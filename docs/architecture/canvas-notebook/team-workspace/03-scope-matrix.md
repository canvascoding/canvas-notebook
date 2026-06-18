# Team Workspace Scope Matrix

Stand: 2026-06-17

## Zweck

Dieses Dokument schliesst Umsetzungsschritt 2 ab: bestehende Canvas Notebook Funktionen nach Ziel-Scope klassifizieren. Die Matrix ist die Grundlage fuer Datenmodell, API-Gates, Migrationen und Testplanung.

## Scope-Definitionen

| Scope | Bedeutung | Beispiele |
|---|---|---|
| `user` | Private Daten oder Einstellungen eines einzelnen Users. | E-Mail-Konto, User-Locale, persoenlicher Agent, privater Workspace. |
| `workspace` | Daten, die zu einem konkreten Arbeitsbereich gehoeren. | Datei, Public Link auf Datei, Agent-Dateiaenderung, Automation-Zielpfad. |
| `organization` | Teamweit geteilte Ressourcen und Governance. | Team Workspace, Rollen, Policies, Team-Studio-Bibliothek, Audit Trail. |
| `instance` | Technische Konfiguration der Notebook-Instanz. | Health Endpoint, lokale DB, Runtime-Verzeichnisse, Deployment Mode. |
| `system/managed` | Vom Control Plane oder Host verwaltete technische Ressourcen. | Managed License, Managed Provider Proxy, Instance Token, Host Metrics. |

## Matrix

