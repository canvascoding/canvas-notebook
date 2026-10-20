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

Der zusätzlich ausgeführte Standard-Typcheck mit allen Skripten endet separat mit Exit 2 nach 80,942 s: 90 Diagnosen ausschließlich unter `scripts/`, keine im geänderten Runtimepfad. Dieser breite Lauf ist nicht grün und wird nicht durch das gezielte Ergebnis ersetzt. Eine Einordnung als ausschließlich von Main geerbt ist damit nicht belegt. Der tatsächliche Release-Typcheck nach erfolgreicher Kompilierung bleibt erforderlich.

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
