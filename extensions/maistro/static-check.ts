import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isDeniedPath } from "./path-guard.ts";
import type { SecurityConfig } from "./types.ts";

export interface StaticCheckResult {
  id: string;
  verdict: "pass" | "fail";
  findings: string[];
}

export interface StaticReport {
  verdict: "pass" | "fail";
  checks: StaticCheckResult[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  }).trim();
}

function listChangedFiles(worktreePath: string, baseCommit: string): string[] {
  const set = new Set<string>();
  try {
    const out = git(worktreePath, ["diff", "--name-only", baseCommit]);
    for (const f of out ? out.split(/\r?\n/).filter(Boolean) : []) set.add(f);
  } catch {
    /* ignore */
  }
  try {
    const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
    for (const f of untracked ? untracked.split(/\r?\n/).filter(Boolean) : []) set.add(f);
  } catch {
    /* ignore */
  }
  // include gitignored untracked (e.g. .env) for policy scanning
  try {
    const ignored = git(worktreePath, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
    ]);
    for (const f of ignored ? ignored.split(/\r?\n/).filter(Boolean) : []) set.add(f);
  } catch {
    /* ignore */
  }
  return [...set];
}

/** policy: no denied paths in diff; no .git writes */
function checkPolicy(
  worktreePath: string,
  baseCommit: string,
  security: SecurityConfig,
): StaticCheckResult {
  const findings: string[] = [];
  const files = listChangedFiles(worktreePath, baseCommit);
  for (const f of files) {
    if (f === ".git" || f.startsWith(".git/") || f.includes("/.git/")) {
      findings.push(`diff touches git metadata: ${f}`);
    }
    if (isDeniedPath(f, security.deniedPaths, worktreePath)) {
      findings.push(`diff touches denied path: ${f}`);
    }
    if (f.includes("node_modules")) {
      findings.push(`diff touches node_modules: ${f}`);
    }
  }
  return {
    id: "policy",
    verdict: findings.length ? "fail" : "pass",
    findings,
  };
}

/** diff: must have some change for write tasks */
function checkDiff(worktreePath: string, baseCommit: string): StaticCheckResult {
  const findings: string[] = [];
  let stat = "";
  try {
    stat = git(worktreePath, ["diff", "--stat", baseCommit]);
  } catch (e) {
    findings.push(`git diff failed: ${String(e)}`);
  }
  const porcelain = git(worktreePath, ["status", "--porcelain"]);
  if (!stat && !porcelain) {
    findings.push("no file changes in worktree");
  }
  return {
    id: "diff",
    verdict: findings.length ? "fail" : "pass",
    findings: findings.length ? findings : [`changes ok: ${stat || porcelain.split("\n").length + " files"}`],
  };
}

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".toml",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".cs",
]);

/** syntax: lightweight brace/bracket balance on changed text files */
function checkSyntax(worktreePath: string, baseCommit: string): StaticCheckResult {
  const findings: string[] = [];
  const files = listChangedFiles(worktreePath, baseCommit);
  for (const f of files) {
    const ext = f.includes(".") ? f.slice(f.lastIndexOf(".")) : "";
    if (!TEXT_EXT.has(ext)) continue;
    const abs = join(worktreePath, f);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // strip strings roughly
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/`(?:\\.|[^`\\])*`/g, "''")
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""');
    const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
    const stack: string[] = [];
    for (const ch of stripped) {
      if (ch in pairs) stack.push(pairs[ch]);
      else if (Object.values(pairs).includes(ch)) {
        const exp = stack.pop();
        if (exp !== ch) {
          findings.push(`${f}: unbalanced '${ch}'`);
          break;
        }
      }
    }
    if (stack.length) findings.push(`${f}: unclosed ${stack.join(" ")}`);
  }
  return {
    id: "syntax",
    verdict: findings.length ? "fail" : "pass",
    findings: findings.length ? findings : ["no obvious brace imbalance in changed text files"],
  };
}

export function runStaticChecks(
  worktreePath: string,
  baseCommit: string,
  security: SecurityConfig,
  enabled: string[] = ["policy", "diff", "syntax"],
): StaticReport {
  const checks: StaticCheckResult[] = [];
  if (enabled.includes("policy")) checks.push(checkPolicy(worktreePath, baseCommit, security));
  if (enabled.includes("diff")) checks.push(checkDiff(worktreePath, baseCommit));
  if (enabled.includes("syntax")) checks.push(checkSyntax(worktreePath, baseCommit));
  const verdict = checks.every((c) => c.verdict === "pass") ? "pass" : "fail";
  return { verdict, checks };
}

export function getUnifiedDiff(worktreePath: string, baseCommit: string): string {
  try {
    const tracked = git(worktreePath, ["diff", baseCommit]);
    const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
    let extra = "";
    if (untracked) {
      for (const f of untracked.split(/\r?\n/).filter(Boolean)) {
        try {
          const body = readFileSync(join(worktreePath, f), "utf8");
          extra += `\n--- /dev/null\n+++ b/${f}\n` + body.split(/\r?\n/).map((l) => `+${l}`).join("\n") + "\n";
        } catch {
          /* binary skip */
        }
      }
    }
    return (tracked + extra).trim();
  } catch (e) {
    return `/* diff error: ${String(e)} */`;
  }
}
