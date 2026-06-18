# Canvas Notebook Team Workspace

Stand: 2026-06-17

Dieses Verzeichnis ist der zentrale Arbeitsbereich fuer den Team-Workspace-Umbau in Canvas Notebook.

## Dateien

- `00-full-plan.md`: vollstaendiger Plan aus der Control-Plane-Abstimmung mit festgehaltenen Nachtraegen.
- `01-inventory.md`: Ist-Inventar der aktuellen Datei-, Workspace- und Scope-Annahmen in diesem Repository.
- `02-execution-model.md`: Vorgehensmodell mit Unterprojekten, Reihenfolge, Commit-Strategie und Test-Gates.
- `03-scope-matrix.md`: Ziel-Scope-Matrix fuer bestehende Funktionen.
- `04-auth-roles-model.md`: Better-Auth-basiertes Organization-, Rollen- und Permission-Modell.
- `05-actor-audit-retention.md`: Actor Context, Audit-Modell, Retention und Storage-Wachstum.
- `06-workspace-switching-ux.md`: Globaler Workspace-Switcher, Chat-Session-Verhalten und Agent-Kontext.
- `07-filesystem-migration-and-write-policy.md`: Filesystem-Layout, Legacy-Migration, Studio-Copy-Ziele, Exportrechte und Agent-Write-Policy.
- `08-user-scoped-secrets-runtime.md`: User-/Organization-/System-Scope fuer Secrets, MCP, Skills, Plugins, Mailboxen und Agent-Runtime.
- `09-initial-setup-and-update-migration.md`: Fresh Install, erstes Admin-/Owner-Setup, Onboarding und Update-Migration bestehender Instanzen.
- `10-agent-tool-execution-policy.md`: Capability-Modell fuer Agent-Turns, Tool-Calls, Cross-Workspace-Reads, Shell, MCP, Gateways und Revocation.
- `11-automation-execution-model.md`: Personal/Organization Automations, Service Actor, Workspace-Scope, Webhooks, Approval, Offboarding und Retry.
- `12-knowledge-ingestion-retrieval-policy.md`: automatische Knowledge-Ingestion, Docling-Abgleich, Secret-/PII-Scan, Knowledge Stores und Retrieval-ACLs.
- `13-resource-aware-ingestion-and-job-backpressure.md`: Resource Profile, Memory-/CPU-Grenzen, Queue-Backpressure, Degradation und Control-Plane-Metriken fuer schwere Jobs.
- `14-public-links-and-studio-assets-policy.md`: Public-Link-Regeln, Latest-Verhalten, Passwortschutz-Vorbereitung, organizationweite Studio Assets und Studio-Copy-Zielauswahl.
- `../todo.json`: Aufgabenindex fuer Agenten und Fortschrittsverfolgung.

## Arbeitsregeln

- Nur ein Unterprojekt gleichzeitig aktiv bearbeiten.
- Keine UI bauen, bevor die serverseitige Isolation fuer den betroffenen Scope steht.
- Jede relevante Aenderung bekommt eigene Tests oder eine bewusst dokumentierte Testluecke.
- Vor Container-Builds immer `npm run build`.
- Container nur bauen, wenn es explizit gefordert ist.
- Fuer UI-Pruefungen vor Playwright/Browser-Automation explizit bestaetigen lassen, sofern die Aufgabe es nicht bereits verlangt.
- Nach abgeschlossenen sinnvollen Zwischenschritten committen, aber nicht pushen.

## Aktueller Stand

- Schritt 1 ist abgeschlossen: Ist-Inventar erstellt.
- Schritt 2 ist abgeschlossen: Scope-Matrix erstellt.
- Schritt 3 ist abgeschlossen: Rollenmodell festgelegt.
- Querschnittsentscheidung fuer Actor Context, Audit und Retention ist dokumentiert.
- Workspace-Switching-UX fuer Startseite, Chat, File Browser und Agent-Kontext ist dokumentiert.
- Filesystem-Migration und Agent-Write-Policy fuer Personal-/Team-Workspaces sind dokumentiert.
- User-scoped Secrets, Runtime, MCP, Skills, Plugins und Mailbox-Regeln sind dokumentiert.
- Initial Setup, Onboarding und Update-Migration bestehender Instanzen sind dokumentiert.
- Agent Tool Execution Policy mit Capability-Kontext, Cross-Workspace-Read-Regeln und Revocation-Verhalten ist dokumentiert.
- Automation Execution Model fuer Personal und Organization Automations ist dokumentiert.
- Knowledge-Ingestion- und Retrieval-Policy ist dokumentiert.
- Resource-aware Ingestion und Job Backpressure fuer kleine VMs ist dokumentiert.
- Public-Link- und Studio-Asset-Policy ist dokumentiert.
- Naechster Schritt: Initiales Admin-/Owner-Setup und Admin-only Gates absichern.
