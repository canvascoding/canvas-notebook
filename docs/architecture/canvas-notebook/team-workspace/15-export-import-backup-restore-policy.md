# Export, Import, Backup und Restore Policy

Stand: 2026-07-08

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

V1-Implementierungsstand:

- Exportprofile: `standard` und `full_admin`.
- `standard` exportiert keine `/data/workspaces/personal/*`-Dateien, auch wenn der Client dies anfordert.
- `full_admin` kann Personal Workspaces nur mit expliziter Auswahl exportieren.
- Das Migration-Bundle enthaelt keine rohen Secret-Dateien aus `/data/secrets`.
- Wenn die Komponente `secrets` ausgewaehlt ist, wird nur `data/reconnect-manifest.json` mit redacted Reconnect-Hinweisen geschrieben.
- Der SQLite-Snapshot wird fuer Migration-Exports bereinigt: Public Shares, Session-/Verification-Tokens, OAuth-Tokens, Channel-Link-Tokens und E-Mail-Reply-Token werden entfernt oder redacted.
- Composio-Webhooks und Automation-Webhooks werden im Snapshot pausiert bzw. ihre Secrets redacted.
- Die UI zeigt Exportprofil, Personal-Workspace-Auswahl und unverschluesseltes V1-Archiv sichtbar an.

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

V1-Implementierungsstand:

- Upload-Inspection erzeugt `inspection.dryRun` mit Zielkontext, User-Mappings, Workspace-Mappings, Reconnect-Anforderungen und Blockern.
- Der Dry Run liest lokale Ziel-User, Ziel-Organisation und aktive Workspace-Records nur fuer Preflight; es werden keine Importdaten geschrieben.
- `createdByUserId`/`createdByEmail` aus dem Export-Manifest und Personal-Workspace-Owner aus Archivpfaden werden als User-Mappings ausgewertet.
- Team-, Personal-, Project- und Legacy-Workspace-Pfade werden aus Manifest-/Archivpfaden erkannt.
- Restore wird serverseitig blockiert, wenn erforderliche User-/Workspace-Mappings nicht ohne Rewrite anwendbar sind.
- Secret-/OAuth-Reconnects aus `data/reconnect-manifest.json` werden als Nacharbeit angezeigt, aber nicht als Dateisecrets importiert.
- Die Settings-UI zeigt Dry-Run-Status, Blocker, User-/Workspace-Mappings und Reconnect-Schritte vor dem Restore-Button an.

## Full Backup

Full Backup ist fuer Betrieb und Disaster Recovery. Es soll den Nutzerdatenzustand einer Canvas-Notebook-Instanz wiederherstellbar machen. Es ist kein VM-, OS-, Docker-Image- oder Host-Konfigurations-Backup.

Scope fuer V1:

- enthalten: Canvas-Notebook-Nutzerdaten, app-interne Instanzdaten unter `/data` und die dazu passende Datenbank,
- nicht enthalten: komplette VM, Betriebssystem, Docker Images, App-Binaries, Source Code, Systemd-/Caddy-Konfiguration, Host-Compose-Datei und Notebook-CLI-Installation,
- nur als Manifest-Metadaten enthalten: App-Version, Datenbankprovider, Dump-/Snapshot-Art, Checksums, CreatedAt, Source-Instanz und Restore-Hinweise.

Mindestinhalt:

- Datenbank provider-spezifisch konsistent gesichert,
- `/data`-Nutzerdaten ohne rekursive Backup-, Cache-, Temp- und Log-Verzeichnisse,
- Workspaces, Studio-Daten, Agenten, Skills/Plugins, Settings, scoped User-/Organization-/Systemdaten und app-interne Runtime-Daten, soweit sie unter dem Canvas-Datenroot liegen,
- Secrets/OAuth-State fuer Full Disaster Recovery, mit klarer Warnung, wenn lokale V1-Backups unverschluesselt sind,
- Public Links inklusive Tokens nur fuer gleiche Disaster-Recovery-Ziele,
- Audit/Usage/Retention-Metadaten,
- Backup Manifest mit Version, Checksums, CreatedAt, Source Instance, Datenbankprovider und Schema-Version.

Trigger:

- manuell durch Owner/Admin im Admin-Kontext,
- durch Control Plane,
- durch Host-/Container-CLI,
- spaeter geplant: Schedule, z. B. taeglich. V1 startet mit manuellem Backup.

Anforderungen:

- Backup muss die Datenbank konsistent sichern: SQLite Snapshot/WAL-Checkpoint oder Postgres Dump/Snapshot.
- V1 setzt die laufende App fuer Backup nicht in Maintenance Mode und stoppt sie nicht.
- Ohne Maintenance Mode ist die Datenbank konsistent, waehrend Dateien unter `/data` als Online-Best-Effort-Snapshot gesichert werden. Das Manifest muss diesen Konsistenzmodus ausweisen.
- Im Postgres-Mode reicht ein Backup von `/data` nicht aus. Der Postgres-Dump bzw. das Postgres-Volume gehoert zwingend zum Full Backup.
- Postgres-Backups muessen Rollen-/Extension-/Schema-Informationen enthalten, damit pgvector beim Restore vorhanden ist.
- Vor Postgres-Backups muss der Provider-Prepare-Pfad bestaetigen, dass Runtime-Env, `DATABASE_URL` und das echte Postgres-Rollenpasswort synchron sind.
- Backup-Jobs laufen als schwere Jobs mit Resource Budget und Logging.
- Backup darf nie mehrere alte Test-/Backup-Jobs parallel unkontrolliert starten.
- Backup-Status und letzte Fehler muessen sichtbar sein.
- V1 legt Backup-Artefakte lokal auf der VM ab. Default ist der Canvas-Backup-Pfad unter `/data/system/backups`; der Host-/Zielpfad muss konfigurierbar sein.
- V1 verwaltet ein stabiles Latest-Backup. Ein neuer Lauf schreibt zuerst in einen temporaeren Staging-Pfad, prueft Archiv, Manifest und Checksum und ersetzt erst danach das bisherige Latest-Backup.
- Das alte Latest-Backup darf erst geloescht oder ueberschrieben werden, wenn das neue Backup vollstaendig erfolgreich erstellt und geprueft wurde.
- V1-Backup-Artefakte und Postgres-Dumps werden nicht automatisch verschluesselt.
- Backup-Archive brauchen Checksums, Integritaetscheck und Retention/Prune-Policy.
- Spaeterer externer Bucket-Upload bleibt vorbereitet und sollte dann Verschluesselung/Transport-Sicherheit bekommen.

### Aktueller Implementierungsstand

Stand 2026-07-08 existiert bereits ein technischer Full-Backup-Kern:

- `app/lib/backups/full-backup-service.ts` erzeugt Full-Backup-Jobs, Manifeste, Checksums und ZIP-Archive.
- SQLite-Backups nutzen einen konsistenten SQLite-Snapshot.
- Postgres-Backups nutzen einen `pg_dump`-Artefaktpfad mit Preflight auf verfuegbaren Dump-Befehl.
- `app/api/admin/backups/*` bietet Erstellen, Auflisten, Status, Download und Inspect fuer Full-Backup-Jobs.
- `scripts/create-full-backup.ts` kann Full Backups im Container anstossen.
- `npm run test:backup:full` deckt SQLite, Postgres-Dump-Pfad, Locking und Inspection ab.

Noch nicht fertig als Produktfeature:

- Die Settings-UI zeigt Migration Export/Import und einfache Datei-/Daten-Downloads, aber noch keinen dedizierten Full-Backup-Bereich.
- Legacy Bash CLI und portable TypeScript-CLI haben noch keinen offiziellen `backup`-Befehl.
- Die Control Plane hat Database-/Migration-Runs, aber noch keine Full-Backup-Operation.
- Das bestehende Backup erzeugt pro Job ein eigenes Archiv. Der stabile Latest-/Replace-Flow mit atomarer Promotion und sicherem Behalten des alten Backups bis zum Erfolg fehlt noch.
- Die Notebook-CLI muss die im Control-Plane-Agenten vorbereitete Postgres-Auth-Reconciliation dauerhaft uebernehmen, damit Backups nach `install`, `update`, `restart` oder `env --sync` nicht an Passwortdrift zwischen Runtime-Env und bestehendem Postgres-Volume scheitern.

### Full Backup Implementierungsplan

Die Backup-Integration wird erst nach dem Provider-Setup-Schritt aus `17-database-provider-postgres-rag-collaboration-policy.md` freigeschaltet. Das verhindert, dass Backups in SQLite funktionieren, aber bei den kuenftigen Team-/Postgres-Installationen scheitern.

Phase 0: Postgres-Provider-Prepare finalisieren.

