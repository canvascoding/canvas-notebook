# Asset-Delete mit eingehendem nativem Link: Projektionsphase

Stand: 17. Oktober 2026. Der tatsächliche lokale PG18-Lauf auf Root `d8e3d5500583e5d99a454723a930bed0a6cc79b3` / QA `9d4327e72e788d267d34f14af1bdc09330606d2d` reproduziert denselben Produktfehler bei drei physischen Zielen: PDF, TXT und PNG mit eingehender nativer Markdown-Notiz. Alle drei enden tatsächlich mit Exit 1; beide Pfad-/Yjs-Linkschritte sind bereits angewendet, aber der Batch meldet `needs_recovery` und `COLLABORATION_FILE_OPERATION_PROJECTION_PENDING`.

## Reale Gegenprobe

Die Probe verwendet den tatsächlichen Legacy-V1-Planer, aktuelle authentifizierte Principal-Rechte, Store/createDirect/claim/withClaim und den unveränderten Executor. Die native Quelle wird über den authentifizierten Upload-/Importdienst erzeugt. Der echte Kollaborationsserver mit Hocuspocus und echten Room-Owner-Sitzungen ist installiert; kein Live-Reader, Writer, Guard, Ergebnis oder SQL-Datensatz wird ersetzt. Ein passiver SQL-Hook beobachtet erst die tatsächliche Antwort und liest danach die tatsächlichen Sperrhalter. Physische Zieldateien sind synthetische Testdaten; insbesondere wird kein PDFparser abgenommen. Der Durchstich ist auf Kerne und Dienste begrenzt, keine HTTP-/Browser-/Produktionsabnahme.

| Ziel | Pfad-/Linkschritte | Tatsächlicher Batchstatus | Eigener exklusiver Halter / abgewiesener Shared-Backend |
| --- | --- | --- | --- |
| `asset-pdf-native-link` | 2/2 angewendet | `needs_recovery` | `66922` / `66941` |
| `asset-txt-native-link` | 2/2 angewendet | `needs_recovery` | `67268` / `67277` |
| `asset-png-native-link` | 2/2 angewendet | `needs_recovery` | `67626` / `67643` |

Die tatsächliche Shared-Trylock-Antwort lautet in jedem Fall `locked:false`, während die exklusive Admission-Sitzung desselben Legacy-Ablaufs noch lebt. Der Fehler liegt nach Pfad- und nativer Linkmutation in `checkpointBatchLink`. Er ist kein Parserfehler oder geänderter Previewinhalt.

Der erste getrennte Aufbauversuch unter `/private/tmp/cn-asset-delete-native-checkpoint-red-nlsp3qev` hatte noch keinen echten Live-Dokumentdienst installiert und stoppte bereits mit `LINK_WRITE_STALE_DOCUMENT`. Dieser Setupfehler wird nicht als Beleg des Sperrkonflikts gezählt. Sein eigener Ressourcenabschluss besteht ebenfalls.

## Korrektur und noch ausstehende Prüfung

Der enge V1-Executor erhält einen ununterbrochenen äußeren Workspace-/Copy-Kernel-Fence. Vorbereitung, Pfad- und Yjs-Linkänderungen bleiben unter der echten exklusiven Lifecycle-Sitzung; jeder vorhandene Pfad-/Linkreceipt wird wie bisher mit Datei-fsync, Rename und Verzeichnis-fsync gesichert. Danach endet diese Sitzung vollständig. Erst anschließend läuft der unveränderte Projector mit seinem eigenen echten Shared-PG-Lock. Kernel-Fence, ursprüngliche Journalidentität, Finalgraph-/Hash-/Inodeprüfungen und finales `applied` bleiben bis zum Ende gebunden.

Eine bereits vom Caller gehaltene aktive Lifecycle-Lease wird vor ersten Writes mit dem bestehenden Busyfehler abgewiesen. Ihre Abwesenheit erzeugt keine Autorität: echte Lifecycle- und Publikationsguards bleiben obligatorisch. Ein inaktiver alter Async-Kontext wird nicht unnötig gesperrt. Native Original-Move-/Delete-B1-Fences werden nicht verändert. Es gibt keinen allgemeinen Lease-/ALS-/Skip-Bypass.

