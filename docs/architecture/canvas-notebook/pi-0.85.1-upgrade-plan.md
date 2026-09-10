# Pi-SDK 0.84.1 → 0.85.1: Bestandsaufnahme und Umsetzungsplan

Stand: 10. September 2026. Geprüfter Canvas-Commit: `92ba7a6b5eec386bea1448a24f60488a80a36ac0`.
Status: Umsetzung läuft; reproduzierbare SDK- und Persistenz-Baseline abgeschlossen. UI- und Live-Provider-Abnahme stehen aus.

## 1. Ergebnis und Ziel

Canvas verwendet bereits `@earendil-works/pi-ai` und `@earendil-works/pi-agent-core` in Version **0.84.1**. Der Scope-Wechsel von `@mariozechner` ist erledigt. Ziel ist ein geprüftes Update beider Pakete auf **0.85.1**, die am 10. September als `latest` in der npm-Registry veröffentlicht ist.

Die bestehende Architektur bleibt die Grundlage: Canvas betreibt den normalen Pi `Agent`, drei direkte `agentLoop`-Integrationen und eine eigene PostgreSQL-basierte Session-, Policy- und Compaction-Verwaltung. Der SDK-Wechsel verlangt keine Migration auf Pi `AgentHarness`, `SessionRepo` oder JSONL.

Die konkrete Arbeit besteht aus:

1. Echte SDK-Vertragstests und eine reproduzierbare Ausgangsbasis herstellen.
2. Die bereits vorhandene falsche Reasoning-Übergabe in drei Hintergrund-Integrationen beheben.
3. Pakete, Lockfile und abhängige Lizenzartefakte zusammen aktualisieren.
4. Das geänderte Timing der Turn-Vorbereitung in Chat, Automationen und Subagents absichern.
5. Neue Nachrichten-Metadaten und Tool-Schema-Semantik über Speicherung, Replay und Streaming erhalten.
6. Provider-Aufrufe, Authentifizierung, Modellkatalog und die betroffenen Benutzeroberflächen abnehmen.

Ein Treffer auf einen Pi-Import bedeutet nicht automatisch eine Codeänderung: 91 Dateien unter `app/` und `server/` referenzieren die Pakete, viele davon ausschließlich als TypeScript-Typen.

## 2. Verifizierter Ist-Stand

| Bereich | Befund | Konsequenz |
| --- | --- | --- |
| Abhängigkeiten | `package.json`: beide Pakete `^0.84.1`; Lockfile: beide exakt `0.84.1`, außerdem `pi-telemetry@0.84.1` | `^0.84.1` umfasst 0.85.1 nicht. Bewusste gemeinsame Anhebung erforderlich. |
| Node.js | `engines.node >=22.19.0`, Docker-Basis Node 24, CI je nach Job Node 22/26 | Keine neue Mindestversion nötig; verteilte Runtime trotzdem mitprüfen. |
| Haupt-Chat | `new Agent(...)` in `app/lib/pi/live-runtime.ts`; explizites `streamFn`, `transformContext`, `convertToLlm`, `prepareNextTurnWithContext` | Bestehendes Agent-Modell weiterverwenden. |
| Hintergrundläufe | Direkte `agentLoop(...)`-Aufrufe in Automationen, temporären Subagents und Memory-Review | Low-Level-Vertrag separat prüfen. |
| E-Mail | Zweiter `new Agent(...)` in `app/lib/email/compose-agent/runner.ts`; außerdem direkte Completion-/Stream-Nutzung | E-Mail gehört zur Regression, auch wenn die Änderung im Pi-Verzeichnis beginnt. |
| Auth/Provider | Eigene Installation-, Benutzer-, Workspace- und Organisationsregeln; explizite `apiKey`-/`headers`-/`env`-Übergabe; OAuth nutzt bereits `builtinModels` und `CredentialStore` | Keine pauschale Auth-Neuentwicklung; bestehende Isolation bewahren. |
| Thinking | `max` ist bereits in `app/lib/pi/config.ts` und `app/lib/agent-runtime-policy/types.ts` enthalten | Kein erneuter Ausbau des globalen Enums notwendig. |
| Sessions | `piSessions`/`piMessages`, JSON-Nachrichten, eigene Compaction und Forks | Kein durch das Update erforderlicher SQL-Schemawechsel erkennbar. |
| Imports | Vier Produktionsmodule verwenden `/compat`; dieser Einstieg existiert im veröffentlichten 0.84.1- und 0.85.1-Paket | `/compat` nicht als angeblich entfernte API ersetzen. |
| Packaging | Pi wird in `next.config.ts` extern gehalten; keine Pi-Patches in `patches/` | Auflösung im Server, im Build und in der verteilten Anwendung prüfen. |
| Lokale Prüfgrundlage | Dieser Worktree hat kein `node_modules` | In dieser Bestandsaufnahme wurden keine Build-, Unit-, Provider- oder UI-Tests ausgeführt. |

Die erste allgemeine Auskunft zu Scope-Wechsel, Node-Minimum und Harness war kein Abgleich mit diesem Repository. Diese Punkte sind hier bereits erfüllt beziehungsweise betreffen eine andere API als die von Canvas verwendete.

### Reichweite laut GitNexus

Der Index wurde für genau diesen Worktree neu erstellt (`canvas-pi-upgrade-2889`, 38.673 Symbole).

