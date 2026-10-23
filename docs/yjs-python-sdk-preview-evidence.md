# Python-SDK und öffentliche Entwicklerdokumentation: erster lokaler Anschluss

**Aktueller Nachtrag, 18. Oktober 2026:** Der tatsächliche installierte SDK-OAuth-/Dokument-/Editorlauf besteht inzwischen mit 7/7 und allen 14 Abschlussprüfungen. Die separate echte macOS-Keyring-Prüfung mit Dummywerten besteht ebenfalls. Die folgenden Erstnachweise behalten ihren damaligen Umfang; aktuelle Ergebnisse, frühere Fehler und Grenzen stehen in der Fortsetzung unten.

Stand: 18. Oktober 2026. Codecommit Root `af3c03d276f21921425983541a3e6aacfbd3d51e`, QA `87388a05f5206f8b0380ace848a97a2b4548a851`.

## Ergebnis und Grenze

`packages/canvas-notebook-python/` ist ein eigenständig installierbares Paket im Notebook-Repository. Distribution `canvas-notebook-python`, Import `canvas_notebook`, eigene Entwicklungsversion `0.1.0.dev0`, Python ab 3.10 und unveränderte mitgelieferte Repositorylizenz. API, SDK, Tests und öffentliche Anleitung können gemeinsam geändert werden; die Paketversion ist unabhängig von der Notebookversion. Kein SDK-Paket wurde veröffentlicht.

Der erste Anschluss bietet Workspace-/Baumnavigation, native Suche, ID-/vollversionsgebundene paginierte Reads, Markdown-Create/Import sowie native Edits und historischen Editstatus über die tatsächlichen MCP-Tools. Der SDK-Kern besitzt keine Laufzeitabhängigkeiten. Optionale MCP-/OAuth- und OS-Keyring-Anschlüsse sind getrennt. Die öffentliche SDK-Anleitung verwendet ein tatsächlich lokal baubares Wheel; sie behauptet keinen vorhandenen PyPI-Release.

Das SDK besitzt keine eigene Yjs-, Projektions-, Link- oder Dateioperationsengine. Callerkeys, Versionen und tatsächliche Ergebnisse bleiben erhalten. Unbestätigte Transportausgänge lösen keine automatische neue Mutation aus; Pending/Conflict/Failed werden nicht zu bestätigter Dauerhaftigkeit. Die offiziellen OAuth-/Header-Protokollwiederholungen bleiben ausdrücklich von dieser Aussage getrennt.

SDK-Move/Copy/Delete, zentrale PDF-Anlage, kontrollierter Agent-Runtimeadapter, echte SDK-OAuth-Browserabnahme, OS-Keyring-Abnahme und Veröffentlichung bleiben offen. Die bestehende interne FD-Bridge ist kein externer HTTP-SDK-Nachweis. Allgemeine native Aktivierung, Dateiaktions-Undo und Review Center bleiben aus. Dieser Schritt schließt den Gesamtplan nicht ab.

## Tatsächlich ausgeführte Paket- und Quellprüfungen

Private Originalbelege: `/private/tmp/canvas-notebook-python-validation-ofbcf_2m/`.

- Wheel und Source-Distribution mit tatsächlichem `build` und `hatchling==1.29.0` gebaut; das Wheel wurde aus der Source-Distribution gebaut.
- Wheel in getrennte isolierte Basis- und MCP-Umgebungen sowie Source-Distribution in eine weitere Basisumgebung installiert. Der finale v4-Stand wurde in diesen bestehenden Testumgebungen neu installiert. Isolierte `python -I`-Imports verwenden `site-packages`, keine editierbare Installation und keinen eingeschobenen Quellpfad.
- 26/26 Unitfälle des installierten finalen Wheels bestanden; zusätzlicher Core-Import jeweils aus Basiswheel und Source-Installation bestanden. Die Basisumgebung enthält keine MCP-/HTTP-/Keyring-Abhängigkeiten.
- Strenges `mypy==1.19.1`, Sprachziel 3.10 und tatsächliche optionale Abhängigkeiten: sieben Quelldateien ohne Befund. Python-3.10-Syntax aller Pythondateien geprüft. Tatsächlicher Laufzeitnachweis ist Python 3.14.3; ein Python-3.10-Runtimelauf ist damit nicht behauptet.
- Gezieltes TypeScript einschließlich neuem HTTP-Harness und vorhandener Fixture sowie Scoped-ESLint bestanden. Es gibt hier keinen neuen vollständigen TypeScript- oder Next-Produktionsbuildnachweis.

