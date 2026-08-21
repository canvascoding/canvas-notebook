---
title: 'Umsetzungsplan zu Ticket 02: Notification- und To-do-Status vereinheitlichen'
status: completed
date: 2026-08-21
branch: ticket/02-notification-todo-status
platforms: [web, server, mobile-api]
tags: [type/implementation-plan, topic/notifications, topic/todos]
---

# Umsetzungsplan: Notification- und To-do-Status vereinheitlichen

## Ziel und Arbeitsmodus

Dieser Plan setzt [Ticket 02](./02-notification-und-todo-status-vereinheitlichen.md)
auf dem nach Ticket 01 gemergten Stand um. Die Phasen werden streng
sequenziell implementiert, getestet und jeweils als eigener Commit
abgeschlossen. Ticket 03 beginnt erst nach der Abnahme dieses Tickets.

Die fachliche Trennung lautet:

- Der **To-do-Lebenszyklus** (`open`, `done`, `archived`) entscheidet, ob ein
  To-do fachlich aktiv und auffindbar ist.
- Der **Aufmerksamkeitsstatus** (`read`/`unread`) ist nutzerbezogen und
  entscheidet nur ueber Darstellung und Counter.
- Notification-Actions pruefen Ownership und Workspace-Zugriff und
  orchestrieren die Statusaenderung.
- Ein gemeinsamer Read-State-Store kapselt die wiederverwendbare Persistenz.
  Web-, Mobile- und To-do-APIs duerfen keine eigene Statusmechanik besitzen.

## Abschluss am 21.08.2026

Alle Phasen wurden umgesetzt. Die fokussierten Commits sind:

1. `ca6f5f66 Add per-user todo read state`
2. `289c06c7 Unify todo read state actions`
3. `dff8dcc2 Keep todos visible in notification inbox`
4. `55b23dbf Separate todos in notification center`

Der finale Vertrag liefert `counts.todoUnread` sowie getrennte
`sections.notifications` und `sections.todos`; die bestehende zusammengefuehrte
`items`-Liste bleibt kompatibel. Der Notification-Summary lädt die To-do-Sektion
separat, damit sie nicht durch ereignisbasierte Hinweise verdraengt wird.

## Inventur des bestehenden Stands

Bereits vorhanden und weiterzuverwenden:

- `todo_items` kennt `status`, `seen_at`, `completed_at` und `archived_at`.
- `app/lib/todos/store.ts` besitzt To-do-CRUD, Scope-Pruefungen und
  `markTodoSeen`.
- `app/lib/mobile/inbox.ts` sammelt Chat-, To-do-, Studio- und
  Automation-Eintraege fuer Web und Mobile.
- `GET/PATCH /api/notifications/summary` verwendet bereits dieselbe
  Aggregation wie die Mobile-Inbox.
- `GET/PATCH /api/mobile/v1/inbox` sowie der Aggregate-Endpunkt besitzen
  Filter, Counts, Pagination und Read-Actions.
- `NotificationBell` zeigt die Web Notification Central und markiert einen
  Eintrag beim Oeffnen als gelesen.
- `scripts/mobile-inbox-todos-test.ts` prueft Inbox, Aggregate-Inbox,
  Notification Summary und To-do-Serialisierung bereits gemeinsam.

Die konkrete Fehlerursache liegt heute an drei Stellen:

1. `collectInboxItems` nimmt ein To-do nur auf, wenn es `open` und entweder
   ungelesen oder faellig ist. Ein gelesenes, nicht faelliges To-do
   verschwindet daher aus Web und Mobile.
2. Persoenliche To-dos verwenden `todo_items.seen_at`, geteilte To-dos dagegen
   `mobile_inbox_read_states`. Dadurch haben To-do-API und Inbox nicht fuer
   jeden Workspace dieselbe Wahrheit.
3. Es existiert nur `mark_item_read`; ein idempotenter, nutzerbezogener Weg
   zurueck auf `unread` fehlt in Notification- und Mobile-Inbox-API.

## Fachliche Entscheidungen

### 1. Sichtbarkeit und Aufmerksamkeit sind unabhaengig

Fuer Ticket 02 gilt folgende Matrix:

| To-do-Status | In To-do-Sektion sichtbar | Kann unread sein | Zaehlt im Unread-Badge |
| --- | --- | --- | --- |
| `open` | ja | ja | ja, wenn unread |
| `done` | ja | ja | ja, wenn unread |
| `archived` | nein | technisch gespeichert | nein |

Damit bleiben gelesene und erledigte To-dos auffindbar. Archivieren ist die
einzige Aktion, die sie aus der aktiven Inbox entfernt. Eine spaetere
Retention fuer erledigte To-dos ist nicht Teil dieses Tickets.

Chat-Hinweise bleiben ereignisorientiert: Nur ungelesene Chat-Antworten
erscheinen in der aktiven Notification-Liste. Nach dem Lesen verschwinden sie.

### 2. Read-State ist pro Nutzer, nicht am gemeinsamen To-do

`todo_items.seen_at` kann bei Team- und Projekt-To-dos keinen individuellen
Status fuer mehrere Nutzer darstellen. Deshalb wird eine kanonische Tabelle
eingefuehrt:

```text
todo_read_states
  user_id       TEXT NOT NULL
  todo_id       TEXT NOT NULL
  read_at       INTEGER NOT NULL
  created_at    INTEGER NOT NULL
  updated_at    INTEGER NOT NULL
  PRIMARY KEY (user_id, todo_id)
```

- Vorhandene persoenliche `seen_at`-Werte werden fuer den bisherigen
  `todo_items.user_id` migriert.
- Bestehende `mobile_inbox_read_states` mit `item_key = todo:<id>` werden,
  soweit To-do und Nutzer noch lesbar sind, uebernommen.
- Lesen ist ein Upsert; als ungelesen markieren loescht den nutzerbezogenen
  Read-State. Beide Operationen sind idempotent.
- `todo_items.seen_at` bleibt zunaechst als Legacy-Spalte erhalten, ist nach
  der Migration aber nicht mehr die fachliche Quelle fuer API-Ausgaben.
- Das Aendern des Read-State darf `todo_items.updated_at` nicht veraendern,
  damit Sortierung, Unread-Berechnung und fachliche Aenderungen getrennt
  bleiben.

### 3. Action und Store bleiben getrennt

Neue Module:

- `app/lib/todos/read-state-store.ts`
  - liest, setzt und entfernt Read-State mit expliziten IDs;
  - kennt keine HTTP-Payloads und entscheidet keine Berechtigungen.
- `app/lib/todos/read-state-actions.ts`
  - laedt das To-do und prueft `canRead` im aktuellen Nutzer-/Workspace-Scope;
  - setzt `read` oder `unread` ueber den Store;
  - liefert einen stabilen, serialisierbaren Status zurueck.

Inbox, Web-API, Mobile-API und To-do-Routen verwenden dieselbe Action. Alte
Sonderwege in `markMobileInboxRead` und `markTodoSeen` werden erst entfernt,
nachdem alle Aufrufer migriert und getestet sind.

## Zielvertraege

### Notification Summary

`GET /api/notifications/summary` bleibt additiv kompatibel und liefert:

```json
{
  "success": true,
  "data": {
    "unreadCount": 3,
    "counts": {
      "unread": 3,
      "chat": 1,
      "todos": 8,
      "todoUnread": 2,
      "studio": 0,
      "automation": 0
    },
    "sections": {
      "notifications": [],
      "todos": []
    },
    "items": []
  }
}
```

`items` bleibt waehrend Ticket 02 als kompatible, zusammengefuehrte Ansicht
erhalten. `sections.todos` enthaelt `open` und `done` unabhaengig vom
Read-State. `sections.notifications` enthaelt weiterhin nur aktive
ereignisbasierte Hinweise.

To-do-Eintraege erhalten mindestens:

```json
{
  "id": "todo:<id>",
  "unread": false,
  "readAt": "2026-08-21T12:00:00.000Z",
  "lifecycleStatus": "open",
  "target": { "kind": "todo", "todoId": "<id>" }
}
```

### Read-/Unread-Mutation

Web und Mobile akzeptieren denselben fachlichen Vertrag:

```json
{
  "action": "set_item_read_state",
  "itemId": "todo:<id>",
  "workspaceId": "<workspace>",
  "read": false
}
```

Response:

```json
{
  "success": true,
  "data": {
    "itemId": "todo:<id>",
    "read": false,
    "readAt": null
  }
}
```

