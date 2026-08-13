# Multi-Participant Conversations und Agent Collaboration

Stand: 2026-08-13

Status: Architekturentwurf zur gemeinsamen Produktabstimmung. Noch nicht implementiert.

## Zweck

Canvas Notebook soll Chat-Gespraeche langfristig nicht mehr als private Runtime-Session genau eines Users mit genau einem Agenten behandeln. Das Ziel ist ein Conversation-Modell, in dem mehrere echte Menschen und mehrere zentral verwaltete Agents als eindeutig erkennbare Teilnehmer schreiben koennen.

Das Modell muss von Beginn an folgende Produktfaelle tragen:

- privater Einzelchat zwischen einem Menschen und einem Agenten,
- Gruppenchat mit mehreren Menschen,
- Gruppenchat mit mehreren Menschen und mehreren Agents,
- gezielte Aktivierung eines Agents ueber `@AgentName`,
- sichtbare Agent-zu-Agent-Kommunikation,
- weiterhin getrennte, unsichtbare Subagent-Runs fuer reine Hintergrundarbeit,
- spaetere Anbindung externer Kanaele an dieselbe Conversation-Domaene.

Die zentrale Architekturentscheidung lautet:

> Eine sichtbare Conversation ist nicht dieselbe Entitaet wie die Runtime-Session eines Agents.

Eine Conversation verwaltet Teilnehmer, sichtbare Nachrichten, Mentions, Lesestatus und Zugriffsrechte. Eine Agent-Runtime verwaltet dagegen den Modellkontext und die Ausfuehrung genau eines Agents fuer einen konkreten Run.

## Ausgangsbefund

### Bereits vorhanden

- `agents` speichert Personal-, Organization- und System-Agenten mit zentraler Definition, Modell-Defaults, Tools und Capability-Bindings.
- `agent_grants` kann Organization-Agenten an Organisation, Rollen, Workspaces, Projekte oder einzelne User zuweisen.
- `agent_members` bildet direkte individuelle Nutzung, Bearbeitung und Verwaltung ab.
- `agent_user_preferences` trennt user-spezifische Preferences von einer zentralen Agent-Definition.
- Chat-History, Runtime-Status, Queue, WebSocket-Events, Usage, Audit und Workspace-Kontext sind bereits sessionbezogen vorhanden.
- `delegate_task` kann kurzlebige Worker oder einen bestehenden Managed Agent in einer separaten Agent-Session starten.
- Organization-Agenten koennen bereits als zentral gepflegte Ressource fuer Mitarbeiter und Workspaces bereitgestellt werden.

### Heutige Grenzen

`pi_sessions` verbindet derzeit in einem Datensatz mehrere fachlich unterschiedliche Konzepte:

- sichtbares Chat-Gespraech,
- Besitzer des Chats ueber `userId`,
- aktiver Agent ueber eine verpflichtende `agentId`,
- Modell-/Runtime-Snapshot,
- Workspace-Kontext,
- History und Read-State.

Die Auswirkungen sind:

- Eine Session gehoert genau einem User.
- Eine Session gehoert genau einem Agenten.
- Ein Agentwechsel startet einen neuen Chat.
- REST- und WebSocket-Zugriff pruefen Session-Besitz ueber den eingeloggten User.
- Ein anderer Mensch kann nicht als gleichwertiger Teilnehmer beitreten.
- Ein zweiter Agent kann nicht unter eigener Identitaet im selben sichtbaren Verlauf schreiben.
- `pi_messages` speichert nur Runtime-Rollen wie `user`, `assistant` und `toolResult`, aber keinen dauerhaften menschlichen oder Agent-Absender.
- Read-/Unread-State liegt an der Session statt pro Conversation-Mitglied.
- Die Runtime ist mit `sessionId + userId` adressiert und verwendet den User fuer Tool-, Secret- und Workspace-Scope.

Die bestehende Delegation ist davon fachlich verschieden:

- Ein Parent-Agent startet einen Worker oder Managed Agent in einer separaten Session.
- Das Ergebnis wird spaeter als speziell markierte `user`-Nachricht in den Parent-Kontext eingespeist.
- Der Worker erscheint nicht als normaler Teilnehmer mit eigener Nachricht im sichtbaren Parent-Gespraech.
- Der Flow ist auf Aufgabenuebergabe und Resultatrueckgabe ausgelegt, nicht auf einen gemeinsamen Gruppenchat.

## Zielbegriffe

### Conversation

Das fachliche, fuer Menschen sichtbare Gespraech. Es besitzt einen stabilen Workspace, Teilnehmer, Nachrichten, Routing-Regeln und einen Lifecycle.

### Participant

Ein Mensch oder ein Managed Agent mit definierten Rechten innerhalb einer Conversation.

### Message

Ein unveraenderlich attribuierter sichtbarer Beitrag eines Menschen, Agents oder Systems. Tool-Events und interne Modellnachrichten sind nicht automatisch sichtbare Conversation Messages.

