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
- [ ] 1. Create-/Import-Ausgang und Statusabfrage
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

Noch offen. Jede Anforderung oben benötigt passende aktuelle Laufzeitevidenz;
Quellcodeprüfung allein gilt nicht als Connector- oder Browser-Abnahme.
