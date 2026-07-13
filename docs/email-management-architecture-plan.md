# E-Mail-Management: Systemsender, Postfaecher und Benachrichtigungen

Stand: 2026-07-13

Status: verbindlicher Umsetzungsplan

## Beschlossene Architektur

Canvas Notebook unterscheidet dauerhaft zwischen drei Dingen:

1. **Login- und Empfaengeradresse eines Users**: `user.email` darf eine beliebige Adresse sein. Sie ist die Standardadresse fuer Passwort-Reset, Verifikation und Benachrichtigungen. Der User muss sie nicht als Postfach in Canvas verbinden.
2. **Persoenliches Postfach eines Users**: optionales Google-, Microsoft- oder SMTP/IMAP-Konto fuer E-Mail-App, Agent-Tools, eigenes Senden und optional Reply-by-email.
3. **System-SMTP-Sender der VM**: genau eine, vom Instanz-Administrator konfigurierte, ausgehende SMTP-Verbindung. Sie dient der gesamten Canvas-Instanz als technischer Absender und hat weder OAuth noch IMAP noch Inbox-Funktionen.

Die System-SMTP-Verbindung hat Vorrang. Ist sie nicht eingerichtet, bleibt das bereits vorhandene persoenliche Standardpostfach des jeweiligen Empfaengers als Fallback aktiv. Damit bleibt das heutige Verhalten erhalten, ohne Nutzer ohne Mailbox-Verknuepfung auszuschliessen, sobald ein Systemsender eingerichtet ist.

```text
To-do / Auth / Team / Automation
            |
            v
Notification Delivery Service
            |
            +-- System-SMTP der VM vorhanden --> senden von notifications@domain
            |
            +-- System-SMTP nicht eingerichtet --> persoenliches Standardpostfach
            |                                      des Empfaengers, sofern sendefaehig
            |
            +-- kein Sender verfuegbar --> nachvollziehbar ueberspringen/fehlschlagen
            v
      Empfaenger: user.email
```

Ein SMTP-Fehler eines konfigurierten Systemsenders loest **keinen** stillen Fallback auf ein persoenliches Postfach aus. Sonst koennte dieselbe Nachricht doppelt oder aus einem unerwarteten Absender versendet werden. Der Fallback gilt ausschliesslich, wenn auf der VM gar kein System-SMTP konfiguriert ist.

## Aktueller Stand

### Persoenliche Mailboxen

- `email_accounts` ist user-spezifisch und erlaubt mehrere Google-, Microsoft- sowie SMTP/IMAP-Konten.
- Ein Konto kann als `Main Email` markiert sein; E-Mail-App und Agent-Tools nutzen es als Default.
- SMTP-only kann senden. IMAP ist nur fuer Inbox, Suche, Lesen und Reply-Polling erforderlich.
- Die Konten und ihre Secrets sind von der Login-Adresse getrennt.
- Der Managed-OAuth-Pfad ist ausschliesslich ein weiterer Weg fuer persoenliche Mailboxen; er ist kein Systemversand.

### To-do-Benachrichtigungen

- Aktuell werden nur durch Agents angelegte To-dos per E-Mail benachrichtigt.
- Die bestehende Logik nimmt die Login-Adresse des Users als Empfaenger und dessen Main Email als Sender.
- Hat der User kein sendefaehiges Standardpostfach, wird die Mail mit `No active email account connected` uebersprungen.
- Bei einem persoenlichen Konto mit IMAP kann die bestehende Reply-by-email-Logik einen Reply-Watcher anlegen.

### Berechtigungen und Settings

- Es gibt bereits eine Instanz-Admin-Pruefung (`isAdminUser`/`requireInstanceAdmin`) sowie serverweite Settings.
- Systemweite Credentials duerfen nicht im Browser, in Prompt-Kontexten oder als Klartext in einer normalen Settings-Datei landen.
- Die zentrale Verwaltung von Integrations-Variablen erfolgt ueber `/data/secrets/Canvas-Integrations.env` und die vorhandenen Integrations-APIs.

## System-SMTP-Profil der VM

### Scope und Rechte

- Es gibt genau **ein** System-SMTP-Profil pro Canvas-Notebook-VM.
- Nur Instanz-Administratoren duerfen es lesen, speichern, testen oder loeschen.
- Normale User sehen weder den Systemsender noch SMTP-Host, Benutzername oder einen Secret-Status.
- Das Profil gehoert zur VM, nicht zu einem User und nicht zu einem persoenlichen E-Mail-Konto.

