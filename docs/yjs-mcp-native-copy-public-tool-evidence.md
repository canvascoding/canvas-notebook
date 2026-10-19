# Öffentlicher nativer MCP-Copy-Anschluss
**Aktueller kompilierter Anschluss lokal abgenommen:** Die unten dokumentierte Fortsetzung besteht nun mit frischem Originalbuild und echtem OAuth-/Browserlauf **8/8** samt allen 14 Abschlussprüfungen. Der folgende erste Abschnitt bleibt der ursprüngliche lokale 29-Gruppen-Nachweis. Allgemeine Aktivierung und Gesamtauftrag bleiben offen.

Stand: 19. Oktober 2026. Dieser Teilabschluss registriert `copy_knowledge_source` mit expliziter Aktivierung und den vier Aktionen Preview, Apply, Status und Recover. Er ist eine lokale Quellen-/PG-/Dispatcherabnahme; kompilierter TCP-/OAuth-/Browseranschluss, SDK-Dateiaktionen, allgemeine Aktivierung und Gesamtauftrag bleiben offen.

## Gemeinsamer Dienst und öffentlicher Vertrag

Der strikt decodierte V1-Wirevertrag akzeptiert nur eigene Daten und feste Felder; Getter/Proxy werden nicht aufgerufen. Aktuelle verifizierte MCP-Autorität bindet Client, Benutzer, Quell-READ und Ziel-WRITE. Der Dienst nimmt die tatsächliche Herkunft in einer kurzen eigenen Transaktion auf; deren COMMIT und Close müssen vor Eintritt in den bestehenden Owner bestätigt sein. Verlorene Bestätigungen starten keine Mutation. Frische aktuelle Ownerprüfungen bleiben maßgeblich; eine frühere Aufnahme ersetzt sie nicht.

Preview, Apply und Recover behalten das native Aktivierungsgate. Status ist auch bei ausgeschaltetem Mutationgate ein aktuell autorisierter reiner Read. Die Registrierung ist explizites Opt-in, standardmäßig aus, mit `knowledge:write` in Descriptor/Settings. Konfigurationsversion und alte Aktivierung werden nicht ausgeweitet.

Web/PI und MCP benutzen denselben festen Copy-Owner und dieselbe Ansichtsfinalisierung. Frische bestätigte Veröffentlichungen erzeugen genau ihre tatsächlichen Serviceereignisse; historische Wiederholungen aktualisieren Zielcaches ohne erneute Geburt oder Quellcachelöschung. Erfolgsfinalisierung liegt außerhalb des Owner-Catch, damit ein Finalisierungsfehler nicht doppelt finalisiert wird.

Preview liefert den vollständigen öffentlichen V4-Plan. Apply und Recover verwenden Caller-Operations-ID, Plan-ID und die aus Preview aufgelösten ursprünglichen Wurzelselektionen in Originalreihenfolge; `rename_on_collision` ist dort nur false oder ausgelassen. Kindmappings werden nicht als zusätzliche Selektionen eingesendet. So bleiben auch frei gewählte Zielnamen mit Kollision bei B1-Recovery und historischem Retry exakt gebunden. Der bestehende Owner-/Stagevertrag wird dafür nicht abgeschwächt.

Wiregröße höchstens 65.536 UTF-8-JSON-Bytes; das vollständige kanonische Original einschließlich tatsächlicher Origin/Endnamen hat zusätzlich sein eigenes gleiches Budget. Die ganze MCP-Hülle einschließlich escaped Text, structuredContent und echter OAuth-Metadaten bleibt höchstens 1 MiB. Kein stilles Abschneiden. Feste öffentliche Fehler behalten eine bekannte gültige Operations-ID. Reine Status-404 und bestehende-only Recover-404 sind getrennt; keiner erlaubt einen neuen Auftrag als vermeintlich sicheren Retry. Erfolgreiche Hüllenantworten können `needs_recovery`/`failed` enthalten. Copy liefert Pfade, keine erfundenen Dokument-IDs.