| Symbol | Direkte Abhängigkeiten | Erreichte Symbole bis Tiefe 3 | GitNexus-Risiko |
| --- | ---: | ---: | --- |
| `resolveExecutableAgentRuntime` | 6 | 29 in 9 Bereichen | **CRITICAL** |
| `getPiModels` | 3 | 18 | LOW |
| `replaceNextTurnContext` | 2 | 3 | LOW |
| `omitUnsupportedTemperature` | 2 | 2 | LOW |

Direkte Aufrufer der zentralen Runtime-Auflösung sind `resolveScopedEmailAiRuntime`, `executeClaim`, `resolveAndPinSessionRuntime`, die Automation-Operation, `prepareAutomationWorkspaceChange` und `ensureOnboardingProfileSession`.

Der Graph ordnet diesen Treffern keine benannten Prozesse zu und erkennt den Callback-Aufruf von `prepareNextTurnContext` nicht als eingehende Kante. Die tatsächlich im Quellcode sichtbaren Chat-, E-Mail-, Automation-, Memory-, Onboarding- und Delegationspfade bleiben deshalb Bestandteil der Abnahme. Die Zahlen sind keine vollständige Abschätzung dynamischer Aufrufe und bedeuten nicht, dass alle erreichten Symbole geändert werden müssen.

## 3. Konkrete Befunde und betroffene Dateien

### A. Pflichtänderung: Reasoning im Low-Level-Agent

In diesen Dateien enthält das an `agentLoop` übergebene Config-Objekt derzeit `thinkingLevel`:

- `app/lib/automations/runner.ts`, etwa Zeile 698.
- `app/lib/pi/delegate-task-tool.ts`, `runEphemeralWorker`, etwa Zeile 448.
- `app/lib/memory/review-worker.ts`, `executeClaim`, etwa Zeile 335.

`AgentLoopConfig` erweitert jedoch `SimpleStreamOptions`; das initiale Feld heißt **`reasoning`**. Das gilt bereits für 0.84.1. `thinkingLevel` ist dagegen korrekt in `Agent.initialState` und in einem zurückgegebenen `AgentLoopTurnUpdate`.

Anpassung: für die drei initialen Loop-Configs `reasoning: selectedLevel === 'off' ? undefined : selectedLevel` verwenden und das Objekt mit `satisfies AgentLoopConfig` prüfen. Die normalen `Agent`-Konstruktoren behalten `initialState.thinkingLevel`.

`scripts/automation-runner-tool-context-test.ts` liest im Mock ausdrücklich `config.thinkingLevel` und bestätigt damit derzeit den falschen Vertrag. Diesen Mock korrigieren und zusätzlich mit der echten Pi-Schleife prüfen, welches `options.reasoning` beim injizierten Stream ankommt. Der vorhandene `scripts/memory-review-runtime-test.ts` prüft die Auswahl des Levels, nicht seine Übertragung an das Modell.

Einordnung: bestätigte bestehende Integrationslücke, kein erst durch 0.85.1 eingeführter Fehler. Ihre Behebung ist Teil einer verlässlichen Update-Basis.

### B. Pflichtprüfung: Turn-Vorbereitung und Abschluss

Ab 0.84.4 läuft `prepareNextTurn*` erst, wenn tatsächlich ein weiterer Assistant-Turn beginnt. `shouldStopAfterTurn` und Queue-Prüfung liegen davor. Auch während der Vorbereitung neu eintreffendes Steering wird berücksichtigt.

Betroffen sind:

- `app/lib/pi/live-runtime.ts`: `prepareNextTurnContext`, Callback bei der Agent-Erstellung, `handleTurnEnd`, `handleAgentEnd`, Fortsetzungs- und Replace-Logik.
- `app/lib/pi/next-turn-context.ts`: Austausch des vom Loop gehaltenen Context-Snapshots.
- `app/lib/automations/runner.ts` und `app/lib/pi/delegate-task-tool.ts`: Erneuerung des Workspace-Dateibaums.
- `app/lib/pi/runtime-queue.ts`, `run-continuation-guard.ts` und `runtime-service.ts`: nachgelagerte Laufsteuerung.

Die derzeitigen Prepare-Hooks erneuern Tools und Prompt-Kontext. Die finale Chat-Persistierung liegt bereits in `handleAgentEnd`; Automation und temporäre Worker speichern nach der Schleife. Es wurde keine pauschal zu verschiebende Abschlusslogik gefunden. Zunächst Vertrags- und Regressionstests anpassen; Produktionscode nur bei nachgewiesener Abhängigkeit vom alten Timing ändern.

Abnahmefälle: erster Turn; Tool-Turn mit Folgeturn; endgültige Antwort ohne Folgeturn; `terminate`; `shouldStopAfterTurn`; Steering während laufender Vorbereitung; ein Follow-up; Abbruch; Replace; Browser-Wechsel von dormant zu active; Dateierzeugung im Tool und aktualisierter Baum im folgenden Turn. Speichern und Abschlussmeldung müssen genau einmal und in der bestehenden Reihenfolge erfolgen.

### C. Pflichtprüfung: Provider-Optionen und neue Modelle

Dateien:

- `app/lib/agent-runtime-policy/request-options.ts` und `provider-runtime.ts`.
- `app/lib/agent-runtime-policy/provider-verification-service.ts`.
- `app/lib/agents/model-test.ts`.
- Indirekt: `app/lib/email/ai-service.ts`, `app/lib/pi/session-title-generator.ts`, `session-summary.ts`, `compaction/summary-generator.ts`.