Vollständiges TypeScript ohne Cache und Scoped-Lint der Korrektur bestehen lokal. Die frische Gegenprobe nach Korrektur und die explizite Recoveryprüfung bleiben zum Zeitpunkt dieses Abschnitts offen. Weder neuer Produktionsbuild noch UI-Abnahme oder Aktivierung werden behauptet.

## Originalartefakte und Ressourcenabschluss

Originalverzeichnis: `/private/tmp/cn-asset-delete-native-checkpoint-runtime-red-og6ox_tx`. Drei tatsächlich gestartete Kinder, keine Timeouts oder Signale. Originalrunner Exit 1, unabhängige Abschlussprüfung Exit 0. Eigene Prozesse/Gruppen, Backends und Schema-OIDs sind geschlossen beziehungsweise entfernt; die bestehende verwaltete Umgebung bleibt erhalten. Äußere Beleg-/Cacheverzeichnisse bleiben bestehen.

| Artefakt | SHA-256 |
| --- | --- |
| `asset-delete-native-checkpoint.ts` | `4b9c15d7375b7566272c752c1d297390fea4d74b94e166e3ab9096b7032b20f0` |
| `manifest.json` | `fe896d63cce9768c8a92e920ea63c664b036bca7c537dec483a3a2d69861a501` |
| `ready.json` | `b452c3612a1d2017118fa61b0c2ed818f94cb1460b005e2b54d6267e45725c4e` |
| `results.json` | `84f317c1127ed504f934d71be9bca0cba01980bec2caa706d743c0fa6095b1d5` |
| `independent-closure.json` | `385af20434dcedbd289ac3329f07b883f6c151d391fd6b375c79beac8558ebd4` |

## Tatsächlicher Folgelauf auf unverändertem Produktcode: 3/3

Root `6179d1c51d12f1a77df23117982e771f4d255f30` und QA `140d327649af80277bcda0e79762fce0cb220d10` binden die Korrektur. Die drei tatsächlichen Varianten PDF/TXT/PNG bestehen mit jeweils Exit 0: Batch `applied`, alle Pfad-/Linkschritte abgeschlossen, physisches Ziel weg, Keep-Dokument unverändert, vollständiger nativer Linkinventarvergleich, exakter erwarteter Markdowntext in Yjs und auf der Platte, kein ausstehender Checkpoint und kein abgewiesener Shared-Lock. Der Originalrunner endet mit Exit 0; die unabhängige Ressourcenprüfung ebenfalls. Die ursprünglichen 180 Sekunden und Erfolgserwartungen bleiben erhalten.

Der erste Folgelauf unter `/private/tmp/cn-asset-delete-native-checkpoint-green-vrsmv7s_` erreicht bereits dreimal tatsächlich `applied`, endet aber dreimal mit Exit 1: Die zusätzliche Testassertion fragt `canonicalContent` am strukturierten nativen Snapshot ab, der dieses Feld nicht besitzt. Dieser Lauf wird ausdrücklich nicht als bestanden gewertet; sein eigener Ressourcenabschluss besteht. Die Testkorrektur liest den echten Markdownserializer und vergleicht zusätzlich unabhängig vorgegebene exakte Sollbytes. Die vorherige Assertion auf den tatsächlichen erfolgreichen Batchabschluss bleibt unverändert. Produktcode, Zeitgrenze, ursprüngliche Daten und alle übrigen Prüfungen werden nicht verändert.

Der korrigierte Nachweis liegt unter `/private/tmp/cn-asset-delete-native-checkpoint-green-fixed-assert-l4j_ik7y`. 6.917 aktuelle Repositoryquellen sind vor/nach dem Lauf gebunden. Kein Kind hat Timeout/Signal, alle drei eigenen Fixturesschemas und Backendidentitäten sind geschlossen/entfernt. Vier vorhandene verwaltete Container und ihre Listener/Gesundheitsprüfungen bleiben unverändert.

