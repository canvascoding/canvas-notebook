# FVRC-1008 – Härtung, Zwischenstand

Stand: 26. September 2026. Ausgangscommit: `83238a7e3`
(abgeschlossenes FVRC-1007). **FVRC-1008 ist in Arbeit, nicht abgenommen.**
Produktionsaktivierung und der manuelle Konflikteditor P12 sind nicht freigegeben.

## Bereits erneut geprüft

| Prüfung | Ergebnis | Nachweis und Grenze |
|---|---|---|
| Proposal-Toolverträge und Agentenadapter | Grün | `npm run test:proposal-graph:tools`, `/tmp/fvrc1008-tools-r1.log`; reale Facade-/Target-Logik, aber teilweise gemockte Auth-/Live-Grenzen und PGlite, kein gewöhnlicher LLM-/Browserlauf |
| Storage/Migration/Retention | Grün | `npm run test:proposal-graph:storage`, `/tmp/fvrc1008-storage-pglite-r1.log`; isoliertes PGlite |
| Storage/Migration und konkurrierende Aktionen auf PostgreSQL | Grün | `/tmp/fvrc1008-storage-postgres-r1.log`; PostgreSQL 18.4 auf 55433, getrennte Backend-Verbindungen, Lock-Timeout, CAS, dauerhafte Reservierung nach Connection-/Service-Neustart und Idempotenz |
| Review-Auswertung, Projektion und Compare-Verträge | Grün | `npm run test:proposal-graph:review-projection`, `/tmp/fvrc1008-review-projection-r1.log`; fokussierte Regression einschließlich des Managed-Runner-Vertrags, kein neuer vollständiger Browserlauf |
| Agent-Dauerhaftigkeit | Grün | `npm run test:collaboration:agent-durability`, `/tmp/fvrc1008-agent-durability-r1.log`; binäre Belege, Client-/Server-Bestätigungen, Reconnect und Rechteprüfungen |
| Agent-Poolkapazität nach Harness-Korrektur | Grün | `npm run test:collaboration:agent-capacity`, `/tmp/fvrc1008-agent-capacity-r2.log`; Kapazitätssuite und 5/5 Operation-Pooltests einschließlich negativem History-Capture-Fall |

Die PostgreSQL-Prüfung verwendete eine neu erzeugte, leere Datenbank im Namespace
`proposal_graph_test_fvrc1008_*`. Der Runner verweigert bestehende Tabellen und
prüft die Migration einschließlich Erhalt seiner eigenen Legacy-Fixtures.
Nach Abschluss wurde ausschließlich diese neu angelegte Testdatenbank gelöscht.
`canvas_notebook`, `canvas_control_plane`, der vorhandene Stack und Nutzerdokumente
wurden weder zurückgesetzt noch verändert. Dies belegt keinen Container-/Host-Crash.

## Bekannter Pooltest: Ursache und Korrektur

Der auf dem Vorgängerstand rote Test für zehn parallele reine Löschungen hatte
einen unvollständigen Testaufbau: Collaboration-Persistenz war simuliert, der
nachgelagerte `fileVersionHistoryService.capturePersistedCollaboration` dagegen
nicht. Der Test rief dadurch den echten History-/Datenbankpfad auf; dessen Fehler
wurde korrekt als unbestätigte Dauerhaftigkeit behandelt.

Die Korrektur ist auf `scripts/collaboration-agent-operation-pool-test.ts`
begrenzt. Die History-Grenze wird ausdrücklich simuliert und die übergebenen
Dokument-IDs, Sequenzen und Herkunft geprüft. Die ursprüngliche Erfolgsassertion
für alle zehn `persisted_yjs`-Ergebnisse bleibt unverändert. Ein zusätzlicher
Gegenfall prüft, dass ein fehlgeschlagener History-Capture weiterhin keinen
dauerhaften Erfolg meldet. Kein Anwendungscode und keine Persistenzprüfung
wurden abgeschwächt. Diese Simulation ersetzt keinen realen History-Integrationstest.

