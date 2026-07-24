import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLedger, sumMonthUsd, monthKey } from "./ledger.ts";
import type { MaistroConfig } from "./types.ts";
import { listTasks } from "./task-journal.ts";

export interface StatsSnapshot {
  month: string;
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  hardCap: boolean;
  ledgerEntriesThisMonth: number;
  byRole: Record<string, { calls: number; costUsd: number; estimatedCalls: number }>;
  byModel: Record<string, { calls: number; costUsd: number }>;
  tasks: {
    total: number;
    byState: Record<string, number>;
    mergeRecommended: number;
  };
  handoffs: number;
  debates: number;
}

export function buildStats(projectRoot: string, config: MaistroConfig): StatsSnapshot {
  const month = monthKey();
  const spent = sumMonthUsd(config.cost.ledgerPath);
  const entries = readLedger(config.cost.ledgerPath).filter((e) => e.ts.startsWith(month));

  const byRole: StatsSnapshot["byRole"] = {};
  const byModel: StatsSnapshot["byModel"] = {};
  for (const e of entries) {
    byRole[e.role] ||= { calls: 0, costUsd: 0, estimatedCalls: 0 };
    byRole[e.role].calls++;
    byRole[e.role].costUsd += e.costUsd || 0;
    if (e.estimated) byRole[e.role].estimatedCalls++;

    const mk = e.model || "unknown";
    byModel[mk] ||= { calls: 0, costUsd: 0 };
    byModel[mk].calls++;
    byModel[mk].costUsd += e.costUsd || 0;
  }

  const tasks = listTasks();
  const byState: Record<string, number> = {};
  let mergeRecommended = 0;
  for (const t of tasks) {
    byState[t.state] = (byState[t.state] || 0) + 1;
    if (t.mergeRecommended) mergeRecommended++;
  }

  const handoffDir = join(projectRoot, "output", "handoffs");
  const debateDir = join(projectRoot, "output", "debates");
  const handoffs = existsSync(handoffDir) ? readdirSync(handoffDir).length : 0;
  const debates = existsSync(debateDir) ? readdirSync(debateDir).length : 0;

  return {
    month,
    spentUsd: spent,
    budgetUsd: config.cost.monthlyBudget,
    remainingUsd: config.cost.monthlyBudget - spent,
    hardCap: config.cost.hardCap,
    ledgerEntriesThisMonth: entries.length,
    byRole,
    byModel,
    tasks: {
      total: tasks.length,
      byState,
      mergeRecommended,
    },
    handoffs,
    debates,
  };
}

export function renderStatsText(s: StatsSnapshot): string {
  const lines = [
    `Maistro stats (${s.month})`,
    `budget: $${s.spentUsd.toFixed(4)} / $${s.budgetUsd} remaining $${s.remainingUsd.toFixed(4)} hardCap=${s.hardCap}`,
    `ledger entries this month: ${s.ledgerEntriesThisMonth}`,
    `tasks: ${s.tasks.total} mergeRecommended=${s.tasks.mergeRecommended}`,
    `task states: ${JSON.stringify(s.tasks.byState)}`,
    `handoffs: ${s.handoffs}  debates: ${s.debates}`,
    "by role:",
    ...Object.entries(s.byRole).map(
      ([r, v]) =>
        `  ${r}: calls=${v.calls} cost=$${v.costUsd.toFixed(4)} estimated=${v.estimatedCalls}`,
    ),
    "by model:",
    ...Object.entries(s.byModel).map(
      ([m, v]) => `  ${m}: calls=${v.calls} cost=$${v.costUsd.toFixed(4)}`,
    ),
  ];
  return lines.join("\n");
}

/** Optional: load last orchestrate/debate JSON for a task */
export function loadJsonIfExists(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
