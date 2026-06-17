# Team Workspace Execution Model

Stand: 2026-06-17

## Ziel

Der Team-Workspace-Umbau soll nicht als ein grosser Change landen. Die Arbeit wird in stabile Unterprojekte aufgeteilt, die einzeln geplant, implementiert, getestet und committed werden koennen.

## Grundprinzipien

- Erst Datenmodell und serverseitige Rechte, dann UI.
- Erst Workspace-Service und Path-Security, dann Agent-Schreibzugriffe.
- Erst eindeutige Scopes, dann Migration bestehender Features.
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
- Kompatibilitaetsentscheidung fuer Legacy-Workspace `data/workspace`.

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
- Root-Boundary-Pruefung inklusive Symlink-Sicherheit.
- Legacy-Kompatibilitaet fuer bestehende `data/workspace`-Installationen.

Tests:

- Path-Traversal- und Symlink-Tests.
- File-Service-Tests fuer personal/team Roots.
- `npm run build`.

### P4 File-API und Workspace-UI

Zweck: Dateien im aktiven Workspace bedienen und sichtbar wechseln koennen.

Lieferumfang:

- File-Routen mit `workspaceId` oder serverseitig aktivem Workspace.
- File Browser zeigt aktiven Workspace.
- Workspace-Switcher.
- Kopieren zwischen Personal und Team Workspace.
- Public-Share-Anzeigen workspace-aware.

Tests:

- API-Integrationstests fuer list/read/write/copy/delete/rename.
- UI-Test nur nach Freigabe, da Workspace-Auswahl sichtbar ist.
- `npm run build`.

### P5 Agent Runtime und Agent-Dateioperationen

Zweck: Agenten arbeiten im aktiven Workspace, nicht im globalen Ordner.

Lieferumfang:

- PI Sessions speichern `workspaceId`.
- System-Prompt beschreibt aktiven Workspace statt hart `/data/workspace`.
- Agent File Tools erzwingen Workspace Root.
- Agent-Dateiaenderungen tragen `userId`, `sessionId`, `workspaceId`.
- Shell-/Tool-Ausfuehrungen koennen fremde Personal Workspaces nicht lesen.

Tests:

- Agent-File-Operation-Script-Tests.
- Tool-Registry-Tests fuer blockierte Writes.
- Session-Persistenz-Tests.
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
- Search/Retrieval-Vorbereitung.

Tests:

- Pro Feature eigene API-/Store-Tests.
- UI-Test nur bei sichtbaren UI-Aenderungen und nach Freigabe.
- `npm run build`.

### P7 Audit, Revisionen, Locks und Retention

Zweck: Team-Aenderungen nachvollziehbar und konfliktarm machen.

Lieferumfang:

- Audit Trail fuer Admin, Auth, Files, Agenten, Automations, Plugins, Integrationen, Export/Import und Studio.
- File-Revisions- oder Checkpoint-Modell.
- Einfache Locks oder Revision-Checks fuer Team-Dateien.
- Trash/Retention-Konzept.

Tests:

- Audit-Insert-Tests.
- Konflikt-/Locking-Tests.
- Regressionstests fuer Delete/Move/Public-Link-Sync.
- `npm run build`.

### P8 Export, Import, Backup und Restore

Zweck: Team-Instanzen sicher migrieren und wiederherstellen koennen.

Lieferumfang:

- Admin-only granularer Export.
- Organization/User/Workspace-Mapping im Manifest.
- Secret-Redaction und Reconnect-Strategie.
- Import Dry-Run.
- Restore einzelner Dateien/Ordner/Revisions.
- Backup-relevante Datenbereiche dokumentiert und technisch angebunden.

Tests:

- Export-/Import-Fixtures.
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
4. P4: File-API und UI-Switcher.
5. P5: Agent Runtime und Agent-Dateioperationen.
6. P6: Feature-Migrationen einzeln.
7. P7/P8: Audit, Revisionen, Export/Import, Backup/Restore.
8. P9: Hardening und Release Readiness.

## Naechster konkreter Schritt

Als naechstes sollte die Scope-Matrix entstehen. Sie muss jede bestehende Funktion einem Ziel-Scope zuordnen:

- `user`
- `workspace`
- `organization`
- `instance`
- `system/managed`

Diese Matrix entscheidet danach, welche Datenbankspalten, Services und API-Gates zuerst gebaut werden muessen.