`omitUnsupportedTemperature` kennt momentan GPT-5 und o1/o3/o4 sowie `compat.supportsTemperature === false`. Die veröffentlichte GPT-6-Astra-Modellbeschreibung enthält dieses Compat-Flag nicht. Eine explizite Temperatur würde bei diesem neuen Modell deshalb durchgereicht; der Responses-Adapter reicht sie ebenfalls weiter. Vor Freigabe dieses Modells den tatsächlichen Request-Vertrag prüfen und die zentrale Normalisierung gegebenenfalls erweitern. Daraus allein folgt noch kein nachgewiesener Provider-Fehler.

Zusätzlich verwendet der Provider-Verifikationstest `completeSimple` direkt mit `...options`, während Modellprobes `temperature: 0` setzen. Hier fehlt die im normalen Runtime-Pfad verwendete Normalisierung. Probe und produktiver Request sollen dieselben unterstützten Optionen verwenden; die bestehende separate Probe-Autorisierung bleibt erhalten.

Regressionen: Output-Limits, Thinking-Level-Mapping, Prompt-Caching, angeforderter und tatsächlich zurückgelieferter Modellname bei Fallback, Usage und Tokenkosten. Fehler dürfen synchron oder als terminales Stream-Event auftreten; beide Formen müssen sich sauber beenden lassen.

### D. Pflichtprüfung: Metadaten, Persistierung und Replay

Dateien:

- `app/lib/pi/visual-data-projection.ts`, `message-projection.ts`, `message-normalization.ts`.
- `app/lib/pi/session-store.ts`, `session-fork.ts`, `usage-events.ts`.
- `app/lib/pi/vision-fallback-stream.ts`, `provider-overflow-recovery.ts`, `stream-proxy.ts`, `stream-runner.ts`.
- `app/lib/pi/compaction/` und `session-compaction-coordinator.ts`.
- `app/components/canvas-agent-chat/useChatRuntimeEvents.ts`, `chatMessageMapping.ts` und `chatRuntimeMessageUtils.ts`.

Erhalten werden müssen insbesondere `providerThinkingLevel`, `endTurn`, Tool-Call-`namespace`, bestehende `thinkingSignature`-Daten und Tool-Result-`addedToolNames`. Alte Nachrichten ohne diese optionalen Felder bleiben gültig. `endTurn` ist laut SDK ein Diagnosefeld und wird nicht allein zum neuen Canvas-Abbruchkriterium.

Canvas speichert Nachrichten als JSON und übernimmt Assistant-Nachrichten bei der LLM-Normalisierung weitgehend unverändert. Das ist eine geeignete Grundlage, muss aber durch Roundtrip-Tests belegt werden. Insbesondere verarbeitet `projectVisualValue` alle Strings rekursiv mit einer Pfad-Redaktion. Opaque, signierte Provider-Daten mit Schrägstrichen dürfen dabei nicht versehentlich verändert werden; sichtbare Tool-Ausgaben und Serverpfade behalten ihren bisherigen Schutz.

Tests mit originalen und slash-haltigen synthetischen Metadaten: Providerantwort → Persistenzprojektion → JSON → Laden → Fork → nächster Modellaufruf; zusätzlich Compaction, Vision-Fallback, Overflow-Recovery und Live-Event-Transport. Keine Umformatierung bereits gespeicherter Nachrichten allein zur Ergänzung neuer Felder: Usage-Fingerprints beruhen auf dem vollständigen JSON und könnten sonst doppelt entstehen.

### E. Pflichtprüfung: Tool-Schemas und Stream-Verbraucher

Relevante Dateien: `app/lib/pi/core-tools.ts`, `tool-runtime-helpers.ts`, `tool-registry.ts`, `effective-tool-manifest.ts`, `progressive-tool-gateway.ts`, `browser/tool.ts`, `app/lib/mcp/direct-tools.ts`, `app/lib/composio/composio-tools.ts` und der Chat-Event-Consumer.

Das SDK normalisiert strikte Schemas und optionale, nicht-nullbare Argumente, die ein Provider mit `null` liefert. Prüfen: `Type.Optional`, nullable Union, verschachtelte Objekte/Arrays, MCP-Schemas, offene Argument-Maps, Fehler in `beforeToolCall`/`afterToolCall`, parallele Ergebnisse und Tool-Limits. Keine zusätzliche doppelte Schema-Umschreibung in Canvas einführen.

Die Pi-Events werden konsistenter. Der Consumer muss Deltas und endgültige Inhalte unterscheiden. Konkreter Prüfpunkt: `useChatRuntimeEvents.ts` hängt sowohl Thinking-Deltas als auch den Inhalt von `thinking_end` an. Prüfen, ob dies während des Streams sichtbare Verdopplungen erzeugt; die spätere `message_end`-Synchronisierung allein ist kein ausreichender Test.

Canvas' progressive Tool-Gateways sind nicht automatisch Pi-native Deferred Tools. Das Update erfordert keine Umstellung dieser Architektur; vorhandene Tool-Namen, MCP-App-Metadaten und Reihenfolgen müssen erhalten bleiben.

### F. Pflichtprüfung: Katalog, Auth und Benutzeroberflächen

Dateien:

- `app/lib/pi/model-resolver.ts`, `provider-help.ts`, `oauth.ts`, `oauth-state.ts`.
- `app/lib/agent-runtime-policy/catalog-discovery.ts`, `catalog-service.ts`, `catalog-store.ts`, `runtime-resolver.ts`, `installation-credentials.ts` und `provider-verification-service.ts`.
- `app/api/oauth/pi/initiate/route.ts` und bestehende OAuth-Status-/Abschlussrouten.
- `app/components/settings/AgentRuntimePreferenceCard.tsx`, `AgentCatalogModelOverrideEditor.tsx`, `PiOAuthButton.tsx` und `app/components/canvas-agent-chat/useChatAgentConfig.ts`.
- `app/lib/managed/control-plane-models.ts` als konsumierte Managed-Provider-Schnittstelle.

Statische Modellkataloge aktualisieren und neue/entfernte Modelle sichtbar machen. Freigaben, Defaults, Workspace-Policies und gepinnte Session-Auswahlen bleiben explizite Canvas-Entscheidungen; ein SDK-Update soll keine neuen Modelle automatisch für alle aktivieren. xAI wechselt in den neueren Katalogen auf Responses; alte Chat-Historien und aktuelle Modellmaterialisierung zusammen testen. Bei entfernten Modellen soll die bestehende verständliche Neuauswahl greifen, statt einen anderen Provider stillschweigend zu wählen.

Die Katalogauswahl verwendet bereits `getSupportedThinkingLevels`. Für Astra unterscheidet sich die veröffentlichte API-Key-Zuordnung von der Codex-Zuordnung: `minimal` ist bei ersterer nicht unterstützt und wird bei letzterer auf `low` abgebildet; `off` ist bei beiden nicht unterstützt. Diese providerbezogenen Fähigkeiten im bestehenden UI prüfen, statt globale Thinking-Optionen zu erweitern.

OAuth verwendet bereits den neueren Models-/CredentialStore-Vertrag. Abnahme: Login, Refresh, Abbruch, abgelaufene Credentials, zwei parallele Refreshes, Benutzer-/Organisationsgrenzen und Revocation während eines Requests. Ein konkreter bestehender Prüfpunkt ist die Signalweitergabe: `getProviderRuntimeAuth` akzeptiert ein Signal, der Aufrufpfad über `resolveRequestAuth`/`runtimeAuth`/`resolveProviderInstallationRuntimeAuth` reicht das Provider-Request-Signal derzeit nicht durch. Falls ein langsamer Refresh die Stop-/Timeout-Abnahme verletzt, dieses Signal entlang des bestehenden Pfads weitergeben und die Lock-Wartephase gesondert testen.

Secrets verbleiben in der bestehenden zentralen und gescopten Canvas-Verwaltung. Keine neue globale Pi-Credential-Datei und kein globales `process.env`-Umschalten zwischen Benutzern. Für Managed-Modelle muss außerdem der vom Control Plane gelieferte Katalog das Modell tatsächlich anbieten; ein Notebook-Paketupdate erweitert diesen Remote-Katalog nicht automatisch.

### G. Pflichtänderung: Abhängigkeiten, Lizenzartefakte und Paketauflösung

Beide direkten Pi-Pakete für die Migration exakt auf `0.85.1` pinnen. `package-lock.json` gemeinsam aktualisieren und prüfen, dass `pi-telemetry` kohärent aufgelöst wird und keine zweite Pi-Minor-Linie entsteht.

Verifizierte direkte SDK-Abhängigkeitsänderungen: OpenAI SDK 6.26.0 → 6.40.0, Anthropic SDK 0.91.1 → 0.123.0; Pi AI entfernt seine direkten Abhängigkeiten auf das Mistral SDK und `@opentelemetry/api`; Agent Core erhält `@earendil-works/chord`. Ein transitives Paket darf nicht pauschal entfernt werden, wenn andere Canvas-Abhängigkeiten es weiterhin benötigen.

Zusammen aktualisieren: `docs/compliance/third-party-license-cache.json`, `docs/compliance/third-party-components.json` und `THIRD_PARTY_NOTICES.md`. Der `prebuild`-Schritt prüft diese Artefakte bereits. Vorhandene Pi-Patches müssen nicht portiert werden.

Die vier `/compat`-Produktionsmodule sind `model-resolver.ts`, `provider-runtime.ts`, `provider-verification-service.ts` und `catalog-discovery.ts`. ESM-Import und CJS-/tsx-Testauflösung getrennt testen: Die veröffentlichten Exports deklarieren `import`, nicht `require`. Ein Importproblem beweist deshalb nicht, dass `/compat` entfernt wurde. `docs/security/2026-09-08-security-hardening.md` enthält einen älteren Testblocker; ihn auf einer frischen Installation reproduzieren und einordnen.

Private Dateipfadimporte in `scripts/agent-runtime-provider-coverage-test.ts` und `scripts/pi-provider-overflow-recovery-test.ts` prüfen und nach Möglichkeit über öffentliche ESM-Imports auflösen. Mocks über `Module._load` dürfen die einzigen Tests des echten Pakets nicht ersetzen. Nicht das gesamte Projekt nur wegen dieser Tests auf ESM umstellen.

## 4. Sequenzieller Arbeitsplan

Jedes Todo beginnt erst nach bestandenem Abschlusskriterium des vorherigen. Fertige Code-/Testpakete separat committen. Vor jeder Symboländerung erneut GitNexus-Impact für den konkreten Symbolstand, vor jedem Commit `detect_changes`.

### T1 — Reproduzierbare SDK-Basis und echte Vertragstests

