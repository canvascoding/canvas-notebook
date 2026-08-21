---
title: 'Umsetzungsplan zu Ticket 11: Lizenztypen und Control-Plane-Handshake Ende-zu-Ende testen'
status: planned
date: 2026-08-21
platforms: [server, control-plane, vm-agent]
repositories: [canvasstudios-notebook, canvas-control-plane]
tags: [type/implementation-plan, topic/licensing, topic/control-plane, topic/e2e, topic/security]
---

# Umsetzungsplan: Lizenztypen und Control-Plane-Handshake Ende-zu-Ende testen

## Ziel, Scope und Arbeitsmodus

Dieser Plan konkretisiert [Ticket 11](./11-lizenztypen-und-control-plane-handshake-testen.md)
gegen den am 21.08.2026 lokal vorgefundenen Codebestand:

- Canvas Notebook: Commit `4fa20777`, Paketversion `2026.8.18.5`;
- Canvas Control Plane: Commit `b11ecf2`, API-Paketversion `1.0.63`;
- gemeinsamer Vertrag: `canvas-team-seat-protocol-v1`;
- beide Vertrag-Fixtures haben denselben SHA-256-Wert
  `bb54a08a0ac80bd6987b4808b9ba2a9022ea50c0f3ad928dac8460654f86edc7`.

Umgesetzt wird ausschliesslich die reproduzierbare, repositoryuebergreifende
Lizenz- und Handshake-Abnahme. Tickets 12, 13 und 15 bleiben ausserhalb dieses
Scopes. Insbesondere werden hier weder der allgemeine Einladungsflow neu
gestaltet noch ein neues Last-Seen-Modell oder ein neuer Update-/Bootstrap-Flow
eingefuehrt. Ein im Test belegter Produktfehler wird nur dann innerhalb Ticket
11 behoben, wenn er unmittelbar den bestehenden Lizenzvertrag, die sichere
Testlizenz-Ausgabe oder die reproduzierbare Abnahme blockiert. Jeder solche
Fix erhaelt einen eigenen, fokussierten Commit und seine Regressionstests.

Die spaetere Umsetzung erfolgt strikt sequenziell. Eine Phase beginnt erst,
wenn die vorherige Phase implementiert, mit den dort genannten Gates geprueft
und in dem jeweils betroffenen Repository committed ist. Container-, Server-
und Browserlaeufe erfolgen nur nach der dafuer erforderlichen ausdruecklichen
Freigabe. Dieser Plan selbst startet keine Prozesse und veraendert keinen
Produktivcode.

## Inventur des bestehenden Stands

### Canvas Notebook

Der Notebook-Lizenzpfad ist bereits weitgehend implementiert:

- `app/lib/license/team-seat-contract.ts`
  - definiert `canvas-team-seat-protocol-v1`, Hosting-Modi `community|cloud`,
    Editions `solo|team`, Lizenzklassen `commercial|manual|test`, Environments
    `development|test|staging|production` und Provider
    `stripe|manual|test|disabled`;
  - typisiert Claim, Preflight, Quote, Authorization, Seat-Execute, Snapshot,
    Refresh und stabile Fehlercodes;
  - validiert eingehende Control-Plane-Payloads fail-closed.
- `app/lib/control-plane/team-client.ts`
  - sendet `X-Canvas-Team-Seat-Protocol`, `X-Canvas-Operation-Id` und
    `X-Canvas-Notebook-Version`;
  - verwendet Bearer-Instanz-Tokens, zehn Sekunden Request-Timeout und
    begrenzte Retries fuer temporaere Fehler;
  - redigiert Tokens, Zertifikate, Member-Hashes, E-Mail-Adressen und
    URL-Credentials aus Logs.
- `app/lib/license/control-plane.ts`
  - konsumiert die versionierten Endpunkte fuer Claim, Token-Rotation,
    Preflight, Seat-Prepare/-Execute, Quote-Status, Snapshot und Refresh;
  - speichert Device-Code und Instanz-Token nur serverseitig;
  - aktiviert ein zurueckgeliefertes Zertifikat erst nach lokaler Pruefung.
- `app/lib/license/jwt.ts` und `app/lib/license/public-key.ts`
  - erzwingen RS256, `kid`, Issuer, Audience, Instance-Bindung, Status,
    Claims, Ablauf, maximal fuenf Minuten zukuenftige `iat`-Abweichung und
    monotone `entitlementsVersion`;
  - trennen Production- und Test-Keyset, Audience, Trust-Fingerprints,
    Cache-Namespace und persistierten Key-Cache;
  - lehnen Testzertifikate in einer Production-Runtime ab.
- `app/lib/license/storage.ts`
  - speichert Claim-, Token-, Refresh- und Zertifikatsdaten mit privaten
    Dateirechten;
  - verhindert Zertifikats-Rollback auf eine kleinere Entitlement-Version.
- `app/lib/license/refresh.ts`
  - implementiert periodischen Refresh, exponentiellen Backoff, Jitter und
    eine konfigurierbare Offline-Grace;
  - die Default-Grace von 24 Stunden gilt nur fuer kommerzielle Community-
    Team-Lizenzen, nicht fuer Test- oder Manual-Grants.
- `app/lib/license/team-license-lifecycle.ts`,
  `app/lib/license/team-seat-reconciliation.ts` und die Outbox-Pfade
  - suspendieren zusaetzliche Team-Mitglieder beim sicheren Solo-Fallback,
    widerrufen Sessions und bewahren Identitaeten, Workspaces und Dateien;
  - koennen einen spaeter wieder gueltigen Teamzustand wiederherstellen.
- `app/api/license/status/route.ts`,
  `app/components/license/TeamSeatHealthPanel.tsx` und
  `app/components/license/CommunityTeamConnectionPanel.tsx`
  - liefern bzw. zeigen den browser-sicheren Lizenzstatus;
  - zeigen fuer berechtigte Owner zusaetzlich Klasse, Environment, Seat-Limit,
    `observed|approved|billed|licensed`, Refresh, Grace und Recovery;
  - kennzeichnen Test und Manual als nicht abrechenbar.

Vorhandene Notebook-Tests decken bereits Teilvertraege ab, insbesondere:

- `scripts/team-seat-contract-test.ts` fuer die gemeinsamen Fixtures;
- `scripts/license-security-test.ts` fuer JWT, Claims, Clock-Skew,
  Environment und Entitlement-Rollback;
- `scripts/license-environment-isolation-test.ts` fuer getrennte Test- und
  Production-Keys/Audiences sowie einen simulierten Keywechsel;
- `scripts/community-license-claim-client-test.ts` fuer Claim-Secret-Schutz,
  Polling, Backoff, Token-Persistenz und Cancel;
- `scripts/community-license-refresh-test.ts` fuer Refresh, Backoff, Offline,
  Grace und terminale Tokenfehler;
- `scripts/team-control-plane-mock-integration-test.ts` fuer den versionierten
  HTTP-Client gegen einen Mock-Server;
- `scripts/team-seat-test-license-activation-test.ts` fuer Test-Seat-Erhoehung,
  `requires_action`, `payment_failed`, Ablauf, Widerruf und Datenbestand;
- die aggregierenden No-Stripe-, Community-Upgrade-, Paid-Activation-,
  Offline-Downgrade- und Release-Verifikationsskripte.

