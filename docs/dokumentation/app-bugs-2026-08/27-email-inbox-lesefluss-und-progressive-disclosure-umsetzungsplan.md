---
title: 'Umsetzungsplan zu Ticket 27: E-Mail-Inbox-Lesefluss und Progressive Disclosure'
status: planned
date: 2026-08-26
platforms: [web, server]
tags: [type/implementation-plan, topic/email, topic/inbox, topic/user-interface, topic/progressive-disclosure]
---

# Umsetzungsplan: E-Mail-Inbox-Lesefluss und Progressive Disclosure

## Auftrag und Arbeitsmodus

Dieser Plan konkretisiert [Ticket 27](./27-email-inbox-lesefluss-und-progressive-disclosure.md)
auf Basis des aktuell ausgecheckten Stands `f131f236` (`v2026.8.25.2`,
`origin/main`). In dieser Planungsaufgabe wurde keine Produktionsimplementierung
durchgeführt. Es wurden keine Tests, Konfigurationen oder bestehenden Dateien
verändert; das einzige neue Artefakt ist dieser Plan.

Die spätere Umsetzung erfolgt in sequenziellen, fokussierten Schritten. Nach
jeder Phase müssen die zugehörigen Tests grün sein, bevor die nächste Phase
beginnt. Ein Container ist für dieses Ticket nicht erforderlich und darf nicht
gebaut werden. Browser-/Playwright-E2E und eine manuelle Browserabnahme erfolgen
nur nach ausdrücklicher Freigabe.

Nicht Bestandteil dieses Tickets sind:

- Änderungen an der serverseitigen Mailbox-/Workspace-Berechtigungslogik;
- eine neue Provider-Synchronisationsarchitektur oder eine zweite Inbox-
  Persistenz neben den bestehenden Services;
- Änderungen an Ticket 09 (E-Mail-Settings) oder Ticket 29 (Attention-/Review-
  Projektion), ausser an klar abgestimmten, additiven UI-Verträgen;
- die Mobile-App; deren Repository ist nicht Teil dieses Tickets.

## Belegter Ausgangszustand

### Daten- und UI-Fluss

| Bereich | Aktueller Ort | Befund und Konsequenz |
| --- | --- | --- |
| Route | `app/[locale]/(routes)/emails/page.tsx`, `.../emails/layout.tsx`, `app/components/EmailShell.tsx` | Die Route authentifiziert die Seite und reicht optionale Deep-Link-Daten (`accountId`, `folder`, `messageId`) als `contextIntent` an den Client. Der Client läuft auch eingebettet im Dashboard; der Reader darf deshalb keinen globalen Scope voraussetzen. |
| Accounts | `EmailClient.tsx`, `/api/email/accounts` | `activeAccountId` wird gegen die geladene, aktuelle Accountliste validiert. Ein Accountwechsel setzt Folder und Seite zurück, löscht die Detailansicht aber erst indirekt im nachgelagerten Effekt. Das ist eine Race-Fenster für alte Antworten. |
| Folder | `EmailClient.tsx`, `/api/email/folders` | `loadFolders` setzt vor jedem Abruf `foldersAccountId` auf leer. Erfolgreiches Nachladen setzt diesen Wert wieder und triggert dadurch den Listen-Effekt. |
| Inbox-Liste | `EmailClient.tsx`, `/api/email/messages/list`, `listLocalEmailMessages`/Managed-Service | Die Liste ist paginiert (Clientgröße 25; lokale Provider begrenzen zusätzlich), wird per POST live vom Provider/Managed Service geladen und besitzt keinen Client-Cache oder Versions-/Cursorvertrag. |
| Detail | `EmailClient.tsx`, `/api/email/accounts/[accountId]/messages/[messageId]` | `selectedMessageId` und `selectedMessage` sind lokaler React-State. Desktop rendert einen flexiblen Reader, Mobile einen Dialog. Der Inhalts-Scrollcontainer liegt in `EmailMessageViewer` bei `div.min-h-0.flex-1.overflow-y-auto`; seine Position wird nicht explizit gesichert. |
| Gelesen-Status | `markMessageReadOnOpen` in `EmailClient.tsx`, Actions-Route | Beim Öffnen eines ungelesenen Elements wird optimistisch markiert. Nach erfolgreicher Mutation ruft der Client `loadFolders` auf; der dadurch entstehende Listenreload kann den gerade gelesenen Inhalt zurücksetzen. |
| Mutationen | `handleMessageAction` und `handleMessageListAction` | Bewusste Aktionen wie Verschieben, Archivieren und Löschen dürfen die aktive Nachricht schliessen. Diese expliziten Wechsel müssen von einem Hintergrund-Refresh getrennt bleiben. |
| Review/Outbox | `WorkspaceReviewQueue`, `PersonalOutboxPanel` in `EmailClient.tsx` sowie `/api/workspaces/[id]/email/{inbox,outbox}` und `/api/email/outbox` | Beide Sektionen stehen heute dauerhaft vor der Inbox und nehmen vertikalen Raum ein. Die Workspace-Queue lädt Inbox-Fälle und Entwürfe getrennt; die Personal-Outbox lädt eigene Entwürfe. |
| Server-Polling | `/api/email/inbox-events/poll`, `app/lib/email/inbox-events.ts` | Der Endpoint ist intern durch `x-canvas-internal-token` geschützt und pollt Workspace-Mailboxen für persistierte Events/Automationen. Er aktualisiert nicht den React-Client. Im aktuellen `EmailClient` existiert kein `setInterval`, kein Push-Listener und kein Realtime-Subscribe für Inbox-Daten. |

