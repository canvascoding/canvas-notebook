# Eintrittsbindung ohne doppelte Principal-Transaktion

Produktbasis: `504effba0863098a967a10c93fa0eb00dc0203ae`.

## Verhalten

Agent und MCP eröffneten vor dem lesenden Öffnen der beiden Wurzelverzeichnisse
eine zusätzliche vollständige Principal-Transaktion. Der anschließend tatsächlich
schreibende `open`-Helfer erhielt bereits unabhängig davon einen neuen Principal.
Die erste Transaktion übertrug keine Autorität auf diesen Helfer.

Der private Eintritt bindet jetzt nur die ursprüngliche Eingabe an den echten
Dateivorgang und seine aktuelle Quelle. Die Owner-/Quellenprüfung bleibt bestehen.
Zwischen Bindung und Helfer werden ausschließlich die beiden Verzeichnisse lesend
geöffnet und ihre Identitäten festgestellt. Der tatsächliche `open`-Aufruf erhält
weiterhin seinen eigenen frischen Principal und die vollständige aktuelle Prüfung,
bevor der Python-Helfer startet oder einen Store, Anker oder Claim verändern kann.

Ein Eintritt unter einer bereits gehaltenen Verbraucher-/Publikationsphase behält
die bisherigen vollständigen Prüfungen. Andere Eingaben, erneute Bindungen,
private ACKs, öffentliche Links, native Schreibgrenzen, finale Bestätigung und
beide Deskriptorschließungen behalten ihre bestehenden Regeln. Es gibt keinen
neuen Parameter und keine Wiederverwendung einer früheren positiven Rechteentscheidung.
Python, Protokoll, Wiederholungen und Zeitlimits bleiben unverändert.

## Tatsächliche Prüfungen

`npm run test:documents:create:entry-binding` verwendet registrierte Agent-Tools,
den echten MCP-Transport, PostgreSQL, physische Verzeichnisse und den echten Helfer.
Positive SQL-/IO-Antworten werden nicht ersetzt.

Sechs Fälle umfassen für beide Aufrufer eine erfolgreiche Kontrolle sowie eine
wirkliche konkurrierende Kontoänderung nach dem lesenden DATA- beziehungsweise
Workspace-Open. Die Änderung bleibt bis zum Abbruch in einer anderen echten
Transaktion gesperrt und wird anschließend zurückgerollt. In allen vier
Fehlerfällen startet kein schreibender Helfer. Native Zeilen einschließlich xmin,
Registry-/Lineage-/Metadaten, Receipts, vorhandene Claim-/Ankerdateien einschließlich
Inodes und Bytes bleiben unverändert; die neue öffentliche Datei existiert nicht.

Alle 20 tatsächlich geöffneten Deskriptoren sind nach Kontrolle, Abbruch und
expliziter Wiederholung geschlossen; der Test prüft den echten `EBADF`-Fehler.
Sechs erfolgreiche Erstzulassungen erwerben nach den lesenden Root-Opens einen
neuen Principal. Die Wiederholung mit demselben Operationsschlüssel erzeugt
keine zweite Anlage und erhält Original-IDs, Claim und vollständigen Inhalt.
Die erfolgreichen Abläufe verwenden acht statt neun Agent- beziehungsweise
sieben statt acht MCP-Principal-Phasen.

Alle 15 gezielten PostgreSQL-Suiten bestehen am gleichen Produktstand, darunter
Private-ACK-, Owner-/Native-/Publikations-, Write-/Close-, COMMIT-Verlust-,
manuelle Anlage- und Upload-Prüfungen. Die bestehenden Sonden und ihre
Prüfaussagen bleiben unverändert. Release-TypeScript, die erweiterte Typprüfung
mit 35 Wurzeln / 5121 Quelldateien und ESLint bestehen.

## Direkter Vergleich

Vier frische Fixtures mit je zehn regulären Upload-Quellen schließen 16 Fenster.
Die Basis wird aus ihrem Git-Archiv mit eigenem nativen Addon gebaut. Alle
Originaldaten bleiben erhalten; Treiber- und Callsite-Zähler stimmen überein.
Alle eigenen Verbindungen, Schemas, temporären Daten und der Basischeckout werden
anschließend entfernt. Kein Messfenster enthält fehlgeschlagene Anweisungen oder
am Ende offene Abfragen/Verbindungen.

| Messfenster | Vorher SQL / Ausleihen | Nachher SQL / Ausleihen |
| --- | ---: | ---: |
| Agent, erster Adapteraufruf | 1264 / 71 | 1195 / 68 |
| Agent, beide warmen Neuanlagen | 1159 / 37 | 1090 / 34 |
| Agent, Originalwiederholung | 168 / 7 | 168 / 7 |
| MCP, erster Adapteraufruf | 890 / 43 | 857 / 42 |
| MCP, beide warmen Neuanlagen | 869 / 30 | 836 / 29 |
| MCP, Originalwiederholung | 102 / 12 | 102 / 12 |

Die instrumentierten warmen Agent-Laufzeiten liegen vorher bei 1996/2015 ms und
nachher bei 1927/1985 ms, MCP bei 1630/1642 beziehungsweise 1660/1587 ms.
Diese wenigen lokalen Werte sind Diagnosewerte; besonders MCP zeigt Streuung.
Sie ersetzen keine kontrollierte Latenz-/Parallelitätsabnahme.

Das vorläufige Create-Budget von 200–500 Anweisungen ist weiterhin nicht erreicht.
Finale 10-/200-Quellen-Vergleiche, aktuelle Build-/UI-/Gesamtsuite-Prüfungen und
sämtliche übrigen Pakete des Dokument-/Linkservice-Plans bleiben erforderlich.
Review Center und Undo sind in diesen Vergleichen deaktiviert;
`FILE_VERSION_CENTER_MODE=shadow` bleibt wie in den bisherigen Messungen gesetzt.
Dies ist keine Gesamtabnahme, Produktionsänderung oder Release-Freigabe.
