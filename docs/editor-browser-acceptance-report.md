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

## Mobiles Bewegungsmenü

Ein weiterer Browserbefund betraf den Menüanker: Nach Fokusverlust blendete sich die mobile Werkzeugleiste nach einer Sekunde aus. Das offene Menü verlor damit seinen Anker. Beim nächsten Touch machte die Capture-Phase die Leiste wieder sichtbar; das Menü sprang noch vor dem synthetischen Klick an einen anderen Ort. Der Eintrag wurde deshalb nicht ausgeführt. Die Leiste bleibt jetzt während der tatsächlichen Öffnungsdauer des Bewegungsmenüs sichtbar, einschließlich Aufhebung bei Schließen, Widerruf oder Unmount.

`editor-mobile-block-moves.spec.ts` reproduzierte den versteckten Anker vor der Korrektur und besteht danach (9,5 Sekunden): echte Touch-Eingaben in Chromium, Pause über die Ein-Sekunden-Frist, Bewegung in beide Richtungen, stabile IDs, Undo und bestätigter Checkpoint. Die 26 bestehenden Block-/Container-/History-/Menütests und ESLint bestehen. Die Viewport-Verkleinerung bildet nur den verfügbaren Platz ab, keine native Bildschirmtastatur oder IME.

Die interaktive Mobilprüfung eines Codeblocks zeigte außerdem eine Endlosschleife. Debugger und CPU-Profil führten zu drei wiederkehrenden NodeView-Mutationen: React hängt seine Ansicht ein und versetzt das bestehende `contentDOM` vom temporären Host in `NodeViewContent`. Tiptaps Mobil-Ausnahme für Enter behandelte alle drei internen Umbauten als Eingabe und erzeugte dieselbe Ansicht erneut. `withStableNodeViewMount` erkennt genau die Versetzung dieses Inhalts und das Einhängen seiner React-Hülle. Andere Mutationen einschließlich Texteingaben und Auswahl werden an die ursprüngliche Behandlung weitergegeben.

Der neue Mutationstest prüft diese Grenze einschließlich tatsächlicher Text-, Enter-ähnlicher Wrapper- und Auswahländerungen. Die mobile Browsersuite besteht für Absatz und Code (17,8 Sekunden), jeweils mit Bewegung in beide Richtungen und vollständigem Undo. Beim Code folgen erfolgreich echte Tastaturaktionen für Enter, Texteingabe und Backspace. Im interaktiven Browser bestanden anschließend Bild und Trennlinie das mobile Bewegungsmenü mit exakter Wiederherstellung des gesamten Dokumentbaums. Die Trennlinie bestand außerdem Desktop-Griff und Tastatur. Ein zuvor erfolgreicher Produktionsbuild umfasst die Erststart- und Bildimportkorrektur (`36b0584c`); die nachfolgenden Mobilkorrekturen benötigen noch den abschließenden Build.

## Unterbrochene erste Kollaborationssitzung

Die neue Clipboard-Testkopie hatte bereits eine aktive `collaboration_documents`-Identität, aber noch keinen Yjs-Zustand. Nach einem abgebrochenen ersten Sitzungsaufbau lieferte die Ortsabfrage deshalb 404. Der gespeicherte Tab konnte seine eigene gültige Datei nicht mehr öffnen. Die Ortsabfrage löst jetzt auch aktive, noch nie initialisierte Identitäten auf und kennzeichnet Generation und Repräsentation ausdrücklich mit `null`. Sie initialisiert selbst keine Sitzung. Bereits vorhandene archivierte oder unpassende Zustände werden weiterhin abgewiesen.

Nachweise: echte zuvor blockierte Datei wieder unter derselben ID geöffnet; PostgreSQL-Integration in einer eigens angelegten und anschließend entfernten Testdatenbank; Request-Validierung, Location-Hook, tatsächlicher Dashboard-Lifecycle und Route-Tests. Die neue Browserregression unterbricht den ersten Sitzungsaufruf, lädt den bekannten Tab neu und prüft Eingabe, Checkpoint und erneutes Öffnen unter derselben ID (12,8 Sekunden). TypeScript und ESLint bestehen. Der Produktionsbuild für `b96adebe` besteht; die anschließende Ortskorrektur benötigt noch den abschließenden Build.

## Native Zwischenablage und weitere offene Fälle

Über native Cmd+A/C/V- und Cmd+A/X/V-Tastaturaktionen wurden alle 18 Wurzelblöcke mit 50 Knoten-IDs kopiert bzw. ausgeschnitten. Die ursprünglichen IDs bleiben beim Kopieren bestehen, eingefügte Knoten erhalten frische, eindeutige IDs. Undo stellte in beiden Fällen den vorherigen vollständigen Baum wieder her.

