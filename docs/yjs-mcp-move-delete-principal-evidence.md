# MCP Move/Delete: aktuelle Autoritätsgrundlage

Stand: 19. Oktober 2026. Codecommit Root `d8c305cd1c1da48d44bc24247598f107d56f1801`, QA `edd05fd7e4a9dc66c9187d448ccbe33a3a1f9312`. Die getrennten aktuellen Move-/Delete-Principals sind implementiert und lokal geprüft. Dauerhafte MCP-Jobs, tatsächliche Dateiänderungen über diese Principals, öffentliche Move-/Delete-Tools, Status/Recover und SDK-Methoden bleiben anzuschließen. QA belegt hier ausschließlich Quellparität.

## Vertrag

Der [bestehende feste MCP-Principal](../app/lib/mcp/server/document-read-principal.ts) besitzt eigene opake Move- und Delete-Brands, jeweils mit fester Factory, geliehener OnConnection-Phase und synchroner Vorabprüfung. Workspace und tatsächlicher Token werden vor dem ersten Await erfasst. Client-, User- und Sitzungsfelder eines fremden `AuthInfo`-DTO ersetzen den verifizierten JWT nicht. Der Observer erhält aktuelle primitive Vergleichsdaten; gespeicherte Herkunft ist kein Factoryeingang und erteilt keine Rechte.

Beide Operationen verlangen `knowledge:write`, exakt ihr eigenes ausgewähltes Tool und aktuelle Read-/Write-/Delete-/Agentrechte auf dem ausgewählten Workspace. Auch Move benötigt Delete. Die echten Workspace-, Sitz-, Benutzer-, Session-, Client-, Consent-, Tokenwiderrufs-, Workspace-Opt-in- und Grantprüfungen erfolgen auf derselben tatsächlichen Caller-Verbindung und XID. Im geprüften Organisationsworkspace folgt Agentzugriff aus Read; Write und Delete werden unabhängig entzogen. Eine erfundene unabhängige Agentberechtigung wird nicht behauptet.

Die gemeinsame Token-Erfassung, OnConnection-Mechanik und serielle Prüfungsreihenfolge sind bytegleich zum vorherigen Commit. Die zusätzliche Delete-Prüfung gilt ausschließlich für die beiden neuen Kinds. Dieselben Backend-/Start-/XID-/Realm-/Schema-/Relationenpins, SHARE-Locks, maximal fünf Sekunden je Phase sowie 5s Statement-/Transaktions- und 50ms Locktimeout bleiben erhalten. Die neue Phase besitzt weder BEGIN/COMMIT/ROLLBACK noch Connection-Close. Fehler, geschluckte Ablehnungen, Wrong-Brand, Reentry und nicht abgewartete Arbeit bleiben fatal; der Caller muss zurückrollen. Die Create-spezifische Receipt-Realmtransition bleibt auf Create begrenzt.

Die Vorabprüfung verwendet keine SQL-Verbindung. Sie bestätigt nur lebende Brand, festen Workspace, Laufzeit und freien Capturezustand. Sie ersetzt keine aktuelle Autorisierung auf einer späteren Ownertransaktion.

`move_knowledge_source` und `delete_knowledge_source` sind in [Konfiguration](../app/lib/mcp/server/config.ts), expliziter Opt-in-Liste und [Bootstrap-Allowlist](../server/load-app-env.js) intern reserviert. Defaults und Konfigurationsversion 7 bleiben unverändert. Settings-Capabilities und öffentliche Registry bieten sie noch nicht an. Die echten registrierten Request-/Response-Proben bestätigen bei ausdrücklicher Reservierung ihre Abwesenheit in `tools/list` und `MethodNotFound` (-32601, kein Resultat) bei `tools/call`.

## Tatsächliche Prüfungen

Alle sechs PostgreSQL-Folgen liefen seriell über den bestehenden [Realquellen-ESM-Runner](../scripts/run-document-read-tool-dispatch-test.mjs). Alle ursprünglichen Prozesse enden mit Exit 0 und ohne Signal.

| Folge | Bestandene Gruppen |
| --- | --- |
| Neue [Move-/Delete-Principalfolge](../scripts/direct-mcp-workspace-path-principal-postgres-test.ts) | 12/12 |
| Bestehender Direct-MCP-Read-Principal | 20/20 |
| Bestehender Direct-MCP-Create-Principal | 8/8 |
| Bestehender nativer Edit-Principal | 9/9 |
| Bestehender Direct-MCP-Copy-Principal | 9/9 |
| Bestehender Web-/PI-Copy-Principal | 17/17 |
| Gesamt | **75/75** |

Die neue Folge verwendet echte signierte Fixture-JWTs, gespeicherte Sessions/Consents/Grants und tatsächliche PG18-Transaktionen. Ein SQL-Witness bestätigt denselben Backend/XID samt `xmin`, unabhängige Unsichtbarkeit vor Caller-COMMIT, Sichtbarkeit danach und tatsächlichen ROLLBACK bei Fehler. Echte Write-/Delete-/Grant-/Client-/Session-/Consent-/Token-/Seatwiderrufe innerhalb B bleiben auch nach geschlucktem `assertCurrent` fatal. Automatische finale Checks werden zusätzlich ohne explizites `assertCurrent` geprüft.

