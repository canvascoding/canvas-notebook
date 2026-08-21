---
title: 'Umsetzungsplan zu Ticket 14: To-do-Sichtbarkeit, Filter und Priorisierung korrigieren'
status: planned
date: 2026-08-22
platforms: [web, server, mobile-api]
tags: [type/implementation-plan, topic/todos, topic/workspaces, topic/ui]
---

# Umsetzungsplan: To-do-Sichtbarkeit, Filter und Priorisierung

## Auftrag und Grenzen dieses Dokuments

Dieser Plan konkretisiert
[Ticket 14](./14-todo-sichtbarkeit-filter-und-priorisierung.md) auf dem aktuellen
Repository-Stand nach Ticket 02. Er beschreibt eine spaetere Umsetzung; in der
Planungsarbeit wurden keine Produktdateien, Tests, Konfigurationen oder
Deployment-Artefakte geaendert und keine Laufzeitpruefungen ausgefuehrt.

Die Implementierung soll streng sequenziell erfolgen. Eine Phase beginnt erst,
wenn Vertrag, Code, Tests und Commit der vorherigen Phase abgeschlossen sind.
Der Ticketstatus bleibt bis zur vollstaendigen technischen und spaeter
freigegebenen UI-Abnahme offen.

## Fachliche Leitentscheidungen

### Sichtbarkeit, Aufmerksamkeit und Filter bleiben getrennt

- **Sichtbarkeit** beantwortet, ob der angemeldete Nutzer das To-do aufgrund
  seines persoenlichen Eigentums oder seines aktuellen Workspace-Zugriffs
  ueberhaupt lesen darf.
- **Lebenszyklus** (`open`, `done`, `archived`) ist ein Listenfilter. Wie in
  Ticket 02 bleiben `open` und `done` grundsaetzlich auffindbar; `archived`
  erscheint nur bei einem expliziten Archiv-/Alle-Filter.
- **Read-State** (`read`/`unread`) ist der nutzerbezogene
  Aufmerksamkeitsstatus aus `todo_read_states`. Er darf die grundsaetzliche
  Sichtbarkeit eines nicht archivierten To-dos nicht veraendern.
- **Assignee, Creator, Kategorie, Quelle, Prioritaet, Faelligkeit und Suche**
  schraenken nur den bereits autorisierten Ergebnisscope ein. Kein Filterwert
  darf Zugriff auf einen weiteren Nutzer oder Workspace erteilen.

### Drei explizite Listenscopes

Der kanonische Vertrag unterscheidet genau drei Modi:

| Scope | Enthaltene To-dos | Nicht enthalten |
| --- | --- | --- |
| `personal` | `scope_kind = user`, `workspace_type = personal` und `user_id = viewer` | workspace-gescopte To-dos, auch aus persoenlichen Workspaces |
| `workspace` | `scope_kind = workspace` und exakt die serverseitig aufgeloeste `workspace_id` | nutzer-gescopte To-dos und jeder andere Workspace |
| `global` | persoenliche To-dos des Viewers plus workspace-gescopte To-dos aus allen aktuell lesbaren Workspaces | inaktive, entfernte oder nicht lesbare Workspaces |

Damit ist die bisher mehrdeutige Bedeutung einer persoenlichen
Workspace-Ansicht beseitigt: Ein Filter auf einen konkreten persoenlichen
Workspace ist ebenso exakt wie ein Team- oder Projekt-Workspace-Filter.
Legacy-Aufrufe ohne realen Workspace werden explizit auf `personal` abgebildet;
sie werden nicht einem beliebigen persoenlichen Workspace zugerechnet.

### Owner- und Assignee-Isolation

- Bei `personal` ist `todo_items.user_id` die Eigentumsgrenze. Nur derselbe
  Nutzer darf den Datensatz sehen; `created_by_user_id` ist Creator-Metadatum
  und keine alternative Berechtigung.
- Bei `workspace` ist der konkrete Workspace die Leseberechtigungsgrenze. Ein
  persoenlicher Workspace ist nur fuer seinen Owner lesbar. Organisation und
  Team erfordern weiterhin aktiven Lesezugriff, Projekte weiterhin aktiven
  Projektzugriff.
- Bei einem geteilten To-do ist `assignee_user_id` eine Zuweisung innerhalb des
  zulaessigen Workspace-Scopes. Die Zuweisung erteilt ohne Workspace-Zugriff
  keinen Lesezugriff und entzieht anderen berechtigten Workspace-Lesern nicht
  automatisch die Sichtbarkeit.
