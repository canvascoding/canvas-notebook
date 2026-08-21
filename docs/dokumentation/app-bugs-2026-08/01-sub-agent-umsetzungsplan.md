---
title: 'Umsetzungsplan zu Ticket 01: Sub-Agent-Steuerung und Darstellung'
status: completed
date: 2026-08-21
branch: ticket/01-sub-agent-control
platforms: [web, server]
tags: [type/implementation-plan, topic/canvas-agent, topic/sub-agents]
---

# Umsetzungsplan: Sub-Agent-Steuerung und Darstellung

## Ziel und Arbeitsmodus

Dieser Plan setzt [Ticket 01](./01-sub-agent-steuerung-und-darstellung.md)
auf Basis der bereits vorhandenen Delegations-Runtime um. Die Arbeit erfolgt
streng sequenziell. Eine Phase beginnt erst, wenn die vorherige Phase
implementiert, getestet und als eigener fokussierter Commit abgeschlossen ist.

Die Implementierung bleibt fachlich getrennt:

- Actions/Policy entscheiden, **ob und mit welchem Scope** delegiert werden
  darf.
- Store und Dispatcher erledigen die wiederverwendbaren technischen
  Operationen fuer Persistenz, Queue, Ausfuehrung und Zustellung.
- API und Agent-Tool sind lediglich Adapter auf dieselbe serverseitige Action.
- Die UI darf Agenten und Toolsets vorschlagen, aber niemals Berechtigungen
  oder den effektiven Runtime-Scope bestimmen.

## Inventur des bestehenden Stands

Bereits vorhanden und weiterzuverwenden:

- `app/lib/pi/delegate-task-tool.ts`
  - startet temporaere oder verwaltete Agenten;
  - akzeptiert bereits `target_agent_id` und `toolsets`;
  - prueft den Zugriff auf verwaltete Ziel-Agenten;
  - entfernt `delegate_task` bei temporaeren Workern;
  - erlaubt das Tool nur dem Hauptagenten.
- `app/lib/pi/delegation-store.ts` und `pi_delegations`
  - speichern Parent-, Worker-, Agent-, Toolset-, Status- und Ergebnisdaten;
  - bilden Queue, Abbruch, Wiederanlauf und Zustellung ab.
- `app/lib/pi/delegation-dispatcher.ts`
  - fuehrt Delegationen asynchron und mit begrenzter Parallelitaet aus;
  - stellt Fertigmeldungen an die Parent-Session zu.
- `app/components/canvas-agent-chat/ChatDelegationPanel.tsx`
  - zeigt laufende und abgeschlossene Delegationen kompakt an;
  - unterstuetzt Abbruch und Polling.
- `app/components/canvas-agent-chat/chatMessageMapping.ts` und
  `useChatRuntimeEvents.ts`
  - blenden die interne Completion-Nachricht bereits aus dem sichtbaren Chat
  aus.
- Tool-, Runtime-, Store-, Dispatcher-, API- und UI-Scripttests existieren
  bereits teilweise.

Noch offen oder nicht hart genug abgesichert:

1. Worker-Sessions sind in `pi_sessions` nicht als solche klassifiziert und
   erscheinen dadurch in Web-, Mobile- und Agent-Sessionlisten.
2. Die Rekursionssperre beruht teilweise auf Agent-ID und Toolfilter. Der
   gemeinsame Runtime-Einstieg kennt keine serverseitig abgeleitete
   `delegationDepth`.
3. Eine nutzbare Startoberflaeche mit Ziel-Agent- und Toolset-Auswahl fehlt.
4. Fuer verwaltete Ziel-Agenten werden die angeforderten `toolsets` derzeit
   nicht pro Delegationslauf als harte Obergrenze angewendet.
5. Die Ergebnisliste zeigt nur sechs Eintraege und eine zweizeilige Vorschau;
   ein vollstaendiges, explizit aufklappbares Detail fehlt.
6. Mehrere vorhandene Delegationstests sind nicht als eigene npm-Scripts
   registriert und werden dadurch leicht uebersehen.

## Architekturentscheidungen

### 1. Session-Klassifizierung liegt in `pi_sessions`

`pi_delegations` bleibt die fachliche Task- und Ergebnisquelle. Fuer schnelle,
eindeutige History- und Runtime-Entscheidungen erhaelt `pi_sessions` zusaetzlich:

```ts
sessionKind: 'conversation' | 'delegation_worker'
parentSessionId: string | null
delegationId: string | null
delegationDepth: 0 | 1
```