| Artefakt des tatsächlichen erfolgreichen Laufs | SHA-256 |
| --- | --- |
| `asset-delete-native-checkpoint.ts` | `c4ced396dd0a3d791c7ef21763b36d4295ad60ff8b214b296052b423f5ee0d75` |
| `manifest.json` | `9ef5c4fb577d8e02d1edfe20e9be28d2cd25d49021960cac6240924ac394854b` |
| `ready.json` | `b6353d00ea8dfdcc8bab878a31c441d9c0720853cefa157a1cf39949fc074497` |
| `results.json` | `201e1de8003181f3008952cc7c69566a77fe5a41336fcdedc924a6b0a227007b` |
| `independent-closure.json` | `05e513a8965a9efebbdd3e6e9751f851e2bdb67c504a75edec592a353f7aaf03` |

Die zusätzliche isolierte Prüfung führt den vollständigen aktuellen Executor mit echten lokalen Dateimutationen, Planer, Kernel-Fence und fsync-Journal aus. Nur die PG-Lifecyclegrenze und fachliche Adapter sind modelliert; jeder PG-Client-/Poolzugriff scheitert. Alle drei Fälle bestehen mit Exit 0 und vollständigem Abschlussmarker: aktive Lease während Mutation / beendete Lease bei Projektion, konkurrierender unabhängiger Kernelzugriff erst nach finalem `applied`-Journal, aktive geerbte Lease vor allen Writes abgewiesen, inaktive geerbte Lease zulässig. Der erste private Pure-Aufbau erreichte noch einen nicht ersetzten SQL-Trashreader und scheiterte; die korrigierte Fassung verwendet genau den bei tatsächlichem Fixture-Rename erzeugten Trashkatalog. Keine Assertion wurde gelockert. Diese isolierte Prüfung beweist keine PG-Locksemantik oder native Yjs-Autorität; dafür steht der getrennte echte Lauf. Die portable Repositoryfassung besteht über `npm run test:files:operation-publication-phase` ebenfalls mit allen drei Fällen, tatsächlichem Exit 0 und vollständigem Abschlussmarker; Scoped-Lint und vollständiges cachefreies TypeScript einschließlich der neuen Testdatei bestehen.

Noch offen sind die explizite tatsächliche Wiederaufnahme desselben Legacy-Batches nach gespeicherten Pfad-/Linkbelegen, Original-Move/Delete-Post-B1-/B2-/ACK-Verlustfolgen, frischer Gesamtbuild und gemeinsame Browserabnahme. Die drei Assetfälle sind kein PDFparser-, HTTP-SDK-, Such-, MCP-Neuanlage- oder Gesamtabschluss. Undo, Review Center und allgemeine Aktivierung bleiben aus.

### Deterministischer Kernelbeleg der portablen Regression

Der zunächst zusätzliche unabhängige Async-Contender allein hatte noch eine Timinglücke: Sein Startsignal plus `setImmediate` bewiesen keinen bereits entschiedenen Sperrerwerb. Diese Annahme ist durch eine echte unabhängige nichtblockierende Python-`flock(LOCK_EX|LOCK_NB)`-Abfrage ersetzt. Ein separat geöffnetes File-Description prüft dieselbe private Lock-Inode; Eltern- und Kind-fstat binden dev/ino/nlink/uid vor und nach dem Versuch. Vor der Publikation müssen die tatsächlich beobachtete Sperre und der weiterhin nicht eingetretene Contender zusammen gelten. Der Helper wird nach tatsächlichem Close ausgewertet; seine 2-Sekunden-Grenze ist keine Domainretry oder verlängerte Dateiaktionsfrist.

Die gehärtete npm-Prüfung besteht wieder mit 3/3 und vollständigem Abschlussmarker. Eine kontrollierte private Kopie des tatsächlichen Executors ohne ausschließlich die äußere `withLock`-Hülle schlägt mit Exit 1 fehl: Der konkurrierende echte Kernelzugriff sieht noch `applying` statt des finalen `applied`-Journals. Alle übrigen Assertionen bleiben erhalten; der Produktcode wird für diese Gegenkontrolle nicht verändert. Private Gegenkontrolle: `/private/tmp/cn-legacy-publication-no-outer-kernel-mutant-49cjpjrs`. Der ursprüngliche Produkt-SHA bleibt `e99befd180360d69ceebf2b137e513f46aef5bc5aa261b6849e131406598efd4`.


