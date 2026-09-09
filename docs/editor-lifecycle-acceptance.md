# Abnahme: Blockbearbeitung und Dokument-Lifecycle

Stand: 2026-09-09, geprüfter Produktcode `b0cb34bd`. Diese Bestandsaufnahme gehört zum [Umsetzungsplan](editor-structure-lifecycle-plan.md). Die Gesamtfreigabe ist offen. „Bestanden“ bezeichnet hier ausschließlich die genannten ausgeführten Kern-/Komponententests; JSDOM liefert keinen Nachweis für Browserlayout, native Zwischenablage oder Betriebssystem-IME.

## Die zwölf verpflichtenden Szenarien

| Nr. | Erwartung | Konkreter Nachweis | Verbleibende Abnahme |
| --- | --- | --- | --- |
| 1 | Einfügen vor einem gezogenen Block erhält Quelle und Nachbarn. | `test:editor:blocks`: „inserting before a dragged block…“, aktuelle Quell-/Zielauflösung. | Tatsächliche Drag-Geste mit Peer-Einfügung, Scroll und Layoutänderung. |
| 2 | Gleichzeitige Textänderung folgt dem verschobenen Block. | `test:collaboration:blocks`, `test:collaboration:block-tree`, `test:collaboration:block-binding`: zwei Repliken, tatsächliche Tiptap-Views und fortbestehendes Textobjekt. | Zwei Browserclients und ein Agent während des Ziehens. |
| 3 | Konkurrierende Moves ergeben genau eine Platzierung. | `test:collaboration:block-tree`: vertauschte Zustellung und doppelte Updates; 576 Paare von Spaltenpermutationen in beiden Zustellreihenfolgen. | Gesten, Konfliktanzeige und Fokus in zwei Browserclients. |
| 4 | Move gegen Löschen erzeugt keine Wiederauferstehung. | `test:editor:blocks`: gelöschte Quelle bzw. Ziel; `test:collaboration:block-tree`: konkurrierende Quelllöschung sowie spätere Ankerlöschung. | **Kernlücke:** gezielte Rennen gegen gelöschte Quell-/Ziel-Elterncontainer, einschließlich gleichzeitig aus dem Container bewegter Kinder. |
| 5 | Gegenläufiges Umhängen erzeugt keine Zyklen oder verwaisten Kinder. | `test:collaboration:block-tree`: A→B gegen B→A, deterministischer Konflikt, atomare Reparenting- und Schemaablehnung. | Mehrstufige Folgen mit drei Repliken und wechselnden Eltern/Löschungen; der bisherige Paar-Test ersetzt dies nicht. |
| 6 | Listen, Tasks und Tabellen behalten IDs und Semantik. | `test:editor:core`, `test:collaboration:block-binding`, `test:collaboration:block-tree`: Listensplit/-join, Task-Move, Tabellenbefehle, Header/Ausrichtung, Spaltenintegrität und genaue Zellselektion. | Browserbedienung; native Copy/Paste-/Cut-/Duplizierfolgen mit neuen IDs sind noch nicht durch einen eigenen integrierten Test belegt. |
| 7 | Eigenes Undo/Redo erhält fremde Änderungen. | `test:collaboration:block-binding`, `test:collaboration:text-history`, `test:editor:local-document`, `test:editor:local-lifecycle`: Move plus Peer-Text, gruppierte Eingabe, View-Zerstörung, Rich/Source und selektive History. | Native Tastatur-/IME-Folgen in wechselnden Browseransichten. |
| 8 | Agentenoperationen bleiben bei gleichen Texten eindeutig. | `test:collaboration:block-agent`: eindeutige Vorkommen, fortbestehendes Ziel nach Move/binärem Öffnen, Revert, sichtbare Markierungen; Split/Join fordert Review. | Ende-zu-Ende-Agentenreview mit zwei menschlichen Clients. |
| 9 | Gesten/Dialoge überleben keinen Rechte-/Datei-/Workspace-/View-Wechsel als Schreibauftrag. | `test:editor:blocks`, `test:editor:interaction`, `test:editor:collaboration-scope`, `test:editor:local-lifecycle`: alte Referenzen/Callbacks, StrictMode, A→B→A, Unmount und Rechteentzug. | Der vollständige native Drag-Pfad einschließlich Escape, Blur und spätem Drop ist noch nicht im Browser geprüft. |
| 10 | Offline-/Reconnect-/Generationswechsel übernehmen keine alte Struktur. | `test:collaboration:durability`, `test:collaboration:rename`, `test:collaboration:location-client`, `test:collaboration:location-adoption`: verspätete Hydrierung/Sessionantwort, Reconnect, Pfadübernahme und Generationsfehler. Frühere PostgreSQL-Abnahme von `test:collaboration:block-format` belegt Migration/Backup/alte Generation; in diesem Audit nicht erneut ausgeführt. | Echte Transportunterbrechung, Restart und Offline-Replik über Migration. Inaktive Tabs und Explorer bei externem Elternordner-Rename sind nicht vollständig belegt. |
| 11 | Nur der exakte bestätigte Zustand erscheint als gespeichert. | `test:collaboration:durability`, `test:collaboration:failures`: Delete-Set trotz gleichem State Vector, überholte HTTP-/Socket-Antworten, Auth-/Generationssperre, exakter Checkpoint. | Echte Netz-/Serververzögerung und Speicherausfall im integrierten Stack. |
| 12 | Persistenzfehler ermöglichen vollständige Recovery. | `test:editor:recovery-copy`, `test:editor:structure-recovery`, `test:editor:startup-recovery`: abgeschlossener binärer Snapshot vor Kopie, Löschmengen/IDs/opaque Metadaten, selektives Undo ohne Editorview, unveränderter Originalzustand und alte Callbacks. | Browserneustart mit echtem IndexedDB, Download-/Importpfad und tatsächlicher Server-/Dateisystemstörung. |

