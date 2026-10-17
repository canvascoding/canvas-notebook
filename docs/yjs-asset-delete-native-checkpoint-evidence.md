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
