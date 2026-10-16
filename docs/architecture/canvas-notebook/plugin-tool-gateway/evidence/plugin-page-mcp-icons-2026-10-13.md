# MCP-Logos: Nachtrag zur Plugin-Katalogabnahme

Stand: 13. Oktober 2026. Der separat beauftragte Logo-Nachtrag ist am Notebook-Commit `a99553e7f2d4456fe272c9ac5994c6b39412189b`, Tree `6379e36dc377bc9b4b529fb1769053194754cbd6`, lokal geprüft. Dieser Nachweis ergänzt die [historische Katalogabnahme](plugin-page-integration-catalog-acceptance-2026-10-13.md); deren Quelle, Hashes und Screenshots bleiben unverändert. Die [Chat-/Agent-Kontextplanung](../chat-extension-reference-plan.md) ist keine implementierte oder durch diesen Lauf geprüfte Erweiterung.

## Änderung

Composio verwendet weiterhin die Logo-Metadaten der Toolkit-API. Persönliche und lesbare gemeinsame MCP-Verbindungen sowie zulässige Definitionen bekommen eine exakte, bereichs- und quellengebundene Same-origin-Bildroute. Diese verwendet die bestehende geprüfte Logo-/Domain-Ermittlung einschließlich Root-Domain-Fallback. Discovery startet bei Bedarf am sichtbaren Bild, nicht während der Katalog-Textsuche.

Die Route prüft aktuellen Actor, Workspace, genaue Quelle und Bindungsstand erneut. Sie liefert ausschließlich geprüfte passive lokale Bildbytes; keine MCP-/OAuth-/ENV-Header werden an Bildserver weitergegeben. Geänderte Quelle, Rechteentzug, unzulässiges Bild oder fehlendes Logo liefern kein fremdes Ersatzbild. Der gemeinsame Avatar fällt auf Initialen derselben Auswahl zurück. Der Cache enthält positive und negative Ergebnisse mit begrenzter Lebensdauer und quellengebundenen Dateien.

Die wiederverwendete SVG-Prüfung wurde zusätzlich gegen nichtlinear laufende Muster gehärtet. Der isolierte E2E-Upstream-Proxy bindet sein Ziel vor dem Fetch an die genaue eigene Origin und erlaubte Pfade; normalisierte Doppel-Slashes oder Redirects können keinen Fremdhost erreichen.

## Frischer vollständiger Lauf

- Runner: `npm run test:plugins:extension-e2e`.
- Eigener Lauf: `/private/tmp/canvas-plugin-extension-e2e-v0v2IW`.
- Frischer `npm run build` mit TypeScript-Prüfung erfolgreich, danach tatsächlicher Node-Produktionshost aus diesem Stand. Kein neuer Docker-Testcontainer.
- Vollständiger Runner: Exit `0`, `PLUGIN_EXTENSION_E2E_PASS`.
- Browser: **15/15 bestanden**, ein Worker, keine Retries, keine übersprungenen, unerwarteten oder flaky Fälle.
- Start: `2026-10-13T20:05:04.377Z`; Dauer: `466257.944` ms.
- Neue erfolgreiche Bildprüfungen: persönliches MCP ohne vorgewärmte Icon-Metadaten in Detail und Liste; gewöhnlicher Nutzer sieht gemeinsames MCP-Logo ohne Manage-Recht; alte Bildreferenz nach Rechteentzug wird abgewiesen.

Der Lauf umfasst weiterhin alle kontrollierten Katalog-, Setup-, Settings-, Account-, Rechte- und responsiven Webfälle der historischen Suite. Er benutzt echte Notebook-APIs, PostgreSQL, HTTP/HTTPS und SDK-Transport mit eigenen Provider-/Registry-Fixtures. Er ist keine echte Canva-/LinkedIn-/Shopify-, Modell-, native Geräte- oder Produktionsabnahme. Die Build-Warnungen werden nicht als warnungsfreier Build ausgegeben.

## Zähler und Grenzen

