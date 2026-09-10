# PostgreSQL-Pool-Nutzer: Inventar zur Startup-Regression

Stand: `96b0ff0f` / v2026.9.10.10, 10.09.2026. Ergänzung zum [Fix- und Testplan](postgres-startup-regression-plan.md).

## Erfassung und Grenzen

TypeScript-AST über alle TS/JS-Dateien in `app/`, `server/`, `lib/`, zusätzlich `server.js` und `scripts/bootstrap-agent-runtime.ts`: benannte, nicht nur typbasierte Imports von `db` / `openDb` aus dem DB-Einstieg sowie dynamische DB-Imports. Hinzu kommt der bekannte CommonJS-Zugriff im Server. Keine Produktdatei wurde geändert.

154 Dateien importieren statisch `db` oder `openDb`: 93 Drizzle, 64 Lease, davon 3 beide. Sieben weitere Laufzeitdateien importieren dynamisch; Server und separater Bootstrap-Prozess sind unten zusätzlich enthalten. Insgesamt 163 erfasste Einstiegskonsumenten. Die Spalte zählt nur syntaktische `openDb()`-Aufrufe, nicht `database.openDb()`, Aliasaufrufe oder indirekte Aufrufer. In app/server/lib plus server.js sind es 212 solcher Aufrufe; dies ist keine maximale Laufzeitkonkurrenz.

Drizzle/Better Auth verwenden den Runtime-Pool mit automatischer Freigabe für normale Queries; Transaktionen halten ihren Client bis zum Abschluss. Lease-Aufrufer müssen `close()` im `finally` ausführen, und alle Queries müssen davor abgeschlossen sein. Dynamische Nutzer wurden zusätzlich auf diese Verträge geprüft. Ein vorhandenes `close()` allein beweist weder korrekte Fehlerpfade noch Leckfreiheit.

Weitere indirekte Nutzer (z. B. Memory-Worker, Channel Manager, API-Routen mit Repository-/Permission-Services) sind über die hier gelisteten Stores und die GitNexus-Upstream-Analyse erfasst, nicht als zusätzliche Pools gezählt. Bei verdächtigen fehlenden Close-Aufrufen wurden auch `close?.()` und delegierte Transaktionsverantwortung berücksichtigt; der bestätigte Session-Cleanup-Fehler steht im Hauptplan. Dies ist keine formale Vollständigkeitsgarantie für dynamische JavaScript-Aufrufe.

## Pool-Erzeugung und separate Prozesse

- `app/lib/db/postgres.ts:createPostgresPool`: einzige produktive `new Pool`-Stelle.
- `app/lib/db/index.ts:createPostgresDatabase`: lazy Runtime-Pool; `db`, `openDb` und E-Mail-Cache teilen ihn innerhalb derselben geladenen Modulinstanz.
- `app/lib/db/startup-migrations.ts`: eigener temporärer Pool, `end()` im `finally`.
- `scripts/bootstrap-admin-postgres.ts`: eigener Prozess/Pool. Connect und ggf. Migration erfolgen derzeit vor dem transaktionalen `try/finally`; gesonderter Cleanup-Härtungspunkt, kein Nachweis der OAuth-Regressionsursache.
- `scripts/bootstrap-agent-runtime.ts`: eigener Prozess, importiert den Runtime-Pool; explizite Legacy-Lease wird im `finally` geschlossen. Ein Prozess-Exit/Idle-Abbau ist nicht mit explizitem `pool.end()` gleichzusetzen.
- `server/terminal-service.js` und `scripts/automation-scheduler.js`: kein eigener PG-Pool gefunden; Scheduler verwendet HTTP und beginnt nach Health-Erfolg.
- Weitere Factory-Aufrufer in `scripts/excalidraw-asset-collaboration-test.ts`, `scripts/excalidraw-agent-collaboration-test.ts` und `scripts/excalidraw-live-collaboration-test.ts` sind Test-Pools. Keine zusätzlich versteckte produktive `new Pool`-Stelle im gescannten Quellbaum gefunden.

Reproduzierbare Querprüfung (vom Repository-Root):

