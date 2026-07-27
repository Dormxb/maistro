/**
 * P7 PlatformAdapter — cross-platform detection and path resolution.
 *
 * Replaces all hardcoded "C:\\Users\\JMAAT001\\..." paths and ".exe" assumptions.
 * Called once at extension startup; result is a singleton used by all AgentTools.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────

export interface PlatformAdapter {
  os: "windows" | "macos" | "linux";
  homeDir: string;
  binExt: string;
  defaultPaths: {
    claude: string[];
    codex: string[];
    agy: string[];
    kimi: string[];
    grok: string[];
  };
  which(name: string): Promise<string | undefined>;
}

// ── Detection ────────────────────────────────────────────────────────

let _platform: PlatformAdapter;

export function detectPlatform(): PlatformAdapter {
  if (_platform) return _platform;

  const p = process.platform;
  const home = process.env.USERPROFILE || process.env.HOME || homedir();

  if (p === "win32") {
    _platform = {
      os: "windows",
      homeDir: home,
      binExt: ".exe",
      defaultPaths: {
        claude: [join(home, ".local", "bin", "claude.exe")],
        codex: [join(home, "AppData", "Local", "OpenAI", "Codex", "bin", "codex.exe")],
        agy: ["agy.exe", "agy"],
        kimi: [join(home, ".kimi-code", "bin", "kimi.exe")],
      },
      which: windowsWhich,
    };
  } else if (p === "darwin") {
    _platform = {
      os: "macos",
      homeDir: home,
      binExt: "",
      defaultPaths: {
        claude: ["/usr/local/bin/claude", join(home, ".local", "bin", "claude")],
        codex: ["/usr/local/bin/codex", join(home, ".local", "bin", "codex")],
        agy: ["agy"],
        kimi: [join(home, ".kimi-code", "bin", "kimi")],
        grok: ["grok"],
      },
      which: unixWhich,
    };
  } else {
    _platform = {
      os: "linux",
      homeDir: home,
      binExt: "",
      defaultPaths: {
        claude: [join(home, ".local", "bin", "claude"), "/usr/local/bin/claude"],
        codex: [join(home, ".local", "bin", "codex"), "/usr/local/bin/codex"],
        agy: ["agy"],
        kimi: [join(home, ".kimi-code", "bin", "kimi")],
        grok: ["grok"],
      },
      which: unixWhich,
    };
  }

  return _platform;
}

export function platform(): PlatformAdapter {
  return _platform || detectPlatform();
}

export function initPlatform(): PlatformAdapter {
  return detectPlatform();
}

// ── which implementations ────────────────────────────────────────────

async function windowsWhich(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("where", [name], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    return stdout.trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}

async function unixWhich(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", [name], {
      encoding: "utf8",
      timeout: 5000,
    });
    return stdout.trim().split("\n")[0] || undefined;
  } catch {
    return undefined;
  }
}

// ── Binary candidate builder ─────────────────────────────────────────

/**
 * Build ordered binary search list:
 *   1. User-configured override (from .maistro.jsonc agentTools.providers.<id>.binary)
 *   2. Platform default paths
 *   3. Bare binary name (PATH lookup)
 */
export function buildCandidates(
  platform: PlatformAdapter,
  defaults: string[],
  configOverride?: string | null,
): string[] {
  const result: string[] = [];

  if (configOverride) {
    result.push(configOverride);
  }

  for (const d of defaults) {
    if (!result.includes(d)) result.push(d);
  }

  // Bare name for PATH lookup.
  const bare = defaults[0]?.split(/[\\/]/).pop()?.replace(/\.exe$/, "");
  if (bare && !result.includes(bare)) {
    result.push(bare);
  }

  return result;
}
