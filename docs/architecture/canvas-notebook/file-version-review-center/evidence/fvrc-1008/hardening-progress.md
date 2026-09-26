# FVRC-1008 – Härtung, Zwischenstand

Stand: 26. September 2026. Ausgangscommit der Härtung: `83238a7e3`
(abgeschlossenes FVRC-1007); Pool-Harness-Korrektur: `0b30dc785`.
**FVRC-1008 ist in Arbeit, nicht abgenommen.**
Produktionsaktivierung und der manuelle Konflikteditor P12 sind nicht freigegeben.

## Ergänzung: Reine Löschung bis zum leeren Dokument

Vier neue gewöhnliche Personal-/Team-Browserfälle prüfen Teil- und
Volltextlöschung in einem Rich-Paragraphen. Der Zustandsvektor bleibt gleich,
Inhalts-/Struktur-/Delete-Set-Proof ändern sich. Ein separater lesender Prozess
weist die vollständige PostgreSQL-Binärpersistenz nach; auch der leere Inhalt
bekommt eine verfügbare 0-Byte-Historyversion, genau eine Revision und einen
idempotenten Aktionsbeleg. Historischer Link und UI-Reload schreiben nichts
erneut. Details: [ordinary-deletion-results.md](ordinary-deletion-results.md).
Keine Produktkorrektur war nötig; ergänzt wurden Test und optionaler lokaler
Persistenzleser. Crash-/Recovery-Grenzen und strukturelle Blocklöschung werden
nicht aus diesem erfolgreichen Textlöschfall abgeleitet.

Die Nachweise zeigen unterschiedliche vollständige Binärhashes von Kandidat
und GC-bereinigter Persistenz bei gleicher Wirkung. Der normale Dauerhaftigkeits-
Nachweis prüft korrekt integrierte Clocks und Delete-Ranges. Für PG-S19 ist nun
konkret der Crash im Status `applying` vor Speicherung des Operationssnapshots
zu prüfen: dessen Recovery verlangt weiterhin exakte Full-State-Proof-Gleichheit
und könnte eine bereits erfolgte Löschung nach GC konservativ blockieren.

## Ergänzung: Vollständige Diff-Seiten vor der Annahme

Ein gewöhnlicher 65-Hunk-Vorschlag war nach den ersten 64 Hunks bereits
annehmbar. Die UI sperrt Inhaltsannahme/Bestätigung jetzt, bis alle gebundenen
Vergleichsseiten verfügbar sind. Bei Seitenfehlern bleibt die Vorschau erhalten;
„Vergleich aktualisieren“ startet eine neue Prüfung. Personal und Team prüfen
zusätzlich einen reinen Graphwechsel bei unverändertem Current: alte Seite und
alte Freigabe bleiben gesperrt, frische vollständige Vorschau lässt nur den
gewählten Vorschlag mit exakt einer Revision zu. Team wurde bei 390 Pixeln
geprüft; der bestehende Nullwirkungsabschluss bleibt funktionsfähig.
Details: [ordinary-diff-pages-results.md](ordinary-diff-pages-results.md).
Die Browser-Paging-/Graph-only-Lücken von MR-20/MR-15 sind damit auf Host-Dev
abgedeckt; übrige Limits und die vollständige FVRC-1008-Abnahme bleiben offen.

## Ergänzung: Nachgewiesene Nullwirkung statt falschem Vergleichsfehler

Der gewöhnliche Personal-/Team-Test für eine offene Kette „10 → 12 → 10“
reproduzierte `PROPOSAL_CANDIDATE_CHANGED` trotz korrekt erkanntem `empty_effect`.
Vergleich, gespeicherte Vorschau und Metadatenabschluss verwenden jetzt dieselbe
statusabhängige Nachweisprüfung. Inhalts-/Strukturgleichheit genügt nur für die
komponierte Nullwirkung; „bereits vorhanden“ und die Current-Freigabe behalten
ihre vollständigen Identitätsprüfungen. Keine Kandidaten werden umgeschrieben.
Vier neue Browserfälle prüfen sowohl Nullabschluss ohne Elternfreigabe als
auch unabhängige gleiche Effekte mit weiterhin gesperrtem, anders verankertem
Kind. Details: [ordinary-no-effect-results.md](ordinary-no-effect-results.md).
Das schließt die bisher separat ausgewiesene Empty-Effect-Browserlücke von
PG-S12/MR-13; es nimmt weder FVRC-1008 insgesamt noch P12 ab.

## Ergänzung: Delete/Recreate und fehlende Wiederherstellungs-Meldung

Der neue Personal-/Team-Browserfall löscht das Original mit offenem Root/Child
und legt am selben Pfad dieselben Bytes neu an. Alte Dokument-/Lineage-Ziele,
Operationen und Freigaben bleiben gesperrt; die neue Datei startet mit Review
aus und ohne alte Vorschläge. Nach expliziter Dateibaum-Auswahl entstehen neue
Vorschläge, deren gemeinsamer Merge exakt eine Revision und den erwarteten
Endtext erzeugt. Der dabei gefundene leere Editor bekommt bei automatischem
Öffnen eine verständliche Meldung, ohne die alte Tab-Identität zu lockern.
Nachweise und Grenzen: [ordinary-recreate-results.md](ordinary-recreate-results.md).
Damit ist der separate MR-17-Delete/Recreate-Fall auf Host-Dev abgedeckt;
die Gesamtfreigabe bleibt offen.

## Ergänzung: Dokumentidentität nach Pfadänderung

Der neue gewöhnliche Tool-/Browserfall für Personal und Team prüft Rename,
Move, Wiederverwendung des alten Pfads sowie Kopien im selben/anderen Workspace.
Die Original-Lineage bleibt annehmbar; die drei anderen Dateien übernehmen
weder Graph noch Freigabe. Exakter gemeinsamer Root-/Child-Merge, +1 Revision,
Block-IDs, idempotenter Retry und unveränderte Kopien sind nachgewiesen.
Details und Grenzen: [ordinary-location-results.md](ordinary-location-results.md).
PG-S27 ist für den authentifizierten Datei-API-Pfad abgedeckt. Der damalige
Delete/Recreate-Restfall von MR-17 ist im obigen Ergänzungsnachweis dokumentiert.
Der ursprüngliche Rename-/Move-Testcommit änderte keinen Produktcode.

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

## Ergänzende gewöhnliche Tool-Prüfungen (26. September 2026)

