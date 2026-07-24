/**
 * P5 AgentToolRegistry
 *
 * Manages all AgentToolProvider instances: registration, disk-persisted
 * state cache, lazy TTL re-probe, execute-error feedback, flapping
 * prevention, change notification, and atomic state-file writes.
 *
 * Key design constraint: Maistro is a short-lived CLI process.
 * We do NOT rely on setInterval for periodic probing. Instead:
 *  - State is persisted to disk between runs.
 *  - On access, expired non-healthy tools are lazily re-probed.
 *  - Healthy tools are only re-evaluated via execute() error feedback.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  AgentToolProvider,
  AgentToolState,
  AgentToolStatus,
  ErrorCategory,
  ModelState,
  ProbeResult,
} from "./types.ts";

// ── Types ────────────────────────────────────────────────────────────

interface StateFile {
  tools: Record<string, AgentToolState>;
  updatedAt: string;
}

type StatusChangeListener = (
  toolId: string,
  prevStatus: AgentToolStatus,
  nextStatus: AgentToolStatus,
) => void;

// ── TTL map ──────────────────────────────────────────────────────────

const TTL_MS: Record<AgentToolStatus, number> = {
  healthy: 15 * 60_000,          // 15 min (startup restore only)
  degraded: 5 * 60_000,          // 5 min
  rate_limited: 60_000,          // minimum 1 min, overridden by retryAfter
  quota_exhausted: 60 * 60_000,  // 1 hour
  unavailable: 5 * 60_000,       // 5 min
  unknown: 0,                    // immediate
};

// ── Registry ─────────────────────────────────────────────────────────

export class AgentToolRegistry {
  private tools = new Map<string, AgentToolProvider>();
  private statePath: string;
  private listeners = new Set<StatusChangeListener>();
  private consecutiveFailures = new Map<string, number>();
  private static FLAP_THRESHOLD = 2;
  private probeInFlight = new Map<string, Promise<ProbeResult>>(); // single-flight
  private timers: Array<{ id: string; timer: NodeJS.Timeout }> = [];

  constructor(statePath?: string) {
    this.statePath = statePath ?? join(homedir(), ".maistro", "agent-tool-state.json");
  }

  // ── Registration ─────────────────────────────────────────────────

  register(tool: AgentToolProvider): void {
    this.tools.set(tool.id, tool);
  }

  getTool(id: string): AgentToolProvider | undefined {
    return this.tools.get(id);
  }

  getAll(): AgentToolProvider[] {
    return [...this.tools.values()];
  }

  /** Tools currently eligible for routing (not unavailable, quota_exhausted, or unknown). */
  getAvailable(opts?: { requireWrite?: boolean }): AgentToolProvider[] {
    const eligible: AgentToolStatus[] = ["healthy", "degraded", "rate_limited"];
    return this.getAll().filter((t) => {
      if (!eligible.includes(t.status)) return false;
      if (opts?.requireWrite && !t.capabilities.write) return false;
      return true;
    });
  }

  /** Enhancement tools that are healthy. */
  getHealthyEnhancements(): AgentToolProvider[] {
    return this.getAll().filter(
      (t) => t.class === "enhancement" && t.status === "healthy",
    );
  }

  // ── Listeners ────────────────────────────────────────────────────

  onChange(fn: StatusChangeListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notifyListeners(toolId: string, prev: AgentToolStatus, next: AgentToolStatus): void {
    if (prev === next) return;
    for (const fn of this.listeners) {
      try { fn(toolId, prev, next); } catch { /* best-effort */ }
    }
  }

  // ── Init ─────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const cached = this.loadState();

    for (const tool of this.tools.values()) {
      const cachedTool = cached?.tools[tool.id];

      if (tool.class === "core") {
        // Core: must probe now unless cache is fresh.
        if (cachedTool && !this.isExpiredStatic(cachedTool)) {
          this.restoreFromCache(tool, cachedTool);
        } else {
          await this.probeWithFlapping(tool);
        }
        this.checkCoreFatal(tool);
      } else {
        // Enhancement: restore from cache if fresh; defer probe if expired.
        if (cachedTool && !this.isExpiredStatic(cachedTool)) {
          this.restoreFromCache(tool, cachedTool);
        } else if (cachedTool) {
          // Expired — reset stale unavailable to unknown so lazy probe can re-evaluate.
          // Prevents "unavailable" from becoming a permanent dead state.
          this.restoreFromCache(tool, cachedTool);
          if (cachedTool.status === "unavailable") {
            tool.status = "unknown";
            tool.statusMessage = undefined;
          }
        }
        // No cache at all → stay "unknown", first access will trigger probe.
      }
    }

    this.persistState();
    this.startOptionalTimers();
  }

  /** Check core fatal condition: no write-capable healthy model. */
  private checkCoreFatal(tool: AgentToolProvider): void {
    if (!tool.capabilities.write) return; // only relevant for write-capable core tools

    const hasWriteModel = tool.modelStates
      ? [...tool.modelStates.values()].some(
          (ms) => ms.status === "healthy" || ms.status === "degraded",
        )
      : tool.status === "healthy" || tool.status === "degraded";

    if (!hasWriteModel) {
      throw new Error(
        `FATAL: core tool "${tool.id}" has no healthy write-capable model. Maistro cannot function.`,
      );
    }
  }

  // ── Lazy access ──────────────────────────────────────────────────

  /**
   * Get a tool, lazily re-probing if its non-healthy state has expired.
   * Healthy tools are NOT lazily re-probed — they rely on execute() error feedback.
   */
  async getToolLazy(id: string): Promise<AgentToolProvider | undefined> {
    const tool = this.tools.get(id);
    if (!tool) return undefined;

    if (tool.status !== "healthy" && this.isExpiredRuntime(tool)) {
      await this.probeWithFlapping(tool);
      this.persistState();
    }

    return tool;
  }

  // ── Execute error feedback ───────────────────────────────────────

  /**
   * Called by AgentPool when execute() fails with a recognised ErrorCategory.
   * This is the PRIMARY mechanism for healthy→non-healthy transitions.
   */
  reportExecuteError(
    toolId: string,
    errorCategory: ErrorCategory,
    message?: string,
    retryAfter?: Date,
  ): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;

    const newStatus = this.mapErrorToStatus(errorCategory);
    if (!newStatus || newStatus === tool.status) return;

    const prev = tool.status;
    tool.status = newStatus;
    tool.statusSince = new Date();
    tool.statusMessage = this.sanitizeMessage(message);
    tool.retryAfter = retryAfter ?? this.parseRetryAfter(message);

    // Also update per-model state for core tools
    if (tool.modelStates) {
      for (const ms of tool.modelStates.values()) {
        if (ms.status === "healthy") {
          ms.status = newStatus;
          ms.statusSince = new Date().toISOString();
          ms.statusMessage = this.sanitizeMessage(message);
          if (retryAfter) ms.retryAfter = retryAfter.toISOString();
        }
      }
    }

    this.consecutiveFailures.delete(toolId);
    this.persistState();
    this.notifyListeners(toolId, prev, newStatus);
  }

  private mapErrorToStatus(cat: ErrorCategory): AgentToolStatus | null {
    switch (cat) {
      case "rate_limit": return "rate_limited";
      case "quota":      return "quota_exhausted";
      case "auth":       return "unavailable";
      case "network":
      case "timeout":
      case "other":      return "degraded";
      default:           return null;
    }
  }

  // ── Probe with flapping prevention ───────────────────────────────

  private async probeWithFlapping(tool: AgentToolProvider): Promise<void> {
    // Single-flight: deduplicate concurrent probes for the same tool.
    const inflight = this.probeInFlight.get(tool.id);
    if (inflight) {
      await inflight;
      return;
    }

    const promise = this.doProbe(tool);
    this.probeInFlight.set(tool.id, promise);
    try {
      await promise;
    } finally {
      this.probeInFlight.delete(tool.id);
    }
  }

  private async doProbe(tool: AgentToolProvider): Promise<void> {
    const prev = tool.status;
    let result: ProbeResult;

    try {
      result = await tool.probe();
    } catch (e) {
      // Probe threw — treat as degraded
      result = {
        status: "degraded",
        message: `probe threw: ${String(e)}`,
        errorCategory: "other",
      };
    }

    // Flapping prevention: healthy → non-healthy requires consecutive failures.
    if (prev === "healthy" && result.status !== "healthy") {
      const fails = (this.consecutiveFailures.get(tool.id) || 0) + 1;
      this.consecutiveFailures.set(tool.id, fails);
      if (fails < AgentToolRegistry.FLAP_THRESHOLD) {
        // Don't flip yet — keep healthy, wait for next probe.
        return;
      }
    }

    // Reset failure counter on healthy result or confirmed transition.
    if (result.status === "healthy") {
      this.consecutiveFailures.set(tool.id, 0);
    }

    // Apply result.
    tool.status = result.status;
    tool.statusSince = new Date();
    tool.statusMessage = this.sanitizeMessage(result.message);
    tool.lastProbeAt = new Date();
    if (result.retryAfter) {
      tool.retryAfter = result.retryAfter;
    }

    // Apply per-model states for core tools.
    if (tool.modelStates && result.modelStates) {
      for (const [key, ms] of Object.entries(result.modelStates)) {
        tool.modelStates.set(key, {
          status: ms.status,
          statusSince: ms.statusSince || new Date().toISOString(),
          statusMessage: this.sanitizeMessage(ms.statusMessage),
          retryAfter: ms.retryAfter,
        });
      }
    }

    this.notifyListeners(tool.id, prev, result.status);
  }

  // ── State persistence ────────────────────────────────────────────

  private loadState(): StateFile | null {
    try {
      if (!existsSync(this.statePath)) return null;
      const raw = readFileSync(this.statePath, "utf8");
      return JSON.parse(raw) as StateFile;
    } catch {
      return null;
    }
  }

  private persistState(): void {
    const tools: Record<string, AgentToolState> = {};
    for (const tool of this.tools.values()) {
      const state: AgentToolState = {
        id: tool.id,
        class: tool.class,
        provider: tool.provider,
        label: tool.label,
        capabilities: { ...tool.capabilities },
        models: [...tool.models],
        status: tool.status,
        statusMessage: tool.statusMessage,
        statusSince: tool.statusSince.toISOString(),
        retryAfter: tool.retryAfter?.toISOString(),
        lastProbeAt: tool.lastProbeAt?.toISOString(),
        probeTTL: this.getTTL(tool),
        consecutiveFailures: this.consecutiveFailures.get(tool.id) ?? 0,
      };

      // Serialise per-model states for core tools.
      if (tool.modelStates && tool.modelStates.size > 0) {
        const ms: Record<string, ModelState> = {};
        for (const [key, val] of tool.modelStates) {
          ms[key] = { ...val };
        }
        state.modelStates = ms;
      }

      tools[tool.id] = state;
    }

    const payload: StateFile = {
      tools,
      updatedAt: new Date().toISOString(),
    };

    // Atomic write: temp file → rename.
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmp = this.statePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, this.statePath);
  }

  // ── Cache helpers ────────────────────────────────────────────────

  private restoreFromCache(tool: AgentToolProvider, cached: AgentToolState): void {
    tool.status = cached.status;
    tool.statusMessage = cached.statusMessage;
    tool.statusSince = new Date(cached.statusSince);
    tool.retryAfter = cached.retryAfter ? new Date(cached.retryAfter) : undefined;
    tool.lastProbeAt = cached.lastProbeAt ? new Date(cached.lastProbeAt) : undefined;
    this.consecutiveFailures.set(tool.id, cached.consecutiveFailures ?? 0);

    if (cached.modelStates && tool.modelStates) {
      for (const [key, ms] of Object.entries(cached.modelStates)) {
        tool.modelStates.set(key, {
          status: ms.status,
          statusSince: ms.statusSince,
          statusMessage: ms.statusMessage,
          retryAfter: ms.retryAfter,
        });
      }
    }
  }

  private isExpiredStatic(cached: AgentToolState): boolean {
    if (!cached.lastProbeAt) return true;
    const ttl = cached.probeTTL ?? TTL_MS[cached.status] ?? 5 * 60_000;
    return Date.now() - new Date(cached.lastProbeAt).getTime() > ttl;
  }

  private isExpiredRuntime(tool: AgentToolProvider): boolean {
    if (!tool.lastProbeAt) return true;
    const ttl = this.getTTL(tool);
    // rate_limited with retryAfter overrides static TTL
    if (tool.status === "rate_limited" && tool.retryAfter) {
      const minWait = tool.retryAfter.getTime() - Date.now() + 60_000;
      return Date.now() - tool.lastProbeAt.getTime() > Math.max(60_000, minWait);
    }
    if (tool.status === "quota_exhausted" && tool.retryAfter) {
      return Date.now() > tool.retryAfter.getTime();
    }
    return Date.now() - tool.lastProbeAt.getTime() > ttl;
  }

  private getTTL(tool: AgentToolProvider): number {
    return TTL_MS[tool.status] ?? 5 * 60_000;
  }

  // ── Optional timers (long sessions only) ─────────────────────────

  private startOptionalTimers(): void {
    // Only for healthy enhancement tools in long sessions.
    // All timers use unref() so they don't block process exit.
    for (const tool of this.tools.values()) {
      if (tool.class !== "enhancement") continue;
      if (tool.status !== "healthy") continue;

      const timer = setInterval(() => {
        // Check if tool state is still fresh; if expired, re-probe.
        if (this.isExpiredRuntime(tool)) {
          this.probeWithFlapping(tool).then(() => this.persistState());
        }
      }, 15 * 60_000);

      timer.unref();
      this.timers.push({ id: tool.id, timer });
    }
  }

  dispose(): void {
    for (const { timer } of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    this.listeners.clear();
    this.probeInFlight.clear();
  }

  // ── Error parsing helpers ────────────────────────────────────────

  /** Parse retry-after hint from error messages. */
  private parseRetryAfter(message?: string): Date | undefined {
    if (!message) return undefined;

    // Try ISO 8601 or common formats
    const isoMatch = message.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/);
    if (isoMatch) {
      const d = new Date(isoMatch[1]);
      if (!isNaN(d.getTime())) return d;
    }

    // "resets at ...", "try again in X minutes/hours"
    const minMatch = message.match(/try again in (\d+)\s*min/i);
    if (minMatch) return new Date(Date.now() + parseInt(minMatch[1]) * 60_000);

    const hourMatch = message.match(/try again in (\d+)\s*hour/i);
    if (hourMatch) return new Date(Date.now() + parseInt(hourMatch[1]) * 3_600_000);

    // Weekly limit: conservative default 6h
    if (/weekly|quota|exceeded/i.test(message)) {
      return new Date(Date.now() + 6 * 3_600_000);
    }

    // Rate limit: conservative default 5min
    if (/rate limit|429/i.test(message)) {
      return new Date(Date.now() + 5 * 60_000);
    }

    return undefined;
  }

  /** Sanitize status messages — strip paths and potential credential fragments. */
  private sanitizeMessage(message?: string): string | undefined {
    if (!message) return undefined;
    // Truncate long messages
    let sanitized = message.length > 500 ? message.slice(0, 497) + "..." : message;
    // Redact common path patterns
    sanitized = sanitized.replace(/[A-Z]:\\[^\s]{3,}/gi, "[path]");
    sanitized = sanitized.replace(/\/home\/[^\s]{3,}/gi, "[path]");
    sanitized = sanitized.replace(/\/Users\/[^\s]{3,}/gi, "[path]");
    return sanitized;
  }
}

/**
 * Helper: derive overall tool status from per-model states.
 * Used by core tools after probe.
 */
export function deriveCoreStatus(modelStates: Map<string, ModelState>): {
  status: AgentToolStatus;
  message?: string;
} {
  const statuses = [...modelStates.values()].map((ms) => ms.status);

  if (statuses.length === 0) return { status: "unavailable", message: "no models configured" };

  const hasHealthy = statuses.some((s) => s === "healthy");
  const hasDegraded = statuses.some((s) => s === "degraded");
  const hasRateLimited = statuses.some((s) => s === "rate_limited");
  const allUnavailable = statuses.every((s) => s === "unavailable");

  if (hasHealthy) return { status: "healthy" };
  if (allUnavailable) return { status: "unavailable", message: "all models unavailable" };
  if (hasDegraded) return { status: "degraded" };
  if (hasRateLimited) return { status: "rate_limited" };

  return { status: "unknown" };
}
