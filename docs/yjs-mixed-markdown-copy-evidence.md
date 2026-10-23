# Gemischter Markdownbestand: tatsächlicher Copy-Anschluss

Stand: 19. Oktober 2026. Ausgangspunkt Root `936c8febc`, QA `9f82e2c00`. Dieser Nachweis betrifft den Copy-Anschluss mit unveränderten physischen Markdownquellen. Er schließt M1 und die Produktionsfreigabe nicht.

## Verhalten und Grenzen

Der tatsächliche Copy-Owner wählt bei physischen Markdownquellen den additiven Vertrag Copy-Evidence 4 / Managed-Plan 4 / Stage 5. Quellen- und Zielprüfung, historische Datenwiederholung, B1, Dateiveröffentlichung und B2 verwenden den vollständigen Bestand. Native Notizen und Scenes werden über ihre bestehenden zentralen Provider kopiert; eine unselektierte rohe Markdown-Datei darf lesend beteiligt bleiben. Die Quelle benötigt ausschließlich Leserechte und wird weder initialisiert noch geschrieben.

Die vollständige Abschlussprüfung enthält rohe Links, Aliase und Selbstlinks. Katalogabhängige physische Link-IDs werden erst nach Prüfung des tatsächlichen aktuellen Katalogs und Rücknahme genau der belegten nativen Klongeburten korreliert. Native Klon-IDs, Block-ID-Zuordnungen, Scene-IDs und Lineages bleiben an echte Providerbelege gebunden. Es werden keine physischen Quellen als native Dokumente ausgegeben.

Ausgewähltes rohes Markdown benötigt weiterhin den echten Zielimport und die vollständige Linkzuordnung; dieser Anschluss folgt separat. Relevante Auflösungsänderungen in unveränderten physischen Quellen werden vor Seiteneffekten abgewiesen. Der neue interne Fehler `MANAGED_COPY_PLAN_IMPORT_REQUIRED` erhält einen verständlichen Web-/PI-Hinweis und wird im öffentlichen MCP-Vertrag auf das bestehende `COPY_NATIVE_REQUIRED` mit Status 409 abgebildet.

Historische Native-Pläne 1/2, Copy-Evidence 3, Managed-Plan 3 und Stages 2/3/4 bleiben eigenständige Verträge. Die historischen Store-APIs bleiben formatstreng. Neue und alte Formate werden bereits vor dem Speichern eines Recovery-Verzeichnisses unterschieden. Der neue Graph-Aufruf ist ausdrücklich von der bisherigen V2-Schnittstelle getrennt.

## Ausgeführte Prüfungen

- TypeScript und gezieltes ESLint: grün.
- 127 bestehende Node-Testfälle: 27 Native-Plan V1, 32 V2, 22 Graph, 15 Stage, vier Stage-Header und 27 Stage-Validierung; keine übersprungenen Fälle.
- Tatsächliche bestehende PostgreSQL-Folgen: Copy-Owner 26/26, Metadaten 15/15, MCP-Owner 10/10, Managed-/Scene-Owner 7/7. Diese Matrix lief vor der letzten gezielten Meldungs-/MCP-Codeanpassung; der Copy-Ausführungskern blieb anschließend unverändert.
- Neue echte MCP-Service-/PG18-/FD-Folge zweimal 10/10, zuletzt auch mit der endgültigen Fehlermeldung und Codezuordnung. Echte READ-only-Quelle, native Notizen und assetlose Scene, rohe Alias-/Selbstlinks, Klon-/Block-/Scene-ID-Zuordnung und portable Scene-Datei, Same-workspace-Copy, relevante Auflösungsänderung, ausgewähltes Raw, veraltete Vorschau, echte verlorene B1-COMMIT-Bestätigung und Wiederaufnahme unter erneuerter Sitzung. Der unabhängige Leser sieht vor dem injizierten Bestätigungsverlust die ursprünglichen nativen und Scene-Belege im tatsächlichen B1-XID. Wiederaufnahme verwendet dieselben IDs und ursprünglichen Actor-/Session-Bezüge.
- Ein gültiger neuer Stage-Input wird gezielt über die historische Store-API aufgerufen. Exaktes `STAGE_CONFLICT`, vollständige Domainzeilen einschließlich `xmin` und der gesamte DATA-Baum einschließlich Bytes und Identitäten bleiben unverändert.
- Acht mechanische MCP-Vertrags-/Formattergruppen einschließlich tatsächlicher neuer Fehlerklasse, Status 409 und unverändertem öffentlichen Fehlerformat: grün. Dies ist kein eigener Autoritäts- oder Ausführungsnachweis.
- Tatsächlicher moderner MCP-HTTP-Dispatcher: 6/6 mit signierten JWTs, aktuellen Grants, PG18/FDs und echten Service-Ereignissen, einschließlich erneuerter Sitzung, Wiederaufnahme und Rechteentzug. Kein TCP-, OAuth-Freigabe-, SDK- oder UI-Nachweis.
- Der gesamte emittierte JavaScript-Code des historischen Native-Plan-V1/V2-Moduls ist vor/nach den zwei strukturellen Typanpassungen bytegleich, SHA-256 `5a4f851eec454d55ee50a2a57ba33f53289faf9e3f485dd1be685a8d96682ea2`. Historische Native-Evidence-Quelldatei unverändert: `d6c297fa0230bb19bb8145bca5c553f75d577de31e537d22af706c292f54afe8`.

