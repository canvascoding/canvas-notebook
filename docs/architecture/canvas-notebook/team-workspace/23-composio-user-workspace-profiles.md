# Composio User- und Workspace-Profile

Stand: 17. Juli 2026

## Entscheidung

Canvas Notebook verwendet weiterhin genau ein Composio-Projekt und einen
`COMPOSIO_API_KEY` pro lokaler beziehungsweise Managed-Installation. Die
Connected Accounts werden jedoch nicht an die Installation, die Organization
oder den Workspace-Owner gebunden, sondern an persoenliche Connection-Profile
des jeweils handelnden Users.

Jeder User besitzt:

- genau ein persoenliches Standardprofil,
- optional weitere persoenliche Connection-Profile,
- optional je Workspace eine Auswahl eines dieser eigenen Profile.

Ohne Workspace-Auswahl verwendet Canvas das persoenliche Standardprofil. Ein
Profil kann vom selben User in mehreren Workspaces wiederverwendet werden. Das
verhindert, dass bei jedem neuen Workspace alle Apps erneut verbunden werden
muessen.

Ein Workspace-Admin oder der Ersteller eines Team-Workspaces waehlt keine
Composio-Accounts fuer andere User aus. Jeder User entscheidet nur fuer sich
selbst, welches eigene Profil in einem Workspace aktiv ist. Zwei User im selben
Team-Workspace koennen deshalb unterschiedliche Composio-Accounts verwenden.

Instagram ist dabei nur ein Beispiel. Die Regeln gelten einheitlich fuer jedes
ueber Composio verwendete Toolkit.

Explizit nicht Teil von V1 sind Organization- oder Team-Connections, auf die
mehrere User gemeinsam zugreifen. Das waere spaeter eine eigene Ressource mit
Admin-Freigabe, Rollen, Audit und eigener Credential-Lifecycle-Policy; sie darf
nicht als Fallback fuer fehlende User-Connections dienen.

## Begriffe

| Begriff | Bedeutung |
|---|---|
| Composio-Projekt | Provider-Projekt hinter dem zentral konfigurierten API-Key |
| Connection-Profil | Persoenlicher Canvas-Container fuer eine stabile Composio User ID und deren Connected Accounts |
| Standardprofil | Genau ein automatisch verwendetes Connection-Profil pro Canvas User |
| Workspace-Override | Auswahl eines anderen eigenen Profils fuer genau einen Workspace |
| Effective Profile | Serverseitig aufgeloestes Profil fuer `userId + workspaceId` |
| Connected Account | Einzelne bei Composio gespeicherte App-Verbindung innerhalb eines Profils |

Der Anzeigename eines Profils, zum Beispiel `Meine Verbindungen`, `Company A`
oder `Company B`, ist Canvas-Metadatum. Er ist kein Composio-Account und kein
Secret.

## Zielverhalten

### Neuer User

Beim ersten Zugriff auf Composio erzeugt Canvas idempotent das Standardprofil
`Meine Verbindungen`. Seine externe Composio User ID wird serverseitig erzeugt
und bleibt stabil. Das Anlegen eines Users oder Workspaces startet keinen
OAuth-Flow.

### Neuer Workspace

Die Workspace-Erstellung bleibt unveraendert und enthaelt keine
Composio-Auswahl. Fuer jeden User gilt in dem neuen Workspace zunaechst dessen
eigenes Standardprofil. Der User kann spaeter in den Connected-Apps-Einstellungen
einen Override setzen.

### Anderes Profil fuer einen Workspace

Der User kann:

1. ein vorhandenes eigenes Profil waehlen,
2. ein neues persoenliches Profil erstellen und anschliessend waehlen,
3. zum Standardprofil zurueckkehren.

Beim Wechsel werden keine Connected Accounts kopiert. Canvas aendert nur die
Zuordnung fuer diesen User und Workspace. Dasselbe Profil kann in mehreren
Workspaces aktiv sein.

### App verbinden oder trennen

Connect, Refresh, Disconnect, Status, Toolkit-Liste und Tool-Ausfuehrung arbeiten
immer auf dem Effective Profile. Ein Disconnect betrifft deshalb das Profil und
damit alle Workspaces dieses Users, die dieses Profil verwenden. Die UI muss die
Auswirkung vor dem Trennen anzeigen.

V1 verwendet pro Toolkit und Profil eine effektive aktive Verbindung. Composio
unterstuetzt mehrere Connected Accounts pro Toolkit; eine zusaetzliche
Account-Auswahl innerhalb desselben Profils ist eine spaetere Erweiterung und
nicht notwendig, um Company-Accounts sauber zu trennen.

