# Raw-Move/Delete: öffentlicher MCP-Anschluss

Stand: 20. Oktober 2026. Arbeitsbasis Root `89347ea9517164283961678348cd6e799754a5f7` plus die unten gepinnten Quellen. **MCP-Teilschritt geprüft; Web-Anschluss, M1-Gesamtabschluss und MVP-Freigabe bleiben offen.** Produktionsaktivierung, Dateiaktions-Undo und Review Center bleiben aus.

## Verhalten

Ein neuer nicht ausführbarer Vorbereitungspreview beschreibt ausgewählte rohe Markdownquellen und notwendige rohe Linkänderungen. Preview verwendet einen echten aktuellen Principal und eine eigene vollständig abgeschlossene Verbindung; es entstehen keine Importe, Claims oder Schreibreferenzen. Bereits native Pläne behalten ihren bisherigen öffentlichen Vertrag.

Apply prüft die ursprüngliche Preview-ID und den vollständigen ursprünglichen Request. Der vorhandene atomare B0-Owner importiert Originale, bindet echte Links und speichert dieselbe Operation. Erst nach bestätigtem Commit, abgeschlossenem Verbindungsende und Guardfreigabe verwendet der öffentliche Adapter den gewöhnlichen Claim und Owner. `operation.planId` bleibt die tatsächliche native ID; das optionale `preparation.previewPlanId` bezeichnet ausschließlich die verifizierte ursprüngliche Zuordnung.

Der gemeinsame historische Selector prüft auf einer neuen echten Verbindung den aktuellen Principal, dieselbe Datenbank/Schemaidentität und die unveränderlichen gespeicherten Belege. Er läuft vor frischer Quellenplanung. Eine erneuerte Sitzung desselben berechtigten Nutzers kann mit der Original-ID weiterarbeiten; gespeicherte Vorgänge bleiben an den ursprünglichen Request gebunden. Ein inzwischen ungültiges neues Dokument am alten Pfad wird dafür nicht erneut gelesen. Fehlende Importzuordnung erlaubt keinen blinden Neuanlauf: Der Adapter prüft vorher auch die gewöhnliche bestehende Vorgangshistorie.

Das Python-SDK reicht strukturierte Ergebnisse bereits unverändert weiter. Angepasst wurden die additiven Typdeklarationen und drei gezielte Vertragstests. Transport, Methoden, Serialisierung und Importoberfläche sind unverändert; diese Änderung veröffentlicht kein Pythonpaket.

## Tatsächliche Abnahme

| Prüfung | Ergebnis |
| --- | --- |
| Finale gezielte TypeScript-/ESLint-Prüfung, run9 | Exit 0 / 0, ohne Lintwarnung |
| SDK-Pfadverträge aus tatsächlicher Root-Quelle, run9 | 19 Tests, Exit 0; Python-3.10-Syntax ebenfalls geprüft |
| Neue öffentliche MCP-Service-/PG18-/FD-Folge, run9 | 6/6, Exit 0 |
| Bisherige reine MCP-Verträge, run6 | 12 Gruppen, Exit 0 |
| Unveränderte atomare interne PG18-/FD-Folge, run6 | 7/7, Exit 0 |
| Unabhängiger Ressourcenabschluss run6 / run9 | beide Exit 0 |

Die sechs neuen Familien führen tatsächliches Decode → MCP-Service → Encode unter echter aktueller JWT-/Principalautorität und den realen nativen Ownern aus:

1. Raw-Move mit reinem Vorbereitungspreview, ursprünglicher Preview-ID, tatsächlichen nativen IDs/Inhalten/Links und gebundenem Status/Recover.
2. Raw-Delete mit tatsächlicher Archivierung der ursprünglichen Bytes/Identitäten und zentralem Unlink eingehender Referenzen.
3. Echter Verlust der Commitbestätigung nach realem B0-COMMIT: Header ohne ausführbare Lease, genau ein Elternvorbereitungsbeleg mit zwei tatsächlichen Dokumentimporten, ein Batch und ein P0, danach Wiederaufnahme mit Original-ID unter echter SID-B.
4. Veraltete Vorschau, geänderter Originalrequest, Rechteentzug und blockierte Kollision ohne Wirkung.
5. Bisheriger bereits nativer Vorschauvertrag und Vorgang ohne Importmapping.
6. Abgeschlossene historische Apply-/Status-/Recover-Wiederholung mit Original-ID unter SID-B trotz ungültiger UTF-8-Datei am alten Pfad: vollständig ohne neue Wirkung und ohne aktuelle Native-Quellenabfrage.

Die neue PG-Folge verwendet bewusst tatsächliche Plain-Importfixtures mit dem unterstützten Source-Metadatenkommentar `<!-- theme: public-import-fixture -->`; die reale Importvorbereitung bestätigt dieses Profil vorab. Sie ist kein neuer Raw-Rich-/XML-/Blocks-Importnachweis. Die separat abgenommene Rich-native-Gegenprobe bleibt im [MVP-Plan](./yjs-document-authority-mvp-launch-plan.md) verlinkt.

