# Multi-Channel Agent Architecture Plan

## Ziel

Canvas Notebook soll eine echte Channel-Architektur bekommen. Web-Chat und Telegram werden dabei nicht mehr als getrennte Sonderpfade behandelt, sondern als Channel-Adapter auf dieselbe Agent-Session-Runtime. Die Architektur soll spaeter Slack, Discord, API/Webhooks und weitere Channels aufnehmen koennen, ohne Telegram-spezifische Annahmen zu kopieren.

Der Main Agent bleibt der feste Standard-Agent:

- `canvas-agent` ist immer vorhanden.
- `canvas-agent` kann nicht geloescht werden.
- Sessions gehoeren kuenftig zu einem Agenten.
- Spezialisierte Agenten werden spaeter ermoeglicht, aber in dieser Umstellung nur vorbereitet.

## Leitentscheidungen

| Thema | Entscheidung |
|---|---|
| Session-Modell | Eine Session kann mehrere Channel-Links haben. |
| Historie | Eine Session hat eine gemeinsame Historie ueber alle verknuepften Channels. |
| Web-Chat | Der React/WebSocket-Chat wird ein fester Channel: `web`. |
| Telegram | Telegram wird auf denselben Adapter-Vertrag wie Web migriert. |
| Antwort-Zustellung | Web sieht Sessions immer live. Externe Channels erhalten standardmaessig Antworten nur, wenn sie der zuletzt aktive externe Channel der Session sind. |
| Broadcast | Versand an alle externen Channels wird technisch vorbereitet, aber nicht als Default aktiviert. |
| Channel Settings | Channel-spezifische Settings werden vorbereitet; in dieser Phase werden nur Web und Telegram umgesetzt. |
| Datei-Groesse | Keine grosse Zentraldatei. Routing, Resolver, Adapter, Delivery und UI werden getrennt. |

## Zielarchitektur

```text
Channel Adapter
  web
  telegram
  future: slack, discord, api
        |
        v
ChannelMessageRouter
        |
        v
ChannelSessionResolver
        |
        v
RuntimeService / LivePiRuntime
        |
        v
ChannelDeliveryRouter
        |
        v
Channel Adapter deliver()
```

## Neue fachliche Begriffe

### Agent

Ein Agent beschreibt Persona, Prompt-Bundle, Tool-Policy und Default-Modell. In dieser Umstellung wird nur die Basis geschaffen.

Initialer Agent:

```text
agentId: canvas-agent
name: Canvas Agent
type: main
removable: false
```

### Session

Eine Session ist die gemeinsame Unterhaltungshistorie. Sie gehoert einem User und einem Agenten.

```text
sessionId
userId
agentId
provider
model
thinkingLevel
title
history
```

### Channel

Ein Channel ist ein Zugriffspunkt auf Sessions. Beispiele:

```text
web
telegram
future: slack
```

### Channel Link

Ein Channel Link verbindet eine Session mit einem konkreten Channel-Kontext.

Beispiele:

```text
web:user:{userId}
telegram:chat:{chatId}
future slack:team:{teamId}:channel:{channelId}:thread:{threadTs}
```

## Datenmodell

### Erweiterung `pi_sessions`

`pi_sessions` sollte ein `agentId` bekommen.

```text
agent_id TEXT NOT NULL DEFAULT 'canvas-agent'
```

Die bestehenden Felder `channel_id` und `channel_session_key` bleiben fuer eine sanfte Migration zunaechst erhalten, werden aber langfristig nicht mehr als Quelle der Wahrheit genutzt.

### Neue Tabelle `agents`

Minimal fuer diese Umstellung:

```text
id INTEGER PRIMARY KEY
agent_id TEXT UNIQUE NOT NULL
name TEXT NOT NULL
type TEXT NOT NULL DEFAULT 'main'
removable INTEGER NOT NULL DEFAULT 0
default_provider TEXT
default_model TEXT
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
```

Spaeter erweiterbar um Prompt-Dateien, Tool-Policy, Skills, Composio-Apps und Workspace-Scope.

### Neue Tabelle `session_channel_links`

```text
id INTEGER PRIMARY KEY
session_id TEXT NOT NULL
user_id TEXT NOT NULL
channel_id TEXT NOT NULL
channel_session_key TEXT NOT NULL
channel_thread_key TEXT
display_name TEXT
is_primary INTEGER NOT NULL DEFAULT 0
delivery_policy TEXT NOT NULL DEFAULT 'last_active'
last_inbound_at INTEGER
last_outbound_at INTEGER
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
```

Indizes:

```text
UNIQUE(channel_id, channel_session_key, channel_thread_key)
INDEX(session_id)
INDEX(user_id, channel_id)
```

### Neue Tabelle `channel_active_sessions`

