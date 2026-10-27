# Dokumentservice: Vergleich kleiner und größerer Workspaces

Stand: 27.10.2026. Frühere Datensätze: Produktcode `7ba5b704f`, Messwerkzeuge `b50605faa`.
Die unten ausgewiesenen aktuellen 10er-/200er-Pfadprüfungen umfassen die sechs
Produktkorrekturen aus `b8dc12cc35` mit einzeln gespeicherten SHA-256-Belegen.
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
Zu diesem Zwischenstand war die größere Pfadaktion noch nicht abgenommen.

Ein weiterer Lauf mit unverändert regulärer Anlage und einer gemeinsamen
Prüfgrammatik nur in der impliziten Übergabe kommt über diese erste Fehlerstelle:
Die Übergabe erreicht `transferred` nach 4,393 Sekunden; Quellenprüfung und
Planaufbau sind nach 0,456 beziehungsweise 1,167 Sekunden erreicht. Die ganze
Pfadaktion bleibt dennoch rot. Nach rund 84,9 Sekunden endet ihr Messfenster mit
40.860 SQL-Aufrufen / 3.747 Ausleihen im Vordergrund und 47.957 / 4.139 im
Prozessfenster. Beim anschließenden vollständigen Worker-Drain protokolliert dessen
B2-Abschlusstransaktion `SQLSTATE_25P04` nach 5,006 Sekunden in `receipt-proof`.
Die zwei nativen Änderungen sind darin ausgeführt, ein COMMIT ist nicht versucht.
Die abschließenden Erfolgs-/Unverändertheitsprüfungen sind nicht erreicht.

Das Fenster endet vor dem Abschluss einer Worker-Abfrage. Seine Null bei
`failedStatements` ist deshalb kein Beleg für einen fehlerfreien Worker. Die dort
noch offene Abfrage/Verbindung und alle übrigen eigenen Ressourcen sind beim
späteren Fixture-Abschluss vollständig geschlossen. Eine weitere, noch nicht
abgenommene Korrektur verwendet die vorhandene Grammatik-Lebensdauer auch in den
nativen Move-Worker-Phasen. Der danach abgeschlossene reguläre 200er-Lauf
verbessert auch diese Phase: Move-Vorbereitung 2,605 Sekunden und B2-Callback
4,413 Sekunden einschließlich finaler Quellenprüfung. Die öffentliche Aktion
bleibt dennoch rot, weil ihre Frist vor dem vollständigen Worker-Abschluss endet
(84,6 Sekunden, 41.203 SQL-Aufrufe / 3.814 Ausleihen im Vordergrund).
Ein abgeschlossener Callback beweist keinen COMMIT. Die abschließenden Inhalts-/
Unverändertheitsprüfungen werden auch in diesem fehlgeschlagenen Lauf nicht erreicht.

Die weitere Korrektur bündelt höchstens acht ursprüngliche Dokumente je echter
Principal-/Verbindungsphase. Jedes Ziel behält seine Freigabe-/Zustandsprüfung und
eine frische Rechte-/Realm-Prüfung danach. Vor dem nächsten Ziel wird die originale
Gesamtfrist geprüft; die Fünf-Sekunden-Grenzen bleiben erhalten. Die 44 Koordinator-
Tests bestehen. Im zusätzlichen echten PostgreSQL-Gegencheck führt ein innerhalb
von B nach dem ersten tatsächlichen Freigabe-ACK gesperrter Account zu HTTP 403
(`SEAT_ACCESS_INACTIVE`): kein zweiter Freigabeschreibvorgang, zurückgerollter erster
Beleg, unveränderte native Daten/Metadaten/`xmin` sowie physische Bytes und Identitäten.
Alle eigenen Ressourcen schließen.

Als Zwischenprüfung bestehen Rename und Move bei **20 regulär angelegten
Dokumenten** einschließlich beider Linkrichtungen, stabiler Dokumentidentitäten,
aktueller nativer/physischer Checkpoints und 17 unveränderter unbeteiligter Quellen.
Jeweils 1.785 SQL-Aufrufe / 174 Ausleihen liegen im Vordergrund; die vollständigen
Prozessfenster umfassen 5.730 / 443 beziehungsweise 5.660 / 405. Die 32,4/30,1 Sekunden
enthalten weiterhin das Warten auf den regulären Projektionsscan. Diese Zwischen-
prüfung ersetzt die erforderliche 200er-Abnahme nicht. Der weitere reguläre
200er-Lauf mit der Bündelung scheitert in der Worker-Vorprüfung nach 5,028 Sekunden
(`BATCH_EXECUTION_FAILED`, HTTP 409); im Vordergrund liegen 8.125 SQL-Aufrufe /
340 Ausleihen. Alle eigenen Ressourcen schließen vollständig.

