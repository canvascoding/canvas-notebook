# Native Copy: dritter Browserlauf und zwei mobile Fehler

Stand 17. Oktober 2026. Der frische Produktionsbuild besteht. Der anschließende originale Browserlauf endet mit Exit 1: **4/6** native Copyfälle bestanden, zwei mobile Fehler; Origin2 und UndoOFF2 wurden wegen dieses Fehlers nicht gestartet. Die vollständige Zehn-Fälle-Abnahme bleibt offen. Frühere Backendnachweise bleiben an ihre Quellen gebunden.

## Quellen und tatsächlicher Build

Der Lauf verwendet Root `7623e3cb8ff17c7952626dcf7bfa26fc8f0cf093`, QA `ac6c0923cbbf27ec7ae854ba3bbd1ab676f1f834` und Control Plane `27c8ce37da082244f006ca376068cde6b98845d5`. Root/QA unterscheiden sich ausschließlich durch das private Aktivierungsgate und die beiden bekannten Evidenzdokumente; binärer Patch-SHA256 `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`.

Die neue Sourceprüfung endet mit Exit 0 (54248). Bericht `/private/tmp/canvas-copy-ui-origin-order-pending-29o3o4ai/source-report.json`, SHA256 `e5333d4f3ec3e1a5544fdd9974b2a8562b584135df300fa7c2b3ccfee0aed8e0`. QA-Quellenfingerprint `8e2170a6aedfc06d5e91be633adf36989e9bda4db4aff36363babfdb5786a1de`.

Der originale Aufruf `node --conditions=react-server --import tsx scripts/run-yjs-authority-e2e.ts build` im QA-Checkout endet tatsächlich mit Exit 0 (64549). Er führt den ursprünglichen Produktionsbuild aus; kein Container oder Image wurde gebaut. Neues privates Buildverzeichnis `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-build-rk0TZa`, Buildlog-SHA256 `ebdb743c5a0ce71df0f9476af32773055145628a99e5ee236befaf9b4cbbbe2b`. Neue Proof-SHA256 `f77f6ff466b9f75b500093394eaf63b419762df8d7c9efd60ded62906b7f073f`, Build-ID `build-TfctsWXpff2fKS`, Buildfingerprint `735429f9b202b61bd258b737d5f6132e9bbb7ab5a6965368bf2b7ede50ec5fe1`.

Die unabhängige Artefaktprüfung endet mit Exit 0 (4191), Bericht `/private/tmp/canvas-copy-ui-origin-order-pending-29o3o4ai/artifact-report.json`, SHA256 `0e1ec7f196bd495dad66ab5d9ec4e420209d439f7d7d4683e6b73370aa92d17f`. Quellen, Build und die tatsächliche QA-API3-Binärdatei sind gebunden; es wurde kein altes Buildartefakt übernommen.

## Originaler Browserlauf

Der originale serielle Supervisor endet tatsächlich mit Exit 1 (93187). Ein Worker, null Retries, unveränderte Tests und Deadlines. Auswahl: `tests/workspace-operation-native-copy.spec.ts`, `tests/workspace-operation-copy-origin.spec.ts`, `tests/workspace-file-undo-disabled.spec.ts`.

Privates Fixture `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-tnf1zm`; numerischer Originalbericht `results/workspace-operation-native-copy/browser-outcome.json`, SHA256 `3b06b7b6188a12620232c4f64ecb7b3b61a649ec44d26fe5d6571dd6c89c07a1`. Originalbrowserlog-SHA256 `5fceec57e2e1556b56194a943c3d97908e9b2a5f561561e8c911a94fbcc1aca2`.

| Fall | Tatsächlicher Ausgang |
| --- | --- |
| Desktop: manuelle native Kopie, relativer Keep-Link und spätere isolierte Klonänderung | bestanden |
| Desktop: gemischter Ordner über Workspaces, nativer interner Link, PDF und historische Wiederaufnahme | bestanden |
| Desktop: Pending-Recovery erreicht bereits offene Zielansicht und erhält gemeinsamen Titel | bestanden |
| Mobil: manuelle native Kopie und isolierte Klonänderung | bestanden |
| Mobil: gemischter Ordner und interner Link | fehlgeschlagen: kein erwarteter Session-POST nach „Open link“ |
| Mobil: Pending-Recovery und historischer Aufruf | fehlgeschlagen: weiterer Files-Heartbeat bleibt im ursprünglichen 40-s-Fenster aus |
| Herkunft2 und Dateiaktions-UndoOFF2 | nicht gestartet |

