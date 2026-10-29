# Dokumentservice: frische Agentenrechte an der bestehenden Create-Grenze

Stand: 29.10.2026. Die [Messbasis für den normalen Organisations-Agenten](document-service-configured-agent-baseline-2026-10-29.md)
wird am unveränderten bisherigen Produktstand mit dem neuen Ablauf verglichen.
Der [maschinenlesbare Nachweis](document-service-agent-access-phase-2026-10-29.json)
bindet die sechs geänderten Quellen und die tatsächlichen Prüfausgaben per SHA-256.
Host-/Linux-Build, Start und UI sind inzwischen am Produktstand
`c8dde1074a257b546eee6e9a4991c637a6b1e9bf` erfolgreich geprüft.

Die normale Agentenfreigabe wird in der tatsächlichen bereits gehaltenen Create-
Verbindung mit einer statt sechs SQL-Abfragen beobachtet. Mitgliedschaft,
Workspace-/Projektzugang und Agentenfreigaben verwenden dieselben reinen
Entscheidungsfunktionen wie der bisherige Leser. Die Beobachtung erfolgt nach
der frühen Scope-Antwort und vor der unabhängig späteren Original-Origin-Prüfung.
Ein echter Widerruf nach der frühen Antwort muss weiterhin erkannt werden;
deshalb darf die Rechteentscheidung nicht in diese frühere Antwort verschoben
werden. Ein solcher zu früher Entwurf wurde durch den tatsächlichen negativen
Test verworfen. Nicht unterstützte Scalar-/Domain-Typen werden durch den echten
bisherigen SQL-Leser ausgewertet, ohne gerundete JSON-Werte zu autorisieren.

Die Zellen nennen SQL-Treiberaufrufe / Pool-Ausleihen je vollständigem registriertem
Werkzeugaufruf. Transaktionssteuerung ist enthalten; mehrteilige Befehlsstrings
werden nicht weiter aufgeteilt. Alle Quellen entstehen durch reguläre Uploads.

| Ablauf | Bisher | Neuer Stand |
| --- | ---: | ---: |
| Organisations-Agent, warme Anlage, 10 Quellen | 1790 / 34 | 1220 / 34 |
| Organisations-Agent, warme Anlage, 200 Quellen | 1790 / 34 | 1220 / 34 |
| Organisations-Agent, Original-Wiederholung | 264 / 7 | 194 / 7 |
| Hauptagent, warme Anlage, 10 Quellen | 1058 / 34 | 1058 / 34 |
| MCP, warme Anlage, 10 Quellen | 702 / 29 | 702 / 29 |

Die 114 bisherigen verschachtelten Agentenrechteprüfungen in gehaltenen Create-
Phasen benötigen nun je eine statt sechs tatsächliche SQL-Antworten. Das spart
570 Aufrufe, rund 32 Prozent der vollständigen warmen Agentenanlage. Die übrigen
Eintrittsprüfungen sowie die 34 Ausleihen bleiben erhalten.

Zwei alternierende Vorher-/Nachher-Paare mit vier warmen Beobachtungen je Version
verzögern tatsächliche PostgreSQL-Antworten um dieselben 2 ms. Ergebnisse, Fehler
und Abfragezahlen bleiben unverändert. Der Median des vollständigen registrierten
Aufrufs sinkt von 7044,345 auf 5247,92 ms, rund 25,5 Prozent; der Mittelwert von
7055,335 auf 5249,718 ms. Das ist eine kontrollierte Latenzempfindlichkeitsmessung,
keine Produktionsperzentile. Die lokalen Läufe ohne Verzögerung streuen und
begründen für sich keine verlässliche allgemeine Laufzeitverbesserung.

Die 72 neuen tatsächlichen PostgreSQL-Fälle bestehen am bisherigen und neuen
Produktstand. Sie prüfen Widerruf vor und nach der Scope-Antwort, passende und
falsche Grants, persönliche und Projekt-Workspaces, exakte NUMERIC-/Domain-Werte,
temporäre Relation-Shadows und unveränderte ursprüngliche Zeilen/`xmin`, native
Zustände und physische Bytes. Der Vergleich verwendet einen echten unveränderten
Git-Archivstand mit derselben verifizierten nativen Laufzeitdatei; eigene Schemas,
Daten und Archivverzeichnisse werden vollständig freigegeben.

Zwölf gezielte PostgreSQL-/Adapter-Suiten einschließlich der neuen Fälle bestehen. Die kanonischen
Release-Quellen samt betroffenen Testeintritten bestehen mit 3624 Wurzeln,
8867 Quellen und null Typdiagnosen; Lint besteht. In den vier Kern-Dateien bleiben
98 ursprüngliche Funktionen bytegleich. Die normalen SQL-Aufrufe und die
Sperrreihenfolge werden beibehalten; drei ursprüngliche Funktionen binden die
geteilten Entscheidungen beziehungsweise die spätere Beobachtung ein.

Der vollständige Host-Build und der Linux-Image-Build bestehen am sauberen selben
Quellstand. Der verwaltete Notebook-Container startet mit derselben Datenbank und
denselben Volumes gesund. Die ursprünglichen Upload-Zeilen mit `xmin`, Identitäten,
Dateibytes und Speicheranker bleiben erhalten; die elf übrigen Container laufen
unter ihren unveränderten IDs weiter. Alle neun CI-Prüfungen am Produktcommit
stehen auf erfolgreich.

Im neu gestarteten Linux-Container bestehen 15 Speicherfälle und vier echte
Browserfälle: mobiler Original-Retry nach Exportfehler ohne Überschreiben späterer
Peer-Änderungen, zwei Live-Editoren mit echtem Rechteentzug und frischem Leser
sowie beide Agentenverwaltungs-/Zugriffsfälle. Fünf tatsächliche Browserabrufe des
Dokumentlesers prüfen Identität, Generation und Inhalt. Review Center ist aus.
Der abschließende Lauf enthält null fehlgeschlagene, übersprungene oder flaky
Fälle und null Playwright-Fallwiederholungen. Eine unveränderte begrenzte
Anmeldewiederholung nach echter HTTP-429-Antwort wartet 1000 ms. Sieben Screenshots
sind visuell geprüft; Originaldaten bleiben auch nach dem Lauf unverändert.

Ein erster Browserlauf bestand drei Fälle; der zusätzliche Peer-Fall stoppte vor
seinen fachlichen Prüfungen an einer veralteten erwarteten Commit-ID im privaten
Testskript. Nur diese ID wurde auf den gebauten Quellstand berichtigt. Alle
anderen Assertions, Zeitgrenzen und Cleanup-Schritte bleiben bytegleich. Nach
erneutem Recreate desselben aktuellen Images besteht der vollständige Vier-Fälle-
Lauf. Der ursprüngliche Fehlbericht und die Vergleichshashes bleiben erhalten.

Die Gesamtbudgets (vorläufig HTTP-Lesen ≤20, Create 200–500), weitere strukturelle
Phasen-/Verbindungsbündelung und alle übrigen Pakete des
[Serviceplans](../document-write-database-performance-plan.md) bleiben offen.
Die vorhandene Dokument-/Linkindexstruktur bleibt die Grundlage für inkrementelle
Extraktion und Zielauflösung. Review Center und Undo werden nicht weiterentwickelt.
Dieser Nachweis ersetzt weder finales `test:all` noch abschließende PR/CI/Reviews,
Backup/Restore, verlustfreie Original-Recovery und
kontrolliertes Release. Produktionsdaten werden dadurch nicht verändert.
