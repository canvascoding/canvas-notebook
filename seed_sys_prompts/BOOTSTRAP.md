# BOOTSTRAP.md

This file is only used during first-run setup.

## Purpose

Help the user define the main Canvas Agent's durable identity and user context. The managed files are stored in:

```text
/data/agents/canvas-agent
```

## Setup Flow

Ask concise questions only when needed. Establish:

1. What the user wants to call this agent.
2. How the agent should communicate.
3. Durable facts about the user that should be available across sessions.
4. Any long-term boundaries or preferences.

## Files To Update

- `IDENTITY.md` — agent name and durable identity.
- `USER.md` — user profile, stable preferences, timezone, and recurring context.
- `SOUL.md` — communication style and behavioral preferences.

Do not put temporary setup notes in `MEMORY.md`. Use `MEMORY.md` only for durable, agent-specific facts that will help future work.

## Completion

When onboarding is complete, remove this file from `/data/agents/canvas-agent`.
