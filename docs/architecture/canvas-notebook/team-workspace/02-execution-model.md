# Team Workspace Execution Model

Stand: 2026-06-17

## Ziel

Der Team-Workspace-Umbau soll nicht als ein grosser Change landen. Die Arbeit wird in stabile Unterprojekte aufgeteilt, die einzeln geplant, implementiert, getestet und committed werden koennen.

## Grundprinzipien

- Erst Datenmodell und serverseitige Rechte, dann UI.
- Erst Workspace-Service und Path-Security, dann Agent-Schreibzugriffe.
- Erst eindeutige Scopes, dann Migration bestehender Features.
- Erst Actor Context und Retention-Regeln, dann breiter Tool-/File-Audit.
- Workspace-Wechsel ist globaler UI-State, aber Agent-Sessions behalten ihren gespeicherten Workspace.
- Legacy-/Community-Betrieb muss waehrend der Migration weiter funktionieren.
- Jeder Schritt muss rueckbaubar oder klar eingegrenzt sein.
- Keine parallelen grossen Umbauten an Auth, Files und Agent Runtime im selben Commit.

## Unterprojekte

### P0 Programmfundament

Zweck: Plan, Inventar, Scope-Matrix und technische Entscheidungsdokumente stabilisieren.

Lieferumfang:

- Vollstaendiger Plan im Repo.
- Ist-Inventar.
- Scope-Matrix fuer bestehende Funktionen.
- Datenmodell-Entscheidungen fuer Organization, Workspace, Rollen und Permissions.
- Querschnittsentscheidung fuer Actor Context, Audit, Retention und Storage-Wachstum.
- Kompatibilitaetsentscheidung fuer Legacy-Workspace `data/workspace`.
- Querschnittsentscheidung fuer user-scoped Secrets, MCP, Skills, Plugins, Mailboxen und Agent Runtime.
- Querschnittsentscheidung fuer Fresh Install, Onboarding und Update-Migration bestehender Instanzen.
- Querschnittsentscheidung fuer Resource Profile, Backpressure und Degradation bei schweren Jobs.

Tests:

- Dokumente/JSON validieren.
- Kein Build erforderlich, solange nur Dokumentation geaendert wird.

### P1 Deployment Mode, Lizenz und Feature-Gates

Zweck: Community, managed-single, managed-team und enterprise-onprem technisch unterscheidbar machen.

Lieferumfang:

- Notebook-seitige Auswertung von `CANVAS_DEPLOYMENT_MODE`.
- Lizenzclaims fuer Teamfunktionen lesen und nicht nur Env-Booleans vertrauen.
- Single-User-Verhalten fuer Community absichern.
- Feature-Gates fuer Team-UI und Team-APIs vorbereiten.

Tests:

- Unit-/Script-Tests fuer License-Parsing und Feature-Resolution.
- `npm run build`.

### P2 Auth, Organization, Rollen und Permissions

Zweck: Better Auth als Grundlage fuer Owner/Admin/Member/External nutzen.

Lieferumfang:

- Organization-/Membership-Modell.
- Genau ein Owner.
- Mindestens ein Admin bleibt erhalten.
- Fresh Install erzeugt Organization, Owner Membership, Owner Permissions und Personal Workspace.
- `/setup` und `bootstrap-admin` fuehren zum gleichen Zielzustand.
- Unvollstaendige Bootstrap-Zustaende werden idempotent fertiggestellt.
- Per-user Permissions fuer Team Workspace, Public Links, Team-Automations, Skill-/Plugin-Freigabe und Exporte.
- Serverseitige Admin-Gates.

Tests:

- Auth-/Setup-Script-Tests.
- Fresh-Install-Test fuer `/setup` und `bootstrap-admin`.
- Idempotenztest fuer teilweise erstellte Bootstrap-Objekte.
- API-Tests fuer Admin-only Aktionen.
- `npm run build`.

### P3 Workspace-Domain und Path-Security

Zweck: Globalen Workspace durch Workspace-Service ersetzen.

