# Actor Context, Audit und Retention

Stand: 2026-06-17

## Zweck

Dieses Dokument konkretisiert eine Querschnittsregel fuer den Team-Workspace-Umbau: Jede Agent-, Tool-, Datei-, Gateway- und Studio-Aktion muss einem Actor und einem Scope zuordenbar sein, ohne die Datenbank durch vollstaendige Runtime-Logs, grosse Tool-Ausgaben oder Asset-Inhalte unkontrolliert wachsen zu lassen.

Diese Entscheidung ergaenzt die Aufgaben `29` Audit Trail, `30` Retention/Trash, `33` Agent-Dateiaenderungen und `35` Storage-Monitoring im Aufgabenindex.

## Grundsatz

Nachvollziehbarkeit wird ueber kleine, strukturierte Metadaten hergestellt. Grosse Inhalte bleiben ausserhalb der relationalen Datenbank.

Die Datenbank speichert dauerhaft:

- wer gehandelt hat,
- in welchem Organization-/Workspace-/Session-Kontext gehandelt wurde,
- welches Tool, Feature oder Gateway beteiligt war,
- welche fachliche Ressource betroffen war,
- welchen Status und welche Referenz das Ergebnis hat,
- Hashes, Groessen und Pfad-/Asset-Referenzen.

Die Datenbank speichert nicht dauerhaft:

- komplette Bild-/Video-/Audio-Dateien,
- Base64-Artefakte,
- grosse Tool-Inputs oder Tool-Outputs,
- komplette Datei-Inhalte,
- ausfuehrliche Debug-Streams,
- unbounded Chat- oder Runtime-Event-Duplikate.

## Actor Context

Jede serverseitige Ausfuehrung, die fachlich einem User oder Agenten zugeordnet werden kann, muss einen expliziten Actor Context erhalten.

Pflichtfelder:

- `organizationId`
- `workspaceId`
- `workspaceType`
- `userId`
- `sessionId`
- `agentId`
- `source`

Optionale Gateway-Felder:

- `gatewayType`
- `channelId`
- `channelUserId`
- `channelSessionKey`
- `channelThreadKey`

Optionale technische Felder:

- `requestId`
- `traceId`
- `toolCallId`
- `jobId`
- `runId`
- `secretRef`
- `secretScope`
- `toolStackRevision`

### Invarianten

- Ein Agent darf kein Tool ausfuehren, bevor der Actor Context aufgeloest ist.
- Der Actor Context eines Agent-Turns muss aus dem gespeicherten Session-Workspace kommen, nicht nur aus dem aktuellen Client-UI-State.
- File-Write-Events duerfen nur fuer den Workspace entstehen, der an der Session gespeichert ist; Cross-Workspace-Reads muessen als explizite Referenz auditiert werden.
- Ein Gateway darf keine Nachricht an die Agent Runtime weitergeben, bevor der externe Channel-User eindeutig auf einen internen `userId` gemappt wurde.
- Datei- und Workspace-Operationen muessen immer `workspaceId` und `userId` kennen.
- Team-Workspace-Schreibzugriffe muessen zusaetzlich Organization-Rolle oder Permission pruefen.
- Studio-Generierungen muessen mindestens `organizationId`, `createdByUserId`, `sessionId` und `agentId` speichern; `workspaceId` wird gespeichert, wenn die Generierung aus einem Workspace-Kontext entstand.
- Automations speichern den Owner am Job und den effektiven Actor Context am Run.
- Secret-, MCP-, Plugin- und Skill-Verwendung darf erst nach Context-Aufloesung passieren und speichert im Audit nur Ref/Scope/Provider, nie Secret-Werte.

## Audit Event Modell

Audit ist ein fachlicher Trail, kein Rohlog.

Empfohlenes Minimalmodell fuer `audit_events`:

- `id`
- `organizationId`
- `workspaceId`
- `userId`
- `sessionId`
- `agentId`
- `source`
- `eventType`
- `entityType`
- `entityId`
- `action`
- `status`
- `summary`
- `metadataJson`
- `inputHash`
- `outputHash`
- `artifactRef`
- `secretRef`
- `secretScope`
- `createdAt`

`metadataJson` muss klein bleiben. Es darf IDs, kurze Namen, Pfade, Hashes, Groessen, MIME Types, Fehlercodes, Secret-Refs und Policy-Entscheidungen enthalten. Es darf keine grossen Payloads, Secrets, OAuth Tokens, API Keys oder vollstaendigen Outputs enthalten.

## Tool Run Modell

Tool-Ausfuehrungen brauchen eine eigene technische Tabelle oder eine spezialisierte Audit-Event-Kategorie.

Empfohlenes Minimalmodell fuer `agent_tool_runs`:

- `id`
- `organizationId`
- `workspaceId`
- `userId`
- `sessionId`
- `agentId`
- `toolCallId`
- `toolName`
- `status`
- `startedAt`
- `finishedAt`
- `inputSummary`
- `outputSummary`
- `inputHash`
- `outputHash`
- `rawInputRef`
- `rawOutputRef`
- `errorCode`
- `secretRefsJson`

