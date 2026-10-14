# V21: authentisierte Textsessions im tatsächlichen Browser

Stand: 2026-10-14. Das lokale V20-Gate bleibt als eigener bestandener Beleg erhalten. V21 prüft den neuen authentisierten HTTP-/Socketanschluss; dieser Lauf besteht nicht.

## Exakter Prüfstand

| Bindung | Tatsächlicher Wert |
| --- | --- |
| QA-Worktree | `yjs-native-websocket/canvasstudios-notebook` |
| QA-Commit | `5f3c1297c895d25365afe1c0accd582ea8e6c97c`, auf `2bcd22b4a` |
| Source-Fingerprint | `dec5259a93ba6bb35c05c82c6f33bc5e1ec0c0f2a4ef108461341a5486b0d98e` |
| Build-Fingerprint | `247c77aa672f7f5d05dcab6654c364240116a711abbe4e3b1c9d38520f01074f` |
| Build-ID | `build-TfctsWXpff2fKS` |
| Control Plane | unverändert und sauber auf `27c8ce37da082244f006ca376068cde6b98845d5` |

Nur der private QA-Branch setzt den gemeinsamen nativen Textsession-Schalter auf `true`. Der Integrationsworktree belässt ihn auf `false`. Die vier ursprünglichen Specs und ihre 17 Runner-/Helper-/Konfigurationsdateien bleiben bytegleich zur V20-Abnahme.

Der erste echte `npm run build` scheitert an einem Dependency-Symlink außerhalb der Turbopack-Projektwurzel. Die eigene QA-Symlinkfixture wird durch eine physische APFS-Kopie derselben Dependencies ersetzt: keine Installation, Versions-, Source- oder Konfigurationsänderung und keine Hardlinks zu veränderlichen Root-Dateien. Der zweite tatsächliche Build besteht. Root bestätigt vor und nach dem Browserlauf den Buildproof durch erneutes Lesen der tatsächlichen Source-, Artifact- und verwendeten externen Packagebytes; außerdem Copy-Manifeste, aktuelle Dateiprofile und unveränderte Paket-/Lock-/Testdateien. Ursprüngliche Build-PID/Starttime-Tupel wurden vom Buildhelper nicht persistiert: bestätigt sind erfolgreicher Child-Close und danach null Prozesse in den eigenen Cwd-Bereichen, keine unabhängige historische PID-Tupelprüfung.

## Originaler Browserbefund

Ausgewählt sind Create/Paste/Import, Fokus/Breite, Workspace-Links und die beiden tatsächlichen Neustartfälle. Der unveränderte Supervisor stoppt nach einem fehlgeschlagenen **Suitegate**, nicht nach dem ersten einzelnen Test.

| Ergebnis | Anzahl |
| --- | ---: |
| Erste Suite: deklarierte und gestartete Fälle | 6 |
| Bestanden | 1 |
| Fehlgeschlagen | 5 |
| Skips / Testtimeouts / Unterbrechungen | 0 / 0 / 0 |
| Weitere gestartete Suites / Hostneustarts | 0 / 0 |

Der gewöhnliche History-Fall für eine `.log`-Datei besteht. Die fünf Editorfälle enthalten jeweils eine tatsächliche Antwort des Sessionendpunkts `POST /api/files/collaboration/session` mit HTTP `409` und `code: PRINCIPAL_BUSY`. Home, Dateibrowser und vollständiger Markdown-Upload zeigen davor je eine erfolgreiche native Sessionantwort: zweimal `tiptap_blocks`, einmal `plain_text`. HTML-Paste und Body-Markdown-Insertion enthalten keinen solchen vorherigen 200-Beleg in den gelesenen Network-Traces. Root bestätigt diese Antworten und die Reporter unabhängig; Credentials, Tickets und vollständige Grantpayloads werden nicht ausgegeben.

Der Fehler in den Home-/Dateibrowserfällen liegt an der zusätzlichen Sessionabfrage vor dem ersten Clipboard-Paste. Dieser Lauf belegt deshalb keinen bestandenen Paste-/Undo-/Peer-/Reopenweg. Der erhaltene Serverlog enthält geschlossene Collaboration-Verbindungen, aber keinen konkreten PostgreSQL-Lockhalter des `PRINCIPAL_BUSY`. Ein Zusammenhang bleibt unbewiesen. Die anschließenden Test-Cleanups erklären, warum die abschließende Datenbankbeobachtung keine aktiven Native-States zeigt; daraus folgt keine nie erfolgte Initialisierung.

## Folgeschritt und Grenzen

Der [Sessiondienst](../app/lib/collaboration/authenticated-text-session-service.ts) und [Client](../app/lib/collaboration/client.ts) besitzen bisher keinen begrenzten Retry für diesen echten HTTP-Busyfall. Der nächste enge Schritt prüft frische Lese-/Enrollmentphasen mit festem ursprünglichem Scope, bestätigtem Rollback, Close und Capability-Disposal. Bootstrap, Migration, Veröffentlichung und unklare Commits bleiben außerhalb dieses Retryloops. Ein kontrollierter echter Parallel-PG-Fall soll den vermuteten Lockkonflikt separat belegen. Die Authlocks werden durch diesen Entwurf nicht gelockert.

Mobile-Session-HTTP → Einmalticket → Raw-Socket und Capability-Disposal bilden eine eigene noch offene Abnahme; die Webfälle bestätigen diese Modulgrenze nicht. Der globale Produktanschluss, die erweiterte Matrix des [Importplans](./markdown-create-paste-full-import-integration-plan.md#9-abnahmefälle) und der ursprüngliche Produktionsfehler bleiben offen. Kein Produktionszugriff, Deployment oder zusätzlicher Testcontainer.

Die eigene fehlgeschlagene Fixture samt Datenbanken, DATA, Logs und Traces bleibt für Diagnose erhalten. Root bestätigt die Abwesenheit aller zwölf von ihm beobachteten Runtime-PIDs und die leeren fünf beobachteten Prozessgruppen. Seine anschließende eigene Read-only-PG-Prüfung bestätigt beide tatsächlichen Datenbank-OIDs/Owner/Marker und jeweils null Sessions. Root-/DATA-Inodes und Owner-Marker bleiben unverändert, die Runtime-Lockdatei fehlt, alle drei eigenen Ports lassen sich erneut exklusiv öffnen und schließen. Der Supervisor markiert den fehlgeschlagenen Lauf weiterhin `preserved`, `uncertain: true` und `passed: false`; die erfolgreiche Prozessclosure bestätigt keine erfolgreiche Browserabnahme. Das Evidence-TODO ist damit dokumentiert; Produktfix und erneute Abnahme bleiben offen.
