# Export, Import, Backup und Restore Policy

Stand: 2026-06-18

## Zweck

Dieses Dokument trennt User-Export, Admin-/Migration-Export, Import, Full Backup und Restore. Diese Modi duerfen nicht vermischt werden, weil sie unterschiedliche Sicherheits-, Datenschutz- und Betriebsziele haben.

Es ergaenzt die Aufgaben `27`, `28` und `36` im Aufgabenindex.

Database-Provider-Regeln fuer SQLite, Postgres, pgvector und SQLite-zu-Postgres-Migration stehen verbindlich in `17-database-provider-postgres-rag-collaboration-policy.md`.

## Grundentscheidung

Canvas Notebook braucht drei klar getrennte Datenbewegungen:

1. Self-service Personal Export fuer normale User.
2. Admin-/Migration-Export fuer bewusst ausgewaehlte Organization-Daten.
3. Full Backup fuer Disaster Recovery und Managed Operations.

Ein Backup darf mehr enthalten als ein Export, ist aber kein normaler Download. Ein Export ist eine bewusste Datenweitergabe. Ein Import ist eine Migration mit Mapping und Dry Run.

## Personal Export

Normale User duerfen exportieren:

- eigenen Personal Workspace,
- eigene User-Einstellungen, soweit exportfaehig,
- eigene user-owned Agenten/Prompts, falls nicht als Organization Template gespeichert,
- eigene To-dos optional, wenn sie nicht organizationweit geteilt sind.

Nicht enthalten:

- fremde Personal Workspaces,
- Team Workspace,
- Organization-Konfiguration,
- Studio Assets als gesamte Organization-Sammlung,
- Public Links,
- Secrets/OAuth-Tokens im Klartext.

Secrets und externe Connections werden nur als Reconnect-Hinweis oder redacted Manifest exportiert.

## Admin- und Migration-Export

Owner/Admins oder User mit expliziter Export-Permission duerfen einen granularen Organization Export ausfuehren.

Exportierbare Bereiche:

- Team Workspace,
- ausgewaehlte Personal Workspaces, wenn Full/Admin Export explizit gewaehlt wird,
- Studio Assets, Produkte, Personas, Styles,
- Organization Agent Templates,
- Organization Automations,
- To-dos und Zuweisungen,
- Knowledge-Metadaten ohne erzwungene Vektor-DB-Portabilitaet,
- Audit Trail optional oder separat,
- App-/Organization-Konfiguration,
- Reconnect-Manifeste fuer Secrets/OAuth.

Regeln:

- Full/Admin Export darf Personal Workspaces enthalten, muss aber explizit gewaehlt, gewarnt und auditiert werden.
- Ein normaler Admin-/Migration-Export sollte Personal Workspaces nicht stillschweigend einschliessen.
- Public Links werden in Migration Exports nicht aktiv exportiert.
- Public-Link-Tokens werden nie migriert.
- Nach Import muessen Public Links neu gesetzt werden.
- Vollstaendige aktive Public Links werden nur in Full Backups fuer gleiche Disaster-Recovery-Ziele gesichert.
- Jeder Admin-/Migration-Export enthaelt `databaseProvider`, Schema-Version, App-Version und Feature-Gates im Manifest.
- Wenn Postgres genutzt wird, kann ein bewusst aktivierter Full Technical Export einen Postgres-Dump enthalten. Normale Migration Exports bleiben logisch und provider-aware.
- V1-Technical-Exports und lokale Backup-Artefakte werden nicht automatisch verschluesselt. Die UI muss deshalb warnen, dass ein Host-/Container-Admin sie lesen kann.

## Bestehendes Migration Manifest

Im aktuellen Code existiert bereits ein Migration-Bundle-Manifest:

- Typen: `app/lib/migration/types.ts`
- Export: `app/lib/migration/export-service.ts`
- Inspection: `app/lib/migration/inspect-service.ts`
- Restore-Anwendung: `scripts/apply-pending-migration-restore.ts`

V1-Manifest heute:

- `format = "canvas-notebook-migration"`
- `bundleSchemaVersion = 1`
- `appVersion`
- `exportedAt`
- `exportId`
- `components`
- `fileCount`
- `totalBytes`
- `warnings`
- `files`

