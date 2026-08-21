---
title: 'Ticket 14: To-do-Sichtbarkeit, Filter und Priorisierung korrigieren'
status: open
priority: high
depends_on: ['02-notification-und-todo-status-vereinheitlichen']
platforms: [web, server, mobile-api]
tags: [type/bug, topic/todos, topic/workspaces, topic/ui]
---

# Ticket 14: To-do-Sichtbarkeit, Filter und Priorisierung korrigieren

> Detaillierter, am aktuellen Codebestand ausgerichteter Umsetzungsplan:
> [14-todo-sichtbarkeit-filter-priorisierung-umsetzungsplan.md](./14-todo-sichtbarkeit-filter-priorisierung-umsetzungsplan.md)

## Problem

In der To-do-Route und den zugehoerigen UI-Flaechen ist nicht verlaesslich
erklaerbar, wann ein To-do angezeigt wird. Bei mehreren persoenlichen und Team-
Workspaces koennen Eintraege trotz aktivem Workspace-Filter fehlen oder aus
einem anderen Workspace erscheinen. Eine eindeutige Priorisierung fehlt.

## Zielzustand

- Sichtbarkeit wird serverseitig aus Nutzer, Assignee, Workspace-Zugriff,
  Lebenszyklus und explizitem Filter bestimmt.
- Ein Workspace-Filter liefert ausschliesslich Eintraege dieses Workspaces;
  eine bewusst gewaehlt globale Ansicht kennzeichnet jeden Workspace sichtbar.
- Sortierung und Wichtigkeit sind deterministisch und dokumentiert.
- Web-, Notification- und Mobile-Listen verwenden dieselbe Scope-Semantik.

## Umsetzung

- To-do-Store, API, Scope-Helfer, Home-/Notification-Komponenten und Mobile-
  Adapter inventarisieren; konkrete Zwei-Workspace-Reproduktionen festhalten.
- Einen kanonischen Listenvertrag fuer `workspaceId`, Assignee, Owner,
  Lebenszyklus, Read-Status, Prioritaet, Faelligkeit und Pagination definieren.
- Scope und Filter in einer gemeinsamen serverseitigen Query-/Policy-Schicht
  erzwingen; persoenliche und Team-Workspaces nicht implizit zusammenfassen.
- Stabile Sortierung festlegen, z. B. Prioritaet, ueberfaellig/faellig,
  Erstellungszeit und ID als Tie-Breaker; Produktentscheidung dokumentieren.
- UI zeigt aktiven Scope, globale Ansicht, Leerzustand und Filterwirkung klar an.

## Abnahmekriterien

- Mit je einem To-do in zwei Workspaces liefert jeder Workspace-Filter nur den
  passenden Eintrag; globale Ansicht zeigt beide eindeutig beschriftet.
- Ein Nutzer sieht keine fremden oder nicht mehr zugaenglichen To-dos.
- Gleiche Daten werden nach Reload, Pagination und Clientwechsel gleich
  sortiert und gefiltert.
- Fuer jeden ausgeblendeten Fall existiert eine testbare fachliche Regel.

## Tests und Abschluss

- Matrix-Tests fuer persoenliche/Team-Workspaces, Rollen, Assignees,
  Lebenszyklen, Filter, Pagination und Prioritaet.
- `npm run build` und manuelle Mehr-Workspace-Abnahme; Browser-/E2E-Test nur
  nach expliziter Freigabe.
- Eigener Commit, danach Status im [Index](./README.md) aktualisieren.
