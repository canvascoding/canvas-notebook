# Database Provider, Postgres, RAG und Collaboration Policy

Stand: 2026-07-13

## Zweck

Dieses Dokument legt fest, wann Canvas Notebook weiter mit SQLite laufen darf und wann Postgres zwingend wird. Es verbindet Datenbankwahl, Installer, Control Plane Provisioning, Knowledge/RAG, pgvector, Collaboration, Export/Import und Backup.

Es ergaenzt die Aufgaben `6`, `8`, `9`, `25`, `34`, `36`, `38`, `39`, `40`, `41`, `42` und `43` im Aufgabenindex.

Das Control-Plane-Repository liegt eine Ebene ueber diesem Repository und heisst `../canvas-control-plane`. Alle VM-Provisioning- und Managed-Installer-Aenderungen muessen dort umgesetzt werden; die Notebook-App und das Canvas Notebook CLI werden in diesem Repository angepasst.

## Grundentscheidung

SQLite bleibt fuer einfache lokale und Single-User-Installationen erlaubt. Sobald Team-/Advanced-Features produktiv genutzt werden, ist Postgres Pflicht.

Pflicht fuer Postgres:

- `CANVAS_DEPLOYMENT_MODE=managed-team`
- Team Workspace als produktiver geteilter Workspace
- Team/Organization Knowledge Base
- Embeddings, RAG oder Knowledge Graph in produktiver Nutzung
- echte oder vorbereitete Realtime-Collaboration/CRDT-Synchronisation
- Managed/Enterprise-Backups mit Datenbank-Dump
- groessere Multi-User-Instanzen mit parallelen Writes und Background Jobs

SQLite darf nur diese Produktlinie tragen:

- Community/Free
- lokale Entwicklung
- einfache Single-User-Installation
- optional `managed-single`, solange Team-, RAG- und Collaboration-Features gesperrt bleiben

SQLite kann technisch Tabellen fuer Chunks, Graph-Kanten oder einfache Full-Text-Suche speichern. Das ist aber nicht der produktive Zielpfad fuer Team-RAG. Fuer Canvas Notebook gilt: produktive Team Knowledge, Embeddings, RAG und Knowledge Graph brauchen Postgres mit pgvector.

## Entkopplungsplan: Runtime, Provider und Capabilities

Der aktuelle Implementierungsstand koppelt Team-Modus, Postgres und pgvector noch stark:

```txt
runtimeMode=team -> CANVAS_DATABASE_PROVIDER=postgres -> CANVAS_TEAM_FEATURES_ENABLED=true -> Team/Postgres-Lizenz erforderlich
```

Diese Kopplung bleibt kurzfristig als Produktregel bestehen. Sie darf aber nicht dauerhaft als implizite Architekturannahme in UI, Env-Generierung, Lizenzpruefung, Healthchecks und Migrationen verstreut bleiben. Fachlich sind drei Konzepte zu trennen:

1. Runtime Mode: `personal` oder `team`.
2. Database Provider: `sqlite` oder `postgres`.
3. Vector Provider: `none`, `pgvector` oder spaeter `external`.

Zielmodell:

```txt
runtimeMode: personal | team
databaseProvider: sqlite | postgres
vectorProvider: none | pgvector | external
capabilities:
  multiUser: boolean
  teamWorkspace: boolean
  vectorSearch: boolean
  liveCollaboration: boolean
```

Wichtig: Diese Entkopplung erlaubt noch nicht automatisch neue Produktkombinationen. Fuer V1 bleibt `team` offiziell nur mit Postgres erlaubt. Der Unterschied ist, dass der Code nicht mehr "Team ist Postgres" annimmt, sondern "Team fordert Capabilities an, und die aktuelle Compatibility-Regel verlangt dafuer Postgres".

### Zielkombinationen

| Runtime | Database | Vector | Status fuer V1 | Bedeutung |
|---|---|---|---|---|
| `personal` | `sqlite` | `none` | erlaubt | Standard fuer lokale und einfache Single-User-Installationen |
| `personal` | `postgres` | `none` oder `pgvector` | optional/vorbereitet | Power-User, Migrationstests oder spaetere Self-hosted-Varianten |
| `team` | `postgres` | `none` | erlaubt mit Team-Lizenz, aber ohne produktive Vector Search | Team Workspace, Rollen, Multi-User, Revisionen und Locks |
| `team` | `postgres` | `pgvector` | voller Zielpfad | Team Workspace plus Knowledge/RAG/Embeddings |
| `team` | `sqlite` | `none` | fuer V1 blockiert | moeglicher spaeterer `Team Lite`- oder Entwicklungsmodus, nicht offizieller Produktpfad |
| `team` | `sqlite` | `pgvector` | ungueltig | pgvector ist ein Postgres-Provider |

### Umsetzungsschritte

1. Zentrales Runtime-Profil einfuehren.
   - Notebook und Control Plane bekommen je eine zentrale Funktion, z. B. `resolveNotebookRuntimeProfile(...)`.
   - Das Profil liefert `runtimeMode`, `databaseProvider`, `vectorProvider`, `deploymentMode`, `features`, `capabilities` und Compatibility-Fehler.
   - Alle Env-, Lizenz-, UI- und Health-Flows lesen aus diesem Profil statt eigene `team -> postgres`-Ableitungen zu bauen.

2. Control Plane Env-Generierung entkoppeln.
   - VM-Erstellung und Runtime-Switch duerfen nicht verstreut `runtimeMode=team` in Postgres-Env umwandeln.
   - Stattdessen erzeugt das Runtime-Profil die konkrete Env:
     - `CANVAS_DEPLOYMENT_MODE`
     - `CANVAS_DATABASE_PROVIDER`
     - `CANVAS_TEAM_FEATURES_ENABLED`
     - `CANVAS_POSTGRES_VECTOR_ENABLED`
     - `DATABASE_URL`
   - `applyManagedEnvToVmConfig()` und `ensureManagedEnvForVmConfig()` schreiben nur noch das validierte Profil.

