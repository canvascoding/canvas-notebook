# Abnahme: Blockbearbeitung und Dokument-Lifecycle

Stand: 2026-09-09. Ursprünglicher Audit auf `b0cb34bd`, ergänzt um die umgesetzten Teilstände 7.8 bis 7.10. Diese Bestandsaufnahme gehört zum [Umsetzungsplan](editor-structure-lifecycle-plan.md). Die Gesamtfreigabe ist offen. „Bestanden“ bezeichnet hier ausschließlich die genannten ausgeführten Kern-/Komponententests; JSDOM liefert keinen Nachweis für Browserlayout, native Zwischenablage oder Betriebssystem-IME.

## Die zwölf verpflichtenden Szenarien

| Nr. | Erwartung | Konkreter Nachweis | Verbleibende Abnahme |
| --- | --- | --- | --- |
| 1 | Einfügen vor einem gezogenen Block erhält Quelle und Nachbarn. | `test:editor:blocks`: „inserting before a dragged block…“, aktuelle Quell-/Zielauflösung. | Tatsächliche Drag-Geste mit Peer-Einfügung, Scroll und Layoutänderung. |
| 2 | Gleichzeitige Textänderung folgt dem verschobenen Block. | `test:collaboration:blocks`, `test:collaboration:block-tree`, `test:collaboration:block-binding`: zwei Repliken, tatsächliche Tiptap-Views und fortbestehendes Textobjekt. | Zwei Browserclients und ein Agent während des Ziehens. |
| 3 | Konkurrierende Moves ergeben genau eine Platzierung. | `test:collaboration:block-tree`: vertauschte Zustellung und doppelte Updates; 576 Paare von Spaltenpermutationen in beiden Zustellreihenfolgen. | Gesten, Konfliktanzeige und Fokus in zwei Browserclients. |
| 4 | Move gegen Löschen erzeugt keine Wiederauferstehung. | `test:editor:blocks`: gelöschte Quelle bzw. Ziel; `test:collaboration:block-tree`: konkurrierende Quelllöschung sowie spätere Ankerlöschung. | `test:collaboration:container-races` ergänzt Quell-/Ziel-Eltern und verschachtelte Vorfahren, kausal spätere Löschung, Peer-Text, Undo/Redo und Neustarts. Ein gleichzeitig eingehängter Block kann weiterhin einen gesperrten, vollständig gesicherten Konflikt erzeugen; dessen tatsächliche Browser-Recovery bleibt abzunehmen. |
| 5 | Gegenläufiges Umhängen erzeugt keine Zyklen oder verwaisten Kinder. | `test:collaboration:block-tree`: A→B gegen B→A, deterministischer Konflikt, atomare Reparenting- und Schemaablehnung. | `test:collaboration:container-races` ergänzt A→B→C→A mit drei Repliken, allen Actor-/Zustellreihenfolgen und drei Neustartpunkten. Beliebigere mehrstufige Seed-Folgen mit wechselnden Eltern/Löschungen bleiben offen. |
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
| Tastatur und Touch | Teilstand 7.9 ergänzt `Alt+Shift+↑/↓` und ein übersetztes Verschiebemenü in Desktop- und Mobiltoolbar. Beide verwenden denselben aktuellen Move und erhalten Text-/Node-/Zellselektionen in derselben History-Transaktion. | Acht neue Kern-/JSDOM-Tests bestehen, einschließlich tatsächlicher Menüaktivierung, Peer-Änderung, Undo/Redo, abgewiesener Transaktion, Escape und Rechte-/View-Wechsel. Native Touch- und Browserbedienung bleiben offen. |
| Codeblöcke und atomare Blöcke | Der bisherige Griff bleibt an `getBlockInsertButtonPosition` gebunden. Das neue Toolbar-Menü und der Tastaturbefehl können Codeblöcke sowie per NodeSelection ausgewählte Bilder bereits verschieben; lokale und kollaborative Fälle bestehen. | Zusätzlich Griff-/Einfügeposition entkoppeln und für atomare Blöcke bestimmen; tatsächliche Pointer-Bedienung prüfen. |
| Verschachtelte Blocksteuerung | Teilstand 7.10 ergänzt eigenständige Kindblöcke in Zitaten, Callouts und Details. Exakte Knotenauswahl kann auch Untercontainer als Ganzes bewegen. Textabsätze in Listeneinträgen und Tabellenzellen steuern weiter die jeweilige strukturelle Einheit; Titel-/Summary-Slots werden nicht als Geschwister bewegt. | Die gemeinsame Auflösung gilt für Drag, Tastatur und Toolbar-Menü; aktuelle Eltern-/Kindgrenzen und ID-Prüfungen bleiben erhalten. Reale Griffe/Overlays und eine ausdrückliche Bedienung zum Wechseln des Elterncontainers bleiben offen. |
| Scroll und Layout | Transaktionen, Scroll und Window-Resize aktualisieren bestehende Overlays. Ein eigener Rand-Autoscroll und eine Beobachtung anderer Layoutänderungen sind in dieser Steuerung nicht implementiert. | Abbruch-/Lebensdauergebundene Steuerung ergänzen; Bildladen, Details, Resize und Scrollcontainer im Browser prüfen. |
| Zwischenablage | Es gibt ID-/Split-/Join- sowie URL-Paste-Tests. Sie sind kein vollständiger Nachweis für native Blockkopie, Ausschneiden, Einfügen und Drag zwischen Dokumenten. | Eindeutige neue IDs für Kopien und unveränderte Quelle bei abgewiesenem fremdem Drop ausdrücklich prüfen. |
| Zustandsfolgen | Feste Repliken-IDs, doppelte Updates, Paar-Rennen, Tabellenpermutationen und Drei-Repliken-Containerfälle mit Neustarts sind vorhanden. Ein allgemeiner gespeicherter Seed-Treiber mit mehreren Restart-Punkten ist nicht belegt. | Einen begrenzten deterministischen Folgentest ergänzen, mit reproduzierbarem Operationsprotokoll bei Fehlschlag. |

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

