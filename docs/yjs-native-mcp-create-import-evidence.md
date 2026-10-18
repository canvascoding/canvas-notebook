# Native Markdownanlage und Import über registrierte MCP-Tools

Stand: 18. Oktober 2026. Dieser Anschluss verbindet `create_knowledge_source` und `import_knowledge_file` für `.md` und `.markdown` mit der vorhandenen authentifizierten nativen Create-/Import-/Projektionsengine. Er ist unter dem bisherigen Aktivierungsgate implementiert; im normalen Root bleibt das Gate aus. Ein externes Python-SDK oder die vollständige HTTP-/OAuth-/Browserabnahme ist damit noch nicht geliefert.

## Verhalten und Autorität

Der feste Einstieg verwendet den echten MCP-Schreibprincipal, aktuelle Tool-/Workspace-/Schreibrechte und dieselbe geprüfte SQL-Verbindung. Es werden keine Webrequests aus Tokenclaims gebaut und keine vom Aufrufer gelieferten Authoritycallbacks akzeptiert. Ein privater Aufruf- und Phasenkontext bindet die tatsächlichen Birth-ACKs an die bereits gehaltene Verbindung; ein verschachtelter ACK darf keine zweite Principalphase eröffnen.

Das vorhandene Workspace-Flock koordiniert auch tatsächlich getrennte Prozesse. Vor Source-I/O werden native und Legacy-Originale derselben stabilen Operation geprüft. Ein vorhandenes Legacy-Original bleibt auf seinem bisherigen Pfad. Ein nativer Claim darf nicht von einem TXT-/Legacywriter übernommen werden. Zwei vorhandene Originalformen verlangen `MCP_INGEST_RECOVERY_REQUIRED`; ein einzelnes abweichendes Legacy-Original bleibt `MCP_INGEST_IDEMPOTENCY_CONFLICT`.

Neuer Text und die tatsächlich vom bestehenden sicheren HTTPS-Downloader gelieferten Importbytes erhalten einen exakten Hash-/Größenbezug sowie begrenzte Provenienzmetadaten. Daraus entstehen native Dokumentidentität, Yjs-Zustand, Importreceipt, privater Birth-Claim, kontrollierte Projektion und erste Agentrevision. Die bestehende History wird als `external_import` erfasst, sofern ihre eigene Policy aktiv ist. Eine abgeschaltete History gilt ausdrücklich nicht als Erfassungsbeleg. Der Pythonhelfer bereitet die tatsächlichen Dateibytes vor; die Veröffentlichung bleibt an die bestehenden FD-/Owner-/SQL-Grenzen gebunden.

Ein erneuter Aufruf mit aktueller Session B desselben Users und Clients kann dieselbe ursprüngliche Operation bestätigen oder fortsetzen. Die echte ursprüngliche Session A bleibt in Intent, Receipt und Agentattribution erhalten; ihre alte Autorität wird nicht wiederverwendet. Abgeschlossene Wiederholungen prüfen den vorhandenen nativen Zustand, Birth, Projektion und Revision vor jedem erneuten Download. Ein noch offener Import lädt erneut und muss mit den ursprünglichen Bytes und Metadaten übereinstimmen. Ein gleicher Host-Datei-Identifier allein genügt nicht.

## Geprüfte Quellen

Die aktuellen Quellen sind gegen das private Manifest `engine-final-type-source-manifest-v6.json` geprüft, SHA-256 `e00823d5b56b66c7f15b70e2c2ea2982239519f74d26c9d29e256489578646c6`. Die sechs Produktpins lauten:

| Datei | SHA-256 |
| --- | --- |
| `app/lib/collaboration/markdown-file-import-persistence.ts` | `8bef9104be6c100d9a63c4ea9d58d2f1862b23b72db59567278fd04187b07102` |
| `app/lib/files/markdown-create-birth.ts` | `bd59dcd1177ac469a7395b0f27bfaa858ec8f741153eda45fb1962ccc7e27d3d` |
| `app/lib/mcp/server/document-read-principal.ts` | `7079a3c90c02fc969487ada5bd585505435154708390ad4dc0878a2fd49e686e` |
| `app/lib/mcp/server/file-ingest.ts` | `d3e2e3935d89234c4b7483b605a141eb607876bc45051f6d0b8689d45ef331fc` |
| `app/lib/mcp/server/ingest-tools.ts` | `0f4b49d37086e4572a665ad0c4992b45d5a059c7f4b4e8c2ed334d53ccc0c0b5` |
| `scripts/runtime/markdown-create-birth.py` | `7e34610e172c3eb6b91b07a4e76fa30e23998510a3ac2e8f717436575e902835` |

Die neue tatsächliche Folge `scripts/direct-mcp-native-markdown-create-postgres-test.ts` hat SHA-256 `78d419c6e688e8c3b42a00467b1e018b4ee4f18ae382794fae9ea65637d8b70f`. Alle 14 Manifestpins sind nach den abschließenden Regressionen unverändert. Gegenüber dem echten 10/10-Lauf änderte sich danach ausschließlich ein nicht emittierter TypeScript-Memberindex; tatsächliche esbuild-Transformation vor und nach dieser Korrektur ergibt bytegleiches JavaScript, SHA-256 `7927c44279923420d5feaacb244ab67ae95812482a04f496b987680b441ec331`.

## Tatsächliche Abnahme und Gegenproben

Originalbelege und Ressourcenprotokolle liegen unter `/private/tmp/canvas-native-mcp-create-3da14de86-pez2gd_z/`. Die Tabellenwerte sind tatsächliche Prozessausgänge; negative Originalläufe bleiben erhalten.

