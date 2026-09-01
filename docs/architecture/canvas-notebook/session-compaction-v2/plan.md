# Hermes-aligned Session Compaction V2

Stand: 2026-09-01
Status: in Umsetzung
Canvas-Ausgangsstand: `0b8fda3f43e36ad165e559b8f0d155755cc1296f` inklusive des gemergten Provider-Context-Status aus PR `#106`
Hermes-Referenz: `NousResearch/hermes-agent@f293e7206b4ddd66042329442c6afebc19a8808d`

## 1. Ziel

Canvas soll die robuste und effiziente Session-Compaction des Hermes Agenten
verhaltensgleich nachbilden. Hermes ist fuer Auswahl, Pruning, Summary-Aufbau,
Trigger, Fehlerbehandlung und Anti-Thrash das ausdrueckliche Referenzsystem.

Das Ziel ist keine blinde Python-zu-TypeScript-Kopie. Uebernommen werden:

- die belastbaren Hermes-Algorithmen moeglichst direkt, wenn sie pure
  Nachrichten- oder Budgetlogik enthalten;
- die Hermes-Invarianten, wenn Canvas bereits eine staerkere oder anders
  aufgebaute Persistenz besitzt;
- die Hermes-Regressionstests als in TypeScript uebersetzte Verhaltensvertraege;
- die MIT-Attribution fuer jeden wesentlichen uebernommenen oder uebersetzten
  Codeanteil.

Canvas behaelt dabei seine vollstaendige Rohhistorie, die transaktionale
Summary-Grenze und die bestehenden Workspace-Berechtigungen. Es werden keine
alten Sessionzeilen destruktiv ersetzt und keine Sessions fuer eine
Compaction rotiert.

Der Zielablauf lautet:

```text
manual | automatic | idle | pre-send | overflow
                    |
                    v
         authoritative request pressure
                    |
                    v
      select head / middle / coherent tail
                    |
                    v
 deterministic prune + exact anchor index
                    |
                    v
     chunk digests + LLM rolling summary
                    |
                    v
 validate coverage, savings and sendability
                    |
                    v
      fenced transactional summary commit
                    |
                    v
       final serialized-request hard gate
```

## 2. Lizenz- und Herkunftsregeln

Hermes Agent steht am Referenzcommit unter der MIT-Lizenz. Die Lizenz erlaubt
Nutzung, Veraenderung, Zusammenfuehrung und Weiterverteilung. Die Bedingung ist,
dass der Copyright-Hinweis `Copyright (c) 2025 Nous Research` und der
MIT-Lizenztext in Kopien oder wesentlichen Teilen erhalten bleiben.

Canvas steht unter der eigenen Sustainable Use License. Das verhindert die
Aufnahme permissiv lizenzierten MIT-Codes nicht. Fuer jede direkte oder
substanzielle Hermes-Uebernahme gelten aber folgende Gates:

1. Vor der ersten Codeuebernahme wird der unveraenderte Hermes-MIT-Text unter
   `docs/compliance/license-texts/hermes-agent-f293e720-MIT.txt` versioniert.
2. `docs/compliance/third-party-license-policy.json` erhaelt Hermes Agent als
   versionierte `additionalComponent` mit Commit, Quell-URL, MIT-Lizenz,
   Modifikationshinweis und den tatsaechlichen Auslieferungszielen.
3. Die generierten Artefakte `THIRD_PARTY_NOTICES.md` und
   `docs/compliance/third-party-components.json` werden aktualisiert.
4. Dateien mit substantiell uebersetztem Code erhalten einen kurzen Header:

   ```text
   Portions adapted from NousResearch/hermes-agent at f293e7206b4d...
   Copyright (c) 2025 Nous Research, MIT License.
   See THIRD_PARTY_NOTICES.md.
   ```

5. Jede Implementierungs-PR fuehrt in ihrer Beschreibung die uebernommenen
   Hermes-Symbole und die Canvas-Zielsymbole auf.
6. Rein nachimplementierte Ideen werden ebenfalls in der Mapping-Tabelle
   dokumentiert, brauchen aber keinen irrefuehrenden Dateikopf, wenn kein
   substanzieller Code oder Prompttext uebernommen wurde.
7. Der vorhandene Third-Party-Compliance-Test ist ein Pflicht-Gate, bevor ein
   Paket als abgeschlossen gilt.

Diese Regeln sind der technische Lizenzplan und ersetzen keine Rechtsberatung.
Die MIT-Pflichten selbst sind durch die eingecheckte Upstream-Lizenz eindeutig.

## 3. Portierungsstufen

Jede Hermes-Referenz wird vor der Implementierung einer dieser Stufen
zugeordnet:

| Stufe | Bedeutung | Vorgehen |
| --- | --- | --- |
| `DIRECT_PORT` | Pure Algorithmen, Regexe oder Begrenzungslogik passen inhaltlich direkt. | Nah am Hermes-Code nach TypeScript uebersetzen, mit Attribution und gepinnten Paritaetstests. |
| `ADAPTED_PORT` | Der Algorithmus ist passend, aber Nachrichtenmodell, Provider oder Persistenz unterscheiden sich. | Hermes-Kontrollfluss und Invarianten erhalten, Canvas-Typen und APIs verwenden, Abweichung dokumentieren. |
| `INVARIANT_ONLY` | Canvas besitzt bereits einen eigenen staerkeren Mechanismus. | Keine Kopie; Hermes-Testfall und Sicherheitsinvariante auf Canvas anwenden. |
| `DO_NOT_PORT` | Hermes-Verhalten waere fuer Canvas regressiv oder nicht anwendbar. | Ablehnung und Canvas-Ersatz im Plan festhalten. |

