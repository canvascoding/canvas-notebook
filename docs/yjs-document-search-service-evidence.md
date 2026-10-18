# Gemeinsame progressive Suche über native Dokumente

Stand: 18. Oktober 2026. Der ausgewählte native Suchschnitt ist lokal abgenommen: gezielte Wiederholungen auf finalen Quellen, angrenzende Regressionen, Scoped-Lint, unabhängiger Ressourcencheck, Root-/QA-Parität, frischer Originalbuild einschließlich Release-Produktcompiler und separater Artefaktabgleich bestehen. Der vollständige Typvergleich bleibt bei 69 bytegleichen Main-Diagnosen mit Exit 2. Eine kompilierte HTTP-/OAuth-/Browser-Suchabnahme oder Erfüllung des Gesamtauftrags wird dadurch nicht behauptet. Die bereits bestandene [Dateiaktionsmatrix 20/20](./yjs-scene-read-admission-evidence.md) gehört zu ihrem früheren Quellenstand.

## Vertrag und tatsächlicher Anschluss

Ein gemeinsamer Dienst in [documents/service.ts](../app/lib/documents/service.ts) bedient `POST /api/documents/search`, den expliziten nativen V1-Zweig von MCP `search_knowledge` und das registrierte PI-Werkzeug `search_documents`. Jeder Eintritt verwendet seinen tatsächlichen Request-, OAuth- beziehungsweise Invocationprincipal und dieselbe gehaltene READ-COMMITTED-/READ-WRITE-SQL-Verbindung. Cursor, Workspace-DTO oder Treffer erteilen keine Rechte. MCP benötigt aktuell `knowledge:search`; das vollständige Weiterlesen erfordert unabhängig `knowledge:read`. PI prüft die frische tatsächliche Werkzeugauswahl zusätzlich zur echten Invocation: feste Listen und `__none__` werden nicht erweitert. Die feste gemeinsame Policymechanik erhält den bisherigen Public-Share-Wrapper.

V1 durchsucht sichtbare initialisierte Yjs-Dokumente in Plain-, XML- und Blocks-Repräsentation, einschließlich nicht als Markdown exportierbarer Struktur und nativer Dokumente mit anderem Suffix. Fehlende oder veraltete Dateiprojektionen sind keine Inhaltsquelle. Pristine wird ohne Initialisierung ausgeschlossen; fehlende oder widersprüchliche native Authority bleibt Fehler. Physische Dateien, Scenes und PDF-Bodies werden in diesem Korpus nicht durchsucht. Der alte MCP-Pfad und `rg` behalten ihre bisherigen Datei-/Regexverträge.

Treffer enthalten stabile Dokument-/Lineage-ID, volle Inhalts- und Metadatenversion, beobachtete Dauerhaftigkeit und höchstens 512 UTF-8-Bytes Klartextausschnitt. Anschließend können bestehende ID-Leser das Dokument mit `expectedVersion=document.version` vollständig lesen. Es gibt keine nachträgliche Pfad→ID-Neuauflösung.

Die Literalsuche ordnet Kandidaten zuerst nach echten Titel-/Pfadmetadaten. Inhaltsranking gilt ausschließlich innerhalb des aktuellen Fensters mit höchstens acht Kandidaten. Standardlimit ist acht, öffentliches Maximum 25; ein Fenster oder das Ausgabebudget kann weniger Treffer liefern. Die vollständige Seite einschließlich Ref, Version, Coverage und Cursor bleibt unter 12.000 UTF-8-Bytes. Nur ganze Treffer werden zurückgehalten; der Cursor rückt um tatsächlich ausgegebene Treffer vor. Eine leere Seite mit `nextCursor` ist zulässig. Passt bereits ein ganzer Treffer nicht, entsteht `SEARCH_OUTPUT_TOO_LARGE` ohne Seite oder Cursorfortschritt.

Die Abdeckung benennt ausgeschlossene zu große, nicht unterstützte oder nicht lokal abgedeckte Owner und zählt keine versteckten/fremden Dokumente als öffentliche Treffer oder Kandidaten. `remoteLive` bleibt immer `unknown`, `globalCurrentContent` immer `not_certified`; `nextCursor:null` ist kein globales Vollständigkeitsversprechen. Eine Korpusänderung invalidiert die Fortsetzung ohne automatische Suchwiederholung.

