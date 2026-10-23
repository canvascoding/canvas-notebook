# Native Copy: ursprüngliche Ablage und gemeinsame Zielordner

## Lieferumfang und Grenze

Der bestehende `WorkspaceOperationStaging` speichert native Copy-Aufträge als private V2-Stage im bisherigen Auftragsverzeichnis. Der ursprüngliche C2-Request, der C1-Plan, die tatsächlichen vorbereiteten Dateisystembelege und sämtliche ursprünglichen nativen Source-/Destinationzustände bleiben gemeinsam gebunden. Die bisherige V1-Ablage wird nicht ersetzt.

Der neue `loadNativeCopyByOperationId` findet den ursprünglichen Auftrag auch vor einem bestätigten ersten Journalheader. Er liest ein begrenztes Manifest über gehaltene Directory-/Dateideskriptoren und verwendet dessen ursprüngliche Identität. Ein während des Lesens gleichartig neu angelegtes Verzeichnis, Symlinks, Legacy-Daten, abweichende Operation-IDs oder korrupte Payloads werden nicht als ursprünglicher Auftrag übernommen. Nur ein anfänglich sicher fehlendes Auftragsverzeichnis ergibt `null`. Der Reader liefert Daten und erteilt keine aktuelle Ausführungsberechtigung.

Mehrere vorbereitete Kopien dürfen gemeinsame neu angelegte Zielordner verwenden. Der mechanische Shared-Parent-Vertrag bindet dafür jeweils das unveränderte Producer-Original, dessen tatsächliche Veröffentlichungsquittung und den ursprünglichen Parent-Birth-Beleg. Ein Consumer übernimmt diese Quittungen nicht als eigene Geburten. Der ausführende Koordinator muss vor Verwendung die ursprünglichen Journal-/Path-/Parentbestätigungen prüfen; die Datenstruktur ersetzt diese Prüfung nicht. Projektionslose Auswahlen dürfen die belegten Ordner beobachten, erzeugen aber selbst keine physischen Ordner oder Markdownprojektionen.

Dieser Baustein ist noch kein Nachweis für den integrierten Copy-Owner, HTTP-/Agentenanbindung, Metadatenpflege oder eine vollständige Datei-/Link-/SDK-Abnahme. Dateiaktions-Undo und Review Center bleiben aus. Es gibt keinen Produktionsrollout und keinen neuen Container.

## Tatsächliche Prüfungen

Der abschließende einzelne serielle Dateilauf endet mit tatsächlichem Exit 0:

- Native V2-Stage und Operation-ID-Recovery: 15/15.
- Unverändertes bisheriges V1-Staging-Programm: Exit 0.
- Unveränderte vorbereitete Copy-Fälle: 33/33.
- Zusätzliche Shared-Parent-Fälle: 9/9.

Keine Fehler, Skips oder abgebrochenen Tests. Scoped ESLint und die Diffprüfung bestehen. Die vollständige cachefreie TypeScript-Prüfung mit 12-GiB-Heap endet im anschließenden Integrationsstand ebenfalls mit Exit 0; spätere Owner-/HTTP-Änderungen benötigen ihre eigene erneute Prüfung.

Der erste externe Runner startet wegen der Darwin-Unixsocket-Pfadlänge des TSX-CLI keine Tests und endet mit Exit 1. Die ursprünglichen negativen Logs bleiben erhalten. Derselbe Produktstand wird danach mit `node --conditions=react-server --import tsx` ohne CLI-IPC geprüft. Typkorrekturen im abschließenden Stand versehen ausschließlich Mockparameter mit konkreten Typen und verwerfen ausdrücklich Projektionsdateien in einem physischen Payload; keine Laufzeitprüfung wird gelockert.

Originaler finaler Bericht: `canvas-copy-opid-final-1jb0k0y_/results.json`, SHA-256 `6a1bf397768047781c5880e0dd14950625ee565ad7bf2ea362b5f380e8ccb2f1`. Die unabhängige frische Abschlussprüfung `canvas-copy-opid-independent-closure-1tqb6_mt/closure-report.json`, SHA-256 `35aece98c501c7eed4f9d2fdbdbedf93a1115f37db7b016c036aaf561375cac6`, bestätigt unveränderte Originalberichte und zehn unveränderte Sourcepins. Alle elf bekannten eigenen Prozessidentitäten und ihre Gruppen sowie sämtliche exklusiven TMP-/Cache-Wurzeln sind geschlossen beziehungsweise entfernt. Gemeinsame fremde TSX-Caches werden nicht gelöscht.

Die vorhandene Klasse hat laut vorheriger GitNexus-Wirkungsanalyse HIGH-Reichweite mit 14 direkten, 75 gesamten Abhängigkeiten und zwei Abläufen. Das wurde vor der Änderung berichtet. Neue Symbole sind im vorhandenen Index nicht erfasst; eine leere Change-Auswertung ist kein Nullrisikonachweis. Der Anschluss ist additiv und durch die unveränderte V1-Regression mitgeprüft.
