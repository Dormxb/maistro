import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BindKind = "pi-session" | "claude-cli" | "codex-cli" | "unavailable";

export interface ResolvedBinding {
  provider: string;
  model: string;
  kind: BindKind;
  piModel?: unknown;
  cliPath?: string;
  cliModel?: string;
  note?: string;
}

const CLAUDE_CANDIDATES = [
  join(homedir(), ".local", "bin", "claude.exe"),
  "C:\\\\Users\\\\JMAAT001\\\\.local\\\\bin\\\\claude.exe",
  "claude",
];

const CODEX_CANDIDATES = [
  "C:\\\\Users\\\\JMAAT001\\\\AppData\\\\Local\\\\OpenAI\\\\Codex\\\\bin\\\\codex.exe",
  "codex",
];

function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) {
    if (p === "claude" || p === "codex") return p;
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function claudeCliModel(modelId: string): string {
  const m = modelId.toLowerCase();
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return modelId;
}

export function codexCliModel(modelId: string): string {
  return modelId;
}

/**
 * Resolve how to run a configured provider/model on this machine.
 * Prefer pi ModelRuntime; fall back to Claude/Codex CLIs.
 */
export async function resolveBinding(
  mod: any,
  provider: string,
  modelId: string,
): Promise<ResolvedBinding> {
  const providerL = provider.toLowerCase();
  const modelL = modelId.toLowerCase();

  // 1) pi ModelRuntime (correct API — not AuthStorage.create which is not exported)
  try {
    const runtime = await mod.ModelRuntime.create();
    let piModel =
      runtime.getModel?.(provider, modelId) ||
      runtime.getModel?.(providerL, modelId);

    if (!piModel) {
      const all = [
        ...(runtime.getModels?.() || []),
        ...((await runtime.getAvailable?.()) || []),
        ...(runtime.getAvailableSnapshot?.() || []),
      ];
      piModel = all.find(
        (m: any) =>
          String(m.provider).toLowerCase() === providerL &&
          (m.id === modelId ||
            String(m.id).toLowerCase() === modelL ||
            String(m.id).toLowerCase().includes(modelL) ||
            modelL.includes(String(m.id).toLowerCase())),
      );
    }

    if (piModel) {
      const hasAuth =
        typeof runtime.hasConfiguredAuth === "function"
          ? runtime.hasConfiguredAuth(piModel.provider || provider)
          : true;
      if (hasAuth) {
        return {
          provider,
          model: modelId,
          kind: "pi-session",
          piModel,
          note: `pi runtime ${piModel.provider}/${piModel.id}`,
        };
      }
      // known model but no auth — fall through to CLI
    }

    // Also try resolveCliModel if exported
    if (typeof mod.resolveCliModel === "function") {
      try {
        const resolved = await mod.resolveCliModel({
          cliModel: `${provider}/${modelId}`,
          modelRegistry: new mod.ModelRegistry(runtime),
        });
        if (resolved?.model) {
          return {
            provider,
            model: modelId,
            kind: "pi-session",
            piModel: resolved.model,
            note: `resolveCliModel ${resolved.model.provider}/${resolved.model.id}`,
          };
        }
      } catch {
        /* continue */
      }
    }
  } catch (e) {
    // continue to CLI
  }

  // 2) Claude CLI for anthropic
  if (providerL === "anthropic" || modelL.includes("claude") || modelL.includes("fable")) {
    const cli = firstExisting(CLAUDE_CANDIDATES);
    if (cli) {
      return {
        provider: "anthropic",
        model: modelId,
        kind: "claude-cli",
        cliPath: cli,
        cliModel: claudeCliModel(modelId),
        note: "Claude Code CLI (pi has no anthropic credential)",
      };
    }
  }

  // 3) Codex CLI for openai
  if (providerL === "openai" || modelL.includes("gpt") || modelL.includes("sol")) {
    const cli = firstExisting(CODEX_CANDIDATES);
    if (cli) {
      return {
        provider: "openai",
        model: modelId,
        kind: "codex-cli",
        cliPath: cli,
        cliModel: codexCliModel(modelId),
        note: "Codex CLI (pi has no openai credential)",
      };
    }
  }

  return {
    provider,
    model: modelId,
    kind: "unavailable",
    note: `no pi runtime model and no CLI fallback for ${provider}/${modelId}`,
  };
}
