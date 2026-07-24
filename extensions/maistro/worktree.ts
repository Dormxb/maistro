import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WriteSession } from "./types.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function assertGitRepo(projectRoot: string): void {
  try {
    const v = git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
    if (v !== "true") throw new Error("not a git repo");
  } catch {
    throw new Error("Maistro P1 requires a git repository (run git init + initial commit)");
  }
}

export function acquireWriteSession(projectRoot: string, taskId: string): WriteSession {
  assertGitRepo(projectRoot);
  const root = resolve(projectRoot);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  const branch = `maistro/${taskId}`;
  const worktreePath = join(root, ".maistro-worktrees", taskId);
  mkdirSync(join(root, ".maistro-worktrees"), { recursive: true });

  // cleanup stale
  if (existsSync(worktreePath)) {
    try {
      git(root, ["worktree", "remove", "--force", worktreePath]);
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }
  try {
    git(root, ["branch", "-D", branch]);
  } catch {
    // branch may not exist
  }

  git(root, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);

  // Block .maistro-session.json from appearing in diffs.
  const gitignorePath = join(worktreePath, ".gitignore");
  try {
    const existing = existsSync(gitignorePath) ? require("node:fs").readFileSync(gitignorePath, "utf8") : "";
    if (!existing.includes(".maistro-session.json")) {
      writeFileSync(gitignorePath, (existing ? existing + "\n" : "") + ".maistro-session.json\n");
    }
  } catch { /* best effort */ }

  // mark
  writeFileSync(
    join(worktreePath, ".maistro-session.json"),
    JSON.stringify({ taskId, branch, baseCommit, createdAt: new Date().toISOString() }, null, 2),
  );

  return {
    taskId,
    worktreePath,
    branch,
    baseCommit,
    createdAt: new Date().toISOString(),
  };
}

export function disposeWriteSession(
  projectRoot: string,
  session: WriteSession,
  mode: "discard" | "keep-branch" = "discard",
): void {
  const root = resolve(projectRoot);
  try {
    git(root, ["worktree", "remove", "--force", session.worktreePath]);
  } catch {
    rmSync(session.worktreePath, { recursive: true, force: true });
  }
  if (mode === "discard") {
    try {
      git(root, ["branch", "-D", session.branch]);
    } catch {
      // ignore
    }
  }
}

export function worktreeStatus(session: WriteSession): string {
  try {
    return git(session.worktreePath, ["status", "--porcelain"]);
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

export function worktreeDiff(session: WriteSession): string {
  try {
    return git(session.worktreePath, ["diff", "--stat", session.baseCommit]);
  } catch (e) {
    return `error: ${String(e)}`;
  }
}
