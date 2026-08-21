---
title: 'Umsetzungsplan zu Ticket 09: Administrator-E-Mail-Setup reparieren'
status: ready
date: 2026-08-21
platforms: [web, server]
tags: [type/implementation-plan, topic/email, topic/settings, topic/admin, topic/security]
---

# Umsetzungsplan: Administrator-E-Mail-Setup reparieren

## Ziel und Arbeitsmodus

Dieser Plan konkretisiert [Ticket 09](./09-administrator-email-setup-reparieren.md)
auf Basis des aktuellen Repository-Stands. Er behandelt ausschließlich das
Administrator-E-Mail-Setup. Die Implementierung erfolgt strikt sequenziell:
Eine Phase beginnt erst, wenn die vorherige Phase vollständig implementiert,
mit den dort genannten Prüfungen verifiziert und als fokussierter Commit
abgeschlossen ist.

Der Zielzustand besteht aus zwei ausdrücklich getrennten Domänen:

1. **System-E-Mail** ist ein instanzweites, ausgehendes Transportmittel für
   Plattformbenachrichtigungen. Es ist kein Postfach, empfängt keine E-Mails
   und darf nie implizit als Workspace- oder persönliches Konto erscheinen.
2. **Business-/Workspace-Postfächer** sind gemeinsam genutzte SMTP/IMAP-Konten
   mit eigener Datenbankzeile, eigener verschlüsselter Secret-Datei und einer
   separat autorisierten Workspace-Zuordnung. Sie dürfen nicht als
   System-Absender für Plattformbenachrichtigungen verwendet werden.

Die gemeinsame technische SMTP-Mechanik wird wiederverwendet; Berechtigung,
Persistenz, Lifecycle, Testbedeutung und Versandpolicy bleiben domänenspezifisch.

## Scope

### Bestandteil von Ticket 09

- Status, Laden, Speichern, Moduswechsel, Entfernen und tatsächlicher
  Testversand des instanzweiten System-Absenders.
- Serverseitige Berechtigungsprüfung aller System-E-Mail- und zentralen
  Business-Mailbox-Endpunkte.
- Redaction des System-SMTP-Passworts in jeder Clientantwort, einschließlich
  indirekter Zugriffe über die allgemeine Integrations-Env-API.
- Sichere, zielgerichtete Persistenz der System-E-Mail-Schlüssel in der
  kanonischen systemweiten `Canvas-Integrations.env`.
- Bereinigung der Scope-Grenze für bereits kopierte System-E-Mail-Schlüssel.
- Gemeinsame SMTP-Validierung, TLS-Semantik, Timeouts und providerneutrale
  Fehlerklassifikation.
- Nachweis, dass System-E-Mail, persönliche Konten und Workspace-Postfächer
  sich gegenseitig nicht verändern oder als unerwarteter Fallback dienen.
- Deutsche und englische Settings-Texte sowie die Produktdokumentation für
  den korrigierten Vertrag.

### Nicht Bestandteil von Ticket 09

- Automationsfilter, Scheduler, Run-Ownership und allgemeine
  Automations-Scope-Logik aus Ticket 10.
- Neue Inbox-/Outbox-Funktionen, automatische E-Mail-Verarbeitung oder ein
  Versand durch Agenten.
- Änderung der Human-Review-Pflicht für Workspace-Outbox-Entwürfe.
- Provider-OAuth für persönliche E-Mail-Konten.
- Allgemeine Neugestaltung der Settings-Navigation oder des Integrations-Editors.
- Container-Build, Deployment oder Änderungen an Canvas Control Plane.

## Inventur des aktuellen Codebestands

### Settings und UI

| Datei | Aktuelle Verantwortung | Relevanter Befund |
| --- | --- | --- |
| `app/[locale]/(routes)/settings/page.tsx` | Lädt Session, Instanz-Adminstatus und Organisationsberechtigung. | Beide Berechtigungsinformationen liegen vor, werden für System-E-Mail aber noch nicht getrennt ausgewertet. |
| `app/components/settings/IntegrationsSettingsClient.tsx` | Settings-Tabs, Sichtbarkeit und Integrations-Env-Editor. | Der Tab `system-email` ist ausschließlich über `isAdmin` sichtbar. Organisations-Admin und Instanz-Admin werden für die zwei E-Mail-Domänen nicht getrennt. |
| `app/components/settings/SystemEmailSettingsPanel.tsx` | System-SMTP laden, speichern, Verbindung testen, entfernen und Managed/Local umschalten. | Enthält `WorkspaceMailboxesSettingsPanel` direkt als Kind. Der binäre Schalter bildet `managed`, `local` und `disabled` nicht vollständig ab. Der Test sendet keine E-Mail. Ein Link zu `/settings?tab=integrations` fehlt. |
| `app/components/settings/WorkspaceMailboxesSettingsPanel.tsx` | Zentrale SMTP/IMAP-Business-Mailboxen anlegen, ändern, testen und entfernen. | Passwortfelder werden beim Laden geleert, aber die API liefert keinen expliziten `passwordConfigured`-Status. Das Panel teilt den visuellen Container mit System-SMTP, obwohl Persistenz und Berechtigungen verschieden sind. |
| `messages/de.json`, `messages/en.json` | Labels, Status- und Fehlermeldungen. | Beschreibt den bisherigen Verbindungstest als erfolgreichen SMTP-Test; sichere Fehlercodes, Testempfänger, Missing-Configuration-Link und drei Versandmodi fehlen. |

### API-Routen und Berechtigungen

