# FVRC-1008 – Härtung, Zwischenstand

Stand: 26. September 2026. Ausgangscommit der Härtung: `83238a7e3`
(abgeschlossenes FVRC-1007); Pool-Harness-Korrektur: `0b30dc785`.
**FVRC-1008 ist in Arbeit, nicht abgenommen.**
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

- Die zentrale workspacegebundene Policy unterstützt inzwischen `off`, `canary`
  und `full`; ohne Konfiguration bleibt sie geschlossen. Die lokale Testbrücke
  gilt nur in Development/Test und nur ohne expliziten Graph-Modus. Es wurde
  keine Runtime-Env geändert und keine Produktionsaktivierung vorgenommen.
- Neue Aktionen bleiben bei Abschaltung gesperrt. Vorhandene Status-/Recovery-
  Aufrufe sind davon getrennt, aber weiterhin an frische Rechte und eine exakte
  Actor-/Scope-/Key-/Digest-Identität gebunden. Die gewöhnliche Toolanbindung
  und ihre tatsächliche UI-Verifikation werden unten separat dokumentiert.
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

## Graph-Policy, Rücknahme und Betriebsdiagnose

Die [Rollout-Notiz](../../rollout-graph.md) beschreibt die neuen Gates. Ein
unbekannter Modus, ungültiger Workspace oder fehlerhafte Allowlist gibt nichts
frei. Die Canary-Policy vergleicht exakte Workspace-IDs statt Präfixen/Wildcards;
Autorisierung bleibt eine zusätzliche unabhängige Voraussetzung.

`npm run test:proposal-graph:review-actions` bestand nach Policy-/Recovery-
Integration (`/tmp/fvrc1008-review-actions-r4.log`). Der zusätzliche Race-Test
bestand anschließend mit insgesamt 13/13 Runtime-Fällen
(`/tmp/fvrc1008-recovery-race-r1.log`):

- Kein neuer Prepare/Execute/Transform und keine Reservierung bei geschlossenem
  Graph- oder FVRC-Schreibgate; vorhandene Session bleibt lesbar.
- Verlorene Apply-Antwort und neue Serviceinstanz bei abgeschalteten Gates:
  Wiederherstellung nur aus dauerhaftem Beleg, ein Apply-Aufruf, ein Ergebnis.
- Bereits reservierte Metadatenaktion kann abgeschlossen werden, aber weder
  fremder Digest noch entzogene Schreib-/Managerrechte können sie freigeben.
- Zwischen Status-Lookup und Recovery entzogene Managerrechte werden erneut
  geprüft. Ein nackter öffentlicher `recover(actionId)`-Zugang existiert nicht.

Dies sind Runtime-/Route-Tests mit kontrollierten Infrastrukturgrenzen. Eine
neue Serviceinstanz in einem Unit-Harness ist **kein** echter Prozess- oder
Containerneustart. Der Live-Rollbacktest bleibt offen.

`observeProposalGraph` protokolliert Auswertung, Aktion und Recovery mit festen
Statuswerten, bekannten Fehlercodes, Dauer sowie ausgewählter, erforderlicher
und anzuwendender Vorschlagsanzahl. Es werden keine IDs, Pfade, Inhalte, Hashes,
Tokens oder freien Fehlermeldungen aufgenommen. Die Zähler beschreiben die
bewertete Auswahl, nicht die Gesamtgröße eines eventuell paginierten Graphen.
Der gemeinsame Metrics-Adapter wird wiederverwendet; Logger-/Adapterfehler
ändern das fachliche Ergebnis nicht. `npm run test:proposal-graph:observability`
bestand einschließlich unbekannter Runtime-Enums und Redaktionsprüfungen.

## Szenarioabdeckung und gewöhnliche Tool-Browserläufe

Die neue [Szenariomatrix](./scenario-matrix.md) unterscheidet Abdeckung,
Teilabdeckung und fehlende Belege für alle PG-, MR- und zugeordneten CR-IDs.
CR-03 ist zusätzlich als echter Yjs-/Evaluator-Test umgesetzt: zwei unabhängige
authoritative Roots bearbeiten disjunkte Spannen desselben Textblocks;
A→B, B→A und gemeinsamer Batch ergeben exakt `A=10 B=20`, ohne dass die
Auswertung den Live-Zustand verändert. Überlappende Roots bilden den negativen
Kontrollfall. `review-projection` bestand danach vollständig
(`/tmp/fvrc1008-review-projection-r3.log`; Evaluator 13/13).

