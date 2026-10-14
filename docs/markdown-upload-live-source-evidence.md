# I-03a: laufende Uploadquelle und dauerhafter Abbruch

Status: **Gemeinsame Upload-Lifetime abgeschlossen; nativer Staging-Writer I-03b und erste Zielveröffentlichung bleiben offen.** Autorcommit `c6802792530e35383a558b00d13eb6bc1a1d71ee`, sechs Source-/Testdateien auf `737ab428d`.

## Verhalten

GET, Chunk und Complete halten eine tatsächliche gemeinsame Session-Kernelsperre. Dateiaktionen halten zusätzlich eine exklusive per-file Sperre; unterschiedliche Dateien können parallel laufen. Cancel und Cleanup verwenden eine exklusive Session-Sperre und warten dadurch auch auf Writer in einem anderen Prozess. Eine Shared→Exclusive-Hochstufung findet nicht statt; die bestehende lokale FileQueue bleibt innerhalb der Session-Sperre.

Cancel bzw. belegter Ablauf veröffentlichen vor der Entfernung ein unveränderliches gebundenes Terminaljournal außerhalb des Upload-Stagings. Ein verlorener Reply oder Helperabbruch macht die Quelle danach nicht wieder verfügbar. GET nach Cancel liefert jetzt `UPLOAD_CANCELLED`/409 statt `UPLOAD_NOT_FOUND`/404. Fehlende oder unlesbare historische Manifestreste bleiben konservativ erhalten; die frühere allein auf Verzeichnisalter beruhende 24-Stunden-Entfernung entfällt. Ein solcher Rest erhält dadurch keine erfundene Identität oder Löschfreigabe.

[withCurrentWorkspaceUploadFile](../app/lib/files/workspace-upload-live-source.ts) ist ein noch ungenutzter interner Anschluss für die spätere native Mutation. Er verbindet aktuelle Originalquelle, Byte-/Profilbindung und historischen I-02-Versuch. Upload-/Actor-/Workspacefelder sind Intent und keine Principal- oder Native-Grants. Der spätere Consumer muss seine vollständige native Operation einschließlich B-/C-Abschluss als Callback-Promise zurückgeben. Beliebige abgetrennte SQL-Promises werden hier nicht beobachtet.

Die privaten Session-/File-FDs bleiben über Callback, Helper, ausstehende Facadeaktionen und DATA-Close gehalten. Benannte Root-/Control-/Sidecaridentitäten werden auch am tatsächlichen Close-Await-Rand erneut geprüft. Ein Closefehler bleibt erhalten; eine zusätzliche begrenzte Closeprüfung benutzt ausschließlich denselben eigenen Handle. Schon laufende Filecallbacks werden vor Parentabschluss geschlossen; ein verspäteter Erwerb beginnt nach Parentreturn keinen neuen Consumer.

## Tatsächliche Befunde und Prüfung

Root reproduzierte vor dem finalen Fix zwei Fehler mit echten privaten FS-/Prozessgegenfällen: Austausch des benannten Sidecars während des letzten Close-Await wurde akzeptiert; SIGKILL nach dem Anchor-fsync hinterließ einen dauerhaft nicht wiederaufnehmbaren Namespace. Die ursprünglichen negativen Belege bleiben erhalten. Die Korrektur prüft den benannten Sidecar auch nach Handleclose und nimmt ausschließlich den exakt zu Root/Control gehörenden privaten fsync-Anchor unter INIT-EX wieder auf. Mehrdeutige, fremde oder nicht attribuierbare Reste bleiben unverändert.

Der unabhängige Source-Review führte außerdem zu präzisen Gegenfällen für parallele Fileerwerbe und abgetrennte File-Lifetimes. Die finale Source reserviert vor dem ersten Await, beobachtet die vollständige tatsächliche File-Promise und prüft nach verzögertem Erwerb erneut die Consumer-Lifetime. Der abschließende Review hat keine weiteren konkreten Findings.

Root bestätigt **22/22 tatsächliche FS-/Prozessfamilien** aus [workspace-upload-live-source-test](../scripts/workspace-upload-live-source-test.ts), scoped ESLint, Pythonkompilierung und die exakten finalen Autorenbytes. Die Matrix umfasst zwei reale Prozesse, Gleichdateiausschluss, unterschiedliche parallele Dateien, Cancel vor/nach Writer, TTL nach Wartezeit, echte SIGKILL-Punkte, Terminal-/Anchor-Recovery, Sidecaraustausch während Close, unawaited Facades, verzögerten Erwerb und begrenzten Closefault. Faultinjektionen behaupten keinen spontan aufgetretenen Datenträgerfehler. Nach Integration bestätigt Root außerdem vollständiges TypeScript mit 8 GiB und `--incremental false` sowie alle vier bestehenden Uploadsuiten, einschließlich 100 paralleler Dateien und zehn tatsächlicher Handler-Serialisierungen mit ersetzten IO-Grenzen. Der Autor bestätigt dieselben fokussierten Prüfungen auf seiner separaten Basis.

Root bestätigt sechzehn vollständige alte Kernel-/Snapshot-/Original-/Import-/Auth-/Reader-/Uploadroute-Module bytegleich zur Basis und die AST-extrahierten Körper von `withFileLock`, `writeSession` und Office-Persistenzcallback. Der tatsächliche Root-Impact vor Integration bewertet Cleanup als HIGH mit einem direkten und vier insgesamt betroffenen Callern; Web/Mobile/MCP-Reichweite bleibt Teil der Prüfung. Der Index ist keine vollständige dynamische Routeabnahme.

Produktfreezes: TS `16c553149f7532eff1f45a08c797b4f277e4c81ec147cc36734759e38c44f042`; Python `8489f2f5547d0e214b9d66b1ca9fef9d656cee81e0a56bea7c7b54db3b699f50`; Service `56ebf2adb0b75ca0baef1b0e571123ee4a82e09729f4d16d3d4245c983df7f94`; Test `a1be21cb89ed4a71d4c7edc378085f831b24f822de813ad89e770292dc159fc5`.

Diese Matrix belegt weder Auth-/PG-/Office-PG-Verhalten noch Browser-, Native-Mobile- oder Produktionsabnahme. Kein nativer Importwriter, Targetpublish oder Sessiongate wird aktiviert. I-03b, I-04 und die gemeinsame [Create-/Paste-/Vollimportabnahme](./markdown-create-paste-full-import-integration-plan.md#9-abnahmefälle) folgen als einzelne Gates.