Diese Tests sind wertvoll, ersetzen aber keinen Lauf von Notebook und Control
Plane als getrennte reale Serverprozesse. Mehrere aggregierende E2E-Skripte
starten lediglich weitere In-Process- oder Mock-Skripte. Ausserdem referenziert
`scripts/team-seat-release-verification-test.ts` eine derzeit nicht vorhandene
Kompatibilitaets-/Owner-Dokumentation. Die Release-Kompatibilitaetsmatrix ist
damit im aktuellen Tree nicht belastbar abgeschlossen.

### Canvas Control Plane

Das lokal vorhandene Gegenrepository unter einem konfigurierbaren Repo-Pfad
(bei der Inventur `/Users/frankalexanderweber/Documents/canvas-control-plane`)
besitzt bereits:

- `packages/shared/fixtures/team-seat-protocol-v1.json` als kanonisches,
  bytegleiches Fixture;
- `apps/api/src/routes/license.ts` mit echten HTTP-Routen fuer Public Keys,
  Claim, Token-Rotation, Refresh, Preflight, Seat-Operationen, Snapshot,
  Token-Revocation und Admin-Grants;
- `apps/api/src/services/communityLicenseClaims.ts` mit gehashten Device- und
  Instanz-Tokens, Scopes, Polling-Limit, Replay-Schutz und Instance-Bindung;
- `apps/api/src/services/teamEntitlementGrants.ts`,
  `teamSeatGrantPolicy.ts` und `testLicenseSigning.ts` fuer serverseitige
  Test-/Manual-Grants, Allowlisten, TTL-/Seat-Grenzen und getrennte
  Signing-Keys/Audiences;
- `apps/api/src/services/teamSeatBilling.ts` und `teamSeatSnapshots.ts` fuer
  Quote, Authorization, Idempotenz, Snapshot-Revisionen und
  providerneutrale Seat-Operationen;
- `apps/api/src/services/licenses.ts` fuer die signierten v1-Claims und eine
  standardmaessig auf 900 Sekunden begrenzte Zertifikatslaufzeit bei Test- und
  Manual-Grants;
- `apps/api/src/services/teamSeatReconciliation.ts` und
  `teamSeatAlerts.ts` fuer Drift, Reissue, Retention und Recovery;
- `apps/api/src/services/managedSecrets.ts`, `agentConfig.ts` und
  `apps/api/src/sockets/agentHandler.ts` fuer den separaten Managed-VM-Pfad,
  in dem `CANVAS_LICENSE_CERT` und `CANVAS_INSTANCE_TOKEN` ueber Agent-
  Konfiguration in die VM gelangen;
- `packages/agent/src/ws-client.ts` fuer den authentifizierten WebSocket-
  Connect, Heartbeats, Versions-/Capability-Meldung und Config-Apply.

Das Control-Plane-Runbook `docs/team-seat-operations-runbook.md` dokumentiert
den entscheidenden offenen Nachweis ausdruecklich: Die No-Stripe-Abnahme laeuft
auf einer frisch migrierten PostgreSQL-Instanz und echten API-Routen, benoetigt
aber noch die Gegenpruefung in einer echten Canvas-Notebook-Test- und
Production-Runtime. Entsprechend bleiben `CP-TS-076`, `CP-TS-077` und
`CP-TS-078` formal offen. `CP-TS-020` und `CP-TS-022` enthalten implementierten
Teilfortschritt, bleiben wegen offener Abhaengigkeiten ebenfalls als `pending`
markiert. Ticket 11 darf diese Stati nicht pauschal auf abgeschlossen setzen,
sondern nur die durch den neuen Harness belegten Gates aktualisieren.

### VM-Agent und zwei getrennte Vertrauenspfade

Es existiert aktuell kein einzelner Dreier-Handshake, bei dem Community-
Lizenzclaims durch den VM-Agenten transportiert werden:

1. **Community-Pfad:** Notebook spricht direkt per versioniertem HTTP mit dem
   Control Plane. Der lokale Instanz-Token authentifiziert Claim-Folgeaktionen,
   Seat-Operationen, Snapshot und Refresh.
2. **Managed-/Cloud-Pfad:** Der VM-Agent authentifiziert sich separat per
   Agent-API-Key am WebSocket `/agent`, meldet Version/Health und wendet die vom
   Control Plane erzeugte Managed-Environment-Konfiguration mit
   `CANVAS_LICENSE_CERT` an.

Der E2E-Plan darf diese Grenzen nicht kuenstlich zu einem neuen Protokoll
vermischen. Er testet beide Pfade einzeln und prueft anschliessend ihren
gemeinsamen beobachtbaren Zustand in Control Plane, Agent und Notebook.

## Belegte Luecken und zu verifizierende Fehlerursachen

### Bereits belegt

1. **Kein echter Cross-Repo-Serverlauf:** Die vorhandenen Notebook-Tests nutzen
   Mock-Fetches oder In-Process-Ablaeufe; der Control-Plane-PostgreSQL-Harness
   startet keine echte Notebook-Runtime.
2. **Keine vollstaendige lokale Reproduktionsanweisung:** Ports, zwei
   Datenbanken, Schluesselgenerierung, Agent-Konfiguration, Fault Injection,
   Cleanup und Artefaktablage sind noch nicht als ein gemeinsamer Ablauf
   beschrieben.
3. **Keine abgeschlossene Kompatibilitaetsmatrix:** Protokollversion,
   Mindest-Notebook-Version, Control-Plane-API-Version und Agent-Version sind
   nicht in einem aktuellen, maschinenpruefbaren Release-Artefakt zusammen
   gefroren.
4. **Key-Rotation ist nur teilweise simuliert:** Das Notebook kann mehrere
   vertrauenswuerdige und bereits bekannte Keys cachen und bei unbekanntem
   `kid` neu laden. Die Control-Plane-Public-Key-Endpunkte liefern aktuell aber
   jeweils nur einen Key. Ein belastbares Ueberlappungsfenster fuer alten und
   neuen Key nach einem frischen Notebook-Start ist deshalb noch nicht
   repositoryuebergreifend belegt.
5. **Agent-Lizenzzustand ist indirekt:** Heartbeats enthalten Version,
   Runtime- und Healthdaten, aber keinen eigenstaendigen Community-
   Lizenzstatus. Uebereinstimmung darf daher im Community-Fall nur aus
   Control-Plane-Lizenz/Token/Snapshot, Notebook-Status und Agent-
   Erreichbarkeit abgeleitet werden. Ein neues Last-Seen-Modell gehoert in
   Ticket 13.

### Im Harness zu verifizieren, nicht vorweg als Ursache festzuschreiben

- ob Header, Body und Fehlerpayloads der echten Server exakt mit den
  bytegleichen Fixtures uebereinstimmen;
- ob Test-Grant-Ausstellung ueber die echte Admin-API ohne Stripe-Daten laeuft
  und keine Stripe-Tabellen/-IDs veraendert;
- ob Claim-Approval und Polling unter echten Prozessgrenzen das Token genau
  einmal im Klartext ausgeben;
- ob Refresh nach Prozessrestart denselben `licenseId`, `instanceId`,
  `seatLimit` und mindestens dieselbe `entitlementsVersion` ergibt;
- ob der Agent bei Managed-Konfiguration ein neues Zertifikat sicher und ohne
  Klartext in Logs/Diagnose anwendet und nach Restart wieder denselben Zustand
  meldet;
- ob kurzfristige Netztrennung tatsaechlich nur Backoff/Grace ausloest und
  Wiederverbindung ohne doppelten Seat- oder Grant-Effekt heilt;
- ob Grant-Widerruf, Token-Widerruf und Zertifikatsablauf fachlich klar
  verschiedene stabile Zustands- und Fehlercodes liefern;
