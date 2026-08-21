---
title: 'Umsetzungsplan zu Ticket 18: Agent-System-Prompts an effektive Tools koppeln'
status: ready
date: 2026-08-21
platforms: [server, agent-runtime]
tags: [type/implementation-plan, topic/agents, topic/system-prompt, topic/tools, topic/email]
---

# Umsetzungsplan: Agent-System-Prompts an effektive Tools koppeln

## Ziel und Arbeitsmodus

Dieser Plan konkretisiert [Ticket 18](./18-agent-system-prompts-an-tools-koppeln.md)
auf Basis des aktuellen Codes. Die spaetere Umsetzung erfolgt strikt
sequenziell. Eine Phase beginnt erst, wenn die vorherige Phase implementiert,
automatisiert geprueft und mit einem fokussierten Commit abgeschlossen ist.

Der zentrale Vertrag lautet:

```text
konfigurierte Praeferenz
  ∩ serverseitig registrierte Tools
  ∩ aktuelle Runtime-Verfuegbarkeit
  ∩ Agent-/Workspace-/Run-Policy
  ∩ Delegations-/Automations-/Modus-Grenze
  = effektive Tools dieses Modell-Turns

effektive Tools dieses Modell-Turns
  -> einzige Quelle fuer den dynamischen Capability-Prompt
  -> exakt dieselben Tool-Schemas im Modellkontext
```

Prompttext darf Rechte weder erzeugen noch erweitern. Tool-Schemas,
`AgentExecutionContext`, Mailbox-Bindings und die Autorisierung im Tool selbst
bleiben auch nach dieser Aenderung die serverseitige Sicherheitsgrenze.

## Umfang und Nicht-Ziele

Im Umfang liegen:

- Basis-System-Prompt, geteilte Promptbausteine, Page-/Channel-Kontext und
  Agent-Templates;
- Toolsets, Registry, Progressive Gateways und user-/workspace-scoped Tools;
- normale Live-Runtime, Planning Mode, Browser-Tool-Refresh und Prompt-Reload;
- Hauptagent, eingebaute und eigene Managed Agents;
- temporaere und verwaltete Delegations-Worker;
- normale Automationen und mailboxgebundene E-Mail-Event-Automationen;
- Provider-/Toolprofilwechsel und Workspace-Scope;
- die Least-Privilege-Policy des eingebauten `email-agent`.

Nicht Teil dieses Tickets sind neue E-Mail-Funktionen, automatischer Versand,
neue Office-Tools aus Ticket 19, ein neues allgemeines Berechtigungsmodell oder
ein Umbau der Control Plane. Es wird insbesondere kein Send-Tool fuer Agenten
eingefuehrt.

## Inventur des bestehenden Stands

### Promptaufbau

- `app/lib/agents/base-system-prompt.ts` beschreibt Dateien, Schreiben,
  Terminal, Automationen, Skills und Connectoren teilweise allgemein, obwohl
  ein konkreter Agent diese Tools nicht zwingend besitzt.
- `app/lib/agents/system-prompt-shared.ts` fuegt
  `CANVAS_BASE_TOOL_GUIDANCE` und `FILE_ACCESS_GUIDANCE` jedem Managed-Agent-
  Prompt hinzu. Der Attachment-Block verlangt beispielsweise `read`, auch
  wenn `read` im Run nicht registriert ist. `PLANNING_MODE_GUIDANCE` enthaelt
  eine statische Toolliste.
- `app/lib/agents/system-prompt.ts` leitet den spezialisierten Toolhinweis aus
  `resolveAgentRuntimeSettings()` und globalen `getPiToolMetadata()`-Daten ab.
  Das ist das konfigurierte Profil, nicht die spaetere, run-spezifische
  Registry. MCP-, Composio- und Browser-Bloecke werden ebenfalls vor der
  finalen Toolfilterung entschieden.
- `app/lib/agents/email-prompt-block.ts`,
  `app/lib/agents/studio-prompt-block.ts` und Teile des dynamischen Notebook-,
  Studio-, E-Mail- und Channel-Kontexts in `app/lib/pi/live-runtime.ts` nennen
  konkrete Werkzeuge oder Dateioperationen unabhaengig vom effektiven Set.
- `seed_sys_prompts/AGENTS.md`, `seed_sys_prompts/TOOLS.md`, die Dateien unter
  `seed_sys_prompts/email-agent/` und die Vorlagen in
  `app/components/settings/CreateAgentDialog.tsx` enthalten weitere statische
  Capability-Erwartungen.

### Toolaufloesung

- `app/lib/pi/tool-registry.ts` baut Kandidaten aus Core-, Scoped-, Agent-,
  Composio-, Direct-MCP- und E-Mail-Tools und kollabiert Progressive Gateways.
- `getPiTools()` filtert danach nach der effektiven Agentenkonfiguration,
  Browser-Verfuegbarkeit, E-Mail-Event-Policy und Delegations-Toolsets. Erst
  dieses Ergebnis entspricht weitgehend dem Toolset des konkreten Runs.
- `app/lib/pi/enabled-tools.ts` normalisiert Default-, Legacy- und explizite
  Toolauswahl. `app/lib/pi/toolsets.ts` ordnet Toolnamen den groben Toolsets
  zu. Das Toolset `file` umfasst aktuell lesende und mutierende Operationen.
- `app/lib/pi/scoped-tools.ts`, `app/lib/pi/agent-file-operations.ts`,
  `app/lib/pi/workspace-email-tools.ts` und die Runtime-Wrapper validieren
  Nutzer, Workspace, Pfade, Mailbox, Schreib-/Loeschrechte und andere
  Parameter beim Aufruf. Diese Checks muessen autoritativ bleiben.
- Eine fehlende Workspace-Schreibberechtigung entfernt heute nicht zwingend
  jedes mutierende Schema aus dem Modellkontext; haeufig blockiert erst die
  Ausfuehrung. Ein aus den registrierten Schemas erzeugter Prompt waere daher
  erst nach einer expliziten Execution-Context-Filterstufe wirklich korrekt.

### Runtime, Snapshots und Reload