| Prüfung | Ergebnis | Originalbeleg SHA-256 |
| --- | --- | --- |
| Neue native MCP-Folge, Session 57303 | Exit 0, 10/10 registrierte MCP-/PG18-/FD-/Prozessgruppen einschließlich echtem öffentlichen HTTPS-Import | `937f031d8a7c128fe1aa9a8e218d32cb7450350c9d17640cba184130d348607c` |
| Vorherige Doppeloriginal-Gegenprobe, Session 56048 | Exit 1, 9/10; letzter Fall beobachtet tatsächlich falsche Konfliktklassifikation. Dieselbe Assertion besteht nach der engen Korrektur | `cbd2b5202c9f12e0430f227027916b05f0c2ed6aec4bd77803df2fbe3f20dcea` |
| Bisherige erste Webprojektion, Session 72642 | Exit 0, 15/15 unveränderte Auth-/SQL-/FS-Gruppen | `ebd0203196ca816b79059c9f406966c962fafdaaa0029b67fe876648f4106c20` |
| Bisherige manuelle Web-/Mobile-Anlage, Session 65489 | Exit 0, 14/14 tatsächliche Routen-/Auth-/SQL-/FS-/Prozessgruppen | `8a4465a4d5746a0c1263fc57b80f6051942e86bf03bd3c1059d54e14c680887f` |
| Bisherige registrierte ID-Reads, Session 26560 | Exit 0, 15/15 MCP-/PI-Gruppen | `6265eca967690df6ef8310e4dcf9e54410ffbaef2305bdcc54408f0bf41b2ce4` |
| Bisherige registrierte progressive Suche, Session 31347 | Exit 0, 6/6 MCP-/PI-Gruppen | `38f4f0cfe57ff4385d40844d3c209e48d30edaa5e524637bf4052d7f509cf4c5` |
| Fester Create-Principal, Session 5257 | Exit 0, 8/8; danach ausschließlich der oben bezeichnete nicht emittierte Indexfix | `05e88f27b55ccfc37f364ca50f94ff4f0f13d8ab92276b013647991ee56e0925` |
| Vollständige cachefreie Typprüfung, Session 43837 | Exit 2, exakt 69 bytegleiche geerbte Main-Diagnosen, keine neue Diagnose | `f87d64a219dd9317c7a22890a2687240cbf81b79851e829dd8117faa2ea561e3` |
| Scoped-Lint, Session 14871 und finaler Principalindex Session 67861 | Beide Exit 0, keine Ausgabe; übrige geprüfte Quellen unverändert | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Die zehn neuen Gruppen prüfen tatsächliche registrierte Create-/Importaufrufe und versionsgebundene ID-Reads, leere und nicht normalisierbare Quellen mit BOM/CRLF/Unicode, erneuerte echte Fixture-Sessions, getrennte OS-Prozesse mit echtem Flock, erhaltene Legacy-Originale, tatsächlich getötete Vorbereitung vor Veröffentlichung und Wiederaufnahme, beschädigte Claims sowie ungültige Eingaben. Beim HTTPS-Import werden unveränderliche öffentliche README-/LICENSE-Bytes verwendet. Der offene Import weist gleiche Host-Datei-ID mit anderen tatsächlich geladenen Bytes ab; ein neuer authentifizierter Fixture-Aufruf setzt nur die Originalquelle fort. Abgeschlossene Imports werden mit einer ungeeigneten neuen URL bestätigt, ohne diese herunterzuladen. Vor-/Nachbeobachtungen erhalten ursprüngliche Zeilen samt `xmin`, Claim-/Projektionsbytes und Attribution. Die Doppeloriginalgruppe richtet ausdrücklich einen beschädigten Testzustand ein; sie behauptet nicht, dass reguläre Writer beide Originale erzeugen.

Die Fixtures melden bzw. prüfen geschlossene eigene Clients, entfernte eigene Schemas und DATA sowie entfernte Runnerbundles. Die neue MCP-Folge benutzt den realen registrierten Webstandardtransport und echte Fixture-JWT-/SQL-Autorität, aber keinen TCP-Host und keine echte OAuth-Ausstellung. Der öffentliche HTTPS-Downloader wird tatsächlich ausgeführt. Diese Beleggrenzen dürfen nicht zu einer kompilierten HTTP-/OAuth-/Browserabnahme umgedeutet werden.

Der frühere vollständige Webprojektionslauf mit PostgreSQL `25P04`, die gezielte unveränderte erfolgreiche Gegenprobe und der neue erfolgreiche vollständige Lauf bleiben getrennte Belege. Der erfolgreiche Folgelauf beweist nicht die ursprüngliche Fehlerursache. Auch frühere Heap-/Hostabbruch- und Compilerfehler werden durch den finalen Typvergleich nicht als erfolgreiche Prüfungen umgeschrieben.

## Weitere Arbeit im selben Auftrag

Für diesen MCP-Anschluss fehlen noch frischer Produktionsbuild und tatsächliche kompilierte HTTP-/OAuth-/Browserabnahme einschließlich neuer Anmeldung beim selben Client. Der öffentliche gemeinsame Mutationsergebnis-/Versionsvertrag und native ID-/Versionsbearbeitung, PI-/Python-Anlageadapter, externes SDK samt öffentlicher Dokumentation, Core-Skill, PDF-Anlage und übrige Sandboxwege bleiben offen. Der vorhandene Python-FD-Zugang ist kein externes SDK. Der Gesamt-E2E und die allgemeine Aktivierung bleiben erforderlich; Dateiaktions-Undo und Review Center bleiben aus.
