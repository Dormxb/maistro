# Maistro

Multi-model collaborative coding and code review extension for pi.

## What Maistro Does

Maistro orchestrates **multiple AI models working together** on your codebase:

| Role | Model | Responsibilities |
|---|---|---|
| **Architect** | Claude Fable 5 | Design architecture, interfaces, risk analysis |
| **Executor** | Grok 4.5 / DeepSeek V4 | Write code in isolated worktrees |
| **Challenger** | GPT-5.6 Sol | Adversarial review — find bugs, security issues, edge cases |
| **Verifier** | Codex | Run actual tests in sandbox (never on your machine) |

## Key Features

- **AgentTool Routing**: Automatically selects the best available model for each request. Uses pi models as baseline, upgrades to Claude/Codex/Kimi/Agy CLI when available and healthy.
- **Six-State Health Model**: healthy → degraded → rate_limited → quota_exhausted → unavailable → unknown. Tools auto-recover when limits reset.
- **Isolated Worktrees**: Executor writes in git worktrees — never touches your working tree until you decide to merge.
- **Budget Protection**: Hard cap at $50/month. Auto-downgrades to cheaper models when 80% spent.
- **Adversarial Review**: Challenger independently attacks the implementation looking for flaws.
- **Cross-Platform**: Windows, macOS, Linux.

## How to Use

### Check Status
```
/maistro doctor
```
Shows all available models and their health status.

### Orchestrate a Task
Use the `maistro_orchestrate` tool:
- `taskId`: Unique task identifier
- `userGoal`: What you want to accomplish
- `acceptanceCriteria`: How to verify success
- `requiredChecks`: Tests Codex must run (e.g., `["npm test"]`)

### Quick Agent Call
Use `maistro_agent_call` for single-role tasks:
- `role`: `architect` | `executor` | `challenger`
- `prompt`: Your request
- `taskId`: Correlation ID

### Review Existing Code
Use `maistro_debate` for multi-perspective analysis of design decisions.

## Commands
- `/maistro doctor` — Health check for all models
- `/maistro tasks` — List active tasks
- `/maistro stats` — Cost and usage statistics
- `/maistro budget` — Budget status
- `/maistro discard <id>` — Clean up task worktree
- `/maistro cancel <id>` — Cancel running task

## Tools
- `maistro_orchestrate` — Full pipeline: Architect → Executor → Codex → Challenger
- `maistro_agent_call` — Single role call (architect/executor/challenger)
- `maistro_debate` — Multi-perspective debate with blind judge
- `maistro_memory_add` — Save decisions/patterns to project memory
- `maistro_memory_search` — Search project memory
- `maistro_stats` — Cost/task statistics

## Configuration (optional)
Default config works out of the box. Create `.maistro.jsonc` only if you need to customize:
- Change models per role
- Adjust monthly budget
- Enable/disable specific CLI tools
- Lock routing to baseline-only mode