Lieferumfang:

- `WorkspaceContext`.
- Personal Workspace pro User.
- Team Workspace pro Organization.
- Resolver fuer aktive Workspace-Auswahl.
- API fuer verfuegbare Workspaces und serverseitigen Default Workspace.
- Physisches `/data/workspaces/...`-Layout und Legacy-Migration aus `data/workspace`.
- Root-Boundary-Pruefung inklusive Symlink-Sicherheit.
- Legacy-Kompatibilitaet fuer bestehende `data/workspace`-Installationen.
- Update-Migration ordnet bestehendes `data/workspace` dem Owner-Personal-Workspace zu, nicht dem Team Workspace.

Tests:

- Path-Traversal- und Symlink-Tests.
- Legacy-Migrationstest: `data/workspace` wird nicht automatisch teamweit sichtbar.
- File-Service-Tests fuer personal/team Roots.
- `npm run build`.

### P4 File-API und Workspace-UI

Zweck: Dateien im aktiven Workspace bedienen und sichtbar wechseln koennen.

Lieferumfang:

- File-Routen mit `workspaceId` oder serverseitig aktivem Workspace.
- File Browser zeigt aktiven Workspace.
- Globaler Workspace Store/Provider.
- Shared `WorkspaceSwitcher` und `WorkspaceBadge`.
- Workspace-Switcher in Startseite, Chat Header und File Browser.
- Workspace-Wechsel im File Browser aktualisiert den globalen State und laedt den passenden Tree.
- Kopieren zwischen Personal und Team Workspace.
- Studio Save-to-Workspace Dialog fragt Personal- oder Team-Ziel ab und nutzt `targetWorkspaceId`.
- Public-Share-Anzeigen workspace-aware.
- Public Links auf Personal-Dateien sind fuer den Owner erlaubt; Team-Public-Links brauchen Admin oder `canCreatePublicLinks`.
- Public Links folgen der neuesten Dateiversion und werden bei Move/Delete deaktiviert.

Tests:

- API-Integrationstests fuer list/read/write/copy/delete/rename.
- Store-/Component-Tests fuer globalen Workspace-Wechsel.
- Chat-Header-Test: Workspace-Wechsel startet neue Session oder setzt den Chat auf neue Session.
- Studio Save-to-Workspace-Test fuer Personal-Ziel, Team-Ziel und fehlende Team-Write-Permission.
- Public-Link-Tests fuer Personal Share, Team Permission, Latest-Version und Deaktivierung bei Move/Delete.
- UI-Test nur nach Freigabe, da Workspace-Auswahl sichtbar ist.
- `npm run build`.

### P5 Agent Runtime und Agent-Dateioperationen

Zweck: Agenten arbeiten im aktiven Workspace, nicht im globalen Ordner.

Lieferumfang:

- PI Sessions speichern `workspaceId`.
- Neue PI Sessions erben den global aktiven Workspace.
- Workspace-Wechsel im Chat Header erzeugt eine neue Session im Ziel-Workspace.
- Bestehende PI Sessions behalten ihren gespeicherten Workspace und werden nicht stillschweigend migriert.
- System-Prompt beschreibt aktiven Workspace statt hart `/data/workspace`.
- Agent File Tools erzwingen Workspace Root.
- Agent File Tools erlauben Schreiben nur in den Session-Workspace.
- Optional erlaubte Cross-Workspace Reads muessen explizit referenziert und permission-geprueft sein.
- Cross-Workspace Reads duerfen mehrere explizit ausgewaehlte Dateien oder Ordner umfassen.
- Jeder Agent-Turn erzeugt einen serverseitigen `AgentExecutionContext`.
- Shell-/Terminal-Tools bleiben auf den Session-Workspace begrenzt und nutzen keine Cross-Workspace-Read-Grants.
- Agent-Dateiaenderungen tragen `userId`, `sessionId`, `workspaceId`.
- Shell-/Tool-Ausfuehrungen koennen fremde Personal Workspaces nicht lesen.
- Agent Runtime Resolver bekommt `organizationId`, `userId`, `workspaceId`, `sessionId` und `agentId`.
- Tool-Env und Credentials werden nur ueber den user-/organization-/system-scoped Secret Resolver injiziert.