- `created_by_user_id` und `assignee_user_id` werden nicht als Synonyme fuer
  `user_id` behandelt. API- und UI-Texte muessen deshalb Creator, Assignee und
  persoenliches Eigentum begrifflich trennen.
- Ein Zugriffsverlust wirkt bei der naechsten Abfrage. Caches, Cursor und
  Deep-Links duerfen einen zuvor erlaubten Workspace nicht weiter lesbar
  machen.

### Kanonische Priorisierung

Alle eigenstaendigen To-do-Listen verwenden fuer denselben Scope und dieselben
Filter dieselbe stabile Sortiertupel-Reihenfolge:

1. Lebenszyklus: `open`, dann `done`, dann `archived`;
2. Prioritaet: `high`, dann `normal`, dann `low`;
3. fuer offene To-dos Faelligkeitsklasse: ueberfaellig, heute, zukuenftig,
   ohne Faelligkeit;
4. `due_at` aufsteigend, `NULL` zuletzt;
5. `created_at` absteigend;
6. `id` absteigend als eindeutiger Tie-Breaker.

Bei einem expliziten Statusfilter entfaellt lediglich der konstante erste
Rang. Ein Read-/Unread-Toggle veraendert diese Reihenfolge nicht. Eventlisten
duerfen weiterhin nach Ereigniszeit sortieren; ihre getrennte persistente
To-do-Sektion muss jedoch die kanonische To-do-Reihenfolge verwenden.

Die Begriffe `heute` und `ueberfaellig` benoetigen einen serverseitig
ausgewerteten Zeitzonenvertrag. Die Implementierung soll eine validierte
IANA-Zeitzone in den Filterkontext und die Cursor-Signatur aufnehmen. Fehlt sie
bei einem Legacy-Client, ist der dokumentierte Server-Fallback anzuwenden; Web
und Mobile duerfen denselben Request nicht lokal unterschiedlich nachsortieren.

## Belegte Inventur des aktuellen Stands

### Datenmodell und Store

| Pfad | Heutige Verantwortung | Fuer Ticket 14 relevante Beobachtung |
| --- | --- | --- |
| `app/lib/db/schema.ts` | `todo_items`, `todo_read_states`, Kategorien und Dateilinks | `todo_items` besitzt `user_id`, Creator, Assignee, Organization/Projekt/Workspace, Scope, Status, Prioritaet, Faelligkeit und Zeitstempel. Vorhandene Indizes orientieren sich ueberwiegend an Status und `updated_at`, nicht an der geplanten Rangfolge. |
| `app/lib/todos/scope.ts` | Kleine Scope-DTOs fuer `user` und `workspace` | Ein globaler Scope ist hier noch nicht modelliert. |
| `app/lib/todos/store.ts` | Scope-Aufloesung, Zugriffspruefung, CRUD, Filter, Hydration und Sortierung | `listTodos` mischt Policy und Query. Standard ist persoenlich. `workspaceType = all` benoetigt optional genau eine Organization und bildet keine organisationsuebergreifende globale Sicht ab. Sortiert wird aktuell ausschliesslich nach `updatedAt DESC, id DESC`. |
| `app/lib/todos/read-state-actions.ts` / `read-state-store.ts` | Berechtigte, nutzerbezogene Read-/Unread-Aktionen | Ticket 14 muss diese Quelle wiederverwenden; `seen_at` bleibt nur Kompatibilitaetsalias. |

Aktuell vorhandene Store-Filter sind Status, Kategorie, Source-Type,
Workspace-Type/-ID, Organization, Scope-Kind, Assignee, Due-Bucket, Textsuche
und ein Cursor aus `updatedAt`/`id`. Ein Prioritaets-, Creator-/Owner- oder
Read-State-Filter fehlt. Der vorhandene Cursor kann eine Sortierung nach
Lebenszyklus, Prioritaet und Faelligkeit nicht korrekt fortsetzen.

### Web-API und To-do-Oberflaeche

