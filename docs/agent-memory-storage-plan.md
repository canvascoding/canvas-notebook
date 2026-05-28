# Agent Memory And Storage Plan

## Ausgangslage

Das persistente Agent Memory ist fachlich vom Session Compacting getrennt:

- `MEMORY.md` und `USER.md` sind dauerhafte Prompt-Dateien.
- `pi_sessions.summary_text` ist nur eine komprimierte Zusammenfassung fuer eine einzelne PI-Session.
- `session_search` wird separat als Tool implementiert und ist nicht Teil dieses Plans.

Der aktuelle Code ist beim Speicherort noch inkonsistent:

- Die neuere Agent-Datei-Logik nutzt bereits `/data/agents/<agentId>/`.
- Fuer den Canvas Main Agent existiert weiterhin ein Legacy-Fallback auf `/data/canvas-agent`.
- Der Bootstrap schreibt Seed-Dateien noch nach `/data/canvas-agent`.
- Seed Prompts und Tool-Beschreibungen nennen ebenfalls noch den alten Pfad.

Ziel ist, alle Agent Prompt Files kanonisch unter `/data/agents/<agentId>/` zu fuehren, auch den Main Agent:

```text
/data/agents/canvas-agent/AGENTS.md
/data/agents/canvas-agent/IDENTITY.md
/data/agents/canvas-agent/USER.md
/data/agents/canvas-agent/MEMORY.md
/data/agents/canvas-agent/SOUL.md
/data/agents/canvas-agent/TOOLS.md
/data/agents/canvas-agent/HEARTBEAT.md
/data/agents/<special-agent>/MEMORY.md
```

Runtime- und Integrationsdateien wie `pi-runtime-config.json`, `mcp.json`, `auth.json` und `mcp-oauth/` koennen zunaechst unter `/data/canvas-agent` bleiben. Diese Dateien sind keine Agent Prompt Files und sollten nur in einem separaten Task migriert werden.

## Plan

### 1. Agent-Storage bereinigen

Dateien:

- `app/lib/agents/storage.ts`
- `app/lib/runtime-data-paths.ts`

Aenderungen:

- `/data/agents/<agentId>/` als kanonischen Pfad fuer alle Managed Prompt Files behandeln.
- `/data/canvas-agent/*.md` nur noch als Migrationsquelle fuer den Canvas Agent lesen.
- Wenn Legacy-Inhalt existiert und `/data/agents/canvas-agent/<file>` fehlt oder leer ist, den Inhalt in den neuen Pfad kopieren.
- Danach soll die Runtime aus `/data/agents/canvas-agent` lesen.
- Spezial-Agenten behalten eigene Dateien unter `/data/agents/<agentId>/`.
- Spezial-Agenten erben weiterhin `IDENTITY.md` und `USER.md` vom Canvas Agent.

### 2. Bootstrap korrigieren

Datei:

- `scripts/bootstrap-agent-runtime.ts`

Aenderungen:

- `AGENTS_STORAGE_ROOT = /data/agents` ergaenzen.
- `CANVAS_AGENT_STORAGE_DIR = /data/agents/canvas-agent` ergaenzen.
- Managed Prompt Files nicht mehr nach `/data/canvas-agent`, sondern nach `/data/agents/canvas-agent` schreiben.
- Migrationen:
  - `/home/node/canvas-agent/*.md` -> `/data/agents/canvas-agent/*.md`
  - `/data/canvas-agent/*.md` -> `/data/agents/canvas-agent/*.md`, falls das Ziel fehlt oder leer ist
- Legacy Runtime Configs weiter nach `/data/canvas-agent` migrieren, solange der Rest der App sie dort erwartet.

### 3. Systemprompt-Quellen korrigieren

Datei:

- `app/lib/agents/system-prompt-shared.ts`

Aenderungen:

- Source-Pfade fuer `canvas-agent` auf `/data/agents/canvas-agent/<file>` setzen.
- Source-Pfade fuer Spezial-Agenten auf `/data/agents/<agentId>/<file>` setzen.
- Geerbte Dateien bei Spezial-Agenten sollen als Quelle `/data/agents/canvas-agent/<file>` zeigen.

### 4. Seed Prompts aktualisieren

Dateien:

- `seed_sys_prompts/AGENTS.md`
- `seed_sys_prompts/BOOTSTRAP.md`
- optional `seed_sys_prompts/MEMORY.md`
- optional `seed_sys_prompts/USER.md`

Aenderungen in `AGENTS.md`:

