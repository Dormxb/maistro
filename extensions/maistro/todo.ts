/**
 * P8.2 TODO — non-intrusive task tracking for Maistro agents.
 *
 * Inspired by AskHuman v0.10.0 Multi-line todos.
 * LLMs create/update/complete TODOs via tools. Displayed in TUI widget.
 * Never interrupts the user's conversation flow.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  createdAt: string;
  completedAt?: string;
}

export interface TodoList {
  taskId: string;
  items: TodoItem[];
  updatedAt: string;
}

// ── Storage ──────────────────────────────────────────────────────────

function todosDir(cwd: string): string {
  return join(cwd, ".system", "todos");
}

function todosPath(cwd: string, taskId: string): string {
  return join(todosDir(cwd), `${taskId}.json`);
}

function ensureDir(cwd: string): void {
  const dir = todosDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(cwd: string, taskId: string): TodoList {
  const path = todosPath(cwd, taskId);
  if (!existsSync(path)) {
    return { taskId, items: [], updatedAt: new Date().toISOString() };
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TodoList;
  } catch {
    return { taskId, items: [], updatedAt: new Date().toISOString() };
  }
}

function save(cwd: string, list: TodoList): void {
  ensureDir(cwd);
  list.updatedAt = new Date().toISOString();
  writeFileSync(todosPath(cwd, list.taskId), JSON.stringify(list, null, 2), "utf8");
}

// ── CRUD ─────────────────────────────────────────────────────────────

function nextId(items: TodoItem[]): string {
  const max = items.reduce((m, i) => Math.max(m, parseInt(i.id) || 0), 0);
  return String(max + 1);
}

export function addTodo(cwd: string, taskId: string, text: string): TodoItem {
  const list = load(cwd, taskId);
  const item: TodoItem = {
    id: nextId(list.items),
    text,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  list.items.push(item);
  save(cwd, list);
  return item;
}

export function updateTodo(
  cwd: string,
  taskId: string,
  id: string,
  status: TodoStatus,
): TodoItem | null {
  const list = load(cwd, taskId);
  const item = list.items.find((i) => i.id === id);
  if (!item) return null;
  item.status = status;
  if (status === "done" || status === "cancelled") {
    item.completedAt = new Date().toISOString();
  }
  save(cwd, list);
  return item;
}

export function listTodos(cwd: string, taskId: string): TodoList {
  return load(cwd, taskId);
}

export function allActiveTodos(cwd: string): TodoItem[] {
  ensureDir(cwd);
  const dir = todosDir(cwd);
  const active: TodoItem[] = [];
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const list = JSON.parse(readFileSync(join(dir, file), "utf8")) as TodoList;
        for (const item of list.items) {
          if (item.status === "pending" || item.status === "in_progress") {
            active.push(item);
          }
        }
      } catch { /* skip corrupt files */ }
    }
  } catch { /* dir may not exist */ }
  // Most recent first
  active.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return active;
}

// ── Rendering ────────────────────────────────────────────────────────

const STATUS_ICONS: Record<TodoStatus, string> = {
  pending: "⬜",
  in_progress: "🔄",
  done: "✅",
  cancelled: "❌",
};

export function renderWidget(cwd: string, maxItems: number = 10): string[] {
  const todos = allActiveTodos(cwd);
  if (todos.length === 0) return [];

  const lines: string[] = [`TODO (${todos.length} active)`];
  const show = todos.slice(0, maxItems);
  for (const item of show) {
    const icon = STATUS_ICONS[item.status];
    // Truncate long items
    const text = item.text.length > 60 ? item.text.slice(0, 57) + "..." : item.text;
    lines.push(` ${icon} ${text}`);
  }
  if (todos.length > maxItems) {
    lines.push(` ... +${todos.length - maxItems} more`);
  }
  return lines;
}
