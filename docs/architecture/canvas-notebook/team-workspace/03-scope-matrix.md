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
| Bootstrap Owner/Admin | `instance`, Bootstrap-E-Mail als Admin-Fallback | `organization` Owner/Admin, Community Single Admin | Initial Owner erzeugen, genau einen Owner und mindestens einen Admin erzwingen | P2 |
| Onboarding | `instance` Completion plus `user` Hints | `user` Onboarding, `organization` Setup-State | Setup-State von User-Hints trennen | P2 |
| License Status | `instance` mit Plan `community/pro/managed` | `instance` Deployment Mode plus signierte Feature-/Quota-Claims | Deployment Modes und Team-Feature-Resolution einfuehren | P1 |
| Managed Control Plane Config | `system/managed` Env/Instance Token | `system/managed`, liefert Organization/License Claims | Notebook liest Claims, vertraut final nicht auf lokale Booleans | P1 |
| Workspace-Dateien | globaler `data/workspace` Ordner | `workspace` mit `personal/team/project` Typ | Workspace-Service, Root Resolver, Legacy-Kompatibilitaet | P3 |
| Workspace Filesystem Layout | implizit `data/workspace` | `/data/workspaces/personal/{userId}/files` und `/data/workspaces/team/{organizationId}/files` | DB-Workspace-Mapping plus physische Roots einfuehren | P3 |
| Legacy Workspace Migration | globaler Workspace wird weiterverwendet | Owner-Personal-Legacy-Import, Team Workspace initial leer | Keine automatische Team-Freigabe alter Daten | P3/P8 |
| File-API | Authenticated User, nur `path` | `workspace` plus User-Permissions | File-Routen auf WorkspaceContext umstellen | P4 |
| Globaler Workspace UI State | nicht vorhanden | `user` aktiver Workspace plus servervalidierte Berechtigungen | Workspace Store/Provider aus Server-Resolver initialisieren | P4 |
| Workspace Switcher | nicht vorhanden | globaler aktiver Workspace, sichtbar in Startseite, Chat und File Browser | Shared Switcher/Badge, Wechsel aktualisiert App-Kontext | P4 |
| File Browser UI | ein globaler Workspace | aktiver `workspace` pro User/UI State | Workspace-Switcher erst nach serverseitiger Isolation; Tree bei Wechsel neu laden | P4 |
| File Watcher/Cache/Search Cache | globaler Workspace Tree | `workspace`-spezifischer Cache | Cache Keys und Events um `workspaceId` erweitern | P4/P5 |
| Uploads/Attachments | globales `data/user-uploads` Intake | `user` Intake mit optionalem `workspace` Ziel | Upload-Metadaten und Copy-to-Workspace workspace-aware machen | P4/P6 |
| Public File Links | `workspacePath` plus `createdByUserId` | `organization`, `workspace`, `createdByUserId`, optional Revision | `workspaceId`, Access Policy, Revision-Pinning, Revocation | P6/P7 |
| Markdown/PDF/HTML Preview | globaler Workspace-Pfad | `workspace` Datei und Preview Policy | Preview-Token und Cache um Workspace erweitern | P4/P6 |
| Terminal Sessions | runtime/session-nah, potentiell globaler Prozesskontext | `user` Session mit aktivem `workspace` CWD/Policy | Terminal-CWD und erlaubte Pfade an Workspace koppeln | P5 |
| PI Chat Sessions | `user` plus `agentId` | `user`, `organization`, `workspace`, `agentId` | `workspaceId` an Sessions und Usage-Kontext ergaenzen; Workspace-Wechsel startet neue Session | P5 |
| PI Messages | Chat-Session | erbt Session-Scope | Keine eigene Workspace-Spalte zwingend, ueber Session relationieren | P5 |
| Agent System Prompt | global `/data/workspace` | aktiver Workspace der Session | Prompt aus WorkspaceContext generieren | P5 |
| Agent File Tools | globaler Agent Workspace Root, absolute Pfade erlaubt | aktiver `workspace`, plus sichere Runtime-Ausnahmen | Resolver und Write-Gates vereinheitlichen | P5 |
| Cross-Workspace Agent Reads/Writes | nicht modelliert | Write nur Session-Workspace, Read nur explizit und berechtigt | Tool-Layer mit `writeWorkspaceId` und `readAllowedWorkspaceIds` | P5 |
| Agent Snapshots/Diffs | technische Snapshot-Metadaten ohne Actor-Scope | `user`, `session`, `workspace`, `agent` | Snapshot/Audit verknuepfen | P5/P7 |
| Agent Definitionen | globale `agents.agentId` | `user` Agenten plus `organization` Templates | Owner/Visibility/Template-Modell einfuehren | P6 |
| Agent Runtime Config | instanzweite Defaults/Agent Config | `organization` Defaults, `user` Preferences, `workspace` Policy, Session Override | Effective Config Resolver erweitern | P5/P6 |
| Usage Events | `user`, `sessionId`, Provider/Model | `organization`, `user`, `workspace`, `session` | Usage Attribution erweitern | P5/P6 |
| Automations Jobs | `createdByUserId`, Pfade als Workspace-Strings | `user` oder `organization`, expliziter `workspace` | OwnerScope, WorkspaceScope, Team-Permission | P6 |
| Automations Runs | Job-basiert, Result-Pfade global | erbt Job plus Run-Audit | Run-Metadaten mit Workspace/Actor speichern | P6/P7 |
| Custom Webhooks | Job-basiert | Job/Organization Scope | Secrets und Permissions an Job-Scope koppeln | P6 |
| Todos | `user`-owned | `organization` mit `createdByUserId`, optional `assigneeUserId`, `workspaceId` | Assignment und Visibility-Modell | P6 |
| Todo Categories | `user` | `user`, optional Organization Defaults spaeter | Erst User-Scope beibehalten | P6 |
| Todo File Links | `user` plus `workspacePath` | `workspace` plus path, optional Revision | `workspaceId` hinzufuegen | P6 |
| E-Mail Accounts/OAuth | bereits `user` | `user`, optional Organization Team-Mailbox spaeter | User-Scope beibehalten, Organization-Mailbox separat modellieren | P6 |
| E-Mail Drafts/Attachments | `user`, Account | `user`, optional `workspace` fuer Attachments | Attachment-Referenzen workspace-aware machen | P6 |
| Composio Identity/Connections | gemischt, teils User-ID/Fallbacks | `user` Connections, optional `organization` Connections | Connection-Scope und Audit erzwingen | P6 |
| MCP Config | instanzweite Settings-Datei | `user` Tool Stack plus `organization` erlaubte Defaults | Config-Schichtung einfuehren | P6 |
| Skills | globales `data/skills` und globale Runtime Config | `user` installierter Stack, `organization` Registry/Templates | Installationspfade/Registry nach Scope trennen | P6 |
| Plugins | globales `data/plugins` | `user` installierter Stack, `organization` Freigabe/Empfehlung | Plugin Registry und Preflight user-aware machen | P6 |
| Integrations Env | globale `data/secrets/Canvas-Integrations.env` | User-, Organization- und Managed/System-Secrets | Secret Resolver mit Scope-Kaskade | P6 |
| User Preferences | JSON-Datei mit `users` Map | `user` | Beibehalten, optional DB-Migration spaeter | P2/P6 |
| Settings Storage | globale Dateien in `data/settings` | je Setting `user`, `organization`, `instance` klassifizieren | Settings nicht pauschal global weiterverwenden | P0/P6 |
| Notifications Summary | globaler Aggregator | `user`, Admin/Organization Alerts optional | Preferences und Channels trennen | P6 |
| Channel Bindings | `user` Channel Binding | `user`, Organization Channels fuer Team Alerts | User-Scope beibehalten, Org-Channels separat | P6 |
| Telegram Active Session | `user`, chat/session | `user`, optional Workspace-Session | Active Session mit WorkspaceContext verbinden | P5/P6 |
| Studio Produkte | `user` | `organization` Bibliothek mit `createdByUserId` und Visibility | Tabellen um Organization/Visibility erweitern | P6 |
| Studio Personas | `user` | `organization` Bibliothek mit `createdByUserId` und Visibility | analog Produkte | P6 |
| Studio Styles | `user` | `organization` Bibliothek mit `createdByUserId` und Visibility | analog Produkte | P6 |
| Studio Presets | default oder `user` | `user`, `organization` Templates, Defaults | Visibility/Template-Scope ergaenzen | P6 |
| Studio Generations | `user` | `organization`, `createdByUserId`, optional `workspaceId` | Team-Asset-Sammlung und Filter | P6 |
| Studio Outputs/Assets Files | globale `data/studio/...` Pfade | `organization` Asset Store, optional Workspace-Verknuepfung | Pfad-/Metadata-Scope ergaenzen | P6 |
| Studio Save to Workspace | globaler Workspace, `targetPath` | expliziter `targetWorkspaceId` plus `targetPath` | Dialog fuer Personal/Team-Ziel und serverseitige Permission | P4/P6 |
| Studio References | globale Upload-/Reference-Bereiche | `user` Intake, `organization` Asset Visibility | Reference Ownership speichern | P6 |
| Personal Workspace Export | globaler Export/adminnah | User darf eigenen Personal Workspace exportieren | Self-service Export ohne Team-/Org-Daten | P8 |
| Migration Export | `instance` Komponenten | Admin-only `organization` Export mit User/Workspace Mapping | Manifest und Component Paths erweitern; Team/Org Export permission-gated | P8 |
| Migration Restore/Import | `instance` Restore | Organization/User/Workspace Mapping, Dry Run | Import Preview und Reconnect-Flows | P8 |
| Secrets Export | optional globale Secrets | redacted/reconnect/encrypted bewusst pro Scope | Keine Default-Klartext-Exports | P8 |
| QMD/Search/Retrieval | global `/data/workspace` Collection | `organization`, `workspace`, optional `user`, Visibility | Collection Metadata und Zugriff pruefen | P6 |
| File Reference Ranking | globaler Workspace Tree | workspace-spezifisch | Ranking-Index pro Workspace | P4/P6 |
| Public Media Routes | Data-/Studio-Pfade | scoped Asset/File Access | Keine absoluten Serverpfade leaken | P6/P7 |
| Admin Cleanup | admin-only, Studio Assets global | `organization` Admin Operation | Admin-Gate plus Audit | P7 |
| Health Endpoint | `instance` | `instance/system` | Bleibt Instanz-Health fuer Control Plane | P9 |
| Runtime Data Paths | `instance` Data Root | `instance`, mit scoped Unterpfaden | Nicht alles unter Data Root fachlich global behandeln | P3/P6 |
| Backups | aktuell Migration/Filesystem-nahe | `organization` Backup plus system-managed Host Backup | Backup Manifest nach Scopes | P8 |
| Audit Trail | nicht als zentrale Domain vorhanden | `organization` zentral, mit User/Workspace/Session | Audit-Domain einfuehren | P7 |
| Retention/Trash | geloeschte Dateien oft direkt entfernt | `organization` Policy, `workspace` Trash | Trash/Retention vor Team-Datei-Loeschung | P7 |
| Raw Tool/Runtime Logs | in Messages/Runtime-Events oder gar nicht zentral | kurzlebiger technischer Debug-Scope mit Retention | Nicht als dauerhafter Audit-Ersatz speichern; Summary/Hash/Ref behalten | P7 |
| Usage Rollups | Einzelereignisse mit User/Session | `organization`, `user`, `workspace`, `agent`, Zeitraum | Tagesrollups erzeugen und Einzelereignisse nach Retention bereinigen | P7/P9 |
| Storage Metrics | Host-/Control-Plane-nah, fachlich nicht aufgeteilt | `instance/system` plus Workspace-/DB-/Asset-Kategorien | DB, WAL, Workspace, Studio, Temp und Backups getrennt melden | P9 |