### Agent Request

Die explizite Aufforderung, einen Agent-Teilnehmer als Reaktion auf eine Nachricht oder durch einen anderen Agenten auszufuehren.

### Agent Run

Eine konkrete, auditierbare Modellausfuehrung eines Agents. Der Run speichert den verantwortlichen menschlichen Execution Principal, Runtime-Snapshot, Status, Kausalkette und Usage.

### Runtime Thread

Der technische Modellkontext eines Agents. Bestehende `pi_sessions` koennen waehrend der Migration als interne Runtime Threads weiterverwendet werden, duerfen aber nicht die dauerhafte Conversation-Identitaet bleiben.

## Conversation-Arten

### Einzelchat (`direct`)

Der erste Produktumfang eines Einzelchats ist bewusst eng:

- genau ein menschlicher Owner,
- genau ein primaerer Agent,
- Nachrichten des Menschen aktivieren den primaeren Agent automatisch,
- ein Agent-Tag ist optional,
- vorhandene `pi_sessions` werden als Einzelchats migriert,
- weitere Teilnehmer werden nicht stillschweigend hinzugefuegt.

Ein Einzelchat bleibt der schnelle, private Standardflow wie der heutige Agent-Chat.

### Gruppenchat (`group`)

Ein Gruppenchat erlaubt:

- mehrere menschliche Teilnehmer,
- mehrere Agent-Teilnehmer,
- Rollen `owner`, `moderator`, `member` und `observer`,
- Mentions von Menschen fuer Benachrichtigungen,
- Mentions von Agents fuer explizite Aktivierung,
- Antworten auf konkrete Nachrichten,
- Read-State pro menschlichem Teilnehmer.

Verbindliche Routing-Regel:

> In einem Gruppenchat antwortet kein Agent auf eine normale unadressierte Nachricht. Ein Agent-Run startet nur durch eine gueltige Agent-Mention, einen expliziten Agent Request, eine bestaetigte UI-Aktion oder eine bewusst konfigurierte Automation.

Eine unadressierte Nachricht bleibt Teil des Verlaufs und steht einem Agent bei seinem naechsten gueltigen Run als Conversation-Kontext zur Verfuegung.

### Einzelchat in Gruppe ueberfuehren

Ein privater Einzelchat darf nicht durch das einfache Hinzufuegen eines Teilnehmers unbemerkt offengelegt werden.

Empfehlung:

- `Gruppe aus diesem Chat erstellen` erzeugt eine neue Conversation.
- Der Nutzer entscheidet explizit zwischen leerem Gruppenchat, uebernommener Zusammenfassung oder vollstaendig uebernommenem Verlauf.
- Die UI zeigt vor einer vollstaendigen Uebernahme, welche privaten Nachrichten und Attachments fuer neue Teilnehmer sichtbar werden.
- Eine Gruppen-Conversation wird nicht wieder in einen Einzelchat zurueckkonvertiert.

Die genaue Uebernahmeregel bleibt vor der Implementierung als Produktentscheidung zu bestaetigen.

## Ziel-Datenmodell

Die Feldlisten sind fachliche Vorschlaege. Namen und SQL-Details werden vor der Migration mit SQLite- und Postgres-Paritaet finalisiert.

### `conversations`

```ts
type Conversation = {
  id: string;
  organizationId: string;
  workspaceId: string;
  kind: "direct" | "group";
  responseMode: "primary_agent" | "mentions_only";
  primaryAgentId: string | null;
  title: string | null;
  status: "active" | "archived";
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
};
```

Regeln:

- Der Workspace ist nach Erstellung unveraenderlich.
- `direct` verwendet `primary_agent` und genau einen primaeren Agenten.
- `group` verwendet in V1 immer `mentions_only`.
- Organization und Workspace werden serverseitig aus dem Workspace Resolver gesetzt.

### `conversation_participants`

```ts
type ConversationParticipant = {
  conversationId: string;
  participantType: "user" | "agent";
  userId: string | null;
  agentId: string | null;
  role: "owner" | "moderator" | "member" | "observer";
  canRead: boolean;
  canPost: boolean;
  canManageParticipants: boolean;
  status: "active" | "removed";
  addedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};
```

Constraints:

- Genau eines von `userId` und `agentId` ist gesetzt.
- Ein aktiver Teilnehmer ist pro Conversation und Identitaet eindeutig.
- Agent-Teilnahme ersetzt keine `agent_grants`; beide Bedingungen muessen erfuellt sein.
- Ein User-Teilnehmer braucht weiterhin normalen Workspace-Zugriff.

### `conversation_messages`

```ts
type ConversationMessage = {
  id: string;
  conversationId: string;
  sequence: number;
  authorType: "user" | "agent" | "system";
  authorUserId: string | null;
  authorAgentId: string | null;
  initiatedByUserId: string | null;
  sourceRunId: string | null;
  replyToMessageId: string | null;
  contentJson: string;
  visibleType: "message" | "status" | "agent_request" | "agent_result";
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
};
```

