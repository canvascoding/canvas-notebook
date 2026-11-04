# Plan: zentraler Dokument- und Linkservice

Stand: 04.11.2026. Ziel ist eine robuste und messbar schnelle gemeinsame Grundlage
für Dokumente, Linkpflege und Aktualisierungen aus Editor, Agenten, MCP und normalen
Dateioperationen. Review Center und Undo sind ausdrücklich außerhalb der Umsetzung.
Bestehende Daten und weiterhin erforderliche Speicherformate werden erhalten.

## Aktueller Abnahmestand vom 04.11.2026

Die Build-Quelle wird nach dem Snapshot-Ausfall auf `deb.debian.org` umgestellt.
Alle neun Quellen-/Binärlisten (Bookworm, Updates und Security; amd64/arm64) sind
heruntergeladen und gegen die veröffentlichten SHA-256-Werte geprüft. Bookworm
und Updates behalten dieselben Paketindizes; Security erhält den geprüften
Stand vom 04.11.2026. `debian-repository-lock.json` bindet die Indexinhalte, und
ein obligatorischer APT-Hook verweigert Installationen nach Indexänderungen.
APT-Signatur- und Ablaufprüfungen bleiben aktiv. Schema 5 des Runtime-Inventars
belegt den tatsächlich installierten Repository-Lock statt eines nicht mehr
verwendeten Snapshot-Datums. Parser-/Negativtests, Lint und `test:licenses` sind
bestanden; echter APT-Build, Host-Build und die anschließenden Abnahmen stehen
für diese Änderung noch aus. Alle 13 CI-Prüfungen des vorherigen Commits
`2e38c50a9` sind erfolgreich abgeschlossen.

Die Cache-Korrektur in `1e9e895b2` ist gepusht und besteht den Host-Produktionsbuild
(einschließlich Release-Typprüfung), die gezielten Retention-, Lifecycle-, Rename-
und Recovery-Tests sowie Lint. Alle 13 CI-Prüfungen dieses Commits sind grün,
einschließlich Native API und installiertem SDK. Ein zusätzlicher Hook-Lifecycle-Test bestätigt
erneute Session-Anforderungen im echten Clientpfad bei RAM-Wiederverwendung, Peer-Löschungen mit gleichem
Versionsvektor, Read-Downgrade, Benutzerisolation, Verdrängung des ältesten von
vier Dokumenten und Ablauf nach 15 Sekunden. Transport und IndexedDB werden in
diesem Hook-Test kontrolliert; dies ersetzt keine echte HTTP-/Browser-Abnahme.

Der Linux-Build dieses Commits wurde nach 11:40 Minuten ohne Fortschritt beim
Snapshot-Paketabruf kontrolliert abgebrochen; der ursprüngliche lokale Container
ist wieder gesund. Begrenzte Diagnose-Builds zeigen Timeouts bzw. HTTP 503
`No healthy backends` bei den Paket-/Quellenlisten, auch über stabile Dateipfade;
der alternative Snapshot-Endpunkt liefert ebenfalls HTTP 503. Eine erneute
Prüfung am 04.11. um 12:08 UTC liefert HTTP 504 für dieselbe Quellenliste. Paketstand,
Signaturprüfung und Produkt-Dockerfile wurden nicht geändert. Beleg:
`document-service-integration-artifacts/sync-retention-linux-build-external-failure-20261104.json`.
Die aktuelle kompilierte Browser-Abnahme und das Release sind deshalb weiterhin
offen. Die folgenden Ergebnisse gehören zum letzten abgeschlossenen Build:

Produktstand `2f85bb3c7de36deab07afe81d785ac3fe01a5be2` enthält `main`
`3ec143a25` einschließlich PR #201. PR #198 bleibt Entwurf; ein Release dieses
Gesamtplans ist noch nicht veröffentlicht. Die folgenden älteren Abschnitte sind
historische Teilnachweise und ersetzen diesen aktuellen Status nicht.

- Host- und Linux-Build sowie alle 13 CI-Prüfungen bestanden am Produktstand.
- Die frische kompilierte 200-Dokumente-Matrix bestand alle sechs REST-/SDK-
  Copy-/Move-/Delete-Gruppen einschließlich ursprünglicher Operationsbelege,
  Status, expliziter Recovery, sofortigem Lesen, eingehenden Links und Rotation.
  Beleg: `compiled-api-sdk-operations-1793755216082-result.json`.
- Die reguläre Gesamtsuite bestand auf demselben Build: **331 bestanden,
  0 fehlgeschlagen, 269 bedingte Skips**, 39,3 Minuten. Skips gelten nicht als
  getestetes Verhalten. Der Runner endete erfolgreich und bestätigte unveränderte
  Originaldaten sowie die Wiederherstellung des vorherigen lokalen Laufzeitstands.
  Beleg: `compiled-test-all-2f85b-1793787570061-result.json`.
- Die Browser-Cache-Abnahme ist offen. Die Diagnose mit zehn Dokumenten zeigt
  weiter etwa 815–851 ms für warme Wechsel und wiederholtes Öffnen der IndexedDB.
  Der Hocuspocus-Verbindungsstart setzt `unsyncedChanges` auch ohne Texteingabe
  auf eins; dieser Zähler allein belegt keine lokale Inhaltsänderung. Die aktuelle
  Aufbewahrungsentscheidung schließt solche noch unbestätigten Verbindungen aus.
- Ein Timeout der ersten Neuladeprobe ist als falsche Testannahme eingegrenzt:
  Die URL forderte B, während die Probe auf A wartete. Die Browseraufnahme zeigt
  B mit korrektem Inhalt, `checkpointed_file`, null ausstehenden Änderungen und
  ohne Fehler. Expliziter Dokumentlink und Wiederherstellung des aktiven Tabs
  werden in der korrigierten Probe getrennt geprüft; deren Erfolg ist noch offen.
  Beleg: `tab-retention-diagnostic-2f85b-20261104-reload-triage.json`.

Die lokalen Ergebnisdateien liegen unter
`~/.local/state/canvas-local-team-seat/document-service-integration-artifacts/owned-linux-fixture-1793174893918/`.
Offen bleiben die unten geforderte vollständige Abnahmematrix am endgültigen
Produktstand, Cache-/Datenbankleistungsnachweise und Budgets sowie PR-Abschluss,
Release und Prüfung der fünf produktiven Workspaces. Review Center und Undo
werden dafür nicht erweitert.


Ergänzung vom 31.10.2026: Programmatischer Zugriff über REST und das installierte
Python-SDK gehört ausdrücklich zum Ziel. Die neuen, noch offenen Pakete 4a und
4b ergänzen eine benutzergebundene API-Key-Verwaltung und die vollständige
API-/SDK-Abnahme. Bisherige Session-/OAuth-Zugänge bleiben erhalten. Diese
Planergänzung stellt keine implementierte Schlüsselverwaltung, neue
SDK-Veröffentlichung oder bestandene Abnahme dar.

Ergänzung vom 01.11.2026: Browserseitige Dokumentinhalte, IndexedDB und Wechsel
zwischen Dokument-Tabs gehören als neues offenes Paket 4c zum Gesamtplan. Grundlage
ist die Prüfung der vorhandenen Ladewege und des vom Nutzer bereitgestellten
Obsidian-Beispiels. Das ist keine bereits umgesetzte Cache-Optimierung oder
gemessene Tabwechsel-Abnahme. Die bisherigen Pakete einschließlich REST, API-Key-
Verwaltung, SDK, Recovery und Release bleiben vollständig erhalten.

Die untersuchte Bündelung der eigenen Original-Move-Katalogprüfung wird nicht
übernommen. Beide Vorher-/Nachher-Fixtures mit 10 und 200 regulär angelegten
Dokumenten bestehen einschließlich Originaldaten-/Containererhalt. Die Variante
bestand außerdem 20 neue PostgreSQL-Fälle und drei vorhandene Suiten. Weniger
SQL-Aufrufe liefern hier jedoch keinen nachgewiesenen Laufzeit- oder
Ausleihengewinn und rechtfertigen die zusätzliche Snapshot-/Hash-Mechanik nicht.

| Warmer öffentlicher Rename bis Datei-Checkpoint | Basis SQL / Ausleihen | Variante SQL / Ausleihen | Gesamtdauer Basis → Variante |
| --- | ---: | ---: | ---: |
| 10 Dokumente | 4046 / 372 | 3810 / 375 | 29,740 → 29,918 s |
| 200 Dokumente | 19692 / 1220 | 18372 / 1237 | 89,837 → 89,849 s |

Das sind einzelne lokale Diagnosefenster, keine belastbare allgemeine
Regressionsschätzung. Die Laufzeitdatei und der Runner dieses Versuchs wurden
bytegleich auf `f9c34dfbb` zurückgestellt;
Versuchsdiff, neue versuchsspezifische Tests und tatsächliche Belege sind privat
erhalten. Der nächste Eingriff gilt den verschachtelten aktuellen Prüfketten
und den einzelnen Kollaborationsbeobachtungen; die Gesamtbudgets bleiben offen.

Die anschließende begrenzte Move-Gruppenprüfung ist lokal umgesetzt und gegen
PostgreSQL geprüft. Bereits materialisierte Belege eines benutzergeführten
Original Move verwenden den vorhandenen frischen Gruppenleser. Die Grenze von
acht Dokumenten, durchgehend gehaltene Owner-/Raumsperren und vollständige
aktuelle Prüfungen an den Gruppengrenzen bleiben erhalten. Unbelegte Ziele und
Agent-/MCP-Aufträge behalten den bisherigen Einzelpfad.

| Warmer öffentlicher Rename bis Datei-Checkpoint | Basis SQL / Ausleihen | Gruppenprüfung SQL / Ausleihen | Aufsummierte Datenbankzeit Basis → Gruppenprüfung |
| --- | ---: | ---: | ---: |
| 10 Dokumente | 4046 / 372 | 3835 / 373 | 5,112 → 4,823 s |
| 200 Dokumente | 19692 / 1220 | 14600 / 1080 | 48,681 → 34,529 s |

Die Gesamtdauer bei 200 Dokumenten bleibt bei rund 90 Sekunden. Die vier
Vergleichsfenster erhalten Originaldaten und laufende Container. 22 vorhandene
Owner-Fälle, verlorene erfolgreiche COMMIT-Antwort, 30 echte Job-Principal-Fälle,
MCP-Principal-Prüfung, elf öffentliche MCP-Gruppen und 47 kontrollierte Scheduler-
Familien bestehen. Drei neue echte Gruppenfehler erhalten Originaldaten und
`xmin`; explizite Wiederaufnahme, fehlender Beleg, die tatsächlich blockierte
parallele Kontosperre und unterbliebener automatischer Lese-Replay sind geprüft.
TypeScript und gezieltes Lint bestehen. Am Produktcommit `ce06019b8` bestehen
Host-/Linux-Produktionsbuild, gesunder Start, 15 Linux-Speicherfälle und neun echte
Browserfälle ohne Skips oder Retries. Originalzeilen mit `xmin`, Dateibytes und
Speicheranker sowie die elf anderen Container bleiben erhalten. Die
[gebundene Teilabnahme](architecture/document-service-move-proof-groups-2026-10-31.md)
ersetzt nicht die abschließende reguläre Gesamtsuite. Die anschließende
[getrennte Zeitmessung](architecture/document-service-move-stage-timing-2026-10-31.md)
besteht ebenfalls: Bei 200 warmen Dokumenten ist der Auftrag nach 61,926 Sekunden
fertig; die Datei-Projektion benötigt weitere 28,189 Sekunden. Bei zehn Dokumenten
sind es 6,339 plus 23,389 Sekunden. Der anschließende
[Weckpfad für die vorhandene Projektion](architecture/document-service-projection-wakeup-2026-10-31.md)
verwendet das tatsächliche Commit-Signal und behält den Wiederherstellungsscan.
Beide realen Vergleiche bestehen: warm insgesamt 29,728 → 8,845 Sekunden bei
zehn und 90,116 → 62,503 Sekunden bei 200 Dokumenten. Die Projektionswartezeit
bei 200 sinkt von 28,189 auf 0,271 Sekunden; der Auftrag selbst bleibt bei rund
62 Sekunden. Die gemessene Verbindungsspitze steigt im großen Fall von vier auf
sechs. 28 Worker-Fälle, bestehende Projektionssuiten, echte PostgreSQL-Signal- und
Kapazitätsfälle, TypeScript und Lint bestehen. Host-/Linux-Build und Browserabnahme
dieses Weckpfads bleiben noch offen;
weitere Performancepakete, API-Key-Verwaltung und vollständige API-/SDK-Abnahme
sind damit nicht abgeschlossen.

