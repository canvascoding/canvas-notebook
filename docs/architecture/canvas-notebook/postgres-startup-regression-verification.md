# PostgreSQL-Startup-Fix: Implementierung und Prüfprotokoll

Stand: 10.09.2026. Produkt-/Testkandidat: `09baebb9b867fb9031fd5c3345ad09ec6d7491fd`, Branch `codex/postgres-startup-regression-plan`. Basis: `.10` / `96b0ff0f`. [Ursprünglicher Plan](postgres-startup-regression-plan.md), [Pool-Inventar](postgres-startup-pool-consumers.md).

**Historischer Quell-/Driver-Prüfstand vor der Containerfreigabe.** Die danach autorisierte Docker-Paritätskorrektur, der zusätzliche Session-Zeitstempel-Fix sowie tatsächliche Container-, Neuinstallations- und Browserprüfungen des Kandidaten `37b7751f` sind im [nachfolgenden Prüfbericht](postgres-startup-container-verification.md) dokumentiert. Die unten damals offenen Betriebsschritte sind nicht der aktuelle Abschlussstatus.

## Ergebnis und Umfang

Der Timeout-Default ist wieder `0`. Positive Betreiber-Overrides bleiben wirksam, einschließlich `15000`; Poolgröße 10, Idle-Timeout 30 Sekunden, Session-Workspace-Leak-Fix und Dispatch-Limiter bleiben unverändert. Keine globale Pool-Singleton- oder Mutex-Umstellung.

Nur Timeout `0` reicht als Resilienzkorrektur nicht: Reale Verbindungsabbrüche lehnen weiterhin Promises ab. Deshalb besitzt Auth sein Initialisierungsergebnis sofort, der Server wartet Auth vor MCP-Schema/JWKS ab, und frühe parallele Warmups besitzen ihre Fehler bereits vor dem späteren Startup-Gate. Ein abgelehntes Auth-Promise wird nicht neu initialisiert oder fälschlich als bereit gemeldet.

Weitere konkret belegte Fehlerpfade sind korrigiert: Health fasst die gesamte noch laufende Prüfung zusammen, Session-Cleanup wartet Query und Freigabe ab, Memory-Scheduling erholt sich mit begrenztem Backoff, und Idle-Pool-Fehler haben einen synchronen nicht werfenden Listener. Das Readiness-Budget begrenzt verstrichene Zeit einschließlich HTTP-Anfragen; der Shell-Prozess verwaltet direkt die Node-Server-PID.

## Reviewbare Commits

| Commit | Änderung und zugehörige Tests |
|---|---|
| `4319ef99` | Timeout-Default/Parser-Regression; Test zuerst rot, danach grün |
| `963ba875` | Gemeinsamer `observeStartupTask`-Helper, Auth-Gate, Warmup-Ownership; echte OAuth-Init-Rejection und tatsächlicher Server-Funktionskörper mit isolierten Abhängigkeiten |
| `4e81f8f0` | Health-Single-flight/Auth-Readiness; Zeitbudget und Shell-Cleanup; 50-Poll-Wellen, späte Acquisition/Query-Rejection, unabhängige Responses |
| `9af7db4c` | Session-Cleanup: await/finally, Überlappungsschutz, Fehler/Recovery, SQLite-Zweig |
| `235cb5b8` | Memory-Scheduling: coalescing, Backoff 1/2/4/8/16/30 Sekunden, Recovery, Stop-/Generationsschutz |
| `fb09ef0f` | Pool-Idle-Error-Handling und endliche bereinigte Diagnosecodes; Fehlerentfernung/Wiederverbindung mit echtem pg-Pool |
| `09baebb9` | Zwei npm-Testeinstiege, native PostgreSQL-Matrix und Typkorrektur des absichtlich reduzierten Pool-Testclients |

