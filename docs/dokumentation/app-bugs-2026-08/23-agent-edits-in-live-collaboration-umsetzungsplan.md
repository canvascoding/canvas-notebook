---
title: 'Umsetzungsplan zu Ticket 23: Agent-Edits in Live-Collaboration-Dokumenten'
status: ready
date: 2026-08-21
platforms: [web, server, agent-runtime]
tags: [type/implementation-plan, topic/agents, topic/live-collaboration, topic/markdown, topic/tools]
---

# Umsetzungsplan: Agent-Edits in Live-Collaboration-Dokumenten

## Ziel, Scope und verbindliches Start-Gate

Dieser Plan konkretisiert [Ticket 23](./23-agent-edits-in-live-collaboration-reparieren.md)
auf Basis des aktuellen Codes. Er ersetzt die vorhandene Collaboration-Logik
nicht. Die Umsetzung darf nur die Integrationsluecke schliessen, die mit einem
echten Agent-Tool-Call im gespeicherten Team-Workspace reproduziert und einer
konkreten Grenze zugeordnet wurde.

Vor jeder Produktcode-Aenderung gelten daher diese Gates:

1. Ein echter Team-Workspace, zwei berechtigte Nutzer, ein aktives Markdown-
   oder Textdokument und eine gespeicherte Agent-Session muessen verwendet
   werden.
2. `read` und danach `edit_file` muessen vom normalen Chat-/Agent-Runtime-Flow
   ausgeloest werden. Ein direkter Aufruf von `piTools`, ein handgebauter
   `AgentExecutionContext` oder `scripts/collaboration-agent-tool-driver.ts`
   gilt nicht als Runtime-Reproduktion.
3. Fuer denselben Tool-Call werden redigiert Context-Identitaet,
   Pfadauflosung, Collaboration-Dokumentidentitaet, Representation,
   Live-Hash/State-Vector, Operationsstatus und erreichte Durability-Grenze
   korreliert.
4. Erst wenn der erste abweichende Vertrag feststeht, wird die passende
   Fixvariante aus der Diagnosematrix dieses Plans umgesetzt.

Die Arbeit erfolgt strikt sequenziell. Eine Phase beginnt erst, wenn die
vorherige Phase abgeschlossen, verifiziert und - sofern sie Code veraendert -
als fokussierter Commit vorliegt. Browser-/Playwright-Pruefungen sind erst nach
erneuter expliziter Freigabe zulaessig. Container werden fuer dieses Ticket nur
auf ausdrueckliche Anforderung gebaut.

## Inventur des aktuellen Stands

### Agent-Runtime und Execution Context

- `app/lib/pi/agent-execution-context.ts`
  - speichert `userId`, `sessionId`, `agentId`, Workspace-IDs, Root und eine
    Permission-Momentaufnahme in `AsyncLocalStorage`;
  - besitzt noch keine Context-ID, Ablaufzeit oder Revisionskennung.
- `app/lib/pi/session-workspace-context.ts`
  - loest eine gespeicherte `pi_sessions`-Session auf den aktuellen Workspace
    auf und prueft `canRead`, `canRunAgent` sowie `requireAgentAccess(...,
    'canUse')`;
  - wird beim Erzeugen des Runtime-Kontexts aufgerufen, nicht automatisch vor
    jedem spaeteren File-Tool-Apply.
- `app/lib/pi/live-runtime.ts`
  - erzeugt den Context bei `createRuntime(...)` und behaelt ihn als
    `readonly executionContext` fuer die Lebensdauer der Runtime;
  - auch `reloadTools()` baut Tools derzeit wieder mit derselben
    Context-Momentaufnahme.
- `app/lib/pi/tool-registry.ts` und `app/lib/pi/tool-runtime-helpers.ts`
  - `getPiTools(...)` baut die effektive Toolmenge und wickelt jedes Tool mit
    `runWithAgentExecutionContext(...)` ein;
  - der Wrapper bindet einen fertigen Context, loest aber riskante
    Write-Capabilities vor dem Call nicht erneut auf.

### Read-, Edit- und Patch-Pfad

- `app/lib/pi/core-tools.ts`
  - `read` loest den Pfad auf, liest zunaechst den Dateicheckpoint und ersetzt
    den Text danach bei aktiver Collaboration durch den autoritativen Yjs-
    Inhalt;
  - der zurueckgegebene SHA-256 ist fuer Collaboration der Hash des
    kanonischen Live-Inhalts;
  - `edit_file` und `apply_patch` reichen den Tool-Call-ID-basierten
    Idempotency-Key an `agent-file-operations.ts` weiter;
  - Fehler werden derzeit ueberwiegend auf freien Text und
    `details: { error: message }` reduziert.
- `app/lib/pi/agent-file-operations.ts`
  - loest relative Pfade gegen `AgentExecutionContext.workspaceRoot` auf und
    begrenzt Reads/Mutationen auf den gebundenen Workspace;
  - rekonstruiert mit `getAgentWorkspaceContext()` einen `WorkspaceContext`
    aus der gespeicherten Context-Momentaufnahme;
  - loest ueber `getFileCollaborationState(..., ensureDocument: false)` den
    aktiven Metadatensatz auf;
  - routet aktive Markdown-/Textdokumente zu
    `prepareCollaborationTextEdit(...)` und
    `executePreparedCollaborationTextEdit(...)`;
  - verwendet fuer nicht kollaborative Dateien weiterhin Snapshot,
    Revision-Guard und atomaren Dateiaustausch.