`mark_item_read` bleibt fuer bestehende Clients als Alias fuer
`set_item_read_state` mit `read: true` erhalten. `read: false` ist nur fuer
To-dos zulaessig; Chat-, Studio- und Automation-Eintraege koennen dadurch
nicht kuenstlich wieder erzeugt werden.

Die direkten To-do-Endpunkte geben ebenfalls `readState` und `readAt` aus und
akzeptieren `read: boolean`. Bestehendes `markSeen: true` wird kompatibel auf
`read: true` abgebildet.

## Sequenzielle Implementierungsphasen

### Phase 1: Kanonische Read-State-Persistenz

- `todo_read_states` in Drizzle-Schema und SQLite-Migration ergaenzen.
- Fremdschluessel und Indizes fuer `user_id`, `todo_id` und `read_at`
  definieren.
- Bestandsdaten aus `todo_items.seen_at` und kompatiblen Inbox-Read-States
  idempotent migrieren.
- `read-state-store.ts` mit Batch-Lesen, Upsert und Delete implementieren.
- Store-Tests fuer persoenliche und geteilte To-dos, Mehrbenutzer-Isolation,
  Idempotenz und Migration ergaenzen.
- Verifikation: `test:todos:store`, Migrations-Test und TypeScript.
- Commit: `Add per-user todo read state`.

### Phase 2: Gemeinsame Read-State-Action und To-do-APIs

- `read-state-actions.ts` mit zentraler Ownership-/Scope-Pruefung bauen.
- `listTodos`/`getTodo` um den effektiven Read-State des anfragenden Nutzers
  ergaenzen, ohne `todo_items.updated_at` anzufassen.
- Web- und Mobile-To-do-Serialisierung auf `readState`/`readAt` umstellen.
- `PATCH /api/todos/[id]` und
  `PATCH /api/mobile/v1/todos/[todoId]` um `read: boolean` ergaenzen.
- `markSeen: true` als Kompatibilitaetsalias beibehalten; widerspruechliche
  Payloads mit stabilem `400`-Fehler ablehnen.
- Neue, vom Nutzer selbst erstellte To-dos fuer den Ersteller initial als
  gelesen markieren; Agent-To-dos bleiben initial ungelesen.
- Negative Tests fuer fremde Nutzer, nicht lesbare Workspaces und unbekannte
  To-dos ergaenzen.
- Verifikation: `test:todos:store`, `test:todos:api`, Mobile-To-do-Tests und
  TypeScript.
- Commit: `Unify todo read state actions`.

### Phase 3: Persistente To-do-Sektion in der Inbox

- `collectInboxItems` so aendern, dass nicht archivierte To-dos unabhaengig
  von `read` und Faelligkeit gesammelt werden.
- `open` und `done` serialisieren; `archived` konsequent ausschliessen.
- Read-State in persoenlichen, Team-, Organisations- und Projekt-Workspaces
  ausschliesslich ueber die gemeinsame Action/Batch-Abfrage aufloesen.
- Counts trennen: Gesamt-To-dos, ungelesene To-dos und gesamte ungelesene
  Aufmerksamkeit.
- Pagination so pruefen, dass persistente To-dos Chat-Hinweise nicht aus dem
  Ergebnis verdraengen; pro Sektion eigene Limits/Cursor verwenden oder die
  Summary bewusst separat laden.
- `mark_all_read` markiert To-dos nur gelesen und entfernt sie nicht aus der
  To-do-Sektion.
- Verifikation: erweiterter `test:mobile:inbox` mit gelesenem offenen,
  gelesenem erledigten und archivierten To-do sowie Cross-Workspace-Faellen.
- Commit: `Keep todos visible in notification inbox`.

### Phase 4: Einheitlicher Read-/Unread-Vertrag

- `set_item_read_state` in Web Notification Summary sowie Workspace- und
  Aggregate-Mobile-Inbox implementieren.
- `read: false` serverseitig auf To-do-Eintraege begrenzen.
- Bestehende `mark_item_read`, `mark_all_read` und `dismiss_item` kompatibel
  erhalten.
- Mutationsantworten in allen Endpunkten angleichen und nach erfolgreicher
  Mutation die aktualisierten Counts bzw. den Item-State liefern.
