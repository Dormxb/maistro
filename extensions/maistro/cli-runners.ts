import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ResolvedBinding } from "./model-resolve.ts";

const execFileAsync = promisify(execFile);

export interface CliRunResult {
  text: string;
  raw: string;
  model: string;
  provider: string;
  /** CLI runners usually don't expose token usage */
  usage?: { input: number; output: number; cacheRead?: number };
}

function approxTokens(s: string): number {
  // rough: ~4 chars/token for mixed text
  return Math.max(1, Math.ceil(s.length / 4));
}

export async function runClaudeCli(
  binding: ResolvedBinding,
  systemPrompt: string,
  userPrompt: string,
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<CliRunResult> {
  const bin = binding.cliPath || "claude";
  const model = binding.cliModel || "fable";
  const full = `${systemPrompt}\n\n---\n\n${userPrompt}`;
  const args = [
    "--model",
    model,
    "--permission-mode",
    "bypassPermissions",
    "-p",
    full,
  ];
  const { stdout, stderr } = await execFileAsync(bin, args, {
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs ?? 600_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
  const raw = `${stdout}\n${stderr}`;
  const text = String(stdout || "").trim() || String(stderr || "").trim();
  return {
    text,
    raw,
    model: `anthropic/${model}`,
    provider: "anthropic",
    usage: {
      input: approxTokens(full),
      output: approxTokens(text),
    },
  };
}

export async function runCodexCli(
  binding: ResolvedBinding,
  systemPrompt: string,
  userPrompt: string,
  opts?: { cwd?: string; timeoutMs?: number; taskId?: string; projectRoot?: string },
): Promise<CliRunResult> {
  const bin = binding.cliPath || "codex";
  const model = binding.cliModel || binding.model;
  const full = `${systemPrompt}\n\n---\n\n${userPrompt}`;

  // Persist prompt for debugging
  if (opts?.projectRoot && opts?.taskId) {
    const dir = join(opts.projectRoot, "output", "cli-runs", opts.taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "codex-prompt.txt"), full, "utf8");
  }

  const args = [
    "exec",
    "--skip-git-repo-check",
    ...(opts?.cwd ? ["-C", opts.cwd] : []),
    ...(model ? ["-m", model] : []),
    full,
  ];

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeoutMs ?? 600_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    const raw = `${stdout}\n${stderr}`;
    const text = String(stdout || "").trim() || String(stderr || "").trim();
    return {
      text,
      raw,
      model: `openai/${model}`,
      provider: "openai",
      usage: { input: approxTokens(full), output: approxTokens(text) },
    };
  } catch (e: any) {
    const raw = `${e?.stdout || ""}\n${e?.stderr || e}`;
    // still return text if any
    const text = String(e?.stdout || "").trim();
    if (text) {
      return {
        text,
        raw,
        model: `openai/${model}`,
        provider: "openai",
        usage: { input: approxTokens(full), output: approxTokens(text) },
      };
    }
    throw e;
  }
}
