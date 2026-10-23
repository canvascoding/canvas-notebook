# Manuelle Markdown-Anlage: I-06

Stand: 15. Oktober 2026. **Sourceanschluss und unabhängige Integrationsprüfung abgeschlossen; Produktgate und gemeinsame Browserabnahme bleiben offen.** Basis ist `ba56bec85c3829fb86f1631510afeb2f91ebe37c`, Integrationsworktree `824c`.

## Ergebnis und enger Vertrag

Homepage und Dateibrowser verwenden den vorhandenen Create-POST mit einer vor dem ersten Senden festgelegten UUID. Ein neues `.md`-/`.markdown`-Dokument erhält zuerst einen wirklich leeren nativen Anfangszustand und eine zugehörige erste physische Veröffentlichung. Erst HTTP 200 mit strikt passender `completed`-Completion darf den Create-Aufruf erfolgreich auflösen und das Dokument öffnen. Die anschließende erste Texteingabe ist eine normale Editoroperation. Gewöhnliches Paste, ausdrückliches Markdown-Einfügen und vollständiger Dateiimport behalten ihre eigenen Verträge aus dem [Detailplan](./markdown-manual-create-implementation-plan.md).

Offene Ergebnisse sind HTTP 409 mit `success: false`, endlichem Code und exakt gebundenen öffentlichen Koordinaten. Eine verlorene oder unlesbare Antwort, 202 oder eine abweichende Completion bleibt unbestätigt. Der gemeinsame Client speichert höchstens 16 öffentliche Lookupversuche pro Konto; Reload und Hydration starten keinen Request. Ausdrückliche Wiederaufnahme sendet dieselbe UUID, denselben Workspace und Pfad. Das lokale Ausblenden entfernt ausschließlich diesen Lookup. Es löscht keine Datei und kompensiert keinen serverseitigen Auftrag.

Der Server teilt den bestehenden authentisierten Create-/Birth-/Projektionskern. Die manuelle Quelle besteht fest aus null UTF-8-Bytes, LF ohne BOM, Blocks/schema1. Es gibt keine künstliche Uploadsession. Der bestehende Uploadzweig behält seine tatsächlichen Manifest-, FD-, Part-, Hash-, Progress- und TTL-Prüfungen. Freie Manualrecords, Accessoren oder ein zweiter Birthentry im selben Kontext können keine Autorität erzeugen: fester privater Kontext, einmal reservierte Invocationidentität sowie echte aktuelle Owner-, Scope-, Realm-, Claim- und Veröffentlichungsphasen werden geprüft.

Nach Schließen des eigentlichen Engine-/Helperversprechens und vor History, Cacheinvalidierung und Audit wird der eigene native und physische Abschluss erneut geprüft. Die tatsächlichen finalen Checkouts prüfen den ursprünglichen rohen Realm vor jeder Normalisierung; die echte Principalphase prüft außerdem Customer, Project und Root. Ein Closefehler kann keine Completed-Antwort erzeugen. History bindet die bestätigten anfänglichen leeren Bytes; Audit bleibt best effort und kann bei Retry wiederholt werden.

Das zentrale Produktgate bleibt unverändert `false`. Der vorhandene ausschließlich an `NODE_ENV=test` gebundene Testeingang wird nur in der isolierten Fixture verwendet. Bei geschlossenem Gate gibt es keine neue native Anlage, Claiminitialisierung, Ersatzdatei oder Createfolgewirkung. Auch ein nachgewiesener fertiger Birth allein belegt dann nicht sämtliche Routefolgen und bleibt konservativ `recovery_required`.

## Tatsächliche Prüfungen und unabhängige Rootkontrolle

