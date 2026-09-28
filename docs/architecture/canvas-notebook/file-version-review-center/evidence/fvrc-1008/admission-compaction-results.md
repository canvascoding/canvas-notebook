# DA-05 – Echte Kompaktierung innerhalb einer geprüften Übergabe

Stand: 27. September 2026. **Interner Kompaktierungsadapter; keine Runtime-
oder Fleet-Aktivierung, kein Abschluss von DA-05/06 oder FVRC-1008.**

## Änderung

Der neue `createCollaborationCompactionHandoffService` verarbeitet einen bereits
reservierten und mit Quiescence-Proof versehenen `compact`-Auftrag. Der Auftrag
bindet genau ein aktives Dokument, seinen exakten Workspace-/Organisations-/
Pfadscope und die erwartete Generation. Die kanonischen Aktionsparameter sind
`{version: 1, documentId, expectedLifecycleGeneration}`; zusätzliche Parameter,
andere Aktionen, Subtrees und implizite Legacy-Payloads werden abgelehnt.

Der Adapter prüft die Rechte auch bei einem historischen Retry und erneut unter
den Mutationssperren. Er erwirbt Pfadlocks und sperrt Agentenoperationen **vor**
Zustandszeilen. Offene Operationen/Reviews und fehlende gesunde Checkpoints
verhindern die Kompaktierung. Backup, neue Yjs-Binärdaten, Generation/Sequence
und Handoff-Outcome werden in einer einzigen SQL-Transaktion gespeichert.
Der SQL-Rewrite wird mit dem alten Kompaktierungspfad geteilt; es gibt keinen
zweiten Testalgorithmus und keine verschachtelte Lifecycle-Transaktion.

Die neue Berechtigung lebt in einer privaten WeakMap auf der **exakten**
SQL-Verbindungsinstanz und nur während des geprüften `mutate`-Callbacks.
Dokument, Aktion, Scope, Epoch, Sequence und vollständige Update-/Vector-Hashes
müssen zum gesperrten Proof passen; die Berechtigung ist pro Dokument einmalig.
Verbindungswrapper, andere Transaktionen und später wiederverwendete Handles
erhalten sie nicht. Bestehende öffentliche Lifecycle-Einstiege bleiben bei
Owner-Epochen größer null gesperrt.

Zusätzlich verfolgt die Übergabe laufende Persistence-Aufrufe schon vor deren
erster SQL-Abfrage. Gibt der Callback zurück, ohne einen begonnenen Rewrite
abzuwarten, wird die Berechtigung entzogen und die Transaktion zurückgerollt.
Jede Fortsetzung prüft die Berechtigung vor der nächsten SQL-Anweisung. Damit
kann ein verspäteter asynchroner Aufruf nicht nach dem Rollback weiterschreiben.

Bei wiederholtem Auftrag wird der gespeicherte Ergebnisbeleg zurückgegeben,
nicht erneut kompaktiert. Das gilt auch nach einer verlorenen Commit-Antwort
und wenn ein neuer Owner bereits einen späteren Zustand bearbeitet. Der Beleg
enthält Backup-ID, Dokument-ID, Generation und Sequence; er wird ausdrücklich
nicht als vermeintlich aktueller Y.Doc zurückgegeben.

## Verifikation

Verwalteter Einzelstack: PostgreSQL 18.4/pgvector auf `127.0.0.1:55433`.
Alle vier Container gesund, kein Rebuild/Restart und keine zweite Umgebung.
Browserprüfungen laufen am frisch gestarteten Host-Dev auf `127.0.0.1:3000`,
nicht am unverändert älteren Container-Image auf Port 3100.

| Prüfung | Ergebnis | Nachweis |
|---|---|---|
| Kompaktierungsvertrag | 4/4 Testgruppen grün; kanonische/feste Eingaben und unzulässige Aktionen/Scopes/Payloads | `scripts/collaboration-compaction-contract-test.ts`; auch Bestandteil der Admission-/Lifecycle-Suite |
| Echte Kompaktierungsübergabe auf PostgreSQL | 12 gruppierte Grenzfälle, zweimal grün | `/tmp/fvrc1008-admission-compaction-postgres.log`, `/tmp/fvrc1008-admission-compaction-postgres-verified.log` |
| Bestehende Lifecycle-Snapshot-/Recovery-Races | 16 Fälle grün | `/tmp/fvrc1008-compaction-legacy-postgres-final.log` |
| Bestehender generischer Handoff | 21 Fälle grün | `/tmp/fvrc1008-compaction-handoff-postgres-final.log` |
| Vollständige Collaboration-Lifecycle-Suite | Exit 0 | `/tmp/fvrc1008-compaction-lifecycle-final.log` |
| Gezieltes ESLint / vollständiges TypeScript NoEmit | Exit 0 / Exit 0 | `/tmp/fvrc1008-compaction-lint-verified.log`, `/tmp/fvrc1008-compaction-types-verified.log` |
| Produktionsbuild | Exit 0 | `/tmp/fvrc1008-compaction-build-final.log` |
| Team-B/C-Review im Browser | 1/1 grün (24,0 s); C angenommen, B bleibt konkret konfliktbehaftet, kein Timeline-Fehler und keine unsichere Annahme | `/tmp/fvrc1008-compaction-team-conflict-report/index.html`; Screenshot visuell geprüft |
| Team-Sammelreview im Browser | 1/1 grün (54,4 s); 10 Vorschläge, 3 einzeln und 7 gemeinsam, exakter Endtext und genau 4 neue Revisionen | `/tmp/fvrc1008-compaction-team-batch-report/index.html`; Screenshot visuell geprüft |