Normale und bestehende Sessions erhalten die Defaults `conversation` und `0`.
Neu fuer eine Delegation erzeugte Sessions werden atomar als
`delegation_worker` mit Tiefe `1` angelegt. Eine bereits vorhandene normale
Managed-Agent-Session darf aus Kompatibilitaetsgruenden weiterhin angesprochen
werden, wird dadurch aber nicht nachtraeglich als Worker umklassifiziert oder
aus der Historie entfernt.

### 2. Rekursion wird an allen serverseitigen Eintrittspunkten blockiert

Eine gemeinsame Policy-Action laedt die Source-Session aus der Datenbank und
akzeptiert Delegation nur, wenn:

- die Session dem authentifizierten Nutzer gehoert;
- Agent, Workspace und Organization eindeutig und weiterhin zugaenglich sind;
- `sessionKind === 'conversation'` und `delegationDepth === 0` gelten;
- der Source-Agent der delegationsberechtigte Hauptagent ist;
- der Ziel-Agent existiert, nicht dem Source-Agent entspricht und im aktuellen
  Workspace mit `canUse` freigegeben ist.

Tool-Schema, UI und Prompt bleiben zusaetzliche Leitplanken. Die Runtime-Policy
ist die Autoritaet und lehnt manipulierte API- oder Tool-Aufrufe ebenfalls ab.

### 3. Effektive Tools sind immer eine Schnittmenge

Die effektiven Worker-Tools werden serverseitig berechnet:

```text
Agent-Konfiguration
∩ aktuelle Nutzer-/Workspace-Berechtigungen
∩ ausgewaehlte delegierbare Toolsets
− immer gesperrte Tools
```

Immer gesperrt sind mindestens Delegation selbst, Onboarding und
Agentenverwaltung. Die Auswahl kann Rechte nur reduzieren. Das Ergebnis wird
in `pi_delegations.toolsets_json` festgehalten und beim Laden bzw. erneuten
Laden der Worker-Tools wieder angewandt. Damit gilt dieselbe Begrenzung fuer
temporaere und verwaltete Worker sowie nach einem Runtime-Reconnect.

### 4. Ein gemeinsamer Startpfad fuer UI und Agent-Tool

Eine neue serverseitige Action, zum Beispiel
`app/lib/pi/delegation-actions.ts`, besitzt Normalisierung, Policy,
Agentenauflosung, Toolset-Auflosung und Enqueue. Sowohl `delegate_task` als auch
`POST /api/delegations` rufen diese Action auf. Der bestehende Dispatcher und
Store bleiben fuer technische Queue- und Persistenzmechanik zustaendig.

### 5. Ergebnis-Karte ist die sichtbare Quelle

Die interne Completion-Nachricht bleibt fuer den Parent-Kontext verfuegbar,
aber unsichtbar. Der sichtbare Parent-Hinweis wird kurz gehalten. Das
vollstaendige gespeicherte Ergebnis wird ausschliesslich nach Nutzeraktion in
der Delegationskarte aufgeklappt. So bleibt der Chat scannbar, ohne das
Arbeitsergebnis zu verlieren.

## Geplante API-Vertraege

### Optionen laden

`GET /api/delegations?sourceSessionId=...&options=true`

Liefert nur serverseitig freigegebene Ziele und Toolsets:

```json
{
  "success": true,
  "source": { "sessionId": "sess-parent", "canDelegate": true },
  "agents": [
    { "agentId": "research-agent", "name": "Research Agent", "iconId": "search" }
  ],
  "toolsets": [
    { "name": "file", "label": "Files", "available": true },
    { "name": "web", "label": "Web", "available": true }
  ],
  "defaults": { "workerType": "managed", "toolsets": ["file", "web"] }
}
```

### Delegation starten

`POST /api/delegations`

```json
{
  "sourceSessionId": "sess-parent",
  "targetAgentId": "research-agent",
  "goal": "Pruefe die Deployment-Dokumentation.",
  "context": "Konzentriere dich auf offene Risiken.",
  "toolsets": ["file", "web"]
}
```

Der Server leitet `userId`, `sourceAgentId`, Workspace, Organization,
Delegationstiefe und effektive Tools selbst her. Die Response ist die bereits
vorhandene serialisierte Delegation mit Status `queued` bzw. `running`.

### Details laden

`GET /api/delegations/[id]`

Liefert nach Ownership- und Parent-Pruefung Status, Agent-Metadaten, Laufzeit,
Toolsets, Vorschau und vollstaendiges Ergebnis. Der Listenendpunkt liefert nur
eine begrenzte Vorschau; dadurch werden lange Ergebnisse erst beim Aufklappen
uebertragen.

## Sequenzielle Implementierungsphasen

### Phase 1: Datenmodell und Session-Erzeugung

- `pi_sessions` in Drizzle-Schema und Migration um Session-Kind,
  Parent-Referenz, Delegation-ID und Tiefe erweitern.
