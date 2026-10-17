# Lokale Copy-Abnahme: frischer Build, unveränderte Browserfolge und Ressourcenabschluss

Stand 17. Oktober 2026. Auf Root `82c6dc1b959c8a8791b67cbfd2000218e2a427bc` und QA `92df8dc5282581a67320802f4b51ab3b1d2f961d` besteht die unveränderte originale Copy10-Folge mit **10/10 und tatsächlichem Exit0**. Der unabhängige Ressourcen-/Artefaktabschluss endet ebenfalls mit Exit0. Das ist eine lokale Abnahme der nachstehenden Matrix, keine Fertigmeldung des Gesamtplans und keine Produktionsauslieferung.

## Tatsächlich ausgeführte Matrix

| Ursprüngliche Spec | Ergebnis | Nachweisumfang |
| --- | --- | --- |
| `workspace-operation-native-copy.spec.ts` | 6/6 | Je Desktop und Mobile Web: manuelle native Rich-Kopie mit Relativlinkpflege und isolierter späterer Kopiebearbeitung; gemischter ordnerübergreifender Copy mit nativer Linknavigation, bytegleicher PDF und historischem Replay; unterbrochener Copyabschluss mit Wiederaufnahme in bereits offener Zielansicht und gemeinsamem Titel. |
| `workspace-operation-copy-origin.spec.ts` | 2/2 | Je Desktop und Mobile Web: TXT-/Markdown-Kopien behalten ihren öffentlichen Originalstatus nach einer tatsächlich neuen Anmeldung; keine zweite Kopie. |
| `workspace-file-undo-disabled.spec.ts` | 2/2 | Je Desktop und Mobile Web: Markdown und TXT lassen sich löschen; Undo fehlt im UI und bleibt einschließlich alter API-/Restore-Einstiege ausdrücklich gesperrt. |

Alle drei Specs sind tatsächlich gestartet und abgeschlossen: deklariert10, bestanden10, fehlgeschlagen0, übersprungen0, timedOut0, unterbrochen0. Ein Worker, null Retries und sämtliche ursprünglichen Assertions/Deadlines bleiben erhalten. Insbesondere bestehen nun die vorher roten mobilen Link- und Recovery-/Heartbeat-/Once-Add-Prüfungen. Die historische 5/6-Folge wird nicht umgedeutet; ihre ursprüngliche genaue zweite WebSocket-Meldung ist weiterhin nicht gespeichert.

## Feste Quellen- und Artefaktbindung

Control Plane bleibt unverändert auf `27c8ce37da082244f006ca376068cde6b98845d5`. Beide Notebookworktrees sind vor und während der Abnahme sauber und unterscheiden sich ausschließlich in den drei vorgesehenen Aktivierungs-/Belegdateien. Binärpatch-SHA `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`.

| Tatsächlicher Schritt | Ergebnis und Originalbeleg |
| --- | --- |
| Neue Quellenprüfung32346 | Exit0; `/private/tmp/canvas-copy-ui-projection-watcher-pending-23_a8uho/source-report.json`, SHA `002fcfa75af6b2b83d299e460657aacbff0de5bf3865c28999e32461c0ee6fc2` |
| Originaler neuer Produktionsbuild22001 | Exit0; neuer privater Buildroot `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-build-xD1Gx1`; Buildlog-SHA `8e6104bb74d108d5fe04bf0315172db602c23c3ca54a809b6e4fe123f6842d8a` |
| Unabhängige Artefaktprüfung42878 | Exit0; `/private/tmp/canvas-copy-ui-projection-watcher-pending-23_a8uho/artifact-report.json`, SHA `7792abc51bb8072aacadc871f78d63e59e59eefdedc992770ea5482a3e572ab5` |
| Originaler Browser-Supervisor93177 | Tatsächlicher Exit0; `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-z9hf6x/recovery.json` mit `phase: cleaned`, `passed: true`, `uncertain: false` |
| Neue passive Baseline | `/private/tmp/canvas-copy-ui-projection-watcher-pending-23_a8uho/baseline.json`, SHA `0ab081159b3f8437af8f4a8974a38b399e0b6ca9195cdbfc6dabc1fb07ee4922` |
| Unabhängiger Originalpostcheck2787 | Exit0; `/private/tmp/canvas-copy-ui-projection-watcher-pending-23_a8uho/postruntime-report.json`, SHA `70000c33a77cb5a000d3b3b6973bde0d2c6115510cd56e3060959c1c1f1ae89d`; sämtliche14 Prüfungen bestanden |

