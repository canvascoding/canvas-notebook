# Team-Seat Membership Path Inventory

Status: verbindliche Inventur für `canvas-team-seat-protocol-v1`
Stand: 2026-08-01
Task: `NB-TS-001`

## Zweck und Geltungsbereich

Dieses Dokument erfasst alle produktiven Pfade, die in Canvas Notebook einen
lokalen Benutzer oder dessen abrechenbaren Team-Status erzeugen, reaktivieren,
sperren oder entfernen können. Es ist die verbindliche Eingabe für den
Membership-Orchestrator, das Seat-Limit, die Control-Plane-Synchronisation und
die späteren Contract- und End-to-End-Tests.

Geprüft wurden:

- Better-Auth-Konfiguration und der zentrale Catch-all-Handler;
- Web-UI und Admin-APIs für Benutzerverwaltung;
- First-Run-Setup und Bootstrap-Scripts für SQLite und PostgreSQL;
- Organization-, Permission-, Workspace- und Offboarding-Services;
- Login-, Onboarding- und Mobile-API-Pfade;
- Migrationsexport, Migration-Inspection und Full-Restore;
- Workspace- und Agent-Mitgliedschaften;
- produktive Scripts außerhalb der reinen Test-Fixtures.

Direkte User-Inserts in `scripts/*test*` und E2E-Fixtures sind keine
Produktionspfade. Sie müssen in Tests weiterhin explizit als Fixture-Erzeugung
gekennzeichnet bleiben und dürfen nicht in Runtime-Code übernommen werden.

## Verbindliche Begriffe und Zählregel

### Lokaler Account

Ein Datensatz in der Better-Auth-Tabelle `user`. Die Existenz eines Accounts
allein macht ihn noch nicht zu einem aktiven oder abrechenbaren Team-Mitglied.

### Angenommenes Organization-Mitglied

Ein Benutzer mit einer lokalen Membership für die Notebook-Organization, dessen
Einladung oder direkte Aufnahme vollständig abgeschlossen wurde. Offene
Einladungen und Kandidaten sind keine angenommenen Mitglieder.

### Aktiver billable Seat

Ein Benutzer zählt genau dann als aktiver Team-Seat, wenn alle folgenden
Bedingungen erfüllt sind:

1. Die Team-Edition ist für die Instanz aktiv.
2. Die lokale Membership befindet sich im Zustand `active`.
3. Der Benutzer ist angenommen und nicht nur eingeladen oder vorgemerkt.
4. Der Better-Auth-Account ist nicht gebannt.
5. Der Benutzer ist nicht `suspended`, `removed`, `archived`,
   `recovery_locked`, `approval_required` oder `billing_pending`.

Owner, Admins, Members und aktive externe Organization-Mitglieder zählen nach
derselben Regel jeweils als ein Seat. Rollen ändern nicht die Quantity.
Workspace- und Agent-Zuweisungen eines bereits aktiven Organization-Mitglieds
erzeugen keinen zusätzlichen Seat.

### Community-Solo-Owner

Der erste lokale Owner bleibt in Community Solo kostenlos und ohne
Control-Plane-Konto nutzbar. Solange die Edition `solo` ist, ist dieser Account
kein kostenpflichtiger Team-Seat. Beim Upgrade auf Community Team wird derselbe
aktive Owner als Seat 1 in `activeSeatCount` und im angeforderten `seatLimit`
berücksichtigt. Es wird dafür kein zweiter Account erzeugt.

### Zustandsautorität

- Canvas Notebook ist die autoritative Quelle für Community-Team-Membership.
- Das Control Plane ist autoritativ für genehmigte/berechnete Quantity,
  Billing-Status und das signierte `seatLimit`.
- Ein lokaler Zustand darf einen Benutzer nie aktiv schalten, wenn das aktuell
  verifizierte Zertifikat danach weniger Seats erlaubt als lokal aktiv wären.
- Offene Einladungen sind nicht billable.
- Suspend oder Remove entzieht lokalen Zugriff sofort. Die idempotente
  Seat-Reduktion darf asynchron nachlaufen.

## Entscheidungsmatrix

