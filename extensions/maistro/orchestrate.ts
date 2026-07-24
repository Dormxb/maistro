import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { AgentPool } from "./agent-pool.ts";
import type { MaistroConfig, WriteSession } from "./types.ts";
import { buildContract, renderContractForPrompt, type TaskContract } from "./contract.ts";
import { acquireWriteSession, disposeWriteSession } from "./worktree.ts";
import { getUnifiedDiff, runStaticChecks, type StaticReport } from "./static-check.ts";
import {
  runCodexVerification,
  writeHandoffPackage,
  type CodexVerificationResult,
  type CodexHandoffPackage,
} from "./codex-handoff.ts";
import { assertBudgetAllows } from "./ledger.ts";
import { isQuotaOrAuthFailure, loadVerificationResult } from "./manual-verify.ts";
import { loadMeta, saveMeta, type TaskRecord } from "./task-journal.ts";

export interface OrchestrateInput {
  taskId: string;
  userGoal: string;
  acceptanceCriteria: string[];
  requiredChecks: string[];
  constraints?: string[];
  nonGoals?: string[];
  runCodex?: boolean;
  runChallenger?: boolean;
  discardAtEnd?: boolean;
  /** Max executor fix rounds after static/codex/challenger failure. Default 2. */
  maxFixRounds?: number;
  /** Resume existing task meta/worktree if present. */
  resume?: boolean;
}

export interface StageOut {
  role: string;
  status: "success" | "failed" | "skipped";
  text?: string;
  model?: string;
  costUsd?: number;
  error?: string;
  round?: number;
}

export interface OrchestrateResult {
  taskId: string;
  contract: TaskContract;
  writeSession?: WriteSession;
  stages: {
    architect?: StageOut;
    executor?: StageOut | StageOut[];
    static?: { status: string; report: StaticReport; round?: number };
    codex?: CodexVerificationResult;
    challenger?: StageOut;
    fixRounds?: number;
  };
  overallStatus: "success" | "partial_success" | "failed" | "blocked" | "awaiting_manual_verify";
  mergeRecommended: boolean;
  handoffPath?: string;
  summary: string;
  fixRound: number;
}

function gitHead(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  }).trim();
}

function persistResult(cwd: string, taskId: string, result: OrchestrateResult): void {
  const outDir = pathJoin(cwd, "output", "handoffs", taskId);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(pathJoin(outDir, "orchestrate-result.json"), JSON.stringify(result, null, 2));
}

function touchMeta(
  base: Partial<TaskRecord> & { taskId: string; state: TaskRecord["state"] },
): void {
  const prev = loadMeta(base.taskId);
  saveMeta({
    taskId: base.taskId,
    state: base.state,
    worktreePath: base.worktreePath ?? prev?.worktreePath,
    branch: base.branch ?? prev?.branch,
    baseCommit: base.baseCommit ?? prev?.baseCommit,
    fixRound: base.fixRound ?? prev?.fixRound ?? 0,
    handoffPath: base.handoffPath ?? prev?.handoffPath,
    lastError: base.lastError,
    mergeRecommended: base.mergeRecommended ?? prev?.mergeRecommended,
    updatedAt: new Date().toISOString(),
  });
}

