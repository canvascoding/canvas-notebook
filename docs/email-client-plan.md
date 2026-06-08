# E-Mail-Client-Plan

Stand: 2026-06-08

## Ziel

Canvas Notebook bekommt eine eigene E-Mail-App unter `/emails`. Die App soll neben Notebook, Automationen und To-dos auf der Startseite und im App Launcher sichtbar sein. Sie verwaltet alle E-Mail-Accounts, die ein Benutzer vorher in den Settings verbunden hat. Der bisher eingefuehrte Main-Email-Account bleibt der Default fuer Systemmails, Agent-Tools und neue Compose-Flows, aber der E-Mail-Client muss mehrere Accounts parallel bedienbar machen.

Odysseus dient als Referenz fuer Verhalten, Edge Cases und Tests. Wegen des anderen Stacks wird Code nicht blind kopiert: Odysseus ist Python/FastAPI plus Vanilla JS, Canvas Notebook ist Next.js/TypeScript. Sinnvoll ist das Portieren von Konzepten, Parserlogik, Sicherheitsregeln, Tests und UI-Verhalten.

## Aktueller Canvas-Stand

- User-spezifische E-Mail-Accounts sind vorhanden.
- Mehrere Accounts pro Benutzer sind moeglich.
- Pro Benutzer gibt es eine Main Email (`isPrimary`).
- Google/Microsoft OAuth ist grundlegend vorhanden.
- SMTP/IMAP-Accounts sind vorhanden.
- Search, Read, Draft und Send existieren als Service-Grundlage.
- `readFrom`/`sendTo` Policies werden serverseitig erzwungen.
- Agent-Tools nutzen die Main Email als Default, wenn keine `accountId` angegeben ist.
- Todo-/Systemmails verwenden die Main Email.

## Gewuenschte Produktoberflaeche

### Neue Route

- Route: `/emails`
- Page: `app/[locale]/(routes)/emails/page.tsx`
- Client-Komponente: `app/apps/email/components/EmailClient.tsx`

Die Route soll wie die anderen App-Routen authentifiziert sein. Ohne Login darf kein Account, Folder oder Mailinhalt geladen werden.

### Startseite

In `app/components/home/HomeWorkspaceView.tsx` wird im Workspace-Bereich eine neue Karte neben Notebook, Automationen und To-dos angezeigt:

- Titel: `E-Mail`
- Icon: `Inbox` oder `MailCheck` aus `lucide-react`
- Link: `/emails`
- Beschreibung: kurzer Hinweis auf Postfaecher, Antworten und Agent-Unterstuetzung

### App Launcher

In `app/components/AppLauncher.tsx` wird eine neue App ergaenzt:

- `id: "emails"`
- `href: "/emails"`
- Icon: `Inbox`
- Keine Quick Actions im ersten Schritt

Translations werden in `messages/de.json` und `messages/en.json` unter `home.apps.email` ergaenzt.

## Account-Setup-Verhalten

Wenn keine E-Mail-Accounts verbunden sind:

- Die `/emails` Route zeigt einen Setup-Zustand.
- Der Benutzer bekommt einen direkten Link zu `/settings?tab=integrations`.
- Besser: Die bestehende E-Mail-Settings-Komponente wird wiederverwendbar gemacht und direkt auf der E-Mail-Route eingebettet.

Um Duplicate-Code zu vermeiden:

1. `EmailAccountsCard` aus `IntegrationsSettingsClient.tsx` in eine eigene Komponente extrahieren.
2. Settings nutzt diese Komponente weiter.
3. `/emails` nutzt dieselbe Komponente im Empty State.

Wenn Accounts vorhanden sind, aber ein Account kein IMAP hat:

- Der Account bleibt fuer Compose/Send nutzbar.
- Die Inbox-/Read-Funktionen zeigen einen klaren Hinweis, dass IMAP fuer diesen Account fehlt.

## Multi-Account-Modell

Der E-Mail-Client muss alle aktiven Accounts des angemeldeten Benutzers anzeigen:

- Account-Switcher in der Topbar.
- Main Email zuerst und mit Badge.
- Weitere Accounts danach.
- Optional spaeter: "Alle Postfaecher" als aggregierte Ansicht.

Alle API-Aufrufe muessen `accountId` akzeptieren. Wenn `accountId` fehlt, wird serverseitig die Main Email gewaehlt. Der Client darf nicht selbst User-IDs oder Default-Entscheidungen erzwingen.

## Backend-Phasen

### Phase 1: Read-only Mailbox

Neue oder erweiterte APIs:

- `GET /api/email/folders?accountId=...`
- `POST /api/email/messages/list`
- `GET /api/email/accounts/[accountId]/messages/[messageId]` erweitern oder durch einen klaren `folder + uid` Endpoint ergaenzen

