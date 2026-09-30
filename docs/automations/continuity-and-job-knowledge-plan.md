# Automation-Kontinuität und Job-Wissen: Umsetzungsplan

Stand: 2026-09-28

Status: Pakete A–E implementiert und lokal abgenommen (einschließlich Browser-E2E im verwalteten Test-Stack)

Referenzstände: Canvas Notebook `4b8d4d485`, Hermes Agent `614b9b3f3c1ea8e24e6c7370bd85f9639f779bf0`

## Umsetzungsstand

| Paket | Commit | Ergebnis |
| --- | --- | --- |
| A | `3ec198a0e` | PostgreSQL-Schema, Migration, `continuityMode=off` und begrenzter Job-Zustand mit Revision/Mutation-ID |
| B | `11339b17e` | Letztes relevantes eigenes Ergebnis mit Run-Pin, Scope-Prüfung, Promptbudget und Provenienz |
| C | `2e017182f`, `19d61876e`, `761385b0a` | Nur für reguläre Automationsläufe gebundene `automation_job_state`- und `automation_run_result`-Tools |
| D | `038f20bb2` | Maximal drei Quell-Jobs, Zyklenschutz, Run-Pins, Workspace-Cutoff und redigierte Run-API |
| E | `ab00b97ee`, `01fd5f651` | Web-/Mobile-State-API, Editor-Einstellungen, Zustandsansicht, Run-Diagnose und persistierte Scheduler-Skips |
| Abnahme | `10aad6889` | Workspace-Scope-Integrationstest und reparierter bestehender npm-Testbefehl |

Bestehende Jobs behalten `off` und eine leere Quellliste. Die automatischen Kontextblöcke bleiben bei `min(2.048 Tokens, 5 % des Modellfensters)` gedeckelt; ein voller Kontext lässt den aktuellen Auftrag unverändert weiterlaufen. Ein Workspace-Wechsel setzt die Kontextgrenze und entfernt Quellverknüpfungen. Ein gelöschter Quell-Job kann als konfigurierte, nicht mehr lesbare ID verbleiben und wird beim Lauf mit `source_missing` ausgelassen. Der Scheduler und seine 90-Sekunden-Regel wurden nicht geändert.

Der Zustand ist über `GET /api/automations/jobs/:jobId/state` als Metadatenliste und über `GET .../state?key=...` für einen einzelnen Wert erreichbar. `DELETE .../state` setzt einen Schlüssel mit `expectedRevision` und `mutationId` zurück. Die Mobile-v1-Routen spiegeln den Vertrag. Run-APIs entfernen interne Retry-Pins und redigieren Quell-Run-IDs; Detailzugriffe prüfen den historischen Run-Workspace. Übersprungene, nie eingereihte Termine werden atomar als Audit-Ereignis gespeichert und getrennt von Runs im Verlauf gezeigt; die 90-Sekunden-Regel und das Ausbleiben eines Runs bleiben erhalten. Das Agent-Tool `automation_run_result` liest auf Anforderung nur das an den laufenden Run gepinnte eigene oder konfigurierte Quell-Ergebnis und begrenzt jede Antwort auf 8 KiB sowie 2.048 geschätzte Tokens.

Verifiziert wurden der Produktionsbuild, TypeScript, ESLint ohne Fehler, die gezielten Migration-/Store-/Runner-/API-/Mobile-/UI-Tests sowie Scheduler-Recovery und Delivery. `test:automation:workspace-scope` läuft mit einem eigenen PGlite-Integrationstest. Zusätzlich sind die Registry-Gates und die Größen-/Rechteprüfung des Run-Lesers getestet. Nach ausdrücklicher Freigabe wurde das aktuelle Notebook-Image im verwalteten lokalen Stack gebaut und der Container neu erstellt; Notebook, Control Plane und PostgreSQL waren gesund. `tests/automation-continuity.spec.ts` bestand gegen `http://127.0.0.1:3100` mit 2/2 Playwright-Tests: Persistenz von `last_relevant` und einer erlaubten Quelle nach Reload sowie Anzeige/Abruf/Reset von Job-Wissen und getrennte Misfire-Diagnose ohne Run. Die zweite Browserprüfung verwendet gezielte API-Fixtures für State und Misfire; die echte Scheduler-Persistenz wurde separat mit `test:automation:scheduler-recovery` geprüft. Danach liefen `test:automation:workspace-scope`, `test:automation:scheduler-recovery`, `test:automation:ui`, `test:automation:runner` und `test:automation:history-compaction` erneut erfolgreich.

