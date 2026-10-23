# Native Dokumente über registrierte MCP- und Agentenwerkzeuge lesen

Stand: 17. Oktober 2026. Dieser Schnitt schließt den Leseanschluss der tatsächlichen Werkzeuge an den [zentralen ID-Lesedienst](./yjs-document-read-service-evidence.md). Der Gesamtauftrag bleibt offen. Gemeinsame Suche, Create-/Import-/Edit-Verträge, externes SDK, regulärer Standard-Skill, nativer PDF-Import, übrige Sandbox-/Mobilewege und die abschließende gemeinsame E2E-Abnahme folgen separat.

## Anschluss und öffentlicher Vertrag

`read_knowledge_source` besitzt zusätzlich zum erhaltenen Pfadread einen nativen ID-Zweig mit `workspace_id`, `document_id`, `format`, `expected_version`, `max_bytes` und `cursor`. Die strenge Auswahl verhindert Mischungen mit Legacy-Pfad und Zeichenoffsets. Die neue `oneOf`-Beschreibung veröffentlicht den vollständigen nativen Seitenvertrag, den tatsächlichen alten Ergebnisvertrag und geschlossene öffentliche Dokumentfehler. Native IDs oder frühere Cursor ersetzen keine aktuelle Token-/Workspaceberechtigung. Hiddenpaths bleiben auch nach ID-Auflösung gesperrt.

Der Zweig verwendet `readDocumentForDirectMcp` mit dem echten eingehenden Token und aktueller `knowledge:read`-Berechtigung. Der zusätzliche vorhandene Workspacezugriff liefert echte Auditidentität. Erfolgreiche Seiten sind vollständig und identisch in JSON-Text und `structuredContent`; native Versionen werden nicht als Legacy-Datei-SHA ausgegeben. Der alte Pfadreader bleibt erhalten.

Das neue interne Agentenwerkzeug `read_document` verwendet ausschließlich `readDocumentForAgentTool` aus der tatsächlichen Werkzeuginvocation. Es ist im PI-Registrykern, dem Datei-Toolset und der Planning-Lesefreigabe registriert. Agenten-/Provider-Einstellungen filtern es weiterhin. Der vorhandene `read`-Pfad und der Runtimewrapper bleiben erhalten.

PI-Fragmente haben ein echtes Decoderlimit von 4–1024 UTF-8-Bytes, Standard 1024. Zusätzlich werden beide serialisierten Seitenausgaben gegen das tatsächliche 12.000-Zeichen-Budget geprüft. Bei Überschreitung entsteht ein kleines `DOCUMENT_READ_OUTPUT_BUDGET_EXCEEDED` mit `safeToAutoRetry:false`, ohne Fragment, Cursor oder vermeintliches Vollständigkeitsflag. Es gibt keine abgeschnittene Seite als Erfolg. Native JSON-Teile werden vor dem Parsen vollständig zusammengesetzt. Nicht verlustfrei als Markdown exportierbares Rich bleibt über native Struktur und semantischen Text lesbar.

Der bestehende Wrapper behält seine Fehlerpriorität: Ein im tatsächlichen Principal-/Serviceaufruf gespeicherter Fehler wird außen weiterhin geworfen, auch wenn der innere Formatierer ihn in ein Ergebnis umwandelt. Die Integration prüft diese echten öffentlichen Rejections; reine Formatierertests sind kein Beweis dafür, dass jeder gewrappte Fehler ein `isError`-DTO liefert. Ein erst nach erfolgreichem Dienstread entstehender Ausgabebudgetfehler bleibt als kleines Fehlerergebnis erreichbar.

## Tatsächlicher positiver Schnitt

Ausgangs-HEAD: Root `7a3cc66ab6650d7fe2f716a23bdaa9827e80f21c` plus die gebundenen, damals noch nicht committeten Adapter-/Testquellen. Der Originallauf liegt unter `/private/tmp/canvas-document-tool-integration-esm6-waam4r0x`.

