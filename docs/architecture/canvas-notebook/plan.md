# Canvas Notebook Architecture Plan

Stand: 2026-06-17

Der aktive Architekturplan fuer den Team-Workspace-Umbau liegt im Unterprojekt:

- `team-workspace/00-full-plan.md`: vollstaendiger Team-Workspace-Plan mit festgehaltenen Nachtraegen.
- `team-workspace/01-inventory.md`: Inventar der bestehenden Workspace- und Dateiannahmen.
- `team-workspace/02-execution-model.md`: Arbeitsmodell mit Unterprojekten, Phasen und Test-Gates.
- `team-workspace/05-actor-audit-retention.md`: verbindliche Regeln fuer Actor Context, Audit, Retention und Storage-Wachstum.
- `team-workspace/06-workspace-switching-ux.md`: verbindliche Regeln fuer globales Workspace-Switching, Chat-Session-Wechsel und Agent-Kontext.
- `team-workspace/07-filesystem-migration-and-write-policy.md`: verbindliche Regeln fuer `/data`-Layout, Legacy-Migration, Studio-Copy, Exportrechte und Agent-Write-Gates.
- `todo.json`: maschinenlesbarer Aufgabenindex ueber Notebook-, Control-Plane- und Cross-Repo-Aufgaben.

Dieses Unterprojekt ist bewusst getrennt, weil der Umbau Auth, Rollen, Workspaces, Agent-Dateioperationen, Public Links, Automations, Studio, Export/Import, Audit und Backup/Restore beruehrt.