## Datenmodell

### `composio_connection_profiles`

| Spalte | Typ/Regel | Zweck |
|---|---|---|
| `id` | Text, Primary Key | Interne stabile Profil-ID |
| `owner_user_id` | FK User, not null | Ausschliesslicher Besitzer |
| `name` | Text, not null | Persoenlicher Anzeigename |
| `composio_user_id` | Text, unique, not null | Stabile externe Composio User ID |
| `is_default` | Boolean, not null | Genau ein Standardprofil pro User |
| `status` | `active`, `archived` | Lifecycle ohne stilles Wiederverwenden |
| `created_at` | Timestamp | Audit-Metadatum |
| `updated_at` | Timestamp | Audit-Metadatum |

Invarianten:

- Pro User existiert genau ein aktives Standardprofil.
- `composio_user_id` ist global eindeutig und nicht aus E-Mail, Name oder
  Workspace-Name ableitbar.
- Profile duerfen nur durch den Owner gelesen, umbenannt, gewaehlt oder
  archiviert werden.
- Das Standardprofil kann nicht archiviert werden.
- Ein verwendetes Profil kann erst archiviert werden, nachdem Overrides und
  betroffene Automations aufgeloest wurden.

### `composio_workspace_profile_overrides`

| Spalte | Typ/Regel | Zweck |
|---|---|---|
| `user_id` | FK User, not null | User, fuer den die Auswahl gilt |
| `workspace_id` | FK Workspace, not null | Aktiver Workspace |
| `profile_id` | FK Connection-Profil, not null | Gewaehltes eigenes Profil |
| `created_at` | Timestamp | Audit-Metadatum |
| `updated_at` | Timestamp | Audit-Metadatum |

Invarianten:

- Unique Key auf `user_id + workspace_id`.
- Das Profil muss `owner_user_id = user_id` und `status = active` haben.
- Der User muss beim Lesen und Schreiben weiterhin Zugriff auf den Workspace
  besitzen.
- Die Auswahl des Standardprofils wird als Loeschen des Overrides gespeichert.
- Ein Admin erhaelt durch seine Rolle keinen Zugriff auf Profile anderer User.

### OAuth-Flow-State

Der OAuth-Start muss Profile und Workspace sicher an den Callback binden. Dafuer
wird kurzlebiger, einmal verwendbarer State serverseitig gespeichert:

| Feld | Zweck |
|---|---|
| `nonce_hash` | Nicht erratbarer Callback-State, nur gehasht persistiert |
| `user_id` | User, der den Flow gestartet hat |
| `workspace_id` | Workspace, aus dem der Flow gestartet wurde |
| `profile_id` | Zielprofil |
| `composio_user_id` | Erwartete externe ID zur Abwehr falscher Zuordnung |
| `toolkit_slug` | Erwartetes Toolkit |
| `return_path` | Serverseitig erlaubter relativer Ruecksprung |
| `expires_at`, `consumed_at` | Ablauf und Replay-Schutz |

Falls der Composio-SDK-Flow keinen eigenen Callback-State zurueckliefert, muss
Canvas dieselbe Bindung ueber eine signierte, kurzlebige Return-Referenz
erzwingen. Freie Redirect-URLs vom Client sind nicht erlaubt.

## Serverseitiger Resolver

Alle Aufrufer verwenden eine gemeinsame Funktion, sinngemaess:

```ts
resolveEffectiveComposioProfile({
  userId,
  workspaceId,
  purpose,
})
```

Aufloesung:

1. Session beziehungsweise Background-Job liefert den verantwortlichen
   `userId`; ein Client darf keinen fremden User einsetzen.
2. Workspace-Zugriff wird serverseitig validiert.
3. Falls ein gueltiger Override fuer `userId + workspaceId` existiert, wird
   dessen Profil verwendet.
4. Sonst wird das Standardprofil des Users verwendet beziehungsweise
   idempotent angelegt.
5. Der Resolver liefert interne Profil-ID, externe `composioUserId`, Herkunft
   `default | workspace_override`, Workspace-ID und eine stabile Cache-Revision.

Es gibt keinen Fallback auf eine VM-, Organization-, Owner- oder
`local-user`-Identity. Der zentrale API-Key authentifiziert nur Canvas gegen das
eine Composio-Projekt; die externe User ID isoliert die Connections.

## API-Vertrag

Bestehende `/api/composio/*`-Routen werden workspace-aware. Der Workspace kommt
aus dem aktiven, serverseitig validierten Canvas-Kontext. Eine optionale
`workspaceId` aus Query oder Body ist nur eine Auswahlhilfe und niemals ein
Berechtigungsnachweis.

