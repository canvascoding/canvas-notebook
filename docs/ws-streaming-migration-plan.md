# WebSocket Streaming Migration Plan

## Aktueller Stand (2026-05-02)

Die produktive Chat-Runtime ist auf WebSocket-Requests umgestellt. Der alte interne HTTP-Loopback aus dem WebSocket-Pfad ist entfernt. Die HTTP-Routen `/api/stream`, `/api/stream/status` und `/api/stream/control` sind nach der WS-Umstellung gelöscht.

Umgesetzte Commits:

- `bc6bc45` — Runtime-Service extrahiert und HTTP-Kompatibilitätsrouten darauf umgestellt.
- `6f01661` — WS-Protokoll mit Request-IDs und Result-Messages eingeführt.
- `555985a` — Chat-Frontend nutzt WS-Requests für Send, Control und Status.
- `cca353e` — alter SSE-Frontendpfad entfernt.
- `0cf794d` — HTTP-Loopback-Bridge entfernt.
- `0fa09ad` — PI-Integrationstest auf echten WebSocket-Client umgestellt.
- `e34545b` — `server-only` Imports im Custom-Server abgefangen.
- `fe3ae55` — Runtime-Service im WS-Server dynamisch geladen.
- `ea75e0c` — WS-Server im Custom-Server per ESM-Import geladen.
- `ebd3fa0` — ESM/CJS Export-Interop des WS-Server-Moduls robust gemacht.
- `4a1f99a` — `@mariozechner/pi-ai` Exporte im Custom-Server auf `dist/*.js` aliasiert, damit Runtime-Service im WS-Pfad lädt.
- `9588538` — WS-Client behandelt Result-Messages ohne pending Request als kompatible Fire-and-forget-Antworten.

Verifiziert:

- `npm run build` erfolgreich nach jedem Umsetzungsblock.
- `npm run lint` erfolgreich nach jedem Umsetzungsblock.
- `node --check scripts/pi-integration-test.mjs` erfolgreich.
- Manueller Befund nach `4a1f99a`: WS-Auth, Session-Subscribe, `send_message`, Runtime-Start und Agent-Events laufen serverseitig.

Noch offen:

- Manuelle UI-Prüfung fortsetzen: Stop, Steer, Replace, Session-Wechsel, Reload/Reconnect.
- Dev-Server prüfen, dass die Browser-Warnung `Unknown message type: subscribe_result` verschwunden ist (behoben durch auth-aware connect und Subscribe-Ack im UI).

## Problem

Die aktuelle Architektur hat zwei parallele Streaming-Pfade:

1. **Direkter SSE-Pfad**: Frontend → `POST /api/stream` → ReadableStream (SSE)
2. **WebSocket-Pfad**: Frontend → WS `send_message` → `sendMessageViaRuntime()` → `fetch('http://127.0.0.1:3000/api/stream')` → Loopback-HTTP

Der WebSocket-Pfad ist kein eigenständiges Streaming — er ruft intern wieder den HTTP-Endpunkt auf. Das erzeugt:
- **HTTP-Loopback** (`chat-event-bridge.ts:206`): Der WS-Server macht einen `fetch()` an sich selbst
- **Retry-Logik** für interne Calls die nicht nötig wäre
- **Doppel-Verarbeitung** im Frontend: SSE-Listener + `agent_event` CustomEvent-Listener mit komplexer `streamSessionRef`-Logik
- **Zwei Auth-Pfade** im `/api/stream`-Endpoint: Session-Auth vs. Internal-Token-Auth

## Ziel-Architektur

```
Frontend (CanvasAgentChat)
  │
  ├─ WebSocket (einziger real-time Transport nach Abschluss der Migration)
  │     ├─ subscribe        → subscribe_result, danach agent_event
  │     ├─ send_message     → send_message_result + Events via WS
  │     ├─ control          → control_result
  │     ├─ get_status       → status_result
  │     ├─ unsubscribe
  │     └─ agent_event      → UI Updates (empfangen)
  │
  └─ HTTP API (nur CRUD, kein Streaming)
        ├─ POST   /api/sessions        (Session erstellen)
        ├─ GET    /api/sessions        (Session-Liste)
        ├─ GET    /api/sessions/:id   (Session-Details)
        └─ GET    /api/history/:id    (Nachrichten-Historie)
```