- `CreatePiSessionWithRuntimeSnapshotInput` um explizite, serverinterne
  Delegationsmetadaten erweitern.
- Temporaere und neu erzeugte Managed-Worker atomar als
  `delegation_worker`/Tiefe `1` anlegen.
- Bestehende normale Sessions nicht umklassifizieren.
- Schema-, Migrations- und Session-Store-Tests fuer Defaults, Parent-Bezug und
  unzulaessige Tiefe ergaenzen.
- Verifikation: betroffene Tests und `npm run build`.
- Commit: `Classify delegated worker sessions`.

### Phase 2: Gemeinsame Policy-Action und harter Rekursionsschutz

- `delegation-actions.ts` als Orchestrierungsgrenze einfuehren.
- Source-Session, Workspace, Ziel-Agent und Berechtigungen dort erneut und
  unmittelbar vor Enqueue aufloesen.
- Delegation aus `delegation_worker` oder Tiefe `1` mit stabilem Fehlercode
  ablehnen.
- `delegate_task` auf die Action umstellen; direkte Startfunktionen bleiben
  intern und akzeptieren nur bereits autorisierte Requests.
- Negative Tests fuer manipulierte Source-Agent-ID, fremde Session, fremden
  Workspace, entzogenes Agentenrecht und Rekursion ergaenzen.
- Verifikation: Tool-, Action-, Access- und Runtime-Tests sowie
  `npm run build`.
- Commit: `Enforce delegation policy at runtime`.

### Phase 3: Toolset-Policy fuer alle Worker-Typen

- Eine zentrale `DELEGATABLE_TOOLSETS`-Allowlist definieren; Delegation,
  Agentenverwaltung und Onboarding ausschliessen.
- Optionen und effektive Tools aus Agentenprofil, Runtime-Registry und
  Workspace-Kontext berechnen.
- Die gespeicherten Toolsets bei jedem Tool-Load eines Worker-Kontexts als
  Obergrenze anwenden, inklusive Progressive-Gateway-Operationen.
- Bestehende temporaere Sonderfilter durch den gemeinsamen Mechanismus
  ersetzen, sobald die Tests Paritaet beweisen.
- Tests fuer unbekannte Toolsets, Rechteentzug, Reconnect/Reload, leere
  Schnittmenge und gesperrte Tools ergaenzen.
- Verifikation: Tool-Registry-, Delegation-Runtime- und Security-Tests sowie
  `npm run build`.
- Commit: `Restrict delegated worker capabilities`.

### Phase 4: Delegations-API fuer Optionen, Start und Details

- Options-, POST- und Detailvertrag implementieren; bestehendes GET-Listing und
  DELETE-Cancel beibehalten.
- Listenresponse auf Preview und benoetigte Kartenmetadaten begrenzen; volles
  Ergebnis nur im Detail laden.
- Fehlercodes fuer nicht delegierbare Source-Session, Agentenzugriff,
  Toolset-Policy, bereits laufende Zielsession und Rate Limit vereinheitlichen.
- API-Tests fuer Auth, Ownership, Workspace-Isolation, Agentenfilter,
  Toolset-Reduktion, Start, Detail und Cancel ergaenzen.
- Die vorhandenen Store-, Dispatcher-, API- und UI-Scripttests als eigene
  npm-Scripts registrieren.
- Verifikation: alle Delegations-Scripttests und `npm run build`.
- Commit: `Add user-facing delegation API`.

### Phase 5: Worker aus allen normalen Historien entfernen

- Web-Sessionliste und deren Count-Pfad standardmaessig auf
  `sessionKind = conversation` begrenzen.
- Mobile-Sessionliste und Inbox-Sessioncounts gleich filtern.
- `session_search` darf Worker nicht beim normalen Browse oder Discovery
  zurueckgeben. Worker-Details bleiben nur ueber die Parent-Delegation
  erreichbar.
- Retention, Loeschen und Agent-Delete-Preview pruefen: Worker muessen beim
  Parent-/Agent-Lifecycle kontrolliert mitbehandelt werden, duerfen aber nicht
  als normale Nutzersession erscheinen.
- Regressionstests fuer Web, Mobile, Search, Counts und Parent-Zugriff
  ergaenzen.
- Verifikation: Session-, Mobile-, Search- und Delegationstests sowie
  `npm run build`.
- Commit: `Hide worker sessions from chat history`.

### Phase 6: Startdialog und kompakte Ergebnis-Karten

- `ChatDelegationPanel` auch ohne vorhandene Tasks als Startpunkt fuer
  delegationsberechtigte Parent-Sessions rendern.