Zusätzlich geprüft: keine History-Sicherung vor bestätigter Yjs-Persistenz,
keine vorausgesetzte Ausführungsreihenfolge der zehn parallelen Captures,
verschachtelter Poolzugriff auch an der simulierten History-Grenze und Erhalt
der bereits persistierten Löschung im Fehlerfall. Typecheck, gezielter ESLint
und `git diff --check` bestanden. Für diesen reinen Test-/Dokumentationsfix war
kein neuer Anwendungsbuild nötig; der letzte erfolgreiche Produktbuild ist in
FVRC-1007 dokumentiert. Der lokale GitNexus-Index wurde nach einem internen
inkrementellen FTS-Fehler vollständig und erfolgreich neu aufgebaut.

Die finale GitNexus-Prüfung des Test-/Dokumentationscommits meldet niedriges
Risiko (vier Dateien, keine betroffenen Produktprozesse). Mit dem erneuerten
Index meldet der gesamte Branchvergleich zum älteren lokalen `main` dagegen
kritisches Risiko: darunter Graph-Apply, Review-Host und Berechtigungsflüsse aus
den vorherigen Änderungen. Diese wurden als relevante Folge-Gates eingeordnet;
der einzelne Testfix ist ausdrücklich keine Merge- oder Produktionsfreigabe.

## Offene Freigabegrenzen

- `assertProposalToolsEnabled` hält öffentliche Graph-Toolaufrufe weiterhin
  geschlossen. Der interne Runtime-Test ist deshalb kein Aktivierungsnachweis.
- `proposalReviewWritesEnabled` erlaubt Graph-Schreibtests nur in Development/Test
  mit lokalem Testschalter; Production bleibt geschlossen. Eine sichere
  serverseitige Ring-/Canary-Konfiguration samt Rücknahme muss vor Freischaltung
  implementiert und separat geprüft werden.
- Der neue Code wurde bisher am Host-Dev-Server auf **3000** geprüft. Der vorhandene
  Notebook-Container auf **3100** enthält nicht diesen Stand. Sein Neubau erfordert
  die ausdrücklich angefragte Freigabe; ein bloß gesundes altes Image zählt nicht.
- Noch erforderlich sind gewöhnliche Markdown-Text-/Blocktoolpfade, Altvorschläge,
  Feature-off, Rollout-/Rollback, vollständige PG-/MR-/zugeordnete CR-Matrizen und
  zwei vollständige UI-Läufe mit Commit-/Build-/Image-Zuordnung.
- Geschütztes Verweigern einer Aktion ist nur dann ein bestandener Test, wenn
  genau diese Verweigerung das vorab definierte Soll ist. Es ersetzt keinen
  erfolgreichen Mehrfach-Merge und keinen abschließenden manuellen Merge aus P12.

Der verbindliche Status bleibt in [todo.json](../../todo.json).

## Konkrete nächste Prüfschritte innerhalb FVRC-1008

1. PG-S01..34, PG-U01..12, MR-01..24 und die zugeordneten CR-Fälle einzeln
   mit festen Solltexten, Status, Revisionenzahl, Testebene und Evidence verbinden.
   Verwandte Testnamen ersetzen keine konkrete Szenariozuordnung.
2. Den gewöhnlichen Markdown-Text-/Blocktoolpfad ohne Runtime-Mock an den Graph
   anbinden und durch das Center prüfen. `editor-agent-review-lifecycle.spec.ts`
   verwendet bislang die Legacy-Accept-Route; die Graph-Suites erzeugen ihre
   Vorschläge bislang über dedizierte Fixtures. Beides separat weiter absichern.
3. Explizite Orakel für disjunkte Änderungen im selben Block (CR-03) und fehlende
   beziehungsweise verschiedene Basen (CR-18) ergänzen. Zwei-Prozess-Races,
   Crash-Grenzen, Retention während Apply und Notification-Ausfälle mit exakten
   Bytes und Revisionen prüfen; der oben genannte Connection-Neustart genügt nicht.
4. Serverseitige gemeinsame Ring-/Rollback-Absicherung für Tools, Review,
   Recovery und Propagation sowie redigierte Graph-Betriebsmetriken ergänzen.
   Bestehende Legacy-Guards und History-Rollouttests bleiben erhalten, belegen
   aber keine neue Graph-Freigabe mit offenen abhängigen Vorschlägen.
5. Nach genehmigtem Build/Recreate den vorhandenen Managed-Runner für zwei
   vollständige serielle Läufe verwenden. Commit, Build, URL, Fixture-IDs,
   Pflicht-Skips und Soll/Ist erfassen. Erst danach FVRC-1008 abschließen;
   Produktionsaktivierung bleibt eine separate Entscheidung.
