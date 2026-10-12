# Workflow-Vertrag (Schritt 5c-b)

Dieser Vertrag beschreibt die implementierten Paket-, Konfigurations- und Laufzeitfelder im Arbeitsstand von Schritt 5c-b. Er dokumentiert keine abschließende QA-Abnahme.

## Portables Paket

Plugins deklarieren optional `workflow` in `.canvas-plugin/plugin.json`; eigenständige Skills und Plugin-Skills verwenden `agents/canvas.yaml` im jeweiligen Skill-Verzeichnis. Der neue Block hat folgenden Vertrag:

```ts
type Workflow = {
  version: 1;
  integrationCapabilities: Array<{
    id: string;
    application: string;
    required?: boolean; // Standard: true
    alternatives: Array<
      | { source: 'mcp'; connector: string; requiredTools?: string[] }
      | { source: 'composio'; toolkit: string; requiredTools?: string[] }
    >;
    skillRefs?: string[];
  }>;
};
```

Eine Capability verwendet eine gewählte Alternative (OR). Alle Pflicht-Capabilities müssen erfüllbar sein (AND). `requiredTools` beschreibt benötigte Funktionen für die Bereitschaftsprüfung; es erteilt keine Tool-Rechte. `skillRefs` ordnet Kontext aus dem tatsächlichen Paketinventar beziehungsweise ausdrücklich deklarierten Seed-Skills zu und lädt keine fremden Pakete nach.

Nur eigenständige Skills dürfen zusätzlich `workflow.mcpConnectors` deklarieren. Die strikten Descriptor-Felder sind `name`, `label`, `reason`, `recommended`, `required`, `configPath`, `env` und `oauth` gemäß dem bestehenden MCP-Descriptor-Vertrag. Plugin-Workflows und Plugin-Skills referenzieren stattdessen genau eine tatsächliche `connectors.mcp`-Deklaration des Elternpakets. Ihr eigener `mcpConnectors`-Block wird abgewiesen.

Die vorhandenen Felder `connectors`, `mcpServers` und `composioToolkits` behalten ihre bisherige Bedeutung. Eine neue Alternative hebt insbesondere keinen unabhängig erforderlichen Legacy-Connector auf. Für eine Alternative muss dessen bisherige Pflichtdeklaration gegebenenfalls ausdrücklich optional sein.

Die neuen Blöcke sind begrenzt und strikt: unbekannte Felder, doppelte Schlüssel beziehungsweise Identitäten und ungültige Referenzen werden abgewiesen. Die vollständige Paketvalidierung prüft Referenzen mit dem tatsächlichen Eltern-/Skill-/Connector-Inventar. Es gibt keine rekursive Import- oder Dependency-Sprache. Die permissive Verarbeitung anderer Legacy-Felder wird dadurch nicht neu definiert.

Elternpaket und Skill-Kind bilden getrennte Deklarationsbereiche. Gleiche Capability-IDs werden weder zusammengeführt noch überschrieben. Der Server erzeugt die Identität aus kanonischer Ressourcenreferenz, paketrelativem Deklarationspfad und Capability-ID. Die Deklarationspfade sind `.canvas-plugin/plugin.json`, `agents/canvas.yaml` oder der genaue Skill-Pfad wie `skills/design/agents/canvas.yaml`. Das portable Paket enthält keine Installations-, Nutzer-, Verbindungs-, Account- oder Credential-Referenzen.

Quelle: `app/lib/capabilities/workflow-contracts.ts`, die Plugin-/Skill-Manifestparser und `validateCompleteCapabilityPackage`.

## Konkrete Paket- und Agent-Zuordnung

`AgentWorkflowConfiguration` ist ein separater Instanzvertrag `{ version: 1, packages: [...] }`. Jede Paketzuordnung enthält:

| Feld | Bedeutung |
| --- | --- |
| `resourceRef` | Kanonische Ressourcenreferenz des veröffentlichten Plugins oder eigenständigen Skills. |
| `publishedRevisionRef`, `checksum` | Genau ausgewählte unveränderliche Veröffentlichung und vollständige Paketprüfsumme. |
| `skillSelection: { kind: 'plugin' }` | Vollständiges Skill-Inventar dieser Plugin-Revision und deren Eltern-Deklaration. |
| `skillSelection: { kind: 'skills', relativeRoots: [...] }` | Nur die genau gewählten Skill-Wurzeln dieser Revision; `''` bezeichnet einen eigenständigen Skill. Keine impliziten Geschwister oder Eltern-Workflow-Deklarationen. |
| `declarations` | Ausgewählte `declarationPath`-Bereiche mit `capabilities: [{ capabilityId, required?, selection }]`. |

