import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MaistroConfig } from "./types.ts";

const DEFAULT_CONFIG: MaistroConfig = {
  version: "8.1",
  orchestrator: { provider: "anthropic", model: "claude-fable-5" },
  agents: {
    architect: {
      provider: "anthropic",
      model: "claude-fable-5",
      tools: ["read", "grep", "find", "ls"],
    },
    executor: {
      provider: "xai",
      model: "grok-4.5",
      tools: ["read", "grep", "find", "ls", "write", "edit"],
    },
    challenger: {
      provider: "openai",
      model: "gpt-5.6-sol",
      tools: ["read", "grep", "find", "ls"],
    },
  },
  verification: {
    authority: "codex",
    maistroStaticChecks: ["policy", "diff", "syntax"],
    requiredChecksMin: 1,
    hostProjectTestExecution: false,
  },
  modes: {
    classifier: { enabled: true },
    review: { enabled: true },
    pipeline: { enabled: false, confirmBeforeRun: true },
    debate: { enabled: false, confirmBeforeRun: true },
  },
  cost: {
    monthlyBudget: 50,
    hardCap: true,
    perTaskLimit: 15,
    ledgerPath: "~/.pi/agent/maistro/ledger.jsonl",
  },
  security: {
    deniedPaths: [
      "**/.env",
      "**/.env.*",
      "**/*.key",
      "**/*.pem",
      "**/credentials/**",
      "**/secrets/**",
      "~/.ssh/**",
      "~/.aws/**",
    ],
    maxFileWriteBytes: 102400,
  },
};

function stripJsonc(text: string): string {
  // remove // line comments and /* */ blocks naively for our controlled config
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([\]}])/g, "$1");
}

export function expandTilde(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export function loadConfig(cwd = process.cwd()): MaistroConfig {
  const path = resolve(cwd, ".maistro.jsonc");
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(stripJsonc(raw)) as Partial<MaistroConfig>;
  const cfg: MaistroConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    ...parsed,
    agents: { ...DEFAULT_CONFIG.agents, ...(parsed.agents || {}) },
    verification: { ...DEFAULT_CONFIG.verification, ...(parsed.verification || {}) },
    modes: { ...DEFAULT_CONFIG.modes, ...(parsed.modes || {}) },
    cost: { ...DEFAULT_CONFIG.cost, ...(parsed.cost || {}) },
    security: { ...DEFAULT_CONFIG.security, ...(parsed.security || {}) },
    orchestrator: { ...DEFAULT_CONFIG.orchestrator, ...(parsed.orchestrator || {}) },
  };
  // P1 invariant: executor never has bash
  for (const [name, agent] of Object.entries(cfg.agents)) {
    agent.tools = agent.tools.filter((t) => t !== "bash");
    if (name === "executor" && agent.tools.includes("bash" as never)) {
      throw new Error("invalid config: executor cannot have bash");
    }
  }
  if (cfg.verification.hostProjectTestExecution) {
    throw new Error("invalid config: hostProjectTestExecution must be false in P1/v8.1");
  }
  cfg.cost.ledgerPath = expandTilde(cfg.cost.ledgerPath);
  return cfg;
}

export function getProjectRoot(cwd = process.cwd()): string {
  return resolve(cwd);
}
