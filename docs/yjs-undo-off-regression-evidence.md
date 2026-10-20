# M3: bestehende Regressionen bei ausgeschaltetem Datei-Undo

Stand: 20. Oktober 2026. Testkorrektur auf Root-Basis `a31869fbba62b00143bc6fd8118a13154754465f`; Produktquellen und feste Undo-OFF-Policy bleiben unverändert. Die gemeinsame aktuelle Build-/Browserabnahme und die PR-Freigabe bleiben offen.

## Ursachen und tatsächliche Gegenproben

Der unveränderte Executor-Test erwartete noch aktives Datei-Undo. Mit der bisherigen echten Hostkonfiguration und dem bisherigen PI-Importcondition-Preload erreicht er die Assertion an Zeile 162: erwartet `BATCH_UNDO_NEW_BACKLINK`, tatsächlich `FILE_OPERATION_UNDO_DISABLED`. Originalprozess: Exit 1, kein Signal, 33,281 Sekunden; vollständiger Quellcensus vorher/nachher gleich.

Zwei vorherige Versuche bleiben getrennt erhalten: ohne Importcondition scheitert der CJS-Import von `pi-ai/compat`; mit Importcondition, aber ohne die bisherige Hostkonfiguration scheitert bereits der erste Forward-Apply. Diese Setupfehler werden nicht als Undo-Produktfehler ausgegeben.

Die unveränderte Undo-OFF-Suite besteht acht Sperrgruppen und scheitert anschließend im modellierten Apply-Workerfall an `executions === 1` mit Wert 0. Originalprozess: Exit 1, kein Signal, 1,714 Sekunden, Quellen unverändert. Ihr expliziter Quellloader hatte das inzwischen ausgelagerte echte `workspace-operation-claim-renewals` nicht geladen; der absichtlich verbotene Ersatzzugriff scheiterte vor Execute und wurde vom Worker als Fehler behandelt.

## Korrektur und Abnahme

- Der Executor behält seine Forward-, Link-, Checkpoint-, Recovery-, Peer-, Actor-, HTML- und Sicherheitsprüfungen. Alle 30 Undo-APIversuche verlangen jetzt exakt Disabled/409 und vergleichen vollständigen DATA-Baum einschließlich Bytes/Identitäten/Metadaten/Manifesten, Ereignisse, Trashrecords, autoritativen Linkzustand und Adapterzähler vorher/nachher. Zuvor gestartete Projektoren werden vor dem jeweiligen Fenster abgewartet.
- Positive inverse Release-/Recovery-/Ledger-/Undo-Assertions gehören zum abgeschalteten Arm und werden ausdrücklich nicht mehr als aktive Abnahme behauptet. Vier gekennzeichnete Fixture-Resets richten nur spätere unabhängige Forwardfälle ein; sie liegen außerhalb der NoWrite-Fenster und sind kein Produkt-Undo. Eine beschädigte Forward-Plan-ID mit neu berechnetem äußeren Digest bleibt eine echte Unavailable-/Pending-Gegenprobe.
- Die separate Undo-OFF-Suite lädt und injiziert ausschließlich das tatsächliche ausgelagerte Claim-Renewal-Modul. Alle alten Assertionen und verbotenen Grenzen bleiben erhalten.
- Der vorhandene feste ESM-Runner erhält nur zwei Allowlist-Einträge. Seine Ausführung und Cleanupmechanik bleiben bytegleich. Im Undo-OFF-Test werden die tatsächlichen dynamisch gelesenen Quellbytes durch den bestehenden Quellloader gepinnt; sie werden nicht fälschlich als Bundleinputs ausgegeben. Der finale Lauf benötigt keinen privaten PI-Preload.

