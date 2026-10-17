# Standalone-Session-Capture: Contentionkorrektur und Abnahmegrenzen

Stand 17. Oktober 2026. Die folgenden PG- und Qualitätsprüfungen liefen auf Root `8ba7603cb` mit fünf ausdrücklich uncommitteten Dateien (zwei App-, drei Testdateien), gebunden durch ihre tatsächlichen `binding.json`-Pins. Die beiden historischen QA-Gegenproben nutzten die alten Produktbytes auf `db70bb037`; sie sind keine Abnahme der neuen App-Dateien. Der anschließende QA-Abgleich übernimmt dieselben fünf Dateien bytegleich, bei unverändertem privatem Aktivierungsgate.

Der ursprüngliche Browser16-Lauf bleibt Exit 1 mit 13/14 ausgeführten Fällen; die zwei Deletefälle starteten nicht. `PRINCIPAL_BUSY` trat beim initialen Sessionaufbau nach Create und vor einem Moveversuch auf. Ob damals die frühe Capture-Sperre oder eine spätere Finalprüfung auslöste, bleibt ungeklärt. Der folgende kontrollierte Gegenfall beweist diese historische Ursache nicht nachträglich.

Im echten PG18-Gegenfall hält ein zweiter eigener Client `ROW EXCLUSIVE` auf `organization_user_permissions`. Die genuine Principal-Schemasperre scheitert mit `55P03`, bevor der interne Capture-Callback betreten wird. Das gesicherte RED antwortet 409 statt erfolgreichem frischem Enrollment. Die unveränderten ursprünglichen Produkt-/Testbytes und roten Berichte bleiben erhalten.

Der Produktschnitt markiert nur standalone Capture (`attempt === undefined`) vor Eintritt seines internen Callbacks. Genuine Fehlerklasse und private WeakSet-Identität bleiben zwingend; gefälschte Namen/Codes genügen nicht. Der Service übernimmt diesen Marker erst nach bestätigtem ROLLBACK und erfolgreichem Close derselben Verbindung in den vorhandenen Read-Contentionpfad. Das gemeinsame Budget bleibt maximal drei Versuche; echte Authentifizierung und ursprünglicher vollständiger Scope werden frisch geprüft. Peer-/Join-Versuche, Callback-/Finalfehler, unbestätigte ACKs sowie Bootstrap/Migration/Veröffentlichung werden dadurch nicht neu wiederholbar.

## Tatsächliche Folgen

| Original unter `/private/tmp/` | Tatsächliches Ergebnis | Originallog SHA-256 |
| --- | --- | --- |
| `canvas-capture-entry-red-77allj5v` | Exit 1, kontrollierter früher Capturefehler | `182ff28affe631053cc6d65967d252aea435d14a44a99409348076e6b1509e28` |
| `canvas-capture-entry-green-ej8xrf4t` | Exit 0, Web/Mobile: zwei Familien, vier transiente/dauerhafte Szenarien | `010dc5d384dbe2667586e7fffb58d692b69d337ef4920550010396314d865a90` |
| `canvas-capture-entry-final-regressions-f7ujv2dl/0` | Exit 0, vollständige Startup33 | `508b8729cae10b43e0636df01d089500b422d040a6a93cdc7278ab493f0df0ab` |
| `canvas-capture-entry-final-regressions-f7ujv2dl/1` | Exit 1 nach 25 Transportgruppen: OID-Fault traf frühere Principalphase | `60d7ad2850f9a4be65c6c81bbce7b1a1ab1735c4370cad492a47df300804a503` |
| `canvas-capture-transport-final-window-baseline-z7729eo1` | Alte QA-Produktbytes, identischer Exit 1 nach 25 Gruppen | `304da9eb95fe9fd8fd773e84f421b021fe80b9910290f43cf5a2dbf8d8ba8df0` |
| `canvas-capture-transport-peer-h9d7h84v/0` | Exit 0, vollständige Transport31 | `6bd8fee0dcaa23194c0cfc6f006fd0c2aa33343952a957842b6b1ec56e29b810` |
| `canvas-capture-transport-peer-h9d7h84v/1` | Exit 1 im alten DDL-Adapter vor Peerfällen; kein Peerpass | `4049c21c385a956fdd656c3b291886be8422b7d7c11e7f69aa5b4f8f7ea05744` |
| `canvas-capture-peer-current-ddl-22fe0wsa` | Exit 0, vollständige Peer13 nach aktueller originaler Migration | `50ae64a743b36665627982ee4c4f4ce0339845eb0d7f9082b74b2ae95e424b94` |

Startup33 enthält echte neue Gegenfälle für verlorene ROLLBACK-/Close-ACKs, ursprüngliche Scopeabweichung während des Wiederholungsfensters und gefälschte Busy-Identitäten auf Web und Mobile. Diese verhindern eine zusätzliche Phase beziehungsweise Veröffentlichung; die bestehenden Consumer-/Final-/COMMIT-, Bootstrap- und Migrationsgrenzen bleiben geprüft. Transport31 prüft zusätzlich die tatsächlich dritte Abschlussabfrage mit realem Schema-OID- beziehungsweise Backendwechsel.