- [x] Aktuellen Branch/Commit, Arbeitsbaum und Paketauflösung protokollieren; Abhängigkeiten aus dem vorhandenen Lockfile installieren.
- [x] Ohne Provider-Netzwerkaufrufe die öffentlichen Pi-Imports unter der echten Server- und Test-Laufzeit laden.
- [x] `scripts/pi-sdk-contract-test.mts` mit echtem `Agent` und `agentLoop`, injiziertem Fake-Stream und lokalen Test-Tools anlegen; noch kein komplettes Pi-Modul mocken.
- [x] Bestehende Modulauflösungsfehler im betroffenen Testpfad beheben und relevante Baseline-Tests ausführen.
- [x] Baseline für Turn-Reihenfolge, finales Speichern, Reasoning-Übergabe und Nachrichten-Roundtrip dokumentieren.

Baseline am 10. September: Branch `codex/pi-sdk-upgrade-plan`, Ausgangscommit `4cecf060`, sauberer Arbeitsbaum vor Umsetzung, Node 26.7.0 / npm 11.19.0, `npm ci` mit beiden Pi-Paketen 0.84.1. Zehn echte SDK-Vertragstests bestanden. Der Reproduktionsfall zeigt, dass `thinkingLevel` in einer initialen Low-Level-Config nicht als `options.reasoning` ankommt. Automation- und Session-Revisionstests verwenden jetzt eine gemeinsame isolierte PGlite-Testhilfe mit den produktiven PostgreSQL-Migrationen; beide bestanden. Zusätzlich bestanden Memory-Review-Runtime, Browser-Tool-Refresh, Queue, Continuation und Temperatur-Normalisierung sowie TypeScript und gezieltes ESLint. Keine externe Datenbank, Provider-Anfrage, Browser-Automation oder Container-Aktion ausgeführt. Die neuen Metadaten-Roundtrips folgen in T5.

Fertig, wenn die Test-Infrastruktur echte SDK-Aufrufe ausführt und bestehende Integrationsfehler als reproduzierbare Fälle feststehen. Keine unbegründete Aussage „alle Tests grün“, solange ein bekannter Pfad nur gemockt ist.

### T2 — Bestehende Integrationsverträge korrigieren

- [x] Die drei Loop-Configs auf `reasoning` und `satisfies AgentLoopConfig` umstellen.
- [x] Automation-Mock korrigieren und Übergabe für `off`, `low`, `high`, `max` im echten Loop prüfen.
- [x] Gemeinsame Normalisierung unterstützter Request-Optionen für Runtime und Provider-Probe absichern; unnötige Temperaturparameter gemäß verifiziertem Modellvertrag behandeln.
- [x] Die bestehenden Tests für E-Mail-Scope, Modellprobe und Hintergrundläufe ergänzen.

T2: Alle drei initialen Loop-Configs verwenden jetzt den typgeprüften SDK-Vertrag. Die Provider-Probe verwendet `omitUnsupportedTemperature`; ein neuer Test durchläuft die echte Verifikation und Modellprobe mit isolierter Transport-/Credential-Grenze und prüft Optionen, Scope und Abbruch. Der vorher referenzierte Test fehlte im Repository. E-Mail-Testdaten wurden auf die aktuelle Hauptagent-ID und eine isolierte Brand-Profil-Abfrage korrigiert; der Delegations-Test nutzt dieselbe PGlite-Hilfe wie T1. Keine neue pauschale GPT-6-Temperaturregel ohne bestätigten Providervertrag eingeführt.

Fertig, wenn der konfigurierte Level am Stream ankommt und Probe sowie produktiver Aufruf denselben Optionsvertrag verwenden. Die `Agent.initialState`-API bleibt korrekt.

### T3 — SDK und erzeugte Abhängigkeitsartefakte aktualisieren

- [x] Beide direkten Dependencies exakt auf `0.85.1` anheben und Lockfile aktualisieren.
- [x] Auflösung von Pi AI, Agent Core, Telemetry und Chord sowie ESM-Imports prüfen; ungewollte zweite Versionen erklären oder beseitigen.
- [x] Lizenzcache und Notices mit den bestehenden Generatoren aktualisieren; Compliance-Prüfungen ausführen.
- [x] TypeScript-Prüfung und T1/T2-Vertragstests auf dem neuen SDK ausführen; tatsächliche Typbrüche hier beheben.

T3: Pi AI, Agent Core, Telemetry und Chord werden jeweils einmal auf 0.85.1 aufgelöst. Die Transitivänderungen enthalten die erwarteten Anthropic-/OpenAI-Upgrades, Chord und Webhook-Abhängigkeiten sowie neu aufgelöste AWS-/Smithy-Patches im Bedrock-Baum. Keine andere direkte Dependency angehoben. Öffentliche ESM-Imports, echte SDK-Verträge, Probe/Temperatur und TypeScript bestanden. Lizenzgenerator: 1.996 Komponenten, keine Release-Blocker; `test:licenses` bestanden. `/compat` bleibt der korrekte Einstieg für globale Provider-Registrierung und `streamSimple`; der Root-Export dient den expliziten Provider-APIs.

Fertig, wenn die neue Paketlinie reproduzierbar installiert wird und die direkten Verträge passen. `0.85.0` wird nicht als Zwischenziel ausgerollt.

### T4 — Turn-Lebenszyklus und Laufsteuerung abnehmen