NoWrite prüft tatsächliche SQL-Befehle einschließlich schreibender CTEs und Notify, Domainzeilen/`xmin`, Tabellen-/OID-Inventar sowie vollständigen DATA-/FD-Baum samt Identitäten und Bytes. Ressourcenabschluss prüft unabhängig entferntes eigenes Schema/OID, beendete eigene Sitzungen und Originalprozesse, entferntes DATA und unverändert dieselben vier gesunden verwalteten Dienste. Kein Container wurde gebaut oder neu gestartet.

run6 bindet dieselben vier verhaltensändernden MCP-/History-/Preview-Kernquellen wie run9. Danach kamen SDK-Deklarationen/-tests, die neue öffentliche Testfolge und reine Toolbeschreibung hinzu. Die vollständigen jeweiligen Vorher-/Nachher-Manifeste sind getrennt erhalten; beide melden unveränderte Quellen während der tatsächlichen Folge.

## Erhaltene Originale und Grenzen

Private Originale liegen unter `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-public-path-ubqmt2ya`.

- `run6/terminal.json`: SHA-256 `35567cbee7687e6f5fb3da96ddd0c715e06aa2f60c1dcad5a1a8fd35af6cf19a`.
- `run6/independent-resource-report.json`: SHA-256 `e164d53f7fcb114c6b9fd744c4e7f35c744f7f7806a4ad70c0c112c46f37001e`.
- `run9/terminal.json`: SHA-256 `512c79206d6355b1a9c76e75e87feabc25111141df70cbc667e9df4add0eadd5`.
- `run9/public-pg.log`: SHA-256 `05ba518d949e46ff5da94396f3766bac91e3eb2d319df21161fdaa5b9538e78d`.
- `run9/sdk-path-unit.log`: SHA-256 `0ca19e773b3763cbda6163f58e49bfaf5d32db53a34faff08589c14eb40867d3`.
- `run9/public-pg-resources.json`: SHA-256 `9b3205c46ed2cf6077c4646b36f168f8751222c3a1bde91b01617c00a06dce8d`.

Die anfängliche Vertragsprobe war rot, weil ihre unveränderte Fünfer-Schema-/Zehner-Gruppenerwartung den zusätzlichen öffentlichen Vorbereitungsarm noch nicht erfasste. Testzählung und Schemaassertion wurden auf sechs Arme/zwölf Gruppen angepasst; das alte native Ergebnis bleibt gesondert geprüft. Die neue PG-Folge benötigte ausdrückliche TypeScript-Ergebnis-/Callbackannotationen. Sämtliche ursprünglichen roten Läufe bleiben erhalten; keine Guards oder fachlichen Orakel wurden abgeschwächt.

Dieser Nachweis enthält **keinen HTTP-/TCP-/Browserlauf, keine echte OAuth-Neuanmeldung, keinen aktivierten Gesamtbuild, keinen Linux-Sandboxnachweis und keine Produktionsauslieferung**. Die neue Web-Anbindung ist noch nicht integriert oder abgenommen. Die beiden bekannten älteren roten Legacy-/Undo-OFF-Gesamtsuiten bleiben offen. Der tatsächliche interne PI-Create-Fallback, verpflichtende Linux-/CI-Prüfung und kontrollierte Aktivierung bleiben M2; finale gemeinsame Abnahme, PR und CI/Review bleiben M3.

## Gebundene Produkt- und Testquellen

| Quelle | SHA-256 |
| --- | --- |
| `app/lib/files/workspace-operation-mcp-path-service.ts` | `fe5e4ab68b4be51ef8e3fcc9c191da20d110764509c26f1f7c0bc347732f1ee9` |
| `app/lib/mcp/server/workspace-path-tool-contract.ts` | `46ce680f0dbc813134db3dbef7eb5ce8828d1b814da65eb282cabd8192ddebad` |
| `app/lib/mcp/server/workspace-tools.ts` | `ba4ed62b3bfb1bb680155d082ec264b5a59baa72a9ebf01570bf8982c8447fef` |
| `packages/canvas-notebook-python/src/canvas_notebook/models.py` | `9fdc8bc3ee9ec65d87e0cc788899287397f65aeda12356f17e25ac4c07897c39` |
| `packages/canvas-notebook-python/tests/test_path_operations.py` | `c98351bd4037831a1f356c8dbfb22419c97b40799da6588d587e66f866163b99` |
| `scripts/mcp-server-workspace-path-contract-test.ts` | `c05861eb39603b7260366bd519e561e5d43064388f6dc02c00641b5d636ebae5` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `e0baeddc6cde051c6be029aa3ce885cb7c09dd29b7fcb1d8ca15c7f9f49c7cad` |
| `app/lib/files/workspace-path-import-operation-history.ts` | `030ec070eb19bfd3786a6007109b556a572b3c375846747de8288391f15baee2` |
| `app/lib/files/workspace-path-import-operation-preview.ts` | `6ea23f38b778ec61e8dcdd24d8d7e47f492b9fc0222b087298cccce9441a2392` |
| `scripts/workspace-path-import-public-postgres-runner-test.ts` | `0df886084d2cca573a29f6156de1d69a440a6dd324c2a84474d674e110be5168` |
| `scripts/workspace-path-import-public-postgres-test.ts` | `492fc00ffa428723a7a3d950bc208cdf748a852945bfa223f2b15db1042a9b6f` |