Regeln:

- Der Absender wird serverseitig gesetzt und kann nicht aus LLM-Text oder Tool-Parametern uebernommen werden.
- Agent-Nachrichten speichern immer `authorAgentId`, `initiatedByUserId` und `sourceRunId`.
- Runtime-interne `toolResult`-Nachrichten bleiben im Runtime Thread und werden nur ueber eine explizite, sichere Projektion sichtbar.
- `sequence` wird pro Conversation atomar vergeben.
- Attachments referenzieren weiterhin autorisierte Workspace-Ressourcen und werden nicht nur als freie Pfade gespeichert.

### `conversation_mentions`

```ts
type ConversationMention = {
  messageId: string;
  targetType: "user" | "agent";
  targetUserId: string | null;
  targetAgentId: string | null;
  behavior: "notify" | "invoke";
};
```

Mentions werden ueber stabile IDs aus dem Composer beziehungsweise Tool-Call gespeichert. Eine reine Zeichenfolge wie `@Research Agent` im generierten Text ist kein vertrauenswuerdiger Trigger.

### `conversation_agent_requests`

```ts
type ConversationAgentRequest = {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  requestingUserId: string | null;
  requestingAgentId: string | null;
  targetAgentId: string;
  executionPrincipalUserId: string;
  chainId: string;
  parentRequestId: string | null;
  depth: number;
  onReply: "post_only" | "resume_requester";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
};
```

Ein Agent Request ist der dauerhafte, auditierbare Auftrag. Er ist nicht identisch mit einer Mention und nicht identisch mit dem daraus entstehenden Runtime Run.

### `agent_runs`

```ts
type AgentRun = {
  id: string;
  conversationId: string;
  requestId: string | null;
  agentId: string;
  initiatedByUserId: string;
  triggerType: "human_message" | "agent_request" | "automation" | "channel";
  runtimeThreadId: string | null;
  runtimeSnapshotJson: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};
```

Usage und Audit muessen langfristig `conversationId`, `agentRunId`, `agentId` und `initiatedByUserId` enthalten.

### `conversation_read_states`

```ts
type ConversationReadState = {
  conversationId: string;
  userId: string;
  lastReadSequence: number;
  lastReadAt: Date;
  mutedUntil: Date | null;
};
```

Unread ist damit pro Mensch korrekt und nicht mehr eine einzelne Eigenschaft der Session.

### `agent_employment_profiles`

Agents werden nicht zu Better-Auth-Usern und belegen keine menschlichen Login- oder Lizenz-Seats. Fuer die Produktdarstellung als Mitarbeiter wird eine getrennte Organization-Metadatenebene empfohlen:

```ts
type AgentEmploymentProfile = {
  agentId: string;
  organizationId: string;
  status: "draft" | "active" | "paused" | "offboarded";
  jobTitle: string | null;
  department: string | null;
  managerUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
```

`agent_grants` bleibt die Berechtigungsquelle. Jobtitel, Manager und Abteilung sind Organisationsmetadaten und duerfen nicht als Berechtigungsersatz verwendet werden.

## Antwort- und Mention-Routing

### Mensch in Einzelchat

1. User-Nachricht wird als `conversation_message` gespeichert.
2. Der primaere Agent wird serverseitig als Ziel aufgeloest.
3. Ein Agent Request und Agent Run werden erzeugt.
4. Die Antwort wird als Agent-Nachricht mit eindeutiger Attribution gespeichert.

### Mensch in Gruppenchat ohne Agent-Mention

1. Nachricht wird gespeichert und an berechtigte Clients verteilt.
2. Erwaehnte Menschen erhalten eine Benachrichtigung.
3. Es wird kein Agent Request erzeugt.

### Mensch in Gruppenchat mit `@Agent`

1. Composer liefert stabile Mention-IDs.
2. Server validiert Teilnehmer-, Agent- und Workspace-Zugriff.
3. Message, Mention und Agent Request werden atomar gespeichert.
4. Der Agent wird asynchron ausgefuehrt.
5. Seine Antwort erscheint unter eigener Agent-Identitaet.

### Mehrere Agent-Mentions

Das Datenmodell erlaubt mehrere Requests aus einer Nachricht. Fuer V1 wird empfohlen:

- maximal drei Agents pro menschlicher Nachricht,
- jeder Agent erhaelt einen getrennten Run,
- Runs duerfen parallel laufen, Antworten werden ueber Conversation-Sequenzen geordnet,
- die UI zeigt deutlich, welche Agents noch arbeiten,
- kein implizites `@all-agents`.

Ob V1 bereits mehrere parallele Mentions erlaubt oder zunaechst genau einen Agenten pro Nachricht akzeptiert, bleibt ein explizites Scope-Gate.

