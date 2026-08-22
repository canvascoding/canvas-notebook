---
title: 'Umsetzungsplan zu Ticket 03: Mobile Inbox mit Kategorien und Badges'
status: planned
date: 2026-08-22
platforms: [mobile, mobile-api, web]
tags: [type/implementation-plan, topic/mobile-app, topic/notifications, topic/email, topic/todos]
---

# Umsetzungsplan: Mobile Inbox mit Kategorien und Badges

## Ziel und Arbeitsmodus

Dieser Plan konkretisiert [Ticket 03](./03-mobile-inbox-tabs-und-badges.md) auf
Basis des aktuellen Server-Repositorys. Er beschreibt keine bereits erfolgte
Produktimplementierung. Ticket 03 und der zugehoerige Eintrag im Index bleiben
offen, bis Server und private Expo-App implementiert und gemeinsam abgenommen
sind.

Die spaetere Umsetzung erfolgt strikt sequenziell. Eine Phase beginnt erst,
wenn die vorherige Phase vollstaendig implementiert, mit den dort genannten
Pruefungen verifiziert und als fokussierter Commit abgeschlossen ist. Der
Serververtrag wird zuerst additiv bereitgestellt; erst danach wird die Expo-App
darauf umgestellt. Server- und Mobile-Repository erhalten getrennte Commits.

Die Zielarchitektur lautet:

- Die sichtbare Mobile-Inbox besitzt genau die drei Hauptbereiche
  **Notifications**, **E-Mails** und **To-dos**.
- Jede Kategorie hat eine eigene paginierte Abfrage, einen eigenen Query-Key,
  einen eigenen Cursor sowie eigene Lade-, Leer-, Fehler- und Offlinezustaende.
- Exakte Kategorie-Counts werden serverseitig aus eigenen Count-Projektionen
  berechnet. Sie werden nicht aus einer begrenzten ersten Listenseite
  abgeleitet.
- Das Badge des Inbox-Eintrags in der Bottom-Navigation und das Betriebssystem-
  App-Badge verwenden denselben Notification-only-Count. E-Mails und To-dos
  werden dort nicht addiert.
- E-Mail-Aufmerksamkeit wird aus den bereits persistierten Inbox-Faellen und
  Review-Entwuerfen gebildet. Das Oeffnen der Mobile-Inbox fragt keine externen
  Gmail-, Microsoft- oder IMAP-Postfaecher live ab.
- To-do-Lifecycle und To-do-Read-State bleiben gemaess Ticket 02 getrennt. Ein
  gelesenes To-do verschwindet nicht aus dem To-do-Tab.
- API-Routen bleiben Adapter. Kategorie-, Deduplizierungs-, Scope- und Count-
  Regeln liegen in gemeinsamen serverseitigen Actions beziehungsweise Read-
  Models und werden nicht in Mobile-, Web- und Push-Adaptern dupliziert.

Nicht Bestandteil dieses Tickets sind ein vollstaendiger nativer E-Mail-
Client, Provider-Synchronisation, neue E-Mail-Sendewege, eine neue Push-
Infrastruktur, ein Redesign der Web Notification Central, Container- oder
Deployment-Arbeiten. Browser-, Playwright- und reale Geraetepruefungen erfolgen
in der spaeteren Umsetzung nur nach ausdruecklicher Freigabe.

## Verbindliche Quellen und Abhaengigkeiten

Der Plan fuehrt folgende vorhandene Grundlagen zusammen:

- [Ticket 02 und dessen Umsetzungsplan](./02-notification-todo-umsetzungsplan.md)
  definieren den nutzerbezogenen To-do-Read-State, persistente To-do-Sektionen
  und die kompatiblen Inbox-Actions.
- [Expo Mobile App – Produkt- und Umsetzungsplan](../../expo-mobile-app-plan.md)
  definiert Expo Router, TanStack Query, Workspace-Scope, Push, Deep Links,
  Offlineverhalten und die Trennung der beiden Repositories.
- [To-do-Zentrale, Notifications und Session-Ungelesen-Flow](../todo-notification-center-plan.md)
  definiert die Attention-Semantik der Web-Glocke und die Trennung von
  Chat-Hinweisen und To-dos.
- `docs/product/en/collaboration/notifications.mdx` beschreibt Notifications
  als persoenliche Attention-Ansicht und nicht als Audit-Log.
- `docs/product/en/email/multiple-inboxes.mdx` verlangt explizite Konto- und
  Mailbox-Grenzen.
- `docs/architecture/canvas-notebook/workspace-email-automations-v1-data-model.md`
  definiert persoenliche und workspacegebundene Inbox-Faelle sowie den
  Human-Review-Lifecycle der Outbox.

Ticket 02 ist im aktuellen Stand umgesetzt. Dessen Read-State-Vertrag wird in
Ticket 03 nur konsumiert und erweitert, nicht durch eine zweite Mobile-
Persistenz ersetzt. Die Expo-App liegt weiterhin im separaten privaten
Repository `canvas-notebook-mobile`. Dieses Repository ist im vorliegenden
Worktree nicht enthalten; deshalb sind Serverpfade unten verifiziert, waehrend
die exakten Mobile-Dateipfade zu Beginn der Clientphase gegen den dortigen
aktuellen Baum bestaetigt werden muessen.

## Inventur des aktuellen Codebestands

### Mobile-Inbox und Counts

- `app/lib/mobile/inbox.ts`
  - kennt die Filter `all`, `unread`, `notifications`, `chat`, `todos`,
    `studio` und `automation`, aber keinen E-Mail-Filter;
  - serialisiert nur `chat.response`, `todo.attention`, Studio- und
    Automation-Eintraege;
  - berechnet `counts` nach dem Sammeln der gesamten Mischliste, bevor der
    angeforderte Filter angewendet wird;
  - begrenzt jede Quellmenge mit `MAX_SOURCE_ITEMS = 200`. Die heutigen Counts
    sind deshalb fuer groessere Datenmengen keine exakten Gesamtzaehler;
  - haelt gelesene `open`- und `done`-To-dos sichtbar und schliesst archivierte
    To-dos aus;
  - besitzt bereits filtergebundene Cursor sowie Aggregate-Cursor ueber mehrere
    Workspaces;
  - dedupliziert identische To-do-IDs und kann in kurzem Zeitfenster erzeugte,
    inhaltlich gleiche Workspace-To-dos fuer die Darstellung gruppieren.