## Kritische Abhaengigkeiten

1. `WorkspaceContext` muss vor Workspace-UI, Public Links, Automations und Agent-Dateioperationen stehen.
2. Rollen und per-user Permissions muessen vor Team-Workspace-Schreibzugriffen stehen.
3. Lizenz-/Deployment-Mode-Gates muessen vor sichtbaren Teamfunktionen stehen.
4. Public Links duerfen erst workspace-aware migriert werden, wenn Files eindeutig Workspace-Roots haben.
5. Agent-Dateioperationen duerfen erst auf Team-Workspaces schreiben, wenn absolute Pfade kontrolliert sind.
6. Studio darf erst organizationweit sichtbar werden, wenn Visibility und Delete/Audit geklaert sind.
7. Export/Import darf erst granular werden, wenn Daten `organizationId`, `userId` und `workspaceId` konsistent speichern.
8. Breiter Tool-/File-Audit darf erst umgesetzt werden, wenn Actor Context, Retention, Cleanup/Rollup und Storage-Monitoring mitgeplant sind.
9. Workspace-Wechsel darf laufende Agent-Sessions nicht stillschweigend migrieren; Chat-Wechsel startet eine neue Session.
10. `data/workspace` darf bei Migration nicht automatisch zum Team Workspace werden.
11. Agent-Dateitools duerfen nur in den Session-Workspace schreiben; fremde Personal Workspaces sind fuer Read und Write verboten.