export async function runTriadPipeline(
  cwd: string,
  config: MaistroConfig,
  pool: AgentPool,
  input: OrchestrateInput,
): Promise<OrchestrateResult> {
  const maxFixRounds = input.maxFixRounds ?? 2;
  const budget = assertBudgetAllows(config.cost, Math.min(config.cost.perTaskLimit, 1));
  if (!budget.allowed) {
    return {
      taskId: input.taskId,
      contract: buildContract({
        taskId: input.taskId,
        userGoal: input.userGoal,
        acceptanceCriteria: input.acceptanceCriteria,
        requiredChecks: input.requiredChecks,
        baseCommit: "unknown",
      }),
      stages: {},
      overallStatus: "blocked",
      mergeRecommended: false,
      summary: budget.reason || "budget blocked",
      fixRound: 0,
    };
  }

  const baseCommit = gitHead(cwd);
  const contract = buildContract({
    taskId: input.taskId,
    userGoal: input.userGoal,
    acceptanceCriteria: input.acceptanceCriteria,
    constraints: input.constraints,
    nonGoals: input.nonGoals,
    requiredChecks: input.requiredChecks,
    baseCommit,
  });
  const contractText = renderContractForPrompt(contract);

  let writeSession: WriteSession;
  const existing = input.resume ? loadMeta(input.taskId) : null;
  if (existing?.worktreePath) {
    writeSession = {
      taskId: input.taskId,
      worktreePath: existing.worktreePath,
      branch: existing.branch || `maistro/${input.taskId}`,
      baseCommit: existing.baseCommit || baseCommit,
      createdAt: existing.updatedAt,
    };
  } else {
    writeSession = acquireWriteSession(cwd, input.taskId);
  }

  touchMeta({
    taskId: input.taskId,
    state: "created",
    worktreePath: writeSession.worktreePath,
    branch: writeSession.branch,
    baseCommit: writeSession.baseCommit,
    fixRound: 0,
  });

  const stages: OrchestrateResult["stages"] = { fixRounds: 0 };
  const executorRounds: StageOut[] = [];

  // Architect once
  try {
    const arch = await pool.call({
      role: "architect",
      taskId: input.taskId,
      prompt: [
        contractText,
        "",
        "Design a minimal implementation plan for this contract.",
        "Output: architecture notes, file list, interfaces, risks.",
        "Do not write code files. Read-only.",
      ].join("\n"),
    });
    stages.architect = {
      role: "architect",
      status: "success",
      text: arch.text,
      model: arch.model,
      costUsd: arch.costUsd,
    };
    touchMeta({ taskId: input.taskId, state: "architect_done", fixRound: 0 });
  } catch (e) {
    stages.architect = { role: "architect", status: "failed", error: String(e) };
    return finish(cwd, input, contract, writeSession, stages, "failed", false, undefined, String(e), 0);
  }

  let fixRound = 0;
  let lastStatic: StaticReport | undefined;
  let lastCodex: CodexVerificationResult | undefined;
  let lastDiff = "";
  let handoffPath: string | undefined;

  while (fixRound <= maxFixRounds) {
    const roundLabel = fixRound === 0 ? "initial" : `fix-${fixRound}`;

    // Executor
    try {
      const fixHint =
        fixRound === 0
          ? ""
          : [
              "",
              `FIX ROUND ${fixRound}/${maxFixRounds}`,
              "Previous static:",
              JSON.stringify(lastStatic, null, 2),
              "Previous Codex/manual verification:",
              JSON.stringify(lastCodex, null, 2),
              "Previous challenger notes may be above in history — repair failures.",
            ].join("\n");

      const ex = await pool.call({
        role: "executor",
        taskId: input.taskId,
        writeSession,
        prompt: [
          contractText,
          "",
          "ARCHITECT PLAN:",
          stages.architect?.text || "",
          fixHint,
          "",
          "Implement by writing files in the worktree only.",
          "No shell. No install. No running tests — Codex or manual verify will run checks.",
        ].join("\n"),
      });
      const out: StageOut = {
        role: "executor",
        status: "success",
        text: ex.text,
        model: ex.model,
        costUsd: ex.costUsd,
        round: fixRound,
      };
      executorRounds.push(out);
      stages.executor = executorRounds.length === 1 ? out : executorRounds;
      touchMeta({ taskId: input.taskId, state: fixRound ? "fixing" : "executor_done", fixRound });
    } catch (e) {
      executorRounds.push({ role: "executor", status: "failed", error: String(e), round: fixRound });
      stages.executor = executorRounds;
      return finish(cwd, input, contract, writeSession, stages, "failed", false, handoffPath, String(e), fixRound);
    }

    // Static
    lastStatic = runStaticChecks(
      writeSession.worktreePath,
      writeSession.baseCommit,
      config.security,
      config.verification.maistroStaticChecks,
    );
    stages.static = { status: lastStatic.verdict, report: lastStatic, round: fixRound };
    if (lastStatic.verdict === "fail") {
      touchMeta({ taskId: input.taskId, state: "static_failed", fixRound, lastError: "static failed" });
      if (fixRound < maxFixRounds) {
        fixRound++;
        stages.fixRounds = fixRound;
        continue;
      }
      return finish(
        cwd,
        input,
        contract,
        writeSession,
        stages,
        "failed",
        false,
        handoffPath,
        "static checks failed after fix rounds",
        fixRound,
      );
    }
    touchMeta({ taskId: input.taskId, state: "static_passed", fixRound });

    lastDiff = getUnifiedDiff(writeSession.worktreePath, writeSession.baseCommit);
    const handoffPkg: CodexHandoffPackage = {
      taskId: input.taskId,
      contract,
      diff: lastDiff,
      staticEvidence: lastStatic,
      requiredChecks: contract.requiredChecks,
      worktreePath: writeSession.worktreePath,
      notes: [
        `round=${roundLabel}`,
        "Architect:",
        (stages.architect?.text || "").slice(0, 1500),
        "Executor:",
        (executorRounds.at(-1)?.text || "").slice(0, 1500),
      ].join("\n"),
    };
    handoffPath = writeHandoffPackage(cwd, handoffPkg);
    touchMeta({ taskId: input.taskId, state: "static_passed", fixRound, handoffPath });

    // Codex or existing manual receipt
    const runCodex = input.runCodex !== false;
    if (runCodex) {
      lastCodex = await runCodexVerification(cwd, handoffPkg);
    } else {
      // Prefer manual receipt if present
      lastCodex =
        loadVerificationResult(cwd, input.taskId) || {
          taskId: input.taskId,
          checks: contract.requiredChecks.map((id) => ({
            id,
            exitCode: null,
            summary: "codex skipped; no manual receipt",
          })),
          verdict: "skipped" as const,
          suggestedAction: "manual" as const,
          handoffPath,
        };
    }
    stages.codex = lastCodex;

    if (lastCodex.verdict === "blocked" || isQuotaOrAuthFailure(lastCodex.raw, lastCodex.error)) {
      touchMeta({
        taskId: input.taskId,
        state: "awaiting_manual_verify",
        fixRound,
        handoffPath,
        lastError: lastCodex.error || "codex blocked/quota",
        mergeRecommended: false,
      });
      // Challenger can still run on static+diff
      if (input.runChallenger !== false) {
        stages.challenger = await runChallenger(pool, input.taskId, contractText, lastStatic, lastCodex, lastDiff);
      }
      return finish(
        cwd,
        input,
        contract,
        writeSession,
        stages,
        "awaiting_manual_verify",
        false,
        handoffPath,
        "Codex blocked (e.g. quota). Submit manual verify via maistro_manual_verify, then maistro_continue_after_verify.",
        fixRound,
      );
    }

    if (lastCodex.verdict !== "pass") {
      touchMeta({ taskId: input.taskId, state: "codex_failed", fixRound, handoffPath });
      if (fixRound < maxFixRounds) {
        fixRound++;
        stages.fixRounds = fixRound;
        continue;
      }
      stages.challenger =
        input.runChallenger === false
          ? { role: "challenger", status: "skipped" }
          : await runChallenger(pool, input.taskId, contractText, lastStatic, lastCodex, lastDiff);
      return finish(
        cwd,
        input,
        contract,
        writeSession,
        stages,
        "failed",
        false,
        handoffPath,
        "verification failed after fix rounds",
        fixRound,
      );
    }

    touchMeta({ taskId: input.taskId, state: "codex_passed", fixRound, handoffPath });
    break; // verified — leave loop for challenger
  }

  // Challenger hard gate
  if (input.runChallenger === false) {
    stages.challenger = { role: "challenger", status: "skipped" };
  } else {
    stages.challenger = await runChallenger(
      pool,
      input.taskId,
      contractText,
      lastStatic!,
      lastCodex!,
      lastDiff,
    );
  }

  const codexPass = lastCodex?.verdict === "pass";
  const staticPass = lastStatic?.verdict === "pass";
  const challengerOk = stages.challenger?.status === "success";
  const mergeRecommended = !!(staticPass && codexPass && challengerOk);

  let overall: OrchestrateResult["overallStatus"] = "success";
  if (!staticPass) overall = "failed";
  else if (!codexPass) overall = lastCodex?.verdict === "blocked" ? "blocked" : "failed";
  else if (!challengerOk) overall = "partial_success";

  return finish(
    cwd,
    input,
    contract,
    writeSession,
    stages,
    overall,
    mergeRecommended,
    handoffPath,
    mergeRecommended ? "merge recommended (user decides)" : "merge NOT recommended",
    fixRound,
  );
}