Ein ausdrücklich diagnostischer Aufbau klont nur unbeteiligte Quellen aus einer
regulär angelegten Vorlage. Die Ziel-/Linkdokumente, öffentlichen Routen und Worker
bleiben echt. Diese Diagnose ersetzt keine normale Upload-Abnahme. Sie reproduziert
zunächst denselben Vorprüfungsfehler nach 5,122 Sekunden. Die vorhandene Grammatik-
Lebensdauer nun auch in Auswahl und tatsächlicher Move-Vorprüfung behebt diese
Fehlerstelle; der danach weiterhin rote Diagnosefall scheitert in B2 bei der
Abschlussbestätigung nach 5,013 Sekunden. Ein COMMIT wird nicht versucht.

Die nächste Korrektur liest und sperrt alle abschließenden nativen Zustände in
einem SQL-Zugriff und bestätigt die exakte Zielmenge mit einem gemeinsamen UPDATE
und RETURNING. Jeder Zustands-/Versions-/Bytevergleich und die tatsächlichen
Transaktions-/Berechtigungsgrenzen bleiben erhalten. Die 21 bisherigen echten
PostgreSQL-Übergabeprüfungen sowie zwei zusätzliche Fälle bestehen: vollständige
Dreiziel-Bestätigung und atomarer Rollback, wenn ein echter Datenbank-Trigger eine
Bestätigung unterdrückt. Die Abschlussbündelung allein reicht noch nicht:
Der danach rote Diagnosefall überschreitet bereits bei der finalen Quellenprüfung
5,027 Sekunden; die neue Abschlussbestätigung wird nicht erreicht.

Die weitere Korrektur bündelt auch die frischen Freigabenachweis-Lesungen. Header,
Zielmenge und native Zustände werden in drei Grundabfragen gelesen und gesperrt;
jeder bisherige Validator läuft weiterhin über die tatsächlichen Zeilen. Zusätzlich
erforderliche Release-/Historienlesungen bleiben erhalten. Die endgültige lokale
Typprüfung, ESLint, 44 Koordinator-Tests und 24 + 18 echte PostgreSQL-Prüffälle
bestehen. Der zusätzliche Fall prüft veränderte gültige Bytes am letzten Ziel bei
unveränderter Sequenz und weist sie vor jeder fachlichen Änderung ab.

Im danach abgeschlossenen Diagnosefall erreichen Rename und Move jeweils den
öffentlichen Erfolgszustand und den nativen/physikalischen Link-Checkpoint. Die
B2-Callbacks benötigen 4,211/4,514 Sekunden und je 610 SQL-Aufrufe. Der gesamte
Diagnosefall bleibt ausdrücklich **rot**: Der abschließende Vergleich meldet
veränderte unbeteiligte native Datenbankzeilen beziehungsweise xmin. Die noch
folgende Prüfung der unbeteiligten physischen Dateien wird deshalb nicht erreicht.
Der Diagnoseaufbau kopiert nur Registry, Lineage, nativen Zustand und Datei,
jedoch keine dauerhaften Projektions-/Revisionsbelege. Der tatsächliche
Projektionsleser klassifiziert solche Einträge ausdrücklich als offen; der
laufende Projektor bearbeitet sie und kann Fehlerstatus in nativen Zeilen
speichern. Dieser Aufbau eignet sich damit nicht für die abschließende
Unverändertheitsabnahme und wurde aus dem Prüflauf entfernt.

Der vollständige **200er-Lauf über reguläre Uploads ist jetzt grün**, einschließlich
beider öffentlichen Aktionen und vollständiger eigener Ressourcenbereinigung.
Rename/Move benötigen im Vordergrund 8.511 SQL-Aufrufe / 783 Ausleihen
beziehungsweise 8.554 / 798. Die vollständigen Prozessfenster umfassen
22.101 / 1.282 beziehungsweise 22.010 / 1.248. Die B2-Callbacks erreichen
4,557/4,501 Sekunden bei je 610 SQL-Aufrufen; der öffentliche Erfolgszustand und
die nachfolgende native/physische Konvergenz bestätigen anschließend den
vollständigen Ablauf. Beide Linkrichtungen und die Identitäten der betroffenen
Dokumente stimmen. Alle 197 separat erfassten unbeteiligten Quellen behalten
native Zeilen, Metadaten, xmin und physische Bytes. Der Fixture-Starter liegt
außerhalb dieser 197 zusätzlichen Unverändertheitssnapshots.