Basis ist `7ecc4dcf0`, ausschließlich ergänzt um Testcode und Dokumentation.
Der Host-Dev-Prozess auf `http://127.0.0.1:3000` läuft nach erneutem CWD-Abgleich
aus dem Implementierungsworktree. Der Skill-Status bestätigt genau einen
verwalteten Stack mit vier gesunden Diensten, PostgreSQL 18.4 und pgvector 0.8.3.
Das drei Tage alte Notebook-Image auf 3100 ist weiterhin kein Nachweis für diese
Änderungen. Es wurden weder Container noch Runtime-Env-Dateien verändert.

Der gemeinsame authentifizierte Testaufbau wurde nach `code-structure` zunächst
für einen bestehenden Aufrufer extrahiert und geprüft (`ordinary-r5`, bestanden,
55,7 Sekunden), danach für weitere Szenarien verwendet. Jeder Aufruf erzeugt
eine eigene UUID-Datei und Agent-Session und entfernt nur diese per API. Der
Toggle schreibt eine dokumentbezogene Policy mit dem Schlüssel
`(user_id, workspace_id, lineage_id)`, keine Workspace-Policy. Neue Dokumente
werden weiterhin mit ausgeschaltetem Review geprüft und explizit umgeschaltet.

| Lauf | Ergebnis | Nachweis |
|---|---|---|
| `ordinary-r5` | bestanden, 55,7 s | Bisheriger Personal-10→3→7-Fall nach Fixture-Extraktion; `/tmp/fvrc1008-ordinary-r5-report/index.html`. |
| `write-patch-r1` | bestanden, 24,9 s | Personal: gewöhnliches `write`, dann ein `apply_patch` mit zehn Ersetzungen; `/tmp/fvrc1008-write-patch-r1-report/index.html`. |
| `write-patch-team-r1` | bestanden, 25,9 s | Derselbe Fall im Shared Test Workspace; `/tmp/fvrc1008-write-patch-team-r1-report/index.html`. |
| `ordinary-team-r1` | bestanden, 54,1 s | Gewöhnliche Tools im Team: zehn unabhängige Vorschläge, H→C→A einzeln, sieben gemeinsam, feste Endbytes und +4 Revisionen; `/tmp/fvrc1008-ordinary-team-r1-report/index.html`. Annahmebelege prüfen jetzt die exakten Proposal-IDs statt nur ihre Anzahl. |
| `ordinary-personal-r6` | bestanden, 56,1 s | Wiederholung im Personal-Workspace mit denselben verschärften Receipt-ID- und Action-Type-Prüfungen; `/tmp/fvrc1008-ordinary-personal-r6-report/index.html`. |
| `ordinary-conflict-personal-r1` | bestanden, 15,8 s | B/C aus A per gewöhnlichem `edit_file`, C annehmen, B bleibt offen/konfligiert; `/tmp/fvrc1008-ordinary-conflict-personal-r1-report/index.html`. |
| `ordinary-conflict-team-r1` | bestanden, 15,5 s | Derselbe Konfliktfall im Team; `/tmp/fvrc1008-ordinary-conflict-team-r1-report/index.html`. |

Die Write-/Patch-Fälle prüfen unabhängig vom Tool-Ergebnis den vollständigen
Solltext: Frontmatter, Überschrift, Fettschrift, Checkbox-/nummerierte Liste,
Zitat, Link, Inline-/Fenced-Code, Tabelle, Umlaute und Emoji bleiben erhalten.
Die tatsächlich gelieferte Repräsentation ist `plain_text`, die Zeilenenden
sind LF. Daraus folgt **kein** Nachweis für CRLF oder die Tiptap-Block-/XML-Pfade.
Der ungültige zehnte Patch-Eintrag erzeugt keinen neuen Vorgang, keinen neuen
Inhalt und keine Revision. Der gültige Zehn-Edit-Patch liefert genau einen
Vorschlag und nach UI-Annahme genau eine zusätzliche Revision. Dies ist kein
Nachweis für einen Fehler im letzten Mitglied eines mehrteiligen Graph-Batches
während des Live-Preflights (PG-S21). Exakte abgeschlossene Write-/Patch-Retries
mit Graph-Modus `off` im separaten Tool-Prozess ändern weder Inhalt noch Historie.

Die B/C-Fälle verwenden keine vorgefertigten Proposal-Knoten: Beide gewöhnlichen
`edit_file`-Aufrufe erhalten denselben Read-Hash von A (`Plan: 100 USD.`), B schlägt
120 und C 130 vor. Nach Annahme von C ist der vollständige Inhalt exakt 130,
die Revisionenzahl steigt um eins und der Beleg nennt ausschließlich C.
B bleibt im echten Review-Endpunkt `lifecycle=open`, `status=conflicted` mit
seiner exakten ID. UI und API bieten keinen Accept an; es gibt weder den alten
Timeline-Fehler noch einen Null-Diff/No-effect. Insgesamt erfolgt nur ein
Action-POST. Die Screenshots zeigen die konkrete Konflikterklärung, den offenen
Vorschlag und zwei Historieneinträge ohne Kartenüberlauf. Dies beweist eine
korrekte Konfliktklassifikation, nicht die noch ausstehende manuelle Auflösung.

PG-S14 hat jetzt ein eigenes Yjs-Evaluator-Oracle: Elternvorschlag und Kind
ändern unterschiedliche Absätze, aber die explizite Abhängigkeit bleibt
erhalten. Der Elternvorschlag ist in Autorisierung, Closure und Apply-Reihenfolge
enthalten; ein abgelehnter Elternvorschlag blockiert das Kind ohne Kandidat,
Live-Byte- oder Statusänderung. Die vollständige Review-Projection-Suite besteht
(`/tmp/fvrc1008-projection-pgs14-r1.log`, Evaluator-Teil 14/14). Das ist kein
Browser- oder tatsächlicher Apply-Nachweis.

Die sechs unterschiedlichen neuen/erweiterten Browserfälle (drei Szenarien in
jeweils Personal/Team) bestanden als serielle Einzelaufrufe mit einem Worker.
Die API-/Tool-Aufrufe benutzen den tatsächlichen PostgreSQL-/Reviewpfad, aber
kein LLM wird dabei zur Auswahl der Werkzeugargumente benötigt. Es wurde kein
vorgefertigter Proposal-Knoten in die Datenbank geschrieben. Eigene Fixture-IDs,
Solltext, Revisionszähler und Repräsentation sind in den JSON-Attachments der
Reports enthalten. Die abschließenden Screenshots wurden visuell geprüft.