## Quellenbindung und Begrenzungen

Ausgangs-HEAD ist Root `6af4bf2e6f988c2aaaadbbb5cfb3dd58635307d6` plus den damals uncommitteten Suchquellen. Originalbelege liegen unter `/private/tmp/canvas-native-search-integration-130qejx6`. Das ursprüngliche `applied-product-manifest.json` bindet die 21 Produkt-/Adapter-/Dispatcherdateien; SHA-256 `0a8362366139a3b8561cf7a0adda55c03cf7e5554e29561ed060faca65e60949`. Sein damaliges `testsRun:false` und `qaMirrorPending:true` bleiben ursprüngliche Vorabangaben, kein später aktualisierter Laufbericht. Nach engen Typnarrowingkorrekturen bindet `tested-source-manifest-v2.json` die 25 Code-/Test-/Runnerdateien; SHA-256 `bcbd48922e2432f5c52dedf43c83fec8d79469af84f0af083edb538f8c0512b9`. Das finale `tested-source-manifest-v3.json` hat SHA-256 `658fbc939bf4ccff339712d309f8219f1791aeb344749e21ffc30b811bdd82eb`; gegenüber v2 ändern sich ausschließlich zwei begründete Kommentarzeilen am legitimen Room-Hook-`this` für abgewartetes Cleanup, keine Runtimebytes. Die ursprünglichen Funktionsläufe bleiben ihrem ursprünglichen Quellenstand zugeordnet.

Alle fünf tatsächlichen Wiederholungen auf v3 enden mit Exit 0: Vertrag3, Request-/REST-Service4, Socket-/Owner-Room2, registrierter Dispatcher6 und Native-ID26. `revised-source-reruns.terminal.json` bindet tatsächliche Startzeit, Dauer, Exit und Originalloghash jedes Laufs sowie unveränderte Quellen; SHA-256 `671f8e466cf7b7614a6d25c8a3801fcb05bf25753a218def9a7ed73f6fa9435c`.

Die unveränderten finalen Quellen sind anschließend lokal als Root `06720908e3ae4360e9049073dd251ba169af57a1` / QA `9e6d4c5d486ec7704daed4fb7e01d6ffd5eed1b3` committet. Beide Checkouts sind sauber, alle 25 Quellen bytegleich. `committed-source-parity.json`, SHA-256 `b15845fb21dfb0672ad93911e73affde07c2d984d1992688e9ee3c6455cf7f26`, erhält ausschließlich die drei bekannten geschützten Differenzen; deren Delta hat SHA-256 `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`. Ein späterer Dokumentationscommit ist kein neuer Produktlauf.

| Quellenpaket | SHA-256 |
| --- | --- |
| Kernel, Vertragsdecoder und vier bestehende Reader-/Katalogseams | `863b509ba10608f7a6f9532d0e087ef1ba3f21ec40d794bacbbf6f5b0240f281` |
| Gemeinsamer Dienst, REST/MCP/PI und feste Werkzeugpolicy | `f224b513f011ecb8e17bfe71de317d7335355d27aad7852bb9d7978ba18af0de` |
| Registrierte echte MCP-/PI-Suchprobe | `926215c9d14fd60f8e18fc530d6bc5364fb34df44e8c643b25a3296b17e16446` |

Der [Suchkern](../app/lib/collaboration/native-document-search.ts) verbindet den dauerhaften Katalog mit tatsächlichen `pg_locks`-/Backendstart-/Ownerrowbelegen und dem [lokalen Raumbestand](./yjs-document-search-census-evidence.md). Die lokale Serverinstallation liefert echte geladene Rauminstanzen; ein nicht lokal abgedeckter aktiver SQL-Owner wird ausdrücklich ausgeschlossen. Ganze Katalog-/Owner-/Metadaten-/Sequencebelege werden nach dem Lesen unabhängig erneut auf derselben Verbindung geprüft. Für das aktuelle Fenster bindet ein SHA-256-Vergleich die wirklich geladenen State-/Vectorbytes an den zuvor beobachteten Rawzustand; ein vorübergehender A→B→A-Wechsel um den Bodyload wird nicht als derselbe Read ausgegeben.

