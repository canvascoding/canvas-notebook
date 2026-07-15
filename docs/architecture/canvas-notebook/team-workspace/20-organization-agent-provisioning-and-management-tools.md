# Organization Agent Provisioning and Agent Management Tools

Stand: 2026-07-15

## Zweck

Dieses Dokument legt fest, wie vollwertige Canvas-Agenten als Personal- oder Organization-Ressource erstellt, konfiguriert, Mitarbeitern beziehungsweise Workspaces zugewiesen und durch den Standardagenten ueber validierte Agent-Tools verwaltet werden.

Der Zielablauf lautet:

1. Ein Owner oder berechtigter Nutzer sagt dem Standardagenten beispielsweise: "Erstelle einen Marketing-Agenten fuer den Marketing-Workspace."
2. Der Standardagent ermittelt die benoetigte Agent-Konfiguration und die verfuegbaren Organization-/Personal-Skills, Plugins, Verbindungen, Modelle und Tools.
3. Der Standardagent laedt per Progressive Disclosure nur das Schema der konkret benoetigten Management-Operation.
4. Dieselbe serverseitige Agent-Management-Logik, die auch Settings-UI und REST-API nutzen, validiert Scope, Rechte, Capability-Referenzen und Konflikte.
5. Der neue Agent wird mit derselben fachlichen Konfiguration wie bei manueller Erstellung angelegt und den erlaubten Nutzern, Rollen, Workspaces oder Projekten zugewiesen.

Der Agent-Tool-Pfad darf kein zweiter, abweichender Agent-CRUD werden.

## Ausgangsbefund

Bereits vorhanden:

- Die Tabelle `agents` speichert Name, Icon, Modell-Defaults, Tool-Override, relevante Skills und relevante Connections.
- `/api/agents` kann Agenten erstellen, aktualisieren, auflisten und loeschen.
- Der Create-Agent-Dialog kann Templates, Agent-Dateien, Modell/Thinking, Tools, Skills und Connections konfigurieren.
- Im aktuellen Arbeitsstand existiert mit `agent_members` eine individuelle Agent-Freigabe mit `canUse`, `canEdit` und `canManage`.
- Die Tool-Registry besitzt Progressive-Disclosure-Gateways mit `search`, `describe` und `call`.
- Read-only Automation-Tools bleiben direkt sichtbar, waehrend schreibende Automation-Operationen im Gateway `automation_manage` zusammengefasst werden.
- Organization-Skills und Organization-Plugins besitzen seit Aufgabe `49` stabile scope-aware Referenzen, immutable Versionspakete, Policy-Kaskade, Konfliktblockierung, persoenliche Aktivierung und user-spezifische Connection Readiness.

Zum Planungszeitpunkt noch fehlend:

- `agents` besitzt keinen eindeutigen Personal-/Organization-Scope mit Owner und Creator.
- Agent-Freigaben gelten nur fuer einzelne User, nicht fuer Organization, Rolle, Workspace oder Projekt.
- Agent-Definition und agent-/user-spezifischer Zustand werden im Filesystem nicht sauber getrennt.
- Agent-Skill-/Plugin-Zuordnungen sind lose Namenslisten statt stabiler, scope-aware Referenzen.
- UI und REST-Route orchestrieren Agent-Erstellung direkt; es gibt noch keine gemeinsame Agent-Management-Anwendungsschicht fuer UI, API und Tool.
- Es gibt keine aktive Tool-Kategorie fuer Agent-Definitionen und keinen Progressive-Disclosure-Gateway fuer Agent-Management.

## Implementierungsstatus

Status: `complete` seit 2026-07-15.

Die geplante Architektur ist umgesetzt:

- `agents` besitzt `scopeType`, Organization-, Owner- und Creator-Kontext sowie eine optimistisch gepruefte `revision`. SQLite- und Postgres-Migrationen legen zusaetzlich Grants, stabile Capability-Bindings und user-spezifische Preferences an und migrieren Bestandsagenten.
- `app/lib/agents/management-actions.ts` ist die gemeinsame fachliche Anwendungsschicht fuer REST, UI und Agent-Tools. Profil, Runtime, Capabilities, Managed Files, Grants, Loeschvorschau und Loeschung verwenden dieselben Permission-, Validierungs-, Revisions-, Rollback- und Audit-Regeln.
- Organization-Definitionen liegen zentral unter `/data/organizations/{organizationId}/agents/{agentId}/definition/`. Persoenliches `MEMORY.md` bleibt unter `/data/users/{userId}/agents/{agentId}/`; Legacy-Pfade werden nur als Migrations-Fallback gelesen.
- `agent_grants` bildet Organization-, Rollen-, Workspace-, Projekt- und User-Zuweisungen mit `canUse`, `canEdit` und `canManage` ab. Session-, Delegation-, Chat- und Ausfuehrungspfade reichen den Workspace-/Projektkontext an dieselbe Access-Aufloesung weiter.
- `agent_capability_bindings` speichert stabile Task-49-Referenzen. Organization-Agenten koennen keine user-scoped Plugins oder Skills binden; Plugin-Skills werden aus der effektiven Plugin-Ressource abgeleitet. Readiness und blockierte beziehungsweise fehlende Ressourcen werden strukturiert ausgegeben.
- `/api/agents`, `/api/agents/files`, `/api/agents/grants` und `/api/agents/delete-preview` sind Adapter der Management Actions. Mutationen verlangen `expectedRevision`; Loeschungen verlangen zusaetzlich einen kurzlebigen revisionsgebundenen Bestaetigungstoken.
- `app/lib/pi/agent-management-tools.ts` stellt `list_agents` und `inspect_agent` direkt und planning-safe bereit. Mutationen werden zur Laufzeit ueber das Progressive Gateway `agent_manage` mit `search`, `describe` und `call` geladen. Gruppe und Toolset heissen `Agents`; alle Agent-Management-Capabilities sind standardmaessig deaktiviert und nur fuer den Main Agent zulaessig.
- Der Settings-Dialog erstellt Personal- oder Organization-Agenten mit Templates, Modell/Thinking, Tools, Skills, Plugins, Connections und Managed Files. Organization-Agenten koennen anschließend zentral an Organization, Rolle, Workspace, Projekt oder User vergeben werden; Scope und Revision sind im Agent-Katalog sichtbar.
- Eine vollstaendige `create_agent`-Spezifikation mit Capability-Bindings, Connection-Anforderungen und initialen Grants bildet das Ausstattungspaket fuer einen Mitarbeiter oder Workspace. Sie referenziert Organization-Ressourcen, ohne Owner-Secrets oder persoenliche Connections zu kopieren; ein separates persistiertes Template-Objekt ist dafuer nicht erforderlich.
- Main Agent, letzter Manager und fremde Personal-Agenten sind geschuetzt. Spezial-Agenten duerfen keine Agent-Management-Tools erhalten. Audit-Eintraege speichern Actor, Quelle, Scope, Operation und Revision sowie bei grossen Inhalten nur Hash/Laenge.

Abnahme am 2026-07-15:

- Service-, Tool- und API-Tests: `scripts/agent-management-service-test.ts`, `scripts/agent-management-tool-test.ts`, `scripts/agent-management-api-test.ts`.
- Regressionspruefungen fuer Agent Access, Managed Files, Runtime, Sessions, Delegation, Tool-Registry, Progressive Gateway und Organization-Capability-Aufloesung.
- Playwright-E2E auf Desktop und Mobile: Personal- und Organization-Erstellung, Scope-Anzeige, Revisionsfortschritt, ungueltiger Grant, Rollen-Grant, Gruppe `Agents`, default-disabled/on-demand Tools und Loeschvorschau.
- `npx tsc --noEmit`, `npm run lint` und `npm run build` erfolgreich.

## Grundentscheidungen

### 1. Scope und Verteilung getrennt modellieren

Jede Agent-Definition hat einen Besitz-/Lebenszyklus-Scope:

```ts
type AgentScopeType = "user" | "organization" | "system";

type AgentOwnership = {
  scopeType: AgentScopeType;
  organizationId: string | null;
  ownerUserId: string | null;
  createdByUserId: string;
};
```

Die Zielgruppe ist davon getrennt:

```ts
type AgentGrantTargetType = "organization" | "role" | "workspace" | "project" | "user";

type AgentGrant = {
  agentId: string;
  targetType: AgentGrantTargetType;
  targetId: string;
  canUse: boolean;
  canEdit: boolean;
  canManage: boolean;
};
```