## Agent-zu-Agent-Tools

Agent-zu-Agent-Kommunikation wird nicht durch Textparsing freigeschaltet. Der ausfuehrende Agent braucht dafuer explizite Tools beziehungsweise Capabilities.

Empfohlene Tool-Gruppe: `Collaboration`.

### `list_conversation_participants`

Read-only und planning-safe.

Liefert nur Teilnehmer, die der aktuelle Agent im aktiven Conversation-/Workspace-Kontext sehen darf:

- stabile User-/Agent-ID,
- Anzeigename,
- Participant-Rolle,
- fuer Agents deren Aktivierungsstatus,
- ob der ausfuehrende User den Ziel-Agent verwenden darf.

### `post_conversation_message`

Schreibt eine sichtbare Nachricht unter der Identitaet des aktuellen Agents, startet aber keinen anderen Agenten.

```ts
type PostConversationMessageInput = {
  conversationId?: string;
  content: string;
  replyToMessageId?: string;
};
```

Ohne `conversationId` ist nur die aktuelle Conversation erlaubt. Das Schreiben in andere Conversations benoetigt eine staerkere separate Capability.

### `request_agent_response`

Schreibt eine gerichtete Agent-Nachricht und erzeugt atomar einen Request fuer den Ziel-Agenten.

```ts
type RequestAgentResponseInput = {
  conversationId?: string;
  targetAgentId: string;
  message: string;
  replyToMessageId?: string;
  onReply?: "post_only" | "resume_requester";
};
```

Semantik:

- `post_only`: Der Ziel-Agent antwortet sichtbar; der anfragende Agent wird nicht automatisch erneut gestartet.
- `resume_requester`: Nach der Zielantwort darf der anfragende Agent innerhalb desselben Chain-Budgets genau einmal fuer Synthese oder Fortsetzung reaktiviert werden.
- Das Tool liefert sofort einen persistenten Request-Handle und blockiert keinen langen Parent-Tool-Call.
- Status und Resultat werden ueber Conversation Events aktualisiert.

### Spaetere Cross-Conversation-Tools

Fuer V1 sollte Agent-zu-Agent-Kommunikation bevorzugt innerhalb derselben Conversation stattfinden. Das Datenmodell kann spaeter zusaetzlich tragen:

- `search_conversations`,
- `read_conversation`,
- `post_to_other_conversation`,
- `request_agent_in_other_conversation`.

Cross-Conversation-Zugriff benoetigt eine eigene Capability und prueft sowohl die Teilnahme des Agents als auch den Zugriff des menschlichen Execution Principals. Fremde Personal Conversations bleiben gesperrt.

## Tool-Capabilities pro KI-Mitarbeiter

Die Settings-UI soll mindestens folgende getrennte Freigaben anbieten:

- Darf im aktuellen Gespraech sichtbar schreiben.
- Darf andere Agent-Teilnehmer beauftragen.
- Darf in andere berechtigte Conversations schreiben.
- Darf mehrere Agents in einem Auftrag aktivieren.
- Darf nach einer Agent-Antwort automatisch fortfahren.

Diese Freigaben werden in das vorhandene Agent-Tool-/Capability-Modell integriert. Sie sind standardmaessig deaktiviert und fuer Spezial-Agenten bewusst zu aktivieren.

Teilnehmerverwaltung bleibt davon getrennt:

- Ein Agent mit Conversation-Tools darf sich nicht selbst zu einer Conversation hinzufuegen.
- `invite_agent`, `remove_participant` und Rollenveraenderungen bleiben menschlichen Ownern/Moderatoren oder einem eigenen hochprivilegierten Management-Gateway vorbehalten.

## Execution Principal, Secrets und Berechtigungen

Agents sind fachliche Akteure, aber keine authentifizierten menschlichen Principals. Jeder Agent Run braucht deshalb einen verantwortlichen Menschen oder einen expliziten Service Actor.

Verbindliche Regeln:

1. Ein menschlich ausgeloester Agent Run verwendet diesen User als `executionPrincipalUserId`.
2. Ruft Agent A Agent B auf, erbt B nicht die Identitaet oder vermeintliche Credentials von A. B laeuft weiterhin im Scope des verantwortlichen menschlichen Users.
3. Der Server prueft den Zugriff des Execution Principals auf Conversation, Workspace und Ziel-Agent.
4. Persoenliche Secrets, Connections, Browserprofile, Mailboxen und User Memory bleiben an den Execution Principal gebunden.
5. Organization-Agenten kopieren weiterhin keine privaten Secrets ihres Erstellers.
6. Ein Agent Request darf Berechtigungen nicht erweitern. Jede Kette ist auf die Schnittmenge der erlaubten Capabilities begrenzt.
7. Automations und Heartbeats benoetigen einen expliziten Service-Actor-Kontext und duerfen nicht still einen zufaelligen Conversation-User impersonieren.
8. Sichtbare Agent-Nachrichten tragen in UI und Audit eine duale Attribution wie `Marketing Agent, im Auftrag von Frank`.

