# Raw-Move/Delete: öffentlicher Web-Anschluss

Stand: 20. Oktober 2026. Arbeitsbasis Root `4c9c30cd60d09cf11fe3f6036017aaa27f82d787` plus die unten gebundenen 26 Quellen. **Web-Implementierungsanschluss aus M1 lokal geprüft; MVP-Freigabe, Produktionsaktivierung und finale kompilierte Browserabnahme bleiben offen.** Der [MVP-Launchplan](./yjs-document-authority-mvp-launch-plan.md) führt M2/M3 weiter. Dateiaktions-Undo und Review Center bleiben ausgeschaltet.

## Verhalten

Die tatsächlichen Rename-/Delete-Webrouten verwenden einen aktuellen Requestprincipal und denselben gemeinsamen nicht ausführbaren Importpreview sowie historischen Selector wie MCP. Preview importiert oder reserviert nichts. Apply bindet den ursprünglichen Request und die Preview-ID an tatsächliche zentrale Originalimporte, native Identitäten und Linkänderungen. Erst nach bestätigtem B0-Abschluss läuft der gewöhnliche Worker. Unverändert native beziehungsweise gewöhnliche Vorgänge behalten ihre eigenen Verträge. Raw-Overwrite und `ignoreMissing` bleiben ausdrücklich vor Importwirkung gesperrt.

Ein seitenlokales Register bindet Original-ID und erste Vorschau an Nutzer, Workspace und exakten Request. Jeder lokale Aufruf erhält ein eigenes Ticket. Lokaler Abbruch oder fehlgeschlagener Flush kann keinen bereits gesendeten oder unbestätigten parallelen Auftrag freigeben. Ein unklarer Ausgang bleibt gebunden; maximal 16 unaufgelöste Einträge werden gehalten und nicht verdrängt. Dispatch prüft unmittelbar vor dem Fetch erneut aktuellen Kontext und Ticket. Nur ein vollständig passender tatsächlicher Abschluss darf den Eintrag auflösen. Bestehende Status-/Benachrichtigungsverbraucher können denselben Abschluss beobachten. Es gibt keinen neuen Timer oder automatischen Mutationsneuanlauf. Das Register ist keine dauerhafte Wiederaufnahme über einen Seitenreload hinweg; ursprüngliche Serveroperationen bleiben separat gespeichert.

Auch die gewöhnliche Vorgangshistorie wird vor frischer Planung geprüft. Historische Antwortwiederholung führt keine erneuten Audit-/Mutationsevents aus. Store und UI wenden alte Pfadmutationen oder Löschungen nicht auf ein späteres Dokument am alten Pfad an; stattdessen erfolgt aktuelle Verzeichnisvalidierung. Für gewöhnliche historische Submit-Wege bleibt `INSERT ... ON CONFLICT DO NOTHING` möglich: Keine pauschale SQL-NoDML-Behauptung für diese Wege.

Der tatsächliche Löschdialog wartet auf die Vorschau, zeigt zentrale Originalimporte und Linkänderungen und bestätigt die ursprüngliche Vorschau. Blockierte, verspätete sowie fremden Workspace-/Authkontexten zugeordnete Antworten dürfen keine Bestätigung freischalten.

## Tatsächliche Abnahme

| Prüfung | Originales Ergebnis |
| --- | --- |
| Finale TypeScript-/Scoped-ESLint-Prüfung, run15 | Exit 0 / 0, keine Lintwarnung |
| Client, tatsächlich gebündelte Rootquellen, run11 | 16 mechanische Testgruppen, Exit 0 |
| Tatsächlicher React/Radix-Löschdialog, run11 | 3 Gruppen, Exit 0; echte UI-Module mit HTTP-Unitfixtures |
| Tatsächliche Web-Request-/Response-/PG18-/FD-Folge, run14 | 7/7, Exit 0 nach 31,997 s |
| Unabhängiger Ressourcenabschluss, run14 | eigener Schema/OID/Sitzungen/DATA/PID entfernt, gleiche vier gesunde verwaltete Dienste |
| Bestehende File-/Pathclients, run12 | beide Exit 0 |
| Statusstore, File-Actions-UI, manueller Deleteverbraucher, Notebook-Pfadmutationen, File-Read-UI, run13 | alle fünf Programme Exit 0 |
| Unveränderter Response-Vertragstest über festen echten ESM-Graph, run16 | Exit 0 nach 33,288 s, selbst beendet; kein erzwungener Exit |

