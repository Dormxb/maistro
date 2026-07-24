import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TaskContract } from "./contract.ts";
import type { StaticReport } from "./static-check.ts";
import { isQuotaOrAuthFailure } from "./manual-verify.ts";

const execFileAsync = promisify(execFile);

export interface CodexHandoffPackage {
  taskId: string;
  contract: TaskContract;
  diff: string;
  staticEvidence: StaticReport;
  requiredChecks: string[];
  worktreePath: string;
  notes?: string;
}

export interface CodexCheckResult {
  id: string;
  exitCode: number | null;
  summary: string;
  logRef?: string;
}

export interface CodexVerificationResult {
  taskId: string;
  checks: CodexCheckResult[];
  verdict: "pass" | "fail" | "blocked" | "skipped";
  suggestedAction: "merge" | "fix" | "abandon" | "manual";
  raw?: string;
  handoffPath: string;
  error?: string;
}

import { platform } from "./platform.ts";

const CODEX_CANDIDATES = (() => {
  const p = platform();
  return [...p.defaultPaths.codex, "codex"];
})();

export function resolveCodexBin(): string | null {
  for (const b of CODEX_CANDIDATES) {
    if (b === "codex") return b;
    if (existsSync(b)) return b;
  }
  return null;
}

export function writeHandoffPackage(
  projectRoot: string,
  pkg: CodexHandoffPackage,
): string {
  const dir = join(projectRoot, "output", "handoffs", pkg.taskId);
  mkdirSync(dir, { recursive: true });
  const handoffPath = join(dir, "handoff.json");
  writeFileSync(handoffPath, JSON.stringify(pkg, null, 2), "utf8");
  writeFileSync(join(dir, "diff.patch"), pkg.diff || "", "utf8");
  writeFileSync(
    join(dir, "codex-prompt.md"),
    buildCodexPrompt(pkg),
    "utf8",
  );
  return handoffPath;
}

export function buildCodexPrompt(pkg: CodexHandoffPackage): string {
  return [
    "You are the Maistro verification authority (Codex).",
    "Maistro produced code in an isolated worktree. You must RUN the required checks.",
    "Do NOT change architecture direction. Do NOT merge to main.",
    "",
    `taskId: ${pkg.taskId}`,
    `worktreePath: ${pkg.worktreePath}`,
    "",
    "TASK CONTRACT:",
    JSON.stringify(pkg.contract, null, 2),
    "",
    "STATIC EVIDENCE (Maistro):",
    JSON.stringify(pkg.staticEvidence, null, 2),
    "",
    "REQUIRED CHECKS (you must run these in the worktree):",
    ...pkg.requiredChecks.map((c) => `- ${c}`),
    "",
    "DIFF SUMMARY (full patch also in diff.patch):",
    pkg.diff.slice(0, 12000),
    pkg.diff.length > 12000 ? "\n...[diff truncated in prompt; see diff.patch]..." : "",
    "",
    pkg.notes ? `NOTES:\n${pkg.notes}\n` : "",
    "Return a final JSON object ONLY in your last message with shape:",
    `{
  "taskId": "${pkg.taskId}",
  "checks": [{"id":"test","exitCode":0,"summary":"..."}],
  "verdict": "pass|fail",
  "suggestedAction": "merge|fix|abandon"
}`,
    "If a check cannot be run, use exitCode null and verdict fail.",
  ].join("\n");
}

/**
 * Invoke Codex exec in the worktree. Best-effort parse JSON from output.
 * If Codex unavailable, returns blocked (does not fake pass).
 */
export async function runCodexVerification(
  projectRoot: string,
  pkg: CodexHandoffPackage,
  opts?: { timeoutMs?: number; model?: string },
): Promise<CodexVerificationResult> {
  const handoffPath = writeHandoffPackage(projectRoot, pkg);
  const bin = resolveCodexBin();
  if (!bin) {
    return {
      taskId: pkg.taskId,
      checks: pkg.requiredChecks.map((id) => ({
        id,
        exitCode: null,
        summary: "codex binary not found",
      })),
      verdict: "blocked",
      suggestedAction: "manual",
      handoffPath,
      error: "codex not found",
    };
  }

  const promptPath = join(projectRoot, "output", "handoffs", pkg.taskId, "codex-prompt.md");
  const prompt = readUtf8(promptPath);

  try {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-C",
      pkg.worktreePath,
      ...(opts?.model ? ["-m", opts.model] : []),
      prompt,
    ];
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: opts?.timeoutMs ?? 600_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    const raw = `${stdout}\n${stderr}`;
    writeFileSync(
      join(projectRoot, "output", "handoffs", pkg.taskId, "codex-raw.txt"),
      raw,
      "utf8",
    );
    const parsed = extractJsonResult(raw, pkg.taskId);
    if (!parsed) {
      return {
        taskId: pkg.taskId,
        checks: pkg.requiredChecks.map((id) => ({
          id,
          exitCode: null,
          summary: "could not parse codex JSON result",
        })),
        verdict: "fail",
        suggestedAction: "manual",
        raw: raw.slice(-4000),
        handoffPath,
        error: "parse_failed",
      };
    }
    const result: CodexVerificationResult = {
      taskId: pkg.taskId,
      checks: parsed.checks || [],
      verdict: parsed.verdict === "pass" ? "pass" : "fail",
      suggestedAction: parsed.suggestedAction || "manual",
      raw: raw.slice(-4000),
      handoffPath,
    };
    // Never pass if required checks empty or missing
    if (!result.checks.length) {
      result.verdict = "fail";
      result.suggestedAction = "fix";
    }
    if (result.verdict === "pass") {
      const failed = result.checks.some((c) => c.exitCode !== 0);
      if (failed) {
        result.verdict = "fail";
        result.suggestedAction = "fix";
      }
    }
    writeFileSync(
      join(projectRoot, "output", "handoffs", pkg.taskId, "codex-result.json"),
      JSON.stringify(result, null, 2),
      "utf8",
    );
    return result;
  } catch (e: any) {
    const raw = String(e?.stdout || "") + "\n" + String(e?.stderr || e);
    writeFileSync(
      join(projectRoot, "output", "handoffs", pkg.taskId, "codex-raw.txt"),
      raw,
      "utf8",
    );
    const err = String(e?.message || e);
    const quota = isQuotaOrAuthFailure(raw, err);
    return {
      taskId: pkg.taskId,
      checks: pkg.requiredChecks.map((id) => ({
        id,
        exitCode: null,
        summary: quota
          ? `codex quota/auth blocked: ${err}`
          : `codex exec failed: ${err}`,
      })),
      verdict: "blocked",
      suggestedAction: "manual",
      raw: raw.slice(-4000),
      handoffPath,
      error: quota ? `quota_or_auth: ${err}` : err,
    };
  }
}

function readUtf8(p: string): string {
  return readFileSync(p, "utf8");
}

function extractJsonResult(raw: string, taskId: string): any | null {
  // try fenced json blocks from the end
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const candidates = [...fences, raw];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const text = candidates[i];
    const start = text.lastIndexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && (obj.taskId === taskId || obj.verdict || obj.checks)) return obj;
    } catch {
      /* continue */
    }
  }
  return null;
}
