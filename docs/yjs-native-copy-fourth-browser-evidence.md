# Vierter Copy-Browserlauf und native Projektionsereignisse

Stand 17. Oktober 2026. Der unveränderte originale Copy10-Lauf auf Root `0e67d8c0e0f2ce377106c11077eec28334af1a2a` / QA `1ba15d31ba11cebd80361efcc52baf3c3d52953b` endet mit tatsächlichem Exit1: **5/6 native Copyfälle bestanden**, ein mobiler Recoveryfall fehlgeschlagen. Die anschließenden Origin2- und UndoOFF2-Fälle sind nicht gestartet. Der Gesamtauftrag und die Copy-Abnahme bleiben offen.

## Neue Originalbelege

- Frische Quellenprüfung23670 Exit0; Bericht-SHA `6abdb476431ed7034ec59739049be32f8699edba3a098ee0b254ec7095fd8bfd`.
- Originaler neuer Produktionsbuild57714 Exit0; privater Buildroot `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-build-PMfvMj`.
- Unabhängige Artefaktprüfung56750 Exit0; Bericht `/private/tmp/canvas-copy-ui-native-tree-pending-1hw_p1u0/artifact-report.json`, SHA `412977a272aa861aa5c4a1b66cb0a476e2acc8f19608bcd7249ffb9d998ecab1`.
- QA-Quellenfingerprint `2a53e30db544d07281261228eacd71c9ec4fae8183280f1759b11a9207b51201`; Buildfingerprint `dde55bbe215a6471664200c6886faaba7d483b60e5f3c40cf6c5c3a70cc0f991`.
- Originalruntime22706 Exit1; neuer eigener Fixtureroot `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-tAYiIs`.
- Frische passive Baseline `/private/tmp/canvas-copy-ui-native-tree-pending-1hw_p1u0/baseline.json`, SHA `1b53df77cfe012414f8b1bd738f9ae7f40d12ce66d4c24af97a56208be56c98f`. Eine Stichprobe, keine vollständige Prozessüberwachung.
- Originaler unabhängiger Postcheck23354 Exit1; Bericht `/private/tmp/canvas-copy-ui-native-tree-pending-1hw_p1u0/postruntime-report.json`, SHA `84657ed011d0733838c1b4996c8552ad333ce9ad2cac1b7fe3ffe90dd6b9baaa`.

Der Postcheck bestätigt unveränderte Quellen-/Artefaktbindung, geschlossene beobachtete eigene Prozesse/Gruppen/Ports, keinen Runtime-Lock, keine Backends in beiden eigenen Datenbanken sowie vier unveränderte gesunde verwaltete Dienste und drei HTTP200. Beide Datenbanken und DATA/TMP sind beim roten Originalabschluss absichtlich erhalten. Ihre getrennte exakt eigene Bereinigung ist ein eigener nachfolgender Nachweis; das originale rote Ergebnis wird dadurch nicht verändert.

## Ergebnis und eingegrenzter Fehler

Alle drei Desktopfälle bestehen. Mobil bestehen manuelle native Kopie mit nachfolgender isolierter Kopiebearbeitung sowie die gemischte ordnerübergreifende Kopie einschließlich tatsächlicher Linknavigation zum nativen Ziel, bytegleicher PDF und historischer Statusabfrage nach legitimer Kopiebearbeitung. Der vorherige mobile Linkfehler ist auf diesem neuen Lauf nicht mehr vorhanden.

Der mobile Recoveryfall erreicht die wiederhergestellte Kopie und den gemeinsamen Titel. Die Heartbeatprüfung in Zeile468 besteht diesmal. Anschließend scheitert die unveränderte Zeile469: `adds` ist2 statt des vorherigen Werts1. Null Retries, originale Deadlines, ein Worker und sämtliche drei gewählten Specargumente bleiben unverändert.

Die offline aus dem erhaltenen Trace und der tatsächlichen Projektionsdatei bestimmte Zeitfolge spricht stark für eine verspätete erste physische Projektion:

| Beobachtung | Relative Tracezeit |
| --- | --- |
| Recovery mit erstem Add bestätigt | ungefähr674073ms |
| Projektionspfad liefert weiterhin ENOENT/404 | 676094ms |
| Historischer Replay abgeschlossen | 681599ms |
| Physische Projektionsdatei entsteht | ungefähr697657ms |
| Files-Baum wird erneut angefordert | 698222ms |
| Auth-Erneuerung mit neuer Watcher-ID | ungefähr709786ms |
| Heartbeat besteht, danach Adds2 | 710062ms |

Die erhaltene Datei hat Inode195291702 und Birthtime1792233650.7169085. Die Umrechnung verwendet die absoluten Zeiten der Traceantworten. Die Dateigeburt liegt etwa16Sekunden nach dem historischen Replay und12Sekunden vor der Auth-Erneuerung. **Die WebSocket-Framepayloads sind nicht im Originaltrace gespeichert.** Die zweite Meldung ist deshalb nicht unmittelbar einem Producer zugeordnet; die genaue Ursprungsaussage bleibt eine starke Inferenz aus Zeitfolge und Quellpfad.

Der Quellpfad besitzt den passenden Fehler: `FileWatcherService.determineEventType` behandelt jedes rohe FS-`rename` bei vorhandener Datei als `add`. Der Kopierabschluss hat die native Datei bereits einmal veröffentlicht. Der Checkpoint selbst veröffentlicht korrekt `change`; der historische Copy-Finalizer besitzt `mutations: []`. Die periodische Projektionswiederaufnahme kann einen dauerhaften Sequenz0-Klon erst später auf die Festplatte projizieren.

