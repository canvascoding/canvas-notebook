# File Version & Review Center: Contract-Inventar

Stand: 2026-09-14

Status: verbindliche Baseline fuer `FVRC-000`

Dieses Inventar fixiert den Ist-Zustand vor der Implementierung. Es ist keine
neue Persistenz- oder API-Implementierung. Spaetere Pakete duerfen die hier
beschriebenen autoritativen Zustaende und Sicherheitsgrenzen nur mit einer
expliziten Contract-Migration veraendern.

## 1. Autoritative Zustaende

| Dateiklasse / Ablauf | Autoritativer aktueller Zustand | Projektion / Ledger | Zulässige dauerhafte Capture-Grenze |
|---|---|---|---|
| Kollaboratives Markdown, `.markdown`, `.txt` | Persistierter Yjs-Zustand samt `stateVector`, Dokument-, Checkpoint- und Lifecycle-Sequenz | Workspace-Datei ist eine verifizierte Projektion; `file_revisions` ist das Metadaten-Ledger | Erst aus einem validierten `AuthoritativeCollaborationSnapshot`, nachdem die passende Yjs-Sequenz persistiert ist. Die Content-Bindung darf erst sichtbar werden, wenn Blob und Revision atomar verbunden sind. |
| Noch nicht kollaborativ geoeffnetes Markdown/Text | Aktuelle Workspace-Datei | Eine beim Lesen oder Schreiben erzeugte `file_revision` kann eine Baseline markieren | Inhalt nach erfolgreichem, revisionsgesichertem Datei-Read/-Write erfassen; ein Read darf keine vermeintliche Nutzer-Version erzeugen, sondern nur eine als `initial` gekennzeichnete Baseline. |
| `revision_check` Text/Code | Aktuelle Workspace-Datei mit Hash-/Revision-Fence | `file_revisions` beschreibt Hash, Groesse, Actor und Basisrevision | Nach erfolgreichem atomaren Datei-Write und erneuter Hash-Pruefung. Niemals vor dem Write oder allein aus dem Request-Payload. |
| Agentenvorschlag fuer Yjs-Text | Persistierter Vorschlag in `collaboration_agent_operations`; aktuelles Dokument bleibt der aktive Yjs-Zustand | Review-Ziele und `proposalVersion` sind eine Kandidatenbeschreibung, keine historische Version | Vor Annahme kein History-Capture als aktuelle Version. Nach Accept/Direct-Apply erst nach `persisted_yjs`, fuer eine file-facing Version nach bestaetigtem Checkpoint. |
| Direkt angewendeter Agentenedit | Zunaechst der unter Grant und Room-Fence mutierte Yjs-Zustand; nach Persistenz der gespeicherte Yjs-Zustand | Operation durchlaeuft `applied_to_ydoc`, `persisted_yjs`, `checkpointed_file` | History-Eintrag erst nach durable Yjs acknowledgement; als vollstaendig projizierte Version nach Checkpoint. Stale lifecycle, degraded persistence und fehlender Grant erzwingen Review. |
| Excalidraw | Persistierter Excalidraw-Kollaborationszustand | Datei und `file_revision` sind Checkpoint/Projektion | Nur am bestehenden Excalidraw-Checkpoint nach erfolgreicher Materialisierung; kein Text-Diff in V1. |
| Office / exklusiver Lock | Publizierte Workspace-Dateibytes und Office-Journal/Commit-Identitaet | `file_revisions` und Office-Version-Journal | Nur nach erfolgreichem Lease-/Journal-Commit und Publikation. Ein eigener Office-Adapter bleibt spaeter erforderlich. |
| Binaerdatei | Aktuelle Workspace-Dateibytes | `file_revisions` ist Metadaten-Ledger | V1 erfasst keinen vergleichbaren Inhalt. Spaeter nur nach erfolgreichem atomaren Write, mit Metadaten-Capability. |
| Gast-Markdown-Historie | Aktueller persistierter Kollaborationszustand | `file_guest_versions` speichert bereits begrenzte Inhalts-Snapshots fuer den Gast-Flow | Bestehenden Guest-Capture nicht parallel als zweite allgemeine Wahrheit ausbauen. Eine Migration muss Inhalte explizit in das gemeinsame History-Modell ueberfuehren. |
| Agenten-Datei-Snapshot | Snapshot-Datei und Metadaten im Agent-Cache | Kurzlebige Recovery-/Rollback-Hilfe | Kein dauerhafter Versionsvertrag. Darf nicht als Ersatz fuer die neue immutable History verwendet werden. |