### Was fällt weg:
- `POST /api/stream` (route.ts) — erst nach erfolgreicher WS-Migration entfernt
- `GET /api/stream/status` (status/route.ts) — erst nach erfolgreicher WS-Migration entfernt
- `POST /api/stream/control` (control/route.ts) — erst nach erfolgreicher WS-Migration entfernt
- `sendMessageViaRuntime()` in `chat-event-bridge.ts` — kein Loopback-HTTP mehr
- `streamSessionRef` / SSE-Doppel-Listener-Logik im Frontend

### Was bleibt:
- HTTP-Endpunkte für CRUD-Operationen (Sessions, Historie)
- `initializeWebSocketBridge()` — broadcastet Events an andere WS-Clients
- `live-runtime.ts` — die PI Runtime-Logik bleibt bestehen, wird nur von Service-Schicht aufgerufen statt von HTTP-Route
- Übergangsweise bleiben die HTTP-Streaming-Endpunkte als Kompatibilitäts-/Fallback-Schicht erhalten, rufen aber denselben `runtime-service` auf. Sie werden erst gelöscht, wenn Frontend, Tests und WS-Integration vollständig umgestellt sind.

---

## Migration ToDos

### Phase 1: Service-Schicht extrahieren

- [x] **1.1** `app/lib/pi/runtime-service.ts` erstellen
  - Funktion `sendMessage(sessionId, userId, message, context)`: Extrahiert die Runtime-Start-Logik aus `app/api/stream/route.ts`
  - Funktion `control(sessionId, userId, action, message?)`: Extrahiert die Logik aus `app/api/stream/control/route.ts:25-90`
  - Funktion `getStatus(sessionId, userId)`: Wrapper für `getPiRuntimeStatus()`
  - Alle drei Funktionen rufen direkt `getOrCreatePiRuntime()` / `getPiRuntimeStatus()` auf — kein HTTP mehr
  - Studio-Image-Injection-Logik aus `route.ts:114-199` wandert in eine Hilfsfunktion im Service
  - Der Service setzt weiterhin alle Prompt-Kontexte: Timezone, Active File, Planning Mode, Page Context und Studio Context
  - Der Service liefert bei `sendMessage()` ein synchrones Ergebnis zurück, ob der Prompt-Start akzeptiert wurde

- [x] **1.2** Validierung extrahieren
  - `isValidUserMessage()`, `resolvePromptMessage()` aus `route.ts` → `runtime-service.ts` oder `app/lib/chat/validation.ts`
  - `isUserMessage()` aus `control/route.ts` → gleiche Datei, vereinfachen zu einer einzigen Validierungs-Funktion

- [x] **1.3** HTTP-Routen auf Service umstellen, aber noch nicht löschen
  - `POST /api/stream` nutzt `runtime-service.sendMessage()` und behält vorerst die bestehende ReadableStream-Response
  - `POST /api/stream/control` nutzt `runtime-service.control()`
  - `GET /api/stream/status` nutzt `runtime-service.getStatus()`
  - Ziel: Service-Extraktion ist verifizierbar, ohne dass Frontend und Tests sofort brechen

- [x] **1.4** Autorisierung zentralisieren
  - Gemeinsame Helper für Session-Ownership einführen
  - `subscribe`, `control` und `get_status` dürfen nur bestehende Sessions des angemeldeten Users bedienen
  - `send_message` darf neue Sessions nur im definierten Create-Flow akzeptieren; fremde bestehende Sessions bleiben verboten

