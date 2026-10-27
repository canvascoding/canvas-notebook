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
