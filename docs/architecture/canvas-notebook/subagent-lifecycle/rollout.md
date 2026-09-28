# Subagent-Lifecycle: Abnahme und Rückfall

Stand: 2026-09-28. Gilt für die Umsetzung aus [plan.md](./plan.md).

## Vor dem Rollout

1. `npm run test:pi:subagent-lifecycle`, `npm run lint` und `npm run build` auf demselben Commit ausführen.
2. Die autorisierten Playwright-Fälle `tests/chat-delegation-live-inspection.spec.ts` und `tests/chat-delegation-session-resume.spec.ts` gegen einen frisch gestarteten lokalen Dienst ausführen. Kein Test-Container ist dafür nötig.
3. Die Laufzeitgrenze `CANVAS_DELEGATION_MAX_CONCURRENCY` für einen vorsichtigen Start niedrig halten (gültig: 1–32, Standard: 4). Das `delegation`-Toolset nur den vorgesehenen Agenten zuweisen. User-, Agenten-, Workspace- und Parent-Prüfungen bleiben in allen Fällen aktiv.
4. Vor einem Produktions-Rollout die Anzahl offener Delegationen und die letzten fehlgeschlagenen Kompaktierungsversuche prüfen. Bereits gespeicherte Kind-Sessions und Summaries bleiben erhalten.

## Beobachtung

Die strukturierten Ereignisse `worker_compaction_attempt`, `worker_compaction_result`, `worker_context_overflow`, `steer_delivery` und `resume_rejection` enthalten nur freigegebene Status- und Zählerfelder. Auftragstext, Modellantworten, Tool-Ausgaben, Korrekturen und Secrets gehören nicht in Metriken oder Logs. Die bestehenden `pi_session_compaction_attempts` sind die dauerhafte Quelle für Kompaktierungsstatus, Reason-Code, Dauer, Token-/Byte-Schätzungen und Summary-Revision. `pi_delegations` sowie die Fortschritts- und Steering-Tabellen sind die dauerhafte Quelle für Auftrags-, Zustell- und Korrekturstatus.

Bei einem Anstieg von `worker_context_overflow` zuerst Modellkontext und Größe der Tool-Ergebnisse prüfen. Bei `worker_compaction_result` mit `failed`, `timed_out` oder `stale` die persistierten Reason-Codes auswerten. Bei `steer_delivery=missed` prüfen, ob der Auftrag vor der Korrektur endete oder die Owner-Lease ablief. `resume_rejection` weist auf eine abgelehnte Wiederverwendung hin; niemals durch schwächere Session-Berechtigungen umgehen.

## Rückfall und Wiederanlauf

- Neue Delegationen vorübergehend über die `delegation`-Toolset-Zuweisung unterbinden und aktive Läufe auslaufen lassen oder gezielt stoppen. `CANVAS_DELEGATION_MAX_CONCURRENCY=1` begrenzt neue Parallelität, deaktiviert aber keine bereits gestarteten Aufträge.
- Für einen Rückfall auf den früheren ephemeren Laufpfad eine geprüfte vorherige Anwendungsversion ausrollen. Die additive Persistenz von Kind-Nachrichten und Summaries **nicht** löschen oder zurücksetzen. Vorher sicherstellen, dass die ältere Version die bestehende Datenbankstruktur toleriert. Ein bereits bestätigter externer Tool-Effekt wird nicht automatisch erneut ausgeführt.
- Nach einem Prozessneustart markiert die Lease-Recovery unbestätigte Worker-Läufe als unterbrochen. Ein unsicherer Completion-Zustellversuch wird sichtbar gehalten statt blind wiederholt. Den gespeicherten Ergebnistext und den Parent-Chat prüfen, bevor eine manuelle Folgeaktion erfolgt.
- Für einen neuen Auftrag mit erhaltenem Kontext die verwaltete `workerSessionId` aus demselben Bradley-Chat auswählen. Ein ephemerer Auftrag ist nicht wiederverwendbar; dort nur einen neuen Auftrag starten.

Container werden nur auf ausdrücklichen Auftrag gebaut. Vor jedem Container-Bau `npm run build` ausführen und nur eine Testumgebung betreiben.