- Ganze Runnerqueue, echte Testausführung und unabhängiger Ressourcenpostcheck enden mit Exit 0.
- Alle **15/15 deklarierte fachliche Fallgruppen** bestehen. Exakter Finalmarker: `groups:15`, `passed:true`, `actualRegisteredWebMcpTransport:true`, `actualPiRegistryWrapper:true`, `tcpOrCompiledOAuthE2e:false`.
- Der unveränderte Test läuft als ein echtes ESM-Bundle des gesamten Repositorygraphen: 1022 tatsächliche Inputs, kein gesplitteter DB-/Principal-/Invocationgraph. Externe import-only-PI-Pakete bleiben tatsächlich ESM. Ursprüngliche Next-Dateien und 22 echte CJS-Paketeinstiege werden gezielt aufgelöst; kleine CommonJS-Fassaden erhalten die ursprüngliche Default-Interop und dieselben installierten Yjs-/TipTap-/ProseMirror-Konstruktoren. Es gibt keine Auth-, SQL-, Dienst- oder Werkzeugergebnismocks und keine Diagnoseinstrumentierung in diesem positiven Bundle.
- Bundle-SHA-256: `b71c54970cade33acb8b357836febd877329df29863b7ab117b79f989922d0e7`.
- Quellenfingerprint: `dd92021b43eb7fca5d5b9eb132ddc9439e46adcae3548bac120c94e63566ff47` über 6950 gebundene Dateien, vor/nach jedem tatsächlichen Schritt identisch.
- `binding.json`: `11781e172f8349b5f227844729ab5ea857fe5f713953677c01422bff09e2c722`.
- `bundle-proof.json`: `d6a2f7f106074040caca552fe76385209158aee2662140cd032b215ed5d68cbf`.
- Originaltestlog: `c85e4e5c425e870ccbe66c2e386cb79627fca377dbeca7f35487e9f0625aa31b`.
- Unabhängiger Ressourcenpostcheck: `3c7924d75eff2a7359799e5833be3e2e566fc240fdb5bbea5068c0a203aa1b9c`.

### Reproduzierbarer Repositoryaufruf und finaler Abschluss

Der neue Aufruf `npm run test:documents:read:tools` verwendet `scripts/run-document-read-tool-dispatch-test.mjs` mit einem einzigen echten ESM-Quellgraphen. Er setzt nur die tatsächliche `react-server`-Bedingung, erhält CJS-Konstruktoridentität und private Principal-/DB-/Invocationmodule, prüft sieben kritische Originalquellen jeweils genau einmal, schließt den esbuild-Prozess vor dem Test und entfernt danach nur sein anhand Device/Inode/UID/Realpath geprüftes eigenes Bundle samt eigenem Modulsymlink. Die benötigte bereits vorhandene esbuild-Version `0.28.2` ist jetzt ausdrücklich als Devabhängigkeit samt Root-Lockfileeintrag deklariert; bestehende aufgelöste Pakete wurden nicht aktualisiert. Der Compiler zielt auf Node22; die tatsächliche Ausführung dieses Nachweises verwendet den installierten Node26. Das ist kein eigener Node22-Laufzeitnachweis.

Die finale Originalqueue `/private/tmp/canvas-document-tool-integration-final-76z6xkwp` besteht tatsächlich mit Exit 0: cachefreies vollständiges TypeScript mit acht GiB Budget, Scoped-ESLint für alle 13 Code-/Test-/Runnerdateien ohne Warnungen und genau der neue npm-Aufruf mit **15/15**. Alle drei Schritte vergleichen Root, QA und Control Plane vor/nach der Ausführung; die ursprünglichen Quellen bleiben jeweils identisch. Das neue Bundle umfasst wieder 1022 echte Inputs; SHA-256 `6a6b4bca0fdb1697d48c45d65d41f686593fe6d5acfea429e94b1fcb3372392b`.

- Rootfingerprint: `27ae1e6d144eb8bd097e203f962d2540b37454eec91d252f5dd7d32522fbc5b4`, 6952 Dateien.
- QAfingerprint: `8862865bdbc0e7346e1065e2beba921c1c7ef6a70333d115b98795702fae0c81`, 6952 Dateien.
- CP-Fingerprint: `a9658619447ed090716b84ac5ccca4489fb7e1ace6888327a077fab1ef9765e9`, 952 Dateien.
- Finales `binding.json`: `0a2115adc8b2d9444bea8418e831cb44d7dd46987226e5e5482aee5e47968ee2`.
- Originaler npm-Testlog: `19efbaba37935da3d50606bc457b456c953f768ef59aa07ba8dd0886f36a1595`.
- `actual-results.json`: `641fc4235bb387dfe0c70ad1122121eac21e32ec9feb8f13f8e7db6ce8143a20`.
- `terminal.json`: `1839e30870ba4a09a464fe7811b7b89dc1ab02afd2101f0e453886750f40ae7a`.
- Separater unabhängiger Ressourcenpostcheck mit tatsächlichem Exit 0: `8e15cb411541dad905d0b01e5e9932910822a97088efc901a118bc5b65c44469`.