- Die defensive Control-Plane-Agent-Logik fuer Managed Postgres wird als Referenz genutzt, aber in die Notebook-CLI verlagert.
- Beide CLI-Linien bekommen einen gemeinsamen `prepare-postgres`-Mechanismus fuer Runtime-Env, Compose-Profil, Postgres-Bereitschaft, Rollenpasswort-Reconciliation, Passwort-Verify und pgvector.
- Der Prepare-Pfad liest intern unredacted Config-/Env-Dateien. `config-show --json` bleibt redacted und darf nicht als Secret-Quelle fuer Reconciliation verwendet werden.
- `install`, `update`, `start`, `restart`, `env --sync`, `database prepare-postgres` und `database migrate-sqlite-to-postgres` nutzen denselben Ablauf.
- Bei maskierten Secrets, fehlendem Passwort-Verify, fehlendem Postgres-Container oder fehlender pgvector-Extension bricht Full Backup mit strukturiertem Preflight-Fehler ab.

Phase 1: Backup-Engine haerten.

- Postgres-Dump-Preflight absichern: Provider, `DATABASE_URL`, `pg_dump`-Verfuegbarkeit, Version und Zielpfad pruefen, bevor ein Archiv geschrieben wird.
- V1 entscheidet sich fuer einen kompatiblen Postgres-Client im App-Container oder fuer einen kontrollierten Dump im Postgres-Container.
- Fehler muessen vor partiellen Archiven abbrechen und als strukturierte Backup-Fehler sichtbar werden.
- Backup-Output erhaelt einen `latest`-Modus: `latest.next`/Staging schreiben, Archiv und Manifest inspizieren, Checksum validieren, dann atomar auf `latest` promoten.
- Retention fuer V1 behaelt genau ein erfolgreiches Latest-Backup plus kurzlebige Staging-/Fehlerstatusdaten. Alte Backups werden erst nach erfolgreicher Promotion entfernt.
- Das Backup-Manifest weist `scope=data_only`, `hostConfigIncluded=false`, `dockerImagesIncluded=false`, `osIncluded=false` und `consistency=online_best_effort` aus.
- Job-Serialisierung darf keine lokalen `filePath`-Interna und keine sensiblen Pfade an normale API-Listen leaken.
- Inspection-Permissions muessen zu Backup-Management passen: Backup-Manager muessen ein Backup inspizieren koennen, Restore-Rechte bleiben separat.

Phase 2: Settings-UI in der App.

- Im Workspace-/Admin-Settings-Bereich entsteht ein dedizierter Full-Backup-Abschnitt.
- Sichtbar nur fuer Owner/Admins oder Rollen mit `canManageBackups`.
- UI-Funktionen:
  - vorhandene Backups laden,
  - neues Backup starten,
  - laufenden Job pollen,
  - Status, Phase, Groesse, Provider und Warnungen anzeigen,
  - fertiges ZIP herunterladen,
  - Backup-Manifest inspizieren,
  - lokale unverschluesselte V1-Backups klar warnen.
- Die UI darf Full Backup nicht mit Migration Export oder `/data`-Download vermischen.
- Optional fuer V1.1: Backup loeschen/prunen, damit lokale VM-Disk nicht unkontrolliert voll laeuft.

Phase 3: Beide Notebook-CLIs.

Legacy Bash CLI und portable TypeScript-CLI bekommen denselben Befehl:

```txt
canvas-notebook backup create [--output <path>] [--json] [--no-wait]
canvas-notebook backup list [--json]
canvas-notebook backup status <id> [--json]
```

V1-Mindestumfang ist `backup create`; `list` und `status` koennen folgen, wenn die UI/API-Serialisierung stabil ist.

Regeln:

- Beide CLIs orchestrieren Backup, duplizieren aber nicht die Backup-Engine.
- Beide CLIs rufen einen Container-internen Backup-Command bzw. Scriptpfad auf, der die vorhandene Notebook-Backup-Logik in einem separaten Prozess nutzt.
- Der CLI ruft fuer Backup-Erstellung nicht die laufende Web-App per HTTP auf. Die laufende App darf parallel weiterlaufen.
- `--output <path>` bzw. ein konfigurierter Backup-Zielpfad kopiert oder schreibt ein fertiges Backup lokal auf der VM.
- `--output` ist nur mit wartendem `create` erlaubt, nicht mit `--no-wait`.
- JSON-Ausgaben muessen maschinenlesbar sein und duerfen keine Secrets enthalten.
- Bei Postgres muss der CLI-Fehler klar sagen, ob Provider-Setup, `pg_dump`, Postgres-Health oder Dump-Erzeugung fehlt.

Phase 4: Control Plane.

- V1 nutzt die bestehende Agent-/Run-Architektur statt freie Shell-VM-Actions.
- Moegliche Modellierung:
  - `database:run` um `backup_full` erweitern, wenn Backup als Database/Maintenance-Operation behandelt wird.
  - oder eigene `backup:run`-Familie, wenn spaeter Retention, externe Ziele und Restore-Workflows groesser werden.
