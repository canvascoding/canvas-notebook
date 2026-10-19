# Raw-Move/Delete: interner atomarer Originalimport

Stand: 20. Oktober 2026. Geprüfte Arbeitsbasis Root `a518f9cae` plus die unten exakt gepinnten Änderungen. **Interner B0-Teilschritt abgenommen; öffentlicher Apply-/Status-/Recoveryanschluss, M1 und MVP bleiben offen.** Produktionsaktivierung und Dateiaktions-Undo bleiben aus; Review Center bleibt außerhalb des Umfangs.

## Verhalten und echte Grenzen

`prepareWorkspacePathImportsOnConnection` übernimmt einen vollständigen vorbereiteten Originalimport auf der tatsächlichen, vom Aufrufer gehaltenen PostgreSQL-Transaktion. Echte Request- oder MCP-Move/Delete-Principals, aktuelle Rechte, privater Lifecycle-Owner, Backend/Schema/XID, Original-FD/Bytes und das vollständige Quelleninventar bleiben gebunden. Die feste private Import-Capability entsteht nur während dieses Ablaufs und wird nicht ausgegeben. Der zentrale vorhandene Importkern erzeugt tatsächliche Dokumente und Linkreferenzen; ein wirklich vorhandener noch nicht initialisierter Registereintrag behält seine ID.

Alle erforderlichen Importe und der unveränderliche Elternbeleg werden auf derselben Transaktion angelegt. Nach tatsächlicher Linkbindung entsteht ein frischer Native-Plan. Ohne verbleibende Physicals verwendet er den bestehenden Identity-2-Vertrag; mit solchen Lesern ausdrücklich Identity 3. Unveränderte Physical-Vorkommen werden über vollständige Original-/Profil-/FD-/Occurrencefakten verbunden, während ausschließlich katalogbedingt neu abgeleitete IDs wechseln dürfen. Eine neue additive Tabelle und ihr unveränderlicher SQL-Guard speichern Originalbeleg und vollständige Importkohorte. Historische Wiederholung unter aktueller SID-B liefert den ursprünglichen Beleg mit ursprünglicher SID-A; der Reader übernimmt keine heutigen Dokumentzustände oder Ersatzdateien.

Der Aufrufer besitzt BEGIN/COMMIT/ROLLBACK. Dieser Teilschnitt legt keinen öffentlichen Batchclaim und keine spätere Zulassungs-/Projektorsperre an, führt keine Dateiaktion aus und schreibt keine Markdownprojektion. Der echte spätere Native-Move im Historienfall ist ausschließlich Testaufbau für veränderten Folgezustand. Er ist kein Nachweis eines neuen vorbereiteten öffentlichen Apply-Ablaufs. Die SQL-Nichtleseprüfung der Historie beginnt nach den bestehenden aktuellen Room-/Lifecycle-Prüfungen des äußeren Guards; sie ist kein instrumentierter Ausschluss aller OS-Leseaufrufe.

## Tatsächliche Prüfung

| Folge | Ergebnis |
| --- | --- |
| Gezieltes TypeScript / ESLint | Exit 0 / 0, ohne Warnung |
| Neue echte B0-/PG18-/FD-Folge | 9/9, zweimal vollständig auf den jeweiligen gepinnten Ständen |
| Vorhandene reine Vorbereitung | 14 Familien |
| Vorhandener tatsächlicher Raw-Copy-Owner | 8 Gruppen |
| Vorhandener expliziter Originalimport | 7 Gruppen |
| MCP Read / Create / Edit-Principals | 20 / 8 / 9 Gruppen |
| MCP Copy / Move+Delete-Principals | 9 / 12 Gruppen |

Die Neunerfolge enthält ausgewähltes Raw mit notwendiger unselektierter eingehender Raw-Linkänderung, Delete-Unlinkplanung, vorhandene Pristine-ID und echte Dateimode 0444, vollständiges Caller-Rollback, aktuellen Rechteentzug, echte spätere Dateiversion, falsche/gefälschte Capabilities und direkte Importverweigerung ohne SQL. Der Historienfall verwendet tatsächlichen späteren Native-Move, veränderte eingehende Native-Sequenz, ungültige UTF8-Ersatzbytes am alten Pfad und eine echte neu angemeldete SID-B. Zusätzlich bleiben unselektierte physische Links nach dem katalogverändernden Import unverändert; die Datei wird weder importiert noch verändert. Die erste Move-Probe verwendet absichtlich umgekehrte Selection-Propertyreihenfolge wie kanonisch gespeicherte Pläne.

Erhaltene REDs: `run1` scheitert ausschließlich an zwei neuen TypeScript-Formfehlern; `run2` und die diagnostisch ergänzte `run3` reproduzieren den echten SQL-Fehler `42883: function pg_catalog.unnest(text[], text[]) does not exist`. Der enge Fix verwendet `ROWS FROM` mit zwei echten einzelnen `pg_catalog.unnest`-Aufrufen. Quellenreview korrigiert zusätzlich katalogabhängige Physical-IDs und die Selection-Propertyreihenfolge vor dem bestehenden Actionhash. Dafür werden keine historischen Hashalgorithmen geändert.