- `app/lib/pi/system-prompt-snapshot.ts` persistiert den vollstaendig
  zusammengesetzten Prompt in `pi_sessions.system_prompt_snapshot`. Ein
  vorhandener Snapshot bleibt absichtlich stabil.
- `app/lib/pi/live-runtime.ts` laedt bei Runtime-Erzeugung erst den Snapshot
  und getrennt davon `getPiTools()`. `reloadTools()` ersetzt Tools bei einem
  neuen Turn, erzeugt aber nur nach einem separat angeforderten Prompt-Refresh
  einen neuen Prompt.
- Toolaenderungen ueber `app/api/agents/tools/route.ts` und Managed-Agent-
  Runtime-Aenderungen aktualisieren die Profilkonfiguration, invalidieren aber
  nicht durchgaengig Prompt-Snapshots und aktive Runtime-Prompts. Plugin- und
  Capability-Aktivierungen besitzen dagegen bereits explizite
  Invalidierungs-/Refreshpfade.
- Planning Mode filtert `this.tools` erst in `live-runtime.ts`. Der statische
  Planning-Prompt kennt weder das vorherige Agentenprofil noch die danach
  verbleibende Schnittmenge.
- Ein Browser-Start kann die Tool-Schemas zwischen Turns von dormant zu aktiv
  wechseln. `prepareNextTurnContext()` ersetzt Tools und Promptkontext, der
  Capability-Text wird derzeit aber nicht aus demselben Ergebnis neu gebaut.

### Delegation

- `getDelegatedWorkerToolsets()` und `resolveDelegatedWorkerToolNames()`
  begrenzen Managed Worker bei jedem Tool-Load auf die gespeicherten Toolsets.
- Temporaere Worker berechnen in `app/lib/pi/delegate-task-tool.ts` bereits
  zuerst ihre Tools und schreiben deren Namen in einen eigenen Worker-Block.
  Ihr geerbter Basis-Prompt kann trotzdem nicht vorhandene allgemeine
  Faehigkeiten behaupten.
- Managed Worker laufen durch die normale Live-Runtime. Ihre Toolset-
  Schnittmenge ist deshalb im gespeicherten spezialisierten Prompt nicht
  sichtbar und kann nach Reload vom Prompt abweichen.
- Die vorhandene Rekursionssperre und der Ausschluss von Agentenverwaltung
  bleiben unveraendert; Ticket 18 nutzt diese Grenzen nur als weitere
  Filterstufe.

### Automationen und E-Mail

- `app/lib/automations/runner.ts` loest Tools vor dem Prompt-Snapshot auf und
  pinnt beide fuer den Agent-Loop. Der Snapshot wurde aber unabhaengig von
  diesen Tools erzeugt. Bei `prepareNextTurn` wird nur der Workspace-Dateibaum
  aktualisiert.
- E-Mail-Event-Runs verwenden in `tool-registry.ts` eine harte Allowlist und
  mailboxgebundene Ersatztools aus
  `app/lib/pi/workspace-email-automation-tools.ts`. Die Allowlist enthaelt
  aktuell auch `list_file_snapshots` und `session_search`, obwohl beide fuer
  die dokumentierte Triage nicht erforderlich sind.
- Der `email-agent` besitzt in `app/lib/agents/registry.ts` standardmaessig nur
  neun E-Mail-Tools. Gleichzeitig beschreiben Basis-Prompt und bestehende
  Architekturplaene Workspace-Dateizugriff bzw. Workspace-Wissenssuche.
- `app/lib/pi/workspace-email-tools.ts` bindet bei Event-Runs die ausloesende
  Mailbox serverseitig und revalidiert Mailbox-/Workspace-Zugriff. Die
  E-Mail-Tools koennen nur Inbox-Faelle und Outbox-Entwuerfe fuer menschliche
  Freigabe erzeugen oder aendern; ein Agent-Sendeweg existiert nicht.

## Fehlerursachen: belegt und noch zu verifizieren

### Im Code belegte Ursachen

1. **Zwei unterschiedliche Quellen:** Prompt und Tool-Schemas werden in
   getrennten Funktionen und zu unterschiedlichen Zeitpunkten aufgeloest.
2. **Zu fruehe Promptentscheidung:** `system-prompt.ts` kennt Profil- und
   globale Metadaten, aber nicht Automation-Binding, Delegationsschnittmenge,
   Planning Mode oder den finalen Workspace-Kontext.
3. **Statische Behauptungen:** Basis-, Attachment-, Page- und Templatebloecke
   nennen Werkzeuge und Dateiaktionen ohne Capability-Gate.
4. **Snapshot-Drift:** Ein gespeicherter Prompt kann nach `reloadTools()` oder
   einer Toolprofil-Aenderung unveraendert bleiben.
5. **Zu grobe E-Mail-Defaults:** Der E-Mail-Agent hat entweder nur E-Mail-
   Tools oder wuerde ueber das allgemeine `file`-Toolset gleichzeitig
   Schreib-/Loeschwerkzeuge erhalten. Eine explizite read-only Mitte fehlt.
6. **Run-spezifische Filter fehlen im Prompt:** E-Mail-Automation und
   Delegation verkleinern Tools erst nach der allgemeinen Promptkomposition.
7. **Kontextdaten ohne Capability-Gate:** Workspace-Dateibaum und manche
   UI-Kontextbloecke werden auch dann erzeugt, wenn der Agent keine passende
   Lese- oder Fachfaehigkeit besitzt.

### Vor der jeweiligen Implementierung zu verifizieren

- Welche Provider-/Modellwechselpfade das Legacy-`enabledTools`-Profil heute
  tatsaechlich aendern und ob Ticket 16 parallel dieselben Resolver anfasst.
- Ob alle Progressive Gateways nach `withAllowedProgressiveGatewayOperations`
  ihre erlaubten Operationen vollstaendig und deterministisch exponieren.
- Welche mutierenden Tools ausser den offensichtlichen Dateiwerkzeugen bei
  `canWrite`, `canDelete` oder `canShare` aus dem Schema entfernt werden
  muessen; Toolgruppen allein reichen dafuer nicht.
- Ob bestehende kundenseitig bearbeitete E-Mail-Agent-Profile exakt dem
  aktuellen Default entsprechen oder absichtlich abweichende Auswahl haben.
  Nur unveraenderte Defaults duerfen automatisch erweitert werden.
