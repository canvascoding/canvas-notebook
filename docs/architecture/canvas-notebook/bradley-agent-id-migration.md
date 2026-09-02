---
title: Canvas Notebook — Bradley Agent-ID-Migration
status: implemented
todo_id: BRADLEY-037
decision_date: 2026-09-02
owners:
  - Canvas Notebook
tags:
  - agent
  - migration
  - mobile
  - database
---

# Canvas Notebook — Bradley Agent-ID-Migration

## Entscheidung

Die kanonische ID des Notebook-Hauptagenten lautet `bradley`. Die frühere ID
`canvas-agent` wird als Legacy-Alias akzeptiert und beim Einlesen auf
`bradley` normalisiert. Neue Datensätze, API-Ausgaben und Clients verwenden
ausschließlich die kanonische ID.

Der Canvas Host Agent und globale Infrastrukturpfade wie `/data/canvas-agent`
sind ein getrenntes System und werden nicht umbenannt.

## Umsetzung

- Eine zentrale Konstante und Alias-Normalisierung definieren die Hauptagent-ID.
- SQLite und PostgreSQL migrieren bestehende Agenten-, Session-, Automations-
  und weitere Agentenreferenzen transaktional von `canvas-agent` zu `bradley`.
- Spaltendefaults für neue Datensätze verwenden `bradley`.
- Eine bereits belegte, nicht zum Hauptagenten gehörende ID `bradley` stoppt die
  Migration mit einer klaren Fehlermeldung, statt Daten zusammenzuführen.
- Nutzerbezogene Dateien unter `agents/canvas-agent` werden beim ersten Zugriff
  nach `agents/bradley` kopiert. Die alte Kopie bleibt für Rollback und Diagnose
  bestehen.
- Web- und Mobile-Oberflächen erkennen während der Übergangszeit beide IDs als
  Bradley, senden für neue Vorgänge aber `bradley`.

## Abnahme

- [x] Frische SQLite-Installation verwendet `bradley`.
- [x] Bestehende SQLite-Daten und Agentendateien werden verlustfrei migriert.
- [x] PostgreSQL-Daten und Spaltendefaults werden migriert.
- [x] Bradley-UI, Starter, Animation, Auswahl und Display-Name funktionieren mit
  kanonischer und alter ID.
- [x] Produktions-Build des Notebook-Repositories ist erfolgreich.
- [ ] Mobile-App verwendet `bradley` für neue Requests und akzeptiert
  `canvas-agent` in alten Serverantworten.

## Bewusst unverändert

- Canvas Host Agent, systemd-Dienst, CLI und Control-Plane-Protokolle;
- globaler Runtime-Pfad `/data/canvas-agent`;
- historische Exportformate und Migrationsquellen;
- Komponentenordner und interne Dateinamen, deren Umbenennung keinen
  funktionalen Nutzen hat.
