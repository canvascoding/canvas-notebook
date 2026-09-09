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

Die interaktive Mobilprüfung eines Codeblocks mit anschließendem Undo zeigte außerdem einen hängenden Renderer. Dieser Folgefehler wird separat eingegrenzt; Bild-/Trennlinien-Moves über das mobile Menü sind damit noch nicht freigegeben. Ein zuvor erfolgreich ausgeführter Produktionsbuild umfasst die Erststart- und Bildimportkorrektur (`36b0584c`), noch nicht die anschließende mobile Menüänderung.

Gruppe 1 ist teilweise geprüft; Trennlinie, Mobilmenü und vollständige Copy-/Paste-Folgen stehen noch aus. Die übrigen Abnahmegruppen sind bis auf den beschriebenen verspäteten Bildimport noch nicht vollständig geprüft. Clipboard-/IME-/Touch-Prüfungen und Browser-Latenzmessungen sind ebenfalls offen.