Neue Profil-Endpunkte:

| Route | Verhalten |
|---|---|
| `GET /api/composio/profiles?workspaceId=...` | Eigene Profile, Effective Profile und Override-Status listen |
| `POST /api/composio/profiles` | Eigenes Profil mit validiertem Namen anlegen |
| `PATCH /api/composio/profiles/[profileId]` | Eigenes Profil umbenennen |
| `DELETE /api/composio/profiles/[profileId]` | Unbenutztes eigenes Nicht-Standardprofil archivieren |
| `PUT /api/composio/workspace-profile` | Eigenes Profil fuer einen zugreifbaren Workspace setzen |
| `DELETE /api/composio/workspace-profile?workspaceId=...` | Override loeschen und Standard erben |

Bestehende Endpunkte fuer Status, Toolkits, Connect, Refresh und Disconnect
geben zusaetzlich den Effective-Profile-Kontext zurueck. Profil- oder
Connected-Account-Daten anderer User erscheinen weder in normalen noch in
Admin-Antworten.

## Runtime und Caches

Der `AgentExecutionContext` enthaelt bereits User und Workspace. Der
Tool-Registry-Aufbau muss den Effective-Profile-Resolver nach Vorliegen dieses
Kontexts aufrufen und `composioUserId` an Session, Gateway und alle vier
Composio-Meta-Tools weitergeben.

Das gilt fuer:

- Tool-Suche mit Connection-Status,
- Schema-Laden, soweit Connection-Status einfliesst,
- Tool-Ausfuehrung,
- `COMPOSIO_MANAGE_CONNECTIONS`,
- Auth-required Events und Connect-Links,
- lokale und Managed-Composio-Gateways.

Raw Toolkit-Metadaten und reine Tool-Schemas koennen global gecacht werden.
Jeder Cache mit Connection-, Session-, Account- oder Auth-Status muss mindestens
`mode + profileId/composioUserId` enthalten. Workspace-ID allein ist kein
geeigneter Cache-Key, weil ein Profil mehrere Workspaces bedienen kann. Beim
Connect, Callback, Refresh, Disconnect, Profilwechsel oder Archivieren werden
die betroffenen Profil-Caches invalidiert.

Auth-required Chat-Nachrichten speichern keine frei waehlbare externe User ID.
Sie tragen `workspaceId`, `profileId`, Profilname und Herkunft aus dem bereits
validierten Resolver, damit die UI den richtigen Kontext erklaeren kann.

## Automations und Trigger

### Geplante Automations

Eine Automation verwendet zur Ausfuehrung:

```text
responsibleUserId + automation.workspaceId -> Effective Profile
```

Damit folgt eine geplante Automation dem aktuellen Profil-Override ihres
verantwortlichen Users im Automation-Workspace. Run-Metadaten speichern die
aufgeloeste `profileId`, `composioUserId` und, soweit vorhanden,
`connectedAccountId`, damit ein vergangener Run auditierbar bleibt.

Kann kein aktives Profil oder keine benoetigte Connection aufgeloest werden,
laeuft die Automation nicht mit irgendeinem Fallback-Account. Sie wird mit einem
klaren Connection-Fehler pausiert beziehungsweise als fehlgeschlagen markiert.

### Composio Webhook-Trigger

Ein externer Trigger ist an einen konkreten Composio User und Connected Account
gebunden. Deshalb speichert der Webhook-Job zusaetzlich `composio_profile_id`.

Beim Wechsel des Workspace-Overrides:

1. Canvas ermittelt betroffene Trigger-Automations dieses Users im Workspace.
2. Fuer das Zielprofil wird geprueft, ob die benoetigte Toolkit-Verbindung
   existiert.
3. Wenn ja, wird der Trigger transaktional migriert beziehungsweise neu erstellt
   und erst danach der alte Trigger deaktiviert.
4. Wenn nein oder bei Teilfehler, wird der Override nicht unbemerkt wirksam fuer
   den Trigger. Der Job wird pausiert und die UI zeigt die notwendige Verbindung
   beziehungsweise Reparatur an.

Ein anderer User oder Workspace-Admin darf diesen Trigger nicht auf sein eigenes
Profil umhaengen. In der Automation-UI werden Profil- und Accountdetails nur dem
`responsibleUserId` gezeigt; andere berechtigte Betrachter sehen lediglich, dass
der verantwortliche User seine Verbindung verwalten muss.

## UI-Spezifikation

### Connected Apps: Kopfbereich

Der Bereich zeigt oberhalb der App-Liste:

- den aktiven Workspace,
- `Verwendet: Meine Verbindungen` oder den Namen des aktiven Profils,
- den Zustand `Standard wird verwendet` oder `Nur fuer diesen Workspace`,
- eine kurze Erklaerung: `Diese Auswahl gilt nur fuer dich. Andere Mitglieder
  verwalten ihre eigenen Verbindungen.`

Aktionen:

- bei geerbtem Standard: `Andere Verbindungen in diesem Workspace verwenden`,
- bei Override: `Profil wechseln`, `Standard wieder verwenden`, `Profil
  verwalten`.

### Profilauswahl

Der Dialog listet ausschliesslich eigene aktive Profile:

- Profilname,
- Kennzeichnung `Standard`,
- verbundene Apps als kompakte Logos/Namen,
- Anzahl der eigenen Workspaces, die das Profil verwenden.

Darunter steht `Neues Verbindungsprofil erstellen`. Die Auswahl eines Profils
setzt den Override; die Auswahl des Standards entfernt ihn. Der Dialog sagt
ausdruecklich, dass keine Accounts kopiert und keine Apps automatisch verbunden
werden.

### Profilverwaltung

Die Profilansicht zeigt:

- Namen und Standardstatus,
- verbundene Apps,
- eigene Workspaces, in denen das Profil effektiv verwendet wird,
- eigene betroffene Automations,
- `Profil umbenennen` und fuer unbenutzte Nicht-Standardprofile `Archivieren`.

`In diesem Workspace nicht mehr verwenden` und `App trennen` sind getrennte
Aktionen. Vor `App trennen` nennt die UI den aktiven Workspace, die Anzahl
expliziter eigener Workspace-Overrides und gebundener Automations. Beim
Standardprofil weist sie zusaetzlich darauf hin, dass weitere Workspaces das
Profil ohne eigenen Override erben koennen.

### Connect- und Auth-required-Flow

Ein Connect-Dialog nennt immer Workspace und Profil. Wenn das Standardprofil in
mehreren Workspaces verwendet wird, warnt er vor der groesseren Reichweite und
bietet:

- `In diesem Profil verbinden`,
- `Separates Profil fuer diesen Workspace erstellen`,
- `Anderes Profil waehlen`.

Die Auth-required-Karte im Chat zeigt denselben Kontext. Nach erfolgreichem OAuth
kehrt der User in den urspruenglichen Workspace und das urspruengliche Profil
zurueck.

### Workspace-Erstellung und Team-Administration

Im Create-Workspace-Dialog gibt es keine Composio-Felder. Organization-Admins
sehen in der Mitglieder- oder Workspace-Verwaltung keine Profilnamen, Apps,
Account-IDs oder Connection-Status anderer User. Sie duerfen hoechstens einen
neutralen Hinweis sehen, dass Integrationen persoenlich verwaltet werden.

### Automations-UI

Die Detailansicht zeigt den verantwortlichen User. Fuer diesen User werden das
Effective Profile und konkrete Reparaturaktionen angezeigt. Fuer alle anderen
lautet der Zustand sinngemaess: `Die Verbindungen werden vom verantwortlichen
User verwaltet.`

## Migration

Die bestehende user-scoped Composio Identity wird je User zum Standardprofil
`Meine Verbindungen`. Die vorhandene externe `composioUserId` bleibt erhalten,
damit bereits verbundene Apps nicht erneut authentifiziert werden muessen.

Migrationseigenschaften:

- idempotent und transaktional,
- kein automatisches Verschieben oder Kopieren von Provider-Credentials,
- keine Workspace-Overrides bei Migration; dadurch bleibt das Verhalten
  zunaechst unveraendert,
- mehrdeutige Legacy-Identities werden nicht geraten, sondern als klarer
  Reparaturzustand gemeldet,
- `COMPOSIO_API_KEY` bleibt zentral in der bestehenden Secret-Verwaltung.

`COMPOSIO_USER_ID` ist nach der Migration kein globaler fachlicher Schalter mehr.
Ein vorhandener Wert darf nur zur Uebernahme des eindeutig zugeordneten
Defaultprofils dienen und nicht fuer weitere User oder neue Profile
wiederverwendet werden.

## Sicherheits- und Datenschutzregeln

- Jede Route authentifiziert den Session-User und prueft Workspace-Zugriff.
- Jede Profiloperation prueft Ownership serverseitig.
- Der Client darf weder `ownerUserId` noch `composioUserId` festlegen.
- Logs und UI geben keine Tokens, Secrets oder Account-Details anderer User aus.
- Profil- und Workspace-Wechsel invalidieren alte Auth-/Session-Zustaende.
- OAuth-State ist kurzlebig, einmal verwendbar und an User, Workspace, Profil und
  Toolkit gebunden.
