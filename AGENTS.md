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

## TASKs:

- Diese Regeln gelten für alle Arbeiten an der neuen Agent-Logik.
- UI- und End-to-End-Prüfungen mit Playwright oder Chrome DevTools durchführen.
- immer ein npm run build testen bevor ein container gebaut wird.
- Sicherstellen, dass nie mehrere Test-Container parallel laufen.
- Test-Container bei neuem Testlauf immer mit aktuellem Stand neu laden (recreate/rebuild), statt alte Container weiterzuverwenden.
- committe sauber die einzelnen fertigen to dos; pushen ist erlaubt, wenn ein PR erstellt/aktualisiert werden soll oder der User es explizit fordert.
- container auf nur bauen wenn es explizit gefordert wird 
- login für die app über `BOOTSTRAP_ADMIN_EMAIL` und `BOOTSTRAP_ADMIN_PASSWORD` aus der lokalen Env-Konfiguration
- mach mit keinem to do weiter wenn der vorherige to do noch nicht fertig ist
- arbeite proaktiv, mach commits zwischendurch und mach noch keine weitere task bevor eine wichtige task fertig ist. 
- teste auch das UI wenn du etwas integrierst.
Für das lokale Dev-Setup den Skill `canvas-local-team-seat-dev` verwenden; er definiert den verwalteten Stack und verhindert parallele Testumgebungen.
- nutz playwright oder so nur wenn ich es explizit sage oder frage danach bevor du es verwendest


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
- Before merging a PR into `main`, verify that all required status checks have completed successfully and that no unresolved actionable review threads remain.
- Review all human and automated comments. Fix actionable findings; document and resolve non-actionable or false-positive findings.
- Do not merge while required checks are pending or failing.

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

## Environment Variables & Secrets

**WICHTIG:** Alle Environment-Variablen für Skills, Integrationen und API-Keys müssen zentral verwaltet werden.

### Speicherort
- **Integrations-Env-Datei:** `/data/secrets/Canvas-Integrations.env`
- Diese Datei wird über den Settings-Bereich unter dem Tab "Integrations" verwaltet

### Regeln für Agent-Implementierungen
1. **Keine Hardcoded Secrets:** API-Keys, Tokens oder sensible Daten dürfen niemals direkt im Code oder in Konfigurationsdateien hinterlegt werden
2. **Zentrale Verwaltung:** Alle Env-Variablen müssen über den Integrations-Tab in `/data/secrets/Canvas-Integrations.env` gespeichert werden
3. **Zugriff über API:** Skills und Tools müssen Env-Variablen über die bereitgestellten API-Endpunkte (`/api/integrations/env`) abrufen
4. **Beispiele für erforderliche Keys:**
   - `GEMINI_API_KEY` - Für Bildgenerierung, Video-Generierung und Ad-Localisierung
   - Provider-spezifische API-Keys (OpenAI, Anthropic, etc.)

### Fehlerbehandlung
Wenn ein Skill oder Tool eine Env-Variable benötigt, die nicht gesetzt ist:
- Zeige eine klare Fehlermeldung im UI an
- Verlinke auf den Integrations-Tab in den Settings
- Biete einen direkten Link: `/settings?tab=integrations`

---

## Control Plane Agent Integration

**This repository contains the Canvas Notebook service (the payload).** It is managed remotely by the **Canvas Control Plane** via the **Canvas Agent** running on the VM host.

### What the Agent Does

The Agent is a lightweight Node.js service (systemd) that:
- Connects to the Control Plane API via WebSocket tunnel
- Collects host and Docker metrics
- Executes management commands locally
- Reports status, alerts (OOM), and container health

### Interfaces Used by the Agent

| Interface | Location | Purpose |
|-----------|----------|---------|
| **Canvas CLI** | `/usr/local/bin/canvas-notebook` | Commands: `update`, `restart`, `start`, `stop`, `health`, `logs`, `status` |
| **Health Endpoint** | `GET /api/health` (inside container) | Container readiness check (returns `{ ok: true }` or DB-connected health JSON) |
| **Docker Compose** | `/opt/canvas/canvas-notebook-compose.yaml` | Container lifecycle management |
| **Systemd Service** | `canvas-notebook.service` | Host-level service control (if installed) |

### Architecture References

- **Canvas Notebook context:** `docs/architecture/canvas-notebook/plan.md`
- **Complete system architecture:** `docs/architecture/canvas-control-plane/plan.md`
- **Implementation tasks:** `docs/architecture/canvas-notebook/todo.json`

**No code changes in this repository are required** for Control Plane integration. The Agent interacts exclusively through the CLI, Docker, and HTTP health endpoint.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **canvas-notebook** (30278 symbols, 81766 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/canvas-notebook/context` | Codebase overview, check index freshness |
| `gitnexus://repo/canvas-notebook/clusters` | All functional areas |
| `gitnexus://repo/canvas-notebook/processes` | All execution flows |
| `gitnexus://repo/canvas-notebook/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
