# Canvas Notebook Architecture Plan

Stand: 2026-07-15

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
- `team-workspace/12-knowledge-ingestion-retrieval-policy.md`: verbindliche Regeln fuer automatische Knowledge-Ingestion, Docling-Abgleich, Secret-/PII-Scan, Knowledge Stores und Retrieval-ACLs.
- `team-workspace/13-resource-aware-ingestion-and-job-backpressure.md`: verbindliche Regeln fuer Resource Profile, Memory-/CPU-Grenzen, Queue-Backpressure, Degradation und Control-Plane-Metriken bei schweren Jobs.
- `team-workspace/14-public-links-and-studio-assets-policy.md`: verbindliche Regeln fuer Public Links, Latest-Verhalten, Passwortschutz-Vorbereitung, organizationweite Studio Assets und Save/Copy-to-Workspace.
- `team-workspace/15-export-import-backup-restore-policy.md`: verbindliche Regeln fuer Personal/Admin Export, Import-Mapping, Public-Link-Ausschluss, Full Backup, Restore und Verschluesselungsgrenzen.
- `team-workspace/16-offboarding-and-recovery-policy.md`: verbindliche Regeln fuer User-Archivierung, Offboarding-Preflight, Credential-Revocation, Automation-/To-do-Review und Personal-Workspace-Recovery.
- `team-workspace/17-database-provider-postgres-rag-collaboration-policy.md`: verbindliche Regeln fuer SQLite/Postgres-Provider, Postgres-Pflicht bei Team/Advanced/RAG, pgvector, Installer, Control Plane Provisioning, Migration und DB-aware Backup.
- `team-workspace/18-collaboration-and-file-conflict-policy.md`: verbindlicher Vollplan fuer echte Yjs-/Hocuspocus-Collaboration bei Markdown/Text, Postgres-State und Datei-Checkpoints, farbige Workspace-Presence im File Tree vor dem Oeffnen, paralleles User-/Agent-Co-Authoring mit dualer Attribution sowie Locks/Revisionen fuer Office/PDF/Assets.
- `team-workspace/19-agent-skill-creation-install-policy.md`: verbindliche Regeln fuer Agent-erstellte lokale Skills ueber dedizierte, validierende Install-Tools statt generischer Runtime-Dateiwrites.
- `team-workspace/20-organization-agent-provisioning-and-management-tools.md`: verbindliche Regeln fuer Personal-/Organization-Agenten, Grants an User/Rollen/Workspaces/Projekte, scope-aware Capability-Referenzen und Agent-Erstellung/-Bearbeitung durch den Standardagenten ueber ein eigenes Progressive-Disclosure-Gateway.
- `team-workspace/21-third-party-license-inventory-and-notices-policy.md`: verbindlicher Audit- und Release-Prozess fuer alle integrierten Drittanbieter-Komponenten, insbesondere vollstaendige MIT-Lizenz-/Copyright-Hinweise, Policy-Gates, Notices und CI-Drift-Schutz.
- `team-workspace/22-excalidraw-live-collaboration-policy.md`: implementierter separater Pfad fuer echte Excalidraw-Multi-User-Bearbeitung mit offiziellem elementweisen Reconciliation-Modell, Canvas-Auth/Presence/Postgres/Checkpoints, Asset-Pipeline, Agent-Review und UI-/E2E-Nachweis.
- `browser-desktop-plan.md`: optionaler, manuell bedienbarer grafischer Browser-Desktop als vom vorhandenen Puppeteer-Headless-Pfad getrennter Compose-Dienst; deckt Netzwerk-Egress, Auth-Proxy, Profilpersistenz, Managed- und Self-Hosted-Lifecycle sowie Ressourcen- und Sicherheitsgrenzen ab.
- `postgres-only-cli-installation-plan.md`: schrittweiser Plan fuer PostgreSQL-only Fresh Installs und Updates mit lokal verwaltetem oder extern gehostetem PostgreSQL, sicherer URL-Eingabe, Verbindungs-/pgvector-Preflight, fail-closed Entfernung von SQLite sowie Control-Plane-/Agent-Anpassungen.
- `memory-reviewer-admin-onboarding-plan.md`: verpflichtende organisationsweite Provider-/Modellwahl fuer den isolierten Memory-Reviewer im Administrator-Onboarding, Queue-Reaktivierung und reiner PostgreSQL-Schemamigrationspfad ohne SQLite-Abhaengigkeit.
- `electron-workspace-drive/README.md`: Einstieg in das Planungspaket fuer den bidirektionalen Electron Workspace Drive mit Hauptplan, V1-Pipeline und maschinenlesbarer Taskliste.
- `todo.json`: maschinenlesbarer Aufgabenindex ueber Notebook-, Control-Plane- und Cross-Repo-Aufgaben.

Dieses Unterprojekt ist bewusst getrennt, weil der Umbau Fresh Install, Update-Migration, Auth, Rollen, Workspaces, Agent-Dateioperationen, Tool-Capabilities, Credentials, MCP, Plugins/Skills, Knowledge/Retrieval, Database Provider, Public Links, Automations, Webhooks, Studio, Export/Import, Audit und Backup/Restore beruehrt.
