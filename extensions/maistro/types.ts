export type RoleName = "architect" | "executor" | "challenger" | "researcher" | "adjudicator";

export type ToolName =
  | "read"
  | "grep"
  | "find"
  | "ls"
  | "write"
  | "edit"
  | "bash";

export interface AgentProfile {
  provider: string;
  model: string;
  tools: ToolName[];
  thinking?: string;
  /** pi-model-roles role name for baseline model resolution. */
  modelRole?: string;
}

export interface CostConfig {
  monthlyBudget: number;
  hardCap: boolean;
  perTaskLimit: number;
  ledgerPath: string;
}

export interface SecurityConfig {
  deniedPaths: string[];
  maxFileWriteBytes: number;
}

export interface MaistroConfig {
  version: string;
  orchestrator: { provider: string; model: string };
  agents: Record<string, AgentProfile>;
  verification: {
    authority: string;
    maistroStaticChecks: string[];
    requiredChecksMin: number;
    hostProjectTestExecution: boolean;
  };
  modes: Record<string, { enabled: boolean; confirmBeforeRun?: boolean }>;
  cost: CostConfig;
  security: SecurityConfig;
}

export interface WriteSession {
  taskId: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  createdAt: string;
}

export interface LedgerEntry {
  ts: string;
  taskId: string;
  project: string;
  role: string;
  provider: string;
  model: string;
  inTok: number;
  outTok: number;
  cacheTok: number;
  costUsd: number;
  estimated: boolean;
  note?: string;
}