Teilstand 7.8 ergänzt sechs Tests mit insgesamt 648 Actor-/Zustell-/Neustartkombinationen. Alle bestehen; TypeScript und scoped ESLint ebenfalls. Der Produktcode bleibt unverändert. Löschung erfasst die beobachteten Nachfahren: Ein zuvor bereits hinausbewegtes Kind bleibt sichtbar; ein konkurrierend hinausbewegtes, vom Löscher noch beobachtetes Kind bleibt gelöscht und mit dem Peer-Text wiederherstellbar. Beim konkurrierenden Einhängen in einen gelöschten Elterncontainer wird entweder der Move ausdrücklich verworfen oder die verwaiste Projektion gesperrt. Kein solcher Zustand erhält einen gültigen Checkpoint. Selektives Undo erhält fremde Löschung/Bewegung und Peer-Text, Redo reproduziert denselben Konflikt, Operationswiederholung bewirkt kein heimliches Redo.

Teilstand 7.9 schließt die gemeinsamen Verschiebebefehle ab. `test:editor:block-move-command` besteht mit acht Tests: lokale/kollaborative rückwärts gerichtete Auswahl, Undo/Redo über View-Zerstörung, Code-/Bild-/Task-/Zellziele, Mehrblock-Auswahl, abgewiesene Transaktionen sowie Desktop-/Touch-Menü unter StrictMode. Die erste getrennt nachgeschobene Auswahlkorrektur verlor beim kollaborativen Redo ihre Markierung; die Auswahl wird deshalb jetzt direkt in der Move-Transaktion abgebildet. Ein frischer vollständiger Produktionsbuild, der anschließende Test am gebauten Checkpoint-Code, TypeScript, scoped ESLint sowie lokale Lifecycle-/Interaktions-/Binding-/Rich-Block-/Mobiltoolbar- und Recovery-Regressionen bestehen.

Teilstand 7.10 erweitert dieselbe Quelle-/Zielauflösung um eigenständige Kindblöcke; die bisherigen ID-/View-/Schemaprüfungen bleiben aktiv. Alle 13 Befehls-/Menütests bestehen, einschließlich 16 lokalen/kollaborativen Varianten verschachtelter Dokumente, fester Container-Slots, Peer-Text und Eltern-Move vor einem Drop sowie zweier unabhängiger Repliken mit Undo/Redo und binärem Wiederöffnen. Die vollständige Rich-Block-/Core-Regressionssuite besteht mit unveränderter Erwartung für das ältere Bild-im-Textabsatz-Fixture. Ein solcher Inline-Kontext wird ausdrücklich nicht als neue Verschiebeebene interpretiert. Auch bisherige Block-, Binding-, lokale Dokument-/Lifecycle- und Interaktionsprüfungen bestehen. Der endgültige Stand besteht einen frischen vollständigen Produktionsbuild einschließlich TypeScript, den anschließenden Test am gebauten Checkpoint-Validator und scoped ESLint; das isolierte DATA bleibt leer.

Als Nächstes folgen die verbleibenden Griff-/Layoutlücken, Zwischenablage, allgemeinere Zustandsfolgen und tatsächliche Binding-Messung. Die Browserabnahme wartet weiter auf die bereits erfragte explizite Freigabe gemäß `AGENTS.md`. Das ist keine Sperre für diese unabhängigen Code- und Komponentenschritte.