### Ausschliesslich SMTP

Der Systemsender unterstuetzt in dieser Ausbaustufe nur:

- SMTP Host und Port
- TLS/SMTPS beziehungsweise STARTTLS-Konfiguration
- SMTP Username und Passwort
- Absenderadresse, Absendername und optional `Reply-To`

Er unterstuetzt bewusst nicht:

- Google- oder Microsoft-OAuth
- IMAP, Inbox, Suche oder Agent-Tools
- Shared Inbox, Mailbox-Polling oder E-Mail-Empfang

Die Absenderadresse muss beim SMTP-Provider zum authentifizierten Konto passen oder dort explizit freigegeben sein. Bei einer eigenen Domain gehoeren SPF, DKIM und DMARC zur Betriebsdokumentation, aber nicht zur Canvas-Konfiguration selbst.

### Speicherung

Die Konfiguration wird in zwei Teile getrennt:

| Daten | Ablage | Rueckgabe an UI |
| --- | --- | --- |
| Host, Port, TLS, From, From-Name, Reply-To und Username | zentrale Integrationskonfiguration | nur maskiert und nur fuer Admins |
| SMTP-Passwort | zentrale Integrations-Secret-Verwaltung | niemals zurueckgeben; nur `passwordConfigured: true/false` |
| letzter Test, letzte erfolgreiche Zustellung, letzter Fehlercode | serverweite, nicht-sensitive Settings | Admins duerfen Status sehen |

Vorgesehene, zentral verwaltete Keys in `/data/secrets/Canvas-Integrations.env`:

```text
CANVAS_SYSTEM_SMTP_HOST
CANVAS_SYSTEM_SMTP_PORT
CANVAS_SYSTEM_SMTP_SECURE
CANVAS_SYSTEM_SMTP_USERNAME
CANVAS_SYSTEM_SMTP_PASSWORD
CANVAS_SYSTEM_EMAIL_FROM
CANVAS_SYSTEM_EMAIL_FROM_NAME
CANVAS_SYSTEM_EMAIL_REPLY_TO
```

Die Admin-UI schreibt diese Werte ausschliesslich ueber eine serverseitige, admin-geschuetzte API. Sie benutzt nicht den persoenlichen Mailbox-Speicher und zeigt gespeicherte Passwoerter nie wieder an.

## Sender- und Empfaengeraufloesung

### Einheitliche Delivery-Schnittstelle

Alle fachlichen Bereiche rufen eine gemeinsame Schnittstelle auf:

```ts
deliverNotification({
  recipientUserId,
  purpose: 'todo_created' | 'todo_assigned' | 'auth_reset' | 'email_verification' | 'invite' | 'automation_alert',
  subject,
  html,
  text,
  locale,
})
```

Der aufrufende Fachbereich entscheidet nur **wann** und **an wen** eine Mail gehen soll. Die Delivery-Schicht entscheidet **wie** gesendet wird und liefert ein strukturiertes Ergebnis zurueck.

### Verbindliche Reihenfolge

1. Lade die Empfaengeradresse aus `user.email`. Fehlt oder ist sie unbrauchbar, wird die Benachrichtigung mit einem eindeutigen Grund uebersprungen.
2. Wenn die VM ein vollstaendig konfiguriertes System-SMTP-Profil besitzt, sende darueber an `user.email`.
3. Wenn kein System-SMTP-Profil konfiguriert ist, suche das persoenliche Main Email-Konto **des Empfaengers**. Nur ein Konto mit Send-Capability darf genutzt werden.
4. Gibt es auch dieses Konto nicht, speichere den Zustand `no_delivery_sender`; die App-Benachrichtigung und das To-do selbst bleiben davon unberuehrt.

Die Senderwahl ist explizit im Ergebnis sichtbar:

```ts
type NotificationDeliveryResult =
  | { status: 'sent'; source: 'system_smtp'; messageId: string | null; from: string }
  | { status: 'sent'; source: 'personal_fallback'; accountId: string; messageId: string | null; from: string }
  | { status: 'skipped'; reason: 'missing_recipient' | 'no_delivery_sender' }
  | { status: 'failed'; source: 'system_smtp' | 'personal_fallback'; error: string };
```

### Wichtiges Verhalten

