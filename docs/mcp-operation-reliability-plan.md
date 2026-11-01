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
- [x] 7. Zusammenhängende E2E-Abnahme
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
  Modulsubstitutionen (`./document-read-principal`); der Harness wurde später in
  Schritt 7 repariert und die vollständige Ingest-Suite erfolgreich wiederholt.

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
- Produktions-Typecheck und scoped ESLint bestanden. Client-Projektion wird
  erst in Schritt 7 abgenommen.
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

### Schritt 7 — abgeschlossene gemeinsame Abnahme

Vor dem Containerlauf wurde eine veraltete lokale `node_modules`-Installation
festgestellt (unter anderem Next 16.3.8 statt Lockfile 16.4.3). `npm ci` hat sie
ersetzt, ohne den Lockfile zu ändern. Danach bestehen Lizenzinventar und alle
gezielten Regressionen erneut mit den tatsächlich festgelegten Abhängigkeiten:

- Status/Commit-Recovery: `/tmp/canvas-mcp-final-status.log`.
- Busy/Konkurrenz/Abbruch/12 sequenzielle Writes: `/tmp/canvas-mcp-final-busy.log`.
- Diagnose-SDK-Test und Schema-Verträge: `/tmp/canvas-mcp-final-diagnostics.log`,
  `/tmp/canvas-mcp-final-schema.log`.
- Neun Guard-Gruppen und 200 echte gezielte HTTP-Abrufe mit Versions-/ACL-Wechsel:
  `/tmp/canvas-mcp-final-target-unit.log`, `/tmp/canvas-mcp-final-target-http.log`.
- 9 Edit-, 15 Create-/Import- und 15 Read-Dispatch-Gruppen:
  `/tmp/canvas-mcp-final-native-document-edit-tool-dispatch-postgres-test.log`,
  `/tmp/canvas-mcp-final-direct-mcp-native-markdown-create-postgres-test.log`,
  `/tmp/canvas-mcp-final-document-read-tool-dispatch-postgres-test.log`.
- Der ältere Ingest-Tool-Harness wurde auf relative Modulauflösung und die
  aktuellen Abhängigkeiten aktualisiert: 10/10, `/tmp/canvas-mcp-legacy-ingest-unit.log`.
- Upload-Schema über denselben Bundle-Runner: 2/2,
  `/tmp/canvas-mcp-final-upload-schema.log`. Validation-, Download- und
  Settings-/UI-Vertragstests ebenfalls bestanden.

Der vollständige Sammelbefehl `npm run test:mcp:file-ingest` besteht jetzt
(`/tmp/canvas-mcp-final-ingest-suite.log`): Upload-Schemas, Inhaltsvalidierung,
Download, 25 Journal-/Tool-Tests und Settings-/UI-Verträge. Dafür wurden zwei
bestehende Harness-Probleme korrigiert: der Upload-Test verwendet den vorhandenen
Bundle-Runner für die ESM-Paketexporte, und die lexikalische Pfaderwartung
unterscheidet den wörtlichen Namen ` .private/note.md` vom verbotenen
`.private/note.md`. Produktive Pfadnormalisierung und Berechtigungen bleiben
unverändert; daraus wird keine erfolgreiche Veröffentlichung in solchen
Verzeichnissen abgeleitet.


#### Produktionsbuild und reale Connector-Abnahme

`npm run build` und der anschließende verwaltete Docker-Build bestanden.
Das laufende Image ist
`sha256:c7454a1b812de81b9c0022315b4a782c0372dc30d0bf6fd8a0b1785fd12e7318`.
Alle 15 geänderten Anwendungsdateien wurden bytegenau gegen das Image geprüft:
`artifacts/mcp-operation-reliability/image-source-verification.json`.
Die späteren Änderungen betreffen ausschließlich Test-Harness und Dokumentation.

Die endgültige Browser-/OAuth-/HTTP-Abnahme besteht mit 15 Schritten:
`artifacts/mcp-connector/0c49c7c4-3ba7-4c08-84fe-b5e4b1be379d/report.json`.
Der installierte `codex app-server` besteht dieselben zusätzlichen Reliability-
Prüfungen einschließlich seines tatsächlichen Tool-Katalogs:
`artifacts/mcp-connector/0c49c7c4-3ba7-4c08-84fe-b5e4b1be379d/codex-client-report.json`.
Logs: `/tmp/canvas-mcp-reliability-browser.log` und
`/tmp/canvas-mcp-reliability-codex.log`.

