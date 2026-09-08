# Plan: verlässliche Blockbearbeitung und kollaborativer Dokument-Lifecycle

Stand: 2026-09-08. Untersuchte Codebasis: `f2724821`.

Für die Probes verwendete, zum Lockfile passende Pakete: Tiptap Core `3.31.0`, `@tiptap/y-tiptap` `3.0.7`, Yjs `13.6.31` und serverseitig `y-prosemirror` `1.3.7`.

Status: Schritte 1 bis 4 sind im Code und in gezielten Kern-, Komponenten- und PostgreSQL-Tests umgesetzt. Der aktuelle Stand umfasst Blockidentitäten, Move-Semantik, Editorbindung, abgesicherte Formatmigration, Agentenanker und Strukturaktionen einschließlich Tabellenkonflikten. Als Nächstes folgen die verbleibenden Dokument-Lifecycle-, Codec-/Recovery- und Abnahmearbeiten aus Schritten 5 bis 7. Browserabnahme und vollständiger Build stehen noch aus. Dieser Plan erweitert `docs/editor-stability-implementation.md` und die bestehende Collaboration-Policy um Strukturänderungen unter gleichzeitiger Bearbeitung. Er ersetzt keine bereits implementierten Schutzmechanismen.

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

Umsetzungsstand: `block-reference.ts` trennt die Zielidentität von den aktuellen Positionsgrenzen. Referenzen sind an eine Editorinstanz gebunden; fehlende oder doppelte IDs werden nicht durch Textsuche ersetzt. Der gemeinsame Move-Helfer prüft Quelle, Drop-Ziel, Schreibrecht und erlaubte Grenzen beim Ausführen. Einfügen und Overlays verwenden dieselbe Auflösung. Task-Items behalten Checkbox und Unterblöcke. Transaktionen aktualisieren den Drag-State; Escape, Unmount, Editor-Zerstörung und Fensterwechsel räumen ihn auf. Abgebrochene Änderungen erhalten ein strukturiertes Fehlerergebnis und eine übersetzte UI-Meldung.

Nachweis: `npm run test:editor:blocks` besteht mit 11 Fällen; `npm run test:editor:markdown` und ESLint für die geänderten TypeScript-Dateien bestehen. Der vollständige Typecheck meldet ausschließlich drei Fehler zu `canvasWorkspaceBound` in den unveränderten DOCX-Pfaden mit den bereitgestellten Abhängigkeiten. Browserfreigabe ist angefragt; die tatsächliche UI-Abnahme steht noch aus. Die beiden Repliken-Gegenbeispiele bleiben bewusst offen bis Schritt 3.

### Schritt 3 — Sichere kollaborative Move-Semantik nachweisen und umsetzen

Den technischen Nachweis aus Abschnitt 4.2 durchführen, die Format-/Binding-Entscheidung festhalten und den gewählten Weg für einen einfachen Block vollständig implementieren. Falls Migration nötig ist, gehört sie zu diesem Schritt. Erst danach weitere Strukturen anbinden.

Abschluss: Move/Text, Move/Move, Move/Delete und Undo erhalten Identitäten und Inhalte für unterschiedliche Update-Reihenfolgen, verzögerte und doppelte Zustellung. Es existiert kein schreibbarer alter Clientpfad, der die gewählte Regel umgehen kann.

Teilstand 3.1: Der getrennte Inhalts-/Platzierungskern und sein ProseMirror-Transaktionsadapter bestehen 16 neutrale Repliken- und Strukturtests. Die Entscheidung und Konfliktregeln stehen in `docs/editor-block-tree-decision.md`. Das ist der abgeschlossene technische Nachweis, noch nicht der Abschluss von Schritt 3. Als Nächstes folgen innerhalb dieses Schritts das tatsächliche Editor-Binding (3.2) sowie Representation-Handshake und Migration (3.3). Der neue Kern ist bis dahin nicht an produktive Sessions angeschlossen.

Teilstand 3.2a: Eine neue Tiptap-Bindung verarbeitet lokale Transaktionen erst nach den angehängten ID-Transaktionen und übernimmt fremde Änderungen über minimale ProseMirror-Slices. Vier DOM-Komponententests prüfen zwei Editorinstanzen mit parallelem Move/Text und Undo/Redo, verzögerte Hydration, Schreibrechtentzug, rein lesende Updates, vollständige Listener-Freigabe, frühes Unmount und atomare Ablehnung ungültiger Änderungen. Vier weitere Tests prüfen Text-/Node-Selections, gelöschte und gleich aussehende Ziele, Unicode, Inline-Atome und binäres Wiederöffnen. Der Move-Helfer übergibt seine tatsächliche Quellabsicht und erkennt verworfene Transaktionen. Die Bindung ist noch nicht an produktive Sessions angeschlossen; insbesondere IME, entfernte Carets, Browserbedienung und der Protokollwechsel bleiben vor der Aktivierung offen.