- ob Features und Quotas im UI/API wirklich aus dem signierten Zertifikat und
  nicht aus lokalen Boolean-Environment-Variablen erweitert werden koennen;
- ob der derzeitige Clock-Skew-Grenzwert an den exakten Grenzen konsistent
  (`iat <= now + 300s`) interpretiert wird;
- ob ein echter Keywechsel mit Cache, Restart und Ueberlappungsfenster sicher
  funktioniert oder eine versionierte Multi-Key-Antwort erfordert.

## Verbindliche Architektur- und Sicherheitsentscheidungen

### 1. Der v1-Vertrag bleibt kanonisch

`packages/shared/fixtures/team-seat-protocol-v1.json` im Control Plane bleibt
Contract-Owner. Die Notebook-Kopie darf nur bytegleich aktualisiert werden.
Ein Test vergleicht SHA-256 und JSON-Semantik beider Dateien. Ein inkompatibles
Feld, geaenderte Semantik oder ein Breaking Error-Code erfordert
`canvas-team-seat-protocol-v2`; stilles Erweitern von v1 ist unzulaessig.
Additive Felder sind nur erlaubt, wenn beide Parser sie bewusst tolerieren und
die Kompatibilitaetsmatrix dies dokumentiert.

### 2. Der Server bleibt Autoritaet

- License-ID und Instance-ID stammen nach dem Claim aus Token-/Datenbankkontext.
- Price, Provider, Szenario, Billing-Summen und freigegebene Quantity werden
  nie aus dem Browser oder Notebook als autoritativ uebernommen.
- Das Test-Szenario stammt ausschliesslich aus dem persistierten Grant.
- Notebook-Boolean-Flags koennen signierte Features, Edition oder Seat-Limit
  nicht erweitern.
- Der Agent transportiert Managed-Konfiguration, entscheidet aber nicht ueber
  Lizenzklasse, Entitlements oder Seats.

### 3. Development-Testlizenzen sind echte, begrenzte Grants

Der Harness verwendet den vorhandenen `test`-Provider und die echte Admin-API,
keinen Test-Bypass und keine direkte Datenbankmanipulation zur Freischaltung.
Verbindliche Testkonfiguration:

- `NODE_ENV` und `TEAM_SEAT_CONTROL_PLANE_ENVIRONMENT` nichtproduktiv;
- `TEAM_SEAT_TEST_GRANTS_ENABLED=true` nur im isolierten Prozess;
- separate Allowlisten fuer Grant-Admin und Ziel-User-ID;
- maximal fuer das Szenario benoetigte Seats, im Regelfall 3;
- kurze Grant-Laufzeit und kurze Zertifikats-TTL;
- separater RSA-Test-Key, separater `kid`, Audience
  `canvas-notebook-test` und getrennte Trust-Fingerprints;
- `BILLING_MODE=disabled`, keine Stripe-Variablen und alle kommerziellen
  Rollout-Flags `false` fuer den verpflichtenden No-Stripe-Lauf;
- sichtbare Kennzeichnung `test`, `nonBillable=true`, `provider=test`,
  `billedQuantity=0` und vorhandene `grantId`.

Eine als `production` gestartete Notebook-Runtime wird spaeter sequenziell auf
dem einzigen erlaubten Notebook-Port `localhost:3000` gestartet und muss das
identische Testzertifikat mit `LICENSE_CERT_ENVIRONMENT_INVALID` ablehnen.
Test- und Production-Runtime laufen niemals gleichzeitig.

### 4. Keine produktiven Netz- oder Secret-Abhaengigkeiten

- Alle Server binden ausschliesslich an `127.0.0.1`.
- Control-Plane-URL, Web-URL und Agent-WebSocket zeigen ausschliesslich auf die
  lokale Testumgebung.
- DNS-/Host-Allowlist und ein Start-Preflight brechen ab, sobald eine URL nicht
  loopback ist oder eine bekannte Produktionsdomain enthaelt.
- Produktions-`.env`-Dateien werden weder geladen noch kopiert.
- Der Harness baut fuer jeden Kindprozess eine explizite Env-Allowlist auf;
  geerbte Shell-Variablen werden nicht ungeprueft weitergereicht.
- Alle Testsecrets und Keys entstehen pro Run unter einem `mktemp`-Verzeichnis
  mit Verzeichnisrecht `0700` und Dateirecht `0600`.
- Logs speichern nur Prefix/Fingerprint/IDs; Device-Code, Instanz-Token,
  Zertifikat, private Keys, Passwoerter und Member-Hashes werden nach dem Lauf
  zusaetzlich durch einen Secret-Scanner ausgeschlossen.
- Der Bericht darf nur redigierte IDs, Hashes, Zeitpunkte, erwartete/effektive
  Stati und Testresultate enthalten.

### 5. Zeit und Netzwerk werden kontrolliert, nicht global manipuliert

- Kein Test aendert die Host-Systemzeit.
- Unit-/Service-Tests nutzen vorhandene `now`-Parameter oder eine injizierbare
  Clock-Abhaengigkeit ohne Environment- oder HTTP-Bypass.
- Prozessuebergreifende Ablaufpruefungen verwenden kurze, explizite TTLs und
  bounded polling mit hartem Gesamt-Timeout; keine langen Sleeps.
- Netzwerkfehler werden ueber einen kleinen lokalen TCP/HTTP-Fault-Proxy als
  Hostprozess erzeugt. Er kann Verbindungen blockieren, Antworten verzoegern
  oder abbrechen, ohne externe Dienste oder einen weiteren Container.
- Jede Fault-Phase besitzt einen deterministischen Restore-Schritt und eine
  abschliessende Wiederverbindungspruefung.

## Isolierte lokale Testumgebung

### Topologie und feste Ports

| Komponente | Bindung | Persistenz | Zweck |
| --- | --- | --- | --- |
| Canvas Notebook | `127.0.0.1:3000` | `$RUN_ROOT/notebook-data` | einzige Notebook-Runtime; Team-UI, lokale DB und Lizenzdurchsetzung |
| Control Plane API | `127.0.0.1:4001` | DB `ticket11_cp_<runId>` | echte `/v1/license/*`- und `/agent`-Schnittstellen |
| Control Plane Web | `127.0.0.1:4004` | keine eigene | Claim- und Grant-/Status-UI |
| Fault Proxy | `127.0.0.1:4101` | keine | Notebook zeigt auf Proxy; Proxy leitet kontrolliert an API `4001` weiter |
| PostgreSQL | `127.0.0.1:55411` | ephemeres Volume | ein Test-DB-Prozess mit getrennten CP- und Notebook-Datenbanken |
| VM-Agent | ausgehend zu `ws://127.0.0.1:4001/agent` | `$RUN_ROOT/agent` | echter Agent-Connect, Heartbeat, Version und Managed-Config-Nachweis |

Port `3001` bleibt unberuehrt. Die Ports werden nicht automatisch verschoben:
Ein Preflight prueft alle Bindungen und bricht mit einer klaren Meldung ab,
wenn ein Port belegt ist. Dadurch bleibt der Lauf reproduzierbar und startet
keinen zweiten Notebook-Server.

### Prozess- und Container-Modell

Um die Repository-Regel zu erfuellen, laufen Notebook, Control-Plane-API,
Control-Plane-Web, Fault Proxy und Agent als explizit getrackte Hostprozesse.
Nur PostgreSQL wird, nach ausdruecklicher Containerfreigabe und nach den Builds
beider geaenderter Web-/Server-Repositories, als ein einzelner frischer
Test-Container gestartet. Der Container verwendet ein eindeutiges Label,
einen eindeutigen Namen und ein ephemeres Volume. Ein globaler Lock sowie ein
Preflight auf vorhandene Ticket-11-Container verhindern parallele Testlaeufe.