Vor den Edits: GitNexus `main` beider Tests jeweils LOW, ein direkter Aufrufer, keine Prozesse; neue `assertUndoDisabled` vorab UNKNOWN, kein Sicherheitsbeweis. Runner-Konstante LOW, keine direkten Aufrufer/Prozesse. Unabhängiger Quellenreview findet keinen konkreten P1/P2; keine Produktpolicy wurde aktiviert oder ersetzt.

| Tatsächlich ausgeführte Prüfung | Ergebnis | Dauer |
|---|---|---|
| TypeScript, Importgraph beider Tests | Exit 0, kein Signal | 19,394 s |
| ESLint, beide Tests und Runner | Exit 0, kein Signal | 1,611 s |
| Vollständiger Executor, echter ESM-Quellgraph | Exit 0, kein Signal | 39,204 s |
| Vollständige Undo-OFF-Suite, 13 Gruppen | Exit 0, kein Signal | 1,479 s |

Beide Tests laufen seriell über `node scripts/run-document-read-tool-dispatch-test.mjs <Testpfad>` mit `NODE_ENV=test` und der bisherigen privaten Hostkonfiguration. Der vollständige Quellenvergleich vor/nach ist gleich. Beide tatsächlichen Bundlepfade fehlen nach bestätigtem Child-Close und Cleanup; kein Executor-Fixturepfad bleibt zurück. Dieselben vier verwalteten Dienste bleiben gesund. Kein Container wurde gebaut oder neu gestartet.

**Grenzen:** Der Executor ist eine explizite Legacy-V1-Dateisystem-/Adapterprobe. Die Undo-OFF-Suite verwendet echte exportierte Funktionskörper und eingebettetes SQL mit kontrollierten Auth-/Kernel-/Executegrenzen. Diese Ergebnisse ersetzen weder aktuelle PG18-/Auth-/Native-Dateiaktionen noch Browser-, Main- oder Produktionsabnahme.

## Gebundene Quellen

| Quelle | SHA-256 |
|---|---|
| `scripts/workspace-operation-batch-executor-test.ts` | `a95301d76758b98791d3026f766a704182ffd5fb815096f6735afdf6bef08e47` |
| `scripts/workspace-file-undo-disabled-test.ts` | `2405bba0f00efdfd5cd988e227ca295b624c68444d454311d78be92ab62ae2d1` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `f9f3ad7283bac2628d170f212c184288dcca593a7e6f551d646bafbc02dbc691` |

## Erhaltene Originale

Private Originale unter `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m3-legacy-close-x5x_tco0`. Historische frühere RED-Belege werden nicht geändert.

| Original | SHA-256 |
|---|---|
| `baseline-executor/terminal.json` | `25656a37770a20a0b385994e8d87055f4fbdb28f6aee18fc29184d193ae0c443` |
| `baseline-executor-import-condition/terminal.json` | `2cd006144c71942b1206ac1887156756cecd446c316adcb8b1f70c7dda7fa196` |
| `baseline-executor-hostenv/terminal.json` | `b7d07a48892ffe942443c3df15b57cd9908215d8bda4d985ce98eb075741ff8d` |
| `baseline-undo-disabled/terminal.json` | `97a63e830711af8e2dd24a4cd1d1a3bf8645c3147b2f802975a5681f366486d2` |
| `final-legacy/source-start.json` | `83ae6dc329ee31fd8ee449306da23e50d2fae1e3c6784a84196d9def8d7fc9e4` |
| `final-legacy/terminal.json` | `873ec2cbff3f469d691470cbf050bb95f180a5d092c20e7c9ff473a20da49170` |
| `final-legacy/batch-executor.log` | `75d39d4e5633da0af71b3c71202778161fe5ef4b24b013a11351101d45737965` |
| `final-legacy/undo-disabled.log` | `47668b94309662b068c5139b36cc837ec4af118ebcce51968f7c7ec677710acc` |
| `legacy-closure.json` | `69876a8f2a9e820d50b84b884d0ecd65a58eb53ecf586b6eccf0cb24cbbc8899` |
