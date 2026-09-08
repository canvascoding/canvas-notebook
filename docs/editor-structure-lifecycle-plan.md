# Plan: verlässliche Blockbearbeitung und kollaborativer Dokument-Lifecycle

Stand: 2026-09-08. Untersuchte Codebasis: `f2724821`.

Für die Probes verwendete, zum Lockfile passende Pakete: Tiptap Core `3.31.0`, `@tiptap/y-tiptap` `3.0.7`, Yjs `13.6.31` und serverseitig `y-prosemirror` `1.3.7`.

Status: ausgearbeiteter Plan mit Codeanalyse und gezielten Reproduktionen. Die Umsetzung ist noch nicht begonnen. Dieser Plan erweitert `docs/editor-stability-implementation.md` und die bestehende Collaboration-Policy um Strukturänderungen unter gleichzeitiger Bearbeitung. Er ersetzt keine bereits implementierten Schutzmechanismen.

## 1. Ziel und Priorität

Eine normale Editor-Aktion muss den beabsichtigten Block einschließlich seiner aktuellen Inhalte bearbeiten. Das gilt beim Alleinarbeiten, mit mehreren Nutzern und mit Agenten sowie über Speichern, Ansichtswechsel, Wiederverbinden und Wiederöffnen hinweg.

Priorität haben Inhaltszuordnung und Erhalt der Änderungen. Danach folgen Wiederherstellung, Bedienbarkeit und Diagnose. Ein erfolgreicher Markdown-Roundtrip allein beweist nicht, dass eine Änderung am richtigen Block angekommen ist.

Der bisherige Screenshot belegt einen blockierten Dateistand, aber nicht den konkreten Auslöser. Die folgenden Fälle verwenden neutrale Testinhalte; sie sind keine Rekonstruktion der privaten Datei.

## 2. Vorhandene Grundlage und nachgewiesene Lücken

Vorhanden sind ein gemeinsamer Yjs-Zustand, getrennte Verbindungs-/Persistenzzustände, Checkpoint-Fencing, generationsgebundene Sessions, lokale Recovery, relative Agentenanker, Ziel-Hashes, idempotente Agentenoperationen, Review/Revert und Regeln zum Erhalt stabiler IDs. Darauf baut die Umsetzung auf.

### Befunde aus gezielten Probes

| Fall | Beobachtung im aktuellen Code | Bedeutung |
| --- | --- | --- |
| Drag-Start auf `BBB`, danach Änderung zu `NEW`, danach Drop | Ergebnis enthält wieder `BBB`; `NEW` geht verloren | Die beim Drag-Start gespeicherte Node-Kopie wird wieder eingefügt |
| Drag-Start auf `BBB` in `AAA / BBB / CCC`, danach `XXX` davor einfügen | Ergebnis `XXX / BBB / CCC / BBB` | Alte Positionsgrenzen löschen `AAA`; `BBB` wird dupliziert |
| Move-Helper mit inzwischen `isEditable=false` aufrufen | Der Helper verschiebt weiterhin | Schreibrecht und Lifecycle müssen unmittelbar vor der Mutation geprüft werden; ein ausgeblendeter Handle allein genügt nicht |
| Handle innerhalb eines Task-Items bestimmen | Das Ziel ist die gesamte `taskList` | Die Erkennung berücksichtigt `listItem`, aber nicht `taskItem` |
| Agentenziel für `BBB` vorbereiten, dann Block verschieben | Agentenoperation erhält `target_changed`, obwohl derselbe sichtbare Block samt ID weiter existiert | Fachliche Block-ID und interne Yjs-Textidentität sind unterschiedliche Dinge |
| Auf Replik A `BBB` verschieben, auf Replik B gleichzeitig `BBB` durch `NEW` ersetzen, Updates austauschen | Beobachtetes Ergebnis `AAA / CCCNEW / BBB`; beide Repliken stimmen überein, Validator meldet gültig | Konvergenz und gültiger Markdown reichen als Korrektheitsnachweis nicht aus |
| Auf zwei Repliken denselben Block an verschiedene Stellen verschieben | Beobachtet wurden doppelte Block-IDs und zusammengeführte Nachbartexte | Gleichzeitige Strukturänderungen brauchen eine ausdrücklich definierte Semantik |