- Ob Automationen mit einem inkompatiblen eigenen Agenten bereits beim
  Speichern/Aktivieren oder erst beim Runstart abgewiesen werden. Der Plan
  bevorzugt eine fruehe Validierung plus erneute Runstart-Pruefung.

## Architekturentscheidungen

### 1. Eine kanonische effektive Toolauflosung

`getPiTools()` wird nicht direkt zum Prompt-Builder. Stattdessen entsteht eine
gemeinsame, serverseitige Aufloesung, beispielsweise in
`app/lib/pi/effective-tools.ts`:

```ts
type EffectiveToolResolution = {
  tools: AgentTool[];
  manifest: EffectiveToolManifest;
  revision: string;
  exclusions: Array<{
    name: string;
    stage: 'config' | 'availability' | 'agent-policy' | 'workspace-policy'
      | 'automation-policy' | 'delegation-policy' | 'mode';
    reasonCode: string;
  }>;
};

type EffectiveToolManifest = {
  registeredToolNames: string[];
  gateways: Array<{
    toolName: string;
    allowedOperationNames: string[];
  }>;
  groups: string[];
  revision: string;
};
```

`registeredToolNames` sind exakt die Top-Level-Schemas, die das Modell im
betreffenden Turn erhaelt. Progressive Gateway-Operationen werden separat
unter dem registrierten Gateway aufgefuehrt und niemals als frei registrierte
Tools ausgegeben. Reihenfolge und Hash sind deterministisch.

Die Filterreihenfolge ist verbindlich:

1. Registry-Kandidaten fuer User, Agent, Session und Workspace bauen;
2. konfigurierte Agentenpraeferenz als Reduktion anwenden;
3. nicht verfuegbare Runtime-Tools entfernen;
4. Agenten-Ceiling und aktuelle Workspace-Rechte anwenden;
5. Automation-/Mailbox- oder Delegations-Policy anwenden;
6. Planning-/sonstigen Run-Modus anwenden;
7. verbleibende Tools mit `AgentExecutionContext` wrappen;
8. aus genau diesem Array Manifest, Revision und Promptblock erzeugen.

Der Resolver liefert bei internen Fehlern nicht den ungefilterten Default.
Kann eine sicherheitsrelevante Filterstufe nicht bestimmt werden, gilt
fail-closed: keine betroffenen Tools und ein capability-neutraler Hinweis.

### 2. Prompt-Fundament und dynamischer Capability-Block werden getrennt

Der persistierte Session-Snapshot enthaelt kuenftig nur das stabile
Prompt-Fundament:

- capability-neutrale Canvas- und Sicherheitsregeln;
- Markdown-Vertrag;
- Agentenrolle, Stil, Memory und User-Kontext;
- effektiv aktivierte Skills, soweit diese bereits ueber die bestehende
  Snapshot-Invalidierung verwaltet werden;
- keine Liste oder Anleitung zu konkreten Runtime-Tools.

Unmittelbar vor jedem Modell-Turn wird ein markierter dynamischer Block aus
`EffectiveToolManifest` angehaengt. Er enthaelt:

- die exakten registrierten Toolnamen und kurzen Beschreibungen;
- bei Progressive Gateways nur den Gateway-Namen und die erlaubten
  Operationen;
- nur die Guidance-Fragmente, deren benoetigte Tools vorhanden sind;
- einen klaren Satz, dass nicht gelistete Tools und Aktionen nicht verfuegbar
  sind und Prompttext keine Berechtigung erteilt.

Allgemeine Arbeitsweise bleibt capability-neutral formuliert: nicht „lies oder
schreibe Dateien“, sondern „nutze ausschliesslich die unten gelisteten Tools;
wenn die benoetigte Capability fehlt, erklaere die Grenze oder bitte um eine
zulaessige Alternative“.

### 3. Kontextbloecke werden an dieselbe Manifest-Quelle gebunden

- E-Mail-Guidance wird nur angehaengt, wenn mindestens das benoetigte
  E-Mail-Tool vorhanden ist; konkrete Workflows nennen nur vorhandene Tools.
- Studio-, Browser-, MCP-, Composio-, Automation- und Agentenmanagement-
  Guidance folgt demselben Prinzip.
- Attachment-Guidance unterscheidet eingebettete Bilder von Dateien, fuer die
  ein effektives `read`-Tool existiert. Ohne `read` wird kein Leseaufruf
  verlangt.
- Notebook-/aktive-Datei-Kontext darf UI-Metadaten liefern, fordert aber nur
  bei vorhandener Lese- bzw. Schreibfaehigkeit eine Dateiaktion.
- Der Workspace-Dateibaum wird nur erzeugt und in den Modellkontext gegeben,
  wenn der effektive Run mindestens eine freigegebene Workspace-Leseoperation
  besitzt. Das verhindert sowohl falsche Capability-Signale als auch
  unnoetige Dateinamenoffenlegung.
- Channel-Formatregeln duerfen capability-neutral bleiben; lokale
  Attachment-/`MEDIA:`-Anweisungen werden nur mit passender Dateifaehigkeit
  genannt.

### 4. Managed Dateien sind Praeferenzen, keine Capability-Quelle

Freitext in `AGENTS.md` oder `TOOLS.md` kann nicht sicher semantisch
umgeschrieben werden. Deshalb gilt:

- alle von Canvas ausgelieferten Seeds und Create-Agent-Templates werden von
  unbedingten Toolbehauptungen bereinigt;
- der generierte Effective-Capabilities-Block steht nach den Managed-Dateien
  und erklaert explizit, dass dort genannte Toolwuensche nur Praeferenzen sind;
- bekannte, nicht effektive Toolnamen in bearbeiteten Managed-Dateien koennen
  im Agent Doctor als Warnung erscheinen, erweitern aber nie Rechte;
- es gibt keine automatische Loeschung oder inhaltliche Migration
  kundenseitig bearbeiteter Promptdateien.

Automatisierte „keine falsche Behauptung“-Tests beziehen sich auf alle von
Canvas kontrollierten Promptbloecke und unveraenderte Templates. Manipulierter
Freitext wird separat als Nicht-Erweiterungsfall getestet.

