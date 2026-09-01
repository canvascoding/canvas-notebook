# Tool Permissions und interaktive Freigaben

> Stand: 2026-08-28
> Status: Entwurf – noch nicht zur Umsetzung freigegeben
> Scope: Agent-Tools zuerst; direkte und Proxy-basierte MCP-Tools in einer anschliessenden Phase

## 1. Ziel

Canvas Notebook soll neben der bestehenden Frage, **ob ein Tool für einen Agenten verfügbar ist**, pro Tool entscheiden können, **wie ein konkreter Aufruf ausgeführt werden darf**.

Die drei sichtbaren Zustände sind:

| Modus | Bedeutung |
|---|---|
| `always_allow` | Der Agent darf das Tool ohne zusätzliche Interaktion ausführen. |
| `needs_approval` | Der Agent muss vor jedem konkreten Aufruf auf eine einmalige Entscheidung des Nutzers warten. |
| `blocked` | Der Agent darf das Tool nicht verwenden. Der Server lehnt auch Aufrufe aus alten Runtime-Snapshots zuverlässig ab. |

Das Modell orientiert sich an der Bedienung von Claude Code, bleibt aber in Canvas Notebook serverautorisiert: Weder Prompt, Browser-State noch vom Modell generierte Tool-Argumente dürfen eine Permission erzeugen oder umgehen.

## 2. Abgrenzung und Grundregeln

### 2.1 Nicht ersetzen, sondern ergänzen

Die vorhandene Tool-Auswahl (`enabledTools`) bleibt eine Capability-Allowlist. Eine Permission ist eine zweite, nachgelagerte Ausführungsentscheidung:

```text
Tool ist im Registry-Katalog vorhanden
  → Tool ist für den Agenten aktiviert
    → Workspace-, Rollen- und Spezial-Policy erlauben den Aufruf
      → effektive Tool-Permission wird ausgewertet
        → always_allow: ausführen
        → needs_approval: auf Nutzerentscheidung warten
        → blocked: serverseitig ablehnen
```

`blocked` ersetzt keine Workspace-ACL, Secret-Validierung, Browser-Policy, E-Mail-Regeln oder Tool-spezifischen Final-Commit-Check. Diese Schutzschichten bleiben immer aktiv.

### 2.2 Ziel-Scope der ersten Version

V1 betrifft nur interaktive Canvas-Chat-Sessions. Ein Approval kann dort über die bestehende WebSocket-Event-Pipeline sichtbar gemacht und beantwortet werden.

Folgende Ausführungsquellen dürfen in V1 **nicht warten**:

- Automationen und geplante Jobs
- Delegationen und Worker-Runs
- E-Mail- oder andere externe Channels
- mobile oder externe API-Clients, bis sie einen eigenen sicheren Approval-Flow unterstützen

Trifft ein solcher Run auf `needs_approval`, gibt der Server einen klaren, nicht ausführenden Tool-Fehler zurück. Er darf niemals stillschweigend zu `always_allow` eskalieren.

### 2.3 Empfohlene Defaults und Migration

- Bestehende aktivierte Tools werden bei der Migration als `always_allow` behandelt, damit ein Update keine laufenden Workflows unerwartet anhält.
- Neue native Tools erhalten einen dokumentierten Standard anhand ihrer Risikoklasse. Schreib-, Lösch-, Shell-, browsermutierende und externe Connector-Tools sollten standardmässig `needs_approval` erhalten; reine Lese-Tools können `always_allow` erhalten.
- Neue oder noch nicht klassifizierte MCP-Operationen sind `needs_approval`.
- Ein explizit gesetztes `blocked` gewinnt immer über geerbte oder automatische Defaults.

Die Risikoklasse ist nur ein Startwert für die UI. Sie ist keine Sicherheitsentscheidung und darf eine explizite Policy nie überschreiben.

## 3. Bestehende Architektur

Die folgenden vorhandenen Bausteine sind die Integrationspunkte:

| Bereich | Bestehender Ort | Relevanz |
|---|---|---|
| Tool-Metadaten und Capability-Filter | `app/lib/pi/tool-registry.ts` | Baut den Toolkatalog, wendet `enabledTools` an und kennt progressive Gateway-Operationen. |
| Haupt- und Agent-Konfiguration | `app/api/agents/tools/route.ts`, `app/lib/agents/effective-runtime-config.ts` | Liefert die effektive Agent-Konfiguration und speichert die aktuelle Tool-Auswahl. |
| Einstellungen | `app/components/settings/AgentToolsCard.tsx`, `AgentSettingsPanel.tsx`, `CreateAgentDialog.tsx`, `EditAgentProfileDialog.tsx` | Bestehende Liste, Filter, Gruppen und Vererbung für Tool-Konfiguration. |
| Tool-Ausführung | `app/lib/pi/live-runtime.ts` | Erzeugt den PI-Agenten und verteilt Runtime-Events an den Client. |
| PI-Agent-Core | `Agent`-Option `beforeToolCall` | Validiert Argumente und kann einen Tool-Call **vor** dessen Ausführung blockieren oder asynchron abwarten. |
| Event-Transport | `app/lib/pi/runtime-event-emitter.ts`, `server/chat-event-bridge.ts` | Sendet Runtime-Ereignisse an alle Session-Clients. |
| Direkte MCP-Tools | `app/lib/mcp/direct-tools.ts` | Macht `Server.tool` bereits als einzelne `AgentTool`-Instanzen verfügbar. |
| MCP-Proxy | `app/lib/mcp/proxy-tool.ts` | Führt dynamische Aufrufe via `mcp` + `action: call_tool` aus. |
| Audit | `app/lib/audit/audit-service.ts` | Bestehender Weg für nachvollziehbare serverseitige Ereignisse. |

Wichtige Feststellung: `beforeToolCall` ist ein verbindlicher Server-Hook. Ein Frontend-Event allein wäre zu spät, weil `tool_execution_start` im Agent-Core bereits vor dem Hook emittiert werden kann. Der neue Approval-Flow muss daher im Hook entschieden und nur zusätzlich per Event visualisiert werden.

## 4. Fachliches Modell

### 4.1 Stabile Permission-Targets

Eine Permission referenziert keinen sichtbaren Label-Text, sondern eine stabile, versionierte Target-ID.

| Tool-Art | Target-ID | Beispiel |
|---|---|---|
| Native Tool | `tool:{toolName}` | `tool:write`, `tool:web_search` |
| Progressive Gateway-Operation | `tool:{operationName}` | `tool:browser_click` |
| Direkte MCP-Operation | `mcp:{server}/{tool}` | `mcp:figma/create_design` |
| MCP-Proxy: Discovery | `tool:mcp` | `list_tools`, `describe_tool` |
| MCP-Proxy: Remote Call | `mcp:{server}/{tool}` | `mcp:canva/generate_design` |

Die Originalnamen von MCP-Server und Tool werden normalisiert, aber nicht nur aus dem bereits sanitisierten direkten Toolnamen rekonstruiert. Die gespeicherte Target-ID muss eindeutig und stabil bleiben, auch wenn zwei fremde Namen auf denselben JavaScript-sicheren Namen abgebildet werden könnten.

V1 unterstützt keine Wildcards wie `mcp:figma/*`. Sie sind erst nach einem separaten Sicherheits- und UX-Review sinnvoll. Gruppenaktionen im UI erzeugen stattdessen mehrere explizite Regeln.

### 4.2 Persistiertes Datenmodell

```ts
type ToolPermissionMode = 'always_allow' | 'needs_approval' | 'blocked';

type ToolPermissionRule = {
  targetId: string;
  mode: ToolPermissionMode;
  updatedAt: string;
};

type ToolPermissionConfig = {
  version: 1;
  rules: ToolPermissionRule[];
};
```

Die Konfiguration wird parallel zu `enabledTools` gespeichert:

- beim Hauptagenten in der Provider-Konfiguration von `pi-runtime-config.json`,
- bei benutzerdefinierten Agenten im Agent-Profil als JSON-Spalte,
- mit derselben Vererbungssemantik wie die aktuelle Tool-Override-Einstellung.

`null` beim Agenten bedeutet „vom Hauptagenten erben“. Eine leere Regelmenge bedeutet „keine expliziten Ausnahmen; Standards anwenden“ und ist nicht mit `null` gleichzusetzen.

Die Runtime löst daraus einen vollständigen, immutable Snapshot auf:

```ts
type EffectiveToolPermission = {
  targetId: string;
  mode: ToolPermissionMode;
  source: 'agent' | 'main-agent' | 'default';
  configRevision: string;
};
```

### 4.3 Präzedenz

Für eine Tool-Target-ID gilt diese Reihenfolge:

1. Tool ist nicht aktiviert oder durch eine Workspace-/Rollenpolicy ausgeschlossen → nicht verfügbar.
2. Explizite Agent-Regel → gilt.
3. Geerbte Hauptagent-Regel → gilt.
4. Klassifizierter Produkt-Default → gilt.
5. Unbekanntes externes Tool → `needs_approval`.

Eine `blocked`-Regel wird nicht durch eine allgemeinere Gruppenaktion oder einen Default aufgehoben. Nur eine explizite Änderung derselben oder einer höher priorisierten Agent-Regel kann sie ändern.

## 5. Approval-Lebenszyklus

### 5.1 Serverzustand

Ein Pending Approval wird in der laufenden Runtime geführt und ist an genau einen Tool-Call gebunden:

```ts
type PendingToolApproval = {
  approvalId: string;
  sessionId: string;
  userId: string;
  agentId: string;
  toolCallId: string;
  targetId: string;
  toolName: string;
  argsHash: string;
  displaySummary: string;
  permissionRevision: string;
  createdAt: string;
  expiresAt: string;
};
```

`argsHash` wird über die bereits validierten Argumente berechnet. Das verhindert, dass eine Freigabe später für abweichende Parameter wiederverwendet werden kann. Die UI erhält nur eine redigierte Zusammenfassung; Tokens, Geheimnisse, Mail-Inhalte und grosse Payloads dürfen nicht vollständig in das Event oder Audit gelangen.

V1 kann Pending Approvals im Speicher der Live-Runtime halten. Bei Server-Restart, Session-Dispose, Agent-Abbruch oder Timeout werden offene Resolver sicher abgelehnt. Eine persistente, restartfähige Approval-Queue ist ausdrücklich nicht Teil von V1.

### 5.2 Ablauf

```text
Modell erzeugt Tool-Call
  → Argumente werden serverseitig validiert
  → beforeToolCall löst die effektive Permission auf
  → needs_approval:
       Pending Approval anlegen
       permission_request an Session senden
       Runtime wartet höchstens N Minuten
  → Nutzer antwortet approve oder deny
  → Server prüft Owner, Session, Agent, Tool, Argument-Hash und Revision erneut
  → approve: Tool wird einmal ausgeführt
  → deny/timeout/revoke/abort: Tool wird nicht ausgeführt
```

Der Runtime-Status erhält zusätzlich `phase: 'waiting_for_approval'` und eine Liste minimaler `pendingApprovals`. Damit mehrere Browser-Tabs denselben, serverautoritativen Zustand sehen und kein Client das Ergebnis erfinden kann.

### 5.3 Nutzeraktionen in der Chat-UI

Die Approval-Karte zeigt Tool, Ziel, verständliche Parameterzusammenfassung und die Herkunft der Regel. V1 bietet:

- **Einmal erlauben**
- **Ablehnen**
- **Zur Tool-Konfiguration**

Eine dauerhafte Änderung („für diesen Agenten immer erlauben“ oder „blockieren“) bleibt zunächst in der Einstellungen-Seite. Das verhindert, dass ein zufälliger Klick während einer laufenden Sitzung unbemerkt die langfristige Agent-Policy erweitert. Eine spätere Version kann diese Aktionen nach einem zusätzlichen Bestätigungsdialog ergänzen.

## 6. UI-Konzept

### 6.1 Tool-Konfiguration

Die bestehende Toolliste erhält je Tool eine Dreifach-Auswahl mit Tooltip und Tastatur-/Screenreader-Labels:

```text
[✓ Always allow]  [✋ Needs approval]  [⊘ Blocked]
```

- Der aktuelle Enable-Switch bleibt erhalten, weil „nicht verfügbar“ und „blocked“ unterschiedliche Zustände sind.
- Ein deaktiviertes Tool zeigt seine konfigurierten Permissions weiter an, kann aber nicht ausgeführt werden.
- Nicht verfügbare Tools lassen sich nicht aktivieren; ihre Permission kann für eine spätere Verfügbarkeit vorbereitet werden.
- Gruppen zeigen einen aggregierten Status: einheitlicher Modus oder `Custom`.
- Gruppen-, Such- und Mehrfachfilter verwenden die bereits sichtbare Ergebnismenge. Eine Sammelaktion ändert nur diese Targets.
- Im Agent-Override bleibt ein klarer „Von Hauptagent erben“-Zustand bestehen; die drei Permission-Modi ersetzen diesen Vererbungszustand nicht.