`tests/file-version-center-ordinary-tools.spec.ts` verwendet den tatsächlichen
`read`-/`edit_file`-Toolpfad und einen per API erzeugten Agent-Session-Kontext,
keine vorbereiteten Proposal-Knoten und kein LLM. Der erste Browserlauf auf
3000 (`/tmp/fvrc1008-ordinary-r1-report`) erreichte für zehn normale Agent-Edits
den exakten Endtext und vier Revisionen nach H→C→A plus Siebener-Batch. Er ist
trotzdem **rot**: Der abschließende identitätsgleiche Tool-Retry meldete den
bereits angenommenen Vorschlag noch als `reviewRequired: true`. Der Befund
lag in der Tool-Ergebnisprojektion; dieser Lauf zählt
nicht als vollständiger Abnahmenachweis.

Der korrigierte Lauf `ordinary-r2` bestand. Ein anschließender vollständiger
Tool-Regressionslauf fand aber eine zu großzügige Ergebnisprojektion bei
widersprüchlichen Eingaben. Deshalb erzwingt ein Proposal weiterhin Review,
außer wenn Operation-ID, terminaler Status, `changed === false`,
`reviewRequired === false` und `not_applied` den exakten unveränderten Retry
belegen. Fehlende Flags werden nicht als `false` interpretiert. Die ursprüngliche
Sicherheitsassertion wurde beibehalten, nicht abgeschwächt.

**Gewöhnlicher Browserlauf `ordinary-r3`: bestanden (58,3 Sekunden).**
Report: `/tmp/fvrc1008-ordinary-r3-report/index.html`, Log:
`/tmp/fvrc1008-ordinary-r3.log`. Der Test prüft:

- neues Dokument standardmäßig ohne Review; explizite Aktivierung im Editor;
- zehn unabhängige Vorschläge über echte gewöhnliche Tools ohne Proposal-Fixture;
- Annahme H→C→A, danach sieben gemeinsam; exakter Endtext und vier neue Revisionen;
- unveränderte IDs und keine zweite Änderung beim wiederholten ursprünglichen Tool-Aufruf;
- derselbe Retry in einem separaten echten Tool-Prozess mit Graph-Modus `off`;
- geänderte Payload mit derselben ID unter `off` ergibt `PROPOSAL_IDEMPOTENCY_MISMATCH`;
- kein zusätzlicher Inhalt/keine zusätzliche Revision, keine beobachteten Review-500/429.

Der Graph-off-Lookup prüft zuerst ausschließlich die gespeicherte Kombination
aus Dokument, auslösendem Benutzer und serverseitig abgeleitetem Retry-Key.
Erst bei einem Treffer folgen frische Actor-/Session-/Scope-/Digest-Prüfungen.
Unbekannte IDs führen weder zur Anlage eines leeren Graphen noch zur Adoption
fremder Vorgänge. Ein bekannter Graph-Retry darf nicht in den
Legacy-Erstellungspfad zurückfallen. Neue Graph-Aktionen bleiben geschlossen.
Die Server-Env blieb unverändert; dies ist kein Server-Neustart-/Live-Rollbacktest.
Die eigenen UUID-Testdateien und Agent-Sessions wurden jeweils per API entfernt.
Die Screenshot-Prüfungen von `ordinary-r2` und `ordinary-r3` bestätigen null offene Reviews sowie
Current und fünf Historieneinträge (ein Ausgangsstand plus vier Annahmen) ohne
Kartenüberlauf.

CR-18/CR-22 sind zusätzlich als Komponententests abgesichert: fehlender Inhalt,
unverifizierbare Legacy-Basis, echter Zwei-Vorschläge-Batchkonflikt und
Netzwerkausfall zeigen getrennte Meldungen, keine Accept-Aktion, keinen falschen
Null-Diff und keinen Legacy-Fallback. Aufklappen und Kopieren geben ausschließlich
die redigierte Diagnose aus. Dies ersetzt nicht die noch offene vollständige
Browsermatrix dieser Fehlerzustände.

