# Gemeinsamer nativer Dokumentlesedienst: lokaler Quell- und PG18-Nachweis

Stand 17. Oktober 2026. Ausgangscommit Root `8bbed1fe3e7d4024b3e7cfb1db1b4dc639562178` plus die zwölf unten gebundenen Quellen. Dieser Schnitt ergänzt den [internen ID-Lesekern](./yjs-native-document-id-read-evidence.md). Der Gesamtauftrag bleibt offen.

## Verhalten und Autorität

`app/lib/documents/service.ts` verbindet denselben nativen ID-Leser mit echten Web-Requests, tatsächlichen PI-Toolinvocations oder einem tatsächlich signierten Direct-MCP-Token. Der Dienst besitzt die einzelne Read-Committed/Read-Write-Transaktion und gibt Inhalt erst nach bestätigtem COMMIT und abgeschlossenem Checkout zurück. Unbestätigte COMMIT-, ROLLBACK- oder Abschlussbestätigungen liefern `READ_OUTCOME_UNCONFIRMED`; sie lösen keinen automatischen Wiederholungsversuch aus.

Der neue `POST /api/documents/read` verarbeitet eine begrenzte JSON-Auswahl und antwortet ohne Cache. Das globale Request-Objekt wird an die lokale NextRequest-Klasse angepasst; Cookie-/Bearerheader bleiben die echte Eingangsautorität. Die PI-Erweiterung beobachtet die ursprüngliche Invocation und den tatsächlichen Workspace; die vorhandenen generischen Principal-Kernfunktionen bleiben erhalten. Der Direct-MCP-Principal verwendet tatsächliche JWT-/JWKS-Prüfung, dieselbe bestehende Grant-SQL und aktuelle Sitzungs-, Account-, Seat-, Workspace-, Consent-, Widerrufs- und Toolfreigaben. Ein bloßes AuthInfo-Claimsobjekt verleiht keine Rechte. MCP-Scopes `knowledge:read` und `knowledge:search` bleiben getrennt. Dies führt keine neue externe REST-Bearerauthentifizierung ein.

Jede Seite prüft die aktuelle Autorität neu. Identität, vollständiger Yjs-Zustandsbeleg, Metadaten, Generation und Ausgabeformat binden den Cursor; Backend-/Transaktionsnummern und individuelle PI-Toolcall-IDs werden nicht zu einer sitzungsübergreifenden Inhaltsberechtigung. Der streng dekodierte, nicht signierte Cursor ist ausschließlich Vergleichsevidenz und kein Grant. Native JSON- und semantische Textausgabe bleiben auch bei gültigem, nicht als Markdown exportierbarem Rich-Inhalt möglich. Expliziter Markdownexport muss die strukturelle Rückprüfung bestehen. UTF-8-Seiten bewahren vollständige Codepoints und genaue Bytepositionen.

Lesen verwendet die ursprüngliche native ID unabhängig von Dateiendung oder vorhandener Markdownprojektion. Fehlender oder quarantänisierter Zustand fällt nicht auf alte Dateien zurück. Ein Projektionsstatus `current` verlangt den passenden finalisierten SQL-Receipt samt Revision, Generation, Sequenz und Hashes; bloß gleiche Zähler, insbesondere 0/0, genügen nicht. Die Receipt-Gegenprobe baut gezielt SQL-Fixtures auf und behauptet keinen tatsächlichen Dateiexport oder Projector-E2E-Erfolg.

## Tatsächliche Prüfungen

Alle aufgeführten Programme wurden von Root seriell gestartet und bis zum ursprünglichen tatsächlichen Prozessende beobachtet. Während der Läufe waren Quellen eingefroren; es liefen keine zusätzlichen Agenten-Compiler, Datenbanktests oder Builds.

| Prüfung | Tatsächliches Ergebnis | Original |
| --- | --- | --- |
| Vollständiges cachefreies TypeScript, 8 GiB | Exit 0, auch nach Testkorrektur | finaler Lauf |
| ESLint für alle zwölf Quellen, max-warnings 0 | Exit 0, auch nach Testkorrektur | finaler Lauf |
| Dokumentverträge | 9/9, keine fehlgeschlagenen/abgebrochenen/übersprungenen Fälle, Exit 0 | erster Lauf |
| Body-/Cursor-/UTF-8-Verträge | 10/10, keine fehlgeschlagenen/abgebrochenen/übersprungenen Fälle, Exit 0 | erster Lauf |
| Unveränderte bestehende Agent-Principal-Regression | 49/49 echte PG18-Familien, Abschluss nach Cleanup, Exit 0 | erster Lauf |
| Neue ursprüngliche PI-Invocation-/Workspacebindung | 26/26 echte PG18-Familien, Abschluss nach Cleanup, Exit 0 | erster Lauf |
| Öffentlicher Dienst und echte POST-Funktion | 21/21 echte PG18-Familien, Abschluss nach Cleanup, Exit 0 | finaler Lauf |
| Direct-MCP-Principal und tatsächlicher Dienstaufruf | 20/20 echte PG18-Familien, null externe Fetches, Abschluss nach Cleanup, Exit 0 | finaler Lauf |

