---
title: 'Umsetzungsplan zu Ticket 17: Exponierten MCP-Server und OAuth-500 beheben'
status: planned
date: 2026-08-21
platforms: [server, mcp, oauth]
tags: [type/implementation-plan, topic/mcp, topic/oauth, topic/integrations]
---

# Umsetzungsplan: Exponierten MCP-Server und OAuth-500 beheben

## Ziel, Scope und Arbeitsmodus

Dieser Plan konkretisiert [Ticket 17](./17-mcp-server-oauth-500-beheben.md)
gegen den aktuellen Codebestand. Er umfasst ausschliesslich den direkten,
read-only MCP-Server unter `/mcp`, dessen OAuth-Provider unter `/api/auth`, die
zugehoerige Discovery, Runtime-Aktivierung, Readiness und Diagnose bis zu einem
authentifizierten Tool-Call.

Die spaetere Umsetzung erfolgt strikt sequenziell: Eine Phase beginnt erst,
wenn die vorherige implementiert, mit den dort genannten Checks verifiziert
und als eigener fokussierter Commit abgeschlossen ist. Reproduktion und Logs
verwenden nur isolierte Testdaten. Browser-/Playwright-Abnahmen erfolgen wegen
der Repository-Regel erst nach ausdruecklicher Freigabe.

Nicht Teil dieses Tickets sind neue schreibende MCP-Tools, Machine-to-Machine-
Grants, ein allgemeiner Umbau der App-Authentifizierung oder eine Umstellung
von DCR auf einen neuen Client-Registrierungsmechanismus ohne belegte
Kompatibilitaetsursache.

## Verbindliche Quellen und Architekturabgleich

Die vorhandenen Plaene unter
`docs/architecture/canvas-notebook/mcp-server/` dokumentieren die urspruengliche
Absicht, sind aber nicht durchgehend der aktuelle Ist-Stand:

- `plan.md` und `direct-v1-oauth-plan.md` beschreiben teilweise noch
  `auth_probe` als einziges Tool und spaetere Core-Tools als offen.
- `oauth-e2e-validation.md` erwartet ebenfalls nur `auth_probe`.
- `todo.json` fuehrt MCP-OAuth- und Core-Schritte als offen, obwohl der aktuelle
  Server bereits sechs Tool-Definitionen besitzt: `auth_probe` sowie fuenf
  Workspace-/Knowledge-Tools.
- Runtime-Settings, settings-basierte Sofortaktivierung und der moderne
  `createMcpHandler`-Transport kamen nach den Architekturplaenen hinzu.

Fuer die Fehlerbehebung ist deshalb der aktuelle Code die technische
Autoritaet. Die Plaene bleiben Entscheidungsverlauf und werden in Phase 8 auf
den nachgewiesenen Endstand gebracht.

Das Soll muss zugleich mit den aktuellen, primaeren Protokollquellen
abgeglichen werden:

- [OpenAI: OAuth for ChatGPT apps](https://developers.openai.com/plugins/build/auth)
  fuer Protected-Resource-Metadaten, exakten `resource`-Parameter,
  PKCE/S256, Client-Registrierung, `iss` und Callback-Verhalten;
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
  fuer OAuth-2.1-Ressourcenbindung und Challenges;
- die zur Implementierungszeit installierten Better-Auth- und MCP-SDK-Typen
  als versionsgenaue Wahrheit. Aktuell ist Better Auth `1.7.0-rc.6`
  installiert; Annahmen aus einer stabilen spaeteren Version duerfen nicht
  ungeprueft uebernommen werden.

## Inventur des aktuellen Request-Flows

### Startup und Aktivierung

1. `server.js` laedt ueber `server/load-app-env.js` die dauerhaften
   Server-Einstellungen vor Next.js und Auth in `process.env`.
2. Startup-Migrationen laufen vor `app.prepare()` und dem Listen-Aufruf.
3. `app/lib/auth.ts` versucht den Direct-MCP-OAuth-Provider beim Modulimport zu
   konfigurieren. Bei ungueltigem oder fehlendem Public Origin wird nur
   gewarnt; die Anwendung startet ohne OAuth-Plugins weiter.
4. `app/lib/mcp/server/runtime-settings.ts` liest Settings pro Request erneut
   und erlaubt damit eine settings-basierte Aktivierung ohne Restart.
5. `app/api/integrations/mcp-server/route.ts` persistiert und aktiviert die
   Einstellung im aktuellen Prozess, fuehrt aber vor `enabled: true` keinen
   vollstaendigen MCP-/OAuth-Readiness-Check aus.
6. `app/api/health/route.ts` prueft Anwendung und Datenbank, nicht aber MCP-
   Konfiguration, OAuth-Schema, Provider, JWKS oder Transport. Der
   Start-Wrapper kann die Instanz daher als bereit melden, obwohl der
   exponierte MCP-Flow nicht bereit ist.

### Discovery, OAuth und Transport

- Die kanonische Ressource ist `https://<public-origin>/mcp`, der Issuer
  `https://<public-origin>/api/auth`. Der Origin kommt statisch aus
  `BETTER_AUTH_BASE_URL` oder `BASE_URL`, nicht aus einem beliebigen Host-
  Header.
- Protected-Resource-Metadaten werden an der Root- und `/mcp`-Well-Known-Route
  angeboten. Authorization-Server-Metadaten besitzen ebenfalls eine
  kanonische Route und einen Kompatibilitaetsalias.
- `app/api/auth/[...all]/route.ts` legt vor Better Auth Policies fuer DCR,
  Authorize, Token, Refresh, Revoke und Introspect. Bekannte Policy-Fehler sind
  strukturiert; unerwartete Provider-, Settings- oder Datenbankfehler besitzen
  noch keine gemeinsame, korrelierte Fehlergrenze.
- Authorization Code und Refresh Token sind an die exakte MCP-Ressource
  gebunden. Authorization Code + PKCE/S256 und Refresh Token sind die einzigen
  vorgesehenen Grants.
- `app/lib/mcp/server/token-verifier.ts` prueft Signatur, exakten Issuer und
  Audience, Claims, Session, Nutzer, Client, Grant und Scope. Bekannte
  Authentifizierungs-, Scope- und Infrastrukturfehler werden bereits als
  401/403/503 unterschieden.
- `app/mcp/route.ts` delegiert an einen zustandslosen HTTP-Transport.
  `POST` und `OPTIONS` sind vorgesehen; `GET` und `DELETE` liefern 405. Moderne
  und Legacy-Protokollpfade erzeugen Server/Handler pro Request.
- `proxy.ts` laesst `/mcp`, Well-Known-Routen und `/api/auth` ohne App-Login
  passieren. CORS akzeptiert nur den konfigurierten vertrauenswuerdigen Origin
  oder serverseitige Clients ohne `Origin`.
- Alle MCP-Tools deklarieren Security Schemes und pruefen Token, Scope und
  aktuelle Workspace-Berechtigung erneut. Einzelne Tool-Fehler geben derzeit
  jedoch rohe `error.message`-Texte zurueck.

## Belegte Luecken und zu verifizierende Ursachen

### Durch Codeinventur belegt

1. **Readiness-Luecke:** `/api/health` kann erfolgreich sein, obwohl Direct MCP
   aktiviert, aber dessen Konfiguration, OAuth-Provider oder Schema nicht
   funktionsfaehig ist.
2. **Fail-open beim Auth-Bootstrap:** Ein fehlerhafter Public Origin fuehrt in
   `app/lib/auth.ts` zu einer Warnung und einem Start ohne OAuth-Plugins. Bei
   aktiviertem MCP entsteht damit ein extern erreichbarer, inkonsistenter
   Teilzustand.
3. **Ungepruefte Aktivierung:** Der Settings-PATCH kann `enabled: true`
   persistieren, obwohl der Status bereits einen `configurationError` kennt.
   Nachfolgende Discovery- oder Transport-Requests koennen beim erneuten
   Aufloesen der Konfiguration ungeplant in einen 500 laufen.
4. **Schema-Testluecke:** `scripts/mcp-server-oauth-schema-test.ts` prueft nur
   die aeltere Teilmenge der OAuth-Tabellen. Die in der aktuellen Better-Auth-
   Integration verwendeten Tabellen `oauth_resource`,
   `oauth_client_resource` und `oauth_client_assertion` sind nicht explizit in
   Fresh-/Upgrade-Assertions enthalten. Die juengsten Reparaturen fuer JWKS-
   `alg`/`crv` und `account.issuer` belegen zudem ein reales Risiko bei
   Versions-/Schema-Drift.
5. **Diagnoseluecke:** Der Transport loggt rohe Error-Objekte ohne Request-ID;
   OAuth- und Discovery-Grenzen besitzen keine gemeinsame Phasen-/Fehlercode-
   Taxonomie. Ein Flow ist dadurch ueber mehrere Requests nicht sicher
   korrelierbar.
6. **Informationsleck-Risiko:** Tool-Fehler koennen interne
   `error.message`-Texte an den Client durchreichen. Eine zentrale Redaction
   fuer Header, Query, Bodies und Fehlerursachen fehlt.
7. **E2E-Luecke:** Der HTTP-Smoke-Test prueft Discovery, Transport und anonyme
   Challenge, verbindet den realen HTTP-OAuth-Flow aber nicht mit einem
   anschliessenden authentifizierten `tools/list` und `tools/call`.
8. **Restart-Luecke:** Bootstrap-Tests pruefen das Laden von Settings, aber
   nicht den gesamten Zustand `persistiert aktiviert -> Prozessstart ->
   Readiness -> Discovery -> authentifizierter Aufruf`.
9. **Dokumentationsdrift:** Toolanzahl, Status und Validierungsanleitung stimmen
   nicht mehr mit dem Code ueberein.

### Erst durch redigierte Reproduktion zu bestaetigen

Der beobachtete ChatGPT-500 darf vor Phase 1 keiner einzelnen Ursache
zugeschrieben werden. Insbesondere sind zu pruefen:

- fehlende oder nur teilweise migrierte Better-Auth-Tabellen/-Spalten auf der
  betroffenen Instanz;
- beim Boot nicht registrierter OAuth-Provider trotz spaeter aktivierter
  Runtime-Einstellung;
- Abweichungen zwischen externem Origin, Issuer, MCP-`resource`, Audience,
  registrierter Redirect-URI und den am Proxy ankommenden Werten;
- ein Fehler waehrend Client-Registrierung, Consent, Code-Austausch,
  JWKS-Laden, Grant-/Session-Pruefung oder MCP-Handler-Erzeugung;
- eine ChatGPT-Callback-Variante, die wegen fehlendem/abweichendem `iss` oder
  Metadaten anders ausfaellt als der isolierte Testclient;
- ein unerwarteter Fehler im ersten authentifizierten Tool-Call statt im
  eigentlichen Token-Austausch.

Die Diagnose muss den ersten fehlgeschlagenen Phasenwechsel und dessen
stabilen internen Fehlercode belegen. Zeitliche Naehe allein reicht nicht als
Root-Cause-Nachweis.

## Architektur- und Sicherheitsentscheidungen

### 1. Ein kanonischer Origin ist die Autoritaet

`BETTER_AUTH_BASE_URL` beziehungsweise `BASE_URL` bleibt die einzige Quelle
fuer Issuer, Resource-ID, Discovery-URLs und servereigene OAuth-Endpunkte.
Beliebige `Host`, `Forwarded` oder `X-Forwarded-*`-Werte duerfen diese URLs
nicht formen. Die Konfiguration wird auf origin-only, HTTPS ausser localhost,
identische Origins und normalisierte Pfade validiert.

Am vertrauenswuerdigen Reverse Proxy werden Forwarded-Header ueberschrieben,
nicht angehaengt. Die Anwendung darf normalisierte Proxy-Werte nur gegen den
kanonischen Origin vergleichen und Abweichungen redigiert melden; sie darf
keinen untrusted Header als Redirect- oder Audience-Autoritaet verwenden.

### 2. Aktiviertes MCP startet fail-closed

Ein gemeinsamer, seiteneffektarmer `validateDirectMcpReadiness()`-Pfad wird
von Startup, Settings-Aktivierung und Health verwendet. Er prueft mindestens:

- kanonischen Origin, Ressourcen-/Issuer-Vertrag und erlaubte Tools;
- Vorhandensein der versionsgenau erwarteten OAuth-Tabellen, Spalten und
  Indizes fuer den aktiven Datenbankprovider;
- Verfuegbarkeit des OAuth-Providers und seiner Metadaten;
- JWKS-Lese-/Initialisierungsfaehigkeit und erlaubten Algorithmus/Kurve;
- Erzeugbarkeit des MCP-Handlers und konsistente Tool-Security-Schemes.

Ist MCP deaktiviert, darf die restliche App starten und Health meldet den
MCP-Zustand als `disabled`. Ist MCP dauerhaft aktiviert und der Preflight
schlaegt fehl, darf der Server vor `listen()` nicht als bereit erscheinen.
Eine Aktivierung ueber Settings wird vor Persistenz/Anwendung abgelehnt und
laesst den letzten funktionsfaehigen Zustand unangetastet. Konfigurations-
Aenderungen, die den beim Boot erzeugten Provider betreffen, werden als
restart-pflichtig ausgewiesen, statt eine nur scheinbare Sofortaktivierung zu
melden.

### 3. DCR bleibt zunaechst der kompatible Registrierungsweg

Die bestehende Dynamic Client Registration bleibt fuer dieses Bugfix-Ticket
erhalten. Sie wird weiterhin auf oeffentliche Clients, exakte Redirect-URIs,
Authorization Code/Refresh und PKCE S256 begrenzt. CIMD oder eine vordefinierte
ChatGPT-Client-ID werden nur in einem separaten Architekturentscheid
eingefuehrt, falls die reproduzierte Inkompatibilitaet das verlangt.

Metadaten und tatsaechliche Authorization Response muessen
`authorization_response_iss_parameter_supported` beziehungsweise den exakten
`iss` konsistent abbilden. Dadurch ist sowohl der stabile ChatGPT-Callback als
auch die dokumentierte Fallback-Variante testbar, ohne Callback-URLs
unbesehen zu erlauben.

### 4. Resource- und Token-Bindung bleibt exakt

Der Wert der PRM-`resource` ist die kanonische `/mcp`-HTTPS-URL. Derselbe Wert
wird in Authorize und Token verlangt und als einzige MCP-Audience akzeptiert.
Kein Prefix-, Host- oder Pfad-Fallback. Userinfo darf nur seine bereits
begruendete Same-Instance-Audience-Ausnahme behalten. Jeder Tool-Call prueft
zusaetzlich aktuelle Session-, Nutzer-, Client-, Grant-, Scope- und
Workspace-Rechte.

### 5. Protokollfehler und interne Diagnose bleiben getrennt

OAuth-Endpunkte behalten standardkonforme Fehlerfelder und Redirect-Semantik;
MCP behält JSON-RPC-/Challenge-Semantik. Zusaetzlich wird auf jeder
Serverantwort eine neu erzeugte, nicht vom Client uebernommene
`X-Request-Id` ausgegeben. Erwartete Fehler werden in stabile interne Codes
uebersetzt, ohne Stack, SQL, Pfade oder Providertexte an Clients zu senden.

Ein `flowRef` darf mehrere OAuth-Requests nur als gekuerzter HMAC ueber
serverseitig bekannte Flowmerkmale korrelieren. `state`, Code, Token,
Verifier, Challenge, Client Secret und der signierte `oauth_query` werden nie
roh gespeichert oder geloggt.

## Daten- und API-Vertraege

### Readiness

`GET /api/health` behaelt seinen bestehenden Vertrag und ergaenzt einen
sanitisierten MCP-Check:

```json
{
  "ok": true,
  "checks": {
    "mcp": {
      "status": "disabled | starting | ready | degraded | failed",
      "code": "MCP_READY"
    }
  }
}
```

Bei aktiviertem MCP ist `ready` fuer HTTP 200 erforderlich. `starting`,
`degraded` oder `failed` liefern Health 503 und niemals Detailursachen oder
Secrets. Die konkrete Ursache steht nur redigiert unter derselben Request-ID
im Serverlog. Ein deaktiviertes MCP beeintraechtigt die Gesamt-Readiness nicht.

### Settings-Aktivierung

Der Admin-PATCH bleibt abwaertskompatibel. Vor dem Uebergang auf `enabled`
laeuft derselbe Preflight. Bei ungueltiger Eingabe gilt 422, bei fehlender
Runtime-/Schema-Verfuegbarkeit 503, bei revisionsbedingtem Konflikt 409. Die
Response enthaelt einen stabilen `code`, `requestId` und eine sichere
Handlungsempfehlung; sie persistiert bei Fehler keinen halbaktiven Zustand.

### Discovery

- PRM liefert genau die kanonische Resource-ID, Authorization-Server-Liste und
  unterstuetzten Bearer-Methoden.
- AS-Metadaten liefern exakten Issuer, DCR-, Authorize-, Token-, Revoke- und
  Introspect-Endpunkte, `S256`, Grants, Scopes und die tatsaechlich
  unterstuetzte Client-Authentifizierung.
- Root-/Pfad- und AS-Aliase muessen inhaltlich dieselben kanonischen Werte
  liefern. Bei aktiviertem, aber nicht bereitem Provider folgt 503 mit
  `MCP_OAUTH_NOT_READY`; deaktiviert bleibt das bisherige 404-Verhalten.

### Fehlerklassifikation

| Fall | HTTP/Protokoll | Stabiler interner Code |
| --- | --- | --- |
| MCP deaktiviert | 404 | `MCP_DISABLED` |
| Aktiviert, Preflight/Provider nicht bereit | 503 | `MCP_NOT_READY` |
| Unzulaessiger Origin | 403 | `MCP_ORIGIN_REJECTED` |
| Methode nicht unterstuetzt | 405 | `MCP_METHOD_NOT_ALLOWED` |
| Ungueltige Redirect-URI/Resource/PKCE oder manipulierte serverseitige Continuation | OAuth 400/Redirect-Error | `OAUTH_REQUEST_INVALID` mit sicherem Subcode |
| Fehlendes/ungueltiges Token | 401 + `WWW-Authenticate`/PRM | `MCP_TOKEN_INVALID` |
| Fehlender Scope/Berechtigung | 403 | `MCP_SCOPE_FORBIDDEN` bzw. `MCP_ACCESS_FORBIDDEN` |
| JWKS/DB/Grant-Pruefung nicht verfuegbar | 503 | `MCP_AUTH_DEPENDENCY_UNAVAILABLE` |
| Unbekannter interner Fehler | 500 | `MCP_INTERNAL_ERROR` |

Eine manipulierte signierte Login-/Consent-Continuation wird serverseitig als
400 abgewiesen. Den vom Authorization Server unveraendert zurueckgegebenen
OAuth-`state` muss dagegen der externe Client mit seinem Ausgangswert
vergleichen; der Testclient bildet diesen Pflichtcheck explizit ab und bricht
bei Abweichung vor dem Token-Austausch ab.

### Schema und Migration

Die Implementation leitet das erwartete Schema aus der installierten
Better-Auth-Version und den lokalen Drizzle-Definitionen ab. Mindestens
folgende Tabellen/Beziehungen werden explizit getestet: `jwks`,
`oauth_client`, `oauth_resource`, `oauth_client_resource`,
`oauth_client_assertion`, `oauth_consent`, `oauth_access_token` und
`oauth_refresh_token`; ausserdem `account.issuer`, benoetigte Indizes und die
Session-/User-Referenzen.

Migrationen sind additiv und idempotent fuer SQLite und PostgreSQL. Kein
Startpfad darf produktive OAuth-Daten automatisch loeschen. Falls eine
versionsbedingte Token-Inkompatibilitaet nachgewiesen wird, ist eine bewusst
freizugebende Token-/Client-Reautorisierung mit Vorab-Kommunikation ein eigener
Migrationsschritt, nicht ein stiller Nebeneffekt.

## Voraussichtlich betroffene Codegrenzen

Die genaue Aenderungsliste folgt aus der Reproduktion; die Planung ordnet die
Verantwortung bereits den vorhandenen Grenzen zu:

- Startup/Readiness: `server.js`, `server/load-app-env.js`,
  `app/api/health/route.ts`, `app/lib/mcp/server/runtime-settings.ts` und ein
  kleiner gemeinsamer Readiness-Baustein unter `app/lib/mcp/server/`;
- Aktivierung/Status: `app/api/integrations/mcp-server/route.ts` und
  `app/lib/mcp/server/settings-status.ts`;
- kanonische URLs und Discovery:
  `app/lib/mcp/server/config.ts`, die beiden Protected-Resource-Routen und die
  beiden Authorization-Server-Metadatenrouten;
- OAuth-Grenze: `app/lib/auth.ts`,
  `app/api/auth/[...all]/route.ts`, OAuth-Request-Policy,
  Login-/Consent-Continuation und Grant-Revocation;
- Token/Transport/Tools: `app/lib/mcp/server/token-verifier.ts`,
  `app/lib/mcp/server/streamable-http.ts`, `app/lib/mcp/server/direct-server.ts`
  und die vorhandenen read-only Tool-Handler;
- Datenmodell: bestehende SQLite-/PostgreSQL-Drizzle-Schemata und
  Startup-Migrationen, ohne paralleles alternatives Schema;
- Tests: die vorhandenen `scripts/mcp-server-*-test.*`-Suiten, insbesondere
  Schema, Provider, Login/Consent, OAuth-Client, Protected Resource,
  Auth-Probe, Runtime-Bootstrap, Settings und HTTP-Smoke;
- Abschlussdokumentation:
  `docs/architecture/canvas-notebook/mcp-server/{plan.md,direct-v1-oauth-plan.md,oauth-e2e-validation.md,todo.json}`
  sowie Ticket und Bug-Index.

Neue Hilfsdateien sind nur fuer gemeinsam genutzte Readiness- oder
Diagnoselogik vorgesehen. Routen und Tools duerfen keine eigene zweite
Konfigurations-, Redaction- oder Fehlerklassifikationslogik erhalten.

## Redigierte Diagnosekette

Jede Phase schreibt genau ein Start-/Ergebnisereignis mit `requestId`, optional
`flowRef`, Phase, Status, stabilem Code und Dauer. Erlaubt sind normalisierte
Methoden/Pfadschablonen, Runtime-Status, Protokollversion, Tool-ID und gehashte
Client-/User-Referenzen. Verboten sind Request-/Response-Bodies, Querystrings,
Cookies, Authorization-Header, Codes, Token, Secrets, State, PKCE-Werte,
persoenliche Inhalte, Dateipfade und rohe Error-Objekte.

Die Reproduktion folgt ohne Spruenge dieser Reihenfolge:

1. `startup.settings`
2. `startup.config`
3. `startup.schema`
4. `startup.oauth_provider`
5. `startup.jwks`
6. `startup.mcp_transport`
7. `discovery.protected_resource`
8. `discovery.authorization_server`
9. `oauth.client_registration`
10. `oauth.authorization_request`
11. `oauth.login_consent`
12. `oauth.authorization_response`
13. `oauth.token_exchange`
14. `token.signature_claims`
15. `token.grant_session_access`
16. `mcp.initialize`
17. `mcp.tools_list`
18. `mcp.tool_call_authorize`
19. `mcp.tool_call_execute`

Der erste Status ausserhalb des erwarteten 2xx/3xx-/OAuth-Protokollpfads ist
die Diagnosegrenze. Nach einem Fix wird exakt derselbe isolierte Ablauf erneut
ausgefuehrt; Erfolg nur bei authentifiziertem `tools/call`, nicht bereits beim
Token-Empfang.

## Strikt sequenzielle Implementierungsphasen

### Phase 1: Reproduzierbare, redigierte Diagnosebasis

- Eine MCP/OAuth-spezifische Diagnosegrenze mit Request-ID, Phasennamen,
  sicheren Fehlercodes, Allowlist-Feldern und zentralen Redaction-Tests
  einfuehren.
- Discovery-, Auth- und Transport-Routen instrumentieren, ohne
  Protokollantworten zu veraendern.
- Einen isolierten HTTP-Testclient erweitern, der DCR, Login/Consent,
  Authorization Code + PKCE, Token, `initialize`, `tools/list` und
  `auth_probe`/einen erlaubten read-only Tool-Call sequenziell ausfuehrt.
- Den aktuellen Fehler zuerst mit Test-Credentials reproduzieren und den
  ersten fehlerhaften Phasenwechsel dokumentieren. Keine Produktionslogs oder
  Zugangsdaten in Testartefakten ablegen.
- Tests: neue Redaction-/Fehlergrenzen-Tests und isolierter reproduzierender
  Flow. Ein Test darf zunaechst gezielt den belegten Defekt zeigen, der Commit
  muss aber reproduzierbar und ohne Secrets sein.
- Verifikation: fokussierte Diagnose-Tests und `npm run build`.
- Commit: `Add redacted MCP OAuth flow diagnostics`.

### Phase 2: Schema- und Versionsvertrag absichern

- Better-Auth-`1.7.0-rc.6`-Schema gegen SQLite- und PostgreSQL-Definitionen,
  generierte Migrationen und reale Query-Pfade vergleichen.
- Schema-Test um alle Resource-/Assertion-Tabellen, `account.issuer`, JWKS-
  Algorithmus/Kurve, Foreign Keys und benoetigte Indizes erweitern.
- Fresh-, Upgrade-von-altem-Snapshot- und zweiter idempotenter Startlauf fuer
  beide Datenbankprovider testen.
- Nur bei belegter Abweichung eine additive Startup-Migration implementieren;
  keine spekulativen Tabellen oder Datenresets.
- Den isolierten OAuth-Flow bis Token-Ausgabe erneut ausfuehren. Falls der 500
  hier behoben ist, Root Cause mit Test und Fehlercode festhalten; die
  folgenden Haertungen bleiben dennoch erforderlich.
- Verifikation: `npm run test:mcp:server-schema`, betroffene Auth-/DB-Tests und
  `npm run build`.
- Commit: `Align MCP OAuth runtime schema`.

### Phase 3: Einheitlichen Preflight und fail-closed Startup herstellen

- Einen gemeinsamen Readiness-Service fuer Config, Schema, Provider, JWKS,
  Transport und Tool-Security-Schemes implementieren.
- `server.js` laesst bei persistiert aktiviertem MCP den Preflight vor
  `listen()` laufen und beendet einen fehlerhaften Start mit sicherem Code.
- `/api/health` bildet den MCP-Zustand nach dem oben definierten Vertrag ab;
  der Start-Wrapper akzeptiert die Instanz erst bei `ready` oder bewusst
  `disabled`.
- Auth-Bootstrap darf bei aktiviertem MCP eine fehlerhafte Provider-
  Konfiguration nicht mehr nur als Warnung behandeln.
- Tests fuer deaktivierten Start, erfolgreichen aktivierten Start, fehlenden
  Origin, fehlendes Schema/JWKS, Restart mit persistierten Settings und
  Recovery nach korrigierter Konfiguration ergaenzen.
- Verifikation: `npm run test:mcp:server-settings`,
  `npm run test:mcp:server-schema`,
  `npm run test:mcp:server-provider`, ergaenzte Health-Tests und
  `npm run build`.
- Commit: `Gate MCP startup on OAuth readiness`.

### Phase 4: Settings-Aktivierung atomar und wahrheitsgemaess machen

- Admin-PATCH vor Persistenz und Runtime-Umschaltung gegen den gemeinsamen
  Preflight pruefen.
- Bei Fehler den vorherigen Settings-/Runtime-Zustand bewahren und 409, 422
  oder 503 mit sicherem Code/Request-ID liefern.
- Explizit unterscheiden, ob eine Einstellung sofort anwendbar oder wegen
  Provider-Bootstrap restart-pflichtig ist. Status und UI duerfen nicht
  `active` melden, solange der Provider fehlt.
- Cross-Process-/Restart-Tests fuer Settings-Datei, Env-Prioritaet,
  Revisionen, Aktivierung, Deaktivierung und Rollback ergaenzen.
- Verifikation: `npm run test:mcp:server-settings`, ergaenzte Bootstrap-/API-
  Tests und `npm run build`.
- Commit: `Make MCP activation readiness-safe`.

### Phase 5: Discovery, Origin, Redirect und OAuth-Vertrag haerten

- PRM- und AS-Metadaten kanonisch vergleichen; Aliase duerfen keine
  abweichenden Issuer-, Resource- oder Endpoint-Werte liefern.
- Exakten `resource`-Roundtrip in Authorize und Token sowie Audience-Bindung
  fuer Code und Refresh absichern.
- DCR auf exakte Redirect-URI, Public Client, Grants, Scopes und S256
  regressionsfest testen. `iss`-Metadatum und tatsaechliche Authorization-
  Response muessen uebereinstimmen.
- Proxy-Tests fuer korrekten externen Origin, manipulierte Host-/Forwarded-
  Header, HTTP-vs-HTTPS und Subpath-/Port-Abweichungen hinzufuegen. Keine URL
  wird aus untrusted Headern konstruiert.
- Negative OAuth-Tests fuer Redirect, Resource, PKCE, Code-Replay, State-
  Rueckgabe/Clientvalidierung und ungueltigen Client erweitern. Erwartete
  Eingabefehler duerfen nie als 500 enden.
- Verifikation: `npm run test:mcp:server-provider`,
  `npm run test:mcp:server-login-consent`,
  `npm run test:mcp:server-oauth-client`,
  `npm run test:mcp:server-resource` und `npm run build`.
- Commit: `Harden MCP OAuth discovery and redirects`.

### Phase 6: Token-Verifikation und HTTP-Transport stabilisieren

- Token-Fehler vollstaendig auf 401/403/503 und korrekte
  `WWW-Authenticate`-Challenges abbilden; nur unbekannte Defekte bleiben 500.
- Moderne und Legacy-Transportpfade erhalten dieselbe Request-ID,
  Fehlergrenze, Origin-Policy und per-Request Auth-Information.
- `POST`/`OPTIONS` sowie bewusst abgelehnte `GET`/`DELETE` regressionsfest
  halten; Handler duerfen bei `ready` nie uninitialisiert sein.
- Tool-Fehler auf sichere, stabile Clientmeldungen umstellen. Interne
  Exceptions und Dateiinhalte bleiben ausschliesslich redigiert serverseitig.
- Tests fuer falschen Issuer/Audience/Signatur/Expiry, fehlende Claims,
  entzogenes Session-/User-/Client-/Grant-Recht, Scope, JWKS-/DB-Ausfall,
  CORS, Methoden und beide Protokollpfade ergaenzen.
- Verifikation: `npm run test:mcp:server-resource`,
  `npm run test:mcp:server-auth-probe`, ergaenzte HTTP-Transport-Tests und
  `npm run build`.
- Commit: `Stabilize MCP token and transport errors`.

### Phase 7: Vollstaendigen HTTP- und Restart-Flow abnehmen

- Den HTTP-Smoke-Test auf die gesamte Diagnosekette ausweiten: Discovery,
  DCR, Login/Consent, PKCE-Code, Token, `initialize`, `tools/list` und einen
  authentifizierten read-only `tools/call`.
- Positiven Ablauf nach sauberem Restart mit denselben persistierten Settings,
  aber frisch erzeugten Test-Credentials wiederholen.
- Negative Matrix fuer Redirect, State, PKCE, Resource/Audience, Token,
  Revocation und Dependency-Ausfall ausfuehren; erwartete 4xx/503 und
  Request-ID pruefen.
- Automatisch Logs auf Bearer-Werte, Codes, Secrets, Cookies, State,
  PKCE-Werte und bekannte Testmarker scannen.
- Nur wenn fuer die Abnahme ein Container explizit beauftragt wird: vorher
  `npm run build`, sicherstellen, dass kein zweiter Test-Container laeuft, und
  den einzigen Test-Container aus aktuellem Stand neu erstellen.
- Verifikation: `npm run test:mcp:server-http-smoke`, alle weiteren
  Direct-MCP-Testskripte, `npm run build` und dokumentierter HTTP-Smoke-Test.
- Commit: `Verify authenticated MCP OAuth end to end`.

### Phase 8: Manuelle ChatGPT-Abnahme und Dokumentation

- Erst nach ausdruecklicher Browser-/Playwright-Freigabe den echten externen
  ChatGPT-Connector mit dediziertem Testkonto verbinden.
- Von Discovery bis authentifiziertem read-only Tool-Call jede Phase anhand
  Request-ID/`flowRef` und Status belegen; danach Server neu starten und den
  Flow erneut abnehmen.
- Sichtbar pruefen, dass Fehler sichere Handlungshinweise statt generischer
  500 oder interner Details zeigen.
- Architekturplaene, Toolinventar, `oauth-e2e-validation.md` und `todo.json`
  auf den verifizierten Ist-Stand aktualisieren. Erst dann Ticketstatus und
  Bug-Index aktualisieren.
- Verifikation: dokumentierte manuelle Abnahme, Log-Redaction-Check, alle
  automatisierten MCP-Tests und abschliessend `npm run build`.
- Commit: `Document verified MCP OAuth recovery`.

## Automatisierte Abnahmematrix

Die Umsetzung ist erst technisch abgenommen, wenn mindestens gilt:

- Fresh- und Upgrade-Schema funktionieren idempotent auf SQLite und
  PostgreSQL/PGlite mit allen OAuth-Ressourcentabellen/-spalten.
- Persistiert deaktiviertes MCP startet die App; persistiert aktiviertes MCP
  wird nur bei erfolgreichem Preflight bereit.
- Eine fehlerhafte Konfiguration kann nicht als `active` persistiert oder von
  Health als bereit gemeldet werden.
- Beide Discovery-Aliase liefern dieselben kanonischen Werte; manipulierter
  Host/Forwarded-Header aendert keine URL.
- DCR -> Authorize -> Login/Consent -> Code -> Token funktioniert mit S256,
  exakter Redirect-URI und exaktem Resource-Wert.
- Falsche Redirect-URI, Resource/Audience, PKCE, Code-Replay, Token, Scope und
  entzogenes Zugriffsrecht liefern jeweils den erwarteten 4xx; absichtlich
  nicht verfuegbare Auth-Abhaengigkeiten liefern 503, keinen generischen 500.
- Gueltiges Token funktioniert fuer moderne und Legacy-MCP-Initialisierung,
  `tools/list` und einen erlaubten read-only Tool-Call.
- Derselbe positive Flow funktioniert nach Restart erneut.
- Log-Capture enthaelt Request-ID und Phase, aber keinen Authorization-Header,
  Cookie, Code, Token, Secret, State, Verifier, Challenge, OAuth-Query,
  Nutzinhalt oder rohen Stacktrace in Clientantworten.

## Manuelle Abnahmekriterien

Nach expliziter Freigabe wird auf der vorgesehenen Testinstanz geprueft:

1. Settings zeigen vor Exposition einen eindeutigen Zustand `ready` oder eine
   sichere, konkrete Fehlermeldung mit Request-ID.
2. ChatGPT entdeckt Ressource und Authorization Server ohne manuelle URL-
   Korrektur.
3. Login und Consent zeigen den erwarteten Client, Scopes und die kanonische
   Ressource; Ablehnen und Zuruecknavigieren bleiben sicher.
4. Autorisierung endet in erfolgreichem `tools/list` und einem
   authentifizierten read-only Tool-Call.
5. Serverneustart, Readiness und derselbe Flow funktionieren erneut.
6. Gezielte negative Testfaelle erzeugen nachvollziehbare 4xx/503 und niemals
   sichtbare Secrets oder einen unerklaerten generischen 500.
7. Logs lassen den Flow ueber Request-ID/`flowRef` nachvollziehen, ohne
   vertrauliche Werte offenzulegen.

## Risiken, Migration und Rollback

- **Better-Auth-RC-Drift:** Vor jeder Schemaaenderung installierte Typen und
  generierte Migrationen diffen. Dependency-Upgrades nicht mit dem Bugfix
  vermischen.
- **Bestehende OAuth-Clients:** DCR-Datensaetze und Refresh Grants erhalten.
  Additive Migrationen zuerst; erzwungene Reautorisierung nur nach Beleg und
  Ankuendigung.
- **Mehrere Runtime-Prozesse:** Settings und Readiness duerfen nicht allein aus
  einem prozesslokalen Cache stammen. Cross-Process-/Restart-Tests muessen den
  autoritativen, dauerhaften Zustand beweisen.
- **Proxy-Fehlkonfiguration:** Striktes Fail-closed kann eine bisher scheinbar
  laufende Instanz als nicht bereit markieren. Vor Rollout Public Origin,
  TLS-Termination und Caddy-Header pruefen.
- **Log-Kardinalitaet/PII:** Nur Allowlist-Felder und gekuerzte HMAC-Referenzen;
  Retention und Sampling fuer Erfolgsevents begrenzen, Fehler nicht mit
  Payloads anreichern.
- **Protokollkompatibilitaet:** DCR und bestehende Aliase waehrend des Fixes
  erhalten. Eine CIMD-/Predefined-Client-Migration ist separat und
  rueckwaertskompatibel zu planen.
- **Rollback:** Jeden Phasen-Commit einzeln revertierbar halten. Additive
  Schemaobjekte duerfen beim Code-Rollback liegen bleiben. Runtime kann als
  Sofortmassnahme auf `disabled` gesetzt werden; der restliche Dienst bleibt
  erreichbar. Keine destruktive Down-Migration und kein automatisches
  Loeschen von Clients/Tokens.

## Definition of Done

- Die konkrete 500-Ursache ist durch die erste fehlschlagende Diagnosephase,
  einen regressionsfesten Test und den zugehoerigen Fix belegt.
- Startup, Settings und Health teilen denselben Readiness-Vertrag; ein
  aktivierter, nicht initialisierter MCP-Server wird nicht exponiert.
- Discovery, Issuer, Resource, Redirect, PKCE und Token-Audience sind unter
  realer Proxy-Nutzung konsistent und gegen Header-Manipulation abgesichert.
- Der vollstaendige HTTP-OAuth-Flow endet vor und nach Restart in einem
  authentifizierten read-only Tool-Call.
- Alle Negativfaelle liefern stabile 4xx/503, unbekannte Defekte eine
  korrelierbare redigierte 500; keine Secrets erscheinen in Logs oder UI.
- Alle betroffenen Tests und `npm run build` sind erfolgreich; die manuelle
  ChatGPT-/Browser-Abnahme wurde nur mit expliziter Freigabe ausgefuehrt.
- Architektur- und Validierungsdokumentation, Ticketstatus und Index bilden
  erst nach erfolgreicher Implementierung den verifizierten Endstand ab.