- `app/lib/collaboration/agent-file-edits.ts`
  - liest kanonischen Plain-Text oder Rich-Markdown aus dem aktuellen `Y.Doc`;
  - prueft `expectedSha256` gegen genau diesen Live-Inhalt;
  - erzeugt Relative-Position-/Target-Hash-Ziele fuer stabile Edits;
  - wechselt bei strukturellen Rich-Markdown-Aenderungen auf einen begrenzten,
    persistierten Review-Patch.

### Dokumentidentitaet, Direct Connection und Durability

- `app/lib/files/collaboration-policy.ts`
  - verwaltet kanonischen Workspace-Pfad, Revision/Lineage und
    `collaboration_documents`-Metadaten;
  - die Metadaten liegen in der Organization-/Bootstrap-Datenbank, waehrend
    der binaere Yjs-State bei Postgres-Betrieb in
    `collaboration_yjs_states` liegt.
- `app/lib/collaboration/document-access.ts`
  - liest bei installiertem In-Process-Bridge-Handler den aktuellen Room-State;
  - faellt fuer Test-/Maintenance-Prozesse auf den letzten persistierten
    Yjs-State zurueck, niemals auf den Datei-Checkpoint.
- `app/lib/collaboration/agent-operations.ts`
  - persistiert Operation, Idempotency-Key, Payload-Hash, Generation,
    Base-State-Vector, CAS und Review-/Durability-Status;
  - serialisiert Apply pro Dokument und revalidiert Target-Anker/Hashes im
    autoritativen `Y.Doc`;
  - unterscheidet `applied_to_ydoc`, `persisted_yjs` und
    `checkpointed_file`;
  - wartet nach dem Direct Apply auf bestaetigte Yjs-Persistenz und
    Datei-Checkpoint.
- `app/lib/collaboration/direct-connection.ts` und
  `server/collaboration-server.ts`
  - stellen eine pro Prozess installierte Hocuspocus Direct Connection bereit;
  - die Direct Connection baut fuer Agenten intern einen Collaboration-
    Context und oeffnet denselben Room wie die verbundenen Clients;
  - der aktuelle Agent-Pfad loest unmittelbar vor `openDirectConnection(...)`
    weder User/Session/Agent noch die Workspace-Permission neu aus der
    Datenbank auf.
- `app/lib/collaboration/persistence.ts` und
  `app/lib/collaboration/checkpoint.ts`
  - speichern Yjs-State, State-Vector und Sequenz in Postgres;
  - materialisieren erst danach den Workspace-Dateicheckpoint und die
    File-Revision;
  - markieren anhaltende Store-/Checkpoint-Probleme als `degraded`.

### Operations- und UI-Vertraege

- `app/lib/pi/agent-file-operations.ts` liefert in
  `AgentFileChangeResult.collaboration` aktuell Operation-ID,
  Operationsstatus, Durability, Review-Flag und vorgeschlagenen Hash.
- `app/lib/pi/tool-file-formatters.ts` formuliert Direkt-Apply und Review fuer
  das Modell als Text, besitzt aber keinen stabilen Fehlercode oder eine
  maschinenlesbare Folgeaktion.
- `app/lib/collaboration/agent-operations-client.ts` und
  `app/components/editor/CollaborationAgentOperations.tsx` zeigen persistierte
  Reviews und Accept/Reject/Revert auf Basis des Dokument-IDs an.
- `app/components/canvas-agent-chat/useChatRuntimeEvents.ts` uebernimmt zwar
  `event.result.details`, erzeugt im Live-UI-Pfad aber derzeit ein
  ToolResult mit `isError: false`; ein textueller `Error: ...` kann deshalb als
  erfolgreich beendeter Toollauf erscheinen.

### Vorhandene Tests und ihre Integrationsgrenze

- `scripts/file-agent-operation-integration-test.ts`
  - deckt Direct Apply, Idempotenz, Review, Accept/Reject/Revert, Rich-
    Markdown, Stale-Hash, Persistence/Checkpoint und Restart-Recovery breit ab;
  - installiert Document-Reader und Direct-Connection als Test-Handler;
  - ruft `piTools` unter einem handgebauten `AgentExecutionContext` direkt auf.
- `tests/file-live-collaboration.spec.ts`
  - deckt zwei Browser-Clients, Presence, Review-UI und Accept/Reject ab;
  - startet Agent-Tools ueber `scripts/collaboration-agent-tool-driver.ts` in
    einem separaten Prozess und uebergibt den Context aus dem Test selbst;
  - umgeht dadurch Session-Snapshot, `resolveAgentExecutionContextForSession`,
    `getPiTools`, Runtime-Tool-Wrapper, Modell-Tool-Loop und den normalen
    Runtime-Eventpfad.
- `scripts/agent-session-workspace-context-test.ts`
  - prueft Pfadauflosung und Workspace-Isolation, aber nur im isolierten
    SQLite-/Personal-Workspace-Profil.
- `scripts/pi-tool-registry-test.ts`
  - prueft Core-Tools und Toolfilter, aber nicht den kompletten Postgres-Team-
    Runtime-/Collaboration-Flow.

Damit erklaeren die vorhandenen Happy-Path-Tests nicht den gemeldeten Fehler im
realen Team-Agentenlauf. Genau diese Luecke hat Prioritaet.

### Bestehende Architekturvorgaben

- `docs/architecture/canvas-notebook/plan.md` verweist fuer dieses Ticket auf
  die Agent-Tool-Policy und den Collaboration-Vollplan.
- `team-workspace/10-agent-tool-execution-policy.md` legt verbindlich fest,
  dass Context und riskante Write-Capabilities serverseitig entstehen und vor
  dem finalen Commit erneut geprueft werden. Aktive Yjs-Dokumente duerfen nur
  ueber den Collaboration-Agent-Service mutiert werden.