Ersetzt langfristig `telegram_active_session`.

```text
id INTEGER PRIMARY KEY
user_id TEXT NOT NULL
channel_id TEXT NOT NULL
channel_session_key TEXT NOT NULL
channel_thread_key TEXT
session_id TEXT NOT NULL
updated_at INTEGER NOT NULL
```

Indizes:

```text
UNIQUE(channel_id, channel_session_key, channel_thread_key)
INDEX(user_id, channel_id)
```

`telegram_active_session` bleibt waehrend der Migration lesbar und wird nach erfolgreicher Migration entfernt.

### Erweiterung `channel_user_bindings`

Die vorhandene Tabelle ist gut als Basis. Fuer Slack/Discord spaeter sollten Metadaten ergaenzt werden.

```text
metadata_json TEXT
settings_json TEXT
enabled INTEGER NOT NULL DEFAULT 1
```

Fuer diese Phase reicht Telegram/Web. Die Spalten koennen vorbereitet werden, muessen aber nicht sofort fuer Slack befuellt werden.

## TypeScript-Struktur

Die Channel-Schicht soll bewusst klein geschnitten werden.

```text
app/lib/channels/
  types.ts
  registry.ts
  manager.ts
  router.ts
  session-resolver.ts
  delivery-router.ts
  channel-links.ts
  active-sessions.ts
  settings.ts

  web/
    index.ts
    inbound.ts
    outbound.ts
    status.ts

  telegram/
    index.ts
    bot.ts
    polling.ts
    commands.ts
    inbound.ts
    outbound.ts
    session-adapter.ts
    config.ts
    status.ts
    link-token.ts
    normalize.ts
```

Keine Datei sollte zum Sammelbecken werden. Als Richtwert: Wenn eine Datei deutlich ueber 300 bis 400 Zeilen waechst, sollte sie fachlich geteilt werden.

## Channel Interface

Das heutige `ChannelPlugin` bleibt als Grundlage, wird aber generischer.

```ts
export interface ChannelPlugin {
  id: ChannelId;
  name: string;
  capabilities: ChannelCapabilities;
  start(context: ChannelStartContext): Promise<void>;
  stop(): Promise<void>;
  deliver(message: OutboundChannelMessage, target: DeliveryTarget): Promise<DeliveryResult>;
  getStatus(): ChannelStatus;
}
```

### Normalisierte Inbound Message

```ts
export interface InboundChannelMessage {
  channelId: string;
  channelSessionKey: string;
  channelThreadKey?: string;
  userId: string;
  text: string;
  contentParts?: AgentContentPart[];
  attachments?: ChannelAttachment[];
  source: ChannelSource;
  metadata?: Record<string, unknown>;
}
```

### Delivery Target

`DeliveryTarget` darf nicht Telegram-spezifisch sein.

```ts
export interface DeliveryTarget {
  channelId: string;
  channelSessionKey: string;
  channelThreadKey?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}
```

Telegram interpretiert `channelSessionKey` als Chat-ID. Slack kann spaeter `channelSessionKey` als Channel-ID und `channelThreadKey` als Thread nutzen.

## Routing

### Inbound

Alle Channels sollen denselben Pfad nutzen:

```text
adapter inbound
  -> ChannelMessageRouter.handleInbound()
  -> ChannelSessionResolver.resolve()
  -> runtime-service.sendMessage()
  -> create/update session_channel_links
  -> update channel_active_sessions
```

Telegram darf nicht mehr direkt die Runtime als Endziel besitzen. Telegram normalisiert nur und uebergibt an den Router.

### Outbound

Der Event-Bridge darf keine Telegram-Details kennen.

Heute problematisch:

```ts
session.channelSessionKey.replace(/^telegram:/, '')
```

Neu:

```text
agent event
  -> ChannelDeliveryRouter.resolveTargets(sessionId, event)
  -> registry.get(target.channelId).deliver(message, target)
```

Delivery-Policy:

```text
web: immer live an abonnierte WebSocket-Clients
external default: nur zuletzt aktiver externer Channel
external broadcast: spaeter optional
```

## Web Channel

Der React Chat wird als `web` Channel modelliert.

### Inbound

Der bestehende WebSocket-Server bleibt fuer Browser-Clients zustaendig, ruft aber nicht direkt nur Runtime-Service-Logik, sondern den Channel Router.

```text
websocket send_message
  -> WebChannelInbound
  -> ChannelMessageRouter
```

### Outbound

Web bleibt ueber die bestehenden WebSocket-Subscriptions live. Aus Architektur-Sicht ist das der Delivery-Mechanismus des `web` Channels.

Wichtig:

- Web muss jede Session anzeigen koennen, auch wenn die letzte Nachricht aus Telegram kam.
- Die Session-Liste darf nicht mehr nur nach einem einzelnen `channelId` denken.
- Web sollte eine Session als "verknuepft mit Telegram" anzeigen koennen.

## Telegram Migration

Telegram bleibt funktional erhalten, wird aber anders angeschlossen.

### Beibehalten

- grammY Bot
- Polling
- `/start TOKEN`
- `/new`
- `/stop`
- `/compact`
- `/sessions`
- `/switch`
- `/status`
- Upload-Download und Speicherung
- Markdown/HTML-Normalisierung
- Chunking
- Typing-Indikator

### Aendern

`telegram/inbound.ts` erstellt nur noch `InboundChannelMessage` und ruft:

```ts
ChannelMessageRouter.handleInbound(inbound)
```

`telegram/session-resolver.ts` wird aufgeteilt:

```text
telegram/session-adapter.ts
  Telegram-spezifische Keys und Commands

channels/session-resolver.ts
  generische Session-Aufloesung

channels/active-sessions.ts
  channel_active_sessions CRUD

channels/channel-links.ts
  session_channel_links CRUD
```

### Migration bestehender Telegram Sessions

Beim ersten Start nach Migration:

1. Alle `pi_sessions` mit `channel_id='telegram'` lesen.
2. Fuer jede Session einen `session_channel_links` Eintrag erzeugen.
3. `telegram_active_session` in `channel_active_sessions` uebertragen.
4. `pi_sessions.agent_id` auf `canvas-agent` setzen.
5. Alte Spalten/Tabelle nicht sofort loeschen.

## Settings UI: Channels

Die Settings-Seite soll Channels fuer normale Nutzer verstaendlich machen.

### Zielseite

Pfad bleibt wahrscheinlich im bestehenden Settings-Bereich:

```text
/settings?tab=channels
```

### Inhalt

Die Seite zeigt alle bekannten Channels als Liste:

```text
Web Chat
  Status: Aktiv
  Beschreibung: Der Chat in Canvas. Immer verfuegbar.
  Verbundene Sessions: Anzahl
  Einstellungen: keine kritischen Einstellungen in V1

Telegram
  Status: Nicht konfiguriert / Verbunden / Aktiv / Fehler
  Bot Token: ueber Integrations-Env verwaltet
  Account-Verknuepfung: verbunden als ...
  Aktionen: Link erzeugen, Verbindung trennen, Bot-Kommandos registrieren, Channel neu starten
```

### Nutzertext

Die UI sollte erklaeren:

- Channels sind Wege, mit dem Canvas Agent zu sprechen.
- Web ist immer aktiv.
- Telegram kann mit demselben Chat-Verlauf wie Web arbeiten.
- Antworten erscheinen im Web immer live.
- Telegram bekommt Antworten, wenn die Unterhaltung dort aktiv ist.

Keine technischen Details wie Tabellen oder Runtime-Namen in der normalen UI.

### Struktur

```text
app/components/settings/channels/
  ChannelsSettingsPage.tsx
  ChannelCard.tsx
  WebChannelCard.tsx
  TelegramChannelCard.tsx
  ChannelStatusBadge.tsx
  ChannelLinkDialog.tsx
```

`ChannelsPanel.tsx` sollte nicht weiter wachsen, sondern in kleinere Komponenten zerlegt werden.

## API-Routen

Bestehende Routen koennen erhalten bleiben, sollten aber auf generische Services zeigen.

```text
GET  /api/channels/status
POST /api/channels/restart
POST /api/channels/link-token
DELETE /api/channels/bind
POST /api/channels/telegram/register-commands
```

Spaeter sinnvoll:

```text
GET  /api/channels
GET  /api/channels/:channelId
PATCH /api/channels/:channelId/settings
GET  /api/sessions/:sessionId/channels
POST /api/sessions/:sessionId/channels
DELETE /api/sessions/:sessionId/channels/:linkId
```

Fuer diese Umstellung reicht es, Web und Telegram sauber auf die neue interne Service-Schicht zu bringen.

## Umsetzungsschritte

### Phase 1: Datenbasis vorbereiten

1. `agents` Tabelle einfuehren.
2. `canvas-agent` Seed sicherstellen.
3. `pi_sessions.agent_id` ergaenzen.
4. `session_channel_links` einfuehren.
5. `channel_active_sessions` einfuehren.
6. Migration fuer bestehende Telegram- und Web-Sessions schreiben.

Akzeptanz:

- Bestehende Sessions bleiben sichtbar.
- Bestehende Telegram-Verknuepfung bleibt erhalten.
- Neue Sessions bekommen `agentId='canvas-agent'`.

### Phase 2: Generische Channel Services