Tests:

- Agent-File-Operation-Script-Tests.
- Tool-Registry-Tests fuer blockierte Writes.
- Secret-Resolver-Tests fuer blockierte fremde User-Secrets.
- ExecutionContext-Tests fuer Tool-Allowlist, Read-Grants und Revocation.
- Session-Persistenz-Tests.
- Tests fuer Workspace-Wechsel: neue Session im Ziel-Workspace, alte Session bleibt im Ursprungs-Workspace.
- Tests fuer blockierte Cross-Workspace-Writes und fremde Personal-Workspace-Reads.
- `npm run build`.

### P6 Feature-Migrationen nach Scope

Zweck: Bestehende fachliche Features auf user/workspace/organization/instance migrieren.

Teilbereiche:

- Public Links.
- Automations mit Personal/Organization Scope, Service Actor, Webhook-Sicherheit, Approval, Offboarding und Retry-Policy.
- Todos.
- Studio Assets, Produkte, Personas, Styles.
- Organizationweite Studio Assets mit Creator-Filter und ohne private Studio Generations.
- Skills, Plugins und Agent-Definitionen.
- Composio, E-Mail-OAuth, Notifications und Channels.
- User-/Organization-/System-Secrets.
- MCP-Konfiguration und MCP-Transport-State.
- Search/Retrieval-Vorbereitung.
- Resource Budget und Backpressure fuer Parsing, OCR, Embeddings, Reindex und schwere Background Jobs.
- Settings-Toggles mit Default-off fuer Knowledge Auto-Ingestion, Heavy Parsing, Docling, OCR, Embeddings und Remote Parsing.
- Strukturierte redacted Operational Logs fuer schwere Jobs.

Tests:

- Pro Feature eigene API-/Store-Tests.
- E-Mail-Tests: User A kann User-B-Mailbox nicht senden, lesen oder als Draft-Ziel verwenden.
- MCP-/Plugin-/Skill-Tests: gleichnamige Konfigurationen bleiben pro User getrennt.
- Automation-Tests fuer Personal vs Organization Scope, Webhook-Signatur, Rate Limits, Offboarding und Risk-Approval.
- Offboarding-Tests fuer Preflight, Credential-Revocation, Automation-/To-do-Review und Recovery-Flow fuer archivierte Personal Workspaces.
- Resource-Tests fuer Low-Resource-Profil, Queue-Backpressure, Parser-Timeouts und fehlende Embeddings bei nicht abgeschlossenem Scan.
- Settings-Tests: Default-off nach Fresh Install/Update, Aktivierung nur durch Admin/Managed Policy und korrektes Pausieren beim Ausschalten.
- Logging-Tests: Resource- und Parser-Logs enthalten Korrelation und `reasonCode`, aber keine Dokumentinhalte oder Secrets.
- UI-Test nur bei sichtbaren UI-Aenderungen und nach Freigabe.
- `npm run build`.

### P7 Audit, Revisionen, Locks und Retention

Zweck: Team-Aenderungen nachvollziehbar und konfliktarm machen.

Lieferumfang:

- Actor Context wird fuer Web, Gateways, Agent Runtime, Automations und Tool-Ausfuehrungen durchgereicht.
- Audit Events bleiben klein und referenziell; grosse Payloads werden nicht dauerhaft in der DB gespeichert.
- Tool-Run-Summaries werden getrennt von kurzlebigen Raw-Debug-Daten behandelt.
- Audit Trail fuer Admin, Auth, Files, Agenten, Automations, Plugins, Integrationen, Export/Import und Studio.
- File-Revisions- oder Checkpoint-Modell.
- Einfache Locks oder Revision-Checks fuer Team-Dateien.
- Trash/Retention-Konzept inklusive Cleanup- und Rollup-Jobs.
- DB-/WAL-/Runtime-Artefakte werden in Storage-Monitoring und Wartung beruecksichtigt.

