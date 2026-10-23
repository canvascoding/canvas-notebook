# MCP-Copy: tatsächliche aktuelle Zwei-Workspace-Autorität

Dieser quellengebundene Nachweis beschreibt die Autoritätsgrundlage vor dem anschließenden [regulären Owner-/Phasenanschluss](./yjs-mcp-native-copy-owner-evidence.md). Seine ursprünglichen Prüfungen und damaligen offenen Grenzen bleiben unverändert erhalten.

Stand: 18. Oktober 2026. Die eigene aktuelle MCP-Copy-Autorität und ihr Domainadapter sind implementiert und tatsächlich geprüft. Der reguläre Copy-Owner, öffentliche Dateiaktionstools, reine Status-/Recoveryadapter und SDK-Dateiaktionsmethoden sind noch anzuschließen. Diese Abnahme ist kein fertiger öffentlicher Copy-Zugang und keine Gesamtfreigabe.

## Vertrag und Umsetzung

Der [gemeinsame MCP-Principal](../app/lib/mcp/server/document-read-principal.ts) besitzt eine eigene opake Copy-Brand. Eine Factory erfasst den tatsächlichen Token und beide Workspace-IDs synchron vor dem ersten Await und prüft den JWT genau einmal. Beide festen Workspace-Slots verwenden denselben unveränderlichen verifizierten Claims-Satz und Realm. Weder gespeicherte Herkunft noch `AuthInfo`-Felder wie `clientId`, `scopes` und `extra` ersetzen diese Verifikation.

Die feste Operation verlangt `knowledge:write` und exakt `copy_knowledge_source`. Quelle benötigt aktuelles Leserecht, Ziel aktuelles Lese-/Schreib-/Agentenrecht. Es wird kein zusätzliches `knowledge:read`-Scope für die Quelle eingeführt. Die echte Workspacepolicy leitet `canRunAgent` aus Lesen ab; ein unabhängiger erfundener Flagwiderruf wird nicht behauptet. Bei gleicher Workspace-ID wird der stärkere Zielslot einmal je Prüfung verwendet.

Eine gemeinsame kurze Caller-B-Phase erhält Backend, Backendstart, XID, Realm, Schema-/Relationenidentität, SHARE-Locks und insgesamt fünf Sekunden. Die Reihenfolge ist Quelle → Ziel → Consumer → Ziel → Quelle. Explizites `assertCurrent` prüft die ganze Paarung seriell. Abgelehnte, verschachtelte, entkommene oder nicht abgewartete Verwendungen vergiften Phase und Capture. Die tatsächliche Callertransaktion muss dann zurückrollen. Die Autorität beginnt oder beendet keine Transaktion und schließt die geliehene Verbindung nicht. Copy benutzt nicht die Create-spezifische Receipt-Realmtransition. Die bisherigen Read-/Create-/Edit-Brands, Observer und Lebenszeitprüfungen bleiben erhalten.

Der neue [Domainadapter](../app/lib/workspaces/copy-principal.ts) akzeptiert nur den tatsächlichen opaken Copy-Principal und V2-Herkunft. Er erzeugt aktuelle Vergleichsdaten ausschließlich aus beiden wirklich geprüften Workspaces und User/Client/SID. Der bestehende [Originvergleich](../app/lib/files/workspace-operation-copy-origin.ts) bindet vollständigen Client, User/Actor und beide Scopes, gibt aber die unveränderte ursprüngliche Attribution mit SID_A zurück. Die aktuelle Sitzung B authentifiziert den Aufruf. Web-/PI-Einstiege bleiben V1; ein agentenförmiger Actor schaltet nicht zu PI um.

Die exakte Copy-Kennung ist in der [Konfiguration](../app/lib/mcp/server/config.ts) und der zweiten [Bootstrap-Allowlist](../server/load-app-env.js) reserviert und ausdrücklich opt-in. Sie ist nicht in Defaults, UI-Capabilities oder Handlerdefinitionen enthalten. Die Konfigurationsversion bleibt bis zum tatsächlichen öffentlichen Anschluss bei 7. Die echte registrierte Werkzeugliste bietet deshalb weiterhin keinen Copy-Handler an.

## Tatsächliche Prüfungen

Alle PostgreSQL-Folgen liefen seriell über den bestehenden tatsächliche Quellen bündelnden ESM-Runner und PostgreSQL 18. Original-Runtime-Exits sind jeweils 0, ohne Signal oder Ersatzresultat.

| Folge | Tatsächliches Ergebnis |
| --- | --- |
| Neue MCP-Copy-Principalfolge | 8/8 echte JWT-/PG-/Lifetime-Familien |
| Bestehende Direct-MCP-Read-Principalfolge | 20/20 |
| Bestehende Direct-MCP-Create-Principalfolge | 8/8 |
| Bestehende native Edit-Principalfolge | 9/9 |
| Bestehende Web-/PI-Copy-Principalfolge | 17/17 |
| Konfiguration und tatsächlicher Bootstrap | beide ursprünglichen Prozesse Exit 0 |
| Gezielter TypeScript-Abschluss einschließlich neuer Suite und vorhandener Ambienttypen | Exit 0 |
| ESLint aller acht Code-/Testdateien, Bootstrap-JS ausdrücklich einbezogen | Exit 0 |

