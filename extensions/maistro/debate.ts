import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPool } from "./agent-pool.ts";
import type { MaistroConfig } from "./types.ts";
import { assertBudgetAllows } from "./ledger.ts";
import { saveMeta } from "./task-journal.ts";
import { rememberDecision } from "./memory.ts";

export interface DebateInput {
  taskId: string;
  question: string;
  proposers?: string[];
  judgeRole?: string;
  context?: string;
  /** Save judgment into .system/memory/decisions.md */
  saveMemory?: boolean;
}

export interface DebateOpinion {
  role: string;
  model?: string;
  status: "success" | "failed";
  text?: string;
  costUsd?: number;
  error?: string;
}

export interface DebateResult {
  taskId: string;
  question: string;
  opinions: DebateOpinion[];
  judgment?: DebateOpinion;
  overallStatus: "success" | "partial_success" | "failed" | "blocked";
  summary: string;
  blindMap: Record<string, string>;
  memoryPath?: string;
}

/**
 * P4 Debate: each proposer answers independently; judge sees blind labels A/B/C.
 * All seats are read-only (no write session).
 */
export async function runDebate(
  cwd: string,
  config: MaistroConfig,
  pool: AgentPool,
  input: DebateInput,
): Promise<DebateResult> {
  const gate = assertBudgetAllows(config.cost, Math.min(config.cost.perTaskLimit, 1));
  if (!gate.allowed) {
    return {
      taskId: input.taskId,
      question: input.question,
      opinions: [],
      overallStatus: "blocked",
      summary: gate.reason || "budget blocked",
      blindMap: {},
    };
  }

  const proposers =
    input.proposers?.length
      ? input.proposers
      : ["architect", "challenger"].filter((r) => config.agents[r]);

  // Include executor perspective via architect call style if executor listed —
  // use read-only roles only for tool safety: map executor seat -> architect tools + implementer prompt
  const labels = ["A", "B", "C", "D", "E"];
  const blindMap: Record<string, string> = {};
  proposers.forEach((r, i) => {
    blindMap[labels[i] || `P${i}`] = r;
  });
  const labelOf = (role: string) =>
    Object.entries(blindMap).find(([, r]) => r === role)?.[0] || role;

  const opinions: DebateOpinion[] = [];
  for (const role of proposers) {
    const callRole = role === "executor" ? "architect" : role;
    const perspective =
      role === "executor"
        ? "Argue as implementer: simplicity, shipability, testability."
        : role === "challenger"
          ? "Argue adversarially: what breaks, what is underspecified."
          : "Argue as architect: structure, boundaries, long-term cost.";

    try {
      const res = await pool.call({
        role: callRole,
        taskId: `${input.taskId}-${role}`,
        systemPrompt: [
          `DEBATE PROPOSER seat="${role}" (tools of ${callRole}, read-only).`,
          `Configured preference: ${config.agents[role]?.provider}/${config.agents[role]?.model}`,
          perspective,
          "No file writes. No shell.",
        ].join("\n"),
        prompt: [
          `QUESTION:\n${input.question}`,
          input.context ? `\nCONTEXT:\n${input.context}` : "",
          "\nStructure: Position / Rationale / Risks / Recommendation",
        ].join("\n"),
      });
      opinions.push({
        role,
        status: "success",
        text: res.text,
        model: res.model,
        costUsd: res.costUsd,
      });
    } catch (e) {
      opinions.push({ role, status: "failed", error: String(e) });
    }
  }

  const successful = opinions.filter((o) => o.status === "success");
  if (successful.length === 0) {
    const result: DebateResult = {
      taskId: input.taskId,
      question: input.question,
      opinions,
      overallStatus: "failed",
      summary: "all proposers failed",
      blindMap,
    };
    persist(cwd, input.taskId, result);
    return result;
  }

  let judgeRole = input.judgeRole || "architect";
  // Prefer judge different from single successful proposer role when possible
  if (successful.length === 1 && successful[0].role === "architect") {
    judgeRole = config.agents.challenger ? "challenger" : "architect";
  } else if (input.judgeRole) {
    judgeRole = input.judgeRole;
  } else if (config.agents.challenger && successful.some((s) => s.role === "architect")) {
    // default architect judge is ok when multiple proposers
    judgeRole = "architect";
  }

  const blindBody = successful
    .map((o) => `### Proposal ${labelOf(o.role)}\n${o.text}`)
    .join("\n\n");

  let judgment: DebateOpinion;
  try {
    const j = await pool.call({
      role: judgeRole,
      taskId: `${input.taskId}-judge`,
      systemPrompt: [
        "You are the debate JUDGE.",
        "Proposals are labeled A/B/C without author identities.",
        "Pick a winner or Hybrid; justify; list residual risks.",
        "READ-ONLY.",
      ].join("\n"),
      prompt: [
        `QUESTION:\n${input.question}`,
        "",
        blindBody,
        "",
        "Output: Verdict (A/B/C/Hybrid) / Why / What to do next / Residual risks",
      ].join("\n"),
    });
    judgment = {
      role: `judge:${judgeRole}`,
      status: "success",
      text: j.text,
      model: j.model,
      costUsd: j.costUsd,
    };
  } catch (e) {
    judgment = { role: `judge:${judgeRole}`, status: "failed", error: String(e) };
  }

  let memoryPath: string | undefined;
  if (input.saveMemory !== false && judgment.status === "success" && judgment.text) {
    try {
      memoryPath = rememberDecision(
        cwd,
        `Debate: ${input.question.slice(0, 80)}`,
        [
          `question: ${input.question}`,
          `blindMap: ${JSON.stringify(blindMap)}`,
          "",
          judgment.text,
        ].join("\n"),
        input.taskId,
        ["debate", "p4"],
      );
    } catch {
      /* non-fatal */
    }
  }

  const result: DebateResult = {
    taskId: input.taskId,
    question: input.question,
    opinions,
    judgment,
    overallStatus:
      judgment.status === "success"
        ? successful.length === proposers.length
          ? "success"
          : "partial_success"
        : "failed",
    summary:
      judgment.status === "success"
        ? `debate ok; memory=${memoryPath ? "saved" : "none"}`
        : "debate judgment failed",
    blindMap,
    memoryPath,
  };

  persist(cwd, input.taskId, result);
  saveMeta({
    taskId: input.taskId,
    state: result.overallStatus === "failed" ? "failed" : "completed",
    fixRound: 0,
    updatedAt: new Date().toISOString(),
    mergeRecommended: false,
    lastError: result.overallStatus === "failed" ? result.summary : undefined,
  });
  return result;
}

function persist(cwd: string, taskId: string, result: DebateResult): void {
  const dir = join(cwd, "output", "debates", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "debate-result.json"), JSON.stringify(result, null, 2));
}
