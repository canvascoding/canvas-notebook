# Zusammenführung von Block-Lifecycle und aktuellem main

Ausgangsstand: `87ebabf2` auf `codex/editor-structure-lifecycle-plan`, zusammengeführt mit `origin/main` auf `f44473f8` (9. September 2026). Anschließend wurde `main` bis `6ad3a2af` (E-Mail-Suche) übernommen; `test:email:context-intent` und `test:email:inbox-flow` bestehen. Die zwölf Textkonflikte betreffen Dashboard, drei Editoren, Kollaborationsclient, Dateiwatcher, Dateistore, HTTP-Server, Paketmanifest und drei Lizenzartefakte.

## Konfliktauflösung

- Der zentrale Dokumentbesitz aus `main` bleibt erhalten. Editoransichten verwenden den bestätigten Dokumenttyp, stabile Dokumentidentitäten und abbrechbare Session-Anfragen des Block-Lifecycle-Branches.
- Der Tab-Abgleich erhält bekannte Dokument-IDs und korrigiert Deep Links nach bestätigten Umbenennungen. Der Dateistore verwendet die umfassende Pfadmutation aus `main` auch bei der Auflösung einer kollaborativen Dokumentidentität.
- Der Dateiwatcher behält die strengere Prüfung von Verbindungsgeneration und Workspace. Rechteentzug beendet die Verbindung; verspätete Transportereignisse heben ihn nicht auf.
- Der gemeinsame Client verbindet Gast- und Nutzeridentität mit dem bestehenden Dokument-Lifecycle. Session-Erneuerung und Checkpoint verwenden für Gäste ausschließlich deren dateigebundene Endpunkte und erhalten Abbruchsignale und vollständige Zustandsnachweise.
- Der HTTP-Server verbindet den Listener für die gesamte Request-Lebensdauer mit den neuen Request- und HTML-Preview-Grenzen aus `main`.
- Die Dokumentauflösung verwendet native PostgreSQL-Parameter. Der Agenten-Pfadtest isoliert nach der PostgreSQL-Umstellung auch die nun über den gemeinsamen Pool angesprochenen Tabellen.
- Der feste Yjs-Patch bleibt erhalten. Lizenzcache und Hinweise wurden aus dem zusammengeführten Lockfile neu erzeugt.

## Gästekollaboration

Gastfreigaben können bestehende Blockdokumente öffnen; neue geeignete Rich-Text-Dokumente verwenden ebenfalls das Blockformat. Session und Checkpoint liefern Formatversion und Zustandsnachweis einschließlich Löschungen. Ein veralteter Nachweis wird auch dann abgelehnt, wenn sich der Yjs-State-Vector nicht geändert hat.

Die Gastansicht verwendet denselben repräsentationsabhängigen Editoradapter wie der reguläre Editor. Das bisherige XML-Format und Klartext bleiben unterstützt. Bild-URLs werden weiterhin nur für die Anzeige umgeschrieben und bleiben auf freigegebene Assets beschränkt. Die Versionswiederherstellung aktualisiert Blockdokumente über den Rich-Text-Adapter.

Gastupdates werden weiterhin auf einer isolierten Kopie geprüft. Beim Blockformat sind ausschließlich dessen Root und Markdown-Metadaten zulässig; ein zusätzliches `body`, `content` oder ein fremder Root wird abgelehnt. Größenlimits und dateigebundene Rechte bleiben bestehen.

## Nachweise

