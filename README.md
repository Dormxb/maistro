# Maistro

Multi-model collaborative coding & review for [pi](https://github.com/earendil-works/pi-coding-agent).

```
You give direction → Maistro orchestrates AI models → Codex verifies → You merge
```

## Install

```bash
pi install git:github.com/Dormxb/maistro
```

Zero config needed — sensible defaults work out of the box. Create `.maistro.jsonc` only for customisation.

## Architecture

```
┌──────────────────────────────────────────────┐
│              Task Classifier                  │
│         (deepseek-v4-flash)                   │
│   Classifies task → picks workflow           │
└──────────────────┬───────────────────────────┘
                   │
    ┌──────────────┼──────────────────┐
    ▼              ▼                  ▼
 Architect    Executor          Challenger
 (Fable 5)   (Grok 4.5 /       (GPT-5.6 Sol)
              DeepSeek V4)      
    │              │                  │
    ▼              ▼                  ▼
┌───────────────────────────────────────────────┐
│              ModelRouter                       │
│   baseline (pi models) + upgrade (CLI tools)  │
│   Auto-selects best available model           │
└───────────────────────────────────────────────┘
```

## Features

### Multi-Agent Pipeline
- **Architect** — Designs architecture, interfaces, risks
- **Executor** — Writes code in isolated git worktrees
- **Challenger** — Adversarial review (finds bugs, security issues)
- **Codex Verifier** — Runs tests in sandbox (never on your machine)

### AgentTool Routing
Automatically discovers available models and selects the best one per request. Six-state health tracking with auto-recovery:
- `healthy` → `degraded` → `rate_limited` → `quota_exhausted` → `unavailable` → `unknown`

CLI tools (Claude, Codex, Agy, Kimi) auto-detected. Tools that hit rate limits auto-recover when limits reset.

### Budget Protection
- $50/month hard cap (configurable)
- Auto-downgrades to baseline models at 80% spend
- Token statistics with per-model/per-tool ASCII histograms

### TODO Tracking
Non-intrusive task tracking — LLM breaks down complex work into TODOs without interrupting your conversation. Displayed in TUI sidebar.

### Cross-Platform
Windows, macOS, Linux. Auto-detects platform and resolves binary paths.

## Quick Start

### 1. Check everything is healthy

```
/maistro doctor
```

Shows model status and routing configuration.

### 2. Token stats

```
/maistro tokens
```

ASCII histogram of cost by model and tool.

### 3. Orchestrate a task

Use the `maistro_orchestrate` tool:

```json
{
  "taskId": "add-dark-mode",
  "userGoal": "Add dark mode toggle to settings",
  "acceptanceCriteria": [
    "Toggle switches between light and dark themes",
    "Preference persists across restarts"
  ],
  "requiredChecks": ["npm test"]
}
```

The pipeline runs: Architect → Executor → Static Checks → Codex → Challenger.

## Commands

| Command | Description |
|---|---|
| `/maistro doctor` | Health check for all models and tools |
| `/maistro tasks` | List active tasks |
| `/maistro tokens` | Token cost histogram by model/tool |
| `/maistro tokens <id>` | Per-task token breakdown |
| `/maistro stats` | Cost and usage statistics |
| `/maistro budget` | Budget status |
| `/maistro discard <id>` | Clean up task worktree |
| `/maistro cancel <id>` | Cancel running task |

## Tools

| Tool | Description |
|---|---|
| `maistro_orchestrate` | Full pipeline: Architect → Executor → Codex → Challenger |
| `maistro_agent_call` | Single role call (architect/executor/challenger) |
| `maistro_continue_after_verify` | Re-run challenger after manual verification |
| `maistro_manual_verify` | Submit external verification results |
| `maistro_debate` | Multi-perspective debate with blind judge |
| `maistro_todo_add` | Add TODO item for task tracking |
| `maistro_todo_update` | Update TODO status |
| `maistro_todo_list` | List TODOs for a task |
| `maistro_memory_add` | Save decisions/patterns to project memory |
| `maistro_memory_search` | Search project memory |
| `maistro_stats` | Cost/task/debate statistics |

## Configuration

Default config — no `.maistro.jsonc` needed. Customise only if you want:

```jsonc
{
  "version": "8.2",
  "agents": {
    "architect": {
      "tools": ["read", "grep", "find", "ls"],
      "tierPreference": "upgrade"       // Use Claude Fable 5 when available
    },
    "executor": {
      "tools": ["read", "grep", "find", "ls", "write", "edit"],
      "tierPreference": "baseline"      // Use pi models (grok-4.5 / deepseek-v4)
    },
    "challenger": {
      "tools": ["read", "grep", "find", "ls"],
      "tierPreference": "upgrade"       // Use GPT-5.6 Sol when available
    }
  },
  "routing": {
    "enabled": true,
    "preferUpgrade": true,              // Use CLI tools when healthy
    "budgetAwareDowngrade": true        // Auto-switch to cheaper models at 80%
  },
  "cost": {
    "monthlyBudget": 50,
    "hardCap": true,
    "perTaskLimit": 15
  }
}
```

## Requirements

- pi >= 0.80.7
- Git (for worktree isolation)
- At least one pi-configured model (grok-4.5 recommended for write)

**Optional CLI tools** (for model diversity in upgrade tier):

| Tool | Install |
|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` |
| Codex CLI | `npm i -g @openai/codex` |
| Agy | `npm i -g agy` |
| Kimi Code | `npm i -g @anthropic/kimi-code` |

## License

MIT
