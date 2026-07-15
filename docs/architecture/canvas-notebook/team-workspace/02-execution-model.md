# Team Workspace Execution Model

Stand: 2026-07-13

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
- Querschnittsentscheidung fuer Database Provider, Postgres-Pflicht bei Team/Advanced/RAG, pgvector, Installer, Control Plane Provisioning und SQLite-zu-Postgres-Migration.
- Querschnittsentscheidung fuer Drittanbieter-Lizenzinventar, MIT-/Copyright-Notices, Policy-Overrides und Release-Drift-Gates.

Tests:

- Dokumente/JSON validieren.
- Kein Build erforderlich, solange nur Dokumentation geaendert wird.

### P1 Deployment Mode, Lizenz und Feature-Gates

Zweck: Community, managed-single, managed-team und enterprise-onprem technisch unterscheidbar machen.

Lieferumfang:

- Notebook-seitige Auswertung von `CANVAS_DEPLOYMENT_MODE`.
- Notebook-seitige Auswertung von `CANVAS_DATABASE_PROVIDER`.
- Lizenzclaims fuer Teamfunktionen lesen und nicht nur Env-Booleans vertrauen.
- Team-/Advanced-Features serverseitig blockieren, wenn `CANVAS_DATABASE_PROVIDER=sqlite` aktiv ist.
- Single-User-Verhalten fuer Community absichern.
- Feature-Gates fuer Team-UI und Team-APIs vorbereiten.
- Control-Plane- und Notebook-CLI-Installer-Anforderungen fuer Postgres/pgvector festlegen.
- Control-Plane-Agent-Migrationsassistent und VM-Detailseite fuer SQLite-zu-Postgres-Migration planen.

Tests:

- Unit-/Script-Tests fuer License-Parsing und Feature-Resolution.
- Tests fuer blockierte Team-/RAG-Features im SQLite-Mode.
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
- Public Links auf Personal-Dateien sind fuer den Owner erlaubt; Team-Public-Links brauchen Team-Workspace-Zugriff und `canCreatePublicLinks`, das fuer interne Team-User in V1 standardmaessig aktiv ist.
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
- RAG-/Embedding-/Knowledge-Graph-Features nur im Postgres-Mode freischalten; SQLite darf nur Metadaten, einfache Suche oder Prototypen tragen.
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
- CRDT/Yjs-Grundlage fuer Markdown/Text-Collaboration oder mindestens harte Revision-Checks fuer Autosave.
- Lock-/Check-out-Policy fuer Word, Excel, PowerPoint, PDF, Bilder, Videos und Audio.
- Trash/Retention-Konzept inklusive Cleanup- und Rollup-Jobs.
- DB-/WAL-/Runtime-Artefakte werden in Storage-Monitoring und Wartung beruecksichtigt.

Tests:

- Audit-Insert-Tests.
- Retention-/Cleanup-Tests fuer Raw Tool Payloads, Runtime Events und Trash.
- Usage-Rollup-Tests.
- Konflikt-/Locking-Tests.
- Markdown-Autosave-Konflikttests.
- Office/PDF/Binary-Lock-Tests.
- Regressionstests fuer Delete/Move/Public-Link-Sync.
- `npm run build`.

### P7b Echte Text-Collaboration und Workspace Presence

Zweck: Die in P7 vorbereiteten Revisionen, Locks, Yjs-Metadaten und Konflikt-Guards zu echter Real-Time Collaboration fuer Markdown/Text ausbauen.

Diese Phase beginnt erst, wenn P7 abgeschlossen ist. Ihre interne Reihenfolge ist verbindlich und wird nicht parallelisiert:

1. Postgres Collaboration Repository, binaerer Yjs-State, stabile Dokument-ID und Schema-Version.
2. WebSocket-Upgrade-Router und Hocuspocus unter `/ws/collaboration` mit Ticket-, Auth-, Permission- und Revocation-Flow.
3. Tiptap-`Y.XmlFragment`- und CodeMirror-`Y.Text`-Bindings; Whole-File-Autosave im Collaboration-Modus entfernen.
4. Materialisierte `.md`-/`.txt`-Checkpoints mit Revision, Audit, File Watcher, Public Links, Knowledge und Backup integrieren.
5. Workspace Presence Registry, Initial-Snapshot und Presence-Deltas fuer File Tree, List und Grid umsetzen.
6. Farbige User-Marker mit `viewing`/`editing`/`agent_editing`, dualer Agent-Attribution, Tooltip, `+N`, Light/Dark Mode und Accessibility integrieren.
7. Agent-/Automation-Direct-Connection, stabile Multi-Range-Zielanker, atomare Operationsgruppen, Overlap-/Rebase-/Race-Gates, persistierte idempotente Operationszustandsmaschine, Cancel/Restart-Recovery, Preflight, duale Attribution und revalidierten Review-Patch-Flow bauen.
8. Durability-Meilensteine, IME/Unicode/Boundary-Semantik, Encoding, GC/Compaction, Feedback-Loops, Limits/Fairness, Provider-Lifecycle, Datei-Generationen und Preview-Rollout hardenen.

File-Tree-Invariante:

- Ein User sieht aktive Bearbeiter bereits vor dem Oeffnen einer Datei.
- Der File Explorer tritt dafuer nicht dem Dokument-Room bei und wird nicht selbst als Viewer angezeigt.
- Die eigentliche Yjs-/Hocuspocus-WebSocket-Verbindung wird erst beim Oeffnen des Editors erstellt.
- Presence wird nur fuer berechtigte Pfade im aktiven Workspace ausgeliefert und bei Workspace-Wechsel vollstaendig verworfen.

Tests:

- Zwei-Client-Konvergenz fuer Tiptap und Raw Text.
- Offline-/Reconnect- und Server-Restart-Persistenztests.
- Ticket-, Permission-, Workspace-Isolation- und Revocation-Tests.
- Checkpoint-/Markdown-Roundtrip- und File-Watcher-Loop-Tests.
- Presence-Snapshot-/Delta-, Deduplizierungs-, Disconnect-/TTL-, Rename- und Workspace-Wechsel-Tests.
- File Tree zeigt User B bei User A vor dem Oeffnen, ohne User A dem Dokument-Room hinzuzufuegen.
- User A tippt manuell, waehrend ein explizit von User B beauftragter Agent einen anderen Absatz als zielverankerte Yjs-Transaktion aendert; beide Clients konvergieren und zeigen `Agent im Auftrag von User B`.
- Gleichzeitige inkompatible Aenderungen desselben Zielabschnitts wechseln auf `needs_review`; autonome Agent-Runs erhalten bei aktiven Menschen standardmaessig einen Review-Patch.
- Multi-Range-Test: Agent B zielt auf zwei getrennte Bereiche, waehrend User A einen oder beide Bereiche aendert; `all_or_nothing`, explizite unabhaengige Gruppen und `partially_applied` verhalten sich deterministisch.
- In-Flight-/Offline-Test: spaet eintreffende User-Aenderung an einem bereits angewendeten Agent-Ziel erzeugt einen sichtbaren `semantic_conflict` statt stiller Erfolgsmeldung.
- Idempotenz-/Parallel-Run-Test: Ein Retry desselben Auftrags wendet ihn genau einmal an; parallele Agenten werden serialisiert und ueberlappende Ziele nicht per Last-Writer-Wins entschieden.
- Cancel-/Recovery-Test: Cancel, Timeout, spaetes Ergebnis und Neustart koennen keinen terminalen oder bereits angewendeten Lauf blind erneut anwenden.
- Durability-Test: UI und State unterscheiden live angewendet, in Postgres persistiert und als Datei materialisiert; Store-Fehler erzeugt `degraded`.
- Review-/Preflight-Test: veraltetes Accept wird voll revalidiert; ungueltiges Schema, doppelte Stable IDs oder Operationen ausserhalb der Ziele erreichen den autoritativen Yjs-State nicht.
- Editor-Hardening-Test: Grenzassoziation, IME-Composition, Unicode-Grapheme, CRLF/BOM, Provider-Doppelmount und abgebrochener Modellstream verhalten sich deterministisch.
- Lifecycle-/Loop-Test: Delete/Restore/Schemawechsel invalidieren alte Runs; Checkpoint/File-Watcher/Knowledge/Automation erzeugen keinen kausalen Retrigger.
- Shell- und generische File-Write-Pfade koennen den Collaboration-Agent-Service nicht per Whole-File-Write umgehen.
- `npm run build`.
- Sichtbare UI-/E2E-Pruefung erst nach expliziter Freigabe.

