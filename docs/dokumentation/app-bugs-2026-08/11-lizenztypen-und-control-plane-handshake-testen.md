---
title: 'Ticket 11: Lizenztypen und Control-Plane-Handshake Ende-zu-Ende testen'
status: open
priority: high
depends_on: []
platforms: [server, control-plane, vm-agent]
repositories: [canvasstudios-notebook, canvas-control-plane]
tags: [type/bug, topic/licensing, topic/control-plane, topic/e2e]
---

# Ticket 11: Lizenztypen und Control-Plane-Handshake Ende-zu-Ende testen

> Detaillierter, am aktuellen Codebestand beider Repositories ausgerichteter
> Umsetzungsplan:
> [11-lizenztypen-control-plane-handshake-umsetzungsplan.md](./11-lizenztypen-control-plane-handshake-umsetzungsplan.md)

## Problem

Lizenztypen, Claims und ihre Auswirkungen sind repositoryuebergreifend noch
nicht in einer realistischen, isolierten Umgebung vollstaendig abgenommen.
Der Handshake zwischen lokalem Control Plane, Canvas Notebook und VM-Agent muss
inklusive Development-Testlizenzen reproduzierbar funktionieren.

## Zielzustand

- Eine dokumentierte lokale Testumgebung startet einen echten Control-Plane-
  Server, Notebook-Server und erforderlichen Agenten ohne Produktionszugriffe.
- Community-, Team-, Test-, abgelaufene, widerrufene und zeitweise offline
  Lizenzen besitzen eine eindeutige Feature-, Quota- und Seat-Wirkung.
- Aktivierung, Refresh, Widerruf, Downgrade und Wiederverbindung verwenden einen
  versionierten, authentifizierten Handshake.
- Development-Testlizenzen lassen sich explizit und sicher ausgeben, erkennen
  und bereinigen.

## Umsetzung

- Zuerst einen repositoryuebergreifenden Testplan mit Ports, Datenbanken,
  Schluesseln, Zeitsteuerung, Cleanup und Netzwerkgrenzen schreiben; keine
  produktiven Secrets oder Lizenzendpunkte verwenden.
- Notebook-Vertraege in `team-seat-licensing-notebook-todo.json` und bestehende
  Control-Plane-Vertraege auf Claim-, Entitlement-, Seat- und Fehlersemantik
  abgleichen.
- Testlizenz-Ausgabe im Development-Modus mit klarer Kennzeichnung, kurzer
  Gueltigkeit und Testschluesseln bereitstellen; in Production hart sperren.
- Matrix fuer Lizenztypen und Zustandswechsel ausfuehren und Auswirkungen auf
  Features, Workspaces, Seats, Quotas und UI dokumentieren.
- Handshake auf Replay, Clock-Skew, Key-Rotation, Timeout, Offline-Grace und
  ungueltige Signaturen pruefen.

## Abnahmekriterien

- Die isolierte Umgebung ist mit dokumentierten Befehlen reproduzierbar und
  hinterlaesst keine Testdaten oder Prozesse.
- Jede Lizenzvariante liefert die erwarteten Claims und Notebook-Funktionen.
- Ungueltige, widerrufene oder Production-fremde Testlizenzen werden sicher und
  mit stabilem Fehlerzustand abgelehnt.
- Control Plane, Agent und Notebook stimmen nach Refresh und Restart ueber den
  Lizenzstatus ueberein.

## Tests und Abschluss

- Vertrags-, Integrations- und E2E-Tests in beiden Repositories; relevante
  Security-Negativfaelle einschliessen.
- Vor einem Container-Test in jedem geaenderten Web-/Server-Repository
  `npm run build`; Container nur nach expliziter Freigabe und frisch erstellt.
- Eigener Commit je Repository, danach Status im [Index](./README.md) setzen.