Teilstand 3.2b: Entfernte Carets verwenden nun dieselben Anker; ihre Awareness-Veröffentlichung gehört einer konkreten View. Das Schließen einer alten View kann die aktuelle Auswahl einer anderen View nicht löschen. Ein zusätzlicher DOM-Test belegte, dass eine fremde Verschiebung den Textknoten einer laufenden Komposition ersetzt. Die Bindung hält während der Komposition deshalb eine isolierte Replik für die sichtbare Eingabe. Lokale Yjs-Updates werden unmittelbar an das Hauptdokument weitergereicht; fremde Änderungen werden nach dem Flush der letzten DOM-Eingabe sichtbar zusammengeführt. Eine Komposition bildet eine Undo-Einheit, erhält fremde Texte und Moves und verwendet bei Wiederholung dieselbe zusätzliche Client-ID. Insgesamt bestehen jetzt 13 Auswahl-/Bindingtests. Auch das Unmount während einer Komposition erhält bereits synchronisierte Eingaben und räumt Observer auf. Die tatsächliche OS-/Browser-IME-Abnahme und die Session-/Migrationsintegration bleiben offen.

Teilstand 3.3a: `rich-document.ts` bietet einen gemeinsamen, schema-normalisierten Leser für das bestehende XML- und das neue Blockformat. Import, Markdown-Export, Validierung und Quelltextersetzung verstehen beide. Die reine Formatkonvertierung übernimmt sämtliche vorhandenen IDs und Metadaten direkt und verändert das Quelldokument nicht. Zwölf Codec-Tests prüfen Formatparität, leere Dokumente, binäres Wiederöffnen, Move/Text bei Quelltextersetzung und Ablehnung gemischter oder unbekannter Wurzeln. Die bestehenden Rich-Block-/Leerblock-Regressionen und alle 16 Kerntests bleiben grün. Der Standard bleibt bis zur vollständigen Sessionintegration das bisherige XML-Format; die neue Konvertierung wird noch nicht auf persistierte Sessions angewendet.

Teilstand 3.3b: Das Backend kennt `tiptap_blocks` als getrennte Repräsentation. Der Session-Handshake verlangt dafür passende Rich-Schema- und Blockformatversionen. Alte Clients erhalten für umgestellte Dokumente kein Ticket. Die bestehende Migration erhält bei Rich-zu-Rich-Wechseln die IDs direkt, sichert den vollständigen vorherigen Zustand und erhöht die Generation; leerer Room und bestätigter Checkpoint bleiben Voraussetzungen. PostgreSQL-Tests in einer temporären Datenbank auf dem verwalteten lokalen Server bestanden den Schema-Upgrade, neue Sessions, Kompatibilitätsfehler, offene Rooms, ausstehende Checkpoints, Backupvergleich und verspätete Writes. Die bestehende Agenten-Integrationssuite bestand ebenfalls. Mobile und Agenten unterscheiden beide Rich-Repräsentationen von Plain Text. Die browserseitige Anbindung und die Auflösung lebender Agentenziele im Blockformat stehen weiterhin aus; der Webclient meldet die neue Fähigkeit deshalb noch nicht an.

Teilstand 3.3c: Direkte Agentenziele tragen im Blockformat zusätzlich die geprüfte Block-ID. Auflösung, Preflight, Review und Revert berücksichtigen ausschließlich sichtbare Inhalte; gespeicherte Texte gelöschter Blöcke bleiben für Recovery erhalten, sind aber keine gültigen Schreibziele. Mehrdeutige Textsuche erfordert eine passende explizite Trefferanzahl. Review-Markierungen verwenden dieselben relativen Blockanker. Fünf neue Tests bestehen Move/Wiederöffnen/Revert, Löschung, doppelte Texte, Frontmatter/Unicode/Formatierung und Markierungen einschließlich ungültiger Recovery-Formate. Die PostgreSQL-Suite beweist zusätzlich den persistierten Agentenpatch nach einem Move, Dateicheckpoint und Revert. Bestehende Agenten-, Hardening- und PostgreSQL-Integrationstests bleiben grün. Noch folgt der Anschluss des Webeditors; die breitere Struktur- und Lifecycle-Matrix bleibt Gegenstand der folgenden Schritte.

Teilstand 3.3d: Der Webclient meldet beide Formatversionen an und prüft die Antwort vor dem Öffnen einer Session. `rich-editor-extensions.ts` wählt genau eine Bindung; der echte Markdown-Editor nutzt diese Auswahl einschließlich Carets und Agentenmarkierungen. Bestehende XML-Dokumente durchlaufen vor formatiertem Bearbeiten die gesperrte Migration. Read/Source beobachten das neue Format direkt. Die 13 Binding-/Auswahltests laufen nun über die produktive Erweiterungsauswahl; ein zusätzlicher React-Test prüft Live-Text/Move und Listener-Abbau beim Dokumentwechsel. PostgreSQL-Migration und Agentenpatch/Revert sowie bestehende Live-/Checkpoint-/Lifecycle-Tests bestanden. Browserfixtures wurden auf die neue Generation und den neuen Handshake angepasst, aber noch nicht ausgeführt. Die echte Browserabnahme, breitere Struktursemantik, verbleibende Lifecycle-Lücken und Codec-/Recovery-Fälle sind weiterhin offen.

