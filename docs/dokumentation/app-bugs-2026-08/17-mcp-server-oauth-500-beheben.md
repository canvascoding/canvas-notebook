---
title: 'Ticket 17: Exponierten MCP-Server und OAuth-500 beheben'
status: open
priority: high
depends_on: []
platforms: [server, mcp, oauth]
tags: [type/bug, topic/mcp, topic/oauth, topic/integrations]
---

# Ticket 17: Exponierten MCP-Server und OAuth-500 beheben

## Umsetzungsplan

Der codebestandsnahe, strikt sequenzielle Plan ist unter
[17-mcp-server-oauth-500-umsetzungsplan.md](./17-mcp-server-oauth-500-umsetzungsplan.md)
dokumentiert.

## Problem

Der extern exponierte MCP-Server startet bzw. antwortet nicht zuverlaessig.
ChatGPT erkennt den OAuth-Flow, nach Autorisierung tritt jedoch ein HTTP-500-
Fehler auf. Discovery, Redirect, Grant, Token-Austausch und MCP-Runtime muessen
als zusammenhaengender Flow diagnostiziert werden.

## Zielzustand

- MCP-Server und OAuth-Metadaten sind nach Startup und Restart erreichbar.
- Ein unterstuetzter ChatGPT-OAuth-Flow durchlaeuft Discovery, Login/Consent,
  Code-Austausch und authentifizierten MCP-Aufruf ohne 500-Fehler.
- Externe Basis-URL, Proxy-Header, Redirect-URIs und geschuetzte Ressourcen sind
  konsistent und sicher validiert.
- Fehler liefern stabile 4xx-/5xx-Codes mit korrelierbarer, redigierter Diagnose.

## Umsetzung

- Plaene unter `docs/architecture/canvas-notebook/mcp-server/` mit Runtime-
  Bootstrap, Settings und aktuellen HTTP-/OAuth-Routen abgleichen.
- Den Fehler in einer isolierten Umgebung reproduzieren und jede Phase mit
  Request-ID, Status und redigierter Ursache protokollieren.
- Startup-Reihenfolge, Runtime-Readiness und Failure Recovery pruefen; ein
  gestarteter Webserver darf keinen nicht initialisierten MCP-Handler melden.
- Issuer/Audience, PKCE, State, Redirect-Allowlist, Forwarded-Header und
  Token-Verifikation gegen den oeffentlichen Ursprung konsistent machen.
- OAuth-Erfolg direkt mit einem authentifizierten Tool-List/Call verbinden.

## Abnahmekriterien

- Der dokumentierte ChatGPT-kompatible OAuth-Test endet in einem erfolgreichen
  MCP-Toolaufruf und funktioniert nach Serverneustart erneut.
- Falsche Redirect-URI, State, PKCE, Audience oder Token werden gezielt als 4xx
  abgewiesen und nicht als generischer 500-Fehler maskiert.
- Keine Authorization Codes, Tokens oder Secrets erscheinen in Logs oder UI.
- Readiness erkennt einen fehlgeschlagenen MCP-Startup vor externem Traffic.

## Tests und Abschluss

- Bestehende MCP-Auth-, OAuth-, Schema-, Protected-Resource-, Bootstrap- und
  HTTP-Smoke-Tests erweitern; realen externen Flow nur mit Test-Credentials.
- `npm run build` und manuelle Integrationsabnahme; Browser-/E2E-Test nur nach
  expliziter Freigabe.
- Eigener Commit, danach Status im [Index](./README.md) aktualisieren.
