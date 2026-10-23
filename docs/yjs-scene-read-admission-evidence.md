# Begrenzte Scene-Read-Zulassung

Stand: 18. Oktober 2026. Der siebte frische Originalbuild, unabhängige Artefaktabgleich und die vollständige kompilierte Dateiaktionsfolge bestehen mit **20/20**, null Fehlern, Skips, Timeouts oder Unterbrechungen. Originalruntime, Queue, Baseline und unabhängiger Postcheck enden tatsächlich mit Exit 0; alle 14 Abschlussprüfungen sind erfüllt. Die lokale Scene-Admission-Gegenprobe besteht 4/4 echte PG-Gruppen, Lifecycle 6/6 echte PG-Gruppen und Strict-Cleanup 6/6 mechanische Fehlerfamilien. Die [vorherige vollständige Folge 17/20 bleibt historisch fehlgeschlagen](./yjs-scene-document-tree-evidence.md#sechster-build-und-vollständige-browserfolge-1720). Diese ausgewählte Dateiaktionsabnahme ist keine Freigabe des vollständigen Dokumentauftrags.

## Enger Produktvertrag

Die zentrale Lifecycleprüfung behält ihre echte verifizierte Owner-Lease-Ausnahme und sämtliche Reservations-/Yjs-Ownerprüfungen. Ausschließlich ohne gültige Lease und bei gewähltem Wait-Modus erwirbt sie denselben exklusiven Workspace-Admission-Key blockierend auf derselben B-Verbindung unter `SET LOCAL lock_timeout='4s'` und `statement_timeout='5s'`. Nur `55P03` dieses Erwerbs wird mit erhaltener tatsächlicher Ursache auf das bestehende Busy abgebildet. Das sind keine neue Gesamtfrist und keine Wiederholung der Operation.

`getExcalidrawDocument` wählt Wait ausschließlich bei vorhandenem `beforeRead`-Callback. Die vorhandenen Eintritte liefern damit ihren aktuellen Principal-/Workspace-Resolver; dessen erneute Prüfung bleibt vor Inspektion beziehungsweise Bootstrap-DML erhalten. Ohne diesen Callback bleiben getDoc, Create und Import fail-fast. getDoc kann History-/Bootstrap-DML ausführen und ist kein READ-ONLY-Dienst. Ein Captured-Workspace-DTO erhält keine neue Warte-/Schreibberechtigung.

Nur Availability-Wait aktiviert den neuen dritten Helperparameter `{strictCleanup:true}`. Nach bestätigtem ROLLBACK und Close bleibt das ursprüngliche Fehlerobjekt erhalten. Ein fehlgeschlagener ROLLBACK führt dagegen zu einem terminalen `AggregateError` aus Operation und Rollback; genau dieses Objekt wird an das tatsächliche `await connection.close(discardError)` übergeben. Ein weiterer Closefehler bleibt mit allen tatsächlichen Ursachen terminal und kann nicht als gewöhnliches Busy durchgehen. Default, `{}` und `strictCleanup:false` behalten die bisherige Helpersemantik. Ein erfolgreicher Adapter-Discard ist kein eigenständiger Beleg des bereits physisch beendeten PostgreSQL-Backends.

## Tatsächliche lokale Prüfungen

| Prüfung | Ergebnis und Grenze |
| --- | --- |
| Kontrollierter Originalcode gegen separat gehaltenen regulären Shared-Reader | Exit 1: sofortiges `EXCALIDRAW_FILE_LIFECYCLE_BUSY`, bevor ein tatsächlicher exklusiver Wait beobachtet werden kann; ursprünglicher RED bleibt erhalten. |
| Neue Scene-Admission-Suite | Exit 0, 4/4: ein tatsächlicher Wait mit 4s/5s auf B und Erfolg nach Readerfreigabe ohne neue Identitäten/DML; anhaltender Shared-Halter endet begrenzt mit verschachteltem PG-`55P03` ohne Bootstrap; Defaults bleiben fail-fast; echter Entzug der Lese-/Schreibrechte während des Waits wird nach Freigabe vor DML abgewiesen. |
| Bestehende Scene-Lifecycle-Suite | Exit 0, 6/6: registrierter/unregistrierter Bootstrap, Create/Import, initialisierte Reads und Wiederholungen, Unterbaum-/Siblinggrenzen, verschobenes D1 gegenüber reserviertem alten D2-Pfad sowie vorbereiteter Receipt ohne Dokument bleiben geschützt. |
| Strict-Cleanup-Faultsuite | Exit 0, 6/6 mechanische Familien am tatsächlichen Helper: awaited Close, Busy-Objektidentität, exaktes Discard-Aggregate, Closefehler, BEGIN-/COMMITfehler und unveränderte Defaults/Wait-only-Opt-in; kein PG-/HTTP-/physischer Disposalnachweis. Ein `beforeExit`-Completed-Guard verhindert einen stillen Erfolg bei einer unerledigten Promise. |

Die eigene Fixture-/Adapterclosure besteht auch nach dem Original-RED. Der zusätzliche unabhängige Abschluss bestätigt mit Exit 0 alle drei exakten eigenen Schemata/OIDs und zugehörigen Application-Backends als entfernt beziehungsweise beendet, die drei DATA- und vier Bundlepfade als ENOENT sowie den geschlossenen Auditclient. Die mechanische Suite bleibt ein Faultnachweis ohne eigene PG-Aussage. Aktuelle HTTP-/OAuth-Authentifizierung und kompilierte Editor-/Asset-/Pixelwirkung werden daraus nicht abgeleitet.

Die Gegenprobe identifiziert ihren bewusst gehaltenen Shared-Reader über `pg_locks` und `pg_blocking_pids`. Sie schreibt ihn nicht dem früheren Browserfehler zu: dessen tatsächlicher ursprünglicher PG-Lockhalter und genauer Guard-Zweig bleiben unbewiesen. Der getrennte [Copy-Owner-Wait](./yjs-copy-reader-contention-evidence.md) bleibt ein eigener Nachweis; die früheren [Scene-/Browserbefunde](./yjs-scene-document-tree-evidence.md) bleiben unverändert erhalten.

## Quellen und Originalbelege

Die folgenden Produktbytes der lokalen Gegenproben sind jetzt in Root `13fb43a5351c6710f8cf032a49f8f12ed213089f` und QA `5bae498af61d8d1a87665907a57b0e16d72604d0` integriert. Der frische kompilierte Nachweis ist an diese tatsächlichen Quellenstände gebunden; spätere reine Dokumentationscommits sind kein neuer Produktlauf:

| Quelle | SHA-256 |
| --- | --- |
| `app/lib/files/workspace-file-lifecycle-guard.ts` | `75d780f86c7d34958d0abc4c5d3092cef332278a5e5a8e58064ded8c70a9a9c9` |
| `app/lib/files/collaboration-repository/transaction.ts` | `65eaf9aa10c8f37de366596955fdbd98071285b7e6d5adaf5d1e4357d789b8dc` |
| `app/lib/excalidraw-collaboration/lifecycle-availability.ts` | `efc84dfdb66c9b98301d1c78c135bfd2dc0517e6bdbc47bfff23121fddb7b430` |
| `app/lib/excalidraw-collaboration/scene-service.ts` | `f9324afa7ca4ff73b3af6f4cf20366d56c329e9357c39c098619a324c804e174` |

Die Tests liegen in `scripts/excalidraw-read-admission-postgres-test.ts`, `scripts/excalidraw-lifecycle-availability-postgres-test.ts` und `scripts/file-collaboration-strict-cleanup-test.ts`; der bestehende begrenzte Dispatcheradapter lädt den tatsächlichen Produktgraph.

Private Originale: `/private/tmp/canvas-scene-admission-proof-wyw1vpd7/`. `controlled-red-report.json` hat SHA-256 `f3e3c62a95e531d3a6ab6a6a7b7d6353a41baf7c4f8f9305917734c1e16645ae`, `controlled-green-report.json` `80872995e8a70c04720275031555c9c540fc855fec1dbb15a4ab890e2d6c7b4d`. Die eigenständigen Originalausgaben `lifecycle-regression.log` und `strict-cleanup.log` haben SHA-256 `a7a317e6f39b99dea03f8a64a692781a62aff1106c4475e36b846cd1e043260c` beziehungsweise `070885c84334ddf0ec1a9cecf75f1643d2d0dd7e023cc52743451863ebeb535b`. Keine Zugangsdaten oder vollständigen privaten Traces werden übernommen.

Der separate tatsächliche Ressourcenabschluss liegt daneben in `independent-fixture-closure.json`, SHA-256 `d43786ed5c8b6bfa576a8744eb8ee1bd206a436bea12821d7e2251d7ec2ebb6a`.

## Siebter Build und vollständige Browserfolge 20/20

Der tatsächliche Originalbuild endet nach 293,347 Sekunden mit Exit 0 einschließlich bestandenem Release-Typecheck. Der separate Artefaktabgleich endet ebenfalls mit Exit 0; Bericht-SHA-256 `65b9c6e523ffb4afcffeb340503142820250a70b1a122f94475fe07e420be8b6`. Er bindet Sourcefingerprint `2997595cfaa77e428d07658bb26412878aa882d4c8eae4d1a81f366bffd18aeb`, Buildfingerprint `c2e1d7c5a22cb322b49b671aedad09df35892863b2362a627d082fa26bb74c26` und unveränderte QA-Quellen vor/nach dem Abgleich.

Die sechs originalen Folgen bestehen in tatsächlicher Reihenfolge: Scene 4/4, Native-Copy 6/6, Herkunft 2/2, UndoOFF 2/2, Move 4/4 und Delete-Links 2/2. Insgesamt sind 20 deklariert und bestanden, ohne Fehler, Skips, Timeouts oder Unterbrechungen. Desktop und Mobile bestätigen reguläre UI-Copy aktualisierter Scenes ohne Quellprojektion sowie gemischter Markdown-/Scene-/PNG-/PDF-Ordner. Die Tests prüfen neue Zielidentitäten, erhaltene Quellinhalte und wiederholtes ENOENT auch nach Preview und Reload. Die gemischten Fälle bestehen echte Browser-Assetabrufe mit HTTP 200, ETag/Hash und PNG-Bytes sowie mindestens 100 schwarze statische Canvas-Pixel nach Erstöffnung und Reload; die Scene-Fälle ohne Asset entsprechend sichtbare Rechteckpixel. APIRequestContext-Abrufe können diese Browserbeobachter nicht erfüllen. PDF-Parsing, weitere Scene-Move-/Delete-Aktionen oder innere Scene-Links werden daraus nicht abgeleitet.

Der tatsächliche unabhängige Postcheck bestätigt alle 14 Prüfungen: Beide exakten eigenen Datenbanken/OIDs `11680090` und `11687704` sowie sämtliche zugehörigen Backends sind entfernt beziehungsweise beendet; DATA/TMP, zwei ursprüngliche Ports und Runlock sind frei. Vier ursprüngliche verwaltete Identitäten bleiben unverändert gesund. Die zusätzliche passive Abschlussprüfung bestätigt alle 43 tatsächlich gesampelten Prozessidentitäten und 14 Gruppen als beendet. Dies ist kein vollständiger Census kurzlebiger Prozesse. Quellen-/Artefaktbindungen bleiben während der gesamten Folge und ihres Abschlusses stabil; sämtliche früheren negativen Originalbelege bleiben erhalten.

Private Laufbelege: `/private/tmp/canvas-scene-admission-browser20g-nx0_hw7e/`, insbesondere `build-terminal.json` (SHA-256 `5ed840b00f74b5c2c07ae9827ddcf0ca90ddf478544988d7d6d4289eaa8dc217`), `artifact-report.json`, `queue-terminal.json` (SHA-256 `b474a4aaaa88cd0a21945c8c6aac8daa6f69120e6687f268bc287f57e95359a0`) und `postruntime-report.json` (SHA-256 `7f78f078119639a9c3e3652feb6c28a8e4c829d3ae218684049f1c3faa4c46e7`). Der zusätzliche Prozessabschluss liegt in `post-cleanup-passive-process-closure.json`, SHA-256 `6023f543fcc706d43004051dd433ee21892f02bee6e0c910ed8216f75d0db098`. Die ursprüngliche Runtime-Fixture war `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-OfaBjb`; die vollständigen Originalergebnisse werden über den Postcheck gebunden.

## Offene Abnahme

Der vollständige Typecheck endet tatsächlich nach 79,571 Sekunden mit Exit 2: exakt die 69 geerbten Main-Diagnosen, bytegleich zur akzeptierten Baseline mit SHA-256 `f87d64a219dd9317c7a22890a2687240cbf81b79851e829dd8117faa2ea561e3`, ohne zusätzliche Diagnose. Das ist kein vollständiger Typecheck-Green; der anschließende Release-Typecheck im frischen Build besteht separat. Scoped-Lint besteht mit Exit 0 für die vier Produkt-, zwei Test- und eine Adapterdatei. Die ausgewählte 20-Fälle-Dateiaktionsabnahme ist abgeschlossen; frühere 17/20 werden nicht nachträglich grün. Vollständige Suche, Create/Import/Edit, weitere MCP-/PI-/Mobile-Transporte, externes SDK, Standard-Skill, PDF-Parseranbindung, Sandbox- und Gesamt-E2E-Abnahme bleiben offen. Allgemeines Aktivierungsgate, Dateiaktions-Undo und Review Center bleiben ausgeschaltet; kein PR, Push oder Rollout wird hiermit behauptet.