- Ein konfigurierter Systemsender wird immer bevorzugt, auch wenn der Empfaenger ein persoenliches Postfach verbunden hat.
- Der persoenliche Fallback sendet im bisherigen Modell typischerweise von der eigenen Adresse des Empfaengers an dessen `user.email`. Das bleibt nur eine Kompatibilitaetsfunktion.
- Ein persoenliches Konto wird nie als Fallback fuer einen anderen User verwendet.
- `sendTo`-Policies gelten weiter fuer persoenliche Fallback-Konten. Sie gelten nicht fuer den Systemsender; dessen Berechtigung wird durch Admin-Rechte, feste Mail-Purposes und Templates begrenzt.
- Ein defekter, aber konfigurierte Systemsender meldet einen Fehler. Er wechselt nicht auf persoenlichen Versand.

## To-do-spezifische Regeln

Die bestehende To-do-Logik wird nicht einfach auf den neuen Sender umgestellt, sondern auch beim Empfaenger korrigiert.

| Situation | Empfaenger | bevorzugter Sender | Fallback |
| --- | --- | --- | --- |
| Persoenliches Agent-To-do | Owner (`todo.userId`) | System-SMTP | Main Email des Owners |
| Team-/Projekt-To-do mit Assignee | Assignee | System-SMTP | Main Email des Assignees |
| Team-/Projekt-To-do ohne Assignee | zunaechst keine E-Mail | keiner | keiner |
| To-do-Abschluss | spaeter per Preference Creator und/oder Assignee | System-SMTP | persoenlich nur ohne System-SMTP |

In der ersten Umsetzungsstufe bleibt der Trigger auf Agent-To-dos beschraenkt, damit sich das Produktverhalten nicht ungefragt ausweitet. Die Entscheidung, ob auch manuell erstellte oder neu zugewiesene To-dos Mails erzeugen, folgt mit Notification-Praeferenzen.

### Reply-by-email

Ein System-SMTP-Sender kann nicht empfangen. Daher gilt:

- Bei Versand ueber `system_smtp` wird kein IMAP-Reply-Watcher angelegt und kein Reply-Token versprochen.
- Die Mail enthaelt einen sicheren Link zum To-do in Canvas.
- Bei `personal_fallback` bleibt die bestehende Reply-by-email-Funktion moeglich, aber nur bei einem geeigneten lokalen IMAP-Konto.
- Ein spaeterer dedizierter Inbound-Reply-Kanal ist ein eigenes Feature; er ist kein Bestandteil dieser SMTP-Ausbaustufe.

## Zielbild der Settings

### Neuer System-Tab: `System-E-Mail`

In der bestehenden Settings-Navigation wird ein eigener, admin-sichtbarer Tab in der Gruppe **System** ergaenzt. Er gehoert nicht in `Integrationen > E-Mail-Konten`, weil diese Seite weiterhin nur persoenliche Mailboxen verwaltet.

Der Tab zeigt:

- Status `Nicht eingerichtet`, `Eingerichtet`, `Letzter Test erfolgreich` oder `Letzter Test fehlgeschlagen`
- From-Adresse, Anzeigename und optional Reply-To
- SMTP Host, Port, TLS-Modus und Username
- Passwortfeld mit `Bestehendes Passwort beibehalten`
- `Verbindung testen`
- `Testmail an meine Login-Adresse senden`
- erklaerenden Hinweis zur Fallback-Reihenfolge
- letzte erfolgreiche Zustellung und einen sicheren, gekuerzten Fehlerhinweis

Nicht-Administratoren sehen den Tab nicht. Direkte API-Aufrufe werden trotzdem serverseitig mit 403 abgewiesen.

### Bestehende persoenliche E-Mail-Einstellungen

Die Karte unter `Integrationen > E-Mail-Konten` bleibt fuer persoenliche Mailboxen bestehen. Ihre Beschriftung wird spaeter auf `Meine Postfaecher` und `Standardpostfach` praezisiert. Sie darf nicht den Eindruck erzeugen, dass sie fuer Reset-, Invite- oder Systemmails erforderlich ist.

## Technischer Zuschnitt

Der gemeinsame Versandmechanismus wird klein und explizit aufgebaut. Domain-Code besitzt keine Nodemailer- oder Credential-Details.

