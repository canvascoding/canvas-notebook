# Unveränderliche Move-Vorbereitung vor dem Editor-Drain

Stand: 19. Oktober 2026. Ausgangspunkt ist Root `cd65e0ac15fc418364cfcc4ced1df36f29445fcb`. Dieser Schritt implementiert und prüft den P0-Datenbaustein. Der vollständige Claim-/Admission-/Drain-/Owneranschluss und eine neue App-/Browserabnahme bleiben offen.

## Verhalten und Grenzen

Die additive Tabelle `workspace_file_operation_move_preparations` bindet genau einen unveränderlichen Vorbereitungstext an den ursprünglichen Batch. Der vorhandene Immutable-Trigger schützt auch diese Tabelle. Die bisherigen Tabellen und deren Originale bleiben erhalten.

Der neue Codec bindet Original-Aktor und Sitzung, Requesthash, Plan, Workspace-Scope, den tatsächlich erfassten CurrentWitness und den endgültigen Admission-Request einschließlich Digest. Native Bundlebytes liegen weiterhin einmal in der bestehenden unveränderlichen Intenttabelle; die Vorbereitung speichert nur deren feste Referenz. Auch `null` durchläuft den bestehenden strikten Move-Decoder: Ein erforderliches natives Bundle darf nicht fehlen, der echte physische Plan ohne native Effekte behält seinen Nullarm.

Lesen und Einfügen verwenden bounded SQL, prüfen kanonische Bytes und Hashes erneut und eröffnen oder beenden keine eigene Transaktion. Die SQL-Verbindung, aktuelle Rechte, Claim und atomare gemeinsame Speicherung mit Bundle und Reservation bleiben Aufgabe des festen Owners. Die Daten verleihen keine Ausführungsautorität.

Beim Wiederlesen wird der native Payload über den unveränderten bestehenden Bundledecoder aus den gespeicherten Originalbytes rekonstruiert. Der kanonisch sortierte Admission-Payload kann dessen ursprüngliche JSON-Byteordnung nicht ersetzen. Ein neuer reiner Wrapper macht diese bestehende Decodierung zugänglich; er gewährt weder Staging noch Ausführung.

Die bisherige Bundle-Erzeugung ist in einen gemeinsamen reinen Movehelper ausgelagert. Der bestehende Owner-Wrapper erhält seinen bisherigen Fehlervertrag. Der Algorithmus und die tatsächlichen Domain-/Recoverypfade bleiben erhalten.

## Tatsächliche Prüfungen

Private Originale und Controller: `/private/tmp/canvas-native-path-admission-8gusy9ys/`.

- Die vorhandenen elf Move-V2-Verträge bleiben unverändert. Acht additive Fälle prüfen Plain/XML/Blocks, legitimen Checkpointdrift, den erforderlichen Nullarm, Original-/Witness-/Requestsubstitution, Budgets und feindliche Daten sowie ausdrücklich deklarierte Borrowed-SQL-Spies. Diese Spies beweisen keine PostgreSQL-, Rechte-, Claim- oder COMMIT-Semantik.
- Der kontrollierte Lauf mit dem eingefrorenen privaten P0-v1-Code scheitert tatsächlich mit Exit 1: Der erforderliche Nullarm wird akzeptiert; zusätzlich scheitert das Wiederlesen. Nach der ersten Nullkorrektur bleiben 18/19 bestanden und der Wiederlesefehler erhalten. Beide Vorläufe werden nicht als bestanden umgedeutet.
- Nach der Payloadkorrektur bestehen alle 19 Fälle. Die erste Typprüfung findet zusätzlich einen nicht eingegrenzten optionalen Descriptor; dessen Prüfung ist im finalen Stand korrigiert. Der abschließende Controller `preparation-v4-terminal.json` bestätigt erneut 19/19 und tatsächlichen Exit 0 nach 36,218 Sekunden, gezieltes TypeScript mit Exit 0 nach 18,112 Sekunden sowie ESLint ohne Warnungen mit Exit 0 nach 2,098 Sekunden. Alle gepinnten Quellen bleiben während dieser Läufe bytegleich.
- Der aktualisierte ursprüngliche Speicherlauf besteht mit tatsächlichem Exit 0 und 15 PostgreSQL-18-Gruppen. Er prüft nun sechs Tabellen und fünf echte Fremdschlüssel sowie den tatsächlichen UPDATE-/DELETE-Trigger auf einer vorhandenen, ausdrücklich mechanischen Preparation-Zeile. Eigene Schemas und Verbindungen werden geschlossen. Der v3-Controller endet anschließend wegen eines Fehlers in seiner Ergebnisauswertung mit Exit 1; der ursprüngliche PG-Childexit 0 bleibt getrennt erhalten. Der korrigierte v4-Controller verwendet eindeutige Exit-/Signalprüfungen.
- Der unveränderte tatsächliche Move-Owner-/Runnerlauf besteht anschließend mit 13/13 PostgreSQL-Gruppen und Exit 0 nach 42,868 Sekunden, einschließlich nativer Linkpflege, gefülltem Ordner, verlorener Backendverbindung, gleichem Original-Recover und historischem Abschluss. Sein positiver Endmarker folgt erst auf vollständig bestätigte Fixturebereinigung. Das prüft den ausgelagerten Bundlehelper im echten bisherigen Ausführungspfad; es ist kein neuer Live-Editor-Drainnachweis.
- Zwei unabhängige rein lesende Reviews prüfen den Datenvertrag und die abschließenden Korrekturen. Ein gesonderter read-only PG-Postcheck bestätigt die Abwesenheit des ursprünglichen Owner-Schemas nach Namen und OID bei weiterhin nicht zugewiesener XID. Die beobachteten Testprozesse sind beendet; die vier verwalteten Canvas-Dienste behalten ihre ursprünglichen Containeridentitäten und sind gesund.

Der erste Controller-Setupversuch mit einem falschen privaten Kandidatenpfad führte noch keinen Test aus. Auch dieser Fehler bleibt im ursprünglichen Toolprotokoll erhalten.

## Weiterer Anschluss

Der feste aktuelle Claim muss den P0-Datenbaustein, natives Bundle und exakt dieselbe Reservation auf derselben autorisierten Verbindung atomar speichern. Vor Sourcecensus und Vorbereitung sind Kernel- und PG-Admissionfence zu halten. Danach muss der tatsächliche Room-Drain außerhalb aller gehaltenen Workspace-/Roomlocks voranschreiten; B1/B2 müssen aktuelle Rechte, unveränderte Originale und echte Quiescence erneut prüfen. Konkurrierende gewöhnliche Projektion braucht auch für die Zeit nach dem P0-COMMIT einen Reservationfence.

Delete benötigt weiterhin den atomaren Domain-/Admissionabschluss für Links, Archiv, Trash und Original-Completion. Auch ein echter Abort ohne Dateistrukturänderung muss offene Editoren invalidieren. Der letzte vollständige Browserstand bleibt bei 8/9. Der ursprüngliche Produktionsfehler ist weiterhin nicht als behoben nachgewiesen; allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus.