Das zusätzlich akzeptierte `childRelativeRoot` muss mit einer einzelnen tatsächlichen Skill-Auswahl übereinstimmen; es ersetzt `skillSelection` nicht. `StoredAgentWorkflowPackage.selectedSkills: [{ name, relativeRoot }]` wird ausschließlich aus der validierten Veröffentlichung abgeleitet. Dieses private Feld ist kein Configure-Input. Ein Plugin-Kind besitzt keinen eigenständigen Publisher-Pin: Paketreferenz und Revision gehören dem Elternpaket, der genaue relative Skill-Pfad begrenzt den Zugriff.

Ein neuer Paket-Head ersetzt die zugewiesene Revision nicht. Prompt, Datei-Lesewurzeln und Script-Autorisierung verwenden dieselben privat ausgestellten `HeldCapabilityPackageRuntimeBinding`-Belege. Auch ein im neuen Head entferntes Kind bleibt aus der alten Veröffentlichung verwendbar, solange die aktuelle Elternressource zugänglich ist und Organisationsnamensraum, Block-Policies und Nutzungsrechte dies weiterhin erlauben. Fehlende, manipulierte oder nicht bestätigte Paketdaten werden nicht durch einen anderen Head ersetzt.

Die Agent-Auswahl aktiviert nur die konfigurierten Pakete beziehungsweise Kinder für diesen Agenten. Persönliche Aktivierungspräferenzen müssen dafür nicht geändert werden. Block-Policies, reservierte Organisationsnamen und aktuelle `canUse`-Rechte bleiben verbindlich; bisherige Core-/explizit erforderliche Organisations-Skills behalten ihre bestehende Auswahlsemantik.

Quelle: `app/lib/agents/workflow-contracts.ts`, `preparePackage` und `app/lib/capabilities/packages/runtime-bindings.ts`.

## Verbindungen und Alternativen

Eine `selection` ist entweder fest oder zentral begrenzt wählbar:

```ts
type Selection =
  | { mode: 'fixed'; alternativeKey: string; target: Target; toolCap: string[] | null }
  | {
      mode: 'selectable';
      allowedChoices: Array<{ choiceId: string; alternativeKey: string; target: Target; toolCap: string[] | null }>;
      defaultChoiceId?: string;
      personalPolicy?: {
        sources: Array<'mcp' | 'composio'>;
        alternativeKeys: string[];
        toolCap: string[] | null;
        mcpDefinitionMappings?: Array<{ connector: string; serverDefinitionIds: string[] }>;
      };
    };
```

`alternativeKey` ist genau `mcp:<connector>` oder `composio:<toolkit>` aus der gewählten Deklaration. `toolCap: null` setzt keine zusätzliche Konfigurationsgrenze; es erweitert keine bestehenden Rechte. `[]` erlaubt keine Calls. Der tatsächliche Feldname ist **`personalPolicy.mcpDefinitionMappings`**. Ein Feld `personalDefinitionMappings` existiert nicht und wird vom strikten Vertrag abgewiesen.

Gemeinsame Targets enthalten `{ kind: 'shared', source, connectionRef, bindingRevision, mcpMapping? }`. `connectionRef` ist eine opake `canvas-connection:…`-Referenz; `bindingRevision` bindet die tatsächliche Einrichtung. MCP kann `mcpMapping: { kind: 'manager_confirmation' }` verlangen. Der Server hält dazu die bestätigte Zuordnung zum Connector sowie aktuelle Konfigurations-/Definitionsrevisionen privat. Anzeigenamen sind kein Zuordnungsbeweis. Aktuelle Nutzer-/Agent-/Team-/Organisationsfreigaben und deren Tool-Grenzen werden unabhängig geprüft.

Persönliche Targets enthalten `{ kind: 'personal', source, ownerUserId, providerRef, accountSelectionRef? }`. `ownerUserId` muss der tatsächliche Actor sein und verleiht keine Actor-Autorität. Beim öffentlichen Own-Choice-Request darf es fehlen; `bindOwnAgentWorkflowChoiceInput` ergänzt dann ausschließlich den authentifizierten Actor. Eine persönliche MCP-Auswahl muss zur ausdrücklich erlaubten `serverDefinitionIds`-Zuordnung ihres Connectors gehören; MCP akzeptiert kein `accountSelectionRef`. Organisationsagenten dürfen keine persönlichen Pakete oder festen persönlichen Accounts einbetten, können aber eine ausdrückliche `personalPolicy` für die eigene Auswahl ihrer Nutzer erlauben.