- `team-workspace/18-collaboration-and-file-conflict-policy.md` definiert
  Dokumentidentitaet, Yjs als Source of Truth, Relative Positions,
  Review-Fallback, Direct Connection, Operationszustandsmaschine sowie die
  Trennung von Yjs-Persistenz und Dateicheckpoint.
- Aufgabe 48 in `docs/architecture/canvas-notebook/todo.json` ist als
  `completed` dokumentiert und enthaelt die zu erhaltenden Agent-/Durability-
  Abnahmekriterien. Die historische Statusabgrenzung am Anfang des
  Collaboration-Vollplans beschreibt einen frueheren Stand; fuer die Ist-
  Inventur dieses Tickets ist der implementierte Code massgeblich, waehrend
  die Sicherheitsinvarianten des Plans weiterhin verbindlich bleiben.

## Belegte Befunde und noch zu verifizierende Ursachen

### Belegt

1. Die Yjs-Ziel-, Review-, Operations-, Persistenz- und Checkpoint-Mechanik ist
   implementiert und in isolierten Service-/Tooltests grundsaetzlich
   funktionsfaehig.
2. `read` und `prepareCollaborationTextEdit` berechnen den SHA-256 aus dem
   kanonischen Live-Yjs-Inhalt, sofern beide denselben Dokumentdatensatz und
   denselben In-Process-Room erreichen.
3. Die realen Collaboration-E2E-Tests verwenden keinen echten Agent-Runtime-
   Tool-Call, sondern einen direkten Tooldriver mit clientseitig konstruiertem
   Context.
4. Die Runtime bindet eine langlebige Context-/Permission-Momentaufnahme an
   Tools. Eine neue Workspace-/Agent-/Write-Pruefung findet nicht bei jedem
   spaeteren Tool-Call statt.
5. Vor der Agent-Direct-Connection werden weder die gespeicherte Session-
   Bindung noch Agentenzugriff und aktuelle Workspace-Write-Permission anhand
   der DB-Quelle erneut verifiziert. `input.workspace.permissions.canWrite`
   stammt aus dem gebundenen Context.
6. Der gespeicherte `actor_session_id` wird beim aktuellen
   `runCollaborationDirectConnection(...)`-Aufruf nicht als
   `actorSessionId` weitergereicht; der serverinterne Collaboration-Context
   verwendet deshalb ersatzweise die Operation-ID als Session-ID.
7. Mehrere technische Ursachen der Direct Connection werden in
   `agent-operations.ts` als `persistence_degraded`/Review zusammengefasst.
   Core-Tools reduzieren geworfene Fehler anschliessend auf freien Text.
8. Der Live-Chat-Adapter markiert ToolResult-Nachrichten unabhaengig vom
   strukturierten Resultat mit `isError: false`. Runtime, Modell und UI besitzen
   damit noch keinen durchgaengigen, typisierten Fehler-/Outcome-Vertrag.

### Im echten Runtime-Lauf zu verifizieren

1. **Context-Bindung:** Stimmen `userId`, `sessionId`, `agentId`,
   `organizationId`, `workspaceId`, Workspace-Typ und Root aus der gespeicherten
   Agent-Session mit dem geoeffneten Team-Workspace ueberein?
2. **Pfadidentitaet:** Loesen `read`, `edit_file` und `apply_patch` denselben
   normalisierten Workspace-Pfad auf, insbesondere bei absoluten Pfaden,
   Legacy-Alias, Symlink/Realpath und `workspaceRootRelativePath`?
3. **Dokumentidentitaet:** Zeigen `collaboration_documents`-Metadaten und
   `collaboration_yjs_states` auf dieselbe aktive Dokument-ID, Workspace-ID,
   Pfad, Representation und Lifecycle-Generation?
4. **Room-Grenze:** Ist der Document-Reader-/Direct-Connection-Bridge-Handler
   im Prozess und in derselben Modulinstanz wie die Agent-Runtime installiert?
   Erreicht der Call den aktiven In-Memory-Room oder nur den persistierten
   Yjs-State?
5. **Hash-Grenze:** Ist der von `read` ausgegebene Live-Hash exakt der Hash,
   den `prepareCollaborationTextEdit` vor dem Target-Aufbau sieht, oder tritt
   dazwischen eine legitime User-Aenderung auf?
6. **Rich-Target-Grenze:** Scheitert der direkte Edit bereits bei
   Context/Dokument/Bridge, oder erst bei Rich-Markdown-Targetauflosung bzw.
   Roundtrip und muesste deshalb als `needs_review` enden?
7. **Durability-Grenze:** Wird die Yjs-Transaktion angewendet und nur die
   Persistence-/Checkpoint-Bestaetigung verfehlt, oder wird der Room nie
   mutiert?
8. **Runtime-Adapter:** Bleiben Operation-ID, Status, Durability, Fehlercode und
   Folgeaktion vom Tool ueber PI-Agent-Core, Runtime-Events, Persistenz und
   Chat-UI erhalten?

## Diagnosematrix: Erstes abweichendes Signal bestimmt den Fix