| Pfad | Heutiger Stand | Luecke |
| --- | --- | --- |
| `app/api/todos/route.ts` | Authentifiziert, loest einen angeforderten Workspace mit `canRead`/`canWrite` auf und ruft `listTodos` auf | GET modelliert nur `user` oder genau einen `workspace`. Es reicht Status, Kategorie, Source, Assignee, Due und Limit weiter, aber weder globale Sicht, Prioritaet, Suche, Read-State noch Cursor. Die Antwort ist eine nackte Datenliste ohne effektiven Scope/Filter/Cursor. |
| `app/api/todos/[id]/route.ts` | Liest ueber `getTodo`, mutiert ueber Store und gemeinsame Read-State-Action | Deep-Link-Lesen prueft zwar den aktuellen Zugriff, traegt aber keinen erwarteten Workspace-Scope; die UI muss einen Scope-Mismatch eindeutig behandeln. |
| `app/apps/todos/components/TodosClient.tsx` | Workspace-, Status- und Kategoriefilter, Liste, Detail und Editor | Die leere Workspace-Auswahl bedeutet `scopeKind=user` und wird mit einem Globus dargestellt, ist aber keine globale Sicht. Beim Start wird bevorzugt der aktive Workspace gewaehlt. Die Liste sendet keine Assignee-, Due-, Priority-, Read-, Such- oder Cursorfilter, obwohl Teile davon serverseitig existieren. |
| `app/components/home/HomeAttentionPanel.tsx` | Zeigt bis zu drei To-dos aus der Notification Summary | Verwendet die zusammengefuehrte Summary-Reihenfolge und baut Workspace-Deep-Links aus den aggregierten Items. |
| `app/components/notifications/NotificationBell.tsx` | Trennt Notifications und persistente To-dos, zeigt Workspace-Namen und Read-Toggle | Die To-do-Sektion uebernimmt die Reihenfolge der Aggregate-Inbox; hohe Prioritaet wird markiert, aber nicht kanonisch einsortiert. |

### Mobile- und Notification-Pfade

| Pfad | Heutiger Stand | Luecke |
| --- | --- | --- |
| `app/lib/mobile/todos.ts` | Workspacegebundene Liste mit Status, Due, Assignee, Suche und `updatedAt`/`id`-Cursor | Fuer einen realen persoenlichen Workspace wird `scopeKind=all` genutzt und dadurch der nutzerbezogene Scope mit dem konkreten Workspace vermischt. Kategorie, Quelle, Prioritaet, Read-State und der neue Cursor fehlen. |
| `app/api/mobile/v1/todos/route.ts` | Erzwingt `X-Canvas-Workspace-Id` ueber `requireRequestWorkspace` | Bietet nur die workspacegebundene Liste; ein kanonischer globaler Vertrag wird nicht verwendet. |
| `app/lib/mobile/inbox.ts` | Sammelt Inbox-Eintraege pro Workspace und aggregiert ueber die erlaubte Workspace-Liste | Persoenliche Nutzer-To-dos koennen in mehreren persoenlichen Workspace-Sammlungen auftauchen und werden erst global nach Todo-ID dedupliziert. Die Sortierung erfolgt nach `occurredAt` (= `todo.updatedAt`) und ID, nicht nach der To-do-Rangfolge. Der Inbox-Priority-Typ reduziert `low` und `normal` beide auf `normal`. |
| `app/lib/mobile/inbox-scope.ts` | Ermittelt aktive, lesbare Workspaces und nutzerbezogene Inbox-Ausschluesse | Diese Aufloesung ist eine belegte Quelle fuer die globale Notification-Sicht, darf aber nicht durch clientseitige Workspace-IDs ersetzt werden. |
| `app/api/notifications/summary/route.ts` | Laedt Notifications und To-dos getrennt aus der Aggregate-Inbox und versieht sie mit Workspace-Namen | Der To-do-Teil ist auf 50 Eintraege begrenzt und besitzt keinen eigenen kanonischen Cursor im Summary-Vertrag. |

### Bestehende Tests

- `scripts/todo-store-test.ts` prueft persoenliche, Team- und Projekt-Scopes,
  Read-State-Isolation, Assignee-Validierung, Status und Due-Filter. Eine
  vollstaendige Mehr-Workspace-/Global-/Sortier-/Cursor-Matrix fehlt.
- `scripts/todo-api-test.mjs` prueft den persoenlichen CRUD-Grundfluss. Exakte
  Workspace-Isolation, globale Sicht und Listenfilter werden dort nicht
  abgedeckt.
- `scripts/mobile-inbox-todos-test.ts` prueft persistente offene/erledigte
  To-dos, Read-State, Aggregate-Inbox, Deduplizierungspraesentation und die
  bestehende Pagination. Die neue Prioritaetsreihenfolge und ein
  Zugriffsverlust zwischen Seiten fehlen.
- Es existieren die npm-Skripte `test:todos:store`, `test:todos:api`,
  `test:todos:assignees` und `test:mobile:inbox`. In dieser Planungsaufgabe
  wurden sie nicht ausgefuehrt.

## Zielarchitektur

### 1. Policy-/Action-Schicht: fachlicher Scope

