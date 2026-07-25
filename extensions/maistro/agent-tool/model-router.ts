/**
 * P9 ModelRouter — integrated with pi-model-roles for baseline model resolution.
 *
 * When pi-model-roles is installed and the role config has a `modelRole` mapping,
 * baseline model selection uses pi-model-roles' explicit role→model binding
 * instead of alphabetical ordering. Thinking level is also resolved from the role.
 */

import type {
  AgentToolProvider,
  DowngradeReason,
  RouteResult,
  RoutingPool,
} from "./types.ts";
import type { AgentToolRegistry } from "./registry.ts";

// ── Optional pi-model-roles integration ──────────────────────────────

let modelRolesApi: any = null;

export function setModelRolesApi(api: any): void {
  modelRolesApi = api;
}

// ── Config ────────────────────────────────────────────────────────────

export interface RouterConfig {
  preferUpgrade: boolean;
  budgetAwareDowngrade: boolean;
  monthlyBudget: number;
  monthlySpent: number;
}

// ── Role-level upgrade preferences ────────────────────────────────────

const ROLE_UPGRADE_PREFS: Record<string, string[]> = {
  architect: ["claude-cli", "codex-cli", "agy-cli", "kimi-cli"],
  challenger: ["codex-cli", "agy-cli", "kimi-cli", "claude-cli"],
};

// ── ModelRouter ───────────────────────────────────────────────────────

export class ModelRouter {
  private config: RouterConfig;

  constructor(
    private registry: AgentToolRegistry,
    config: Partial<RouterConfig> = {},
  ) {
    this.config = {
      preferUpgrade: config.preferUpgrade ?? true,
      budgetAwareDowngrade: config.budgetAwareDowngrade ?? true,
      monthlyBudget: config.monthlyBudget ?? 50,
      monthlySpent: config.monthlySpent ?? 0,
    };

    this.registry.onChange(() => {});
  }

  updateBudget(monthlySpent: number): void {
    this.config.monthlySpent = monthlySpent;
  }

  route(
    role: string,
    prompt: string,
    tierPref: string = "upgrade",
    modelRole?: string,
  ): RouteResult {
    const core = this.registry.getTool("pi-session");
    const requireWrite = role === "executor";

    // ── Executor: always baseline ──────────────────────────────────
    if (requireWrite) {
      if (!core || (core.status !== "healthy" && core.status !== "degraded")) {
        throw new Error("FATAL: no healthy pi-session for executor (write required)");
      }
      const model = this.pickBestCoreModel(core, { requireWrite: true, role, modelRole });
      return { tool: core, model, pool: "baseline" };
    }

    // ── Budget-aware downgrade ─────────────────────────────────────
    const budgetRatio = this.config.monthlySpent / Math.max(1, this.config.monthlyBudget);
    const forceBaseline = this.config.budgetAwareDowngrade && budgetRatio >= 0.8;
    const strictUpgrade = tierPref === "upgrade-required";

    // ── Upgrade path ───────────────────────────────────────────────
    if (this.config.preferUpgrade && !forceBaseline) {
      const prefs = ROLE_UPGRADE_PREFS[role] || [];
      const healthyEnhancements = this.registry.getHealthyEnhancements();

      for (const toolId of prefs) {
        const tool = healthyEnhancements.find((t) => t.id === toolId);
        if (tool && tool.models.length > 0) {
          return {
            tool,
            model: tool.models[0],
            pool: "upgrade",
          };
        }
      }

      if (strictUpgrade) {
        const unavailable = prefs.map((id) => {
          const t = this.registry.getTool(id);
          return t ? `${t.id}=${t.status}` : `${id}=not_registered`;
        }).join(", ");
        throw new Error(`upgrade-required: no healthy CLI tool. Status: ${unavailable}`);
      }
    }

    // ── Baseline path ──────────────────────────────────────────────
    if (!core || core.status === "unavailable") {
      throw new Error("FATAL: pi-session unavailable");
    }

    const model = this.pickBestCoreModel(core, { requireWrite: false, role, modelRole });
    const downgradeReason: DowngradeReason | undefined = forceBaseline
      ? { from: "upgrade", to: "baseline", reason: `budget ${Math.round(budgetRatio * 100)}% spent` }
      : tierPref === "upgrade" || tierPref === "upgrade-required"
        ? { from: "upgrade", to: "baseline", reason: "no healthy CLI tools available" }
        : undefined;

    return { tool: core, model, pool: "baseline", downgraded: downgradeReason };
  }

  /**
   * P9: Resolve thinking level from pi-model-roles if available.
   * Returns undefined if model-roles is not installed or role has no thinking config.
   */
  resolveThinking(role: string, modelRole?: string): string | undefined {
    if (!modelRolesApi) return undefined;
    try {
      const roleName = modelRole || role;
      const config = modelRolesApi.getRole(roleName);
      return config?.thinking;
    } catch {
      return undefined;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Pick the best available core model. P9: uses pi-model-roles if available. */
  private pickBestCoreModel(
    core: AgentToolProvider,
    opts: { requireWrite: boolean; role: string; modelRole?: string },
  ): string {
    // Try pi-model-roles resolution first.
    if (modelRolesApi && core.modelStates && core.modelStates.size > 0) {
      try {
        const roleName = opts.modelRole || opts.role;
        const resolved = modelRolesApi.resolveRole(roleName);
        if (resolved?.model) {
          const key = `${resolved.model.provider}/${resolved.model.id}`;
          const ms = core.modelStates.get(key);
          if (ms && (ms.status === "healthy" || ms.status === "degraded")) {
            if (opts.requireWrite && ms.status !== "healthy") {
              // Write requires healthy model — fall through to alphabetical.
            } else {
              return key;
            }
          }
        }
      } catch {
        // pi-model-roles not installed or role not found — fall through.
      }
    }

    // Fallback: alphabetical with healthy-first.
    if (!core.modelStates || core.modelStates.size === 0) {
      return core.models[0] || "unknown";
    }

    const entries = [...core.modelStates.entries()]
      .filter(([, ms]) => {
        if (opts.requireWrite && ms.status !== "healthy" && ms.status !== "degraded") {
          return false;
        }
        return ms.status === "healthy" || ms.status === "degraded";
      })
      .map(([key, ms]) => ({ key, healthy: ms.status === "healthy" }));

    if (entries.length === 0) throw new Error("no healthy core model available");

    entries.sort((a, b) => {
      if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
      return a.key.localeCompare(b.key);
    });

    return entries[0].key;
  }
}