- Offboarding archiviert User-Profile, widerruft beziehungsweise trennt deren
  Connections nach bestehender Policy und pausiert betroffene Automations.
- Managed Control Plane transportiert die aufgeloeste externe User ID, darf aber
  keine Profile verschiedener Canvas User zusammenfassen.

## Implementierungsstand

Die V1-Implementierung ist abgeschlossen:

- Datenmodell, Legacy-Uebernahme und Effective-Profile-Resolver liegen in
  `app/lib/composio/composio-profiles.ts` und
  `app/lib/composio/composio-context.ts`.
- Profile, Workspace-Overrides und die workspace-aware bestehenden
  Composio-Routen sind unter `app/api/composio/*` umgesetzt.
- OAuth-State, Gateway-Sessions, Caches, Agent-Tools und Auth-required-Events
  sind an das aufgeloeste Profil gebunden.
- Connected Apps bietet persoenliche Profilauswahl, Erstellen, Umbenennen,
  Archivieren, Standard-Wiederherstellung sowie kontextbezogene Connect- und
  Disconnect-Warnungen.
- Scheduled Automations und Webhook-Trigger speichern beziehungsweise
  validieren das konkrete Profil. Trigger werden bei einem Profilwechsel sicher
  migriert oder sichtbar pausiert.
- Profil- und Accountdetails einer Automation werden nur dem verantwortlichen
  User praesentiert.

Automatisch verifiziert wurden:

- `npm run test:composio:user-scope`,
- `npx tsx --conditions react-server scripts/composio-user-workspace-profiles-test.ts`,
- `npm run test:db:sqlite-to-postgres-plan`,
- `npx tsx scripts/composio-profile-ui-test.ts`,
- gezieltes ESLint und `npx tsc --noEmit`,
- `npm run build` inklusive License-Gate und Next.js-Produktionsbuild.

Der Browser-E2E-Test bleibt gemaess Repository-Regel bis zur ausdruecklichen
Freigabe ausstehend. Es wurde kein Container gebaut oder gestartet.

## Umsetzungsreihenfolge

1. Datenmodell, Migration, Repository und Effective-Profile-Resolver inklusive
   Ownership-/Workspace-Tests.
2. Bestehende Composio-APIs, OAuth-State, Gateways, Sessions und Caches auf den
   Resolver umstellen.
3. Agent Runtime und Auth-required Events mit Workspace-/Profilkontext versehen.
4. Connected-Apps-UI, Profilauswahl, Profilverwaltung und Warnungen umsetzen.
5. Geplante Automations und Webhook-Trigger auf Responsible User plus Effective
   Profile umstellen.
6. Regressionstests, Lint und Build; nach expliziter Freigabe zusaetzlich ein
   Browser-E2E-Test mit zwei Usern, zwei Workspaces und mindestens zwei Profilen.

## Akzeptanzkriterien

- User A und User B verwenden im selben Team-Workspace unabhaengige Profile.
- Ein Admin kann weder Profile noch Accountdetails eines anderen Users lesen
  oder auswaehlen.
- Ein neuer Workspace verwendet ohne OAuth automatisch das Standardprofil jedes
  Users.
- Ein User kann ein Profil in mehreren Workspaces wiederverwenden.
- Ein Workspace-Override beeinflusst keine anderen User und keine anderen
  Workspaces desselben Users.
- Connect, Disconnect, Status und Agent-Ausfuehrung verwenden dasselbe Effective
  Profile.
- Vorhandene Verbindungen des bisherigen user-scoped Modells bleiben nach der
  Migration verwendbar.
- Scheduled Automations verwenden `responsibleUserId + workspaceId` und niemals
  einen globalen Fallback.
- Webhook-Trigger werden bei Profilwechsel validiert/migriert oder sichtbar
  pausiert.
- Caches leaken keinen Connection-Status zwischen Profilen.
- Workspace-Erstellung enthaelt keine Composio-Auswahl.
- Der zentrale API-Key bleibt die einzige Provider-Projekt-Konfiguration.

## Composio-Referenzen

- [Authentication and user isolation](https://docs.composio.dev/docs/authentication)
- [Connected Accounts API](https://docs.composio.dev/reference/v3/api-reference/connected-accounts)
- [Managing multiple connected accounts](https://docs.composio.dev/docs/managing-multiple-connected-accounts)
- [How Composio works](https://docs.composio.dev/docs/how-composio-works)