| Bereich | Neue oder angepasste Komponente | Verantwortung |
| --- | --- | --- |
| SMTP-Transport | `app/lib/email/smtp-transport.ts` | gemeinsame Nodemailer-Optionen, Verify und Send ohne User-/DB-Zugriff |
| Systemkonfiguration | `app/lib/email/system-smtp-config.ts` | Keys laden, validieren, maskierten Admin-Status erzeugen |
| Systemversand | `app/lib/email/system-smtp-service.ts` | From/Reply-To festlegen, System-SMTP senden und Fehler klassifizieren |
| Senderwahl | `app/lib/email/notification-delivery-service.ts` | System-SMTP-vor-persoenlichem-Fallback, strukturiertes Ergebnis |
| Admin-API | `app/api/admin/system-email/*` | Status, Speichern, Verbindungstest und Testmail mit `requireInstanceAdmin` |
| Admin-UI | `SystemEmailSettingsPanel` und Settings-Navigation | nur Administratoren, keine Secret-Rueckgabe |
| To-dos | `app/lib/todos/email-notifications.ts`, `app/lib/todos/store.ts` | Empfaenger bestimmen, Delivery-Service aufrufen, Reply nur bei personal fallback |
| Auth/Team | `app/lib/auth.ts` und kuenftige Invite-Flows | nach dem Kernservice Reset, Verify und Einladungen anbinden |
| Lokalisierung | `messages/de.json`, `messages/en.json` | Admin-, Status-, Fehler- und Fallback-Texte |

`smtp-service.ts` fuer persoenliche Konten soll nicht zu einem globalen God-Service werden. Gemeinsame, providernahe Nodemailer-Mechanik wird in `smtp-transport.ts` extrahiert; Account-Auswahl, Richtlinien und Entwuerfe bleiben in ihren jeweiligen Fachservices.

## Daten, Migration und Audit

### Kernimplementierung

Die erste Stufe benoetigt keine neue `email_accounts`-Zeile und keine Inbox-Datenbank fuer den Systemsender. Das ist wichtig: Der Systemsender ist kein Benutzerkonto.

Nicht-sensitive Health-Metadaten werden serverweit gespeichert, zum Beispiel:

- `systemEmailLastTestedAt`
- `systemEmailLastTestSucceededAt`
- `systemEmailLastDeliveryAt`
- `systemEmailLastErrorCode`

Fuer To-dos wird eine kleine Migration vorbereitet, um die Quelle nachvollziehen zu koennen:

- `email_notification_delivery_kind` (`system_smtp` oder `personal_fallback`)
- `email_notification_from`

Die bestehenden Felder `emailNotificationSentAt` und `emailNotificationError` bleiben kompatibel.

### Spaetere Zuverlaessigkeit

Erst nach dem funktionierenden Kernversand wird eine Outbox eingefuehrt. Dann entstehen `email_outbox` und `email_delivery_attempts` mit Purpose, Idempotency-Key, Retry-Zeit und anonymisierten Fehlerdaten. Die fachliche Erstellung eines To-dos darf danach nicht mehr auf eine SMTP-Antwort warten.

## Vollstaendiger Umsetzungsplan

### P0: Managed-/lokales Mailbox-Routing

Status: umgesetzt

- Lokale `accountId` und lokale Main Email gewinnen gegen den globalen Managed-Modus.
- Managed-Duplikate einer lokalen Adresse werden nicht verwendet.
- Ein 409 des Managed-Maildienstes blockiert lokale SMTP/IMAP-Konten nicht.

### P1: System-SMTP als VM-Administration

1. Admin-geschuetzte Konfigurations- und Status-Service-Schicht erstellen.
2. Zentrale `CANVAS_SYSTEM_SMTP_*`-Secrets ueber die bestehende Integrations-Secret-Verwaltung speichern; Passwoerter nie lesen oder ausgeben.
3. System-E-Mail-Tab unter **System** implementieren, einschliesslich Verbindungstest und Testmail an den eingeloggten Admin.
4. Gemeinsamen SMTP-Transport extrahieren, ohne persoenliche Account-Policies in Systemversand zu uebernehmen.
5. `notification-delivery-service` mit der verbindlichen System-then-personal-Fallback-Reihenfolge implementieren.
6. Dokumentation fuer Absenderfreigabe und DNS-Anforderungen ergaenzen.

Akzeptanz:

- Ein Admin kann die VM-SMTP-Verbindung einrichten und testen.
- Kein normaler User kann Konfiguration oder Secret-Status lesen.
- Ein User ohne verbundenes Postfach kann eine Testbenachrichtigung an seine Login-Adresse erhalten.

### P2: To-do-Migration

