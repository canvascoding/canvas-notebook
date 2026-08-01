# Canvas Notebook MCP Server Architecture Plan

> Stand: 2026-08-01
> Status: Entwurf – noch nicht zur Umsetzung freigegeben

## 1. Ziel

Canvas Notebook soll seine Knowledge Base und ausgewählte Workspace-Funktionen über MCP für externe Clients bereitstellen können.

Der erste Zielclient ist eine manuell in ChatGPT Developer Mode oder einem anderen MCP-Client konfigurierte direkte Verbindung zur jeweiligen Notebook-Instanz. Eine zukünftige offizielle und von OpenAI geprüfte Canvas-Notebook-App folgt erst mit dem Managed Gateway in V2.

Die Architektur muss folgende Betriebsarten unterstützen:

1. V1: eine direkte Verbindung zu einer selbst gehosteten oder verwalteten Notebook-Instanz ohne Canvas Control Plane im Datenpfad.
2. V2: eine selbst gehostete Notebook-Instanz mit optionalem Canvas Cloud Link.
3. V2: eine durch Canvas verwaltete Notebook-Instanz hinter dem zentralen Managed Gateway.

V1 benötigt keine zentrale Canvas-App-Registrierung. Jede Instanz wird mit ihrer eigenen stabilen HTTPS-URL als eigener MCP-Server im Client eingetragen.

## 2. Abgrenzung zur vorhandenen MCP-Client-Integration

Die vorhandene Planung unter [`docs/dokumentation/architecture/mcp-integration`](../../../dokumentation/architecture/mcp-integration/) beschreibt Canvas Notebook als MCP-Client:

- Canvas Notebook verbindet sich mit externen MCP-Servern.
- Canvas Notebook verwaltet dafür Serverkonfigurationen und OAuth-Tokens.
- Der lokale Agent ruft externe MCP-Tools auf.

Dieser Plan beschreibt die entgegengesetzte Richtung:

- Canvas Notebook stellt selbst MCP-Tools bereit.
- Externe Clients wie ChatGPT greifen auf Workspace- und Knowledge-Base-Daten zu.
- Canvas Notebook bleibt die lokale Autorität für Benutzer, Workspaces und Berechtigungen.

Beide Funktionen dürfen gemeinsame MCP-Grundlagen verwenden, müssen aber getrennte Konfigurationen, Tokens, Berechtigungen und Sicherheitsgrenzen besitzen.

## 3. Architekturentscheidung

Die Umsetzung wird verbindlich in zwei voneinander getrennte Stufen aufgeteilt.

### 3.1 V1: direkter MCP-Server pro Notebook-Instanz

Jede Notebook-Instanz ist selbst OAuth Authorization Server und MCP Resource Server:

```text
MCP Resource:
https://{instance-domain}/mcp

Better Auth Issuer:
https://{instance-domain}/api/auth
```

ChatGPT wird im Developer Mode manuell mit der jeweiligen Instanz-URL verbunden. Der Benutzer meldet sich im OAuth-Flow direkt mit seinem lokalen Canvas-Notebook-Konto an. Better Auth stellt Authorization Code Flow, PKCE, Dynamic Client Registration, Access Tokens, Refresh Tokens und Revocation bereit. Die Notebook-Instanz prüft danach weiterhin ihre lokale Benutzer- und Workspace-ACL.

```text
ChatGPT / MCP Client
          │
          │ OAuth mit lokalem Canvas-Benutzer
          │ MCP Request mit instanzgebundenem Access Token
          ▼
┌────────────────────────────────────────────┐
│ Canvas Notebook Instanz                   │
│                                           │
│ Better Auth OAuth Provider: /api/auth     │
│ MCP Resource Server: /mcp                 │
│ lokale Benutzer- und Workspace-ACLs       │
│ Knowledge Base und Workspace-Dateien      │
└────────────────────────────────────────────┘
```

V1 benötigt keine zentrale Benutzerzuordnung, keine Control-Plane-Auflösung, keinen Relay, kein Pairing und keine zentrale Canvas-App-Registrierung.

### 3.2 V2: zentraler Managed Gateway

Für eine später zentral veröffentlichte Canvas-Notebook-App bleibt folgender Produktionsendpunkt reserviert:

```text
https://mcp.canvasnotebook.app/mcp
```

> Architekturentscheidung (2026-08-01): Die Basisdomain lautet verbindlich `canvasnotebook.app` ohne Bindestrich. Die Wiederholung von `mcp` ist beabsichtigt: Die Subdomain bezeichnet den Dienst, der Pfad den MCP-Endpunkt.