Der bestehende `AgentExecutionContext` muss dafuer langfristig zwischen folgenden Identitaeten unterscheiden:

- Conversation Actor beziehungsweise sichtbarer Absender,
- Agent Actor,
- menschlicher oder technischer Execution Principal,
- Initiator des aktuellen Causal Chain,
- Workspace und Organization.

## Loop-, Kosten- und Missbrauchsschutz

Empfohlene Defaults:

- Agent-Nachrichten aktivieren andere Agents nie allein durch enthaltenen Mention-Text.
- Nur ein erfolgreicher `request_agent_response`-Call erzeugt einen Agent Request.
- Maximal zwei Agent-zu-Agent-Kanten pro menschlichem Ausgangsauftrag.
- Derselbe Agent darf innerhalb einer Chain nicht erneut aktiviert werden.
- Maximal drei gleichzeitig aktive Ziel-Agents pro Ausgangsnachricht.
- Kein `@all-agents` in V1.
- `resume_requester` verbraucht ebenfalls Chain-Budget.
- Jede Conversation besitzt eine Aktion `Agents pausieren`.
- User- und Organization-Limits fuer parallele Runs, Tokens und Kosten werden vor jedem Request geprueft.
- Blockierte, pausierte, geloeschte oder nicht mehr freigegebene Agents werden fail-closed nicht gestartet.
- Jede Kette speichert `chainId`, `parentRequestId`, `depth`, Agent-Pfad und Abbruchgrund.
- Ein idempotenter Request-Key verhindert doppelte Runs nach Retry oder WebSocket-Reconnect.

Beispiel:

```txt
Frank: @Marketing entwickle eine Kampagnenidee.

Marketing Agent:
Ich lasse zuerst die Zielgruppendaten pruefen.
-> request_agent_response(Research Agent, onReply="resume_requester")

Research Agent:
Die Zielgruppe reagiert besonders auf ...

Marketing Agent:
-> genau eine erlaubte Fortsetzung
Hier ist die daraus abgeleitete Kampagnenidee.
```

Ohne `resume_requester` endet die Kette nach der sichtbaren Antwort des Research Agents.

## Runtime- und Kontextmodell

Die sichtbare Conversation-History wird zur kanonischen Teilnehmer-History. Der Modellkontext eines Agents darf trotzdem agent- und principal-spezifisch bleiben.

Empfohlener Migrationspfad:

1. `pi_sessions` erhaelt additiv `conversationId` und bleibt zunaechst Runtime Thread.
2. Bestehende Runtime-History wird weiterhin fuer alte Sessions geladen.
3. Neue Conversation Messages werden kanonisch in `conversation_messages` gespeichert.
4. Vor einem Agent Run baut ein Context Projector einen begrenzten Modellkontext aus sichtbaren Conversation Messages, Agent-Definition, Workspace-Kontext und principal-spezifischen privaten Daten.
5. Private `USER.md`, persoenliche `MEMORY.md`, Secrets und Tool-Ergebnisse werden nicht ungeprueft in die fuer alle Teilnehmer sichtbare Conversation projiziert.
6. Nach stabiler Migration wird entschieden, ob `pi_messages` reine Runtime-History bleibt oder teilweise durch reproduzierbare Run-Projektionen ersetzt wird.

Ein langlebiger in-memory Runtime Thread darf nicht ungeprueft zwischen verschiedenen Execution Principals weiterverwendet werden. Fuer den ersten sicheren Umfang sind zwei Varianten zulaessig:

- Runtime pro `conversationId + agentId + executionPrincipalUserId`, oder
- pro Run neu projizierter Agent-Kontext mit klar getrenntem principal-spezifischem Tool-Layer.

Die konkrete Variante wird in einem Runtime-Spike festgelegt. Sicherheit und Secret-Isolation haben Vorrang vor maximaler Context-Wiederverwendung.

## WebSocket- und Event-Modell

WebSocket-Abonnements wechseln von Besitzpruefung auf Conversation-ACL:

- `subscribe_conversation`,
- `unsubscribe_conversation`,
- `conversation_message_created`,
- `conversation_message_updated`,
- `conversation_participant_changed`,
- `agent_request_updated`,
- `agent_run_status`,
- `conversation_read_state_updated`.

Broadcasts gehen nur an aktuell berechtigte menschliche Teilnehmer. Eine entfernte oder gesperrte Mitgliedschaft beendet bestehende Abonnements fail-closed.

Runtime-Streaming bleibt einem konkreten Agent Run zugeordnet. Die UI darf mehrere aktive Runs einer Gruppen-Conversation getrennt anzeigen.

## Mitarbeiterverwaltung

