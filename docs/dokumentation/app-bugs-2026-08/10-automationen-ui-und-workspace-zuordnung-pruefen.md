---
title: 'Ticket 10: Automationen, UI und Workspace-Zuordnung pruefen'
status: open
priority: high
depends_on: ['09-administrator-email-setup-reparieren']
platforms: [web, server, agent-runtime]
tags: [type/bug, topic/automations, topic/workspaces, topic/ownership]
---

# Ticket 10: Automationen, UI und Workspace-Zuordnung pruefen

## Problem

Automationsrouten, Listen-UI und Scope-Logik muessen erneut Ende-zu-Ende
geprueft werden. Insbesondere ist unklar, ob Filter sinnvoll vorhanden sind,
welche Automation welchem Workspace und Owner gehoert und ob Agent-Tool-Calls
dieselben Regeln wie UI und REST-API erzwingen.

## Zielzustand

- Jede Automation hat einen eindeutigen Owner, Workspace und gegebenenfalls
  Organization-Scope.
- Die Liste kann mindestens nach Workspace, Owner, Status und Automationstyp
  gefiltert werden und zeigt den aktiven Scope sichtbar an.
- Erstellen, Aendern, Ausfuehren und Loeschen nutzen fuer UI, API und Agent-Tool
  dieselbe serverseitige Policy.
- Runs und Logs bleiben der Automation und ihrem Scope eindeutig zugeordnet.

## Umsetzung

- Alle Automationsrouten, Store-/Policy-/Runner-Pfade, Mobile-Adapter und
  Agent-Tools gegen `team-workspace/11-automation-execution-model.md`
  inventarisieren.
- Datenmodell und Legacy-Daten auf fehlende oder widerspruechliche Owner- und
  Workspace-Zuordnung pruefen; sichere Migration bzw. Quarantaene definieren.
- Listenvertrag um explizite Filter, Pagination, stabile Sortierung und
  serverseitige Scope-Begrenzung ergaenzen; UI-Zustaende und Filter-Reset
  verstaendlich gestalten.
- Gemeinsame Action-/Policy-Grenze fuer UI, API und Tool-Calls verwenden.
  Client- oder Toolargumente duerfen Owner und Workspace nicht frei setzen.
- Run-now, Scheduler, Webhook und Workspace-Wechsel auf dieselben Regeln testen.

## Abnahmekriterien

- Nutzer sehen und mutieren nur Automationen zugaenglicher Workspaces; Filter
  vermischen keine Eintraege anderer Workspaces.
- Owner, Workspace und Ausfuehrungskontext bleiben nach Bearbeitung und Run
  stabil und sind in UI sowie Auditdaten nachvollziehbar.
- Ein manipulierter API- oder Tool-Aufruf kann keine Automation in fremdem
  Scope anlegen, verschieben, aendern, ausfuehren oder loeschen.
- Leere, geladene, gefilterte und fehlerhafte Listen sind sinnvoll bedienbar.

## Tests und Abschluss

- Route-/Policy-/Runner-Tests fuer CRUD, Filter, Tool-Calls, Scheduler,
  Webhooks, Ownership und Workspace-Isolation.
- `npm run build` und manuelle UI-Abnahme; Browser-/E2E-Test nur nach
  expliziter Freigabe.
- Eigener Commit, danach Status im [Index](./README.md) aktualisieren.