- `app/api/mobile/v1/inbox/route.ts` stellt die workspacegebundene Liste und
  Item-Actions bereit.
- `app/api/mobile/v1/inbox/aggregate/route.ts` stellt die nutzerweite Liste
  ueber die in den Inbox-Praeferenzen eingeschlossenen Workspaces bereit. Der
  Aggregate-PATCH akzeptiert derzeit nur `mark_all_read`.
- `app/lib/mobile/inbox-scope.ts` und
  `app/api/mobile/v1/inbox/preferences/route.ts` filtern auf aktive, lesbare
  Workspaces und verhindern einen leeren oder fremden Inbox-Scope.
- `app/lib/mobile/app-badge.ts` zaehlt ueber
  `countMobileUnreadMessages` ausschliesslich ungelesene Agentenantworten. Der
  Weg ist To-do-frei, umfasst aber noch keine anderen ungelesenen
  Notification-Typen.
- `app/api/mobile/v1/inbox/badge/route.ts` liefert aktuell nur
  `{ success, count }`.

### Web Notification Central und Push

- `app/api/notifications/summary/route.ts` verwendet dieselbe Aggregate-
  Inbox, laedt Notifications und To-dos getrennt und erhaelt die kompatible
  zusammengefuehrte `items`-Liste.
- `app/components/notifications/notification-summary.ts` und
  `NotificationBell.tsx` kennen nur Notification- und To-do-Sektionen. Der
  Web-Badgewert `unreadCount` umfasst heute den bestehenden kombinierten
  Attention-Vertrag aus Ticket 02.
- `app/lib/mobile/push-devices.ts` setzt den OS-Badgewert vor einem Push ueber
  `countMobileAppBadgeForUserId`. Damit teilen Push und Badge-Route bereits
  einen Resolver.
- Der Push-Vertrag kennt bereits `email.outbox_review` und
  `sendWorkspaceOutboxReviewPush`; dieser Zieltyp wird aber weder in
  `app/lib/mobile/inbox.ts` gesammelt noch durch eine eigene E-Mail-
  Praeferenzspalte getrennt. Er verwendet derzeit `todo_attention` als
  Praeferenzfallback.
- `app/lib/mobile/compatibility.ts` und `app/lib/mobile/bootstrap.ts` melden
  bereits `inbox.feed`, `inbox.aggregate`, `inbox.sources`,
  `inbox.read_state`, `inbox.dismiss` und `push.app_badge`. Eine Capability
  fuer den Drei-Kategorien-Vertrag oder E-Mail-Attention fehlt.

### E-Mail-Read-Models

- `app/lib/email/service.ts`, `local-service.ts` und `imap-service.ts` koennen
  Provider-Nachrichten und deren `isRead`-Status lesen und veraendern. Diese
  Aufrufe benoetigen jedoch Providerzugriff und sind kein stabiler Bestandteil
  eines globalen Inbox-Aggregats.
- `email_inbox_cases` und `personal_email_inbox_cases` in
  `app/lib/db/schema.ts` bilden bereits persistierte, scopegebundene E-Mail-
  Faelle mit `status`, `priority`, Bearbeiter und Zeitstempeln ab.
- `email_drafts` enthaelt die Reviewzustaende `prepared`, `awaiting_review`,
  `editing`, `sent`, `discarded` und `send_failed` sowie einen optionalen
  Inbox-Fallbezug.
- `app/lib/email/workspace-inbox-outbox.ts` trennt persoenliche und Workspace-
  Inbox/Outbox fachlich, prueft Workspacezugriff und gibt redigierte DTOs ohne
  Provider-Secrets oder Nachrichtenkoerper im Inbox-Fall aus.
- Die vorhandenen Listen sind noch ungepaginiert und besitzen kein fuer Mobile
  normalisiertes Attention-DTO. Ein Fall und sein wartender Entwurf koennen bei
  naiver Zusammenfuehrung doppelt gezaehlt werden.

### Vorhandene Tests

- `scripts/mobile-inbox-todos-test.ts` prueft heute Inbox, Aggregate-Inbox,
  Cursor, Workspace-Praeferenzen, To-do-Sichtbarkeit, Read-/Unread-Actions,
  Web-Summary und den Agentenantwort-Badgeweg gemeinsam.
- `scripts/mobile-push-devices-test.ts` prueft Push-Badge und iOS-Widget-
  Refresh-Nachrichten.
- `scripts/mobile-bootstrap-test.ts` und
  `scripts/mobile-compatibility-test.ts` fixieren die Capabilitylisten exakt.
- `scripts/email-account-workspace-binding-test.ts` prueft persoenliche und
  Workspace-Inbox-Faelle, Outbox-Entwuerfe und Cross-Workspace-Ablehnung.

## Belegte Luecken und Konsequenzen