### 6.2 Gruppierung

V1 gruppiert ausschließlich nach der vorhandenen Toolgruppe, etwa `Core`, `Browser`, `Composio`, `MCP`, `Email` und `Studio`. Die Detailansicht zeigt darüber hinaus:

- Risikohinweis aus der Tool-Metadatenquelle,
- ob der Modus geerbt oder explizit ist,
- bei MCP Server und Remote-Tool,
- einen Hinweis, dass zusätzliche Workspace- und Tool-spezifische Prüfungen weiter gelten.

## 7. MCP-Erweiterung

### 7.1 Direkte MCP-Tools (Phase 2A)

`buildDirectMcpTools` erstellt heute einzelne Toolobjekte. Beim Aufbau wird die unverkürzte Herkunft ergänzt, beispielsweise als interne Metadaten `permissionTargetId: 'mcp:server/tool'`. Der allgemeine Permission-Wrapper behandelt sie danach wie native Tools.

### 7.2 MCP-Proxy (Phase 2B)

Der Proxy bleibt selbst ein Tool, erhält aber für `action: 'call_tool'` eine feinere Zielauflösung:

- `list_servers`, `status`, `list_tools`, `search_tools`, `describe_tool`, OAuth-Status: prüfen `tool:mcp`.
- `call_tool`: Server und Remote-Tool zuerst aus den validierten Argumenten auflösen, dann `mcp:{server}/{tool}` prüfen.
- Falls Server oder Tool nicht eindeutig auflösbar sind, wird der Call abgewiesen; es gibt keine Freigabe eines unbestimmten MCP-Aufrufs.

Eine MCP-Server-Verbindung, OAuth-Freigabe oder die bestehende `directTools`-Auswahl bedeutet damit nicht automatisch, dass jede Remote-Operation ausgeführt werden darf.

### 7.3 Spätere Erweiterungen

Nicht Bestandteil des initialen Plans:

- Wildcards und Regelbereiche (`mcp:figma/*`),
- parameterbasierte Allowlisten, zum Beispiel „nur diese Domain“ oder „nur read-only Operationen“,
- Team- oder Organisations-Policy oberhalb des Agentenprofils,
- persistente Approval-Queues für Automationen,
- Approval über Telegram, E-Mail oder externe MCP-Clients.

Diese Erweiterungen dürfen erst auf dem stabilen Target-ID-, Audit- und Runtime-Modell aufsetzen.

## 8. Sicherheits- und Betriebsinvarianten

1. Jede Entscheidung wird serverseitig unmittelbar vor der Ausführung getroffen.
2. Ein Client darf nur über eine eigene, aktive Session entscheiden und nie eine fremde Approval-ID verwenden.
3. Eine Freigabe ist einmalig, parametergebunden, zeitlich begrenzt und nicht übertragbar.
4. Ein Abbruch, Timeout, Rechteentzug oder Runtime-Dispose führt zu „nicht ausführen“.
5. Konfigurationsänderungen werden vor dem Ausführen erneut revalidiert. Ein Approval gegen eine alte Permission-Revision wird abgelehnt.
6. `blocked` bleibt Schutz gegen Tools, die noch in einer alten Runtime oder einem gecachten Toolset sichtbar sind.
7. Jede Anfrage, Entscheidung, Ablehnung, Timeout und tatsächliche Ausführung wird mit Policy-Herkunft auditiert. Keine Rohsecrets oder unredigierten sensiblen Argumente speichern.
8. Workspace-ACL, Secret-Revocation, Browser-/E-Mail-/Datei-Policy und Final-Commit-Prüfungen bleiben unabhängig davon wirksam.

## 9. Umsetzungsreihenfolge

Die Tasks sind bewusst sequenziell. Ein Task beginnt erst, wenn sein Vorgänger mit den angegebenen Abnahmekriterien abgeschlossen ist.