Nachgewiesen sind OAuth-DCR/PKCE, Workspace-Grant, Schema-Discovery, Textformat
mit exakt 4096 Bytes, Versions-/Hash- und Such-Cursor, vollständige Ersetzung,
Upload mit echtem Container-Neustart und SHA-256, Manifest, native Create-
Statusabfrage und idempotenter Retry sowie beide typisierten nativen Patchformen.
Ein großes Rich-Text-Dokument überschreitet das Vollabruflimit für Edit-Ziele;
sein ausgewählter Block ist trotzdem mit 64-Byte-Fortsetzungen lesbar.
Eine spätere Änderung verwirft den alten Cursor. Create-Link und ID-basierter
Edit-Link öffnen im echten Editor den bestätigten Inhalt `Reliability AFTER`.
`native-operation-link.png`, `document.png` und `settings.png` wurden zusätzlich
visuell geprüft. Es wurden keine Modell-Turns gestartet. Testverbindungen wurden
anschließend widerrufen; der lokale Codex-Testlogin wurde abgemeldet.

Wiederholung im vorbereiteten, source-verifizierten Teststack:

```sh
node --import tsx scripts/mcp-connector-read-search-e2e.mjs
node --import tsx scripts/mcp-local-codex-client-e2e.mjs <neuer-report.json>
```

Der Restart-Test verlangt die Image-Prüfdatei und die private `fixture.json`
unter `~/.local/state/canvas-local-team-seat/mcp-operation-reliability-runtime`.
Er prüft Image-ID und eigenes Datenverzeichnis, bevor er den Container neu startet.

#### Testumgebung und verbleibende Grenzen

Es lief genau ein Notebook-Testcontainer im vorhandenen verwalteten Stack.
Für die Abnahme wurden eine eigene PostgreSQL-Datenbank und ein eigenes
Datenverzeichnis verwendet. Die alte gemeinsame Testdatenbasis blieb erhalten:
Ihr historischer Birth-Namespace stimmte nicht mehr mit der aktuellen Mount-
Identität überein. Es wurden keine Identitätsanker zurückgesetzt oder umgeschrieben.
Die frische Instanz erhielt über den regulären Control-Plane-Aktivierungsweg eine
Development-Team-Lizenz und läuft im Team-Modus. Der vollständige allgemeine
Fixture-Bootstrap scheiterte weiterhin bei der nicht benötigten zweiten
Mitgliedschaft mit `TEAM_SEAT_RECONCILIATION_REQUIRED`; diese Einschränkung wird
nicht als bestandener Zwei-Benutzer-/Seat-Test ausgegeben. Die MCP-Abnahme verwendet
den Bootstrap-Admin mit einem eigenen synthetischen Workspace. Health meldet
PostgreSQL, MCP und Collaboration bereit.

Ein erster großer Testtext enthielt abschließende Leerzeichen und wurde im
verlustfreien Quelltextmodus angelegt. Der abschließende Block-Test verwendet
kanonisches Rich-Markdown und prüft ausdrücklich `tiptap_blocks`.

Die gehostete ChatGPT-Schemaumwandlung und die Produktionsinstanz wurden nicht
mit diesem neuen Stand geprüft. Der Stand wurde nicht veröffentlicht oder deployed.
Die genaue Ursache aller historischen 40 Busy-Antworten bleibt ohne damalige
korrelierte Logs offen; reale Sperrkonkurrenz, Freigabe, Abbruch, Retry und
sequenzielle Writes wurden geprüft. Knowledge-Sync und Produktionsdokumente
wurden nicht verändert.


### Nachtrag zur PR-/Release-Abnahme

PR #199 wurde nach vollständig erfolgreicher CI und Prüfung aller Kommentar-
und Review-Endpunkte am 2026-11-01 gemergt (Merge `85fc78794460cbc6405d90f87a3ad106503c6ede`).
Es lagen keine offenen Review-Threads vor. Der oben beschriebene allgemeine
Fixture-Blocker wurde anschließend durch einen frischen, nicht abrechenbaren
Seat-Quote und reguläre Aktivierung behoben: zwei aktive Benutzer, gemeinsamer
Workspace und Ollama-Verifikation sind bestätigt.

Zusätzlich wurde `npm run test:all` vollständig ausgeführt. Browser-Ergebnis:
310 bestanden, 272 regulär übersprungen, 17 fehlgeschlagen, 1 nicht ausgeführt.
Nach Korrektur der lokalen Fixture-Konfiguration (Shared Test Workspace,
Sekundärbenutzer, PostgreSQL über 127.0.0.1:55433 und interner Browser-Port 3000)
bestanden alle 17 gezielten Wiederholungen; der abhängige Folgetest bestand
anschließend separat. Ein Auth-429 und ein Studio-Retry-Timing waren im
Einzellauf nicht reproduzierbar. Es wurden dafür keine Produktdateien geändert.

Logs: `/tmp/canvas-mcp-pr199-test-all.log`, `/tmp/canvas-mcp-pr199-recheck.log`,
`/tmp/canvas-mcp-pr199-followup.log`, `/tmp/canvas-mcp-pr199-fixtures.log`.
Die ausgelassenen Tests werden ausdrücklich nicht als bestanden ausgewiesen.