| Route | Methoden | Aktueller Guard | Relevanter Befund |
| --- | --- | --- | --- |
| `app/api/admin/system-email/route.ts` | `GET`, `PUT`, `PATCH`, `DELETE` | `requireInstanceAdmin` in jeder Methode | Grundguard ist vorhanden. Responses verwenden freie Fehlertexte; Mutationen haben kein eigenes Rate Limit. |
| `app/api/admin/system-email/test/route.ts` | `POST` | `requireInstanceAdmin` | Ruft nur `verifySystemSmtpConnection()` auf. Es wird keine Testnachricht versendet, Managed Email wird nicht getestet, Rohfehler gelangen in Response und Audit-Metadaten, ein Rate Limit fehlt. |
| `app/api/admin/workspace-email-mailboxes/route.ts` | `GET`, `POST` | `requireInstanceAdmin` | Listet derzeit Business-Mailboxen instanzweit. Die bestehende Architektur fordert für zentrale Business-Credentials Organisations-Owner/Admin und Organisationsisolation. |
| `app/api/admin/workspace-email-mailboxes/[mailboxId]/route.ts` | `PATCH`, `DELETE` | `requireInstanceAdmin` | ID-Auflösung ist nicht an eine Organisation gebunden. |
| `app/api/admin/workspace-email-mailboxes/[mailboxId]/test/route.ts` | `POST` | `requireInstanceAdmin` | Verbindungstest ist rate-limitiert, löst die Mailbox aber nur über ihre ID und nicht zusätzlich über den autorisierten Organisations-Scope auf. |
| `app/api/workspaces/[id]/email/mailbox/route.ts` | Auswahl und Zuordnung | Workspace-Guard | Gehört zur fachlichen Workspace-Zuordnung und bleibt außerhalb der Implementierung dieses Tickets; Regressionen werden lediglich verhindert. |
| `app/api/integrations/env/route.ts` | `GET`, `PUT` | Session plus User-/Org-/System-Scope-Guard | Gibt gelesene Werte und `rawContent` an berechtigte Clients zurück. Bei explizitem System-Scope könnte dadurch auch `CANVAS_SYSTEM_SMTP_PASSWORD` zurückgegeben werden. |

### Services, Persistenz und Versand

| Datei | Aktuelle Verantwortung | Relevanter Befund |
| --- | --- | --- |
| `app/lib/email/system-smtp-config.ts` | System-Schlüssel lesen, validieren, vollständig ersetzen und Status bilden. | Speichert korrekt im zentralen Integrations-Env-Pfad und gibt das Passwort im eigenen Status nicht zurück. Das Read-modify-replace schreibt jedoch die ganze Env-Datei neu und kann parallele Änderungen oder nicht entschlüsselbare fremde Werte verlieren. |
| `app/lib/integrations/env-config.ts` | Scopes, dotenv-Parsing, optionale AES-GCM-Verschlüsselung und atomisches Umbenennen. | Entschlüsselte Werte werden im internen State gehalten; bei Entschlüsselungsfehler wird nur `value: ''` geliefert. Es fehlt eine gezielte Key-Mutation, die unveränderte Ciphertexte bytegetreu bewahrt. |
| `app/lib/integrations/legacy-secret-migration.ts` und `scripts/bootstrap-admin.js` | Kopieren bisher globaler Env-Schlüssel in den Scope des initialen Owners. | Kopieren aktuell alle Schlüssel und damit auch eindeutig systemeigene `CANVAS_SYSTEM_SMTP_*`-/`CANVAS_SYSTEM_EMAIL_*`-Werte in den persönlichen Scope. |
| `app/lib/email/system-smtp-service.ts` | System-SMTP prüfen und Nachrichten senden. | Transport wird sauber geschlossen; Test und Versand geben Providerfehler ungefiltert weiter. |
| `app/lib/email/smtp-transport.ts` | Gemeinsame Nodemailer-Transportfabrik. | Timeouts sind bereits auf 15 s Verbindung, 15 s Greeting und 30 s Socket begrenzt. `secure: false` erzwingt aber noch kein STARTTLS. |
| `app/lib/email/smtp-service.ts` | SMTP/IMAP für persönliche und Workspace-Konten normalisieren, prüfen und senden. | Dupliziert Host-/Port-/Credential-Validierung. `parseInt` akzeptiert teilweise numerische Strings; boolesche Workspace-Werte werden über `Boolean(...)` coercet. |
| `app/lib/email/notification-delivery-service.ts` | Wählt Managed System Email, lokales System-SMTP oder persönlichen Fallback. | Persönliche Konten werden über den Account-Store bereits auf `account_scope = personal` begrenzt. `deliveryMode = disabled` fällt derzeit trotzdem bis zum persönlichen Fallback durch. |
| `app/lib/email/managed-system-email-client.ts` | Status und Versand über Canvas Control Plane. | Unterstützt echten Versand, wird aber vom Admin-Testendpunkt nicht verwendet. Fehler werden als freie Texte weitergereicht. |
| `app/lib/email/workspace-mailbox-store.ts` | Zentrale Business-Konten, Workspace-Zuordnung und öffentliche DTOs. | Passwörter und `secretRef` werden aus DTOs entfernt. Listen-, Test-, Update- und Delete-Auflösung benötigen jedoch einen expliziten Organisationsfilter. |
| `app/lib/email/secret-store.ts` | Verschlüsselte OAuth-/SMTP-/IMAP-Secrets für persönliche und Workspace-Konten. | Workspace-Secrets liegen getrennt unter `email-accounts/workspace/...`; diese Persistenz darf nicht mit System-SMTP zusammengeführt werden. |
| `app/lib/email/account-store.ts` | Persönliche Konten und öffentliche DTOs. | Die persönliche Liste filtert bereits auf `account_scope = personal`; diese Sicherheitsinvariante ist für Ticket 09 als Regressionstest festzuschreiben. |

### Vorhandene Tests und Dokumentation

| Datei / Script | Bereits abgedeckt | Fehlende Abdeckung für Ticket 09 |
| --- | --- | --- |
| `scripts/system-email-notification-test.ts` / `npm run test:email:system` | Managed- und Local-Routing, Speichern, Password-keep, Transport-Verify, Versandservice und Entfernen. | Keine Routen/Guards, keine echte Admin-Testnachricht, keine Error-Codes, kein Redaction-Nachweis über alle APIs, keine Migration, keine Parallelmutation, kein Workspace-Isolationsnachweis. |
| `scripts/scoped-env-config-test.ts` / `npm run test:integrations:env-scope` | Pfade, User-/Org-/System-Scope und Dateimodus `0600`. | Keine reservierten System-E-Mail-Schlüssel, keine opaque Preservation und keine clientseitige Redaction. |
| `scripts/legacy-secret-migration-test.ts` | Kopieren und idempotenter Marker für Legacy-Secrets. | Bestätigt aktuell gerade das pauschale Kopieren; systemeigene Schlüssel und Konfliktfälle fehlen. |
| `scripts/email-account-workspace-binding-test.ts` / `npm run test:email:workspace-binding` | Trennung persönlicher und zentraler Mailboxen sowie Workspace-Binding. | Organisationsübergreifende Admin-Liste/Mutation und Unverändertheit bei System-E-Mail-Mutationen fehlen. |
| `scripts/email-accounts-service-test.ts` / `npm run test:email:accounts` | SMTP/IMAP-Secrets werden aus öffentlichen Account-DTOs entfernt. | Parität der künftig gemeinsamen Validierung und explizite Secret-Statusfelder fehlen. |
| `docs/product/en/admin/system-email.mdx` | Beschreibt getrennten System-Absender und die zentralen Schlüssel. | Dokumentiert bereits einen Testversand, obwohl die Route aktuell nur `verify()` ausführt; Managed/Disabled, Fehlercodes und Scope-Migration fehlen. |
| `docs/product/en/email/main-system-email.mdx` | Trennt persönlichen Hauptaccount und System-SMTP. | Business-/Workspace-Postfach als dritte Domäne und exakte Disabled-/Fallback-Semantik fehlen. |