## Tatsächlich ausgeführte Abnahme

Alle vier Originalfolgen liefen seriell im vorhandenen verwalteten PostgreSQL-18-Stack, ohne neuen Container oder Appserver. Parent und alle Kinder endeten mit Exit 0 ohne Signal.

| Folge | Gruppen | Originalexit |
| --- | --- | --- |
| `mcp-server-workspace-copy-contract-test` | 8/8 | 0 |
| `direct-mcp-workspace-copy-tool-postgres-test` | 6/6 | 0 |
| `direct-mcp-workspace-copy-principal-postgres-test` | 9/9 | 0 |
| `workspace-operation-native-copy-views-postgres-test` | 6/6 | 0 |

Damit bestehen **29 tatsächliche Prüfgruppen**. Die acht reinen Vertragsfamilien prüfen Decodierung, Proxy-/Getter-Abweisung, Bytebudgets, vollständige Preview-/Statusausgaben, feste Fehler und echte OAuth-Challenge-Metadaten. Sie ersetzen keinen Autoritätsnachweis.

Die sechs registrierten Dispatcherfamilien benutzen `handleDirectMcpPost`, tatsächliche signierte JWTs, aktuelle echte SQL-Grants, den unveränderten nativen Owner, PostgreSQL/FD-Stages und beobachtete echte Serviceereignisse. Gemischte native Markdown-/Scene-/PNG-/PDF-/Leerordnerkopien, neue Identitäten, Links, Metadaten, Bytes, Zielcaches, historische Wiederholung, reiner Status, fehlender Recover, Gate-OFF-Status, B1-COMMIT mit verlorenem ACK, echte erneuerte SID B, belegter benutzergewählter Zielname, nach Preview belegtes Ziel sowie verlorene Prelude-COMMIT-/Close-Bestätigung und tatsächlicher Rechteentzug bestehen. Die Gegenfälle erhalten Domänenzeilen einschließlich `xmin`, Dateien/Identitäten, Stage und Ereignisse entsprechend dem jeweiligen Vertrag. Kein AuthInfo-, Autoritäts-, Ownerresultat- oder Eventpublisher-Ersatz.

Principal9 erhält Policy-/Lifetime-/Default-OFF-Grenzen; dessen frühere No-Handler-Assertion ist gezielt an die nun echte Registrierung und strikte Invalid-Request-Antwort angepasst. Die sechs bestehenden Ansichtsgruppen prüfen den gemeinsamen Web-/PI-Service über echte Web-Requests einschließlich B2-Rollback, verlorener B2-Bestätigung und historischer Finalisierung erneut; ihre Ereigniszustellung ist dort beobachtet. Die echte FileWatcher-Subscription wird separat durch Dispatcher6 belegt. Ein eigener PI-Invocation-Lauf wird damit nicht behauptet. Das sind keine TCP-, Zustimmung/OAuth-Login-, SDK- oder UI-Prüfungen.

Gezieltes cachefreies TypeScript besteht auf allen 13 finalen Code-/Testquellen; Scoped-Lint der Produktintegration bestand zuvor und das geänderte Fixture/Runner-Lint erneut. Die korrigierte Settingsfolge besteht mit verfügbarer, standardmäßig weiterhin ausgeschalteter Copyfähigkeit. Unabhängige lesende Reviews von Dienst, Wirevertrag, Fixturekorrektur und öffentlicher Dokumentation fanden keinen konkreten Blocker. Der vollständige Produktbuild und die gemeinsame Browserfolge wurden für diesen Schritt nicht wiederholt.

## Erhaltene negative Befunde und offene Legacygrenze

