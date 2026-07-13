# E-Mail-Management: Status quo und Zielarchitektur

Stand: 2026-07-13

Status: Entscheidungsentwurf nach Analyse des lokalen und Managed-Mailpfads

## Ziel

Canvas Notebook braucht E-Mail fuer zwei unterschiedliche Produktbereiche:

1. **System- und Benachrichtigungsmails** der App, zum Beispiel Passwort-Reset, Verifikation, Team-Einladung und To-do-Benachrichtigungen.
2. **Persoenliche Postfaecher** eines Users fuer Inbox, Suche, Compose, Antworten, Agent-Tools und Automationen.

Diese Bereiche sollen dieselbe robuste Provider- und Versandmechanik wiederverwenden, aber getrennte Ownership-, Berechtigungs- und Ausfallregeln besitzen. Die erste Ausbaustufe soll klein bleiben und spaetere Provider, mehrere Organisationen und zusaetzliche Notification-Kanaele nicht blockieren.

## Bestaetigter Status quo

### Persoenliche E-Mail-Konten

- Lokale Konten liegen user-spezifisch in `email_accounts`.
- Unterstuetzt werden Google OAuth, Microsoft OAuth und SMTP mit optionalem IMAP.
- Ein User kann mehrere Konten und genau eine lokale `Main Email` besitzen.
- SMTP-only kann senden; SMTP plus IMAP kann zusaetzlich Inbox, Suche und Lesen.
- Secrets werden nicht in der Datenbank oder im Browser gespeichert, sondern ueber verschluesselte Secret-Referenzen geladen.
- `readFrom`- und `sendTo`-Policies werden serverseitig erzwungen.
- E-Mail-Client und Agent-Tools verwenden die `Main Email`, wenn keine `accountId` angegeben ist.

### Managed OAuth

- Bei einer Managed-Instanz liegen OAuth-Tokens fuer Google oder Microsoft im Control Plane.
- Das Notebook sendet eine pseudonyme, instanzgebundene User-ID an `/v1/managed/email/*`.
- Managed Accounts werden zur Laufzeit mit lokalen Accounts zusammengefuehrt, liegen aber nicht als lokale `email_accounts`-Zeilen vor.
- Der globale Managed-Modus sagt nur, dass das Control Plane erreichbar ist. Er sagt nicht, dass jedes angezeigte Mailkonto oder jede Mail-Capability funktioniert.

### System- und To-do-Mails

- Fuer System-Mail existiert noch kein eigener organisationsweiter Delivery-Transport.
- To-do-Mail wird aktuell nur fuer durch Agents erstellte To-dos versendet.
- Empfaenger ist die Login-Adresse des Users; Absender ist dessen aktive `Main Email`.
- Antworten auf To-do-Mails koennen ueber IMAP-Polling wieder einer Agent-Session zugeordnet werden.
- Die Reply-Watcher referenzieren lokale `email_accounts`. Managed Accounts sind dadurch fuer diesen Teil noch kein vollwertiger Ersatz.
- Der Versand erfolgt im To-do-Flow ohne allgemeine Outbox, Retry-Queue oder organisationsweite Notification-Praeferenzen.

### Auth und Team

- Better Auth hat E-Mail/Passwort aktiviert und Sign-up deaktiviert.
- Das Schema kennt `emailVerified` und Verification-Records.
- Ein produktiver Versand-Callback fuer Passwort-Reset oder E-Mail-Verifikation ist noch nicht konfiguriert.
- Team-/Workspace-Mitglieder und Zuweisungen existieren, aber es gibt noch keinen gemeinsamen Mail-Notification-Service fuer Einladungen, Rollenwechsel oder Zuweisungen.
- Ein User besitzt derzeit genau eine Login-E-Mail in `user.email`; verifizierte Aliase und getrennte Notification-Adressen existieren noch nicht.

## Ursache des aktuellen Produktionsfehlers

Das Control Plane kann einen zuvor verbundenen Managed-OAuth-Account weiterhin aus seiner Datenbank listen. Eine anschliessende Microsoft-Graph-Mailoperation kann trotzdem mit `MailboxNotEnabledForRESTAPI` beziehungsweise `Mail service not enabled` scheitern. Das Control Plane bildet diesen Providerfehler korrekt auf HTTP 409 ab.