| Erstes abweichendes Signal | Primaere Grenze | Zulaessige Fixrichtung |
| --- | --- | --- |
| Session/Agent/Workspace stimmt vor `read` nicht | `session-workspace-context.ts` / Runtime-Erzeugung | gespeicherte Session-Bindung und Context-Aufloesung korrigieren; keine Collaboration-Sonderlogik |
| `read` und `edit_file` normalisieren unterschiedliche Pfade | File-Action/Pfadauflosung | einen gemeinsamen kanonischen Workspace-Path-Resolver fuer Read/Prepare/Apply verwenden |
| Metadaten- und Yjs-Datensatz unterscheiden sich | Dokumentauflosung/Lifecycle | dokumentgebundene Resolution gegen Workspace, Pfad, Provider, Representation und Generation vereinheitlichen |
| Reader oder Direct Connection ist trotz laufendem Server nicht installiert | Prozess-/Modul-Bridge | Bridge-Ownership am Custom Server vereinheitlichen und Startup-Health fail-closed machen |
| Live-Hash hat sich durch User-Edit geaendert | erwarteter Konflikt | stabilen `stale_live_hash`-Vertrag mit `read_again`; niemals Auto-Retry oder Overwrite |
| Targets sind strukturell/mehrdeutig | Rich-Markdown-Action | vorhandenen persistierten Review-Pfad erreichen und korrekt zur Runtime transportieren |
| Apply erreicht Y.Doc, Persistence/Checkpoint aber nicht | Durability | Statusfolge und `degraded` reparieren; keinen falschen Saved-Status melden |
| Toolresultat ist korrekt, Runtime/UI verliert Details | Runtime-Adapter | typisierten Outcome-/Error-Vertrag unveraendert durchreichen und korrekt darstellen |

Mehrere beobachtete Abweichungen werden in dieser Reihenfolge behoben. Eine
nachgelagerte Wirkung darf nicht durch eine zweite Parallelimplementierung der
Yjs-Mechanik kaschiert werden.

## Zielarchitektur und Sicherheitsentscheidungen

### 1. Eine gemeinsame serverseitige File-Action fuer Read/Prepare/Apply

`core-tools.ts` bleibt Tooladapter. `agent-file-operations.ts` bleibt
Orchestrator fuer normale Datei- und Collaboration-Flows. Die wiederverwendbare
Yjs-Mechanik verbleibt in `agent-file-edits.ts` und `agent-operations.ts`.

Die gemeinsame Action-Grenze muss fuer jeden Collaboration-Read/-Write einen
expliziten, frisch autorisierten Kontext liefern:

```ts
type AuthorizedAgentFileActionContext = {
  executionContextId: string;
  userId: string;
  sessionId: string;
  agentId: string;
  workspace: WorkspaceContext;
  relativePath: string;
  absolutePath: string;
  document: {
    documentId: string;
    provider: 'yjs';
    representation: 'plain_text' | 'tiptap_xml';
    lifecycleGeneration: number;
    documentSequence: number;
  };
};
```

Die Action besitzt die Domain-Regeln: Session-/Agent-/Workspace-Aufloesung,
Permission, Pfad-/Dokumentidentitaet, Fehlerklassifikation und Entscheidung
zwischen normalem File-Flow und Collaboration. Die Services erhalten nur
explizite validierte Inputs und besitzen keine zweite Workspace-Autoritaet.

### 2. Revalidierung unmittelbar vor der autoritativen Transaktion

Vor jedem direkten Apply und erneut bei Review-Accept/Revert werden geprueft:

- initiierender Nutzer ist aktiv und besitzt die gespeicherte Session;
- Session ist weiterhin an denselben Agenten und Workspace gebunden;
- Agent ist in Organization/Workspace/Projekt weiterhin mit `canUse`
  freigegeben;
- Workspace ist aktiv, lesbar und fuer den konkreten Apply schreibbar;
- absoluter und relativer Pfad liegen im aktuellen Workspace-Root;
- Metadaten-Dokument und Yjs-State stimmen bei Dokument-ID, Workspace, Pfad,
  Provider, Representation, Schema und Lifecycle-Generation ueberein;
- Operation ist nicht terminal, Payload-/Idempotency-Bindung stimmt und die
  Targets revalidieren im aktuellen `Y.Doc`.

Presence, Toolparameter, Client-Workspace-Header und die alte Context-
Momentaufnahme duerfen Rechte nur beschreiben, niemals erweitern. Die frisch
aufgeloeste Capability wird an die Direct Connection uebergeben; dort wird
kein pauschales `permission: 'write'` aus ungeprueften Inputs erzeugt.

### 3. Kanonische Dokumentauflosung fuer Read und Write

Read, Prepare und Apply verwenden dieselbe Resolution aus
`workspaceId + normalisiertem relativePath + provider`. Sie gleicht die
`collaboration_documents`-Metadaten mit `collaboration_yjs_states` ab und gibt
eine einzige Dokumentidentitaet zurueck. Ein Mismatch endet fail-closed mit
stabilem Code; es wird weder ein zweites Dokument erzeugt noch auf den
Dateicheckpoint zurueckgefallen.

Die aktuelle Aufteilung zwischen Metadaten-Datenbank und Postgres-Yjs-State
wird fuer Ticket 23 nicht migriert, solange die Reproduktion keinen
providerbedingten Identitaetsfehler belegt. Falls genau diese Grenze die
Ursache ist, wird zunaechst ein gemeinsamer Repository-Resolver eingefuehrt;
eine Datenmigration ist eine separat zu pruefende Folgeentscheidung.

### 4. Live-Hash und Target-Anker haben unterschiedliche Aufgaben

- `liveSha256` schuetzt den Read-Prepare-Vertrag und erzwingt bei einer
  zwischenzeitlichen Aenderung ein erneutes Lesen.
- `stateVector`, Relative Positions und `baseTargetHash` schuetzen Prepare-
  Apply und erlauben nur deterministisch revalidierbare Zieloperationen.
- Ein Hash-Mismatch fuehrt nicht automatisch zu Review, wenn die Operation
  noch gar nicht gegen den neuen State vorbereitet wurde; die Folgeaktion ist
  `read_again`.