- [ ] Prepare-Hook-Tests auf „nur bei Folgeturn“ einstellen und mit dem echten Loop prüfen.
- [ ] Browser-/Tool-Refresh, Workspace-Baum, Steering, Follow-up, Terminate, Abort und Replace abdecken.
- [ ] `turn_end`- und `agent_end`-Persistierung, Queue-Verbrauch und Runtime-Recreation auf Doppelungen/Races prüfen.
- [ ] Nur nachgewiesene Abhängigkeiten vom alten Timing im Produktionscode ändern.

Fertig, wenn kein zusätzlicher Modellaufruf nach Abschluss entsteht, neue Tool-Schemas rechtzeitig gelten und Nachrichten zuverlässig gespeichert werden.

### T5 — Nachrichtendaten, Tools und Streaming abnehmen

- [ ] Roundtrip-Vertrag mit neuen optionalen Feldern, alten Nachrichten und opaken Thinking-Signaturen prüfen.
- [ ] Pfad-/Bildprojektion, Usage-Idempotenz, Fork und Compaction an denselben Fixtures prüfen.
- [ ] Tool-Null-Normalisierung, MCP/Composio-Schemas, parallele Events und terminale Fehler testen.
- [ ] Thinking-/Text-Deltas und finale Inhalte im Chat-Consumer prüfen und erforderliche Korrekturen vornehmen.

Fertig, wenn Replay gültig bleibt, UI-Inhalte nicht doppelt erscheinen und Usage nicht durch reine Metadatenbehandlung dupliziert wird.

### T6 — Provider, Auth und Katalogintegration abnehmen

- [ ] Offline-Request-Tests für die relevanten Transportfamilien aus Abschnitt 5 durchführen.
- [ ] Neue/entfernte Katalogmodelle, Thinking-Fähigkeiten, bestehende Policies und gepinnte Sessions prüfen.
- [ ] OAuth-Scope, Refresh/Revocation und langsamen Auth-Abbruch testen; notwendige Signalweitergabe implementieren.
- [ ] Für neue Modelle die Provider-Probe und Hilfsaufrufe wie Titel, Summary, Compaction und E-Mail prüfen.
- [ ] Katalogänderungen als bewussten administrativen Schritt dokumentieren; Remote-Managed-Katalog gesondert verifizieren.

Fertig, wenn unterstützte Modelle ausführbar sind und bestehende Credential-/Policy-Grenzen auch bei Parallelität gelten. Fehlende Live-Zugänge als ungetestete Fälle dokumentieren, nicht durch erfolgreiche Mock-Tests ersetzen.

### T7 — Build, gespeicherte Daten und vollständige Regression

- [ ] Relevante Tests aus Abschnitt 5 sequenziell ausführen, neue Fehler beheben.
- [ ] `npm run lint` und `npm run build` einschließlich Lizenzprüfung abschließen.
- [ ] Den realen Server-Importpfad über `server/agent-runtime-loader.ts` sowie Prewarm mit echter Paketauflösung prüfen.
- [ ] Auf kopierten/anonymisierten Session-Fixtures alte Chats öffnen, fortsetzen, forken und kompaktieren; auch erneutes Laden unter dem vorherigen SDK prüfen.
- [ ] Packaging-Smoke für die tatsächlich zu veröffentlichenden Ziele durchführen; besonders transitive Pi-Dateien, JSON-Kataloge und Chord im verteilten Artefakt prüfen.

Fertig, wenn alle Release-relevanten automatisierten Prüfungen erfolgreich sind und keine Datenmigration benötigt wird beziehungsweise jede tatsächlich nötige Transformation einen getesteten Rückweg hat.

### T8 — UI-/End-to-End-Abnahme im verwalteten lokalen Stack

- [ ] Vor Verwendung von Playwright/Browserautomation die vom Repository verlangte explizite Nutzerfreigabe einholen, sofern sie bis dahin nicht erteilt ist.
- [ ] Den verwalteten Stack aus dem Skill `canvas-local-team-seat-dev` verwenden; einen Container nur bei explizitem Auftrag bauen. Dann zuerst erfolgreicher Build, anschließend aktueller Rebuild/Recreate, keine parallele Testumgebung.
- [ ] Login über `BOOTSTRAP_ADMIN_EMAIL` und `BOOTSTRAP_ADMIN_PASSWORD` aus der lokalen Konfiguration.
- [ ] Chat: Streaming, Thinking, Tool-Fortschritt, Stop, Queue/Replace, Browser-Schemawechsel, Reconnect und Fortsetzen eines alten Chats.
- [ ] Settings: Modelltest, Katalogauswahl, unterstützte Thinking-Level und OAuth-Status/Refresh.
- [ ] Automation und Delegation: Verlauf, Ergebnis, Timeout, Wiederholung ohne doppelte Abschlussnachricht.
- [ ] E-Mail: Entwurf/Zusammenfassung und Workspace-Agent; Onboarding-Chat und Memory-Ergebnisstatus.
- [ ] Mobile-API-Verträge und Darstellung bei einem bestehenden Client prüfen; ein Native-App-Release ist nur bei nachgewiesener Vertragsänderung erforderlich.

Fertig, wenn die Integrationen im UI funktionieren und die Belege in der PR dokumentiert sind. Diese Planung selbst beinhaltet keine UI-Automation und keinen Containerbau.

### T9 — Releasevorbereitung und Rückweg