- [x] **1.5** Rate-Limits für WS-Pfad vorbereiten
  - HTTP-Rate-Limits fallen nach dem Löschen der Routen weg
  - WS-seitig per User/Session begrenzen: `send_message`, `control`, `get_status`

### Phase 2: WebSocket-Handler auf Service umstellen

- [x] **2.1** `server/websocket-server.ts`: `send_message`-Handler umstellen
  - Statt `sendMessageViaRuntime()` → direkt `runtimeService.sendMessage()` aufrufen
  - Kein `fetch()`-Aufruf mehr, kein Retry-Logic
  - Antwortet immer mit `{ type: 'send_message_result', requestId, success, status?, error? }`
  - UI kann dadurch optimistische User-Messages bei Startfehlern sauber auf `error` setzen

- [x] **2.2** `subscribe_session` mit Ack versehen
  - Payload: `{ type: 'subscribe_session', requestId, sessionId }`
  - Response: `{ type: 'subscribe_result', requestId, success, sessionId, error? }`
  - `send_message` darf erst nach erfolgreichem Subscribe-Ack gesendet werden
  - Alternative: `send_message` subscribed serverseitig automatisch auf die Session, bevor `runtimeService.sendMessage()` startet
  - Wichtig: Keine frühen `runtime_status`, `message_start` oder Tool-Events verlieren

- [x] **2.3** Neuen WS-Message-Typ `control` hinzufügen
  - Payload: `{ type: 'control', sessionId, action, message? }`
  - Ruft `runtimeService.control()` auf
  - Sendet Ergebnis als WS-Response: `{ type: 'control_result', success, status?, error? }`

- [x] **2.4** Neuen WS-Message-Typ `get_status` hinzufügen
  - Payload: `{ type: 'get_status', sessionId }`
  - Ruft `runtimeService.getStatus()` auf
  - Sendet Ergebnis als WS-Response: `{ type: 'status_result', success, status?, error? }`

- [x] **2.5** Runtime-Lifecycle über WS vollständig abbilden
  - Nach `send_message` direkt aktuellen `runtime_status` senden oder sicherstellen, dass `runtime-service` ihn über Events publiziert
  - Idle-Endstatus zuverlässig an aktive Subscriber senden
  - `replace` / `pendingReplace` darf nicht als endgültiges Ende interpretiert werden
  - Reconnect-Client kann über `get_status` den aktuellen Runtime-Zustand rekonstruieren

### Phase 3: Frontend auf WebSocket umstellen

- [x] **3.1** CanvasAgentChat.tsx: `fetch('/api/stream')` ersetzen
  - Statt HTTP-POST + ReadableStream: `wsRequest('send_message', { sessionId, message, context })`
  - Events kommen bereits über den `agent_event`-Listener an
  - Optimistische User-Message erst endgültig als `sent` markieren, wenn `send_message_result.success === true`
  - Bei `send_message_result.success === false` optimistische Message auf `error` setzen und Systemfehler anzeigen
  - `streamAbortRef` / `streamSessionRef` entfernen, sobald keine SSE-Verbindung mehr existiert

- [x] **3.2** CanvasAgentChat.tsx: `fetch('/api/stream/control')` ersetzen
  - Statt HTTP-POST: `wsRequest('control', { sessionId, action, message? })`
  - Warten auf `control_result` WS-Response (Promise-basiert mit Request-ID)

- [x] **3.3** CanvasAgentChat.tsx: `fetch('/api/stream/status')` ersetzen
  - Statt HTTP-GET: `wsRequest('get_status', { sessionId })`
  - Warten auf `status_result` WS-Response
  - Bei Reconnect / Timeout klare UI-Fehlermeldung und Status-Sync erneut versuchen

- [x] **3.4** SSE-Doppel-Listener-Logik entfernen
  - `streamSessionRef` und der "Skip wenn SSE aktiv"-Check in Zeile 1832 entfernen
  - Alle Events kommen einheitlich über WS `agent_event`
  - `handleStreamEvent` bleibt, aber wird nur noch vom WS-Listener aufgerufen

