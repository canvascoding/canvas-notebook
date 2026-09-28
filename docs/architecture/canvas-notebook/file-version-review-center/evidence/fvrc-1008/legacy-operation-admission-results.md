# DA-05 – Zulassung neuer Legacy-Agentenoperationen

Stand: 27. September 2026. **Begrenzter Legacy-Baustein verifiziert;
keine Gesamtfreigabe oder Aktivierung.** Quellbasis: `0fd22ef8d` plus die
zusammen mit diesem Nachweis committierten Änderungen.
Fortsetzung des [Initialisierungsschutzes](initialization-admission-results.md).

## Begrenzter Umfang

Der ältere `applyPersistedAgentTextOperation`-Pfad verwendet jetzt für seine
Create-or-load-Phase eine kurze dedizierte SQL-Transaktion. Vorhandene
idempotente oder nachgewiesen identische Kettenoperationen bleiben lesbar;
nur eine wirklich neue Operation prüft die persistente Admission unmittelbar
vor ihrem INSERT. Guard, Prüfung und INSERT gehören derselben Verbindung und
demselben Commit an. Ein späterer Policy-, Grant-, Raum- oder Persistenz-Wait
hält diese Verbindung nicht mehr.

Alle Eingaben der Create-or-load-Phase werden vor dem ersten Await kopiert.
Der Zustand wird auf derselben Verbindung gelesen, statt unter gehaltenem
Guard noch einen Pool-Client auszuleihen. Organisation, Generation und Schema
der neuen Operation müssen zum aktuellen Zustand passen; vorhandene Pfad-
und Repräsentationsprüfungen bleiben bestehen. Bestehende globale Zustands-
Aufrufe verwenden weiterhin dieselbe Abfrage und schließen ihre eigene
Verbindung wie zuvor.

Die kurze Legacy-Transaktion liest den Zustand mit `FOR SHARE`. Der
Workspace-Guard allein reicht hier nicht: Ein bereits laufender Lifecycle-
Handoff kann seine Reservation ohne diesen Guard terminalisieren. Die
Zeilensperre hält Generation und Pfad vom Lesen bis zum Operations-Commit
stabil; ein vorheriger Handoff wird abgewartet und sein neuer Scope geprüft.
Nur dieser explizite Aufrufer fordert die Sperre an. Die Reihenfolge bleibt
Admission → State, ohne nachträglichen Pfad- oder Owner-Lock.

Die spätere Operationsverarbeitung bleibt statementweise: Der bestehende
`createAgentOperationDatabase`-Guard erlaubt weiterhin keine Transaktions-
oder Session-SQL-Anweisungen. Die neue kurze Transaktion ist keine Erlaubnis,
einen Pool-Client bis zum Ende einer Agentenoperation festzuhalten.

## Verlorene Commit-Antworten

Die vorhandene Lifecycle-Transaktionsmechanik verwirft eine ungewisse Sitzung
zuerst. Erst nach bestätigtem Discard wird auf einer neuen Verbindung exakt
die ursprüngliche `operation_id` gelesen. Unveränderliche Scope-/Auftragsfelder,
Payload, Basisvektor und Basissequenz müssen mit dem versuchten Commit
übereinstimmen. Kein Lookup über einen neuen Zufallsschlüssel, kein Reinsert,
keine Rekonstruktion aus einer späteren Dokumentversion.

Nur die exakt wiedergefundene, ursprünglich neu angelegte Operation im Zustand
`preparing` mit CAS 0 setzt die neue Vorbereitung fort. Bereits fortgeschrittene
Operationen gehen in die bestehende Reconciliation; sie werden nicht erneut
als neue Operation angewandt. Fehlgeschlagener Discard startet keinen Read-
Recoveryversuch. Graph-gebundene Operationen werden nicht als Legacy adoptiert.

## Bewusst offene Graph-/Domain-Grenze