`npx tsc --noEmit` und fokussiertes ESLint bestanden
(`/tmp/fvrc1008-tool-matrix-typecheck-r4.log`,
`/tmp/fvrc1008-tool-matrix-lint-final.log`), ebenso `git diff --check`.
Der unabhängige Testreview fand nach Verfolgung des tatsächlichen Policy-Targets
keinen konkreten verbleibenden Fehler; sein Hinweis auf exakte Receipt-IDs wurde
übernommen und in Personal/Team erneut geprüft. Produktcode und Abhängigkeiten
wurden in dieser Ergänzung nicht geändert; es gab keinen neuen Containerbuild.
Der erfolgreiche Produktbuild aus der vorherigen Runde bleibt separat dokumentiert.

GitNexus vor Commit: sechs Test-/Evidence-Dateien, 25 Symbole, null betroffene
Produktprozesse, Risiko niedrig. Der gesamte Branchvergleich zum lokalen
`main` umfasst 156 Dateien/1107 Symbole/27 Prozesse und bleibt kritisch.
SHA-256 des staged Code-Patches (`app scripts tests package.json`) gegen
`7ecc4dcf0`: `35edd97ba034c7c74fef0d0cbb6e86f57a6a5e0986c4ff75906f922cdd76c6d8`.
Die generierten Änderungen an `AGENTS.md` und `CLAUDE.md` gehören nicht zu diesem
Commit. Kein Push und keine Produktionsaktivierung.

FVRC-1008 bleibt in Arbeit. Die neuen Fälle schließen konkrete Evidenzlücken,
ersetzen aber weder die zwei vollständigen Matrixläufe noch die ausstehenden
Crash-/Rollback-/Retention-Prüfungen. P12 wurde nicht begonnen.

## Parallelentscheidungen und automatische UI-Konvergenz (26. September 2026)

Basis: `c1a228344` plus der nachfolgende Konvergenz-Patch. Die gewöhnlichen
`read`/`edit_file`-Tools erzeugen einen echten Review-Vorschlag. Zwei getrennte
Browserkontexte öffnen ihn, sehen denselben Graphstand und bestätigen ihre
Entscheidung, bevor beide echten HTTP-POSTs freigegeben werden. Nur der Zeitpunkt
wird gesteuert; Antworten und Apply-Pfad werden nicht ersetzt. Personal verwendet
zwei Sitzungen desselben Bootstrap-Users, Team den Bootstrap-Administrator und
den tatsächlich verschiedenen zweiten Team-User. Die Tests prüfen die Actor-IDs.

Der strengere Test `race-personal-accept-r2` fand einen Produktfehler: Der Server
schrieb korrekt nur einmal, der unterlegene Tab behielt aber den alten Vergleich
und „Action status is not yet confirmed“. Das vorherige Oracle mit Seitenreload
verdeckt diesen UI-Fehler. Der neue Pflicht-Check prüft Terminalstatus und das
Verschwinden der Pending-Anzeige **vor jedem Reload**.

Die Korrektur verwendet keinen pauschalen 409-Reset. Nach einem strukturierten
`PROPOSAL_GRAPH_CHANGED`/`PROPOSAL_RECOVERY_REQUIRED` werden nacheinander geprüft:

1. Frischer autorisierter Review der exakten Proposal-Auswahl, ohne Cache.
2. Exakt gleicher Workspace, Lineage, Dokument, Lifecycle-Generation und
   Schema-Version wie im alten Fence, aber strikt höhere Graphrevision.
3. Erst danach ein frischer Status-Read für den eigenen Key und Request-Digest;
   dieser muss `receipt=null` ergeben.

Die Reservierung und der Status-Read verwenden denselben Graph-Lock. Eine zuvor
reservierte eigene Aktion ist im Status sichtbar; eine noch nicht reservierte
späte Kopie kann den alten Revisions-Fence nicht mehr passieren. Die UI darf
daraufhin ihre nicht reservierte Aktion auflösen und Timeline/Review neu laden.
Die neue vollständige `context.scope` ist optional für Rückwärtskompatibilität:
alte Antworten ohne Scope bleiben lesbar, liefern aber keinen Auflösungsbeleg.
Transportfehler, fehlender Scope, Generationwechsel, unveränderter Graph,
fehlgeschlagene Statusabfrage oder ein vorhandener eigener Receipt erlauben
keinen solchen Reset. Die bisherige servergeprüfte Ablauf-/Receipt-Recovery bleibt.

Rein lesende Folgeprüfungen warten auch auf langsamere Gewinner: einmal nach
250 ms, anschließend höchstens alle fünf Sekunden bis zum serverbekannten
Fence-Ablauf einschließlich Schlussprüfung. Keine Mutation wird automatisch
erneut gesendet. Unmount/Scopewechsel brechen Requests und Timer ab.

Die Gegenprüfung fand zusätzlich ein altes Client-Rennen: A konnte schon per
Status als abgeschlossen erkannt werden, während sein ursprünglicher POST noch
unterwegs war. Ein spätes A durfte dann Bs neue Recovery-Kennung nicht löschen.
Cleanup ist nun an die exakte Identität gebunden, laufende POSTs werden pro
Identität gezählt, und UI-Antworten an die noch aktive Ansicht gebunden.
Komponententests halten A absichtlich zurück, starten B nach A-Status-Recovery,
liefern A verspätet aus und verlieren anschließend Bs Antwort. Bs Identität,
exakte Retry-Anfrage und Pending-Zustand bleiben erhalten. Das ist ein gezielter
Client-Race-Test, kein Prozess-Crash-Nachweis.

Die erste Team-Race-Ausführung hatte erfolgreiche Business-Orakel, scheiterte
jedoch beim Fixture-Cleanup: der zweite User darf schreiben, aber nicht löschen.
Die gemeinsame Fixture akzeptiert dafür nun eine ausdrücklich separate
Cleanup-Identität. Sie löscht ausschließlich ihre eigene UUID-Datei per API als
Administrator; Rollen/Berechtigungen werden nicht geändert. Die einmal übrig
gebliebene eigene Testdatei wurde nach Prüfung der exakten Sollbytes entfernt,
anschließend wurde GET=404 geprüft. Wiederholte Team-Läufe bestanden mit Cleanup.