Die ersten vier Fälle wurden direkt mit dem produktiven Move-/Range-Code und ProseMirror-Zuständen geprüft. Die letzten drei verwenden zwei getrennte Yjs-Repliken, den installierten `@tiptap/y-tiptap`-Adapter und die produktiven Agentenfunktionen. Sie sind keine Browser-, Netzwerk- oder Produktionsabnahme. Die genaue Zusammenführung kann von Reihenfolge und Client-IDs abhängen; eine fehlerhafte Reihenfolge reicht als Gegenbeispiel.

Zusätzlich bleiben die zuvor reproduzierten Checkpoint-Fälle relevant: Fettformatierung mit Rand-Leerzeichen und aufeinanderfolgende harte Umbrüche in Tabellenzellen. Dort kann die Rückumwandlung Struktur verändern, obwohl der Markdown-Text stabil bleibt.

### Betroffene Stellen

- `app/lib/editor/reorderable-blocks.ts`: Range-Erkennung und `moveReorderableBlock`; derzeit Delete/Insert einer gespeicherten Node.
- `app/components/editor/MarkdownEditor.tsx`: `MarkdownBlockControls`, Dialogziele, Drag-State, Editor-Bindung und Ansichtswechsel.
- `app/lib/editor/canvas-unique-id.ts`: Identität nach Split/Join und Behandlung doppelter IDs.
- `app/lib/markdown/core/table-commands.ts`: Zeilen-/Spaltenbewegungen und Erhalt von Header/Ausrichtung.
- `app/lib/collaboration/agent-operations.ts`: relative Anker, Preflight, strukturelle Reviews und Revert.
- `app/lib/collaboration/agent-target-decorations.ts`: sichtbare Zuordnung von Agentenzielen.
- `app/lib/collaboration/client.ts`, `client-state.ts`, `local-recovery.ts`: Session, Binding, Speicherbestätigungen und Freigabe.
- `app/lib/files/document-transition.ts`, `app/store/file-store.ts`, `app/store/workspace-store.ts`: Wechsel zwischen Dokumenten und Workspaces.

Die vorhandenen Move-Tests behandeln hauptsächlich direkt aufeinanderfolgende Einzelaktionen. Die neuen Reproduktionen ergänzen gezielt Änderungen zwischen Drag-Start und Drop sowie konkurrierende Repliken.

## 3. Verbindliche Regeln für Struktur und Identität

| Operation | Identität und Inhalt |
| --- | --- |
| Verschieben | Block und Unterblöcke behalten ihre Identität; verschoben wird der aktuelle Inhalt |
| Kopieren/Duplizieren | Kopie und alle adressierbaren Unterblöcke erhalten neue IDs |
| Teilen | Der definierte ursprüngliche Teil behält seine ID; neue Teile erhalten neue IDs und nachvollziehbare Herkunft |
| Zusammenführen | Ein ausdrücklich definierter Block bleibt bestehen; Anker auf entfernte Identitäten werden nachweisbar umgesetzt oder als Konflikt behandelt |
| Typ ändern | Identität bleibt bei einer semantisch fortbestehenden Einheit erhalten; ein Schemawechsel wird validiert |
| Löschen | Ein später eintreffender Move oder Agentenpatch darf den gelöschten Block nicht unbemerkt wiederherstellen |
| Undo/Redo | Rücknahme betrifft die eigene Aktion und erhält inzwischen eingetroffene fremde Änderungen |

Weitere Invarianten:

- Jede lebende Block-ID ist im Dokument genau einmal vorhanden; jeder Block hat genau einen gültigen Elternknoten. Gleichzeitiges Umhängen darf keine Zyklen oder verwaisten Inhalte erzeugen.
- Eine Änderung an Block B darf nie in einem gleich aussehenden Block C landen. Gleicher Text ist kein Identitätsbeweis.
- Eine lokale strukturelle Aktion wird atomar angewendet und bildet eine eigene Undo-Einheit. Das allein löst noch keine Konflikte zwischen Repliken.
- Auswahl, Carets, Agentenmarkierungen und offene Dialoge folgen der fachlichen Zielidentität; veraltete absolute Positionen werden nicht ungeprüft verwendet.
- Ein Dokument besitzt genau eine schreibbare Representation. Read und Source-Ansicht beobachten denselben aktuellen Zustand.