| Bereich | Aktueller Scope | Ziel-Scope | Primaere Migration | Reihenfolge |
|---|---|---|---|---|
| Better Auth User | `user` mit globalem `role` Feld | `organization` Membership plus `user` Profil | Membership-/Role-Modell ergaenzen, Better Auth weiter nutzen | P2 |
| Sessions/Auth Accounts | `user` | `user`, optional `organization` Context | Session muss aktuelle Organization/Workspace aufloesen koennen | P2/P3 |
| Bootstrap Owner/Admin | `instance`, Bootstrap-E-Mail als Admin-Fallback | `organization` Owner/Admin, Community Single Admin, Personal Workspace und User Runtime Root | Initial Owner erzeugen, genau einen Owner und mindestens einen Admin erzwingen, scoped Roots anlegen | P2 |
| Onboarding | `instance` Completion plus `user` Hints | `user` Onboarding, `organization` Setup-/Review-State | Setup-State von User-Hints trennen; Legacy Review fuer Admins separat fuehren | P2 |
| Offboarding | nicht zentral modelliert | `organization` Workflow mit archiviertem `user` und Recovery-locked Personal Workspace | Preflight, Credential-Revocation, Automation-/To-do-Review, Personal-Workspace-Recovery mit Audit | P6/P7 |
| License Status | `instance` mit Plan `community/pro/managed` | `instance` Deployment Mode plus signierte Feature-/Quota-Claims | Deployment Modes und Team-Feature-Resolution einfuehren | P1 |
| Managed Control Plane Config | `system/managed` Env/Instance Token | `system/managed`, liefert Organization/License Claims | Notebook liest Claims, vertraut final nicht auf lokale Booleans | P1 |
| Database Provider | implizit SQLite unter `/data/sqlite.db` | `instance/system` Provider: SQLite fuer Community/Single-User, Postgres Pflicht fuer Team/Advanced/RAG | `CANVAS_DATABASE_PROVIDER` plus Lizenz-/Deployment-Gate einfuehren | P1/P8 |
| Postgres/pgvector Runtime | nicht vorhanden | `system/managed` DB-Service neben App-Container | Notebook CLI und Control Plane Provisioning erzeugen Compose/Secrets/Health fuer Postgres mit pgvector | P1/P8 |
| Workspace-Dateien | globaler `data/workspace` Ordner | `workspace` mit `personal/team/project` Typ | Workspace-Service, Root Resolver, Legacy-Kompatibilitaet | P3 |
| Workspace Filesystem Layout | implizit `data/workspace` | `/data/workspaces/personal/{userId}/files` und `/data/workspaces/team/{organizationId}/files` | DB-Workspace-Mapping plus physische Roots einfuehren | P3 |
| Legacy Workspace Migration | globaler Workspace wird weiterverwendet | Owner-Personal-Legacy-Import, Team Workspace initial leer | Keine automatische Team-Freigabe alter Daten | P3/P8 |
| Initial Setup Filesystem | Setup erstellt nur Auth-User | Erstes Setup erzeugt Organization, Owner, Personal Workspace, scoped User-/Org-/System-Roots | `/setup` und `bootstrap-admin` auf gemeinsamen Bootstrap-Service bringen | P2/P3 |
| File-API | Authenticated User, nur `path` | `workspace` plus User-Permissions | File-Routen auf WorkspaceContext umstellen | P4 |
| Globaler Workspace UI State | nicht vorhanden | `user` aktiver Workspace plus servervalidierte Berechtigungen | Workspace Store/Provider aus Server-Resolver initialisieren | P4 |
| Workspace Switcher | nicht vorhanden | globaler aktiver Workspace, sichtbar in Startseite, Chat und File Browser | Shared Switcher/Badge, Wechsel aktualisiert App-Kontext | P4 |
| File Browser UI | ein globaler Workspace | aktiver `workspace` pro User/UI State | Workspace-Switcher erst nach serverseitiger Isolation; Tree bei Wechsel neu laden | P4 |
| File Watcher/Cache/Search Cache | globaler Workspace Tree | `workspace`-spezifischer Cache | Cache Keys und Events um `workspaceId` erweitern | P4/P5 |
| Uploads/Attachments | globales `data/user-uploads` Intake | `user` Intake mit optionalem `workspace` Ziel | Upload-Metadaten und Copy-to-Workspace workspace-aware machen | P4/P6 |
| Public File Links | `workspacePath` plus `createdByUserId` | `organization`, `workspace`, `createdByUserId`, latest target | Personal Share fuer Owner; Team Share nur Admin/Permission; Latest-Link; Revocation bei Move/Delete; Passwortschutz spaeter | P6/P7 |
| Markdown/PDF/HTML Preview | globaler Workspace-Pfad | `workspace` Datei und Preview Policy | Preview-Token und Cache um Workspace erweitern | P4/P6 |
| Terminal Sessions | runtime/session-nah, potentiell globaler Prozesskontext | `user` Session mit aktivem `workspace` CWD/Policy | Terminal-CWD und erlaubte Pfade an Workspace koppeln | P5 |
| PI Chat Sessions | `user` plus `agentId` | `user`, `organization`, `workspace`, `agentId` | `workspaceId` an Sessions und Usage-Kontext ergaenzen; Workspace-Wechsel startet neue Session | P5 |
| PI Messages | Chat-Session | erbt Session-Scope | Keine eigene Workspace-Spalte zwingend, ueber Session relationieren | P5 |
| Agent System Prompt | global `/data/workspace` | aktiver Workspace der Session | Prompt aus WorkspaceContext generieren | P5 |
| Agent Execution Context | nicht zentral modelliert | serverseitige Capability pro Turn mit User, Workspace, Tools, Secrets, MCP und Revisions | `AgentExecutionContext` einfuehren und an Tool-Calls binden | P5/P7 |
| Agent File Tools | globaler Agent Workspace Root, absolute Pfade erlaubt | aktiver `workspace`, plus sichere Runtime-Ausnahmen | Resolver und Write-Gates vereinheitlichen | P5 |
| Cross-Workspace Agent Reads/Writes | nicht modelliert | Write nur Session-Workspace, Read nur explizit und berechtigt | Tool-Layer mit `writeWorkspaceId` und `readAllowedWorkspaceIds` | P5 |
| Agent Shell/Terminal Tools | Prozesskontext mit globalem Zugriffspotential | Session-Workspace-only, keine Cross-Workspace-ReadGrants | Shell-CWD, Env-Allowlist und Pfadblocker erzwingen | P5 |
| Agent Snapshots/Diffs | technische Snapshot-Metadaten ohne Actor-Scope | `user`, `session`, `workspace`, `agent` | Snapshot/Audit verknuepfen | P5/P7 |
| Agent Definitionen | globale `agents.agentId` | `user` Agenten plus `organization` Templates | Owner/Visibility/Template-Modell einfuehren | P6 |
| Agent Runtime Config | instanzweite Defaults/Agent Config | `organization` Defaults, `user` Preferences, `workspace` Policy, Session Override, mit sessiongebundener Revision | Effective Config Resolver mit `organizationId`, `userId`, `workspaceId`, `sessionId`, `agentId` erweitern | P5/P6 |
| Usage Events | `user`, `sessionId`, Provider/Model | `organization`, `user`, `workspace`, `session` | Usage Attribution erweitern | P5/P6 |
| Automations Jobs | `createdByUserId`, Pfade als Workspace-Strings | `personal` Owner-User oder `organization` Service Actor, genau ein primaerer `workspace` | OwnerScope, ServiceActor, WorkspaceScope, Team-Permission, Approval | P6 |
| Automations Runs | Job-basiert, Result-Pfade global | erbt Job plus Run-Audit | Run-Metadaten mit Workspace/Actor speichern | P6/P7 |
| Custom Webhooks | Job-basiert | Job/Organization Scope | Secrets und Permissions an Job-Scope koppeln | P6 |
| Automation Webhooks | Trigger ohne Team-Sicherheitsmodell | signiert, rate-limited, replay-geschuetzt, schema-validiert | Webhook Secret, Dedupe und Abuse Protection einfuehren | P6 |
| Todos | `user`-owned | `organization` mit `createdByUserId`, optional `assigneeUserId`, `workspaceId` | Assignment und Visibility-Modell | P6 |
| Todo Categories | `user` | `user`, optional Organization Defaults spaeter | Erst User-Scope beibehalten | P6 |
| Todo File Links | `user` plus `workspacePath` | `workspace` plus path, optional Revision | `workspaceId` hinzufuegen | P6 |
| E-Mail Accounts/OAuth | bereits `user` | `user`, optional Organization Team-Mailbox spaeter | User-Scope beibehalten, Managed/Gateway-Mail user-bound halten, Organization-Mailbox separat modellieren | P6 |
| E-Mail Drafts/Attachments | `user`, Account | `user`, optional `workspace` fuer Attachments | Attachment-Referenzen workspace-aware machen | P6 |
| Composio Identity/Connections | gemischt, teils User-ID/Fallbacks | `user` Connections, optional `organization` Connections | Connection-Scope und Audit erzwingen | P6 |
| MCP Config | instanzweite Settings-Datei | `user` Tool Stack plus `organization` erlaubte Defaults/Templates | Config-Schichtung einfuehren; Manager-Key um `organizationId` und `userId` erweitern | P6 |
| MCP Runtime/Transport State | geteilte Manager-Verbindungen nach Servername/Hash | `user` isolierte Verbindung, Cache, Logs und Tokens | Connection Pool und Env-Aufloesung user-aware machen | P6 |
| Skills | globales `data/skills` und globale Runtime Config | installierter Stack unter `/data/users/{userId}/skills`, `organization` Registry/Templates | Installationspfade/Registry nach Scope trennen | P6 |
| Plugins | globales `data/plugins` | installierter Stack unter `/data/users/{userId}/plugins`, `organization` Freigabe/Empfehlung | Plugin Registry, Config und Preflight user-aware machen | P6 |
| Integrations Env | globale `data/secrets/Canvas-Integrations.env` | `/data/users/{userId}/secrets`, `/data/organizations/{organizationId}/secrets`, `/data/system/secrets` | Secret Resolver mit Scope-Kaskade und Admin-Review fuer Legacy-Keys | P6 |
| User Preferences | JSON-Datei mit `users` Map | `user` | Beibehalten, optional DB-Migration spaeter | P2/P6 |
| Settings Storage | globale Dateien in `data/settings` | je Setting `user`, `organization`, `instance/system` klassifizieren | Settings nicht pauschal global weiterverwenden; User-Settings unter `/data/users/{userId}/settings` | P0/P6 |
| Notifications Summary | globaler Aggregator | `user`, Admin/Organization Alerts optional | Preferences und Channels trennen | P6 |
| Channel Bindings | `user` Channel Binding | `user`, Organization Channels fuer Team Alerts | User-Scope beibehalten, Org-Channels separat | P6 |
| Telegram Active Session | `user`, chat/session | `user`, optional Workspace-Session | Active Session mit WorkspaceContext verbinden | P5/P6 |
| Studio Produkte | `user` | `organization` Bibliothek mit `createdByUserId` und Visibility | Tabellen um Organization/Visibility erweitern | P6 |
| Studio Personas | `user` | `organization` Bibliothek mit `createdByUserId` und Visibility | analog Produkte | P6 |
| Studio Styles | `user` | `organization` Bibliothek mit `createdByUserId` und Visibility | analog Produkte | P6 |
| Studio Presets | default oder `user` | `user`, `organization` Templates, Defaults | Visibility/Template-Scope ergaenzen | P6 |
| Studio Generations | `user` | `organization`, `createdByUserId`, optional `workspaceId` | Organizationweit sichtbar; Creator-Filter; keine privaten Studio Generations | P6 |
| Studio Outputs/Assets Files | globale `data/studio/...` Pfade | `organization` Asset Store, optional Workspace-Verknuepfung | Organizationweite Asset-Sammlung, Creator bleibt erhalten, Offboarding loescht Assets nicht | P6 |
| Studio Save to Workspace | globaler Workspace, `targetPath` | expliziter `targetWorkspaceId` plus `targetPath` | Pflichtdialog fuer Personal/Team-Ziel und serverseitige Permission | P4/P6 |
| Studio References | globale Upload-/Reference-Bereiche | `user` Intake, `organization` Asset Visibility | Reference Ownership speichern | P6 |
| Personal Workspace Export | globaler Export/adminnah | User darf eigenen Personal Workspace exportieren | Self-service Export ohne Team-/Org-Daten und ohne Secrets | P8 |
| Migration Export | `instance` Komponenten | Admin-only `organization` Export mit User/Workspace/Reference Mapping | Public Links auslassen, Secrets redacted, Personal Workspaces nur expliziter Full/Admin Export | P8 |
| Migration Restore/Import | `instance` Restore | Organization/User/Workspace/Chat/Agent Mapping, Dry Run | Import Preview, unresolved References und Reconnect-Flows | P8 |
| Update-Migration File Formats | Legacy-Dateien werden beim Start teilweise kopiert | versionierte, idempotente Migration mit Owner-Aufloesung und Review-State | Migration State Manifest/DB-Tabelle, keine automatische Team-Aktivierung globaler Dateien | P8/P9 |
| Secrets Export | optional globale Secrets | redacted/reconnect/encrypted bewusst pro Scope | Keine Default-Klartext-Exports | P8 |
| QMD/Search/Retrieval | global `/data/workspace` Collection | getrennte Knowledge Stores fuer `personal_user`, `team_workspace`, optional `organization`; produktive Embeddings/RAG nur mit Postgres/pgvector | Collection Metadata, Secret-/PII-Scan, ACL-Filter, Provider-Gates und Delete-Propagation erzwingen | P6 |
| Docling Knowledge Ingestion | separater Plan, noch nicht team-scoped | automatische Ingestion mit lokalen Parsern, Scope-Metadaten und Scan vor Embedding | Docling-Plan mit Knowledge Policy verbinden | P6 |
| Knowledge Graph / Vektorindex | nicht vorhanden | Postgres/pgvector fuer produktive Team Knowledge, RAG und Graph-Metadaten | SQLite nur fuer Metadaten/einfache Suche; Team-RAG blockieren, wenn Postgres fehlt | P6/P8 |
| Resource Budget und Backpressure | nicht zentral modelliert | `instance/system`, mit Job-Scope fuer `user`, `workspace`, `organization` | Memory/CPU/Disk/Queue-Limits vor schweren Jobs pruefen; Degradation und Control-Plane-Metriken | P6/P9 |
| Knowledge/Parsing Settings | nicht vorhanden | `organization`/`instance`, Admin-only | Schwere Ingestion, Docling, OCR, Embeddings und Remote Parsing default `off`, aktivierbar im Settings UI | P6 |
| Heavy Job Operational Logs | nicht zentral modelliert | kurzlebiger technischer `instance/system` Scope mit Actor-/Job-Referenz | Resource-Entscheidung, Queue, Parser-Exit und Crash redacted loggen | P7/P9 |
| File Reference Ranking | globaler Workspace Tree | workspace-spezifisch | Ranking-Index pro Workspace | P4/P6 |
| Public Media Routes | Data-/Studio-Pfade | scoped Asset/File Access | Keine absoluten Serverpfade leaken | P6/P7 |
| Admin Cleanup | admin-only, Studio Assets global | `organization` Admin Operation | Admin-Gate plus Audit | P7 |
| Health Endpoint | `instance` | `instance/system` | Bleibt Instanz-Health fuer Control Plane | P9 |
| Runtime Data Paths | `instance` Data Root | `instance`, mit scoped Unterpfaden | Nicht alles unter Data Root fachlich global behandeln | P3/P6 |
| Backups | aktuell Migration/Filesystem-nahe | Full Instance Backup plus system-managed Host/Control-Plane Backup | SQLite Snapshot oder Postgres Dump/Snapshot plus `/data`, verschluesselt, extern triggerbar, Schedule vorbereitet | P8 |
| SQLite -> Postgres Migration | nicht vorhanden | provider-aware Maintenance Flow | SQLite-Snapshot, Postgres-Init, Datenkopie, Referenzpruefung, `requires_reindex` fuer Embeddings | P8/P9 |
| Audit Trail | nicht als zentrale Domain vorhanden | `organization` zentral, mit User/Workspace/Session | Audit-Domain einfuehren | P7 |
| Retention/Trash | geloeschte Dateien oft direkt entfernt | `organization` Policy, `workspace` Trash | Trash/Retention vor Team-Datei-Loeschung | P7 |
| Raw Tool/Runtime Logs | in Messages/Runtime-Events oder gar nicht zentral | kurzlebiger technischer Debug-Scope mit Retention | Nicht als dauerhafter Audit-Ersatz speichern; Summary/Hash/Ref behalten | P7 |
| Usage Rollups | Einzelereignisse mit User/Session | `organization`, `user`, `workspace`, `agent`, Zeitraum | Tagesrollups erzeugen und Einzelereignisse nach Retention bereinigen | P7/P9 |
| Storage Metrics | Host-/Control-Plane-nah, fachlich nicht aufgeteilt | `instance/system` plus Workspace-/DB-/Asset-Kategorien | DB, WAL, Workspace, Studio, Temp und Backups getrennt melden | P9 |
| Compute/Memory Metrics | Host-/Control-Plane-nah, nicht app-spezifisch | `instance/system`, mit Parser-/Queue-Status | RAM/CPU/Queue/Parser-Degradation melden und Alerts ausloesen | P9 |

