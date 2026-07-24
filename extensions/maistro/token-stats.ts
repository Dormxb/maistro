/**
 * P8.1 Token statistics — per-model, per-tool, per-session tracking.
 *
 * Records every agent_call to ~/.maistro/token-stats.jsonl.
 * Supports query, summary, and ASCII histogram display.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

export interface TokenRecord {
  ts: string;
  taskId: string;
  role: string;
  model: string;
  tool: string;
  provider: string;
  input: number;
  output: number;
  costUsd: number;
  pool?: string;
  downgradedFrom?: string;
}

export interface ModelStats {
  input: number;
  output: number;
  costUsd: number;
  calls: number;
}

export interface ToolStats {
  input: number;
  output: number;
  costUsd: number;
  calls: number;
}

export interface TokenSummary {
  byModel: Record<string, ModelStats>;
  byTool: Record<string, ToolStats>;
  byRole: Record<string, { input: number; output: number; costUsd: number; calls: number }>;
  total: { input: number; output: number; costUsd: number; calls: number };
}

// ── Storage ──────────────────────────────────────────────────────────

const STATS_DIR = join(homedir(), ".maistro");
const STATS_FILE = join(STATS_DIR, "token-stats.jsonl");

function ensureDir(): void {
  if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
}

export function recordCall(record: TokenRecord): void {
  ensureDir();
  appendFileSync(STATS_FILE, JSON.stringify(record) + "\n", "utf8");
}

// ── Query ────────────────────────────────────────────────────────────

export function loadAllRecords(): TokenRecord[] {
  if (!existsSync(STATS_FILE)) return [];
  const raw = readFileSync(STATS_FILE, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    try { return JSON.parse(line) as TokenRecord; } catch { return null; }
  }).filter(Boolean) as TokenRecord[];
}

export function sessionRecords(taskId: string): TokenRecord[] {
  return loadAllRecords().filter((r) => r.taskId === taskId);
}

export function summarize(records: TokenRecord[]): TokenSummary {
  const summary: TokenSummary = {
    byModel: {},
    byTool: {},
    byRole: {},
    total: { input: 0, output: 0, costUsd: 0, calls: 0 },
  };

  for (const r of records) {
    // By model
    const mk = r.model || "unknown";
    if (!summary.byModel[mk]) summary.byModel[mk] = { input: 0, output: 0, costUsd: 0, calls: 0 };
    summary.byModel[mk].input += r.input;
    summary.byModel[mk].output += r.output;
    summary.byModel[mk].costUsd += r.costUsd;
    summary.byModel[mk].calls++;

    // By tool
    const tk = r.tool || "unknown";
    if (!summary.byTool[tk]) summary.byTool[tk] = { input: 0, output: 0, costUsd: 0, calls: 0 };
    summary.byTool[tk].input += r.input;
    summary.byTool[tk].output += r.output;
    summary.byTool[tk].costUsd += r.costUsd;
    summary.byTool[tk].calls++;

    // By role
    if (!summary.byRole[r.role]) summary.byRole[r.role] = { input: 0, output: 0, costUsd: 0, calls: 0 };
    summary.byRole[r.role].input += r.input;
    summary.byRole[r.role].output += r.output;
    summary.byRole[r.role].costUsd += r.costUsd;
    summary.byRole[r.role].calls++;

    summary.total.input += r.input;
    summary.total.output += r.output;
    summary.total.costUsd += r.costUsd;
    summary.total.calls++;
  }

  return summary;
}

// ── ASCII Histogram ──────────────────────────────────────────────────

const BAR_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function bar(value: number, max: number, width: number = 20): string {
  if (max === 0) return "";
  const ratio = Math.min(1, value / max);
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function renderModelHistogram(records: TokenRecord[]): string {
  const summary = summarize(records);
  const entries = Object.entries(summary.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (entries.length === 0) return "No token data yet.";

  const maxCost = Math.max(...entries.map(([, s]) => s.costUsd));
  const maxTokens = Math.max(...entries.map(([, s]) => s.input + s.output));
  const labelWidth = Math.max(...entries.map(([k]) => k.length), 10);

  const lines: string[] = ["Token Cost by Model", "=".repeat(60)];
  for (const [model, stats] of entries) {
    const label = model.padEnd(labelWidth);
    const barStr = bar(stats.costUsd, maxCost);
    const tokStr = `${(stats.input + stats.output).toLocaleString()} tokens`;
    const costStr = `$${stats.costUsd.toFixed(4)}`;
    lines.push(`${label} ${barStr} ${costStr} (${stats.calls} calls, ${tokStr})`);
  }
  return lines.join("\n");
}

export function renderToolHistogram(records: TokenRecord[]): string {
  const summary = summarize(records);
  const entries = Object.entries(summary.byTool).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (entries.length === 0) return "No token data yet.";

  const maxCost = Math.max(...entries.map(([, s]) => s.costUsd));
  const labelWidth = Math.max(...entries.map(([k]) => k.length), 10);

  const lines: string[] = ["Token Cost by Agent Tool", "=".repeat(60)];
  for (const [tool, stats] of entries) {
    const label = tool.padEnd(labelWidth);
    const barStr = bar(stats.costUsd, maxCost);
    const tokStr = `${(stats.input + stats.output).toLocaleString()} tokens`;
    const costStr = `$${stats.costUsd.toFixed(4)}`;
    lines.push(`${label} ${barStr} ${costStr} (${stats.calls} calls, ${tokStr})`);
  }
  return lines.join("\n");
}

export function renderSummaryText(records: TokenRecord[], scope: string = "all"): string {
  const summary = summarize(records);
  const lines: string[] = [
    `Token Statistics (${scope})`,
    "=".repeat(60),
    `Total calls: ${summary.total.calls}`,
    `Total tokens: ${(summary.total.input + summary.total.output).toLocaleString()} (in: ${summary.total.input.toLocaleString()}, out: ${summary.total.output.toLocaleString()})`,
    `Total cost: $${summary.total.costUsd.toFixed(4)}`,
    "",
  ];

  // By role
  const roles = Object.entries(summary.byRole).sort((a, b) => b[1].calls - a[1].calls);
  if (roles.length > 0) {
    lines.push("By Role:");
    for (const [role, stats] of roles) {
      lines.push(`  ${role}: ${stats.calls} calls, $${stats.costUsd.toFixed(4)}`);
    }
    lines.push("");
  }

  lines.push(renderModelHistogram(records));
  lines.push("");
  lines.push(renderToolHistogram(records));

  return lines.join("\n");
}