Der Originaltest bestätigt erneut die vollständigen Fixtureabschlüsse und `fetches:0`; der Repositoryrunner bestätigt zusätzlich `removed:true` für sein eigenes Bundleverzeichnis. Der unabhängige Postcheck erfasst auch dessen Verzeichnisnamensfamilie und erhält dieselbe Baseline sowie dieselben vier gesunden verwalteten Container. Die genaue Reichweite des Ressourcenchecks bleibt wie unten beschrieben begrenzt. Die ursprünglichen Positiv- und Fehlbelege werden nicht auf einen späteren Dokumentations-/Commit-HEAD umetikettiert.

Gebundene Codequellen (SHA-256):

| Datei | SHA-256 |
| --- | --- |
| `app/lib/documents/read-json-schema.ts` | `92cea5e12e4ba4b0cfbba3fbd71a162cf8d7ed31b2977da0a356aab11cf11c12` |
| `app/lib/mcp/server/document-read-tool-contract.ts` | `9fcfa26cf4cf61ee253028840d8ab0fd3178d2b34cf02411193b293e70029177` |
| `app/lib/mcp/server/workspace-tools.ts` | `39f3c8b7bf332baddd120103ecdca78321036896ef2fd4b0d1ad2053a2227986` |
| `app/lib/pi/document-read-tool.ts` | `12edc4dd6924de0618ef94ffaee9d67a002184006e35db462cf063e0f7941b99` |
| `app/lib/pi/document-read-tool-contract.ts` | `648cc6b8beb4f4cb4ade4ef07e4751125511a25b38aca9c23f30ad4e0482d909` |
| `app/lib/pi/core-tools.ts` | `fdbd533ff65f4a0042825510512851e4765a75406350eddbb578e927b8c92f03` |
| `app/lib/pi/toolsets.ts` | `7e4a1e3b5bfd9fb92630da6470e6cad227eb1ca094e352795cd9c8f633ae1880` |
| `app/lib/pi/planning-mode.ts` | `77e7bfda2ad0049ae3b45b6038a0b0323a9f174ff8cb111e73ba534f56233e82` |
| `scripts/mcp-document-read-tool-contract-test.ts` | `28e449d4d5f36c19aa800fc4fbff91251eb0ae4205a0c31b2b17fc5321cc6eed` |
| `scripts/pi-document-read-tool-test.ts` | `ef03475c379b4c22dbbc894610837c41a3f6e37223ba0c7826eef3be59135dd1` |
| `scripts/helpers/document-read-tool-dispatch-fixture.ts` | `d659f090cc8dcba9829bc98c923680e422cfd369a727ecd8eaae4ef03eca4723` |
| `scripts/document-read-tool-dispatch-postgres-test.ts` | `d0e3b230b4b2d71192486adc78e01566abe0a275dbf81ef8b8ceb3e228158232` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `c78d49342fa0b1378e090129e252a3702c638374651be324a04a07875aec2ce6` |


Nach der finalen Abnahme wurde ausschließlich eine zusätzliche Leerzeile am Ende von `document-read-tool-contract.ts` entfernt, damit der Git-Whitespacecheck besteht. Getesteter Originalhash `9fcfa26cf4cf61ee253028840d8ab0fd3178d2b34cf02411193b293e70029177`, normalisierter Dateihash `7772235acbd77921885c2ab0d6838952732d5cc7236e0ebf3738575cd8614a81`; alle übrigen Bytes sind identisch. Die oben gebundenen Originalnachweise bleiben unverändert.

## Was die 15 Gruppen tatsächlich prüfen

