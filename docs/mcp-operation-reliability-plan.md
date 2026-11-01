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
- [ ] 2. Lifecycle-Busy und sequenzielle Writes
  - Sperrbesitzer, Geltungsbereich und Freigabe einschließlich Abbruch prüfen.
  - Konflikt mit `retryable`, `retry_after_ms` und stabilem Vorgangsbezug ausgeben;
    gültige Requests nicht als Argumentfehler klassifizieren.
  - Bestehende Lifecycle-/Yjs-Schutzgrenzen erhalten.
  - Tests: mehrere sequenzielle Creates, Hintergrundprojektion, echte Konkurrenz,
    Abbruch und anschließender erfolgreicher Retry ohne Dubletten.
- [ ] 3. Diagnosevertrag
  - Begrenzte Fehlerdaten: Code, correlation_id, Phase, Speicherstatus,
    Wiederholbarkeit und Vorgangsbezug soweit vorhanden.
  - Interne Details ausschließlich serverseitig; keine Inhalte, Tokens oder
    Download-URLs protokollieren. Unbestätigte Speicherung niemals als fehlend melden.
  - Tests: unerwartete Ausnahmen und Ausgabevalidierung vor/nach Persistierung.
- [ ] 4. Sichtbare Tool-Schemas
  - Read-Parameter am tatsächlichen tools/list- und Client-Ende prüfen.
  - Edit-Patches vollständig typisiert einschließlich Pflichtfeldern, Grenzen
    und Beispielen veröffentlichen; Adapter-Kompatibilität real testen.
  - Strikte Laufzeitvalidierung der jeweiligen Varianten beibehalten.
  - Tests: Discovery, Text/4096 Byte, Cursor, falsche Revision, Patchvarianten,
    ungültige Mischformen; lokalen Codex-Client und gehosteten Adapter unterscheiden.
- [ ] 5. Große Bearbeitungsziele
  - Ziele unabhängig vom Inhaltsseitenlimit begrenzt paginieren oder gezielt
    nach Block/Abschnitt abrufen; keine vollständige übergroße Zielliste voraussetzen.
  - Fortsetzungen an Dokumentversion, Auswahl und aktuelle Leserechte binden.
  - Tests: großes strukturiertes Dokument, vollständige eindeutige Zielabdeckung,
    Versionswechsel und Berechtigungsentzug zwischen Seiten.
- [ ] 6. Einheitliche Dokumentlinks
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

Jede Anforderung oben benötigt passende aktuelle Laufzeitevidenz;
Quellcodeprüfung allein gilt nicht als Connector- oder Browser-Abnahme.