Funktionen:

- Folder listen.
- Folder-Namen provider-spezifisch normalisieren.
- Messages pro Folder listen.
- Pagination/Limit/Offset.
- Suche.
- Filter: unread, answered, has attachments, sender.
- Einzelne Mail lesen.
- Plaintext und HTML aus MIME extrahieren.
- Attachments auflisten, aber noch nicht zwingend herunterladen.

Odysseus-Referenzen:

- `routes/email_helpers.py`: IMAP-Connection, mailbox quoting, folder detection, MIME extraction.
- `routes/email_routes.py`: list/read/folders Endpoints.
- `scripts/odysseus-mail`: CLI-Semantik fuer list/read/folders.

### Phase 2: IMAP-Aktionen

APIs:

- Mark read/unread.
- Mark answered/unanswered.
- Archive.
- Move to folder.
- Delete.
- Permanent delete nur mit expliziter Confirmation im UI.

Wichtig:

- Jede Aktion ist user-scoped.
- `accountId + folder + uid` ist die sichere Identitaet.
- UIDs nie global interpretieren.
- Folder-Namen IMAP-sicher quoten.

Odysseus-Referenzen:

- `routes/email_routes.py`: `mark-read`, `mark-unread`, `archive`, `move`, `delete`.
- `static/js/emailInbox.js` und `static/js/emailLibrary.js`: UX fuer Inbox-Aktionen und Bulk Actions.

### Phase 3: Compose, Reply, Send

Funktionen:

- Compose UI.
- From Account auswaehlen, Default = Main Email.
- To/Cc/Bcc/Subject/Body.
- Draft speichern und aktualisieren.
- Senden.
- Reply und Reply All.
- Forward.
- Threading mit `In-Reply-To` und `References`.
- Optional: gesendete SMTP-Mails in Sent per IMAP ablegen, wenn der Provider das nicht automatisch macht.

Attachments:

- Upload-Staging.
- Groessenlimit.
- Server-seitige MIME-Erstellung.
- Cleanup nach Send oder Abbruch.

Odysseus-Referenzen:

- `routes/email_routes.py`: send, draft, schedule, compose-upload.
- `static/js/emailLibrary/replyRecipients.js`: Reply-All-Recipient-Logik.
- `static/js/emailInbox.js`: Reply-Draft-Verhalten.

### Phase 4: Agent-Tools

Agent-Tools werden nach dem stabilen Client erweitert:

- `email_list_messages`
- `email_read_message`
- `email_archive`
- `email_mark_read`
- `email_delete`
- `email_create_reply_draft`
- `email_send`

Regeln:

- E-Mail-Inhalte sind untrusted content.
- Agent darf Mails lesen nur ueber serverseitig erlaubte Accounts und Policies.
- Senden nur bei expliziter User-Anweisung.
- Wenn mehrere Accounts passen, muss der Agent `email_list_accounts` nutzen oder die Main Email verwenden, wenn der User keinen Account nennt.

Odysseus-Referenzen:

- `src/tool_schemas.py`
- `src/agent_loop.py`
- `mcp_servers/email_server.py`

### Phase 5: AI-Funktionen

Spaeter aufbauen:

- AI Summary pro Mail.
- AI Reply Draft.
- Urgency/Triage-Tags.
- Newsletter/Marketing/Spam-Klassifikation.
- Kalender-Event-Extraktion.
- Scheduled send.
- Automationen fuer periodische Mail-Triage.

Diese Features sollten nicht in den ersten Client-Schritt gemischt werden. Erst muss die Mailbox robust, sicher und multi-account-faehig sein.

## Odysseus-orientierter Feature-Ausbau

Der Odysseus-Client besteht im Kern aus drei Ebenen:

1. Reader-Toolbar direkt an der geoeffneten Mail.
2. More-Menue fuer zustandsveraendernde Mail-Aktionen.
3. Backend-Endpunkte, die jede Aktion serverseitig auf `account_id + folder + uid` ausfuehren.

Dieses Muster wird fuer Canvas uebernommen, aber in React/Next-Service-Schichten umgesetzt. Keine DOM-String-Menues aus Odysseus kopieren.

### Direkt zu portierende Verhaltensweisen

- Beim Oeffnen einer Mail wird sie lokal und serverseitig als gelesen markiert.
- Reader-Toolbar:
  - Reply.
  - Reply all, nur sinnvoll sichtbar, wenn mehrere Thread-Beteiligte vorhanden sind.
  - Forward.
  - AI reply.
  - Summary.
  - More.