3. Lizenzclaims capability-basiert machen.
   - Managed-Lizenzen sollen nicht nur `runtimeMode=team` ausdruecken.
   - Relevante Claims:
     - `features.teamWorkspace`
     - `features.multiUser`
     - `features.vectorSearch`
     - `databaseProvider`
     - `vectorProvider`
     - `postgresRequired`
   - Team-Lizenzen duerfen fuer V1 weiterhin `databaseProvider=postgres` und `postgresRequired=true` ausstellen.

4. Notebook-Gates trennen.
   - Bestehende Checks wie `requireTeamRuntimeLicense()` werden perspektivisch in kleinere Guards aufgeteilt:
     - `requireRuntimeCapability("teamWorkspace")`
     - `requireRuntimeCapability("multiUser")`
     - `requireDatabaseProvider("postgres")`
     - `requireVectorProvider("pgvector")`
   - V1 darf intern weiter sagen: `teamWorkspace` verlangt Postgres.
   - Fehlermeldungen muessen aber unterscheiden:
     - Lizenz erlaubt Capability nicht.
     - Runtime ist nicht kompatibel.
     - Datenbankprovider fehlt.
     - pgvector fehlt.

5. Compatibility-Regeln zentralisieren.
   - Eine Funktion wie `validateRuntimeCompatibility(profile)` entscheidet, welche Kombinationen erlaubt sind.
   - Aktuelle V1-Regeln:
     - `teamWorkspace=true` braucht `databaseProvider=postgres`.
     - `multiUser=true` braucht `databaseProvider=postgres`.
     - `vectorSearch=true` braucht `databaseProvider=postgres` und `vectorProvider=pgvector`.
     - `liveCollaboration=true` braucht fuer produktive Team-Nutzung Postgres.
   - Spaetere Aenderungen wie `team + sqlite` als experimenteller Team-Lite-Modus duerfen nur hier freigeschaltet werden.

6. UI-Sprache korrigieren.
   - UI soll nicht mehr implizieren: "Team ist Postgres".
   - Besser:
     - Runtime Mode: Personal oder Team.
     - Database Provider: SQLite oder Postgres.
     - Vector Provider: None, pgvector oder spaeter external.
   - Solange Self-hosted Team noch nicht verfuegbar ist, zeigt die Control Plane: Team Mode ist aktuell nur fuer canvasnotebook.app verfuegbar; Self-hosted folgt.
   - Sobald Self-hosted Team freigegeben wird, zeigt die UI: Team Mode benoetigt aktuell Postgres.

7. Migration provider- und capability-aware machen.
   - Migrationsmanifest erhaelt getrennte Felder:

```json
{
  "runtimeMode": "team",
  "databaseProvider": "postgres",
  "vectorProvider": "pgvector",
  "capabilities": ["teamWorkspace", "multiUser", "vectorSearch"]
}
```

   - SQLite-zu-Postgres ist eine Datenbankmigration.
   - Vector-Reindex ist ein separater Schritt.
   - Team-Aktivierung ist ein Runtime-/Capability-Schritt nach bestandener Migration.

8. Testmatrix absichern.
   - `personal + sqlite`: erlaubt.
   - `personal + postgres`: explizit erlaubt oder explizit blockiert, nicht implizit.
   - `team + postgres`: mit Team-Lizenz erlaubt.
   - `team + sqlite`: fuer V1 blockiert mit klarem `team_requires_postgres`.
   - `team + postgres + vectorProvider=none`: Team erlaubt, Vector Search blockiert.
   - `vectorSearch + sqlite`: blockiert mit `requires_postgres` oder `requires_external_vector_provider`.

### Nicht-Ziele fuer diesen Refactor

- Kein sofortiges Freischalten von `team + sqlite` fuer Self-hosted.
- Kein Einbau echter Yjs-/CRDT-Live-Collaboration als Teil dieses Entkopplungsschritts.
- Kein Wechsel weg von pgvector als bevorzugtem V1-Vektorpfad.
- Keine Migration ohne Maintenance Mode, Snapshot und expliziten Admin-Start.

Der Refactor ist erfolgreich, wenn das Produktverhalten gleich bleibt, aber die Architektur klar unterscheidet: Runtime Mode fordert Capabilities an; Provider und Vector Store liefern technische Voraussetzungen; Compatibility-Regeln entscheiden, welche Kombinationen aktuell erlaubt sind.

## Database Provider Modes

Canvas Notebook bekommt einen expliziten Database Provider.

Empfohlene ENV:

```env
CANVAS_MANAGED_SERVICES_ENABLED=false
CANVAS_DEPLOYMENT_MODE=community
CANVAS_DATABASE_PROVIDER=sqlite
```

oder:

```env
CANVAS_MANAGED_SERVICES_ENABLED=true
CANVAS_DEPLOYMENT_MODE=managed-team
CANVAS_ORGANIZATION_ID=<organizationId>
CANVAS_DATABASE_PROVIDER=postgres
DATABASE_URL=postgresql://canvas:<password>@postgres:5432/canvas_notebook
CANVAS_POSTGRES_VECTOR_ENABLED=true
CANVAS_POSTGRES_IMAGE=<pinned-postgres-pgvector-image>
CANVAS_POSTGRES_DATA_VOLUME=canvas-postgres-data
```

Regeln:

- `CANVAS_MANAGED_SERVICES_ENABLED=true|false` bleibt als bestehender Managed-Services-Schalter erhalten.
- `CANVAS_DATABASE_PROVIDER` ist die lokale technische Auswahl.
- `CANVAS_DEPLOYMENT_MODE` und `CANVAS_LICENSE_CERT` entscheiden, ob diese Auswahl erlaubt ist.
- Wenn Lizenz/Deployment Team-Features verlangen und `CANVAS_DATABASE_PROVIDER=sqlite` gesetzt ist, startet die App nicht im Team-Modus. Sie muss Setup/Health mit klarer Fehlermeldung blockieren.
- `DATABASE_URL` darf nur fuer Postgres verwendet werden. SQLite bleibt unter `/data/sqlite.db`.
- DB-Passwoerter werden durch Installer/Control Plane in Secret-Dateien oder geschuetzte Env-Dateien geschrieben, nicht hart im Code.
- Der Runtime Env Allowlist/Secret Resolver muss Datenbank-Secrets vor Agent-Tools verbergen.