Die numerischen Originalwerte sind declared6/passed4/failed2/skipped0/timedOut0/interrupted0. Der alte Transportabbruch beziehungsweise frühere Apply409 werden dadurch weder rückwirkend erklärt noch als behoben nachgewiesen.

## Belegte native Inventurlücke

Der unveränderte mobile Trace zeigt beide nativen Klone bereits mit Session HTTP200, eigener Dokumentidentität, Sequenz0 und `projectionFinalized:false`. Danach liefern zwei frische `/api/files/tree?...&noCache=...`-Anfragen nur die kopierte PDF. Auch der erste Linkindex des neuen Browserkontexts enthält beide nativen Dokumente nicht, meldet jedoch vollständige Coverage. „Open link“ erzeugt den sichtbaren Toast „Document not found“; ein Session-POST ist damit tatsächlich ausgeblieben. Erst spätere Antworten enthalten die inzwischen projizierten Markdown-Dateien und korrekten Links.

Die Ursache ist quellenbelegt: `buildWorkspaceLinkIndex` liest über den Referenzcache ausschließlich `listDirectory` und anschließend physische Dateibytes; `buildFileTree` inventarisiert ebenfalls nur das Dateisystem. Der Native-Copy-Finalizer invalidiert Referenz-/Ansichtscaches bereits korrekt. Ein Cache-Refresh kann die fehlende native Autorität nicht ergänzen.

Erforderlich bleibt ein gemeinsamer lesender Linkindex aus echten nativen Inventories und originalen physischen Quellen sowie die sichtbare Namespaceunion für Files einschließlich logischer Eltern. Native Referenzen dürfen keine erfundenen Markdown-Quellspannen bekommen. Die bestehenden körperlichen Änderungsrezepte bleiben getrennte Verträge. Diese Integration ist in diesem Beleg noch **nicht umgesetzt oder abgenommen**. Es gibt keine künstliche Projektionswartezeit oder Neuladung im Browserfall.

## Heartbeat-Gegenprobe und enge Korrektur

Der Trace belegt eine reguläre Erneuerung des Files-Watchers nach rund60s anhand einer neuen echten Client-ID und erfolgreichem `/api/files/watch`-POST. Die Quelle sendet Heartbeats erst nach30s, erneuert den Stream aber nach60s. Wenn die Erneuerung den gleichzeitig fälligen Intervallcallback zuvor abbricht, kann bis zum ersten Heartbeat des neuen Streams eine Lücke von rund60s entstehen.

Die Originaltrace enthält keine gespeicherten WebSocket-Framepayloads. Die genaue Callbackreihenfolge beziehungsweise Subscription-ID ist deshalb für diesen Originalfehler nicht nachträglich bewiesen. Die Erklärung ist mit dessen Zeiten vereinbar; die separate deterministische Gegenprobe beweist den möglichen Fehlerpfad.

Neuer unverändert wiederholter Regressionstest in `scripts/live-events-bridge-test.ts`: echte Watch-Route, echte Bridge und echter SSE-Parser, Refresh vor altem Intervall, normale Wiederanmeldung mit derselben logischen Subscription-ID, alte Callbackfences und späterer403-Widerruf. Vor der Produktkorrektur endet der vollständige Aufruf `node --conditions=react-server --import tsx --test scripts/live-events-bridge-test.ts` mit Exit1 und11/12; ausschließlich die neue Wiederanmeldungsprüfung scheitert bei1 statt2 Heartbeats (Originaltoolausgabe `6542c5`). Danach besteht derselbe Aufruf12/12 mit Exit0 (`1949fb`), ohne Skip oder Cancel. Es wurden keine nachträglichen Original-Logdateien erzeugt.