- More-Menue:
  - Mark read / Mark unread.
  - Done / Not done (`\Answered`).
  - Archive.
  - Move to folder.
  - Move to trash.
  - Delete permanently mit expliziter Confirmation.
- Nach Archive/Delete/Move wird die Mail aus der aktuellen Liste entfernt und die Reader-Auswahl geleert.
- Nach Flag-Aenderungen wird die lokale Liste sofort aktualisiert und anschliessend serverseitig bestaetigt.

Odysseus-Referenzen:

- Reader-Toolbar: `../odysseus/static/js/emailLibrary.js`, `_toggleCardPreview`.
- More-Menue: `../odysseus/static/js/emailLibrary.js`, `_showReaderMoreMenu`.
- Sidebar-Aktionen: `../odysseus/static/js/emailInbox.js`, `_archiveEmail`, `_deleteEmail`, `_toggleDone`.
- Backend-Mutationen: `../odysseus/routes/email_routes.py`, `mark-read`, `mark-unread`, `archive`, `delete`, `delete-permanent`, `move`.
- AI Summary: `../odysseus/static/js/emailLibrary.js`, `_summarizeEmail` und `../odysseus/routes/email_routes.py`, `summarize_email`.
- AI Reply: `../odysseus/static/js/emailInbox.js`, `ai-reply` Draft-Flow und `../odysseus/routes/email_routes.py`, `ai_reply`.

### Umsetzungsschritt A: Mail-Aktionen

Backend:

- `app/lib/email/imap-service.ts`
  - `setImapEmailMessageSeen(account, messageId, folder, seen)`.
  - `setImapEmailMessageAnswered(account, messageId, folder, answered)`.
  - `moveImapEmailMessage(account, messageId, folder, destination)`.
  - `archiveImapEmailMessage(account, messageId, folder)`.
  - `trashImapEmailMessage(account, messageId, folder)`.
  - `deleteImapEmailMessagePermanently(account, messageId, folder)`.
- `app/lib/email/local-service.ts`
  - Gleiche Funktionen provider-neutral anbieten.
  - SMTP/IMAP nutzt IMAPFlow.
  - Microsoft nutzt Graph `move`, `PATCH isRead`, `DELETE`.
  - Google nutzt Gmail `modify`, `trash`, `delete`; dafuer ist ein OAuth-Scope-Upgrade auf `https://www.googleapis.com/auth/gmail.modify` noetig. Ohne Scope klare Fehlermeldung mit Reconnect-Hinweis.
- `app/lib/email/service.ts`
  - Provider-neutrale Exporte.
- API-Routen unter `app/api/email/accounts/[accountId]/messages/[messageId]/...`
  - `POST mark-read`
  - `POST mark-unread`
  - `POST mark-answered`
  - `POST clear-answered`
  - `POST archive`
  - `POST move`
  - `DELETE trash`
  - `DELETE permanent`

Frontend:

- Reader-Toolbar in `EmailMessageViewer`.
- More-Menue als einfache, mobile-taugliche Button-Gruppe oder Dropdown.
- Move-to-folder Dialog mit bestehender Folder-Liste.
- Confirm-Dialog fuer permanent delete.

### Umsetzungsschritt B: Reply / Reply All / Forward

Backend:

- `createEmailReplyDraft(userId, accountId, messageId, folder, mode, optionalBody?)`.
- Originalmail wird serverseitig geladen, nicht vom Client vertraut.
- Reply-All-Empfaengerlogik wird aus Odysseus portiert:
  - eigene Account-Adressen aller Accounts des Users herausfiltern;
  - Originalsender in `to`;
  - uebrige To/Cc in `cc`;
  - keine Duplikate.
- Draft erhaelt Threading-Metadaten:
  - `In-Reply-To`
  - `References`
  - Source Account / Folder / UID

Frontend:

- Reply/Reply All/Forward oeffnen eine Compose-/Draft-Ansicht.
- Wenn Compose noch nicht voll gebaut ist, erste Version als Draft-Erzeugung mit Erfolgshinweis und spaeterer Compose-Route.

### Umsetzungsschritt C: AI Summary

Odysseus macht Summary nicht automatisch bei jedem Klick, sondern zeigt zuerst einen Zustand und generiert explizit. Canvas uebernimmt dieses Kosten-/Kontrollmuster.

Backend:

- Route: `POST /api/email/accounts/[accountId]/messages/[messageId]/summary`.
- Server laedt die Mail selbst.
- Prompt:
  - 1-3 kurze Bullet Points.
  - Hauptpunkt, Action Items, Deadlines.
  - Mailinhalt als untrusted user content markieren.
- Cache:
  - userId + accountId + messageId + folder + subject/date als Key.
  - Spalte/Store kann zunaechst file- oder sqlite-basiert analog Draft-Store sein.

