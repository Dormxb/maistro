# Maistro

Multi-model collaborative coding & review extension for [pi](https://github.com/earendil-works/pi-coding-agent).

```
Architect (Fable 5) → Executor (Grok 4.5) → Codex verify → Challenger (Sol)
```

## Install

```bash
pi install git:github.com/Dormxb/maistro@v8.3.0
```

## Requirements

- pi >= 0.80.7
- Git worktree support (for isolated writes)
- At least one pi-configured model (xai/grok-4.5 recommended for write capability)

### Optional CLI tools (for model diversity)

| Tool | Purpose | Install |
|------|---------|---------|
| Claude CLI | Architect/Challenger intelligence tier | `npm i -g @anthropic-ai/claude-code` |
| Codex CLI | Challenger adversarial review | `npm i -g @openai/codex` |
| Agy CLI | Balance tier option | `npm i -g agy` |
| Kimi CLI | Balance tier option | `npm i -g @anthropic/kimi-code` |

## Quick Start

1. Create `.maistro.jsonc` in your project root:

```jsonc
{
  "version": "8.2",
  "agents": {
    "architect":  { "provider": "anthropic", "model": "claude-fable-5", "tools": ["read"], "tierPreference": "upgrade" },
    "executor":   { "provider": "xai", "model": "grok-4.5", "tools": ["read", "write", "edit"], "tierPreference": "baseline" },
    "challenger": { "provider": "openai", "model": "gpt-5.6-sol", "tools": ["read"], "tierPreference": "upgrade" }
  },
  "routing": { "enabled": true, "preferUpgrade": true, "budgetAwareDowngrade": true },
  "agentTools": {
    "providers": {
      "pi-session": { "enabled": true },
      "claude-cli":  { "enabled": true },
      "codex-cli":   { "enabled": true }
    }
  },
  "cost": { "monthlyBudget": 50, "hardCap": true, "perTaskLimit": 15 }
}
```

2. Run doctor to verify:

```
/maistro doctor
```

3. Orchestrate a task:

Use `maistro_orchestrate` tool with taskId, userGoal, acceptanceCriteria, requiredChecks.

## Features

- **AgentTool plugin system**: Auto-discovers pi models + external CLI tools
- **Six-state health model**: healthy / degraded / rate_limited / quota_exhausted / unavailable / unknown
- **Two-pool model routing**: baseline (pi models) + upgrade (CLI tools when available)
- **Budget-aware downgrade**: Auto-switches to baseline when >80% monthly spend
- **Downgrade observability**: Every routing decision logged with reason
- **Cross-platform**: Windows, macOS, Linux
