import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { initPlatform } from "./platform.ts";
import { initPiEntry } from "./agent-tool/builtin/pi-session.ts";
import { AgentPool } from "./agent-pool.ts";
import { loadConfig, getProjectRoot } from "./config.ts";
import { assertBudgetAllows, sumMonthUsd } from "./ledger.ts";
import {
  acquireWriteSession,
  disposeWriteSession,
  worktreeDiff,
  worktreeStatus,
} from "./worktree.ts";
import { assertReadable, isDeniedPath } from "./path-guard.ts";
import type { WriteSession } from "./types.ts";
import { continueAfterVerify, runTriadPipeline } from "./orchestrate.ts";
import { resolveCodexBin } from "./codex-handoff.ts";
import { submitManualVerification } from "./manual-verify.ts";
import { listTasks, loadMeta } from "./task-journal.ts";
import { disposeWriteSession as disposeWt } from "./worktree.ts";
import { runDebate } from "./debate.ts";
import { appendMemory, listMemory, searchMemory } from "./memory.ts";
import { buildStats, renderStatsText } from "./stats.ts";

const writeSessions = new Map<string, WriteSession>();

export default function (pi: ExtensionAPI) {
  // P7: Initialize platform detection and pi module path BEFORE anything else.
  initPlatform();
  initPiEntry(pi);

  const cwd = getProjectRoot(process.cwd());
  let config = loadConfig(cwd);
  let pool = new AgentPool({ cwd, config });

  function reload() {
    config = loadConfig(cwd);
    pool = new AgentPool({ cwd, config });
  }

  pi.registerCommand("maistro", {
    description:
      "Maistro: doctor | status | budget | tasks | stats | discard <id> | cancel <id>",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "status";

      if (sub === "stats") {
        reload();
        ctx.ui.notify(renderStatsText(buildStats(cwd, config)), "info");
        return;
      }

      if (sub === "tasks") {
        const rows = listTasks()
          .slice(0, 20)
          .map(
            (t) =>
              `${t.taskId}  ${t.state}  fix=${t.fixRound}  merge=${t.mergeRecommended ?? "-"}  ${t.updatedAt}`,
          );
        ctx.ui.notify(rows.length ? rows.join("\n") : "no tasks", "info");
        return;
      }

      if (sub === "cancel" && parts[1]) {
        const meta = loadMeta(parts[1]);
        if (!meta) {
          ctx.ui.notify(`unknown task ${parts[1]}`, "error");
          return;
        }
        if (meta.worktreePath) {
          try {
            disposeWt(
              cwd,
              {
                taskId: parts[1],
                worktreePath: meta.worktreePath,
                branch: meta.branch || `maistro/${parts[1]}`,
                baseCommit: meta.baseCommit || "HEAD",
                createdAt: meta.updatedAt,
              },
              "discard",
            );
          } catch {
            /* ignore */
          }
        }
        writeSessions.delete(parts[1]);
        const { saveMeta } = await import("./task-journal.ts");
        saveMeta({
          ...meta,
          state: "cancelled",
          updatedAt: new Date().toISOString(),
          lastError: "cancelled by user",
        });
        ctx.ui.notify(`cancelled ${parts[1]}`, "info");
        return;
      }

      if (sub === "doctor") {
        reload();
        const spent = sumMonthUsd(config.cost.ledgerPath);
        let binds: string[] = [];
        let toolStatus: string[] = [];

        // P5: AgentTool statuses. Probe FIRST so describeBindings sees updated states.
        try {
          if ((config as any).routing?.enabled) {
            const registry = await (pool as any).getRegistry();
            if (registry) {
              for (const tool of registry.getAll()) {
                // Trigger lazy probe for enhancement tools that are still unknown.
                if (tool.class === "enhancement" && tool.status === "unknown") {
                  try { await registry.getToolLazy(tool.id); } catch { /* ignore */ }
                }
                const statusIcon = tool.status === "healthy" ? "🟢" :
                  tool.status === "degraded" ? "🟡" :
                  tool.status === "rate_limited" ? "🔴" :
                  tool.status === "quota_exhausted" ? "⛔" :
                  tool.status === "unavailable" ? "⚫" : "❓";
                let modelsStr = "";
                if ((tool as any).modelStates && (tool as any).modelStates.size > 0) {
                  const healthy = [...(tool as any).modelStates.entries()]
                    .filter(([, v]: [string, any]) => v.status === "healthy");
                  const count = healthy.length;
                  if (count <= 8) {
                    modelsStr = healthy.map(([k]: [string]) => `    ${k}`).join("\n");
                  } else {
                    modelsStr = healthy.slice(0, 5).map(([k]: [string]) => `    ${k}`).join("\n")
                      + `\n    ... +${count - 5} more healthy`;
                  }
                } else {
                  modelsStr = `    ${tool.models.join(", ")}`;
                }
                toolStatus.push(`  ${statusIcon} ${tool.id} [${tool.class}] ${tool.status}${tool.statusMessage ? ` (${tool.statusMessage})` : ""}${modelsStr ? "\n" + modelsStr : ""}`);
              }
            }
          }
        } catch { /* ignore */ }

        // Now probe is done — get bindings with fresh statuses.
        try {
          const b = await pool.describeBindings();
          binds = b.map((x) => `  ${x.role}: ${x.provider}/${x.model} → ${x.kind}${x.note ? ` (${x.note})` : ""}`);
        } catch (e) {
          binds = [`  binding probe failed: ${String(e)}`];
        }

        const routingEnabled = (config as any).routing?.enabled ? "YES" : "no";
        const lines = [
          "Maistro doctor",
          `- cwd: ${cwd}`,
          `- config: .maistro.jsonc loaded (v${config.version})`,
          `- routing: ${routingEnabled}`,
          `- executor tools: ${config.agents.executor.tools.join(", ")}`,
          `- executor has bash: ${config.agents.executor.tools.includes("bash" as never) ? "YES(BAD)" : "no"}`,
          `- hostProjectTestExecution: ${config.verification.hostProjectTestExecution}`,
          `- monthly spent: $${spent.toFixed(4)} / $${config.cost.monthlyBudget} hardCap=${config.cost.hardCap}`,
          `- active write sessions: ${writeSessions.size}`,
          `- deniedPaths: ${config.security.deniedPaths.length} patterns`,
          `- codex: ${resolveCodexBin() || "NOT FOUND"}`,
          `- verification.authority: ${config.verification.authority}`,
          `- modes: classifier=${config.modes.classifier?.enabled ?? config.modes.router?.enabled} review=${config.modes.review?.enabled} pipeline=${config.modes.pipeline?.enabled} debate=${config.modes.debate?.enabled}`,
        ];
        if (toolStatus.length > 0) {
          lines.push("- agent tools:", ...toolStatus);
        }
        lines.push("- role bindings:", ...binds);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "budget") {
        const spent = sumMonthUsd(config.cost.ledgerPath);
        const gate = assertBudgetAllows(config.cost, 0);
        ctx.ui.notify(
          `budget spent=$${spent.toFixed(4)} remaining=$${gate.remaining.toFixed(4)} hardCap=${config.cost.hardCap}`,
          gate.remaining <= 0 ? "error" : "info",
        );
        return;
      }

      if (sub === "discard" && parts[1]) {
        const s = writeSessions.get(parts[1]);
        if (!s) {
          ctx.ui.notify(`unknown taskId ${parts[1]}`, "error");
          return;
        }
        disposeWriteSession(cwd, s, "discard");
        writeSessions.delete(parts[1]);
        ctx.ui.notify(`discarded write session ${parts[1]}`, "info");
        return;
      }

      // status
      const rows = [...writeSessions.entries()].map(([id, s]) => {
        return `${id}  ${s.branch}  ${s.worktreePath}`;
      });
      ctx.ui.notify(
        rows.length ? `write sessions:\n${rows.join("\n")}` : "no active write sessions",
        "info",
      );
    },
  });

  // Path policy probe tool
  pi.registerTool({
    name: "maistro_check_path",
    label: "Maistro Check Path",
    description: "Check whether a path is allowed for read under Maistro security policy",
    parameters: Type.Object({
      path: Type.String({ description: "Path to check" }),
    }),
    async execute(_id, params) {
      try {
        const norm = assertReadable(params.path, config.security, cwd);
        return {
          content: [{ type: "text", text: JSON.stringify({ allowed: true, path: norm }, null, 2) }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ allowed: false, error: String(e) }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  });

  // Acquire worktree write session
  pi.registerTool({
    name: "maistro_acquire_write_session",
    label: "Maistro Acquire Write Session",
    description: "Create an isolated git worktree write session for executor role (P1)",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id, used as worktree/branch suffix" }),
    }),
    async execute(_id, params) {
      const session = acquireWriteSession(cwd, params.taskId);
      writeSessions.set(params.taskId, session);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(session, null, 2),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "maistro_write_session_status",
    label: "Maistro Write Session Status",
    description: "Show git status/diff for a write session",
    parameters: Type.Object({
      taskId: Type.String(),
    }),
    async execute(_id, params) {
      const s = writeSessions.get(params.taskId);
      if (!s) {
        return {
          content: [{ type: "text", text: `unknown taskId ${params.taskId}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session: s,
                status: worktreeStatus(s),
                diffStat: worktreeDiff(s),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "maistro_discard_write_session",
    label: "Maistro Discard Write Session",
    description: "Force-remove a write session worktree and branch",
    parameters: Type.Object({
      taskId: Type.String(),
    }),
    async execute(_id, params) {
      const s = writeSessions.get(params.taskId);
      if (!s) {
        return {
          content: [{ type: "text", text: `unknown taskId ${params.taskId}` }],
          isError: true,
        };
      }
      disposeWriteSession(cwd, s, "discard");
      writeSessions.delete(params.taskId);
      return { content: [{ type: "text", text: `discarded ${params.taskId}` }] };
    },
  });

  // Guarded agent call — P1 core
  pi.registerTool({
    name: "maistro_agent_call",
    label: "Maistro Agent Call",
    description:
      "Call a Maistro role agent. Executor writes only inside an acquired write session. No shell/command tools.",
    parameters: Type.Object({
      role: Type.String({ description: "architect | executor | challenger" }),
      prompt: Type.String(),
      taskId: Type.String({ description: "Task id for ledger/worktree correlation" }),
      useWriteSession: Type.Optional(
        Type.Boolean({ description: "If true, executor uses acquired write session for taskId" }),
      ),
    }),
    async execute(_id, params) {
      reload();
      const role = params.role;
      const profile = config.agents[role];
      if (!profile) {
        return {
          content: [{ type: "text", text: `unknown role ${role}` }],
          isError: true,
        };
      }

      // Hard deny bash surface
      if (profile.tools.includes("bash" as never)) {
        return {
          content: [{ type: "text", text: "refusing role with bash tool" }],
          isError: true,
        };
      }

      let writeSession: WriteSession | undefined;
      const wantsWrite =
        params.useWriteSession || role === "executor" || profile.tools.includes("write");
      if (wantsWrite) {
        writeSession = writeSessions.get(params.taskId);
        if (!writeSession) {
          return {
            content: [
              {
                type: "text",
                text: `write session required: call maistro_acquire_write_session first (taskId=${params.taskId})`,
              },
            ],
            isError: true,
          };
        }
      }

      // Budget pre-check — conservative reserve (HIGH-2 alignment)
      const gate = assertBudgetAllows(config.cost, Math.min(config.cost.perTaskLimit, 0.5));
      if (!gate.allowed) {
        return {
          content: [{ type: "text", text: gate.reason || "budget blocked" }],
          isError: true,
        };
      }

      try {
        // Demonstrate guard path for a synthetic probe (ensures policy wiring)
        if (role !== "executor") {
          // readonly roles should not write
          try {
            pool.guardArgs(role, "write", { path: "x.txt", content: "nope" }, writeSession);
            return {
              content: [{ type: "text", text: "BUG: readonly role allowed write" }],
              isError: true,
            };
          } catch {
            // expected
          }
        }

        // Deny reading secrets even before model call (policy smoke)
        const secretHit = isDeniedPath(".env", config.security.deniedPaths, cwd);

        const result = await pool.call({
          role,
          prompt: params.prompt,
          taskId: params.taskId,
          writeSession,
          systemPrompt: [
            `You are Maistro role=${role}.`,
            `Provider/model target: ${profile.provider}/${profile.model}.`,
            `Allowed tools: ${profile.tools.join(", ")}.`,
            `Command execution is DISABLED. Never ask for bash.`,
            writeSession
              ? `You may only write inside worktree: ${writeSession.worktreePath}`
              : `You are read-only.`,
            secretHit ? `Secret paths are denied by policy.` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  role,
                  model: result.model,
                  costUsd: result.costUsd,
                  usage: result.usage,
                  worktreePath: result.worktreePath,
                  text: result.text,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `agent_call failed: ${String(e)}` }],
          isError: true,
        };
      }
    },
  });

  // P2: triad orchestration + Codex handoff
  pi.registerTool({
    name: "maistro_orchestrate",
    label: "Maistro Orchestrate",
    description:
      "Run P2 triad pipeline: Architect(Fable) → Executor(Grok) → static checks → Codex verify → Challenger(Sol). Does not auto-merge.",
    parameters: Type.Object({
      taskId: Type.String(),
      userGoal: Type.String(),
      acceptanceCriteria: Type.Array(Type.String()),
      requiredChecks: Type.Array(Type.String(), {
        description: "Checks Codex must run, e.g. npm test",
      }),
      constraints: Type.Optional(Type.Array(Type.String())),
      nonGoals: Type.Optional(Type.Array(Type.String())),
      runCodex: Type.Optional(Type.Boolean({ description: "Default true" })),
      runChallenger: Type.Optional(Type.Boolean({ description: "Default true" })),
      discardAtEnd: Type.Optional(Type.Boolean({ description: "Default false" })),
      maxFixRounds: Type.Optional(Type.Number({ description: "Default 2" })),
      resume: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      reload();
      try {
        const result = await runTriadPipeline(cwd, config, pool, {
          taskId: params.taskId,
          userGoal: params.userGoal,
          acceptanceCriteria: params.acceptanceCriteria,
          requiredChecks: params.requiredChecks,
          constraints: params.constraints,
          nonGoals: params.nonGoals,
          runCodex: params.runCodex,
          runChallenger: params.runChallenger,
          discardAtEnd: params.discardAtEnd,
          maxFixRounds: params.maxFixRounds,
          resume: params.resume,
        });
        if (result.writeSession) {
          writeSessions.set(params.taskId, result.writeSession);
        } else {
          writeSessions.delete(params.taskId);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError:
            result.overallStatus === "failed" || result.overallStatus === "blocked",
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `orchestrate failed: ${String(e)}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "maistro_manual_verify",
    label: "Maistro Manual Verify",
    description:
      "When Codex is quota-blocked, record external verification results (does not run tests in Maistro).",
    parameters: Type.Object({
      taskId: Type.String(),
      checks: Type.Array(
        Type.Object({
          id: Type.String(),
          exitCode: Type.Number(),
          summary: Type.Optional(Type.String()),
        }),
      ),
      notes: Type.Optional(Type.String()),
      attestedBy: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      try {
        const result = submitManualVerification(cwd, params);
        const meta = loadMeta(params.taskId);
        if (meta) {
          const { saveMeta } = await import("./task-journal.ts");
          saveMeta({
            ...meta,
            state: result.verdict === "pass" ? "codex_passed" : "codex_failed",
            updatedAt: new Date().toISOString(),
            lastError: result.verdict === "pass" ? undefined : "manual verify fail",
          });
        }
        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(result, null, 2) +
                "\n\nNext: maistro_continue_after_verify to run challenger and recompute merge recommendation.",
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: String(e) }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "maistro_continue_after_verify",
    label: "Maistro Continue After Verify",
    description:
      "After Codex or manual verification exists, run challenger and recompute merge recommendation.",
    parameters: Type.Object({
      taskId: Type.String(),
      runChallenger: Type.Optional(Type.Boolean()),
      discardAtEnd: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      reload();
      try {
        const result = await continueAfterVerify(cwd, config, pool, params.taskId, {
          runChallenger: params.runChallenger,
          discardAtEnd: params.discardAtEnd,
        });
        if (result.writeSession) writeSessions.set(params.taskId, result.writeSession);
        else writeSessions.delete(params.taskId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.mergeRecommended && result.overallStatus === "failed",
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: String(e) }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "maistro_debate",
    label: "Maistro Debate",
    description:
      "P4 multi-perspective debate (read-only proposers + blind judge). Optional memory save.",
    parameters: Type.Object({
      taskId: Type.String(),
      question: Type.String(),
      context: Type.Optional(Type.String()),
      proposers: Type.Optional(Type.Array(Type.String())),
      judgeRole: Type.Optional(Type.String()),
      saveMemory: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      reload();
      try {
        const result = await runDebate(cwd, config, pool, {
          taskId: params.taskId,
          question: params.question,
          context: params.context,
          proposers: params.proposers,
          judgeRole: params.judgeRole,
          saveMemory: params.saveMemory,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: result.overallStatus === "failed" || result.overallStatus === "blocked",
        };
      } catch (e) {
        return { content: [{ type: "text", text: String(e) }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "maistro_memory_add",
    label: "Maistro Memory Add",
    description: "Append a decision/pattern/failure/note to .system/memory/",
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal("decision"),
        Type.Literal("pattern"),
        Type.Literal("failure"),
        Type.Literal("note"),
      ]),
      title: Type.String(),
      body: Type.String(),
      taskId: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) {
      try {
        const path = appendMemory(cwd, {
          ts: new Date().toISOString(),
          kind: params.kind,
          title: params.title,
          body: params.body,
          taskId: params.taskId,
          tags: params.tags,
        });
        return { content: [{ type: "text", text: `saved ${path}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: String(e) }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "maistro_memory_search",
    label: "Maistro Memory Search",
    description: "Search project memory entries",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const hits = searchMemory(cwd, params.query, params.limit ?? 10);
      return {
        content: [{ type: "text", text: JSON.stringify(hits, null, 2) }],
      };
    },
  });

  pi.registerTool({
    name: "maistro_stats",
    label: "Maistro Stats",
    description: "Cost/task/debate statistics snapshot",
    parameters: Type.Object({}),
    async execute() {
      reload();
      const s = buildStats(cwd, config);
      return {
        content: [
          {
            type: "text",
            text: renderStatsText(s) + "\n\n" + JSON.stringify(s, null, 2),
          },
        ],
      };
    },
  });

  pi.on("session_start", async () => {
    try {
      reload();
    } catch (e) {
      console.error("[maistro] config load failed", e);
    }
  });

  pi.on("session_end", async () => {
    try {
      pool.dispose();
    } catch {
      /* ignore */
    }
  });
}