`listPersonalWorkflowProviderAccountChoices` liefert für persönliche Composio-Provider sichere Account-Labels mit `status`, `selectable` und opakem `accountSelectionRef`. Dieser serverseitige Auswahlbeleg bindet Actor, Kontext, Provider, Profil, Toolkit, Account und aktuelle Revisionen. `preparePersonalWorkflowProviderTarget` akzeptiert nur eine aktuelle Auswahl; ohne Auswahl ist ein authentifizierter Account nur bei genau einem aktiven Account eindeutig. Verifiziertes `no_auth` ist eine eigene Bindungsart. Bei Mehrdeutigkeit gibt es keinen „ersten Account“-Fallback.

Die gespeicherte persönliche Bindung hält Quelle, Profil, Toolkit, Provider-Modus und Account exakt privat fest. Profil-, Credential-, Account- oder Konfigurationswechsel erfordern eine neue gültige Auswahl. Ein privater Profilwechsel ersetzt keine feste gemeinsame Verbindung.

`GET /api/agents/workflow?view=personal-options` verwendet `listAgentWorkflowPersonalOptions` mit `agentId`, `capabilityKey`, optional `expectedWorkflowRevision`, `alternativeKey` und `providerRef`. Zuerst werden nur tatsächlich eigene, zentral erlaubte Provider mit opaken Referenzen und `status: unverified` aus lokalem Zustand gelistet. Erst die ausdrücklich gewählte eigene Composio-App/-Provider-Referenz darf deren Account-Metadaten abfragen. Der sichere Options-Vertrag liefert Workflow-/Preference-Revisionen, erlaubte Alternativen und Provider-Labels sowie gegebenenfalls die opaken Account-Auswahlreferenzen. Fremde Profile, nicht erlaubte Apps/Alternativen und feste Slots werden vor Provider-I/O abgewiesen. Das gleichnamige Verhalten des normalen Agent-Tools `list_agent_workflow_personal_options` ist deshalb nicht für Planning freigegeben.

Quelle: `app/lib/agents/workflow-contracts.ts`, `prepareTarget` und `app/lib/integration-tools/workflow-personal-bindings.ts`.

## Atomare Verwaltung und eigene Auswahl

`updateManagedAgentConfiguration` prüft aktuelle Actor-/Workspace-Autorität und Agent-`canEdit`. Profil, native `enabledTools`, Modellvorgaben, Paket-Pins und Bindings werden auf derselben SQL-Verbindung atomar aktualisiert. `expectedRevision` schützt die Agent-Konfiguration; bei einer Workflow-Änderung ist zusätzlich `expectedWorkflowRevision` erforderlich. Ein ausgelassenes `workflow` erhält die Konfiguration, `workflow: null` hebt sie ausdrücklich auf. Workflow-Felder und Legacy-Capability-Felder dürfen nicht im selben Update konkurrieren. Eine bestehende Version-1-Konfiguration wird nicht durch Legacy-Binding-Felder umgangen.

Pflicht-Capabilities der ausgewählten Deklarationen dürfen nicht entfernt oder herabgestuft werden. Konfigurierte Tool-Grenzen müssen deren `requiredTools` enthalten, und die aktuelle Verbindung muss sie tatsächlich erlauben. Provider-Abfragen zur Vorbereitung erfolgen außerhalb gehaltener SQL-Transaktionen; vor dem Commit werden lokale Autorität und konkrete Bindungsrevisionen nochmals geprüft.

`setManagedAgentWorkflowChoice` benötigt nur aktuelle Agent-`canUse`, aber einen zentral als `selectable` eingerichteten Slot. Der strikte Request enthält `agentId`, `capabilityKey`, `expectedWorkflowRevision`, `expectedPreferenceRevision` und genau eines von:

- `choiceId`: eine zentral erlaubte Choice; `null` entfernt ausdrücklich die eigene Auswahl.
- `personalSelection: { alternativeKey, target }`: die gemäß `personalPolicy` erlaubte tatsächliche eigene Verbindung beziehungsweise Account-Auswahl.