## Installer und Control Plane

Es gibt zwei Installationsorte, die synchron gehalten werden muessen.

Canvas Notebook CLI:

- fragt bei Self-hosted/CLI-Install nach `SQLite` oder `Postgres`,
- erklaert, dass SQLite keine produktive Team Knowledge, RAG oder Collaboration unterstuetzt,
- erzwingt Postgres, wenn Team/Advanced Features ausgewaehlt werden,
- erzeugt bei Postgres eine Compose-Konfiguration mit App-Container und Postgres-Container,
- erzeugt sichere Datenbank-Secrets,
- gleicht bei bestehenden Postgres-Volumes das echte Rollenpasswort mit der gespeicherten Runtime-Env ab, bevor die App gestartet oder neu gestartet wird,
- fuehrt Datenbank-Migrationen fuer den gewaehlten Provider aus,
- prueft Health inklusive Provider, Schema-Version und pgvector-Status.

Control Plane Provisioning in `../canvas-control-plane`:

- setzt `CANVAS_DEPLOYMENT_MODE`, `CANVAS_ORGANIZATION_ID`, `CANVAS_DATABASE_PROVIDER` und die DB-Secrets beim VM-Install,
- erzeugt bei Teamplaenen automatisch einen Postgres-Service in der Docker-Compose-Datei,
- laesst den Postgres-Container auf derselben VM wie Canvas Notebook laufen, aber getrennt vom App-Container,
- legt ein eigenes Docker Volume fuer Postgres an,
- installiert/aktiviert pgvector fuer die Datenbank,
- gibt dieselbe Provider-Auswahl auch bei Agent-Config-Sync und Updates weiter,
- verhindert Team-Provisioning ohne Postgres, ausser ein expliziter Maintenance-/Migration-Flow laeuft,
- sammelt DB-Health, Disk-/WAL-Wachstum, Backup-Status und Migrationsstatus fuer das Control-Plane-Dashboard.

Die Compose-Datei darf kein ungebundenes `latest`-Tag fuer produktive Postgres-Images verwenden. Sie soll eine aktuell unterstuetzte, gepinnte Major-/Minor-Linie verwenden und Upgrades bewusst ueber den Update-Flow fahren.

## Vorgelagerter Provider-Setup-Plan vor Full Backup

Full Backup darf erst als Produktfeature sichtbar werden, wenn die Datenbankauswahl und Postgres-Provisionierung in allen Installationswegen explizit, wiederholbar und health-geprueft sind. Sonst entsteht ein Backup-Feature, das bei zukuenftigen Team-/Postgres-Setups genau im wichtigsten Disaster-Recovery-Fall fehlschlaegt.

Ziel fuer V1:

1. Provider-Auswahl ist ein offizieller Setup-Schritt, kein verstecktes `config-set`.
2. `sqlite` bleibt der Default fuer einfache Single-User-Installationen.
3. `postgres` kann bei Single-User bewusst gewaehlt werden und ist fuer Team/Advanced verpflichtend.
4. Eine bestehende SQLite-Instanz wird nicht allein durch Provider-Auswahl migriert. Sie braucht den gefuehrten SQLite-zu-Postgres-Migrationsflow.
5. Full Backup nutzt immer den tatsaechlichen Provider: SQLite-Snapshot bei SQLite, Postgres-Dump oder gleichwertiger Snapshot bei Postgres.

### Notebook CLI und Installer

Legacy/Linux-Installer:

- Der klassische `install.sh` fragt bereits interaktiv nach Deployment Scope und Datenbankprovider.
- Dieser Pfad bleibt der Referenzablauf fuer Linux-VMs.
- Die Bash-CLI muss weiterhin `CANVAS_DATABASE_PROVIDER`, `COMPOSE_PROFILES=postgres`, Postgres-Secret-Generierung und Healthchecks synchron halten.

Portable TypeScript-CLI:

- Die portable CLI braucht erstklassige Optionen fuer denselben Ablauf, z. B.:

```txt
canvas-notebook install --database sqlite|postgres --runtime personal|team
canvas-notebook database status [--json]
canvas-notebook database prepare-postgres
canvas-notebook database migrate-sqlite-to-postgres [options]
```

- `--runtime team` muss `--database postgres` erzwingen oder mit klarem Fehler abbrechen.
- `--database postgres` muss Compose-Profil, `DATABASE_URL`, Postgres-DB/User/Passwort, pgvector-Schalter und persistente Volumes materialisieren.
- `config-set env.CANVAS_DATABASE_PROVIDER postgres` bleibt als Low-Level-Admin-Werkzeug erlaubt, ist aber nicht der empfohlene Setup-Pfad.
- `config-show --json` und Statusausgaben duerfen `DATABASE_URL` und `CANVAS_POSTGRES_PASSWORD` nie unmaskiert ausgeben.

Nicht-interaktive Installationen:

- `CANVAS_DEPLOYMENT_MODE`, `CANVAS_DATABASE_PROVIDER`, `DATABASE_URL`, `CANVAS_POSTGRES_*` und Team-/Capability-Flags muessen weiter ueber Env gesetzt werden koennen.
- Wenn Team-/Advanced-Faehigkeiten gesetzt sind und `CANVAS_DATABASE_PROVIDER=sqlite` bleibt, muss der Setup-Flow abbrechen oder serverseitig auf Postgres normalisieren. Stilles Starten in einem inkompatiblen Zustand ist nicht erlaubt.

### Compose- und Secret-Vertrag