Drei Fixturekorrekturen sind vom Produktschnitt getrennt: (1) Der Workspace-Type-Test erwartet nun exakt den früheren Original-Origin-Fehler `NATIVE_TRANSPORT_SCOPE_CHANGED`; die erste alte QA-Baseline scheiterte mit ursprünglichen Produktbytes nach denselben neun Gruppen. (2) Beide Final-Faults zählen nur die konkrete Transportquery (`to_regnamespace(current_schema())` und `FROM pg_stat_activity a JOIN canvas_workspaces`), weiterhin den dritten Treffer: verify-vor, verify-nach, run-final. OID-/Backendmutation und strikte Fehlererwartung bleiben. Der breite alte Zähler erfasste inzwischen auch Principalabfragen; die zweite alte QA-Baseline reproduziert dies. (3) Der Peer-Adapter führt das originale aktuelle Migrations-SQL unverändert aus und verlangt zwei `table_schema = current_schema()`-Scans sowie keinen alten Publicscan; keine DDL wird synthetisch ersetzt. Kein Produktguard wird dafür gelockert.

Auf denselben zwei App-Pins bestehen nun tatsächlich Startup33, Transport31 und Peer13: zusammen 77 PG-Familien in den getrennten Originalfolgen. Peer-Lauf `22912` endet Exit 0 bei unveränderten Quellenpins; sein eigener Ergebnisbericht bindet 13 Fälle und PID 32481. Die frühere Startup27, der erste Transport-RED und beide alten QA-Baselines bleiben getrennte Originalbelege im Begleitmanifest. Kein roter Lauf wird nachträglich grün erklärt.

## Pins und Ressourcenabgrenzung

| Aktuelle Root-Arbeitskopie / Laufbindung | SHA-256 |
| --- | --- |
| `app/lib/collaboration/authenticated-native-session-transport.ts` | `34a180c5edf98b5f71b71f21ecf732b720e1db23c4fea809fba711ab3c62bfa6` |
| `app/lib/collaboration/authenticated-text-session-service.ts` | `5b1b94a14f8b5ffff8280600c9e9ce0255a59d4e5f04917accc3a84e9784d0ac` |
| `scripts/authenticated-text-session-busy-postgres-test.ts` | `fd673b093c64615007a046671bd86ffbf0bf8b6764ca4fcb85c01aae33abeedb` |
| `scripts/authenticated-native-session-transport-postgres-test.ts` | `0ebc1b3da4b23670194345f8826630363c0bd3a4ed6b8b4c85aa34416015f2d7` |
| `scripts/authenticated-native-peer-busy-postgres-test.ts` | `c71f982b91459902596d27877d0350e6b6aa37a2eac1dc2d2795138f66a731c3` |

Der frische lesende Abschluss `canvas-capture-entry-final-regressions-f7ujv2dl/read-only-closure.json` (`a1f0b78cfa2182a8b8bbc3bc22a6aff3357f0f3a49a2ee60b27b4cc8aa9d3b6f`) bestätigt keine eigenen Schemas/Backends/Fixture-TMPs, null zugewiesene XID, geschlossene Prüfverbindung und drei konkret gebundene PIDs abwesend. `resourceChecksPassed:true` und `originalSerialAcceptancePassed:false` sind ausdrücklich getrennt. Der frühere kombinierte Abschluss `c0d0c03d…` sowie der eigene frühe RED-Abschluss `ca5294bd…` bleiben erhalten. Der getrennte tatsächliche Folgeabschluss `canvas-capture-peer-current-ddl-22fe0wsa/read-only-closure.json` (`ff5df5136819e5836471d91ffd1ed6a9bb7c89bc041be72729f1a34b134b8522`, Exit 0) bindet Transport31 und Peer13 frisch: eigene Schemas/Backends leer, null zugewiesene XID, Prüfverbindung geschlossen, drei gebundene PIDs abwesend, neue und alte Peer-Daten sowie HTTP-Fixture-TMPs fehlen. Im originalen Peer-Evidenzroot `canvas-native-peer-busy-NXt9qQ` sind PID 32481, 13 Ergebnisse, `serverListening:false` und `remainingSockets:0` separat gespeichert. Das ist Ressourcenabschluss, kein Browser16-Pass.

Die anschließende tatsächliche Qualitätsfolge `81016` unter `/private/tmp/canvas-capture-quality-gates-0kha4auu` endet in allen drei Originalen mit Exit 0: vollständiges cachefreies TypeScript mit 8 GB, ESLint der fünf geänderten Dateien ohne Warnungen und die unveränderte Client-Startup-Regression mit 24/24 Fällen. Alle acht ausdrücklich gebundenen Quellpins sind unverändert und erneut lesend mit den aktuellen Dateien verglichen. Qualitäts-Sammelbericht: `48b6f5284877d447fa327cec55e2837a4cd2b12a7b0f7d4a2a6ec69bcbb48d49`; Client-Originallog: `226d7fc70252aa2a325f8f9b0c83e9790a80c356ce7cb724d621017306911694`. Die leeren TypeScript-/ESLint-Logs besitzen jeweils SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; ihr Erfolg wird durch die jeweiligen echten Exitberichte belegt.

Offen bleiben frischer Originalbuild, Artefaktprüfung und dieselbe vollständige Browser16-Abnahme auf dem anschließenden sauberen Root-/QA-Stand. Kein neuer Build-/UI-/Produktionspass oder allgemeine Aktivierung wird behauptet. Dateiaktions-Undo und Review Center bleiben aus; Editor-Textundo ist getrennt. SDK, vollständige API-/MCP-/PI-/Mobileverträge, progressive Suche, Standard-Skill, PDF und vollständige Sandboxabnahme bleiben Teil des offenen Gesamtplans.
