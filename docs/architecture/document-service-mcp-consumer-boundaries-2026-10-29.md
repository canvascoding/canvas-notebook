# Aktuelle MCP-Prüfungen an tatsächlichen Verbrauchergrenzen

Produktbasis: `0f037fc350f5c7108684a8f8ba53152f6d9055f7`.
Die eigenständige Testkorrektur `36d747ac5` ändert keinen Produktcode.

## Verhalten

Der echte MCP-Principal prüft aktuelle Berechtigungen vor dem vollständigen
Verbraucher und nach dessen Abschluss auf derselben Verbindung. Er hält dabei
die tatsächlichen Datenbanksperren. Der private Markdown-Create-Wrapper führte
zusätzlich vor und nach seinem Verbraucher noch einmal die vollständige
Current- und Realm-Prüfung aus.

Diese beiden zusätzlichen äußeren Prüfungen werden durch einen synchronen
Vergleich der ursprünglichen Aufrufdaten ersetzt. Dafür müssen die echte private
Phase, Verbindung, der Frame und das Access-Objekt identisch und aktiv sein.
Die ursprünglichen Datenprädikate bleiben bytegleich. Der umschließende Principal
behält seine vollständigen frischen Eintritts- und Ausgangsprüfungen. Die echten
IO-/Native-Grenzen innerhalb des Verbrauchers behalten Current und die frische
Realm-Abfrage. Die separate späte Owner-Prüfung nach asynchroner B-Autorisierung
bleibt ebenfalls bestehen.

Auch der frühere Workspace-Rückruf benötigt keine eigene zusätzliche Current-
Beobachtung: Er gibt ausschließlich die Daten des echten Principals zurück,
der ihn vollständig mit seinen frischen Eintritts-/Ausgangsprüfungen umschließt.
Es gibt keinen neuen öffentlichen Modus, keine gespeicherte positive
Berechtigungsentscheidung und keine Änderung an Zeitlimits oder Wiederholungen.

Der allgemeine MCP-Principal einschließlich seiner eigenständigen Schema-
Vorprüfung bleibt vollständig bytegleich zur Produktbasis. Diese Vorprüfung
erhält insbesondere den richtigen Bereichsfehler bei einem tatsächlichen
Schemaaustausch, bevor SQL auf Tabellen des ersetzten Schemas geparst wird.
Request-/Agent-Zweige und die vollständige Current-/Realm-Prüfung an echten
IO-Grenzen bleiben ebenfalls bytegleich.

## Tatsächliche Fehlerfallprüfungen

`npm run test:documents:mcp:create-boundaries` verwendet echte MCP-HTTP-Aufrufe,
JWTs, PostgreSQL-Verbindungen und Kernel-Deskriptoren. Drei Fälle umfassen eine
Kontrolle sowie tatsächlichen Rechteentzug auf derselben B-Verbindung:

- Nach der Eintrittsantwort wird das Konto wirklich gesperrt. Die folgende
  echte Schreibgrenze verweigert den Vorgang vor dem ersten mutierenden Helfer;
  ursprüngliche Zeilen/xmin, Claims, Anker, Inodes und Bytes bleiben unverändert.
- Nach beiden tatsächlichen Deskriptor-Schließungen und der letzten gewöhnlichen
  Owner-Prüfung wird das Konto auf dem schließenden B gesperrt. Die abschließende
  Current-Prüfung des echten umschließenden Principals sieht diesen Entzug und
  liefert keinen Erfolg. Bereits veröffentlichte Originalbelege und Inhalte
  bleiben erhalten; eine explizite Wiederholung desselben Schlüssels verwendet
  dieselbe ursprüngliche Anlage.

Sechs tatsächlich geöffnete Deskriptoren schließen. Die Kontenzeile einschließlich
xmin bleibt nach dem tatsächlichen Rollback gleich. Wiederholungen erzeugen keine
zweite native Identität. Die Sonde beobachtet echte Antworten und den tatsächlichen
anonymen Ausgangs-Callsite; sie ersetzt keine positive SQL- oder IO-Antwort.

`npm run test:documents:mcp:runtime-snapshot` ergänzt 24 tatsächliche Fälle für
Read/Create/Edit und vorbereitete/gewöhnliche SQL-Leser. Die echten Settings-
Dateibytes werden gelesen; Konto- und Bereichsänderungen passieren auf dem
tatsächlichen B während dieses IO. Ein deaktivierter MCP-Lauf behält seine
Fehlerpriorität gegenüber gleichzeitig nicht unterstützten Daten. Current
benötigt weiterhin drei SQL-Aufrufe. Originaldaten, xmin, Spaltentypen und
Konfigurationsbytes bleiben erhalten.

