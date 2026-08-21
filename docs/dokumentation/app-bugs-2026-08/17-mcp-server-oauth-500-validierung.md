# Ticket 17 – Implementierungs- und Validierungsnachweis

Stand: 2026-08-21

## Umgesetzt

- Redigierte, korrelierbare Direct-MCP-Diagnostik mit `x-request-id` und
  HMAC-basiertem `flowRef`; OAuth-Parameter, Cookies, Codes und Tokens werden
  nicht geloggt.
- OAuth-Ressourcenschema, Runtime-Readiness, Health-Check und atomare
  Settings-Aktivierung. Ein aktivierter Server startet nur bei erfuelltem
  OAuth-, Schema-, JWKS- und Transport-Preflight.
- Strikte Resource- und S256-PKCE-Pruefung vor dem Provider; fehlerhafte
  Eingaben liefern stabile 4xx-Antworten.
- Korrekte lokale Revocation auch fuer selbstenthaltene JWT-Access-Tokens:
  Sitzung und zugehoerige Refresh-Grants werden lokal entzogen, waehrend der
  OAuth-Endpunkt protokollkonform mit 200 antwortet.
- DCR-Clients mit `token_endpoint_auth_method=none` werden beim Consent als
  oeffentliche Clients erkannt. Better Auth persistiert das historische
  `public`-Feld fuer diese DCR-Zeilen nicht mehr; die Entscheidung basiert
  deshalb auf der verpflichtenden `none`-Methode und lehnt nur explizit
  private Eintraege ab.
- Moderne und Legacy-MCP-Transportpfade verwenden dieselbe Auth-, Origin-,
  Fehler- und Request-ID-Behandlung. Auch `GET`, `DELETE` und `OPTIONS` sind
  diagnostizierbar. Tool-Ausnahmen geben keine internen Fehlermeldungen aus.

## Erfolgreich automatisiert validiert

Alle folgenden Befehle liefen am 2026-08-21 erfolgreich:

- `npm run test:mcp:server-diagnostics`
- `npm run test:mcp:server-schema`
- `npm run test:mcp:server-settings`
- `npm run test:mcp:server-provider`
- `npm run test:mcp:server-login-consent`
- `npm run test:mcp:server-oauth-client`
- `npm run test:mcp:server-resource`
- `npm run test:mcp:server-auth-probe`
- `npm run test:mcp:server-http-smoke` gegen den frisch gebauten Stand auf
  `http://localhost:3000` mit isolierten temporaeren Testdaten
- `npm run build`

Die OAuth-Client-Pruefung deckt DCR, Login/Consent, S256-PKCE, Code- und
Refresh-Token-Austausch, Replay, Scope- und Resource-Ablehnung, Revocation,
`initialize`, `tools/list` und einen authentifizierten `auth_probe`-Call ab.

## Noch offen

- Manuelle externe ChatGPT-Connector-Abnahme. Sie erfordert weiterhin eine
  explizite Browser-/Playwright-Freigabe und dedizierte Test-Credentials.

Nach dieser Abnahme kann das Ticket geschlossen und der Bug-Index aktualisiert
werden.