### 5. Workspace-Rechte reduzieren bereits das exponierte Schema

Tool-interne Revalidierung bleibt bestehen. Zusaetzlich erhaelt die Registry
eine explizite Policy-Klassifikation fuer Tools, statt Seiteneffekte aus Namen
oder Gruppen zu erraten. Mindestens `readWorkspace`, `writeWorkspace`,
`deleteWorkspace`, `shareWorkspace` und fachliche Spezialrechte werden als
serverseitige Metadaten gepflegt.

Bei `canWrite = false`, `canDelete = false` oder `canShare = false` werden
betroffene Schemas vor dem Modellaufruf entfernt. Ein spaeterer Rechteentzug
wird weiterhin im Tool selbst direkt vor der Aktion blockiert. Prompt und
Schema zeigen damit die Rechte am Turnstart korrekt, ohne die notwendige
Time-of-check/Time-of-use-Pruefung zu ersetzen.

### 6. E-Mail-Agent: explizite Least-Privilege-Obergrenze

Die Produktentscheidung fuer den eingebauten `email-agent` lautet: Er darf
E-Mails innerhalb der serverseitig autorisierten Mailbox lesen, Inbox-Faelle
pflegen, Outbox-Entwuerfe fuer menschliche Freigabe pflegen und dazu
Workspace-Wissen **lesen**, aber keine Workspace-Datei veraendern und keine
allgemeine Runtime steuern.

Die unveraenderliche Obergrenze besteht exakt aus:

```text
email_list_mailboxes
email_search_messages
email_read_message
email_list_thread_messages
email_list_cases
email_create_or_update_case
email_create_outbox_draft
email_update_outbox_draft
email_list_outbox_drafts
ls
read
rg
grep
glob
inspect_document_relations
```

Explizit ausgeschlossen sind:

- `write`, `edit_file`, `apply_patch`, `copy_path`, `move_path`,
  `delete_path`, `restore_file_snapshot`, PDF-/Studio-Schreiboperationen und
  `bash`;
- `list_file_snapshots` und `session_search`, weil sie fuer die Triage keine
  notwendige Workspace-Wissensoperation darstellen;
- Delegation, Agenten-/Automations-/Skill-/Pluginverwaltung;
- MCP, Composio, Browser und andere externe Connectoren;
- jeder direkte oder indirekte E-Mail-Versand.

Die gespeicherte `enabledTools`-Auswahl des E-Mail-Agenten ist eine Teilmenge
dieser Obergrenze. UI/API und Agent-Management-Tool weisen eine Erweiterung
ausserhalb der Grenze frueh ab; die Runtime schneidet trotzdem erneut, damit
eine manipulierte DB-/Konfigurationszeile keine Rechte erzeugt.

Unveraenderte bisherige Defaultprofile mit genau den neun E-Mail-Tools werden
auf die neue Defaultmenge migriert. Bewusst angepasste Profile bleiben
unveraendert und erhalten nicht still neue Dateirechte. Unsichere Alteintraege
werden beim Run entfernt und in Settings/Doctor als nicht wirksam markiert.

Fuer eine E-Mail-Event-Automation gilt zusaetzlich:

```text
effektive Tools des ausgewaehlten Agenten
  ∩ E-Mail-Event-Obergrenze oben
  ∩ gebundene Mailbox-Operationen
  ∩ aktuelle Workspace-Rechte
```

Die Automation darf keine fehlenden Tools hinzufuegen. Eine Triage-Vorlage
verlangt mindestens `email_list_mailboxes`, `email_read_message`,
`email_create_or_update_case` und `email_create_outbox_draft`; inkompatible
Agenten werden beim Aktivieren und erneut am Runstart mit einem stabilen
Fehlercode abgewiesen.

### 7. Reload ist ein atomarer Prompt-/Tool-Wechsel am Turnrand

Ein Modell-Turn verwendet immer ein gepinntes Paar aus Promptrevision und
Toolrevision. Laufende Turns werden nicht mutiert.

- Normale Live-Session: `reloadTools()` wird zu einer gemeinsamen
  `reloadEffectiveRuntimeContext()`-Operation. Sie setzt Tools, Manifest und
  dynamischen Prompt zusammen am naechsten sicheren Turnrand.
- Planning Mode: Erst wird die Toolmenge reduziert, dann der Prompt aus dieser
  reduzierten Menge erzeugt.
- Browser dormant/active: der neue Gateway-Schemaumfang und der neue Prompt
  werden in demselben `replaceNextTurnContext()` uebergeben.
- Provider-/Toolprofilwechsel: der naechste Turn loest die neue Konfiguration
  auf; Prompt und Tools wechseln gemeinsam. Ein separater Prompt-Refresh ist
  fuer reine Toolaenderungen nicht mehr erforderlich.
- Managed Prompt-/Skillaenderungen nutzen weiter Snapshot-Invalidierung, aber
  die anschliessende Komposition verwendet das zu diesem Turn effektive
  Manifest.
- Workspace-Wechsel erzeugt weiterhin eine neue Session. Ein bestehender Run
  bleibt an seinem persistierten `AgentExecutionContext` gebunden.
- Automationen und temporaere Worker pinnen das Paar fuer den gesamten Run.
  Tool-interne Permission-Checks koennen eine spaeter entzogene Aktion dennoch
  blockieren. Der naechste Run erhaelt ein neues Paar.

## Daten- und API-Vertraege

### Persistierter Prompt-Snapshot

Es ist keine neue Datenbankspalte erforderlich. Die Bedeutung von
`system_prompt_snapshot` wird auf das capability-neutrale Prompt-Fundament
praezisiert. Ein Versionsmarker, zum Beispiel
`<!-- canvas-system-prompt-foundation:v2 -->`, erlaubt die Erkennung alter
Snapshots.

Beim Rollout werden alte Snapshots ohne Marker invalidiert und beim naechsten
Run aus den weiterhin gespeicherten Managed-Dateien neu erzeugt. Der
dynamische Capability-Block wird nicht dauerhaft in den Snapshot geschrieben,
damit Reloads keine historische Falschinformation wiederverwenden.