Finales Wheel SHA-256 `a49b1910b15a915fb1059fe184c28e6db436f7c7a68418e10fe794ac8ad82b7c`, 26.342 Bytes. Es ist sowohl als `dist-v4` tatsächlich installiert und über HTTP geprüft als auch im letzten `dist-v5` bytegleich gebaut. Die finale Source-Distribution `dist-v5` besitzt SHA-256 `65727e5261219936e1469f133a5484a92ae547e92593f04854dbde8b0960d6e3`; ihre Quelldateien stimmen exakt mit dem Codecommit überein. Nach `dist-v4` wurde ausschließlich eine zusätzliche EOF-Leerzeile im Core-Importtest entfernt. Das beeinträchtigt weder die ausgeführten Funktionsprüfungen noch die bytegleiche Wheelbindung; der separat installierte Source-Nachweis gehört weiterhin `dist-v4`.

Wheelmodule und Repositorylizenz sind tatsächlich bytegleich geprüft; Archive enthalten keine absoluten Pfade, Traversalpfade oder Pythoncaches. Originale Build-/Install-/Unitprotokolle bleiben erhalten.

## Installiertes Wheel → echtes TCP → Original-MCP → PostgreSQL/Room-Owner

`scripts/python-sdk-document-postgres-test.ts` startet die vorhandene isolierte PostgreSQL-18-Fixture und einen tatsächlich gebundenen Loopbacklistener. Der optionale Fixture-Origin wird vor Backendimports durchgehend an Basis-URL, Auth, Consent und JWT-Resource gebunden. Die bisherigen Defaultwerte bleiben gleich. Der HTTP-Adapter übergibt die tatsächlichen Requests an den ursprünglichen MCP-Handler; er erzeugt weder `AuthInfo` noch Ersatzprincipals.

`scripts/helpers/python_sdk_document_probe.py` verwendet das installierte Wheel mit den wirklichen optionalen Abhängigkeiten `mcp==2.3.0`, `mcp-types==2.3.0` und `httpx2==2.13.1`. Modulpfad, installierte Distribution, tatsächliche `direct_url.json`, Wheel-URL und Archivhash werden geprüft. Fixturetokens gelangen ausschließlich über begrenztes stdin zum eigenen Pythonprozess, nicht in Argumente, ENV oder Logs. Dies sind tatsächlich signierte Testtokens mit aktuellen SQL-Grants; es ist kein Browser-OAuth-Ausstellungsnachweis.

Der finale Originalaufruf endet mit Exit 0. Fünf Familien bestehen bei 27 tatsächlichen HTTP-Requests:

1. Registrierte Tool-/Workspace-Discovery, native Suche und vollständiger UTF-8-Mehrseitenread mit stabiler ID und Suchtreffer-Vollversion; die echte Yjs-Quelle besitzt keine physische Projektion.
2. Native Markdown-Anlage und tatsächlicher Same-Key-Create-Retry mit derselben ursprünglichen Operation und Dokumentidentität.
3. Native Bearbeitung über den echten lokalen Raumowner, bestätigte Dauerhaftigkeit, neuer versionsgebundener Read, historischer Status, Same-Key-Retry und tatsächlicher Stale-Version-Konflikt.
4. Ein tatsächliches Read/Search-Token darf den Write-Editstatus nicht lesen.
5. Row-count-geprüfter Ablauf der echten Fixture-Session führt zu HTTP 401/`invalid_token` des Originalhandlers; eine beliebige Pythonexception allein zählt nicht als Beleg.

