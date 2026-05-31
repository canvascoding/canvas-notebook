# To-do-Zentrale, Notifications und Session-Ungelesen-Flow

## Ziel

Canvas Notebook soll eine zentrale, mobile-taugliche To-do-App erhalten, die menschliche Aufgaben verwaltet und vom Agenten beschrieben werden kann. Parallel soll die vorhandene Chat-Session-Historie um "als ungelesen markieren" erweitert werden. Eine Glocke in der globalen Kopfzeile soll ungelesene Chat-Antworten, neue Agent-To-dos und faellige To-dos kompakt anzeigen.

Der Chat soll in der neuen To-do-App rechts ein- und ausblendbar sein. Die bestehende Studio-Implementierung fuer Chat-Seitenpanel, Fullscreen-Modus, Mobile-Sheet und Resize soll dafuer in eine wiederverwendbare Shell extrahiert werden, statt fuer To-dos dupliziert zu werden.

## Grundentscheidungen

- Start mit einer zentralen To-do-Liste pro Nutzer.
- Kategorien ersetzen zunaechst mehrere Listen.
- Mehrere Listen/Projekte werden erst spaeter eingefuehrt, falls ein klarer Bedarf nach projekt-, kunden- oder mitarbeiterbezogener Trennung entsteht.
- User duerfen To-dos vollstaendig selbst verwalten: erstellen, bearbeiten, abhaken, wieder oeffnen und loeschen. Technisch bedeutet "loeschen" zunaechst archivieren.
- Agenten duerfen To-dos fuer den aktuell eingeloggten Nutzer erstellen, aber keine User-ID aus Tool-Parametern akzeptieren.
- To-dos koennen Workspace-Dateien verlinken. Gespeichert werden nur validierte, workspace-relative Pfade.
- Die Glocke ist eine kompakte Notification-Zentrale, aber nicht die primaere To-do-Oberflaeche.
- Bestehende Agent-Sessions und deren Systemprompt-Snapshots werden nicht nachtraeglich aktualisiert. Die Human-in-the-loop-Regel gilt ab der Implementierung fuer neu erzeugte Systemprompts/Sessions.

## Bestehende Anknuepfungspunkte

- Session-Unread basiert bereits auf `lastMessageAt > lastViewedAt` in `pi_sessions`.
- `PATCH /api/sessions` unterstuetzt bereits `markAsRead` und `markAllAsRead`.
- `SessionSidebar` zeigt bereits Unread-Badges und "Alle als gelesen markieren".
- `StudioShell` enthaelt bereits Chat-Dock-Logik:
  - Desktop-Seitenpanel
  - Desktop-Fullscreen
  - Mobile-Sheet
  - Breiten-Resize
  - LocalStorage fuer Chat-Sichtbarkeit und Breite
  - `CanvasAgentChat` mit `requestContext`
- `AppLauncher` und `HomeWorkspaceView` sind die Stellen fuer globale App-Eintraege und Startseiten-Kacheln.
- `server/websocket-broadcast.ts` kann bereits user-weite Events an alle verbundenen Clients senden.

## Phase 1: Session "Als ungelesen markieren"

### Ziel

Nutzer koennen eine Session im UI wieder auf ungelesen setzen.

### Umsetzung

- `RenameSessionPayload` bzw. Session-PATCH-Payload um `markAsUnread?: boolean` erweitern.
- In `PATCH /api/sessions`:
  - Eigentum ueber `sessionId`, `userId`, `agentId` pruefen.
  - Nur PI-Sessions unterstuetzen, da Legacy-Sessions keine Unread-Metadaten haben.
  - `lastViewedAt = null` und `updatedAt = now` setzen.
  - Optional ablehnen, wenn `lastMessageAt` leer ist, weil eine leere Session nicht sinnvoll ungelesen sein kann.
- In `SessionSidebar`:
  - einzelne Rename/Delete-Icon-Buttons durch ein Kontextmenue ersetzen.
  - Menueeintraege:
    - Umbenennen
    - Als gelesen markieren
    - Als ungelesen markieren
    - Loeschen
  - Fuer Legacy-Sessions Unread-Aktionen ausblenden oder deaktivieren.
- i18n-Texte in `messages/de.json` und `messages/en.json` ergaenzen.

### Tests

