# Shared-App-Autorisierung ohne Prompt-Paketbindung

Historischer Source-Gate-Stand: 10. Oktober 2026, geprüft um 17:45:33 UTC. Schritt `6b-e-4` bleibt `in_progress`. Die acht Source-Gates sind bestanden; der neue Produktionsbuild ist an diesem Belegstand **noch ausstehend**.

Aktueller Nachtrag um 18:08:22 UTC: Der Produktionsbuild ist mit Exitcode `0` auf denselben sechs eingefrorenen Quelldateien abgeschlossen. Die Warnungen bleiben erhalten; es gibt weiterhin keine neue native/API-/Latenzabnahme.

## Enger Umfang und Autoritätsgrenze

Die Änderung umfasst genau drei Produktdateien und drei bestehende Testmatrizen. `resolveAgentAuthorizationContextForSession` und `resolveIntegrationAuthorizationContext` sind explizite serverseitige Resolver. Nur die zwei frischen Kontextprüfungen in `requireSharedMcpAppAccess` verwenden den neuen Pfad. Er führt dieselben Workspace-/Brand-, aktuellen Agent-Use-, gespeicherten Session-/Actor-/Agent-/Workspace- und Ban-Prüfungen aus, liefert aber leere `skillReadRoots` und `skillPackageBindings`. Der gemeinsame interne Resolver wird durch eine feste Server-Funktionsreferenz gewählt; Requests können keinen Modus einschalten.

Alle bisherigen vollständigen Resolver und Runtime-/Gateway-/`getPiTools`-Aufrufer behalten ihre Prompt-Paketbindung. `ensurePiSessionWorkspaceSnapshot` einschließlich Brand-Lookup bleibt unverändert. Die neue Grenze entfernt ausschließlich die zusätzliche Prompt-/Dateisystembindung aus Shared-App-Preflights; gespeicherte private Invocation-Autorität, Policy-Fingerprint, Originalsession, Source-/Target-Use, exakte Anbieter-/ENV-Bindung und die abschließenden aktuellen Prüfungen bleiben erhalten.

WF0 liest weiterhin aktuelle Runtime-Einstellungen, Modus und Delegationsprovenienz unter dem gespeicherten Policy-Ceiling. WF1 erstellt weiterhin seine eigene frische Workflow-Projektion mit exakten Paket-Pins, ACL-/Byteprüfung und erforderlicher Provider-/Tool-Readiness. Leere Prompt-Roots ersetzen diese Projektion nicht. Der Source-Befund zeigt unnötige vollständige Katalog-/Paketprüfung vor der Skill-Auswahl im bisherigen Shared-App-Pfad; er beweist weder die frühere 44,5-Sekunden-Latenz noch die Ursache des Run9-Timeouts. Eine leere `relevantSkills`-Liste wählt Core-/policy-required Skills und bindet nicht automatisch alle Legacy-Skills.

Vor der Änderung wurde die **CRITICAL**-Reichweite des Session-Resolvers mit 16 direkten und 71 gesamten betroffenen Callern an den Nutzer gemeldet. Zwei Source-Peer-Reviews sind im Root-Gatebeleg erfasst. Sie prüfen insbesondere die unveränderten Autoritätsbedingungen, feste Resolverwahl, zwei begrenzte Shared-App-Callsites und den erhaltenen WF1-Pfad.

## Eingefrorene Dateien

| Datei | SHA-256 |
| --- | --- |
| `app/lib/pi/session-workspace-context.ts` | `941dc3a6883dff84e3a9691eacfbedcf6b59de7f4e1ab814adcd5b6a4f5d58b5` |
| `app/lib/integration-tools/context.ts` | `456dd0fdf990033d51083838660e9d175ba0dd490a2f899446e2e913de93fa04` |
| `app/lib/mcp/apps-shared-access.ts` | `de6c79066b062fffb7ba2639ff32a6f9bfcb6de4076b2622dbc81de665a382c2` |
| `scripts/integration-tool-context-test.ts` | `4235cea89303054131e61021afd81ade6fcc5c45f4533827d46cdbd59bd728bf` |
| `scripts/integration-tool-runtime-policy-test.ts` | `2d47adab7786a2f7c846e698d3a7e30960c05601bed990fbed6ddf52755cdac6` |
| `scripts/agent-workflow-integration-runtime-test.ts` | `cce2a5b8002621fbee11f2c9f7a22ccc73a4e1efc24d58950672bd2b26a4c6a6` |

