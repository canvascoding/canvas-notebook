# Native Copy: zweiter gemeinsamer Browserlauf

Stand: 17. Oktober 2026. Der frische Lauf `canvas-yjs-authority-lasSNn` ist mit Exit 1 beendet. NativeCopy bleibt bei **2 von 6 bestanden**; CopyOrigin 2 und Undo-OFF 2 wurden anschließend nicht gestartet. Die erneut korrigierte Spec ist typgeprüft, aber noch nicht im Browser ausgeführt.

## Tatsächlich gebauter und geprüfter Stand

| Bindung | Wert |
| --- | --- |
| Root | `7fce84ba0435801ee703620d3725180029fdbcf7` |
| QA | `925b85f33f504003d9e3ebd0b7c518494c69fc6e` |
| Control Plane | `27c8ce37da082244f006ca376068cde6b98845d5` |
| Root-Sourcefingerprint | `26b09cc5babb91ebf44e5993303459a1f541bc4b267f065b3966a61695b190f5` |
| QA-Sourcefingerprint | `7eb4f43d15dbdb47a8197b0521d9eeac52be5fabc5a69651d3a2620362f1491b` |
| Buildfingerprint | `52bbc1d846ad372d32a3e33445424209c2fb07ac5c26b67d700ae00d7a85769c` |
| Build-ID | `build-TfctsWXpff2fKS` |
| Ausgeführte Spec-SHA256 | `b6bffc307e200b3f24a08833f48cc2a5b309bdec241dc69fde1eeb47267c23fa` |

Der originale Produktionsbuild endete mit Exit 0. Die unabhängige Artefaktprüfung bindet den Buildproof und die tatsächlichen Native-/Buildbytes an diesen Quellenstand. Die drei beabsichtigten Root↔QA-Abweichungen bleiben exakt Aktivierungspatch plus zwei historische Dokumente: Patch-SHA256 `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`. Das allgemeine Gate bleibt false; ausschließlich QA aktiviert den geprüften Pfad.

Private Belege unter `/private/tmp/canvas-copy-ui-corrected-preparation-4rr7cjn8/`: `source-report.json` SHA256 `b5c8cf909d0fe7be6d11a74cabd6605f54251a5dfdcc51791c712dabdbe23038`, `artifact-report.json` SHA256 `a8cfcc242f003af52abb0285f1b03fe352a3a7789e50142de6ec5517f95593ab`, Buildproof-SHA256 `dc5ca2cff17ed634823abd05d675236e9d6664568351bb7f366047425b030f8d`. Originalbuild: `canvas-yjs-build-hoyy7w/build.log`, SHA256 `6051257e952cc45233e44c0943d8fd304a535106b372a6d438dde453b2af05a4`.

## Originales Ergebnis und vier Fehlergrenzen

Root-Session 82340 endete tatsächlich mit Exit 1. Der Reporter zählt NativeCopy 6 deklariert, 2 bestanden, 4 fehlgeschlagen und jeweils null Skips, Testtimeouts oder Unterbrechungen. Bestanden sind die manuellen Rich-Notiz-/Markdown-Paste-/Link-/Clone-Isolationsfälle auf Desktop und Mobile. Die später geplanten vier Fälle sind keine bestandenen Tests.

1. **Desktop Mixedfolder:** Copy und historischer Replay liefern HTTP 200/complete. Ausschließlich `completedSteps` hat umgekehrte Reihenfolge; alle übrigen Operationsfelder sind exakt gleich. Die Assertion behandelt eine ungeordnete Schrittliste zu streng.
2. **Mobile Mixedfolder:** Die Quellansicht behält den enthaltenen Ordner als Breadcrumb. Der Root-Tree enthält den gesuchten Ordner, die sichtbare Liste zeigt dessen Kinder. Die Fixture sucht den Rootordner in dieser Kindliste; ein Copy-POST wird nicht erreicht.
3. **Desktop Pending-Recovery:** Fault-Apply liefert HTTP 200/partial und `NATIVE_COPY_PUBLICATION_UNCONFIRMED`; Recovery liefert HTTP 200/complete. Offene Zielansicht, gemeinsamer Titel und Cloneinhalt werden erreicht. Erst der folgende Source-Session-POST um 06:48:27.081Z bricht nach etwa 1,8 ms ohne HTTP-Antwort mit `ECONNRESET` ab. Weitere API-Aufrufe funktionieren unmittelbar danach. Das Hostlog belegt keinen passenden Session-/HTTPfehler oder Serverneustart; die Transportursache ist ungeklärt und nicht behoben.
4. **Mobile Pending-Recovery:** Preview um 06:52:14.093Z liefert HTTP 200. Apply mit unveränderten Pfad-/Workspaceparametern und derselben Preview-ID liefert um 06:52:23.489Z nach 373 ms HTTP 409, Body `{success:false,error:"NATIVE_COPY_PLAN_CHANGED",code:"NATIVE_COPY_PLAN_CHANGED"}`. Der Vergleich des frisch beobachteten Plans scheitert vor Stage/B0/B2. Welche beobachtete Tatsache sich verändert hat, ist nicht belegt; die vorgesehene B2-Unterbrechung wird nicht erreicht.