SQL begrenzt Zahl und Headertext vor dem Transfer auf 10.000 Einträge und acht MiB. Persistierter State/Vector sind je Dokument auf zwei MiB/128 KiB, je Fenster auf acht MiB/512 KiB begrenzt. Der tatsächliche Persisted- und Live-Yjs-Preflight läuft vor Schema-/Inhaltsmaterialisierung und zählt Clients, Structs, Historie, Strings, JSONtiefe sowie Formatattributverstärkung. Semantischer Text wird vor jedem Append auf 256 KiB begrenzt. Bestehende Reader ohne den optionalen Suchbudgetparameter behalten ihre bisherigen Defaults.

Die bestehenden Principal-/SQL-Phasen behalten ihre fünf Sekunden; der Suchkern hat zusätzlich ein konservatives Viersekundenbudget. Das ist keine garantierte präemptive CPU-/Heapgrenze des synchronen Yjs-Decoders. Keine neue Seite verlässt den festen Dienst vor erfolgreichem COMMIT und abgewartetem Verbindungsabschluss. Unbestätigte Abschlussfehler geben keine vorbereiteten Snippets aus.

Notebook-main `67c509c08a204b7481fa063cf5de007de8538dd4` und Marketplace-main `54ce6573502f67f4cb6227871000aa315ab87dbe` wurden laut `latest-main-refresh.json` am 18. Oktober um 07:34:25.485617 UTC erneut geholt und blieben unverändert; Notebook-main ist enthalten. Das belegt weder einen neuen Standard-Skill noch eine Marketplaceveröffentlichung. Der bestehende Yjs-/Next-Quellenfingerprint erfasst `seed_skills` nicht; die spätere Standard-Skill-Abnahme muss vollständige Core-Paket-/Referenzhashes und tatsächlich ausgelieferte Seeddateien gesondert bestätigen.

## Tatsächlich bestandene lokale Teilprüfungen

Alle folgenden Originalläufe enden mit Exit 0. Sie verwenden den bestehenden begrenzten ESM-Quellstarter mit echten installierten Konstruktoren und einem gemeinsamen privaten DB-/Principal-/Invocationgraphen. Die PG-Prüfungen verwenden tatsächliches PostgreSQL und echte Autorisierung, keine substituierten Auth-, SQL- oder Dienstergebnisse.

| Originallog / Prüfung | Bestanden | Reichweite |
| --- | --- | --- |
| `search-contract.original.log` / `native-document-search-contract-test.ts` | 3/3 | Strikter Decoder, echte Yjs-Historien-/Format-/Strukturgrenzen und begrenzte semantische Extraktion; mechanisch, kein PG-Grant |
| `search-service.original.log` / `native-document-search-service-postgres-test.ts` | 4/4 | Echter Request/REST, fehlende/stale Projektionen, Ranking/Fortsetzung, Korpus-/Raw-A→B→A-Konflikte, aktuelle ACL und verlorene reale COMMIT-/Close-Bestätigung |
| `search-live-room.original.log` / `native-document-search-room-postgres-test.ts` | 2/2 | Echter Cookie-/Socket-/Hocuspocus-/PG-Owner, ungespeicherte Liveversion samt ID-Read, tatsächliches Raumupdate vor Finalcheck und ausdrücklich nichtlokaler Owner |
| `search-dispatch.original.log` / `document-search-tool-dispatch-postgres-test.ts` | 6/6 | Registriertes MCP `tools/list`→`tools/call`, Plain/XML/Blocks-Suche→versionsgebundener Read, getrennte OAuth-Such-/Leserechte, Legacyerhalt, echte PI-Registry und frische Deaktivierung, vollständiges Runtimeausgabebudget |
| `native-snapshot.esm-original.log` | 9/9 | Bestehende native Snapshotverträge |
| `workspace-native-search.original.log` | 8/8 | Bestehender semantischer/physischer Suchreader |
| `search-room-census.original.log` | 57/57 | Bestehende lokale Censusobserver |
| `legacy-mcp-routing.original.log` | 5/5 | Bestehende MCP-Suchroutingassertions unverändert |
| `legacy-native-id-read.original.log` | 26/26 | Bestehender echter Native-ID-/Principalreader auf PG18 |
| `legacy-document-read-service.original.log` | 21/21 | Bestehender öffentlicher PG18-Lesedienst einschließlich bestätigter Freigabe aller 17 beobachteten SQL-Leases |
| `legacy-read-dispatch.original.log` | 15/15 | Bestehende registrierte MCP-/PI-Leseadapter samt tatsächlichem Fixture-/Adapterabschluss |
| `public-share-create.original.log` | 46/46 | Bestehende Public-Share-Create-/Policygruppen; eigenes Schema/DATA entfernt, null offene Clients |
| `public-share-revoke.original.log` | 60/60 | Bestehende Public-Share-Revoke-/Policygruppen; eigenes Schema/DATA entfernt, null offene Clients |