Tests:

- Audit-Insert-Tests.
- Retention-/Cleanup-Tests fuer Raw Tool Payloads, Runtime Events und Trash.
- Usage-Rollup-Tests.
- Konflikt-/Locking-Tests.
- Regressionstests fuer Delete/Move/Public-Link-Sync.
- `npm run build`.

### P8 Export, Import, Backup und Restore

Zweck: Team-Instanzen sicher migrieren und wiederherstellen koennen.

Lieferumfang:

- Admin-only granularer Export.
- Self-service Export nur fuer den eigenen Personal Workspace.
- Team-/Organization-Export nur fuer Admins oder User mit Export-Permission.
- Organization/User/Workspace-Mapping im Manifest.
- Chat-/Session-/Agent-/Automation-/To-do-Referenzen im Manifest und Import-Dry-Run mappen.
- Public Links aus Migration Exports auslassen; im Zielsystem neu setzen.
- Secret-Redaction und Reconnect-Strategie.
- Import Dry-Run.
- Restore einzelner Dateien/Ordner/Revisions.
- Full Backup inklusive DB, Workspaces, Studio, Runtime, Secrets/OAuth verschluesselt und Public Links fuer Disaster Recovery.
- Backup-Trigger ueber Admin/API/CLI/Control Plane vorbereiten; taeglichen Schedule spaeter ermoeglichen.
- Verschluesselungsgrenzen dokumentieren: App-Exportrechte sind keine kryptografische Isolation gegen Root-/Container-Admins.
- Update-Migration bestehender Datei- und Runtime-Formate ist versioniert, idempotent und wiederaufnehmbar.

Tests:

- Export-/Import-Fixtures.
- Export-Permission-Tests fuer Personal, Team und Organization.
- Tests fuer Public-Link-Ausschluss in Migration Exports.
- Import-Dry-Run-Tests fuer User-/Workspace-/Chat-/Agent-Referenzen und `unresolved` Mapping.
- Restore-Dry-Run-Tests.
- Backup-Trigger- und Parallel-Run-Blocker-Tests.
- Update-Migrations-Fixtures fuer Single-User, eindeutigen Bootstrap-Admin und mehrdeutige Multi-User-Instanzen.
- SQLite-Snapshot-Tests.
- `npm run build`.

### P9 Hardening und Release Readiness

Zweck: Teamfunktion stabil fuer Managed/Enterprise machen.

Lieferumfang:

- Migrationen fuer bestehende Single-User-Installationen.
- Performance- und Storage-Checks.
- Memory-/CPU-/Queue-Checks und Control-Plane-Alerts fuer `resource_degraded`, `resource_critical` und `parser_disabled`.
- Security Review.
- Admin-Dokumentation.
- Release Notes.

Tests:

- `npm run test:all`, wenn fuer Release/Deploy relevant.
- Zusaetzlich UI- und E2E-Tests nach expliziter Freigabe.
- Kein Container-Build ohne ausdrueckliche Anforderung.

## Commit-Strategie

- Ein Commit pro abgeschlossenem Unterprojekt-Schritt oder pro klar testbarer Teilaufgabe.
- Keine gemischten Commits aus Schema, UI und Agent Runtime, wenn sie getrennt testbar sind.
- Dokumentation und Todo-Status im selben Commit aktualisieren, wenn sie direkt zum Schritt gehoeren.
- Vor jedem Commit: `git status --short` pruefen und nur eigene Aenderungen stagen.

## Test-Gates

Minimal je Change:

- Dokumentation: JSON/Markdown-Struktur pruefen, kein Build noetig.
- Reine Server-/API-Logik: relevante Script-/Integrationstests plus `npm run build`.
- Datenmodell/Migration: Migrationstest oder gezielte DB-Fixture plus `npm run build`.
- UI-Aenderung: `npm run build` plus Browser/Playwright-Pruefung nach Freigabe.
- Container: nur nach expliziter Anforderung, vorher immer `npm run build`, Container neu bauen/recreate und sicherstellen, dass kein alter Test-Container parallel laeuft.

