# Browserabnahme für Blockbearbeitung und Dokument-Lifecycle

Stand: 9. September 2026, Ausgangsproduktstand `b40f9a08`. Ergänzung zur [Abnahmematrix](editor-lifecycle-acceptance.md). Die Ausführung hat nach Browserfreigabe begonnen; konkrete Ergebnisse stehen im [Browserbericht](editor-browser-acceptance-report.md). Dieser Ablauf ist keine Gesamtfreigabe.

## Umgebung und Nachweise

Die Ausführung beginnt nach der expliziten Browserfreigabe gemäß `AGENTS.md`, Zeile 29. Für die lokale Umgebung gilt `canvas-local-team-seat-dev`: vorgesehener Worktree, verwalteter Stack, PostgreSQL, zwei tatsächliche schreibberechtigte Testnutzer und `Shared Test Workspace`. Den Zustand des Stacks beim Start prüfen; seine aktuelle Verfügbarkeit wird hier nicht behauptet. Ein erforderlicher Containerneubau braucht eine eigene ausdrückliche Beauftragung und vorher einen erfolgreichen `npm run build`. Keine alte Anwendung als Nachweis für den aktuellen Commit verwenden.

Logins kommen aus der privaten lokalen Konfiguration. Zugangsdaten, Tickets und vollständige Netzwerkheader gehören nicht in Berichte oder eingecheckte Traces. Die verwalteten Testnutzer und Lizenzfixtures verwenden den vorgesehenen Control-Plane-Ablauf. Testdateien bekommen einen eindeutigen Laufpräfix; nur die eigenen Testdateien werden anschließend entfernt.

Je Fall festhalten: Commit, Browser/Version, Nutzer A/B, Dokument-ID, Generation, Representation, Aktion, sichtbares Ergebnis und gespeichertes Ergebnis. Vor und nach Strukturänderungen die ID-zu-Inhalt-/Eltern-/Reihenfolge-Zuordnung vergleichen. Im DOM entspricht das vorhandene UniqueID-Attribut `data-id`; für nicht direkt sichtbare Unterblöcke zusätzlich den aktuellen Dokumentzustand lesen. Lesende Diagnose darf keine Inhaltsmutation ersetzen.

Eine Bildschirmaufnahme allein belegt weder korrekte IDs noch Dauerhaftigkeit. Nach Änderungen den bestätigten Checkpoint und ein erneutes Öffnen prüfen. Bei ausdrücklich gesperrten Strukturkonflikten stattdessen vollständige Recovery, unveränderte betroffene Inhalte und das Fehlen einer unberechtigten Gespeichert-Anzeige belegen.

## Vorhandene automatische Grundlagen und ihre Grenzen

| Datei | Vorbereiteter Umfang laut aktuellem Quelltext | Noch fehlender Nachweis |
| --- | --- | --- |
| `tests/file-live-collaboration.spec.ts` | Zwei unabhängige Browserkontexte, Carets/Präsenz, Seitenneuladen, Dateicheckpoint sowie ein separater Agentenreview-Ablauf. | Die Kontexte verwenden dieselbe Admin-Identität. Das ersetzt keine Prüfung zweier Nutzer/Rollen. Der Reconnect-Teil lädt die Seite neu; er unterbricht nicht tatsächlich den Transport. Es gibt keinen gemeinsamen nativen Drag-/Agentenfall. |
| `tests/collaboration-recovery.spec.ts` | Browserfixture mit realem IndexedDB und Transition-/Recovery-UI; API-Antworten werden ersetzt. | Die Fixture verwendet `plain_text`, keinen kollidierten Blockbaum. Ein echter Server-/Dateisystemfehler und Neustart eines erhaltenen Browserprofils sind damit nicht belegt. |
| `tests/file-collaboration-restart.spec.ts` | Getrennte `prepare`-/`verify`-Phasen mit gespeichertem Dateipfad und erwartetem Text. | Der Prozessneustart muss außerhalb des Tests tatsächlich stattfinden. Die Prüfung öffnet einen neuen Browserkontext und belegt keine Offline-Recovery des ursprünglichen Profils. |
| `tests/markdown-rich-blocks.spec.ts` | Einfügen, Darstellung, Toggle und Serialisierung von Rich-Blöcken. | Paralleles Verschieben, widerrufene Gesten und echte Touch-/IME-Folgen. |
| `tests/editor-table-menu.spec.ts`, `tests/editor-image-controls.spec.ts`, `tests/editor-url-paste.spec.ts` | Bestehende Menü-, Bild- und Paste-Regressionsfälle. | Die vollständige neue Block-/Container-/Lifecycle-Matrix. |