Vollständige ursprüngliche Domain-/Operations-/Payload-/Revisions-/Blobzeilen einschließlich `xmin` bleiben nach Status, Retry, Konflikt und Ablehnungen unverändert. Eigener Pythonprozess, HTTP/WSS, tatsächlicher Ownerbackend, Schema und DATA sind geschlossen beziehungsweise entfernt; externer Fixturefetch bleibt null. Der ursprüngliche v3-Lauf und der finale v4-Lauf sind getrennte erfolgreiche Protokolle, keine umgebundenen Belege.

Die bestehenden Default-Fixture-Aufrufer bestehen anschließend seriell: Read15, Search6 und native MCP-/PI-Edits8, zusammen 29 Gruppen mit bestätigtem eigenem Cleanup. Diese ergänzen den neuen Loopbackfall und ersetzen keine echten OAuth-/kompilierten Browserfälle.

## Öffentliche Dokumentationsquelle und tatsächlicher Generator

Die maßgeblichen Seiten liegen im Notebook-Repository:

- `docs/product/en/developers/document-api.mdx`
- `docs/product/en/developers/python-sdk.mdx`

Der unveränderte bestehende Control-Plane-Sync und -Generator auf `27c8ce37da082244f006ca376068cde6b98845d5` wurden mit `CANVAS_DOCS_SOURCE_DIR` auf diesen Notebook-Quellen ausgeführt. Der Arbeitsordner `/private/tmp/canvas-sdk-public-docs-validation-gwo3a805/web` hält ausschließlich die eigene erzeugte Ausgabe; der Control-Plane-Checkout und die laufende Website wurden dabei nicht geändert.

Die tatsächliche Generierung aller 126 Seiten besteht einschließlich Metadaten, Slugs/Reihenfolge und interner Links. Beide neuen Raw-MDX-Ausgaben entsprechen exakt den Seitenkörpern; beide Seiten stehen in `llms.txt`, `llms-full.txt` und im Suchindex mit zehn beziehungsweise sieben Einträgen. Alle 13 bestehenden Markdown-/Suchtests bestehen. Die vier Pythonbeispiele bestehen die Python-3.10-Syntaxprüfung; das OAuth-Quickstartbeispiel ist noch kein ausgeführter Browsernachweis.

Die vorgesehenen öffentlichen HTML-Routen sind `/docs/developers/document-api` und `/docs/developers/python-sdk`. Lokale Generierung und Indizes belegen weder eine ausgeführte HTML-/Browserabnahme noch ihre öffentliche Erreichbarkeit. Websitebuild, SDK-OAuth-Browserlauf und spätere tatsächliche Veröffentlichung bleiben getrennte Gates.

## Erhaltene negative Ergebnisse und Review

Die erste gezielte TypeScript-Prüfung des neuen Harness endete mit fünf Typfehlern: optionale eingehende URL, minimale Child-ENV ohne das deklarierte `NODE_ENV` sowie daraus folgende Childtypfehler. Explizite URL-Narrowingvariable und `NODE_ENV: test` im ansonsten minimalen Child-ENV beheben diese; der zweite Originallauf endet mit Exit 0. Der erste strenge Python-Typlauf meldete einen zu engen `dict`-Parameter für eine nur lesende TypedDict-Prüfung; die passende `Mapping`-Annotation behebt ihn ohne Laufzeitänderung. Die ursprünglichen negativen Protokolle bleiben erhalten.

Unabhängige lesende Reviews prüften SDK-Fassade und echten installierten MCP-Lifecycle, den HTTP-/PG-Harness und beide öffentlichen Seiten. Ein veralteter Satz der privaten API-Seite über noch fehlende SDK-Methoden wurde beim Übernehmen zum tatsächlichen unveröffentlichten SDK-Previewlink korrigiert. Neue Python-/Harnesssymbole sind im älteren GitNexus-Index nicht vollständig erfasst; ein dort fehlender Treffer ist kein Nullrisikonachweis. Die bestehende Fixture hatte im Rootindex sechs direkte Aufrufer; die drei gezielten Defaultfamilien sind tatsächlich geprüft. Vor Codecommit bestätigen beide `detect_changes` nur den erwarteten Fixture-/Runnerumfang; die tatsächlichen neuen Dateien und Tests werden zusätzlich im Diff geprüft.