async function runChallenger(
  pool: AgentPool,
  taskId: string,
  contractText: string,
  staticReport: StaticReport,
  codex: CodexVerificationResult,
  diff: string,
): Promise<StageOut> {
  try {
    const ch = await pool.call({
      role: "challenger",
      taskId,
      prompt: [
        contractText,
        "",
        "Adversarial review. Attack the implementation.",
        "STATIC:",
        JSON.stringify(staticReport, null, 2),
        "VERIFICATION:",
        JSON.stringify(codex, null, 2),
        "DIFF:",
        diff.slice(0, 14000),
        "",
        "List findings Critical/High/Medium/Low. If verification is not pass, say so.",
      ].join("\n"),
    });
    touchMeta({ taskId, state: "challenger_done", fixRound: loadMeta(taskId)?.fixRound || 0 });
    return {
      role: "challenger",
      status: "success",
      text: ch.text,
      model: ch.model,
      costUsd: ch.costUsd,
    };
  } catch (e) {
    return { role: "challenger", status: "failed", error: String(e) };
  }
}

/**
 * After manual verification receipt, re-run challenger and recompute merge recommendation.
 */
export async function continueAfterVerify(
  cwd: string,
  config: MaistroConfig,
  pool: AgentPool,
  taskId: string,
  opts?: { runChallenger?: boolean; discardAtEnd?: boolean },
): Promise<OrchestrateResult> {
  const meta = loadMeta(taskId);
  if (!meta?.worktreePath) throw new Error(`no resumable task ${taskId}`);
  const verify = loadVerificationResult(cwd, taskId);
  if (!verify) throw new Error(`no verification result for ${taskId}; submit maistro_manual_verify first`);

  const prevPath = pathJoin(cwd, "output", "handoffs", taskId, "orchestrate-result.json");
  const prev = JSON.parse(readFileSync(prevPath, "utf8")) as OrchestrateResult;

  const writeSession: WriteSession = {
    taskId,
    worktreePath: meta.worktreePath,
    branch: meta.branch || `maistro/${taskId}`,
    baseCommit: meta.baseCommit || prev.contract.baseCommit,
    createdAt: meta.updatedAt,
  };

  const stages = { ...prev.stages, codex: verify };
  const contractText = renderContractForPrompt(prev.contract);
  const diff = getUnifiedDiff(writeSession.worktreePath, writeSession.baseCommit);
  const staticReport =
    stages.static?.report ||
    runStaticChecks(writeSession.worktreePath, writeSession.baseCommit, config.security);

  if (opts?.runChallenger !== false) {
    stages.challenger = await runChallenger(pool, taskId, contractText, staticReport, verify, diff);
  }

  const mergeRecommended =
    verify.verdict === "pass" &&
    staticReport.verdict === "pass" &&
    stages.challenger?.status === "success";

  const overall: OrchestrateResult["overallStatus"] = mergeRecommended
    ? "success"
    : verify.verdict === "pass"
      ? "partial_success"
      : "failed";

  const result: OrchestrateResult = {
    taskId,
    contract: prev.contract,
    writeSession,
    stages,
    overallStatus: overall,
    mergeRecommended,
    handoffPath: meta.handoffPath || prev.handoffPath,
    summary: mergeRecommended
      ? "manual/codex verify pass + challenger ok"
      : "still not merge-ready after verify continue",
    fixRound: meta.fixRound || 0,
  };
  persistResult(cwd, taskId, result);
  touchMeta({
    taskId,
    state: mergeRecommended ? "completed" : "failed",
    fixRound: meta.fixRound,
    mergeRecommended,
    handoffPath: result.handoffPath,
  });
  if (opts?.discardAtEnd) {
    disposeWriteSession(cwd, writeSession, "discard");
    result.writeSession = undefined;
  }
  return result;
}

