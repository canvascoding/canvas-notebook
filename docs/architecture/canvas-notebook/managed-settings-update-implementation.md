# Managed Settings Updates: Umsetzungsplan und Abnahme

Stand: 2026-09-22

## Ziel und Grenzen

Ein Instanzadministrator kann ein zentral freigegebenes Update in Settings starten,
den Fortschritt auch waehrend des Containerwechsels verfolgen und nach Wiederkehr
der App den verifizierten Abschluss oder einen Fehler sehen.

Verbindlicher Weg: Notebook UI -> Notebook API -> Control Plane -> bestehender
Agent-WebSocket -> Host-Agent -> vorhandene Host-CLI. Die Control Plane behaelt
Releaseauswahl, persistente Runs, Sperren, Policy und abschliessende Verifikation.
Es entsteht kein zweiter Docker-Updatepfad und kein allgemeiner Host-Shell-Zugang.
Standalone behaelt seinen Unix-Socket-Updater.

## Ausgangsbefund

- Notebook erwartet `/v1/managed-system-updates`; die gepruefte Control Plane
  implementiert diesen Vertrag nicht und behandelt ihn als Benutzer-Session-API.
- Der vorhandene Managed-Token erreicht dort HTTP 401.
- Die lokale VM verwendet `http://host.orb.internal:4001`; das neue Notebook-Backend
  erlaubt HTTP nur an Loopback-Adressen.
- Agent-Phasen werden aus Terminaltext abgeleitet, obwohl die CLI bereits
  `--event-stream --operation-id` unterstuetzt.
- Das Managed-Backend liefert keinen unabhaengigen Statuszugang.
- Der bestehende Architekturplan bezeichnet Phase 7 voreilig als abgeschlossen.
- Vorhandene VM: App/CLI 2026.8.29.5. Lokaler Docker-Stack: Notebook 2026.9.16.2,
  Update-Worker deaktiviert, Notebook ohne Instanz-Token im manuellen Modus.
  Diese laufenden Artefakte gelten nicht als Abnahme des neuen Quellstands.

## Gemeinsamer Schnittstellenvertrag

Kanonischer Namespace: `/v1/managed/system-updates`.

| Aufruf | Ergebnis |
| --- | --- |
| GET `/availability?channel=stable` | `SystemUpdateAvailability`, contractVersion 1 |
| POST `/` mit `channel`, `expectedReleaseId` | 202 mit `{ operation }`, erst nach persistenter Uebergabe |
| GET `/:operationId` | `{ operation }` fuer die authentifizierte VM |
| GET `/:operationId/events?after=N` | `{ operation, events }`, monotoner Journal-Cursor |
| POST `/:operationId/status-ticket` | kurzlebiger, nur lesbarer und operationsgebundener Statuszugang |

Operationen und Events entsprechen den vorhandenen Notebook/CLI-Typen. Die
oeffentliche operationId ist die persistente Run-Item-ID; interne cmdIds und
Release-Image-Referenzen bleiben serverseitig. `succeeded` bedeutet zentral
verifizierten Erfolg, nicht bloss einen CLI-Exitcode. Ein verifizierter Rollback
wird von Fehlern und unklaren Zustaenden unterschieden.

Instanz-Tokens duerfen nur ihre eigene VM und deren Operationen ansprechen.
Neue Berechtigungen fuer Update-Lesen und -Start werden explizit eingefuehrt und
bestehende provisionierte Tokens kontrolliert migriert. Browser erhalten weder
Instanz-Token noch frei waehlbare Images, VM-IDs oder Shell-Befehle.

Der Statuszugang verwendet dieselben Snapshot-Daten und kann direkt von der
Control Plane gelesen werden. Ein Ticket gilt nur fuer eine Operation, laeuft ab
und erlaubt keine Mutation. Die UI akzeptiert ausschliesslich serverseitig
validierte URLs; CORS und Credential-Verhalten muessen dazu passen. Standalone-
SSE bleibt kompatibel. REST-Polling bleibt der verbindliche Recovery-Pfad.

Lokales HTTP ist nur ueber eine ausdrueckliche Entwicklungs-Konfiguration fuer
konkrete lokale Hosts erlaubt; der HTTPS-Standard fuer Produktion bleibt bestehen.
Ein als Managed konfiguriertes Notebook mit fehlenden Credentials darf nicht
stillschweigend auf einen anderen Update-Verantwortlichen wechseln.

## Arbeitspakete und Gates

### Gate 1: Plan und Arbeitsumgebungen