Die acht Bestandsprogramme umfassen den Response-Vertragstest. Die Notebook-Pfadmutationen enthalten zusätzlich vier Gegenproben mit tatsächlichem Client/Store: vorbereitete und gewöhnliche historische Move-/Delete-Bestätigungen verändern zu keinem Zeitpunkt den neu gesetzten D2-Zustand. Subscriptions prüfen jede synchrone Transition vor einer möglichen Verzeichnisheilung. Diese HTTP-Unitfixtures sind keine zusätzlichen Backendmutationen.

Die sieben echten Webgruppen prüfen:

1. Reinen Renamepreview und Apply mit ursprünglicher Preview-ID, tatsächlichem B0, gewöhnlichem Worker, nativen Inhalten/Identitäten und zentralen Linkänderungen.
2. Delete einschließlich ursprünglicher Archivierung, tatsächlichem Trash und zentralem Unlink.
3. Tatsächliche SID-B nach Ablauf von SID-A; ursprüngliche Apply-/Statushistorie bleibt trotz ungültiger neuer UTF-8-Dateien an den alten Pfaden erhalten und verändert gespeicherte Belege nicht.
4. Geänderter ursprünglicher Request wird vor frischer Planung mit `PATH_IMPORT_HISTORY_CHANGED` abgewiesen.
5. Nach Preview geänderte Originalbytes werden vor Import-/Header-/Problempersistenz mit `PREVIEW_STALE` abgewiesen.
6. Tatsächlicher aktueller WRITE- und Delete-Rechteentzug verhindert Importwirkung.
7. Raw-Overwrite und `ignoreMissing` werden ausdrücklich ohne Wirkung abgewiesen.

Diese Folge verwendet tatsächliche signierte Cookie-Sitzungen, originale Routeexporte und den gewöhnlichen PostgreSQL-/FD-Worker. Die Bare-Markdown-Fixtures werden tatsächlich importiert; vollständige native Inhalte werden gegen die ursprünglichen beim INSERT gespeicherten Updatebytes, Vektoren, unveränderlichen Hashbelege und erwarteten Linkänderungen geprüft. Ein gespeicherter Yjs-Snapshot ist dabei ein Zustandsbeleg, kein eigenständiges rekonstruierbares Dokumentupdate.

SQL-Probes beobachten die tatsächlichen nativen Adapterbefehle einschließlich Befehlsart, schreibender CTEs und Notify. Unabhängige vollständige Schema-/Tabellen-/OID-/Zeilen-/`xmin`- und DATA-/FD-Snapshots prüfen Identitäten und Bytes. **Drizzle-Auth-Aufrufe mit QueryConfig plus separaten Parametern werden vom bestehenden Probe nicht beobachtet.** Beim echten SID-A-401-Fall wird deshalb ausdrücklich null beobachtete native Adapteraktivität erwartet; die vollständigen Snapshots und echte 401-Prüfung bleiben erhalten. Ein vollständiger Auth-SQL-Wire-/NoDML-Nachweis einschließlich möglicher transienter/rollbackter Schreibbefehle wird nicht behauptet. Alle nachfolgenden tatsächlichen Native-History-/Status-/Negativfenster behalten ihre positiven Ereigniszählungen und Schreibguards.

Sämtliche akzeptierten Läufe melden unveränderte Quellen. Die vollständigen Quellcensus von run14/15/16 sind bytegleich. run11/12/13 unterscheiden sich ausschließlich durch die später präzisierte SID-A-Testzählung, nicht durch Produktquellen. Client-, Web-PG- und Response-Bundleverzeichnisse sind nach tatsächlichem Prozessabschluss unabhängig als entfernt geprüft. Kein Container wurde gebaut oder neu gestartet.

## Erhaltene REDs und Grenzen

Alle ursprünglichen roten Läufe bleiben unverändert erhalten. run1/2 scheitern vor Unitabnahme an Testauflösung beziehungsweise falscher React-Importbedingung. run3 reproduziert den tatsächlichen V1-Fehler: Ein lokaler Parallelabbruch konnte die ID eines schon gesendeten unbestätigten Auftrags freigeben. V4 korrigiert dies mit gemeinsamen Einträgen und einzelnen Tickets; die entsprechenden Clientgruppen bestehen.