Diese Tests wurden in diesem Audit gelesen, nicht gestartet. Für den späteren Lauf verlangt der Team-E2E-Bestand `COLLABORATION_E2E=1`; beim verwalteten externen Server muss `E2E_EXTERNAL_SERVER=1` gesetzt sein, damit Playwright keinen zusätzlichen Server startet. Die ursprüngliche Konfiguration lädt lokale Umgebungswerte; Basis-URL, DATA und Workspace müssen daher vor dem Lauf zum verwalteten Teststand passen. Den bestehenden Restart-Test nur in seiner passenden Phase ausführen. Ein übersprungener Test ist kein Nachweis.

## Neutrales Testdokument

[editor-block-lifecycle.md](../tests/fixtures/editor-block-lifecycle.md) enthält eindeutig benannte Absätze A/B/C, zwei gleiche Textabsätze, Zitat, verschachtelte Aufgabenliste, Tabelle, Code, Callout, Details und Fußnote. Pro unabhängiger Folge eine neue Kopie verwenden. Dokument- und Block-IDs entstehen beim Import und werden danach erfasst; sie werden nicht im Testtext erfunden.

Die Fixture wurde ohne Browser über die produktiven Markdown-/Block-Codecs geprüft: strikter Checkpoint gültig, 48 eindeutige Knoten-IDs, zwei weiterhin getrennte gleiche Textabsätze, keine Binäränderung durch die Validierung und identischer strukturierter Zustand nach binärem Wiederöffnen. Dieser Nachweis prüft das Testmaterial, nicht die nachfolgenden Browseraktionen.

Ein zusätzliches Bild über den normalen Bildimport einfügen. So wird zugleich geprüft, dass eine verspätete Importantwort nach Datei-/Ansichtswechsel keinen anderen Block verändert. Für Layoutfälle das Bild zunächst laden lassen und später Größe/Ausrichtung ändern.

## Reihenfolge der Abnahme

Jede Gruppe wird abgeschlossen, bevor die nächste beginnt. Fehlschläge mit minimaler Aktionsfolge und Artefakten festhalten; einen beobachteten Integritätsfehler zuerst beheben und seinen Fall wiederholen.

