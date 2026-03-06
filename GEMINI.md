# Canvas Notebook - Project Context & Mandates

## Project Overview
Canvas Notebook is a modern Next.js-based web application designed as an interactive online notebook. It features a robust file browser, integrated terminal, and advanced AI agent capabilities.

### Key Technologies
- **Frontend:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS, shadcn/ui, Zustand.
- **Backend:** Next.js API Routes, Custom Node.js Server (`server.js`) for WebSockets/PTY.
- **Database & Auth:** Drizzle ORM (SQLite), Better-Auth, iron-session.
- **Terminal:** xterm.js, node-pty.
- **AI Agent Integration:** (Transitioning) Current focus is migrating to the **PI-first** agent system using `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core`.

---

## 🏗️ Project Structure & Module Organization

- `app/`: Next.js App Router pages, API routes, and UI components.
  - `app/api/`: REST endpoints for auth, files, and downloads.
  - `app/components/`: UI building blocks (file browser, editor, terminal).
  - `app/lib/`: auth, local filesystem, utilities.
  - `app/store/`: Zustand state stores.
- `components/ui/`: shadcn/ui primitives (button, dialog, tooltip, etc.).
- `docs/`: deployment, security, monitoring guides, and migration plans.
- `server/`: custom Node server for WebSocket terminal.
- `scripts/`: build/deploy/test helpers.

---

## 🤖 MANDATE: PI Agent von Mariozechner integrieren

These rules are **non-negotiable** for all work on the new agent logic:

1.  **Strict Sequencing:** Follow the sequence in `docs/pi-first-implementation-todo.json` exactly. Do not proceed to the next task until the current one is finished and verified.
2.  **Testing Protocol:** 
    - Perform UI and E2E checks with Playwright or Chrome DevTools.
    - **Container Usage:** Always use a single container on port `3000` for manual tests.
    - **Isolate Environments:** Ensure no multiple test containers run in parallel.
    - **Clean Slate:** Rebuild/recreate (`--force-recreate`) the container for every new test run; do not reuse old containers.
3.  **Authentication:** Use `info@canvasstudios.store` / `Canvas2026!` for testing.
4.  **Documentation Sync:** Always update `/Users/frankalexanderweber/.openclaw/workspace-mango-jerry/canvasstudios-notebook/docs/pi-first-implementation-todo.json` to keep status current.
5.  **Proactive Workflow:** Work proactively, make frequent commits for completed sub-tasks, and **never push** unless explicitly instructed.
6.  **UI Verification:** Always test the UI when integrating backend components.
7.  **Reference:** The full plan is in `docs/pi-first-migration-plan.md`.

---

## 🛠️ Development & Operations

### Build, Test, and Development Commands
- `npm run dev`: local dev server (set `PORT=3001` if needed).
- `npm run build`: production build.
- `npm run start`: start the custom server.
- `npm run lint`: eslint checks.
- `npm run test:smoke`: smoke test against a running server.
- `npm run test:integration`: API integration tests.
- `npm run test:e2e`: Playwright E2E tests (`tests/e2e.spec.ts`).
- `npm run test:all`: build + start + all tests. Run this before production deploys.

### Coding Style & Naming Conventions
- TypeScript/React with 2-space indentation.
- Components in `PascalCase` (`FileBrowser.tsx`).
- Functions/variables in `camelCase` (`loadFileTree`).
- Prefer small, focused components; avoid heavy inline logic.
- Linting: ESLint (`npm run lint`).

### Commit & Pull Request Guidelines
- Use short, descriptive commit messages (e.g., `Fix terminal copy on iPad`).
- PRs must include a summary, screenshots for UI changes, and verification steps.

### Security & Configuration
- **Secrets:** Keep secrets in `.env.local` or environment variables; never commit them.
- **Production:** Uses `systemd` (`canvas-notebook.service`).
- **Workspace:** Path configured via `WORKSPACE_DIR` (default: `./workspace`).
- **DB Path:** Configured via `SQLITE_PATH`.