Aktuell ist das ein SQLite-/Datei-Migration-Manifest, kein vollstaendiges Postgres-/Disaster-Recovery-Manifest.

Erweiterung fuer Bundle Schema Version 2:

```txt
database:
- provider: sqlite | postgres
- logicalSchemaVersion
- migrationVersion
- backupKind: sqlite_snapshot | postgres_dump | none
- artifactPath
- artifactSha256
- compressedBytes?
- pgvectorEnabled?
- pgvectorVersion?
- postgresVersion?

source:
- instanceId
- organizationId
- deploymentMode
- managedServicesEnabled
- createdByUserId

features:
- teamWorkspaceEnabled
- knowledgeEnabled
- embeddingsEnabled
- collaborationEnabled

restore:
- requiresPostgres
- requiresReindex
- preservesTargetInstanceAndLicense
- publicLinksIncluded: false fuer Migration Export, true nur fuer Full Backup
```

Regeln:

- `bundleSchemaVersion=1` bleibt fuer bestehende SQLite-Migrationen lesbar.
- Postgres-Dumps duerfen nicht in ein V1-Manifest ohne Provider-Felder geschrieben werden.
- Import/Restore muss Provider-Mismatch im Dry Run anzeigen, bevor Dateien oder Datenbank geschrieben werden.
- Full Backup darf ein anderes Format wie `canvas-notebook-full-backup` nutzen, soll aber dieselben Provider-, Source-, Feature- und Checksum-Felder enthalten.

## Zuweisungen und Referenzen

Import/Export muss Zuweisungen und Referenzen korrekt behandeln.

Betroffene Referenzen:

- `userId` fuer Creator, Owner, Assignee, Actor.
- `workspaceId` fuer Dateien, To-dos, Automations, Agent-Sessions.
- `sessionId` oder Chat-Referenzen, wenn Chat-/Agent-Historie exportiert wird.
- `agentId` und Agent Template IDs.
- `automationId`, `todoId`, `sourceStudioOutputId`.
- File References mit Workspace, Pfad und optional Revision/Hash.
- Datenbankprovider und Schema-Version fuer Quelle und Ziel.

Regeln:

- Export schreibt ein Manifest mit logischen IDs und Referenztypen.
- Import laeuft zuerst als Dry Run und erzeugt eine Mapping-Tabelle.
- User-Referenzen muessen auf bestehende oder neu importierte User gemappt werden.
- Chat-/Session-Referenzen duerfen nur gemappt werden, wenn die Ziel-Session ebenfalls importiert wird.
- Unaufloesbare Referenzen werden nicht stillschweigend auf den importierenden Admin gesetzt.
- Unaufloesbare Referenzen bekommen Status `unresolved` und muessen im Import-Report sichtbar sein.
- To-dos, Automations und Agent-Verknuepfungen duerfen erst aktiviert werden, wenn ihre User-/Workspace-/Secret-Referenzen aufgeloest sind.
- Team-RAG-/Embedding-/Knowledge-Graph-Daten duerfen nicht in ein SQLite-Ziel importiert werden; der Dry Run muss `requires_postgres` oder `requires_reindex` melden.

## Full Backup

Full Backup ist fuer Betrieb und Disaster Recovery. Es soll die komplette Instanz wiederherstellbar machen.

Mindestinhalt:

- Datenbank provider-spezifisch konsistent gesichert,
- `/data/workspaces`,
- `/data/studio`,
- scoped User-/Organization-/System-Konfiguration,
- Secrets/OAuth-State fuer Full Disaster Recovery, mit klarer Warnung wenn lokale V1-Backups unverschluesselt sind,
- Agent-/Runtime-Konfiguration,
- Public Links inklusive Tokens nur fuer gleiche Disaster-Recovery-Ziele,
- Audit/Usage/Retention-Metadaten,
- Backup Manifest mit Version, Checksums, CreatedAt, Source Instance und Schema-Version.

Trigger:

- manuell durch Owner/Admin im Admin-Kontext,
- durch Control Plane,
- durch Host-/Container-CLI,
- spaeter geplant: Schedule, z. B. taeglich. V1 startet mit manuellem Backup.

Anforderungen:

- Backup muss konsistent sein: SQLite Snapshot/WAL-Checkpoint, Postgres Dump/Snapshot oder kontrollierter Maintenance-Modus.
- Im Postgres-Mode reicht ein Backup von `/data` nicht aus. Der Postgres-Dump bzw. das Postgres-Volume gehoert zwingend zum Full Backup.
- Postgres-Backups muessen Rollen-/Extension-/Schema-Informationen enthalten, damit pgvector beim Restore vorhanden ist.
- Backup-Jobs laufen als schwere Jobs mit Resource Budget und Logging.
- Backup darf nie mehrere alte Test-/Backup-Jobs parallel unkontrolliert starten.
- Backup-Status und letzte Fehler muessen sichtbar sein.
- V1 legt Backup-Artefakte lokal auf der VM ab.
- V1-Backup-Artefakte und Postgres-Dumps werden nicht automatisch verschluesselt.
- Backup-Archive brauchen Checksums, Integritaetscheck und Retention/Prune-Policy.
- Spaeterer externer Bucket-Upload bleibt vorbereitet und sollte dann Verschluesselung/Transport-Sicherheit bekommen.

## Restore

Restore-Modi:

- Full Instance Restore fuer Disaster Recovery.
- Organization Restore, wenn spaeter mehrere Organizations pro Instanz moeglich werden.
- Granular Restore fuer Datei, Ordner oder Revision.
- Metadata Restore fuer To-dos, Automations, Studio Asset Metadata oder Agent Templates.

Regeln:

- Restore braucht Preview/Dry Run, ausser bei explizitem Full Disaster Restore.
- Restore darf bestehende Daten nicht stillschweigend ueberschreiben.
- Secrets/OAuth brauchen Reconnect oder entschluesselten Full-Backup-Kontext.
- Public Links aus Migration Imports werden nicht automatisch reaktiviert.
- Public Links aus Full Disaster Restore koennen erhalten bleiben, wenn Source und Ziel dieselbe kontrollierte Instanz-/Backup-Domain sind.
- Provider-Mismatch ist ein Restore-/Import-Konflikt. SQLite-Quellen koennen ueber den definierten Migration-Flow nach Postgres gehoben werden; Postgres-Team-RAG-Daten duerfen nicht in SQLite downgraded werden.

## Rollback-Regeln

Rollback folgt Phasen. Automatischer Rollback ist nur erlaubt, solange keine neuen produktiven Writes auf dem neuen Zielsystem akzeptiert wurden.

Phasen:

1. `preflight`: keine Aenderung, Fehler bricht ohne Rollback ab.
2. `snapshot_created`: SQLite-Snapshot, `/data`-Backup und Manifest wurden erstellt. Rollback besteht aus Nicht-Anwenden und Aufbewahrung des Snapshots.
3. `postgres_prepared`: Postgres-Container, Volume, User und Extension sind angelegt, App laeuft aber noch auf SQLite. Fehler duerfen automatisch auf `sqlite_active` zurueckgehen; Postgres bleibt optional fuer Diagnose erhalten.
4. `data_copied`: Daten liegen in Postgres, App ist noch nicht umgeschaltet. Fehler duerfen automatisch neu kopieren oder abbrechen; SQLite bleibt Quelle der Wahrheit.
5. `validated`: Referenzen, Counts, Checksums, Schema und Health sind geprueft. Noch kein User-Traffic auf Postgres.
6. `cutover_started`: Env/Compose/App werden auf Postgres umgeschaltet. Wenn Health vor Freigabe fehlschlaegt und keine User-Writes zugelassen wurden, darf automatisch auf SQLite-Env/Compose zurueckgeschaltet werden.
7. `cutover_completed`: Team-Features und User-Writes sind freigegeben. Ab hier kein automatischer Rollback mehr.
8. `post_cutover_failed`: Fehler nach produktiven Writes fuehrt zu Maintenance Mode und Owner-/Admin-Recovery-Flow mit Warnung, Audit und manueller Entscheidung.

Best-Practice-Regeln:

- Quelle wird nie destruktiv geloescht, bevor Retention und mindestens ein erfolgreiches Postgres-Backup vorhanden sind.
- Jeder Schritt schreibt `migration_state` mit Phase, Zeit, Actor, Checksums, Counts und letzter erfolgreicher Aktion.
- Rollback darf keine neueren Writes verlieren, ohne explizite Owner/Admin-Bestaetigung.
- Bei Post-Cutover-Fehlern gibt es nur Recovery-Optionen: Postgres reparieren, aus Full Backup wiederherstellen oder manuell aus SQLite-Snapshot plus Postgres-Diff rekonstruieren.
- Recovery-Aktionen sind Owner/Admin-only, auditpflichtig und zeigen klar, welche Daten verloren gehen koennten.

## Admin-Zugriff und Verschluesselung

Solange Workspace-Dateien im Container im Klartext liegen und die App sie lesen kann, kann ein Host-/Container-Admin mit ausreichenden Rechten die Dateien technisch lesen. App-Level Exportrechte sind dann Policy-, UI- und Audit-Grenzen, aber keine kryptografische Abschottung gegen Root-/Container-Admins.

Moegliche Verschluesselungsmodelle:

1. Volume-/Disk-Verschluesselung: schuetzt gegen verlorene Disks oder Offline-Zugriff, aber nicht gegen Admins auf laufendem Host.
2. Server-side Workspace Encryption: Dateien werden pro Workspace verschluesselt, aber wenn Keys im Container, in Env oder in lokaler DB liegen, kann ein Admin mit Root-Zugriff typischerweise auch die Keys finden.
3. Externe KMS/Control-Plane-Key-Verwaltung: verbessert Backup- und Secret-Schutz, schuetzt aber laufende App-Zugriffe nur begrenzt, wenn die App entschluesseln darf.
4. User-held oder Client-side Encryption: Admins koennen Rohdateien nicht lesen, aber Server-Preview, Search, Knowledge-Ingestion, Agent-Dateitools und Automations funktionieren nur, wenn der User die Daten aktiv entschluesselt oder dem Agenten zeitweise Zugriff gibt.

Empfehlung fuer V1:

- Keine Dateisystem- oder per-Workspace-Verschluesselung fuer Workspace-Dateien in V1.
- Dateien bleiben im Container-Dateisystem lesbar.
- App erzwingt strikte User-/Workspace-/Exportrechte.
- Admin-Full-Export ist erlaubt, aber explizit, auditiert und nicht mit normalem User-Export vermischt.
- Lokale V1-Backups und Postgres-Dumps werden nicht automatisch verschluesselt; Admin-UI und Control Plane muessen diesen Umstand sichtbar machen.
- Keine falsche Sicherheitsbehauptung machen, dass Admins technisch keine Dateien sehen koennen.

Option fuer spaeter:

- Enterprise-Modus mit per-Workspace Envelope Encryption.
- Optional externe KMS-Keys.
- Optional user-held Keys fuer besonders sensible Personal Workspaces, mit klaren Feature-Einschraenkungen fuer Agenten, Search und Automations.

## Tests

Pflichttests:

- User exportiert nur eigenen Personal Workspace.
- User kann keinen fremden Personal Workspace exportieren.
- Admin-/Migration-Export schliesst Personal Workspaces nur bei expliziter Full/Admin-Auswahl ein.
- Migration Export enthaelt keine aktiven Public Links oder Tokens.
- Import markiert Public Links als neu zu erstellen.
- Import-Dry-Run zeigt User-, Workspace-, Chat-/Session- und Agent-Referenz-Mapping.
- Unaufloesbare Zuweisungen werden als `unresolved` reportet und nicht stillschweigend umgebogen.
- Secrets/OAuth werden im Migration Export nur als Reconnect-Manifest exportiert.
- Full Backup enthaelt Public Links und kann Secrets/OAuth-State enthalten; bei lokal unverschluesseltem V1-Backup muss die Admin-Warnung sichtbar sein.
- Backup kann via Admin/API/CLI getriggert werden.
- Geplanter Backup-Job blockiert parallele Backup-Laeufe.
- Restore Preview erkennt Konflikte vor dem Schreiben.
- Restore-/Migration-Manifest V2 enthaelt Provider-, Schema-, Source-, Feature- und Checksum-Felder.
- Postgres-Full-Backup enthaelt DB-Dump/Snapshot plus `/data`.
- Import-Dry-Run erkennt Provider-Mismatch und blockiert Team-RAG-Downgrade nach SQLite.
- V1-Backup-Artefakte liegen lokal und unverschluesselt auf der VM.
