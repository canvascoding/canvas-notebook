# Nativer Textsocket: tatsächliche Anmeldung und Peerphasen

Status: **Sourceanschluss abgeschlossen; gemeinsamer Produktschalter weiterhin `false`.** Autorcommit `7f98daea015a5bf9576ce7b3b952417ad47178a0`; Root integriert exakt seine sechs Dateien auf der separat geprüften aktiven PostgreSQL-Leasekorrektur `820762b11`.

## Vertrag

Der Websocket erfasst die tatsächlichen Upgradeheader vor Await. Mobile erhält den privaten ursprünglichen HTTP-Transport aus einem tatsächlich publizierten Einmalticket. Weder gespeicherte Claims noch Actor-IDs werden zu einer synthetischen Anmeldung. HTTP und Socket verwenden denselben typisierten nativen Textsession-Schalter.

Gesunde Read-only-Joins verwenden den festen echten `canRead`-Reader. Quarantänediagnose besitzt eine eigene private `canRead`-Capability. Ein unverbindlicher Modeselector vermeidet zwei konkurrierende Authfactories innerhalb derselben B-Phase; anschließend gibt es genau einen gewählten, vollständig authentifizierten Reader. Ein Modewechsel wird abgewiesen, ohne Readerfallback oder Schreibgrant.

Jede Peerprüfung öffnet eine frische echte Authphase und prüft ursprüngliche Session-/Realm-/Ownerbindung. Die Schreibphase einschließlich Finalprüfung, bestätigtem COMMIT und Close muss **vor** Hocuspocus-Apply abgeschlossen sein. Die tatsächliche Roommutationqueue und Activityfence bleiben bis zum Abschluss des Messagehooks gehalten. Bereits akzeptierte Änderungen dürfen nach späterer Credentialdisposal weiterhin ownergefenced gespeichert werden.

Private Busy-Zustände werden pro konkretem Hook höchstens dreimal mit frischen Phasen geprüft. Erschöpfung schließt den tatsächlichen Socket mit `1013`; sie erzeugt keine falsche Rechteentziehung. Verbindungsabbruch und Shutdown warten auf Watcher-/Phase-Cleanup, bevor die opaque Anmeldung entsorgt wird. Der gemeinsame verschachtelte Peer-Lifetimestate überlebt Hocuspocus-Kontextkopien.

## Konkrete Gegenproben

Ein früherer genuine COMMIT-Lostresponse-Gegenlauf zeigte trotz fehlgeschlagener Autorisierung Änderungen in Room, Remotepeer und Store. Die korrigierte Reihenfolge schließt Autorisierung vor Apply. Der finale Gegenlauf weist bei tokenbezogenem Finalverlust, COMMIT-/Closefehler, finalem Ownerwechsel, tatsächlichem Disconnect und echtem PostgreSQL-Timeout jeweils `roomChanged=false`, `remoteChanged=false`, `storedChanged=false` nach.

Enrollment ordnet den tatsächlich geminteten privaten Transport innerhalb der Phase zu. Dadurch werden auch nach COMMIT-/Closefehler oder spätem Abort genau diese Credentials entsorgt. Der separate Modeselector beseitigt den im Authorlauf beobachteten Authfactory-Deadlock; Locks und echte Finalprüfungen werden nicht gelockert. Der daraus beobachtete aktive Poolclient-Prozessabbruch hat seine eigene [Corekorrektur und Beweisgrenze](./yjs-postgres-active-lease-evidence.md).

## Abnahme und offene Grenzen

Root bestätigt unabhängig **23/23** tatsächliche Netzwerk-/PostgreSQL-18-/Auth-/Owner-/Apply-/Store-Gruppen aus [authenticated-native-websocket-postgres-test](../scripts/authenticated-native-websocket-postgres-test.ts). Dazu gehören echte Cookie-Joins, Tokenrotation, beide Read-only-Modi und deren Races, tatsächliche private Mobiletickets, kein Webfallback bei Mobileprotokoll, queued Revoke und einmal gesendete lokale Änderungen nach vorübergehendem Busy. Nach `1013` nimmt ein frischer tatsächlicher HTTP-Sessionpublisher ein neues Einmalticket auf; der echte Yjs-Protokollclient resynchronisiert denselben lokalen Zustand. Das ist kein Beleg für automatische Reconnect-UI oder ein mobiles Gerät.

Die Matrix lädt echte Produktmodule und den tatsächlichen Server mit eng begrenzter Beobachtung/Faultinstrumentierung; Authfactory, SQL-Daten, Owner, Roomapply und Store sind echt. Gezielte COMMIT-/Close-/Finalfaults bleiben kontrollierte Faultinjektion. Der Timeoutfall besitzt zusätzlich einen eigenen Fixture-Clientlistener; er ist für sich kein allgemeiner Poolcore-Beleg. Root nutzt zugleich die unveränderte tatsächliche Corekorrektur, deren unabhängige Matrix diese eigene Grenze schließt.

Beide bestehenden Startup-/Mutation-Serverregressionen, vollständiges TypeScript mit 8 GiB und `--incremental false`, scoped Lint6, Diffprüfung und sechs exakte Autorendateien bestehen. Die beiden Legacy-Testadapter ergänzen ausschließlich erforderliche Imports und eng erlaubte Admission-SQL-Stubs. Ein unabhängiger zweiter Reviewer bestätigt bytegleiche vollständige Fallkörper und erhaltene Assertions. Die tatsächliche Matrix schließt eigene Socket-/Server-/PG-/DATA-Ressourcen; sie startet keinen Container oder fremden Runtime.

Der Sourceanschluss aktiviert weder den neuen Vollimportkoordinator noch allgemeine Writer/Dateioperationen. Die kombinierte HTTP-/Ticket-/Socket-/Browserabnahme verlangt einen frischen isolierten Build mit gezieltem Testscope. Weitere Create-/Clipboard-/Importfälle, Native-Mobile-Geräteabnahme und der ursprüngliche Produktions-`PREVIEW_BLOCKED` bleiben offen.
