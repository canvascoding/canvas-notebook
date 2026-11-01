# MCP operation reliability — Umsetzung und Abnahme

Stand: 2026-11-01. Ausgangspunkt: `origin/main`, separater Branch
`codex/mcp-operation-reliability`. Keine erneute Ausführung des Knowledge-Sync,
keine Änderungen an den abgeglichenen Produktionsdokumenten.

## Befund und Beweisgrenzen

Der lokale Nachweis `shopify2.0/output/knowledge-sync/2026-11-01/sync-ergebnis.json`
enthält 182 Operationen: 139 `created`, 40 Lifecycle-Busy, zwei
`MCP_INGEST_FAILED` und einen internen Fehler. Alle 100 Story-Hashes stimmen
laut Nachweis überein. Neun native Änderungen sind `confirmed`, ihre Projektion
ist `unconfirmed`. Dies ist kein Nachweis eines verlorenen nativen Commits.
Die genaue historische Fehlerphase ist ohne korrelierte Serverlogs unbekannt.

## Reihenfolge und Anforderungen

- [x] Plan im Repository speichern und aktuellen main als Basis verwenden.
- [x] 1. Create-/Import-Ausgang und Statusabfrage (Code und Integration; gemeinsame E2E unter 7)
  - Dauerhafte native Speicherung unabhängig von Projektion/Folgearbeiten melden.
  - Vorhandene Birth-/Receipt-Identität verwenden; keine zweite Schreibautorität.
  - Autorisierte, lesende Statusabfrage über denselben Idempotenzschlüssel oder
    Vorgangsbezug; fremde Verbindungen/Workspaces dürfen keine Belege lesen.
  - Bestätigte Identität und Version nur aus dauerhaften Belegen zurückgeben.
    Unbekannter Ausgang bleibt ausdrücklich unbekannt; Retry mit gleichem Key.
  - Tests: Fehler vor Commit, nach Commit, Projektionfehler, verlorene Antwort,
    Neustart, identischer Retry, abweichender Inhalt und entzogene Berechtigung.
- [x] 2. Lifecycle-Busy und sequenzielle Writes (Code und Integration; gemeinsame E2E unter 7)
  - Sperrbesitzer, Geltungsbereich und Freigabe einschließlich Abbruch prüfen.
  - Konflikt mit `retryable`, `retry_after_ms` und stabilem Vorgangsbezug ausgeben;
    gültige Requests nicht als Argumentfehler klassifizieren.
  - Bestehende Lifecycle-/Yjs-Schutzgrenzen erhalten.
  - Tests: mehrere sequenzielle Creates, Hintergrundprojektion, echte Konkurrenz,
    Abbruch und anschließender erfolgreicher Retry ohne Dubletten.
- [x] 3. Diagnosevertrag (Code und Integration; gemeinsame E2E unter 7)
  - Begrenzte Fehlerdaten: Code, correlation_id, Phase, Speicherstatus,
    Wiederholbarkeit und Vorgangsbezug soweit vorhanden.
  - Interne Details ausschließlich serverseitig; keine Inhalte, Tokens oder
    Download-URLs protokollieren. Unbestätigte Speicherung niemals als fehlend melden.
  - Tests: unerwartete Ausnahmen und Ausgabevalidierung vor/nach Persistierung.
- [x] 4. Sichtbare Tool-Schemas (Code und Integration; Client-E2E unter 7)
  - Read-Parameter am tatsächlichen tools/list- und Client-Ende prüfen.
  - Edit-Patches vollständig typisiert einschließlich Pflichtfeldern, Grenzen
    und Beispielen veröffentlichen; Adapter-Kompatibilität real testen.
  - Strikte Laufzeitvalidierung der jeweiligen Varianten beibehalten.
  - Tests: Discovery, Text/4096 Byte, Cursor, falsche Revision, Patchvarianten,
    ungültige Mischformen; lokalen Codex-Client und gehosteten Adapter unterscheiden.
- [x] 5. Große Bearbeitungsziele (Code und Integration; gemeinsame E2E unter 7)
  - Ziele unabhängig vom Inhaltsseitenlimit begrenzt paginieren oder gezielt
    nach Block/Abschnitt abrufen; keine vollständige übergroße Zielliste voraussetzen.
  - Fortsetzungen an Dokumentversion, Auswahl und aktuelle Leserechte binden.
  - Tests: großes strukturiertes Dokument, vollständige eindeutige Zielabdeckung,
    Versionswechsel und Berechtigungsentzug zwischen Seiten.
