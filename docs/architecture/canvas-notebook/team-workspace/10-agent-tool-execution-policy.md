# Agent Tool Execution Policy

Stand: 2026-06-17

## Zweck

Dieses Dokument konkretisiert, wie Canvas Notebook jeden Agent-Turn und jeden Tool-Call serverseitig begrenzt. Es verbindet Workspace-Kontext, Filesystem, Secrets, MCP, Skills/Plugins, Mail, Shell, Gateway-Nachrichten und laufende Sessions zu einem einheitlichen Capability-Modell.

Es ergaenzt die Aufgaben `16`, `17`, `18`, `19`, `21`, `29`, `31` und `33` im Aufgabenindex.

## Grundentscheidung

Ein Agent darf nie direkt aus UI-State, Prompt-Text oder Tool-Parametern ableiten, was erlaubt ist. Vor jedem Agent-Turn erzeugt der Server einen `AgentExecutionContext`. Tools erhalten nur diesen Context und validierte Parameter.

Der Prompt darf den Agenten orientieren. Sicherheit entsteht aber ausschliesslich durch Server-Resolver, Permissions und Capability-Pruefungen.

## AgentExecutionContext

Empfohlenes Modell:

```ts
type AgentExecutionContext = {
  id: string;
  organizationId: string;
  userId: string;
  workspaceId: string;
  workspaceType: "personal" | "team" | "project";
  sessionId: string;
  agentId: string;
  source: "web" | "gateway" | "automation" | "system";
  gateway?: {
    type: "telegram" | "email" | "web" | "api";
    channelId: string;
    channelUserId: string;
  };
  writeWorkspaceId: string;
  readGrants: Array<{
    workspaceId: string;
    kind: "file" | "folder";
    path: string;
    recursive: boolean;
    grantedBy: "user-selection" | "session-context" | "automation-config";
  }>;
  allowedToolIds: string[];
  allowedMcpServerIds: string[];
  allowedSecretRefs: string[];
  toolStackRevision: string;
  runtimeConfigRevision: string;
  expiresAt: string;
};
```

Regeln:

- Der Context wird serverseitig erzeugt und darf nicht vom Client geliefert werden.
- Der Context wird aus gespeicherter Session, User, Organization, Workspace, Permissions und Tool-Stack-Revision berechnet.
- Bei Konflikt zwischen Client-UI-State und gespeicherter Session gewinnt die gespeicherte Session.
- Jeder Tool-Call referenziert `AgentExecutionContext.id`.
- Jeder Tool-Call prueft kurz vor Ausfuehrung erneut, ob User, Workspace, Permission, Secret und Tool noch erlaubt sind.
- Der Context enthaelt Secret-Refs, aber niemals Secret-Werte.

## Workspace Read/Write Policy

### Writes

Schreiben ist nur im `writeWorkspaceId` erlaubt. Dieser Wert ist immer der gespeicherte Workspace der Agent-Session.

Nicht erlaubt:

- Schreiben in einen anderen Workspace,
- Schreiben in den Team Workspace aus einer Personal-Session,
- Schreiben in den Personal Workspace aus einer Team-Session,
- Schreiben in fremde Personal Workspaces,
- automatischer Retry in einem anderen Workspace.

### Cross-Workspace Reads

Cross-Workspace-Reads sind erlaubt, wenn sie explizit als `readGrants` vorliegen.

Erlaubt:

- Personal-Session liest mehrere explizit ausgewaehlte Team-Dateien.
- Personal-Session liest einen explizit ausgewaehlten Team-Ordner, wenn der User Team-Leserechte hat.
- Team-Session liest mehrere explizit ausgewaehlte Dateien aus dem eigenen Personal Workspace.
- Team-Session liest einen explizit ausgewaehlten Personal-Ordner des ausloesenden Users.

Nicht erlaubt:

- fremde Personal Workspaces lesen,
- einen anderen Workspace breit durchsuchen, indexieren oder automatisch rekursiv crawlen,
- Cross-Workspace-Reads aus Prompt-Text allein ableiten,
- Cross-Workspace-Reads ueber Shell erzwingen.

Ordner-Grants:

- Ein Folder-Grant muss serverseitig auf einen Workspace-Root validiert werden.
- Fuer grosse Ordner braucht es spaeter Limits fuer Datei-Anzahl, Gesamtgroesse und Rekursionstiefe.
- Wenn ein Ordner-Limit ueberschritten wird, muss der Tool-Call stoppen und eine UI-/Agent-Meldung zur gezielteren Auswahl ausgeben.

## Shell und Terminal

Shell-/Terminal-Ausfuehrung ist V1-strikter als File-Read-Tools.

Regeln:

- Shell-CWD liegt im Session-Workspace.
- Shell darf keine Cross-Workspace-ReadGrants nutzen.
- Absolute Pfade ausserhalb erlaubter Runtime- und Session-Workspace-Pfade werden blockiert.
- Shell bekommt keine ungefilterte Secret-Env.
- Shell bekommt nur explizit erlaubte Env-Werte fuer den konkreten Tool-Call.
- Shell-Ausgaben werden als untrusted behandelt und duerfen keine neuen Permissions erzeugen.

Begruendung: Shell-Kommandos sind schwer granular zu begrenzen. Fuer Cross-Workspace-Reads werden dedizierte File-Tools genutzt, nicht Shell.

## Tool-Klassen

| Tool-Klasse | Read | Write | Secret-Zugriff | Besondere Regeln |
|---|---|---|---|---|
| File Read | Session Workspace plus `readGrants` | nein | nein | mehrere explizite Dateien/Ordner erlaubt |
| File Write/Edit/Delete | nur Session Workspace | nur Session Workspace | nein | vor Commit Workspace und Revision pruefen |
| Shell/Terminal | nur Session Workspace | nur Session Workspace | nur Allowlist | keine Cross-Workspace-Reads |
| MCP | tool-spezifisch | tool-spezifisch | User/Org Secret-Refs | Connection ist user-scoped; jeder Call revalidiert |
| E-Mail | eigene User-Mailbox oder erlaubte Team-Mailbox | senden nur erlaubter Account | Mail Secret-Refs | AccountId anderer User gilt als nicht vorhanden |
| Studio | erlaubte Source Assets | Ziel nur erlaubter Workspace/Asset-Scope | Provider Secret-Refs | Save-to-Workspace braucht `targetWorkspaceId` |
| Public Links | erlaubter Workspace | Link nur mit Permission | nein | Team Workspace braucht Public-Link-Permission |
| Search/Retrieval | erlaubte Knowledge Stores | nein | nein | keine fremden Personal Workspaces; ACL-Filter vor Rueckgabe |
| Automation Runner | siehe Automation-Scope | siehe gespeicherter Job-Workspace | Owner/Org nach Policy | separates Automations-Modell erforderlich |

## Revocation und laufende Runs

Workspace-Wechsel:

- Laufende Runs bleiben im alten gespeicherten Session-Workspace.
- Neue Chats nutzen den neuen global aktiven Workspace.
- Kein laufender Run wird stillschweigend in den neuen Workspace migriert.

Permission-Entzug:

- Ein bereits gestarteter einzelner Tool-Call darf fertig werden, wenn er nicht vor dem finalen Commit erneut pruefen muss.
- Jeder neue Tool-Call muss Permission neu pruefen und bei Entzug blockieren.
- Riskante Write-/Send-/Delete-Tools pruefen direkt vor dem finalen Commit erneut.

Secret-Rotation oder Secret-Revocation:

- Neue Tool-Calls resolven Secrets neu.
- Revoked Secrets blockieren neue Calls sofort.
- Ein bereits laufender externer Provider-Call wird nicht mit neuen Secrets fortgesetzt.

User-Deaktivierung/Offboarding:

- Neue Agent-Turns, Tool-Calls, MCP-Calls und Mail-Calls des Users werden blockiert.
- Queued Jobs und Automations des Users werden pausiert, bis der Offboarding-Flow sie transferiert, loescht oder reaktiviert.

Tool-Stack-/Runtime-Aenderung:

- Ein laufender Turn nutzt die beim Start gepinnte `toolStackRevision` und `runtimeConfigRevision`.
- Der naechste Turn nutzt die neue Revision.
- Wenn eine neue Policy eine laufende riskante Aktion verbietet, muss der finale Commit-Check blockieren.