Beim eingefügten Bild ging zunächst die Zentrierung verloren: Die HTML-Zwischenablage normalisiert CSS-Leerzeichen, Semikolons und Nullwerte, während der Import die exakte kanonische Zeichenfolge verglich. Der HTML-Import liest jetzt die normalisierten Rand-Eigenschaften aus dem DOM; der strikte portable Markdown-Parser bleibt unverändert. Die 17 Clipboard-Testgruppen enthalten nun Bilder mit linker, mittlerer und rechter Ausrichtung und vergleichen auch alle kopierten Attribute. Sie und die portable Bildsuite bestehen. Die native Wiederholung behielt 240 px und Zentrierung sowie sämtliche sonstigen Attribute/Inhalte; ein zusätzlicher leerer Eingabeabsatz nach dem Paste bleibt erwartbar. Erneutes Kopieren, bestätigter Checkpoint und Reload ergaben denselben vollständigen Baum mit 101 eindeutigen Knoten-IDs. Das ist eine Chromium-Prüfung der nativen Zwischenablage, kein Nachweis für andere Betriebssysteme.

Ein normaler abgebrochener HTTP-Aufruf beendete zunächst zweimal den lokalen Dev-Server mit `ECONNRESET`. Die später erfolgreiche Reproduktion und Korrektur sind im Abschnitt zu abgebrochenen HTTP-Anfragen dokumentiert.

## Containerwechsel und leere Absätze

Eine frische Fixture bestand die Bewegung desselben Absatzes in Zitat, Aufgabenpunkt, Hinweis, Details-Inhalt und Fußnote: richtige Eltern-ID, unveränderte Absatz-ID und vollständiges Undo. Beim Herausnehmen beider Zitatabsätze wurde der leere Zitatwrapper entfernt; zweimaliges Undo stellte exakt den vorherigen Baum her. Der erste Pflichtabsatz eines Aufgabenpunkts ist absichtlich kein selbständig verschiebbarer Geschwisterblock; ohne passende andere Aufgabenliste wird kein ungültiges Root-Ziel angeboten.

Nach dem Herausbewegen des ersten Details-Absatzes hinter die Fußnote reproduzierte sich `roundtrip_unstable`. Ursache war ein leerer Cursorabsatz, der durch den Move zu einem inneren Absatz wurde: Die eigenen Tokenizer für Fußnote, Hinweis und Details verschluckten dessen reine Leerzeilen beim Markdown-Rückweg. `CanvasDocument` markiert jetzt sämtliche inneren leeren Absätze eindeutig mit dem bereits unterstützten `&nbsp;`-Format. Die Prüflogik wurde nicht gelockert.

Die neue Regression scheiterte vor der Korrektur in drei von zehn Blockkombinationen und besteht danach vollständig, einschließlich binärer Wiederöffnung. Empty-Block-/EOF- und gesamte Markdown-Core-Suite bestehen. Der volle pausierte Zustand wurde im Browser heruntergeladen. Nach kontrolliertem Neustart des eigenen Host-Servers mit dem neuen Codec speicherte derselbe offene Browserzustand über „Retry file saving“ erfolgreich und unverändert. Auch das Herausnehmen des letzten Details-Absatzes, Erhalt von Summary/Container-ID, vollständiges Undo dieses Moves und Reload bestanden. Container-Geometrie und die übrigen konkurrierenden Lifecycle-Folgen bleiben noch offen.

Die übrigen Abnahmegruppen sind bis auf den beschriebenen verspäteten Bildimport noch nicht vollständig geprüft. IME-/Hardware-Touch-Prüfungen und Browser-Latenzmessungen sind ebenfalls offen.

## Geometrie, konkurrierende Nutzer und Agentenreview

Die native Drag-Vorschau blieb bei einer Verbreiterung von 1.200 auf 1.400 px exakt am Quell- und Zielabsatz: beide Markierungen und die Einfügelinie wuchsen von 462 auf 662 px. Screenshot und DOM-Rechtecke stimmen überein. Escape entfernte die Vorschau ohne Dokumentänderung.

Beim Autoscroll setzt Chromium 149.0.7827.55 nach dem nativen Dragabbruch das Scrollen fort. Derselbe Effekt ließ sich in einer isolierten HTML-Seite mit einem nativen Draggable und einem scrollbaren Contenteditable reproduzieren, ohne Canvas-Editorcode oder dessen Autoscroll. Im Editor gab es nach dem Abbruch keine weiteren JavaScript-Schreibzugriffe auf `scrollTop`. Dieser Browserbefund bleibt offen; die produktive Abbruchlogik wurde dafür nicht umgangen.