Falls spaeter nachgewiesen wird, dass der Managed-Agent-Config-Apply zwingend
eine echte Notebook-Container-Runtime benoetigt, wird diese Erweiterung nicht
stillschweigend vorgenommen. Sie benoetigt eine gesonderte Freigabe und ersetzt
das obige Prozessmodell in einer eigenen seriellen Phase; es werden niemals
zwei Ticket-11-Teststacks parallel betrieben.

### Datenbanken und Testdaten

Ein Bootstrap legt im einen PostgreSQL-Prozess mindestens zwei getrennte
Datenbanken und Rollen an:

- `ticket11_cp_<runId>` fuer die Control Plane;
- `ticket11_nb_<runId>` fuer Canvas Notebook und pgvector-Team-Readiness.

Die Datenbank-URLs werden nur in den privaten Run-Env-Dateien abgelegt. Der
Harness fuehrt die normalen Better-Auth-/Drizzle-Migrationen beider
Repositories aus, seedet einen eindeutig markierten Plattform-Admin, eine
Billing-Organization, einen lokalen Notebook-Owner und maximal zwei weitere
Testmitglieder. Test-E-Mails verwenden reservierte `.test`-Domains. Jeder
Datensatz traegt, soweit das Schema Metadata erlaubt, `ticket11:<runId>`.
Lizenz- und Grant-Ausstellung erfolgen danach ausschliesslich ueber echte
Services/API-Routen.

### Startreihenfolge

1. Repo-Pfade, saubere/erwartete Revisionen, Tools, Ports, Loopback-URLs,
   Container-Lock und fehlende Stripe-/Produktionsvariablen pruefen.
2. Ephemeren Run-Ordner und zwei getrennte Signing-Keypaare erzeugen.
3. In beiden geaenderten Repositories die vorgeschriebenen statischen Tests
   und Builds abschliessen.
4. Nach expliziter Freigabe genau einen frischen PostgreSQL-Testcontainer
   starten, Readiness abwarten, beide Datenbanken anlegen und migrieren.
5. Control Plane API und Web mit expliziter Test-Env starten und deren Health
   pruefen.
6. Fault Proxy im Durchleitungsmodus starten.
7. Notebook auf `localhost:3000` mit eigenem `DATA`, eigener DB und lokalen
   Public Keys starten; Bootstrap-Admin aus der lokalen Test-Env verwenden.
8. VM-Agent mit eigener Testkonfiguration und lokalem Agent-API-Key starten;
   ersten authentifizierten Heartbeat und Versionen abwarten.
9. Testmatrix strikt sequenziell ausfuehren und pro Fall redigierte Ergebnisse
   erfassen.
10. Alle Hostprozesse per PID/Process-Group beenden, DBs/Volume/Container
    entfernen, Run-Secrets vernichten und Ports/Prozesse/Container nachpruefen.

Jeder Startschritt besitzt einen Health-Timeout. Scheitert ein Schritt, wird
sofort derselbe idempotente Cleanup-Pfad ausgefuehrt; nachfolgende Szenarien
starten nicht.

## Daten- und API-Vertraege

### Gemeinsame Request-Metadaten

Alle versionierten Notebook-Requests tragen:

| Element | Wert/Regel |
| --- | --- |
| Protocol Header | `X-Canvas-Team-Seat-Protocol: canvas-team-seat-protocol-v1` |
| Operation Header | stabile UUID je fachlicher Mutation; Retry verwendet dieselbe ID |
| Version Header | reale Canvas-Notebook-Paketversion |
| Authorization | `Bearer <instanceToken>` nur nach Claim und nur fuer erlaubten Scope |
| Body | ebenfalls `protocolVersion`, sofern der vorhandene Vertrag dies vorsieht |
| Cache | `no-store` fuer Lizenz-/Statusoperationen |

Ein fehlender/falscher Header, v2-Body gegen v1 oder eine Header-/Body-
Abweichung muss mit stabilem `TEAM_SEAT_PROTOCOL_UNSUPPORTED` bzw.
`TEAM_SEAT_INVALID_REQUEST` scheitern und darf keine Mutation erzeugen.

### Zu pruefende HTTP-Operationen

| Phase | Notebook -> Control Plane | Autorisierung | Kernaussage |
| --- | --- | --- | --- |
| Public Key | `GET /v1/license/public-key` und `/test` | keine | getrennte, vertrauenswuerdige Keysets |
| Claim Start | `POST /v1/license/claim/v1/start` | aktives Zertifikat im Body | kurzlebiger Device-/User-Code, noch kein Token |
| Claim Preview/Approve | `/v1/license/claim/v1/preview`, `/approve` | verifizierter CP-User/Owner | Browser sieht kein Device- oder Instanz-Token |
| Claim Poll | `POST /v1/license/claim/v1/poll` | Device-Code | Token genau einmal, danach Replay-Ablehnung |
| Token Rotation | `POST /v1/license/community/v1/token/rotate` | `token:rotate` | altes Token sofort ungueltig |
| Preflight | `POST /v1/license/community/v1/team/preflight` | `seat:prepare` | Version, Postgres, Claim und Rollout ohne Mutation |
| Seat Prepare | `POST /v1/license/community/v1/seats/prepare` | `seat:prepare` | serverseitige Quote/Authorization |
| Quote Status | `GET /v1/license/community/v1/seats/quotes/:id` | `seat:prepare` | unveraenderte serverseitige Quote |
| Seat Execute | `POST /v1/license/community/v1/seats/execute` | `seat:execute` | idempotente Operation, ggf. neues Zertifikat |
| Snapshot | `POST /v1/license/community/v1/seats/snapshot` | `seat:snapshot` | monotone Revision, Hash, Drift und Replay |
| Refresh | `POST /v1/license/community/v1/refresh` | `license:refresh` | gleiches Subject, monotone Entitlements |
| Token Revoke | bestehender authentifizierter Adminpfad | Owner/Plattform-Admin | Audit-Grund, Request-ID, sofortige Ablehnung |
| Grant Lifecycle | `/v1/license/admin/team-grants*` | allowlisteter Plattform-Admin | Preview/Create/Update/Revoke ohne Stripe |

Responses werden sowohl gegen die Typ-Parser als auch gegen die gemeinsamen
Fixtures geprueft. Fehlerresponses enthalten mindestens `error`, stabilen
`code` und korrektes `retryable`; Secrets duerfen weder in Body noch Headern,
Logs oder Testreport erscheinen.

### Signierter Lizenzvertrag

Fuer moderne Zertifikate werden mindestens folgende Claims exakt verglichen:

```text
iss=canvas-control-plane
aud=canvas-notebook | canvas-notebook-test
sub=instanceId
protocolVersion=canvas-team-seat-protocol-v1
licenseId, instanceId
hostingMode=community|cloud
edition=solo|team
licenseClass=commercial|manual|test
licenseEnvironment=development|test|staging|production
provider=stripe|manual|test|disabled
seatLimit >= 1
entitlementsVersion >= 0
features, quotas, capabilities
grantId nur bei manual|test
nonBillable=false bei commercial, true bei manual|test
iat, exp, kid
```

Zusaetzliche Konsistenzregeln:

- `community` verwendet Plan `community`, `cloud` Plan `managed`;
- `solo` hat exakt `seatLimit=1`;
- `test` benoetigt Test-Key, Test-Audience, nichtproduktives exakt passendes
  Environment, `provider=test` und eine aktive `grantId`;