### Reproduzierbare Reset-Sequenz

1. Eine Account-/Folder-Kombination laden und eine Nachricht ohne
   `contextIntent.messageId` öffnen.
2. Bei einer ungelesenen Nachricht führt `markMessageReadOnOpen` nach dem
   Server-Update `loadFolders(activeAccount.id)` aus.
3. `loadFolders` setzt `foldersAccountId` zunächst auf `''` und danach wieder
   auf die Account-ID. Weil `loadMessages` von diesem Wert abhängt, wird die
   Liste erneut geladen.
4. Ein erfolgreicher `loadMessages`-Durchlauf setzt für den normalen UI-Fluss
   `selectedMessage` auf `null`, leert bei Bedarf `selectedMessageId`, löscht
   die Summary und schliesst den mobilen Dialog. Erhalten bleibt die Auswahl
   nur für den Sonderfall `contextMessageId` eines Deep Links.

Dasselbe Verhalten ist direkt über den manuellen Refresh reproduzierbar:
`onClick={() => void loadMessages()}` ruft denselben destruktiven Erfolgsweg
auf. Suche, Filter- und Seitenwechsel leeren die Auswahl bewusst und sollen das
auch weiterhin tun.

Die aktuelle Detailabfrage hat zusätzlich keinen Abbruch- oder
Request-Identitätsschutz. Öffnet ein Nutzer Nachricht A und danach B, kann die
später eintreffende Antwort von A B überschreiben. Beim Account-/Folderwechsel
können alte Folder-, Listen- oder Detailantworten ebenfalls neuen Scope-State
überschreiben. Ein Fehler in `loadMessage` leert die Auswahl und schliesst den
Dialog unabhängig davon, ob inzwischen eine andere Nachricht aktiv ist.

Die Inbox-Liste wird vom Provider live neu aufgebaut. Neue Elemente können die
Seitenreihenfolge verschieben; gelöschte oder verschobene Nachrichten fehlen in
der nächsten Liste. Der Client hat derzeit keinen stabilen Datensatzvergleich
für aktive Details und keinen sichtbaren Zustand für „aktive Nachricht nicht
mehr verfügbar“. Die Detailroute wandelt Provider-/IMAP-Not-found-Fälle aktuell
nicht in einen einheitlichen HTTP-404-/Fehlercode um; der Client behandelt den
Fehler wie einen generischen Ladefehler.

## Zielarchitektur und kanonischer Refresh-Vertrag

### Scope-Schlüssel

Jeder Folder-/Listen-/Detailrequest erhält einen unveränderlichen Scope-
Schlüssel aus:

```text
user session + accountId + folder + filter + submittedQuery + page/offset
```

Der Nutzer- und Workspace-Scope bleibt serverseitig autoritativ. Der Client darf
mit dem Schlüssel nur Antworten akzeptieren, die noch zum aktiven Account,
Folder und Request gehören. Kein Cache-Key oder React-Key darf eine Nachricht
zwischen Accounts, Mailboxen oder Workspaces wiederverwenden.

