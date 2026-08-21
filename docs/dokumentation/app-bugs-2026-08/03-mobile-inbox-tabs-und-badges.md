---
title: 'Ticket 03: Mobile Inbox mit Kategorien und Badges'
status: open
priority: high
depends_on: ['02-notification-und-todo-status-vereinheitlichen']
platforms: [mobile, mobile-api, web]
tags: [type/bug, topic/mobile-app, topic/notifications, topic/todos]
---

# Ticket 03: Mobile Inbox mit Kategorien und Badges

## Problem

Die Expo-Inbox vermischt Notifications und To-dos. E-Mails sind nicht klar
separiert, und weder die Untertabs noch die Bottom-Navigation zeigen, wo neue
oder offene Arbeit liegt.

## Zielzustand

- Die mobile Inbox hat die drei Bereiche **Notifications**, **E-Mails** und
  **To-dos**.
- Jeder Bereich zeigt ein klar definiertes Counter-Badge.
- Der Inbox-Eintrag der Bottom-Navigation zeigt die Summe wichtiger ungelesener
  Notifications; offene To-dos werden nicht versehentlich als ungelesene Chats
  mitgezaehlt.
- To-dos bleiben im To-do-Tab dauerhaft sichtbar, auch wenn sie gelesen sind.

## Umsetzung

- UX-Entscheidung fuer Reihenfolge, Leerzustaende, Fehlersicht, Pull-to-refresh
  und Badge-Darstellung festhalten.
- Den in Ticket 02 definierten API-Vertrag um getrennte, paginierbare Listen und
  serverseitig berechnete Counts fuer Notifications, E-Mails und To-dos
  ergaenzen, soweit dies noch fehlt.
- Counter-Semantik festschreiben: Notifications/E-Mails zaehlen ungelesene oder
  aktionserforderliche Eintraege; To-dos zaehlen offene Eintraege nach der
  Produktentscheidung, nicht ihren Lese-Status.
- Expo-Inbox mit Tabs, individuellen Lade-/Leer-/Fehlerzustaenden sowie einer
  stabilen Cache-Invalidierung implementieren.
- Bottom-Tab-Badge aus dem serverseitigen wichtigen Notification-Count speisen.
- Das Zusammenspiel mit der Web Notification Central aus Ticket 02 auf gleiche
  Datenquelle und Begriffe pruefen.

## Abnahmekriterien

- Alle drei Kategorien sind separat erreichbar und haben korrekte Counts.
- Gelesene offene To-dos bleiben im To-do-Tab; ihr Read/Unread-Toggle aus
  Ticket 02 funktioniert dort.
- Das globale Badge reagiert nach Lesen einer wichtigen Notification und nach
  Synchronisation korrekt.
- Offline-, Lade-, Fehler- und leere Listen sind eindeutig und blockieren keine
  Navigation.

## Tests und Abschluss

- Serververtrag mit Listen-/Count-/Scope-Tests absichern.
- Im Expo-Repository Komponenten- und reale Geraeteabnahme fuer Tabs, Badges,
  Deep Links und Synchronisation dokumentieren.
- `npm run build` fuer geaenderte Server-/Web-Anteile.
- Eigener Commit je Repository; dann Status im [Index](./README.md) aktualisieren.