1. Echte MCP-Initialisierung und registrierte `tools/list` mit nativer/alter Eingabe sowie vollständigen drei Ausgabealternativen.
2. Registrierte MCP-ID-Reads für Plain und XML ohne physische Markdownprojektion, vollständige native/semantische Inhalte und echte Versions-/Persistenzangaben.
3. Gültige nicht exportierbare Blocktabellen einschließlich `colwidth`; native Struktur und Text funktionieren, explizites Markdown erhält den öffentlichen Formatfehler.
4. Fünf echte Unicode-Fortsetzungen für `A😀B🧪C`: insgesamt elf UTF-8-Bytes, Offsets 0/1/5/6/10 und unveränderte volle Version.
5. Abgewiesene gemischte Selektoren, unbekannte/versteckte IDs, fremder Workspace und ungültiges Budget ohne Dokumentseite.
6. Fehlendes Token als Toolchallenge und tatsächlich ungültiges Token als vorgeschaltetes HTTP401 mit Authchallenge.
7. Ein echtes nur für Suche ausgestelltes Token kann das bestehende Suchwerkzeug aufrufen, erhält dadurch aber keinen nativen Readgrant.
8. Serverweit deaktiviertes Werkzeug fehlt in `tools/list` und wird als MethodNotFound abgewiesen.
9. Zwischen Calls tatsächlich entfernter Workspacegrant verhindert die nächste native Seite.
10. Echte PI-Registry und vorhandener Wrapper, fehlende nackte Invocation sowie aktuelle explizite Agenten-/Provider-Werkzeugfilter.
11. Vollständige PI-Reads für Plain/XML/Blocks und Native-only-Pfade; echte große Metadatenhülle führt nach erfolgreichem Dienstread zum kleinen Budgetfehler, ohne Auszug oder gespeichertes Outputartefakt.
12. PI-Unicode-Fortsetzung, strenge Eingabe und Versionskonflikt; auch derselbe MCP-Konflikt liefert keine erfundene Fortsetzung.
13. Ein bereits gehaltener echter PI-Wrapper verliert bei nachträglich archivierter persistierter Sitzung seine Freigabe.
14. Aktueller Rechte-/Seatentzug sperrt PI und den nächsten MCP-Aufruf; native Bytes und Nachbarn bleiben erhalten.
15. Erhaltener Legacy-Pfadread mit exakt ursprünglichen Bytes/SHA und Dateisystemidentität sowie vollständiger Prüfung unveränderter nativer Inhalte/IDs, Revisionen, Projektionen und Nachbarn.

Die neuen nativen ID-Reads vergleichen vor/nach den geprüften Readfolgen vollständige Dokument-/Lineage-/Yjs-/Metadaten-/Revisions-/Projektionszeilen einschließlich `xmin`. Gezielte Fixtureänderungen an Grants, Sitzungen und Titeln sind ausdrücklich vorbereitende Testaktionen. Nur die Legacygruppe berücksichtigt dessen bereits vorhandene unbedingte Lineage-Upserts und `document.updated_at`: ausschließlich beim exakten eigenen Ziel werden dessen Zeit-/`xmin`-Buchungsfelder verglichen-normalisiert. Alle übrigen Felder, Yjs-Bytes und Nachbar-`xmin` bleiben im strengen Gesamtvergleich. Dies ist keine Aussage, dass der alte Pfadreader keine Verwaltungswrites ausführt.

## Reale Autorität und bewusste Abnahmegrenzen

Der MCP-Test ruft den echten `handleDirectMcpPost(Request)` und darüber den registrierten Server, SDK-Protokolltransport, echte Better-Auth-JWT-Ausstellung/-Verifikation, aktuelle SQL-Grants und den eigentlichen Lesedienst auf. Eröffnet werden keine TCP-Server. Lizenz, Seats, OAuthclient/-consent und Grants sind ausdrücklich lokal signierte beziehungsweise gespeicherte Testdaten in einem eigenen PG18-Schema, keine echte Control-Plane-Ausstellung und kein erfolgreich durchlaufener Browser-PKCE-Flow.

Der PI-Test benutzt tatsächlich `getPiTools` und dessen vorhandenen Runtimewrapper. Seine gespeicherte echte PI-Sitzung löst den Workspace selbst auf; ein fertiger ExecutionContext oder eine erfundene Invocation wird nicht eingespeist. Das ist keine vollständige Live-Chatturn-Abnahme mit tatsächlicher `agentTurnId`; diese bleibt Bestandteil der gemeinsamen späteren E2E-Folge.

Die Fixture schließt ihren eigenen Pool und ihre Clients, prüft Schema/OID/Owner/Marker vor DROP sowie das eigene DATA-Verzeichnis nach Device/Inode/UID/Realpath. Der unabhängige Postcheck bestätigt denselben erfassten Schema-/DATA-Namensbestand wie vorher, keine eigenen Anwendungsbackends und identische vier gesunde verwaltete Container. Er ist kein vollständiger Dateisysteminhalts-/Inode- oder Prozesshistorienbeweis. Der abschließende Fixturemarker bestätigt `schemaRemoved:true`, `clientsClosed:true`, `dataRemoved:true`, `fetches:0`, `tcpServersCreated:0`.

## Reine Tests und ursprüngliche Fehlversuche