## 2. Bestehende Revisions- und Capture-Pfade

### 2.1 Breiter Metadaten-Hub

`ensureFileRevisionForCurrentContent` normalisiert den Workspace-Pfad, sperrt
den Pfad im PostgreSQL-Transaktionskontext, stellt eine aktive Lineage sicher
und fuegt bei geaendertem Hash/Groesse eine `file_revision` an. Bei identischem
Hash und identischer Groesse wird die letzte Revision wiederverwendet. Der
Contract speichert **keinen Inhalt**.

Direkte Produktionsaufrufe bestehen heute aus:

- Yjs- und Excalidraw-Checkpoints,
- normalem Datei-Write und Workspace-Upload,
- Datei-Create und baseline-erzeugendem Datei-Read,
- Agenten-Text-, Binaer- und Office-Dateioperationen,
- Mobile Notebook und Mobile Excalidraw,
- Office-Publikation und Recovery,
- direkten MCP-Workspace-/Knowledge-Source-Operationen.

Folgerung: Dieser Hub ist nicht die globale FVRC-Capture-API. Er kennt weder den
autoritativen Content-Provider noch Capture-Quelle, Retention, vollstaendige
Idempotenz, Blob-Commit oder die fachliche Sichtbarkeit einer Version.

### 2.2 Yjs-Checkpoint

`authoritativeCollaborationSnapshot` rekonstruiert den kanonischen Text
ausschliesslich aus dem persistierten Yjs-Update. Es validiert den State Vector
und bei Rich Markdown zusaetzlich die Dokumentstruktur. Der Checkpoint-Flow
schreibt die kanonische Projektion, bestaetigt den Dateihash als Revision und
verschiebt anschliessend den Dokument-Checkpoint auf genau diese Revision.

Der spaetere Capture-Hook gehoert als schmale, idempotente Aktion in den
Checkpoint-/Durability-Orchestrator. Er darf nicht eine zweite Textquelle vom
Aufrufer akzeptieren.

### 2.3 Normale Datei- und Upload-Writes

`writeWorkspaceFileContentUnlocked` und der Workspace-Upload-Flow validieren
die bestehende Revision/Lock-Policy und schreiben erst danach die Datei. Fuer
`revision_check`-Dateien ist der bestaetigte Inhalt nach dem Write die
Capture-Quelle. Kollaborative Whole-File-Writes bleiben durch die bestehende
Policy blockiert beziehungsweise werden ueber den passenden Adapter geleitet.

Create und Read koennen heute eine fehlende Revisions-Baseline herstellen. Das
ist wichtig fuer Identitaet und Konfliktpruefung, darf aber nicht als bewusste
Nutzer- oder Agenten-Version dargestellt werden.

### 2.4 Agentenoperationen

`applyPersistedAgentTextOperation` bindet die Operation an Nutzer, Agent,
Session, Workspace, Dokument, Lifecycle-Generation, Schema und State Vector.
`applyStoredOperation` faellt bei veraltetem Lifecycle, degradiertem Zustand,
State-Vector-Konflikt oder ungueltiger Vorschau auf `needs_review` zurueck.

Accept, Reject und Revert besitzen bereits autorisierte, idempotente
Aktionspfade. FVRC ruft diese Orchestrierung auf; es dupliziert weder deren
Mutationslogik noch lockert es `actionsAllowed`, `proposalVersion` oder
Lifecycle-Fences.

Die bestehende Direct-Edit-Freigabe ist maximal 30 Minuten gueltig und an
`userId + workspaceId + agentId + actorSessionId + documentId +
lifecycleGeneration` gebunden. Die spaetere dauerhafte Dokumentpraeferenz ist
nur Policy-Input. Sie ersetzt niemals den kurzlebigen Grant am Apply-Boundary.

### 2.5 Guest- und Agenten-Snapshots

`recordFileGuestVersion` schreibt bereits Inhalts-Snapshots, ist aber auf den
Gastzugriff zugeschnitten und zeitlich/anzahlmaessig begrenzt. Die Agenten-
Snapshots unter `agent-file-operations` sind Recovery-Caches. Beide werden im
FVRC nicht still als allgemeine Versionshistorie umetikettiert.

## 3. Geplante schmale Capture-Seams

