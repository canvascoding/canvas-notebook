# Eigener HTTP-Integrationstest und Child-Failure-Closure

Stand: 20. Oktober 2026. Dieser Beleg erweitert die historische 29er-MVP-Abnahme, ersetzt aber weder sie noch `npm run test:all`. Die Produkt-/Runnerquellen bleiben während der hier beschriebenen Läufe auf Root `4e798e3ec30824c86cfa6fcc95c62b9bf8d7a486` / QA `2bcf2ad918cef40ebc3eeb90aed8815d4fe60a01` gebunden; CP `27c8ce37da082244f006ca376068cde6b98845d5` bleibt unverändert.

## Frischer Build und echte HTTP-Folge

Der Originalproduktionsbuild endet mit **Exit 0 nach 234,009 Sekunden**. Der unabhängige Quellen-/Artefaktprüfer besteht. Originalbasis: `/private/tmp/canvas-owned-http-integration-acceptance-20261020`.

| Original | SHA-256 |
| --- | --- |
| `build-terminal.json` | `e7ddbe2953c7152e1a921b358f029436a5dc2fcd0f9caf5b92ae3415467bf013` |
| `source-report.json` | `3603623053fa4f59a2201b09c339f22a1236280500fc20f84bd13adc3a7e3c89` |
| `artifact-report.json` | `06b871deb4298276a5fd654a5e8305504ccca5eb01bc71447fa7a5ea35854701` |
| `http-positive/http-postruntime-report.json` | `5d34def7915b54f6f0661a6489d615bb86b8badd1a98eed7f9534aa61e9c3a29` |

Der feste Supervisor-Modus führt das tatsächliche `npm run test:integration` gegen die eigene App, DB, DATA, Anmeldung und Lizenzinstanz aus. Der Originalprozess `71681`, Fixture `f9844L`, beendet **1/1 Script mit Exit 0**; Queue, Baseline und Postcheck sind 0, alle **11/11 unabhängigen Prüfungen** bestehen. Tatsächlich geprüft sind gewöhnliche JSON-Dateiaktionen sowie exaktes Undo-OFF: Restore 409 mit `FILE_OPERATION_UNDO_DISABLED`, gelöschter Pfad weiterhin 404, Kopie intakt und Cleanup ohne fehlgeschlagene Einträge. Die Testscriptquelle ist SHA `7707a881379dc9820a7bd68277e5f86c8e00053ce2626b2097e40c6902d5201c`.

Der finale HTTP-Beleg hat `kind=http-script`, `completedScripts=1`, `status=passed`, `childClosed=true`, `cleanupConfirmed=true`. Beide eigenen DB-Namen/OIDs, DATA/TMP, ursprüngliche Prozesse/Gruppen/Ports und Lock sind unabhängig geschlossen; die vier verwalteten Dienste bleiben unverändert gesund. Die Browserfelder bleiben leer, `activeSpec=null`, `restartCount=0`, `browserAcceptancePassed=false` und `testAllPassed=false`. Der kurze HTTP-Child war nicht im passiven Live-Baselinefenster beobachtet; sein ursprünglicher Supervisorbeleg und die unabhängige finale PID-/Gruppenabwesenheit sind ausdrücklich getrennt.

## Drei injizierte Childfehler, keine App-Abnahme

Originalbasis: `/private/tmp/canvas-owned-http-failure-closure-candidate-20261020`. Die festen npm-Shims führen das Anwendungsscript nicht aus. Jeder Original-Runner bleibt **Exit 1 / failed / preserved / uncertain**; ein kooperativer Child-Exit 0 wird nicht zu Anwendungserfolg umgedeutet.

| Fall | tatsächliche Testphasenzeit | Original-Exit | strikter Failure-Postcheck | unabhängige Cleanup-Closure |
| --- | --- | --- | --- | --- |
| Exit23 | 1920 ms | 1 | 12/12, expectedFailure=true | geschlossen |
| SIGTERM | 583 ms | 1 | 12/12, expectedFailure=true | geschlossen |
| echte Deadline | 120013 ms | 1 | 12/12, expectedFailure=true | geschlossen |

Die Postcheck-SHAs sind Exit23 `af934efa4d23d4c45cc651314b537177bc9859b52ae4f719e6237483236cfc6d`, SIGTERM `ddbb05970d0aaf1db5bb150ed10261262c99d4a4e41faa3b42e8ba437100178d`, Deadline `81fdae4890bee2da67ca39987cc60e2c42ed789a40388efcd9842c95b1cb7882`. Die getrennten `independent-cleanup-postcheck.json` haben SHA `d1d8f55293a57b210f0ac29f95775b73a53096d432272c19cb56f2f5e770ed6c`, `762c4cf8ebeca1824930bca8e603f587ab20100fddc3326dd9f3b142a34ddfc5` und `9d02e2a374224e4a96f97fa3e81fd5f97ae7f6bc86b2e12e1a88aee325c4fd7c`; jeweils `cleanupClosed=true`, Originalfehlerbeleg erhalten.

Das private V1-Chronologieorakel war bei Abbruch falsch: `finishedAt` ist das Ende der Testphase, während erst der äußere `finally` den Child schließt. V2 bindet den Shutdown-Intent zwischen diesem Ende und dem tatsächlichen post-wait Terminal-Journal; die echte SIGTERM-Anforderung muss vor Testphasenende liegen. V1 und alle Originale bleiben erhalten. Nur private Checker/Binder und deren Quellenpins wurden korrigiert; keine Produktquelle, Deadline oder der zwölfteilige Closurevertrag wurde dafür verändert. Aus diesen Shims folgt ausdrücklich keine HTTP-App-, Browser- oder `test:all`-Abnahme.

## Noch offene Freigaben

Die echte Default-Playwright-Collection auf Root `4e798e3ec` endet mit Exit 0: **789 Fälle in 201 Dateien, keine Testausführung**. Originalbasis `/private/tmp/canvas-mvp-default-playwright-collection-20261020`; Terminal-SHA `75f27346404db67aff7af7061deb23822d2675b0a7944c19185247b54b4d78d8`, Summary-SHA `07576d6fa1635ba27fb9664e4e0dd246db163b8560edf5290dda2e2be68ff6f5`. Der zusätzliche Fokus-Browserlauf scheiterte am veralteten `chat-input`-Selector; der lokale reine Selectorfix ist noch nicht erneut im Browser bestanden.

`npm run test:all` bleibt das unveränderte Produktionsgate ohne Nutzer-Waiver. Nach Main-Integration und gemeinsamer Build-/Browserabnahme folgt dessen tatsächliche Ausführung in der eigenen isolierten Instanz mit bereitem Modell und die Behebung konkreter Fehler, kein vorausgesetzter neuer Universalrunner. PR #176 auf dem damals veröffentlichten `fd1b54dcae9a2eec05ab342a12b381a7e7a70344` hat sieben grüne CI-Checks, ist gegenüber Main `05e9da30fe4d8a29521223595bf58564d5daebb9` aber `DIRTY`; Policy-/Kohortenzuordnung der elf neuen MVP-Tabellen und Downloadtickets sind konkret zu integrieren. Main ist nicht integriert, Produktion nicht ausgeliefert. Die historische 29er-Abnahme bleibt an `98956a6bd` / `6537fbbe8` gebunden; alle sieben Roadmap-Pakete bleiben offen, zusätzliche SDK-/PDF-/Such-/Skillfeatures nach MVP, Review Center und Dateiaktions-Undo aus.
