# Direct V1 MCP OAuth Implementation Plan

> Stand: 2026-08-02
> Status: Umsetzung läuft – MCP-OAUTH-01 bis MCP-OAUTH-04 abgeschlossen
> Scope: ausschließlich direkte OAuth- und MCP-Anbindung einer einzelnen Canvas-Notebook-Instanz

## 1. Ziel und Reihenfolge

V1 verbindet ChatGPT oder einen anderen MCP-Client direkt mit genau einer Canvas-Notebook-Instanz:

```text
https://{instance-domain}/mcp
```

Die Instanz ist gleichzeitig:

- OAuth Authorization Server über das vorhandene Better Auth.
- MCP Resource Server.
- Benutzer- und Workspace-Autorität.
- Ausführungsort der späteren MCP-Tools.

Canvas Control Plane, zentraler Canvas-Account, Cloud Link, Relay und User-Pairing sind nicht Bestandteil von V1.

Die Reihenfolge ist verbindlich:

1. Better Auth OAuth Provider und Datenbankschema integrieren.
2. OAuth ohne fachliche MCP-Tools vollständig testen.
3. Einen minimalen MCP-`auth_probe` zum Test der Client-Integration bereitstellen.
4. OAuth mit MCP Inspector und ChatGPT Developer Mode Ende-zu-Ende testen.
5. Erst nach bestandenem Gate die fachlichen MCP-Tools implementieren.

Der minimale `auth_probe` ist kein vorgezogener MCP-Produktumfang. Er ist nötig, weil ChatGPT den OAuth-Dialog erst durch die Security-Metadaten und den Auth-Challenge eines MCP-Tools vollständig auslöst.

## 2. Festgelegter V1-Vertrag

### 2.1 Öffentliche Endpunkte

| Zweck | URL |
|---|---|
| MCP Resource und Transport | `https://{instance-domain}/mcp` |
| Protected Resource Metadata, kanonisch | `https://{instance-domain}/.well-known/oauth-protected-resource/mcp` |
| Protected Resource Metadata, Kompatibilitätsalias | `https://{instance-domain}/.well-known/oauth-protected-resource` |
| Better Auth Issuer | `https://{instance-domain}/api/auth` |
| Authorization Server Metadata, kanonisch | `https://{instance-domain}/.well-known/oauth-authorization-server/api/auth` |
| Authorization Server Metadata, Issuer-Alias | `https://{instance-domain}/api/auth/.well-known/oauth-authorization-server` |
| JWKS | `https://{instance-domain}/api/auth/jwks` |

Die konkrete Authorization-, Token-, Registration-, Revocation- und Introspection-URL wird nicht im Anwendungscode dupliziert, sondern aus den Better-Auth-Metadaten gelesen.

### 2.2 Origin und Issuer

`BETTER_AUTH_BASE_URL` bleibt die externe Origin der Instanz:

```text
https://{instance-domain}
```

Der Wert enthält weder `/api/auth` noch `/mcp`. Der bestehende Better-Auth-Basispfad `/api/auth` ergibt daraus den Issuer:

```text
https://{instance-domain}/api/auth
```

Proxy-, TLS- und Forwarded-Host-Konfiguration müssen sicherstellen, dass Better Auth ausschließlich die öffentliche Origin in Redirects und Metadaten ausgibt. Ein Host-Header darf den Issuer nicht frei beeinflussen.

### 2.3 Resource und Audience

Die kanonische OAuth Resource ist immer:

```text
https://{instance-domain}/mcp
```

Der Authorization Request und der Token Request müssen diese Resource übernehmen. Das resultierende Access Token muss genau auf diese Resource als Audience gebunden sein. Token einer anderen Canvas-Notebook-Instanz oder einer anderen Route sind ungültig.

### 2.4 Benutzeridentität

- `sub` entspricht der lokalen Better-Auth-`user.id`.
- Der Benutzer meldet sich mit seinem bestehenden lokalen Canvas-Notebook-Konto an.
- E-Mail-Adresse und Passwort verlassen die Instanz nicht.
- `email` und `profile` sind keine V1-MCP-Scopes.
- Ein inaktiver, gesperrter oder gelöschter lokaler Benutzer wird trotz formal gültigem Access Token abgewiesen.