## Tatsächliche Legacy-Wiederaufnahme nach verlorenem Shared-ACK

Auf Root `ada376646345e5730d4667609c3bc3e1043a7189` / QA `c557c53c6ed3b61800428e7eae2e0aa45d32cd56` wurde die echte erste erfolgreiche Shared-Lock-Antwort einmal mit EIO verworfen. Zuvor sind Pfad- und nativer Linkschritt tatsächlich angewendet und im fsync-Journal gesichert. Der echte Store setzt `needs_recovery`, gibt die Claim frei und nimmt dieselbe unveränderte Operation mit frischem Principal, Claim und Executor wieder auf. Dies prüft Legacy-Hashjournal-Recovery, nicht Original-Delete-B1/B2 oder HTTP/UI.

Der erste Recoverylauf `/private/tmp/cn-asset-delete-native-recovery-runtime-_se03fp_` endet dreimal rot an einer nicht genauer erfassten Assertion in der zweiten Ausführung; diese Originale bleiben unverändert. Die zusätzliche Diagnose unter `/private/tmp/cn-asset-delete-recovery-diagnosis-outer-pending-ypgp8lx3` endet ebenfalls tatsächlich mit Exit 1, erfasst aber vor allen unveränderten Assertions den konkreten Befund in allen drei Modi: `applied`, 2/2 Schritte, kein Fehler, ein tatsächlicher erfolgreicher Shared-Erwerb, vollständige native Bytes/Vektor/Sequenz/Persistenzzeit unverändert und `pending=false`. Kein weiterer Trashwrite tritt auf. Einziger strenger Counterkandidat ist die tatsächliche Checkpoint-Metadatenanweisung SHA `e8226b1684d4ed7001f961cb2b02911a0e8c8059e219199657927777900322e8`: Ihr `CASE WHEN document_sequence = $6` wurde fälschlich als Zuweisung an `document_sequence` gezählt. Tatsächliche SET-Ziele sind ausschließlich `checkpointed_at`, `checkpoint_sequence`, `canonical_hash`, `serialized_hash`, `degraded`. Der Diagnose-Exit bleibt rot; Ressourcenabschluss ist unabhängig erfolgreich.

Die enge neue Testfassung unterscheidet echte obere SET-Zielspalten von RHS-Prädikaten. Der eigenständige Offline-Gegencheck bindet exakt die tatsächlich ausgeführte SQL-Anweisung, beweist den alten Fehlalarm und erkennt echte Zuweisungen an Yjs-Bytes/Vektor/Sequenz sowie INSERT weiterhin. Unbekannte Zielsyntax scheitert ausdrücklich. Keine Zeilenzahl wird zum Herausfiltern benutzt. Alle ursprünglichen Domainassertions einschließlich leerer Content-/Trash-Schreiblisten, positiver Shared-/Pending-Abfragen, Originaljournal, vollständiger nativer Fakten und 180 Sekunden bleiben erhalten. Der Helper ist vollständig in die versiegelte Kinddatei eingebettet.

Der frische Lauf `/private/tmp/cn-asset-delete-recovery-corrected-runtime-dne6qomb` besteht tatsächlich **3/3**, Originalrunner Exit 0, ohne Signale/Timeouts; alle nachfolgenden Assertions und `finishClaim` schließen ab. Neuer und erster Trash-ID/Payload bleiben identisch, Native-Bytes/Sequenz unverändert, ursprüngliche Plan-/Autorisierungsstrings und angewandte Journalreceipts exakt. Nur deklarierte Finalisierungsfelder des veränderlichen Legacy-Journals dürfen sich ändern. Der unabhängige Ressourcenabschluss besteht ebenfalls. Produktcode und Deadline wurden für diese Testkorrektur nicht verändert; vier verwaltete Dienste bleiben unverändert.