Im Notebook wurde der globale Managed-Modus bei der Kontenauflösung zu stark gewichtet. Dadurch konnte eine Operation an `/v1/managed/email/search` gehen, obwohl eine lokale SMTP/IMAP-Main-Email vorhanden war.

Der umgesetzte Hotfix stellt deshalb folgende Invarianten her:

- Explizit lokale `accountId` bedeutet immer lokaler Providerpfad.
- Eine lokale Main Email ist auch in einer Managed-Instanz der Default.
- Ein lokales Konto gewinnt gegen einen Managed-Duplikateintrag mit derselben Adresse.
- Ist der Managed-Maildienst nicht verfuegbar, bleibt die lokale Kontenverwaltung nutzbar.
- Ein echter Managed Account liefert Managed-Fehler weiterhin sichtbar zurueck; es gibt kein stilles Umschalten auf ein anderes Postfach.

## Fachliche Trennung

### 1. Organization Delivery Profile

Ein organisations- beziehungsweise instanzweites Versandprofil ist ein technischer Absender der App. Es ist **kein Postfach** und darf nicht in der persoenlichen Inbox oder in Agent-Tools auftauchen.

Verwendungszwecke:

- Passwort-Reset und Login-Sicherheit
- E-Mail-Verifikation und Aenderung der Login-Adresse
- Team- und Workspace-Einladungen
- Rollen-, Berechtigungs- und Offboarding-Hinweise
- To-do-Zuweisung, Faelligkeit und Abschluss
- Automation-Fehler und wichtige Runtime-/Backup-Warnungen
- spaeter optionale Digests

V1 braucht genau ein aktives Delivery Profile pro Organisation. SMTP reicht als erster Provider. Ein spaeterer Managed-Transactional-Provider kann hinter derselben Service-Schnittstelle ergaenzt werden.

### 2. Personal Mailbox Connection

Ein persoenliches Postfach gehoert genau einem User. Es kann je nach Provider folgende Capabilities haben:

- `send`
- `draft`
- `read`
- `folders`
- `messageActions`
- `replyPolling`

Die UI und alle Services muessen Capabilities anzeigen und pruefen, statt nur `local` oder `managed` zu unterscheiden. Ein SMTP-only-Konto ist zum Beispiel gesund fuer `send`, aber nicht fuer `read`.

### 3. User Email Address

Eine Login- oder Notification-Adresse ist keine Mailbox-Verbindung. Sie besitzt keine Provider-Tokens und kein SMTP-Passwort.

Mittelfristig soll ein User haben koennen:

- eine primaere Login-Adresse,
- null oder mehrere verifizierte Aliase,
- eine bevorzugte Notification-Adresse,
- Notification-Praeferenzen pro Ereigniskategorie.

Damit muss ein User nicht sein privates oder berufliches Postfach mit Inbox-Rechten verbinden, nur um App-Benachrichtigungen zu empfangen.

## Zielbild

```text
Auth / Team / To-do / Automationen
                |
                v
       Domain-Orchestrierung
       (warum und wann senden)
                |
                v
     Transactional Mail Service --------> Organization Delivery Profile
     Template, Outbox, Retry, Audit         SMTP, spaeter Managed Provider

E-Mail-App / Agent-Tools / Mail-Automationen
                |
                v
        Mailbox Account Resolver
        accountId, source, capabilities
             /                 \
            v                   v
   Local OAuth/SMTP/IMAP   Managed OAuth im Control Plane
```

Die Domain-Orchestrierung entscheidet Empfaenger, Template, Prioritaet und fachliche Fehlerbehandlung. Gemeinsame Services besitzen Providerzugriff, MIME/Template-Rendering, Timeout, Retry, Health und strukturierte Ergebnisse.

## Schlankes Datenmodell

### Phase 1: Delivery und Outbox

`organization_email_delivery_settings`

- `organizationId`
- `provider` (`smtp`, spaeter `managed_transactional`)
- `fromAddress`, `fromName`, `replyTo`
- `secretRef`
- `status`
- `lastTestedAt`, `lastSuccessAt`, `lastErrorCode`
- `createdAt`, `updatedAt`

`email_outbox`