## Fortsetzung: echter SDK-OAuth-Anschluss und Browser7 lokal bestanden

Die tatsächliche HTTP-Gegenprobe reproduziert zunächst HTTP 200 statt der
benötigten HTTP 401 für einen anonymen modernen `tools/call`; native
Domainzeilen bleiben unverändert. Auf Root `4d15faa74` liefert der ursprüngliche
Handler für diesen Fall nun die echte HTTP401/`invalid_token`-Antwort mit
Bearer-PRM-Challenge. Anonyme moderne Discovery und Toolliste sowie der
Legacy-Toolfehler mit `_meta`-Challenge bleiben erhalten. Der GREEN-Originallog
protokolliert sechs Gruppen – fünf SDK-Familien und die neue HTTP-Grenze – mit
32 tatsächlichen TCP-Requests, unveränderten Originalzeilen und eigenem
Python-/HTTP-/WSS-/Owner-/Schema-/DATA-Abschluss. Dieser Quell-/TCP-Nachweis
bleibt vom nachfolgenden kompilierten OAuth-/Browsernachweis getrennt.

Der erste Browser7-Aufruf auf Root `4d15faa74` / QA `7cdb39f01` endet vor jedem
Test: erwartet 7, deklariert 0, bestanden 0; alle übrigen Fallzähler sind 0.
Runtime, unabhängiger Postcheck und Queue enden mit Exit 1. Das verschachtelte
`test.use` für Trace/Screenshot/Video ist wegen des Worker-Scope in
Playwright 1.61.1 unzulässig. Kein SDK-OAuth-Fall lief. Die enge Korrektur auf
Root `29019a909` verschiebt die Konfiguration auf Dateiebene und erhält alle
sechs bisherigen Fallkörper/Fachassertions. Der tatsächliche `--list`-Lauf
erfasst anschließend sieben Fälle mit Exit 0; er bleibt ein Collectionbeleg.

Der zweite ursprüngliche Browserlauf auf Root `29019a909` / QA `a63b434ba`
endet mit 7 deklarierten, 6 bestandenen und einem fehlgeschlagenen Fall, ohne
Skips, Timeouts oder Unterbrechungen; Runtime, Postcheck und Queue jeweils
Exit 1. Der neue Fall erreicht Consent, den echten SDK-Callback mit HTTP 200,
die Workspacefreigabe und nach Root-Hostbeobachtung den Tokenexchange sowie
anschließenden MCP-Request mit HTTP 200. Er stoppt bei `next('authenticated')`
mit einem unerwarteten Ereignis. Dessen ursprüngliche Fehlerklasse wurde
nicht gespeichert und bleibt unbekannt; SDK-Claimprüfung, Suche und Erstellung
sind für diesen negativen Lauf nicht als erreicht belegt. Die anschließende
Quellprüfung weist unabhängig einen konkreten Testvertragsfehler nach:
`list_workspaces` liefert einen menschenlesbaren Summarytext neben dem
strukturierten Ergebnis; der Helper versuchte den Summarytext als JSON zu
lesen. Root `f56c2bc25` benutzt ausschließlich für diese bestehende
Workspaceantwort `.require_success()` und ergänzt sichere Stage-/Fehlerklassen-
Diagnose. Die strikten JSON-Textspiegelprüfungen der nativen V1-Ergebnisse
bleiben erhalten. Der bekannte Quellfehler wird nicht nachträglich als
beobachtete ursprüngliche Exception ausgegeben.

