# Native Move/Delete: kanonische Erwartung nach Linkentfernung

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
