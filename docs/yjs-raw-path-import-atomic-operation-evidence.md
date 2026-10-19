# Raw-Move/Delete: atomare interne Operationsvorbereitung

Stand: 20. Oktober 2026. Arbeitsbasis Root `7b51a4ab803730544f66e9aa4120d0ab86d1154f` plus die unten gepinnten Änderungen. **Interner Teilschritt geprüft; öffentlicher Originalpreview-ID-Anschluss, M1 und MVP bleiben offen.** Produktionsaktivierung, Dateiaktions-Undo und Review Center bleiben aus.

## Verhalten und Grenze

Der feste Commit-Owner `prepareWorkspacePathImportOperation` verwendet den vorhandenen tatsächlichen Lifecycle-Guard und Transaktionsowner. Auf derselben B0-Transaktion entstehen zentrale Originalimporte, unveränderlicher Elternbeleg, echter Batchheader, Move-Vorbereitung samt Bundle beziehungsweise Delete-Zulassung und vollständige Admission-Reservation. Der feste interne Reservationseinstieg prüft den privaten lebenden Frame und die echte externe Workspace-Lease; normale Reservierungslocks bleiben erhalten. Die vorhandenen Projektionsguards sperren die importierten Originale bereits nach Commit.

MCP erhält einen unbeanspruchten `needs_recovery`-Header, Web einen `queued`-Header, jeweils ohne Lease. Vor bestätigtem COMMIT, Verbindungsabschluss und Guardfreigabe wird kein ausführbarer Claim erzeugt. Danach führen der unveränderte gewöhnliche MCP-Claim und Owner beziehungsweise der echte Web-Worker dieselbe Operation aus. Unsicherheit über Commit oder Verbindungsabschluss bestätigt keinen Erfolg. Historische Wiederholung liefert ursprüngliche Fakten ohne aktuelle Native-/FD-Übernahme. Die gespeicherte Physical-Parser-Version wird in späteren Ownern weitergegeben; alte fehlende beziehungsweise Version-2-Marker bleiben Version 2.

Der öffentliche Adapter ist **noch nicht angeschlossen**: Der Test verwendet beim späteren MCP-Recover die tatsächlich gespeicherte native Plan-ID. Er belegt keine öffentliche Originalpreview-ID-Zuordnung, keinen HTTP-/Browserlauf, keinen fertigen Markdownexport und keine ausgelieferte Produktion.

## Tatsächliche Prüfung

| Folge | Ergebnis |
| --- | --- |
| Finale gezielte TypeScript-/ESLint-Prüfung | Exit 0 / 0, ohne Lintwarnung |
| Neue tatsächliche atomare PG18-/FD-Folge | 7/7, Exit 0 |
| Bisheriger interner B0-Import | 9/9 |
| Bestehender gemischter Move / Delete | 6/6 / 8/8 |
| Bestehender ausgewählter Raw-Copy-Owner | 8/8 |
| Gemeinsame tatsächliche Admission-/Kernelprobe | bestanden, nicht übersprungen |

Die sieben neuen Gruppen prüfen echte MCP-Move-/Delete-Imports mit Same-B/XID, Header/P0/Targets und Unsichtbarkeit vor Commit; den echten Web-Worker; vollständiges Caller-Rollback; unveränderte 0444-Raw-Dateien mit lokalen Links über den tatsächlichen vollständigen Commit-Owner; falsche Principals/Capabilities; sowie echte SID-B-Historie nach Move mit ungültiger Ersatzdatei am alten Pfad. Nach Commit werden die tatsächliche Projektorsperre und spätere Freigabe geprüft. Native Links/Inhalte, archivierte Identität samt exakten Yjs-Bytes und Vektor sowie SQL-/DATA-/FD-Orakel bleiben vollständig.

Erhaltene REDs betreffen den neuen Test: TypeScript-Unionvergleich (`run2`), spät zugewiesene Sitzungsvariable/ESLint (`run3`), API-JSON gegenüber internen Null-Prototyp-Attributen (`run4`), Active-only-Load für korrekt archivierten State (`run5`) und Active-Snapshot für archivierten State (`run6`). Der Test liest nun mit dem vorhandenen tatsächlichen Archived-Reader und behält Status/Generation/Binary/Vector-Assertions. Ein zusätzliches Quellenreview trennt den Fresh-Guard vom gesamten weiterhin streng beobachteten historischen Reader; das No-current-Native-SQL-Orakel bleibt bestehen. Produktguards werden nicht gelockert. Ursprünglicher V2-Testkandidat und sämtliche roten Originale bleiben privat erhalten.