Auf Root `f56c2bc2597674e8601e23a047c88d5a45a1b1c1` / QA
`3b5eb75bbe7802d8ae5d3b846c73d8f2c6effc97` bestehen der frische
Originalproduktionsbuild nach 255,607 Sekunden mit Exit 0 und der getrennte
Artefaktabgleich. Der abschließende Originalbrowserlauf besteht tatsächlich
mit **7/7**, ohne Fehler, Skips, Timeouts oder Unterbrechungen. Die bisherigen
sechs Create-/Import-/Renewal-/MCP-/RESTfälle und der neue SDK-Fall bestehen
gemeinsam. Das unveränderte installierte v4-Wheel
`a49b1910b15a915fb1059fe184c28e6db436f7c7a68418e10fe794ac8ad82b7c`
verwendet den offiziellen MCP2.3.0-OAuth-Code-/PKCE-Provider mit wirklichem
Loopbackcallback und Tokenexchange. Aktuelle Session, Clientregistrierung,
Issuer, MCP-Resource und eigener Workspacegrant werden an die tatsächlichen
issued Credentials gebunden. Echte SDK-Suche liefert native ID und vollständige
Version für den mehrseitigen Read; native Create-, versionsgebundene Edit-
und Statusaufrufe erreichen denselben offenen Editor. Sichtbarer Text und
vollständiges natives Editor-JSON stimmen nach Edit und Reload mit dem
SDK-Ergebnis überein. Root sichtete zusätzlich den tatsächlichen Screenshot
mit „Python OAuth changed target 🧪.“ und unverändertem finalem Absatz.

Originalruntime (PID 83699), Baseline, unabhängiger Postcheck und Queue enden
jeweils mit Exit 0; alle 14 Abschlussprüfungen bestehen. Der eigene
Pythonprozess ist geschlossen, die neue SDK-Verbindung widerrufen. Die zwei
eigenen Datenbanken samt Backends, DATA, TMP und Runtime-Lock sind abwesend;
beobachtete eigene Prozessidentitäten, Gruppen und Listener sind geschlossen.
Die vier verwalteten Dienste behalten ihre ursprünglichen Identitäten und
gesunden Zustand; alle drei geprüften Health-URLs liefern HTTP 200.
Originalberichte und beide früheren negativen Läufe bleiben erhalten.

Diese enge SDK-OAuth-/Dokument-/Editorfolge ist damit lokal abgenommen.
Die separate macOS-Keyring-Prüfung ist unten belegt. Öffentliche HTML-/Websiteabnahme
und tatsächliche Veröffentlichung bleiben eigene offene Gates. SDK-Move/Copy/Delete, zentrale PDF-Anlage und der
kontrollierte Runtimeadapter werden durch diesen Lauf nicht ergänzt.
Review Center, Dateiaktions-Undo und allgemeine Aktivierung bleiben aus;
der gesamte Dokument-/Datei-/Skillauftrag ist dadurch noch nicht abgeschlossen.

