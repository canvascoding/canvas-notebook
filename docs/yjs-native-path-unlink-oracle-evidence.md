# Native Move/Delete: kanonische Erwartung nach Linkentfernung

## Aktuelle vollständige Browserabnahme: 9/9

Auf Root `fb0d492d7a7d264643e6826653ea33c02c10c503`, QA `192d8458fed5b0de3e419e48f4416f9dd2b569c2` und unveränderter Control Plane `27c8ce37da082244f006ca376068cde6b98845d5` besteht die vollständige neue Originalfolge: **9/9, null Fehler, Skips, Timeouts oder Unterbrechungen**. Der korrigierte Spec-Pin bleibt `b6074d6870ed21c2c2e46a075bcdb5e77c3f6e7ae3463d7d119396c5d45e7908`.

Der echte neue Produktionsbuild besteht nach 432,792 Sekunden mit Exit 0. Unabhängiger Quellen- und Artefaktabgleich bestehen, mit QA-Sourcefingerprint `8a20cc203e674f7ff81f1f98df4a8eb54b69d9b9f107dc2dcae7a82adc20f836` und Buildfingerprint `43b11be15d540c29c8aa444c62998db9d8e1b09041d5e79f6e9006266b011193`. Die drei geschützten Root-/QA-Differenzen, originalen Supervisor-/Nativekomponenten und alle übrigen Assertions bleiben erhalten.

Fall 9 bestätigt tatsächliches Opt-in und Save/Reload, echte Workspacefreigaben, identische Dokument-ID/Lineage nach Move, den ursprünglichen vollständigen Versionsread am neuen Pfad und vollständig passenden nativen Editorinhalt nach Reload. Die montierte Dateiliste folgt Move und Delete ohne manuellen Reload. Der eingehende Link wird zunächst genau umgeschrieben und bei Delete genau als Mark entfernt; Bold, Fremdlink, Zeichen und übrige Blöcke bleiben vollständig erhalten. Beide sicheren Editor-Screenshots wurden zusätzlich visuell geprüft. Nach Abmeldung der ursprünglichen echten Sitzung werden deren Tokens mit HTTP 401 abgewiesen; eine neue Sitzung mit derselben OAuth-Clientregistrierung erhält dieselben historischen Move-/Delete-Fakten und führt ausdrückliche abgeschlossene Recovery derselben beiden Originaloperationen aus. Originalattribution, Belegzeilen und `xmin` bleiben unverändert.

Dieser neunte Fall belegt abgeschlossene historische Recovery; unterbrochene ACK-/Owner-Recovery bleibt der separate tatsächliche PG-Nachweis. Er belegt öffentliche MCP-Move-/Delete-Aufrufe, **keinen** installierten Python-SDK-Move-/Delete-Lifecycle. Das ältere echte SDK-OAuth-Wheel in Fall 7 bleibt ein Create-/Edit-Nachweis. Weitere physische/Ordner-/Scene-Dateiaktionsfälle, die übrigen Planblöcke und allgemeine Aktivierung bleiben offen. Dateiaktions-Undo und Review Center bleiben aus.

### Originalbelege und Ressourcenabschluss

Privater Controller: `/private/tmp/canvas-mcp-path-oracle-controller9-197sdebp`. Exakte tatsächliche Originale:

| Beleg | SHA-256 |
| --- | --- |
| `source-report.json` | `ac9d2d4fd3e67d0bec6c9d8bfaf120f274f6bba27a61085739c796ececfdbd01` |
| `artifact-report.json` | `f60d19278f13a73078b7c63ba5d05d805bb91e97dfa3011faad089fdcb56f273` |
| `postruntime-report.json` | `d0258da5cb6993ca2d94d1b455e36bac60f932062572d57727c722f9562d9996` |