Eine gemeinsame serverseitige Policy, beispielsweise
`app/lib/todos/list-policy.ts`, erhaelt den authentifizierten Actor und einen
normalisierten Listenrequest. Sie ist verantwortlich fuer:

- Auswahl genau eines der Scopes `personal`, `workspace` oder `global`;
- Aufloesung eines angeforderten Workspace ueber die bestehende
  Workspace-Berechtigungslogik, nicht ueber Client-Metadaten;
- Ermittlung der aktuell lesbaren Workspace-IDs fuer `global`;
- Owner-, Organization-, Team- und Projekt-Isolation;
- Normalisierung von Assignee-/Creator-Filtern nach der Scope-Aufloesung;
- stabile fachliche Fehlercodes und ein strukturiertes `ResolvedTodoListScope`.

Die Policy gibt nur explizite, bereits autorisierte Constraints zurueck, zum
Beispiel:

```ts
type ResolvedTodoListScope =
  | { kind: 'personal'; viewerUserId: string }
  | { kind: 'workspace'; viewerUserId: string; workspace: WorkspaceContext }
  | {
      kind: 'global';
      viewerUserId: string;
      readableWorkspaceIds: string[];
    };
```

Der globale Fall muss alle fuer den Actor lesbaren Organisationen/Projekte
beruecksichtigen; eine einzelne optionale `organizationId` ist keine
ausreichende Sicherheitsgrenze. Leere Workspace-Mengen sind ein gueltiger
globaler Scope, der weiterhin persoenliche To-dos liefern kann.

### 2. Query-Service: gemeinsame Listenmechanik

Eine kleine Query-Schicht, beispielsweise `app/lib/todos/list-query.ts`,
uebernimmt nur wiederverwendbare Mechanik:

- Scope-Constraints in SQL ausdruecken;
- normalisierte Filter anwenden;
- die kanonischen Rang-Ausdruecke anwenden;
- Keyset-Cursor validieren und fortsetzen;
- Relationen und nutzerbezogenen Read-State in Batches hydrieren;
- strukturierte Ergebnisse mit `items` und `nextCursor` liefern.

Sie trifft keine HTTP-, UI- oder Berechtigungsentscheidung und erhaelt den
aufgeloesten Scope als expliziten Parameter. `app/lib/todos/store.ts` bleibt
fuer CRUD und Hydration zustaendig oder delegiert die Listenmechanik schrittweise
an den neuen Service. Die Migration erfolgt Caller fuer Caller, damit nicht
Web, Mobile und Inbox gleichzeitig ohne abgesicherten Zwischenstand umgestellt
werden.

### 3. Route-Adapter

Web-To-dos, Mobile-To-dos und Inbox/Notification Summary parsen ihre jeweiligen
Transportvertraege, rufen aber dieselbe Policy und denselben Query-Service auf.
Sie duerfen keine eigenen SQL-Scopebedingungen, Due-Buckets oder
Client-Nachsortierungen besitzen.

Die Inbox bleibt fachlich eine Orchestrierung mehrerer Ereignistypen. Fuer ihre
To-do-Sektion verwendet sie den gemeinsamen To-do-Listenservice; Chat-, Studio-
und Automation-Ereignisse behalten ihre eigene Ereignislogik.

## Kanonischer Listenvertrag

### Request

Der neue interne DTO soll alle Aufrufer abbilden:

```ts
type TodoListRequest = {
  scope: 'personal' | 'workspace' | 'global';
  workspaceId?: string;
  status?: 'active' | 'open' | 'done' | 'archived' | 'all';
  priority?: 'low' | 'normal' | 'high';
  due?: 'overdue' | 'today' | 'upcoming' | 'none';
  readState?: 'read' | 'unread';
  assignee?: 'me' | 'unassigned' | string;
  createdBy?: 'me' | string;
  categoryId?: string;
  sourceType?: 'user' | 'agent';
  query?: string;
  timeZone?: string;
  cursor?: string;
  limit?: number;
};
```

Vertragsregeln:

- `workspaceId` ist bei `scope=workspace` erforderlich und sonst unzulaessig.
- Unbekannte Enumwerte werden mit `400 INVALID_TODO_FILTER` abgelehnt; sie
  duerfen nicht stillschweigend zum Default werden.
- Der API-Default fuer `status` bleibt `active`; die To-do-UI darf fuer ihre
  Startansicht explizit `open` senden.