- [ ] Für eine spätere Veröffentlichung `npm run test:all` unter den dann autorisierten Voraussetzungen und den Release-Lizenzcheck abschließen.
- [ ] PR mit finalem Umfang, Testnachweisen, UI-Belegen und verbleibenden Provider-Einschränkungen erstellen, wenn beauftragt; erforderliche Checks und Review-Kommentare vor Merge abschließen.
- [ ] Vor dem Rollout aktive Läufe geordnet beenden und Daten/Konfiguration gemäß bestehendem Backup-Verfahren sichern.
- [ ] Vorheriges Anwendungsartefakt mitsamt Lockfile aufbewahren; nicht nur ein einzelnes npm-Paket im laufenden System downgraden.
- [ ] Rollback auf vorherige Anwendung mit denselben Daten auf Fixtures testen; keine pauschale DB-Rücksicherung über nach dem Update entstandene Nutzerdaten.
- [ ] Nach Deployment Providerfehler, abgeschnittene Streams, Queue-/Persistenzfehler, Tool-Validierungen, OAuth und Usage mit den vorhandenen Betriebswerkzeugen kontrollieren.

Abschlusskriterium: freigegebene Regression, getesteter Rückweg und dokumentierter Rollout. Deployment und zusätzliche Überwachung werden nicht durch diesen Plan ausgelöst.

## 5. Testmatrix

Neue Vertragstests sollen Netzwerk und Modellantworten an der Transportgrenze simulieren, aber die reale SDK-Schleife, Schema-Validierung und Projektion durchlaufen. Bestehende Tests bleiben wertvoll; reine Source-/Mock-Tests belegen jedoch keine SDK-Kompatibilität.

| Bereich | Bestehende Tests / Befehle | Zusätzlich nachzuweisen |
| --- | --- | --- |
| SDK/Loader | `scripts/agent-runtime-loader-test.ts`, `scripts/pi-runtime-prewarm-test.ts`, `test:agents:provider-coverage` | Echte Pi-Importauflösung, echte Agent-/Loop-Verträge, neuer SDK-Contract-Test |
| Runtime/Policy/Auth | `test:agents:runtime`, `test:pi:oauth-scope`, `test:agent:provider-verification`, `test:email:ai-runtime-scope`, `scripts/session-runtime-snapshot-postgres-test.ts` | Abort während Auth, Refresh-Parallelität, Revocation, identische Probe-/Runtime-Optionen |
| Modelloptionen | `test:agent:temperature`, `test:agent:model-probe`, `test:agent:ollama-setup` | Neue Katalogmodelle und native Thinking-Maps, Cache-/Output-Limits |
| Chat-Lebenszyklus | `test:pi:browser-tool-refresh`, `test:pi:queue`, `test:pi:continuation`, `test:pi:session-exclusive`, `scripts/pi-runtime-session-operation-test.ts` | Reale Callback-Reihenfolge und finale Barriere |
| Tools | `test:pi:tools`, `test:pi:effective-tools`, `test:pi:progressive-gateway`, vorhandene MCP-/Composio-Tests | Strict/Optional/Null, Namespace-Replay, parallele Resultate und Abbruch |
| Daten/Usage | `test:pi:session-store-revision`, `test:pi:usage`, `test:chat:fork`, `scripts/pi-message-projection-test.ts` | Alte/neue Metadaten-Roundtrips ohne Mutation und doppelte Usage |
| Compaction | `test:pi:normalized-compaction-preflight`, `test:pi:compaction-v2-durability`, `test:pi:compaction-v2-runtime`, `test:pi:compaction-ui`, `test:pi:summary`, `test:pi:session-title` | Signaturen, Metadaten, Callback-Timing, Abbruch und bestehende Token-/Transfergrenzen |
| Multimodal | `test:pi:attachments`, `test:pi:multimodal-delivery`, `test:pi:vision-fallback`, `scripts/pi-provider-overflow-recovery-test.ts` | Fehler vor `start`, keine doppelte Teilantwort beim Retry, Metadaten-Erhalt |
| Hintergrundläufe | `test:automation:runner`, `test:automation:timeout`, `test:automation:delivery`, `test:pi:delegate-task`, `test:pi:delegation-dispatcher`, `test:memory:review-runtime` | Echte Reasoning-Weitergabe, Timeout/Abschluss und persistente versus temporäre Delegation |
| E-Mail/Onboarding | `test:email:ai-runtime-scope`, `test:email:client-ai-stream`, `scripts/onboarding-profile-test.ts` | Thinking-/Modelloptionen in einfachen und Tool-basierten Antworten |
| UI | `tests/pi-chat.spec.ts`, `test:pi:context-ui-browser`, `test:agent:runtime-settings-ui`, `test:pi:delegation-ui` | Browser-E2E gemäß T8; nicht nur Komponenten-/Source-Tests |
| Artefakte | `npm run licenses:refresh-cache`, `npm run test:licenses`, `npm run lint`, `npm run build` | Anschließend Server-/Distributionsimport aus dem erzeugten Artefakt |

### Provider-Szenarien

