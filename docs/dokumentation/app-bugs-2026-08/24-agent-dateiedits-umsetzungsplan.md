---
title: 'Umsetzungsplan zu Ticket 24: Agent-Dateiedits buendeln und Stale-State-Feedback verbessern'
status: planned
date: 2026-08-21
platforms: [server, agent-runtime, web]
tags: [type/implementation-plan, topic/agents, topic/tools, topic/files, topic/live-collaboration]
---

# Umsetzungsplan: Agent-Dateiedits buendeln und Stale-State-Feedback verbessern

## Ziel, Scope und Arbeitsmodus

Dieser Plan konkretisiert [Ticket 24](./24-agent-dateiedits-buendeln-und-stale-state-feedback.md)
auf Basis des Codebestands in Commit `1c589a23`. Er ist ausschliesslich die
Planung fuer den Agent-Dateiworkflow aus `read`, `edit_file`, `apply_patch` und
`write`, die dazugehoerigen Runtime-Resultate sowie deren Chat-Darstellung.

Die spaetere Implementierung erfolgt strikt sequenziell. Eine Phase beginnt
erst, wenn die vorherige Phase implementiert, mit den dort genannten Tests
verifiziert und als eigener fokussierter Commit abgeschlossen ist. Container
sind fuer dieses Ticket nicht erforderlich und werden nicht gebaut. Ein
Browser-/Playwright-Test erfolgt nur nach ausdruecklicher Freigabe.

Nicht Teil dieses Tickets sind:

- die Capability-/Prompt-Architektur aus Ticket 18 selbst;
- die Reparatur des Live-Collaboration-Apply-Pfads aus Ticket 23;
- neue Dateiformate, Shell-Schreibwege oder ein allgemeiner Transaktionsdienst
  fuer beliebige Dateisystemoperationen;
- ein automatisches Merge, Force-Overwrite oder blinder Retry nach Konflikten;
- eine verteilte All-or-nothing-Garantie ueber mehrere Dateien oder mehrere
  aktive Collaboration-Dokumente.

## Abhaengigkeiten und verbindliche Integrationsgates

### Ticket 18 ist eine harte fachliche Abhaengigkeit

[Ticket 18](./18-agent-system-prompts-an-tools-koppeln.md) ist noch offen. Der
aktuelle feste Basisprompt beschreibt Dateiwerkzeuge unabhaengig vom
tatsaechlichen Toolset eines Runs. Gleichzeitig werden Tools erst spaeter in
`getPiTools(...)` nach Agentenkonfiguration, Workspace-Kontext, Automation,
Delegation und Runtime-Verfuegbarkeit gefiltert.

Ticket 24 darf deshalb keine konkurrierende finale Prompt- oder
Tool-Capability-Architektur einfuehren. Vor dem ersten Produktivcode-Commit
muss Ticket 18 abgeschlossen und sein tatsaechlicher Vertrag dokumentiert
sein. Ticket 24 konsumiert danach dessen einen kanonischen Mechanismus fuer:

- die effektiven Tools des konkreten Runs;
- capability-gebundene Guidance;
- Prompt-Snapshot-Erzeugung und -Invalidierung;
- Reload, Delegation und Automation.

Die konkrete Funktion beziehungsweise Datei, in der Ticket 18 diese Guidance
verankert, bleibt bis zu dessen Abschluss absichtlich offen. Die fachliche
Entscheidungsmatrix aus diesem Plan ist verbindlich; ihre technische
Prompt-Einbettung wird nicht vorweggenommen.

### Ticket 23 ist eine koordinierte Schnittstelle, kein Teil-Scope

[Ticket 23](./23-agent-edits-in-live-collaboration-reparieren.md) ist ebenfalls
offen und besitzt dieselben Integrationsgrenzen in `core-tools.ts`,
`agent-file-operations.ts` und `agent-file-edits.ts`. Ticket 24 veraendert
nicht die fachliche Yjs-/Review-Entscheidung. Es uebernimmt nach Ticket 23 die
dort festgelegten stabilen Collaboration-Fehlercodes und Statusnamen, sofern
sie bis dahin eingefuehrt wurden.

Verbindliche Grenze:

- Ein `read` auf ein aktives Markdown-/Text-Collaboration-Dokument liest den
  autoritativen Live-Yjs-State.
- `edit_file` und `apply_patch` verwenden zielverankerte Yjs-Operationen oder
  persistierte Reviews.
- `write` darf ein aktives Collaboration-Dokument weder direkt noch als
  Fallback auf den materialisierten Datei-Checkpoint ueberschreiben.
- `afterSha256` eines Review-Ergebnisses bezeichnet den weiterhin aktuellen
  Live-State; `proposedSha256` bezeichnet nur den Vorschlag. Der Agent darf den
  Vorschlagshash nicht als neue Edit-Basis behandeln.
- Ein semantischer Collaboration-Konflikt wird als Review-/Konfliktzustand
  erhalten und nicht in einen normalen Hash-Retry umgedeutet.

## Inventur des bestehenden Stands

### Prompt und effektive Tooltexte

- `app/lib/agents/base-system-prompt.ts`
  - `CANVAS_BASE_TOOL_GUIDANCE` nennt `edit_file` fuer exakte Ersetzungen,
    `apply_patch` fuer mehrere koordinierte Ersetzungen und `write` fuer neue
    Dateien oder Full Rewrites.
  - Es fehlt eine vollstaendige Matrix fuer Einzel-Edit, gebuendelte bekannte
    Edits, sequenziellen Folge-Edit, unklaren Zustand und Live Collaboration.
- `app/lib/agents/system-prompt-shared.ts`
  - bindet die Basis-Guidance statisch in jeden zusammengesetzten Prompt ein;
  - persistierte Session-Prompts werden als Snapshots gespeichert.
- `app/lib/agents/system-prompt.ts`
  - erzeugt fuer spezialisierte Agenten eine Toolliste aus globalen Metadaten
    und konfigurierten Overrides, nicht aus dem final gefilterten Run-Toolset.
