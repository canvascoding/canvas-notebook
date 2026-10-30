# Aktuelle Editor-Prozessfenster bei 10 und 200 Dokumenten

Stand: 30.10.2026. Produktstand `6302d6403755e581f0eae9e83a10e1c016aa918c` nach PR #191.
Teil des [zentralen Dokumentservice-Plans](../document-write-database-performance-plan.md).
Die [maschinenlesbaren Ergebnisse](document-service-editor-current-baseline-2026-10-30.json)
enthalten Quellhashes, Zähler und bereinigte Ausführungspläne ohne SQL-Text, Parameter,
Dokumentinhalte, Akteur-IDs oder Zugangsdaten.

## Gleicher tatsächlicher Ablauf in beiden Größen

Der unveränderte Editor-Profiler legt die Quellen über den normalen nativen
Upload-/Anlageweg in einem eigenen PostgreSQL-18-Schema und privaten Datenordner an.
Er verwendet echte Fixture-Cookies, den ursprünglichen Session-Handler, HTTP,
WebSocket, Hocuspocus, den tatsächlichen Room Owner und die physische Projektion.
Er prüft die erste Synchronisation, einen gehaltenen Editor ohne Eingabe, zwei
Rich-Text-Speicherungen bis zum nativen und physischen Checkpoint und einen zweiten
wirklichen Peer. Beide Größen bestehen vollständig und schließen Server, Peers,
Owner-Verbindungen, Pool, Clients, Schema und temporäre Daten. Kein externer Fetch
findet statt. Review Center und Undo werden nicht weiterentwickelt.

Dies sind isolierte Protokoll-/Prozessfenster. Browser, Next-Middleware und weitere
Frontend-Abfragen etwa für die Link-Seitenleiste gehören nicht zu diesen Zahlen.
Der Prozess ist durch die reguläre Fixture-Anlage bereits aufgewärmt; eine kalte
Datenbankplatte wird nicht behauptet. Die getrennte reguläre UI-Abnahme bleibt im
[Projektionsbericht](document-link-resolution-projection-2026-10-30.md) dokumentiert.

## Aktuelle SQL- und Pool-Zähler

| Fenster | 10 Dokumente: SQL / Pool-Zähler | 200 Dokumente: SQL / Pool-Zähler |
| --- | ---: | ---: |
| Erste Session, Socket und Projektion | 690 / 94 | 690 / 95 |
| 6,1 Sekunden Leerlauf | 801 / 151 | 769 / 149 |
| Erster warmer Save bis Datei-Checkpoint | 410 / 80 | 447 / 87 |
| Zweiter warmer Save bis Datei-Checkpoint | 417 / 82 | 407 / 79 |
| Warme Session und zweiter Peer | 729 / 100 | 739 / 102 |

Das erste Öffnen benötigt in diesem Versuch bei beiden Größen 690 Treiberaufrufe.
Ein Anstieg proportional zur Dokumentzahl ist für diese Fenster nicht nachgewiesen.
Der erhebliche Leerlauf und die Save-Fenster bleiben bestehen. Neben der
ursprünglichen Nutzereingabe sind darin die wirklich parallel laufenden Admission-,
Owner- und Projektionsprüfungen enthalten. Die Fenster oder ihre verschachtelten
Phasen sind keine addierbaren unabhängigen Vorgänge.

In allen zehn Fenstern entsprechen die Callsite-Zähler exakt den tatsächlichen
SQL-Zählern; Stackfehler und fehlgeschlagene SQL-Aufrufe sind null. Beim ersten
Zehner-Öffnen enthalten 325 der 690 Aufrufe Katalog-/Kontextabfragen; beim zweiten
Peer sind es 341 von 729. Eine zusammengesetzte aktuelle Rechteabfrage kann dabei
auch Konten-, Seat- und Workspace-Fakten lesen. Die Klassifikation bedeutet daher
nicht, dass ihre gesamte Arbeit ausschließlich Tabellenmetadaten betrifft.

Der vorhandene Runtime-Pool-Zähler bucht beim Abschluss von `connect`; der
Callsite-Profiler beobachtet dessen Start. Hintergrundarbeit kann Fenstergrenzen
überschreiten. Diese Zähler werden getrennt ausgewiesen und nicht als zwingend
gleich behandelt. Ebenso dürfen am Fensterende noch laufende Hintergrundabfragen
nicht als Ressourcenleck interpretiert werden: Der vollständige anschließende
Fixture-Abbau ist geprüft. `peakConnections` umfasst nur Pool-Leases; die
zusätzlichen 100-ms-Backend-Samples umfassen direkte Owner-Verbindungen, bleiben
aber eine Untergrenze des tatsächlichen Gesamtmaximums.

## Ausführungsplan der wiederholten Member-Beobachtung

Ein separater kleiner Fixture führt zwei ursprüngliche Cookie-Session-Anfragen
aus; beide antworten mit 200. Die aktuelle kombinierte Member-Abfrage wird dabei
152-mal beobachtet. Für ihre ersten beiden tatsächlichen Aufrufe wird auf der
jeweils original gehaltenen Verbindung zusätzlich `EXPLAIN (ANALYZE, BUFFERS)`
ausgeführt. Nur der bekannte lesende SELECT wird zugelassen; SQL-Text und
Parameter bleiben außerhalb des Berichts. Diese Diagnose-SELECTs sind zusätzliche
Testarbeit und werden nicht als normale Request-Latenz oder SQL-Einsparung verkauft.

| Beobachtung | Planung | Ausführung |
| --- | ---: | ---: |
| 1 | 1,504 ms | 0,410 ms |
| 2 | 1,457 ms | 0,359 ms |

In diesen zwei Planproben ist der Planungsanteil höher als die Ausführung. Das
begründet einen gezielten nächsten Vergleich der häufigen Kontextaufrufe und
ihrer Planverwendung, ohne frische Rechte- oder Zustandsprüfungen zu entfernen.
Die übrigen dominanten SQL-Gruppen und alle tatsächlichen Aufrufer benötigen
weiterhin eigene aktuelle Messungen.

## Datenerhalt und offene Abnahme

Die geschützten vorhandenen QA-Originalzeilen inklusive `xmin`, nativen Zuständen,
Dateibytes und allen drei Speicherankern bleiben vor und nach den Editor-Läufen
sowie nach der Planprobe gleich. Alle 12 laufenden Container behalten ihre IDs;
kein Container wurde für diese Host-Fixtures verändert. Die Diagnose sammelt
zusätzliche Stacks und ist deshalb kein allgemeiner Produktionslatenz-Benchmark.

Dieser Messschritt ändert keinen Produktcode und erklärt die Leistungsbudgets
nicht für erreicht. Vollständige aktuelle Editor-/Agent-/MCP-/Rename-/Move-Vergleiche,
exakte Verbindungsspitzen, weitere Faktenbündelung, begrenzte native Body-Lesungen
und die übrigen Pakete des Gesamtplans bleiben offen.