Die Graph-Aufrufer von `createOrLoadOperation` sind in diesem Schritt **nicht**
umgestellt. Ein Admission-Lock nach ihren bestehenden Graph-/Identitätslocks
könnte die Sperrreihenfolge umkehren. Ein pauschaler Lock vor dem Graph wäre
ebenfalls unzureichend: Unter gehaltenen SQL-Verbindungen leihen bestehende
Auth-/State-/Live-Reads zusätzliche Pool-Clients aus; parallele wartende
Graph-Transaktionen könnten diese Kapazität aufbrauchen. Der Folgeschritt
muss diese Reads und die äußere Transaktionsgrenze gemeinsam behandeln.

Dies ist ein Writer-Nachweis, keine vollständige Domain-Reservation-Abnahme.
Wenn eine Operation zuerst zugelassen wurde, muss der Lifecycle-Coordinator
ihre Fortsetzung bzw. seinen belegten Abbruch berücksichtigen. Die bestehende
Kompaktierungsübergabe prüft offene Operationen erneut und kann ohne Mutation
abschließen. Die frühere fachliche Vorprüfung darf nicht als atomare Aussage
über die spätere Reservation ausgegeben werden. Ein genereller Pending-Op-
Verbotscheck passt nicht automatisch zu jeder Lifecycle-Aktion. Insbesondere
darf dafür kein Admission → Pfad-Lock hinzugefügt werden, solange der neue
Metadatenpfad Pfad → Admission verwendet.

Excalidraw-Operationen, regulärer Owner-Bootstrap, Fleet-Gate, vollständige
Mehrprozess-/Crash-Matrix und manueller Konflikteditor P12 bleiben offen.

## Verifikation

- Neuer Zulassungs-Unit-Harness: 17/17 inklusive Unterfällen. Verwendet echte
  Create-or-load-, Lifecycle-Transaktions- und Admission-Funktionen mit einem
  transaktionalen Fehleradapter. Beide Reihenfolgen, vorhandener Retry und
  Kettenduplikat unter Reservation, Commit-Ablehnung/Antwortverlust/Discard-
  Fehler, fortgeschrittene exakte Operation, Payload-/Vektor-Drift, Scope-
  Abweichungen und historischer Nachweis trotz späterem Current geprüft.
- Operations-Pool: 5/5, weiterhin zehn parallele Direct-Löschungen, kein
  zusätzlicher State-Client innerhalb der neuen Transaktion und null gehaltene
  Clients an späteren Grant-/Live-/Durability-Wartepunkten. Dieser Kapazitäts-
  Harness simuliert den Workspace-Lock nicht seriell; die echten Sperrrennen
  gehören ausdrücklich zum separaten PostgreSQL-Harness.
- Vollständige Agent-Approval- und Agent-Structure-Suites grün; darin die
  angepassten Approval- (21), Replay- (29) und Markdown-Adapter-Tests (22).
  Der Replay-Harness erlaubt nur Transaktionskontrolle und verweigert weiterhin
  jede DML-Mutation. Ein aktiver Reservationsbeleg bleibt für den vorhandenen
  Retry irrelevant, ohne den neuen INSERT-Pfad freizugeben.
- Lifecycle- und Graph-Tool-Suites grün; Graph-Erstellung bleibt in diesem
  Schritt unverändert und erhält daraus keine Admission-Freigabe.
- Echtes PostgreSQL 18: 10/10 Grenzfälle im exklusiv erzeugten Schema. Neben
  den Commit-/Workspace-Guard-Fällen sind beide State-Zeilensperrfolgen über
  getrennte Backends und `pg_blocking_pids` nachgewiesen: Lifecycle zuerst
  führt zum Reject der alten Generation ohne INSERT; Operationsanlage zuerst
  hält eine State-Mutation bis nach ihrem Commit zurück. Die simulierte
  Lifecycle-Terminalisierung ist ein gezielter Sperrtest, kein vollständiger
  Domain-/Owner-Handoff-Abnahmetest. Cleanup: null verbliebene Testschemas.
