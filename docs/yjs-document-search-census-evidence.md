# Lokaler Raumbestand für die gemeinsame Dokumentsuche

Stand: 17. Oktober 2026. Vorbereitender Suchbaustein auf Root `8f0453326` / QA `94574e521` plus den unten gebundenen Änderungen; kein abgeschlossener Suchdienst und keine neue Gesamt-E2E-Abnahme.

## Verhalten und Grenze

`search-room-census.ts` ist am tatsächlichen Collaboration-Server installiert. Der synchrone Capture beobachtet alle geladenen Plain-/XML-/Blocks-Räume des gewählten Workspace, einschließlich Räumen ohne verbundene Peers. Native Inhaltsextraktion, Berechtigungsprüfung, Datenbankkorpus, Ranking und HTTP-/MCP-/PI-Suchadapter bleiben eigene noch offene Anschlüsse.

Die Beobachtung bindet konkrete Rauminstanz, aktive Documents-/Loading-/Unloading-Maps, Identitätsobjekt und Scope, monotone Yjs-Transaktions-/Updatebeobachtung, Ownerfelder und registrierte Servergeneration. Revalidierung erkennt auch Delete bei unverändertem Statevector, Delete/Undo mit wieder gleichem Text, fehlende Updateabhängigkeiten und vorzeitig werfende Update-Listener. Offene Transaktionen, unbekannte Identität, Loading, Unloading, Drain, verlorener oder fehlender Owner und Budgetgrenzen ergeben ausdrücklich unvollständige Abdeckung. Listener werden beim Serverwechsel, Close und beobachtetem Raumaustritt entfernt.

`completeFor` ist ausschließlich `same_process_loaded_text_rooms`; `remoteCoverage` bleibt `unknown`. Ein fehlender Provider bedeutet unbekannte Abdeckung. `coversOwner` vergleicht nur eine tatsächlich vom späteren SQL-Leser gelieferte Ownerbeobachtung mit privaten lokalen Belegen; es erteilt keine Rechte. Vor Suchveröffentlichung sind aktueller autorisierter Native-Read, unabhängiger SQL-Korpus-/Ownerabgleich und eine erneute synchrone Censusprüfung nach allen Await-/Commit-/Dispose-Grenzen verpflichtend. Kurzzeitig zwischen zwei Beobachtungen geladene und wieder entfernte andere Räume sind kein historischer Vollständigkeitsbeleg; ihre dauerhaften Änderungen muss der SQL-Abschluss erkennen.

Die feste Sichtbarkeit `exclude_dot_segments` filtert bekannte versteckte Räume vor Kandidaten, Ownerbelegen und Inhaltswitness; Änderungen dieser Räume invalidieren einen sichtbaren Capture nicht. Der globale Scanaufwand ist trotzdem über alle Map-Einträge begrenzt (Standard 1.024, maximal 4.096); viele fremde oder ausgeblendete Räume können deshalb ehrlich `limit` erzeugen. Der spätere öffentliche Vertrag darf daraus keine verborgenen Trefferzahlen ableiten. Unbekannte Loading-Identitäten bleiben konservative Unsicherheit.

Die Prozessregistry verbindet auch getrennte unveränderte Modulkopien. Revalidierungsfehler werden auf die Fehlerklasse des Consumers normalisiert. Diese enge Gegenprobe ist kein kompiliertes Next.js-/OAuth-/HTTP-E2E.

## Tatsächliche Prüfungen

Originalqueue: `/private/tmp/canvas-search-room-census-final-proof-ut9f_c4c`, tatsächlich Exit 0.

| Prüfung | Ergebnis | Original-Log SHA-256 |
| --- | --- | --- |
| `npm run test:collaboration:search-census`: 57 echte Observerfälle und tatsächliche Serverinstallation/Hocuspocus-Raumregression | Exit 0 | `aa45adb8aff4f386c92f0e0d63c67ebeaeb193ee3905494ebbf89946eb7ca9a3` |
| Unveränderte Produktassertionen der 12 Direct-Lifecycle-Fälle mit angepasster Fixture-Reihenfolge | Exit 0 | `a7999627c8451214770ed5caf0b75f210687ac0c5177e66c5d4a34eeaee2d5ae` |
| Vollständiges cachefreies TypeScript, 8 GiB Heap | Exit 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Scoped ESLint für alle sechs Code-/Testdateien, null Warnungen | Exit 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Keine Skips in den 57 Observerfällen. Ausgeführt mit Node `v26.7.0`. Die Originalqueue bindet alle sieben Produkt-/Test-/Packagebytes und alle drei Worktrees vor/nach jedem Schritt; sämtliche Quellen bleiben während der vier Schritte unverändert. Der unabhängig erneut berechnete Postcheck bestätigt die ursprünglichen Sourcefingerprints und die ursprünglichen temporären Fixturenamensmengen. Das ist keine vollständige Prozesshistorien-/Filesystem-Inhaltsprüfung. Es wurden keine HTTP-Listener oder SQL-Fixturen für diesen Baustein angelegt. Die vier bestehenden verwalteten Container sind anschließend mit denselben IDs `running healthy`; kein Recreate oder Imagebau.

Terminaldatei SHA-256: `3136e3a4a930ca7d60aa223e1e5a7a524b902bc9b0f4ebad8238805249aa9cef`. Unabhängiger Postcheck SHA-256: `5c0dba3031bd42d47b96e1aba7bc479f4c16a630dbb69ba792f7fd0ed27ffd39`.