- Die Compose-Datei enthaelt den Postgres-Service weiterhin optional ueber das Profil `postgres`.
- `COMPOSE_PROFILES=postgres` ist die technische Aktivierung fuer lokale Postgres-Provisionierung.
- Der App-Container erhaelt `CANVAS_DATABASE_PROVIDER=postgres` und `DATABASE_URL` ueber die geschuetzte Container-Env-Datei.
- Postgres-Container-Parameter kommen aus Compose-Env, muessen aber ebenfalls als sensitive Host-Dateien behandelt werden.
- Das Postgres-Datenvolume muss stabil benannt und in der Konfiguration persistiert werden.
- `CANVAS_POSTGRES_IMAGE` wird gepinnt und nicht implizit auf ein unkontrolliertes `latest` aktualisiert.

### `prepare-postgres`

`prepare-postgres` ist ein idempotenter Infrastruktur-Schritt vor Migration und Full Backup:

1. Config validieren und fehlende Postgres-Secrets erzeugen.
2. Compose-Datei und Env-Dateien synchronisieren.
3. Postgres-Profil starten.
4. DB-User/Passwort mit der gespeicherten Config abgleichen.
5. pgvector Extension anlegen oder bestaetigen.
6. Healthstatus fuer Postgres, pgvector und App-Provider melden.

Der Schritt darf keine SQLite-Daten kopieren. Er bereitet nur Infrastruktur vor.

### Control-Plane-Hotfix als Referenz fuer die dauerhafte CLI-Loesung

Im Control-Plane-Repo existiert am 2026-07-08 bereits ein defensiver Agent-/Control-Plane-Hotfix, der als Ablaufreferenz dient:

- `../canvas-control-plane/apps/api/src/services/managedSecrets.ts` generiert und erhaelt Managed-Postgres-Env-Werte. Ein vorhandenes `CANVAS_POSTGRES_PASSWORD` wird wiederverwendet, statt bei jedem Update neu erzeugt zu werden.
- `../canvas-control-plane/packages/agent/src/ws-client.ts` entscheidet mit `postgresRuntimeDesired()`, ob Postgres vorbereitet werden muss.
- `../canvas-control-plane/packages/agent/src/ws-client.ts` enthaelt mit `syncPostgresPassword()` den Kern-Fix fuer bestehende Docker-Volumes: Das gespeicherte Runtime-Passwort wird per SQL auf die echte Postgres-Rolle angewendet.
- `../canvas-control-plane/packages/agent/src/ws-client.ts` zeigt mit `preparePostgresService()` die richtige Reihenfolge: Runtime-Env sicherstellen, Postgres-Profil starten, Rollenpasswort synchronisieren, Env syncen, Rollenpasswort erneut synchronisieren, pgvector Extension sicherstellen.

Diese Logik bleibt nicht dauerhaft primaer in der Control Plane. Die stabile Loesung gehoert in die Canvas-Notebook-CLI, weil dort `install`, `update`, `start`, `restart`, `env --sync`, `database prepare-postgres` und `database migrate-sqlite-to-postgres` orchestriert werden.

Ziel-Invariant fuer Managed Postgres:

- `canvas-notebook-config.json`,
- `/opt/canvas-notebook/.env`,
- `/opt/canvas-notebook/canvas-notebook.env`,
- App-Container-Env,
- Postgres-Container-Env,
- und das echte Passwort der Postgres-Rolle

muessen dieselben unmaskierten Werte fuer `CANVAS_POSTGRES_DB`, `CANVAS_POSTGRES_USER`, `CANVAS_POSTGRES_PASSWORD`, `CANVAS_POSTGRES_DATA_VOLUME` und `DATABASE_URL` verwenden.

Die CLI braucht dafuer einen gemeinsamen Postgres-Prepare-Service in beiden CLI-Linien:

- Legacy Bash: z. B. `install/lib/shared/postgres.sh`.
- Portable TypeScript: z. B. `cli/src/core/postgres.ts` oder ein passend vorhandener Core-Service.

Faehigkeiten dieses Services:

- `postgres_runtime_desired`
- `postgres_load_runtime_env_unredacted`
- `postgres_start_profile`
- `postgres_wait_ready`
- `postgres_sync_role_password`
- `postgres_verify_runtime_password`
- `postgres_ensure_pgvector`
- `postgres_prepare_managed_runtime`

Wichtig: Die dauerhafte Notebook-CLI darf fuer diesen Pfad nicht `config-show --json` als Secret-Quelle verwenden, weil diese Ausgabe fuer Menschen und Control-Plane-UI redacted bleiben muss. Der Service liest intern direkt die lokale Config-Datei oder die generierten geschuetzten Env-Dateien. Wenn ein Wert maskiert aussieht, leer ist oder offensichtlich nicht das echte Secret sein kann, bricht der Prepare-Schritt ab, statt dieses Pseudo-Secret auf die Datenbankrolle zu schreiben.

`postgres_prepare_managed_runtime` laeuft in dieser Reihenfolge:

1. Config normalisieren und Postgres-Secrets erzeugen oder bestehende wiederverwenden.
2. `.env` und `canvas-notebook.env` materialisieren.
3. Nur den Postgres-Service starten: `docker compose --profile postgres up -d postgres`.
4. Auf Postgres-Bereitschaft warten.
5. Unmaskiertes Runtime-Passwort laden.
6. Rollenpasswort per SQL-stdin synchronisieren, nicht ueber Shell-Interpolation oder argv.
7. TCP-Login mit exakt diesem Passwort validieren.
8. `CREATE EXTENSION IF NOT EXISTS vector` ausfuehren, wenn pgvector aktiv ist.
9. Erst danach App-Container starten, recreaten oder Health-Wait ausfuehren.

Integration:

- `install`: nach Config-/Env-Erzeugung, vor App-Start.
- `update`: nach Pull/Config-/Env-Erzeugung, vor App-Recreate/Health-Wait.
- `start`: vor App-Start, wenn Postgres gewuenscht oder erforderlich ist.
- `restart`: vor App-Recreate, wenn Postgres gewuenscht oder erforderlich ist.
- `env --sync`: Env-Dateien und Postgres-Auth synchronisieren, bevor eine App mit moeglich falscher DB-Auth neu startet.
- `database prepare-postgres`: denselben Service explizit und idempotent ausfuehren.
- `database migrate-sqlite-to-postgres`: die vorhandene Prepare-Phase auf denselben Service umstellen.