| Befund | Status | Konsequenz fuer Ticket 03 |
| --- | --- | --- |
| Die Inbox kennt keine E-Mail-Items und keinen `emails`-Filter. | im Code belegt | Der E-Mail-Tab benoetigt ein neues persistiertes Attention-Read-Model und einen additiven Filtervertrag. |
| Counts werden aus maximal 200 geladenen Elementen je Quelle berechnet. | im Code belegt | Tab-Badges muessen aus exakten Count-Queries stammen und duerfen nicht aus Listenseiten abgeleitet werden. |
| `counts.unread` vermischt Notification- und To-do-Unread. | im Code belegt | Ein neuer expliziter Kategorie-Count ist noetig; die Legacyfelder bleiben kompatibel. |
| Der OS-/API-Badge zaehlt nur Agentenantworten. | im Code belegt | Der Resolver muss alle badgefaehigen ungelesenen Notification-Typen, aber keine E-Mails oder To-dos zaehlen. |
| Der Web-Summary und die Mobile-Inbox teilen die Aggregation, aber nicht klar benannte Kategorie-Counts. | im Code belegt | Eine gemeinsame Count-Action liefert beiden Adaptern dieselben Begriffe, ohne den Web-Legacyvertrag sofort zu brechen. |
| E-Mail-Faelle und Review-Entwuerfe koennen denselben Vorgang repraesentieren. | im Code belegt | Der E-Mail-Read-Model-Layer muss vor Count und Pagination nach Fallbezug deduplizieren. |
| Ein E-Mail-Providerabruf kann langsam, offline oder kontospezifisch fehlschlagen. | architektonisch belegt | Die Haupt-Inbox verwendet nur persistierte Faelle/Entwuerfe; ein voller Provider-Posteingang bleibt ausserhalb dieses Tickets. |
| Das private Expo-Repository ist nicht Teil dieses Worktrees. | lokal belegt | Die erste Clientphase inventarisiert reale Routen, Query-Keys und Komponenten, bevor Mobile-Dateien geaendert werden. |

## Verbindliche Produkt- und UX-Entscheidungen

### 1. Kategorien, Reihenfolge und sichtbarer Umfang

Die Reihenfolge ist dauerhaft:

1. **Notifications**
2. **E-Mails**
3. **To-dos**

Beim ersten Oeffnen ist `Notifications` aktiv. Der zuletzt aktive Untertab darf
pro Instanz und Nutzer lokal wiederhergestellt werden, sofern der gespeicherte
Wert weiterhin gueltig ist. Der bisherige gemischte `all`-Feed bleibt nur als
API-Kompatibilitaet fuer alte Clients bestehen und wird nicht als vierter Tab
angezeigt.

Der sichtbare Inhalt lautet:

- **Notifications:** `chat.response`, `studio.completed`, `studio.failed` und
  `automation.failed`. Gelesene Chat-Hinweise verschwinden wie bisher;
  Studio-/Automation-Eintraege bleiben bis zur vorhandenen Dismiss-Aktion
  sichtbar.
- **E-Mails:** persistierte persoenliche oder Workspace-Inbox-Faelle in
  `new`, `in_progress`, `awaiting_review` oder `needs_routing` sowie
  eigenstaendige Review-Entwuerfe in `awaiting_review`, `editing` oder
  `send_failed`. `answered`, `closed`, `sent` und `discarded` erscheinen nicht.
  Ein mit einem Fall verknuepfter Review-Entwurf wird in derselben Zeile als
  naechste Aktion dargestellt und nicht als zweites Badgeobjekt gezaehlt.
- **To-dos:** alle nicht archivierten `open`- und `done`-To-dos aus Ticket 02.
  `open` steht vor `done`; innerhalb derselben Gruppe gilt die bestehende
  stabile Aktualitaets-/Prioritaetssortierung.

Der E-Mail-Tab ist damit eine mobile Attention-/Triage-Ansicht und kein voller
Provider-Posteingang. Betreff, Absenderanzeige, Status, Prioritaet, Workspace
und naechste Aktion duerfen im Listen-DTO stehen; Body, Secrets, Token,
vollstaendige Header und Empfaengerlisten gehoeren nicht hinein.

### 2. Badge-Semantik

| Anzeige | Exakte Semantik | Nicht enthalten |
| --- | --- | --- |
| Untertab `Notifications` | Anzahl ungelesener, aktiver Notification-Items der vier oben genannten Typen | E-Mails, To-dos, gelesene oder dismissed Items |
| Untertab `E-Mails` | Anzahl deduplizierter, aktionserforderlicher E-Mail-Vorgaenge | beantwortete/geschlossene Faelle, gesendete/verworfenene Entwuerfe, rohe Provider-Unreads |
| Untertab `To-dos` | Anzahl `open`-To-dos unabhaengig von `readState` | `done`, `archived`; `todoUnread` ist kein sichtbares Tab-Badge |
| Bottom-Navigation `Inbox` | exakt derselbe Wert wie Untertab `Notifications` | E-Mail-Attention und offene/ungelesene To-dos |
| OS-App-Icon und Push `badge` | exakt derselbe Wert wie Bottom-Navigation `Inbox` | E-Mail-Attention und offene/ungelesene To-dos |

Alle sichtbaren Badges werden bei `0` ausgeblendet und ab `100` als `99+`
dargestellt. Der Server liefert weiterhin die ungekappte Ganzzahl; nur die UI
formatiert. Der Ausdruck "wichtige ungelesene Notifications" aus dem Ticket
bezeichnet alle in die aktive Notification-Kategorie aufgenommenen Ereignisse,
nicht nur `priority = high`.

Der bestehende kombinierte `unreadCount` der Web Notification Central bleibt
waehrend der additiven Migration kompatibel. Web und Mobile verwenden aber
dieselbe neue Kategorieprojektion. Eine bewusste spaetere Umstellung des
Web-Glockenbadges auf Notification-only ist kein versteckter Bestandteil
dieses Mobile-Tickets.

### 3. Read-, Attention- und Lifecycle-Aktionen

- Das Oeffnen einer ungelesenen Notification darf sie ueber die bestehende
  Item-Action als gelesen markieren.
- Das Oeffnen eines E-Mail-Vorgangs loest dessen Attention nicht automatisch.
  Erst eine fachliche Statusaenderung am Fall oder Review-Entwurf veraendert
  den E-Mail-Count.
- Das Oeffnen eines To-dos darf seinen nutzerbezogenen Read-State setzen; es
  bleibt unabhaengig davon sichtbar und zaehlt weiter im To-do-Badge, solange
  es `open` ist.
- Eine Bulk-Aktion muss kategoriegebunden sein. Ein neuer Client verwendet
  `mark_category_read` fuer `notifications`; der bestehende globale
  `mark_all_read`-Alias bleibt nur fuer alte Clients kompatibel. E-Mail-
  Attention kann nicht durch eine generische Read-Aktion geleert werden.

