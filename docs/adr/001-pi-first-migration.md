# ADR 001: PI-first Migration

## Status
Accepted

## Context
The current AI agent backend logic is fragmented across multiple providers and custom streaming implementations. To improve maintainability and leverage a unified agent core, we are migrating to `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core`.

## Decision
We will completely replace the existing agent engine with the PI runtime.

### Key Decisions:
1. **PI-first strategy:** The backend will only support the PI engine once the migration is complete.
2. **Hard Cutover:** No long-term parallel support for legacy agent logic in the `main` branch.
3. **UI Integration:** The existing Chat UI will be retained but integrated with the PI runtime events (text deltas, thinking blocks, tools).
4. **Adapter Pattern:** Upstream PI packages will remain unmodified. All project-specific logic will reside in a local adapter layer (e.g., `app/lib/pi/`).
5. **Session Persistence:** Migrate from text-centric to PI-compatible `AgentMessage` context snapshots.

## Non-Goals & Boundaries
- **pi-web-ui Adoption:** We are NOT replacing our current Chat UI with `pi-web-ui` at this stage.
- **pi-tui:** Integration into the terminal is optional and secondary.
- **Provider Parity:** Only providers supported by `pi-ai` will be used (OpenRouter, Claude, Ollama native, etc.).

## Consequences
- Significant cleanup of legacy chat routes and stream parsers.
- Unified handling of tools and thinking processes.
- Migration required for existing user sessions (best-effort).
