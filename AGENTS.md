# Repository Guidelines

## Project Structure & Module Organization
- `app/`: Next.js App Router pages, API routes, and UI components.
  - `app/api/`: REST endpoints for auth, files, and downloads.
  - `app/components/`: UI building blocks (file browser, editor, terminal).
  - `app/lib/`: auth, SSH/local filesystem, utilities.
  - `app/store/`: Zustand state stores.
- `components/ui/`: shadcn/ui primitives (button, dialog, tooltip, etc.).
- `docs/`: deployment, security, monitoring guides.
- `server/`: custom Node server for WebSocket terminal.
- `scripts/`: build/deploy/test helpers.

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
- Local filesystem mode is supported: `SSH_USE_LOCAL_FS=true` and `SSH_BASE_PATH=/home/canvas-notebook/workspace`.
- For remote SSH/SFTP, set `SSH_HOST`, `SSH_USER`, and `SSH_KEY_PATH`.
- Keep secrets in `.env.local` / `.env.systemd` and out of git.
