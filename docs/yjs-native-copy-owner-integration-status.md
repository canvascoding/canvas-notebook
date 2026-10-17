# Nativer Copy-Owner: Integrationsstand und offene Laufzeitgrenze

## Geltungsbereich

Der neue feste Owner, die gemeinsame Clone-/Linktransaktion, die vorbereitete Dateisystemveröffentlichung, historische Wiederaufnahme sowie Service und HTTP-Vorschau sind im Worktree in Integration. Dies ist noch keine abgeschlossene Copy-Abnahme. Der allgemeine Aktivierungsgate bleibt aus; es gibt keinen Produktionsrollout. Dateiaktions-Undo und Review Center bleiben ausgeschaltet.

## Bestätigte Korrekturen

- Die ursprüngliche native V2-Ablage und Shared-Parent-Veröffentlichung sind separat committed und geprüft: Stage 15/15, bisherige V1-Regression, bisherige Copy-Folge 33/33 und Shared-Parent 9/9.
- Die finale Graphprüfung verwendet die wirkliche `registry:`-Identität des Collectors; die korrigierte Gegenprobe besteht 22/22.
- Der echte PG-Test initialisiert neue Workspaces über denselben Starterinitialisierer wie die API. Der vorher ausgelassene Initialisierungsschritt ist eine Harnesskorrektur. Der originale Negativfall für uninitialisiertes physisches Markdown bleibt erhalten.
- Beim Abschluss einer nativen Kopie wurde innerhalb eines bereits aktiven Borrowed-Writers ein zweiter Journal-Borrower geöffnet. Das scheiterte mit `JOURNAL_TRANSACTION_CHANGED`. Der eigene Reservation-Check liest jetzt ausschließlich den originalgebundenen Header, ohne einen zweiten Borrower zu öffnen. Der gemeinsame Abschluss von Veröffentlichung, Journal und Admission-Outcomes ist danach in echten Fällen bestanden.
- Service und direkter Owner normalisieren echte Web-Requests vor der lokalen `NextRequest`-Nominalgrenze. Eine zweite tatsächliche NextRequest-Konstruktorinstanz scheiterte zuvor im Service. Der identische neue Test besteht nach dem schmalen Adapterfix; Service/Public besteht 23/23. Bloße Datenobjekte bleiben abgewiesen, Credentials werden vor dem ersten Await kopiert und echte Authentifizierung bleibt unverändert.

## Aktueller roter Integrationsnachweis

Der tatsächliche vollständige Auftrag umfasst 25 Gruppen. Die letzten beiden Läufe enden jeweils mit Exit 1: vier bestanden, die fünfte fehlgeschlagen und die übrigen 20 nicht gestartet. Bestanden sind der erhaltene Starter-Negativfall, Plain-Text-Kopien innerhalb und zwischen Workspaces sowie eine Rich-Text-Kopie innerhalb eines Workspaces. Die workspaceübergreifende XML-Rich-Text-Kopie scheitert in B1 am PostgreSQL-Transaktionslimit (`25P04`).

Im zweiten dieser Läufe bleibt eine genuine Principal-Komposition für die gesamte kurze Phase geöffnet. Vor und nach jedem festen Schreibschritt werden weiterhin tatsächlicher Owner und B/XID geprüft. Die echten ACL-/Session-Exitprüfungen einschließlich source READ → destination WRITE → source READ bleiben erhalten. Der unabhängige Quellreview findet dazu keinen konkreten P1/P2; der Laufzeitnachweis ist weiterhin rot. Die ursprüngliche Fünf-Sekunden-Grenze wird nicht erhöht.

Die zusätzliche reine JS-Messung belegt für diesen Lauf:

| Tatsächliche Phase | Dauer | Querydispatches | Ergebnis |
| --- | ---: | ---: | --- |
| B0, ursprünglicher Header | 506,835 ms | 153 Produkt + 1 Fixture | committed |
| B1, Clone-/Linkphase | 6.718,303 ms | 436 Produkt + 24 Fixture | SQL-Fehler, vollständig zurückgerollt |
| B2, Veröffentlichung/Abschluss | nicht gestartet | — | — |
| Getrennte Recoverymarkierung | 187,551 ms | 297 Produkt + 1 Fixture | committed |

Die Einheit zählt tatsächlich dispatchte Queryaufrufe, nicht die Zahl einzelner SQL-Statements in kombinierten Queries. Die Dauer der vollständigen Stage-Nachlese im Test-ACK ist noch nicht separat erfasst. Die gemessenen Queryzahlen allein beweisen daher keinen CPU- oder Netzwerkanteil.

Originalbelege des letzten Laufs liegen privat unter `/private/tmp/cnco-7nmis_4s/`:

- `results.json`: SHA-256 `0205f84cb2f087139af7321515b54f51399de7399ec69bccb9c63a403f9a6c6c`.
- `transaction-analysis.json`: SHA-256 `b218fde3115ccbd02885f3f54def58e49984feb9ac06e10395d2beff1601e134`.
- Alle 48 Produkt-/Testpins sind zwischen Start und tatsächlichem Terminal unverändert. Die Belege werden nicht nachträglich als grün ausgegeben.

## Nächste Abnahme

Zuerst werden im unveränderten roten Produktpfad tatsächliche SQL-Wartezeit, Prozess-CPU und die vorhandene Fixture-Stage-Nachlese getrennt gemessen. Ein privates CPU-Profil soll die mehrfachen reinen Compiler-/Yjs-Replays zuordnen. Erst danach wird über weitere Produkt- oder Harnessoptimierung entschieden. Keine Berechtigungsprüfung, Assertion, Originalbindung oder Timeoutgrenze wird für einen grünen Lauf entfernt.

Danach fehlen der vollständige 25-Gruppen-Pass, die unveränderte Lifecycle-Guard-Regression, finale Typ-/Lintprüfung, der saubere QA-Anschluss mit frischem Produktionsbuild und echte Desktop-/Mobile-Copy-Abnahme. Die Copy-Metadatenpolitik ist ebenfalls noch offen. Neue Browserfälle werden parallel vorbereitet; sie sind noch nicht ausgeführt.

Gemeinsame Create-/Read-/Edit-Pfade über API/MCP/PI/Mobile, progressive Suche mit stabilen Dokument-IDs, SDK/Standard-Skill, PDF-Anlage, Sandbox und Gesamt-E2E bleiben im vollständigen Auftrag. Frühere Browserpässe sind ausschließlich an ihre damaligen Quellen und Builds gebunden.
