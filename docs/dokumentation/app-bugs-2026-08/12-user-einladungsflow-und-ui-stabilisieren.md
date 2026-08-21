---
title: 'Ticket 12: User-Einladungsflow und scrollbare UI stabilisieren'
status: open
priority: high
depends_on: ['11-lizenztypen-und-control-plane-handshake-testen']
platforms: [web, server]
tags: [type/bug, topic/user-management, topic/invitations, topic/ui]
---

# Ticket 12: User-Einladungsflow und scrollbare UI stabilisieren

## Problem

Die User-Management-Seite bzw. der Einladungsdialog ist nicht durchgaengig
scrollbar. Ausserdem muessen alle Schritte von Einladung und Vorschau ueber
Annahme bis Seat-Aktivierung, Ablauf und erneuter Einladung fachlich und
technisch erneut geprueft werden.

## Zielzustand

- Der gesamte Einladungsflow ist auf kleinen und grossen Viewports per Maus,
  Touch und Tastatur erreichbar.
- Rolle, Workspace-Zugriff, Seat-/Lizenzauswirkung, Ablauf und aktueller Status
  werden vor dem Absenden eindeutig angezeigt.
- Einladung, Annahme, Aktivierung, Widerruf, Ablauf und erneuter Versand sind
  idempotent und serverseitig berechtigt.
- Fehler lassen den Nutzer in einem korrigierbaren, nachvollziehbaren Zustand.

## Umsetzung

- `UserManagementPanel`, Dialog-/Sheet-Container und globale Overflow-Regeln
  inventarisieren; Scroll-Lock und verschachtelte Scrollbereiche korrigieren.
- UI-Schritte und API-Vertraege fuer Quote, Einladung, Preview, Accept,
  Activate und Revoke als Zustandsmaschine dokumentieren.
- Rollen-, Workspace-, Organization- und Seat-Pruefungen serverseitig an jedem
  Uebergang erzwingen; Race-Conditions und doppelte Klicks behandeln.
- Abgelaufene, bereits angenommene, widerrufene und doppelte Einladungen mit
  stabilen Status- und Fehlermeldungen darstellen.
- Accessibility, Fokusfuehrung, mobile Safe Areas und langen Inhalt pruefen.

## Abnahmekriterien

- Auf kleinem Viewport sind alle Formularfelder, Hinweise und Aktionen ohne
  abgeschnittenen Inhalt erreichbar; Fokus wird nicht eingeschlossen.
- Unberechtigte Rollen-/Workspace-Zuweisungen und Seat-Ueberschreitungen werden
  serverseitig abgelehnt.
- Doppelte Requests erzeugen weder doppelte Mitgliedschaften noch doppelte
  Seat-Aktivierungen.
- Einladung und Annahme enden nach Reload in demselben korrekten Status.

## Tests und Abschluss

- Einladungs-/Membership-/Seat-Tests fuer alle Uebergaenge und Negativfaelle.
- `npm run build` und manuelle responsive UI-Abnahme; Browser-/E2E-Test nur
  nach expliziter Freigabe.
- Eigener Commit, danach Status im [Index](./README.md) aktualisieren.