### Schritt 4 — Strukturaktionen und Agentenziele integrieren

Teilstand 4.1: Zwei zusätzliche Gegenbeispiele belegten unterschiedlich sortierte Kopf-/Datenzeilen nach parallelen Spaltenaktionen. Der Strukturkern gruppiert jetzt sämtliche Teilbewegungen einer Editortransaktion mit gemeinsamem kausalem Stempel und interner Reihenfolge. Neue Blöcke erhalten auch bei scheinbar passender Ausgangsposition eine ausdrückliche Platzierung, damit konkurrierende Einfügungen nicht von zufälligen Zell-IDs abhängen. Die 20 Kerntests enthalten 1.152 Umordnungsabläufe (alle 576 Vier-Spalten-Paare in beiden Zustellrichtungen), Einfügung/Einfügung, Löschung/Move und Undo/Redo mit fremder Zelländerung. Binding- und Agentenregressionen bestehen weiterhin. Die breitere Befehlsintegration, Split/Join und Konfliktanzeige folgen innerhalb dieses Schritts.

Teilstand 4.2: Sieben produktive Tabellenbefehle werden jetzt durch die Blockbindung einschließlich exakter ID-Erhaltung bei Undo/Redo und binärem Wiederöffnen geprüft. Hinzu kommen das Herauslösen eines mittleren Listeneintrags mit fremder Textänderung, dessen Undo/Redo sowie Text-Split/Join. Dabei wurde eine weitere Bindungslücke geschlossen: Ein automatisch angehängter Absatz durfte nach Hydration nur in der View stehen und blockierte danach echte Eingaben. Der Dispatcher schützt autoritative Projektionen und verhindert, dass reine Auswahl-/Fokus-/Create-Transaktionen zu Inhaltsänderungen werden. Ein Test wartet ausdrücklich auf verzögerte Create-Callbacks und vergleicht den vollständigen Yjs-Zustand. Insgesamt bestehen 23 Auswahl-/Bindingtests mit der produktiven Canvas-ID-Erweiterung.

Teilstand 4.3: Mehrfachauswahlen in Tabellen tragen Tabellen-ID, beide Randzellen und die vollständige ausgewählte Zellmenge. Sie folgen Moves und binärem Wiederöffnen. Wenn eine Umordnung fremde Zellen in das Auswahlrechteck einschiebt oder ein Ziel löscht, wird die Auswahl verworfen. Awareness und entfernte Hervorhebungen verwenden denselben Vertrag und markieren einzelne Zellen. Drei zusätzliche Anker-/DOM-Tests bestehen, insgesamt 26 Auswahl-/Bindingtests.

Teilstand 4.4: Verworfene konkurrierende Platzierungen lösen pro View und Absicht eine übersetzte Warnung aus; ein gültiges Dokument bleibt bearbeitbar. Die Anzeige deckte einen weiteren Kernfehler auf: Das vorzeitige Entfernen sämtlicher später gelöschter Anker konnte bereits angenommene Moves rückwirkend aufheben. Löschungen werden jetzt an ihrer kausalen Stelle ausgewertet. Ein Move vor einer späteren Löschung behält seine Wirkung; ein Move nach Löschung wird abgewiesen. Die Tests bestehen mit 21 Kernfällen, 27 Auswahl-/Bindingfällen und sechs Agentenfällen. Der zusätzliche Agententest verlangt nach Textübertragung durch Split/Join explizite Prüfung, statt relative Anker an eine andere Blockidentität zu verleihen.

Teilstand 4.5: Gleichzeitiges Einfügen einer Zeile und einer Spalte kann eine nicht rechteckige Tabelle erzeugen. Der gemeinsame Blockleser prüft deshalb zusätzlich die ProseMirror-Tabellengeometrie. Ungültige Ergebnisse werden weder als aktuelle View noch als gültiger Checkpoint ausgegeben; sämtliche Zellrecords bleiben binär wiederherstellbar. Die Bindung lässt selektives Undo zur Auflösung zu, solange die View besteht und Schreibrecht vorliegt. Ein DOM-Test nimmt die eigene Zeile zurück, erhält die fremde Spalte, synchronisiert beide Views wieder und setzt die Bearbeitung fort. Kern (22), Auswahl/Binding (28), gemeinsame Rich-Codecs (12) und Agentenziele (6) bestehen. Der weitere Wiederherstellungsablauf nach einem fehlgeschlagenen Servercheckpoint bleibt Bestandteil von Schritt 6.

Abschlussnachweis Schritt 4: Die PostgreSQL-Suiten für Format-Handshake, Migration, Backup, veraltete Generationen, verschobene Agentenziele, Checkpoints und Revert sowie die bestehende Agentenoperationen-Integration bestanden erneut. Die temporäre Datenbank wurde entfernt. Der gemeinsame Leser hat einen hohen Aufrufbereich (15 direkte Aufrufer); Scope-Review und die genannten Integrationsprüfungen begrenzen das Änderungsrisiko. Die reale Browserabnahme bleibt separat offen.

