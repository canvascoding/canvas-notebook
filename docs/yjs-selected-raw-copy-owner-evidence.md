# Tatsächlicher Zielimport beim Kopieren von Raw-Markdown

Stand: 19. Oktober 2026; Arbeitsbasis Root `a41c09417`. Dieser Teilschritt schließt ausgewähltes Raw-Copy und erklärt den gesamten MVP nicht als freigegeben.

Der öffentliche MCP-Service kopiert eine nur lesbare Markdownquelle durch denselben Copy-Owner. Stage 6 hält echte Originalbytes; B1 importiert alle Ziele auf derselben tatsächlichen PostgreSQL-Verbindung und Transaktion. Unveränderliche Birth-Belege binden die ursprünglichen Imports an den Copy-Parent. Erst daraus entstehen echte native Linkreferenzen. B2 bestätigt den vollständigen Graphen und die Veröffentlichung. Eine neue Sitzung kann ausschließlich diese ursprünglichen Fakten wiederaufnehmen.

Ein führendes BOM ohne Frontmatter erzeugte zunächst falsche UTF16-Linkpositionen. Local-/Physical-Parser 3 korrigieren genau diese neue Variante. Frische Copy-Beobachtungen wählen sie ausdrücklich, gespeicherte Vorgänge wählen ihre ursprüngliche Parserkennung. Die alten Varianten und ihre Hashformeln bleiben erhalten. Ein zweiter Fehler verlor den kanonischen Datenbankkontext nach C1-COMMIT im Statusleser. Dessen geprüfter Kontext bleibt nun für die Lebensdauer derselben Verbindung bestehen; die Verbindung wird anschließend auch bei Erfolg verworfen.

## Tatsächlich ausgeführte Abnahme

- `scripts/workspace-operation-selected-raw-copy-postgres-test.ts`: **8/8** echte Service-/PG18-/FD-Gruppen. READ-only-Quelle, zwei echte Zielimporte auf demselben B1-Backend/XID, unveränderliche Belege, echte Ziel-ID-Reads und genaue Selbst-/gegenseitige Links, Source-/Katalogdrift, No-Delta-Ziel, verlorene B1-Bestätigung, SID-B-Recovery und nicht schreibende Status-/Wiederholungsabrufe bestehen.
- Dieselbe finale Folge prüft **zwei** tatsächliche Raw-Birth-Projektorsperren vor B2 und die Freigabe derselben Identitäts-/Publikationsguards nach B2. Native Clone-Dokumente im Parent sind dabei leer; die Probe trifft den neuen Raw-Birth-Zweig. Die freigegebene Seite liest nur Guards und behauptet keinen fertigen formatierten Export.
- Bestehende echte Owner-/öffentliche MCP-Dispatcherfolgen: **10/10** und **6/6**. Bestehender Stage-/Storelauf: **6/6**. Planung, Stage und Binder bestehen ihre reinen **8/7/9** Familien; Blockfragment-Grenzen und Kontrollen bestehen **18** Fälle.
- BOM-Parsermatrix: acht Grundvarianten, acht Fälle am Zeilenanfang, zwei Doppel-BOM-Fälle, ein expliziter historischer EOF-Gegenfall und eine Metadatengruppe mit vier Quellen. Doppel-BOM wird damit grammatisch geprüft; daraus folgt keine vollständige native Doppel-BOM-Importfreigabe.
- **864** direkte JSON-Bytevergleiche zwischen separaten tatsächlichen alten und aktuellen Legacy-Parser-/Physical2-Modulen sowie **738** alte/aktuelle V2-/V3-Planner-/Compilervergleiche sind gleich. Zusätzlich bestehen **37** vorhandene Node-Tests.
- Finale gezielte TypeScript- und Scoped-ESLint-Prüfung bestehen ohne Warnung. Alle kontrollierten Quellen bleiben zwischen Start und Ende des jeweiligen Laufs identisch.

## Erhaltene Originale

Private Originalausgaben, vollständige Quellpins und Terminalbelege liegen unter `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-copy-birth-z_ax5eva/`: `owner6-validation7` enthält den echten Statusfehler nach vier abgeschlossenen Gruppen; `owner6-validation8-red-status` erhält dessen tatsächlichen Stack. `owner6-validation9` besteht die erste vollständige Acht und Stage-Sechs; `owner6-validation10-regressions` enthält die bisherigen Owner-/Dispatcherfolgen; `owner6-validation11-projector` enthält die finale Acht mit Projektorsperren sowie Typen/Lint. Die anfänglichen BOM-/Principal-Gegenproben in `owner6-validation1` bis `6` bleiben erhalten.

Der historische Planner-/Compilervergleich liegt in `plan5-parity3-owner6`; der separate Legacy-Parser-/Physical2-Vergleich in `/private/tmp/canvas-local-link-legacy-parity-candidate-hLSJwuAp`. Unabhängige Ressourcenprüfungen bestätigen die entfernten eigenen Schemas/OIDs, geschlossenen eigenen Sitzungen, beendeten Originalprozesse und entfernten Fixture-Dateien. Die vier verwalteten Dienste bleiben unverändert gesund; kein Container wurde gebaut oder neu gestartet.

## Verbleibende Freigabegrenzen

Rich-native Blockfragmentziele, deren neue Block-ID nicht sicher auflösbar ist, werden vor B1 ausdrücklich gesperrt. Weitere notwendige rohe Linkänderungen und Move-/Delete-Vorbereitung sowie der ursprüngliche Produktionsgegenfall sind nicht durch diese Copy-Probe abgenommen. Keine neue gemeinsame Browserfolge oder vollständige Produktionsbuild-Abnahme wird hier behauptet. Root-Aktivierung bleibt `false`, Dateiaktions-Undo und Review Center bleiben aus. Interner Agenten-Create-Weg, verpflichtender Linux-Schreibschutznachweis und die gemeinsame finale Abnahme bleiben Launch-Gates im [MVP-Plan](./yjs-document-authority-mvp-launch-plan.md).
