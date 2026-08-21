---
title: 'Ticket 24: Agent-Dateiedits buendeln und Stale-State-Feedback verbessern'
status: open
priority: medium
depends_on: ['18-agent-system-prompts-an-tools-koppeln']
platforms: [server, agent-runtime]
tags: [type/improvement, topic/agents, topic/tools, topic/files, topic/developer-experience]
---

# Ticket 24: Agent-Dateiedits buendeln und Stale-State-Feedback verbessern

## Problem

Die Dateiwerkzeuge verhalten sich grundsaetzlich korrekt, werden von Agenten
aber nicht immer effizient eingesetzt. Mehrere schnelle `edit_file`-Aufrufe
auf dieselbe Datei verwenden leicht einen veralteten `expectedSha256`, wenn der
Agent zwischen den Mutationen weder den neuen `afterSha256` uebernimmt noch die
Datei erneut liest. Der zweite oder spaetere Edit wird dann zu Recht abgelehnt,
wirkt fuer Nutzer und Agent jedoch wie ein unerwarteter Toolfehler.

Der Grundprompt erwaehnt `apply_patch` bereits fuer mehrere koordinierte
Ersetzungen und Toolresultate liefern den neuen Hash. Die Entscheidungsmatrix,
strukturierte Fehlerhilfe und testbare Runtime-Guidance sind aber noch nicht
stark genug, damit Agenten verlaesslich den passenden Workflow waehlen.

## Zielzustand

- Agenten verwenden `edit_file` fuer eine einzelne kleine Ersetzung und
  `apply_patch` fuer mehrere bekannte Aenderungen derselben oder mehrerer
  Dateien.
- Vor einem Edit wird der aktuelle Zustand gelesen. Nach einer erfolgreichen
  Mutation kann der Agent fuer einen bewusst sequenziellen Folge-Edit den
  zurueckgegebenen `afterSha256` verwenden; bei Unsicherheit oder fremden
  Aenderungen liest er erneut.
- Eine grosse strukturelle Umschreibung verwendet nur nach aktuellem Read den
  dafuer zulaessigen Schreib-/Review-Pfad. Aktive Live-Collaboration-Dokumente
  duerfen nicht per Whole-File-Write umgangen werden.
- Stale-State-Fehler erklaeren strukturiert, dass sich die Datei geaendert hat,
  und empfehlen `read` plus neue Planung bzw. gebuendeltes `apply_patch`.
- Revision-, Workspace-, Collaboration- und Berechtigungspruefungen bleiben
  unveraendert autoritativ; es gibt keinen blinden Auto-Retry.

## Umsetzung

- Prompt- und Tooltexte in `base-system-prompt.ts`, `core-tools.ts` und den
  effektiven Toolbeschreibungen aus Ticket 18 auf eine eindeutige Matrix
  vereinheitlichen:
  - einzelne kleine Ersetzung: `edit_file`;
  - mehrere vorab bekannte Ersetzungen: ein `apply_patch`;
  - grosse strukturelle Umschreibung: aktueller `read`, danach nur der fuer den
    Dateityp und Collaboration-Zustand erlaubte Write-/Review-Pfad;
  - unklarer oder moeglicherweise veraenderter Zustand: erneut `read`.
- Pruefen, ob Mutationsergebnisse `afterSha256`, geaenderten Pfad,
  Collaboration-/Review-Status und eine maschinenlesbare Folgeaktion in allen
  Runtime-Adaptern unverkuerzt an das Modell weitergeben.
- Hash-/Revision-Konflikte mit stabilem Fehlercode, aktuellem sicheren Hash und
  `recommendedAction: read_then_retry` ausgeben. Bei wiederholten Mutationen
  derselben Datei im selben Run zusaetzlich auf einen gebuendelten Patch
  hinweisen, ohne einen nicht mehr sicheren Edit automatisch zu wiederholen.
- Bewerten, ob die Runtime aufeinanderfolgende `edit_file`-Aufrufe desselben
  Pfads zaehlen und ab dem zweiten Aufruf einen nicht blockierenden Hinweis
  liefern soll. Inhalte duerfen dafuer nicht in Telemetrie persistiert werden.
- Sicherstellen, dass `apply_patch` alle Ersetzungen vorab prueft, pro Datei
  einen konsistenten Ausgangshash verwendet und bei einem Preflight-Fehler
  keine Teilmutation als vollstaendig erfolgreich meldet.
- Toolresultate und UI-Darstellung so formulieren, dass „Sicherheitskonflikt“,
  „Review erforderlich“ und „technischer Fehler“ unterscheidbar bleiben.

## Abnahmekriterien

- Ein Agent mit drei bekannten Aenderungen an derselben Datei waehlt einen
  `apply_patch`-Aufruf statt drei unkoordinierten `edit_file`-Aufrufen.
- Ein erfolgreicher Einzel-Edit liefert den neuen Hash eindeutig; ein bewusst
  sequenzieller Folge-Edit kann ihn verwenden und bleibt revisionssicher.
- Wird die Datei zwischen Read und Edit von einem Nutzer, einer Automation oder
  einem anderen Agenten geaendert, erfolgt keine stille Wiederholung oder
  Ueberschreibung. Das Resultat fordert zum erneuten Lesen und Neuplanen auf.
- Ein Stale-Fehler enthaelt einen stabilen Code und eine maschinenlesbare
  Folgeaktion; Prompt und Toolbeschreibung verwenden dieselben Begriffe.
- Live-Collaboration-Dokumente folgen weiterhin dem Yjs-/Review-Pfad aus Ticket
  23 und werden weder durch `write` noch durch einen Auto-Retry umgangen.
- Einzelne Edits, Multi-File-Patches, nicht kollaborative Dateien und persoenliche
  sowie Team-Workspaces zeigen keine Berechtigungs- oder Revisionsregression.

## Tests und Abschluss

- Prompt-Builder- und Tool-Registry-Tests fuer die Entscheidungsmatrix und die
  effektiven, tatsaechlich verfuegbaren Tooltexte.
- Runtime-Tests fuer Einzel-Edit, gebuendelten Patch, `afterSha256`-Weitergabe,
  mehrere Edits desselben Pfads, externe Zwischenmutation und strukturierten
  Stale-State-Fehler.
- Integrationsmatrix fuer normale Dateien, Shared-Workspace-Revisionsguard und
  aktive Live Collaboration; keine inhaltshaltige Telemetrie.
- `npm run build` nach Runtime-/Server-Aenderungen.
- Manuelle Agent-Abnahme anhand derselben Mehrfach-Edit-Aufgabe vor und nach der
  Aenderung; Browser-/Playwright-Test nur nach expliziter Freigabe.
- Eigener fokussierter Commit, danach Status im [Index](./README.md)
  aktualisieren.
