/**
 * P5.3 ModelRouter
 *
 * Request-level model routing within a role.
 * Two pools: baseline (pi models, always available) and upgrade (CLI tools, optional).
 * Includes role-specific upgrade preferences to prevent Architect/Challenger same-model bias.
 * Budget-aware downgrade when monthly spend exceeds 80%.
 */

import type {
  AgentToolProvider,
  DowngradeReason,
  RouteResult,
  RoutingPool,
} from "./types.ts";
import type { AgentToolRegistry } from "./registry.ts";

// ── Config ────────────────────────────────────────────────────────────

export interface RouterConfig {
  preferUpgrade: boolean;
  budgetAwareDowngrade: boolean;
  monthlyBudget: number;
  monthlySpent: number;
}

// ── Role-level upgrade preferences ────────────────────────────────────

/**
 * Per-role ordered list of preferred CLI tool IDs for upgrade pool.
 * Architect prefers Claude (Fable 5 for design); Challenger prefers Codex (Sol for adversarial review).
 * This prevents both roles from defaulting to the same model and losing adversarial independence.
 */
const ROLE_UPGRADE_PREFS: Record<string, string[]> = {
  architect: ["claude-cli", "codex-cli", "agy-cli", "kimi-cli"],
  challenger: ["codex-cli", "agy-cli", "kimi-cli", "claude-cli"],
  // Executor never uses upgrade (CLI all read-only).
};

/** Baseline model sort: write-capable first, then alphabetically by provider. */
function baselineSort(a: { key: string; write: boolean }, b: { key: string; write: boolean }): number {
  if (a.write !== b.write) return a.write ? -1 : 1;
  return a.key.localeCompare(b.key);
}

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

    // Subscribe to registry changes — rebuild route table on any status change.
    this.registry.onChange(() => {
      // Route table is computed lazily per-request, so no explicit rebuild needed.
      // This handler exists for future caching if needed.
    });
  }

  updateBudget(monthlySpent: number): void {
    this.config.monthlySpent = monthlySpent;
  }

  /**
   * Route a request to the best available model.
   *
   * @param role      — architect | executor | challenger
   * @param prompt    — the user prompt (for future complexity classification)
   * @param tierPref  — "baseline" | "upgrade" | "upgrade-required"
   */
  route(
    role: string,
    prompt: string,
    tierPref: string = "upgrade",
  ): RouteResult {
    const core = this.registry.getTool("pi-session");
    const requireWrite = role === "executor";

    // ── Executor: always baseline ──────────────────────────────────
    if (requireWrite) {
      if (!core || (core.status !== "healthy" && core.status !== "degraded")) {
        throw new Error("FATAL: no healthy pi-session for executor (write required)");
      }
      // Pick the best write model from core.
      const model = this.pickBestCoreModel(core, { requireWrite: true });
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
          const model = tool.models[0]; // first model is the default/best
          return {
            tool,
            model: this.resolveModelName(tool, model),
            pool: "upgrade",
          };
        }
      }

      // No healthy CLI — fallback to baseline.
      if (strictUpgrade) {
        // upgrade-required: fail rather than silently downgrade.
        const unavailable = prefs.map((id) => {
          const t = this.registry.getTool(id);
          return t ? `${t.id}=${t.status}` : `${id}=not_registered`;
        }).join(", ");
        throw new Error(
          `upgrade-required: no healthy CLI tool available. Status: ${unavailable}`,
        );
      }
    }

    // ── Baseline path ──────────────────────────────────────────────
    if (!core || core.status === "unavailable") {
      throw new Error("FATAL: pi-session unavailable");
    }

    const model = this.pickBestCoreModel(core, { requireWrite: false });
    const downgradeReason: DowngradeReason | undefined = forceBaseline
      ? {
          from: "upgrade",
          to: "baseline",
          reason: `budget ${Math.round(budgetRatio * 100)}% spent, upgrade disabled`,
        }
      : tierPref === "upgrade" || tierPref === "upgrade-required"
        ? {
            from: "upgrade",
            to: "baseline",
            reason: "no healthy CLI tools available",
          }
        : undefined;

    return {
      tool: core,
      model,
      pool: "baseline",
      downgraded: downgradeReason,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Pick the best available core model. */
  private pickBestCoreModel(
    core: AgentToolProvider,
    opts: { requireWrite: boolean },
  ): string {
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
      .map(([key, ms]) => ({
        key,
        write: opts.requireWrite,
        healthy: ms.status === "healthy",
      }));

    if (entries.length === 0) {
      throw new Error("no healthy core model available");
    }

    // Prefer healthy over degraded, then alphabetical.
    entries.sort((a, b) => {
      if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
      return a.key.localeCompare(b.key);
    });

    return entries[0].key;
  }

  /** Resolve a model name — for CLI tools, map to the CLI model flag. */
  private resolveModelName(tool: AgentToolProvider, model: string): string {
    return model;
  }
}
