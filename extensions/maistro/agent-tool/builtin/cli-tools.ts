/**
 * P5.2 CLI-based AgentTool helpers + implementations
 *
 * ClaudeCliTool, CodexCliTool, AgyCliTool, KimiCliTool
 * All are read-only enhancement tools that wrap external CLI binaries.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { platform, buildCandidates } from "../../platform.ts";
import type {
  AgentToolProvider,
  ExecuteOpts,
  ExecuteResult,
  ProbeResult,
  ProviderClass,
} from "../types.ts";

const execFileAsync = promisify(execFile);

// ── Shared CLI helpers ───────────────────────────────────────────────

/** Find a binary: absolute candidates first, then async PATH lookup. */
async function findBinary(candidates: string[]): Promise<string | undefined> {
  const p = platform();
  for (const c of candidates) {
    if (c.includes("/") || c.includes("\\")) {
      if (existsSync(c)) return c;
    } else {
      const found = await p.which(c);
      if (found) return found;
    }
  }
  return undefined;
}

/** Compute a lightweight fingerprint for binary caching (realpath + mtime + size, no inode). */
function fingerprint(bin: string): string | undefined {
  try {
    const stat = statSync(bin);
    return `${stat.mtimeMs}-${stat.size}`;
  } catch {
    return undefined;
  }
}

/** Run a binary with --version. Returns version string or null. */
async function runVersionCheck(bin: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["--version"], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
    });
    return (stdout || stderr || "").trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

function approxTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

function parseRetryAfter(stderr: string): Date | undefined {
  const iso = stderr.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/);
  if (iso) {
    const d = new Date(iso[1]);
    if (!isNaN(d.getTime())) return d;
  }

  const minMatch = stderr.match(/try again in (\d+)\s*min/i);
  if (minMatch) return new Date(Date.now() + parseInt(minMatch[1]) * 60_000);

  const hourMatch = stderr.match(/try again in (\d+)\s*hour/i);
  if (hourMatch) return new Date(Date.now() + parseInt(hourMatch[1]) * 3_600_000);

  if (/weekly|quota/i.test(stderr)) return new Date(Date.now() + 6 * 3_600_000);
  if (/rate limit|429/i.test(stderr)) return new Date(Date.now() + 5 * 60_000);

  return undefined;
}

function categorizeStderr(stderr: string): import("../types.ts").ErrorCategory | undefined {
  const lower = stderr.toLowerCase();
  if (/weekly.limit|quota.exceeded|monthly.limit/i.test(lower)) return "quota";
  if (/rate.limit|429|too.many.requests|throttl/i.test(lower)) return "rate_limit";
  if (/auth|unauthorized|forbidden|401|403|login|credential|api.key.*invalid/i.test(lower)) return "auth";
  if (/timeout|timed.?out/i.test(lower)) return "timeout";
  if (/network|ECONNREFUSED|ENOTFOUND|connect/i.test(lower)) return "network";
  return undefined;
}

// ── Base class for CLI tools ─────────────────────────────────────────

abstract class CliTool implements AgentToolProvider {
  abstract id: string;
  abstract provider: string;
  abstract label: string;
  class: ProviderClass = "enhancement";
  capabilities = { read: true, write: false };
  abstract models: string[];

  status = "unknown" as const;
  statusSince = new Date();

  /** Binary candidates (absolute paths first, then PATH names). */
  protected abstract binaryCandidates: string[];
  private _binaryPath?: string;
  private _fingerprint?: string;

  async probe(): Promise<ProbeResult> {
    // 1. Find binary (async — uses platform.which).
    const bin = await findBinary(this.binaryCandidates);
    if (!bin) {
      this.status = "unavailable";
      this.statusSince = new Date();
      return { status: "unavailable", message: `${this.label} binary not found` };
    }

    // 2. Fingerprint check — skip version check if unchanged.
    const fp = fingerprint(bin);
    if (fp && fp === this._fingerprint && this.status !== "unknown") {
      return { status: this.status }; // cached
    }

    // 3. --version check.
    const version = await runVersionCheck(bin);
    if (!version) {
      this.status = "degraded";
      this.statusSince = new Date();
      return { status: "degraded", message: `${this.label} --version failed` };
    }

    this._binaryPath = bin;
    this._fingerprint = fp;
    this.status = "healthy";
    this.statusSince = new Date();
    return { status: "healthy" };
  }

