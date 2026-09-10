# PostgreSQL-Startup: Container- und Neuinstallationsprüfung

Abgeschlossen: 10.09.2026. Produktkandidat `37b7751fae0d6ff62ce41fe24708fd223d9de61e`, Branch `codex/postgres-startup-regression-plan`. Ergänzt den [Quell-/Driver-Prüfbericht](postgres-startup-regression-verification.md) und den [ursprünglichen Plan](postgres-startup-regression-plan.md). Container-Build und Browserprüfung wurden anschließend ausdrücklich autorisiert; keine Veröffentlichung oder Production-Änderung.

**Ergebnis:** Beide Neuinstallationspfade (Bootstrap-Admin und manueller Ersteigentümer), 40 erfolgreiche Wiederholungsstarts der gesunden Konfigurationen einschließlich Bestand sowie der echte 20-Minuten-Nachlauf sind bestanden. Host-/Ubuntu-/Docker-Builds und Regressionstests sind grün. Der weiterhin wirksame **3000-ms-Override reproduziert dagegen den OAuth-Startup-Fehler** und wird ausdrücklich nicht als gesunde Konfiguration abgenommen. Der Kandidat behandelt diesen Fehler kontrolliert; Default 0 bleibt die gezielte Rücknahme der Regression.

## Weitere Änderungen vor dem finalen Image

| Commit | Befund und Korrektur |
|---|---|
| `53768aee` | Docker installiert mit `npm ci --force` den vollständigen unveränderten Lockfile-Graph. `--legacy-peer-deps` ließ 42 benötigte Peer-Pakete aus. Runtime-Pruning mit `--omit=dev --force --ignore-scripts`; kein nachträgliches, Versionen neu auflösendes `npm install tsx`. Die bereits gelockte Produktionsabhängigkeit `tsx` wird im Image auf ihre Lockfile-Version geprüft. Lizenzgate und native Sharp-Linkage-Prüfung bleiben aktiv. |
| `37b7751f` | Neuinstallationsprüfung fand einen zusätzlichen Session-Cleanup-Fehler: Das PostgreSQL-Schema schreibt Epoch-Millisekunden, die Query verglich Sekunden. Bestehende Daten enthalten beide Formate. Cleanup berücksichtigt beide Einheiten und erhält gültige Legacy-Sekunden-Sessions. Regressionstest führt den echten Scheduler-Funktionskörper gegen PGlite aus und bezieht die Millisekunden aus dem echten Schema-Codec; vorher rot, danach grün. |

GitNexus-Impact vor diesen Änderungen: Dockerfile LOW/0 direkte Aufrufer (operativ alle Images betroffen); `scheduleExpiredSessionCleanup` LOW/1 direkt, `purgeExpiredSessions` LOW/1 direkt/2 insgesamt. `detect-changes --scope staged` lief vor beiden Commits. Der globale Pool/Auth-Impact bleibt wie im Vorbericht HIGH/CRITICAL; die neuen Änderungen rechtfertigen keine kleinere Einschätzung dieser ursprünglichen Importfläche.

