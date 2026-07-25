/**
 * P10 CodeGraph integration — knowledge graph for code intelligence.
 *
 * Wraps the codegraph CLI (v1.4.1) for use by Maistro agents and doctor.
 */

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

export interface CodeGraphStatus {
  installed: boolean;
  initialized: boolean;
  files: number;
  nodes: number;
  edges: number;
  dbSize: string;
  upToDate: boolean;
  suggestion?: string;
  rawOutput: string;
}

export interface SymbolResult {
  kind: string;
  name: string;
  file: string;
  line?: number;
  signature?: string;
}

// ── CLI helpers ──────────────────────────────────────────────────────

function run(args: string[], cwd?: string): string {
  return execSync(`codegraph ${args.join(" ")}`, {
    cwd: cwd || process.cwd(),
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Status ───────────────────────────────────────────────────────────

export function checkInstalled(): boolean {
  try {
    execSync("codegraph version", { encoding: "utf8", timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function getStatus(cwd?: string): CodeGraphStatus {
  const installed = checkInstalled();
  const result: CodeGraphStatus = {
    installed,
    initialized: false,
    files: 0,
    nodes: 0,
    edges: 0,
    dbSize: "0",
    upToDate: false,
    rawOutput: "",
  };

  if (!installed) {
    result.suggestion = "Install: npm i -g codegraph";
    return result;
  }

  const dotDir = join(cwd || process.cwd(), ".codegraph");
  const dbPath = join(dotDir, "codegraph.db");
  result.initialized = existsSync(dbPath);

  if (!result.initialized) {
    result.suggestion = "Run: codegraph init";
    return result;
  }

  // Get DB size.
  try {
    const stat = statSync(dbPath);
    result.dbSize = stat.size > 1024 * 1024
      ? `${(stat.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(stat.size / 1024)} KB`;
  } catch { /* ignore */ }

  // Parse status output.
  try {
    const raw = run(["status"], cwd);
    result.rawOutput = stripAnsi(raw);

    const filesMatch = raw.match(/Files:\s+([\d,]+)/);
    if (filesMatch) result.files = parseInt(filesMatch[1].replace(/,/g, ""));

    const nodesMatch = raw.match(/Nodes:\s+([\d,]+)/);
    if (nodesMatch) result.nodes = parseInt(nodesMatch[1].replace(/,/g, ""));

    const edgesMatch = raw.match(/Edges:\s+([\d,]+)/);
    if (edgesMatch) result.edges = parseInt(edgesMatch[1].replace(/,/g, ""));

    result.upToDate = raw.includes("up to date") || raw.includes("✓");

    if (raw.includes("re-index")) {
      result.suggestion = "Run: codegraph sync";
    }
    if (raw.includes("stale") || raw.includes("out of date")) {
      result.suggestion = "Run: codegraph sync";
    }
    if (raw.includes("Index was built by an earlier version")) {
      result.suggestion = "Run: codegraph index (full rebuild recommended)";
    }
  } catch {
    result.suggestion = "codegraph status failed — check CLI installation";
  }

  return result;
}

// ── Sync ─────────────────────────────────────────────────────────────

export function sync(cwd?: string): string {
  try {
    return stripAnsi(run(["sync"], cwd));
  } catch (e: any) {
    return `sync failed: ${e.stderr || e.message}`;
  }
}

// ── Query ────────────────────────────────────────────────────────────

export function query(symbol: string, cwd?: string): SymbolResult[] {
  try {
    const raw = stripAnsi(run(["query", symbol], cwd));
    return parseQueryResults(raw);
  } catch {
    return [];
  }
}

function parseQueryResults(raw: string): SymbolResult[] {
  const results: SymbolResult[] = [];
  const lines = raw.split("\n");
  let current: Partial<SymbolResult> = {};

  for (const line of lines) {
    const kindMatch = line.match(/^(\w+)\s+(.+)$/);
    if (kindMatch) {
      // Save previous.
      if (current.name) results.push(current as SymbolResult);
      current = { kind: kindMatch[1], name: kindMatch[2].trim() };
      continue;
    }
    const fileMatch = line.match(/^\s+([^\s]+\.\w+)(?::(\d+))?/);
    if (fileMatch && current.name) {
      current.file = fileMatch[1];
      current.line = fileMatch[2] ? parseInt(fileMatch[2]) : undefined;
    }
    const sigMatch = line.match(/^\s+\((.+)\)/);
    if (sigMatch && current.name) {
      current.signature = sigMatch[1];
    }
  }
  if (current.name) results.push(current as SymbolResult);

  return results;
}

// ── Callers / Impact ─────────────────────────────────────────────────

export function callers(symbol: string, cwd?: string): string {
  try { return stripAnsi(run(["callers", symbol], cwd)); } catch { return ""; }
}

export function impact(symbol: string, cwd?: string): string {
  try { return stripAnsi(run(["impact", symbol], cwd)); } catch { return ""; }
}

export function affected(files: string[], cwd?: string): string {
  try { return stripAnsi(run(["affected", ...files], cwd)); } catch { return ""; }
}

// ── Doctor line ──────────────────────────────────────────────────────

export function doctorLine(cwd?: string): string {
  const s = getStatus(cwd);
  if (!s.installed) return "codegraph: not installed";
  if (!s.initialized) return "codegraph: not initialized → run: codegraph init";

  const icon = s.upToDate ? "✅" : "⚠️";
  let line = `codegraph: ${icon} ${s.files} files, ${s.nodes} symbols, ${s.edges} edges, ${s.dbSize}`;

  if (!s.upToDate && s.suggestion) line += ` → ${s.suggestion}`;
  return line;
}
