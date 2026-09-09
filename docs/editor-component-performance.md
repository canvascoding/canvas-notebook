# Editor-Komponentenmessung

Stand: 9. September 2026, Teilstand 7.16. Gemessen auf Apple M1 Max / Node 26.7.0.

Der tatsächliche Tiptap-Editor und die tatsächliche MarkdownEditor-Komponente laufen in JSDOM. Der React-Entwicklungsbuild läuft unter StrictMode. Transport, Theme und fremde Vorschaukomponenten sind ersetzt; Blockbindung, lokales Dokumentmodell, ProseMirror-DOM, History und Markdown-Analyse bleiben produktiv. Das ist keine Browser-, Layout-, Paint-, Netzwerk-, Datenbank- oder IndexedDB-Messung.

## Methode

`npm run bench:editor:blocks -- --output <Datei>` misst 100, 1.000 und 5.000 kurze formatierte Absätze. Das größte Dokument bleibt mit 113.888 Zeichen unter der bestehenden Rich-Text-Grenze von 180.000 Zeichen. Eine zuerst verwendete längere Fixture überschritt diese Grenze und öffnete lokal korrekt Source; die Produktgrenze wurde nicht verändert.

Pro Fall: zwei Aufwärmdurchläufe und sieben Messwerte. Erfasst werden synchroner Move-Dispatch und Abschluss von React `act` (bei reiner Bindung: ein Microtask), Undo, Redo und kollaborative Textzustellung. Bei sieben Werten ist p95 das Maximum; Rohwerte sind beigefügt. Mount wird einmal pro Fall gemessen und ist kein belastbarer Kaltstart-Quantilwert. Datenanlage, Peer-Update-Erzeugung, Assertions und Cleanup liegen außerhalb der Zeitfenster. Künftige Timer und Animation-Frames sind nicht Teil von `act`-Abschluss. Die Laufzeit ist kein automatisches Bestehens-/Fehlschlagskriterium.

`CANVAS_EDITOR_BENCH_SIZES=5000 CANVAS_EDITOR_BENCH_MODES=binding npm run bench:editor:blocks` grenzt den Lauf ein. Unterstützte Modi: `binding`, `react-local`, `react-collaboration`.

Jeder Move prüft die aktuelle Block-ID; einmaliges Undo stellt IDs, Reihenfolge und Formatierung exakt wieder her. Redo verschiebt dieselbe ID. Die kollaborativen Fälle prüfen zusätzlich Peer-Text, den strikt validierten Checkpoint ohne Änderung der Binärdaten und binäres Wiederöffnen. Lokal wird die Ausgabe des echten Dokumentmodells verglichen.

## Belegter Engpass und Änderung

`CollaborationBlockTree.applyChanges` suchte für jeden Block erneut mit `includes` und `indexOf` in derselben Geschwisterliste. Beim strukturellen Move geschah dies auch in der vorgelagerten Validierungsreplik. Ein Node-CPU-Profil des Bindungslaufs bestätigte diesen Modulpfad als größten eigenen CPU-Anteil.

Die Nachfolgerzuordnung wird jetzt einmal pro Elterncontainer und unveränderter Projektion aufgebaut. Sobald eine Operation die Projektion ersetzt, wird sie vor dem nächsten Vergleich erneuert. Die Prüfung der Elternzugehörigkeit, das gesonderte Platzieren neuer IDs und die isolierte Strukturvalidierung bleiben bestehen. Es gibt keinen langlebigen zusätzlichen Blockindex, keine gelockerte Validierung und keine andere Operationsreihenfolge.

Median der Move-Zeit bis zum oben definierten Abschluss, in Millisekunden:

| Modus | Absätze | Vorher | Nachher |
| --- | ---: | ---: | ---: |
| Bindung | 100 | 5,8 | 5,9 |
| Bindung | 1.000 | 58,7 | 43,6 |
| Bindung | 5.000 | 924,1 | 297,0 |
| React lokal | 100 | 21,7 | 21,3 |
| React lokal | 1.000 | 67,3 | 66,7 |
| React lokal | 5.000 | 373,5 | 373,7 |
| React kollaborativ | 100 | 30,5 | 30,5 |
| React kollaborativ | 1.000 | 177,6 | 160,1 |
| React kollaborativ | 5.000 | 1.588,7 | 971,5 |

Die großen kollaborativen Fälle profitieren deutlich; der unveränderte lokale Pfad dient als Vergleich. Kleine Differenzen sind Messstreuung. [Rohdaten vorher](editor-component-performance-baseline.json) und [Rohdaten nachher](editor-component-performance-adjacency.json) enthalten Laufzeitumgebung, Commitbezug, Dirty-Status und alle Einzelwerte. Beide Berichte entstanden vor dem Commit dieses abgeschlossenen Schritts.

## Verbleibende Grenzen

Der endgültige Stand besteht die Block-Tree-Suite mit allen Tabellenpermutationen, Binding/Anker, zwölf Seed-Folgen, 648 Container-Rennkombinationen, 26 Move-/Menügruppen, 17 Clipboard-Gruppen, die tatsächliche lokale MarkdownEditor-Lifecycle-Prüfung, Agentenziele und Struktur-/Start-Recovery. Scoped ESLint sowie der frische vollständige Produktionsbuild mit TypeScript und 333 Seiten bestehen. Der anschließende Test am tatsächlich gebauten Checkpoint-Modul besteht ebenfalls; das isolierte DATA blieb leer. GitNexus `detect_changes` erfasst die erwarteten acht Dateien (LOW). Keine Browser, Server oder Container gestartet.

5.000 Absätze sind weiterhin langsam: kollaborativer Move etwa 972 ms, Peer-Text etwa 548 ms, lokaler Move etwa 374 ms im Median. Der lokale Mount betrug einmalig etwa 6,4 Sekunden. Die Messung ist daher ausdrücklich kein Nachweis flüssiger Browserbedienung.

Für weitere Optimierungen sind getrennte Profile von vollständiger Markdown-Analyse/Serialisierung, Strukturvorprüfung und ProseMirror-/React-Aktualisierung erforderlich. Aus den Gesamtzeiten lässt sich deren jeweiliger Anteil nicht ableiten. Eine automatische Verdichtung alter Operations-/Receipt-Daten benötigt unabhängig davon ein Protokoll für Offline-Repliken, Undo und Idempotenz. Native Drop-Reaktion, Touch, IME und Browserneustart bleiben Teil der ausstehenden Browserabnahme.
