# Plugin-Seite: gemeinsame Katalogsuche und Einrichtung

Stand: 13. Oktober 2026. Die Schritte 1–5 des [UI-Katalogplans](../plugin-page-integration-catalog-plan.md) sind implementiert und am unten gepinnten Stand mit frischem Produktionsbuild und 15/15 Browserfällen lokal abgenommen. Die Settings-Katalogmigration ist eingeschlossen. Die gesonderte Runtime-/Provider-/Geräteabnahme bleibt offen.

Die folgenden Daten bleiben historische Belege dieses gepinnten Stands. Der spätere [MCP-Logo-Nachtrag mit eigener frischer 15-Fall-Abnahme](plugin-page-mcp-icons-2026-10-13.md) ergänzt sie; Chat- und Agent-Kontext bleiben gesonderte Planung.

## Geprüfte Quelle und Build

- Notebook-Commit: `dc20226b1308f564236ba95799640c1c7e097db5`.
- Git-Tree: `13c1e606f785acdda72dff4fa8df48b8d1118ee9`.
- Frischer `npm run build`, anschließend der tatsächliche Produktionshost aus dieser Arbeitskopie; keine Wiederverwendung eines alten Testcontainers.
- Build-ID aus dem ausgestellten Fixture: `build-TfctsWXpff2fKS`.
- Eigener Lauf: `/private/tmp/canvas-plugin-extension-e2e-l9OOkE`, Runner `test:plugins:extension-e2e`.
- Ursprünglicher vollständiger Runner und Browserlauf: Exit `0`; 15/15 Fälle bestanden, ein Worker, keine Retries, kein übersprungener oder flaky Fall. Browserstart `2026-10-13T18:29:15.654Z`, Dauer `435322.086` ms.

Der Build enthält weiterhin Node-localStorage- und dynamische Dateisystem-Tracing-Warnungen. Sie werden nicht als neue Fehler oder als warnungsfreier Build ausgegeben. Die folgenden Hashes identifizieren die gepinnten Git-Dateien und erhaltenen Belege; sie sind kein vollständiges Byteinventar aller Build-Artefakte.

| Git-Datei an diesem Commit | SHA-256 |
| --- | --- |
| `app/lib/plugins/plugin-extension-search.ts` | `7e2afeab84f2e99818617c18ee0fa9225033c43a404878d443cde377f2c4536e` |
| `app/lib/plugins/plugin-extension-integrations.ts` | `ba82b803975acceee702d1b5822cae2f2e05e9b2ffbccb77d6bb6e11563ea3b2` |
| `app/components/plugins/PluginExtensionWorkspace.tsx` | `7d46ed3b9b907cdd9b566ac2a2d39e9dad48f22f46fd02b0c2b10efd928c1ed3` |
| `app/components/plugins/PackageRequirementsSetup.tsx` | `baaceebea3411305ac1f067e8d65470dff9eaec1199ffa8e957f1b75ea5b6c9d` |
| `app/components/settings/ConnectedAppsPanel.tsx` | `38ac4867f1a6628f6d342d1d85a3a8ccf3a93294282d78d8db0990239945499f` |
| `app/components/settings/ComposioProfileSwitcher.tsx` | `3b0669642541f51c24a75713b37a4358457e0386d4882a3a5e30d1f32da57b00` |
| `scripts/run-plugin-extension-e2e.mjs` | `69e6037bdbf51c6039fcdded71e206768521d9986e6181fe34f04f94e23e2968` |
| `tests/plugin-extension-search.e2e.spec.ts` | `d980de7d687ce5983b8bd397844afc8e9435b3e9323a9f1a897c7ef2852c0d98` |

## Tatsächliche Browserabnahme

Die Suite bedient die tatsächliche Plugin-Oberfläche und bestehende Formulare. PostgreSQL, Ressourcen-/Verbindungsrechte, Archive/Installation, Agent-Konfiguration und HTTP-/SDK-Verbindungen laufen über echte Notebook-APIs. Provider, Store-Registry und Consent-Endpunkte sind ausschließlich eigene kontrollierte HTTP-/HTTPS-Fixtures. Es gibt keinen Browser-Katalogmock und keine Ersetzung der Notebook-Suchroute. Dieser Nachweis ist deshalb eine UI-/API-/Transportabnahme mit Fixtures, keine erfolgreiche Anmeldung bei Canva, LinkedIn, Shopify oder einem anderen externen Produktivkonto.

