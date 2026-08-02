# Direct MCP V1 – OAuth-E2E-Prüfprotokoll

> Stand: 2026-08-02
> Zugehöriges Todo: `MCP-OAUTH-08`
> Status: Externe Prüfung ausstehend

Dieses Protokoll ist der verbindliche Nachweis für den OAuth-Flow des direkten
MCP-V1-Servers. Ein grüner automatisierter Test ersetzt weder den MCP Inspector
noch den manuellen ChatGPT-Test. Das Todo darf erst als abgeschlossen markiert
werden, wenn beide externen Abschnitte vollständig protokolliert sind.

Referenzen:

- [Offizieller MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [OpenAI: Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)
- [OpenAI: Authentication](https://developers.openai.com/plugins/build/auth)

## 1. Testinstanz

Vor Beginn ausfüllen:

| Feld | Wert |
|---|---|
| Datum und Tester | _ausstehend_ |
| Git-Revision | _ausstehend_ |
| Deployment-ID oder Release | _ausstehend_ |
| Öffentliche Instanz-Origin | _ausstehend_ |
| MCP-URL | `https://<instanz>/mcp` |
| Inspector-Version | _ausstehend_ |
| ChatGPT-Workspace und Plan | _ausstehend_ |
| Browser | _ausstehend_ |

Die Testinstanz muss eine isolierte, öffentlich erreichbare HTTPS-Instanz sein.
Sie verwendet einen eigens dafür angelegten lokalen Canvas-Notebook-Benutzer
und Testdaten. Produktionskonten, echte Workspace-Inhalte und Tokens dürfen
nicht in Screenshots oder Logs erscheinen.

Erforderliche Laufzeitkonfiguration:

```dotenv
CANVAS_MCP_DIRECT_ENABLED=true
BASE_URL=https://<instanz>
BETTER_AUTH_BASE_URL=https://<instanz>
AUTH_COOKIE_SECURE=true
```

`BASE_URL` und `BETTER_AUTH_BASE_URL` müssen exakt dieselbe öffentliche Origin
enthalten. In Production ist HTTP nicht zulässig.

## 2. Automatisierte Baseline

Vor dem externen Test müssen diese Prüfungen auf derselben Git-Revision grün
sein:

```bash
npm run test:mcp:server-oauth-client
npm run test:mcp:server-auth-probe
npm run test:mcp:server-resource
```

Der Auth-Probe-Test blockiert jeden ausgehenden `fetch`-Aufruf. Damit weist er
für eine nicht verwaltete Direct-V1-Konfiguration zusätzlich nach, dass der
OAuth- und MCP-Request keine Canvas Control Plane und keinen anderen Remote-
Dienst aufruft. Eine reine Logzeile mit dem konfigurierten
`controlPlaneHost` ist kein Netzwerkaufruf.

Aktueller lokaler Nachweis:

| Datum | Git-Revision | Ergebnis |
|---|---|---|
| 2026-08-02 | `8e6182e0c9a3` | alle drei Prüfungen grün |

## 3. Discovery-Preflight

Für die folgenden Beispiele wird nur die Testinstanz-Origin gesetzt:

```bash
MCP_TEST_ORIGIN=https://<instanz>
```

Die vier Discovery-Routen müssen ohne Anmeldung erreichbar sein:

```bash
curl --fail --silent --show-error \
  "$MCP_TEST_ORIGIN/.well-known/oauth-protected-resource/mcp" | jq
curl --fail --silent --show-error \
  "$MCP_TEST_ORIGIN/.well-known/oauth-protected-resource" | jq
curl --fail --silent --show-error \
  "$MCP_TEST_ORIGIN/.well-known/oauth-authorization-server/api/auth" | jq
curl --fail --silent --show-error \
  "$MCP_TEST_ORIGIN/api/auth/.well-known/oauth-authorization-server" | jq
```

Zu prüfen:

- `resource` ist exakt `https://<instanz>/mcp`.
- `authorization_servers` enthält exakt `https://<instanz>/api/auth`.
- der Authorization Server nennt DCR, Authorization, Token und Revocation.
- `code_challenge_methods_supported` enthält `S256`.
- `grant_types_supported` enthält `authorization_code` und `refresh_token`.
- `scopes_supported` enthält `openid`, `offline_access` und die MCP-Scopes.
- keine URL zeigt auf `mcp.canvasnotebook.app` oder die Canvas Control Plane.

Die anonyme MCP-Initialisierung und `tools/list` müssen möglich sein.
`auth_probe` muss dabei ein erstklassiges OAuth-`securitySchemes`-Feld mit
`workspace:list` liefern. Ein anonymer Aufruf von `auth_probe` muss eine
`mcp/www_authenticate`-Challenge mit der kanonischen Protected-Resource-
Metadata-URL liefern.

## 4. MCP-Inspector-Test

Zuerst die tatsächlich verwendete Inspector-Version erfassen und für den Test
fest pinnen:

```bash
MCP_INSPECTOR_VERSION="$(npm view @modelcontextprotocol/inspector version)"
npx -y "@modelcontextprotocol/inspector@$MCP_INSPECTOR_VERSION" \
  --cli "$MCP_TEST_ORIGIN/mcp" \
  --transport http \
  --method tools/list
```

Danach dieselbe Version im UI-Modus starten. Der Inspector bleibt ausschließlich
an localhost gebunden; sein Proxy-Session-Token darf nicht protokolliert werden:

```bash
MCP_AUTO_OPEN_ENABLED=false \
npx -y "@modelcontextprotocol/inspector@$MCP_INSPECTOR_VERSION"
```

Im Inspector:

1. Transport `Streamable HTTP` und `https://<instanz>/mcp` auswählen.
2. Verbindung herstellen und den angebotenen OAuth-Flow starten.
3. Prüfen, dass der Client per DCR seine eigene Redirect URI registriert.
4. Auf der lokalen Canvas-Notebook-Loginseite mit dem Testbenutzer anmelden.
5. Clientname, Redirect-Ziel und Scopes auf der Consent-Seite prüfen und
   zustimmen.
6. Die erfolgreiche Rückkehr zum Inspector bestätigen.
7. `tools/list` ausführen und ausschließlich `auth_probe` erwarten.
8. `auth_probe` ausführen und nur `authenticated`, eine redigierte `user_ref`
   und `workspace:list` erwarten.
9. Nach Ablauf des 15-minütigen Access Tokens erneut `auth_probe` ausführen.
   Der Inspector muss den Refresh Token verwenden oder kontrolliert eine neue
   Autorisierung verlangen; ein stiller Dauerfehler ist nicht zulässig.
10. In Canvas Notebook abmelden und den bestehenden Token erneut verwenden.
    Der Aufruf muss abgewiesen werden. Nach Reconnect und neuer Anmeldung muss
    `auth_probe` wieder funktionieren.

Ein erfolgreicher Callback plus Tokenaustausch gilt als Nachweis, dass
Authorization Request, registrierte Redirect URI und Token Request exakt
zusammenpassen. Codes, Tokens, Cookies und der Inspector-Proxy-Token werden
vor dem Speichern der Evidenz vollständig entfernt.

Ergebnis:

| Prüfung | Status | Evidenz/Notiz |
|---|---|---|
| Discovery beider Metadata-Ebenen | ausstehend | |
| DCR mit Inspector-Redirect | ausstehend | |
| lokaler Login und Consent | ausstehend | |
| Rückkehr und `tools/list` | ausstehend | |
| authentifizierter `auth_probe` | ausstehend | |
| Refresh nach Tokenablauf | ausstehend | |
| Session-Widerruf und Reconnect | ausstehend | |
| kein Control-Plane-Aufruf | ausstehend | |

## 5. ChatGPT-Developer-Mode-Test

Der Test findet in ChatGPT Web statt. Der verwendete Account muss für Developer
Mode und das Erstellen einer eigenen MCP-App berechtigt sein.

1. Developer Mode gemäß den aktuellen Workspace-Regeln aktivieren.
2. Unter `Settings → Apps → Create` eine neue private Test-App anlegen.
3. Als MCP-Endpunkt ausschließlich `https://<instanz>/mcp` eintragen und OAuth
   als Authentifizierung verwenden.
4. `Scan Tools` starten.
5. Im automatisch geöffneten lokalen Canvas-Notebook-Flow anmelden, Consent
   prüfen und bestätigen.
6. Prüfen, dass der Scan genau `auth_probe` findet und die App als `Dev`
   gekennzeichnet wird.
7. In einem neuen Chat die Test-App auswählen und ausdrücklich `auth_probe`
   ausführen lassen.
8. Nach mehr als 15 Minuten denselben Probe erneut ausführen. Die Verbindung
   muss per Refresh Token erhalten bleiben.
9. Den lokalen Canvas-Notebook-Benutzer abmelden beziehungsweise seine Session
   widerrufen. Der nächste Probe muss scheitern und eine erneute Anmeldung
   anbieten.
10. Erneut verbinden und den erfolgreichen Probe bestätigen.
11. Die Test-App nach Abschluss löschen oder deaktivieren.

OpenAI weist darauf hin, dass Refresh Tokens nur zuverlässig verwendet werden,
wenn `offline_access` angefordert und in den Discovery-Metadaten angeboten wird.
Beides ist daher ausdrücklich Teil dieses Tests.

Ergebnis:

| Prüfung | Status | Evidenz/Notiz |
|---|---|---|
| Tool-Scan startet OAuth | ausstehend | |
| lokaler Login und Consent | ausstehend | |
| Rückkehr und Tool-Scan | ausstehend | |
| `auth_probe` im Chat | ausstehend | |
| Refresh nach Tokenablauf | ausstehend | |
| Session-Widerruf löst Re-Auth aus | ausstehend | |
| Reconnect erfolgreich | ausstehend | |
| kein Control-Plane-Aufruf | ausstehend | |

## 6. Abschlusskriterium

`MCP-OAUTH-08` wird nur abgeschlossen, wenn:

- alle Tabellenzeilen auf `bestanden` stehen,
- Inspector- und ChatGPT-Version sowie Git-Revision erfasst sind,
- sensible Werte aus der Evidenz entfernt wurden,
- kein Zugriff auf die Canvas Control Plane beobachtet wurde,
- Abweichungen als eigenes Todo erfasst und behoben wurden.

Die aktuelle Ausführung ist noch blockiert: Im Repository ist keine öffentliche
HTTPS-Staging-Instanz hinterlegt. Außerdem konnte die Inspector-Version in der
lokalen Arbeitsumgebung wegen fehlender DNS-Auflösung für `registry.npmjs.org`
nicht geladen werden. Diese beiden Punkte sind keine bestandene externe
Prüfung.
