# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Canvas Notebook** is a self-hosted Next.js web app combining:
- A file browser + code editor (CodeMirror) for a workspace directory
- A terminal emulator (xterm.js + node-pty via WebSocket)
- A spreadsheet viewer (UniverseJS)
- An AI agent chat interface powered by the **PI framework** (`@mariozechner/pi-ai` + `@mariozechner/pi-agent-core`)

## Commands

```bash
npm run dev                     # Start dev server (tsx server.js, not next dev)
npm run build                   # Production build (next build --webpack)
npm run start                   # Production start (bootstrap admin + tsx server.js)
npm run lint                    # ESLint

npm run bootstrap:admin         # Create initial admin user from BOOTSTRAP_ADMIN_* env vars

npm run test:smoke              # Quick smoke test
npm run test:integration        # API integration tests
npm run test:integration:pi     # PI agent integration tests
npm run test:pi:attachments     # PI attachment tests
npm run test:prompt-builder     # Prompt builder tests
npm run test:e2e                # Playwright E2E tests
npm run test:all                # Full suite (build + all above)
```

**Important:** Every `dev`, `build`, `lint`, and `test:*` command runs `npm run todos:sync:agent` as a pre-hook, which syncs implementation TODOs from managed files in `app/lib/agents/`.

The dev server is `tsx server.js` (not `next dev`) because the custom server adds WebSocket support for terminals and authenticated `/media/` file serving.

## Architecture

### Custom Server (`server.js`)
The app runs through a custom Node.js server that wraps Next.js:
- Handles `/media/` routes with auth-gated static file serving (range requests, cache control)
- Attaches a WebSocket server for terminal sessions (`server/terminal-server.js`)
- Delegates everything else to Next.js

### PI Agent Streaming (`app/api/stream/route.ts`)
The main AI agent endpoint is `POST /api/stream`. It:
1. Resolves provider/model from config via `app/lib/pi/model-resolver.ts`
2. Resolves the API key via `app/lib/pi/api-key-resolver.ts`
3. Looks up or creates a PI session in SQLite (`pi_sessions`, `pi_messages` tables)
4. Runs the PI agent loop with registered tools from `app/lib/pi/tool-registry.ts`
5. Streams results back as SSE

Tools available to the agent: `ls`, `read`, `write`, `mkdir`, `terminal exec`, and others registered in `tool-registry.ts`.

### Database (`app/lib/db/`)
SQLite via Drizzle ORM. Schema in `app/lib/db/schema.ts`. Migration config in `drizzle.config.ts`.

Tables:
- `user`, `session`, `account`, `verification` — managed by better-auth
- `pi_sessions`, `pi_messages` — PI agent conversation persistence
- `claude_sessions`, `claude_messages`, `ai_sessions`, `ai_messages` — legacy, kept for compatibility

### Authentication (`app/lib/auth.ts`)
better-auth with SQLite adapter. Session cookies cached for 5 minutes. Signup can be disabled via `ALLOW_SIGNUP=false`. Custom `role` field on users. Bootstrap admin user created from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` env vars.

### Terminal (`server/terminal-server.js`, `server/terminal-manager.js`)
WebSocket-based PTY sessions. Max 3 terminals per user, 30-min idle timeout. Sessions are in-memory only (lost on server restart).

### Workspace & Files
Workspace root is configurable via `WORKSPACE_DIR` env (defaults to `./data/workspace`). File CRUD via `app/api/files/`. The workspace path is sandboxed — file API rejects paths that escape it.

### PI Agent Config (`app/lib/pi/config.ts`)
Config is file-based (PI v2 format), provider-driven. Supports openrouter, anthropic, google, ollama. The agent system prompt is composed from managed files in `app/lib/agents/` (synced by `scripts/sync-agent-todos.mjs`).

## Key Environment Variables

```
BETTER_AUTH_SECRET          # Required: 32-byte base64 session key
BETTER_AUTH_BASE_URL        # Required: auth redirect base URL
WORKSPACE_DIR               # Workspace root (default: ./data/workspace)
DATABASE_PATH               # SQLite path (default: ./data/sqlite.db)
ALLOW_SIGNUP                # Set to "false" to disable registration
BOOTSTRAP_ADMIN_EMAIL       # Admin email for initial setup
BOOTSTRAP_ADMIN_PASSWORD    # Admin password for initial setup
CLAUDE_API_KEY              # Anthropic Claude API key
OPENROUTER_API_KEY          # OpenRouter API key
GEMINI_API_KEY              # Google Gemini API key
OLLAMA_BASE_URL             # Local Ollama endpoint
INTEGRATIONS_ENV_PATH       # Path to integrations secrets file
AGENTS_ENV_PATH             # Path to agents secrets file
```

## State Management

UI state is managed with Zustand. The main store is in `app/lib/store/` or co-located with components. Server state flows through Next.js API routes — no tRPC or React Query.

## Docker

```bash
docker compose up   # Uses compose.yaml, single service
```

Data volumes: `/data/workspace` (files), `/data/sqlite.db` (database), `/home/node` (npm globals/CLI config). Optionally installs `codex`, `claude`, or `ollama` at container startup based on env vars.