- API-Test fuer `markAsUnread`.
- Bestehenden Read/Unread-Test erweitern.
- UI-Test nur nach expliziter Freigabe fuer Playwright/Browser.
- `npm run build`.

### Commit

- Eigener Commit, z. B. `Add mark unread session action`.

## Phase 2: Gemeinsame Chat-Dock-Shell

### Ziel

Die Chat-Dock-Logik aus Studio wird wiederverwendbar, damit neue App-Seiten wie `/todos` denselben Chat rechts anbieten koennen.

### Umsetzung

- Neue Komponente, z. B. `app/components/layout/ChatDockShell.tsx`.
- Extrahieren aus `StudioShell`:
  - `DesktopChatMode = 'side' | 'fullscreen'`
  - Sichtbarkeit Desktop/Mobile
  - Resize-Logik
  - Keyboard-Toggle `Cmd/Ctrl + K`
  - Chat-Mode-Menue
  - Mobile-Sheet
  - `CanvasAgentChat`
- Props:
  - `children`
  - `title`
  - `backHref`
  - `backLabel`
  - `requestContext`
  - `storageKeyPrefix`
  - `hintPage`
  - `hintEnabled`
  - optional Header-Actions
- `StudioShell` auf die neue Shell umbauen und Verhalten gleich halten.
- `/todos` kann danach dieselbe Shell verwenden.

### Tests

- Build prueft Typen und Imports.
- UI-Regressionscheck Studio nur nach expliziter Playwright/Browser-Freigabe.
- Manuell pruefen, dass Studio-Seitenpanel, Fullscreen und Mobile-Sheet unveraendert funktionieren.

### Commit

- Eigener Commit, z. B. `Extract reusable chat dock shell`.

## Phase 3: To-do-Datenmodell und Store

### Ziel

Persistente To-dos, Kategorien und Dateiverlinkungen serverseitig verwalten.

### Tabellen

`todo_categories`

- `id TEXT PRIMARY KEY`
- `user_id TEXT NOT NULL`
- `name TEXT NOT NULL`
- `color TEXT`
- `icon TEXT`
- `sort_order INTEGER NOT NULL DEFAULT 0`
- `is_archived INTEGER NOT NULL DEFAULT 0`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

`todo_items`

- `id TEXT PRIMARY KEY`
- `user_id TEXT NOT NULL`
- `category_id TEXT`
- `title TEXT NOT NULL`
- `description TEXT`
- `status TEXT NOT NULL` (`open`, `done`, `archived`)
- `priority TEXT NOT NULL DEFAULT 'normal'` (`low`, `normal`, `high`)
- `due_at INTEGER`
- `source_type TEXT NOT NULL DEFAULT 'user'` (`user`, `agent`)
- `source_agent_id TEXT`
- `source_session_id TEXT`
- `seen_at INTEGER`
- `completed_at INTEGER`
- `archived_at INTEGER`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

`todo_file_links`

- `id TEXT PRIMARY KEY`
- `todo_id TEXT NOT NULL`
- `user_id TEXT NOT NULL`
- `workspace_path TEXT NOT NULL`
- `label TEXT`
- `created_at INTEGER NOT NULL`

### Store

Neue Service-Schicht `app/lib/todos/store.ts`.

Aufgaben:

- Eingaben normalisieren und validieren.
- Auth-/Ownership-Regeln zentral halten.
- Workspace-Pfade gegen Workspace-Grenzen pruefen.
- CRUD-Operationen fuer To-dos, Kategorien und Dateilinks bereitstellen.
- Keine direkte Verwendung von User-IDs aus Client- oder Tool-Input.

### Migrations

- `app/lib/db/schema.ts` erweitern.
- `app/lib/db/migrate.ts` um `CREATE TABLE IF NOT EXISTS` und Indizes erweitern.
- Relevante Indizes:
  - `todo_items(user_id, status, updated_at)`
  - `todo_items(user_id, due_at)`
  - `todo_items(user_id, seen_at)`
  - `todo_categories(user_id, sort_order)`
  - `todo_file_links(todo_id)`

### Tests

- Script-Test fuer Store-CRUD.
- Tests fuer Workspace-Pfadvalidierung.
- `npm run build`.

### Commit

- Eigener Commit, z. B. `Add todo persistence layer`.

## Phase 4: To-do-API

### Ziel

Serverseitige API fuer UI und Agent-Tool bereitstellen.