| Seam | Verantwortlichkeit | Nicht erlaubt |
|---|---|---|
| `version-history-service` | Fachlich entscheiden, ob und mit welcher Quelle eine Version sichtbar wird | Direktzugriff aus UI-Komponenten; Auth- oder Restore-Regeln verstecken |
| `version-content-store` | Immutable Blob-Mechanik, Deduplizierung, Kompression und Groessenpruefung | Workspace-/Nutzerpolitik oder Timeline-Reihenfolge entscheiden |
| Yjs Durability/Checkpoint Orchestrator | Den bereits validierten kanonischen Snapshot plus genaue Sequenz uebergeben | Beliebigen Request-Text als autoritativ annehmen |
| `revision_check` Write-Orchestrator | Nach atomarem Write Inhalt, Hash und neue Revision binden | Capture vor dem Write oder ohne aktuellen Fence |
| Agenten-Operation/Change-Group Orchestrator | Tool-Aufruf, Operation und erzeugte Revision idempotent verbinden | Operationsergebnis als Dokumentinhalt im Chat speichern |
| Restore-Orchestrator | Auth, Capability, erwarteten aktuellen Stand, Pre-Restore-Capture und Adapter koordinieren | Alte Revision in-place ueberschreiben oder Ledger-Eintraege loeschen |

Die Mechanik wird in kleine Capability-Bloecke aufgeteilt. Domain-Aktionen
behalten Auth, Policy, Statuswechsel, Idempotenz und nutzerlesbare Fehler. Ein
neuer allwissender `VersionService` ist nicht vorgesehen.

## 4. Einheitliche Aufrufmatrix

| Einstieg | Verfuegbarkeit | Request-Ziel | Startansicht / Auswahl | Mutationsrecht |
|---|---|---|---|---|
| Editor Agenten-Button | Sobald Agentenaktivitaet vorliegt | bevorzugt `documentId`, zusaetzlich `workspaceId` | `reviews`, neueste offene `agent_operation` | Bestehende `actionsAllowed`- und API-Pruefung |
| Editor History-Button | Nur bei serverseitig bestaetigter Capability | `lineageId` oder `documentId` | `history`, aktueller Stand | Lesen; Restore separat autorisiert |
| Editor Review-Toggle | Nur bei `agentReviewPolicy: true` | `workspaceId + lineageId` | aktuelle effektive Policy | CAS-Write fuer aktuellen Nutzer; fail-closed |
| Dateibrowser-Kontextmenue | Genau eine Datei und serverseitige Capability | `lineageId`, sonst aufloesbarer `pathHint` | `history`, aktueller Stand | Keine implizite Schreibfreigabe |
| Chat Built-in Tool App | Nur persistierte, autorisierbare Change Group | `changeGroupId`, optional selektierter Eintrag | `reviews` bei Handlungsbedarf, sonst `history` | Widget enthaelt keine Freigabetokens; Server prueft neu |
| Deep-Link | Reload-/Navigations-Fallback | Versionierter serialisierter Request ohne Inhalt | wie kodiert, nach Aufloesung | Jede ID ist untrusted; aktueller Zugriff entscheidet |
| Notification, spaeter | Nur Review/Konflikt/fehlgeschlagene Direktanwendung | `workspaceId + operationId` beziehungsweise Change Group | exakte Review-Auswahl | Beim Oeffnen neu autorisieren; kein Content im Item |

Alle Einstiege verwenden spaeter denselben versionierten Open-Contract und den
einmal global montierten Host. Kein Einstieg laedt, vergleicht oder restauriert
Dateiinhalte selbst.

## 5. Bestehende Routen, die wiederverwendet werden

- `GET /api/files/collaboration/operations` und der Einzeloperation-Read
  liefern die bestehende Agentenaktivitaet.
- `POST .../[operationId]/accept`, `/reject`, `/revert` und `/cancel` bleiben
  die autoritativen Agentenaktionen.
- `POST .../[operationId]/direct-edit-grant` bleibt die kurzlebige
  Direct-Edit-Autorisierung waehrend der Migration.
- `POST /api/chat/tool-apps` ist der bestehende autorisierte Built-in-Widget-
  Resolver. Eine Change Group wird als neuer App-Typ integriert, nicht als
  unvalidierter Payload-Sonderweg.
- Die normalen Datei-Read/-Write-Routen bleiben fuer aktuelle Dateiinhalte
  bestehen, werden aber nicht als History- oder Restore-API missbraucht.

Neue FVRC-Routen muessen unter einem versionierten Contract arbeiten,
`private, no-store` antworten und Workspace, Nutzer, Lineage/Lifecycle sowie
Capabilities bei jedem Zugriff serverseitig aufloesen.