- [x] 6. Einheitliche Dokumentlinks (Code und Integration; Browser unter 7)
  - Create, Import und Edit liefern den tatsächlich adressierten Dokumentlink.
  - Zentralen Linkbuilder und autoritative Dokument-/Lineage-Identität verwenden.
  - Tests: Linkfelder und Öffnen im Browser nach Create/Import/Edit.
- [ ] 7. Zusammenhängende E2E-Abnahme
  - Fokussierte Contract-/PostgreSQL-Tests je Schritt; abgeschlossene Schritte committen.
  - Produktionsbuild vor Containerbuild. Nur ein verwalteter Notebook-Testcontainer;
    aktuellen Stand neu bauen und erstellen. Bestehende Daten nicht zurücksetzen.
  - Reale OAuth-/HTTP-MCP-Aufrufe, installierter Codex-MCP-Client und Playwright:
    Login, Discovery, Create/Status/Retry, Busy-Recovery, Edit, Zielpagination,
    Revisionkonflikt und Dokumentlink/Editor.
  - Nur synthetische Testdokumente. Fehlerfälle gezielt im isolierten Testharness
    auslösen; keine öffentlichen produktiven Fehler-Injektionsschalter.
  - Ergebnisse mit Commit/Image, Befehlen, Checkanzahl und Evidenzpfaden hier
    ergänzen. Kein grünes E2E behaupten, bevor der tatsächliche Lauf beendet ist.

## Umsetzungsergebnisse

### Schritt 1 — implementiert und integrationsgeprüft

Create und Import erhalten `action: "status"` mit `workspace_id`, `path` und
dem ursprünglichen `idempotency_key`, ohne `content` oder `file`. Die Abfrage
verwendet die aktuelle Create-/Import-Berechtigung auf der tatsächlichen
Datenbankverbindung. Sie startet weder einen Write noch eine Projektion.

`storage_status: confirmed` bezeichnet den nachgewiesenen ursprünglichen Commit;
`original_version` ist ausdrücklich nicht die Zusicherung des heutigen Inhalts.
`processing_status` unterscheidet `completed` und `unconfirmed`. Fehlende oder
nicht überprüfbare Belege ergeben `unknown`, niemals behauptete Nicht-Speicherung.
Bei geänderter physischer Birth-Identität bleibt die bestehende Integritätsprüfung
erhalten; es wird kein neuer Dateizustand aufgrund gleicher Bytes adoptiert.

Nach einem Fehler versucht der Handler eine neue, autorisierte Beobachtung des
passenden ursprünglichen Requests. Bei bestätigtem Commit lautet die Antwort
`outcome: stored`, mit Speicher-/Verarbeitungsstatus und `processing_error_code`.
Request-/Versionskonflikte und ein ausdrücklich nicht unterstützter nativer
Request bleiben Fehler. Normale erfolgreiche V1-Create-Antworten behalten ihren
bisherigen Dokument-/Currency-/Projektionsvertrag.

Bereits bestanden: fokussierter echter PostgreSQL/MCP-HTTP-Test für Status,
fehlenden Beleg, Identität/Hash, lesende Wirkung, falschen Pfad, wiederholten
Request und entzogene Rechte. Ein testseitiger Fehler nach echtem Receipt-COMMIT
und Connection-Release bestätigt Recovery mit derselben Dokument-ID; ein
anschließender Retry beendet die Projektion. Produktions-Typecheck und scoped
ESLint bestanden auch abschließend. Die vollständige native Create-/Import-Suite
besteht 15/15 Gruppen, einschließlich separatem Prozess, echtem HTTPS-Import,
abgebrochener Projektion, erneuerter OAuth-Session, Konflikten und Metadaten.
Container-/Browser-/Codex-E2E sind noch offen.

Evidenz (lokal, keine Produktionsdaten):

- `NODE_ENV=test CANVAS_POSTGRES_VECTOR_ENABLED=false node scripts/run-document-read-tool-dispatch-test.mjs scripts/mcp-ingest-status-postgres-test.ts`
  — `/tmp/canvas-mcp-ingest-status-final.log`, Exit 0.
- Derselbe Runner mit `scripts/direct-mcp-native-markdown-create-postgres-test.ts`
  — `/tmp/canvas-mcp-native-create-regression.log`, 15/15, Exit 0.
- `npm run build:release:typecheck` — `/tmp/canvas-mcp-status-final-types.log`, Exit 0.
- Scoped ESLint für Status, Ingest-Handler/-Service und neue Tests — Exit 0.
- GitNexus-Neuindizierung scheitert intern an `Failed calling LOWER: Invalid UTF-8`.
  `detect_changes` wurde über denselben LocalBackend mit explizitem Worktree
  ausgeführt; ergänzende direkte Diff-/Aufruferprüfung erforderlich, da der Index alt ist.
