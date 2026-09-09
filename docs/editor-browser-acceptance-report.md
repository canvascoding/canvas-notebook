# Browserabnahme: Blockbearbeitung und Lifecycle

Begonnen am 9. September 2026 nach Browserfreigabe. Ausgangsstand `1a3ed752`, Chromium `149.0.7827.55`, Desktop 1600 × 900. Der aktuelle Worktree läuft als Host-Dev-Server auf Port 3000 am verwalteten lokalen PostgreSQL-Stack. Zwei verschiedene Nutzer sind angemeldet und haben Schreibrechte im `Shared Test Workspace`. Kein Container wurde gebaut.

Der [Abnahmeablauf](editor-browser-acceptance-runbook.md) bleibt die vollständige Prüfliste. Dieser Bericht dokumentiert ausgeführte Fälle und ist noch keine Gesamtfreigabe.

## Erststart einer neuen Datei

**Gefunden:** Eine neue leere Markdown-Datei zeigte eine bestätigte Verbindung und einen aktuellen Checkpoint, aber zugleich „This live state cannot currently be rendered“. Der Browserzustand enthielt sowohl `body` als auch `canvas-block-tree-v1`; die heruntergeladene Binärsicherung enthielt nur den gültigen Blockbaum.

**Ursache und Korrektur:** Die Live-Vorschau las nach dem ersten, leeren IndexedDB-Ladevorgang den noch nicht eingetroffenen Blockbaum als altes XML. Dadurch legte sie selbst einen konkurrierenden `body`-Root an. Sie wartet jetzt bei einer angekündigten Block-Repräsentation auf deren tatsächlichen Root. Der Update-Listener bleibt aktiv und veröffentlicht die erste Serverprojektion ohne einen Ansichtswechsel.

**Nachgewiesen:** Der ergänzte Regressionstest scheiterte vor der Korrektur mit drei unerwarteten Roots statt null und besteht danach. Live-Markdown-, Startup-Recovery- und Structure-Recovery-Suites sowie ESLint bestehen. Im Browser wurde anschließend eine weitere neue Datei angelegt, normal per Tastatur bearbeitet, bis zum bestätigten Checkpoint gewartet und neu geladen. Der eingegebene Text war wieder sichtbar und editierbar; es gab keine Browser-Exceptions.

Private Laufartefakte liegen unter `~/.codex/tmp/editor-fbd6-browser-20260909/`: QA-Inventar, Vorher-/Nachher-Screenshots, Binärsicherung und ein JSON-Nachweis mit Dokument-/Block-ID. Zugangsdaten und Transporttickets werden nicht in den Bericht übernommen.

## Bildimport im gemeinsamen Workspace

**Gefunden:** Der normale Uploaddialog legte einen Bildblock mit relativem Pfad an, dessen Vorschau nicht laden konnte. Die Datei war über den alten Standard-Workspace erreichbar (HTTP 200), im aktiven gemeinsamen Workspace fehlte sie (HTTP 404). Der Importrequest enthielt keinen Workspace-Header.

**Korrektur und Nachweis:** Der Dialog übergibt jetzt den Workspace des laufenden Aufrufs. Ein erneuter Upload war im gemeinsamen Workspace erreichbar und im Standard-Workspace nicht vorhanden. Die erweiterte `editor-image-controls.spec.ts` verwendet den echten Uploaddialog und besteht vollständig: laden, Größe/Ausrichtung ändern, Resize, Undo/Redo, Checkpoint, Reload, Resize-Abbruch und Read-Ansicht einschließlich kleiner Bildschirmbreite. Laufzeit: 17,7 Sekunden. ESLint und `editor-interaction-lifecycle-test.tsx` bestehen.

Zusätzlich wurde im interaktiven Browser eine echte Serverantwort des Imports zurückgehalten, der Dialog abgebrochen und zu einer anderen Datei gewechselt. Nach Freigabe der Antwort blieben beide strukturierten Dokumentzustände unverändert. Die bereits serverseitig hochgeladene Testdatei wird separat bereinigt.

## Bisherige Blockbedienung

Absatz B wurde mit nativer Mausgeste am Griff hinter C verschoben. Quellmarkierung und Einfügelinie wurden während des Drags visuell geprüft. Die ursprünglichen IDs, Inhalte und Nachbarn blieben erhalten. Undo/Redo, Read/Source/Edit sowie Checkpoint und Reload bestätigten das Ergebnis. Das Bewegungsmenü und `Alt+Shift+↑/↓` wurden ebenfalls mit Undo geprüft.

Der Codeblock wurde per Tastatur vor die Tabelle und per Griff hinter den Callout bewegt. Undo stellte jeweils den vollständigen vorherigen Dokumentbaum einschließlich IDs und Codewortlaut wieder her. Ein regulär importierter Bildblock bestand Bewegung per Tastatur und Griff mit derselben ID und exakter Wiederherstellung per Undo; Breite 240 px und Zentrierung wurden visuell geprüft.

**Testmaterial:** Die ursprüngliche Fixture ist als Quelltext nicht kanonisch und bleibt beim regulären Import mit `roundtrip_changed` im Source-Modus. Die vorher dokumentierte strikte Blockprüfung hatte diesen Eintrittspfad nicht geprüft. Der Browserlauf verwendet deshalb ihre vom produktiven Codec serialisierte Fassung. Unterschiede sind Tabellenstriche, Leerzeilen und die Schreibweise des Callout-Typs; Inhalte und strukturierte Blöcke bleiben erhalten. Die Importschutzprüfung wurde nicht geändert.