### Interner Runtime-Vertrag

Jeder Einstiegspunkt uebergibt dasselbe `EffectiveToolResolution` an Prompt
und Agent-Loop:

```ts
type EffectiveRuntimeContext = {
  baseSystemPrompt: string;
  effectiveSystemPrompt: string;
  tools: AgentTool[];
  toolManifest: EffectiveToolManifest;
  promptRevision: string;
  toolRevision: string;
};
```

Vor dem Modellaufruf gilt als Invariante:

```text
manifest.registeredToolNames == context.tools.map(tool => tool.name)
```

Gateway-Operationen werden gegen die im konkreten Gateway-Tool gespeicherte
Allowed-Operations-Liste geprueft.

### Agent-Tools-API

`GET /api/agents/tools` bleibt rueckwaertskompatibel und kann pro Tool
additiv liefern:

```json
{
  "policy": {
    "selectable": false,
    "reasonCode": "EMAIL_AGENT_TOOL_CEILING"
  }
}
```

Die Config-Antwort unterscheidet optional `configuredEnabledTools` von
`effectiveEnabledTools`. `PATCH /api/agents/tools`, `PATCH /api/agents` und
das Agent-Management-Gateway lehnen eine unzulaessige E-Mail-Agent-Auswahl mit
`AGENT_TOOL_POLICY_DENIED` ab. Diese API-Validierung verbessert die UX; die
Runtime-Obergrenze bleibt die eigentliche Absicherung.

Weitere oeffentliche Chat-, Automation- oder Mobile-API-Aenderungen sind fuer
Ticket 18 nicht erforderlich.

## Verbindliche Prompt-/Tool-Matrix

| Lauf | Konfiguration/Scope | Erwartete effektive Tools | Promptaussage und Negativfall |
| --- | --- | --- | --- |
| Hauptagent, Default | Defaultprofil, schreibbarer Workspace | alle Defaulttools nach Verfuegbarkeit und Workspace-Policy | listet exakt registrierte Schemas; Browser fehlt, solange er default-disabled oder runtime-unavailable ist |
| Hauptagent, keine Tools | `__none__` | leer | erklaert fehlende Runtime-Tools; keine Datei-, Web-, E-Mail-, Automation- oder Connector-Anleitung |
| Eigener Managed Agent | explizit `read`, `rg` | nur `read`, `rg` nach Scope | beschreibt nur lesende Dateioperationen; behauptet weder Schreiben noch Shell |
| Read-only Workspace | Profil enthaelt Read und Write, `canWrite=false` | Read-Tools, keine Write-Tools | nennt keine Schreibfaehigkeit; manipulierter Write-Call bleibt tool-intern blockiert |
| E-Mail-Agent, Default | neues Systemdefaultprofil | neun E-Mail- plus sechs Read-only-Dateitools | beschreibt Mailbox/Inbox/Outbox und Workspace-Lesen; kein Versand, Schreiben, Shell oder externer Connector |
| E-Mail-Agent, reduzierte Auswahl | Admin deaktiviert Dateiwerkzeuge | nur verbleibende E-Mail-Tools | kein Workspace-Dateizugriff und kein Workspace-Dateibaum im Prompt |
| E-Mail-Agent, manipuliert | Profil enthaelt `bash`/`write` | Ceiling entfernt beide | Prompt nennt beide nicht; direkte Toolanfrage ist nicht registriert, gefaelschter Aufruf wird serverseitig abgewiesen |
| Managed Delegation | Zielagent hat E-Mail+Read, Worker-Toolsets nur `file` | nur Schnittmenge aus Zielprofil und delegiertem File-Set, fuer E-Mail-Agent also nur sechs Read-Tools | Parent-/Zielprompt kann keine E-Mail- oder Schreibtools suggerieren |
| Temporaere Delegation | Hauptagent breit, Worker-Toolsets `web` | nur delegierbare effektive Webtools | Worker-Block und Basisprompt nennen nur diese; kein `delegate_task` |
| Normale Automation | Agentprofil plus Automation-Workspace | dieselben Agenttools nach aktuellen Workspace-Rechten | Prompt und Agent-Loop verwenden dasselbe gepinnte Paar |
| E-Mail-Event-Automation | beliebiger kompatibler Agent, gebundene Mailbox | Agentprofil ∩ E-Mail-Event-Ceiling, E-Mail-Tools mailboxgebunden | genau eine Mailbox; keine Session-Suche, Snapshots, Shell, Delegation, Konfigurationsaenderung oder Versand |
| Inkompatible E-Mail-Automation | Agent ohne minimale E-Mail-Tools | kein Start | stabiler Policyfehler statt stiller Toolerweiterung |
| Planning Mode | beliebiges Profil | Profil ∩ Workspace-Policy ∩ Planning-Allowlist | dynamische Liste enthaelt nur die tatsaechlich verbliebenen read-only Tools |
| Browser-Refresh | Browser startet/stoppt zwischen Turns | dormant/active bzw. entfernt nach Runtime-Policy | Gateway-Hinweis und Schema wechseln atomar am Turnrand |
| Provider-/Toolprofilwechsel | neues Providerprofil zwischen Turns | neu aufgeloeste Toolmenge | naechster Turn nutzt neue Tool- und Promptrevision; laufender Turn bleibt gepinnt |
| Workspace-Wechsel | UI wechselt Workspace | neue Session/neuer Execution Context | alte Session behaelt alten Workspace; keine Tool- oder Promptuebernahme in den neuen Workspace |

## Sequenzielle Implementierungsphasen

### Phase 1: Pure Manifest- und Prompt-Vertraege

- `EffectiveToolManifest`, deterministische Sortierung/Revision und einen
  reinen Builder fuer den markierten Capability-Block einfuehren.
- Progressive Gateway-Namen und erlaubte Operationen korrekt abbilden.
- Guidance-Fragmente anhand expliziter benoetigter Toolnamen auswaehlen.
- Prompt-Fundament von statischer Tool-Guidance trennen, ohne bereits einen
  Runtime-Einstieg umzustellen.
- Pure Tests fuer leere, direkte, Gateway-, unavailable- und gemischte Sets
  sowie Byte-Budget/Truncation ergaenzen.