Der nächste [HTTP-Workspace-Schritt in Paket 2](architecture/document-service-http-initial-facts-2026-10-31.md)
bündelt die ersten fünf Workspace-/Einrichtungsabfragen in einer tatsächlichen
Abfrage. Bei zehn und 200 Dokumenten sinkt ein warmer HTTP-Abruf von 59 auf 55 SQL-
Aufrufe; die acht Ausleihen und Agent-/MCP-Kontrollen bleiben unverändert. Vier
bestehende PostgreSQL-Suiten, 34 neue Fälle und 15 Vergleichsfenster bestehen.
Am Produktcommit `6bb4d6ff6` bestehen außerdem Host-/Linux-Produktionsbuild,
gesunder Start, 15 Linux-Speicherfälle, neun echte Browserfälle ohne Skips/Retry
und alle sechs GitHub-Checks. Originaldaten und Dateianker sowie die elf übrigen
Container sind erhalten. Die abschließende CI-/Review-Prüfung erfolgt am
jeweiligen Head von [PR #194](https://github.com/canvascoding/canvas-notebook/pull/194).
Paket 2, die reguläre Gesamtsuite vor dem nächsten Produktionsdeploy und die
weiteren Paketabnahmen bleiben offen.

Ein erster kleiner [HTTP-Verbindungsschritt in Paket 2](architecture/document-service-request-source-connection-2026-10-30.md)
verwendet die tatsächliche Herkunftsverbindung für die folgende native
Lesetransaktion weiter. Fünf frische Fixtures mit 15 Messfenstern und sechs echte
PostgreSQL-Suiten bestehen. Bei zehn und 200 Dokumenten sinken warme HTTP-Ausleihen
von neun auf acht; SQL bleibt bei 59. Agent-/MCP-Kontrollen bleiben unverändert.
Host-/Linux-Produktbuild und gesunder Start am Produktstand `04332be41`, 15
Linux-Speicherfälle, reguläres `test:all` (331/0/269), neun zusätzliche echte
Browserfälle ohne Skips/Retry und alle sechs CI-Prüfungen bestehen. Beide
Live-Editoren, die widerrufene Sitzung und eine neue schreibgeschützte Sitzung
sind gegen den kompilierten Dokumentleser geprüft. Originaldaten und Dateianker
sowie die elf anderen Container bleiben erhalten. Dies ist noch keine
SQL-Bündelung oder Abnahme von Paket 2; weitere gemeinsame Fakten, selektive
Body-Lesungen, Schreibmechanik und abschließende Release-Gates bleiben offen.

Die [reguläre Linux-Gesamtsuite](architecture/document-service-regular-suite-2026-10-28.md)
ist inzwischen als Regressionstest-Grundlage bestanden (329/0/268, neun erfolgreiche
CI-Prüfungen am dokumentierten Teststand). Die Leistungsbudgets und die übrigen
Abnahmen der folgenden Pakete bleiben offen; dieser Meilenstein ist keine
Gesamtabnahme oder Produktionsfreigabe.

Der [mobile Speicherabschluss](architecture/document-service-mobile-completion-2026-10-29.md)
ist am gebauten Produktstand `32880bee0` gesondert geprüft: 15 echte PostgreSQL-
Testgruppen, Host-/Linux-Build, Start, neun CI-Prüfungen und alle sieben aktivierten
Recovery-/Linkfälle bestehen ohne Browser-Retries oder Skips. Ursprüngliche
Operationsbelege, Zeilen mit `xmin`, Dateibytes und Speicheranker bleiben erhalten.
Dies schließt den gefundenen Admission-Fehler; weitere strukturelle Bündelung und
sämtliche übrigen Pakete bleiben offen.

Die zusätzliche [NUMERIC-Wertabweichung](architecture/document-service-membership-scalars-2026-10-29.md)
ist am gebauten Stand `31fcf8aee` korrigiert. 24 echte PostgreSQL-Varianten, die
vorhandenen Agent-/MCP-Verbraucher, Host-/Linux-Build, Start, neun CI-Prüfungen und
drei bestehende Agent-/Mobil-Browserfälle bestehen. Reine Entscheidungen und der
gesperrte Leser bleiben bytegleich, Rohwerte und Originaldaten bleiben erhalten.
Die SQL-Anzahl dieses Lesers bleibt bei eins beziehungsweise drei; die Abnahme
ersetzt weder neue Leistungswerte noch einen Abschluss des Bündelungspakets.

Die [gemeinsame native Lesephase](architecture/document-service-native-read-phase-2026-10-29.md)
bündelt inzwischen frische Kontext-, Workspace-, Dokumentkopf- und Reservierungsdaten
und begrenzt ID-Joins vorab. Der tatsächliche Vergleich bei 10 und 200 Quellen senkt
warme HTTP-Lesefenster von 69 auf 59 SQL-Aufrufe, Agent von 109 auf 99 und MCP
von 84 auf 74; Ausleihen bleiben unverändert. Die fünf betroffenen PostgreSQL-Suiten
und der Vergleich mit begrenzter Antwortlatenz bestehen. Lokal ist ohne zusätzliche
Verzögerung kein wesentlicher allgemeiner Latenzgewinn nachgewiesen. Am gebauten
Produktstand `0e0884175` bestehen zusätzlich Host-/Linux-Build, Start, neun CI-
Prüfungen und vier aktuelle Browserfälle einschließlich echter Dokumentabrufe aus
zwei Live-Editoren und einer frischen Ansicht mit Leserechten. 15 Linux-Speicherfälle,
Originaldaten und die elf übrigen Container sind geprüft. Die Buildlaufzeit ist
höher; die Ursache bleibt zu untersuchen. Die Leistungsbudgets und übrigen Pakete
bleiben offen.

Die [inkrementelle Zielauflösung](architecture/document-link-resolution-projection-2026-10-30.md)
ist am kombinierten Produktstand `64532d709` einschließlich der MCP- und
Sicherheitsänderungen geprüft. Bei 200 warmen Quellen werden null Links neu
aufgelöst; eine einzelne Quellenänderung löst nur deren zwei Links neu auf.
102 gezielte Fälle, der echte PostgreSQL-/HTTP-Vergleich und zwölf zusätzliche
kodierte Zielfälle entsprechen dem vollständigen Neuaufbau. Host-/Linux-Build,
gesunder Start, 15 Linux-Speicherfälle, die reguläre Gesamtsuite (331/0/269) und
sieben Recovery-/Linkfälle plus HEIF bestehen ohne Browser-Retries. Originaldaten,
Speicheranker und die elf anderen laufenden Container sind erhalten. Die
SQL-Anzahl bleibt bei 36 / sieben Ausleihen; native Body-Lesungen, weitere
Faktenbündelung und sämtliche übrigen Paketabnahmen bleiben offen.

Die [Editor-Messung vor der genauen Verbindungsdiagnose](architecture/document-service-editor-current-baseline-2026-10-30.md)
am Produktstand `6302d6403` besteht mit zehn und 200 regulär angelegten Dokumenten.
Erstes Öffnen benötigt in diesem Lauf in beiden Größen 690 SQL-Aufrufe; die Prozessfenster enthalten
weiterhin erhebliche Hintergrundarbeit. Alle zehn SQL-Callsite-Zähler stimmen
exakt überein. Zwei zusätzliche echte Planproben der oft wiederholten Member-
Beobachtung zeigen hier mehr Planungs- als Ausführungszeit. Originaldaten und
alle laufenden Container bleiben erhalten. Das ist eine aktuelle Messgrundlage,
keine Produktoptimierung oder Abnahme der Leistungsbudgets.

Die [genaue Verbindungsdiagnose](architecture/document-service-physical-connections-2026-10-30.md)
erfasst jetzt bereite direkte und gepoolte Laufzeitverbindungen einschließlich
ruhender Clients; laufende Anmeldeversuche stehen separat. 14 echte PostgreSQL-
Kontrollfenster bestehen, auch kombiniert mit der vorhandenen SQL-Diagnose.
Produktcode, Originaldaten und laufende Container bleiben unverändert. Die
nachfolgenden aktuellen Lese-, Anlage-, Editor-, Backlink- und Pfadvergleiche
wenden diese Diagnose an. Die Leistungsbudgets sind damit nicht als erreicht erklärt.

Die [aktuelle Lese-Matrix](architecture/document-service-current-read-matrix-2026-10-30.md)
besteht mit HTTP, Hauptagent, Organisationsagent und MCP bei zehn und 200
Quellen in allen 24 Fenstern. Warme Reader benötigen 59 / 99 / 117 / 74 SQL-
Aufrufe; die genaue Diagnose misst zwei bis vier bereite Laufzeitverbindungen.
Alle SQL-Zähler stimmen exakt überein, Originaldaten bleiben erhalten. Die
nachfolgende vollständige Prozessmatrix ergänzt Anlage, Editor und Pfadoperationen.
Leistungsoptimierung und die übrigen Abnahmen bleiben offen.

Die [aktuelle Anlage im Standardmodus](architecture/document-service-current-create-default-2026-10-30.md)
besteht bei zehn Quellen in zwölf Fenstern für Hauptagent, Organisationsagent
und MCP. Der Messlauf erzwingt den früheren Schattenmodus nicht mehr; Version-
Center-Modus, Review Center und Undo sind ausgeschaltet. Warme Anlagen benötigen
1058 / 1220 / 675 SQL-Aufrufe bei maximal vier bereiten Verbindungen. Original-
Retries und sämtliche vorhandenen Quelldaten bleiben erhalten. Dies ist eine
korrekt abgegrenzte Default-Messung, keine Produktoptimierung. Die 200er-Anlagen
und übrigen aktuellen Prozessvergleiche sind in der folgenden Matrix enthalten;
die Leistungsbudgets bleiben offen.

Die [vollständige Prozessmatrix](architecture/document-service-current-operation-matrix-2026-10-30.md)
besteht mit zwölf getrennten Fixtures und 42 vollständig beobachteten Fenstern.
Alle Anlage-, Editor- und Rename-/Move-Vergleiche liegen bei zehn und 200 regulär
angelegten Dokumenten vor. Beim großen Umbenennen/Verschieben wachsen die
SQL-Aufrufe von etwa 4.050 auf etwa 19.700, während höchstens vier bereite
Laufzeitverbindungen bestehen. Die Stackbelege grenzen wiederholte Storage-,
Claim-, Current- und dokumentweise Quieszenzprüfungen als wesentliche Aufrufer ein.
Die weiterleitende Owner-Fassade ist dabei nicht allein eine Berechtigungsprüfung.

Die [gemeinsamen Dokument- und Linkverträge](architecture/document-service-shared-contracts-2026-10-30.md)
sind zusätzlich über die tatsächlichen HTTP-, registrierten Agenten- und MCP-Wege
geprüft: 20 Backlink-Fenster und je 26 Fenster mit Haupt- und Organisationsagent
bestehen. Die nativen Leseseiten sind gleich; Linkentscheidungen, Diagnosen und
die Wirkung einer MCP-Neuanlage entsprechen dem gemeinsamen Index. Warme Caches
verdecken keine inaktiven oder beschädigten Quellen. Backlinks benötigen bei zehn
und 200 Quellen warm weiterhin 36 SQL-Aufrufe, sieben Ausleihen und zwei bereite
Verbindungen. Die vollständige gezielte Typprüfung umfasst 5.140 Importdateien.
Originaldaten, Dateibytes und laufende Container bleiben erhalten; absichtliche
Fehler betreffen ausschließlich die eigene Test-Fixture und werden exakt behoben.

Damit sind Messbasis und vorhandene gemeinsame Leseverträge lokal nachgewiesen.
Die PR-/CI-/Review-Freigabe erfolgt auf dem endgültigen Commit des Pakets.
Die weitere Faktenbündelung,
Header-/Body-Lesungen, gemeinsamen Änderungspfade und endgültigen Leistungsgrenzen
sind damit nicht abgeschlossen.

## Priorität und Umsetzungspakete

Die Linkpflege ist eine zentrale Produktfunktion. Ein gemeinsamer Service bedeutet
hier gemeinsame Verträge und wiederverwendete Mechanik für alle Aufrufer; er
erfordert zunächst keinen weiteren laufenden Dienst. Der bestehende Dokumentleser,
die Quellenbeobachtung und die native Persistenz sind die Ausgangspunkte.

Die nächste Umsetzung folgt dieser Reihenfolge. Jedes Paket wird mit seinem
Abnahmekriterium abgeschlossen, bevor das abhängige Paket beginnt. Die bereits
vorhandenen Teiloptimierungen gelten nicht als Abnahme eines ganzen Pakets.

| Paket | Konkrete Änderung | Abnahme |
| --- | --- | --- |
| 0. Quellenfehler zuverlässig behandeln | Dokumentbezogene Ausfälle im lesenden Index eingrenzen; globale Autoritätsfehler weiterhin als solche behandeln. | Eine nachweislich einzelne fehlerhafte Quelle entfernt keine anderen geprüften Dokumente. Diagnose nennt die Quelle; nach Wiederherstellung verschwindet sie. Schreibprüfungen bleiben streng. |
| 1. Messung und Verträge vervollständigen | Editor einschließlich Zutritt und Projektion, Agent, MCP sowie öffentliche Rename-/Move-Abläufe mit derselben Instrumentierung messen. | Vergleichbare Berichte für kalt/warm und kleine/größere Workspaces; direkte Owner-Verbindungen sind enthalten; dominante Abfragegruppen stehen fest. |
| 2. Datenbankzugriffe bündeln | Aktuelle Berechtigungs-, Registry- und Zustandsdaten pro notwendiger Phase gemeinsam lesen und dieselbe Verbindung verwenden. | Weniger Abfragen und Pool-Ausleihen; echte Widerrufs-, Seat-, Realm- und Parallelitätstests bestehen unverändert. |
| 3. Linkprojektion inkrementell machen | Versionierte Extraktion je Dokument und gezielte Neuauflösung abhängiger Ziele; vollständigen Neuaufbau erhalten. | Ein Save inspiziert nur die geänderte Quelle. Rename, Move, Titel, Aliase und neue Ziele korrigieren alle betroffenen Links. Ergebnisse entsprechen dem Neuaufbau. |
| 4. Schreibwege vereinheitlichen | Bestehende Speicherung, Versionsprüfung und dauerhafte Belege hinter kleinen gemeinsamen Operationen verwenden; Aufrufer einzeln umstellen. | Editor, Agent, MCP, REST und SDK liefern für dieselbe freigegebene Operation gleiche Speicher- und Linkergebnisse. Gleichzeitige Änderungen, Wiederholungen und Abbruch verlieren keine Daten. |
| 4a. API-Key-Verwaltung ergänzen (in Umsetzung) | Benutzergebundene Schlüssel mit Workspace-/Aktionsrechten, Ablauf, Rotation und Widerruf verwalten; REST und SDK über denselben aktuellen Berechtigungsdienst anbinden. | Ein regulär ausgestellter Schlüssel funktioniert ohne Browsersitzung ausschließlich im freigegebenen Umfang; gesperrte oder abgelaufene Zugänge werden zuverlässig abgewiesen. |
| 4b. API und SDK vollständig abnehmen (in Umsetzung) | Gemeinsame Funktions-/Rechtematrix gegen echte HTTP-Endpunkte und ein frisch installiertes SDK ausführen; Schlüssel-, Session- und OAuth-Zugänge getrennt prüfen. | Alle ausgewiesenen Funktionen sowie Konflikt-, Recovery-, Widerrufs-, Neustart- und Leistungsfälle bestehen am selben gebauten Produktstand; öffentliche Beispiele sind ausführbar. |
| 4c. Browser-Dokumentcache und Tabwechsel verbessern (offen) | Vorhandenen Yjs-/IndexedDB-Speicher und Dokumentleser weiterverwenden; begrenzte RAM-Lebensdauer, aktuelle Autorisierung und Wiederherstellung getrennt behandeln. | Kaltes Öffnen, A→B→A, Speicherverdrängung und Browser-Neuladen sind gemessen; warme Wechsel vermeiden unnötige Inhaltsübertragung und doppelte Initialisierung, ohne Rechte- oder Datenverlust. |
| 5. Einführung absichern | Endgültige Leistungsbudgets, reguläre Gesamtsuite, vollständige API-/SDK-Abnahme, Desktop/Mobil, PR/CI/Reviews, Backup-/Restore-Nachweis und kontrolliertes Release. | Alle tatsächlich umgestellten Abläufe sind nachgewiesen; nach Deployment funktionieren Filetree, Öffnen, Speichern, Linkpflege und freigegebene API-/SDK-Zugänge in allen fünf Workspaces. |

### Verbindliche Planführung

Diese Datei ist der vollständige gemeinsame Arbeitsplan. Die planführende Session
`01a172a1-5e99-7722-a401-028e9e0323ad` führt die bestehenden und ergänzten Pakete
hier weiter aus und arbeitet sie anhand ihrer Abnahmekriterien ab. Einzelne
Prüfberichte ergänzen diesen Plan; eine Chat-Nachricht ersetzt ihn nicht.

Vor dem nächsten Paketabschluss den tatsächlichen Stand pro Paket als offen,
in Umsetzung oder abgenommen mit dem nächsten konkreten Schritt festhalten.
Eine Abnahme nennt den Produktcommit, die tatsächlich geprüften Aufrufer,
Messgrenzen und Ergebnisbelege. Historische Teilerfolge bleiben sichtbar und
werden nicht als neue Gesamtabnahme ausgegeben. Fehlende Browser-Messwerte sind
zunächst zu erheben und werden nicht aus statischem Code oder Obsidian abgeleitet.

Den laufenden Arbeitsschritt zuerst abschließen. Paket 4c wird nach seinen
gemeinsamen Lese-/Speichervoraussetzungen vor der abschließenden Einführung
abgenommen. Bereits laufende API-/SDK-Arbeit wird durch die Ergänzung nicht
verworfen. Erforderliche Prüfungen folgen den tatsächlich geänderten Abläufen;
Review Center und Undo werden weiterhin nicht ausgebaut.

Historische Paketübersicht vom 02.11.2026; aktueller Status siehe oben. Die jeweils geprüften Produktstände und Teilbelege
stehen in den zugehörigen Abschnitten:

| Paket | Status | Nächster konkreter Nachweis |
| --- | --- | --- |
| 0 | in Umsetzung | Quellen-/Recovery-Fälle am endgültigen gebauten Produktstand und nach Einführung bestätigen. Die lokalen Belege stehen unten. |
| 1 | in Umsetzung | Die vollständigen neuen REST-/SDK- und Browser-Aufrufer in die vergleichbare 10-/200-Quellen-Messung aufnehmen. |
| 2 | in Umsetzung | Verbleibende dominante Abfrageketten nach den unten dokumentierten Teiloptimierungen messen und gezielt bündeln. |
| 3 | in Umsetzung | Tatsächlich umgestellte Aufrufer gegen vollständigen Link-Neuaufbau und die abschließenden Leistungsbudgets prüfen. |
| 4 | in Umsetzung | Die implementierten API-Key-Schreib-/Job-Ursprünge und Originalimporte über die gemeinsamen Speicherkerne abschließend auf Transport-/Linkparität prüfen. Die native CI und installierten SDK-Familien bestehen; dies ersetzt noch keine ganze kompilierte Matrix. |
| 4a | in Umsetzung | Am gebauten Stand `871a0ef43` bestehen alle vier Schlüsselverwaltungs-Browserfälle und der vollständige echte OAuth-/Keychain-Lauf einschließlich natürlichem Tokenablauf, Refresh und historischer Status-/Recovery-Zugriffe. Alle 13 CI-Prüfungen sind grün. Die übrige Rechte-/Unterbrechungs-/Dateimatrix und die portable Restore-Abnahme bleiben offen. Alle geforderten Adapter sind implementiert, siehe 5a. |
| 4b | in Umsetzung | `main` mit PR #201 ist unter Erhalt unserer Projektionssperren integriert. `871a0ef43` besteht den echten OAuth-/Editor-/Pfadablauf und beide REST-/SDK-Operationsprofile. `2a4aded19` besteht beide Builds, Start und alle 13 CI-Prüfungen. `test:all` ist mit drei exakt gebundenen Testdatei-Korrekturen am selben Produktstand grün: 331 bestanden, 0 fehlgeschlagen, 269 bestehende bedingte Skips. Originale samt `xmin`, Dateibytes und Autoritätsmarkern bleiben unverändert. Der rohe Kalt-Klon belegt Start und Lesen; unterstützte Schreib-Wiederherstellung, übrige API-/SDK-Matrix, vollständige Leistungsabnahme und Beispiele bleiben offen. |
| 4c | offen | Zunächst die in 5c benannten kalten und warmen Browserabläufe messen; Cache-Lebensdauer erst danach festlegen. |
| 5 | offen | Nach vollständigen Nachweisen Gesamtsuite, PR/CI/Reviews und kontrolliertes Release mit Deployment-Verifikation durchführen. |

Paket 0 adressiert einen konkret reproduzierten Fehler: Im isolierten UI-/API-Test führte ein
gezielt erzeugter Katalog-/Native-Zustandskonflikt bei `unavailable.md` zu null
Indexdokumenten und einer globalen Diagnose, obwohl andere Quellen lesbar waren.
Die originale Testquelle wurde feld- und bytegenau wiederhergestellt; der reale
Index lieferte danach wieder sechs Dokumente und drei Backlinks zum Testziel.
Die Korrektur ist lokal umgesetzt und mit einem echten PostgreSQL-Vergleich sowie
der gebauten Desktop-/Mobiloberfläche geprüft: Inaktive Zustände und beschädigte
native Bytes lassen die übrigen geprüften Dokumente verfügbar. Ein globaler
Organisationskonflikt verwirft weiterhin den ganzen Index; der Standardleser für
Mutationseingänge bleibt streng. Der [Prüfbericht](architecture/document-link-source-isolation-2026-10-26.md)
beschreibt die Abnahme einschließlich der feld- und bytegenauen Wiederherstellung.

Die gewünschte öffentliche Wirkung ist einheitlich: Ein erfolgreicher Save bestätigt
den gespeicherten nativen Stand; der abgeleitete Linkstand darf diesen nicht
überschreiben. Ein echter Versionskonflikt bleibt ein nachvollziehbarer Konflikt.
Wiederholungen dürfen anhand desselben dauerhaften Operationsbelegs fortsetzen,
statt eine Dokumentanlage oder Inhaltsänderung doppelt auszuführen.

## Befund und Ausgangszustand

- Der aktuelle Leser ist `app/lib/markdown/workspace-document-link-index.ts`.
  Die HTTP-Route und das Agentenwerkzeug für Dokumentbeziehungen verwenden ihn.
  Er beobachtet die Quellen über `workspace-source-authority-stage.ts`.
- Dateioperationen verwenden diese Quellengrundlage mit einer strengeren Prüfung.
  Native Linkänderungen werden über
  `app/lib/markdown/native-link-mutation-persistence.ts` gespeichert. Dort bestehen
  bereits Versionsprüfungen, Konflikterkennung und dauerhafte Änderungsbelege.
- Ein alter physischer Index/Umbenennungshelfer existiert ebenfalls. Die aktuelle
  Suche findet keine Produktaufrufer seiner exportierten Hauptfunktionen. Vor
  Entfernung müssen indirekte Aufrufer, Tests und Integrationen geprüft werden.
- Eine kleine neue Markdown-Datei verursachte im isolierten PostgreSQL-18-Test
  15.445 SQL-Anweisungen, davon 7.548 in einer Publikationstransaktion. Diese dauerte
  lokal 3,37 Sekunden. Kleine zusätzliche Antwortlatenz reproduzierte den Ablauf
  des Principals nach fünf Sekunden. In Produktion wurde auch ein PostgreSQL-
  Transaktions-Timeout protokolliert. Diese Messung gilt für die Agenten-Neuanlage;
  andere Abläufe brauchen eigene Messungen.
- Die erste lokale Optimierung reduzierte die größte Transaktion im verschachtelten
  Test auf 3.089 Anweisungen. Im danach vergleichbar gemessenen Create-Engine sank
  die SQL-Anzahl durch gebündelte Leser von 8.480 auf aktuell 6.452; davon liegen
  4.122 weiterhin in 229 Berechtigungsprüfungen. Die größte Transaktion dieses
  Messbereichs benötigt 2.337 Anweisungen. Das ursprüngliche vollständige Szenario
  mit 15.445 Anweisungen hat eine andere Messgrenze und ist damit nicht direkt
  vergleichbar. Die Zielbudgets sind weiterhin nicht erreicht.
  Die zwölf tatsächlichen PostgreSQL-Testgruppen für Agenten-Neuanlagen und die
  21 Fälle des gemeinsamen Dokumentlesers sind inzwischen erfolgreich. Ein zuvor
  beobachteter unerwarteter Netzwerkaufruf trat in den abschließenden Läufen nicht
  auf; die strenge Prüfung bleibt bestehen. Diese Teilergebnisse ersetzen weder
  die reguläre Gesamtsuite noch die Abnahme der nachstehenden Architektur.
- Der gemeinsame Dokumentleser besteht bereits in `app/lib/documents/service.ts`.
  Der Quellenleser lädt native Zustände bereits gebündelt mit zwei SQL-Abfragen
  je Prüfdurchlauf. Daher vorhandene Schnittstellen weiterentwickeln und die
  verbleibenden Wiederholungen messen, statt einen zusätzlichen Service daneben
  aufzubauen. Der normale Editor-Speicherpfad muss gesondert erfasst werden.

## Aktueller Messstand und verbleibende Bündelung

Die [frische spätere Agentenrechte-Beobachtung](architecture/document-service-agent-access-phase-2026-10-29.md)
reduziert die tatsächliche Organisations-Agent-Anlage bei 10 und 200 regulären
Quellen von 1790 auf 1220 SQL-Treiberaufrufe; die 34 Ausleihen bleiben erhalten.
Der Original-Retry sinkt von 264 auf 194 Aufrufe bei sieben Ausleihen. Hauptagent
und MCP bleiben im 10-Quellen-Kontrolllauf bei 1058 / 34 beziehungsweise 702 / 29.
Die vollständige registrierte Anlage wird bei identischen 2 ms zusätzlicher
echter PostgreSQL-Antwortlatenz im Median von 7044,345 auf 5247,92 ms schneller.
72 neue Rechte-/Datenerhaltfälle bestehen vor und nach der Änderung, einschließlich
echtem Widerruf nach der frühen Scope-Antwort. Die gebündelte Abfrage bleibt an
der späteren tatsächlichen Rechtegrenze; Original-Origin-, native/Owner- und
COMMIT-Prüfungen bleiben erhalten. Zwölf gezielte Suiten, Typprüfung
und Lint bestehen. Am Produktstand `c8dde1074` bestehen zusätzlich vollständiger
Host-/Linux-Build, gleicher Datenbestand beim Neustart, alle neun CI-Prüfungen,
15 Linux-Speicherfälle und vier Browserfälle mit ausgeschaltetem Review Center.
Originaldaten und Speicheranker sowie die elf übrigen Container sind erhalten.
Die Gesamtbudgets und übrigen Pakete sind weiterhin offen.

Die [Nachmessung mit einem normalen Organisations-Agenten](architecture/document-service-configured-agent-baseline-2026-10-29.md)
am unveränderten Produktstand `0e088417588b780ccc3ea24e36e9c3c0eb63869b` ergänzt
die bisher vorwiegend am eingebauten Hauptagenten gemessene Anlage. Sie benötigt
bei 10 und 200 regulär angelegten Quellen identisch 1790 SQL-Treiberaufrufe / 34
Ausleihen pro warmer Neuanlage; Hauptagent und MCP liegen im wiederholten
10-Quellen-Vergleich weiterhin bei 1058 / 34 beziehungsweise 702 / 29. Die
zusätzlichen 732 Anweisungen stammen aus der wiederholten tatsächlichen Agenten-
Zugriffskette. Die Test-Fixture kann diesen eingeschränkten Agenten nun über die
normale Profil-Factory und gespeicherte Mitgliedschaft erzeugen; ihre bisherige
Voreinstellung bleibt erhalten. Originaldaten und Belege, Ressourcenfreigabe,
Typprüfung, Lint sowie die vorhandenen Read-/Edit-/Search-Suiten sind geprüft.
Das ist eine erweiterte Messbasis, keine neue Produktoptimierung oder Abnahme
der Leistungsbudgets. Die nächste Bündelung muss diese normale Zugriffskette
einschließen und die frischen Prüfungen an späteren I/O-Grenzen erhalten.

Der [aktuelle Create-Vergleich](architecture/document-service-create-matrix-current-2026-10-27.md)
am Produktstand `0a40365484806ea83d1e906d99406ff1445bde6b` besteht in allen 16 Fenstern
für Agent/MCP mit jeweils 10 und 200 regulär angelegten Quellen. Die warme
Agentenanlage benötigt 2.180 SQL-Treiberaufrufe / 46 Ausleihen, MCP 2.597 / 37;
die ursprüngliche Wiederholung 180 / 7 beziehungsweise 129 / 12. Identitäten,
Originalinhalt und vorherige Registry-/Lineage-/Native-/Metadatenzeilen/xmin sowie
physische Bytes bleiben geprüft; alle eigenen Ressourcen schließen vollständig.
Diese Werte sind innerhalb der jeweils gleichen Messgrenze vergleichbar.

Das ist ein abgeschlossener Messnachweis für Create, keine Abnahme von Paket 2
oder des Gesamtplans. Die [gemeinsame Member-Prüfung](architecture/document-service-member-current-2026-10-27.md)
liest aktuelle Sitzungs-, Konto-, Seat-, Workspace- und Kontextdaten inzwischen
in zwei statt acht frischen SQL-Aufrufen. Der tatsächliche 10-Quellen-Vergleich
reduziert warmes HTTP-Öffnen von 100 auf 88 Aufrufe und ein Editor-Leerlauffenster
von 1390 auf 1176; MCP-Neuanlage bleibt bei 2597. Die übrige gemeinsame Fakten-,
Registry- und Zustandsbündelung sowie abschließende Größen-/Latenzvergleiche
bleiben offen. Die [MCP-Faktenbündelung](architecture/document-service-mcp-slot-snapshot-2026-10-27.md)
reduziert inzwischen dessen aktuelle Slot-Prüfung von sechs auf drei Aufrufe;
mit tatsächlicher SQL-Planwiederverwendung sinkt warme MCP-Neuanlage bei zehn und
200 Quellen auf 1976 / 37. Die anschließend nachgewiesene NUMERIC-/JSON-
Abweichung ist nun mit [gemeinsamer exakter Wertübertragung](architecture/document-service-scalar-snapshots-2026-10-27.md)
auch in den Benutzer- und Agent-Create-Lesern lokal korrigiert. Agentenprofil- und
Sitzungsprüffelder verwenden dieselbe Mechanik; bestehende reine
Berechtigungsentscheidungen bleiben erhalten. Die Create-Budgets von wenigen Hundert Aufrufen, gemeinsame
Verträge, inkrementelle Links, normale gemeinsame Schreibwege und alle finalen
Recovery-/Build-/UI-/Suite-/Release-Gates bleiben erforderlich.

Die [gemeinsame Speicheraufruf-Phase für Agent und MCP](architecture/document-service-mcp-storage-phase-2026-10-27.md)
verwendet nun auch im MCP die vorhandene Transaktion bis zum Ende eines vollständigen
Helferaufrufs einschließlich seiner Bestätigungen. Die getrennten Aufrufe bleiben
frisch autorisiert; bestehende native Publikationsphasen behalten ihre Verbindung.
Der direkte Zehn-Quellen-Vergleich senkt warme MCP-Neuanlage weiter von 1976 / 37
auf 1871 / 33. Echte Sperren an ACKs, Rechteverlust vor der nächsten Phase und
verlustfreie explizite Wiederaufnahme nach zwei tatsächlichen COMMIT-Antwortverlusten
sind geprüft. Weitere Current-/Resolver- und Registry-/Zustandsbündelung bleibt nötig.

Die [zugeordneten Publikationsprüfungen](architecture/document-service-publication-boundaries-2026-10-27.md)
zeigen die dominanten Wiederholungen in MCP-Rechte-/Schema-, Lifecycle-Owner- und
Dokumentzustandslesern. Doppelte benachbarte Vollprüfungen sind innerhalb der
vorhandenen echten Phase entfernt; jede tatsächliche Publikationsgrenze behält
ihre vollständige native Prüfung. Der direkte Zehn-Quellen-Vergleich reduziert
warme MCP-Anlage von 1871 / 33 auf 1556 / 33 und
Agentenanlage von 2180 / 46 auf 2143 / 46.
Echte native Versionsrennen verweigern die Publikation; explizite Wiederholungen
erhalten Originalidentitäten und vollständige Bytes. Weitere Bündelung und alle
übrigen Abnahmen des Gesamtplans bleiben offen.

Die [gemeinsame frische native Beobachtung](architecture/document-service-native-observation-2026-10-27.md)
bündelt Receipt, Registry/Lineage-Beleg und nativen Zustand nach den unveränderten
strengen Katalogprüfungen. Am tatsächlichen Publikations-ACK sinken die betreffenden
Dokumentabfragen von sieben auf drei; sechs reale Zustandsfehler verweigern die
Publikation und explizite Wiederholungen erhalten Original-IDs und Bytes.
Der direkte Zehn-Quellen-Vergleich reduziert warme MCP-Anlage von
1556 / 33 auf 1404 / 33 und Agentenanlage von
2143 / 46 auf 1991 / 46. Die bisherigen
Validatoren bleiben gemeinsam verwendet. Weitere Bündelung und die übrigen
Abnahmen des Gesamtplans bleiben offen.

Die [gemeinsamen Owner-Fakten](architecture/document-service-owner-facts-2026-10-27.md)
lesen Verbindung, exklusive Sperre und Workspace-Zuordnung in einer frischen echten
Beobachtung. Die feste MCP-Quellenprüfung ersetzt nur ihre eigene doppelte
Owner-Lesung; Agenten behalten ihre separate Prüfung. Zwei reale Owner-Unlocks und
zwei Owner-Schemawechsel vor Veröffentlichung werden ohne Datenverlust abgewiesen;
explizite Wiederholungen behalten Original-ID und Inhalt. Der direkte Vergleich mit
zehn Quellen reduziert warme MCP-Anlage von 1404 / 33 auf
1312 / 33 und Agentenanlage von 1991 / 46 auf
1931 / 46. Weitere Bündelung und sämtliche übrigen Abnahmen des
Gesamtplans bleiben offen.

Die [frische Agentenprofil- und Rechtebeobachtung](architecture/document-service-agent-policy-profile-2026-10-28.md)
bündelt nun das vollständige Policy-Profil mit der bestehenden abschließenden
Workspace-/Verbindungskontextbeobachtung. Im direkten Zehn-Quellen-Vergleich sinkt
warme Agentenanlage von 1919 / 46 auf 1735 / 46 SQL-Aufrufe / Ausleihen;
15 neue Testgruppen und 29 bestehende PostgreSQL-Suiten bestehen. Die aktuelle
Beobachtung vor und nach der Policy-Entscheidung bleibt erhalten. Die
Leistungsbudgets und sämtliche übrigen Abnahmen bleiben offen.

Die [gemeinsame frische Bereichs-/Anlagebeleg-Beobachtung](architecture/document-service-birth-realm-observation-2026-10-28.md)
bündelt die beiden benachbarten Abfragen auf derselben gehaltenen Verbindung.
Zwölf neue echte Fälle, darunter zehn tatsächliche Fehleränderungen, und neun
bestehende PostgreSQL-Suiten bestehen. Der direkte Vergleich mit zehn regulär
angelegten Quellen spart je Neuanlage 40 Aufrufe: warm Agent 1735 → 1695 / 46
Ausleihen und MCP 1312 → 1272 / 33. Originalbelege und Wiederholungen bleiben
erhalten; die Budgets und übrigen Pakete bleiben offen.

Der [echte private Verifikationseintritt](architecture/document-service-verification-entry-2026-10-28.md)
verwendet innerhalb der bereits gehaltenen Publikationsphase deren bestehenden
Kontext; der vollständige frische Verifikationsausgang und sämtliche Schreib-/
Publikationsgrenzen bleiben erhalten. Acht neue reale Fälle und zehn bestehende
PostgreSQL-Suiten bestehen. Der direkte Zehn-Quellen-Vergleich senkt warm Agent
1695 → 1599 / 46 Ausleihen und MCP 1272 → 1192 / 33. Aufrufer können diesen Weg
nicht über Stage-Strings oder Eingabekopien auswählen. Die Gesamtbudgets und
übrigen Pakete bleiben offen.

Die [rein lesende private Belegverifikation](architecture/document-service-readonly-birth-verification-2026-10-28.md)
ist als Voraussetzung der strukturellen Phasenbündelung geprüft: Verifizieren
initialisiert oder repariert keine Stores, Anker oder Claims mehr. Alle sechs
bisherigen und neun neuen tatsächlichen IO-Fälle bestehen auf macOS und Linux;
acht PostgreSQL-Suiten erhalten Originaldaten und Wiederaufnahme. SQL-Phasen und
Rechteprüfungen sind an diesem vorbereitenden Schritt noch nicht entfernt.

Die [historische Verifikation ohne eigene SQL-Phase](architecture/document-service-readonly-sql-phase-2026-10-28.md)
entfernt nun die zusätzliche Principal-Transaktion zwischen nativer Anlage und
erster Veröffentlichung. Die abschließende aktuelle Bestätigung nach COMMIT
behält ausdrücklich einen neuen echten Principal. Sechs tatsächliche Agent-/MCP-
Kontrollen/Widerrufe, zehn PostgreSQL-Suiten und TypeScript/Lint bestehen.
Vier frische Zehn-Quellen-Fixtures schließen 16 Vergleichsfenster: warm Agent
1599 → 1523 SQL / 46 → 43 Ausleihen, MCP 1192 → 1152 / 33 → 32. Ursprüngliche
Wiederholungen bleiben gleich. Die Budgets und übrigen Pakete bleiben offen.

Die [Prüfungen an Schreib- und Ergebnisgrenzen](architecture/document-service-write-boundaries-2026-10-28.md)
ersetzen nun die nochmals verschachtelten Rechteprüfungen innerhalb reiner
Dateiverifikation durch den tatsächlichen aktuellen Nachweis nach dem Lesen und
vor nativer DML oder Ergebnisbestätigung. Die vollständige native Prüfung nach
der letzten Publikationsverifikation bleibt erhalten. Neun gezielte echte Fälle,
zwölf PostgreSQL-Suiten und Typ-/Lint-Prüfungen bestehen. Vier frische Fixtures
schließen 16 Fenster: warm Agent 1523 → 1347 SQL / 43 Ausleihen, MCP 1152 → 973 / 32.
Ursprüngliche Wiederholungen und Ausleihen bleiben unverändert. Die Gesamtbudgets,
übrigen Servicepakete und finalen Release-Gates sind weiterhin offen.

Die [gemeinsame tatsächliche Abschlussphase](architecture/document-service-close-phase-2026-10-29.md)
fasst finale Verifikation, beide Deskriptor-Schließungen und die abschließenden
Quellen-/Namensraumprüfungen unter einem frischen Principal bis nach dem Close
zusammen. Verweigerter Eintritt schließt die Deskriptoren weiterhin; Fehler oder
verlorene Close-Antwort liefern keinen Erfolg. Acht neue tatsächliche Fälle,
dreizehn PostgreSQL-Suiten und Typ-/Lint-Prüfungen bestehen. Vier frische Fixtures
schließen 16 Fenster: warm Agent 1347 → 1219 SQL / 43 → 37 Ausleihen,
MCP 973 → 919 / 32 → 30. Originalwiederholungen bleiben gleich. Gesamtbudgets,
übrige Servicepakete und alle finalen Release-Gates bleiben weiterhin offen.

Die [Zuordnung tatsächlicher SQL-Aufrufe zu Pool-Ausleihen](architecture/document-service-lease-attribution-2026-10-29.md)
lokalisiert die verbleibenden Blöcke ohne zusätzliche SQL-Anweisungen. In beiden
warmen Fenstern sind alle 1219 Agent- beziehungsweise 919 MCP-Anweisungen ihren
tatsächlichen Ausleihen zugeordnet. Die größten Publikationsverbindungen enthalten
332 beziehungsweise 288 Aufrufe; die separate Absicherung des Dateivorgangs
159 beziehungsweise 220. Das begründet die nächste Bündelung innerhalb dieser
Phasen, ist selbst aber keine Leistungseinsparung oder Paketabnahme.

Die [internen Dateisystem-Bestätigungen](architecture/document-service-private-acks-2026-10-29.md)
verwenden jetzt die tatsächlich gehaltene Publikationsphase, ohne an privaten
ACKs vollständige Rechte-/Native-Leser zu wiederholen. Helfereintritt, wirklicher
Link und Abschluss behalten die frischen vollständigen Prüfungen. Ein dabei
reproduzierter Agent-Wiederaufnahmefehler ist ebenfalls korrigiert: Der zentrale
Dienst darf die originale Anlage prüfen, bevor die allgemeine Hardlink-Sperre
eine beabsichtigte private Sicherung blockiert; gewöhnliche Hardlinks bleiben
gesperrt. Zehn neue Kontroll-/Fehlerfälle, 15 PostgreSQL-Suiten und Typ-/Lint-Prüfungen
bestehen. Vier frische Fixtures / 16 Fenster reduzieren warme Agent-Neuanlage von
1219 auf 1159 SQL und MCP von 919 auf 869; Ausleihen und Originalwiederholungen
bleiben gleich. Die endgültigen Budgets, übrigen Pakete und Release-Gates bleiben offen.

Die [private Eintrittsbindung](architecture/document-service-entry-binding-2026-10-29.md)
entfernt nun eine vollständige zusätzliche Principal-Transaktion vor den rein
lesenden Root-Opens. Der tatsächlich schreibende Helfer erhält weiterhin einen
eigenen frischen Principal und die vollständige Prüfung vor jeder ersten Wirkung.
Sechs neue echte Kontrollen/Sperrfälle und alle 15 gezielten PostgreSQL-Suiten
bestehen; bestehende Sonden bleiben unverändert. Vier frische Fixtures / 16 Fenster
senken warme Agent-Neuanlage von 1159 / 37 auf 1090 SQL / 34 Ausleihen und MCP von
869 / 30 auf 836 / 29. Originalwiederholungen bleiben gleich. Typprüfung und Lint
bestehen. Laufzeiten bleiben Diagnosewerte; die endgültigen Budgets, übrigen
Pakete und alle finalen Release-Gates bleiben weiterhin offen.

Die [Quellen- und Owner-Grenzen](architecture/document-service-source-owner-boundaries-2026-10-29.md)
trennen nun den MCP-Quellenbeleg von den ausdrücklichen frischen Owner-Prüfungen
seiner Koordinatoren. Nur tatsächliche private Leseverifikation entfernt den
doppelten äußeren Owner-Leser; vor gewöhnlichen Helfern und beim Abschluss bleibt
die späte Prüfung nach asynchroner B-Autorisierung bestehen. Vier neue echte
Kontrollen/Lockverluste, alle 17 gezielten PostgreSQL-Suiten und Typ-/Lint-Prüfungen
bestehen. Vier frische Fixtures / 16 Fenster reduzieren warm Agent von 1090 auf
1058 SQL / 34 Ausleihen und MCP von 836 auf 753 / 29. Originalwiederholungen bleiben
gleich; bestehende Sonden werden nicht geändert. Gesamtbudgets, übrige Pakete
und sämtliche finalen Release-Gates bleiben offen.

Die [tatsächlichen MCP-Verbrauchergrenzen](architecture/document-service-mcp-consumer-boundaries-2026-10-29.md)
verwenden die frischen Eintritts-/Ausgangsprüfungen des echten umschließenden
Principals. Der zusätzliche private Wrapper vergleicht dort nur seine identischen
ursprünglichen Daten; tatsächliche IO-/Native-Grenzen behalten die volle aktuelle
Prüfung. Drei neue reale Eintritts-/Ausgangsfälle, 24 Settings-IO-Fälle und alle 25
gezielten PostgreSQL-Suiten bestehen. Eine veraltete Copy-Testannahme zum früheren
Native-Opt-in ist am dauerhaft aktivierten Produktvertrag ausgerichtet; ursprüngliche
Recover-Belege und Daten bleiben geprüft. Vier frische Fixtures / 16 Fenster senken
warm MCP von 753 auf 702 SQL / 29 Ausleihen und dessen Originalwiederholung von
102 auf 91 / 12. Agent bleibt als Kontrolle bei 1058 / 34 beziehungsweise 168 / 7.
Typprüfung, Lint und tatsächliche Ressourcenfreigabe bestehen. Gesamtbudgets,
abschließende Standardsettings-/Latenz-/Größenabnahme, übrige Pakete und alle
finalen Release-Gates bleiben offen.

Die [Bewertung gebündelter Principal-Zeilensperren](architecture/document-service-principal-lock-batching-evaluation-2026-10-29.md)
verwirft eine zusätzliche Produktvariante: 44 gezielte PostgreSQL-Suiten und sechs
Vorher-/Nachher-Fixtures bestanden, doch die SQL-Ersparnis von rund drei Prozent
bei Agent-Neuanlagen brachte keinen belegten lokalen Laufzeitgewinn. Die
Laufzeitdateien sind bytegleich wiederhergestellt; vier echte Regressionen für
kombinierte Daten-/Sperrfehler bleiben erhalten. Der nächste strukturelle
Schwerpunkt liegt auf wiederholten Kontextaufbauten beim normalen Dokumentöffnen.
Budgets, übrige Pakete und Release-Gates bleiben vollständig offen.

Die [interaktive Link-Nachladung](architecture/document-service-interactive-link-refresh-2026-10-28.md)
behandelt zusätzlich einen belegten Client-Wartezustand: Direkte Vorschau und
Navigation warten nach Invalidierung nicht mehr auf die lokale Zehn-Sekunden-
Hintergrundfrist. Ein gemeinsamer Abruf, aktuelle Invalidierungsgrenzen und echte
Server-Wartefristen bleiben erhalten. Die kontrollierten Client- und bestehenden
Hintergrundtests, vollständiger Host-/Linux-Build und echter Containerstart
bestehen. Am Produkt- und Teststand `193685510b` bestehen alle sieben gezielten
Browserfälle einschließlich aktivierter Recovery-Prüfungen ohne Retries, Skips
oder Flakes. Die endgültige Gesamtsuite, aktuellen CI-Gates und die übrigen
Pakete bleiben offen.

## Zielaufbau

Editor / Agent / MCP / REST / Python-SDK / Systemauftrag
→ jeweilige echte Authentifizierung und eng begrenzter Adapter
→ gemeinsamer Dokument- und Linkservice
→ aktuelle Berechtigungs- und Dokumentbeobachtung
→ vorhandene native Speicherung mit Versionsprüfung und Änderungsbeleg
→ abgeleitete Linkprojektion und gezielte Benachrichtigung.

Der Dienst bekommt getrennte, kleine Verantwortlichkeiten: aktuelle Daten lesen,
Links extrahieren und auflösen, eine Änderung vorbereiten, eine autorisierte
Änderung speichern und eine abgeleitete Projektion aktualisieren. Die Namen der
konkreten Schnittstellen werden bei Umsetzung festgelegt. Kein neuer großer
Controller und keine zweite Dokument-Wahrheit.

## Detaillierte Anforderungen und Abnahmekriterien

Die folgenden Pakete werden nacheinander abgenommen. Ein Paket gilt erst mit seinem
Nachweis als abgeschlossen; erste Optimierungen sind noch keine fertige Einführung.
Die aktuelle Aufrufkarte, abgegrenzte Messbereiche und offene Nachweise stehen in
[Aufrufer und Messbasis](architecture/document-service-database-baseline.md).

### 1. Aufrufer und Messbasis erfassen

Je einen reproduzierbaren Ablauf für Öffnen, Speichern, Agenten-/MCP-Neuanlage,
REST-/SDK-Zugriff, Backlinks und Umbenennen/Verschieben erfassen. Pro Aktion und Phase SQL-Anzahl,
Datenbankzeit, Gesamtdauer, Pool-Wartezeit und gleichzeitige Verbindungen messen.
Kalte/warme Aufrufe und kleine/große Workspaces getrennt vergleichen. Metriken
enthalten keine Inhalte, Pfade, Nutzeridentitäten, SQL-Parameter oder Secrets.

**Fertig:** Aufrufkarte, feste Testdaten, Messberichte und dominante Abfragegruppen.
Es darf keine Optimierung mit einer ungemessenen neuen Lesekette abgenommen werden.

### 2. Gemeinsame Verträge festlegen

Die echte Autorität bleibt beim nativen Dokumentzustand. Dokument-ID, Lineage,
Lebenszyklusgeneration, Sequenz, Zustandsbeleg und Parser-Version kennzeichnen eine
Beobachtung. Pfade und Titel dienen nicht als Ersatz für Dokumentidentität.
Gemeinsame Parser und Zielauflösung werden von den Integrationsadaptern verwendet.
Leseprofile und Prüfungen für Änderungen bleiben explizit unterscheidbar.

**Fertig:** Dieselben Eingaben liefern in Editor, Agent und MCP dieselben Links,
Zielentscheidungen und Diagnosen. Fehlende Zustände, Metadatenfehler, HTML-Grenzen
und unaufgelöste Ziele bleiben getrennt. Ein Lesecache kann keinen Schreibplan
oder eine Berechtigung erzeugen.

### 3. Berechtigungs- und Dokumentdaten bündeln

Für jede erforderliche Grenze aktuelle Benutzer-, Seat-, tatsächliche Sitzungs-,
Agenten-, Tool- und Workspace-Daten zusammen lesen. Bestehende Entscheidungslogik
wiederverwenden; keine Berechtigungen aus einem angenommenen Workspace herstellen.
Registry, Lineage, nativen Zustand und Projektionsstand gemeinsam und begrenzt laden.
Eine Beobachtung wird nur innerhalb ihrer konkret gehaltenen Phase verwendet.
Identität, Generation und Version werden vor dem Schreiben erneut geprüft.

Die Datenbankphase besitzt ihre Verbindung und Transaktion. Untergeordnete Dienste
öffnen dafür keine weiteren Verbindungen und wiederholen nicht dieselben vollständigen
Resolver unmittelbar hintereinander. Erforderliche Sperren, aktuelle Rechte,
Schema-/Relationsprüfung und bestehende Fristen bleiben erhalten. Der bestehende
allgemeine Rechteresolver wird nur schrittweise und nach Äquivalenztests umgestellt.
Vor der Umstellung wird explizit festgelegt, welche Änderungen innerhalb einer Phase
möglich sind und an welchen Grenzen eine neue Beobachtung zwingend erforderlich ist.
Eine gehaltene Verbindung allein ist kein Beleg für unveränderte Berechtigungen.

**Fertig:** Entzogene Rechte, gesperrte Accounts, fehlende Seats, archivierte
Sitzungen und geänderte Agenten-/Toolprofile werden auch unter Last abgewiesen.
Keine länger gültigen Principals und kein Berechtigungscache über Phasengrenzen.

### 4. Linkprojektion inkrementell aktualisieren

Die extrahierten Links werden pro Dokument mit dessen Versionsbeleg vorgehalten.
Beim Speichern wird nur das geänderte Dokument erneut extrahiert. Ein normaler
Backlink-Aufruf muss nicht erneut sämtliche Dateien lesen und Yjs-Zustände dekodieren.
Zunächst den begrenzten dokumentweisen Lesepfad umsetzen und messen; eine persistente
Projektionsablage nur mit nachgewiesenem Bedarf und eigenem kleinen Schema einführen.

Extraktionscache, aufgelöster Linkindex und Browser-Dokumentinhalt haben getrennte
Verantwortlichkeiten und Lebensdauern. Der Linkindex wird im Arbeitsspeicher
begrenzt vorgehalten und versionsgebunden aktualisiert. Ein warmer Zugriff darf
nicht allein wegen einer neuen Ansicht sämtliche nativen Inhalte erneut laden.
Kleine gemessene Durchläufe über vorhandene Metadaten sind zulässig; eine zusätzliche
Index-Datenbank oder ein weiterer laufender Dienst wird nur bei belegtem Bedarf
eingeführt. Speichergrenzen, Verdrängung und Wiederaufbau sind ausdrücklich zu prüfen.

Änderungen an Pfad, Titel und Aliasen invalidieren gezielt die davon abhängigen
Zielauflösungen. Auch bisher fehlende oder mehrdeutige Ziele müssen berücksichtigt
werden: Eine neue Datei kann einen alten Link reparieren oder mehrdeutig machen.
Verschobene Quellen benötigen eine neue Auflösung relativer Links. Dafür werden
Abhängigkeiten für exakte Pfade, Aliasnamen und Dateinamen ausdrücklich geführt.

Falls ein Hintergrundprojektor erforderlich ist, wird sein Auftrag atomar mit der
nativen Änderung gespeichert. Wiederholungen sind idempotent; ältere Aufträge dürfen
keinen neueren Stand überschreiben. Bestehende Produktbenachrichtigungen werden erst
nach bestätigtem Commit ausgelöst. Externe physische Dateiänderungen brauchen eine
Startup-/Abgleichstrategie; reine Browser-Invalidierung oder eine TTL reicht nicht.

**Fertig:** Einzeländerungen lösen keinen vollständigen Workspace-Neuaufbau aus.
Ein vollständiger Neuaufbau bleibt für Erstaufbau, Reparatur und Vergleich verfügbar.
Die Projektion ist jederzeit aus den maßgeblichen Quellen wiederherstellbar und
wird nie als alleinige Autorität für Schreiboperationen benutzt.

### 5. Normale Änderungen zentral ausführen

Editor, Agent, MCP, REST und SDK delegieren die eigentliche Speicherung an dieselben
spezifischen Dienste. Ihre Authentifizierung bleibt jeweils echt und getrennt.
Vorhandene native Versionsprüfung und dauerhafte Belege werden weiterverwendet.
Parsing und Serialisierung finden außerhalb langer Schreibtransaktionen statt,
soweit das ohne Verlust einer notwendigen Sperre möglich ist. Jede Phasenteilung
braucht einen echten Abbruch-/Wiederholungsnachweis.

Bei Umbenennen und Verschieben werden die betroffenen eingehenden und relativen
Verweise vorab bestimmt und unter aktuellen Zustandsbelegen geändert. Mehrdeutige
oder nicht vollständig geprüfte Ziele dürfen keine stillen Umschreibungen erhalten.
Ein unsicherer COMMIT-Ausgang wird anhand dauerhafter Originalbelege aufgeklärt.
Ein unbestätigter Rollback wird nicht blind wiederholt.

**Fertig:** Kein Verlust von Inhalt, IDs, Lineage, Revisionen oder Freigaben bei
Parallelbearbeitung, Prozessabbruch, verlorener COMMIT-Antwort und Neustart.
Keine neue Review-Center- oder Undo-Implementierung als Voraussetzung.

### 5a. API-Key-Verwaltung für programmatischen Zugriff

**Status: in Umsetzung, noch nicht veröffentlicht.** Das Verwaltungs-Backend
mit additiven Auth-Tabellen und Session-geschützten Routen unter
`/api/api-access/integrations` ist implementiert. `npm run test:api-keys` prüft
den Lebenszyklus mit echten Auth-Sitzungen in PGlite sowie die Settings-Oberfläche
mit kontrolliertem HTTP-Transport; `npm run test:api-keys:native`
führt dieselben Prüfungen und zusätzliche unabhängige Transaktions-/Worker-Rennen
auf dem verwalteten lokalen PostgreSQL in einer eigenen temporären Datenbank aus.
Die Oberfläche unter **Verbindungen → API-Zugriff** ist für `35489f790` an einem
frisch gebauten Linux-Image abgenommen: vier Browserfälle ohne Wiederholung oder
Skip prüfen Desktop (1280 px), Mobil (390 px), Rotation/Widerruf und verlorene
Ausstellungsantworten vor beziehungsweise nach dem tatsächlichen Commit.
Alle sechs dabei ausgestellten Testschlüssel sind widerrufen; die geschützten
Dokumentdaten blieben unverändert. Diese Browserfälle werden im Abnahmepaket 5b
noch in einen dauerhaften Repository-Runner übernommen.

Die separate Schlüsselprüfung ist implementiert und mit regulär ausgestellten
Schlüsseln in PGlite und PostgreSQL geprüft. Sie erkennt gemischte Zugangsdaten,
Widerruf, Rotation, Ablauf, Kontosperren, fremde Instanzen, kopierte Nachweise,
temporäre Schattentabellen und einen geänderten Datenbank-Suchpfad. Logout beendet
den Schlüsselzugang nicht. Ein warmer Einstieg benötigt einschließlich der
gemeinsamen Client-/Global-/Key-/User-Limits und begrenzter Nutzungsstatistik fünf
SQL-Anweisungen. Zusätzlich ist die separate Read-/Search-Principal-Phase mit
sieben echten PostgreSQL-Fällen geprüft: aktuelle Seat-/Workspace-/Aktionsrechte,
auf Lesen begrenzte Permissions, unverfälschbare und nur während des Aufrufs
gültige Handles, Reentranz, tatsächlicher Backend-/Transaktionswechsel sowie
ein unabhängiger Widerruf, der auf die laufende Phase wartet. Die Phase leiht
die echte Transaktion und verändert keine Dokument-/Yjs-/Projektionsdaten.
Diese Prüfung läuft dauerhaft unter `test:api-keys:documents:native` und im
nativen API-Key-Paket. Die REST-Routen `/api/documents/read` und
`/api/documents/search` verwenden diese Phase und die bestehenden nativen
Dokumentkerne. Sechs PostgreSQL-/Route-Testgruppen prüfen regulär ausgestellte
Schlüssel, Unicode-Seiten, progressive Suche, Fortsetzung nach Rotation innerhalb
derselben Integration, fremde Integrations-Cursor und echte 401/403/429-Antworten.
Diese Tests verwenden echte Route-/Auth-/SQL-Implementierungen, ersetzen aber
keine Abnahme über TCP am frisch kompilierten Container.
`/mcp` erkennt den eigenen Key-Header getrennt von OAuth. Die beiden nativen
Read-/Search-Adapter sind über Legacy- und modernes MCP-Protokoll mit sechs
weiteren PostgreSQL-Gruppen geprüft; API-Key-Verbindungen erhalten dafür eigene
Auth-/Input-/Fehlerschemata. Eine laufende Phase prüft die wirklichen MCP-Tool-
schalter erneut. Es entstehen keine fingierten OAuth- oder Browser-Sitzungen.
Fünf aktuelle native Regressionssuiten und der korrigierte isolierte MCP-
Nutzungsanzeigentest bestehen. Das SDK besitzt den ausdrücklich getrennten
`api_key`-Transportmodus mit HTTPS-Pflicht außerhalb Loopback, eigenem Header,
begrenzter Lebensdauer im Client und ohne neue automatische Schreibwiederholung.
Ein frisch installiertes Wheel besteht 80 mechanische Tests unter Python
3.10.19 und 3.14.3; ein Core-Wheel-Import ohne MCP-Extras ist ebenfalls geprüft.
Der dauerhafte Runner `test:api-keys:sdk:native` prüft reguläre Ausstellung,
mehrseitige Unicode-Reads, Suche, Rotation, Rechteentzug und Widerruf über
wirkliches HTTP mit dem installierten Wheel. Er verlangt explizite
`CANVAS_SDK_TEST_PYTHON`-/`CANVAS_SDK_TEST_WHEEL`-Pfade und vergleicht jede
installierte SDK-Quelldatei mit dem Wheel und dem Arbeitsstand.
Für Workspace-Listen ist eine getrennte, auf Lesen begrenzte Principal-Familie
vorbereitet. Vier echte PostgreSQL-Gruppen prüfen einen und 100 explizite
Workspace-Selektoren, aktuelle Rechte/Archivierung und die Trennung vom
Dokument-Principal. Beide Größen benötigen in dieser gehaltenen Phase acht
SQL-Anweisungen einschließlich drei aktueller gemeinsamer Beobachtungen;
das ist keine vollständige HTTP-Leistungsmessung. Die bestehenden drei nativen
API-Key-Lesesuiten bestehen nach der Bündelung weiterhin.
Eine getrennte native Edit-Principal-Familie ist vorbereitet. Fünf weitere echte
PostgreSQL-Gruppen prüfen aktuelle Edit-/Status-Aktionen und normale Workspace-
Write-/Agent-Rechte, die Trennung von Read/List/Browse, gefälschte und abgelaufene
Handles, den tatsächlichen MCP-Edit-Schalter, Reentranz und die synchrone letzte
Ablaufprüfung vor dem späteren Writer. Status verlangt in dieser Edit-Familie
zusätzlich zur aktuellen Edit-Berechtigung die explizite Status-Aktion.
Die Phase verwendet dieselbe tatsächliche Verbindung und acht SQL-Anweisungen
einschließlich drei aktueller Beobachtungen; das ist keine Messung einer ganzen
Änderung. `test:api-keys:edit-principal:native` gehört zum nativen Key-Paket.
Die bisherigen drei Dokument- und fünf Workspace-Suiten sowie Typecheck und
gezieltes ESLint bestehen. Die Familie ist inzwischen an die bestehende native
Edit-Authority und den Writer angeschlossen. Ein eigener `api_key`-Ursprung hält
Benutzer, Integration, Instanz und die ursprüngliche Credential-ID fest.
Die Actor-Zuordnung bleibt bei Rotation stabil; `sessionId` und die gespeicherte
Session-Spalte sind für diesen Zugang `null`. Es entsteht keine Browser-/OAuth-/
PI-Sitzung. Die vorhandene binäre Versionshistorie akzeptiert diesen fehlenden
Session-Wert ausschließlich im geprüften nativen Key-Kontext nach Vergleich des
gespeicherten Originals, tatsächlichen After-Belegs und exakten Payloads.
Zwölf PostgreSQL-/Native-Runtime-/Route-/MCP-Gruppen prüfen echte Speicherung,
After und HistoryOnly-Version, unveränderte Belege bei Wiederholung/Rotation,
fremde Integrationsgrenzen, Widerruf und abgewiesene fingierte Session-Zuordnung.
Die öffentlichen Key-Adapter verwenden unter `/api/documents/edit` und
`/api/documents/edit/status` dieselben nativen Kerne. MCP bietet ausschließlich
deren native Edit-/Status-Eingaben an; beide Protokollversionen sind mit echten
Schlüsseln und veröffentlichten Schemata geprüft. Der gespeicherte Key-Ursprung
unterscheidet REST und MCP, während dieselbe Integration ihren Status auch nach
Rotation und über den jeweils anderen Transport lesen kann. Versteckte MCP-
Pfade, aktuelle Seat-/Schreibrechte, entzogene Aktionen und echte Key-Limits
werden vor der Änderung geprüft. Die sichere Fehlerdarstellung veröffentlicht
nur Fehlercode, gegebenenfalls begrenzte Wartezeit und tatsächliche Operations-ID.
Ein verlorenes Acknowledgement nach dem wirklichen Schreib-COMMIT erzeugt keine
zweite Operation. Läuft der Schlüssel erst nach dem abgeschlossenen Schreibvorgang
ab, bleibt dessen Referenz für die Statusabfrage mit einem neu ausgestellten
Schlüssel erhalten. Nach dem tatsächlichen Löschen der ausstellenden Browser-
Sitzung funktionieren native Key-Edits und Status weiterhin ohne Ersatzsitzung.
Neun bestehende Principal-Familien, zehn reale Edit-Owner-Gruppen mit Peer-
Änderungen und sechs Historiengruppen bestehen ebenfalls. Typecheck, ESLint
und vollständiger Test-Cleanup sind bestätigt. Der dauerhafte Key-Runner ist
`scripts/api-key-native-edit-owner-postgres-test.ts` in `test:api-keys:edits:native`.
Die drei vorhandenen Key-Dokument- und fünf Workspace-Suiten, die zehn Session-
Owner-Gruppen, neun registrierten MCP-/PI-Dispatch-Gruppen sowie Resultat-,
MCP-Vertrags- und Nutzungsanzeigentests bestehen. Der bisherige CJS-Start des
MCP-Vertragstests wurde auf den bereits vorhandenen ESM-Test-Runner umgestellt:
Das installierte `pi-ai/compat` besitzt ausschließlich einen Import-Export.
Der vollständige Paketbefehl besteht ohne ausgelassene Tests. Release-Typecheck
und gezieltes ESLint bestehen. Die kompilierte Container-Abnahme bleibt offen.
Der getrennte Runner `test:api-keys:sdk:edits:native` besteht mit dem oben
genannten installierten Wheel unter Python 3.10.19 und 3.14.3: jeweils sechs
Gruppen und 31 ausschließlich über Key authentifizierte HTTP-Anfragen prüfen
native Änderung, Status, exakte Wiederholung, Versionskonflikt, Rotation,
fremde Integrationen, aktuelle Aktionsrechte, echten Logout und Widerruf.
Eine tatsächlich gekappte HTTP-Antwort nach bestätigter Speicherung führt zu
keinem automatischen zweiten Schreibaufruf. Der offizielle MCP-Client beendet
dabei seine Verbindung; nach deren vollständigem Schließen öffnet der Test eine
frische Verbindung. Die ausdrücklich vom Aufrufer gestartete Wiederholung
liefert dieselbe dauerhafte Operation zurück, deren Status bestätigt ist.
Der unabhängige Datenbankleser prüft die gespeicherten Yjs-Bytes; ein vorübergehend
im RAM gehaltener Raum wird nicht als Dauerhaftigkeitsnachweis verwendet.
Genau drei tatsächliche Änderungen entstehen; Originalbelege bleiben bei
Wiederholung unverändert. Ein separates Kontroll-Dokument einschließlich
nativer Zeilen, `xmin` und physischer Bytes bleibt erhalten. Review Center ist
ausgeschaltet, alle eigenen Ressourcen und Schema-Fixtures schließen vollständig.
Die zwölf HTTP-/MCP-Owner-Gruppen bestehen nach Auslagerung ihres gemeinsamen
Test-Runtime-Aufbaus weiterhin. `test:api-keys:sdk:native` führt Lese- und
Schreibprüfungen künftig nacheinander aus. Weitere Schreib-/Recovery-Methoden,
OAuth-/Keyring-Gesamtabnahme und der frisch kompilierte Container bleiben offen.

Für native Neuanlage und Import ist inzwischen eine eigene API-Key-Principal-
Familie implementiert. Sieben echte PostgreSQL-Gruppen prüfen die getrennten
`create`-/`import`-Aktionen, normale aktuelle Workspace-/Seat-Rechte, die feste
Trennung von Read, Browse, List und Edit sowie echte MCP-Toolschalter und deren
Entzug innerhalb einer gehaltenen Phase. Gefälschte oder abgelaufene Handles,
Options-Getter, ein zur Laufzeit falsch übergebener Zweck und abgefangene
Reentranz erlauben keine spätere Speicherung. Die synchrone letzte Ablaufprüfung
verwendet den aktuellen Nachweis derselben tatsächlichen Transaktion.
Die gemessene Phase mit Einstieg `request` benötigt neun SQL-Anweisungen
einschließlich drei aktueller Beobachtungen. Der zusätzliche Schritt setzt nach
Prüfung des tatsächlichen Eingangs-Realm den festen Schema-Pfad des bestehenden
Receipt-Triggers. Weitere Beobachtungen prüfen diesen wirklichen Pfad und alle
unveränderten Realm-/Credential-Bindungen; es wird keine SQL-Antwort umgeschrieben.
Andere Pfade und kopierte Credential-Metadaten eröffnen keine Principal-Phase.
Read-/Browse-/Edit-Familien behalten ihre bisherigen Realm-Prüfungen. Das ist kein
Budget für die gesamte Neuanlage. Nach echtem Logout
bleibt der Schlüssel gültig; ein unabhängiger tatsächlicher Widerruf wartet auf
die gehaltene Key-Zeilensperre und verweigert danach beide Zwecke.
Die Ursprungsdaten halten Benutzer, Integration, Instanz, Credential, Zweck und
REST-/MCP-Einstieg fest, ohne Browser-/OAuth-/PI-Sitzung. Diese Daten selbst
erteilen keine Rechte. Dokument-, Yjs-, Revisions- und Projektionszeilen samt
`xmin` bleiben unverändert. Der dauerhafte Runner
`test:api-keys:creates:native` gehört zum nativen Key-Paket. Es prüft inzwischen
zusätzlich den Anschluss an den vorhandenen Neuanlage-Kern, seine tatsächlichen
Dateisystem- und Birth-Grenzen, native Speicherung, Historie und erste Projektion.
Ein eigener `api-key-markdown-v1`-Quellbeleg und strenge Ursprungsdaten halten
die wirkliche Integration und ursprüngliche Credential-ID fest; die Session ist
`null`. Gemeinsame Byteprüfung und Speichermechanik bleiben bei den bestehenden
Browser-/Upload-, Agenten- und OAuth-Wegen. Der Python-Dateisystemhelfer versteht
denselben ausdrücklichen Key-Beleg. Kopierte Belege können dessen privaten
Owner-/Phasen-Kontext nicht herstellen.

Neun echte PostgreSQL-/FD-/Birth-/HTTPS-Gruppen prüfen befüllte und leere Anlage,
Anlage ohne Read-Aktion, Integrationsisolation, unveränderte Originale bei
Wiederholung und Rotation sowie den Import unabhängig geladener Bytes von einer
festen öffentlichen HTTPS-Quelle. Eine abgeschlossene Wiederholung verwendet
ihren Originalbeleg auch bei inzwischen unbrauchbarer Download-URL. URL und
Zugangsschlüssel erscheinen nicht im privaten Herkunftsbeleg.
Der native Request-Einstieg erlaubt regulär zulässige versteckte Workspace-Pfade;
MCP schließt diese weiterhin aus, auch bei einer Wiederholung mit vorhandenem
Request-Ursprung. Diese Prüfung betrifft den echten Kern und seine Herkunftsgrenzen;
die öffentliche HTTP-/MCP-Transportabnahme bleibt ein eigener Schritt.
Ein tatsächlicher Verlust des erfolgreichen Native-COMMIT-Acknowledgements
erzeugt keinen zweiten Receipt-Insert. Bei wirklicher Schlüsselrotation nach
Native-COMMIT stoppt der alte Aufruf vor der Dateiprojektion. Ein expliziter
Wiederholungsaufruf mit dem neuen Schlüssel derselben Integration setzt dieselbe
Operation unter aktuellen Rechten fort: Receipt und Ursprungsdaten samt alter
Credential-ID sowie ursprüngliche Yjs-Bytes, Vektor und Sequenz bleiben erhalten;
es entsteht kein zweiter Native-Insert. Logout benötigt keine Ersatzsitzung;
Widerruf und deaktivierte MCP-Werkzeuge verweigern weitere Anlage. Ein eigenes
Kontroll-Dokument einschließlich Zeilen, `xmin` und physischer Bytes bleibt
unverändert. Die großen Schema-Fixtures werden vollständig geschlossen.
Diese Kernfälle sind von den öffentlichen REST-/MCP- und installierten SDK-
Create-/Import-Grenzen getrennt; deren weitere Nachweise folgen unten.
Die drei bestehenden Key-Dokument-, fünf Workspace- und beiden Edit-Suiten
einschließlich der zwölf wirklichen Writer-/Route-/MCP-Gruppen bestehen nach der
Erweiterung. Die installierten SDK-Lese- und Edit-Pakete bestehen ebenfalls unter
Python 3.10.19 und 3.14.3. Reguläre Key-Suite, Release-Typecheck und gezieltes
ESLint bestehen.

Die neuen öffentlichen Key-Routen `POST /api/documents/create` und
`POST /api/documents/import` sowie die registrierten Key-MCP-Werkzeuge
`create_knowledge_source` und `import_knowledge_file` verwenden nun denselben
nativen Kern. Der REST-Einstieg erwartet einen echten ausdrücklichen
`X-Canvas-API-Key` und CamelCase-Selektoren, MCP die eigenen SnakeCase-Selektoren;
beide verlangen API-Version 1 und verweigern einen Legacy-Fallback.
Browser-Session-Anlage und -Upload behalten ihre vorhandenen Datei-Einstiege.
Die öffentliche Key-Werkzeugbeschreibung bleibt ein reines Metadatenmodul.
Erst eine tatsächliche Create-/Import-Ausführung lädt den Writer; der wirkliche
MCP-Abbruch-Signalpfad wird bis zum Kern weitergereicht.

Acht zusätzliche echte Route-/MCP-/PostgreSQL-/FD-/HTTPS-Gruppen prüfen beide
Protokolltransporte und ihre publizierten Ein-/Ausgabe-Schemas, leere und befüllte
Anlage, vollständige native Versionen und identische Wiederholung über REST/MCP.
HTTP 400/401/403/409/413/422/429 werden an ihren tatsächlichen Grenzen geprüft,
einschließlich ungültigem UTF-8/Text, MIME-Widerspruch, gemischten Credentials
und wirklichem Abuse-Limit mit begrenztem Retry-Header. Die HTTPS-Quelle wird
unabhängig geladen und mit physischer Datei und Quellhash verglichen. Versteckte
REST-Pfade bleiben von MCP ausgeschlossen. Rotation, Logout und Widerruf
erhalten Original-Receipt und Eigentümerschaft. Ein eigenes Kontrolldokument
bleibt samt nativen Zeilen, `xmin` und physischen Bytes unverändert.

Der neue dauerhafte Runner `test:api-keys:sdk:creates:native` ergänzt das
SDK-Gesamtpaket. Sieben Gruppen bestehen pro Python 3.10.19 und 3.14.3 mit dem
tatsächlich installierten neuen Wheel über echte Loopback-HTTP-Verbindungen.
Sie umfassen Create/Import, Konflikt und exakte Wiederholung, Rotation, getrennte
Aktionsrechte, Issuer-Logout und Widerruf. Für Create und Import wird jeweils
eine wirkliche erfolgreiche HTTP-Antwort nach dauerhafter Speicherung verworfen.
Der SDK-Aufruf wiederholt keine Mutation automatisch. Nach geschlossenem
Transport setzt ein ausdrücklicher Aufruf mit demselben ursprünglichen Idempotenzschlüssel
jeweils genau dieselbe Operation fort; native Receipt-Zeile und `xmin` bleiben
unverändert. Pro Lauf entstehen fünf beabsichtigte neue Operationen.
Alle 32 HTTP-Anfragen verwenden ausschließlich den Key-Header. Nach Widerruf
scheitern moderne Discovery und der offizielle Legacy-Initialisierungsversuch
vor einem weiteren Werkzeugaufruf; das sind keine Schreibwiederholungen.
Kontrolldokument und Originale bleiben unverändert; alle Prozesse, Datenbank-
Schemas, HTTP-Server und Verbindungen werden geschlossen.

Neues Wheel: `642c6fbfe2cc9c4f91661fd5942c1f18fecd22b486b1f3a20a6bc761481f5a0f`.
Neue Source-Distribution:
`c650d2b82d1c47c0f03afa79dd6431f9bb8850b5240b1d91c685fb12dfa1fc87`.
Installierte Moduldateien werden gegen Wheel und aktuelle Quellen verglichen.
Alle 80 mechanischen SDK-Tests bestehen mit dem neuen Wheel unter beiden
Python-Versionen und nach Installation aus der Source-Distribution unter 3.10;
die Core-Installation ohne MCP-Extras besteht ebenfalls. Die vollständigen
bisherigen SDK-Lese- und Edit-HTTP-Runner bestehen mit diesem neuen Wheel unter
beiden Python-Versionen weiterhin. Dies ist Source-HTTP-/Paket-Abnahme, noch
keine Abnahme eines neuen kompilierten Containers oder veröffentlichten Releases.

Die großen Schema-Fixtures am gemeinsam verwalteten PostgreSQL werden
nacheinander ausgeführt. Zwei parallel gestartete Regressionen bestanden ihre
Funktionsfälle, scheiterten aber beim gleichzeitigen `DROP SCHEMA` am PostgreSQL-
Sperrspeicherlimit (`out of shared memory`). Die zugehörigen Serverfehler wurden
über Backend-PID und exakten Schema-Namen zugeordnet; beide eindeutig eigenen
Schemas sind bereinigt. Die vollständigen sequenziellen Wiederholungen bestehen
einschließlich Cleanup. Es wurde kein PostgreSQL-Limit erhöht.

Für Copy ist eine eigene API-Key-Principal-Familie mit festen Zwecken
`copy_preview`, `copy_apply`, `copy_status` und `copy_recover` hinzugekommen.
Beide ausgewählten Workspaces werden in derselben tatsächlichen B-Beobachtung
mit den aktuellen Key-, Seat- und Workspace-Rechten geprüft. Die Quelle benötigt
Read; das Ziel Write und Agent-Zugriff. Auch bei gleichem Workspace bleibt die
Quellansicht ausdrücklich schreibgeschützt. Copy gibt kein Delete-, Admin- oder
Public-Link-Recht weiter. Alle Zwecke verlangen `copy`; Status zusätzlich
`status`, Recover zusätzlich `recover`. Andere Principal-Familien und Zwecke
können diese Captures nicht ausleihen.

Die Verwaltung erlaubt jetzt schreibgeschützte Workspaces als mögliche
Copy-Quellen in der expliziten Allowlist. Ein gemischter Aktionssatz mit Copy
erteilt dadurch kein neues tatsächliches Schreibrecht: Jede einzelne Operation
prüft weiterhin ihre aktuellen Rollen. Der echte Test weist insbesondere Edit
an der schreibgeschützten Quelle ab und erlaubt dieselbe freigegebene Edit-Aktion
am tatsächlich beschreibbaren Ziel. Ohne Copy behalten Edit-/Recover-only-
Schlüsselausstellungen ihre bisherigen strengen Rechteprüfungen.

Der reine feste Receipt-Pfad-Decoder wird nun von Create und Copy geteilt.
Copy darf sowohl im rohen Auth-Realm als auch im bestehenden kanonischen
Native-Inspection-Realm beginnen; ausschließlich der serverseitig abgeleitete
Schema-Pfad ist zulässig. Die tatsächlichen Schema-/Datenbank-OIDs, Relationen
und Transaktionsidentitäten werden unverändert geprüft. Create behält seinen
rohen Eingangsnachweis, Read/Browse/Edit ihre bisherigen Realm-Grenzen.

Neun echte PostgreSQL-/Auth-/Rollen-/Lebensdauer-Gruppen bestehen im dauerhaften
Runner `test:api-keys:copies:native`. Eine Phase mit zusätzlichem aktuellem Check
benötigt neun SQL-Anweisungen für beide Workspaces zusammen. Der Test prüft auch
Allowlist- und Aktionsentzug, MCP-Toolschalter, echte synchrone Ablaufgrenzen,
abgefangene Reentranz, Logout, Rotation und einen unabhängigen Widerruf, der an
der wirklichen gehaltenen Zeilensperre wartet. Original-Dokument-, Yjs- und
Revisionszeilen samt `xmin` und physische Originalbytes bleiben unverändert.
Die native Herkunftsstruktur enthält inzwischen zusätzlich ein ausdrückliches
API-Key-V3-Format. Es bindet Benutzer, stabile Integration, Instanz und beide
Original-Workspace-Scopes. Die ursprüngliche Credential-Kennung und der
Einstiegspunkt bleiben nach Rotation unverändert; es wird keine Login- oder
PI-Sitzung erfunden. Diese gespeicherten Fakten ersetzen keine aktuelle
Autorisierung. Die neue Copy-Komposition verlangt auf jedem tatsächlichen B den
lebenden Key-Principal mit dem vom Aufrufer fest vorgegebenen Zweck und prüft
weiterhin aktuelle Quell-/Zielrechte.

Neun zusätzliche PostgreSQL-/Auth-/Herkunfts-Gruppen prüfen diese Komposition,
die vollständige V3-Speicherung im echten Journal, unveränderte Journalbytes und
`xmin` bei Wiederholung und Rotation, fremde Integrationen/Scopes, Logout,
Widerruf und die Trennung von Session, PI und OAuth. Die bisherigen Original-
und OAuth-Sitzungen behalten ihre Erneuerungsregeln. Der ältere lokale Session-/
PI-Test verwendet nun einen über `realpath` aufgelösten temporären Datenpfad:
Der macOS-Alias `/var` darf nicht als Verzeichnis ohne Symlinks ausgegeben
werden. Die produktiven FD-/Symlink-Prüfungen bleiben unverändert.

Der vorhandene native Copy-Owner und seine Schreibphasen sind jetzt ebenfalls
an API-Keys angeschlossen. Vorschau, Apply und Recover setzen ihren Zweck am
festen Einstieg. Eine Schreibphase übernimmt diesen Zweck nur vom tatsächlichen
privaten Owner und genau dessen lebendem Key-Handle. V3-Zuordnungen erreichen
keinen PI-/Session-/OAuth-Ersatzpfad. Bei Wiederholung und Rotation bleibt die
ursprüngliche Journal-/Receipt-Zuordnung erhalten. Die bestehenden FD-, Stage-,
Transaktions-, Link-, Scene-/Asset- und Publication-Prüfungen bleiben im selben
nativen Ablauf. Native History verwendet die tatsächlich sitzungslose
API-Key-Zuordnung, ohne eine allgemeine Session-Prüfung abzuschalten.

Der zusätzliche API-Key-Statuszugang verwendet ausschließlich die bestehenden
C1/RR-RO/C2-Beobachtungen und historischen Receipt-Prüfungen. Er öffnet keinen
Mutation-Owner, veröffentlicht keine Dateien und startet keine Wiederaufnahme.
Neun weitere echte PostgreSQL-/FD-/Owner-Gruppen bestehen im Copy-Paket. Sie
prüfen gemischte native Markdown-/Scene-/Asset-/PDF-/Verzeichnis-Kopien,
aktuelle native Zustände trotz fehlender Projektionen, Link-Rezepte, frische
Yjs-Identitäten, Copy innerhalb desselben Workspaces, Rotation, unveränderte
historische Zeilen samt `xmin`, Status ohne DML/DDL/Notify, feste Zwecke und
echte Pool-Acquisitions bei Abweisung. Eine tatsächlich verlorene B1-COMMIT-
Bestätigung wird auf einer neuen Verbindung mit unveränderten Original-IDs
wiederaufgenommen; ein wirklicher ACL-Entzug nach B1 verhindert die spätere
Scene-/Asset-Veröffentlichung. Unbekannte Status-/Recovery-Vorgänge erzeugen
keine Operation und keine dauerhafte Stage.

Die öffentlichen API-Key-Copy-Adapter sind ebenfalls implementiert:
`POST /api/documents/copy` und das echte Direct-MCP-Werkzeug
`copy_knowledge_source` führen Vorschau, Apply, Status und explizites Recover
über denselben nativen Owner und dessen vorhandene View-Finalisierung aus.
REST hat einen begrenzten CamelCase-V1-Vertrag, MCP den bestehenden
SnakeCase-Vertrag; kein Eingang konstruiert eine Session oder OAuth-Autorität.
`copy` erlaubt Vorschau/Apply, Status verlangt zusätzlich `status`, Recover
zusätzlich `recover`. Der Browser-Eingang `/api/files/copy` behält seinen
Session-Vertrag. Acht echte PostgreSQL-/Route-/MCP-Gruppen prüfen beide
Protokolle, veröffentlichte Schemata, Proxy-Grenzen, echte Rotation und
Widerruf, unabhängige Toolschalter und aktuelle Zielrechte, unveränderte
historische Zeilen sowie verlorene tatsächliche B1-COMMIT-Bestätigungen.
Die sechs bestehenden OAuth-Copy-Adaptergruppen bestehen weiterhin.

Die installierte Copy-SDK-Abnahme hat dabei einen echten gemeinsamen Lesefehler
aufgedeckt: neu kopierte native Markdown-Dokumente ohne physische Projektion
fehlten im Manifest. Übersicht, Baum und Manifest verwenden jetzt dieselbe
native Namespace-Quelle wie der UI-Dateibaum. Eine begrenzte Baumseite hält
einen Katalog-Scope für sämtliche besuchten Verzeichnisse; sie eröffnet keinen
zusätzlichen Katalog je Kind. Native Katalogänderungen invalidieren bestehende
Cursor. Fremde Katalogpfade, Root-/Alias-Wechsel und Scene-Änderungen bleiben
Abbruchgründe. Dreißig Baumprüfungen sowie die echten Key- und OAuth-Browse-
Adapterprüfungen bestehen. Die noch physischen PI-`ls`-/Agent-Kontext-Leser
werden im verbleibenden gemeinsamen Leserpaket gesondert geprüft; der
Legacy-Suchvertrag wird nicht stillschweigend umgestellt.

**PI-`ls`: gemeinsamer Namespace statt Projektionsdateien.** Der erste
Leserschritt verwendet für alle modernen Workspace-Aufrufe denselben nativen
Baumseiten-Leser wie UI/API/MCP. Auch ein einfacher Aufruf ohne Parameter ist
jetzt begrenzt (direkte Kinder, standardmäßig 200 Einträge); Cursor und
Unvollständigkeit bleiben sichtbar. Die echten Runtime-Aufrufe liefern den
vorhandenen opaken Agent-Prinzipal. Aktuelle Benutzer-/Agent-/Workspace-Rechte
werden in kurzen eigenen Transaktionen vor der Namespace-Lesung und vor der
Ausgabe geprüft. Ein bloßer Ausführungskontext kann keine native Liste erlauben.
Der gesamte native Baum verwendet pro Seite einen Katalog-Scope. Es gibt keinen
physischen Rückfall nach einem nativen Fehler und keine Projektionserstellung.
Unverbrauchte Datei-Metadaten-Anreicherungen sind für `ls` abgeschaltet; Namen,
Typ, Größe und Änderungszeit benötigen diese zusätzlichen Abfragen nicht.

Separat erlaubte Skill-/Temp-Wurzeln behalten den bestehenden Pfadschutz und
eine begrenzte physische Liste ohne erfundenen persönlichen Workspace. Ein
bewiesener Root-Alias wird erst nach echter Autorisierung auf denselben
Workspace gebunden; Aliase innerhalb des Workspace bleiben abgewiesen.
Die bestehende `details.files`-Struktur bleibt neben den Baumseiten-Fakten
erhalten; nicht vorhandene native Größen/Zeitpunkte bleiben null.

Sieben echte Registry-/PostgreSQL-Gruppen bestehen für native Dokumente ohne
Projektion, physische/gemischte Inhalte, Pagination und veraltete Cursor,
Root-/interne Aliase und versteckte Pfade, echte Namenskonflikte ohne Rückfall,
berechtigte Temp-/fremde Wurzeln sowie Rechteentzug vor und während der Lesung.
Dokument-/Lineage-/State-/Metadaten-/Revisions-/Projektionszeilen samt `xmin`
bleiben unverändert. Schema, Clients, Daten und Bundle schließen vollständig.
Die bisherigen ungebundenen Positivtests prüfen jetzt die ausdrückliche
Ablehnung; die echten Positivfälle sind im dauerhaften Runner
`test:pi:workspace-tree:native`. Reguläre Baumtests und `test:pi:tools`
einschließlich aller 13 echten Suchprozessfälle bestehen ohne neue Skips.
Der Backend-Test startet mit `react-server`; der Suchtest überbrückt die
tatsächlichen ESM-SDK-Namensräume, statt SDK- oder Tool-Ergebnisse zu fälschen.
ESLint und strenge Typprüfung (3.737 Wurzeln/9.067 Quellen) bestehen fehlerfrei.
Der Prompt-Dateibaum und die abschließende kompilierte Browser-/Release-Abnahme
bleiben Teil der noch offenen Gesamtabnahme.

**Generisches PI-Pfadlesen – native Quelle vor Dateiprojektion, 02.11.2026:**
Der registrierte `read`-Aufruf liest in modernen Workspace-Sitzungen vorhandene
native Textdokumente über den gemeinsamen Katalog-/Admission-Lesescope. Eine
physische Datei ist dafür nicht erforderlich. `ls` und `read` verwenden dieselben
echten Aufruf-Principals und frischen Berechtigungsphasen vor und nach dem nativen
Lesen. Der Snapshot verwendet die SQL-Verbindung dieses Lesescopes. Ein fehlender
oder beschädigter initialisierter Zustand erlaubt keinen Dateirückfall und wird
beim Lesen nicht neu initialisiert. Physische, unregistrierte oder nie
initialisierte Dateien bleiben Bytequellen ohne neue Dokument-, State-, Revisions-
oder Projektionszeilen. Bestehende Legacy-/Zusatzpfade behalten ihren Pfadschutz.
Native Textausgaben weisen ihre tatsächliche persistierte oder noch laufende
Currency aus. Fehler, Binärdateien und zu große physische PDFs melden `isError`.

Der dauerhafte Runner `test:pi:read:native` prüft zehn echte PostgreSQL-/Registry-
Gruppen: fehlende und veraltete Projektionen, Plain/XML/Blocks, leere Dokumente,
abweichende Dateiendungen, Block-IDs/-Hashes und Fortsetzung, physische/pristine
Dateien, Größen-/Byte-Guards, beschädigte/fehlende States, Pfadschutz und bloße
Ausführungskontexte sowie Rechteentzug vor und nach dem tatsächlichen State-Laden.
Der vollständige Tool-Ablauf `read → read_document → edit_file V1 → read` benutzt
den echten lokalen Kollaborationsserver und eine vollständige native Version.
Reine Reads erhalten alle Fachzeilen samt `xmin`; der letzte Fall bestätigt eine
beabsichtigte tatsächliche Bearbeitung. Alle eigenen Server, Clients, Schemas,
Daten und Bundles werden geschlossen beziehungsweise entfernt. Die abschließende
kompilierte Prozess-/Browser-Gesamtabnahme bleibt offen.

**Prompt-Dateibaum – gemeinsamer nativer Namespace, 02.11.2026:** Die drei
Live-Runtime-, zwei Delegations- und zwei Automationsstellen lesen jetzt über
denselben nativen Katalog wie die Dateiwerkzeuge. Der neue dünne Reader hält
einen Katalog-/Admission-Scope für die gesamte begrenzte Baumlesung offen;
Datei-Metadaten-Anreicherungen bleiben dabei ausgeschaltet. Der Formatter behält
Tiefe 3, 40 Einträge je Verzeichnis, 200 Detail-Einträge, 8.192 Prompt-Bytes,
Sortierung, Namens-Escaping und Unvollständigkeitsmarker. Die bisherigen
Formatierungstests verwenden ausdrücklich einen Datenleser und behaupten keine
Autorisierung. Der erzeugte persönliche Workspace mit `canRead: true` entfällt.

Normale PI-Aufrufe prüfen die wirkliche gespeicherte Sitzung, delegierte Prompts
ihre wirkliche Elternsitzung. Aktueller Konto-, Workspace- und Agentzugriff werden
vor und nach der nativen Lesung geprüft. Der bisherige Session-Leser setzt eine
vorgelagerte Kontoprüfung voraus; der Prompt-Einstieg prüft deshalb auch eine
aktuelle Sperre selbst. Automationen behalten ihre bestehende verantwortlicher
Benutzer/Eigentümer-/Workspace-Policy und ergänzen dieselbe Kontoprüfung. Deren
Checkout wird vor der bestehenden Policy freigegeben. Es gibt keinen erfundenen
Tool-Aufruf und keinen Rückfall auf einen physischen Baum bei nativen Fehlern.

`test:pi:workspace-tree:prompt:native` prüft sieben echte PostgreSQL-Gruppen:
native und gemischte Namen ohne Projektion, Begrenzungen und Escaping, genau
einen Katalog-Scope mit zwei Katalog-SELECTs und null Datei-Metadaten-SELECTs,
fremde Selektoren, Namenskonflikte und tatsächliche Sperre/Archivierung nach
erfolgreicher Verzeichnislesung. Der Fehlertest bestätigt die gespeicherte
Änderung per `RETURNING`, bevor er die Ausgabeablehnung zählt. Ein tatsächlich
gespeicherter, über den normalen Store geladener Automationsauftrag prüft seine
aktuelle Eigentümer-/Workspace-Policy und Rechteentzug. Alle Fachzeilen samt
`xmin` bleiben unverändert; eigene Schemas, Clients, Daten und Bundles schließen.
Echte Modell-/Automationsläufe und die kompilierte UI sind damit nicht abgenommen.

Ein Manifest unterscheidet physische Originaldatei-Hashes von aktuellen nativen
Markdown-Hashes. Fehlt die physische Projektion, bleiben deren Hash und Revision
null und `file_state` lautet `not_materialized`. Erst eine erfolgreiche echte
native Lesung bestätigt den separaten Dokumenteintrag. Coverage heißt nun
`visible_workspace_namespace`; ein fehlgeschlagener nativer Read macht sie
unvollständig. Es wird kein Projektionsinhalt erfunden oder geschrieben.

Das neu gebaute Wheel
`58623027e9cd3464fd1bec1cf8c9c6e1a56bf7678b3cf4ac2cf6562d477a5dfe`
und das Quellarchiv
`21cccda635205bee33f2a9f64881ad0bf4b5edf0067653bd70a330928831ae43`
sind unabhängig installiert geprüft. Unter Python 3.10 und 3.14 bestehen jeweils
die vollständigen nativen SDK-Pakete für Read/Browse (4 Gruppen), Edit (6),
Create/Import (7) und Copy (8). Jede Copy-Abnahme umfasst 40 ausschließlich mit
dem Schlüssel authentifizierte echte HTTP-Anfragen, vier absichtliche HTTP-401-
Abweisungen, vier beabsichtigte Operationen, eine verlorene HTTP-Erfolgsantwort
und eine verlorene tatsächliche B1-COMMIT-Bestätigung. Es gibt keine automatische
Schreibwiederholung; ursprüngliche Quellen bleiben unverändert. Sofortige
Manifest-Sichtbarkeit und der native Hash werden gegen eine echte ID-Lesung
geprüft. Beide Wheel-Installationen und die Python-3.10-Quellarchivinstallation
bestehen jeweils 80 Paketprüfungen; Core-only-Import und Abhängigkeitsprüfungen
bestehen. Diese HTTP-/Handler-/PostgreSQL-Nachweise ersetzen weder die noch
offene kompilierte Container-Abnahme noch eine echte OAuth-Erstausstellung.

**Die übrigen Schreib-/Job-Phasen, öffentlichen Datei-/Recovery-Key-Adapter und
der Key-Import bereits vorhandener Originaldateien sowie die gesamte kompilierte
API-/SDK-Abnahme sind noch offen.**

Für Move und Delete ist die echte API-Key-Principal-Familie jetzt ergänzt. Ihre
acht festen Zwecke trennen Vorschau, Apply, Status und Recover je Operationsart.
Status verlangt zusätzlich `status`, Recover zusätzlich `recover`; Read-/Copy-
Handles können diese Familie nicht ersetzen. Jeder tatsächliche B prüft aktuelle
Lese-, Schreib-, Lösch- und Agent-Rechte. Workspace-Verwaltung und öffentliche
Freigaben werden nicht gewährt. Die vorhandenen Realm-, Schema-/OID-,
Transaktions-, Rechte-/Key-Lock- und Lebensdauerprüfungen bleiben gemeinsam.
Acht unabhängige PostgreSQL-Gruppen prüfen alle Zwecke, Action- und Allowlist-
Entzug, echte Rechteänderungen, fremde Familien, Proxies/Getter, unzulässige
Schema-Wechsel und Auth-Tabellen-Schatten, Toolschalter, Rotation, Ablauf, Reentranz und eine
tatsächlich wartende Widerrufstransaktion. Dokument-/Yjs-/History-Zeilen samt
`xmin` und Originalbytes bleiben unverändert. Der dauerhafte Runner liegt unter
`test:api-keys:paths:native` und ist in das gesamte native Key-Paket aufgenommen.
Für die zunächst ergänzte Principal-Grundlage in `1e680a78a` bestanden die
reguläre Key-Suite und das vollständige native Key-Paket einschließlich der
vorhandenen Read-/Browse-/Edit-/Create-/Copy-Wege. Der aktuelle Claim-Anschluss
wird erneut in diesen Paketen geprüft.
Das ist die Autorisierungsgrundlage; die noch offenen nativen Move-/Delete-Job-
Owner, öffentlichen Adapter und deren installierte SDK-Abnahme folgen darauf.

Der eigene Originaldatenvertrag für diese Jobs liegt unter
`workspace-operation-api-key-authorization.ts`. Er enthält den Transport
`api-key`, Benutzer, Integration, Instanz, ursprünglichen Schlüssel und
ursprünglichen Einstieg; eine Session ist ausdrücklich null. Die vollständige
native Plan-/Workspace-Bindung wird gemeinsam mit MCP geprüft. Die stabile
Batch-ID bindet Benutzer, Integration, Instanz, Workspace, Operationsart und den
exakten Caller-Key; Rotation und ein erlaubter Wechsel zwischen REST und MCP
verändern sie nicht. Die historische Schlüssel-/Einstiegszuordnung bleibt dabei
vollständig erhalten. Sechs echte PostgreSQL-/Key-/native Plan-Gruppen prüfen
strikte Metadaten, Identitäts-/Scope-/Plan-Konflikte, Rotation und aktuelles
Abweisen nach Action-/Rechte-/Tool-Entzug beziehungsweise Widerruf. Die acht
bestehenden reinen MCP-Vertragsgruppen bestehen nach der gemeinsamen
Planprüfung weiterhin. Diese Datenprüfung erstellt keinen nativen Job und
ersetzt keinen lebenden Principal oder Claim.

Der Batch-Store erkennt den strikten Modus `api-key` und erstellt seine Claims
über denselben Lease-/Header-Ablauf wie MCP. Der eigene Zweig benötigt einen
lebenden Key-Principal mit dem exakten Move-/Delete-Apply- oder Recover-Zweck.
Normale Move-/Delete-Phasen behalten den Suchpfad ihrer tatsächlichen
Einstiegsverbindung; der nur für Create/Copy benötigte Receipt-Wechsel wird
hier nicht übernommen. Neue Verbindungen können dadurch denselben echten
Claim-/Schema-/OID-Nachweis bestätigen. Der Decoder prüft weiterhin native
Planversion, Scope, Aktionszahl und leere Review-Zuordnungen. Queue, lose
Heartbeats und Abschlüsse sowie gewöhnliche Worker dürfen diese Jobs nicht
übernehmen. Sieben echte PostgreSQL-Gruppen prüfen opake Claims nach bestätigtem
Commit, falsche Zwecke/Familien, Rotation, unveränderte Originaldaten und Pläne,
explizite Recovery, eine tatsächlich verlorene Claim-COMMIT-Bestätigung und
Abweisung nach Rechteentzug/Widerruf. Auch die echte Browser-Session des
Schlüsselinhabers darf diese Jobs über die gewöhnlichen Batch-GET-/POST-Routen
weder lesen noch fortsetzen; sie erhält früh `BATCH_API_KEY_AUTHORIZATION_REQUIRED`
mit HTTP 403. Dokumente, Yjs, History, native Intents, Batch-Zeilen und
Originalbytes bleiben bei diesen Ablehnungen unverändert.
Die reguläre Key-Suite und das vollständige native Key-Paket bestanden nach dem
Claim-Anschluss. Alle 43 bestehenden MCP-/Web-Owner-Fälle bestanden anschließend
ohne Fallfilter, einschließlich echter Live-Räume, Session-Erneuerung,
Commit-Bestätigungsverlust, HTML, PDF/PNG und Ordner-Sammeloperationen. Ihr
Testaufbau wartet bei tatsächlich laufendem Projektor auf dessen Finalisierung,
bevor fehlende Projektionen oder historische Snapshots arrangiert werden; die
produktiven Quellnachweise und vollständigen Zustandsvergleiche bleiben streng.
Die zuletzt ergänzte, ausschließlich den Key-Modus betreffende Web-Abgrenzung
bestand danach in den sieben Claim-Gruppen mit vier echten Cookie-Requests;
auch die reguläre Key-Suite, Release-Typprüfung und gezieltes Lint sind grün.
Der Anschluss an native Key-Owner, reine Statusleser, öffentliche Adapter und
das installierte SDK bleibt erforderlich.

Die lebende Schreib-/Recovery-Policy für Key-Jobs ist inzwischen als eigener
Adapter in `workspace-operation-api-key-job-principal.ts` ergänzt. Er verbindet
einen echten Principal mit einem echten Store-Claim auf derselben aktuellen
Verbindung, prüft vollständigen Originalplan und Namespace und behält den
ursprünglichen Actor ohne Session-/PI-Zuordnung. Nur die festen Apply-/Recover-
Zwecke werden angenommen. Vorschau und Status können diese Schreib-Policy nicht
auswählen. Sechs echte PostgreSQL-/Key-/Claim-Gruppen prüfen diese Verbindung,
fremde Zwecke und Handles, falsche Realms und Read-only-Transaktionen, Rotation
sowie Action-Entzug und Widerruf nach bestätigtem Claim-Commit. Native Dokumente,
History, Intents und Bytes bleiben dabei unverändert.
Die reine Callback-Lebensdauer ist mit dem bestehenden MCP-Adapter gemeinsam;
die jeweiligen aktuellen Berechtigungsprüfungen bleiben getrennt. Sieben
mechanische Gruppen und der echte Live-Incoming-Move-/Delete-Fall bestehen.
Das vollständige Path-Paket und alle 43 bestehenden Owner-Fälle bestehen mit
dieser Extraktion.

Der ursprüngliche native Move-Runner, seine Admission und seine tatsächlichen
Owner-Transaktionen sind nun an die aktuelle Key-Policy angeschlossen. Ein
kleiner gemeinsamer Dispatcher wählt ausschließlich den tatsächlich übergebenen
MCP- oder Key-Principal; getrennte Eingabefelder verhindern, dass ein Key als
MCP-Handle übergeben wird. Gemischte Handles, Getter, Proxies und zusätzliche
Policy-Berechtigungsfelder werden abgewiesen. Der bestehende MCP-Zweig behält
seine eigenen aktuellen Prüfungen. Eine Key-Operation erzeugt keine Session
und keinen PI-Agenten; Undo wird dadurch nicht freigegeben.
Zwei echte PostgreSQL-/Key-/Move-Gruppen bestehen bei ausgeschaltetem Review
Center und Undo: mit physischer Projektion und mit ausschließlich nativem
Quelldokument. Sie prüfen die vollständige Verschiebung, stabile Dokument- und
Lineage-Identitäten, unveränderte Yjs-/State-Vector-Bytes, genau eine eingehende
Linkänderung, unveränderte externe Links und mitverschobene Titel/Favoriten/Pins.
Die tatsächlichen nativen Move- und Link-Belege werden anhand der Completion,
ihrer Hashes und des sessionlosen Originalakteurs geprüft. Der dauerhafte
Runner `test:api-keys:path-owners:native` gehört zum gesamten Path-Paket.
Der ursprüngliche Delete-Runner, seine Originaldaten-/Admission-Verträge und
seine Einzel-/Sammel-Owner akzeptieren jetzt ebenfalls den tatsächlichen
Key-Delete-Principal. Der gespeicherte Akteur bleibt sessionlos; die strikte
ursprüngliche Key-/Plan-/Workspace-Zuordnung wird bei jeder aktuellen
Owner-Phase geprüft. Der Key-Zweig erhält keinen Undo-/Restore-Zugang.
Fünf zusätzliche echte PostgreSQL-/Key-Owner-Gruppen bestehen: natives Delete
mit und ohne physische Projektion, physisches PDF und PNG sowie zwei gemeinsam
gelöschte Ordner mit nativen, rein nativen und physischen Dateien. Vollständige
Yjs-/State-Vector-Bytes und native Identitäten bleiben im Archiv erhalten;
vorhandene Originaldateien werden bytegleich in den Papierkorb verschoben.
Alle betroffenen Links einer Rückverweisquelle werden in genau einer nativen
Mutation angepasst. Ein unbeteiligtes Dokument und seine persönlichen Metadaten
bleiben einschließlich ihrer Datenbankrevisionen unverändert. Der echte
erneute Owner-Historienaufruf und explizite Recover-Header-Zugriff nach Abschluss
erzeugen keine zweite Mutation. Der Runner prüft damit insgesamt sieben
Move-/Delete-Owner-Gruppen bei ausgeschaltetem Review Center und Undo.
Die externe Linkerhaltung wird strukturell anhand des vollständigen `href`
geprüft; die frühere Teilzeichenfolgenprüfung des Beispiel-URLs ist ersetzt.
Die bestehenden vier Status-Leser für Move, natives Delete, physisches Delete
und Sammel-Delete verwenden nun auch echte Key-Principals. Ihre sechs festen
Lesezwecke umfassen Apply, Status und Recover je Operationsart; die getrennte
Writer-Erfassung bleibt auf ihre vier Apply-/Recover-Zwecke begrenzt. Ein
Status-Handle kann deshalb keine Writer-Policy oder Admission übernehmen.
Der vorhandene Ablauf bleibt zentral: frische Autorisierung auf einer echten
RC/RW-Verbindung, ein RR/RO-Snapshot samt bestätigter Freigabe der Verbindung,
anschließend eine neue Autorisierung. Der Key-Zweig verwendet aktuelle Key- und
Integrationsdaten; MCP behält seine eigenen Session-/Client-Prüfungen. Innerhalb
einer Anfrage müssen Credential, Benutzer, Integration, Instanz, Operationsart,
Einstieg und Realm stabil bleiben. Die ursprüngliche Credential-/RequestHash-
Zuordnung bleibt auch nach erlaubter Rotation erhalten.
Alle sieben Owner-Fälle prüfen zusätzlich genau einen bestätigten Nur-Lese-
Snapshot ohne DML/Notifications und unveränderte geschützte Domainzeilen samt
`xmin`. Acht echte PostgreSQL-/Key-Grenzfallgruppen bestehen: eigene Apply-/
Recover-Lesezwecke, gefälschte/gemischte/Accessor-Handles, fehlende Status-Freigabe
und fremde Integration, fehlende Jobs in allen vier Profilen, veränderter
Snapshot-Realm sowie Action-Entzug, Rotation und Widerruf nach dem tatsächlichen
Snapshot-Commit. Eine verweigerte Schlussprüfung gibt ihr vorbereitetes Ergebnis
nicht heraus. Nach Rotation kann ein frischer Aufruf mit dem neuen Schlüssel
dieselbe unveränderte Originalhistorie lesen. Fehlende Jobs erzeugen keinen
Batch und keine Historie.
Der gemeinsame Batch-Ausführer reicht den echten Key-Principal über seinen
eigenen Eingang an dieselben bestehenden Move-, Einzel-/physischen Delete- und
Sammel-Delete-Owner sowie ihre Nur-Lese-Beobachtung weiter. Er prüft weiterhin
den tatsächlichen Claim, den vollständigen Originalplan, Workspace und Akteur.
Der Key-Aufruf trägt keine Session; sein gespeichertes Original behält explizit
`actorSessionId: null`. Key- und MCP-Aufträge erhalten keinen Legacy-FS-Fallback
und keinen Undo-Zugang. Alle sieben Key-Owner-Fälle beginnen nun beim gemeinsamen
Ausführer und prüfen weiterhin seine Original-Belege, native Inhalte und
Dateibytes. Zehn zusätzliche Eingangsprüfungen weisen gefälschte, fehlende,
gemischte und Accessor-Principals, Status-/Preview-Handles, falsche Akteure,
Legacy-Pläne und fehlende Claims vor jedem SQL-Zugriff zurück.
Der bestehende Dateisystem-Unit-Test läuft zusätzlich mit unveränderten
Assertions und echtem Lifecycle-Schutz unter einer eigenen PostgreSQL-Fixture.
Sein bisheriger direkter Aufruf scheitert ohne Datenbankkonfiguration auch am
unveränderten Ausgangscommit. `test:files:batch-executor:postgres` stellt den
isolierten Kontext bereit, prüft feste Quellhashes vor/nach dem Kindprozess und
bestätigt dessen Ende sowie die vollständige Fixture-Freigabe. Dieser Aufruf
gehört jetzt ebenfalls zum gesamten nativen Key-Path-Paket. Review Center und
Undo bleiben ausgeschaltet.
Der gemeinsame native Statusdispatcher wählt inzwischen Move 3, natives Delete 2,
physisches Delete 5 oder Sammel-Delete 6 anhand des gespeicherten Headers in
demselben schreibgeschützten Snapshot. Die vorhandenen numerischen Leser und
der Dispatcher verwenden dieselben reinen historischen Beobachtungsfunktionen.
Die öffentliche MCP-Pfadsteuerung verwendet diesen Dispatcher ebenfalls.
Ein Key-Lookup mit Workspace und tatsächlicher Aufrufer-Operations-ID ermittelt
die aktuelle Workspace-Zuordnung und stabile Jobkennung direkt in der bestehenden
ersten Berechtigungsphase. Die zurückgegebene Zuordnung ist eine Faktensicht;
Schreib-Principal und Claim bleiben eigene geprüfte Eingänge.
Sieben echte native Key-Owner-Fälle vergleichen numerischen Leser, gemeinsamen
Leser mit Scope und gemeinsamen Lookup mit Operations-ID. Alle drei Zugänge
liefern dieselbe Originalhistorie, behalten Domainzeilen einschließlich `xmin`
bei und verwenden genau einen Repeatable-Read-/Read-Only-Snapshot sowie zwei
aktuelle Berechtigungsphasen. Neun zusätzliche Grenzfallgruppen prüfen echte
Rechteänderungen, Rotation/Widerruf nach dem Snapshot, Realm-Wechsel, fremde
Integrationen und fehlende Jobs; gefälschte/gemischte/Accessor-Handles und
ungültige/gemischte Operations-Selektoren werden vor dem SQL-Zugriff abgewiesen.
Der isolierte Key-Statusleser benötigt dabei 88 Anwendungs-SQL für Move, 60 für
natives beziehungsweise physisches Delete und 58 für Sammel-Delete.
HTTP-Eingangsprüfung und kompletter Operationsablauf gehören zur weiterhin
offenen Gesamtmessung. Das gesamte native Key-Pfadpaket, elf echte öffentliche
MCP-Pfadgruppen und zwölf MCP-Berechtigungsfamilien bestehen lokal. Der strenge
Release-/Test-Typecheck umfasst 3.664 Prüfdateien und 8.954 Quellen ohne Fehler;
die anschließende CI- und Release-Abnahme dieses Schritts bleibt erforderlich.
Die installierte SDK-Abnahme für Apply/Status/Recover bleibt weiterhin offen;
die äußeren Key-REST-/MCP-Adapter sind im folgenden Abschnitt dokumentiert.

Die gemeinsame native Pfadsteuerung ist inzwischen auch an echte Key-Principals
angeschlossen. MCP und API-Key verwenden denselben Planner, Claim-Ablauf,
nativen Executor, Erneuerungs-/Abschlussablauf und dieselbe begrenzte
Ergebnisdarstellung; ihre tatsächlichen Principal-Handles und Prüfungen bleiben
getrennt. API-Keys übernehmen weder eine OAuth-/Session-Identität noch den
impliziten MCP-Originalimport. Dieser benötigt weiterhin einen eigenen
ausdrücklich berechtigten Importweg. Die vorhandene Workspace-Auswahlsperre
wird vor dem nativen Admission-/Owner-Ablauf freigegeben.
Ein fehlender Job liefert seine aktuelle Workspace-Faktensicht und stabile
Operationskennung nach demselben C1-/Snapshot-/C2-Lookup zurück. Eine zusätzliche
vorläufige Scope-Ausleihe ist dadurch nicht erforderlich; die bisherigen
numerischen und öffentlichen nullable Leser behalten ihre Rückgabeform.
Zehn echte PostgreSQL-Dienstgruppen prüfen Preview/Apply/Status/Recover für
Move mit/ohne physische Projektion sowie natives, physisches und gemischtes
Sammel-Delete. Sie bestätigen erhaltene Originalzustände/Dateibytes, Linkpflege,
unveränderte Historie bei Wiederholung, echte Rotation über die Eingangsgrenze,
fehlende Jobs und widerrufene Schlüssel, gesperrte MCP-Tools und Abbruch vor dem Start.
Der neue Diensttest gehört dauerhaft zum gesamten nativen Key-Pfadpaket.
Dieses vollständige Paket, elf registrierte MCP-Pfadgruppen einschließlich
verlorener COMMIT-Bestätigungen sowie zwölf MCP-Principal-Familien bestehen am
gleichen unveränderten Quellstand. Alle isolierten Datenbank-/Dateiressourcen
sind danach freigegeben. Release-TypeScript und die strenge erweiterte Prüfung
mit 3.667 Wurzeln/8.958 Quellen sowie ESLint bestehen. Die bisherigen 218
Runner-Einträge behalten ihre Quellwächter; der neue Eintrag ergänzt 35 echte
Quellabhängigkeiten. Dies ist eine Dienst-/Fixture-Abnahme; die folgende
Adapterprüfung ergänzt sie. Installiertes SDK, kompiliertes Image,
Gesamtbudgets und Release bleiben eigene offene Abnahmen. Review Center und
Undo bleiben ausgeschaltet.

Die getrennten Key-Routen `POST /api/documents/move` und
`POST /api/documents/delete` sowie beide registrierten MCP-Pfadtools sind jetzt
an diesen Dienst angeschlossen. REST akzeptiert den begrenzten CamelCase-V1-
Vertrag, MCP den vorhandenen strengen SnakeCase-Vertrag. Die aktuelle
Key-Authentifizierung läuft vor dem Lesen des HTTP-Bodys; gemischte Credentials
werden abgewiesen. Der strenge UTF-8-/Stream-Leser wird mit Copy geteilt,
während jede Aktion ihre Fehlerfamilie und Größenregel behält. Nur die exakten
neuen Routen umgehen das Proxy-Body-Buffering; benachbarte APIs behalten ihren
Schutz. Die echten MCP-Schemas beider Protokollversionen werben die neuen
Key-Aktionen und ihre zusätzlichen Status-/Recover-Rechte aus, ohne implizite
Originalimport-Vorschauen zu veröffentlichen.
Sechzehn echte REST-/registrierte-MCP-/PostgreSQL-Gruppen bestehen. Sie führen
Move und Delete jeweils für native, rein native, physische PDF- und gemischte
Ordner aus; native Originalzustände, Dateibytes beim physischen Move, Linkpflege, unveränderte Historien
einschließlich `xmin`, Rotation und die gleichen Aufruferkennungen bleiben
erhalten. Vier Fälle verlieren tatsächlich die Claim- oder Abschluss-COMMIT-
Bestätigung und prüfen lesenden Status sowie ausdrückliches Recover derselben
Operation. Fehlende Jobs, Rechte-/ACL-Entzug, versteckte MCP-Pfade, gemischte
Credentials, abgeschaltete Tools und echter Schlüsselwiderruf bleiben
begrenzte Ablehnungen. Die acht bestehenden nativen Copy-Adaptergruppen und
elf OAuth-MCP-Pfadgruppen bestehen ebenfalls. Vier zusätzliche Read-/Browse-
Gruppen des installierten SDKs über echtes TCP/HTTP bestehen am selben
Produktstand mit dem unveränderten Wheel und Python 3.14.3. Dies ist eine
Regression der bisherigen Lesezugänge; die endgültige aktuelle/minimale
Python-Matrix und die SDK-Pfadabnahme bleiben offen. Alle vier isolierten
Fixtures geben ihre Schemas, Daten und Clients vollständig frei.
Release-TypeScript und der strenge erweiterte Test-Typecheck mit 3.674 Wurzeln/
8.972 Quellen sowie ESLint bestehen. Die Typkorrekturen am neuen Adaptertest
erzeugen bytegleiches ESM/CommonJS; die bestehenden Laufzeit-Assertions bleiben
erhalten. Die bisherigen 219 Runner-Einträge behalten alle Quellwächter; Copy
erhält den neuen gemeinsamen Leser als zusätzlichen Wächter und der neue
Pfad-Adaptertest prüft 46 echte Eingangsquellen. Der neue Test gehört dauerhaft
zum nativen Key-Pfadpaket, der Stream-Lesertest zur regulären Key-Suite.
Die folgende SDK-Pfadprüfung ergänzt diese Adapterabnahme. Aktuelle Image-/UI-
Abnahme, die vollständige API-/SDK-Matrix, dedizierte CI und die übrigen
vereinbarten Pakete bleiben weiterhin offen; dies ist keine Release-Abnahme.

Der neue installierte SDK-Pfadtest führt die vorhandenen Python-Methoden
Preview/Apply/Status/Recover über echte TCP-/MCP-Anfragen aus. Der isolierte
Client prüft Wheel-/Installationshashes und alle acht Laufzeitdateien gegen den
aktuellen Checkout; er erhält den API-Key ausschließlich über den Eingabekanal
und keine Datenbank-, Session- oder OAuth-Zugangsdaten. Der Messhelfer behält die
vorhandenen Copy-Zähler bei und erfasst Move/Delete getrennt nach Tool,
Aufruferkennung und Aktion, ohne Anfragen oder Antworten zu ersetzen.
21 Gruppen bestehen auf Python 3.14.3 mit dem unveränderten geprüften Wheel:
113 Key-Anfragen, 14 dauerhafte Operationen, zwei tatsächlich verlorene HTTP-
Antworten und vier tatsächlich verlorene Claim-/Abschluss-COMMIT-Bestätigungen.
Native, rein native, physische PDF-/PNG- und gemischte Ordnerinhalte behalten
ihre Originalzustände/Bytes; Linkpflege, native Papierkorbzustände und
ursprüngliche Historien einschließlich `xmin` bleiben geprüft. Dieselbe
Aufruferkennung für Move und anschließendes Delete besitzt getrennte echte
Operationskennungen. Rotation, Rechte-/Allowlist-/ACL-Entzug, abgeschaltete
MCP-Tools und echter Widerruf bleiben wirksam. Ein API-Key funktioniert nach
dem tatsächlichen Logout seiner ausstellenden Browser-Session weiter.
Bei verlorener HTTP-Antwort beendet der offizielle MCP-Client den wartenden
Task mit `CancelledError`; beim Schließen folgt die Gruppe mit dem echten
Transportfehler. Das entspricht dem bestehenden SDK-Vertrag und dessen
Abbruchtests: Cancellation wird nicht in einen gewöhnlichen Fehler
umklassifiziert. Der neue Test verlangt entweder den unveränderten typisierten
Unknown-Outcome-Fehler oder genau diesen erhaltenen Abbruch mit echtem HTTP-
Transportfehler. In beiden Fällen müssen die vor dem Await gespeicherte
Aufruferkennung, der Plan und die Originalpfade erhalten bleiben; Status und
ausdrückliches Recover bestätigen dieselbe dauerhafte Operation. Kein
Schreibaufruf wird automatisch wiederholt.
Die acht bestehenden installierten Copy-SDK-Gruppen bestehen nach der
Messhelfer-Erweiterung ebenfalls über echtes HTTP, einschließlich verlorener
HTTP-/B1-Bestätigung. Beide isolierten Datenbank-/Datei-/Client-Kontexte werden
vollständig freigegeben. Die neue Pfad-Suite gehört dauerhaft zum nativen
SDK-Gesamtpaket; alle bisherigen 220 Runner-Einträge behalten ihre Quellwächter,
der neue Eintrag ergänzt 44 echte Eingangsquellen.
Python 3.14.3 ist hier ein Zwischenstand. Die endgültige Matrix umfasst weiter
die deklarierte 3.10-Kompatibilität und die tatsächlich aktuelle stabile
Version, mit frisch gebauten/prüfbaren Artefakten. Für den Stand vom 01.11.2026
sind dies 3.10.22 und 3.15.2 laut der
[Python-Downloadseite](https://www.python.org/downloads/). Die neuen Selected-Block-/
Dokument-URL-Verträge aus Main, vollständige Auth-/UI-/Image-Abnahme,
dedizierte CI und die übrigen Gesamtpakete bleiben offen. Review Center und
Undo sind bei der neuen SDK-Pfadprüfung ausgeschaltet.

Die Workspace-Liste ist inzwischen unter `GET /api/workspaces` für den
ausdrücklichen Key-Zugang und als MCP-`list_workspaces` angeschlossen. Vier
Route-/PostgreSQL-/Protokollgruppen prüfen die begrenzten Metadaten, den
unveränderten Session-Vertrag, 401/403, aktuelle Archivierung und Widerruf.
Der tatsächliche Next.js-Proxy delegiert ausschließlich den begrenzten Key-
Kandidaten für dieses exakte GET an die Route. Der native Adaptertest umfasst
diesen Proxy vor der echten Schlüsselprüfung; die reguläre Key-Suite prüft
zusätzlich die Abweisung benachbarter Methoden und geschützter APIs.
Der installierte SDK-HTTP-Runner prüft jetzt auch `CanvasNotebook.list_workspaces()`.
Er prüft darüber hinaus Übersicht, mehrseitigen Baum und das neue begrenzte
`CanvasNotebook.get_manifest()` mit getrennten Hash-/Coverage-Feldern und
Fortsetzung nach Schlüsselrotation. Das aktuelle Wheel
`900425d9719fc276a137778ab6b40118f778b33ef6fe3b72ee6a3015019441a1`
besteht unter beiden Python-Versionen dieselben vier realen HTTP-/PostgreSQL-
Gruppen mit jeweils 26 ausschließlich per Key authentifizierten Requests.
Der echte Server weist den alten und den widerrufenen Schlüssel jeweils mit
HTTP 401 ab; alle drei Browse-Werkzeuge verweigern entzogene Leserechte.
Originale Dokumentdaten bleiben unverändert. Die kompilierte Container- und
vollständige Schreib-/Recovery-Abnahme bleiben offen.
Baum, Übersicht und Manifest sind in `488fee094` an
`POST /api/documents/browse` für echte Session-/Key-Anfragen und an die drei
entsprechenden MCP-Key-Werkzeuge angeschlossen. Fünf echte PostgreSQL-/Route-/
Protokollgruppen prüfen die exakte Proxy-Grenze, begrenzte Eingaben, Sichtbarkeit,
beide MCP-Protokolle und veröffentlichte Schemata, getrennte physische/native
Hashes, Pagination, veraltete Cursor, aktuelle Rechte und Widerruf. Originale
Dokument-/Yjs-/Metadaten-/Revisions-/Projektionszeilen einschließlich `xmin`
bleiben unverändert. Beleg ist der dauerhafte Runner
`scripts/api-key-workspace-browse-adapters-postgres-test.ts` im Workspace-Paket.
Die drei vorhandenen Key-Dokument- und fünf Workspace-Suiten sowie die echten
Session-Read-/Search-Service-Suiten, HTTP-Grenzprüfung, Release-Typecheck und
gezieltes ESLint bestehen. Die oben separat belegte installierte SDK-Browse-
Abnahme ersetzt die kompilierte Container-Abnahme nicht.
Ihre bisherigen Datenleser für Übersicht, Baum/Links und Datei-/Native-Hashes
liegen nun gemeinsam in `documents/workspace-browse.ts`. Die bestehenden
OAuth-Werkzeuge verwenden diese Helfer mit unveränderten Auth-/Audit- und
Fehlergrenzen. Der echte OAuth-/PostgreSQL-Runner prüft alle drei Lesewege,
einschließlich Sichtbarkeit, Links, Hashes, Cursor-Änderungen und Widerruf.
Die dafür getrennten API-Key-Browse-Principals besitzen feste Zwecke für Baum,
Übersicht und Manifest. Vier weitere PostgreSQL-Gruppen prüfen deren aktuelle
Lesegrenzen, exakte MCP-Toolschalter, Zweck-/Familientrennung, gefälschte und
abgelaufene Handles sowie Rechteentzug/Archivierung/Widerruf. Die bisherigen
nativen Dokument- und Workspace-Suiten bleiben grün.
Die Verwaltungs- und Anmeldeprüfungen ersetzen deren
vollständige Abnahme nicht. Erster Umfang sind benutzergebundene
Integrationen. Eine zusätzliche Servicekonto-/Rollenverwaltung gehört nicht zu
diesem Schritt. Vor dem Adapterumbau werden Aufrufer und Auswirkungen mit
GitNexus geprüft; gemeinsame Regeln bleiben im vorhandenen Berechtigungsdienst.

**Verwaltung und Schlüssellebenszyklus:**

- Unter **Settings → Verbindungen → API-Zugriff**, neben MCP und Integrationen,
  einen Bereich für benannte Integrationen und deren Schlüssel vorsehen.
  Erstellen, Auflisten, Rotieren und Widerrufen
  verlangen eine echte aktuelle Benutzersitzung und die passende Berechtigung;
  bei Veränderungen gelten die bestehenden Origin-/CSRF-Prüfungen. Ein API-Key
  darf keine neuen Schlüssel erzeugen oder sich selbst mehr Rechte erteilen.
- Jede Integration erhält eine stabile Identität, einen Eigentümer, eine
  explizite Workspace-Liste und freigegebene Aktionen. Neue Workspaces werden
  nicht automatisch zugänglich. Lesen/Suchen sind getrennt von Schreiben;
  Copy, Move, Delete und deren Status-/Recovery-Zugänge werden ausdrücklich
  zugeordnet. Voreinstellung ist Lesezugriff ohne Schreibfreigabe.
  Die serverseitig geprüfte Instanzbindung verhindert, dass importierte
  Schlüssel einer fremden Installation automatisch Zugang erhalten.
- Jeder Schlüssel besitzt eine eigene Kennung, Erstellzeit, Ablaufdatum,
  Widerrufsstatus und eine begrenzt aktualisierte letzte Nutzung. Die UI zeigt
  nur Kennung/Präfix und Metadaten; ein kryptographisch zufälliges Geheimnis mit
  mindestens 32 Zufallsbytes wird bei Ausstellung genau einmal ausgegeben.
  Beim Deploy oder Containerstart wird kein globaler Zugangsschlüssel erzeugt.
- Der Server speichert nur einen kryptographischen Hash des Geheimnisses und
  die autoritativen Zuordnungen, niemals den wiederlesbaren Vollschlüssel.
  Authentifizierungsdaten liegen im serverseitigen Auth-Speicher. Benötigt ein
  Canvas-interner Client den Vollschlüssel, verwendet er den bestehenden
  Secrets-Service und `Canvas-Secrets.env` im passenden Berechtigungsbereich;
  es entsteht keine weitere ENV-Datei. Externe Clients verwenden ihren eigenen
  Secret-Speicher oder OS-Keyring. Keine Schlüssel in URLs, Local Storage,
  Logs, Screenshots, Dokumentinhalten oder ausgelieferten Browser-Bundles.
- Rotation stellt ein neues Geheimnis für dieselbe Integration aus und
  widerruft das alte atomar. Eigentümer und stabile Integrationsidentität der
  bisherigen Operationsbelege bleiben erhalten. Der neue Schlüssel darf deren
  Status/Recovery nur unter aktuellen passenden Rechten beobachten/fortsetzen;
  eine andere Integration desselben Benutzers erhält daraus keinen Zugriff.
  Geht die Ausstellungs-/Rotationsantwort verloren, werden Metadaten geprüft
  und ein unbekannter neuer Schlüssel gezielt widerrufen; die UI erzeugt
  nicht automatisch weitere Schlüssel und kann das Geheimnis nicht nachladen.
- Widerruf, Ablauf, Kontosperre, verlorener Seat und entzogene Workspace-Rechte
  wirken an der nächsten erforderlichen aktuellen Prüfgrenze, auch bei einer
  bestehenden HTTP-/MCP-Verbindung. Dokumente und Operationsbelege werden durch
  Rotation oder Widerruf nicht gelöscht. Unsichere Schreibausgänge bleiben
  anhand ihrer ursprünglichen Belege aufklärbar.

**Anschluss an REST und SDK:**

- Den eigenen Header `X-Canvas-API-Key` für explizit unterstützte Dokument- und
  Workspace-Endpunkte sowie den SDK-Zugang an `/mcp` verwenden. Session-Bearer
  und OAuth-Bearer behalten ihre bisherigen Verträge. Gleichzeitige
  widersprüchliche Zugangsdaten werden abgewiesen; fehlgeschlagene Schlüssel
  fallen nicht auf einen anderen angemeldeten Benutzer zurück.
- Ein geprüfter Schlüssel erzeugt einen ausdrücklich typisierten API-Key-
  Principal aus den tatsächlichen serverseitigen Daten. Keine fingierte
  Better-Auth-Sitzung, kein fingierter OAuth-Grant und kein genereller Zugriff
  auf andere Notebook-APIs. Admin-, Benutzer- und Secrets-Verwaltung bleiben
  außerhalb dieser Dokumentfreigabe.
- Effektive Rechte sind die Schnittmenge aus Schlüsselaktionen, Workspace-
  Freigaben, aktuellen Benutzer-/Seat-/Organisationsrechten und vorhandenen
  Funktions-/Toolschaltern. Normale Dokumentversions-, Schema-, Sperr-, Claim-
  und COMMIT-Prüfungen gelten auch für API-Key-Aufrufe.
- Das Python-SDK erhält einen ausdrücklich auswählbaren `api_key`-Zugang neben
  OAuth beziehungsweise einem ausgestellten MCP-Token. Es verwendet denselben
  Header und dieselben zentralen Dokumentoperationen. Externe Verbindungen
  verlangen HTTPS; Loopback-Entwicklung bleibt möglich. Keine automatische
  Wiederholung unbestätigter Änderungen durch den neuen Auth-Adapter.
- Für jede unterstützte Operation REST-Endpunkt, MCP-Tool und SDK-Methode
  verbindlich zuordnen. Bisher nur über MCP angebotene, bereits implementierte
  Dokumentoperationen erhalten bei Bedarf einen dünnen REST-Adapter. Fehlende
  Adapter werden als offene Arbeit ausgewiesen; es entsteht keine zweite
  Speicher-, Yjs-, Link- oder Recovery-Engine.
- Authentifizierung und aktuelles Berechtigungslesen pro notwendiger Phase
  bündeln. Nutzungsstatistik darf keine zusätzliche Schreibkette je
  Unteraufruf erzeugen. Rate Limits gelten serverseitig pro Schlüssel und
  Benutzer sowie für unauthentifizierte Zugriffe; bei mehreren Prozessen
  dürfen sie nicht durch einen anderen Worker umgangen werden.

**Fertig:** Ein über die wirkliche Verwaltungsoberfläche ausgestellter Schlüssel
kann ohne Browsersitzung über REST und das installierte SDK genau die erlaubten
Aktionen ausführen. Abgelaufene/ungültige Schlüssel liefern 401, fehlende aktuelle
Rechte 403 und ausgeschöpfte Limits 429; bestehende Fachkonflikte behalten ihre
Codes. Ausgabe, Speicherung, Rotation, Widerruf und Audit-Metadaten sind mit
echten Requests und Datenbankbeobachtungen geprüft. Ein DB-Fehler verweigert den
Zugriff; erfolgreiche Berechtigungen werden nicht über Phasengrenzen gecacht.

**SDK-Vertragsabgleich, 01.11.2026:** Die öffentlichen Python-Lesemethoden nehmen
auch `edit_target_block_id` an. Eine einzelne Blockauswahl verlangt native
Edit-Targets und die vollständige beobachtete Version. Bei `read_all` bleiben
Auswahl und Version auf jeder Cursorseite gleich; eine leere Zielliste bleibt
ein tatsächliches Serverergebnis. Der installierte HTTP-Test prüft zusätzlich
einen absichtlich mit anderer Blockauswahl verwendeten Cursor. Der öffentliche
Edit-Ergebnistyp enthält nun `document_url`; der echte Edit-/Status-Test prüft
die konfigurierte Notebook-Adresse sowie Workspace-, Dokument- und Lineage-ID
statt eines behaupteten aktuellen Pfads. Angaben zur vollständigen Abnahme
bleiben von diesen einzelnen Vertragsprüfungen getrennt.

Die lokale Paketmatrix besteht unter Python 3.10.22 und 3.15.2: Wheel und
Quelldistribution jeweils als Core-, MCP- und Keyring-Installation, zwölf
Kombinationen. Jede Installation gleicht die acht Laufzeitdateien mit dem
Arbeitsstand ab. Core bleibt ohne optionale Abhängigkeiten importierbar; jedes
Adapterprofil besteht 83 mechanische Tests. Auf beiden Versionen bestehen
zusätzlich die fünf echten HTTP-/PostgreSQL-SDK-Pakete mit jeweils 46 Gruppen
und 255 Key-Requests. Diese Gesamtläufe sind an ihr aufgezeichnetes erstes
Wheel gebunden. Nach dem abschließenden Abgleich der ECMAScript-Leerzeichen
im lokalen Block-ID-Guard wurden Wheel/Quelldistribution neu gebaut, alle zwölf
Installationen und die betroffenen echten Read-/Cursorfälle auf beiden
Versionen erneut geprüft. Im Wheel ändern sich dabei ausschließlich
`documents.py`, Metadaten und deren Dateiliste; die übrigen sieben
Laufzeitdateien bleiben bytegleich. Kein automatisches Mutation-Replay.

Die erweiterte Typprüfung enthält alle geänderten PR-TypeScript-Dateien und
Produktquellen: 3.718 Wurzeln, 9.048 Quellen, null Fehler. Veraltete Testtypen
wurden ohne neue Skips oder schwächere Assertions korrigiert. Die fünf
betroffenen nativen PostgreSQL-Pakete bestehen mit 37 Gruppen; die
Verwaltungs-UI-Prüfung besteht ebenfalls. Das ersetzt weder die abschließende
kompilierte Browser-/OAuth-/Keyring-Abnahme noch `test:all`, die Gesamtfluss-
Leistungsbudgets oder die spätere Veröffentlichung.

**Vorhandene Originaldateien – erster Integrationsschritt, 01.11.2026:**
Der bestehende explizite Import verlangt `expectedFileVersion`; der bisherige
Manifest-`revision` ist dagegen eine Inhaltsrevision (`sha256:…`). Das
gemeinsame Manifest liefert nun zusätzlich `file_version` aus demselben
geöffneten, vor/nach der Hashbildung und am Pfad geprüften Dateihandle. Es
entsteht keine zusätzliche Datenbankabfrage oder zweite Dateilesung. Bei nicht
verfügbaren, zu großen oder nicht materialisierten Originaldateien bleibt der
Wert `null`; ein nativer Dokument-Hash ersetzt ihn niemals. Ein atomarer
Austausch durch bytegleiche Dateien behält SHA/Revision und ändert die
physische Version. Der Wert ist Vergleichsdaten, keine Importberechtigung.

Die echte OAuth-Manifestprüfung, die sechs Key-/Session-/Protokollgruppen und
das installierte SDK auf Python 3.10.22/3.15.2 bestehen. Jede SDK-Prüfung hat
39 echte Key-Requests und zwei tatsächliche 401-Antworten; die acht SDK-
Laufzeitdateien bleiben unverändert. Alle vier eigenen PostgreSQL-Fixtures
sind geschlossen und entfernt; Produkt-/PR-Typprüfung und ESLint bestehen.
Der tatsächliche Key-Schreibzugang und seine unveränderliche historische
Zuordnung bleiben der nächste Schritt. Die bestehende V1-Historie verlangt
eine reale Session-ID; sie darf dafür weder umgedeutet noch durch eine
erfundene Session ergänzt werden. Aktuelle Import-/Statusrechte und eine
eigene versionierte Key-Zuordnung müssen vor dem gemeinsamen Writer greifen.

**Originaldatei-Import – eigene Key-Berechtigungsphasen, 01.11.2026:** Die
interne Principal-Familie unterscheidet `import_existing` und
`import_existing_status`. Beide verlangen den aktuellen `import`-Grant sowie
Write-/Agent-Rechte; expliziter Status zusätzlich `status`. Ein Read-,
Create-/Upload-Import-, Edit-, Browse-, Copy- oder Move/Delete-Handle kann sie
nicht ersetzen. MCP verwendet den bestehenden, tatsächlich eingeschalteten
`import_knowledge_file`-Schalter; die spätere Originaldatei-Variante wird streng
von einem neuen Upload unterschieden. HTTP behält seinen eigenen Key-Zugang.

Die Phasen verwenden dieselben tatsächlichen Key-/Seat-/Workspace-Snapshots,
SQL-Realm-, Transaktions-, Laufzeit- und Sperrprüfungen. Herkunftsdaten enthalten
Benutzer, Integration, Instanz und Credential, keine Session. Acht echte
PostgreSQL-Gruppen prüfen Grants/Rollen, Familienisolation, ungültige und nicht
mehr aktive Handles, MCP-Entzug, eine tatsächlich blockierte Gegenverbindung,
Realm-Manipulation, erneute Rechteprüfung zwischen Transaktionen und echte
Rotation/Logout/Widerruf. Ein Phasenlauf mit zwei zusätzlichen aktuellen
Prüfungen bleibt bei neun SQL-Anweisungen. Diese Berechtigungsbasis ist noch
kein angeschlossener Originaldatei-Writer oder öffentlicher Import-Endpunkt.
Die vollständige bestehende native API-Key-Suite besteht nach dieser Änderung:
29 seriell ausgeführte Kommandos, darunter 26 echte PostgreSQL-Integrations-
einstiege. Der eigene neue Einstieg ist darin dauerhaft enthalten; alle
bisherigen Runner-Einträge und ihre Eingabearrays bleiben unverändert.

**Originaldatei-Import – gemeinsamer Writer mit echter Key-Zuordnung,
01.11.2026:** Der interne Key-Zugang ist jetzt an denselben Originaldatei-
Bootstrap angeschlossen. Datei-/FD-Erwartung, bestehende pristine Dokument-ID,
Lineage, Historien-/Quarantäne-/Raumprüfungen, Kernel-/Admission-Sperren und
nativer Yjs-Writer bleiben gemeinsam. Auch die getrennten Owner-/Mutations-
Verbindungen und die Transaktionssteuerung verwenden einen gemeinsamen Kern.
Die tatsächliche Key-Phase weist zuerst ihren unveränderten SQL-Realm nach
und setzt anschließend den vorhandenen festen Receipt-Suchpfad. Eine Key-
Identität wird weder als Session-Request noch als Upload-Import ausgegeben.

Eine additive unveränderliche V2-Tabelle bindet die tatsächliche Key-Herkunft
an den bestehenden nativen Import-Receipt. V1-Session-Belege und ihre Guards
bleiben erhalten; die native Receipt-Tabelle bleibt das alleinige Importjournal.
Der interne Operationsschlüssel bindet Benutzer, Integration, Instanz,
Workspace und die vom Aufrufer gewählte Operation. Rotation und ein anderer
Einstieg ändern ihn nicht; das ursprünglich verwendete Credential wird nicht
umgeschrieben. Status und Wiederholung lesen den ursprünglichen Beleg vor
jedem aktuellen Dateizugriff. Ein nativer Receipt ohne seine atomare Key-
Zuordnung ist ein Fehler und löst keinen erneuten Import aus. Historische
HTTP-Pfade aus ausgeblendeten Verzeichnissen werden über MCP nicht offengelegt.
Eine verlorene COMMIT-Antwort wird ausschließlich unter erneuter tatsächlicher
Key-Berechtigung historisch bestätigt; ein Widerruf blockiert diese Bestätigung.

Dreizehn echte PostgreSQL-/Key-/Datei-Gruppen bestehen: unveränderte BOM-/CRLF-
Originalbytes und physische Version, Session-freie Herkunft, Rotation,
unveränderliche Wiederholung/Status, Konflikte und fremde Integration,
pristine Identität und beide Rich-Formate, spätere fehlerhafte physische
Ersetzung, Import ohne Read/Create, MCP-Pfadgrenze, bytegleicher Dateiaustausch,
PG-Guards, atomarer Rollback, ein tatsächlich Session-eigener nativer Beleg ohne
Key-Zuordnung und zwei tatsächliche verlorene COMMIT-Antworten.
Die bisherigen Session-Importe bestehen mit sieben Gruppen, ihre HTTP-
Handler mit sieben weiteren und der originale Bootstrap mit 29 tatsächlichen
Auth-/Team-/PG-/Dateisystem-Familien. Die reguläre Key-Suite einschließlich
Verwaltungs-UI besteht; die strenge Typprüfung umfasst 3.727 Wurzeln und
9.057 Quellen ohne Fehler. Die neuen öffentlichen REST-/MCP-Adapter und die
installierte SDK-Originaldatei-Abnahme sind weiterhin offen. Die vollständige
native Key-Suite besteht mit 30 seriellen Kommandos, darunter 27 echte
PostgreSQL-ESM-Suiten; alle 27 eigenen Bundles und Schema-/Client-/Daten-Fixtures
sind entfernt. Sämtliche 219 bisherigen Runner-Einträge und ihre Eingabearrays
bleiben unverändert; ein neuer Einstieg und ein natives Kommando kommen hinzu.
Diese interne
Integration ist noch kein veröffentlichtes Release oder Gesamtfluss-Budget.

**Originaldatei-Import – öffentlicher REST-Key-Zugang, 01.11.2026:** Die
bestehenden `/api/documents/import-existing`- und `/status`-POST-Routen
verwenden bei vorhandenem `X-Canvas-API-Key` den echten Key-Zugang. Ein leerer,
ungültiger oder mit Cookie/Bearer vermischter Key fällt nicht auf eine Session
zurück. Ohne Key bleiben die vorhandenen Session-Pfade erhalten. Beide
Zugänge liefern dieselben begrenzten ursprünglichen Importfakten und die
Operations-ID des Aufrufers; interne Key-Zuordnung und native Receipt-Felder
werden nicht als Autorität oder aktueller Dokumentstand ausgegeben. Key-
Fehler und Rate-Limits behalten stabile Codes und begrenzte Retry-Header.

Acht neue echte TCP-/HTTP-/PG-Gruppen bestehen mit 27 Anfragen. Sie prüfen
Import, danach tatsächliches natives API-Lesen und -Bearbeiten, unveränderte
Importhistorie trotz Bearbeitung, Rotation, Grant-Grenzen, gemischte und
ungültige Zugangsdaten, strikte Body-/UTF-8-/Größenprüfung, eine tatsächlich
verlorene HTTP-Antwort mit anschließendem Status/Retry sowie Widerruf. Beide
eigenen Fixtures schließen; die bisherigen sieben Session-HTTP-Gruppen und
die reguläre Key-Suite einschließlich Verwaltungs-UI bleiben grün. Typprüfung:
3.728 Wurzeln, 9.058 Quellen, null Fehler; ESLint besteht. Der neue Einstieg
ergänzt die native Gesamtsuite dauerhaft; alle 220 bisherigen Runner-Arrays
und 30 bisherigen nativen Kommandos bleiben unverändert. Das ist eine echte
HTTP-/Handler-Abnahme, keine kompilierte Next-/Browser- oder installierte
SDK-Abnahme. Die MCP-Originaldatei-Variante und das SDK bleiben der nächste
Schritt; die abschließenden Gesamt-, CI-, UI- und Release-Gates bleiben offen.

**Originaldatei-Import – MCP-Key-Adapter, 01.11.2026:** Das vorhandene
`import_knowledge_file` erhält in seiner Key-Definition die strikten Aktionen
`import_existing` und `status_existing`. Import verlangt `api_version:1`,
`workspace_id`, einen sichtbaren relativen Markdown-Pfad, eine stabile
`operation_id` und die tatsächliche `expected_file_version` aus dem Manifest.
Status verlangt ausschließlich Version, Aktion, Workspace und dieselbe
Operations-ID. Upload, Original-Import und Status sind getrennte exakte
Schema-Zweige; ihre Felder dürfen nicht gemischt werden. Der vorhandene
Upload ohne `action` bleibt erhalten. Die Key-Create-/Upload-Metadaten
verlangen jetzt auch das ohnehin im Writer erforderliche `content`/`file`;
die dort nicht unterstützten OAuth-Upload-Aktionsfelder werden nicht mehr
im Key-Schema angekündigt. Die OAuth-Upload-Definition bleibt unverändert.

Der Adapter ruft den gemeinsamen Original-Owner mit echtem Key und Einstieg
`mcp` auf. Er verwendet den vorhandenen Import-Schalter und dieselben
begrenzten öffentlichen Importfakten/Fehler wie REST. Es entsteht weder ein
paralleler Import-Schalter noch eine rekonstruierte Session oder ein Upload-
Grant für bestehende Dateien. Elf echte PG-/MCP-Handler-Gruppen bestehen
mit 41 JSON-RPC-Anfragen über die Protokolle 2025-11-25 und 2026-07-28:
Schema/Argumente, tatsächliches Manifest → Import → natives Lesen/Bearbeiten,
historischer Status nach Bearbeitung, Rotation und REST-Status, Feld-/Tool-
Konflikte, versteckte HTTP-Originale, Import-/Statusrechte und Schalterentzug,
tatsächlicher COMMIT-Antwortverlust, abgelaufene Aussteller-Session und echter
Key-Widerruf. Der erste Testlauf hatte ein zusätzliches `api_version` beim
bestehenden MCP-Lesen gesendet; der Test wurde an dessen strikten Vertrag
angepasst, der Produkt-Leser bleibt unverändert. Die eigenen Ressourcen
schließen vollständig. Die reguläre Suite, ESLint und strenge Typprüfung
(3.731 Wurzeln/9.061 Quellen, null Fehler) bestehen. Das ist eine echte
Handler-/Protokoll-/Datenabnahme; installierter MCP-Client, SDK, kompilierte
UI und abschließende Gesamtmatrix bleiben eigene verpflichtende Gates.
Die vollständige native Key-Suite besteht auf diesem MCP-Stand mit 32
seriellen Kommandos, darunter 29 echte PG-ESM-Suiten und die zwei weiteren
nativen Verwaltungs-/Authentifizierungs-Fixtures. Alle 29 eigenen Bundles
und Schema-/Client-/Daten-Fixtures sind entfernt. Die bisherigen 221 Runner-
Arrays und 31 nativen Kommandos bleiben unverändert. Die neue Scopeprüfung
weist neun Dateien/48 Symbole/sieben MCP-Abläufe und HIGH aus; der vollständige
PR-Vergleich umfasst 202 Dateien/1.831 Symbole/43 Abläufe und CRITICAL. Der
breitere Dispatcher-Umfang wurde vor dem Commit ausdrücklich benannt.

**SDK-Originalimport über den vorhandenen MCP-Transport.** Die Python-Fassade
ergänzt `import_existing_markdown` und `original_import_status` auf demselben
`import_knowledge_file`-Werkzeug. Sie verlangt die tatsächliche Key-Fähigkeit,
einen vor dem Await aufbewahrten Caller-Auftrag und die exakte physische
`file_version` aus dem Manifest. Uploads und bestehende Originale bleiben
getrennte Verträge. Fünf exportierte Typen kennzeichnen die unveränderlichen
Initialfakten; eine spätere Bearbeitung verwendet eine frische native Leseversion.
Eine fehlerhafte Vergleichsantwort bleibt als vollständiges Original erhalten
und löst keinen erneuten Import aus. Transportfehler behalten den ursprünglichen
Caller im bestehenden Unsicherheitsfehler; Task-Abbruch wird weitergereicht.
Die Fassade erzeugt keine Schlüssel und rekonstruiert keine Session.

Neun neue mechanische Testgruppen prüfen genaue Argumente und Rückgabetypen,
Unicode/Dateinamens-Leerzeichen, UTF-16-Grenzen, lokale Ablehnung vor dem
Transport, unveränderte Fehler-/Abbruchobjekte und fehlerhafte Initialfakten.
Zwölf frische Wheel-/Sdist-Installationen bestehen auf Python 3.10.22 und
3.15.2 in den Profilen Core, MCP und MCP/Keyring: alle acht Laufzeitdateien
stimmen mit der Quelle überein, Core bleibt ohne Adapterabhängigkeiten ladbar,
jede Adapterinstallation besteht alle 92 Tests.

Der dauerhafte Runner `test:api-keys:sdk:original-imports:native` verwendet den
vorhandenen echten HTTP-/MCP-Fixture und den nativen PG-/Room-Owner. Sieben
Gruppen prüfen Manifest → Originalimport → natives Lesen/Bearbeiten, eine
vorregistrierte nie initialisierte Identität, unveränderliche historische
Belege nach Bearbeitung und Rotation, aktuelle Import-/Statusrechte,
Dateiversions-/Auftragskonflikte, Aussteller-Logout und echten Widerruf.
Eine Antwort wird erst nach belegtem Commit beider Originalbelege verworfen.
Der tatsächliche Transport kann dabei einen Abbruch mit gebündelter
HTTP-Transportursache melden; der Test erhält das konkrete Fehlerobjekt und
den vollständigen Auftrag. Vor einer ausdrücklich aufgerufenen Statusabfrage
und Wiederholung gibt es genau einen Importaufruf. Die ursprünglichen Belege
bleiben bytegleich; das unbeteiligte native Dokument bleibt unverändert.

Die gesamte installierte SDK-Suite besteht auf Python 3.10.22 und 3.15.2 mit
je sechs seriellen Bereichen und 53 Gruppen. Beide Prozesse beenden sich mit
Exit 0; alle zwölf eigenen Bundles und zehn Metadaten-Owner-Fixtures sind
vollständig entfernt. ESLint und die strenge Typprüfung mit 3.732 Wurzeln/9.062 Quellen
bestehen mit null Fehlern. Alle bisherigen Runner-Einträge bleiben unverändert;
der SDK-Aggregator hängt ausschließlich den neuen Originalimport-Runner an.
Die kompilierte UI, echte OAuth-/OS-Store-Gesamtabnahme, portable CI-Gates und
Release-/Produktionsabnahme bleiben die folgenden verpflichtenden Schritte.

#### Abnahme der tatsächlichen Next.js-Routengrenze

Die CI am Stand `b3af2d889` besteht einschließlich der nativen PostgreSQL-Tests,
zwölf frischen SDK-Installationsprofilen und je 53 echten SDK-/HTTP-Testgruppen
unter Python 3.10.22 und 3.15.1. Auch der vollständige Host- und Linux-Build,
der frisch erstellte Container mit erfolgreicher Bootstrap-Anmeldung und die
vier Desktop-/Mobilfälle der Schlüsselverwaltung bestehen. Die geschützten
Originalzeilen einschließlich `xmin`, Quelldatei und Anker bleiben unverändert.

Die zusätzliche Prüfung am kompilierten Server findet jedoch einen eigenen
HTTP-Einstiegsfehler: Ein regulär ausgestellter Schlüssel funktioniert über
`/mcp`, wird aber bei Workspace-Liste und Dokumentanlage als `API_KEY_INVALID`
abgewiesen. Next.js reicht bei automatischer dynamischer Auswertung einen
Proxy-Request weiter; die strenge interne Credential-Grenze akzeptiert diesen
absichtlich nicht. Die früheren direkten Route-Tests erzeugten unverpackte
`NextRequest`-Objekte und erfassten diesen Unterschied nicht.

Workspace-Liste, Anlage/Import, Copy und Move/Delete übernehmen deshalb wie die
vorhandenen Read-/Edit-Adapter URL, Methode, Header und Abbruchsignal in einen
normalen Request. Der ursprüngliche Body bleibt beim begrenzten Stream-Leser.
Die Credential-Prüfung und sämtliche aktuellen Rechteprüfungen bleiben strikt.
Die vier betroffenen PostgreSQL-Adaptersuiten verwenden nun explizit umhüllte
Requests; ihre bestehenden positiven und negativen Gruppen bleiben erhalten.
Die unten dokumentierte erneute Abnahme des korrigierten kompilierten Servers
einschließlich echter OAuth-Ausstellung, macOS-Schlüsselbund, tatsächlichem
Tokenablauf und Zugriff aus einem separaten Prozess besteht inzwischen. Die
grüne CI allein ist ausdrücklich keine vollständige API-/SDK- oder Release-Abnahme.

#### Verifizierter Fixstand und dauerhafte Runner, 02.11.2026

Der im PR enthaltene Fixstand `a3ff44120` besteht alle 13 PR-Prüfungen, einschließlich
der vollständigen nativen API-/Agent-Prüfung und je sechs installierten SDK-/HTTP-
Familien mit 53 Gruppen auf Python 3.10.22 und 3.15.1. Alle zwölf frischen
Installationsprofile bestehen ohne Skips. Der korrigierte Host-/Linux-Build und
die frische einzelne Notebook-Runtime bestehen einschließlich tatsächlicher
Anmeldung und Originaldatenkontrolle. Die vorher mit `API_KEY_INVALID`
abgewiesene Workspace-Liste und Dokumentanlage funktionieren mit demselben
regulär ausgestellten Schlüssel nun auch am kompilierten Server.

Die vier Desktop-/Mobilfälle der Schlüsselverwaltung bestehen auf diesem Stand.
Das tatsächlich installierte Wheel führt echte Browserfreigabe/PKCE, Suche,
mehrseitiges Lesen sowie Create/Edit/Status aus; zwei offene Editoren und deren
Neuladen zeigen die Änderung. Nach dem tatsächlichen Ablauf des 15-Minuten-Tokens
erneuert der offizielle SDK-Provider den Token automatisch ohne zweite
Browserfreigabe. Ein unabhängiger Python-Prozess liest den erneuerten Zugang aus
dem wirklichen macOS-Schlüsselbund und führt einen geschützten HTTP-Aufruf aus.
Die eigene Verbindung und der eigene Seed-Key werden widerrufen, eigene
OS-Einträge entfernt und die vorherigen MCP-Einstellungen wiederhergestellt.
Originalzeilen/`xmin`, Inhalte und Anker bleiben unverändert. Das ist die Abnahme
dieser konkreten Fälle, nicht der vollständigen Matrix oder des Releases.

Die Fälle sind seit `9ba00fd2b` als
`test:api-keys:compiled` und `test:api-keys:sdk:oauth:compiled` dauerhaft integriert
und auf genau diesem gebauten Quellstand erneut bestanden.
Gemeinsame Testmechanik prüft Image-/Quellstand, private Eingaben und geschützte
Originale ausschließlich über reale Docker-/Read-only-PG-Beobachtungen.
OAuth-Zustimmung, Schlüsselverwaltung und sämtliche Änderungen bleiben echte
HTTP-Aufrufe. Alle vier Desktop-/Mobilfälle bestehen ohne Skips und Retries.
Auch expliziter Zugriff mit dem tatsächlich ausgestellten Bearer, dessen echte
Ablehnung nach Ablauf, automatische Erneuerung und unabhängiges Lesen des
erneuerten Schlüsselbund-Zugangs bestehen. Eigene Schlüssel, Grants und
OS-Einträge sind bereinigt und die vorherigen MCP-Einstellungen wiederhergestellt.
Fünf Harness-Schutzfälle, das reguläre Key-Vertragspaket und striktes TypeScript
bestehen. Host-/Linux-Build, frischer Start sowie Originalzeilen/`xmin`, Inhalte
und Anker sind geprüft. Das Wheel stimmt in allen acht Laufzeitdateien mit dem
Quellstand überein. Der konkrete erneute Runner-Lauf zählt als Nachweis;
ein früherer temporärer Probe-Erfolg wird nicht als dessen Ausführung gezählt.
[Aufruf und genaue Prüfgrenzen](testing/compiled-api-sdk-acceptance.md) sind
dokumentiert. Paket 4c, Gesamtabnahme und Release bleiben offen.

**Verbleibender operativer Blocker:** Ein zusätzlicher realer REST-/SDK-Lauf für
Copy, Move, Delete, Status und explizites Recover besteht einmal vollständig,
einschließlich sechs historischer Zugriffe nach Schlüsselrotation. Weitere Läufe
zeigen jedoch sporadische Vorschaufehler: zunächst Delete mit `PATH_UNAVAILABLE`,
später SDK-Move mit `INVALID_REQUEST`. Eine nicht pausierende Diagnose am echten
kompilierten Server belegt für den Move-Fehler `NATIVE_MOVE_PLAN_INVALID` beim
Erstellen des Quellnachweises; die innere Diagnose lautet
`NATIVE_SOURCE_EVIDENCE_INVALID`. Die genaue verletzte Bedingung ist noch nicht
identifiziert. Nachträglich lesend gesicherte Registry-/Yjs-Zustände sind
konsistent; wiederholte frische und gecachte Inspektionen derselben nativen Bytes
liefern identische, vollständige Linkinventare. Das erklärt den Laufzeitfehler
noch nicht. Der erfolgreiche Einzellauf schließt diese Regression nicht.
Fehlgeschlagene Vorschauen lösen kein Apply aus; Originaldaten bleiben erhalten.
Die temporären zusätzlichen Operationsläufe sind noch kein dauerhafter Runner.

Ein [reproduzierter Projektions-Race](architecture/document-source-projection-fence-2026-11-02.md)
ist anschließend lokal korrigiert: Die eigenständige Quellenbeobachtung hält
dieselbe vorhandene Workspace-Sperre wie der Projektionsschreiber, vor dem
SQL-Checkout bis nach Verbindungsschließung. Zwei echte Prozessfälle scheitern
vorher und bestehen nachher; die vier neuen Sperrfälle und insgesamt 40
Quellen-/Dateifälle bestehen. Zwei weitere Versuche mit echten lesenden
QA-PostgreSQL-Verbindungen liefern vollständige native Nachweise und erhalten
Originalzeilen/`xmin` sowie Bytes. Die 53 Collector-Fälle, ESLint und striktes
TypeScript bestehen ebenfalls. Der Collector auf einer vom Aufrufer gehaltenen
Verbindung bleibt unverändert. Die kompilierte Abnahme einschließlich echter
Projektion und die genaue Zuordnung aller bisherigen Laufzeitfehler bleiben
offen; der operative Blocker ist damit noch nicht geschlossen.

Die anschließende Prüfung der OAuth-MCP-Vorschau findet eine weitere fehlende
Sperre vor deren eigener Quellen-Transaktion. Der gemeinsame Service hält nun
auch dort die bestehende Workspace-Sperre; die UI-Einstiege halten sie bereits.
Der neue Regressionstest reproduziert den ungeschützten Einstieg. Die
erweiterte native MCP-Abnahme besteht nach der Korrektur 15 Gruppen über
tatsächlichen HTTP-Dispatcher, signierte Fixture-Tokens und PostgreSQL,
einschließlich paralleler Move-/Delete-Projektion, Widerruf und Recovery.
Native Zeilen, `xmin` und Bytes bleiben erhalten; die Ressourcenbereinigung
ist bestätigt. `test:mcp:path-tools:native` führt diese Prüfung dauerhaft aus
und ist im CI-Workflow ergänzt. Die gemeinsam verwendete Prozess-Testmechanik
behält die vier ursprünglichen Sperrfälle und alle 40 Quellen-/Dateifälle grün.
Die erneute kompilierte Browser-/OAuth-/SDK-Abnahme am neuen Stand bleibt offen.

Aktualisierter Prüfstand `974e4a162`: Alle 13 PR-Prüfungen sind abgeschlossen
und erfolgreich, einschließlich der nativen API-/Agent-Fälle und der frisch
installierten SDK-Prüfungen auf Python 3.10 und 3.15. Der Host-Produktionsbuild
besteht ebenfalls. Die dauerhafte Operationsprüfung ist nun als
`test:api-keys:sdk:operations:compiled` implementiert: zwei eigene Workspaces,
sechs REST-/SDK-Dateioperationen, vier eingehende Linkquellen, Rotation und eine
zusätzliche unabhängige REST-Statuskontrolle. Ihre acht Node-Schutzprüfungen und
zwei atomaren Python-Dateischreibfälle sowie das reguläre API-Key-Vertragspaket
bestehen. Der Runner selbst ist noch nicht am neuen gebauten Server ausgeführt;
die Schutzprüfungen führen keine API-/SDK-Dateioperation an diesem Server aus.
Der erneute Container-Nachweis, die vollständige Matrix, die reguläre
Gesamtsuite und das Release sind damit weiterhin nicht abgenommen.

Die anschließende Wiederherstellungsprüfung findet einen zusätzlichen
Integrationsfehler: Der portable PostgreSQL-Export lehnt auf dem echten
QA-Schema zunächst `canvas_api_integrations` und nach dessen Einordnung auch
`collaboration_original_markdown_import_api_keys` als unbekannt ab.
Die beiden Zugangstabellen sind nun explizit erhaltener Zustand der Zielinstanz;
Quellschlüssel werden nicht in portable Archive übernommen. Schlüsselgebundene
Originalimport-Zuordnungen werden wie die bisherigen sitzungsgebundenen
Originalimport-Zuordnungen zurückgesetzt. Dokumente, native Yjs-Zustände und
dauerhafte Dateiimportbelege behalten ihre bestehende Kopierregel.
Fünf neue echte PostgreSQL-Gruppen prüfen Exportausschluss, tatsächliche
Restore-Übernahme und Rollback mit unveränderten Zielschlüsselzeilen samt `xmin`,
zielseitige Benutzer sowie die Ablehnung eingeschleuster Credentials und
weiterhin unbekannter Tabellen. Sie verwenden deklarierte Speicherfixtures in
einer durch die regulären Laufzeitmigrationen initialisierten eigenen Datenbank,
keinen HTTP-Authentifizierungsersatz. `test:api-keys:migration:native` ist Teil
der nativen API-Suite. Diese Speicherprüfung ersetzt den noch offenen
kompilierten Neustart-/Backup-/Restore-/Credential-Nachweis nicht.

Die dauerhafte kompilierte Operationsprüfung erhält zusätzlich `--minimal`.
Diese Variante führt nach der tatsächlichen Zielanlage unmittelbar die
Move-/Delete-Vorschau aus, ohne dazwischen eine Linkquelle anzulegen, die Quelle
erneut zu lesen oder zu warten. Die ursprüngliche sporadische Regression darf
nicht allein durch die später ergänzten Linkfälle als geschlossen gelten,
weil deren zusätzliche Vorbereitung den Ablauf zeitlich verändert. Die
Standardvariante behält alle vier eingehenden Linkprüfungen. Beide Varianten
verlangen jeweils sechs REST-/SDK-Operationen, Rotation und sechs historische
Status-/Recovery-Zugriffe mit unabhängiger REST-Nachkontrolle und getrennter
privater Evidenz. Zehn Node-Schutzfälle und zwei Python-Dateifälle bestehen;
beide tatsächlichen Läufe am neuen kompilierten Container stehen noch aus.

**Letzte Quellenbeobachtung und aktueller Prüfstand:** Die gezielte Korrektur aus
`d7a8e9c3d` ([PR #201](https://github.com/canvascoding/canvas-notebook/pull/201))
ist auch in diesen Fixstand integriert. Eine gleichzeitige native Versionsänderung
kann die unabhängig wiederholte letzte Quellenprüfung berechtigt entwerten.
Der Collector entfernt dann seinen privaten Katalognachweis. Der gemeinsame
Planer muss dessen vorhandene private Stale-Markierung vor jeder Auswahl eines
nativen, physischen oder HTML-Plans beachten; andernfalls entsteht fälschlich
`NATIVE_SOURCE_EVIDENCE_INVALID` beziehungsweise öffentlich `PATH_UNAVAILABLE`.
Er liefert nun `PREVIEW_STALE`, das über den bestehenden gemeinsamen öffentlichen
Mapper zu `PATH_PLAN_CHANGED` und HTTP 409 wird. Davon profitieren auch die
API-Key-REST-/SDK-Aufrufer desselben Planers. OAuth-MCP kennzeichnet ausschließlich
die erneute Vorschau als wiederholbar; Apply, Recover und Status erhalten dadurch
keine automatische Schreibwiederholung oder zusätzliche Quellinformationen.

Der neue echte PostgreSQL-/HTTP-Dispatcher-Fall scheitert vor der Korrektur mit
`PATH_UNAVAILABLE` und besteht danach innerhalb aller 16 nativen MCP-Gruppen.
Die vorhandenen unabhängigen Projektionsschreiber-, COMMIT-Antwortverlust-,
Widerrufs- und Recovery-Fälle bleiben enthalten. 14 reine Vertragsgruppen prüfen
zusätzlich die phasenabhängigen Wiederholhinweise und den Vorrang von
Authentifizierungsfehlern; alle 37 nativen Delete-Planerfälle, ESLint und striktes
TypeScript bestehen. Die zuletzt veröffentlichte PR-Version `8983f2bbd` besteht
inzwischen alle 13 CI-Prüfungen. Diese lokalen Ergebnisse gehören zur hier
integrierten Korrektur; die neue PR-CI und der eigene kompilierte Containerlauf
sind gesondert auszuführen. Die Browser-/Connector-Abnahme von PR #201 wird
nicht als Abnahme unseres API-Key-/SDK-Builds ausgegeben. Der andere Chat hat
seine lokale Prüfung abgeschlossen und die ursprüngliche Stack-Konfiguration
wiederhergestellt. Nächster Schritt sind der Build dieses Fixstands und die
erneute eigene Prüfung beider Operationsvarianten am einzigen Testcontainer.

**Integration von PR #201 nach dessen Main-Merge:** Der geprüfte Main-Stand
`3ec143a25359e38a808641cf1f2f052a8e0e8a49` ist aufgenommen. Die drei
Konfliktdateien sind mit beiden Testfamilien aufgelöst: Die unabhängigen
Move-/Delete-Projektionsschreiber bleiben erhalten, ebenso die neuen Fälle für
geänderte Rechte, Sitzungen und Quellen zwischen kurzen Lesetransaktionen sowie
echte SQL-Timeouts. Unsere beiden Workspace-Projektionssperren bleiben bestehen;
der gemeinsame finale Stale-Guard entspricht Main. Die optimierte
Inventarwiederverwendung verlangt weiter vollständig gleiche, erneut gelesene
SQL-Zustände. Virtuelle Linkgraphen werden nur innerhalb eines Planeraufrufs
wiederverwendet. Daraus folgt noch kein vollständiges 10-/200-Quellen-Leistungsbudget.

Der zusätzliche API-Key-Abgleich reproduziert einen echten Anschlussfehler:
Der eigenständige Quellenleser verschluckte einen tatsächlich ausgelösten
PostgreSQL-Timeout. Seine blockierte Beobachtung wurde anschließend als ungültiger
nativer Plan mit HTTP 400 ausgegeben. Er erhält nun den ersten erkannten
Infrastrukturfehler auch durch Rollback und Verbindungsschließung und wirft ihn
vor der Planerauswahl erneut. Unbekannte Fehler bleiben blockierte Beobachtungen;
die bestehende Kernel-Sperre und die Bereinigung bleiben erhalten. Sechs echte
Timeoutfälle für Move/Delete über REST und beide registrierten MCP-Protokolle
liefern nun `PATH_TIMEOUT`, bei REST HTTP 503, ohne Änderungen an Dokumentdaten.
Sie sind Teil aller 17 bestandenen nativen API-Key-Adaptergruppen. Alle 21
zusammengeführten nativen MCP-Pfadgruppen, 13 echte JWT-/PostgreSQL-
Berechtigungsfamilien, die native Ingest-Prüfung, 115 Quellen-/Planerfälle und
28 Quellen-/Projektionssperrfälle bestehen. Die zusätzlichen isolierten
Bereinigungsfälle prüfen auch den Vorrang des ursprünglichen Fehlers vor einem
zweiten Fehler beim Schließen. Striktes TypeScript umfasst 3.765 Wurzeln und
9.098 Quelldateien ohne Fehler; die gezielten ESLint-Prüfungen bestehen.

Der neue öffentliche Code `PATH_TIMEOUT` ist außerdem in den SDK-Typen und
Entwickleranleitungen ergänzt. Der Typvertrag scheitert davor und besteht
danach; alle 23 mechanischen SDK-Pfadtests bleiben grün. Empfangene Fehler
behalten ihr Originalergebnis; Preview, Apply und Recover lösen keinen
automatischen SDK-Folgeaufruf aus. Da sich eine SDK-Laufzeitdatei geändert hat,
ist für die neue kompilierte Abnahme ein frisch gebautes und installiertes
Artefakt erforderlich. Das bisherige Wheel wird dafür nicht wiederverwendet.

Der gemeinsame Stand `65e069683` besteht den Host- und Linux-Produktionsbuild,
den Start des einzigen verwalteten Notebook-Testcontainers sowie Bootstrap-
Anmeldung und Abmeldung. Alle 38 gebundenen Produktquellen stimmen mit dem Image
überein. Die Originalbelege, vier geschützten Datenbankzeilen einschließlich
`xmin`, Quelldateien und drei Anker bleiben unverändert. Beide dauerhaften
kompilierten Operationsprofile bestehen: jeweils sechs REST-/SDK-Operationen,
sechs SDK-Status-/Recovery-Prüfungen nach tatsächlicher Schlüsselrotation und
sechs unabhängige REST-Statusprüfungen. Das zweite Profil bestätigt vier Gruppen
eingehender Links. Eigene Schlüssel, Sitzungen und MCP-Einstellungen werden
bereinigt beziehungsweise wiederhergestellt. Das frisch installierte Wheel
besteht alle 92 SDK-Tests ohne Überspringungen. Alle 13 PR-Prüfungen sind für
diesen Stand erfolgreich; dies ersetzt die noch offene Gesamtabnahme nicht.

Die anschließende kompilierte Browserprüfung besteht mobil und für beide
unterbrochenen Ausgaben, scheitert jedoch im Desktop-Lebenszyklus: Der neue
Schlüssel funktioniert über HTTP, seine Karte steht tatsächlich auf Position 33
von 47, während die Liste zunächst nur 25 Metadaten lädt. Die UI zeigt nun die
bestätigte neue beziehungsweise geänderte Karte unmittelbar an, auch wenn sie
außerhalb der ersten Seite liegt. Nachladen führt anhand der Integrations-ID
zusammen, ohne doppelte Karten oder erneute Ausgabe. Nach einer vollständigen
Seitenaktualisierung verwendet der Browserfall die vorhandene sichtbare
Paginierung. Ein neuer deterministischer UI-Regressionsfall reproduziert den
Fehler zunächst und besteht anschließend mit 26 Einträgen, Nachladen,
Duplikatprüfung und erneutem Lesen. Die bestehenden Ausgabefehler- und
Geheimnisprüfungen sowie die API-Key-Vertragssuite bleiben grün. Die tatsächliche
kompilierte Wiederholung dieses UI-Fixes und die echte OAuth-/Keychain-/
Ablaufprüfung stehen am neuen Fixstand noch aus. Review Center und Undo bleiben
außen vor; Paket 4b und das Release bleiben offen.

**Fortschritt am Paginierungsfix `d6a686fc7`:** Beide Produktionsbuilds,
Neustart und Bootstrap-Anmeldung/-Abmeldung sowie alle vier kompilierten
API-Key-Browserfälle bestehen ohne Wiederholungen und Überspringungen. Die
geschützten Originaldaten bleiben unverändert. Der erste echte OAuth-Lauf
bestätigt PKCE, Grants, Suche, Lesen, Create und dauerhaftes Edit, bricht aber
danach beim Editorabgleich ab; der bisherige Runner speichert dafür nur einen
allgemeinen Fehler. Alle eigenen Zugänge werden bereinigt. Eine unabhängige
REST-/Browser-Lesung desselben Belegs bestätigt anschließend zweimal exakt
denselben nativen Inhalt und dieselbe Version wie das SDK sowie vier aktuelle
Editoransichten ohne alte Textfassung. Es liegt kein beobachteter verlorener
Schreibvorgang vor; die ursprüngliche einzelne Abweichung ist damit nicht erklärt.

Eine private Diagnosekopie erhält alle bisherigen Assertions und Zeitgrenzen und
ergänzt lesende Phasenbeobachtungen. Sie besteht beide Live-Ansichten, Reloads,
den tatsächlichen 15-Minuten-Ablauf mit HTTP 401 für den alten Token, automatische
offizielle SDK-Erneuerung ohne zweite Zustimmung und unabhängiges Wiederöffnen
aus dem macOS-Schlüsselbund. Sie ist getrennte Diagnoseevidenz und ersetzt die
fehlgeschlagene dauerhafte Abnahme nicht.

Der dauerhafte Runner prüft deshalb nun sechs aufeinanderfolgende versionierte
SDK-Änderungen mit 24 Live-/Reload-Prüfungen und protokolliert den genauen
fehlgeschlagenen Editor-/Zyklus-/Assertion-Schritt ohne Dokumenttexte oder
Zugangsdaten. Zusätzlich deckt er Copy zwischen zwei neuen Workspaces sowie
Move und Delete über dieselbe tatsächlich ausgestellte OAuth-Verbindung ab.
Apply-Anfragen werden vor Versand mit dem vorhandenen atomaren Journal-Schreiber
dauerhaft gespeichert und anhand des gemeinsamen Validators an die eigenen
Nonce-Pfade gebunden. Nach wirklichem Tokenablauf und Erneuerung werden alle
sechs Edit-Statusbelege und drei Pfadstatus-/Recovery-Aufrufe erneut geprüft.
Die Bereinigung deaktiviert und verifiziert beide eigenen Workspace-Opt-ins.
Die Produktdienste und die SDK-Laufzeitdateien ändern sich dafür nicht. Die
eigene kompilierte Ausführung dieser erweiterten Abnahme steht noch aus.
Die elf lokalen Daten-/Belegprüfungen, die vorhandenen zehn Node- und zwei
Python-Journalschutzfälle, Syntax und ESLint bestehen. Diese Prüfungen erzeugen
keine Anwendungsberechtigung und ersetzen den echten OAuth-Lauf nicht. Alle
13 PR-Prüfungen des bisherigen kompilierten Stands `d6a686fc7` sind erfolgreich,
einschließlich der tatsächlichen installierten SDKs unter Python 3.10 und 3.15.

**Erweiterte Abnahme auf `721e59a9f`:** Host-/Linux-Build, Containerstart,
Bootstrap-Anmeldung/-Abmeldung und Erhalt der geschützten Originaldaten bestehen.
Die dauerhafte OAuth-Abnahme scheitert im ersten Zyklus nach dem bestätigten
Edit: Der erste Editor zeigt den neuen Inhalt und besteht Reload, der zweite
zeigt weiter die alte Fassung und ist auch nach der 45-Sekunden-Grenze
schreibgeschützt. Der gespeicherte Phasenbeleg benennt exakt Zyklus 0, Editor 2,
Live-Ansicht, Assertion `editable`. Die drei Pfadoperationen und die erneute
Ablaufprüfung werden in diesem fehlgeschlagenen Lauf nicht erreicht.

Zwei getrennte private Diagnosekopien beobachten zusätzlich echte WebSocket-
Metadaten und HTTP-Status, ohne Antworten, Autorisierung oder Dokumente zu
ersetzen. Sie stoppen mit `DOCUMENT_EDIT_UNAVAILABLE` beim ersten Edit, während
der zweite Peer seine Verbindung aufbaut. Eine unabhängige REST-/SQL-Beobachtung
aller drei Belege weist den dauerhaften Zustand nach: Der erfolgreiche Edit
steht mit Sequenz 1 und exakt dem bestätigten Inhalt/Version in Yjs und Beleg;
die beiden fehlgeschlagenen Edits besitzen jeweils einen fehlgeschlagenen
Operationsbeleg ohne Apply-/Persistenzsequenz. Inhalt, Version und Sequenz 0
bleiben dort unverändert. Die geschützten Originaldaten bleiben erhalten;
eigene Zugänge, Workspace-Opt-ins und Sitzungen werden bereinigt.

Vor einer Änderung der Fehlerbehandlung wird jetzt die interne Ursache an den
beiden tatsächlichen Grenzen protokolliert: vor `nativeEditFailure` den
unbekannten Grund vereinheitlicht sowie vor einer endgültigen Peer-Ablehnung.
Die Beobachtung enthält einen begrenzten eigenen Fehlercode und einen
Fingerabdruck einer nativen Fehlermeldung. Dokumenttext, rohe Fehlermeldung,
Stack, Pfad und Tokens werden nicht ausgegeben; Accessors und Proxies werden
nicht aufgerufen. Die zwölf lokalen Datenschutz-/Datenfälle bestehen. Die
Produktkorrektur und die vollständige kompilierte Wiederholung bleiben offen.
Die API-Key-Vertragssuite und die echte native Edit-Suite einschließlich zwölf
Owner-/PostgreSQL-/Route-/MCP-Gruppen bestehen mit den Diagnoseänderungen. Ein
zusätzlich herangezogener synthetischer Starttest scheitert bereits mit exakt
dem unveränderten Serverstand `721e59a9f` an einem leeren Alias-Dummy für den
Metrikbeobachter. Seine weiteren nativen Aufnahme-Abhängigkeiten sind ebenfalls
nicht aufgebaut. Der Versuch einer punktuellen Fixture-Anpassung wird wieder
entfernt; diese Suite gilt ausdrücklich nicht als erfolgreicher Startnachweis.
Die tatsächlichen kompilierten Starts sind separat belegt. Der reproduzierte
Livefehler und seine kompilierte Ursachenanalyse bleiben der nächste Schritt.

**Ursacheneingrenzung am kompilierten Stand `51bde8d5f`:** Beide Builds,
Start, Bootstrap-Anmeldung/-Abmeldung und alle 42 gebundenen Produktquellen sind
bestätigt. Die kurze echte OAuth-Diagnose reproduziert den zweiten
schreibgeschützten Editor erneut. Der zweite Tab bekommt HTTP 200 mit
Schreibrecht, wird danach aber beim WebSocket-Beitritt mit `permission-denied`
abgewiesen. Das Serverlog benennt zeitgleich `onAuthenticate: ADMISSION_CONFLICT`.
Der erste SDK-Edit ist bestätigt, Editor 1 zeigt die aktuelle Fassung auch nach
Reload. Eigene Zugänge werden bereinigt und die geschützten Originale bleiben
unverändert. Damit ist die fehlerhafte endgültige Ablehnung bei der zusätzlichen
Raumaufnahme eingegrenzt; die zwei früheren Edit-Fehler sind damit noch nicht
abschließend erklärt.

Die letzte native Raumaufnahme verwendet nun dieselben Shared-Sperren und
Reservierungsprüfungen mit ausdrücklich bestätigtem Transaktionsabschluss.
Ausschließlich ein echter `ADMISSION_CONFLICT`, dessen Rollback und
Verbindungsfreigabe bestätigt sind, fordert über den vorhandenen Busy-Grund
eine neue, begrenzte Client-Aufnahme mit frischer Sitzung an. Die vorherige
native Aufnahme und ihre Transport-/Rechteprüfung sowie alle strengen
Schreibprüfungen bleiben bestehen. Es gibt keinen automatischen Schreibaufruf.
Unklare Commit-, Rollback- oder Freigabeergebnisse und andere SQL-Fehler bleiben
Fehler. Neun Fälle auf echtem PostgreSQL prüfen Leser-Koexistenz, fremde Schreibsperre,
Dokumentreservierung, den Ausschluss von Zeichnungen und verlorene tatsächliche SQL-/Freigabe-Bestätigungen;
alle bestehen. Die 23 Transaktionsmechanikfälle bleiben ebenfalls grün.
Der neue Test verwendet die vorhandene Nonce-/Eigentümer-geprüfte CI-Auswahl
und ist in die native Edit-Suite eingebunden. Der neue kompilierte
Zwei-Editor-Lauf und die vollständige Abnahme bleiben offen.

**Kompilierte Wiederholung auf `16719bc24`:** Beide Builds, Start, Anmeldung,
43 Quellbindungen und Erhalt der Originale bestehen. Die echte kurze
OAuth-Diagnose beobachtet das neue Busy-Signal beim zweiten Tab, dessen
anschließende erfolgreiche Neuaufnahme und acht erfolgreiche Live-/Reload-
Prüfungen über zwei bestätigte SDK-Edits. Der dritte Edit scheitert weiterhin
mit `DOCUMENT_EDIT_UNAVAILABLE`. Der neue interne Fingerabdruck weist hier
exakt auf `ADMISSION_CONFLICT`; die innere Edit-Normalisierung verwirft diesen
Code, obwohl die äußere öffentliche Normalisierung bereits `DOCUMENT_BUSY`
kennt. Diese zweite Korrektur und die vollständige Abnahme bleiben offen.
Eine unabhängige REST-/lesende SQL-Prüfung bestätigt exakt den zuletzt
bestätigten SDK-Inhalt/Version, Yjs-/Checkpoint-Sequenz 2, zwei dauerhafte
Operationsbelege und einen fehlgeschlagenen dritten Beleg ohne Apply oder
Persistenz. Eigene Zugänge sind bereinigt, Originale unverändert.

Die GitHub-CI findet außerdem eine falsche Annahme im neuen Test: Eine frische
Nonce-Datenbank enthält absichtlich keine öffentlichen Admission-Tabellen.
Die Fixture erstellt deshalb ihre Tabellen nun mit den tatsächlichen
Migrationen im eigenen Schema und setzt eine echte Elternreservierung für
den Fremdschlüssel. Die bisherige Fassung scheitert reproduzierbar auf einer
frischen eigenen CI-Datenbank, die vorbereitete Korrektur besteht dort alle
neun Fälle. Öffentliche Relationen bleiben leer; das eigene Schema und die
OID-/Marker-geprüfte Nonce-Datenbank werden entfernt. Der übernommene Test
besteht anschließend lokal und mit allen neun Fällen auf einer weiteren
frischen CI-Datenbank; die neue GitHub-Ausführung steht noch aus.

Die innere und äußere Fehlerübersetzung verwenden nun dieselbe feste Tabelle.
Ihr bisheriger öffentlicher Funktionskörper bleibt unverändert; unbekannte
Fehler behalten ihre begrenzte interne Diagnose und den terminalen öffentlichen
Code. Ein echter zusätzlicher Leser wird im Regressionstest erst nach dem
tatsächlichen SQL-Übergang nach `applying` gestartet. Vor der Korrektur folgt
HTTP 503 `DOCUMENT_EDIT_UNAVAILABLE`, danach HTTP 409 `DOCUMENT_BUSY` mit
derselben Operationsreferenz. Der fehlgeschlagene Beleg besitzt weder Apply-
noch Persistenzzeit/-sequenz; native Bytes und Version bleiben unverändert.
Alle 13 nativen API-Key-Owner-/REST-/MCP-Gruppen, fünf echte Principal-Gruppen,
sechs installierte SDK-HTTP-/PG-Gruppen und neun registrierte MCP-/Agent-Gruppen
bestehen. Beim verlorenen SDK-Schreib-ACK erfolgt weiterhin keine automatische
Schreibwiederholung. Verträge, ESLint und strenges TypeScript mit 20 Wurzeln/
5255 Quellen bestehen. Neue Produktionsbuilds und die kompilierte Gesamt-
abnahme dieses zweiten Fixes bleiben offen.

**Kompilierte Abnahme auf `4482c9940`:** Beide Produktionsbuilds, Start,
Bootstrap-Anmeldung/-Abmeldung und alle 44 gebundenen Produktquellen stimmen.
Die kurze Diagnose besteht sechs Edits und 24 Live-/Reload-Prüfungen. Auch der
unveränderte dauerhafte OAuth-Runner besteht danach alle sechs Edits und 24
Editorprüfungen; die anschließende erste Copy-Apply-Anfrage scheitert jedoch
mit `COPY_UNAVAILABLE`. Move/Delete und der wirkliche Tokenablauf werden nicht
erreicht. Der vor Versand gespeicherte Copy-Aufruf bleibt im eigenen Journal.
Eine unabhängige REST-/lesende SQL-Beobachtung bestätigt exakt den sechsten
SDK-Inhalt samt Version, sechs dauerhafte Edit-Belege und Yjs-/Checkpoint-
Sequenz 6. Zum geprüften Plan-/Operationsbezug sind weder Batch noch Ziel-
Dokument oder Copy-Beleg sichtbar. Es erfolgt kein erneuter Schreibaufruf.
Eigene Zugänge und Sitzungen sind bereinigt, Originaldaten unverändert.

Die unbekannte Copy-Ursache wird vor ihrer bisherigen Vereinheitlichung nun
mit derselben begrenzten Diagnose beobachtbar gemacht: Operationsreferenz,
eigener sicherer Code und nativer Meldungsfingerabdruck, ohne Argumente,
rohe Fehlermeldung, Stack oder Zugangsdaten. Das bestehende Fehlerformat,
OAuth-Challenge und alle Berechtigungs-/Schreibentscheidungen bleiben gleich.
Die kompilierte Ursachenbeobachtung auf `752b911c4` besteht erneut sechs Edits
und alle 24 Editorprüfungen. Sie belegt als Copy-Ursache exakt
`COLLABORATION_FILE_LIFECYCLE_BUSY`: Die beiden Quell-Editoren sind noch offen.
Diese Schutzsperre ist ausdrücklich bereits durch die bestehenden Lifecycle-
UI-Tests vorgegeben und bleibt erhalten. Die gemeinsame MCP-/REST-
Fehlerübersetzung ergänzt den fehlenden festen Eintrag zu `COPY_BUSY` (409).
Der neue Vertragstest scheitert vor dem Eintrag und besteht anschließend mit
Fehler-, Ausführungs- und Statusformat sowie unbekannten Codevarianten.

Die dauerhafte OAuth-Abnahme erwartet nun nach unveränderten sechs Edits und
24 Editorprüfungen die sichere Busy-Ablehnung. Sie prüft den ursprünglichen
vorbereiteten Auftrag, fehlende native/Scene-Geburten und unveränderten
Quellinhalt, schließt die eigenen Editoren und wartet auf die nachgewiesene
Freigabe von Owner-Feldern und tatsächlicher PostgreSQL-Sperre. Erst dann
fordert sie explizites Recover mit derselben Operations-/Plan-ID und denselben
Auswahlen an. Es gibt weder eine neue Copy-Operation noch automatische
Schreibwiederholung. Ein echter zusätzlicher MCP-/PostgreSQL-Fall prüft dabei
auch erhaltene private Staging-Dateien und den zugehörigen Asset-Originalbeleg;
die bestehenden Dokument-/Assetdateien und Quellzeilen bleiben geschützt.
Die kompilierte Ausführung dieses ergänzten Ablaufs bleibt offen.

Die sieben echten MCP-/PostgreSQL-/FD-/Service-Ereignisgruppen bestehen,
einschließlich dieser expliziten Recovery und der bestehenden verlorenen
Commit-/Transportbestätigungen und Rechteentzüge. Acht echte API-Key-REST-/
MCP-Adaptergruppen sowie acht installierte SDK-Copy-Gruppen bestehen ebenfalls;
der SDK-Lauf verwendet 40 echte Key-Header-Anfragen und bestätigt null
automatische Schreibwiederholungen. Die Quellen bleiben unverändert, eigene
Schemas/Clients/Testdateien sind bereinigt. Die zehn Node-Helferfälle, zwei
Python-Journalfälle, Syntax, ESLint und strenges TypeScript mit sechs Wurzeln/
5191 Quellen bestehen. Für diesen lokalen Korrekturstand stehen die neuen
Builds, kompilierte Abnahme und GitHub-Prüfungen noch aus.

**Kompilierte Abnahme auf `a12c8f58f`:** Beide Builds, Start, Bootstrap-
Anmeldung/-Abmeldung und alle 45 Produktquellbindungen bestehen. Der aktuelle
`main`-Stand mit PR #201 ist vollständig enthalten. Der dauerhafte echte
OAuth-Lauf besteht sechs bestätigte Edits und 24 Editorprüfungen, Busy-
Ablehnung ohne Geburten, positive Owner-/PG-Sperrfreigabe und ausdrückliches
Recover des ursprünglichen Copy-Auftrags. Der folgende Manifest-/Inhaltsschritt
scheitert. Eine unabhängige ausschließlich lesende Prüfung bestätigt den
abgeschlossenen Journal-/Veröffentlichungsbeleg, genau eine aktive Kopie,
bytegleichen Markdown-Inhalt und gleiche native Inhalte mit frischen Block-IDs.
Quellinhalt, Version und geschützte Originaldaten bleiben unverändert; es wird
weder Apply noch Recover erneut gesendet.

Ein isolierter echter OAuth-Manifestaufruf identifiziert den Fehler des
Abnahmehelfers eindeutig als `JSONDecodeError`: Er verlangt JSON im Textfeld,
während der bestehende OAuth-Manifestvertrag dort seine feste Zusammenfassung
und daneben `structuredContent` liefert. Nur die Manifestprüfung verwendet
deshalb eine eigene Prüfung auf genau diese Zusammenfassung samt tatsächlicher
Eintragszahl. Die bisherigen JSON-Prüfungen der nativen Dokument-/Copy-Werkzeuge,
Pagination und Inhalts-/Identitätsassertions bleiben erhalten. Sieben lokale
mechanische Envelope-Fälle bestehen. Weitere diagnostische Komplettläufe
werden außerdem durch korrekt gemeldetes `DOCUMENT_BUSY` während gleichzeitiger
Editorzugriffe beendet; diese Ergebnisse werden erhalten und nicht als grüne
Vollabnahme gezählt. Die neue vollständige kompilierte Abnahme bleibt offen.

**Editor-Vorbedingung:** Auch auf `0ac1e889d` bestehen beide Builds, Start,
die 45 Produktquellbindungen und alle vier API-Key-Browserfälle ohne Retry,
Skip oder Flake. Der dauerhafte OAuth-Lauf endet nach einem bestätigten Edit/
vier Ansichten erneut mit dem vorgesehenen `DOCUMENT_BUSY`. Der Runner wartet
bisher nur auf sichtbaren Inhalt und `contenteditable`; ein neu geladener
Editor kann diese bereits aus seinem lokalen Zustand erfüllen.

Eine getrennte echte Diagnose ergänzt daher vor den vorhandenen Assertions
die positive Authenticated-/SyncStep2-Beobachtung für genau das eigene Dokument
auf dem aktuellen `/ws/collaboration`-Socket und Seitenstand. Sie besteht sechs
Edits, alle 24 Live-/Reload-Assertions und 26 positive Verbindungsprüfungen über
14 Seitenstände. Der Python-Prozess bleibt vor Pfadoperationen am letzten
Editor-Handshake angehalten und wird danach geordnet bereinigt; diese Diagnose
behauptet weder Pfadabnahme noch echten Tokenablauf. Originaldaten bleiben
unverändert, die eigenen Zugänge sind vollständig bereinigt. Die dauerhafte
Abnahme übernimmt diese zusätzliche Vorbedingung mit der bisherigen Zeitgrenze.
Navigation, Socketwechsel/-schluss und Auth-Ablehnung setzen die Bereitschaft
zurück; `/ws/live-events` und fremde Dokumentframes zählen nicht. Weder SDK-
Schreibwiederholung noch feste Verzögerung oder geänderte Serverrechte werden
eingeführt. Die neue kompilierte Gesamtwiederholung bleibt offen.

**Vollständige kompilierte Wiederholung auf `871a0ef43`:** Beide Builds,
Container-Start, tatsächliches Bootstrap-Login/-Logout und alle 45 gebundenen
Produktquellen bestehen. Der dauerhafte PKCE-/Consent-/SDK-Lauf besteht sechs
bestätigte Edits, alle 24 Live-/Reload-Ansichten und 26 positive Socket-
Synchronisationsprüfungen. Copy eines noch geöffneten Dokuments meldet korrekt
`COPY_BUSY`; nach bestätigter Owner-/Advisory-Lock-Freigabe führt explizites
Recover den unveränderten ursprünglichen Auftrag erfolgreich weiter. Danach
bestehen tatsächliches Manifestlesen, Copy-Inhaltsvergleich, Move und Delete.
Der Lauf wartet den natürlichen 15-Minuten-Tokenablauf ab, weist den alten Bearer
mit 401 zurück und bestätigt automatisches SDK-Refresh ohne neuen Consent.
Alle sechs historischen Edit-Statusabfragen sowie die drei Pfad-Status-/Recover-
Paare funktionieren weiter; ein unabhängiger Prozess liest den macOS-Keychain-
Eintrag erneut. Eigene Credentials, Grants, Betriebssystemeinträge, Workspace-
Freigaben und Sitzungen werden mit null Bereinigungsfehlern entfernt beziehungsweise
wiederhergestellt. Die geschützten Originale bleiben unverändert.

Am selben Stand bestehen alle vier API-Key-Browserfälle ohne Skip, Retry oder
Flake. Beide dauerhaften REST-/installierten SDK-Operationsprofile bestehen je
sechs Copy-/Move-/Delete-Operationen, echte Schlüsselrotation, sechs historische
SDK-Status-/Recover-Paare und sechs unabhängige REST-Statusabfragen. Das Profil
mit eingehenden Links bestätigt außerdem vier Gruppen von Linkanpassungen.
Alle 13 GitHub-Prüfungen dieses Commits sind erfolgreich; die native CI verwendet
installierte SDKs auf Python 3.10 und 3.15.

**Reguläre Gesamtsuite und Kalt-Restore:** Eine konsistente Sicherung aus echtem
PostgreSQL-Custom-Dump, DATA- und HOME-Archiv wird bei gestopptem Notebook in eine
eigene Nonce-Datenbank und eigene Volumes zurückgespielt. Der einzige verwaltete
Notebook-Container startet damit am unveränderten Image; tatsächliche Anmeldung,
geschützte Zeilenwerte, Dateibytes und Sicherungsmarker stimmen. Nach dem Test
wird der ursprüngliche Stand wieder gestartet und zusätzlich auf unveränderte
ursprüngliche `xmin` geprüft. Eine spätere Schreibprüfung verweigert Uploads mit
`UPLOAD_STATE_UNCONFIRMED`: Die inodegebundenen Autoritätsmarker des ursprünglichen
DATA-Verzeichnisses passen nicht zu den neu erzeugten Volumes. Die Marker bleiben
unverändert; keine Prüfung wird umgangen. **Start und lesende Originalvergleiche
sind nachgewiesen, eine funktionsfähige Wiederherstellung ist damit nicht
abgenommen.** Der unterstützte Restore derselben Instanz und die portable
Übernahme in eine andere Instanz mit getrennten Credentials bleiben offen.
Die reguläre Suite läuft anschließend mit frischer Sicherung und neu erstelltem
Container auf den gültigen ursprünglichen QA-Volumes.

Der erste Suiteversuch scheitert vor jeder Assertion an einem zu langen privaten
Unix-Socket-Pfad auf macOS; der Supervisor verwendet danach einen kurzen eigenen
temporären Pfad. Im zweiten Lauf bestehen Browser-Testumgebung, Prozess-Lifecycle,
Scheduler, CLI, Smoke, API-Integration und die API-Key-Serverprüfungen. Danach
scheitert der React-Komponententest, weil der echte Produktions-Testlauf
`NODE_ENV=production` vererbt und React darin `act` nicht bereitstellt. Der
gemeinsame UI-Testaufruf erhält ausdrücklich `NODE_ENV=test`; die aggregierte
API-Key-Suite verwendet denselben Aufruf. Der Server bleibt im Produktionsmodus,
alle bestehenden Assertions bleiben erhalten. Die vollständige API-Key-Teilsuite
besteht danach auch mit geerbtem `NODE_ENV=production`, einschließlich des UI-
Tests, zwölf Diagnosefällen und der zehn Node-/zwei Python-Harnessfälle.
Der vollständige Lauf am kompilierten `f6bfdc29e` mit beiden tatsächlich
angemeldeten Testbenutzern besteht anschließend die API-/UI-/Agent-Prüfungen und
330 Browserfälle; ein Browserfall schlägt fehl, 269 bleiben bedingt übersprungen.
Der einzelne Fehler liegt in der Studio-Retry-Simulation: Sie wechselt bereits
vor dem tatsächlich ausgeführten Klick auf Erfolg, sodass ein paralleler
Konfigurationsabruf den Retry-Button vorzeitig entfernt. Die Simulation liefert
jetzt bis zum echten Browserklick weiterhin einen Fehler und erwartet danach
die erfolgreiche Antwort. Die Anmeldung verwendet den vorhandenen Helfer mit
tatsächlicher Identitätsprüfung und Sitzungscache; rohe wiederholte Logins hatten
im gezielten Test HTTP 429 ausgelöst. Die korrigierte Retry-Variante besteht drei
unabhängige Browserdurchläufe ohne Retry oder Skip. Produktdateien und ihre 45
Quellenbindungen bleiben dabei unverändert; geschützte Originalzeilen samt `xmin`,
Dateibytes und Autoritätsmarker bleiben erhalten.

**Vollständiger regulärer Lauf, 03.11.2026:** Der kombinierte Produktstand
`2a4aded19` besteht macOS- und Linux-Produktionsbuild, echten Containerstart und
alle 13 CI-Prüfungen. Der Studio-Retry-Fall besteht im Gesamtlauf. Zwei weitere
Läufe weisen unabhängige Testfehler nach: Eine vorübergehend fehlende Panelbox
wird vor dem Drag gelesen; eine bestehende Sitzung verliert die TCP-Verbindung
vor der HTTP-Antwort. Die Panel-Messung wartet auf eine sichtbare Geometrie und
behält alle Toleranzen und Interaktionsprüfungen. Der gemeinsame Testhelfer
erlaubt genau einen Playwright-Transport-Retry bei `ECONNRESET` innerhalb des
bestehenden GET-Zeitlimits. Der echte TCP-Vertragstest prüft einmaligen Reset,
anhaltenden Reset und HTTP 401; Identitätsprüfung, 429-Grenzen und Login bleiben
unverändert. Alle 28 gezielten Browserdurchläufe bestehen.

`npm run test:all` endet erfolgreich mit **331 bestanden, 0 fehlgeschlagen,
269 bestehenden bedingten Skips** im Browserabschnitt (48,7 Minuten). Der
Lauf bindet die drei korrigierten Testdateien per SHA-256 an den unveränderten
Produktstand mit 45 überprüften Produktdateien. Er verwendet echte
Administrator- und Zweitbenutzersitzungen, frische PostgreSQL-/DATA-/HOME-Sicherungen
und einen neu erstellten Notebook-Container auf denselben gültigen QA-Volumes.
Die Abschlussprüfung bestätigt unveränderte Originalzeilen einschließlich
`xmin`, Dateibytes und Autoritätsmarker. Review Center und Undo bleiben aus.
Diese Abnahme belegt die reguläre Suite; die übrigen Release-Gates bleiben
in Abschnitt 5b und 5c separat aufgeführt.

### 5b. Vollständige API- und SDK-Testmatrix

**Portabler CI-Pfad, 02.11.2026 – lokal und in GitHub bis `9ba00fd2b` geprüft:** Die drei
gemeinsamen nativen Fixtures verwenden eine zentrale, ausschließlich für Tests
bestimmte Datenbankauswahl. CI verlangt eine eigene Nonce-Datenbank und prüft
PostgreSQL 18, Datenbankname, tatsächlichen Eigentümer und Lauf-Marker vor DDL.
Die Bereinigung bindet zusätzlich die erfasste OID. Fehlende
CI-Auswahl erlaubt weder eine lokale private ENV-Datei noch einen Runtime-URL-
Rückfall. Eine eigene Bereinigung erhält Kontrollwerte bei falschem Marker/OID;
sie entfernt ausschließlich nachgewiesene eigene Ressourcen und meldet Leaks
weiterhin als Fehler. Die lokale Konfigurationsprüfung besteht 19 Fälle.

Der isolierte CI-Datenbankpfad besteht lokal das vollständige native API-Paket
sowie die nativen Agent-Listen-/Read-/Prompt-Prüfungen. Frische Wheel-/Sdist-
Installationen bestehen auf Python 3.10.22 und 3.15.2 in allen zwölf Core-, MCP-
und MCP/Keyring-Profilen: exakte Laufzeitdateien und Bytes, Abhängigkeiten und
alle jeweiligen Tests, ohne neue Skips. Beide installierten Wheel-Interpreter
bestehen außerdem je sechs echte HTTP-/PostgreSQL-SDK-Familien mit 53 Gruppen
auf eigenen CI-Datenbanken. Kontrollschemata, Datenbankkinder, öffentliche
Relationen und offene Verbindungen sind vor dem Entfernen jeweils null.

Der neue Workflow führt diese Prüfungen seriell auf Linux mit einem isolierten
PostgreSQL-Dienst aus und bewahrt Logs und SDK-Artefakte auf. `actionlint`
bestätigt die Workflow-Syntax. Der erste GitHub-Lauf hat einen fehlenden
Vorbereitungsschritt aufgedeckt: Der native Dateisystem-Helfer für Copy-/Move-
Verzeichnisoperationen muss auch auf Linux vor den Tests gebaut und geprüft
werden. Die Workflow-Vorbereitung holt das jetzt ausdrücklich nach; die reale
Copy-Prüfung und alle Abbruchbedingungen bleiben erhalten. Die Bereinigung des
fehlgeschlagenen Laufs bestätigte null verbliebene Ressourcen.
Der nachfolgende GitHub-Lauf
[`41392006457`](https://github.com/canvascoding/canvas-notebook/actions/runs/41392006457)
auf `9ba00fd2b` besteht, ebenso alle 13 PR-Prüfungen dieses Standes. Die tatsächlichen
Artefakte belegen zwölf frische Installationsprofile auf Python 3.10.22 und
3.15.1, je sechs installierte SDK-/HTTP-Familien mit 53 Gruppen und null verbliebene
Schemas, öffentliche Relationen, Backends oder Kinddatenbanken vor dem Entfernen
der eigenen Testdatenbank. ZIP-SHA-256:
`1d21f8fab2365476d4e4c4abc1bde7e1603048c6dc9dd4f9987ca17e489bcfb6`.
Die oben separat dokumentierten kompilierten Browser-/OAuth-/OS-Keyring-Läufe
bestehen ebenfalls. Der sporadische Vorschaufehler, die übrige vollständige
Matrix und der Release-Nachweis bleiben offen.
[Betrieb und Prüfgrenzen](testing/native-api-sdk-ci.md) beschreiben die Schichten;
die bisherigen einzelnen CodeQL-Dispositions- und Prüfnotizen bleiben
[unverändert archiviert](testing/api-key-access-pr-198-history.md).

**Reguläre Tool-Output-Regressionen, 02.11.2026 – lokal grün:** Beide zuvor
fehlgeschlagenen Aggregate bestehen jetzt vollständig. Der Charakterisierungstest
ändert Secrets über den aktuellen zentralen Service; der Suchtest lädt die
tatsächlichen import-only SDK-Namensräume für seinen CommonJS-Einstieg. Alle
sechs Mitglieder von `test:pi:tool-outputs` bestehen. Der delegierte Budgettest
verwendet eine isolierte PGlite-Datenbank mit den echten Migrationen und dem
wirklichen Turn-Lebenszyklus. Erfolg, Budgetverweigerung, Abbruch und unterbrochener
Provider-Stream hinterlassen vier abgeschlossene Einträge; die bestehenden
Output-/Abbruchprüfungen bleiben erhalten. Zusammen mit dem Block-Budgettest
besteht `test:pi:tool-output-budgets`. Nachrichtenpersistenz und Modelltransport
bleiben in diesem isolierten Budgettest ausdrücklich Testersatz; daraus folgt
keine OAuth-, Modell- oder kompilierte UI-Abnahme. Keine neue Review-Center-
oder Undo-Funktion wird eingeführt. Die reguläre `test:all`-Abnahme bleibt offen.

**Status: offen; vor dem Release verpflichtend.** Der Umfang umfasst alle in API
und SDK ausgewiesenen Dokumentfunktionen und Authentifizierungsarten. Eine
Versions-/Fähigkeitsmatrix benennt unterstützte Typen, Schalter und bewusste
Grenzen. Nicht unterstützte Funktionen werden explizit abgewiesen und nicht als
erfolgreich getestet gezählt. Review Center, Undo und zusätzliche Modell-/Plugin-
Spezialumgebungen bleiben außerhalb dieses Auftrags.

| Prüfbereich | Verbindliche Fälle |
| --- | --- |
| Zugänge und Verwaltung | REST mit Session und API-Key; SDK mit OAuth, ausgestelltem MCP-Token und API-Key. Echte Ausstellung, einmalige Anzeige, sichere Speicherung, Rotation, Ablauf, Widerruf, konkurrierende Verwaltungsaktionen, verlorene Ausstellungsantwort, OAuth-Erneuerung und erneute Anmeldung; UI auf Desktop und Mobil. |
| Rechte und Isolation | Fehlender/falscher Schlüssel, Read-only, fremder Benutzer/Workspace/Instanz, fehlender Seat, Kontosperre, deaktiviertes Tool, entzogenes Recht während eines laufenden Vorgangs und mehrdeutige Auth-Header. Ein Schlüssel kann keine Admin-/Secrets-Endpunkte freischalten. |
| Navigation und Lesen | Workspace-Liste, Baum mit Fortsetzungen, progressive Suche und native Reads nach stabiler ID und vollständiger Version; Unicode, mehrseitige Antworten, leere Trefferseiten mit Fortsetzung, Größenlimits und Versionskonflikt zwischen Seiten. |
| Erstellen, Importieren und Bearbeiten | Native leere/befüllte Markdown-Anlage, unterstützter Import, Text-/Blockänderungen und Status; identische Wiederholung mit Original-ID, abweichender Request unter gleichem Schlüssel, Stale-Version-Konflikt und zwei tatsächlich gleichzeitig geöffnete Editoren. |
| Dateioperationen und Links | Copy/Move/Delete mit Preview, Apply, Status und Recover für die ausgewiesenen unterstützten Typen; gleiche und getrennte Workspaces, Kollisionen, relative Links, Backlinks, Titel-/Aliasänderungen sowie vorher fehlende/mehrdeutige Ziele. Vergleich mit vollständigem Link-Neuaufbau. |
| Unterbrechungen und Wiederaufnahme | Abbruch/Timeout, tatsächlicher Verlust einer COMMIT-Antwort, Prozess-/Containerneustart und Schlüsselrotation vor erlaubtem Status/Recovery. Backup-/Restore-Test erhält die vorgesehene Instanz- und Credential-Zuordnung. Originale Dokument-/Operationsidentitäten, Inhalte, Revisionen, Linkergebnisse und Freigaben bleiben erhalten. Kein automatischer neuer Schreibversuch nach unklarem Ausgang. |
| Paket und Kompatibilität | Core-Installation ohne optionale MCP-Abhängigkeiten, vollständige MCP-/Keyring-Installation, tatsächliche Mindest-Python-Version und eine aktuelle unterstützte Version; geprüfte SDK-/Backend-Paare und OS-Keyring-Verhalten. Fehlende sichere Credential-Ablage führt zu einem klaren Fehler statt Klartext-Fallback. |
| Fehler und Leistung | Echte HTTP-Fehler samt 401/403/409/429 und begrenzten Retry-Angaben, Protokoll-/Schemaabweichungen, Datenbankausfall, bereinigte Fehlerantworten und vollständige Ressourcenfreigabe. Gleiche Messgrenzen für SQL, Ausleihen, Pool-Wartezeit, Datenbank-/Gesamtzeit und übertragene Bytes bei 10/200 regulär angelegten Quellen, kalt/warm und mit begrenzter echter Antwortlatenz. |

Die Abnahme erfolgt in dieser Reihenfolge, jeweils mit gebundenem Produktstand:

1. Vertrags-/Parser-/Autorisierungstests und echte PostgreSQL-Fälle. In den
   Auth-/HTTP-Abnahmen verwenden erlaubte wie verweigerte Requests die wirkliche
   Auth-Schicht; positive Antworten oder Principals werden dort nicht durch
   Testersatz erzeugt. Isolierte Vertragstests ersetzen diese Nachweise nicht.
2. SDK-Wheel und Source-Distribution bauen, in isolierten Umgebungen installieren
   und Paket-/Import-/Abhängigkeitsprüfungen ausführen. Der echte HTTP-Test nutzt
   das installierte Wheel und prüft dessen Modul-/Versionsbindung; ein Import
   aus dem Quellordner ersetzt diesen Nachweis nicht.
3. `npm run build`, danach den einzigen verwalteten Notebook-Testcontainer mit
   aktuellem Stand neu bauen/erstellen. Echte HTTP-/OAuth-/API-Key-/Playwright-
   Fälle gegen dieses kompilierte Produkt ausführen. Testdaten und Credentials
   werden regulär in isolierten Test-Workspaces erzeugt, eigene Zugänge danach
   widerrufen und alle eigenen Prozesse/Verbindungen geschlossen.
4. Die reguläre Gesamtsuite `test:all` und die vereinbarten Recovery-/Link-UI-
   Fälle am selben Quellstand bestehen lassen. Featureeigene Spezialumgebungen
   bleiben ausgeschlossen; keine neuen Skips zur Umgehung eines API-/SDK-Fehlers.
5. Ausführbare REST-/SDK-Beispiele, dokumentierte Header/Rechte, Installation,
   Rotation und Fehlerbehandlung mit den echten Verträgen abgleichen. Die
   öffentlichen Quellen bleiben `docs/product/en/developers/document-api.mdx`
   und `docs/product/en/developers/python-sdk.mdx`; keine Anleitung stellt
   geplante oder nur lokal geprüfte Funktionen als bereits deployed dar.

**Fertig:** Für jede Matrixzelle liegen die tatsächlichen Ergebnisse, Produkt-/
SDK-Versionen, Quellenbindung und Grenzen vor. Skips oder ältere Belege ersetzen
keine neue erforderliche Abnahme. Nach erfolgreicher CI und abgeschlossenen
Reviews werden Notebook und das kompatible SDK kontrolliert veröffentlicht;
Paketinstallation, Dokumentationsauslieferung und Zugriff nach dem Deployment
werden separat nachgewiesen. Produktivprüfungen sind lesend; ein Schreibtest
verwendet ausschließlich ausdrücklich bestimmte Testdokumente.

### 5c. Browser-Dokumentcache und Wechsel zwischen Dokument-Tabs

**Status am 04.11.2026: teilweise umgesetzt und gemessen; Abnahme offen.** Die begrenzte Aufbewahrung ist implementiert (drei Dokumente, 15 Sekunden, 1 MiB je Dokument), vermeidet aber bei schnellen Wechseln noch nicht alle Neuinitialisierungen. Gemeint sind
die Dokument-Tabs innerhalb des Notebooks; zusätzliche Browser-Tabs und Browser-
Neustarts werden als getrennte Lebensdauern geprüft. Kein zusätzlicher laufender
Dienst und kein vollständiges Vorladen aller Workspace-Dokumente sind vorgesehen.

#### Verifizierter Ausgangspunkt und offene Messung

Der am 01.11.2026 geprüfte Code hält im File-/Editor-Store einen aktiven
Dokumentinhalt. Die sichtbare Tab-Liste speichert Pfade und Dokumentidentitäten
in `localStorage`; sie hält nicht für jeden Tab einen gemounteten Editor.
Kollaborative Textdokumente besitzen einen Yjs-Zustand im RAM und eine persistente
Kopie über `y-indexeddb`. Der lokale Speicher ist damit bereits vorhanden und
wird weiterverwendet. Eine allgemeine persistente Inhaltsablage für sämtliche
Dateitypen oder den ganzen Workspace ist daraus nicht abzuleiten.

Der Wechsel A→B→A führt im bestehenden Pfad wieder durch Dokumentladen und
Session-Auflösung. Der Query-Leser teilt gleichzeitige Reads, setzt für Dokumente
aber `staleTime: 0`; der HTTP-Leser verwendet `cache: 'no-store'`. Ein unbenutzter
Kollaborationseintrag wird nach derzeit einer Sekunde zur Freigabe vorgesehen.
Dabei bleibt die IndexedDB-Kopie erhalten; eine unbestätigte lokale Sicherung
darf die letzte RAM-Kopie weiterhin nicht verwerfen.

Das bedeutet nicht, dass jeder Wechsel den vollständigen Text neu herunterlädt:
Der native `collaborationBootstrap`-Lesepfad fordert Metadaten an; der Editor
hydratisiert den Inhalt aus IndexedDB und gleicht ihn über Yjs mit dem Server ab.
Neue Autorisierungsrequests, vollständige Inhaltsübertragung, Yjs-Deltas und
Editor-Neuaufbau müssen deshalb separat gemessen werden. Die betreffende
Tabwechsel-Requestzahl wurde bei dieser Planergänzung nicht gemessen.

Die Ausgangspunkte sind `app/components/DashboardShell.tsx`,
`app/components/editor/FileEditor.tsx`, `app/store/file-store.ts`,
`app/store/editor-store.ts`, `app/lib/queries/document-queries.ts`,
`app/lib/files/client.ts`, `app/lib/collaboration/client.ts` und
`app/lib/collaboration/opened-document-registry.ts`. Vor Umsetzung den dann
aktuellen Code und gebauten Produktstand erneut abgleichen.

#### Ausgangsmessung auf dem integrierten Linux-Build

Auf Commit `1a4f09bf9` wurden je vier sichtbare Tabwechsel in isolierten
Workspaces mit 10 und 200 Testdokumenten gemessen. Bei 10 Dokumenten dauerte
A→B→A pro Wechsel 821–855 ms, bei 200 Dokumenten 855–919 ms. Beim Klick auf
den bereits aktiven Tab waren es 27–43 ms. Bei den warmen Wechseln entstanden
typischerweise zehn HTTP-Aufrufe, eine neue Kollaborationsverbindung und ein
erneutes Öffnen der Yjs-Datenbank. Drei Standortabfragen und zwei Watch-Aufrufe
machten typischerweise die Hälfte der HTTP-Aufrufe aus. Die Zeit bis zum
sichtbaren Inhalt und die während des Messfensters übertragenen Bytes wurden
getrennt erfasst. SQL, Pool-Ausleihen und der genaue Abstand zur Freigabe des
vorherigen Dokuments sind in dieser Messung noch offen.

Eine separate instrumentierte Messung auf `93fad1da2` mit zehn Dokumenten
zählte bei acht warmen Wechseln 593–618 SQL-Aufrufe und 108–116 Pool-Ausleihen
pro Wechsel über die beobachteten Datei-HTTP-Endpunkte. Der Session-Endpunkt
allein führte je 396 SQL-Aufrufe und 48 Pool-Ausleihen aus und benötigte
509–655 ms serverseitig. Auf ihn entfielen 3.168 von 4.853 SQL-Aufrufen.
Die Standortabfragen waren mit insgesamt 609 SQL-Aufrufen die zweitgrößte
Gruppe. Die Instrumentierung zählt Aufrufe des PostgreSQL-Treibers bis zum
Abschluss der jeweiligen HTTP-Antwort. WebSocket- und Hintergrundarbeit
sind in diesen Zahlen nicht enthalten.

#### Umsetzung in überprüfbaren Schritten

1. **Istzustand messen:** Zwei regulär angelegte Testdokumente bei insgesamt 10
   und 200 Quellen verwenden. Kaltes Öffnen, erneuten Klick auf den aktiven Tab,
   A→B→A vor und nach der bisherigen Freigabefrist sowie Browser-Neuladen getrennt
   erfassen. Pro Phase HTTP-/WebSocket-Aufrufe, Inhalts- und Delta-Bytes,
   IndexedDB-Hydration, Editor-Initialisierungen, SQL/Ausleihen, sichtbare Ladezeit
   und gehaltene Dokumente/Verbindungen messen. Messungen nicht mit fremden
   Build-/Lastläufen vermischen. Wiederholte vergleichbare Wechsel liefern
   belastbare Latenzwerte statt einer einzelnen lokalen Momentaufnahme.
2. **Lebensdauer festlegen:** Aktiven Editor, lokalen Dokumentzustand, aktuelle
   Serverautorisierung und Transport getrennt behandeln. Eine kleine gemeinsame
   Dokumentverwaltung soll bereits geöffnete native Zustände innerhalb expliziter
   Grenzen wiederverwenden können. Vor dem Umbau Anzahl, Speicherbudget und
   Freigaberegel anhand der Messung festlegen. Inaktive Tabs benötigen nicht
   jeweils einen dauerhaft gemounteten Editor oder eine aktive WebSocket-Verbindung.
   Ungesicherte Änderungen dürfen durch Verdrängung nicht verloren gehen.
3. **Warme Wechsel verbessern:** Bereits gültigen lokalen Inhalt wiederverwenden;
   benötigte aktuelle Autorisierung und Versionsabgleich über die gemeinsamen
   vorhandenen Leser ausführen. Doppelte gleichzeitige Bootstrap-/Session-Aufrufe
   zusammenführen, ohne spätere echte Prüfgrenzen zu überspringen. Geänderte
   Inhalte werden mit dem aktuellen nativen Stand zusammengeführt; ein älterer
   Cache darf keinen neueren Server- oder lokalen Stand überschreiben.
4. **Grenzen und Wiederherstellung erhalten:** Cache nach Benutzer-/Anmeldekontext,
   Workspace, Dokument-ID, Generation und Repräsentation eindeutig zuordnen.
   Rename/Move aktualisiert die Zuordnung unter derselben gültigen Identität;
   Löschen und Wiederanlage am selben Pfad sind verschiedene Dokumente.
   Logout, Benutzer-/Workspace-Wechsel und Rechteentzug dürfen aus Cache-Daten
   keine neue Lese- oder Schreibberechtigung erzeugen. Vorhandene Offline-/
   Recovery-Fälle mit unbestätigten Änderungen erhalten; Browser-Neuladen,
   fehlende oder nicht verfügbare IndexedDB und lokales Speicherlimit liefern
   nachvollziehbare Zustände. Bestätigtes Speichern bleibt an den tatsächlichen
   Server-/Persistenzbeleg gebunden.
5. **Gezielt abnehmen:** Desktop und Mobil, schnelle und verzögerte Tabwechsel,
   erzwungene Cache-Verdrängung, Browser-Neuladen, zweite Browsersitzung mit
   tatsächlicher Peer-Änderung, Rechteentzug und Pfad-/Generationswechsel prüfen.
   Normale nicht kollaborative Dateien sowie bestehende Office-/Szenenwege auf
   unbeabsichtigte Änderungen prüfen, soweit der Umbau sie berührt. Keine neue
   Review-Center- oder Undo-Logik als Voraussetzung einführen.

**Fertig:** Die Vorher-/Nachher-Berichte trennen kaltes Öffnen und warme Wechsel.
Solange der lokale native Zustand gültig und vorgehalten ist, entsteht beim
Wechsel kein unnötiger vollständiger Inhaltsdownload und keine doppelte native
Initialisierung. Notwendige aktuelle Rechte- und Versionsprüfungen bleiben
nachgewiesen. RAM, gehaltene Dokumente und Verbindungen bleiben innerhalb der
festgelegten Grenzen; Verdrängung und Wiederöffnung verlieren keine Änderungen.
Inhalt, Links und Speicherstatus bleiben nach Peer-Änderung, Neustart und Recovery
korrekt. Die reguläre Gesamtsuite und die tatsächlich betroffenen UI-/Recovery-
Fälle bestehen am freizugebenden Produktstand. Eine reine Verlängerung der
Freigabefrist oder ein höherer Cache-Grenzwert gilt nicht allein als Abnahme.

### 6. Leistungsgrenzen und sichere Einführung

Nach der Bündelung verbleibende langsame Abfragen anhand tatsächlicher
`EXPLAIN (ANALYZE, BUFFERS)`-Pläne im isolierten repräsentativen Datenbestand prüfen.
Erst daraus zusätzliche Indizes ableiten. Vorläufige Entwurfsziele: höchstens fünf
SQL-Lesezugriffe pro aktueller Berechtigungsbeobachtung, höchstens zwanzig für ein
normales Dokumentöffnen und wenige Hundert für eine Neuanlage. Die endgültigen
Grenzen sind noch nicht abgenommen; 200–500 Anweisungen für die vollständige
Neuanlage sind zunächst ein Arbeitsbereich. Endgültige Grenzen anhand des
vollständigen Ablaufs festlegen, mit deutlichem Abstand zu den
bestehenden Zeitlimits und begrenzter Abhängigkeit von der Verzeichnistiefe.

Korrektheits- und Leistungstests umfassen echte PostgreSQL-Antwortlatenz, entzogene
Rechte, parallele Bearbeitung, fehlende Zustände, defekte Metadaten, HTML, Alias-
Konflikte, relative Links und neue Ziele für bisher unaufgelöste Verweise.
Desktop und Mobilansicht prüfen. Die vereinbarte reguläre Gesamtsuite muss grün sein;
Spezialumgebungen für Review Center und Undo werden dafür nicht neu aufgebaut.
Die vollständige API-/SDK-Matrix aus Abschnitt 5b ist ein eigenes Release-Gate;
ein erfolgreicher Editor- oder MCP-Lauf allein erfüllt sie nicht.
Das Browser-Paket 4c mit den Nachweisen aus Abschnitt 5c ist ebenfalls vor dem
Abschluss der Einführung abzunehmen; ein schneller Backend-Read allein belegt
keinen schnellen und korrekten Dokument-Tabwechsel.

Einführung in kleinen PRs: Messung/Verträge → gebündelte Leser → inkrementeller
Linkindex → gemeinsame Änderungspfade → API-Key-Verwaltung → API-/SDK-Abnahme
→ Browser-Dokumentcache und Tabwechsel
→ kontrollierte Umschaltung und Bereinigung.
Neue Leseergebnisse zunächst mit dem bisherigen, vollständigen Neuaufbau vergleichen.
Die Umschaltung erfolgt pro Ablauf und mit Rückfall auf den vorherigen Codepfad.
Bei Datenänderungen bedeutet Rückfall nicht das Überschreiben neuerer Inhalte.

Die PR-Reihenfolge folgt den Abhängigkeiten: zuerst Messung und Verträge, danach
gebündelte Berechtigungs-/Dokumentleser, anschließend inkrementelle Linkprojektion,
danach die gemeinsamen Änderungspfade, API-Key-Verwaltung und vollständige
API-/SDK-Abnahme, Browser-Dokumentcache/Tabwechsel und abschließend
Einführung/Bereinigung.
Jeder PR benennt seine tatsächlich umgestellten Aufrufer, Vorher-/Nachher-Messungen
und die noch offenen Abläufe. Der erste Leseumbau wird an einem einzigen Adapter
geprüft, bevor die übrigen Adapter folgen.

**Fertig:** Erforderliche CI-Prüfungen und umsetzbare Reviews abgeschlossen,
reguläre Gesamtsuite und UI grün, überprüfte Sicherung/Wiederherstellung vor
Produktionsmigration, danach Release, kontrolliertes Deployment und Prüfung aller
fünf Workspaces. Kein neues Release wird durch den Plan allein als fertig erklärt.

## Verhältnis zum bereits begonnenen Fehlerfix

Der Funktionsfix ist über [PR #188](https://github.com/canvascoding/canvas-notebook/pull/188)
auf `main` integriert und als [Release 2026.10.29.1](https://github.com/canvascoding/canvas-notebook/releases/tag/v2026.10.29.1)
veröffentlicht und produktiv ausgerollt. Der geprüfte Release-Commit ist
`08bce484ab0bd52c59c2d593852704b9e4800631`. CI, Release-Artefakte, Prüfsummen,
Standalone-Signatur, Update-Registrierung und der gesunde Produktionsstart sind
nachgewiesen.

Die sieben Altregistrierungen wurden nach tatsächlicher Backup-Wiederherstellung
verlustfrei repariert. Identitäten, Historien und unveränderte Quellen blieben erhalten;
alle sieben Dokumente sind über den echten MCP-Connector wieder lesbar. Die
ursprüngliche unvollständige Dokumentanlage wurde danach im angemeldeten,
ursprünglichen Agent-Chat mit identischem Inhalt und Vorgangsschlüssel abgeschlossen.
Dokument-ID, Lineage und der unveränderliche Operationsbeleg einschließlich `xmin`
blieben erhalten. Editor, Dateibaum, beide ausgehenden Links, vollständiges MCP-Lesen
und eine MCP-Schreibprüfung ohne Inhaltsänderung bestehen. Die abgeschlossene
Wiederherstellung und ihre Belege sind zusätzlich in einem geprüften lokalen und
remote verfügbaren Backup enthalten.

Für den veröffentlichten Funktionsfix bestehen die reguläre Gesamtsuite mit
329 erfolgreichen Fällen, 268 bestehenden bedingten Überspringungen und null
Fehlern sowie sieben zusätzlich aktivierte Recovery-/Linkfälle ohne Browser-Retries.
Die Überspringungen sind nicht ausschließlich Review-Center-Tests. Acht weitere
Testgruppen prüfen native Agent-/MCP-Bearbeitungen über die registrierten
Tool-Einstiege mit PostgreSQL; diese sind keine Behauptung über produktive
Modellaufrufe oder die OAuth-Ausstellung.

Die weitere inkrementelle Zielauflösung ist inzwischen über PR #191 auf `main`
integriert (`6302d6403755e581f0eae9e83a10e1c016aa918c`). Die kombinierte Abnahme
am Produktstand `64532d709` umfasst 102 gezielte Tests, zwölf zusätzliche Fälle
mit kodierten relativen Dateinamen, die echte Cookie-/PostgreSQL-Route mit 10/200
Dokumenten, beide Builds, Start und die reguläre Gesamtsuite (331/0/269).
Recovery-/Linkfälle und HEIF bestehen ebenfalls ohne Browser-Retries. Bei 200
Dokumenten benötigt ein warmer Indexabruf keine neue Zielauflösung; eine geänderte
Quelle löst nur ihre zwei Links neu auf. Das gemessene warme Routenfenster bleibt
bei 36 SQL-Aufrufen und sieben Ausleihen. Dies ist keine SQL-Reduktion und keine
Gesamtabnahme des Serviceumbaus; die Ergebnisse stehen im
[Bericht](architecture/document-link-resolution-projection-2026-10-30.md).

Der vollständige Serviceumbau, die inkrementellen Header-/Body-Lesungen, die übrige
Bündelung und Vereinheitlichung der Änderungspfade sowie die endgültigen
Leistungsbudgets bleiben offen. Die folgenden Teilberichte dokumentieren die
jeweiligen Zwischenstände und ersetzen diese Gesamtabnahme nicht.

Die [gemeinsame frische Bindungsbeobachtung](architecture/document-service-read-binding-2026-10-28.md)
bündelt Realm, Relationsauflösung und rohe Workspace-Felder an jeder unveränderten
Prüfstelle. Sechs erfolgreiche Kontrollen und fünfzehn echte Fehlerfälle über HTTP,
Agent und MCP erhalten Grenzen, Rollback und Originaldaten. Zehn PG-Suiten,
Release-/erweiterte TypeScript-Prüfung und ESLint bestehen. Zwölf echte getrennte
Fixtures mit 10/200 Dokumenten sparen in allen 18 Vergleichsfenstern jeweils zwölf
SQL-Aufrufe bei unveränderten Ausleihen. Normales warmes HTTP-Lesen sinkt von
88 auf 76 SQL-Aufrufe / 9 Ausleihen. Das finale Budget und alle übrigen Pakete
bleiben offen; dies ist keine Produktions-/Release-Abnahme.

Die [gemeinsame native Realm-/Sperrbeobachtung](architecture/document-service-native-read-fence-2026-10-28.md)
ersetzt benachbarte Realm-/Relations-/Shared-Lock-Lesungen an allen fünf bestehenden
Header-/Body-Grenzen. Sechs Kontrollen und 24 reale Fehlerfälle sowie zehn Lese-/
Such-/Rechte- und drei tatsächliche Edit-PG-Suiten bestehen. Der veraltete ACK-Hook
des Owner-Tests wird nach nachgewiesenem Ausgangsfehler an die tatsächliche Member-
Beobachtung angepasst; alle ursprünglichen Recovery-Assertions bleiben erhalten.
Zwölf 10/200-Dokument-Fixtures sparen in allen 18 Vergleichsfenstern sechs weitere
SQL-Aufrufe: warm HTTP 76 → 70 / 9 Ausleihen, Agent 116 → 110 / 3 und MCP 90 → 84 / 19.
Release-TypeScript, erweiterte TypeScript-Prüfung (55 Wurzeln/5184 Quellen) und ESLint
bestehen. Gesamtbudgets und übrige Pakete bleiben weiterhin offen.

Die [gebündelte aktuelle Editor-Statusprüfung](architecture/document-service-peer-status-2026-10-29.md)
ersetzt zwei unmittelbar aufeinanderfolgende vollständige Principal-Phasen durch
eine feste, rein beobachtende Phase. Aktuelle Schreibrechte, die ursprüngliche
Transportgrenze und Quarantäne bleiben geprüft; die zusätzliche frische
Schreibfreigabe vor dem tatsächlichen Apply bleibt unverändert. 66 echte
PostgreSQL-Fälle bestehen. Ein Statuscheck sinkt von 94 SQL / 18 Ausleihen auf
47 / 9. Im gepaarten Editorlauf mit zehn regulären Quellen sinkt das breite
6,1-Sekunden-Fenster nach dem Öffnen von 1220 / 233 auf 782 / 151; beide Saves
benötigen ebenfalls weniger Abfragen. Der Laufzeitgewinn beim Speichern ist klein.
Die finalen Budgets, übrigen Pakete und Prüfungen vor dem Release bleiben offen.

Die [mobile Originalwiederholung unter einem echten Leser](architecture/document-service-mobile-replay-2026-10-29.md)
behebt einen weiteren im Linux-UI-Lauf gefundenen HTTP-500-Pfad. Ein bereits
dauerhaft angewendeter Beleg wird anhand seines ursprünglichen Yjs-Snapshots
lesend bestätigt, ohne noch einmal in den nativen Schreiber einzutreten. Die
Aktivität bleibt eine aktuelle Benutzer-/Owner-/Identitätsprüfung; öffentliche
Schreibfreigabe und tatsächlicher Apply behalten den strengen Schreibzaun.
Unangewendete Änderungen und echte Fremdschreiber bleiben abgewiesen. Eine neue
echte PG-Suite und die bisherigen 15 Grenzfälle bestehen. Am Produktstand
`24b234d61` bestehen beide Produktionsbuilds, gleicher Linux-Datenbestand beim
Neustart, alle vier UI-Fälle, 15 Linux-Speicherfälle und neun CI-Prüfungen. Die
Originaldaten bleiben nach dem gesamten Lauf unverändert. Die finale Gesamtsuite,
Budgets, übrigen Pakete und Release-Abnahme bleiben offen.
