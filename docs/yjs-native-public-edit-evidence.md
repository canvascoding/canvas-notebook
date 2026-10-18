# Öffentlicher nativer Edit- und Operationsstatusvertrag

Stand 18. Oktober 2026. Die Request-, registrierten MCP- und PI-Adapter sind implementiert und auf echten lokalen PostgreSQL-/Raumquellen geprüft. Der erste frische kompilierte HTTP-/OAuth-/Browserlauf besteht 5/6 Fälle und findet eine fehlende Proxyzuordnung für cookie-freie REST-Aufrufe. Die enge Korrektur ist implementiert; deren erneute kompilierte Abnahme steht aus. Allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus.

## Gemeinsamer Zugang

`POST /api/documents/edit` nimmt den bestehenden strikten V1-Vertrag mit Workspace, Dokument-ID, vollständiger Inhaltsversion, stabilem Idempotenzschlüssel und nativer Text- oder Blockänderung entgegen. `POST /api/documents/edit/status` liest mit Workspace und Operations-ID die gespeicherten historischen Belege. Beide verwenden die echte aktuelle Requestautorität einschließlich Cookie beziehungsweise Session-Bearer. Ein MCP-OAuth-Token für `/mcp` wird dadurch nicht zum REST-Sessiontoken.

Das bestehende MCP-Tool `edit_knowledge_source` verwendet `api_version:1` mit `action:edit` beziehungsweise `action:status`; das PI-Tool `edit_file` verwendet dieselben Formen in camelCase. Ungültige native Marker, Versionswerte und gemischte Legacyfelder werden vor Pfad-/Projektionszugriffen abgewiesen. Alte Pfad-/SHA-Aufrufe behalten ihren gesonderten vollständigen Vertragszweig. Caller-Schlüssel werden auch bei neuen Toolcall-IDs und erneuerten Sessions erhalten. Kein zusätzlicher OAuth-Scope, synthetischer Principal oder direkter Markdownwriter wurde eingeführt.

Die öffentliche Antwort enthält ausschließlich Version, Operations-ID, stabile Dokumentidentität, Zustand, historischen Effekt und getrennte Persistenz-, Projektions- und Historybelege. `confirmed` bestätigt den gespeicherten Effekt; `pending`, Konflikte und unklare Ergebnisse dürfen keinen automatischen Replay oder neuen Schlüssel auslösen. Bekannte tatsächliche Operations-IDs bleiben bei späteren Autorisierungs-/Antwortfehlern als Recoveryreferenz erhalten. Private Attribution, Origins, Tokens, Datenbank-/Dateipfade, Zielpayloads und Yjs-Bytes werden nicht ausgegeben.

## Reiner Status

Status verwendet aktuelle Write-/Toolrechte und denselben ursprünglichen Benutzer sowie gegebenenfalls OAuth-Client oder Agenten. Eine neue echte Session desselben Owners ist zulässig. Die Abfrage liest über qualifizierte Tabellen ausschließlich begrenzte gespeicherte Original-/After-/Headerdaten und ruft weder Raumaufnahme noch Reconciliation, History-Capture oder Projektion auf. Spätere Peer-Edits und heutige Pfade werden nicht als historischer Effekt ausgegeben.

Die bestehende Autoritätsphase ist READ COMMITTED / READ WRITE und kann eine XID vergeben. SELECT-only bedeutet hier keine Fach-DML oder geänderten Domain-xmins, keine PostgreSQL-READ-ONLY-Zusage. Ein parallel später ergänztes Receipt kann zunächst konservativ unbestätigt bleiben. `history:captured` bestätigt gespeicherte Bindungen und Blobheader; es ist kein erneuter Integritätsaudit des dekomprimierten Historyinhalts.

## Native Blockziele

Ein ID-Read im nativen Format kann ausdrücklich `includeEditTargets:true` anfordern, bei MCP `include_edit_targets`. Der normale Read ohne dieses Flag beziehungsweise mit `false` behält seine bisherigen Bytes. Sichtbare IDs, Hierarchie, Attribute und exakte lokale Guards stammen synchron aus demselben vollständigen Zustand wie der Inhalt. Private Platzierungsoperationen und Receipts werden nicht veröffentlicht. Targets sind Teil des paginierten Bodys und seines Fortsetzungsnachweises.

Der explizite Zielread ist auf `tiptap_blocks`, 512 sichtbare PM-Knoten einschließlich Text/Root, je 64 KiB kodierten Inhalt und Targets sowie 2048 Records/Operationen beziehungsweise Receipts begrenzt. Die darunterliegenden Rohzustandsgrenzen werden enger, niemals weiter. Ein abgewiesener Zielread verhindert keinen gewöhnlichen nativen Read.