  async execute(opts: ExecuteOpts): Promise<ExecuteResult> {
    const bin = this._binaryPath || await findBinary(this.binaryCandidates);
    if (!bin) {
      return {
        success: false,
        error: new Error(`${this.label} binary not found`),
        errorCategory: "other",
      };
    }

    try {
      const { stdout, stderr } = await this.run(bin, opts);
      const text = String(stdout || "").trim() || String(stderr || "").trim();
      return {
        success: true,
        text,
        model: opts.model,
        usage: {
          input: approxTokens(opts.prompt),
          output: approxTokens(text),
        },
      };
    } catch (e: any) {
      const stderr = String(e?.stderr || e?.message || "");
      const category = categorizeStderr(stderr);
      return {
        success: false,
        error: e,
        errorCategory: category,
      };
    }
  }

  /** Subclass implements — builds CLI args and runs. */
  protected abstract run(
    bin: string,
    opts: ExecuteOpts,
  ): Promise<{ stdout: string; stderr: string }>;
}

// ── ClaudeCliTool ─────────────────────────────────────────────────────

export class ClaudeCliTool extends CliTool {
  id = "claude-cli";
  provider = "anthropic";
  label = "Claude CLI";
  models = ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"];

  protected binaryCandidates = [
    ...platform().defaultPaths.claude,
    "claude",
  ];

  protected async run(
    bin: string,
    opts: ExecuteOpts,
  ): Promise<{ stdout: string; stderr: string }> {
    const model = this.claudeCliModel(opts.model);
    const full = `${opts.systemPrompt || ""}\n\n---\n\n${opts.prompt}`;
    const { stdout, stderr } = await execFileAsync(
      bin,
      ["--model", model, "--permission-mode", "bypassPermissions", "-p", full],
      {
        cwd: opts.writeSessionPath || opts.cwd,
        timeout: opts.timeoutMs ?? 600_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: false,
      },
    );
    return { stdout, stderr };
  }

  private claudeCliModel(modelId: string): string {
    const m = modelId.toLowerCase();
    if (m.includes("fable")) return "fable";
    if (m.includes("opus")) return "opus";
    if (m.includes("sonnet")) return "sonnet";
    if (m.includes("haiku")) return "haiku";
    return modelId;
  }
}

// ── CodexCliTool ──────────────────────────────────────────────────────

export class CodexCliTool extends CliTool {
  id = "codex-cli";
  provider = "openai";
  label = "Codex CLI";
  models = ["gpt-5.6-sol", "gpt-5", "gpt-5-fast"];

  protected binaryCandidates = [
    ...platform().defaultPaths.codex,
    "codex",
  ];

  protected async run(
    bin: string,
    opts: ExecuteOpts,
  ): Promise<{ stdout: string; stderr: string }> {
    const full = `${opts.systemPrompt || ""}\n\n---\n\n${opts.prompt}`;
    const args = [
      "exec",
      "--skip-git-repo-check",
      ...(opts.writeSessionPath || opts.cwd ? ["-C", opts.writeSessionPath || opts.cwd] : []),
      "-m",
      opts.model,
      full,
    ];

    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        timeout: opts.timeoutMs ?? 600_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: false,
      });
      return { stdout, stderr };
    } catch (e: any) {
      // Codex may return useful stderr on failure.
      if (e?.stdout) return { stdout: e.stdout, stderr: e.stderr || "" };
      throw e;
    }
  }
}

// ── AgyCliTool ────────────────────────────────────────────────────────

export class AgyCliTool extends CliTool {
  id = "agy-cli";
  provider = "antigravity";
  label = "Agy CLI";
  models = ["antigravity-default"];

  protected binaryCandidates = [
    ...platform().defaultPaths.agy,
  ];

  protected async run(
    bin: string,
    opts: ExecuteOpts,
  ): Promise<{ stdout: string; stderr: string }> {
    const full = `${opts.systemPrompt || ""}\n\n---\n\n${opts.prompt}`;
    const { stdout, stderr } = await execFileAsync(bin, ["-p", full], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 600_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    return { stdout, stderr };
  }
}

// ── KimiCliTool ───────────────────────────────────────────────────────

export class KimiCliTool extends CliTool {
  id = "kimi-cli";
  provider = "moonshot";
  label = "Kimi CLI";
  models = ["kimi-default"];

  protected binaryCandidates = [
    ...platform().defaultPaths.kimi,
    "kimi-code",
    "kimi",
  ];

  protected async run(
    bin: string,
    opts: ExecuteOpts,
  ): Promise<{ stdout: string; stderr: string }> {
    const full = `${opts.systemPrompt || ""}\n\n---\n\n${opts.prompt}`;
    const { stdout, stderr } = await execFileAsync(bin, ["-p", full], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 600_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    return { stdout, stderr };
  }
}

// ── Factory ───────────────────────────────────────────────────────────

/** Create all built-in AgentTool instances. */
export function createAllTools(): AgentToolProvider[] {
  return [
    new (require("./pi-session.ts").PiSessionTool)(),
    new ClaudeCliTool(),
    new CodexCliTool(),
    new AgyCliTool(),
    new KimiCliTool(),
  ];
}