### 4. Laden, Fehler, Offline und Refresh

- Beim ersten Laden zeigt nur die aktive Liste Skeletons. Die Tableiste und
  bereits bekannte Counts bleiben bedienbar.
- Jeder Tab besitzt einen eigenen Leerzustand mit klarer Kategoriebezeichnung
  und einer passenden naechsten Aktion. Ein nicht konfiguriertes E-Mail-System
  ist kein Fehler, sondern ein Empty State mit Link zum vorhandenen Setup.
- Bei einem Refetch bleibt vorhandener Inhalt sichtbar. Ein Fehler erscheint
  als Inline-Banner mit `Erneut versuchen`, nicht als blockierende Vollseite.
- Offline werden gecachte Daten mit sichtbarem Stale-Hinweis gezeigt. Es gibt
  keine Offline-Mutationsqueue. Read-, Dismiss-, Status- und Lifecycle-Aktionen
  sind bis zum Reconnect deaktiviert oder schlagen sichtbar fehl.
- Pull-to-refresh invalidiert zuerst die Count-Query und danach die aktive
  Kategorienliste. Es laedt nicht automatisch alle drei kompletten Listen.
- App-Fokus, Reconnect, erfolgreicher Item-Mutation, passender Push/Deep Link
  und vorhandene `session_updated`-/`todo_updated`-/Notification-Ereignisse
  invalidieren die betroffenen Query-Keys gezielt.

## Zielvertrag der Mobile-API

### Kategorie-Counts und globales Badge

`GET /api/mobile/v1/inbox/badge` bleibt additiv kompatibel. `count` behaelt
seinen skalaren Typ, wird aber zum kanonischen Notification-only-Badge. Die
Response wird erweitert:

```json
{
  "success": true,
  "count": 4,
  "categories": {
    "notifications": { "badge": 4 },
    "emails": { "badge": 3 },
    "todos": { "badge": 8 }
  },
  "generatedAt": "2026-08-22T12:00:00.000Z"
}
```

Die Count-Action fuehrt exakte DB-Counts aus. Sie verwendet weder die erste
Listenseite noch `MAX_SOURCE_ITEMS`. Dieselbe Action speist
`countMobileAppBadgeForUserId`, Push-Payloads, iOS-Widget-Refresh und die
additiven Kategorie-Counts der Listen- und Web-Summary-Responses.

### Getrennte Listen

Die bestehenden Endpunkte bleiben erhalten:

```text
GET /api/mobile/v1/inbox?filter=notifications&limit=...&cursor=...
GET /api/mobile/v1/inbox?filter=emails&limit=...&cursor=...
GET /api/mobile/v1/inbox?filter=todos&limit=...&cursor=...

GET /api/mobile/v1/inbox/aggregate?filter=notifications&limit=...&cursor=...
GET /api/mobile/v1/inbox/aggregate?filter=emails&limit=...&cursor=...
GET /api/mobile/v1/inbox/aggregate?filter=todos&limit=...&cursor=...
```

`emails` wird additiv in `MOBILE_INBOX_FILTERS` aufgenommen. Jeder Cursor ist
an Scope, Kategorie, Sortierzeitpunkt, Workspace und stabile Item-ID gebunden.
Ein Cursor einer anderen Kategorie oder eines geaenderten Workspace-Scope wird
weiterhin mit `INVALID_CURSOR` abgewiesen.

Listenantworten erhalten additiv dieselbe `categories`-Struktur wie die Badge-
Response. Die bisherigen `counts`-Felder sowie `all`, `unread`, `chat`,
`studio` und `automation` bleiben fuer alte Clients erhalten. Neue Clients
verwenden fuer sichtbare Badges ausschliesslich `categories`.

Ein E-Mail-Item hat mindestens folgenden redigierten Vertrag:

```json
{
  "id": "email-case:<caseId>",
  "type": "email.attention",
  "category": "emails",
  "title": "Subject",
  "detail": "Awaiting review",
  "occurredAt": "2026-08-22T11:30:00.000Z",
  "unread": false,
  "attentionRequired": true,
  "priority": "high",
  "workspaceId": "<workspaceId>",
  "target": {
    "kind": "email",
    "scope": "workspace",
    "caseId": "<caseId>",
    "draftId": "<optionalDraftId>"
  }
}
```

`unread` bleibt fuer alte generische Renderer vorhanden, ist bei E-Mail-
Attention aber nicht die Badgeautoritaet. Dafuer ist
`attentionRequired = true` explizit. Persoenliche E-Mail-Faelle werden dem
persoenlichen Mobile-Workspace des Users zugeordnet, ohne eine versteckte
Team-Workspace-Zuordnung zu erzeugen.

### Actions und Deep Links

Der PATCH-Vertrag wird additiv um eine kategoriegebundene Bulk-Aktion
erweitert:

```json
{
  "action": "mark_category_read",
  "category": "notifications",
  "workspaceId": "<optional bei Aggregate>"
}
```

Nur `notifications` ist fuer diese Aktion zulaessig. Bestehende
`mark_item_read`, `set_item_read_state`, `dismiss_item` und `mark_all_read`
bleiben kompatibel. Nach jeder Mutation laedt der Client die kanonischen
Counts neu; er berechnet keine dauerhafte Badgewahrheit durch lokales
Inkrementieren oder Dekrementieren.

Notification-, E-Mail- und To-do-Ziele erhalten je einen typisierten nativen
Deep Link. Bei App-Kaltstart werden Auth, Instanz und Workspace zuerst
aufgeloest. Ein nicht mehr lesbares Ziel fuehrt in den passenden Tab mit einer
stabilen "nicht mehr verfuegbar"-Meldung und niemals in einen fremden
Workspace oder auf eine WebView mit internen Daten.

### Capability und Rollout