## Ziel und Abgrenzung

Wiederkehrende Canvas-Automationen sollen bei Bedarf wissen, was sie beim letzten relevanten Lauf gemeldet oder verarbeitet haben. Für Cursor, Watermarks und ähnliche kleine Werte erhalten sie einen eigenen dauerhaften Zustand. Später können Jobs gezielt Ergebnisse anderer Jobs als Eingabe verwenden. Jeder dieser Kontexte bleibt klein, überprüfbar und an Job und Workspace gebunden.

Der bestehende Scheduler, die PostgreSQL-Run-Historie, der normale Pi-Agent-Harness und die dokumentierte **90-Sekunden-Skip-on-Misfire-Regel** bleiben die Grundlage. Dieser Plan führt weder eine neue Scheduler-Runtime noch eine automatische Wiederholung verpasster Termine ein. Allgemeines Agent-Memory, Job-Zustand, Run-Historie und Chat-Verlauf bleiben getrennte Konzepte.

**Nicht Teil dieses Vorhabens:** automatische Subagent-Delegation *während* eines Automationslaufs. Die unten genannten Subagenten sind für die **Entwicklung und Prüfung** der Funktion gedacht. Die bestehende Runtime-Delegation erlaubt aktuell nur Bradley-Konversationen als Quelle (`app/lib/pi/delegation-policy.ts`); ihre Öffnung für Automationen benötigt eine eigene Rechte-, Timeout- und Zustellungsentscheidung.

## Ausgangslage in Canvas

1. `scripts/automation-scheduler.js` pollt `queue-due` und `execute-ready`; `app/lib/automations/store.ts` beansprucht Jobs und Runs transaktional. Verspätete geplante Slots werden nach 90 Sekunden übersprungen (`docs/automations/scheduler-semantics.md`).
2. `automation_runs` speichert Status, Ergebnis, Fehler, Logs, Metadaten und `piSessionId`; `listAutomationRuns` zeigt die jüngsten 100. Die Historie ist damit eine gute Quelle, aber derzeit kein automatisch verwendeter Job-Kontext.
3. `app/lib/automations/runner.ts` erzeugt standardmäßig eine neue Session pro Run. Nur `fixed_session` oder eine tatsächlich gefundene `channel_active`-Session lädt früheren Chat-Verlauf. Diese Zustellungsoptionen dürfen nicht stillschweigend die Kontinuität eines Jobs definieren.
4. `app/lib/automations/prompt.ts` baut den Ausführungsprompt; `history-compaction.ts` begrenzt bestehende Session-Historie. Eine neue Job-Kontextschicht muss **vor** der finalen Budgetprüfung eingefügt werden und darf deren Kompaktierung nicht umgehen.
5. Die Agent-Definition hat bereits eigenes `MEMORY.md`. Dieses allgemeine Wissen ersetzt keine per Job geführten Cursor oder letzten Ergebnisse.

## Hermes als Inspiration

Die folgenden kurzen Zitate beziehen sich auf den lokalen Clone unter `~/Documents/hermes-agent` beim oben genannten Commit. Sie beschreiben die Inspiration, keine Vorgabe zur Übernahme der Datei- oder SQLite-Architektur.

> “Cron jobs run in isolated sessions with no memory of previous runs. But sometimes one job's output is exactly what the next job needs.”
> — Hermes, `website/docs/user-guide/features/cron.md`, Abschnitt „Chaining jobs with context_from“

Hermes kann über `context_from="self"` den letzten verwertbaren Output desselben Jobs und über Job-IDs Outputs vorheriger Jobs in den Prompt setzen (`cron/scheduler_prompt.py`). Stille/inhaltlose Audits werden übersprungen; eine Ausgabe wird auf 8.000 Zeichen begrenzt. Canvas soll dieses **explizite Kontinuitätsmodell** übernehmen, aber den bestehenden PostgreSQL-Run statt Output-Dateien verwenden.

> “Per-job durable KV notepad (cursors, watermarks) carried across cron wake-ups”
> — Hermes, `cron/notepad.py`, Modulbeschreibung

Hermes begrenzt den Notizblock auf 16 KiB je Wert und 64 KiB je Job. Für Canvas ist die Trennung zwischen dauerhaftem Job-Zustand und Antwort-Historie sinnvoll. **Nicht übernehmen:** den gesamten Notizblock bei jedem Lauf in den Prompt kopieren.