## Bestätigter Ist-Zustand und wahrscheinliche Fehlerursachen

Die folgenden Befunde sind direkt aus dem aktuellen Code ableitbar und müssen
vor der Implementierung nicht erst durch Browserbeobachtung bestätigt werden:

1. **Der Testvertrag ist falsch benannt und unvollständig.**
   `POST /api/admin/system-email/test` ruft ausschließlich Nodemailer
   `verify()` auf. Der in Ticket und Produktdokumentation geforderte
   Testempfang, Absender, Reply-To und tatsächliche Provider-Versandpfad werden
   damit nicht geprüft.
2. **Managed/Local/Disabled ist kein verlässlicher Zustandsautomat.**
   Die API kennt drei Modi, die UI nur einen Managed-Schalter. `disabled` sieht
   im Panel wie Local aus, und der Delivery-Resolver kann anschließend einen
   persönlichen Fallback wählen. Ein Admin kann deshalb den effektiven Zustand
   nicht sicher erkennen.
3. **Fehlende Konfiguration ist nicht handlungsorientiert.**
   Status- und Fehlerboxen nennen zwar einzelne Validierungsfehler, enthalten
   aber weder stabilen Fehlercode noch den vorgeschriebenen Link
   `/settings?tab=integrations`.
4. **SMTP-Semantik ist zwischen System und Mailboxen divergent.**
   Host, Port, Bool-Werte und E-Mail-Adressen werden doppelt normalisiert.
   Teilstrings wie `587abc` können durch `parseInt` akzeptiert werden;
   manipulierte String-Bools können im Workspace-Pfad den falschen TLS-Wert
   ergeben. `secure = false` garantiert aktuell kein STARTTLS.
5. **Providerfehler sind weder stabil noch ausreichend redigiert.**
   Rohtexte aus Nodemailer bzw. Managed API werden an den Client und beim
   System-Test in Audit-Metadaten weitergegeben. Inhalt und Format hängen vom
   Provider ab und können Account- oder Serverdetails enthalten.
6. **Die eigene Statusroute redigiert das Passwort, der allgemeine Secret-Pfad
   jedoch nicht vollständig.** `SystemEmailSettingsPanel` erhält nur
   `passwordConfigured`; die allgemeine Env-API kann bei System-Scope jedoch
   Entries und Raw-Content mit dem Passwort liefern.
7. **Ganzdatei-Ersetzungen sind ein Verlust- und Konkurrenzrisiko.**
   System-SMTP-Updates lesen alle Integrationseinträge entschlüsselt ein und
   schreiben sie neu. Eine parallele Integrationsänderung oder ein
   nicht entschlüsselbarer fremder Ciphertext kann dabei überschrieben werden.
8. **Die Legacy-Scope-Migration verletzt die neue Eigentumsgrenze.**
   System-E-Mail-Schlüssel werden derzeit wie persönliche Provider-Keys in den
   initialen User-Scope kopiert. Dadurch entstehen doppelte Quellen und ein
   zusätzlicher Client-Lesepfad für das SMTP-Passwort.
9. **Business-Mailboxen sind in Persistenz, aber nicht durchgehend in
   Autorisierung getrennt.** DTOs und Secret-Dateien sind sauber getrennt; die
   Admin-Routen und Store-Lookups sind jedoch instanzweit und nicht an die
   Organisation des berechtigten Admins gebunden.
10. **Die vorhandenen Tests bestätigen vor allem den Happy Path.** Eine grüne
    `test:email:system`-Ausführung würde den fehlerhaften Testvertrag, die
    Route-Berechtigung, die Env-Leaks und die Scope-Migration nicht erkennen.

Folgende Punkte sind Provider-/Runtime-abhängig und werden erst in der
Implementierungsabnahme reproduziert:

- konkrete Nodemailer-Fehlertexte bei DNS-, TLS-, Auth- und Timeout-Fehlern;
- Providerverhalten bei nichtstandardmäßigen Ports;
- Managed-Control-Plane-Verfügbarkeit und tatsächlich empfangene Testmail;
- bestehende Produktionsdaten mit teilweisen, duplizierten oder nicht mehr
  entschlüsselbaren System-E-Mail-Schlüsseln.

## Architekturentscheidungen

### 1. Autorisierungs- und Rollenmatrix

| Operation | Erforderliche Autorität | Scope |
| --- | --- | --- |
| System-Absender lesen, speichern, testen, Modus ändern oder entfernen | Instanz-Admin (`requireInstanceAdmin`) | gesamte Notebook-Instanz / VM |
| Zentrale Business-Mailbox verbinden, Credentials ändern, testen oder trennen | aktiver Organisations-Owner/Admin; Legacy-Solo-Fallback nur für den Instanz-Admin ohne eingerichtete Organisation | genau eine Organisation |
| Bereits verbundene Business-Mailbox einem Workspace zuordnen | Workspace-Owner/Admin mit `canManageWorkspace` | genau der Ziel-Workspace |
| Persönliches E-Mail-Konto verwalten | authentifizierter Eigentümer | genau der User |

Der System-E-Mail-Tab wird sichtbar, wenn mindestens eine der ersten beiden
Fähigkeiten vorhanden ist. Innerhalb des Tabs werden System-Absender und
Business-Mailboxen als Geschwister mit getrennten Capability-Props gerendert.
Ein Organisations-Admin ohne Instanz-Adminrecht sieht niemals die
System-Absender-Credentials; ein reiner Instanz-Admin erhält in einer
eingerichteten Teamorganisation nicht automatisch Zugriff auf fremde
Business-Mailboxen.

Die Workspace-Zuordnungsroute bleibt unverändert Eigentümer ihrer eigenen
Policy. Ticket 09 ändert dort keine Automation oder Assignment-UX.

### 2. Actions orchestrieren, Services stellen Mechanik bereit

Die Struktur folgt einer zweistufigen Grenze:

```text
Route / Admin-Action
  - Session und Rolle
  - Instanz-/Organisations-Scope
  - zulässiger Zustandswechsel
  - Testempfänger und Audit
  - providerneutraler API-Fehler
             |
             v
Shared SMTP-/Secret-Services
  - exakte Normalisierung
  - TLS- und Timeout-Optionen
  - verify/send/close
  - gezielte Env-Key-Mutation
  - strukturierte technische Fehlerursache
```

Vorgesehene Verantwortlichkeiten:

- `system-smtp-config.ts` bleibt alleiniger Owner der bekannten
  `CANVAS_SYSTEM_*`-Schlüssel und liefert intern vollständige Konfiguration,
  extern aber nur ein redigiertes Status-DTO.
- Eine kleine gemeinsame SMTP-Konfigurations-/Fehlerkomponente übernimmt nur
  wiederverwendbare Normalisierung, TLS-Optionen und Fehlerklassifikation für
  System-SMTP und SMTP/IMAP-Konten. Sie kennt weder User noch Workspace noch
  Datenbank.
- `smtp-transport.ts` bleibt die einzige Nodemailer-Fabrik.
- Eine Admin-Action für System-E-Mail entscheidet über Modus, echten
  Testversand, Empfänger, Audit-Ergebnis und öffentliche Fehlercodes.
- `workspace-mailbox-store.ts` behält Datenbank- und Secret-Lifecycle, erhält
  aber den bereits autorisierten `organizationId` als expliziten Parameter und
  filtert jede Auflösung danach.

Es wird kein großer universeller E-Mail-Service eingeführt. Systemmail,
persönliche Mail und Workspace-Outbox behalten getrennte Domain-Actions.

### 3. Kanonische Secret-Quelle und zielgerichtete Mutation

Die kanonische Quelle für System-E-Mail bleibt die systemweite
`Canvas-Integrations.env`, standardmäßig
`/data/secrets/Canvas-Integrations.env` bzw. der vorhandene
`INTEGRATIONS_ENV_PATH`-Override. Persönliche und organisationseigene Env-Dateien
sind keine gültige Laufzeitquelle für System-E-Mail.

Für System-E-Mail-Schlüssel wird eine atomische Key-Mutation ergänzt:

- nur die reservierten System-E-Mail-Keys werden eingefügt, ersetzt oder
  gelöscht;
- unbeteiligte Zeilen und nicht entschlüsselbare Ciphertexte bleiben erhalten;
- eine pro Dateipfad serialisierte Mutation verhindert Lost Updates innerhalb
  des Serverprozesses;
- Schreiben erfolgt weiterhin über Temp-Datei, Modus `0600` und Rename;
- `passwordAction: keep` bewahrt den vorhandenen gespeicherten Wert ohne ihn an
  Client oder UI zurückzugeben;
- bei nicht lesbarem gespeichertem Passwort wird nicht still mit leerem Wert
  weitergeschrieben, sondern `SECRET_UNREADABLE` gemeldet.

Der allgemeine Integrations-Endpunkt behandelt die reservierten
System-E-Mail-Schlüssel gesondert: Werte und Raw-Zeilen werden nie an den Client
serialisiert; generische Vollersetzungen dürfen diese Schlüssel weder löschen
noch durch leere Platzhalter überschreiben. Schreiben der reservierten Keys
erfolgt ausschließlich über die dedizierte Admin-System-E-Mail-Action.

### 4. Redigierter Statusvertrag

Die öffentliche System-E-Mail-Response enthält ausschließlich:

```ts
type SystemEmailStatus = {
  mode: 'managed' | 'local' | 'disabled';
  effectiveRoute: 'managed' | 'local' | 'personal_fallback' | 'unavailable';
  local: {
    configured: boolean;
    complete: boolean;
    host: string | null;
    port: number | null;
    tlsMode: 'implicit_tls' | 'starttls' | null;
    username: string | null;
    passwordStatus: 'set' | 'missing' | 'unreadable';
    fromAddress: string | null;
    fromName: string | null;
    replyTo: string | null;
  };
  managed: {
    configured: boolean;
    available: boolean;
    fromAddress: string | null;
    fromName: string | null;
  };
  missingKeys: string[];
  configurationCode: string | null;
  settingsLink: '/settings?tab=integrations';
};
```

`password`, Token, Ciphertext, `rawContent`, Secret-Pfad und `secretRef` sind in
diesem Vertrag nicht zulässig. Für Workspace-Mailboxen werden zusätzlich
`smtpPasswordStatus` und `imapPasswordStatus` als reine Zustände ausgegeben;
die Werte bleiben immer abwesend.

### 5. Eindeutige Modus- und Fallback-Semantik

- `managed`: ausschließlich Managed System Email verwenden. Ist die Managed
  Route bei der Zustandsauflösung nicht verfügbar, ist der Status sichtbar
  degraded; ein Admin-Test fällt sicher fehl und nutzt keinen persönlichen
  oder Workspace-Fallback.
- `local`: ausschließlich die gespeicherte lokale System-SMTP-Konfiguration
  verwenden. Nach einem Verbindungs- oder Versandfehler kein stiller Fallback.
- `disabled`: System-E-Mail ist bewusst deaktiviert. Der Resolver gibt
  `unavailable` mit einem stabilen Grund zurück; er darf nicht zu einem
  persönlichen Konto durchfallen.
- `personal_fallback`: nur für den rückwärtskompatiblen Zustand ohne expliziten
  Modus und ohne konfigurierte Systemroute. Die ausgewählte Mailbox muss
  `account_scope = personal` haben. Workspace-Konten sind ausgeschlossen.

Die UI verwendet eine explizite Modusauswahl statt eines binären Schalters und
zeigt den effektiven Versandweg separat vom gespeicherten Modus.

### 6. TLS, Port und Timeout

Die API verwendet künftig `tlsMode` statt eines mehrdeutigen String-/Boolean-
Werts. Zur Persistenz- und Request-Kompatibilität wird das bestehende
`secure`-Boolean weiterhin eingelesen und eindeutig abgebildet:

- `implicit_tls` -> Nodemailer `secure: true`, üblicher Default-Port 465;
- `starttls` -> `secure: false` plus `requireTLS: true`, üblicher Default-Port
  587;
- nichtstandardmäßige Ports zwischen 1 und 65535 bleiben providerneutral
  erlaubt; Port/TLS-Kombinationen erzeugen höchstens einen klaren Hinweis,
  keine starre Providerannahme;
- numerische Eingaben müssen vollständig numerisch sein; Teilstrings werden
  abgelehnt;