QA-Quellenfingerprint `c184a4e7d35a0e54c7310eb939d9bc4fa487585cff23d5711fe7feb60febe015`; Root `30ddfd994e651c7c815a84973458f9652f7a706bb1bb85684158f3bb47080c33`. Je5491 Dateien, unabhängiges serielles Hashing stimmt überein. Kompilierter Fingerprint `048ba3b3918d3233ffdb85648d52985182c467525db4c791775e65aa8eeb4585`. Die native FD-API3 wird anhand Manifest, Original-C-Quelle und tatsächlich gebauter Binärdatei geprüft; kein alter Proof wird als neuer übernommen.

Die separate lesende Packagingprüfung verfolgt den produktiven Watcher-Singleton, seinen dynamischen Loader, alle43 referenzierten vorhandenen Chunks und den tatsächlichen Classifierexport. Die Helper-Sourcemap ist bytegleich dem aktuellen TypeScript. Auch der direkte TS-Pfad des Customservers enthält beide Dateien. Das ist ein zusätzlicher Verdrahtungsnachweis; allein daraus folgt kein erfolgreicher Datenbankread.

Das geschlossene originale `host-0.log` umfasst460613Byte, ist nicht abgeschnitten und trägt SHA `491328d0a4cbb57b5442299c70495039354bf84d0ba657a40c1443a0b8b4f8e4`. Die unabhängige lesende Auswertung findet jeweils0 für `FILESYSTEM_AUTHORITY_UNAVAILABLE`, native Namespacefehler, fehlende Module beziehungsweise Dynamic-Import-/Chunkfehler sowie unbehandelte Promise-/Laufzeitfehler. Erfolgreiche Classifier-Aufrufe werden nicht einzeln protokolliert. Auch der originale Reporter persistiert die nur im Speicher angehängten Files-Protokollbodies und erfolgreichen Traces nicht. Es werden deshalb keine nachträglichen Framepayloads oder Aufrufzahlen rekonstruiert. Die unveränderten Assertions prüfen den späteren Heartbeat, unveränderte Adds und leere Streamfehler.

## Tatsächlicher Ressourcenabschluss

Die neue passive Baseline erfasst zehn ursprüngliche Prozessidentitäten. Der Postcheck bestätigt alle beobachteten Identitäten abwesend, eigene Gruppen leer, ursprüngliche Ports60930/60653/60603 frei und den Lauf-Lock entfernt. Die eigenen Notebook-/Issuer-Datenbanken mit OIDs10496992/10504461 sowie ihre Namen und Backends sind tatsächlich abwesend. DATA und TMP fehlen ebenfalls. Issuer-Originalbeleg: `cleaned`, Pools und App geschlossen, Datenbank gelöscht, keine Unsicherheit.

Vier verwaltete Dienste besitzen weiterhin dieselben IDs, laufen und sind gesund; drei HTTP-Healthchecks liefern200. Quellen, Buildproof und Originalbelege bleiben während des Postchecks unverändert. Die Baseline ist eine passive Stichprobe und kein vollständiger Startup-/Kurzprozessmonitor; der originale Supervisor prüft zusätzlich seine gehaltenen Childgruppen. Es gibt keine Container-/Image-Erstellung, keine fremde Prozessbeendigung und keine Produktionsmutation.

## Grenzen und nächste notwendige Arbeit

Diese Abnahme ergänzt die bereits dokumentierten Copy25-, Metadata13-, Views6- und lokalen Gegenproben. Diese älteren Nachweise behalten jeweils ihre eigenen Quellstände; sie werden nicht nachträglich auf neue Bytes umgebunden. Die [vierte rote Folge und ihr getrenntes Cleanup](./yjs-native-copy-fourth-browser-evidence.md) sowie die früheren roten Folgen bleiben vollständig erhalten.

Nicht nachgewiesen sind dadurch ein Copy-Hostneustart während einer offenen Operation, die Linux-Wiederholung des neuen Copy-FS-Pfads oder eine allgemeine Lastabnahme mit Tausenden nativer Klone. Der ursprüngliche Produktionsfehler ist damit weder erneut mutiert noch nachträglich kausal erklärt. Allgemeine Aktivierung bleibt vom Gesamtgate abhängig.

Der nächste gemeinsame Produktschnitt bleibt die projektionsunabhängige V2-Semantik für Move/Rename und Delete-Current-Pins einschließlich ursprünglicher Original-/Intent-/Bundle-/CAS-Bindungen. Einheitliche API-/MCP-/PI-/Mobile-Verträge, progressive ID-/Versionssuche, externes Python-SDK, Standard-Skill, PDF→native Herkunft und die übrige Sandboxmatrix bleiben im Gesamtauftrag. Dateiaktions-Undo und das experimentelle Review Center bleiben aus.