## Noch auszuführen

### Mobiles Bewegungsmenü

Ein weiterer Browserbefund betraf den Menüanker: Nach Fokusverlust blendete sich die mobile Werkzeugleiste nach einer Sekunde aus. Das offene Menü verlor damit seinen Anker. Beim nächsten Touch machte die Capture-Phase die Leiste wieder sichtbar; das Menü sprang noch vor dem synthetischen Klick an einen anderen Ort. Der Eintrag wurde deshalb nicht ausgeführt. Die Leiste bleibt jetzt während der tatsächlichen Öffnungsdauer des Bewegungsmenüs sichtbar, einschließlich Aufhebung bei Schließen, Widerruf oder Unmount.

`editor-mobile-block-moves.spec.ts` reproduzierte den versteckten Anker vor der Korrektur und besteht danach (9,5 Sekunden): echte Touch-Eingaben in Chromium, Pause über die Ein-Sekunden-Frist, Bewegung in beide Richtungen, stabile IDs, Undo und bestätigter Checkpoint. Die 26 bestehenden Block-/Container-/History-/Menütests und ESLint bestehen. Die Viewport-Verkleinerung bildet nur den verfügbaren Platz ab, keine native Bildschirmtastatur oder IME.

Die interaktive Mobilprüfung eines Codeblocks zeigte außerdem eine Endlosschleife. Debugger und CPU-Profil führten zu drei wiederkehrenden NodeView-Mutationen: React hängt seine Ansicht ein und versetzt das bestehende `contentDOM` vom temporären Host in `NodeViewContent`. Tiptaps Mobil-Ausnahme für Enter behandelte alle drei internen Umbauten als Eingabe und erzeugte dieselbe Ansicht erneut. `withStableNodeViewMount` erkennt genau die Versetzung dieses Inhalts und das Einhängen seiner React-Hülle. Andere Mutationen einschließlich Texteingaben und Auswahl werden an die ursprüngliche Behandlung weitergegeben.

Der neue Mutationstest prüft diese Grenze einschließlich tatsächlicher Text-, Enter-ähnlicher Wrapper- und Auswahländerungen. Die mobile Browsersuite besteht für Absatz und Code (17,8 Sekunden), jeweils mit Bewegung in beide Richtungen und vollständigem Undo. Beim Code folgen erfolgreich echte Tastaturaktionen für Enter, Texteingabe und Backspace. Im interaktiven Browser bestanden anschließend Bild und Trennlinie das mobile Bewegungsmenü mit exakter Wiederherstellung des gesamten Dokumentbaums. Die Trennlinie bestand außerdem Desktop-Griff und Tastatur. Ein zuvor erfolgreicher Produktionsbuild umfasst die Erststart- und Bildimportkorrektur (`36b0584c`); die nachfolgenden Mobilkorrekturen benötigen noch den abschließenden Build.

## Unterbrochene erste Kollaborationssitzung

Die neue Clipboard-Testkopie hatte bereits eine aktive `collaboration_documents`-Identität, aber noch keinen Yjs-Zustand. Nach einem abgebrochenen ersten Sitzungsaufbau lieferte die Ortsabfrage deshalb 404. Der gespeicherte Tab konnte seine eigene gültige Datei nicht mehr öffnen. Die Ortsabfrage löst jetzt auch aktive, noch nie initialisierte Identitäten auf und kennzeichnet Generation und Repräsentation ausdrücklich mit `null`. Sie initialisiert selbst keine Sitzung. Bereits vorhandene archivierte oder unpassende Zustände werden weiterhin abgewiesen.

Nachweise: echte zuvor blockierte Datei wieder unter derselben ID geöffnet; PostgreSQL-Integration in einer eigens angelegten und anschließend entfernten Testdatenbank; Request-Validierung, Location-Hook, tatsächlicher Dashboard-Lifecycle und Route-Tests. Die neue Browserregression unterbricht den ersten Sitzungsaufruf, lädt den bekannten Tab neu und prüft Eingabe, Checkpoint und erneutes Öffnen unter derselben ID (12,8 Sekunden). TypeScript und ESLint bestehen. Der Produktionsbuild für `b96adebe` besteht; die anschließende Ortskorrektur benötigt noch den abschließenden Build.

## Native Zwischenablage und weitere offene Fälle

Über native Cmd+A/C/V- und Cmd+A/X/V-Tastaturaktionen wurden alle 18 Wurzelblöcke mit 50 Knoten-IDs kopiert bzw. ausgeschnitten. Die ursprünglichen IDs bleiben beim Kopieren bestehen, eingefügte Knoten erhalten frische, eindeutige IDs. Undo stellte in beiden Fällen den vorherigen vollständigen Baum wieder her. Der Inhalt blieb erhalten, beim eingefügten Bild ging jedoch die Zentrierung verloren. Diese Formatregression wird als nächstes korrigiert; die Clipboard-Abnahme ist noch offen.

Ein normaler abgebrochener HTTP-Aufruf beendete zweimal den lokalen Dev-Server mit `ECONNRESET`. Eine vorübergehende private Diagnose erfasst den Ursprung; reguläre Abbrüche mit vorhandenen Fehlerhandlern sind bereits sichtbar, der fatale Fall ist damit noch nicht erklärt oder behoben.

Die übrigen Abnahmegruppen sind bis auf den beschriebenen verspäteten Bildimport noch nicht vollständig geprüft. IME-/Hardware-Touch-Prüfungen und Browser-Latenzmessungen sind ebenfalls offen.