- Ein Target-/Schema-/Strukturkonflikt nach valider Vorbereitung fuehrt zu
  `needs_review` oder `semantic_conflict`.

### 5. Rich Markdown bleibt targetbasiert

Ein stabiler Text innerhalb eines Tiptap-Textknotens kann direkt angewendet
werden. Knotenuebergreifende, strukturelle oder nicht roundtrip-stabile
Aenderungen werden als begrenzte Exact-Edit-Review-Payload persistiert. Ein
Whole-Document-Ersatz darf ausschliesslich nach explizitem Accept innerhalb des
bereits validierten Review-Pfads entstehen; er ist kein technischer Fallback.

### 6. Durability und fachlicher Outcome werden getrennt

Der fachliche Outcome beschreibt, was mit dem Vorschlag geschah. Durability
beschreibt, bis wohin ein tatsaechlich angewendeter Edit bestaetigt ist:

```text
outcome: applied | review_required | conflict | degraded | failed
durability: none | applied_to_ydoc | persisted_yjs | checkpointed_file
```

`review_required` hat keine angewendete Durability. Ein Apply mit spaeterem
Persistence-Problem bleibt als `degraded` mit mindestens
`applied_to_ydoc` sichtbar. Nur `checkpointed_file` darf einen aktuellen
Datei-/Download-Checkpoint behaupten.

### 7. Strukturierte Fehler ohne Inhaltsleck

Runtime, Modell und UI erhalten stabile Codes und Folgeaktionen. Logs/Audit
enthalten IDs, Hashes, Representation, Status und Dauer, aber keine
Dokumentinhalte, `oldText`/`newText`, Yjs-Payloads, Tokens oder Secrets.

## Geplante interne Daten- und Tool-Vertraege

### Read-Resultat fuer aktive Collaboration

Der bestehende Textinhalt fuer das Modell bleibt erhalten. `details` wird
mindestens so praezisiert:

```ts
type CollaborationReadDetails = {
  source: 'live_yjs';
  documentId: string;
  workspaceId: string;
  path: string;
  representation: 'plain_text' | 'tiptap_xml';
  lifecycleGeneration: number;
  documentSequence: number;
  stateVector: string;
  liveSha256: string;
};
```

Das bestehende top-level `sha256` bleibt fuer Kompatibilitaet und entspricht
bei `source='live_yjs'` exakt `liveSha256`.

### Edit-/Patch-Resultat

```ts
type CollaborationToolOutcome = {
  outcome: 'applied' | 'review_required' | 'conflict' | 'degraded' | 'failed';
  code:
    | 'collaboration_applied'
    | 'collaboration_review_required'
    | 'stale_live_hash'
    | 'collaboration_target_conflict'
    | 'collaboration_semantic_conflict'
    | 'collaboration_permission_revoked'
    | 'collaboration_context_mismatch'
    | 'collaboration_document_mismatch'
    | 'collaboration_lifecycle_stale'
    | 'collaboration_direct_connection_unavailable'
    | 'collaboration_persistence_degraded'
    | 'collaboration_failed';
  recommendedAction: 'none' | 'read_again' | 'review' | 'wait_for_persistence' | 'ask_user';
  operationId: string | null;
  operationStatus: AgentOperationStatus | null;
  durability: 'none' | 'applied_to_ydoc' | 'persisted_yjs' | 'checkpointed_file';
  reviewRequired: boolean;
  documentId: string;
  representation: 'plain_text' | 'tiptap_xml';
  beforeLiveSha256: string;
  afterLiveSha256: string | null;
  proposedSha256: string;
};
```

`apply_patch` liefert denselben Vertrag pro Datei. Der Gesamtadapter darf bei
einem Preflight-Fehler nicht `applied` behaupten. Dokumentuebergreifende
Atomaritaet wird in Ticket 23 nicht neu eingefuehrt.

### Fehlersemantik im PI-Tooladapter

- Erwartete Sicherheits-/Konfliktpfade werden als strukturiertes Outcome mit
  passendem Modelltext zurueckgegeben.
- Technische Fehler setzen den vom PI-Toolvertrag vorgesehenen Error-Marker
  und behalten `details.code`/`recommendedAction`.
- Runtime-Events, gespeicherte ToolResult-Nachricht und Chat-UI uebernehmen den
  Marker statt pauschal `isError: false` zu setzen.
- Das Modell erhaelt eine kurze konkrete Anweisung; der Runtime-Adapter
  entfernt weder Operation-ID noch Status.

### Operation und Direct-Connection-Capability

Die persistierte Operation besitzt bereits die meisten benoetigten Felder.
Die Direct Connection erhaelt zusaetzlich explizit:

```ts
type AuthorizedAgentDirectConnectionInput = {
  operationId: string;
  initiatedByUserId: string;
  actorSessionId: string;
  actorAgentId: string;
  workspaceId: string;
  documentId: string;
  path: string;
  representation: 'plain_text' | 'tiptap_xml';
  lifecycleGeneration: number;
};
```

Der Server loest daraus den aktuellen Workspace-/Agent-Zugriff erneut auf und
vergleicht ihn mit der Operation. Ein Client kann dieses Objekt nicht liefern.

## Strikt sequenzielle Implementierungsphasen

### Phase 0: Reale Runtime-Reproduktion und Evidence Bundle

- Lokales Postgres-Team-Profil und vorhandenen Custom Server verwenden; keinen
  zusaetzlichen Dev-Server oder Container starten.
- User A und User B im selben berechtigten Workspace anmelden und dasselbe
  aktive Markdown-Dokument oeffnen.