- [x] Befunde und Vertrag dokumentieren.
- [x] Separate Arbeitsbranches fuer Notebook und Control Plane anlegen.
- [x] Plan nach GitNexus-Aenderungspruefung committen.

### Gate 2: Implementierung (ein gemeinsamer Meilenstein mit drei Subagenten)

Die drei Teilbereiche duerfen nach Gate 1 parallel umgesetzt werden. Gate 3
beginnt erst, wenn alle Teilbereiche abgeschlossen und zusammengefuehrt sind.

Status: Alle drei Teilbereiche umgesetzt, zusammengefuehrt und auf Quellcode-Ebene
sowie mit realer VM und Browser lokal abgenommen. Laufzeitbefunde und Grenzen
stehen im [Abnahmeprotokoll](managed-settings-update-acceptance.md).

1. **Control-Plane-API:** neue instanzgebundene Routen, Scope-Migration,
   Readiness/Release-Pruefung, Wiederverwendung der bestehenden Start-Orchestrierung,
   Ownership-Pruefung fuer Status/Events, kurzlebiger Statuszugang, Tests fuer
   Cross-VM-Zugriffe, Worker-offline, Releasewechsel und konkurrierende Starts.
2. **Host-Agent:** strukturierte CLI-Ereignisse validieren und inkrementell parsen,
   Operation-ID zuordnen, Events ins vorhandene Journal transportieren; CLI-
   Faehigkeit vor Start pruefen. Locks, Deadlines, Pre-/Postflight und CLI-Rollback
   beibehalten. Tests fuer Chunk-Grenzen, falsche IDs, ungueltige Events und
   Rueckwaertskompatibilitaet.
3. **Notebook:** Namespace und Backend-Auswahl korrigieren, lokale URL-Policy
   explizit machen, direkten Ticket-Status abrufen und nach App-Reconnect abgleichen,
   permanente Auth-/Not-found-Fehler von Downtime unterscheiden. Tests fuer
   Managed/Standalone/Manual, Ticket-Validierung und Recovery.

### Gate 3: Integration und Abnahme

- [x] Gemeinsame Payloads gegen echte Parser beider Repositories pruefen.
- [x] Fokussierte Tests sowie Control-Plane-Typecheck und Notebook-Build erfolgreich.
- [x] GitNexus detect_changes vor jedem Implementierungscommit; nur erwartete Pfade.
- [x] Bestehenden lokalen Stack nur nach expliziter Build-Freigabe aktualisieren;
      vorher erfolgreicher Host-Build, keine weitere Testumgebung starten.
- [x] Browser-Abnahme nur nach ausdruecklicher Playwright-Freigabe.
- [x] Echte VM-Abnahme: Start, persistente Annahme, Containerwechsel, direkter Status,
      Wiederverbindung, verifizierte Zielversion; Rollback separat kontrolliert testen.
- [x] Nicht ausgefuehrte oder blockierte Laufzeitpruefungen ausdruecklich dokumentieren.

### Gate 4: Abschluss

- [x] Architekturstatus und Ergebnisse aktualisieren.
- [x] Logische Aenderungen in beiden Repositories separat committen.
- [x] Commits, Testnachweise und verbleibende Betriebsanforderungen dokumentieren.

## Abnahmekriterien

- Die reale Control-Plane-Route und ihr Auth-Pfad sind durch Tests abgedeckt;
  reine Notebook-Mocks gelten nicht als Integrationsnachweis.
- Bei deaktiviertem Worker, fehlendem Agenten oder nicht freigegebenem Release
  wird kein scheinbar ausfuehrbarer Updateauftrag angenommen.
- Eine Instanz kann weder fremde Operationen lesen noch fremde VMs aktualisieren.
- Start und Releasepruefung verhindern einen unbemerkten Zielwechsel.
- Status ist nach Verlust der App-Verbindung rekonstruierbar; keine Endlosschleife
  fuer abgelaufene Anmeldung oder geloeschte Operationen.
- Erfolg wird nur aus der zentralen Verifikation abgeleitet.
- Keine Secrets in Browser-Payloads, Logs, Tests oder Dokumentation.

## Durchfuehrungsprotokoll

### Implementierung und Commits

Beide Repositories verwenden den Branch `fix/managed-settings-updates`.
Es wurde nichts gepusht oder ausgerollt.