Die Produktkorrektur sendet einen echten initialen Heartbeat erst nach Autorisierung, Watcherregistrierung, vollständigem Cleanup und Abortprüfung. Danach bleibt das30-s-Intervall unverändert. Die60-s-Zugriffsprüfung bleibt erhalten. Bereits abgebrochene Requests senden keinen Heartbeat; Fehler und späte Callbacks nutzen die bestehenden Cleanupfences. Watch-Route-SHA256 `20ca3e47ca992de319a5487045de51cbfbb6cee8a55a7d393dac98f17df81b01`, Test-SHA256 `b22c3a4a418adf34aa9c183190dff217268c0dec42293e3954d8e3a2fa416b55`.

GitNexus: WatchGET LOW/0 direkte registrierte Aufrufer; bestehende Testfixture LOW/1. Der unabhängige lesende Diffreview findet keine neue Regression. Fokussiertes ESLint endet mit Exit0 (80261). Der erste vollständige cachefreie TypeScript-Lauf endet am4-GiB-Node-Heaplimit mit Exit134 (2856); die unveränderte vollständige Prüfung mit explizitem16-GiB-Heap endet anschließend mit Exit0 (33720). Der echte Browsernachweis nach der Korrektur bleibt offen.

## Unabhängiger Abschluss des roten Originals

Die passive Livebaseline wurde während der echten Browserphase aufgenommen: `/private/tmp/canvas-copy-ui-origin-order-pending-29o3o4ai/baseline.json`, SHA256 `359d14f958df6c8c83bbb236a24e77843f00bf9bb1688e52ea625e798b821713`. Sie enthält eine begrenzte Prozessstichprobe, keine vollständige Kurzprozessüberwachung.

Nach dem tatsächlichen Originalexit endet der ursprüngliche rein lesende Postcheck ebenfalls mit Exit1 (91010), Bericht `postruntime-report.json`, SHA256 `af957eadff8fc30d39a4e71970b559d22a375a368aa959d23855c124027f6aaf`. Die Browserabnahme bleibt fehlgeschlagen. Alle beobachteten ursprünglichen Prozesse, fünf Gruppen, drei Ports und Runlock sind geschlossen; keine Backends der beiden eigenen Datenbanken. Beide DBs und DATA/TMP bleiben zunächst absichtlich erhalten.

Die stehen gebliebene Issuer-`ready`-Quittung entspricht dem vorgesehenen Preserve-Pfad: Bei fehlgeschlagenem Browserlauf wählt der Supervisor SIGKILL für den eigenen Issuer; dessen regulärer `close()` schreibt die Cleanquittung dann nicht. Aus dieser Quittung wird kein zusätzlicher Produktfehler abgeleitet.

Nach abgeschlossener Tracediagnose führt Root den getrennten, streng gebundenen Cleanup tatsächlich aus (51153, Exit0). Bericht `/private/tmp/canvas-copy-ui-origin-order-owned-cleanup-ktowlt3i/cleanup-report.json`, SHA256 `7dcc9c2165ea5eaf55572afd7b5945eccf8ce7ba9858354b7be5244dd7b52bfe`. Ausschließlich die beiden eigenen exakten DBs/OIDs werden nach Name/Owner/Marker- und Nullbackendprüfung normal entfernt; keine Sitzungsbeendigung oder FORCE. DATA/TMP werden relativ zum gehaltenen originalen Root-FD nach Identitätsprüfung entfernt. Alle119 geschützten Originaleinträge einschließlich110 Dateien und18 externe Originaldateien bleiben byte- und identitätsgleich; eine weitere unabhängige Dateiprüfung bestätigt dies. Die Laufzeitabfragen zeigen DB-/OID-Abwesenheit, leere eigene Gruppen/Ports und unveränderte gesunde vier Managed-Dienste mit drei HTTP200. Die spätere unabhängige Dateiprüfung wiederholt keine SQL-/Prozess-/Healthabfragen.

Originale Berichte, Quittungen, Traces und roter Status bleiben erhalten. Keine allgemeine Aktivierung, Produktionsmutation, Auslieferung oder Review-Center-Erweiterung; Dateiaktions-Undo bleibt für alle Dateitypen und Ordner ausgeschaltet. Der vollständige Plan einschließlich Move/Delete-V2-Anschluss, Create/Import/API/MCP/PI/Mobile, progressiver Suche, externem SDK, Standard-Skill, PDF und übriger Sandboxabnahme bleibt im Auftrag.