Die abschließenden Suites `review-actions`, `review-ui` und `observability`
bestanden (`/tmp/fvrc1008-review-actions-final.log`,
`/tmp/fvrc1008-review-ui-final.log`, `/tmp/fvrc1008-observability-final.log`).
Der unabhängige Nachreview des Recovery-Race-Fixes fand keinen verbleibenden
konkreten Bypass; Recovery führt weiterhin nur Belegprüfung/Finalisierung aus,
keinen zweiten Live-Apply. Eine Rechteprüfung ist kein globaler Lock gegen
beliebige spätere Rechteänderungen.

Der ergänzende echte Browserlauf `recovery-r2` bestand in 8 Sekunden
(`/tmp/fvrc1008-recovery-r2-report/index.html`): Die Apply-Antwort wird nach
erfolgreicher dauerhafter Verarbeitung verworfen. Nach Schließen/Wiederöffnen
liefert die Statusabfrage denselben Beleg, ohne zweiten Apply-POST und mit genau
einer neuen Revision. Auch dieser Test simuliert Antwortverlust, keinen Host-Crash.

Die breite Approval-Suite fand einen veralteten Client-Test: Er erwartete bei
zwei Reviews eine automatische Auswahl des neuesten Vorgangs. FVRC-1007 und der
bereits geprüfte Editor-Browserfall verlangen stattdessen explizite Auswahl.
Nur dieses Oracle wurde korrigiert und um fehlendes `selectedEntry` sowie null
Approval-POSTs abgesichert. Die vollständige Suite besteht danach
(`/tmp/fvrc1008-agent-approval-explicit-selection.log`, 102 Tests in sechs
Teilreports). Kein Produktverhalten wurde für den Test abgeschwächt.

Die weitere breite Durability-/Strukturregression deckte außerdem eine echte
Graph-off-Kompatibilitätslücke auf: Ein unbekannter Tool-Retry durchlief bereits
die strenge Graph-Factory, obwohl der Legacy-Pfad zuständig war. Der vorhandene
Graph-Off-Browserfall mit bekanntem Retry konnte dies nicht finden. Die
Existenzprüfung wurde deshalb vor die Factory verschoben und gesondert geprüft;
erst ein Treffer durchläuft sämtliche Graph-Scope-/Actor-/Digest-Prüfungen.
Die roten Läufe bleiben unter `/tmp/fvrc1008-agent-durability-final.log` und
`/tmp/fvrc1008-agent-structure-final.log` nachvollziehbar und sind keine Freigabe.

Nach Korrektur bestehen beide vollständigen Suites sowie die vollständige
Tool-Suite: `/tmp/fvrc1008-agent-durability-r3.log`,
`/tmp/fvrc1008-agent-structure-r3.log`, `/tmp/fvrc1008-tools-r4.log`.
Der Legacy-Harness prüft explizit einen ausgeführten read-only Probe und null
Graph-Factory-Aufrufe. Die echten Runtime-/SQL-Tests prüfen bekannte und
unbekannte Keys ohne zusätzliche Graph-Metadaten; ihre Datenbankebene ist PGlite.

**Finaler Tool-Browserlauf `ordinary-r4`: bestanden (56,5 Sekunden)**,
`/tmp/fvrc1008-ordinary-r4-report/index.html` und `/tmp/fvrc1008-ordinary-r4.log`.
Er wiederholt nach der letzten Produktkorrektur alle oben genannten Orakel
einschließlich des bekannten Graph-off-Retries mit der echten PostgreSQL-Instanz.
Diese wiederholten Einzeltests sind weiterhin keine zwei vollständigen
FVRC-1008-Matrixläufe.

Der Policy-/Recovery-/Diagnose-Teil ist als `8f919dbe3` separat committed.
Vor diesem Commit: GitNexus staged 19 Dateien/66 Symbole, Risiko niedrig;
alle Änderungen: Risiko hoch (Agent-Edit-Pfade). Der Branchvergleich zum
älteren lokalen `main` umfasst 147 Dateien/1056 Symbole/27 Prozesse und ist
kritisch eingestuft. Das betrifft auch die früheren Graph-Apply-, UI- und
Berechtigungsänderungen und ist ausdrücklich keine Produktionsfreigabe.