- Der ältere direkte `tsx`-Ingest-Unit-Harness scheitert beim Laden relativer
  Modulsubstitutionen (`./document-read-principal`); nicht als bestanden gewertet.

### Schritt 2 — implementiert und integrationsgeprüft

Busy-Antworten enthalten `retryable: true`, `retry_after_ms: 250`,
`phase: admission`, `correlation_id` und dieselbe `operation_id` wie ein späterer
erfolgreicher Create. Die ID wird erst aus einem verifizierten OAuth-Principal
gebildet. Die öffentliche MCP-Antwort ist ein fachlicher Tool-Konflikt, kein
JSON-RPC-InvalidParams. Eine zusätzliche Client-Einstufung muss im echten Client
geprüft werden.

Der bestehende native Create-Pfad wartet bereits bis zu vier Sekunden auf die
workspaceweite Admission-Sperre. Sie schützt auch Räume und Reservierungen;
die dedizierte Session wird im `finally` verworfen. Diese Sicherheitsgrenze
wurde nicht verengt. Derselbe Wartepfad ist bereits im Release 2026.10.31.1.
Die historischen 40 Konflikte sind ohne damalige Sperrhalter-/Phasenbelege nicht
auf einen bestimmten Freigabefehler zurückzuführen.

`scripts/mcp-ingest-busy-postgres-test.ts` besteht mit dem realen MCP-Dispatcher:
echte konkurrierende PostgreSQL-Sperre, korrekte Konfliktantwort, keine Anlage
vor Zulassung, Retry mit derselben ID, zwölf sequenzielle Creates unter kurzen
gemeinsamen Lesesperren sowie Abbruch und anschließender erfolgreicher Retry.
Log: `/tmp/canvas-mcp-busy-test.log`, Exit 0. Produktions-Typecheck
(`/tmp/canvas-mcp-busy-types.log`) und scoped ESLint: Exit 0.

### Schritt 3 — implementiert und integrationsgeprüft

Tool-Antwort und HTTP-Request-Historie verwenden dieselbe Korrelations-ID.
Bekannte Create-/Statusfehler und beobachtete Commit-Recoveries schreiben nur
begrenzte Diagnosefelder ins Serverlog: Code, ID, Phase, Speicherstatus,
Wiederholbarkeit und gegebenenfalls Vorgangs-ID. Fehlermeldungen, SQL, Tokens,
Pfade und Dokumentinhalte werden nicht übernommen. Vorhandene sichere
Projektionsphasen werden aus einer begrenzten primären Ursachenkette übernommen.

Der zentrale Tool-Dispatcher liefert bei unerwarteten Ausnahmen und internen
Protokollfehlern `MCP_TOOL_FAILED`, `storage_status: unknown` und
`retryable: false`: ein unbekannter Schreibausgang darf keinen blinden Retry
auslösen. Bekannte Parameter-/Protokollfehler bleiben erhalten.

- Echter SDK-Client/Server mit kontrolliert fehlschlagendem Handler:
  `node --conditions=react-server --import tsx --test scripts/mcp-tool-failure-test.ts`
  besteht; interne Fehler werden strukturiert, private Meldungen entfernt,
  Getter/Proxy-Werte nicht ausgeführt, echte InvalidParams bleiben Fehler.
- Echter PostgreSQL/MCP-HTTP-Status-/Recovery-Test besteht erneut, einschließlich
  Gleichheit von `correlation_id` und HTTP-`x-request-id`.
  Log: `/tmp/canvas-mcp-diagnostics-http.log`, Exit 0.
- Produktions-Typecheck (`/tmp/canvas-mcp-diagnostics-types.log`) und scoped
  ESLint: Exit 0. Der SDK-Test ist keine Browser-/Hosted-Connector-Abnahme.

Jede Anforderung oben benötigt passende aktuelle Laufzeitevidenz;
Quellcodeprüfung allein gilt nicht als Connector- oder Browser-Abnahme.

### Schritt 4 — implementiert und integrationsgeprüft

Der MCP-Edit-Eingang veröffentlicht alle Felder direkt am Objekt, statt sie in
einer Root-Union zu verstecken. Patch- und Blockvarianten verwenden `anyOf`
mit explizit typisierten Diskriminatoren, Pflichtfeldern und Grenzen. Beispiele
zeigen Textpatch, Blockpatch und Status. Die strikte Laufzeitdekodierung bleibt
unverändert; sie lehnt auch Mischformen ab, die eine flache Client-Deklaration
allein nicht ausschließen kann. Der PI-Schemavertrag bleibt unverändert.

