import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryKind = "decision" | "pattern" | "failure" | "note";

export interface MemoryEntry {
  ts: string;
  kind: MemoryKind;
  taskId?: string;
  title: string;
  body: string;
  tags?: string[];
}

function memDir(projectRoot: string): string {
  const d = join(projectRoot, ".system", "memory");
  mkdirSync(d, { recursive: true });
  return d;
}

function fileFor(kind: MemoryKind, projectRoot: string): string {
  const map: Record<MemoryKind, string> = {
    decision: "decisions.md",
    pattern: "patterns.md",
    failure: "failures.md",
    note: "notes.md",
  };
  return join(memDir(projectRoot), map[kind]);
}

export function appendMemory(projectRoot: string, entry: MemoryEntry): string {
  const path = fileFor(entry.kind, projectRoot);
  if (!existsSync(path)) {
    writeFileSync(path, `# ${entry.kind}\n\n`, "utf8");
  }
  const block = [
    `## ${entry.title}`,
    "",
    `- ts: ${entry.ts}`,
    entry.taskId ? `- taskId: ${entry.taskId}` : null,
    entry.tags?.length ? `- tags: ${entry.tags.join(", ")}` : null,
    "",
    entry.body.trim(),
    "",
    "---",
    "",
  ]
    .filter((x) => x !== null)
    .join("\n");
  appendFileSync(path, block, "utf8");

  // machine index
  const idx = join(memDir(projectRoot), "index.jsonl");
  appendFileSync(idx, JSON.stringify(entry) + "\n", "utf8");
  return path;
}

export function listMemory(projectRoot: string, kind?: MemoryKind): MemoryEntry[] {
  const idx = join(memDir(projectRoot), "index.jsonl");
  if (!existsSync(idx)) return [];
  return readFileSync(idx, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as MemoryEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is MemoryEntry => !!x)
    .filter((e) => (kind ? e.kind === kind : true))
    .reverse();
}

export function searchMemory(projectRoot: string, query: string, limit = 10): MemoryEntry[] {
  const q = query.toLowerCase();
  return listMemory(projectRoot)
    .filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.body.toLowerCase().includes(q) ||
        e.tags?.some((t) => t.toLowerCase().includes(q)),
    )
    .slice(0, limit);
}

/** Promote debate/orchestrate outcome into a decision memory entry. */
export function rememberDecision(
  projectRoot: string,
  title: string,
  body: string,
  taskId?: string,
  tags?: string[],
): string {
  return appendMemory(projectRoot, {
    ts: new Date().toISOString(),
    kind: "decision",
    taskId,
    title,
    body,
    tags,
  });
}
