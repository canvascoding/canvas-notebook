# PostgreSQL-Startup-Regression: Fix- und Testplan

Stand: 10.09.2026. Review-Basis: `96b0ff0f47c67e2f3e206dc59ef98590896e0bce` / `v2026.9.10.10`. Vergleich: `v2026.9.10.9` (`d34fd045`). Status: **Analyse und ausführbare Charakterisierung, noch keine Produktimplementierung.** Keine Veröffentlichung, Production-Änderung, Container-Aktion oder Browser-Automation ausgeführt.

## 1. Entscheidung

**Default auf `0` zurücksetzen, positive Overrides behalten; zusätzlich die Auth-Initialisierung sofort beobachten und vor weiteren DB-abhängigen Startup-Schritten explizit abwarten.** Das ist der kleinste sinnvolle Kandidat. Poolgröße 10, Idle-Timeout 30 Sekunden, behobene Session-Workspace-Lease und Dispatch-Limit bleiben erhalten.

Nur Timeout `0` beseitigt den neu eingeführten Zeitdruck und entspricht dem gesunden `.9`-Verhalten. Es behebt aber keine fehlende Promise-Fehlerbehandlung. Ein echter Verbindungsabbruch kann weiterhin dieselbe Auth-Initialisierung verwerfen; ein dauerhaft hängender Verbindungsaufbau wartet ohne eigene Grenze. Deshalb ist `0` eine gezielte Rücknahme der Regression, **kein vollständiger Resilienz-Fix und kein Nachweis, dass 15 Sekunden grundsätzlich ausreichen müssten**.

Ein weiterhin gesetzter Override `15000` gewinnt auch nach dem Default-Fix. Die Timeout-0-Variante muss deshalb im isolierten Test ausdrücklich mit `0` oder ohne Override geprüft werden. Eine spätere Änderung des Production-Overrides wäre ein eigener autorisierter Betriebsschritt und gehört nicht zu diesem Auftrag.

Vor dauerhafter Abnahme außerdem die Health-Parallelität begrenzen und die konkret gefundenen Hintergrundfehlerpfade absichern. Keine globale Serialisierung sämtlicher Pool-Nutzer, keine pauschale Vergrößerung des Pools und kein vollständiger Revert von `f157d16c`.

## 2. Belegte Ursache und offene Produktionshypothese

### Timeout-Semantik

`f157d16c` („Prevent PostgreSQL pool starvation“) führte in `app/lib/db/postgres-runtime-options.ts` den Default `connectionTimeoutMillis: 3_000` ein. `.9` übergab diesen Parameter nicht. Der aktuelle Parser macht auch aus einem expliziten `CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS=0` wieder `3000`.

Im installierten **pg 8.22.0 / pg-pool 3.14.0** sind zwei Fehler unterscheidbar:

| Situation | Fehlermeldung | Aussage |
|---|---|---|
| Neuer Client erreicht bis zur Frist keinen verbindungsbereiten Zustand | `Connection terminated due to connection timeout` | Der Pool beendet den Verbindungsaufbau; nicht gleichbedeutend mit einer zu langsamen SQL-Ausführung. |
| Alle Clients belegt, wartende Acquisition läuft ab | `timeout exceeded when trying to connect` | Wartezeit in der Pool-Queue überschritten. |
| Timeout `0` | Kein solcher Timer | Wartet auf freie bzw. fertig verbundene Clients; reale Netzwerkfehler bleiben Fehler. |