- Einen responsiven Dialog fuer Ziel-Agent, Ziel, Kontext und Toolsets bauen;
  Agentenname und Icon statt technischer ID darstellen.
- Optionen beim Oeffnen frisch laden, Submit gegen Doppelklick sperren und
  Serverfehler klar im Dialog anzeigen.
- Karten standardmaessig einklappen; Status, Agent, Dauer, Toolsets und kurze
  Vorschau anzeigen. Volltext beim ersten Aufklappen ueber den Detailendpunkt
  laden.
- Pagination oder „Weitere laden“ statt harter Begrenzung auf sechs Tasks
  ergaenzen.
- Completion-Prompt und sichtbaren Parent-Hinweis auf eine kurze,
  handlungsorientierte Zusammenfassung begrenzen.
- Deutsche und englische Texte sowie Accessibility-Labels ergaenzen.
- Verifikation: Komponenten-/API-Tests und `npm run build`; manueller
  UI-/E2E-Test mit Playwright oder Chrome erst nach expliziter Freigabe.
- Commit: `Add delegated task controls to chat`.

### Phase 7: Gesamtabnahme und Ticketabschluss

- Vollstaendige Delegations-Testgruppe ausfuehren:
  - Tool und Policy;
  - Store und Migration;
  - Dispatcher und Wiederanlauf;
  - temporaere und Managed-Runtime;
  - API, History-Filter und UI-Mapping;
  - Agent-/Workspace-Isolation.
- `npm run lint` fuer betroffene Dateien und abschliessend `npm run build`.
- Mit expliziter Browserfreigabe den Flow auf `localhost:3000` pruefen:
  Parent-Session oeffnen, Agent und Toolsets waehlen, Task starten, Status
  verfolgen, Ergebnis aufklappen, Session-Historie kontrollieren und einen
  Rekursionsversuch negativ bestaetigen.
- Ticketstatus und [Index](./README.md) erst nach erfolgreicher Abnahme auf
  `erledigt` setzen.
- Abschlusscommit: `Complete subagent controls ticket`.

## Testmatrix

| Bereich | Positiver Fall | Negativer/Sicherheitsfall |
| --- | --- | --- |
| Agentenauswahl | freigegebener Managed Agent im Source-Workspace | fremder, geloeschter, Source- oder nicht freigegebener Agent |
| Toolsets | ausgewaehlte Schnittmenge steht dem Worker zur Verfuegung | unbekanntes, nicht konfiguriertes oder immer gesperrtes Tool |
| Rekursion | Parent mit Tiefe 0 startet genau einen Worker | Worker-Session/API-Manipulation versucht Tiefe 2 |
| Historie | Parent bleibt sichtbar, Karte zeigt Worker | Worker erscheint in Web, Mobile, Count oder `session_search` |
| Ergebnis | Preview sofort, Volltext erst nach Aufklappen | fremder Nutzer liest Detail oder Worker-Session |
| Lifecycle | Queue, Run, Completion, Cancel und Restart-Recovery | Doppelstart, laufende Zielsession, Zustellfehler oder Rechteentzug |

## Definition of Done

- Alle Abnahmekriterien aus Ticket 01 sind nachweislich erfuellt.
- UI und Agent-Tool nutzen dieselbe serverseitige Policy-Action.
- Rekursion ist nicht nur ueber Prompt oder fehlendes Tool, sondern ueber den
  gespeicherten Runtime-Kontext hart auf Tiefe `1` begrenzt.
- Worker-Sessions fehlen in allen normalen Web-, Mobile- und Agent-Historien,
  bleiben aber ueber die Parent-Delegationskarte nachvollziehbar.
- Die pro Lauf gewaehlten Toolsets koennen den effektiven Agent-Scope nur
  verkleinern und gelten auch nach Reload/Reconnect.
- Ergebnisse sind kompakt und bei Bedarf vollstaendig einsehbar.
- Alle neuen und bestehenden Delegationstests, Lint und Build sind gruen.
- Jede Phase besitzt einen eigenen fokussierten Commit; erst danach beginnt
  Ticket 02.

## Abschlussnachweis

- Phasen-Commits: `91f3e726`, `64aaffc4`, `4ec4e129`, `a48e36ed`,
  `96f94dc2`, `33831b9d`.
- Erfolgreich ausgefuehrt: Delegation-Runtime-, Tool- und UI-Scripttests,
  TypeScript-Pruefung, gezieltes ESLint und `npm run build`.
- Der Build gab lokale Hinweise zu `BETTER_AUTH_BASE_URL` bzw. der Better-Auth
  Base-URL aus, endete aber erfolgreich.
- Eine interaktive Browser-Abnahme wurde gemaess Repository-Regel nicht ohne
  ausdrueckliche Freigabe gestartet.