Die neue Folge verwendet echte Workspace-/Mitgliedskonstruktoren, signierte Fixturetokens, aktuelle Consent-/Session-/Client-/Workspacegrant-/ACL-Zeilen und wirkliche Callertransaktionen. Eine nur lesbare Quelle und schreibbares Ziel erreichen denselben B/XID. Eigene SQL-Witnesses samt `xmin` belegen tatsächlichen COMMIT und ROLLBACK. Rechte-/Session-/Client-/Tokenwiderrufe werden innerhalb B tatsächlich angewendet; sowohl geschluckte explizite Ablehnungen als auch automatische Nachprüfungen müssen den gesamten Aufruf ablehnen und die Witnesswrites zurückrollen. Reale erneuerte SID_B, gültige fremde Clients/Benutzer und geänderte Paarselektion prüfen die unveränderte Original-A-Bindung. Diese Origin-A-Beobachtung ersetzt noch keinen positiven Copy-Journal-/Owner-Recoverybeleg.

Die neue registrierte Web-Request/Response-Protokollprobe bestätigt mit tatsächlichem Token und moderner MCP-Metadatenbindung: Die reservierte Kennung erscheint nicht in `tools/list`; `tools/call` endet `MethodNotFound`, ohne Dokument-/History-/Projektionsänderung. Es werden kein TCP-Server, kein Browser und kein OAuth-Ausstellungsflow gestartet. Tatsächlich geprüft sind 5s Transaktions-/Statementtimeout und 50ms Locktimeout; es gibt hier keine ausgesessene Timeoutprobe.

Die gezielte Typprüfung des neuen Tests meldete zunächst zweimal Zugriff auf ein unbekanntes `SqlConnection.run`-Ergebnis. Der finale Test validiert das echte Ergebnis mit seinem vorhandenen Objekthelfer; Compilerregeln und Produktdeklarationen wurden nicht abgeschwächt. Ein vorheriger Quellenübernahmeversuch stoppte am Hashguard vor Anlage der Testdatei, weil die beauftragte zusätzliche Scopegegenprobe inzwischen einen neuen finalen Kandidatenpin erzeugt hatte. Der danach versehentlich mit altem Config ausgeführte Typdurchlauf ist keine Abnahme der neuen Suite. Alle ursprünglichen Diagnosen bleiben erhalten; erst der abschließende `type-v4.log`-Lauf umfasst die tatsächlich integrierte neue Testfassung.

## Quellen- und Ressourcenbindung

Die privaten Originale liegen unter `/private/tmp/canvas-mcp-copy-authority-j_9q9qsi/`. `tested-source-pins.json` und `tested-source/` halten die acht tatsächlich geprüften Code-/Testfassungen. Principal-SHA: `e3631490aca14bcc7729bfe753e6417f515aac19d18b82235dd17161ecd5c6c4`; tatsächliche neue Testquelle: `be5a588ac85c4b39903b0e46ce51c45965db6aa9cdb2592787ab07adffc07664`. Die unabhängigen Quellenreviews prüften Principal, Adapter, Reservierung und finalen Testdelta vor der PG-Ausführung. Danach änderten sich nur die Plan-/Belegtexte.

| Original-Log | SHA-256 |
| --- | --- |
| `direct-mcp-workspace-copy-principal-postgres-test.log` | `ae0d7e9bf83dde491ccbe21a1e2950f5863b37eaf5cba0911910e02c88b12f9d` |
| `direct-mcp-document-read-principal-postgres-test.log` | `f79f52a3abc4fbc8373a468c3016ca1e089b93953413718f317f2a0d6f090062` |
| `direct-mcp-document-create-principal-postgres-test.log` | `6885969739d2e6060c73bc0061d5eb02155017330d0d1fc53f97f97fbc7644c7` |
| `native-document-edit-principal-postgres-test.log` | `fe950513232142ada586261a76dc7d58c717183f0dc6b412324d5f1c9f214fde` |
| `workspace-copy-principal-postgres-test.log` | `728dee962d182f51de0d61239516511b6c94370d500e789e7457e02cd4ecf251` |

Die eigene frische RR-/READ-ONLY-Abschlussprüfung endet tatsächlich mit Exit 0. Passende Testschema-/Backendinventare sind vor und nach der Folge leer; die vier tatsächlich geloggten eigenen DATA-Verzeichnisse und neun bekannten Runner-/Fixture-PIDs sind abwesend. Alle fünf Originalberichte und Quell-/Loghashes stimmen. Vier verwaltete Dienste behalten ihre ursprünglichen IDs und gesunden Zustand; drei Health-URLs liefern HTTP 200. Die Prüfverbindung weist keine zugewiesene XID auf und wird geschlossen. Dies ist eine begrenzte Abschlussbeobachtung, keine Vollhistorie unbeobachteter Prozesse. Container wurden nicht erstellt oder verändert.

Der tatsächliche Abschlussbericht `resources-after.json` hat SHA-256 `bde1438ef3fb4b531bbaf1a6b4c80e38c737e4e0613a0ce22ba05db3cd88fa1a` und nennt `testsSucceeded: true`. Vorher- und Nachherbericht bleiben getrennte unveränderte Originale.

## Nächster regulärer Anschluss

Der Copy-Owner lehnt V2 weiterhin vor Poolzugriff ab. Sein späterer Eingang muss den aktuellen opaken MCP-Handle separat von serialisierbarer V2-Herkunft führen, einschließlich `bindOriginal`, Recovery und sämtlicher festen B1-/B2-Phasen. Keine aktuelle Autorität gehört in Stage oder Journal. Erst danach folgen echter öffentlicher Handler mit Preview/Apply, reiner Status und begrenzte Wiederaufnahme sowie SDK-Methoden. Move/Delete benötigen ebenfalls ihre eigene aktuelle MCP-Workerintegration. Dateiaktions-Undo und Review Center bleiben aus. Es gibt hier keinen neuen Produktionsbuild, Browser-/Gesamt-E2E-Nachweis, keine allgemeine Aktivierung und keine Veröffentlichung.