Die tatsächliche Tabellengegenprobe fand einen Fehler bei `addRowAfter` auf nativen Tabellen mit Spaltenbreiten: Offline-Kommandos erzeugten neue Zellen mit fehlenden Breiten. Die gemeinsame Tabellenvorbereitung führt nun dieselbe vorhandene ProseMirror-Tabellenreparatur aus, bevor der Blockbaum validiert wird. Die Regression prüft gültige native Vorbereitung, unveränderte Ausgangsbytes vor Apply, drei Zeilen, exakte Breite 120 aller alten/neuen Zellen und unveränderte IDs/Attribute/Subtrees der bisherigen Zellen.

## Tatsächliche lokale Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| Öffentlicher Ergebnis-/Statuscodec | 4 Gruppen, Exit 0 |
| Native Zielreads, strikte PI-/MCP-Selektoren, echte Yjs-Grenzen und Bytekompatibilität | 8/8, Exit 0 |
| Tatsächlicher Request-/PG-/Raumowner mit neuen HTTP-Handlern | 10/10, Exit 0; historische Statusreads ohne Domain-DML, späterer echter Peeredit, Bearer, Retry/Konflikt/Bodygrenze, alle sechs Blockoperationen mit öffentlich gelesenen Guards, terminaler Sessionentzug |
| Registrierte moderne MCP- und tatsächliche PI-Registry-/Prepare-/SDK-Validator-/Invocationkette | 8/8, Exit 0; tatsächliche PG-/Raumowner, erneuerte SID B, Original-A-/xmin-Erhaltung, Scope-/Tool-/ACL-/Sessionentzug, Transportowner-Isolation, Legacyedit |
| Isolierte native Tabellengegenprobe | 2 Stufen, Exit 0 |
| Bisherige Blockwriter / Admission / native Vorbereitung nach Tabellenkorrektur | 42/42, 5/5 und 8/8, jeweils Exit 0 |
| Bestehender MCP-Legacyvertragszweig | 3/3, Exit 0; sämtliche bisherigen Feld-/Required-Assertions im unveränderten Legacy-Unionzweig |
| Cachefreie gezielte Typprüfung vor Browserergänzung / finales Lint | 29 Typecheck-Eingänge, Exit 0; abschließend alle 29 geänderten Code-/Testdateien einschließlich der Sechs-Fälle-Browser-Spec ohne Lintbefund |
| Vollständiges cachefreies TypeScript einschließlich finaler Browser-Spec, 6144 MiB | Exit 2, exakt dieselben 69 bytegleichen Bestandsdiagnosen; SHA256 `f87d64a219dd9317c7a22890a2687240cbf81b79851e829dd8117faa2ea561e3` |
| Erster frischer Produktionsbuild / unabhängiger Artefaktabgleich | Beide Exit 0 auf Root `ce6035a43` / QA `9fbb32e1b`; enthält noch nicht die folgende Proxykorrektur |
| Tatsächlicher kompilierter HTTP-/OAuth-/Browserlauf | 5/6 bestanden, 1 fehlgeschlagen, keine übersprungenen Fälle; REST-401 verhindert die vollständige Abnahme |
| Enge Proxykorrektur | Echter Next-Matcher mit allen vier exakten Routen und geschützten Nachbarn, bisherige begrenzte Read-Fehler und Rate-Limit bestehen; cachefreier gezielter Typcheck und Lint der vier geänderten Code-/Testdateien Exit 0 |

## Erster kompilierter Lauf und Proxykorrektur

Die sechs Fälle laufen auf demselben frischen Build mit echten Browseranmeldungen und OAuth-Codeausstellung. Die drei bisherigen Create-/Import-/ID-Read-Fälle bestehen unverändert. Zusätzlich bestehen Textedit mit sichtbarer Änderung und vollständigem Zustandsvergleich im geöffneten Editor sowie erneuerte OAuth-Session, unveränderte Originalattribution und ein tatsächliches Blockverschieben mit öffentlich gelesenen Guards. Fall sechs scheitert vor dem ersten REST-Edit: Der tatsächlich ausgestellte Session-Bearer liefert cookie-frei am Session-Endpunkt HTTP 200 mit der richtigen Identität, am Edit-Endpunkt jedoch den generischen Proxyfehler `{"success":false,"error":"Unauthorized"}` und HTTP 401.

Der bestehende Proxy nimmt nur die native Readroute von seiner Cookie-Vorprüfung und Bodypufferung aus. Edit, Edit-Status und Suche besitzen ebenfalls eigene echte Session-/Bearer-Prüfungen und begrenzte Streamreader, erreichten diese aber cookie-frei nicht. Die Korrektur erweitert ausschließlich den vorhandenen exakten Matcher-Ausschluss auf `documents/(?:read|search|edit(?:/status)?)$`. Es gibt keinen neuen öffentlichen Prefix oder generellen Bearerzugang; geschützte Nachbarrouten behalten ihre Vorprüfung. Der sechste Browserfall prüft vor dem Edit jetzt zusätzlich tatsächliche REST-Suche und versionsgebundenen ID-Read sowie nach echtem Sign-out die Ablehnung aller vier Dokumentrouten.