### Endpunkte

- `GET /api/todos`
  - Filter: `status`, `categoryId`, `sourceType`, `due`
  - liefert To-dos mit Kategorie und Dateilinks
- `POST /api/todos`
  - erstellt ein To-do fuer den eingeloggten Nutzer
- `PATCH /api/todos/[id]`
  - bearbeitet Titel, Beschreibung, Kategorie, Prioritaet, Faelligkeit, Status, Dateilinks
  - markiert `seenAt` bei Bedarf
- `DELETE /api/todos/[id]`
  - archiviert das To-do technisch (`status = 'archived'`, `archivedAt = now`)
  - die UI kann diese Eintraege als "Zuletzt geloescht" anzeigen
- `GET /api/todo-categories`
- `POST /api/todo-categories`
- `PATCH /api/todo-categories/[id]`
- `DELETE /api/todo-categories/[id]`
  - archiviert die Kategorie technisch; To-dos bleiben erhalten

### Sicherheit

- Jede Route nutzt `auth.api.getSession`.
- Jede Query filtert serverseitig nach `session.user.id`.
- Client darf keine fremde `userId` setzen.
- Dateilinks werden serverseitig gegen den Workspace validiert.
- Eingabetexte werden laengenbegrenzt.

### Tests

- Integrationstest fuer Auth, CRUD und Ownership.
- Negative Tests fuer ungueltige Dateipfade.
- `npm run build`.

### Commit

- Eigener Commit, z. B. `Add todo API routes`.

## Phase 5: To-do-App UI unter `/todos`

### Ziel

Eine eigene App fuer To-dos mit Chat rechts, Desktop- und Mobile-tauglich.

### Route

- `app/[locale]/(routes)/todos/page.tsx`
- optional Client-Komponente `app/apps/todos/components/TodosClient.tsx`

### UI-Struktur

- Header ueber `ChatDockShell`.
- Hauptbereich:
  - linke/obere Filterleiste
  - To-do-Liste
  - Detail-/Edit-Panel oder Drawer
- Chat rechts ueber gemeinsame Chat-Dock-Shell.
- Mobile:
  - To-do-Liste als Hauptscreen
  - Detail als Sheet oder eigener Bereich
  - Chat als rechtes Sheet wie Studio

### Funktionen

- To-do erstellen.
- To-do bearbeiten.
- To-do abhaken.
- To-do wieder oeffnen.
- To-do loeschen; technisch wird es archiviert.
- "Zuletzt geloescht" anzeigen und archivierte To-dos bei Bedarf wiederherstellen.
- Kategorie zuweisen.
- Kategorie erstellen, umbenennen, loeschen.
- Datei aus Workspace verlinken.
- Dateilink oeffnen.

### Standardkategorien

Beim ersten Verwenden der To-do-App werden pro Nutzer einfache Standardkategorien angelegt. Der Nutzer kann sie spaeter umbenennen, ausblenden/archivieren oder eigene Kategorien ergaenzen.

Vorgeschlagene Startkategorien:

- To-do
- Pruefen
- Freigabe
- Automation
- Follow-up
- Recherche
- Dateien

Separate Kategorie-Templates sind fuer das MVP nicht noetig, weil die wichtigsten Kategorien direkt vorgegeben werden.

### Dateilinks

- Dateiauswahl nur aus Workspace.
- Speichern als workspace-relativer Pfad.
- Klick oeffnet `/files?path=<encoded-path>`.
- `/files` muss Deep-Link-Support erhalten, damit die Datei direkt geladen und im Preview angezeigt wird.
- Wenn eine verlinkte Datei geloescht oder verschoben wurde, bleibt das To-do stabil. Die UI zeigt "Datei nicht gefunden" und bietet keinen kaputten Preview-Zustand.

### Chat-Kontext

`CanvasAgentChat` erhaelt fuer `/todos` einen `requestContext`, z. B.:

- `currentPage: '/todos'`
- `selectedTodoId`
- `selectedTodoTitle`
- `selectedCategoryId`
- `linkedWorkspacePaths`

Damit kann der Agent zielgerichtet auf sichtbare Aufgaben und verlinkte Dateien reagieren.

### Tests

- Component-/Integrationstests fuer API-Interaktion.
- UI-Test fuer Desktop und Mobile nach expliziter Playwright/Browser-Freigabe.
- `npm run build`.