function finish(
  cwd: string,
  input: OrchestrateInput,
  contract: TaskContract,
  writeSession: WriteSession | undefined,
  stages: OrchestrateResult["stages"],
  overallStatus: OrchestrateResult["overallStatus"],
  mergeRecommended: boolean,
  handoffPath: string | undefined,
  summary: string,
  fixRound: number,
): OrchestrateResult {
  stages.fixRounds = fixRound;
  const result: OrchestrateResult = {
    taskId: input.taskId,
    contract,
    writeSession,
    stages,
    overallStatus,
    mergeRecommended,
    handoffPath,
    summary,
    fixRound,
  };
  persistResult(cwd, input.taskId, result);
  touchMeta({
    taskId: input.taskId,
    state:
      overallStatus === "awaiting_manual_verify"
        ? "awaiting_manual_verify"
        : overallStatus === "success"
          ? "completed"
          : overallStatus === "blocked"
            ? "codex_blocked"
            : "failed",
    worktreePath: writeSession?.worktreePath,
    branch: writeSession?.branch,
    baseCommit: writeSession?.baseCommit,
    fixRound,
    handoffPath,
    mergeRecommended,
    lastError: overallStatus === "success" ? undefined : summary,
  });
  if (input.discardAtEnd && writeSession && overallStatus !== "awaiting_manual_verify") {
    disposeWriteSession(cwd, writeSession, "discard");
    result.writeSession = undefined;
  }
  return result;
}