### 2.5 Scopes

Vom Authorization Server erlaubte V1-Scopes:

```text
openid
offline_access
workspace:list
knowledge:tree
knowledge:search
knowledge:read
```

Dabei gilt:

- `openid` liefert eine stabile lokale Subject-Identität.
- `offline_access` darf nur nach explizitem Consent ein Refresh Token ermöglichen.
- DCR registriert standardmäßig nur `openid`.
- Ein Client darf ausschließlich Scopes aus der Allowlist anfordern.
- Jedes MCP-Tool deklariert seinen benötigten Scope.
- Der tatsächliche Zugriff ist immer Token-Scope geschnitten mit der aktuellen lokalen ACL.

Die effektive V1-Autorisierung lautet:

```text
gültige Lizenz/Aktivierung
∩ gültiger OAuth-Grant und Consent
∩ gültiges Token für den exakten Issuer und die exakte Resource
∩ benötigter Tool-Scope
∩ aktiver lokaler Benutzer
∩ aktuelle lokale Workspace-ACL
```

Eine zusätzliche Workspace-Allowlist ist nicht Teil des isolierten OAuth-Proofs. Vor Beginn der realen Knowledge-Tools wird in einem eigenen Security Gate entschieden, ob sie bereits in V1 benötigt wird.

## 3. Better-Auth-Zielkonfiguration

### 3.1 Abhängigkeiten

Die App löst aktuell Better Auth 1.6.23 auf. Der erste Implementierungsversuch pinnt deshalb `better-auth`, `@better-auth/expo` und `@better-auth/oauth-provider` gemeinsam auf 1.6.23. Falls ein Upgrade erforderlich ist, werden alle Better-Auth-Pakete gemeinsam angehoben; gemischte Core-Versionen sind nicht zulässig.

Geplante Imports:

```ts
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
```

Auf dem Client wird für die Consent-Seite ergänzt:

```ts
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
```

### 3.2 Provider-Optionen

Die Zielkonfiguration wird beim Implementierungstodo gegen die installierten TypeScript-Typen geprüft. Inhaltlich gilt:

```ts
jwt(),
oauthProvider({
  loginPage: "/login",
  consentPage: "/oauth/consent",
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  grantTypes: ["authorization_code", "refresh_token"],
  scopes: [
    "openid",
    "offline_access",
    "workspace:list",
    "knowledge:tree",
    "knowledge:search",
    "knowledge:read",
  ],
  clientRegistrationDefaultScopes: ["openid"],
  clientRegistrationAllowedScopes: [
    "openid",
    "offline_access",
    "workspace:list",
    "knowledge:tree",
    "knowledge:search",
    "knowledge:read",
  ],
  codeExpiresIn: 5 * 60,
  accessTokenExpiresIn: 15 * 60,
  refreshTokenExpiresIn: 30 * 24 * 60 * 60,
})
```

Zusätzliche Regeln:

- PKCE bleibt verpflichtend; für öffentliche Clients ausschließlich `S256`.
- `client_credentials` ist für Benutzerzugriff nicht erlaubt.
- Dynamisch registrierte Clients dürfen Consent nicht überspringen.
- `allowPublicClientPrelogin` wird nur aktiviert, falls der getestete ChatGPT-Flow es tatsächlich benötigt.
- `nextCookies()` bleibt der letzte Better-Auth-Plugin-Schritt.
- JWT/JWKS bleibt aktiviert, damit die MCP Resource Tokens lokal und ohne Control Plane prüfen kann.

### 3.3 Dynamic Client Registration

ChatGPT erhält die Redirect URI erst bei der Verbindung. Deshalb erlaubt V1 unauthenticated DCR für öffentliche Clients.

Diese öffentliche Oberfläche erfordert:

- Rate Limit pro IP und Instanz.
- maximale Request-Größe.
- strikte Validierung der Redirect URIs durch die OAuth-Bibliothek.
- ausschließlich erlaubte Grant Types und Scopes.
- keine frei registrierbaren vertraulichen Clients mit vom Aufrufer gesetzten Secrets.
- Audit Event ohne Client Secret, Code oder Token.
- Aufräumstrategie für ungenutzte dynamische Clients.

DCR ist eine bewusst begrenzte V1-Kompatibilitätsentscheidung. Bei späteren Upgrades wird geprüft, ob ChatGPT Client ID Metadata Documents unterstützt und DCR dadurch geschlossen werden kann.

### 3.4 Login und Consent

Der vorhandene Login bleibt die einzige Benutzeranmeldung. Er muss jedoch den signierten Better-Auth-OAuth-Kontext erhalten und darf nach erfolgreichem Login nicht pauschal zur Startseite umleiten.

Die Consent-Seite:

- liegt stabil unter `/oauth/consent`.
- zeigt Clientname, Instanzdomain und angeforderte Scopes.
- erlaubt explizites Akzeptieren oder Ablehnen.
- ruft `authClient.oauth2.consent(...)` über `oauthProviderClient()` auf.
- zeigt keine geheimen OAuth-Parameter an.
- funktioniert auf Deutsch und Englisch, ohne die stabile OAuth-Route zu lokalisieren.
- bietet keinen „Consent immer überspringen“-Pfad für dynamische Clients.

### 3.5 Datenbankschema

Nach aktuellem Better-Auth-OAuth-/JWT-Modell werden mindestens folgende Tabellen erwartet:

```text
oauthClient
oauthAccessToken
oauthRefreshToken
oauthConsent
jwks
```

Das genaue Schema wird mit der tatsächlich gepinnten Better-Auth-Version generiert. Danach wird es manuell in die bestehende Drizzle-Struktur und die anwendungseigenen Migrationen übernommen:

- SQLite: Schema und idempotente Startup-Migration.
- PostgreSQL: Schema, Erstellung und idempotente Migration.
- Upgrade einer bestehenden Datenbank.
- Neuinstallation mit leerer Datenbank.

Die Better-Auth-CLI darf die produktive Datenbank nicht eigenständig verändern.

## 4. MCP-Authentifizierungsvertrag

### 4.1 Protected Resource Metadata

Die Metadaten enthalten mindestens:

```json
{
  "resource": "https://{instance-domain}/mcp",
  "authorization_servers": [
    "https://{instance-domain}/api/auth"
  ],
  "scopes_supported": [
    "workspace:list",
    "knowledge:tree",
    "knowledge:search",
    "knowledge:read"
  ],
  "bearer_methods_supported": ["header"]
}
```

Die kanonische path-aware URL wird bevorzugt. Der Root-Alias liefert denselben fachlichen Inhalt.
Die Protected-Resource-Metadaten nennen ausschließlich Resource-Scopes.
`openid` und `offline_access` bleiben in den Authorization-Server-Metadaten,
weil sie vom Authorization Server und nicht von der MCP Resource verarbeitet werden.

### 4.2 Token-Prüfung

Jeder geschützte MCP-Request prüft:

1. Bearer Token vorhanden.
2. Signatur gegen das lokale JWKS gültig.
3. Issuer entspricht exakt `https://{instance-domain}/api/auth`.
4. Audience enthält exakt die kanonische MCP Resource
   `https://{instance-domain}/mcp`. Bei `openid` darf Better Auth zusätzlich nur
   die Userinfo-Audience derselben Instanz ergänzen; fremde Audiences bleiben
   unzulässig.
5. Token ist noch nicht abgelaufen.
6. Token oder zugehöriger Grant ist nicht widerrufen.
7. benötigter Scope ist enthalten.
8. lokaler Benutzer existiert und ist aktiv.
9. lokale Workspace-ACL erlaubt die konkrete Operation.

Die Prüfung verwendet nach Möglichkeit den Better-Auth-Resource-Client beziehungsweise dessen `verifyAccessToken`-Helper mit expliziter Audience. Eigene JWT-Logik wird nur ergänzt, wenn die Bibliothek eine erforderliche MCP-Prüfung nicht abdeckt.