- Vier Schema-/Vertragstests bestanden: `/tmp/canvas-mcp-schema-contract.log`.
- Neun echte PostgreSQL-/MCP-Dispatch-Gruppen bestanden, einschließlich
  tools/list, nativem Edit/Status, falschen Versionen, Mischformen und
  unverändertem Legacy-Edit: `/tmp/canvas-mcp-schema-dispatch.log`.
- Read-Schema-/Decoder-Vertragstests bestanden unverändert:
  `/tmp/canvas-mcp-read-schema.log` (direkter `tsx --test`-Runner).
- Scoped ESLint bestanden. Client-Projektion wird erst in Schritt 7 abgenommen.
- GitNexus: Produktions-Schemafunktion LOW; Testfunktion CRITICAL über einen
  veralteten indirekten Graph. Direkte Quellprüfung zeigt ausschließlich den
  lokalen Selbstaufruf der Testdatei; keine Produktionsaufrufer dieser Funktion.

### Schritt 5 — gezielter Blockabruf

`read_knowledge_source` ergänzt `edit_target_block_id`. Zusammen mit
`include_edit_targets: true` und der `expected_version` eines normalen nativen
Reads liefert es ausschließlich die Guards dieses sichtbaren Blocks. Die
Block-ID stammt aus dem nativen Inhalt. Eine unbekannte ID liefert eine leere
Zielliste. Inhalt und vollständige Zielliste werden dabei nicht ausgegeben.

Der bestehende Byte-Cursor paginiert bei Bedarf die ausgewählte Zielantwort.
Sein Body-Hash bindet auch die Blockauswahl; Dokumentversion, Metadaten und
aktuelle Autorisierung bleiben auf jeder Seite geprüft. Ein anderer Block oder
geänderte Version weist den alten Cursor mit `DOCUMENT_VERSION_CONFLICT` zurück.

Es wird keine vollständige Guardliste erzeugt oder nachträglich abgeschnitten.
Nur das gewählte Teilbaum-Hash und nötige Tabellen-Guards werden berechnet.
Die strukturellen und privaten History-Grenzen bleiben erhalten (unter anderem
2048 Records/Placement-Einträge). Für den gezielten Abruf gelten begrenzte
Quellbudgets von 8 MiB Zustand und 5 MiB Text; ausdrücklich kleinere interne
Budgets werden weiterhin nicht angehoben. Ziel-JSON bleibt auf 64 KiB begrenzt.
Der bisherige Vollabruf und die normalen Leseantworten bleiben unverändert.

Abnahme: neun reine Guard-/Selector-Gruppen inklusive 600-Blöcke-Dokument und
Tabellenvergleich; echter PostgreSQL-/HTTP-Abruf von 200 eindeutigen Zielen
über dem Vollabruflimit, Cursorwechsel, entzogener Workspace-Grant und echte
Änderung des gespeicherten Yjs-Zustands zwischen Seiten. Alle bestanden.
Evidenz: `/tmp/canvas-mcp-target-unit.log`, `/tmp/canvas-mcp-target-postgres.log`.
Die 15 bestehenden Read-Dispatch-Gruppen bleiben grün
(`/tmp/canvas-mcp-target-read-regression.log`), ebenso Read-Vertragstests,
Produktions-Typecheck und scoped ESLint. Kein produktives Dokument verändert.

### Schritt 6 — native Ergebnislinks

Native V1-Create-/Import-Antworten enthalten zusätzlich `document_url` aus dem
zentralen Linkbuilder und der tatsächlich zurückgegebenen Dokumentidentität.
Native Edit-/Status-Antworten enthalten denselben Feldnamen mit stabiler
Dokument-/Lineage-ID. Weil historische Edit-Belege keinen aktuellen Pfad
beweisen, löst Notebook den aktuellen Pfad beim Öffnen anhand dieser IDs auf.
Es werden weder Pfade geraten noch zusätzliche Lese-/Schreibrechte abgeleitet.
Die MCP-Ausgabedeklaration wurde erweitert; der interne strikte V1-Beleg und
PI bleiben unverändert.

Neun Edit-Dispatch-Gruppen und 15 native Create-/Import-Gruppen bestehen,
einschließlich echten HTTPS-Imports und wiederholter Requests. Alle nativen
Ergebnisse werden auf Workspace, Dokument-ID, Lineage und Create-Pfad geprüft.
Logs: `/tmp/canvas-mcp-links-edit.log`, `/tmp/canvas-mcp-links-create-import.log`.
Produktions-Typecheck und scoped ESLint bestanden. Das tatsächliche Öffnen
im neu gebauten Container wird im gemeinsamen E2E geprüft.
