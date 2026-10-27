# Dokumentservice: Vergleich kleiner und größerer Workspaces

Stand: 27.10.2026. Produktcode `7ba5b704f`, Messwerkzeuge `b50605faa`.
Dies ist eine Teilabnahme der Messbasis aus dem
[Gesamtplan](../document-write-database-performance-plan.md), keine Freigabe des
gesamten Serviceumbaus. Review Center und Undo werden nicht weiterentwickelt.
Die [maschinenlesbaren Ergebnisse](document-service-matrix-2026-10-27.json)
enthalten ausschließlich Messwerte und Prüfmerkmale, keine Dokumentinhalte,
Dokument-/Nutzeridentitäten, Pfade, SQL-Texte, Parameter oder Secrets.
Der SQL-Zähler erfasst Treiber-Query-Aufrufe einschließlich Transaktionskontrolle;
mehrteilige Befehlsstrings werden dabei nicht in Einzelanweisungen zerlegt.

## HTTP, registrierter Agentenleser und MCP

Jeder Adapter und jede Größe läuft in einem eigenen frischen Prozess mit eigenem
privaten PostgreSQL-Schema. Dieselben festen Markdown-Inhalte werden über die
tatsächliche HTTP-Route, das registrierte `getPiTools`-Werkzeug beziehungsweise
den registrierten MCP-Web-Request/Response-Transport gelesen. Authentifizierung,
Toolregistrierung und Datenbankergebnisse werden nicht ersetzt. Nutzer, Seats,
Lizenz und Dokumente sind ausdrücklich isolierte Testdaten; eine echte Control-
Plane-Lizenzausstellung, ein Browser-OAuth-Flow oder ein laufender LLM-Chatturn
werden durch diese Fixtures nicht behauptet.

| Adapter | Native Dokumente | Erster Einstieg: SQL / Ausleihen | Wiederholtes Lesen: SQL / Ausleihen |
| --- | ---: | ---: | ---: |
| HTTP | 10 | 103 / 12 | 100 / 9 |
| HTTP | 200 | 103 / 12 | 100 / 9 |
| Agent | 10 | 236 / 37 | 131 / 3 |
| Agent | 200 | 236 / 37 | 131 / 3 |
| MCP | 10 | 129 / 32 | 108 / 19 |
| MCP | 200 | 129 / 32 | 108 / 19 |

Je Dataset bestehen der erste und zwei wiederholte Aufrufe. Der erste Agenten-
Aufruf umfasst auch seine Werkzeugregistrierung; der erste MCP-Aufruf umfasst
zusätzlich `initialize` und `tools/list`. Diese ersten Einstiege sind deshalb
keine identischen einzelnen RPCs. Die wiederholten Aufrufe führen jeweils nur
den tatsächlichen Leseaufruf aus und prüfen weiter aktuelle Rechte.

Vollständiger Inhalt, Byteumfang, Dokument-ID, Lineage, Pfad und Versionen werden
gegen die jeweilige native Testquelle geprüft. Die erzeugten IDs sind pro Fixture
verschieden; sie bleiben innerhalb ihres Fixtures stabil. Native Zeilen und Bytes
sowie Metadaten einschließlich ihrer `xmin` bleiben unverändert. Auch Revisions-
und Projektionszeilen bleiben durch die Leseaufrufe unverändert. Alle sechs Fixtures schließen Pool und Clients und entfernen
ihr eigenes Schema und Datenverzeichnis vollständig.

Der warme MCP-Aufruf enthält **72 SQL-Anweisungen / 4 Ausleihen im gemeinsamen
Dokumentleser** und zusätzlich **36 Anweisungen / 15 Ausleihen außerhalb dieses
Messbereichs**. Dort entfallen 10 auf Accounts, 6 auf Seats, 5 auf Workspaces,
2 auf Sitzungen, 4 auf Transaktionsanweisungen und 9 auf andere Abfragen.
Das grenzt die nächste Verbindungsbündelung ein. Eine Ausleihe ist keine neu
aufgebaute TCP-Verbindung. Die Dienstmessung ist Teil des Prozessfensters;
beide Werte dürfen nicht nochmals addiert werden.

