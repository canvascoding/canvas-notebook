# Agent Implementation Plan (Canvas Notebook) - Final v1 Spec

## Dokumentstatus
- Version: v1.0 (finalisierte Planfassung vor Umsetzung)
- Stand: 2026-03-05
- Geltungsbereich: Canvas Notebook (`canvasstudios-notebook`)

---

## 1) Zielbild (Final)

Wir bauen in v1 **einen einzigen Main-Agent-Workflow** für Canvas Notebook:

1. Es gibt keinen Sub-Agent-Mode und keine Multi-Agent-Orchestrierung.
2. Im Chat gibt es keine Agent-Auswahl mehr.
3. Ein globaler Main-Agent bleibt als Abstraktion konstant.
4. In Settings wird nur der **Provider** des Main-Agents gewechselt (z. B. Codex CLI vs. OpenRouter).
5. Sessions sind zentral, persistent und aktiv verwaltbar (neu, laden, umbenennen, löschen, Historie).
6. Agent-Dateien (`AGENTS.md`, `MEMORY.md`, `SOUL.md`, `TOOLS.md`) liegen persistent unter `/home/node/canvas-agent` und sind im UI editierbar.
7. Fehlende Agent-Dateien werden beim Container-Start idempotent angelegt.

---

## 2) Harte Produktentscheidungen (Locked)

1. **Single Main Agent only**  
   Keine Sub-Agent-Logik, kein Agent-Switcher im Chat.

2. **Provider wechselbar in Settings**  
   Main-Agent bleibt gleich, Provider ist konfigurierbar.

3. **Persistenzpfad für Agent-Systemdateien**  
   `/home/node/canvas-agent`

4. **Dateien im Agent-Verzeichnis**  
   `AGENTS.md`, `MEMORY.md`, `SOUL.md`, `TOOLS.md`

5. **Zentrale Runtime-Konfiguration**  
   `/home/node/canvas-agent/agent-runtime-config.json`

6. **Template-Erzeugung**  
   Beim Container-Start (EntryPoint), idempotent: nur anlegen, wenn Datei fehlt.

7. **Session-Logik**  
   Fokus auf Session-Management, keine Sub-Agent-Sitzungen.

8. **Session-Sichtbarkeit**  
   Global geteilt unter allen eingeloggten Nutzern.

9. **Session-Berechtigungen**  
   Alle eingeloggten Nutzer dürfen Sessions erstellen, umbenennen, löschen.

10. **Historie-Limit**  
    Maximal 200 Sessions (Retention-Cap).

11. **Provider-Wechsel und Sessions**  
    Provider wird pro Session fixiert; bestehende Sessions laufen mit ihrem ursprünglichen Provider weiter.

12. **Legacy-Logik**  
    Alte modellbasierte Session-Logik wird ersetzt; Legacy-Daten werden beim Rollout gelöscht.

13. **Auth-Gating**  
    Nicht eingeloggte Nutzer sehen nur Login; Home/Suite ist nicht mehr öffentlich zugänglich.

---

## 3) Ist-Zustand (Repo-relevant)

### Bereits vorhanden
- Agent-Katalog: `app/lib/agents/catalog.ts`
- Runtime-Resolver (env-basiert): `app/lib/agents/runtime.ts`
- Chat-Route: `app/api/chat/route.ts`
- Session-APIs: `app/api/sessions/route.ts`, `app/api/sessions/messages/route.ts`
- Integrations-Env-Mechanik: `app/lib/integrations/env-config.ts`, `app/api/integrations/env/route.ts`
- Docker EntryPoint: `scripts/docker-entrypoint.sh`
- Home und Settings Seiten: `app/page.tsx`, `app/settings/page.tsx`

### Hauptlücken
1. Runtime-Konfig kommt primär aus `process.env`.
2. Keine zentrale JSON-basierte Agent-Konfig unter `/home/node/canvas-agent`.
3. Keine verwalteten Agent-Dateien im Settings-UI.
4. Chat-UI enthält Mehr-Agent-Selector.
5. Session-API ist modellbasiert und nicht auf Single-Main-Agent optimiert.
6. `/` ist aktuell über Middleware als Public erlaubt.