`rawInputRef` und `rawOutputRef` duerfen nur auf kurzlebige Debug-Artefakte zeigen. Wenn keine Debug-Retention aktiv ist, bleiben diese Felder leer.
`secretRefsJson` darf nur Secret-Refs, Scope, Provider und Zugriffszweck enthalten, niemals Secret-Werte.

## Datei- und Revisionsmodell

Dateiaenderungen werden ueber kleine Events und optionale Revisionen nachverfolgt.

Pflichtmetadaten fuer Datei-Events:

- `organizationId`
- `workspaceId`
- `userId`
- `sessionId`
- `agentId`
- `action`
- `path`
- `beforeHash`
- `afterHash`
- `sizeBytes`
- `revisionId`

Grosse Datei-Inhalte bleiben im Workspace-Dateisystem oder spaeter in Object Storage. Die DB speichert nur Revision-Metadaten, Hashes und Referenzen.

## Retention Defaults

Die konkreten Werte muessen spaeter plan- und deployment-abhaengig konfigurierbar sein. Fuer V1 gelten diese Default-Ziele:

| Datenklasse | Default | Grund |
|---|---:|---|
| Runtime Debug Events | 7 Tage | Nur Fehlersuche, nicht fachlicher Verlauf. |
| Raw Tool Inputs/Outputs | 30 Tage | Debugging mit begrenztem Risiko und Speicherverbrauch. |
| Agent Tool Run Summaries | 180 Tage | Nachvollziehbarkeit ohne grosse Payloads. |
| Audit Events | 365 Tage | Team-Governance und Verantwortlichkeit. |
| Trash/File Revisions | 30 Tage | Wiederherstellung nach Fehlern, begrenztes Wachstum. |
| Studio Temp Uploads | 14 Tage | Kurzlebige Inputs bereinigen. |
| Studio Assets | planabhaengig | Produktdaten, nicht automatisch kurzlebig. |
| Daily Usage Rollups | 24 Monate | Abrechnung, Kostenanalyse und Trends. |
| Einzelne Usage Events | 90 Tage | Danach Rollup ausreichend. |
| Backups | rotierend | Separat in Backup-Policy definieren. |

## Aggregation und Cleanup

Unbounded Tabellen muessen von Anfang an Cleanup- oder Rollup-Strategien haben.

Erforderliche Jobs:

- Usage Rollup: Einzelereignisse in Tageswerte pro Organization/User/Workspace/Agent/Provider aggregieren.
- Runtime Cleanup: Debug-Events und Raw Tool Payloads nach Retention entfernen.
- Trash Cleanup: abgelaufene Trash-/Revisionseintraege entfernen oder archivieren.
- Studio Temp Cleanup: nicht referenzierte Uploads und temporaere Outputs entfernen.
- Audit Compaction: optional technische Detailfelder reduzieren, Audit-Kern erhalten.
- Backup Prune: alte Backups nach Policy entfernen.

SQLite-spezifisch muessen Cleanup-Jobs auch WAL-/Checkpoint- und Datei-Groessen beruecksichtigen. Nach groesseren Loeschungen braucht es eine geplante Maintenance-Strategie, z. B. Checkpoint und kontrolliertes Vacuum ausserhalb kritischer Nutzungszeiten.

## Storage Monitoring

Das Control Plane muss Speicher nicht nur als Host-Disk-Metrik sehen. Fuer Team-Instanzen sollen mindestens diese Werte gemeldet werden:

- Datenbankgroesse,
- WAL-/Journalgroesse,
- Workspace-Dateien gesamt,
- Team Workspace Groesse,
- Personal Workspaces Groesse,
- Studio Assets,
- temporaere Uploads,
- Backups,
- Logs/Runtime-Artefakte,
- freier Host-Speicher.

Warnungen:

- `storage_warning`: Schreibzugriffe bleiben erlaubt, Admins werden informiert.
- `storage_critical`: riskante grosse Schreibaktionen, Backups, Imports und Studio-Generierungen duerfen blockiert oder nur mit Admin-Bestaetigung fortgesetzt werden.

## Umsetzungsgates

Vor breiter Audit-Implementierung muessen diese Grundlagen stehen:

1. Actor Context Resolver fuer Web, Agent Runtime, Automations und Gateways.
2. Kleines Audit-/Tool-Run-Schema mit Retention-Feldern.
3. File-Event-/Revision-Metadaten ohne grosse Inhalte in der DB.
4. Cleanup-/Rollup-Jobs als Teil der ersten Audit-Migration.
5. Storage-Metriken fuer DB, Workspace, Studio, Temp und Backups.
6. Secret-/Runtime-Resolver, damit Tool-Audit keine globalen Instanz-Credentials protokolliert.

Ohne diese Gates darf kein vollstaendiger Tool-/File-Audit breit ausgerollt werden, weil sonst Datenbank- und Storage-Wachstum nicht kontrolliert sind.