| Lauf / Artefakt | SHA-256 |
| --- | --- |
| Diagnose `ready.json` | `c031b5fe1c712bfbaa696207638f865ea91b2b8281b40d459d6ce5dc1e965f38` |
| Diagnose `results.json` | `8e398c7a90d73acef674a1219d6e835c84dfd81e69506709cda8877216fecf72` |
| Diagnose `independent-closure.json` | `1cb97d3b11cc800be657ee660e4a2f44376e6401edfc5874666896745778cafb` |
| Korrigiertes Kindskript | `55092cd638f8e5e3492db93f66882c9169e9205c3547031b19a61f7ae1e2926d` |
| Korrigiert `ready.json` | `39c07bfd9a8b7e50db06aa5a32784ddb0ba9ebed4f11a5d231b7e7dde14ca962` |
| Korrigiert `results.json` | `de5155e25a96fbf93c58b0775dea73bc3c957cd082127d4d4196e073b8a41bbd` |
| Korrigiert `independent-closure.json` | `3ecd5876a4789a497634f02c74e4bd631c2662a5cddb1dbf11fd808c02b093b4` |

Eine zusätzliche Sourceprüfung zeigt eine getrennte noch zu prüfende Grenze: Nach bestätigtem Checkpoint-COMMIT und anschließender fehlgeschlagener Share-Synchronisierung können Datei und Sequenz aktuell sein, während der Projektionsreceipt noch nicht finalisiert ist. `checkpointBatchLink` berücksichtigt derzeit nur Hash und Sequenz. Der vorhandene mechanische Projektionsfencetest bildet einen solchen Finalisierungsfehler ab; der echte Legacy-Batch-Durchstich und gegebenenfalls dessen enge Korrektur bleiben offen. Der oben erfolgreiche Shared-ACK-Fall beweist diese spätere Phase nicht. Frischer Gesamtbuild, gemeinsame Transport-/Browserabnahme und übriger API-/SDK-/Such-/Skill-/PDF-/Sandbox-Auftrag bleiben offen.

## Unterbrochene Finalisierung nach bestätigtem Checkpoint-COMMIT

Die erste Folge (`68230`, `/private/tmp/cn-asset-delete-finalization-runtime-red-ilh7b8r4`) scheiterte am Testobserver und bleibt ein fehlgeschlagener Aufbau. Die anschließende einzelne PDF-Diagnose (`67481`, `/private/tmp/cn-asset-finalization-origin-single-pdf-bk_2jlcd`) grenzt den Fehler ein: Derselbe Poolclient führte nach dem bereits erfassten Checkpoint-COMMIT weitere echte COMMITs aus; der Observer verlangte dort erneut einen noch nicht vorhandenen Commitbeleg und warf vor dem vorgesehenen EIO. Die neue Testfassung SHA `280ac9ba7f58755e233aad0d0018fa83632e99352f3017f0f87d8ff60c583afa` beobachtet deshalb ausschließlich den ersten tatsächlichen COMMIT der zuvor gebundenen Metadaten-/Pending-Receipt-Transaktion. Sämtliche Domainassertions und die 180-Sekunden-Grenze bleiben unverändert. Diese Testkorrektur ist kein Produktfix.

Der danach tatsächliche Dreifachlauf `/private/tmp/cn-asset-finalization-targeted-commit-red-c81eopw5` reproduziert den Produktbefund für PDF, TXT und PNG: Originalrunner `61293` und alle drei Kinder enden mit Exit 1, ohne Signal oder Timeout. Nach bestätigtem Checkpoint-COMMIT und absichtlich unterbrochener Finalisierung liefert die Wiederaufnahme bereits `applied`, 2/2 Schritte und keinen Fehler. Der direkt gespeicherte Zustand zeigt jedoch in allen drei Fällen `documentSequence = checkpointSequence = 1`, physische Bytes gleich dem serialisierten Hash, `projectionFinalized=false`, Receipt `finalized=0` und `pending=true`. Die vollständigen nativen Fakten bleiben gegenüber dem Fehlerzeitpunkt identisch; Content-/Trash-Schreiblisten sind leer. Der Batch überspringt die noch erforderliche Finalisierung. Die unabhängige Abschlussprüfung `20542` endet mit Exit 0; sie bestätigt den Ressourcenabschluss und deutet den Domainlauf nicht in einen Erfolg um.

