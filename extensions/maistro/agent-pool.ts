/**
 * P5.5 AgentPool (integrated with AgentTool system)
 *
 * Uses AgentToolRegistry + ModelRouter instead of resolveBinding().
 * Maintains backward compatibility: routing.enabled=false falls back to old path.
 * Executor hard assertion preserved: write roles MUST use pi-session.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { MaistroConfig, RoleName, WriteSession } from "./types.ts";
import { assertBudgetAllows, appendLedger, estimateCostUsd } from "./ledger.ts";
import { guardToolArgs } from "./path-guard.ts";
import { ALL_BUILTIN_FILE_TOOLS, buildGuardedCustomTools } from "./guarded-tools.ts";

// Old path (routing.enabled=false)
import { resolveBinding } from "./model-resolve.ts";
import { runClaudeCli, runCodexCli } from "./cli-runners.ts";

// New path (routing.enabled=true)
import {
  AgentToolRegistry,
  ModelRouter,
  PiSessionTool,
  ClaudeCliTool,
  CodexCliTool,
  AgyCliTool,
  KimiCliTool,
  getPiEntry,
} from "./agent-tool/index.ts";
import { setModelRolesApi } from "./agent-tool/model-router.ts";
import type { ExecuteResult, RouteResult } from "./agent-tool/types.ts";
import { recordCall } from "./token-stats.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface CallResult {
  text: string;
  model?: string;
  provider?: string;
  usage?: { input: number; output: number; cacheRead?: number };
  costUsd: number;
  worktreePath?: string;
  /** Present when ModelRouter downgraded from upgrade to baseline. */
  downgraded?: { from: string; to: string; reason: string };
}

export interface AgentPoolOptions {
  cwd: string;
  config: MaistroConfig;
  getModel?: (provider: string, modelId: string) => Promise<unknown> | unknown;
  createSession?: (opts: Record<string, unknown>) => Promise<{ session: any }>;
}

// ── AgentPool ────────────────────────────────────────────────────────

export class AgentPool {
  private cwd: string;
  private config: MaistroConfig;
  private sessions = new Map<string, any>();

  // P5: AgentTool system (initialised lazily)
  private registry?: AgentToolRegistry;
  private router?: ModelRouter;
  private _routingEnabled?: boolean;

  constructor(private opts: AgentPoolOptions) {
    this.cwd = opts.cwd;
    this.config = opts.config;
  }

  // ── Role helpers (unchanged) ─────────────────────────────────────

  getRole(role: RoleName | string) {
    const profile = this.config.agents[role];
    if (!profile) throw new Error(`unknown role: ${role}`);
    if (profile.tools.includes("bash" as never)) {
      throw new Error(`role ${role} illegally includes bash`);
    }
    return profile;
  }

  allowedTools(role: RoleName | string): string[] {
    const tools = this.getRole(role).tools.filter((t) => t !== "bash");
    return tools.filter((t) => t !== "bash");
  }

  canWrite(role: RoleName | string): boolean {
    return this.allowedTools(role).includes("write") || this.allowedTools(role).includes("edit");
  }

  guardArgs(
    role: RoleName | string,
    toolName: string,
    args: Record<string, unknown>,
    writeSession?: WriteSession,
  ): Record<string, unknown> {
    const root = writeSession?.worktreePath || this.cwd;
    const canWrite = this.canWrite(role) && !!writeSession;
    if ((toolName === "write" || toolName === "edit") && !writeSession) {
      throw new Error("BLOCKED_BY_POLICY: write/edit requires an active write session/worktree");
    }
    if (toolName === "bash") {
      throw new Error("BLOCKED_BY_POLICY: command execution disabled (P1)");
    }
    return guardToolArgs(toolName, args, this.config.security, root, canWrite);
  }

  // ── P5: Routing enabled check ────────────────────────────────────

  private get routingEnabled(): boolean {
    if (this._routingEnabled === undefined) {
      this._routingEnabled = !!(this.config as any).routing?.enabled;
    }
    return this._routingEnabled;
  }

  /** Public accessor for doctor/status display. Triggers lazy init if needed. */
  async getRegistry() {
    return this.routingEnabled ? this.ensureRegistry() : undefined;
  }

