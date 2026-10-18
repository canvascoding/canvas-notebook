# Python-SDK und öffentliche Entwicklerdokumentation: erster lokaler Anschluss

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
