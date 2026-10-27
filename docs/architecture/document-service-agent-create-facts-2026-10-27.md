# Agent Create: aktuelle Scope-Daten gemeinsam lesen

Stand: 27.10.2026. Vergleich mit der [abgeschlossenen Create-Matrix](document-service-create-matrix-2026-10-27.md).
Produktgrundlage `fdbd3136575fd29244298a33ecf1e3a954675b59`; die einzige geänderte Produktdatei ist
`app/lib/workspaces/request-principal.ts`. Der [maschinenlesbare Bericht](document-service-agent-create-facts-2026-10-27.json)
bindet die tatsächlichen Quellen und Messwerte ohne Inhalte, Dokument-/Benutzeridentitäten,
Dokumentpfade, SQL-Texte, Parameter oder Secrets.

## Änderung

Der reguläre Agenten-Neuanlagepfad liest Workspace, ursprüngliche PI-Sitzung,
Agentenprofil und Konto bei jeder notwendigen Current-Prüfung in einem frischen
SQL-Snapshot auf seiner bereits gehaltenen und gesperrten Verbindung. Die
Sitzungs- und Profilvalidatoren sind unverändert als reine Funktionen extrahiert;
der normale Principal und Job-Aufrufer behalten ihre bisherigen Lesewege.
Seat-/Workspace-/Agentenrichtlinien, Realm- und Transaktionsprüfungen, Fristen,
Widerrufsbehandlung und dauerhafte Originalbelege bleiben aktiv. Die gelesenen
Zeilen sind nur lokale Werte dieses Aufrufs; es gibt keinen Cache über Prüfungen.

## Gleicher Aufrufer und gleiche Testdaten

Beide Größen laufen in frischen privaten PostgreSQL-18-Fixtures mit dem bestehenden
registrierten `write` und tatsächlichen normalen Uploads. Der identische Testaufbau
prüft vollständigen nativen Inhalt, Original-Birth und Projektion, authentifizierten
Dokument-ID-Leser, alle ursprünglichen Registry-/Native-/Metadaten-/xmin-/Dateistände
und eine gesonderte ursprüngliche Wiederholung ohne zweite Anlage. Alle Ressourcen
werden vollständig geschlossen. Die Kontrollläufe sind 49 normale Principal-,
26 Original-Origin-, 48 aktuelle Scope-Fälle und zwölf native PI-Create-Gruppen;
darin bleiben unbestätigtes COMMIT, Reentranz, abgelaufene oder vertauschte Kontexte,
Rechte-/Toolwiderruf und vollständiger Rollback geprüft.

Die Tabelle nennt SQL-Aufrufe vor/nach der Änderung; Pool-Ausleihen bleiben gleich.

| Anfangsbestand | Erster Adapteraufruf | Warme Neuanlage 1 / 2 | Ursprüngliche Wiederholung | Ausleihen erster / warm / Wiederholung |
| --- | ---: | ---: | ---: | ---: |
| 10 | 5308 → 4597 | 5203 → 4492 / 5203 → 4492 | 326 → 284 | 92 / 58 / 7 |
| 200 | 5308 → 4597 | 5203 → 4492 / 5203 → 4492 | 326 → 284 | 92 / 58 / 7 |

Die 229 aktuellen Autorisierungsbeobachtungen im Create-Engine bleiben erhalten;
ihre SQL-Aufrufe sinken von 2.748 auf 2.061 (25 Prozent). Das vollständige
Create-Engine-Fenster sinkt von 4.994 auf 4.307 Aufrufe. Der vollständige warme
Adapteraufruf sinkt von 5.203 auf 4.492 (rund 13,7 Prozent). Seine Messgrenze enthält
weitere echte Prüfungen außerhalb des Create-Engine; deshalb beträgt seine
Einsparung 711 und diejenige des Engine 687. Diese verschachtelten Werte werden
nicht addiert. Die ersten drei Fenster je Größe betreffen frische Neuanlagen; die
Originalwiederholung wird gesondert gemessen.

Release-TypeScript und die abhängigkeitsgeschlossene Typprüfung des Testmoduls
(5.071 Quelldateien, 23 Wurzeln) liefern null Diagnosen; ESLint besteht. Die
Messungen belegen weniger Abfragen. Sie belegen weder einen kontrollierten
Latenzgewinn noch eine verringerte Zahl von Pool-Ausleihen. Jeder Aufruferlauf
beginnt in einem neuen Node-Prozess; der PostgreSQL-Puffercache wird nicht geleert. Das isolierte Lizenzzertifikat
ist ein Testwert; produktive Lizenz-/OAuth-Ausstellung und Modellaufrufe sind
nicht Teil des Vergleichs.

Weitere Berechtigungs-/Realm-Bündelung, inkrementelle Zielauflösung, gemeinsame
normale Schreibmechanik, Original-Recovery und endgültige Leistungsbudgets bleiben
offen. Der finale Produktstand braucht erneut Build/UI, reguläres `test:all`,
PR/CI/Reviews, einen tatsächlichen Backup-/Restore-Nachweis und kontrolliertes
Deployment in allen fünf Workspaces. Review Center und Undo werden nicht weiterentwickelt.

