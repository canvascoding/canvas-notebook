# MVP-Abnahme: aktueller Ergebnis- und Evidenzindex

Stand: 22. Oktober 2026, letzter Laufabschluss am 21. Oktober um 23:39:13 UTC. **Kein gemeinsamer MVP-/Main-/Produktionsabschluss.** Dieser Index trennt abgeschlossene Teilnachweise, offene Pflichtabnahmen und historische Originale. Die früher mehrfach geführte Laufchronologie ist hier konsolidiert; zugrunde liegende Logs und Artefakte werden nicht gelöscht. Architektur: [Masterplan](./yjs-document-authority-consolidation-plan.md). Nächste Schritte: [Launchplan](./yjs-document-authority-mvp-launch-plan.md).

## Aktueller Ergebnisstand

| Bereich | Nachweis und Grenze |
| --- | --- |
| Full 36 jüngster Abschluss | Session 79724: **Originalexit 0 / alle 36 Gruppen bestanden**, unverkleinert / Selector unset / Profiler aus / Revisionen OFF / 155 Pins. Log `owner-physical36-settled-observer31-full36.log`, SHA `dae344a9e5433f79f0478d781716d8a6c501e05deb1f303628b7e172a0ab0f08`. Unabhängig geschlossen um 23:39:13.419 UTC; Gate 1 geprüft, keine gemeinsame MVP-/Browser-/Main-Abnahme. |
| Pure / fokussierte Web-Gegenprobe | Pure25: Originalexit 0, Log `physical5-historical-details-pure25.log`, SHA `d1ba04b14c8bda62b58388ed8767b138d972c3fe12b186c6e020066ef7ebebff`. Session 18976: Originalexit 0 / ein Web-Fall / 35 ausgelassen, Log `owner-physical36-historical-details-web-focused.log`, SHA `9874de3fea0a989712c60e682e19ed452c497711ff29838ea74b8a9b028eac40`. Keine Full36-Abnahme. Claim40 auf PG18: Session 21144 / Originalexit 0 / 40 Familien, Log-SHA `65d48fd8a3fedc2756320fc774b49136b597c1c3170c3fd511bb3acb7c64c8e8`. Fokus60-CPU-Baseline 6021: RED, zweiter Web-B2 `PRINCIPAL_EXPIRED` nach 5.015 ms / 792 Fehler- und 793 Schlussqueries / 23 begonnen und 22 abgeschlossen / kein COMMIT; Log-SHA `99fe28921ca803d8947eed75ca08281364ecd7bcca6ad9a2a42f4b83a239f6c8`. |
| Vorheriger GET-Grammar-Lauf | Session 46020: Exit 1 / RED nach 28 Gruppen. Menschliche Phase 3 besteht in 3.796 ms / 243 Queries / sechs vollständigen Current-Prüfungen. B2: `25P04` nach 5.009 ms, 538 Fehler- / 539 Schlussabfragen, zehn begonnen / neun abgeschlossen, kein COMMIT. Status-GET-Grammarframe reicht nicht. Log-SHA `00cf246e8406e6c21ea7229b4fc18d7e764030719ad569f937cbaf82cc4cd58f`. |
| Vorheriger Lastbefund | Session 5570: RED28, Case18 und Phase 3 bestanden (3.972 ms / 243 Queries / sechs Checks), danach B2 `PRINCIPAL_EXPIRED` nach 5.008 ms, 739 Fehler- / 740 Schlussabfragen, 17 begonnen / 16 abgeschlossen. Log `owner-physical36-human-writer-settled-preview-full36.log`, SHA `794e1dd55d59b1d4c22d51592d7730ed0041f9715957df847c1c75c6a391bf61`; Nachbericht `independent-postcheck-owner-physical36-human-writer-settled-preview-full36.json`, entferntes Schema `copy_metadata_f9871033387843bbb832dca362129f1d` / OID 15698030. |
| Vorheriger Fixturebefund | Session 22239: RED nach 17 Gruppen beim FS-Vergleich nach bestandenen Stale-/No-DML-/SQL-Orakeln. Originalbundle SHA `becad8083d05d649d208149bc51e8baa24a07f24bab423e0cbe8e104fd819070`, Log-SHA `0c7215663750e676e468913c3c052e46648900e05d70b4394b7db5981b6779dc`. Der anschließend eingegrenzte Case18 ist im jüngsten vollständigen Lauf bestanden. |
| Full 36 älterer Budgetbefund | Session 91905: Exit 1 / RED nach 28 Gruppen, menschlicher Web-DELETE, Phase 3 final-check 5.076 ms / 328 Queries, `25P04`, kein COMMIT. Unabhängig geschlossen 20:35:22 UTC; 154 Pins unverändert. Log-SHA `d911ead1daa5327bc8fa9535f5093afd559e2f95292c5560d5b78007692dce43`. |
| DA04 VACANT | Echte Borrowed-PG18-Folge 47/47 mit unveränderten 42 alten und 5 neuen Fällen. 54 echte Rows, 52 unverändert / 2 geänderte, 4 separate Driftfälle. Log-SHA `8273f88aebbac4654b095392bb9d646f5b1173e3e52499489e11b9633b4ebcb0`. Kein ausreichender Full 36-Zeitgewinn daraus abgeleitet. |
| Früherer A-Backendabschluss | Owner 31/31, Exit 0 und unabhängig geschlossen; damaliger Stand mit ausgeschalteter optionaler Historie. Log-SHA `7967ea6ace1f96787d206c275239bc0e28e909ec40f0b14673a533a6fdc1ae35`. Keine aktuelle 36er-Gesamtfreigabe. |
| Copy und gewöhnliche Assets | Commit `cbe9dead3`: 35 Pflichtfamilien und 43 Regressionen, damaliges installiertes SDK-Wheel 70 Tests. Nachfolgende C1/C2-Änderungen benötigen neue passende Abnahme. |
| Raw-C1/C2 | C1 in `71c09176f` geprüft: Binding 13; PG Raw 11 / Vorbereitung 10 / Public 8 / Web 9 / Atomic 8; bestehende Copy 26 / Metadaten 15 / HTML 10 / Assets 5. Alle Originalexits 0, je Lauf unveränderte Quellen, Compiler/DATA und jeweilige PG-Ressourcen unabhängig geschlossen; letzter Abschluss 22. Oktober 00:33:36 UTC. Raw-Log-SHA `d9a7b5327e62ed56280dfc1426931a78a3c2c19895419c8fd4b207ba45deb1f2`, Web-Log-SHA `3d63fd13f472cf10c68f336a8073de875cec278a2c6ad6c6d6626e38b79523d9`. Belege bleiben an ihren jeweiligen Quellstand gebunden. C2 Binding 19/Raw-PG 14 und passende Copyregressionen bleiben Pflicht. |
| Cohort | 34-Path-Paket für native/gemischte Ordner/Mehrfach-Delete privat, 43 Ownerfälle deklariert. Strikte Source-/Inverse-Proofs und Grammaranschluss sind keine Compiler-/FD-/PG-/UI-Abnahme. |
| Finale Oberfläche/API/SDK | Ganze Matrix und Controller vorbereitet, noch nicht an endgültigen Build/SDK/Specs gebunden. Neue Viewer-/Cohortfälle müssen integriert werden. Revisionen-OFF-MCP 10 bleibt erforderlich. |
| Gesamtcheck | Letztes originales `test:all`: 234 bestanden, 218 fehlgeschlagen, 269 übersprungen, 88 nicht ausgeführt. [Konkrete Lücke](./yjs-mvp-full-test-runner-gap.md). |

Die unveränderlichen Physical5-Originalplandetails sind nach dem vorhandenen Native4-Muster übernommen (Physical-SHA `41f97f86d36ee050de41862f978cbad3311cee60350d40e81ef65e9b4191dfc3`, Pure-SHA `5f9f310d41042a3bd84cd9d8cbc62d5846d8d68e1414bd2c1af6540b108a26c1`). Zwei unmittelbar doppelte `current(captured)`-Aufrufe vor dem unveränderten `checkOwner` sind entfernt (Owner-SHA `8a77432f89e2b4fbdd76272becc9df018f9d316bb4e790f29528ec0a1c2de46f`). Vollständige Current-/Schreibprüfungen bleiben erhalten; aktuelle Dokument-, Rechte- oder SQL-Fakten werden nicht gecacht. Die begrenzte byteidentische Originalplanfragment-Wiederverwendung in Store und Claimtest ist übernommen (Store-SHA `e1b1a19e0ea715126584bc12b2a3ee613000ca17608d8fb4428bce1ec9048afd`, Claim-SHA `2c7649c1fba7d39c2a405c5d359beb4b7f0a04973d7c09cc835495908c8b5cfd`); Current-/SQL-/Rechte-/Expiryprüfungen bleiben bytegleich. TSC 76163 / Lint 82201: Exit 0. Claim40 ist auf PG18 grün; Pure25 und Web1 bleiben Teilbelege. Full36 79724 besteht mit 36/36. Der vorausgehende 33518 bleibt RED30 (Log-SHA `a82cda2fc8aaecc24f5fcacb809d958e79356480597d7b99c923873b32195e2a`): Der exakt rekonstruierte FS-Vergleich nutzte eine Baseline vor der vorhandenen Projektionsgrenze. Seine minimale Beobachterfensterkorrektur (Owner-Test-SHA `07d804cb74b35cf51a9d82fe22f1572dd88dd2e6a7395892aee062916518c657`) ist übernommen und im unverkleinerten grünen Lauf geprüft. C1 ist anschließend in `71c09176f` geprüft; C2-/Cohort-Integration und ihre Abnahmen bleiben offen.

Commit `4e53b0a71` entfernt gegenüber dem geprüften 155-Pin-Stand zusätzlich nur zwei leere Schlusszeilen, ohne Symboländerung; die Originalnachweise bleiben an ihre tatsächlichen Quellen gebunden.

Die Phase-Queryzahl erfasst die gesamte Transaktion, nicht nur den letzten Callback. Ein zuletzt gespeichertes Relationslabel identifiziert nicht automatisch das tatsächlich fehlgeschlagene SQL. 5-Sekunden-/Lock-/Authority-/Hash-/Coveragegrenzen bleiben erhalten.

## Prüfen statt aus Teilgrün schließen

Für jede tatsächliche Abnahme gehören zusammen: genaue Quelle/Commit oder unveränderliche Pins, unveränderte ganze Auswahl, erwartete und tatsächliche Fallzahl, Originallog samt SHA, Originalexit sowie unabhängiger Abschluss eigener Backends/Räume/Sockets/Schema-OIDs/DATA/Compiler. Fixture-Cleanup allein ist kein fachlicher Erfolg. Fokussierte Läufe benennen ausgelassene Fälle. Private Pakete, statische Discovery, Typen und Lint werden getrennt von Runtime geführt.

Der jüngste Full36-Abschluss `independent-postcheck-owner-physical36-settled-observer31-full36.json` bestätigt um 23:39:13.419 UTC Originalexit 0 / alle 36 Gruppen, 155 unveränderte Pins und entfernte Schema-OID 15766967, DATA und Compiler; vier Raumruntimes / ein Owner / zehn Sockets geschlossen, keine eigenen Backends oder vorbereiteten Transaktionen, Read-only-Prüfung zurückgerollt und Verbindung geschlossen. Der vorherige Full36 67406 bleibt RED28 (Log-SHA `231099db2d82724eee51483da70e58c97115581e208b30b48e217b955d7ee342`). `independent-postcheck-owner-physical36-focus60-cpu-baseline.json` bestätigt um 22:45:26.831 UTC Originalexit 1 / 154 Pins, entfernte OID 15749411, zwei leere geschlossene Räume und entfernte DATA-/Compilerressourcen ohne eigene Backends oder vorbereitete Transaktionen. `independent-postcheck-claim40-plan-fragment-pg18.json` bestätigt um 22:50:24.047 UTC Originalexit 0 / 40 echte PG18-Familien / 155 unveränderte Pins; eigene `job_scope`-Schemas, Backends und vorbereitete Transaktionen null, Compiler entfernt, Read-only-Prüfung zurückgerollt und Verbindung geschlossen. Die frühere CPU-Diagnose Session 64068 (Exit 0 / ein Web-Fall / 35 ausgelassen), Log `owner-physical36-web-cpu-baseline-focused.log`, SHA `ada865e17d7a9fcdce06a79dd02049703400056bf76164dd50156dd1721193de`, ist keine Full36-Abnahme; inklusive Profilzeiten des gesamten Falls überlappen und belegen keine B2-Zeitanteile. Der separate Diagnoseabschluss `independent-postcheck-owner-physical36-web-cpu-baseline-focused.json` bestätigt um 21:59:16.020 UTC nur einen bestandenen Fall, dieselben 154 Pins, entfernte OID 15725255 und zwei leere geschlossene Raumruntimes. Keine neue vollständige Abnahme daraus abgeleitet. Die neuen unabhängigen Abschlüsse `independent-postcheck-physical5-historical-details-pure25.json` (22:07:29 UTC / 25 reine Familien / Compiler entfernt) und `independent-postcheck-owner-physical36-historical-details-web-focused.json` (22:08:36 UTC / ein Fall / entfernte OID 15732766 / zwei leere geschlossene Räume / DATA und Compiler entfernt / keine eigenen Backends oder vorbereiteten Transaktionen) bestätigen jeweils Originalexit 0 und 154 unveränderte Pins.

Produktionsdiagnose auf Version `2026.10.17.2`: OAuth-Probe und beide betroffenen Dokumente wurden erfolgreich als `live_yjs` gelesen (gemeldete Größen 7.787 / 22.135). Die zwei fehlerbezogenen Control-Plane-Logabfragen über sieben Tage lieferten jeweils null Treffer. Das beweist keinen Fix: Eine Move-/Delete-Vorschau oder Dateiaktion wurde in Produktion nicht ausgeführt.

## Finale Abnahmepflichten

1. Physical 36 und fixed C1 geprüft und unabhängig geschlossen; nun fixed C2 samt echter Copy-/Import-/Originalreceipt-/späterer-History-Regressionswege.
2. Cohort 43 und vorhandene FD-/Planfamilien: normale native+PNG/PDF-Ordner, Mehrfachauswahl, gemeinsame Backlinkquelle, geöffnete zweite Sitzung, Partial-FS/B2/CAS/ACK-Recovery, gleiche ursprüngliche Identitäten und D2/NoRevival. Unsichere Auswahl vor Wirkung blockieren; Restore darf neuen Cohort-Payload nicht teilweise missverstehen, Undo bleibt OFF.
3. Finales installiertes Python-Wheel und SDK-Probe an exakt denselben Produkt-/Toolbuild binden. Package-Quellen oder frühere Wheeltests beweisen keine Veröffentlichung oder aktuelle OAuthfolge.
4. [Finale E2E-Auswahl](./yjs-mvp-e2e-matrix.md) nach Übernahme der privaten Fälle tatsächlich entdecken: ganze UI-Specs, MCP 10 separat, REST 6 separat, zwei reale Neustarts. [Controller-Vorbereitung](./yjs-mvp-final-acceptance-evidence.md) ist kein ausgeführter Build/Browserpass.
5. Effektive optionale Revisionen OFF, Review-Verfügbarkeit false, Dateiaktions-Undo 409 ohne Mutation und kein zusätzlicher Review-Annahmeschritt. MCP 10 ausdrücklich OFF und Null-Capture; Shadow-Belege nicht übertragen.
6. Originalbuild, relevante vollständige Prüfungen, erforderliche CI-Checks und sämtliche actionable Reviews auf dem finalen eigenen PR-Head, dann Main-Merge/Remoteverifikation. Kein Produktionsfix ohne reale ausgelieferte Version behaupten.

<details>
<summary>Erhaltene Referenzen der beiden vorherigen Statusstände</summary>

Diese Originalverweise bleiben historische Belege, keine aktuellen Laufzustände: `15680941`, `15689983`, `409 / PREVIEW_STALE`, `671e728745934e0a893b3bbe3a05d5ed`, `81d61fe7606d48fca769d66d38b2c261`, `independent-postcheck-owner-physical36-da04-vacant-profile-full36.json`, `independent-postcheck-owner-physical36-human-fixed-writer-full36.json`, `owner-physical36-human-fixed-writer-full36.log`.

</details>

## Historische Evidenz lesen

Der gemeinsame private Evidenzroot ist `/private/tmp/canvas-mvp-concurrent-move-20261020-Y8J3GcFs`. Weitere im Original genannte private Pfade bleiben unten erhalten. Nicht jeder historische Temp-Pfad ist dauerhaft verfügbar; die aufgeführten Hashes sind ursprüngliche Quellen-/Laufbindungen, keine erneute Verifikation ihres Inhalts. Erhaltene REDs bleiben REDs, spätere grüne Teilstände ersetzen keine neue Gesamtabnahme.