Der erste tatsächliche Lauf endet mit Exit 1: Nach zwölf erfolgreichen Dienstfamilien erwartet die nächste Familie einen gültigen Owner-Read, erhält aber `AUTHENTICATION_REQUIRED`. Die vorherige Bansperre führt im bestehenden echten Auth-Seatguard zur Sitzungswiderrufung; das Testskript hatte nur das Konto reaktiviert. Die enge Testkorrektur prüft nun tatsächlich die gelöschten Owner-/Member-Sitzungen und erzeugt nach Reaktivierung eine neue Fixture-Sitzung. Vor der Suspended-Seat-Gegenprobe bestätigt sie zusätzlich einen positiven autorisierten Member-Read. Alle 21 Familien und ihre Negativprüfungen bleiben erhalten. Keine Produktquelle wurde zwischen beiden Läufen geändert; ausschließlich das neue Diensttestskript änderte sich. Der originale RED bleibt erhalten. Die unveränderten vier erfolgreichen Vertrags-/Principalprogramme wurden nicht nochmals ausgeführt.

Die echte Dienstmatrix umfasst Plain/XML/Blocks, native-only und umbenannte Dateien, unexportierbaren gültigen Rich-Inhalt, vollständige Unicode-Seiten, Delete-only-Yjs-Änderungen trotz identischem Statevector, Metadaten-/Umbenennungskonflikte, D2 am alten Pfad, Archive/Quarantäne, frischen Rechte-/Seatentzug, genuine PI-Aufrufe sowie tatsächliche Schema-/Generations- und späte Autoritätsänderungen. Die mechanischen Queryhooks bewahren ursprüngliche SQL und tatsächliche Ergebnisse. Abschlussfehler werden erst nach tatsächlichem COMMIT, ROLLBACK oder Release injiziert; die gespeicherte Commitprobe wird anschließend über eine eigene echte Verbindung gelesen.

Die MCP-Matrix verwendet das echte lokale Better-Auth-JWKS und `signJWT`, echte OAuth-/Workspace-/Seatdaten, den bisherigen Verifier-Wrapper, noch nicht zugewiesene Transaktions-IDs, Scope-/Resource-/Signatur-/Expiryfehler, Widerruf und Latest-Consent, aktuelle Runtime-/Tool-/Workspacefreigaben, tatsächliche SQL-Sperren sowie Backend-/Schema-/Lebensdauergegenproben. Der tatsächliche zentrale MCP-Service liest zusätzlich native JSON- und fünf vollständige UTF-8-Textseiten. D/L/S-/Metadatazeilen einschließlich xmin bleiben unverändert.

## Ursprüngliche Belege und Ressourcenabschluss

Erster Lauf: `/private/tmp/canvas-document-read-service-quality-dta81865`. Quellenfingerprint für 6939 erfasste Dateien: `170685fdb0400a649c1ba0d2914a7ce0b3ded31ac6d2d8147ce8db883bcd6d47`. Ursprünglicher Dienst-RED: SHA-256 `4dc312a71afc0ef7b2049b4efb6984567fbf5d1b32a0f8a04b4f7268bc4e7c33`.

Finaler Lauf: `/private/tmp/canvas-document-read-service-quality-si4vx_x2`. Quellenfingerprint für 6939 erfasste Dateien: `ee61fa6309823bebbec82131e0ee3efa8187c349de1340203e6665d936147e55`. Die tatsächliche vierteilige Queue sowie alle Kinder enden mit Exit 0. Dienst21-Original: SHA-256 `7fcf41963ef5a15c0e0acac51c32777ab2d315b669cab4f4c0b6ac7ab8c7f7c3`. MCP20-Original: SHA-256 `681baacd86629b0536fa70a314ab2a0268bc840b4f50b1e90c9c31e92a6418d8`.

Nach beiden ursprünglichen Prozessenden besteht ein separater Read-only-Ressourcencheck mit tatsächlichem Exit 0. Die erfassten eigenen Schema/OID-Bestände und Namen der DATA-Verzeichnisse entsprechen der jeweiligen Baseline; die geprüften Fixture-Anwendungssitzungen sind geschlossen. Die vier verwalteten Container behalten Identität, Startzeit und gesunden Laufzustand. Das ist kein vollständiger Prozesshistorien- oder DATA-Inhalts-/Inodevergleich. Es erfolgte keine pauschale Datenbank-, Container- oder Verzeichnisbereinigung.