Weitere ursprüngliche Läufe finden drei Typannotationen, zwei Lintinitialisierungen sowie zwei UI-Hostfehler. Die finale Dialogfixture installiert ihre HTTP-Sessionantwort vor dem echten BetterAuth-Import und wartet auf dessen tatsächliche Atom-/Authbeobachtung. Radix wird nach DOM-Aufbau geladen und vor DOM-Abbau vollständig abgehängt; weder Authguards noch Dialogverbraucher werden ersetzt. Dies ist weiterhin eine Unit-HTTP-Sitzungsfixture, kein Backend-Authentifizierungsnachweis.

run9 findet das falsche Anwenden eines gespeicherten Yjs-Snapshotbelegs als Dokumentupdate. Ausschließlich das Testorakel verwendet danach die beim tatsächlichen ursprünglichen INSERT beobachteten Updatebytes und prüft sie gegen alle unveränderlichen Belege. run11 findet die oben erklärte falsche positive Adapterzählung am SID-A-401-Arm. Unabhängige Ressourcenabschlüsse bleiben auch für die roten Datenbankläufe erhalten.

Der unveränderte direkte TSX-Responseaufruf in run12 endet vor Testcode mit `ERR_PACKAGE_PATH_NOT_EXPORTED`: `pi-ai/compat` besitzt ausschließlich einen ESM-Importarm. run16 verwendet deshalb den gepinnten existierenden gemeinsamen Controller mit genau drei festen privaten Konfigurationsanpassungen (Root, fester Entry, 20 tatsächliche Pflichtquellen), echten unveränderten Produkt-/Testimports und `react-server`. Kein Produkt- oder Testkörper wird transformiert oder gemockt. Der private Runner hat SHA-256 `3a12b157ff27d8e3ed857696dba6cfce32a7f6d499b3c8a44b71df24a694e895`; eine grüne unveränderte npm-Gesamtpipeline wird daraus nicht behauptet.

Dieser Nachweis enthält **keinen TCP-/Proxy-/Browserlauf, keine echte OAuth-Neuanmeldung, keinen frischen aktivierten Gesamtbuild, keinen Linux-Sandbox-/CI-Nachweis und keine Produktionsauslieferung**. Die frühere kompilierte Neunerabnahme gilt für ihren damaligen Stand. Zentraler interner PI-Create, verpflichtender Linux-/CI-Schutz und kontrollierte Aktivierung bleiben M2. Finale gemeinsame Browser-/Build-/API-/MCP-Abnahme einschließlich Copy, die zwei bekannten älteren roten Legacy-/Undo-OFF-Gesamtsuiten und PR/CI/Review bleiben M3. Die vollständige SDK-/PDF-/Such-/Skill-Roadmap bleibt nachgelagert.

## Gebundene Originale