Die vollständigen 92,8/90,4 Sekunden umfassen weiterhin die Freigabephasen und den
regulären Projektionsscan. Das sind noch keine endgültigen Leistungsbudgets und
kein Produktions-Latenzvergleich mit den vorher abgebrochenen Abläufen. Separate
kalte/warme Aktionen bleiben erforderlich. Die Produktkorrekturen sind als
`b8dc12cc35` committed. Alle 22 tatsächlichen Original-Move-Fälle, der echte
Own-B-Rechtewiderruf, alle 43 gemeinsamen Dateiaktionsfälle und alle 26 nativen
Kopierfälle bestehen mit vollständiger eigener Ressourcenbereinigung. Im Live-
Room-Test verwenden der rohe initiale Planaufbau und der historische Nur-Lese-
Vergleich die bereits vorhandene tatsächliche Projektions-/Workspace-Sperrgrenze;
keine SQL-Schreibbeobachtung oder Datenprüfung wurde ausgefiltert.

Der bereinigte, ausschließlich reguläre 10er-Lauf besteht ebenfalls auf denselben
sechs Produktdateien: Rename/Move mit 1.385/1.381 SQL-Aufrufen und 152/148 Ausleihen
im Vordergrund. Die Prozessfenster umfassen 4.668/4.536 Aufrufe und 424/374
Ausleihen; die vollständigen Dauern liegen bei 32,5/29,9 Sekunden. Alle sieben
zusätzlich erfassten unbeteiligten Quellen behalten native Zeilen, Metadaten,
xmin und physische Bytes. Die aktuelle 10er-/200er-Gegenüberstellung ist damit
belegt. Die Typprüfung aller fünf geänderten Testmodule (5.140 Quelldateien)
liefert null Diagnosen; ESLint ist grün. Aktueller Produktionsbuild, gerenderte
Desktop-/Mobilprüfung, reguläres test:all und CI dieses neuen Standes sind noch
nicht durch diese Backend-Abnahme belegt.

Die Größen-/Wiederholungsmatrix für registrierte Agenten- und MCP-Neuanlagen ist
inzwischen für beide Adapter mit 10 und 200 regulär angelegten Quellen abgeschlossen;
der [Create-Vergleich](document-service-create-matrix-2026-10-27.md) enthält die
16 vollständigen Aufruffenster und Quellenbelege. Auch die getrennten ersten und
wiederholten Rename-/Move-Aktionen sind inzwischen für 10 und 200 Quellen geprüft;
der [Pfadvergleich](document-service-path-cold-warm-2026-10-27.md) enthält alle acht
Prozessfenster und die darin enthaltenen Vordergrundmessungen. Alle acht Aktionen
stellen Links und ursprüngliche Pfade korrekt wieder her; acht beziehungsweise
198 unbeteiligte Quellen einschließlich des Starters bleiben unverändert.

Damit liegen die geforderten Messbereiche vor: 18 HTTP-/Agent-/MCP-Lesefenster,
zehn Editorfenster einschließlich Zutritt, direkter Owner-Verbindung und Projektion,
16 Create-Fenster sowie acht getrennte Pfadaktionsfenster. Diese 52 Fenster sind
keine 52 unabhängigen Tests; verschachtelte Servicewerte dürfen nicht addiert werden.
Die Editor-Verbindungskonkurrenz ist durch administrative Stichproben belegt und
ausdrücklich eine Untergrenze. Der tatsächliche direkte Owner-Client installiert
`installDocumentClientQueryMetrics` vor `connect`; seine Abfragen sind enthalten.
Die ergänzende echte Index-Route-Prüfung bei 10 und 200 Quellen bestätigt eine
einzelne schmutzige Quelleninspektion, Neuaufbau-Parität, neue Zielauflösung,
physische Änderungen und verweigerten Zugriff nach Rechtewiderruf.

Dies schließt die Messbasis ab. Die gemeinsamen Verträge, weitere Datenbank- und
Verbindungsbündelung, inkrementelle Linkauflösung, gemeinsame Änderungspfade,
Original-Recovery, endgültige Leistungsbudgets und Gesamtsuite,
Backup-/Restore-Nachweis sowie kontrolliertes Release bleiben Teil des Gesamtplans.

Die erste nachfolgende [Bündelung aktueller Agenten-Scope-Daten](document-service-agent-create-facts-2026-10-27.md)
ist bei beiden Größen geprüft: Der vollständige warme Agenten-Neuanlageaufruf
benötigt 4.492 statt 5.203 SQL-Aufrufe. Die 229 aktuellen Autorisierungsbeobachtungen
bleiben erhalten und benötigen im Create-Engine 2.061 statt 2.748 Aufrufe. Das ist
eine abgegrenzte Teilkorrektur; Pool-Ausleihen und die übrigen offenen Pakete
werden dadurch nicht als abgeschlossen bewertet.
