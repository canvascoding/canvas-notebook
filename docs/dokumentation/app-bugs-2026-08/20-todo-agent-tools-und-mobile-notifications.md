---
title: 'Ticket 20: Agenten-Tools fuer To-do-Verwaltung und Mobile Notifications erweitern'
status: open
priority: medium
depends_on: ['02-notification-und-todo-status-vereinheitlichen', '14-todo-sichtbarkeit-filter-und-priorisierung', '29-notification-zentrum-attention-todos-email-review']
platforms: [server, agent-runtime, mobile, mobile-api]
repositories: [canvasstudios-notebook, expo-mobile-app]
tags: [type/feature, topic/todos, topic/tools, topic/notifications]
---

# Ticket 20: Agenten-Tools fuer To-do-Verwaltung und Mobile Notifications erweitern

## Problem

Agenten koennen derzeit im Wesentlichen To-dos erstellen, aber vorhandene
To-dos nicht vollstaendig listen, bearbeiten, abschliessen, archivieren oder
loeschen. Gleichzeitig muessen To-do-Aenderungen in der separaten Expo-App
zuverlaessiger als Notifications ankommen und zum richtigen Eintrag fuehren.

## Zielzustand

- Berechtigte Agenten koennen To-dos scoped suchen/auflisten, lesen, aendern,
  abschliessen und nach klarer Policy archivieren oder loeschen.
- Mutationen nutzen dieselbe Action-/Policy-Schicht wie UI und API und sind
  idempotent, auditierbar und konfliktbewusst.
- Mobile Notifications werden nur an berechtigte betroffene Nutzer zugestellt,
  dedupliziert und oeffnen den richtigen Workspace und das richtige To-do.
- Sensible Titel oder Inhalte werden je nach Notification-Policy nicht auf dem
  Lockscreen offengelegt.

## Umsetzung

- `human-todo-tool`, To-do-Store/API/Scope und Mobile-Inbox-Vertrag gegen die
  Ergebnisse aus Tickets 02 und 14 inventarisieren.
- Kleine, getrennte Tool-Schemas fuer List/Get/Update/Complete/Archive/Delete
  definieren; destruktives Loeschen nur bei fachlicher Notwendigkeit und mit
  enger Berechtigung, sonst Archivierung bevorzugen.
- Version/Revision oder vergleichbaren Konfliktschutz und stabile Fehlercodes
  fuer veraltete Agent-Mutationen einfuehren.
- Notification-Ereignisse fuer Create, Assignment, wichtige Aenderung,
  Faelligkeit und Abschluss fachlich festlegen; Noise und Duplikate begrenzen.
- Expo-Deep-Link, Badge-/Read-Sync, Workspace-Wechsel und Push-Fallback gegen
  den versionierten Serververtrag implementieren.

Ereignisarten, Attention-Counts und die Trennung von To-do-Lifecycle,
Ereignis-Unread und E-Mail-Review richten sich nach
[Ticket 29](./29-notification-zentrum-attention-todos-email-review.md).
Dieses Ticket erweitert den Vertrag um Agenten- und Push-Ausloeser, statt eine
zweite Notification-Semantik einzufuehren.

## Abnahmekriterien

- Ein Agent kann nur To-dos zulaessiger Nutzer/Workspaces lesen und mutieren;
  Promptargumente koennen den Scope nicht erweitern.
- Update, Abschluss und Archivierung erscheinen nach Reload konsistent in Web,
  Mobile und Agent-Resultat; konkurrierende Aenderungen gehen nicht still verloren.
- Eine relevante Aenderung erzeugt hoechstens eine passende Push-Notification
  und der Deep Link oeffnet nach Auth den korrekten Workspace/Eintrag.
- Abgemeldete, entfernte oder unberechtigte Nutzer erhalten keine Details.

## Tests und Abschluss

- Tool-/Policy-/Audit-/Conflict-/Notification-Tests im Server-Repository;
  Push-, Badge-, Deep-Link- und Multi-Workspace-Tests im Expo-Repository.
- `npm run build` fuer Server-/Web-Aenderungen und reale Mobile-Abnahme.
- Eigener Commit je Repository, danach Status im [Index](./README.md) setzen.
