# Native Dateiaktionen trotz nicht exportierbarer Markdownprojektion

Stand: 19. Oktober 2026; unveränderte Produktbasis Root `3b02a4e0ac558df4aa23c122622a1e059bc11219`. Dieser Teilschritt ergänzt einen tatsächlich ausgeführten Abnahmenachweis. Anwendungscode wurde dafür nicht geändert.

## Tatsächlicher Fall und Ergebnis

Der neue Test `scripts/workspace-operation-unexportable-native-path-public-postgres-test.ts` wird ausdrücklich durch `scripts/workspace-operation-unexportable-native-path-public-runner-test.ts` ausgeführt. Er verwendet die bestehende echte Metadata-Owner-Fixture, tatsächliche signierte JWTs, aktuelle SQL-Rechte und die öffentlichen MCP-Move-/Delete-Serviceexports. Es werden keine Principals, SQL-Ergebnisse oder Mutationsadapter ersetzt.

Der Upload legt echte Dokument- und Lineage-IDs an. Der Rich-Codec serialisiert zuvor gültige Testquelle in die tatsächlich rich-importierbare Form. Erst im klar abgegrenzten privaten Fixtureaufbau erhalten die legalen Tabellenzellen `colwidth: [120]` samt entsprechendem echtem Yjs-Zustand/Vektor und dauerhaftem Clock. Der gewöhnliche Projektor schlägt danach wirklich mit `COLLABORATION_ROUNDTRIP_UNSTABLE`, `snapshot_validate`, `roundtrip_unstable`, `permanent=false` fehl; der echte Diagnosepfad speichert diesen Befund.

Die Folge besteht für zwei physisch verschiedene Fälle: fehlende Projektion (`ENOENT`) und echte reguläre 0-Byte-Datei mit eigenem Inode und SHA-256 der leeren Bytes. Jeweils:

1. Vollständiger Native-ID-Read gelingt; ausdrücklich angeforderter Markdown-Read bleibt abgewiesen.
2. Ein normales Keep-Dokument wird verschoben. Das fehlerhafte Rich-Dokument bleibt unselektiert; sein Tabellenlink sowie der Keep-Link einer weiteren Notiz werden zentral geändert. Die fehlende beziehungsweise unverändert leere Projektion und die Rich-ID bleiben erhalten.
3. Anschließend wird das Rich-Dokument selbst in einen vorhandenen Ordner verschoben. Ausgehender Tabellenlink und eingehender Link werden korrekt geändert; vollständiges natives JSON, Tabellenattribute und stabile Block-/Dokument-/Lineage-IDs stimmen bis auf genau die verlangten href-Deltas überein.
4. Delete archiviert dieselben IDs bei exakt gleichem Yjs-Binary und Vektor des zuvor verschobenen Zustands. Der eingehende Link-Mark wird entfernt; Text und anderer Keep-Link bleiben erhalten. Die archivierte ID ist öffentlich nicht mehr aktiv lesbar, historischer Status bleibt bestätigt.

**Final: 12/12 Gruppen, 14/14 NoWrite-Fenster, ursprünglicher Exit 0.** Die NoWrite-Fenster prüfen SQL einschließlich NOTIFY/pg_notify, vollständige private Schemazeilen mit `xmin` und OIDs sowie den vollständigen DATA-Baum mit FD-Identitäten, Modi, Zeiten, Größen und Bytes. Alle Orakel laufen auch bei vorherigem Fehler. Strikter Export bleibt vor und nach beiden Moves sowie nach Archivierung fehlerhaft. Der archivierte Inhalt wird mit dem tatsächlichen Archived-Native-Inspector gelesen; kein gefälschter Aktivstatus wird eingesetzt.

## Quellenbindung und Originale

Finale gezielte TypeScript-Prüfung: Exit 0 nach 18,657 Sekunden; warnungsfreies Scoped-ESLint: Exit 0 nach 1,893 Sekunden; tatsächlicher PG-/FD-Lauf: Exit 0 nach 76,484 Sekunden. Alle **4.169** gebundenen Produkt-/Test-/Typ-/Paketquellen sind zwischen Start und Ende identisch.

| Beleg | SHA-256 |
| --- | --- |
| Finaler Test | `eb39e65976d9b9a17db6fc5b9f842cb12d64c1f425b585a6b7a341f49f0b0f49` |
| Tatsächlich ausführender Runner | `490bcb058c0940db42f12d3ff955e8add9e409133ec8ba1ecc59b63ba22b2bad` |
| Originales `terminal.json` | `27caf28f90b168d33dbfa1f2be56622921c0460c5334fc1d340bc0ea0bc5df85` |
| Unabhängiger Ressourcenabschluss | `4aca7c1cdd25b32611d6ba7eb8c4b4693daee9b3092fc4d9af433c1e92cdffe7` |

Private Originale: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-unexportable-owner-928mm__y/run3`. Der erste Lauf im Elternordner bleibt mit Exit 1/0 Gruppen erhalten: Upload fiel wegen zunächst nicht kanonischer Quelle absichtlich auf Plain Text zurück. `run2` bleibt mit Exit 1/0 Gruppen und einem NoWrite-Fenster erhalten: Der erste vollständige Native-Read verglich interne Null-Prototyp-Attribute mit übertragenem JSON. Die enge Fixture-/JSON-Wertkorrektur erhält sämtliche JSON-Inhalte und Array-Reihenfolgen; die Wireantwort bleibt ungefiltert. Das zuvor unabhängig geprüfte erwartete Unlink-Baumorakel berücksichtigt die normale Zusammenführung benachbarter Textknoten. Keine dieser Testkorrekturen verändert das Produkt oder repariert den bewusst erhaltenen Exportfehler.

Die drei unabhängigen Ressourcenabschlüsse bestätigen entfernte eigene Schemas/OIDs, geschlossene eigene Sitzungen und Fixture-Pools, entfernte eigene DATA-Bäume sowie beendete Originalprozesse. Die vier verwalteten Dienste behalten Identitäten und gesunden Zustand. Kein Container wurde gebaut oder neu gestartet.

Der zunächst inkrementelle GitNexus-Neuaufbau scheiterte mit `LOWER: Invalid UTF-8`; der anschließende reine vollständige Indexneuaufbau besteht mit Exit 0, 100.800 Knoten und 284.097 Kanten. Er verändert keine Anwendungsquellen oder AGENTS-Dateien. Neue Testfunktionen bleiben als nicht indizierte neue Symbole mit UNKNOWN-Impact ausgewiesen; das ist keine Nullrisiko-Aussage.

## Genaue Grenze

Dies ist eine strukturell passende erhaltene lokale Rich-colwidth-Gegenprobe. Das ursprüngliche Produktionsbinary liegt nicht vor; weder dessen konkrete Codecursache noch eine heutige Produktionsdateiaktion oder Auslieferung werden damit behauptet. TCP/HTTP, Browser, Raw-Importvorbereitung und der gesamte MVP sind durch diese Folge nicht abgenommen. Root-Aktivierung bleibt `false`; Dateiaktions-Undo und Review Center bleiben aus. Nächster M1-Schritt sind die noch fehlenden aktionsgebundenen Raw-Import-/Linkwege im [MVP-Launchplan](./yjs-document-authority-mvp-launch-plan.md).
