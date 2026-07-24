import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import type { SecurityConfig } from "./types.ts";

const DOS_DEVICES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(2));
  }
  if (p.toUpperCase().includes("%USERPROFILE%")) {
    return p.replace(/%USERPROFILE%/gi, homedir());
  }
  return p;
}

export function normalizePath(p: string, root?: string): string {
  let x = expandHome(p).replace(/\\/g, "/");
  // ADS / stream
  if (x.includes(":") && !/^[A-Za-z]:\//.test(x) && !/^[A-Za-z]:$/.test(x)) {
    throw new Error("BLOCKED_BY_POLICY: ADS/stream paths are not allowed");
  }
  const base = x.split("/").pop() || "";
  const stem = base.split(".")[0]?.toUpperCase() || "";
  if (DOS_DEVICES.has(stem)) {
    throw new Error(`BLOCKED_BY_POLICY: DOS device name ${stem}`);
  }
  const abs = isAbsolute(expandHome(p))
    ? resolve(expandHome(p))
    : resolve(root || process.cwd(), expandHome(p));
  let out = abs;
  try {
    if (existsSync(abs)) out = realpathSync(abs);
  } catch {
    // keep resolved abs
  }
  out = out.replace(/\\/g, "/");
  if (platform() === "win32") out = out.toLowerCase();
  return out;
}

function patternToRegExp(pattern: string): RegExp {
  let pat = expandHome(pattern).replace(/\\/g, "/");
  // Treat patterns without ** as matching any directory prefix for basename-like globs
  if (!pat.includes("/") && (pat.startsWith("*.") || pat.startsWith("*"))) {
    pat = "**/" + pat;
  }
  if (pat.startsWith("~/")) {
    pat = normalizePath(pat);
  }
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*" && pat[i + 1] === "*") {
      re += ".*";
      i++;
      if (pat[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if ("+|(){}^$.".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, platform() === "win32" ? "i" : "");
}

export function isDeniedPath(targetPath: string, denied: string[], root?: string): boolean {
  let norm: string;
  try {
    norm = normalizePath(targetPath, root);
  } catch {
    return true;
  }
  const rel = root
    ? relative(normalizePath(root), norm).replace(/\\/g, "/")
    : norm;
  const candidates = [norm, rel, norm.split("/").pop() || ""];
  for (const pat of denied) {
    const rx = patternToRegExp(pat);
    for (const c of candidates) {
      const cc = platform() === "win32" ? c.toLowerCase() : c;
      if (rx.test(cc) || rx.test(c)) return true;
    }
    // also match expanded home absolute patterns
    if (pat.includes("~") || pat.includes("%USERPROFILE%")) {
      const absPat = patternToRegExp(expandHome(pat));
      if (absPat.test(norm)) return true;
    }
  }
  return false;
}

export function assertInsideRoot(targetPath: string, root: string): string {
  const nRoot = normalizePath(root);
  const nTarget = normalizePath(targetPath, root);
  const rel = relative(nRoot, nTarget).replace(/\\/g, "/");
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`BLOCKED_BY_POLICY: path escapes root ${nRoot}`);
  }
  return nTarget;
}

export function assertReadable(
  targetPath: string,
  security: SecurityConfig,
  root?: string,
): string {
  const norm = normalizePath(targetPath, root);
  if (root) assertInsideRoot(norm, root);
  // Outside project root is blocked for agent tools when root is project
  if (root) {
    // already inside root
  }
  if (isDeniedPath(norm, security.deniedPaths, root)) {
    throw new Error(`BLOCKED_BY_POLICY: read denied for ${targetPath}`);
  }
  return norm;
}

export function assertWritable(
  targetPath: string,
  security: SecurityConfig,
  root: string,
): string {
  const norm = assertInsideRoot(targetPath, root);
  if (isDeniedPath(norm, security.deniedPaths, root)) {
    throw new Error(`BLOCKED_BY_POLICY: write denied for ${targetPath}`);
  }
  // protect .git management plane
  const rel = relative(normalizePath(root), norm).replace(/\\/g, "/");
  if (rel === ".git" || rel.startsWith(".git/") || rel.split("/").includes(".git")) {
    throw new Error("BLOCKED_BY_POLICY: .git is not writable");
  }
  if (rel.includes("node_modules")) {
    throw new Error("BLOCKED_BY_POLICY: node_modules is not writable");
  }
  return norm;
}

export function assertWriteSize(bytes: number, security: SecurityConfig): void {
  if (bytes > security.maxFileWriteBytes) {
    throw new Error(
      `BLOCKED_BY_POLICY: write exceeds maxFileWriteBytes (${security.maxFileWriteBytes})`,
    );
  }
}

/** Wrap a pi tool execute function with path policy. */
export function guardToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  security: SecurityConfig,
  root: string,
  canWrite: boolean,
): Record<string, unknown> {
  const next = { ...args };
  const pathKeys = ["path", "file_path", "filePath", "target"];
  for (const k of pathKeys) {
    if (typeof next[k] === "string") {
      const p = next[k] as string;
      if (toolName === "write" || toolName === "edit") {
        if (!canWrite) throw new Error(`BLOCKED_BY_POLICY: ${toolName} not allowed for this role`);
        next[k] = assertWritable(p, security, root);
      } else if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
        // ls may take path
        try {
          next[k] = assertReadable(p, security, root);
        } catch (e) {
          // for ls/find root listing of denied leaves — rethrow
          throw e;
        }
      }
    }
  }
  if (toolName === "write" && typeof next.content === "string") {
    assertWriteSize(Buffer.byteLength(next.content, "utf8"), security);
  }
  if (toolName === "bash") {
    throw new Error("BLOCKED_BY_POLICY: bash/command execution is disabled in Maistro P1");
  }
  return next;
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