> “An empty notepad MUST return '' so jobs that never use the feature get a byte-identical prompt”
> — Hermes, `cron/notepad.py`, `render_notepad_section`

Die gleiche Eigenschaft gilt für Canvas: Ohne aktivierte oder verfügbare Kontinuität muss der bisherige Prompt unverändert bleiben. Hermes' lokaler Code lädt bei Cron-Läufen inzwischen Memory mit `skip_memory=False`; ältere `cron/AGENTS.md`-Hinweise dazu sind nicht mehr aktuell. Dieser Plan stützt sich für das Verhalten auf den Ausführungscode.

## Produktvertrag

### 1. Letztes eigenes Ergebnis

- Neue Job-Einstellung `continuityMode = off | last_relevant`; **Default `off`** für bestehende und neue Jobs bis zur bewussten Aktivierung.
- `last_relevant` wählt vor Run-Start den jüngsten **abgeschlossenen, erfolgreichen, inhaltlichen** Run desselben Jobs. `NO_ACTION`, leere Antworten, übersprungene Termine und reine Zustellfehler sind keine Kontinuitätsantwort. Fehler bleiben im Laufprotokoll und werden nicht als vorige Erfolgsmeldung ausgegeben.
- Der Kontext trägt Quelle, Run-ID, Zeitpunkt, Status und einen begrenzten Antwortauszug. Er wird als **zitierte, nicht vertrauenswürdige Daten** eingefügt; enthaltene Befehle dürfen den konfigurierten Job-Prompt nicht ändern.
- Die Auswahl wird für einen Run als Referenz in dessen Metadaten fixiert. Ein Retry desselben Runs liest dieselbe Referenz und keine inzwischen neuere Antwort. Ist die referenzierte Quelle gelöscht oder nicht mehr berechtigt, läuft der Job ohne diesen Kontext mit protokolliertem Grund.
- Ein `fixed_session`/`channel_active`-Run lädt möglicherweise denselben Inhalt bereits aus dem Chat. Die Komposition dedupliziert per Run-ID/Session-Bezug; Zustellung und Kontinuität bleiben unabhängig konfigurierbar.

### 2. Kleiner dauerhafter Job-Zustand

- Neue Tabelle für `jobId`, `key`, `value`, Revision und Änderungszeit sowie eine eindeutige, begrenzt aufbewahrte Mutation-ID je Run/Schreiboperation. FK-Löschung entfernt Zustand und Mutationsbelege zusammen mit dem Job; `jobId` ist die Isolationsgrenze, `jobScope`/Workspace wird bei jedem Zugriff am aktuellen Job erneut geprüft.
- Grenzen als Startwert: Schlüssel maximal 128 Zeichen, Wert maximal 16 KiB, gesamter Job maximal 64 KiB. Writes verwenden Compare-and-Swap auf Revision sowie eine idempotente Mutation-ID je Run, damit Retries und parallele Tool-Aufrufe keinen Zustand unbemerkt überschreiben.
- Ein einziges, nur im Automationskontext verfügbares Tool mit `get | set | delete | list` und serverseitig gebundenem `jobId`. Das Modell darf keine fremde Job-ID wählen. Große Werte werden **nur auf Abruf** gelesen; automatisch erscheinen höchstens ausdrücklich ausgewählte kleine Schlüssel oder ein kurzer Hinweis auf verfügbare Schlüssel.
- Zustand ist kein freies Agent-Memory: keine Secrets, vollständigen Logs oder großen Antworten speichern. UI/API zeigt Schlüssel, Revision und Änderungszeit; Werte nur für Berechtigte, mit Reset und Audit. Fehler bei fehlender Berechtigung stoppen den Zugriff, nicht die gesamte Automation, sofern deren Aufgabe ohne Zustand noch sinnvoll ist.

### 3. Abhängigkeit von anderen Jobs (nach 1 und 2)

- Optionale Liste mit höchstens drei Quell-Jobs. Für jede Quelle wird beim Start ein jüngster relevanter Run referenziert. Quellen müssen im selben zulässigen Workspace- und Organisations-Scope liegen; Zugriff wird bei Konfiguration **und** Ausführung geprüft. Kein implizites Lesen fremder persönlicher Jobs oder Workspace-Grenzen.
- Das ist Datenabhängigkeit, **keine Ausführungsreihenfolge**. Ein fehlender oder noch laufender Quell-Job blockiert den Ziel-Job nicht; der Kontext entfällt mit sichtbarem Hinweis. Eine spätere echte DAG-Orchestrierung wäre ein anderes Vorhaben.
- Zyklen einschließlich Selbstbezug über Quellen werden bei der Konfiguration abgelehnt; für das eigene letzte Ergebnis gilt ausschließlich `continuityMode`.