Die Server-Capabilities werden additiv um mindestens
`inbox.categories.v1` und `inbox.email_attention` erweitert. Der Mobile-Client
aktiviert die Drei-Tab-UI erst, wenn `inbox.categories.v1` vorhanden ist. Bei
einem aelteren kompatiblen Server bleibt die bisherige Inboxdarstellung aktiv;
es gibt keinen teilweisen E-Mail-Tab mit clientseitig geratenen Counts.

## Zielarchitektur im Server-Repository

### Gemeinsame Kategorie- und Count-Grenze

Eine schmale gemeinsame Action, beispielsweise
`app/lib/mobile/inbox-counts.ts`, liefert explizit:

```ts
type MobileInboxCategoryCounts = {
  notifications: { badge: number };
  emails: { badge: number };
  todos: { badge: number };
};
```

Sie orchestriert fachliche Count-Queries mit explizitem `userId` und bereits
autorisiertem Workspace-Scope. Die Inbox-Route, Badge-Route, Web-Summary und
Push-Schicht verwenden diese Action. Push und HTTP bilden die Semantik nicht
erneut in eigenen Filtern nach.

Die wiederverwendbaren Datenbankmechaniken bleiben klein und
quellenspezifisch: Notification-Count, E-Mail-Attention-Count und
Open-To-do-Count. Scopeentscheidung, Kategoriezuordnung und Fehlerklassifikation
bleiben in der Action; Providerzugriff, HTTP-Response und Clientcache gehoeren
nicht in die Count-Module.

### E-Mail-Attention-Read-Model

Ein neues Modul, beispielsweise `app/lib/email/inbox-attention.ts`, baut aus
den vorhandenen Tabellen ein paginierbares, redigiertes Read-Model. Es:

1. prueft persoenlichen Owner beziehungsweise `canRead` des exakten Workspace;
2. selektiert nur die oben festgelegten aktiven Fall- und Draftzustaende;
3. verknuepft Drafts ueber `inbox_case_id` beziehungsweise
   `personal_inbox_case_id`;
4. erzeugt pro Fall genau einen Attention-Eintrag und nur fuer Drafts ohne
   Fallbezug einen eigenstaendigen Eintrag;
5. zaehlt nach derselben Deduplizierung, mit der die Liste erzeugt wird;
6. sortiert deterministisch nach `updatedAt`, Workspace und stabiler ID;
7. gibt keine Secret-Referenz, Mailbox-Credentials, Bodies oder vollstaendigen
   Providerheader aus.

Die Mobile-Inbox ruft keine bestehenden HTTP-E-Mail-Routen intern per `fetch`
auf. Sie verwendet das gemeinsame Read-Model direkt. Die allgemeinen
`listEmailMessages`-/IMAP-/OAuth-Mechaniken bleiben unangetastet, weil sie einen
anderen Produktflow bedienen.

### Kategoriegebundene Pagination

Der neue Kategoriepfad darf nicht zuerst bis zu 200 gemischte Items laden und
danach filtern. Fuer jede angeforderte Kategorie werden nur die benoetigten
Quellen cursorgebunden abgefragt:

- Notifications: pro Notification-Quelle maximal `limit + 1`, anschliessend
  stabil zusammenfuehren;
- E-Mails: deduplizierte SQL-/Read-Model-Abfrage mit `limit + 1`;
- To-dos: vorhandene To-do-Query mit Lifecyclefilter und stabilem Cursor,
  anschliessend bestehende Aggregate-Deduplizierung beibehalten.

Der Legacy-`all`-Feed darf intern vorerst den bisherigen Sammler verwenden,
solange seine Kompatibilitaet dokumentiert bleibt. Sichtbare neue Tabs und
ihre Counts duerfen nicht von dessen Limitierung abhaengen.

## Sequenzielle Implementierungsphasen

### Phase 0: Mobile-Bestand und Vertrag einfrieren

- Im privaten `canvas-notebook-mobile`-Repository die tatsaechlichen Inbox-
  Route-, Tab-Layout-, API-Client-, Query-Key-, Badge-, Push- und Deep-Link-
  Dateien inventarisieren.
- Den derzeitigen Fallback fuer Server ohne `inbox.categories.v1` festhalten.
- Server- und Mobile-Fixtures fuer Kategorie-Counts, Items, Cursor, Fehlercodes
  und Deep Links identisch versionieren.
- Keine UI-Implementierung beginnen, bevor die oben definierte E-Mail-
  Attention-Semantik und der Notification-only-Globalbadge in beiden
  Repositories dokumentiert sind.
- Verifikation: reiner Contract-/Dateibaum-Review; noch kein Produktcode.
- Commit im Mobile-Repository nur, falls dort eine Contractdokumentation
  versioniert wird: `Document mobile inbox category contract`.

### Phase 1: Exakte Kategorie-Counts und E-Mail-Read-Model bauen

- `app/lib/email/inbox-attention.ts` mit Scope, Statusfilter,
  Fall-/Draft-Deduplizierung, Cursor und Count implementieren.
- Eine gemeinsame Mobile-Inbox-Count-Action einfuehren und Notification-,
  E-Mail- sowie Open-To-do-Counts ueber exakte Queries liefern.
- `app/lib/mobile/app-badge.ts` auf den gemeinsamen Notification-only-Count
  umstellen; die oeffentlichen Wrapper fuer Push und Badge-Route beibehalten.
- Tests fuer mehr als 200 Eintraege, Fall/Draft-Deduplizierung, persoenliche
  Isolation, Cross-Workspace-Ablehnung, ausgeschlossene Lifecyclezustaende und
  exakte Count-Paritaet ergaenzen.
- Verifikation: fokussierte Store-/Read-Model-/Count-Tests und TypeScript.
- Commit: `Add exact mobile inbox category counts`.

### Phase 2: Additiven Mobile- und Web-Vertrag ausliefern

- `app/lib/mobile/inbox.ts` um `emails`, `email.attention`, `category`,
  `attentionRequired` und den E-Mail-Targettyp erweitern.