Sicherheitsregeln:

- Passwort nie in Logs, Command-Display, argv oder Fehlerausgaben schreiben.
- `DATABASE_URL` immer redacted anzeigen.
- Kein `set -x` in diesem Pfad.
- SQL nur ueber stdin an `psql`.
- Bei maskierten oder verdachtig kurzen Secrets abbrechen.
- `config-show --json` bleibt redacted; interne Prepare-Logik nutzt eigene unredacted Loader.

### Backup-Voraussetzung

Vor der Full-Backup-Integration muss der Postgres-Dump-Weg geklaert sein:

- Der bestehende Backup-Service erzeugt Postgres-Backups ueber `pg_dump`.
- V1 stellt einen passenden Postgres-Client im App-Container bereit oder fuehrt den Dump kontrolliert im Postgres-Container aus.
- Der bevorzugte V1-Pfad ist ein kompatibler Postgres-Client im App-Container, weil API, UI und CLI dann denselben Backup-Service nutzen koennen.
- Die Notebook-CLI bleibt Orchestrator und dupliziert die Backup-Engine nicht. Sie ruft einen Container-internen Backup-Command bzw. Scriptpfad auf, der die vorhandene Notebook-Backup-Logik in einem separaten Prozess ausfuehrt.
- Der CLI-Backup-Pfad ruft nicht die laufende Web-App per HTTP auf und braucht keinen App-Stopp. Die App darf waehrend `backup create` weiterlaufen.
- Full Backup ist ein Daten-Backup: enthalten sind Datenbank und Canvas-Notebook-Nutzerdaten unter `/data`; nicht enthalten sind VM, OS, Docker Images, App-Binaries, Source Code, Systemd-/Caddy-/Compose-/Host-Konfiguration und CLI-Installation.
- Der Backup-Zielpfad ist konfigurierbar. Default ist der Canvas-Backup-Pfad unter `/data/system/backups` bzw. der zugehoerige lokale VM-Pfad.
- V1 verwaltet ein stabiles Latest-Backup. Das alte Latest-Backup wird erst nach erfolgreicher Erstellung, Manifest-/Checksum-Pruefung und atomarer Promotion des neuen Backups ersetzt.
- Wenn `pg_dump` fehlt oder nicht kompatibel ist, muss Backup mit einem klaren Preflight-Fehler abbrechen, bevor ein teilweises Archiv entsteht.
- Vor einem Postgres-Backup muss der Provider-Prepare-Service bestaetigen, dass das App-Runtime-Passwort und das echte Postgres-Rollenpasswort zusammenpassen. Sonst kann ein Backup direkt nach `update`, `restart` oder `env --sync` genau im Managed-Team-Fall scheitern.

### Umsetzungsreihenfolge

1. Gemeinsamen Postgres-Prepare-Service inklusive Rollenpasswort-Reconciliation fuer portable TS-CLI und Legacy Bash-CLI bauen.
2. `install`, `update`, `start`, `restart`, `env --sync`, `database prepare-postgres` und `database migrate-sqlite-to-postgres` auf diesen Service umstellen.
3. Portable CLI um offiziellen Provider-/Runtime-Setup-Pfad erweitern und Legacy CLI/Installer-Texte, Help und Tests auf dieselbe Sprache bringen.
4. `database status` und `database prepare-postgres` in beiden CLIs harmonisieren.
5. Postgres-Dump-Voraussetzung im App-Image oder Backup-Service loesen.
6. Erst danach Full Backup in App, CLI und Control Plane freischalten.

## Control Plane Status Quo

Lesender Abgleich mit `../canvas-control-plane` am 2026-07-08:

- `apps/api/src/services/managedSecrets.ts` enthaelt inzwischen die Managed Runtime-, Database-, Vector- und Postgres-Env-Keys inklusive `DATABASE_URL`, `CANVAS_DATABASE_PROVIDER`, `CANVAS_POSTGRES_VECTOR_ENABLED`, `CANVAS_POSTGRES_IMAGE`, `CANVAS_POSTGRES_DATA_VOLUME`, `CANVAS_POSTGRES_DB`, `CANVAS_POSTGRES_USER` und `CANVAS_POSTGRES_PASSWORD`.
- `apps/api/src/services/notebookRuntime.ts` enthaelt ein zentrales Managed Runtime Profile fuer Runtime Mode, Database Provider, Vector Provider und Capabilities.
- `apps/api/src/routes/databaseMigration.ts` stellt `/vms/:id/database/status`, `/runs`, `/prepare-postgres` und `/migrate-sqlite-to-postgres` bereit.
- `apps/api/src/services/databaseMigration.ts` speichert Database-Runs, Status, Phasen, Progress und Agent-Acknowledgements.
- `packages/agent/src/ws-client.ts` verarbeitet `database:run` mit `status`, `prepare_postgres` und `migrate_sqlite_to_postgres`.
- `packages/agent/src/metrics/docker.ts` sammelt bereits Postgres-Companion-Metriken, wenn der Provider oder pgvector aktiv ist.
- `apps/web/src/app/dashboard/vms/[id]/page.tsx` und `apps/web/src/components/vm/database-migration-tab.tsx` haben einen Database-/Migration-Bereich fuer Providerstatus und Migration-Runs.

Offene Aenderungspunkte:

- Notebook portable CLI muss denselben Provider-Setup-Pfad wie der Legacy-Installer offiziell anbieten.
- Der Control-Plane-Hotfix fuer Postgres-Auth-Reconciliation muss in die Notebook-CLI wandern, damit Managed-Instanzen nicht dauerhaft von defensiver Agent-Logik abhaengen.
- `packages/agent/src/ws-client.ts` liest aktuell fuer Teile dieses Hotfixes ueber `canvas-notebook config-show --json --no-banner`; die Notebook-CLI muss fuer interne Prepare-Pfade stattdessen unredacted Config-/Env-Loader bereitstellen, waehrend `config-show` redacted bleibt.
- Control Plane soll fuer Backups nicht die freien VM-Actions verwenden, sondern die bestehende typed Run-Struktur erweitern.
- Database-Runs koennen um `backup_full` oder eine eigene Backup-Run-Familie erweitert werden; die Entscheidung haengt davon ab, ob Backup fachlich als Database/Maintenance-Operation oder als eigener Disaster-Recovery-Bereich modelliert wird.
- Remote-Download grosser Backup-Archive aus der Control Plane ist nicht Teil von V1, solange keine sichere Artifact-Transfer- oder Object-Storage-Strecke existiert.
- Backup-Status soll in den Database-/Maintenance-Bereich einfliessen, ohne lokale Dateipfade oder Secrets unredacted an die Web-UI zu senden.

