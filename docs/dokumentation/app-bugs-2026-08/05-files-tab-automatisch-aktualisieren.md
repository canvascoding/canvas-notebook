---
title: 'Ticket 05: Files-Tab automatisch aktualisieren'
status: open
priority: medium
depends_on: ['04-mobile-chat-und-browser-use-stabilisieren']
platforms: [web, server]
tags: [type/bug, topic/files, topic/web-app]
---

# Ticket 05: Files-Tab automatisch aktualisieren

## Problem

Extern durch Agenten, Automatisierungen oder Nutzer geaenderte Dateien und
Ordner werden erst nach manuellem Refresh im Web-Files-Tab sichtbar.

## Zielzustand

Der Files-Tab aktualisiert sich zeitnah und scoped auf den aktiven Workspace.
Falls ein automatischer Reload gerade nicht sinnvoll ist, zeigt die UI klar an,
dass neue Aenderungen verfuegbar sind und laedt sie mit einer Aktion nach.

## Umsetzung

- Aktuelle Dateischreibwege, Cache-Invalidierungen und Workspace-Scope
  inventarisieren; keine Ereignisse fuer fremde Workspaces ausliefern.
- Push-Variante (bestehender WebSocket-Broadcast oder SSE) gegen begrenztes,
  sichtbarkeitsabhaengiges Polling bewerten und die Entscheidung dokumentieren.
- Ereignisse auf Dateimetadaten beschraenken: Workspace, Pfad, Aktion,
  Zeitstempel/Revision; keine Dateiinhalte ueber den Broadcast senden.
- Client nach relevanten Ereignissen gezielt invalidieren/revalidieren und
  Race-Conditions mit laufenden Navigationen, Uploads oder Mutationen
  behandeln.
- Bei nicht automatisch anwendbaren Aenderungen einen Badge/Hinweis mit
  expliziter Aktualisierungsaktion darstellen.

## Abnahmekriterien

- Eine ueber API oder Agent erzeugte Datei bzw. ein Ordner wird ohne manuellen
  Browser-Refresh im richtigen Workspace sichtbar.
- Ein Ereignis fuer Workspace A aktualisiert keinen Files-Tab in Workspace B.
- Mehrere kurz aufeinanderfolgende Aenderungen verursachen keine falsche oder
  flackernde Baumansicht.
- Fallback ohne Push-Verbindung bleibt nutzbar und macht ausstehende Aenderungen
  sichtbar.

## Tests und Abschluss

- Service-/Integrationstests fuer Scope, Eventpayload, Revalidierung und
  Burst-Aenderungen.
- `npm run build`.
- Manuelle Abnahme mit Datei- und Ordneranlage; Browser-/E2E-Test nur nach
  expliziter Freigabe.
- Eigener Commit, dann Status im [Index](./README.md) aktualisieren.