| Lauf vor abschließender Late-Response-Härtung | Ergebnis | Report |
|---|---|---|
| Personal Accept/Accept `r3` | bestanden, 17,8 s; ein Accept, +1 Revision | `/tmp/fvrc1008-race-personal-accept-r3-report/index.html` |
| Team Accept/Accept `r2` | bestanden, 17,4 s; zwei verschiedene User, ein Accept, +1 | `/tmp/fvrc1008-race-team-accept-r2-report/index.html` |
| Personal Accept/Reject `r1` | bestanden, 21,4 s; Accept gewann, +1 | `/tmp/fvrc1008-race-personal-reject-r1-report/index.html` |
| Team Accept/Reject `r1` | bestanden, 16,8 s; Reject gewann, unveränderte Bytes/+0 | `/tmp/fvrc1008-race-team-reject-r1-report/index.html` |
| Lost response `r1` | bestanden, 8,1 s; ein POST, gleicher Recovery-Beleg, +1 | `/tmp/fvrc1008-convergence-lost-reply-r1-report/index.html` |

Die Parallelfälle prüfen zwei unterschiedliche Idempotency-Keys, dieselbe
angezeigte Graphrevision, exakte Proposal-IDs/Action-Typen und insgesamt genau
zwei Action-POSTs. Genau einer liefert einen erfolgreichen Receipt, der andere
409 (Graphänderung oder laufende Recovery). Endbytes und Revisionenzahl werden
vor und nach Reload unabhängig geprüft. Screenshots zeigen sowohl „Applied“
mit zwei Revisionen als auch „Rejected“ mit nur der ursprünglichen Revision.
Redigierte JSON-Attachments enthalten Fixture-IDs, Solltext und beide Ergebnisse.

Alle Browserläufe verwenden den aktuellen Host-Dev-Prozess auf Port 3000 und
echtes PostgreSQL 18.4/pgvector 0.8.3 des einzigen verwalteten Stacks. Das alte
Notebook-Image auf 3100 wird weiterhin nicht als aktueller Nachweis verwendet.
Zwei Browserkontexte sind kein Nachweis für zwei unabhängige App-Prozesse.
FVRC-1008 bleibt offen; P12 und die vollständigen Crash-/Rollback-/Restore-
Prüfungen sind hiermit ausdrücklich nicht abgeschlossen.

### Abschließende Prüfungen des kombinierten Konvergenz-/Late-Response-Fixes

Der abschließende Produktcode ist seit dem folgenden Patch-Digest unverändert:
SHA-256 von `git diff --cached -- app scripts tests package.json` gegen
`c1a228344`: `ea32a0389e63d39a055581f0d2ebaaa1a257484f519175f416682e89813bef55`.

- `npm run test:proposal-graph:review-ui` vollständig bestanden, inklusive der
  sieben neuen Proof-Tests, drei Action-State-Tests und erweiterten DOM-Tests
  für den langsamen Gewinner, abgebrochene Timer und verspätetes A/verlorenes B.
  Log: `/tmp/fvrc1008-convergence-review-ui-r3.log`.
- `npm run test:proposal-graph:review-actions` vollständig bestanden.
  Log: `/tmp/fvrc1008-convergence-review-actions-r2.log`. Die lokalen öffentlichen
  Base-URLs wurden nur für diesen Prozess gesetzt, keine Runtime-Env verändert.
- `npx tsc --noEmit`, fokussiertes ESLint und `git diff --check` bestanden.
  Logs: `/tmp/fvrc1008-convergence-typecheck-r2.log` und
  `/tmp/fvrc1008-convergence-lint-final.log`.
- Der abschließende `npm run build` bestand mit 353/353 Seiten und null
  Lizenzblockern (`/tmp/fvrc1008-convergence-build-final.log`). Wie zuvor gibt es
  31 Turbopack-Tracing-Warnungen in unveränderten Dateien; keine Build-Fehler.
- Der GitNexus-Inkrementallauf war an einem UTF-8-Indexfehler gescheitert. Ein
  vollständiger Reindex bestand; danach lieferte die staged Prüfung 17 Dateien,
  55 Symbole, null betroffene indexierte Prozesse und Risiko niedrig. Der gesamte
  Branchvergleich zu lokalem `main` bleibt kritisch (159 Dateien, 1143 Symbole,
  27 Prozesse). Die additive zentrale Vertragsänderung wurde unabhängig davon
  konservativ als höhere Review-Sensitivität behandelt und separat geprüft.
- Der unabhängige abschließende Code-Review fand nach Behebung der beiden
  Recovery-Rennen keinen weiteren konkreten Fehler in diesem Pfad.

| Wiederholung auf endgültigem Produktcode | Ergebnis | Report |
|---|---|---|
| Personal Accept/Accept | bestanden, 25,3 s; Accept, +1 | `/tmp/fvrc1008-race-personal-accept-final-report/index.html` |
| Team Accept/Accept | bestanden, 20,6 s; Accept, +1 | `/tmp/fvrc1008-race-team-accept-final-report/index.html` |
| Personal Accept/Reject | bestanden, 16,6 s; Reject, +0 | `/tmp/fvrc1008-race-personal-reject-final-report/index.html` |
| Team Accept/Reject | bestanden, 17,2 s; Accept, +1 | `/tmp/fvrc1008-race-team-reject-final-report/index.html` |
| Lost response | bestanden, 8,0 s; ein POST, gleicher Recovery-Beleg, +1 | `/tmp/fvrc1008-convergence-lost-reply-final-report/index.html` |

Diese fünf Fälle wurden seriell, jeweils mit einem Worker und Abstand zwischen
den Läufen geprüft; kein beobachteter 429-/5xx-Fehler. Sie sind weiterhin keine
zwei vollständigen FVRC-1008-Matrixläufe. Die beiden neuen Helper-Suites sind im
bestehenden `test:proposal-graph:review-ui`-Befehl enthalten. Der neue Client
akzeptiert ältere Antworten ohne `context.scope`; die umgekehrte Kombination
eines noch geöffneten alten Browserbundles mit neuem Server ist hiermit nicht
als Rolling-Upgrade-Kompatibilität freigegeben.

Keine Dependencies, Container oder Runtime-Env-Dateien geändert, kein Push und
keine Produktionsaktivierung. Die generierten Änderungen an `AGENTS.md` und
`CLAUDE.md` bleiben außerhalb des Commits. Ein Build/Recreate des Notebook-
Containers auf 3100 wurde separat angefragt und noch nicht durchgeführt.