Die folgenden deduplizierten Register erhalten sämtliche ursprünglichen Markdown-Linkziele, Original-Linkbeschriftungen, inline benannten Pfade/Artefakte und Hex-Commit-/Hash-Tokens der drei ersetzten Dokumentstände. Herkunftsangaben verweisen auf deren exakt gesicherte Basen im privaten Doc-Paket; sie sind historische Einträge, keine aktuellen Arbeitsaufträge. Alte Abschnittsanker bleiben erreichbar. Die Kürzung begründet keine zusätzliche Freigabe.

## Historische Quellenbindungen

| Kürzel | Exakter ursprünglicher Dokumentstand | SHA-256 |
| --- | --- | --- |
| C | `docs/yjs-document-authority-consolidation-plan.md` | `d19bb711981cf1bd4798f217ab4efca51d715fa304eee15f328f74ea4ff13369` |
| L | `docs/yjs-document-authority-mvp-launch-plan.md` | `9a9cfeb4fc1c449384516c3cc5d5c2dbbcfdfc343eae80ec4ddfe16d3d3d2c0d` |
| A | `docs/yjs-mvp-tool-and-restore-acceptance.md` | `0b1a6d5f8eb1e96392698886036997183e3781edffc4a6d9c8a56f11962779bc` |

`C:L`, `L:L` und `A:L` bedeuten Ursprungskürzel und Zeilennummer im gesicherten Basisstand. Mehrfachvorkommen identischer Tokens werden zusammengeführt. Vollständige Basen und maschinelle Erhaltprüfung: `/private/tmp/canvas-mvp-concurrent-move-20261020-Y8J3GcFs/docs3-current-mvp-cleanup-xor668bf`.

## Historische Links

<details>
<summary>Erhaltene Originalverweise öffnen</summary>