| Repository | Commit | Ergebnis |
| --- | --- | --- |
| Notebook | `f8b994167` | Plan vor Beginn der Implementierung dokumentiert |
| Notebook | `df72a32b2` | Rollback prueft nach Healthcheck die tatsaechlich laufende Image-ID |
| Notebook | `51fa23cb8` | Optionaler, validierter Image-Nachweis im CLI-Ereignisvertrag |
| Notebook | `c3edc173a` | Managed-API, sichere Backend-Auswahl, Status-Ticket-Recovery und Integrationstest |
| Control Plane | `0c8f7fb` | Strukturierter CLI-Stream, Faehigkeitspruefung, kompatibler Legacy-Pfad |
| Control Plane | `4d33623` | Instanz-API, Migration, zentrale Orchestrierung, Status-Tickets und persistentes Journal |

Zusaetzliche Befunde bei der Zusammenfuehrung wurden behoben:

- Erfolgreiche Healthchecks allein belegen keinen erfolgreichen Rollback. Die CLI
  vergleicht jetzt auch das wiederhergestellte Image; Agent und Control Plane
  transportieren bzw. pruefen den expliziten Nachweis. Historische CLI-Ereignisse
  ohne Nachweis werden nicht nachtraeglich als verifizierter Rollback ausgegeben.
- Gleichzeitige Journal-Schreibvorgaenge koennen ohne Serialisierung spaeter
  sichtbare Ereignisse vor einen bereits ausgelieferten Cursor einschieben.
  Eine transaktionale Sperre pro Run-Item serialisiert Vergabe und Speicherung.
- Eine Backup-Pflicht aus Release-Metadaten wird bis zur Host-CLI weitergegeben;
  eine CLI ohne erforderliche Faehigkeit startet dieses Update nicht.

### Ausgefuehrte Pruefungen

Alle folgenden Pruefungen waren erfolgreich:

| Bereich | Befehl / Nachweis |
| --- | --- |
| Notebook Produktionsbuild | `npm run build` |
| Settings, Backend, Recovery | `npm run test:system-updates` (fuenf Testscripte; UI-Komponententest mit DOM-Simulation) |
| CLI-Vertrag | `npx tsx scripts/system-update-contract-test.ts` und `npx tsx scripts/system-update-reporter-test.ts` |
| CLI-Updater | `npm run test:cli:updater` und `npx tsx scripts/cross-platform-cli-test.ts` |
| Control Plane alle Workspaces | `npm run typecheck` |
| API/Auth/Ticket/Rollback | `npx tsx --test apps/api/tests/managedSystemUpdates.test.ts apps/api/tests/managedSystemUpdateRollback.test.ts` (6 Tests) |
| Orchestrierung mit PostgreSQL | `npx tsx --test apps/api/tests/updateOrchestration.test.ts` (42 Tests, darunter konkurrierende Journal-Schreiber und idempotente Scope-Migration) |
| Host-Agent | `npx tsx scripts/host-cli-events-test.ts` und `npx tsx scripts/host-cli-update-execution-test.ts` (8 Ausfuehrungsszenarien plus Parser-/UTF-8-Pruefungen) |
| Repository-Grenze | `CANVAS_CONTROL_PLANE_SOURCE=/absoluter/pfad/zum/control-plane npx tsx --conditions react-server scripts/system-update-control-plane-integration-test.ts` im Notebook-Repository |
| Quellcode | ESLint fuer geaenderte Notebook-Module und Tests, `git diff --check`, GitNexus `detect_changes` vor den Commits |

Der Integrationstest verwendet die tatsaechlichen Fastify-Routen, Auth-Hooks,
CORS-Konfiguration, CP-Projektionen und das Notebook-Managed-Backend. Persistenz
und Start-Orchestrierung sind dort Test-Fixtures. Der API-Test prueft zusaetzlich
die echte Managed-Token-Validierung mit bcrypt und Scopes. Die PostgreSQL-Suite
prueft die reale Datenbankimplementierung einschliesslich Migration.

Fuer die PostgreSQL-Suite wurde im bereits laufenden lokalen PostgreSQL-Container
eine leere temporaere Datenbank mit kopiertem Schema angelegt; keine Nutzerdaten
wurden kopiert. `DATABASE_URL` zeigte ausschliesslich auf diese Testdatenbank und
`MANAGED_SECRETS_MASTER_KEY` war ein fluechtiger Zufallswert fuer den Testprozess.
Die temporaere Datenbank wurde nach Abschluss geloescht. Fuer Wiederholungen ist
erneut eine wegwerfbare Datenbank erforderlich: Die Suite leert Tabellen.

Der erste Notebook-Build scheiterte an der extern verlinkten `node_modules`-
Struktur des Worktrees; lokale Dependencies behoben das. Der anschliessende
Typecheck fand fehlendes `NODE_ENV` in neuen Test-Fixtures; diese sind korrigiert.
Der finale Build bestand. Bestehende Turbopack-Warnungen zu dynamischem
Filesystem-Tracing bleiben bestehen.