## Kritische Abhaengigkeiten

1. `WorkspaceContext` muss vor Workspace-UI, Public Links, Automations und Agent-Dateioperationen stehen.
2. Rollen und per-user Permissions muessen vor Team-Workspace-Schreibzugriffen stehen.
3. Lizenz-/Deployment-Mode-Gates muessen vor sichtbaren Teamfunktionen stehen.
4. Team-/Advanced-/RAG-Features duerfen erst freigeschaltet werden, wenn Postgres/pgvector im Provider-Gate bestanden ist.
5. Public Links duerfen erst workspace-aware migriert werden, wenn Files eindeutig Workspace-Roots haben und Move/Delete-Revocation implementiert ist.
6. Agent-Dateioperationen duerfen erst auf Team-Workspaces schreiben, wenn absolute Pfade kontrolliert sind.
7. Studio darf erst organizationweit sichtbar werden, wenn `organizationId`, `createdByUserId`, Creator-Filter, Delete/Audit und Save/Copy-Zielauswahl umgesetzt sind.
8. Export/Import darf erst granular werden, wenn Daten `organizationId`, `userId` und `workspaceId` konsistent speichern.
9. Breiter Tool-/File-Audit darf erst umgesetzt werden, wenn Actor Context, Retention, Cleanup/Rollup und Storage-Monitoring mitgeplant sind.
10. Workspace-Wechsel darf laufende Agent-Sessions nicht stillschweigend migrieren; Chat-Wechsel startet eine neue Session.
11. `data/workspace` darf bei Migration nicht automatisch zum Team Workspace werden.
12. Agent-Dateitools duerfen nur in den Session-Workspace schreiben; fremde Personal Workspaces sind fuer Read und Write verboten.
13. Secrets, MCP, Skills, Plugins und Agent Runtime duerfen in Team-Instanzen nicht aus globalen Instanz-Dateien als aktive User-Konfiguration aufgeloest werden.
14. Fresh Install und Update-Migration muessen denselben scoped Zielzustand erzeugen; mehrdeutige Owner- oder Secret-Zuordnung stoppt mit Admin-Review.
15. Agent-Tools duerfen nur ueber einen serverseitig erzeugten Execution Context laufen; Tool-Parameter aus dem LLM sind untrusted.
16. Automations haben genau einen primaeren Workspace; Organization Automations laufen ueber Service Actor und brauchen Admin-Approval.
17. Knowledge-Ingestion darf nur nach Scope, Scan-Policy und Provider-Gate indexieren; Retrieval muss ACLs vor Rueckgabe erzwingen.
18. Offboarding darf Personal Workspaces nicht normal fuer Admins sichtbar machen; Zugriff nur ueber Recovery-Flow mit Audit.