- [#176](https://github.com/canvascoding/canvas-notebook/pull/176) — L:13
- [13 echte FS-Testgruppen](../scripts/workspace-original-file-source-test.ts) — C:1195
- [20 echte isolierte PG18-/Yjs-Testgruppen](../scripts/native-session-state-reader-postgres-test.ts) — C:1187
- [24 echte PG18-/BetterAuth-/Team-/Solo-Testgruppen](../scripts/authenticated-native-session-reader-postgres-test.ts) — C:1207
- [29 echte Auth-/PG18-/FS-Testgruppen](../scripts/workspace-pristine-original-bootstrap-postgres-test.ts) — C:1209
- [37 tatsächlichen PG18-Testgruppen](../scripts/workspace-request-principal-postgres-test.ts) — C:1203
- [Agent-Block-Admission](../scripts/collaboration-agent-block-admission-test.ts) — C:1003
- [Aktueller Copy-Nachweis](./yjs-native-copy-owner-integration-status.md) — C:239
- [Aktueller Lauf, Artefakte, Bereinigung und Grenzen](./yjs-scene-document-tree-evidence.md#vierter-build-und-vollständige-browserfolge-1820) — C:169
- [Aktueller Sourceprojektionsnachweis](./yjs-native-copy-source-projection-evidence.md) — C:235
- [Anschluss, echte Gegenprobe und genaue Grenzen](./yjs-mvp-tool-and-restore-acceptance.md#html-move-durch-plan-mutation-und-echten-owner-angeschlossen) — L:68
- [Anschlussplan für SQL-Nebenwirkungen und Veröffentlichung](./yjs-native-file-lifecycle-side-effects-plan.md) — C:1143
- [Anschlussplan für bereits native Dokumente mit anderem Dateisuffix](./yjs-existing-native-suffix-integration-plan.md) — C:1251
- [Anschlussplan](./central-notebook-file-api-import-plan.md) — C:1016
- [Anschlussplan](./yjs-native-session-bootstrap-plan.md#42-geschlossene-grundlagen-und-offene-rechtebindung) — C:1217
- [Archiv-Inspector](../app/lib/collaboration/archived-native-snapshot.ts) — C:1189
- [Batch-Executor](../scripts/workspace-operation-batch-executor-test.ts) — C:1003
- [Belege und Grenzen](./yjs-mvp-tool-and-restore-acceptance.md#clientanschluss-und-beobachtung-der-authentifizierung) — L:82
- [Block-Clipboard](../scripts/markdown-block-clipboard-test.ts) — C:1009
- [Browser-Abnahmeplan](./yjs-create-paste-browser-acceptance-plan.md) — C:1384
- [Browser-Test](../tests/editor-markdown-insertion.spec.ts) — C:692
- [Browserplan](./yjs-create-paste-browser-acceptance-plan.md#v14-undo-verlassen-und-vollständige-enge-webmatrix-bestanden) — C:1338
- [Clone-/Publicationkerne auf der tatsächlichen Aufruferverbindung und die frische Clone-Linkzuordnung](./yjs-native-copy-transaction-evidence.md) — C:245
- [Collaboration-Policy](architecture/canvas-notebook/team-workspace/18-collaboration-and-file-conflict-policy.md) — C:324
- [Combined-Handoff-Grundlage](../app/lib/markdown/native-file-operation-handoff.ts) — C:1137
- [Compiled-Mobile-Protokollgegenprobe](./yjs-mobile-compiled-protocol-precondition-evidence.md) — C:1273
- [Copy-Belege](./yjs-selected-raw-copy-owner-evidence.md) — C:68
- [Create-/Paste-/Vollimport-Anschlussplan](./markdown-create-paste-full-import-integration-plan.md) — C:1125
- [Create-Route](../app/api/files/create/route.ts) — C:690
- [CreateItemDialog.tsx](../app/components/file-browser/CreateItemDialog.tsx) — C:690
- [DashboardShell.tsx](../app/components/DashboardShell.tsx) — C:774
- [Dateiinfo-Endpunkt](../app/api/files/info/route.ts) — C:1159
- [Dateilink- und Dateioperationsplan](architecture/canvas-notebook/workspace-file-links-and-operations-plan.md) — C:324
- [Details und Grenzen](./yjs-native-metadata-writer-evidence.md) — C:308
- [Einfügedialog](../scripts/markdown-insertion-dialog-test.tsx) — C:1009
- [Einzel-Delete mit eingehenden Linkänderungen](./yjs-native-delete-links-evidence.md) — C:259
- [Erfolgreicher Originallauf und genaue Grenzen](./yjs-document-read-service-evidence.md#vierter-lauf-vollständige-kompilierte-http-abnahme-bestanden) — C:175
- [Ergänzung für API, MCP, interne Agenten, SDK und progressive Dokumentsuche](./workspace-document-api-mcp-search-plan.md) — C:267
- [Ergänzung für exakte Public- und Markdownpfade](./yjs-public-share-exact-path-evidence.md) — C:282
- [Erhaltener RED und notwendige Abnahme](./yjs-pi-markdown-create-evidence.md) — L:175
- [FD-basierte Copy-Unterbau und vollständige native Postcondition](./yjs-native-copy-publication-graph-evidence.md) — C:241
- [Feldinhalt](../scripts/markdown-field-content-test.tsx) — C:1007
- [FileEditor.tsx](../app/components/editor/FileEditor.tsx) — C:776
- [Fixture- und Abnahmegrenzen](./yjs-create-paste-browser-acceptance-plan.md) — C:1390
- [Fokus/Breite](../tests/editor-focus-width.spec.ts) — C:1007
- [Fundament für aktuelle Jobrechte auf der echten Lifecycle-Ownerverbindung](./yjs-owned-file-job-evidence.md) — C:290
- [Gast-Kollaboration](../tests/editor-guest-collaboration.spec.ts) — C:1007
- [Gegenprobe und genaue Grenzen](./yjs-unexportable-native-path-public-evidence.md) — C:68
- [Gegenprobe, genaue Änderung und Abnahmegrenzen](./yjs-session-capture-contention-evidence.md) — C:189
- [Genaue Gegenproben und Grenzen](./yjs-mvp-tool-and-restore-acceptance.md#implizites-rename-bei-angenommenen-noch-nicht-gespeicherten-rich-änderungen) — L:74
- [Genaue Quellen, Originale, Screenshots und Grenzen](./yjs-native-path-unlink-oracle-evidence.md) — C:84
- [Gesamtcheck](./yjs-mvp-full-test-runner-gap.md) — L:86
- [Gesamtcheckbericht](./yjs-mvp-full-test-runner-gap.md) — A:117
- [Getrennte Befunde und Abschlussbelege](./yjs-guest-writer-binding-evidence.md#siebter-gesamtlauf-anderer-ui-fokusfehler) — C:306
- [GuestMarkdownEditor.tsx](../app/components/file-guests/GuestMarkdownEditor.tsx) — C:756
- [Handoff-Ausführungskontext](../app/lib/collaboration/handoff-execution-context.ts) — C:1151
- [HomeNewNoteDialog.tsx](../app/components/home/HomeNewNoteDialog.tsx) — C:690
- [I-05-Einzeldatei-Chunkanschluss](./markdown-chunk-import-integration-evidence.md) — C:1287
- [I-07-Abnahmeplan](./yjs-create-paste-browser-acceptance-plan.md) — C:1388
- [Implementierung, genaue Formate, Nachweise und offene Grenzen](./yjs-managed-copy-owner-evidence.md) — C:183
- [Initialisierungsprüfung](../scripts/collaboration-initialization-admission-postgres-test.ts) — C:1009
- [Integrationsnachweis, ursprüngliche Fehler und Grenzen](./yjs-current-main-integration-evidence.md) — C:181
- [Konkrete Komplexitätsprüfung und Current-only-Folgevertrag](./yjs-document-authority-consolidation-plan.md#komplexität-begrenzen-verbindliche-trennung-für-das-mvp) — L:54
- [Konkreter Anschluss und Abnahme §4.1–4.3](./central-notebook-file-api-import-plan.md#41-standard-skill-und-kontext-erst-bei-bedarf) — C:316
- [Konkreter Stand und nächste Anschlüsse](./yjs-public-share-binding-evidence.md) — C:304
- [Konsolidierungsplan](./yjs-document-authority-consolidation-plan.md) — L:9
- [Korrektur der automatischen Public-Pfadauswahl](./yjs-public-share-lifecycle-path-evidence.md) — C:284
- [Korrektur temporärer nativer Lesesperren](./yjs-native-read-busy-evidence.md) — C:1205
- [Laufbindung, Matrix und Abschluss](./yjs-scene-document-tree-evidence.md#fünfter-build-und-gezielte-scene-browserfolge-24) — C:167
- [Leseumfang, Quellenhashes und Grenzen](./yjs-original-production-read-evidence.md) — C:237
- [Link-Write-Executor](../scripts/workspace-link-write-executor-test.ts) — C:1003
- [Link-Yjs-Edits](../scripts/workspace-link-yjs-edits-test.ts) — C:1003
- [Live-Dokument- und Agentenplan](live-document-agent-editing-plan.md) — C:324
- [MVP-Launchplan](./yjs-document-authority-mvp-launch-plan.md) — C:68, C:78, C:80
- [MVP-Plan](./yjs-document-authority-mvp-launch-plan.md) — C:52, C:54
- [Markdown-Feld-UI](../scripts/markdown-field-ui-test.tsx) — C:1007
- [MarkdownDocumentModes.tsx](../app/components/editor/MarkdownDocumentModes.tsx) — C:753
- [MarkdownEditor.tsx](../app/components/editor/MarkdownEditor.tsx) — C:754
- [MarkdownField.tsx](../app/components/editor/MarkdownField.tsx) — C:755
- [MarkdownInsertDialog.tsx](../app/components/editor/MarkdownInsertDialog.tsx) — C:692
- [Matrix, Korrektur und Abschluss](./yjs-scene-document-tree-evidence.md#sechster-build-und-vollständige-browserfolge-1720) — C:195
- [Matrix, statische Korrektur, Artefakte und Abschluss](./yjs-scene-document-tree-evidence.md#sechster-build-und-vollständige-browserfolge-1720) — C:165
- [Menü-Fokuskorrektur](./notebook-editor-bubble-focus-evidence.md) — C:1193
- [Nachtrag zur historischen Einzel-Recovery](./workspace-file-undo-disabled.md#nachtrag-historische-einzel-recovery-und-feste-identität) — C:666
- [Nachweise und Grenzen](./yjs-agent-tool-principal-evidence.md) — C:302
- [Nachweise und Grenzen](./yjs-guest-redemption-atomicity-evidence.md) — C:310
- [Nachweise und Testgrenzen](./yjs-public-share-read-evidence.md) — C:300
- [Native Inventur, Anschlüsse und Grenzen](./yjs-native-document-read-index-evidence.md) — C:221
- [Native-Mobile-Busyadapter](./native-mobile-peer-admission-adapter-evidence.md) — C:1285
- [Notebook-I-06-Createanschluss](./markdown-manual-create-integration-evidence.md) — C:1289
- [NotebookFocusContext.tsx](../app/components/notebook/NotebookFocusContext.tsx) — C:774
- [Offline-Kollaboration](../tests/editor-offline-collaboration.spec.ts) — C:1007
- [Original und Grenzen](./yjs-mvp-tool-and-restore-acceptance.md#implizites-rename-bei-angenommenen-noch-nicht-gespeicherten-rich-änderungen) — L:78
- [Originalbelege und Grenzen](./yjs-copy-history-foreign-key-evidence.md) — L:149
- [Originalbelege und Grenzen](./yjs-explicit-original-markdown-import-evidence.md) — C:80
- [Originalbelege und Grenzen](./yjs-native-path-unlink-oracle-evidence.md) — L:100
- [Originalbelege und Grenzen](./yjs-physical-native-import-binding-evidence.md) — C:76
- [Originalbelege und Grenzen](./yjs-python-sdk-preview-evidence.md) — C:138
- [Originalbelege und Grenzen](./yjs-raw-copy-planning-evidence.md) — C:74, L:145
- [Originalbelege und genaue Daten-/Ausführungsgrenze](./yjs-raw-copy-stage-evidence.md) — L:147
- [Originalbelege und genaue Grenzen](./yjs-native-path-owner-live-acceptance-evidence.md) — C:88
- [Originalbelege und genaue Grenzen](./yjs-pi-copy-bridge-evidence.md) — L:135
- [Originalbelege, Diagnose und genaue Grenzen](./yjs-native-copy-fourth-browser-evidence.md) — C:219
- [Originalbelege, Fehlergrenzen und verbleibende Anschlüsse](./yjs-raw-path-import-preparation-evidence.md) — C:78
- [Originalbelege, Quellen und verbleibende Grenzen](./yjs-mixed-markdown-delete-evidence.md) — L:137
- [Originalbelege, Quellenbindung und Grenzen](./yjs-mixed-markdown-copy-evidence.md) — L:133
- [Originalbelege, gesonderter Ressourcenabschluss und verbindlicher vollständiger Admission-/Drain-/Rejoin-Anschluss](./yjs-mcp-active-editor-lifecycle-evidence.md) — C:100
- [Originalbelegen](./yjs-mvp-tool-and-restore-acceptance.md) — L:29
- [Originale und Grenzen](./yjs-copy-history-foreign-key-evidence.md) — C:70
- [Originale und Grenzen](./yjs-linux-agent-sandbox-evidence.md) — L:179
- [Originale und Grenzen](./yjs-mvp-tool-and-restore-acceptance.md#vollständiger-backendnachweis-für-paralleles-editieren-und-move) — L:80
- [Originale und Grenzen](./yjs-mvp-tool-and-restore-acceptance.md) — L:86
- [Originale und genaue Daten-/Ausführungsgrenze](./yjs-raw-copy-stage-evidence.md) — C:72
- [Originale und genaue Grenzen](./yjs-mvp-final-acceptance-evidence.md) — L:95
- [Originale und genaue Grenzen](./yjs-mvp-tool-and-restore-acceptance.md#aktueller-editorerfolg-und-rote-dateiaktionsabnahme) — L:66
- [Originale und genaue Grenzen](./yjs-native-move-delete-source-projection-evidence.md) — C:217
- [Originale und genaue Grenzen](./yjs-raw-path-import-preparation-evidence.md) — L:141
- [Originale, Diagnosegrenze und nächste vollständige Abnahme](./yjs-file-actions-browser16-first-evidence.md) — C:205
- [Originale, Grenzen und Rolloutvoraussetzungen](./yjs-native-activation-evidence.md) — L:181
- [Originale, Korrekturen und Grenzen](./yjs-undo-off-regression-evidence.md) — L:187
- [Originale, Quellpins und genaue Grenzen](./yjs-pi-markdown-create-evidence.md) — L:177
- [Originale, RED/GREEN-Korrekturen und genaue Grenzen](./yjs-explicit-original-markdown-import-evidence.md) — L:139
- [Originale, Versionsgrenze und notwendiger B1-/Stage-/Projektionsanschluss](./yjs-physical-native-import-binding-evidence.md) — L:143
- [Originale, enge Korrektur und Grenzen](./yjs-native-path-unlink-oracle-evidence.md) — C:86
- [Originale, genaue Matrix und Grenzen](./yjs-file-actions-browser16-first-evidence.md#dritter-gemeinsamer-lauf-vollständige-16-fälle-abnahme) — C:171
- [Originale, genaue Änderung und Grenzen](./yjs-mvp-tool-and-restore-acceptance.md#ordner-move-erhält-pristine-identitäten-und-schließt-innerhalb-des-limits-ab) — L:72
- [Originalfehler, Korrektur und Prüfgrenzen](./yjs-asset-delete-native-checkpoint-evidence.md#unveränderte-echte-finalisierungs-gegenprobe-nach-korrektur-33) — C:211
- [Originalquellen, genaue Matrix und Grenzen](./yjs-native-copy-browser-pass-evidence.md) — C:213
- [Owned-Subwrite-/Metadata-Zielplan](./yjs-owned-lifecycle-subwrites-and-metadata-targets-plan.md) — C:1145
- [Owned-Subwrite-Grundlage](../app/lib/files/workspace-owned-lifecycle-subwrite.ts) — C:1149
- [PGlite-Startlauf](../scripts/native-file-operation-storage-migration-test.ts) — C:1197
- [POST-Schutz vor Datei-/Office-Dispatch](./yjs-native-file-write-predispatch-evidence.md) — C:1249
- [PR #176](https://github.com/canvascoding/canvas-notebook/pull/176) — C:52, C:54
- [Pending-Copy-Projektionsschutz](./yjs-native-copy-pending-projector-evidence.md) — C:235
- [Plan für den nativen Sessionbootstrap](./yjs-native-session-bootstrap-plan.md) — C:1163
- [Plan für kooperative Writer-Fences](./yjs-native-side-effect-writer-fences-plan.md) — C:1143
- [Policy/UI-Nachweis](./yjs-public-share-policy-evidence.md) — C:296
- [Projection-Runtime](../scripts/collaboration-projection-runtime-test.ts) — C:1003
- [Präzise Evidenzgrenzen](./yjs-native-auth-foundations-evidence.md) — C:1247
- [Quellen, Originalausgaben und Grenzen](./yjs-mixed-markdown-move-evidence.md) — L:131
- [Quellen, Originale und Abnahmegrenzen](./yjs-unexportable-native-path-public-evidence.md) — L:129
- [Quellen, Originale und Grenzen](./yjs-file-action-current-regression-evidence.md) — C:209
- [Quellen, Originale und Grenzen](./yjs-raw-path-import-atomic-operation-evidence.md) — C:62, L:157
- [Quellen, Originale und genaue Grenze](./yjs-raw-path-import-phase-evidence.md) — C:64, L:155
- [Quellen, Originale und genaue Grenze](./yjs-raw-path-preparation-plan-evidence.md) — C:66, L:153
- [Quellen, Originale und genaue Grenzen](./yjs-raw-path-import-public-mcp-evidence.md) — C:60, L:159
- [Quellen, Originale, Wiederholung und offene Abnahme](./yjs-native-move-delete-source-projection-evidence.md) — C:215
- [Quellen, erhaltene REDs und genaue Abnahmegrenzen](./yjs-raw-path-import-public-web-evidence.md) — C:58, L:161
- [Quellen, fehlgeschlagene und erfolgreiche Läufe sowie nächste Anschlüsse](./yjs-guest-writer-binding-evidence.md) — C:312
- [Quellen, tatsächliche Matrix, ursprüngliche Fehler und Grenzen](./yjs-document-read-tools-evidence.md) — C:177
- [Quellen, ursprünglicher Fehler, echte Prüfungen und Grenzen](./yjs-document-read-service-evidence.md) — C:173
- [Quellenstand, Abdeckungsgrenzen und vorbereitete Matrix](./yjs-mvp-final-acceptance-evidence.md) — L:185
- [Read-Snapshot](../scripts/collaborative-file-read-test.ts) — C:1003
- [Receipt-DDL](../app/lib/db/native-file-operation-handoff-migration.ts) — C:1137
- [Receiptversions-Nachweis](./yjs-native-file-operation-version-evidence.md) — C:1348
- [Recovery-Operator-Vertrag](architecture/canvas-notebook/collaboration-recovery-2026-10.md) — C:1066
- [Reproduktion und genaue Grenzen](./yjs-mvp-tool-and-restore-acceptance.md#move-wartet-begrenzt-auf-kurze-lesezugriffe) — L:70
- [Request-Principal-Grundlage](../app/lib/workspaces/request-principal.ts) — C:1203
- [Scene-Dateibaumanschluss](./yjs-scene-document-tree-evidence.md) — C:193
- [Scene-Read-Korrektur](./yjs-scene-read-admission-evidence.md) — C:163
- [Schema-Bindung der Main-Agent-Migration](./postgres-main-agent-schema-isolation-evidence.md) — C:1348
- [Serializer](../app/lib/files/workspace-upload-service.ts) — C:1253
- [Shared-Writer-Grundlage](../app/lib/files/workspace-side-effect-writer-fence.ts) — C:1147
- [StateProof](../scripts/collaboration-state-proof-test.ts) — C:1003
- [Suchprozessnachweis](./yjs-agent-search-process-evidence.md) — C:1342
- [UI-Dateierstellung](../tests/destination-folder-creation.spec.ts) — C:1009
- [URL-Paste](../tests/editor-url-paste.spec.ts) — C:1009
- [Umsetzung, Gegenproben und genaue Grenzen](./yjs-native-copy-source-projection-evidence.md#beide-unveränderten-postgresql-gegenproben-auf-v2-bestanden) — C:223
- [Umsetzung, frühere Fixturefehler und genaue Grenze](./yjs-public-share-create-evidence.md) — C:298
- [Umsetzung, tatsächliche Belege und Grenzen](./yjs-mcp-file-action-origin-evidence.md) — C:134
- [Umsetzung, tatsächliche Originalläufe und Grenzen](./yjs-native-edit-owner-evidence.md) — C:142
- [Undo](../scripts/workspace-operation-undo-test.ts) — C:1003
- [Ursache, tatsächliche Belege und Einprozessgrenze](./yjs-admission-kernel-ordering-evidence.md) — C:90
- [Ursprünglicher Abbruch, bewusste Budgetänderung und Grenzen](./yjs-authority-artifact-budget-evidence.md) — C:207
- [V1-Planer verwendet jetzt die gehaltene Lifecycle-Verbindung](./yjs-legacy-planner-owner-evidence.md) — C:261
- [V12-Reloadbefund und die begrenzte Startup-Diagnose](./yjs-editor-reload-startup-evidence.md) — C:1221
- [V13-Fragmentbefund und enge Rich-Viewfix](./yjs-rich-heading-navigation-evidence.md) — C:1223
- [V14-Abnahmebeleg](./yjs-create-paste-browser-acceptance-plan.md#v14-undo-verlassen-und-vollständige-enge-webmatrix-bestanden) — C:347
- [V14-Neustart-Locatorbefund](./yjs-restart-native-paragraph-target-evidence.md) — C:1225
- [V15-Storage-Testreaderbefund](./yjs-owned-storage-bigint-adapter-evidence.md) — C:1227
- [V16-Befund des vorbereitenden Linkreads](./yjs-link-fixture-temporary-read-evidence.md) — C:1229
- [V17-Befund beim ersten Fokus-Dokumentöffnen](./yjs-editor-join-authentication-evidence.md) — C:1231
- [V18-Befund der Neustart-Cleanup-Voraussetzung](./yjs-restart-active-editor-cleanup-evidence.md) — C:1235
- [V19-Befund der Evidence-Child-Frist](./yjs-evidence-child-deadline-evidence.md) — C:1239
- [V21-Browserbefund authentisierter Textsessions](./yjs-native-session-browser-busy-evidence.md) — C:1261
- [V22-Browserbefund nach dem HTTP-Readfix](./yjs-native-session-browser-join-busy-evidence.md) — C:1267
- [V9-Abnahme und Grenzen](./yjs-guest-writer-binding-evidence.md#neunter-gesamtlauf-vollständige-lokale-40-fall-abnahme) — C:274
- [Verhalten, Originalbelege und Grenzen](./yjs-native-path-editor-rejoin-evidence.md) — C:96
- [Vertrag und Originalbelege](./yjs-mcp-move-delete-principal-evidence.md) — C:108
- [Vertrag, Artefakte und Originalbelege](./yjs-python-sdk-copy-evidence.md) — C:110
- [Vertrag, Artefakte, erhaltene Fehlversuche und Grenzen](./yjs-python-sdk-move-delete-evidence.md) — C:102
- [Vertrag, Originalbelege und Grenzen](./yjs-mcp-copy-principal-evidence.md) — C:132
- [Vertrag, Originalbelege und Grenzen](./yjs-mcp-move-delete-owner-integration-evidence.md) — C:106
- [Vertrag, Originalbelege und Grenzen](./yjs-mcp-native-copy-owner-evidence.md) — C:130
- [Vertrag, Originalbelege und Grenzen](./yjs-mcp-native-copy-status-recovery-evidence.md) — C:128
- [Vertrag, Originalbelege und genaue Grenzen](./yjs-mcp-native-copy-public-tool-evidence.md#fortsetzung-frischer-build-und-tatsächlicher-oauth-browseranschluss-88) — C:112
- [Vertrag, Originalbelege, Ressourcenabschluss und Grenzen](./yjs-native-path-projection-fence-evidence.md) — C:92
- [Vertrag, Quellen und Originalbelege](./yjs-native-copy-request-budget-evidence.md) — C:126
- [Vertrag, erhaltene Fehlversuche und Grenzen](./yjs-mcp-move-delete-public-tool-evidence.md) — C:104
- [Vertrag, erhaltene Fehlversuche und genaue Grenzen](./yjs-native-path-preparation-evidence.md) — C:94
- [Vertrag, tatsächliche Belege und Grenzen](./yjs-native-create-result-v1-evidence.md) — C:144
- [Vertrag, tatsächliche Belege und Grenzen](./yjs-native-public-edit-evidence.md) — C:140
- [Vertrag, tatsächliche Prüfungen und offene Grenzen](./yjs-document-search-service-evidence.md) — C:148
- [Vollständige Quellen- und Nachweisgrenzen](./yjs-selected-raw-copy-owner-evidence.md) — L:151
- [Web-/Mobile-Service](../app/lib/collaboration/authenticated-text-session-service.ts) — C:1247
- [Workspace-Navigation](../scripts/workspace-markdown-navigation-client-test.ts) — C:1007
- [additive Erstformatwahl](./yjs-pristine-bootstrap-initial-format-evidence.md) — C:1217
- [additive private DDL](../app/lib/db/native-file-operation-side-effects-migration.ts) — C:1139
- [agent-file-edits.ts](../app/lib/collaboration/agent-file-edits.ts) — C:418
- [agent-operations.ts](../app/lib/collaboration/agent-operations.ts) — C:418
- [agent-shell-sandbox.ts](../app/lib/pi/agent-shell-sandbox.ts) — C:433
- [aktuelle M3-Belege und Grenzen](./yjs-mvp-final-acceptance-evidence.md) — C:54
- [aktuelle Originale und Grenzen](./yjs-mvp-tool-and-restore-acceptance.md#ordner-move-erhält-pristine-identitäten-und-schließt-innerhalb-des-limits-ab) — C:52
- [aktuellen E2E-Matrix](./yjs-mvp-e2e-matrix.md) — L:185
- [atomare Metadatenbereinigung bei regulärem Original-Delete](./yjs-original-delete-metadata-evidence.md) — C:239
- [authentifizierte native Socketanschluss](./yjs-authenticated-native-websocket-evidence.md) — C:1257
- [authentisierte existing-only Readernaht](../app/lib/collaboration/native-session-state-reader.ts) — C:1207
- [autoritativer Planner](../scripts/workspace-authoritative-planner-snapshot-test.ts) — C:1003
- [begrenzte authentisierte Session-Readfix](./yjs-native-session-read-retry-evidence.md) — C:1265
- [begrenzte native Verbindungsaufbau](./yjs-native-peer-admission-evidence.md) — C:1279
- [callbackgebundene native Requestrechte-Fassade](./yjs-native-session-callback-access-evidence.md) — C:1219
- [checkpoint.ts](../app/lib/collaboration/checkpoint.ts) — C:419
- [collaborative-read-snapshot.ts](../app/lib/files/collaborative-read-snapshot.ts) — C:429
- [damalige Browserlauf](./yjs-workspace-starter-birth-evidence.md) — C:270
- [dauerhafte Bindung ursprünglicher Deleteziele](./yjs-original-delete-owned-evidence.md) — C:292
- [dauerhafte Kontextbindung direkter Datei-Jobs](./yjs-direct-job-scope-evidence.md) — C:286
- [dauerhafte Move-Journal und die internen Reserve-/Prove-/DA04-Varianten auf derselben echten Verbindung](./yjs-move-journal-admission-evidence.md) — C:253
- [der enge Legacy-Phasenschnitt](./yjs-asset-delete-native-checkpoint-evidence.md) — C:215
- [descriptorgebundene Veröffentlichungsgrundlage](./yjs-fd-publication-backend-evidence.md) — C:1277
- [direct-connection.ts](../app/lib/collaboration/direct-connection.ts) — C:418
- [document-access.ts](../app/lib/collaboration/document-access.ts) — C:417
- [document-state-service.ts](../app/lib/collaboration/document-state-service.ts) — C:690
- [download](../app/api/files/download/route.ts) — C:432
- [echte Claim- und Laufzeitbindung der Datei-Jobs](./yjs-claimed-file-job-evidence.md) — C:288
- [echte PG-Gegenprobe](./yjs-copy-reader-contention-evidence.md) — C:197
- [echte PG18-Importmatrix](../scripts/markdown-file-import-postgres-test.ts) — C:1201
- [enge Reader-/Room-Admission-Fix](./yjs-native-reader-room-admission-evidence.md) — C:1233
- [enge Reparatur der aktiven PostgreSQL-Lease](./yjs-postgres-active-lease-evidence.md) — C:1255
- [enge native Workspace-Unconfirmed-Fix](./yjs-native-workspace-unconfirmed-evidence.md) — C:1271
- [enge native macOS-Fall](./yjs-owned-agent-transport-evidence.md#zweiter-nativer-sandboxlauf-lokal-bestanden) — C:1344
- [erhaltene Linktrace](./yjs-rich-links-fixture-evidence.md) — C:1211
- [erste Browserfolge](./yjs-native-copy-browser-acceptance-evidence.md) — C:239
- [existing-only Session-Lesegrundlage](../app/lib/collaboration/native-session-state-reader.ts) — C:1187
- [failure.ts](../app/lib/collaboration/failure.ts) — C:419
- [feste ursprüngliche Move-Owner samt Runner, Recovery und historischem Status](./yjs-native-move-owner-evidence.md) — C:251
- [files/read](../app/api/files/read/route.ts) — C:429
- [frische enge Browserlauf](./yjs-native-file-operation-version-evidence.md#frischer-app--und-browserabschluss-auf-dem-kombinierten-stand) — C:1350
- [frische kompilierte Mobile-Protokollnachweis](./yjs-native-compiled-protocol-evidence.md) — C:1283
- [gebundene Direct-Activity-Session](../app/lib/collaboration/direct-activity-session.ts) — C:1181
- [gemeinsame Originaldatei-Lesegrundlage](../app/lib/files/workspace-original-file-source.ts) — C:1195
- [gemeinsame Upload-Lifetime I-03a](./markdown-upload-live-source-evidence.md) — C:1263
- [gemeinsame Web-/Mobile-Starterinitialisierung samt tatsächlichem Folgelauf](./yjs-workspace-starter-initialization-evidence.md) — C:265
- [gemeinsame native Create-/Birth-/Projektionsengine](./yjs-native-mcp-create-import-evidence.md) — C:150
- [gemeinsame native Prozessbesitzer](./yjs-native-runtime-broker-evidence.md) — C:1275
- [genauen Testadapter- und Evidenzgrenzen](./yjs-create-paste-browser-acceptance-plan.md) — C:1386
- [gezielte Neustart-Cleanup-Korrektur](./yjs-restart-cleanup-release-fixture-evidence.md) — C:1237
- [historisch erhalten](./yjs-raw-path-import-preparation-evidence.md#zusätzliche-rote-bestandsprüfungen) — L:187
- [inaktive dauerhafte Uploadversuchsgrundlage I-02](./markdown-upload-attempt-evidence.md) — C:1259
- [inaktive erste Markdown-Veröffentlichung I-04](./markdown-first-projection-evidence.md) — C:1281
- [interne ID-Leser mit neun Vertragsfällen und 26 PG18-Familien](./yjs-native-document-id-read-evidence.md) — C:173
- [interne authentisierte Staging-Writer I-03b](./markdown-authenticated-staging-writer-evidence.md) — C:1263
- [isolierte PG18-Restore-Matrix](../scripts/native-file-operation-restore-postgres-test.ts) — C:1189
- [kollaborative Positions-/Modus-E2E](../tests/editor-mode-position.spec.ts) — C:1007
- [kompatible Multipart-Markdownimport](./compat-markdown-native-upload-evidence.md) — C:239
- [konkrete MVP-Launchplan](./yjs-document-authority-mvp-launch-plan.md) — C:82
- [kontrollierte Native-Peer-Sperrgegenprobe](./yjs-native-peer-busy-counter-evidence.md) — C:1269
- [lifecycle-repository.ts](../app/lib/files/collaboration-repository/lifecycle-repository.ts) — C:427
- [lokal bestandene V20-Kernlauf](./yjs-editor-browser-acceptance-evidence.md) — C:1024
- [lokale Positions-/Modus-E2E](../tests/editor-mode-position-local.spec.ts) — C:1007
- [lokale Raumbestand](./yjs-document-search-census-evidence.md) — C:179
- [lokale V20-Editor-Abnahme](./yjs-editor-browser-acceptance-evidence.md) — C:1243
- [markdown-insertion.ts](../app/lib/editor/markdown-insertion.ts) — C:692
- [markdown-mode-availability.ts](../app/lib/editor/markdown-mode-availability.ts) — C:757
- [markdown-state.ts](../app/lib/collaboration/markdown-state.ts) — C:420
- [mobile Viewports](../tests/editor-mobile-viewport.spec.ts) — C:1007
- [native DOCX-API-Readeranschluss](./yjs-native-docx-reader-evidence.md) — C:1161
- [native Markdown-Insertion](../scripts/markdown-insertion-test.ts) — C:1009
- [native Nebenwirkungsmodul](../app/lib/markdown/native-file-operation-side-effects.ts) — C:1139
- [native Publicreader](./yjs-public-native-reader-evidence.md) — C:280
- [native Restore-Grundlage](../app/lib/markdown/native-file-operation-restore.ts) — C:1189
- [notebook.ts](../app/lib/mobile/notebook.ts) — C:430, C:690
- [persistence.ts](../app/lib/collaboration/persistence.ts) — C:419
- [pristine-only Originalbootstrap](../app/lib/collaboration/markdown-file-import-persistence.ts) — C:1209
- [private Restore-DDL](../app/lib/db/native-file-operation-restore-migration.ts) — C:1189
- [private Rohdatenkonsistenzprüfung](./yjs-native-session-raw-consistency-evidence.md) — C:1213
- [private native Copy-Plan und unveränderliche historische Kopierbeleg](./yjs-native-copy-foundation-evidence.md) — C:249
- [private native Pfadplan V3](./yjs-native-move-plan-evidence.md) — C:257
- [projection-runtime.ts](../app/lib/collaboration/projection-runtime.ts) — C:419
- [quellengebundene E2E-Matrix](./yjs-mvp-e2e-matrix.md) — L:58
- [reale Markdown-Insertion-E2E](../tests/editor-markdown-insertion.spec.ts) — C:1009
- [responsive Layoutfix](./notebook-responsive-surface-lifecycle-evidence.md) — C:1185
- [separate native Ereignisnachweis und enge Editorfix](./yjs-rich-links-macos-evidence.md) — C:1215
- [sieben Borrowed-Journaloperationen und genuine Web-/PI-Principal-Komposition](./yjs-native-copy-journal-principal-evidence.md) — C:243
- [statische Specabgleich](./yjs-mvp-e2e-matrix.md) — C:48
- [tatsächlichen PostgreSQL-18-Startlauf](../scripts/native-file-operation-storage-migration-postgres-test.ts) — C:1197
- [unabhängig geprüften nativen Auth-Grundlagen](./yjs-native-auth-foundations-evidence.md) — C:1245
- [unabhängige vollständige I/O-Gegenprobe](./yjs-evidence-child-deadline-evidence.md) — C:1241
- [ursprüngliche Wiederherstellung und Jobphasenkoordination](./yjs-original-restore-owned-evidence.md) — C:294
- [ursprünglichen Actor-/Sitzungs-/Workspacekontext](./yjs-native-copy-origin-evidence.md) — C:247
- [ursprünglicher Widerrufsnachweis](./yjs-public-share-revocation-evidence.md) — C:296
- [vollständige Import](../app/lib/collaboration/markdown-file-import-persistence.ts) — C:1201
- [vorbereitete Datei-/Ordnerbewegung mit Originalbelegen und Recovery](./yjs-prepared-path-move-evidence.md) — C:255
- [vorbereitete Dokumentationskandidat 0.1.0](./yjs-documents-skill-preparation.md) — C:318
- [workspace-authoritative-planner-snapshot.ts](../app/lib/markdown/workspace-authoritative-planner-snapshot.ts) — C:421
- [workspace-download-archive.ts](../app/lib/files/workspace-download-archive.ts) — C:1155
- [workspace-file-operation-link-assessment.ts](../app/lib/markdown/workspace-file-operation-link-assessment.ts) — C:422
- [workspace-files.ts](../app/lib/filesystem/workspace-files.ts) — C:426
- [workspace-link-write-executor.ts](../app/lib/markdown/workspace-link-write-executor.ts) — C:424
- [workspace-link-yjs-edits.ts](../app/lib/markdown/workspace-link-yjs-edits.ts) — C:423
- [workspace-operation-backup.ts](../app/lib/files/workspace-operation-backup.ts) — C:426
- [workspace-operation-batch-executor.ts](../app/lib/files/workspace-operation-batch-executor.ts) — C:425, C:428
- [workspace-tools.ts](../app/lib/mcp/server/workspace-tools.ts) — C:431
- [zentrale Abschaltung](./workspace-file-undo-disabled.md) — C:263
- [zentrale native Copy-Ansichtsfinalisierung](./yjs-native-copy-view-finalization-evidence.md) — C:239
- [zentraler Datei-/API-/SDK-/PDF-/Sandbox-Anschlussplan](./central-notebook-file-api-import-plan.md) — C:314
- [zweite Folge](./yjs-native-copy-second-browser-evidence.md) — C:239
- [§1.1 des Create-/Paste-/Import-Anschlussplans](./markdown-create-paste-full-import-integration-plan.md#11-bedienwege-für-die-gemeinsame-prüfung) — C:678
- [§4.1–4.3 des Anschlussplans](./central-notebook-file-api-import-plan.md#41-standard-skill-und-kontext-erst-bei-bedarf) — C:466
- [§5 des Anschlussplans](./central-notebook-file-api-import-plan.md#5-bestehendes-pdf-tool-bis-zum-echten-notizbuchdokument) — C:706
- [Änderungen, Originalbelege und Grenzen](./yjs-native-path-drain-foundation-evidence.md) — C:98
- [öffentliche SDK-/API-Dokumentation unter canvasnotebook.app/docs](./central-notebook-file-api-import-plan.md#40-sdk-paket-und-öffentliche-entwicklerdokumentation) — C:159

</details>

## Historische Pfade und Artefakte

<details>
<summary>Erhaltene Pfade und Artefakte öffnen</summary>

- `.../canvas-mvp-final-owned-acceptance-retry-inputs-20261020/extra23/` — A:143
- `.../canvas-mvp-post-admission-wait-owned-acceptance-inputs-20261020/manual17/` — A:166
- `.html` — A:209
- `.log` — C:1171
- `.md` — C:1026, C:1028, C:1059, C:314, C:358, C:392, C:408, C:447, C:524, C:684, C:690, C:923, C:964
- `.md/.markdown` — C:1201
- `.mdx` — C:1086, C:1108, C:1133, C:462
- `/Users/frankalexanderweber/.codex/worktrees/824c/canvasstudios-notebook` — C:890
- `/api/files/read` — C:1173
- `/app/api/files/create/route.ts` — C:690
- `/app/api/files/download/route.ts` — C:432
- `/app/api/files/info/route.ts` — C:1159
- `/app/api/files/read/route.ts` — C:429
- `/app/components/DashboardShell.tsx` — C:774
- `/app/components/editor/FileEditor.tsx` — C:776
- `/app/components/editor/MarkdownDocumentModes.tsx` — C:753
- `/app/components/editor/MarkdownEditor.tsx` — C:754
- `/app/components/editor/MarkdownField.tsx` — C:755
- `/app/components/editor/MarkdownInsertDialog.tsx` — C:692
- `/app/components/file-browser/CreateItemDialog.tsx` — C:690
- `/app/components/file-guests/GuestMarkdownEditor.tsx` — C:756
- `/app/components/home/HomeNewNoteDialog.tsx` — C:690
- `/app/components/notebook/NotebookFocusContext.tsx` — C:774
- `/app/lib/collaboration/agent-file-edits.ts` — C:418
- `/app/lib/collaboration/agent-operations.ts` — C:418
- `/app/lib/collaboration/archived-native-snapshot.ts` — C:1189
- `/app/lib/collaboration/authenticated-text-session-service.ts` — C:1247
- `/app/lib/collaboration/checkpoint.ts` — C:419
- `/app/lib/collaboration/direct-activity-session.ts` — C:1181
- `/app/lib/collaboration/direct-connection.ts` — C:418
- `/app/lib/collaboration/document-access.ts` — C:417
- `/app/lib/collaboration/document-state-service.ts` — C:690
- `/app/lib/collaboration/failure.ts` — C:419
- `/app/lib/collaboration/handoff-execution-context.ts` — C:1151
- `/app/lib/collaboration/markdown-file-import-persistence.ts` — C:1201, C:1209
- `/app/lib/collaboration/markdown-state.ts` — C:420
- `/app/lib/collaboration/native-session-state-reader.ts` — C:1187, C:1207
- `/app/lib/collaboration/persistence.ts` — C:419
- `/app/lib/collaboration/projection-runtime.ts` — C:419
- `/app/lib/db/native-file-operation-handoff-migration.ts` — C:1137
- `/app/lib/db/native-file-operation-restore-migration.ts` — C:1189
- `/app/lib/db/native-file-operation-side-effects-migration.ts` — C:1139
- `/app/lib/editor/markdown-insertion.ts` — C:692
- `/app/lib/editor/markdown-mode-availability.ts` — C:757
- `/app/lib/files/collaboration-repository/lifecycle-repository.ts` — C:427
- `/app/lib/files/collaborative-read-snapshot.ts` — C:429
- `/app/lib/files/workspace-download-archive.ts` — C:1155
- `/app/lib/files/workspace-operation-backup.ts` — C:426
- `/app/lib/files/workspace-operation-batch-executor.ts` — C:425, C:428
- `/app/lib/files/workspace-original-file-source.ts` — C:1195
- `/app/lib/files/workspace-owned-lifecycle-subwrite.ts` — C:1149
- `/app/lib/files/workspace-side-effect-writer-fence.ts` — C:1147
- `/app/lib/files/workspace-upload-service.ts` — C:1253
- `/app/lib/filesystem/workspace-files.ts` — C:426
- `/app/lib/markdown/native-file-operation-handoff.ts` — C:1137
- `/app/lib/markdown/native-file-operation-restore.ts` — C:1189
- `/app/lib/markdown/native-file-operation-side-effects.ts` — C:1139
- `/app/lib/markdown/workspace-authoritative-planner-snapshot.ts` — C:421
- `/app/lib/markdown/workspace-file-operation-link-assessment.ts` — C:422
- `/app/lib/markdown/workspace-link-write-executor.ts` — C:424
- `/app/lib/markdown/workspace-link-yjs-edits.ts` — C:423
- `/app/lib/mcp/server/workspace-tools.ts` — C:431
- `/app/lib/mobile/notebook.ts` — C:430, C:690
- `/app/lib/pi/agent-shell-sandbox.ts` — C:433
- `/app/lib/workspaces/request-principal.ts` — C:1203
- `/docs` — L:193
- `/private/tmp/canvas-markdown-migration-source-resume-20261020/verification-manifest.json` — A:123
- `/private/tmp/canvas-mvp-blocked-preview-diagnostics-20261020` — A:125
- `/private/tmp/canvas-mvp-concurrent-move-20261020-Y8J3GcFs` — A:29, A:454, A:478, A:49, A:57, A:65
- `/private/tmp/canvas-mvp-concurrent-move-20261020-Y8J3GcFs/` — A:287, A:389
- `/private/tmp/canvas-mvp-concurrent-move-20261020-Y8J3GcFs/legacy-owner-quiescence-groups.log` — A:317
- `/private/tmp/canvas-mvp-create-admission-fix-20261020/{red-runtime.log,green-runtime.log,red-runtime-closure-independent.json,green-runtime-closure-independent.json}` — A:160
- `/private/tmp/canvas-mvp-final-owned-acceptance-inputs-20261020/extra23/` — A:135
- `/private/tmp/canvas-mvp-final-owned-acceptance-inputs-20261020/mcp10/artifact-report.json` — A:131
- `/private/tmp/canvas-mvp-final-owned-acceptance-retry-inputs-20261020/mcp10/artifact-report.json` — A:139
- `/private/tmp/canvas-mvp-html-aware-source-v5-e175zcgt/` — A:219
- `/private/tmp/canvas-mvp-html-public-move-v5-jur43h_c/` — A:237
- `/private/tmp/canvas-mvp-html-source-foundation-20261020/{foundation-final.log,legacy-v1-final.log,legacy-v2-final.log,collector-final.log,types-final-2.log,lint-final-2.log,final-source-pins.json}` — A:189
- `/private/tmp/canvas-mvp-move-admission-wait-20261020-Oyn9C7M1/` — A:253
- `/private/tmp/canvas-mvp-move-profile-20261020-oDyRSjt7/` — A:271
- `/private/tmp/canvas-mvp-ordinary-link-v4-rxgt75bd/{v4-final.log,html-foundation-regression.log,native-links-regression.log,bom-v3-regression.log,legacy-v1-regression.log,legacy-v2-regression.log,collector-regression.log,types-final.log,lint-final.log,final-source-pins.json,historical-function-audit.json}` — A:203
- `/private/tmp/canvas-mvp-post-admission-wait-owned-acceptance-inputs-20261020/mcp10/artifact-report.json` — A:164
- `/private/tmp/canvas-mvp-pristine-folder-move-20261020-wTRL5gTt/red-owner-first.log` — A:259
- `/private/tmp/canvas-owned-additional23-html-failure-cleanup-20261020/independent-postcheck.json` — A:175
- `/private/tmp/canvas-owned-extra23-retry-code-block-failure-cleanup-20261020/independent-postcheck.json` — A:143
- `/private/tmp/canvas-owned-extra23-rich-blocks-failure-cleanup-20261020/independent-postcheck.json` — A:135
- `/private/tmp/canvas-sdk-delete3-wheel-Ox9tv0` — A:35
- `/private/tmp/canvas-sdk-path-oauth-e2e10-candidate-20261019` — L:195
- `/private/tmp/canvas-sdk-path-oauth10-validation-kksi17od` — L:195
- `/private/tmp/canvas-yjs-authority-5t6uxR/` — A:143
- `/private/tmp/canvas-yjs-authority-GUaeO2/` — A:135
- `/private/tmp/canvas-yjs-authority-Mnlx4T` — A:154
- `/private/tmp/canvas-yjs-authority-QaXwxX/results/owner-regression-outcome.json` — A:93
- `/private/tmp/canvas-yjs-authority-QaXwxX/results/portability-outcome.json` — A:103
- `/private/tmp/canvas-yjs-authority-UgHvFH` — A:166
- `/private/tmp/canvas-yjs-authority-WQIJL8/test-all.log` — A:111
- `/private/tmp/canvas-yjs-authority-emMvHK/results/test-all-outcome.json` — A:117
- `/private/tmp/canvas-yjs-authority-nQ7c4t` — A:168
- `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-boundary-2nnwed4w` — L:121
- `/proc/self/fd` — C:1277
- `200 / applied` — L:80
- `200/applied` — A:335
- `202 / applying` — A:349, A:365, A:373, L:80
- `409 / BATCH_CLAIM_DISPOSAL_UNCONFIRMED` — A:13, C:11, L:21
- `409 / BATCH_EXECUTION_FAILED` — A:13, A:295, A:303, C:11, L:21, L:74
- `409 / COLLABORATION_FILE_LIFECYCLE_BUSY` — A:279, L:74
- `409 / FILE_OPERATION_UNDO_DISABLED` — A:127
- `409 / JOB_LIFECYCLE_CHANGED` — A:243
- `409 / NATIVE_SOURCE_EVIDENCE_INVALID` — A:170, L:64
- `409/PRINCIPAL_BUSY` — C:1261
- `503 / IMPLICIT_MOVE_OUTCOME_UNCONFIRMED` — A:289, L:78
- `@earendil-works/pi-ai/compat` — A:217, A:293, A:333, A:47, A:67
- `A_B.md` — C:1211
- `A|B.md` — C:1211
- `COLLABORATION_ROUNDTRIP_UNSTABLE / snapshot_validate` — L:129
- `DIRTY/CONFLICTING` — L:13
- `DashboardShell.tsx` — L:15, L:76
- `Erste Schritte.md` — C:270
- `INVALID_MESSAGE / A stable, consistent clientMessageId is required` — A:109
- `PATCH /api/agents/tools` — A:73
- `POST /api/documents/search` — C:148
- `PROVIDER_VERIFIED / ready` — A:107
- `SKILL.md` — C:316
- `WorkspaceSwitcher.tsx` — L:15, L:76
- `after-path-facts-independent-postcheck.json` — A:271
- `applying/preparing` — A:381
- `attempts-client-v2-regression.log` — A:331
- `bom-v3-final.log` — A:219
- `claim_owner/ROOM_OWNER_BUSY` — C:1231
- `client-public-v2-unit-final.log` — A:331
- `codex/` — C:892
- `codex/yjs-document-authority-plan` — C:890, L:103
- `collaboration-document-lifecycle-test.tsx` — C:338
- `collaboration-room-mutation-server-test.ts` — C:336
- `collector-regression.log` — A:219
- `components-delete-historical-memo31.log` — A:694
- `copy25-assets-pure5.log` — A:724
- `copy25-b-pg10-classified.log` — A:25
- `copy25-b-pg10-diagnostic.log` — A:25
- `copy25-b-pg10-owner-diagnostic.log` — A:25
- `copy25-b-pg10-public-cause.log` — A:25
- `copy25-b-pg10-range-frames.log` — A:25
- `copy25-b-pg10-yjs-frames.log` — A:25
- `copy25-b-pg10.log` — A:25
- `core-after-path-facts.log` — A:271
- `core-gap-order-third.log` — A:237
- `delete-a-current-type-lint-results.json` — A:521
- `delete-a-html-move-v5-regression-clock-fixed.log` — A:523
- `delete-a-pure-program-results.json` — A:521
- `delete-a-writer-two-read-metadata8-checkoutfix.log` — A:589
- `delete-a-writer-two-read-metadata8.log` — A:580
- `delete-local-factors-pure-baseline.json` — A:502
- `delete4-after-physical-read-boundary-frame.json` — A:552
- `delete4-prephysical-timing-source-preservation.json` — A:569
- `direct-mcp-workspace-path-owner-postgres-test.ts` — A:319
- `document-snapshot.ts` — C:1117
- `ek-fuchs-transkript.md` — C:1063, C:237, C:353, C:357
- `extensions/context-prompt.ts` — C:185
- `extensions/core-source.ts` — C:185
- `failed / COLLABORATION_FILE_LIFECYCLE_BUSY / preparing / 0` — C:1235
- `failed/preparing` — A:409
- `file-operation-client-v2-regression.log` — A:331
- `file-version-default-off-native-history.log` — A:65
- `final-independent-postcheck.json` — A:253
- `green-owner-final.log` — A:253
- `green-owner-first.log` — A:253
- `historical-eligibility31-adoption.json` — A:719
- `historical-function-audit.json` — A:219
- `html-foundation-final.log` — A:219
- `html-legacy-esm-final.log` — A:219
- `html-legacy-regression.log` — A:219
- `independent-postcheck-client-public-v2-admission-timings-owner.json` — A:375
- `independent-postcheck-client-public-v2-auth-witness-owner.json` — A:349
- `independent-postcheck-client-public-v2-callback-owner.json` — A:343
- `independent-postcheck-client-public-v2-completion-b2-timings-owner.json` — A:401
- `independent-postcheck-client-public-v2-completion-single-current-owner.json` — A:411
- `independent-postcheck-client-public-v2-http-client-deadline-owner.json` — A:389
- `independent-postcheck-client-public-v2-http-poll-owner.json` — A:383
- `independent-postcheck-client-public-v2-intent-bundle-facts-owner.json` — A:439
- `independent-postcheck-client-public-v2-owner.json` — A:337
- `independent-postcheck-client-public-v2-p0-read-captured-owner.json` — A:421
- `independent-postcheck-client-public-v2-p0-reuse-owner.json` — A:369
- `independent-postcheck-client-public-v2-projection-read-boundary-owner.json` — A:429
- `independent-postcheck-client-public-v2-worker-diagnostic-owner.json` — A:359
- `independent-postcheck-delete-a-writer-two-read-metadata8-checkoutfix-green.json` — A:591
- `independent-postcheck-delete-a-writer-two-read-metadata8-interrupted.json` — A:582
- `independent-postcheck-delete-e6-afterphysical-focused-red.json` — A:618
- `independent-postcheck-delete-e6-afterphysical-owned-runtime-green.json` — A:625
- `independent-postcheck-delete-e6-archive-full30-red.json` — A:641
- `independent-postcheck-delete-e6-cas-negative-focused-green.json` — A:632
- `independent-postcheck-owned-context-capture-owner.json` — A:478
- `independent-postcheck-owner-delete-a-analysis-local29-red.json` — A:554
- `independent-postcheck-owner-delete-a-html-twofaults29-red.json` — A:527
- `independent-postcheck-owner-delete-a-local-factors29-red.json` — A:536
- `independent-postcheck-owner-delete-a-recipe-local-factors29-red.json` — A:543
- `independent-postcheck-owner-delete-a-reserved-boundary29-red.json` — A:565
- `independent-postcheck-owner-delete-a-writer-two-read29-red.json` — A:602
- `independent-postcheck-owner-delete-e6-exact-writer-full31.json` — A:683
- `independent-postcheck-owner-delete-e6-exact-writer-revocation-focused.json` — A:676
- `independent-postcheck-owner-delete-e6-fixed-domain-full31.json` — A:669
- `independent-postcheck-owner-delete-e6-fixed-domain-revocation-focused.json` — A:657
- `independent-postcheck-owner-delete-historical-memo-full31.json` — A:702
- `independent-postcheck-owner-e5-historical-memo-full31.json` — A:717
- `independent-postcheck-owner-e6-schema-frame-full31.json` — A:33
- `independent-postcheck-p0-pure-ab-owner.json` — A:295
- `independent-postcheck-p0-pure-abd-constructor-step-owner.json` — A:307
- `independent-postcheck-p0-pure-abd-owner.json` — A:301
- `independent-postcheck-pending-ui-census-owner.json` — A:493
- `independent-postcheck-pending-ui-delete-local-factors-owner.json` — A:506
- `independent-postcheck-quiescence-groups-faults-owner.json` — A:323
- `independent-postcheck-quiescence-groups-first-owner.json` — A:311
- `independent-postcheck-wired-first-owner.json` — A:289
- `independent-resource-report.json` — L:127
- `legacy-core-gap-final.log` — A:237
- `legacy-v1-regression.log` — A:219
- `legacy-v2-regression.log` — A:219
- `lint-final-2.log` — A:219
- `markdown-insertion.ts` — C:1316
- `metadata8-owned-interrupted-cleanup.json` — A:582
- `native-operation-history-postgres-test.ts` — A:65
- `native-receipt-proof-focused-postgres.log` — A:461
- `needs_recovery/recovery` — A:387, A:427, A:437
- `notification-bell-read-state-test.tsx` — A:489
- `opaque-fixture-cleanup31-adoption.json` — A:57
- `operation/authority` — A:387
- `origin/main` — A:19, L:103, L:13
- `owner-after-path-facts.log` — A:271
- `owner-before-fresh-binding.log` — A:287
- `owner-before-optimization.log` — A:271
- `owner-client-public-v2-admission-timings.log` — A:373
- `owner-client-public-v2-auth-witness.log` — A:347
- `owner-client-public-v2-callback.log` — A:343
- `owner-client-public-v2-completion-b2-timings.log` — A:401
- `owner-client-public-v2-completion-single-current.log` — A:411
- `owner-client-public-v2-http-client-deadline.log` — A:389
- `owner-client-public-v2-http-poll.log` — A:383
- `owner-client-public-v2-intent-bundle-facts.log` — A:439
- `owner-client-public-v2-observed.log` — A:339
- `owner-client-public-v2-p0-read-captured.log` — A:421
- `owner-client-public-v2-p0-reuse.log` — A:365
- `owner-client-public-v2-projection-read-boundary.log` — A:429
- `owner-client-public-v2-worker-diagnostic.log` — A:357
- `owner-client-public-v2.log` — A:335
- `owner-default-off-full31.log` — A:53
- `owner-delete-a-html-e6.log` — A:525
- `owner-delete-a-html-twofaults29-analysis-local.log` — A:545, A:550
- `owner-delete-a-html-twofaults29-local-factors.log` — A:533, A:536
- `owner-delete-a-html-twofaults29-recipe-local-factors.log` — A:540, A:543
- `owner-delete-a-html-twofaults29-reserved-boundary.log` — A:556, A:563
- `owner-delete-a-html-twofaults29-writer-two-read.log` — A:593, A:598
- `owner-delete-a-html-twofaults29.log` — A:527
- `owner-delete-e6-archive-afterphysical-focused.log` — A:616
- `owner-delete-e6-archive-afterphysical-owned-runtime.log` — A:623
- `owner-delete-e6-archive-cas-negative-focused.log` — A:630
- `owner-delete-e6-archive-full30.log` — A:632, A:637
- `owner-delete-e6-exact-writer-full31.log` — A:676, A:681
- `owner-delete-e6-exact-writer-revocation-focused.log` — A:673, A:676
- `owner-delete-e6-fixed-domain-cas-focused.log` — A:657, A:660
- `owner-delete-e6-fixed-domain-full31.log` — A:662, A:667
- `owner-delete-e6-fixed-domain-revocation-focused.log` — A:655
- `owner-delete-historical-memo-full31.log` — A:696, A:700
- `owner-e5-historical-memo-full31.log` — A:712, A:717
- `owner-e6-schema-frame-full31.log` — A:17, C:15, L:25
- `owner-fifth.log` — A:237
- `owner-gate-after-draining.log` — A:287
- `owner-green-independent-postcheck.json` — A:237
- `owner-historical-eligibility-full31.log` — A:719
- `owner-opaque-fixture-cleanup-archive1.log` — A:59
- `owner-opaque-fixture-cleanup-blocked1.log` — A:59
- `owner-owned-context-capture.log` — A:470
- `owner-p0-pure-ab.log` — A:293, A:295
- `owner-p0-pure-abd-constructor-step.log` — A:303
- `owner-p0-pure-abd.log` — A:299, A:301
- `owner-pending-ui-census.log` — A:491
- `owner-pending-ui-delete-local-factors.log` — A:504
- `owner-phase-intent-and-receipt-capture.log` — A:450
- `owner-phase-intent-facts-baseline.log` — A:448
- `owner-physical36-admission-atomic-human-full36.log` — A:13, C:11, L:21
- `owner-physical36-da04-vacant-profile-full36.log` — A:4, C:4, L:4
- `owner-physical36-owner-delete-phase-schema-full36.log` — A:13, C:11, L:21
- `owner-physical36-web-initialized-full36.log` — A:13, C:11, L:21
- `owner-preview-guard-diagnostic.log` — A:287
- `owner-quiescence-groups-faults.log` — A:319
- `owner-quiescence-groups-first.log` — A:311
- `owner-terminal-auth-read-boundary.log` — A:459
- `owner-wired-diagnostic.log` — A:291
- `owner-wired-first.log` — A:289
- `owner-wired-profile.log` — A:291
- `p0-insert-parity-baseline-final.log` — A:361
- `p0-insert-parity-optimized-final.log` — A:361
- `packages/core-runtime-bindings.ts` — C:185
- `pending-ui-path-client.log` — A:489
- `pending-ui-pure-validation.json` — A:489
- `pi-ai/compat` — A:160, A:495
- `pins-client-public-v2-http-client-deadline-owner.json` — A:389
- `pins-delete-historical-memo31-current.json` — A:696
- `pins-e5-historical-memo31-current.json` — A:712
- `pins-historical-eligibility31-current.json` — A:719
- `postcheck-components-delete-historical-memo31.json` — A:694
- `postcheck-components-e5-historical-memo31.json` — A:708
- `postcheck-delete-a-analysis-local-pure.json` — A:545
- `postcheck-delete-a-b2-domain-archive-timing-preflight.json` — A:609
- `postcheck-delete-a-local-factors-pure.json` — A:533
- `postcheck-delete-a-recipe-local-factors-pure.json` — A:540
- `postcheck-delete-a-reserved-boundary-scoped.json` — A:556
- `postcheck-delete-a-writer-two-read-typefix-preflight.json` — A:578
- `postcheck-delete-e6-exact-writer31-preflight.json` — A:673
- `postcheck-delete-historical-memo31-preflight.json` — A:692
- `postcheck-delete-local-factors-pure-optimized.json` — A:502
- `postcheck-direct-e5-tests-baseline.json` — A:708
- `postcheck-pending-browser-scoped.json` — A:517
- `postcheck-source-suite-e5-historical-memo31.json` — A:710
- `postgres-completion-b2-timings-owned-backend.json` — A:401
- `postgres-http-client-deadline-owned-backend.json` — A:391
- `postgres-runtime.ts` — C:1388
- `pure-intent-bundle-facts-baseline.log` — A:435
- `pure-intent-bundle-facts-optimized.log` — A:435
- `pure-p0-read-captured-baseline-parity.log` — A:417
- `pure-p0-read-captured-optimized-parity.log` — A:417
- `queued/applying/applied` — A:349
- `receipt-local-capture-commit-scope.json` — A:463
- `red-owner.log` — A:253
- `references/python-runtime.md` — C:187
- `results/default-browser-test-results/` — A:117
- `results/restore-comparison.json` — A:103
- `results/shared-workspace-html-move/` — A:168
- `scripts/agent-extension-context-preflight-test.ts` — C:187
- `scripts/agent-shell-sandbox-test.ts` — L:171
- `scripts/collaboration-block-history-ime-allocation-test.ts` — C:1298
- `scripts/collaboration-block-history-lineage-test.ts` — C:1294
- `scripts/collaboration-block-history-mixed-inline-test.ts` — C:1305
- `scripts/collaborative-file-read-test.ts` — C:1109
- `scripts/core-skills-test.ts` — C:187
- `scripts/extension-context-prompt-test.ts` — C:187
- `scripts/lib/owned-yjs-authority-qa.ts::sourceFingerprint` — C:187
- `scripts/native-file-operation-handoff-postgres-test.ts` — A:461
- `scripts/skill-script-process-test.ts` — L:171
- `scripts/workspace-operation-raw-markdown-boundary-postgres-test.ts` — L:121
- `seed_skills/canvas-notebook-documents/` — C:185
- `source-suite-e5-historical-memo31.log` — A:710
- `src/features/notebook/notebook-document-screen.tsx` — C:759
- `terminal.json` — L:127
- `test-all.log` — A:117
- `test_core_bearbeitungsfeatures.md` — C:353
- `tests/editor-create-paste-import.spec.ts` — C:1165
- `tests/editor-create-paste-import.spec.ts:266` — C:1199
- `tests/editor-create-paste-import.spec.ts:308` — C:1324
- `tests/editor-focus-width.spec.ts:128` — C:1191
- `text/html` — C:697
- `text/plain` — C:697
- `types-final-2.log` — A:219
- `v4-first.log` — A:203
- `v5-final-3.log` — A:219
- `workspace-file-metadata-contract.ts` — A:724
- `workspace-html-link-safety.ts` — A:55
- `workspace-operation-html-link-assessment.ts` — A:55
- `workspace-operation-native-delete-html-plan.ts` — A:545
- `workspace-path-operation-client-test.ts` — A:489
- `workspace-path-operation-notification-summary-test.ts` — A:489
- `workspace-path-operation-status-store-test.ts` — A:489
- `workspace-path-operation-status-ui-test.tsx` — A:489

</details>

## Historische Commit- und Hash-Tokens

<details>
<summary>Erhaltene Quellen- und Laufbindungen öffnen</summary>

Die ursprüngliche Bedeutung (Commit, Quellenhash, Originallog oder Prooffingerprint) bleibt an den jeweiligen Herkunftseintrag gebunden; gleiche Form bedeutet keinen gleichartigen Beleg.

- `3812554` — A:115
- `4176716` — A:391
- `4189522` — A:399
- `75718fc` — C:187
- `f394ff2` — C:185
- `05e9da30` — L:13
- `10f35450` — A:604
- `14695632` — A:135
- `14703423` — A:135
- `14714311` — A:143
- `14791255` — A:175
- `14894416` — A:287
- `14902339` — A:287
- `14910261` — A:287
- `14918200` — A:289
- `14926139` — A:291
- `14934060` — A:291
- `14941987` — A:295
- `14949964` — A:301
- `14957718` — A:307
- `14965703` — A:311
- `14981511` — A:323
- `14989628` — A:337
- `14997635` — A:339
- `14ad1c00` — C:1390
- `15005642` — A:343
- `15013648` — A:349
- `15021689` — A:359
- `15029726` — A:369
- `15037772` — A:375
- `15045819` — A:383
- `15053905` — A:389
- `15061963` — A:401
- `15070000` — A:411
- `15078159` — A:421
- `15086245` — A:429
- `15094428` — A:439
- `15102637` — A:448
- `15110773` — A:450
- `15119119` — A:459
- `15127811` — A:478
- `15136286` — A:493
- `15144185` — A:506
- `15178899` — A:543
- `15187573` — A:554
- `15196260` — A:565
- `15212491` — A:591
- `15220198` — A:602
- `15228943` — A:618
- `15236440` — A:625
- `15243941` — A:632
- `15251443` — A:641
- `15260173` — A:657
- `15267652` — A:660
- `15275151` — A:669
- `15283849` — A:676
- `15291340` — A:683
- `15308791` — A:717
- `15389512` — A:33
- `15466118` — A:726
- `20261019` — L:195
- `20261020` — A:123, A:125, A:131, A:135, A:139, A:143, A:160, A:164, A:166, A:175, A:189, A:253, A:259, A:271, A:287, A:29, A:317, A:389, A:454, A:478, A:49, A:57, A:65
- `28570af3` — A:706
- `2971d8b3` — A:630
- `2ee22a5f` — A:719, L:35
- `33629abb` — A:500
- `3ad7e904` — A:487
- `3c4b9aa8` — A:593
- `3e8b4836` — A:623
- `40160241` — A:576
- `4cbea68f` — A:500
- `54ce6573` — C:181
- `59576bf7` — A:515
- `6736e33a` — A:576
- `6a34c635` — C:1390
- `6d8131fb` — A:655
- `6e19f080` — A:671
- `7ca4a66f` — C:1388, C:1390
- `ab6bd145` — A:587
- `abcb0e12` — A:604
- `ca061cea` — A:651
- `cc5f1da1` — A:616
- `d9d78718` — C:1253
- `de0515dd` — A:719, L:35
- `de09ace0` — L:33
- `e98c9577` — C:1283
- `02e1ec874` — C:181
- `04110e1cb` — C:1131
- `04e512720` — C:312
- `0546169e4` — C:261
- `05533cad3` — C:247
- `06720908e` — C:148
- `093a9cecc` — C:288
- `0a7a8676e` — C:1131
- `0cc661a83` — A:397
- `0e67d8c0e` — C:219
- `101ee77e5` — C:171
- `11f9c851c` — C:286
- `121fa8211` — A:195
- `12d5979df` — C:255
- `12ebe45b7` — C:284
- `13fb43a53` — C:163
- `15e145c95` — C:261
- `1613ba7c0` — C:106
- `16e2a920d` — C:1344
- `18845697c` — L:91
- `192d8458f` — C:116, C:84, L:99
- `1b078acf9` — C:239
- `1ba15d31b` — C:219
- `1d094e666` — C:282
- `21f25842f` — C:1245
- `22033952c` — C:171
- `246c04e6a` — L:201, L:44, L:62
- `24c9d5992` — A:147
- `27f7b8713` — C:1235
- `29f7679ec` — C:175
- `3061b3f29` — A:125
- `30cf2a28e` — C:1127
- `3102aed2e` — C:312
- `32a2a8dc8` — A:510
- `32c689588` — C:1167
- `3422a68fd` — C:296
- `3582f5772` — C:280
- `3825eca58` — C:286
- `3857ce3d6` — C:1227
- `3a1c92603` — C:209
- `3b5eb75bb` — C:138
- `3b743d3ab` — C:195
- `3db537a07` — C:150
- `3e23ff15f` — C:302
- `3f0ea1dfb` — C:1187, C:1189
- `3f1c1b842` — C:247
- `3f30cd06a` — C:253
- `4033ef013` — C:290
- `42a8db79e` — C:1135
- `43be59fe2` — C:300
- `44c304dc7` — C:308
- `4578b0185` — C:274
- `49dfd9bee` — C:270
- `4c23728eb` — C:1384
- `4d6ad0594` — C:302
- `4e69c68bf` — A:127
- `516f9245c` — C:259
- `51886a75f` — C:308
- `55cf40e6a` — C:312
- `58503f3d0` — C:257
- `58d947398` — C:312
- `597286c9a` — A:67
- `59886de5b` — C:1111
- `5b0f23451` — C:259
- `5bae498af` — C:163
- `5c7b20480` — C:104
- `5e7074360` — C:1135
- `5f3c1297c` — C:1261
- `6007e1adf` — C:1225
- `6179d1c51` — C:215
- `619b77e9d` — C:310
- `61a34604c` — L:29
- `63df89dff` — C:1153
- `63ec6b56b` — C:257
- `647183ef1` — C:1153
- `6537fbbe8` — C:54, L:95
- `67523cbb5` — L:99
- `67c509c08` — C:181
- `6891c1bba` — C:86
- `69d7c1f88` — C:211
- `6c94366ff` — C:300
- `6cb69ce6b` — A:407
- `6ce930a5d` — C:1350
- `6cee66086` — C:1213, C:1215
- `6d8fc7079` — C:1336, C:1356, C:276, C:856
- `6e75aad1e` — C:110
- `716d82215` — A:147
- `71d0a11b0` — C:251
- `728b548d8` — C:1157
- `72e4b8f8f` — C:298
- `7623e3cb8` — C:221
- `76ad27135` — A:123
- `774d62d84` — C:112
- `78709aed3` — C:255
- `7d28b7055` — C:195
- `7fbfd5a3c` — C:102
- `803ab80b2` — C:282
- `81ece4edf` — C:209
- `81f33e86a` — C:1229
- `82c6dc1b9` — C:213
- `831c67071` — L:99
- `85d76cefe` — C:288
- `8690c5ff5` — C:1245
- `87a77f7d4` — C:294
- `887f5b54b` — C:1322
- `89347ea95` — L:103
- `89eed5377` — A:127
- `8bbed1fe3` — C:173
- `8bd8d3376` — L:175
- `8cac894e5` — C:312
- `8cf79496b` — C:1207, C:1209
- `8dfefb49d` — L:89
- `90a8be406` — C:1243, C:1367
- `92df8dc52` — C:213
- `94dd203c1` — C:280
- `95cccfc9f` — C:312
- `97ebad800` — L:86
- `98956a6bd` — C:54, L:95
- `98fa56596` — A:277, L:76
- `9c336481e` — C:144
- `9c350ccc7` — C:290
- `9d1212b79` — C:292
- `9d4327e72` — C:215
- `9e6d4c5d4` — C:148
- `9f8b85540` — A:415, A:444
- `a1fc2a0b8` — C:1344
- `a1ffb8769` — C:1267
- `a41c09417` — L:151
- `a465b5bb0` — C:1223
- `a533b2ce6` — A:133, L:91
- `a5449b85b` — A:154, A:156, L:64
- `a5f4160b8` — C:1231
- `a6f1d2d99` — C:140
- `a8930ea2b` — C:306
- `a9462efbf` — C:312
- `a9e76ae28` — C:144
- `ac6347216` — C:1384
- `ac6c0923c` — C:221
- `aed9e95b7` — C:1153
- `afb1e65d8` — C:205
- `b64d85c52` — L:121
- `b9fb44f1c` — C:296
- `baba78fa1` — C:175
- `bae26a971` — C:270
- `bb69c78a6` — C:209
- `bc15c35ba` — C:104
- `bc698ae35` — C:294
- `bddd73de2` — C:1135
- `be59a1f48` — C:251
- `c4ae9e0b9` — C:1165
- `c4b2fd21c` — A:351
- `c4bbc0c23` — C:274
- `c5c7467b0` — C:1125
- `c71242bba` — C:310
- `c726bf11a` — A:133, L:91
- `c8f57b29b` — C:1294, C:1305
- `c9e9109b6` — C:298
- `cbe9dead3` — A:19, A:23, A:732, C:17, L:27, L:40
- `cdc3ab959` — C:1171
- `cdd774f2c` — C:292
- `ceb948454` — C:1350
- `d29e7991d` — C:253
- `d368abd39` — C:1245
- `d415bf599` — C:1287
- `d6bc8b780` — C:1151
- `d7c63ab39` — C:106
- `d8484987b` — C:239
- `d8c305cd1` — C:108
- `d8e3d5500` — C:215
- `d9a802b9a` — C:1171
- `daef6e040` — A:245
- `db00623b5` — C:140
- `db447529a` — C:112
- `db835a435` — C:304
- `de93d5b8e` — C:110
- `df05e0e4e` — C:312
- `e14a5fc91` — A:141, L:89
- `e17a312a7` — A:259, C:52
- `e48f348d4` — C:1123
- `e604524ee` — C:1129
- `e693cd965` — C:1123
- `e79b7738a` — C:284
- `eb1d8d7b5` — C:312
- `ec44fce5f` — A:19
- `edd05fd7e` — C:108
- `f1813c898` — C:1219
- `f223d98ca` — C:239
- `f34428452` — C:304
- `f56c2bc25` — C:138
- `f5868fd4c` — A:463
- `f5a36a9f3` — C:306
- `f5ed169eb` — C:205
- `f75c6dda3` — C:102
- `f7d2db52e` — C:86
- `f8e62c366` — A:365
- `fb0d492d7` — C:116, C:84, L:99
- `fb8ede68a` — C:211
- `fbe5fb27b` — C:1336, C:1356, C:276, C:856
- `fd93c7cd1` — C:150
- `fdde18e50` — L:93
- `fe1f6d23e` — C:1125
- `01c1316a44` — C:265
- `140d327649` — C:215
- `1e12bba036` — C:265
- `3ccb819373` — C:100
- `70dedc26d4` — C:1239
- `ba8125738d` — C:100
- `09d7a8db05e942c19a8c27c7630b5ee7` — A:683
- `09ea9820f7f248339514e247d31be457` — A:287
- `108c272d18484364acc0a62bf973f075` — A:421
- `1c27909f3bb84b8c869459f2f519bccf` — A:565
- `22457a0968c24a748db46a6a8d34e331` — A:632
- `232db568df8b4f0f97fc5eb36fe4426f` — A:343
- `292282d4bca94f80af7d82ac7dcf065c` — A:401
- `2c4ff14d4ac943bfb66dfe74c3f9398b` — A:602
- `3256b7ddc91447f0a28d31021620c180` — A:493
- `38cb047fde4b4785abc1432956906cfb` — A:554
- `38ee179d56244800941634b9e1ec0522` — A:369
- `3a6647dbe8a143868b587c77ef0ecada` — A:717
- `48da35740d9b4c10bc3f32d78411c385` — A:439
- `4dfc107843114493b716a36202874b30` — A:676
- `4f258ae4fa15486d913569886399f116` — A:641
- `55f9ada52f744e5c9762613f88ef348f` — A:411
- `568edd103f9c45cfb4c7285a9ec37d41` — A:618
- `58f451880634417aa8383fea5cb75718` — A:660
- `604d1ca5362e40ba8f917ffc46cd3c74` — A:389
- `633808301d8341759b621cdbd29c86ba` — A:307
- `6ab3dc15a89b4043b3ed9baaa8fadf07` — A:311
- `6c982adbb2be46c38c1d835bc26f734a` — A:287
- `706ec76dc2a44aa2bcb545aebc87d9ad` — A:657
- `71030cc4a8d8493eb56ab1d26d0b75c4` — A:591
- `78a641a961224090969a39c96ea11343` — A:287
- `792288c765044f6db91a72f585d066a8` — A:669
- `8609411d861f43299afb75c05634cd31` — A:291
- `87579cc4fb95478b9946f0d8b4fa5a1e` — A:506
- `8790e0f6741e427f9cd8c8987cd435c0` — A:291
- `915f5158238742dc84a4121f2144e08f` — A:289
- `92611cf8bf5b4a389bca564553d74a93` — A:33
- `9d5b8651fe9645e5940d4cdc328f9f1d` — A:349
- `9eba6df306ef4ca98a8926fbc1a45c5c` — A:295
- `9fbb6843944e44cbbe2def4f837e635a` — A:359
- `a1348dda94d5420b90f89520c672ddaf` — A:478
- `b1150b4c633849978c544c2ddcea8f91` — A:543
- `b1b1daad4c64429320190cb9a72c9a71` — A:135
- `b72233d60fdd492ba184aa2192433451` — A:301
- `c993293b9e724f1a8b47265e8ca41cbf` — A:383
- `d396bac56e9e4159b19e56bff3d07719` — A:339
- `d97dd24af34c404ea0911edac5010555` — A:625
- `e210c6a184e84aababf1d388bda702ae` — A:337
- `e4e358f83d3f4d859329b1904fc25834` — A:375
- `e9aa22d4043d4e7b90a9f23423ee11e6` — A:323
- `f970266fe6fd42bd9dbafed127cd0a6e` — A:429
- `05e9da30fe4d8a29521223595bf58564d5daebb9` — A:164, A:271, C:52, L:93
- `14c1a6c6a5f89d98523283a2c7f96aeba8c0eb4c` — A:19, A:732, L:13, L:76
- `1506927038b80036749266a56fb769dcb6e6d18c` — L:103
- `18845697c75b956fec6c4e924a4aa354e87676bf` — A:131
- `246c04e6a089243d5584b7e1574d4a10ad6a832c` — A:164
- `27c8ce37da082244f006ca376068cde6b98845d5` — A:115, A:69
- `3515c61370a3d62247d645b5f3deed5c1b42e081` — C:1310
- `3aa988639fc96a13739e2980484c2abbc1dd144c` — C:1173
- `3b743d3abf4caba9a4e166232a424631a25f4884` — C:165
- `3ba1eb92dee91c198265403d09395bd1e3a8fff8` — C:759
- `3ee3b0588b30af3e445b10828293c154b2593424` — C:167
- `3f0ea1dfb81be2c1178c3733ef513782205ca303` — C:1191
- `4d618ec38b870e36e98e98e9476922e3911fa772` — C:1199
- `54ce6573502f67f4cb6227871000aa315ab87dbe` — C:185
- `620ee1fb296bf092ec547a1a2d28312b70b35ef0` — C:1283
- `64b1234566bddbb070236cda82462b0c3dbee8c6` — C:1322
- `67c509c08a204b7481fa063cf5de007de8538dd4` — C:185
- `78149802542a7e502699d1aec0d5b448265b14d9` — C:1169
- `7d28b70556613fe945e32cdc801ab430745eec73` — C:165
- `82a47c602c354164ac6c92e6cd6fbb63e15ec8e2` — C:223
- `83ae8fc1ae252e0075b1ade8bc55a3dcac110e90` — C:1322
- `84f12e4ea7b541fc53d535fb0e0f857597c02e23` — C:320
- `887f5b54b4901b7245d393983ab70bed114f1cd3` — C:1310
- `8cf79496bb64c371f3ea2618e58de1c887221dc7` — C:1211
- `8dfefb49d476f04303dca452bf478c1618bb9d5e` — A:139
- `97ebad800c818c331cbc0e38bdfad7971d810468` — A:115
- `a2f1a87c5cd6fd57c4d0f240f9723b0edf5eaa1f` — A:69
- `acfa5061956824775e1dd2444a6828e0d164e468` — C:1285
- `b7f165c83f8c6957df292ce54ea0ce82f9d2f566` — C:1177
- `bcbc634fd50930bd816dfea57b00c782dcba778f` — A:69
- `c5ddb615d3ad646cd33997c4571f439cea52d968` — C:223
- `d6bc8b78027ebacef31062b2f7dbf1f1a8886435` — C:1179
- `e1ea0fa8ac709d83e614f8e8f343841a384be31b` — C:169
- `ec32129cd87ff0a97fe77c8f2ed1391245979524` — C:167
- `ec44fce5fc39ea641adaf6b0b1dbd703cb6d53b0` — L:13
- `ef5ec183ee14172fbe122ea0dcd771e0effbbe93` — C:169
- `f0bf56f27b31d38dc226fd941dc393f36b9b8040` — C:1171
- `007f8b794d7d8c90b52080a2e04dcd43a3435209aea259f548b9f5e38655083e` — A:660
- `00ef244c87270d1991453687916b6133f1fbaa4fcdf83f42a5c888ecd7f8d3dc` — A:47
- `02854b31731c7875cb9fcc07feadcdb70e6c28ad15623ecbf765cfd588bc0980` — A:401
- `06e982e62f8780f056b0b02f0cfff77eb6e55f90266c057118fd96c90fcf43d1` — A:369
- `073017a35279ccbb9f106ae95a2340dcc6ec6240d20a2a3b0f439a649fd6e98f` — A:383
- `098e296fa4498dedcfb4cf4c6ae07aef2aa72d2453c93b6391f0b881b298ab64` — C:1199
- `0aaf712627f39b49c6b85c283528ebe9adfd77b175de0cf234c755e63aa07000` — A:717
- `0db31e950c661d49ded96f8f04008313b16b062a82950b0ec86e0cde8b0cc9a5` — A:589
- `0dc9d22d02d859224b7d6be035f9e806321b1ddc79d9b624b2931453e04fa741` — A:237
- `0de237612a167fd2adc1cecf10307482ada78cae8953fb1ab14412ed502d62e5` — A:301
- `0f840c337037e3e315494ced73525b1f93ab98e012b9c895ad4e1ffb6680553a` — A:527
- `10fc5b5f1b0ebf047ee7ee3cdcb117c3c488ae22c5e6cc2e47de4f4f433ca831` — A:506
- `1149308f14d23ea070233f7b61bdfd9e86e8e67a49fbafe96ebb46a0c109799c` — A:271
- `1370d4957c5f0e37669ba6b42c2bf1df434021ce2c2ee1a80721796ccaad49ef` — A:625
- `13fa18a6c4df22ad4804a7166dfee713bdbb84ff1dbdfa44c6b1f46b3eefc710` — A:253
- `13fcedf366e54c6ccc08ef8cc8e9c18719fafd7a35dbd9ef2153b92f36433cd4` — A:696
- `13fd755af7b2c664d8f2b7d25ca0b4510ad9d844352339360dbdb7dd3a9aaf6c` — A:93
- `15b326f6390c74b59c48af4f0edeb24b906f880c7b27d72f889ae4085db26b09` — A:271
- `176a64b8b89d39fc11d3e68ea828252a153ec1aaa2fa8f22e81e4422338bb54b` — A:139
- `18bd700023b1e2c298c45a09afa7bd44994ed1cb582311cf6eac23a8c98252af` — A:131
- `1c0f86cfc69cf6358bf4ca3a8f2aadb0f1d011ca8278006e9f76f40403708285` — A:411
- `1dfc762d3040bb6bf99253a854368b3259cad7661f2ae2176fc9d9b46e438295` — A:131
- `2144ab45b819e9de76db5b25be80dc415ca99c06f873a9d70327c99d5dc00830` — A:726
- `21e26cdb51dda2d3d64e2e6bd607aa9060b26aba90902904fd63cb93163befa3` — C:1177
- `22eb3694d3be50c7d95f94103ebd7bf80171945632747dbb4e8e932ba5561ad0` — A:667
- `246c9451d483e17e23ab40b37782fb2d00be71d21a733d0084a88ef5777b9b8a` — A:448
- `263cf172b66722d3619aab7f9fa7cb1683610f05de23c6f3df361b6d82e6e25c` — A:287
- `26e5b4602882fb792794a870fb059b0bcb8da295395ea212ea004c7e10defd61` — A:598
- `2836654730a6907561c1ba0d08d2cd9e8a51e6c2a354c40a8e04e6c0c8b36c73` — A:417
- `2929f83a4ca58f2c68e6eee517fdb81db4e9488f7954a51a5fe060e4b387df32` — A:317
- `2a4a80091e3029aa1df8279b5b4d9a2e8e9cfb016199b390130d6d63e9edb1ae` — C:1310
- `3012c7a08291a41e43e9d0050ecc4a6aaa7a8d622b7fd7cdd88477925c74db27` — A:552
- `30347087dc3fb4ff0e6b34903c05f7482fdf05d68664d92b0672126f70cf0066` — A:13, C:11, L:21
- `317b9a367a96c5942377c13bf99725029758f93f910b5a38f16953998c128550` — A:450
- `31d76e80f6d5a0fddb4073c5c76ba3e34a8051a0cdbef6869eba4cb6f2631d2f` — A:323
- `3644fa477836953b7b6a721931cd4928d827d7645c60950f31e45ab17ae71caa` — A:461
- `3674d101704bfee2e39311511979be8dc4933a0160c929ee51f61dba0de91fc2` — A:237
- `36768412d293db532db5b53cdb838b3cfa873278f87a9d2034a3b2bb613a18ec` — A:253
- `381d207b91fad117a0f5c9bc437c564b5d9192e63a9bb74828e3d3c3c2857e74` — A:433
- `38aa849fc54afc3f0b9253bfc55c7892776c8c704817c6384238d2d44c13186b` — C:1179
- `38f301e884042970c1e2b4af090464c34b21ed1fc205e827bd1fb739095562c5` — A:525
- `3a5c6c02373584b68198bc2f7ee9b69e849c172bc34d72f216b717d742c442ab` — A:35
- `3a78ef7c9810e455b0e5fa30378dfe2a892830cec68b2cb2118c69f796244435` — A:13, C:11, L:21
- `3ad7e9049a7b1c09f5cb273aebaa08349babc96fe6e3e7669d01affc11e52a3e` — A:480
- `3cb11324c2b88defcb028fa66848836b5ea1b453aa56dcd378d6a266280bca24` — A:287
- `3df9307b9b09f33d8b1444a5271512fd7af11c2f272433685de0eaed010cf7d3` — A:676
- `405882a855ad937ca9796c80e5e1fbad21e5c63eb5f58a766e212582a8f27914` — A:550
- `40c37ed9b5891e5849e56c55e5cd9abda8090d1c87788303b6360fa19be96c89` — A:237
- `44e0c219ef8b6bbf85278c499d4b3e35b4a00e4f24dd6c35a0df407c93d2616a` — A:349
- `454db18871b5ab03b23cbdbab195e714d15e77640e68b58063ce9cb65cf7bdd2` — A:237
- `46329ffd70dce42e83f7953d6a869f5296ecf31c9d4eefe7e236767123e9a1a1` — A:730
- `48512a1ffffd3d8302c232c31acff64d7668924f23938ca4d9ebffb54bc0d905` — A:271
- `4a4cf75cd67be32f4161d44e7e0c134e0f26491604d0246ab20db230cdfed2e5` — A:139
- `4caa1a76dc803944aa8a46c141b626aea10e1e39a621b3e007edb6b1fa648941` — A:417
- `50bae21b47f3bc9aa02d1031e35484e34e1d2a89d2ee2c398d223430c5590368` — A:13, C:11, L:21
- `517509f53c4777a76a580ef8cbc889c35710009c0661ed2069a38d251df1e69c` — C:1330
- `56282208e551f30f8f49dfdf9cd18f25805c66909ab2cc57b3264f526901b6d9` — A:82
- `57549353ba840edd034ccdd9f4370633343a3cf406c618a72d419a7287bff200` — A:29
- `58f9cd40c3a04270ff1f4a3a00c381026ef2bd43e35690e5f94bbeb3dd6beeed` — A:389
- `5900039be0a293efe12eec438fa77b5bbee6f06208a60b231a9620dcebe9877a` — A:65
- `5a24ebe16b2f2d615b2b131cbc6dccd5d774c72b6029395e2ecc5fd0f8091365` — A:164
- `5c432e105504a794219f67022f1b5cf3d4a41fd25aa74617022ab7de02db15b4` — A:563
- `5c901794b383da0c34144e4d9cfe6f8e74ed458267321b8044cd15677518a7b6` — A:271
- `60a63bc3d606362e9f42576a0b1e5f9524a14e9612ba2dc5e9a39461b6c60d9b` — A:135
- `61ac16d03a58b393957b1a18276226dde8717f21178419543871ef00fece5e3c` — C:1179
- `6302d5bca932c0065a77b06c276ce751ddda8935d039572f0f2e8b0326a01466` — A:53
- `66afe766350c67c4d6580671480f7d9e55a91139fedbfcf8538653608edb0da4` — C:1294
- `6861bc3feebccac5b64580dca751acec15612ba6405921432a1ff5e929209eab` — A:563
- `68ac0a5be955a204b4c8b440c762fde72d4f4c4238eb2a7af16179bb28565dc1` — C:1316
- `6a83ae3a1e588562c84b1ad6058767b40ab1068b18512233b44de8598bbfc67a` — A:253
- `6cd53fa25ca3b941b2460e715c545ae649c938cd52584d4c18eba6387801bcc6` — A:291
- `6d4f8d945a0223f143baa9c698c9c2a34d4dfb794a998e19440deba93ca1da0e` — A:439
- `6d8bc8f97b7e081cbb070e0b126fa3c99a074a6f76427ecaf9d85b0ba8b60c3d` — A:253
- `6dbf4bfb1ee8b720fcca446cee500372fc21f6e5230c7e9dfe546501749afbad` — A:319
- `6eac601fc0cb76e58a697f10a57a1226c1f51c483934b71e8dd2c7b3fb8db66f` — A:49
- `73c3062dcea37f9b63073bd8bb21598dfbf2c4608dd0af86c7a8f5a87ac09fed` — A:131
- `7592bbf5aa4061ac0347c0ab825ca5a37a004645028a2365bb9c13daff772849` — A:632
- `79046dd8597f08a43662bfe768ff8a293949fbe5940f351760c08f637a39c7ae` — A:253
- `7967ea6ace1f96787d206c275239bc0e28e909ec40f0b14673a533a6fdc1ae35` — A:17, A:33, C:15, L:25
- `7a7936d52c155de00c280912eb7ffea92003f665f57c3b744e866e771caf6a96` — A:125
- `7c67decb7e71848bfc79e0f607a4303cec2dfdf62033ec5e199f5fa983baa1eb` — A:359
- `7d2d1a683369edc600c5556b30048b6666f52bf1f19c7af0f57b807438f4d318` — A:700
- `7fc3fdd55d4566d3d88d90b456f4a38829a62b9035555339fa8eb89ec4afb97e` — A:543
- `81bece3905f2b682da44359091a75292eca498962e61314b4cb0acacc921416b` — A:287
- `820ed11fde04cf0bce0c5c81c8762345aed1414ce05699a436320abf381fd0ba` — A:309
- `82a6e063a44236282e65de1824cf717449156bff7f1f87a7b00120223b3c2bc3` — A:459
- `82e7b1b13ce1cdff1f996c928b518290498b3280d9c592ed0631649f64e90645` — A:690
- `834ff3b21912b0ae29950af392fb099eba29da49bf03568ec2e2feec18e338de` — C:1199
- `841f603e04d47bd93df1f5c0199e69f1332087fd255d67f2259ff8f3f6362c59` — L:121
- `854d8b413716299b4a33a975de5dc99e64b81d306d74aba14adfb48a30b99ba1` — A:536
- `8557d8d87649004eaa36fa77b1a9f135ff5925a6563f406cadd607cdc55dc19e` — A:593
- `879b0b5304e4d77ec627ca7b6fff9189ca154ef74ab53ecb5b4a8057e33a61bf` — A:637
- `87b809a5e72cbd7c50bf10665d225ba744ab62a778b4ccb790fc93685a3bc6f0` — A:710
- `881b60570ca4d988ad0a2e51f8a49ce8b0472df16e6fe88da5d5b3c24c523e8f` — L:127
- `8a494cd73c490aa79493009efcd0a04fa8fdd706d37a62ae5b8459f505da08c6` — A:435
- `8cd9f720f31463c9f3e91297787bbf8fbb9ca2f770ff848835f2ec1cd0c66432` — A:694
- `95c80c92f9b49f9e23b83cfa1988b0654654d8f541813f6034f2b02cd920d079` — A:433
- `95dd4a18e14c8f89b63d77a2dc9335916753a0d11a1cbb0efed957e5e1914eeb` — A:405
- `9719f3ef72afd71d08341d89e1c3fe75007b50d09c3c3ea17f0b4a084f63eec3` — A:726
- `982841dec35cf763a8ed184058f05b6908d73c6e7eb6339d51e079b1f993e830` — A:307
- `98da4e98aedc4e8ed42180a8f9ae3724582152a5cd77b27cc1e92786a6afcb01` — C:1318
- `9dc5df38a28fab2c253027b03c86595d98cc7bea07c366d3d1d100a4f9e5ba3e` — A:692
- `a23d949398303426a1f191bc077cdfc6b9b2bfb949d9b2204df5086942bfcbdb` — C:1326
- `a5a48ea1b4e10916232910d6ee6ea79a32da5fcc4d9cd1ed7b19ff43af3330c9` — A:401
- `a5b98d362ad25908a3a81b0e913b692781a9c00c9941384813fa6097e80026c8` — A:139
- `a7d0e3a0e85fe4fc45cd110502c8de5211e8c63139e32cff0ddc13f60131c71d` — A:690
- `a82378acd189dbdf6ce11ebba5356cc21909b70b85f8ce989ba5733f113edae6` — C:1191
- `aca795549818dbf5a8b10bfd40434cdcb13a346ae6eaddfdb35a4c717c174f42` — A:99
- `ad842cdaeb64588dc30356c0eedc0bf65a0970d99593a787d719a579190a1a53` — A:692
- `b2048c2e475264cf4001e3b3b461b9f429bf6aa760a86c00958e26c1c898eea1` — C:1322
- `b2a95fcb1d2fc2bf430f086bdf455dfe80db12b320c67f02a4ea083d35a09b79` — A:339
- `b499793344aefd9360b5bd60c14954343421adc19c12635505ccc5ecd3049eb7` — A:343
- `b5c5f0b8e57ea7fefedd26d629d2d2e9278417867d13e941a63acafcb0020bfa` — A:271
- `b5c934ebc9a8c9149b62749f03cf0812f53610fbbb53d695f95ba09e24283c43` — A:289
- `b66a213d2ae06b7b733403cfc16e51387ebd17ffae8c73b4608d67926e2b4798` — A:117
- `bafbbedecaccfeddbb0a11186caf39f546120700627366c3397e2204fd97aaad` — C:1316
- `bb95bd925367473f412ad92cf49158bb54b3c4ab687e38d33fa1d5a5076fc3da` — A:470
- `bbf4e877be058423af328facda21991321063ed2a4770b6177fae029431669a7` — A:558
- `bc2366d2dddeec883f8abf5ad9825ea1f7203684b60490ae86f78121dd58a15b` — A:681
- `be73f653fc80f48c55c24332f2ebf3d6b7b9d0d9bf2f9396ecf38c49aa011f04` — A:123
- `be9358508408710d60355d57ea825e061dee8c5d8e6ffa1e58ea227fe5cf9cf1` — C:1318
- `c1ceff8047f838db854ba3d6f45669f744351054e217205b26e1b02960237f49` — A:13, C:11, L:21
- `c1e8fed869c0bb26130e3c409950db6c81e7b05e686e17d494bd8699878270fc` — A:375
- `c29207462d6dd865893412dfe8d0a6bc7b0ef35383006e0e86322ebec9a29747` — C:1322
- `c3951ab12fde833db084c16a36fb47b20e3f99c6069e12b51a21cec315de2e4a` — C:1177
- `c433e273d24e7a7042f18fe5cff7ee884fa196248159e517e2631ccf70df0384` — A:523
- `c96b56e11a8768f2168d229691dfe350ec5fafd34985a4b19d640c762b677da4` — A:13, C:11, L:21
- `ca7e75ee76c18ce90dbfb132c00da8c95c88f64ade254ca0425f864e1dd7423a` — A:417
- `cb8ad7c36ae798231686cfedf34e270396ff00a533fd7f6b8af362270868c711` — A:295
- `ccde6e85ea81808d08e97595fa14921c55682efb552d10123ad4c27b28b70e0e` — A:57
- `cd80b12dc41da6598c5563c424a6e255b074a58b5360ab7a627982b0897797e5` — A:389
- `cdd5ee5e38eec4cf6acb4b478756de388abf02ef49195bcf5637304cf23c6184` — A:168
- `cddd4d5bc591616d9070401617cde7c5a4ed8c5299fe98300cbb39f94cbb9f03` — A:271
- `cdf52d65827f2c646d12164186acd02b7432037a4fcd2e1dd3128328c5a185e8` — A:81
- `cf8b72ccf776bcd26e8d38f7edeb44e7429b32e46483a768804ffe6432d645e7` — A:311
- `cfc4ea2938b20fdc7290d71887641e13630ec4d772590e7199de833f4672bb92` — A:421
- `d1287476f7fc7069ed52a1700b4edcc6dcd2cb34adc117d42ca64302fd1e10f3` — A:435
- `d1555d538cf354ac0965c3d5aca25ec18e7dc8b7576a0012580cce7620657b55` — L:127
- `d180493f1c672f6c2e85c62c0134abac7ecfdf99852ca2485d67ecb8c3ea4fa8` — C:1305
- `d22f0cc3064a6d716b145f85e8363d01e4f49f30d7c4567c58b361be6cd839f9` — A:164
- `d3fec80754af58ae5a03dbcdd38dddb8208500ffb6ca8d731c45e812e13d5b3b` — A:111
- `d513ee0c322e341fbf5711be38de87c99d2245a225cb516e5bf557e296f82ef4` — A:655
- `d59332908ba358f667503dd13781e145099da776e2a758d998df4650e5566222` — A:417
- `d78c8e41310e1f830671924738378b024db6c5f0a7a7ffc302f84ba62cd86f3d` — A:164
- `d8d7af36762f3c094789f4400d070910ea3157c46dd8d388334e05c2ecbdff82` — A:45, A:673
- `d911ead1daa5327bc8fa9535f5093afd559e2f95292c5560d5b78007692dce43` — A:4, C:4, L:4
- `da56851def7be4a1d4bbba2cd1691560e794679abd4282e9169b5a445f4661c8` — A:692
- `de09ace0d29693948f12acbbac00e6a28d27d92ab34579dbcc4aa55248108acd` — A:706
- `dfc09368cd3c77415b00fdaad2d06db854d636e5f69d923b1aee7fbb70714030` — A:45
- `e41c52098af0e8f756ee52270d070041a417b42fa304d404ab4b6038d7f0535f` — C:1310
- `e59874327ed0355cf6bfac24f8345ddf5d83a35462b33958ba2c96ff95ba2a91` — A:335
- `e65f6126551409b8175a9f5356b5a6c03383e1c416ac4073957d47c432a89b39` — A:391
- `e699aaedd1a8b6332f6f864a3f12bd1cd07d6a6fdc0179ddceb98a41e1d9943a` — A:706
- `e7058991cee3a86e9f6922ccc986325b6451524ac5ac200ce258887893eb2f74` — A:13, C:11, L:21
- `e8a02700320535d5c47745f43b11712769bcad1c50b3d4e936f367da81df04e7` — A:429
- `eca8f679829afb3d75120ddf231024a3106cc448729fefbd129dd226a87a9c98` — C:1191
- `ed9aa5987d2c453efc526f9d36e8f30cf645f0c3ae719bc3d959ca452b5ad4d5` — A:425
- `ee0365bffc7a77af3173ead8f181512026f1aa221866f67064d0bd812cdbfd6f` — A:259
- `f1581d32a7b01dda23e5a0fccc55b99f0659b353920338077408d250206ac9d5` — A:618
- `f6da0d3948846be3b4eeed9ab7f0f46b22127f601c3d275416f799485a211098` — A:493
- `f7ac23d891139f60914949cfa097e02880467e0d8cb9bdfc365275febe0c87b6` — A:253
- `f82ada3be3bddbb7b9352c2f307e42eeda48194d0b25fdecb0f1110b0e63ef3a` — A:41
- `faedd7989120d38c8f6bb863d95a1514e12ebe0c28b7c94e27f04d2e1ac529c4` — A:708
- `fe5959fc9aea026592560feccc656fbedd0178356039e9b970a3a3e7bec1a5f1` — A:291
- `feb0e4f31ae0526ab9364568001dae0973719aafbbe48969883d8da191884f05` — A:279

</details>

<details>
<summary>Erhaltene historische Abschnittsanker</summary>

Die früheren Abschnittsnummern führen zum konsolidierten historischen [Evidenzindex](./yjs-mvp-tool-and-restore-acceptance.md#historische-evidenz-lesen). Maßgeblich sind die aktuellen Verträge oben.

<a id="komplexität-begrenzen-verbindliche-trennung-für-das-mvp"></a>
<a id="nutzerergänzung-persistenter-linkindex-und-offen-bleibende-dokumente"></a>
<a id="plan-yjs-dokumentautorität-und-sichere-dateiaktionen-konsolidieren"></a>
<a id="restarbeiten-bis-zum-vollständigen-ergebnis"></a>
<a id="verbindlicher-aktueller-status"></a>
<a id="quellengebundene-historie-der-umsetzung-und-nachweise"></a>
<a id="0-zuerst-undo-verlassen-und-bestätigte-speicherung"></a>
<a id="1-ausgangspunkt-und-überprüfter-fehlerfall"></a>
<a id="11-was-in-dieser-untersuchung-bestätigt-wurde"></a>
<a id="12-was-dieser-fall-architektonisch-zeigt"></a>
<a id="2-zielbild-und-verbindliche-invarianten"></a>
<a id="3-bestandsaufnahme-vorhandene-grundlagen-und-lücken"></a>
<a id="31-vorläufige-auswirkungsanalyse"></a>
<a id="4-geltungsbereich-und-abgrenzung"></a>
<a id="41-bestandteil-der-konsolidierung"></a>
<a id="42-eigenständige-verträge-die-erhalten-bleiben"></a>
<a id="43-nachgelagerte-beziehungsweise-ausgeschlossene-arbeiten"></a>
<a id="5-gemeinsame-interne-document-service-fähigkeiten"></a>
<a id="51-vorgeschlagene-fähigkeiten"></a>
<a id="52-snapshot--und-frischevertrag"></a>
<a id="53-autoritätsklassen-und-initialisierung"></a>
<a id="6-linkprüfung-ohne-pflicht-zur-markdown-projektion"></a>
<a id="61-repräsentationsspezifische-prüfung"></a>
<a id="62-link-referenzen-und-vorbedingungen"></a>
<a id="63-vollständigkeit-und-betroffene-quellen"></a>
<a id="64-gezielte-mutation"></a>
<a id="7-dateiaktions-koordinator-sicherer-zielablauf"></a>
<a id="71-planen"></a>
<a id="72-ausführen-und-bestätigen"></a>
<a id="73-abschlussvertrag"></a>
<a id="74-retry-konflikte-und-unklarer-ausgang"></a>
<a id="8-backup-copy-delete-undo-und-restore"></a>
<a id="81-autoritative-recovery-artefakte-als-p0-voraussetzung"></a>
<a id="82-copy-und-initialer-import"></a>
<a id="83-delete-und-papierkorb"></a>
<a id="84-undo-und-restore"></a>
<a id="85-neues-dokument-text-einfügen-und-markdown-importieren"></a>
<a id="86-pdf-konvertierung-ist-ein-kontrollierter-dokumentimport"></a>
<a id="9-writer-reader-und-abgeleitete-verbraucher-vereinheitlichen"></a>
<a id="10-ui-fehlerverträge-und-observability"></a>
<a id="101-nutzerverständliche-zustände"></a>
<a id="102-direkt-editierbarer-inhalt-als-standard"></a>
<a id="103-platzierung-von-dokumentbreite-und-vollbildfokus"></a>
<a id="104-fachliche-fehlerklassen"></a>
<a id="105-messbarkeit"></a>
<a id="11-leistungs--und-konsistenzoptimierung"></a>
<a id="12-umsetzung-im-worktree-mit-abhängigkeiten-und-abschluss-gates"></a>
<a id="121-checkliste-für-die-gemeinsame-fortschreibung"></a>
<a id="122-konkrete-ui-liefergegenstände-innerhalb-yd-10"></a>
<a id="123-worktree-regeln-und-parallelisierbare-pakete"></a>
<a id="13-verpflichtende-abnahmematrix"></a>
<a id="131-bestehende-testgrundlagen"></a>
<a id="132-integrierte-prüfungen-und-umgebungsregeln"></a>
<a id="133-verbindlicher-manueller-createpasteimport-abnahmelauf"></a>
<a id="14-migration-rückstände-und-rollout"></a>
<a id="141-additive-verträge-zuerst"></a>
<a id="142-vor-dem-rollout-lesen-und-messen"></a>
<a id="143-kontrollierte-aktivierung"></a>
<a id="144-rollback-ohne-zweite-wahrheit"></a>
<a id="15-separate-behandlung-des-aktuellen-transkripts"></a>
<a id="16-offene-entscheidungen-für-unsere-gemeinsame-prüfung"></a>
<a id="161-umsetzungsvorgaben-und-yd-00-nachweis"></a>
<a id="162-implementierungsnachweise-und-verbleibende-abnahmen"></a>
<a id="history-lineage-deterministischer-gegenfall-und-korrekturentwurf"></a>
<a id="v12-historykorrektur-im-browser-bestätigt-link-fixture-vor-navigation-gestoppt"></a>
<a id="v13-frisches-wiederöffnen-bringt-entfernte-eigenänderung-zurück"></a>
<a id="v14-u-01-und-enge-web-abnahme-i-07-bestanden"></a>
<a id="yd-08s-privilegierte-suchprozesse-gegen-options-konfigurationseinfluss-abgesichert"></a>
<a id="native-dateiaktionsbelege-explizite-formatgrenze-vor-dem-koordinatoranschluss"></a>
<a id="17-änderungs--und-nachweisprotokoll"></a>
<a id="historische-zwischenstände-vor-v14"></a>
<a id="mvp-launch-zentraler-dokumentkern"></a>
<a id="aktuelle-entscheidung-für-den-launch"></a>
<a id="komplexität-und-bewusste-mvp-grenze"></a>
<a id="ergänzung-linkindex-und-offene-ansichten"></a>
<a id="bisherige-teilnachweise-und-historische-fehlerstände"></a>
<a id="historischer-ausgangspunkt"></a>
<a id="erster-veröffentlichungsumfang"></a>
<a id="verbindliche-launch-gates"></a>
<a id="m1--alltägliche-bestehende-dokumente-und-dateiaktionen"></a>
<a id="m2--produktionsaktivierung-und-einheitlicher-schreibweg"></a>
<a id="m3--gemeinsame-abnahme-und-main-merge"></a>
<a id="nachgelagerte-roadmap-weiter-offen"></a>
<a id="nächster-umsetzungsschritt"></a>
<a id="mvp-toolkonfiguration-und-restore-abnahme"></a>
<a id="copy25-integration-snapshotformatfehler-konkret-eingegrenzt-und-korrigiert"></a>
<a id="vollständige-owner31-abnahme-mit-ausgeschalteter-optionaler-historie-besteht"></a>
<a id="owner31-erneute-echte-budgetgrenze-bei-60-zielen"></a>
<a id="owner31-größerer-öffentlicher-linkfall-besteht-negativfixture-korrigiert"></a>
<a id="optionale-versionierung-standardmäßig-aus"></a>
<a id="zwei-konkrete-produktkorrekturen"></a>
<a id="frischer-produktionsbuild"></a>
<a id="tatsächlicher-sameowner-commit-und-fünf-schutzfälle"></a>
<a id="tatsächliches-zielsystem-commit-anmeldung-und-weiterbearbeitung"></a>
<a id="gesamtcheck-konkreter-red-und-testkorrektur"></a>
<a id="vollständige-wiederholung-nach-der-nachrichten-id-korrektur"></a>
<a id="integrierte-editor--und-previewkorrekturen"></a>
<a id="neuer-build-und-erster-zusätzlicher-browserlauf"></a>
<a id="zentraler-read-und-reload-bestanden-mobiler-hoververtrag-korrigiert"></a>
<a id="grenzen-und-launch"></a>
<a id="create-sperrkonflikt-nach-erneuter-echter-browserabnahme"></a>
<a id="aktueller-editorerfolg-und-rote-dateiaktionsabnahme"></a>
<a id="isoliertes-html-inspektions--und-belegfundament"></a>
<a id="isolierte-gewöhnliche-linkinventare-v4"></a>
<a id="gemischte-quellen-und-operationsbezogene-html-bewertung"></a>
<a id="html-move-durch-plan-mutation-und-echten-owner-angeschlossen"></a>
<a id="move-wartet-begrenzt-auf-kurze-lesezugriffe"></a>
<a id="ordner-move-erhält-pristine-identitäten-und-schließt-innerhalb-des-limits-ab"></a>
<a id="implizites-rename-bei-angenommenen-noch-nicht-gespeicherten-rich-änderungen"></a>
<a id="vollständiger-backendnachweis-für-paralleles-editieren-und-move"></a>
<a id="clientanschluss-und-beobachtung-der-authentifizierung"></a>
<a id="jüngste-pending-diagnose-timeout-vor-workerstart"></a>
<a id="p0-transfer-innerhalb-des-limits-nachfolgender-workerfehler-eingegrenzt"></a>
<a id="admission-phasendiagnose-und-abweichende-testpollinglast"></a>
<a id="echter-http-statuspoll-und-nachfolgender-verarbeitungsfehler-21-oktober"></a>
<a id="abschlussphase-gemessen-doppelter-reiner-compiler-entfernt"></a>
<a id="gespeicherte-move-vorbereitung-verwendet-bereits-erfasste-daten-weiter"></a>
<a id="historische-statusprüfung-nach-echter-projektionsfinalisierung"></a>
<a id="weitere-reine-bundle-wiederverwendung-parität-belegt-laufzeitproblem-bleibt-offen"></a>
<a id="phasenlokale-intentdaten-und-receipt-proof-aufbereitung-echter-fortschritt-neue-abnahmegrenze"></a>
<a id="wiederholung-mit-terminaler-projektionsgrenze-und-separat-bestandene-native-receiptfolge"></a>
<a id="vollständiger-aktueller-ownerabschluss-2424-21-oktober"></a>
<a id="pending-ui-eingebaut-gezielte-programme-grün-integrierter-delete-b2-weiter-offen"></a>
<a id="pending-census-und-delete-engpass-aktuell-vollständig-geschlossen-2424"></a>
<a id="zusätzliche-pending-browserfamilie-übernommen-tatsächliche-ausführung-offen"></a>
<a id="nativer-html-delete-lokal-integriert-erweiterte-tatsächliche-abnahme-bleibt-rot"></a>
<a id="delete4-erreicht-tatsächlichen-stage-physical-fault-nachfolgende-testbarriere-korrigiert"></a>
<a id="tatsächliche-sid-b-recovery-erreicht-zusätzlicher-prephysical-engpass-offen"></a>
<a id="begrenzter-writer-queryanschluss-und-erhaltener-metadata-fixturefehler"></a>
<a id="metadata8-mit-korrigierter-checkoutbeobachtung-tatsächlich-bestanden"></a>
<a id="querykorrektur-besteht-metadata8-html-recovery-erreicht-atomaren-b2-archive-schritt-und-bleibt-rot"></a>
<a id="enger-nächster-archive-kandidat-nach-bestätigtem-b2-timeout"></a>
<a id="e6-archive-kandidat-erreicht-abschluss-erste-einzelgegenprobe-bleibt-wegen-projektionsbarriere-rot"></a>
<a id="echte-after-physical-grant-sid-b-einzelgegenprobe-besteht-mit-besessenem-projektor"></a>
<a id="echte-cas1-cas4-rollbackfamilie-grün-unveränderter-vollständiger-owner30-lauf-gestartet"></a>
<a id="vollständige-owner30-folge-bleibt-im-größeren-workspace-vor-erstem-archive-read-rot"></a>
<a id="nächster-begrenzter-entwurf-aus-dem-aktuellen-quellenreview"></a>
<a id="fester-e6-domain-leseschritt-eingebaut-echte-späte-toolfreigabe-gegenprobe-besteht"></a>
<a id="owner31-im-größeren-workspace-weiterhin-rot-exakter-writer-with-kandidat-übernommen"></a>
<a id="vollständige-owner31-folge-mit-exaktem-writer-with-erreicht-archiveabschluss-bleibt-im-budget-rot"></a>
<a id="rein-historische-planwiederverwendung-übernommen-alle18-purefamilien-und-komponenten-bestehen"></a>
<a id="vollständige-planmemo-ownerfolge-erreicht-alle-domainstufen-bleibt-vor-commit-rot"></a>
<a id="historische-e5-wiederverwendung-rein-geprüft-neuer-vollständiger-ownerlauf-offen"></a>
<a id="e5-memo-erreicht-26-ownerfamilien-öffentlicher-delete-bleibt-am-budget-rot"></a>
<a id="copy-abschluss-am-21-oktober-assets-regressionen-und-installiertes-sdk"></a>

</details>
