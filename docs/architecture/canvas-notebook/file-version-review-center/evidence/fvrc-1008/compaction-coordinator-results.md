# DA-03/04/05 – Wiederaufnehmbare Kompaktierungssteuerung

Stand: 27. September 2026. Interne Domain-Orchestrierung für Kompaktierung;
**kein Bootstrap-Cutover, keine Fleet-Freigabe und kein Abschluss von FVRC-1008.**

## Zusammenhängender Ablauf

`createCollaborationCompactionCoordinator` verbindet die bestehenden echten
Reservation-, Quiescence- und Handoff-Dienste. `advance(request, authorization)`
führt genau einen begrenzten Fortschritt aus; `resume(requestId, authorization)`
lädt den dauerhaft gespeicherten kanonischen Auftrag und verwendet denselben
Ablauf. Es gibt keine eigene In-Memory-Jobwahrheit, kein Sleep und keine
Endlosschleife. Die Eingabe wird vor dem ersten Await unveränderlich erfasst.

1. Frische Autorisierung und exakter historischer Outcome-Read. Abgeschlossenes
   Apply und belegter Abort werden unterscheidbar zurückgegeben; alte Cancel-
   Ergebnisse bleiben ebenfalls terminal.
2. Nur für neue Aufträge: explizites `assertCanStartAdmission`-Gate, dann ein
   kurzer Read-only-Preflight unter Workspace → Pfad → Operationszeilen →
   Zustandszeilen. Offene Reviews, falscher Scope/Generation, ungesunder oder
   veralteter Checkpoint und überlaufende Zähler verhindern eine Reservation.
3. Alle Preflight-Sperren und die dedizierte SQL-Sitzung schließen; erneut
   autorisieren, das Start-Gate nochmals prüfen und erst dann reservieren.
   Reservation und späterer Handoff prüfen ihre jeweiligen Vorbedingungen
   nochmals; der Preflight ist kein Lease.
4. Immer zuerst Quiescence nachweisen. Das erkennt auch normales Unload zwischen
   Reservation und Aufruf, obwohl im Reservationssnapshot noch der alte Token steht.
5. Nur bei einem belegten Room-Lock-Konflikt und ursprünglich gebundenem Owner
   dessen exakten Drain-Auftrag dauerhaft anlegen. Der bestehende Owner-Worker
   findet ihn über Polling. Genau ein weiterer Proof-Versuch; sonst `pending`.
   Bei ursprünglich tokenlosem Zustand keinen fremden Drain erfinden.
6. Nach Proof den echten Kompaktierungs-Handoff ausführen. Trifft jetzt eine
   offene Agentenoperation ein, darf ausschließlich der konkrete typisierte
   `agent_operation_pending`-Fehler den nochmals gesperrt geprüften
   `precondition_failed`-Abort auslösen. Verschwindet diese Vorbedingung vor dem
   Abort, bleibt der Auftrag aktiv und der Aufrufer erhält erneut `pending`.

`pending` enthält nur Request-ID, Digest und Phase (`quiescence` oder `handoff`),
keine Owner-Tokens, Backend-Identitäten oder Drain-Tickets. Bei Rückgabe werden
keine Workspace-/Pfad-/Room-Sperren oder SQL-Sitzungen gehalten. Der Aufrufer
setzt später dieselbe ID fort. Ein fehlender dauerhafter Auftrag oder
`recovery_required` wird nicht als endloses Waiting ausgegeben.

Das Start-Gate gilt nur für neue Reservationen: Bereits begonnene Recovery und
historische Reads dürfen durch ein nachträglich geschlossenes Start-Gate nicht
abgeschnitten werden. Die konkrete Prüfung gemischter Serverversionen und aller
Writer ist weiterhin ein separat offenes Rollout-Gate, nicht durch einen
erfolgreichen Test-Callback bewiesen.
Die zweite Prüfung reduziert ein widerrufenes Start-Gate während des Preflights;
sie ersetzt kein zukünftiges atomar mit Reserve geprüftes dauerhaftes Fleet-Gate.
Autorisierung ist ein begrenzter Permission-Read ohne erneuten Erwerb von
Collaboration-/Workspace-/Pfadlocks. Der gesperrte Preflight-Recheck läuft vor
den Dokumentzustandslocks; beliebige Agenten-/Netzwerkjobs gehören hier nicht hinein.