Die nachgewiesene Mechanik auf Listen, Task-Items, Container und Tabellen ausweiten. Agentenziele zusätzlich an die fachliche Blockidentität und geprüfte Strukturhistorie binden. Relative Textanker bleiben innerhalb fortbestehender Inhalte nutzbar; unklare Split-/Join-Ziele werden nicht automatisch neu zugeordnet. Review, Revert und Zielmarkierungen verwenden dieselbe Auflösung.

Abschluss: Ein verschobener Block bleibt für einen passenden Agentenpatch adressierbar; gleich aussehende Nachbarblöcke werden nie zum Ersatz-Ziel. Tabellen-/Containeraktionen bestehen dieselben Integritätsprüfungen.

### Schritt 5 — Dokument-Lifecycle und History durchgängig absichern

Teilstand 5.1: `interaction-target.ts` kapselt kurzlebige Bereichs- und Knotenziele. Bereiche nutzen im Blockformat relative Textanker und vergleichen vor einer Ersetzung den vorbereiteten Inhalt; lokale Ziele folgen unveränderten Blockidentitäten. Ganze Knotendialoge lehnen zwischenzeitlich geänderte Inhalte ab. Abbruch, Schreibschutz, Komposition, gelöschte Ziele und eine andere Editorinstanz verhindern die Ausführung. Der gemeinsame React-Hook widerruft gespeicherte Callbacks bei Schließen, Editorwechsel und Unmount, einschließlich StrictMode. Linkdialog, Desktop-/Mobile-Linköffner, Linkmenü und URL-Paste erfassen ihre Ziele beim Auslösen. Eine übersetzte Meldung lässt den Dialogentwurf bei Konflikten bestehen. 31 Auswahl-/Bindingtests sowie der neue React-/URL-Paste-Lifecycle-Test bestehen; ESLint ist grün, der Typecheck enthält weiterhin ausschließlich die bekannten DOCX-Abhängigkeitsfehler. Weitere Dialoge, mobile Auswahlwiederherstellung, asynchrone Bildimporte und die Speicherbestätigung folgen innerhalb dieses Schritts.

Teilstand 5.2: Die mobile Werkzeugleiste hält eine identitätsgebundene Auswahl ab Beginn einer Berührung oder Menüaktion fest. Wiederholte Pointer-/Touch-Ereignisse und Remote-Transaktionen ersetzen dieses Ziel nicht. Vor der Ausführung wird die aktuelle Auswahl einschließlich Rückwärtsselektion, Knotenauswahl und exakter Tabellenzellenmenge wiederhergestellt; geänderte oder gelöschte Ziele werden ohne Positionsfallback abgelehnt. Editorwechsel und Unmount widerrufen auch gespeicherte Toolbar-Callbacks. Undo/Redo benötigen kein gültiges Dialogziel und bleiben für Struktur-Recovery verfügbar. Die 32 Auswahl-/Bindingtests und der React-Test für gehaltene Toolbar-Ziele bestehen. Kein echter Browserlauf; die UI-Abnahme bleibt offen.

Teilstand 5.3: Bild- und Emoji-Dialoge erfassen ihr Ziel beim Öffnen über Toolbar oder Slash-Kommando. Die Bestätigung prüft die Identität und den vorbereiteten Inhalt erneut; es gibt keinen Rückfall auf eine alte Position oder die aktuelle Auswahl. Bildimporte besitzen einen eigenen abbrechbaren Request pro Dialogöffnung. Doppelte Bestätigungen, verspätete Antworten nach Abbruch/Editorwechsel und veraltete Callbacks nach erneutem Öffnen werden abgefangen; der Abbrechen-Knopf bleibt während des Imports bedienbar. Datei-, Workspace-, Dokument-, Generations- oder Representation-Wechsel ersetzen die Rich-Editoransicht und schließen damit ihre Interaktionen. Das bricht Client-Requests und Einfügungen ab; bereits serverseitig gespeicherte Bilddateien werden nicht automatisch gelöscht. Der React-Lifecycle-Test und 33 Auswahl-/Bindingtests einschließlich Bild-/Emoji-Ersetzung nach Move und Undo bestehen. ESLint ist grün; der vollständige Typecheck zeigt weiterhin nur die bekannten DOCX-Abhängigkeitsfehler. Rich-Block-/Tabellendialoge, History-Lebensdauer und Speicherbestätigung sind noch offen.