- `app/lib/pi/system-prompt-snapshot.ts`
  - laedt bestehende Snapshots weiter und regeneriert sie nur bei expliziter
    Invalidierung oder fehlendem Snapshot.
- `app/lib/pi/core-tools.ts`
  - ist heute die kanonische Registry fuer die tatsaechlichen Beschreibungen
    und Schemas von `read`, `write`, `edit_file` und `apply_patch`;
  - die Beschreibungen erwaehnen Revisionen und Collaboration, aber noch nicht
    durchgaengig die neue Entscheidungsmatrix und den sicheren Folgeworkflow.
- `app/lib/pi/tool-registry.ts` und `app/lib/pi/toolsets.ts`
  - filtern die Tools fuer Hauptagent, spezialisierten Agenten, Delegation und
    Automation; der File-Toolset enthaelt alle vier betroffenen Werkzeuge.

Die endgueltige Kopplung dieser Texte an das effektive Toolset gehoert zu
Ticket 18. Ticket 24 liefert dafuer nur die Dateiworkflow-Semantik.

### Read-, Mutation- und Hash-Vertrag

- `read` liefert fuer Textdateien den SHA-256 sowohl im sichtbaren Text als
  auch in `details.sha256`.
- Bei aktiver Collaboration stammt dieser Hash bereits aus dem kanonischen
  Live-Yjs-Inhalt; `details.collaboration.source` ist `live_yjs`.
- `AgentFileChangeResult` in `app/lib/pi/agent-file-operations.ts` enthaelt
  `path`, `beforeSha256`, `afterSha256`, Diff, Validierung, Snapshot und
  optional Collaboration-Status.
- `app/lib/pi/tool-file-formatters.ts` zeigt `After SHA-256` auch im sichtbaren
  Tooltext. `core-tools.ts` legt das unverkuerzte Ergebnis zusaetzlich in
  `details` beziehungsweise bei `apply_patch` in `details.results` ab.
- `writeAgentTextFile`, `editAgentFile` und `applyAgentFilePatch` vergleichen
  `expectedSha256` bereits vor der Mutation. Bestehende Dateien in Shared
  Workspaces verlangen zwingend einen erwarteten Hash.
- `scripts/file-revision-guard-test.ts` belegt bereits, dass der von einer
  erfolgreichen Mutation gelieferte `afterSha256` als Basis fuer einen
  bewusst sequenziellen Folge-Edit funktioniert.

### Fehler- und UI-Vertrag

- Der allgemeine File-Service besitzt mit `WorkspaceFileRevisionError` bereits
  stabile Codes `FILE_REVISION_REQUIRED` und `FILE_REVISION_CONFLICT` sowie
  `expectedSha256`, `currentSha256` und aktuelle Stats.
- Die Agent-Dateioperationen werfen fuer dieselben Situationen dagegen meist
  generische `Error`-Objekte mit reinem Meldungstext.
- Die Catch-Bloecke in `core-tools.ts` reduzieren Fehler auf
  `details: { error: message }`; `code`, Kategorie, Pfad, aktueller Hash und
  Folgeaktion gehen verloren.
- Die Live Runtime reicht ein Toolresultat mit `details` an den WebSocket-Client
  weiter, und die Persistenzprojektion behaelt kleine Detailobjekte bei.
- `useChatRuntimeEvents.ts` setzt ein `tool_execution_end` derzeit jedoch
  pauschal auf `isError: false` und Chat-Status `sent`. Ein vom Tool als Text
  zurueckgegebener Fehler erscheint daher visuell als `Fertig`.
- `ToolOutputView.tsx` parst erfolgreiche Dateiresultate aus formatiertem Text.
  Es gibt keine strukturierte Karte fuer Sicherheitskonflikt, Reviewbedarf
  oder technischen Fehler.
- `tool-loop-guard.ts` erkennt Fehler heute heuristisch ueber `details.error`
  oder ein `Error:`-Praefix und stoppt nur identische, wiederholt fehlschlagende
  Calls. Erfolgreiche, aber unguenstig aufgeteilte `edit_file`-Folgen werden
  nicht erkannt.

### Verhalten von `apply_patch`

- `applyAgentFilePatch` lehnt leere Patches, leere Editlisten, fehlende Dateien
  und denselben kanonischen Pfad in zwei `files[]`-Eintraegen ab.
- Innerhalb eines Dateieintrags werden alle exakten Ersetzungen auf einem
  gemeinsamen gelesenen Ausgangsinhalt berechnet. Dadurch ist die fachliche
  Reihenfolge der bekannten Ersetzungen deterministisch.
- Alle Dateien werden heute vor dem ersten Write gelesen, auf Hash,
  Occurrence-Anzahl und Format validiert und in `prepared[]` gesammelt. Ein
  Fehler in diesem Preflight hinterlaesst daher noch keine Mutation.
- Anschliessend werden die vorbereiteten Dateien jedoch sequenziell committed.
  Direkt vor einem nicht kollaborativen Commit wird der aktuelle Dateihash
  nicht erneut gegen den Preflight-Hash geprueft.
- Ein externer Write zwischen Preflight und Commit kann dadurch eine neuere
  Datei ueberschreiben. Ein Fehler waehrend eines spaeteren Commits kann
  ausserdem bereits angewendete fruehere Dateien hinterlassen, waehrend der
  aktuelle Tooladapter nur einen Gesamtfehler ohne Teilstatus liefert.
- Fuer aktive Collaboration-Dokumente existiert bereits eine eigene
  persistierte Operations-/Saga-Semantik. Eine allgemeine verteilte
  All-or-nothing-Behauptung ueber mehrere Dokumente waere damit unvereinbar.

### Bestehende Tests

- `scripts/prompt-builder-test.ts`: statische Basisprompt-Komposition;
- `scripts/agent-runtime-config-test.ts`: konfigurierte Agent-Tooltexte und
  Prompt-Snapshots;
- `scripts/pi-tool-registry-test.ts`: Toolregistrierung, Einzel-Edit,
  gebuendelte Ersetzungen innerhalb einer Datei, Snapshots und Loop Guard;
- `scripts/file-revision-guard-test.ts`: Shared-Workspace-Hashpflicht sowie
  `afterSha256`-Weitergabe in einer sequenziellen Mutation;