## 4. Architekturentscheidung vor der breiten Integration

### 4.1 Gemeinsame Operationsregeln

Wiederverwendbare Mechanik für Zielauflösung, Identitätsprüfung, erlaubte Eltern-/Kind-Beziehungen, Transaktionsvalidierung und Fehlerergebnisse wird gemeinsam verwendet. UI-Aktionen behalten Auswahl, Fokus und Gesten; Agentenaktionen behalten Autorisierung, Review, Idempotenz und Audit. Kein universeller Dienst, der alle Verantwortlichkeiten übernimmt.

Eine strukturelle Operation beschreibt ihre Absicht, beispielsweise `move_block(blockId, targetParentId, beforeBlockId)`. Sie enthält Dokument-/Workspace-ID, Lifecycle-Generation, eine Operations-ID und die relevanten Vorbedingungen. Zeilenpositionen und Dateipfade allein sind keine dauerhaften Zielanker.

Beim Ausführen werden Quelle und Ziel im aktuellen Dokument erneut aufgelöst. Inhaltliche Änderungen im selben weiterhin vorhandenen Block sind bei einem reinen Move grundsätzlich zulässig. Ein verschwundenes, mehrdeutiges oder unzulässiges Ziel führt zu einem klaren Abbruch.

### 4.2 Block-ID ist noch keine verschiebbare CRDT-Identität

Die heutige Delete/Insert-Operation wird vom Yjs-Adapter in Änderungen an XML-Knoten und Texten übersetzt. Der Erhalt eines `id`-Attributs garantiert nicht den Erhalt des adressierten Yjs-Textobjekts. Deshalb darf die Korrektur nicht bei einer erneuten Suche nach `blockId` enden.

Ein begrenzter technischer Nachweis muss zuerst diese Fälle bestehen: Move gegen Textänderung im selben Block, Move gegen Move, Move gegen Delete, verschachtelte Moves und selektives Undo nach fremder Änderung.

Bevorzugt wird eine mit dem bestehenden Dokumentformat kompatible Lösung, **sofern** sie diese Invarianten nachweislich erfüllt. Ein Server-Mutex reicht nicht, solange bereits erzeugte Client-/Offline-Yjs-Updates ihn umgehen können. Auch bloßes Neuanlegen von XML-Knoten mit gleicher Block-ID ist kein Nachweis.

Wenn das bestehende Binding keine sichere Identität bei Moves gewährleisten kann, folgt eine versionierte Representation mit getrenntem Blockinhalt und Platzierung. Dabei bleibt der kollaborative Inhalt eines Blocks bestehen, während Eltern-/Reihenfolgeinformationen verändert werden. Eine einfache Y.Array mit Delete/Insert von IDs genügt dafür ebenfalls nicht: konkurrierende Platzierungen, Löschungen und Zyklen benötigen eindeutige Konfliktregeln. Die Tiptap-Projektion muss die Identität der Textänderungen erhalten und braucht einen geprüften Adapter.

Die Entscheidung wird mit reproduzierbaren Ergebnissen dokumentiert. Eine neue Representation erfordert Client-Kompatibilitätsprüfung, Migration bei ruhendem Room, Backup, Generation-Wechsel und Wiederherstellungsplan. Sie wird nicht beiläufig beim Öffnen eingeführt.

## 5. Erwartetes Verhalten bei gleichzeitigen Änderungen

