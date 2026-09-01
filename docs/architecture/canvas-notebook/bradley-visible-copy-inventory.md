---
title: Canvas Notebook — Bradley sichtbares Copy-Inventar
status: implemented
todo_id: BRADLEY-035
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - bradley
  - automation
  - copy
  - email
  - notification
  - onboarding
---

# Canvas Notebook — Bradley sichtbares Copy-Inventar

## Ergebnis

Alle gefundenen sichtbaren Hauptagent-Referenzen in Onboarding, UI,
Agent-Management, Tool-Metadaten, Delegation, Notifications, Automation und
E-Mail verwenden Bradley oder bewusst generische Agententerminologie.

Die Prüfung unterscheidet Produktidentität von technischer Identität:

- **Bradley** ist der sichtbare feste Name des Hauptagenten.
- **Spezialagent** oder **managed agent** bleibt generisch, wenn tatsächlich ein
  anderer Agent gemeint ist.
- **`canvas-agent`** bleibt ausschließlich interne ID in Datenbank, APIs,
  Sessions, Pfaden und Tests.
- **`Canvas Agent`** bleibt nur als exakt erkannter Legacy-Datenwert und in den
  zugehörigen Negativ-/Migrationstests erhalten.

## Migrierte Flächen

| Bereich | Änderung | Begründung |
| --- | --- | --- |
| persönliches Onboarding | Bradley als fester Hauptagent in DE/EN | Produktidentität wird beim Erstkontakt klar |
| Resize- und Accessibility-Labels | `Bradley chat` / `Bradley-Chat` | sichtbare und Screenreader-Copy muss denselben Namen verwenden |
| Agent-Einstellungen | Vererbung von Bradley; Spezialagent behält eigene Identität | bisherige Copy behauptete fälschlich eine geerbte Identität |
| Agent-Management-Schutzfehler | Bradley-Profil, -Runtime, -Capabilities und -Dateien | Fehler sind für Nutzer und API-Clients sichtbar |
| Agent-Management-Tool-Metadaten | Bradley als geschützter Hauptagent | Tool-Erklärung folgt der Produktidentität |
| Delegationsfehler | „Only Bradley, the main agent …“ | Berechtigungsgrund bleibt eindeutig |
| Delegations- und Session-Toolsets | generischer `managed agent` / `agent sessions` | Ziel oder Historie kann ein Spezialagent sein |
| Kollaborationsakteur | `getAgentDisplayName()` | Hauptagent erscheint als Bradley; Spezialagenten bleiben unterscheidbar |
| To-do-Notification-E-Mail | dynamischer tatsächlicher Akteur | Bradley nur beim Hauptagenten, Spezialagent-ID sonst lesbar abgeleitet |
| Runtime-Prompt und Onboarding-Hinweise | Bradley statt alter Produktbezeichnung | verhindert Identitätskonflikte im Prompt |
| neue `AGENTS.md`-Seeds | Bradley als Hauptagent | neue Instanzen starten konsistent |
| neue `SOUL.md`-Seeds | obsolete Namenszeile entfernt | Identität gehört nicht in persönliche Präferenzen |

## Zweisprachige Settings-Copy

Die deutschen und englischen Einstellungen erklären jetzt ausdrücklich:

- Spezialagenten können Modell, Tools und User-Kontext von Bradley erben;
- Spezialagenten behalten ihre eigene Identität;
- Bradley ist der feste, nicht löschbare Hauptagent;
- geerbtes Modell, geerbte Tools und geerbte Dateien stammen sichtbar von
  Bradley.

Damit ist die frühere Aussage korrigiert, Spezialagenten würden auch Bradleys
Identität erben.

## Akteursattribution in Notification-E-Mails

Die To-do-E-Mail verwendet den tatsächlichen `sourceType` und die
`sourceAgentId`:

| Quelle | sichtbare Einleitung |
| --- | --- |
| `sourceType = agent`, ID `canvas-agent` | Bradley |
| `sourceType = agent`, Spezialagent-ID | lesbarer Name aus der ID |
| keine Agentenquelle | Canvas Notebook |

Dadurch wird Bradley nicht als Urheber einer Aktion ausgegeben, die ein
Spezialagent oder der Nutzer ausgelöst hat.

## Bewusst erhaltene Treffer

| Ort | Wert | Grund |
| --- | --- | --- |
| `app/lib/agents/registry.ts` | `Canvas Agent` | exakter Legacy-Wert für die sichere Display-Name-Migration |
| `scripts/agent-display-name-migration-test.ts` | `Canvas Agent` | positiver Legacy-Migrationsfall |
| `scripts/agent-display-fallbacks-test.ts` | `Canvas Agent` | Negativprüfung gegen zurückkehrende UI-Fallbacks |
| `scripts/onboarding-profile-test.ts` | `Canvas Agent` | Negativprüfung gegen Identität in `SOUL.md` |
| technische IDs und Pfade | `canvas-agent` | stabiler Runtime-Vertrag, kein sichtbarer Produktname |

## Verifikation

Die Abnahme umfasst:

- JSON-Parität und gezielte DE-/EN-Copy-Prüfung;
- Onboarding- und Prompt-Builder-Regression;
- Agent-Management- und Delegationstests;
- To-do-Notification-E-Mail in Deutsch und Englisch;
- Panel-/Accessibility-Label-Test;
- Display-Name-, Fallback- und Agent-Plugin-Tests;
- Quellinventar, das keine weitere produktive Zeichenkette `Canvas Agent`
  außerhalb der Legacy-Allowlist zulässt.

Eine visuelle Browserprüfung bleibt bis zur ausdrücklichen Freigabe Teil von
BRADLEY-044.

## Abschluss BRADLEY-035

Onboarding-, Notification-, Automation-, E-Mail-, Tool- und Settings-Copy ist
klassifiziert und umgesetzt. Bradley erscheint nur als Hauptagent; generische
und spezialisierte Akteure bleiben korrekt bezeichnet. Der alte sichtbare Name
existiert produktiv nur noch als absichtlich benötigter Migrationswert.