Der saubere Produktcommit `f17b175ef92061cf635ee87d2c33c79202dc982c` besteht
anschließend den vollständigen Produktionsbuild und 14 aktuelle Desktop-/Mobil-
Integrationsmerkmale einschließlich zweier Peers, Offline/Reconnect und exakter
Rückführung der Originalinhalte. Der [aktuelle UI-Nachweis](document-service-native-path-ui-2026-10-27.md#integration-nach-gebündelten-agenten-scope-lesern)
trennt diese Editor-Integration von den tatsächlichen registrierten Agenten-Aufrufen.
Die genannten abschließenden Gesamtplan-Gates bleiben offen.

## Aktueller Benutzer und Workspace in einem Snapshot

Die nächste Bündelung liest die aktuelle Benutzer-ID, E-Mail und Rolle zusammen mit
Workspace- und Berechtigungszeilen auf derselben Verbindung. Der vorhandene
Workspace-Rechte-Mapper und `resolveWorkspaceActor` bleiben unverändert.
Der gespeicherte PI-Sitzungsbezug, verlangte Berechtigungen und aktuelle Agentenrechte
werden weiter geprüft. Es gibt keine neue Autorität, Bootstrap-Schreibvorgänge,
Cache, Transaktion oder Pool-Ausleihe. Der [maschinenlesbare Nachweis](document-service-current-user-workspace-2026-10-27.json)
bindet die tatsächlichen Quellbytes und abgegrenzten Messwerte.

Alle 21 tatsächlichen PostgreSQL-Workspace-Varianten stimmen vollständig mit dem
bisherigen Leser überein: Organisation, Team, Personal, Projekt, fehlende und
gesperrte Zuordnungen, geänderte Kontorolle/E-Mail sowie fehlende Konten. Der neue
Leser benötigt genau eine Abfrage. Alle zwölf echten MCP-Authority-Familien,
16 gezielte Unit-Fälle, 49 normale Principal-, 26 Original-Origin-, 48 aktuelle
Agenten-Scope-Fälle und zwölf native PI-Create-Gruppen bestehen. Release-TypeScript,
Test-TypeScript (5.088 Quellen, 24 Wurzeln, null Diagnosen) und ESLint sind grün.

Der gleiche registrierte Agent mit zehn regulär angelegten Quellen benötigt beim
ersten Einstieg 4.344 statt 4.597, bei den beiden warmen Neuanlagen jeweils 4.239
statt 4.492 und bei der Originalwiederholung 268 statt 284 SQL-Aufrufe. Die Ausleihen
bleiben 92/58/7. Die 229 aktuellen Autorisierungsbeobachtungen bleiben erhalten und
benötigen jetzt 1.832 statt 2.061 Abfragen; das Create-Engine-Fenster sinkt von
4.307 auf 4.064. Vollständiger Originalinhalt, Birth-/Projektionsbelege, unveränderte
vorherige Zeilen/Metadaten/xmin/Dateien und Wiederholung ohne zweite Anlage werden
weiter im echten Werkzeuglauf geprüft. Alle eigenen Fixture-Ressourcen sind geschlossen.

Diese Zwischenmessung gilt nur für zehn Quellen. Der nachfolgende gemeinsame
Snapshot ist zusätzlich mit 200 Quellen geprüft. Der oben dokumentierte
Build/UI-Nachweis gilt für den vorherigen Produktcommit `f17b175ef`; spätere
Produktänderungen werden dadurch nicht als UI-geprüft bezeichnet.

## Konto, Seat und vollständige Workspace-Richtlinie gemeinsam lesen

Die echte Agenten-Neuanlage liest nun zusätzlich die vollständigen aktuellen
Seat- und Workspace-Berechtigungsdaten zusammen mit ursprünglicher PI-Sitzung,
Profil und Konto in derselben SQL-Anweisung. Jede Current-Beobachtung lädt diese
Daten neu auf der tatsächlich gehaltenen Verbindung. Die bisherigen Seat-
Entscheidungsfunktionen, der vollständige Workspace-Mapper und der aktuelle
Agenten-Zugriffsresolver werden weiterverwendet. Der gewöhnliche Seat-Einstieg
und die gewöhnlichen/Job-Agentenpfade behalten ihre bisherigen Prüfungen.

Der [maschinenlesbare Vergleich](document-service-joint-create-facts-2026-10-27.json)
bindet die tatsächlichen Quellbytes auf Grundlage `b74a13d06fec4c5ee541c0a45957bfeb76c40d16`.
Alle ursprünglichen Current-Beobachtungen, Zeitgrenzen, Sperren und
Realm-/Schema-/Relationsprüfungen bleiben erhalten. Es gibt keinen Cache über
Beobachtungen und keine neue Autorität aus den gelesenen Werten.

| Anfangsbestand | Erster Adapteraufruf vorher → aktuell | Warme Neuanlage 1 / 2 vorher → aktuell | Ursprüngliche Wiederholung vorher → aktuell | Ausleihen erster / warm / Wiederholung |
| --- | ---: | ---: | ---: | ---: |
| 10 | 5308 → 3633 | 5203 → 3528 / 5203 → 3528 | 326 → 226 | 92 / 58 / 7 |
| 200 | 5308 → 3633 | 5203 → 3528 / 5203 → 3528 | 326 → 226 | 92 / 58 / 7 |

Das vollständige warme Fenster des registrierten Hauptagenten benötigt damit
rund 32 Prozent weniger SQL-Aufrufe als die ursprüngliche vergleichbare Matrix.
Das Create-Engine-Fenster sinkt von 4994 auf 3377. Seine unverändert 229 aktuellen
Berechtigungsbeobachtungen benötigen 1145 statt 2748 Aufrufe, also jeweils fünf
statt zwölf. Die verschachtelten Fenster werden nicht addiert; Pool-Ausleihen
bleiben unverändert. Ein kontrollierter Latenzgewinn wird nicht behauptet.

Beide unabhängigen Fixtures verwenden reguläre Uploads und prüfen vollständige
Original-Birth-/Projektionsbelege, authentifizierte ID-Lesezugriffe, vollständige
native/physische Inhalte sowie sämtliche vorherigen Zeilen, Metadaten, xmin und
Dateien. Die ursprüngliche Wiederholung erhält ihre Identität ohne zweite Anlage.
Alle eigenen PostgreSQL-, Prozess- und Dateisystemressourcen werden geschlossen.

60 echte Scope-Fälle prüfen Haupt-, E-Mail- und eingeschränkte Agenten jeweils
im gewöhnlichen und Create-Pfad mit Kontrolle sowie Organisations-, Sitzungs-,
Profil-, Workspace-, Konto- und Seat-Änderungen. Dazu gehören neu ein deaktivierter
Workspace und ein suspendierter Seat innerhalb der tatsächlich gehaltenen
Transaktion. Abgewiesene Änderungen erhalten alle beobachteten Autoritätszeilen
einschließlich Seat-/Sync-/Organisationsberechtigungen und xmin durch Rollback.
Alle zwölf MCP-Authority-Familien, 21 Workspace-Paritätsvarianten, 49 gewöhnlichen
Principal-, 26 Original-Origin-Fälle und zwölf nativen PI-Create-Gruppen bestehen.
Release-TypeScript, Test-TypeScript (5093 Quellen, 25 Wurzeln, null Diagnosen) und
ESLint sind grün.

Eingeschränkte Agenten verwenden weiterhin ihren vollständigen tatsächlichen
Zugriffsresolver: In den erfolgreichen nativen Create-Fällen mit 229 Beobachtungen
sind es 2519 Autorisierungsabfragen, also elf je Beobachtung, und 4835 im Engine.
Dieses Budget bleibt offen. Im warmen Hauptagentenfenster entfallen weiterhin
1884 der 3528 Aufrufe auf die heuristische Katalog-/Verbindungskontextgruppe,
insbesondere PostgreSQL-Schema-/Relationsprüfungen. Die Gesamtbudgets für Create,
weitere Adapter und Pool-Ausleihen sind damit noch nicht erreicht.

Die vollständige GitNexus-Aktualisierung scheitert an `LOWER: Invalid UTF-8`.
Gezielte Symbol-Impactprüfungen und die vorgeschriebenen Änderungsanalysen sind
weiter ausführbar; die tatsächlichen Quelländerungen werden zusätzlich geprüft.
Der aktuelle Produktstand benötigt abschließend Build/UI und reguläres
`test:all`; gemeinsame Verträge, inkrementelle Zielauflösung, Schreibmechanik,
Original-Recovery und sämtliche PR-/Rollout-Gates des Gesamtplans bleiben offen.

## Native Realm- und Relationsbeobachtung in einem Snapshot

Die gemeinsame native Importmechanik liest bei gewöhnlichen Realm-Beobachtungen
Verbindungsidentität und sämtliche erforderlichen Tabellenzuordnungen jetzt in
einer statt zwei SQL-Anweisungen. Der vorhandene Identitätsparser und beide festen
SQL-Leser sind bytegleich ausgelagert. Der sperrende Einstieg behält die Reihenfolge
frische Identität → tatsächliches `LOCK` → frische Relationsprüfung. Jede
Beobachtung lädt neue Daten; Current-Prüfungen und Zeitgrenzen bleiben erhalten.
Der [Quell- und Messnachweis](document-service-native-realm-snapshot-2026-10-27.json)
bindet den Vergleich auf Grundlage `55afd27eecdde730f5fa8807da1b2b315e54b24e`.

| Zehn regulär angelegte Quellen | Erster Adapteraufruf | Warme Neuanlage 1 / 2 | Ursprüngliche Wiederholung | Ausleihen erster / warm / Wiederholung |
| --- | ---: | ---: | ---: | ---: |
| Derselbe Hauptagent vorher → aktuell | 3633 → 3590 | 3528 → 3485 / 3528 → 3485 | 226 → 226 | 92 / 58 / 7 |
| Aktueller MCP-Aufrufer | 3244 | 3223 / 3223 | 133 | 50 / 37 / 12 |

Das Hauptagenten-Engine sinkt von 3377 auf 3334 SQL-Aufrufe. Alle 229 aktuellen
Berechtigungsbeobachtungen bleiben bei insgesamt 1145 Aufrufen. Vorhandene
Dokumente, ihre nativen Zeilen/Metadaten/xmin/Dateien, tatsächliche vollständige
Birth-/Projektionsbelege, authentifizierter Inhalt und ursprüngliche Wiederholung
ohne zweite Anlage werden weiter in beiden echten registrierten Werkzeugen geprüft.
Die Fenster überlappen; Pool-Ausleihen bleiben gleich. Ein kontrollierter
Latenzgewinn wird nicht behauptet. Der aktuelle Vergleich gilt für zehn Quellen;
die vorangegangene 200er-Abnahme gehört zum vorherigen Produktstand.

16 echte Upload-, 15 Erstprojektions-, 15 manuelle Create-, 15 Copy-Metadaten-,
26 vollständige Copy-Owner- und zwölf PI-Create-Fälle bestehen. Dazu zählen tatsächliche
verlorene COMMIT-/Filesystem-Bestätigungen, Rechtewiderruf, Prozess-/Sitzungswechsel,
Parallelität, Original-Recovery und vollständige Ressourcenbereinigung. Ein neuer
Negativtest ersetzt innerhalb der echten Transaktion eine native Tabellenzuordnung:
Der erwartete Realm-Fehler verhindert COMMIT; Rollback stellt die Original-OID und
sämtliche beobachteten nativen Zeilen einschließlich xmin wieder her.

Die Upload-Fixture führt nun die unveränderte tatsächliche `current_schema()`-
Migration aus. Zwei manuelle Testannahmen zum alten deaktivierbaren Test-Opt-in
passen zum inzwischen dauerhaft aktivierten nativen Kern: Web und Mobil erzeugen
auch ohne Opt-in vollständige Dokumente; die Wiederholung erhält Identität, nativen
Inhalt, Lineage und Revisionszahl. Gewöhnliche Route-Effekte einschließlich
Registry-Zeitstempel und Audit bleiben dabei aktiv. Diese Korrekturen verändern
keinen Produktschalter und keine Review-Center-/Undo-Funktion.

Release-TypeScript, Test-TypeScript (5086 Quellen, 24 Wurzeln, null Diagnosen),
ESLint und die aktuellen PostgreSQL-Nachweise bestehen. Der große aktuelle
Vergleich, Build/UI und reguläres `test:all` folgen nach Abschluss des gesamten
Bündelungspakets; die übrigen Architektur-, Recovery- und Rollout-Gates bleiben offen.

## Abschließenden Agenten-Ursprung gemeinsam beobachten

Die private echte Agenten-Neuanlage liest drei unmittelbar benachbarte abschließende
Identitäts-/Ursprungs-/Identitätsbeobachtungen jetzt in einem frischen SQL-Snapshot.
Dazwischen lag bisher weder ein Callback noch eine Mutation. Ein `LEFT JOIN` erhält
die vollständige Kontextbeobachtung auch bei fehlendem Workspace. Der bisherige
Identitätsvalidator, sein eigenständiger SQL-Leser und die vollständige
Agenten-/Sitzungs-/Seat-/Workspace-Entscheidungslogik sind bytegleich ausgelagert.
Gewöhnliche Principals behalten ihre Lesekette; eingeschränkte Agenten behalten
ihren tatsächlichen zusätzlichen Zugriffsresolver. Es gibt keinen Prüfungs-Cache
und keine Änderung an Sperren, Toolkonfiguration oder Phasenfristen.

Der [Quell- und Messnachweis](document-service-agent-final-origin-snapshot-2026-10-27.json)
bindet die tatsächlichen Quellen auf Grundlage `585f82edb`. Zwölf neue echte
PostgreSQL-Fälle verändern nach dem tatsächlichen Scope-Snapshot dieselbe gehaltene
Transaktion: Suchpfad, Workspace-Wurzel/-Status, Tabellenzuordnung oder fehlende
Workspace-Tabelle. Haupt- und E-Mail-Agent werden kontrolliert geprüft. Jede
Abweisung verhindert Ergebnisfreigabe und Ursprungs-Sink; Rollback stellt alle
beobachteten Autoritätszeilen/xmin und ursprünglichen Tabellen-OIDs wieder her.
Diese zwölf Fälle bestehen sowohl vor als auch nach der Produktänderung. Dazu
bestehen 60 Scope-, 49 gewöhnliche Principal-, 26 Original-Origin-, 66 Member-/
Metadaten-, zwölf MCP- und zwölf native PI-Create-Gruppen.

| Zehn normale Upload-Quellen | Erster Adapteraufruf | Warme Neuanlage 1 / 2 | Ursprüngliche Wiederholung | Ausleihen erster / warm / Wiederholung |
| --- | ---: | ---: | ---: | ---: |
| Derselbe Hauptagent vorher → aktuell | 3590 → 3116 | 3485 → 3011 / 3485 → 3011 | 226 → 198 | 92 / 58 / 7 |

Alle 229 aktuellen Berechtigungsbeobachtungen bleiben aktiv; sie benötigen 687
statt 1145 SQL-Aufrufe, also drei statt fünf je Beobachtung. Das Engine-Fenster
sinkt von 3334 auf 2876. Die beiden vollständigen warmen Adapterfenster sparen
jeweils 474 Aufrufe (rund 13,6 Prozent gegenüber dem vorigen Stand). Darin liegen
1367 Katalog-/Kontextabfragen (45,4 Prozent), 829 Konto-/Seat-/Agenten-/Workspace-/
Sitzungsabfragen (27,5 Prozent) und 273 Dokumentzustands-/Register-/Projektionsabfragen
(9,1 Prozent). Die Gruppen sind heuristisch; die verschachtelte Autorisierungsphase
wird nicht dazuaddiert. Pool-Ausleihen bleiben gleich; ein kontrollierter
Latenzgewinn ist nicht nachgewiesen. Frühere 200er-Nachweise gehören zu früheren
Quellen. Das endgültige Create-Budget ist weiterhin offen.

Ein früherer Member-Lauf traf bei einem konkurrierenden Metadaten-Patch einen
tatsächlichen Foundation-Tabellen-Sperrfehler `55P03`. Zwei nachfolgende vollständige
66er-Läufe bestehen; die sporadische Ursache ist damit nicht geklärt oder behoben.
Ein rein lesender Fehlerzeuge erfasst künftig konkrete eigene Sperrhalter und
Wartungsstände, ohne SQL-Ergebnisse, Fehler oder Parallelitätsassertionen zu ändern.
Ein zunächst fehlgeschlagener Agenten-Messlauf bestätigte nach dem Client-Ende noch
einen eigenen PostgreSQL-Backendprozess. Die Fixture beobachtet nun ausschließlich
ihre beiden exakten Zufallsnamen bis zu zwei Sekunden und entfernt ihr Schema nur
nach nachgewiesener Backend-Beendigung. Der zunächst zurückgelassene eigene
Schemazustand wurde nach OID-/Marker-/Eigentümerprüfung und null eigenen Backends
entfernt. Der akzeptierte Agentenvergleich und der MCP-Lauf schließen alle eigenen
Ressourcen und tätigen keine externen Netzaufrufe.

Release-TypeScript, Test-TypeScript (5094 Quellen, 26 Wurzeln, null Diagnosen),
ESLint und Quellenvergleich bestehen. Die offene Sperrbeobachtung, aktueller großer
Vergleich, finale Build-/UI-/Gesamtsuite und sämtliche weiteren Architektur-,
Recovery-, PR-/CI- und Release-/Rollout-Gates bleiben Teil des Gesamtplans.

## Eine Transaktion pro Agenten-Speicheraktion

Die feste Dateisystemhilfe meldet ihre Zwischenstände an den Koordinator zurück.
Bisher konnte jeder dieser Prüfaufrufe außerhalb einer laufenden Native-/
Publikationsphase eine eigene Principal-Transaktion eröffnen. Die echte Agenten-
Neuanlage hält jetzt eine Transaktion je vollständiger Speicheraktion: vor dem
ersten Root-/Guard-Aufruf bis nach Helper-Schluss, Rückmeldungsverarbeitung und
abschließenden Prüfungen. Eine bereits gehaltene Native-/Publikationsverbindung
wird wiederverwendet. Die nächste getrennte Aktion authentifiziert sich neu.

Der Koordinator liefert dafür einen begrenzten Phasen-Wrapper an die bestehende
Speichermechanik. Er gibt weder eine Verbindung noch eine Berechtigung zurück.
Sämtliche festen Storage-Guards sowie der tatsächliche Helper-/ACK-/Close-Körper
sind bytegleich erhalten. Principal, Tool-Policy, Transaktionskern und Python-Hilfe
bleiben unverändert. Die Fünf-Sekunden- und 50-ms-Grenzen gelten weiterhin; die
Transaktion wird während einer Aktion nicht durch neue Principal-Laufzeiten ersetzt.
Manuelle Anlage, Upload und MCP verwenden weiterhin ihren bisherigen Standardpfad.
Der [Quell- und Messbericht](document-service-agent-storage-phase-2026-10-27.json)
bindet die Abnahme auf Grundlage `4bebe6932`.

Ein echter PostgreSQL-/Helper-Test beobachtet beim ursprünglichen `open` zwei
Transaktions-IDs und schlägt ausschließlich an der neuen Phasengrenze fehl, nachdem
nativer und physischer Inhalt sowie bestätigte Birth-/Projektionszeilen geprüft sind.
Am neuen Stand verwenden sämtliche beobachteten Aktionen eine Transaktion. Zwei
tatsächliche konkurrierende Kontoänderungen blockieren während der Open-Rückmeldung
mit `55P03`; nach bestätigtem Aktions-Commit wird eine tatsächliche Kontosperre
zugelassen. Die nächste Principal-Phase weist sie mit `PRINCIPAL_AUTH_REVOKED` ab.
Für diese abgewiesene Anlage entstehen weder natives Dokument noch Importbeleg oder
öffentliche Datei. Die erfolgreiche Quelle bleibt vollständig und authentifiziert
über ihre ID lesbar; alle eigenen Ressourcen werden geschlossen.

| Zehn normale Upload-Quellen | Erster Adapteraufruf | Warme Neuanlage 1 / 2 | Ursprüngliche Wiederholung | Ausleihen erster / warm / Wiederholung |
| --- | ---: | ---: | ---: | ---: |
| Derselbe Hauptagent vorher → aktuell | 3116 → 2829 | 3011 → 2724 / 3011 → 2724 | 198 → 198 | 92 → 80 / 58 → 46 / 7 → 7 |

Das vollständige warme Fenster benötigt rund 9,5 Prozent weniger SQL-Aufrufe und
rund 20,7 Prozent weniger Pool-Ausleihen als der vorherige Stand. Der Engine sinkt
von 2876 auf 2589 Aufrufe und von 51 auf 39 Ausleihen. Seine Current-Beobachtungen
sinken von 229 auf 212, weil redundante Principal-Ein-/Austritte entfallen; die
bestehenden festen Grenzprüfungen bleiben aktiv. Jede Beobachtung benötigt weiter
drei SQL-Aufrufe. Vollständige Original-Birth-/Projektionsbelege, authentifizierte
ID-Leser, vorherige native Zeilen/Metadaten/xmin/Dateien und ursprüngliche Wiederholung
ohne zweite Anlage werden im vergleichbaren registrierten Werkzeug geprüft.
Die Messbereiche überlappen; ein kontrollierter Latenzgewinn ist nicht nachgewiesen.

Die neuen Speicherphasen-/Widerrufsnachweise, zwölf native PI-Create-, 60 Scope-,
zwölf Final-Origin-, 16 Upload-, 15 Erstprojektions- und 15 manuelle Create-Gruppen
sowie der Agentenvergleich bestehen. Die ursprünglichen Prüfungen umfassen unter
anderem tatsächlichen Bestätigungsverlust, Prozessabbruch und Wiederaufnahme. Ein
verlorener Commit speziell der neu eingeführten Speicheraktions-Transaktion wurde
im neuen fokussierten Test noch nicht separat injiziert; deren vorhandener
Transaktionskern verwirft die Verbindung und meldet den Ausgang unbestätigt.
Release-TypeScript, Test-TypeScript (5097 Quellen, 28 Wurzeln, null Diagnosen),
ESLint und Quellenvergleich bestehen. Weitere Adapter-/Zustandsbündelung, das
endgültige Gesamtbudget, aktueller großer Vergleich, Build/UI/`test:all`, ungeklärter
Member-Sperrfehler und sämtliche Architektur-/Recovery-/PR-/Release-Gates bleiben offen.

## Verlorene Bestätigung der Speicheraktions-Transaktion

Der [zusätzliche PostgreSQL-Nachweis](document-service-agent-storage-commit-2026-10-27.json)
schließt die oben benannte fokussierte Prüflücke auf Produktgrundlage `ba0a5ad97`.
Die Produktquellen bleiben unverändert. Je ein tatsächlicher Commit der neuen
Agenten-Speicheraktion wird erfolgreich ausgeführt und verliert anschließend seine
Antwort: `open` vor nativer Anlage und `verify` nach bestätigtem nativen Import,
aber vor physischer Publikation. Die tatsächlich beobachtete Client-/Transaktions-ID
und fehlende Daten-DML grenzen diese Speichertransaktion von der Importtransaktion ab.
Weder SQL-Zeilen noch Helper-Nachrichten oder Berechtigungen werden ersetzt.

Beide Aufrufe melden den Ausgang unbestätigt samt ursprünglichem Wiederholungsschlüssel.
Die alte Backend-Sitzung wird nachweislich verworfen; keine Helper-Aktion wird
automatisch wiederholt. Bis zum ausdrücklichen neuen Aufruf bleiben alle beobachteten
nativen Zeilen/xmin unverändert. Der ursprüngliche Speicherbeleg bleibt mit seiner
ID, seinem Fingerprint und vollständigen Intent erhalten.

Die Wiederaufnahme erzeugt genau ein vollständiges Dokument und eine Revision.
Beim bereits nativen Fall bleiben Dokument-ID, Lineage-ID, native Bytes, Vektor,
Generation und Sequenz sowie der ursprüngliche Importbeleg einschließlich xmin
erhalten. Die normale erste Versionsbindung nutzt ihren bestehenden Lineage-Upsert:
Der tatsächliche Rückgabewert behält die alte ID anstelle der vorgeschlagenen neuen.
Die vollständigen Lineage-Werte bleiben gleich; ihre Datenbankversion darf bei dieser
regulären Bindung fortschreiten. Eine Lineage-Löschung ist ausgeschlossen.

Authentifizierter ID-Leser und physische Datei liefern den vollständigen Originaltext.
Die anschließende Wiederholung des abgeschlossenen Originals meldet `already_created`,
führt null beobachtete führende INSERT-/UPDATE-/DELETE-Anweisungen aus und erhält
alle beobachteten Dokument-, Zustands-, Lineage-, Revisions-, Birth- und Projektionszeilen
einschließlich xmin. Die eigene Fixture schließt Schema, Pool, Clients und Dateien
ohne externe Netzaufrufe. Test-TypeScript (5098 Quellen, 29 Wurzeln, null Diagnosen)
und ESLint bestehen. Die Testergänzung ändert keine Produktmechanik und wiederholt
deshalb keinen Produktbuild oder UI-Lauf.

Dieser lokale Nachweis ersetzt nicht die Reparatur der ursprünglichen produktiven
LinkedIn-Anlage. Aktueller großer Vergleich, finale Build-/UI-/Gesamtsuite, ungeklärter
Member-Sperrfehler und die übrigen Service-/Recovery-/PR-/Release-Gates bleiben offen.

## Identität und exklusive Workspace-Sperre gemeinsam frisch prüfen

Der Importkoordinator prüft die tatsächliche dedizierte Lifecycle-Verbindung und
ihre exklusive Advisory-Sperre jetzt mit einer frischen SQL-Anweisung statt der
bisherigen drei Abfragen. Die vorhandene private Zuordnung von Lease, Verbindung
und laufendem Kontext wird verwendet. Eine ersetzte Verifier-Funktion wird vor
und nach dem Lesen abgewiesen; sie wird nicht als positiver Nachweis verwendet.
Der vorhandene Owner-Abschluss registriert, verwirft und drainiert abgetrennte
Leseaufrufe. Identitäts-SQL, Parser und acht vorhandene Lifecycle-Funktionen sind
gegen die Grundlage bytegleich. Es entsteht kein Berechtigungs-Cache.

Der [maschinenlesbare Nachweis](document-service-lifecycle-owner-snapshot-2026-10-27.json)
bindet den Stand an `b9b8d4cea03a5c008c102a5124b190f3f4ee7269` und tatsächliche Quellen. Zehn neue
PostgreSQL-Owner-Fälle prüfen echte und fremde Verbindungen, fingierte öffentliche
Leases, ersetzte Verifier, tatsächliche search_path-Änderung, exklusiven
Sperrverlust, unzureichende Shared-Sperren sowie geschlossene und abgetrennte
Kontexte. 28 vorhandene Source-Owner-Familien, Upload, erste Projektion,
Web-/Mobile-Anlage, native PI-Anlage, Storage-Phasen, echte COMMIT-Verluste,
finale Origin-Prüfungen und sieben explizite Originalimport-Gruppen bestehen.
Alle eigenen Fixtures schließen vollständig.

| Agent, zehn reguläre Quellen | SQL vorher → aktuell | Ausleihen vorher → aktuell |
| --- | ---: | ---: |
| first-adapter-entry-and-create | 2829 → 2505 | 80 → 80 |
| warm-fresh-create-1 | 2724 → 2400 | 46 → 46 |
| warm-fresh-create-2 | 2724 → 2400 | 46 → 46 |
| same-original-idempotent-retry | 198 → 194 | 7 → 7 |

Das Create-Engine-Fenster sinkt von 2589 auf 2265 SQL-Aufrufe.
Seine 212 aktuellen Berechtigungsbeobachtungen benötigen weiterhin
636 SQL-Aufrufe. Verschachtelte Fenster werden nicht addiert;
ein kontrollierter Latenzgewinn wird nicht behauptet. Vollständige Originalinhalte,
native Identitäten, vorherige Zeilen/Metadaten/xmin/Dateien und die ursprüngliche
Wiederholung bleiben geprüft. Die aktuelle MCP-Messung ist gesondert aufgezeichnet.

Ein zusätzlich gestarteter Originalimport-Test schlug auch auf dem tatsächlichen
vorherigen Produktstand fehl: Die Anmeldung löscht die absichtlich abgelaufene
Sitzung bei ihrer Ablehnung. Der Test verlangt nun gesondert genau diese eine
Sitzungslöschung sowie unveränderte übrige Sitzungszeilen/xmin, sämtliche
Dokumentdaten/xmin und das Dateisystem. Die bisherige strikte Null-DML-Prüfung für
gesunde Receipt-Wiederholung und Status bleibt bytegleich. Auth-Produktcode wird
nicht geändert. Release-TypeScript, Test-TypeScript (5.105 Quellen, 33 Wurzeln)
und ESLint ohne Warnungen bestehen. Aktuelle große Matrix, Build/UI,
reguläres test:all und die übrigen Gesamtplan-/Rollout-Gates bleiben erforderlich.

## Anfangsnachweis und aktuelle Agenten-Scope-Daten gemeinsam lesen

Die private Agenten-Anlage liest nun den ersten vollständigen Identitäts-/Relations-
nachweis zusammen mit ihren bisherigen aktuellen Scope-Daten. Zwischen diesen
vorherigen beiden Abfragen lag weder Callback noch Mutation. Der abschließende
frische Origin-/Identitätsnachweis bleibt erhalten, einschließlich der Erkennung
tatsächlicher Änderungen nach dem Scope-Lesen. Es wird kein positiver Nachweis
übernommen oder über eine notwendige Grenze gespeichert.

Der [gebundene Bericht](document-service-agent-initial-snapshot-2026-10-27.json)
vergleicht den tatsächlichen Stand `d0068b4f98a9a6f92ab705620027284a2600981b` mit den neuen
Quellen. Der bisherige Identitäts-Snapshot wird mit festen Parameterpositionen
wiederverwendet; seine Standard-SQL-Bytes und der Scope-SQL-Block sind unverändert.
Neun vorhandene Entscheidungs-/Phasenfunktionen, einschließlich Konto-/Seat-/
Workspace-/Agent-Entscheidung, Parser, Locks und Laufzeitgrenzen, sind bytegleich.
Gewöhnliche Agenten-, Member- und Job-Pfade behalten ihre bisherigen Lesewege.

21 tatsächliche PostgreSQL-Fälle prüfen Haupt-, E-Mail- und eingeschränkte Agenten.
Eine aktuelle Managed-Prüfung benötigt tatsächlich zwei statt drei SQL-Anweisungen;
der eingeschränkte Agent behält seinen echten Resolver und benötigt acht. Jede
erneute Prüfung liest beide Nachweise neu. Kontosperre, Sitzungsarchivierung,
Suchpfad-Reihenfolge, fehlender Suchpfad, echte temporäre Relation und echte
Relationsentfernung werden vor einem erfolgreichen Ergebnis abgewiesen. Die
gebündelte Abfrage kann bei fehlenden Relationen/Spalten bereits bei der Planung
scheitern; diese Fälle liefern PRINCIPAL_SCHEMA_INVALID. Ein vollständig verstellter
Suchpfad kann deshalb als Schemafehler statt als unabhängiger Scopefehler erscheinen.
Ein fehlender Namensraum liefert PRINCIPAL_SCOPE_CHANGED. Es erfolgt kein Retry
einer abgebrochenen Transaktion. Alle beobachteten Authority-/Native-Zeilen und xmin
bleiben nach Erfolg beziehungsweise Rollback gleich.

Die unveränderten zwölf finalen Origin-, 60 Scope-, 49 normalen Agent-, 26
Original-Origin-, 66 Member-, zwei Storage-Phasen-, zwei COMMIT-Verlust- und zwölf
nativen PI-Gruppen bestehen ebenfalls. Alle eigenen Fixtures schließen vollständig.

| Agent, zehn reguläre Quellen | SQL vorher → aktuell | Ausleihen vorher → aktuell |
| --- | ---: | ---: |
| first-adapter-entry-and-create | 2505 → 2285 | 80 → 80 |
| warm-fresh-create-1 | 2400 → 2180 | 46 → 46 |
| warm-fresh-create-2 | 2400 → 2180 | 46 → 46 |
| same-original-idempotent-retry | 194 → 180 | 7 → 7 |

Das Create-Engine-Fenster benötigt jetzt 2053 SQL-Anweisungen bei
39 Ausleihen. Seine 212 aktuellen Berechtigungsbeobachtungen benötigen
424 statt 636 SQL-Anweisungen. Vollständige native/physische Originalinhalte,
authentifizierte ID-Leser, unveränderte vorherige Zeilen/Metadaten/xmin/Dateien und
die ursprüngliche Wiederholung bleiben nachgewiesen. Verschachtelte Werte werden
nicht addiert; ein kontrollierter Latenzgewinn wird nicht behauptet. Die groben
Abfragefamilien sind Diagnosehilfen: Ein gemeinsamer Berechtigungs-/Identitäts-
Snapshot wird wegen seiner Kataloganteile als catalogue gezählt.

Release-TypeScript, die Testtypprüfung mit 5.106 Quellen und 34 Wurzeln sowie ESLint
ohne Warnungen bestehen. Die verbleibenden Abfragen und Phasen müssen weiter
gebündelt werden; die endgültigen Create-Budgets sind nicht erreicht. Aktuelle große
Matrix, Build/UI, reguläres test:all, PR/CI/Reviews und die übrigen Gesamtplan-/
Recovery-/Release-Gates bleiben erforderlich.