Die neue PG-Suite nutzt isolierte UUID-Schemas und echte getrennte Owner-/SQL-
Verbindungen, Pfad-Advisory-Locks, Operations-/Zustandslocks und den tatsächlichen
transpilierten Kompaktierungs-Code. Geprüft sind exakter Predecessor-Backup,
Generation/Sequence/Text, einmaliger Claim, Wrapper-/Escaped-Handle-Ablehnung,
verzögerte nicht abgewartete Aufrufe vor/nach Claim, reine Löschung mit gleichem
Vector, Legacy-Sperre, offene Operationen, abgewiesener COMMIT und verlorene
Commit-Antwort mit inzwischen neuem Owner. Wiederholung erzeugt kein zweites
Backup. Die Tests halten bereits ausgeführte SQL-Antworten kontrolliert zurück;
sie behaupten keinen echten App-/OS-Prozessabsturz.

Die PG-Suite injiziert einen einfachen Plaintext-Codec und einen kontrollierten
Workspace-Lock-Wrapper; sie belegt keinen echten Rich-Markdown-Roundtrip,
Filesystem-Flock oder Dateiprojektionspfad. Testschemas wurden entfernt;
produktive Daten und Lizenzfixtures wurden nicht zurückgesetzt. Der erste
Buildversuch traf noch eine in Arbeit befindliche Testfixture-Typkorrektur;
der obige abschließende Build und NoEmit-Lauf sind grün.

Die abschließende öffentliche DB-Prüfung fand `owner_era_rows=0`,
`admission_requests=0` und keine übrig gebliebenen Kompaktierungstestschemas.
Das bestätigt insbesondere, dass diese Prüfung die neue Runtime nicht
versehentlich aktiviert hat. Browserläufe erfolgten seriell mit einem Worker
und mehr als 55 Sekunden Pause zwischen den Auth-lastigen Fällen.

GitNexus vor dem Commit: aktueller Umfang 11 Dateien / 108 Symbole, Risiko
`low`, keine zusätzlich erkannten Prozesspfade. Der vollständige ältere Branch
gegenüber `main` umfasst 300 Dateien / 30 betroffene Prozesse und bleibt
`critical`; diese lokale Teilabnahme ist keine Merge- oder Rollout-Freigabe.

## Noch offen

- Reguläre Runtime-Anbindung des nachfolgend ergänzten internen
  [Coordinators](compaction-coordinator-results.md) für Vorprüfung, Reservation,
  Drain, Proof und fortsetzbare Ausführung. Keine Runtime-Aktivierung.
- Persistenter Nutzer-Abbruchwunsch während eines laufenden Drains.
  Der nachfolgende [belegte Abbruch](admission-abort-results.md) ergänzt inzwischen
  den expliziten No-write-Abschluss nach Quiescence, insbesondere bei offenen
  Reviews. Der ursprüngliche Cancel-Vertrag bleibt auf unberührte Reservationen
  beschränkt; kein beliebiger Fehler löscht einen Request auf eigene Faust.
- Repräsentationswechsel einschließlich Dateiprojektion und die übrigen
  Dateiaktionen (Rename/Move, Archive/Restore, Copy/Replace).
- Gemeinsame Zulassungsprüfung aller neuen Dokument-/Agenten-Writer sowie
  gemischte Serverversionen, Mehrprozess-/Crash- und Rollout-Gates.
- Ein Browserlauf des gewöhnlichen Review Centers ist Regressionsevidence,
  kein Browsernachweis dieser noch internen Kompaktierung. Es existiert dafür
  derzeit kein produktiver UI-/HTTP-Einstieg.

Fortsetzung und verbindliche Invarianten:
[distributed-admission-plan.md](distributed-admission-plan.md).
