# Plan: zentraler Dokument- und Linkservice

Stand: 31.10.2026. Ziel ist eine robuste und messbar schnelle gemeinsame Grundlage
für Dokumente, Linkpflege und Aktualisierungen aus Editor, Agenten, MCP und normalen
Dateioperationen. Review Center und Undo sind ausdrücklich außerhalb der Umsetzung.
Bestehende Daten und weiterhin erforderliche Speicherformate werden erhalten.

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
| 4. Schreibwege vereinheitlichen | Bestehende Speicherung, Versionsprüfung und dauerhafte Belege hinter kleinen gemeinsamen Operationen verwenden; Aufrufer einzeln umstellen. | Editor, Agent und MCP liefern gleiche Speicher- und Linkergebnisse. Gleichzeitige Änderungen, Wiederholungen und Abbruch verlieren keine Daten. |
| 5. Einführung absichern | Endgültige Leistungsbudgets, reguläre Gesamtsuite, Desktop/Mobil, PR/CI/Reviews, Backup-/Restore-Nachweis und kontrolliertes Release. | Alle tatsächlich umgestellten Abläufe sind nachgewiesen; nach Deployment funktionieren Filetree, Öffnen, Speichern und Linkpflege in allen fünf Workspaces. |

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

Editor / Agent / MCP / Systemauftrag
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
Backlinks und Umbenennen/Verschieben erfassen. Pro Aktion und Phase SQL-Anzahl,
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

Editor, Agent und MCP delegieren die eigentliche Speicherung an dieselben
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

Einführung in kleinen PRs: Messung/Verträge → gebündelte Leser → inkrementeller
Linkindex → gemeinsame Änderungspfade → kontrollierte Umschaltung und Bereinigung.
Neue Leseergebnisse zunächst mit dem bisherigen, vollständigen Neuaufbau vergleichen.
Die Umschaltung erfolgt pro Ablauf und mit Rückfall auf den vorherigen Codepfad.
Bei Datenänderungen bedeutet Rückfall nicht das Überschreiben neuerer Inhalte.

Die PR-Reihenfolge folgt den Abhängigkeiten: zuerst Messung und Verträge, danach
gebündelte Berechtigungs-/Dokumentleser, anschließend inkrementelle Linkprojektion,
danach die gemeinsamen Änderungspfade und abschließend Einführung/Bereinigung.
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