- `active` bedeutet `open OR done`, nie `archived`.
- `assignee=me` wird serverseitig aus der Session aufgeloest. Eine konkrete
  Assignee-/Creator-ID wird erst nach dem autorisierten Scope als Filter
  angewandt und kann ihn nur verkleinern. Eine unbekannte oder scopefremde ID
  liefert eine leere Menge, ohne ihre Existenz gesondert zu bestaetigen.
- Leere Suche und leere optionale IDs werden kanonisch entfernt. Laengenlimits
  bleiben serverseitig.
- Read-State-Filter werden ueber `todo_read_states` fuer den Viewer ausgewertet,
  nicht ueber `todo_items.seen_at`.
- `limit` besitzt einen dokumentierten Default und ein gemeinsames Maximum.

Bestehende `scopeKind`, `workspaceId` und Mobile-Header werden waehrend einer
Kompatibilitaetsphase eindeutig auf den neuen Scope gemappt. Mehrdeutige
Kombinationen werden nicht geraten, sondern als `400` beantwortet.

### Response

Neue Listenantworten liefern neben den Items den effektiv angewandten Vertrag:

```json
{
  "success": true,
  "data": {
    "items": [],
    "nextCursor": null,
    "scope": { "kind": "workspace", "workspaceId": "..." },
    "filters": { "status": "open", "priority": "high" },
    "sort": "todo-priority-v1"
  }
}
```

Das Scope-Echo darf nur bereits autorisierte IDs enthalten. Die globale
Antwort muss nicht die gesamte erlaubte Workspace-ID-Liste offenlegen; fuer
die UI genuegen `kind=global` und Workspace-Metadaten pro Item.

### Cursor

Der Cursor ist opaque, versioniert und an Scope, Filter, Zeitzone sowie
Sortierversion gebunden. Er enthaelt die Rangwerte des letzten Elements,
`dueAt`, `createdAt` und `id`. Ein Cursor aus einem anderen Workspace, Filter,
Viewer oder einer alten Sortierversion wird mit einem stabilen
`INVALID_TODO_CURSOR` abgelehnt.

Die Keyset-Bedingung muss exakt dieselbe Tuple-Reihenfolge wie `ORDER BY`
abbilden. Die Garantie gilt fuer einen unveraenderten Datensatz. Mutationen,
die Status, Prioritaet oder Faelligkeit waehrend einer Pagination aendern,
werden durch einen sichtbaren Refresh neu eingeordnet und nicht durch
clientseitiges Zusammenmischen kaschiert.

## Sequenzielle Implementierungsphasen

### Phase 1: Vertrag und Policy isolieren

- Scope-, Filter-, Sortier- und Fehlercode-Typen als serverseitige DTOs
  festlegen.
- Die oben definierten Sichtbarkeitsregeln in einer gemeinsamen List-Policy
  abbilden.
- `personal`, exakten persoenlichen Workspace, Organisation, Team, Projekt und
  `global` gegen die bestehende Workspace-Aufloesung implementieren.
- Assignee und Creator ausschliesslich als einschraenkende Filter behandeln.
- Legacy-Personalzugriff explizit und testbar auf `personal` mappen.
- Zuerst Policy-Tests ohne Umbau der Aufrufer abschliessen.
- Commitvorschlag: `Define canonical todo list scope policy`.

### Phase 2: Query, Filter und stabile Sortierung

- Die Listenquery aus `listTodos` in eine gemeinsame, mit aufgeloestem Scope
  parametrisierte Mechanik ueberfuehren.
- Alle kanonischen Filter inklusive Prioritaet, Read-State, Creator, Suche und
  `due=none` serverseitig implementieren.
- Sortierranks und versionierten Keyset-Cursor gemeinsam implementieren.
- Hydration von Kategorien, Nutzern, Workspace, Dateilinks und Read-State als
  Batchzugriffe erhalten; keine per-Item-Zugriffsabfrage einfuehren.
- Bestehende Indizes mit der realen Queryform und `EXPLAIN QUERY PLAN` bewerten.
  Nur belegte Engpaesse fuehren zu einer gezielten Schema-/Migrationsphase;
  neue Indizes werden nicht allein aus Vermutung hinzugefuegt.
- Store-/Query-Matrixtests und Cursor-Tests abschliessen.
- Commitvorschlag: `Add scoped todo filters and stable ranking`.

### Phase 3: Web-API auf den kanonischen Vertrag umstellen

- `GET /api/todos` auf Policy und Query-Service migrieren.
- Globale Sicht, Filter, Cursor und strukturierte Response additiv einfuehren.
- Bestehende Clients waehrend der Umstellung ueber eine dokumentierte
  Kompatibilitaetsabbildung bedienen; kein stiller Scope-Wechsel.