## Migrationsreihenfolge fuer Datenmodell

1. Organization/Membership/Role/Permission Tabellen.
2. Workspace Tabelle und Legacy Workspace Mapping.
3. Workspace Resolver API und globaler Workspace UI State.
4. Filesystem-Layout unter `/data/workspaces/...` und Legacy-Import-Strategie.
5. `workspaceId` an PI Sessions, File/Public-Link-Metadaten und Automations.
6. Actor Context Resolver fuer Web, Gateways, Agent Runtime und Automations.
7. Audit Event und Tool-Run Tabellen mit kleinen Metadaten, Hashes und Artefakt-Referenzen.
8. `organizationId` und `createdByUserId` an teamfaehige Feature-Tabellen.
9. Revision/Lock/Trash Tabellen.
10. Retention-/Cleanup-/Usage-Rollup-Jobs.
11. Export/Import Manifest-Version erhoehen.

## Minimaler V1-Scope

Fuer eine erste robuste Team-Version sollten diese Bereiche enthalten sein:

- Owner/Admin/Member Rollen.
- Personal Workspace pro User.
- Ein Team Workspace pro Organization.
- Globaler Workspace-Switcher auf Startseite, Chat Header und File Browser.
- Workspace-Wechsel im Chat startet eine neue Session im Ziel-Workspace.
- Copy Personal <-> Team als explizite Aktion.
- File-API serverseitig workspace-aware.
- Agent-Sessions und Agent-Dateioperationen im aktiven Workspace.
- Agent-Schreibzugriffe nur in den Session-Workspace; fremde Personal Workspaces komplett gesperrt.
- Studio Save-to-Workspace mit Zielauswahl fuer eigenen Personal Workspace oder berechtigten Team Workspace.
- Public Links mit `workspaceId`.
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