### Zwei getrennte Refresh-Arten

1. **Destruktiver Scopewechsel:** Account, Folder, Suche, Unread-Filter oder
   Seite ändern. Aktive Detailansicht, Summary, Detail-Scrollcontainer und
   Mobile-Dialog werden bewusst beendet. Alte Requests werden abgebrochen oder
   ihre Antworten verworfen.
2. **Nicht-destruktive Revalidierung:** manueller Refresh, späteres Polling,
   Push-/Realtime-Hinweis oder ein Read-State-Folgeupdate innerhalb desselben
   Scopes. Die bisherige Liste bleibt sichtbar, während im Hintergrund geladen
   wird. Eine aktive Nachricht bleibt anhand ihrer stabilen Identität geöffnet;
   die Scrollposition bleibt erhalten.

Für nicht-destruktive Revalidierungen gilt:

- parallele Requests werden über einen AbortController plus Request-/Scope-ID
  dedupliziert; nur die jüngste Antwort darf den State aktualisieren;
- ein unverändertes aktives Detail wird nicht ersetzt und nicht remountet;
- ein geändertes Detail wird anhand einer Content-Revision erkannt. Der bisher
  angezeigte Inhalt bleibt zunächst stehen und erhält einen klaren Hinweis mit
  „aktualisierte Version laden“ bzw. „aktuelle Version beibehalten“;
- eine neue Nachricht wird in die Liste übernommen, ohne Auswahl oder Fokus zu
  stehlen;
- fehlt die aktive ID im neuen Listensnapshot, wird nicht still auf leer
  zurückgesetzt. Der Reader zeigt einen stabilen, bedienbaren
  „nicht mehr verfügbar“-Zustand mit erneutem Laden und Rückkehr zur Liste;
- Hintergrundfehler lassen die bereits geladene Liste und den bereits gelesenen
  Detailinhalt stehen. Nur ein sichtbarer, nicht-blockierender Fehlerhinweis
  wird ergänzt;
- ein expliziter Nachrichtenwechsel, Scopewechsel oder bestätigter
  Content-Revision-Wechsel darf den Reader remounten und damit seine
  Scrollposition auf den Anfang setzen.

Der manuelle Refresh verwendet denselben nicht-destruktiven Vertrag wie ein
späteres Polling. Polling darf erst eingeführt werden, wenn dieser Vertrag und
die Deduplizierung getestet sind. Wenn Push-/Realtime-Updates später einen
Refresh auslösen, rufen sie nur denselben Revalidator auf und führen keine
eigene Listen-/Detaillogik ein.

### Lade- und Fehlerzustände

Liste und Detail unterscheiden künftig mindestens:

- initiales Laden ohne vorhandene Daten: Loader bzw. leerer Reader;
- Revalidierung mit vorhandenem Inhalt: Inhalt bleibt sichtbar, Refresh-
  Indikator erscheint nur am betroffenen Bereich;
- Transport-/Providerfehler: Inhalt bleibt erhalten, Fehler mit Retry;
- aktive Nachricht geändert: Update-Hinweis mit expliziter Entscheidung;
- aktive Nachricht gelöscht/verschoben oder nicht mehr zugreifbar: stabiler
  Not-found-Zustand mit Retry und „zurück zur Nachrichtenliste“;
- bewusste Mutation: explizite Bestätigung/Notice und anschliessender
  Reader-Wechsel entsprechend der Aktion.

Der Serververtrag sollte für providerseitige Not-found-Fälle einen stabilen
Fehlercode (`EMAIL_MESSAGE_NOT_FOUND`) und HTTP 404 liefern. Andere Provider-
oder Authentifizierungsfehler bleiben davon getrennt. Das verbessert die
Darstellung, ohne die serverseitige Scope-/Berechtigungsprüfung zu lockern.

## Progressive Disclosure und responsive Layout

### Default und Persistenz

Die primäre Oberfläche ist die Inbox-/Lesefläche. Beide sekundären Bereiche
werden standardmässig eingeklappt und zeigen im Header weiterhin Name, Anzahl
und eine kurze Statusinformation. Workspace-Review und persönliche Outbox
bleiben unabhängig steuerbar.

Jeder Bereich erhält:

- einen echten Button mit verständlichem accessible name;
- `aria-expanded` am Toggle und `aria-controls` auf eine eindeutige Region;
- sichtbaren Fokus und eine Chevron-/State-Anzeige, die nicht die einzige
  Zustandsinformation ist;
- Session-Persistenz über einen namespaced `sessionStorage`-Schlüssel. Der
  Workspace-Schlüssel enthält die Workspace-ID; die persönliche Outbox nutzt
  einen eigenen Schlüssel. Storage-Fehler dürfen die Nutzung nicht blockieren;
- Abbruch alter Queue-Requests beim Workspacewechsel und Schutz gegen späte
  Antworten eines vorherigen Workspace-Scope.

Die eingeklappte Darstellung darf keine Inhalte aus der vorherigen Session oder
aus einem anderen Workspace übernehmen. Beim Öffnen werden vorhandene
Summary-/Statusdaten dieses Scopes angezeigt; Detailinhalte werden erst beim
bewussten Öffnen des jeweiligen Outbox-Eintrags geladen bzw. editiert.

### Layout-Ziele

- Review- und Outbox-Header bleiben kompakt und `shrink-0`.
- Die Inbox-/Lesefläche liegt strukturell vor den sekundären Bereichen bzw.
  erhält in der verfügbaren Flex-/Grid-Fläche Vorrang; auf Desktop darf sie
  nicht durch dauerhaft expandierte Queues verkürzt werden.
- Auf kleinen Viewports bleiben die Sektionen vollständig erreichbar, dürfen
  aber nicht den Nachrichten-Dialog verdecken. Der bestehende mobile Dialog
  und der Folder-Dropdown bleiben erhalten.
- Der freie Platz wird der bestehenden Nachrichten-/Reader-Gridfläche gegeben;
  keine neue parallele Inbox oder neue Scrollhierarchie einführen.
- Keyboard-Fokus muss nach dem Ein-/Ausklappen am Toggle verbleiben. Eine neue
  Nachricht oder Hintergrund-Revalidierung darf keinen Fokus verschieben.

## Notebook-Route: direkte E-Mail-Surface und Tab-Lesefluss

Die Notebook-Einbettung ist ein eigener Nutzungskontext und darf nicht nur als
allgemeines `embedded`-Layout behandelt werden. Im aktuellen Stand passiert
Folgendes:

- `DashboardShell` erzeugt bei einem E-Mail-Kontext eine E-Mail-`SurfaceTab`
  mit `role="tab"`, `aria-controls` und `aria-selected`.
- Die zugehörige `SurfaceLayer` ist ein `role="tabpanel"` mit
  `aria-labelledby="notebook-surface-email-tab"`. Alle SurfaceLayers bleiben
  gerendert; eine inaktive Surface wird per `inert`, `aria-hidden` und CSS
  verborgen. Ein Tabwechsel muss daher den lokalen `EmailClient`-State
  erhalten, solange der Kontext-Scope gleich bleibt.
- Desktop und Mobile setzen jeweils `EmailContextHeader` vor den eingebetteten
  `<EmailClient contextIntent={emailContext} embedded />`. Der Header ist
  `role="status"`/`aria-live="polite"` und zeigt Toolstatus sowie Betreff,
  Query oder Folder. Seine Höhe gehört zur knappen Readerfläche.
- `useNotebookToolContext` öffnet die E-Mail-Surface beim Start eines
  `email_*`-Tools, führt bei einem neuen Chat-/Session-Scope einen bewussten
  Close/Reset aus und erlaubt, die E-Mail-Surface manuell zu schliessen.
  Ein Workspacewechsel leert den Kontext ebenfalls bewusst.

### Notebook-Daten- und Zustandsvertrag

Der direkte Kontext wird durch `NotebookEmailContextIntent` identifiziert:

```text
chat/agent session + toolCallId + accountId + folder + messageId/query/draftId
```

Für einen gleichbleibenden Schlüssel gilt:

- Ein `email_read`-Kontext mit `accountId`, `folder` und `messageId` öffnet
  genau diese Nachricht. Die Liste darf dafür noch laden; der Detailrequest
  verwendet trotzdem den expliziten Account, Folder und die Message-ID und
  darf nicht auf den Default-Account zurückfallen.
