---
title: 'Umsetzungsplan zu Ticket 10: Automationen, UI und Workspace-Zuordnung'
status: planned
date: 2026-08-21
platforms: [web, mobile-api, server, agent-runtime]
tags: [type/implementation-plan, topic/automations, topic/workspaces, topic/ownership]
---

# Umsetzungsplan: Automationen, UI und Workspace-Zuordnung

## Ziel und Arbeitsmodus

Dieser Plan konkretisiert [Ticket 10](./10-automationen-ui-und-workspace-zuordnung-pruefen.md)
auf Basis des aktuellen Codebestands. Er beschreibt keine bereits erfolgte
Implementierung. Die spaetere Umsetzung erfolgt strikt sequenziell: Eine Phase
beginnt erst, wenn die vorherige Phase implementiert, mit den fuer sie
definierten Tests verifiziert und als eigener fokussierter Commit abgeschlossen
ist.

Die zentrale Zielarchitektur lautet:

- Ein serverseitiger Automation-Action-Service entscheidet fuer jede Lese- und
  Schreiboperation ueber Actor, Organization, Workspace und erlaubte Aktion.
- REST-, Mobile-, Composio-, Scheduler-, Webhook- und Agent-Tool-Adapter duerfen
  diese Entscheidung nicht nachbilden oder umgehen.
- Der Persistenz-Layer speichert eindeutige Scope-Daten und fuehrt keine
  unautorisierten ID-basierten Mutationen aus.
- Ein Run besitzt einen unveraenderlichen Scope- und Actor-Snapshot. Aktuelle
  Job-Berechtigung und historischer Run-Scope werden beim Zugriff getrennt
  geprueft.
- Client- und Toolargumente duerfen weder Owner, Organization noch effektiven
  Workspace frei bestimmen.

Nicht Bestandteil dieses Tickets sind neue Automationstypen, ein Redesign des
gesamten Agent-Chats, Control-Plane-Aenderungen oder Container-/Deployment-
Arbeiten. Browser- und Playwright-Pruefungen erfolgen auch in der spaeteren
Umsetzung erst nach ausdruecklicher Freigabe.

## Verbindliche Architekturquellen

Die Implementierung muss folgende bereits dokumentierte Regeln gemeinsam
erfuellen:

- `docs/architecture/canvas-notebook/team-workspace/11-automation-execution-model.md`
  definiert einen primaeren Workspace pro Job, Personal-/Organization-Actor,
  Run-Snapshots, Webhook-Haertung und das Verbot von Meta-Automationen.
- `docs/architecture/canvas-notebook/team-workspace/10-agent-tool-execution-policy.md`
  verlangt einen serverseitig erzeugten, vor Toolausfuehrung erneut
  validierten `AgentExecutionContext`.
- `docs/architecture/canvas-notebook/team-workspace/03-scope-matrix.md`
  ordnet Automation, Run und Webhook einem exakten Workspace und Actor zu.
- `docs/architecture/canvas-notebook/team-workspace/05-actor-audit-retention.md`
  definiert Actor-, Approval-, Trigger-, Retry- und Audit-Metadaten.
- `docs/architecture/canvas-notebook/team-workspace/16-offboarding-and-recovery-policy.md`
  regelt Pausierung und Uebergabe bei Offboarding.
- `docs/architecture/canvas-notebook/team-workspace/23-composio-user-workspace-profiles.md`
  bindet einen Lauf ohne Fallback an
  `responsibleUserId + workspaceId + effectiveProfile`.

Bei einer Abweichung zwischen Code und diesen Dokumenten ist die konservativere
Scope- und Actor-Regel der sichere Default. Eine bewusst abweichende
Produktentscheidung muss vor der entsprechenden Implementierungsphase in den
Architekturdokumenten festgehalten werden.

## Inventur des bestehenden Stands

### Oberflaeche und API-Adapter

- `app/apps/automations/components/AutomationsClient.tsx`
  - laedt einmalig die vollstaendige fuer den Nutzer sichtbare Jobliste;
  - filtert nur clientseitig nach Suche und den Sammelzustaenden `active`,
    `paused`, `running` und `attention`;
  - sortiert clientseitig nach Name, letztem oder naechstem Lauf;
  - besitzt keinen Workspace-, Owner-, Scope- oder Typfilter und keine
    Pagination;
  - zeigt Workspace und Status pro Karte, aber keinen eindeutigen
    Owner/Responsible-User und keinen permanent sichtbaren aktiven Listenscope;
  - zeigt in der Detailansicht nur die ersten zehn der geladenen Runs.
- `app/[locale]/(routes)/automations/page.tsx` und `[jobId]/page.tsx` sind
  schlanke Session-/UI-Einstiege; die fachliche Autorisierung liegt in den
  API-Routen.
- `app/api/automations/**` deckt Job-CRUD, Workspace-Wechsel, Run-now, Runs,
  Logs, Custom Webhooks, Scheduler und interne Ausfuehrung ab.
- `app/api/mobile/v1/automations/**` exportiert ueberwiegend dieselben Handler.
  Das ist eine gute Paritaetsbasis, ersetzt aber keine Vertragstests fuer
  Filter, Fehlercodes und Scope-Isolation.
- `app/api/composio/triggers/**` sowie die Composio-Webhook-Routen sind weitere
  Create-/Update-/Delete-/Run-Einstiege und muessen in dieselbe Action-Grenze
  einbezogen werden.

### Datenmodell und Persistenz

- `app/lib/automations/types.ts` fuehrt bereits `scope`, `jobScope`,
  `organizationId`, `workspaceId`, `workspaceType`, `ownerUserId`,
  `responsibleUserId`, `serviceActorId`, Approval-Metadaten und entsprechende
  Run-Snapshots.
- In `app/lib/db/schema.ts` sind die entscheidenden Job-Felder weiterhin
  nullable. Die Datenbank verhindert daher weder einen Personal-Job ohne Owner
  oder Workspace noch einen Organization-Job ohne Organization, Responsible
  User oder Service Actor.
- `app/lib/db/migrate.ts` backfillt Legacy-Owner und Scope-Felder, weist aber
  Jobs ohne eindeutigen Workspace nicht deterministisch zu und quarantaenisiert
  widerspruechliche Datensaetze nicht. Die Migration kann ausserdem
  `ownerUserId` auch fuer Organization-Zeilen aus `createdByUserId` ableiten,
  obwohl das Zielmodell dort einen Service Actor und Responsible User vorsieht.