Der Installationsmodus ist eine bewusste Tolerierung bestehender Upstream-Peer-Konflikte, keine Korrektur ihrer Metadaten. Die npm-Optionen sind in der [offiziellen Config-Referenz](https://docs.npmjs.com/cli/v11/using-npm/config/) und [Prune-Dokumentation](https://docs.npmjs.com/cli/v11/commands/npm-prune/) beschrieben. Kein `npm audit fix`, keine Paket-/Lockfile-/Lizenzfreigabeänderung.

## Umgebung und genaue Abgrenzung

- Genau ein Notebook-Testcontainer: `canvas-local-prod-notebook`, ausschließlich `127.0.0.1:3100` veröffentlicht. Jeder Lauf ersetzt ihn mit `--force-recreate --no-deps`, prüft eine neue Container-ID und die aktuelle Image-ID.
- Bestehender verwalteter Docker-Kontext `orbstack`, ARM64; 10 CPUs, 25.23 GB Docker-RAM; keine individuellen CPU-/RAM-Limits am Notebook. Control Plane API/UI und PostgreSQL liefen weiter und wurden nicht ersetzt.
- PostgreSQL 18.4 mit verfügbarer pgvector-Version 0.8.3 im bereits vorhandenen Testserver. Bestehende DB `canvas_notebook` und ihr `/data` bleiben erhalten; separater privater `pg_dump` vor den Tests.
- Frische DB `canvas_startup_test_20260910` aus `template0`, anfangs 0 öffentliche Tabellen und keine installierte `vector`-Extension. Eigener leerer `/data`-Bind-Mount. Bootstrap-Admin aus privater lokaler Env, Direct MCP an.
- Zweite leere DB `canvas_startup_owner_test_20260910` und eigener leerer `/data`-Mount für den UI-Ersteigentümer ohne Bootstrap-Variablen.
- Das ist ein echter Neuinstallationsnachweis **auf Datenbank-/App-Ebene im External-PostgreSQL-Modus**, kein Neuaufsetzen des gemeinsamen PostgreSQL-Clusters, seiner Rollen oder einer kompletten Installer-VM. Die Installer-/CLI-Defaults wurden zusätzlich mit den vorhandenen Shell-Fixture-Tests geprüft; deren Docker-Aufrufe sind Mocks.

Finales ARM64-Image:

```text
canvas-notebook:local-prod
sha256:590aeb1fda7a76b42230c25a543f1665267781f8112c0f4d5871d22f91f7ff02
```

Node 24.18.0, npm 11.11.0, pg 8.22.0, tsx 4.23.1. Unveränderter Lockfile-SHA256 `435bb17efba6f71005fd1286fd8e24a63038a215c905f5f52a1979864d595b1e`. `server.js` im Image und Checkout: `1b987d8103b0d594f4b6cb7c778de8cd76eac4ff15c5af1b27a64e4aa5663070`.

Der Stack-Skill erzwang vollständiges `npm run build` auf dem Host vor jedem Docker-Build und begrenzte alle Änderungen auf den einen verwalteten Notebook-Dienst. Beide Build-/Recreate-Läufe (vor und nach der Cleanup-Korrektur) waren erfolgreich; Lizenzinventar, Typecheck, Next-Build, Runtime-Inventar und native Sharp-Prüfungen liefen tatsächlich. Nach beiden normalen Skill-Starts wurden auch die beiden lokalen Benutzer-/Workspace-/Ollama-Fixtures über die vorgesehenen APIs verifiziert.

## Bereits abgeschlossene Fälle

| Fall | Ergebnis |
|---|---|
| Leere DB, leeres `/data`, Bootstrap-Admin, MCP an, Timeout 0/max 10 | Erste gesunde Antwort nach 58.172 ms inklusive Container-Austausch, Migrationen und Bootstrap. 136 Tabellen, `vector 0.8.3`, genau 1 Admin/1 Credential/1 OAuth-Resource, 0 unvalidierte Fremdschlüssel. Login, Session-Identität und Logout erfolgreich; 0 automatische Restarts. |
| Datenmigrationen beim Erststart | `main-agent-id-bradley-v1` und `memory-reviewer-opt-in-v1` registriert. Wiederholte Starts müssen dieselben Benutzer-/Credential-/Resource-Anzahlen erhalten. |
| Unerreichbare DB | Nur eigener Notebook-Test: Verbindung nach `127.0.0.1:1`, Restart-Policy `no`. Entrypoint beendet Migration kontrolliert mit Exit 1, keine unhandled rejection und kein Neustart. Danach gesunder Wiederanlauf derselben frischen Testinstallation nach 53.209 ms. |
| Bootstrap-Admin im Browser | Ungültige Credentials: 401 und sichtbare Fehlermeldung. Korrekte private Credentials über das Formular: Onboarding. Reload erhält Sitzung. Zeitzone gespeichert, optionale Lizenzaktivierung bewusst übersprungen, KI-Provider-Schritt erreicht und nach Reload erhalten. |
| Responsive Erst-Setup | Desktop 1600×900 und Mobile 390×844 visuell geprüft, kein horizontaler Überlauf, wesentliche Beschriftungen/Formular/Aktion ohne Abschneiden sichtbar. Passwort-Anzeigen/Verbergen mit ungültigem Fixture-Passwort geprüft. |
| Finale Ubuntu-ARM64-Kopie | Frische Lockfile-Installation, vollständiges `npm run build` (Next-Kompilierung 106 s, Typecheck 72 s, Seitengenerierung und CLI-Injektion), danach alle 11 Startup-Testgruppen und `docker-dependency-contract-test.mjs`: Exit 0. |
| Bestehende PostgreSQL-Regressionssuite auf Ubuntu | `npm run test:db:postgres-regressions`: SQL-Kompatibilität, Provider-Erkennung, File-Metadata-Parameter und Session-Runtime-CAS bestanden. Isolierte PGlite-/Quelltests, keine Veränderung am laufenden Testcontainer. |
| Native PostgreSQL-Matrix, finaler Ubuntu-Stand | Erneut alle 12 Fälle mit `--slow` bestanden, read-only. 4-s-Handshake: 3000-ms-Timeout nach 3002 ms, Timeout 0 verbunden nach 4010 ms. 16-s-Handshake: 15000-ms-Timeout nach 15004 ms, Timeout 0 verbunden nach 16028 ms. Harness-Event-Loop-P95 16 ms. |
| Abschließender Host-Lint | Vollständiges `npm run lint` unter Node 24.18.0/npm 11.11.0: Exit 0. |

Kein externer Lizenz-Key angefordert, kein Newsletter-/Kaufvorgang, keine KI-Provider-Credentials hinterlegt und keine Modellanfrage ausgelöst. Die Konfiguration eines KI-Providers und die nachfolgenden fachlichen Onboarding-Schritte sind kein Bestandteil dieses Datenbank-Startup-Nachweises. Die unangemeldete Branding-Logo-Abfrage meldete einen bestehenden 401, mit sichtbarem Fallback-Logo; nicht mit einem DB-/Auth-Startup-Fehler verwechseln.

## Wiederholungs- und Langzeitprüfung

| Wiederholungsvariante | Erfolgreiche Läufe | Readiness inkl. Recreate | Größte beobachtete Pool-Queue |
|---|---:|---:|---:|
| Timeout 0, max 10, MCP an | 10/10 | 53.413–70.875 ms | 0 |
| Timeout 0, max 1, MCP aus | 10/10 | 53.430–64.088 ms | 3 |
| Timeout 3000, max 10, MCP an | **Negativfall reproduziert; Serie gestoppt** | 503 bis zum Startbudget | 0 im Fehlerlauf |
| Timeout 15000, max 10, MCP an | 10/10 | 53.093–66.317 ms | 0 |

Während eines Teils der ersten beiden Serien lief zusätzlich der native Ubuntu-Build. Die Zeiten sind daher kein isoliertes Performance-Benchmark. Pooloptionen werden anhand der tatsächlich erzeugten pg-Pools gegen die jeweilige Testkonfiguration geprüft. Alle 30 erfolgreichen Wiederholungsrunden: Auth/DB gesund, MCP passend ready/disabled, Login/Session/Logout erfolgreich, keine doppelten Bootstrap-Datensätze und kein automatischer Restart.

### Tatsächliche Reproduktion mit positivem 3000-ms-Override

Der erste Lauf dieser Variante wurde nicht gesund. Der Custom-Server meldete zunächst erfolgreiche Auth-Initialisierung; danach erschienen zwei weitere Runtime-Pools im selben Prozess. Bei deren Initialisierung wurde ein Event-Loop-P95 von 4349 ms und anschließend 5805 ms gemessen. Ein Delegation-Dispatcher-Zugriff scheiterte nachweislich mit `Connection terminated due to connection timeout`. Health blieb ehrlich bei `auth:error`, `mcp:error`, `db:ok` (503), obwohl die Pools später wieder frei waren.

Das eigene Testbudget brach nach 180 Sekunden ab; anschließend beendete auch das tatsächliche Server-Readiness-Budget den Start kontrolliert. Die normale lokale Restart-Policy erzeugte **einen** automatischen Neustart. Auch in diesem blieb der Auth-Kontext fehlerhaft; ein unauthentifizierter `get-session`-Aufruf lieferte 500 und machte den gespeicherten Fehler einer echten `oauth_resource`-Abfrage sichtbar. Keine unhandled rejection. Weitere automatische Restarts wurden ausschließlich für diesen Testcontainer deaktiviert, bevor die nächste Konfiguration ihn ersetzte.

Damit ist 3000 ms auf diesem lokalen Vollstart **nicht** als gesunde Betreiber-Konfiguration abgenommen. Die übrigen neun geplanten Erfolgswiederholungen wurden nach dem reproduzierten Timeout nicht fortgesetzt. Der positive Override bleibt unverändert wirksam; er darf nicht stillschweigend durch den Fix ignoriert werden. Die Messung stützt lokal Startup-/Event-Loop-Konkurrenz als Timeout-Auslöser, beweist aber nicht die konkrete >15-Sekunden-Ursache in Production. Ein Auth-Promise wird nach Ablehnung bewusst nicht automatisch neu initialisiert oder durch spätere erfolgreiche DB-Pings als gesund ausgegeben.

### Pool-/Backend-Messung und Serialisierungsentscheidung

In allen 33 bis zum Nachlauf abgeschlossenen Kandidatenstarts mit der separat initialisierten Testdatenbank wurden **drei Runtime-Pools in derselben Server-PID** beobachtet. Je Pool stimmen Max/Timeout mit der jeweiligen Konfiguration überein. Das bestätigt die im ursprünglichen Plan offene Mehrfach-Modulinstanz-Grenze: `max=10` ist ein Poollimit, kein containerweites Verbindungslimit. Die separaten Migration-/Bootstrap-Prozesse sind darin nicht mitgezählt. Nur der erste Start verwendet eine wirklich leere DB; die Wiederholungen prüfen zusätzlich Migrations-/Bootstrap-Idempotenz auf demselben erhaltenen Testbestand.

Während der späteren Wiederholungsserien wurden alle drei Sekunden PostgreSQL-Backend-Zustände aufgenommen: 501 Stichproben, maximal sechs Backends dieser Testdatenbank, kein beobachtetes `Lock`-Warten. Die Diagnoseverbindung selbst wird aus der Abfrage ausgeschlossen. Pool-Probes alle fünf Sekunden plus Connect-/Create-Ereignisse und Backend-Sampling liefern **beobachtete**, keine garantierten absoluten Maxima; sie ersetzen kein Profiling des Production-Hosts.

Für eine weitere pauschale Wartungs-Serialisierung oder einen globalen Pool-Singleton besteht nach den gesunden Timeout-0-Läufen einschließlich max=1 kein hinreichender Anlass. Beibehalten werden die gezielte Auth→MCP-Reihenfolge, sofortige Promise-Fehlerverantwortung, Health-Single-flight sowie die konkreten Cleanup-/Memory-Guards. Der volle 3000-ms-Negativfall zeigt zugleich, warum das erfolgreiche erste Auth-Gate nicht mit der Bereitschaft aller später geladenen Auth-/Next-Modulinstanzen gleichgesetzt werden darf. Ein dauerhaft abgelehnter späterer Auth-Kontext wird von Health erfasst und begrenzt den Start, statt als gesund oder unhandled weiterzulaufen.

Eine spätere Production-Umstellung muss ausdrücklich berücksichtigen: Ein noch gesetzter `CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS=15000` gewinnt weiterhin gegen den reparierten Default. Zum tatsächlichen `.9`-Timeoutverhalten müsste dieser Override separat autorisiert entfernt oder auf `0` gesetzt werden. Das wurde hier **nicht** vorgenommen.

### 20 Minuten Nachlauf mit echtem Session-Timer

Nach erneutem Recreate mit Timeout 0/max 10/MCP an lief derselbe Container 1212 Sekunden nach Fixture-Erzeugung, ohne Restart oder Austausch. 122 Health-Anfragen einschließlich zweier Wellen von je 50 parallelen Anfragen waren erfolgreich; maximale gemessene Antwortzeit 199 ms. Jede Antwort meldete Auth/DB/MCP bereit. Keine unhandled rejection, kein Connection-Timeout und keine Cleanup-Fehlermeldung.

Nach dem unmittelbaren Startup-Cleanup wurden vier ausschließlich testeigene Sessions angelegt: je eine abgelaufene und eine gültige in Sekunden bzw. Millisekunden. Der **reale** 15-Minuten-Scheduler entfernte beide abgelaufenen Sessions; Log: `[Session Cleanup] Deleted 2 expired session(s)`. Die Löschung wurde nach 840 Sekunden Fixture-Nachlauf erstmals beobachtet, weil der Scheduler bereits vor der Fixture-Erzeugung gestartet war. Beide gültigen Sessions blieben bis zum Testende erhalten. Danach entfernte das Harness nur die verbleibenden eigenen Fixture-Zeilen.

Nach abschließender Ruhephase: drei Pools mit `total/idle/waiting = 0/0/0`, `1/1/0`, `1/1/0`; während des erfassten Nachlaufs kein beobachteter Queue-Warter. Der Server sowie alle anderen verwalteten Dienste blieben gesund. Kein beschleunigter Timer und kein manueller Aufruf der Produkt-Cleanup-Funktion.

### Zweite Neuinstallation: Ersteigentümer über die UI

Eine zweite DB aus `template0` und ein zweites leeres `/data` wurden mit **leeren Bootstrap-Admin-Variablen** gestartet. Nach 56.330 ms einschließlich Recreate/Migrationen waren Auth/DB/MCP gesund: 136 Tabellen, pgvector 0.8.3, 0 Benutzer/0 Credentials und 1 OAuth-Resource. Die Startseite leitete korrekt nach `/de/setup`.

Mit realen Formulareingaben geprüft: Deutsch→Englisch→Deutsch, Passwort-Anzeigen/Verbergen, unterschiedliche Passwortbestätigung mit sichtbarer Fehlermeldung, erfolgreiche Admin-Erstellung (200), automatische Anmeldung und Onboarding nach Reload. Ein bereits vorher geöffneter zweiter mobiler Setup-Dialog erhielt beim Absenden nach der ersten Erstellung **409** und leitete zum Login weiter. Anmeldung mit dem neu angelegten Admin gelang auch dort. Ein zusätzlicher API-Wiederholungsversuch wurde ebenfalls mit `ALREADY_CONFIGURED`/409 abgewiesen.

Nachher weiterhin genau 1 Benutzer mit Admin-Rolle, 1 Credential und 1 OAuth-Resource; 0 unvalidierte Fremdschlüssel, 0 Restarts. Jetzt 137 Tabellen: ausschließlich `security_public_rate_limits` kam erwartungsgemäß durch den öffentlichen Setup-Endpunkt hinzu. Kein zweiter Admin. Login/Session-Identität/Logout auch separat über HTTP verifiziert.

Desktop 1600×900 und Mobile 390×844 visuell geprüft: gesamtes Erst-Setup-Formular einschließlich Submit sichtbar, kein horizontaler Überlauf oder abgeschnittene Pflichtfelder. Post-Submit-Onboarding ebenfalls geprüft; keine beobachteten Page-Errors. Screenshots und Ergebnisse: `manual-owner-*.png`, `manual-owner-before.json`, `manual-owner-after.json`, `ui-manual-owner-result.json` im privaten Artefaktverzeichnis.

### Rückkehr zur Bestandsdatenbank und Endzustand

Alle **10/10** Wiederholungsstarts auf der erhaltenen DB `canvas_notebook` und dem ursprünglichen `notebook-data` waren erfolgreich, mit 53.315–57.012 ms bis Readiness einschließlich Recreate. Jeweils Login/Session-Identität/Logout erfolgreich und RestartCount 0; MCP entsprechend der ursprünglichen lokalen Konfiguration deaktiviert. Test-Datenbank-Overrides, Probe-Mount und `NODE_OPTIONS`-Preload sind entfernt. Die Bestandsserie ist deshalb nicht pool-instrumentiert: leere Probe-Arrays im Harness sind **kein** Messwert „null Pools“.

Direkt im finalen Container geprüft: unveränderter `server.js`-SHA256 des Kandidaten, Node 24.18.0, pg 8.22.0, tsx 4.23.1 und aus der normalen Umgebung aufgelöste Pooloptionen `{ max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 0 }`. Timeout/Poolgröße sind in der ursprünglichen lokalen Env nicht überschrieben; hier wird tatsächlich der neue Default geprüft.

`status-local.sh`: alle vier Dienste gesund; Notebook-, Control-Plane-API- und Control-Plane-UI-Endpunkte erfolgreich; PostgreSQL 18.4/pgvector 0.8.3 in `canvas_notebook`. `npm run testenv:fixtures`: Exit 0, bestehende begrenzte Development-Team-Lizenz (`test/development`), beide lokalen Logins, gemeinsamer Workspace mit Schreibberechtigungen und die vorgesehene Ollama-Runtime verifiziert. Bestehende App-Oberfläche über das Loginformular geöffnet und nach Reload einschließlich fertig geladener Startseite visuell geprüft (1600×900, kein horizontaler Überlauf).

Der eine Notebook-Testcontainer bleibt auf dem geprüften Kandidaten und dem **vorhandenen** Datenbestand stehen. Control Plane und PostgreSQL wurden während der Prüfung nicht ersetzt. Die beiden separaten neuen Testdatenbanken/-Datenverzeichnisse, private DB-Sicherung und Ubuntu-Kopie bleiben für Nachprüfung erhalten; die vier temporären Soak-Session-Fixtures sind vollständig entfernt. Die private Compose-Konfiguration zeigt weiterhin auf den aktuellen Worktree `7611`; die vorige Konfiguration liegt als `compose.env.before-postgres-startup-20260910` im privaten State. Keine Produktionsdaten, kein anderes VM-/Test-Setup und kein veröffentlichter Release wurden verändert.

## Verbleibende Grenzen der Aussage

- Keine neu gebauten historischen Vollimages von `.9`, unverändertem `.10` und `.10`-only-0. Deren Timeout-/Promise-Unterschiede sind mit den echten installierten Treibern/Plugins und den kontrollierten nativen Verzögerungstests aus dem Vorbericht charakterisiert; der Vollcontainer-Nachweis gilt für den hier genannten Kandidaten.
- Die reale Fehlerprobe „DB unerreichbar“ verwendet sofortiges Connection-refused, keinen dauerhaft schweigenden Netzpfad während der Migration. Das 180-Sekunden-Readiness-Budget beginnt beim Node-Server; vorangehende Migrationen/Bootstrap sind kein Bestandteil dieses Budgets. Migrationen dürfen nicht unbesehen mit einem kurzen pauschalen Query-Timeout abgebrochen werden.
- PostgreSQL-Clusterinstallation, restriktivere externe Datenbankrollen, Betriebssystem-/Netzwerk-Provisioning und die Production-Ressourcen-/Netzwerksituation wurden nicht neu aufgesetzt oder verändert. App-/Datenbank-Erststarts, Erweiterungserzeugung und Migrationen wurden dagegen tatsächlich ausgeführt.
- Die npm-Aliase `test:auth:setup` und `test:db:unavailable` zeigen bereits auf `main` auf fehlende Dateien. Sie wurden nicht als bestandene Tests verbucht. Der reale Erst-Setup-/Fehlernachweis in diesem Bericht ersetzt keine Reparatur dieser unabhängigen Baseline-Testlücken.

## Reproduktion und private Artefakte

Alle temporären Testskripte, Compose-Overrides, Logs und Ergebnisse liegen außerhalb des Repositorys in:

```text
/Users/frankalexanderweber/.local/state/canvas-local-team-seat/startup-validation.pEFqBt
```

Das Verzeichnis ist privat (0700), rohe Logs/Ergebnisse 0600. `fresh.yaml` interpoliert ausschließlich die bereits private Compose-Env; es enthält kein Passwort. `pool-probe.cjs` ist nur als Read-only-Testmount und über `NODE_OPTIONS` aktiv, nicht im Produktimage. Es protokolliert PID/Pool-ID, Max/Timeout, total/idle/waiting und Event-Loop-P95; keine URLs, SQL-Parameter oder Benutzer. Es hängt **keinen** Error-Handler an und ersetzt keine Connect-/Query-Promises.

Die folgenden Befehle sind nur für diesen autorisierten, privaten lokalen Stack bestimmt. Sie ersetzen jeweils den einen Notebook-Testcontainer; sie sind keine allgemeinen Production-Kommandos:

```sh
npx --yes --package=node@24.18.0 --package=npm@11.11.0 -c 'node /Users/frankalexanderweber/.local/state/canvas-local-team-seat/startup-validation.pEFqBt/container-check.mjs matrix'
npx --yes --package=node@24.18.0 --package=npm@11.11.0 -c 'node /Users/frankalexanderweber/.local/state/canvas-local-team-seat/startup-validation.pEFqBt/container-check.mjs matrix-15000'
npx --yes --package=node@24.18.0 --package=npm@11.11.0 -c 'node /Users/frankalexanderweber/.local/state/canvas-local-team-seat/startup-validation.pEFqBt/soak-check.mjs'
npx --yes --package=node@24.18.0 --package=npm@11.11.0 -c 'node /Users/frankalexanderweber/.local/state/canvas-local-team-seat/startup-validation.pEFqBt/container-check.mjs restore'
```

`matrix` setzt eine bereits initialisierte frische DB voraus und führt die konfigurierten Varianten nacheinander aus; bei einem Fehler stoppt es und sichert `failure-last.log`. Der 3000-ms-Fall kann wie beschrieben real scheitern. Vor einer Fortsetzung den Fehler auswerten, den automatischen Neustart dieses exakten Testcontainers bei Bedarf mit `docker update --restart=no canvas-local-prod-notebook` begrenzen und Logs sichern. `matrix-15000` ist der explizite Fortsetzungseinstieg für die zehn 15000-ms-Läufe und endet wieder bei Timeout 0/MCP an. Nicht beide Prozesse gleichzeitig ausführen.

`soak-check` prüft den exakten Datenbanknamen und das aktuelle Image, erzeugt ausschließlich vier eigene Session-Fixtures, prüft den tatsächlichen 15-Minuten-Cleanup und entfernt verbleibende eigene Fixtures. `restore` entfernt alle Test-Overrides und verwendet wieder die vorhandene Datenbank und das ursprüngliche Notebook-Datenverzeichnis. Ohne neue Buildfreigabe vorhandenes Kandidatenimage verwenden; nach Produktänderungen zuerst Host-Build und dann den einen Kandidaten neu bauen.

Für einen **erneuten echten Erststart** eine neue eindeutig benannte Testdatenbank aus `template0` und ein neues leeres Test-Datenverzeichnis anlegen sowie die privaten Override-/Harness-Ziele entsprechend anpassen. Vorher Tabellenzahl 0 und fehlende Extension prüfen; keine existierende DB oder Datenablage löschen, um den Test künstlich zurückzusetzen. `owner-start` verweigert absichtlich eine bereits befüllte Datenbank.

Ubuntu-Kopie des finalen Produktstands: `/home/frankalexanderweber/canvas-startup-install.gwv5kn`. Der ältere Benutzercheckout und die vorangegangene Verifikationskopie bleiben unangetastet. Für Quelltests ist ein externes `node_modules`-Symlink ausreichend, Turbopack verweigert es jedoch außerhalb seines Root. Deshalb erfolgt der finale Build mit einer eigenen frischen `npm ci --force`-Installation in dieser Kopie. Ein zunächst **innerhalb** des Projekts umbenanntes Symlink-Backup wurde vom TypeScript-Glob mitgezählt (24.726 zusätzliche Dependency-Dateien) und führte bei 4/6 GB zu Heap-OOM; dieses eigene Testartefakt wurde anschließend außerhalb des Projekts aufbewahrt. Das ist kein Produkt-/Lockfile-Fehler. Der saubere Wiederholungslauf verwendet dasselbe 6-GB-Buildbudget wie das Dockerfile. Toolchain und Lockfile bleiben identisch. Native PG-Verzögerungs-/Queue-/Idle-Fehlertests und Zugangsladung sind im Vorbericht reproduzierbar beschrieben.

```sh
orb -m ubuntu sh -lc 'cd /home/frankalexanderweber/canvas-startup-install.gwv5kn && env -u SENTRY_AUTH_TOKEN NODE_OPTIONS=--max-old-space-size=6144 npx --yes --package=node@24.18.0 --package=npm@11.11.0 -c "npm ci --force --loglevel=error && npm run build && npm run test:postgres:startup && node scripts/docker-dependency-contract-test.mjs"'
```