| Pfad | Kostenwirkung | Quote | Approval | Seat-Change | `seatLimit` | Verbindliche Zielregel |
| --- | --- | --- | --- | --- | --- | --- |
| Erster Owner über Setup | Community Solo, kein Team-Seat | nein | nein | nein | Solo-Maximum 1 | Nur bei leerer User-Tabelle; erzeugt Owner atomar |
| Bootstrap-Admin auf leerer Instanz | Community Solo, kein Team-Seat | nein | nein | nein | Solo-Maximum 1 | Gleiche Ausnahme wie First-Run-Owner |
| Bootstrap-Admin synchronisiert bestehenden Owner | keine Quantity-Änderung | nein | nein | nein | ja | Darf Membership-Status oder Ban niemals reaktivieren |
| Direkte Team-User-Erstellung | `+1` | ja | ja | increase | vor Aktivierung | Erst Kandidat, dann Prepare/Approval/Execute/Cert, dann Better Auth |
| Einladung erstellen | noch keine Kosten | nein | nein | nein | nein | Persistiert nur `invited`; Kostenhinweis anzeigen |
| Einladung annehmen | `+1` | ja | ja | increase | vor Aktivierung | Annahme bleibt pending, bis Billing und Zertifikat bestätigt sind |
| Ban/Suspend | `-1` gewünschte Quantity | nein | nein | decrease | nein | Zugriff sofort sperren, Reduktion idempotent nachführen |
| Unban/Reaktivierung | `+1` | ja | ja | increase | vor Reaktivierung | Kein direktes Better-Auth-Unban vor gültigem Seat |
| Vollständiges Offboarding/Remove | `-1` gewünschte Quantity | nein | nein | decrease | nein | Daten behalten, Zugriff sofort entziehen |
| Rollenwechsel | keine Quantity-Änderung | nein | nein | nein | aktuelles Cert | Nur Berechtigungsänderung; aktive Membership bleibt bestehen |
| Passwortänderung | keine Quantity-Änderung | nein | nein | nein | nein | Kein Membership-Effekt |
| Login eines aktiven Team-Users | keine Quantity-Änderung | nein | nein | nein | bei jedem Login | Login ablehnen, wenn Zustand oder signiertes Limit nicht reicht |
| Mobile-Login | wie Web-Login | nein | nein | nein | bei jedem Login | Nutzt denselben serverseitigen Login-/Membership-Guard |
| SQLite-Full-Restore mit zusätzlichen aktiven Usern | mögliches `+n` | bei Erhöhung | bei Erhöhung | increase | vor Apply | Restore blockieren oder User pending importieren; nie still aktivieren |
| Bestehende User bei Upgrade Solo → Team | initiale Team-Quantity | ja | ja | set/increase | vor Team-Aktivierung | Owner eingeschlossen; zusätzliche lokale User erst nach Freigabe aktiv |
| Team → Solo/Downgrade | Reduktion auf Solo | nein | nein | decrease/cancel | Solo-Maximum 1 | Owner bleibt aktiv; weitere User werden gesperrt, nicht gelöscht |
| Workspace-Mitglied hinzufügen/entfernen | keine Quantity-Änderung | nein | nein | nein | gültige Team-Lizenz | Nur bereits aktive Organization-Mitglieder auswählbar |
| Agent-Mitglied hinzufügen/entfernen | keine Quantity-Änderung | nein | nein | nein | gültige Team-Lizenz | Nur Berechtigungszuweisung, kein neuer Organization-Seat |

`Approval` bedeutet eine an eine konkrete Quote gebundene Freigabe. Bei einem
serverseitig autorisierten Manual-/Test-Grant läuft derselbe fachliche Flow;
lediglich der Billing-Provider ist nicht Stripe.

## Inventarisierte produktive Pfade

### 1. First-Run-Owner

Einstieg:

- `POST /api/setup/owner`
- `app/lib/auth-setup.ts:createInitialOwner`

Aktueller Effekt:

- prüft, dass noch kein Auth-User existiert;
- erzeugt User und Credential-Account;
- erzeugt Organization, Owner-Permission und persönliche Workspace-Struktur;
- SQLite und PostgreSQL werden transaktional behandelt.

Klassifikation:

- einzige erlaubte account-erzeugende Ausnahme ohne Team-Quote;
- muss dauerhaft auf eine leere Instanz und genau einen Solo-Owner begrenzt
  bleiben;
- ein vorhandener Community-Solo-Owner wird beim späteren Team-Upgrade nicht
  neu angelegt, sondern als erster aktiver Seat gezählt.

### 2. Bootstrap-Admin-Scripts

Einstiege:

- `scripts/bootstrap-admin.js`
- `scripts/bootstrap-admin-postgres.ts`
- Environment: `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`,
  `BOOTSTRAP_ADMIN_ENSURE_ONLY`

Aktueller Effekt:

- erzeugt auf einer leeren Instanz den ersten Admin;
- aktualisiert auf bestehenden Instanzen Name, E-Mail, Rolle und Credential;
- bootstrapped Organization und persönliche Workspace-Struktur.

Klassifikation:

- Neuerstellung ist nur als First-Owner-Ausnahme zulässig.
- Auf einer nicht leeren Instanz darf der Pfad keinen zusätzlichen Account
  erzeugen.
- Die Synchronisation eines existierenden Accounts darf weder `banned` noch
  einen nicht aktiven Organization-Membership-Status zurücksetzen.
- Der Pfad muss später eine gemeinsame First-Owner-Invariante mit
  `createInitialOwner` verwenden.

### 3. Direkte Admin-Erstellung über Better Auth

Einstiege:

- `UserManagementPanel` → `authClient.admin.createUser`
- Better-Auth-Pfad `/api/auth/admin/create-user`
- anschließend `POST /api/onboarding/user-initialize`

Aktueller Effekt:

- Better Auth erzeugt sofort einen loginfähigen User;
- der Catch-all-Handler versucht nachträglich, Onboarding zu initialisieren;
- die UI wiederholt die Initialisierung bei einem Fehler;
- Organization-Permission und persönlicher Workspace können erst nach der
  Account-Erstellung entstehen.

Klassifikation:

- billable `+1`;
- in der Zielarchitektur verboten als direkter erster Schritt;
- wird vollständig durch einen serverseitigen Membership-Orchestrator ersetzt;
- der Better-Auth-Create-Call ist erst die lokale Commit-Phase nach
  Prepare/Approval/Execute und verifiziertem neuem Zertifikat.

### 4. Invitations

Aktueller Stand:

- Es gibt keinen produktiven Organization-Invitation-Flow.
- Workspace-Member- und Agent-Member-Routen sind keine Organization-
  Invitations und können nur vorhandene User referenzieren.

Zielklassifikation:

- Einladung erzeugen: `invited`, nicht billable, keine Seat-Änderung;
- Einladung annehmen: billable `+1`, Quote/Approval/Seat-Increase vor
  Aktivierung;
- abgelaufene, widerrufene oder abgelehnte Einladungen ändern die Quantity
  nicht;
- die UI weist bereits beim Versand darauf hin, dass die Annahme Kosten
  auslösen kann.

### 5. Ban und Unban

Einstiege:

- `authClient.admin.banUser`
- `authClient.admin.unbanUser`
- Better-Auth-Pfade unter `/api/auth/admin/*`

Aktueller Effekt:

- Ban/Unban ändert den Better-Auth-Zugriff direkt;
- der Organization-Membership-Status und Billing-Zustand werden nicht
  koordiniert.

Klassifikation:

- Ban wird als Suspend behandelt: Zugriff sofort sperren und gewünschte
  Quantity um eins reduzieren.
- Unban ist eine kostenwirksame Reaktivierung und benötigt denselben
  Prepare-/Approval-/Execute-/Cert-Flow wie ein neuer User.
- Ein archivierter/offboarded User darf nicht über den allgemeinen
  Better-Auth-Unban-Pfad reaktiviert werden.

### 6. Vollständiges Offboarding

Einstiege:

- `GET /api/admin/organization/users/:userId/offboarding`
- `POST /api/admin/organization/users/:userId/offboarding`
- `app/lib/organization/offboarding.ts:offboardUser`

Aktueller Effekt:

- bannt den User und widerruft Sessions/Credentials;
- pausiert Automationen und entfernt Workspace-Zuweisungen;
- sperrt den persönlichen Workspace für Recovery;
- setzt Organization-Permission auf `archived`;
- bewahrt Daten und schreibt ein Manifest.

Klassifikation:

- gewünschte Quantity `-1`;
- lokales Sperren bleibt die erste, transaktionale Aktion;
- nach Commit wird eine idempotente Seat-Reduktion in die Outbox geschrieben;
- ein Control-Plane-Ausfall darf das lokale Sperren nicht rückgängig machen.

### 7. Rollen und individuelle Permissions

Einstiege:

- `PATCH /api/admin/organization/users/:userId/role`
- `PATCH /api/admin/organization/users/:userId/permissions`
- Better-Auth-Rollenabbildung für `admin` und `user`

Klassifikation:

- keine Änderung der Seat-Quantity;
- Owner, Admin, Member und aktive externe Organization-Mitglieder zählen
  jeweils einmal;
- Rollenwechsel bleiben Team-lizenziert und auditiert;
- Rollenwechsel dürfen keinen pending, suspendierten oder archivierten User
  aktivieren.

### 8. Organization- und Workspace-Bootstrap

Einstiege:

- `ensureOrganizationBootstrapForUser`
- `ensurePostgresOrganizationBootstrapForUser`
- `POST /api/onboarding/user-initialize`
- verschiedene Workspace-Listing- und Workspace-Routen

Aktueller Effekt:

- eine fehlende Organization-Permission kann für einen existierenden Auth-User
  implizit mit Status `active` erzeugt werden;
- persönliche Workspace-Struktur wird angelegt.

Klassifikation:

- dieser Pfad darf künftig keine billable Membership erzeugen;
- ein fehlender Membership-Datensatz bei einem Nicht-Owner ist kein
  Bootstrap-Fall, sondern ein Drift-/Import-Fall;
- Workspace-Initialisierung wird erst nach aktiver Membership ausgeführt;
- beim Login darf Bootstrap nur den bestehenden, bereits autorisierten Zustand
  reparieren, nie Billing umgehen.

### 9. Login-Gates

Einstiege:

- Better-Auth `sign-in` unter `/api/auth/*`
- Web-Login unter `/:locale/login`
- Expo/Bearer-Authentifizierung über dieselbe Better-Auth-Instanz
- WebSocket-Authentifizierung in den Collaboration-Servern

Aktueller Effekt:

- öffentliche Registrierung ist deaktiviert;
- Better Auth blockiert gebannte Accounts;
- es gibt noch keinen zentralen Vergleich zwischen lokal aktiven Team-Usern
  und signiertem `seatLimit`.

Zielklassifikation:

- Community-Solo-Owner darf ohne Control Plane und Internet einloggen.
- Ein Team-Login verlangt eine aktive lokale Membership und ein gültiges
  Zertifikat, dessen `seatLimit` den vollständigen aktiven Seat-Count deckt.
- `billing_pending`, `approval_required`, `suspended`, `removed`, `archived`
  und `recovery_locked` werden vor Session-Ausgabe blockiert.
- Mobile, Web und WebSocket verwenden dieselbe serverseitige Entscheidung.

### 10. Import und Restore

Einstiege:

- Migration-Upload und Inspection unter `/api/migration/*`
- `app/lib/migration/restore-service.ts`
- `scripts/apply-pending-migration-restore.ts`

Aktueller Effekt:

- ein SQLite-Full-Restore ersetzt die Datenbank und kann dadurch Auth-User und
  aktive Organization-Permissions aus einer anderen Instanz einführen;
- Sessions werden invalidiert;
- Instanzidentität und Teile der Lizenzdaten werden abhängig vom Runtime-Modus
  bewahrt;
- die aktuelle Inspection kann User-Mappings erkennen, führt aber noch keine
  Team-Seat-Freigabe durch.

Klassifikation:

- Restore ist ein potenzieller `+n`- oder Reaktivierungspfad.
- Die Dry-Run-Prüfung muss den resultierenden aktiven Seat-Count bestimmen.
- Liegt er über dem signierten Limit, wird der Restore vor Apply blockiert oder
  alle zusätzlichen User werden als nicht aktive Import-Kandidaten übernommen.
