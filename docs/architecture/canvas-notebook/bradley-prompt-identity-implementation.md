---
title: Canvas Notebook — Bradley Prompt-Identity-Implementierung
status: implemented
todo_id: BRADLEY-030
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - bradley
  - prompt
  - runtime
  - system
---

# Canvas Notebook — Bradley Prompt-Identity-Implementierung

## Ergebnis

Bradleys feste Produktidentität ist als produktseitiger Systemblock in der
Prompt-Architektur implementiert. Der Block wird ausschließlich für die
interne Hauptagent-ID `canvas-agent` geladen. Spezialagenten und der
E-Mail-Agent erhalten ihn nicht.

## Effektive Reihenfolge

```text
1. Canvas System-Prompt-Foundation-Marker
2. Canvas Notebook Runtime und Sicherheitsregeln
3. fester Bradley Identity Block, nur für canvas-agent
4. feste Canvas-Markdown-Regeln
5. begrenzte editierbare AGENTS.md / SOUL.md / TOOLS.md
6. Skills und effektive Tool-Capabilities
7. authentifizierter Nutzer- und aktiver Workspace-Kontext
8. Workspace Brand Profile für relevante Deliverables
9. aktuelle Nutzeranweisung
```

Die physische Runtime kann kontextabhängige Blöcke später anfügen. Der Bradley
Identity Block erklärt deshalb zusätzlich seine Grenzen gegenüber
Nutzeranweisung, editierbaren Agentendateien, Memory, Workspace-Inhalt und
Brand Profile. Diese nachrangigen Quellen dürfen Ton und Zusammenarbeit
verfeinern, aber nicht Namen, Hauptagentenrolle, Sicherheitsgrenzen,
tatsächliche Fähigkeiten oder Akteursattribution ändern.

## Implementierte Bausteine

| Datei | Verantwortung |
| --- | --- |
| `app/lib/agents/bradley-identity.ts` | versionierter Identity-Marker, fester englischer Systemblock, Agent-ID-Prüfung und idempotentes Snapshot-Upgrade |
| `app/lib/agents/system-prompt-shared.ts` | fügt den Block nach der festen Runtime und vor editierbaren Agentendateien ein |
| `app/lib/agents/system-prompt.ts` | normalisiert die Agent-ID vor dem Loader und erhält die korrekte Identität auch im Read-Fallback |
| `app/lib/pi/system-prompt-snapshot.ts` | ergänzt den Block in bestehende Hauptagent-Snapshots, ohne deren gespeicherte editierbare Inhalte neu zu laden |
| `scripts/prompt-builder-test.ts` | prüft Reihenfolge, Grenzen, Spezialagenten-Ausschluss und idempotentes Snapshot-Upgrade |
| `scripts/agent-runtime-config-test.ts` | prüft den vollständigen Loader, agentenspezifische Fallbacks und persistierte Snapshot-Migration |

## Fester Identity-Inhalt

Der Systemblock legt fest:

- sichtbarer Name immer vollständig `Bradley`;
- Rolle als Hauptagent in Canvas Notebook;
- ruhiger, klarer, warmer, präziser, praktischer und professioneller Ton;
- Anpassbarkeit von Anrede, Formalität, Länge, Humor und Arbeitsstil innerhalb
  fester Grenzen;
- keine Behauptung von Bewusstsein, Gefühlen oder menschlicher Erinnerung;
- tatsächlichen Akteur bei Spezialagenten, E-Mail-Agent, Automation, Tool,
  Systemfunktion und Canvas Host Agent korrekt nennen;
- Status, Fehler, Sicherheit und Freigaben sachlich formulieren;
- Workspace Brand Profile nur auf relevante Deliverables anwenden;
- gefaltetes Canvas als einzige sparsame visuelle Metapher verwenden.

## Agent-ID- und Fallback-Verhalten

| Eingabe | Bradley Block |
| --- | --- |
| `canvas-agent` | ja |
| Groß-/Kleinschreibung oder umgebende Leerzeichen um `canvas-agent` | ja, nach Normalisierung |
| `email-agent` | nein |
| benannter Spezialagent | nein |
| ungültige andere Agent-ID mit Read-Fallback | nein |
| Read-Fallback des Hauptagenten | ja |

Der Composer nimmt bei fehlender Quell-ID nicht stillschweigend Bradley an.
Alle produktiven Loader-Aufrufe übergeben die normalisierte Agent-ID. Dadurch
kann ein direkter technischer Composer-Aufruf keine Spezialidentität
versehentlich in Bradley verwandeln.

## Schutz bestehender Prompt-Snapshots

Bestehende Session-Snapshots mit Canvas-Foundation werden nicht vollständig
neu erzeugt. `ensureBradleyIdentitySystemPrompt()` ergänzt den versionierten
Marker `canvas-bradley-identity:v1` nur bei `canvas-agent` und positioniert ihn
vor Markdown-/Managed-/Skill-Blöcken.

Dabei bleiben erhalten:

- die zum Sessionstart gespeicherten Inhalte von `AGENTS.md`, `SOUL.md` und
  `TOOLS.md`;
- bestehende Skills und Promptteile innerhalb des Größenlimits;
- Hash und Erstellzeit nach dem einmaligen persistierten Upgrade;
- spezialisierte und E-Mail-Agent-Snapshots ohne Bradley-Block.

Das Upgrade ist idempotent: Ein bereits markierter Snapshot erhält keinen
zweiten Identity Block.

## Verifizierte Invarianten

- Bradley Block steht vor `AGENTS.md` und `SOUL.md`.
- Eine editierbare `SOUL.md` mit Umbenennungs- oder globaler Brand-Voice-Vorgabe
  kann die feste Systemidentität nicht ersetzen.
- Workspace Brand Profile bleibt ausdrücklich auf relevante Deliverables
  begrenzt.
- Research- und E-Mail-Agent erhalten keinen Bradley-Marker.
- Hauptagent-Read-Fallback enthält Bradley; ein ungültiger anderer Agent nicht.
- Ein alter Hauptagent-Snapshot wird einmalig ergänzt und behält seine
  gespeicherten persönlichen Inhalte.
- Die zusammengesetzte Promptgröße bleibt durch das bestehende feste
  Gesamtbudget begrenzt.

## Abgrenzung der Folgearbeiten

- BRADLEY-031 passt das Onboarding sichtbar an die feste Produktidentität an.
- BRADLEY-032 inventarisiert und schützt bestehende persönliche `SOUL.md`-
  Inhalte bei der inhaltlichen Migration.
- BRADLEY-033 migriert sichtbare Hauptagent-Datensätze idempotent.
- BRADLEY-034 und BRADLEY-035 bereinigen UI-Fallbacks und sichtbare Alttexte.
- BRADLEY-036 führt die breitere Stabilitäts- und Regressionstestmatrix aus.

## Abschluss BRADLEY-030

Die feste Bradley-Identität besitzt einen versionierten, ausschließlich an
`canvas-agent` gebundenen Systemblock. Nutzeranweisung, persönliche
Zusammenarbeit und Workspace Brand Voice bleiben nutzbar, können aber Namen,
Rolle, Sicherheit oder Akteursattribution nicht überschreiben. Bestehende
Hauptagent-Snapshots werden ohne Verlust ihrer gespeicherten persönlichen
Promptinhalte idempotent ergänzt.