- Wechseln Nutzer im eingebetteten Reader bewusst Account, Folder, Suche,
  Filter oder Seite, ist das ein normaler destruktiver Scopewechsel. Der alte
  Kontext darf nicht später durch eine verspätete Deep-Link-Antwort
  wiederhergestellt werden.
- Ein reiner Wechsel vom E-Mail-Tab zu Dokument, Chat oder Browser und zurück
  ist kein Scopewechsel. Er darf keine Listen-/Detailabfrage starten, keine
  Auswahl löschen, keinen Reader remounten und keinen Fokus aus dem Notebook-
  Tab stehlen. Aktive Nachricht, Reader-Scrollposition, Summary und ein
  geöffneter Composer/Entwurf bleiben erhalten.
- Ein neuer `toolCallId`, ein neuer Chat-/Agent-Scope, ein Account-/Workspace-
  wechsel oder ein bewusstes Schliessen beendet den alten E-Mail-Kontext
  sichtbar und verwirft dessen Requests. Inhalte, Auswahl, Outbox-Daten und
  Drafts des alten Scopes dürfen danach nicht im neuen Kontext erscheinen.
- Refresh, Read-State-Folgeupdate, neue Nachricht und Realtime-/Polling-Hinweis
  folgen innerhalb des gleichen Notebook-Scope demselben nicht-destruktiven
  Revalidierungsvertrag wie auf der vollständigen E-Mail-Route.

### Notebook-UI und progressive Disclosure

Im `embedded`-Modus ist die zur Verfügung stehende Fläche kleiner als auf der
vollständigen E-Mail-Route und wird zusätzlich durch den Context-Header, den
Notebook-Tabstreifen sowie auf Desktop durch Explorer/Chat/Terminal begrenzt.
Die spätere Umsetzung muss deshalb:

- die aktive Nachricht und ihren Reader als primäre Fläche sichtbar halten;
- Workspace-Review und persönliche Outbox standardmässig geschlossen und nur
  als kompakte, unabhängige Disclosure-Header anzeigen;
- bei geöffneten Sekundärbereichen deren Inhalt begrenzen, ohne den Reader-
  Scrollcontainer zu verdecken oder eine zweite unklare Scrollhierarchie zu
  erzeugen;
- auf Mobile die bestehende Nachricht-Dialoglogik erhalten, aber sicherstellen,
  dass Context-Header, Tabsteuerung, Queue-Toggle und Dialog nicht dauerhaft
  übereinander liegen oder den Rückweg zum E-Mail-Tab verdecken;
- beim Ein-/Ausblenden einer Notebook-Surface keine CSS-/React-Remounts
  verwenden, die den Reader-Scroll oder den Entwurfseditor zurücksetzen.

Der Context-Header darf Statusänderungen ankündigen, aber ein Hintergrund-
Refresh darf weder den Tab automatisch aktivieren noch den Fokus vom aktuellen
Control in den Header verschieben. Bei einer expliziten Kontextänderung muss
der Tab hingegen sichtbar als geschlossen, leer oder nicht verfügbar
gekennzeichnet werden; ein stilles Verschwinden des gelesenen Inhalts ist nicht
zulässig.

### Notebook-Abnahmeszenarien

Die folgenden Szenarien sind für beide Viewports verpflichtend. Sie sind als
zusätzliche Szenarien zur allgemeinen E-Mail-Abnahme zu verstehen; die
Browser-/Playwright-Ausführung erfolgt weiterhin nur nach ausdrücklicher
Freigabe.

#### Desktop-Notebook

1. Aus einem direkten `email_read`-Kontext die E-Mail-Surface öffnen. Prüfen,
   dass Account, Betreff und gewünschte Message-ID geladen werden und der
   Reader gegenüber Header, Queue und übrigen Notebook-Flächen Vorrang erhält.
2. In einer langen Nachricht scrollen, zu Dokument/Chat/Browser wechseln und
   zum E-Mail-Tab zurückkehren. Auswahl, Scrollposition, Summary und ein
   geöffneter Composer-/Draft-Zustand bleiben unverändert; es gibt keinen
   zusätzlichen Listen- oder Detailrequest nur durch den Tabwechsel.
3. Im E-Mail-Tab revalidieren, eine neue Nachricht erhalten und den
   Hintergrund-Refresh wiederholen. Liste/Count aktualisieren sich, die aktive
   Nachricht, Scrollposition und der Keyboard-Fokus bleiben erhalten.