| Originalbeleg | SHA-256 / Ergebnis |
| --- | --- |
| `/private/tmp/canvas-notebook-python-validation-ofbcf_2m/anonymous-oauth-http-red-v1.log` | `326d804a3c8e53973ad8f87263cb3e35479de0eeec4e654e91e699d2708cfb72` – echte HTTP200-Gegenprobe |
| `/private/tmp/canvas-notebook-python-validation-ofbcf_2m/anonymous-oauth-http-red-closure.json` | `ed75ec2bbe12c774abbace80ed182f99bf01d524b7b07ca789139074d9f6a40e` |
| `/private/tmp/canvas-notebook-python-validation-ofbcf_2m/anonymous-oauth-http-green-v1.log` | `663f880980fccf3530106077b708b17250c2751906110d1a752b6b279b5dfc74` – HTTP401, sechs Gruppen |
| `/private/tmp/canvas-python-sdk-oauth-controller7-dmt6cV1M/runtime-terminal.json` | `509855c35a346a6bdb88e34bdb9354769438452a0993ef697ec80960463a5e5b` – ursprünglicher Exit1 |
| `/private/tmp/canvas-python-sdk-oauth-controller7-dmt6cV1M/queue-terminal.json` | `7da4e735f7fb8d1b346ab1ccd9499337cc77b7d747c8c907e570c89c37254c77` – deklariert0, Queue1 |
| `/private/tmp/canvas-sdk-oauth-collection-8pl6i37a/collection-report.json` | `8e9f416feb3990771506d3273072df9f4ab345846144411db63f467c4037ae68` – Exit0, nur Collection mit sieben Fällen |
| `/private/tmp/canvas-python-sdk-oauth-controller7-retry-kM2O0dJO/runtime-terminal.json` | `99a8729288bb15fef0984a6a8dc3c90c9472da64e51cd00d1c11d982032fb21d` – ursprünglicher Exit1 |
| `/private/tmp/canvas-python-sdk-oauth-controller7-retry-kM2O0dJO/queue-terminal.json` | `c393fe5d63de439f8ece25d414a8c3f07da6f37b9d8b03011f4d2846b8c6c0ed` – ursprüngliche6/7, Queue1 |
| `/private/tmp/canvas-python-sdk-oauth-controller7-stagefix-FYrjS71X/source-report.json` | `b9d0942b2769f496e2bb72ae9b85a9b2b8eeb7c9d5eda2bce39ff7b07d8464f0` |
| `/private/tmp/canvas-python-sdk-oauth-controller7-stagefix-FYrjS71X/build-terminal.json` | `7336186a22f84708b0a79bc0af2ca0e26d8a61ee97db462028ce99f9836dc948` – tatsächlicher Buildexit0 |
| `/private/tmp/canvas-python-sdk-oauth-controller7-stagefix-FYrjS71X/artifact-report.json` | `8f360fc74e84d3b00c4d7eaa52abef3b106874bc01724abfbbaa73ba255ebb87` |
| `/private/tmp/canvas-python-sdk-oauth-controller7-stagefix-FYrjS71X/runtime-terminal.json` | `f87d61216e34b5376a611276884b10cba66a3c104316c450356d950b4f33577e` – tatsächlicher Runtimeexit0 |
| `/private/tmp/canvas-python-sdk-oauth-controller7-stagefix-FYrjS71X/postruntime-report.json` | `266d61c13c2b06d11906af3017b5f767b7609879d31285831f99c22686697e08` – 14/14 Abschlussprüfungen |
| `/private/tmp/canvas-python-sdk-oauth-controller7-stagefix-FYrjS71X/queue-terminal.json` | `9a16a325c8be7807f8b0bd99b313669a3389e616268cc4ebd35618a7564517d7` – tatsächliche7/7, Queueexit0 |

Die finale Originalfixture ist
`/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-EONa0D`.
Unter `results/direct-mcp-native-create-import/` besitzt `browser-outcome.json`
SHA `cea226784769d121afe864394a9713c1c73b4e6e7134b49ce0fe73d0e268e21e`.
Der neue SDK-Fall unter
`playwright/direct-mcp-native-create-i-90258-e-visible-editor-and-reload/`
hält `native-mcp-http-evidence.json` mit SHA
`3b481248a29661452d97ffd399595f398d9f658419efa9ffc77d48de9037bc64`
und den von Root gesichteten Screenshot
`python-sdk-oauth-visible-editor-reloaded.png` mit SHA
`3f040286d4fda0c0fe833dc3e1ebd470311537aed7c44acb3eaf4d123a28f7f8`.
Der finale Quellenfingerprint ist
`a38e5e9aec385b4a977347f509e7eb8af684dfa16142cc183bd7865628ed54a2`,
Buildfingerprint `36c0d297f9d2176abd7133e0df3f8661911ea1a23be511fd4beeb81017a2f677`.


## Separate tatsächliche macOS-Keyring-Prüfung

Eine neue isolierte Umgebung `venv-keyring` wurde aus demselben unveränderten v4-Wheel mit den Extras `mcp,keyring` und tatsächlichem `keyring==25.7.0` installiert. Die Browser-SDK-Umgebung blieb unverändert. Drei verschiedene eigene Pythonprozesse verwenden das echte Backend `keyring.backends.macOS.Keyring`: Schreiben zweier zunächst leerer eigener Accounts, prozessübergreifendes Lesen sowie `clear_tokens` mit erhaltener Clientregistrierung und abschließendes Entfernen des verbliebenen eigenen Dummyaccounts. Andere neue Endpoint-/Profilnamespaces bleiben getrennt und leer.