## Verbindliches Kontextbudget

1. Kontext wird nur aus ausgewählten Ergebnistexten und Zustandsschlüsseln zusammengesetzt; niemals ganze Logs, Tool-Outputs, Run-Metadaten, Chat-Historien oder eine ungebundene Knowledge-Suche automatisch injizieren.
2. Startbudget für **alle neuen Job-Kontextblöcke zusammen**: höchstens `min(2.048 Tokens, 5 % des Modell-Kontextfensters)`. Davon maximal 1.024 Tokens eigenes Ergebnis, 512 Tokens ausgewählte Zustandswerte und 1.024 Tokens alle Quell-Jobs zusammen; der globale Deckel gilt zuerst. Diese Werte sind anfängliche Sicherheitsgrenzen, keine garantierte Mindestmenge.
3. Systemprompt, Tools, aktueller Job-Prompt, Ereignisdaten, bestehende Session-Historie und reservierte Antworttokens werden vor dem Job-Kontext budgetiert. Reicht der tatsächliche Rest nicht, werden zuerst Quell-Outputs, dann die eigene vorige Antwort, zuletzt automatisch ausgewählte Zustandswerte gekürzt oder weggelassen. **Der aktuelle Auftrag bleibt vollständig erhalten.** `prepareAutomationHistoryWithCompaction` und die finale Payload-Prüfung bleiben maßgeblich.
4. Kürzung erfolgt an Text-/Token-Grenzen mit Marker und Quellenangabe; keine stillen Ausschnitte, die eine Ausgabe als vollständig erscheinen lassen. UI und Run-Metadaten zeigen verwendete Quellen, geschätzte Tokens und ausgelassene Blöcke, aber keine duplizierten vertraulichen Inhalte.
5. Falls für brauchbare Kontinuität mehr Inhalt nötig ist, ruft der Agent einen berechtigten, begrenzten Run-/Zustandsleser gezielt auf. Die Automatik erhöht das Budget nicht selbst.

## Technische Umsetzung in abgeschlossenen Arbeitspaketen

| Paket | Inhalt und voraussichtliche Dateien | Abnahmebedingung |
| --- | --- | --- |
| A – Vertrag und Speicherung | `app/lib/db/schema.ts`, Startup-Migration, `app/lib/automations/types.ts`, neuer kleiner Store für Kontext/Zustand; Versionierung, CAS, FK, Job-/Workspace-Prüfung | Migration auf Bestandsdaten ohne Verhaltensänderung; Zugriffe und Größenlimits geprüft |
| B – Auswahl und Prompt | `app/lib/automations/runner.ts`, `prompt.ts`, eigener Kontext-Composer, `history-compaction.ts`; fixierte Run-Referenzen, No-op-Filter, Deduplikation, Budget und Provenienz | Wiederholte Runs sehen nur erlaubten relevanten Kontext; Auftrag bleibt bei vollem Fenster enthalten |
| C – Zustandstool | `app/lib/pi/scoped-tools.ts` bzw. bestehende Tool-Registrierung, gebundene Job-State-Aktionen, Audit | Tool erscheint nur im zulässigen Automationslauf; kein Zugriff auf andere Jobs; Retry/CAS sicher |
| D – Quell-Jobs | Erweiterung von Schema, Store und Composer um autorisierte Quell-Job-Referenzen; Diagnose für fehlende Quellen | Kein Cross-Workspace-Leck, kein Zyklus, keine implizite Laufreihenfolge |
| E – API, UI und Betrieb | `app/lib/automations/api.ts`, Job-Routen, `app/apps/automations/components/AutomationsClient.tsx` und Detailansicht; Einstellungen, Quellenwahl, Zustand/Reset, Kontext-Provenienz und Diagnose für übersprungene Termine | Desktop und Mobile-Verträge bleiben konsistent; bestehende 90-Sekunden-Regel unverändert; Run-Historie erklärt Auslassungen |