| Gruppe | Konkrete Folge | Erforderliches Ergebnis | Matrix |
| --- | --- | --- | --- |
| 1. Lokale Bedienung | Absatz, Code, Bild und Trennlinie jeweils mit Griff, Tastatur und Mobilmenü bewegen. Danach Undo/Redo, Read/Rich/Source und Wiederöffnen. | Aktueller Inhalt, IDs, Auswahl und Formatierung bleiben zugeordnet; eine Move-Aktion bleibt eine Undo-Einheit. Kopieren und Duplizieren erzeugen neue IDs, Ausschneiden/Paste folgt dem dokumentierten Vertrag. | 6, 7, 9 |
| 2. Container und Geometrie | Absatz zwischen Root, Zitat, Task-Item, Callout und Details per Containermenü bewegen; auch das letzte Kind herausnehmen. Während eines Drags scrollen, Bildmaße ändern, Details schließen, Editorbreite/Zoom ändern. | Erforderliche Titel-/Summary-Slots bleiben erhalten. Quelle und Einfügemarkierung folgen dem sichtbaren Block. Kein Drop in eigene Nachfahren; Scroll endet bei Abbruch und Unmount. | 5, 6, 9 |
| 3. Mensch plus Agent | Nutzer A beginnt Absatz B zu ziehen. Nutzer B fügt vor der Quelle einen Absatz ein. Ein tatsächliches Agententool liest das Dokument und ändert den Text im ursprünglichen Absatz B. Erst nach sichtbarer Zustellung lässt Nutzer A los. Mit Undo/Redo und Checkpoint wiederholen. | Genau ein ursprünglicher Absatz B am beabsichtigten Ort mit aktuellem Peer-/Agententext. Nachbarn unverändert, keine neue ID für den Move, kein fremder Textverlust bei Undo. | 1, 2, 7, 8 |
| 4. Konkurrierende Struktur | Zwei Nutzer beginnen Moves desselben Blocks bzw. gegenläufige Container-Moves vor der jeweiligen Zustellung. Getrennt Quelle, Ziel und Elterncontainer während eines Drags löschen. Die Zustellreihenfolge kontrolliert variieren. | Eine deterministische Platzierung oder sichtbarer Strukturkonflikt; keine Duplikate, Zyklen oder unbemerkte Wiederauferstehung. Konflikt-Recovery erhält alle betroffenen Inhalte. | 3, 4, 5 |
| 5. Eindeutige Agentenziele | Die beiden gleichen Textabsätze getrennt adressieren. Einen davon bewegen, kopieren, teilen und zusammenführen; vorbereiteten Agentenpatch danach prüfen/anwenden oder zurücknehmen. | Gleicher Text allein reicht nicht als Ziel. Move erhält das Ziel; Kopie ist unabhängig. Mehrdeutiger Split/Join fordert Review und bearbeitet keinen Ersatzblock. | 8 |
| 6. Widerruf | Drag bzw. Link-/Bild-/Rich-Block-Dialog öffnen. Dann Rechte entziehen und wiedergeben, Datei/Workspace A→B→A wechseln, Ansicht schließen oder neu öffnen. Alte Bestätigung/Importantwort bzw. verspäteten Drop zustellen. | Kein alter Schreibauftrag wirkt in einer neuen Lebensdauer. Entwurf, Meldung und Auswahl sind verständlich; neue Interaktionen funktionieren anschließend. | 9 |
| 7. Tab- und Pfad-Lifecycle | Zwei bekannte kollaborative Tabs offen halten. Anderer Nutzer verschiebt ihren Elternordner. Während Standort- bzw. Dateiantworten verzögert sind, inaktiven Tab schließen oder einen anderen wählen; alten Pfad mit anderer Datei belegen. | Aktiver Editor behält seine Identität; beide Tabs und Explorer folgen dem bestätigten neuen Ort. Späte Antworten öffnen keinen geschlossenen Tab und laden keinen fremden Inhalt am wiederverwendeten Pfad. | 10 |
| 8. Offline und Generation | Transport eines Clients wirklich unterbrechen, lokal ändern und erneut verbinden. Separat alte Offline-Replik behalten, autorisierten Format-/Generationswechsel durchführen und erst danach den alten Client verbinden. | Zusammenführung derselben Generation erhält die Änderungen. Alte Generation wird gesichert und abgewiesen; sie schreibt nicht in den neuen Zustand. | 10 |
| 9. Speicherbeweis | Checkpointantworten verzögern und vertauschen; zwischen Antworten weiter tippen bzw. nur löschen. Danach echte kontrollierte Persistenz- und Dateischreibfehler im Teststand auslösen. | „Gespeichert“ gehört ausschließlich zum exakt bestätigten Zustand einschließlich Löschmengen. Fehler erhalten eine vollständige Sicherung und nachvollziehbare Recovery. | 11, 12 |
| 10. Neustart und Wiederherstellung | Mit ausstehender lokaler Änderung denselben Browserprofilzustand erhalten, Browserprozess beenden und neu starten. Separat die Anwendung vollständig neu starten. Block-Recovery herunterladen, erneut lesen/importieren und den Zustand vergleichen. | IDs, Text, gelöschte Inhalte und relevante Metadaten bleiben vollständig zugeordnet. Keine behauptete Persistenz einer nur im Speicher gehaltenen Undo-History. | 10, 12 |

Native Systemzwischenablage und Betriebssystem-IME separat prüfen: komponierte Eingabe, Emoji und kombinierende Zeichen während Peer-Text/Move sowie beim Ansichtswechsel. Synthetische `compositionstart`-/`compositionend`-Ereignisse ersetzen diesen Nachweis nicht. Touch-Emulation und tatsächliche Touch-Bedienung getrennt kennzeichnen.

Die Größenmessung ergänzt dieselben Flows mit 100/1.000/5.000 Absätzen und tief verschachtelten Containern. Dauer vom Pointer-Up bis zur sichtbaren, stabilen Platzierung sowie Eingabelatenz und Layoutsprünge im Browser erfassen. Die vorhandenen JSDOM-Werte sind Vergleichsdaten, keine native Latenzzusage.

## Entscheidung nach dem Lauf

Jeden Matrixeintrag als bestanden, fehlgeschlagen oder ungetestet mit passendem Nachweis markieren. Ausgelassene Rollen, Betriebssystemeingaben, Fehlerarten und Neustartvarianten bleiben ausdrücklich offen. Browsertraces und State-Diffs müssen zur getesteten Commitfassung gehören. Die Gesamtfreigabe erfolgt erst nach erfolgreicher vollständiger Abnahme; ein grüner Teiltest oder ein sichtbares Dokument genügt nicht.

Die Operationshistorie des Blockformats bleibt derzeit vollständig erhalten. Ein normaler Checkpoint verdichtet sie nicht; Undo nimmt Ausführungsbelege nicht zurück. Die gemessenen etwa 3,2 MiB nach 10.000 Moves sind kein Langzeitlimit. Automatische Verdichtung bleibt offen und benötigt eine eigene Generation-/Offline-/Undo-/Idempotenzabnahme; dieser Browserlauf soll insbesondere die dafür erforderlichen Übergänge belegen.