- `npm run build`, vollständiger TypeScript-Check und gezieltes ESLint: grün.
  Aktueller Host-Dev `127.0.0.1:3000`: Health 200 nach diesem Build.
- Zwei echte Browserclients, Legacy-Toolpfad explizit im Testworker ausgewählt:
  ursprünglicher Vorschlag nach Verschieben seines unveränderten Zielblocks
  erfolgreich angenommen; gleiche Block-IDs und exakte Inhalte auf beiden
  Clients. Playwright: 1/1, 28,7 s, keine Skips.
- Zwei echte Browserclients, erfolgreiche serverseitige Annahme mit nur im
  Browser verlorener HTTP-Antwort: Derselbe Schlüssel liefert denselben
  dauerhaften Beleg, ohne erneute Textmutation; exakt ein `AGENT-ONCE`-Zusatz.
  Playwright: 1/1, 14,9 s, keine Skips. Kein simuliertes Server-Crash-Szenario.
- Separater gewöhnlicher Team-B/C-Graph-Regressionslauf: C angenommen, B bleibt
  mit konkretem Konflikt offen statt Timeline-Fehler. Playwright 1/1, 16,7 s,
  keine Skips. Dieser Lauf prüft die bestehende Produktfunktion, nicht die noch
  offene persistente Admission des Graph-Schreibpfads.

Alle Prüfungen verwenden den aktuellen Host-Worktree auf Port 3000 und die
verwaltete lokale PostgreSQL-Instanz. Der vorhandene Container auf Port 3100
wurde nicht gebaut oder ersetzt und ist kein Nachweis für diesen Quellstand.
Kontrolle nach dem ersten Browserlauf: null Owner-Epochen größer null,
null persistente Admissions im normalen Schema und null Testschemas.

Ein erster Build-/TypeScript-Versuch scheiterte an einer beim Dev-Stop leer
gebliebenen generierten `.next/dev/types/routes.d.ts`. Nur dieser generierte
Typcache wurde nach `/tmp/fvrc1008-dev-type-cache.x4Ixu4` verschoben. Anschließender
Build und vollständiger TypeScript-Check bestehen. Vorhandene Build-Warnungen
zu dynamischen Dateipfaden und fehlender Buildzeit-Auth-URL bleiben sichtbar.

Lokale Logs unter `/tmp/fvrc1008-operation-admission-*`: `capacity-final.log`,
`approval.log`, `structure.log`, `lifecycle.log`, `graph-tools.log`,
`types-final.log`, `lint-final.log`, `build.log` und `dev.log`.
Aktueller State-Fence-Stand: `capacity-state-fence.log`,
`approval-state-fence.log`, `structure-state-fence.log`, `lint-state-fence.log`,
`build-state-fence-retry.log`, `types-state-fence-retry.log`,
`dev-state-fence.log`; PostgreSQL:
`/tmp/fvrc1008-agent-operation-admission-rowlock-pg.log`.
Browser: `/tmp/fvrc1008-legacy-block-move.log`, zugehöriger HTML-Report unter
`/tmp/fvrc1008-legacy-block-move-report/`; verlorene Antwort:
`/tmp/fvrc1008-legacy-lost-response.log` und
`/tmp/fvrc1008-legacy-lost-response-report/`.
Team-Graph-Regression: `/tmp/fvrc1008-legacy-team-graph-regression.log` und
`/tmp/fvrc1008-legacy-team-graph-regression-report/`.

GitNexus vor Commit: genau 13 erwartete Dateien im Staging, keine dort
zusätzlich zugeordneten Prozessketten. Der Gesamtvergleich mit `main` umfasst
312 Dateien und 30 Prozessketten mit kritischer Reichweite; er bleibt ein
separates Integrations-/Rollout-Gate. Kein Push und keine Mergefreigabe.