- `GET /api/todos/[id]` optional den erwarteten Scope entgegennehmen lassen und
  Workspace-Mismatch wie Nicht-Sichtbarkeit behandeln, ohne fremde Existenz zu
  bestaetigen.
- API-Negativtests fuer fremden Owner, fremden Workspace, entfernte
  Mitgliedschaft, scopefremde Assignee-/Creator-IDs und Cursor-Replay
  abschliessen.
- Commitvorschlag: `Expose canonical todo list API`.

### Phase 4: Mobile- und Notification-Adapter migrieren

- `app/lib/mobile/todos.ts` auf denselben Scope-/Filter-/Cursorvertrag
  umstellen; `scopeKind=all` fuer einen konkreten persoenlichen Workspace
  entfernen.
- Workspacegebundene Mobile-To-dos bleiben exakt; eine globale Mobile-Liste
  verwendet die globale Policy statt clientgelieferter Workspace-Mengen.
- `collectInboxItems` fuer To-dos nicht mehr je persoenlichem Workspace um den
  nutzerbezogenen Scope erweitern. Persoenliche To-dos werden einmal, konkrete
  Workspace-To-dos exakt einmal gesammelt.
- Aggregate-Inbox und Notification Summary lassen ihre To-do-Sektion durch die
  kanonische Rangfolge erzeugen. Ereignis-Sektionen bleiben zeitbasiert.
- Den Inbox-Typ auf alle drei Prioritaeten erweitern oder getrennte
  `todoPriority`-Metadaten liefern; `low` darf nicht als `normal` ausgegeben
  werden, wenn Clients danach darstellen oder filtern sollen.
- Workspace-Ausschluesse der Inbox bleiben eine Notification-Praeferenz. Sie
  duerfen die globale To-do-App nicht stillschweigend einschraenken.
- Mobile-/Summary-Contract- und Mehr-Workspace-Tests abschliessen.
- Commitvorschlag: `Align mobile todo and notification scopes`.

### Phase 5: Web-UI integrieren

- In `TodosClient` drei klar benannte Scopeoptionen anbieten: persoenliche
  To-dos, ein konkreter Workspace und bewusst gewaehlte globale Sicht.
- Den bisherigen Globus nicht mehr fuer den persoenlichen Scope verwenden,
  wenn er eine globale Ansicht suggeriert. Scope-Label, Filterzusammenfassung
  und Leerzustand muessen die effektive Serverantwort widerspiegeln.
- Assignee, Priority, Due, Read-State und Suche an den Serververtrag anbinden;
  Kategorie und Status beibehalten. Filterwechsel setzt Cursor und Auswahl
  kontrolliert zurueck.
- Keine clientseitige Nachsortierung einfuehren. Infinite Scroll oder
  „Mehr laden“ verwendet ausschliesslich `nextCursor` und verwirft Seiten bei
  geaendertem Scope/Filter.
- In globaler Sicht zeigt jede Zeile und jedes Detail den Workspace; ein
  persoenliches To-do erhaelt ein eindeutiges persoenliches Label.
- Deep-Links waehlen den Item-Scope nur nach erfolgreicher Serverantwort. Ein
  nicht mehr erlaubtes To-do fuehrt zu einem neutralen Nicht-verfuegbar-Zustand
  und nicht zum automatischen Wechsel in einen fremden Workspace.
- Home Attention und Notification Bell verwenden Workspace-Label und
  kanonische To-do-Reihenfolge der Summary ohne lokale Abweichung.
- Komponenten-/i18n-/Accessibility-Tests abschliessen.
- Commitvorschlag: `Clarify todo scope filters and priority UI`.

### Phase 6: Gesamtabnahme und Ticketabschluss

- Alle fokussierten Server-, API-, Mobile- und UI-Vertragstests ausfuehren.
- Gezieltes ESLint fuer geaenderte Dateien und danach `npm run build`
  ausfuehren.
- Die unten definierte manuelle Mehr-Workspace-Abnahme durchfuehren.
- Browser-/Playwright-Pruefungen nur nach ausdruecklicher Freigabe ausfuehren;
  bis dahin als offene UI-Abnahme dokumentieren.
- Erst nach erfolgreichen technischen und freigegebenen UI-Pruefungen Ticket
  und Index aktualisieren. Dieser Plan markiert Ticket 14 nicht als erledigt.
- Abschlusscommit erst dann, nicht in der Planungsaufgabe.

## Testmatrix fuer die spaetere Umsetzung