Agents werden in der Produktoberflaeche wie Mitarbeiter behandelt, technisch aber nicht als Better-Auth-User modelliert.

Empfohlener Settings-Bereich `Team` beziehungsweise `Mitarbeiter`:

- kombinierte Uebersicht,
- Tab `Menschen`,
- Tab `KI-Mitarbeiter`,
- optional Filter nach Team, Workspace, Status und Manager.

Menschenprofil:

- Rolle und Status,
- Workspaces und Projekte,
- zugewiesene Organization-Agenten,
- persoenliche Agents nur fuer den jeweiligen User sichtbar,
- Usage und relevante aktive Conversations.

KI-Mitarbeiterprofil:

- Name, Avatar, Jobtitel, Abteilung und menschlicher Manager,
- Status `draft`, `active`, `paused`, `offboarded`,
- Organization-/Workspace-/User-Grants,
- Modell, Skills, Plugins, Connections und Tools,
- Conversation-Capabilities,
- aktive Conversations und laufende Runs,
- Usage, Kosten, letzte Aktivitaet und Audit.

Scope-Regel:

- Personal-Agenten werden als private Assistenten dargestellt.
- Organization-Agenten koennen als KI-Mitarbeiter aktiviert und zentral gepflegt werden.
- Ein KI-Mitarbeiter belegt keinen menschlichen Login- oder Lizenz-Seat.

## Chat-UX

### Erstellung

- Aktion `Neuer Einzelchat` startet den schnellen bisherigen Flow.
- Aktion `Neue Gruppe` oeffnet Teilnehmerauswahl fuer Menschen und berechtigte Agents.
- Der aktive Workspace ist vor Erstellung sichtbar und danach unveraenderlich.

### Header

- Conversation-Titel und Typ anzeigen.
- Teilnehmer-Avatare fuer Menschen und Agents.
- Agent-Teilnehmer erhalten ein eindeutiges KI-Badge.
- Gruppenchat zeigt `Agents reagieren nur auf @Mention`.
- Aktion `Agents pausieren` fuer Owner und Moderatoren.

### Composer

- `@` oeffnet eine typisierte Teilnehmerauswahl.
- Menschen-Mention erzeugt `notify`.
- Agent-Mention erzeugt nach Servervalidierung `invoke`.
- Mehrere ausgewaehlte Agents zeigen vor dem Senden die Zahl erwarteter Runs.
- Ungueltige oder nicht mehr berechtigte Mentions werden vor dem Senden blockiert.

### Nachrichten

- Jede Nachricht zeigt den tatsaechlichen menschlichen oder Agent-Absender.
- Agent-Nachrichten zeigen optional `im Auftrag von <User>`.
- Antworten haben `replyToMessageId` statt nur kopierten Text.
- Laufende Agent Requests erscheinen als eigene, kompakte Aktivitaet.
- Fehler und Abbrueche werden dem betroffenen Request zugeordnet und nicht als anonyme Systemmeldung angehaengt.

### History

- History listet Conversations statt Agent-Sessions.
- Filter: Einzelchat, Gruppe, Agent, Teilnehmer, Workspace, ungelesen.
- Read-State und Benachrichtigungen sind pro User.
- Der bisherige Agent-Filter bleibt als Conversation-Teilnehmerfilter nutzbar.

## Migration bestehender Daten

Die Migration erfolgt additiv und rueckwaertskompatibel.

### Phase A: Schema und Backfill

Fuer jede bestehende `pi_session`:

1. Eine `direct` Conversation mit demselben Workspace und Titel anlegen.
2. Den bisherigen `userId` als Owner-Teilnehmer einfuegen.
3. Die bisherige `agentId` als primaeren Agent-Teilnehmer einfuegen.
4. `pi_sessions.conversationId` setzen.
5. Bestehende User-Nachrichten dem Session-Owner attribuieren.
6. Bestehende Assistant-Nachrichten dem Session-Agent attribuieren.
7. Tool Results nur intern migrieren und nicht ungeprueft als sichtbare Nachrichten ausgeben.
8. Bisherigen `lastViewedAt` in einen initialen Conversation Read State ueberfuehren.

### Phase B: Dual Read

- Neue APIs lesen bevorzugt Conversations.
- Nicht migrierte Legacy-Sessions bleiben ueber Adapter erreichbar.
- Bestehende Session-URLs werden auf die zugehoerige Conversation aufgeloest.
- Alte Clients duerfen waehrend eines begrenzten Fensters weiterarbeiten.

### Phase C: Conversation Write Path

- Neue sichtbare Nachrichten werden nur noch ueber den Conversation Service geschrieben.
- Runtime-Projektionen und `pi_messages` werden transaktional beziehungsweise idempotent aktualisiert.
- WebSocket-Events verwenden Conversation IDs.

### Phase D: Legacy Cleanup