| Prüfung | Ergebnis und Beleggrenze |
| --- | --- |
| Neue echte Cookie-/Bearer-/PG18-/FS-/Prozessmatrix | Neun unveränderte Familien im V6-Vollanlauf bestanden; fünf gezielt ausgewählte Familien auf V7 mit tatsächlichem Exit 0. Kein einzelner vollständiger V7-14er-Lauf behauptet. |
| Freier mechanischer Birthentry | Neun genaue Negativfälle, Exit 0; echte Dateisystemgrenze, kein Auth-/PG-Nachweis. |
| Bestehende authentisierte Staging-Uploadmatrix I-03b | Alle 15 Familien, Exit 0. |
| Bestehende First-Projection-Matrix I-04 | Alle 14 Familien, Exit 0, einschließlich tatsächlich gestopptem Helper, beendetem D-Backend und widerrufener Session vor verweigerter Veröffentlichung. |
| Bestehende echte Chunkroutenmatrix I-05 | Alle 17 Familien, Exit 0, einschließlich ursprünglichem Native-Queueconsumer. |
| Echter Client-/Store-/React-Consumer und vorhandene Create-/Home-/Zielpicker-Suiten | Bestanden. Nach der Dialoggenerationskorrektur bestehen zusätzlich sechs gezielte Reactfälle und der bestehende neue Clienttest auf den finalen Produktbytes. Agent führte diese Läufe aus; Root prüfte Source, Diff, Log- und Freezehashes unabhängig. |
| Finales vollständiges TypeScript und Lint | Cachefreies vollständiges TypeScript mit 12 GiB, Exit 0; scoped Lint aller geänderten TS-/TSX-Dateien bestanden. Frühere TSC-Läufe fanden jeweils zwei reine Testtypprobleme: Zahlannotationen im Clienttest und Nichtnullzusicherungen für `process.disconnect` nach dessen vorhandener IPC-Bedingung. Root prüfte beide genauen Korrekturen und das unveränderte transpilierte JavaScript. |

Die ersten neun neuen Familien prüfen unter anderem direkte erfolgreiche Cookie-Web- und Bearer-Mobile-Erstellung, ursprünglichen Retry, fremden physischen Pfad, gleiche Bytes in fremdem Inode, echte Session-/Rechtebindung, tatsächlich getöteten Vorbereitungshelper nach Commit, verlorene Prozessantwort und zwei echte gleichzeitige Prozesse mit verschiedenen beziehungsweise gleichen UUIDs. Winner-/Loser-Receipts und Birthbindungen werden getrennt geprüft. Es gibt keine automatischen Mutationswiederholungen zum Bestehen eines Rennens.

V7 prüft separat die fünf verbleibenden Familien: ursprünglicher Scopewechsel nach dem zweiten tatsächlichen Observer-COMMIT, veränderter roher finaler Checkout bei gleichen Schema-/Datenbank-OIDs, tatsächlicher Observer-Closefehler, tatsächlicher Owner-Closefehler nach Routefolgen und Gatefalse ohne neue History-/Auditfolgen. Die Drifttests verlangen positive tatsächliche SQL-Witnesses sowie fehlende History-/Audit-/Normalisierungswirkungen. Ein Fehler in der Testvorbereitung kann dadurch nicht als gewünschte Produkt409 bestehen.

Die zusätzliche Clientreview fand einen konkreten verspäteten Dialogabschluss: Nach Workspacewechsel und Wiederöffnen konnte ein alter Request die neue Form blockieren, Fehler schreiben oder bei A→B→A schließen. Der Dialog prüft jetzt seine konkrete Generation und Requestinstanz; der Hook räumt ausschließlich seine eigene `createdRef`-Identität ab. Sechs echte Consumerfälle decken A→B und A→B→A mit jeweils verspätetem Completed, Pending und verlorener Antwort ab. Sie belegen auch, dass der neue Request währenddessen senden darf und sein eigener Doppelabsendeschutz erhalten bleibt.

Der frische tatsächliche Rootindex erfasst den fokussierten staged Umfang mit 25 Dateien, 295 Symbolen und neun betroffenen Prozessen als HIGH. Die erfassten Prozesse gehören zu Create-Auth/Rechten/Rate-Limit und Home; dynamische UI-/Callbackcaller wurden zusätzlich anhand von Source und Consumerfällen geprüft. Der separate Vergleich des gesamten bisherigen Branches gegen `main` umfasst 448 indexierte geänderte Dateien, 4.974 Symbole und 46 Prozesse und ist CRITICAL. Er ist kein alleiniger I-06-Umfang und kein Abnahmebeleg für den ganzen Branch. Die Risiken wurden vor dem Commit gemeldet.