Originalruntime, passive Baseline, unabhängiger Postcheck und Queue enden tatsächlich mit Exit 0. Alle 14 unabhängigen Abschlussprüfungen bestehen: ursprüngliche Namen/OIDs und Backends fehlen, DATA/TMP und Lock sind entfernt, alle erfassten Prozessidentitäten/Gruppen und Ports sind frei, die vier verwalteten Dienste behalten ihre ursprünglichen IDs und bleiben gesund, drei Healthendpunkte antworten 200. Quellen, geschützte Differenzen und Originalbelege bleiben während des Postchecks unverändert. Die zusätzliche abschließende Prozessaufnahme bestätigt null verbleibende Originalprozesse.

Die frühere fehlgeschlagene Fixture bleibt weiterhin als 8/9 dokumentiert. Ihre getrennte exakte Schließung unter `/private/tmp/canvas-native-path-admission-8gusy9ys/browser9-failed-fixture-cleanup-candidate-v1/prepared` besteht mit Cleanupbericht `6606c2679c6abccc5921bda460a612f3ca9e426562b615ecf9e99873ea4bcc5a` und anschließendem tatsächlichem READ-ONLY-Nachcheck `f328a25923b71f807b9e6e9884dcbd48cfbffd964bd9cfd7096a440842afa09b`. Der Original-Runtimelog ist vor DATA-Entfernung FD-/Identitäts-/Hash-geprüft privat kopiert, fsynct und erneut gelesen; sämtliche Originalreceipts und negativen Berichte bleiben unverändert. Eine zunächst falsche 1-MiB-Eingangsgrenze des unabhängigen privaten Prüfers wurde vor jeder DB-Verbindung abgewiesen und anschließend auf dieselbe bereits geprüfte explizite 64-MiB-Grenze des tatsächlichen Manifests korrigiert; der ursprüngliche Aufbaufehler bleibt separat erhalten. Die zwei privaten SDK-Binding-Verifier-Aufruffehler (falscher Interpreter beziehungsweise fehlendes Pfadargument) sind ebenfalls getrennt erhalten; die korrekte gebundene Interpreter-/Argumentprüfung besteht vor Runtime-Start mit Exit 0. Diese Aufbauten erfordern keine Produkt- oder Assertionänderung.

## Historie: ursprünglicher Browserfehler und gezielte Testkorrektur

Stand: 19. Oktober 2026. Dieser Nachweis trennt den tatsächlichen fehlgeschlagenen Browserlauf von der anschließenden engen Testkorrektur. Allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus.

## Tatsächlicher frischer Build und Browserlauf

Gebundene Ausgangsquellen: Root `6891c1bbab411ed535dadea67c87e880a95351d8`, QA `f7d2db52ec869cb1b021251cc61a3417a01bfd9d`, Control Plane `27c8ce37da082244f006ca376068cde6b98845d5`. Die drei geschützten Root-/QA-Differenzen bleiben exakt; ihr binärer Patchhash ist `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`.

Der originale Produktionsbuild endet tatsächlich mit Exit 0 nach 714,682 Sekunden; der unabhängige Artefaktabgleich endet ebenfalls mit Exit 0. Build-ID `build-TfctsWXpff2fKS`; Buildfingerprint `83f742c30647c24d423bbf4c265dbc347047865fa46cbafdbf9812496362b463`. Der volle damalige Spec-Pin lautet `0588d40d9ca32c231a8c518a165600cd21e675b1ef8db60d54e16d1e029000f3`.

Die unveränderte vollständige Originalfolge enthält neun deklarierte Fälle: acht bestanden, einer fehlgeschlagen, null Skips, Timeouts oder Unterbrechungen. Fälle 1–8 schließen echte OAuth-/Create-/Import-/Read-/Edit-/REST-/SDK-/Copy-Verträge ein. Fall 9 führt Move, nativen Read, Editor-Reload und zentralen Linkrewrite erfolgreich aus. Danach bestehen Delete-Apply und die sichtbaren Dateilistenprüfungen. Er scheitert erst am vollständigen nativen JSON-Vergleich nach Unlink: tatsächlicher Text ` Target and ` gegenüber drei erwarteten Textknoten ` `, `Target`, ` and `.