## 4. Hermes-zu-Canvas-Mapping

| Faehigkeit | Hermes-Referenz | Canvas-Ziel | Stufe und Rueckschluss |
| --- | --- | --- | --- |
| Modellabhaengige Trigger | [`_effective_threshold_percent`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L2999-L3014), [`_compute_threshold_tokens`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L3016-L3054) | `app/lib/pi/compaction/policy.ts`, `context-budget.ts` | `DIRECT_PORT`: effektives Inputfenster beruecksichtigt Outputreserve; Modelle unter 512K erhalten den 75-Prozent-Floor. Canvas-Overheads bleiben zusaetzliche feste Kosten. |
| Guenstiger Preflight-Gate | [`_should_run_preflight_estimate`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/turn_context.py#L340-L365) | `app/lib/pi/compaction/policy.ts` | `DIRECT_PORT`: Nachrichtenanzahl oder grobe Zeichenlast entscheidet nur, ob die teure vollstaendige Schaetzung ausgefuehrt wird. |
| Materieller Fortschritt | [`compression_made_progress`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/turn_context.py#L293-L320), [`_compression_warrants_another_preflight_pass`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/turn_context.py#L323-L338) | `app/lib/pi/compaction/policy.ts` | `DIRECT_PORT`: weitere Runde nur bei weiterhin bestehendem Druck und mehr als 5 Prozent Einsparung. |
| Geschuetzter Head mit Verfall | [`_effective_protect_first_n`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L5837-L5870), [`_protect_head_size`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L5872-L5901) | `app/lib/pi/compaction/selection.ts` | `ADAPTED_PORT`: erste drei Nicht-System-Nachrichten nur bis zur ersten erfolgreichen Compaction schuetzen; Canvas-Systemprompt bleibt ausserhalb der History. |
| Tokenbasierter Tail | [`_find_tail_cut_by_tokens`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L6216-L6350) | `app/lib/pi/compaction/selection.ts` | `ADAPTED_PORT`: Rueckwaertslauf, 1.5-fache Soft-Ceiling, mindestens drei aktuelle Nachrichten und sinnvolles Middle direkt uebernehmen; Canvas-History-Units ersetzen Python-Dicts. |
| Aktive User-/Assistant-Anker | [`_ensure_last_user_message_in_tail`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L6052-L6092), [`_ensure_last_assistant_message_in_tail`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L5994-L6030) | `app/lib/pi/compaction/selection.ts` | `ADAPTED_PORT`: letzte echte User-Anfrage und letzte sichtbare Assistant-Antwort muessen wortgetreu im Tail bleiben. Synthetische Status- und Summary-Zeilen zaehlen nicht als User-Anker. |
| Tool-Gruppen nicht teilen | Boundary-Alignment innerhalb von [`_find_tail_cut_by_tokens`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L6216-L6350) | `history-budget.ts`, `app/lib/pi/compaction/units.ts` | `INVARIANT_ONLY`: Canvas besitzt bereits History-Units. Diese werden erweitert und gegen Hermes-Faelle fuer Tool-Call/Result-Grenzen getestet. |
| Alte Tool-Ausgaben prunen | [`_prune_old_tool_results`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L3647-L3943), [`prune_tool_results_only`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L3945-L4175) | `app/lib/pi/compaction/prune.ts` | `ADAPTED_PORT`: zweiphasiges deterministisches Pruning, Mindestgroesse, Mindestgewinn und Re-Arm-Runway uebernehmen. Pi-ToolResults und Cache-Fingerprints brauchen Canvas-spezifische Umsetzung. |
| Exakter Anchor Index | [`_build_anchor_index`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L1019-L1066) | `app/lib/pi/compaction/anchors.ts` | `DIRECT_PORT`: Kategorien, Frequency/Recency-Ranking und Zeichenbudget nahezu direkt portieren; um Canvas-Sessions, Todos und Workspace-IDs erweitern. |
| Verbatim-User-Block | [`_build_verbatim_user_section`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L910-L946) | `app/lib/pi/compaction/summary-input.ts` | `DIRECT_PORT`: echte User-Texte newest-first unter Budget erhalten; synthetische User-Zeilen filtern. |
| Recovery Footer | [`_build_recovery_footer`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L948-L968) | `app/lib/pi/compaction/summary-input.ts` | `ADAPTED_PORT`: auf das bereits vorhandene Canvas-Tool `session_search` und die konkrete Session-ID verweisen. |
| Chunk Digests | [`_build_chunk_digests`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L4434-L4517) | `app/lib/pi/compaction/summary-generator.ts` | `ADAPTED_PORT`: sequentielle Digests mit identifier-erhaltendem Prompt uebernehmen; Canvas-StreamFn, Abbruchsignal und Summary-Modell verwenden. |
| Begrenzter Summary-Input | [`_bound_summary_input`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L4519-L4549) | `app/lib/pi/compaction/summary-input.ts` | `DIRECT_PORT`: Head und Tail des Summary-Inputs erhalten, ausgelassene Mitte explizit markieren und nie den Summarizer selbst ueberladen. |
| Rolling LLM Summary | [`_generate_summary`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L4582-L5432) | `app/lib/pi/compaction/summary-generator.ts`, `session-summary.ts` | `ADAPTED_PORT`: iterative vorherige Summary, Aux-Modell-Feasibility, Timeout- und Fehlerklassifizierung uebernehmen; Pi-Provider-Aufruf und Sicherheitswrapper bleiben Canvas-native. |
| Fokus-Compaction | [`_derive_auto_focus_topic`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L5434-L5500), `focus_topic` in [`compress`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L7134-L7211) | Runtime-Compact-Command und UI | `ADAPTED_PORT`: optionaler Fokus beeinflusst Priorisierung, darf aber die Pflichtanker und aktive Aufgabe nicht verdraengen. |
| Progress-aware Timeout | [`CompressionCommitFence`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/conversation_compression.py#L469-L559), Timeout-Policy in `conversation_compression.py` | `session-compaction-coordinator.ts` | `INVARIANT_ONLY`: Canvas-Commit-Fence bleibt. Ergaenzt werden Idle- und Total-Deadline sowie Summary-Stream-Fortschritt. Ein begonnener DB-Commit wird nicht mitten in der Transaktion verlassen. |
| Session-Lock und Watermark | Lock-/Watermark-Abschnitt in [`compress_context`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/conversation_compression.py#L2255-L2520) | `session-compaction-store.ts`, `session-compaction-coordinator.ts` | `INVARIANT_ONLY`: Canvas besitzt bereits dauerhafte Attempt-Zeilen, Unique-Active-Lock, Summary-Revision und Sequence-Fence. Hermes-Faelle fuer parallele Forks und Live-Tail-Adoption werden als Tests portiert. |
| Finale Pre-API-Pruefung | Pre-API-Block in [`conversation_loop.py`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/conversation_loop.py#L2491-L2776) | `LivePiRuntime.finalizeContextCandidate` | `ADAPTED_PORT`: exakt den vollstaendig normalisierten Canvas-Request pruefen; Retry nur bei materiellem Fortschritt. |
| Manuell und Idle | `force` in [`compress_context`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/conversation_compression.py#L2255-L2410), [`_should_idle_compact`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/turn_context.py#L368-L430) | `LivePiRuntime.compactNow`, optionaler Idle-Scheduler | `ADAPTED_PORT`: manuell umgeht Cooldown einmal und darf vor Auto-Threshold arbeiten; Idle ist opt-in und respektiert Floor, Lock und Breaker. |
| Statischer Fallback | [`_build_static_fallback_summary`](https://github.com/NousResearch/hermes-agent/blob/f293e7206b4ddd66042329442c6afebc19a8808d/agent/context_compressor.py#L4177-L4432) | Summary-Fehlerpfad | `DO_NOT_PORT` als autoritative Abdeckung: Canvas darf bei LLM-Ausfall die Summary-Grenze nicht mit einer semantisch unvollstaendigen Fallback-Summary vorziehen. Ein Fallback darf Diagnose/Anchors erzeugen, aber keine History als vollstaendig abgedeckt committen. |
| Session-Rotation oder Transcript-Rewrite | In-place/Legacy-Persistenz in `conversation_compression.py` | Canvas-Session-Store | `DO_NOT_PORT`: Canvas behaelt Rohhistorie plus Summary-Projektion; keine Rotation und kein Soft-Archive als Voraussetzung fuer Compaction. |

## 5. Canvas-Zielstruktur

Die pure und wiederverwendbare Mechanik lebt unter `app/lib/pi/compaction/`:

```text
app/lib/pi/compaction/
  types.ts              gemeinsame strukturierte Inputs und Ergebnisse
  policy.ts             Trigger, Zielbudget, Fortschritt, Breaker
  units.ts              koharente User/Assistant/Tool-Einheiten
  selection.ts          Head/Middle/Tail-Auswahl
  prune.ts              Tool-, Medien-, Skill- und Replay-Pruning
  anchors.ts            mechanischer exakter Anchor Index
  summary-input.ts      Redaction, Verbatim-User, Recovery, Bounds
  summary-generator.ts  Digests und LLM Rolling Summary
  validation.ts         Coverage-, Anchor-, Groessen- und Sendability-Gates
```

Diese Dateien erhalten keine DB-Zugriffe und keine versteckten
Runtime-Singletons. Sie akzeptieren explizite Parameter und liefern
strukturierte Ergebnisse.

Die Orchestrierung bleibt in:

- `session-compaction-coordinator.ts`: Attempt-Lifecycle, Timeout,
  Fehlerklassifizierung, Retry und Commit-Fence;
- `session-compaction-store.ts`: dauerhafte Locks, Revisionen, Sequenzen und
  Telemetrie;
- `live-runtime.ts`: Manual-, Automatic-, Idle- und Pre-Send-Ausloeser;
- `automations/history-compaction.ts`: Automation-Policy bei identischer
  Compaction-Mechanik;
- UI-Hooks: Benutzerfeedback und Fokus-Eingabe.

Damit wird Hermes' grosse `ContextCompressor`-Klasse nicht als God-Service
nachgebaut. Die einzelnen, gut getesteten Hermes-Faehigkeiten bleiben trotzdem
erkennbar und koennen gegen ihren Ursprung verglichen werden.

## 6. Strikt sequenzielle Arbeitspakete

### SC-P00: Referenz, Lizenz und Baseline sperren

Hermes-Rueckschluss:

- Der Referenzcommit und die Defaultwerte aus `hermes_cli/config_defaults.py`
  werden als Fixtures gepinnt.
- Die Hermes-MIT-Lizenz wird vor jeder substanziellen Uebernahme inventarisiert.

Umsetzung:

1. PR `#106` mergen und neuen Branch von aktualisiertem `main` erstellen.
2. Hermes-MIT-Komponente und Lizenztext in Canvas' Compliance-System aufnehmen.
3. Eine maschinenlesbare Paritaetsfixture mit Hermes-Defaults anlegen:
   Threshold `0.50`, Small-Context-Floor `0.75`, `protect_first_n=3`,
   `protect_last_n=20`, `target_ratio=0.20`, maximal drei Versuche.
4. Bereinigte reale Canvas-Fixtures fuer die bekannten Overflow- und
   falschen-Status-Faelle aufnehmen.
5. Aktuelle Canvas-Ergebnisse als Baseline messen, ohne sie als Sollverhalten
   festzuschreiben.

Gate:

- Lizenz- und Notice-Tests sind gruen.
- Jede spaetere Task besitzt eine Hermes-Referenz und eine Portierungsstufe.
- Provider-Ist-Nutzung und Next-Request-Schaetzung sind getrennt.

Umsetzungsstand 2026-09-01: abgeschlossen. PR `#106` ist als
`0b8fda3f43e36ad165e559b8f0d155755cc1296f` gemergt. Der Hermes-MIT-Text,
die zusaetzliche Compliance-Komponente, die gepinnten Hermes-Defaults und die
bereinigten Canvas-Baselines sind versioniert und durch
`test:pi:compaction-v2-baseline`, `test:licenses`,
`test:pi:context-budget`, `test:pi:compaction-ui` und
`test:pi:live-compaction` abgesichert.

### SC-P01: Policy und Pressure Engine portieren

Hermes-Rueckschluss:

- `_effective_threshold_percent`, `_compute_threshold_tokens`,
  `_should_run_preflight_estimate`, `compression_made_progress` und
  `_compression_warrants_another_preflight_pass` werden direkt portiert.

Umsetzung:

1. `compaction/policy.ts` als pure Capability anlegen.
2. Effektives Inputbudget aus Modellfenster minus Outputreserve und allen
   Canvas-spezifischen festen Requestkosten berechnen.
3. Modell- und absolute Token-Overrides ermoeglichen.
4. Cheap-Gate und autoritative Vollschaetzung trennen.
5. 5-Prozent-Fortschrittsregel und maximale Rundenzahl einfuehren.
6. Provider-Ist-Nutzung aus PR `#106` fuer Kalibrierung verwenden, niemals als
   Ersatz fuer die naechste Request-Schaetzung.

Gate:

- 32K-, 128K-, 262K-, 512K- und 1M-Fixtures entsprechen der Hermes-Policy.
- Outputreserve kann nicht zu einem unmoeglichen Trigger bei 100 Prozent
  fuehren.
- Kein Request wird nur wegen Nachrichtenanzahl als sicher klassifiziert.

Umsetzungsstand 2026-09-01: abgeschlossen. Die pure Policy in
`app/lib/pi/compaction/policy.ts` portiert Small-Window-Floor, Modell- und
Token-Overrides, Cheap-Gate, autoritative Next-Request-Entscheidung sowie die
strikte Fortschrittsgrenze von mehr als fuenf Prozent. Context-Snapshot und
History-Komposition rechnen jetzt mit dem effektiven Inputbudget nach
Outputreserve und festen Canvas-Requestkosten. Paritaets-, Context-, Summary-,
UI-Vertrags-, Coordinator-, Store-, Live- und Automationstests sowie
TypeScript, ESLint, Lizenzpruefung und Produktionsbuild sind gruen.

### SC-P02: Head/Middle/Tail und Tool-Atomaritaet portieren

Hermes-Rueckschluss:

- Head-Verfall, Rueckwaerts-Tailwalk, Soft-Ceiling und aktive Anker werden aus
  den genannten Hermes-Funktionen uebernommen.
- Canvas' bestehende History-Units werden als staerkerer atomarer Unterbau
  beibehalten.

Umsetzung:

1. `units.ts` und `selection.ts` implementieren.
2. Echte und synthetische User-Zeilen eindeutig klassifizieren.
3. Tool-Call und alle zugehoerigen Results atomar halten.
4. Initialen Head schuetzen und nach erfolgreicher Compaction verfallen lassen.
5. Tokenbasierten Tail mit Minimum, Soft-Ceiling und letztem User-/Assistant-
   Anker waehlen.
6. Legacy- und Lean-Tail-Budget als Policyvarianten anbieten.

Gate:

- Aktive User-Anfrage und letzte Assistant-Antwort bleiben bytegleich.
- Kein Tool-Result ist verwaist.
- Jede Auswahl besitzt ein sinnvolles komprimierbares Middle oder liefert einen
  erklaerten No-op.

Umsetzungsstand 2026-09-01: abgeschlossen. Canvas gruppiert parallele und
verschachtelte Tool-Transaktionen vor jeder Auswahl atomar und legt darauf die
Hermes-Selektion mit verfallendem Drei-Nachrichten-Kopf, tokenbudgetiertem
Tail, Acht-Nachrichten-Floor und 1,5-fachem Soft-Ceiling. Echte User-Anfragen
und sichtbare Assistant-Antworten bleiben Anker; synthetische Summary- und
Leerzeilen zaehlen nicht. Legacy- und Lean-Tail (`2,5 %`, `10K` bis `25K`)
sind abgedeckt. Pure Selection-, Context-, Summary-, Live-, Automation-,
Coordinator-, Store- und UI-Vertragstests sowie TypeScript, ESLint und der
Produktionsbuild sind gruen.

### SC-P03: Deterministisches Pruning portieren

Hermes-Rueckschluss:

- Zweiphasiges Tool-Pruning, Mindestgroesse, Mindestgewinn, Re-Arm-Runway,
  historische Medien und Skill-Reload-Marker werden aus Hermes adaptiert.

Umsetzung:

1. Alte grosse Tool-Results zu strukturierten Stubs verkleinern.
2. Low-Signal-Acks und leere Erfolgsantworten aus Digest-Inputs entfernen.
3. Nur die neuesten relevanten Bilder im aktiven Tail behalten; aeltere
   Payloads durch sichere Metadaten ersetzen.
4. Veraltete Reasoning-/Replay-Sidecars entfernen.
5. Verlorene Skill-Bodies mit einem kanonischen Reload-Marker kennzeichnen.
6. Proaktives Pruning standardmaessig deaktiviert lassen, bis Cache- und
   Kostenmessungen den Hermes-Trade-off bestaetigen.

Gate:

- Pruning ist idempotent.
- Ein Commit erfolgt nur oberhalb des Mindestgewinns.
- Letzte drei Nachrichten, aktive Tool-Gruppe und neueste relevante Bilder
  bleiben erhalten.

Umsetzungsstand 2026-09-01: abgeschlossen. Die pure Pruning-Capability ist
standardmaessig deaktiviert und arbeitet ohne LLM. Sie dedupliziert exakte
Tool-Ausgaben, demotiert grosse historische Results und Argumente, entfernt
alte Tool-Bilder bis auf die drei neuesten, verwirft stale Replay-Sidecars und
setzt fuer verlorene Skill-Bodies einen kanonischen, sanitisierten
`SKILL_PRUNED`-Reload-Marker. Aenderungen werden nur oberhalb des gemessenen
Reclaim-Gates uebernommen; ein Cache-Re-Arm verlangt danach eine volle
Wachstums-Runway. Idempotenz, aktive Tool-Gruppe, letzte drei Nachrichten,
Bildfenster, Low-Signal-Filter und Pressure-Tail sind getestet. TypeScript,
ESLint, Compliance und Produktionsbuild sind gruen.

### SC-P04: Anchor Index, Digests und Recovery portieren

Hermes-Rueckschluss:

- `_build_anchor_index`, `_build_verbatim_user_section` und
  `_bound_summary_input` werden nahezu direkt portiert.
- Chunk Digests und Recovery Footer werden an Pi und `session_search`
  angepasst.

Umsetzung:

1. Exakte Anchor-Kategorien mit Frequency/Recency-Ranking implementieren.
2. Canvas-spezifische Workspace-, Todo-, Automation- und Session-IDs
   ergaenzen.
3. Echte User-Texte newest-first unter eigenem Budget erhalten.
4. Lange Middle-Bereiche in chronologische Digests teilen.
5. Recovery Footer mit Session-ID und `session_search` erzeugen.
6. Redaction vor jedem Digest-, Anchor- und Summary-Persistenzschritt
   erzwingen; Anchor-Extraktion darf keine Secrets konservieren.

Gate:

- Unterstuetzte nicht-sensitive Anchors werden zu 100 Prozent erhalten.
- Secret-, URL-Credential- und Token-Fixtures tauchen weder in Summary noch
  Anchor Index auf.
- Der Recovery-Hinweis verweist nur auf eine autorisierte, existierende
  Session.

Umsetzungsstand 2026-09-01: abgeschlossen. Die Recovery-Capability extrahiert
PRs, SHAs, Branches, Dateien, Fehler, URLs, Versionen, UUIDs sowie Canvas-
Workspace-, Todo-, Automation- und Session-IDs mechanisch und priorisiert sie
nach Frequenz und Aktualitaet. Echte User-Texte bleiben newest-first
wortgetreu, abgesehen von zwingender Secret-Redaktion. Der bereinigte
Transcript wird lueckenlos in chronologische SHA-256-Chunks zerlegt;
Low-Signal-Tool-Acks werden herausgefiltert und optionale pristine Tool-Bodies
bleiben fuer Digests nutzbar. `session_search`-Footer entstehen nur bei exakt
passender Autorisierung und vorhandener Capability. Das Summary-Input ist bei
160K Zeichen mit explizitem Middle-Marker begrenzt. Der 175-KB-Regressionstest
laeuft ohne Regex-Backtracking-Probleme; TypeScript, ESLint, Compliance und
Produktionsbuild sind gruen.

### SC-P05: Rolling LLM Summary und Fokus adaptieren

Hermes-Rueckschluss:

- Iterative Summary, Digests, Fokus, Aux-Modell-Feasibility und Input-Bounds
  folgen `_generate_summary` und `compress`.
- Die Hermes-Prompttexte koennen mit MIT-Attribution direkt uebernommen und an
  Canvas' Summary-Schema angepasst werden.

Umsetzung:

1. Summary-Vertrag versionieren.
2. Vorherige Summary, Digests, Verbatim-User-Block, Anchor Index, offene
   Aufgaben und Recovery Footer in stabiler Reihenfolge zusammensetzen.
3. Optionales `focusTopic` durch API, Runtime und Prompt fuehren.
4. Summary-Modell gegen eigenes Kontextfenster und Outputreserve pruefen.
5. Summary-Stream mit Idle- und Total-Timeout instrumentieren.
6. Ergebnis auf Pflichtabschnitte, aktive Aufgabe, Anchors, Groesse und
   Prompt-Injection-Grenzen validieren.
7. Bei LLM-Ausfall keine autoritative Summary-Grenze committen.

Gate:

- Mehrere Compaction-Zyklen verlieren keine bereits erhaltenen Fakten.
- Fokus priorisiert, darf Pflichtanker aber nicht entfernen.
- LLM-Fehler, leere Antwort und Timeout lassen die Rohhistorie unveraendert.

Umsetzungsstand 2026-09-01: abgeschlossen. Der versionierte
`canvas-session-summary:v2`-Vertrag erzeugt zunaechst chronologische,
SHA-adressierte Segment-Digests und danach eine Rolling Summary mit stabilen
Pflichtabschnitten. Vorherige Summary, exakte Anchors, echte User-Texte,
optionaler Fokus und autorisierter Recovery-Footer werden unter festen
Input- und Outputgrenzen zusammengefuehrt. Das Summary-Modell wird vor jedem
Call gegen sein eigenes Kontextfenster samt Outputreserve geprueft; Idle- und
Total-Timeout sowie Stream-Fortschritt sind getrennt sichtbar. Secrets werden
vor dem Providerprompt und erneut vor Persistenz redigiert. Leere, gekappte,
fehlerhafte oder prompt-injizierte Antworten sowie erfundene User-Provenienz
scheitern geschlossen und verschieben keine Summary-Grenze. Legacy bleibt bis
zur Runtime-Umschaltung in SC-P07 der Default. Multi-Zyklus-, Fokus-,
Zero-User-, Timeout-, Providerfehler-, Injection-, Redaktions-, TypeScript-,
ESLint- und Legacy-Kompatibilitaetstests sind gruen.

### SC-P06: Coordinator, Store und Anti-Thrash haerten

Hermes-Rueckschluss:

- Progress-aware Timeout, Lock-Konkurrenz, Watermark-Adoption, persistenter
  Breaker und Attempt-Telemetrie werden als Invarianten uebernommen.
- Canvas' bestehender Coordinator und Store werden nicht durch Hermes'
  Session-Persistenz ersetzt.

Umsetzung:

1. Attempt-Telemetrie um Trigger, Pressure vorher/nachher, Regionen,
   Anchor-Anzahl, Summary-Modell, Dauer, Fortschritt und Fehlerklasse erweitern.
2. Idle- und Total-Deadline trennen.
3. Concurrent Live-Tail ueber Sequence-Watermark nach erfolgreichem Commit
   erhalten.
4. Stale Generation, Revision oder Workspace-Kontext atomar ablehnen.
5. Wiederholt ineffektive oder fehlgeschlagene automatische Versuche mit
   durablem Breaker und Re-Arm-Grenze stoppen.
6. Manuelle Versuche duerfen den Fehler-Cooldown genau einmal umgehen, aber
   nie Lock oder Commit-Fence.

Gate:

- SQLite und PostgreSQL bestehen dieselben Lock-, Timeout-, Stale- und
  Concurrent-Tail-Tests.
- Abgebrochene oder verspaetete Worker koennen nicht nachtraeglich committen.
- Kein Endlos- oder Busy-Loop bei ineffektiver Compaction.

Umsetzungsstand 2026-09-01: abgeschlossen. Coordinator und Store trennen nun
eine durch Fortschritt verlaengerbare 120-Sekunden-Idle-Deadline von der
absoluten 600-Sekunden-Grenze; spaete Worker verlieren weiterhin am
Commit-Fence. Zwei dauerhaft gespeicherte, ineffektive automatische Versuche
oeffnen fuer 300 Sekunden den Anti-Thrash-Breaker, danach ist genau ein
Recovery-Probe moeglich. Der manuelle Einmal-Bypass umgeht nur Cooldown bzw.
Breaker, niemals Lock, Generation, Revision oder Workspace-Fence. SQLite und
PostgreSQL persistieren inhaltsfreie Attempt-Telemetrie, Fortschritt, Dauer und
getrennte Timeout-Ursachen. Coordinator-, Store-, Live- und
Automationsintegrationstests sowie TypeScript und fokussiertes ESLint sind
gruen.

### SC-P07: Runtime-Trigger und finale Sendability integrieren

Hermes-Rueckschluss:

- Turn-Preflight, Pre-API-Gate, Overflow-Recovery, manuelles `force` und
  optionales Idle-Verhalten werden aus `turn_context.py`,
  `conversation_loop.py` und `conversation_compression.py` adaptiert.

Umsetzung:

1. Live-Chat und Automationen auf dieselben Compaction-Capabilities umstellen.
2. Automatischen Preflight nur nach Cheap-Gate und Pressure-Entscheidung
   ausfuehren.
3. Den vollstaendig normalisierten Request unmittelbar vor Provideraufruf
   erneut pruefen.
4. Maximal definierte Retry-Runden nur bei mehr als 5 Prozent Fortschritt.
5. Provider-Overflow einmal klassifiziert in denselben Recoverypfad leiten.
6. Manuellen Compact-Button vor Auto-Threshold zulassen, sobald ein Middle mit
   materiellem Einsparpotential existiert.
7. Idle-Compaction als opt-in Policy implementieren.

Gate:

- Kein absichtlich uebergrosser finaler Request erreicht den Provider.
- Manual funktioniert vor dem Auto-Trigger oder liefert einen konkreten No-op,
  keine generische Fehlermeldung.
- Live-Chat und Automationen haben identisches Auswahl- und Summary-Verhalten.

### SC-P08: Statusleiste und Bedienung korrigieren

Hermes-Rueckschluss:

- Hermes trennt reale Provider-Nutzung, Rough Estimate, Threshold und
  Compaction-Status. Canvas bildet dieselbe Semantik sichtbar ab.

Umsetzung:

1. Letzte Provider-Input-Nutzung und naechste Request-Schaetzung getrennt
   darstellen.
2. Effektives Inputbudget, Triggerlinie und Zielbereich sichtbar machen.
3. Vorher/nachher, zusammengefasste Nachrichten und Triggergrund anzeigen.
4. Optionalen Fokus ohne Pflichtdialog anbieten.
5. No-op, Cooldown, Timeout, Lock, feste-Kontext-Ueberlastung und
   Summary-Providerfehler konkret unterscheiden.
6. UI-Texte Deutsch und Englisch pflegen.

Gate:

- Die Bar verwendet dieselbe Pressure-Quelle wie der Trigger.
- Direkt nach Compaction ist erkennbar, dass die niedrigere Fuellung der
  Zielstand und nicht der vorherige Triggerstand ist.
- UI/E2E wird auf `localhost:3000` nach expliziter Freigabe fuer Playwright
  geprueft.

### SC-P09: Shadow-Rollout, Defaultwahl und Abschluss

Hermes-Rueckschluss:

- Hermes bietet Legacy- und Lean-Tail bewusst als Modi an und deaktiviert
  cachebrechende Micro-Compaction standardmaessig. Canvas uebernimmt diesen
  vorsichtigen Rollout.

Umsetzung:

1. V2-Auswahl und erwartete Einsparung zunaechst im Shadow-Modus messen.
2. Deterministische Auswahl/Anchors vor LLM-Summary V2 aktivieren.
3. Legacy und Lean anhand realer Sessions vergleichen.
4. Default erst nach Recall-, Kosten-, Cache- und Latenzgates festlegen.
5. Micro-Compaction nicht in V2 aufnehmen; eigenes spaeteres Vorhaben nur nach
   belastbarer Cachemessung.
6. V1 als Rollback behalten und erst nach stabiler Betriebsphase entfernen.
7. `detect_changes` gegen `main`, gezielte Tests, Lint, Production-Build und
   genehmigte UI-Pruefung abschliessen.

Gate:

- Null bekannte History-Verluste.
- Null verwaiste Tool-Gruppen.
- 100 Prozent Anchor-Erhalt in den unterstuetzten Kategorien.
- Jede erfolgreiche Runde spart mehr als 5 Prozent und endet sendbar oder mit
  einem expliziten sicheren Fehler.
- Statusanzeige und Trigger stimmen in allen getesteten Providern ueberein.

## 7. Hermes-Testuebernahmematrix

Hermes-Tests werden nicht nur als Inspiration gelesen. Fuer jede Gruppe wird
ein aequivalenter Canvas-Test angelegt und im PR auf den Upstream-Test
verwiesen:

| Canvas-Testgruppe | Zu portierende Hermes-Testfamilien |
| --- | --- |
| Policy und kleine Fenster | `test_compression_small_ctx_threshold_floor.py`, `test_per_model_compression_threshold.py`, `test_preflight_compression_gate.py` |
| Auswahl und Tool-Grenzen | `test_compressor_actionable_tail_anchor.py`, `test_compressor_assistant_tail_anchor.py`, `test_compressor_tail_cut_tool_pair_floor.py`, `test_compressor_tail_cut_oob_fix.py` |
| Medien und Pruning | `test_compressor_historical_media.py`, `test_compressor_media_stripping.py`, `test_compressor_stale_tool_images.py`, `test_proactive_tool_result_pruning.py`, `test_ghost_skill_pruning.py` |
| Summary-Kontinuitaet | `test_context_compressor_summary_continuity.py`, `test_context_compressor_temporal_anchoring.py`, `test_context_compressor_zero_user_provenance.py`, `test_compress_focus.py` |
| Fallback und Sicherheit | `test_compression_fallback_budget.py`, `test_compaction_redaction_boundaries.py`, `test_compress_signal_leak.py`, `test_summary_prefix_semantics.py` |
| Lock, Timeout und Concurrency | `test_compression_watermark_commit.py`, `test_hermes_state_compression_locks.py`, `test_compression_concurrent_fork.py`, `test_compress_context_progress_timeout.py`, `test_compression_closed_adoption.py` |
| Anti-Thrash | `test_compaction_anti_thrash.py`, `test_compression_anti_thrash_persistence.py`, `test_compression_anti_thrash_recovery.py`, `test_infinite_compaction_loop.py` |
| Runtime und finaler Request | `test_preflight_compression_cap_e2e.py`, `test_uncompressed_context_guardrail.py`, `test_post_tool_compression_attempt_cap.py`, `test_1630_context_overflow_loop.py` |
| Manuell und Idle | `test_manual_compress.py`, `test_compress_focus.py`, `test_idle_compaction.py`, `test_idle_compaction_lock_and_guards.py` |

Ein Canvas-Test gilt erst als Paritaetsbeleg, wenn er dieselbe Invariante und
nicht lediglich denselben Funktionsnamen prueft.

## 8. PR- und Commitfolge

Wegen des kritischen Blast-Radius werden keine gestapelten, ungemergten
Umbauten begonnen. Die Reihenfolge ist strikt:

1. PR A: `SC-P00` bis `SC-P02` – Lizenz, Baseline, Policy und Auswahl.
2. PR B: `SC-P03` bis `SC-P05` – Pruning, Anchors, Digests und LLM-Summary.
3. PR C: `SC-P06` und `SC-P07` – Store, Coordinator und Runtime-Integration.
4. PR D: `SC-P08` und `SC-P09` – UI, Shadow-Rollout und Abschluss.

Innerhalb eines PRs erhaelt jedes abgeschlossene Arbeitspaket einen eigenen
fokussierten Commit. Das naechste Paket beginnt erst, wenn Tests und Gate des
vorherigen Pakets bestanden sind. Vor jedem Symbol-Edit wird GitNexus-Impact
ausgefuehrt; vor jedem Commit folgt `detect_changes({scope: "compare",
base_ref: "main"})`.

## 9. Bekannte Risiken

GitNexus stuft `composePiHistoryForLlm` und `runPiSessionCompaction` wegen der
gemeinsamen Nutzung durch Live-Chat und Automationen als `CRITICAL` ein;
`LivePiRuntime` ist `HIGH`. Daraus folgen diese Schutzmassnahmen:

- pure Hermes-Ports zuerst hinter Tests, bevor Runtime-Aufrufer umgestellt
  werden;
- genau ein migrierter Aufrufer pro Schritt;
- kein Big-Bang-Rewrite von `live-runtime.ts`;
- Feature Flag und Shadow-Telemetrie vor Defaultwechsel;
- Rohhistorie bleibt jederzeit recoverbar;
- LLM-Ausfall darf nie als erfolgreiche semantische Abdeckung gelten;
- Prompts, Anchor Index und Telemetrie duerfen keine Secrets konservieren;
- proaktive und Micro-Compaction werden wegen Prompt-Cache-Kosten nicht ohne
  Messung aktiviert.

## 10. Definition of Done

Session Compaction V2 ist erst abgeschlossen, wenn:

1. jede implementierte Faehigkeit auf eine konkrete Hermes-Funktion oder eine
   bewusst dokumentierte Canvas-Abweichung verweist;
2. uebernommener Hermes-Code und Prompttext MIT-konform inventarisiert und
   attribuiert sind;
3. manuelle Compaction vor der automatischen Schwelle funktioniert;
4. automatische, Idle-, Pre-Send- und Overflow-Pfade dieselbe Engine verwenden;
5. aktive User-Anfrage, letzte Assistant-Antwort und Tool-Gruppen intakt bleiben;
6. nicht-sensitive exakte Anchors in den unterstuetzten Kategorien vollstaendig
   erhalten bleiben;
7. LLM-Ausfall, Timeout, Stale-Generation oder Konkurrenz keine History
   verlieren und keine falsche Summary-Grenze committen;
8. der finale serialisierte Request vor Provideraufruf sicher in das effektive
   Fenster passt;
9. Provider-Ist-Nutzung, naechste Request-Schaetzung, Trigger und Zielstand im
   UI semantisch uebereinstimmen;
10. SQLite, PostgreSQL, Live-Chat und Automationen dieselben relevanten
    Paritaetstests bestehen;
11. Third-Party-Compliance, gezielte Tests, Lint und `npm run build` erfolgreich
    sind;
12. die UI nach expliziter Browserautomationsfreigabe auf `localhost:3000`
    verifiziert wurde.

Der ausfuehrbare Taskstand liegt neben diesem Dokument in `todo.json`.
