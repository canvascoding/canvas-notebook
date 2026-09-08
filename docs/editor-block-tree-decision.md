# Strukturidentität im kollaborativen Editor

Stand: 2026-09-08. Entscheidung für Schritt 3 des Editor-Lifecycle-Plans.

## Befund und Entscheidung

Die bisherige ProseMirror/Yjs-Bindung schreibt einen Baum aus verschachtelten XML-Knoten. Ein Delete/Insert zum Verschieben erhält dessen interne Textidentität nicht. Die Gegenbeispiele in `test:collaboration:blocks` belegen sowohl Textzuordnung zu einem Nachbarblock als auch doppelte Block-IDs. Erneutes Auflösen einer fachlichen ID behebt die lokalen Drag-Fehler, aber diesen Bindungsfehler nicht.

Der neue Kern trennt deshalb Inhalt und Platzierung. Er liegt in `app/lib/collaboration/block-tree.ts` und `block-tree-placement.ts`. Er wird erst nach der noch ausstehenden Binding-/Protokollintegration und abgesicherten Migration produktiv verwendet. Bestehende Dokumente werden durch diese Implementierung nicht umgeschrieben.

## Persistiertes Modell

`canvas-block-tree-v1` enthält eine Formatversion, Blockdatensätze, Strukturabsichten und unveränderliche Ausführungsbelege. Ein Blockdatensatz besitzt eine Identität, eine ursprüngliche Platzierung, seinen Typ, einzeln kollaborativ veränderbare Attribute und ein dauerhaft integriertes XML-Fragment für Inline-Inhalt. Unterblöcke besitzen eigene Datensätze. Ein Move verändert ausschließlich die Strukturabsichten; kein Inhaltsfragment wird neu angelegt oder umgehängt.

Die Platzierung wird aus ursprünglichem Baum und Operationshistorie berechnet. Operationen werden nach kausalem logischem Zeitpunkt, numerischer Actor-ID und binär verglichener Operations-ID geordnet. Der logische Zeitpunkt folgt der Summe des integrierten Yjs-State-Vektors und bleibt über Undo und Neustart hinweg monoton. Zwei konkurrierende Moves derselben Identität werden deterministisch nacheinander angewendet; es gibt genau eine Platzierung. Beide Absichten bleiben nachvollziehbar.

Eine Löschung markiert die zum Ausführungszeitpunkt betroffenen Identitäten einschließlich ihrer beobachteten Nachfahren. Sie gewinnt gegen deren konkurrierende Moves. Ein inzwischen gelöschtes Ziel wird nicht durch einen zufälligen Nachbarblock ersetzt. Ein konkurrierender Move, der einen Zyklus erzeugen würde, wird bei der deterministischen Auswertung verworfen und als Strukturkonflikt ausgewiesen. Neu eingefügter Inhalt unter einem gleichzeitig gelöschten Container bleibt im binären Zustand erhalten; eine verwaiste Struktur wird nicht stillschweigend als gültiges Dokument exportiert.

Undo erfasst nur die eigenen Änderungen an Inhalt und aktiven Operationen. Ein Undo des Moves entfernt dessen Platzierungswirkung und erhält fremde Textänderungen. Ausführungsbelege werden dabei nicht zurückgenommen: Ein wiederholter Zustellversuch derselben Operation darf kein versehentliches Redo bewirken. Explizites Redo bleibt möglich.

## ProseMirror-Adaptervertrag

Eine Editortransaktion liefert vorherigen und nächsten Dokumentzustand. Der Adapter prüft zunächst, dass der vorherige Zustand noch zum gebundenen CRDT-Dokument gehört. Danach werden veränderte Inhalte und Attribute anhand der Identitäten aktualisiert. Neue Blöcke erhalten neue Datensätze; gelöschte Datensätze bleiben für Recovery erhalten. Ein expliziter Drag-Move übergibt zusätzlich seine tatsächliche Quellidentität. Eine reine Reihenfolgedifferenz könnte dieselbe sichtbare Änderung sonst als Move eines Nachbarblocks interpretieren.

Strukturänderungen werden zunächst auf einer isolierten Replik geprüft, weil Yjs-Transaktionen bei Fehlern nicht zurückrollen. Erst wenn Projektion und ProseMirror-Ziel einschließlich IDs identisch sind, wird derselbe Plan synchron auf dem aktiven Dokument angewendet. Textänderungen erfordern keine solche Replik und erzeugen keine Platzierungsoperationen.

## Nachweis und noch offene Integration

`npm run test:collaboration:block-tree` prüft 16 Fälle: unterschiedliche Zustellreihenfolgen, Move/Text, Move/Move, Move/Delete, relative Textanker, Undo/Redo und Retry nach Undo, Zyklen, binäres Wiederöffnen mit verspäteten Abhängigkeiten, tatsächliche ProseMirror-Moves, atomare Einfüge-/Lösch-/Umhängoperationen, ungültige Container und stale Transaktionen sowie Task-/Tabellenidentitäten mit Formatierung und Unicode. Die ursprünglichen Gegenbeispiele gegen das alte Binding bleiben separat bestehen.

Vor Aktivierung fehlen weiterhin:

1. Ein Editor-Binding einschließlich Auswahl, Carets, IME, schreibgeschütztem Zustand und sauberem Unmount.
2. Eine eindeutige neue Representation und deren Client-Handshake. Alte Clients dürfen kein Schreib-Ticket dafür erhalten; ein altes `body`-Fragment darf nicht parallel schreibbar bleiben.
3. Migration mit ruhendem Room, bestätigtem Checkpoint, vollständigem Backup und Generation-Wechsel. Der Umstieg darf nicht allein aus einem lokalen Ansichtsschalter entstehen.
4. Gemeinsame Codec-/Agenten-/Review-Auflösung sowie Anzeige verworfener Strukturabsichten. Relative Anker müssen nur auf lebende, weiterhin zugehörige Inhalte angewendet werden.
5. Browserabnahme und Lastprüfung. Die Operationshistorie wird bewusst noch nicht abgeschnitten; eine spätere Verdichtung muss alte Clients und deren ausstehende Operationen über die Generation ausschließen und IDs/Belege erhalten.

Die grundlegende Einschränkung integrierter Shared Types und die selektive Undo-Konfiguration wurden mit den installierten Paketen und der [Yjs-Dokumentation](https://github.com/yjs/docs/blob/main/getting-started/working-with-shared-types.md) sowie der [UndoManager-Dokumentation](https://github.com/yjs/docs/blob/main/api/undo-manager.md) abgeglichen.