- `scripts/file-agent-operation-integration-test.ts`: echter Live-Yjs-Read,
  stale Live-Hash, direkter Agent-Edit, Review und Collaboration-Sagas;
- `tests/file-live-collaboration.spec.ts`: Browser-E2E fuer Live-Read,
  `edit_file` und `apply_patch`;
- `tests/pi-chat.spec.ts`: Darstellung eines erfolgreichen Dateiresultats.

Noch nicht abgedeckt sind die effektive Entscheidungsmatrix aus Ticket 18,
strukturierte Agent-Stale-Resultate, ein externer Write im
Patch-Preflight/Commit-Fenster, sichtbare Teilresultate, nicht blockierende
Same-Path-Hinweise sowie die drei UI-Kategorien dieses Tickets.

## Belegte und vor Implementierung zu verifizierende Fehlerursachen

### Im Code belegte Ursachen

1. **Stale-Information geht an der Toolgrenze verloren.** Die tieferen
   File-APIs kennen strukturierte Revisionskonflikte, die Agent-Operationen und
   `core-tools.ts` geben aber nur einen String weiter.
2. **Der Folgehash ist vorhanden, aber nicht handlungsorientiert typisiert.**
   `afterSha256` steht in Text und Details, es fehlt jedoch eine
   maschinenlesbare Aussage, wann er fuer einen Folge-Edit geeignet ist.
3. **Die Promptmatrix ist zu grob und statisch.** Mehrere bekannte
   Aenderungen an derselben Datei werden nicht eindeutig einem einzigen
   `apply_patch` zugeordnet; die Guidance ist zudem nicht an den finalen
   Runtime-Toolbestand gekoppelt.
4. **Die Runtime klassifiziert Toolfehler nicht verlaesslich.** Ein Catch in
   `core-tools.ts` erzeugt ein regulaeres Resultat, und die Live-UI markiert
   das Endereignis als erfolgreich.
5. **`apply_patch` hat eine Race-Luecke nach dem Preflight.** Nicht
   kollaborative Dateien werden aus dem vorbereiteten Buffer geschrieben,
   ohne unmittelbar davor dessen Hash erneut zu bestaetigen.
6. **Multi-File-Fehler besitzen keinen Batchstatus.** Ein spaeter Fehler kann
   fruehere Erfolge verdecken; der Adapter behauptet zwar nicht explizit
   Atomaritaet, liefert aber auch keinen belastbaren Teilstatus.
7. **Same-Path-Folgen werden nur bei identischen Fehlern erkannt.** Der
   vorhandene Loop Guard beobachtet weder erfolgreiche `edit_file`-Calls noch
   normalisierte Zielpfade.

### Vor Phase 1 erneut zu verifizieren

- Welche Capability-/Prompt-API Ticket 18 tatsaechlich liefert und wie
  persistierte Prompt-Snapshots nach einer Guidance-Aenderung erneuert werden.
- Welche stabilen Conflict-, Review- und Durability-Codes Ticket 23 am Ende
  verwendet; Ticket 24 fuehrt keine konkurrierenden Synonyme ein.
- Ob `AgentToolResult.isError` in der eingesetzten PI-Version unverkuerzt an
  Modell, persistierte Message, Automation/Delegation und WebSocket gelangt.
- Ob Provideradapter `details` vollstaendig erhalten oder nur sichtbaren Text
  an das Modell geben; fuer Sicherheitsfelder muss beides konsistent sein.
- Ob parallele Tool-Calls innerhalb eines Modellturns moeglich sind. Der
  Same-Path-Zaehler und Patch-CAS muessen auch dann deterministisch bleiben.
- Welche File- und Collaboration-Locks bereits fuer eine kurze serialisierte
  Preflight-/Commit-Section wiederverwendet werden koennen, ohne einen zweiten
  Lockdienst zu schaffen.

## Architektur- und Sicherheitsentscheidungen

### 1. Eine fachliche Entscheidungsmatrix, capability-gebunden ausgespielt

Nach Abschluss von Ticket 18 verwendet der effektive Prompt und jede
betroffene Toolbeschreibung dieselben Begriffe:

| Ausgangslage | Workflow | Revisionsregel |
| --- | --- | --- |
| einzelne kleine, exakt bekannte Ersetzung | `read`, dann ein `edit_file` | Hash aus dem aktuellen Read |
| mehrere bereits bekannte Ersetzungen derselben Datei | `read`, dann ein `apply_patch` mit einem Dateieintrag und mehreren `edits[]` | genau ein Ausgangshash fuer die Datei |
| mehrere bereits bekannte Ersetzungen mehrerer Dateien | alle Ziel-Dateien lesen, dann ein `apply_patch` mit einem Eintrag pro kanonischem Pfad | ein Ausgangshash pro Datei |
| bewusst erst nach dem ersten Ergebnis planbarer Folge-Edit | `afterSha256` des **angewendeten** Ergebnisses als `expectedSha256` verwenden | nur innerhalb derselben kontrollierten Sequenz |
| Zustand unklar, Ergebnis war Review oder irgendein fremder Write ist moeglich | erneut `read`, danach neu planen | niemals Hash aus Fehlermeldung blind uebernehmen |
| neue Datei | `write` | kein bestehender Ausgangshash |
| grosse strukturelle Umschreibung einer bestehenden, nicht kollaborativen Datei | aktueller `read`, Ansatz ankündigen, danach der erlaubte Full-Write-/Review-Pfad | aktueller Hash zwingend in Shared Workspaces |
| aktive Live-Collaboration | zielgenaues `edit_file`/`apply_patch` oder struktureller Review aus Ticket 23 | Live-Yjs-Hash; kein Whole-File-Write |

Falls eines der genannten Tools im effektiven Run fehlt, darf der Prompt es
nicht nennen und keine gleichwertige Schreibfaehigkeit behaupten. Ein Agent
ohne `apply_patch` erhaelt daher auch keine Aufforderung, dieses Tool zu
verwenden. Die erlaubte Ersatzhandlung wird durch Ticket 18 aus den effektiven
Capabilities abgeleitet; Sicherheit und Berechtigung bleiben serverseitig.