Die Gegenproben verwenden neutrale Dokumente. Der ursprüngliche private Screenshot wurde dadurch weder rekonstruiert noch als repariert nachgewiesen.

## Zusätzliche Bedienanforderungen aus Abschnitt 7 des Plans

| Bereich | Befund im geprüften Produktcode | Nächster konkreter Schritt |
| --- | --- | --- |
| Tastatur und Touch | `MarkdownBlockControls` ruft den gemeinsamen Move nur im Drop-Handler auf. Der Griff öffnet per Klick das Einfüge-/Formatmenü; ein eigener Verschiebebefehl fehlt. | Dieselbe aktuelle Blockoperation über bedienbare Auf-/Ab-Aktionen und Tastatur anbieten; Quelle/Auswahl sowie Rechte-/View-Scope erhalten. Touch kann diese Aktionen verwenden. |
| Codeblöcke und atomare Blöcke | `getBlockInsertButtonPosition` liefert bei Codeblöcken ausdrücklich `null` und verlangt eine aktive Textblock-Tiefe. Eine NodeSelection auf einem Bild hat keinen solchen Textblock. | Einfüge-/Textmenü von der Verschiebesteuerung trennen; Steuerung auch für ausgewählte atomare Blöcke und Codeblöcke bestimmen. |
| Verschachtelte Blocksteuerung | `getReorderableBlockRangeAt` kennt derzeit Top-Level-Blöcke und List-/Task-Items. Andere verschachtelte Inhalte werden über den äußeren Top-Level-Container angesprochen. | Regeln für Container und adressierbare Kindblöcke ausdrücklich festlegen und über dieselbe ID-Auflösung integrieren; Tabellengeometrie und Containerpflichtfelder schützen. |
| Scroll und Layout | Transaktionen, Scroll und Window-Resize aktualisieren bestehende Overlays. Ein eigener Rand-Autoscroll und eine Beobachtung anderer Layoutänderungen sind in dieser Steuerung nicht implementiert. | Abbruch-/Lebensdauergebundene Steuerung ergänzen; Bildladen, Details, Resize und Scrollcontainer im Browser prüfen. |
| Zwischenablage | Es gibt ID-/Split-/Join- sowie URL-Paste-Tests. Sie sind kein vollständiger Nachweis für native Blockkopie, Ausschneiden, Einfügen und Drag zwischen Dokumenten. | Eindeutige neue IDs für Kopien und unveränderte Quelle bei abgewiesenem fremdem Drop ausdrücklich prüfen. |
| Zustandsfolgen | Feste Repliken-IDs, doppelte Updates, Paar-Rennen und Tabellenpermutationen sind vorhanden. Ein allgemeiner gespeicherter Seed-Treiber mit mehreren Restart-Punkten ist nicht belegt. | Einen begrenzten deterministischen Folgentest ergänzen, mit reproduzierbarem Operationsprotokoll bei Fehlschlag. |