- `organizationId`, optional `userId`
- `purpose` (`auth_reset`, `verification`, `invite`, `todo_assigned`, ...)
- `recipient`, `locale`, `templateDataJson`
- `status`, `attemptCount`, `nextAttemptAt`
- `idempotencyKey`
- `lastErrorCode`, `createdAt`, `sentAt`

Provider-Credentials bleiben verschluesselt hinter `secretRef`. Falls ein Provider einen instanzweiten API-Key als Environment-Variable benoetigt, wird er ueber den Integrations-Tab und `/data/secrets/Canvas-Integrations.env` verwaltet.

### Phase 2: Adressen und Praeferenzen

`user_email_addresses`

- `userId`, `emailAddress`
- `kind` (`login`, `alias`, `notification`)
- `isPrimary`, `isVerified`, `verifiedAt`

`user_notification_preferences`

- `userId`
- `category` (`security`, `collaboration`, `tasks`, `automations`, `digest`)
- `emailEnabled`
- optional spaeter Frequenz und Quiet Hours

### Managed-Account-Projektion

Die aktuelle Runtime-Zusammenfuehrung reicht fuer den Hotfix. Bevor Managed Accounts als Reply-Watcher, dauerhafte Main Email oder Fremdschluesselziel dienen, braucht das Notebook eine lokale Projektion mit `source`, `externalAccountId`, Capabilities und Health. Provider-Tokens bleiben trotzdem ausschliesslich im Control Plane.

## Settings-Struktur

Die bestehende E-Mail-Karte unter Integrationen mischt heute Systemversand und persoenliche Postfaecher gedanklich zu stark. Empfohlen ist ein eigener Bereich **E-Mail & Benachrichtigungen** mit progressiver Anzeige.

### Systemversand

Nur fuer Organization Owner/Admin sichtbar:

- Absendername und Absenderadresse
- Reply-To
- SMTP Host, Port, TLS, Username und Passwort
- `Verbindung testen` und `Testmail senden`
- klarer Health-Status mit letzter erfolgreicher Zustellung
- Liste der Verwendungszwecke

Im Single-User-Modus lautet die Beschriftung `System-E-Mail`; im Team-Modus `Organisations-Absender`.

### Meine Postfaecher

Fuer jeden User privat:

- Quelle: Lokal oder Managed
- Provider und Adresse
- Capabilities als lesbare Badges
- Health mit konkretem Fehler und passender Handlung
- `Standardpostfach` statt des unklaren Begriffs `Main Email`
- SMTP/IMAP, Google OAuth und spaeter Microsoft OAuth hinzufuegen
- Richtlinien fuer Agent-Lesen und Agent-Senden

Bei einem Managed-Microsoft-Konto ohne Exchange-Mailbox soll die UI `Postfach beim Provider nicht aktiviert` anzeigen, Inbox-Aktionen deaktivieren und nicht den Eindruck eines gesunden Kontos erwecken.

### Meine Adressen und Benachrichtigungen

- Login-Adresse mit Verifikationsstatus
- spaeter verifizierte Notification-Aliase
- Kategorien fuer Security, Team, To-dos und Automationen
- keine Provider-Credentials in diesem Abschnitt

## To-do-Notification-Regeln

V1 sollte die Regeln explizit machen:

- Persoenliches Agent-To-do: Empfaenger ist der Owner.
- Team-To-do mit Assignee: Empfaenger ist der Assignee.
- Nicht zugewiesenes Team-To-do: standardmaessig keine E-Mail, spaeter optional Workspace-Admin.
- Abschlussmail an Creator/Assignee erst nach eigener Preference.
- Reply-by-email wird nur angeboten, wenn ein expliziter Rueckkanal mit `replyPolling` existiert.
- Ohne Rueckkanal enthaelt die Mail nur einen sicheren Link zum To-do in Canvas.

Der Transactional-Absender und der Inbound-Reply-Kanal sind getrennte Konzepte. V1 soll sie nicht durch implizite Nutzung eines persoenlichen Postfachs koppeln.

## Zuverlaessigkeit und Sicherheit