Der erste Settingslauf stoppte an einer veralteten erwarteten Verfügbarkeitsliste; nur diese Erwartung wurde ergänzt. Der ursprüngliche registrierte Dispatcherlauf unter `/private/tmp/canvas-mcp-copy-tool-admission-a9yqagh5/` endete mit Exit 1 nach drei bestandenen Gruppen in Familie vier. Sein konkreter öffentlicher Fehlercode wurde nicht gespeichert. Dieser Originallauf, seine Logs/Quellen und sein eigener erfolgreicher Ressourcenabschluss bleiben unverändert erhalten.

Der Quellenreview bestätigt einen ungeeigneten Kollisionsaufbau: roh geschriebene `custom.md`, `race.md` und `race (1).md` hatten keine native Bindung. Der Collector markiert bei physischem Markdown die Observation `requires-import-and-rebinding`; der native Managed-Plan akzeptiert diesen Bestand nicht. Der korrigierte Test initialisiert alle drei Dateien über den echten authentifizierten `persistPristineOriginalWorkspaceFileForWrite`, prüft Quellehash, Registry, native Persistenz und Originalbytes; sämtliche Kollision-/Recovery-/Identitäts-/Erhaltungsassertions bleiben bestehen. Der neue Lauf besteht auf diesen finalen Quellen. Das belegt keinen konkreten ursprünglichen öffentlichen Code und keine Reparatur eines Produkt-Kollisionsfehlers.

**Offen bleibt der zentrale Import-/Rebindingpfad für tatsächliche Legacy-/rohe Markdownbestände.** Bereits nicht initialisiertes Markdown außerhalb der Auswahl im geprüften Quell-/Zielgraphen kann die native Copyaktion blockieren. Eine gültige native Testfixture schließt diese Produktlücke ausdrücklich nicht. Pure Reads, Preview und Status dürfen keine Quellmigration auslösen; eine Copyquelle mit nur READ bleibt unverändert. Ein eigener zentraler Vertrag muss geprüfte Originalbytes/Dateiversion, Identität/Lifecycle, tatsächliche Rechte, Operations-ID, neue native Zielidentität und Linkbelege verbinden. Gemischter Bestand, Kollisionen, Rechteentzug, verlorene Bestätigungen und Wiederaufnahme derselben Operation gehören zur noch offenen Abnahme. Kein roher Markdown-Fallback.

## Gebundene Quellen, öffentliche Doku und Ressourcenabschluss

Ausgangsstände: Root `2e26607b0224f6db12e85965f3d357f485465f41`, QA `8c4da1838f217ee7452ca33d37d40838b717849c`, einschließlich frisch integriertem main `1506927038b80036749266a56fb769dcb6e6d18c`. Finaler Quellen-/Testordner: `/private/tmp/canvas-mcp-copy-tool-admission-v2-mtckjvfj/`. Alle 13 Code-/Testquellen sind in Root/QA bytegleich eingefroren; `tested-source-pins.json` und `static-checks.json` binden Originale.

