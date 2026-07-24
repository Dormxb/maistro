/**
 * P5.4 TaskClassifier
 *
 * Classifies a user task goal into a workflow, using a lightweight pi model
 * (deepseek-v4-flash by default). The result determines which roles run and
 * whether to request upgrade-tier models.
 *
 * Responsibilities (scoped per Fable 5 review):
 *   - Task decomposition and role dispatch → Classifier
 *   - Structural validation (schema, diff, tests) → Pipeline TypeScript logic
 *   - Qualitative evaluation (depth, security, edge cases) → Challenger role
 *   - Final decision → Human
 */

import type { ClassifierResult, WorkflowKind } from "./types.ts";

// ── Heuristic pre-filter (0 token, 0 latency) ────────────────────────

interface HeuristicHint {
  workflow: WorkflowKind;
  confidence: "low" | "medium" | "high";
}

function heuristicClassify(goal: string): HeuristicHint | null {
  const lower = goal.toLowerCase();

  // Trivial: single file, simple action verbs, no structural change.
  const trivialPatterns = [
    /fix\s+(a\s+)?typo/i,
    /fix\s+spelling/i,
    /add\s+(a\s+)?comment/i,
    /rename\s+\w+\s+to\s+\w+/i,
    /format\s+code/i,
    /remove\s+dead\s+code/i,
    /update\s+readme/i,
    /bump\s+version/i,
  ];
  if (trivialPatterns.some((p) => p.test(lower)) && goal.length < 200) {
    return { workflow: "executor_only", confidence: "high" };
  }

  // Review: explicitly asking for review of existing code/diff.
  const reviewPatterns = [
    /review\s+(this|the|my|a)\s+(pr|pull|diff|change|code)/i,
    /code\s+review/i,
    /audit\s+(this|the|my)\s+(code|file)/i,
    /security\s+review/i,
    /find\s+(bugs|issues|vulnerabilities)\s+in/i,
  ];
  if (reviewPatterns.some((p) => p.test(lower))) {
    return { workflow: "challenger_review", confidence: "high" };
  }

  // Complex: architectural keywords, multi-system, design-heavy.
  const complexIndicators = [
    "architecture", "design", "system", "refactor", "migrate",
    "authentication", "authorization", "database schema", "api design",
    "distributed", "scaling", "performance overhaul", "security model",
    "from scratch", "greenfield", "new system", "new service",
  ];
  const complexCount = complexIndicators.filter((k) => lower.includes(k)).length;
  if (complexCount >= 2 || goal.length > 2000) {
    return { workflow: "full_pipeline", confidence: "medium" };
  }

  // Simple: multi-file but well-defined, CRUD, config changes.
  const simpleIndicators = [
    "add endpoint", "add api", "crud", "create component",
    "add field", "add column", "add route", "update config",
    "add test", "fix bug", "fix edge case", "handle error",
  ];
  if (simpleIndicators.some((k) => lower.includes(k))) {
    return { workflow: "architect_executor", confidence: "medium" };
  }

  return null; // ambiguous — needs LLM classification
}

// ── LLM classifier (only called when heuristics are ambiguous) ────────

async function llmClassify(
  goal: string,
  modelProvider: string,
  modelId: string,
): Promise<ClassifierResult> {
  // Import pi entry dynamically.
  const piEntry = (await import("./builtin/pi-session.ts")).getPiEntry();
  const mod = await import(piEntry);
  const runtime = await mod.ModelRuntime.create();

  const piModel =
    runtime.getModel?.(modelProvider, modelId) ||
    runtime.getModel?.(modelProvider.toLowerCase(), modelId);

  if (!piModel) {
    // Fallback to heuristic default if model unavailable.
    return { workflow: "architect_executor", reasoning: "classifier model unavailable", modelStrategy: "baseline" };
  }

  const { homedir } = await import("node:os");
  const { join } = await import("node:path");

  const loader = new mod.DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: join(homedir(), ".pi", "agent"),
    noExtensions: true,
    systemPromptOverride: () =>
      [
        "Classify the following coding task into one workflow.",
        "Output ONLY a JSON object with:",
        '  "workflow": "executor_only" | "architect_executor" | "full_pipeline" | "challenger_review"',
        '  "reasoning": one-sentence explanation',
        "",
        "Rules:",
        "- executor_only: single trivial file change, typo, comment, rename, format",
        "- architect_executor: multi-file feature, CRUD, config changes, well-defined scope",
        "- full_pipeline: architecture, design, system-level, refactor, auth, db schema, new service",
        "- challenger_review: reviewing existing code, finding bugs, security audit",
        "",
        "Output only the JSON. No markdown. No extra text.",
      ].join("\n"),
  });
  await loader.reload();

  const { session } = await mod.createAgentSession({
    cwd: process.cwd(),
    agentDir: join(homedir(), ".pi", "agent"),
    tools: [],
    excludeTools: ["bash", "write", "edit", "read", "grep", "find", "ls"],
    resourceLoader: loader,
    sessionManager: mod.SessionManager.inMemory(process.cwd()),
    model: piModel,
  });

  let text = "";

  const unsub = session.subscribe?.((ev: any) => {
    if (ev?.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
      text += ev.assistantMessageEvent.delta || "";
    }
  });

  try {
    await session.prompt(`Task: ${goal}`);
  } finally {
    try { unsub?.(); } catch { /* ignore */ }
    try { session.dispose?.(); } catch { /* ignore */ }
  }

  // Parse JSON from response.
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        workflow: parsed.workflow || "architect_executor",
        reasoning: parsed.reasoning || "llm classified",
        modelStrategy: parsed.workflow === "full_pipeline" || parsed.workflow === "challenger_review"
          ? "upgrade"
          : "baseline",
      };
    }
  } catch {
    /* fall through to default */
  }

  return { workflow: "architect_executor", reasoning: "failed to parse classifier output", modelStrategy: "baseline" };
}

// ── TaskClassifier ────────────────────────────────────────────────────

export interface ClassifierConfig {
  provider: string;
  model: string;
}

const DEFAULT_CLASSIFIER: ClassifierConfig = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
};

export class TaskClassifier {
  private config: ClassifierConfig;

  constructor(config?: Partial<ClassifierConfig>) {
    this.config = { ...DEFAULT_CLASSIFIER, ...config };
  }

  /**
   * Classify a task goal. Heuristics first (0 token), LLM as fallback.
   * Returns the workflow and model strategy recommendation.
   */
  async classify(goal: string): Promise<ClassifierResult> {
    // 1. Try heuristics.
    const hint = heuristicClassify(goal);
    if (hint && hint.confidence === "high") {
      return {
        workflow: hint.workflow,
        reasoning: `heuristic: ${hint.workflow} (${hint.confidence} confidence)`,
        modelStrategy:
          hint.workflow === "full_pipeline" || hint.workflow === "challenger_review"
            ? "upgrade"
            : "baseline",
      };
    }

    // 2. LLM classification.
    return llmClassify(goal, this.config.provider, this.config.model);
  }
}
