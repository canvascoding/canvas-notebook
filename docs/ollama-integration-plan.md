# Ollama Integration Plan (Canvas Notebook) - Final v1

## Dokumentstatus
- Version: v1.0 (final)
- Stand: 2026-03-05
- Scope: Canvas Notebook (`canvasstudios-notebook`)

## 1) Zielbild (final)

Wir betreiben den Main-Agent-Workflow mit vier Providern im zentralen Agent-Runtime-Setup:
- `codex-cli`
- `claude-cli`
- `openrouter`
- `ollama`

`gemini-cli` ist aus dem Main-Agent-Provider-Flow entfernt.

Ollama wird nativ ueber `/api/chat` integriert (kein OpenAI-kompatibler `/v1/chat/completions`-Pfad).
Zusatzanforderung: Die `ollama` CLI muss im App-Container verfuegbar sein, damit sie im Container-Terminal direkt aufrufbar ist.

## 2) Ist-Zustand vor Umsetzung

Vor der Umsetzung war der Main-Agent-Stack auf `codex-cli`, `claude-cli`, `gemini-cli`, `openrouter` ausgelegt.
- Kein `ollama` Provider in Runtime/Storage/UI.
- Keine native Ollama-Streaming-Implementierung in `POST /api/chat`.
- Kein Ollama-Check in Doctor.
- Keine Ollama-CLI-Installation im Container.

## 3) Finale Produktentscheidungen (locked)

1. `gemini-cli` wird aus dem Main-Agent-Provider-Flow entfernt.
2. `ollama` wird als eigener Provider-Typ aufgenommen.
3. Chat fuer `ollama` nutzt die native Ollama API: `POST {baseUrl}/api/chat` mit Streaming.
4. `baseUrl` fuer Ollama wird normalisiert (Trailing Slash entfernen, optionales `/v1` entfernen).
5. Ollama API-Key bleibt optional:
- `apiKeySource: none | integrations-env | process-env`
- `none` ist der Default fuer lokale Instanzen.
6. Doctor prueft Ollama zusaetzlich per optionalem Live-Ping auf `/api/tags`.
7. Container stellt `ollama` CLI bereit (auto-installierbar beim Start).

## 4) Implementiertes Design

### 4.1 Provider-/Storage-Modell

In `app/lib/agents/storage.ts`:
- `AgentProviderId`: `codex-cli | claude-cli | openrouter | ollama`
- `AgentProviderKind`: `cli | openrouter | ollama`
- Neuer Provider-Block:

```json
"ollama": {
  "enabled": true,
  "baseUrl": "http://127.0.0.1:11434",
  "model": "llama3.2:3b",
  "apiKeySource": "none"
}
```

- `gemini-cli` wurde entfernt.
- Legacy-Fallback bleibt robust:
- `gemini` / `gemini-cli` Alias mappt auf `codex-cli`.

### 4.2 Runtime-Resolver

In `app/lib/agents/runtime.ts`:
- Neuer Runtime-Typ `kind: 'ollama'`.
- `getAgentRuntime()` kann jetzt `ollama` aufloesen.
- `gemini` Alias wird nur noch als Legacy-Eingabe auf `codex` gemappt.

### 4.3 Chat-Route (`POST /api/chat`)

In `app/api/chat/route.ts`:
- Neuer Ollama-Runtime-Pfad.
- Request an `POST {ollamaBase}/api/chat` mit `stream: true`.
- Streaming-Parser fuer NDJSON-Events implementiert.
- Text-Chunks aus `message.content` werden fortlaufend an den Client gestreamt.
- Persistenz (`ai_sessions`, `ai_messages`) bleibt gleich.
- Attachments fuer `openrouter` und `ollama` sind aktuell explizit als text-only blockiert.

### 4.4 Doctor

In `app/api/agents/doctor/route.ts`:
- OpenRouter Live-Ping bleibt.
- Neuer Ollama Live-Ping auf `{baseUrl}/api/tags`.
- Optionaler Bearer-Header bei vorhandenem Ollama-Key.
- Checks enthalten jetzt auch Ollama-Key-/Model-Status.

### 4.5 Settings UI

In `app/components/settings/AgentSettingsPanel.tsx`:
- `gemini-cli` aus Auswahl und Config-Feldern entfernt.
- `ollama` im Provider-Dropdown hinzugefuegt.
- Neue Felder:
- `Ollama Base URL`
- `Ollama Model`
- `Ollama Key Source` (`none`, `integrations-env`, `process-env`)
- `Ollama enabled`
- Doctor-Anzeige erweitert auf OpenRouter- und Ollama-Ping-Warnungen.

### 4.6 Bootstrap Defaults

In `scripts/bootstrap-agent-runtime.ts`:
- Default-Config enthaelt jetzt `ollama`.
- `gemini-cli` Default wurde entfernt.

## 5) Container-Integration (CLI-Verfuegbarkeit)

### 5.1 EntryPoint

In `scripts/docker-entrypoint.sh`:
- Neuer Schalter `OLLAMA_CLI_AUTO_INSTALL` (Default: `true`).
- Wenn `ollama` nicht vorhanden ist:
- Download von `https://ollama.com/install.sh`
- Installation mit `OLLAMA_NO_START=1`
- Danach ist `ollama` im Container-CLI verfuegbar.

### 5.2 Dockerfile / Compose / Env

- `Dockerfile`: `curl` + `zstd` im Runner-Image installiert (Voraussetzung fuer Ollama-Installscript).
- `compose.yaml`: `OLLAMA_CLI_AUTO_INSTALL: "true"` gesetzt.
- `.env.example`: `OLLAMA_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_CLI_AUTO_INSTALL` dokumentiert.
- `README.md`: CLI-Auto-Install-Doku auf Codex + Claude + Ollama aktualisiert.

## 6) Verifikation (finale Testschritte)

1. To-do-Sync ausfuehren:
```bash
npm run todos:sync:agent
```
2. Sicherstellen, dass kein alter Test-Container laeuft:
```bash
docker compose down --remove-orphans
```
3. Container frisch neu bauen/starten (Port 3000):
```bash
docker compose up -d --build --force-recreate
```
4. Login in der App:
- Email: `admin.com`
- Passwort: `change-me`
5. Settings -> Agent Settings:
- Provider `ollama` waehlbar
- Base URL + Model speicherbar
- Doctor zeigt Ollama-Checks
6. Chat-Test mit aktivem `ollama` Provider:
- Streaming-Antwort kommt
- Session wird persistiert
7. Container-CLI-Test:
```bash
docker compose exec canvas-notebook ollama --version
```
8. Nach Abschluss To-do-Sync erneut:
```bash
npm run todos:sync:agent
```

## 7) Definition of Done

Die Ollama-Integration gilt als final, wenn:
- `gemini-cli` nicht mehr im Main-Agent-Provider-Flow sichtbar ist.
- `ollama` in Settings konfigurierbar und als aktiver Provider nutzbar ist.
- `POST /api/chat` fuer Ollama stabil streamt.
- Doctor fuer Ollama verwertbare Readiness- und Ping-Infos liefert.
- `ollama` als CLI im Container aufrufbar ist.
- Doku/Env/Compose konsistent aktualisiert sind.