## Messung und Langzeitverhalten

- Der [CPU-Benchmark](editor-block-performance-block-start-hints.json) prüft sieben Dokumentklassen mit IDs/Inhalten, konkurrierendem Text, binärem Wiederöffnen und unverändernder Validierung. Für 5.000 Absätze: vollständiger Checkpoint etwa 370 ms, Move p95 etwa 15 ms. Das enthält keine DOM-, Netzwerk- oder Datenbankzeiten.
- Der bestehende Index pro unveränderlichem ProseMirror-Dokument ist ausreichend schnell; zusätzliche Zielindexstrukturen sind bisher nicht begründet.
- Für die tatsächliche Editor-Bindung einschließlich ProseMirror-/React-Aktualisierung fehlt eine separate Messung. Die Browser-Drop-Latenz bleibt ebenfalls offen.
- 10.000 Moves erhöhen den Binärstand bei 1.000 Absätzen auf etwa 3,2 MiB. Operations-/Receipt-Daten bleiben erhalten. Eine Verdichtung muss eigene Undo-History, Idempotenzbelege und alte Offline-Repliken berücksichtigen; sie ist noch nicht implementiert und darf nicht durch unkontrolliertes Löschen ersetzt werden.

## Ausgeführte Prüfungen und Reihenfolge

Nach Commit `b0cb34bd` wurden diese 14 Prüfgruppen erneut vollständig ausgeführt, alle mit Exitcode 0:

```text
test:editor:blocks
test:collaboration:block-tree
test:collaboration:blocks
test:collaboration:block-binding
test:editor:identity
test:editor:interaction
test:editor:collaboration-lifecycle
test:editor:collaboration-scope
test:collaboration:text-history
test:collaboration:rename
test:collaboration:location-client
test:collaboration:location-adoption
test:editor:recovery-copy
test:collaboration:failures
```

Die übrigen oben genannten Tests und der vollständige Produktionsbuild liefen unmittelbar vor diesem Commit im abgeschlossenen Schritt 7.6; der Validator wurde anschließend aus dem tatsächlich gebauten Checkpoint-Endpunkt geladen und geprüft. Das isolierte DATA-Verzeichnis des Audits blieb leer und wurde entfernt. Keine Browser, Server oder Container gestartet, keine Produktionsdokumente verändert.

Die nächste abgeschlossene Einheit behandelt zunächst die fehlenden Elterncontainer-/Mehrrepliken-Gegenproben. Danach folgen die gemeinsamen Verschiebebefehle und die genannten Blocksteuerungs-/Layoutlücken, Zwischenablage und tatsächliche Binding-Messung. Die Browserabnahme wartet weiter auf die bereits erfragte explizite Freigabe gemäß `AGENTS.md`. Das ist keine Sperre für diese unabhängigen Code- und Komponentenschritte.