Die unveränderten reinen Adapterprogramme bestehen: MCP14/14 und PI13. Bestehende MCP-Suche3/3, Workspacepolicy, Planning-Regression und große PI-Registryregression bestehen auf denselben Produktquellen. Die erste anschließende Typprüfung fand vier optionale Diagnose-Strings nur im neuen Test; deren enge Korrektur besteht danach vollständiges cachefreies TypeScript und Lint. Die abschließende cachefreie Typ-/Lintprüfung nach allen reinen Testdiagnosen, Fixturekorrekturen und dem neuen Repositoryrunner besteht ebenfalls, siehe finalen Originalabschluss oben.

Die tatsächlichen roten Originale bleiben unverändert erhalten; für jeden folgenden Lauf liegt ein eigener erfolgreicher unabhängiger Ressourcenabschluss vor:

| Privates Originalverzeichnis unter `/private/tmp` | Tatsächliches Ergebnis / eingegrenzte Ursache |
| --- | --- |
| `canvas-document-tool-integration-quality2-ck7edj9t` | Typprüfung/Lint 0; Dispatcher vor Fällen RED durch import-only-Paket im TSX/CJS-Ladeweg. |
| `canvas-document-tool-integration-package-probe-woupu6y_` | Bestätigt tatsächliches `pi-ai/compat` ohne `require`-Export; 0/15. |
| `canvas-document-tool-integration-import-condition-knlvhrg5` | Globale Importbedingung wählt für internen PG-Require den ESM-Pool; Start scheitert, 0/15. |
| `canvas-document-tool-integration-esm-zwjk011z` / `canvas-document-tool-integration-esm2-zrlz6_8r` | ESM-Graph lädt; TipTap-CJS-Default wurde zuerst als Modulobjekt importiert. Sichere Stackdiagnose bestätigt Bild-Erweiterung; 0/15. |
| `canvas-document-tool-integration-esm3-8hocoqoq` / `canvas-document-tool-integration-esm4-gymfbtm2` | Reale Initialisierung/Werkzeugliste bestehen, erster Read scheitert nach zentralem Dienstread an zusätzlicher Workspaceprüfung; 1/15. |
| `canvas-document-tool-dispatch-cause-909kz0l2` | Privater Diagnosebundleaufbau findet umbenannten Zielbezeichner nicht; kein Dispatcher gestartet. |
| `canvas-document-tool-dispatch-cause2-v89szemn` / `canvas-document-tool-dispatch-cause3-li81al08` | Ausschließlich Diagnoseinstrumentierung, ausdrücklich kein positiver Produktnachweis. Zweite Fehlerspur korrigiert den Catchbezeichner und bindet den unbekannten Fehler an `readableWorkspace`. |
| `canvas-document-tool-integration-esm5-w9j5_jai` | Vollständige signierte Team-Laufzeitclaims und tatsächlicher positiver Lizenz-/Workspace-Setupcheck; alle 14 nativen/Agentenfamilien bestehen. Nur die falsche Legacy-No-DML-Annahme scheitert; 14/15. |

Die neue Testlizenz hatte zuvor nur Team-Edition, aber keine für das alte Workspace-Listing erforderlichen Laufzeitcapabilities/-provider. Die Korrektur verwendet den vorhandenen vollständigen Team-Testlizenzvertrag und prüft den echten Teamlizenzguard bereits im Setup. Das tatsächliche Workspace-Listing/Bootstrap läuft danach vor den Dokument-Snapshots. Es wird kein Auth-/Lizenzdienst ersetzt.

Zwei weitere neue Testaufbaukorrekturen erhalten die fachliche Matrix: vorgeschaltetes HTTP401 wird anhand seines echten `{error,message}`-Vertrags statt als JSON-RPC-Envelope geprüft; der alte Legacy-Read erhält einen konsistent initialisierten Dokumentbestand und seine ausdrücklich dokumentierten eigenen Bookkeeping-Ausnahmen. Die 14 neuen nativen/Agentenfälle behalten ihre strengen No-DML-Assertions.

## Weitere Arbeit

Die Adapter sind ein abgeschlossener fachlicher Leseschnitt, keine vollständige gemeinsame Dokument-API. Suche mit Ranking/IDs/Coverage/Fortsetzung, Create-/Import-/Edit-Anschlüsse, externes HTTP-Python-SDK, tatsächliche Standard-Skill-Auslieferung, nativer PDF-/Herkunftsanschluss und restliche Sandbox-/Mobilewege bleiben erforderlich. Danach folgen aktuelles main, neuer gemeinsamer Originalbuild und vollständige End-to-End-Abnahme. Allgemeine Aktivierung und Produktionsrollout sind weiterhin nicht erfolgt. Dateiaktions-Undo bleibt für alle Dateitypen und historischen Jobs aus; Review Center bleibt aus und außerhalb des Auftrags.