## Fehler- und Abbruchgrenzen

Nur erkannte `ADMISSION_STATE_CHANGED`-/`ADMISSION_REQUEST_CHANGED`-Rennen dürfen
auf einen inzwischen bestätigten terminalen Ausgang abgeglichen werden. SQL-,
Autorisierungs-, Recovery- und insbesondere Fehler beim Schließen einer
ungewissen Sitzung werden nicht durch einen zusätzlichen positiven Status-Read
verdeckt. Lost-COMMIT-Recovery bleibt Aufgabe der geprüften unteren Dienste.

Timeout, HTTP-Abbruch, `AbortSignal` und Prozessende bedeuten keinen angenommenen
Nutzer-Cancel. Die neue Steuerung bietet daher keinen scheinbar dauerhaften
Cancel während des Drains an. Für diese spätere UI-Funktion wird ein eigener
persistenter `abort_requested`-Intent benötigt, den jedes Resume berücksichtigt.
Der vorhandene CAS-Cancel für ungestartete Reservationen bleibt unverändert.

## Verifikation

- `npm run test:collaboration:lifecycle`: Exit 0, einschließlich der neuen
  **9 Coordinator-Testgruppen**. Diese Flow-Tests verwenden injizierte
  Service-Doubles; sie ersetzen keinen SQL-Nachweis.
- Echte PostgreSQL-18.4-Compaction-Suite: **35 Testgrenzen**, zweimal Exit 0.
  Die bisherigen 26 bleiben erhalten. Die Erweiterung führt tatsächliche
  Admission-, Quiescence-, Handoff- und Kompaktierungsdienste aus; ein
  Test-Hook setzt ausschließlich Rennen nach der echten Reserve-Transaktion.
  Geprüft sind freies Dokument, aktiver Owner/Drain und frisches Resume,
  normales Unload im Rennen, tokenloser belegter Guard, verlorener Owner ohne
  Receipt, frühe/späte offene Reviews, Rechteentzug und wieder autorisierte
  Fortsetzung sowie historische Apply-/Abort-/Cancel-Ergebnisse.
- Zusätzliche PostgreSQL-Regressionen: **21 Handoff-Fälle** und
  **18 Quiescence-Testgrenzen**, beide Exit 0; jeweils isolierte generierte
  Schemas, keine Änderungen an Produktions- oder öffentlichen Testtabellen.
- Der erste PostgreSQL-Lauf deckte einen echten Preflight-Fehler auf:
  `degraded` kommt als BIGINT-String `"0"` zurück. Der Decoder akzeptiert nun
  ausschließlich `0`, `false` und `"0"`; Checkpoints müssen sichere Zahlen
  oder kanonische Dezimalstrings sein. Null, leerer Text, ungültige Zahlen und
  nichtkanonische Strings führen vor Reserve zum Abbruch. Unit-Regressionen
  prüfen zusätzlich das Schließen der Sitzung und Freigeben der Sperren.
- `npm run build`: Exit 0. Kein Container gebaut oder neu gestartet.
- Gezieltes ESLint und vollständiges `tsc --noEmit --incremental false`:
  beide Exit 0.
- Read-only-Prüfung der öffentlichen lokalen Tabellen: `owner_era_rows=0`,
  `admission_requests=0`; keine verbliebenen Schemas der drei PG-Suites.
- Unabhängiger Read-only-Review: keine konkreten verbleibenden Integritäts-
  oder Deadlock-Blocker innerhalb dieses internen Koordinierungsumfangs.