- Asynchrone Outbox mit Idempotency-Key pro fachlichem Ereignis.
- Exponentielle Retries fuer temporaere Netzwerk-/4xx-Providerlimits; keine Retries fuer permanente Adress- oder Policyfehler.
- Generische Auth-Antworten, damit Passwort-Reset keine User-Existenz verraet.
- Signierte, kurzlebige Reset-, Verify- und Invite-Tokens.
- Rate Limits pro Organisation, User, Adresse und Purpose.
- Strukturierte Delivery-Ergebnisse statt ungefilterter Providerfehler im UI.
- Audit-Events ohne Passwoerter, Tokens oder Mailinhalte.
- E-Mail-Inhalte aus persoenlichen Postfaechern bleiben untrusted content.
- Organization Admins duerfen den Delivery-Status sehen, aber keine privaten Mailbox-Inhalte oder Credentials anderer User.

## Priorisierter Umsetzungsplan

### P0: Routing-Hotfix

Status: umgesetzt

- Konkrete Account-Quelle vor globalem Managed-Modus aufloesen.
- Lokale Main Email priorisieren.
- Duplikate lokal vor managed priorisieren.
- Managed-Ausfall darf lokale Accounts nicht blockieren.
- Regressionstests fuer SMTP/IMAP plus Managed 409.

### P1: Transparenz und Capability Health

- Account-DTO um `source`, `capabilities` und strukturierten `health` erweitern.
- Settings und E-Mail-App zeigen Quelle und Capability-Status.
- Managed 409 in einen handlungsorientierten Account-Status uebersetzen.
- Begriff `Main Email` in `Standardpostfach` aendern.
- Kein neues Datenmodell fuer Aliase oder Notification-Routing in diesem Schritt.

Akzeptanz: Ein User kann vor jeder Aktion erkennen, welches Konto und welcher Providerpfad verwendet werden.

### P2: Organization Delivery Profile

- Eine organisationsweite SMTP-Konfiguration mit Testmail einfuehren.
- Gemeinsamen Transactional-Mail-Service als kleine Provider-Adapter-Schicht bauen.
- Auth-, Invite- und To-do-Orchestrierung rufen diesen Service auf.
- Single-User-Kompatibilitaet: vorhandene Main Email nur waehrend einer dokumentierten Migration als Fallback; Team-Modus verlangt ein Delivery Profile.

Akzeptanz: Passwort-Reset und Team-Einladung haengen nicht von einem persoenlichen Postfach ab.

### P3: Outbox und Notification Preferences

- Outbox, Idempotency, Retry und Delivery-Audit.
- Task-Zuweisungen und Automation-Fehler migrieren.
- Preferences pro User und Kategorie.
- Monitoring fuer Queue-Tiefe und permanente Fehler.

Akzeptanz: Ein temporaerer SMTP-Ausfall verliert keine Benachrichtigung und blockiert keine fachliche API-Anfrage.

### P4: Verifizierte User-Adressen

- Login-Adresse, Aliase und bevorzugte Notification-Adresse trennen.
- Verify- und Change-Email-Flows anbinden.
- Team-Einladungen an noch nicht vorhandene User robust abbilden.

### P5: Managed Transactional Provider und Inbound Routing

- Optionalen Managed-Systemversand ueber das Control Plane anbieten.
- Inbound Reply Address oder Provider-Webhook statt generischem IMAP-Polling evaluieren.
- Erst dann Managed Accounts als dauerhafte Reply-Watcher voll integrieren.

## Bewusste Nicht-Ziele fuer die erste Version

- Kein Newsletter- oder Marketing-System.
- Keine beliebig vielen Organization-Sender oder komplexen Routingregeln.
- Kein Shared-Inbox-/Helpdesk-Produkt.
- Keine automatische Freigabe persoenlicher Postfaecher fuer Organization Admins.
- Kein stiller Provider-Fallback, der E-Mails aus einem unerwarteten Absenderkonto sendet.

## Empfohlene Entscheidungen

1. Systemversand und persoenliche Postfaecher werden fachlich getrennt.
2. V1 besitzt genau ein Organization Delivery Profile, zunaechst SMTP.
3. Die `Standardpostfach`-Auswahl bleibt pro User und steuert Mail-App sowie Agent-Tools, nicht Passwort-Reset oder Einladungen.
4. Mehrere User-Adressen werden erst nach dem Delivery Profile eingefuehrt.
5. Reply-by-email bleibt optional und capability-basiert; es darf den normalen Notification-Versand nicht blockieren.
6. Das Control Plane ist nur dann Providerpfad, wenn das konkrete Konto beziehungsweise Delivery Profile als managed aufgeloest wurde.