- Eine echte gespeicherte Agent-Session in genau diesem Workspace starten und
  den Agenten zunaechst `read`, dann einen eindeutig nicht ueberlappenden
  Absatz mit `edit_file` aendern lassen.
- Tool-Call-ID als Correlation-ID verwenden und an den Grenzen
  Runtime-Context, kanonischen Pfad, Dokument-ID, Representation,
  Lifecycle/Sequenz, Live-Hash, Operation-ID/-status und Durability erfassen.
- Parallel einen Stale-Fall und einen strukturellen Rich-Markdown-Fall
  ausloesen, um erwartete Konflikte vom gemeldeten technischen Fehler zu
  unterscheiden.
- Keine Inhalte oder Secrets loggen; Hashes und opaque IDs genuegen.
- Den ersten abweichenden Vertrag anhand der Diagnosematrix festhalten.

Abnahme:

- der Fehler ist mit normalem Agent-Runtime-Tool-Call reproduziert;
- der direkte Tooldriver-Happy-Path bleibt nur Kontrollgruppe;
- eine konkrete erste fehlerhafte Grenze und ein redigiertes Resultat liegen
  vor;
- ohne eindeutigen Befund beginnt Phase 1 nicht.

Kein Produktcode-Commit. Falls temporaere Diagnoseinstrumentierung noetig ist,
wird sie vor dem ersten Commit entfernt oder in Phase 1 als inhaltsfreie,
testbare Observability uebernommen.

### Phase 1: Runtime-nahe Regression und kleinste belegte Integrationskorrektur

- Einen deterministischen Postgres-Team-Test ergaenzen, der eine echte
  `pi_sessions`-Zeile und Workspace-Mitgliedschaft anlegt,
  `resolveAgentExecutionContextForSession(...)` und `getPiTools(...)` nutzt und
  `read -> edit_file` ueber die gewrappten Tools ausfuehrt.
- Zusaetzlich den normalen Runtime-/Tool-Eventadapter mit einem kontrollierten
  Modellstream pruefen, damit Toolresultat und Details nicht erst in der UI
  verloren gehen koennen.
- Die in Phase 0 belegte erste Integrationsluecke korrigieren:
  Context-Bindung, gemeinsamer Pfadresolver, Dokumentresolver, Modul-Bridge
  oder Resultatadapter - niemals mehrere hypothetische Fixes gleichzeitig.
- `scripts/collaboration-agent-tool-driver.ts` nicht als Ersatz fuer diesen
  Test verwenden.

Verifikation:

- neuer Test reproduziert den alten Fehler vor dem Fix und besteht danach;
- bestehender direkter Tool-Happy-Path besteht weiterhin;
- falscher Workspace/Agent/Session wird negativ getestet;
- kein aktives Yjs-Dokument faellt auf Whole-File-Write zurueck.

Commit: `Repair agent collaboration runtime boundary`.

### Phase 2: Frische Action-Capability und kanonische Dokumentidentitaet

- Die gemeinsame serverseitige File-Action fuer Read/Prepare/Apply einfuehren
  oder die vorhandene Grenze in `agent-file-operations.ts` entsprechend
  schaerfen.
- Vor jedem Collaboration-Call Session, Agentenzugriff und Workspace aus
  gespeicherten Quellen neu aufloesen.
- Einen gemeinsamen kanonischen Resolver fuer absoluten/relativen Pfad,
  Collaboration-Metadaten und Yjs-State verwenden.
- `read`, `edit_file` und `apply_patch` auf dieselbe aufgeloeste
  Dokumentidentitaet stellen.
- Normale Dateioperationen und persoenliche Workspaces unveraendert ueber ihre
  bestehenden Pfade laufen lassen.

Verifikation:

- Team-, Projekt-, Organization- und Personal-Scope werden korrekt getrennt;
- Metadaten-/Yjs-Mismatch, archivierte Generation und falsche Representation
  enden fail-closed;
- Live-Read und Prepare liefern fuer unveraenderten State denselben Hash;
- Stale-Hash nennt den aktuellen Live-Hash nur im autorisierten Toolresultat.

Commit: `Bind agent file actions to live document identity`.

### Phase 3: Apply-Revalidierung und Direct-Connection-Sicherheit

- `actorSessionId` und `actorAgentId` durch Operation und Direct Connection
  durchreichen.
- Direkt vor `openDirectConnection(...)` Nutzer, gespeicherte Session,
  Agentenzugriff, Workspace-Write-Permission und Dokumentgeneration erneut
  aufloesen.
- Revalidierte Daten mit Operation-ID, Initiator, Workspace, Dokument, Pfad,
  Representation und Lifecycle vergleichen.
- Review-Accept und Revert dieselbe Capability-Pruefung durchlaufen lassen;
  der aktuell klickende User braucht zusaetzlich den bestehenden
  Operationszugriff und `canWrite`.
- Fehler der Direct Connection nach Ursache klassifizieren. Nur ein echter
  Persistence-/Checkpoint-Fehler darf `persistence_degraded` heissen.

Verifikation:

- entzogene Workspace-Write-Permission blockiert vor der Yjs-Transaktion;
- fremde oder umgebundene Session, fremder Agent und fremder Workspace werden
  abgelehnt;
- Presence und manipulierte Actor-Parameter erweitern keine Berechtigung;
- ein autorisierter nicht ueberlappender Edit konvergiert weiterhin live;
- Idempotency-Key und CAS verhindern doppelten Apply.

Commit: `Revalidate collaboration agent applies`.

### Phase 4: Durchgaengiger Outcome-, Fehler- und Durability-Vertrag

