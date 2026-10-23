# Historischer M3-/29-Fälle-Vorbereitungsindex

Historischer Stand: 20. Oktober 2026. Die nachfolgenden M3-/29-Fälle-Belege behalten ihre ursprünglichen Quellen- und Laufbindungen; sie sind keine aktuelle 94/23-Gesamtabnahme. Maßgeblich sind der [aktuelle MVP-Abnahmeindex](./yjs-mvp-tool-and-restore-acceptance.md) und die [aktuelle E2E-Matrix](./yjs-mvp-e2e-matrix.md). A4- und EB9-MCP10 bleiben separat bestanden; UI76 auf A4 RED49/1/26 und EB9 RED62/2/12 bleibt jeweils trotz geschlossenem Ressourcenbericht rot. Produktstand `7c24a631860787d668aea288b6573d7a48e3b6f0`: Die funktionale MVP-Abnahme ist im unveränderten Umfang mit 94 bestandenen Fällen in 23 ganzen Specs abgeschlossen: originale8e2-MCP10/1 und UI67/17 werden aufgrund belegter Produkt-/Orakelparität wiederverwendet (77/18); auf7c24 sind Rest-UI9/3 sowie Restart2/1 und REST6/1 neu bestanden (17/5). Dies ist die ausdrücklich erlaubte Komposition mehrerer echter Läufe, kein einzelner frischer Whole94-Lauf. Der ursprüngliche8e2-UI76-RED67/3/6 bleibt unverändert. Rest-UI9 endet mit Original4778/49c0a6 Exit0,9/9 und14/14 Abschlusschecks. Die gemeinsame remaining10-Runtime endet mit Original33018/94b3ac Exit0,10/10 und14/14 Abschlusschecks: Restart2 zuerst mit zwei echten Neustarts, danach REST6 und zuletzt Metadata2. Nur die acht Restart-/REST-Fälle zählen zu94; Metadata2 ist ein bestandener Zusatztest. PI12 ist zusätzlich12/12 bestanden und unabhängig geschlossen; verpasste optionale Anfangsidentitäten bleiben NULL. Maßgeblich sind der aktuelle Abnahmeindex und die E2E-Matrix mit tatsächlich gebundenen Originalen. Die vier von Root visuell geprüften Bilder bleiben Originalaufnahmen von8e2 mit belegter Produktparität, keine neuen7c24-Aufnahmen. Der Code-CI-Snapshot auf7c24 ist mit sieben erfolgreichen Checks abgeschlossen. Er nimmt den späteren Dokumentations-Head nicht vorweg: dessen erforderliche CI, vollständige Reviews, Main-Frische und tatsächlicher Merge/Remote-Main-Abschluss sind über [PR #176](https://github.com/canvascoding/canvas-notebook/pull/176) noch frisch zu prüfen. Keine Main-/Produktionsfreigabe oder künftige Commit-/Merge-SHA wird vorweggenommen.

## Unveränderter Produktkern, ergänzte Raw-Web-Prüfung

`direct-mcp-native-create-import.spec.ts` erhält genau einen zehnten Fall und zwei Fixture-/Beobachtungshelfer. Alle neun bisherigen Fallkörper, Hooks, Auth-/Recovery-/Native-Inhaltsorakel bleiben bytegleich. Die ursprüngliche vollständige Spec lässt sich durch Entfernen der zwei additiven Quellblöcke exakt mit SHA-256 `b6074d6870ed21c2c2e46a075bcdb5e77c3f6e7ae3463d7d119396c5d45e7908` rekonstruieren.

Der neue Fall führt Move und Delete über die tatsächlichen Browserdialoge aus. Zwei disjunkte rohe Markdownpaare im eigenen, über echtes HTTP angelegten Workspace verhindern, dass der Delete-Arm versehentlich bereits native Quellen prüft. Originalbytes entstehen ausschließlich als kontrolliertes Fixture mittels exklusiver NoFollow-FDs; keine Autoritätszeile, kein Produktionsseed-Endpunkt und keine Authumgehung werden angelegt. Vor Preview wird kein Raw-Editor geöffnet.

Je Aktion: echter nicht importierender Preview mit zwei Imports und einem Rewrite/Unlink; unveränderte benannte Dokument-/Operationszeilen samt xmin und beide Originaldateien; Apply mit ursprünglicher Preview-ID und echter Client-Operations-ID; tatsächliches Mapping auf nativen Plan/Batch und originale Sitzung; stabile IDs/Lineages, vollständiger nativer JSON-/Markdowninhalt sowie sichtbarer Editor und Reload aller drei überlebenden Dokumente. Nur generierte Block-IDs werden in die unabhängig geparste Erwartung eingebunden. Das gelöschte Ziel wird über ursprüngliche Importidentität, Lineage, Archivierung und aktiven ID-Read mit 404 geprüft, nicht durch einen erfundenen aktuellen Archiv-Volltextread.

NoWrite bedeutet hier die acht benannten Dokument-/Operations-/Projektions-Tabellen und zwei ausgewählte Originaldateien pro Vorschau. Kein vollständiger SQL-Wire-/All-DATA-Nachweis und kein Recovery-/PDF-/SDK-Lifecyclezusatz wird aus diesem Fall behauptet. Eigene Seiten und Workspace werden auch bei Fehlern geschlossen. Review Center und Datei-Undo bleiben aus.

Unabhängiger Quellenreview ohne konkreten P1/P2. Drei neue Symbolimpacts wurden vorab mit UNKNOWN/not-found versucht; dies ist kein Sicherheitsurteil. Tatsächliche erste Typprüfung fand eine fehlende Typannotation im neuen Test (TS7022); der erhaltene RED ist keine Produktregression. Ausschließlich `found: Row[]` wurde ergänzt. Danach: TypeScript Exit 0 / 18,146 s, ESLint Exit 0 / 2,048 s, reine Collection genau 10 Fälle Exit 0 / 0,802 s. Keine Browserausführung wird daraus abgeleitet.

## Historische geplante Laufmatrix der M3-/29-Auswahl

| Serielle eigene Runtime | Spec | Tatsächlich deklarierte Fälle | Erwartete Hostneustarts |
|---|---|---:|---:|
| MCP/API und Dateiaktionen | `direct-mcp-native-create-import.spec.ts` | 10 | 0 |
| Manuelle Neuanlage/Paste/Import | `editor-create-paste-import.spec.ts` | 15 | 0 |
| Verlorene Create-Antwort und Recovery, in derselben manuellen Runtime | `editor-manual-create-recovery.spec.ts` | 2 | 0 |
| Dauerhaftigkeit bei Graceful/Crash-Neustart, separate Runtime | `editor-yjs-owned-restart.spec.ts` | 2 | 2 |

Die 19 vorhandenen manuellen Fälle wurden zusätzlich tatsächlich gesammelt, Exit 0, Quellpins vorher/nachher gleich; noch nicht ausgeführt. **Die MCP-Folge allein prüft kein manuelles Create/Clipboard-Paste.** Die vorhandenen separaten Suiten schließen diese Abdeckung und behalten alle Fälle einschließlich Peer-/Text-Undo-/Reconnectgrenzen bei. Text-Undo im Editor ist vom abgeschalteten Dateiaktions-Undo getrennt.

Der bestehende Supervisor bleibt unverändert: ein eigener kompilierter Host, je Runtime eigene noncegebundene PG18-Notebook-/Issuerdatenbanken, ein Browserworker, null Retries/Skips, keine Testcontainer. Vor jeder nächsten Runtime müssen Originalprozess und eigene DBs/DATA/Lock beendet und unabhängig geschlossen sein. Derselbe frische Build und dieselben eingefrorenen Root-/QA-/CP-HEADs gelten für alle drei Runtimes. Der installierte Python-Client in bestehendem Fall 7 wird frisch gegen sein wirklich installiertes Wheel und den Probehelper gebunden; daraus folgt keine Veröffentlichung des SDK.

## Quell- und Vorbereitungspins

| Quelle | SHA-256 |
|---|---|
| `tests/direct-mcp-native-create-import.spec.ts` | `80cef0d0497c3cef044f8e244ec977bdfb241308944b757d7db05329ab80470c` |
| `tests/editor-create-paste-import.spec.ts` | `ed85abbbd65a2f5e10dd909b93372f773dde969363d16f9170297658de768586` |
| `tests/editor-manual-create-recovery.spec.ts` | `170532df4fc87d82b4beb2030db9b44b12361439281e350b9d6b1df404dd702b` |
| `tests/editor-yjs-owned-restart.spec.ts` | `d657f906b7021a82c9db8db546f7f3863f2bd5b6605585dcb7c031c77f52870b` |

Private neue Raw-Web-Autorenoriginale: `/private/tmp/canvas-m3-raw-web-candidate-20261020`. Tatsächliche statische RED-/GREEN-Originale unter `raw-web-spec-static` / `raw-web-spec-static-final`, zusätzliche Collection unter `manual-suite-collection`, jeweils in `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m3-legacy-close-x5x_tco0`.

| Original | SHA-256 |
|---|---|
| `raw-web-spec-static/terminal.json` | `d1baad4346c13f7bdbc64e0adf15fc1e0551ece1cfc23f21a0a2e0ee2adb604e` |
| `raw-web-spec-static-final/terminal.json` | `53badb09500c33bf1bbd1643651129fdf51bbb64931b1bc548243b5b4037dcea` |
| `raw-web-spec-static-final/collection.log` | `f92dc2a84f6f3cd387079df2d535da9a222b7dc009d138dcfa5eb1d4b74a4c6d` |
| `manual-suite-collection/terminal.json` | `4259540c84f74dba41ee8a5740e793c0676450bfe9dd0a3d373611df79d20e2b` |

## Zwei tatsächliche Buildabbrüche und gezielter Tracing-Fix

Beide Originalbuilds verwenden denselben eingefrorenen Root `d4cae9ed3ac6c6bf17590cea3b7f731483c954f2`, QA `b72546589faebe1ced79d559287eac3fd5cfe741` und CP `27c8ce37da082244f006ca376068cde6b98845d5`. Der zweite Lauf begann nach Ende der ersten eigenen Prozessgruppen mit rund 40 GiB freiem Hostspeicher; keine fremden Dienste wurden gestoppt. Code, Buildkonfiguration, vier native Worker und Fristen blieben unverändert. Dies beweist keine Speicherursache.

| Tatsächlicher Build | Originaldauer | Ergebnis | Beobachteter Fortschritt |
|---|---:|---|---|
| Erster Lauf | 1513.504 s | Original Exit 1; Release-Timeout 124, Next SIGTERM 143 | Kompilierung 21,9 min; kein vollständiger Cacheabschluss |
| Unveränderter Wiederlauf | 1508.079 s | Original Exit 1; Release-Timeout 124, Next SIGTERM 143 | Kompilierung 20,2 min; Cache-Schreiben 4,1 min, Ende dennoch jenseits Compilefrist |

Die Routentabelle und die Kompilierungsmeldung sind kein erfolgreicher Gesamtbuild. In beiden Fällen wurde kein neuer Buildnachweis veröffentlicht; die Queue beendet sich vor Artefakt-/Browserstart mit `results: []`. Keine aktuelle Runtime und keiner der 29 Fälle wird als ausgeführt oder bestanden bezeichnet. Nach dem Wiederlauf sind die benannten ursprünglichen PIDs/Prozessgruppen beendet und die vier verwalteten Dienste gesund; daraus folgt kein umfassender Fremdprozesszensus.

Turbopack meldet genau einen zusätzlichen Whole-Project-Tracing-Einstieg gegenüber dem früher erfolgreichen Build: `fs.realpath(appRoot())` bei der Root-Manifestprüfung des Skillprozesses. Bereits 52 solche Stellen bestanden vorher. Ein zusätzlicher Einstieg ist belegt, zusätzliche eindeutige Dateien und eine Zeit-/Speicherkausalität nicht. Der vom tatsächlichen Warntext vorgesehene Kommentar `/* turbopackIgnore: true */` begrenzt ausschließlich diesen Einstieg. Kanonisierung, Symlink-/Regular-File-Prüfung und die Freigabe genau der öffentlichen Manifestdatei bleiben identisch; kein Verzeichnis wird freigegeben. `Dockerfile:248` liefert `/app/package.json` unabhängig vom Filetracing, `CANVAS_APP_ROOT=/app` ist separat gesetzt. Andere Distributionswege und beliebige Root-Overrides sind damit nicht geprüft.

Vorher SHA-256 `4ebfcfc96d2630ffd2f882b31f8cedd288f0a78db2d26ef98f530c31ec006297`, danach `35a72928cae583fad017b238f9b1503341d7f59aa6f08b299c42f6281a7c7afd`. Entfernen exakt dieses Kommentars stellt die Originalbytes wieder her. Tatsächlicher TypeScript-Transpilevergleich ohne Kommentare liefert byteidentisches JavaScript, Exit 0 / 0,250 s. Gezielte Typprüfung des Produktpfads einschließlich Imports Exit 0 / 18.887 s, Scoped-Lint Exit 0 / 1.759 s. Beide GitNexus-Impacts vor Änderung: HIGH, acht Symbole, zwei direkte Aufrufer, null indizierte Prozesse; vorab gemeldet. Unabhängiger Quellenreview ohne konkreten P1/P2. Kein Build- oder Performance-Erfolg wird daraus abgeleitet.

Der zusätzlich ausgeführte Standard-Typcheck mit allen Skripten endet separat mit Exit 2 nach 80,942 s: 90 Diagnosen ausschließlich unter `scripts/`, keine im geänderten Runtimepfad. Dieser breite Lauf ist nicht grün und wird nicht durch das gezielte Ergebnis ersetzt. Eine Einordnung als ausschließlich von Main geerbt ist damit nicht belegt. Der tatsächliche Release-Typcheck besteht inzwischen im folgenden dritten Originalbuild. Der breite Standard-Typcheck wird dadurch nicht als grün bezeichnet.

Private Originale: erster Controller `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m3-launch-controller10-ogtssyem`, zweiter Controller `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m3-launch-controller10-retry-n_8vzwur`, Korrektur und tatsächliche statische Läufe `/private/tmp/canvas-m3-tracing-fix-20261020`.

| Original | SHA-256 |
|---|---|
| Erster Buildterminal | `ae4c523af85bb27e9b39b5486740a9f8493af68697aa49605f1bd9b777e4c88e` |
| Zweiter Buildterminal | `bd398e5b08fc037feeabbf17d6a19de3e7927c326a3a2733279808c55a01f0ed` |
| Zweiter Queueterminal | `fc8b588b38f2bba3b69b28cc01fc71e0aa1a3fb072a83f4c10bd882188ac7382` |
| Zweiter Produktionslog | `f6462451138cf1b16d398a21fa28b30b74e444825195e1f84f47a4eb1f8ebb62` |
| Gezielter Typ-/Lintterminal | `9b07d96d900e064b66e3b1e5bece55650dfb8ddf41b794b70fa0fc3f40142358` |
| Breiter Standard-Typterminal | `63ce670a4d48349bdd4c57600a5194190da535c8bc66388d81e5c546bd0acfa4` |
| Beendete benannte Buildressourcen | `bf3e71e12c79f5288dae59d452dbd0e5065601a025e60a877ad8c166d66fc32b` |

## Dritter Build: Releasephasen bestanden, Artefaktprüfung blockiert

Eingefrorene Heads Root `b830fde99f8ef0b28e296e6f1b801177545c0c6d`, QA `967734e646ef2a499357d46fe47fdd1f3dfb9ed9`, CP weiterhin `27c8ce37da082244f006ca376068cde6b98845d5`. Der originale Owned-Build endet tatsächlich mit **Exit 1 nach 482,583 s**, ohne freiwillige Unterbrechung. Compile endet nach 404 s mit Exit 0, Release-Typecheck und Generate bestehen, anschließend besteht der Produktionsmodultest. Beim vollständigen kompilierten Artefaktfingerprint scheitert der unveränderte Supervisor jedoch mit `Compiled artifact visit limit exceeded.` an seiner 100.000-Einträge-Grenze. Die unabhängige reine Strukturinventur zählt 102.642 Einträge (100.898 Dateien, 1.726 Verzeichnisse, 18 Symlinks). Sie ersetzt keinen akzeptierten bytegebundenen Fingerprint.

Die Queue endet korrekt vor Runtime 1 mit `results: []`; kein aktueller Browserfall wurde gestartet. Alle direkten Serverchunk-Dateien tragen Zeiten aus diesem Build. Ob vorhandener Turbopack-Cache den großen Output beeinflusst, ist damit ungeklärt. Deshalb wurde nach Ende der ursprünglichen Gruppen das gesamte vorige QA-`.next` inklusive Cache durch Rename unter Erhaltung seiner Verzeichnisidentität außerhalb des Projekt-/Tracingroots gesichert. Das neue QA-`.next` ist leer. Ein tatsächlicher vollständiger Kaltbuild mit unveränderten Limits steht aus; keine Kapazitätsgrenze wurde erhöht oder Artefaktkategorie übersprungen.

Originalcontroller: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m3-launch-controller10-tracing-jmv5qn40`; Originalbuildroot `canvas-yjs-build-RMh626` im selben privaten Temp-Verzeichnis. Originalbuildlog SHA-256 `067a41da351c9dffad151d69c62246e9937fed75284315cf8a5887280c449a1b`; Produktionslog `9772b943e52dc5ec528f89c02d64cbbdd9a63f16a18a5d192711da56325c38fd`. Read-only-Fehlerreproduktion und Inventare: `/private/tmp/canvas-m3-tracing-fix-20261020`; reversible Cachevorbereitung: `/private/tmp/canvas-m3-file-test-reconciliation-20261020/cold-build-preparation.json`.

## Laufende Anpassung bestehender Dateiaktionstests

Acht ältere Skripte enthalten 21 der 90 Diagnosen des breiten Standard-Typchecks. Explizite echte Versionsassertionen, passende Plan-/Stage-Eingabetypen und erhaltene Compilerunions schließen ihre veralteten Typannahmen. Im vollständigen Copy-Owner hatte das erste Raw-Starter-Orakel noch eine Importablehnung erwartet; der aktuelle zentrale Plan 5 sieht bereits einen nicht ausführenden Zielimport vor. Der tatsächliche unveränderte Vorlauf bestätigt den alten Erwartungsfehler mit Exit 1. Der neue Test prüft Plan, Originalbytes, Parser, Namespace sowie vollständige Datenbank- und DATA-Unverändertheit.

Der erste echte Authabruf erzeugt JWT-Schlüssel und erneuert die künstlich kurzlebige Fixturesitzung. Die echte zentrale Workspace-Sperre erzeugt beim ersten Erwerb ihre dauerhafte private Lockdatei. Deshalb werden dieselbe echte Sitzung mit geprüften Benutzer-/Sitzungs-IDs und derselbe echte Kernel-Lock vor den vollständigen Snapshots vorbereitet. Kein Preview wird vorgewärmt, keine Tabelle oder DATA-Datei ausgenommen. Der aktuelle Raw-Previewfall besteht. Die vollständige 26er-Folge ist noch nicht bestanden: Ein zu kurzer äußerer Ad-hoc-Watchdog brach sie nach 180 Sekunden und zwölf bestandenen Gruppen ab; der frühere vollständige Lauf dauerte tatsächlich 630,002 Sekunden. Original-RED bleibt erhalten, exakt zugeordnete eigene Ressourcen wurden anhand Schema/OID/Marker und Dateiidentitäten entfernt. Ein vollständiger Wiederlauf mit passendem äußerem Testbudget sowie sieben weitere bestehende Programme bleiben erforderlich. Produktfristen, Buildlimits und Schutzorakel sind unverändert. Private Originale: `/private/tmp/canvas-m3-file-test-reconciliation-20261020`.

## Sechs bestehende Programme aktuell bestanden; Copy-/Delete-Abschluss offen

Die anschließende tatsächliche serielle Folge auf demselben unveränderten Produktkern besteht für sechs der sieben zunächst angesetzten Programme. Quellenpins bleiben vor/nach jedem Lauf identisch. Alle folgenden Originalprozesse enden mit Exit 0, ohne Signal oder Timeout; ihre vorhandenen eigenen Cleanup-Assertions bestehen. Die unabhängige gemeinsame Browser-/Runtimeabnahme wird daraus nicht abgeleitet.

| Tatsächliches Programm | Umfang | Dauer |
|---|---:|---:|
| Direkter MCP-Copy-Owner | 10 Gruppen | 144,365 s |
| Managed-Copy-Stage | 7 Gruppen | 28,332 s |
| Native-Copy-Metadaten | 15 Gruppen | 97,580 s |
| Native-Copy-Compiler | 29 Node-Tests, null Skips | 9,102 s |
| Direkter MCP-Move/Delete-Owner mit echten Live-Rooms | 16 Gruppen | 338,422 s |
| Gemischter Move | 6 Gruppen | 40,914 s |

Die vollständige gezielte Typprüfung aller acht bearbeiteten Skripte besteht davor mit Exit 0 / 19,639 s, ESLint mit Exit 0 / 2,351 s. Diese sechs abgeschlossenen Skriptkorrekturen enthalten echte enge Versionsassertionen beziehungsweise passende Plan-/Stage-/Compiler-Eingabetypen; kein Produktkern wurde dafür geändert.

Das siebte angesetzte Programm, Native-Delete-Links `--success`, endet nach 11,806 s mit Exit 1 und sauberem eigenem Cleanup. Der anschließende Source-Review zeigt veraltete V3-only-Intent-/Completion-Erwartungen gegenüber dem heutigen Evidence-V2-Pfad mit V4 und Admissionbindung. Dessen enge Testkorrektur und sämtliche vier Delete-Gruppen bleiben noch tatsächlich zu prüfen. Der vollständige Copy-Owner26 bleibt nach dem separat erhaltenen äußeren Timeout ebenfalls offen. Der geplante erneute breite Standard-Typcheck wurde nach dem Delete-RED nicht ausgeführt; weiterhin keine Behauptung eines grünen Gesamttypchecks oder einer bereits bestätigten Reduktion auf 69 Diagnosen.

Originalfolge: `/private/tmp/canvas-m3-file-test-reconciliation-20261020/verification-remaining-v1`, Bericht `terminal.json`, tatsächliche Einzelergebnisse/Loghashes und vollständige unveränderte Testquellenpins darin. Die eigentlichen Build-/29-Browser-/CI-/Review-Gates bleiben bestehen.

## Aktueller Abschluss der Dateiaktionsregressionen und Main-Typvergleich

Die vorherigen RED-Abschnitte bleiben mit ihrem damaligen Quellen- und Laufstand erhalten. Der folgende Abschluss gilt für die tatsächlich beendeten neuen Originale auf Root `0db0ab9c215485fd6a35cb8c0fdf109933a9f97b` / QA `f761b9b388c69187b8d45e7bd275063c891a8f5a`. Die vollständigen Quellfingerprints jedes Checkouts bleiben vor/nach identisch: Root `220521272423c53df3f6911d34fe7bfc4650132e4573d9860ae2be1a8f8cff67`, QA `7c90ce3b5c4448d3c15db94477ce0edfbb0fa776e7b09ced72c93d84d3f5b41c`.

Die erneute gezielte Typprüfung aller acht bearbeiteten Skripte endet mit Exit 0 / 19,312 s, ESLint mit Exit 0 / 2,339 s. Alle vier tatsächlichen Native-Delete-Link-Folgen bestehen mit jeweils zwei Personal-/Team-/Cookie-/Bearer-Familien. Der Test prüft jetzt exakt V4 samt echtem gespeichertem Admissionheader. Sein Connection-Orakel erfasst jeden tatsächlichen History-/Admission-/Owner-Checkout statt einer veralteten globalen Ein-Verbindungs-Annahme; ein Close zählt erst nach abgeschlossenem tatsächlichem Close. Gleichzeitig auftretende Primär- und Cleanupfehler bleiben erhalten. Link-, Inhalt-, Actor-, Recovery-, Fault-/COMMIT- und vollständige Cleanuporakel bleiben bestehen; kein Produktkern wurde dafür geändert.

| Tatsächlicher neuer Originalprozess | Umfang | Exit | Dauer |
|---|---:|---:|---:|
| Native-Delete-Links `--success` | 2/2 Familien | 0 | 29,898 s |
| Native-Delete-Links `--drift` | 2/2 Familien | 0 | 17,177 s |
| Native-Delete-Links `--rollback` | 2/2 Familien | 0 | 33,281 s |
| Native-Delete-Links `--ack` | 2/2 Familien | 0 | 25,488 s |
| Vollständiger Native-Copy-Owner | 26/26 Gruppen | 0 | 617,534 s |

Alle fünf Prozesse enden ohne Signal oder Timeout. Die vier Deleteprogramme bestehen ihre vorhandenen eigenen Cleanup-Assertions. Für den Copy-Owner bestätigt ein zusätzlicher unabhängiger lesender Nachcheck exakt eigenes Schema/OID/Marker und Sessions, ursprüngliche Runner-/Fixture-PIDs, DATA und Bundle als entfernt beziehungsweise beendet. Dessen Originalresultat bestätigt `fetches=0`, `opened=closed=1`. Dieser unabhängige Nachcheck wird ausdrücklich nicht als unabhängiger Delete-Ressourcenabschluss ausgegeben. Die sechs oben bereits abgeschlossenen Programme werden auf ihren unveränderten eigenen Test- und Produktquellen weiterverwendet; daraus entsteht kein neuer gemeinsamer Wiederlauf aller sechs.

Der anschließend im ersten Abschlusscontroller gestartete breite Default-Typcheck endet nach 40,111 s mit Heap-OOM, Exit -6 / SIGABRT. Er belegt weder null Diagnosen noch einen grünen Typcheck. Ein eigenständiger tatsächlich beendeter Wiederlauf mit 8 GiB Node-Heap endet nach 80,622 s mit Exit 2 und **69 Diagnosen**. Gegenüber dem ursprünglichen 90er-Lauf sind die 21 MVP-Diagnosen geschlossen; die übrigen vollständigen Diagnoseblöcke bleiben unverändert.

Der separate tatsächliche Main-Lauf auf `1506927038b80036749266a56fb769dcb6e6d18c` generiert seine Next-Typen erfolgreich und endet beim Default-Typcheck ebenfalls mit Exit 2 / 65,420 s. Ein unabhängiger Vergleich bindet Originaljournale, vollständige Logtexte einschließlich Folgezeilen und Häufigkeiten: **Alle 69 Root-Diagnoseblöcke werden auf frischem Main bytegleich reproduziert; Root-only 0.** Das Main-Log enthält insgesamt 75 Blöcke. Seine sechs zusätzlichen Blöcke sind zwei `NODE_ENV`-Widening-Diagnosen im Shell-Test und vier Mobile-Testdiagnosen bei fehlendem Control-Plane-Sibling im isolierten Export; im Root stehen dort begrenzte lokale Strukturtypen. Daraus werden keine vier eigenständigen Main-Produktfehler oder 75 unabhängigen Produktfehler abgeleitet. Beide breiten Typchecks bleiben rot. Dieser Vergleich ist eine Diagnosezuordnung, kein Produktions-, Runtime-, Browser- oder allgemeiner Regressionspass.

Originale liegen unter `/private/tmp/canvas-m3-file-test-reconciliation-20261020` in `final-two-verification-v2`, `separate-types-8g` und `separate-native-owner26`. Der tatsächliche Main-Compilerlauf liegt unter `/private/tmp/canvas-m3-main-type-baseline-05ehipv5`, der unabhängige Vergleich unter `/private/tmp/canvas-m3-types-ro-comparison-20261020-ocVf2bxK`.

| Original | SHA-256 |
|---|---|
| `final-two-verification-v2/terminal.json` | `055d633bf1958ead236c691776a8cf3e9123614e8d1734bfecc559ac5725f6e5` |
| `native-delete-links-success.log` | `76b1cd69d44d80095225b6e0a5a0927aee764920570013c5bfbe7f49ec3a356e` |
| `native-delete-links-drift.log` | `8d1503d525646c434e116a570e2949d59eda94dd22b079f664e5bae30a702213` |
| `native-delete-links-rollback.log` | `a072ce305697f8a055201eb1fbf1ae02eab86cbd614e1f7a5349037521f31826` |
| `native-delete-links-ack.log` | `9d9cdff6ed38033531ce64bf0a7f783ed4c4362879be4df638ea788d9e700c3c` |
| `separate-native-owner26/terminal.json` | `4be4e54908ff44dc996e2ffbb7396520de00bf1cb25e739e5818bd45b77b7a96` |
| `separate-native-owner26/independent-closure.json` | `1458e72a8160177d761cada1646b447366ddcebded789dc74e0e4716c37f783a` |
| `separate-types-8g/terminal.json` | `07895a462670fefb63f739c54cca9fbb45c2d5da6516eb022ee006fbee7da389` |
| `separate-types-8g/original.log` | `f87d64a219dd9317c7a22890a2687240cbf81b79851e829dd8117faa2ea561e3` |
| Main `terminal.json` | `4f2977b602ba852a60006cb772eb87985fba2c442f7d0eab7952eccb3a72cef4` |
| Unabhängiger Main-Vergleich `comparison.json` | `8ad4b5fe3a3b1bd6be37035080fdb5853cb4ce1a9b17ce2206310facfebb7cbb` |

**Weiter offen:** akzeptierter vollständiger Kaltbuild mit unveränderten Schutzlimits und unabhängiger Quellen-/Artefaktbindung, anschließend alle 29 Browser-/API-/MCP-Fälle in drei seriellen eigenen Runtimes, danach aktuelle CI und vollständiges Review. Noch keine Main-/Launchfreigabe und keine Produktionsauslieferung. Die sieben nachgelagerten Roadmap-Pakete bleiben unverändert offen.

## Vierter Originalbuild: kalter Cache, unveränderte Artefaktgrenze

Der vorherige warme Stand bleibt vollständig erhalten. Der neue tatsächliche Build beginnt mit leerem QA-`.next`; das gesamte vorige Verzeichnis einschließlich Cache bleibt reversibel außerhalb des Projekt-/Tracingroots gesichert. Gebundene Heads sind Root `f7a554742ea2ce08acb1deeb62ac99b987dd6e0c`, QA `e248e8e758a33f6141c0d75299a417e8e2e308ef`, CP unverändert `27c8ce37da082244f006ca376068cde6b98845d5`. Build-/Browserfristen und die bisherigen fünf Helper-/Supervisor-/Nativepins bleiben in diesem Original unverändert.

Der originale Owned-Prozess endet mit **Exit 1 nach 344,904 s**. Compile besteht mit Exit 0 nach 264 s; Release-Typecheck besteht, Generate endet mit Exit 0 nach 13 s und der echte Produktionsmodultest bestätigt gemeinsame Yjs-Identität sowie XML-/Block-/Reload-Erhaltung. Die Queue endet ebenfalls fehlgeschlagen vor Runtime 1 mit `results: []`. Keine der 29 aktuellen Browserprüfungen startet. Eine anschließende ausschließlich lesende Reproduktion mit dem unveränderten Originalhelper `62a43d597f3e251cd3a7c793fe559194d187740e66951544203571ea6d6096cb` verweigert den Fingerprint mit `Compiled artifact visit limit exceeded.`; Quellenfingerprint vorher/nachher gleich, kein Artefakt akzeptiert.

Das abgeschlossene kalte Inventar trennt **102.642 kompilierte** und **10.213 externe** Einträge. Die kompilierte Anzahl ist exakt gleich der warmen Inventur; daraus folgt keine Bytegleichheit. Alle 18 untersuchten Paketaliasformen sind strukturell kanonisch. Der vollständige Source-Map-Pfad-Audit liest 48.266 Maps einschließlich rekursiver indizierter `sections[].map` und `sourceRoot`-Präfixbehandlung: 148.091 Referenzen, 17.589 eindeutige Quellangaben, keine Parsefehler, keine nichtleeren `sourceRoot`-Felder und keine verschachtelten Buildpfade in diesen Quellangaben. Das ist ein Struktur-/Quellpfadaudit, **kein vollständiger Byte-Fingerprint, Reachability-, nativer Validierungs- oder Buildnachweis**. Der Kaltvergleich liefert damit keinen Hinweis, dass allein der vorherige warme Cache die Anzahl erklärt.

**Kapazitätsvertrag v2 ist inzwischen umgesetzt und gezielt geprüft:** 110.000 ausschließlich für kompilierte Einträge, die getrennte externe Grenze bleibt 100.000. Unter den ursprünglichen fünf Helper-/Supervisor-/Nativepins ändert ausschließlich `scripts/lib/owned-yjs-authority-qa.ts` seinen SHA auf `f2a2f00d18dd37859290188b4cbaaf235160fef24feb5db512260e6cbed99b5a`; die vier anderen Originalpins sind auf Root und QA bytegleich erhalten. Vorab wurde der HIGH-Impact mit 53 betroffenen Symbolen und acht direkten Aufrufern gemeldet. Grenztests und tatsächliche Programme prüfen den geänderten Vertrag, ersetzen aber weder den fehlgeschlagenen alten Build noch einen vollständigen neuen Produktionsartefaktnachweis. Die neuen privaten Controllerinputs bleiben `ready: false`, bis Root nach Commit saubere aktuelle Heads und den geprüften Helper-Pin frisch bindet; keine alten Quellen-/Artefaktbelege werden übernommen.

**Aktuelle Kapazitäts-v2-Prüfung tatsächlich abgeschlossen:** Alle sechs Originalergebnisse sind Exit 0, ohne Signal oder Timeout; `failure: null`, `sourcesUnchanged: true`. Dazu gehören gezielte Typen/Lint und die vier tatsächlichen Programme unten. Die vollständigen Quellenfingerprints bleiben je Checkout vor/nach gleich: Root `a4196f9e31e4404c3feccbd25449bd1ef74491ce7c1678f086ad6a651b444ed9`, QA `fa375ca60a89e4844226fe1c4f86d798ad7097cab1612d6410680ada82cbf3cc`. Originale: `/private/tmp/canvas-m3-capacity-v2-verification-20261020`; `terminal.json` SHA-256 `657f3f196f8ad414f2d1b9a5899dd70a7d8dea8236bc287800d8efe085f85ecc`. Die tatsächlichen Logfooter bestätigen Fingerprint-/Byteänderungs-/Kapazitäts-/Alias-/Guard-/Handle-Abschlussprüfungen. Es werden keine zusätzlichen Testfallzahlen abgeleitet. Kein neuer Produktionsbuild, keine rückwirkende Annahme des alten Artefakts, keine Browser- oder Launchfreigabe.

| Tatsächlicher Originalprozess | Exit | Dauer | Original-Log SHA-256 |
|---|---:|---:|---|
| `targeted-types` | 0 | 2,508 s | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `targeted-lint` | 0 | 1,767 s | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `fingerprint` | 0 | 3,743 s | `2f6217a99d2963f4535959937da7b06cb72accabe0bba7db9d2579e13b191db5` |
| `artifact-budget` | 0 | 59,15 s | `0d3f154aacb421dc6ded6cf66cd2beca16a5c2e2ee29937230c706d56a721570` |
| `qa-guards` | 0 | 1,324 s | `d5ab9159ac7fe0f8f68896a59789f45f7e69b3c89a8009ba6f1efc3a7480bdae` |
| `native-artifact` | 0 | 4,477 s | `e93edbb29940638ad37544a55c18ac372fdcb7ba9cc9bc1f8a40b2e51494b388` |

Originalcontroller: `/private/tmp/canvas-m3-fresh-controller-inputs-20261020-RO2L5GQl/mcp10`; Originalbuildroot: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-build-R9zDAG`; ausschließlich lesende Diagnose und vollständiger indizierter Inventarabschluss: `/private/tmp/canvas-m3-cold-artifact-diagnosis-20261020`.

| Original | SHA-256 |
|---|---|
| `build-terminal.json` | `51f5532287ef2d8c5bdb2d02997707202b6c603a6aded435815935459bc15380` |
| `launch-terminal.json` | `128af26d9d0fa6a2c4607e9ba787f1212085b0772e7309022b8b27f448ee85ae` |
| Originalcontroller `build.original.log` | `8c6d53c3df947d5b10ce9e686b455dec5d2c2f1347295a4cb6d145c23a40743b` |
| Originalbuild `build.log` | `ac97d65fdf37a24ffa6280e41e403b5dedd8f6ef4694e7bb8c50f4fad31259a5` |
| `diagnostic.json` | `9cb94c80c89184a3eeaf14daf546914bbf124e11db5bd512559cc84bed31699e` |
| `cold-inventory-indexed-roots.json` | `c7c77eb6f70c1f0eb485229de5dd331594e58bf928de62131c6aa34d926f1352` |

Ein akzeptierter neuer Produktionsbuild mit unabhängigem vollständigem Quellen-/Artefaktabgleich, danach alle 29 Fälle in drei seriellen eigenen Runtimes, aktuelle CI und vollständiges Review bleiben offen. Keine Main-/Launchfreigabe und keine Produktionsauslieferung. Die historischen Statusmarker und nachgelagerten Roadmap-Pakete bleiben unverändert.


## Fünfter Originalbuild bestanden; Web-Request-Grenze im zehnten Browserfall

Gebundene Quellen sind Root `aa8476835d7e9d8f1c32d74129f7bcf5527ec756`, QA `118d8cfa8d6af551fbae1d15fc36af8524521aee`, CP unverändert `27c8ce37da082244f006ca376068cde6b98845d5`. Der tatsächliche vollständige Produktionsbuild endet mit **Exit 0 nach 178,921 s**. Der anschließende unabhängige Artefaktabgleich besteht einschließlich Quellenbindung, vollständigem Fingerprint und nativer Identität. Build-ID `build-TfctsWXpff2fKS`, Artefaktfingerprint `30012e84728bbd1e5e0fbd0a7d7ec22221bd2badaa871412cc7403bf5cffa6fd`. Dieser Nachweis gilt ausschließlich für diese Quellen; die nachfolgende Produktkorrektur erfordert einen neuen Build.

Die echte OAuth-/API-/MCP-/Browserfolge endet mit **Exit 1: zehn deklariert, neun bestanden, ein Fehler, keine Skips, Timeouts oder Unterbrechungen**. Die bestandenen Fälle schließen sichtbare Bearbeitung und Reload, das installierte Python-Wheel mit echtem PKCE, Suche/Read/Create/Edit sowie native Copy-/Move-/Delete-Aktionen über MCP und zentrale Linkänderungen ein. Fall 10 scheitert beim ersten Raw-Web-Move-Preview: erwartet HTTP 200, tatsächlich HTTP 500. Die weiteren 17 manuellen Editorfälle und zwei Neustartfälle werden nicht gestartet; die Queue bleibt bei `results: []`, weil sie nur vollständig erfolgreich abgeschlossene Runtimes aufnimmt.

Der Hoststack endet am Eingangscheck von `withRequestPrincipal` mit `PRINCIPAL_INVALID`, vor Authauflösung oder Principal-/WeakMap-Erstellung. Die originalen kompilierten Module bestätigen zwei unterschiedliche `NextRequest`-Klassen: Frameworkadapter `487718` erzeugt `e6`, die Principal-Factory importiert die Klasse `l` aus Modul `929666`. Der bisherige direkte Web-PG-Test konstruiert seinen Request im selben ESM-Graphen und durchläuft diese Frameworkgrenze nicht. Rename und Delete übernehmen deshalb das bereits in Create/Upload vorhandene lokale Request-Snapshotmuster. URL, Methode und Header werden vor dem ersten await kopiert; Body und Rate-Limit verwenden weiter den eingehenden Request. Auth-/Principal-Guards, Rechteprüfungen, Originalimporte und zentrale Mutationsverträge werden nicht gelockert. Der unabhängige Quellreview findet keine P1/P2; der erneute reale Browsernachweis bleibt offen.

Originalcontroller: `/private/tmp/canvas-m3-capacity-v2-controller-inputs-20261020-Cv2/mcp10`; Buildroot: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-build-GlKEFX`; Browserfixture: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-Yfnm0u`.

| Original | SHA-256 |
|---|---|
| `build-terminal.json` | `7a5e4dac7871ad1a005495c9f70277e2f0f291ad6a0037368fca524733017b74` |
| `artifact-report.json` | `706d79337d5d4ac6c0175ab97663a95e332e223540c1dcf39b82a98e32344874` |
| `runtime-terminal.json` | `b7de10c75da28ed9fde7f7294c780ce0b26e59f086370678d54e73f9a722187b` |
| `postruntime-report.json` | `ead2fa0160d56955b11fa18d90d91c61598ccfbc6de71e218d13d4fc4b66c4fe` |
| `queue-terminal.json` | `b6680ce0010ae1848c685b95c03eaad72b8237b1fd5f973a780594dab4e7bd33` |

Der ursprüngliche unabhängige Abschlussbericht ist ausdrücklich rot: Prozesse/Ports/Lock/DB-Backends sind beendet beziehungsweise frei und die vier verwalteten Dienste unverändert gesund, aber beide eigenen Datenbanken und DATA/TMP bleiben zur Fehlerdiagnose erhalten. Eine spätere gezielte Bereinigung ist ein eigener Nachweis und ändert diesen Originalbericht nicht. Noch keine M3-, Main- oder Launchfreigabe; keine Produktionsauslieferung. Die sieben Roadmap-Pakete bleiben offen.

Auf der anschließenden Zwei-Handler-Korrektur bestehen der vollständige Release-Typecheck (`tsconfig.release.json`), Scoped-ESLint und die unveränderte echte Web-PG-Folge **7/7 mit Exit 0 nach 39,986 s**. Der Originaltest bestätigt entferntes eigenes Schema, geschlossene Pools/Clients, entferntes DATA und null Fetches; der echte ESM-Runner bestätigt sein entferntes Bundle. Originale unter `/private/tmp/canvas-m3-web-request-boundary-20261020`, Web-PG-Log SHA-256 `ea63279fc76fe4940e4d1b6d9df4c074df5fb520c5c8c9c03d0b6f9ad816a5fb`. Dies ist keine kompilierte Browserabnahme und kein grüner Standard-Gesamttypcheck.


## Sechster Originalbuild bestanden; Tree-Bedienung des zehnten Tests korrigiert

Auf Root `a2fce6070b8eb2b4ccfa34574c4a16bde5e24c8f` / QA `c53194ae81a3a6e7e725c472ddb45d162151dc19`, CP unverändert, besteht der tatsächliche vollständige Produktionsbuild mit **Exit 0 nach 316,455 s**. Der anschließende unabhängige vollständige Quellen-/Artefaktabgleich besteht. Neue Originale: `/private/tmp/canvas-m3-nextrequest-controller-inputs-20261020-Nr1/mcp10`; Buildroot `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-build-iJ1Fdj`.

Die tatsächliche Zehnerfolge ist erneut **9/10, Exit 1, keine Skips, Timeouts oder Unterbrechungen**. Der vorherige `PRINCIPAL_INVALID`-Abbruch ist geschlossen: Das originale Web-Move-Preview antwortet 200, seine vollständigen NoWrite-Prüfungen bestehen; Apply und Status bestätigen `applied`, alle Aktionen abgeschlossen, `linkStatus: complete` und genau einen aktualisierten eingehenden Link. Der nächste Abbruch liegt vor den vollständigen nativen JSON-/Markdown-/Editororakeln und vor Raw-Web-Delete: Nach `folder.dblclick()` ist die Ziel-Datei nicht sichtbar.

Der Originalsnapshot zeigt Tree-Modus, den richtigen Workspace, Breadcrumb `raw-web-destination` und einen ausgewählten, geschlossenen Zielordner. Der tatsächliche `FileTreeNode` verwendet einen kontrollierten Radix-Collapsible-Trigger: jeder Klick toggelt, ein Tree-Doppelklickhandler existiert nicht. Der erste Klick öffnet und lädt, der zweite schließt; `selectNode` setzt davon unabhängig die Breadcrumb. Dies erklärt das beobachtete Bild. Der minimale Testfix wählt ausdrücklich Tree-Modus, adressiert den primären `treeitem`, öffnet ihn bei Bedarf mit einem Klick und prüft zusätzlich `aria-expanded=true`. Dieselbe Ziel-Datei-Sichtbarkeitsprüfung bleibt erhalten. Kein Refresh, Reload, künstlicher Wait oder höheres Timeout wird ergänzt; Produktcode bleibt unverändert.

Der unabhängige vollständige Testdiff bestätigt exakt diese zwei Stellen. Die ersten neun Fallkörper sowie alle übrigen Inhalts-/NoWrite-/Recoveryorakel, Fristen und Cleanup sind bytegleich. Ursprüngliche Spec SHA-256 `80cef0d0497c3cef044f8e244ec977bdfb241308944b757d7db05329ab80470c`; Originalkopie und Korrekturbelege unter `/private/tmp/canvas-m3-tree-test-correction-20261020`. Der GitNexus-Index löst weder die neue benannte Testfunktion noch die Spec auf; die Impactbewertung bleibt UNKNOWN und wird durch den engen unabhängigen Quell-/Aufrufervergleich ergänzt.

Browserfixture `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-JXh9nO`. Die ursprüngliche Runtime und ihr unabhängiger Abschlussbericht bleiben rot; eigene Datenbanken und DATA/TMP sind zur Diagnose erhalten. Die Queue startet weder die weiteren 17 Editorfälle noch die zwei Neustartfälle. Eine spätere gezielte Bereinigung verändert diesen Originalnachweis nicht.

| Original | SHA-256 |
|---|---|
| `build-terminal.json` | `376208db6806a4240165faa44e01e43e8344c0825745a1430a9cb74d2764124d` |
| `artifact-report.json` | `78f5d001573c97cb5aef9acb0d4d6aef9e76530e7a8a850d92ee5d637045ee31` |
| `runtime-terminal.json` | `c330a05f31aa0cf0d0b06d99589422715e350e134313b742e2d68866896373fc` |
| `postruntime-report.json` | `795e92d312306eea0fee162ce396ad05777aa0b15fb7baf6ede9c1a58bd08779` |
| `queue-terminal.json` | `b6680ce0010ae1848c685b95c03eaad72b8237b1fd5f973a780594dab4e7bd33` |
| `launch-terminal.json` | `e98964fd19453a1f1115171b346ccd973b3af6266ced6d6077fb22c3386a04c6` |

Die vorherige exakt begrenzte Bereinigung der fünften Browserfixture `Yfnm0u` ist inzwischen tatsächlich abgeschlossen: beide gebundenen eigenen DB-OIDs 14265702 und 14273493 sind entfernt, nur eigenes DATA/TMP entfernt, sämtliche gepinnten Originalbelege bytegleich erhalten. Separater Bericht `/private/tmp/canvas-m3-exact-failed-runtime-cleanup-20261020/cleanup-result.json`, SHA-256 `81190302a140ffe10d0b58f6296a5e8b774dcf2644cdb700001453cbf32a00f4`. Dies ist keine nachträgliche Browser- oder Abschlussfreigabe des fehlgeschlagenen Originals.

Die erneute vollständige Abnahme des korrigierten Tests sowie aktuelle CI/Review bleiben offen. Keine Main-/Launchfreigabe oder Produktionsauslieferung. Die sieben nachgelagerten Roadmap-Pakete bleiben unverändert.


## Siebter Originalbuild bestanden; unabhängiges Expected-JSON wertbasiert getrennt

Auf Root `50506cda2fe2f2bc222af7a4cd47848865f3c641` / QA `64c5239068c605733dc3d554ea7dae69de566a52`, CP unverändert, besteht der vollständige Originalproduktionsbuild mit **Exit 0 nach 163,279 s**. Der unabhängige vollständige Quellen-/Artefaktabgleich besteht. Originalcontroller `/private/tmp/canvas-m3-nextrequest-controller-inputs-20261020-Nr2/mcp10`; Buildroot `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-build-YkkI10`.

Die reale Zehnerfolge bleibt **9/10, Exit 1, keine Skips, Timeouts oder Unterbrechungen**. Der Request-Fix und die korrigierte Tree-Bedienung bestehen; Ziel-Datei-Sichtbarkeit sowie die nachfolgenden nativen Lese-/Identitäts-/Versions-/Dauerhaftigkeitsfelder werden erreicht. Der Abbruch erfolgt in der unabhängig geparsten Expected-Struktur beim zweiten Absatz: dessen erwartete `attrs.id` ist durch die vorherige ID-Zuweisung bereits verändert, obwohl der frische Parser korrekt `null` liefert. Die vollständige Inhalts-/Editorabnahme und Raw-Web-Delete werden noch nicht erreicht; die weiteren 19 Fälle starten nicht.

ProseMirror `NodeType.computeAttrs` verwendet gemeinsame `defaultAttrs`; `Node.toJSON` übernimmt diese Referenz. Das erste `attrs.id=id` verändert daher auch weitere erwartete Absätze und das Schema-Default. `Mark.toJSON` behält zudem Nullprototyp-Attributobjekte, während die tatsächliche API JSON-Werte liefert. Eine nur lokale Attrkopie würde den folgenden Link-Mark-Vergleich noch nicht reparieren; ein tatsächlicher isolierter Probeversuch bestätigt diesen zusätzlichen Prototypunterschied.

Die minimale Korrektur materialisiert ausschließlich die unabhängig aus dem Autoren-Markdown und Schema erzeugte Expected-Struktur einmal mittels `JSON.parse(JSON.stringify(...))`. Die tatsächliche Antwort bleibt exakt erhalten. Null-Erwartung, gültige eindeutige tatsächliche IDs, Knotentypen/-anzahl und der vollständige JSON-/Mark-/Attribut-/Textvergleich bleiben unverändert. `structuredClone` wird nicht verwendet, weil es geteilte Referenzen erhält. Vier tatsächliche reine Orakelproben für Move/Delete und ihre Incoming-Linkinhalte bestätigen den alten Aliasfehler und die neue unveränderte Schema-/Attributbehandlung; synthetische opake IDs sind ausschließlich Probeinputs. **Keine App-, DB- oder Browserfreigabe aus diesen Proben.** Gezielte Spec-Typprüfung und Scoped-ESLint bestehen. Beide unabhängigen Quellreviews finden im vollständig gelesenen übrigen Fall keine weitere konkrete falsche Testannahme; der echte vollständige Lauf bleibt erforderlich.

Korrektur-/Probeoriginale: `/private/tmp/canvas-m3-expected-attrs-correction-20261020`. Ursprüngliche Spec SHA-256 `a65f6957a9bc29e6ae0518ed75e19bc938e994ece5f39d10912180a850bc1ffe`; erste neun Fälle, restliche Orakel, Fristen und Cleanup bleiben bytegleich. Produktcode bleibt unverändert. GitNexus löst die neue Testfunktion weiterhin nicht auf; Impact UNKNOWN und enge unabhängige Quellprüfung sind ausdrücklich getrennt.

Browserfixture `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-W5FIBa`. Originalruntime und unabhängiger Abschlussbericht bleiben rot und werden nicht nachträglich freigegeben. Eine gezielte Bereinigung eigener DBs/DATA/TMP wird gesondert dokumentiert und erhält die Originalbelege.

| Original | SHA-256 |
|---|---|
| `build-terminal.json` | `c6771fb793097c3bcf9cb08f6b7253e25af7323e400486ed6b25bc28c4a94d21` |
| `artifact-report.json` | `1b247ee72d14e2ee254c09eada9b3cbf900e7453b864402da6cd0c825dd797a7` |
| `runtime-terminal.json` | `49cb1d7885561124c38d7c256f53b3112ee1a677fb151a1004f5656ae79a562e` |
| `postruntime-report.json` | `4c152f91f8078b7a3be9e05b5d3c512a50b849f9f518cdb63080f43defcc35dc` |
| `queue-terminal.json` | `b6680ce0010ae1848c685b95c03eaad72b8237b1fd5f973a780594dab4e7bd33` |
| `launch-terminal.json` | `2c9ff58adf0c88af06a2dfa2dcdc7dac82411ed1abc54e4917066b743602d068` |

Vollständige 29er-Abnahme, aktuelle CI und finale Reviewkontrolle bleiben offen. Keine Main-/Launchfreigabe und keine Produktionsauslieferung; die sieben Roadmap-Pakete bleiben unverändert.


## Achter Build und tatsächliche 27/29-Teilabnahme, 20. Oktober 2026

Gebundene Originalquellen: Root `83c70acc0ac2009af768279fcab39cf95c41bb76`, QA `771bb80557f3cde2717cbebde43b45b9a830dcd1`, CP unverändert `27c8ce37da082244f006ca376068cde6b98845d5`. Alle waren während der vollständigen Folge sauber. Originalbuild Exit 0 nach **161,982 Sekunden**; unabhängiger vollständiger Artefaktabgleich Exit 0. Artefaktbericht SHA-256 `d7738bad9beaa204ab931babe8c7e694e1152a91e60df86a75735c870f7bc314`, Quellenbericht `1fdd4f5c18b9d2f0cac3f04f6ea847f0a3e488f172246b50e1291dfe8ed7e7c4`. Originalcontroller: `/private/tmp/canvas-m3-nextrequest-controller-inputs-20261020-Nr3`.

Die erste Runtime besteht **10/10 tatsächliche Fälle**, darunter der vollständige Raw-Web-Move und -Delete mit Originalimport, stabilen Identitäten, vollständigem Inhalts-/Linkbeleg, sichtbarem Editor und Reload. Die echte installierte Python-Wheel-Folge prüft OAuth-PKCE, Suche, ID-Read, Create und Edit; kein veröffentlichter SDK-Lifecycle-Nachweis für Move/Delete. Alle 14 unabhängigen Abschlussprüfungen sind grün; Postbericht SHA-256 `277d11b12b31d12e60c2b838f36e14077b75148fbab1c0bba0f0fb7a264d9e04`.

Die zweite Runtime besteht **17/17 tatsächliche Fälle**: 15 Desktop-/Mobile-Web-Create-/Paste-/Markdownimport-/Fresh-Browser-Fälle und zwei verlorene Create-Antworten mit gebundener Wiederaufnahme derselben Neuanlage. Alle 14 unabhängigen Abschlussprüfungen sind grün; Postbericht SHA-256 `795be50d5c60e22b6ef71b9a5c2538473c02971be653b4c4434d57bacb528911`.

Die dritte Runtime bleibt **0/2, Exit 1**, ohne Skips, Timeouts oder Unterbrechungen. Beide echten Neustarts werden durchgeführt. In beiden Fällen bestehen manuelle Anlage, echtes erstes Paste, Peer-Edit, dauerhafter SQL-Inhalt, vollständig neuer Browser ohne alten Cache, unveränderte IDs und Reload. Erst die zusätzliche mutierende aktive Delete-Probe vor dem normalen UI-Close scheitert: erwartet 409, erhalten 200. Der heutige native V2-Vertrag reserviert und drainiert einen aktiven Owner ausdrücklich vor physischer Mutation. Die ältere pauschale Busy-Erwartung widerspricht diesem Vertrag; 200 ist im direkten HTTP-Pfad ausschließlich der angewendete Terminalzustand. Die unabhängige Quellenprüfung bindet den tatsächlichen Admission-/Quieszenz-/Releasepfad und die vorhandenen positiven/negativen Live-Owner-Vertragsbelege. Die anschließende unabhängige RR-READ-ONLY-PG-Abfrage bestätigt für beide erhaltenen Dokumente `archived`, jeweils Deletebatch `applied` / `complete` / 1 von 1 / ohne Fehler und Intent 4 samt Completion 4. Beide zugehörigen Admissions sind `committed`; Targets `completed`, inaktiv, mit `owner_drain`, gebundener Release-ID, Epoch 3 und Sequenz 2. Die Live-/Persistenz-Releasehashes stimmen jeweils überein, Owner-Tupel sind gelöscht. Tatsächlicher Mutationsabschluss ist damit belegt; die rote Originaltestausgabe bleibt unverändert. Der erste reine Leseversuch traf wegen angenommener Registryspalten auf SQL 42703 und wurde zurückgerollt und geschlossen; die anschließende Abfrage verwendet das tatsächliche Schema. Beide Leseverbindungen sind geschlossen, keine Domainwrites.

Die minimale Testkorrektur entfernt ausschließlich die aktive Delete-Probe vor dem normalen Close. Der vorhergehende Restart-/Persistenzteil und der nachfolgende normale UI-Close-/Release-/Versions-/Delete-Teil bleiben jeweils bytegleich. Die genaue Scope-Proof-Prüfung bindet unverändert Workspace, Organisation, Dokument-ID, Pfad, Generation, Darstellung, Schema und Lineage. Ein separater Workspacewert aus der nun entfallenen mutierenden Probe ist dafür nicht erforderlich: der Read-only-Reader prüft Registry und Zustand selbst explizit. Keine Produktquelle, kein Reader, keine Frist, keine Anzahl und kein Cleanup wird verändert. GitNexus kann die anonyme Testfunktion nicht zuordnen (UNKNOWN); die enge direkte unabhängige Quellprüfung bleibt erforderlich.

Originalfixture: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-1CMHc0`. Originalruntime, Browserausgaben und roter unabhängiger Abschluss bleiben unverändert erhalten; eigene DBs/DATA/TMP werden bis zur gebundenen Diagnose bewahrt. Runtime-Terminal SHA-256 `41ef51070edcd7f7af58b18323781d6c5360975a8c49eae228883615af6c5675`, Postbericht `9e26c0b6469910487c1e148215a5f333ef4e53ee902fa2d8f235416ca36b191e`, Queue-Terminal `6e1b7bc10f33f6da25e093ab8e087c293e556688bc0ad725613e6c2bedfc6db1`, gesamtes rotes Launch-Terminal `7ab19d1671938fc62be1b8ba3f8bcd8332a5b159e814b7fea8068d8146869843`.

Die vollständige 29er-Abnahme bleibt offen. Sieben CI-Prüfungen auf dem gebundenen Root `83c70acc0` sind tatsächlich erfolgreich; es bestehen zwei aufgelöste Reviewthreads und keine neuen menschlichen oder offenen automatischen Findings. Das ist keine Freigabe des folgenden Testkorrekturcommits. Main bleibt `1506927038b80036749266a56fb769dcb6e6d18c`; keine Main- oder Produktionsauslieferung. Dateiaktions-Undo und Review Center bleiben aus, die sieben Roadmap-Pakete offen.

Gezielte Typprüfung der korrigierten Restart-Spec mit den tatsächlichen Projekt-Ambienttypen und Scoped-ESLint bestehen. Der erste isolierte Typkonfigurationsversuch ohne Projekttypwurzeln ist als separater Konfigurationsfehler erhalten; keine Produktkorrektur daraus. Die lesende visuelle Prüfung des echten 17er-Screenshots bestätigt den direkt editierbaren kompakten Editor. [Originale manuelle Create-/Paste-Ansicht](./evidence/yjs-mvp-manual-create-paste.png), SHA-256 `6148de251a4bd96b6bcd981b0de9eba5abd79ee256d97339e9972451e569ad63`. Das Bild ersetzt keine Browserabnahme und zeigt keinen separaten Fokusbutton im bereits erweiterten Dateimodal.

Unabhängiger tatsächlicher Read-only-PG-/Testdeltabericht: `/private/tmp/canvas-m3-restart-delete-contract-readonly-review-20261020.md`, SHA-256 `3de5fd942af18530f1d6eac3b0e945a3747ad9518f8a42f813c28c581baaf40a`. Keine P1/P2 im engen Testdelta; Update-/Vectorbytes bleiben bei beiden beobachteten zentralen Deletes erhalten.


## Neunter Build und erhaltenes physisches Beobachtungs-RED, 20. Oktober 2026

Gebundene Originalquellen: Root `88d0bdd11bc94c1ef17d543e92bd84c18fd8fee9`, QA `19684f987ebd601ad369532b905433d2e2ee77ed`, CP unverändert `27c8ce37da082244f006ca376068cde6b98845d5`. Frischer Originalbuild Exit 0 nach **248,971 Sekunden**, unabhängiger vollständiger Artefaktabgleich Exit 0. Originalcontroller `/private/tmp/canvas-m3-nextrequest-controller-inputs-20261020-Nr4`; Build-Terminal SHA-256 `a6daaca50b11a10e704252656bd526c3b60ae3b9a9eaa2745afdcbb029f36f1e`, Artefaktbericht `dc1182497b6752e190654636a4ae0f12e73ec4ee66b49e774230b76a6a5c0a04`.

Die tatsächliche Zehnerfolge bleibt **9/10, Exit 1**, keine Skips, Timeouts oder Unterbrechungen. Im zehnten Fall bestehen Raw-Web-Move und -Delete mit tatsächlichem Import und Status, vollständigen nativen JSON-/Markdown-API-Inhalten sowie sichtbarem Editor und Reload. Das abschließende physische Delete-Incoming-Orakel sieht den alten Link. Es prüft jedoch die Buffer aus `after`, die bereits unmittelbar nach Apply und vor sämtlichen Editor-/Reloadwartezeiten eingefroren wurden. Der alte Buffer wird später nicht frisch gelesen. Der native Linkvertrag bestätigt den dauerhaften Yjs-/Graphabschluss und exportiert ausdrücklich selbst kein Markdown; die Datei wird über die getrennte Hintergrundprojektion veröffentlicht. Ein einmal früher aufgenommener physischer Buffer ist daher kein zutreffendes Endorakel für den späteren Stand.

Die minimale Korrektur erhält `after` und alle DB-/Import-/Identitäts-/nativen Inhalts-/UIorakel vollständig. Nur die abschließende physische Beobachtung liest mit demselben vorhandenen Owned-/READ-ONLY-Helfer frisch und verlangt innerhalb **30 Sekunden** exakt den vollständigen erwarteten Incoming-Inhalt. Target-Abwesenheit und vollständige MoveTarget-Bytes werden aus derselben frischen Beobachtung geprüft; ihr geschlossener Probe-Beleg wird zusätzlich dokumentiert. Keine Inhaltsnormalisierung, kein manuelles Checkpointen, keine Produktänderung. Die ersten neun Fälle, alle Helper, Cleanup, Counts und das tatsächliche globale Falllimit **180000 ms** bleiben gleich. Diese Testfrist ist keine zusätzliche Produktionsgarantie; bei erneutem Rot sind konkrete Projektionssequenzen, Receipts und Fehler zu untersuchen, keine blinde Fristerhöhung.

Unabhängige direkte Deltaprüfung findet keine P1/P2; GitNexus löst die neue Testfunktion weiterhin nicht auf (UNKNOWN), daher kein Schluss aus einer leeren Symbolzuordnung. Private Vorherkopie und Bindung: `/private/tmp/canvas-m3-projection-observation-correction-20261020`. Alte Spec SHA-256 `6d591562e6bfe6291c4293158ded9bc92b4444b6d67077558de3de5601848de8`, korrigierte Spec `7503d22a699d7203aebdb4f3d43e223fac9fd4b677b3dbbc527c162f4915bff4`.

Originalfixture `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-hutdNf`. Rote Originale bleiben erhalten: Runtime-Terminal `0ce881c4fe81201194f30ef1ecce52ac83699031278ce6e817f172d91a37d6a3`, Postbericht `0a1e132e5a1de61df0d606c77dc7de50e07004baeabd3ad238baf888ac6bd106`, Queue-Terminal `b6680ce0010ae1848c685b95c03eaad72b8237b1fd5f973a780594dab4e7bd33`, gesamtes Launch-Terminal `bab620e0798f8b5ea609c6b6b2e7f4fb76cd96a50ae608496b7b6a5732a58523`. Weitere 19 Fälle sind nicht gestartet. Die frühere echte 27er-Teilabnahme bleibt auf ihrem damaligen Quellenstand erhalten; die neue vollständige 29er-Abnahme und aktuelle CI/Review sind weiterhin offen. Keine Main-/Produktionsfreigabe, Undo und Review Center bleiben aus, sieben Roadmap-Pakete weiter offen.

Die tatsächliche anschließende RR-/READ-ONLY-/NoXID-Gegenprobe bestätigt den bereits vor der Fehlerassertion korrekt veröffentlichten Stand: Delete-Incoming Sequenz/Checkpoint/Projection jeweils 1, finalized 1, keine Projektionsfehler und degraded 0. FD-SHA entspricht State- und Projection-Serializedhash. Mutation 06:53:52,370 UTC, Datei-mtime 06:54:07,271, Checkpoint 07,299, Finalisierung 07,336, Reload-Screenshot 09,873 und erst dann alte Bufferassertion 10,158. Das Target fehlt. Die Leseverbindung ist geschlossen. Originaler Metabeleg `/private/tmp/canvas-m3-nr4-projection-readonly-metadata-20261020.json`, SHA-256 `cfc60972664e15bf2d83c682f2f65bd6314ccc24808d849eb672a50aac59659d`. Die korrekte Dateipublikation ist damit tatsächlich belegt; das Original-RED wird nicht umgeschrieben. Gezielte Spec-Typprüfung mit Projekttypen und Scoped-ESLint bestehen, ebenso die enge unabhängige Deltaprüfung.


## Finale gemeinsame M3-Abnahme auf Root 98956a6bd – 29/29 tatsächlich bestanden

Gebundene tatsächlich getestete Quellen: Root `98956a6bd1407ff92a7c14626c0124da25e59be7`, QA `6537fbbe8a6ae7ef53154b10d801a268da09192d`, CP `27c8ce37da082244f006ca376068cde6b98845d5`. Quellenbericht SHA-256 `50d66199e4ba39582a2bce0879d9da1af9a871758408611d432d1cc64138d071`. Der tatsächliche vollständige Originalproduktionsbuild endet mit **Exit 0 nach 163,020 Sekunden**. Der anschließende vollständige unabhängige Artefaktabgleich hat Exit 0; Artefaktbericht SHA-256 `2361015383ed84f85079ac938c204d85218e7e2b8a6c857a5ee7bf5ed41f00a8`. Buildfingerprint `e6e5bb24cf42c553383ad386382179988f7365e44bb9d3c842db2d2a7bd8283e`, QA-Quellenfingerprint `ddfdfd2af09670acefe913156cad8460c7fef7a79f94aac9de5f1d3cf60081f1`. Originalcontroller `/private/tmp/canvas-m3-nextrequest-controller-inputs-20261020-Nr5`; Buildroot `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-build-I96np8`.

| Serielle Originalruntime | Tatsächlich bestanden / deklariert | Originalexit | Unabhängige Abschlussprüfungen | Tatsächliche Hostneustarts |
|---|---:|---:|---:|---:|
| MCP/API/Dateiaktionen | 10 / 10 | 0 | 14 / 14 | 0 |
| Manuelles Create/Paste/Markdownimport und Create-Recovery | 17 / 17 | 0 | 14 / 14 | 0 |
| Graceful-/Crash-Neustart | 2 / 2 | 0 | 14 / 14 | 2 |

Alle 29 deklarierten Fälle sind tatsächlich bestanden, ohne Fehler, Skips, Timeouts oder Unterbrechungen; sämtliche Original-, Baseline-, Postcheck- und Queue-Exits sind 0. Das originale `launch-terminal.json` endet mit **Exit 0 / passed: true**. Dieselben eingefrorenen Quellen und derselbe neue Build gelten für alle drei seriellen Runtimes. Die drei Abschlussberichte bestätigen jeweils unveränderte Quellenbindungen und vollständigen Ressourcenabschluss vor dem nächsten Lauf. Das Gesamtterminal bindet genau dieselben drei ursprünglichen Queueterminals und den unveränderten Artefakthash.

Die Folge deckt native API-/MCP-Neuanlage, kontrollierten Markdownimport, versionsgebundenen ID-Read und Edit, tatsächlichen OAuth-/PKCE-Anschluss des frisch installierten Python-Wheels, unterstützte Copy-/Move-/Delete-Aktionen und zentrale Linkpflege sowie vollständigen nativen Inhalt und sichtbaren Editor/Reload ab. Die manuelle Folge umfasst Desktop-/Mobile-Web-Neuanlage, echte Paste-/Importwege, frischen Browser und verlorene Create-Antworten mit gebundener Wiederaufnahme. Die zwei Neustartfälle prüfen gespeicherten Inhalt, stabile IDs, vollständig neue Browser ohne alten IndexedDB-Zustand, normalen UI-Close, genaue Owner-/Scope-/Release-/Versionsbelege und abschließendes Löschen. Die vollständigen Originalergebnisse bestätigen diese Fallabdeckung; die beiden Neustarts sind zusätzlich im ursprünglichen erfolgreichen Abschlussreceipt mit restartCount: 2 gebunden.

| Neues Original unter Nr5 | SHA-256 |
|---|---|
| `mcp10/source-report.json` | `50d66199e4ba39582a2bce0879d9da1af9a871758408611d432d1cc64138d071` |
| `mcp10/build-terminal.json` | `47399006e270134db23dafd5125638e5e509a22721270f5e6714cc99fdc0f7ec` |
| `mcp10/artifact-report.json` | `2361015383ed84f85079ac938c204d85218e7e2b8a6c857a5ee7bf5ed41f00a8` |
| `mcp10/runtime-terminal.json` | `b5550008a769e0fd9144f826d0491d8059aeb35f7f57261fb46568434a96e8f6` |
| `mcp10/postruntime-report.json` | `365febbeb30c39e73d8edbef3772d13e0b1e92d996e091972988e6992e865e46` |
| `mcp10/queue-terminal.json` | `d75b8353f6bd366cf6bba0cfd4896014c2bc8433e3d78d4479017ea5ffb97106` |
| `manual17/runtime-terminal.json` | `c7189f32c4a78ca3b7d0b653d159f8bfc60955fd20220ca878a50657491f6bd9` |
| `manual17/postruntime-report.json` | `a4963de3d0251dc11b9729be25d222911252af7d1c0b1d9e2f11bd9fd349fe56` |
| `manual17/queue-terminal.json` | `39915497808900974c2a4000a107c631179a315bdaced6f54ebf7b33c123b6dc` |
| `restart2/runtime-terminal.json` | `4f0275828454bbb06fd73486b1a566068d78ed73827823abd9e457557180906e` |
| `restart2/postruntime-report.json` | `7cec26fe42cd4b00e803819c1b7b22866628a1992663f80150fb6e10b82042c3` |
| `restart2/queue-terminal.json` | `e7d265a045c027cbe851be3dea604297b3d0fd543c4db8462c67ca1ed77ed74c` |
| `mcp10/launch-terminal.json` | `2b86d402703422a9fd2587b47ee091215572eda320164b5076887963961ee408` |

Die früheren Fehlversuche, korrigierten Testorakel und roten Originalberichte bleiben unverändert. Diese frische Abnahme schreibt kein früheres Ergebnis um; gesonderte exakte Ressourcenbereinigungen bleiben getrennte Nachweise.

**CI und Review getrennt vom Laufnachweis:** Auf dem tatsächlich getesteten Root `98956a6bd1407ff92a7c14626c0124da25e59be7` wurden am 20. Oktober 2026 um 07:30 UTC alle sieben CI-Checks abgeschlossen und erfolgreich gelesen. Der erneute GitHub-Abgleich am 20. Oktober 2026 um 07:30:25 UTC bestätigt unverändert den getesteten PR-Head, sieben abgeschlossene erfolgreiche Checks, zwei vollständig aufgelöste Reviewthreads, eine COMMENTED-Botreview, keine allgemeinen Kommentare und keine neuen menschlichen oder offenen automatischen Findings. Sämtliche Seiten wurden vollständig gelesen. Main bleibt `1506927038b80036749266a56fb769dcb6e6d18c`; PR #176 ist weiterhin Draft, mergeable und CLEAN. Die hier ergänzte Abschlussdokumentation wird anschließend als eigener reiner Dokumentationscommit veröffentlicht. Dessen erst dann bekannte SHA sowie aktuelle CI-/Reviewergebnisse werden vor Merge im PR gebunden und geprüft; ein grüner geprüfter Lauf auf `98956a6bd` wird keinem späteren Head zugerechnet. Dieser Dokumentationstext behauptet keinen bereits erfolgreichen Main-Merge oder Produktionsrollout.

Der vollständige Standard-Typecheck wird nicht als grün bezeichnet: 69 Diagnoseblöcke sind getrennt bytegleich auf Main reproduziert; der Release-Typecheck und scoped ESLint bestehen auf den dokumentierten Quellen. Lokale M3-Abnahme, tatsächlicher Main-Merge und Produktionsauslieferung sind getrennte Schritte. Keine Main-/Produktionsveröffentlichung wird aus diesem Bericht abgeleitet. Beim späteren gesonderten Rollout sind alte Writer/Serverräume zu drainen, bevor neue Owner übernehmen; ausgelieferte Version und aktive Fähigkeiten sind danach tatsächlich zu prüfen. Dateiaktions-Undo und Review Center bleiben aus. Alle sieben Roadmap-Pakete bleiben offen, insbesondere voller veröffentlichter SDK-Lifecycle, Runtimeadapter, PDF-Parseranschluss, breitere Suche und Standard-Skill.

Unabhängige vollständige Schlussprüfung einschließlich redundantem Queue-Abgleich: `/private/tmp/canvas-m3-nr5-final-readonly-review-20261020.json`, SHA-256 `babeb4930aa6627710039c2117724d3907efb11f0080f22b98ab9da2ea189536`. Keine P1/P2 für die gebundene MVP-Abnahme; die vollständige Roadmap bleibt davon getrennt.