- Kategoriegebundene, nicht auf `MAX_SOURCE_ITEMS` basierende Listenpfade fuer
  Notifications, E-Mails und To-dos einbauen; Legacyfilter kompatibel lassen.
- `/api/mobile/v1/inbox`, `/aggregate` und `/badge` um die neue
  `categories`-Struktur, E-Mail-Items und stabile Fehlercodes ergaenzen.
- `mark_category_read` auf Notifications begrenzen und in Workspace- sowie
  Aggregate-Route identisch autorisieren.
- `app/api/notifications/summary/route.ts` und
  `app/components/notifications/notification-summary.ts` additiv auf das
  gemeinsame Category-DTO erweitern. Bestehende Web-Sektionen und
  `unreadCount` bleiben kompatibel.
- `app/lib/mobile/compatibility.ts`, `app/lib/mobile/bootstrap.ts` und ihre
  exakten Capabilitytests um `inbox.categories.v1` und
  `inbox.email_attention` erweitern.
- `app/lib/mobile/push-devices.ts` so anbinden, dass sichtbarer Push,
  Widget-Refresh, `/inbox/badge` und Bottom-Tab denselben Notification-Count
  erhalten. Die E-Mail-Push-Praeferenz wird fachlich benannt statt dauerhaft
  ueber `todo_attention` versteckt zu bleiben; eine additive Migration behaelt
  den bisherigen Userwert.
- Verifikation: Mobile-Inbox-, Notification-Summary-, Push-, Capability-,
  Auth-, Cursor- und Scope-Vertragstests; anschliessend `npm run build`.
- Commit: `Expose categorized mobile inbox contract`.

### Phase 3: Mobile Query-Schicht und Tab-Shell umstellen

- Den generierten beziehungsweise typisierten Mobile-Client erst nach
  erfolgreichem Capability-Handshake auf den neuen Vertrag aktualisieren.
- Getrennte Query-Keys fuer Counts und die drei paginierten Kategorien
  einfuehren; Instanz-ID, Nutzer, Inbox-Scope und Kategorie muessen Bestandteil
  des Keys sein.
- Die Inbox-Route in eine zugreifbare Drei-Tab-Shell mit der festgelegten
  Reihenfolge, lokalem Last-Tab-State und `99+`-Formatierung umbauen.
- Count-Query und aktive Liste getrennt laden. Ein Listenfehler darf die
  Navigation und bereits bekannte Counts nicht loeschen.
- Pull-to-refresh, Fokus- und Reconnect-Invalidierung gemaess UX-Vertrag
  implementieren.
- Verifikation: Komponenten-/Hook-Tests fuer Tabwechsel, Query-Key-Isolation,
  Stale-Daten, Retry und Server-Capability-Fallback.
- Commit im Mobile-Repository: `Add categorized inbox shell`.

### Phase 4: Notifications und globale Badges integrieren

- Nur Notification-Items im ersten Tab darstellen und bestehende Chat-,
  Studio- und Automation-Deep-Links beibehalten.
- Notification-Read und Dismiss als serverbestaetigte Mutationen ausfuehren;
  danach Notificationliste und Count-Query invalidieren.
- Bottom-Tab-Badge und OS-App-Badge ausschliesslich aus
  `categories.notifications.badge` speisen.
- Push-Kaltstart, Push im Vordergrund, Widget-Refresh, App-Fokus und manuelles
  Lesen auf denselben Count abgleichen. Lokale optimistische Werte duerfen nur
  temporaer sein und werden immer durch die Serverantwort ersetzt.
- Verifikation: Mobile-Komponententests sowie Push-/Deep-Link-Fixtures fuer
  Chat, Studio und Automation; keine reale Push-Zustellung ohne gesonderte
  Testfreigabe.
- Commit im Mobile-Repository: `Sync inbox notification badges`.

### Phase 5: E-Mail-Tab integrieren

- Deduplizierte E-Mail-Faelle und Review-Entwuerfe mit Status, Prioritaet,
  Workspace und naechster Aktion darstellen.
- Persoenliche und Workspace-Ziele anhand des typisierten Targets oeffnen;
  Rechte und Existenz nach Navigation erneut serverseitig pruefen.
- Das Oeffnen darf den Attention-Count nicht lokal entfernen. Erst die
  bestaetigte Fall-/Draftmutation invalidiert E-Mail-Liste und Counts.
- Empty State zwischen "keine Aufmerksamkeit" und "keine E-Mail-Quelle
  eingerichtet" unterscheiden, ohne Providerfehler oder Secrets anzuzeigen.
- Verifikation: Komponenten-/Contract-Tests fuer persoenliche und Workspace-
  Faelle, verknuepfte und eigenstaendige Drafts, fehlende Berechtigung,
  geloeschtes Ziel und Statuswechsel.
- Commit im Mobile-Repository: `Add email attention inbox tab`.

### Phase 6: To-do-Tab integrieren

- Persistente `open`- und `done`-Items aus Ticket 02 darstellen; gruppierte
  Workspace-To-dos weiterhin aufloesbar halten.
- Das sichtbare Tab-Badge ausschliesslich aus `categories.todos.badge`
  (`open`) speisen, nie aus `todoUnread`.
- Read-/Unread-Toggle, Oeffnen, Done/Reopen und Archivieren gezielt
  invalidieren. Read-Toggle aendert weder Sichtbarkeit noch Open-Count;
  Done/Reopen aendert den Count, Archivieren entfernt das Item.
- Verifikation: Komponenten-/Contract-Tests fuer gelesenes offenes, gelesenes
  erledigtes, wieder geoeffnetes, archiviertes und gruppiertes To-do.
- Commit im Mobile-Repository: `Keep todos visible in mobile inbox`.

### Phase 7: Zustaende, Accessibility und Synchronisation haerten

- Deutsche und englische Labels, Leerzustaende, Fehlertexte und
  Accessibility-Labels fuer Tabs und Badges vervollstaendigen.
- Screenreader sollen Tabname und ungekappte Countbedeutung ansagen; `99+` ist
  nur die visuelle Darstellung.