Teilstand 5.4: Callout-, Details-, Formel-, Fußnoten- und Tabellendialoge speichern stabile Knoten-/Bereichsziele statt absoluter Positionsnummern. Beim Anwenden werden Snapshot, aktuelle Editorinstanz und Schreibfähigkeit geprüft; fehlgeschlagene Aktionen schließen den Entwurf nicht. Geschlossene oder ersetzte Dialogziele werden widerrufen. Auch das per Animation Frame geöffnete Blockmenü löst sein Ziel beim Öffnen und Ausführen neu auf. `rich-block-commands.ts` bündelt die tatsächlich ausgeführten Titel-, Fußnoten- und Formeländerungen; Fußnoten verwenden die aufgelöste Knotenposition. Löschen und Formeleinfügen erfolgen nun in einer einzigen Undo-Transaktion. 39 Auswahl-/Bindingtests einschließlich beider Containerarten, beider Formelarten, Fußnote und Tabelle bestehen; React-Lifecycle und ESLint bestehen, der Typecheck enthält weiterhin nur den DOCX-Bestand. Offen bleiben unter anderem die vorhandene vereinfachte Textbearbeitung mehrteiliger/formatierter Fußnoten, DOM-Details-/Metadatenaktionen, Undo-Gruppierung und History über Ansichtswechsel sowie der Nachweis reiner Löschänderungen beim Speichern.

Teilstand 5.5: Reine Attributänderungen an Callouts/Details erhalten unveränderte Titel einschließlich Formatierung. Der Fußnotendialog liest und ersetzt jetzt den gesamten Inhalt als Markdown; mehrere Absätze, Listen und Inline-Formatierung gehen dabei nicht mehr im ersten Absatz auf. Unveränderte Unterblöcke und fortbestehende bearbeitete Blöcke behalten ihre IDs. Dafür liegt die bestehende ID-Zuordnung aus `markdown-state.ts` unverändert in `rich-node-identities.ts`, gemeinsam für Server und Editor. Neue formatierte Fußnoten werden einschließlich Referenz und Definition als eine Undo-Einheit eingefügt. Dialoginhalte werden nicht pauschal getrimmt, damit Markdown-Einrückungen erhalten bleiben. 42 Auswahl-/Bindingtests, 12 Rich-Dokumenttests, 6 Agentenzieltests und beide isolierten PostgreSQL-Integrationssuiten bestehen. ESLint ist grün; der Typecheck zeigt weiterhin nur die bekannten DOCX-Abhängigkeitsfehler. Die offenen Lifecycle-, History-, Speicher- und Codec-Punkte aus Schritten 5 bis 7 bleiben bestehen.

Teilstand 5.6: Die Betätigung einer Details-Zusammenfassung ist an die aktuelle ProseMirror-DOM-Instanz und deren Lebensdauer gebunden. Native `toggle`-Ereignisse aus DOM-Projektion oder schreibgeschützter Betrachtung schreiben nichts zurück, auch wenn sie erst nach einem Rechtewechsel eintreffen. Fehlende/mehrdeutige IDs fallen nicht auf Nachbarpositionen zurück; Schreibschutz, Komposition, ungültige Bindung und Cleanup verhindern Schreibzugriffe. Metadatenänderungen prüfen die aktive beschreibbare Editorinstanz. Ein veralteter Eigenschaftenentwurf liefert ausschließlich den neuen Frontmatter-Präfix; aktueller Text und vorhandene finale Zeilenenden bleiben erhalten. Im kollaborativen Fall veröffentlicht ausschließlich der bestehende gemeinsame Observer den aktuellen Text mit den neuen Metadaten, sodass die alte Entwurfsfassung nicht anschließend zurückgeschrieben wird. 44 Auswahl-/Bindingtests einschließlich echter DOM-Details-Ereignisse in JSDOM und einer Metadaten-Regression bestehen. ESLint ist grün; der Typecheck enthält nur die DOCX-Bestandsfehler. Reale Browserabnahme bleibt ausstehend.

Teilstand 5.7: Die Undo-History gehört jetzt dem gemeinsamen Yjs-Dokument und bleibt beim Ersetzen einer Block-Editoransicht erhalten. Jede View registriert ausschließlich ihren lokalen Ursprung und gibt ihn beim Schließen wieder frei; fremde Repliken-/Agentenänderungen bleiben außerhalb dieser History. Laufende Texteingabe wird innerhalb desselben Blocks und derselben Auswahlfolge gruppiert, einschließlich fremder Moves und Einfügungen. Cursorwechsel, Pausen, Formatierungswechsel und Strukturaktionen bilden Grenzen; Komposition bleibt eine eigene Einheit. Vorher-/Nachher-Auswahlen werden über stabile Block- und Textanker wiederhergestellt. Andere montierte Views aktualisieren ihre Undo-/Redo-Verfügbarkeit nach der gemeinsamen Änderung. 48 Auswahl-/Bindingtests und der React-Lifecycle-Test einschließlich der gemeinsamen Toolbar-Anzeige bestehen; ESLint ist grün, der Typecheck meldet ausschließlich den bekannten DOCX-Abhängigkeitsbestand. Wiederholtes Montieren hält die Dokument-Observer konstant; erst das Verwerfen des Yjs-Dokuments beendet die History. Die History wird nicht in binäre Recovery-Dateien exportiert. Die tatsächliche Dokumentlebensdauer der Registry sowie lokale/Source-Ansichten und Speicherbestätigungen sind weiterhin gesondert zu prüfen.