- Verifikation: `test:prompt-builder`, neue Manifesttests, gezieltes ESLint
  und `npm run build`.
- Commit: `Derive prompt capabilities from tool manifests`.

### Phase 2: Registry-Pipeline und Workspace-Policy

- `getPiTools()` intern auf `EffectiveToolResolution` umstellen; einen
  Kompatibilitaetswrapper fuer bestehende Aufrufer belassen.
- Policy-Metadaten fuer read/write/delete/share und Spezialrechte zentral
  erfassen.
- Workspace-Rechte vor dem Modellaufruf als Schemafilter anwenden; bestehende
  Tool-interne Revalidierung nicht entfernen.
- Verfuegbarkeit, Progressive Gateways und Fail-closed-Fehlerpfad in die
  kanonische Filterreihenfolge uebernehmen.
- Tests fuer manipulierte Toolnamen, read-only Workspace, fehlende
  Execution-Context-Aufloesung und Gateway-Operationen ergaenzen.
- Verifikation: `test:pi:tools`, `test:agent:session-workspace`, relevante
  Scope-/Securitytests und `npm run build`.
- Commit: `Resolve effective runtime tools server-side`.

### Phase 3: Prompt-Fundament, Seeds und kontextabhaengige Guidance

- Unbedingte Toolbehauptungen aus `base-system-prompt.ts`,
  `system-prompt-shared.ts` und den optionalen MCP-/Composio-/Browser-Bloecken
  entfernen bzw. als capability-gesteuerte Fragmente neu aufbauen.
- E-Mail-, Studio-, Notebook-, Attachment- und Channel-Kontext nur mit den
  passenden Manifest-Capabilities operational formulieren.
- Workspace-Dateibaum ohne effektive Workspace-Lesefaehigkeit auslassen.
- Canvas-Seeds, E-Mail-Seeds und Create-Agent-Templates capability-neutral
  formulieren; Userdateien nicht automatisch umschreiben.
- Doctor-Warnung fuer bekannte nicht effektive Toolreferenzen vorsehen, ohne
  sie als Sicherheitsentscheidung zu verwenden.
- Tests fuer jeden Canvas-kontrollierten Promptblock und jede unveraenderte
  Templatevariante ergaenzen.
- Verifikation: Prompt-, Agent-Runtime-, Template- und Workspace-Tree-Tests
  sowie `npm run build`.
- Commit: `Make agent prompt templates capability-aware`.

### Phase 4: E-Mail-Agent-Ceiling und Defaultmigration

- Die eine exportierte E-Mail-Agent-Allowlist als gemeinsame Quelle fuer
  Registry, Profilvalidierung, Settings-Metadaten und Event-Automation
  einfuehren.
- Defaultprofil auf neun E-Mail- und sechs Read-only-Workspace-Tools
  erweitern; nur das exakt bisherige Defaultprofil automatisch migrieren.
- Unsichere konfigurierte Werte in UI/API ablehnen und in der Runtime dennoch
  abschneiden.
- E-Mail-Event-Allowlist um `list_file_snapshots` und `session_search`
  reduzieren und mailboxgebundene Ersatztools weiterhin nach der
  Agentenschnittmenge einsetzen.
- Kompatibilitaetspruefung fuer E-Mail-Automationsagenten beim Aktivieren und
  am Runstart einfuehren.
- Positive und negative Tests fuer persoenliche/Workspace-Mailbox, gebundene
  Mailbox, Dateilesen, Schreib-/Shell-/Sendversuch und manipulierte
  Agentenkonfiguration ergaenzen.
- Verifikation: `test:email:agent-profile`, `test:email:workspace-binding`,
  `test:automation:runner`, `test:pi:tools`, Agent-Management-/API-Tests und
  `npm run build`.
- Commit: `Enforce least privilege for the email agent`.

### Phase 5: Normale Live-Runtime atomar umstellen

- Runtime-Erzeugung so ordnen, dass Toolresolution und dynamische
  Promptkomposition dasselbe Ergebnis verwenden.
- `reloadTools()` durch einen atomaren Prompt-/Tool-Refresh ersetzen und
  `agent.state.systemPrompt` sowie `agent.state.tools` nur als konsistentes
  Paar publizieren.
- Planning Mode vor der Manifestbildung filtern.
- Browser dormant/active in `prepareNextTurnContext()` mit derselben Revision
  austauschen.
- Toolprofil-, Provider-, Managed-Prompt- und Capability-Aenderungen auf den
  gemeinsamen naechsten-Turn-Pfad fuehren; redundante reine Tool-Prompt-
  Invalidierungen entfernen.
- Runtime-Diagnostik um Prompt-/Toolrevision und Anzahl erweitern, ohne
  sensible Toolparameter zu loggen.
- Verifikation: Live-Runtime-, Browser-Refresh-, Planning-, Providerwechsel-,
  Prompt-Snapshot- und Session-Workspace-Tests sowie `npm run build`.
- Commit: `Reload prompts and tools atomically`.

### Phase 6: Delegation auf den gemeinsamen Vertrag umstellen

- Temporaeren Worker-Block aus `EffectiveToolManifest` statt einer separaten
  Namensliste erzeugen.
- Managed Worker bei Initialisierung und jedem Reload aus der bereits
  implementierten Agentprofil-∩-Toolset-Schnittmenge komponieren.
- Leere Worker-Schnittmenge explizit und ohne falsche Guidance behandeln.
- Rekursions-, Agentenmanagement- und Onboarding-Ausschluesse unveraendert
  serverseitig halten.
- Tests fuer temporaere/Managed Worker, `web`-only, `file`-Schnittmenge,
  Progressive Gateway, Reconnect und manipulierte Toolsets ergaenzen.
- Verifikation: alle registrierten `test:pi:delegat*`-Scripte,
  Runtime-/Registrytests und `npm run build`.
- Commit: `Align delegated prompts with worker tools`.

### Phase 7: Automations-Harness auf den gemeinsamen Vertrag umstellen

- `automation/runner.ts` aus einer einzigen `EffectiveToolResolution` Prompt,
  Toolschemas und Tokenbudget erzeugen lassen.