| Fall | Tatsächlich geprüfter Bedienweg |
| --- | --- |
| 1 | Persönlichen MCP-Zugang hinzufügen; eine Suche liefert Plugin, Skill, Composio und MCP; Filter/Detail/Back behalten Begriff und Fokus. |
| 2 | Zweite Composio-Katalogseite finden; no-auth startet keinen OAuth-Flow; einzelnen Skill unabhängig installieren. |
| 3 | Gemischte Pagination anhängen und nach exakter ID deduplizieren; Suchänderung verwirft den alten Cursor. |
| 4 | Plugin aus geprüftem Store-Archiv installieren; erforderliche/optionale Einrichtung und exakte Paketrückkehr. |
| 5 | Tatsächlich bearbeitete Shared-MCP-Entwürfe bei abgebrochenem Bereichswechsel oder lokalem Back erhalten; bestätigtes Verwerfen erzeugt keinen Write. |
| 6 | Composio-Paketanforderung nach Consent-Ablehnung und -Zustimmung wiederaufnehmen; persönliches MCP über seinen Browser-OAuth-Weg autorisieren. |
| 7 | Nur im Manifest deklarierte OAuth-Pflicht bei gemeinsamem MCP übernehmen; neue exakte Auswahl nach Refresh und tatsächlichem Fixture-Consent behalten. |
| 8 | Eigenständige Composio-Verbindungen für Organisation und Team einrichten; Referenzen, Rückkehr und getrennte Use-/Manage-Rechte erhalten. |
| 9 | Gemeinsames MCP autorisieren; exakter Vorlagenmatcher, gewöhnlicher Nutzer, Datenschutz und Rechteentzug. |
| 10 | Gewöhnlicher Nutzer sieht berechtigte gemeinsame Instanzen ohne private Backend-Identitäten, versteckte persönliche Accounts oder Verwaltungsrecht; Entzug entfernt Zugriff. |
| 11 | Passende vorhandene Verbindungen wiederverwenden; optionales GitHub getrennt halten; enthaltener Skill behält Plugin-Herkunft. |
| 12 | Vorhandene Agent-Verwaltung öffnen und die exakte veröffentlichte Plugin-Version an einem tatsächlich bearbeitbaren Agenten speichern. |
| 13 | Tatsächlich ausgefallene Upstream-Store-Quelle lässt MCP-/Composio-Ergebnisse bestehen; Teilabdeckung und Retry funktionieren. |
| 14 | DE/EN, 1280-px-Desktop und 390-px-Browseransicht, hell/dunkel: genau eine Suche, bedienbare Filter und kein horizontaler Überlauf; Paket-/MCP-Einrichtung eingeschlossen. |
| 15 | In Settings ein persönliches Profil tatsächlich erstellen und auf den aktuellen Workspace anwenden; denselben Katalog im aktuellen Profil-/Workspace-Kontext öffnen; das genaue ursprüngliche Profil wiederherstellen. |

Die schmale Browseransicht ist keine neue native iOS-/Android-Abnahme. Der Agent-Konfigurationsfall speichert die konkrete Bindung; er führt keinen Modellauftrag oder fachlichen Provider-Aufruf aus.

## Abgenommene Settings-Migration

Die Settings-Migration ist in `ece867781b034b18b7f76615c6c9d8522623fb0c` enthalten. Der abschließende 15-Fall-Runner hat diese Änderung im oben gepinnten Stand vollständig geprüft. Der vorherige 14-Fall-Lauf an `fb0fa1f9a558247bbf4bac6e6eec22598b6864cc` war die Grundlage vor der Settings-Migration; der hier dokumentierte neue Lauf ersetzt seinen UI-Abnahmestand.

Settings öffnet den gemeinsamen Katalog mit Integrationsfilter und aktuellem Workspace statt einer zweiten Toolkit-Liste. Providerstatus und Profilverwaltung bleiben verfügbar. Gehaltene HTTP-Antworten, Profilwechsel und gezielte zentrale System-PATCHes sind in `test:plugins:extension-settings` geprüft: Client-/React-Fixtures bleiben von der tatsächlichen ENV-Route, ihrem Admin-Prädikat und dem verschlüsselten isolierten Dateispeicher getrennt. Die API-Prüfung bestätigt den neuen Schlüssel in derselben zentralen Integrationsprojektion, die der Composio-Client liest; fremde zentrale und persönliche Schlüssel bleiben erhalten. Test-Session, Audit und MCP-Invalidierung sind ausdrückliche Harness-Grenzen, kein Produktivnachweis.