---

## 4) Zielarchitektur (v1)

## 4.1 Agent Storage Layer (Dateisystem, zentral)

Verzeichnis:
- `/home/node/canvas-agent`

Dateien:
- `/home/node/canvas-agent/agent-runtime-config.json`
- `/home/node/canvas-agent/AGENTS.md`
- `/home/node/canvas-agent/MEMORY.md`
- `/home/node/canvas-agent/SOUL.md`
- `/home/node/canvas-agent/TOOLS.md`

Eigenschaften:
1. Persistenz über Docker Volume auf `/home/node`.
2. Atomare Schreibvorgänge für JSON/Markdown (`tmp + rename`).
3. Idempotentes Initialisieren beim Container-Start.

---

## 4.2 Runtime-Config JSON Schema (v1)

Beispielstruktur:

```json
{
  "version": 1,
  "mainAgent": "canvas-main-agent",
  "provider": {
    "id": "codex-cli",
    "kind": "cli"
  },
  "providers": {
    "codex-cli": {
      "enabled": true,
      "command": "codex"
    },
    "claude-cli": {
      "enabled": true,
      "command": "claude"
    },
    "gemini-cli": {
      "enabled": true,
      "command": "gemini"
    },
    "openrouter": {
      "enabled": true,
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "anthropic/claude-sonnet-4.5",
      "apiKeySource": "integrations-env"
    }
  },
  "doctor": {
    "enableLivePing": true,
    "timeoutMs": 2500
  },
  "updatedAt": "2026-03-05T12:00:00.000Z",
  "updatedBy": "user:<id-or-email>"
}
```

Hinweise:
1. `mainAgent` bleibt logisch konstant.
2. Aktiver Runtime-Pfad wird über `provider.id` bestimmt.
3. OpenRouter-Key liegt nicht im JSON-Klartext.
4. `updatedBy` wird aus Session-User gesetzt.

---

## 4.3 Provider-/Credential-Auflösung

OpenRouter-API-Key Reihenfolge:
1. Konfigurationshinweis aus `agent-runtime-config.json` (`apiKeySource`)
2. Integrations-Env (`INTEGRATIONS_ENV_PATH`)
3. Prozess-Env (`OPENROUTER_API_KEY`)

CLI-Command Reihenfolge:
1. `agent-runtime-config.json` command override
2. Fallback-Defaults (`codex`, `claude`, `gemini`)

---

## 4.4 Session-Modell (Single Main Agent)

Kernaussagen:
1. Session ist primäres Steuerobjekt.
2. Jede Session speichert beim Erstellen den aktiven Provider.
3. Resume nutzt immer den in der Session gespeicherten Provider.
4. Provider-Wechsel betrifft nur neu erstellte Sessions.

Datenhaltung:
- Bestehende Tabellen `ai_sessions`, `ai_messages` werden weiter genutzt.
- `ai_sessions.model` dient als gespeicherter Provider-Key.
- `ai_sessions.userId` bleibt Creator-Feld.

---

## 5) API-Design (Final)

## 5.1 Agent Config APIs

1. `GET /api/agents/config`
- Liefert sanitised runtime config + readiness.

2. `PUT /api/agents/config`
- Validiert und speichert zentrale JSON-Konfig.

3. `POST /api/agents/doctor`
- Lokale Checks:
  - CLI `command -v`
  - OpenRouter key verfügbar
  - Modellstring plausibel
- Optionaler Live-Ping (timeout, Warnung statt Hard-Fail).

---

## 5.2 Agent Files APIs

1. `GET /api/agents/files`
- Liefert Inhalte von `AGENTS.md`, `MEMORY.md`, `SOUL.md`, `TOOLS.md`.

2. `PUT /api/agents/files`
- Payload enthält Dateiname + neuen Inhalt.
- Nur erlaubte Dateinamen.
- Persistenter Write nach `/home/node/canvas-agent`.

---

## 5.3 Session APIs (ohne model-Query)