| Dimension | Positiver Nachweis | Negativer/Sicherheitsnachweis |
| --- | --- | --- |
| Personal Owner | Nutzer A sieht eigene `scope=user`-To-dos | Nutzer B erhaelt weder Liste noch Detail; Creator-/Assignee-ID erweitert den Scope nicht |
| Persoenlicher Workspace | Filter auf Workspace P1 liefert nur `workspace_id=P1` | Nutzer-To-dos und P2-To-dos erscheinen nicht; Nicht-Owner sieht nichts |
| Team/Organisation | Aktives leseberechtigtes Mitglied sieht exakt diesen Workspace | anderes Team, andere Organization, externe/inaktive/entfernte Mitgliedschaft bleibt ausgeschlossen |
| Projekt | Admin oder aktives Projektmitglied mit Read-Recht sieht das Projekt-To-do | Mitglied ohne Projekt-Read und entferntes Mitglied sieht es nicht |
| Global | Eigene persoenliche plus alle aktuell lesbaren Workspace-To-dos erscheinen einmal mit Label | inaktive/nicht lesbare Workspaces und Duplikate fehlen |
| Assignee/Creator | `me`, `unassigned` und berechtigte konkrete ID verengen korrekt | Assignee ohne Workspace-Zugriff kann das To-do nicht lesen; Filter leakt keine Existenz |
| Lebenszyklus | `active`, `open`, `done`, `archived`, `all` liefern die definierte Menge | Read-Toggle blendet `open`/`done` nicht aus; Archiv erscheint nicht in `active` |
| Weitere Filter | Kategorie, Source, Priority, Due, Read-State und Suche sind kombinierbar | unbekannte Werte, ungueltige Zeitzone und ueberlange Suche liefern stabile 400-Fehler |
| Sortierung | Status-, Priority-, Due-, Created- und ID-Rangfolge ist bei gleichen Daten identisch | Read-Toggle aendert Position nicht; gleicher Rang erzeugt dank ID keine Instabilitaet |
| Pagination | Alle Items erscheinen ueber mehrere Seiten genau einmal und in Reihenfolge | Cursor aus anderem Scope/Filter/Viewer/Sortierversion wird abgelehnt |
| Web/Mobile/Summary | Derselbe aktive To-do-Teilscope liefert dieselben Todo-IDs in derselben Reihenfolge | Client darf weder Scope erweitern noch lokal abweichend sortieren |
| Zugriffsverlust | Nach Entzug verschwindet das To-do bei Reload und neue Cursor werden ohne Item erzeugt | alter Cursor und alter Deep-Link umgehen die neue Policy nicht |

Fuer Due-Tests wird die Uhr kontrolliert und eine feste IANA-Zeitzone genutzt.
Grenzfaelle liegen unmittelbar vor/nach Mitternacht, am Monats-/Jahreswechsel
und rund um eine Sommerzeitumstellung. Sortier- und Paginationstests arbeiten
mit identischen Priority-/Due-/Created-Werten, damit der ID-Tie-Breaker
tatsaechlich bewiesen wird.

## Spaetere UI-Abnahme

Nach ausdruecklicher Browser-/Playwright-Freigabe wird mit zwei Nutzern und
mindestens zwei persoenlichen sowie zwei geteilten Workspaces geprueft:

1. Persoenlich, Workspace P1, Workspace P2 und global nacheinander waehlen;
   Scope-Label, URL/Request und sichtbare Itemmenge stimmen ueberein.
2. In jedem Workspace je ein gleich benanntes To-do anlegen; die globale Sicht
   zeigt beide mit eindeutigem Workspace, die Einzelansicht jeweils genau eins.
3. High/normal/low sowie ueberfaellig/heute/zukuenftig/ohne Datum kombinieren;
   Reload und Pagination behalten die Reihenfolge.
4. Status-, Assignee-, Priority-, Due-, Read- und Kategoriefilter kombinieren;
   Filterchips/Zusammenfassung und Leerzustand erklaeren die resultierende
   Menge.
5. Ein To-do in Notification Bell und Home Attention oeffnen; der Link landet
   im richtigen Scope und markiert nur den Read-State des aktuellen Nutzers.
6. Workspace-Zugriff fuer Nutzer B entziehen und danach Liste, Summary,
   Reload, alten Deep-Link und alten Cursor pruefen; kein Titel oder Workspace-
   Detail darf weiter sichtbar sein.
7. Desktop und Mobile-Viewport pruefen: Filterbedienung, Fokusreihenfolge,
   Tastaturbedienung, Screenreader-Labels, Lade-, Fehler- und Leerzustaende.