### Gewöhnliche Rich-Markdown-Merges: zwölf weitere Browserfälle

[Ordinary rich merge results](ordinary-rich-merge-results.md) dokumentiert zwölf
bestandene E2E-Fälle auf unverändertem Produktcode `542c99dc2`: Versand-P1/Q in
beiden Reihenfolgen und als Batch sowie zwei explizit blockadressierte Änderungen
im selben Absatz, jeweils Personal und Team. Geprüft sind feste Zwischen-/Endtexte,
aktuelle Rest-Diffs, stabile Block-IDs, der beim ersten Merge eingefügte Absatz,
exakte Aktionsbelege und +2 Einzel-/+1 Batch-Revisionen. Alle Fixtures verwenden
nachweislich `tiptap_blocks` und gewöhnliche registrierte Agentenwerkzeuge.

TypeScript, fokussiertes ESLint, Diff-Prüfung und unabhängiger Quell-Review
bestanden. Testtreiberlogik ist ohne Produktänderung in einen gemeinsamen Helper
extrahiert. Die erste falsche Abschluss-Locator-Erwartung wurde korrigiert und
alle Fälle danach erneut ausgeführt. Kein 429-/5xx-Fehler, kein Skip. Die
Szenariomatrix aktualisiert PG-S01, MR-05/MR-06 und CR-03/CR-04 nur für die
tatsächlich abgedeckten Orakel. FVRC-1008 und P12 bleiben offen; kein Push,
kein Container-Rebuild und keine Produktionsfreigabe.

### Gewöhnliche abhängige Markdown-Vorschläge: acht Browserfälle

[Ordinary dependent merge results](ordinary-dependent-merge-results.md)
dokumentiert acht zusätzliche bestandene E2E-Fälle auf unverändertem Produktcode
`542c99dc2`. P1 fügt einen neuen Absatz ein; P2 liest den noch offenen P1-Kandidaten
über das registrierte Werkzeug und erweitert genau dessen neue Block-ID. Q ist
eine unabhängige Änderung auf dem ursprünglichen autoritativen Dokument. Alle
drei existieren vor der ersten Annahme. Personal und Team prüfen P1 → Q → P2,
P2 → Q, Q → P2 und die gemeinsame Annahme. Exakte Texte, Block-Identitäten,
Rest-Diffs, Voraussetzungen/Anwendungsmengen, Lebenszyklen, +3/+2/+1 Revisionen
und historische P1-Ansichten sind nachgewiesen.

Eine zunächst falsche Testgleichsetzung von geprüfter Abhängigkeitsmenge und
neu anzuwendenden Vorschlägen wurde korrigiert: Ein bereits angewendetes P1
bleibt bei P2 im Aktionsbeleg enthalten, wird aber nicht erneut angewendet oder
aufgelöst. Zusätzlich wurde ein mehrdeutiger CLI-Testfilter korrigiert; der
unterbrochene Lauf wird nicht als Nachweis gezählt. Alle acht abschließenden
Einzelfälle liefen seriell ohne Skip oder beobachteten Review-429-/5xx-Fehler.
TypeScript, fokussiertes ESLint und unabhängiger Testquell-Review bestanden.

Die Matrix aktualisiert PG-S03/04/07/13 und MR-09 nur für die tatsächlich
geprüften Orakel. Vollständige Crash-/Restore-/Mehrprozess-Prüfungen, zwei
Gesamtmatrixläufe, frisches Produktionsimage und P12 bleiben offen. Kein
Produktcode, keine Dependencies, Runtime-Env oder Container geändert; kein
Push und keine Produktionsaktivierung. Generierte `AGENTS.md`-/`CLAUDE.md`-
Änderungen gehören nicht zum Test-Commit.

### Restore und verlorene Voraussetzungen: vier Browserfälle

[Ordinary restore prerequisite results](ordinary-restore-prerequisite-results.md)
dokumentiert vier weitere bestandene E2E-Fälle auf unverändertem Produktcode
`542c99dc2`: Personal/Team mit tatsächlichem UI-Restore auf die Version vor P1,
jeweils mit und ohne anschließendes Wiederherstellen des gleichen P1-Textes.
Die abhängigen Vorschläge entstehen vorher über gewöhnliche Werkzeuge. P2
bleibt nach Verlust des von P1 eingefügten Absatzbezugs offen, aber mit genauer
Graph-Diagnose `prerequisite_lost` und ohne Annahmeaktion. P1 bleibt historisch
angewendet. Gleicher Text mit neuer Block-ID berechtigt nicht zur Übernahme.

Der alte signierte Annahmeauftrag scheitert mit 409/`PROPOSAL_CURRENT_CHANGED`
ohne weiteren Inhaltseffekt; identische Restore-Wiederholungen liefern dasselbe
Ergebnis ohne zusätzliche Revision. Geprüft sind exakte Texte, Block-Identität,
Lebenszyklen, +2/+3 Revisionen und konkrete UI-Diagnose statt Legacy-Timeline-
Fehler. Der erste Lauf fand einen mehrdeutigen Test-Locator, nicht einen
Produktfehler; nach dessen Eingrenzung bestanden alle vier Einzeltests.

TypeScript, fokussiertes ESLint und unabhängiger Quell-Review bestanden. Keine
Review-429-/5xx-Antwort und kein Skip in den abschließenden seriellen Läufen.
PG-S11/MR-10 erhalten nur diesen konkreten Restore-Nachweis; sichere Blockierung
wird nicht als erfolgreicher Konflikt-Merge gezählt. Gesamtgate, zwei volle
Matrixläufe, frisches Produktionsimage, Mehrprozess-/Crash-Prüfungen und P12
bleiben offen. Kein Push, Container-Rebuild oder Produktiv-Rollout.

### Abgelehnte Voraussetzung: ausdrückliches Ablösen im Browser

[Ordinary rejected-parent detach results](ordinary-rejected-parent-detach-results.md)
dokumentiert einen real reproduzierten UI-Fehler und den begrenzten Fix:
Bei `PROPOSAL_DEPENDENCY_BLOCKED` war nicht nur Annehmen, sondern auch das
ausdrückliche Ablösen eines offenen Nachfolgers gesperrt. Start und Bestätigung
unterscheiden jetzt Ablösen von Ersetzen. Nur Ablösen erlaubt diesen konkreten
Kontextfehler; alle anderen Sperren und die Server-Freigaben bleiben erhalten.