### Rollout-Reihenfolge und Konfiguration

1. Control-Plane-Migration `0098_managed_system_update_scopes.sql` mit dem normalen
   Migrationsverfahren anwenden. Nur aktive, nicht abgelaufene provisionierte
   Tokens mit allen drei Managed-License-Scopes erhalten die zwei neuen Scopes.
   Eingeschraenkte Tokens muessen gezielt neu berechtigt oder provisioniert werden.
2. Control-Plane-API aus diesem Branch ausrollen und den bestehenden Update-Worker
   starten. Die API prueft den tatsaechlich initialisierten Worker, nicht nur eine
   Environment-Variable. Stable-Releases muessen die bestehenden Artefakt-, Digest-
   und Provenienzpruefungen erfuellen. Beta ist ausdruecklich noch nicht verfuegbar.
3. Host-Agent aus diesem Branch im normalen Agent-Releaseverfahren bereitstellen.
   Der Host-Agent handelt CLI-Faehigkeiten aus; vollstaendig alte CLIs behalten den
   Legacy-Pfad. Unvollstaendige Faehigkeiten oder fehlende Pflicht-Backup-Unterstuetzung
   werden abgelehnt. Neue Agent-/CLI-Artefakte und Versionsmetadaten sind erst im
   separaten Releaseprozess zu veroeffentlichen.
4. Notebook und CLI aus diesem Branch bereitstellen. Notebook benoetigt den
   richtigen `CANVAS_CONTROL_PLANE_URL` und `CANVAS_INSTANCE_TOKEN`; der Token
   bleibt serverseitig. Expliziter Managed-Modus ohne Credentials bleibt gesperrt.
5. Fuer direkten Browserstatus muss die Notebook-Origin in `vm_config.domain`
   oder exakt in `MANAGED_UPDATE_STATUS_ORIGINS` stehen. Tickets gelten 30 Minuten,
   fuer eine VM und Operation und ausschliesslich zum Lesen. CORS erlaubt keine
   beliebigen Origins und keine Cookies. Der bestehende Managed-Master-/Auth-Key
   dient zur Signierung; es entsteht kein zusaetzliches Browsergeheimnis.
6. Ausschliesslich fuer lokale Tests kann `CANVAS_UPDATE_ALLOW_LOCAL_HTTP=true`
   auf den beteiligten Diensten gesetzt werden. Erlaubt sind die expliziten lokalen
   Hosts, darunter `host.orb.internal`; produktive Verbindungen bleiben HTTPS.
   Ein Browser muss den konfigurierten CP-Host selbst erreichen koennen.

### Abgeschlossene lokale Laufzeitabnahme

Mit der ausdruecklichen Folgeanweisung „Dann mach die abnahme“ wurden die
Container-/VM-/Browserpruefungen beauftragt und am 2026-09-22 durchgefuehrt.
Der verwaltete Stack wurde nach erfolgreichen Host-Builds aus den Branches neu
gebaut. Fuer den Agent-/CLI-Lauf blieb ausschliesslich die OrbStack-VM als
Notebook-Testinstanz aktiv; der Notebook-Dienst im lokalen Compose-Stack wurde
gestoppt.

Die Abnahme fand und korrigierte zusaetzlich die fehlende CP-Origin in der CSP
(`646bcb18a`) sowie die fehlende Digest-Persistenz und ueberschriebene explizite
Vector-Policy der CLI (`6049e7d6c`). Eine inkonsistente lokale Domain-Fixture wurde
ueber die CP-API angeglichen.

Echter UI-Start, konkurrierender Start, Offline-Zustaende, direkter Status bei
App-Ausfall, Reload, abgelaufene Sitzung, Ticket-Ablauf samt Erneuerung, zentral
verifizierter Erfolg und kontrollierter Rollback mit Image-Nachweis bestanden.
Das [Abnahmeprotokoll](managed-settings-update-acceptance.md) enthaelt Operationen,
Screenshots, Journale, unabhaengige DB-/Host-Verifikation und finalen Testzustand.

Ausdrueckliche Grenzen: lokale gleiche-Version-Rebuilds statt neuer Schema-
Migration; CLI passend vorinstalliert statt extern heruntergeladen; produktive
DNS/TLS und der separate Standalone-Pfad wurden hier nicht abgenommen. Als kleine
UX-Nacharbeit bleibt eine genauere grobe Fortschrittsphase waehrend des
Host-Healthchecks; technische Details und Abschlusssemantik sind korrekt.
