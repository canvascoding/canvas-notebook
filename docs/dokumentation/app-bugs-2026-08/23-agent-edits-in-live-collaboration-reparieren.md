---
title: 'Ticket 23: Agent-Edits in Live-Collaboration-Dokumenten reparieren'
status: open
priority: high
depends_on: []
platforms: [web, server, agent-runtime]
tags: [type/bug, topic/agents, topic/live-collaboration, topic/markdown, topic/tools]
---

# Ticket 23: Agent-Edits in Live-Collaboration-Dokumenten reparieren

Der codebestandsnahe, strikt sequenzielle Plan liegt in
[Ticket 23: Umsetzungsplan](./23-agent-edits-in-live-collaboration-umsetzungsplan.md).

## Problem

In einem Team-Workspace kann ein KI-Agent Markdown- bzw. Textdokumente mit
aktiver Live Collaboration nicht zuverlaessig bearbeiten. Das `edit_file`-Tool
schlaegt in diesem Zustand fehl, obwohl Agent-Edits laut bestehender
Collaboration-Architektur ueber den aktuellen Yjs-State laufen sollen.

Der Code enthaelt bereits einen vorgesehenen Pfad fuer Live-Reads,
zielverankerte Yjs-Transaktionen und strukturelle Review-Operationen. Daher muss
zuerst reproduziert werden, an welcher realen Integrationsgrenze der Tool-Call
scheitert, statt die Collaboration-Logik parallel neu zu implementieren.

## Zielzustand

- Ein berechtigter Agent liest bei aktiver Collaboration den autoritativen
  Live-Yjs-State und kann einen stabilen, nicht konkurrierenden Markdown- oder
  Textabschnitt mit `edit_file` bearbeiten.
- Strukturelle, mehrdeutige oder konkurrierende Markdown-Aenderungen erzeugen
  eine persistierte Accept-/Reject-Review-Operation statt eines generischen
  Toolfehlers oder eines Whole-File-Overwrite.
- Alle verbundenen Clients sehen erfolgreiche Agent-Aenderungen live; Yjs-
  Persistenz und Datei-Checkpoint erreichen nachvollziehbare Durability-Status.
- Nutzer-, Agent-, Session-, Workspace- und Dokumentidentitaet werden bei jedem
  Apply serverseitig revalidiert. Presence oder Clientparameter erweitern keine
  Berechtigung.

## Umsetzung

- Den Fehler mit einem echten Team-Workspace, mindestens zwei berechtigten
  Nutzern, einem aktiven Markdown-Dokument und einem realen Agent-Tool-Call
  reproduzieren. Toolresultat, redigierte Serverursache, Dokumentstatus,
  Representation, Live-Hash und Operationsstatus erfassen.
- Den Lauf von `core-tools.ts` ueber `agent-file-operations.ts` bis
  `agent-file-edits.ts`, Collaboration-Persistenz und Direct Connection
  nachverfolgen. Insbesondere pruefen:
  - ob `AgentExecutionContext` den korrekten Nutzer, Agenten, die Session und
    den Team-Workspace enthaelt;
  - ob Pfad und `collaborationDocumentId` auf denselben aktiven Datensatz
    aufgeloest werden;
  - ob `read` den Live-Yjs-Hash liefert und `edit_file` genau diesen Hash gegen
    denselben kanonischen Live-State prueft;
  - ob Rich-Markdown-Targets, Review-Fallback, Idempotency-Key, Direct
    Connection und Persistence-/Checkpoint-Bestaetigung erreicht werden;
  - ob der reale Runtime-Tooladapter Fehlerdetails oder Collaboration-Resultate
    verliert bzw. faelschlich als allgemeinen Edit-Fehler darstellt.
- Eine gemeinsame serverseitige Action-Grenze fuer Read/Prepare/Apply erhalten
  und nur die belegte Integrationsluecke schliessen. Aktive Yjs-Dokumente duerfen
  niemals auf normalen Whole-File-Write oder Checkpoint-Text zurueckfallen.
- Stale-Hash- und semantische Konflikte mit stabilen Fehlercodes und einer
  konkreten Read-again-/Review-Anweisung an Agent und UI zurueckgeben.
- Review- und Durability-Status im Toolresultat so erhalten, dass Runtime und UI
  zwischen angewendet, zur Pruefung, Konflikt, degraded und fehlgeschlagen
  unterscheiden koennen.

## Abnahmekriterien

- In einem Team-Workspace bearbeiten User A und User B dasselbe Live-Dokument;
  ein von einem berechtigten Nutzer gestarteter Agent aendert parallel einen
  nicht ueberlappenden Absatz erfolgreich und beide Clients konvergieren.
- `read` und anschliessendes `edit_file` verwenden denselben Live-Yjs-State.
  Eine zwischenzeitliche Aenderung erzeugt einen klaren Stale-/Konfliktpfad und
  ueberschreibt keine menschliche Arbeit.
- Eine strukturelle Rich-Markdown-Aenderung erscheint als persistierte Review
  mit funktionierendem Accept und Reject; ein einfacher stabiler Edit wird
  direkt angewendet.
- Nach erfolgreichem Apply folgen `applied_to_ydoc`, `persisted_yjs` und
  `checkpointed_file` in korrekter Reihenfolge. Bei Persistence-Fehler wird kein
  falscher Saved-Status gemeldet.
- Fremde Nutzer, Agenten, Sessions oder Workspaces koennen das Dokument weder
  auslesen noch mutieren. Entzogene Schreibrechte greifen vor dem Apply.
- Nicht kollaborative Markdown-/Textdateien und persoenliche Workspaces zeigen
  keine Regression im bestehenden `edit_file`- und `apply_patch`-Verhalten.

## Tests und Abschluss

- Bestehende Tests in `scripts/file-agent-operation-integration-test.ts` um den
  konkret reproduzierten Runtime-/Context-Fehler erweitern, nicht nur direkte
  Service-Happy-Paths testen.
- Tool-Runtime-, Workspace-/Identity-, Live-Hash-, Stale-State-, Review-,
  Idempotenz-, Reconnect-, Persistence- und Restart-Tests ergaenzen.
- `npm run build` nach Server-/Web-Aenderungen.
- Manuelle Abnahme mit zwei Browser-Sessions und echtem Agent-Tool-Call;
  Playwright-/Browser-E2E nur nach expliziter Freigabe.
- Eigener fokussierter Commit, danach Status im [Index](./README.md)
  aktualisieren.
