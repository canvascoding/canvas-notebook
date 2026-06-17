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
- Per-user Permissions fuer Team Workspace, Public Links, Team-Automations, Skill-/Plugin-Freigabe und Exporte.
- Serverseitige Admin-Gates.

Tests:

- Auth-/Setup-Script-Tests.
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

Tests:

- API-Integrationstests fuer list/read/write/copy/delete/rename.
- Store-/Component-Tests fuer globalen Workspace-Wechsel.
- Chat-Header-Test: Workspace-Wechsel startet neue Session oder setzt den Chat auf neue Session.
- Studio Save-to-Workspace-Test fuer Personal-Ziel, Team-Ziel und fehlende Team-Write-Permission.
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
- Agent-Dateiaenderungen tragen `userId`, `sessionId`, `workspaceId`.
- Shell-/Tool-Ausfuehrungen koennen fremde Personal Workspaces nicht lesen.
- Agent Runtime Resolver bekommt `organizationId`, `userId`, `workspaceId`, `sessionId` und `agentId`.
- Tool-Env und Credentials werden nur ueber den user-/organization-/system-scoped Secret Resolver injiziert.

Tests:

- Agent-File-Operation-Script-Tests.
- Tool-Registry-Tests fuer blockierte Writes.
- Secret-Resolver-Tests fuer blockierte fremde User-Secrets.
- Session-Persistenz-Tests.
- Tests fuer Workspace-Wechsel: neue Session im Ziel-Workspace, alte Session bleibt im Ursprungs-Workspace.
- Tests fuer blockierte Cross-Workspace-Writes und fremde Personal-Workspace-Reads.
- `npm run build`.

### P6 Feature-Migrationen nach Scope

Zweck: Bestehende fachliche Features auf user/workspace/organization/instance migrieren.

Teilbereiche:

- Public Links.
- Automations.
- Todos.
- Studio Assets, Produkte, Personas, Styles.
- Skills, Plugins und Agent-Definitionen.
- Composio, E-Mail-OAuth, Notifications und Channels.
- User-/Organization-/System-Secrets.
- MCP-Konfiguration und MCP-Transport-State.
- Search/Retrieval-Vorbereitung.

Tests:

- Pro Feature eigene API-/Store-Tests.
- E-Mail-Tests: User A kann User-B-Mailbox nicht senden, lesen oder als Draft-Ziel verwenden.
- MCP-/Plugin-/Skill-Tests: gleichnamige Konfigurationen bleiben pro User getrennt.
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
- Secret-Redaction und Reconnect-Strategie.
- Import Dry-Run.
- Restore einzelner Dateien/Ordner/Revisions.
- Backup-relevante Datenbereiche dokumentiert und technisch angebunden.

Tests:

- Export-/Import-Fixtures.
- Export-Permission-Tests fuer Personal, Team und Organization.
- Restore-Dry-Run-Tests.
- SQLite-Snapshot-Tests.
- `npm run build`.

### P9 Hardening und Release Readiness

Zweck: Teamfunktion stabil fuer Managed/Enterprise machen.

Lieferumfang:

- Migrationen fuer bestehende Single-User-Installationen.
- Performance- und Storage-Checks.
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