| Code-/Testquelle | SHA-256 |
| --- | --- |
| `app/lib/files/workspace-file-operation-service.ts` | `d6618337308a0d5ee620b508295f5aab8a94023ffe09072b596c89d40f2af86a` |
| `app/lib/mcp/server/workspace-copy-tool-contract.ts` | `e251d46455f2818e14b9b5fafe3d39e6c7fc0fd0a1bb7a1fac64c643ac0f239c` |
| `app/lib/mcp/server/workspace-tools.ts` | `b94e6a6604dd932121a1037f1576d9237afd51acae75808a4b947f1b9f2562e5` |
| `app/lib/mcp/server/direct-server.ts` | `2ff45c5ee626263887796603598cfe6d535ac6aad7b7900e65c9c0fff7d535b1` |
| `app/lib/mcp/server/settings-status.ts` | `c183048f2f6891b7351016c84d644cc12917d2e00bd48c46aa4322c8b9f73a25` |
| `app/lib/mcp/server/config.ts` | `281d54a166d603604c77bc302cc06db6dc89c6412ffd72105c5102351f409489` |
| `messages/en.json` | `6894652ac885a1d19929bb106e7fd4d52175674bf3db93150e5a57e81e98b217` |
| `messages/de.json` | `8e8a28f407029d58cf7f532d15cc0b4f165ce16886ad84b7417b5be8536f15a3` |
| `scripts/mcp-server-workspace-copy-contract-test.ts` | `a7846265aab899900e5ee296236e39f51e16454980f0090b31bbfa496f285dd1` |
| `scripts/direct-mcp-workspace-copy-tool-postgres-test.ts` | `8c83b816389c8d788299f8cee7e92bc4f1e1f740e526ee6d70a4834f34fd084a` |
| `scripts/mcp-server-settings-test.ts` | `31188c89cd6adb2378539442ea990831623e05be1445c19d5e8c60778ec5668b` |
| `scripts/direct-mcp-workspace-copy-principal-postgres-test.ts` | `a77dcd772b278371ae6596ec73f126037ff059d04eb537acee9e8e797e089e15` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `57c7681216e35d76a4da48d8e3b1ead085651476e7ae6e0cc14f17a5782451c5` |

| Originallog | Ende UTC | SHA-256 |
| --- | --- | --- |
| `mcp-server-workspace-copy-contract-test.log` | `2026-10-19T04:30:09.036Z` | `d841a72cadf274294b4cc084bf9759db982d1476761947a0256efdeb6e129b5a` |
| `direct-mcp-workspace-copy-tool-postgres-test.log` | `2026-10-19T04:31:23.688Z` | `7593f6703028fa6e58e6ac3fb238b3939e64a485430ea71925e3311df48d5fac` |
| `direct-mcp-workspace-copy-principal-postgres-test.log` | `2026-10-19T04:31:41.345Z` | `c1684cd97aa688e06768d40f6f52252e5ae748a130c4acfb5d13f730a6c3cf8c` |
| `workspace-operation-native-copy-views-postgres-test.log` | `2026-10-19T04:32:26.729Z` | `06fce242c8b5143e32cff0999a14ded1bbf04fa43d405bc8831660004eadc1a2` |

Der frische unabhängige RO/RR-Abschluss `resources-after.json` bestätigt null eigene Fixture-Schemas/Backends, drei entfernte eigene DATA-Wurzeln, sieben beendete bekannte PIDs, dieselben vier gesunden Dienste und drei HTTP-200-Gesundheitsantworten. Er prüft tatsächliche Originallog-/Quellhashes. Dies ist keine Behauptung über unbeobachtete Prozesshistorie.

`detect_changes` prüft vor Commit in beiden Worktrees den erwarteten Umfang von 18 Dateien mit LOW. Einige veraltete Index-Hunkzuordnungen zeigen unveränderte Konstanten beziehungsweise `rebuildPlan`; der zusätzliche tatsächliche TypeScript-AST-Vergleich bestätigt unveränderte Laufzeitdeklarationen. Neue noch unindexierte Symbole sind separat quellengeprüft; eine leere Prozessliste ist kein vollständiger Abhängigkeitsnachweis.

Die kanonischen öffentlichen MDX-Seiten beschreiben den tatsächlichen Entwicklungsschnitt einschließlich Rootmappings, Budgets, getrennten Status-/Recoverfällen und Legacygrenze. Sie erfinden keine SDK-Copymethode. Der unveränderte Control-Plane-Sync/Generator läuft in einer neuen privaten Ausgabe unter `public-docs/web`; 126 Seiten und alle 13 bestehenden Markdown-/Suchtests bestehen. Checkout und laufende Website bleiben unverändert. Öffentliche HTML-/Browserabnahme und Veröffentlichung stehen weiterhin aus.

