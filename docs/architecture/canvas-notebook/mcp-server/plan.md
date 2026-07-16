# Canvas Notebook MCP Server Architecture Plan

> Stand: 2026-07-16
> Status: Entwurf – noch nicht zur Umsetzung freigegeben

## 1. Ziel

Canvas Notebook soll seine Knowledge Base und ausgewählte Workspace-Funktionen über MCP für externe Clients bereitstellen können.

Der wichtigste Zielclient ist eine zukünftige offizielle und von OpenAI geprüfte Canvas-Notebook-App für ChatGPT. Zusätzlich soll eine direkte MCP-Anbindung für Entwicklung, Tests und individuell konfigurierte MCP-Clients möglich bleiben.

Die Architektur muss folgende Betriebsarten unterstützen:

1. Eine durch Canvas verwaltete Notebook-Instanz.
2. Eine selbst gehostete Notebook-Instanz mit optionalem Canvas Cloud Link.
3. Eine vollständig direkte Development-Anbindung ohne Canvas Control Plane.

Der Zugriff auf eine selbst gehostete Instanz über die offizielle ChatGPT-App darf nicht voraussetzen, dass der Betreiber den vollständigen Managed Mode aktiviert.

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

Für die offizielle Canvas-Notebook-App wird ein zentraler öffentlicher MCP-Endpunkt benötigt. Ein zentraler OAuth-Provider allein reicht nicht aus.

Die veröffentlichte App soll einen stabilen öffentlichen MCP-Endpunkt verwenden:

```text
https://mcp.canvasnotebook.app/mcp
```

Der zentrale OAuth-Provider soll ebenfalls über eine offizielle Canvas-Domain erreichbar sein:

```text
https://auth.canvasnotebook.app
```

Der zentrale MCP-Endpunkt ist ein Gateway. Die eigentliche Knowledge-Base-Operation wird weiterhin von der verbundenen Canvas-Notebook-Instanz ausgeführt.

```text
ChatGPT / offizieller Canvas Client
                  │
                  │ OAuth-Token und MCP Request
                  ▼
┌────────────────────────────────────────────┐
│ Canvas Cloud                              │
│                                           │
│ auth.canvasnotebook.app                   │
│ Zentraler OAuth Authorization Server      │
│                                           │
│ mcp.canvasnotebook.app/mcp                │
│ Öffentlicher MCP Resource Server/Gateway  │
└─────────────────────┬──────────────────────┘
                      │
                      │ ausgehender authentifizierter Tunnel
                      ▼
┌────────────────────────────────────────────┐
│ Canvas Notebook Instanz                   │
│                                           │
│ lokaler MCP Executor                      │
│ lokale Benutzer- und Workspace-ACLs       │
│ Knowledge Base und Workspace-Dateien      │
└────────────────────────────────────────────┘
```

Diese Architektur folgt der aktuellen OpenAI-Anforderung, dass eine ChatGPT-App einen öffentlich erreichbaren MCP-Endpunkt verwendet. OAuth muss für benutzerbezogene Daten als getrennte Authorization- und Resource-Server-Architektur umgesetzt werden:

- [OpenAI: Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- [OpenAI: Authentication](https://developers.openai.com/apps-sdk/build/auth)

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

| Modus | MCP-Endpunkt | OAuth | Control Plane | Offizielle ChatGPT-App |
|---|---|---|---|---|
| Direct Development | direkt an der Notebook-Instanz oder über einen individuellen Tunnel | lokal oder individuell | nicht erforderlich | nein, manuelle Developer-Konfiguration |
| Self-hosted mit Cloud Link | zentraler Canvas MCP Gateway | zentraler Canvas OAuth-Provider | nur Cloud-Link-Dienste | ja |
| Canvas Managed | zentraler Canvas MCP Gateway | zentraler Canvas OAuth-Provider | vollständiger Managed Mode | ja |
| Enterprise On-Prem | eigener oder zentraler Gateway | eigener oder zentraler Provider | optional | abhängig vom gewählten Modell |

OpenAIs Secure MCP Tunnel kann für direkte Development-Verbindungen zu privaten Instanzen relevant sein. Er ersetzt in dieser Zielarchitektur nicht den zentralen mandantenfähigen Gateway der offiziellen Canvas-App:

- [OpenAI: Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## 6. Identitäten und Autorisierung

Folgende Identitäten und Berechtigungen müssen getrennt behandelt werden:

| Ebene | Bedeutung |
|---|---|
| Lizenz-Entitlement | Darf diese Instanz lokalen oder zentral vermittelten MCP-Zugriff anbieten? |
| Instanzidentität | Handelt es sich um eine registrierte und authentische Notebook-Instanz? |
| User Link | Welcher zentrale Canvas-Account ist mit welchem lokalen Notebook-Benutzer verbunden? |
| OAuth Grant | Welche Rechte hat ein bestimmter MCP-Client erhalten? |
| lokale Autorisierung | Darf der lokale Benutzer aktuell auf den Workspace und die angefragte Ressource zugreifen? |

Eine Lizenz identifiziert keinen Benutzer und darf nicht als Benutzer-Credential oder Request-Token verwendet werden.

Der bestehende `CANVAS_INSTANCE_TOKEN` für Managed Services soll nicht ohne gesonderte Sicherheitsprüfung für den MCP Relay wiederverwendet werden. Bevorzugt wird eine eigene Instanzidentität mit eigenem Schlüsselpaar und eng begrenzten Relay-Rechten.

## 7. Registrierung einer Notebook-Instanz

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

## 8. Verknüpfung eines lokalen Benutzers

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

Für die erste Version soll das Pairing vor dem OAuth-Flow in ChatGPT abgeschlossen sein. Ein Pairing innerhalb eines bereits laufenden OAuth-Dialogs bleibt eine spätere Erweiterung.

## 9. OAuth-Modell für die offizielle App

Der zentrale OAuth-Provider übernimmt:

- Anmeldung beziehungsweise Registrierung des zentralen Canvas-Accounts.
- Auswahl einer bereits verknüpften Instanz.
- Auswahl oder Bestätigung eines bestehenden lokalen Grants.
- Ausgabe kurzlebiger Access Tokens.
- Refresh und Revocation.
- Bindung des Tokens an den vorgesehenen MCP Resource Server.

Die OAuth-Implementierung soll mindestens berücksichtigen:

- OAuth 2.1 beziehungsweise ein mit OpenAI kompatibles OAuth-2.0-Profil.
- Authorization Code Flow.
- PKCE.
- Authorization-Server-Metadaten.
- Protected-Resource-Metadaten.
- Resource Indicators und Audience-Prüfung.
- klar definierte Scopes.
- Token- und Grant-Revocation.
- Schutz vor Login-CSRF und Authorization-Code-Replay.

Der Token-Subject repräsentiert den zentralen Benutzer. Die konkrete Instanz- und User-Link-Zuordnung wird serverseitig aus dem Grant aufgelöst.

Ein vom Modell oder Client frei übergebener `instanceId`, `userId` oder `workspaceId` darf niemals allein die Zielidentität bestimmen.

## 10. Request-Ablauf

Ein Tool-Aufruf über die offizielle ChatGPT-App soll wie folgt verarbeitet werden:

1. ChatGPT sendet einen MCP-Request an den zentralen Canvas MCP Gateway.
2. Der Gateway validiert Access Token, Client, Audience, Scopes und Grant-Status.
3. Der Gateway ermittelt die fest mit dem Grant verknüpfte Instanz und `linkId`.
4. Der Gateway erstellt einen kurzlebigen signierten Request-Umschlag mit:

   - Request-ID.
   - Grant-ID.
   - Link-ID.
   - erlaubten Scopes.
   - Toolname.
   - Ablaufzeit.
   - Nonce beziehungsweise Replay-Schutz.

5. Der Request wird über den ausgehenden Instanztunnel zugestellt.
6. Canvas Notebook prüft Signatur, Ablaufzeit, Replay-Schutz und Grant-Revision.
7. Canvas Notebook löst die `linkId` zum lokalen Benutzer auf.
8. Canvas Notebook prüft erneut:

   - Ist der lokale Benutzer aktiv?
   - Ist der User Link aktiv?
   - Ist der lokale Grant aktiv?
   - Ist die Lizenz noch gültig?
   - Ist der Workspace für diesen Grant freigegeben?
   - Besitzt der Benutzer aktuell die erforderliche Workspace-Berechtigung?
   - Darf das angefragte Tool mit den erteilten Scopes ausgeführt werden?

9. Der lokale MCP Core führt das Tool aus.
10. Das Ergebnis wird über den Relay an ChatGPT zurückgegeben.

Die lokale Berechtigungsprüfung bleibt immer die abschließende Autorität. Ein gültiges zentrales OAuth-Token darf eine lokal entzogene Berechtigung nicht wiederherstellen.

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

Gibt ausschließlich Workspaces zurück, die für den verbundenen lokalen Benutzer und den OAuth-Grant sichtbar sind.

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

Ein OAuth-Scope allein reicht nicht. Zusätzlich muss lokal eine Workspace-Allowlist gespeichert werden.

Ein Grant besteht daher mindestens aus:

```text
Client
User Link
Instanz
Scopes
lokaler Workspace-Allowlist
Status
Revision
Erstellungs- und Widerrufszeitpunkt
```

## 14. Datenmodell

Die genauen Tabellen werden erst während der Detailplanung festgelegt. Fachlich werden mindestens folgende Datensätze benötigt.

### 14.1 Control Plane

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

### 14.2 Canvas Notebook

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

Der zentrale MCP Gateway liegt im Datenpfad. Daraus folgt:

- Knowledge-Base-Daten bleiben dauerhaft auf der Notebook-Instanz gespeichert.
- Angeforderte Inhalte verlassen die Instanz und werden an ChatGPT übertragen.
- Der zentrale Gateway verarbeitet Inhalte während der Weiterleitung technisch im Klartext, sofern keine zusätzliche Ende-zu-Ende-Verschlüsselung verfügbar ist.
- Der Gateway soll keine Tool-Eingaben, Prompts, Dokumentinhalte oder Ergebnisse dauerhaft speichern.
- Logs sollen Inhalte standardmäßig redigieren oder vollständig auslassen.
- Erlaubte Metriken sollen sich auf Status, Laufzeit, Tooltyp, Datenmenge und Fehlerklassen beschränken.
- Caches für Knowledge-Inhalte sind standardmäßig deaktiviert.
- Support-Zugriff darf keine Inhalte sichtbar machen.

Die Produktkommunikation darf deshalb nicht behaupten, dass externe MCP-Daten die VM niemals verlassen. Korrekt wäre die Aussage, dass die Knowledge Base weiterhin auf der eigenen Instanz gespeichert und nur für explizit autorisierte Anfragen übertragen wird.

## 16. Sicherheitsanforderungen

- Keine lokalen Passwörter im Control Plane.
- Keine Wiederverwendung lokaler Session-Cookies.
- Keine stille Identitätsverknüpfung über E-Mail.
- Eigene, eng begrenzte Instanz-Credentials für den MCP Relay.
- Bevorzugt asymmetrische Instanzidentität statt langfristigem Shared Secret.
- Rotation und Widerruf von Instanz-Credentials.
- kurzlebige OAuth Access Tokens.
- Audience- und Resource-Prüfung.
- signierte, kurzlebige Request-Umschläge.
- Replay-Schutz.
- Rate Limits auf Benutzer-, Grant-, Instanz- und Tool-Ebene.
- Größen- und Laufzeitlimits.
- lokales Re-Authorization-Gate für jeden Request.
- keine Secrets in MCP-Ergebnissen.
- keine ungefilterte Rückgabe versteckter System- oder Agent-Dateien.
- explizite Deny-Regeln für `/data/secrets`, System-Prompts und Runtime-Credentials.
- Security Audit vor Aktivierung schreibender Tools.

## 17. Fehler- und Sperrzustände

Der Gateway und das Notebook sollen stabile, maschinenlesbare Fehlerklassen verwenden.

Beispiele:

```text
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

- Eine offline Instanz wird nicht automatisch durch eine andere Instanz ersetzt.
- Ein deaktivierter lokaler Benutzer verliert den Zugriff sofort.
- Eine entfernte Workspace-Berechtigung wirkt trotz gültigem OAuth-Token sofort.
- Zentrale und lokale Revocation werden unabhängig geprüft.
- Bei abgelaufener Lizenz werden keine neuen Grants oder Requests zugelassen.
- Ein optionales Grace-Period-Verhalten muss ausdrücklich als Produktentscheidung definiert werden.

## 18. Umsetzungsphasen

Die folgenden Phasen sind eine Planungsreihenfolge. Sie stellen noch keinen Implementierungsauftrag dar.

### Phase 0: ADR und Threat Model

- öffentliche Endpunkte festlegen.
- Trust Boundaries dokumentieren.
- Datenfluss und Datenschutzversprechen festlegen.
- Managed Mode und Cloud Link verbindlich trennen.
- Bedrohungsmodell für Instanz-, Benutzer- und Grant-Übernahme erstellen.
- Lizenz- und Tarifgrenzen festlegen.

### Phase 1: Lokaler MCP Core

- read-only Knowledge-Tools definieren.
- Toollogik von MCP-Transport und Gateway trennen.
- lokalen User- und Workspace-Kontext erzwingen.
- direkte lokale Development-Verbindung ermöglichen.
- Ergebnis-, Datei- und Tokenlimits definieren.

### Phase 2: Zentraler OAuth-Provider und MCP Gateway

- OAuth-Metadaten und PKCE umsetzen.
- festen offiziellen MCP-Endpunkt bereitstellen.
- Token-, Audience- und Scope-Prüfung umsetzen.
- Grant-Modell einführen.
- zunächst eine Instanz pro Grant unterstützen.

### Phase 3: Canvas Cloud Link

- separate Instanzregistrierung einführen.
- Instanz-Keypair und Rotation umsetzen.
- ausgehenden Relay-Tunnel bereitstellen.
- Self-hosted- und Managed-Provisionierung unterstützen.
- Lizenz- und Quota-Prüfung integrieren.

### Phase 4: User-Pairing und Workspace-Grants

- Pairing aus einer lokalen authentifizierten Session starten.
- zentralen Account verknüpfen.
- lokale Workspace-Allowlist und Scopes speichern.
- lokale und zentrale Revocation-Oberflächen bereitstellen.
- Audit Events ergänzen.

### Phase 5: Request-Routing und Hardening

- signierte Request-Umschläge.
- Replay- und Idempotency-Schutz.
- Rate Limits.
- Offline- und Revocation-Verhalten.
- Privacy-konformes Logging und Monitoring.
- Last-, Sicherheits- und Ausfalltests.

### Phase 6: Offizielle ChatGPT-App

- App-Metadaten und Toolbeschreibungen finalisieren.
- Privacy Policy und Support-Abläufe bereitstellen.
- OAuth- und Pairing-UX testen.
- Review- und Veröffentlichungsvoraussetzungen erfüllen.
- zunächst ausschließlich read-only Knowledge-Tools veröffentlichen.

### Phase 7: Erweiterungen

- mehrere Instanzen pro zentralem Benutzer.
- mehrere Grants mit unterschiedlichen Workspace-Sets.
- schreibende Tools.
- Freigabe- und Bestätigungsdialoge.
- Mediengenerierung und asynchrone Jobs.
- Enterprise-Gateway und On-Prem-Varianten.

## 19. Entscheidungen für die erste Version

Für einen beherrschbaren ersten Release werden folgende Einschränkungen empfohlen:

1. Nur read-only Knowledge-Base-Zugriff.
2. Ein OAuth-Grant verweist auf genau eine Instanz.
3. Workspaces werden lokal explizit freigegeben.
4. Pairing wird vor dem ChatGPT-OAuth-Flow durchgeführt.
5. Keine lokalen Passwörter oder zentralen E-Mail-Matches.
6. Kein Host- oder Containerzugriff über den MCP Relay.
7. Keine Wiederverwendung des allgemeinen Managed-Service-Tokens.
8. Kein zentraler Knowledge-Cache.
9. Keine Mediengenerierung im MVP.
10. Direkter Development-MCP bleibt unabhängig vom Cloud Link möglich.

## 20. Offene Produkt- und Architekturentscheidungen

Vor Beginn der Implementierung müssen mindestens folgende Fragen entschieden werden:

- Gehört `mcpLocalServer` zur Community-, Pro- oder Enterprise-Lizenz?
- Ist `mcpCloudRelay` ein eigenes Add-on oder Bestandteil von Pro und Managed?
- Welche Traffic- und Request-Quotas gelten?
- Soll der zentrale Account mehrere Instanzen gleichzeitig verwalten können?
- Muss die erste Version Organisationen und Team-Accounts unterstützen?
- Wird Better Auth als zentraler OAuth-Provider erweitert oder ein separater Authorization Server betrieben?
- Läuft der Relay als Bestandteil des bestehenden Control Plane oder als eigener Dienst?
- Wird der Tunnel direkt im Notebook-Prozess, in einem Sidecar oder in einem separaten lokalen Dienst betrieben?
- Welche Daten dürfen für Audit und Abrechnung gespeichert werden?
- Welche maximale Dokument- und Ergebnisgröße gilt?
- Wie werden Lizenzablauf und temporäre Control-Plane-Ausfälle behandelt?
- Welche Anforderungen stellt OpenAI zum Zeitpunkt der konkreten App-Einreichung?

## 21. Abnahmekriterien der Architektur

Die Architekturplanung gilt als bereit für eine spätere Umsetzung, wenn:

- der feste öffentliche MCP- und OAuth-Endpunkt entschieden ist.
- Managed Mode und Self-hosted Cloud Link fachlich und technisch getrennt sind.
- das User-Pairing ohne Übertragung lokaler Zugangsdaten spezifiziert ist.
- Lizenz, Instanzidentität, User Link, OAuth Grant und lokale ACL getrennt modelliert sind.
- die MVP-Tools und Scopes festgelegt sind.
- Datenschutz- und Logging-Grenzen freigegeben sind.
- das Threat Model geprüft wurde.
- die notwendigen Änderungen im Notebook- und Control-Plane-Repository getrennt geplant sind.
- ein Testplan für OAuth, Pairing, Revocation, ACLs, Tunnel und Ausfälle vorliegt.

## 22. Verwandte Dokumente

- [Vorhandene MCP-Client-Integration](../../../dokumentation/architecture/mcp-integration/)
- [Canvas Notebook Architecture](../plan.md)
- [Canvas Control Plane Architecture](../../../dokumentation/architecture/canvas-control-plane/plan.md)
- [Managed Service Planning](../../../dokumentation/manged-service/)
- [License and Registration Plan](../../../license-registration-plan.md)