- `manual` verwendet Production-Key/-Audience, `provider=manual`,
  `nonBillable=true` und eine aktive `grantId`;
- `commercial` hat keine `grantId`, ist abrechenbar und darf nicht auf
  `manual|test` zeigen;
- ein Zertifikat mit niedrigerer `entitlementsVersion` ersetzt niemals den
  lokal gespeicherten Stand.

### Agent-Vertrag

Der reale Agent verbindet sich mit einem ausschliesslich fuer den Test
erzeugten Agent-API-Key an `/agent`, meldet mindestens Agent-, Notebook-CLI-
und Canvas-Version, Capabilities, Runtime und Health. Fuer Managed-Szenarien
wird zusaetzlich geprueft:

- das Control Plane erzeugt `CANVAS_INSTANCE_TOKEN` und
  `CANVAS_LICENSE_CERT` serverseitig;
- Agent-Config und Diagnose melden nur `hasManagedToken`/`hasLicenseCert`, nie
  die Werte;
- Config-Apply ist versionsgegated und idempotent;
- nach Agent- und Notebook-Restart stimmen Control-Plane-Entitlements und der
  vom Notebook verifizierte Lizenzstatus weiterhin ueberein.

Community-Claims werden nicht ueber den Agenten umgeleitet. Dort lautet das
Abnahmekriterium: Agent ist authentifiziert/online, waehrend Notebook und
Control Plane den Community-Lizenzstatus direkt synchronisieren.

## Lizenztyp- und Zustandsmatrix

Die Matrix trennt Produktvariante, Lizenzklasse, Provider und Laufzeitstatus.
Nicht jede mathematische Kombination ist erlaubt; unzulaessige Kombinationen
werden als Negativfall getestet.

| ID | Variante / Klasse | Provider / Env | Erwartete Claims | Seats, Features, Quotas und UI |
| --- | --- | --- | --- | --- |
| L1 | Unregistriert | disabled / production | kein gueltiges Zertifikat | Core nutzbar, Team aus, ein lokaler User, Aktivierungs-UI |
| L2 | Community Solo commercial | disabled / production | community, solo, commercial, seat 1 | keine Team-Features; Claim optional; Community-Status aktiv |
| L3 | Community Team test | test / development | community, team, test, grantId, nonBillable | `seatLimit=3`, Team-Features an, `billed=0`, TEST/NON-BILLABLE sichtbar |
| L4 | Community Team manual | manual / staging oder production | community, team, manual, grantId, nonBillable | Seat-Limit aus Grant, Manual-Banner, keine Stripe-IDs |
| L5 | Community Team commercial | stripe / production | community, team, commercial | nur wenn kommerzielles Rollout freigegeben; sonst stabiler Feature-Blocker ohne Mutation |
| L6 | Cloud Solo commercial | disabled/Stripe / production | cloud, solo, commercial, seat 1 | Managed-Env ueber Agent, keine Team-Features |
| L7 | Cloud Team test/manual | test oder manual / nichtproduktiv | cloud, team, passende Klasse | Agent transportiert Zertifikat; Seats/Features wie Grant; nicht abrechenbar |
| L8 | Cloud Team commercial | stripe / production | cloud, team, commercial | Mixed-Item/Agent-Pfad; bis CP-TS-075 getrenntes Release-Gate |

Fuer jede positive Zeile werden mindestens folgende Auswirkungen erfasst:

- `licensed`, `licenseState`, Hosting, Edition, Klasse und Environment;
- signiertes `seatLimit`, Quota `users` und Feature-/Capability-Menge;
- lokaler Owner, offene Einladung, aktives Mitglied und blockiertes
  zusaetzliches Mitglied;
- Workspace-Sichtbarkeit und Erhalt beim Fallback;
- `observed`, `approved`, `billed`, `licensed` und Entitlement-Version;
- Owner-UI, oeffentlicher Status und Mobile-Status ohne Secret-Leak;
- Control-Plane-Admin-/Owner-Ansicht und Agent-Diagnose.

### Zustandsuebergaenge

| ID | Ausgang -> Ereignis -> Ziel | Erwarteter Nachweis |
| --- | --- | --- |
| S1 | unregistered -> register/activate -> Community Solo | signiertes Production-Zertifikat, Seat 1, keine Teamfreigabe |
| S2 | Solo -> Claim pending/approve/poll -> connected | Token einmalig; Owner/Instance gebunden; Browser secretfrei |
| S3 | connected -> Test-Grant -> Team Test | neues Testzertifikat, hoehere Entitlement-Version, `billed=0` |
| S4 | Team Test seat 1 -> prepare/execute -> seat 2 | User erst nach signiertem hoeherem Limit aktiv |
| S5 | `requires_action` oder `payment_failed` | kein neuer aktiver User, kein hoeheres lizenziertes Limit |
| S6 | identischer Execute-Retry | gleiche Operation/Antwort, keine Doppelaktivierung |
| S7 | gleiche Operation-ID mit anderem Payload | stabiler Replay-/Idempotency-Konflikt, keine Mutation |
| S8 | Snapshot gleiche Revision/gleicher Hash | `replayed=true`; keine doppelte Reconciliation |
| S9 | Snapshot gleiche Revision/anderer Hash oder rueckwaerts | Konflikt/stale, keine Mengenmutation |
| S10 | Token rotate | neues Token aktiv; altes Token sofort `TEAM_SEAT_TOKEN_INVALID` |
| S11 | Control Plane kurz offline | Retry/Backoff; signiertes Zertifikat bleibt bis Ablauf nutzbar |
| S12 | Reconnect vor Ablauf | Refresh heilt; IDs, Seat-Limit und Version bleiben konsistent |
| S13 | kommerzielle Team-Lizenz offline ueber Grace | `grace` -> Solo-Fallback; zusaetzliche User suspendiert, Daten erhalten |
| S14 | Test-/Manual-Grant abgelaufen | kein kommerzieller Grace-Bypass; signierter Solo-Fallback |
| S15 | Grant widerrufen | sofortiger Reissue-Versuch, danach Solo; Daten/Identitaeten erhalten |
| S16 | Instanz-Token widerrufen | Refresh/Seat/Snapshot abgelehnt; Reconnect erforderlich; bestehendes Zertifikat nur bis eigener Grenze |
| S17 | Team wieder gueltig | suspendierte Memberships kontrolliert restauriert; kein neuer Datensatz |
| S18 | Agent oder Notebook Restart | Control Plane, Agent und Notebook konvergieren auf denselben Status |

### Security-Negativmatrix

Mindestens folgende Faelle sind automatisiert und ohne Produktivzugriff zu
belegen:

- falsche Signatur, Algorithmus, Issuer, Audience, `kid` oder Fingerprint;
- Testzertifikat mit Production-Key oder Production-Audience;
- Testzertifikat in Production-Runtime, auch wenn der Request ein anderes
  Environment behauptet;
- identischer Test- und Production-Key bzw. identische Audience;
- falsche Instance-ID/Subject, License-ID oder Grant-Bindung;
- abgelaufenes Zertifikat, `iat` mehr als 300 Sekunden in der Zukunft sowie
  exakte Grenzwerte 299/300/301 Sekunden;
- `seatLimit=0`, Bruchzahl, Solo mit Seat-Limit > 1, fehlende `grantId`,
  inkonsistenter Provider oder `nonBillable`;