- `AgentFileChangeResult.collaboration` auf den beschriebenen typisierten
  Outcome erweitern; Kompatibilitaetsfelder beibehalten, solange bestehende UI
  und Tests sie lesen.
- Stale-Hash, Target-Konflikt, Review, Lifecycle-Mismatch, Direct-Connection-
  Ausfall und Persistence-Degradation mit stabilen Codes abbilden.
- `core-tools.ts`, `tool-file-formatters.ts`, PI-Runtime-Events, gespeicherte
  ToolResult-Nachricht und Chat-UI auf denselben Vertrag stellen.
- In der Editor-Operations-UI weiterhin die persistierte Operation als Quelle
  fuer Accept/Reject/Revert verwenden; Tooldetails autorisieren keine Aktion.
- Statusmeldungen fuer `applied_to_ydoc`, `persisted_yjs` und
  `checkpointed_file` nicht zusammenziehen.

Verifikation:

- Modell und UI unterscheiden `applied`, `review_required`, `conflict`,
  `degraded` und `failed`;
- ein erwarteter Review wird nicht als technischer Fehler dargestellt;
- ein technischer Fehler erscheint nicht mit gruenem Erfolgsstatus;
- Details bleiben nach Runtime-Persistenz und erneutem Laden der Session
  erhalten;
- Logs enthalten keine Datei- oder Patchinhalte.

Commit: `Preserve collaboration tool outcomes`.

### Phase 5: Runtime-, Konflikt-, Persistenz- und Restart-Testmatrix

- `scripts/file-agent-operation-integration-test.ts` um den konkret
  reproduzierten Runtime-/Context-Fehler erweitern oder den neuen runtime-nahen
  Test als eigenes npm-Script registrieren.
- Tests fuer Live-Hash-Gleichheit, Stale-Hash, nicht ueberlappenden Direkt-
  Apply, Rich-Markdown-Review, Accept/Reject, Idempotenz und Reconnect
  vervollstaendigen.
- Persistence-Fehler gezielt zwischen `applied_to_ydoc` und `persisted_yjs`
  sowie zwischen `persisted_yjs` und `checkpointed_file` simulieren.
- Restart-Recovery fuer `preparing`, `applying`, `applied_to_ydoc` und
  `persisted_yjs` pruefen; kein Replay einer bereits angewendeten Operation.
- Negative Matrix fuer fremden User, fremde Session, falschen Agenten,
  Workspace-Mismatch und unmittelbar vor Apply entzogene Rechte ergaenzen.
- Regression fuer nicht kollaborative Markdown-/Textdateien, persoenliche
  Workspaces und bestehendes `apply_patch` beibehalten.

Verifikation in dieser Reihenfolge:

1. fokussierte neue Runtime-/Action-Tests;
2. `npm run test:agent:session-workspace`;
3. `npm run test:files:collaboration` und vorhandene Collaboration-
   Scripttests;
4. Tool-Registry-/Runtime-Adapter-Tests;
5. `npm run lint` beziehungsweise fokussierter Lint fuer geaenderte Dateien;
6. `npm run build`.

Commit: `Cover live collaboration agent runtime regressions`.

### Phase 6: Manuelle Zwei-User-Abnahme und Ticketabschluss

Nach ausdruecklicher Browser-/Playwright-Freigabe:

- User A und User B oeffnen dasselbe Live-Dokument in getrennten Sessions.
- Der echte Agent von User B liest den Live-State und aendert einen anderen
  Absatz direkt; beide Clients muessen konvergieren.
- Eine User-A-Aenderung zwischen Agent-Read und Edit erzeugt `stale_live_hash`
  mit `read_again` und keinen Apply.
- Eine strukturelle Rich-Markdown-Aenderung erscheint als persistierte Review;
  Accept und Reject werden jeweils separat abgenommen.
- Waehrend/nach dem Apply werden UI-, Operation- und Dateistatus mit
  `applied_to_ydoc -> persisted_yjs -> checkpointed_file` abgeglichen.
- Permission-Entzug unmittelbar vor Apply wird manuell fail-closed bestaetigt.
- Server-/Browserfehler und redigierte Toolresultate werden als Abnahmebeleg
  festgehalten.

Danach Ticketstatus und Index aktualisieren und nur die Abschlussdokumentation
committen.

Commit: `Document ticket 23 acceptance`.

## Risiken, Migration und Rollback

### Risiken

- **Stochastischer Modelllauf:** Die manuelle Reproduktion braucht einen
  echten Agent-Call, die dauerhafte Regression muss Toolparameter jedoch mit
  kontrolliertem Stream deterministisch erzeugen.
- **In-Process-Bridge:** Reader und Direct Connection liegen auf `globalThis`.
  Doppelte Modulinstanzen, Test-Child-Prozesse oder ein spaeteres Multi-Node-
  Setup koennen unterschiedliche Bridges sehen.
- **DB-geteilte Dokumentidentitaet:** Metadata und Yjs-State liegen aktuell in
  verschiedenen Repository-Grenzen. Ein halbfertiger Datensatz darf nicht
  automatisch repariert oder neu erzeugt werden.
- **Langlebige Runtime:** Ein frisch aufgeloester Tool-Context darf den
  Workspace einer laufenden Session nicht still migrieren; er muss den
  gespeicherten Session-Workspace revalidieren.
- **Hash-Semantik:** kanonischer LF-/BOM-freier Live-Hash und serialisierter
  Datei-Hash duerfen nicht verwechselt werden.
- **Statusrennen:** Yjs kann sichtbar angewendet sein, obwohl Persistence oder
  Checkpoint spaeter scheitert. Rollback darf dann keinen unsicheren
  Whole-File-Overwrite ausloesen.
