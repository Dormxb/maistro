# 🍸 Maistro

> Multi-model collaborative coding & review for [pi](https://github.com/earendil-works/pi-coding-agent)

[![npm](https://img.shields.io/npm/v/@simplesiong/maistro)](https://www.npmjs.com/package/@simplesiong/maistro)
[![license](https://img.shields.io/npm/l/@simplesiong/maistro)](LICENSE)

---

## Install

```bash
pi install npm:@simplesiong/maistro
```

Zero config. Works on **Windows · macOS · Linux**.

---

## What it does

```
You: "Add dark mode toggle to settings"
          │
          ▼
   ┌──────────────┐
   │  Classifier  │  "simple feature → Architect + Executor"
   └──────┬───────┘
          │
   ┌──────▼──────┐   ┌──────────┐   ┌────────────┐
   │  Architect  │──▶│ Executor │──▶│ Challenger │
   │  (Fable 5)  │   │(Grok 4.5)│   │ (Sol)      │
   │  Design     │   │ Write    │   │ Attack     │
   └─────────────┘   └──────────┘   └────────────┘
                          │
                    ┌─────▼─────┐
                    │   Codex   │
                    │  Verify   │
                    └───────────┘
                          │
                    ┌─────▼─────┐
                    │   You     │
                    │  Merge?   │
                    └───────────┘
```

Four AI models collaborate on your code. Design → Write → Test → Review. You decide what ships.

---

## In action

### `/maistro doctor` — health check

```
🟢 pi-session     healthy   deepseek-v4-flash, grok-4.5, deepseek-v4-pro
🟢 claude-cli      healthy   fable-5, opus-4-8, sonnet-5, haiku-4-5
🟢 codex-cli       healthy   gpt-5.6-sol, gpt-5, gpt-5-fast
🟢 agy-cli         healthy   antigravity-default
🟢 kimi-cli        healthy   kimi-default
```

### `/maistro tokens` — cost histogram

```
Token Cost by Model
==============================
deepseek-v4-flash ████████████░ $0.45
xai/grok-4.5      ██████░░░░░░░ $0.29
claude-fable-5    ████░░░░░░░░░ $0.20

Token Cost by Agent Tool
==============================
pi-session        ██████████████ $0.74
claude-cli        ████░░░░░░░░░ $0.20
```

---

## Features

| | |
|---|---|
| 🔀 **Auto routing** | Picks best model per request. CLI tools auto-detected. |
| 💚 **Self-healing** | Rate limits? Auto-fallback. Quota resets? Auto-rejoin. |
| 💰 **Budget guard** | $50/mo hard cap. Auto-downgrades at 80%. |
| 📋 **TODO tracking** | LLM breaks down work without interrupting you. |
| 🌍 **Cross-platform** | Windows, macOS, Linux. No config changes. |

---

## Quick start

```bash
# Install
pi install npm:@simplesiong/maistro

# Check health
/maistro doctor

# View costs
/maistro tokens

# Run a task — call maistro_orchestrate
```

---

## Tasks (P0–P8)

```
P0 ─ Pi API probing          ✅
P1 ─ Trust Core + guards     ✅
P2 ─ Triad orchestration     ✅
P3 ─ Fix loop + recovery     ✅
P4 ─ Debate + Memory         ✅
P5 ─ AgentTool plugin routing ✅
P6 ─ Smoke + config          ✅
P7 ─ Cross-platform + npm    ✅
P8 ─ Token stats + TODO      ✅
```

---

## License

MIT