- Prompt-/Toolpaar fuer den Run pinnen; Workspace-Dateibaum nur bei
  effektiver Lesefaehigkeit aktualisieren.
- Normale Automation, E-Mail-Event-Automation, wiederverwendete
  Thread-Session und Providerwechsel zwischen Runs testen.
- Sicherstellen, dass kein Automation-Prompt eine nicht registrierte
  Operation nennt und dass mailboxgebundene Tools nie in ungebundene Tools
  zurueckfallen.
- Verifikation: Automation-Runner-, Workspace-Scope-, E-Mail-Event-,
  Session-Messages- und Timeouttests sowie `npm run build`.
- Commit: `Pin automation prompts to effective tools`.

### Phase 8: Snapshotmigration, Gesamtmatrix und Abschluss

- Versionsmarker fuer capability-neutrale Prompt-Fundamente aktivieren und
  alte abgeleitete Snapshots ohne Datenverlust invalidieren.
- Die vollstaendige Matrix als parametrisierten Contracttest ausfuehren; pro
  Fall exakte Gleichheit von Manifest und registrierten Top-Level-Tools sowie
  erlaubten Gateway-Operationen pruefen.
- Negative Promptassertions fuer Datei-Write, Shell, Send, Delegation,
  Connectoren und unavailable Browser aufnehmen.
- `npm run lint`, alle fokussierten Tests und abschliessend `npm run build`.
- Erst nach erfolgreicher automatisierter und freigegebener manueller Abnahme
  Ticket und Index auf `erledigt` setzen.
- Abschlusscommit: `Complete effective agent tool prompts`.

## Automatisierte Abnahme

### Pure Prompt-/Manifesttests

- Aus demselben Toolarray entstehen deterministisch dieselben Namen,
  Gateway-Operationen und Revisionen.
- Kein Promptfragment wird ohne seine benoetigten Tools aufgenommen.
- Leere Toolmenge enthaelt keine Toolnamen oder implizite Datei-/Schreib-
  /Terminal-/E-Mail-Behauptung.
- Progressive Gateway-Operationen erscheinen nur unter dem tatsaechlich
  registrierten Gateway.
- Prompttruncation entfernt niemals nur den negativen Sicherheits-/
  Autoritaetshinweis und laesst keine halbe Toolliste zurueck.

### Registry- und Policytests

- Konfiguration kann nur registrierte Tools auswaehlen und serverseitige
  Policy nie erweitern.
- `canWrite=false`, `canDelete=false` und `canShare=false` entfernen die
  zugehoerigen Schemas; gefaelschte direkte Calls bleiben blockiert.
- Browser-/Connector-Unverfuegbarkeit entfernt Tool und Guidance.
- E-Mail-Agent-Ceiling gilt bei UI/API, Agent-Management-Tool, direkter
  Registry-Aufloesung und manipulierter Persistenz identisch.
- Mailbox-, Workspace- und User-Isolation der bestehenden Toolausfuehrung
  bleibt gruen.

### Runtime-Matrixtests

- Hauptagent, eigener Agent, E-Mail-Agent, Managed Worker, temporaerer Worker,
  normale Automation und E-Mail-Event-Automation pruefen jeweils
  Prompt-/Toolgleichheit.
- Toolprofil- und Providerwechsel zwischen Turns tauschen Prompt und Tools
  gemeinsam; der laufende Turn bleibt unveraendert.
- Planning Mode, Browser-Start/-Stop und Tool-Reload erzeugen keine
  Zwischenrevision mit altem Prompt und neuen Schemas oder umgekehrt.
- Workspace-Wechsel kann einer vorhandenen Session weder Dateibaum noch Tools
  des neuen Workspaces unterschieben.
- Rechte- oder Mailbox-Binding-Entzug blockiert den naechsten bzw. kritischen
  Tool-Call auch bei gepinntem Run.

### Konkrete bestehende Tests zum Erweitern

- `scripts/prompt-builder-test.ts`
- `scripts/agent-runtime-config-test.ts`
- `scripts/pi-tool-registry-test.ts`
- `scripts/pi-browser-tool-refresh-test.ts`
- `scripts/runtime-prompt-context-test.ts`
- `scripts/workspace-file-tree-context-test.ts`
- `scripts/email-agent-profile-test.ts`
- `scripts/agent-management-service-test.ts`
- `scripts/agent-management-tool-test.ts`
- `scripts/agent-tools-route-test.ts`
- `scripts/pi-delegate-task-tool-test.ts`
- `scripts/pi-delegate-task-runtime-test.ts`
- `scripts/automation-runner-tool-context-test.ts`
- `scripts/automation-workspace-scope-test.ts`
- `scripts/email-account-workspace-binding-test.ts`
- `scripts/agent-session-workspace-context-test.ts`

Ein neuer parametrischer Test, beispielsweise
`scripts/effective-agent-tools-prompt-matrix-test.ts`, wird als eigenes
`package.json`-Script registriert, damit die Kerninvariante nicht nur indirekt
in Einzelfalltests vorkommt.

## Manuelle Abnahme

Browser-/Playwright-Abnahme erfolgt nur nach expliziter Freigabe und dann
ausschliesslich gegen einen bereits laufenden oder einmalig auf
`localhost:3000` gestarteten Dev-Server. Es werden keine Container gebaut.

Zu pruefen sind:

1. E-Mail-Agent in einem Workspace mit Testdatei auswaehlen, Datei lesen und
   aus einer Testmail einen Inbox-Fall plus Outbox-Entwurf erzeugen.
2. In Settings bestaetigen, dass nur die erlaubte E-Mail-Agent-Obergrenze
   waehlbar ist; `bash`, Write/Delete, Connectoren und Delegation sind
   deaktiviert oder mit Policygrund erklaert.
3. Dateiwerkzeuge beim E-Mail-Agenten deaktivieren, neue Session starten und
   nach Workspace-Dateizugriff fragen: Der Agent nennt die Grenze und versucht
   keinen nicht vorhandenen Call.
4. Mit manipulierter Testkonfiguration einen verbotenen Toolnamen speichern
   bzw. direkt aufloesen und die serverseitige Ablehnung bestaetigen.