Frontend:

- Summary-Button zeigt Panel oberhalb Body.
- Wenn nicht cached: "Generate now".
- Ergebnis nur als Text rendern, nie als HTML.

### Umsetzungsschritt D: AI Reply

AI Reply erstellt nie automatisch eine gesendete Mail, sondern nur einen Draft.

Backend:

- Route: `POST /api/email/accounts/[accountId]/messages/[messageId]/ai-reply`.
- Server laedt Originalmail selbst.
- LLM bekommt:
  - Empfaenger.
  - Betreff.
  - Originalbody.
  - optional spaeter Sender-Historie.
- Ergebnis wird bereinigt und als Reply-Draft gespeichert.
- `sendTo`-Policy bleibt aktiv; fuer reine UI-Manual-Overrides wird spaeter ein eigener expliziter Override-Mechanismus benoetigt.

Frontend:

- AI Reply Button generiert Draft.
- UI zeigt Ladezustand und Ergebnislink/Compose-State.
- Kein automatisches Senden.

## Frontend-Design

Erster voll nutzbarer Client:

- Topbar: Account-Switcher, Search, Refresh, Compose.
- Linke Spalte: Folder.
- Mittlere Spalte: Message List.
- Rechte Spalte: Reader.
- Mobile: Liste und Reader als gestapelte Views.
- Account ohne IMAP: Compose-only Zustand.
- Keine Accounts: Setup-Komponente.

Reader:

- Header: From, To, Cc, Date, Subject.
- Body: Plaintext oder sanitisiertes HTML.
- Attachments: Liste mit Dateiname, Groesse, Download/Open spaeter.
- Aktionen: Reply, Reply All, Forward, Mark unread/read, Archive, Delete.

## Sicherheitsanforderungen

- Nie User-ID aus dem Client akzeptieren.
- Account-Zugriff immer ueber `session.user.id` pruefen.
- `accountId` darf keine Existenz anderer User leaken; Fehler als "not found".
- Secrets bleiben in `data/secrets` bzw. Secret Store, nie im Client.
- Remote HTML immer sanitizen.
- Externe Bilder standardmaessig blocken oder bewusst erlauben.
- Attachments nur ueber owner-scoped Endpoints.
- Keine URLs oder Attachment-Pfade ungeprueft ins Dateisystem aufloesen.
- Rate Limits fuer Search, Read, Send, Actions.
- E-Mail-Inhalte im Agent-Kontext immer als untrusted markieren.

## Testplan

Service/API:

- Multi-Account list/folders/read.
- Main Email Default.
- Account anderer User wird nicht gefunden.
- IMAP Folder quoting.
- Gmail/Fastmail/Apple/Outlook Folder Detection.
- ReadFrom Policy beim Lesen.
- SendTo Policy beim Senden.
- SMTP Security Modes: SSL, STARTTLS, none.
- HTML sanitizer und linkify XSS Regressionen.
- Attachment path confinement.

Frontend:

- Empty State ohne Accounts.
- Account-Switcher mit Main Email.
- Folder wechseln.
- Message lesen.
- Search.
- Mark read/unread.
- Archive/Delete nach Implementierung.
- Responsive Layout.

Nach Repo-Regel nur mit expliziter Freigabe:

- Playwright/UI-Test.

Immer fuer produktionsrelevante Aenderungen:

- `npm run lint`
- `npm run build`

## Empfohlene Commit-Reihenfolge

1. Route/Navigation/Empty State:
   - `/emails` Route.
   - Startseitenkarte.
   - App Launcher Eintrag.
   - Reusable `EmailAccountsCard`.
   - Noch kein IMAP-Client noetig.

2. Read-only Backend:
   - folders/list/read APIs.
   - Tests fuer Multi-Account und Owner-Scope.

3. Read-only UI:
   - Account-Switcher.
   - Folder-Liste.
   - Message-Liste.
   - Reader.

4. IMAP-Aktionen:
   - read/unread, answered, archive, move, delete.
   - Bulk Actions optional danach.

5. Compose/Reply/Send:
   - Compose UI.
   - Reply/Reply All.
   - Drafts.
   - Attachments.

6. Agent-Tools:
   - read/list/action tools.
   - reply draft.
   - send nur explizit.

7. AI-Funktionen:
   - summary, reply draft, triage, calendar extraction, scheduled send.

## Erste Umsetzungsempfehlung

Als naechstes sollte nur der erste Commit gebaut werden:

`/emails` Route + Navigation + Empty State + wiederverwendbare EmailAccountsCard`

Das ist klein, klar testbar und legt die Produktoberflaeche fest, ohne bereits IMAP-Aktionslogik, Compose oder AI-Triage zu vermischen.