### 2. Ein versionierter, additiver Datei-Toolresultatvertrag

Die vier Dateiwerkzeuge erhalten einen gemeinsamen kleinen Resultatvertrag.
Bestehende Felder und der menschenlesbare Text bleiben zunaechst kompatibel;
neue Consumer verwenden `details.contractVersion` und strukturierte Felder.

Erfolgsbeispiel:

```ts
type AgentFileMutationSuccess = {
  contractVersion: 1;
  kind: 'file_mutation';
  outcome: 'applied' | 'unchanged' | 'review_required';
  category: 'success' | 'review_required';
  operation: 'write' | 'edit_file' | 'apply_patch';
  path: string;                 // kanonischer Workspace-relativer Pfad
  changed: boolean;
  beforeSha256: string | null;
  afterSha256: string;          // tatsaechlich aktueller Zustand nach Resultat
  proposedSha256?: string;      // nur fuer noch nicht angenommene Review
  recommendedAction:
    | 'none'
    | 'reuse_after_sha256_if_sequential'
    | 'review_in_editor'
    | 'consider_apply_patch';
  safeToAutoRetry: false;
  collaboration?: {
    documentId?: string;
    operationId: string;
    operationStatus: string;
    durability: string;
    reviewRequired: boolean;
  };
};
```

Stale-/Revisionsfehler:

```ts
type AgentFileMutationError = {
  contractVersion: 1;
  kind: 'file_mutation_error';
  outcome: 'blocked';
  category: 'safety_conflict' | 'technical_error';
  code: string;
  operation: 'write' | 'edit_file' | 'apply_patch';
  path: string;
  message: string;
  expectedSha256: string | null;
  currentSha256: string | null;
  recommendedAction: 'read_then_retry' | 'inspect_error';
  safeToAutoRetry: false;
};
```

Fuer einen normalen Hashkonflikt werden die bestehenden Codes
`FILE_REVISION_CONFLICT` beziehungsweise `FILE_REVISION_REQUIRED`
wiederverwendet. Ein von Ticket 23 eingefuehrter spezifischer
Collaboration-Code bleibt erhalten und wird nur derselben Kategorie und
Folgeaktion zugeordnet. `currentSha256` ist Diagnoseinformation, keine
Freigabe zum sofortigen Retry: `recommendedAction: read_then_retry` und
`safeToAutoRetry: false` sind immer gemeinsam zu setzen.

Ein Review ist kein technischer Fehler und kein angewendeter Erfolg. Es traegt
`category: review_required`, `recommendedAction: review_in_editor`, den
aktuellen `afterSha256` und getrennt den `proposedSha256`.

### 3. Fehler werden an einer gemeinsamen Adaptergrenze serialisiert

Eine kleine gemeinsame Fehlernormalisierung, beispielsweise in einem neuen
`app/lib/pi/agent-file-tool-results.ts`, mappt bekannte Domainfehler auf den
Vertrag. `write`, `edit_file` und `apply_patch` duplizieren diese Logik nicht.

Die Domain-Schicht wirft weiterhin typisierte Fehler; der Tooladapter erzeugt
ein `AgentToolResult` mit strukturierten Details und `isError: true` fuer
Sicherheitskonflikte und technische Fehler. Das Modell erhaelt dieselben
Kernaussagen zusaetzlich als knappen Text. UI und Runtime duerfen die Kategorie
nicht aus lokalisiertem Text erraten.

Workspace-, Permission-, Lock-, Collaboration- und Revisionspruefungen werden
nicht zusammengelegt oder abgeschwaecht. Die Normalisierung klassifiziert nur
das Ergebnis; sie autorisiert keine Mutation.

### 4. `afterSha256` ist nur nach bestaetigtem Zustand eine Folge-Revision

- `applied` und `unchanged` liefern den bestaetigten aktuellen Hash.
- Ein bewusst sequenzieller Folge-Edit darf diesen Wert innerhalb desselben
  Runs verwenden.
- `review_required` liefert zwar den aktuellen Hash, empfiehlt aber Review und
  niemals einen Folge-Edit auf Basis des Vorschlags.
- `partially_applied`, `safety_conflict`, `degraded` und technische Fehler
  verlangen einen neuen Read der noch zu bearbeitenden Dateien.
- Batchresultate liefern pro Datei einen eigenen `afterSha256`; es gibt keinen
  synthetischen Hash fuer den gesamten Batch.

### 5. `apply_patch` ist pro Datei atomar, ueber Dateien eine sichtbare Saga

Ein Dateieintrag mit mehreren `edits[]` wird aus genau einem aktuellen Inhalt
berechnet, komplett validiert und als ein fachlicher Commit angewendet. Direkt
vor diesem Commit wird der aktuelle autoritative Hash erneut gegen den
Preflight-Hash geprueft. Bei aktiver Collaboration uebernimmt Ticket 23 die
serialisierte Revalidierung und Gruppenatomicity.

Fuer mehrere Dateien gilt:

1. Alle Pfade kanonisieren und Duplikate ablehnen.
2. Alle Dateien lesen und alle Hash-, Occurrence-, Format-, Permission- und
   Collaboration-Preflights abschliessen, bevor irgendein Commit beginnt.
3. Ein Preflight-Fehler setzt den Batch auf `not_applied`; keine Datei wurde
   veraendert.
4. Beim Commit jede Datei unmittelbar vorher gegen ihren Preflight-Zustand
   revalidieren.
5. Schlaegt ein spaeter Commit nach frueheren Erfolgen fehl, den Batch als
   `partially_applied` mit explizitem Status pro Datei zurueckgeben. Nicht
   gestartete Dateien sind `not_applied`, konfliktbehaftete `blocked` und
   bereits angewendete `applied`.
6. Keine automatische Kompensation oder Rueckschreibung versuchen. Diese
   koennte inzwischen neue Arbeit ueberschreiben. Der Agent liest die offenen
   Pfade erneut und plant bewusst weiter.