  private async ensureRegistry(): Promise<AgentToolRegistry> {
    if (this.registry) return this.registry;

    let statePath: string;
    const configured = (this.config as any).agentTools?.stateCachePath;
    if (configured) {
      statePath = configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
    } else {
      statePath = join(homedir(), ".maistro", "agent-tool-state.json");
    }

    this.registry = new AgentToolRegistry(statePath);

    // Register all built-in tools.
    this.registry.register(new PiSessionTool());
    this.registry.register(new ClaudeCliTool());
    this.registry.register(new CodexCliTool());
    this.registry.register(new AgyCliTool());
    this.registry.register(new KimiCliTool());

    await this.registry.init();

    // Create router.
    const spent = (await import("./ledger.ts")).sumMonthUsd(this.config.cost.ledgerPath);
    this.router = new ModelRouter(this.registry, {
      preferUpgrade: !!(this.config as any).routing?.preferUpgrade,
      budgetAwareDowngrade: !!(this.config as any).routing?.budgetAwareDowngrade,
      monthlyBudget: this.config.cost.monthlyBudget,
      monthlySpent: spent,
    });

    return this.registry;
  }

  // ── Main call entry ──────────────────────────────────────────────

  async call(params: {
    role: RoleName | string;
    prompt: string;
    taskId: string;
    writeSession?: WriteSession;
    systemPrompt?: string;
  }): Promise<CallResult> {
    const profile = this.getRole(params.role);
    const reserveUsd = Math.min(this.config.cost.perTaskLimit, 0.5);
    const pre = assertBudgetAllows(this.config.cost, reserveUsd);
    if (!pre.allowed) {
      throw new Error(pre.reason || "budget blocked");
    }

    const systemPrompt =
      params.systemPrompt ||
      `You are Maistro role=${params.role}. No shell. Tools limited.`;

    // ── New path: AgentTool routing ────────────────────────────────
    if (this.routingEnabled) {
      return this.callViaRouter(params, profile, systemPrompt);
    }

    // ── Old path: resolveBinding (backward compat) ─────────────────
    return this.callViaBinding(params, profile, systemPrompt);
  }

  // ── New: Router-based call ───────────────────────────────────────

  private async callViaRouter(
    params: { role: string; prompt: string; taskId: string; writeSession?: WriteSession; systemPrompt?: string },
    profile: any,
    systemPrompt: string,
  ): Promise<CallResult> {
    const registry = await this.ensureRegistry();
    const router = this.router!;
    const requireWrite = this.canWrite(params.role) && !!params.writeSession;

    // Executor hard assertion (defense in depth — preserved from P1).
    if (requireWrite) {
      const core = registry.getTool("pi-session");
      if (!core || (core.status !== "healthy" && core.status !== "degraded")) {
        throw new Error("FATAL: executor requires pi-session with write-capable healthy model");
      }
    }

    // Route.
    const tierPref = profile.tierPreference || (requireWrite ? "baseline" : "upgrade");
    const modelRole = profile.modelRole;
    let route: RouteResult;
    try {
      route = router.route(params.role, params.prompt, tierPref, modelRole);
    } catch (e: any) {
      throw new Error(`routing failed: ${e.message}`);
    }

    // Execute (with retry on upgrade→baseline fallback).
    const result = await this.executeWithRetry(route, params, systemPrompt, registry);

    if (!result.success) {
      throw result.error || new Error("agent call failed");
    }

    // ── Ledger with routed provider/model ──────────────────────────
    const routedProvider = route.tool.provider;
    const inTok = result.usage?.input || 8000;
    const outTok = result.usage?.output || 2000;
    const estimated = route.tool.id !== "pi-session"; // CLI usage is approximate

    const costUsd = estimateCostUsd(inTok, outTok, routedProvider);

    const noteParts: string[] = [
      `pool=${route.pool}`,
      `tool=${route.tool.id}`,
    ];
    if (route.downgraded) {
      noteParts.push(`downgraded:${route.downgraded.from}→${route.downgraded.to}`);
      noteParts.push(`reason:${route.downgraded.reason}`);
    }
    if (estimated) noteParts.push("cost-estimated");

    appendLedger(
      {
        ts: new Date().toISOString(),
        taskId: params.taskId,
        project: this.cwd,
        role: String(params.role),
        provider: routedProvider,
        model: result.model || route.model,
        inTok,
        outTok,
        cacheTok: result.usage?.input ? 0 : 0,
        costUsd,
        estimated,
        note: noteParts.join("; "),
      },
      this.config.cost.ledgerPath,
    );

    // P8: Record token stats for per-model/tool analysis.
    recordCall({
      ts: new Date().toISOString(),
      taskId: params.taskId,
      role: String(params.role),
      model: result.model || route.model,
      tool: route.tool.id,
      provider: routedProvider,
      input: inTok,
      output: outTok,
      costUsd,
      pool: route.pool,
      downgradedFrom: route.downgraded?.from,
    });

    return {
      text: result.text || "",
      model: result.model || route.model,
      provider: routedProvider,
      usage: { input: inTok, output: outTok, cacheRead: 0 },
      costUsd,
      worktreePath: params.writeSession?.worktreePath,
      downgraded: route.downgraded
        ? { from: route.downgraded.from, to: route.downgraded.to, reason: route.downgraded.reason }
        : undefined,
    };
  }