- `app/lib/db/postgres.ts` besitzt einen eigenen PostgreSQL-DDL-Pfad, der bei
  Automation-Aenderungen zusammen mit dem SQLite-Pfad und den Drizzle-Typen
  aktualisiert und auf Paritaet getestet werden muss.
- `app/lib/automations/store.ts` filtert die Jobliste nach Personal-Owner oder
  Organization und fuehrt anschliessend eine weitere Policypruefung pro Zeile
  aus. Es fehlen serverseitige Filter, Cursor, Total-/Facet-Metadaten und eine
  begrenzte Ergebnismenge.
- Runs speichern Scope-, Workspace- und Actor-Snapshots. Die Run- und
  Log-Routen autorisieren den Zugriff jedoch ueber den aktuell geladenen Job.
  Nach einem Scope- oder Workspace-Wechsel kann damit historischer Inhalt unter
  dem neuen Job-Scope sichtbar werden.
- Job-Loeschung entfernt Runs, Webhook-Ereignisse und Trigger hart. Die
  technische Run-Historie und Audit-Nachweise koennen dadurch auseinanderfallen.

### Policy, Actions und Ausfuehrung

- `app/lib/automations/policy.ts` loest den Create-Scope serverseitig auf und
  prueft Lese-/Schreib-/Run-Rechte am Workspace. Das verhindert bereits, dass
  ein einfacher Create-Request den Owner frei setzt.
- `canAccessAutomationJob` ist jedoch eine breite Zugriffsaussage. View,
  Update, Move, Run, Secret-Rotation und Delete werden nicht als getrennte
  Aktionen modelliert.
- Organization-Lesen und -Mutieren sind derzeit an
  `canCreateTeamAutomations` gekoppelt. Das Ausfuehrungsmodell nennt fuer
  Organization-Automationen dagegen Owner/Admin. Diese Rollen-/Permission-
  Abweichung muss vor Aktivierung der neuen Policy explizit entschieden werden.
- Routen, Composio-Adapter und `app/lib/pi/scoped-tools.ts` rufen Store- und
  Policyfunktionen in unterschiedlicher Reihenfolge auf. Fuer Audit, stabile
  Fehlercodes und Revalidierung existiert keine gemeinsame Action-Grenze.
- `scheduleAutomationJobRun` nimmt eine Job-ID an und erzeugt einen Run, ohne
  selbst Jobstatus, aktuelle Scope-Invarianten oder den Actor des Aufrufers zu
  validieren. Die einzelnen Aufrufer besitzen unterschiedliche Vorpruefungen.
- `app/lib/automations/runner.ts` validiert den Workspace vor der Ausfuehrung,
  vergleicht den gespeicherten Run-Snapshot aber nicht vollstaendig mit einer
  frisch geladenen, versionierten Jobdefinition. Pause, Edit, Offboarding oder
  Scope-Aenderung zwischen Queue und Start sind deshalb nicht als einheitliche
  Policyentscheidung modelliert.
- Der normale Automation-Runner baut den regulaeren Toolumfang auf. Nur der
  Email-Event-Sonderpfad entfernt `automation_manage`. Damit koennen andere
  Automationslaeufe derzeit Automation-Create/-Update/-Delete/-Trigger-Tools
  erhalten; das verletzt das dokumentierte Verbot von Meta-Automationen.
- Der aktuelle `AgentExecutionContext` enthaelt User, Session, Agent,
  Organization und Workspace, aber keine belastbare Quelle wie
  `source: automation`, `automationId`, `runId`, `jobRevision` oder eine
  korrelierbare Execution-ID.

### Scheduler, Webhooks, Runs und Logs

- Scheduler-Routen sind durch ein internes Token geschuetzt und waehlen nur
  aktive faellige Jobs. Queue und Execute besitzen danach aber keine gemeinsame
  Action mit Run-now und Webhooks.
- Custom Webhooks verwenden gehashte Secrets, Body-Limits, Idempotency und ein
  Rate Limit pro IP/Webhook. Es fehlen die im Ausfuehrungsmodell geforderten
  Timestamp-/Nonce-Replayfenster, eine typisierte Payload-Schemafreigabe sowie
  Limits auf Organization-/User-Ebene.
- Ein gueltiger anonymer Webhook kann derzeit einen normalen, grundsaetzlich
  schreibfaehigen Agentlauf ausloesen. Das widerspricht der V1-Regel, nach der
  anonyme Public Webhooks keinen write-capable Agent Turn starten duerfen.
- Composio Webhooks besitzen providerbezogene Verifikation und Profilbindung,
  muessen aber fuer Queue, Scope-Snapshot, Pausierung und Audit dieselbe
  gemeinsame Run-Action verwenden.
- Der Log-Endpunkt liefert gespeicherte Run-/Logdaten einschliesslich
  technischer Pfadinformationen. Interne Dateipfade gehoeren nicht in den
  externen Vertrag; Events muessen begrenzt, redigiert und retention-konform
  ausgeliefert werden.

### Bestehende Tests

- `scripts/automation-workspace-scope-test.ts` prueft Personal-/Organization-
  Erstellung, Workspace-Isolation, Moves und Run-Snapshots auf Store-Ebene.
- `scripts/automation-custom-webhook-test.ts` prueft Secret-Hashing, Rotation,
  Deduplizierung und pausierte Jobs, aber nicht den vollstaendigen HTTP-,
  Replay-, Schema- und Organization-Scope.
- `scripts/automation-runner-tool-context-test.ts` prueft Runtime-Kontext,
  Retry und Delivery. Der Test bestaetigt aktuell fuer regulaere Automationen
  den breiten Toolumfang und muss auf die Meta-Automationssperre umgestellt
  werden.
- `scripts/pi-tool-registry-test.ts` prueft Tool-CRUD und Cross-User-Isolation,
  aber keine Aktionsmatrix, Organization-Rollen, Auditparitaet oder zwingenden
  Automation-Source-Kontext.
- `scripts/mobile-automations-test.ts` prueft Alias- und Capability-Paritaet,
  nicht den neuen Listen- und Fehlervertrag.
- `scripts/db-migration-legacy-test.ts` deckt Legacy-Spalten und Basis-
  Backfills ab, aber keine widerspruechlichen oder nicht eindeutig
  zuordenbaren Automation-Daten.
