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