  /** Execute and retry once on upgrade→baseline fallback. */
  private async executeWithRetry(
    route: RouteResult,
    params: { role: string; prompt: string; taskId: string; writeSession?: WriteSession; systemPrompt?: string },
    systemPrompt: string,
    registry: AgentToolRegistry,
  ): Promise<ExecuteResult> {
    // Build execute opts.
    const thinking = this.router?.resolveThinking?.(params.role, (profile as any).modelRole);
    const execOpts = {
      role: params.role,
      prompt: params.prompt,
      systemPrompt,
      model: route.model,
      cwd: this.cwd,
      writeSessionPath: params.writeSession?.worktreePath,
      thinking,
    };

    // First attempt.
    let result = await route.tool.execute(execOpts);

    // On failure with error category: report to registry, retry if upgrade→baseline makes sense.
    if (!result.success) {
      const category = result.errorCategory || "other";
      registry.reportExecuteError(route.tool.id, category, result.error?.message);

      // If we were in upgrade pool, retry with baseline.
      if (route.pool === "upgrade") {
        const core = registry.getTool("pi-session");
        if (core && (core.status === "healthy" || core.status === "degraded")) {
          const fallbackModel = core.models[0] || "unknown";
          result = await core.execute({ ...execOpts, model: fallbackModel });
        }
      }
    }

    return result;
  }

  // ── Old: Binding-based call (backward compat) ────────────────────