## Abschließender Stand dieser Implementierungsrunde

- Produktcode unverändert seit `ordinary-r4`; der erneute Produktionsbuild
  bestand mit 353/353 Seiten (`/tmp/fvrc1008-build-r2.log`, Build-ID
  `build-TfctsWXpff2fKS`). Für diesen Host-Build wurden nur öffentliche lokale
  Base-URLs gesetzt, keine Runtime-Env-Dateien verändert. 31 Turbopack-
  Filesystem-Tracing-Warnungen betreffen in dieser Runde unveränderte Dateien;
  der Build war erfolgreich. Der vorgelagerte Lizenzcheck meldete null Blocker.
- `npx tsc --noEmit` und der Build-Typecheck bestanden. Repository-ESLint hat
  null Fehler/sieben Warnungen in unveränderten Dateien; alle geänderten Dateien
  sind im abschließenden fokussierten ESLint warnungsfrei
  (`/tmp/fvrc1008-changed-lint-final.log`). `git diff --check` bestanden.
- Browserbasis: Commit `8f919dbe3` plus der nachfolgend committete Tool-Patch.
  SHA-256 von `git diff --cached -- app scripts tests package.json` vor diesem
  Commit: `ae07083c7cae06a78f577128a887ed139b33491a0fbd29eb51c1b1fca190344e`.
  Browser-URL: `http://127.0.0.1:3000`; PostgreSQL 18.4/pgvector 0.8.3 aus dem
  einzigen verwalteten Stack. Keine Aussage über das alte Image auf 3100.
- Finale GitNexus-Prüfung des Tool-/Test-/Evidence-Commits: 22 Dateien,
  112 Symbole, sieben betroffene Agent-Edit-Prozesse, Risiko hoch. Gesamter
  Branchvergleich: 154 Dateien/1093 Symbole/27 Prozesse, kritisch. Die
  Pfad-/Actor-/Workspace-Grenzen wurden anhand des Codes und der breiten
  Tool-, Replay-, Approval- und Durability-Suites geprüft. Der unabhängige
  Nachreview fand keinen konkreten Bypass im neuen No-hit-/Retry-Pfad.
- Keine Container erstellt, ersetzt oder gelöscht; kein Push und keine
  Produktionsaktivierung. FVRC-1008 bleibt offen, P12 wurde nicht begonnen.

## Konkrete nächste Prüfschritte innerhalb FVRC-1008

1. PG-S01..34, PG-U01..12, MR-01..24 und die zugeordneten CR-Fälle einzeln
   mit festen Solltexten, Status, Revisionenzahl, Testebene und Evidence verbinden.
   Verwandte Testnamen ersetzen keine konkrete Szenariozuordnung.
2. Den nun angebundenen und erfolgreich geprüften gewöhnlichen Texttoolpfad um
   die verbleibenden Markdown-Struktur-/Block-, Altvorschlags- und Team-Varianten
   in der Browsermatrix erweitern. Bestehende Legacy-Lifecycle-Prüfungen und
   dedizierte Graph-Fixtures weiter getrennt von gewöhnlichen Tools ausweisen.
3. Die neuen CR-03-Yjs- und CR-18/CR-22-Komponentenorakel um die fehlenden
   Browser-/Integrationsnachweise ergänzen. Zwei-Prozess-Races,
   Crash-Grenzen, Retention während Apply und Notification-Ausfälle mit exakten
   Bytes und Revisionen prüfen; der oben genannte Connection-Neustart genügt nicht.
4. Die implementierte gemeinsame Ring-/Rollback-Policy für Tools, Review und
   Recovery sowie redigierte Betriebsmetriken im genehmigten Zielprozess prüfen.
   Die neuen Unit-/Route- und echten Tool-Prozess-Prüfungen ersetzen keinen
   vollständigen Rollback nach Serverneustart mit offenen abhängigen Vorschlägen.
5. Nach genehmigtem Build/Recreate den vorhandenen Managed-Runner für zwei
   vollständige serielle Läufe verwenden. Commit, Build, URL, Fixture-IDs,
   Pflicht-Skips und Soll/Ist erfassen. Erst danach FVRC-1008 abschließen;
   Produktionsaktivierung bleibt eine separate Entscheidung.
