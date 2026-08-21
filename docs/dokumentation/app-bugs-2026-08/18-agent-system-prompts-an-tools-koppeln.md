---
title: 'Ticket 18: Agent-System-Prompts an effektive Tools koppeln'
status: open
priority: high
depends_on: ['17-mcp-server-oauth-500-beheben']
platforms: [server, agent-runtime]
tags: [type/bug, topic/agents, topic/system-prompt, topic/tools, topic/email]
---

# Ticket 18: Agent-System-Prompts an effektive Tools koppeln

## Problem

System-Prompts koennen Faehigkeiten behaupten, die im effektiven Runtime-Toolset
nicht vorhanden sind. Der E-Mail-Agent hat beispielsweise Core-Dateiwerkzeuge
deaktiviert, erwartet laut Prompt aber Workspace-Dateizugriff. Gleichzeitig
muss er strikt auf die fuer ihn freigegebenen Tools begrenzt bleiben.

## Zielzustand

- Der finale System-Prompt wird aus dem tatsaechlich effektiven Toolset des
  konkreten Runs erzeugt, nicht aus einem statischen oder nur konfigurierten Set.
- Nicht verfuegbare Faehigkeiten werden weder beschrieben noch suggeriert.
- Der E-Mail-Agent erhaelt nach dokumentierter Produktentscheidung genau die
  erforderlichen E-Mail- und gegebenenfalls begrenzten Dateiwerkzeuge.
- Prompt und Toolregistrierung bleiben bei Reload, Delegation, Automation und
  Workspace-Wechsel konsistent.

## Umsetzung

- `base-system-prompt`, geteilte Promptbausteine, Agent-Templates, Toolsets,
  Registry, Scoped Tools und Runtime-Reload gemeinsam inventarisieren.
- Eine Capability-Beschreibung direkt aus den nach Policy gefilterten Tools
  ableiten; statische Toolbehauptungen aus allgemeinen Prompts entfernen.
- Fuer den E-Mail-Agenten festlegen, welche Workspace-Dateioperationen wirklich
  notwendig sind und sie als explizite Least-Privilege-Policy konfigurieren.
- Sicherstellen, dass Prompttext niemals Rechte erweitert: Tool-Schema und
  serverseitige Authorization bleiben autoritativ.
- Matrix fuer Hauptagent, E-Mail-Agent, Managed Agent, Sub-Agent und Automation
  sowie Tool-Reload/Providerwechsel testen.

## Abnahmekriterien

- Ein Agent ohne Dateiwerkzeuge behauptet keinen Datei-Lese-/Schreibzugriff und
  versucht bei Capability-Fragen keinen nicht vorhandenen Tool-Call.
- Ein freigegebener E-Mail-Agent kann die benoetigten Workspace-Dateien lesen,
  aber keine nicht genehmigten Datei- oder Core-Aktionen ausfuehren.
- Prompt und registrierte Toolnamen stimmen fuer jede getestete Runtime ueberein.
- Manipulierte Agentenkonfiguration kann serverseitige Rechte nicht erweitern.

## Tests und Abschluss

- Prompt-Builder-, Tool-Registry-, Agent-Profil-, Scope-, Reload-, Delegations-
  und Automations-Runtime-Tests mit positiver und negativer Toolmatrix.
- `npm run build`; Runtime-Verhalten manuell mit Testagenten abnehmen.
- Eigener Commit, danach Status im [Index](./README.md) aktualisieren.