Die Abnahme wird mit Screenshots/Trace und den verwendeten Fixtures
dokumentiert. Ohne diese Freigabe bleibt die UI-Abnahme offen; erfolgreiche
Servertests oder ein Build ersetzen sie nicht.

## Risiken und Gegenmassnahmen

| Risiko | Auswirkung | Gegenmassnahme |
| --- | --- | --- |
| Legacy-Personal-Scope wird mehreren Workspaces zugerechnet | Duplikate oder scheinbar falscher Workspace | `personal` als eigene Identitaet behandeln; nie einem beliebigen Workspace zuweisen |
| Globaler Scope wird aus einer einzelnen Organization gebildet | fehlende oder fremd wirkende Eintraege bei mehreren Organizations | globale Policy aus der kanonischen Workspace-Aufloesung des Actors erzeugen |
| Assignee wird als Berechtigung interpretiert | Datenleck nach Zuweisung | Authorization vor Filterung; Assignee kann nur verengen |
| Alte Cursor basieren auf `updatedAt` | Luecken/Duplikate nach neuer Sortierung | Cursor versionieren und alte Signaturen ablehnen |
| Due-Buckets verwenden unterschiedliche Zeitzonen | Web/Mobile sortieren um Tagesgrenzen anders | eine validierte serverseitige Zeitzone in Filter und Cursor binden |
| Read-State-Join oder grosse globale Workspace-Menge wird teuer | langsame globale Listen/Summary | Batch-Hydration erhalten, Queryplan messen, nur belegte Indizes/Migrationen hinzufuegen |
| Summary-Limit von 50 verdeckt wichtige To-dos | hohe Prioritaet fehlt trotz vorhandener Daten | erst kanonisch ranken, dann limitieren; vollstaendige To-do-App ueber Cursor erreichbar halten |
| Kategorie ist nutzerbezogen, Shared-To-do ist workspacebezogen | Filter kann fuer andere Nutzer unerklaerlich sein | Kategorieverhalten explizit als bestehende Abhaengigkeit testen; eine Kategorien-Neumodellierung nicht still in Ticket 14 aufnehmen |
| Zugriff aendert sich zwischen Cursorseiten | alte Seite enthaelt stale Items | Zugriff bei jeder Anfrage neu aufloesen; UI verwirft alte Seiten bei 403/invalidem Cursor und refetcht |

## Nicht Bestandteil von Ticket 14

- neue Agent-CRUD-Tools, Push-Delivery und Konfliktversionierung aus Ticket 20;
- neue Mobile-Inbox-Tabs aus Ticket 03;
- Aenderung des in Ticket 02 vereinheitlichten Read-State-Modells;
- Neumodellierung von Kategorien als Workspace-Ressource;
- neue Write-/Archive-/Delete-Policies, soweit sie nicht fuer die belegte
  Listenisolation erforderlich sind;
- Container-, Deployment- oder Control-Plane-Arbeiten.

## Abnahmekriterien / Definition of Done

- Jede Listenanfrage besitzt serverseitig genau einen expliziten Scope;
  Workspace- und globaler Scope werden aus aktuellem Zugriff aufgeloest.
- Ein exakter Workspace-Filter liefert ausschliesslich To-dos mit dieser
  Workspace-ID. Persoenliche Nutzer-To-dos werden dabei nicht implizit
  zugemischt.
- Globale Sicht liefert jedes eigene bzw. aktuell lesbare To-do genau einmal
  und kennzeichnet dessen Scope eindeutig.
- `user_id`, Creator und Assignee sind fachlich getrennt; Assignee/Creator
  koennen eine autorisierte Menge nur verengen.
- Status, Prioritaet, Due, Read-State, Assignee, Creator, Kategorie, Quelle und
  Suche sind serverseitig kombinierbar und in der Antwort nachvollziehbar.
- Web-To-dos, Mobile-To-dos, Notification To-do-Sektion und Home Attention
  verwenden dieselbe Scope- und Rangsemantik.
- Die kanonische Sortierung ist bei Reload und unveraenderter Pagination stabil;
  unpassende Cursor werden sicher abgelehnt.
- Zugriffsverlust sperrt Liste, Detail, Deep-Link und Cursor ohne
  Existenzoffenlegung.
- Die definierte Testmatrix, gezieltes Lint und `npm run build` sind in der
  spaeteren Implementierung erfolgreich; die freigegebene UI-Abnahme ist
  dokumentiert.
- Ticket und Index werden erst nach diesen Nachweisen, nicht aufgrund dieses
  Plans, als erledigt markiert.