- niedrigere `entitlementsVersion` nach bereits aktiviertem neueren Stand;
- fehlender/falscher Token-Scope, altes rotiertes Token, widerrufenes Token;
- Claim-Code-Bruteforce/Polling vor Intervall, abgelaufener oder konsumierter
  Claim;
- manipulierte Quote, fremde Authorization, stale Quote, abgelaufene
  Authorization und Idempotency-Payload-Mismatch;
- Snapshot fuer fremde Instanz, doppelte Member-Hashes, falscher Hash,
  Zukunftszeit und ruecklaeufige Revision;
- clientseitiger Versuch, Provider, Test-Szenario, Price, billed Quantity oder
  Environment festzulegen;
- Logs, Responses, Screenshots und Report enthalten keine Testsecrets;
- keine Stripe-Variablen, Stripe-IDs, Customers, Subscriptions, Items,
  Checkout-Sessions oder Invoices im No-Stripe-Lauf.

### Key-Rotation

Key-Rotation wird als eigener sequenzieller Testblock ausgefuehrt:

1. Zertifikat mit Key A aktivieren und A als vertrauenswuerdig persistieren.
2. Key B zusaetzlich freigeben, Control Plane auf B als aktuellen Signer
   wechseln und ein Zertifikat mit unbekanntem `kid=B` refreshen.
3. Notebook erzwingt einen frischen Key-Abruf und akzeptiert B nur bei
   vorab erlaubtem Fingerprint und korrektem Keyset.
4. Prozessrestart: waehrend des Ueberlappungsfensters muessen Zertifikate A und
   B weiterhin gemaess definierter Policy pruefbar sein.
5. Nach Ablauf aller mit A signierten Zertifikate A aus dem Trustset entfernen;
   A wird danach stabil abgelehnt, B bleibt aktiv.
6. Derselbe Ablauf wird getrennt fuer Test- und Production-Keyset geprueft;
   ein Cross-Keyset-`kid` bleibt ungueltig.

Vor Phase 4 wird entschieden, wie das Ueberlappungsfenster im echten Vertrag
repraesentiert wird. Bevorzugt wird eine additive, versionierte Keyset-Antwort
mit aktuellem und vorherigem Public Key bei unveraendert strikter
Fingerprint-Allowlist. Falls v1 diese Antwort nicht kompatibel aufnehmen kann,
ist eine neue Route oder Protokollversion erforderlich. Nur der lokale Cache
eines bereits laufenden Notebooks ist kein ausreichender Rotation-Nachweis.

## Strikt sequenzielle Implementierungsphasen und Commits

### Phase 1: Cross-Repo-Contract und Kompatibilitaet einfrieren

**Canvas Control Plane**

- kanonisches Fixture, API-Paketversion, Agent-Version und vorhandene
  Mindest-Notebook-Version in ein maschinenlesbares Kompatibilitaetsmanifest
  aufnehmen;
- Contract-Test um SHA-/Schema-Export fuer das Gegenrepository erweitern;
- offene Statusangaben in Architektur/Todo nur anhand belegter Tests
  korrigieren.

**Canvas Notebook**

- bytegleichen Fixture-Vergleich gegen einen konfigurierbaren
  `CANVAS_CONTROL_PLANE_REPO`-Pfad implementieren;
- `scripts/team-seat-release-verification-test.ts` auf ein tatsaechlich
  versioniertes Kompatibilitaetsdokument/-manifest ausrichten;
- fehlende npm-Testskripte fuer die spaetere Harness-Gruppe registrieren.

**Gate**

- beide Fixture-Parser, SHA-Vergleich und Versionsmatrix sind gruen;
- ein absichtlich veraendertes Fixture oder eine ununterstuetzte
  Protokollversion faellt mit klarer Meldung durch.

**Fokussierte Commits**

- Control Plane: `Freeze Team Seat compatibility contract`
- Notebook: `Verify cross-repository license contract`

### Phase 2: Reproduzierbaren Harness und sicheren Lifecycle bauen

**Canvas Notebook als Harness-Owner**

- einen kleinen TypeScript-/Shell-Orchestrator unter `scripts/` anlegen, der
  Repo-Pfad, Tools, Ports, Loopback, Secret-Isolation und Parallel-Lock prueft;
- Run-Root, PID-Datei, Prozessgruppen, redigierte Logs und idempotenten Cleanup
  verwalten;
- feste Start-/Stop-/Status-Kommandos und ein `--plan`/Preflight ohne
  Mutation anbieten;
- Fault Proxy und Secret-Scanner als test-only Hilfen bereitstellen;
- Testreport als JSON plus kurze Markdown-Zusammenfassung erzeugen, aber
  Run-Secrets und volatile Reports nicht committen.

**Canvas Control Plane**

- dokumentierte Test-Env-Vorlage ohne Werte bereitstellen;
- Migration/Seed so kapseln, dass der Harness normale Services und echte
  Grant-/Claim-APIs nutzen kann;
- Agent-Testkonfiguration mit neuem API-Key und ohne Produktions-VM anlegen.

**Gate**

- Preflight erkennt belegte Ports, fremde URLs, Stripe-Variablen, fehlende
  Tools und vorhandenen Ticket-11-Lock;
- ein absichtlich abgebrochener Start hinterlaesst keine Prozesse, Ports,
  Container, Volumes, Datenbanken oder Klartextsecrets.

**Fokussierte Commits**

- Control Plane: `Prepare isolated license handshake fixtures`
- Notebook: `Add isolated license handshake harness`

### Phase 3: Echte Development-Testlizenz und No-Stripe-Flow

**Canvas Control Plane**

- Admin-Readiness ueber echte API pruefen;
- Test-Grant per Preview/Create mit stabiler Request-ID, Grund, Ziel-User,
  Instance, Environment, Seat-Limit und kurzer TTL ausgeben;
- vor/nach dem Lauf Datenbankinvarianten fuer `billed=0`, fehlende Stripe-IDs
  und Audit-Events pruefen;
- `success`, `requires_action`, `payment_failed`, `past_due` und `canceled`
  nur ueber Grant-Updates setzen.

**Canvas Notebook**

- echten Register/Activate/Claim/Poll-/Token-Flow ausfuehren;
- Testzertifikat aktivieren, sichtbare Owner-Health und Seat-Limit pruefen;
- User-Aktivierung erst nach hoeherem signiertem Limit bestaetigen;
- Production-Runtime sequenziell auf Port 3000 starten und dasselbe
  Testzertifikat negativ pruefen.

**Gate**

- L1 bis L4 und S1 bis S7 bestehen;
- keine Stripe-Konfiguration oder -Persistenz ist vorhanden;
- Teststatus ist in API und Owner-UI eindeutig, aber Secrets bleiben verborgen.

**Fokussierte Commits**

- Control Plane: `Exercise non-billable development licenses`
- Notebook: `Cover real test license activation flow`

### Phase 4: Versionierter Handshake, Replay und Key-Rotation haerten

Zuerst werden die echten negativen Tests geschrieben. Nur belegte
Inkompatibilitaeten werden danach im jeweils verantwortlichen Repository
behoben.

- Header-/Body-Protokollabgleich, Scopes, Operation-ID-Fingerprint,
  Claim-Replay, Snapshot-Revision und Entitlement-Rollback testen;
- exakte Clock-Skew-/Expiry-Grenzen testen;
- Public-Key-Rotation A -> A+B -> B und Prozessrestart pruefen;
- falls noetig, Control-Plane-Keyset-Antwort und Notebook-Parser additiv
  versionieren, mit getrennten Test-/Production-Keysets und maximalem
  Ueberlappungsfenster;