| Gleichzeitige Aktionen | Erwartetes Verhalten |
| --- | --- |
| Nutzer verschiebt B, Agent ändert Text in B | B steht am neuen Ort und enthält die Agentenänderung |
| Nutzer verschiebt B, Agent bearbeitet C | Beide Änderungen bleiben unabhängig erhalten |
| Vor dem Drag-Ziel werden Blöcke eingefügt | Das Ziel wird über Identität und Platzierung neu aufgelöst |
| Zwei Nutzer verschieben denselben Block | Genau eine deterministisch aufgelöste Platzierung; kein doppelter Block, keine vermischten Nachbartexte |
| Zielblock oder Quelle wird während Drag gelöscht | Aktion abbrechen und verständlich melden; keine automatische Wiederherstellung |
| Zwei Personen verändern denselben Textbereich | Bestehende Hash-/Ankerprüfung; bei widersprüchlicher Änderung Review statt ungeprüftem Überschreiben |
| Agentenziel wird durch Split/Join mehrdeutig | Expliziter Strukturkonflikt; keine Suche nach zufällig gleichem Text |
| Nutzer nimmt seinen Move nach einer Agentenänderung zurück | Position zurücknehmen, neue Inhalte behalten |
| Ein Agent wird nach Transportfehler erneut ausgeführt | Dieselbe Operation höchstens einmal anwenden; ursprüngliches Ergebnis wiedergeben |
| Client kommt nach Generation-/Representation-Wechsel zurück | Alten Zustand sichern, alte Operation nicht in das neue Dokument schreiben |

Für konkurrierende Moves wird in der Architekturentscheidung eine deterministische Konfliktregel festgelegt und als Fixture dokumentiert. Eine nicht verwendete Platzierungsabsicht bleibt in der Operationshistorie nachvollziehbar. Bei Strukturverlust, ungültiger Elternbeziehung oder unklarer Zielidentität wird nicht automatisch weitergeschrieben.

## 6. Lifecycle über alle Editor-Aktionen

Ein gemeinsamer Dokumentkontext umfasst Workspace-ID, Dokument-ID, Generation und Representation. Eine davon getrennte lokale View-/Interaktionskennung schützt kurzlebige UI-Aktionen. Laufende Agentenarbeit darf weiterlaufen, wenn lediglich eine Ansicht geschlossen wird; veraltete UI-Callbacks dürfen dagegen keine neue Ansicht verändern.

| Übergang | Regel |
| --- | --- |
| Öffnen und Hydrieren | Editoraktionen erst nach korrekter Binding-Zuordnung und bestätigtem initialen Zustand freigeben |
| Read/Edit/Source wechseln | Dokumentzustand erhalten; keine Neuanlage aus Markdown. Laufenden Drag abbrechen, Dialogziele ausdrücklich beenden oder gültig weiterführen |
| Datei/Workspace wechseln | Lokale Interaktion beenden, aktuellen Zustand checkpointen oder vollständig lokal sichern; erst danach die konkrete View freigeben |
| Reconnect derselben Generation | Binären Zustand zusammenführen; weder altes `setContent` noch eine gespeicherte Node-Kopie zurückschreiben |
| Rename/Move der Datei | Dokument-ID erhalten, Pfadabhängigkeiten und Tickets korrekt erneuern; verspätete Antworten bleiben ihrem ursprünglichen Dokument zugeordnet |
| Schreibrecht entziehen | Unmittelbar vor jeder Mutation nochmals prüfen; Drag, Paste, Dialogbestätigung und Agenten-Apply berücksichtigen |
| Checkpointfehler | Dokumentzustand erhalten, Fehlerklasse unterscheiden und einen überprüfbaren Recovery-Pfad anbieten |
| Unmount/Tab-Schließen | View-Lebensdauer von noch benötigter Persistenz-/Operationslebensdauer trennen; Refcount/Cleanup ohne verspätete Schreibzugriffe |
| Browserabbruch/Prozessneustart | Laufende lokale Sicherung nicht erst auf ein unzuverlässiges Unload-Ereignis verschieben; Operationsergebnisse nach Neustart eindeutig rekonstruieren |

Die bestehenden Transition-Guards und Session-Prüfungen werden erweitert. Sie werden nicht durch eine zweite parallele Zustandsverwaltung ersetzt. Späte API-Antworten, Hydration-Promises, Menüs und Upload-/Paste-Ergebnisse müssen gegen den passenden Dokument- und Interaktionskontext geprüft werden.

