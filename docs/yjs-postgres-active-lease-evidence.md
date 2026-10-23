# PostgreSQL: aktive Connection-Lease und terminale Fehler

Status: **Enges Core-Paket abgeschlossen; native Produktaktivierung und gemeinsame Browserabnahme bleiben offen.** Autorstand `a83194b79b89ae5207e6eca1498b93b7e9cb16b1`, unabhängig im Integrationsworktree übernommen.

## Befund und Scope

Ein tatsächlicher PostgreSQL-18-`transaction_timeout` zwischen zwei Abfragen konnte am ausgeliehenen Poolclient ein unbehandeltes `error`-Event auslösen und den Nodeprozess beenden. Der bestehende Poolhandler schützt idle Clients; er deckte diese aktive Lease nicht ab. Der Autor reproduziert den alten Prozessabbruch mit tatsächlichem `FATAL 25P04` in einem eigenen Kindprozess, Schema und DATA-Verzeichnis.

Die frische Impactanalyse vor Integration bewertet `openPostgresDb` als **CRITICAL**: direkter Caller `openDb`, 809 erreichbare Symbole, 24 Prozesse und 20 Module. Die spätere enge Diffanalyse ersetzt diese Reichweitenwarnung nicht. Der Produktdiff bleibt ausschließlich in `openPostgresDb`; Poolerzeugung, Fehlerklassifikation, Diagnostik und der vollständige Lifecycle-Transaction-Core bleiben bytegleich.

## Verhalten

- Der aktive Clienthandler wird synchron im echten `pg`-Acquirecallback angebunden. Ein terminaler Clientfehler wird gespeichert, ohne aus dem Eventhandler zu werfen.
- Abfragen prüfen die Lease vor und nach tatsächlicher Ausführung. Gewöhnliche SQL-Fehler vergiften eine gesunde Verbindung nicht; Rollback und Wiederverwendung bleiben möglich.
- Eine Lease wird genau einmal freigegeben. Normaler Close einer beschädigten Verbindung schlägt fehl, einschließlich eines Fehlers während der tatsächlichen Releasegrenze; ein bestätigter Abschluss darf daraus nicht entstehen.
- Ein ausdrücklich verlangter erfolgreicher Discard darf die bestehende frische Recovery-Verbindung C ermöglichen. Ein tatsächlicher Releasefehler bleibt ein Fehler; Mutation und COMMIT werden nicht wiederholt.

## Nachweise und Grenzen

Root führt auf dem unveränderten finalen Freeze unabhängig alle **15/15** Gruppen aus [postgres-active-connection-postgres-test](../scripts/postgres-active-connection-postgres-test.ts) aus. PostgreSQL 18 und der verwaltete lokale Server werden geprüft; jede Gruppe nutzt ausschließlich eigene UUID-Schemas, Backendfences und DATA. Die Matrix enthält echte Wire-Timeouts und gezielte Backendbeendigung sowie separat kontrollierte Events am tatsächlichen Poolclient für Acquire-, Postquery-, Release- und COMMIT-Grenzen. Diese kontrollierten Gegenproben sind keine zusätzlichen spontanen Wirefehler.

Gesunde Wiederverwendung, SQL-`22012`/Rollback, in-flight Close, einmaliger Discard, tatsächlicher dauerhafter COMMIT-Marker mit verlorener Antwort und frischer Recovery ohne Replay bestehen. Der Rootlauf beendet alle Kindprozesse regulär und entfernt seine eigenen Schemas/DATA. Bestehende Poolregressionen, alle acht Lifecycle-Transaction-Fälle und runtime-only bestehen unabhängig ebenfalls. Der Autor bestätigt zusätzlich die echte Startup-/Idle-Wire-Disconnect-/Reconnect-Integration; dieser Zusatzlauf wurde von Root nicht erneut ausgeführt.

Root bestätigt integriertes vollständiges TypeScript mit 8 GiB und `--incremental false`, scoped ESLint und exakte Autorenbytes. Eine vorherige inkrementelle Typdiagnose meldete einen Header-Tuplefehler; auf dem unveränderten frischen Gesamtlauf ist er nicht reproduzierbar. Seine genaue Cache-/Kontextursache bleibt ungeklärt, eine Produktkorrektur erfolgt dafür nicht. Der unveränderte Produktfreeze lautet `5ff179f6ebe2aeebcba64ff57ef0c615eb1982e7cba3baf7b60fc59e9361d87b`, der Testfreeze `2d22b23ddbba10d7f53bf2d98ddcdfa2e820aa0bb9b574b9b604d248ed59c0e8`. Die unabhängige Matrix auf genau diesen Bytes wird nach ihrer bytegleichen Übernahme nicht identisch wiederholt.

Dieses Paket ist keine Behebung des ursprünglichen Produktions-`PREVIEW_BLOCKED`, keine allgemeine native Writer-/Importaktivierung und kein Browser-/Native-Mobile-Gerätenachweis. Der gemeinsame HTTP-/Socket-/UI-Test folgt auf einem frischen integrierten Build.