### TP-01 – Vertrags- und Default-Katalog festlegen

**Ziel:** Alle V1-Tooltargets und Produkt-Defaults vor Datenbank- oder UI-Arbeit verbindlich machen.

- Target-ID-Builder für native, progressive und direkte MCP-Tools spezifizieren.
- V1-Toolkatalog mit Risikoklasse und Standardmodus erstellen.
- Entscheiden und dokumentieren, welche Quellen in V1 interaktiv approven dürfen.
- Redaktionsregeln für Tool-Argumente und Audit-Metadaten festlegen.

**Abnahme:** Testfälle und dokumentierte Beispiele decken mindestens native File-, Shell-, Browser-, Web-, Studio-, Composio- und MCP-Tools ab. Kein Target ist nur über sein UI-Label identifiziert.

### TP-02 – Permission-Domänenmodell und Resolver implementieren

**Ziel:** Eine reine, testbare Serverbibliothek löst die effektive Permission deterministisch auf.

- `ToolPermissionMode`, Regel- und Effective-Policy-Typen anlegen.
- Normalisierung, Duplikatbehandlung und Versionsvalidierung implementieren.
- Präzedenz Agent → Hauptagent → Default → unbekannter externer Target testen.
- Helper für Target-ID und sichere Argumentzusammenfassung anlegen.

**Abnahme:** Unit-Tests decken Default, Vererbung, explizites Blockieren, unbekannte MCP-Tools und ungültige Eingaben ab. Die Bibliothek hat keine UI- oder Datenbankabhängigkeit.

### TP-03 – Persistenz, Migration und effektive Agent-Konfiguration

**Ziel:** Policies sind pro Agent speicherbar, vererbbar und rückwärtskompatibel.

- Provider-Konfigurationsschema und Agent-Profile um Permission-JSON erweitern.
- SQLite- und Postgres-Migration, Normalisierung und Revisionierung ergänzen.
- `resolveAgentRuntimeSettings` um die effektive Permission-Konfiguration erweitern.
- Bestehende Daten als implizites `always_allow` migrieren, ohne Konfigurationsverlust.
- Konfigurations-GET/PATCH validieren und Audit-Ereignisse ergänzen.

**Abnahme:** Migration funktioniert für Hauptagent, Agent mit Override und vererbenden Agent. Eine alte Konfiguration erzeugt keine unerwartete Approval-Pause. Unbekannte Targets und fremde Agent-IDs werden abgewiesen.

### TP-04 – Tool-Metadaten und Settings-API erweitern

**Ziel:** UI und API erhalten alle Informationen für Tool- und Gruppenanzeigen.

- Toolmetadata um `permissionTargetId`, Risiko-/Default-Hinweis und effektiven Modus erweitern.
- API liefert Konfiguration, Vererbungsquelle und Target-Metadaten.
- Direkte MCP-Tools geben Server- und Original-Toolname als sichere Metadaten weiter.
- Bestehende Enable/Disable-Filterlogik unverändert kompatibel halten.

**Abnahme:** API-Tests beweisen, dass Toolverfügbarkeit und Permission getrennt sind; progressive Operationen und direkte MCP-Tools haben eindeutige Targets.

### TP-05 – Permission-Einstellungen für native Tools

**Ziel:** Toolgruppe und Einzeltool lassen sich wie im Ziel-UX konfigurieren.

- Dreifach-Auswahl pro Tool mit vollständiger Tastatur- und Screenreader-Unterstützung implementieren.
- Aggregierten Gruppenstatus und `Custom`-Darstellung implementieren.
- Bestehende Filter-, Suche- und Gruppen-Sammelaktionen für den sichtbaren Bereich verwenden.
- Vererbungszustand in Hauptagent, Agent erstellen und Agent bearbeiten eindeutig darstellen.
- Übersetzungen, leere Zustände und Fehlermeldungen ergänzen.

**Abnahme:** Ein Nutzer kann eine gefilterte Teilmenge auf jeden der drei Modi setzen; nicht sichtbare Tools bleiben unverändert. Einzeltool, Gruppe und geerbter Agent zeigen jeweils den korrekten Status.

### TP-06 – Serverseitigen Permission-Wrapper bauen

**Ziel:** Jede Toolausführung wird unabhängig von der UI gesichert.