- `tests/automationen.spec.ts` prueft Auth und einen Admin-Happy-Path. Multi-
  User-, Scope-, Filter-, Run-/Log- und Manipulationsfaelle fehlen.
- Schedule-, Delivery-, Timeout-, Session-Message-, Offboarding- und Composio-
  Tests existieren und sind als Regressionen weiterzuverwenden.

## Belegte Fehlerursachen und offene Verifikationen

| Einstufung | Befund | Konsequenz |
| --- | --- | --- |
| Belegt | `listAutomationJobs(userId)` besitzt keinen Filter-/Cursorvertrag; die UI filtert nur den bereits geladenen Teil lokal. | Filter, Sortierung und Scopeanzeige koennen fuer grosse Datenmengen nicht korrekt oder stabil sein. |
| Belegt | Workspace, Owner, Scope und Typ sind keine vollstaendigen Listenfilter; Owner/Responsible fehlt auf Karten und Details. | Der Zielzustand des Tickets ist in der UI nicht erreicht. |
| Belegt | UI, REST, Composio und Agent-Tools kombinieren Policy und Store jeweils selbst. | Mutationen, Fehlercodes, Audit und Revalidierung koennen auseinanderlaufen. |
| Belegt | Regulaere Automation-Runs koennen `automation_manage` erhalten. | Ein Lauf kann entgegen der Architektur Meta-Automationen anlegen oder veraendern. |
| Belegt | Historische Runs werden ueber den aktuellen Job statt zusaetzlich ueber den Run-Snapshot autorisiert. | Ein spaeterer Job-Move kann den Lesescope alter Run-/Logdaten verschieben. |
| Belegt | Queue-Erzeugung validiert nicht zentral Status, Scope, Actor und Jobrevision. | Run-now, Scheduler und Webhook haben unterschiedliche Sicherheitsgrenzen. |
| Belegt | Job-Scope-Felder sind nullable; das Legacy-Backfill hat keine Quarantaene fuer mehrdeutige Zuordnungen. | Widerspruechliche Daten koennen bis in Liste, Runner und Tool-Calls gelangen. |
| Belegt | Custom Webhooks fehlen Replayfenster, Payload-Allowlist und gestaffelte Limits. | Gestohlene oder wiederholte Requests koennen uebermaessig bzw. mit unkontrollierten Eingaben laufen. |
| Belegt | Listen-Gruppen werden nicht disjunkt berechnet. Ein Webhook kann etwa gleichzeitig als Integration und Running/Attention erscheinen. | Anzahl und sichtbare Karten koennen nicht konsistent sein. |
| Zu verifizieren | Anzahl und konkrete Formen inkonsistenter Legacy-Jobs in SQLite und PostgreSQL. | Erst ein read-only Integrity-Report bestimmt Backfill- oder Quarantaeneumfang. |
| Zu verifizieren | Ob delegierte Mitglieder Organization-Automationen verwalten duerfen oder strikt Owner/Admin gelten soll. | Die Rollenentscheidung bestimmt Policy- und Ownerfilter; Default bleibt Owner/Admin. |
| Zu verifizieren | Welche historischen Run-/Logfelder sensible Prompts, Dateipfade oder Fremdscope-Daten enthalten. | Redaction, Retention und Migrationsbedarf muessen anhand produktionsnaher Fixtures festgelegt werden. |
| Zu verifizieren | Ob bestehende Mobile-Clients ungepaginierte Arrays oder aktuelle Fehlertexte fest voraussetzen. | Der neue Vertrag benoetigt gegebenenfalls eine additive Version bzw. befristete Kompatibilitaet. |

## Zielarchitektur und Sicherheitsentscheidungen

### 1. Gemeinsamer Actor- und Action-Vertrag

Eine neue Grenze, beispielsweise `app/lib/automations/actions.ts`, erhaelt nur
serverseitig erzeugte Principals:

```ts
type AutomationCaller =
  | { source: 'web' | 'mobile' | 'agent_tool'; userId: string; sessionId: string }
  | { source: 'scheduler'; serviceActorId: string }
  | { source: 'custom_webhook'; webhookId: string; requestId: string }
  | { source: 'composio_webhook'; providerEventId: string; requestId: string }
  | { source: 'runner'; automationId: string; runId: string };

type AutomationAction =
  | 'list'
  | 'view'
  | 'create'
  | 'update'
  | 'move'
  | 'run'
  | 'delete'
  | 'rotate_secret'
  | 'view_runs'
  | 'view_logs';
```

Die Action laedt Nutzer, Organization, Workspace-Mitgliedschaft, Job und bei
Bedarf Run unmittelbar vor der Operation. Sie liefert entweder eine
normalisierte Entscheidung mit Actor-/Scope-Snapshot oder einen stabilen
Fehlercode. Nicht autorisierte IDs antworten nach aussen mit `404`, damit keine
fremden Jobs, Runs oder Webhooks enumeriert werden koennen.

Der Store bleibt Repository fuer Transaktionen und Queries. Direkte
Mutationsaufrufe aus Routen und Tools werden entfernt oder als interne,
bereits-autorisierte Funktionen gekennzeichnet. Eine einfache ID darf nie die
einzige Sicherheitsgrenze einer Mutation sein.

### 2. Aktionsmatrix

| Scope | View/List | Create/Update/Move/Delete/Secret | Run | Actor im Run |
| --- | --- | --- | --- | --- |
| Personal | nur `ownerUserId`, aktiver Workspace-Zugriff | nur Owner, Zielworkspace erneut validiert | Owner, aktiver Job und Workspace | `actorType=user`, `actorUserId=ownerUserId` |
| Organization | Organization Owner/Admin plus Workspace-Read; eine breitere Leseberechtigung nur nach dokumentierter Produktentscheidung | Organization Owner/Admin plus jeweilige explizite Team-Automation-Berechtigung | Owner/Admin bzw. freigegebener Responsible User gemaess finaler Rollenentscheidung | `actorType=service`, `serviceActorId` und `responsibleUserId` |
| Scheduler/Webhook | kein allgemeines Listing | kein CRUD/Move/Secret | nur den fest gespeicherten aktiven Job nach voller Revalidierung queuen | aus Jobdefinition abgeleiteter Actor, niemals Request-Actor |
| Automation-Runner | eigener Job/Run nur intern | immer verboten | kein Run-now fuer andere Jobs | unveraenderlicher Run-Snapshot |

