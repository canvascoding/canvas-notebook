# Native Copy: zentrale Aktualisierung der Dateiansichten

Stand: 17. Oktober 2026. Backendanschluss im Worktree abgenommen; die gemeinsame frische Build-/Browserabnahme folgt. Allgemeines Aktivierungsgate bleibt aus. Dateiaktions-Undo und Review Center bleiben ausgeschaltet; kein Produktionsrollout.

Aktueller Nachtrag: Der erste gemeinsame frische Build besteht. Die [anschließende Browserfolge](./yjs-native-copy-browser-acceptance-evidence.md) endet mit tatsächlichem Exit 1, 2/6 bestanden und vier Fehlern; CopyOrigin2 und UndoOFF2 starten nicht. Zwei anhand der Originaltraces belegte Testannahmen sind eng korrigiert, noch nicht erneut im Browser geprüft. Eine mögliche vorzeitige physische Projektion während Pending-Copy bleibt gesondert zu untersuchen; dieser Backendnachweis garantiert keine Copy-weite Unterdrückung aller physischen Watcherereignisse.

## Verhalten und Anschluss

Der bestehende `executeWorkspaceFileOperationService` finalisiert native Copy-Ansichten zentral. Dadurch benutzen Copy-POST, Recovery-POST und die vorhandenen direkten PI-/Agentenaufrufe denselben Anschluss. Der vorhandene `invalidateWorkspaceFileViews` und die gesamte `route-helpers.ts` bleiben bytegleich.

- Die Completionphase unterscheidet neue Veröffentlichung und bereits abgeschlossene History. Das Phasenergebnis alleine ist kein COMMIT-Beleg.
- Der feste Owner erfasst neue Veröffentlichungsdaten synchron unmittelbar nach tatsächlich bestätigtem B2-COMMIT, vor nachfolgender Verifikation oder Sessiondisposal. Ein unbekannter COMMIT-ACK erzeugt keine neue Dateimeldung.
- Nur exakte zurückgegebene Result-/Errorobjekte erhalten die privaten, eingefrorenen Benachrichtigungsdaten. Wertgleiche Klone erhalten sie nicht. Diese WeakMap erteilt keine Lese-, Schreib- oder Recoveryautorität.
- Die Daten bleiben auch bei späteren Journal-/Cleanup-/Verifikationsfehlern erhalten. Der Service finalisiert Erfolg und geworfene Fehler.
- Neue Datei-, Ordner- und tatsächlich angelegte Parentpfade stammen aus ursprünglichen C1-Mappings beziehungsweise echten Pfadreceipts. Nur das Zielworkspace wird invalidiert und benachrichtigt.
- Native History invalidiert Zielbaum und Referenzcache ohne erneut `add`/`addDir` zu melden. `alreadyKnown` ist kein Nachweis historischer Veröffentlichung: Eine bereits bekannte Pending-Recovery kann erstmals veröffentlichen.
- Ein interner Servicemarker verhindert die zweite native Invalidierung in Copy-POST. Öffentlicher Execution-/HTTP-DTO, Legacy-Overwrite und der bisherige Legacy-Servicezweig bleiben unverändert. Auch dessen bisherige History-`copied`-Semantik bleibt eine ausdrückliche Altgrenze.

Es entsteht kein neuer Eventbus und keine dauerhafte Outbox. Genau-einmal-Zustellung über einen Prozessabsturz hinweg sowie Aktualisierung bereits geöffneter Browseransichten sind durch diese Backendabnahme nicht allgemein bewiesen. Der aktuelle direkte MCP-Katalog besitzt keinen eigenen Copy-Adapter; daraus wird keine neue MCP-Copy-Transportabnahme abgeleitet.

## Tatsächliche Prüfungen

| Prüfung | Ergebnis | Originalbericht |
| --- | --- | --- |
| Unveränderte ursprüngliche Copy-PG18-/FS-Folge | 25/25, tatsächlicher Child-/Runner-Exit 0 | `/private/tmp/cnco-copy-views-original25-kkspyo9e/results.json`, SHA-256 `69fa3858c34cdc451f8318353a9148b31ed340f80a4aaeb90ad544bca5ae4c82` |
| Neue echte PG18-/FS-Viewfolge | 6/6, tatsächlicher Child-/Runner-Exit 0 | `/private/tmp/cn-copy-views-pg-3j_bg9so/results.json`, SHA-256 `5ff38a61b0613177221ca5df4075039d755fe310bc23048f49e2447440b8af1f` |
| Breitere Node-Regression | 169/169, keine Skips/Fehler/Abbrüche/Todos; enthält HTTP-Scriptwrapper | `/private/tmp/cn-copy-views-checks-8jiyd8vv/pure.log`, SHA-256 `8bdfcac350b4c59cc8fc5a3ef891b47d7e4f723c52c1b2c8d1056601d1f19c7f` |
| Finalizer nach reiner Testtypkorrektur | 4/4, tatsächlicher Exit 0 | `/private/tmp/cn-copy-view-finalizer-type-6mhvdoqt/results.json`, SHA-256 `830f0b13b494c230c74489aeee81009b269ced2b4282e441239bdb372bb4c1e6` |
| Abschließendes Scoped-Lint und vollständiges cachefreies TypeScript | beide Exit 0, 5.068 Quellenpins unverändert | `/private/tmp/cn-copy-views-final-types-fjgdczrj/results.json`, SHA-256 `91b88fde99327a99c2ebf00c058c30969ada2f8404c7ab3302a340ed5b26406c` |