Finale Baseline: SHA-256 `c6ae7cac1d980f6886d0b5a939d017ebbafba08ce1e4fe24c28a7b6fcbecf786`. Finaler unabhängiger Postcheck: SHA-256 `95247cecb509da950b8c57dadd5560fe468c30b704b5410095f23d256934fc20`.

## Gebundene finale Quellen

| Datei | SHA-256 |
| --- | --- |
| `app/api/documents/read/route.ts` | `6b419b229657f9c8dbbd925bd69bd50941f08276c0717a8f2a122e74825f791a` |
| `app/lib/documents/contracts.ts` | `b2d24467e25c501a8a2cf20c9c9cf9074f96a4e3b2ce6f7394da25b7c926141b` |
| `app/lib/documents/read-body.ts` | `f0f5a0c207855c5c344ecad1c8631e4a250906336edef12fbdc6188fec461cd6` |
| `app/lib/documents/read-continuation.ts` | `389dd1cc85f3178a03e1b8b778c77ab4ca908fa5c8b6503d2d4a038cdda8699e` |
| `app/lib/documents/service.ts` | `e8b8b5cf06d5ac36621cba88a2ca31a540b72055d6792bd48d7bbcfa177b8fb8` |
| `app/lib/mcp/server/access-token-verifier.ts` | `49092cd28c242f1bb82b47c7c6e09f8b822d1195982c2372e14c634b729e31b4` |
| `app/lib/mcp/server/document-read-principal.ts` | `9119492c80dbac719970745a6805fc24d63eb87ea4c2002368ab9a57f4ef9039` |
| `app/lib/workspaces/request-principal.ts` | `575080d29a217e5d57dc68757541430ccda834dc90a8235145426fb336160fa1` |
| `scripts/document-read-body-continuation-test.ts` | `e4b86fee24dd2602779d8d1a4cf79f2ddfcc3d8a24fbfc9030a8e7ee4770eca3` |
| `scripts/document-read-service-postgres-test.ts` | `91685182c44164d20b322b7c3417f57d6898e5019464e6363c50705b23f901e7` |
| `scripts/direct-mcp-document-read-principal-postgres-test.ts` | `25b3d755bbb7d063f8b63633598aee5e662a4e55d66835b0e3125f38c432b2cb` |
| `scripts/workspace-agent-tool-principal-original-origin-postgres-test.ts` | `b9b8c7cadd14c8754d36796135cec6a7bc3277b5c01c25cbf1708ae8ff6a5909` |

Die GitNexus-Prüfung vor dem Commit erfasst in beiden Worktrees die erwarteten 14 Dateien. Root meldet 19 bekannte berührte Symbole und LOW, QA sieben und MEDIUM mit zwei indirekten Upload-Flows. Versetzte alte Symbolbereiche und neue, noch nicht indexierte Funktionen begrenzen diese Auswertung; sie beweist keinen Nullradius. Der frühere Upstream-Impact der beiden gemeinsamen Agent-Principal-Einstiege war HIGH; die 49 unveränderten Agent- und 26 neuen Origin-Regressionen bestehen. Die bestehenden generischen Kernprüfungen und die Grant-SQL sind im Quellvergleich erhalten.

## Offene Abnahme und nächste Schritte

Dies ist eine Quell-/Funktions- und echte PG18-Dienstintegration. Die POST-Funktion wird direkt aufgerufen; es ist noch kein neuer kompilierter Next-/TCP-/Browsernachweis. Der Direct-MCP-Serviceaufruf ersetzt keinen registrierten MCP-Transport- oder PI-Tooldispatcher-E2E-Test. Die neue ID-Lesefunktion muss noch in den tatsächlichen Werkzeugkatalogen angeschlossen und dort aufgerufen werden.

Einheitliche progressive Suche, weitere Create-/Import-/Edit-Verträge und Mobile-/API-/MCP-/PI-Anschlüsse, externes SDK, Standard-Skill-Auslieferung, PDF-Nativeimport und verbleibende Sandboxpfade sind weiterhin offen. Aktuelles main, neuer Gesamtbuild, gemeinsame vollständige E2E-Abnahme und allgemeine Aktivierung bleiben weitere Gates. Dateiaktions-Undo bleibt für alle Formate ausgeschaltet; Review Center bleibt ausgeschaltet und außerhalb des Auftrags. Kein Push, PR, Containerbuild oder Produktionsrollout durch diesen Nachweis.

## Erster kompilierter HTTP-Abnahmeversuch

