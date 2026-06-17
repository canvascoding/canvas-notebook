# Canvas Notebook Architecture Plan

Stand: 2026-06-17

Der aktive Architekturplan fuer den Team-Workspace-Umbau liegt im Unterprojekt:

- `team-workspace/00-full-plan.md`: vollstaendiger Team-Workspace-Plan mit festgehaltenen Nachtraegen.
- `team-workspace/01-inventory.md`: Inventar der bestehenden Workspace- und Dateiannahmen.
- `team-workspace/02-execution-model.md`: Arbeitsmodell mit Unterprojekten, Phasen und Test-Gates.
- `team-workspace/05-actor-audit-retention.md`: verbindliche Regeln fuer Actor Context, Audit, Retention und Storage-Wachstum.
- `team-workspace/06-workspace-switching-ux.md`: verbindliche Regeln fuer globales Workspace-Switching, Chat-Session-Wechsel und Agent-Kontext.
- `team-workspace/07-filesystem-migration-and-write-policy.md`: verbindliche Regeln fuer `/data`-Layout, Legacy-Migration, Studio-Copy, Exportrechte und Agent-Write-Gates.
- `team-workspace/08-user-scoped-secrets-runtime.md`: verbindliche Regeln fuer user-/organization-/system-scoped Secrets, MCP, Skills, Plugins, Mailboxen und Agent-Runtime.
- `team-workspace/09-initial-setup-and-update-migration.md`: verbindliche Regeln fuer Fresh Install, erstes Admin-/Owner-Setup, Onboarding und Update-Migration bestehender Instanzen.
- `team-workspace/10-agent-tool-execution-policy.md`: verbindliche Regeln fuer AgentExecutionContext, Tool-Capabilities, Cross-Workspace-Reads, Shell, MCP, Gateways und Revocation.
- `team-workspace/11-automation-execution-model.md`: verbindliche Regeln fuer Personal/Organization Automations, Service Actor, Workspace-Scope, Webhooks, Approval, Offboarding und Retry.
- `todo.json`: maschinenlesbarer Aufgabenindex ueber Notebook-, Control-Plane- und Cross-Repo-Aufgaben.

Dieses Unterprojekt ist bewusst getrennt, weil der Umbau Fresh Install, Update-Migration, Auth, Rollen, Workspaces, Agent-Dateioperationen, Tool-Capabilities, Credentials, MCP, Plugins/Skills, Public Links, Automations, Webhooks, Studio, Export/Import, Audit und Backup/Restore beruehrt.
