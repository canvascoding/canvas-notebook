# Native Session: callbackgebundene Requestrechte

Stand: 2026-10-14. Basis `3bb49751a9606da2a26827ca71b07ccacabf049c`, abgeschlossener Source-/Fixturecommit `979cd2c17c721983159a49eee97785e08fec5647`. Das Paket bleibt inaktiv; keine Session-, Route-, WS-, Grant- oder automatische Read/Write-Auswahl wurde angeschlossen.

Der [authentisierte native Reader](../app/lib/collaboration/native-session-state-reader.ts) übergibt dem Consumer zusätzlich `ExistingNativeSessionRequestAccess`. Dessen Workspace, User-ID und Session-ID stammen ausschließlich aus dem echten `WorkspaceRequestPrincipalAccess` derselben B-Transaktion. Es gibt keinen Eingang für einen callerdefinierten Access oder ein Schreibflag. Die private Fassade bindet alle Getter und ihre gespeicherte Prüffunktion an die tatsächliche native Capability. `assertCurrent()` verwendet den vorhandenen nativen Current-Check und prüft damit Principal, Backend/XID, Schema, Native Identity und Admission auf derselben Connection. Die Fassade öffnet oder beendet keine Transaktion und besitzt keine Connection.

Nach Ende des nativen Callbacks verweigern alle Fassade-Getter und eine zuvor gespeicherte Prüffunktion die Nutzung, auch während der anschließenden Principal-Finalprüfung. Abgefangene Fehler bleiben fatal; ausstehende Prüfungen werden vor der Fehlerausgabe vollständig abgewartet. Bereits entnommene eingefrorene Workspacewerte bleiben historische Daten; sie sind keine weiter gültige Capability. Die Fassade ist ausschließlich serverintern und kein öffentlicher DTO. Keine Credentials werden übergeben.

## Belegte Read/Write-Grenze

`access.workspace` ist das eingefrorene Rechtebild beim Eintritt in die tatsächliche B-Principalphase. Der [Principal-Service](../app/lib/workspaces/request-principal.ts) prüft bei `assertCurrent` und beim Abschluss erneut die ursprünglich geforderte Berechtigung. Er ersetzt das eingefrorene Workspacebild dabei nicht durch das neu gelesene Ergebnis. Der opake Principaltyp und die Fassade zeigen nicht an, ob die Factory `canRead` oder `canWrite` gefordert hat.

Die neue reale PG-Fixture bestätigt deshalb bewusst den Gegenfall: Ein echter `canRead`-Principal tritt mit `canWrite=true` ein; dieselbe B-Transaktion entzieht ausschließlich das Schreibrecht und erhält das Leserecht. `access.assertCurrent()` und der Abschluss sind weiterhin als Lesediagnose zulässig, während der eingefrorene Entrywert `canWrite=true` bleibt. Daraus darf niemals ein Schreibgrant oder eine Dokumentmutation abgeleitet werden.

Eine getrennt tatsächlich mit `canWrite` erfasste Principalphase weist den Schreibrechtsentzug vor dem Consumer, bei expliziter Prüfung, nach Callbackrückkehr und in beiden anschließenden Finalprüfungsfenstern zurück. Künftige schreibende Caller müssen diese echte Factoryprovenienz privat erhalten und die vollständige zuständige Mutationsphase umschließen. Ein `canWrite`-Principal allein besitzt weiterhin keine Native-Mutations-, Lifecycle-, Room-, Grant- oder COMMIT-Autorität. Automatische Read/Write-Wahl, Migration und Sessionaktivierung sind separate Anschlussgates.

## Wiederholbare Evidenz

Root integriert das abgeschlossene Agentpaket nach `380567154` und bestätigt Reader und neue Fixture bytegleich zum geprüften Sourcecommit. Alle 18 übrigen Readerfunktionen, die vier alten PG-Matrizen und der Principal-Service bleiben vollständig bytegleich. Root führt die neue echte PG16-Matrix sowie die ursprünglichen RO20/Auth24/Principal37/Raw270-Matrizen erneut erfolgreich aus; RawConsistency meldet 15 Familien und null unerwartete Admissions. Vollständiges TypeScript mit 8 GiB, scoped ESLint und lokale Dokumentlinks bestehen. Der Browserlauf V12 bleibt separat auf `f1813c898` eingefroren und enthält diese spätere Reader-Erweiterung nicht.

```sh
npm run test:collaboration:native-session-callback-access:postgres
```

Die [neue eigene Fixture](../scripts/native-session-callback-access-postgres-test.ts) verwendet echte BetterAuth-Cookie-/Bearer-Anmeldung, eine tatsächlich verifizierte signierte Team-Lizenz, den verwalteten PG18-Dienst, ein eigenes Zufallsschema und eine Workspace-ID mit UUID. Kein Authmock, Host, Container, Browser oder externer Issuer wird gestartet. Credentials werden nicht ausgegeben; nur eigenes Schema und temporäre Daten werden entfernt.

Bestanden: **16 Fallgruppen** für genuine B-Rechte gegenüber früheren Requestrechten, lesende und schreibend autorisierte Phasen, Write-Loss einschließlich Finalprüfungen, echte Peer-ACL-/Session-/User-Lockkonflikte, sämtliche Getter und gespeicherte Prüfungen nach Ablauf, abgelaufene Fassade im Nachfolger, Fehler in beiden Completionfenstern, abgefangene/detached/reentrante Fehler, tatsächliche Backend-/XID-/Searchpath-Wechsel und Sessionablauf mit Rollback. Der native State bleibt unverändert; es wird kein Schreibgrant erzeugt.

Unverändert bestanden: [RO-Reader 20](../scripts/native-session-state-reader-postgres-test.ts), [AuthReader 24](../scripts/authenticated-native-session-reader-postgres-test.ts), [Principal 37](../scripts/workspace-request-principal-postgres-test.ts), [RawConsistency 270 Aufrufe in 15 Familien, null unerwartete Admissions](../scripts/native-session-raw-consistency-postgres-test.ts) und [Compiler acht Fälle](../scripts/markdown-file-import-test.ts). Alle vier alten Matrizen und der Principal-Service sind bytegleich zur Basis; 18 bestehende Readerfunktionen bleiben bytegleich. Vollständiges TypeScript mit 8-GiB-Heap, scoped ESLint und `diff --check` bestanden. Der reine RO-Test benötigt weiterhin seinen expliziten privaten `CANVAS_NATIVE_SESSION_READER_TEST_ENV_FILE`-Pfad.

Vor Sourceänderung: frischer symbolgenauer Readerexport-Impact LOW, null direkte/gesamte Aufrufer und null Prozesse. Vor der einzigen Testtypenkorrektur: Fixture-`main` LOW, ein direkter/gesamter Aufrufer und null Prozesse. Finaler vollständiger Index: 93,0 Sekunden; staged `detect_changes`: zwei Dateien, 46 Symbole, null betroffene Prozesse, LOW. Der positional mitgelistete Readerkern ist per Bytevergleich unverändert. Diese lokale Evidenz bestätigt keine Session-/HTTP-/WS-/UI-Aktivierung oder Produktion.

SHA-256: Reader `233b950417cfb069154fdef661c161cdb63619d164d0a4436cca9e14854cc3fc`; neue Fixture `85eacc79e53c9feb5b9dda0b7be2e203111c34ec35ef4c1a746d44808712bfa8`.