Better Auth `1.6.23` prüft eine JWT-Revocation kryptografisch, speichert den
Widerruf eines selbst enthaltenen JWTs aber nicht. V1 bindet deshalb jeden
MCP-Access-Token zusätzlich an seine lokale Better-Auth-Session. Eine
erfolgreiche Access- oder Refresh-Token-Revocation sperrt atomar die zugehörigen
Refresh-Grants und entfernt diese Session. Der gemeinsame Verifier verlangt die
weiterhin aktive Session; ein widerrufenes Token ist dadurch sofort und auch
nach einem Refresh-Versuch unbrauchbar.

### 4.3 Auth-Challenge

Ein Request ohne Token antwortet mit `401` und:

```text
WWW-Authenticate: Bearer resource_metadata="https://{instance-domain}/.well-known/oauth-protected-resource/mcp"
```

Ein MCP-Tool deklariert sein `securitySchemes`. Beim geschützten Tool-Fehler wird zusätzlich `_meta["mcp/www_authenticate"]` gesetzt, damit ChatGPT den OAuth-Dialog zuverlässig öffnet.

Fehlt nur ein Scope, nennt der Challenge ausschließlich den tatsächlich benötigten Scope und gibt keine geschützten Daten zurück.

## 5. Strikt sequenzielle Todos

Es darf immer nur ein Todo `in_progress` sein. Jedes Todo wird getestet und separat abgeschlossen, bevor das nächste beginnt. Die maschinenlesbare Fassung steht in [`todo.json`](./todo.json).

### MCP-OAUTH-01 – Versionen und Schema-Snapshot

Ergebnis:

- kompatible, exakt festgelegte Better-Auth-Pakete.
- generiertes OAuth-/JWT-Schema als Review-Grundlage.
- dokumentierter Diff zum vorhandenen Schema.

Prüfung:

- npm löst genau eine kompatible Better-Auth-Core-Version auf.
- TypeScript akzeptiert die vorgesehenen Plugin-Optionen.
- noch keine produktive Route ist aktiviert.

### MCP-OAUTH-02 – SQLite- und PostgreSQL-Migrationen

Ergebnis:

- OAuth- und JWKS-Tabellen im zentralen Drizzle-Schema.
- idempotente Migrationen für beide Datenbankprovider.
- keine Veränderung vorhandener Auth-Daten.

Prüfung:

- frische SQLite-Datenbank.
- Upgrade einer bestehenden SQLite-Datenbank.
- frische PostgreSQL-Datenbank.
- Upgrade einer bestehenden PostgreSQL-Datenbank.
- zweiter Migrationslauf bleibt ohne Fehler und ohne Schemaänderung.

### MCP-OAUTH-03 – Better Auth OAuth Provider und Discovery

Ergebnis:

- JWT- und OAuth-Provider-Plugins eingebunden.
- Grants, Scopes und Laufzeiten wie festgelegt.
- Authorization-Server-Metadaten unter beiden Discovery-Varianten.
- DCR nur mit festgelegten öffentlichen Clientregeln.

Prüfung:

- Metadaten enthalten den exakten öffentlichen Issuer.
- `authorization_code` und `refresh_token` sind erlaubt, `client_credentials` nicht.
- PKCE `S256` wird angekündigt und erzwungen.
- nicht erlaubte Scopes und Redirect URIs werden abgewiesen.

### MCP-OAUTH-04 – Login-Continuation und Consent

Ergebnis:

- der bestehende lokale Login erhält den signierten OAuth-Kontext.
- stabile, zweisprachige Consent-Seite.
- Akzeptieren und Ablehnen funktionieren.
- Consent wird benutzer-, client- und scopegebunden gespeichert.

Prüfung:

- ausgeloggter Benutzer kehrt nach Login in denselben OAuth-Flow zurück.
- bereits eingeloggter Benutzer gelangt direkt zum Consent.
- Ablehnung liefert einen standardkonformen OAuth-Fehler.
- manipulierte oder abgelaufene OAuth-Query wird abgewiesen.
- bestehender normaler Login funktioniert unverändert.