Die sechs neuen PG-Gruppen prüfen tatsächlichen authentisierten Upload und Copy durch Service/Owner, Zielcache-Isolation bei Cross-Workspace-Copy, unveränderte historische Receipts, echten B2-Rollback und Pending-Recovery, echten COMMIT mit verlorenem ACK, bestätigten ACK mit anschließendem echtem Owner-Queryfehler sowie native Ordner/Child/Parentpfade und exakte private Objektreferenzen. Ledger- und Completion-`xmin` müssen zusammenpassen; ursprüngliche native Quelldaten bleiben unverändert. Nur die Eventzustellung wird an der ausdrücklich benannten Watchergrenze beobachtet; die echte Browser-/WebSocketzustellung ist kein Bestandteil dieses PG-Nachweises. Die Pure-/HTTPprüfungen benutzen benannte Boundary-Stubs und ersetzen keine Transaktionsbelege.

Der ursprüngliche 25er-Test bleibt bytegleich (`970df9f19701d9cff841adef3b757f529803a7316939bd21cdd4d7b2edf57fdb`), ebenso Metadata-Fixture, bestehende Metadaten-/Delete-PG-Suiten und ihre Zeitgrenzen. Die neue PG6-Quelle hat SHA-256 `a087ba0b578ca6ad7e2b1df478c6483e0f818c530580723626e7c2ec92f32867`.

## Unabhängiger Abschluss und erhaltene Gegenbefunde

Beide PG-Läufe sind vor weiterer Arbeit separat durch einen frischen Read-only-PG-Prozess geschlossen. Original25: `/private/tmp/cnco-copy-views-original25-closure-xn1u7mfb/closure-cnco-copy-views-original25-kkspyo9e.json`, SHA-256 `6f50149920c99368079071065c979bf734db72c612b277145246a7240e88000b`. Die 52 direkten und zehn zusätzlichen Pins bleiben gleich. PG6: `/private/tmp/cn-copy-views-audit-1k9q1ous/closure-cn-copy-views-pg-3j_bg9so.json`, SHA-256 `0058e64af08f4fa0b5e7f9fdf9655976596c426a5ce7c562bc4439026d5d46cf`. Alle 5.071 expliziten Quellen-/Artefaktpins bleiben gleich; 25 beobachtete Backendidentitäten, eigenes Schema/OID, Prozesse, beide Gruppen, Launcher, DATA und Runlock fehlen. Das sind explizite Pinmengen, keine behauptete vollständige transitive Abdeckung. Jeweils vier unveränderte verwaltete Dienste bleiben gesund, drei HTTP-Checks liefern 200. Keine weitere Testumgebung oder Containerbilder wurden gebaut.

Vor dem ersten PG6-Start fand die unabhängige Quellenprüfung drei falsch adressierte Testproben: Der echte Bulk-INSERT bindet Pfade als Array in `values[1]`. Ausschließlich diese drei Membershiptests wurden korrigiert; SQL-/Workspacebindung und Assertions blieben erhalten. Die ungestarteten früheren Versiegelungen bleiben im privaten Runroot erhalten. Der erste vollständige Typcheck scheiterte anschließend ausschließlich an einem Readonly-Testcast (`/private/tmp/cn-copy-views-checks-8jiyd8vv/results.json`, SHA-256 `0b6f52a82dfe6e09e0ec7e55957e61f4d1a6bebb54be222a855bf877417c0381`). Nur die Typangabe wurde korrigiert, die vier betroffenen Tests erneut bestanden und der vollständige cachefreie Typcheck neu ausgeführt. Produkt und Assertions wurden dafür nicht geändert.

Der unabhängige Produkt-/Testreview findet nach diesen engen Korrekturen keinen konkreten neuen P1/P2. `detect_changes` meldet MEDIUM und drei betroffene Copy-POST-Prozesse; unindexierte neue Owner-/Phasen-/Testfunktionen sind damit nicht vollständig erfasst. Der Legacy-Servicesuffix ab `savedRequest`, PI, Recoveryroute und Undo-Policy sind bytegleich; die Copyroute unterscheidet sich allein durch die native Dedupebedingung. Die weitere gemeinsame UI-Abnahme und der vollständige API-/SDK-/Such-/PDF-/Sandboxauftrag bleiben offen.