Die enge Produktkorrektur in `checkpointBatchLink` behält die bisherigen Native-/Dateibytesprüfungen und Sequenzgrenzen bei. Zusätzlich werden der tatsächliche Receiptstatus über `loadCollaborationProjectionStatus` und ein verbleibender Rückstand über `hasPendingCollaborationProjection` berücksichtigt. Eine unbestätigte Receipt oder ein Registryrückstand führt damit erneut durch den vorhandenen Materializer; `pending=false` allein gilt nicht als Finalisierungsbeleg. Die bestehenden Materializer- und Quarantänegrenzen werden weiterverwendet.

Root hat die isolierte Prüfung mit zwölf Fällen tatsächlich ausgeführt (`5589`, Exit 0, zwölf bestandene Fälle und positiver Abschlussmarker; Executor-SHA wie unten). Sie führt die vollständige aktuelle Executorquelle mit echten Yjs-, Dateisystem-, Pfad- und Hashfunktionen aus; ausschließlich State-/Status-/Pending-SQL und der Materializer sind modelliert, sämtliche PG-Client-/Poolzugriffe gesperrt. Drei Fälle prüfen zusätzlich die unveränderte Identität weitergereichter Status-, Pending- und Materializerfehler. Dafür liegt eine tatsächliche Terminalausführung vor, kein separater gespeicherter Originallog oder unabhängiger PG-Nachweis. Die vollständige cachefreie Typprüfung besteht mit 8 GiB Node-Heap (`95388`, Exit 0); ein vorheriger Versuch mit dem Standardheap endete tatsächlich mit Speicherfehler/Exit 134. Scoped-Lint (`37689`) und die unveränderte Drei-Fall-Sperrphasenprüfung (`55676`) bestehen ebenfalls mit Exit 0. Der zusätzliche ältere `workspace-operation-batch-executor-test.ts` endet bereits beim ersten Batch mit `failed/BATCH_EXECUTION_FAILED`; er injiziert seinen eigenen Checkpointadapter und erreicht den korrigierten Helfer nicht. Die gesonderte Baselineursache ist noch zu klären; dieser Lauf wird nicht als bestanden gezählt. **Der frische echte PG18-Folgelauf bleibt offen**; Build-, Browser-, HTTP-/SDK-, PDFparser- oder Gesamtabnahme werden hier nicht behauptet. Dateiaktions-Undo, Review Center und allgemeine Aktivierung bleiben aus.

| Artefakt | SHA-256 |
| --- | --- |
| Gezieltes Kindskript: `/private/tmp/cn-asset-finalization-first-commit-only-_nyynzrd/asset-delete-native-checkpoint-finalization-first-commit-draft.ts` | `280ac9ba7f58755e233aad0d0018fa83632e99352f3017f0f87d8ff60c583afa` |
| Roter Dreifachlauf: `/private/tmp/cn-asset-finalization-targeted-commit-red-c81eopw5/results.json` | `af280209bc14cfa29a3e8bd8837ff92de9d4064cdf7c52cb0c7ddebe94d6acf8` |
| Unabhängiger Abschluss: `/private/tmp/cn-asset-finalization-targeted-commit-red-c81eopw5/independent-closure.json` | `0c44debc4d0659beb2ba4fcf4bebb32485aeb6e51f9a04245ca9092dba5b9702` |
| Korrigierter Executor: `app/lib/files/workspace-operation-batch-executor.ts` | `31a142664a54e570f23af69678f3f1ec7c1b14e7d61c68f0d4799be763ef0f7c` |
| Isolierte Zwölf-Fall-Prüfung: `scripts/workspace-operation-batch-link-checkpoint-test.ts` | `254d4f4f917e1c73098f73802bc2ee29f9bf4850dc0e9bde962a3499fa2c7c46` |

## Unveränderte echte Finalisierungs-Gegenprobe nach Korrektur: 3/3

