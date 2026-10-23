# I-02: dauerhafter privater Markdown-Uploadversuch

Status: **Inaktive Grundlage abgeschlossen; echter Importwriter und Erstveröffentlichung bleiben offen.** Autorcommit `e5fac532e9050cafbaf9ca2a70d3b02960ac80cd`, exakt drei neue Dateien.

## Vertrag und Grenzen

Ein privater per-file Store außerhalb der alten Upload-Cancelnamespace hält unveränderliche Originalbytes und ein gebundenes Birthrecord. Ein tatsächlich vererbter DATA-Verzeichnis-FD und relative Python-`dir_fd`-Operationen prüfen Namespace, Owner/Modes, NOFOLLOW, reguläre Dateien, nlink1, Inodeprofil und Hash. Die Quelle ist auf 5 MiB begrenzt. Diese Opaque-Snapshotgrenze verspricht noch keine UTF-8-/Markdown-Verarbeitung, Öffnungsgröße oder native 1-MiB-Updatefähigkeit.

Der Record bindet ausschließlich bekannte skalare Request-/Actor-/Session-/Workspace-/Quell-/Zieldaten. IDs sind **Intent**, keine Authentisierung oder Grants. Unveränderliche `retained`- und `abandoned`-Marker bleiben private Recovery-/Tombstonezustände, keine Native-/Completed-Meilensteine. Partielle und unbestätigte Objekte bleiben konservativ erhalten; diese Grundlage führt keine Garbage Collection oder pauschale Löschung durch.

Eine tatsächliche prozessübergreifende File-Fence bleibt über den Callback, serialisierte Helperaktionen, vollständig beobachtete Facade-Promises und DATA-FD-Close gehalten. Der benannte Root wird auch nach Close geprüft; Primary- und Abschlussfehler bleiben aggregiert. Alle Helper und ausstehenden Aktionen schließen vor Release. Bereits geschlossene Facades können keine weitere IO beginnen.

Historische Snapshots ersetzen den ursprünglichen Upload nicht. `readSource` prüft dessen tatsächlichen aktuellen Zustand erneut und verweigert Missing/Cancel/Expired/Completed/Changed bzw. Abandoned. Diese Beobachtung ist punktuell; ein späterer aktiver I-03-Consumer muss seinen aktuellen Upload-/Cancelvertrag und echte Rechte separat halten. Es gibt keine Route, keinen Auth-/Native-Commit und keine Veröffentlichung im Zielworkspace.

## Konkrete Befunde und Abnahme

Zwei unabhängige Source-Reviewer finden zunächst parallele widersprüchliche Terminalmarker und den DATA-Close außerhalb der File-Fence. Tatsächliche Zwei-Helper-/Prozessgegenfälle beweisen beide Fehler sowie fehlende abschließende Rootprüfung. Die Folgeprüfung findet den Close-Await-Rand und verlorene Primaryfehler; tatsächliche Close-Observer bestätigen auch diese Gegenfälle. Ein korrupter Manifest-MIME-Objektwert gelangt zunächst in das private Record; bekannte Scalarformen werden anschließend vor der ersten Kopie geprüft. Alle Gegenfälle bestehen nach den engen Korrekturen. Die abschließende unabhängige Review findet keine weiteren konkreten Befunde.

Root bestätigt auf den integrierten unveränderten Bytes **34/34** tatsächliche FS-/Prozessfamilien aus [workspace-markdown-upload-attempt-test](../scripts/workspace-markdown-upload-attempt-test.ts). Dazu gehören gleiche/differente Dateien in zwei unabhängigen Nodeprozessen, echte Kernel-fences, SIGKILL-/Lostanswer-Grenzen, gezielte File-/Directory-fsync-Faults, Source-/Parent-/Entry-/Store-/DATA-Austausch, Fremdrecords, Inode-ABA, Hardlinks, FIFO/Symlink, Cancel/Expiry/Completed, Root `.` und nullable/fehlendes MIME. Die fsync-Faults sind gezielte Fehlerinjektion; sie behaupten keinen spontan aufgetretenen Datenträgerfehler. Unawaited Rejections werden im echten Kindprozess ohne externe Unhandled-Handler geprüft. Alle eigenen Worker/DATA schließen im erfolgreichen Lauf.

Root bestätigt außerdem vollständiges TypeScript mit 8 GiB und `--incremental false`, Lint2, Pythonkompilierung ohne Cacheartefakt sowie drei exakte Autorendateien. Zwölf vollständige alte Upload-/Office-/Cancel-/Kernel-/Original-/Import-/Route-Module sind bytegleich zur Basis `9ba279b43`; deren vier vorhandene Uploadsuiten bestätigt der Autor zusätzlich. Der Rootlauf wiederholt diese unveränderten IO-Suiten nicht. Es gibt keinen Auth-/PG-/Browserbeleg aus dieser FS-Matrix.

Produktfreezes: TS `944685d1adcb3741eebc0fc1e36d174fcfb629944c53b9935fe05fc8074c165f`, Python `22dc2b46ed0bef4a405d08b56154db7ebe0eece9f017636e23ae272715bdc4f3`; Test `a5965926f3dcf266ce25b3231913ef87653ddd176f8cb26d23225da027024700`. Der nächste Schritt ist ausschließlich I-03 aus dem [Create-/Paste-/Vollimportplan](./markdown-create-paste-full-import-integration-plan.md#8-umsetzung-in-abgeschlossenen-schritten); I-04/05 bleiben eigene Gates.
