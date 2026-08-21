---
title: 'Ticket 16: Persoenliches ChatGPT-Abo im Team-Workspace nutzbar machen'
status: in_review
priority: high
depends_on: []
platforms: [web, server, agent-runtime]
tags: [type/bug, topic/chatgpt, topic/oauth, topic/workspaces, topic/runtime]
---

# Ticket 16: Persoenliches ChatGPT-Abo im Team-Workspace nutzbar machen

> Detaillierter, am aktuellen Codebestand ausgerichteter Umsetzungsplan:
> [16-chatgpt-abo-im-team-workspace-umsetzungsplan.md](./16-chatgpt-abo-im-team-workspace-umsetzungsplan.md)

## Problem

Ein Nutzer kann sein persoenlich verbundenes ChatGPT-Abo im persoenlichen
Workspace verwenden, im Team-Workspace arbeitet der KI-Agent damit jedoch
nicht verlaesslich. Die Aufloesung von Nutzer-Credential, Workspace-Policy,
Provider und Session-Runtime muss ueberprueft werden.

## Zielzustand

- Ein persoenliches Provider-Credential kann nach ausdruecklicher Freigabe des
  Nutzers in zulaessigen Team-Workspaces fuer dessen eigene Runs genutzt werden.
- Credentials werden niemals mit anderen Teammitgliedern oder Team-Agenten
  geteilt und nicht als Workspace-Secret persistiert.
- Workspace-/Organization-Policy kann den Provider einschränken, aber kein
  fremdes Credential freigeben.
- Session, Reconnect, Tool-Run und Automation loesen denselben effektiven
  Nutzer-/Workspace-/Provider-Kontext auf.

## Umsetzung

## Aktueller Umsetzungsstand (2026-08-21)

Die Consent-, Resolver- und Credential-Isolationsaenderungen sind als PR #73
in `main` integriert. Die fokussierte Runtime-Abnahme mit Testkonten sowie die
manuelle Verifikation der Consent-/Reauth-Zustaende stehen noch aus; das Ticket
ist deshalb in Abnahme und nicht erledigt.

- OAuth-/Provider-Credentials, Runtime-Resolver, Session-Snapshots und
  Workspace-Berechtigungen fuer persoenliche und Team-Sessions inventarisieren.
- Eine explizite Credential-Aufloesungsmatrix fuer Actor, Workspace-Typ,
  Agent-Owner, Provider-Policy und Ausfuehrungsart dokumentieren.
- User-Scoped Credential nur zur Laufzeit referenzieren; Teammitglieder,
  Background-Runs und delegierte Agenten getrennt bewerten.
- UI zeigt, welches persoenliche Konto fuer den eigenen Run verwendet wird,
  und bietet klare Reauth-/Nicht-erlaubt-Zustaende.
- Token-Refresh, Reconnect, Providerwechsel und Berechtigungsentzug absichern.

## Abnahmekriterien

- Derselbe Nutzer kann einen erlaubten Agent-Run mit seinem Abo in persoenlichem
  und Team-Workspace ausfuehren.
- Ein zweiter Nutzer kann das Credential weder sehen noch indirekt verwenden.
- Workspace-Policy und Credential-Entzug greifen bei neuen Runs sofort und
  erzeugen eine klare Fehlermeldung.
- Runtime-Snapshot und Logs enthalten keine Tokens.

## Tests und Abschluss

- Runtime-/OAuth-/Workspace-Matrixtests fuer Sessions, Reconnect und
  Negativfaelle; Automations- und Delegationsverhalten explizit festlegen.
- `npm run build` und manuelle Abnahme mit Testkonten; Browser-/E2E-Test nur
  nach expliziter Freigabe.
- Eigener Commit, danach Status im [Index](./README.md) aktualisieren.