`run4` besteht Typen/Lint und die neue Neunerfolge. `run5` besteht diese Folge erneut über den gemeinsamen vorhandenen ESM-Runner sowie alle genannten Regressionen bis zur Copy-Principals-Vorbereitung. Diese Vorbereitung scheitert vor dem ersten Principal-Fall an macOS `/var` als Symlinksegment im temporären DATA-Pfad (`WorkspaceStarterDocumentError / invalid-source`). `run6` verwendet den tatsächlich aufgelösten temporären Pfad über TMPDIR, weiterhin mit eingeschaltetem echten Testkern; dieselben unveränderten Produkt-/Testquellen bestehen Copy 9/9 und Move+Delete 12/12. Kein Guard wird gelockert, kein Fall übersprungen und keine Uhr/Auth/SQL-Antwort ersetzt. Der gesamte `run5`-Exit bleibt historisch ausdrücklich 1.

Zwischen `run5` und `run6` sind alle **4.176** Quellenpins bytegleich; beide Läufe verändern keine dieser Quellen. Sechs unabhängige Ressourcenprüfungen der echten Metadata-Owner-Läufe bestätigen entferntes eigenes Schema/OID, geschlossene eigene Backends, entferntes DATA, beendeten Originalprozess sowie dieselben vier gesunden verwalteten Dienste. Die zusätzliche unabhängige RO/RR-/unassigned-XID-Prüfung bestätigt alle fünf erfassten Principal-Fixture-Ressourcen einschließlich des fehlgeschlagenen Copy-Aufbaus und zehn entfernte ESM-Verzeichnisse. Read-Principals meldet seinen separaten eigenen Ressourcenabschluss. Es wurde kein Container gebaut oder neu gestartet.

## Originalbelege und Quellen

Private Originale: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-path-b0-cbnqabc5`. `run1` bis `run6` behalten jeweils Controller, Quellenpins, Ausgaben und echte Terminalcodes. Ressourcenbelege liegen bei ihren jeweiligen Läufen; `final-regression-resource-report.json` bindet die gleiche Quellenbasis und den zusätzlichen Abschluss. Die durch GitNexus gemeldeten Risiken des gemeinsamen Importkerns (HIGH), der gemeinsamen MCP-Phase und des Migrationsstarts (CRITICAL) wurden vor der Änderung gemeldet; diese Einstiege werden durch die obigen tatsächlichen Regressionen mitgeprüft. Neue Symbole sind im frischen Ausgangsindex UNKNOWN und damit keine Sicherheitsfreigabe. Der erste Root-Änderungsabgleich liegt unter `root-detect-changes.json`; er erfasst die fünf bereits getrackten Dateien, neue Dateien benötigen zusätzlich den abschließenden Stage-/Quellenabgleich.

| Quelle | SHA-256 |
| --- | --- |
| `app/lib/files/workspace-path-import-preparation-phase.ts` | `2e5a94e43022cc3c6efdc79f17b85dc86df2dbacf4dbd51dd5485f9a5af2ce1d` |
| `app/lib/files/workspace-path-import-preparation-record.ts` | `6d410f0091fc1ffb835cb6445979079b315df730ae34567bf26eeb93db8f4e43` |
| `app/lib/db/workspace-path-import-preparation-migration.ts` | `89835b509f7feedbb603698cb034f89cab3f0c56cd2ace4051c9f567c4200bde` |
| `app/lib/collaboration/markdown-file-import-persistence.ts` | `6296f1d9e28f341159eaeeabd85d5095b4f00fff9459cf3cfcf4c99af43b6ba6` |
| `app/lib/files/workspace-file-lifecycle-guard.ts` | `ad7e9120433f1783a96785fc346b3b666286189e03a719b37db20d8302eab5f4` |
| `app/lib/mcp/server/document-read-principal.ts` | `ab7bfc974d5e79fc35fd145ddfda79a7d80e515e0ecf6d650b0a98cd0b17a760` |
| `app/lib/db/postgres.ts` | `14b0f31ff416ac586f6bec50812118fe8e2e736708975210df33505c96e165f9` |
| `scripts/workspace-path-import-preparation-phase-postgres-test.ts` | `2f0f54e4192e38f8f8db85be2ad091709332500aafa7afac8d8096db4b8e1dde` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `d687c60f3d3820d2df3412090b6d9adaccb014c1ac24b7646f1d0f9f9b82e947` |

Terminal `run5`: `4cb96c4cb205547a10c02cb0fd6ef5fab46ca0e98678ecf5ac086d38d3cbdd1e`. Terminal `run6`: `603275d03c0e6aa805ba8ba790f537aeecf656c745eac064bdaf984fb2e821bd`. Unabhängiger gemeinsamer Abschluss: `c091e269c0f393f8cb1dc1c749bf4960ecdf5f3d7d8b3889b9cbbec9fbf907e2`.

## Verbleibender MVP-Anschluss

Der öffentliche Koordinator muss Originalpreview-ID, diese Vorbereitung und den späteren Native-Plan dauerhaft derselben Operation zuordnen. Import, tatsächliche Batchvorbereitung/Claim, Zulassung und Projektionsschutz müssen gemeinsam bis zum bestätigten Commit und zur ursprünglichen Wiederaufnahme abgesichert werden. Verbleibende Physical-Parser-3-Evidence muss im tatsächlichen späteren Owner ausdrücklich mit derselben Version gelesen werden; historische Parser-2-Verträge bleiben erhalten. Erst danach tatsächliche öffentliche Apply-/Status-/Recover-/Bestätigungsverlustproben samt zentraler Links durchführen. M2 (interner Create, Linux/CI, Aktivierung) und M3 (finaler Build/UI/API/MCP/Regression/PR) bleiben offen.
