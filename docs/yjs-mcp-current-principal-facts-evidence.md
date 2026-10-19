# Frische MCP-Berechtigungsfakten auf derselben Verbindung bündeln

Stand: 19. Oktober 2026. Dieser Schnitt erhält die aktuellen Berechtigungsprüfungen für Read, Create, Edit, Copy, Move und Delete. Er aktiviert keine Funktion und erklärt weder den vollständigen Dateiaktionsplan noch den offenen Live-Editor-Abschluss für fertig.

## Vertrag

`currentSlot` liest vier bisherige Faktenabfragen in einem tatsächlichen SQL-Statement auf derselben gehaltenen B. Rawuser, Client und Session bleiben skalare Driverwerte. Die beiden ursprünglichen workspacegebundenen Opt-in-/Grantprüfungen bleiben bestehen; Organisationsflags und Nutzerpermissions werden vor getrennten Aggregaten weiterhin auf 17/1025 Zeilen begrenzt. Die unveränderten nachfolgenden Maxima bleiben 16/1024. Fehlender Rawuser erzeugt keine künstliche Rechtezeile, leere Mengen bleiben unabhängig `[]`.

Die fachliche Prüfungsreihenfolge, der separate originale Grantloader, SHARE-Tabellenlocks, Source-/Destination-Slots, strengere Same-ID-Copyprüfung, alle Checkpoints, XID-/Realm-/Identitätsprüfungen und das Fünf-Sekunden-Limit bleiben erhalten. Es entsteht kein Rechtecache. Numerische Aggregateflags werden als exakter PostgreSQL-Text übertragen; ein ungültiger NUMERIC-Wert nahe 0 oder 1 darf beim JSON-Decode nicht zu einem gültigen Flag gerundet werden.

Das unterstützte physische Flagspaltenschema ist BIGINT. Bei absichtlich abweichenden JSON/JSONB-Spaltentypen kann der neue exakte Text enger ablehnen. Datenbankfehler bisher späterer Teilabfragen können im gemeinsamen Statement früher auftreten; vollständige SQL-Fehlerprioritätsgleichheit für ein beschädigtes Schema wird nicht behauptet. Solche Fehler bleiben geschlossen.

Vor Autorenschaft war `currentSlot` als HIGH mit einem direkten Aufrufer und neun betroffenen Abläufen analysiert; Warnung, Kontext und tatsächliche SHARE-Fences wurden geprüft. Der neue private Faktenleser ist im Index noch unbekannt. Unabhängiger Quellenreview und eigener vollständiger Diffabgleich finden im unterstützten Schema keine Rechteausweitung.

## Tatsächliche Validierung

Originale unter `/private/tmp/canvas-native-path-admission-8gusy9ys/`; die Controller erhalten Exits, Signale und Vor-/Nach-Quellhashes.

| Originalprogramm | Ergebnis |
| --- | --- |
| `principal-read-pg-principal-terminal-pg-v1.log` | 20/20 echte PostgreSQL-Lesefamilien, Exit 0 |
| `principal-create-pg-principal-terminal-pg-v1.log` | 8/8 echte Create-Principalgruppen, Exit 0 |
| `principal-copy-pg-principal-terminal-pg-v1.log` | 9/9 echte Copy-Principalgruppen, Exit 0 |
| `principal-path-pg-principal-terminal-pg-v2.log` | 12/12 echte Move-/Delete-Principalgruppen, Exit 0 |
| `principal-edit-pg-principal-edit-pg-v1.log` | 9/9 echte native Edit-Principalgruppen einschließlich MCP, REST und PI, Exit 0 |
| `scoped-types-owner-terminal-v16.log` | Gezieltes TypeScript einschließlich geändertem Path-Principaltest, Exit 0 |

Damit bestehen 58 echte Principalgruppen. Diese prüfen tatsächliche JWT-/Session-/Grant-/ACL-/Seat-/Realm-/Transaktions- und Lifetimegrenzen, keine vollständige neue Dateiaktions-/Browserabnahme. Die Fixtures melden entfernte eigene Schemata/DATA, geschlossene Clients und null externe Fetches; die Runner bestätigen entferntes Bundle.

Die Pathfolge scheiterte zuerst nach einer Gruppe an einem alten Testorakel, das inzwischen angeschlossene öffentliche Move-/Deletehandler weiterhin als nicht registriert erwartete. Die unveränderte Vorher-Principalquelle reproduziert denselben Fehler im tatsächlichen PG-Gegenlauf `path-principal-baseline-v2`; der frühere private Baseline-Bundlevorlauf scheiterte bereits am Resolverregex und ist kein fachlicher Gegenbeleg. Der enge Testfix erhält Scope-/Tool-/Writeprüfungen, prüft aktuelle ausdrücklich aktivierte Handler und verlangt beim weiterhin unvollständigen Request `INVALID_REQUEST` sowie unveränderte Dokumentzeilen. Der bestehende breitere öffentliche Tooltest bleibt die gesonderte Domain-/FS-Abnahme.

Produkt-SHA-256: `7bb4acab8492bd4ed525cd4c5e8fd429fb2f145dc0e21df4e37cee52699122ad` (`app/lib/mcp/server/document-read-principal.ts`). Test-SHA-256: `6d4d81f8ead3c54a85dd2b97f60f52819f00a3ba7956e666772b4dfd458baf8c` (`scripts/direct-mcp-workspace-path-principal-postgres-test.ts`). Originalquelle: `6167fed7367df6199d19712f3830c4aa1104dd9f97b58a9ee08b4dc279d08413`.

Allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben ausgeschaltet. Der [vollständige Owner-/Live-/Terminalanschluss](./yjs-native-path-owner-integration-evidence.md) und die übrigen sieben Planblöcke bleiben gesondert offen.
