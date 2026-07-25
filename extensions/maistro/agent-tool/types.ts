/**
 * P5 AgentTool — Core Types
 * 
 * ProviderClass, AgentToolStatus, ErrorCategory, and the AgentToolProvider interface
 * that all built-in (and future) agent tools must implement.
 */

// ── Provider classification ──────────────────────────────────────────

/**
 * core:     Must be available for Maistro to function.
 *           Fatal condition = no write-capable healthy model.
 *           PiSessionTool is the only core provider in v1.
 *
 * enhancement: Optional. Unavailable → automatic fallback to baseline
 *              with downgrade annotation in output.
 */
export type ProviderClass = "core" | "enhancement";

// ── Six-state health model ───────────────────────────────────────────

export type AgentToolStatus =
  | "healthy"          // Fully operational
  | "degraded"         // Available but slow/limited; lower routing priority
  | "rate_limited"     // Temporary (429 etc.), retry after retryAfter
  | "quota_exhausted"  // Weekly/monthly quota spent; periodic re-probe
  | "unavailable"      // Binary missing, config error, or auth failure
  | "unknown";         // Not yet probed (valid initial state for enhancement)

// ── Error classification (for execute → registry feedback loop) ─────

export type ErrorCategory =
  | "rate_limit"       // → rate_limited
  | "quota"            // → quota_exhausted
  | "auth"             // → unavailable
  | "network"          // → degraded (transient)
  | "timeout"          // → degraded
  | "other";           // → degraded

// ── Per-model state (for core tools like PiSession) ──────────────────

export interface ModelState {
  status: AgentToolStatus;
  statusSince: string;    // ISO timestamp
  statusMessage?: string;
  retryAfter?: string;    // ISO timestamp
}

// ── Serialisable state (persisted to disk) ───────────────────────────

export interface AgentToolState {
  id: string;
  class: ProviderClass;
  provider: string;
  label: string;
  capabilities: { read: boolean; write: boolean };
  models: string[];

  // Overall status. For core tools this is derived from modelStates.
  status: AgentToolStatus;
  statusMessage?: string;
  statusSince: string;
  retryAfter?: string;
  lastProbeAt?: string;
  probeTTL?: number;

  // Per-(provider/model) states for core tools.
  // Key format: "provider/model" (e.g. "xai/grok-4.5").
  modelStates?: Record<string, ModelState>;

  // Consecutive probe failure count for flapping prevention.
  consecutiveFailures?: number;
}

// ── Probe / Execute ──────────────────────────────────────────────────

export interface ProbeResult {
  status: AgentToolStatus;
  message?: string;
  retryAfter?: Date;
  errorCategory?: ErrorCategory;
  /** Per-model results for core tools. */
  modelStates?: Record<string, ModelState>;
}

export interface ExecuteOpts {
  role: string;
  prompt: string;
  systemPrompt?: string;
  model: string;
  cwd: string;
  writeSessionPath?: string;
  timeoutMs?: number;
  /** Thinking level from pi-model-roles integration. */
  thinking?: string;
}

export interface ExecuteResult {
  success: boolean;
  text?: string;
  model?: string;
  usage?: { input: number; output: number };
  error?: Error;
  errorCategory?: ErrorCategory;
}

// ── Downgrade reason (for observability) ─────────────────────────────

export interface DowngradeReason {
  from: string;     // tool id we wanted
  to: string;       // tool id or "baseline" we fell back to
  reason: string;   // human-readable
  retryAfter?: string;
}

// ── AgentToolProvider interface ──────────────────────────────────────

export interface AgentToolProvider {
  id: string;
  class: ProviderClass;
  provider: string;
  label: string;
  capabilities: { read: boolean; write: boolean };
  models: string[];

  // Current status (may be derived from modelStates for core tools)
  status: AgentToolStatus;
  statusMessage?: string;
  statusSince: Date;
  retryAfter?: Date;
  lastProbeAt?: Date;

  // Per-model states for core tools
  modelStates?: Map<string, ModelState>;

  /** Cheap health check — MUST NOT consume real LLM tokens. */
  probe(): Promise<ProbeResult>;

  /** Execute a prompt with the selected model. */
  execute(opts: ExecuteOpts): Promise<ExecuteResult>;
}

// ── Router types ─────────────────────────────────────────────────────

export type RoutingPool = "baseline" | "upgrade";

export interface RouteResult {
  tool: AgentToolProvider;
  model: string;
  pool: RoutingPool;
  downgraded?: DowngradeReason;
}

// ── Task Classifier types ────────────────────────────────────────────

export type WorkflowKind = "executor_only" | "architect_executor" | "full_pipeline" | "challenger_review";

export interface ClassifierResult {
  workflow: WorkflowKind;
  reasoning: string;
  modelStrategy: "baseline" | "upgrade";
}