V2 ergänzt den zentralen OAuth-Provider, den Canvas Cloud Link, Instanz- und User-Pairing sowie das Gateway. Der lokale MCP Core bleibt dabei dieselbe Autorisierungs- und Ausführungsschicht wie in V1.

Die Detailplanung orientiert sich an:

- [OpenAI: Authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI: Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider)

## 4. Produktbausteine

Die Architektur trennt drei unabhängige Produktbausteine.

### 4.1 Canvas MCP Core

Der MCP Core läuft innerhalb von Canvas Notebook und enthält:

- MCP-Tooldefinitionen.
- Eingabevalidierung.
- Auflösung des lokalen Benutzerkontexts.
- Workspace- und Knowledge-Base-Zugriff.
- lokale Berechtigungsprüfung.
- Audit Events.
- Aufbereitung und Begrenzung der Ergebnisse.

Der MCP Core muss unabhängig davon funktionieren, ob Requests direkt oder über das zentrale Gateway eintreffen.

### 4.2 Canvas Cloud Link

Der Canvas Cloud Link ist eine optionale Verbindung zwischen Notebook und Canvas Cloud.

Er stellt bereit:

- Registrierung und Identität der Notebook-Instanz.
- einen ausschließlich ausgehend aufgebauten Tunnel.
- Routing von MCP-Requests.
- Status und Verfügbarkeit der Instanz.
- kurzlebige signierte Request-Umschläge.
- Widerruf und Rotation der Instanz-Credentials.

Der Cloud Link darf nicht automatisch folgende Managed-Rechte erhalten:

- Docker- oder Host-Steuerung.
- Updates und Restarts.
- Zugriff auf Logs.
- Zugriff auf lokale Secrets.
- Monitoring außerhalb der für MCP notwendigen Verbindungsdaten.
- Nutzung verwalteter Modell- oder Medienprovider.

### 4.3 Canvas Managed

Der Managed Mode umfasst weiterhin Provisionierung, Betrieb, Monitoring und andere Managed Services.

Managed Instanzen können den Cloud Link automatisch erhalten. Der Cloud Link bleibt trotzdem ein separat berechtigter Dienst, damit er auch von lizenzierten Self-hosted-Instanzen genutzt werden kann.

## 5. Betriebsmodelle

| Version und Modus | MCP-Endpunkt | OAuth | Control Plane | ChatGPT-Einbindung |
|---|---|---|---|---|
| V1 Direct | `https://{instance-domain}/mcp` | lokales Better Auth | nicht erforderlich | manuelle Developer-Mode-Konfiguration |
| V2 Self-hosted mit Cloud Link | `https://mcp.canvasnotebook.app/mcp` | zentraler Canvas OAuth-Provider | nur Cloud-Link-Dienste | zentrale Canvas-App |
| V2 Canvas Managed | `https://mcp.canvasnotebook.app/mcp` | zentraler Canvas OAuth-Provider | vollständiger Managed Mode | zentrale Canvas-App |
| Enterprise On-Prem | eigener oder zentraler Gateway | eigener oder zentraler Provider | optional | abhängig vom gewählten Modell |

Eine V1-Instanz benötigt eine stabile, öffentlich erreichbare HTTPS-Domain. OpenAIs Secure MCP Tunnel kann ausschließlich für Entwicklung mit privaten Instanzen verwendet werden. Er ersetzt weder die öffentliche V1-Instanz-URL noch später den mandantenfähigen V2-Gateway:

- [OpenAI: Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## 6. Identitäten und Autorisierung

Folgende Identitäten und Berechtigungen müssen getrennt behandelt werden:

| Ebene | V1 Direct | V2 Managed |
|---|---|---|
| Lizenz-Entitlement | Darf diese Instanz direkten MCP-Zugriff anbieten? | Darf sie zusätzlich den Cloud Relay verwenden? |
| Instanzidentität | HTTPS-Origin und lokaler OAuth-Issuer | registrierte Instanzidentität plus Relay-Credential |
| Benutzeridentität | lokaler Better-Auth-`user.id` | zentraler Benutzer plus expliziter User Link |
| OAuth Grant | lokaler Client, lokale Scopes und lokaler Consent | zentraler Client, Instanz, User Link, Scopes und Grant |
| lokale Autorisierung | aktuelle lokale Benutzer- und Workspace-ACL | bleibt auch nach Gateway-Prüfung die letzte Autorität |

Eine Lizenz identifiziert keinen Benutzer und darf nicht als Benutzer-Credential oder Request-Token verwendet werden.

V1 verwendet keine Instanz-Credentials gegenüber der Control Plane. Für V2 soll der bestehende `CANVAS_INSTANCE_TOKEN` nicht ohne gesonderte Sicherheitsprüfung für den MCP Relay wiederverwendet werden. Bevorzugt wird eine eigene Instanzidentität mit eigenem Schlüsselpaar und eng begrenzten Relay-Rechten.

## 7. V2: Registrierung einer Notebook-Instanz

Dieser Abschnitt gilt ausschließlich für den späteren Managed Gateway. V1 benötigt keine zentrale Instanzregistrierung.

### 7.1 Self-hosted

Eine lizenzierte Self-hosted-Instanz soll in den lokalen Einstellungen einen Bereich für externen Zugriff erhalten.

Der geplante Ablauf:

1. Ein lokaler Administrator aktiviert den Canvas Cloud Link.
2. Canvas Notebook prüft das erforderliche Lizenz-Entitlement.
3. Die Instanz erzeugt lokal ein asymmetrisches Schlüsselpaar.
4. Der private Schlüssel verbleibt geschützt auf der Instanz.
5. Die Instanz registriert ihre öffentliche Identität über einen kurzlebigen Aktivierungsablauf.
6. Der Control Plane ordnet die Instanz der Lizenz beziehungsweise dem zentralen Account oder der Organisation zu.
7. Canvas Notebook baut einen ausgehenden Tunnel zum MCP Relay auf.
8. Die Instanz kann zentral als online, offline, gesperrt oder widerrufen erkannt werden.

Die Registrierung für den Cloud Link darf die Self-hosted-Instanz nicht in den Managed Mode versetzen.

### 7.2 Managed

Bei einer Managed-Instanz kann die Instanzidentität während der Provisionierung erzeugt werden.

Trotz automatischer Registrierung bleibt die Verknüpfung eines lokalen Benutzers mit einem zentralen Account eine eigene, explizite Berechtigung.

## 8. V2: Verknüpfung eines lokalen Benutzers

Dieser Abschnitt gilt ausschließlich für den späteren Managed Gateway. In V1 ist der OAuth-Subject direkt der lokale Better-Auth-Benutzer.

Lokale Canvas-Zugangsdaten dürfen niemals an den zentralen OAuth-Provider übertragen werden.

Insbesondere sind folgende Ansätze ausgeschlossen:

- Eingabe des lokalen Canvas-Passworts auf einer Control-Plane-Webseite.
- zentrale Prüfung lokaler Passwörter.
- automatisches User-Matching ausschließlich anhand gleicher E-Mail-Adressen.
- Übertragung lokaler Session-Cookies an das zentrale Gateway.

Stattdessen wird ein expliziter Pairing-Flow verwendet.

### 8.1 Empfohlener Pairing-Flow

1. Der Benutzer meldet sich lokal in Canvas Notebook an.
2. Er öffnet `Settings > ChatGPT & MCP`.
3. Er wählt „Mit Canvas Cloud verbinden“.
4. Canvas Notebook erstellt über den authentifizierten Instanzkanal einen kurzlebigen Pairing-Code.
5. Die UI öffnet eine zentrale URL, beispielsweise:

   ```text
   https://account.canvasnotebook.app/link?code=ABC-123
   ```

6. Der Benutzer meldet sich beim zentralen Canvas-Account an.
7. Der zentrale Dienst bestätigt Instanz und Pairing-Code.
8. Der lokale Benutzer wählt die freizugebenden Workspaces und Scopes.
9. Canvas Notebook speichert lokal die Zuordnung zwischen einer undurchsichtigen `linkId` und dem lokalen `userId`.
10. Der Control Plane speichert die Verbindung zwischen zentralem Benutzer, Instanz und `linkId`.
11. Die Verbindung kann sowohl lokal als auch zentral widerrufen werden.

Für die erste V2-Version soll das Pairing vor dem OAuth-Flow in ChatGPT abgeschlossen sein. Ein Pairing innerhalb eines bereits laufenden OAuth-Dialogs bleibt eine spätere Erweiterung.

## 9. OAuth-Modell

### 9.1 V1 Direct

Die lokale Better-Auth-Installation wird um den offiziellen OAuth-Provider und JWT/JWKS erweitert. Der bestehende E-Mail-/Passwort-Login bleibt die Benutzeranmeldung.

Der V1-Vertrag lautet:

```text
MCP Resource:
https://{instance-domain}/mcp

Protected Resource Metadata:
https://{instance-domain}/.well-known/oauth-protected-resource/mcp

Protected Resource Metadata Alias:
https://{instance-domain}/.well-known/oauth-protected-resource

Authorization Server Issuer:
https://{instance-domain}/api/auth
```

Erforderlich sind:

- Authorization Code Flow mit PKCE `S256`.
- Dynamic Client Registration für öffentliche ChatGPT-Clients.
- exakte Redirect-URI-Prüfung.
- Protected-Resource- und Authorization-Server-Metadaten.
- Resource Indicator `https://{instance-domain}/mcp`.
- Audience-Bindung und Prüfung auf genau diese Resource.
- kurzlebige Access Tokens, rotierbare Refresh Tokens und Revocation.
- lokale Consent-Seite mit klaren Scopes.
- keine Übertragung lokaler Passwörter oder Sessions an Canvas Cloud.

Der Token-Subject ist die lokale Better-Auth-`user.id`. `email` und `profile` werden für V1 nicht als MCP-Scopes benötigt.

### 9.2 V2 Managed

Der zentrale OAuth-Provider übernimmt später die Anmeldung des zentralen Canvas-Accounts, die Auswahl einer verknüpften Instanz, den zentralen Grant sowie Ausgabe, Refresh und Revocation der Gateway-Tokens.

Der Token-Subject repräsentiert dann den zentralen Benutzer. Instanz und User Link werden serverseitig aus dem Grant aufgelöst. Ein vom Modell oder Client übergebener `instanceId`, `userId` oder `workspaceId` darf niemals allein die Zielidentität bestimmen.

## 10. Request-Ablauf

### 10.1 V1 Direct

1. Der MCP-Client liest die Protected-Resource-Metadaten der Instanz.
2. Er registriert sich dynamisch beim lokalen Better-Auth-OAuth-Provider.
3. Der lokale Benutzer meldet sich auf seiner eigenen Canvas-Notebook-Instanz an und bestätigt die Scopes.
4. Der Client tauscht den einmaligen Authorization Code mit PKCE-Verifier gegen instanzgebundene Tokens.
5. Der Client sendet den MCP-Request mit Bearer Token direkt an `/mcp`.
6. Canvas Notebook validiert Signatur, Issuer, Audience, Ablauf, Revocation und erforderlichen Scope.
7. Canvas Notebook löst `sub` ausschließlich zum lokalen Benutzer auf und prüft dessen aktuelle ACL.
8. Der lokale MCP Core führt das read-only Tool aus und antwortet direkt an den Client.

Ein deaktivierter Benutzer oder eine entzogene Workspace-Berechtigung wirkt sofort, auch wenn das Access Token noch nicht abgelaufen ist.

### 10.2 V2 Managed

V2 ersetzt die direkte Transportstrecke durch den zentralen Gateway und einen ausgehenden Instanztunnel. Der Gateway validiert den zentralen Grant, bindet den Request an Instanz und User Link und sendet einen kurzlebigen signierten Request-Umschlag. Die lokale Instanz validiert diesen Umschlag und führt dieselben lokalen ACL-Prüfungen wie in V1 aus.

## 11. Lizenzmodell

Das vorhandene flexible Feature- und Quota-Modell soll verwendet werden. Die bestehende Lizenzarchitektur ist unter [`../../../license-registration-plan.md`](../../../license-registration-plan.md) beschrieben.

Empfohlene getrennte Features:

```text
mcpLocalServer
mcpCloudRelay
```

Mögliche Quotas:

```text
mcpLinkedUsers
mcpLinkedInstances
mcpRequestsPerMonth
mcpRelayEgressMb
mcpConcurrentRequests
```

Eine mögliche Produktaufteilung:

- Direkter lokaler MCP Server als Community-, Pro- oder Development-Funktion.
- Offizielle ChatGPT-App über den Canvas Cloud Link als kostenpflichtige Cloud-Funktion.
- Cloud Link im Managed-Tarif enthalten.
- Self-hosted Pro kann den Cloud Link separat lizenzieren.

Die endgültige Preis- und Tarifentscheidung ist nicht Teil dieses Architekturplans.

## 12. Geplante MCP-Funktionen

Die erste Version soll read-only bleiben und sich auf die Knowledge Base konzentrieren.

### 12.1 MVP-Tools

#### `list_workspaces`

Gibt ausschließlich Workspaces zurück, die für den authentifizierten lokalen Benutzer sichtbar sind und deren Nutzung durch die Token-Scopes erlaubt ist.

#### `get_workspace_overview`

Gibt eine kompakte Übersicht über einen Workspace zurück:

- Name und Beschreibung.
- verfügbare Wissensquellen.
- freigegebene Hauptordner.
- unterstützte Dateitypen.
- optionale statistische Metadaten.

#### `list_knowledge_tree`

Gibt den freigegebenen File Tree beziehungsweise Knowledge Tree zurück.

Erforderliche Optionen:

- Workspace.
- Startpfad.
- maximale Tiefe.
- maximale Anzahl Einträge.
- optionaler Dateitypfilter.

#### `search_knowledge`

Durchsucht die Knowledge Base des freigegebenen Workspace.

Ergebnisobjekte sollen mindestens enthalten:

- Titel oder Dateiname.
- Quellpfad beziehungsweise stabile Source-ID.
- relevanter Ausschnitt.
- Relevanz.
- Änderungsdatum, sofern zulässig.

#### `read_knowledge_source`

Liest eine konkrete freigegebene Quelle oder begrenzte Ausschnitte daraus.

Es müssen Größen-, Seiten- und Tokenlimits gelten. Binärdateien werden nicht ungeprüft vollständig übertragen.

### 12.2 Spätere Tools

- strukturierte Workspace-Zusammenfassungen.
- Quellen- und Metadatenverwaltung.
- Notizen oder Dateien erstellen.
- bestehende Inhalte aktualisieren.
- Exporte erzeugen.
- Bildgenerierung.
- Soundgenerierung.
- Videogenerierung.
- Statusabfrage für asynchrone Medienjobs.

Schreibende Tools und Mediengenerierung benötigen ein separates Berechtigungs-, Kosten-, Bestätigungs- und Jobmodell und sind nicht Teil des ersten Releases.

## 13. Scopes

Vorgeschlagene OAuth- beziehungsweise Grant-Scopes:

```text
workspace:list
knowledge:tree
knowledge:search
knowledge:read
```

Spätere Scopes:

```text
files:write
knowledge:write
media:image:generate
media:audio:generate
media:video:generate
jobs:read
```

In V1 ergibt sich die effektive Berechtigung aus:

```text
lokaler OAuth-Consent
∩ Token-Scopes
∩ aktuelle lokale Benutzer- und Workspace-ACL
```

Eine zusätzliche Workspace-Allowlist ist für den ersten OAuth-Proof nicht erforderlich. Sie kann vor Veröffentlichung der realen Knowledge-Tools als V1.1-Härtung ergänzt werden, falls ein Client nur einzelne Workspaces sehen soll. In V2 ist die explizite Workspace-Allowlist Teil des zentral und lokal widerrufbaren Grants.

## 14. Datenmodell

### 14.1 V1 Direct in Canvas Notebook

Better Auth OAuth Provider und JWT benötigen nach dem aktuellen v1.6-Schema mindestens:

```text
oauthClient
oauthAccessToken
oauthRefreshToken
oauthConsent
jwks
```

Das authoritative Schema wird mit der zur App passenden Better-Auth-Version generiert, geprüft und danach in die vorhandenen eigenen Drizzle-Migrationen für SQLite und PostgreSQL übernommen. Die produktive Datenbank darf nicht blind über Better Auth CLI migriert werden.

V1 benötigt keine Control-Plane-Tabelle, keinen `external_identity_link` und keinen zentralen MCP-Grant. Bestehende Benutzer-, Session- und Workspace-Daten bleiben die lokale Autorität.

### 14.2 V2 Control Plane

#### `mcp_instances`

- zentrale Instanz-ID.
- Lizenz-, Account- oder Organisationszuordnung.
- öffentlicher Instanzschlüssel.
- Betriebsmodus `self_hosted_link` oder `managed`.
- Status.
- Zeitpunkt der letzten Verbindung.
- Credential-Revision.

#### `mcp_user_links`

- Link-ID.
- Instanz-ID.
- zentraler Benutzer.
- Status.
- Verknüpfungs- und Widerrufszeitpunkt.

Der Control Plane muss die lokale Benutzer-ID nicht als frei verwendbaren Identifier kennen. Eine undurchsichtige Link-ID ist vorzuziehen.

#### `mcp_oauth_grants`

- Grant-ID.
- User-Link-ID.
- OAuth-Client.
- Scopes.
- Status.
- Ablauf und Widerruf.

#### `mcp_tunnel_sessions`

- kurzlebige Verbindungsmetadaten.
- Instanz-ID.
- Verbindungsstatus.
- Protokollversion.
- Start- und Endzeit.

### 14.3 V2 Canvas Notebook

#### `external_identity_links`

- Link-ID.
- Provider `canvas_cloud`.
- lokaler Benutzer.
- Status.
- Verknüpfungs- und Widerrufszeitpunkt.

#### `external_mcp_grants`

- Grant-ID.
- Link-ID.
- Scopes.
- lokale Workspace-Allowlist.
- Revision.
- Status.
- Widerrufszeitpunkt.

#### Pairing Challenges

- Challenge-ID.
- kurzlebiger Code-Hash.
- lokaler Actor.
- Ablaufzeit.
- Status.

## 15. Datenschutz und Trust Boundaries

In V1 liegt die Canvas Control Plane nicht im OAuth- oder MCP-Datenpfad. Der Client verbindet sich direkt mit der Notebook-Instanz. Angeforderte Inhalte verlassen die Instanz nur in Richtung des ausdrücklich verbundenen MCP-Clients.

In V2 liegt der zentrale MCP Gateway zusätzlich im Datenpfad. Daraus folgt:

- Knowledge-Base-Daten bleiben dauerhaft auf der Notebook-Instanz gespeichert.
- Angeforderte Inhalte verlassen die Instanz und werden an ChatGPT übertragen.
- Der zentrale Gateway verarbeitet Inhalte während der Weiterleitung technisch im Klartext, sofern keine zusätzliche Ende-zu-Ende-Verschlüsselung verfügbar ist.
- Der Gateway soll keine Tool-Eingaben, Prompts, Dokumentinhalte oder Ergebnisse dauerhaft speichern.
- Logs sollen Inhalte standardmäßig redigieren oder vollständig auslassen.
- Erlaubte Metriken sollen sich auf Status, Laufzeit, Tooltyp, Datenmenge und Fehlerklassen beschränken.
- Caches für Knowledge-Inhalte sind standardmäßig deaktiviert.
- Support-Zugriff darf keine Inhalte sichtbar machen.

Die Produktkommunikation darf deshalb in keiner Version behaupten, dass per MCP angeforderte Daten die VM niemals verlassen. Korrekt ist: Die Knowledge Base bleibt auf der eigenen Instanz gespeichert und Inhalte werden nur für explizit autorisierte Requests an den verbundenen Client übertragen; in V2 werden sie zusätzlich durch den Canvas Gateway geleitet.

## 16. Sicherheitsanforderungen

- Authorization Code Flow nur mit PKCE `S256`.
- exakte Redirect-URI-Prüfung bei Registrierung und Authorization Request.
- Dynamic-Client-Registration-Endpunkt mit Rate Limit, Audit Event und strikter Scope-Allowlist.
- keine Consent-Umgehung für dynamisch registrierte Clients.
- kurzlebige OAuth Access Tokens.
- strikte Prüfung von Issuer, Audience, Resource, Ablauf und Scopes pro Request.
- Authorization Codes nur einmal verwendbar und kurzlebig.
- Refresh-Token-Rotation und sofortige Revocation.
- keine Wiederverwendung lokaler Session-Cookies als MCP-Credential.
- Rate Limits auf Benutzer-, Grant-, Instanz- und Tool-Ebene.
- Größen- und Laufzeitlimits.
- lokales Re-Authorization-Gate für jeden Request.
- keine Secrets in MCP-Ergebnissen.
- keine ungefilterte Rückgabe versteckter System- oder Agent-Dateien.
- explizite Deny-Regeln für `/data/secrets`, System-Prompts und Runtime-Credentials.
- Security Audit vor Aktivierung schreibender Tools.

Zusätzlich für V2:

- keine lokalen Passwörter im Control Plane.
- keine stille Identitätsverknüpfung über E-Mail.
- eigene, eng begrenzte und rotierbare Instanz-Credentials für den MCP Relay.
- bevorzugt asymmetrische Instanzidentität statt langfristigem Shared Secret.
- signierte, kurzlebige Request-Umschläge mit Replay-Schutz.

## 17. Fehler- und Sperrzustände

Der lokale V1-Server und der spätere V2-Gateway sollen stabile, maschinenlesbare Fehlerklassen verwenden.

Beispiele:

```text
OAUTH_DISCOVERY_INVALID
OAUTH_CLIENT_REGISTRATION_DENIED
OAUTH_REDIRECT_URI_INVALID
OAUTH_PKCE_REQUIRED
TOKEN_INVALID
TOKEN_AUDIENCE_INVALID
TOKEN_REVOKED
INSTANCE_OFFLINE
INSTANCE_REVOKED
USER_LINK_REQUIRED
USER_LINK_REVOKED
GRANT_REVOKED
GRANT_SCOPE_MISSING
LICENSE_REQUIRED
LICENSE_EXPIRED
WORKSPACE_NOT_ALLOWED
LOCAL_PERMISSION_DENIED
RESOURCE_NOT_FOUND
RESULT_TOO_LARGE
RATE_LIMITED
REQUEST_EXPIRED
REPLAY_DETECTED
```

Verhaltensregeln:

- Ein nicht authentifizierter MCP-Request antwortet mit `401` und einem `WWW-Authenticate`-Verweis auf die Protected-Resource-Metadaten.
- Fehlende Scopes antworten ohne Datenleck mit `403` beziehungsweise einem neuen OAuth-Challenge für den erforderlichen Scope.
- Ein deaktivierter lokaler Benutzer verliert den Zugriff sofort.
- Eine entfernte Workspace-Berechtigung wirkt trotz gültigem OAuth-Token sofort.
- Bei abgelaufener Lizenz werden keine neuen Grants oder Requests zugelassen.
- In V2 wird eine offline Instanz nicht durch eine andere Instanz ersetzt und zentrale sowie lokale Revocation werden unabhängig geprüft.

## 18. Umsetzungsphasen

Die Phasen werden strikt nacheinander umgesetzt. Keine Phase beginnt, bevor ihre Abnahmekriterien erfüllt sind.

### Phase 0: V1-Vertrag und Threat Model

- Direct-V1-Endpunkte, Issuer, Resource und Scopes festschreiben.
- DCR als temporäre ChatGPT-Kompatibilitätsentscheidung dokumentieren.
- lokale Trust Boundaries und Datenschutzversprechen freigeben.
- Lizenz- und Aktivierungsverhalten entscheiden.

### Phase 1: Better Auth OAuth Provider

- kompatible Better-Auth- und OAuth-Provider-Versionen festlegen.
- OAuth- und JWKS-Schema generieren und in SQLite/PostgreSQL-Migrationen integrieren.
- Authorization Code, PKCE, DCR, Consent, Token, Refresh und Revocation konfigurieren.
- bestehendes Login so anpassen, dass der signierte OAuth-Request erhalten bleibt.
- Discovery- und Protected-Resource-Metadaten bereitstellen.

### Phase 2: OAuth isoliert testen

- automatisierten PKCE-Client gegen die lokale OAuth-Implementierung ausführen.
- Discovery, DCR, Code-Austausch, Audience, Refresh und Revocation positiv und negativ testen.
- Migrationen auf frischen und aktualisierten SQLite- und PostgreSQL-Datenbanken testen.
- Login- und Consent-Flow in beiden unterstützten Locales prüfen.

### Phase 3: minimaler MCP-Auth-Probe

- einen nicht fachlichen `auth_probe` über `/mcp` bereitstellen.
- Tool-`securitySchemes`, `WWW-Authenticate` und `_meta["mcp/www_authenticate"]` korrekt ausgeben.
- OAuth mit MCP Inspector und danach mit ChatGPT Developer Mode auf einer öffentlichen Staging-Instanz vollständig testen.

Dieser Probe ist der kleinste nötige Protokoll-Harness und noch keine Implementierung der eigentlichen MCP-Tools. Ohne ihn kann der reale ChatGPT-OAuth-Einstieg nicht vollständig validiert werden.

### Phase 4: lokaler MCP Core und read-only Tools

- Toollogik von Transport und Authentifizierung trennen.
- `list_workspaces`, `get_workspace_overview`, `list_knowledge_tree`, `search_knowledge` und `read_knowledge_source` implementieren.
- lokalen Benutzer- und Workspace-Kontext bei jedem Request neu prüfen.
- Ergebnis-, Datei-, Laufzeit- und Tokenlimits durchsetzen.

### Phase 5: V1 Hardening und Freigabe

- Rate Limits, Audit Events, Revocation und Abuse-Schutz abschließen.
- Security-, Integrations-, Build- und UI-Tests durchführen.
- direkte Einrichtung für ChatGPT Developer Mode dokumentieren.
- ausschließlich read-only V1 freigeben.

### Phase 6: V2 Managed Gateway

- zentralen OAuth-Provider und `https://mcp.canvasnotebook.app/mcp` bereitstellen.
- Canvas Cloud Link, Instanzregistrierung und Tunnel umsetzen.
- User-Pairing und Workspace-Grants ergänzen.
- Request-Routing, signierte Umschläge, Revocation und Ausfallverhalten härten.
- zentrale Canvas-App zur Prüfung einreichen.

### Phase 7: Erweiterungen

- mehrere Instanzen und Grants.
- schreibende Tools und Bestätigungsdialoge.
- Mediengenerierung und asynchrone Jobs.
- Enterprise-Gateway und On-Prem-Varianten.

## 19. Entscheidungen für die erste Version

Für den V1-Release gelten folgende Entscheidungen:

1. Nur read-only Knowledge-Base-Zugriff.
2. Ein MCP-Server entspricht genau einer Notebook-Instanz und ist unter `https://{instance-domain}/mcp` erreichbar.
3. OAuth läuft vollständig auf dieser Instanz über den bestehenden lokalen Better-Auth-Benutzer.
4. Keine Control Plane, kein Relay, kein Pairing und keine zentrale Canvas-App in V1.
5. ChatGPT wird manuell im Developer Mode verbunden.
6. Der OAuth-Grant gilt nur für die exakte Resource und die erteilten Scopes.
7. Die aktuelle lokale ACL bleibt bei jedem Request die letzte Autorität.
8. Keine zusätzliche Workspace-Allowlist im OAuth-Proof; vor den realen Tools wird diese Entscheidung erneut sicherheitlich geprüft.
9. Keine Mediengenerierung und keine schreibenden Tools.
10. Der Managed Gateway bleibt als V2-Erweiterung vorgesehen.

## 20. Offene Produkt- und Architekturentscheidungen

Vor Beginn beziehungsweise während der bezeichneten Phase sind noch folgende Fragen zu entscheiden:

- Gehört `mcpLocalServer` zur Community-, Pro- oder Enterprise-Lizenz?
- Wird der direkte OAuth-Endpunkt nur per Lizenz und nicht zusätzlich per Deployment-Schalter aktiviert?
- Wird vor Phase 4 eine explizite Workspace-Allowlist bereits für V1 eingeführt?
- Welche maximale Dokument- und Ergebnisgröße gilt?
- Welche DCR-Rate-Limits und Aufbewahrungsfristen gelten für ungenutzte dynamische Clients?
- Wann kann Dynamic Client Registration durch Client ID Metadata Documents ersetzt werden?
- Für V2: Tarif, Relay-Topologie, mehrere Instanzen, Organisationen, Quotas und Audit-Abrechnung.
- Welche Anforderungen stellt OpenAI zum Zeitpunkt der späteren zentralen App-Einreichung?

## 21. Abnahmekriterien der Architektur

V1 darf erst mit den fachlichen MCP-Tools beginnen, wenn:

- Direct-V1-Resource, Issuer und Metadaten stabil sind.
- Better Auth OAuth Provider und Datenbankmigrationen für SQLite und PostgreSQL funktionieren.
- DCR, Authorization Code mit PKCE `S256`, Consent, Audience, Refresh und Revocation positiv und negativ getestet sind.
- falsche Issuer, Resources, Redirect URIs, Scopes, Codes und Tokens zuverlässig abgewiesen werden.
- der lokale Login- und Consent-Flow keine OAuth-Parameter verliert.
- der minimale MCP-Auth-Probe mit MCP Inspector und ChatGPT Developer Mode auf einer öffentlichen Staging-Instanz funktioniert.
- ein deaktivierter Benutzer und eine entzogene lokale ACL trotz vorhandenem Token keinen Zugriff erhalten.
- keine Tokens, Codes, Passwörter oder Inhalte in Logs erscheinen.

Die ausführbare Reihenfolge und die einzelnen Abnahmekriterien stehen im [Direct V1 OAuth Implementation Plan](./direct-v1-oauth-plan.md) und in [`todo.json`](./todo.json).

## 22. Verwandte Dokumente

- [Vorhandene MCP-Client-Integration](../../../dokumentation/architecture/mcp-integration/)
- [Direct V1 OAuth Implementation Plan](./direct-v1-oauth-plan.md)
- [Direct V1 OAuth Todos](./todo.json)
- [Canvas Notebook Architecture](../plan.md)
- [Canvas Control Plane Architecture](../../../dokumentation/architecture/canvas-control-plane/plan.md)
- [Managed Service Planning](../../../dokumentation/manged-service/)
- [License and Registration Plan](../../../license-registration-plan.md)
