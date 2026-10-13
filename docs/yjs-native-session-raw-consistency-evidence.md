# Nativer Sessionreader: rohe Fehlermetadaten erhalten

## Nachgewiesene Lücke

Auf dem Readerstand `c83b6bc356fae0fe011649163d95f8df4a199923` prüfte die private Rohdatenvalidierung den Projektionsfehler nur bei vorhandenem Code. Tatsächliche PostgreSQL-Zeilen mit `projection_error_permanent=1`, `projection_error_code=NULL` und `degraded=0` erreichten dadurch den Consumer. Der bestehende Mapper erzeugte ohne Code kein Errorobjekt; der Snapshot zeigte weder Degradation noch Quarantäne. Verwaiste Phase-/Sequenz-/Generationwerte, Zukunftsclocks und ein permanentes Flag einer älteren Generation konnten ebenfalls passieren.

Eine neue [echte PG18-/Auth-Matrix](../scripts/native-session-raw-consistency-postgres-test.ts) prüft 15 Familien in Plain/XML/Blocks, mit tatsächlichen BIGINT-String-/Numberparsern und beiden Readereingängen: RO sowie tatsächlichem BetterAuth-Cookie/Bearer-Principal. Alle 270 Aufrufe verwenden eigene zufällige Schema-/Workspace-/DATA-Bereiche und unveränderte echte Start-DDL, Auth-, Seat- und Workspacepfade. Kein Authmock oder externer Issuer wird verwendet. Die gespeicherten Zeilen und nativen Bytes müssen nach jedem Read unverändert sein.

Root reproduzierte auf der unveränderten Produktquelle die 126 unerlaubten Consumerzugänge unabhängig; die abschließende Regressionassertion scheitert erwartungsgemäß. Der private vollständige Root-Baseline-Log besitzt SHA256 `1a7aaa74eee599c5bdbc4592cf272fa13f1887dfbd098a1d2d9ad5f41d9a57d9`. Dieser fehlgeschlagene Baselinelauf bleibt als Gegenbeweis erhalten.

## Enger Fix

Nur `validateRawState` im [Sessionreader](../app/lib/collaboration/native-session-state-reader.ts) ändert sich. Vor dem Mapper gelten dieselben konsistenten Fehlergrenzen wie im bereits vorhandenen privaten Bootstrap-Recoveryreader:

- Ohne Code: permanentes Flag 0 und NULL für Phase, Sequenz und Generation sind Pflicht.
- Mit Code: gültiger begrenzter Code/Phase und sichere Sequenz-/Generationzahlen, keine Werte jenseits des aktuellen Dokumentstands.
- Permanentes Flag: gültiger Code und aktuelle Fehlergeneration sind Pflicht. Danach entscheidet die unveränderte tatsächliche Quarantäneprüfung.

Gespeicherte Daten werden weder repariert noch gelöscht. Unklassifiziertes historisches `degraded=1` ohne Code und gültige aktuelle permanente Fehler bleiben exakt `NATIVE_SESSION_QUARANTINED`. Fehlerhafte Tuples ergeben exakt `NATIVE_SESSION_STATE_INVALID`, bevor eine Capability an den Consumer gelangt. Gültige historische nichtpermanente Fehler, vorübergehende Projektionsfehler und der bekannte wiederholbare Binary-Persistenzfehler bleiben erlaubt. Allgemeiner Mapper, Failureklassifizierung, Persistence, Authhubs, öffentliche Reader-APIs und Sessionrouten bleiben unverändert.

## Unabhängige Integrationsprüfung

Root übernahm exakt den geschlossenen Autorenstand `aec96ce228661e9cfa590aef898869fe3b4495fd`. Der gesamte Reader außerhalb des einzigen privaten Validators ist bytegleich. Source-SHA256: `3608dd7271979936a1376f6813a56653d96e12892a2ba34213e21f37b7b9a080`; neue Fixture: `15e991a8af47cc7a1d1f5b87162ef7a424422a092637ae130e1536ffb4c693fb`. Die Fixturepräzisierung gegenüber dem Baselinebeweis verschärft ausschließlich die erwarteten INVALID-/QUARANTINED-Codes und benennt Familienabschluss klar; Fallzahl und Eingänge bleiben erhalten.

Root bestätigt nach Integration: neue 270 Aufrufe/15 Familien mit null unerlaubten Zugängen, unveränderte ursprüngliche RO20-/Auth24-/Principal37-/Bootstrap29-PG-Matrizen, vollständiges TypeScript mit 8 GiB und fokussiertes ESLint. Der private vollständige Root-Fixlog hat SHA256 `0d4a6ec663a4c045638cf59a0f40b0028e3a8f9cefc907775b9900cd000013f8`. Eigene Schema-/Clients-/DATA-Bereiche werden durch die tatsächlichen Finallypfade bereinigt. Bekannt bleibt nur die Node-localStorage-Warnung.

Wiederholung: `npm run test:collaboration:native-session-raw-consistency:postgres`. Der Befehl verwendet die bestehende private lokale PG-Konfiguration; keine Container- oder Hostinitialisierung.

Der präzise Pre-Edit-Impact meldet LOW, einen direkten/sechs insgesamt erfasste Caller und null indizierte Abläufe. Diese Korrektur aktiviert keinen neuen Produktpfad. V11 ist separat auf `6cee66086` eingefroren und enthält diesen späteren Fix nicht; seine Browserergebnisse sind davon getrennt.
