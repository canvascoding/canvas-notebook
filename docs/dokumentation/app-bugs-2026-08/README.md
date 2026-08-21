---
title: App-Fehler August 2026 – sequenzielle Ticketliste
date: 2026-08-21
status: open
tags:
  - type/bug-tracker
  - status/open
  - topic/canvas-agent
---

# App-Fehler August 2026 – sequenzielle Ticketliste

Diese Tickets zerlegen die gesammelten App-, Runtime-, Control-Plane- und
Mobile-Befunde in abnahmefaehige Arbeitspakete. Die Nummerierung dient der
Orientierung, nicht als globale Sperre: Ein Ticket darf starten, sobald seine
in der Tabelle und im Front Matter genannten fachlichen Abhaengigkeiten
abgeschlossen sind.

| Reihenfolge | Ticket | Status | Abhaengigkeit |
| --- | --- | --- | --- |
| 01 | [Sub-Agent-Steuerung und Darstellung](./01-sub-agent-steuerung-und-darstellung.md) | erledigt | – |
| 02 | [Notification- und To-do-Status vereinheitlichen](./02-notification-und-todo-status-vereinheitlichen.md) | offen | 01 |
| 03 | [Mobile Inbox mit Kategorien und Badges](./03-mobile-inbox-tabs-und-badges.md) | offen | 02 |
| 04 | [Mobile Chat und Browser-Use stabilisieren](./04-mobile-chat-und-browser-use-stabilisieren.md) | offen | 03 |
| 05 | [Files-Tab automatisch aktualisieren](./05-files-tab-automatisch-aktualisieren.md) | offen | 04 |
| 06 | [Mobile Notizen von WebView zu nativ migrieren](./06-mobile-notizen-native-migration.md) | offen | 05 |
| 07 | [Session-Liste typografisch korrigieren](./07-session-liste-typografie.md) | offen | 06 |
| 08 | [Dateien nach Nutzung sortieren und anpinnen](./08-dateien-sortieren-und-anpinnen.md) | offen | 07 |
| 09 | [Administrator-E-Mail-Setup reparieren](./09-administrator-email-setup-reparieren.md) | in Abnahme | – |
| 10 | [Automationen, UI und Workspace-Zuordnung pruefen](./10-automationen-ui-und-workspace-zuordnung-pruefen.md) | offen | – |
| 11 | [Lizenztypen und Control-Plane-Handshake Ende-zu-Ende testen](./11-lizenztypen-und-control-plane-handshake-testen.md) | offen | – |
| 12 | [User-Einladungsflow und scrollbare UI stabilisieren](./12-user-einladungsflow-und-ui-stabilisieren.md) | offen | 11 |
| 13 | [Lizenzaktivitaet und Last-Seen im Control Plane aktualisieren](./13-lizenzaktivitaet-und-last-seen-aktualisieren.md) | offen | 11 |
| 14 | [To-do-Sichtbarkeit, Filter und Priorisierung korrigieren](./14-todo-sichtbarkeit-filter-und-priorisierung.md) | offen | 02 |
| 15 | [Legacy-Auto-Update und Managed Bootstrap entkoppeln](./15-legacy-auto-update-und-managed-bootstrap-entkoppeln.md) | offen | 11 |
| 16 | [Persoenliches ChatGPT-Abo im Team-Workspace nutzbar machen](./16-chatgpt-abo-im-team-workspace-stabilisieren.md) | offen | – |
| 17 | [Exponierten MCP-Server und OAuth-500 beheben](./17-mcp-server-oauth-500-beheben.md) | offen | – |
| 18 | [Agent-System-Prompts an effektive Tools koppeln](./18-agent-system-prompts-an-tools-koppeln.md) | offen | – |
| 19 | [Word- und Excel-Werkzeuge evaluieren](./19-word-und-excel-werkzeuge-evaluieren.md) | offen | – |
| 20 | [Agenten-Tools fuer To-do-Verwaltung und Mobile Notifications erweitern](./20-todo-agent-tools-und-mobile-notifications.md) | offen | 02, 14 |
| 21 | [MARP-Praesentationen auf Mobile korrekt rendern](./21-marp-mobile-rendering-korrigieren.md) | offen | – |
| 22 | [MARP-YAML und Formatierung beim Editorwechsel erhalten](./22-marp-editor-roundtrip-verlustfrei-machen.md) | offen | – |

## Gemeinsame Arbeitsregeln

- Es duerfen mehrere Tickets parallel bearbeitet werden, sofern alle expliziten
  Abhaengigkeiten abgeschlossen sind und die Tickets keine gemeinsamen
  unaufgeteilten Dateien, API-Vertraege oder Migrationen veraendern.
- Parallele Implementierungen erfolgen in getrennten Branches bzw. Worktrees.
  Fuer gemeinsame Runtime-, Datenmodell- oder API-Grenzen wird vorab ein Owner
  und ein Integrations-Commit festgelegt.
- Vor Umsetzung sind betroffene Datenfluesse, API-Vertraege und Plattformen zu
  inventarisieren; der konkrete Umfang wird im Ticket fortgeschrieben.
- Backend-Aenderungen muessen die Datenisolation sowie die Berechtigungspruefung
  auf dem Server erhalten. Der Client ist keine Autoritaet fuer Nutzer-,
  Workspace- oder Agenten-Scope.
- Die Expo-App liegt in einem separaten Repository. Mobile-Tickets definieren
  daher hier Server-Vertraege und Abnahmekriterien; ihre Client-Implementierung
  wird im Mobile-Repository referenziert und getestet.
- Control-Plane-Tickets werden in einer isolierten lokalen Testumgebung mit dem
  benachbarten Control-Plane-Repository geplant und abgenommen. Produktive
  Instanzen, Lizenzen und Updatekanaele duerfen dabei nicht verwendet werden.
- Fuer jedes Ticket: relevante automatisierte Tests, `npm run build` bei
  Server-/Web-Aenderungen und eine manuelle Produktabnahme dokumentieren. UI-
  oder End-to-End-Tests mit Playwright/Chrome nur nach expliziter Freigabe.
- Der Abschluss eines Tickets erfordert einen eigenen, fokussierten Commit.

## Parallelisierungsplan fuer Tickets 09–22

| Strang | Startbare Tickets | Harte Reihenfolge / Koordination |
| --- | --- | --- |
| E-Mail und Automationen | 09, 10 | Koordination bei gemeinsamen E-Mail-Settings; keine harte Abhaengigkeit. |
| Lizenz und Control Plane | 11 | Danach 12, 13 und 15; 13 und 15 teilen Agent-/VM-Zustaende und werden besser nacheinander integriert. |
| To-dos | 14 nach 02 | 20 erst nach 02 und 14. |
| Agent-Runtime | 16, 18 | Bei gemeinsamen Runtime-Resolver-Dateien vorab Dateigrenzen festlegen. |
| MCP | 17 | Eigenstaendig; nur OAuth-/Runtime-Schnittstellen mit 16/18 abstimmen. |
| Office-Dateien | 19 | Als Evaluation eigenstaendig; eine spaetere Tool-Implementierung mit 18 abstimmen. |
| MARP | 21, 22 | Mobile-Rendering und Web-Editor sind getrennt; gemeinsame MARP-Fixtures abstimmen. |

## Bestehende Referenzen

- [To-do-Zentrale, Notifications und Session-Ungelesen-Flow](../todo-notification-center-plan.md)
- [Expo Mobile App – Produkt- und Umsetzungsplan](../../expo-mobile-app-plan.md)
- Bereits gemeldeter Browser-Gateway-Validierungsfehler (separat dokumentiert)