- Alte Hinweise auf `/data/canvas-agent` durch `/data/agents/<active-agent-id>` und `/data/agents/canvas-agent` ersetzen.
- Memory-Regeln schaerfen:
  - `MEMORY.md` enthaelt dauerhafte agentenspezifische Fakten.
  - `USER.md` enthaelt dauerhafte Nutzerpraeferenzen und Nutzerprofil.
  - Session Summaries und Compacting-Inhalte werden nicht automatisch in Memory uebernommen.
  - Keine Secrets, Logs, transienten Aufgaben oder grosse Tool-Ausgaben speichern.
  - Memory klein, kuratiert und dedupliziert halten.
- Wenn ein dediziertes `memory` Tool verfuegbar ist, soll der Agent dieses bevorzugen statt direktem `write`.

Aenderungen in `BOOTSTRAP.md`:

- Pfade auf `/data/agents/canvas-agent` aendern.
- Produktiver formulieren und weniger spielerisch halten.
- Nicht mehr suggerieren, dass Memory-Dateien fehlen muessen; sie werden gebootstrappt.

### 5. Tool-Hinweise korrigieren

Datei:

- `app/lib/pi/tool-registry.ts`

Aenderungen:

- Tool-Beschreibungen und Kommentare von `/data/canvas-agent` auf `/data/agents/canvas-agent` aktualisieren, soweit sie Managed Prompt Files betreffen.
- Pruefen, dass Agent-Tools `/data/agents` lesen und schreiben duerfen.
- `/data/secrets` bleibt gesperrt.

### 6. Dediziertes Memory-Tool bauen

Neue Datei:

- `app/lib/agents/memory-store.ts`

Ziel:

Das persistente Memory soll nicht mehr ueber generische File Writes gepflegt werden muessen, sondern ueber eine kontrollierte Schicht.

API-Skizze:

```ts
readMemory({ agentId, target })
addMemory({ agentId, target, content, reason })
updateMemory({ agentId, target, id, content })
deleteMemory({ agentId, target, id })
```

Targets:

- `target: "agent"` -> `/data/agents/<agentId>/MEMORY.md`
- `target: "user"` -> `/data/agents/canvas-agent/USER.md`

Regeln:

- atomische Writes
- Groessenlimit
- einfache Secret-Erkennung
- keine leeren Eintraege
- keine offensichtlichen Duplikate
- stabiles, parsebares Markdown-Format

### 7. PI Memory Tool anschliessen

Datei:

- `app/lib/pi/tool-registry.ts`

Neues Tool:

```ts
memory({
  action: "read" | "add" | "update" | "delete",
  target: "agent" | "user",
  id?: string,
  content?: string,
  reason?: string
})
```

Verhalten:

- Agenten nutzen dieses Tool fuer dauerhafte Erinnerungen.
- Direkter `write` auf Agent-Dateien bleibt technisch moeglich, wird aber nicht empfohlen.
- Das Tool schreibt nie in `pi_sessions.summary_text`.

### 8. Compacting getrennt halten

Keine automatische Uebernahme von `summaryText` in `MEMORY.md`.

`summaryText` bleibt Session Compacting. Persistentes Memory bleibt `MEMORY.md` und `USER.md`.

Ein optionaler spaeterer Memory-Review nach Assistant-Turns kann auf dem Memory Tool aufbauen, sollte aber nicht Teil des Compacting-Pfads werden.

### 9. Tests

Anpassen:

- `scripts/prompt-builder-test.ts`
  - Source-Pfade auf `/data/agents/canvas-agent/...` umstellen.
- `scripts/agent-runtime-config-test.ts`
  - pruefen, dass Main-Agent-Dateien unter `/data/agents/canvas-agent` landen.
  - pruefen, dass Spezial-Agenten `USER.md` erben und eigenes `MEMORY.md` besitzen.

Neu:

- `scripts/agent-memory-store-test.ts`
  - `read`
  - `add`
  - `update`
  - `delete`
  - Groessenlimit
  - Secret-Block
  - Trennung `target: "agent"` vs. `target: "user"`

Optional:

- Bootstrap-Test fuer Migration von `/data/canvas-agent/*.md` nach `/data/agents/canvas-agent/*.md`.

### 10. Verifikation

Nach der Umsetzung:

```bash
npm run test:pi:summary
npm run test:agent:memory
npm run lint
npm run build
```

Kein Container-Build, solange er nicht explizit angefordert wird.

## Reihenfolge

1. Storage- und Bootstrap-Pfade konsistent machen.
2. Seed Prompts und Tool-Hinweise aktualisieren.
3. Tests fuer Storage und Prompt-Quellen anpassen.
4. Memory Store implementieren.
5. PI `memory` Tool anschliessen.
6. Tests ausfuehren.
7. Sauberen Commit erstellen, ohne fremde Session-Search-Aenderungen zu stage'n.