Die ausdrückliche Freigabe für den Playwright-Lauf wurde am 2026-08-02 erteilt.
Der funktionale OAuth-Flow, die servergerenderten deutschen und englischen
UI-Zustände sowie Build, Typen und Lint sind geprüft. Der lokale macOS-Host
beendet Chromium jedoch vor dem ersten Tab; der echte Screenshot-Lauf bleibt
deshalb als abschließender QA-Nachweis in `MCP-OAUTH-09` offen.

### MCP-OAUTH-05 – Protected Resource Metadata und Token-Verifier

Ergebnis:

- kanonische path-aware Resource-Metadaten plus Root-Alias.
- gemeinsame serverseitige Verifier-Funktion für späteren MCP-Transport.
- standardkonforme `WWW-Authenticate`-Challenges.
- öffentliche Routing-Ausnahmen nur für Discovery und OAuth-Einstieg; die Resource autorisiert sich selbst.

Prüfung:

- korrekter Issuer und exakte Resource.
- Token einer anderen Resource oder Instanz wird abgewiesen.
- abgelaufenes, manipuliertes oder widerrufenes Token wird abgewiesen.
- fehlender Scope führt zu `403` mit geeignetem Challenge.
- deaktivierter lokaler Benutzer wird abgewiesen.

### MCP-OAUTH-06 – isolierter OAuth-Conformance-Test

Ergebnis:

- automatisierter Testclient erzeugt PKCE-Verifier und `S256`-Challenge.
- vollständiger DCR-, Authorization-, Token-, Refresh- und Revocation-Ablauf.
- Negativtests sind reproduzierbar.

Implementiert als `scripts/mcp-server-oauth-client-test.ts` beziehungsweise
`npm run test:mcp:server-oauth-client`. Der Test verwendet die produktiven
Next.js-Auth-Route-Handler mit einer isolierten SQLite-Datenbank und einem
öffentlichen PKCE-S256-Client.

Pflichtfälle:

- Discovery und DCR erfolgreich.
- Authorization Code ist nur einmal verwendbar.
- fehlendes oder `plain` PKCE wird abgewiesen.
- Redirect-URI-Mismatch wird abgewiesen.
- Resource wird in Authorization und Token Request übernommen.
- Access Token enthält beziehungsweise validiert die exakte Audience.
- Refresh rotiert das Token.
- Revocation beendet den weiteren Zugriff.
- falscher Issuer, falsche Audience, falscher Scope und abgelaufenes Token schlagen fehl.
- Logs enthalten keine Codes, Access Tokens, Refresh Tokens oder Passwörter.

Abschluss-Gate:

- OAuth selbst ist technisch freigegeben.
- Noch keine fachlichen MCP-Tools werden begonnen.

### MCP-OAUTH-07 – minimaler MCP-Auth-Probe

Ergebnis:

- Streamable-HTTP-MCP-Transport unter `/mcp`.
- ausschließlich ein nicht fachliches Tool `auth_probe`.
- Tool-Security-Schema und MCP-Auth-Challenge korrekt.
- der Probe gibt nur lokale Benutzer-ID in redigierter Form und bestätigte Scopes zurück, keine Workspace-Daten.

Prüfung:

- MCP-Initialisierung ohne Datenzugriff.
- unauthentifizierter Probe löst OAuth-Challenge aus.
- authentifizierter Probe funktioniert nur mit korrekter Audience und Scope.
- ein Token einer anderen Instanz wird abgewiesen.

### MCP-OAUTH-08 – externer End-to-End-Test

Reihenfolge:

1. MCP Inspector gegen eine Testinstanz.
2. ChatGPT Developer Mode gegen eine öffentlich erreichbare HTTPS-Staging-Instanz.

Prüfung:

- Client findet beide Metadata-Ebenen.
- dynamische Registrierung übernimmt die vom Client gelieferte Redirect URI.
- lokaler Login und Consent werden angezeigt.
- Rückkehr zum Client funktioniert.
- Token-Refresh und erneute Verbindung funktionieren.
- Widerruf beendet die bestehende Verbindung.
- keine Canvas Control Plane wird aufgerufen.