Damit behauptet der Vertrag keine nicht vorhandene verteilte Atomaritaet und
bleibt mit der Cross-Document-Saga aus der Collaboration-Architektur
vereinbar.

### 6. Same-Path-Hinweise sind laufzeitlokal und nicht blockierend

Der bereits vorhandene `afterToolCall`-Mechanismus wird um eine getrennte,
komponierbare File-Workflow-Beobachtung erweitert. Pro User-Turn werden nur
folgende fluechtige Daten gehalten:

- Toolname;
- kanonischer Workspace-relativer Pfad;
- Anzahl erfolgreicher `edit_file`-Mutationen dieses Pfads;
- ob der letzte Aufruf den vorherigen `afterSha256` korrekt verwendet hat.

Ab dem zweiten erfolgreichen `edit_file` desselben Pfads kann das Resultat
einen nicht blockierenden Hinweis `recommendedAction: consider_apply_patch`
erhalten. Ein korrekt gehashter, bewusst sequenzieller Folge-Edit bleibt
erfolgreich. Der Hinweis resetet beim naechsten User-Turn und ist unabhaengig
vom bestehenden Failure Loop Guard.

Dateiinhalte, `oldText`, `newText`, Diffs und Hashes werden fuer diesen Zaehler
nicht dauerhaft gespeichert oder in neue Telemetrie geschrieben. Falls eine
Metrik benoetigt wird, ist nur ein aggregierter Counter ohne Pfad und Inhalt
zulaessig.

### 7. UI unterscheidet Ergebnisarten aus strukturierten Details

Die Chat-Darstellung leitet den Status aus `category`, `outcome` und
`isError` ab:

- `success`: neutral/gruen, inklusive Diff und Folgehash;
- `review_required`: eigener Hinweis mit Operation-/Durability-Status und
  Verweis auf Accept/Reject im Editor;
- `safety_conflict`: klarer Konflikthinweis mit `Erneut lesen und neu planen`,
  nicht als generischer Absturz;
- `technical_error`: Fehlerstatus mit technischer Meldung, ohne
  Review-Behauptung.

Der formatierte Text bleibt als Fallback fuer alte gespeicherte Messages. Neue
Darstellung und Accessibility-Labels verwenden die strukturierten Details und
deutsche/englische Uebersetzungen.

## Daten- und API-Vertraege im Detail

### Einzelmutation

- `details` ist das kanonische maschinenlesbare Resultat.
- Der sichtbare Text enthaelt mindestens Operation, Pfad, Outcome,
  `afterSha256` bei Erfolg und die empfohlene Aktion bei Konflikt.
- `path` wird nach erfolgreicher Resolver-/Workspace-Pruefung als
  kanonischer Workspace-relativer Pfad ausgegeben. Absolute Runtime-Pfade
  bleiben allenfalls in bereits autorisierten internen Auditdaten.
- `safeToAutoRetry` ist fuer jede schreibende Dateioperation `false`; auch ein
  idempotenter Collaboration-Key ersetzt keinen neuen Read nach Stale State.

### Patch-Batch

```ts
type AgentFilePatchBatchResult = {
  contractVersion: 1;
  kind: 'file_patch_batch';
  outcome: 'applied' | 'unchanged' | 'not_applied' | 'partially_applied' | 'review_required';
  category: 'success' | 'review_required' | 'safety_conflict' | 'technical_error';
  results: Array<AgentFileMutationSuccess | AgentFileMutationError>;
  recommendedAction: 'none' | 'read_then_retry' | 'review_in_editor';
  safeToAutoRetry: false;
};
```

Invarianten:

- Die Reihenfolge von `results[]` entspricht der normalisierten
  Eingabereihenfolge.
- Jeder kanonische Pfad kommt genau einmal vor.
- `outcome: applied` ist nur erlaubt, wenn alle Dateieintraege angewendet oder
  nachweislich unveraendert sind und kein Review offen ist.
- `not_applied` nach Preflight enthaelt keine scheinbar erfolgreichen
  Dateieintraege.
- `partially_applied` nennt jeden bereits sichtbaren Seiteneffekt.
- Ein Resultat fuer aktive Collaboration behaelt `operationId`, Status,
  Durability, Reviewflag und `proposedSha256` unverkuerzt.

### Fehlercodes und Kategorien

| Domainzustand | Code | Kategorie | Folgeaktion |
| --- | --- | --- | --- |
| erwarteter Hash fehlt | `FILE_REVISION_REQUIRED` | `safety_conflict` | `read_then_retry` |
| erwarteter Hash ist veraltet / Datei fehlt inzwischen | `FILE_REVISION_CONFLICT` | `safety_conflict` | `read_then_retry` |
| Exact-Text-Vorkommen stimmt nicht | bestehender `ExactTextPatchError.code`, stabil namespacen | `safety_conflict` | `read_then_retry` |
| aktiver Yjs-Zustand ist stale | Code aus Ticket 23, sonst auf gemeinsamen Revision-Conflict abbilden | `safety_conflict` | `read_then_retry` |
| struktureller/semantischer Collaboration-Review | Code/Status aus Ticket 23 | `review_required` | `review_in_editor` |
| Permission, Workspace oder Lock blockiert | bestehender Policycode erhalten | `safety_conflict` | `inspect_error` beziehungsweise neuer Read nach Freigabe |
| Persistenz/Checkpoint degraded | Code aus Collaboration-Domain | `technical_error` oder eigener nicht-erfolgreicher Durability-Status aus Ticket 23 | `inspect_error` |
| unerwartete I/O-/Validierungsstörung | stabiler technischer Obercode plus redigierte Meldung | `technical_error` | `inspect_error` |

Die genaue Benennung neuer Collaboration-Codes wird erst nach Ticket 23
finalisiert. Bestehende Codes werden nicht ohne Migrationsgrund umbenannt.

## Strikt sequenzielle Implementierungsphasen

### Phase 0: Abhaengigkeiten abschliessen und Vertrag einfrieren

- Den gemergten Stand von Ticket 18 vollstaendig gegen diesen Plan pruefen:
  effektive Toolquelle, Prompt-Guidance-Hook, Snapshot-Lifecycle, Delegation,
  Automation und Reload.