1. `GET /api/sessions`
- Globale Sessionliste, newest first.
- Enthält Creator-Info (Name/Email).

2. `POST /api/sessions`
- Explizite Session-Erstellung (leer oder optional initial title).

3. `PATCH /api/sessions`
- Session-Titel umbenennen.

4. `DELETE /api/sessions?sessionId=...`
- Löscht Session + zugehörige Messages.

5. `GET /api/sessions/messages?sessionId=...`
- Liefert Nachrichten einer Session, chronologisch.

---

## 5.4 Chat API

`POST /api/chat`:
1. Mit `sessionId`:
- Provider aus Session lesen und verwenden.
2. Ohne `sessionId`:
- Provider aus globaler Agent-Konfig verwenden.
- Bei Bedarf neue Session referenzieren.
3. Fehler explizit:
- Provider nicht verfügbar.
- OpenRouter key fehlt.
- CLI nicht installiert.

---

## 6) UI/UX Final

## 6.1 Home (`/`)
1. Login-gated.
2. Software Suite + Agent Setup Card sichtbar nur mit Session.
3. Agent Setup Card zeigt:
- Provider-Status
- Doctor-Status
- Shortcuts zu Settings.

## 6.2 Settings (`/settings`)
Neuer Tab „Agent Settings“:
1. Provider-Auswahl (global)
2. Provider-Konfiguration (CLI commands / OpenRouter model/base URL)
3. Doctor-Button + Ergebnisse
4. Editor für:
- `AGENTS.md`
- `MEMORY.md`
- `SOUL.md`
- `TOOLS.md`
5. Session-Management:
- Liste
- Umbenennen
- Löschen
- Neue Session erstellen

## 6.3 Chat UI
1. Kein Agent-Dropdown.
2. New Session Button bleibt.
3. Session-Historie bleibt.
4. Laden/Rename/Delete bleiben.
5. Provider-spezifische Sessionbindung bleibt transparent im Backend.

---

## 7) Container-Startup und Bootstrap

Ort:
- `scripts/docker-entrypoint.sh`

Ablauf:
1. Sicherstellen, dass `/home/node/canvas-agent` existiert.
2. Für jede Datei (`AGENTS.md`, `MEMORY.md`, `SOUL.md`, `TOOLS.md`):
- Wenn nicht vorhanden: mit Canvas-spezifischem Kurztemplate anlegen.
- Wenn vorhanden: unverändert lassen.
3. `agent-runtime-config.json` bei Fehlen mit Default erstellen.
4. Einmalige Legacy-Session-Cleanup-Logik ausführen (siehe Migration).
5. Danach normaler App-Start.

Warum nicht Build-Time:
- Volume-Mounts sind zur Build-Zeit nicht verfügbar.
- Existenzprüfung muss zur Laufzeit im Container erfolgen.

---

## 8) Migration / Legacy-Cutover

Ziel:
- Alte modellbasierte Historie entfernen, clean state für neue Single-Main-Agent-Logik.

Strategie:
1. Beim ersten Start nach Deployment:
- `DELETE FROM ai_messages`
- `DELETE FROM ai_sessions`
2. Markerdatei setzen, z. B.:
- `/home/node/canvas-agent/.legacy-session-wipe-done`
3. Wenn Marker existiert:
- Kein erneutes Löschen.

---

## 9) Sicherheit und Robustheit

1. Keine Secrets im Klartext in API-Responses oder Logs.
2. OpenRouter-Key masked ausgeben (`isSet`, optional letzte 4 Zeichen).
3. Dateiname-Whitelist für Agent-Dateien erzwingen.
4. Pfad-Traversal verhindern (nur fester Base-Dir).
5. Rate-Limit auf Config/File/Doctor APIs.
6. Klare Fehlermeldungen ohne Secret-Leaks.
7. Atomare Writes für Konfig und Markdown-Dateien.

---

## 10) Konkrete Implementierungsphasen

## Phase 1 - Storage + Bootstrap
- Neue Lib für Agent-Storage unter `app/lib/agents/`.
- Datei- und JSON-Store.
- Idempotente Initialisierung.
- EntryPoint um Bootstrap erweitern.

