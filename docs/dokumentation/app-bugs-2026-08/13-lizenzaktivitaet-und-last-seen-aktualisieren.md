---
title: 'Ticket 13: Lizenzaktivitaet und Last-Seen im Control Plane aktualisieren'
status: open
priority: medium
depends_on: ['11-lizenztypen-und-control-plane-handshake-testen']
platforms: [server, control-plane, vm-agent]
repositories: [canvasstudios-notebook, canvas-control-plane]
tags: [type/bug, topic/licensing, topic/telemetry, topic/control-plane]
---

# Ticket 13: Lizenzaktivitaet und Last-Seen im Control Plane aktualisieren

## Problem

Das im Control Plane angezeigte „zuletzt gesehen“ fuer lizenzierte Instanzen
oder Seats wird nicht verlaesslich aktualisiert. Dadurch laesst sich die Zahl
tatsaechlich aktiver Lizenzen nicht belastbar auswerten.

## Zielzustand

- Eine dokumentierte Aktivitaetsdefinition unterscheidet Instanzkontakt,
  Lizenz-Refresh, Agent-Heartbeat und gegebenenfalls aktive Seats.
- Das Control Plane aktualisiert `lastSeen` regelmaessig, monoton und nur nach
  authentifiziertem Kontakt.
- UI und Auswertung zeigen aktive, inaktive, offline tolerierte und abgelaufene
  Lizenzen anhand eines klaren Zeitfensters.
- Die Erfassung bleibt datensparsam und enthaelt keine Nutzerinhalte.

## Umsetzung

- Bestehende Heartbeat-, Lizenz-Refresh- und Agent-Pfade in beiden Repositories
  inventarisieren und eine autoritative Quelle pro Aktivitaetstyp festlegen.
- Persistenzfelder, Zeitzone, Clock-Skew, Debouncing und Updatefrequenz
  definieren; Schreiblast und verlorene Updates beruecksichtigen.
- Signierten bzw. authentifizierten Heartbeat/Refresh so erweitern, dass ein
  erfolgreicher Kontakt die passende Aktivitaet aktualisiert.
- Control-Plane-UI und Reporting mit dokumentiertem Aktivitaetsfenster,
  Zeitstempel und erklaerenden Zustaenden ausstatten.
- Restart, Offline-Phase, Retry, veraltete Events und Lizenzwechsel testen.

## Abnahmekriterien

- Ein aktiver Testserver aktualisiert `lastSeen` innerhalb des definierten
  Fensters; ein gestoppter Server wird nach Ablauf als inaktiv ausgewiesen.
- Spaet eintreffende Events koennen einen neueren Zeitstempel nicht
  zuruecksetzen.
- Ungueltige oder fremde Heartbeats veraendern keine Lizenzaktivitaet.
- Dashboard-Zahl und Detailansicht basieren auf derselben Definition.

## Tests und Abschluss

- Fake-Clock-, Auth-, Retry-, Offline- und Reporting-Tests in beiden
  Repositories sowie Abnahme in der isolierten Umgebung aus Ticket 11.
- `npm run build` in geaenderten Web-/Server-Repositories; Container nur nach
  expliziter Freigabe.
- Eigener Commit je Repository, danach Status im [Index](./README.md) setzen.