4. Die aktive Nachricht während der Revalidierung ändern oder löschen. Der
   Reader bleibt als E-Mail-Surface sichtbar und zeigt den Update- bzw.
   Not-found-Zustand mit Retry und Rückkehr zur Liste; er fällt nicht in einen
   anderen Notebook-Tab zurück.
5. Workspace wechseln oder einen neuen Chat-/Agent-Scope öffnen, während
   Requests laufen. Die alte E-Mail-Surface wird bewusst geschlossen bzw.
   zurückgesetzt; nach Abschluss alter Requests erscheinen weder alte
   Nachricht noch alter Entwurf im neuen Workspace.
6. Mit Tastatur zwischen Notebook-Tabs navigieren und die E-Mail-Surface
   schliessen/wieder öffnen. Tab/tabpanel-Zuordnung, `aria-selected`,
   `aria-hidden`, `inert`, Fokus und der zugängliche Context-Header bleiben
   konsistent.

#### Mobile-Notebook

1. Einen direkten `email_read`-Kontext im mobilen Notebook öffnen. Prüfen,
   dass die Nachricht im bestehenden mobilen Reader-Dialog erreichbar ist und
   die kompakte Inbox nicht die primäre Lesefläche verdrängt.
2. Nachricht scrollen, den Dokument-/Chat-/Browser-Tab wählen und zurückkehren.
   Der Dialog-/Reader-Zustand, die Position innerhalb des Inhalts und ein
   laufender Composer-/Draft-Zustand bleiben erhalten; der Tabwechsel öffnet
   nicht ungefragt eine neue Nachricht.
3. Während der E-Mail-Tab inaktiv ist einen Refresh-/Neue-Mail-Hinweis
   auslösen. Nach der Rückkehr ist die Liste aktualisiert, ohne Dialog,
   Auswahl oder Fokus unaufgefordert zu verändern.
4. Die aktive Nachricht ist nicht mehr verfügbar. Der mobile Reader zeigt
   einen verständlichen Not-found-Zustand mit Retry und „zur Liste“; der
   Context-Header bleibt nicht als irreführender Erfolgshinweis zurück.
5. Workspace-/Sessionwechsel und verspätete Antworten prüfen wie im Desktop-
   Szenario. Keine alte E-Mail, Queue oder Composer-Draft darf in der neuen
   mobilen Surface sichtbar werden.
6. Touch- und Tastaturbedienung (wo vorhanden) prüfen: SurfaceTab,
   Schliessen, Disclosure-Toggles, Dialog und Retry sind erreichbar; keine
   Sekundärsektion verdeckt dauerhaft die Reader- oder Rücknavigation.

## Geplante Umsetzung in Phasen

### Phase 1: reine Zustandslogik und Testbarkeit

- Refresh-/Scope-Typen und kleine pure Hilfsfunktionen für Scope-Key,
  Content-Revision und Snapshot-Vergleich definieren.
- `loadMessages`, `loadFolders` und `loadMessage` mit Abort-/Request-Identität
  versehen; alte Antworten und Fehler dürfen keinen neuen Scope überschreiben.
- Einen gemeinsamen Revalidator mit `background`/nicht-destruktivem Modus
  einführen. Initial- und Scopewechsel-Laden bleibt davon unterscheidbar.
- Auswahl-/Detail-State nur bei bewusstem Scopewechsel oder expliziter Aktion
  löschen. Das `mark-read`-Folgeupdate darf den Reader nicht über einen
  destruktiven Folder-/Listenreload schliessen.
- Aktive Detailanfrage bei explizitem Nachrichtenwechsel abbrechen. Eine
  Antwort darf nur gesetzt werden, wenn Account, Folder und messageId noch
  übereinstimmen.

### Phase 2: stabile Revision- und Not-found-Semantik

- Server-/Servicefehler für „nicht mehr vorhanden“ providerübergreifend
  normalisieren und an der Detailroute als 404 mit stabilem Code ausgeben.
- Bei Revalidierung den aktiven Listeneintrag und anschliessend das Detail
  gezielt anhand Account/Folder/ID nachladen; keine leere Detailansicht als
  implizite Löschung verwenden.