| Quelle | Sichere Zähler |
| --- | --- |
| Browser | Runtimefehler `0`, verbotene Aufrufe `0`; zusätzlich `61` erwartete `net::ERR_CERT_AUTHORITY_INVALID`-Logo-Ladefehler der isolierten HTTPS-Fixtures mit Initialen-Fallback |
| MCP-Bilder | `6` Discovery-Reads und `6` Bild-Reads am eigenen Provider |
| MCP-Protokoll | `1` Initialisierung, `0` Toollisten, `0` Tool-Aufrufe, `0` unautorisierte MCP-Anfragen |
| Composio | `3` Zustimmungen, `2` Ablehnungen, `5` SDK-Links, `5` Callback-Redirects, `62` spätere Toolkit-Seitenzugriffe, `0` Businesscalls |
| HTTPS-Store | `189` Registry-Reads, `5` Archiv-Reads, `0` abgelehnte Requests; `0` erfolgreiche Registry-Icon-Reads |

Die Zertifikatsfehler sind ausdrücklich kein erfolgreicher externer Logo-Nachweis. Erfolgreiche MCP-Bilder werden über die Notebook-Origin ausgeliefert und in den genannten echten Browserfällen geprüft. Nicht implementierte Single-toolkit-/Auth-config-Fixturepfade sind durch diese 15 Fälle nicht separat abgenommen.

Fokussierte lokale Prüfungen bestanden separat: `test:plugins:extension-search`, `test:plugins:extension-avatar-ui`, `test:plugins:extension-icons`, `test:plugins:extension-runner`, die bestehende MCP-Icon-Regression und die isolierte tatsächliche PostgreSQL-/HTTP-Bildroute. Diese unterscheiden Metadatenprojektion, Cache/TTL/Coalescing, passive Bildprüfung mit Timeout-Regression, Bindungswechsel, Rechteentzug während I/O, native Routen und Fixture-Upstream-Canary. Die Canary-Prüfung meldet `0` Fremdhost-Aufrufe. Sie ersetzen keine Drittanbieter- oder Modellabnahme.

## Belege und Bereinigung

| Originalbeleg im privaten Laufverzeichnis | SHA-256 |
| --- | --- |
| `build.log` | `8e2fe418e8f28cc44348c8a545c73fe5a4cf68410f03c255d30f7fae498d1cc0` |
| `browser.log` | `d426cce626b424d4834c9e1bbdc30e97b8bd04a7fe8b3aeb95f294ef4367995e` |
| `playwright-results.json` | `97f88d376928df6ffc8c9d5a2a46b1bb81c7a6e21ebc62b78f5d414d24c2a52f` |
| `browser-proof.json` | `68d345cb4f7048b1627c6f320c8f07262f7b5486186cf3da3d75615ca50cb4b2` |
| `provider-proof.json` | `d31a8f70fc12e6a0b52d6e675b00f5f36130e1cddbcb326b2d484c64d49da9fe` |
| `recovery.json` | `eac6d7894ef65d8c9f13b6fc11831b28be03ee4bcacb9f3a5482f849964dffea` |
| `issuer-recovery.json` | `43d19bf96d92e54753b4e6c5929cb568339f22a451ae5ab1498fe8c2f000c94d` |

Notebook- und Control-Plane-Issuer-Receipt des vollständigen Laufs melden jeweils `phase: cleaned`, `databaseDropped: true`, `uncertain: false`. Private DATA-/Credential-/JSON-Dateien bleiben außerhalb des Repositorys.

Ein vorheriger eigener Lauf wurde vor Browserstart zur Sicherheitskorrektur abgebrochen. Sein ursprüngliches unsicheres Recovery-Receipt bleibt erhalten; eine separate `manual-cleanup.json` dokumentiert die anschließend geprüfte Entfernung ausschließlich seiner nonce-, Owner- und Marker-gebundenen Datenbank, ohne aktive Clients. Das ist keine erfolgreiche Browserabnahme dieses abgebrochenen Laufs.

Remote-CI, Veröffentlichung auf `main` und Deployment sind durch diesen lokalen Nachweis nicht bestätigt.