- alte Keys erst nach maximaler Zertifikatslaufzeit und dokumentiertem
  Rollout entfernen.

**Gate**

- alle Security-Negativfaelle mutieren weder License, Grant, Seat noch Token;
- ein identischer Retry ist idempotent, ein abweichender Replay scheitert;
- Key-Rotation funktioniert auch nach frischem Notebook-Prozess und faellt
  bei Cross-Keyset oder nicht allowlistetem Fingerprint geschlossen aus.

**Fokussierte Commits**

- ein Contract-/Rotation-Commit pro betroffenem Repository, zum Beispiel
  `Support overlapping license signing keys` und
  `Verify rotated license keysets`;
- keine Vermischung mit Ablauf-/UI-Aenderungen.

### Phase 5: Offline, Timeout, Ablauf, Widerruf und Wiederverbindung

- Fault Proxy zunaechst kurz blockieren und Retry/Backoff pruefen;
- Verbindung vor Zertifikatsablauf wiederherstellen und Konvergenz pruefen;
- Test-/Manual-Ablauf ohne kommerzielle Grace pruefen;
- kommerzielle Community-Team-Grace separat mit kurzer Testpolicy pruefen;
- Grant- und Token-Widerruf getrennt ausfuehren;
- Solo-Fallback, suspendierte zusaetzliche User, widerrufene Sessions und
  erhaltene Workspace-Dateien pruefen;
- Grant/Verbindung erneut herstellen und kontrollierte Reaktivierung pruefen;
- keine Systemzeit aendern und jeden Poll/Retry hart begrenzen.

**Gate**

- S8 bis S17 bestehen;
- kein Fallback loescht Identitaet, Workspace oder Datei;
- keine Wiederverbindung erzeugt doppelten Grant, Token, Seat oder Member.

**Fokussierte Commits**

- Control Plane: `Cover license revocation and reconnect recovery`
- Notebook: `Verify offline license lifecycle end to end`

### Phase 6: VM-Agent und Restart-Konvergenz

- echten Agenten mit Test-API-Key verbinden und ersten Heartbeat abwarten;
- Agent-, Control-Plane- und Notebook-Version gegen das Manifest pruefen;
- Community-Pfad: Agent online halten, waehrend Claim/Refresh/Snapshot direkt
  zwischen Notebook und Control Plane laufen;
- Managed-Test-/Manual-Pfad: vorhandenen Managed-Env-/Config-Apply-Vertrag
  pruefen, ohne Secrets in Diagnose oder Logs;
- Agent, Notebook und Control Plane nacheinander neu starten und nach jedem
  Restart Konvergenz auf License-ID, Instance-ID, Edition, Seat-Limit,
  Entitlement-Version und Health pruefen;
- kein neues Last-Seen-Produktverhalten implementieren; fehlende
  Aktivitaetssemantik als Input fuer Ticket 13 dokumentieren.

**Gate**

- S18 besteht fuer den Community-Pfad und, soweit der vorhandene sichere
  Agent-Prozessmodus es erlaubt, fuer Managed-Test/Manual;
- Agent-Diagnose zeigt nur Vorhandensein/Version/Fingerprint-Metadaten;
- verlorene WebSocket-Verbindung veraendert keine Lizenz- oder Seat-Autoritaet.

**Fokussierte Commits**

- Control Plane/Agent: `Verify agent license state convergence`
- Notebook nur bei erforderlicher Gegenpruefung: `Assert license state after restart`

### Phase 7: UI-Abnahme, Dokumentation und Ticketabschluss

- automatisierte API-/DOM-nahe UI-Tests fuer Banner, Seat-Zahlen, Grace,
  Reconnect und serverseitige Blocker ausfuehren;
- nach ausdruecklicher Browser-/Playwright-Freigabe auf `localhost:3000`
  manuell bzw. per E2E den Claim-, Test-Grant-, Seat-, Offline- und
  Reconnect-Flow pruefen; kein zweiter Dev-Server und keine Nutzung von Port
  3001;
- Control-Plane-UI auf `localhost:4004` fuer Grant-Preview, TEST/NON-BILLABLE,
  Audit-Grund und Revocation pruefen;
- finalen redigierten Beispielreport, Kompatibilitaetsmatrix, Runbook,
  Cleanup-Anleitung und bekannte offene kommerzielle Gates dokumentieren;
- nur erfolgreich belegte Todo-/Ticketstati aktualisieren;
- erst danach Ticket 11 und den Index auf `erledigt` setzen.

**Gate**

- alle automatisierten und freigegebenen manuellen Kriterien unten sind
  erfuellt;
- Builds, Cleanup-Audit und Secret-Scan sind gruen;
- jedes Repository besitzt eigene fokussierte Commits.

**Abschlusscommits**

- Control Plane: `Document license handshake release evidence`
- Notebook: `Complete license handshake validation ticket`

## Automatisierte Abnahmekriterien

### Vor jedem prozessuebergreifenden Lauf

- Notebook: relevante Lizenz-/Team-Seat-Tests, `npm run lint` fuer betroffene
  Dateien und `npm run build`;
- Control Plane: relevante API-/Agent-Tests, `npm run typecheck` und
  `npm run build`;
- vor jedem Container-Test muessen die Builds beider geaenderter Web-/Server-
  Repositories erfolgreich sein;
- der Harness verweigert parallele Ticket-11-Laeufe und laedt niemals einen
  alten Container/Prozesszustand weiter.

### Contract und Security

- beide Fixtures sind bytegleich und werden von beiden Parsern akzeptiert;
- v2/falsche Version, falsche Claims und alle Security-Negativfaelle werden
  mit stabilen Codes abgelehnt;
- Production lehnt das echte Development-Testzertifikat ab;
- Test- und Production-Key/-Audience sind kryptografisch getrennt;
- Rotation, unbekanntes `kid`, Ueberlappung, Restart und Key-Entfernung sind
  reproduzierbar;
- Logs und Report bestehen den Secret-Scan.

### Fachlicher E2E-Nachweis

- Register/Activate, Claim, Poll, Token-Rotation, Preflight, Snapshot, Quote,
  Authorization, Execute und Refresh laufen ueber echte Servergrenzen;
- Community Solo, Community Team Test/Manual, abgelaufen, widerrufen, offline
  und wiederverbunden liefern die erwarteten Claims und Wirkungen;
- `success` aktiviert den zusaetzlichen User erst nach hoeherem signiertem
  Seat-Limit;
- `requires_action`, `payment_failed`, `past_due` und `canceled` aktivieren
  keinen unbezahlten User;
- Replay und Restart erzeugen keine Doppelmutation;
- Fallback suspendiert statt zu loeschen und Reaktivierung verwendet dieselben
  Identitaeten/Workspaces;
- Control Plane, Notebook und Agent konvergieren nach Refresh und Restart;
- der No-Stripe-Lauf erzeugt nachweislich keinerlei Stripe-Objekte.

### Cleanup und Reproduzierbarkeit

- `finally`/Trap-Cleanup laeuft bei Erfolg, Assertion-Fehler, Signal und
  Startup-Timeout;
- danach lauscht keiner der reservierten Ports;
- keine PID/Process-Group, kein Ticket-11-Container, kein Volume und keine
  Testdatenbank bleibt bestehen;
- der Run-Root mit privaten Keys und Secrets ist entfernt;
- ein zweiter Lauf auf demselben Commit erzeugt dieselben fachlichen
  Resultate, abgesehen von dokumentierten Run-IDs, Zufallssecrets und Zeiten;