## Verträge und korrigierte Ursachen

Die gemeinsame Projektion prüft den aktuellen Actor-/Workspace-Kontext nach Katalog-I/O erneut. Composio-Accounts werden im ursprünglich beobachteten wirksamen oder ausdrücklich gebundenen Profil revalidiert; diese privaten Kontext-/Entity-Revisionsdaten bleiben außerhalb der DTOs. Persönliche MCP-Status-/OAuth-Abfragen verwenden die tatsächliche gespeicherte Credential-Besitzzuordnung. Autorisierung wird von zuletzt geprüfter Erreichbarkeit und Use-/Manage-Rechten getrennt.

MCP-Anforderungen verwenden den exakten aktuellen Paket-/Eltern-Snapshot und vergleichen tatsächlichen Endpoint beziehungsweise STDIO-Konfiguration. Anzeigenamen sind keine Verbindungsidentitäten. OAuth-Pflicht aus dem Manifest oder der gesäuberten Konfiguration wird auch im gemeinsamen Formular berücksichtigt. Paket-Verbindungsänderungen laden den Katalog ohne Paket-Remount neu; eigenständige Integrationsdetails aktualisieren ihre eigene genaue Auswahl und laden den Gesamtkatalog bei Back nach. OAuth-Rückkehr wählt nur eine frisch passende exakte Referenz des gleichen Pakets/Workspace aus; ein Rückkehrmarker bestätigt keine Autorisierung.

Die Store-Vorschau berücksichtigt den verifizierten temporären Archivordner, während Name/Version/Checksumme weiterhin unabhängig geprüft werden. Installierte Bilder verwenden aktuelle exakte Resource-/Parent-Read-Rechte und Quellenrevisionen. Öffentliche deklarierte HTTPS-Bilder erhalten einen geprüften Redirect; lokale passive Bildbytes werden aus der erfassten Quelle gelesen. Fehlende kleine Bilder können auf eine vorhandene größere Deklaration zurückfallen. Cached MCP-Logos werden nur für die autorisierte genaue Verbindung, passenden aktuellen Origin und gültigen Abrufzeitpunkt verwendet; es erfolgt keine neue Icon-Discovery. Fehlende/fehlgeschlagene Bilder zeigen Initialen derselben Auswahl.

## Zähler und Fehlergrenzen

Die sicheren `browser-proof.json`-/`provider-proof.json`-Zähler des vollständigen Laufs melden:

| Quelle | Zähler |
| --- | --- |
| Composio-Consent | 3 Zustimmungen, 2 Ablehnungen, 5 SDK-Link-Anfragen, 5 Callback-Redirects |
| Composio-Katalog | 63 Zugriffe auf die spätere Toolkit-Seite |
| MCP-OAuth | 3 Registrierungen, 5 Consent-Aufrufe, 3 Zustimmungen, 2 Ablehnungen, 3 Token-Exchanges, 0 fehlgeschlagene Exchanges, 0 Refreshes |
| MCP-Protokoll | 1 Initialisierung, 0 `tools/list`, 0 Tool-Aufrufe, 0 unautorisierte MCP-Anfragen |
| HTTPS-Store | 191 Registry-Reads, 5 Archiv-Reads, 0 abgelehnte Requests; 0 erfolgreiche externe Registry-Icon-Reads |
| Fachliche Provider-Aufrufe | Composio-SDK-Businesscalls `0`, MCP-Toolcalls `0`, blockierte externe Redirects `0` |
| Browser | Keine Runtimefehler und keine verbotenen Aufrufe; keine `asset-errors.json`; 60 erwartete Logo-Ladefehler `net::ERR_CERT_AUTHORITY_INVALID` mit geprüftem Initialen-Fallback |

Die isolierten Logos nutzen ein eigenes Zertifikat, dem Chromium nicht vertraut. Diese tatsächlichen Bildfehler prüfen den Fallback; sie sind keine erfolgreichen externen Bild-Reads. Die Suite prüft erfolgreiche installierte Paket-/Skill-Bilder über die gleiche Notebook-Origin und exakte Bildroute. Der Consent-Test erlaubt ausschließlich den gepinnten eigenen MCP-Zertifikatsschlüssel über die SPKI-Liste; die allgemeine Browser-Zertifikatsprüfung bleibt aktiv.

## Lokale Regressionen