Der Originallauf endet mit Exit 0. Sämtliche drei Phasen bestehen. Vor `clear_tokens` werden die über das SDK validierten Dummymodelle verglichen; beim abschließenden Backenddelete wird zusätzlich der vollständige eigene Dummyenvelope exakt geprüft. Danach sind beide eigenen Accounts tatsächlich leer. Es gibt keine Inventur bestehender Credentials, globale Entfernung, ACL-/Unlockänderung oder echten OAuth-/HTTP-Aufruf. Dies ist ein OS-Persistenz-/Partitionierungs-/Bereinigungsnachweis mit echten SDK-Modellen und Dummywerten; der erfolgreiche OAuth-Browserlauf oben verwendet `MemoryTokenStorage`. Ein kombinierter persistenter OAuth-/Refreshlauf und andere OS-Backends werden daraus nicht behauptet.

Originalbelege: `/private/tmp/canvas-notebook-python-validation-ofbcf_2m/keyring-install-v1.json`, `keyring-probe-terminal-v1.json` und `/private/tmp/canvas-sdk-keyring-qa-kg5x1pcz/result.json`. Der ursprüngliche Koordinator-PID ist 7539; die drei tatsächlich verschiedenen Worker-PIDs sind 7541, 7594 und 7608. Der Root-Wrapper bestätigt seinen tatsächlichen Exit 0 und der Koordinator wartet jeden eigenen Worker ab. Result-SHA `d4ef9048fc6890625a84b13ee073731a39935222578964aff484682233b7587f`, Original-Log-SHA `597f6eb9426d98f7060ff2b8288569c61bdac0129a805f412b82eeab8365108e`. Die bereits vorher gelesene private Prüfquelle hat SHA `fc0802a2de1835b247e20eb3f7783516d90ab64c5840ffdb95f34e28568a445c`; ihre eigene vor dem ersten Write gesicherte Namespacebindung bleibt im privaten Reportordner erhalten.

Der Browserpostcheck bindet fünf zuvor beobachtete PID-Identitäten und zwei Gruppen. Roots zusätzliche, nur vorbereitende Stichprobe erweitert diese Union auf sechs tatsächlich abwesende Identitäten und vier leere Gruppen; `root-sampled-union-closure.json` hält diese Grenze ausdrücklich fest. Dies ist kein vollständiger Verlauf aller kurzlebigen Prozesse. Die ursprünglichen erfolgreichen und negativen Browserberichte werden durch diesen Dokumentationsnachtrag nicht umgeschrieben.

## Nachführung der Paketdokumentation

Am 18. Oktober 2026 wurden ausschließlich `packages/canvas-notebook-python/README.md` und `CHANGELOG.md` an die oben belegten lokalen Abnahmen angeglichen. Ihre älteren Statuszeilen hatten Browser-OAuth und sämtliche echten OS-Credential-Stores noch pauschal als ungeprüft bezeichnet. Der Pakettext trennt jetzt die tatsächliche kompilierte Browserfolge mit temporärem Tokenspeicher von der separaten macOS-Keychain-Prüfung mit Dummywerten. Kombiniertes persistentes OAuth, andere OS-Backends, weitere Pythonlaufzeiten und öffentliche Auslieferung bleiben offen.

SDK-Code, Paketversion und die bisherigen Distributionsartefakte bleiben unverändert. Dieser reine Textnachtrag baut kein neues Wheel und behauptet keinen neuen Installations-, HTTP-, OAuth- oder Browserlauf. Die oben genannten Wheel-SHAs und Testquellen bleiben ihren ursprünglichen Artefakten zugeordnet. Der Quelltext der öffentlichen SDK-/API-Seiten und die Repositoryentscheidung in §4.0 des zentralen Plans bleiben unverändert.