Die vollstaendige technische Policy, Datenmodelle, UI-Regeln und Abnahmekriterien stehen in `18-collaboration-and-file-conflict-policy.md`.

### P7c Excalidraw Scene Collaboration

Zweck: `.excalidraw`-Dateien in Team Workspaces mit einer eigenen, zur offiziellen Excalidraw-Semantik kompatiblen Scene-Collaboration ausstatten, ohne sie in das Yjs-Textmodell von P7b zu pressen.

Diese Phase ist eine eigene Aufgabe `52` und beginnt mit einem verpflichtenden Architektur-Spike. Sie darf Querschnittsinfrastruktur aus P7b wiederverwenden, erweitert aber nicht den Scope von Aufgabe `48`.

Reihenfolge:

1. Zwei-Client-Spike fuer npm-API, `reconcileElements`, Undo/Redo, Bindings, Reihenfolge, Bilder, Reconnect und Fork-Vergleich.
2. Explizite Entscheidung fuer Canvas-nativen Scene-Provider oder dokumentierten Fork-Ausnahmefall.
3. Excalidraw-Provider/Document-Kind, Szenenrepository, Sequence, Tombstones und Asset-Referenzen in Postgres.
4. `excalidraw-v1` im gemeinsamen WebSocket-Router mit Ticket/Auth, Workspace-Permission, ACK/Resync, Limits und serialisierter Apply-Section.
5. Editor-Provider mit deaktiviertem Whole-File-Autosave, Remote-Reconciliation, Cursor/Selection und separater Binary-Asset-Pipeline.
6. Datei-Checkpoints, Revision, Public Preview, File Watcher, Presence, Backup/Restore und Lifecycle integrieren.
7. Mehrclient-, Offline-, Restart-, Security-, Last- und Upstream-Kompatibilitaetstests; stufenweises Feature-Gate.

Tests:

- Zwei-/Drei-Client-Konvergenz fuer verschiedene und gleiche Elemente.
- Loesch-, Undo/Redo-, Binding-, Group-, Frame- und Fractional-Index-Tests.
- Asset-Upload-/Download-/Reconnect-/Retention-Tests ohne wiederholte Data-URL-Full-Scene-Payloads.
- Ticket-, Workspace-Isolation-, Permission-Entzug-, Origin-, Schema- und Payload-Limit-Tests.
- Persistence-, ACK/Resync-, Server-Restart-, File-Checkpoint- und Backup/Restore-Tests.
- Nach expliziter Freigabe sichtbarer Multi-User-UI-/E2E-Test mit Playwright oder Chrome DevTools.
- `npm run build`.

Die vollstaendige Variantenbewertung und Zielpolicy steht in `22-excalidraw-live-collaboration-policy.md`.

### P8 Export, Import, Backup und Restore

Zweck: Team-Instanzen sicher migrieren und wiederherstellen koennen.

Lieferumfang:

- Admin-only granularer Export.
- Self-service Export nur fuer den eigenen Personal Workspace.
- Team-/Organization-Export nur fuer Admins oder User mit Export-Permission.
- Organization/User/Workspace-Mapping im Manifest.
- Export-/Import-Manifeste speichern `databaseProvider`, Schema-Version und Provider-Kompatibilitaet.
- Chat-/Session-/Agent-/Automation-/To-do-Referenzen im Manifest und Import-Dry-Run mappen.
- Public Links aus Migration Exports auslassen; im Zielsystem neu setzen.
- Secret-Redaction und Reconnect-Strategie.
- Import Dry-Run.
- Restore einzelner Dateien/Ordner/Revisions.
- Full Backup inklusive provider-spezifischer DB-Sicherung, Workspaces, Studio, Runtime, Secrets/OAuth und Public Links fuer Disaster Recovery.
- Postgres-Backups enthalten konsistenten DB-Dump bzw. Snapshot plus pgvector-/Extension-/Schema-Informationen; `/data` allein reicht im Postgres-Mode nicht.
- V1-Backup-Artefakte liegen lokal auf der VM und werden nicht automatisch verschluesselt.
- Backup-Trigger ueber Admin/API/CLI/Control Plane vorbereiten; V1 manuell, taeglichen Schedule spaeter ermoeglichen.
- Verschluesselungsgrenzen dokumentieren: App-Exportrechte sind keine kryptografische Isolation gegen Root-/Container-Admins.
- Update-Migration bestehender Datei- und Runtime-Formate ist versioniert, idempotent und wiederaufnehmbar.
- SQLite-zu-Postgres-Migration als eigener Maintenance-Flow mit Snapshot, Referenzpruefung, Provider-Wechsel und Reindex-Status.

Tests:

- Export-/Import-Fixtures.
- Export-Permission-Tests fuer Personal, Team und Organization.
- Tests fuer Public-Link-Ausschluss in Migration Exports.
- Import-Dry-Run-Tests fuer User-/Workspace-/Chat-/Agent-Referenzen und `unresolved` Mapping.
- Restore-Dry-Run-Tests.
- Backup-Trigger- und Parallel-Run-Blocker-Tests.
- Update-Migrations-Fixtures fuer Single-User, eindeutigen Bootstrap-Admin und mehrdeutige Multi-User-Instanzen.
- SQLite-Snapshot-Tests.
- Postgres-Backup-Tests fuer DB-Dump plus `/data`.
- SQLite-zu-Postgres-Migrations-Fixture mit Referenzpruefung und `requires_reindex`.
- Test fuer lokale unverschluesselte Backup-Warnung in Admin/Control Plane.
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
- Reproduzierbares Drittanbieter-Inventar und ausgelieferte Third-Party Notices fuer Source, Container, CLI/Installer und Electron.
- Blockierender Compliance-Check fuer fehlende, unbekannte, unreviewte oder gegenueber den Notices gedriftete Lizenzdaten.

Tests:

- `npm run test:all`, wenn fuer Release/Deploy relevant.
- Lizenzinventar-/Notice-Generator zweimal ausfuehren und Differenzfreiheit sowie Vollstaendigkeit in allen Release-Artefakten pruefen.
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
7. P7: Audit, Revisionen, Locks und Retention.
8. P7b: echte Text-Collaboration, Datei-Checkpoints, File-Tree-Presence und Agent-Patches.
9. P7c: separate Excalidraw-Scene-Collaboration nach abgeschlossenem Architektur-Spike.
10. P8: Export/Import und Backup/Restore inklusive Yjs- und Excalidraw-Szenenstate.
11. P9: Hardening und Release Readiness.

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

Die Database-Provider-Entscheidung in `17-database-provider-postgres-rag-collaboration-policy.md` ist verbindlich fuer Deployment Mode, Notebook CLI, Control Plane Provisioning, RAG/Embeddings, Collaboration und Backup: SQLite bleibt fuer Community/Single-User; Team/Advanced/RAG braucht Postgres mit pgvector und einen provider-aware Backup-/Migration-Flow.

Die Collaboration-Entscheidung in `18-collaboration-and-file-conflict-policy.md` ist verbindlich fuer P7b: Der Yjs-State ist waehrend aktiver Collaboration die schreibbare Wahrheit, Workspace-Dateien sind materialisierte Checkpoints, und der File Explorer erhaelt workspace-weite Presence ohne selbst Dokument-Rooms zu oeffnen.