Auf Root `fb8ede68a6654ce4209c979e9dcb374f1b5eca66` / QA `69d7c1f880280f04c35d7b6fe6e7d6fc8eb108f8` besteht dieselbe vollständige Kindstestquelle SHA `280ac9ba7f58755e233aad0d0018fa83632e99352f3017f0f87d8ff60c583afa` für PDF, TXT und PNG. Originalrunner `61543` und alle drei Kinder enden tatsächlich mit Exit 0, ohne Timeout oder Signal. Die ursprünglichen 180 Sekunden je Kind, sämtliche Fehlerpunkte und Erfolgserwartungen bleiben erhalten. Der frische äußere Runner liegt unter `/private/tmp/cn-asset-finalization-checkpoint-fix-outer-pending-svd67qfx`; vier CJS-Helfer und Test-ENV sind bytegleich zum roten Dreifachlauf. Der Sealer bindet 6.920 aktuelle Quellen, neue Regression, native Artefakte und die tatsächlich sauberen Root-/QA-/Control-Plane-Heads.

Vor der Wiederaufnahme ist der Receipt im neu erworbenen echten Kernel weiterhin nachweislich offen. Danach liefert der tatsächliche frische Store/Claim/Executor jeweils `applied`, 2/2 Schritte und keinen Fehler; der eigene Shared-Erwerb ist jeweils positiv (`finalShared=1`), ebenso die echte Pending-Abfrage. Alle Receipts sind finalisiert und `pending=false`. Vollständige native Bytes, Vektor, Sequenz und Persistenzzeit, bereits korrekte Datei einschließlich Inode/Bytes, vorhandene Revisionen und derselbe Papierkorbeintrag bleiben beim Resume unverändert. Content- und Trash-Schreiblisten sind leer. Es entsteht kein zweites Löschen, keine zusätzliche Revision oder neue Operationsidentität.

Die unabhängige Prüfung `64316` endet tatsächlich mit Exit 0: Quellen vor/nach identisch, alle eigenen Prozesse/Gruppen und Backend-/Schemaidentitäten geschlossen oder entfernt, vier vorhandene verwaltete Dienste mit Listenern und Gesundheitsprüfungen unverändert. Die historischen roten Originale bleiben unverändert. Äußere Belegverzeichnisse bleiben zur Nachprüfung erhalten. Dieser Abschluss gilt für die echte lokale Legacy-Dienstfolge; Original-Move/Delete-Gesamtregressionen, neue HTTP-/Browserabnahme und Gesamtbuild bleiben erforderlich. PDFparser, allgemeine API/MCP-Neuanlage, Suche, externes SDK, Standard-Skill und vollständige Sandboxmatrix sind damit nicht abgenommen. Undo, Review Center und allgemeine Aktivierung bleiben aus.

Der zusätzliche ältere modellierte Executor-Test bleibt ausdrücklich rot. Root hat ihn mit exakt unverändertem ursprünglichem Test und vollständigem Executor vor dem Receiptfix wiederholt (`6749`, Exit 1, gepinnt auf `51e11b98a0463aa4bbef3e1fc554769e024ccacc`): derselbe erste Fehler in Zeile 131 (`failed/BATCH_EXECUTION_FAILED` statt `applied`). Die Dependencies stammen dabei aus dem aktuellen Checkout; dies ist keine vollständige historische Checkoutabnahme. Der Test injiziert seinen eigenen Checkpointadapter. Die Baseline ist damit ebenfalls rot, die konkrete Ursache noch offen; keine Assertion wurde gelockert und kein alter Test als grün ausgegeben. Privater Loader: `/private/tmp/cn-legacy-batch-51head-baseline-offline-qdvauffe/run-51head-baseline.cjs`, Originallog SHA `879496b4689513512d086369b60c524e978dcd00e73eeecad404d137e628f934`.

| Artefakt des tatsächlichen erfolgreichen Dreifachlaufs | SHA-256 |
| --- | --- |
| `ready.json` | `1c8c5e7ad917a0df57ae998b7c1c3a2d6b4ecf7604f9535dcc37833de2efb801` |
| `results.json` | `572f2476a2ef5aedd1fd9e4a4c9c8557280e95524b8a16f2eae81f51a69526b4` |
| `independent-closure.json` | `3f78f8c9684fcb5ea1ce39eec834673e137352461c3b8b1aad414c9b22b7eff0` |
