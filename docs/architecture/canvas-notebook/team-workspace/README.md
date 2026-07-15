# Canvas Notebook Team Workspace

Stand: 2026-07-15

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
- `15-export-import-backup-restore-policy.md`: Personal/Admin Export, Import-Mapping, Public-Link-Ausschluss, Full Backup, Restore und Verschluesselungsgrenzen.
- `16-offboarding-and-recovery-policy.md`: User-Archivierung, Offboarding-Preflight, Credential-Revocation, Automation-/To-do-Review und Personal-Workspace-Recovery.
- `17-database-provider-postgres-rag-collaboration-policy.md`: SQLite/Postgres-Entscheidung, pgvector, RAG-/Collaboration-Gates, Installer, Control Plane Provisioning, DB-Migration und DB-aware Backup.
- `18-collaboration-and-file-conflict-policy.md`: vollstaendiger Ziel- und Ausfuehrungsplan fuer Yjs/Tiptap/CodeMirror/Hocuspocus, Postgres-Persistenz, Workspace-weite File-Tree-Presence vor dem Oeffnen, paralleles User-/Agent-Co-Authoring mit dualer Attribution, Checkpoints sowie Locks/Revisionen fuer Office/PDF/Assets.
- `19-agent-skill-creation-install-policy.md`: dedizierter Agent-Flow fuer validierte Skill-Erstellung und Installation ohne generische `/data/users/{userId}/skills`-Writes.
- `20-organization-agent-provisioning-and-management-tools.md`: Personal-/Organization-Agenten, Mitarbeiter-/Workspace-Zuweisung, scope-aware Skill-/Plugin-Abhaengigkeiten und vollwertige Agent-Erstellung/-Bearbeitung durch den Standardagenten ueber Progressive Disclosure.
- `21-third-party-license-inventory-and-notices-policy.md`: vollstaendiger Drittanbieter-/MIT-Lizenz-Audit, maschinenlesbares Inventar, ausgelieferte Notices und blockierender CI-Drift-Check.
- `22-excalidraw-live-collaboration-policy.md`: eigene Excalidraw-Scene-Collaboration ausserhalb von Aufgabe 48, inklusive Variantenvergleich, Canvas-native Empfehlung, Auth/Persistenz/Assets/Presence und Entscheidungstor.
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
- Export-/Import-/Backup-/Restore-Policy ist dokumentiert.
- Offboarding- und Recovery-Policy ist dokumentiert.
- Database-Provider-Policy fuer SQLite, Postgres, RAG, Collaboration, Installer und Control Plane ist dokumentiert.
- Collaboration- und File-Conflict-Policy fuer Text, Office/PDF und Assets ist dokumentiert und auf den aktuellen Foundation-Stand abgegrenzt.
- Revisionen, Locks, Konflikt-Guards und Yjs-Metadaten sind als Foundation umgesetzt; echte Yjs-Synchronisation, Hocuspocus, Awareness und File-Tree-Presence sind noch nicht implementiert.
- Der vollstaendige Folgeplan fuer Live-Collaboration inklusive farbiger aktiver Nutzer im File Tree ist in Aufgabe `48` erfasst.
- Agent Skill Creation und Install Policy fuer user-scoped lokale Skills ist dokumentiert.
- Organization Agent Provisioning und ein eigenes Progressive-Disclosure-Agent-Management-Toolset mit vollstaendiger UI-/API-Paritaet sind dokumentiert und in den Aufgaben `49` und `50` erfasst.
- Die Drittanbieter-/MIT-Lizenzinventur und eine verpflichtend mitausgelieferte Notice-Liste sind als eigene Aufgabe `51` geplant.
- Excalidraw-Live-Collaboration ist bewusst nicht Teil von Aufgabe `48`; sie ist mit einem vorgeschalteten Architektur-Spike und eigenem Scene-Provider als Aufgabe `52` geplant.
- Control-Plane-Status-Quo fuer Managed Env, Installer-Artefakte, VM-Agent, VM-Actions und VM-Detailseite ist in der Database-Provider-Policy mit konkreten Zielpfaden abgeglichen.
- Control Plane Managed Mode, Team-Claims, Managed ENV und Organization-Runtime-Provisioning sind umgesetzt und in PR #3 gemerged.
- Workspace-Modell, Workspace-Service, Bootstrap-Erzeugung und `/api/workspaces` in Canvas Notebook sind eingefuehrt.
- Community-/Single-User-Installationen bleiben auch bei gesetztem Team-Flag auf Personal Workspace begrenzt.
- Personal Workspaces werden pro User angelegt; Team Workspace wird nur in teamfaehigen Deployment Modes angelegt.
- Globaler Workspace-Switcher, Workspace-Badge, clientseitiger Workspace-Store und Chat-Neustart bei Workspace-Wechsel sind eingefuehrt.
- Kopieraktionen zwischen Personal und Team Workspace sind fuer File Browser und Studio-Importe umgesetzt.
- Agent-Runtime-Einstellungen und Agent-Sessions sind an User-/Workspace-Kontext gebunden.
- Live-Collaboration darf erst nach Abschluss der in `18-collaboration-and-file-conflict-policy.md` definierten Phasen als aktiv oder produktionsbereit ausgewiesen werden.