- Der Agent startet auf der VM `canvas-notebook backup create --json` oder direkt den Container-internen Scriptpfad.
- Control Plane speichert Run-ID, Phase, Progress, Provider, Dateigroesse, Checksum und Fehlercode.
- Die Web-UI zeigt nur redacted Status und Artefaktmetadaten. Lokale VM-Pfade, `DATABASE_URL`, Postgres-Passwort, Instance Token und interne API-Keys bleiben verborgen.
- Die Control-Plane-VM-Detailseite bekommt einen Backup-Bereich mit `Backup erstellen/ersetzen`, Status, Groesse, Erstellzeit, Provider, Checksum und Download-Button.
- Der Download-Button ist Teil von V1, weil nicht-technische Nutzer sonst keinen praktikablen Zugriff auf das lokale VM-Backup haben.
- Der Download streamt das lokale Backup-Artefakt ueber Agent/Control Plane zum Browser. Die Control Plane speichert das ZIP nicht dauerhaft in ihrer Datenbank.
- Externer Bucket-Upload bleibt spaeter optional und ist nicht Aufgabe des ersten CLI-Backup-Flows.

Phase 5: Restore und Retention folgen separat.

- Full Backup Create/Download ist nicht automatisch Full Restore, bereitet Restore aber durch Manifest, Checksums und Provider-Metadaten vor.
- Restore braucht eigenen Dry Run, Provider-Kompatibilitaet, App-Stopp oder Maintenance Mode und Rollback-Regeln. Restore darf nicht gegen eine normal laufende App schreiben.
- Retention V1 ersetzt lokal das alte Latest-Backup erst nach erfolgreichem neuen Backup. Spaetere externe Backup-Ziele koennen darauf aufbauen.

### Reihenfolge der Umsetzung

1. Provider-Setup vorlagern: dauerhafter Postgres-Prepare-Service in portable TS-CLI und Legacy Bash-CLI inklusive Rollenpasswort-Reconciliation, Passwort-Verify, pgvector und Postgres-Health.
2. `install`, `update`, `start`, `restart`, `env --sync`, `database prepare-postgres` und `database migrate-sqlite-to-postgres` auf diesen Service umstellen.
3. Postgres-Dump-Voraussetzung loesen und Preflight im Backup-Service beibehalten.
4. Full-Backup-Service/API absichern und Serialisierung korrigieren.
5. App Settings UI integrieren.
6. Legacy Bash CLI `backup create`.
7. Portable TypeScript-CLI `backup create`.
8. Lokalen Latest-/Replace-Flow mit atomarer Promotion und konfigurierbarem Zielpfad implementieren.
9. Control-Plane-Run fuer manuelle Full Backups inklusive Download-Button.
10. Restore-Command und Restore-Dry-Run planen/umsetzen.

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
- Settings-UI kann Full Backup starten, pollt den Jobstatus und laedt fertige Archive herunter.
- Legacy Bash CLI kann `backup create --output <path>` ausfuehren.
- Portable TypeScript-CLI kann `backup create --output <path>` ausfuehren.
- Control Plane kann einen Full-Backup-Run starten und Status/Fehler ohne Secrets anzeigen.
- Geplanter Backup-Job blockiert parallele Backup-Laeufe.
- Postgres-Prepare synchronisiert bei bestehendem Docker-Volume das Rollenpasswort auf das aktuelle Runtime-Passwort, bevor Backup, App-Start oder App-Recreate weiterlaufen.
- `config-show --json` bleibt redacted; interne Prepare-/Backup-Preflights koennen trotzdem echte Secrets aus geschuetzten lokalen Quellen laden.
- `env --sync` mit Postgres startet keine App, die wegen Passwortdrift sofort in einen DB-Auth-Loop laeuft.
- Restore Preview erkennt Konflikte vor dem Schreiben.
- Restore-/Migration-Manifest V2 enthaelt Provider-, Schema-, Source-, Feature- und Checksum-Felder.
- Postgres-Full-Backup enthaelt DB-Dump/Snapshot plus `/data`.
- Postgres-Full-Backup bricht vor Archivschreibung mit klarem Fehler ab, wenn `pg_dump` oder ein gleichwertiger Dump-Weg fehlt.
- Import-Dry-Run erkennt Provider-Mismatch und blockiert Team-RAG-Downgrade nach SQLite.
- V1-Backup-Artefakte liegen lokal und unverschluesselt auf der VM.