Die neue `tests/document-read-http.spec.ts` ist auf Root `32d6016bf9fe233d2ed64ed3225394fb14624c01` / QA `e8188afca9e457dbc2d75ca16380399a845eabe4` committed. Ihre vollständige Typprüfung und Scoped-Lint bestehen. Der unabhängige Quellenabgleich bestätigt 5518 Anwendungs-/Testquellen und den unveränderten ursprünglichen Drei-Dateien-Root/QA-Patch `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`. Der unveränderte Originalsupervisor startet tatsächlich einen frischen `npm run build`; dieser endet mit Exit 0. Ein separater Artefaktabgleich endet ebenfalls mit Exit 0. Build-ID `build-TfctsWXpff2fKS`, Buildfingerprint `38e28fadff3495f4e114806f5ddd3a08f164508b0b086034466efe6ae31d58f2`.

Der danach tatsächliche isolierte Produktionshost samt originalem Testissuer startet. Der passive Identitäts-/Ressourcenbaselinecheck endet mit Exit 0. Die Browserabnahme endet jedoch vor der Testregistrierung: Playwright verlangt für den ersten Callbackparameter die Destrukturierung; die neue fünfte Testdeklaration verwendet dort `_fixtures`. Der tatsächliche Report meldet **null deklarierte und null ausgeführte Fälle** bei Status `failed`. Originalsupervisor und gesamter Runtimewrapper enden mit Exit 1. Dies beweist keinen Fehler oder Erfolg des neuen HTTP-Lesedienstes.

Die enge Korrektur ersetzt ausschließlich diesen Testparameter durch `{}`. Alle sechs Familien und ihre Assertions bleiben erhalten. Auf dem korrigierten Testskript SHA-256 `36f2bdd9c99671aa7f3e010c173d88a936975e6fbfad403aa0a2dd3e7e3f9800` bestehen erneut vollständiges cachefreies TypeScript, Scoped-Lint sowie die reine Playwright-Registrierungsprüfung (`--list`) mit exakt sechs Fällen und tatsächlichem Exit 0. Diese Registrierungsprüfung startet weder einen Host noch die Testfälle und erzeugt ausdrücklich keinen Abnahmereport. Original: `/private/tmp/canvas-document-read-http-collection-tpajkowy`; ursprünglicher Listinglog SHA-256 `eb425e6bebdc3a670ff3282439e2da49fce51ba09d1aec92db9364219b3b3c01`. Für die vollständige neue HTTP-Abnahme bleiben ein neuer gebundener Build und der tatsächliche Sechs-Fälle-Lauf nötig.

Ursprüngliche private Belege: `/private/tmp/canvas-document-read-http-5kc46wut`. Sourcebericht SHA-256 `b43b7d51b456ae95a9cb519b29f45a1e055e26ad8645d4b02a1fcf9a6253fc7d`, Artefaktbericht `2cdbd302e309091ed16855a29d6b622c557d9e4bd0e2ea1360aeb9c402a8e3fd`, Originalbuildlog `7a9935d4c4d7b8f306753d19e2cd4ecf695b46db1141fee9e50a5c0cff812ab8`. Der unabhängige ursprüngliche Postcheck SHA-256 `a30f2e533d6666767651072589962017535161ddb413398b7e4cc50112017551` endet korrekt mit Exit 1: beobachtete eigene Prozesse/Gruppen und Ports sind geschlossen, Runlock fehlt, keine Backends verbleiben für die beiden Datenbanken, vier verwaltete Container und drei Gesundheitsendpunkte bleiben gesund. Der fehlgeschlagene Supervisor erhält jedoch beide eigenen Datenbanken sowie DATA/TMP zur Diagnose. Der ursprüngliche Fehlerlauf und sein Report werden nicht nachträglich zu einem erfolgreichen Lauf umgeschrieben.

Der anschließende gezielte Root-Ressourcenabschluss endet tatsächlich mit Exit 0: exakt beide ursprünglichen Datenbanknamen/OIDs/Owner/Marker und fehlende Sitzungen wurden vor jedem DROP frisch geprüft; nur die beiden eigenen DATA-/TMP-Verzeichnisse wurden nach FD-/Geräte-/Inode-/UID-/Markerprüfung relativ zum gehaltenen Verzeichnis entfernt. Danach sind beide Datenbanken samt OIDs, ihre Backends, DATA/TMP, die erfassten Prozesse/Gruppen/Ports und der Runlock geschlossen. Vier ursprüngliche verwaltete Container und drei Gesundheitsendpunkte bleiben gesund. Geschützte Originaldateien und historische Fehlermeldungen bleiben byte- und identitätsgleich; Original-Exit 1 und der gescheiterte Abnahmereport werden ausdrücklich nicht geändert. Privater Abschlussbericht: `/private/tmp/canvas-document-read-http-cleanup-htzwz2cu/cleanup-failed-report.json`, SHA-256 `94e993680e019759455a79a495bbbf193301c55e95cfac4147de7a183803ca7b`. Dieser Ressourcenabschluss ist kein bestandener HTTP-Test.
