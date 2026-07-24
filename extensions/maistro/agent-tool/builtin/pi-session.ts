/**
 * P5.2 PiSessionTool (core)
 *
 * Wraps pi ModelRuntime to auto-discover all configured models.
 * The only tool with write capability. Fatal if no write model is healthy.
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "../../platform.ts";
import type {
  AgentToolProvider,
  ExecuteOpts,
  ExecuteResult,
  ModelState,
  ProbeResult,
  ProviderClass,
} from "../types.ts";

// P7: pi module path — resolved from Node module resolution or npm root -g.
let _piEntry: string;

export function initPiEntry(_ext?: any): void {
  // 1. Best: Node 22+ import.meta.resolve (OS-independent).
  try {
    _piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    return;
  } catch {}

  // 2. Fallback: npm root -g (works for any Node.js install method: brew, nvm, fnm, official).
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const root = execSync("npm root -g", { encoding: "utf8", timeout: 5000 }).trim();
    const path = `${root}/@earendil-works/pi-coding-agent/dist/index.js`;
    if (existsSync(path)) {
      _piEntry = `file://${path}`;
      return;
    }
  } catch {}

  // 3. Last resort: hardcoded common paths.
  const home = platform().homeDir;
  for (const path of [
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    `${home}/.pi/agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js`,
  ]) {
    if (existsSync(path)) { _piEntry = `file://${path}`; return; }
  }

  // Give up — will fail later with a clear error.
  _piEntry = "";
}

export function getPiEntry(): string {
  if (!_piEntry) initPiEntry();
  if (!_piEntry) throw new Error(
    "Cannot find pi module. Please report this with your OS and Node.js install method."
  );
  return _piEntry;
}

// ── PiSessionTool ────────────────────────────────────────────────────

export class PiSessionTool implements AgentToolProvider {
  id = "pi-session";
  class: ProviderClass = "core";
  provider = "pi";
  label = "Pi Session";
  capabilities = { read: true, write: true };
  models: string[] = [];

  status = "unknown" as const;
  statusSince = new Date();
  modelStates = new Map<string, ModelState>();

  private _mod: any;
  private _runtime: any;

  async probe(): Promise<ProbeResult> {
    const modelStates: Record<string, ModelState> = {};

    try {
      if (!this._mod) {
        this._mod = await import(PI_ENTRY);
      }
      const runtime = await this._mod.ModelRuntime.create();
      this._runtime = runtime;

      // Discover all models.
      const allModels: any[] = [
        ...(runtime.getModels?.() || []),
        ...((await runtime.getAvailable?.()) || []),
        ...(runtime.getAvailableSnapshot?.() || []),
      ];

      if (allModels.length === 0) {
        return {
          status: "unavailable",
          message: "no models configured in pi",
          modelStates: {},
        };
      }

      const seen = new Set<string>();
      this.models = [];

      for (const m of allModels) {
        const provider = String(m.provider ?? "unknown");
        const modelId = String(m.id ?? m.model ?? "unknown");
        const key = `${provider}/${modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.models.push(key);

        // Check auth.
        let authOk = true;
        try {
          if (typeof runtime.hasConfiguredAuth === "function") {
            authOk = runtime.hasConfiguredAuth(provider);
          }
        } catch {
          authOk = false;
        }

        modelStates[key] = {
          status: authOk ? "healthy" : "unavailable",
          statusSince: new Date().toISOString(),
          statusMessage: authOk ? undefined : `auth failed for ${provider}`,
        };
      }

      // Discovered successfully.
      this.modelStates.clear();
      for (const [k, v] of Object.entries(modelStates)) {
        this.modelStates.set(k, v);
      }

      // Derive overall status.
      const { status, message } = deriveStatus(modelStates);
      this.status = status;
      this.statusSince = new Date();

      return { status, message, modelStates };
    } catch (e) {
      this.status = "unavailable";
      this.statusSince = new Date();
      return {
        status: "unavailable",
        message: `pi runtime probe failed: ${String(e)}`,
        modelStates: {},
      };
    }
  }

  async execute(opts: ExecuteOpts): Promise<ExecuteResult> {
    // Parse model from "provider/model" format.
    const [provider, modelId] = opts.model.split("/");

    if (!this._mod) {
      this._mod = await import(PI_ENTRY);
    }

    // Re-use the session creation logic from agent-pool (will be refactored in P5.5).
    // For now, delegate to a lightweight pi session.
    try {
      const runtime = this._runtime || (await this._mod.ModelRuntime.create());

      const piModel =
        runtime.getModel?.(provider, modelId) ||
        runtime.getModel?.(provider.toLowerCase(), modelId);

      if (!piModel) {
        return {
          success: false,
          error: new Error(`model ${opts.model} not found in pi registry`),
          errorCategory: "other",
        };
      }

      const cwd = opts.writeSessionPath || opts.cwd;
      const agentDir = join(homedir(), ".pi", "agent");

      // Build tools list based on role capabilities.
      const toolNames = ["read", "grep", "find", "ls"];
      if (this.capabilities.write && opts.writeSessionPath) {
        toolNames.push("write", "edit");
      }

      const loader = new this._mod.DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        systemPromptOverride: () =>
          opts.systemPrompt ||
          [
            `You are Maistro role=${opts.role}.`,
            `Model: ${opts.model}.`,
            `Command execution is DISABLED.`,
            opts.writeSessionPath
              ? `Write only inside: ${opts.writeSessionPath}`
              : "Read-only mode.",
          ].join("\n"),
      });
      await loader.reload();

      const { session } = await this._mod.createAgentSession({
        cwd,
        agentDir,
        tools: toolNames,
        excludeTools: ["bash"],
        resourceLoader: loader,
        sessionManager: this._mod.SessionManager.inMemory(cwd),
        model: piModel,
      });

      let text = "";
      let usage = { input: 0, output: 0 };

      const unsub = session.subscribe?.((ev: any) => {
        if (ev?.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          text += ev.assistantMessageEvent.delta || "";
        }
        if (ev?.type === "message_end" && ev.message?.role === "assistant") {
          const u = ev.message.usage;
          if (u) {
            usage.input += Number(u.input || u.inputTokens || 0);
            usage.output += Number(u.output || u.outputTokens || 0);
          }
        }
      });

      try {
        await session.prompt(opts.prompt);
      } finally {
        try { unsub?.(); } catch { /* ignore */ }
        try { session.dispose?.(); } catch { /* ignore */ }
      }

      return { success: true, text, model: opts.model, usage };
    } catch (e: any) {
      const category = categorizeError(e);
      return {
        success: false,
        error: e,
        errorCategory: category,
      };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function deriveStatus(states: Record<string, ModelState>): {
  status: import("../types.ts").AgentToolStatus;
  message?: string;
} {
  const entries = Object.values(states);
  if (entries.length === 0) return { status: "unavailable", message: "no models" };

  const hasHealthy = entries.some((s) => s.status === "healthy");
  const hasDegraded = entries.some((s) => s.status === "degraded");
  const hasRateLimited = entries.some((s) => s.status === "rate_limited");
  const allUnavailable = entries.every((s) => s.status === "unavailable");

  if (hasHealthy) return { status: "healthy" };
  if (allUnavailable) return { status: "unavailable", message: "all models unavailable" };
  if (hasDegraded) return { status: "degraded" };
  if (hasRateLimited) return { status: "rate_limited" };
  return { status: "unknown" };
}

function categorizeError(e: any): import("../types.ts").ErrorCategory {
  const msg = String(e?.message || e || "").toLowerCase();
  if (/rate.limit|429|throttl/i.test(msg)) return "rate_limit";
  if (/quota|weekly|monthly|exceeded|limit reached/i.test(msg)) return "quota";
  if (/auth|unauthorized|forbidden|401|403|key.*invalid/i.test(msg)) return "auth";
  if (/timeout|timed.?out|ETIMEDOUT/i.test(msg)) return "timeout";
  if (/network|ECONNREFUSED|ENOTFOUND|fetch.failed/i.test(msg)) return "network";
  return "other";
}