Der bestehende Matcher-/Read-Boundarytest läuft über den vorhandenen echten ESM-Quellrunner: `NODE_ENV=test BETTER_AUTH_BASE_URL=http://localhost node scripts/run-document-read-tool-dispatch-test.mjs scripts/document-read-http-boundary-test.ts`. Nur dieser Test bündelt das installierte `next-intl` und lädt die tatsächliche Next-Node-Baseline vor dem Bundle. Dadurch funktionieren dessen tatsächliche Next-Matcher- und Handlerimporte trotz import-only-Abhängigkeiten; Produktpakete, Exports und andere Runner-Einstiege bleiben unverändert. Die vorangegangenen Loaderfehler sind keine Produktabnahme.

Der ursprüngliche Lauf, Queue und unabhängige Postcheck bleiben Exit 1, Browser 5/6. Alle eigenen Prozesse und Listener wurden beendet. Das getrennte geprüfte Cleanup entfernt nur beide ursprünglichen Datenbanken mit ihren exakten OIDs und Markern sowie DATA/TMP, schließt den Maintenance-Client und bestätigt dieselben vier gesunden verwalteten Dienste; alle ursprünglichen negativen Belege bleiben unverändert. Originale: `/private/tmp/canvas-native-edit-public-ui-preparation-gPy2Gw/`, separate Bereinigung: `/private/tmp/canvas-native-edit-public-failed-cleanup-ktqekrg3/`. Ein Cleanup-Erfolg bestätigt keine Produktfunktion. Die Korrektur benötigt einen neuen gebundenen Produktionsbuild und die vollständige erneute Sechs-Fälle-Abnahme.

Die neuen registrierten Tests verwenden echte lokal signierte Fixture-JWTs und SQL-Rechte; dies ersetzt keine echte OAuth-Ausstellung. Die Handlerprüfungen sind tatsächliche Web-Request-/PG-/Raumprüfungen, keine ausgeführte kompilierte TCP-HTTP- oder Mobile-App-Abnahme. Der bestehende CJS-Unitloader von `agent-structured-file-tools-test.ts` scheitert separat am import-only-Paketexport `@earendil-works/pi-ai/compat`; seine 18 Fälle werden nicht als bestanden ausgegeben. Der Versuch, diesen dynamisch Dateien lesenden Unitloader mit dem ESM-Integrationsrunner zu verwenden, wurde bereits vor Teststart durch dessen Eingangsprüfung abgewiesen. Produkt-, alte Test- und Paketexports wurden dafür nicht umgebaut.

Alle Originalläufe einschließlich negativer Vorstufen bleiben privat unter `/private/tmp/canvas-native-public-edit-root-k20_ak0e/`. Der erste neue Statusfall verwendete einen zuvor absichtlich abgelaufenen Peer; ein weiterer Versuch verwendete eine abgelaufene und durch BetterAuth entfernte Login-Session erneut. Diese Testanordnungen wurden korrigiert, der ursprüngliche Rechteentzug bleibt als terminaler Fall erhalten. Die Tabellen-409 wurde zusätzlich isoliert reproduziert und erst danach im gemeinsamen Writer korrigiert. Der reine Zieltest verglich zunächst JSON-Werte mit internen null-prototype-PM-Attributobjekten; das Orakel prüft nun exakt die transportierten JSON-Werte. Der registrierte Native-Selektor liefert seinen angekündigten `INVALID_REQUEST`-Toolfehler; das ursprüngliche Testorakel erwartete fälschlich einen JSON-RPC-Fehler. Alle ursprünglichen negativen Logs bleiben erhalten. Die erfolgreichen PG-Läufe bestätigen geschlossene eigene Sockets/Server/Ownerbackends, entfernte Schemas/DATA und geschlossene Clients; dies ist keine vollständige historische Prozessinventur.

Unabhängige lesende Prüfungen der Transport-/Targetgrenzen, Tabellenkorrektur und Status-/Ergebnisquellen melden keinen konkreten Blocker. SDK, öffentliche Developer-Seiten, Standard-Skill, PDF-/weitere Sandbox- und Dateiaktionsanschlüsse sowie die gemeinsame Gesamt-E2E bleiben erforderlich. Dieser Nachweis beendet den Gesamtauftrag nicht und enthält keine PR-, Push- oder Produktionsfreigabe.