Die Code-Structure-Regel führte zu einem kleinen gemeinsam verwendeten Outcome-Helper statt separater Auth-/Warmup-Implementierungen. Der lokale Stack-Skill begrenzte den Datenbanktest auf den vorhandenen verwalteten PostgreSQL-Testdienst; kein weiterer App-/DB-Stack wurde gestartet.

GitNexus-Impact wurde vor den Änderungen erneut ausgeführt und HIGH/CRITICAL für Pool/Auth gemeldet. Nach einem Index-Refresh war der MCP-Transport geschlossen; weitere Impact-/Change-Prüfungen liefen über GitNexus CLI. Neue noch nicht indexierte Test-Fixtures lieferten `UNKNOWN`, keinen behaupteten Sicherheitsnachweis. `detect-changes --scope staged` lief vor jedem Commit. Der Vergleich gegen `main` meldete 23 Dateien/99 Symboltreffer, LOW/0 erfasste Prozesse; dieser Gesamtwert ersetzt nicht die kritische Auth-Importfläche. Manuelle Diff-Prüfung schloss ungewollte Änderungen an Nachbarsymbolen wie `createPostgresDrizzle`, `deduplicatePiSessions`, Membership-Konstanten und `triggerMemoryReviewWorker` aus. Solche Treffer entstehen teilweise durch verschobene Zeilen im älteren Index.

## Tatsächlich ausgeführte Prüfungen

Toolchain auf beiden Architekturen: Node **24.18.0**, npm **11.11.0**, pg **8.22.0**, pg-pool **3.14.0**, Better Auth/OAuth-Provider **1.7.1**. PostgreSQL **18.4**, vorhandenes Image `pgvector/pgvector:0.8.3-pg18`.

| Prüfung | macOS ARM64 | Ubuntu ARM64 |
|---|---|---|
| `npm run test:postgres:startup` (11 sequenzielle Gruppen) | bestanden | bestanden |
| Native PostgreSQL-Matrix `--slow` (12 Fälle) | bestanden | bestanden |
| Vollständiges `tsc --noEmit --incremental false` | bestanden | bestanden |
| `npm run lint` | bestanden | nicht separat wiederholt |
| Vollständiges `npm run build` inklusive prebuild/Lizenzgate | bestanden | bestanden |
| Bestehender OAuth-PG-Provider-Test (PGlite) | bestanden | nicht separat wiederholt |
| `npm run test:db:provider` | bestanden | nicht separat wiederholt |

Die Builds kompilierten Next in 115 Sekunden auf dem Host bzw. 103 Sekunden auf Ubuntu und schlossen auch TypeScript, Seitengenerierung sowie CLI-Versionsinjektion erfolgreich ab (Exit 0). Ohne private Build-Env erscheinen bestehende Hinweise zur fehlenden Auth-Base-URL/MCP-Konfiguration. Das ist kein Auth-/Login-Runtime-Nachweis. `SENTRY_AUTH_TOKEN` war für Builds entfernt; keine Veröffentlichung ausgeführt.

Zusätzlich geprüftes bestehendes `npm run test:db:unavailable` ist **nicht ausführbar**: `scripts/database-unavailable-error-test.ts` fehlt bereits auf `main`. Kein Bestandteil der neuen grünen Startup-Suite; nicht als PostgreSQL-Fixfehler oder erfolgreicher Test verbuchen. Keine fremde Testlücke nebenbei repariert.

### Native Messwerte

Die Matrix verwendet die echte Produkt-Pool-Factory und native PostgreSQL-Verbindungen. Ein Loopback-TCP-Proxy verzögert den Verbindungsaufbau, nicht die SQL-Ausführung. Die Fehlertexte werden exakt geprüft. Alle Sessions setzen serverseitig `default_transaction_read_only=on`, zusätzlich `statement_timeout=5000`; kein Migration-/Seed-/UPDATE-/DELETE-Lauf gegen den bestehenden Testdatenbestand.

