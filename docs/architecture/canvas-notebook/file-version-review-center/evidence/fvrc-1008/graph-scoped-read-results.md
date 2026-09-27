# Graph-Zulassung: verbindungsgebundene Leser als Vorstufe

Stand: 27. September 2026. **Vorstufe separat verifiziert; Graph-Zulassung bleibt offen.**
Quellbasis: `8548921a8` plus die mit diesem Nachweis committierten Änderungen.

## Befund und begrenzte Änderung

Eine Graph-Transaktion darf nicht erst eine Pool-Verbindung halten und dann
für Berechtigungen, Live-Zustand oder Operationsvorbereitung weitere
Verbindungen benötigen. Zehn wartende Transaktionen können sonst alle zehn
Poolplätze belegen, während die erste Transaktion keine Kapazität zum
Abschließen bekommt. Der persistente Admission-Guard darf diesen Fehler
nicht verschärfen.

Dieser Schritt stellt ausschließlich die dafür nötigen Leser bereit:

- `getAgentAccessOnConnection` und
  `readPostgresWorkspaceForActorOnConnection` verwenden die bereits
  bestehenden Regeln auf der übergebenen Verbindung. Die alten Wrapper
  behalten Besitz und Freigabe ihrer eigenen Verbindung sowie den
  Built-in-Agenten-Schnellpfad.
- `readStoredAgentWorkspaceOnConnection` bindet eine nicht archivierte
  Sitzung exakt an Nutzer, Agent und Workspace. Aktuelle Workspace-Rechte
  und Agentenzugriff werden über dieselbe Verbindung geprüft. Kein Default-
  Workspace, kein Bootstrap, keine Session-Snapshot-Schreiboperation und
  keine Brand-/Skill-Abfrage unter dem Graph-Lock. Eingaben und angeforderte
  Rechte werden vor dem ersten Await kopiert.
- `readCurrentCollaborationDocument` kann einen expliziten Zustandsleser
  des Transaktionsbesitzers verwenden. Der installierte Server-Reader
  behält Activity-Zulassung, aktive Dokumentidentität, Workspace-Prüfung
  und Live-Raum-Identitätsprüfung. Ohne Live-Raum wird genau der gelieferte
  persistierte Snapshot gelesen. Fehler fallen nicht auf eine andere
  Verbindung zurück. Alle bisherigen Aufrufer behalten den Standardpfad.

Es wurde noch kein Graph-Aufrufer auf diese APIs umgestellt. Insbesondere
ist dieser Schritt kein Nachweis für Graph-Admission, parallele Graph-
Transaktionen ohne Poolerschöpfung oder Mehrprozess-Owner-Aktivierung.

## Nächster, separat abzunehmender Integrationsschritt

1. `ProposalProvenanceDependencies.withTransaction` erhält expliziten Zweck
   `read` oder `create_operation`. Nur `create`/`createIndependent` sind
   Operationsanlage; `readExact` bleibt Lesen.
2. Runtime-lokale, wiedereintrittsfähige Storage-Datenbank verwendet dieselbe
   äußere SQL-Transaktion. Die Anlage erwirbt den Workspace-Admission-Guard
   vor Graph-, Lineage-, Dokument- und State-Zeilensperren. Keine zweite
   SQL-Transaktion und kein neuer Pfad-Advisory-Lock in diesem Abschnitt.
3. Alle Berechtigungsprüfungen nach einem Guard-Wait verwenden die neue
   verbindungsgebundene Autorisierung, keine bloß vorher gecachte Freigabe.
4. Live-Reads und `prepareProposalAgentOperation` lesen Zustand auf derselben
   Verbindung. Der Graph hält State bereits `FOR UPDATE`; kein separater
   Pool-Client wird ausgeliehen.
5. Nur ein neuer `insertPreparedOperation` verlangt die aktive lokale
   Anlageberechtigung und prüft persistente Admission direkt vor dem INSERT.
   Exakt nachgewiesene Wiederholungen bleiben unter Reservation lesbar und
   benötigen keinen heutigen Kandidaten oder Live-Read.
6. Operation, Proposal und neue Artefakte committen atomar; jeder fachliche
   Fehler rollt sie gemeinsam zurück. Ungewisse Commits niemals blind neu
   anlegen oder durch eine unbestätigte Verbindung als gescheitert behandeln.

Abnahmefälle für diesen Folgeschritt:

- Reservation zuerst: keine neue Operation, kein Proposal, keine Artefakte.
- Graph zuerst: Reservation wartet bis zum atomaren Commit.
- Handoff/State-Sperre in beiden Reihenfolgen; alte Generation bleibt ungültig.
- Exakter Retry während aktiver Reservation ohne neuen Kandidaten-/Live-Read.
- Sitzung oder Rechte während Guard-Wartezeit entzogen: Anlage verweigert.
- Ausgelasteter Pool mit konkurrierenden Graph-Transaktionen: null zusätzliche
  Leases unter der Graph-Transaktion, erfolgreiche Weiterarbeit statt Timeout.
- Fehler nach Vorbereitung: weder verwaiste Operation noch halbes Proposal.
- Team/Personal-Browserpfad einschließlich B/C-Konflikt und Sammelannahme.

`prepareProposalGraphActionOperation`, weitere Domainadapter, Owner/Fleet,
atomarer Kandidaten-Publish und P12 bleiben eigenständige offene Schritte.

## Verifikation dieser Vorstufe

- Scoped-Session-Harness: 16/16 einschließlich nachträglicher Eingabemutation.
- Document-Reader-Harness: 10/10 einschließlich falschem Scope, Archivierung,
  Fehlerweitergabe, Live-Bridge und Freigabe temporärer Yjs-Dokumente.
- Echter Hocuspocus-Testaufbau prüft installierten Reader: Live-Raum,
  persistierter Fallback, Dokument/Workspace/Generation, null zusätzliche
  Zustandsverbindung und unveränderter Standardleser.
- Graph-Tool- und vollständige Collaboration-Lifecycle-Suites: grün.
- Scoped-ACL: 2/2 Testgruppen mit dem echten Workspace-Permissions-Modul;
  bestehende Regeln für Built-ins, Legacy, persönliche Agenten,
  Direkt-/Rollen-/Workspace-/Projektgrants, falsche Organisation, fehlenden
  Agenten und entzogene Mitgliedschaften. Alte Wrapper und neue Leser liefern
  gleiche Ergebnisse; auch Fehler geben die eigene Verbindung korrekt frei.
- Workspace-Foundation und bestehender Session-Connection-Release-Test: grün.
- `npm run build`, vollständiger TypeScript-Check und gezieltes ESLint: grün.
- Browser auf aktuellem Host-Dev `127.0.0.1:3000`: gewöhnlicher B/C-Reviewpfad
  in Team (26,3 s) und Personal (16,1 s), jeweils 1/1 ohne Skips. Nach Annahme
  von C bleibt B mit konkretem Konflikt offen, ohne Timeline-Fehler. Beide
  Screenshots visuell geprüft. Diese Läufe prüfen die bestehenden Default-
  Aufrufer, nicht die noch ausstehende Graph-Admission-Anbindung.

Aktueller Build, TypeScript und Testgruppen haben jeweils Exit 0. Vor dem
Build wurde der beim Dev-Stop geleerte generierte Typcache nach
`/tmp/fvrc1008-scoped-dev-types.vtvOzf` gesichert; keine Quelldatei gelöscht.
Der erste Health-Probe fiel noch in den Serverstart; anschließend Health 200
und beide vollständigen Browserläufe erfolgreich. Container-Port 3100 bleibt
unverändert und ist nicht die Evidence für diesen Worktree.

GitNexus vor Commit: 14 erwartete Dateien. Die vorgelagerte Impact-Analyse
meldete kritische Reichweite der gemeinsamen Auth-/Dokumentleser; der
Gesamtvergleich mit `main` bleibt mit 320 Dateien/30 Prozessketten kritisch.
Die begrenzte Vorstufe ändert weder Berechtigungsregeln noch das Rollout-Gate.

Bekannte Test-Infrastrukturfehler: `npm run test:agent:access` und
`npm run test:organization:permissions` verweisen bereits auf die nicht
vorhandenen Dateien `scripts/agent-access-service-test.ts` bzw.
`scripts/organization-permission-guards-test.ts`.
Die fehlgeschlagenen Starts zählen nicht als bestandene ACL-Tests. Die neue
gezielte Suite und tatsächlich vorhandene Berechtigungstests werden getrennt
ausgewiesen; die veralteten Paketbefehle werden hier nicht umgedeutet.

Logs: `/tmp/fvrc1008-graph-scoped-*`; `reads-final.log` (28 gezielte Fälle),
`tools.log`, `lifecycle.log`, `workspaces.log`, `session-default.log`,
`build.log`, `types-final.log`, `lint.log`, `team.log` und `personal.log`.
HTML-Reports: `/tmp/fvrc1008-graph-scoped-team-report/` und
`/tmp/fvrc1008-graph-scoped-personal-report/`.
Keine Container-Recreation, kein Push,
keine Aktivierung. Der übergeordnete Status FVRC-1008 bleibt `in_progress`.