Teilstand 5.8: Speicherbestätigungen führen zusätzlich `stateProof` (`yjs-snapshot-sha256-v1`) mit. Der gemeinsame Nachweis hasht den kanonischen Yjs-Snapshot aus State-Vector und zusammengefassten Löschbereichen; reine Löschungen unterscheiden sich damit auch bei identischem State-Vector. Unvollständig integrierte Updates erhalten keinen Nachweis. Server-Sessions, WebSocket-Meldungen und Checkpoint-Antworten leiten ihn aus dem gespeicherten Binärzustand ab. Der Checkpoint-Endpunkt verlangt ihn vor Materialisierung und vor dem schnellen „bereits gespeichert“-Pfad; ältere manuelle Checkpoint-Clients müssen aktualisiert werden. Dokument-ID, Generation und Sequenz bleiben zusätzliche Prüfungen. Der Client zertifiziert eine Session erst nach Hydration und tatsächlichem Zustandsvergleich; jede Dokumentänderung widerruft die Anzeige sofort, noch vor dem Versand durch den Provider. Verspätete Meldungen ersetzen keinen neueren ausstehenden Nachweis. Sechs Beweis-/Reducerfälle, ein React-Test mit dem produktiven Client-Hook und ausgetauschten Transport-/IndexedDB-Adaptern sowie ein Checkpoint-Endpunkttest bestehen. Beide PostgreSQL-Integrationssuiten bestehen, einschließlich reiner Textlöschung im Blockformat, abgewiesenem alten Checkpoint und bestätigtem Dateiinhalt. Die temporäre Datenbank wurde entfernt. Bestehende Client-Lifecycle-, Live-, Hardening- und Mobile-Notebook-/Ticket-Tests sowie scoped ESLint bestehen; der Typecheck enthält nur den bekannten DOCX-Bestand. Die GitNexus-Scope-Prüfung stuft die Gesamtänderung wegen der gemeinsam betroffenen Editor-/Session-Pfade als HIGH ein; alle 17 geänderten Dateien liegen im erwarteten Umfang. Der Zustandsnachweis ersetzt keine binäre Recovery-Sicherung. Die Registry-/Ansichtsübergänge, Codec-/Recovery-Arbeit und vollständige UI-/Build-Abnahme bleiben offen.

Teilstand 5.9: Jeder Registry-Eintrag besitzt eine abbrechbare Lebensdauer. Nach Modul-/Session-Laden, IndexedDB-Hydration, Token-Erneuerung und HTTP-Antwort wird geprüft, ob genau dieser Eintrag noch gültig ist. Endgültiges Cleanup widerruft Requests und Synchronisations-Wartefunktionen, schließt Provider/Persistenz/Dokument und kann keinen neueren Eintrag desselben Schlüssels entfernen. Verspätete Antworten werden auch dann verworfen, wenn ein Transport den Abbruch ignoriert. Session- und Checkpoint-Requests verwenden den ursprünglichen Dokument-Workspace; der Session-Resolver bricht bei Schlüsselwechsel seinen Request ab. Die bestehende kurze Wiederverwendungsfrist bleibt erhalten. Der produktive Client-Hook wurde mit Wiederöffnen desselben Schlüssels vor der alten Antwort, spätem IndexedDB-Abschluss, bereits geschlossenen Callbacks, abgebrochenem Sync-Warten und spätem Checkpoint-Erfolg geprüft. Diese Fälle sowie die Durability- und Code-Editor-Lifecycle-Suiten und scoped ESLint bestehen. Der Parent hält das kollaborative Dokument auch in Read und in der schreibgeschützten Rich-Source-Ansicht; die neue Block-History bleibt deshalb während dieser Ansichtswechsel verfügbar. Lokale Rich-/Source-Editor-History ohne Kollaboration, Rename-Verhalten sowie Codec-/Recovery- und Browserabnahme bleiben gesonderte offene Punkte.

Teilstand 5.10: Ein lokaler Dokumentkern besitzt jetzt eine gemeinsame ProseMirror-History für Rich-Inhalt, Originalquelltext, Frontmatter und Auswahlen. Editoransichten erhalten widerrufbare Schreibzugriffe; ein Nachfolger ersetzt die alte View, ohne ihre History zu übernehmen oder zu löschen. Quelltext, der vorübergehend nicht verlustfrei darstellbar ist, bleibt unverändert erhalten; Undo stellt die vorherigen Rich-Blöcke samt IDs wieder her. Externe Ersetzungen beginnen eine neue History, reine Parent-Bestätigungen erhalten sie. Metadatenentwürfe ändern nur den Präfix und behalten den aktuellen Body. Sechs Kerntests sowie scoped ESLint bestehen. Der Kern ist in diesem Teilstand noch nicht an die sichtbaren Tiptap-/CodeMirror-Ansichten angebunden; diese Integration ist der unmittelbar folgende Arbeitsschritt. Reale Browserabnahme bleibt offen.