## 7. Allgemeine Editor-Bedienung

Der gleiche Strukturvertrag gilt für Absätze, Überschriften, normale Listen, Task-Listen, verschachtelte Listen, Tabellen, Bilder, Codeblöcke, Zitate, Callouts, Details und Fußnoten.

- Drag-Ziele werden bei Transaktionen und Layoutänderungen aktualisiert. Autoscroll und eine eindeutig sichtbare Einfügekante bleiben synchron. Kein Drop in eigene Nachfahren oder unzulässige Container.
- Tastaturbefehle zum Verschieben verwenden dieselbe Operation wie Drag-and-drop. Escape beendet die Interaktion. Touch erhält eine bedienbare Alternative, ohne Textauswahl zu beschädigen.
- Task-Items werden als einzelne Einheiten behandelt; Listenwechsel, Ein-/Ausrücken und Split/Join erhalten Nummerierung, Checkboxstatus und Unterblöcke.
- Tabellenzeilen/-spalten brauchen dieselben Nebenläufigkeitsnachweise wie ganze Blöcke. Header, Ausrichtung, Zellidentität und Zellinhalt bleiben erhalten; die bestehenden Markdown-Grenzen für verbundene Zellen bleiben explizit.
- Copy/Paste und Duplizieren vergeben neue Identitäten. Ausschneiden/Einfügen sowie blockübergreifende Selections werden separat geprüft. Dokumentübergreifendes Drag darf nicht versehentlich die Quelle löschen.
- Offene Dialoge für Callouts, Details, Mathematik, Links und Bilder werden auf stabile Ziele bezogen. Ein inzwischen gelöschtes Ziel führt zu einer Meldung und erhält den Dialogentwurf.
- Eingabemethoden, Emoji, zusammengesetzte Unicode-Zeichen und aktive Textkomposition werden nicht durch Struktur- oder Agentenaktionen unterbrochen.
- Undo-Gruppierung und Cursorwiederherstellung gehören zur Operation. Fremde Änderungen und eigene Strukturaktionen dürfen nicht zu einer untrennbaren History-Einheit werden.

## 8. Umsetzung in abgeschlossenen Schritten

Jeder Schritt endet mit passenden Prüfungen, Scope-Review und eigenem Commit. Der nächste beginnt erst, wenn das Abschlusskriterium erfüllt ist.

### Schritt 1 — Reproduktionsbestand und verbindliche Erwartungen

Die oben belegten Fälle in dauerhafte neutrale Tests überführen. Vergleichsmaßstab sind Reihenfolge, Block-/Unterblock-IDs, Elternzuordnung, Text und Formatierung je Identität, Agentenanker sowie unveränderte Nachbarblöcke. Erfolgreiche Konvergenz und Roundtrip werden separat geprüft.

Abschluss: Die beobachteten Fehler sind reproduzierbar, ohne Browser-/Timing-Zufall und ohne produktive Daten. Bestehende Tests und neue Gegenbeispiele sind dokumentiert. Falls der erste Commit einen roten Reproduktionsbestand enthält, bleibt er als bewusster Zwischenstand isoliert und ist kein mergefähiger Abschluss.

### Schritt 2 — Lokale Move- und Interaktionsfehler schließen

Gespeicherte Node-Kopien und Positionsbereiche durch stabile Zielauflösung mit aktueller Prüfung ersetzen. Schreibrecht, Dokumentzuordnung, Zieltyp und zulässige Container an der Mutationsgrenze prüfen. Drag-State bei Abbruch/Ansichtswechsel bereinigen, Task-Items korrigieren und Fehler strukturiert zurückgeben.

Abschluss: Die ersten vier Probes sind grün; Bearbeiten/Einfügen/Löschen zwischen Drag-Start und Drop beschädigt keine Inhalte. Das ist ein begrenzter Fix und noch keine Freigabe konkurrierender Moves.

### Schritt 3 — Sichere kollaborative Move-Semantik nachweisen und umsetzen