| Fault / Konfiguration | macOS, Millisekunden | Ubuntu, Millisekunden |
|---|---:|---:|
| Handshake +4000, Timeout 3000 | Fehler nach 3002 | Fehler nach 3003 |
| Handshake +4000, Timeout 0 | verbunden nach 4018 | verbunden nach 4011 |
| Handshake +16000, Timeout 15000 | Fehler nach 15001 | Fehler nach 15000 |
| Handshake +16000, Timeout 0 | verbunden nach 16015 | verbunden nach 16010 |
| Event-Loop-P95 des gesamten Harness | 12 | 13 |

Weitere Assertions: max=1 und max=10 werden nicht überschritten; volle Pools haben genau einen kontrollierten Queue-Warter; finite Queue-Timeouts unterscheiden sich vom Connect-Fehler; Timeout 0 fährt nach Release fort. Am Ende jedes Falls `waitingCount=0` und `totalCount=idleCount`. `pg_sleep(0.12)` auf einem bereits verbundenen Pool läuft trotz danach gesetztem 40-ms-Connect-Limit erfolgreich. Beendete eigene Proxy-Sockets lösen einen behandelten Idle-Error aus; SELECT funktioniert nach Wiederverbindung. Das echte OAuth-Plugin erhält vor seinem verspäteten Consumer einen nativen Connect-Fehler, ohne unhandled rejection; das originale `$context` bleibt ablehnend.

**Grenze:** Der OAuth-Adapterzugriff ist eine kontrollierte Fixture und scheitert vor Ausführung der `oauth_resource`-Abfrage. Die Matrix ist kein kompletter Drizzle/Auth-/Container-Start und keine vollständige `.9`/`.10`/only-0/Kandidat-Image-Matrix. Die Produktionsursache für >15 Sekunden ist weiterhin nicht gemessen.

## Lockfile und Build-Voraussetzung

Unveränderter SHA-256 von `package-lock.json` auf Host und Ubuntu:

```text
435bb17efba6f71005fd1286fd8e24a63038a215c905f5f52a1979864d595b1e
```

`npm ci --legacy-peer-deps` ließ 42 im Lockfile vorhandene Peer-Pakete aus, unter anderem `@testing-library/dom` und Webpack-Abhängigkeiten. Das verursachte den ursprünglichen Lizenzinventarfehler und fehlende UI-Test-Exports im Typecheck. `npm ci --force` mit gepinnter Toolchain installierte diese Pakete aus demselben Lockfile trotz bestehender veralteter React-Peer-Bereiche. Anschließend: 1996 Lizenzkomponenten, 0 Blocker, `gate=approved`; keine Lizenzfreigabe, Paketversion oder Lockfile-Änderung.

**Damals offene Build-Parität:** Das Dockerfile verwendete zu diesem Prüfstand weiterhin `npm ci --legacy-peer-deps`. Der grüne Quellbuild mit vollständiger Peer-Installation bewies deshalb noch keinen grünen unveränderten Docker-Build. Vor Container-/Release-Abnahme waren Peer-Metadaten bzw. Installationsmodus separat zu entscheiden und im echten Image zu prüfen; zu diesem Zeitpunkt war kein `--force` in das Dockerfile übernommen. Die inzwischen geprüfte Entscheidung steht im Folgeprüfbericht. npm meldete außerdem acht bestehende Audit-Befunde (2 moderate/5 high/1 critical), nicht Gegenstand dieser Regression; kein pauschales Audit-Fix ausgeführt.

## Ubuntu-Reproduktion ohne neuen Stack

Maschine `ubuntu`: Ubuntu 26.04.1 LTS, `aarch64`. Exaktes `git archive` des Kandidaten wurde in `/home/frankalexanderweber/canvas-startup-regression.FpXCXg` extrahiert und frisch mit Linux-Abhängigkeiten installiert. Der ältere Checkout `/home/frankalexanderweber/canvas-notebook-test` blieb unverändert. Kein Wiederverwenden seiner `node_modules` oder `.next`.