- der Report nennt beide Commit-SHAs, Paket-/Protokollversionen,
  Konfigurationshashes und jede Matrix-ID.

## Manuelle Abnahmekriterien

Browser-/Playwright-Schritte erfolgen nur nach ausdruecklicher Freigabe.
Danach wird mit den lokalen Bootstrap-Admin-Credentials geprueft:

1. Community Solo zeigt Core-Nutzung ohne Teamfreigabe.
2. Claim zeigt nur User-Code/Verification-URL; Device-Code und Token erscheinen
   weder in Notebook- noch Control-Plane-Browserdaten.
3. Die Control-Plane-Preview zeigt exakt License-ID, Instance-ID, Environment,
   Seat-Limit, Ablauf, Grund und `Nicht abrechenbar / Test`.
4. Nach Test-Grant und Refresh zeigt die Notebook-Owner-Ansicht TEST LICENSE,
   NON-BILLABLE, korrektes Seat-Limit, Klasse, Environment und Sync-Zahlen.
5. Ein zusaetzlicher User bleibt vor Seat-Execute pending/blockiert und wird
   erst nach hoeherem Zertifikat aktiv.
6. `requires_action`/`payment_failed` zeigen einen stabilen handlungsfaehigen
   Zustand ohne aktiven User.
7. Offline zeigt Backoff/Grace und keine falsche Erfolgsmeldung; Reconnect
   stellt den konsistenten Zustand wieder her.
8. Grant-Widerruf und Ablauf fuehren sichtbar zum Solo-Fallback, waehrend
   Userdaten und Workspace-Datei erhalten bleiben.
9. Token-Widerruf zeigt `reconnect_required`; das alte Token kann nicht erneut
   verwendet werden.
10. Production-Runtime zeigt das Development-Testzertifikat als abgelehnt und
    laesst Teamfunktionen geschlossen.
11. Nach Agent-/Notebook-Restart zeigen Control Plane und Notebook denselben
    Lizenz-/Seat-Stand; Agent ist mit erwarteter Version online.
12. Nach Ende der Abnahme sind alle lokalen Testprozesse und Testdaten entfernt.

## Risiken, Migration und Rollback

### Risiken

- **Kommerzielle Stripe-Pfade sind noch nicht vollstaendig freigegeben.** Der
  verpflichtende Lauf bleibt No-Stripe. L5/L8 duerfen bis CP-TS-075 nur als
  stabil geblockter Zustand oder in einer separat freigegebenen Stripe-
  Testmode-Abnahme gelten.
- **PostgreSQL-Versionen unterscheiden sich.** Der vorhandene Control-Plane-
  Migrationstest nutzt PostgreSQL 16, Notebook zielt auf pgvector/PostgreSQL
  18. Der einzelne Harness-DB-Prozess muss beide Migrationsketten nachweislich
  tragen; bestehende PG16-Tests bleiben zusaetzlich bestehen.
- **Key-Rotation besitzt derzeit keinen serverseitigen Multi-Key-Contract.**
  Eine additive Aenderung darf v1-Clients nicht still brechen. Notfalls wird
  die Rotation als eigener versionierter Endpoint/Contract geplant.
- **Kurze TTLs koennen flakey werden.** Alle Zeitfenster benoetigen grosszuegige
  relative Grenzen, monotone Clock-Nutzung und bounded polling statt exakter
  Wall-Clock-Sleeps.
- **Agent-Config-Apply kann Hostzustand veraendern.** Der Harness verwendet nur
  einen isolierten Agent-Config-/Datenpfad und keine produktive systemd-,
  Compose- oder CLI-Konfiguration. Ein echter Container-Apply benoetigt eine
  eigene Freigabe.
- **UI und oeffentliche Status-API zeigen bewusst unterschiedliche Details.**
  Klasse/Environment/Seat-Sync werden nur der berechtigten Owner-Health
  zugemutet; ein vermeintlich fehlendes Feld im oeffentlichen Status ist nicht
  automatisch ein Bug.

### Schema- und Datenmigration

Der Testplan selbst benoetigt voraussichtlich keine neue Produktionsmigration.
Falls ein belegter Blocker eine Schemaaenderung erfordert:

- zuerst additive Migration und Rueckwaertskompatibilitaet definieren;
- bestehende Grant-, Token-, License-, Snapshot- und Audit-Historie erhalten;
- keine History-Tabelle oder aktive Lizenz hart loeschen;
- Migration in frischer DB und gegen eine redigierte realistische
  Bestandskopie pruefen;
- eigenes Migration-Commit vor der konsumierenden Produkt-/Testaenderung.

Testdaten werden nie in eine bestehende lokale oder produktive Datenbank
migriert. Jede Harness-Datenbank ist run-spezifisch und wird komplett entfernt.

### Rollback

- Test-Harness und Tests koennen per eigenem Commit zurueckgenommen werden,
  ohne Produktionsdaten anzufassen.
- Bei einem Lizenzincident bleiben kommerzielle Rollout- und Stripe-Mutations-
  Flags `false`; Test-Grants werden widerrufen und der Reconciliation-Worker
  bleibt fuer sichere Reduktion/Reissue aktiv.
- Signing-Rotation: neuer Signer kann auf A zurueckgestellt werden, solange A
  im Trust-/Keyset-Ueberlappungsfenster liegt. Ein kompromittierter Key wird
  nicht aus Bequemlichkeit reaktiviert; dann gelten Revocation und kontrollierte
  Neuausstellung.
- Keine Datenbankmigration wird blind zurueckgerollt, solange Audit-, Grant-
  oder Subscription-Historie sie referenziert.
- Cleanup ist der technische Rollback jedes lokalen Tests: Prozesse stoppen,
  Container/Volume/DBs entfernen, Run-Secrets loeschen und Portfreiheit
  bestaetigen.

## Definition of Done

- Der lokale Ablauf startet nach Freigabe echte Control-Plane-, Notebook- und
  Agent-Prozesse ausschliesslich auf den dokumentierten Loopback-Grenzen.
- Development-Testlizenzen werden ueber den echten sicheren Grant-Flow
  ausgegeben, erkannt, widerrufen, ablaufen gelassen und restlos bereinigt.
- Die Lizenztyp-/Zustandsmatrix ist automatisiert belegt; jede Abweichung ist
  entweder mit fokussiertem Fix geschlossen oder als explizites Release-Gate
  dokumentiert.
- Der v1-Handshake ist fuer Authentifizierung, Version, Replay, Clock-Skew,
  Timeout, Offline, Key-Rotation und ungueltige Signaturen getestet.
- Features, Workspaces, Seats, Quotas und UI-Wirkung stimmen mit den signierten
  Claims ueberein; Test-/Manual-Rails bleiben nicht abrechenbar.
- Control Plane, Agent und Notebook konvergieren nach Refresh,
  Wiederverbindung und Restart ohne Doppelmutation.
- Kein Test verwendet Produktionssecrets, Produktionsendpunkte oder
  Produktionsdaten; der Secret- und Cleanup-Audit ist gruen.
- Kompatibilitaetsmanifest, Runbook, redigierter Nachweis und beide Todo-
  Verweise sind aktuell.
- Alle vorgeschriebenen Tests, Typechecks, Lints und Builds sind gruen; ein
  Container-Test wurde erst danach und nur nach expliziter Freigabe frisch
  gestartet.
- Jede logische Phase besitzt einen eigenen fokussierten Commit im jeweils
  betroffenen Repository. Erst danach werden Ticket 11 und der Index auf
  `erledigt` gesetzt und die abhaengigen Tickets 12, 13 und 15 freigegeben.
