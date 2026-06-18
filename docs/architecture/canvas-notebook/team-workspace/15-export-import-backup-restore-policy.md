# Export, Import, Backup und Restore Policy

Stand: 2026-06-18

## Zweck

Dieses Dokument trennt User-Export, Admin-/Migration-Export, Import, Full Backup und Restore. Diese Modi duerfen nicht vermischt werden, weil sie unterschiedliche Sicherheits-, Datenschutz- und Betriebsziele haben.

Es ergaenzt die Aufgaben `27`, `28` und `36` im Aufgabenindex.

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

## Zuweisungen und Referenzen

Import/Export muss Zuweisungen und Referenzen korrekt behandeln.

Betroffene Referenzen:

- `userId` fuer Creator, Owner, Assignee, Actor.
- `workspaceId` fuer Dateien, To-dos, Automations, Agent-Sessions.
- `sessionId` oder Chat-Referenzen, wenn Chat-/Agent-Historie exportiert wird.
- `agentId` und Agent Template IDs.
- `automationId`, `todoId`, `sourceStudioOutputId`.
- File References mit Workspace, Pfad und optional Revision/Hash.

Regeln:

- Export schreibt ein Manifest mit logischen IDs und Referenztypen.
- Import laeuft zuerst als Dry Run und erzeugt eine Mapping-Tabelle.
- User-Referenzen muessen auf bestehende oder neu importierte User gemappt werden.
- Chat-/Session-Referenzen duerfen nur gemappt werden, wenn die Ziel-Session ebenfalls importiert wird.
- Unaufloesbare Referenzen werden nicht stillschweigend auf den importierenden Admin gesetzt.
- Unaufloesbare Referenzen bekommen Status `unresolved` und muessen im Import-Report sichtbar sein.
- To-dos, Automations und Agent-Verknuepfungen duerfen erst aktiviert werden, wenn ihre User-/Workspace-/Secret-Referenzen aufgeloest sind.

## Full Backup

Full Backup ist fuer Betrieb und Disaster Recovery. Es soll die komplette Instanz wiederherstellbar machen.

Mindestinhalt:

- Datenbank inklusive WAL/Journal konsistent gesichert,
- `/data/workspaces`,
- `/data/studio`,
- scoped User-/Organization-/System-Konfiguration,
- Secrets/OAuth-State nur verschluesselt,
- Agent-/Runtime-Konfiguration,
- Public Links inklusive Tokens nur fuer gleiche Disaster-Recovery-Ziele,
- Audit/Usage/Retention-Metadaten,
- Backup Manifest mit Version, Checksums, CreatedAt, Source Instance und Schema-Version.

Trigger:

- manuell durch Owner/Admin im Admin-Kontext,
- durch Control Plane,
- durch Host-/Container-CLI,
- spaeter geplant: Schedule, z. B. taeglich.

Anforderungen:

- Backup muss konsistent sein: DB Snapshot/WAL-Checkpoint oder kontrollierter Maintenance-Modus.
- Backup-Jobs laufen als schwere Jobs mit Resource Budget und Logging.
- Backup darf nie mehrere alte Test-/Backup-Jobs parallel unkontrolliert starten.
- Backup-Status und letzte Fehler muessen sichtbar sein.
- Backup-Archive brauchen Verschluesselung, Integritaetscheck und Retention/Prune-Policy.

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

## Admin-Zugriff und Verschluesselung

Solange Workspace-Dateien im Container im Klartext liegen und die App sie lesen kann, kann ein Host-/Container-Admin mit ausreichenden Rechten die Dateien technisch lesen. App-Level Exportrechte sind dann Policy-, UI- und Audit-Grenzen, aber keine kryptografische Abschottung gegen Root-/Container-Admins.

Moegliche Verschluesselungsmodelle:

1. Volume-/Disk-Verschluesselung: schuetzt gegen verlorene Disks oder Offline-Zugriff, aber nicht gegen Admins auf laufendem Host.
2. Server-side Workspace Encryption: Dateien werden pro Workspace verschluesselt, aber wenn Keys im Container, in Env oder in lokaler DB liegen, kann ein Admin mit Root-Zugriff typischerweise auch die Keys finden.
3. Externe KMS/Control-Plane-Key-Verwaltung: verbessert Backup- und Secret-Schutz, schuetzt aber laufende App-Zugriffe nur begrenzt, wenn die App entschluesseln darf.
4. User-held oder Client-side Encryption: Admins koennen Rohdateien nicht lesen, aber Server-Preview, Search, Knowledge-Ingestion, Agent-Dateitools und Automations funktionieren nur, wenn der User die Daten aktiv entschluesselt oder dem Agenten zeitweise Zugriff gibt.

Empfehlung fuer V1:

- Dateien bleiben im Container-Dateisystem lesbar.
- App erzwingt strikte User-/Workspace-/Exportrechte.
- Admin-Full-Export ist erlaubt, aber explizit, auditiert und nicht mit normalem User-Export vermischt.
- Backups werden verschluesselt.
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
- Full Backup enthaelt Public Links und Secrets nur verschluesselt.
- Backup kann via Admin/API/CLI getriggert werden.
- Geplanter Backup-Job blockiert parallele Backup-Laeufe.
- Restore Preview erkennt Konflikte vor dem Schreiben.
