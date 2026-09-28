# DA-04/05 – Expliziter Abbruch nach belegtem Ruhezustand

Stand: 27. September 2026. **Interner Protokollbaustein, nicht im regulären
Server aktiviert. DA-03 bis DA-06, FVRC-1008 und P12 bleiben offen.**

## Problem und Vertrag

Eine bereits reservierte und entladene Datei kann fachlich nicht kompaktierbar
sein, beispielsweise wegen offener Agentenreviews. Der bisherige Cancel erlaubt
nur unberührte Reservationen. Nach Quiescence war deshalb ein ausdrücklich
belegter No-write-Abschluss nötig, damit ein neuer Room-Claim wieder möglich ist.

`createCollaborationAdmissionHandoffService.abort` verwendet dieselbe geordnete
Übergabe wie die Mutation: dedizierte Room-Guards, Workspace-/Pfad-/Operations-
Locks, Request-/Target- und Zustandsprüfung. Der Aufrufer autorisiert vor Beginn
und erneut nach dem gesperrten Prepare. Abort erhält keine private
Mutationsberechtigung und besitzt keinen Mutate-Callback.

Der vollständige Zustand nach Prepare muss bytegenau zum gespeicherten Proof
und zum vor der Entscheidung gesperrten Snapshot passen. Das schließt Scope,
Generation, Epoch, Sequence und die Hashes des vollständigen Yjs-Updates und
Vectors ein. Ein bloß gleicher Text oder Vector ist kein No-write-Nachweis.
Fehlender Proof, Drift, Rechteverlust und unklare Commits bleiben gesperrt.

Der SQL-Header `committed` bedeutet einen dauerhaft gespeicherten
**Protokollausgang**, nicht zwingend eine Dokumentänderung. Bestehende v1-
Ergebnisse bleiben bytekompatibel. Nur v2 bezeichnet den neuen Ausgang:

```ts
{ version: 2, disposition: 'aborted', reasonCode: 'user_cancelled' | 'precondition_failed',
  requestId, requestDigest, result: {}, targets }
```

Targets werden atomar mit dem Outcome als abgeschlossen/inaktiv gespeichert.
Ihre ursprünglichen Reservationen und Quiescence-Belege bleiben erhalten.
Der Reader prüft die exakte kanonische Form und bindet den Abbruch auch an den
ursprünglichen reservierten Snapshot. Die Gründe sind feste Codes ohne
Dokumentinhalt oder unkontrollierte Fehlertexte.

Im Kompaktierungsadapter ist `precondition_failed` ausschließlich erlaubt,
wenn unter den echten Operationslocks noch nicht abgeschlossene Agenten-
operationen existieren. `user_cancelled` ist die ausdrückliche Abbruchentscheidung
des autorisierten Aufrufers. Kein Catch-all wandelt einen beliebigen Fehler
automatisch in einen erfolgreichen Abbruch um.

## Wiederholung und Weiterarbeit

- Execute nach gespeichertem Abort liefert das historische v2-Ergebnis; keine
  spätere Kompaktierung unter derselben Request-ID. Ein echter neuer Versuch
  benötigt eine neue ID und neue Reservation/Proofs.
- Abort nach erfolgreichem Apply liefert das historische v1-Ergebnis. Es ist
  kein Undo. Die erste dauerhaft gespeicherte Entscheidung gewinnt.
- Nach verlorener Commit-Antwort wird die alte Verbindung verworfen und nur
  der exakte gespeicherte Ausgang über eine neue Verbindung gelesen. Ein neuer
  Owner darf inzwischen legitim weiterarbeiten; es erfolgt kein Replay.
- Ein früherer Owner-Drain bleibt für seinen rein lokalen Abschluss lesbar,
  auch wenn der Request inzwischen abgebrochen und ein neuer Owner aktiv ist.

## Verifikation

Verwalteter Einzelstack auf PostgreSQL 18.4/pgvector 0.8.3, Port 55433;
alle vier Container gesund, keine Containeränderung und keine zweite Umgebung.