Der Sockettest belegt echte offene Räume und neuere ungespeicherte Inhalte bei separat nachgewiesenem älterem SQLstand. Er ersetzt keine globale Remote-Liveabdeckung. Die registrierte Werkzeugprobe ist ein tatsächlicher MCP-Web-Request-Transport, kein TCP-/kompilierter OAuth-End-to-End- oder vollständiger Live-Chatturn-Nachweis. Der PI-12k-Nachweis betrifft die tatsächlich getrennt geprüften Tooltext-/Detailsausgaben; er garantiert kein ungekürztes kumulatives Modellkontextfenster.

Der finale begrenzte ESM-Runner besitzt SHA-256 `1e73a388e7ef564553ec277bed24525658cdf50d216a04733f4a7f3c35c628c2` und vier neue sowie acht Regressionseinträge. Scoped-Lint besteht tatsächlich für alle 25 Code-/Test-/Runnerdateien mit Exit 0. Der vorherige Lauf endet an `no-this-alias`; die gezielte begründete Direktive am echten Hook-`this` erhält dessen tatsächlichen Cleanupvertrag, der rote Originallog bleibt erhalten. Der frische Originalbuild und separate Artefaktabgleich bestehen wie unten gebunden. Eine kompilierte HTTP-/OAuth-/Browser-Suchabnahme ist kein Bestandteil dieses Nachweises.

Der unabhängige ausschließlich lesende Postcheck endet tatsächlich mit Exit 0. `search-readonly-postcheck.original.json`, SHA-256 `af7e5652f20888b3fd883ed346f5ffc8b654c953674709361a781af512f5ce13`, bestätigt 25 unveränderte Quellenpins und 25 gebundene Logs sowie aktuelle Abwesenheit von acht protokollierten Schemanamen, sieben tatsächlichen Schema-OIDs, sieben protokollierten Anwendungsfamilien, acht DATA-Pfaden und 18 Bundleverzeichnissen. Sein eigener READ-ONLY-Client hat COMMIT und echtes Endereignis abgewartet. Originalprozess-Exitcodes stammen getrennt aus Roots Originalläufen; fehlende ursprüngliche Ressourcenidentitäten werden nicht rekonstruiert. Legacy-Präfixabwesenheit ist keine exakte historische OID-Prüfung, ENOENT kein ursprünglicher Inodebeweis; kein vollständiger Kurzprozess-Census und keine unabhängig zweite Clientprüfung des Auditbackends werden behauptet.

Die erste aktuelle vollständige Typprüfung (`full-types.original.log`) endet tatsächlich mit Exit 2: 77 Diagnosen, davon 69 unverändert aus der akzeptierten Main-Baseline und acht neu. Nach engen Typnarrowingkorrekturen endet der echte zweite vollständige Lauf (`full-types-v2.original.log`) ebenfalls mit Exit 2, jetzt bei ausschließlich den 69 bytegleichen Main-Diagnosen ohne zusätzliche Diagnose. `full-types-v2.comparison.json` bestätigt SHA-256 `f87d64a219dd9317c7a22890a2687240cbf81b79851e829dd8117faa2ea561e3` für beide Diagnoseausgaben. Das ist kein grüner vollständiger Typecheck; der getrennte Release-Produktcompiler im frischen Build besteht. Beide Originalläufe bleiben erhalten.