1. `channel-links.ts` fuer Link-CRUD.
2. `active-sessions.ts` fuer aktive Session pro Channel-Kontext.
3. `session-resolver.ts` fuer generische Session-Aufloesung.
4. `router.ts` fuer Inbound Routing.
5. `delivery-router.ts` fuer Outbound Routing.

Akzeptanz:

- Router kann eine Web-Nachricht und eine Telegram-Nachricht gleich behandeln.
- Runtime-Service bleibt zentrale Runtime-Schicht.
- Keine Telegram-Key-Manipulation im Event-Bridge.

### Phase 3: Web Channel migrieren

1. `web` Channel Plugin einfuehren.
2. WebSocket `send_message` ueber `ChannelMessageRouter` laufen lassen.
3. WebSocket Subscriptions als Delivery-Mechanismus des Web Channels dokumentieren.
4. Session-Liste so anpassen, dass channeluebergreifende Sessions korrekt erscheinen.

Akzeptanz:

- Web-Chat funktioniert unveraendert fuer Nutzer.
- Telegram-Nachrichten erscheinen in der Web-Session.
- Web sieht Antworten live, auch wenn Telegram der aktive externe Channel ist.

### Phase 4: Telegram migrieren

1. Telegram Inbound auf `InboundChannelMessage` umbauen.
2. Telegram Session Resolver auf generische Services umstellen.
3. Commands an neues Session-Link-Modell anpassen.
4. Outbound ueber `ChannelDeliveryRouter` laufen lassen.
5. Typing-Indikator ueber Channel Plugin abstrahieren.

Akzeptanz:

- `/start TOKEN` funktioniert.
- Normale Telegram-Nachrichten erreichen den Agent.
- Bilder/Dokumente funktionieren weiter.
- `/new`, `/sessions`, `/switch`, `/stop`, `/compact`, `/status` funktionieren weiter.
- Antworten kommen in Telegram an, wenn Telegram der letzte aktive externe Channel ist.
- Antworten erscheinen parallel im Web.

### Phase 5: Settings UI ueberarbeiten

1. `ChannelsPanel.tsx` in kleinere Komponenten zerlegen.
2. Web Channel sichtbar machen.
3. Telegram Status und Aktionen verstaendlicher darstellen.
4. Erklaeren, wie gemeinsame Historie zwischen Web und Telegram funktioniert.
5. Bestehende Integrations-Env-Regeln beibehalten.

Akzeptanz:

- Nutzer versteht, dass Web immer aktiv ist.
- Nutzer sieht, ob Telegram konfiguriert, verbunden und laufend ist.
- Link-/Unlink-/Restart-/Register-Commands bleiben vorhanden.
- Keine Secrets werden im UI offengelegt.

### Phase 6: Tests und Pruefung

Mindestens:

- `npm run build`
- API-Test fuer Session-Erstellung mit `agentId`.
- Service-Test fuer `ChannelSessionResolver`.
- Service-Test fuer `ChannelDeliveryRouter`.
- Telegram Command/Resolver Tests, soweit ohne echten Bot moeglich.
- UI-Pruefung der Settings-Seite.

Playwright/Browser-Pruefung nur nach Rueckfrage oder expliziter Freigabe, entsprechend Repository-Regel.

## Risiken

### Ungewollter Broadcast

Antworten an alle Channels koennen sensible Nachrichten falsch verteilen. Deshalb ist Broadcast nicht Default.

### Doppelzustellung

WebSocket-Bridge und ChannelDeliveryRouter duerfen nicht beide Telegram direkt beliefern. Telegram-Zustellung muss an genau einer Stelle passieren.

### Migration bestehender Telegram Sessions

Bestehende `telegram_active_session` Daten muessen weiterhin funktionieren. Die Migration sollte idempotent sein.

### Zu grosse Dateien

Besonders `ChannelsPanel.tsx`, `chat-event-bridge.ts` und Telegram Commands koennen schnell zu gross werden. Neue Services muessen fachlich klein bleiben.

## Nicht Bestandteil dieser Umstellung

- Vollstaendige Spezial-Agenten-Verwaltung.
- Slack-Implementierung.
- Discord-Implementierung.
- Broadcast-UI fuer alle Channels.
- Loeschen alter Telegram-Tabellen direkt in der ersten Migration.
- Vollstaendige Provider-Registry nach Hermes-Vorbild.

## Ergebnis

Nach dieser Umstellung gibt es ein stabiles Fundament:

```text
canvas-agent
  -> gemeinsame Sessions
    -> Web Channel
    -> Telegram Channel
    -> spaeter Slack/Discord/API
```

Web und Telegram funktionieren weiter, aber beide laufen ueber dieselbe Channel-Architektur. Dadurch wird Slack spaeter ein neuer Adapter statt ein neuer Sonderfall.
