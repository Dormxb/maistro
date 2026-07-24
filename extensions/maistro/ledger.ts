import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CostConfig, LedgerEntry } from "./types.ts";

function ensureParent(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function appendLedger(entry: LedgerEntry, ledgerPath: string): void {
  ensureParent(ledgerPath);
  appendFileSync(ledgerPath, JSON.stringify(entry) + "\n", "utf8");
}

export function readLedger(ledgerPath: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

/** UTC month key YYYY-MM to match ISO timestamps from toISOString(). */
export function monthKey(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function sumMonthUsd(ledgerPath: string, now = new Date()): number {
  const key = monthKey(now);
  return readLedger(ledgerPath)
    .filter((e) => e.ts.startsWith(key))
    .reduce((s, e) => s + (e.costUsd || 0), 0);
}

export function assertBudgetAllows(
  cost: CostConfig,
  additionalUsd: number,
  now = new Date(),
): { allowed: boolean; spent: number; remaining: number; reason?: string } {
  const spent = sumMonthUsd(cost.ledgerPath, now);
  const remaining = cost.monthlyBudget - spent;
  if (cost.hardCap && spent + additionalUsd > cost.monthlyBudget + 1e-9) {
    return {
      allowed: false,
      spent,
      remaining,
      reason: `monthly hard cap reached (spent $${spent.toFixed(4)} / $${cost.monthlyBudget})`,
    };
  }
  if (additionalUsd > cost.perTaskLimit + 1e-9) {
    return {
      allowed: false,
      spent,
      remaining,
      reason: `per-task limit exceeded ($${additionalUsd.toFixed(4)} > $${cost.perTaskLimit})`,
    };
  }
  return { allowed: true, spent, remaining };
}

/** Very rough pre-estimate when provider usage unknown. */
export function estimateCostUsd(inTok: number, outTok: number, provider: string): number {
  // fallback averages; real rates should come from profiles later
  const table: Record<string, { inPerM: number; outPerM: number }> = {
    anthropic: { inPerM: 10, outPerM: 50 },
    openai: { inPerM: 5, outPerM: 30 },
    xai: { inPerM: 2, outPerM: 6 },
  };
  const r = table[provider] || { inPerM: 5, outPerM: 15 };
  return (inTok * r.inPerM + outTok * r.outPerM) / 1_000_000;
}