- GitNexus nach Reparatur eines inkonsistenten inkrementellen FTS-Index durch
  vollständigen Neuaufbau: dieser Commitumfang **LOW**, zehn Dateien, keine
  zusätzlich erfassten Prozesse. Der gesamte Branchvergleich mit `main` bleibt
  **CRITICAL** (305 Dateien / 30 Prozesse); keine Merge- oder Gesamtfreigabe.

Die beiden Browserregressionen laufen seriell mit einem Worker gegen den
frisch gestarteten Worktree-Devserver `127.0.0.1:3000`, mit dem PostgreSQL und
den Team-Fixtures des verwalteten lokalen Stacks. Der Notebook-Container auf
`3100` bleibt unverändert. Diese Prüfungen testen den bestehenden regulären
Review-Pfad, **nicht** eine aktivierte Coordinator-/Owner-Runtime. Diese
Unterscheidung bleibt trotz grüner Browserergebnisse eine offene Gesamtgrenze.
Die Vorschläge stammen aus deterministischen normalen `read`-/`edit_file`-
Toolaufrufen; dies ist kein Nachweis für einen externen Live-LLM-Durchlauf.

- Team-Konfliktfall B/C auf derselben Ausgangsversion: **1 bestanden, 23,4 s**.
  C wird angenommen; B bleibt als konkreter Konflikt offen, ohne Timeline-
  Fehler, irreführenden Null-Diff oder unzulässigen Annahme-Button.
  Bericht: `/tmp/fvrc1008-coordinator-team-conflict-report/index.html`.
- Team-Batchfall mit zehn unabhängigen `edit_file`-Vorschlägen: **1 bestanden,
  56,0 s**. Drei Annahmen in Nicht-Präfix-Reihenfolge, danach sieben in einer
  Batch-Aktion; exakter Endinhalt, vier neue Revisionen und idempotenter Retry.
  Bericht: `/tmp/fvrc1008-coordinator-team-batch-report/index.html`.
- Beide abschließenden Screenshots visuell geprüft: Konfliktkennzeichnung,
  Diagnose-Ausklapper und Handlungsoptionen beziehungsweise keine offenen
  Reviews nach Batch-Abschluss und vollständige Versionsliste.

Lokale Logs: `/tmp/fvrc1008-coordinator-lifecycle-final.log`,
`/tmp/fvrc1008-admission-compaction-coordinator-postgres.log`,
`/tmp/fvrc1008-coordinator-postgres-repeat.log`,
`/tmp/fvrc1008-coordinator-handoff-postgres.log`,
`/tmp/fvrc1008-coordinator-quiescence-postgres.log` und
`/tmp/fvrc1008-coordinator-build-final.log`.

## Offene Gesamtanforderungen

- Reguläre Runtime-/HTTP-Aufrufer, tatsächlicher Owner-Worker-Bootstrap und
  konkrete Fleet-/Writer-Admission-Prüfung gemeinsam integrieren.
- Einen autorisierten Recovery-/Operatorpfad für nachträglich entzogene Rechte
  anbinden. Der bisherige Nutzer darf nicht weiterschreiben; die Reservation
  wird deshalb nicht stillschweigend gelöscht.
- Owner-Verlust ohne gültigen finalen Receipt bleibt ein Recoveryfehler;
  kein automatischer Token-Clear, Generation-Sprung oder stilles Verwerfen
  unbestätigter Nutzeränderungen.
- Dauerhafter Nutzer-Abbruchwunsch nach Drain-Beginn, Repräsentationswechsel,
  Dateiprojektion und übrige Dateiaktionen bleiben separat umzusetzen.
- Echte App-Prozess-Abstürze, Mehrprozess-/Peer-/Offline-Matrix sowie atomarer
  Kandidatencommit vor Live-Publish und P12 sind noch nicht abgenommen.

Verbindlicher Gesamtplan: [Distributed Admission](distributed-admission-plan.md).