## Tatsächlicher Editor-Backendablauf

Die Größe wird über den normalen Upload-/Birth-/Projektionsservice aufgebaut.
Anschließend laufen echter Cookie-Sessionhandler, Hocuspocus-Provider und die
regulären Owner-Intervalle einschließlich direkter Owner-Verbindungen. Inhalte,
Sequenz und physischer Datei-Checkpoint werden nach den Saves geprüft.

| Prozessfenster | SQL bei 10 / 200 Dokumenten | Ausleihen bei 10 / 200 Dokumenten |
| --- | ---: | ---: |
| Erste Session, Socket, Projektion | 1.144 / 1.117 | 110 / 103 |
| 6,1 Sekunden ohne Eingabe | 1.333 / 1.400 | 222 / 223 |
| Erster Save bis Datei-Checkpoint | 616 / 706 | 97 / 112 |
| Zweiter Save bis Datei-Checkpoint | 723 / 732 | 116 / 117 |
| Zweiter wirklicher Peer | 1.255 / 1.254 | 126 / 126 |

Die Hintergrundzyklen fallen unterschiedlich in die Fenster; die kleinen
Unterschiede sind keine präzise Kostenkurve der Dokumentmenge. Die beiden warmen
Saves im 200er-Fall dauern etwa 2,8 Sekunden. Beide Fixtures schließen alle eigenen
Server, Sockets, direkten Backends, Pool-Clients und entfernen Schema und Daten.
Dies ist ein Backend-/Protokolltest, keine zusätzliche gerenderte Groß-Workspace-
UI-Abnahme. Die tatsächliche Desktop-/Mobilprüfung des unveränderten Produktcodes
steht im [Editor-Prüfbericht](document-service-editor-observation-2026-10-27.md).

## Öffentliche Pfadaktionen und offene Matrixfelder

Mit zehn nativen Dokumenten bestehen die öffentliche Rename-Route und der mobile
Move-Alias einschließlich Vorschau, tatsächlichem Worker, terminalem Status und
nativer/physischer Projektion. Rename benötigt in seinem gesamten Prozessfenster
5.469 SQL-Anweisungen / 501 Ausleihen und 32,7 Sekunden; der nachfolgende Move
5.322 / 447 und 29,6 Sekunden. Die sieben unbeteiligten Quellen behalten ihre
nativen Zeilen, IDs, Lineages, Metadaten, `xmin` und physischen Dateibytes.
Die beiden betroffenen Dokumente behalten ebenfalls IDs und Lineages; eingehende
und relative Verweise werden korrekt angepasst. Alle eigenen Ressourcen schließen.

Der Pfadaktions-Fall mit 200 über den normalen Upload-Service angelegten
nativen Dokumenten ist **fehlgeschlagen**: Rename endet nach 51,3 Sekunden mit
HTTP 503 (`IMPLICIT_MOVE_DISPOSAL_UNCONFIRMED`). Das Diagnoseprotokoll enthält
`SQLSTATE_25P04`; die abschließende Vorbereitung überschreitet das unveränderte
Transaktionslimit. Der gemessene Vordergrundvorgang umfasst 39.686 SQL-Aufrufe,
3.541 Pool-Ausleihen und 1.946 Rechteprüfungen. Dieser Messbereich ist kein
vollständig gespeichertes Prozessfenster. Move und die abschließenden Inhalts-/
Unverändertheitsprüfungen werden nach dem Fehler nicht mehr erreicht. Worker,
Server, Pool, Clients, privates Schema und Datenverzeichnis schließen vollständig.
Die größere Pfadaktion hat damit noch keine Abnahme.

Getrennte kalte/wiederholte Pfadaktionen sowie die Größen-/Wiederholungsmatrix
für Agenten- und MCP-Neuanlagen sind weiterhin erforderlich und offen. Die bisherige vollständige Agenten-/MCP-Create-Regressionsprüfung
ersetzt diese Messfelder nicht. Auch Verbindungsbündelung, inkrementelle Link-
auflösung, gemeinsame Änderungspfade, Original-Recovery, endgültige Gesamtsuite,
Backup-/Restore-Nachweis und kontrolliertes Release bleiben Teil des Gesamtplans.