- OpenAI Responses: normaler Chat, Tool-Turn, Reasoning, explizites Prompt-Caching, Output-Limit, neue Modelle.
- OpenAI Codex OAuth: Login/Refresh, terminales SSE ohne abschließende Leerzeile, Namespaces, `endTurn`, Abbruch.
- Anthropic direkt und über OpenRouter: Thinking-Level-Wechsel, persistierte signierte Antworten, Replay und ausgewiesene Usage bei Fallback.
- OpenRouter und xAI: neue Transport-/Reasoning-Zuordnungen, alte Historie, nicht unterstütztes `off`.
- Ollama und OpenAI-kompatible Custom-Endpunkte: eigene Base-URL, ohne API-Key falls konfiguriert, Tool-Schemas, Vision-Fallback und unveränderte explizite Compat-Overrides.
- Canvas Control Plane: tatsächlich angebotene Modelle, Auth-Header, Katalogrevision und Policy-Wechsel während eines Runs.
- Mistral, Google/Vertex, Bedrock und Copilot: Offline-Vertragstests für geänderte Transport-/Tool-/Auth-Verträge; Live-Abnahme für die in der Zielinstallation aktiv verwendeten Provider.

## 6. Optionale Weiterentwicklung nach dem Update

Diese Arbeiten sind eigene spätere Vorhaben und keine Voraussetzung für 0.85.1:

| Option | Möglicher Nutzen | Vor einer Umsetzung zu klären |
| --- | --- | --- |
| `/compat` schrittweise reduzieren | Klarere Provider-Abhängigkeiten und weniger globale Registrierung | Ersatz für Canvas-Custom-Provider, dynamische Kataloge und gescopte Auth; zuerst hinter bestehender Provider-Grenze |
| Assistant-Message-Frames | Kompaktere Streaming-Persistierung und Reconnect | Koexistenz mit WebSocket-/Mobile-Protokoll, DB-Nachrichten, Projektion, Versionierung und Usage-Fingerprints |
| Pi `AgentHarness`/Session v4 | Eventuell wiederverwendbare langlebige Operationen | Vollständiger Abgleich mit Canvas-Postgres, Mandantenrechten, Compaction, Locks, Forks und Wiederherstellung; API-Reife separat prüfen |
| vLLM-Priorität/Thinking-Budget-Felder | Priorisierung interaktiver gegenüber Hintergrundrequests | Nur für kompatible Server; Konfigurationsschema, Validierung und Settings gezielt erweitern |
| Pi-native Deferred Tools | Nutzung message-gebundener Tool-Nachladung | Verhältnis zu bestehenden Gateway-/MCP-/Composio-Verträgen und Sichtbarkeit im UI |
| Zusätzliche Pi-Telemetrie | Bessere Provider-/Harness-Diagnostik | Nutzen gegenüber bestehender Observability, Datenumfang und ausdrückliche Aktivierung |

Keine neue Pflichtarbeit ergibt sich aus dem entfernten Cloudflare-Binding-Helper oder dem umbenannten `GoogleThinkingLevel`: In `app/`, `server/` und `scripts/` wurde keine Nutzung dieser APIs gefunden. Auch die entfernten Harness-Manual-Drive- und Session-Subpaths werden hier nicht verwendet.

## 7. Aufwand und offene Abnahmebedingungen

Grobe Planung: **3–5 Arbeitstage** für die Pflichtstrecke inklusive echter SDK-Tests und Integrationsabnahme, sofern das bestehende Testsetup reproduzierbar ist und die genutzten Providerzugänge vorliegen. Das ist eine Aufwandsschätzung aus der Quellcodeprüfung, keine bereits gemessene Umsetzung. Ein Harness-/Frame-Umbau ist darin nicht enthalten.

Vor der Umsetzung stehen keine grundlegenden Architekturentscheidungen offen. Vor vollständiger Freigabe sind die tatsächlichen Build-/Testresultate, die verfügbare Provider-Matrix, die UI-Abnahmefreigabe und der getestete Rückweg erforderlich. Die exakten Produktionsänderungen in Projektion, Event-Consumer und Auth-Abbruch ergeben sich aus den in diesem Plan benannten Vertragstests; bestätigte Befunde und noch zu prüfende Risiken sind bewusst getrennt.

## 8. Quellen und Prüfgrenzen

- Lokaler Quellcode und Lockfile am oben genannten Commit, insbesondere die in Abschnitt 3 genannten Dateien.
- [Pi AI 0.85.1 Changelog](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/CHANGELOG.md).
- [Pi Agent Core 0.85.1 Changelog](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/CHANGELOG.md).
- [AgentLoopConfig und Tool-Verträge](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/types.ts).
- [Tatsächliche Loop-Reihenfolge in 0.85.1](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent-loop.ts).
- [Pi AI Stream-/Nachrichtentypen](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/types.ts).
- [Weiterhin vorhandene Compat-API](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/compat.ts).
- [npm-Metadaten Pi AI](https://registry.npmjs.org/@earendil-works%2Fpi-ai) und [Pi Agent Core](https://registry.npmjs.org/@earendil-works%2Fpi-agent-core), einschließlich Versionszeitpunkt, Exports und Dependencies.
- Modell-Metadaten zusätzlich gegen die veröffentlichten Paketdateien geprüft: [OpenAI-Katalog](https://unpkg.com/@earendil-works/pi-ai@0.85.1/dist/providers/data/openai.json), [Codex-Katalog](https://unpkg.com/@earendil-works/pi-ai@0.85.1/dist/providers/data/openai-codex.json).

Die Analyse umfasst statische Codeprüfung, Versions-/API-Vergleich und einen frischen lokalen Abhängigkeitsgraphen. Sie ist keine bereits bestandene Laufzeitprüfung. Es wurden keine Pakete aktualisiert, keine Produktionsdaten verändert, keine Provideraufrufe zur Inferenz gestartet und keine Container oder Browser-Tests ausgeführt.
