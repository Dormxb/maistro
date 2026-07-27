/**
 * P7 PlatformAdapter — cross-platform detection and path resolution.
 * Supports: claude, codex, agy, kimi, grok, gemini, qwen
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PlatformAdapter {
  os: "windows" | "macos" | "linux";
  homeDir: string;
  binExt: string;
  defaultPaths: {
    claude: string[]; codex: string[]; agy: string[];
    kimi: string[]; grok: string[]; gemini: string[]; qwen: string[];
  };
  which(name: string): Promise<string | undefined>;
}

let _platform: PlatformAdapter;

function build(ext: string, opts: {
  claude: string[]; codex: string[]; agy: string[];
  kimi: string[]; grok: string[]; gemini: string[]; qwen: string[];
}) {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  return {
    os, homeDir: home, binExt: ext as string,
    defaultPaths: {
      claude: opts.claude.map(p => p.replace("$HOME", home)),
      codex: opts.codex.map(p => p.replace("$HOME", home)),
      agy: opts.agy,
      kimi: opts.kimi.map(p => p.replace("$HOME", home)),
      grok: opts.grok,
      gemini: opts.gemini,
      qwen: opts.qwen,
    },
    which: process.platform === "win32" ? windowsWhich : unixWhich,
  } as PlatformAdapter;
}

export function detectPlatform(): PlatformAdapter {
  if (_platform) return _platform;
  const home = process.env.USERPROFILE || process.env.HOME || homedir();

  if (process.platform === "win32") {
    _platform = build(".exe", {
      claude: [join(home, ".local", "bin", "claude.exe")],
      codex: [join(home, "AppData", "Local", "OpenAI", "Codex", "bin", "codex.exe")],
      agy: ["agy.exe", "agy"],
      kimi: [join(home, ".kimi-code", "bin", "kimi.exe")],
      grok: ["grok.exe", "grok"],
      gemini: ["gemini.exe", "gemini"],
      qwen: ["qwen.exe", "qwen"],
    });
  } else if (process.platform === "darwin") {
    _platform = build("", {
      claude: ["/usr/local/bin/claude", join(home, ".local", "bin", "claude")],
      codex: ["/usr/local/bin/codex", join(home, ".local", "bin", "codex")],
      agy: ["agy"],
      kimi: [join(home, ".kimi-code", "bin", "kimi")],
      grok: ["grok"],
      gemini: ["gemini"],
      qwen: ["qwen"],
    });
  } else {
    _platform = build("", {
      claude: [join(home, ".local", "bin", "claude"), "/usr/local/bin/claude"],
      codex: [join(home, ".local", "bin", "codex"), "/usr/local/bin/codex"],
      agy: ["agy"],
      kimi: [join(home, ".kimi-code", "bin", "kimi")],
      grok: ["grok"],
      gemini: ["gemini"],
      qwen: ["qwen"],
    });
  }
  return _platform;
}

export function platform(): PlatformAdapter { return _platform || detectPlatform(); }
export function initPlatform(): PlatformAdapter { return detectPlatform(); }

async function windowsWhich(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("where", [name], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    return stdout.trim().split(/\r?\n/)[0] || undefined;
  } catch { return undefined; }
}

async function unixWhich(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", [name], { encoding: "utf8", timeout: 5000 });
    return stdout.trim().split("\n")[0] || undefined;
  } catch { return undefined; }
}

export function buildCandidates(platform: PlatformAdapter, defaults: string[], configOverride?: string | null): string[] {
  const result: string[] = [];
  if (configOverride) result.push(configOverride);
  for (const d of defaults) { if (!result.includes(d)) result.push(d); }
  const bare = defaults[0]?.split(/[\\/]/).pop()?.replace(/\.exe$/, "");
  if (bare && !result.includes(bare)) result.push(bare);
  return result;
}
