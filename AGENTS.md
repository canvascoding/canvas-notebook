# Repository Guidelines

## Project Structure & Module Organization

- `app/`: Next.js App Router pages, API routes, and UI components.
  - `app/api/`: REST endpoints for auth, files, and downloads.
  - `app/components/`: UI building blocks (file browser, editor, terminal).
  - `app/lib/`: auth, local filesystem, utilities.
  - `app/store/`: Zustand state stores.
- `components/ui/`: shadcn/ui primitives (button, dialog, tooltip, etc.).
- `docs/`: deployment, security, monitoring guides.
- `server/`: custom Node server for WebSocket terminal.
- `scripts/`: build/deploy/test helpers.

## TASK: PI Agent von Mariozechner integrieren

- Diese Regeln gelten für alle Arbeiten an der neuen Agent-Logik.
- UI- und End-to-End-Prüfungen mit Playwright oder Chrome DevTools durchführen.
- immer ein npm run build testen bevor ein container gebaut wird.
- Sicherstellen, dass nie mehrere Test-Container parallel laufen.
- Test-Container bei neuem Testlauf immer mit aktuellem Stand neu laden (recreate/rebuild), statt alte Container weiterzuverwenden.
- commmit sauber die einzelnen fertigen to dos, aber nicht pushen. 
- container auf port 3000 nur bauen wenn es explizit gefordert wird 
- login für die app ist email: admin.com und psw: change-me
- mach mit keinem to do weiter wenn der vorherige to do noch nicht fertig ist
- update immer /Users/frankalexanderweber/.openclaw/workspace-mango-jerry/canvasstudios-notebook/docs/pi-first-implementation-todo.json damit wir up to date bleiben
- arbeite proaktiv, mach commits zwischendurch und mach noch keine weitere task bevor eine wichtige task fertig ist. 
- teste auch das UI wenn du etwas integrierst.
- /Users/frankalexanderweber/.openclaw/workspace-mango-jerry/canvasstudios-notebook/docs/pi-first-migration-plan.md hier liegt der komplette plan für den generellen overview. 

## Build, Test, and Development Commands
- `npm run dev`: local dev server (set `PORT=3001` if needed).
- `npm run build`: production build.
- `npm run start`: start the custom server.
- `npm run lint`: eslint checks.
- `npm run test:smoke`: smoke test against a running server.
- `npm run test:integration`: API integration tests.
- `npm run test:e2e`: Playwright E2E tests.
- `npm run test:all`: build + start + all tests.

## Coding Style & Naming Conventions
- TypeScript/React with 2-space indentation.
- Components in `PascalCase` (`FileBrowser.tsx`).
- Functions/variables in `camelCase` (`loadFileTree`).
- Linting: ESLint (`npm run lint`).
- Prefer small, focused components and avoid heavy inline logic.

## Testing Guidelines
- E2E: Playwright (`tests/e2e.spec.ts`).
- Integration/smoke scripts in `scripts/`.
- No explicit coverage target; keep tests relevant to changed behavior.
- Run `npm run test:all` before production deploys.

## Commit & Pull Request Guidelines
- Git history has a single initial commit; no enforced convention.
- Use short, descriptive commit messages (e.g., `Fix terminal copy on iPad`).
- PRs should include: summary, screenshots for UI changes, and steps to verify.

## Security & Configuration Tips
- Production uses `systemd` (`canvas-notebook.service`).
- Base data path is configured via `DATA` (default: `./data`). Workspace, SQLite, and skills are stored under this path.
- Keep secrets in `.env.local` / `.env.systemd` and out of git.

## Agent Storage Locations
Agent-managed files are persisted in `/data` for easy access and backup:
- **System Prompt Files:** `/data/canvas-agent/` (AGENTS.md, MEMORY.md, SOUL.md, TOOLS.md)
- **Runtime Config:** `/data/canvas-agent/pi-runtime-config.json`
- **Secrets:** `/data/secrets/` (Canvas-Integrations.env, Canvas-Agents.env)

These paths replace the legacy `/home/node/canvas-agent/` location. The bootstrap script automatically migrates existing files on container startup.