- Den aktuellen Stand von Ticket 23 an den gemeinsamen Dateien und
  Resultatcodes pruefen; keine Ticket-23-Fehlerursache nebenbei reparieren.
- Die oben beschriebenen Resultattypen, Code-Mappings und
  Batch-Semantik als kurze technische Vertragsnotiz finalisieren.
- Baseline-Tests fuer bestehendes Verhalten ausfuehren.
- Gate: Keine Produktivcode-Aenderung, solange Ticket 18 offen oder die
  gemeinsame Ownership von `core-tools.ts`/Prompt-Dateien ungeklärt ist.
- Verifikation: Dokumentationskonsistenz und Baseline der gezielten Tests.
- Commit: `Define agent file workflow contracts`.

### Phase 1: Typisierte Domain- und Toolresultate

- Eine gemeinsame Dateiresultat-/Fehlernormalisierung einfuehren.
- Agent-Dateioperationen fuer Revision-required, Revision-conflict,
  Occurrence-mismatch und bekannte Collaboration-/Policyfehler typisiert
  durchreichen.
- Erfolgsresultate additiv um `contractVersion`, `kind`, `operation`,
  `outcome`, `category`, `recommendedAction` und `safeToAutoRetry` erweitern.
- `path` nach Resolver-Pruefung kanonisch und workspace-relativ ausgeben.
- `core-tools.ts` auf den gemeinsamen Serializer umstellen und fuer echte
  Fehler `isError: true` setzen.
- Verifikation: neue fokussierte Contracttests sowie bestehende
  `file-revision-guard`- und `pi-tool-registry`-Tests.
- Commit: `Structure agent file tool results`.

### Phase 2: Patch-Preflight und Commit-Sicherheit

- `applyAgentFilePatch` intern klar in Resolve/Read/Preflight und Commit
  trennen.
- Pro kanonischem Pfad genau einen Preflight-Snapshot und Hash verwenden.
- Alle Preflightfehler vor dem ersten Commit sammeln beziehungsweise den
  Batch sicher abbrechen; keine Mutation starten.
- Direkt vor jedem nicht kollaborativen Commit Hash, Existenz, Workspace,
  Permission, Lock und Collaboration-Uebergang erneut pruefen.
- Fuer eine Datei alle Edits in genau einem validierten Commit anwenden.
- Multi-File-Commit als explizite Saga mit `not_applied`/
  `partially_applied` und Status pro Datei zurueckgeben; keine blinde
  Kompensation.
- Ticket-23-Operationen fuer aktive Dokumente unveraendert als autoritative
  Commitgrenze verwenden.
- Verifikation: Preflight-Fehler an Datei 2 laesst Datei 1 unveraendert;
  injizierter Zwischenwrite wird nicht ueberschrieben; injizierter spaeter
  Commitfehler meldet korrekten Teilstatus; Duplicate-Path- und
  Collaboration-Regressionstests.
- Commit: `Harden bundled file patch commits`.

### Phase 3: Resultatweitergabe in allen Runtime-Pfaden

- Haupt-Chat-Runtime, temporaere Delegation, Managed-Delegation und Automation
  gegen denselben Resultatvertrag testen.
- Sicherstellen, dass `details`, `isError`, `afterSha256`, Pfad,
  Collaboration-/Review-Status und `recommendedAction` den Modellkontext,
  WebSocket, Persistenz und geladene Context-/Display-Projektion erreichen.
- Projektionen duerfen grosse Diffs weiter kuerzen, aber die kleinen
  Sicherheits- und Folgeaktionsfelder nicht entfernen.
- Den bestehenden Loop Guard auf strukturierte Fehlerkategorien umstellen,
  mit Textheuristik nur als Rueckwaertskompatibilitaets-Fallback.
- Verifikation: Adapter-/Projectiontests fuer Live Chat, Reload, Delegation und
  Automation; keine Provider- oder Toolset-Rechteausweitung.
- Commit: `Preserve file mutation outcomes across runtimes`.

### Phase 4: Laufzeitlokale Same-Path-Guidance

- Einen eigenen File-Workflow-Observer mit dem vorhandenen `afterToolCall`-
  Hook komponieren; der Failure Loop Guard bleibt separat.
- Pfade nach Workspace und Resolver normalisieren, bevor gezaehlt wird.
- Pro User-Turn erfolgreiche `edit_file`-Aufrufe zaehlen und bei der zweiten
  Mutation einen nicht blockierenden `consider_apply_patch`-Hinweis ergaenzen.
- Korrekte Nutzung des unmittelbar vorherigen `afterSha256` erkennen, ohne den
  Folge-Edit zu blockieren.
- Bei Parallelcalls deterministische Reihenfolge ueber Tool-Endereignis und
  Tool-Call-ID definieren.
- Bei neuem User-Turn, Runtime-Recreate und Abbruch den Zustand loeschen.
- Keine Inhalte oder pfadbezogenen Verlaufsdaten persistieren.
- Verifikation: erster Edit ohne Hinweis; zweiter Same-Path-Edit mit Hinweis;
  anderer Pfad ohne Hinweis; Turn-Reset; Fehlercall zaehlt nicht; keine
  Telemetrieinhalte.
- Commit: `Guide repeated edits toward bundled patches`.

### Phase 5: Effektive Prompt- und Tool-Guidance integrieren

- Die Entscheidungsmatrix in den von Ticket 18 bereitgestellten
  capability-gebundenen Guidance-Mechanismus integrieren.
- `read`, `write`, `edit_file` und `apply_patch` in `core-tools.ts` mit exakt
  denselben Begriffen fuer aktuellen Read, Ausgangshash, Folgehash,
  `read_then_retry`, Review und fehlenden Auto-Retry beschreiben.
- Toolkombinationen testen: alle Filetools; Read/Edit ohne Patch; Read-only;
  keine Filetools; Delegation/Automation mit reduziertem Toolset.
- Persistierte Prompt-Snapshots nach dem in Ticket 18 definierten Mechanismus
  gezielt invalidieren beziehungsweise versionieren, damit neue Guidance nicht
  nur neue Sessions erreicht.