## Empfohlene Reihenfolge

1. P0 abschliessen: Scope-Matrix und Datenmodellentscheidung.
2. P1/P2: Deployment Mode, Lizenz, Organization, Rollen und Permissions.
3. P3: Workspace-Service und Path-Security.
4. P4: File-API, globaler Workspace Store und UI-Switcher.
5. P5: Agent Runtime, Session-Workspace und Agent-Dateioperationen.
6. P6: Feature-Migrationen einzeln.
7. P7/P8: Audit, Revisionen, Retention, Export/Import, Backup/Restore.
8. P9: Hardening und Release Readiness.

## Naechster konkreter Schritt

Als naechstes sollte die Bootstrap-/Admin-Gate-Umsetzung vorbereitet werden. Sie muss festlegen:

- welche bestehenden `isAdminUser()`-Checks instanzweit bleiben,
- welche Checks auf Organization Role/Permission wechseln,
- wie der Erstnutzer Organization Owner wird,
- welche Tests Bootstrap, Owner-Invariant und Last-Admin-Schutz abdecken.

Das Rollenmodell in `04-auth-roles-model.md` ist die Grundlage dafuer.

Die Querschnittsentscheidung in `05-actor-audit-retention.md` ist verbindlich, sobald Agent-, Tool-, File-, Gateway-, Studio- oder Automation-Audit implementiert wird. Audit darf erst breit ausgerollt werden, wenn Actor Context, Retention Defaults, Cleanup/Rollup und Storage-Monitoring mitgeplant sind.

Die Workspace-Switching-Entscheidung in `06-workspace-switching-ux.md` ist verbindlich fuer Startseite, Chat Header, File Browser und Agent Runtime: Ein Wechsel an einer UI-Stelle aktualisiert den globalen aktiven Workspace, aber laufende oder historische Agent-Sessions behalten ihren gespeicherten `workspaceId`; ein Wechsel im Chat startet eine neue Session im Ziel-Workspace.

Die Filesystem- und Write-Policy in `07-filesystem-migration-and-write-policy.md` ist verbindlich fuer Workspace-Service, Studio Save-to-Workspace, Export/Import und Agent-Dateitools: Physische Roots werden nur ueber Workspace-Metadaten aufgeloest, bestehendes `data/workspace` wird nicht automatisch teamweit geteilt, und Agenten duerfen nur in den Session-Workspace schreiben.

Die Secret-/Runtime-Entscheidung in `08-user-scoped-secrets-runtime.md` ist verbindlich fuer Integrations-Env, Agent-Env, MCP, Skills, Plugins, E-Mail, Composio und Agent Runtime: Aktive Tool-Ausfuehrungen nutzen immer den Tool- und Secret-Scope des ausloesenden Users; Organization- und System-Secrets werden nur ueber explizite Policies injiziert.

Die Initial-Setup- und Update-Migrationsentscheidung in `09-initial-setup-and-update-migration.md` ist verbindlich fuer `/setup`, `bootstrap-admin`, Onboarding und bestehende Instanzen: Fresh Install und Migration muessen denselben Zielzustand erzeugen; globale Legacy-Dateien werden nicht automatisch als Team- oder Organization-Ressourcen aktiviert.

Die Resource-Entscheidung in `13-resource-aware-ingestion-and-job-backpressure.md` ist verbindlich fuer Knowledge-Ingestion, Docling/OCR, Embeddings, Reindex, Import/Export, Backup-Vorbereitung und Maintenance: Schwere Jobs starten nur mit Resource Budget; bei knappen Ressourcen wird deferiert oder degradiert statt die VM zu ueberlasten.

Die Settings- und Logging-Entscheidung ist Teil dieser Resource-Policy: Schwere Knowledge-/Parsing-Funktionen sind default `off`, muessen sichtbar aktivierbar/deaktivierbar sein und brauchen strukturierte redacted Logs fuer Diagnose.