Ein Organization-Agent kann dadurch zentral gepflegt und trotzdem nur fuer den Marketing-Workspace, die Rolle `member` oder einzelne Mitarbeiter freigegeben werden. Workspace-/Projekt-Grants geben keinen zusaetzlichen Dateizugriff; der Nutzer braucht weiterhin die normalen Workspace-Rechte.

### 2. Gemeinsame Definition und persoenlichen Zustand trennen

Organization-Agenten verwenden eine zentral gepflegte Definition:

```txt
/data/organizations/{organizationId}/agents/{agentId}/definition/
  AGENTS.md
  SOUL.md
  TOOLS.md
  HEARTBEAT.md
```

Persoenlicher Zustand bleibt user-scoped:

```txt
/data/users/{userId}/agents/{agentId}/
  MEMORY.md
  preferences.json
```

`USER.md` bleibt Kontext des ausfuehrenden Users. Ein zugewiesener Mitarbeiter erhaelt damit dieselbe Organization-Agent-Definition, aber keine privaten Erinnerungen oder Secrets des Erstellers.

Personal-Agenten koennen Definition und Zustand weiterhin unter dem User-Scope halten. Verzeichnisse mit dem Namen `agent-templates` sind nur fuer echte Kopiervorlagen gedacht; ein zentral aktualisierter Organization-Agent ist eine aktive Organization-Ressource und kein Template.

### 3. Skills und Plugins als scope-aware Capability-Referenzen

Ein Plugin ist eine Paketquelle, kein eigener Scope. Organization- und Personal-Plugins koennen jeweils Skills bereitstellen. Der Effective-Capability-Resolver laedt Kandidaten in dieser Reihenfolge:

1. Core-/System-Skills.
2. Organization-Policies fuer User, Rolle, Workspace und Projekt.
3. Organization-Standalone-Skills und Skills aus Organization-Plugins.
4. Personal-Standalone-Skills und Skills aus Personal-Plugins.
5. Konfliktpruefung ohne stilles Ueberschreiben.
6. User-Aktivierung fuer optionale Ressourcen.
7. Agent-Capability-Bindings als letzte Einschraenkung.

Dabei gewinnt `blocked` immer, `required` kann nicht persoenlich deaktiviert werden und Core-/Organization-/Plugin-Skills duerfen nicht still durch gleichnamige Personal-Skills ersetzt werden.

Agenten speichern langfristig stabile Referenzen statt nur Namen:

```ts
type AgentCapabilityRef = {
  resourceType: "skill" | "plugin" | "connection";
  scopeType: "organization" | "user" | "system";
  resourceId: string;
  version?: string;
  requirement: "optional" | "required";
};
```

Secrets, OAuth-Tokens und private Connector-Konfigurationen werden nie mit der Agent-Definition kopiert. Die Definition darf nur benoetigte Connection-Typen oder Secret-Namen deklarieren; die effektive Verbindung wird fuer den ausfuehrenden User und Workspace aufgeloest.

## Gemeinsame Anwendungsschicht

REST-Route, Settings-UI und Agent-Tool muessen dieselben fachlichen Aktionen aufrufen:

```txt
Settings UI ---------> /api/agents adapter -----\
                                                -> Agent management actions -> capability services
Standard agent ------> Agent tool adapter ------/
```

Empfohlene Schichtung:

### Adapter

- `app/api/agents/*`: Authentifizierung, HTTP-Parsing und HTTP-Responses.
- `app/lib/pi/agent-management-tools.ts`: Tool-Schemas, Progressive-Disclosure-Operationen und strukturierte Tool-Ausgaben.

### Application Actions

Neue zentrale Schicht, beispielsweise `app/lib/agents/management-actions.ts`:

- `listManagedAgents(actorContext, query)`
- `inspectManagedAgent(actorContext, input)`
- `createManagedAgent(actorContext, input)`
- `updateManagedAgentProfile(actorContext, input)`
- `updateManagedAgentRuntime(actorContext, input)`
- `updateManagedAgentCapabilities(actorContext, input)`
- `updateManagedAgentFile(actorContext, input)`
- `setManagedAgentGrant(actorContext, input)`
- `removeManagedAgentGrant(actorContext, input)`
- `deleteManagedAgent(actorContext, input)`

Diese Schicht besitzt fachliche Regeln, Permission-Entscheidungen, Revisionspruefung, Rollback-Orchestrierung, Audit und Fehlerklassifikation. Sie wird von HTTP und Agent-Tools identisch verwendet.

### Capability Services