Organization-Create darf im sicheren Default nur Owner/Admin. Falls
`canCreateTeamAutomations` bewusst an Mitglieder delegierbar bleiben soll,
muessen View, Create, Update, Run, Delete und Approval als getrennte
Permissions dokumentiert und getestet werden; eine einzige breite Boolean-
Berechtigung bleibt nicht bestehen.

### 3. Agent-Tool-Policy und Meta-Automationssperre

- `AgentExecutionContext` wird um `source`, `automationId`, `runId`,
  `jobRevision` und `executionContextId` erweitert.
- Der Kontext wird beim Runner serverseitig aufgebaut und kann nicht aus
  Prompt- oder Toolargumenten stammen.
- Fuer `source === 'automation'` werden alle Automation-Management-Tools bereits
  beim Registry-Aufbau entfernt. Die Action-Grenze lehnt Create, Update, Move,
  Run, Delete und Secret-Rotation zusaetzlich ab, falls ein Tool anderweitig
  aufgerufen wird.
- In interaktiven Nutzer-Sessions verwenden Tool-Calls dieselben Actions wie
  REST. Sie koennen nur `workspaceId` als Zielwunsch fuer Create/Move angeben;
  Organization, Scope, Owner, Responsible User und Service Actor leitet der
  Server ab.
- Jeder Tool-Call erzeugt denselben Auditdatensatz wie die entsprechende
  REST-Operation, ergaenzt um Session, Agent, Toolname und Execution-ID.

### 4. Run-, Scheduler- und Webhook-Policy

Eine zentrale `queueAutomationRun`-Action wird fuer Run-now, Scheduler, Custom
Webhook und Composio verwendet. Sie:

1. laedt den Job frisch und sperrt/versioniert ihn fuer die Queue-Transaktion;
2. verlangt `status === active`, vollstaendige Scope-Invarianten und einen
   aktuellen Workspace-/Actor-Zugriff;
3. validiert den aufruferspezifischen Trigger und seine Dedupe-/Idempotency-
   Daten;
4. schreibt einen unveraenderlichen Scope-, Actor-, Profil- und Jobrevision-
   Snapshot in den Run;
5. schreibt Queue- und Policyentscheidung mit einer gemeinsamen Correlation-ID
   in Audit und Run-Events.

Der Runner laedt vor Start Job und Run erneut. Scope, Workspace, Actor,
Responsible User, Service Actor, Profil und Revision muessen zum Queue-Snapshot
passen. Ein fachlich relevanter Unterschied fuehrt nicht zu einem Lauf mit
neuem Scope, sondern zu `blocked`/`cancelled`, einem expliziten Grund und – bei
dauerhaftem Fehler – zur Pausierung des Jobs. Ein neuer Lauf muss anschliessend
unter der neuen Revision erzeugt werden.

Custom Webhooks erhalten versionierte Payload-Schemas bzw. eine explizite
Allowlist, signierte Timestamps, Nonce-/Replay-Speicher und Limits pro IP,
Webhook und Organization/User. Anonyme Webhooks duerfen in V1 nur eine
begrenzte, nicht schreibfaehige Ausfuehrung starten. Falls ein write-capable
Flow produktseitig erforderlich ist, benoetigt er eine separate, dokumentierte
Approval- und Capability-Policy; ein gueltiges Webhook-Secret allein reicht
nicht.

### 5. Audit, Loeschung und historische Sichtbarkeit

- Create, Update, Move, Run-now/Queue, Pause/Resume, Delete, Secret-Rotation,
  Runner-Start/Ende und Policy-Denials erhalten korrelierbare Audit-Events.
- Job-Delete wird als Soft Delete/Tombstone geplant. Trigger und neue Runs
  werden deaktiviert, bestehende Runs und Auditnachweise bleiben bis zum Ende
  ihrer Retention erhalten.
- Historische Runs werden gegen ihren unveraenderlichen Snapshot autorisiert.
  Nach einem Workspace-/Scope-Wechsel erscheinen alte Runs nur Nutzern, die
  sowohl den aktuellen Job als auch den historischen Run-Scope sehen duerfen.
  Andernfalls werden sie aus der Liste entfernt bzw. als nicht zugaengliche
  Historie aggregiert, niemals unter dem neuen Scope offengelegt.
- API-Responses geben keine internen Log- oder Dateipfade aus. Logevents werden
  serverseitig begrenzt, redigiert und nach Retention gefiltert.

## Datenmodell und Migration

### Zielinvarianten fuer Jobs

Personal-Job:

```text
scope = personal
ownerUserId != null
responsibleUserId = ownerUserId
organizationId != null
workspaceId != null
workspaceType = personal
serviceActorId = null
approvedByUserId = null
```

Organization-Job:

```text
scope = organization
ownerUserId = null
responsibleUserId != null
organizationId != null
workspaceId != null
workspaceType = team
serviceActorId != null
approvedByUserId != null
```

Zusaetzlich sind vorzusehen:

- eine monotone `revision` fuer konkurrierende Edits, Moves und Run-Queueing;
- `integrityStatus = valid | quarantined` und ein maschinenlesbarer
  `integrityReason` fuer Legacy-Daten;
- `deletedAt`, `deletedByUserId` und optional `disabledReason` statt sofortiger
  physischer Loeschung;
- eindeutige, DB-seitig pruefbare Personal-/Organization-Check-Constraints,
  soweit SQLite und PostgreSQL dies konsistent unterstuetzen.

Run-Snapshots werden mindestens um `jobRevision`, `ownerUserId`,
`responsibleUserId`, `approvedByUserId`, `executionContextId`, `triggerSource`
und `policyDecisionId` ergaenzt. Webhook-Events speichern Organization,
Workspace, Jobrevision, Request-/Provider-ID und Schema-Version als Snapshot,
nicht nur indirekt ueber einen spaeter veraenderbaren Job.

### Additive Migrationsstrategie

1. Read-only Integrity-Report fuer SQLite und PostgreSQL erstellen. Er zaehlt
   fehlende Workspaces/Owner/Responsible User/Service Actor, Scope-/Workspace-
   Widersprueche, verwaiste Runs/Trigger und historische Cross-Scope-Runs.
2. Neue Spalten, Indizes und zunaechst nicht erzwingende Constraints additiv
   anlegen. Alte Binaries muessen die erweiterte Datenbank weiterhin lesen
   koennen.