## MCP

MCP-Verbindungen sind pro User persistent, aber nicht blind vertrauenswuerdig.

Regeln:

- Connection Key enthaelt `organizationId`, `userId`, `serverName` und `configHash`.
- MCP-Server-Konfig stammt aus User-Scope oder erlaubtem Organization-Template.
- OAuth Tokens, Cache und Logs sind user-scoped.
- Jeder MCP-Tool-Call prueft aktuellen `AgentExecutionContext`, Tool-Permission und Secret-Ref.
- Wenn ein Secret oder eine MCP-Permission revoked wird, bleiben bestehende Verbindungen nicht fuer neue Calls nutzbar.

## Gateway-Kontext

Gateway-Nachrichten, z. B. Telegram, duerfen nicht direkt in die Runtime gehen.

Pflichtschritte:

1. Externen Channel-User auf internen `userId` mappen.
2. Organization und erlaubten Default Workspace aufloesen.
3. Session finden oder neue Session mit Workspace erzeugen.
4. `AgentExecutionContext` erzeugen.
5. Tool-Calls nur mit diesem Context erlauben.

Wenn das Mapping nicht eindeutig ist, wird kein Agent-Turn gestartet.

## Automations

Automations folgen dem separaten Modell aus `11-automation-execution-model.md`.

Invarianten:

- Keine Automation darf ohne gespeicherten Execution Owner laufen.
- Personal Automations laufen im Auftrag eines konkreten `ownerUserId`.
- Organization Automations laufen ueber einen Organization Service Actor.
- Jede Automation hat genau einen primaeren `workspaceId`.
- Jeder Automation Run erzeugt einen eigenen `AgentExecutionContext` aus gespeicherter Job-Konfiguration und aktuellen Permissions.

## Prompt Injection und Parameter-Validierung

LLM-Ausgaben sind untrusted.

Pflichtregeln:

- Tool-Parameter werden mit Runtime-Schemas validiert.
- IDs, Pfade, AccountIds, SecretRefs und WorkspaceIds werden serverseitig autorisiert.
- Der LLM darf keine rohen SQL-Queries oder ungefilterten Shell-Kommandos aus User-Input in privilegierte Operationen umwandeln.
- Tool-Allowlist und Runtime-Config begrenzen die verfuegbaren Tools vor dem Modellaufruf.
- Wenn ein Tool blockiert wird, darf der Agent textlich erklaeren und Alternativen vorschlagen, aber nicht automatisch in einem anderen Workspace retryen.

## Audit

Jeder Tool-Call speichert kleine Metadaten:

- `executionContextId`
- `organizationId`
- `userId`
- `workspaceId`
- `sessionId`
- `agentId`
- `toolName`
- `toolClass`
- `status`
- `readGrantsUsed`
- `writeWorkspaceId`
- `secretRefs`
- `mcpServerId`
- `permissionDecision`
- `inputHash`
- `outputHash`
- `artifactRef`

Nicht speichern:

- Secret-Werte,
- OAuth Tokens,
- komplette grosse Tool-Payloads,
- komplette Datei-Inhalte,
- rohe Shell-Streams ohne Retention.

## Tests

Pflichttests:

- Personal-Session kann mehrere explizit ausgewaehlte Team-Dateien lesen.
- Personal-Session kann nicht in Team Workspace schreiben.
- Team-Session kann mehrere explizit ausgewaehlte eigene Personal-Dateien lesen.
- Team-Session kann nicht in Personal Workspace schreiben.
- Fremde Personal Workspaces sind fuer Read und Write blockiert.
- Shell kann keine Cross-Workspace-ReadGrants nutzen.
- Workspace-Wechsel laesst laufende Session im alten Workspace.
- Permission-Entzug blockiert neue Tool-Calls.
- Secret-Revocation blockiert neue Tool-Calls.
- MCP-Verbindungen mit gleichem Servernamen bleiben zwischen Usern getrennt.
- Gateway-Nachricht ohne eindeutiges User-Mapping startet keinen Agent-Turn.
- Blockierter Tool-Call fuehrt nicht zu automatischem Retry in anderem Workspace.
- Audit enthaelt ExecutionContext- und Secret-Refs, aber keine Secret-Werte.
