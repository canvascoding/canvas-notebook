---
title: 'Ticket 15: Legacy-Auto-Update und Managed Bootstrap entkoppeln'
status: open
priority: high
depends_on: ['11-lizenztypen-und-control-plane-handshake-testen']
platforms: [server, cli, control-plane, vm-agent]
repositories: [canvasstudios-notebook, canvas-control-plane]
tags: [type/bug, topic/updates, topic/control-plane, topic/cli]
---

# Ticket 15: Legacy-Auto-Update und Managed Bootstrap entkoppeln

## Problem

Bei Control-Plane-gemanagten Updates ueberschneiden sich Legacy-Auto-Update,
Canvas-Notebook-CLI, VM-Agent und Bootstrap. Dabei tritt unter anderem
„Legacy Auto-Update did not become inactive before bootstrap“ auf. Ownership,
Locking und Reihenfolge der Updatepfade sind nicht eindeutig genug.

## Zielzustand

- Pro Deployment-Modus besitzt genau ein Orchestrator die Update-Autoritaet.
- Managed Mode deaktiviert und bestaetigt Legacy-Auto-Update vor Bootstrap,
  waehrend Standalone weiterhin den vorgesehenen lokalen Pfad nutzen kann.
- CLI, Agent und Bootstrap teilen einen versionierten Zustandsautomaten mit
  Locking, Timeout, Recovery und aussagekraeftiger Diagnose.
- Gleichzeitige Updateversuche koennen keine parallelen Container, verlorenen
  Zustand oder endlose Bootstrap-Schleife erzeugen.

## Umsetzung

- Sequenzdiagramm aller Timer, systemd-Units, CLI-Kommandos, Agent-Befehle,
  Locks, Markerdateien und Bootstrap-Schritte in beiden Repositories erstellen.
- Deployment-Modus und Update-Owner vor jeder Mutation serverseitig/lokal
  eindeutig aufloesen; Legacy-Scheduler im Managed Mode idempotent stoppen.
- Gemeinsamen Lock- und Statusvertrag mit atomaren Uebergaengen, Stale-Lock-
  Behandlung, Timeout und Rollback definieren.
- Fehlertext um aktuellen Owner, Zustand und sichere Recovery-Anweisung
  erweitern, ohne Secrets oder interne Tokens auszugeben.
- Race zwischen geplantem Auto-Update, manuellem CLI-Update, Agent-Update und
  Neustart deterministisch testen.

## Abnahmekriterien

- Im Managed Mode kann nur der Control-Plane-/Agent-Pfad ein Update starten;
  Legacy-Auto-Update ist vor Bootstrap nachweislich inaktiv.
- Im Standalone-Modus bleibt der dokumentierte Updatepfad funktionsfaehig.
- Parallel gestartete Befehle fuehren zu genau einem Update und einem klaren
  Busy-/Retry-Ergebnis fuer alle weiteren Aufrufer.
- Abbruch, VM-Neustart und Stale Lock lassen sich ohne Datenverlust erholen.

## Tests und Abschluss

- Deterministische Lock-/Race-/Restart-Tests in beiden Repositories und
  isolierter Managed-/Standalone-Testplan.
- Vor Containerbau `npm run build`; nie mehrere Testcontainer parallel und
  jeden Lauf nur mit frisch erstelltem Stand, jeweils nach expliziter Freigabe.
- Eigener Commit je Repository, danach Status im [Index](./README.md) setzen.