Zwei verschiedene Nutzer öffneten eine neue neutrale Datei. Während Nutzer A Absatz B am Griff hielt, fügte Nutzer B davor einen neuen Absatz ein. Der tatsächliche `read`-/`edit_file`-Agententreiber erzeugte eine auf die stabile Text-ID bezogene Änderung. Der separate Treiberprozess besitzt keine direkte Verbindung zum laufenden Kollaborationsserver und stellte deshalb einen Review bereit (`requestedMode: direct_apply`, Konflikt `persistence_degraded`). Ein unabhängiger Browserkontext des berechtigten Auftraggebers nahm diesen über die reguläre UI an; der gewöhnliche Workspace-Mitgliedsnutzer hatte korrekt keine Annahmebefugnis. Erst nach sichtbarer Agentenänderung wurde die ursprüngliche Drag-Geste abgeschlossen. Genau eine ursprüngliche B-ID stand anschließend hinter C, mit aktuellem Agententext; alle Nachbarn und die Peer-Einfügung blieben erhalten. Beide Nutzer konvergierten, Undo/Redo und Checkpoint/Reload verglichen den vollständigen Baum exakt. Das belegt Agententool plus Review während eines nativen Drags, keinen direkten Agentenlauf im selben Serverprozess.

Für einen konkurrierenden Move wurde der echte Kollaborations-WebSocket des zweiten Nutzers gezielt geschlossen und sein Wiederaufbau vorübergehend abgefangen. Der Browser zeigte Offline-Bearbeitung; sein lokaler Move erreichte den anderen Nutzer zunächst nicht. Währenddessen verschob der verbundene Nutzer denselben Block an eine andere Position. Nach Wiederverbindung konvergierten beide auf genau eine Platzierung mit unveränderten IDs und Texten; bestätigter Checkpoint und Reload bestanden. `setOffline` allein hatte zuvor den bestehenden WebSocket nicht getrennt und wird ausdrücklich nicht als Offline-Nachweis gezählt.

## Gelöschte Drag-Ziele

Quelllöschung durch den zweiten Nutzer widerrief die native Geste; ein später Drop stellte nichts wieder her. Bei Ziellöschung zeigte die Browserprüfung dagegen eine Verletzung des Plans: Unter dem unveränderten Mauszeiger wurde automatisch der nächste Block zum Ersatzziel, und der Drop führte einen unerwarteten Move aus.

Die Blocksteuerung hält jetzt zusätzlich die Identität des aktuellen Vorschauziels fest. Vor erneuter Geometrieauflösung muss dieses weiterhin gültig sein; andernfalls werden Geste, Autoscroll und Vorschau mit der bestehenden Abbruchmeldung aufgehoben. Die neue Regression in der tatsächlichen MarkdownEditor-Komponente scheiterte vor der Änderung und besteht danach für gelöschte Absätze und Container. Später Drop bleibt wirkungslos, eine ausdrücklich neue Geste funktioniert. Die gesamte lokale Lifecycle-Suite, 26 Blockbefehls-/Menütests und scoped ESLint bestehen. Zwei unterschiedliche Browsernutzer bestätigten anschließend Zielabbruch, unveränderten späten Drop und exakten Checkpoint/Reload. Der abschließende Produktionsbuild steht noch aus.

## URL nach externem Ordnerumbenennen

Zwei bekannte kollaborative Tabs und der Explorer folgten einer über die reguläre API ausgeführten Umbenennung ihres Elternordners unter Erhalt der Dokument- und Block-IDs. Ein wiederverwendeter alter Pfad ersetzte beim Tabwechsel keinen Inhalt. Die Browseradresse blieb jedoch auf diesem alten Pfad stehen: Reload öffnete dadurch die neu dort angelegte andere Datei.

Der Tab-Abgleich aktualisiert jetzt auch einen bestehenden URL-Verweis, wenn seine bekannte Dokument-ID eindeutig an einen bestätigten neuen Pfad umzieht. Workspace-Grenze, andere Query-Parameter und Fragment bleiben erhalten; eine unbekannte, geschlossene oder mehrdeutige Identität erzeugt keine Umleitung. Die Aktualisierung markiert dieselbe Navigationsabsicht als bereits geöffnet, damit der neue URL-Parameter keinen zusätzlichen Tabwechsel auslöst.

Die Regression am tatsächlichen DashboardShell scheiterte vorher am alten URL-Pfad und besteht danach einschließlich der vorhandenen verspäteten Standort-/Dateiantworten, geschlossenen Tabs und wiederverwendeten Pfade. Der ergänzte URL-Test deckt auch inaktive Zielidentitäten, fremde Workspaces und mehrdeutige Zuordnungen ab. Die Browserwiederholung bestätigte die neue Adresse, unveränderte Block-IDs und anschließend den Originalinhalt nach erneuter Belegung des früheren Pfads und Reload. Scoped ESLint besteht; der abschließende Build steht noch aus.

## Abgebrochene HTTP-Anfragen und dauerhafte Browserregressionen