## Migrationsreihenfolge fuer Datenmodell

1. Organization/Membership/Role/Permission Tabellen.
2. Bootstrap-/Migration-State fuer Fresh Install und Update-Migration.
3. Database Provider Gate und DB-Migration-State.
4. Workspace Tabelle und Legacy Workspace Mapping.
5. Workspace Resolver API und globaler Workspace UI State.
6. Filesystem-Layout unter `/data/workspaces/...` und Legacy-Import-Strategie.
7. `workspaceId` an PI Sessions, File/Public-Link-Metadaten und Automations.
8. Actor Context Resolver fuer Web, Gateways, Agent Runtime und Automations.
9. Secret-/Runtime-Resolver fuer User-, Organization- und System-Scopes.
10. Audit Event und Tool-Run Tabellen mit kleinen Metadaten, Hashes und Artefakt-Referenzen.
11. `organizationId` und `createdByUserId` an teamfaehige Feature-Tabellen.
12. Revision/Lock/Trash Tabellen.
13. Retention-/Cleanup-/Usage-Rollup-Jobs.
14. Export/Import Manifest-Version erhoehen.

## Minimaler V1-Scope

Fuer eine erste robuste Team-Version sollten diese Bereiche enthalten sein:

- Owner/Admin/Member Rollen.
- Fresh Install erzeugt sofort Organization, Owner, Personal Workspace und scoped User Runtime.
- Bestehende Single-User-Instanzen werden versioniert in denselben Zielzustand migriert.
- Personal Workspace pro User.
- Ein Team Workspace pro Organization.
- Globaler Workspace-Switcher auf Startseite, Chat Header und File Browser.
- Workspace-Wechsel im Chat startet eine neue Session im Ziel-Workspace.
- Copy Personal <-> Team als explizite Aktion.
- File-API serverseitig workspace-aware.
- Agent-Sessions und Agent-Dateioperationen im aktiven Workspace.
- Agent-Schreibzugriffe nur in den Session-Workspace; fremde Personal Workspaces komplett gesperrt.
- Agent-ExecutionContext fuer Tool-Allowlist, Cross-Workspace-Read-Grants, Secret-Refs und Revocation.
- Multi-File-Cross-Workspace-Reads fuer explizit ausgewaehlte Dateien/Ordner.
- Shell bleibt Session-Workspace-only.
- Studio Save-to-Workspace mit verpflichtender Zielauswahl fuer eigenen Personal Workspace oder berechtigten Team Workspace.
- User-scoped Secrets, MCP-Konfiguration, Skills, Plugins und Agent-Runtime-Einstellungen.
- E-Mail bleibt strikt user-scoped; Organization-Team-Mailboxen sind kein impliziter Fallback.
- Automatische Personal Knowledge und policy-gesteuerte Team Knowledge mit Secret-/PII-Scan vor Embedding.
- SQLite bleibt nur fuer Community/Single-User; produktive Team Knowledge, Embeddings, RAG und Knowledge Graph brauchen Postgres/pgvector.
- Public Links mit `workspaceId`, Latest-Verhalten und Deaktivierung bei Move/Delete.
- Audit fuer Admin-Aktionen, File Writes, Agent File Writes und Public Links, ohne grosse Payloads dauerhaft in der DB zu speichern.
- Retention Defaults fuer Raw Tool Payloads, Runtime Events, Trash/Revisions und Usage-Einzelereignisse.
- Export mindestens fuer Workspaces, DB, Audit und Team-relevante Metadaten mit Secret-Redaction.
- User-Self-Service-Export nur fuer den eigenen Personal Workspace.

Nicht zwingend fuer V1:

- External Users.
- Projekt-/Kunden-Workspaces.
- Echte Realtime Collaboration.
- Organization-geteilte Composio/E-Mail-Team-Mailboxen.
- Vollstaendige Skills-/Plugin-Registry pro Organization, solange globale Installation fuer Community/Legacy weiter existiert und Team-Gates restriktiv sind.

## Naechster Schritt

Nach dieser Matrix folgt die Datenmodell-Entscheidung fuer P0/P2/P3:

- Welche Better-Auth-Erweiterung oder eigene Membership-Tabellen werden genutzt?
- Wie wird `CANVAS_ORGANIZATION_ID` persistiert?
- Wie wird der Legacy-Workspace `data/workspace` beim ersten Team-Start gemappt?
- Welche Tabellen bekommen in der ersten Migration zwingend `workspaceId` und `organizationId`?