Teilstand 5.11: Die lokale Tiptap-Anbindung verarbeitet Änderungen vor Übernahme in die sichtbare Editor-State und delegiert Undo/Redo an den Dokumentkern. Sie projiziert vollständige Dokumentzustände und Auswahlen exakt, widerruft alte Views und verhindert automatische Inhaltsänderungen bei Fokus oder Projektion. Komposition bildet eine eigene History-Einheit und sperrt Moves bis zum Abschluss. Die kollaborative und lokale Anbindung teilen sich die Klassifikation fortlaufender Texteingaben sowie die exakte ProseMirror-Projektion. Zwölf lokale Kern-/Tiptap-Tests einschließlich Tabellenspalten, Zellenauswahl, Metadaten, Read-only und Neuaufbau sowie alle 48 kollaborativen Auswahl-/Bindingtests bestehen; scoped ESLint besteht. Die Anbindung ist noch nicht in den React-Editor eingesetzt. CodeMirror-Anbindung, Parent-Lebensdauer und externe Value-Synchronisation sind die folgenden Integrationsschritte; Browserabnahme bleibt offen.

Teilstand 5.12: CodeMirror besitzt nun eine Anbindung über seinen regulären `dispatchTransactions`-Einstieg. Sie prüft View-Lebensdauer, Schreibrechte, Dokumentrevision und den Ausgangszustand vorbereiteter Transaktionen vor der sichtbaren Übernahme. Quelltextänderungen und Undo/Redo laufen durch denselben Dokumentkern wie Rich-Änderungen. Mehrere Auswahlen samt Hauptauswahl, Unicode und gemischte CR/LF-Zeilenenden bleiben im Originalquelltext erhalten. Alle 17 lokalen Kern-/Tiptap-/CodeMirror-Tests und scoped ESLint bestehen; der Typecheck enthält nur den bekannten DOCX-Abhängigkeitsbestand. Der React-Host muss diese Anbindung über den dokumentierten CodeMirror-Konstruktor einsetzen; der bisherige UIW-Wrapper reicht diesen Konstruktorparameter nicht durch. Die sichtbare Parent-Integration und vollständige UI-Abnahme bleiben offen.

Teilstand 5.13: Der React-Parent hält das lokale Dokument jetzt für Workspace, Pfad, Frontmatter-Modus und Betriebsart. Rich-Editor und Source verwenden die neuen Anbindungen; Lesen zeigt denselben aktuellen Zustand. Der CodeMirror-Host nutzt die bestehenden UIW-Setup-/Theme-Erweiterungen mit dem dokumentierten eigenen Dispatch-Einstieg. Parent-Bestätigungen erhalten History und neuere Eingaben; begrenzte Fingerprints erkennen verspätete Bestätigungen, ohne vollständige Kopien alter Texte aufzubewahren. Externe Ersetzungen starten eine neue History; `when-blurred` wird bei Blur oder Ansichtswechsel tatsächlich abgearbeitet. Der Parent widerruft Schreibrechte beim Scope-Wechsel oder Unmount; React-StrictMode-Cleanup kann anschließend wieder verbinden. Explizite Markdown-Normalisierung ist eine normale Undo-Aktion und kann zur ursprünglichen Source-Ansicht zurückkehren.

Der produktive `MarkdownEditor` wurde in JSDOM mit echten Tiptap-/CodeMirror-Instanzen geprüft: Öffnen ohne Änderung, StrictMode, Text plus Block-Move, Read/Rich/Source-Wechsel, gemeinsame Undo-Folge, spätes Parent-Ack, externe Änderung bis Blur, Normalisierung mit Undo, Dateiwechsler für beide Editortypen, Rechtewechsel ohne neuen Source-Editor und Tastatur-Undo. Router-/Preview-/Renderer- und Store-Ränder sind im Test ersetzt; Layout und echte Pointer-/IME-Browserereignisse werden damit nicht abgenommen. Die 17 lokalen Kern-/Bindingtests, bestehende Feld-/Interaktions-/Code-Editor-Lifecycle-Suiten, gemeinsame Markdown-Core-Prüfungen und scoped ESLint bestehen. Der vollständige Typecheck meldet nur den bekannten DOCX-Abhängigkeitsbestand. Rename, weitere Extension-/History-Sonderfälle, Codec-/Recovery-Arbeit, Performance, vollständiger Build und Browserabnahme bleiben offen.

Teilstand 5.14: Kollaborative Text-/Source-Ansichten verwenden eine selektive Yjs-History pro Textdokument. Der reproduzierte Tastaturfehler, bei dem Undo eine fremde Einfügung entfernte, ist behoben; die native CodeMirror-History ist für diese Ansichten deaktiviert. Eingabe-/Löschgruppen, Komposition und relative Mehrfachauswahlen überleben fremde Änderungen und den Neuaufbau einer Ansicht. Nicht aufgezeichnete Transaktionen bleiben bei Undo erhalten. Schreibschutz und Dokument-Cleanup sperren History und weitere Änderungen. Die Anbindung setzt die öffentlichen Sync-/Cursor-Erweiterungen zusammen und beendet den ungenutzten Undo-Manager, den die Bibliothek bereits beim Erzeugen der Sync-Konfiguration anlegt. Wiederholte Ansichten sammeln damit keine zusätzlichen Dokument-Observer an. Vier Kernfälle und der produktive React-CodeEditor in JSDOM bestehen einschließlich Tastatur-Undo/Redo, fremdem Text, neuer View und Rechtewechsel; scoped ESLint besteht. Echte Browser-/IME-Abnahme, Rename und die übrigen Schritte bleiben offen.