1. Empfaenger auf `assigneeUserId ?? userId` aufloesen.
2. Bestehendes Agent-To-do-Template ueber den Delivery-Service versenden.
3. System-SMTP bevorzugen; persoenlichen Fallback nur bei fehlender Systemkonfiguration nutzen.
4. Versandquelle und Fehlerzustand am To-do speichern und in der UI anzeigen.
5. Reply-Watcher nur noch fuer personal fallback erzeugen; Systemmails verlinken in die App.
6. Bestehende To-do-Mail-Tests auf beide Senderpfade erweitern.

Akzeptanz:

- Ein Assignee ohne persoehnliche Mailbox bekommt bei eingerichtetem System-SMTP seine Mail.
- Ein User mit persoenlicher Main Email behaelt ohne System-SMTP das heutige Verhalten.
- Ein defekter System-SMTP erzeugt einen klaren Fehler statt eines stillen Absenderwechsels.

### P3: Auth und Team

1. Passwort-Reset und E-Mail-Verifikation an den Delivery-Service anbinden.
2. Team-/Workspace-Einladungen und Berechtigungshinweise als eigene Mail-Purposes einführen.
3. Alle Auth-Antworten bleiben generisch, damit keine E-Mail-Adressen oder Accounts enumerierbar sind.
4. Template-Sprache aus User- oder Invite-Kontext bestimmen.

Akzeptanz:

- Reset und Einladung funktionieren ohne persoenliches Mailbox-Konto des Empfaengers.
- Systemmails kommen immer vom VM-Sender, wenn dieser konfiguriert ist.

### P4: Outbox, Retry und Notification-Praeferenzen

1. Asynchrone Outbox mit Idempotency-Key und begrenzten Retries aufbauen.
2. Dauerhafte versus temporaere SMTP-Fehler trennen.
3. Praeferenzen fuer To-dos, Team, Automationen und Digests einführen.
4. Queue-Tiefe, letzte Fehler und Zustellraten fuer Admins sichtbar machen.

Akzeptanz:

- Temporäre SMTP-Ausfaelle verlieren keine Benachrichtigung.
- Eine Mail wird trotz Wiederholung nicht doppelt gesendet.

### P5: Optionale Erweiterungen

- Verifizierte zusaetzliche Notification-Adressen eines Users.
- Eigener Inbound-Reply-Kanal, falls Reply-by-email fuer Systemmails gewuenscht ist.
- Weitere Notification-Kanaele; sie verwenden dieselbe Domain-Orchestrierung, nicht dieselbe SMTP-Konfiguration.

## Testplan

### Unit- und Service-Tests

- Systemkonfiguration: unvollstaendig, gueltig, Passwort beibehalten, keine Secret-Leaks.
- Berechtigungen: GET/PATCH/Test als Admin erlaubt, alle Varianten als Nicht-Admin verboten.
- SMTP: TLS/Port-Validierung, Verify, Send, permanente und temporaere Fehler.
- Senderauflösung: System konfiguriert, System nicht konfiguriert plus persoenlicher Fallback, kein Sender, Systemfehler ohne Fallback.
- To-dos: Owner, Assignee, fehlender Assignee, Fallback, Systemversand ohne Reply-Watcher, persoenlicher IMAP-Fallback mit Reply-Watcher.
- Auth/Invite: generische Antworten und korrekter Mail-Purpose.

### UI- und End-to-End-Pruefung

- Admin sieht und speichert den System-E-Mail-Tab; Nicht-Admin sieht ihn nicht.
- Passwort wird nach Reload nie angezeigt.
- Testmail trifft den Test-SMTP-Adapter mit der Login-Adresse des Admins.
- To-do fuer einen User ohne Mailbox zeigt nach Systemversand einen erfolgreichen Zustellstatus.
- Der bestehende E-Mail-Client funktioniert unveraendert fuer persoenliche SMTP/IMAP-Konten.

Vor jedem Container-Build wird `npm run build` ausgefuehrt. Container werden fuer diese Aufgabe nur auf ausdruecklichen Auftrag gebaut oder gestartet.

## Bewusste Nicht-Ziele

- Kein OAuth fuer den VM-Systemsender.
- Kein IMAP, keine Inbox und kein E-Mail-Empfang fuer den VM-Systemsender.
- Kein Newsletter-, Kampagnen- oder Helpdesk-System.
- Keine stillen Fallbacks bei einem fehlerhaften konfigurierten Systemsender.
- Keine Freigabe persoenlicher Postfaecher fuer Administratoren oder andere Teammitglieder.
