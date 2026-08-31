---
title: Canvas Notebook — Bradley Display-Name-Migration
status: implemented
todo_id: BRADLEY-033
decision_date: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - bradley
  - database
  - migration
  - display-name
---

# Canvas Notebook — Bradley Display-Name-Migration

## Ergebnis

Der integrierte Hauptagent wird in neuen SQLite- und PostgreSQL-Datenbanken mit
dem sichtbaren Namen `Bradley` angelegt. Bestehende Datensätze mit der internen
ID `canvas-agent` werden beim zentralen Laden ausschließlich dann umbenannt,
wenn ihr Name exakt dem bekannten Altstandard `Canvas Agent` entspricht.

Andere Namen werden als bewusste oder externe Anpassung behandelt und bleiben
unverändert. Die interne ID, Sessions, Automationen, Pfade und API-Verträge
bleiben bei `canvas-agent`.

## Migrationsregel

| Agent-ID | bisheriger Name | Ergebnis |
| --- | --- | --- |
| `canvas-agent` | `Canvas Agent` | einmalig `Bradley` |
| `canvas-agent` | `Bradley` | keine Änderung |
| `canvas-agent` | jeder andere Name | keine Änderung |
| jede andere ID | beliebiger Name | nicht im Umfang |

Die Prüfung ist absichtlich case- und whitespace-sensitiv. Eine ähnlich
aussehende Zeichenkette reicht nicht für eine automatische Änderung.

## Idempotenz und Nebenwirkungen

`ensureCanvasAgent()` aktualisiert den Namen mit einer zusätzlichen
Datenbankbedingung auf den zuvor gelesenen Altwert. Damit kann ein paralleler
Aufruf eine zwischenzeitliche Anpassung nicht zurücksetzen. Nur der tatsächlich
ausgeführte Migrationsschritt erhöht `revision` und `updatedAt`.

Ein weiterer Aufruf mit `Bradley` oder einem individuellen Namen ist ein No-op.
Unverändert bleiben insbesondere:

- `agent_id = canvas-agent`;
- Typ `main` und Löschschutz;
- Scope und Berechtigungen;
- Provider-, Modell- und Thinking-Defaults;
- Tools, Skills und Connections;
- gespeicherte Sessions, Delegationen und Automationen;
- verwaltete Dateien einschließlich `SOUL.md`.

## Implementierte Bausteine

| Datei | Verantwortung |
| --- | --- |
| `app/lib/agents/registry.ts` | kanonischer Display-Name und exakte Legacy-Migration beim zentralen Laden |
| `app/lib/db/migrate.ts` | Bradley als SQLite-Erstwert |
| `app/lib/db/postgres.ts` | Bradley als PostgreSQL-Erstwert |
| `scripts/agent-display-name-migration-test.ts` | frischer Datensatz, Altwertmigration, Wiederholung und Erhalt eines individuellen Namens |
| `package.json` | gezielter Testbefehl `test:agent:bradley-display-name` |

## Abgrenzung

- Die UI-Fallbacks sind im
  [Bradley UI-Fallback-Inventar](./bradley-ui-fallback-inventory.md)
  vereinheitlicht.
- Sie ändert keine sichtbaren Texte außerhalb des Agent-Datensatzes; deren
  Inventar folgt in BRADLEY-035.
- Sie verändert keine internen IDs oder Speicherpfade; die breite Absicherung
  folgt in BRADLEY-036.
- Sie verändert keine persönlichen `SOUL.md`-Inhalte; dafür gilt der
  [Bradley SOUL.md-Migrationsschutz](./bradley-soul-migration-safety-contract.md).

## Abschluss BRADLEY-033

Neue Hauptagent-Datensätze heißen Bradley. Der einzige bekannte alte
Standardname wird exakt einmal migriert, während jeder andere vorhandene Name
und alle technischen Agentenbezüge erhalten bleiben.