Belege: `node_modules/pg-pool/index.js` (Queue um Zeile 206, neuer Client um Zeile 250) und [node-postgres Pool API](https://node-postgres.com/apis/pool). Das Query-Label `oauth_resource` zeigt die fehlgeschlagene Operation; es beweist weder DDL-Locks noch einen langsamen SELECT. Timer können auch durch Event-Loop-/CPU-Last verspätet verarbeitet werden.

### Warum gerade OAuth und eine unhandled rejection?

1. `app/lib/auth.ts:102` ruft auf Modulebene `betterAuth(...)` auf. Der OAuth-Provider bleibt bei gültiger öffentlicher URL absichtlich installiert, auch wenn Direct MCP deaktiviert ist.
2. `directMcpOAuthResourceOptions` konfiguriert `resourceSeedMode: 'merge'`. Der installierte OAuth-Provider 1.7.1 führt beim asynchronen Plugin-Init `seedResources` aus; dessen `adapter.findOne({ model: 'oauthResource', ... })` greift auf die betroffene Tabelle zu. Verbindungsfehler werden weitergeworfen; nur bestimmte fehlende Tabellen werden toleriert.
3. Better Auth 1.7.1 startet `initFn(options)` unmittelbar und veröffentlicht das Promise als `auth.$context`, ohne selbst einen Rejection-Handler anzuhängen (`better-auth/dist/auth/base.mjs`). Der normale API-Zugriff wartet erst später auf dieses Promise.
4. `getDirectMcpReadiness` importiert Auth, wartet zunächst auf Settings und prüft anschließend über eine eigene Lease die Tabellen. Erst danach konsumiert `auth.api.getJwks()` den Auth-Kontext. Bei deaktiviertem MCP oder frühem Schemafehler kommt dieser Aufruf gar nicht zustande.
5. Damit können OAuth-Seeding und Schema-Readiness über zwei Clients parallel starten. Eine früh ablehnende Auth-Initialisierung kann unhandled werden, während der Startup-Aufrufer noch etwas anderes abwartet. `server.js` behandelt `unhandledRejection` ausdrücklich mit `process.exit(1)`.

Der beigefügte [Charakterisierungstest](../../../scripts/postgres-startup-characterization.mjs) reproduziert diese Kombination mit den echten installierten pg-/Better-Auth-/OAuth-Implementierungen. Nur TCP-Gegenstelle und Adapter-Speicherzugriff sind Fehler-Fixtures; er startet weder die gesamte App noch einen echten PostgreSQL-Server. Ohne sofortigen Handler endet der Child-Prozess fatal; mit sofort beobachtetem Outcome bleibt die ursprüngliche Auth-Rejection erhalten und kann später kontrolliert ausgewertet werden.

**Noch nicht gemessen:** Warum der Produktions-Verbindungsaufbau mehr als 15 Sekunden benötigt, wie viele Pools/Backends dort tatsächlich existieren und welcher Startup-Verbraucher welchen Anteil verursacht. CPU-Drosselung, Event-Loop-Stall, DNS/TLS/Netzweg, PostgreSQL-Admission/Last sowie mehrere Modulinstanzen sind zu messen, nicht als bewiesene Ursache auszugeben. Der frühere Workspace-Leak erklärt den hier reproduzierten Promise-Fehler nicht und wird nicht erneut als offene Ursache behauptet.

## 3. Tatsächliche Startup-Konkurrenz

| Phase | Ablauf / Pool-Beteiligung | Parallelität und Fehlerverantwortung |
|---|---|---|
| Entrypoint | Migrationen, danach Agent-Datei-/Legacy-Bootstrap | Separate, nacheinander laufende Prozesse. Migrations-Pool wird im `finally` beendet. Nicht pauschal gleichzeitig mit OAuth. |
| start-services | Terminal-Service, dann optional Bootstrap-Admin, dann `server.js` | Terminal ohne eigenen PG-Pool; Admin eigener Pool/Prozess. |
| Früher Serverstart | Migrationen nur falls nicht bereits abgeschlossen; Import MCP-Readiness startet Auth | OAuth-Seeding kann mit Schema-Readiness konkurrieren. Bei MCP disabled fehlt hier ein Auth-Ready-Gate. |
| Weitere Initialisierung | WebSocket-/Collaboration-Imports, Agent-Preload, Katalog-Warmup, Channel Manager, Next prepare | Warmup-Promises werden gestartet, aber erst nach weiteren Imports und `manager.start()` gemeinsam awaited. Ein `.then(success)` besitzt keinen Rejection-Handler für das erzeugte Promise. |
| Nach listen | Stale-Automation-Recovery sofort; nach 1,5 s Cleanup, Preset-Seeding, Session-Cleanup, License-/Memory-Initialisierung | Gemeinsamer Laufzeit-Pool wird von Wartung und ersten HTTP-/Health-Aufrufen belastet. Mehrere Starter starten eigene Timer; nicht alle führen sofort DB-Arbeit aus. |
| Nach erster gesunder HTTP-Prüfung | Separater Automation-Scheduler | Verwendet HTTP, keinen eigenen pg-Pool. Kann erst jetzt weitere Runtime-Abfragen auslösen. |

Quellen: `scripts/docker-entrypoint.sh:221`, `scripts/start-services.sh:94`, `server.js:419`, `server.js:734`, `server.js:520`. Die Sequenz ist relevant: Ein pauschales „Migrationen + alle Worker + OAuth starten zugleich“ wäre falsch.

Der Runtime-Pool ist **modullokal**, nicht nachweislich einmal pro Container: `app/lib/db/index.ts` enthält `let runtimeDatabase`. Custom-Server-Quellen und Next-Server-Bundles könnten unterschiedliche Modulinstanzen laden. `max=10` gilt dann pro Pool. Vor einer Änderung auf `globalThis` zunächst PID/Pool-Identität messen; eine solche Singleton-Umstellung wäre ein eigener größerer Eingriff.

## 4. Alle Pool-Zugangsarten und konkrete Befunde

Das [Inventar](postgres-startup-pool-consumers.md) listet 154 statische Einstiegskonsumenten (93 Drizzle, 64 Lease, 3 Überschneidungen), sieben weitere dynamische Runtime-Importe sowie Server und Bootstrap-Prozess: insgesamt 163 Dateien. Es ergänzt GitNexus um dynamische Imports und CommonJS. 212 syntaktische `openDb()`-Aufrufe im Laufzeit-Quellbaum sind keine 212 gleichzeitig belegten Clients.

| Zugangsart | Nutzer / Vertrag | Ergebnis |
|---|---|---|
| Drizzle / Better Auth | Auth, Sessions/PI, Channels, Todos, Studio, Audit, Mobile, Sharing, E-Mail u. a. | Normale Queries nutzen automatische Pool-Freigabe; Transaktionen halten eine Lease. Auth-Init kann trotzdem ein unbeobachtetes Promise erzeugen. |
| `openDb()` | Health, MCP, Memory, Workspaces, Permissions, Team-/License-Flows, Agent-Policies, Collaboration u. a. | Explizite Freigabe erforderlich. `close?.()` und an Transaktionshelfer delegierte Freigabe wurden bei verdächtigen Treffern mitgeprüft. Keine belastbare Aussage „alle Leaks ausgeschlossen“. |
| Runtime-Queryable | E-Mail-Cache über dynamischen DB-Import | Benutzt denselben vorhandenen Pool, kein zusätzlicher Cache-Pool. |
| Separate Factory-Pools | Migrationen, Bootstrap-Admin, Testskripte | Nicht mit gleichzeitigem Runtime-Verbrauch vermischen; Admin-Connect/Migration vor dessen `try/finally` als separaten Cleanup-Härtungspunkt festhalten. |

Zusätzliche, aus dem Code belegte Fehlerpfade:

- **Session-Cleanup (`server.js:485`):** `dbConn.run(cleanupQuery)` wird nicht awaited, danach wird der Client freigegeben. Ein späterer Query-Fehler entkommt dem äußeren `catch`; `result.changes` ist bei PostgreSQL außerdem ein Zugriff auf ein Promise. `finally` fehlt.
- **Memory-Scheduling (`app/lib/memory/review-worker.ts:440`):** `scheduleRuntime()` fragt bereits `nextMemoryReviewDueAt()` ab. Mehrere `void scheduleRuntime(...)` haben keinen Fehler-Handler. Das `catch` des eigentlichen Worker-Zyklus deckt diese Scheduling-Abfrage nicht ab.
- **Health (`app/api/health/route.ts:126`):** Der HTTP-Timeout via `Promise.race` stoppt keine DB-Arbeit. Nur MCP-Readiness ist bisher zusammengefasst; wiederholte GETs können weiter eigene Health-Checks/Leases anstellen. Bei Timeout `0` ist das besonders wichtig.
- **Pool-Idle-Fehler (`createPostgresPool`):** Kein `pool.on('error')`-Listener in der Factory. Ein Fehler eines unbenutzten Clients hat einen anderen Fehlerkanal als eine abgelehnte Query; ebenfalls gezielt absichern.

## 5. GitNexus-Impact vor den Änderungsentwürfen

Frischer Index für genau diesen Worktree; Aufrufe mit `direction: upstream`, `minConfidence: 0.8`, in der Regel `maxDepth: 3`. Auth-Datei separat mit Tiefe 2. Die Risikowerte wurden vor dem Entwurf gemeldet.

| Ziel | Risiko | Direkte Abhängigkeiten / Reichweite | Konsequenz |
|---|---|---|---|
| `resolvePostgresRuntimeOptions` | HIGH | 2 direkt, 14 insgesamt inkl. Test | Nur Timeout-Fallback verändern, übrige Optionen unverändert. |
| `createPostgresPool` | HIGH | 6 direkt, 14 insgesamt | Runtime-Factory, Migration, Bootstrap-Admin und drei Collaboration-Tests berücksichtigen. |
| `openDb` | CRITICAL | 212 direkt, 1.123 insgesamt, 34 Prozessgruppen; teilweise gekürzt | Keine globale Acquisition-/Lease-Neuimplementierung im Hotfix. |
| Datei `app/lib/auth.ts` | CRITICAL | 269 direkte Imports, 634 insgesamt bei Tiefe 2 | API-Objekt und Plugin-Konfiguration erhalten; zusätzliches Ready-Gate. |
| `resolveAgentSessionWorkspaceForUser` | CRITICAL | 41 direkt, 212 insgesamt, 8 Prozessgruppen | Bestehenden Leak-Fix erhalten und testen. |
| `getDirectMcpReadiness` | LOW | 2 direkt | Startup und Settings-PATCH; Health-Callback zusätzlich manuell berücksichtigen. |
| `startServer` / `scheduleBackgroundMaintenance` | LOW | jeweils 1 direkt | Statisch klein, operativ gesamter Start betroffen. |
| `purgeExpiredSessions` / Memory-`scheduleRuntime` | LOW | 1 / 2 direkt | Timer- und Fehlerpfade gesondert testen. |
| `performHealthChecks` / `createCachedAsyncCheck` | LOW | 1 / 2 direkt | HTTP-Timeout, In-flight-Verhalten und Response-Verwendung testen. |

GitNexus erfasst Promise-Ownership, Zeitabstände und dynamisch geladene Bundle-Instanzen nicht vollständig. Insbesondere war ein isolierter `auth`-Symboltreffer mit null Importern irreführend; die Datei-Analyse zeigt die tatsächliche große Importfläche. Leere Prozesslisten bei begrenztem Index-Sampling sind kein Sicherheitsnachweis. Vor jeder späteren Implementierung Indexstand prüfen und Impact erneut ausführen; vor jedem Commit `detect_changes`, zusätzlich vor Abnahme Vergleich gegen `main`.

## 6. Kleine, sequenziell abzuarbeitende Änderungspakete

Jedes Paket erhält Code, seine Tests und einen eigenen Commit. Erst das aktuelle Paket fertigstellen; kein Push, Tag, Release oder Production-Eingriff. Die folgenden Änderungen sind **Vorschläge**, nicht bereits umgesetzt.

### T1 — Timeout-Verhalten von .9 wiederherstellen

Dateien: `app/lib/db/postgres-runtime-options.ts`, `scripts/postgres-runtime-options-test.ts`.

Minimaler Produktdiff:

```diff
     connectionTimeoutMillis: resolvePositiveInteger(
       environment.CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS,
-      3_000,
+      0,
       60_000,
     ),
```

Dazu ein Kommentar: pg-Default `0` bedeutet kein Acquisition-/Connect-Zeitlimit; endliche Werte sind bewusste Betreiber-Overrides. **Ein neuer Parser ist nicht nötig:** Der vorhandene Parser liefert für fehlend/ungültig/negativ/`0` dann `0`; positive Werte und Cap bleiben unverändert. Die bisherige `parseInt`-Semantik nicht nebenbei verschärfen. `POOL_MAX=0` muss weiterhin auf 10 zurückfallen, Idle-Default bleibt 30.000.

Tests: fehlend, leer, explizites `0`, negativ, nichtnumerisch → 0; `3000`, `15000`, `60000` bleiben erhalten; Übergrenze wird auf 60.000 begrenzt; Pool-/Idle-Optionen unverändert. Bestehender Runtime-Options-Test erwartet momentan ausdrücklich den regressiven Default und muss angepasst werden. Commit: `Restore PostgreSQL connection timeout default`.

### T2 — Auth-Start explizit besitzen und abhängig serialisieren

Dateien: `app/lib/auth.ts`, `server.js`, bei Bedarf `app/lib/mcp/server/readiness.ts`; neues isoliert testbares Startup-Outcome-Hilfsmittel nur bei tatsächlichem Wiederverwendungsbedarf.

Direkt nach `betterAuth(...)`, noch während derselben Modulauswertung, das ursprüngliche Promise beobachten:

```ts
const authInitialization = auth.$context.then(
  () => ({ ok: true } as const),
  (error: unknown) => ({ ok: false, error } as const),
);

export async function ensureAuthReady(): Promise<void> {
  const result = await authInitialization;
  if (!result.ok) throw result.error;
}
```

Damit bleibt `auth.$context` unverändert ablehnend; das sofort erzeugte Outcome-Promise erfüllt sich in beiden Fällen. **Nicht** `.catch(error => { throw error; })` als alleinstehendes unbeobachtetes Promise verwenden. Ein bloßes `.catch(log)` ohne späteren Fatal-/Readiness-Pfad wäre ebenfalls falsch.

Reihenfolge im Server: Migrationen abgeschlossen → `ensureAuthReady()` → MCP-Schema/JWKS-Readiness → übrige Warmups → Listen. Das Auth-Gate gilt auch bei deaktiviertem MCP. Die Beobachtung muss in der Auth-Moduldefinition selbst liegen, damit auch eine getrennte Next-Modulinstanz abgesichert ist. Health muss die für seine Modulinstanz erforderliche Auth-Bereitschaft ebenfalls berücksichtigen.

Agent-/Katalog-Warmups dürfen parallel bleiben, erhalten aber **ab ihrer Erzeugung** eine Outcome-Beobachtung, einschließlich Fehlern in Erfolgshandlern. Alle gestarteten Operationen bleiben auch dann beobachtet, wenn ein späterer Import oder Channel-Start vorher abbricht. Ihre Fehler werden am expliziten Startup-Gate nach bestehender Required-/Optional-Policy behandelt. Auth-Fehler bleiben fatal, aber kontrolliert mit Phase und bereinigter Ursache; den globalen Fatal-Handler nicht entfernen.

Tests: tatsächliches OAuth-Seeding schlägt vor spätem Consumer fehl; MCP an/aus; früher Schemafehler; mehrere `ensureAuthReady()`-Aufrufer ohne zweites Seeding; Auth-API bleibt bei Init-Fehler ablehnend; Warmup lehnt ab, während Channel-Start noch wartet; alle Fehlerpfade ohne unhandled rejection. Keine blinden Auth-Retries: Das erneute Awaiten desselben abgelehnten `$context` initialisiert nichts neu. Commit: `Own authentication and warmup startup promises`.

### T3 — Health-Wartearbeit begrenzen und Startbudget ehrlich machen

Dateien: `app/api/health/route.ts`, passende Tests; `scripts/start-services.sh` als getrennt reviewbarer Teil desselben Betriebsvertrags.

- Gesamte `performHealthChecks`-Operation pro geladener Route zusammenfassen, nicht nur MCP. Bestehendes `createCachedAsyncCheck(loader, 0)` genügt als In-flight-Sperre ohne zusätzlichen Resultat-Cache.
- Jeder GET behält seinen HTTP-Timeout. Die In-flight-Referenz bleibt bis zum tatsächlichen Abschluss erhalten, auch nach einem 503-Timeout. Sonst entsteht weiterhin Arbeit pro Poll.
- Keine gemeinsame `Response` mehrfach konsumieren: bevorzugt Check-Daten sammeln und pro GET eine neue JSON-Response erstellen; alternativ vor Auslieferung klonen. Auth-Init-Fehler darf auch bei MCP disabled nicht zu `healthy` werden.
- `Promise.race(pool.connect(), timeout)` nicht als vermeintliche Cancellation ergänzen: Ein verspätet erworbener Client würde ohne explizite Freigabe lecken. Auch Single-flight beendet keine dauerhaft hängende SQL-Abfrage; diese Grenze dokumentieren.
- `STARTUP_HEALTH_MAX_ATTEMPTS=180` ist derzeit **kein 180-Sekunden-Deadline**: pro Runde kommen `curl` ohne `--max-time` und eine Sekunde Sleep hinzu. Für den Server-Ready-Abschnitt tatsächliche verstrichene Zeit begrenzen, einzelne HTTP-Aufrufe begrenzen und bei Fristablauf die vorhandene Prozess-Cleanup-Kette verwenden. Migrationen/Bootstrap liegen davor und benötigen separat festgelegte, migrationsverträgliche Grenzen. Nicht eine 3-Sekunden-Connect-Grenze durch eine versteckte gleich kurze Startup-Grenze ersetzen.

Tests: mindestens 50 parallele/aufeinanderfolgende Polls gegen eine blockierte Query → nur ein vollständiger Check in-flight; 503 innerhalb HTTP-Budget; spätere Query-Rejection bleibt behandelt; späte erfolgreiche Acquisition wird exakt einmal freigegeben; neuer Check nach Abschluss; unabhängige Response-Bodies; echter Zeitablauf statt Versuchszahl im Shell-Starttest. Commit: `Bound health work during PostgreSQL startup`.

### T4 — Die bestätigten weiteren Fehlerkanäle schließen

Kleine getrennte Commits statt Sammelrefactor:

1. `purgeExpiredSessions`: `await dbConn.run(...)`, `await close()` im `finally`, auch etwaiges Optimize awaiten; überlappende Cleanup-Runden vermeiden. Deferred-Query-Test beweist: kein Release vor Query-Abschluss; bei Fehler genau ein Release und ein kontrollierter Warnpfad. SQLite-Kompatibilitätszweig nicht unabsichtlich verändern.
2. Memory-`scheduleRuntime`: initiales Planen, Trigger und Wiederplanung nach Zyklus besitzen je einen Fehlerpfad. Scheduling-Fehler führen zu begrenztem Backoff und einem erneuten Versuch, nicht nur zu Log + dauerhaft stillgelegtem Worker. Nach Await `stopped`/Runtime-Identität erneut prüfen; parallele Trigger dürfen keine doppelten Timer erzeugen. Tests mit Scheduling-Fehler, Recovery und Stop während ausstehender DB-Abfrage.
3. `createPostgresPool`: synchroner, nicht werfender `error`-Listener für Idle-Client-Fehler. Nur bereinigter Fehlercode, Pool-Rolle und Zähler; keine Connection-URL, SQL-Parameter oder Secrets. Tests: Idle-Error tötet Prozess nicht, betroffener Client entfernt, nächste Query kann wieder verbinden. Query-/Auth-Fehler werden dadurch ausdrücklich nicht verschluckt.

Den Admin-Bootstrap-Cleanup vor `try/finally` separat nachziehen, falls dessen eigener Fehlerpfad im Integrationstest Ressourcen offen lässt. Keine Massenänderung aller `openDb`-Aufrufer ohne konkreten Befund.

### T5 — Reale Lastmessung und bedingte weitere Serialisierung

Nur für isolierte Tests Diagnose-Marker mit PID, Pool-Instanz/Rolle und Phase; Pool `totalCount`, `idleCount`, `waitingCount`, Acquire-/Connect-Zeit, Event-Loop-Delay und PostgreSQL-Backend-Zustand erfassen. Unbekanntes serverseitiges SQL nicht vollständig loggen. Bei mehreren Pools zunächst erklären, welche Modulinstanzen/Prozesse sie erzeugen; globale Pool-Freigabe ist dann eine eigene Designentscheidung.

Die notwendige Serialisierung ist Auth → Schema/JWKS, nicht ein globaler DB-Mutex. Optionale erste Wartungsdurchläufe nur dann zusätzlich mit kleiner begrenzter Parallelität staffeln, wenn Messungen den Bedarf zeigen. Ein bloßer größerer `setTimeout` verschiebt Konkurrenz. `CANVAS_AUTOMATION_MAX_CONCURRENT_RUNS` bzw. den bestehenden Dispatch-Limiter nicht ohne Messung verändern.

## 7. Regressionstests und Abnahmekriterien

### Bereits ausgeführt

| Prüfung | Ergebnis |
|---|---|
| `tsx scripts/postgres-runtime-options-test.ts` | Bestanden auf unveränderter .10-Basis; beweist die alte Erwartung, noch nicht den vorgeschlagenen Fix. |
| `tsx scripts/health-async-check-test.ts` | Bestanden; noch kein vollständiger Route-/Queue-Test. |
| `tsx scripts/session-workspace-connection-release-test.ts` | Bestanden; bestehender Leak-Fix bleibt als Schutztest. |
| `tsx scripts/automation-dispatch-concurrency-test.ts` | Bestanden. |
| Neues Offline-Harness unter macOS ARM64, Node 26.7.0 | Alle sechs Charakterisierungsfälle bestanden. |
| Dasselbe Harness auf Ubuntu ARM64, Node 22.22.1 | Alle sechs Fälle bestanden, pg 8.22.0; echte OAuth-Abhängigkeiten 1.7.1. |
| Wiederholungsprüfung des finalen Harness auf Ubuntu | Drei aufeinanderfolgende Läufe bestanden; keine App-/DB-Dienste gestartet. |
| ESLint für das neue Harness, `node --check`, `git diff --check` | Bestanden; kein Ersatz für repositoryweites Lint/Build. |
| `env -u SENTRY_AUTH_TOKEN npm run build` | **Fehlgeschlagen in prebuild/test:licenses**, vor Next-Kompilierung. Tool-App-Build vorher erfolgreich. |

Build-Befund: Nach `npm ci --legacy-peer-deps` mit unverändertem Lockfile (Host npm 11.19.0) scheitert `scripts/third-party-license-compliance-test.ts:92` an `machine-readable third-party inventory must be regenerated after dependency changes`. Das gespeicherte Inventar und das lokal neu berechnete Ergebnis unterscheiden sich; letzteres enthält 42 zusätzliche verteilte Review-Items. **Kein PostgreSQL-Compilefehler nachgewiesen und kein erfolgreicher vollständiger Build behauptet.** Lizenz-Artefakte wurden nicht regeneriert, die Freigabeprüfung nicht umgangen. Zuerst im gepinnten Build-Toolchain-Setup gegenprüfen; bleibt der Fehler bestehen, als separaten Baseline-Blocker beheben lassen.

### Vor Implementierungsabnahme zusätzlich erforderlich

Einen echten PostgreSQL-Integrationstest ergänzen, z. B. `scripts/postgres-startup-integration-test.mjs` (derzeit noch nicht vorhanden). Contract: ausschließlich explizite private Test-DB, kein Production-Fallback, eigener Testdatenbereich, deterministisch verzögerbarer TCP-Proxy, Child-Prozess-Lebenszyklus und harter Test-Watchdog mit Socket-/Client-/Prozess-Cleanup. Keine Timeouts lediglich mit Sleep und Erfolgs-Log „testen“.

| Fall | Erwartung / Vergleich |
|---|---|
| max=1 und max=10, Pool vollständig ausgeliehen, zusätzlicher Nutzer | Endlicher Override liefert Queue-Fehler; `0` wartet und fährt nach Release fort, keine überzähligen Clients. |
| Neue PostgreSQL-Verbindung 4 s / 16 s verzögert | .10 mit 3 s / 15 s scheitert deterministisch am Connect; `0` und Kandidat starten nach freigegebener Verbindung. Nicht Query-Laufzeit statt Handshake verzögern. |
| Query auf bereits verbundenem Client verzögert | Unterscheidet Query-Dauer vom Connect-Timer; kein falscher SQL-Timeout-Beweis. |
| OAuth-Init-DB-Fehler vor spätem Consumer | Kandidat: phasenbezogener kontrollierter Startup-Fehler, keine unhandled rejection; Auth nicht gesund melden. |
| Vorübergehend unerreichbare / dauerhaft blockierte DB | Recovery ohne verspätete Lease-Leaks bzw. kontrollierter Abbruch am vereinbarten Startup-/Testbudget. |
| Idle-Backend-Verbindung beendet | Kein ungefangener EventEmitter-Fehler, Pool erholt sich. Nur Test-Backend beenden. |
| MCP enabled / disabled, bestehende / leere gültig migrierte oauth_resource | Auth-Gate funktioniert; Merge erhält bestehende Policy und aktualisiert erlaubte Scopes wie zuvor. |
| Frische DB und bereits migrierte DB | Entrypoint-Migrationen vor Runtime, keine konkurrierende Doppelmigration. |
| Health-Sturm + Session-Cleanup + Memory-Scheduling-Fehler | Kein Prozessabsturz, keine wachsende Queue durch Polls, Worker-Recovery belegt. |
| Session-/Workspace-Auflösung parallel | Bestehender max=1-Lease-Release-Test bleibt grün; keine Rückkehr zum verschachtelten Checkout. |

Versionsmatrix: `.9` als historische Kontrolle; `.10` unverändert; `.10` mit **nur** Timeout-0-Patch; vollständiger Kandidat. Positive Overrides 3000/15000 gesondert testen. Ein bloß gesetztes `...TIMEOUT_MS=0` ist auf unverändertem `.10` keine gültige Timeout-0-Kontrolle. Gleiche Ressourcen, Testdaten und Fault-Sequenz; unterschiedliche Lockfiles der Releases protokollieren. Für `.10`-only-0 vs. Kandidat müssen Lockfile und Toolchain identisch sein.

Abnahme: 10 wiederholte gesunde Starts pro relevanter Kandidatenkonfiguration, mindestens ein echter kalter Compile-/Startlauf, danach 20 Minuten Laufzeit (inkl. 15-Minuten-Session-Cleanup); kein unerwarteter Exit/Restart, keine unhandled rejection, keine verlorene Fehlerursache. Unter beendeter Testlast `waitingCount=0`, keine ausgeliehenen Clients (`totalCount-idleCount=0` nach Quieszenz), HTTP-Health ehrlich und innerhalb Budget. Fehlerfälle dürfen bewusst kontrolliert nonzero enden. Positive finite Overrides dürfen bei längerer künstlicher Verbindungsverzögerung weiterhin korrekt fehlschlagen.

Pflichtbefehle im Kandidatencheckout, nach lokalem Dependency-Install und ohne Production-Env:

```sh
./node_modules/.bin/tsx scripts/postgres-runtime-options-test.ts
./node_modules/.bin/tsx scripts/health-async-check-test.ts
./node_modules/.bin/tsx scripts/session-workspace-connection-release-test.ts
./node_modules/.bin/tsx scripts/automation-dispatch-concurrency-test.ts
node scripts/postgres-startup-characterization.mjs
npm run lint
env -u SENTRY_AUTH_TOKEN npm run build
git diff --check
```

Neue Tests aus T2–T4 und der echte PG-Test kommen in einen gemeinsamen, sequenziellen `test:postgres:startup`-Script-Eintrag. Bestehendes `npm run test:all` nicht unbesehen starten: es enthält E2E/Browser-Automation und benötigt vorher die entsprechende ausdrückliche Freigabe. Kein Container-Build vor grünem vollständigem `npm run build`.

## 8. Reproduzierbarer Ubuntu-ARM64-Ablauf

### A. Sofort wiederholbare, bereits erfolgreich ausgeführte Charakterisierung

Gefundene Maschine: OrbStack-VM `ubuntu`, Ubuntu 26.04.1 LTS, `aarch64`. Vorhandener Checkout: `/home/frankalexanderweber/canvas-notebook-test`, HEAD `160145d6`, Package-Version `.9`. Dort vorhandene pg-/OAuth-Abhängigkeiten haben die oben genannten exakten Versionen; dessen Lockfile ist aber **nicht** das aktuelle `.10`-Lockfile. Keine Vollstart-/Build-Freigabe aus diesem Dependency-Reuse ableiten.

Vom aktuellen macOS-Worktree aus:

```sh
orb -m ubuntu sh -lc 'uname -m; node --version; npm --version'
orb -m ubuntu sh -lc 'cd /home/frankalexanderweber/canvas-notebook-test && CANVAS_TEST_DEPENDENCY_ROOT=/home/frankalexanderweber/canvas-notebook-test node /Users/frankalexanderweber/.codex/worktrees/7611/canvasstudios-notebook/scripts/postgres-startup-characterization.mjs'
```

Erwartung: `result: passed`, `platform: linux`, `architecture: arm64`, sechs Fälle; einschließlich fatalem unowned-Child und kontrolliertem owned-Child. Nur Loopback-Sockets, keine reale DB und keine Credentials erforderlich. Das Harness ist auch direkt aus einem späteren Linux-Kandidatencheckout ohne `CANVAS_TEST_DEPENDENCY_ROOT` ausführbar.

### B. Reproduzierbarer vollständiger Kandidatenlauf — noch auszuführen

1. Kandidaten-SHA und Lockfile-SHA festhalten, sauberen **separaten Quellcheckout** auf der Maschine anlegen; keine bestehende Arbeitskopie überschreiben. Linux-eigene `node_modules` mit `npm ci --legacy-peer-deps` aus genau diesem Lockfile installieren. Keine macOS-Module und keine alte `.next` übernehmen. Node 24 und npm 11.11.0 passend zum Dockerfile verwenden; der Docker-Basisdigest ist dort gepinnt. Node 22/26 aus den Charakterisierungsläufen ist kein Ersatz für diesen Paritätslauf.
2. Die obigen Tests und `npm run build` auf Ubuntu wiederholen; bei Lizenz-Gate-Fehler stoppen und ihn getrennt klären. Kein `--ignore-scripts`/direktes `next build` als Ersatz für die Build-Abnahme.
3. **Setup-Voraussetzung offen:** Auf `ubuntu` lief bei der Prüfung weder Docker noch PostgreSQL/App; dort ist kein sofort startbereiter produktionsähnlicher Stack belegt. Auf dem Host existiert bereits der verwaltete `canvas-local-prod-*`-Stack. Die weitere VM `canvas-managed-e2e` besitzt eine eigene laufende Umgebung und bleibt unangetastet. Für den vollständigen Ubuntu-Lauf zuerst explizit den Testbetrieb/Containerbau freigeben und genau eine verwaltete Umgebung als Testziel festlegen bzw. auf Ubuntu vorbereiten; nicht parallel eine zweite starten.
4. Dazu verbindlich `canvas-local-team-seat-dev` mit dessen `references/workflow.md` verwenden: beide Repository-Regeln lesen, Listener/Container prüfen, private State-Konfiguration auf den **Kandidatencheckout** vorbereiten, aktuelle Quellen bauen und Notebook mit `start-local.sh --target notebook` neu erstellen. Das Skript nutzt den in `compose.env` gespeicherten Checkout, nicht automatisch das aktuelle Verzeichnis. PostgreSQL/Control Plane und Testdaten erhalten, kein Volume-Reset. Nur die autorisierte Testumgebung umstellen, keine fremden Dienste stoppen. Plattform am tatsächlich gestarteten Image/Container als `linux/arm64` prüfen.
5. Frisch migrierte, ausschließlich dafür reservierte Test-DB bzw. Testdaten-Snapshot verwenden; DB-Version 18/pgvector und Konfiguration mit Produktion abgleichen. Fixture-Credentials privat aus dem verwalteten State beziehen, Login über `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`; niemals Env-Werte oder Tokens ins Protokoll schreiben. Fault-Injection nur am Notebook-Testzugang, nicht am gemeinsam benötigten Control-Plane-Zugang und niemals am Production-DB-Host.
6. Den geplanten echten PG-Integrationstest und die Versions-/Timeout-Matrix aus Abschnitt 7 sequenziell ausführen. Für jede geänderte Variante aktuellen Stand rebuild/recreate, nicht einen alten Container weiterbenutzen. Reproduzierbar speichern: Commit/Lockfile/Image-Digest, Node/pg/OAuth-Versionen, CPU-/RAM-Limit, PG-Version, Timeout/Pool-Optionen, Phasenzeiten, bereinigte Pool-/PG-Messwerte, Prozess-Exit und RestartCount.
7. Health, Login und erforderliche Auth-/MCP-API-Flows gegen die isolierte Umgebung prüfen. UI-/Playwright-Prüfung erst nach ausdrücklicher Freigabe; für diesen Plan wurde kein Browser gestartet. Zum Abschluss nur temporäre Test-Fixtures entfernen/stoppen, Testdaten-Volumes nicht löschen.

Ein erfolgreicher Offline-Fehlertest auf Ubuntu ist damit heute belegt; ein erfolgreicher aktueller ARM64-Produktionsbuild und ein vollständiger Container-Startup-Test bleiben ausdrücklich offene Abnahmepunkte.

## 9. Review- und Abschlusscheckliste

- [ ] T1: Default und explizites 0; Poolgröße/Idle-Policy und frühere Leak-Korrektur unverändert.
- [ ] T2: Auth und frühe Warmups sofort beobachtet; Fehler bleiben wirksam; MCP disabled abgedeckt.
- [ ] T3: Health-Queue begrenzt, keine falsche Readiness; wirkliche Startup-Zeitgrenze definiert/getestet.
- [ ] T4: Cleanup-/Memory-/Idle-Error-Tests grün, Recovery und Freigabe belegt.
- [ ] T5: Anzahl der realen Pools und Ursache langsamer Connects gemessen; zusätzliche Serialisierung nur bei Befund.
- [ ] Lizenz-Baseline geklärt; `npm run lint` und vollständiges `npm run build` grün.
- [ ] Ubuntu ARM64: exakter Kandidat/Lockfile, echter PG-Test, wiederholte Starts, Nachlauf und Failure-Matrix bestanden.
- [ ] GitNexus `detect_changes` vor jedem Implementierungscommit und gegen `main`; nur erwartete Symbole/Flows.
- [ ] Keine Veröffentlichung, kein Push, kein Tag und keine Production-Änderung ohne neuen Auftrag.