Der Produktionsbuild für `df550d6f` besteht. Die anschließend ergänzte Browsersuite reproduzierte den zuvor sporadischen Serverabsturz. Die private Diagnose erfasste unmittelbar davor eine abgebrochene `/api/files/collaboration/session`-Anfrage ohne verbleibenden `error`-Listener. Node stellt diesen Streamfehler asynchron zu. Ein minimierter echter TCP-Test zeigt die relevante Lücke: Entfernt ein Framework seinen Listener zwischen Einreihen und Zustellen, endet der ungeschützte Prozess mit `ECONNRESET`.

Der eigene HTTP-Server registriert deshalb sofort einen Listener für die gesamte Lebensdauer jeder Anfrage. Bekannte Verbindungsabbrüche schließen nur die betroffene Antwort; unerwartete Streamfehler bleiben protokolliert und erreichen weiterhin die Framework-Listener. Der globale Umgang mit Programmfehlern bleibt unverändert. Die TCP-Gegenprobe stürzt ohne Schutz ab und beantwortet mit Schutz auf demselben Server die nächste Health-Anfrage. Syntaxprüfung und scoped ESLint bestehen.

`editor-structure-lifecycle.spec.ts` hält die neuen Browserregressionen dauerhaft fest: Peer-Löschung der Drag-Quelle, Peer-Löschung des Vorschauziels sowie Ordnerumbenennung mit neu belegtem altem Pfad und anschließendem Reload. Alle drei bestehen gegen den aktuellen Host-Server (1,2 Minuten). Diese automatisierte Suite verwendet unabhängige Kontexte derselben Admin-Identität; die vorher beschriebene interaktive Prüfung verwendete zwei unterschiedliche Nutzer. Der Build wird nach der HTTP-Korrektur abschließend erneuert.

## Tatsächlicher Dateischreibfehler

Nur die eigene neutrale Testdatei und ihr eigener Testordner bekamen vorübergehend keine Schreibrechte. Eine normale Tastatureingabe erzeugte daraufhin einen echten `EACCES` beim Dateicheckpoint. Die UI meldete „File saving paused“, der ursprüngliche Dateiinhalt blieb unverändert und die neue Eingabe blieb im Editor erhalten. Über die normale Downloadaktion wurde der vollständige Binärzustand gesichert. Sein unabhängig gelesener Blockbaum enthält exakt sämtliche JSON-Felder und IDs des sichtbaren Zustands; JSON-Prototypen der ProseMirror-Attribute sind dabei keine Dokumentdaten.

Die Rechte wurden in einem `finally`-Block vollständig wiederhergestellt. „Retry file saving“, bestätigter Checkpoint und Reload behielten anschließend denselben vollständigen Dokumentbaum. Das ist ein tatsächlicher Dateisystemfehler, kein simulierter API-Fehler und kein Nachweis eines PostgreSQL-Ausfalls. Während des letzten Serverlaufs erfasste die private Diagnose 82 reguläre Verbindungsabbrüche und keinen unbehandelten Fehler.

## Abschluss dieses Durchlaufs und verbleibende Abnahme

Die eigenen Testdateien und -ordner einschließlich fehlgeschlagener Testläufe wurden über die reguläre Lösch-API ohne Fehler in den Papierkorb verschoben. Die QA-Browser und der eigene Host-Dev-Server wurden geschlossen; der verwaltete Containerstack bleibt unverändert. Private Screenshots, vollständige Recovery-Dateien und strukturierte Zustandsvergleiche bleiben im genannten lokalen Artefaktordner erhalten.

Eine Gesamtfreigabe bleibt offen. Priorisierte Restfälle sind direkte Agentenausführung im laufenden Serverprozess, konfliktbehaftete Containerzyklen mit Browser-Recovery, eindeutige Agentenziele nach Split/Join, die vollständigen Rechte-/Workspace-Widerrufsfolgen, alte Offline-Repliken über einen Generationswechsel sowie Browserprozess-Neustart mit erhaltenem IndexedDB-Profil. Hinzu kommen tatsächliche Datenbankfehler, vertauschte Checkpointantworten, große Dokumente und Betriebssystem-IME beziehungsweise Hardware-Touch. Der isoliert reproduzierte Chromium-Autoscrollbefund bleibt ebenfalls offen. Diese Punkte werden durch die bestandenen Kern-/Komponententests und Teilprüfungen nicht als erledigt gewertet.

Der abschließende vollständige `npm run build` auf Produktstand `44f15e11` besteht einschließlich TypeScript und Seitengenerierung. Der Build verwendet ein isoliertes DATA-Verzeichnis. Alle vier bestehenden verwalteten Container sind weiterhin gesund; es wurde kein Container gebaut oder ausgetauscht. Die zehn Produktkorrekturen liegen in einzelnen nachvollziehbaren Commits; eine Veröffentlichung wurde nicht ausgeführt.