Vor dem Gesamtabschluss fehlen außerdem Move/Delete-Transportanschlüsse, SDK-Dateiaktionen, interne native PI-Neuanlage/SDK-Runtime, PDF-zu-nativer-Anlage, Standard-Skill, breitere Suche, restliche Sandboxlaufwege und die gemeinsame Build-/E2E-Abnahme. Dateiaktions-Undo und Review Center bleiben aus. Das normale native Aktivierungsgate bleibt aus; kein Push, PR oder Deployment durch diesen Schritt.

## Fortsetzung: frischer Build und tatsächlicher OAuth-/Browseranschluss 8/8

Auf Root `774d62d842460642818ddcfc51df60323a540234` / QA `db447529a57dbed509d333d91ead524a6a7c202a` besteht der frische Originalproduktionsbuild nach **739,032 Sekunden** mit Exit 0. Der unabhängige Artefaktabgleich bestätigt denselben eingefrorenen Quellstand, Build und nativen FD-Baustein. Neuer Testquellhash: `cdeb9458b49a1e3ce25257999997c9ba939dfcabc188d3e3ef59727b792fef8e`. Die sieben ursprünglichen Testkörper sind durch tatsächlichen AST-Textvergleich bytegleich erhalten; ein achter Fall ist ergänzt. Der erste gezielte Typcheck mit fünf Testdiagnosen bleibt erhalten. Nach korrekter Behandlung der Browserantwort und expliziten Sitzungstypen bestehen finale gezielte Typprüfung und Lint; weder Timeout noch Supervisor oder vorhandene Fälle wurden gelockert.

Die originale kompilierte Browserfolge besteht **8 deklariert / 8 bestanden**, null Fehler, Skips, Timeouts und Unterbrechungen. Die ursprünglichen sieben Create-/HTTPS-Import-/Sessionrenewal-/MCP-/REST-/SDK-/Editorfälle und der neue öffentliche Copyfall laufen gemeinsam. Die SDKfälle benutzen weiterhin das unveränderte installierte v4-Wheel; daraus folgt keine SDK-Copymethode.

Der neue Fall belegt über die tatsächliche sichtbare Settingsseite: Copy ist in der gespeicherten Ausgangsauswahl aus, wird per Schalter und Save ausdrücklich aktiviert und bleibt nach Reload aktiviert. Vorher fehlt die Fähigkeit in `tools/list`, danach wird der tatsächliche Vier-Aktionen-Vertrag angeboten. Dies ist keine eigene Upgrade-/Migrations-Defaultprobe; die getrennten Konfigurationsprüfungen bleiben dafür maßgeblich.

Zwei echte persönliche Workspaces werden mit bestätigter nativer Starterinitialisierung erstellt und derselben echten OAuthverbindung ausdrücklich freigegeben. Quelle und belegtes Ziel entstehen über native MCP-Create, nicht über rohe Markdownbytes. Beide Workspaces gehören dem Testbenutzer und sind schreibbar; ein kompilierter READ-only-Quellberechtigungsfall wird nicht behauptet. Preview löst den benutzergewählten belegten Zielnamen einmal auf; Apply behält Caller-ID, Plan und das exakte Ziel `custom-target (1).md` mit false-Mutationsflag. Die bereits geöffnete Ziel-Dateiliste zeigt den neuen Eintrag ohne manuelles Reload. Eine echte Sessionantwort liefert die Ziel-ID; vollständiger nativer MCP-Read und Original-Copyreceipt bestätigen dieselbe neue ID, Lineage, Quell-ID und den aufgelösten Pfad. Dadurch kann eine erst beim Öffnen entstandene Identität einen fehlenden Copybirth nicht kaschieren.

