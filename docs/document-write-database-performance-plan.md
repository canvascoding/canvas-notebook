# Plan: zentraler Dokument- und Linkservice

Stand: 01.11.2026. Ziel ist eine robuste und messbar schnelle gemeinsame Grundlage
für Dokumente, Linkpflege und Aktualisierungen aus Editor, Agenten, MCP und normalen
Dateioperationen. Review Center und Undo sind ausdrücklich außerhalb der Umsetzung.
Bestehende Daten und weiterhin erforderliche Speicherformate werden erhalten.

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

Arbeitsstand am 01.11.2026; die jeweils geprüften Produktstände und Teilbelege
stehen in den zugehörigen Abschnitten:

| Paket | Status | Nächster konkreter Nachweis |
| --- | --- | --- |
| 0 | in Umsetzung | Quellen-/Recovery-Fälle am endgültigen gebauten Produktstand und nach Einführung bestätigen. Die lokalen Belege stehen unten. |
| 1 | in Umsetzung | Die vollständigen neuen REST-/SDK- und Browser-Aufrufer in die vergleichbare 10-/200-Quellen-Messung aufnehmen. |
| 2 | in Umsetzung | Verbleibende dominante Abfrageketten nach den unten dokumentierten Teiloptimierungen messen und gezielt bündeln. |
| 3 | in Umsetzung | Tatsächlich umgestellte Aufrufer gegen vollständigen Link-Neuaufbau und die abschließenden Leistungsbudgets prüfen. |
| 4 | in Umsetzung | Die noch fehlenden API-Key-Schreib-/Job-Ursprünge an die vorhandenen Speicher- und Operationskerne anbinden. |
| 4a | in Umsetzung | Datei-/Recovery-Adapter und Key-Import bestehender Originaldateien ergänzen; vollständige kompilierte Abnahme durchführen. Verwaltung, Leseadapter sowie native HTTP-/MCP-Create-/Import-/Edit-Wege einschließlich installiertem SDK sind lokal teilweise abgenommen, siehe 5a. |
| 4b | in Umsetzung | Die noch fehlenden Schreib-/Recovery-Matrixfälle aus 5b vorbereiten und danach am kompilierten Produkt prüfen. |
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
Batch und keine Historie. Die gesamte öffentliche Key-Apply-/Status-/Recover-
Steuerung über REST/MCP und die installierte SDK-Abnahme sind weiterhin offen.

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

### 5b. Vollständige API- und SDK-Testmatrix

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

**Status: geplant, noch nicht umgesetzt oder abschließend gemessen.** Gemeint sind
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
