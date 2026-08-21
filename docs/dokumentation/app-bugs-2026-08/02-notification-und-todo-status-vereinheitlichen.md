---
title: 'Ticket 02: Notification- und To-do-Status vereinheitlichen'
status: erledigt
priority: high
depends_on: ['01-sub-agent-steuerung-und-darstellung']
platforms: [web, server, mobile-api]
tags: [type/bug, topic/notifications, topic/todos]
---

# Ticket 02: Notification- und To-do-Status vereinheitlichen

> Detaillierter, am aktuellen Codebestand ausgerichteter Umsetzungsplan:
> [02-notification-todo-umsetzungsplan.md](./02-notification-todo-umsetzungsplan.md)

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

- Kanonische, nutzerbezogene `todo_read_states`-Persistenz mit idempotenter
  Migration aus den bisherigen `seen_at`- und Inbox-Read-States eingefuehrt.
- Read/Unread wird ueber eine gemeinsame, berechtigte Serveraktion gesetzt;
  `todo_items.updated_at` bleibt dabei unveraendert.
- Web-, Mobile- und Inbox-APIs liefern `readAt`/`readState`; `markSeen` und
  `mark_item_read` bleiben kompatible Read-Aliase.
- Open und done To-dos bleiben als eigene Inbox-Sektion sichtbar; archived
  To-dos bleiben ausgeschlossen. Counter unterscheiden Gesamt-To-dos und
  ungelesene To-dos.
- Die Web Notification Central trennt Benachrichtigungen und To-dos und
  bietet pro To-do einen Gelesen/Ungelesen-Schalter.

## Abnahmekriterien

- Ein gelesenes offenes To-do ist ueber Web- und Mobile-API weiterhin abrufbar.
- Ein Chat-Hinweis kann nach Lesen aus der aktiven Notification-Liste fehlen,
  ohne To-dos mit zu entfernen.
- Ein Toggle in einem Client ist nach Reload und im anderen Client sichtbar.
- Fremde Nutzer, Workspaces und nicht existente To-dos koennen nicht mutiert
  oder ausgelesen werden.

## Tests und Abschluss

- `npm run test:todos:store`, `npm run test:mobile:inbox` und ESLint erfolgreich.
- `npm run build` erfolgreich (inklusive Lizenz- und TypeScript-Pruefung).
- Browser-/Playwright-Abnahme wurde nicht ausgefuehrt, weil sie laut
  Repository-Regel erst nach expliziter Freigabe erfolgen darf.