- Keine nicht verfuegbare Capability im Prompt suggerieren.
- Verifikation: Prompt-Builder-, Tool-Registry-, Snapshot-, Reload-,
  Delegations- und Automation-Tests.
- Commit: `Align effective file editing guidance`.

### Phase 6: Chat-UI fuer Erfolg, Konflikt, Review und Fehler

- Live-Event-Mapping so korrigieren, dass strukturierte Toolfehler nicht als
  `Fertig` erscheinen.
- `ChatToolRunMessages` und `ToolOutputView` um strukturierte, zugängliche
  Zustandskarten fuer `safety_conflict`, `review_required` und
  `technical_error` erweitern.
- Erfolgs-Diff, Folgehash und Same-Path-Hinweis erhalten; Review zeigt
  Operation/Durability und verweist auf den Editor.
- Deutsche und englische Texte sowie Accessibility-Labels ergaenzen.
- Alte, nur textuelle Toolmessages weiter lesbar darstellen.
- Verifikation: Komponenten-/Mappingtests ohne Browser; anschliessend
  `npm run build`.
- Optional erst nach ausdruecklicher Freigabe: Playwright-Abnahme auf dem
  bereits laufenden beziehungsweise einmalig auf `localhost:3000` gestarteten
  Dev-Server. Kein Port 3001.
- Commit: `Differentiate file tool outcomes in chat`.

### Phase 7: Gesamtabnahme und Ticketabschluss

- Alle unten genannten automatisierten Matrizen ausfuehren.
- Gezieltes ESLint fuer betroffene Dateien und abschliessend `npm run build`.
- Manuelle Agent-Abnahme mit derselben Aufgabe vor und nach der Aenderung:
  drei bekannte Aenderungen an einer Datei, ein bewusst sequenzieller Edit und
  eine externe Zwischenmutation.
- Mit separater ausdruecklicher Browserfreigabe zusaetzlich Team-Workspace und
  aktive Live Collaboration in zwei Browser-Sessions pruefen.
- Erst nach vollstaendiger Abnahme Ticketstatus und Index auf `erledigt`
  setzen.
- Abschlusscommit: `Complete agent file edit workflow ticket`.

## Automatisierte Testmatrix

| Ebene | Positiver Fall | Konflikt-/Sicherheitsfall |
| --- | --- | --- |
| Prompt/Capabilities | effektiver Agent mit `read`, `edit_file`, `apply_patch` sieht die komplette Matrix | Agent ohne Patch-/Filetools erhaelt keine entsprechende Behauptung |
| Einzel-Edit | Read-Hash -> Edit -> eindeutiger `afterSha256`; Folge-Edit nutzt ihn | externe Mutation erzeugt strukturierten Conflict und keine Ueberschreibung |
| Patch einer Datei | drei bekannte Ersetzungen, ein Ausgangshash, ein Commit | eine falsche Occurrence verhindert alle drei Ersetzungen |
| Patch mehrerer Dateien | alle Eintraege erfolgreich mit eigenem Folgehash | Preflightfehler veraendert keine Datei; spaeter Applyfehler meldet sichtbaren Teilstatus |
| Race | unveraenderter Preflight-State commitet | Zwischenwrite vor Commit wird per Revalidierung blockiert |
| Workspaces | Personal, Team und Projekt im erlaubten Session-Scope | fremder Workspace, entzogene Write-Permission oder aktiver Lock bleibt blockiert |
| Collaboration | stabiler Absatz wird live angewendet und Hash stammt aus Yjs | struktureller/semantischer Konflikt bleibt Review; kein `write`-Fallback |
| Runtimeadapter | Hauptagent, Delegation und Automation erhalten identische Kerndetails | Projektion/Reload verliert weder Code noch Folgeaktion; kein Auto-Retry |
| Same-Path-Hinweis | zweiter erfolgreicher Edit desselben Pfads erhaelt Hinweis | anderer Pfad, neuer Turn oder Fehlercall erzeugt keinen falschen Zaehler |
| UI | Erfolg, Review, Sicherheitskonflikt und technischer Fehler sind unterscheidbar | alter Textfallback bleibt lesbar und Fehler erscheint nicht als `Fertig` |
| Datenschutz | Audit enthaelt bestehende Hash-/Pfadmetadaten und Ergebnisstatus | Same-Path-Beobachtung persistiert keine Inhalte, Diffs oder Hashfolgen |

Gezielt zu ergaenzen beziehungsweise auszufuehren:

- `npm run test:prompt-builder`;
- `npm run test:pi:tools`;
- `scripts/agent-runtime-config-test.ts`;
- `scripts/file-revision-guard-test.ts`;
- `scripts/file-agent-operation-integration-test.ts`;
- `scripts/pi-message-projection-test.ts`;
- `scripts/automation-runner-tool-context-test.ts`;
- Delegations-Tool- und Delegations-Runtime-Tests;
- neue fokussierte Tests fuer File-Resultatvertrag, Patch-Races,
  Same-Path-Observer und Chat-Mapping;
- relevante Collaboration-Tests aus Ticket 23;
- abschliessend `npm run build`.

Browser-E2E in `tests/pi-chat.spec.ts` und
`tests/file-live-collaboration.spec.ts` wird nur nach expliziter Freigabe
ausgefuehrt.

## Manuelle Abnahmekriterien

1. Ein Agent erhaelt eine Aufgabe mit drei gleichzeitig bekannten
   Ersetzungen in derselben Datei und ruft nach aktuellem Read genau einmal
   `apply_patch` statt dreimal `edit_file` auf.
2. Eine einzelne kleine Ersetzung verwendet `edit_file`; der sichtbare und
   maschinenlesbare Folgehash stimmen ueberein.
3. Ein erst nach dem ersten Ergebnis planbarer Folge-Edit verwendet dessen
   `afterSha256` und bleibt revisionssicher. Die Runtime darf dabei lediglich
   auf kuenftige Buendelung hinweisen, nicht den validen Call blockieren.
4. Nach einer menschlichen oder automatischen Zwischenmutation wird kein
   Toolcall still wiederholt. Agent und UI zeigen Sicherheitskonflikt,
   `read_then_retry` und die Notwendigkeit einer neuen Planung.
