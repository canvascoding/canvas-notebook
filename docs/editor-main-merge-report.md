# Zusammenführung von Block-Lifecycle und aktuellem main

Ausgangsstand: `87ebabf2` auf `codex/editor-structure-lifecycle-plan`, zusammengeführt mit `origin/main` auf `f44473f8` (9. September 2026). Die zwölf Textkonflikte betreffen Dashboard, drei Editoren, Kollaborationsclient, Dateiwatcher, Dateistore, HTTP-Server, Paketmanifest und drei Lizenzartefakte.

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