Die neue Folge verwendet echte signierte Fixture-JWTs, aktuelle Grants/ACL, den öffentlichen MCP-Service, Original-Owner, PostgreSQL und tatsächliche FD-Veröffentlichung. Sie ersetzt keine OAuth-Freigabe, TCP-/Browserabnahme, SDK-Abnahme oder Prüfung der ursprünglichen Produktionsdatei.

## Originalbelege und Review

Private Originalausgaben und Quellenpins liegen unter `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-copy-v4-lzcovdnu`:

- `pure/`: TypeScript, Lint und die 127 Node-Fälle, Original-Exit 0.
- `validation3/`: erste grüne gemischte Zehnerfolge in 49,941 Sekunden; der anschließende alte Owner-Test scheiterte noch an seiner bisherigen Fehlercodeerwartung. Original-Gesamt-Exit ausdrücklich 1; unabhängiger Ressourcenabschluss vorhanden.
- `validation4/`: gesamte bestehende PG-Matrix, alle Original-Exits 0 und Quellenpins unverändert. `validation-terminal.json` SHA-256 `a529b70c55170b8674ea2de93a8f202543c6cf6f7bde6588ff8172393a4b715f`, unabhängiger Ressourcenbericht `375a3ec7d242f7db06759276e9d7ad5b8586bdda59f2dffd491bb3b895b3290c`.
- `validation5/`: endgültige gezielte Abnahme nach der Fehlermeldungs-/MCP-Anpassung; TypeScript, Lint, acht Vertragsgruppen, gemischte Zehnerfolge (49,523 Sekunden) und tatsächlicher HTTP-Dispatcher (75,553 Sekunden) grün. Quellenpins unverändert, alle Original-Exits 0. Terminalbericht SHA-256 `e4141f30f97b6d0e9d1e4a01b7303622772846be88bce708a4719f1c022adf7e`, unabhängiger Ressourcenbericht `20f93cb57926e9c2dd3a3eb9de303c0e267dd3322606c1614bbaf70f608eb2f4`. Tatsächlicher neuer Testquellenstand `3b51351b3a78d18e8a46531a96079ca896f4532c917e88451e49f1cc8fae8299`.

Die ursprüngliche Roh-Gegenprobe bleibt unter `raw-gate-current/` mit ihrem tatsächlichen Exit 1 erhalten: Der neue Copy-Vertrag erreichte den Owner, aber ihre alte feste Versionsassertion erwartete weiterhin Plan 3. `raw-gate-v4/` prüft den bewusst neuen Plan 4 samt zusätzlichem echten physischen Quellenbeleg; weder die drei Readiness-Erwartungen noch ein NoWrite-Orakel wurden abgeschwächt. Ergebnis: Copy bereit / Move bereit / Delete weiterhin `NATIVE_SOURCE_IMPORT_REQUIRED`, alle sechs vollständigen NoWrite-Pakete grün. Tatsächlicher Gesamt-Exit weiterhin 1 nach 27,232 Sekunden. TypeScript und Lint sind grün; unabhängiger Ressourcenabschluss vorhanden. Die historischen Ausgangsquellen liegen zusätzlich unter `before/`.

Die unabhängige Kontrolle bestätigt für die bisherigen PG-Läufe entfernte eigene Schemas/OIDs, geschlossene eigene Verbindungen, entfernte DATA-Verzeichnisse und beendete Originalprozesse. Die vier verwalteten Dienste bleiben unverändert gesund. Es wurde kein Container gebaut, gestartet oder ersetzt.

Fehlgeschlagene erste Prüfungen bleiben erhalten: ein Test-Typinferenzfehler, ein falscher Workspace-Spaltenbezug der Projektionstabelle und die alte allgemeine Fehlercodeerwartung. Der Projektionenvergleich nutzt nun die echte Zuordnung über Dokument-IDs; kein Quellen- oder NoWrite-Orakel wurde entfernt.

Parallele reine Quellenreviews fanden und schlossen zwei Integrationsbefunde: native Katalogvergleiche müssen erlaubte Projektions-/Registry-Uhrfortschritte erst nach vollständiger aktueller Prüfung semantisch normalisieren; Store-Formatfehler müssen vor der Persistierung scheitern. Ein früher Budgetbefund im privaten Plan-Kandidaten wurde vor Integration korrigiert. Compiler, Tests, Datenbank und Git wurden vom Root ausgeführt.

## Verbleibende MVP-Gates

Delete bei gemischten Beständen, tatsächlicher Raw-Import samt Linkzuordnung, die ursprüngliche Produktionsgegenprobe, der alte Copy-Overwriteweg und der PI-Copy-and-rename-Fallback bleiben offen. Letzterer überspringt bei anderem Zielbasename den zentralen Service und erreicht noch `fs.cp`; die neue zentrale Copy-Abnahme darf nicht als Beleg für diesen Pfad verwendet werden. Danach folgen Produktionsaktivierung, interner zentraler Create-Schreibweg, tatsächlicher Linux-Sandboxnachweis sowie gemeinsamer Build, UI-/E2E-Abnahme, PR/CI/Review und Auslieferungsprüfung. Dateiaktions-Undo und Review Center bleiben aus.