Alle 25 gezielten PostgreSQL-Suiten bestehen. Die bisherigen 132 MCP-Snapshot-
Gruppen bleiben unverändert. Native Versionsrennen, Owner-Lockverlust während
frischer B-Autorisierung, Close-/COMMIT-Antwortverlust und ursprüngliche
Wiederaufnahme bleiben geprüft. Die Private-ACK-Prüfung bestätigt weiterhin
60 private und zehn öffentliche ACKs, 70 blockierte echte Peer-Updates, acht
tatsächliche Konto-/Native-Fehler und 180 Ablehnungen kopierter Eingaben.

Eine zuvor veraltete Copy-Testannahme ist eigenständig korrigiert: Native
Dokumentautorität ist auf `main` seit `a31869fbb` dauerhaft integriert; die frühere
Test-Opt-in-Variable schaltet sie nicht aus. Alle sechs Copy-Testgruppen prüfen
nun auch bei gelöschtem Opt-in ursprüngliche Apply-/Recover-Belege, native IDs,
Scene-/Asset-/Linkdaten und unveränderte Inhalte. Produktive Aktivierung und
Rechteprüfungen werden dafür nicht geändert. Auf macOS starten die Tests mit dem
kanonischen temporären Verzeichnis; die produktive Symlink-Prüfung bleibt streng.

Release-TypeScript, die erweiterte Typprüfung mit 44 Wurzeln / 5174 Quellen und
ESLint bestehen. Drei bestehende Produktfunktionen ändern sich, ein privater
Datenvergleich kommt hinzu. 326 andere Funktionen in den vier untersuchten
Produktdateien bleiben bytegleich.
Der vollständig aktualisierte GitNexus-Index ordnet den vorbereiteten Diff den
erwarteten vier Produktfunktionen und Testhelfern zu: sieben Dateien, 55 Symbole,
keine betroffenen Ausführungsprozesse und Risiko LOW.

## Direkter Vergleich

Vier frische Fixtures mit je zehn regulären Upload-Quellen schließen 16 Fenster.
Die Produktbasis wird aus ihrem Git-Archiv mit eigenem nativen Addon verwendet.
Treiber- und Callsite-Zähler stimmen vollständig überein. Es bleiben keine
Abfragen oder Verbindungen offen; ursprüngliche Zeilen/xmin, IDs, Belege und
physische Inhalte bleiben erhalten.

| Messfenster | Vorher SQL / Ausleihen | Nachher SQL / Ausleihen |
| --- | ---: | ---: |
| Agent, erster Adapteraufruf | 1163 / 68 | 1163 / 68 |
| Agent, beide warmen Neuanlagen | 1058 / 34 | 1058 / 34 |
| Agent, Originalwiederholung | 168 / 7 | 168 / 7 |
| MCP, erster Adapteraufruf | 774 / 42 | 723 / 42 |
| MCP, beide warmen Neuanlagen | 753 / 29 | 702 / 29 |
| MCP, Originalwiederholung | 102 / 12 | 91 / 12 |

Die warmen MCP-Katalogabfragen sinken von 490 auf 439. Die tatsächlichen Owner-
Lesungen bleiben bei 120; MCP-Faktenlesungen sinken von 126 auf 100, Schema-
Lesungen von 84 auf 71 und zusätzliche Realm-Lesungen von 48 auf 36. Die warme
instrumentierte MCP-Laufzeit liegt vorher bei 1492/1518 ms und nachher bei
1485/1502 ms. Diese wenigen lokalen Laufzeiten sind Diagnosewerte. Kontrollierte
Latenz-/Parallelitätstests und der abschließende 10/200-Vergleich bleiben nötig.

Der abschließende lesende PostgreSQL-/Dateisystem-Audit bestätigt die Abwesenheit
von 46 einzeln protokollierten eigenen Testschemas, Backends und Datenverzeichnissen
einschließlich verworfener Versuche. Für die ältere MCP-Read-Suite ergänzen
tatsächliche Cleanup-Aussagen und die Abwesenheit ihrer Schema-/Backend-/Temp-
Familien den fehlenden individuellen Besitzbericht. Das Basisarchiv ist entfernt.

Review Center und Undo sind deaktiviert; `FILE_VERSION_CENTER_MODE=shadow` bleibt
wie im bisherigen Vergleich gesetzt. Die abschließende Abnahme der normalen
Standardeinstellungen steht weiterhin aus. Das vorläufige Create-Budget von
200–500 Aufrufen ist nicht erreicht. Übrige Servicepakete, aktuelle Build-/UI-/
Gesamtsuite, PR/CI/Reviews, Produktionsbackup/Restore und Release-Gates bleiben
erforderlich. Dieser Nachweis ist keine Produktionsänderung oder Release-Freigabe.