- Neuer Regressionstest: Gaständerung und Blockverschiebung wurden vor der Korrektur abgelehnt; danach bestehen sie bei bytegenau unverändertem Live-Zustand während der Prüfung. Fremde Roots und Formatvermischung bleiben abgewiesen.
- `test:file-guests`: echte Hocuspocus-Verbindungen über Loopback mit isolierter PGlite-Datenbank für Klartext, XML und Blockbaum. Gleichzeitige Eingaben, Offline-Reconnect, Checkpoint-Nachweise, reine Löschungen, Versionswiederherstellung, Leserechte, Widerruf und ungültige Updates bestehen.
- Dateiwatcher, Pfadmutationen, Notebook-Races, Standortübernahme, kollaboratives Umbenennen, Durability, Zugriffswiderruf, lokaler Editor-Lifecycle, Tabs, Öffnen bekannter IDs, Editorinteraktionen und HTTP-Request-Lifecycle bestehen. Die tatsächliche Dashboard-Komponente besteht außerdem `test:notebook:location-lifecycle`.
- PostgreSQL-SQL-Kompatibilität und Lizenzprüfung bestehen. Scoped ESLint prüft die aufgelösten und angepassten Dateien.
- Der abschließende vollständige Produktionsbuild einschließlich TypeScript und 336 Seiten besteht. Der anschließende Test am tatsächlich gebauten Checkpoint-Modul bestätigt weiterhin die gemeinsame Yjs-Modulidentität und beide Rich-Text-Adapter.
- Vier dauerhafte Browserregressionen bestehen gegen den zusammengeführten Host-Server: unterbrochene erste Session, gelöschte Drag-Quelle, gelöschtes Drag-Ziel und Ordnerumbenennung mit Wiederverwendung des alten Pfads (51,6 Sekunden).
- Interaktive Browserprüfung mit Eigentümer, Schreibgast und Lesegast: Native Blockverschiebung während einer Gasttexteingabe konvergiert mit identischen IDs. Undo/Redo des Eigentümers erhält den Gasttext. Gastformatierung, Undo/Redo, Read/Edit/Source-Wechsel sowie Checkpoint und Reload erhalten den vollständigen Dokumentbaum.
- Der Lesegast hat kein editierbares Feld. Nach Widerruf wird der Schreibgast gesperrt; der Dateiendpunkt verweigert den Zugriff und die lokale Markdown-Kopie bleibt herunterladbar. Der Eigentümerzustand bleibt unverändert.
- Desktop und 390-Pixel-Ansicht wurden visuell geprüft; kein horizontales Überlaufen und keine Browser-Exceptions. Die Browsergäste wurden über reguläre Challenge-/Verify-Servicefunktionen mit abgefangenem E-Mail-Versand vorbereitet. E-Mail-Zustellung ist kein Gegenstand dieses Nachweises.

Private Browserbilder, Zustandsvergleiche und Logs liegen unter `~/.codex/tmp/editor-fbd6-browser-20260909/merge-*`. Die eigenen Gastfreigaben wurden widerrufen und die Testdatei über die reguläre API gelöscht. Browser und Host-Dev-Server wurden beendet; der verwaltete Containerstack wurde weder gebaut noch ersetzt.

Dieser Nachweis betrifft die Zusammenführung und die Gastkompatibilität. Er ersetzt nicht die übrigen, separat dokumentierten Punkte der vollständigen Editor-Abnahmematrix. Es wurde nichts nach `main` gepusht und kein PR gemergt.

## Gemeinsame Bedienelemente für Gäste und Accounts

Die bisherige Gastansicht hatte einen eigenen Rich-Text-Editor mit sechs Textbuttons. Sie verwendet jetzt die tatsächliche `RichMarkdownEditor`-Komponente des Account-Zugangs, außerdem die gemeinsame `MarkdownModeBar`. Dadurch werden Desktop-/Mobilwerkzeugleiste, Blockgriffe und Verschiebemenü, Formatierung, Listen, Tabellen, Linkdialoge, Bildausrichtung/-größe, Suche, Gliederung sowie Undo/Redo gemeinsam gepflegt.