Tatsächliches Sign-out verwirft die frühere Sitzung, deren unveränderter Token HTTP 401 erhält. Neue Anmeldung und echter Consent mit derselben Registrierung sowie frische Quell-/Zielfreigaben ermöglichen Status, bestehenden abgeschlossenen Recover und identischen Apply-Retry. Journal-/Receiptzeilen samt `xmin` und ursprünglicher A-Attribution bleiben identisch. Der unterbrochene B1-/B2-Recoveryfall bleibt der separat tatsächlich ausgeführte PG-/Dispatcher-/Ansichtsnachweis; der neue Browserfall beweist ausdrücklich abgeschlossene historische Wiederaufnahme. True-Mutationsflag und unbekannter Recover werden abgewiesen, für letzteren entstehen weder Auftrag, Receipt noch Zieldokument. Quelle und zuvor belegtes Ziel behalten ihre vollständigen nativen Versionen und Inhalte.

Der Zieltext ist im direkt editierbaren Editor sichtbar, ohne Read/Edit-Auswahl, und bleibt nach Reload gleich dem vollständigen nativen JSON. Root hat beide tatsächlichen sicheren Screenshots angesehen: Copy-Schalter und Beschreibung sind sichtbar; der Editor zeigt `Public Copy`, den kopierten Text und den unveränderten Schlussabsatz. Der numerische Settingscheck bestätigt keinen horizontalen Overflow; die regulär vertikal scrollende Einstellungsseite wird dadurch nicht zur vollständig auf einen Bildschirm passenden Ansicht erklärt.

Originalruntime PID 75012, Baseline, unabhängiger Postcheck und Queue enden jeweils mit Exit 0. Alle **14/14** Abschlussprüfungen bestehen: eigene Datenbanken samt OIDs/Backends, DATA, TMP, Runtime-Lock, beobachtete Prozesse/Gruppen/Ports sind geschlossen; vier verwaltete Dienste behalten ihre Identitäten und gesunden Zustand, drei Gesundheitsantworten sind HTTP 200. Roots zusätzliche Stichprobenunion bestätigt 19 tatsächlich beobachtete Build-/Runtimeidentitäten und acht leere Gruppen; sie behauptet keinen vollständigen Verlauf kurzlebiger Prozesse.

Originale liegen unter `/private/tmp/canvas-mcp-copy-controller8-tHE1G83I/`; der tatsächliche Runtimefixture ist `canvas-yjs-authority-Eiku6F`. Frühere rote Ergebnisse und ihre Abschlussberichte bleiben unverändert.

| Originalbericht | SHA-256 |
| --- | --- |
| `source-report.json` | `edcdeb0433c895dec5fee65b801e8d0e0b4193d97340432ea8eef2aca089b1cd` |
| `build-terminal.json` | `4f62464bb05105bbfb6afb697739b634127313bffe8369e6916b9e288c5d1f11` |
| `artifact-report.json` | `439c0544c83d8863e7eafb325583a4b392a2e41355da56d8a3adf3b097c27a7a` |
| `runtime-terminal.json` | `60a69c30d1408195cf4841ff19cb584cee21dc3231f1c3d733dd6bc1f173554c` |
| `postruntime-report.json` | `04bd5f5009d961b4c4c1d804a87d871af370b2165a885248bd33d11f623656b7` |
| `queue-terminal.json` | `39a4f4d613cc74a4458f4821d333e8be1342806e722c9d10335e1373bfce4471` |
| `root-sampled-union-closure.json` | `71acfc341ab3647774ca263af3b99d7988d4f15d3b25730c95bf8553facbe146` |

Der öffentliche Copyanschluss ist damit für den beschriebenen nativen Schnitt lokal kompiliert und tatsächlich geprüft. Legacy-/rohes Markdown, SDK-Dateiaktionen, Move/Delete-Transportanschlüsse, interne PI-Neuanlage/Runtimeadapter, PDF, Standard-Skill, breitere Suche, restliche Sandboxwege und die gemeinsame Gesamtabnahme bleiben offen. Normales Aktivierungsgate, Dateiaktions-Undo und Review Center bleiben aus; keine Veröffentlichung oder Produktionsfreigabe.