- Content-Revision aus den für die Anzeige relevanten Detailfeldern ableiten;
  bei unveränderter Revision den bestehenden Viewer-State und Scrollcontainer
  behalten. Bei Änderung eine Nutzerentscheidung anzeigen.
- Not-found und Providerfehler getrennt darstellen. Retry muss den aktuellen
  Scope erneut verwenden und darf nicht auf den Default-Account fallen.

### Phase 3: progressive Sekundärbereiche

- `WorkspaceReviewQueue` und `PersonalOutboxPanel` auf unabhängige Disclosure-
  Toggles mit Session-State umstellen.
- Queue-Requests an Workspace-/Komponenten-Scope binden, abortierbar machen und
  Fehler sichtbar, aber nicht global blockierend anzeigen.
- Desktop- und Mobile-Klassen so ordnen, dass die Inbox-/Lesefläche den
  freigewordenen Raum nutzt. Die vorhandenen Outbox-/Composer- und
  Workspace-Berechtigungsverträge bleiben unverändert.
- Den `embedded`-Pfad im Notebook ausdrücklich mitprüfen: Context-Header,
  SurfaceTab/tabpanel und E-Mail-Reader müssen gemeinsam in die verfügbare
  Höhe passen, ohne bei Tabwechseln zu remounten oder lokale Drafts zu verlieren.
- Übersetzungen für Toggle-, Fehler-, Update- und Not-found-Zustände in
  `messages/en.json` und `messages/de.json` ergänzen.

### Phase 4: einheitliche Auslöser

- Manuellen Refresh auf den kanonischen Hintergrund-Revalidator umstellen.
- Erst danach optional sichtbarkeitsbewusstes Polling bzw. Realtime-Hinweise
  anbinden; alle Auslöser müssen denselben deduplizierten Revalidator nutzen.
- Mutationen nach Erfolg gezielt aktualisieren: read/unread aktualisiert
  Metadaten, Verschieben/Archivieren/Löschen beendet den Reader bewusst,
  Outbox-Senden aktualisiert nur die betroffenen Review-Daten.

## Tests und Abnahmematrix für die spätere Umsetzung

### Komponenten-/Store-/Hilfstests

- unveränderte Nachricht bleibt ausgewählt, inklusive `selectedMessageId` und
  Detailinhalt, wenn wiederholt im selben Scope revalidiert wird;
- Scrollcontainer wird bei unveränderter Revision nicht remountet bzw. seine
  Position bleibt erhalten;
- neues Listenelement ändert Liste und Count, aber nicht Auswahl, Reader oder
  Fokus;
- geänderte aktive Nachricht erzeugt genau einen Update-Hinweis und wendet die
  neue Version erst nach ausdrücklicher Entscheidung an;
- gelöschte/verschobene aktive Nachricht erzeugt den stabilen Not-found-Zustand;
- parallele Revalidierungen werden dedupliziert/abgebrochen; nur die jüngste
  Antwort darf den State schreiben;
- verspätete Antworten von Folder-, Listen- und Detailrequests überschreiben
  keinen neuen Account-/Folder-/Query-Scope;
- Search, Filter, Folder, Page und Accountwechsel löschen die aktive Nachricht
  bewusst und laden keinen alten Detailzustand wieder ein;
- Session-Disclosure bleibt je Bereich und je Workspace stabil; Storage-
  Ausnahmen bleiben bedienbar.
- Notebook-Surface bleibt bei reinem Tabwechsel mounted und erhält Auswahl,
  Reader-Scroll, Summary und Draft-State; ein tab-only Wechsel erzeugt keinen
  neuen Detail-/Listenrequest und keine Fokusverschiebung;
- direkter `email_read`-Kontext öffnet die angeforderte Account-/Folder-/
  Message-Kombination, auch wenn die Inbox-Liste noch nicht geladen ist;
- neuer Tool-/Chat-Scope, Workspacewechsel und bewusstes Schliessen brechen
  alte Requests ab und entfernen den alten Scope ohne Datenleck;
- Desktop- und Mobile-Notebook-Szenarien für Refresh, neue Nachricht,
  geänderte/gelöschte aktive Nachricht, Tabwechsel und Scopewechsel sind
  getrennt abgedeckt.

### Route-/Daten-/Scope-Tests

- `/api/email/messages/list` und Detailroute behalten Session-, Account- und
  Read-Policy-Prüfungen unverändert;