- Verbindung 15 s, Greeting 15 s und Socket 30 s bleiben die gemeinsame
  Obergrenze für System-, persönliche und Workspace-SMTP-Pfade.

Plaintext-SMTP ohne TLS wird im Administrator-Setup nicht angeboten.

### 7. Echter, sicher begrenzter Testversand

`POST /api/admin/system-email/test` testet die aktuell ausgewählte
Systemroute und sendet eine echte, klar gekennzeichnete Testnachricht an die
E-Mail-Adresse des authentifizierten Instanz-Admins. Die Route akzeptiert
keinen frei wählbaren Empfänger und kann dadurch nicht als beliebiges
Admin-Mailrelay missbraucht werden.

Der Test:

- nutzt bei `local` die gespeicherte System-SMTP-Konfiguration;
- nutzt bei `managed` den Managed-System-Email-Client;
- lehnt `disabled`, fehlende, unvollständige oder nicht lesbare Konfiguration
  ohne Fallback ab;
- prüft den tatsächlichen From-/Reply-To-/Send-Pfad, nicht nur `verify()`;
- verwendet einen generischen Betreff und Inhalt ohne Secret- oder
  Systemdiagnosedaten;
- besitzt ein enges nutzerbezogenes Rate Limit;
- liefert nur Route, redigierten Empfänger, Zeit und optional Message-ID-Status,
  niemals Providerrohantwort oder Credentials.

### 8. Providerneutrale Fehlercodes und sichere Audits

Mindestens folgende Codes werden zentral klassifiziert:

| Code | Bedeutung | HTTP |
| --- | --- | --- |
| `SYSTEM_EMAIL_VALIDATION_FAILED` | Feld fehlt oder hat ungültiges Format | 400 |
| `SYSTEM_EMAIL_CONFIG_MISSING` | erforderliche Konfiguration fehlt | 409 |
| `SYSTEM_EMAIL_SECRET_UNREADABLE` | vorhandenes Secret kann nicht entschlüsselt werden | 409 |
| `SYSTEM_EMAIL_MODE_UNAVAILABLE` | Managed/Local/Disabled kann nicht getestet werden | 409 |
| `SMTP_DNS_FAILED` | Host nicht auflösbar | 502 |
| `SMTP_CONNECTION_FAILED` | Verbindung abgelehnt/abgebrochen | 502 |
| `SMTP_CONNECTION_TIMEOUT` | gemeinsame Timeoutgrenze erreicht | 504 |
| `SMTP_TLS_FAILED` | Zertifikat, Handshake oder STARTTLS fehlgeschlagen | 502 |
| `SMTP_AUTH_FAILED` | Provider lehnt Anmeldung ab | 422 |
| `SMTP_SENDER_REJECTED` | From-Adresse nicht erlaubt | 422 |
| `SMTP_RECIPIENT_REJECTED` | Admin-Testempfänger abgelehnt | 422 |
| `SYSTEM_EMAIL_SEND_FAILED` | sicherer generischer Restfehler | 502 |

Clienttexte werden über `messages/de.json` und `messages/en.json` aufgelöst.
Audit-Metadaten enthalten nur Code, Modus, Route, Port/TLS, redigierte Adresse,
Actor und Ergebnis. Rohfehler, Passwort, Token, Auth-Objekt, vollständige
Providerresponse und Nachrichtentext werden weder geloggt noch auditiert.

## Migrations- und Rückwärtskompatibilitätsplan

### Unterstützte Altzustände

- bestehende vollständige Schlüssel in der kanonischen globalen
  `Canvas-Integrations.env`;
- bestehender `INTEGRATIONS_ENV_PATH`-Override;
- Klartextwerte in einer Datei mit Modus `0600`;
- `enc:v1`-Werte mit verfügbarem `INTEGRATIONS_ENV_MASTER_KEY`;
- Konfiguration ohne `CANVAS_SYSTEM_EMAIL_DELIVERY_MODE`;
- gespeichertes `secure=true|false`;
- durch die Legacy-Migration duplizierte System-E-Mail-Schlüssel im User- oder
  Organisations-Scope;
- partielle oder nicht mehr entschlüsselbare Konfiguration.

### Deterministische Regeln

1. Eine vollständige, lesbare kanonische Systemkonfiguration gewinnt immer.
2. Fehlt der Modus, bleibt das heutige kompatible Verhalten erhalten:
   Managed nur bei verfügbarer Managed-Konfiguration ohne lokale Werte,
   ansonsten Local bzw. der dokumentierte persönliche Legacy-Fallback.
3. `secure=true|false` wird verlustfrei in den öffentlichen `tlsMode`
   übersetzt; die persistierten Schlüssel müssen nicht sofort umbenannt werden.
4. Künftige Legacy-to-User-Migrationen überspringen alle reservierten
   System-E-Mail-Schlüssel in beiden Implementierungen
   (`legacy-secret-migration.ts` und `bootstrap-admin.js`).
5. Für bereits kopierte Schlüssel wird eine idempotente, versionierte
   Scope-Bereinigung ausgeführt:
   - kanonische und scoped Schlüssel nur als Namen, Presence, Hash und
     Lesbarkeitsstatus inventarisieren;
   - bei kanonischem vollständigem Satz scoped Duplikate erst nach erfolgreicher
     Sicherung und Re-Read entfernen;
   - falls kanonisch leer und genau ein vollständiger, lesbarer Scoped-Satz
     existiert, diesen atomisch in den kanonischen Scope übernehmen;
   - bei mehreren unterschiedlichen, partiellen oder nicht lesbaren Kandidaten
     nichts automatisch auswählen oder löschen, sondern
     `SYSTEM_EMAIL_MIGRATION_CONFLICT` melden;
   - Manifest und Backup enthalten keine Klartextwerte.
6. Eine ungültige neue Eingabe wird vollständig validiert, bevor irgendein
   Schlüssel mutiert wird. Die vorherige gültige Konfiguration bleibt erhalten.
7. Beim Ersetzen eines Passworts wird das neue Secret erst erfolgreich
   persistiert und wieder lesbar geprüft, bevor der Status als gespeichert gilt.

Individuelle `CANVAS_SYSTEM_*`-Werte aus dem Prozess-Environment werden nicht
als zusätzliche, versteckte dritte Schreibquelle eingeführt. Der vorhandene
Dateipfad-Override bleibt der unterstützte Mechanismus für extern verwaltete
Persistenz. Dadurch ist die Precedence eindeutig und ein UI-Delete lässt keine
alte Prozessvariable überraschend wieder erscheinen.

## Geplanter API-Vertrag