- User-/Agent-Besitzannahmen aus REST, WebSocket, Runtime Store und UI entfernen.
- Alte Session-History-APIs erst nach vollstaendiger Daten- und Clientmigration entfernen.
- Legacy-Backfill und Rollback-Pfad bis mindestens eine stabile Release-Grenze beibehalten.

## Gemeinsame Anwendungsschicht

REST, WebSocket, UI und Agent-Tools muessen dieselbe Conversation-Anwendungsschicht nutzen.

Empfohlene Actions:

- `createConversation(actor, input)`
- `listConversations(actor, filters)`
- `inspectConversation(actor, conversationId)`
- `addConversationParticipant(actor, input)`
- `removeConversationParticipant(actor, input)`
- `postConversationMessage(actor, input)`
- `createAgentRequest(actor, input)`
- `cancelAgentRequest(actor, requestId)`
- `markConversationRead(actor, input)`
- `archiveConversation(actor, conversationId)`

Ein Agent-Tool ruft keine REST-Route auf. REST und WebSocket sind Adapter derselben Actions.

## Sequenzielle Implementierungsplanung

Gemaess Repository-Regeln wird kein Folge-To-do begonnen, bevor das vorherige fachlich abgeschlossen, getestet und sauber committed ist.

### To-do 1: Architekturentscheidungen finalisieren

- Begriffe und V1-Scope bestaetigen.
- Einzelchat-zu-Gruppe-Uebernahme festlegen.
- Mehrfach-Mentions in V1 festlegen.
- Cross-Conversation-Agent-Tools in V1 oder spaeter festlegen.
- Runtime-Isolationsvariante fuer wechselnde Execution Principals festlegen.

Abnahme:

- aktualisiertes Architekturdokument,
- Threat Model fuer Conversation ACL und Agent Chains,
- konkrete Migrations- und Rollback-Entscheidung.

### To-do 2: Conversation-Schema und ACL-Service

- Tabellen, Constraints, SQLite-/Postgres-Migrationen,
- zentrale Conversation ACL,
- Participant- und Message-Actions,
- Read-State und Audit,
- noch keine neue Gruppenchat-UI.

Abnahme:

- Service- und Migrationstests,
- Zugriff auf fremde Conversations wird blockiert,
- atomare Message-Sequenzen unter parallelen Writes.

### To-do 3: Bestehende Einzelchats migrieren

- Backfill bestehender Sessions,
- `conversationId` an Runtime Threads,
- Dual-Read-Adapter,
- Session-URL-Kompatibilitaet,
- bestehendes Einzelchat-Verhalten unveraendert halten.

Abnahme:

- bestehende History vollstaendig sichtbar,
- Agent- und User-Attribution korrekt,
- kein Verlust von Attachments, Titeln, Runtime-Status oder Usage-Bezug.

### To-do 4: Multi-User-Gruppenchat

- Gruppen erstellen,
- Menschen einladen und entfernen,
- Conversation-ACL in WebSocket-Abonnements,
- Read-State und Unread pro Teilnehmer,
- Teilnehmer-, Header- und Gruppen-History-UI.

Abnahme:

- zwei echte User koennen denselben Verlauf sehen und schreiben,
- entfernte User verlieren Zugriff sofort,
- parallele Nachrichten bleiben stabil geordnet.

### To-do 5: Agent-Mentions und Routing

- stabile Mention-IDs im Composer,
- `notify` fuer Menschen und `invoke` fuer Agents,
- `mentions_only` in Gruppen,
- Agent Requests und Agent Runs,
- mehrere aktive Runs in Runtime- und UI-Status.

Abnahme:

- unadressierte Gruppennachricht startet keinen Agent,
- `@Agent` startet genau einen idempotenten Request,
- Agent-Antwort ist korrekt attribuiert.

### To-do 6: Agent-zu-Agent-Tools

- Tool-Gruppe `Collaboration`,
- `list_conversation_participants`,
- `post_conversation_message`,
- `request_agent_response`,
- Capability-Gates,
- Chain-/Loop-/Kostenlimits,
- `post_only` und `resume_requester`.

Abnahme:

- Agent A kann Agent B sichtbar ansprechen,
- Agent B antwortet unter eigener Identitaet,
- fehlende Tools oder Grants blockieren den Request,
- Zyklen und ueberschrittene Chain-Budgets werden verhindert.

### To-do 7: KI-Mitarbeiterverwaltung

- gemeinsame Mitarbeiteransicht,
- Employment Profile,
- User-zentrierte Agent-Zuweisungen,
- Conversation-Capability-Schalter,
- Aktivitaets-, Usage- und Statusansicht.

Abnahme:

- Menschen und Organization-Agenten sind an einem Ort verwaltbar,
- Personal-Agenten bleiben privat,
- KI-Mitarbeiter werden nicht als Better-Auth-User oder menschlicher Seat behandelt.

### To-do 8: Cross-Conversation-Agent-Kommunikation