- Einen generischen Wrapper für `AgentTool.execute` bzw. einen zentralen Policy-Resolver implementieren.
- `always_allow` durchlassen; `blocked` vor Ausführung mit sauberem Tool-Result ablehnen.
- Den Effektive-Policy-Snapshot an die Live-Runtime anbinden und vor Ausführung auf aktuelle Revision prüfen.
- Bestehende Workspace-/Execution-Context-Wrapper in der richtigen Reihenfolge erhalten.

**Abnahme:** Integrationstests zeigen, dass ein blockiertes Tool weder bei normaler Toolliste noch aus einem alten Runtime-Snapshot ausgeführt wird. Bestehende Workspace-Policy bleibt unverändert durchgesetzt.

### TP-07 – Interaktiven Approval-Broker und Runtime-Zustand implementieren

**Ziel:** `needs_approval` pausiert sicher und ist steuerbar.

- Pending-Approval-Registry mit Timeout, Abort-Signal und Dispose-Cleanup implementieren.
- `beforeToolCall` an den Agenten beim Erzeugen der Live-Runtime anschliessen.
- Runtime-Status um `waiting_for_approval` und minimierte Pending-Daten erweitern.
- Neue Runtime-Events `tool_permission_request` und `tool_permission_resolved` definieren und über den bestehenden Event-Emitter ausliefern.
- Revalidierung von Session, User, Agent, Target, Argument-Hash und Permission-Revision vor `approve` implementieren.

**Abnahme:** Approve führt genau einen Call aus; Deny, Timeout, Abort, Browser-Tab-Wechsel und Konfigurationsänderung führen nie zur Ausführung. Mehrere Tabs sehen denselben Pending-Status.

### TP-08 – Approval-API und Chat-Karte implementieren

**Ziel:** Berechtigte Nutzer können einen Pending Call verstehen und entscheiden.

- Session-gebundene Approve-/Deny-Route oder Runtime-Control-Aktion implementieren.
- Zugriffsprüfung, Idempotenz und sinnvolle Konfliktantworten implementieren.
- Chat-Event-Typen und Client-State erweitern.
- Approval-Karte mit redigierter Zusammenfassung, Einmal erlauben, Ablehnen und Link zu den Einstellungen implementieren.
- Pending- und Abschlusszustände im Tool-Message-Verlauf darstellen.

**Abnahme:** Nur der Sitzungsinhaber mit aktuellem Zugriff kann entscheiden. Doppelklick, parallele Tabs und verspätete Antworten sind idempotent und führen zu höchstens einer Ausführung.

### TP-09 – Audit, Observability und nicht-interaktive Runs absichern

**Ziel:** Die Funktion ist nachvollziehbar und in nicht-interaktiven Kontexten fail-closed.

- Audit-Ereignisse für Anfrage, Entscheidung, Timeout, Block und Ausführung hinzufügen.
- Metriken/strukturierte Logs für Pending-Anzahl, Timeout, Deny und Policy-Quelle ergänzen.
- Automationen, Delegationen, E-Mail/Channels und Mobile/API explizit als nicht-interaktiv kennzeichnen.
- Für `needs_approval` in diesen Quellen einen erklärenden, nicht sensitiven Tool-Fehler liefern.

**Abnahme:** Kein nicht-interaktiver Run kann auf eine Nutzerentscheidung warten oder eine Freigabe umgehen. Audit enthält keine Secrets und kann einen Tool-Call seiner Entscheidung zuordnen.

### TP-10 – Direkte MCP-Tools integrieren

**Ziel:** Ausgewählte direkte MCP-Operationen verwenden dieselbe Policy ohne Sonderweg.

- Permission-Target beim Aufbau direkter MCP-Tools erzeugen und in Metadaten übernehmen.
- Tool-Konfiguration um MCP-Server und Operation zeigen erweitern.
- Beim Ausführen dieselben Block-/Approval-Regeln und Audit-Attribute anwenden.
- Verbindungs-, OAuth- und bestehende `directTools`-Checks unverändert beibehalten.

**Abnahme:** Zwei Tools desselben MCP-Servers können unterschiedliche Modi haben. Eine Serververbindung allein erlaubt keine blockierte Operation.

### TP-11 – MCP-Proxy fein granular integrieren