### Commit

- Eigener Commit, z. B. `Add todos workspace app`.

## Phase 6: Agent-Tool `create_human_todo`

### Ziel

Der Agent kann Aufgaben fuer den Menschen anlegen, wenn menschliche Entscheidung, Freigabe, Nacharbeit oder Offline-Arbeit erforderlich ist.

### Tool

Name: `create_human_todo`

Parameter:

- `title: string`
- `description?: string`
- `priority?: 'low' | 'normal' | 'high'`
- `dueAt?: string`
- `categoryId?: string`
- `categoryName?: string`
- `linkedWorkspacePaths?: string[]`
- `reason?: string`

### Verhalten

- Tool ist user-gescoped ueber den laufenden Agent-Kontext.
- Keine `userId` als Tool-Parameter.
- Wenn `categoryName` existiert, aber keine Kategorie gefunden wird, wird keine neue Kategorie automatisch erstellt. Das To-do faellt auf die Standardkategorie `To-do` zurueck.
- `linkedWorkspacePaths` werden serverseitig validiert.
- `sourceType = 'agent'`
- `sourceAgentId = aktueller Agent`
- `sourceSessionId = aktuelle Session`, wenn verfuegbar.
- `seenAt = null`, damit neue Agent-To-dos in der Glocke erscheinen.

### Tool-Registry

- `app/lib/pi/tool-registry.ts` erweitern.
- Neues Toolset `todos` in `app/lib/pi/toolsets.ts`.
- Tool-Metadaten in Agent Settings sichtbar machen.
- Default-enabled ja, sofern kein Sicherheitsgrund dagegen spricht.

### System-Prompt

Der Hinweis gehoert in den Basis-Systemprompt, den alle Agenten erhalten. Dadurch gilt die Regel auch fuer Automationen, delegierte Agenten und spezialisierte Agenten, sofern das To-do-Tool fuer sie verfuegbar ist.

Human-in-the-loop-Regel:

- Wenn eine Aufgabe abgeschlossen ist und danach eine Handlung, Entscheidung, Freigabe, Pruefung, Rueckmeldung oder Offline-Aktion durch den Menschen erforderlich ist, lege ein To-do mit `create_human_todo` an.
- Das To-do ist der verbindliche Uebergabepunkt an den Nutzer. Es soll in der To-do-Liste sichtbar machen, was der Mensch als Naechstes tun muss.
- Bei Automationen gilt dieselbe Regel: Wenn ein automatischer Lauf fertig ist und menschliche Nacharbeit oder Kontrolle braucht, wird ein To-do angelegt.
- Nutze `create_human_todo`, wenn eine Aufgabe explizit an den Menschen uebergeben werden soll oder sich aus dem Ergebnis ein klarer menschlicher Folgeschritt ergibt.
- Erstelle keine To-dos fuer rein interne, temporaere Agent-Schritte.
- Speichere keine Secrets, Tokens oder sensiblen Rohdaten in To-dos.
- Verlinke relevante Workspace-Dateien, wenn sie fuer die Aufgabe wichtig sind.
- Formuliere To-dos konkret und abhakbar.
- Nenne im To-do kurz den Grund, warum menschliche Aktion erforderlich ist.

### Tests

- Tool-Test nach Muster bestehender `pi-*-tool-test.ts`.
- Test, dass Tool ohne User-ID nicht laeuft.
- Test fuer Dateipfadvalidierung.
- Test fuer Tool-Metadaten.
- `npm run build`.

### Commit

- Eigener Commit, z. B. `Add human todo agent tool`.

## Phase 7: Notification-Glocke

### Ziel

Globale Glocke in Headern neben AppLauncher, Theme/Logout anzeigen. Sie zeigt kompakt ungelesene Sessions und neue/faellige To-dos.

### Anzeige

- Badge-Zahl:
  - ungelesene Chat-Sessions
  - neue Agent-To-dos
  - faellige offene To-dos
  - Darstellung maximal zweistellig, bei mehr als 99 als `99+`
- Popover:
  - Abschnitt "Chat"
  - Abschnitt "To-dos"
  - Quicklinks zu Session bzw. To-do
  - Aktion "Alle Chat-Sessions als gelesen"
  - Aktion "Alle To-dos als gelesen markieren"
  - Aktion pro Eintrag "Als gelesen markieren"
  - Oeffnen eines To-dos auf der `/todos`-Route markiert dieses To-do ebenfalls als gelesen/gesehen

