import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type TaskState =
  | "created"
  | "architect_done"
  | "executor_done"
  | "static_failed"
  | "static_passed"
  | "codex_blocked"
  | "codex_failed"
  | "codex_passed"
  | "challenger_done"
  | "fixing"
  | "awaiting_manual_verify"
  | "completed"
  | "failed"
  | "cancelled";

export interface JournalEvent {
  ts: string;
  taskId: string;
  event: string;
  state: TaskState;
  detail?: Record<string, unknown>;
}

export interface TaskRecord {
  taskId: string;
  state: TaskState;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
  fixRound: number;
  handoffPath?: string;
  lastError?: string;
  mergeRecommended?: boolean;
  updatedAt: string;
}

function tasksDir(): string {
  const d = join(homedir(), ".pi", "agent", "maistro", "tasks");
  mkdirSync(d, { recursive: true });
  return d;
}

function journalPath(taskId: string): string {
  return join(tasksDir(), `${taskId}.jsonl`);
}

function metaPath(taskId: string): string {
  return join(tasksDir(), `${taskId}.meta.json`);
}

export function appendJournal(ev: JournalEvent): void {
  appendFileSync(journalPath(ev.taskId), JSON.stringify(ev) + "\n", "utf8");
}

export function readJournal(taskId: string): JournalEvent[] {
  const p = journalPath(taskId);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JournalEvent);
}

export function saveMeta(rec: TaskRecord): void {
  writeFileSync(metaPath(rec.taskId), JSON.stringify(rec, null, 2), "utf8");
  appendJournal({
    ts: new Date().toISOString(),
    taskId: rec.taskId,
    event: "state",
    state: rec.state,
    detail: {
      fixRound: rec.fixRound,
      mergeRecommended: rec.mergeRecommended,
      lastError: rec.lastError,
    },
  });
}

export function loadMeta(taskId: string): TaskRecord | null {
  const p = metaPath(taskId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as TaskRecord;
}

export function listTasks(): TaskRecord[] {
  const dir = tasksDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".meta.json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskRecord;
      } catch {
        return null;
      }
    })
    .filter((x): x is TaskRecord => !!x)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function isTerminal(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}