Personal und Team bestehen den gewöhnlichen Werkzeugpfad P1 ablehnen → P2
ablösen → neuen Vorschlag prüfen und separat annehmen. P1s Kostenänderung wird
nicht übernommen, nur P2s Lieferzeitänderung. Volltext, ursprüngliche Block-IDs,
explizite Beziehungen, identischer Erstellungs-Retry, Lebenszyklen und genau
eine Inhaltsrevision sind belegt. Bestehende normale Ablösen-/Ersetzen-E2E,
Review-UI-/Server-Suiten, TypeScript, ESLint und Produktionsbuild bestehen.

PG-S05/PG-S14 erhalten den konkreten positiven Browsernachweis; Gesamtgate und
P12 bleiben offen. Der einzige Stack wurde nicht neu gebaut. Getestet wurde
aktueller Host-Dev-Code auf 3000, nicht das ältere Notebook-Image auf 3100.

### Gemeinsame Vorfahren, dreistufige Ketten und kollidierende Geschwister

[Ordinary closure results](ordinary-closure-results.md) dokumentiert zehn weitere
bestandene Browserfälle auf unverändertem Produktcode `dbdfcae3b`. In Personal
und Team werden gewöhnliche `read`-/`edit_file`-Werkzeuge mit `tiptap_blocks`
verwendet: zwei kompatible Kinder desselben P1 als Batch oder nach P1-Annahme,
eine dreistufige Kette als Batch oder durch alleinige Auswahl ihres letzten
Kindes, sowie zwei kollidierende Kinder mit anschließend ausdrücklich neu
geprüfter Einzelannahme. Gemeinsame Voraussetzungen werden genau einmal
angewendet; bereits übernommene Vorfahren bleiben im Beleg, aber nicht in der
neuen Anwendungs-/Abschlussmenge. Exakte Texte, Block-IDs, Aktionsbelege,
Lebenszyklen, Idempotenz und +1/+2 Revisionen sind geprüft.

Beim kollidierenden Sammel-Merge bleibt auch der konfliktfreie Parent-Anteil
unangetastet. Erst die eigene Vorschau und Bestätigung von P2 übernimmt P1+P2
in genau einer Revision; P3 bleibt offen und mit konkreter Konfliktdiagnose
gesperrt. Das ist ein erfolgreicher sicherer Teil-Merge, kein Nachweis für den
noch ausstehenden manuellen Konflikteditor.

Die Testentwicklung korrigierte drei Annahmen: Geschwisterkomposition ist
`clean_rebased`, ein neuer Geschwistervorschlag benötigt nach Graphänderung einen
frischen P1-Quellbeleg, und abgeschlossene Geschwister werden über ihre exakte
Operation geprüft statt in fremdem aktivem Kontext vorausgesetzt. Keine
Produktsicherheitsprüfung wurde gelockert. Alle zehn finalen Läufe bestanden
seriell ohne Skip oder beobachteten Review-429-/5xx-Fehler. JSON-Belege wurden
unabhängig ausgewertet, repräsentative Erfolgs-/Konfliktansichten visuell geprüft.
Ein unabhängiger Subagenten-Quellreview fand keinen wesentlichen Testfehler.

TypeScript ohne inkrementellen Cache, fokussiertes ESLint, Graphmodell-,
Kandidaten- und Orchestrator-Suites bestehen. PGlite-Storage-Regressionsprüfungen
bleiben getrennt von den Browserfällen auf echtem verwaltetem PostgreSQL.
PG-S07/PG-S13/MR-11/MR-12 sind nur für die konkret geprüften Orakel aktualisiert.
FVRC-1008 bleibt in Arbeit; P12, zwei Gesamtmatrixläufe und die Prüfung eines
frischen Produktionsimages bleiben offen. Keine Produkt-, Dependency-, Env-
oder Containeränderung, kein Push und keine Produktionsaktivierung.

### Gewöhnliche Alternativen und Ersetzungen

[Ordinary choice results](ordinary-choice-results.md) dokumentiert die nun
tatsächlich angeschlossene Relationship-Policy der normalen Agentenwerkzeuge,
die transaktional korrekte Anlage ihrer Auswahlgruppen und den Erhalt
ausgeblendeter abgeschlossener Gruppenmitglieder. Bisherige Gruppen-Fixtures
allein hatten diese Authoring-Anbindung nicht belegt.

Vier neue Browserfälle auf echtem PostgreSQL bestehen in Personal und Team:
gemischte alternative Zweige ohne Teilanwendung verweigern, einen ausgewählten
Nachfahren mit genau seinen Voraussetzungen übernehmen, sowie Ersetzung mit
richtiger Quelle/Gruppe ablehnen, ohne das Original wiederzuöffnen, und danach
die verbleibende Alternative annehmen. Jeweils genau eine Inhaltsrevision,
exakte IDs/Endtexte/Belege, stabile Block-IDs und sichere identische Retries.

Die neuen PGlite-Tests sichern Rollback einschließlich Graphrevision und
Reservierung, unmittelbaren Rechteentzug, Archivangaben und Anlage-Retries ab.
PG-S08/09/10, MR-11 und CR-12 sind für diese konkreten Orakel aktualisiert;
Gesamtmatrix, Produktionsimage und P12 bleiben offen. Die Produktionsfreigabe
wurde nicht geändert; kein Containerneubau und kein Push.

### Default-Direktbearbeitung und Review-Toggle

[Ordinary toggle results](ordinary-toggle-results.md) ergänzt echte gewöhnliche
Direkt-Edits vor und zwischen Review-Phasen in Personal und Team. Dabei wurde ein
Produktfehler gefunden: Der Operationsresolver verlangte auch beim impliziten
Default eine noch nicht vorhandene Präferenzzeile. Der Fix bindet Revision 0 an
den vor der Neuanlage erfassten serverseitigen Snapshot und die exakte noch nicht
angewandte Operation; Reads erzeugen keine Präferenz und Retries erhalten keine
neue Direktfreigabe.

Der separate Tool-Worker konnte bislang nur Vorschläge erzeugen, nicht den
prozesslokalen Collaboration-Apply-Handler des Servers nutzen. Ein ausschließlich
expliziter lokaler Test-Launcher führt die echten registrierten Tools deshalb
im bestehenden Serverprozess aus, über einen privaten begrenzten Unix-Socket.
Dies ist keine Produkt-HTTP-Route und kein simulierter Apply. Der Skill-Stack
blieb einzeln; nur der eigene Host-Dev-Server wurde vorübergehend ersetzt.

