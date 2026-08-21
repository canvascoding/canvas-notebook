---
title: 'Umsetzungsplan zu Ticket 16: Persoenliches ChatGPT-Abo im Team-Workspace'
status: planned
date: 2026-08-21
platforms: [web, server, agent-runtime]
tags: [type/implementation-plan, topic/chatgpt, topic/oauth, topic/workspaces, topic/runtime, topic/security]
---

# Umsetzungsplan: Persoenliches ChatGPT-Abo im Team-Workspace

## Ziel, Scope und Sicherheitsinvariante

Dieser Plan konkretisiert [Ticket 16](./16-chatgpt-abo-im-team-workspace-stabilisieren.md)
am aktuellen Codebestand. Er plant ausschliesslich die Nutzung der bereits
user-scoped gespeicherten `openai-codex`-OAuth-Verbindung eines Menschen fuer
dessen eigene, ausdruecklich autorisierte Runs in einem Team-Workspace.

`openai-codex` (ChatGPT-Login) und `openai` (API-Key) bleiben unterschiedliche
Provider-Installationen und duerfen weder in UI noch Resolver als austauschbare
Fallbacks behandelt werden. Laut der offiziellen OpenAI-Dokumentation ist die
Anmeldung mit ChatGPT planbasierte Authentifizierung, waehrend API-Key-Login
nutzungsbasierte Platform-Abrechnung verwendet. Authentifizierung ersetzt
ausserdem keine Workspace- und lokale Berechtigungspruefung:

- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Roles and workspace permissions](https://learn.chatgpt.com/docs/enterprise/roles-and-workspace-permissions)
- [Codex pricing](https://learn.chatgpt.com/docs/pricing)

Die zentrale Sicherheitsinvariante lautet:

> Eine Workspace- oder Agent-Policy kann die Nutzung eines persoenlichen
> Credentials nur verbieten. Nutzbar wird es erst durch eine eigene,
> serverseitig gebundene Freigabe des Credential-Inhabers fuer Workspace,
> Agent, Provider-Installation und Ausfuehrungsart. Kein Admin, Agent,
> Teammitglied, Session-Snapshot oder Automation-Owner kann diese Freigabe
> stellvertretend erzeugen oder den Credential-Subject austauschen.

Ein Agent erhaelt weder Token noch Credential-Referenz. Nur der serverseitige
Provider-Broker darf das Credential unmittelbar vor genau einem ausgehenden
Provider-Request laden. Ein Organization- oder System-Agent kann damit zwar
als Workload eines eigenen interaktiven User-Runs ausgefuehrt werden, sofern
alle Gates dies erlauben; das Credential wird dem Agenten dadurch aber weder
uebereignet noch als Agent-, Workspace- oder Organization-Secret gespeichert.

Nicht Teil dieses Tickets sind ein neues OpenAI-Billingmodell, das Teilen eines
ChatGPT-Abos, eine Organization-weite Token-Migration, allgemeine Automation-
oder Delegationserweiterungen sowie die spaetere Multi-Participant-Conversation-
Architektur. Fuer diese angrenzenden Bereiche werden nur die notwendigen
fail-closed Grenzen festgelegt.

## Inventur des Ist-Zustands

### Provider-Katalog, Policy und Auswahl

- `app/lib/agent-runtime-policy/types.ts`
  - kennt die Credential-Scopes `managed`, `system`, `organization` und `user`;
  - speichert in `AiWorkspaceModelPolicy` nur das grobe Gate
    `allowUserCredentials`;
  - `AiRuntimeResolutionContext` enthaelt zwar Organization, User, Workspace,
    Agent und optional Session, aber keine Principal-Art, Ausfuehrungsart oder
    eigene Credential-Subject-ID;
  - `AiSessionRuntimeSnapshot` pinnt Auswahl sowie Katalog-/Policy-Revision,
    aber weder Credential-Subject noch Freigaberevision.
- `app/lib/agent-runtime-policy/provider-auth-policy.ts` erzwingt fuer OAuth
  bereits den Scope `user`. Eine OAuth-Installation kann damit nicht als
  Organization- oder System-Credential katalogisiert werden.
- `app/lib/agent-runtime-policy/runtime-resolver.ts`
  - laesst User-Installationen im Personal Workspace oder bei
    `policy.allowUserCredentials === true` zu;
  - prueft Verfuegbarkeit anschliessend mit der einzigen `context.userId`;
  - loest die Auswahl in der Reihenfolge Session, User Preference, Agent
    Default, Workspace Default und App Default auf;
  - kann nicht unterscheiden, ob `userId` Credential-Inhaber, verantwortlicher
    Auditor einer Organization-Automation oder interaktiver Principal ist.
- `app/api/admin/agent-runtime/workspace-policy/route.ts` ist zu Recht
  admin-only und kann den zulaessigen Modellkatalog sowie
  `allowUserCredentials` einschraenken. Das Flag ist aktuell jedoch zugleich
  die einzige Team-Freigabe und bildet keine Einwilligung eines Users ab.
- `app/api/agent-runtime/preferences/route.ts` und
  `app/api/agent-runtime/effective/route.ts` pruefen Workspace- und Agent-
  Zugriff fuer den eingeloggten User. Ihre Responses kennen nur generische
  Credential-Verfuegbarkeit, nicht Freigabe-, Reauth- oder Kontostatus.

### Credential-Speicherung und Provider-Request

- `app/lib/pi/oauth.ts` speichert OAuth-Credentials eines eingeloggten Users in
  `/data/users/{userId}/settings/auth.json`, schreibt atomar mit restriktiven
  Dateirechten und serialisiert Refreshes ueber einen Credential-Store-Lock.
- Die OAuth-Routen unter `app/api/oauth/pi/` binden Status, Initiate, Complete,
  Exchange und Disconnect an die authentifizierte `session.user.id`. Ein
  user-scoped Request faellt nicht auf die alte globale OAuth-Datei zurueck.
- `app/lib/agent-runtime-policy/installation-credentials.ts` liest fuer eine
  User-Installation nur den User-Scope und erlaubt `process.env` nur fuer
  System-Installationen. Das ist die richtige Runtime-Grenze.
- `app/lib/agent-runtime-policy/provider-runtime.ts` loest Auth request-lokal
  auf, mutiert `process.env` nicht und revalidiert Auswahl, Katalog und
  Workspace-Policy vor und nach dem Credential-Lookup. Widerruf waehrend dieses
  Fensters schlaegt damit grundsaetzlich fail-closed fehl.
- `app/lib/pi/api-key-resolver.ts` ist ein paralleler Legacy-Pfad. Fuer
  API-Key-Provider mischt er user-scoped Eintraege mit `process.env`; dadurch
  kann eine scoped Aufloesung auf einen breiteren Systemwert fallen. Die
  executable Agent-Runtime nutzt bereits den neueren Provider-Broker, aber
  `app/lib/agents/storage.ts` und Tests referenzieren den Legacy-Resolver noch.
  Vor Freigabe muss belegt sein, dass kein produktiver Modell-Request diesen
  zweiten Pfad umgehen kann.

### Sessions, Reconnect und Tool-Runs

- `pi_sessions` speichert User, Agent, Workspace, Provider-Installation,
  Katalog-/Policy-Revision und Auswahlquelle. Es speichert keinen Token.
- `app/lib/agent-runtime-policy/session-runtime-service.ts` und
  `provider-runtime.ts` pinnen eine Runtime-Auswahl revisionsgebunden. Ein
  alter Snapshot ist keine alleinige Autorisierung: Bei einem neuen Provider-
  Request wird die aktuelle Policy erneut gelesen.
- `app/lib/pi/live-runtime.ts`, `app/lib/pi/runtime-service.ts` und
  `app/lib/pi/session-runtime-access.ts` adressieren eine Runtime mit
  `userId + sessionId`, verlangen Session-Ownership und bauen sie nach einem
  Reconnect erneut aus der gespeicherten Session auf.
- Der aktuelle `AgentExecutionContext` in
  `app/lib/pi/agent-execution-context.ts` enthaelt nur eine `userId` und keine
  getrennte Principal-/Credential-Subject-Semantik. Tools koennen daher zwar
  den Workspace-Scope erben, aber der Modell-Broker kann die Herkunft eines
  Runs nicht beweisbar klassifizieren.

### Delegation und Automationen

- `app/lib/pi/delegation-policy.ts`, `delegate-task-tool.ts` und
  `delegation-dispatcher.ts` halten Source, Worker und Restart aktuell bei
  derselben `userId`; Worker-Sessions sind dem User zugeordnet. Das verhindert
  bereits einen offensichtlichen User-Wechsel, ist aber keine explizite
  Freigabe fuer die Ausfuehrungsart `delegation`.
- Ephemere und Managed Delegationen uebernehmen die Runtime-Auswahl des
  Parent-Runs. Der Resolver kann nicht unterscheiden, ob ein User das
  persoenliche Credential auch dem delegierten Workload erlauben wollte.
- Die Architektur in
  `docs/architecture/canvas-notebook/team-workspace/11-automation-execution-model.md`
  verlangt fuer Organization Automations einen Service Actor und verbietet
  private User-Secrets.
- Der aktuelle Runner in `app/lib/automations/runner.ts` setzt jedoch
  `automationUserId = responsibleUserId || ownerUserId || createdByUserId` und
  uebergibt diese ID unveraendert an Workspace-, Session-, Tool- und Runtime-
  Resolver. Bei aktivem Team-Flag kann eine Organization-Automation deshalb
  die User-Installation und Preference des verantwortlichen Users erreichen.
  Dies ist eine belegte Policy-Luecke und kein blosses UI-Problem.

### UI und Status

- `app/components/settings/PiOAuthButton.tsx` zeigt pro eingeloggtem User nur
  Providername, `connected` und optional `expiresAt`. Ein sicherer Account-
  Hinweis, `reauth_required` und die Team-Freigaben fehlen.
- `ProviderInstallationCredentialEditor.tsx` erklaert den User-Scope korrekt.
  Seine sichtbare Einbindung liegt aber in `AiProvidersModelsPanel.tsx`; der
  zugehoerige Settings-Tab `ai-providers` ist in
  `IntegrationsSettingsClient.tsx` nur fuer Instanz-Admins sichtbar. Ein
  normales Teammitglied hat damit keinen vollstaendigen Self-Service-Flow fuer
  Connect, Reauth, Workspace-Freigabe und Widerruf.
- `ChatModelSelector` und `AgentRuntimePreferenceCard` zeigen Provider und
  Credential-Scope, unterscheiden aber nicht zwischen fehlender Verbindung,
  fehlender User-Einwilligung, Workspace-Verbot, Agent-Verbot und
  Refresh-/Reauth-Fehler.

### Vorhandene Tests, die erweitert werden koennen

- `scripts/pi-oauth-user-scope-test.ts`
- `scripts/agent-runtime-resolution-test.ts`
- `scripts/agent-session-runtime-api-test.ts`
- `scripts/pi-session-provider-switch-test.ts`
- `scripts/channel-session-runtime-test.ts`
- `scripts/chat-workspace-runtime-lifecycle-test.ts`
- `scripts/pi-delegate-task-runtime-test.ts`
- `scripts/pi-delegation-dispatcher-test.ts`
- `scripts/automation-runner-tool-context-test.ts`
- `scripts/automation-workspace-scope-test.ts`
- `scripts/agent-runtime-provider-verification-test.ts`
- `scripts/account-credentials-route-test.ts`

Die vorhandenen Tests decken einzelne User-Scope-, Snapshot-, Race-,
Delegation- und Automationseigenschaften ab. Es fehlt ein gemeinsamer Zwei-
User-Matrixtest fuer `openai-codex`, ausdrueckliche Team-Freigaben,
Principal-Arten, Refresh/Widerruf sowie negative Organization-Automationen.

## Fehlerursachen und Verifikationsstatus

| Befund | Status | Konsequenz fuer die Umsetzung |
| --- | --- | --- |
| `allowUserCredentials` plus `context.userId` ist die gesamte Team-Autorisierung | im Code belegt | Ein eigener User-Grant und ein typisierter Execution Principal sind zwingend. |
| Organization-Automation verwendet `responsibleUserId` im Runtime-Resolver | im Code belegt | Service Actor und Credential Subject muessen getrennt werden; User-Credentials dort hart ausschliessen. |
| OAuth-Datei und OAuth-Routen sind user-scoped | im Code belegt | Vorhandene Speicherung behalten; keine Token-Migration in DB oder Workspace. |
| Provider-Broker revalidiert Policy und Credential pro Request | im Code belegt | Als einziger Modell-Auth-Pfad ausbauen und um Grant-/Principal-Revalidierung erweitern. |
| Legacy-API-Key-Resolver kann scoped Werte mit `process.env` mischen | im Code belegt | Produktionsaufrufer entfernen oder denselben strikten Installations-Resolver verwenden lassen. |
| Session-Snapshot enthaelt keine Credential-Bindung | im Code belegt | Nicht-geheime Subject-/Grant-Metadaten pinnen, aber bei jedem Request aktuell revalidieren. |
| OAuth-UI ist fuer normale Mitglieder nicht vollstaendig erreichbar | im Code belegt | User-facing Account-/Grant-Flaeche ausserhalb des Admin-Katalogs schaffen. |
| `openai-codex` liefert eine stabile, sichere Account-ID oder E-Mail | zu verifizieren | PI-OAuth-Typ und Provider-Response pruefen; keine JWT-Heuristik oder Token-Introspection ohne dokumentierten Vertrag. |
| Lokales Disconnect widerruft den Token auch upstream | zu verifizieren | Provider-Revoke-Unterstuetzung pruefen; mindestens lokalen Entzug atomar und sofort wirksam machen. |
| Alle produktiven Modellaufrufe gehen ueber `provider-runtime.ts` | zu verifizieren | Callgraph fuer Chat, Reconnect, Channels, Delegation, Automationen, Titel/Summary und Provider-Test vervollstaendigen. |
| Eine laufende Runtime wird bei Grant-/OAuth-Widerruf aktiv invalidiert | teilweise belegt | Neue Calls scheitern bereits; Cache-/Queue-Invalidierung und klare UI-Ereignisse fehlen. |

## Zielarchitektur und Least-Privilege-Nachweis

### 1. Vier getrennte Autoritaeten

Eine User-OAuth-Nutzung ist nur erlaubt, wenn alle vier unabhaengigen Gates
gleichzeitig erfolgreich sind:

1. **Organization/Workspace-Policy:** Provider-Installation und Modell sind
   erlaubt; `allowUserCredentials` ist aktiv. Dieses Gate kann nur
   einschraenken.
2. **Agent-Policy:** Der konkrete Agent ist fuer den User und Workspace mit
   `canUse` zugaenglich und seine Credential-Policy erlaubt die konkrete
   Ausfuehrungsart. Organization-Agenten starten fail-closed; der eingebaute
   Hauptagent braucht eine explizite System-Policy statt einer Sonderregel im
   Client.
3. **User-Grant:** Der Credential-Inhaber hat genau
   `workspaceId + agentId + providerInstallationId + executionMode`
   freigegeben. Nur dieser User darf den Grant erstellen oder widerrufen.
4. **Run-Principal:** Der serverseitig abgeleitete User-Principal ist zugleich
   Credential Subject. Bei Service Actor, fehlendem Subject oder ungleichen
   User-IDs ist User-Scope immer verboten.

Formal:

```txt
mayUseUserCredential =
  provider.credentialScope == "user"
  && workspacePolicy.allowUserCredentials
  && modelAllowedByWorkspacePolicy
  && agentAccess.canUse
  && agentCredentialPolicy.allows(executionMode)
  && principal.type == "user"
  && principal.userId == credentialSubjectUserId
  && session.userId == credentialSubjectUserId
  && activeUserGrant.matches(
       organizationId,
       workspaceId,
       agentId,
       providerInstallationId,
       executionMode,
       credentialSubjectUserId
     )
  && oauthConnection.userId == credentialSubjectUserId
  && oauthConnection.status == "connected"
```

Kein Gate darf ein anderes ersetzen. Insbesondere ist `responsibleUserId`
niemals ein Credential Subject eines Service-Actor-Runs.

### 2. Execution Principal statt ueberladener `userId`

Der zentrale, serverseitig erzeugte Runtime-Kontext wird erweitert:

```ts
type AiExecutionMode =
  | 'interactive'
  | 'external_channel'
  | 'delegation'
  | 'personal_automation'
  | 'organization_automation';

type AiRuntimePrincipal =
  | {
      type: 'user';
      userId: string;
      credentialSubjectUserId: string;
    }
  | {
      type: 'organization_service';
      serviceActorId: string;
      responsibleUserId: string;
      credentialSubjectUserId: null;
    };

type AiRuntimeResolutionContext = {
  organizationId: string;
  workspaceId: string;
  workspaceType: WorkspaceType;
  agentId: string;
  sessionId?: string | null;
  requestedSelection?: AiRuntimeSelection | null;
  executionMode: AiExecutionMode;
  triggerSource: 'web' | 'mobile' | 'reconnect' | 'channel' | 'delegation' | 'automation';
  principal: AiRuntimePrincipal;
};
```

Die bestehende `userId` in Session-, Workspace- und Tool-APIs kann waehrend
der Migration als Session Owner bzw. Permission Subject bestehen bleiben. Sie
darf nach der Umstellung aber nicht mehr allein die Credential-Aufloesung
steuern. `AgentExecutionContext` traegt denselben Principal und Mode, damit ein
Tool weder die Ausfuehrungsart noch den Credential Subject durch Parameter
austauschen kann.

### 3. Credential-Broker als einzige Token-Grenze

`provider-runtime.ts` bleibt der einzige Produktionspfad fuer Modell-Auth:

- Resolver liefert nur eine nicht-geheime, authorisierte Binding-Entscheidung.
- `installation-credentials.ts` erhaelt den bereits validierten Credential
  Subject und die Binding-/Grant-ID, nicht eine beliebige User-ID.
- Unmittelbar vor jedem Provider-Request werden Membership, Workspace-Policy,
  Agent-Policy, User-Grant, OAuth-Status und Session-Bindung erneut gelesen.
- Token/Headers/Env leben nur im lokalen Request-Scope von `streamFn` und
  gelangen weder in Tools, Prompt, Session, DB, Audit noch Client-Response.
- Ein fehlender User-Grant fuehrt nicht zu Organization-, System-,
  `process.env`- oder anderem User-Fallback.
- Ein Providerwechsel erzeugt eine neue explizite Auswahl und Binding-Pruefung;
  ein gepinnter `openai-codex`-Run wechselt bei Fehler nicht still auf
  `openai` oder einen Workspace-Default.

Der Legacy-Resolver wird entweder auf Test-/Migrationszwecke begrenzt oder als
Adapter auf den Installations-Resolver umgebaut. Danach verhindert ein
statischer Test neue produktive Importe ausserhalb der erlaubten Datei.

### 4. Agent-Definition ist kein Credential-Owner

Die vorhandenen Agent-Felder `scopeType`, `organizationId`, `ownerUserId` und
die Access-Pruefung bleiben die Ownership-Quelle. Eine kleine serverseitige
Agent-Credential-Policy ergaenzt sie, beispielsweise:

```ts
type AgentPersonalCredentialPolicy =
  | 'deny'
  | 'interactive_user_grant'
  | 'interactive_and_delegated_user_grant';
```

- User-eigene Agents koennen fuer den eigenen interaktiven Principal innerhalb
  der Workspace-Obergrenze freigegeben werden.
- Organization-Agents starten bei `deny`; ein Admin kann nur die Agent-
  Eignung erlauben, niemals den User-Grant erzeugen.
- Der eingebaute Hauptagent erhaelt eine explizit getestete System-Policy fuer
  `interactive_user_grant`.
- Delegation braucht sowohl eine passende Agent-Policy des Ziel-Agenten als
  auch einen separaten User-Grant fuer den Mode `delegation`.
- Weder Agent-Definition noch `agent_grants` speichern Token, OAuth-Subject
  oder eine uebertragbare Secret-Ref.

### 5. Verhalten nach Ausfuehrungsart

| Actor / Ausfuehrung | Workspace | Agent | User-Credential im Team | Begruendung |
| --- | --- | --- | --- | --- |
| User A, direkter Web-/Mobile-Run | Personal von A | erlaubter Agent | wie bisher aus A-Scope; keine Team-Freigabe noetig | Personal Ownership und User-Principal stimmen ueberein. |
| User A, direkter Run | Team | Agent mit passender Policy | nur mit Workspace-Gate und aktivem Grant von A fuer genau diesen Agent/Provider/`interactive` | Zielumfang des Tickets. |
| User B im selben Team | Team | derselbe Agent | nur eigenes Credential und eigener Grant von B; A gilt wie nicht vorhanden | Keine Cross-User-Aufloesung oder Statussichtbarkeit. |
| Reconnect von A | Team | gepinnter Agent | Reconnect selbst laedt keinen Token; naechster Turn baut A-Principal neu und revalidiert Grant/Policy | Snapshot ist Auswahl, nicht Autorisierung. |
| Tool-Call in einem Run von A | Team | aktueller Agent | Tool erhaelt keinen Provider-Token; weitere Modellaufrufe nutzen denselben versiegelten Principal | Keine Credential-Weitergabe an Tools. |
| Externer Channel fuer A | Team | erlaubter Agent | V1 standardmaessig aus; nur eigener Grant `external_channel` nach eindeutigem Channel-User-Mapping | Hintergrund-/Channel-Risiko getrennt vom Live-Chat. |
| Ephemere oder Managed Delegation von A | Team | erlaubter Ziel-Agent | V1 default-deny; nur separater Grant `delegation`, gleicher User-Principal und passende Ziel-Agent-Policy | Keine implizite Vererbung aus `interactive`. |
| Personal Automation von A | Personal von A | erlaubter Agent | A-Scope nach bestehender Personal-Automation-Policy | Kein Team-Workspace-Fall; aktuelle Semantik bleibt. |
| Organization Automation | Team | Organization-/System-Agent | niemals User-Scope; nur Organization/System/Managed | Service Actor hat `credentialSubjectUserId = null`. |
| System-/Background-Run ohne User-Principal | beliebig | beliebig | niemals | Kein authentifizierter Credential-Inhaber. |

Fuer V1 kann die UI ausschliesslich `interactive`-Grants im Team anbieten.
`delegation` und `external_channel` bleiben bis zu eigener UI- und Threat-
Model-Abnahme technisch default-deny. Der Datenvertrag wird dennoch von Beginn
an explizit, damit spaetere Aufrufer nicht wieder auf eine allgemeine `userId`
zurueckfallen.

## Datenvertraege

### User-Grant

Neue Tabelle `ai_user_workspace_provider_grants` in `app/lib/db/schema.ts`, den
SQLite-/Postgres-Migrationen und den Store-Abstraktionen:

```ts
type AiUserWorkspaceProviderGrant = {
  id: string;
  organizationId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  providerInstallationId: string;
  allowedExecutionModes: AiExecutionMode[];
  status: 'active' | 'revoked';
  revision: number;
  grantedAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
```

Constraints und Indizes:

- Unique-Key auf `userId + workspaceId + agentId + providerInstallationId`;
- Foreign Keys auf User, Workspace und Provider-Installation mit sicherem
  Revoke/Delete-Verhalten;
- Organization-ID muss zu Workspace und Installation passen;
- `organization_automation` ist per Schema-/Service-Validierung nie in
  `allowedExecutionModes` zulaessig;
- Update mit `expectedRevision`/CAS; Revoke ist idempotent;
- Grant enthaelt keine OAuth-Daten und kann ohne Credential nicht als
  Autorisierung genutzt werden.

Der Workspace-Policy-Flag bleibt als Admin-Obergrenze bestehen. Bestehende
Team-Workspaces erhalten keine Grants durch Migration.

### Agent-Policy

Die Agent-Policy wird als nicht-geheimes Feld an der zentralen Agent-Definition
oder in einer eigenen Policy-Tabelle mit Revision gespeichert. Die konkrete
Persistenzentscheidung wird in Phase 1 anhand der bestehenden Agent-Update-
APIs getroffen. Pflichtfelder des logischen Vertrags sind:

```ts
type AiAgentCredentialPolicy = {
  agentId: string;
  personalCredentialPolicy: AgentPersonalCredentialPolicy;
  revision: number;
  updatedByUserId: string | null;
  updatedAt: Date | null;
};
```

Eine User-API darf dieses Objekt lesen, aber nur berechtigte Agent-Manager
duerfen es aendern. Der User-Grant kann die Agent-Policy nur weiter
einschraenken.

### Session-Snapshot

`AiSessionRuntimeSnapshot` und `pi_sessions` werden um ausschliesslich
nicht-geheime Bindungsmetadaten ergaenzt:

```ts
type AiSessionRuntimeAuthorizationSnapshot = {
  credentialScope: AiCredentialScope;
  credentialSubjectUserId: string | null;
  executionMode: AiExecutionMode;
  principalType: 'user' | 'organization_service';
  userGrantId: string | null;
  userGrantRevision: number | null;
};
```

Der Snapshot belegt, welche Entscheidung die Auswahl gepinnt hat. Er ist
niemals eine dauerhafte Freigabe: aktuelle Revision, Status, OAuth-Verbindung,
Membership und Policies werden vor jedem neuen Provider-Request revalidiert.
Ein Aufruf mit einem anderen Principal oder Mode darf einen existierenden
Snapshot nicht umdeuten.

Fuer Organization-Automationen ist `credentialSubjectUserId = null`, auch wenn
Session-Ownership aus Kompatibilitaetsgruenden vorerst noch auf einer
`responsibleUserId` basiert. Dieser Widerspruch wird sichtbar und fail-closed,
bis Session Ownership langfristig auf Service Actors erweitert wird.

### Sicherer Connection-Status

Token-Datei und Refresh-Credential bleiben unter
`/data/users/{userId}/settings/auth.json`. Separat darf nur ein minimales,
user-scoped Statusobjekt geliefert werden:

```ts
type AiUserProviderConnectionStatus = {
  providerId: 'openai-codex';
  state: 'disconnected' | 'connected' | 'refreshing' | 'reauth_required';
  accountLabel: string | null;
  expiresAt: number | null;
  lastVerifiedAt: string | null;
  revision: number;
};
```

`accountLabel` darf nur aus dokumentierter, nicht-tokenbasierter
Provider-Metadaten oder einem vom User selbst gesetzten Alias entstehen. Vor
der Implementierung ist zu pruefen, ob PI fuer `openai-codex` eine stabile
Account-Kennung liefert. Kein Access-/ID-Token wird im Client decodiert, kein
vollstaendiger Token oder Refresh-Fehlertext wird persistiert. Wenn keine
verifizierbare Kennung existiert, zeigt die UI einen expliziten User-Alias plus
„nicht vom Provider bestaetigt“ statt eine erfundene Identitaet.

## API-Vertraege

### Eigene Verbindung und Freigaben

Die vorhandenen `/api/oauth/pi/*`-Routen bleiben strikt auf den eingeloggten
User begrenzt. Der Statusvertrag wird um `state`, sicheren `accountLabel` und
`lastVerifiedAt` erweitert. Keine Admin-Route kann Status oder Accountlabel
eines anderen Users abrufen.

Neue, user-owned Route, beispielsweise
`/api/agent-runtime/user-credential-grants`:

- `GET ?workspaceId&agentId&providerInstallationId`
  - verlangt `canRead + canRunAgent` sowie `canUse` fuer den Agent;
  - gibt nur den eigenen Grant, den eigenen Connection-Status und redacted
    Gate-Entscheidungen zurueck.
- `PUT`
  - Body:
    `{ workspaceId, agentId, providerInstallationId, allowedExecutionModes, expectedRevision }`;
  - setzt `userId` aus der Session;
  - validiert Organization/Workspace, Agent-Zugriff, Agent-Policy, Provider-
    Scope `user`, OAuth-Auth-Methode und erlaubte Modes;
  - erlaubt niemals `organization_automation`.
- `DELETE ?workspaceId&agentId&providerInstallationId&expectedRevision`
  - widerruft nur den eigenen Grant idempotent;
  - erhoeht die relevante Runtime-Autorisierungsrevision und invalidiert
    betroffene Laufzeit-Caches.

Die effektive Runtime-Response erhaelt fuer User-Installationen einen
redacted, UI-tauglichen Status:

```ts
type AiUserCredentialEligibility = {
  state:
    | 'ready'
    | 'not_connected'
    | 'reauth_required'
    | 'workspace_policy_blocked'
    | 'agent_policy_blocked'
    | 'consent_required'
    | 'execution_mode_blocked';
  accountLabel: string | null;
  grantRevision: number | null;
};
```

Diese Daten werden nur fuer den aktuellen User berechnet. Katalog- und Admin-
APIs geben weiterhin keine user-spezifischen Connection-Metadaten aus.

### Fehlercodes

Resolver und Provider-Broker unterscheiden mindestens:

- `USER_CREDENTIAL_NOT_CONNECTED`
- `USER_CREDENTIAL_REAUTH_REQUIRED`
- `USER_CREDENTIAL_CONSENT_REQUIRED`
- `USER_CREDENTIAL_WORKSPACE_BLOCKED`
- `USER_CREDENTIAL_AGENT_BLOCKED`
- `USER_CREDENTIAL_EXECUTION_MODE_BLOCKED`
- `USER_CREDENTIAL_SUBJECT_MISMATCH`
- `USER_CREDENTIAL_GRANT_REVOKED`
- `ORGANIZATION_AUTOMATION_USER_CREDENTIAL_FORBIDDEN`

API-Meldungen duerfen einem fremden User nicht bestaetigen, dass ein Credential
oder Grant existiert. Bei Cross-User-IDs gilt die Ressource als nicht vorhanden
oder der serverseitig abgeleitete Subject gewinnt; die Response nennt niemals
den fremden Account.

## Strikt sequenzielle Implementierungsphasen

Jede Phase beginnt erst, wenn die vorherige implementiert, mit ihren
fokussierten Tests validiert und als eigener Commit abgeschlossen ist. Bei
einem fehlgeschlagenen Gate wird nicht mit der naechsten Phase begonnen.

### Phase 1: Verifikationsspikes und Sicherheitsvertrag fixieren

1. Alle produktiven Aufrufer von `resolvePiApiKey`,
   `resolveProviderInstallationRuntimeAuth`, `resolveExecutableAgentRuntime`
   und `resolveAndPinSessionRuntime` fuer Chat, Summary/Title, Reconnect,
   Channels, Delegation, Provider-Test und Automationen als Callgraph
   dokumentieren.
2. Den konkreten `openai-codex`-Credential-Typ der installierten PI-Version
   pruefen: sichere Account-Metadaten, Refreshfehler und moegliche upstream
   Revoke-Funktion. Keine Live-Credentials in Fixtures oder Logs verwenden.
3. Agent-Policy-Persistenz sowie SQLite-/Postgres-Migrationspfad festlegen.
4. Die oben definierte Matrix als ausfuehrbare Testtabelle anlegen; Tests sind
   zunaechst rot fuer fehlende Principal-/Grant-Gates.

Gate: Callgraph ohne unbekannten produktiven Auth-Pfad, festgeschriebener
Accountlabel-Vertrag und reproduzierbare failing security tests.

Fokussierter Commit: `test: capture team user credential security gaps`

### Phase 2: Principal, Execution Mode und Organization-Automation absichern

1. `AiRuntimeResolutionContext` und `AgentExecutionContext` um den
   serverseitigen Principal, `executionMode` und `triggerSource` erweitern.
2. Alle Entry Points typisiert migrieren; keine Default-Werte im tiefen
   Resolver, weil ein vergessener Aufrufer compile- oder testseitig auffallen
   soll.
3. Automation-Policy und Runner so umbauen, dass Organization-Automationen
   `organization_service` mit `credentialSubjectUserId = null` verwenden.
   `responsibleUserId` bleibt nur Audit-/Permission-Verantwortlicher.
4. User-Installationen und User Preferences fuer Service-Actor-Runs schon vor
   jedem Credential-Lookup aus dem effektiven Katalog entfernen. Eine alte
   user-scoped Snapshot-Auswahl fuehrt zu einem klaren, pausierbaren Fehler und
   nicht zu einem stillen Providerwechsel.

Gate: Organization-Automations koennen auch bei aktivem Workspace-Flag kein
User-Credential aufloesen; direkte Personal-Runs bleiben unveraendert.

Fokussierter Commit: `fix: separate runtime principals from automation owners`

### Phase 3: User-Grants und Agent-Policy persistieren

1. Schema, SQLite- und Postgres-Migrationen fuer User-Grants und Agent-
   Credential-Policy implementieren; Startup-/Provider-Paritaet testen.
2. Store und Domain-Service mit CAS, idempotentem Revoke und strikter
   Organization-/Workspace-/User-Konsistenz bauen.
3. Bestehende Team-Policies nicht automatisch in User-Grants umwandeln.
4. Admin-Policy-Aenderungen, Agent-Policy-Aenderungen, Grant und Revoke mit
   IDs, Scope, Revision, Actor und Status auditieren, aber ohne Accountlabel,
   Token oder Credential-Dateipfad.

Gate: Zwei User koennen nur eigene Grants lesen/aendern; Migration ist auf
leerer und bestehender SQLite-/Postgres-Datenbank idempotent; Default bleibt
Team-deny.

Fokussierter Commit: `feat: add scoped user provider grants`

### Phase 4: Einen authoritativen Resolver und Broker erzwingen

1. `runtime-resolver.ts` um Workspace-, Agent-, Grant-, Principal- und Mode-
   Gates erweitern und die genaue Eligibility statt nur
   `credentialAvailable` zurueckgeben.
2. `provider-runtime.ts` revalidiert die komplette Binding-Entscheidung vor
   und nach OAuth-Refresh. `installation-credentials.ts` akzeptiert nur den
   validierten Credential Subject.
3. Legacy-Auth-Aufrufer auf diesen Pfad migrieren oder explizit aus dem
   Produktionspfad entfernen; scoped Auth darf nie `process.env` beimischen.
4. Einen Import-/Callgraph-Test hinzufuegen, der neue Modell-Auth-Bypaesse und
   direkte OAuth-Dateizugriffe ausserhalb des Credential-Moduls ablehnt.
5. Race-Tests fuer Policy-, Grant-, Agent-Policy- und Disconnect-Aenderung
   waehrend Credential-Lookup ergaenzen.

Gate: Jeder Modell-Request hat einen versiegelten Principal und eine aktuelle
Grant-Entscheidung; alle breiteren und Cross-User-Fallbacks sind negativ
getestet.

Fokussierter Commit: `refactor: enforce one scoped provider auth broker`

### Phase 5: Session-Snapshot, Reconnect und Laufzeit-Widerruf

1. Snapshot-Typ, `pi_sessions`, Store und Session-CAS um die nicht-geheime
   Authorization Snapshot erweitern.
2. Neue Session, Session-PATCH, Reconnect-Prewarm, WebSocket-Subscribe,
   Mobile-Ticket und Channel-Session gegen Session Owner, Principal und
   Workspace revalidieren.
3. Ein Snapshot pinnt Provider/Modell und dokumentiert Subject/Grant, darf aber
   einen abgelaufenen Grant nicht verlaengern. Naechster Turn/Provider-Call
   liest die aktuelle Revision.
4. Disconnect, Grant-Revoke, Workspace-/Agent-Policy-Aenderung und
   Membership-Entzug invalidieren betroffene Live-Runtime-Caches und queued
   Runs. Ein bereits gestarteter externer Request wird nicht mit einem neuen
   Token fortgesetzt; jeder Folgecall stoppt.
5. Providerwechsel verlangt einen neuen Snapshot-CAS. Kein automatischer
   Fallback bei Reauth oder Revoke.

Gate: Reconnect verwendet nur das Credential desselben Users; Widerruf greift
bei bestehender Session vor dem naechsten Provider-Request und Tokens fehlen in
Snapshot, Events und Logs.

Fokussierter Commit: `fix: bind session runtime to current user grants`

### Phase 6: Delegation, Channels und Tool-Run-Grenzen

1. Direkte Tool-Calls erben den versiegelten Execution Context und erhalten
   nie Provider-Auth. Modell-Fortsetzungen nach Tools gehen erneut durch den
   Broker.
2. Delegation erbt nicht automatisch den `interactive`-Grant. Parent, Worker,
   Ziel-Agent, Principal, Workspace und Mode `delegation` werden im Store und
   beim Dispatcher-Restart revalidiert.
3. V1 laesst Team-Delegation mit User-Credential default-deny, sofern die
   Produktfreigabe fuer einen separaten Delegations-Grant nicht in derselben
   Phase explizit umgesetzt und abgenommen wird.
4. Externe Channels verwenden `external_channel`; fehlendes oder mehrdeutiges
   User-Mapping sowie fehlender Mode-Grant blockieren den Run.
5. Organization-Automationen bleiben unabhaengig von Delegations-/Channel-
   Grants immer User-Credential-deny.

Gate: Dispatcher-Restart, Managed Target, ephemerer Worker, Channel-Reconnect
und Tool-Fortsetzung koennen Subject oder Mode nicht erweitern.

Fokussierter Commit: `fix: preserve credential boundaries across agent workloads`

### Phase 7: User-facing Connect-, Consent- und Reauth-UI

1. Eine fuer normale Mitglieder sichtbare persoenliche Provider-Flaeche in den
   Settings oder Agent-Preferences schaffen; der Admin-Katalog bleibt getrennt.
2. Connect/Reauth/Disconnect fuer `openai-codex`, sicheren Account-Hinweis,
   Ablauf-/Reauth-Status und einen Link zur eigenen Freigabeverwaltung zeigen.
3. Beim Auswaehlen im Team-Workspace einen expliziten Consent-Dialog fuer
   Workspace, Agent, Provider und V1-Mode `interactive` anzeigen. Kein
   vorselektierter Delegations-/Channel-/Automation-Scope.
4. ChatModelSelector und Runtime Preference unterscheiden die definierten
   Statuscodes und verlinken zielgerichtet zu Connect, Reauth oder Consent.
5. Disconnect/Revoke erklaert die Auswirkung auf bestehende Sessions; Admins
   sehen nur aggregierte Policy-/Readiness-Informationen, niemals User-
   Accountlabels oder Verbindungsstatus anderer Mitglieder.

Gate: Ein normales Teammitglied kann den gesamten eigenen Flow ohne Admin-
Zugriff bedienen; User B sieht in DOM, API und Fehlertext keine Metadaten von A.

Fokussierter Commit: `feat: add personal ChatGPT team consent UI`

### Phase 8: Abschlussregression und Betriebsfreigabe

1. Alle unten genannten fokussierten Tests sowie Lint fuer betroffene Dateien
   ausfuehren.
2. `npm run build` ausfuehren. Kein Containerbau ist fuer dieses Ticket
   erforderlich; falls spaeter explizit verlangt, erst nach erfolgreichem Build
   und nie parallel zu einem anderen Test-Container.
3. Manuelle Zwei-User-Abnahme nach der unten stehenden Checkliste. Browser-/
   Playwright-E2E nur nach expliziter Freigabe gemaess Repository-Regeln.
4. Security-Diff pruefen: keine Tokenwerte, keine fremden Accountlabels, keine
   untypisierten Runtime-Aufrufer, keine stillen Fallbacks.
5. Ticket und Index erst nach vollstaendig bestandener Produktabnahme auf
   `erledigt` setzen.

Gate: automatisierte und manuelle Abnahmekriterien vollstaendig dokumentiert;
Rollback wurde auf einem Upgrade-Testbestand geprobt.

Fokussierter Commit: `test: verify personal ChatGPT team isolation`

## Automatisierte Abnahmekriterien

### Runtime- und Zwei-User-Matrix

- User A und B besitzen getrennte `openai-codex`-Fixtures mit Sentinel-
  Credentials. Jeder Provider-Request erhaelt ausschliesslich den Sentinel des
  aktiven Subjects.
- Workspace-Flag aus, fehlender Grant, falscher Agent, falscher Mode,
  widerrufener Grant, deaktivierter Agent, fehlendes `canRunAgent` und
  gesperrtes Modell werden jeweils vor Credential-Lookup abgelehnt.
- Ein Admin kann die Workspace-/Agent-Obergrenze, aber keinen Grant fuer A oder
  B erstellen.
- Manipulierte `userId`, Grant-ID, Session-ID, Agent-ID und
  Provider-Installation in API-Payloads erweitern keine Rechte.
- User B erhaelt fuer Status, Grant oder Session von A keine unterscheidbare Existenz-
  Information.

### OAuth, Refresh und Widerruf

- Erfolgreicher Refresh ersetzt nur das Credential von A unter dessen Pfad und laesst B
  unveraendert.
- `invalid_grant`/abgelaufener Refresh setzt einen klaren
  `reauth_required`-Status und startet keinen Provider-Request mit altem Token.
- Zwei parallele Refreshes bleiben durch den per-User/per-Provider Lock
  serialisiert.
- Disconnect waehrend des Lookup-Fensters blockiert den Request in der finalen
  Revalidierung.
- Kein API-/Audit-/Console-Output enthaelt Sentinel Access Token, Refresh Token,
  Auth-Header, komplette OAuth-Credential-Objekte oder Credential-Dateipfade.

### Session, Reconnect und Providerwechsel

- Neue Team-Session von A pinnt Scope, Subject und Grant-Revision ohne Token.
- Reconnect als A funktioniert nach erneuter Policy-/Grant-Pruefung; Reconnect
  als B liefert `SESSION_NOT_FOUND` bzw. den bestehenden Ownership-Fehler.
- Grant-/Policy-Revoke nach Session-Erstellung blockiert den naechsten Turn und
  laesst die History lesbar.
- Providerwechsel ist CAS-gebunden; ein Race mit Policy-/Grant-Revision
  scheitert und verlangt erneute Auswahl.
- Reauth-Fehler verursacht keinen stillen Wechsel von `openai-codex` zu
  `openai`, App Default oder Organization Credential.

### Delegation, Tools, Channels und Automation

- Tool-Parameter und Tool-Env enthalten kein Provider-Credential; ein weiterer
  Modell-Turn nach Tool-Result revalidiert den Broker.
- Ephemere und Managed Delegation sind ohne Mode-Grant blockiert. Falls der
  Mode aktiviert wird, gelten gleicher User, Workspace und Ziel-Agent-Policy;
  Dispatcher-Restart behaelt diese Grenzen.
- Channel-Run ist ohne eindeutiges internes User-Mapping oder ohne
  `external_channel`-Grant blockiert.
- Personal Automation im Personal Workspace kann weiterhin das Owner-
  Credential verwenden.
- Organization Automation kann trotz `allowUserCredentials = true`,
  `responsibleUserId`, User Preference und altem User-Snapshot niemals einen
  User-Provider materialisieren; sie pausiert mit dem spezifischen Policy-
  Fehler.

### Schema/API/UI-Vertraege

- SQLite und Postgres erstellen Constraints/Indizes identisch; wiederholte
  Startup-Migration bleibt idempotent.
- Bestehende Team-Sessions und Preferences erzeugen durch Migration keinen
  Grant.
- User-Grant-APIs sind session-derived, CSRF-/Rate-Limit-konform, CAS-geschuetzt
  und auditieren nur redacted Metadaten.
- Komponenten-/Contract-Tests pruefen jeden Eligibility-State, Reauth-Link,
  Consent-Text, Revoke-Flow und die Admin-/Member-Sichtbarkeit.
- Ein statischer Regressionstest verbietet direkte produktive OAuth-Dateireads
  und neue Importe des Legacy-Key-Resolvers in Runtime-Aufrufern.

## Manuelle Abnahme

Die Abnahme nutzt zwei normale Testnutzer A und B sowie einen Admin. Sie darf
erst in der Implementierungsphase und fuer Browser/Playwright nur nach
expliziter Freigabe erfolgen.

1. Admin erlaubt `openai-codex` und User-Credentials fuer genau einen Team-
   Workspace sowie den Hauptagenten.
2. A verbindet das eigene ChatGPT-Konto in der persoenlichen Provider-Flaeche
   und sieht den sicheren Account-Hinweis.
3. A kann im Personal Workspace chatten, im Team Workspace vor Consent jedoch
   nicht.
4. A erteilt den sichtbaren Grant fuer Team-Workspace, Hauptagent und
   `interactive`; der eigene Team-Chat funktioniert anschliessend.
5. B sieht weder das Konto noch den Grant von A und kann mit derselben Auswahl nicht
   laufen. Nach eigener Verbindung/Freigabe verwendet B ausschliesslich Bs
   Konto.
6. Die bestehende Session von A funktioniert nach Page Reload/WebSocket-Reconnect;
   ein Login als B kann die Session nicht abonnieren oder fortsetzen.
7. Admin sperrt das Modell oder User-Credentials. Der naechste Turn von A stoppt mit
   klarer Policy-Meldung; erneutes Aktivieren erzeugt keinen User-Grant.
8. A widerruft den Workspace-Grant und spaeter die OAuth-Verbindung. Bestehende
   History bleibt, neue Provider-Calls stoppen sofort und die UI bietet den
   richtigen Consent- bzw. Reauth-Flow.
9. Delegation, externer Channel und Organization-Automation werden ohne eigene
   Freigabe bzw. grundsaetzlich fuer Organization Automation blockiert.
10. Server-/Audit-Logs und gespeicherter Session-Snapshot werden auf Tokens,
    Auth-Header, fremde Accountlabels und Credential-Pfade kontrolliert.

## Migration, Rollout und Rollback

### Migration

- Additive Tabellen/Felder zuerst ausrollen; alte Runtime liest sie noch nicht.
- Alle neuen Team-Grants starten leer. Es gibt kein Backfill aus
  `allowUserCredentials`, User Preferences oder bestehenden Sessions.
- Bestehende Personal-Workspace-Nutzung bleibt funktional, solange Principal-
  und Broker-Migration keine Regression zeigt.
- Bestehende Team-Snapshots mit User-Installation bleiben als History
  erhalten, sind aber bis zu neuem explizitem Consent nicht ausfuehrbar.
- Accountstatus wird lazy beim eigenen Statusabruf/Connect/Refresh aufgebaut;
  OAuth-Tokens werden weder verschoben noch neu serialisiert.
- SQLite-, Postgres-, Backup-/Restore- und SQLite-to-Postgres-Pfade muessen die
  neuen nicht-geheimen Daten mitnehmen. OAuth-Dateien bleiben Bestandteil der
  bestehenden user-scoped Backup-Policy.

### Gestufter Rollout

1. Principal-/Automation-Fix aktivieren; Organization-Automation sofort
   fail-closed fuer User-Credentials.
2. Grant- und Broker-Code hinter einem serverseitigen Feature-Gate deployen,
   Default aus.
3. Interne Testorganisation mit `interactive` aktivieren und Isolation/Audit
   beobachten.
4. Allgemein aktivieren; `delegation` und `external_channel` bleiben getrennt
   aus, bis ihre Abnahme erfolgt ist.

Das Feature-Gate darf nur die neue Team-Nutzung deaktivieren. Es darf weder
Principal-Pruefung noch Organization-Automation-Sperre umgehen.

### Rollback

- Feature-Gate deaktivieren: Neue Team-User-Credential-Ausfuehrungen werden
  blockiert; Personal-Workspace und Organization/Managed Provider bleiben
  nutzbar.
- Grant-Daten und additive Snapshot-Felder bleiben fuer ein spaeteres
  Vorwaerts-Rollout erhalten, werden aber nicht ausgewertet.
- Keine Down-Migration loescht Grants oder OAuth-State waehrend eines
  Betriebs-Rollbacks. Eine spaetere bereinigende Migration ist separat zu
  pruefen.
- Wenn der neue Broker eine Regression zeigt, darf nur auf einen nachweislich
  scope-strikten Adapter zurueckgeschaltet werden; der alte ambient-fallback-
  faehige `resolvePiApiKey` ist kein zulaessiger Rollback-Pfad.
- Queued Organization-Automationen mit ehemaliger User-Auswahl bleiben
  pausiert, bis ein erlaubter Organization/System/Managed Provider explizit
  gewaehlt wurde.

## Risiken und Gegenmassnahmen

| Risiko | Gegenmassnahme |
| --- | --- |
| Admin-Policy wird als Einwilligung missverstanden | Vier-Gate-Modell; Grant kann nur der eingeloggte Credential-Inhaber schreiben. |
| `responsibleUserId` bleibt verdeckter Secret-Subject | Typisierter Service-Actor-Principal mit `credentialSubjectUserId = null`; negativer Automationstest. |
| Snapshot konserviert widerrufene Rechte | Snapshot nur als Auswahl/Audit; aktuelle Grant-/Policy-Revalidierung pro Provider-Request. |
| Organization-Agent exfiltriert persoenliches Credential | Token bleibt im Broker, Agent/Tools sehen keine Ref; Agent-Policy plus per-Agent-Grant; keine Authdaten im Prompt. |
| OAuth-Refresh-Race nutzt altes Credential | Store-Lock plus Revalidierung nach Refresh und vor Request; Runtime-Invalidierung bei Revoke. |
| UI leakt Accountidentitaet an Admin/B | Eigene Statusroute, keine Accountfelder im Admin-Katalog, Cross-User-Contracttests. |
| Fehlende Provider-Accountmetadaten fuehren zu unsicherer Tokenanalyse | Verifikationsgate; nur dokumentierte Metadaten oder klar markierter User-Alias. |
| Legacy-Key-Resolver umgeht Scope | Ein Broker, statischer Importtest, kein ambient Fallback fuer scoped Runs. |
| Zu breite Delegations-/Channel-Freigabe | Eigene Execution Modes, V1 default-deny, keine implizite Vererbung aus `interactive`. |
| Rollback reaktiviert unsichere Automationen | Automation-Sperre nicht feature-gaten; Jobs mit unzulaessiger Auswahl pausiert halten. |

## Definition of Done

Ticket 16 ist erst umgesetzt, wenn:

- die belegte Organization-Automation-Luecke geschlossen ist;
- alle produktiven Modellaufrufe denselben scope-strikten Broker verwenden;
- User A sein Credential explizit fuer einen erlaubten eigenen Team-Run
  freigeben und jederzeit widerrufen kann;
- User B und jeder Service Actor das Credential weder sehen noch direkt oder
  indirekt verwenden koennen;
- Workspace- und Agent-Policy nur einschraenken, niemals stellvertretend
  freigeben;
- Session, Reconnect, Tool-Fortsetzung und die explizit definierten
  Hintergrundarten denselben Principal-/Grant-Vertrag einhalten;
- Snapshot, Audit, Logs, Client-Responses und Tools keine Tokens enthalten;
- fokussierte Tests, `npm run build` und die freigegebene manuelle Abnahme
  bestanden sind;
- die Implementierung in den beschriebenen sequenziellen Commits vorliegt und
  Ticket/Index erst danach auf `erledigt` gesetzt wurden.