## Erhaltene Fehlversuche und korrigierte Testvorbereitung

V5 endete nach neun bestandenen Familien mit Exit 1, weil der Scope-Witness nicht erreicht wurde. Die Quelle zeigt, dass die direkten Handleraufrufe dasselbe echte 20/Minute-Budget teilen; variierte Forwarded-Header partitionieren diese Identität nicht. Ein tatsächlicher HTTP-429-Status wurde in diesem Lauf nicht protokolliert und wird nicht rückwirkend behauptet. Der Test verwendet anschließend den unveränderten vorhandenen 19/61s-Budgethelfer vor dem Senden, ohne Limiteränderung oder Fehlerretry.

V6 besteht die ersten neun Familien und protokolliert zusätzlich einen zehnten PASS. Danach endete der Rawtest tatsächlich mit HTTP 200 und `injected: false`, `rawVerified: false`; er hatte keine Abweichung erzeugt. Der zehnte PASS ist ebenfalls kein Beleg für die beabsichtigte finale Scope-Race, weil der damalige Zähler mehrere Receipt-SELECTs innerhalb desselben Observers zählte. V7 zählt stattdessen erfolgreiche echte BEGIN/Receipt/COMMIT-Transaktionen, setzt beide Drifts nach Observer-COMMIT 2 und wählt den echten rohen Guard-SQL auf einem bekannten Runtime-Checkout. Alle fünf gezielten Fälle bestehen mit tatsächlichem Exit 0. Produktdateien wurden zwischen diesen Läufen nicht verändert; alte Logs und Freeze-Manifeste bleiben erhalten.

## Closure und Evidenzgrenzen

Die neue Fixture hält ihre eigenen Sourcechild-Prozesse und Gruppen mit PID-/Start-/CWD-Fences. Endliche Result-/Ready-/Closegrenzen sowie eine tatsächliche lesende PostgreSQL-Abwesenheitsbarriere laufen vor DROP/RM. Unbestätigte Closure behält Schema und DATA. Das ist kein unabhängiger OS-Inventarbeleg für sämtliche kurzlebigen Root-API-Helper; dort gilt der vorhandene Produkt-Whole-Promise-Vertrag. Der echte I-04-Latehelper-Gegenfall ist ein eigener zusätzlicher Nachweis.

Nach dem V7-Lauf hat Root Nodeprozess, eigene DATA und UUID-Schema zusätzlich unabhängig als abwesend geprüft. Nach der alten I-05-Vollmatrix hat Root auch alle 154 vom Lauf beobachteten Runtimebackends unabhängig als abwesend geprüft. Andere Cleanupangaben bleiben bei den ausdrücklich benannten internen Scriptassertions.

## Noch offene Abnahmen

Der installierte Native-Mobile-Files-Createclient sendet noch keine stabile Request-ID und benötigt vor allgemeiner Aktivierung seinen eigenen Adapter. Die bestehende Mobile-Route erbt bereits den sicheren Serververtrag und antwortet bei fehlender ID mit 400; sie liefert keinen ungebundenen scheinbaren 2xx-Erfolg. Das separate Notebook-Titeltemplate bleibt ein eigener nicht leerer Create.

I-07 muss den frischen integrierten Build über echte Browserinteraktion prüfen: UI-Create, erster Clipboardpaste, ausdrückliches Markdowneinfügen, vollständiger Dateiimport, Pending/Resume, Undo/Redo, Peer, Reload, frischer Browser, Desktop/mobiles Web, Breite/Fokus und zwei tatsächliche Hostneustarts. Frühere Browser- oder kompilierte Protokollläufe auf älterer Basis ersetzen das nicht. Native Geräte, weitere Importflächen und die ursprüngliche Produktionsdatei sind damit nicht abgenommen oder repariert.

Private Rootbelege: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-i06-root-integration-vflrpgc9/`. Server-Testfreeze V7: `/tmp/canvas-i06-server-test-freeze-v7.json`, SHA-256 `97a6336e679b200aac1d83e473c58b5f96956bb86ea998eb9c92296f45a5e1f6`.