Teilstand 5.15: Jede geladene Datei erhält eine lokale Öffnungskennung. Der Markdown-Parent und sein lokaler Dokumentkern verwenden sie unabhängig vom Pfad; Refresh und Datei-/Ordner-Rename erhalten sie, ein neuer Load ersetzt sie. Rich- und Source-Interaktionen werden bei Rename weiterhin geschlossen und widerrufen. Ein neuer React-Lifecycle-Fall belegt Block-Move/Undo sowie Source-Änderung/Undo über zwei Renames, verworfene alte Dispatches und leere History bei einem neuen Dokument am gleichen Pfad. Der produktive File-Store wurde mit Laden, Refresh und beiden Rename-Arten geprüft; die bestehende Save-Session wird beim Rename weiterhin erhöht, sodass alte Speicher-Callbacks ungültig bleiben. Datei-Lade-/Race-Tests bestehen. Scoped ESLint hat keine Fehler und eine unveränderte `savedTime`-Warnung in `FileEditor`. GitNexus stuft den FileEditor-Pfad als HIGH und den weit referenzierten gemeinsamen Dateityp als CRITICAL ein; dessen Erweiterung ist optional. Die kollaborative Registry-/Session-Übernahme beim Rename ist der nächste gesonderte Teil und hier noch nicht umgesetzt.

Teilstand 5.16: Die kollaborative Registry trennt den Pfad von der lokalen Öffnungskennung und der bestätigten Dokument-ID/Generation/Representation. Während der Session-Auflösung eines Rename bleibt ihr Eintrag referenziert, auch wenn die Antwort länger als die Cleanup-Frist braucht. Die neue Session ersetzt ausschließlich die Provider-Verbindung; Yjs-Dokument, IndexedDB-Persistenz und History bleiben bestehen. Ein neuer Request-Scope widerruft alte Checkpoint-/Token-Aufrufe und Provider-Meldungen; alte `finally`-Callbacks können keine neueren Requests entfernen. Token-Erneuerung verwendet den übernommenen Pfad. Ein Generationswechsel erzeugt weiterhin ein anderes Dokument. CodeEditor löst seine Session nun ebenfalls vor der Bindung auf und zeigt einen aufgetretenen Resolverfehler mit Wiederholung an.

Awareness gehört ebenfalls dem Dokument: Provider bekommen eine widerrufbare Nutzung mit eigenen Listenern. Dadurch bleiben die Versionszähler für entfernte Cursor monoton, während alte Provider-/View-Callbacks keine neue Präsenz verändern. Der reale Hocuspocus-Provider wurde ohne Netzwerkverbindung erzeugt/geschlossen; wiederholte Wechsel sammeln keine Dokument-Listener. Die Rename-Regression verwendet die produktiven Session-/Registry-Hooks, reale Yjs-/CodeMirror-History und ersetzte Transport-/IndexedDB-Ränder. Sie belegt verzögerte Session-Auflösung, selektives Undo nach Rename, alte HTTP-/Provider-Antworten, neue Token-Pfade, Generationswechsel und Rename vor Hydrationsabschluss. Der Nachweis gilt für einen im aktuellen FileEditor ausgelösten Rename. Die Benachrichtigung anderer bereits geöffneter Clients über einen externen Rename, Server-/Browserabnahme und die offenen Codec-/Recovery-Arbeiten sind damit noch nicht abgeschlossen.

Teilstand 5.17: Eine authentifizierte, nicht gecachte Pfadabfrage löst bestehende Yjs-Dokument-IDs innerhalb des freigegebenen Workspace auf. Sie liest ausschließlich aktive, miteinander übereinstimmende Dokument-/Yjs-Metadaten unter dem Workspace-Mutationslock. Damit werden Zwischenpfade eines laufenden Rename oder Rollbacks nicht als gültiger neuer Speicherort veröffentlicht. Die Abfrage liest keinen Dokumentinhalt und erzeugt keine neue Identität. Der isolierte PostgreSQL-Test belegt Datei-/Ordner-Renames, unveränderten Binärzustand und Sequenz, wiederverwendete alte Dateinamen, Workspace-Abgrenzung, Rollback-Warten und Archivierung. Endpoint-Tests prüfen Berechtigung, Workspace-Scope, Eingaben, Rate-Limit, `no-store` und Fehlerantworten. Die temporäre Datenbank wurde entfernt; scoped ESLint besteht, der Typecheck enthält nur den bekannten DOCX-Bestand. Der Client muss diese Abfrage als Reaktion auf strukturelle Watcher-Ereignisse und Reconnect noch verwenden; die automatische Übernahme externer Renames ist in diesem Teilstand noch nicht integriert.

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