- [x] **3.5** Subscribe-Reihenfolge absichern
  - Beim Laden oder Erstellen einer Session erst `subscribe_session` per Request/Ack abschließen
  - Danach erst `send_message` oder `get_status`
  - Bei Session-Wechsel alte Session unsubscriben, neue Session subscriben, dann Status laden

- [x] **3.6** Pending-Requests bei Disconnect aufräumen
  - Alle offenen `wsRequest()` Promises bei Disconnect entweder rejecten oder nach Reconnect gezielt neu ausführen
  - Keine `send_message` Requests automatisch replayen, wenn unklar ist, ob der Server sie bereits gestartet hat
  - `get_status` darf nach Reconnect neu versucht werden

### Phase 4: Übergangsprüfung ohne HTTP-Loopback

- [x] **4.1** Sicherstellen, dass `sendMessageViaRuntime()` nicht mehr genutzt wird
  - `server/websocket-server.ts` nutzt direkt `runtime-service`
  - Kein interner `fetch('http://127.0.0.1:3000/api/stream')` mehr

- [x] **4.2** Alle Frontend-Aufrufer von `/api/stream*` entfernen
  - `rg "/api/stream"` muss keine produktiven UI-Aufrufer mehr finden
  - Test-Mocks danach auf WS-Protokoll umstellen

- [x] **4.3** HTTP-Routen temporär als Fallback lassen
  - Erst nach erfolgreichen WS-Integrationstests löschen
  - Falls in dieser Phase Fehler auftreten, kann die UI kurzfristig zurück auf HTTP gestellt werden

### Phase 5: HTTP-Endpunkte entfernen

- [x] **5.1** `app/api/stream/route.ts` löschen
- [x] **5.2** `app/api/stream/status/route.ts` löschen
- [x] **5.3** `app/api/stream/control/route.ts` löschen
- [x] **5.4** `app/api/stream/` Ordner entfernen (sollte dann leer sein)

### Phase 6: Chat-Event-Bridge aufräumen

- [x] **6.1** `sendMessageViaRuntime()` aus `server/chat-event-bridge.ts` entfernen
  - Wird nicht mehr gebraucht, da WS-Handler den Service direkt aufruft
- [x] **6.2** `initializeWebSocketBridge()` bleibt bestehen
  - Broadcastet weiterhin Events an andere WS-Clients

### Phase 7: Request-Response-Korrelation für WS

- [x] **7.1** Request-ID-System für WS-Nachrichten
  - Jede WS-Nachricht die eine Response erwartet bekommt ein `requestId`-Feld
  - Frontend mappt `requestId` → Promise-Resolver
  - Wird gebraucht für `subscribe_result`, `send_message_result`, `control_result` und `status_result`
  - Implementierung: Map<string, { resolve, reject }> im WS-Client-Wrapper

- [x] **7.2** WS-Client-Wrapper im Frontend
  - Statt rohe `ws.send()`-Aufrufe: wrapper-Funktion `wsRequest(type, payload)` die ein Promise zurückgibt
  - Timeout-Handling (z.B. 10s) für nicht beantwortete Requests
  - Pending Requests bei Disconnect bereinigen
  - `send_message` nicht blind nach Reconnect replayen

### Phase 8: Tests aktualisieren

- [x] **8.1** Playwright-Tests `tests/pi-chat.spec.ts`
  - Alle `page.route('**/api/stream', ...)`  entfernen
  - Stattdessen WS-Messages mocken/abfangen
  - `page.route('**/api/stream/status', ...)`  und `page.route('**/api/stream/control', ...)` ebenfalls migrieren
  - Hinweis: Playwright-WS-Mocking ist schwieriger als HTTP-Routing; wenn Mocking zu fragil wird, echte WS-Integrationstests priorisieren