```sh
rg -n 'new Pool\\(|createPostgresPool\\(|getPostgresRuntimeQueryable\\(' app server lib scripts
rg -n 'openDb|from .*lib/db|from .*[/]db|import\\([^)]*[/]db' app server lib server.js scripts/bootstrap-agent-runtime.ts
```

## Vollständige erfasste Einstiegsliste

| Datei | Zugriff | Direkte openDb()-Aufrufe |
|---|---|---:|
| `app/api/account/email/route.ts` | Drizzle | 0 |
| `app/api/channels/telegram/bindings/route.ts` | Drizzle | 0 |
| `app/api/composio/webhook/route.ts` | Drizzle | 0 |
| `app/api/customers/route.ts` | Lease | 2 |
| `app/api/health/route.ts` | Lease | 1 |
| `app/api/license/status/route.ts` | Lease | 1 |
| `app/api/license/team/recovery/route.ts` | Lease | 1 |
| `app/api/memory/route.ts` | Lease | 1 |
| `app/api/mobile/v1/push-previews/studio/[ticket]/route.ts` | Drizzle | 0 |
| `app/api/onboarding/user-initialize/route.ts` | Drizzle | 0 |
| `app/api/projects/route.ts` | Lease | 2 |
| `app/api/sessions/messages/route.ts` | Drizzle | 0 |
| `app/api/sessions/route.ts` | Drizzle | 0 |
| `app/api/sessions/search/route.ts` | Drizzle | 0 |
| `app/api/studio/media/[...path]/route.ts` | dynamic | 0 |
| `app/api/studio/references/assets/route.ts` | Drizzle | 0 |
| `app/api/todos/assignees/route.ts` | Drizzle | 0 |
| `app/api/user-hints/route.ts` | Drizzle | 0 |
| `app/lib/agent-runtime-policy/agent-default-service.ts` | Lease | 1 |
| `app/lib/agent-runtime-policy/bootstrap-service.ts` | Lease | 1 |
| `app/lib/agent-runtime-policy/catalog-store.ts` | Lease | 3 |
| `app/lib/agent-runtime-policy/runtime-store.ts` | Lease | 11 |
| `app/lib/agents/access.ts` | Lease | 5 |
| `app/lib/agents/capability-bindings.ts` | Lease | 2 |
| `app/lib/agents/grants.ts` | Lease | 4 |
| `app/lib/agents/management-actions.ts` | Lease | 1 |
| `app/lib/agents/registry.ts` | Drizzle | 0 |
| `app/lib/agents/session-retention.ts` | Drizzle | 0 |
| `app/lib/agents/system-prompt.ts` | Drizzle | 0 |
| `app/lib/audit/audit-service.ts` | Drizzle | 0 |
| `app/lib/auth-setup.ts` | Lease | 2 |
| `app/lib/auth.ts` | Drizzle | 0 |
| `app/lib/automations/chat-targets.ts` | Drizzle | 0 |
| `app/lib/automations/integrity.ts` | Lease | 1 |
| `app/lib/automations/store.ts` | Drizzle | 0 |
| `app/lib/capabilities/catalog.ts` | Lease | 1 |
| `app/lib/capabilities/management-actions.ts` | Lease | 1 |
| `app/lib/capabilities/policy-store.ts` | Lease | 1 |
| `app/lib/channels/active-sessions.ts` | Drizzle | 0 |
| `app/lib/channels/channel-links.ts` | Drizzle | 0 |
| `app/lib/channels/channel-session-store.ts` | Lease | 1 |
| `app/lib/channels/session-resolver.ts` | Drizzle | 0 |
| `app/lib/channels/telegram/link-token.ts` | Drizzle | 0 |
| `app/lib/channels/telegram/session-resolver.ts` | Drizzle | 0 |
| `app/lib/chat/session-read-state.ts` | Drizzle | 0 |
| `app/lib/cleanup/orphaned-assets.ts` | Drizzle | 0 |
| `app/lib/collaboration/agent-operations.ts` | Lease | 10 |
| `app/lib/collaboration/agent-sagas.ts` | Lease | 5 |
| `app/lib/collaboration/connection-access.ts` | Drizzle | 0 |
| `app/lib/collaboration/document-location.ts` | Lease | 1 |
| `app/lib/collaboration/persistence.ts` | Lease | 9 |
| `app/lib/composio/composio-gateway.ts` | Drizzle | 0 |
| `app/lib/composio/composio-oauth-state.ts` | Lease | 3 |
| `app/lib/composio/composio-profiles.ts` | Lease | 1 |
| `app/lib/db/ensure-user.ts` | Drizzle | 0 |
| `app/lib/db/legacy-ai-tables.ts` | Lease | 1 |
| `app/lib/email/account-store.ts` | Drizzle | 0 |
| `app/lib/email/cache/store.ts` | dynamic | 0 |
| `app/lib/email/draft-store.ts` | Drizzle | 0 |
| `app/lib/email/inbox-attention.ts` | Drizzle | 0 |
| `app/lib/email/inbox-events.ts` | Drizzle | 0 |
| `app/lib/email/local-service.ts` | Drizzle | 0 |
| `app/lib/email/workspace-email-automation-events.ts` | Drizzle | 0 |
| `app/lib/email/workspace-inbox-outbox.ts` | Drizzle | 0 |
| `app/lib/email/workspace-mailbox-store.ts` | Drizzle | 0 |
| `app/lib/excalidraw-collaboration/agent-operations.ts` | Lease | 4 |
| `app/lib/excalidraw-collaboration/assets.ts` | Lease | 3 |
| `app/lib/excalidraw-collaboration/repository.ts` | Lease | 7 |
| `app/lib/file-guests/service.ts` | Drizzle | 0 |
| `app/lib/file-guests/versions.ts` | Drizzle | 0 |
| `app/lib/files/collaboration-repository/transaction.ts` | dynamic | 1 |
| `app/lib/files/upload-access-store.ts` | Lease | 3 |
| `app/lib/files/workspace-file-metadata.ts` | Lease | 1 |
| `app/lib/filesystem/workspace-trash.ts` | Drizzle | 0 |
| `app/lib/home/recent-chats.ts` | Drizzle | 0 |
| `app/lib/html-preview-ticket.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-aspect-ratio-service.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-bulk-service.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-generation-queue.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-generation-service.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-media-access.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-persona-service.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-preset-defaults.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-preset-service.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-product-service.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-style-service.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-usage-reporting.ts` | Drizzle | 0 |
| `app/lib/integrations/studio-workspace-file-migration.ts` | Drizzle | 0 |
| `app/lib/license/public-key.ts` | Drizzle | 0 |
| `app/lib/license/seat-limit.ts` | Lease | 2 |
| `app/lib/license/storage.ts` | Drizzle | 0 |
| `app/lib/license/team-license-lifecycle.ts` | dynamic | 0 |
| `app/lib/license/team-membership-sync.ts` | Lease | 1 |
| `app/lib/license/team-runtime-readiness.ts` | dynamic | 1 |
| `app/lib/license/team-seat-outbox-worker.ts` | Lease | 1 |
| `app/lib/license/team-seat-reconciliation.ts` | dynamic | 0 |
| `app/lib/mcp/apps-host.ts` | Drizzle | 0 |
| `app/lib/mcp/server/access-token-verifier.ts` | Lease | 1 |
| `app/lib/mcp/server/connection-management.ts` | Lease | 4 |
| `app/lib/mcp/server/oauth-client-maintenance.ts` | Lease | 1 |
| `app/lib/mcp/server/oauth-grant-revocation.ts` | Lease | 2 |
| `app/lib/mcp/server/oauth-page-query.ts` | Drizzle | 0 |
| `app/lib/mcp/server/readiness.ts` | Lease | 1 |
| `app/lib/mcp/server/request-history.ts` | Drizzle | 0 |
| `app/lib/mcp/server/workspace-access-policy.ts` | Lease | 5 |
| `app/lib/memory/approval-attention.ts` | Lease | 2 |
| `app/lib/memory/legacy-migration.ts` | Lease | 3 |
| `app/lib/memory/prompt-projection.ts` | Lease | 1 |
| `app/lib/memory/service.ts` | Lease | 35 |
| `app/lib/migration/inspect-service.ts` | Lease | 1 |
| `app/lib/mobile/app-badge.ts` | Drizzle | 0 |
| `app/lib/mobile/chat.ts` | Drizzle | 0 |
| `app/lib/mobile/inbox-counts.ts` | Drizzle | 0 |
| `app/lib/mobile/inbox.ts` | Drizzle | 0 |
| `app/lib/mobile/promotion-state.ts` | Drizzle | 0 |
| `app/lib/mobile/push-devices.ts` | Lease | 1 |
| `app/lib/oauth/store.ts` | Lease | 3 |
| `app/lib/onboarding/hint-state.ts` | Drizzle | 0 |
| `app/lib/onboarding/profile.ts` | Drizzle | 0 |
| `app/lib/onboarding/status.ts` | Drizzle | 0 |
| `app/lib/organization/membership-orchestrator.ts` | Lease | 10 |
| `app/lib/organization/membership-reactivation.ts` | Lease | 1 |
| `app/lib/organization/membership-seat-activation.ts` | Lease | 1 |
| `app/lib/organization/membership-seat-quote.ts` | Lease | 1 |
| `app/lib/organization/membership-suspension.ts` | Lease | 1 |
| `app/lib/organization/offboarding.ts` | Lease | 2 |
| `app/lib/organization/permissions.ts` | Lease | 1 |
| `app/lib/organization/policy-targets.ts` | Lease | 1 |
| `app/lib/organization/team-invitations.ts` | Lease | 6 |
| `app/lib/pi/delegate-task-tool.ts` | Drizzle | 0 |
| `app/lib/pi/delegation-policy.ts` | Drizzle | 0 |
| `app/lib/pi/delegation-store.ts` | Drizzle | 0 |
| `app/lib/pi/live-runtime.ts` | Drizzle | 0 |
| `app/lib/pi/session-compaction-store.ts` | Lease | 1 |
| `app/lib/pi/session-deletion.ts` | Drizzle | 0 |
| `app/lib/pi/session-fork.ts` | Drizzle, Lease | 1 |
| `app/lib/pi/session-runtime-access.ts` | Drizzle | 0 |
| `app/lib/pi/session-search-tool.ts` | Drizzle | 0 |
| `app/lib/pi/session-store.ts` | Drizzle, Lease | 3 |
| `app/lib/pi/session-title-generator.ts` | Drizzle | 0 |
| `app/lib/pi/session-workspace-context.ts` | Drizzle, Lease | 1 |
| `app/lib/pi/system-prompt-snapshot.ts` | Drizzle | 0 |
| `app/lib/pi/tool-output-maintenance.ts` | Drizzle | 0 |
| `app/lib/pi/usage-events.ts` | Drizzle | 0 |
| `app/lib/pi/usage-reporting.ts` | Drizzle | 0 |
| `app/lib/pi/workspace-email-tools.ts` | Drizzle | 0 |
| `app/lib/public-sharing/public-file-shares.ts` | Drizzle | 0 |
| `app/lib/security/public-rate-limit.ts` | dynamic | 0 |
| `app/lib/todos/email-notifications.ts` | Drizzle | 0 |
| `app/lib/todos/email-reply-tracking.ts` | Drizzle | 0 |
| `app/lib/todos/email-reply-watchers.ts` | Drizzle | 0 |
| `app/lib/todos/read-state-store.ts` | Drizzle | 0 |
| `app/lib/todos/reminders.ts` | Drizzle | 0 |
| `app/lib/todos/store.ts` | Drizzle | 0 |
| `app/lib/tool-apps/builtin-access.ts` | Drizzle | 0 |
| `app/lib/user-profile/service.ts` | Drizzle | 0 |
| `app/lib/workspaces/brand-profile-service.ts` | Lease | 8 |
| `app/lib/workspaces/legacy-recovery.ts` | Lease | 1 |
| `app/lib/workspaces/postgres-runtime.ts` | Lease | 15 |
| `scripts/bootstrap-agent-runtime.ts` | dynamic | 0 |
| `server.js` | require / Lease | 1 |
| `server/chat-event-bridge.ts` | Drizzle | 0 |
| `server/websocket-server.ts` | Drizzle | 0 |