Die Pakete laufen **nacheinander**: A muss vollständig geprüft und sauber committed sein, bevor B startet; entsprechend für B–E. Für jede Codeänderung gilt vorher GitNexus-`impact`, bei HIGH/CRITICAL eine Warnung, vor jedem Commit `detect_changes`. Die Implementierung nutzt den Skill `canvas-local-team-seat-dev` für den verwalteten lokalen Stack; kein Containerbau ohne ausdrückliche Anforderung. Vor einem später ausdrücklich gewünschten Containerbau läuft `npm run build`. UI-/End-to-End-Prüfung mit Playwright oder Chrome DevTools erfolgt gemäß Repository-Regeln erst nach ausdrücklicher Bitte oder Rückfrage; bis dahin stehen Unit-, API- und Build-Prüfungen zur Verfügung.

## Umsetzung mit Entwicklungs-Subagenten

Ein koordinierender Hauptagent hält den Produktvertrag, die Reihenfolge, Integration und Commits. Subagenten erhalten **begrenzte Aufträge mit exklusiven Dateien** und liefern Code, Testnachweise und offene Risiken zurück. Es gibt keine parallelen Edits an `runner.ts`, `store.ts`, `schema.ts` oder den gleichen UI-Dateien.

1. **A: Datenmodell-Subagent** bearbeitet Schema/Migration/Store und dessen Tests. Der Hauptagent prüft Scope, Migration und GitNexus-Ergebnis, integriert und committed A.
2. **B: Kontext-Subagent** bearbeitet Auswahl/Prompt/Budget auf Basis des fertigen A-Vertrags. Ein zweiter Subagent darf gleichzeitig **nur lesend** den Kompaktierungs- und Session-Pfad überprüfen und Gegenbeispiele liefern. Der Hauptagent integriert, testet und committed B.
3. **C: Tool-Subagent** bearbeitet die Tool-Registrierung und Zugriffsprüfungen. Parallel ist ein lesender Security-Review der Job-/Workspace-Grenzen möglich. Integration und Commit folgen erst nach vollständiger Abnahme.
4. **D: Quellen-Subagent** implementiert Quell-Job-Referenzen und Scope-Prüfungen auf Basis der fertigen Kontinuität. Ein zweiter Subagent überprüft Zyklen, Löschfälle und Scheduler-Semantik **lesend**. Der Hauptagent integriert und committed D.
5. **E: UI-Subagent** übernimmt klar benannte UI-Dateien, während ein API-Subagent getrennte Route-/Payload-Dateien bearbeitet. Der Hauptagent gleicht Desktop und Mobile an, führt die abschließenden Prüfungen aus und committed E.

Jede Übergabe enthält: vereinbarte Schnittstelle, Dateibesitz, Nicht-Ziele, relevante Tests, GitNexus-Befund und die Pflicht, keine fremden Änderungen zu überschreiben. Die Subagenten arbeiten nicht am nächsten Paket, solange das aktuelle Paket offen ist. Diese Aufteilung betrifft die **Entwicklung**; sie schaltet `delegate_task` in produktiven Automationen nicht frei.

## Test- und Freigabekriterien

- Relevante Store-/Runner-/Prompt-Tests für: erster Lauf ohne Kontext; Erfolg → nächster Lauf; `NO_ACTION`/leer/Fehler; Retry mit fixierter Quelle; Löschung/Pause/Scope-Wechsel; zwei parallele State-Writes; Größenlimits; volles Kontextfenster; Chat-Historie ohne doppelte Antwort; Quell-Job fehlt oder ist nicht berechtigt.
- Bestehende Suites gezielt nutzen: `test:automation:runner`, `test:automation:history-compaction`, `test:automation:session-messages`, `test:automation:scheduler-recovery`, `test:automation:workspace-scope`, `test:automation:ui` sowie die passenden API-/Migrationstests. Nach Integration `npm run lint` und `npm run build`.
- Für UI-Integration zusätzlich eine echte Browserprüfung nach der in `AGENTS.md` verlangten Freigabe für Playwright/Chrome DevTools. Screenshots und konkrete Verifikationsschritte in einem späteren PR dokumentieren.
- Produktabnahme: bestehende Jobs laufen ohne Migrationseffekt weiter; `off` erzeugt keinen zusätzlichen Prompttext; aktivierte Jobs sehen nur die ausgewählten, begrenzten und autorisierten Daten; ein übervolles Fenster verdrängt nie den aktuellen Auftrag; Berechtigungsentzug wirkt vor dem nächsten Lauf.