Die Aktion verändert nur `agent_user_preferences.preferences_json.workflowChoices` für diesen Agenten und Actor. Die eigene CAS-Revision steigt, zentrale Workflow-/Agent-Revision, Paket-Pins und Grants bleiben unverändert. Eine gespeicherte Auswahl mit veralteter Workflow-Revision fällt geschlossen aus. Nur ohne eigene gespeicherte Auswahl kann `defaultChoiceId` greifen; ein ungültiger eigener Eintrag wird nicht still ersetzt.

Die Persistenzfelder sind `agents.workflow_version`, `agents.workflow_revision`, `agent_capability_bindings.configuration_json` und die genannten eigenen Preferences. `PATCH /api/agents` verwendet den gemeinsamen strikten Konfigurationsvertrag. `GET /api/agents/workflow?agentId=…` inspiziert; `view=options` liefert Optionen, und `PATCH /api/agents/workflow` speichert die eigene Auswahl. Actor-Identität kommt aus der authentifizierten Session. Angefragte Organisations-/Workspace-/Projekt-IDs werden aktuell kanonisch geprüft und sind keine Rechtebelege.

## Sichere Reader-DTOs

`AgentWorkflowDescriptor` enthält `agentId`, `revision`, `workflowVersion`, `workflowRevision`, `preferenceRevision`, aktuelle `access`, optional `unavailablePackageCount` und lesbare Paket-Pins. Der Count gibt die Anzahl konfigurierter Pakete ohne aktuelle Use-Autorität an, ohne deren private Identitäten offenzulegen. Bei einem positiven Wert warnt der Chooser und sperrt Auswahl, Save und persönliche Provider-Probes; Reload und Close bleiben verfügbar. Capability-Einträge enthalten `capabilityKey`, `capabilityId`, `application`, `required`, `selectionMode`, sichere `choices`, optional `selectedConnection`, `selectedChoiceId`, `personalChoiceAllowed`, `selectedKind` und `selectionOrigin: fixed | default | user | stale`.

`AgentWorkflowConnectionOption` enthält `label`, `availability`, `status` und gegebenenfalls `source`, `scopeLabel` und die erlaubte opake gemeinsame `connectionRef`. Persönliche Targets werden als persönliche MCP-/Composio-Auswahl beschrieben; rohe Account-/Profil-/Provider-Actor-IDs, Tokens, private Fingerprints und Backend-Konfiguration fehlen im normalen DTO. Die Account-Auswahlliste ist ein separater ausdrücklich aufgerufener Helper mit opaken Auswahlreferenzen.

`availability` bildet aktuelle lokale Autorität und Einrichtung ab. `status: unknown` behauptet keine geprüfte Provider-Erreichbarkeit; ein ausstehendes gemeinsames Setup kann `setup_required` zeigen. Inspect darf für aktuelle Agent-Use-, Edit- oder Manage-Berechtigte verfügbar sein. Nur die gesondert geprüfte tatsächliche `canUse`-Autorität erlaubt Runtime-Nutzung; ein Manager-/Editor-Reader-Beleg allein genügt nicht.

## Provider-Matrix und Dispatch

`resolveAgentWorkflowRuntimeProjection` kompiliert aus dem aktuellen privat ausgestellten Reader-/Paketbeleg eine `IntegrationPolicy.providerToolRules`-Matrix. Jede Regel bindet `source`, `providerRef`, `allowedToolNames` und `allowedOperations`. Die erlaubten Namen sind die Schnittmenge aus `toolCap`, aktuellen Verbindungs-/Grant-Grenzen und allen bestehenden Source-, App-, Tool-, Operations-, Workspace- und Delegationsgrenzen. Mehrere legitime Anforderungen an denselben Provider können dort zusammengeführt werden; Tool-Namen eines anderen Providers schalten ihn niemals frei.

Fehlend/null erhält den Legacy-Matrixvertrag. `[]` verweigert sämtliche Provider; innerhalb einer eingeschränkten Matrix wird eine fehlende Provider-Regel verweigert. Fehlerhafte/doppelte Regeln und fehlende Pflichtauswahlen fallen geschlossen aus. Ein optionales nicht verfügbares Binding öffnet keine Ersatzverbindung.

Die Matrix gilt vor Discovery/Pagination, Beschreibung und Call. Vor der Bereitschaftsprüfung eines Calls werden die bereits ausgestellten `toolRef`-/`schemaRef`-Identitäten gegen aktuellen Kontext, Quelle, Provider, Tool, App und Call-Rechte geprüft. Erst danach darf `assertAgentWorkflowRuntimeReady` ausgewählte Pflicht-Provider prüfen. Auch dort muss `requiredTools` bereits eine Teilmenge der tatsächlichen erlaubten Tools sein, bevor ein Provider abgefragt wird. Die Bereitschaftsprüfung fügt keine Grants hinzu.

