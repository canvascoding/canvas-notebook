# Agent Runtime Architecture Plan

Stand: 2026-05-27

## Zielbild

Canvas Notebook soll von einer globalen Agent-Konfiguration zu einer agent-zentrierten Runtime wechseln. Der Canvas Agent bleibt der feste Hauptagent und ist nicht loeschbar. Weitere spezialisierte Agenten koennen spaeter erstellt werden und erben zunaechst die Defaults des Canvas Agent.

```text
Agent
  -> Prompt Files
  -> Runtime Config
  -> Tools / Skills
  -> Sessions
      -> Channel Links
  -> Automations
      -> Runs
      -> Delivery Target
```

## Entscheidungen

- Eine Session gehoert genau einem Agenten.
- Eine Session kann ueber mehrere Channels erreichbar sein, zum Beispiel Web und Telegram.
- Mehrere Agenten teilen keine Session-Historie.
- `canvas-agent` ist immer vorhanden, nicht entfernbar und Default fuer Chat, Telegram und Automations.
- Spezial-Agenten erben Provider, Model, Tool-Defaults und `USER.md` vom Canvas Agent, solange sie keine eigenen Overrides setzen.
- Jeder Agent hat eigenes `MEMORY.md`.
- Jeder Agent hat eine eigene Heartbeat-Konfiguration.
- Automations bekommen einen ausfuehrenden Agenten und ein separates Delivery-Ziel.

## Prompt-Dateien

Canvas Agent:

```text
AGENTS.md
USER.md
MEMORY.md
SOUL.md
TOOLS.md
HEARTBEAT.md
```

Spezial-Agenten:

```text
AGENTS.md
MEMORY.md
SOUL.md
TOOLS.md
HEARTBEAT.md
```

Geerbt vom Canvas Agent:

```text
USER.md
```

## Systemprompt-Komposition

Die Prompt-Komposition orientiert sich an Hermes und wird in drei Ebenen getrennt.

```text
Stable:
- Canvas Core Rules
- USER.md vom Canvas Agent
- SOUL.md des aktiven Agenten
- TOOLS.md des aktiven Agenten
- Skills/Tools/Provider-Hinweise

Context:
- AGENTS.md des aktiven Agenten
- Workspace-Kontext
- Channel-Kontext
- Session-Kontext
- Automation-Kontext, falls Run

Volatile:
- MEMORY.md des aktiven Agenten
- USER.md vom Canvas Agent
- aktuelle Zeit
- Delivery-Ziele
- Heartbeat-/Run-Kontext
```

## Session-Logik

Sessions werden agent-spezifisch gespeichert:

```text
pi_sessions.agent_id = canvas-agent | <special-agent-id>
```

Channel-Zuordnung bleibt session-basiert:

```text
session_channel_links
  session_id
  user_id
  channel_id
  channel_session_key
  channel_thread_key
```

Damit kann eine Telegram-Session im Web sichtbar sein und umgekehrt. Die Historie bleibt aber immer an den Agenten gebunden, mit dem sie erstellt wurde.

## Automations

Jede Automation braucht kuenftig mindestens:

```text
agent_id
delivery_mode
delivery_channel_id
delivery_session_mode
delivery_session_id
delivery_channel_session_key
```

`agent_id` beantwortet: welcher Agent fuehrt den Job aus?

Delivery beantwortet separat: wohin geht das Ergebnis?

Geplante Delivery-Modi:

```text
web           Ergebnis in Web sichtbar machen
origin        Zurueck in den Chat/Thread, aus dem die Automation erstellt wurde
session       In eine konkrete bestehende Session schreiben
channel_home  In den Home-Chat eines Channels schreiben
silent        Nur speichern, nicht aktiv zustellen
```

Geplante Session-Zielmodi:

```text
new_session      neue Automation-Session erzeugen
channel_active   beim Run aktive Session des gewaehlten Channels aufloesen
fixed_session    immer in dieselbe Session schreiben
```

Default:

```text
agent_id = canvas-agent
delivery_mode = web
delivery_session_mode = new_session
```

## Telegram und Web

Wenn eine Automation in Telegram erstellt wird, bleibt die Session trotzdem im Web auffindbar, weil die Historie session-basiert gespeichert wird. Das Delivery-Ziel soll nicht automatisch Telegram sein, damit geplante Jobs Telegram nicht ungefragt zuspammen. Telegram-Delivery wird explizit gewaehlt, zum Beispiel spaeter ueber eine UI-Auswahl oder einen Command wie `--deliver here`.

## Settings UI

Die Agent-Konfiguration bleibt in den Settings, nicht als eigene Haupt-Route.

```text
Settings
  -> Agents
      Agent-Liste
        Canvas Agent
        Spezial-Agenten

      Detailbereich
        Uebersicht
        Prompt
        Modell
        Tools & Skills
        Memory
        Heartbeat
        Automations
        Channels
```

Die Automationen-App bleibt fuer Job-Management zustaendig, bekommt aber eine Agent-Auswahl und Delivery-Auswahl. Die Chat-UI bekommt eine Agent-Auswahl fuer neue Sessions und zeigt den Agenten bestehender Sessions an.

## Umsetzungsschritte

1. Erledigt: Agent-Datei-Storage ist auf `/data/agents/<agentId>/` abstrahiert.
2. Erledigt: Legacy-Pfad `/data/canvas-agent/` bleibt als Fallback/Migration fuer den Canvas Agent erhalten.
3. Erledigt: `loadManagedAgentSystemPrompt(agentId)` laedt den Prompt agent-spezifisch.
4. Erledigt: Automations haben `agent_id` und Delivery-Zielmodell.
5. Erledigt: Automation Runner laedt Prompt und Runtime-Kontext ueber `job.agentId`.
6. Erledigt: Agent-Settings-Komponenten sind gesplittet und arbeiten ueber den ausgewaehlten `agentId`.
7. Erledigt als Basis: Spezial-Agenten koennen in den Agent Settings angelegt, ausgewaehlt und entfernt werden; der Canvas Agent bleibt nicht entfernbar.

## Aktueller Umsetzungsstand

- Web-Chat und Telegram nutzen weiterhin den Canvas Agent als Standard-Agent.
- Sessions, PI-Persistenz, Automations und aktive Channel-Sessions sind agent-aware.
- Aktive Channel-Sessions sind pro Agent getrennt, damit spaeter mehrere Agenten im gleichen Channel-Kontext aktiv sein koennen.
- Spezial-Agenten erben User-Kontext vom Canvas Agent, besitzen aber eigene AGENTS.md, MEMORY.md, SOUL.md, TOOLS.md und HEARTBEAT.md.
- Vollstaendige Spezial-Agent-Konfiguration fuer Provider-/Model-Overrides, Toolsets, Skills und Composio-Scopes ist vorbereitet, aber bewusst noch nicht als eigener Detail-Editor ausgebaut.