5. Ein Preflightfehler in einem Multi-File-Patch veraendert keine Zieldatei.
   Ein spaeter Commitfehler zeigt exakt, welche Dateien bereits angewendet
   wurden.
6. Ein struktureller Live-Collaboration-Edit erscheint als persistierte Review;
   ein stabiler Ziel-Edit konvergiert live. `write` kann beide Pfade nicht
   umgehen.
7. Reviewbedarf, Sicherheitskonflikt und technischer Fehler besitzen
   unterschiedliche sichtbare Status und Accessibility-Texte.
8. Persoenliche und Team-Workspaces sowie reduzierte Agent-/Automation-Toolsets
   zeigen keine Berechtigungs-, Prompt- oder Revisionsregression.

## Risiken, Migration und Rollback

### Risiken und Gegenmassnahmen

- **Ticket-18-Drift:** Eine vorgezogene Promptloesung wuerde erneut statische
  Capability-Behauptungen schaffen. Gegenmassnahme: Phase-0-Gate und Nutzung
  ausschliesslich der gemergten Ticket-18-Schnittstelle.
- **Ticket-23-Drift:** Doppelte Collaboration-Codes oder ein Whole-File-
  Fallback koennten den Yjs-Pfad unterlaufen. Gegenmassnahme: Codes und Status
  aus Ticket 23 uebernehmen, gemeinsame Dateien vor Phase 1 abstimmen.
- **Falsche Atomaritaetsbehauptung:** Mehrere Dateicommits koennen nicht
  crash-sicher als eine Dateisystemtransaktion garantiert werden.
  Gegenmassnahme: per-file Atomicity, Preflight-vor-Write und sichtbare Saga.
- **Race trotz Preflight:** Externe Prozesse koennen zwischen Read und Commit
  schreiben. Gegenmassnahme: unmittelbare Hash-/Policy-Revalidierung an der
  autoritativen Commitgrenze und negativer Race-Test.
- **Hash als Retry-Abkuerzung:** Ein Modell koennte `currentSha256` aus dem
  Fehler direkt verwenden. Gegenmassnahme: immer `read_then_retry`, explizites
  `safeToAutoRetry: false`, Prompt- und Tooltext sowie kein Runtime-Auto-Retry.
- **UI/Modell-Divergenz:** Text, Details und `isError` koennten unterschiedlich
  klassifiziert werden. Gegenmassnahme: ein gemeinsamer Serializer und
  End-to-End-Contracttests durch Persistenz und Projektion.
- **Prompt-Snapshot-Stale-State:** Bestehende Sessions koennten alte Guidance
  behalten. Gegenmassnahme: den von Ticket 18 definierten Snapshot-
  Versions-/Invalidierungsweg verwenden und explizit testen.
- **Datenschutz:** Same-Path-Telemetrie koennte Dateiinhalte oder Arbeitsmuster
  sammeln. Gegenmassnahme: nur turnlokaler Speicher; keine Inhalte, Diffs oder
  Hashfolgen; allenfalls anonyme Aggregatmetrik ohne Pfad.

### Migration

Eine Datenbankmigration ist nach aktuellem Stand nicht erforderlich. Der
Toolresultatvertrag wird additiv versioniert. Alte gespeicherte Toolmessages
bleiben ueber den bestehenden Textfallback darstellbar. Falls Ticket 18 eine
Prompt-Snapshot-Version einfuehrt, nutzt Ticket 24 genau diesen Mechanismus und
keinen eigenen parallelen Migrationspfad.

### Rollback

- Prompt-/Tool-Guidance kann gemeinsam auf die vorherige capability-gebundene
  Version zurueckgesetzt werden, ohne Berechtigungslogik zu aendern.
- Neue UI-Karten fallen bei unbekanntem oder altem Vertrag auf die bestehende
  Textdarstellung zurueck.
- Der Same-Path-Observer ist zustandslos und kann separat deaktiviert werden.
- Die typisierte Fehlernormalisierung ist additiv; bei Rollback bleiben die
  tieferen Revision-, Workspace-, Lock- und Collaboration-Guards autoritativ.
- Die Patch-CAS-Revalidierung darf nicht als Komfortfeature weggerollt werden,
  wenn dadurch wieder neuere Daten ueberschrieben werden koennten. Bei einem
  Defekt wird `apply_patch` konservativ blockiert, bis die sichere
  Commitgrenze repariert ist.

## Definition of Done

- Ticket 18 ist abgeschlossen, und Ticket 24 verwendet dessen effektive
  Prompt-/Toolarchitektur ohne parallelen Sonderpfad.
- Die Schnittstelle zu Ticket 23 ist dokumentiert und aktive Yjs-Dokumente
  koennen weder durch `write` noch durch Retry umgangen werden.
- Prompt und tatsaechliche Tooltexte enthalten dieselbe capability-abhaengige
  Entscheidungsmatrix.
- Erfolgreiche Einzel- und Patch-Mutationen liefern Pfad und `afterSha256`
  unverkuerzt in allen Runtimepfaden.
- Stale State besitzt stabilen Code, aktuellen sicheren Hash,
  `recommendedAction: read_then_retry` und `safeToAutoRetry: false`.
- Ein Patch-Preflightfehler mutiert nichts; ein spaeter Multi-File-Fehler
  meldet jeden bereits eingetretenen Seiteneffekt als Teilstatus.
- Wiederholte Same-Path-Edits erhalten eine nicht blockierende, nicht
  inhaltshaltig persistierte Buendelungs-Guidance.
- UI und Modell koennen Erfolg, Review, Sicherheitskonflikt und technischen
  Fehler unterscheiden.
- Alle relevanten automatisierten Tests und `npm run build` sind gruen.
- Eine Browser-/Playwright-Abnahme wurde nur bei ausdruecklicher Freigabe
  ausgefuehrt; andernfalls ist sie im Abschlussnachweis als offen benannt.
- Ticket und Index werden erst nach der spaeteren Implementierungsabnahme auf
  `erledigt` gesetzt.