  private async callViaBinding(
    params: { role: string; prompt: string; taskId: string; writeSession?: WriteSession; systemPrompt?: string },
    profile: any,
    systemPrompt: string,
  ): Promise<CallResult> {
    const piEntry = getPiEntry();
    const mod = await import(piEntry);

    // provider/model MUST exist in backward compat mode.
    if (!profile.provider || !profile.model) {
      throw new Error(
        `routing.enabled=false requires agents.${params.role}.provider and .model to be set`,
      );
    }

    const binding = await resolveBinding(mod, profile.provider, profile.model);

    // Executor writes require pi-session.
    if (this.canWrite(params.role) && binding.kind !== "pi-session") {
      throw new Error(
        `role ${params.role} needs write tools via pi-session; resolved ${binding.kind}. ` +
        `Configure executor on a pi-authenticated provider.`,
      );
    }

    let text = "";
    let usage = { input: 0, output: 0, cacheRead: 0 };
    let sawUsage = false;
    let servedModel = `${profile.provider}/${profile.model}`;

    if (binding.kind === "claude-cli") {
      const r = await runClaudeCli(binding, systemPrompt, params.prompt, {
        cwd: params.writeSession?.worktreePath || this.cwd,
      });
      text = r.text;
      servedModel = r.model;
      if (r.usage) { sawUsage = true; usage = { input: r.usage.input, output: r.usage.output, cacheRead: 0 }; }
    } else if (binding.kind === "codex-cli") {
      const r = await runCodexCli(binding, systemPrompt, params.prompt, {
        cwd: params.writeSession?.worktreePath || this.cwd,
        projectRoot: this.cwd,
        taskId: params.taskId,
      });
      text = r.text;
      servedModel = r.model;
      if (r.usage) { sawUsage = true; usage = { input: r.usage.input, output: r.usage.output, cacheRead: 0 }; }
    } else if (binding.kind === "pi-session") {
      const session = await (this as any).createStandaloneSession(
        params.role, params.writeSession, systemPrompt, binding.piModel,
      );
      const unsub = session.subscribe?.((ev: any) => {
        if (ev?.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          text += ev.assistantMessageEvent.delta || "";
        }
        if (ev?.type === "message_end" && ev.message?.role === "assistant") {
          const u = ev.message.usage;
          if (u) { sawUsage = true; usage.input += Number(u.input || u.inputTokens || 0); usage.output += Number(u.output || u.outputTokens || 0); }
          if (ev.message.model?.id) servedModel = `${ev.message.model.provider || profile.provider}/${ev.message.model.id}`;
        }
      });
      try { await session.prompt(params.prompt); }
      finally { try { unsub?.(); } catch { /* ignore */ } try { session.dispose?.(); } catch { /* ignore */ } }
    } else {
      throw new Error(`model binding unavailable for ${params.role}: ${binding.note}`);
    }

    let inTok = usage.input, outTok = usage.output;
    if (!sawUsage || (inTok === 0 && outTok === 0)) {
      inTok = Math.max(inTok, 8000);
      outTok = Math.max(outTok, 2000);
    }
    const estimated = binding.kind !== "pi-session";
    const costUsd = estimateCostUsd(inTok, outTok, profile.provider);

    appendLedger(
      {
        ts: new Date().toISOString(), taskId: params.taskId, project: this.cwd,
        role: String(params.role), provider: profile.provider, model: servedModel,
        inTok, outTok, cacheTok: usage.cacheRead, costUsd, estimated,
        note: `${binding.kind}${estimated ? ";cost-estimated" : ""}`,
      },
      this.config.cost.ledgerPath,
    );

    return {
      text, model: servedModel, provider: profile.provider,
      usage: { input: inTok, output: outTok, cacheRead: usage.cacheRead },
      costUsd, worktreePath: params.writeSession?.worktreePath,
    };
  }

  // ── Doctor: describe bindings ────────────────────────────────────

  async describeBindings(): Promise<
    Array<{ role: string; provider: string; model: string; kind: string; note?: string }>
  > {
    // Use new registry if routing enabled — show per-tool, not per-role×model.
    if (this.routingEnabled) {
      const registry = await this.ensureRegistry();
      const out: Array<{ role: string; provider: string; model: string; kind: string; note?: string }> = [];
      for (const tool of registry.getAll()) {
        // Show healthy pi models, but truncate to avoid spam.
        if (tool.id === "pi-session" && tool.modelStates) {
          const healthyModels = [...tool.modelStates.entries()]
            .filter(([, ms]) => ms.status === "healthy")
            .map(([key]) => key);
          const count = healthyModels.length;
          const preview = healthyModels.slice(0, 5).join(", ");
          out.push({
            role: "all",
            provider: tool.provider,
            model: `${count} healthy pi models (${preview}${count > 5 ? "..." : ""})`,
            kind: `${tool.class}/${tool.status}`,
            note: tool.statusMessage,
          });
        } else {
          out.push({
            role: "all",
            provider: tool.provider,
            model: tool.models.join(", "),
            kind: `${tool.class}/${tool.status}`,
            note: tool.statusMessage,
          });
        }
      }
      return out;
    }

    // Old path.
    const piEntry = getPiEntry();
    const mod = await import(piEntry);
    const out = [];
    for (const [role, profile] of Object.entries(this.config.agents)) {
      if (!(profile as any).provider || !(profile as any).model) continue;
      const b = await resolveBinding(mod, (profile as any).provider, (profile as any).model);
      out.push({ role, provider: (profile as any).provider, model: (profile as any).model, kind: b.kind, note: b.note });
    }
    return out;
  }

  dispose(): void {
    if (this.registry) {
      this.registry.dispose();
    }
    this.sessions.clear();
  }
}