## Frischer Originalbuild, Artefakte und begrenzter Prozessabschluss

Auf unveränderten sauberen Root-/QA-Commits `06720908e3ae4360e9049073dd251ba169af57a1` / `9e6d4c5d486ec7704daed4fb7e01d6ffd5eed1b3` endet der eigene originale Produktionsbuild tatsächlich mit Exit 0 nach 955,331 Sekunden. Buildwurzel: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-build-2R4fhi`; ursprünglicher Wrapperlog SHA-256 `ae68e66db86a36795c552e42c68ce1e6e3f670b4689441d5c54c3ebc3684c5ae`. Release-Produktcompiler und vollständige ursprüngliche Buildgates bleiben erhalten und bestehen.

Der separate ausschließlich lesende Artefaktprüfer endet ebenfalls tatsächlich mit Exit 0. `production-artifact-postcheck.original.json` hat SHA-256 `c3d362bcaaac0bacdc108a33acee8180983647045fcb7d3b1171d4def1fdcff1`. Alle 25 Quellenpins sowie Root-/QA-Fingerprints bleiben vor/nach der Prüfung unverändert; die drei bekannten geschützten Differenzen bleiben exakt gebunden. Build-ID `build-TfctsWXpff2fKS`, Buildfingerprint `88fe9d191fe9c92a71c289fde3c85d142788a754740d40afb858e4ea66ae6015`. Das versiegelte Artefakt enthält den lesbaren kompilierten Routepfad `/api/documents/search/route` mit SHA-256 `a9eef7771e52d59c453ff0c5bf87d1a0829e52a89bd5137542593a5918dc4410`; dies ist kein ausgeführter HTTP-Request.

`build-process-closure.original.json` bestätigt nach tatsächlich erfolgreichem Prüflauf die Abwesenheit aller neun tatsächlich gesampelten Prozessgeburtsidentitäten und ihrer drei erfassten Gruppen. Vier bereits bestehende verwaltete Dienste behalten ihre IDs und sind unverändert gesund. Nicht gesampelte historische Kindprozesse werden nicht nachträglich als vollständig erfasst behauptet. Kein Container wurde für diesen Suchschnitt gebaut.

### Erhaltener ursprünglicher Loaderfehler

`npm run test:collaboration:native-snapshot` endet ursprünglich vor den Assertions mit Exit 1: `ERR_PACKAGE_PATH_NOT_EXPORTED` für `@earendil-works/pi-ai/compat` im TSX-CJS-Pfad. Das installierte Paket exportiert den Subpfad für `import` und Typen, nicht für `require`. Der Originallog bleibt erhalten, SHA-256 `b95f268902933a2548523e6fa3818369d179a76800fd578cbd343ea3623c8094`.

Der rein lesende Vergleich mit `git show 6af4bf2e6:…` belegt bereits dort die eager Importkette Snapshotprobe→Checkpoint→PublicShares/Writer→Requestprincipal→Sessionworkspace→Extension-/Packagekontext→Workflowkonfiguration→Agentdefault-/Runtime-/Bootstrapdienst→`catalog-discovery`/`model-resolver`→PI-Compat. Die neue Snapshotkante Suchbudget→Dokumentverträge fügt keinen PI-Runtimeimport hinzu. Das ist ein Quellenbefund; ein tatsächlicher unveränderter CJS-Baselinelauf wurde nicht ausgeführt. Der anschließende echte ESM-Lauf besteht 9/9, SHA-256 `0e5ad5c7b64b1ac27e0849474fa8d603eb2ab5b2624c2b1af86408018f300a4d`.

## Verbleibende Grenzen

Dieser Schnitt liefert kein externes SDK, keinen ausgelieferten Documents-Standard-Skill, keinen nativen PDF-Import, keine allgemeinen Create-/Import-/Edit- oder MCP-Dateiaktionsanschlüsse und keine abschließende Gesamt-E2E-Freigabe. Allgemeines Aktivierungsgate, Dateiaktions-Undo und Review Center bleiben ausgeschaltet. Kein PR, Push, Containerbuild oder Produktionsrollout ist durch diese Teilprüfungen belegt.
