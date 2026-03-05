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

## TASK: agent implementieren
- Diese Regeln gelten für alle Arbeiten an der neuen Agent-Logik.
- Vor, während und nach Änderungen immer den aktuellen Stand der To-dos synchronisieren und prüfen:
  - Datei: `docs/agent-implementation-todo.json`
  - Befehl: `npm run todos:sync:agent`
- Bei jeder Umsetzung die betroffenen To-dos in `docs/agent-implementation-todo.json` auf Aktualität prüfen.
- UI- und End-to-End-Prüfungen mit Playwright oder Chrome DevTools durchführen.
- Für manuelle Tests immer einen Container auf Port `3000` verwenden.
- Sicherstellen, dass nie mehrere Test-Container parallel laufen.
- Test-Container bei neuem Testlauf immer mit aktuellem Stand neu laden (recreate/rebuild), statt alte Container weiterzuverwenden.

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
- Workspace path is configured via `WORKSPACE_DIR` (default: `./workspace`).
- Keep secrets in `.env.local` / `.env.systemd` and out of git.
