---
title: 'Ticket 02: Notification- und To-do-Status vereinheitlichen'
status: open
priority: high
depends_on: ['01-sub-agent-steuerung-und-darstellung']
platforms: [web, server, mobile-api]
tags: [type/bug, topic/notifications, topic/todos]
---

# Ticket 02: Notification- und To-do-Status vereinheitlichen

## Problem

Die Notification Central behandelt Chat-Hinweise und To-dos gleich. Dadurch
verschwinden To-dos nach dem Lesen aus Web- und Mobile-Inbox, obwohl sie bis zu
ihrem fachlichen Abschluss auffindbar bleiben muessen. Der Umschalter fuer
gelesen/ungelesen ist zwischen den Clients inkonsistent.

## Zielzustand

- Chat-Notifications duerfen nach dem Lesen aus der aktiven Notification-Liste
  verschwinden.
- To-dos bleiben unabhaengig von ihrem Lese-Status sichtbar, solange sie nicht
  archiviert oder nach einer festgelegten fachlichen Regel abgeschlossen sind.
- Der Lese-Status eines To-dos kann in Web und Mobile gezielt zwischen gelesen
  und ungelesen umgeschaltet werden.
- Web und Expo verwenden denselben serverseitigen Statusvertrag.

## Umsetzung

- Bestehendes To-do-Modell und die Planung in
  `docs/dokumentation/todo-notification-center-plan.md` inventarisieren; eine
  eindeutige Trennung zwischen Lebenszyklus (`open`, `done`, `archived`) und
  Aufmerksamkeitsstatus (`seenAt`/ungelesen) festlegen.
- API-Listen typbasiert ausliefern: Chat-Notifications nach ungelesen, To-dos
  nach Lebenszyklus und nicht nach Lese-Status filtern.
- Idempotente Serveraktion zum Setzen von gelesen/ungelesen fuer To-dos bauen;
  Nutzer-, Workspace- und Ownership-Scope serverseitig erzwingen.
- Web Notification Central in getrennte Chat- und To-do-Bereiche aufteilen und
  einen sichtbaren Status sowie Toggle ergaenzen.
- Mobile-Vertrag inklusive Filter, Counts und Mutationsresponse versioniert
  dokumentieren, damit Ticket 03 darauf aufbauen kann.

## Abnahmekriterien

- Ein gelesenes offenes To-do ist ueber Web- und Mobile-API weiterhin abrufbar.
- Ein Chat-Hinweis kann nach Lesen aus der aktiven Notification-Liste fehlen,
  ohne To-dos mit zu entfernen.
- Ein Toggle in einem Client ist nach Reload und im anderen Client sichtbar.
- Fremde Nutzer, Workspaces und nicht existente To-dos koennen nicht mutiert
  oder ausgelesen werden.

## Tests und Abschluss

- API-/Integrationstests fuer Typfilter, Lebenszyklus, Read/Unread-Toggle,
  Idempotenz und Scope-Isolation.
- `npm run build` nach Server-/Web-Aenderungen.
- Manuelle Web-Abnahme; Mobile-Vertrag mit dem Expo-Repository abgleichen.
- Eigener Commit, danach Status im [Index](./README.md) aktualisieren.