Die Browserorakel prüfen unangetasteten Default, on/off/on, unveränderte offene
Abhängigkeiten und Retries, gesperrte alte Vorschau nach einem direkten Edit
sowie einen erfolgreichen frischen Vierer-Batch. Endtext, Block-IDs, genaue
Abschlussmengen und insgesamt zwei Direktrevisionen plus eine Merge-Revision
sind fest vorgegeben. PG-S22/MR-24 sind nur für diese Orakel fortgeschrieben.
Abgelaufene Grants im Browser und die noch nicht angeschlossene strengere
Workspace-Policy bleiben ausdrücklich offen; FVRC-1008 ist nicht abgenommen.

### Gelöschter und mit gleichem Text neu angelegter Rich-Absatz

[Ordinary block recreate results](ordinary-block-recreate-results.md) ergänzt
CR-05/MR-08 um tatsächliche Editor- und Browsernachweise in Personal und Team.
Ein Absatz wird per sichtbarer Auswahl/Tastatur gelöscht und neu eingefügt.
Markdown-Bytes und Inhalts-Hash sind danach wieder identisch, der Absatz hat
jedoch eine neue ID; Struktur- und Yjs-Zustandsnachweise unterscheiden sich.
Der alte Vorschlag bleibt offen und als konkreter Konflikt sichtbar, alte
Einzel-/Batchfreigaben werden ohne Live-Mutation abgelehnt.

Der gemischte Sammelvergleich lässt auch den konfliktfreien Anteil unangetastet.
Erst eine ausdrücklich neue Einzelvorschau und Bestätigung übernimmt den
unabhängigen Vorschlag in genau einer Inhaltsrevision. Exakter Volltext,
unveränderte Nachbar-/Ersatzblock-IDs, Zustandsnachweise, Lebenszyklen und
identischer Retry sind geprüft. Der kollidierende Vorschlag wird nicht
heimlich verworfen oder auf den neu angelegten Absatz übertragen.

Beide finalen Browserfälle bestehen auf unverändertem Produktcode `da8c01744`
und echtem PostgreSQL; 37 fokussierte Evaluator-/Yjs-/Compare-Tests, vollständiges
TypeScript und fokussiertes ESLint sind ebenfalls grün. Zwei fehlerhafte
Testannahmen aus Entwicklungsläufen sind im Nachweis getrennt dokumentiert,
ohne Produktprüfungen zu lockern. PG-S21 bleibt für das abschließende Live-
Preflight-Rennen offen. Gesamtmatrix, Produktionsimage und manueller
Konflikteditor P12 sind damit nicht abgenommen; kein Containerneubau oder Push.

### Verschobene Zielabsätze mit zusätzlicher Löschung und Einfügung

[Ordinary block move results](ordinary-block-move-results.md) schließt die
konkrete Browserlücke CR-04/MR-05: Zwei gewöhnliche blockgebundene Vorschläge
werden vor echten Editoränderungen angelegt. Danach wird der Zielabsatz per
Tastatur verschoben, ein unabhängiger Entwurfsabsatz gelöscht und ein neuer
Hinweis vor dem Ziel eingefügt. Auch nach Editor-Reload behalten die bestehenden
Absätze ihre IDs; der neue Hinweis erhält eine neue Identität.

Vier finale Fälle bestehen auf unverändertem Produktcode in Personal und Team:
Lieferzeit/Kosten einzeln (+2 Revisionen) und gemeinsam (+1). Der vollständige
Endtext ist in allen Fällen identisch, Verschiebung und Benutzeränderungen
bleiben erhalten. Alte vorbereitete Einzel-/Batchannahmen werden ohne Mutation
abgelehnt; neue Vorschau und Bestätigung verwenden den aktuellen Stand.
Der unabhängige Testreview führte zu stärkeren sichtbaren Batch-Diff-Assertions;
alle vier Kombinationen wurden auf diesem finalen Spec ausgeführt.

86 fokussierte Editor-/BlockTree-/Yjs-Kandidatentests, TypeScript ohne
inkrementellen Cache und ESLint bestehen. Die vollständige Gesamtmatrix,
Mehrprozess-/Crash-Fälle, Produktionsimage und manueller Konflikteditor P12
bleiben offen. Kein Produkt-, Dependency- oder Env-Fix war für diesen
Grenzfall erforderlich; kein Containerneubau, Push oder Rollout.

### Recovery eines bereits gespeicherten, GC-bereinigten Kandidaten

[Recovery GC results](recovery-gc-results.md) reproduziert und behebt die im
Lösch-Persistenznachweis eingegrenzte konservative Recovery-Verweigerung. Nur
eine noch `applying` markierte Aktion ohne gespeicherte Operationssnapshot
darf nach exakter Prüfung von Inhalt, Struktur/IDs, Vector und Delete-Set
beide vollständigen Updates in temporären Docs GC-normalisieren und erneut
vollständig vergleichen. Normale Annahme-Fences bleiben streng; keine
Artefaktmutation, kein Live-Replay und kein textbasierter Ersatznachweis.

44 Candidate-/State-/Durability-Tests, 18 Orchestrator-Tests, PGlite-Storagegate
und 16 Operationsharness-Tests bestehen. Erneute normale Personal-/Team-
Browserannahmen eines leeren Dokuments sind mit exakten History-/Persistenz-
Orakeln grün. TypeScript, fokussiertes ESLint und Produktionsbuild bestehen.
Der Recovery-Code ist im Harness geprüft, nicht durch einen echten
Prozessabsturz im PostgreSQL-Stack. PG-S19 bleibt dafür offen; FVRC-1008 und
P12 werden nicht vorzeitig abgeschlossen. Kein Containerneubau oder Push.

### Echte App-Prozessabstürze an drei Persistenzgrenzen

[Proposal crash results](proposal-crash-results.md) ergänzt den bisherigen
GC-Harness-Nachweis um sechs echte Playwright-/PostgreSQL-Fälle: Personal und
Team jeweils nach Yjs-Persistenz vor Operationsbestätigung, vor History sowie
nach bestätigter History vor dem Operationsabschluss. Der eigene Host-Dev-
Prozess endet an der exakt geprüften Grenze mit SIGKILL und wird neu gestartet.
Keine SQL-Manipulation stellt einen gewünschten Produktzustand her.

