import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexCheckResult, CodexVerificationResult } from "./codex-handoff.ts";

export interface ManualVerifyInput {
  taskId: string;
  /** Map check id -> exit code (0 pass) */
  checks: Array<{ id: string; exitCode: number; summary?: string }>;
  notes?: string;
  /** Who attested */
  attestedBy?: string;
}

/**
 * When Codex is quota-blocked, user/operator can submit a manual verification receipt.
 * This does NOT auto-run tests in Maistro — it only records external attestation.
 */
export function submitManualVerification(
  projectRoot: string,
  input: ManualVerifyInput,
): CodexVerificationResult {
  if (!input.checks?.length) {
    throw new Error("manual verification requires at least one check result");
  }
  const dir = join(projectRoot, "output", "handoffs", input.taskId);
  mkdirSync(dir, { recursive: true });

  const checks: CodexCheckResult[] = input.checks.map((c) => ({
    id: c.id,
    exitCode: c.exitCode,
    summary: c.summary || (c.exitCode === 0 ? "manual pass" : "manual fail"),
    logRef: "manual-receipt",
  }));
  const allPass = checks.every((c) => c.exitCode === 0);
  const result: CodexVerificationResult = {
    taskId: input.taskId,
    checks,
    verdict: allPass ? "pass" : "fail",
    suggestedAction: allPass ? "merge" : "fix",
    handoffPath: join(dir, "handoff.json"),
    raw: JSON.stringify({ source: "manual", notes: input.notes, by: input.attestedBy }, null, 2),
  };

  writeFileSync(join(dir, "manual-verify.json"), JSON.stringify({ input, result }, null, 2), "utf8");
  writeFileSync(join(dir, "codex-result.json"), JSON.stringify(result, null, 2), "utf8");
  return result;
}

export function loadVerificationResult(
  projectRoot: string,
  taskId: string,
): CodexVerificationResult | null {
  const p = join(projectRoot, "output", "handoffs", taskId, "codex-result.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as CodexVerificationResult;
}

/** Detect common Codex quota / auth failures in raw text */
export function isQuotaOrAuthFailure(raw?: string, error?: string): boolean {
  const t = `${raw || ""} ${error || ""}`.toLowerCase();
  return (
    t.includes("quota") ||
    t.includes("insufficient") ||
    t.includes("rate limit") ||
    t.includes("429") ||
    t.includes("usage limit") ||
    t.includes("billing") ||
    t.includes("payment") ||
    t.includes("unauthorized") ||
    t.includes("401") ||
    t.includes("403") ||
    t.includes("not logged") ||
    t.includes("auth")
  );
}