Bestehende beziehungsweise kleine fokussierte Services behalten die wiederverwendbaren Mechaniken:

- Agent-Registry und Profile persistieren.
- Managed Agent Files lesen/schreiben.
- Modell-/Runtime-Defaults validieren.
- Agent-Grants persistieren.
- Effective Skills, Plugins, Connections und Tools aufloesen.
- Audit Events schreiben.

Kein Tool ruft intern die REST-Route auf. Die REST-Route darf umgekehrt auch keine Tool-Implementierung importieren.

## Tool-Kategorie und Progressive Disclosure

### Eigene Kategorie `Agents`

Agent-Definitionen gehoeren nicht in bestehende Kategorien:

- `Delegation` startet eine andere Agent-Session, verwaltet aber keine Agent-Definition.
- `Skills` verwaltet Erweiterungspakete, nicht Agent-Lebenszyklus oder Mitarbeiterzugriff.
- `Core` waere zu breit und wuerde Sicherheits- und Side-Effect-Hinweise verschleiern.

Deshalb werden ergaenzt:

- `PiToolGroup`: `Agents`
- `PiToolset`: `agents`
- Progressive Gateway: `agent_manage`

### Direkt sichtbare, planning-safe Leseoperationen

Analog zur Automation bleiben zwei kleine read-only Tools direkt sichtbar:

- `list_agents`: liefert nur berechtigte Agenten mit Scope, Kurzprofil, Readiness, Revision und Grant-Zusammenfassung.
- `inspect_agent`: laedt gezielt Profil, Runtime, Capability-Refs, verwaltete Dateien und Grants; grosse Inhalte nur ueber explizite `sections`.

Diese beiden Tools werden fuer Planning Mode freigegeben.

### Schreibende Gateway-Operationen

Das Gateway `agent_manage` enthaelt:

- `create_agent`
- `update_agent_profile`
- `update_agent_runtime`
- `update_agent_capabilities`
- `update_agent_file`
- `set_agent_access`
- `remove_agent_access`
- `delete_agent`

Nur das einzelne Gateway-Schema ist permanent im Modellkontext. Der Standardagent nutzt:

1. `search`, um die passende Operation zu finden.
2. `describe`, um exakt ein Parameterschema zu laden.
3. `call`, um die validierte Operation auszufuehren.

Die Settings-UI zeigt die einzelnen Gateway-Operationen weiterhin als getrennt aktivierbare Capabilities mit Badge `Bedarfsgesteuert`.

## Vollstaendige Konfigurationsparitaet

Der Agent-Tool-Pfad muss alle fachlichen Einstellungen der manuellen Erstellung und Bearbeitung abdecken:

| Bereich | Create | Update | Tool-Operation |
|---|---:|---:|---|
| Name, ID/Slug, Icon | ja | ja | `create_agent`, `update_agent_profile` |
| Personal-/Organization-Scope | ja | eingeschraenkt | `create_agent`, `update_agent_profile` |
| Modell, Provider-Installation, Thinking | ja | ja | `create_agent`, `update_agent_runtime` |
| Tool-Override | ja | ja | `create_agent`, `update_agent_capabilities` |
| Skill-Referenzen | ja | ja | `create_agent`, `update_agent_capabilities` |
| Plugin-Referenzen | ja | ja | `create_agent`, `update_agent_capabilities` |
| Connection-Anforderungen | ja | ja | `create_agent`, `update_agent_capabilities` |
| AGENTS.md, SOUL.md, TOOLS.md, MEMORY.md, HEARTBEAT.md | ja | ja | `create_agent`, `update_agent_file` |
| User-/Rollen-/Workspace-/Projektzugriff | ja | ja | `create_agent`, `set_agent_access`, `remove_agent_access` |
| Browser-/Heartbeat-Einstellungen, soweit im UI vorhanden | ja | ja | `create_agent`, `update_agent_runtime` |

`create_agent` darf eine vollstaendige initiale Spezifikation annehmen. Updates bleiben in kleinere Operationen getrennt, damit der Standardagent nicht fuer eine Namensaenderung ein riesiges All-in-one-Schema laden muss.

Jede Aenderung verwendet `expectedRevision`. Veraltete Updates werden ohne Teilmutation abgelehnt und verlangen ein neues `inspect_agent`.

## Permissions und Sicherheitsgrenzen

Ziel-Permissions:

- `canCreatePersonalAgents`
- `canManageOrganizationAgents`
- `canAssignOrganizationAgents`
- `canManageAgentCapabilities`

Bis zur feinen Permission-Migration gilt:

- Personal-Agent erstellen: aktiver interner User, sofern Organization-Policy es erlaubt.
- Organization-Agent erstellen: Owner/Admin.
- Agent bearbeiten: effektives `canEdit` plus Scope-Policy.
- Grants und Loeschung verwalten: effektives `canManage`; der letzte Manager bleibt geschuetzt.
- Organization-Skills/-Plugins anbinden: zusaetzlich passende Organization-Publish-/Policy-Permission.

Weitere Regeln:

- Das Management-Tool ist in V1 nur im Standardagenten `canvas-agent` verfuegbar.
- Spezial-Agenten erhalten `agent_manage` nicht automatisch und koennen in V1 keine rekursive Agentenfabrik erzeugen.
- Das Toolset `agents` ist standardmaessig deaktiviert und wird dem Standardagenten bewusst zugewiesen.
- Der Standardagent selbst kann ueber dieses Tool weder geloescht noch in seiner Basisdefinition ersetzt werden.
- Ein erstellter Agent kann nur Tools, Skills, Plugins und Connections referenzieren, die der Actor fuer den Ziel-Scope verwalten darf.
- Agent-Erstellung oder -Bearbeitung darf keine Workspace-, Secret-, Plugin- oder Model-Permissions erweitern.
- Organization-weite Freigaben, Entfernen des Zugriffs anderer User und Loeschungen erhalten vor Apply eine strukturierte Vorschau. Loeschung erfordert einen kurzlebigen, revisionsgebundenen Bestaetigungstoken.
- Normale Create-/Update-Auftraege brauchen einen expliziten Nutzerauftrag; Tool-Beschreibung und System Prompt untersagen proaktive Agent-Erstellung ohne Auftrag.
- Planning Mode erlaubt nur `list_agents` und `inspect_agent`; alle Mutationen bleiben blockiert.

## Tool-Ausgaben und Audit

Jede erfolgreiche Mutation liefert strukturiert:

- Agent-ID, Name, Scope und neue Revision.
- Geaenderte Bereiche, aber keine kompletten geheimen oder sehr grossen Inhalte.
- Capability-Readiness: verfuegbar, fehlt, blockiert oder persoenliche Verbindung erforderlich.
- Angelegte beziehungsweise entfernte Grants.
- Hinweise auf Konflikte, fehlende Integrationen oder erforderliche Admin-Aktion.

Audit speichert:

- `initiatedByUserId`
- `sourceAgentId`
- `sessionId`, `workspaceId`, `organizationId`
- Operation, Ziel-Agent, Scope, Revision und geaenderte Feldnamen
- Hashes beziehungsweise Laengen grosser Prompt-Dateien statt kompletter Inhalte
- keine Secrets, OAuth-Tokens oder vollstaendigen Agent-Prompts

## Provisioning UX

Nach Anlegen eines Mitarbeiters kann ein Owner ein Ausstattungspaket zuweisen:

```txt
Marketing Starter
  Agent: Organization Marketing Agent (canUse)
  Workspace: Marketing Team
  Skills: Brand Writing (required), Frontend Design (default-enabled)
  Plugins: Content Production (default-enabled)
  Connections: Google Drive erforderlich, Social Publishing optional
```

Die Zuweisung referenziert Organization-Ressourcen und kopiert sie nicht in jeden User-Scope. Persoenliche OAuth-Verbindungen oder Secrets werden beim ersten Einsatz als fehlende Readiness angezeigt und vom Mitarbeiter selbst beziehungsweise ueber eine explizite Organization-Verbindung eingerichtet.

## Implementierungsreihenfolge

Die Schritte werden nacheinander abgeschlossen und jeweils separat committed:

1. Organization-Skill-/Plugin-Registry, Policies und konfliktfreien Effective-Capability-Resolver fertigstellen.
2. Agent-Scope, Ownership, Grants und Migration fuer bestehende Agenten fertigstellen.
3. Agent-Definition und user-spezifischen Zustand im Storage trennen.
4. Bestehende `/api/agents`-Orchestrierung ohne Verhaltensaenderung in gemeinsame Management Actions extrahieren und API-Tests stabilisieren.
5. `Agents`-Toolgruppe, `agents`-Toolset sowie `list_agents` und `inspect_agent` implementieren.
6. Progressive Gateway `agent_manage` mit den schreibenden Operationen implementieren.
7. Agent-Capability-Referenzen und Readiness fuer Organization-/Personal-Skills, Plugins und Connections anbinden.
8. Provisioning-UI fuer User, Rolle, Workspace, Projekt und Ausstattungspakete ergaenzen.
9. Migration, Offboarding, Audit, Revision/Conflict-Tests und UI-/E2E-Pruefung abschliessen.

## Tests

Pflichttests:

- API und Tool erzeugen aus derselben Eingabe semantisch dieselbe Agent-Definition.
- Eine Validierungs- oder Persistenzkorrektur in den gemeinsamen Management Actions gilt gleichzeitig fuer UI/API und Tool.
- `list_agents` und `inspect_agent` zeigen nur berechtigte Agenten und keine fremden Personal-Agenten.
- `agent_manage` exponiert per Default nur sein Gateway-Schema; `describe` laedt exakt eine erlaubte Operationsstruktur.
- Tool-Metadaten zeigen Gruppe `Agents`, Toolset `agents`, Gateway-Zuordnung, Default-disabled und Planning-Mode-Regeln korrekt.
- Der Standardagent kann einen Personal-Agenten mit allen Create-Dialog-Feldern erstellen und danach vollstaendig inspizieren.
- Ein Owner kann einen Organization-Agenten erstellen und einem User, einer Rolle, einem Workspace oder Projekt zuweisen.
- Ein Member ohne Organization-Agent-Permission kann keinen Organization-Agenten erstellen oder Grants erweitern.
- `canUse`, `canEdit` und `canManage` werden in REST, Tool, Chat-Auswahl, Sessions, Delegation und Automations identisch erzwungen.
- Ein zugewiesener User erhaelt die gemeinsame Organization-Definition, aber eigene Memory-/Preference-Dateien.
- Organization-/Personal-/Plugin-Skill-Konflikte werden blockiert und nicht durch Aufloesungsreihenfolge versteckt.
- Required/blocked Organization-Policies koennen durch Agent- oder User-Konfiguration nicht umgangen werden.
- Fehlende persoenliche Plugin-Verbindungen werden als Readiness-Problem gemeldet; fremde Secrets werden nie aufgeloest.
- `expectedRevision` verhindert verlorene Updates; fehlgeschlagene Multi-Bereich-Erstellung hinterlaesst weder halbe Profile noch halbe Grants oder Dateien.
- Main Agent und letzter Agent-Manager bleiben vor Loeschung geschuetzt.
- Ein erstellter Spezial-Agent erhaelt nicht automatisch das Agent-Management-Tool.
- Audit enthaelt Actor-/Source-Agent-/Scope-/Revision-Metadaten, aber keine Secrets oder kompletten Prompt-Dateien.
- SQLite- und Postgres-Pfade verhalten sich gleich.
- `npm run lint`
- `npm run build`
- UI-/E2E-Test mit Playwright oder Chrome DevTools erst nach expliziter Freigabe.

## Akzeptanzkriterien

- Der Standardagent kann nach explizitem Nutzerauftrag einen vollwertigen Agenten mit derselben fachlichen Konfiguration wie die Settings-UI erstellen und bearbeiten.
- Agent-Management nutzt Progressive Disclosure und blaehlt den permanenten Tool-Kontext nicht mit allen Mutationsschemas auf.
- UI, REST und Agent-Tool verwenden dieselben fachlichen Management Actions, Validierungen, Permissions, Revisionen und Audit-Regeln.
- Personal- und Organization-Agenten besitzen eindeutige Ownership- und Storage-Scopes.
- Organization-Agenten koennen Usern, Rollen, Workspaces und Projekten mit `canUse`, `canEdit` und `canManage` zugewiesen werden.
- Skills und Plugins werden scope-aware und konfliktfrei aufgeloest; Agenten referenzieren stabile Capability-IDs statt impliziter Namensueberschreibung.
- Zentrale Agent-Definitionen werden geteilt, persoenliche Memory-/Preference- und Secret-Daten bleiben isoliert.
- Das Agent-Management-Tool kann keine Rechte, Secrets, Workspace-Zugriffe oder Tool-Capabilities ueber die Rechte des ausloesenden Users hinaus erweitern.