## Enger Produktfix

Der neue `classifyWorkspaceFilesystemEvent` verwendet ausschließlich den bestehenden begrenzten Namespace-Lesefence `withNativeWorkspaceFilesRead`: exakter Pfad, höchstens ein Eintrag, aktuelle Workspace-/Organisationsbindung und endgültiger Katalogvergleich. Keine Yjs-Binaries, Markdownserialisierung, Initialisierung oder Mutation werden benötigt.

Bei initialisiertem beziehungsweise verlorenem nativen Zustand werden rohe physische Anlage, Ersetzung und Entfernung als `change` ausgegeben. Eine Projektions-Inodeversion wird entfernt. Gewöhnliche Dateien, Assets, ausdrücklich pristine Registrierungen und tatsächliche Verzeichnisereignisse behalten ihre Ereignisse. Explizite fachliche Copy-/Create-/Delete-/Rename-Meldungen werden nicht durch diesen Klassifizierer geleitet.

Der produktive Watcher-Singleton bindet den Reader ein. Der rohe FS-Callback prüft seine eigene Watcher- und Subscriptionidentität vor und nach dem asynchronen Read. Ein unsicherer Read invalidiert Caches und protokolliert ausschließlich `FILESYSTEM_AUTHORITY_UNAVAILABLE`; er erfindet weder Geburt noch Löschung und erzeugt keinen unbehandelten Promisefehler. Der bestehende pauschale FS-Stat-Catch verschluckt diese Authorityfehler nicht.

GitNexus meldet vor der Änderung CRITICAL für den Watcher mit22 direkten/326 insgesamt betroffenen Stellen; die gezielten Aufrufe für `startWatchingDir` und den disambiguierten produktiven `getFileWatcher` sind HIGH. Die Reichweite wurde vor der Änderung gemeldet. Neue Helper sind nicht indexiert. Unabhängige Quellreview findet im engen Diff keinen weiteren notwendigen Fix.

## Tatsächliche lokale Prüfungen und Grenzen

- Neue echte Dateisystem-Gegenprobe: erster roter Lauf5398 reproduziert Adds2 statt1. Gesamtstand dieses abgebrochenen Laufs: ein Pass, ein Fail, ein unterbrochener Fall; kein vollständiger roter Dreierpass wird behauptet.
- Mit Fix bestehen zunächst3/3 (27663), anschließend mit zusätzlicher Fehlerpfadprüfung4/4 (71005), jeweils Exit0. Eigene echte FS-Fixtures prüfen verspätete Erstprojektion, Ersetzung/Entfernung, normale Assetanlage/-löschung, geschlossene beziehungsweise ersetzte Watcher und sichere Cacheinvalidierung bei abgelehntem Reader. Die Authorityentscheidung ist dort injiziert.
- Neuer Klassifizierer:14/14 mit Exit0 (49052). Tatsächlicher Namespace-Helper und tatsächlicher Katalogvalidator an einem explizit gemockten SQL-Witness prüfen denselben Readfence, endgültige Katalogbindung, Rollback und Fehlerweitergabe. Keine neue PostgreSQL-Laufzeitabnahme wird daraus abgeleitet.
- Vollständige cachefreie Typprüfung69839 und Scoped-Lint76121 bestehen auf dem Produktfix vor der anschließenden engen Testfixturekorrektur. Die finale Prüfung läuft danach erneut.

Der erste zusätzliche Regressionsbatch9gcmy0if endet beim React-Clienttest wegen irrtümlich gesetzter `react-server`-Bedingung. Der neue korrekt getrennte Batch564vd2wq passiert vier Programme und scheitert am alten Staging-Clienttest. Derselbe Test scheitert unverändert auch im sauberen QA1ba15 (44116): Er erwartet einen `/files/read`, während `workspacePathExists` längst `/files/exists` benutzt. Die Fixture wurde gezielt um den tatsächlichen Existsvertrag ergänzt; Staging-Noop, Workspacebindung, keine unnötige Inhaltsserialisierung und bestätigtes Löschen bleiben strikt. Die korrigierte Einzelprüfung62070 besteht. Beide früheren Batchberichte bleiben unverändert.

Die finale Folge45091 besteht tatsächlich mit allen neun separat seriell ausgeführten Programmen und unveränderten Quellen-/Testpins davor und danach. Bericht `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-native-projection-watch-final-vl6cbdja/results.json`, SHA `c63a0fb634b11b829423767be895c7e4cd51f8dd43ebd6e47cd03916d77ecd05`. Server- und React-Clientbedingungen sind im Bericht pro ursprünglichem Kommando festgehalten. Abschließende vollständige cachefreie Typprüfung50516 mit16GiB und Scoped-Lint34619 enden jeweils mit Exit0, `git diff --check` ebenfalls. Diese Prüfungen enthalten keine neue PostgreSQL- oder Browserabnahme des Fixes.

Ein neuer Produktionsbuild und die vollständige unveränderte Copy10-Abnahme **nach diesem Watcherfix** fehlen noch. Der vorherige Build gehört ausschließlich zu Root0e67/QA1ba15. Kein aktueller lokaler Test ersetzt den ausstehenden Browsernachweis. Dateiaktions-Undo und Review Center bleiben ausgeschaltet; keine allgemeine Aktivierung, Produktionsmutation oder Container-/Image-Erstellung.