Die tatsächlichen Antworten, Zeiten und Fehler bleiben in den originalen Traces und `host-0.log` unter der Fixture erhalten. Der negative unabhängige `postruntime-report.json` hat SHA256 `74f8520055e51bd7d47c2a0ad3c2cd033ee0fcca4839fc2bd4e9975e98d3e9df` und bleibt negativ. Er bestätigte unter anderem Prozess-/Portabschluss und Dienstgesundheit, aber noch vorhandene eigene Datenbanken/DATA/tmp; deren spätere Entfernung ist ein separater Beleg.

## Zwei belegte Fixturekorrekturen, noch ohne Browserwiederholung

Ein gemeinsamer strikter Historyvergleich prüft jetzt an beiden Aufrufstellen gleiche Listenlänge, eindeutige Schritte und sortierte `completedSteps`; alle anderen Operationsfelder bleiben exakt gleich. Vor der Copyauswahl navigiert die Fixture über den echten Root-Breadcrumb. HTTP-Prädikate, Wartezeiten und Produktdateien bleiben unverändert. Diese Änderungen beheben keine Transport- oder Planänderungsursache.

Neue Spec-SHA256: `a80710a54a5d81a2e91b1c2bbeae09103f550fbf053892b0a549bb4b0e2fd507`. Enger Patch-SHA256 `59cc00004729e2b8820f913976867e96784811d4ada9dcd7723fae0f89974785`; Diagnose-/Patchbericht `/private/tmp/cn-copy-lasSNn-ro-patch-6_igsjw7/report.json`, SHA256 `c6ec68e106b82d9ea7f19b22ff7405e2ac57a85a93c206d542bbc7fdf7de0e4c`. Der dort vorbereitete Patch wurde anschließend von Root angewandt.

Vollständige cachefreie Typprüfung und scoped ESLint endeten für diesen korrigierten Stand jeweils mit Exit 0; 5072 erfasste Quellen blieben dabei stabil. Bericht `/private/tmp/cn-copy-ui-second-fixes-types-1u258oit/results.json`, SHA256 `511a4a211f73af512e6670d5d427eda3c61e96ebb61c19bb2acd2d026e14b657`. Das ist kein neuer Build- oder Browserpass.

Zwei getrennte kontrollierte Gegenproben bleiben offen: erstens eine Hintergrundprojektion des pending Clone nach B1/fehlgeschlagenem B2 vor Recovery und mögliche vorzeitige sichtbare Dateimeldungen; zweitens eine reine Sourceprojektion zwischen Preview und Apply bei unveränderten Yjsbelegen. Die volle Plan-ID bindet rohe Projektions-/FS-Fakten, während der Current-Vertrag ersetzbare Nativeprojektionen semantisch normalisiert. Das ist ein Quellenhinweis, keine bewiesene Ursache des mobilen 409. Der vorhandene Trace enthält keine WS-Nutzframes und keinen Sourceproof-/FD-Snapshot nach Preview. Kein Repreview oder Retry ersetzt diese Gegenproben.

## Separater eigener Ressourcenabschluss

Root-Session 76526 endete tatsächlich mit Exit 0. Ausschließlich die exakt gebundenen eigenen Datenbanken, DATA und tmp wurden entfernt; keine FORCE-Drops oder Sessionterminierungen. Beide exakten Datenbanknamen/OIDs, beobachtete Prozesse/Gruppen, Listener und Runlock sind geschlossen. Vier verwaltete Dienste bleiben identisch und gesund; drei Healthaufrufe liefern HTTP 200. Die Prozessbeobachtung erfasst nicht sämtliche kurzlebigen Startprozesse.

Cleanupbericht `/private/tmp/canvas-copy-ui-corrected-owned-cleanup-on42_niw/cleanup-report.json`, SHA256 `4df810ee52b75029696f43dc427b1b988682d7dd5c46dcbc55e2cabca0b3206d`. Alle 117 geschützten Originaleinträge einschließlich 108 Dateien bleiben byte- und identitätsgleich. Die externe Baseline und der negative Postreport bleiben separat anhand ihrer ursprünglichen SHA256 bytegleich; dafür wird keine zusätzliche Inodegleichheit behauptet. Es war kein Sourceparking nötig; der Ressourcenabschluss ändert den fehlgeschlagenen Browserstatus nicht.

Der erste negative Lauf und seine Belege bleiben ebenfalls erhalten; siehe [erster Browserbeleg](yjs-native-copy-browser-acceptance-evidence.md), Originalpostreport SHA256 `24d0a99d3b621223ec00044d01c91aa2a38be8fb976d914b5f3c0007b1edebb2`. Offen sind die beiden Ursachenprüfungen und eine neue vollständige Abnahme des korrigierten Stands. Es gibt daraus keine Produktänderung, allgemeine Aktivierung, Produktionsauslieferung oder Gesamtfreigabe. Dateiaktions-Undo und Review Center bleiben ausgeschaltet; diese Etappe erweitert sie nicht.