3. Nur eindeutig beweisbare Datensaetze backfillen. Es gibt keinen Fallback auf
   den ersten oder aktuell aktiven Workspace.
4. Mehrdeutige, verwaiste oder widerspruechliche Jobs atomar pausieren und als
   `quarantined` markieren. Scheduler und Webhooks duerfen sie nicht queuen.
5. Runs und Webhook-Ereignisse aus den damaligen Job-/Auditdaten backfillen,
   soweit der Scope beweisbar ist; sonst ebenfalls als historische Quarantaene
   markieren und nicht normal ausliefern.
6. Nach reportierter Null-Fehlerquote die finalen Constraints fuer beide
   Datenbanken aktivieren. Eine SQLite-Tabellenneuanlage wird separat und mit
   Restore-Test implementiert.

Quarantaene ist reversibel: Der Originaldatensatz und sein Fehlergrund bleiben
erhalten. Eine Admin-Reparatur muss Zielworkspace, Actor und Approval explizit
setzen und ein Audit-Event erzeugen; automatisches Raten ist ausgeschlossen.

## Geplante API-Vertraege

### Jobliste

`GET /api/automations/jobs`

Unterstuetzte Queryparameter:

```text
scope=personal|organization
workspaceId=<id>
ownerUserId=<id>
status=active|paused
runState=idle|queued|running|attention
type=scheduled|custom_webhook|composio_webhook|event
q=<name-or-description>
sort=name|nextRunAt|lastRunAt|createdAt
direction=asc|desc
limit=1..100
cursor=<opaque-keyset-cursor>
```

- Alle Filter werden nach serverseitiger Scopebegrenzung angewandt.
- `ownerUserId` bedeutet bei Personal-Jobs Owner und bei Organization-Jobs den
  verantwortlichen Nutzer; die Response benennt dies als `responsibleUser`.
- Sortierung verwendet immer einen eindeutigen ID-Tiebreaker. Cursor enthalten
  Filter-/Sort-Signatur, damit sie nicht zwischen Abfragen wiederverwendet
  werden koennen.
- Ein gefaelschter Workspace- oder Ownerfilter liefert keine fremden Facets,
  Counts oder Timing-Unterschiede.