Die späteren Assertions zu sichtbarem Linkabbau, vollständigem Editorinhalt, historischer Status-/Recoveryprüfung und erneuerter OAuth-Sitzung wurden in diesem Fall nicht erreicht. Der Lauf bleibt **8/9 und Exit 1**. Ein bestandener Backendlauf oder eine korrigierte Test-Erwartung ersetzt diese offene Browserabnahme nicht.

## Ursache und enge Korrektur

`workspace-native-link-mutations.ts` entfernt ausschließlich den ausgewählten Link-Mark. Der native Reader baut ProseMirror-Knoten über den Blockbaum auf. `prosemirror-model` vereinigt in `Fragment.fromArray` benachbarte Textknoten mit identischem Markup. Der bisherige lokale `expectedPathLinkChange`-Helfer entfernte dagegen Marks aus einem rohen JSON-Klon, ohne diese gültige Kanonisierung vorzunehmen.

Geändert sind ausschließlich zwei clientfähige Schemaimports und der Abschluss dieses Erwartungshelfers: nach weiterhin exakt einer geprüften Linkänderung wird nur der erwartete Baum mit `getSchema(richMarkdownCodecExtensions()).nodeFromJSON(...)` gelesen, geprüft und als gewöhnliches JSON zurückgegeben. Tatsächliche Native-/Editorwerte bleiben unverändert. Außerhalb dieser beiden Imports und des Helfers ist der gesamte Spec bytegleich, einschließlich aller neun Fallkörper, vollständigen Struktur-/Versions-/Fremdlink-/Text-/UI-/historischen Assertions, Budgets und Timeouts. Kein Produktcode wurde für diese Korrektur verändert.

## Tatsächliche gezielte Prüfung

Der korrigierte Spec-Pin lautet `b6074d6870ed21c2c2e46a075bcdb5e77c3f6e7ae3463d7d119396c5d45e7908`.

- Echte ProseMirror-`Transform.removeMark`-Gegenprobe: der ursprüngliche Helfer lehnt das gültige Ergebnis ab; der korrigierte Helfer stimmt vollständig überein.
- Rename bleibt strukturell exakt; der ursprüngliche Input bleibt unverändert.
- Sechs negative vollständige Vergleiche bleiben ablehnend: Textänderung, falscher Fremdlink, fehlender Bold-Mark, veränderte stabile Block-ID, entfernter Hardbreak und entfernte Absatzgrenze. Fehlender ausgewählter Link wird weiterhin abgewiesen.
- Gezieltes cachefreies TypeScript und Scoped-ESLint enden tatsächlich mit Exit 0. Unabhängiger Read-only-Review bestätigt die enge Änderung und unveränderte übrige Assertions.

Die privaten Originalbelege liegen im Controller `/private/tmp/canvas-mcp-path-live-controller9-6o3epvsc`: `source-report.json`, `build-terminal.json`, `artifact-report.json`, `runtime-terminal.json`, `postruntime-report.json`. Der tatsächliche ursprüngliche Postcheck bleibt fehlgeschlagen; seine Quellen-/Prozess-/Port-/Diensteprüfungen bestehen, DATA/TMP und die zwei eigenen Datenbanken wurden zur Diagnose zunächst erhalten. Keine nachträgliche Aufwertung der Originalreceipts.

Die private reine Gegenprobe liegt unter `/private/tmp/canvas-native-path-admission-8gusy9ys/browser-path-oracle-v1`: `check-oracle.cjs` und `oracle-report.json`. Diese privaten Dateien enthalten keinen behaupteten Browserpass und sind kein auszuliefernder Produktbestandteil.

## Nächste verbindliche Abnahme

Nach getrennter Schließung der eigenen fehlgeschlagenen Laufressourcen: saubere Root-/QA-Integration mit exakt den drei geschützten Differenzen, neue tatsächliche Quellenbindung, frischer originaler Produktionsbuild, unabhängiger Artefaktabgleich und unveränderte vollständige Neun-Fälle-Browserfolge. Erst deren tatsächliches Ergebnis kann die offenen späteren Assertions schließen. Der weitere installierte SDK-Lifecycle und die übrigen sieben Planblöcke bleiben eigenständige Arbeit.