`MarkdownEditorAccessContext` begrenzt ausschließlich Zugriffe auf Ressourcen außerhalb der freigegebenen Datei. Gäste erhalten keine Workspace-Suche, privaten Wiki-Vorschauen, Mitgliedervorschläge, Backlinks, Uploads in den Workspace oder serverseitigen Webvorschau-Importe. Freigegebene Bilder werden über den Gastendpunkt angezeigt; HTTPS-Bilder können direkt verlinkt werden. Der Account-Editor behält seine bisherigen Ressourcenfunktionen. Rechte werden weiterhin am Server durchgesetzt.

Die Gastseite hat nun einen eigenen vertikalen Scrollbereich, damit die globale App-Scrollsperre auf kleinen Bildschirmen keinen Inhalt abschneidet. Der Quelltextbereich scrollt innerhalb der verfügbaren Höhe.

Zusätzliche Nachweise:

- `test:editor:guest-controls` rendert die echte Editor-Komponente: gemeinsame Werkzeugleiste, tatsächlicher Formatierungsbefehl und Undo, Bildcontrols, Leserechte und keine privaten Workspace-Anfragen trotz gespeichertem Account-Workspace. Lokaler Editor-Lifecycle und Editorinteraktions-/Dialogtests bestehen weiterhin.
- Browser mit Besitzer, Schreibgast und Lesegast: identische Controls bei vergleichbarer Breite; native Blockverschiebung durch den Gast während einer Texteingabe des Besitzers erhält IDs und Text. Undo/Redo erhält die Änderung des Besitzers.
- Tabellen einfügen, Zelle bearbeiten, Zeile ergänzen, Weblink setzen, privaten Bildpfad ablehnen, Bildbreite und Ausrichtung ändern, Suche, Ansichtswechsel, Checkpoint und Reload funktionieren. Ein lokaler Browser-Response stellt das externe Testbild bereit.
- Mobile Werkzeugleiste und Verschiebebefehl sind geprüft. Tastaturaktivität wurde über eine verkleinerte Viewport-Höhe simuliert; die Hardware-Tastaturprüfung bleibt Teil der umfassenderen Abnahmematrix. Das Next.js-Dev-Symbol überlagert im Dev-Build den ersten mobilen Button; dessen Menü wurde über Fokus/Enter geöffnet und anschließend normal bedient.
- Bei Widerruf während eines geöffneten Linkdialogs schließen Dialog und Bearbeitungscontrols, der Zustand bleibt erhalten und lässt sich lokal exportieren. Der Lesegast bleibt schreibgeschützt.
- Die 390-Pixel-Ansicht scrollt bis zum Footer (Scrollhöhe 1010, sichtbare Höhe 844 Pixel), ohne horizontalen Überlauf. Im abgeschlossenen Prüflauf traten keine Anfragen außerhalb der Gast-API und keine App-Exceptions auf. Eine Navigation zur Browser-Fehlerseite beim absichtlichen Serverneustart wird separat als Testumgebungsereignis dokumentiert.
- Die Browserregression für gelöschte Drag-Quelle/-Ziel wartet nach Reload nun ausdrücklich auf den sichtbaren Editor, bevor sie den unveränderten vollständigen Dokumentbaum vergleicht. Zuvor lief die fünfsekündige Inhaltsprüfung bereits während des erneuten Ladens ab.

Die Nachweise zur Angleichung liegen privat unter `~/.codex/tmp/editor-fbd6-browser-20260909/guest-parity-*` und `guest-controls-*`. Die Testfreigaben sind widerrufen und die neutrale Testdatei gelöscht.

Abschließende Prüfung der Controls-Angleichung: vollständiger `npm run build` einschließlich TypeScript und Lizenzprüfung erfolgreich; ESLint für alle hier geänderten Code-/Testdateien ohne Fehler oder Warnungen. Alle vier Browserregressionen bestehen: drei gemeinsam, die Umbenennungsprüfung im anschließenden Einzellauf nach einem Verbindungsabbruch ausschließlich beim vorherigen Test-Cleanup. Die unveränderten Inhaltsprüfungen bestanden auch zuvor. Der eigene Host-Server ist beendet, alle vier verwalteten Container bleiben unverändert gesund.