- Eine automatische kostenpflichtige Erhöhung ohne explizite Quote und
  Approval ist unzulässig.
- Die Ziel-Instance-ID, das Instance-Token, das lokale Entitlement und die
  Membership-Revision dürfen nicht aus dem Backup überschrieben werden.
- Nach Apply wird zwingend ein vollständiger Snapshot mit höherer Revision
  gesendet, bevor zusätzliche Team-User einloggen können.

### 11. Mobile-Pfade

Geprüfte produktive Bereiche:

- `/api/mobile/v1/bootstrap`
- mobile Better-Auth-/Bearer-Sessions
- `/api/mobile/v1/workspaces*`
- mobile Lizenzstatus-, Registrierungs- und Aktivierungsrouten

Ergebnis:

- Die Expo-App besitzt derzeit keinen eigenen Organization-User-Create-,
  Invitation-, Ban-, Unban-, Role- oder Offboarding-Pfad.
- Mobile Workspace-Member-Routen lesen oder ändern nur Zuweisungen bereits
  existierender Organization-Mitglieder.
- Die Expo-App darf auch künftig weder Instance-Token noch Seat-Operationen
  direkt zum Control Plane senden.
- Mobile Login, Bootstrap und Workspace-Zugriff müssen dieselbe serverseitige
  aktive-Membership- und `seatLimit`-Prüfung verwenden.

### 12. Nicht billable Membership-Begriffe

Die folgenden Tabellen oder APIs verwenden ebenfalls den Begriff `member`,
ändern aber nicht die Team-Seat-Quantity:

- `canvas_workspace_members`;
- `canvas_project_members`;
- Agent-Member-/Agent-Grant-Zuweisungen;
- Kollaborations-Presence und aktive Sessions;
- Todo-Assignees;
- Channel- oder Integration-Bindings.

Sie dürfen ausschließlich bereits aktive Organization-Mitglieder referenzieren.
Wenn ein unbekannter oder nicht aktiver User über einen dieser Pfade übergeben
wird, muss der Request abgelehnt werden; es darf kein impliziter User oder
Organization-Member entstehen.

## Verbindliche Runtime-Invarianten

1. Nur der Membership-Orchestrator darf nach dem First-Owner-Setup einen User
   in den Zustand `active` bringen.
2. Kein Browser-, Mobile- oder Better-Auth-Admin-Request darf diese Invariante
   umgehen.
3. `activeSeatCount` wird ausschließlich aus angenommenen, aktiven lokalen
   Memberships berechnet und enthält in Team den Owner.
4. `activeSeatCount <= verifiedCertificate.seatLimit` gilt vor Create,
   Invitation-Accept, Unban, Restore-Aktivierung und Login.
5. Quote und Approval beziehen sich auf exakte vorherige und gewünschte
   Quantity sowie eine monotone Membership-Revision.
6. Seat-Increase und lokale Aktivierung sind idempotent und crash-resistent.
7. Suspend/Remove sperrt lokal sofort; die Reduktion wird per Outbox
   nachgeführt.
8. Rollen, Workspace-Zuweisungen und Agent-Zuweisungen ändern die Seat-Quantity
   nicht.
9. Community Solo bleibt mit genau einem Owner ohne Control Plane nutzbar.
10. Downgrade, Nichtzahlung und abgelaufene Grace löschen keine User- oder
    Workspace-Daten.

## Nachweis für nachfolgende Tasks

Die folgenden Implementierungsstellen müssen auf diese Inventur zurückgeführt
werden:

- `NB-TS-010`: Zustände für Kandidaten, Invitations und Memberships;
- `NB-TS-040`: einzige serverseitige Membership-Orchestrator-Grenze;
- `NB-TS-043` und `NB-TS-044`: direkte Erstellung und Invitation-Accept;
- `NB-TS-045` und `NB-TS-046`: Suspend, Offboarding, Rollen und Reaktivierung;
- `NB-TS-047`: Seat-Limit in allen oben aufgeführten Pfaden;
- `NB-TS-071` bis `NB-TS-076`: State-, Mock-, E2E- und Cross-Repository-Tests.