`run8` besteht finale Typen/Lint und alle sieben Gruppen. Die anschließend ausgeführte `run7` besteht alle fünf gezielten Bestandsfolgen. Alle **4.180 Quellenpins** sind innerhalb und zwischen diesen beiden Läufen unverändert. Acht unabhängige Metadata-Ressourcenabschlüsse bestätigen entferntes eigenes Schema/OID, geschlossene eigene Sessions, entferntes DATA, beendeten Originalprozess sowie dieselben vier gesunden verwalteten Dienste. Der zusätzliche RO/RR-/unassigned-XID-Nachcheck bestätigt Admission-Schema-/Session-, Kernel-DATA-/PID-Abschluss und neun entfernte ESM-Verzeichnisse. Kein Container wurde gebaut oder neu gestartet.

## Originale und Quellen

Private Originale: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-path-atomic-a8a77vfm`. Die Ordner behalten Controller, Quellenpins, Logs und Terminalcodes; `accepted-source-pins.json` und `final-validation-report.json` binden die gemeinsame Abnahme. Der gemeinsame Reservierungskern meldete vor Änderung HIGH mit fünf direkten Aufrufern in drei Modulen. Seine normale Locksequenz bleibt unverändert und wird tatsächlich mitgeprüft. Neue Symbole waren im Ausgangsindex UNKNOWN; dies war keine Sicherheitsfreigabe. Abschließende Root-/QA-Änderungsabgleiche und Schutzpins liegen separat bei den Originalen.

| Quelle | SHA-256 |
| --- | --- |
| `app/lib/collaboration/room-admission.ts` | `c669c3a76247e3494d5c71f9f81d477635957308361b5558c22d6e4f67beabb9` |
| `app/lib/files/workspace-operation-batch-store.ts` | `ad099f31127638df3cd226b9bf05ee70fc70c60ead00e49e1214fd2dff1cfb8f` |
| `app/lib/files/workspace-operation-job-lifecycle-owner.ts` | `d1f5010eaeb8a61bf9f9c125baa622845a8f90eea0ccf678aa34434a2397269b` |
| `app/lib/files/workspace-operation-native-path-admission.ts` | `91e80e3b2f75f67abdcc5f8bae4ffb6657fe02e13e9099dac0317ba6a31e724a` |
| `app/lib/files/workspace-operation-original-move-sources.ts` | `dd7ba013525a095302afea1c882cb0b880ea581cbce7b4b7598062fa93b893ac` |
| `app/lib/files/workspace-path-import-preparation-phase.ts` | `0370c67a016b89c1b54d268ad20f09e8ab1fd0df58c973f1f9add5125cc228ff` |
| `app/lib/files/workspace-operation-path-source-parser.ts` | `36ff9f6a163967ebfa031df5bf3908086130da88672fdf351c9f34faeda20cad` |
| `app/lib/files/workspace-path-import-operation.ts` | `d04f4ff845cfae9c940745bb78754fbbdcc7df666c6ee715a60bf7249b9f34e9` |
| `scripts/workspace-path-import-atomic-postgres-test.ts` | `93f33940b9d39f4383cdb8f077c190234f70f5c79e9801f21535a072dc4c4325` |
| `scripts/workspace-path-import-atomic-postgres-runner-test.ts` | `c12b3640fda8138cb42fe8791394e45251222347dce8d5c037030c4636edd103` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `f89cfe7707f6f8d474ea7cfa73b880bf33c552813eace333b5bf584e9f9840a5` |

M1 benötigt jetzt den gemeinsamen autorisierten historischen Selector und die öffentlichen MCP-/Web-Preview-, Apply-, Status- und Recover-Anschlüsse. M2 und M3 bleiben wie im [MVP-Launchplan](./yjs-document-authority-mvp-launch-plan.md) offen. Die zwei bekannten roten älteren Gesamtsuiten sind durch diese gezielten Prüfungen nicht geschlossen.
