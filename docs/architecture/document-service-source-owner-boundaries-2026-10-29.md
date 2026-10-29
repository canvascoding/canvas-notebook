# Quellenbeleg und aktuelle Owner-Prüfungen

Produktbasis: `5ef1d5a8e3adc80999bebf132ec77631655f75ee`.

## Verhalten

Eine MCP-Quelle prüfte neben ihrer ursprünglichen Invocation und den gebundenen
Bytes nochmals den Dateivorgang-Owner. Ihre Koordinatoren führten diese
Owner-Prüfung an mehreren Stellen bereits ausdrücklich durch. Bei privater
Dateiverifikation wiederholte zusätzlich der äußere Rückruf die gerade erfolgte
Owner-/Workspace-Beobachtung des festen Speicherwächters.

Die MCP-Quellenkapsel prüft jetzt wie die Agent-Quelle ihren echten aktiven Aufruf,
die private Lebensdauer und die ursprünglichen Bytes. Das ist ein Quellenbeleg,
keine aktuelle Berechtigung oder Schreibautorität. Frische Owner-Prüfungen bleiben
ausdrücklich an Capture, Quellenlesen und Native-Grenzen bestehen. Insbesondere
bleibt die MCP-Prüfung nach der frischen Native-Realm-/Quellenbeobachtung erhalten.

Nur der äußere Rückruf einer tatsächlich privaten, rein lesenden Verifikation
verzichtet auf seinen doppelten Owner-Leser. Er prüft dafür den echten aktiven
Owner, seinen Frame, die identische Quelle und das ursprüngliche Eingabeobjekt
im tatsächlichen privaten Verifikationskontext. Ein Aufrufer kann diesen Pfad
nicht mit einem Stage-String oder einer Eingabekopie auswählen. Die feste
Verifikationsgrenze beobachtet Owner und Workspace weiterhin frisch; zwischen
ihr und dem äußeren Rückruf findet keine weitere B-Rechtebeobachtung statt.
Die bestehende [rein lesende Verifikation](document-service-readonly-birth-verification-2026-10-28.md)
initialisiert oder repariert dabei keine Stores, Anker oder Claims.

Gewöhnliche Helfer- und Abschlussgrenzen behalten den späten äußeren Owner-Nachweis
nach der asynchronen Rechteprüfung auf B. Eine frische B-Berechtigung bestätigt
nicht, dass A seinen separaten Dateivorgang-Lock weiterhin besitzt. Request-
Quellen behalten ihren bisherigen Rückruf. Es gibt keinen neuen öffentlichen
Parameter, keine frühere positive Berechtigungsentscheidung als Ersatz und
keine Änderung an Python, Publikationsprotokoll, Zeitlimits oder Retries.

## Tatsächliche Prüfungen

`npm run test:documents:create:late-owner` verwendet registrierte Agent-Tools,
den echten MCP-Transport, tatsächliche PostgreSQL-Antworten und physische Dateien.
Die Sonde erfasst nach beiden lesenden Root-Opens den echten Owner A. Während
einer anschließenden tatsächlichen SELECT-Antwort auf B löst sie den wirklichen
exklusiven Advisory-Lock auf der originalen A-Verbindung.

Vier Fälle umfassen beide Aufrufer mit Kontrolle beziehungsweise Lockverlust.
Beide Fehlerfälle werden vor dem ersten schreibenden Helfer abgewiesen. Native
Zeilen einschließlich xmin, vorhandene Registry-/Lineage-/Metadaten, Claims,
Receipts, Anker, Inodes und Bytes bleiben unverändert. Acht tatsächlich geöffnete
Deskriptoren schließen; `stat` liefert anschließend den echten `EBADF`-Fehler.
Die explizite Wiederholung desselben Schlüssels gelingt und ein weiterer Retry
erzeugt keine zweite Anlage oder Veränderung der ursprünglichen Belege.

Alle 17 gezielten PostgreSQL-Suiten bestehen am gleichen Produktstand. Die
bisherigen Owner-/Native-/Publikationssonden und ihre Aussagen bleiben
unverändert. Das umfasst reale Owner-Lockverluste und Schemawechsel, Native-
Versionsrennen, COMMIT-/Close-Antwortverlust, Erstveröffentlichung, manuelle
Anlage und Upload. Die Private-ACK-Prüfung bestätigt weiterhin 60 private und
zehn öffentliche Bestätigungen, 70 blockierte Peer-Updates und acht tatsächliche
Konto-/Native-Fehler. An den verbleibenden echten SQL-Grenzen weisen nun 180
Prüfungen kopierte Eingaben im lebenden privaten Kontext zurück.

Release-TypeScript, die erweiterte Typprüfung mit 37 Wurzeln / 5123 Quelldateien
und ESLint bestehen. Fünf bestehende Produktfunktionen ändern sich; 278 andere
Funktionen in den drei untersuchten Produktdateien bleiben bytegleich. Bestehende
Prüfaussagen, reguläre Suiteauswahl, Zeitlimits und Wiederholungen werden nicht
angepasst.

## Direkter Vergleich

Vier frische Fixtures mit je zehn regulären Upload-Quellen schließen 16 Fenster.
Die Produktbasis wird aus ihrem Git-Archiv mit eigenem nativen Addon gebaut.
Treiber- und Callsite-Zähler stimmen überein; keine Anweisung schlägt fehl und
am Ende bleiben keine Abfragen oder Verbindungen offen. Originalzeilen
einschließlich xmin, native IDs/Bytes und physische Inhalte bleiben erhalten.
Alle Vergleichsschemas, Daten, Verbindungen und der Basischeckout werden entfernt;
der abschließende PostgreSQL-/Dateisystem-Audit bestätigt deren Abwesenheit.

| Messfenster | Vorher SQL / Ausleihen | Nachher SQL / Ausleihen |
| --- | ---: | ---: |
| Agent, erster Adapteraufruf | 1195 / 68 | 1163 / 68 |
| Agent, beide warmen Neuanlagen | 1090 / 34 | 1058 / 34 |
| Agent, Originalwiederholung | 168 / 7 | 168 / 7 |
| MCP, erster Adapteraufruf | 857 / 42 | 774 / 42 |
| MCP, beide warmen Neuanlagen | 836 / 29 | 753 / 29 |
| MCP, Originalwiederholung | 102 / 12 | 102 / 12 |

Die Owner-Beobachtungen sinken warm von 138 auf 106 beim Agenten und von 203 auf
120 bei MCP. Die instrumentierten warmen Laufzeiten liegen beim Agenten vorher
bei 1943/2029 ms und nachher bei 1895/1904 ms, bei MCP bei 1603/1630 beziehungsweise
1548/1536 ms. Diese wenigen lokalen Werte sind nur Diagnosewerte. Kontrollierte
Latenz-/Parallelitätstests und der abschließende Vergleich mit 10/200 Quellen
bleiben erforderlich. Review Center und Undo sind deaktiviert;
`FILE_VERSION_CENTER_MODE=shadow` bleibt wie in den bisherigen Vergleichen gesetzt.

Das vorläufige Create-Budget von 200–500 Aufrufen ist weiterhin nicht erreicht.
Die aktuelle Build-/UI-/Gesamtsuite und die übrigen Pakete des
Dokument-/Linkservice-Plans bleiben erforderlich. Review Center und Undo werden
nicht weiterentwickelt; dies ist keine Produktionsänderung oder Release-Freigabe.