Eine tatsächlich gespeicherte zweite Sitzung B mit neu signiertem JWT wird akzeptiert, während Sitzung A abgelaufen ist. Dies ist **kein** OAuth-Ausstellungs-/Refreshflow und noch kein Original-A-/Job-/Recoverybeleg. Weitere Gegenfälle prüfen Read-/Move-/Delete-Brandwechsel, gefälschte und entkommene Handles, Reentry, Pending-Arbeit, Proxy-/Getterselektoren ohne Trapaufruf, synchrone/async Observerfehler, echte JWT-Ablaufzeit, XID-/Realmwechsel und temporäre Auth-Tabellenschatten. Die Ablaufprobe wartet außerhalb B; ein ausgesessener SQLtimeout wird nicht behauptet.

Der abschließende Fixture-Snapshot umfasst sechs konkrete Dokument-/Lineage-/State-/Metadaten-/Revisions-/Projektionsrelationen ohne geseedetes Dokument. Er belegt keine allgemeine Datei-/Historyabnahme. Die lokal signierte Team-Testlizenz ist keine neue Control-Plane-Lizenzausstellung.

`npm run test:mcp:server-settings`, gezieltes cachefreies TypeScript und finales ESLint aller sieben Code-/Testdateien bestehen. Der erste Lintprozess endete zwar mit Exit 0, übersprang aber die ignorierte Bootstrap-JS-Datei mit Warnung. Erst `--no-ignore --max-warnings 0` prüft sie ausdrücklich; der finale Lauf ist warnungsfrei. Eine private Zusammenfassungsprüfung, die zuvor ein leeres Erstlintlog erwartete, scheiterte deshalb an dieser Warnung; sie ist kein Produkt-/PG-Fehler. Produktquellen und Regeln wurden dafür nicht verändert.

## Quellen und Ressourcen

Originale und Pins: `/private/tmp/canvas-mcp-path-authority-7_gp77wu/`. Principal-SHA-256 `6167fed7367df6199d19712f3830c4aa1104dd9f97b58a9ee08b4dc279d08413`; neue Testquelle `71c83b0da97d497f281a5d85c4090773a78417df46758b6e6a2ef38f9fe15d76`. `tested-source-pins-v2.json`, `shared-mechanics-parity.json`, sechs unveränderte Prozessberichte/Originallogs und `validation-summary.json` binden die geprüften Bytes. Unabhängige Quellenreviews bestätigen Kern und Test ohne eigene Ausführung.

Der frische RR-/READ-ONLY-Abschluss findet vor und nach der Folge keine passenden Testschema-/Backendreste. Fünf genau geloggte DATA-Verzeichnisse, elf bekannte Test-PIDs und separat alle sechs Runner-Bundles sind unabhängig als abwesend bestätigt. Die Readprobe hat keine zugewiesene XID und wird geschlossen. Vier verwaltete Dienste behalten ihre ursprünglichen Identitäten und gesunden Zustand; drei Health-URLs antworten HTTP 200. Dies ist eine begrenzte Abschlussbeobachtung, keine Vollhistorie unbeobachteter Prozesse. `resources-after.json`: SHA-256 `9acfec61db1172f8d24126893605a40410d12366410830c0ff895ec897996e43`.

GitNexus wurde im reinen Indexmodus aktualisiert. Vorherige gemeinsame Mechanik und später der konkret aufgelöste `currentSlot` haben HIGH-Reichweite; die bestehenden Consumer wurden deshalb mitgeprüft. Die verpflichtenden Änderungsprüfungen vor Root-/QA-Commit umfassen genau sieben Dateien, melden LOW und keine betroffenen indexierten Prozesse. Das ist kein allgemeiner Nullrisikonachweis: Neue Testfunktionen waren beim vorherigen Indexlauf noch nicht vorhanden; QA besitzt einen älteren Index. Die geschützte Root-/QA-Abweichung aus genau drei Dateien bleibt bytegleich mit SHA-256 `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`.

## Nächster Anschluss

Der aktuelle Jobpfad behandelt direkte Actors ausschließlich als Webbenutzer oder echte PI-Agenten. MCP braucht nun einen ausdrücklichen dauerhaften Discriminator mit Client/Tool/Original-SID_A und einen festen Adapter, der einen echten Claim mit diesem live Principal auf jeder bestehenden Owner-B verbindet. Der allgemeine Worker darf MCP-Autorität nicht aus gespeicherten Daten rekonstruieren. Eine erneuerte aktuelle SID_B bleibt von ursprünglicher Attribution getrennt. Die vorhandenen OriginalMove-/OriginalDelete-Runner, Linkpflege und Receipts werden weiterverwendet.

Anschließend folgen vorhandenen Auftrag fortsetzender Recover, rein lesender aktuell autorisierter Status, öffentliche Tools und SDK-Move/Delete. Die neue Grundlage führt noch keine Move-/Delete-Dateiaktion aus. Es gibt hier keinen neuen Next-Produktionsbuild, Browser-/Gesamt-E2E-Nachweis, keine normale Aktivierung, Veröffentlichung oder Containeränderung. Dateiaktions-Undo und Review Center bleiben aus; alle übrigen Restpakete des [Gesamtplans](./yjs-document-authority-consolidation-plan.md#restarbeiten-bis-zum-vollständigen-ergebnis) bleiben erforderlich.