## Control Plane API Vertrag

Es gibt drei unterschiedliche Secret-/Token-Ebenen. Sie duerfen nicht vermischt werden.

| Ebene | Aktueller Mechanismus | Zweck | Darf fuer DB-Migration/Backup genutzt werden? |
|---|---|---|---|
| VM-Agent-Control | `API_KEY` in `/etc/canvas-control-agent.env`, WebSocket `Authorization: Bearer <API_KEY>` | Control Plane steuert den Host-Agenten, Actions, Terminal, Health und Metriken | ja, fuer Host-/Docker-/Compose-Operationen ueber den verbundenen Agent |
| Managed Instance Token | `CANVAS_INSTANCE_TOKEN` im Notebook-Container, gespeichert als Hash in `vmManagedAccessTokens` mit Scopes | Notebook ruft Managed Services der Control Plane auf, z. B. Models, Media, Email, License | nein, nicht fuer Host-Level-Migration oder Backup-Orchestrierung |
| Notebook Internal API | `CANVAS_INTERNAL_API_KEY` lokal in der Notebook-Instanz | interne Scheduler-/App-Endpunkte innerhalb der Notebook-Runtime | nein, nicht fuer Control-Plane-Agent-Steuerung |

Identitaeten:

- `vmId` ist die Control-Plane-VM-/Agent-ID und entspricht im Managed Notebook `CANVAS_INSTANCE_ID`.
- `organizationId` kommt in der Control Plane aus der VM-/Billing-/Organization-Zuordnung und im Notebook aus `CANVAS_ORGANIZATION_ID` oder License Claim.
- User-/Rollenrechte werden bei Control-Plane-API-Aufrufen serverseitig ueber Session, Organization Membership und VM Access geprueft.

Neue Control-Plane-API-Kanten:

```txt
GET  /v1/vms/:id/database/status
GET  /v1/vms/:id/database/runs
POST /v1/vms/:id/database/prepare-postgres
POST /v1/vms/:id/database/migrate-sqlite-to-postgres
POST /v1/vms/:id/database/backup
POST /v1/vms/:id/database/runs/:runId/cancel
```

Autorisierung:

- `status` braucht VM-Read-Zugriff.
- `prepare-postgres` braucht Owner/Admin oder explizite VM-Manage-Rechte.
- `migrate-sqlite-to-postgres`, `backup`, `cancel` brauchen Owner/Admin.
- Teamplan-Aktivierung darf Migration/Prepare nicht ueber Client-Flags erzwingen; der Server prueft Plan, License/Feature Claims, Organization und VM-Zuordnung.

Agent-Nachrichten:

```txt
database:status:request
database:prepare-postgres
database:migrate-sqlite-to-postgres
database:backup
database:run:cancel
```

Agent-Antworten:

```txt
database:status
database:run:started
database:run:progress
database:run:completed
database:run:failed
database:run:cancelled
```

Mindest-Payload fuer Runs:

```json
{
  "runId": "<uuid>",
  "operation": "migrate_sqlite_to_postgres",
  "vmId": "<vmId>",
  "organizationId": "<organizationId>",
  "requestedByUserId": "<userId>",
  "phase": "snapshot_created",
  "progress": 35,
  "message": "SQLite snapshot created",
  "errorCode": null,
  "rollbackAvailable": true
}
```

Sicherheitsregeln:

- `DATABASE_URL`, Postgres-Passwort, `CANVAS_INSTANCE_TOKEN`, Agent `API_KEY` und interne Notebook-Keys duerfen nie an die Web-UI gesendet werden.
- UI sieht nur redacted Status, Provider, Versionen, Volumes, letzte Fehlercodes und Run IDs.
- Freie Shell-Commands sind nicht der primaere Migrationsvertrag. Migration/Backup laufen ueber typisierte Agent-Operationen mit festen Parametern.
- Jede Operation schreibt Lifecycle-/Audit-Events mit `vmId`, `organizationId`, `requestedByUserId`, Run-ID, Phase und Error Code.

## Version Pinning

Stand 2026-06-18:

- PostgreSQL 18.4 ist die aktuelle stabile Minor-Version der 18er Linie.
- PostgreSQL 19 ist Beta und nicht fuer produktive Team-Installationen vorgesehen.
- pgvector 0.8.3 ist im aktuellen Changelog als neueste Version ausgewiesen.

Installer-Regel:

- Die Control Plane fuehrt eine gepflegte Versionstabelle fuer empfohlene Postgres-/pgvector-Kombinationen.
- Neue Team-Installationen nutzen die aktuelle stabile, getestete Kombination aus dieser Tabelle.
- Produktive Compose-Dateien pinnen Image und Extension-Version.
- Upgrades laufen ueber den normalen Control-Plane-Update-Flow mit Healthcheck, Backup-Hinweis und Rollback-Strategie.

## Postgres Service

Empfohlener V1-Betrieb:

- separater Postgres-Container neben dem App-Container,
- eigenes Docker Volume fuer Postgres-Daten,
- pgvector als Extension verfuegbar,
- App verbindet ueber internes Compose-Netzwerk,
- Backups nutzen `pg_dump`/`pg_dumpall` oder ein gleichwertiges konsistentes Verfahren,
- Connection Pooling wird eingeplant, sobald Multi-User- oder Background-Job-Last steigt,
- App-DB-User bekommt keine Superuser-Rechte.