Der ChatGPT-Test ist manuell zu protokollieren, da der Client außerhalb dieses Repositorys liegt.

### MCP-OAUTH-09 – Security-, Build- und Release-Gate

Ergebnis:

- DCR-Rate-Limits und Audit Events.
- dokumentierte Token- und Client-Aufräumstrategie.
- Security-Negativtests.
- Lizenz-/Aktivierungsentscheidung umgesetzt.
- Build und relevante bestehende Tests grün.

Prüfung:

- `npm run lint`.
- gezielte OAuth-Integrations- und Migrationstests.
- `npm run build`.
- kein Container-Build, solange der Nutzer ihn nicht ausdrücklich verlangt.
- kein Start eines zweiten Development-Servers; lokaler UI-Test ausschließlich auf Port 3000.

Entscheidung vor Abschluss:

- Reicht die aktuelle lokale ACL als Workspace-Grenze?
- Falls nicht, muss die Workspace-Allowlist vor `MCP-CORE-01` ergänzt und getestet werden.

### MCP-CORE-01 – fachlichen MCP Core beginnen

Dieses Todo darf erst starten, wenn `MCP-OAUTH-01` bis `MCP-OAUTH-09` abgeschlossen sind.

Erster Umfang:

- `list_workspaces`
- `get_workspace_overview`
- `list_knowledge_tree`
- `search_knowledge`
- `read_knowledge_source`

Alle Tools bleiben read-only und verwenden den zuvor getesteten gemeinsamen Token-Verifier sowie die aktuelle lokale ACL.

## 6. Testmatrix

| Ebene | Positivtest | Negativtest |
|---|---|---|
| Discovery | korrekter Issuer und Resource | falscher Host/Origin wird nicht gespiegelt |
| DCR | öffentlicher Client mit exakter Redirect URI | unbekannter Grant Type, Scope oder ungültige URI |
| Authorization | Code Flow mit `S256` | fehlendes PKCE, `plain`, CSRF/State-Mismatch |
| Token | exakte Resource/Audience | falsche Resource, Code-Replay, Redirect-Mismatch |
| Refresh | Rotation und gültiger neuer Access Token | altes/revoziertes Refresh Token |
| Resource | korrekter Scope und aktiver lokaler User | falscher Issuer/Audience/Scope oder inaktiver User |
| ACL | berechtigter Workspace | lokal entzogene Berechtigung trotz gültigem Token |
| MCP | Challenge, Login, Consent, Tool-Antwort | kein Token, fremdes Token, fehlender Scope |
| Logging | redigierte Audit Events | keine Secrets, Codes, Tokens oder Dokumentinhalte |
| Datenbank | Fresh Install und Upgrade | wiederholte Migration erzeugt keinen Drift |

## 7. Definition of Done für OAuth vor dem MCP Core

OAuth gilt erst als fertig, wenn alle folgenden Punkte erfüllt sind:

- Better Auth Provider, JWT/JWKS und DCR laufen auf einer Instanzdomain.
- beide Discovery-Ebenen liefern stabile, standardkonforme Metadaten.
- Authorization Code mit PKCE `S256` funktioniert.
- Tokens sind an den exakten Issuer und `https://{instance-domain}/mcp` gebunden.
- Consent, Refresh und Revocation funktionieren.
- SQLite- und PostgreSQL-Migrationen sind fresh, upgradefähig und idempotent.
- Login-Continuation funktioniert ohne Regression des normalen Logins.
- alle definierten Negativtests bestehen.
- der MCP-`auth_probe` funktioniert im Inspector und in ChatGPT Developer Mode.
- lokale Sperre oder ACL-Entzug beendet den Zugriff.
- Security-, Lint- und Build-Gates sind grün.

Erst danach beginnt die Implementierung der Knowledge-Base-Tools.

## 8. Quellen

- [OpenAI: Authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI: Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider)