### API

`GET /api/notifications/summary`

Liefert:

- `unreadSessionsCount`
- `newTodosCount`
- `dueTodosCount`
- kurze Listen der neuesten Eintraege

Optional:

- `PATCH /api/notifications/read`
  - markiert einzelne oder alle To-do-Hinweise als gesehen
  - Chat-Read bleibt ueber bestehende Session-API

### Echtzeit

- Bei neuen Agent-To-dos user-weites WebSocket-Event senden, z. B. `todo_updated` oder `notification_summary_updated`.
- Bestehende Broadcast-Infrastruktur kann `broadcastToUser` nutzen.
- Glocke refetcht Summary bei Event.
- Das reine Oeffnen der Glocke markiert To-dos nicht automatisch als gelesen. Gelesen wird ein To-do durch explizites Markieren oder durch Oeffnen des To-dos in der To-do-Route.

### Integration

- `AppHeader` existiert nicht zentral fuer alle Seiten, daher zunaechst:
  - Home-Header
  - `SuitePageLayout`
  - `StudioShell` bzw. neue `ChatDockShell`
  - FileBrowser-Header, falls separater Header bleibt
- Langfristig Header-Actions weiter vereinheitlichen.

### Tests

- API-Test fuer Summary.
- UI-Test nach expliziter Playwright/Browser-Freigabe.
- `npm run build`.

### Commit

- Eigener Commit, z. B. `Add notification bell summary`.

## Phase 8: `/files?path=` Deep-Link

### Ziel

To-do-Dateilinks fuehren direkt zur relevanten Workspace-Datei und oeffnen sie in der Preview.

### Umsetzung

- `/files` liest `path` aus Search Params.
- Pfad server-/clientseitig normalisieren.
- Wenn Pfad Datei ist:
  - Ordner laden
  - Datei auswaehlen
  - Preview oeffnen
- Wenn Pfad Ordner ist:
  - Ordner laden und anzeigen
- Ungueltige oder fehlende Pfade:
  - Toast/Fehler anzeigen
  - in To-do-Dateilinks sichtbar als "Datei nicht gefunden" markieren
  - auf Workspace-Root zurueckfallen

### Tests

- Deep-Link auf Datei.
- Deep-Link auf Ordner.
- Ungueltiger Pfad.
- `npm run build`.

### Commit

- Eigener Commit, z. B. `Add file deep links for todos`.

## Reihenfolge der Abarbeitung

1. Session-Kontextmenue und "als ungelesen markieren".
2. Gemeinsame Chat-Dock-Shell extrahieren und Studio regressionsarm umbauen.
3. To-do-Datenmodell, Migration und Store.
4. To-do-API.
5. To-do-App `/todos` mit Chat rechts.
6. Agent-Tool `create_human_todo`.
7. Notification-Glocke.
8. Datei-Deep-Links fuer To-do-Verlinkungen.

Kein naechstes grosses To-do beginnen, solange das vorherige nicht fertig, gebaut und committed ist.

## Verification-Plan

Pro Phase:

- relevante Script-/Integrationstests
- `npm run build`
- UI-Pruefung fuer integrierte UI-Aenderungen nur nach expliziter Freigabe fuer Playwright/Browser
- keine Container bauen, ausser explizit gefordert
- keine parallelen Test-Container starten
- bei Container-Testlaeufen immer recreate/rebuild

## Rueckgestellte Erweiterungen ohne Blocker

- Mehrere Listen: Empfehlung ist erst nach MVP evaluieren.
- Notification-Historie: Empfehlung ist zunaechst aggregierte Summary statt persistenter Notification-Tabelle.
- Hard-Delete alter archivierter To-dos: nicht im MVP. To-dos bestehen aus kleinen Text-/Metadatenstrings und sollten speicherseitig unkritisch sein. Falls spaeter notwendig, kann ein Wartungsjob archivierte To-dos nach einer langen Frist, z. B. 12 oder 24 Monate, endgueltig entfernen.

## Keine offenen Blocker-Fragen

Der Plan ist umsetzbar, ohne vorher weitere Entscheidungen zu erzwingen. Die rueckgestellten Punkte koennen nach dem MVP anhand der konkreten Nutzung bewertet werden.