5. Managed Worker mit reduziertem Toolset und E-Mail-Event-Automation mit
   gebundener Mailbox ausfuehren; Toolaktivitaet und Antwort duerfen nur die
   jeweilige Schnittmenge zeigen.
6. Planning Mode sowie einen freigegebenen Provider-/Toolprofilwechsel zwischen
   Turns pruefen; die sichtbare Toolaktivitaet darf keine alte Capability
   verwenden.
7. Workspace wechseln und bestaetigen, dass eine neue Session entsteht und
   der alte Run im alten Workspace verbleibt.

## Migration und Rollback

### Migration

- Keine neue persistente Berechtigung und keine neue Secretquelle einfuehren.
- Alte Prompt-Snapshots sind abgeleitete Daten und koennen markerbasiert auf
  `null` gesetzt werden. Managed-Dateien und Chatnachrichten bleiben erhalten.
- Nur exakt unveraenderte alte E-Mail-Agent-Defaults werden um die sechs
  lesenden Dateiwerkzeuge erweitert. Benutzerdefinierte Teilmengen bleiben
  bestehen.
- Bestehende unsichere E-Mail-Agent-Toolnamen werden nicht ausgefuehrt. Sie
  koennen nach erfolgreichem Rollout in einer getrennten, auditierten
  Bereinigung entfernt werden; der Runtime-Cut gilt sofort.

### Rollback

- Die neue Promptversion kann zurueckgerollt werden, ohne DB-Schema
  zurueckzubauen. Alte Versionen erzeugen fehlende Snapshots erneut.
- Die E-Mail-Agent-Obergrenze sollte auch bei einem Teilrollback als
  Sicherheitsfix erhalten bleiben. Muss der neue Default zurueckgenommen
  werden, werden nur die sechs Datei-Reads aus unveraenderten Defaultprofilen
  entfernt; Inbox-/Outbox-Daten und Entwuerfe bleiben unberuehrt.
- Capability-Prompt und Runtime-Umschaltung werden phasenweise integriert,
  damit bei einem Fehler auf den letzten vollstaendig konsistenten Commit
  zurueckgegangen werden kann. Ein Zustand „neuer Prompt-Builder, alte
  getrennte Toolauflosung“ darf nicht ausgerollt werden.
- Bei unerwarteter Matrixabweichung ist der sichere Betriebsmodus: betroffene
  Tools fuer den Turn leer lassen und eine klare Nichtverfuegbarkeit melden,
  nicht ungefilterte Defaults verwenden.

## Risiken und Gegenmassnahmen

- **Promptgroesse:** Eine Vollauflistung kann gross werden. Progressive
  Gateways bleiben kompakt; Beschreibungen werden begrenzt, Toolnamen und
  Sicherheitsinvariante jedoch nie abgeschnitten.
- **Gateway-Namensverwechslung:** Config-Operationen und registrierte
  Gateway-Schemas sind nicht identisch. Der getrennte Manifestvertrag und
  exakte Gleichheitstests verhindern scheinbar direkte Operationen.
- **Historische Snapshot-Semantik:** Ein alter Snapshot kann Capabilitytext
  enthalten. Der Versionsmarker und die einmalige Invalidierung verhindern
  Wiederverwendung.
- **Kundenspezifische TOOLS.md:** Freitext kann weiterhin falsche Wuensche
  enthalten. Der effektive Block supersediert sie sichtbar; Doctor warnt und
  die serverseitige Policy blockiert. Eine semantische automatische
  Umschreibung findet nicht statt.
- **Tool-Klassifikationsluecken:** Neue mutierende Tools koennten ohne Policy-
  Metadaten erscheinen. Neue Tools muessen fail-closed klassifiziert sein;
  ein Contracttest schlaegt bei fehlender Klassifikation fehl.
- **Reload-Race:** Prompt und Toolarray duerfen nicht einzeln mutiert werden.
  Eine gemeinsame Runtime-Revision und Turnrand-Umschaltung verhindert
  Mischzustaende.
- **E-Mail-Regression:** Read-only-Dateien duerfen keinen Pfad zu Secrets,
  anderen Workspaces oder Schreiboperationen oeffnen. Bestehende Pfadguards,
  Workspace-Kontext und negative Cross-Scope-Tests bleiben Pflicht.
- **Ticket-16-Ueberschneidung:** Falls Providerresolver parallel geaendert
  werden, bleibt Ticket 18 Owner des aus dem finalen Toolarray gebauten
  Manifests; Ticket 16 darf die vorgelagerte Runtimeauswahl liefern, aber
  keinen zweiten Prompt-Tool-Resolver einfuehren.

## Definition of Done

- Jeder Modell-Turn in normaler Session, Delegation und Automation erhaelt
  Prompt und Tool-Schemas aus derselben effektiven Aufloesung.
- Canvas-kontrollierte Promptbloecke und unveraenderte Templates behaupten
  keine nicht vorhandene Capability.
- Ein Agent ohne Dateiwerkzeuge erhaelt weder Datei-Guidance noch
  Workspace-Dateibaum und versucht in der manuellen Capability-Abnahme keinen
  nicht registrierten Datei-Call.
- Der eingebaute E-Mail-Agent kann standardmaessig genau die notwendigen
  Workspace-Dateien lesen und Mailbox-/Inbox-/Outbox-Arbeit erledigen, aber
  weder Dateien veraendern noch Shell, Delegation, Verwaltung, externe
  Connectoren oder Versand nutzen.
- E-Mail-Event-Automationen bleiben auf die ausloesende Mailbox und dieselbe
  Least-Privilege-Obergrenze begrenzt.
- Manipulierte Agenten-, Toolset-, Workspace- oder Automationseingaben koennen
  serverseitige Rechte nicht erweitern.
- Planning Mode, Reload, Browserzustand, Providerprofil und Workspacewechsel
  halten Prompt-/Toolrevisionen konsistent.
- Die parametrische Matrix, alle betroffenen Bestandstests, Lint und
  `npm run build` sind gruen.
- Manuelle UI-/Runtime-Abnahme wurde nur nach expliziter Browserfreigabe
  dokumentiert.
- Ticket und Index werden erst nach der Implementierungsabnahme auf
  `erledigt` gesetzt.