- Einen fokussierten Notification-Summary-API-Test als eigenes npm-Script
  registrieren; bestehende Mobile-Inbox-Tests nicht mit Web-spezifischen
  Assertions ueberladen.
- Verifikation: Summary-, Mobile-Inbox-, Auth-, Scope- und Idempotenztests.
- Commit: `Add todo read and unread inbox actions`.

### Phase 5: Web Notification Central

- `NotificationBell` visuell in `Notifications` und `To-dos` strukturieren,
  ohne die Tab-Navigation aus Ticket 03 vorwegzunehmen.
- Gelesene To-dos weiterhin darstellen; Unread-Markierung nur visuell
  aendern.
- Pro To-do eine Aktion `Als gelesen` bzw. `Als ungelesen` anbieten.
- Klick auf ein To-do darf es weiter als gelesen markieren und zur To-do-App
  navigieren; ein explizites Zuruecksetzen bleibt danach moeglich.
- `Alle als gelesen` beeinflusst Counter und Darstellung, nicht die
  To-do-Sichtbarkeit.
- Deutsche/englische Texte, Tastaturbedienung und Accessibility-Labels
  ergaenzen.
- Verifikation: Komponenten-/Contract-Test, gezieltes ESLint und TypeScript.
  Browser-/Playwright-Abnahme nur nach expliziter Freigabe.
- Commit: `Separate todos in notification center`.

### Phase 6: Mobile-Vertrag, Gesamtabnahme und Ticketabschluss

- Den finalen Mobile-Vertrag mit Beispielen fuer `filter=todos`, Counts,
  Pagination und `set_item_read_state` dokumentieren.
- Sicherstellen, dass die Expo-App ohne sofortige Client-Aenderung weiterhin
  `mark_item_read` verwenden kann; die eigentliche Tab-UI folgt in Ticket 03.
- Gesamte relevante Testgruppe ausfuehren:
  - To-do-Store, API, Agent-Tool und Assignees;
  - Mobile Inbox und Mobile To-dos;
  - Notification Summary und Web-Mapping;
  - Auth-, Workspace- und Mehrbenutzer-Isolation.
- Gezieltes ESLint fuer alle geaenderten Dateien und abschliessend
  `npm run build` ausfuehren.
- Ticketstatus und Index erst danach auf `erledigt` setzen.
- Abschlusscommit: `Complete notification todo status ticket`.

## Testmatrix

| Bereich | Positiver Fall | Negativer/Sicherheitsfall |
| --- | --- | --- |
| Sichtbarkeit | gelesenes `open`/`done` bleibt in To-do-Sektion | `archived` erscheint nicht |
| Toggle | read -> unread -> read ist sofort in Web/Mobile sichtbar | fremder Nutzer oder Workspace erhaelt 404/403 |
| Mehrbenutzer | Teammitglieder haben getrennte Read-States | ein Nutzer veraendert nicht den Status anderer |
| Chat | ungelesene Antwort erscheint und verschwindet nach Lesen | To-do wird durch Chat-Aktion nicht entfernt |
| Mark all | Counter wird null, To-dos bleiben sichtbar | archivierte Items werden nicht reaktiviert |
| Kompatibilitaet | `mark_item_read` und `markSeen` funktionieren weiter | widerspruechliche Payload wird abgewiesen |
| Sortierung | Read-Toggle aendert nicht `todo.updatedAt` | Pagination erzeugt keine Duplikate/Luecken |

## Definition of Done

- Web und Mobile verwenden dieselbe nutzerbezogene Read-State-Quelle.
- `open` und `done` bleiben unabhaengig vom Read-State auffindbar;
  `archived` bleibt ausgeschlossen.
- To-dos koennen idempotent gelesen und ungelesen gesetzt werden.
- Chat-Hinweise behalten ihr ereignisorientiertes Verhalten.
- Workspace-, Projekt- und Nutzerisolation sind serverseitig getestet.
- Bestehende Clients bleiben ueber die dokumentierten Aliase kompatibel.
- Alle relevanten Tests, TypeScript, gezieltes ESLint und Build sind gruen.
- Jede Phase besitzt einen eigenen fokussierten Commit; Ticket 03 bleibt bis
  zum Abschluss unangetastet.