## Tatsächlich ausgeführte Source-Gates

Root führte die folgenden acht Gates auf unveränderter eingefrorener Quelle aus. Alle endeten mit Exitcode `0`.

| Gate | Abgedeckte Grenze | Log-SHA-256 |
| --- | --- | --- |
| Kontextmatrix, zweiter Lauf | Echte PGlite-Identität/Rechte für Full und Authorization; unveränderliche Eingabe; fehlende/fremde/archivierte Session; Agent-/Workspace-Entzug; spätes Archive-/Agent-/Workspace-/Ban-Race. Nur isolierter Prompt-Capture-Stub mit Sentinel: Full lädt, Authorization lädt nie. | `5a96ac0f8aafc55b6632919eba8b149add1e558487cf6e614a1d62346e055e2f` |
| Runtime-Policy | Gleiche WF0-Policy/Fingerprints für Full und Authorization, aktuelle Einstellungen und monotones Ceiling, Managed-/Ephemeral-/Automation-Provenienz; ein gecancelter Task bleibt gesperrt. | `712630e6cdbd5ef50c123c0c62cc1d151fb77329b7476aac28a88f92d5f826cb` |
| Shared MCP Apps | Tatsächlich gespeicherte Gateway-Invocation, exakte Org-/Team-Quellen, private Autorität, unabhängige Source-/Target-Rechte, aktuelle Bindung, Session- und Metadata-/HTML-Races. | `ae17d17feaf792bb2e576fad0d9213c77c33241d7ea9d9d68f2222cf5f24eace` |
| Mobile Shared MCP Apps | Tatsächliche gespeicherte V2-Quelle und Policy-Ceiling, Originalauth, private Tickets, persistierte One-Shot-Claims, Approval1/Reject0/Replay0, Source-/Target-/ENV-/Agent-Entzug. | `ca8ef02e791d395e8c465c39095cd5ef0d369c3a9178ae8ea1316e1263719ae5` |
| Workflow-Paketmatrix | Vollständige Default-Kontexte behalten reale Paket-Roots/Bindings, exakte alte Pins und frische Policy-/ACL-/Byte-/Korruptionsgrenzen. | `64dc06a087ae8999122ebd4d907ceefdaef74b6f109e5acb0c4bcf7e9bc0e752` |
| WF1-Integration | Authorization mit leeren Roots behält gleichen frischen Fingerprint und Pin V1 nach HEAD V2; tatsächliche Projection-Attach/Readiness sperrt fehlendes Pflichttool und aktuellen Entzug der zweiten Pflichtverbindung mit null Business-Dispatch. Full-Gateway-Pfade bleiben erhalten. | `b0b72d1c6041de5db69c7325051a324ea9a6d4ed405f8318fd5f69c5f5748127` |
| Vollständiges TypeScript, 8 GiB | Gesamter Notebook-Typecheck, Exit `0`, keine Diagnostikausgabe. | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| ESLint, sechs Dateien | Gezielter Check mit null Warnungen, Exit `0`, keine Diagnostikausgabe. | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Der erste Kontextlauf bleibt als Exit `1` mit Log-SHA `2a3f156a1cdbb2a2e1629ae536457d9334965c5e233f096ab53db92bf35e6670` erhalten. Sein neuer Late-Ban-Test erwartete irrtümlich `provider_denied`: Der unverändert frische Agent-Use-Guard erkennt den Ban zuvor und liefert `AgentAccessError`/`AGENT_ACCESS_DENIED`/403. Nur diese konkrete Test-Erwartung wurde berichtigt; der initiale Ban bleibt `provider_denied`. Der anschließend bestandene Kontextlauf ersetzt den ursprünglichen Fehlversuch nicht.

Root-Belege, jeweils `acceptance:false`:

- `authorization-source-freeze-1.json`: SHA-256 `ca03e4bbbca0d9624c338f0fc70a8705b78cb215da1bde2989ab190f38c7eade`.
- `authorization-source-gates-1.json`: SHA-256 `cd8c9516311dacea8f2bbe4607030cfe67314bec9197843d8de480c5bf16f466`; erfasst unveränderte Quellen, acht Exitcodes `0`, den ersten Kontextfehler, zwei Peer-Reviews und `buildPending:true`.

## Bestätigter Produktionsbuild

Root bestätigt den tatsächlichen Abschluss von Build-Session `26904` mit Exitcode `0`. Die sechs Source-Hashes entsprechen unverändert der obigen Tabelle. Log-SHA-256: `be4b63eed364029892724fa098600b8b019085845849a7bd88d98ab6829a232b` (`/tmp/canvas-widget-authorization-build-1.log`).

Der neue Root-Beleg `authorization-build-result-1.json`, geprüft um 18:08:22 UTC, hat SHA-256 `e992f94253ab7a9c9879feafb843d12c2505e0b585aaddaec9cb2f6b3bc0687d` und bleibt `acceptance:false`. Er bestätigt `buildExitCode:0`, `sourcesUnchanged:true` und die vorhandene Cache-Kompressionswarnung. Die dynamischen Tracing-Warnungen des gesamten Projekts bleiben ebenfalls erhalten. Der Build liefert keinen Nachweis einer behobenen Latenzursache oder einer gemessenen Performanceverbesserung.

## Tatsächlicher Android-UI-Integrationsnachweis

Root bestätigt im frischen Run10 den vollständigen Android-Manager-Flow `64-identity-leave-manager.yaml`: Das gemeinsame Organisations-Widget erreicht tatsächlich **Ready**, anschließend erfolgt normaler Manager-Sign-out. Whole-Launcher-Exit `0`, null Fehler im ursprünglichen JUnit und unveränderte 32 YAML-Quellen sind belegt. Am Belegstand sind `nativeAppRows:0` und `providerActions:0` erfasst; es wurde dadurch keine App-Aktion freigegeben oder ausgeführt.

Der eng begrenzte Root-Beleg `authorization-android-native-frame-1.json`, geprüft am 10. Oktober um 18:30:52 UTC, hat SHA-256 `2f8289bab69789f5d434ee0495c33041f59fb3b2b3f2c52087927ea5fed1f0c0`. Er bindet `native-evidence/manager-android-64-identity-leave-manager-257e7e517cd10c73` an Result-SHA `2e3918133ba76437e8643ddfb907658717e45dc7a982bf2c3b646dffd9d442c5` und Report-SHA `6b3606c6e3a4e07b3bc00b990e2aa2e8b2bceeaef4c74975f86d1348178250aa`. Dies ist tatsächliche UI-Integrationsevidenz der Autorisierungskontext-Änderung, keine vollständige native 16-Fall-Matrix oder finale Siegelung. Der ursprüngliche Latenzgrund bleibt unbewiesen; `native16CaseAcceptance:false` und `originalLatencyCauseProved:false` bleiben ausdrücklich erhalten.

## Ausstehende Abnahme

Am ursprünglichen Source-Gate-Snapshot um 17:45:33 UTC hatte der neue Build noch keinen bestätigten Abschluss; dieser frühere Pending-Beleg bleibt unverändert erhalten. Der anschließend bestätigte Build und die Source-Gates enthalten keinen neuen nativen Lauf und keinen neuen Render-API-/Provider-Latenznachweis. Sie machen die früheren Repro-/Run9-Teilnachweise nicht vollständig und liefern keine nachgewiesene ursprüngliche Timeout-Ursache.

[Run9](step-6b-e-4-run9-partial.md) und die [abgeschlossene isolierte Render-Diagnose](step-6b-e-4-render-repro.md) behalten ihre ursprünglichen Ergebnisse und Grenzen. Ein vollständiger frischer 16-Fall-Nachweis mit Original-Auth-/Scope-/Flow-/Provider-/Closure-Belegen steht weiter aus. `6b-e-4` bleibt `in_progress`, `6b-f` und Plan 7 bleiben `pending`; der strikte Mobile-Audit bleibt unverändert **RED, 23 HIGH / 0 CRITICAL**. Keine native, Modell-, Drittanbieter-, Produktions-, Release- oder Gesamtplan-Abnahme wird daraus abgeleitet.