Nur wenn nach V1 weiterhin gewuenscht:

- autorisierte Conversation-Suche,
- Read-/Post-Tools fuer andere Conversations,
- staerkere Capability und Audit,
- Benachrichtigungs- und Delivery-Regeln,
- Schutz fremder Personal Conversations.

## Teststrategie

### Service- und Integrationstests

- Direct-/Group-Constraints.
- Participant ACL fuer User und Agents.
- Message-Attribution und Sequenzierung.
- Read-State pro User.
- Agent-Mention erzeugt genau einen Request.
- Retry erzeugt keinen doppelten Run.
- Agent ohne Tool darf keinen Agent Request erzeugen.
- Agent ohne Participant-/Grant-Zugriff darf weder lesen noch schreiben.
- Execution Principal und Secret-/Connection-Scope bleiben korrekt.
- Cycle Detection und Hop-Limit.
- Pause, Revocation, Offboarding und Agent-Loeschung.
- SQLite-/Postgres-Migrationsparitaet.

### UI-/End-to-End-Tests

- Bestehender Einzelchat bleibt funktionsfaehig.
- Zwei User schreiben in dieselbe Gruppe.
- Unadressierte Gruppennachricht startet keinen Agent.
- `@Agent` startet den korrekten Agent.
- Agent A beauftragt Agent B sichtbar.
- `resume_requester` fuehrt genau eine erlaubte Fortsetzung aus.
- Mehrere Agents zeigen getrennte Runtime-Zustaende.
- Entfernte Teilnehmer verlieren Live-Zugriff.
- Mobile und Desktop zeigen Absender, Mentions und Read-State korrekt.

Playwright oder Browser-Automation wird gemaess Repository-Regeln vor dem konkreten Testlauf explizit bestaetigt. Vor einem Container-Build wird immer `npm run build` ausgefuehrt; Container werden nur auf ausdrueckliche Anforderung gebaut.

## Noch offene Produktentscheidungen

1. Darf ein Einzelchat mit vollstaendigem Verlauf in eine Gruppe uebernommen werden, oder wird standardmaessig nur eine Zusammenfassung geteilt?
2. Erlaubt V1 genau einen Agent-Tag pro Nachricht oder bereits bis zu drei parallele Agent-Mentions?
3. Werden Cross-Conversation-Agent-Tools bereits in V1 umgesetzt oder erst nach stabiler Gruppenchat-Einfuehrung?
4. Ist `resume_requester` standardmaessig deaktiviert oder darf ein Agent es pro Request selbst anfordern?
5. Welche Organization-Limits gelten fuer parallele Runs, Chain-Tiefe und Agent-Kosten?
6. Duerfen Organization-Automations in bestehende Gruppen schreiben, und welche sichtbare Service-Actor-Attribution erhalten sie?

## Empfohlener V1-Scope

Fuer einen sicheren und migrationsarmen ersten Release wird empfohlen:

- bestehende Chats als `direct` Conversations migrieren,
- neue `group` Conversations mit mehreren Menschen und Agents,
- Agents reagieren in Gruppen ausschliesslich auf stabile Mentions,
- zunaechst maximal ein aktivierter Agent pro menschlicher Nachricht,
- Agent-zu-Agent innerhalb derselben Conversation,
- `post_only` als Default,
- `resume_requester` nur mit eigener Capability,
- maximal zwei Agent-zu-Agent-Kanten und kein wiederholter Agent pro Chain,
- keine Cross-Conversation-Agent-Tools in V1,
- Organization-Agenten als KI-Mitarbeiter, Personal-Agenten als private Assistenten.

Dieser Scope schafft das endgueltige Conversation-Fundament, ohne Multi-Agent-Orchestrierung und Cross-Conversation-Kommunikation gleichzeitig mit der Datenmigration ausrollen zu muessen.

## Definition of Done fuer das Gesamtziel

Das Vorhaben ist erst abgeschlossen, wenn:

- sichtbare Conversations nicht mehr an genau eine `agentId` oder genau einen Besitzer gebunden sind,
- mehrere berechtigte Menschen denselben Gruppenchat verwenden koennen,
- mehrere Agents als Teilnehmer mit eigener Identitaet dargestellt werden,
- Agents in Gruppen nur explizit aktiviert werden,
- Agent A Agent B nur ueber freigeschaltete, serverseitig validierte Tools ansprechen kann,
- jeder Agent Run einen verantwortlichen Execution Principal besitzt,
- Agent-zu-Agent-Ketten technisch begrenzt und vollstaendig auditierbar sind,
- private Secrets, Memory und Personal Conversations nicht zwischen Teilnehmern leaken,
- bestehende Einzelchats ohne Datenverlust migriert sind,
- Menschen und KI-Mitarbeiter an einem zentralen Ort verwaltet werden koennen,
- Service-, Integrations-, Build- und freigegebene UI-/E2E-Gates erfolgreich sind.