Vom Host aus, im bestehenden Kandidatenverzeichnis:

```sh
orb -m ubuntu sh -lc 'cd /home/frankalexanderweber/canvas-startup-regression.FpXCXg && npx --yes --package=node@24.18.0 --package=npm@11.11.0 -c "node --version && npm --version && npm ci --force --loglevel=error"'
orb -m ubuntu sh -lc 'cd /home/frankalexanderweber/canvas-startup-regression.FpXCXg && npx --yes --package=node@24.18.0 --package=npm@11.11.0 -c "npm run test:postgres:startup && node ./node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false"'
orb -m ubuntu sh -lc 'cd /home/frankalexanderweber/canvas-startup-regression.FpXCXg && env -u SENTRY_AUTH_TOKEN npx --yes --package=node@24.18.0 --package=npm@11.11.0 -c "npm run build"'
```

Der vorhandene verwaltete PostgreSQL-Testdienst ist von Ubuntu über `host.orb.internal:55433` erreichbar. Folgender Launcher lädt ausschließlich den Testzugang aus privatem State in die Child-Umgebung; keine URL in Argumenten, Logs oder Repositorydateien. Er startet keinen App-Service:

```sh
orb -m ubuntu sh -lc 'cd /home/frankalexanderweber/canvas-startup-regression.FpXCXg && node --input-type=module' <<'NODE'
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
const config = dotenv.parse(readFileSync('/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env'));
const target = new URL(config.DATABASE_URL);
target.hostname = 'host.orb.internal';
const child = spawn('npx', ['--yes', '--package=node@24.18.0', '--package=npm@11.11.0', '-c', 'npm run test:postgres:startup:integration -- --slow'], {
  stdio: 'inherit', env: { ...process.env, CANVAS_TEST_POSTGRES_URL: target.toString() },
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
NODE
```

Der Test akzeptiert nur explizit `CANVAS_TEST_POSTGRES_URL` mit lokalem Ziel, niemals einen `DATABASE_URL`-Fallback. Ohne `--slow` dauert die künstliche Handshake-Verzögerung 200 ms statt 4/16 Sekunden. Alle erzeugten Pools und Proxy-Sockets werden geschlossen; ein 120-Sekunden-Watchdog begrenzt den Prozess. Nur die neue Quell-/Dependency-/Build-Kopie bleibt zur Wiederholung auf Ubuntu erhalten.

## Damals offene Abnahme vor gesonderter Freigabe

- Genau einen autorisierten verwalteten Notebook-Testcontainer aus dem Kandidaten neu bauen/erstellen; zuvor Docker-Installationsparität klären. Zu diesem Quell-/Driver-Prüfstand war noch kein Container für diesen Auftrag gebaut, ersetzt oder neu gestartet.
- Vollständige Versions-/Override-Matrix mit frischer und vorhandener migrierter Test-DB, MCP an/aus, echten OAuth-/Login-Flows; zehn wiederholte Starts, ein kalter Start, anschließend 20 Minuten Nachlauf inklusive Session-Cleanup.
- Tatsächliche Runtime-Pool-Anzahl, Startup-Phasen, Backend-Wartezustände, Ressourcenlimits und RestartCount messen. Weitere Wartungs-Serialisierung nur bei nachgewiesenem Bedarf; künstliche Proxy-Verzögerung nicht als Produktionsdiagnose ausgeben.
- UI-/Playwright-Prüfung benötigt gemäß Repository-Regeln eine ausdrückliche Freigabe; kein Browser benutzt. Keine Änderung am Produktions-Override `15000`, kein Push, Tag, Release oder Deploy.

Implementierung und Quell-/Driver-Tests waren damit reviewbar. Die späteren Betriebsprüfungen bleiben mit ihren tatsächlichen Ergebnissen und Grenzen im Folgeprüfbericht getrennt nachvollziehbar.
