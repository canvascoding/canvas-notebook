# M3: gemeinsame finale Abnahme – vorbereiteter Quellenstand

Stand: 20. Oktober 2026. **Noch kein aktueller Build-/Browser-Gesamtpass.** M1/M2, die beiden Undo-OFF-Regressionskorrekturen und die dokumentierten CodeQL-Korrekturen sind getrennt belegt. Diese Datei hält die verbleibende tatsächliche Endabnahme fest.

## Unveränderter Produktkern, ergänzte Raw-Web-Prüfung

`direct-mcp-native-create-import.spec.ts` erhält genau einen zehnten Fall und zwei Fixture-/Beobachtungshelfer. Alle neun bisherigen Fallkörper, Hooks, Auth-/Recovery-/Native-Inhaltsorakel bleiben bytegleich. Die ursprüngliche vollständige Spec lässt sich durch Entfernen der zwei additiven Quellblöcke exakt mit SHA-256 `b6074d6870ed21c2c2e46a075bcdb5e77c3f6e7ae3463d7d119396c5d45e7908` rekonstruieren.

Der neue Fall führt Move und Delete über die tatsächlichen Browserdialoge aus. Zwei disjunkte rohe Markdownpaare im eigenen, über echtes HTTP angelegten Workspace verhindern, dass der Delete-Arm versehentlich bereits native Quellen prüft. Originalbytes entstehen ausschließlich als kontrolliertes Fixture mittels exklusiver NoFollow-FDs; keine Autoritätszeile, kein Produktionsseed-Endpunkt und keine Authumgehung werden angelegt. Vor Preview wird kein Raw-Editor geöffnet.

Je Aktion: echter nicht importierender Preview mit zwei Imports und einem Rewrite/Unlink; unveränderte benannte Dokument-/Operationszeilen samt xmin und beide Originaldateien; Apply mit ursprünglicher Preview-ID und echter Client-Operations-ID; tatsächliches Mapping auf nativen Plan/Batch und originale Sitzung; stabile IDs/Lineages, vollständiger nativer JSON-/Markdowninhalt sowie sichtbarer Editor und Reload aller drei überlebenden Dokumente. Nur generierte Block-IDs werden in die unabhängig geparste Erwartung eingebunden. Das gelöschte Ziel wird über ursprüngliche Importidentität, Lineage, Archivierung und aktiven ID-Read mit 404 geprüft, nicht durch einen erfundenen aktuellen Archiv-Volltextread.

NoWrite bedeutet hier die acht benannten Dokument-/Operations-/Projektions-Tabellen und zwei ausgewählte Originaldateien pro Vorschau. Kein vollständiger SQL-Wire-/All-DATA-Nachweis und kein Recovery-/PDF-/SDK-Lifecyclezusatz wird aus diesem Fall behauptet. Eigene Seiten und Workspace werden auch bei Fehlern geschlossen. Review Center und Datei-Undo bleiben aus.

Unabhängiger Quellenreview ohne konkreten P1/P2. Drei neue Symbolimpacts wurden vorab mit UNKNOWN/not-found versucht; dies ist kein Sicherheitsurteil. Tatsächliche erste Typprüfung fand eine fehlende Typannotation im neuen Test (TS7022); der erhaltene RED ist keine Produktregression. Ausschließlich `found: Row[]` wurde ergänzt. Danach: TypeScript Exit 0 / 18,146 s, ESLint Exit 0 / 2,048 s, reine Collection genau 10 Fälle Exit 0 / 0,802 s. Keine Browserausführung wird daraus abgeleitet.

## Erforderliche echte Laufmatrix auf demselben frischen Produktionsbuild

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