## Phase 2 - Runtime + APIs
- `runtime.ts` auf zentralen Store umstellen.
- Neue APIs:
  - `/api/agents/config`
  - `/api/agents/doctor`
  - `/api/agents/files`
- Session-APIs auf single-main-agent contracts umbauen.

## Phase 3 - Chat + Session-Verhalten
- `/api/chat` auf provider-pro-session binding umstellen.
- Explizite Session-Erstellung (`POST /api/sessions`).
- Rename/Delete/List finalisieren.
- Retention-Cap 200 implementieren.

## Phase 4 - UI
- Settings Tab „Agent Settings“ inkl. Datei-Editoren.
- Home Setup Card.
- Chat ohne Agent-Dropdown.
- Sessionliste mit Creator-Feld.
- Rename-Flow.

## Phase 5 - Auth/Gating + Cleanup
- Middleware/Public route policy für `/` anpassen.
- Legacy session wipe bei Deployment aktivieren.
- Regression-Fixes.

---

## 11) Testmatrix und Abnahmekriterien

## 11.1 API Tests
1. `GET/PUT /api/agents/config` liest/schreibt korrekt.
2. `GET/PUT /api/agents/files` funktioniert nur für erlaubte Namen.
3. `POST /api/agents/doctor` liefert lokale Checks + optionalen Ping.
4. `POST /api/sessions` erstellt Session explizit.
5. `PATCH /api/sessions` benennt um.
6. `DELETE /api/sessions` löscht Session + Messages.
7. `GET /api/sessions/messages` liefert chronologische Daten.
8. Retention hält max. 200 Sessions.

## 11.2 Session/Provider Tests
1. Session unter Provider A starten.
2. Global auf Provider B wechseln.
3. Gleiche Session laden/resume.
4. Erwartung: Session nutzt weiter Provider A.
5. Neue Session nutzt Provider B.

## 11.3 Startup/Persistenz Tests
1. Container mit leerem `/home/node` starten.
2. Erwartung: alle 5 Dateien angelegt.
3. Dateien im UI editieren.
4. Container neu starten.
5. Erwartung: Inhalte bleiben erhalten.
6. Erwartung: keine Überschreibung bestehender Dateien.

## 11.4 UI Tests
1. Kein Agent-Dropdown im Chat.
2. Session erstellen/laden/umbenennen/löschen funktioniert.
3. Settings zeigt Agent-Tab und Editoren.
4. Nicht eingeloggte Nutzer landen auf Login statt Suite/Home.

---

## 12) Nicht-Ziele (v1, bewusst ausgeschlossen)

1. Sub-Agenten
2. Multi-Agent-Orchestrierung
3. Kanal-/User-spezifische Tool-Permissions-Matrix
4. Provider-übergreifende Session-Kompatibilität
5. OAuth-Provider-Setup-Flows
6. Vollständige Historien-Migration alter modellbasierter Sessions

---

## 13) Offene technische Defaults (gesetzt)

1. Agent-Basisordner: `/home/node/canvas-agent`
2. Retention: 200 Sessions
3. Doctor Live Ping: optional, timeout-basiert
4. Alle eingeloggten User dürfen Agent-Settings/Files/Sessions bearbeiten
5. Legacy-Sessiondaten werden einmalig gelöscht

---

## 14) Ergebnisdefinition (Definition of Done)

Das Feature gilt als fertig, wenn:

1. Das gesamte Agent-System über zentrale Dateien in `/home/node/canvas-agent` betrieben wird.
2. Chat nur noch Main-Agent-Workflow zeigt (kein Agent-Switch im Chat).
3. Provider-Wechsel in Settings möglich ist.
4. Sessions vollständig verwaltbar sind (create/load/rename/delete/history).
5. Provider pro Session stabil gebunden ist.
6. Home/Suite nur nach Login erreichbar ist.
7. Startup-Templates und Config idempotent angelegt werden.
8. Legacy-Datenbereinigung einmalig und nachvollziehbar ausgeführt wurde.
9. Tests für kritische Pfade bestehen.