- Offline-, Reconnect-, Kaltstart-, Workspace-Ausschluss- und Sessionwechsel-
  Verhalten pruefen. Logout und Instanzwechsel loeschen alle nutzer- und
  instanzgebundenen Inbox-Caches.
- Race-Test: Item wird auf einem zweiten Client gelesen/abgeschlossen, waehrend
  die App eine alte Seite zeigt; der naechste Sync korrigiert Item und Badge
  ohne Duplikat oder negativen Count.
- Verifikation: automatisierte Mobile-Tests. Reale iOS-/Android-Abnahme,
  Maestro, Browser oder Playwright nur nach ausdruecklicher Freigabe.
- Commit im Mobile-Repository: `Harden mobile inbox synchronization`.

### Phase 8: Gemeinsame Abnahme und Ticketabschluss

- Zuerst alle Server-Vertragstests und `npm run build` im Server-Repository
  ausfuehren. Ein Container wird nur auf explizite Anforderung gebaut.
- Danach Mobile-Typecheck, Unit-/Komponententests und den freigegebenen nativen
  Abnahmeweg im Mobile-Repository ausfuehren.
- Die Testmatrix auf mindestens einer persoenlichen und einer Team-/Projekt-
  Workspace-Fixture durchlaufen; keine produktiven Postfaecher, Secrets oder
  Push-Tokens verwenden.
- Produktdokumentation fuer Mobile Inbox, Badge-Semantik und E-Mail-Attention
  aktualisieren.
- Erst nach belegter Server-/Client-Abnahme Ticket und Index auf `erledigt`
  setzen. Planung allein erfuellt diese Phase nicht.
- Abschlusscommits getrennt je Repository, zum Beispiel
  `Complete mobile inbox categories ticket`.

## Dateibezogener Aenderungsplan

### Bestaetigte Serverpfade

| Pfad | Geplante Verantwortung |
| --- | --- |
| `app/lib/email/inbox-attention.ts` (neu) | Scopegebundenes, redigiertes und dedupliziertes E-Mail-Attention-Read-Model mit Cursor und Count. |
| `app/lib/mobile/inbox-counts.ts` (neu, Name bei Umsetzung bestaetigen) | Gemeinsame Kategorie-Count-Action fuer Mobile, Web, Badge und Push. |
| `app/lib/mobile/inbox.ts` | Additive Kategorie-/Itemtypen, `emails`-Filter, getrennte Pagination und category-spezifische Actions. |
| `app/lib/mobile/app-badge.ts` | Notification-only-Resolver als einzige globale Badgequelle. |
| `app/lib/mobile/inbox-route.ts` | Stabile, redigierte Kategoriefehler und unveraenderte No-Store-Header. |
| `app/api/mobile/v1/inbox/route.ts` | Workspacegebundene Kategorienliste und Actions. |
| `app/api/mobile/v1/inbox/aggregate/route.ts` | Aggregate-Kategorienliste und kategoriegebundene Bulk-Actions. |
| `app/api/mobile/v1/inbox/badge/route.ts` | Additive Drei-Kategorien-Countresponse bei kompatiblem Skalarfeld `count`. |
| `app/api/notifications/summary/route.ts` | Gemeinsame Kategorie-Counts und optionale E-Mail-Sektion ohne Bruch des Web-Legacyvertrags. |
| `app/components/notifications/notification-summary.ts` | Additive Web-Typen fuer die gemeinsame Response; keine Mobile-Badgeentscheidung im Client. |
| `app/lib/mobile/push-devices.ts` | Gemeinsamer Notification-Badgewert und explizite E-Mail-Praeferenzmigration. |
| `app/lib/mobile/compatibility.ts`, `app/lib/mobile/bootstrap.ts` | Capability-Gate fuer den neuen Vertrag. |
| `scripts/mobile-inbox-todos-test.ts` | Bestehende Regressionen fuer Ticket 02 und Legacyvertrag erhalten. |
| `scripts/mobile-inbox-categories-test.ts` (neu) | Fokussierter Kategorie-, Count-, Cursor-, E-Mail- und Scope-Vertrag. |
| `scripts/mobile-push-devices-test.ts` | Paritaet von API-, Push-, Widget- und Notification-only-Badge. |
| `scripts/email-account-workspace-binding-test.ts` | E-Mail-Scope, Deduplizierung und Lifecycle als Domainregression. |
| `scripts/mobile-bootstrap-test.ts`, `scripts/mobile-compatibility-test.ts` | Exakte neue Capabilitylisten und alter Fallback. |

Ob ein separates `inbox-counts.ts` noetig ist, wird an der Wiederverwendung
entschieden: Da mindestens Badge-Route, Push, Mobile-Listen und Web-Summary die
gleiche Mechanik benoetigen, ist eine gemeinsame Action gerechtfertigt. Das
E-Mail-Read-Model bleibt dennoch in der E-Mail-Domaene; `inbox.ts` soll kein
neuer God-Service fuer Provider-, E-Mail- und To-do-Interna werden.

### Mobile-Repository

Vor Phase 3 muessen die tatsaechlichen Pfade im privaten Repository ermittelt
werden. Unabhaengig von deren Namen sind folgende Verantwortungen getrennt zu
halten:

- Expo-Router-Inboxroute und Bottom-Tab-Konfiguration;
- typisierter/generated Mobile-API-Client und Runtime-Validatoren;
- Query-Keys, Infinite Queries und Mutationsinvalidierung;
- reine Tab-/Badge-/State-Komponenten;
- Notification-, E-Mail- und To-do-Itemrenderer;
- Push-/Deep-Link-Router;
- instanz- und nutzergebundener Cache-/Logout-Lifecycle;
- deutsche/englische Texte sowie Accessibility-Labels.

Die Dateinamen werden nicht aus dem Serverplan erfunden. Phase 0 traegt die
gefundenen Pfade in die Mobile-Implementierungsnotiz ein, bevor der erste
Clientcode geaendert wird.

## Testmatrix fuer die spaetere Umsetzung