Private Belege: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-web-path-eiaww3k5`.

| Original | SHA-256 |
| --- | --- |
| `run11/terminal.json` | `1720376fbc30c7544c679c78ca816a8481a8ee56011d674a924803ac147ae762` |
| `run12/terminal.json` | `c3c903c1149009a00f31b128db1ccafbd978fa90e80381fbca9442d0f7d912d1` |
| `run13/terminal.json` | `fea4d1e9bf85743d7aa7725d6a64d16c65abd07a2336b401e2f6240dc5eb4077` |
| `run14/terminal.json` | `e9f9534a0b4538276e9e8e90f61012764cd1ef6998de2d9ec9eeb5609143c7b1` |
| `run14/web-pg.log` | `96b8987f008278dc2d151da080a406050f2d0b9d7499f8314f4e8591a306bfaa` |
| `run14/web-pg-resources.json` | `46203796bc09a89c1948e2297ff10558be7d1909d07a8acd3f6e2c5265b61e03` |
| `run15/terminal.json` | `f1338ef46d0b7b2fc09fb3ea19a7d79d82b3ffea164056fccbcfa24ce5b7e89e` |
| `run16/terminal.json` | `e490345b9366777bea997e75d7fe08df5a7223d69c2d13d11600bbcd2ba47ac0` |
| `run16/response-esm.log` | `5635b5a57fd37bc211af5b5353231159e87d18cd7a1c77f8a0ef98f90bf0384b` |
| `web-accepted-source-pins.json` | `d0d9b6423f0ab1b466b3c364bc9f3910b541b3b1bb1a3b9f5085a27dbdd740fc` |

## Gebundene Produkt- und Testquellen

| Quelle | SHA-256 |
| --- | --- |
| `app/api/files/delete/route.ts` | `5c1d9279b1c9dc5e76be99c40af3012f68fcae074915d03bd66e7567d8c3c766` |
| `app/api/files/rename/route.ts` | `280d94561cc410aaca99dfa70d3156cc5ab5907c524d34e497b79c32726d065d` |
| `app/components/file-browser/DeleteConfirmDialog.tsx` | `204fc61ffc168fe320b894696d648f71f8655130a31ad3b5552b5813533bae43` |
| `app/components/file-browser/FileActionsDropdown.tsx` | `a3f7da33ceb36b12c22581dcbabe4ed4da7b0b748c4bd38cf446ecc2d29a07e7` |
| `app/components/file-browser/FileBrowser.tsx` | `92bc6688fb704a776084a27a1874181844caa7ab8b7bb5ee11c6e53975fd5f2f` |
| `app/components/file-browser/useTrashUndo.ts` | `1f1a6a8d3722bafc34bd86d219295a4d218d4c54f1701dd4cbf6316a09ad4875` |
| `app/lib/files/client.ts` | `42c447f878843f77649208f8b9865fe49642986509f1b7e974b55dcead60b991` |
| `app/lib/files/workspace-path-operation-attempts.ts` | `6a7aaece7c3452b1561a8dba96d0ed57bcd0fe0956c083b069a44051a11fc6bb` |
| `app/lib/files/workspace-path-operation-client.ts` | `8d67ea0bb8f73dda8e5cba259ff260a1dba95cfecced3add8740d78cd4138b49` |
| `app/lib/files/workspace-path-operation-parser.ts` | `d585112d7cecb1e95460be7ffb7ce1be284cd6ac8ab5ad4eff5b8e163eb4688a` |
| `app/lib/files/workspace-path-operation-preview.ts` | `8b33fda25f10eca285f6206e10641a10919c32558ba9a9a6b406fb2c337f26d0` |
| `app/lib/files/workspace-path-operation-public.ts` | `a6bd701046978a1ceb7d76e53cc890e68722cae6b9707d85d2ddcf2ff652a5dc` |
| `app/store/file-store.ts` | `eb8ed946fd75963be7f2cec3306dfad69a68aff43005a2c9a3d1137858e9b53f` |
| `app/store/workspace-path-operation-store.ts` | `a8b317b3787cfb3efc73eb36e0dcb7c04357c2a21bbb1f54e3a64651a0397c05` |
| `messages/de.json` | `6770b35a765e6a63cfd3060a60e9525b29e2352964e5f813abff5fb9afa183ad` |
| `messages/en.json` | `63100e308dc60e1e97df363fe13a50b366eb170b64d083050c8b0bf28a3b47e8` |
| `scripts/notebook-path-mutations-test.ts` | `7dff5f92870653d79de99109f3738a00c342995229ee30a2c53aad6c5b5e1339` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `b29f0d9930925be8b5d9f58ce922dc39bd6cbe997e44fd58ad3aef7da4ad0d2b` |
| `scripts/workspace-delete-confirm-dialog-runner-test.ts` | `4ab051d1cafe50767c49f3a33ae782f6007d3eb8628ec30c5ab0e4b5b3dbef82` |
| `scripts/workspace-delete-confirm-dialog-test.tsx` | `4380fd73d5ad448ed516fee7044e5e2a2eed7817f22704b106cc2d843b0a69f4` |
| `scripts/workspace-file-operation-client-test.ts` | `f744a85e67e1a67bc7c7aa419124860d026a70d0a7fcccdb900ca8ec105050ff` |
| `scripts/workspace-operation-manual-delete-ui-test.tsx` | `4c8cd1984c2d19cd5d29ef73a82d87deef532b40677e86513470e85dd2fed925` |
| `scripts/workspace-path-import-web-routes-postgres-runner-test.ts` | `734fc6957018ae75cf01ada6793abdc8e81a57c342a23a130c96442f03a09325` |
| `scripts/workspace-path-import-web-routes-postgres-test.ts` | `1359cf7cbb103edc5e4a63dd92c0ef994bbe2303ca0216f4494816020eccbf0d` |
| `scripts/workspace-path-operation-attempts-runner-test.ts` | `030f1d2dfef259fd9b5bd7792da4abc57ce878164ba07689445ff709fd562790` |
| `scripts/workspace-path-operation-attempts-test.ts` | `1775072c8e09cc8ae4d924004c7ac5f1b698a6b80f52df267dd0b827ff91e723` |
