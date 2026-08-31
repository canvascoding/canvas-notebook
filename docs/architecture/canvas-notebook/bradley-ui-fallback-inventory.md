---
title: Canvas Notebook — Bradley UI-Fallback-Inventar
status: implemented
todo_id: BRADLEY-034
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - bradley
  - fallback
  - registry
  - ui
---

# Canvas Notebook — Bradley UI-Fallback-Inventar

## Ergebnis

Alle inventarisierten sichtbaren Namens-Fallbacks für den integrierten
Hauptagenten verwenden `Bradley`. Der kanonische Display-Name liegt in einem
client- und serverseitig nutzbaren Modul. Registry, Chat, Home-Composer und
Automationsauswahl referenzieren damit denselben Wert.

Die interne ID bleibt `canvas-agent`. Namen von Spezialagenten werden weiterhin
aus ihrem Profil oder lesbar aus ihrer ID abgeleitet.

## Kanonische Quelle

```ts
export const MAIN_AGENT_DISPLAY_NAME = 'Bradley';
```

Die Konstante liegt in `app/lib/agents/main-agent.ts`. Das Modul enthält kein
`server-only` und kann daher von Client-Komponenten verwendet werden. Die
Server-Registry re-exportiert den Wert für bestehende serverseitige Aufrufer.

## Inventarisierte Fallbacks

| Oberfläche | Vorher | Jetzt | Auslöser |
| --- | --- | --- | --- |
| zentrale `getAgentDisplayName()`-Auflösung | `Canvas Agent` | `Bradley` | keine ID oder `canvas-agent` |
| Hauptchat-Agentenliste | `Canvas Agent` | `Bradley` | Agenten-API liefert vorübergehend keine Profile |
| Home-Composer | `Canvas Agent` | `Bradley` | Agentenliste ist noch nicht geladen oder leer |
| Automations-Agentenauswahl | `Canvas Agent` | `Bradley` | Agentenliste ist leer |
| Server-Registry-Erstwert | `Canvas Agent` | `Bradley` | neuer Hauptagent-Datensatz |

Die Registry-Migration selbst ist separat in der
[Bradley Display-Name-Migration](./bradley-display-name-migration.md)
dokumentiert.

## Bewusst nicht als Fallback klassifiziert

Die folgenden Treffer sind keine Standard-Namens-Fallbacks und werden deshalb
in BRADLEY-034 nicht geändert:

- technische Prompt- und Tool-Terminologie;
- Validierungs- und Schutzfehler in Agent-Management-APIs;
- Benachrichtigungs-, Automation- und E-Mail-Sätze;
- Resize-Labels und erklärende Übersetzungstexte;
- der exakte Legacy-Wert `Canvas Agent`, den die Datenmigration erkennen muss;
- technische Akteurs-Fallbacks wie `Agent <interne-id>`.

Diese sichtbaren Texte werden in BRADLEY-035 vollständig klassifiziert. Die
interne technische Terminologie bleibt dort erhalten, wenn eine Umbenennung die
Akteurs- oder Supportklarheit verschlechtern würde.

## Regressionstest

`test:agent:bradley-fallbacks` prüft:

- den kanonischen Wert `Bradley`;
- `null`, `undefined` und `canvas-agent` in `getAgentDisplayName()`;
- die unveränderte Ableitung eines Spezialagenten wie `research-agent`;
- die Nutzung der gemeinsamen Konstante in Chat, Home und Automationen;
- das Fehlen des alten Objekt-Fallbacks `name: 'Canvas Agent'` in diesen
  Komponenten.

Eine visuelle Browserprüfung wird wegen der Repository-Regel erst nach
ausdrücklicher Freigabe im gebündelten UI-Todo BRADLEY-044 ausgeführt.

## Abschluss BRADLEY-034

Kein inventarisierter sichtbarer Hauptagent-Fallback zeigt unbeabsichtigt
`Canvas Agent`. Alle vier Runtime-/UI-Fallbackpfade und der Registry-Default
verwenden die gemeinsame Bradley-Konstante; Spezialagenten bleiben getrennt.