Schema-Regeln:

- Tabellen mit `organizationId`, `workspaceId`, `userId`, `sessionId` oder `sourceId` bekommen passende Indizes.
- Foreign-Key-Spalten werden explizit indexiert.
- Lange Transaktionen sind zu vermeiden; externe API-Aufrufe finden nicht in offenen DB-Transaktionen statt.
- Fuer Job-Queues, Reindex, Backup-Locks und einmalige Maintenance kann Postgres Advisory Locks nutzen.
- Vektor-Tabellen speichern niemals nur Embeddings. Jede Zeile braucht Scope- und Source-Metadaten.

## RAG, Embeddings und Knowledge Graph

Produktive RAG-Funktionen werden nur im Postgres-Mode freigeschaltet.

Feature Gates:

- `embeddingIndexingEnabled` braucht `CANVAS_DATABASE_PROVIDER=postgres`.
- `ragRetrievalEnabled` braucht Postgres und bestandenen ACL-/Source-Filter.
- `teamKnowledgeBase` braucht Postgres, sobald Chunks/Embeddings produktiv gespeichert werden.
- `knowledgeGraphEnabled` braucht Postgres.

SQLite-Mode:

- darf Knowledge-Source-Metadaten und Scan-Status fuer spaetere Migration vorbereiten,
- darf einfache lokale Textsuche oder kleine Prototypen erlauben,
- darf keine produktive Team-RAG-Freischaltung anzeigen,
- darf keine UI versprechen, die spaeter Postgres voraussetzt, ohne klaren Upgrade-Hinweis.

Postgres/pgvector-Mode:

- speichert Chunk-Metadaten relational,
- speichert Embeddings in pgvector-Spalten oder einer separaten Vektor-Tabelle,
- filtert vor und nach Vektorsuche nach `organizationId`, `workspaceId`, `knowledgeStore`, `visibility`, `sourceAclVersion` und User-Berechtigung,
- loescht oder revoked Chunks/Embeddings bei Delete, Move oder Permission Change,
- kann spaeter Graph-Entities und Relations relational speichern.

## Collaboration und Multi-User-Edits

V1 startet nicht mit echter Realtime-Collaboration fuer alle Dateitypen. Fuer Markdown/Text wird die vorhandene Revision-/Lock-/Metadaten-Foundation in einem eigenen Folgebaustein zu echter Yjs-/Hocuspocus-Collaboration ausgebaut. Der vollstaendige Implementierungsplan steht in `18-collaboration-and-file-conflict-policy.md`.

V1-Regeln:

- Markdown- und reine Textdateien bekommen einen persistierten Yjs-Dokumentzustand mit Tiptap- oder CodeMirror-Binding.
- QMD-, JSON-, YAML- und Code-Dateien bleiben in V1 revision- und konfliktgeschuetzt, aber nicht live kollaborativ.
- Office-Dateien, PDFs, Bilder, Videos, Audio und sonstige Binary Assets werden nicht live gemerged.
- Office-/PDF-/Asset-Bearbeitung nutzt Locks, Check-out, Revision Checks und Konfliktkopien.
- Team-Dateien bekommen Revision Checks auch dann, wenn der konkrete Editor noch kein CRDT nutzt.
- Konflikte werden sichtbar, wenn zwei Sessions auf unterschiedlichen Revisionen speichern.
- Workspace-Dateien bleiben als materialisierte Checkpoints erhalten; bei aktiver Collaboration ist der binaere Yjs-State die schreibbare Wahrheit.
- File Tree, Listen- und Grid-Ansicht erhalten workspace-weite Presence-Snapshots und Deltas, damit aktive User schon vor dem Oeffnen einer Datei sichtbar sind.
- File-Tree-Presence erzeugt keine Dokument-Room-Verbindung fuer den betrachtenden User. Die Dokument-WebSocket-Verbindung beginnt erst beim Oeffnen.

Postgres-Abhaengigkeit:

- SQLite kann einfache Revision Checks fuer Single-User oder kleine lokale Nutzung tragen.
- Produktive Multi-User-Collaboration mit Presence, Edit Events, CRDT/OT-State oder vielen parallelen Writes braucht Postgres. `collaboration_documents` speichert dafuer den binaeren Yjs-State und nicht nur Provider-Metadaten.
- Redis ist fuer V1 keine Pflicht. Leichte Events koennen zunaechst ueber App-WebSockets und Postgres-Tabellen/Notifications geplant werden. Wenn spaeter Multi-Node oder hohe Eventlast entsteht, kann Redis/NATS separat entschieden werden.

Presence-Persistenz:

- Awareness und aktuelle File-Tree-Presence bleiben fluechtig und werden nicht als Mitarbeiteraktivitaets-Historie in Postgres gespeichert.
- Postgres speichert Dokumentzustand, State-Version, Representation und Checkpoint-Revision.
- Der File Explorer erhaelt einen permission-geprueften Initial-Snapshot und anschliessend kleine Presence-Deltas ueber einen workspace-weiten Kanal.
- Backup und Restore muessen den Yjs-State aus Postgres und die materialisierten Workspace-Dateien gemeinsam sichern.

## SQLite zu Postgres Migration

Es braucht ein eigenes Migrationswerkzeug fuer bestehende Instanzen.

Der Migrationsassistent gehoert fachlich in den Control-Plane-Agenten auf der VM. Dieser Agent liegt im Repository `../canvas-control-plane` und muss um eine versionierte Migration API erweitert werden.

Control-Plane-Ablauf fuer ein Upgrade von SQLite auf Team:

1. Control Plane erkennt Teamplan fuer eine bisherige SQLite-Instanz.
2. VM-Detailseite zeigt einen Tab `Migration` oder `Database Migration`.
3. Admin/Owner startet den Assistenten manuell.
4. Agent prueft Docker, Compose-Datei, App-Container, Postgres-Service und vorhandene SQLite-Datei.
5. Wenn Postgres fehlt, erzeugt der Agent zuerst den Postgres-Service, Volume, DB-User, DB-Secret und `DATABASE_URL`.
6. Erst danach wird die eigentliche Datenmigration gestartet.
7. Team-Features bleiben blockiert, bis Migration und Healthcheck erfolgreich sind.

