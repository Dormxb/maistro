export interface TaskContract {
  taskId: string;
  userGoal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  nonGoals: string[];
  requiredChecks: string[];
  baseCommit: string;
  createdAt: string;
}

export function buildContract(input: {
  taskId: string;
  userGoal: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  nonGoals?: string[];
  requiredChecks?: string[];
  baseCommit: string;
}): TaskContract {
  const acceptanceCriteria = (input.acceptanceCriteria || []).map((s) => s.trim()).filter(Boolean);
  const requiredChecks = (input.requiredChecks || []).map((s) => s.trim()).filter(Boolean);
  if (!input.userGoal?.trim()) throw new Error("TaskContract.userGoal required");
  if (acceptanceCriteria.length < 1) {
    throw new Error("TaskContract.acceptanceCriteria requires at least 1 item");
  }
  if (requiredChecks.length < 1) {
    throw new Error("TaskContract.requiredChecks requires at least 1 item (Codex will run these)");
  }
  return {
    taskId: input.taskId,
    userGoal: input.userGoal.trim(),
    acceptanceCriteria,
    constraints: (input.constraints || []).map((s) => s.trim()).filter(Boolean),
    nonGoals: (input.nonGoals || []).map((s) => s.trim()).filter(Boolean),
    requiredChecks,
    baseCommit: input.baseCommit,
    createdAt: new Date().toISOString(),
  };
}

export function renderContractForPrompt(c: TaskContract): string {
  return [
    "=== TASK CONTRACT (authoritative, do not violate) ===",
    `taskId: ${c.taskId}`,
    `goal: ${c.userGoal}`,
    "acceptanceCriteria:",
    ...c.acceptanceCriteria.map((x) => `  - ${x}`),
    "constraints:",
    ...(c.constraints.length ? c.constraints.map((x) => `  - ${x}`) : ["  - (none)"]),
    "nonGoals:",
    ...(c.nonGoals.length ? c.nonGoals.map((x) => `  - ${x}`) : ["  - (none)"]),
    "requiredChecks (executed by Codex, NOT by you):",
    ...c.requiredChecks.map((x) => `  - ${x}`),
    `baseCommit: ${c.baseCommit}`,
    "=== END CONTRACT ===",
  ].join("\n");
}