- [x] **8.2** Integration-Tests `scripts/pi-integration-test.mjs`
  - HTTP-Tests für `/api/stream` entfernen
  - Neue WS-basierte Tests für `subscribe_session`, `send_message`, `control`, `get_status`
  - Auth success/failure testen
  - Reconnect während aktiver Runtime testen
  - Fehlerfälle testen: fremde Session, fehlende Session, invalid role, compact während Streaming

- [ ] **8.3** Manuelle UI-Prüfung (noch durchzuführen)
  - Neue Session erstellen und erste Antwort streamen
  - Laufende Antwort stoppen
  - Follow-up/Steer/Replace während aktiver Runtime testen
  - Session wechseln während Runtime läuft und zurückwechseln
  - Browser-Reload/Reconnect während Runtime läuft
  - Studio-Kontext mit aktivem Output-Bild testen

### Phase 9: Dokumentation & Aufräum

- [x] **9.1** `CLAUDE.md` / Migrationsplan aktualisieren — Streaming-Abschnitt auf WS-Architektur umgeschrieben
- [x] **9.2** `app/lib/chat/types.ts` — Kommentar "Used uniformly across SSE and WS path" aktualisieren
- [x] **9.3** Verwaiste Imports bereinigen — `isValidCanvasInternalToken` wird noch von Automations-Routen genutzt; Stream-Route-Imports mit gelöscht

---

## Technische Details

### runtime-service.ts — API-Design

```typescript
// app/lib/pi/runtime-service.ts

export async function sendMessage(
  sessionId: string,
  userId: string,
  message: Extract<AgentMessage, { role: 'user' }> | null,
  context?: ChatRequestContext
): Promise<PiRuntimeStatus> {
  const runtimeInstance = await getOrCreatePiRuntime(sessionId, userId);
  
  // Image injection, timezone, active file, planning mode, page context
  // (extracted from current route.ts logic)
  
  const resolvedMessage = await injectStudioImage(message, context);
  setTimezoneContext(runtimeInstance, context);
  runtimeInstance.setActiveFileContext(context?.activeFilePath ?? null);
  runtimeInstance.setPlanningMode(context?.planningMode === true);
  runtimeInstance.setPageContext(context?.currentPage);
  
  // Events are broadcasted via runtime-event-emitter → WebSocket Bridge
  if (resolvedMessage) {
    runtimeInstance.startPrompt(resolvedMessage);
  }

  return runtimeInstance.getStatus();
}

export async function control(
  sessionId: string,
  userId: string,
  action: 'follow_up' | 'steer' | 'abort' | 'replace' | 'compact',
  message?: Extract<AgentMessage, { role: 'user' }>
): Promise<PiRuntimeStatus> {
  const runtimeInstance = await getOrCreatePiRuntime(sessionId, userId);
  
  switch (action) {
    case 'follow_up': return runtimeInstance.queueFollowUp(message!);
    case 'steer':     return runtimeInstance.queueSteering(message!);
    case 'replace':   return runtimeInstance.replace(message!);
    case 'abort':     return runtimeInstance.abort();
    case 'compact':   return runtimeInstance.compactNow();
  }
}

export async function getStatus(
  sessionId: string,
  userId: string
): Promise<PiRuntimeStatus | null> {
  return getPiRuntimeStatus(sessionId, userId);
}
```

### WS-Message-Protokoll (neue Typen)

```typescript
// Client → Server
{ type: 'subscribe_session', requestId: string, sessionId: string }
{ type: 'send_message', requestId: string, sessionId: string, message: AgentMessage, context?: ChatRequestContext }
{ type: 'control', requestId: string, sessionId: string, action: string, message?: AgentMessage }
{ type: 'get_status', requestId: string, sessionId: string }

// Server → Client
{ type: 'subscribe_result', requestId: string, success: boolean, sessionId?: string, error?: string }
{ type: 'send_message_result', requestId: string, success: boolean, status?: PiRuntimeStatus, error?: string }
{ type: 'control_result', requestId: string, success: boolean, status?: PiRuntimeStatus, error?: string }
{ type: 'status_result', requestId: string, success: boolean, status?: PiRuntimeStatus, error?: string }
```