- **Rich-Markdown-Review:** Accept gegen einen inzwischen geaenderten Baum kann
  erneut Review/Konflikt ergeben; dies ist korrekt und darf nicht erzwungen
  werden.
- **Ticket 24:** dessen spaetere allgemeine Stale-/Retry-Guidance muss die hier
  festgelegten Collaboration-Codes wiederverwenden, aber Ticket 23 implementiert
  keine automatische Edit-Buendelung.

### Datenmigration

Voraussichtlich ist keine neue Tabelle erforderlich: Operation, Identity,
State-Vector, Lifecycle und Durability sind bereits persistiert. Neue
strukturierte Tooldetails werden in der vorhandenen PI-Message-Persistenz
abgelegt.

Falls Phase 0 eine inkonsistente Metadata-/Postgres-Dokumentzuordnung belegt,
wird vor einer Migration ein read-only Audit geplant, das aktive
`workspaceId + path + provider`-Paare mit `collaboration_yjs_states` vergleicht.
Automatische Neuzuordnung, Loeschung oder State-Neuanlage ist nicht Teil dieses
Tickets ohne gesonderte Freigabe und Backup-/Rollback-Konzept.

### Rollback

- Jeder fokussierte Commit muss einzeln revertierbar bleiben.
- Bei Problemen wird der neue Agent-Apply-Pfad fail-closed deaktiviert;
  bestehende menschliche Collaboration bleibt aktiv/read-only gemaess Health.
- Es gibt keinen Rollback auf Whole-File-Write, Checkpoint-Text oder
  clientseitigen Overwrite fuer ein aktives Yjs-Dokument.
- Persistierte Review-Operationen und bereits bestaetigte Yjs-States werden bei
  Code-Rollback nicht geloescht.
- Additive Resultatfelder bleiben waehrend Rollback kompatibel; alte Clients
  duerfen unbekannte Felder ignorieren.

## Automatisierte Abnahmekriterien

Die Umsetzung gilt technisch erst als abgeschlossen, wenn alle folgenden
Kriterien nachgewiesen sind:

- ein Test startet mit echter gespeicherter Team-Session ueber
  `resolveAgentExecutionContextForSession` und `getPiTools`, nicht ueber
  direkten `piTools`-Import;
- `read` und `edit_file` verwenden unveraendert dieselbe Dokument-ID,
  Representation, Generation und denselben Live-Hash;
- eine zwischenzeitliche User-Aenderung liefert `stale_live_hash` und mutiert
  weder Yjs-State noch Dateicheckpoint;
- ein stabiler nicht ueberlappender Plain-/Rich-Text-Edit wird direkt
  angewendet und erreicht die drei Durability-Stufen in Reihenfolge;
- eine strukturelle Rich-Markdown-Aenderung erzeugt eine persistierte Review,
  deren Accept und Reject idempotent funktionieren;
- Direct-Connection-Ausfall, Persistence-Fehler und Checkpoint-Fehler besitzen
  unterscheidbare Codes und Status;
- ein Persistence-Fehler nach Apply meldet niemals `checkpointed_file` oder
  einen falschen Saved-Status;
- fremder User, fremde Session, falscher Agent, falscher Workspace, archivierte
  Generation und entzogene Rechte blockieren vor Apply;
- Toolresultat, Runtime-Event, gespeicherte PI-Nachricht und Chat-UI behalten
  Code, Outcome, Operation-ID, Durability und Folgeaktion;
- Retry mit identischem Idempotency-Key wendet genau einmal an;
- Restart spielt keinen unsicheren oder bereits angewendeten Edit erneut ab;
- nicht kollaborative Dateien, persoenliche Workspaces und `apply_patch`
  zeigen keine Regression;
- `npm run build` besteht vor jedem spaeter ausdruecklich angeforderten
  Container-Build.

## Manuelle Abnahmekriterien

- User A und User B sehen denselben live konvergierten Stand, nachdem der von
  User B beauftragte Agent einen anderen Absatz geaendert hat.
- Agent-Presence und Operations-UI zeigen Agent plus Auftraggeber korrekt.
- Der Agent sieht bei Stale-State eine konkrete Read-again-Anweisung und
  umgeht sie nicht mit `write` oder Shell.
- Ein Review ist in der Editor-UI sichtbar, vergleichbar und mit Accept/Reject
  bedienbar; unbeteiligte parallele User-Aenderungen bleiben erhalten.
- Die UI unterscheidet live angewendet, Yjs-persistiert, Datei-checkpointed,
  Review, Konflikt, degraded und technisch fehlgeschlagen.
- Ein Rechteentzug vor Apply verhindert die Aenderung in beiden Clients.
- Nach Reconnect und dem fuer Restart freigegebenen Test bleibt der bestaetigte
  Inhalt erhalten und die Workspace-Datei stimmt mit dem letzten
  `checkpointed_file`-Stand ueberein.

## Nicht-Ziele

- keine neue Collaboration-Engine oder parallele CRDT-Implementierung;
- kein Whole-File-Fallback fuer aktive Yjs-Dokumente;
- keine automatische Stale-State-Wiederholung;
- keine allgemeine Edit-Buendelung aus Ticket 24;
- keine Excalidraw-Aenderung;
- keine Multi-Node-/Redis-/NATS-Einfuehrung;
- keine Datenbereinigung oder produktive Migration ohne eigenen Befund und
  Freigabe;
- kein Container-Build und keine Browser-/Playwright-Ausfuehrung waehrend der
  reinen Planungsaufgabe.