Gewöhnliche Agentenwerkzeuge erzeugen die vollständige Textlöschung; die UI
zeigt sie und bestätigt die Annahme. Ein unabhängiger lesender Prozess weist
bei gestopptem Server den gespeicherten Zustand nach. Nach Startup-Recovery
bleiben Binärhash, Inhalts-/Yjs-Proof und Sequenz unverändert; kein Live-Replay,
exakt eine zusätzliche Historyrevision und derselbe Beleg bei identischem
Retry. Die Oberfläche beendet ihren Pending-Auftrag über die Statusabfrage
und kann den genauen historischen Vorschlag anschließend read-only anzeigen.

Sieben isolierte Probe-Tests, Launcher-/Log-Sicherheitsprüfungen, 34 fokussierte
Orchestrator-/Operationsfälle, PGlite-Storagegate, vollständiges TypeScript,
ESLint und Produktionsbuild bestehen. Die Ergänzung ändert nur Tests und den
lesenden Test-Probe für legitimes SQL-NULL vor dem Operationssnapshot; der
geprüfte Produktfix ist `73776e9dd`. Ein unabhängiger Subagent prüfte die
Harness-Sicherheitsgrenzen und ergänzte die negativen History-Nachweise.

PG-S19 bleibt für die übrigen Unterbrechungs-/Mehrprozessgrenzen offen. Keine
DB-/VM-/Container-Crashprüfung, kein aktuelles Produktionsimage und keine
vollständige doppelte Matrix werden daraus abgeleitet. Der einzelne Skill-
Stack blieb erhalten; nur der eigene App-Prozess auf 3000 wurde unterbrochen.
FVRC-1008 und P12 bleiben offen. Kein Push oder Rollout.

### Echter Prozessabsturz vor Beginn der Mutation

[Preparing crash results](proposal-preparing-crash-results.md) ergänzt zwei
Personal-/Team-Browserfälle auf dem verwalteten PostgreSQL: SIGKILL nach
dauerhafter Aktionsvorbereitung, aber vor dem ersten `preparing → applying`
Übergang. Unabhängige PG-Prüfung bei gestopptem Server belegt unveränderte
Bytes, Inhalt, Yjs-Proof und Sequenz. Startup-Recovery beendet den sicher
unangewendeten Auftrag; weder Mutation noch neue Revision oder Replay.

Der Browser klärt den verlorenen Auftrag per Statusabfrage. Anschließend
funktioniert eine neue ausdrückliche Annahme mit frischer Vorschau und neuem
Idempotenzschlüssel, genau einer Direct Connection und einer Revision. Alte
Retries bleiben fehlgeschlagen, neue Retries liefern denselben Erfolgsbeleg.
Der historische Vorschlag bleibt schreibgeschützt aufrufbar.

Der unabhängige Review fand zunächst einen Test-Hook-Fehler (initiale CAS-
Version `0` wurde ausgeschlossen). Er ist mit eigenem Regressionstest
korrigiert; der frühe fehlgeschlagene Browserlauf wird nicht verschwiegen.

Beide neuen E2Es und zwei wiederholte Post-Persistenz-Crashfälle bestehen.
15 Probe-Tests, vollständiges TypeScript, ESLint und Produktionsbuild mit
353 Seiten/Lizenzgate sind grün. Nur das Test-Harness und die Nachweise wurden
erweitert; keine Produktlogik, Dependencies oder Env-Dateien verändert.

Noch **nicht** gelöst: Nach dem Wechsel zu `applying`, aber vor beweisbarer
Persistenz kann die Recovery die Wirkung nicht sicher bestimmen. Dann bleibt
die Aktionsreservierung bestehen und kann weitere Annahmen blockieren. Kein
blindes Replay oder textbasierter No-effect-Schluss; separater abgesicherter
Recovery-/Fencing-Entwurf mit Peer-Reconnect-Tests nötig. PG-S19, FVRC-1008 und
P12 bleiben offen; keine vollständige Produktionsfreigabe.

### Lokale Synchronisierung vor dem Durable-Publication-Cutover

[Room mutation barrier results](room-mutation-barrier-results.md) dokumentiert
die gemeinsame Raum-Sperre für Writer-SyncStep2/Update und Direct Connections.
Zehn isolierte Fälle und acht echte Hocuspocus-Receiver-Szenarien prüfen
Reihenfolge, Fehlerfreigabe, Rechteentzug, unabhängige Räume und Store-/Disconnect-
Deadlocks. Nicht mutierender sowie Read-only-Verkehr bleibt bedienbar. Die
vollständige Lifecycle-Suite besteht; Browser-Regressionsbelege stehen im
verlinkten Ergebnisdokument.

Dies ist erst Schritt 1 des [Durable-Publication-Plans](durable-publication-plan.md).
Die sichere Reihenfolge „atomar speichern, dann veröffentlichen“ sowie Store-CAS,
Mehrprozess-Owner und Peer-Reconnect-Crashabnahme sind weiterhin offen. Keine
Freigabe ungewisser Legacy-Aufträge aufgrund bloßer Textgleichheit; FVRC-1008
und der manuelle Konflikteditor P12 bleiben offen.

### Monotone Stores und nachgelagerter Live-Abgleich

[Monotonic store results](monotonic-store-results.md) ergänzt den SQL-seitigen
Schutz: verzögerte Vorgänger ersetzen keinen neueren Snapshot, unabhängige
Änderungen und reine Löschungen werden unter einer echten PostgreSQL-Zeilensperre
vereinigt. No-ops erhöhen die Sequenz nicht, löschen keinen strukturellen
Fehlerstatus und erzeugen keine falsche History-Autorenschaft. Ein unklarer
Commit verwirft seine Verbindung; der folgende Retry bleibt idempotent.

Der Live-Raum gleicht sich erst unter seiner Mutationssperre ab, ohne dass
onStoreDocument darauf wartet. Reale Hocuspocus-Prüfungen belegen Erhalt
zwischenzeitlicher lokaler Änderungen, Schutz ersetzter Räume und ausbleibende
Disconnect-/Store-Deadlocks. PGlite und getrennte PostgreSQL-Backends bestehen;
Einzelheiten und das neue Größenlimit samt Rollout-Preflight stehen im Nachweis.
Mehrprozess-Owner und atomarer Kandidatencommit vor Live-Publish bleiben offen.
