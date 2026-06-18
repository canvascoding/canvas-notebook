# Database Provider, Postgres, RAG und Collaboration Policy

Stand: 2026-06-18

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

V1 startet nicht mit echter Realtime-Collaboration fuer alle Dateitypen.

V1-Regeln:

- Team-Dateien bekommen Revision Checks und Locks fuer riskante Bearbeitung.
- Binary Assets werden nicht live gemerged.
- Text-/Markdown-Dateien koennen spaeter CRDT/OT bekommen.
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