Die passenden Regressionseinstiege sind `test:plugins:extension-search`, `test:plugins:extension-ui`, `test:plugins:extension-setup`, `test:plugins:extension-agent-ui`, `test:plugins:extension-avatar-ui`, `test:plugins:extension-icons`, `test:plugins:extension-settings`, `test:plugins:extension-profiles:native`, `test:plugins:extension-mcp:native`, `test:plugins:workspace-ui` und `test:plugins:extension-e2e`. Root hat die fokussierten API-/Service-/React-/TypeScript-/ESLint-Gates vor dem frischen vollständigen Browserlauf geprüft. Die native Profilprüfung nutzt echte PostgreSQL-Profil-/Override-Verträge mit kontrollierter Composio-Clientabhängigkeit; sie ist kein eigener echter Provider-Aufruf. Lokale/Managed-Collection-Loader-/Routenprüfungen bleiben von tatsächlichen SDK-HTTP- und Drittanbieter-Nachweisen getrennt.

## Erhaltene Belege und Bereinigung

Die privaten Originalartefakte liegen ausschließlich im genannten Laufverzeichnis. Zwei unveränderte Screenshots mit synthetischen Fixture-Inhalten sind im Repository abgelegt: [gemeinsame Suche mit allen vier Typen](plugin-page-integration-catalog-2026-10-13/catalog-all-types-de.png) und [Settings mit aktuellem Profil-/Workspace-Kontext](plugin-page-integration-catalog-2026-10-13/settings-profile-context.png). Schlüsselwerte sind nicht sichtbar. Private JSON-/DATA-/Credential-Dateien werden nicht kopiert.

| Repository-Screenshot | Originaldatei im Laufverzeichnis | SHA-256 |
| --- | --- | --- |
| `catalog-all-types-de.png` | `de-1280-light-catalogue-all-types.png` | `3a522c9a02b94e2926fffb3f13e897f358fab64d9efb47379884c9863f53135b` |
| `settings-profile-context.png` | `settings-created-profile-current-context.png` | `e7c7a8cf27be6d57503d7d9bcb84912aedb008b3cf08a258b4187e556424a9dd` |

| Originalbeleg im Laufverzeichnis | SHA-256 |
| --- | --- |
| `build.log` | `3d214bc6bd0fe263f6a6233d6deadbf4a40a9af8c537ea1ec7a22e1e35fd6e4a` |
| `browser.log` | `df434144a89ad93f284d109333507c6c9f3f6ccfc3616a3f65de71ab36330942` |
| `playwright-results.json` | `e4396e3a7e2b2c2b90ebbd81926d6585a9f9473bfedc0e5fce4a0a917817fb82` |
| `browser-proof.json` | `6e4699c38241dbe9925c60719c98bdbd1707284eca4d5e62d9cc70d94c2d3bec` |
| `provider-proof.json` | `bea1382c20325fd77a1abf3fa288a6dae2468a18a660480ee1f382737ed34a2a` |
| `recovery.json` | `5a9735974be64b9e7b11f63d6fce5eb696c31d85c580bbec9404163ccbe60d0c` |

Notebook- und eigener Control-Plane-Issuer-Receipt stehen auf `phase: cleaned`, `databaseDropped: true`, `uncertain: false`. Der Runner prüft beendete eigene Child-Prozesse und den Besitz der entfernten Testdatenbanken; Provider-/Registry-Listener und Pools werden geschlossen. Private Diagnoseartefakte und Fixture-DATA bleiben erhalten. Das ist keine Behauptung, dass diese Dateien gelöscht oder fremde/verwaltete Dienste verändert wurden. Credential-/Secret-Dateien werden weder hier kopiert noch als Belege veröffentlicht.

## Weiterhin offen

Die UI-Schritte 1–5 einschließlich Settings-Migration sind im dokumentierten Stand lokal abgenommen. Die generelle Gateway-Einführung bleibt im [Rollout-Plan](../rollout-plan-2026-10-13.md) und [implementation.json](../implementation.json) separat `in_progress`, der Gateway-Default bleibt aus. Echte externe MCP-/Modellabnahme, Default-/Telemetrie-/Rollback-Vergleich und gesonderte Geräteprüfungen werden durch diesen UI-Lauf nicht abgeschlossen. Der bereits vorhandene [echte Composio-/Canva-Modellnachweis](step-7-live-composio-model-acceptance.md) bleibt separat gültig. Dieser Bericht behauptet keine Veröffentlichung, kein Deployment und keine Änderung eines Produktionsschalters.