Pflichtablauf:

1. Maintenance Mode aktivieren.
2. Laufende Jobs, Automations, Ingestion und Agent-Sessions stoppen oder drainen.
3. SQLite-Snapshot und `/data`-Backup erstellen.
4. Schema-Version und Migration-State pruefen.
5. Postgres initialisieren und Basisschema migrieren.
6. Daten aus SQLite in Postgres transformieren und kopieren.
7. IDs, Foreign Keys, Zuweisungen, Sessions, Workspace-Refs und Audit-Refs pruefen.
8. Knowledge-/Embedding-Indizes nicht blind kopieren; nach Migration reindexieren oder explizit als stale markieren.
9. `CANVAS_DATABASE_PROVIDER=postgres` und `DATABASE_URL` setzen.
10. App-Health pruefen.
11. SQLite-Snapshot fuer Rollback aufbewahren.

Der Agent muss Error Handling und Fortschritt granular melden:

- `postgres_missing`
- `docker_unavailable`
- `compose_update_failed`
- `sqlite_not_found`
- `snapshot_failed`
- `schema_migration_failed`
- `data_copy_failed`
- `reference_check_failed`
- `pgvector_missing`
- `healthcheck_failed`
- `rollback_available`

Nicht erlaubt:

- stille Teilmigration bei laufender Team-Nutzung,
- Team-Features in SQLite aktivieren und spaeter ohne Review "hochziehen",
- Embeddings ohne Source-/ACL-Metadaten migrieren,
- fehlgeschlagene Migration automatisch durch leeres Postgres ersetzen.

## Export, Import und Backup

Export/Import muss den Datenbankprovider kennen.

Migration Export:

- schreibt `databaseProvider`, Schema-Version, App-Version und Feature-Gates ins Manifest,
- exportiert ausgewaehlte App-Daten logisch mit User-/Workspace-/Reference-Mapping,
- enthaelt keine aktiven Public-Link-Tokens,
- enthaelt Knowledge-Metadaten und Source-Refs, aber keine Garantie, dass ein Vektorindex providerunabhaengig portabel ist,
- kann bei Postgres optional einen technischen DB-Dump enthalten, wenn Admin "Full Technical Export" auswaehlt.

Import:

- prueft Source- und Target-Provider im Dry Run,
- erlaubt SQLite-zu-Postgres-Migration nur ueber den dafuer vorgesehenen Migrationsflow,
- blockiert Import von Team-RAG/Embedding-Daten in SQLite-Ziele,
- markiert nicht importierbare Vektor-/Graph-Artefakte als `requires_reindex`.

Full Backup:

- SQLite: konsistenter SQLite Snapshot inklusive WAL/Journal plus `/data`.
- Postgres: konsistenter Postgres-Dump oder physischer Snapshot plus `/data`.
- Postgres-Backups enthalten Rollen-/Extension-/Schema-Informationen, damit pgvector beim Restore vorhanden ist.
- Full Backup wird ueber Admin/API/CLI/Control Plane triggerbar.
- Control Plane muss bei Postgres nicht nur `/data`, sondern auch das Postgres Volume bzw. den DB-Dump erfassen.
- V1 legt Backup-Artefakte lokal auf derselben VM ab.
- V1 startet mit manuellen Backups; kein automatischer Schedule als Pflicht.
- V1 verschluesselt lokale Backup-Artefakte und Postgres-Dumps nicht automatisch. Die UI muss klar warnen, dass Host-/Container-Admins diese Dateien lesen koennen.

## Control Plane UI und Health

Die VM-Detailseite im Control Plane braucht einen Database-/Migration-Bereich.

Anzuzeigen:

- Database Provider: `sqlite` oder `postgres`.
- Deployment Mode und Team-Gate-Status.
- Postgres Container Status.
- Postgres Version.
- pgvector Version und Extension Status.
- DB-Verbindungsstatus aus Canvas Notebook Health.
- Postgres Volume Groesse und freier Host-Speicher.
- letzter DB-Dump / letztes Full Backup.
- Migration Status, Fortschritt, letzte Fehler und Rollback-Hinweis.

Teamplan ohne Postgres:

- Control Plane zeigt `postgres_required`.
- Canvas Notebook Setup/Homepage zeigt einen blockierenden Fehler.
- Team Workspace, Team Knowledge, RAG und Collaboration bleiben gesperrt.

## Tests

Pflichttests:

- SQLite-Installation startet Community/Single-User, aber blockiert Team-RAG.
- Portable CLI kann bei Neuinstallation `sqlite` oder `postgres` explizit auswaehlen.
- Portable CLI erzwingt Postgres fuer `team`/Advanced Runtime.
- Managed-Team-Provisioning ohne Postgres blockiert mit klarer Health-/Setup-Meldung.
- CLI-Installer erzeugt fuer Team/Advanced Features eine Compose-Datei mit Postgres-Service.
- `database prepare-postgres` ist idempotent und startet Postgres plus pgvector ohne SQLite-Datenmigration.
- Control Plane Provisioning setzt `CANVAS_DATABASE_PROVIDER=postgres` und DB-Secrets fuer Teamplaene.
- Control-Plane-Agent kann fehlenden Postgres-Service vor SQLite-zu-Postgres-Migration anlegen.
- VM-Detailseite zeigt Migration-Status und konkrete Error Codes.
- pgvector-Healthcheck erkennt fehlende Extension.
- Backup im Postgres-Mode enthaelt DB-Dump und `/data`.
- Backup im Postgres-Mode zeigt Warnung fuer lokal unverschluesselten DB-Dump.
- Migration Export schreibt `databaseProvider` und Schema-Version ins Manifest.
- Import-Dry-Run blockiert Team-RAG-Daten in SQLite-Ziel.
- SQLite-zu-Postgres-Migration prueft Referenzen und markiert Embeddings als `requires_reindex`.
- App-DB-User hat keine Superuser-Rechte.