## 6. Blast-Radius fuer spaetere Pakete

GitNexus wurde im dedizierten Worktree gegen Commit `a2ae6c99` neu analysiert.
Die Impact-Pruefung verwendet `direction: upstream`, Tiefe 3 und mindestens
0,8 Confidence.

| Symbol | Risiko | Betroffen / direkt | Prozesse / Module | Konsequenz |
|---|---:|---:|---:|---|
| `ensureFileRevisionForCurrentContent` | CRITICAL | 53 / 19 | 6 / 8 | Contract nicht erweitern; separaten Capture-Service an schmalen Orchestrierungsgrenzen anbinden |
| `applyPersistedAgentTextOperation` | HIGH | 21 / 8 | 2 / 3 | Policy- und Change-Group-Integration adapterweise, mit kompletter Agenten-Durability-Suite |
| `resolveAgentDirectEditGrant` | HIGH | 18 / 3 | 0 / 3 | Kurzlebigen Grant beibehalten; dauerhafte Policy davor aufloesen |
| `readBuiltinToolAppDescriptor` | CRITICAL | 24 / 4 | 0 / 6 | Neuen Descriptor additiv/versioniert einfuehren; bestehende App-Typen unveraendert lassen |
| `documentCapabilities` | CRITICAL | 9 / 5 | 2 / 5 | FVRC-Capabilities serverseitig in eigenem Modul aufbauen, nicht den Client-Helper umdeuten |
| `FileActionsDropdown` | HIGH | 7 / 2 | 2 / 4 | Nur Open-Intent injizieren; keine History-/Diff-Logik in die Komponente |
| `CollaborationAgentOperations` | HIGH | 5 / 1 | 2 / 4 | Bestehendes Popover erst nach globalem Center migrieren; keine parallele Actions-Implementierung |
| `NotificationBell` | CRITICAL | 25 / 5 | 2 / 8 | Deferred; neuen Target-Typ additiv und ueber globalen Opener behandeln |
| `writeCollaborationCheckpointFile` | LOW | 3 / 2 | 0 / 1 | Bevorzugter schmaler Integrationsbereich nach gesondertem Impact der konkreten Aenderung |
| `acceptAgentOperation` | LOW | 5 / 3 | 0 / 1 | Bestehende Aktion wiederverwenden |
| `rejectAgentOperation` | LOW | 4 / 3 | 0 / 1 | Bestehende Aktion wiederverwenden |
| `revertAgentOperation` | MEDIUM | 10 / 6 | 0 / 1 | Wiederverwenden; Restore bleibt fachlich getrennt |
| `BuiltinToolAppActions` | LOW | 3 / 1 | 0 / 2 | Additive Darstellung fuer Change Groups |
| `writeAgentTextFile` | LOW | 1 / 1 | 1 / 1 | Change-Group-Ergebnis erst nach bestaetigter Aenderung ergaenzen |
| `editAgentFile` | LOW | 0 / 0 | 0 / 0 | Tool-Result-Adapter bevorzugen; internen Ablauf nicht fuer UI-Anforderungen verzerren |
| `applyAgentFilePatch` | LOW | 0 / 0 | 0 / 0 | Batch-Reihenfolge ueber Change Group fixieren |

Die gelesenen Ausfuehrungstraces `EditAgentFile -> GetRuntimeCwd` und
`ApplyAgentFilePatch -> GetRuntimeCwd` bestaetigen, dass Tool-Aufrufe ihre
Workspace-Pfade ueber den Agenten-Runtime-Kontext aufloesen. Persistierte
FVRC-Referenzen verwenden trotzdem niemals absolute Runtime-Pfade.

## 7. Verbindliche Nicht-Ziele dieser Baseline

- Keine neue Tabelle oder Migration.
- Kein History-Capture aus bestehenden Schreibpfaden.
- Kein UI-Host oder Dialog.
- Keine Aenderung an Accept/Reject/Revert oder Direct-Edit-Grants.
- Keine Vermischung von Guest-Historie, Agenten-Snapshot-Cache und allgemeiner
  Workspace-Historie.
- Keine Playwright-, Chrome- oder Containerausfuehrung.

## 8. Gate fuer `FVRC-001`

`FVRC-001` darf beginnen, wenn dieses Inventar gegen `plan.md` geprueft ist,
alle spaeteren Einstiege auf einen gemeinsamen versionierten Open-Contract
verweisen und die CRITICAL/HIGH-Seams nicht durch Runtime-Aenderungen in P00
beruehrt werden.