- Managed- und lokaler OAuth-/IMAP-Pfad normalisieren Not-found korrekt, ohne
  fremde Inhalte sichtbar zu machen;
- Folder-/Listen-/Detailrequests bleiben auf den angeforderten `accountId` und
  Folder gebunden;
- Workspace-Inbox und Workspace-Outbox bleiben durch die vorhandenen
  `requireWorkspace`-/Mailbox-Prüfungen isoliert;
- Queue-Refresh darf keine Daten des vorherigen Workspace übernehmen;
- Outbox-Mutationen verwenden weiterhin erwartete Versionen und bestehende
  Human-in-the-loop-Senderechte.

### UI-/Accessibility-/manuelle Abnahme

Nach ausdrücklicher Browserfreigabe mit einer langen Nachricht prüfen:

1. Nachricht öffnen, weit nach unten scrollen und mehrfach manuell sowie durch
   den späteren Hintergrundauslöser revalidieren: Auswahl, Inhalt, Position und
   Fokus bleiben erhalten.
2. Neue Nachricht hinzufügen: Inbox aktualisiert sich, Reader bleibt geöffnet.
3. Aktive Nachricht ändern, verschieben und löschen: jeweils Update- oder
   Not-found-Zustand mit bedienbaren Aktionen.
4. Workspace-Review und persönliche Outbox unabhängig ein-/ausklappen; Zustand
   nach Navigation innerhalb der Session und beim Workspacewechsel prüfen.
5. Desktop und kleiner Viewport: Inbox-/Readerfläche erhält sichtbar mehr Raum,
   mobile Dialoge und Folder-Navigation bleiben nutzbar.
6. Mit Tastatur durch Toggle, Nachrichtenliste, Reader-Aktionen und Retry
   navigieren; `aria-expanded`, `aria-controls`, Namen und Fokusfolge prüfen.
7. Account-/Workspacewechsel während laufender Requests: niemals Inhalt oder
   Auswahl des vorherigen Scopes anzeigen.

Vor Abschluss der späteren Web-/Server-Implementierung sind die fokussierten
E-Mail-Tests, Lint und `npm run build` auszuführen. Containerbau ist nicht
erforderlich. Playwright-/Chrome-Prüfungen bleiben bis zu einer expliziten
Freigabe ausgesetzt.

## Risiken und Integrationsgates

| Risiko | Gegenmassnahme/Gate |
| --- | --- |
| Ein „Refresh“ wird wieder als kompletter UI-Reset implementiert | Destruktiver Scopewechsel und nicht-destruktive Revalidierung als getrennte APIs/Tests erzwingen. |
| `mark-read` triggert indirekt erneut `loadFolders` und schliesst den Reader | Read-State-Folgeupdate gezielt behandeln; Test mit ungelesener Nachricht und langer Scrollposition als Pflicht-Gate. |
| Späte Providerantwort zeigt Daten aus Account A in Account B | Scope-Key, AbortController und Antwortprüfung; Account-/Workspace-Matrix vor UI-Abnahme. |
| Content-Revision überschreibt lokale Lese-/Entwurfsarbeit | Update-Hinweis mit expliziter Entscheidung; aktive Composer-Drafts bleiben vom Inbox-Revalidator getrennt. |
| Provider liefert 404/403/5xx uneinheitlich | Stabiler Not-found-Code nur für echte Nichtverfügbarkeit; Berechtigungs- und Authfehler separat lassen. |
| Progressive Disclosure wird durch Queue-Reloads oder globale Fehler wieder dominant | Sekundärbereiche standardmässig geschlossen, eigene Statusanzeige, begrenzte Höhe und unabhängiger Scope. |
| Konflikt mit Ticket 09 oder 29 | Keine Settings-/Attention-Datenmodelle anfassen; Deep-Link- und Review-Verträge vor Integration abstimmen. |

Abschlussreihenfolge: **Plan freigegeben → Zustands-/Request-Tests → Server-
Not-found-Vertrag → Reader-Revalidierung → Disclosure/Layout → Auslöser-
Vereinheitlichung → fokussierte Tests, Lint und Build → manuelle Abnahme nach
Freigabe → eigener fokussierter Implementierungscommit → Ticket-Index auf
„in Umsetzung“/„in Abnahme“ aktualisieren.**