| Prüfung | Ergebnis | Nachweis |
|---|---|---|
| Reader-/Vertragsfälle | 7/7 Gruppen grün; v1/v2, kanonische Form, falscher Request/Scope/Grund, manipulierte Proof-/Outcome-/Reservationssnapshots und Größenlimit | `scripts/collaboration-admission-abort-outcome-test.ts`, nun Bestandteil von `test:collaboration:admission` |
| Echte Kompaktierungs-/Abbruchübergabe auf PostgreSQL | 26 Grenzfallgruppen zweimal grün | `/tmp/fvrc1008-admission-compaction-abort-postgres.log`, `/tmp/fvrc1008-abort-compaction-postgres-verified.log` |
| Bestehender generischer Handoff / Quiescence / Lifecycle-Snapshot | 21 / 18 / 16 Fälle grün | `/tmp/fvrc1008-abort-handoff-postgres.log`, `/tmp/fvrc1008-abort-quiescence-postgres.log`, `/tmp/fvrc1008-abort-legacy-postgres.log` |
| Vollständige Collaboration-Lifecycle-Suite / abschließende Admission-Suite | Exit 0 / Exit 0 | `/tmp/fvrc1008-abort-lifecycle-final.log`, `/tmp/fvrc1008-abort-admission-final.log` |
| Vollständiges TypeScript NoEmit / fokussiertes ESLint | Exit 0 / Exit 0 | `/tmp/fvrc1008-abort-types-final.log`, `/tmp/fvrc1008-abort-lint-final.log` |
| Produktionsbuild | Exit 0 | `/tmp/fvrc1008-abort-build-final.log` |
| Team-B/C-Review im Browser | 1/1 grün (23,4 s); C angenommen, B bleibt als konkreter Konflikt offen, kein Timeline-Fehler | `/tmp/fvrc1008-abort-team-conflict-report/index.html`; Screenshot visuell geprüft |
| Team-Sammelreview im Browser | 1/1 grün (55,9 s); 10 Vorschläge, 3 Einzelannahmen plus 7 gemeinsam, exakter Endtext und genau 4 zusätzliche Revisionen | `/tmp/fvrc1008-abort-team-batch-report/index.html`; Screenshot visuell geprüft |

Die PG-Suite nutzt tatsächliche getrennte Datenbank-/Owner-Verbindungen,
isolierte UUID-Schemas und die reale Handoff-/Kompaktierungsimplementierung.
Sie belegt unter anderem: Abbruch ohne Mutationsberechtigung, Rechteentzug
vor/nach Sperren, fehlenden Proof, Drift, offene Operationen mit unveränderten
Bytes/Generation/Sequence/Backups/Operationsstatus, historischen Retry und
anschließend erfolgreichen neuen Claim plus neue Kompaktierung. Der vollständige
Owner-Drain-Abbruch bleibt nach Ersatz-Claim für `readDrain`, `pendingDrains`
und `recoverCollaborationRoomRelease` lesbar. Die bisherigen angewandten v1-
Commitfehler und der Retry nach beendeter Operation bleiben separate Fälle;
die v2-Abbruchfälle ersetzen sie nicht.

Abgewiesene und verlorene Commit-Antworten werden an echten SQL-Grenzen
kontrolliert injiziert. Dies behauptet keinen App-/OS-Prozessabsturz. Der
Plaintext-Codec und Workspace-Lock-Wrapper der isolierten PG-Suite sind
kontrollierte Testadapter, kein Rich-Markdown-/Dateiprojektionsnachweis.
Der Produktionsbuild prüft den finalen Quellstand. Die getrennten Browser-
Regressionsprüfungen laufen am anschließend frisch gestarteten Host-Dev auf
`127.0.0.1:3000`, nicht am unverändert älteren Notebook-Container auf Port 3100.
Die öffentliche Datenbank bleibt ohne aktive neue Owner-/Admission-Nutzung:
`owner_era_rows=0`, `admission_requests=0`. Keine Kompaktierungstest-Schemas
zurückgeblieben; Daten und Lizenzfixtures wurden nicht zurückgesetzt.
Browserfälle liefen seriell mit einem Worker und mehr als 55 Sekunden Abstand
zwischen den Auth-lastigen Aufrufen. Gewöhnliche Agentenwerkzeuge erzeugen die
Vorschläge deterministisch; diese Tests setzen keine erreichbare LLM-Antwort voraus.

Der unabhängige Produktreview fand keinen Integritätsblocker. GitNexus auf dem
abschließend indizierten Commitumfang: 12 Dateien, 50 zugeordnete Symbole,
keine zusätzlich erkannten Prozesspfade, Risiko `low`. Der gesamte bisherige
Branch gegenüber `main` bleibt mit 300 Dateien und 30 betroffenen Prozessen
`critical`; keine Gesamtfreigabe oder Deployment-Empfehlung aus dieser Teilabnahme.

## Grenzen und nächste Pflichtschritte

Der nachfolgende [Kompaktierungscoordinator](compaction-coordinator-results.md)
verbindet inzwischen Vorprüfung, Reservation, Drain, Proof, Resume und den
belegten Abbruch bei nachträglich offenen Operationen. Reguläre Runtime-Aufrufer,
die übrigen Domainadapter, vollständige App-Prozess-/Crash-Matrix und gemeinsame
sichere Aktivierung sämtlicher Writer bleiben offen. Der Adapter hat keinen produktiven UI-/HTTP-
Aufrufer; normale Review-Center-E2Es sind Regressionstests, kein Nachweis eines
bereits aktivierten Abbruch-Workflows.

Eine konkurrierende Terminalisierung zwischen historischem Vorab-Read und
Domain-Prepare kann weiterhin eine vorübergehende Ablehnung auslösen, wenn
die fachliche Vorbedingung inzwischen verschwunden ist. Der nächste identische
Retry liest den gespeicherten Ausgang. Das erlaubt keine Mutation oder falsche
Freigabe; eine garantierte Ein-Aufruf-Fortsetzung in diesem schmalen Rennen
wird hier nicht behauptet.

Verbindliche Fortsetzung: [Distributed-Admission-Plan](distributed-admission-plan.md).