**Ziel:** Dynamische `mcp.call_tool`-Calls prüfen die konkrete entfernte Operation.

- Für Proxy-Discovery eine eigene native `tool:mcp`-Rule verwenden.
- Vor `call_tool` Server und Tool aus validierten Parametern eindeutig auflösen.
- Den Remote-Target-ID-Resolver und denselben Approval-Broker einsetzen.
- Unvollständige oder nicht eindeutig auflösbare Calls fail-closed behandeln.

**Abnahme:** `mcp.call_tool` kann nicht über eine allgemeine Proxy-Freigabe eine blockierte Remote-Operation ausführen. Toolwechsel nach Approval, manipulierter Servername und abweichende Argumente werden abgelehnt.

### TP-12 – Vollständige Regression und Release-Gate

**Ziel:** Das Permission-Modell ist vor dem Rollout belastbar.

- Unit-, API-, Runtime-, MCP- und Migrationssuite ausführen.
- Bestehende Agent-Tool-, Workspace-, Automation-, Delegation-, Browser- und MCP-Tests regressionsprüfen.
- Nach ausdrücklicher Freigabe UI-/End-to-End-Prüfung mit Playwright oder Chrome DevTools für die Tool-Konfiguration und den Approval-Flow ausführen.
- `npm run lint` und `npm run build` ausführen; vor einem etwaigen Container-Build ist ein erfolgreicher Build Pflicht.
- Feature hinter einem gezielt aktivierbaren Rollout-Flag bereitstellen; zunächst nur für Administratoren aktivieren.

**Abnahme:** Alle Gate-Tests grün, keine offene Security- oder Audit-Lücke, Approval funktioniert in mehreren Tabs und MCP-Policies sind für direkte sowie Proxy-Calls geprüft.

## 10. Testmatrix

| Fall | Erwartung |
|---|---|
| Aktiviert + always allow | Tool läuft; Audit zeigt `always_allow`. |
| Aktiviert + needs approval + Approve | genau eine Ausführung mit identischem Argument-Hash. |
| Aktiviert + needs approval + Deny | keine Ausführung; Modell erhält Tool-Fehler. |
| Aktiviert + needs approval + Timeout/Abort | keine Ausführung; Pending-State wird bereinigt. |
| Aktiviert + blocked | Tool wird nicht angeboten und ein staler Aufruf wird blockiert. |
| Deaktiviert + always allow | Tool läuft nicht; Enable-Policy bleibt führend. |
| Regel während Pending geändert | alte Freigabe wird abgelehnt. |
| Benutzer verliert Session-/Workspace-Zugriff | Entscheidung und Ausführung werden abgelehnt. |
| Automation trifft needs approval | fail-closed, keine wartende Runtime. |
| Direkte MCP-Tools eines Servers | pro Operation unterschiedliche Modi möglich. |
| MCP-Proxy `call_tool` | Remote-Server und -Tool werden gezielt geprüft. |
| Proxy-Discovery | nur die allgemeine `tool:mcp`-Regel ist relevant. |

## 11. Offene Produktentscheidungen vor TP-01

1. Soll der Standard für **neue native Schreibtools** generell `needs_approval` sein oder nur für eine initial festgelegte Liste?
2. Dürfen Organisation-Administratoren später eine nicht überschreibbare, organisationsweite Block-Policy setzen? Dies ist nicht Teil der ersten Version.
3. Soll ein Nutzer aus der Approval-Karte dauerhaft „immer erlauben“ beziehungsweise „blockieren“ dürfen, oder bleibt das dauerhaft ausschließlich in den Einstellungen?
4. Welche externen Clients dürfen nach V1 einen eigenen Approval-Flow erhalten: Mobile App, Telegram, E-Mail, API oder MCP-Clients?
5. Sollen zukünftig parameterbezogene Regeln unterstützt werden? Diese dürfen nicht als Teil des V1-Datenmodells vorweggenommen werden.

## 12. Referenzen

- `docs/architecture/canvas-notebook/team-workspace/10-agent-tool-execution-policy.md`
- `docs/architecture/canvas-notebook/mcp-server/plan.md`
- `app/lib/pi/tool-registry.ts`
- `app/lib/pi/live-runtime.ts`
- `app/lib/mcp/direct-tools.ts`
- `app/lib/mcp/proxy-tool.ts`