Beispielresponse im bestehenden `success`-/`data`-Envelope:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "job-1",
        "name": "Weekly report",
        "scope": "organization",
        "workspace": { "id": "ws-1", "name": "Marketing", "type": "team" },
        "responsibleUser": { "id": "user-1", "name": "Alex" },
        "status": "active",
        "runState": "idle",
        "type": "scheduled",
        "revision": 4,
        "capabilities": { "view": true, "update": true, "run": true, "delete": false }
      }
    ],
    "page": { "limit": 50, "nextCursor": null, "hasMore": false },
    "facets": {
      "workspaces": [{ "id": "ws-1", "name": "Marketing", "count": 1 }],
      "owners": [{ "id": "user-1", "name": "Alex", "count": 1 }],
      "statuses": [{ "value": "active", "count": 1 }],
      "types": [{ "value": "scheduled", "count": 1 }]
    },
    "activeScope": { "organizationId": "org-1", "workspaceId": "ws-1" }
  }
}
```

Falls ein bestehender Mobile-Client das bisherige Array zwingend benoetigt,
wird der neue Vertrag zunaechst unter einer expliziten API-Version oder einem
Capability-Flag additiv ausgeliefert. Web und Mobile duerfen nicht dauerhaft
unterschiedliche Autorisierungslogik erhalten.

### Detail und Mutationen

- `GET /api/automations/jobs/[jobId]` liefert normalisierte Scope-, Owner-/
  Responsible-, Workspace- und `capabilities`-Daten, aber keine Secrets oder
  internen Pfade.
- `POST /api/automations/jobs` akzeptiert den gewuenschten `workspaceId` und
  Jobinhalt. Scope, Organization, Owner, Responsible User, Service Actor und
  Approval werden serverseitig hergeleitet.
- `PATCH /api/automations/jobs/[jobId]` akzeptiert fachliche Jobfelder und
  `expectedRevision`; Scope-/Owner-/Workspace-Felder bleiben verboten.
- `POST /api/automations/jobs/[jobId]/workspace` akzeptiert nur
  `targetWorkspaceId`, Preview/Confirm-Token und `expectedRevision`. Die Action
  wiederholt bei Confirm alle Berechtigungs- und Integritaetspruefungen.
- `POST /api/automations/jobs/[jobId]/run-now` akzeptiert `expectedRevision`
  und einen Idempotency-Key. Run-Actor und Workspace stammen aus dem Job.
- `DELETE /api/automations/jobs/[jobId]` verlangt `expectedRevision` und
  erzeugt einen Tombstone plus Audit; die Response enthaelt keine geloeschten
  Run-Inhalte.
- Secret-Erzeugung/-Rotation zeigt ein neues Secret genau einmal und speichert
  nur den Hash. Zugriff nutzt die Action `rotate_secret`.

Konkurrierende Revisionen antworten mit `409 AUTOMATION_REVISION_CONFLICT`.
Quarantaene antwortet mit `409 AUTOMATION_SCOPE_INVALID`; UI zeigt den
reparierbaren Grund ohne vertrauliche IDs anderer Scopes. Authentifizierte, aber
nicht autorisierte IDs bleiben `404 AUTOMATION_NOT_FOUND`.

### Runs und Logs

- `GET /api/automations/jobs/[jobId]/runs` erhaelt `limit`, `cursor`, `status`
  und `triggerSource`. Die Response enthaelt Scope-/Actor-Snapshot,
  Jobrevision, Zeitpunkte, Status, sicheren Ergebnisstatus und
  `capabilities.viewLogs`.
- `GET /api/automations/runs/[runId]` prueft Run-Snapshot und aktuellen Job
  gemeinsam. Ein fremder historischer Scope wird nicht unter dem neuen Job
  sichtbar.
- `GET /api/automations/runs/[runId]/logs` liefert cursorbasierte,
  groessenbegrenzte und redigierte Events. `logPath`, Prompt-Rohdaten, Secrets,
  Tokens und fremde Workspace-Pfade werden nie ausgeliefert.
- Run-/Log-Responses enthalten `executionContextId`/`correlationId`, damit UI,
  Audit und Support denselben Lauf eindeutig referenzieren koennen.

## Listen- und Detail-UI

- Die Seite besitzt getrennte Scope-Tabs `Meine Automationen` und
  `Organization`. Der aktive Tab, Organization und Workspace werden als
  sichtbarer Scope-Chip oberhalb der Liste angezeigt.
- Workspace, Owner/Responsible User, Status, Run-State und Automationstyp sind
  explizite Filter. Der Ownerfilter ist nur mit den im aktiven Scope sichtbaren
  Personen befuellt.
- Queryparameter sind die autoritative Filterquelle. Browser-Navigation und
  Reload stellen Filter, Sortierung und Cursoranfang reproduzierbar wieder her.
- `Filter zuruecksetzen` entfernt Suche, Owner, Status, Run-State und Typ,
  behaelt aber den bewusst gewaehlten Scope. Ein separater Scope-Wechsel
  verwendet den aktiven Workspace oder `Alle zugaenglichen Workspaces`.
- Die UI rendert die serverseitig paginierte Liste. Infinite Scroll oder
  `Weitere laden` darf keine alte Filterabfrage mit einer neuen vermischen;
  laufende Requests werden abgebrochen oder anhand eines Querykeys verworfen.
- Karten zeigen Scope, Workspace, Owner/Responsible User, Typ, Jobstatus,
  Run-State und naechsten Lauf. Mutationsbuttons werden anhand der vom Server
  gelieferten `capabilities` dargestellt, aber weiterhin serverseitig geprueft.
- Ein Job erscheint genau einmal. Falls Gruppierung beibehalten wird, wird ein
  disjunkter Anzeigezustand mit fester Prioritaet berechnet, zum Beispiel
  `attention > running > active > paused`; Automationstyp ist kein zweiter
  Statusbereich.
- Eigene Zustaende sind erforderlich fuer Initial-Loading, Nachladen, global
  leer, durch Filter leer, Fehler mit Retry, veraltete Detailauswahl,
  Revision-Conflict und Quarantaene.
- Die Detailseite zeigt Scope, Organization, Workspace, Owner bzw. Responsible
  User, Service-Actor-Typ, Approval, Revision und Run-/Log-Historie. Secrets,
  technische Actor-IDs und interne Pfade bleiben verborgen.

## Strikt sequenzielle Implementierungsphasen

### Phase 1: Charakterisierung und Sicherheitsvertrag

- Aus den belegten Befunden Action-, Rollen-, Run- und Listenvertrag als
  testbare Fixtures festschreiben.
- Einen read-only Integrity-Reporter fuer SQLite und PostgreSQL implementieren;
  noch keine Daten veraendern.
- Negative Tests fuer fremde Workspace-/Ownerfilter, fremde Job-/Run-IDs,
  manipulierte Owner-/Scope-Felder und Automation-Source-Toolcalls zunaechst
  als reproduzierbare Regressionen anlegen.
- Die Rollenentscheidung fuer Organization-Automationen dokumentieren. Ohne
  ausdrueckliche Abweichung gilt Owner/Admin als Mutationsgrenze.
- Verifikation: neue Charakterisierungstests, bestehender Workspace-Scope-Test,
  `npm run build`.
- Commit: `Characterize automation scope contracts`.

### Phase 2: Additives Datenmodell und Legacy-Quarantaene

- Revision, Integritaetsstatus, Tombstone- und fehlende Run-/Webhook-Snapshot-
  Felder in Schema, SQLite- und PostgreSQL-Migration ergaenzen.
- Eindeutige Legacy-Daten backfillen; mehrdeutige Jobs pausieren und
  quarantaenisieren.
- Scheduler, Webhooks und Listen so absichern, dass Quarantaene nicht
  ausgefuehrt und nur autorisierten Admins als reparierbarer Zustand gezeigt
  wird.
- Migrationsfixtures fuer Personal, Organization, fehlenden Workspace,
  widerspruechlichen Owner, verwaisten Responsible User und alte Cross-Scope-
  Runs ergaenzen.
- Verifikation: Migration-/Restore-Tests, Integrity-Report vor/nach Migration,
  Workspace-Scope- und Offboarding-Tests, `npm run build`.
- Commit: `Add automation scope integrity migration`.

### Phase 3: Gemeinsame Action- und Policy-Grenze

- `AutomationCaller`, `AutomationAction`, aktionsspezifische Policy und
  normalisierte Fehlercodes einfuehren.
- Repository-Queries nach Organization/Workspace/Owner scopen, bevor Objekte
  materialisiert werden; per-ID-Storemutationen nur intern zugaenglich machen.
- Create, View, Update, Move, Run, Delete, Secret und Run-/Log-Read als
  serverseitige Actions implementieren, inklusive Audit und Revision-Check.
- Zuerst direkte Action-/Policy-Tests fuer Personal, Organization,
  Rollenentzug, Workspace-Entzug, Offboarding und ID-Enumeration abschliessen.
- Verifikation: Policy-/Action-/Audit-/Storetests, `npm run build`.
- Commit: `Centralize automation action policy`.

### Phase 4: Read-APIs, Runs/Logs und Listenvertrag

- Job-, Detail-, Run- und Log-GET-Routen auf die Actions umstellen.
- Serverseitige Filter, Facets, Keyset-Pagination und stabile Sortierung
  implementieren.
- Historische Run-Snapshot-Autorisierung und Log-Redaction erzwingen.
- Mobile-Aliase auf denselben Vertrag bzw. eine additive Version umstellen;
  Compatibility-Tests fuer bestehende Clients aufnehmen.
- Verifikation: Route-Tests fuer jede Filterkombination, Cursorstabilitaet,
  Cross-Scope-Denials, Run-Move-Historie und Log-Redaction sowie
  `npm run build`.
- Commit: `Add scoped automation list and run APIs`.

### Phase 5: Mutationsadapter und Composio-Paritaet

- Web- und Mobile-Create/Patch/Move/Run-now/Delete/Secret-Routen auf die
  gemeinsamen Actions umstellen.
- Composio-Trigger-CRUD und Profilwechsel ebenfalls ueber Actions und
  Revisionen fuehren; keine adaptereigene Ownership-Logik behalten.
- Requests mit `ownerUserId`, `organizationId`, `serviceActorId` oder freiem
  Scope konsequent ablehnen bzw. aus dem oeffentlichen Schema entfernen.
- Workspace-Move Preview und Confirm gegen denselben frischen Snapshot,
  Revision, Actor und Zielworkspace pruefen.
- Verifikation: REST-/Mobile-/Composio-Vertragstests, parallele Edit-/Move-
  Konflikte, manipulierte Payloads, Auditparitaet, `npm run build`.
- Commit: `Route automation mutations through shared actions`.

### Phase 6: Agent-Tools und Execution Context

- `AgentExecutionContext` um Automation-Quelle, Job, Run, Revision und
  Correlation-ID erweitern.
- Interaktive Automation-Tools auf die Actions umstellen und Owner/Scope nicht
  als Toolargumente anbieten.
- Automation-Management-Tools fuer alle Automation-Runs aus der Registry
  entfernen und dieselbe Sperre in der Action als Defense in Depth erzwingen.
- Tool-Audit mit REST-Audit angleichen.
- Verifikation: Tool-Registry-, Prompt-Manipulations-, Personal-/Organization-
  Isolation-, Context-Revalidation- und Meta-Automation-Negativtests sowie
  `npm run build`.
- Commit: `Enforce automation tool execution scope`.

### Phase 7: Queue, Runner, Scheduler und Webhook-Haertung

- Alle Triggerquellen auf `queueAutomationRun` umstellen.
- Jobrevision, Scope-/Actor-/Profil-Snapshot und Idempotency atomar mit dem Run
  speichern.
- Runner-Revalidierung, Block-/Cancel-Gruende, Pausierung bei dauerhaften
  Actor-/Workspace-Fehlern und Auditkorrelation umsetzen.
- Custom Webhooks um Timestamp, Nonce, Replayfenster, Payload-Schema,
  Organization-/User-Limits und nicht schreibfaehige Capability-Policy
  erweitern.
- Composio-Verifikation beibehalten, danach aber dieselbe Queue-Action nutzen.
- Verifikation: Schedule-, Runner-, Timeout-, Delivery-, Custom-/Composio-
  Webhook-, Replay-, Rate-Limit-, Offboarding-, Revision- und Retry-Tests sowie
  `npm run build`.
- Commit: `Harden automation run entry points`.

### Phase 8: Listen- und Detail-UI

- Serverfilter, Scope-Tabs/-Chip, Workspace-/Owner-/Status-/Run-State-/
  Typfilter und URL-Synchronisation implementieren.
- Pagination, disjunkte Darstellung, sichtbare Owner-/Workspace-Zuordnung und
  servergelieferte Capabilities integrieren.
- Detail- und Runhistorie auf cursorbasierte APIs, sichere Loganzeige,
  Revision-Conflict und Quarantaenezustand umstellen.
- Loading-, Empty-, Filter-Empty-, Retry- und Stale-Selection-Zustaende in
  Deutsch und Englisch vervollstaendigen; Tastatur- und Screenreader-Labels
  pruefen.
- Verifikation: Komponenten-/Payload-Tests und `npm run build`. Manuelle UI-
  sowie Browser-/Playwright-Abnahme nur nach expliziter Freigabe.
- Commit: `Add scoped automation list controls`.

### Phase 9: Constraints, Retention und Gesamtabnahme

- Integrity-Report nach Datenmigration auswerten und erst bei Null
  unerklaerter Fehler die finalen DB-Constraints aktivieren.
- Tombstone-/Run-/Log-/Webhook-Retention sowie Recovery und Restore fuer beide
  Datenbanken pruefen.
- Alle Automation-, Composio-, Mobile-, Tool-, Offboarding-, Route- und
  Migrationssuites ausfuehren; gezieltes Lint und abschliessend
  `npm run build`.
- Mit expliziter Freigabe auf dem bereits laufenden `localhost:3000` die
  manuelle Browserabnahme aus der unten stehenden Matrix durchfuehren. Keinen
  zweiten Dev-Server und keinen Container starten.
- Ticket und Index erst nach vollstaendiger Abnahme auf erledigt setzen.
- Commit: `Complete automation scope hardening`.

## Automatisierte Testmatrix

| Bereich | Positiver Fall | Negativer/Sicherheitsfall |
| --- | --- | --- |
| Liste | Filter und Facets fuer erlaubte Personal-/Team-Workspaces, stabiler Cursor bei gleichen Sortierwerten | fremder Workspace/Owner erscheint weder in Items, Facets, Count noch Cursor |
| Create | Workspacewunsch wird serverseitig zu Personal- oder Organization-Scope aufgeloest | Payload setzt Owner, Organization, Service Actor oder nicht zugaenglichen Workspace |
| Update/Delete | berechtigter Actor mutiert erwartete Revision und Audit entsteht | fremder Actor, Automation-Runner, alte Revision oder quarantaenisierter Job |
| Workspace-Move | Preview und Confirm behalten Actor-/Profilinvarianten | Rechteentzug, Revisionwechsel, In-flight-Run, fremder Zielworkspace, Scope-Race |
| Runs/Logs | Run bleibt seinem Queue-Snapshot und Actor zugeordnet | alter Run wird nach Job-Move im neuen Scope oder mit internem Logpfad sichtbar |
| Run-now | aktiver Job wird genau einmal mit aktuellem Snapshot gequeued | pausierter/quarantinisierter Job, Doppelrequest, manipulierte Actor-/Workspace-Daten |
| Scheduler | nur aktive faellige Jobs, atomare Dedupe und Revision | Offboarding, Workspace-Entzug oder Edit zwischen Queue und Execute |
| Custom Webhook | gueltige Signatur, Timestamp, Nonce, Schema und Limits | Replay, abgelaufener Timestamp, falsches Schema, fremder Scope, Write-Capability |
| Composio | Provider-Event nutzt exaktes Responsible-User-/Workspace-Profil | fremdes Profil, fehlende Verbindung, Provider-Replay oder Scopewechsel |
| Agent-Tool | interaktiver berechtigter Nutzer nutzt dieselbe Action wie REST | Automation-Source, Prompt-Injection, fremde ID oder frei gesetzter Owner/Scope |
| Offboarding | betroffene Jobs pausieren oder werden kontrolliert uebergeben | verwaister Responsible User laeuft ueber Scheduler/Webhook weiter |
| Migration | eindeutige Daten werden verlustfrei backfillt | mehrdeutige Daten werden geraten, ausgefuehrt oder ohne Grund verworfen |
| Mobile | gleicher Scope-, Cursor- und Fehlervertrag wie Web | Alias umgeht neue Action oder exponiert Legacy-Rohdaten |

Neue Route- und Action-Tests sollen als eigene npm-Scripts registriert und in
die relevante Gesamttestgruppe aufgenommen werden. Bestehende Scripts werden
nicht durch einen einzelnen neuen End-to-End-Test ersetzt, sondern als
gezielte Regressionen weitergefuehrt.

## Manuelle Abnahmekriterien

Nach ausdruecklicher Browserfreigabe sind mindestens folgende Rollen mit
getrennten Testkonten zu pruefen:

1. Personal-Owner sieht nur eigene Automationen und kann den sichtbaren
   Personal-Workspace filtern.
2. Organization Owner/Admin sieht berechtigte Team-Workspaces, filtert nach
   Responsible User und erkennt Organization-Scope eindeutig.
3. Normales Mitglied sieht entsprechend der final dokumentierten Rollenmatrix
   entweder nur freigegebene Read-Daten oder gar keine Organization-
   Automationen; Mutationsbuttons und API sind konsistent.
4. Workspace-Wechsel aktualisiert Karte und Detail, alte Runs werden nicht in
   den neuen Scope geleakt und ein gleichzeitig geoeffneter alter Edit endet in
   einem verstaendlichen Revision-Conflict.
5. Filter-Reset, Reload, Back/Forward, `Weitere laden`, globale Leere,
   gefilterte Leere, Fehler/Retry und geloeschte aktuelle Auswahl bleiben
   bedienbar.
6. Run-now, Scheduler-Fixture, Custom Webhook und Composio-Webhook erzeugen
   denselben nachvollziehbaren Actor-/Workspace-Snapshot.
7. Eine Automation kann weder ueber UI noch Agent-Prompt/Tool eine weitere
   Automation erstellen, aendern, starten oder loeschen.
8. Logs zeigen sichere Events und Correlation-ID, aber keine Secrets,
   Prompt-Rohdaten, internen Dateipfade oder Daten historisch fremder Scopes.
9. Desktop- und schmale mobile Webansicht besitzen sichtbare Filterlabels,
   Tastaturbedienung und keine horizontal unbedienbaren Controls.

## Risiken, Rollout, Migration und Rollback

- **Legacy-Mehrdeutigkeit:** Ein falscher automatischer Workspace ist ein
  Datenleck. Deshalb nur beweisbare Backfills, ansonsten pausierte
  Quarantaene mit manueller Reparatur.
- **Rollenkompatibilitaet:** Eine strengere Owner/Admin-Regel kann bestehende
  delegierte Teamnutzer ausschliessen. Vor Aktivierung wird der Integrity-
  Report um betroffene Actors ergaenzt; eine breitere Regel erfordert
  dokumentierte Einzelpermissions statt stiller Ausnahme.
- **Mobile-Vertrag:** Pagination aendert Responseformen. Additive Versionierung
  und Capability-Erkennung verhindern einen ungeplanten Clientbruch.
- **Scheduler-Doppelverarbeitung:** Migration und Rollout muessen Queue-
  Idempotency und Jobrevision zuerst deployen. Es darf zu keinem Zeitpunkt
  zwei konkurrierende Scheduler-Policies geben.
- **Historische Sichtbarkeit:** Strengere Run-Snapshot-Regeln koennen alte Runs
  ausblenden. Sie werden nicht geloescht; autorisierte Admin-Recovery bleibt
  auditierbar.
- **Webhook-Kompatibilitaet:** Timestamp-/Nonce-Pflicht benoetigt eine
  versionierte Uebergangsfrist und getrennte Secrets. Alte Secrets werden
  gezielt rotiert, nicht dauerhaft unsicher akzeptiert.
- **Performance:** Facets und Run-State duerfen keine N+1-Queries erzeugen.
  Indizes und Queryplaene fuer Organization, Workspace, Owner, Status, Typ,
  Sortwert und ID werden mit grossen Fixtures geprueft.
- **Rollback:** Schemaaenderungen bleiben bis zur finalen Constraint-Phase
  additiv. Ein App-Rollback darf neue Spalten ignorieren; Quarantaene und
  Tombstones bleiben erhalten und reversibel. Constraints werden erst
  aktiviert, wenn die vorherige Appversion nicht mehr benoetigt wird.
- **Kein unsicherer Fallback:** Bei Problemen darf der Rollback neue
  Mutationen/Runner pausieren, aber nicht auf die breite alte Policy oder einen
  geratenen Workspace zurueckfallen.

Fuer den Rollout sind Metriken bzw. strukturierte Logs fuer Policy-Denials,
quarantinisierte Jobs, Revision-Conflicts, Queue-Dedupe, blockierte Runner,
Webhook-Replays und Scope-Mismatches vorzusehen. Keine dieser Telemetriedaten
darf Promptinhalt, Secrets oder personenbezogene Logpayloads enthalten.

## Definition of Done

- Jeder nicht geloeschte, nicht quarantinisierte Job erfuellt die Personal-
  oder Organization-Invarianten in Datenbank, API und UI.
- Die Jobliste filtert und paginiert serverseitig nach Workspace,
  Owner/Responsible User, Status, Run-State und Typ und zeigt den aktiven Scope
  dauerhaft sichtbar.
- UI, Web-/Mobile-REST, Composio und interaktive Agent-Tools verwenden dieselbe
  aktionsspezifische Policy und denselben Auditpfad.
- Automation-Runs besitzen keinen Zugriff auf Automation-Management-Tools;
  Defense-in-Depth blockiert Meta-Aktionen auch bei direktem Action-Aufruf.
- Run-now, Scheduler, Custom Webhook und Composio queuen nur aktive, valide,
  frisch autorisierte Jobs und schreiben unveraenderliche Actor-/Workspace-
  Snapshots.
- Historische Runs und Logs bleiben ihrem urspruenglichen Scope zugeordnet und
  exponieren keine internen Pfade, Secrets oder fremden Workspace-Inhalt.
- Legacy-Daten sind beweisbar migriert oder reversibel quarantinisiert; Restore
  und Rollback wurden fuer SQLite und PostgreSQL geprueft.
- Alle in der Testmatrix genannten Tests, gezieltes Lint und `npm run build`
  sind erfolgreich. Browser-/Playwright-Abnahme ist nur mit expliziter
  Freigabe erfolgt und dokumentiert.
- Jede Phase besitzt einen fokussierten Commit; Ticketstatus und Index werden
  erst nach der Implementierungs- und Abnahmephase aktualisiert.