| Bereich | Positiver Fall | Negativer/Abgrenzungsfall |
| --- | --- | --- |
| Notification-Count | Chat, Studio und Automation werden nach bestehender Unread-Regel exakt gezaehlt | To-dos und E-Mails veraendern Bottom-/OS-Badge nicht |
| E-Mail-Count | aktiver Fall plus verknuepfter Review-Draft ergibt einen Vorgang | beantworteter/geschlossener Fall und sent/discarded Draft zaehlen nicht |
| To-do-Count | jedes `open`-To-do zaehlt unabhaengig vom Read-State | `done` und `archived` zaehlen nicht; Read-Toggle aendert Count nicht |
| Grosse Datenmenge | mehr als 200 Eintraege liefern exakten Count und lueckenlose Cursorseiten | kein Count wird aus `MAX_SOURCE_ITEMS` oder sichtbarer Seite abgeleitet |
| Cursor | jede Kategorie paginiert ohne Duplikate oder Luecken | fremder Kategorie-/Scope-Cursor ergibt `INVALID_CURSOR` |
| Workspace-Scope | eingeschlossene lesbare Workspaces erscheinen | ausgeschlossener, inaktiver oder fremder Workspace liefert keine Items/Counts |
| Persoenliche E-Mail | eigener persoenlicher Fall erscheint im persoenlichen Scope | Fall eines anderen Users ist weder list- noch per ID lesbar |
| E-Mail-Datenminimierung | Listen-DTO enthaelt Betreff, Anzeige, Status und Ziel-IDs | Body, Secrets, Token und vollstaendige Header fehlen |
| Read-Actions | Notificationlesen senkt Notificationbadge; To-do-Read-Toggle bleibt sichtbar | E-Mail-Attention kann nicht per generischem Read geleert werden |
| Lifecycle | Done/Reopen und E-Mail-Statuswechsel aktualisieren den richtigen Tabcount | kein lokaler Optimismus bleibt gegen Serverwahrheit stehen |
| Kompatibilitaet | alter Client kann `all`, Legacy-Counts und `mark_all_read` weiter verwenden | neue Drei-Tab-UI startet ohne Capability nicht halb |
| Web-Paritaet | Web-Summary und Mobile verwenden dieselbe Kategorieprojektion | Web-Legacybadge wird nicht unbemerkt durch dieses Ticket umdefiniert |
| Push/Deep Link | Push, Bottom-Tab und `/inbox/badge` gleichen sich nach Sync an | geloeschtes/fremdes Ziel leakt keine Daten und blockiert Navigation nicht |
| Offline/Cache | gecachte Tabs bleiben mit Stale-Hinweis lesbar | keine Read-/Lifecycle-Mutation wird offline still gequeued |
| Logout/Instanzwechsel | alle Inbox-Caches werden sauber neu namespaced | Daten des vorigen Users oder Servers blitzen nicht auf |

## Abnahmecheckliste

### Automatisiert

- Exakte Kategorie-Counts einschliesslich Datensatzmengen ueber 200.
- Einzel- und Aggregate-Cursor fuer alle drei Kategorien.
- Personal-, Team-, Projekt- und Organisationsscope sowie ausgeschlossene
  Workspaces.
- E-Mail-Fall-/Draft-Deduplizierung und alle definierten Lifecyclezustaende.
- To-do-Read-/Lifecycle-Trennung aus Ticket 02.
- Notification-only-Badgeparitaet in Badge-Route, Push und Widget-Refresh.
- Capability-Fallback fuer alte Server und additive Responsekompatibilitaet.
- Mobile Query-Key-, Mutation-, Offline-, Reconnect- und Logouttests.
- `npm run build` fuer den geaenderten Server-/Web-Anteil vor jeder optionalen
  Containerarbeit.

### Manuell nach expliziter Freigabe

- iOS und Android: Tabreihenfolge, Safe Areas, grosse Schrift, Dark Mode,
  Screenreader, `99+` und lange deutsche/englische Labels.
- Pull-to-refresh und Retry bei gezielt simuliertem Listenfehler pro Tab.
- Kaltstart aus Chat-, E-Mail- und To-do-Deep-Link.
- Zwei-Client-Synchronisation nach Read-, Done/Reopen-, Archiv- und
  E-Mail-Statusaenderung.
- Bottom-Tab- und OS-App-Badge nach Push, Vordergrund, Reconnect und Logout.

Browser, Playwright, Maestro, Dev-Server, Container und reale Provider werden
nicht im Rahmen der Planerstellung ausgefuehrt. Die spaetere manuelle Abnahme
verwendet ausschliesslich kontrollierte Testdaten und beginnt erst nach
ausdruecklicher Freigabe.

## Definition of Done

- Mobile zeigt genau Notifications, E-Mails und To-dos als getrennte Tabs.
- Jede Kategorie besitzt eine unabhaengige, lueckenlos paginierte Liste und
  einen exakten serverseitigen Badgewert.
- Bottom-Tab, OS-App-Icon, Push und Widget verwenden denselben
  Notification-only-Count; E-Mails und To-dos sind ausgeschlossen.
- E-Mail-Attention stammt aus persistierten, scopegeprueften und deduplizierten
  Faellen/Review-Entwuerfen, nicht aus live aggregierten Providerpostfaechern.
- Gelesene offene To-dos bleiben sichtbar; ihr sichtbares Tab-Badge folgt nur
  dem Lifecycle `open`.
- Bestehende Clients und die Web Notification Central funktionieren mit dem
  additiven Vertrag weiter.
- Lade-, Leer-, Fehler-, Offline-, Refresh-, Deep-Link- und Logoutverhalten
  sind fuer beide Plattformen belegt.
- Server- und Mobile-Pruefungen sowie der Serverbuild sind erfolgreich; eine
  freigegebene manuelle UI-/Geraeteabnahme ist dokumentiert.
- Erst dann werden Ticket 03 und der Index als erledigt markiert. Dieser
  Planungscommit allein ist keine Produktabnahme.