### Frontend WS-Request-Wrapper

```typescript
const pendingRequests = new Map<string, { resolve: Function; reject: Function; timer: NodeJS.Timeout }>();

function wsRequest<T>(type: string, payload: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('WS request timeout'));
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ type, requestId, ...payload }));
  });
}

// In der WS onmessage-Handler:
function handleWsMessage(data: unknown) {
  if (data.requestId && pendingRequests.has(data.requestId)) {
    const { resolve, reject, timer } = pendingRequests.get(data.requestId)!;
    clearTimeout(timer);
    pendingRequests.delete(data.requestId);
    if (data.success) resolve(data);
    else reject(new Error(data.error));
    return;
  }
  // ... existing event handling
}
```

---

## Risiko & Mitigation

| Risiko | Mitigation |
|--------|-----------|
| WS-Verbindungsabbruch während Streaming | Runtime läuft serverseitig weiter; bei Reconnect wird Status via `get_status` synchronisiert |
| Frühe Runtime-Events gehen verloren, weil Subscribe noch nicht aktiv ist | `subscribe_result` abwarten oder `send_message` serverseitig vor Runtime-Start automatisch subscriben |
| `send_message` startet nicht, UI zeigt aber optimistische User-Message als gesendet | `send_message_result` mit `requestId`; UI setzt Message bei Fehler auf `error` |
| Keine HTTP-Fallback-Route mehr | HTTP erst nach erfolgreicher WS-Umstellung löschen; danach UI-Error + Reconnect + Status-Sync |
| Playwright-Tests müssen WS mocken | Zusätzlich echte WS-Integrationstests mit `ws`-Client gegen den Server einführen |
| Auth-Fallback: HTTP-Route hatte Session-Auth | WS-Auth beim Upgrade plus per-Message Session-Ownership für `subscribe`, `send_message`, `control`, `get_status` |
| HTTP-Rate-Limits fallen weg | WS-seitige Rate-Limits pro User/Session implementieren |
| Pending Requests bleiben nach Disconnect hängen | Pending-Request-Map bei Disconnect bereinigen; nur idempotente Requests nach Reconnect wiederholen |
| `replace` / Pending Replace wird als Run-Ende fehlinterpretiert | Runtime-Lifecycle-Events und Status-Sync müssen `hasPendingReplace()` berücksichtigen |

---

## Reihenfolge der Umsetzung

1. **Phase 1** (Service-Schicht + HTTP über Service) — erledigt
2. **Phase 7** (Request-ID-System) — erledigt
3. **Phase 2** (WS-Handler) — erledigt
4. **Phase 3** (Frontend) — erledigt
5. **Phase 4** (Übergangsprüfung ohne HTTP-Loopback) — erledigt
6. **Phase 8** (Tests) — Integrationstest auf WS umgestellt; Playwright-Tests auf `routeWebSocket` umgestellt
7. **Phase 5** (HTTP-Endpunkte löschen) — erledigt (`/api/stream/route.ts`, `/api/stream/status/route.ts`, `/api/stream/control/route.ts` gelöscht)
8. **Phase 6** (Bridge aufräumen) — erledigt
9. **Phase 9** (Doku) — erledigt (Migration-Plan aktualisiert, verwaiste Imports geprüft)

Zusätzliche Änderungen nach dem ursprünglichen Plan:

- **WS-Client Auth-Aware:** `connect()` resolvt erst nach `auth_success`, nicht mehr bei `onopen`. `isConnected()` und `send()` prüfen `isAuthenticated`. Behebt den "WebSocket request timeout" bei `get_status`.
- **WS Rate-Limits:** `server/websocket-rate-limit.ts` ergänzt per-User Rate-Limits für `send_message` (20/min), `control` (30/min), `get_status` (120/min), `subscribe_session` (30/min).
