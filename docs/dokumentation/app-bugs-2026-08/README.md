---
title: App-Fehler August 2026 – sequenzielle Ticketliste
date: 2026-08-20
status: open
tags:
  - type/bug-tracker
  - status/open
  - topic/canvas-agent
---

# App-Fehler August 2026 – sequenzielle Ticketliste

Diese Tickets zerlegen den Bericht „Weitere App-Fehler – Sub-Agents,
Notification-Inbox, Mobile UI & Files-Tab“ in abnahmefaehige Arbeitspakete.
Sie werden **streng in der angegebenen Reihenfolge** bearbeitet: Mit Ticket
`NN` darf erst begonnen werden, wenn Ticket `NN - 1` implementiert, getestet,
dokumentiert und als erledigt markiert wurde.

| Reihenfolge | Ticket | Status | Abhaengigkeit |
| --- | --- | --- | --- |
| 01 | [Sub-Agent-Steuerung und Darstellung](./01-sub-agent-steuerung-und-darstellung.md) | offen | – |
| 02 | [Notification- und To-do-Status vereinheitlichen](./02-notification-und-todo-status-vereinheitlichen.md) | offen | 01 |
| 03 | [Mobile Inbox mit Kategorien und Badges](./03-mobile-inbox-tabs-und-badges.md) | offen | 02 |
| 04 | [Mobile Chat und Browser-Use stabilisieren](./04-mobile-chat-und-browser-use-stabilisieren.md) | offen | 03 |
| 05 | [Files-Tab automatisch aktualisieren](./05-files-tab-automatisch-aktualisieren.md) | offen | 04 |
| 06 | [Mobile Notizen von WebView zu nativ migrieren](./06-mobile-notizen-native-migration.md) | offen | 05 |
| 07 | [Session-Liste typografisch korrigieren](./07-session-liste-typografie.md) | offen | 06 |
| 08 | [Dateien nach Nutzung sortieren und anpinnen](./08-dateien-sortieren-und-anpinnen.md) | offen | 07 |

## Gemeinsame Arbeitsregeln

- Jedes Ticket bleibt bis zur vollstaendigen Abnahme der alleinige aktive
  Arbeitsschritt. Folge-Tickets werden nicht parallel implementiert.
- Vor Umsetzung sind betroffene Datenfluesse, API-Vertraege und Plattformen zu
  inventarisieren; der konkrete Umfang wird im Ticket fortgeschrieben.
- Backend-Aenderungen muessen die Datenisolation sowie die Berechtigungspruefung
  auf dem Server erhalten. Der Client ist keine Autoritaet fuer Nutzer-,
  Workspace- oder Agenten-Scope.
- Die Expo-App liegt in einem separaten Repository. Mobile-Tickets definieren
  daher hier Server-Vertraege und Abnahmekriterien; ihre Client-Implementierung
  wird im Mobile-Repository referenziert und getestet.
- Fuer jedes Ticket: relevante automatisierte Tests, `npm run build` bei
  Server-/Web-Aenderungen und eine manuelle Produktabnahme dokumentieren. UI-
  oder End-to-End-Tests mit Playwright/Chrome nur nach expliziter Freigabe.
- Der Abschluss eines Tickets erfordert einen eigenen, fokussierten Commit.

## Bestehende Referenzen

- [To-do-Zentrale, Notifications und Session-Ungelesen-Flow](../todo-notification-center-plan.md)
- [Expo Mobile App – Produkt- und Umsetzungsplan](../../expo-mobile-app-plan.md)
- Bereits gemeldeter Browser-Gateway-Validierungsfehler (separat dokumentiert)