Workflow-Agenten verwenden den gemeinsamen `integrations`-Gateway. Bereits geladene Legacy-MCP-/Composio-Wrapper und direkte MCP-Tools prüfen vor weiterer Provider-Auflösung die aktuelle Workflow-Grenze erneut. Ein NULL-Legacy-Agent erhält durch den neuen Modus-Lookup keine zusätzlichen Workflow-Voraussetzungen; ungültige Versionen, Revisionen oder ein NULL-Header mit gespeicherter Workflow-Konfiguration bleiben Fehler. Tatsächliche externe Aufrufe behalten die vorhandene persistierte Session-/Workspace-/Agent-Autorisierung.

`schemaRef` bindet den aktuellen Kontext und Policy-Vertrag sowie Tool-Schema, konkrete Account-/Verbindungs- und Versionsidentität. Vor dem tatsächlichen Provider-Dispatch werden Kontext, Workflow-Auswahl und Rechte frisch geprüft. Nach Änderungen sind neue gültige Referenzen erforderlich; es gibt keinen automatischen Provider-/Account-Wechsel. Privat ausgestellte WeakMap-/WeakSet-Belege werden bei erlaubten Kontextübergängen serverseitig neu gebunden. Serialisierte JSON-Kopien verleihen keine Autorität.

## Planung, Bootstrap, E-Mail und Delegation

Initiales Planning ist vor der ersten Runtime-/Registry-Konstruktion bekannt und wird bei Tool-Reloads beibehalten. Planning und E-Mail-Automation erlauben keine externen Integration-Calls oder Provider-/SDK-Discovery. Die Workflow-Prüfung in dieser Phase verwendet SQL-/Datei-/Paketautorität. Paket-Capture im Bootstrap arbeitet mit `currentSnapshot(false)`; Prewarm verwendet `metadataOnlyExternal: true` und nur vorhandene direkte MCP-Metadaten. Der echte Turn lädt nach Anwendung seines Kontexts die normalen aktuellen Tools neu. Diese Grenze betrifft Provider-I/O, nicht sämtliche anderen Dienste einer Session.

Native Tools bleiben durch die zentrale Agent-Tool-Konfiguration gesteuert. E-Mail verwendet die bestehenden Canvas-Mailbox-/Fachtools und Review-Regeln; eine portable Integration-Capability verlagert E-Mail nicht zu Composio. Planning-/Automationsfilter erhalten die jeweils erlaubten nativen E-Mail-Operationen.

Der unterstützte Delegations-Elternagent ist aktuell ausschließlich Bradley (`DEFAULT_AGENT_ID`) in einer gespeicherten Conversation-Session mit Tiefe 0. Der eingebaute Main-Agent kann nicht über die Workflow-Konfigurations-API auf Version 1 umgestellt werden. Ein konfigurierbarer Workflow-Spezialagent erhält dadurch keinen neuen Delegations-Einstieg.

Ein verwalteter Zielagent verwendet seine eigenen zentral konfigurierten Paket-Pins und aktuellen Rechte, zusätzlich begrenzt durch die nachgewiesene aktive Delegationsaufgabe. Ein ephemerer Worker erhält Paketbelege nur als Schnittmenge der vorher gehaltenen Auswahl und seiner zulässigen exakten Pins; neue Heads oder zusätzliche Kinder werden nicht eingewechselt. Der bestehende execute-only-Composio-Handoff bleibt auf ausdrücklich beschriebene Elternreferenzen, aktuelle Eltern-/Kindrechte und exakte Account-/Schema-Identität beschränkt. Gemeinsame Parent-Agent-only-Grants übertragen sich nicht automatisch auf einen anderen Zielagenten.

Unbekannte Ausführungsergebnisse behalten die dauerhaften Turn-/Parent-Sperren: weder Worker, Automation noch Script-Brücke dürfen automatisch wiederholen oder auf einen anderen Provider ausweichen. Die Script-Brücke prüft ausgewählte Tool-/Schema-Referenzen über `inspectScriptBinding` und gibt dem Script beim Describe nur `{ schemaHandle, inputSchema }` zurück. Das interne `providerRef` aus `inspectIssuedToolIdentity` bleibt Teil der serverseitigen Identitäts-/Fingerprint-Prüfung.
