# Database Provider, Postgres, RAG und Collaboration Policy

Stand: 2026-07-01

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

## Control Plane Status Quo

Lesender Abgleich mit `../canvas-control-plane` am 2026-06-18:

- `apps/api/src/services/managedSecrets.ts` enthaelt heute `MANAGED_SERVICE_ENV_KEYS` mit `CANVAS_MANAGED_SERVICES_ENABLED`, `CANVAS_CONTROL_PLANE_URL`, `CANVAS_INSTANCE_ID`, `CANVAS_INSTANCE_TOKEN` und `CANVAS_LICENSE_CERT`.
- `applyManagedEnvToVmConfig()` und `ensureManagedEnvForVmConfig()` schreiben aktuell nur diese Managed-Service-Env-Werte in `vmConfig.env`.
- `apps/api/src/services/agentArtifacts.ts` erzeugt den Canvas-Control-CLI-Installer und den VM-Install-Script-Pfad. Dort wird der Canvas-Notebook-Installer mit `notebookEnv` ausgefuehrt.
- `packages/agent/src/ws-client.ts` kann bereits `config:apply` empfangen, `canvas-notebook config-set env.<KEY>` ausfuehren und danach `canvas-notebook env --sync` starten.
- `apps/api/src/lib/actionCatalog.ts` definiert die VM-Actions, `apps/api/src/routes/actions.ts` schickt Actions an den VM-Agenten.
- `apps/web/src/app/dashboard/vms/[id]/page.tsx` enthaelt die VM-Detailseite mit Tabs fuer Metrics, Logs, Terminal, Health, Lifecycle, Alerts, Actions, Maintenance, Setup, Account und Users.
- `apps/web/src/components/vm/maintenance-tab.tsx` ist ein vorhandenes Muster fuer laengere Host-/VM-Operationen mit Status, Runs und Output.
- `packages/agent/src/metrics/docker.ts` sammelt vorhandene Docker-Metriken; fuer Postgres braucht es zusaetzliche Container-/Volume-/DB-Health-Metriken.

Konkrete Control-Plane-Aenderungspunkte:

- `MANAGED_SERVICE_ENV_KEYS` um `CANVAS_DEPLOYMENT_MODE`, `CANVAS_ORGANIZATION_ID`, `CANVAS_DATABASE_PROVIDER`, `DATABASE_URL`, `CANVAS_POSTGRES_VECTOR_ENABLED`, `CANVAS_POSTGRES_IMAGE` und `CANVAS_POSTGRES_DATA_VOLUME` erweitern.
- `applyManagedEnvToVmConfig()` und `ensureManagedEnvForVmConfig()` provider-aware machen und Teamplaene auf `CANVAS_DATABASE_PROVIDER=postgres` setzen.
- `getInstallScript()`/Notebook-Installer-Uebergabe in `agentArtifacts.ts` so erweitern, dass Team-VMs direkt Postgres/pgvector-Compose und DB-Secrets bekommen.
- VM-Agent in `ws-client.ts` um eine explizite `database:migrate`- oder `database:prepare-postgres`-Operation erweitern, statt die Migration nur als freie Shell-Action abzuwickeln.
- `VM_ACTIONS` nur fuer einfache Bedienaktionen verwenden; fuer SQLite-zu-Postgres-Migration ist ein eigener API-/Run-Typ sinnvoll, damit Fortschritt, Error Codes und Rollback-Hinweise strukturiert gespeichert werden.
- VM-Detailseite um einen Tab `Database` oder `Migration` erweitern. Der Tab soll den aktuellen Provider, Team-Gate-Status, Postgres-/pgvector-Status, Backup-Status und Migration-Runs anzeigen.
- `maintenance-tab.tsx` kann als UI-Muster dienen, aber die DB-Migration bekommt eigene Validierungen, Rollenpruefung und gefuehrte Warnungen.

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

V1 startet nicht mit echter Realtime-Collaboration fuer alle Dateitypen. Fuer Markdown/Text soll aber direkt die richtige Grundlage gelegt werden, damit Team-Arbeit nicht auf reine Last-Write-Wins-Revisionen reduziert wird.

V1-Regeln:

- Markdown- und reine Textdateien bekommen eine CRDT/Yjs- oder kompatible Operation-Log-Grundlage fuer Live-/Near-Live-Collaboration.
- QMD-, JSON-, YAML- und Code-Dateien bleiben in V1 revision- und konfliktgeschuetzt, aber nicht live kollaborativ.
- Office-Dateien, PDFs, Bilder, Videos, Audio und sonstige Binary Assets werden nicht live gemerged.
- Office-/PDF-/Asset-Bearbeitung nutzt Locks, Check-out, Revision Checks und Konfliktkopien.
- Team-Dateien bekommen Revision Checks auch dann, wenn der konkrete Editor noch kein CRDT nutzt.
- Konflikte werden sichtbar, wenn zwei Sessions auf unterschiedlichen Revisionen speichern.

Postgres-Abhaengigkeit:

- SQLite kann einfache Revision Checks fuer Single-User oder kleine lokale Nutzung tragen.
- Produktive Multi-User-Collaboration mit Presence, Edit Events, CRDT/OT-State oder vielen parallelen Writes braucht Postgres.
- Redis ist fuer V1 keine Pflicht. Leichte Events koennen zunaechst ueber App-WebSockets und Postgres-Tabellen/Notifications geplant werden. Wenn spaeter Multi-Node oder hohe Eventlast entsteht, kann Redis/NATS separat entschieden werden.

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
- Managed-Team-Provisioning ohne Postgres blockiert mit klarer Health-/Setup-Meldung.
- CLI-Installer erzeugt fuer Team/Advanced Features eine Compose-Datei mit Postgres-Service.
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