| Datei | Geprüfter SHA-256 |
| --- | --- |
| `app/lib/collaboration/search-room-census.ts` | `4c7ad9cbfedcea192603f0509c06131ed62024ba57ba36e75f47ba34bccff3c0` |
| `server/collaboration-server.ts` | `b68adbafb89907eb4b8c764a4cc698de9f0f1fe9c130a6e77542550992558dc0` |
| `scripts/collaboration-search-room-census-test.ts` | `4baa7b7e9c013eaaf84f9b3ada8bc41710ee6b9a8ca9a8b592c1eea6f9e85d96` |
| `scripts/collaboration-room-generation-test.ts` | `5002da7f9edbb3be3a832842d68561581fe523d5d9a1496e08cb82e5a16d99d3` |
| `scripts/collaboration-server-lifecycle-test.ts` | `80563b2a2fb4e173f8286edfeae60283f7561fa04c0652ee9c06b825846255ff` |
| `scripts/helpers/legacy-room-lifecycle-stubs.ts` | `9933456cfae14e68080034af9f39e43fcb44f28fef05b1b4282749b5b0e24fb4` |
| `package.json` | `6d52457d6c9d752916c4f6608a76607122c014c8eec852d42dc4f48b697e4078` |

## Erhaltene Fehler und Korrekturen

- `/private/tmp/canvas-search-room-census-021d0d6u`: Observer56 bestanden, ältere Generation-Fixture fehlte ein heutiger Admission-Adapter (`openDb`). Unveränderte Originalbytes von Server und Test aus HEAD reproduzieren denselben Fehler in `unchanged-baseline-with-runtime.original.log`; der erste private Baselineversuch fehlte seinerseits den tatsächlichen Python-Lockhelper und bleibt getrennt erhalten.
- `/private/tmp/canvas-search-room-census-final-3y6a3xaj`: Nach erstem Fixtureabgleich fehlte noch der Lifecycle-Kontext. Die Fixture verwendet nun den echten ALS-Kontext; SQL-/Admission-/Historien-/Recovery-Abhängigkeiten sind ausdrücklich kontrollierte Teststubs. Diese alten Lifecycleprüfungen sind keine echten SQL-/Auth-/Ownernachweise. Keine ursprüngliche Produktassertion wurde entfernt.
- `/private/tmp/canvas-search-room-census-verified-p9o2npcs`: Observer/Generation bestanden. Die alte Lifecycle-Fixture hielt den tatsächlichen Workspace-Lock und wartete gleichzeitig auf eine Raumöffnung, die der aktuelle Server erst hinter demselben Lock beginnt. Der Prozess beendete sich selbst am echten 30-s-Locktimeout, bevor ein Signal gesendet werden konnte. Seine eigene DATA-Fixture liegt mit identischem Device/Inode privat unter `retained-failed-lifecycle-data`; sie ist erhalten, nicht als gelöscht ausgewiesen. Der korrigierte Test prüft vor Freigabe erste Autorisierung sowie null Öffnungen/Admission/Apply und anschließend weiterhin Raumöffnung und Rechteentzugs-Rejection.
- `/private/tmp/canvas-search-room-census-acceptance-wrv9gdzu`: Verhalten bestanden, vollständiges TypeScript beanstandete zwei BigInt-Literale beim bestehenden Compilerziel. Gleicher unbegrenzter Zähler verwendet jetzt `BigInt(0)`.
- `/private/tmp/canvas-search-room-census-closed-fkmy24qj`: Erste vollständige vierteilige Queue bestanden. Die zusätzliche unveränderte Zweimodul-Gegenprobe `cross-copy-red.original.log` bestätigt danach eine nicht lokal erkennbare Fehlerklasse (56/57). Exakt dieser Gegenfall besteht nach lokaler Fehlernormalisierung unverändert in der finalen 57er-Matrix.

Der frische GitNexus-Indexversuch `/private/tmp/canvas-document-search-index-hp_s_a0p` endet tatsächlich mit Exit 1 (`LOWER: Invalid UTF-8`), bei unveränderten Quellen. Der vorhandene Index bleibt abfragbar. `createCollaborationServer` meldet LOW/einen direkten Aufrufer; sein Ausgangscode ist gegenüber dem indexierten Stand bytegleich. Neue Census-Symbole sind ausdrücklich UNKNOWN/unindexiert. Die allgemeinen Testnamen `main`/`harness` melden CRITICAL mit einer teilweise leeren direkten Kante; die tatsächlichen Quelleneinstiege und Packageaufrufe wurden gesondert geprüft, die Warnung nicht als Freigabe behandelt.

## Verbindliche Fortsetzung und aktueller main

Die gemeinsame Suche bleibt offen: dauerhafter nativer Korpus, physische Ressourcen, aktuelle Owner-/Versionen, brauchbares Ranking, deterministische Seiten und ehrliche Coverage werden mit den echten Web-/MCP-search-/PI-Principals verbunden und anschließend über die tatsächlich konsumierten Clients geprüft. SDK, Standard-Skill und PDF/Create/Edit folgen weiterhin dem Gesamtplan. Dateiaktions-Undo und Review Center bleiben ausgeschaltet.

Nutzerergänzung: Vor Skill-/Pluginumsetzung den neuesten `main` erneut lesen und an Integrationspunkten nachholen. Beide Remotes wurden tatsächlich frisch gefetcht: Notebook `67c509c08a204b7481fa063cf5de007de8538dd4`, Marketplace `54ce6573502f67f4cb6227871000aa315ab87dbe`. Dies ist ein Ref-/Quellenabgleich, noch kein Merge dieser Änderungen in den Yjs-Branch. Aktuelle vereinigte Extension-/Skill-Discovery und Standardauslieferung müssen wiederverwendet und der vorbereitete Documents-Kandidat daran neu geprüft werden. Keine Veröffentlichung, kein Push, PR, Containerbau oder Rollout in diesem Schritt.