### `GET /api/admin/system-email`

- Guard: Instanz-Admin.
- Response: ausschließlich der redigierte Statusvertrag.
- Header: `Cache-Control: private, no-store`.
- Fehlende Keys: `configurationCode`, `missingKeys` und fester
  `settingsLink: /settings?tab=integrations`.

### `PUT /api/admin/system-email`

Request:

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "tlsMode": "starttls",
  "username": "notifications@example.com",
  "passwordAction": "keep",
  "password": "",
  "fromAddress": "notifications@example.com",
  "fromName": "Canvas Notebook",
  "replyTo": "support@example.com"
}
```

- `passwordAction = keep` ist nur bei vorhandenem lesbarem Passwort zulässig.
- `passwordAction = replace` verlangt ein nicht leeres Passwort.
- Leeres Passwort bedeutet nicht mehr implizit gleichzeitig „behalten“ und
  „löschen“.
- Alle Felder werden vor der Mutation validiert.
- Eine erfolgreiche Speicherung setzt den Modus bewusst auf `local` oder
  verlangt den gewünschten Modus explizit; kein versteckter Zustandswechsel.
- Response: redigierter Status, niemals der Request-Payload.

### `PATCH /api/admin/system-email`

Request: `{ "mode": "managed" | "local" | "disabled" }`.

- prüft vor Aktivierung, ob die gewählte Route konfigurierbar ist;
- erlaubt `disabled` ausdrücklich und setzt dessen No-Fallback-Semantik durch;
- liefert den redigierten Status.

### `DELETE /api/admin/system-email`

- entfernt nur die lokalen System-E-Mail-Schlüssel;
- ändert keine persönliche oder Workspace-Mailbox;
- der gewünschte Folgemodus wird eindeutig auf `disabled` gesetzt, damit kein
  gelöschtes Local-Setup still in einen persönlichen Absender wechselt;
- liefert den redigierten Status.

### `POST /api/admin/system-email/test`

- Guard: Instanz-Admin plus enges Rate Limit.
- Kein frei wählbarer Empfänger; Ziel ist die Session-E-Mail des Admins.
- Sendet über genau den aktiven Systemmodus.
- Response enthält `mode`, `route`, `recipientMasked`, `sentAt` und optional
  `messageAccepted: true`, aber keinen geheimen oder providerinternen Wert.

### Business-Mailbox-Routen

- Zentraler Guard löst Session, Organisationsstatus und aktive
  Owner/Admin-Rolle auf.
- Service-Calls erhalten `organizationId` explizit.
- `GET`, `PATCH`, `DELETE` und `test` filtern zusätzlich zur ID nach
  `email_accounts.organization_id` und `account_scope = workspace`.
- Legacy-Solo ohne Organisation behält einen dokumentierten Instanz-Admin-
  Fallback; Teaminstallationen erhalten keinen globalen Fallback.
- Public DTOs führen nur Password-Statusfelder, keine Werte oder Secret-Refs.

## Strikt sequenzielle Implementierungsreihenfolge

### Phase 1: Verträge und gemeinsame SMTP-Mechanik härten

- Exakte Normalisierung für Host, vollständige Portzahl, E-Mail-Adresse,
  Credentials und `tlsMode` als kleine zustandsfreie Servicefunktionen
  extrahieren.
- `smtp-transport.ts` um explizites `requireTLS` für STARTTLS ergänzen und die
  vorhandenen Timeoutwerte als benannte gemeinsame Konstanten festschreiben.
- Strukturierte technische Fehlerursachen erzeugen; noch keine Route darf
  Rohfehler direkt serialisieren.
- Zuerst System-SMTP auf die gemeinsame Mechanik umstellen und testen, danach
  persönliche/Workspace-SMTP-Parität herstellen.
- Tests: gültige Standard-/Nichtstandardports, `587abc`, URL statt Host,
  String-Bools, implicit TLS, STARTTLS, Timeoutoptionen und sichere
  Fehlerklassifikation.
- Verifikation: gezielte SMTP-/E-Mail-Service-Tests und `npm run build`.
- Commit: `Unify SMTP validation and transport safety`.

### Phase 2: System-Secret-Scope und verlustfreie Env-Mutationen reparieren

- Reservierte System-E-Mail-Keyliste zentral definieren.
- Zielgerichtete, pro Pfad serialisierte Env-Key-Mutation implementieren, die
  unbeteiligte Ciphertexte und Einträge bewahrt.
- `system-smtp-config.ts` auf diese Mutation umstellen; Password-keep und
  Secret-Lesbarkeit explizit modellieren.
- System-E-Mail-Passwort und reservierte Raw-Zeilen in der allgemeinen Env-API
  redigieren; generische Saves bewahren reservierte Werte.
- Legacy-to-User-Migration in TypeScript und Bootstrap-JavaScript so ändern,
  dass systemeigene Keys nie kopiert werden.
- Versionierte Bereinigung bereits duplizierter Keys einschließlich Backup,
  Manifest, Konfliktstatus und idempotentem Wiederanlauf ergänzen.
- Tests: Klartext, verschlüsselt, fehlender/falscher Master-Key, Keep/Replace,
  parallele Mutation eines fremden Keys, Remove nur reservierter Keys,
  Migration canonical-wins, Single-candidate, Konflikt und zweiter Lauf.
- Verifikation: Env-Scope-, Legacy-Migrations- und neue System-Secret-Tests
  sowie `npm run build`.
- Commit: `Protect system email secrets and scope migration`.

### Phase 3: Admin-Actions, Scope-Guards und API-Verträge vereinheitlichen

- Eine schmale System-E-Mail-Admin-Action für Status, Save, Mode und Remove
  einführen. Routen bleiben für HTTP, Guard und Rate Limit zuständig.
- Instanz-Admin-Guard für jede System-E-Mail-Methode beibehalten und durch
  direkte Routentests für `401`, `403` und Erfolg beweisen.
- Providerneutrale Fehlercodes und HTTP-Status auf allen Systemrouten anwenden;
  Auditpayloads zentral redigieren.
- Zentrale Business-Mailbox-Guards auf Organisations-Owner/Admin umstellen,
  `organizationId` explizit bis in Store-Lookups durchreichen und Cross-Org-IDs
  ablehnen.
- Instanzweite System-E-Mail-Operationen dürfen keine
  `email_accounts`-/`workspace_email_mailboxes`-Zeile verändern; Business-
  Operationen dürfen keinen `CANVAS_SYSTEM_*`-Key mutieren.
- Tests: unauthentifiziert, Nicht-Admin, Instanz-Admin, Organisations-Admin,
  deaktiviertes Mitglied, Legacy-Solo, fremde Organisation, erratene ID,
  Rate Limit und Audit-Redaction.
- Verifikation: neue Route-/Action-Tests, Workspace-Binding-Tests und
  `npm run build`.
- Commit: `Enforce email administration boundaries`.

### Phase 4: Echten System-E-Mail-Test und verlässliches Delivery-Routing bauen

- Admin-Testroute von reinem `verify()` auf tatsächlichen Testversand an die
  Session-E-Mail umstellen.
- Local und Managed über ihre jeweiligen Systempfade testen; niemals
  persönlichen oder Workspace-Fallback verwenden.
- `disabled` als echte `unavailable`-Route implementieren.
- Legacy-Personal-Fallback nur ohne expliziten Systemmodus erhalten und
  serverseitig auf `account_scope = personal` beweisen.
- Testnachricht mit neutralem Inhalt, Zeit/Instanzkennung ohne sensible
  Diagnosedaten und klar erkennbarem Testzweck erstellen.
- Tests: erfolgreicher Local-/Managed-Test, empfangene From-/Reply-To-Header,
  Disabled, Missing Config, Timeout, TLS, Auth, Sender-/Recipient-Rejection,
  kein Fallback nach Test-/Sendefehler und keine Workspace-Mailboxauswahl.
- Verifikation: `npm run test:email:system`, Notification-/Todo-E-Mail-Tests,
  Workspace-Binding-Test und `npm run build`.
- Commit: `Send safe administrator email tests`.

### Phase 5: Settings-UI fachlich trennen und Zustände vollständig machen

- Einen kleinen E-Mail-Administrationscontainer einführen, in dem
  `SystemEmailSettingsPanel` und `WorkspaceMailboxesSettingsPanel` als
  Geschwister mit getrennten Capability-Props gerendert werden.
- Settings-Tab-Sichtbarkeit aus Instanz- und Organisationsberechtigung ableiten;
  nicht autorisierte Teilpanels weder rendern noch laden.
- Explizite Auswahl für Managed, Local und Disabled mit sichtbarem effektivem
  Versandweg, Configuration Source und Degraded-Status bauen.
- Lade-, Speichern-, Modus-, Entfernen- und Testzustände unabhängig behandeln,
  Doppelaktionen sperren und Erfolg erst nach bestätigter Serverresponse
  anzeigen.
- Passwortfelder immer leer laden; Status `gesetzt`, `fehlt` oder `nicht
  lesbar` getrennt darstellen und Keep/Replace bewusst senden.
- Bei fehlenden Keys oder nicht lesbarer Konfiguration konkrete Feldhinweise
  und einen direkten Link auf `/settings?tab=integrations` anzeigen.
- Echten Testempfänger als nicht editierbare Adminadresse vor dem Versand
  anzeigen; Erfolgstext spricht ausdrücklich von versendeter Testnachricht.
- Workspace-Panel zeigt seine separate Organisations-/Workspace-Bedeutung und
  Password-Status, ohne System-Absenderbegriffe zu verwenden.
- Deutsche und englische Texte, Fokusführung, `aria-live` für Statusmeldungen
  und zugängliche Labels ergänzen.
- Verifikation: fokussierter Komponenten-/Source-Test und `npm run build`;
  interaktive UI-/E2E-Prüfung nur nach expliziter Browserfreigabe.
- Commit: `Clarify administrator email settings`.

### Phase 6: Dokumentation, Gesamtabnahme und Ticketabschluss

- Produktdokumentation für Rollen, drei Modi, echten Testversand,
  Fallback-Regeln, Secret-Status, TLS/Port und Migration aktualisieren.
- Alle Ticket-09-Tests ausführen, gezieltes ESLint für geänderte Dateien und
  abschließend `npm run build`.
- Keine Container bauen, sofern dies nicht ausdrücklich angefordert wird.
- Mit expliziter Browserfreigabe die manuelle UI-Matrix ausschließlich auf
  `localhost:3000` abnehmen; vorhandenen Server verwenden und keinen zweiten
  starten. Anmeldung über `BOOTSTRAP_ADMIN_EMAIL` und
  `BOOTSTRAP_ADMIN_PASSWORD` aus der lokalen Env-Konfiguration.
- Ticketstatus und [Index](./README.md) erst nach vollständig grüner Abnahme
  auf `erledigt` setzen.
- Abschlusscommit: `Complete administrator email setup ticket`.

## Automatisierte Testmatrix

| Bereich | Positiver Fall | Negativer / Sicherheitsfall |
| --- | --- | --- |
| System-Status | vollständiges Local und verfügbares Managed werden korrekt redigiert angezeigt | Passwort, Token, Ciphertext, Raw-Content oder Secret-Pfad taucht in keiner JSON-Response auf |
| Speichern | Replace legt neue Konfiguration atomisch ab; Keep erhält das alte Passwort | ungültige/partielle Eingabe, unreadable Secret und Parallelmutation lassen die alte gültige Konfiguration und fremde Keys unverändert |
| Modus | Managed, Local und Disabled haben eindeutigen gespeicherten und effektiven Zustand | nicht verfügbare Route wird nicht still auf persönliche oder Workspace-Mail umgebogen |
| Testversand | angemeldeter Instanz-Admin erhält echte Local- bzw. Managed-Testmail | Nicht-Admin, beliebiger Empfänger, Rate-Limit, fehlende Config, Auth/TLS/Timeout und Provider-Rejection werden sicher abgewiesen |
| Fehler | stabile Codes und lokalisierbare Texte | Providerrohtext, Credentials oder Nachrichtentext fehlen in Response, Log und Audit |
| Env-Scope | kanonischer System-Scope und `0600` bleiben erhalten | generische Env-API liest/löscht/überschreibt reservierte System-E-Mail-Secrets nicht |
| Migration | canonical-wins bzw. genau ein eindeutiger Scoped-Kandidat wird idempotent bereinigt | divergierende, partielle oder nicht lesbare Kandidaten werden nicht gelöscht oder automatisch zusammengeführt |
| Business-Mailbox | Organisations-Admin verwaltet Mailbox der eigenen Organisation | fremde Organisation, deaktivierter Admin und erratene ID erhalten keinen Status oder Secret-Metadaten |
| Domänentrennung | System-Save/Test/Remove ändert nur System-Keys; Business-CRUD nur Account/Secret | Systemroute nutzt kein Workspace-Konto; Workspace-Operation ändert keinen Systemmodus oder System-Secret |
| Fallback | legacy ohne expliziten Modus kann ein persönliches aktives Konto verwenden | `account_scope = workspace`, Managed-/Local-Fehler und Disabled dürfen nie als persönlicher/Workspace-Fallback enden |

Vorgesehene Scripts:

- `npm run test:email:system` erweitern;
- neues fokussiertes Route-/Security-Script, zum Beispiel
  `test:email:system-admin-api`;
- `npm run test:email:workspace-binding` erweitern;
- `npm run test:email:accounts` für Validierungsparität erweitern;
- `npm run test:integrations:env-scope` erweitern;
- `scripts/legacy-secret-migration-test.ts` erweitern;
- relevante Todo-/Notification-E-Mail-Tests als Routingregression ausführen.

## Manuelle Abnahmekriterien

Die manuelle Abnahme erfolgt erst nach Implementierung und nur mit der
vorgeschriebenen Freigabe für Browser/Playwright:

1. Als Instanz-Admin `/settings?tab=system-email` öffnen und bestätigen, dass
   der System-Absender sichtbar ist; Passwortfelder sind leer und zeigen nur
   ihren Status.
2. Gültige Local-Konfiguration mit STARTTLS/587 speichern, neu laden und
   bestätigen, dass alle nicht geheimen Werte und der Passwortstatus korrekt
   bleiben.
3. Testnachricht auslösen, den angezeigten nicht editierbaren Adminempfänger
   prüfen und den tatsächlichen Empfang inklusive From und Reply-To bestätigen.
4. Host, Port, TLS, Username oder From ungültig machen; konkrete sichere
   Fehlermeldung und Integrations-Link prüfen. Nach Reload muss die vorherige
   gültige Konfiguration unverändert vorhanden sein.
5. Mit falschen Credentials bzw. kontrolliertem Timeout testen und bestätigen,
   dass UI und Network-Response nur providerneutralen Code/Text enthalten.
6. Managed, Local und Disabled nacheinander auswählen; gespeicherter Modus,
   effektive Route und Testverhalten müssen übereinstimmen.
7. Als Nicht-Admin die Routen direkt aufrufen und `403` bestätigen; bloßes
   Ausblenden des Tabs zählt nicht als Abnahme.
8. Als Organisations-Admin Business-Mailboxen der eigenen Organisation laden,
   bearbeiten und testen; fremde Organisations-ID darf weder sichtbar noch
   mutierbar sein.
9. Vor und nach System-Save/Test/Remove Snapshots der
   `email_accounts`-/`workspace_email_mailboxes`-Daten und Workspace-Secret-
   Referenzen vergleichen: keine Änderung.
10. Vor und nach Business-Mailbox-CRUD die reservierten System-E-Mail-Keys und
    den Systemmodus vergleichen: keine Änderung.
11. Network-Responses von Status, Save, Test, Env-GET und Env-PUT prüfen:
    Passwort, Token, Ciphertext, Raw-Zeile und Secret-Pfad kommen nicht vor.
12. Mobile/responsive Darstellung der Status-, Fehler- und Aktionsbereiche
    prüfen; diese UI-Prüfung erweitert den Scope nicht um ein Mobile-App-Ticket.

## Sicherheits- und Betriebsrisiken mit Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
| --- | --- |
| SMTP-Test wird als Relay missbraucht | Empfänger fest auf Session-Adminadresse, Rate Limit, generischer Inhalt, Audit |
| Providerfehler enthält Accountdaten | zentrale Klassifikation, Whitelist-Audit, keine Rohtexte im Client |
| Secret wird über Env-API oder Raw-Modus sichtbar | reservierte Key-Redaction in allen Serialisierungen und Preservation bei generischen Writes |
| Ganzdatei-Write verliert fremde Secrets | zielgerichtete serialisierte Mutation, opaque Preservation, atomisches Rename |
| Master-Key fehlt oder wurde rotiert | `unreadable` statt leer, keine Mutation, Konflikthinweis und Integrations-Link |
| Migration wählt falsche Kopie | canonical-wins, genau-ein-Kandidat-Regel, Hashvergleich, Backup/Manifest, fail closed |
| Organisationsübergreifender Mailboxzugriff | explizite `organizationId` in Guard und jedem Store-Query |
| TLS wird unbemerkt auf Plaintext herabgestuft | explizites `tlsMode`, `requireTLS` für STARTTLS, kein Plaintextmodus |
| Disabled sendet trotzdem über persönlichen Fallback | eigener Resolver-Endzustand `unavailable` und Regressionstest |
| UI zeigt Erfolg vor Persistenz/Test | getrennte Actions, Erfolg erst nach bestätigter Response, Reload-Abgleich |
| System und Workspace teilen zu viel Logik | nur zustandsfreie SMTP-Mechanik teilen; Actions und Persistenz getrennt halten |

## Definition of Done

- Alle Abnahmekriterien aus Ticket 09 sind nachweislich erfüllt.
- Instanz-Systemmail, persönliche Accounts und Business-/Workspace-Mailboxen
  haben getrennte Autorisierungs-, Persistenz- und Delivery-Grenzen.
- Jede relevante API-Methode prüft die passende Berechtigung serverseitig und
  Business-Mailbox-Lookups sind organisationsgebunden.
- Eine echte Testnachricht kann über Local und Managed an den angemeldeten
  Instanz-Admin versendet werden; Disabled und Fehlzustände fallen sicher aus.
- System-SMTP-Passwort, Tokens, Ciphertexte, Raw-Content und Secret-Refs werden
  in keiner Clientantwort, keinem Audit und keinem Log ausgegeben.
- Ungültige Eingaben, Providerfehler, Parallelmutationen und
  Entschlüsselungsprobleme zerstören keine zuvor gültige Konfiguration und
  keine fremden Integrationswerte.
- Fehlende oder nicht lesbare Konfiguration zeigt eine konkrete Meldung und
  den direkten Link `/settings?tab=integrations`.
- Bestehende Konfigurationen und Scope-Duplikate werden deterministisch,
  idempotent und ohne stillen Datenverlust behandelt.
- Die automatisierte Testmatrix, gezieltes Lint und `npm run build` sind grün.
- Die UI-Abnahme ist nach expliziter Browserfreigabe dokumentiert; es wurde
  kein Container ohne ausdrücklichen Auftrag gebaut.
- Jede Phase besitzt ihren eigenen fokussierten Commit. Ticket und Index werden
  erst im Abschlusscommit auf `erledigt` gesetzt.
