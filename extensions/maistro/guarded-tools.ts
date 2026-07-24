/**
 * P1 fix CRITICAL-1: wrap pi builtin tool definitions with Maistro path guards.
 * Live agent sessions must use these customTools + excludeTools builtins.
 */
import type { SecurityConfig } from "./types.ts";
import {
  assertReadable,
  assertWritable,
  assertWriteSize,
  guardToolArgs,
} from "./path-guard.ts";

type AnyDef = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: any,
    ctx?: any,
  ) => Promise<any>;
  [k: string]: unknown;
};

export interface GuardContext {
  root: string;
  security: SecurityConfig;
  canWrite: boolean;
}

function wrapExecute(def: AnyDef, g: GuardContext, toolName: string): AnyDef {
  const inner = def.execute.bind(def);
  return {
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (toolName === "bash") {
        throw new Error("BLOCKED_BY_POLICY: bash/command execution is disabled in Maistro");
      }
      const guarded = guardToolArgs(
        toolName,
        (params || {}) as Record<string, unknown>,
        g.security,
        g.root,
        g.canWrite,
      );
      // path fields may have been normalized to absolute; keep them
      return inner(toolCallId, guarded, signal, onUpdate, ctx);
    },
  };
}

/**
 * Build guarded custom tool definitions for a role session.
 * Uses pi's create*ToolDefinition factories when available.
 */
export async function buildGuardedCustomTools(
  mod: any,
  cwd: string,
  g: GuardContext,
  allowedToolNames: string[],
): Promise<AnyDef[]> {
  const names = new Set(allowedToolNames.filter((t) => t !== "bash"));
  const out: AnyDef[] = [];

  const add = (name: string, factory: string) => {
    if (!names.has(name)) return;
    if (typeof mod[factory] !== "function") {
      // fallback: try definition factory names
      const alt = factory.replace("Tool", "ToolDefinition");
      if (typeof mod[alt] === "function") {
        const def = mod[alt](cwd) as AnyDef;
        out.push(wrapExecute(def, g, name));
        return;
      }
      throw new Error(`pi SDK missing ${factory}`);
    }
    // createReadTool returns AgentTool; createReadToolDefinition returns ToolDefinition
    const defFactory = factory.endsWith("Definition")
      ? factory
      : factory.replace(/Tool$/, "ToolDefinition");
    if (typeof mod[defFactory] === "function") {
      const def = mod[defFactory](cwd) as AnyDef;
      out.push(wrapExecute(def, g, name));
      return;
    }
    // Last resort: wrap AgentTool-like object into ToolDefinition shape
    const tool = mod[factory](cwd);
    out.push(
      wrapExecute(
        {
          name: tool.name || name,
          label: tool.label || name,
          description: tool.description || name,
          parameters: tool.parameters,
          execute: tool.execute.bind(tool),
        },
        g,
        name,
      ),
    );
  };

  add("read", "createReadToolDefinition");
  add("write", "createWriteToolDefinition");
  add("edit", "createEditToolDefinition");
  add("grep", "createGrepToolDefinition");
  add("find", "createFindToolDefinition");
  add("ls", "createLsToolDefinition");

  // Never include bash
  return out;
}

/** Builtin names we always exclude so only guarded custom tools remain. */
export const ALL_BUILTIN_FILE_TOOLS = [
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "bash",
] as const;

export function validateGuardedCall(
  toolName: string,
  params: Record<string, unknown>,
  g: GuardContext,
): void {
  if (toolName === "bash") {
    throw new Error("BLOCKED_BY_POLICY: bash disabled");
  }
  guardToolArgs(toolName, params, g.security, g.root, g.canWrite);
  // Extra explicit checks for e2e probes
  if (toolName === "read" && typeof params.path === "string") {
    assertReadable(params.path as string, g.security, g.root);
  }
  if ((toolName === "write" || toolName === "edit") && typeof params.path === "string") {
    if (!g.canWrite) throw new Error("BLOCKED_BY_POLICY: write not allowed");
    assertWritable(params.path as string, g.security, g.root);
    if (toolName === "write" && typeof params.content === "string") {
      assertWriteSize(Buffer.byteLength(params.content as string, "utf8"), g.security);
    }
  }
}