Den technischen Nachweis aus Abschnitt 4.2 durchführen, die Format-/Binding-Entscheidung festhalten und den gewählten Weg für einen einfachen Block vollständig implementieren. Falls Migration nötig ist, gehört sie zu diesem Schritt. Erst danach weitere Strukturen anbinden.

Abschluss: Move/Text, Move/Move, Move/Delete und Undo erhalten Identitäten und Inhalte für unterschiedliche Update-Reihenfolgen, verzögerte und doppelte Zustellung. Es existiert kein schreibbarer alter Clientpfad, der die gewählte Regel umgehen kann.

### Schritt 4 — Strukturaktionen und Agentenziele integrieren

Die nachgewiesene Mechanik auf Listen, Task-Items, Container und Tabellen ausweiten. Agentenziele zusätzlich an die fachliche Blockidentität und geprüfte Strukturhistorie binden. Relative Textanker bleiben innerhalb fortbestehender Inhalte nutzbar; unklare Split-/Join-Ziele werden nicht automatisch neu zugeordnet. Review, Revert und Zielmarkierungen verwenden dieselbe Auflösung.

Abschluss: Ein verschobener Block bleibt für einen passenden Agentenpatch adressierbar; gleich aussehende Nachbarblöcke werden nie zum Ersatz-Ziel. Tabellen-/Containeraktionen bestehen dieselben Integritätsprüfungen.

### Schritt 5 — Dokument-Lifecycle und History durchgängig absichern

Die Übergänge aus Abschnitt 6 mit aktiven Strukturaktionen, Agentenoperationen und verzögerten Callbacks verbinden. Bestehende Registry/Guards gezielt erweitern. Undo eines Moves als Positionsänderung prüfen; Undo darf keine frühere Inhaltskopie über spätere fremde Änderungen legen.

Abschluss: Read/Edit-Wechsel, Navigation, Rename, Reconnect, Rechtewechsel und Neustart haben jeweils nachgewiesene Ergebnisse. Eine Speicherantwort des alten Dokuments kann das neue weder verändern noch als gespeichert markieren.

### Schritt 6 — Codec, Speicherdiagnose und Recovery vervollständigen

Die bereits reproduzierten Format-/Tabellenumbrüche reparieren, strukturierte Ursachen für fehlgeschlagene Checkpoints bereitstellen und die volle Yjs-Sicherung vor einer potenziell verlustbehafteten Markdown-Kopie bestätigen. Revalidierung nach einer Korrektur ermöglichen; Freigabe erst nach nachgewiesenem aktuellem Checkpoint.

Abschluss: Strukturtreue und Dateispeicherung werden getrennt bewiesen. Wiederhergestellte Zustände behalten IDs, Löschungen und aktuelle Inhalte. Die Diagnose enthält keine privaten Dokumenttexte in allgemeinen Logs.

### Schritt 7 — UI-Abnahme und integrierte Regression

Browserprüfungen mit zwei Nutzern und einem Agenten ergänzen. Reale Pointer-/Tastaturaktionen einschließlich Drag-Pause, Agentenänderung, Drop, Undo, Wechsel und Reload durchführen. Erst dieser Schritt belegt das Verhalten der vollständigen Editorintegration.

Abschluss: Die Matrix unten ist vollständig bestanden; keine ungeklärten Konsistenzfehler oder unbestätigten Speicheranzeigen. `npm run build`, passende Typ-/Lintprüfungen und betroffene Integrationssuiten sind erfolgreich. Kein Containerbau ohne ausdrückliche Beauftragung.

## 9. Abnahmematrix und Messung

Mindestens diese Szenarien werden über ProseMirror-/Yjs-Tests und anschließend die relevanten realen UI-Flows abgedeckt:

1. Block B bewegen, während vor B ein neuer Block eingefügt wird.
2. Block B bewegen, während B geändert wird; B am neuen Ort mit aktuellem Text.
3. Zwei Moves desselben Blocks mit vertauschter Zustellung; genau eine gültige Platzierung.
4. Move gegen Löschung von Quelle, Ziel oder Elterncontainer; keine Wiederauferstehung.
5. Verschachtelte Gegenbewegungen; keine Zyklen, keine verwaisten Kinder.
6. Listen teilen/zusammenführen, Task-Item verschieben, Tabelle umordnen; IDs und Semantik bleiben korrekt.
7. Nach Agentenänderung Move rückgängig machen und wiederholen; fremder Inhalt bleibt bestehen.
8. Identischen Text in mehreren Blöcken und Kopien bearbeiten; Agentenziel bleibt eindeutig.
9. Drag oder Dialog öffnen, anschließend Rechte-/Datei-/Workspace-/Ansichtswechsel; kein verspäteter Schreibzugriff.
10. Offline-/Reconnect-Zustände und Generation-Wechsel; keine alte Struktur in neuer Generation.
11. Verzögerte/überholte Checkpoints und reine Löschänderungen; keine unberechtigte Gespeichert-Anzeige. State Vector allein ist kein vollständiger Inhalts-/Delete-Set-Nachweis.
12. Fehler beim lokalen Speichern, Serverpersistieren und Dateischreiben; vollständige Recovery einschließlich erneuten Öffnens.

Der Testtreiber variiert Repliken, Zustellreihenfolge, Verzögerung, Duplikate und Restart-Punkte deterministisch. Feste Seeds und minimierte Gegenbeispiele werden gespeichert. Zufällige Zustandsfolgen ergänzen die konkreten Regressionen; sie ersetzen diese nicht.

Bei jedem Schritt werden Dokumentstruktur, ID-zu-Inhalt-Zuordnung, Formatierung, Agentenziel, Undo-Ergebnis und Persistenzstatus verglichen. Jede bestätigte Änderung muss im Ergebnis nachvollziehbar erhalten sein oder einen ausdrücklich sichtbaren Konflikt haben. Ein grün validierbarer, aber semantisch falsch zugeordneter Text ist ein Fehler.

Für große und tief verschachtelte Dokumente werden Transaktionsdauer, Zielauflösung und Drop-Reaktion gemessen. Ein Blockindex wird nur bei belegtem Bedarf ergänzt und muss inkrementell konsistent bleiben. Teure vollständige Roundtrips gehören nicht in jedes Pointer-Move-Ereignis.

## 10. Risiken, Freigaben und überprüfter Umfang

- GitNexus: `moveReorderableBlock` hat einen kleinen direkten Aufrufbereich (LOW); die semantische Datengefährdung ist durch die Probes dennoch hoch. Graphgröße ist kein Integritätsbeweis.
- `replaceRichMarkdownInYDoc` ist HIGH und erreicht auch mobile und Agentenpfade. Validator-/Äquivalenzänderungen sind ebenfalls HIGH. Vor Codeänderungen wird die Analyse für die konkreten Symbole erneut geprüft.
- Ein neues Blockmodell wäre eine größere Adapter-/Speichermigration mit eigener Kompatibilitätsabnahme. Dieser Aufwand wird nicht als einfacher Drag-Fix eingeplant.
- Ein erfolgreicher Code-/ProseMirror-Test ersetzt keine Browserabnahme. Gemäß `AGENTS.md` werden Playwright/vergleichbare Browserläufe erst nach expliziter Nutzerfreigabe ausgeführt. Für einen später benötigten lokalen Stack gilt `canvas-local-team-seat-dev`; keine parallelen Testumgebungen.
- Aktuell durchgeführt: Quellcode-/Historienanalyse, GitNexus-Kontext/Impact und gezielte isolierte Probes der produktiven Helfer. Im vorherigen Untersuchungsschritt liefen Core-, Preservation-, Lifecycle-, Checkpoint- und Recovery-Tests erfolgreich.
- Aktuell nicht durchgeführt: neue Browser-/E2E-Abnahme, neuer Build, Containerbau, Deployment oder Änderung produktiver Dokumente.

Die Planung ist abgeschlossen. Für die Umsetzung gilt die Reihenfolge 1 bis 7; die Architekturentscheidung in Schritt 3 ist ein verpflichtendes Ergebnis und darf nicht durch die Annahme ersetzt werden, eine gleichbleibende ID mache Delete/Insert automatisch kollaborativ sicher.
