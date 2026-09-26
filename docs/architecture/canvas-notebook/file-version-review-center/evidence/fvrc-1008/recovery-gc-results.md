# Recovery nach Yjs-Bereinigung: enger Sicherheitsfix

Stand: 26. September 2026. Ausgangscommit `06bba9c36`. Teilnachweis PG-S19;
kein vollständiger Crash-/Restart- oder Produktionsnachweis.

## Reproduzierter Fehler

Die vorherigen [Löschtests](ordinary-deletion-results.md) zeigten verschiedene
Full-State-Hashes für den unveränderlichen Kandidaten (`gc:false`) und die
gespeicherte Yjs-Snapshot nach Garbage Collection. Inhalt, Struktur, Clocks und
Delete-Set stimmen dabei überein. Normale Durability mit gespeichertem
Operationssnapshot erkennt die Wirkung bereits korrekt.

Anders bei einer Unterbrechung nach der Mutation/Persistenz, aber **vor** dem
gespeicherten Operationssnapshot: Die Operation steht noch auf `applying`.
`proposalRecoveryCurrentMatches` verlangte den unveränderten vollständigen
Binärhash und verweigerte deshalb auch einen vollständig gespeicherten,
GC-bereinigten Kandidaten mit `PROPOSAL_RECOVERY_REQUIRED`.

Eine neue Reproduktion im bestehenden Operationsharness scheiterte vor dem
Produktfix genau an dieser Stelle (15/16 Tests grün). Der Gegenfall mit einem
zusätzlichen, noch nicht quittierten Peer-Edit wurde korrekt abgewiesen.
Log: `/tmp/fvrc1008-recovery-gc-before.log`.

## Begrenzung des Fixes

- Nur der bestehende `applying`-Recovery-Abgleich erhält einen Fallback nach
  erfolglosem exakten Vergleich. Scope, Lifecycle, Akteur, freigegebener
  Kandidatenhash und Action-Receipt werden vorher weiterhin geprüft.
- Beide vollständigen Updates werden mit denselben Größen-, Repräsentations-,
  Schema- und Kausalitätsprüfungen geöffnet. Pending Structs/Delete-Sets sind
  weiterhin unzulässig.
- Vor der Normalisierung müssen alle Proof-Felder außer `fullStateHash`
  identisch sein: insbesondere Inhalt, Struktur/Block-IDs, State-Vector und
  Delete-Set. Gleicher Markdown-Text oder bloße Zustandsinklusion genügt nicht.
- Erst dann werden **beide** Updates unabhängig in temporären `gc:true`-Docs
  normalisiert und die vollständigen Proofs erneut exakt verglichen. Dies
  entspricht den aktuellen Hocuspocus-Defaults (`gc:true`, GC-Filter erlaubt
  alle Structs). Bei einer künftigen Server-GC-Konfigurationsänderung muss diese
  Annahme mitgeprüft werden.
- Keine normalisierten Bytes werden zurückgeschrieben. Unveränderliche
  Vorschlagsartefakte und dort erhaltene Kind-Anker bleiben unangetastet.
  Recovery öffnet keinen Live-Raum und spielt keine Mutation erneut ab.
- Normale Accept-Preflights und Current-/Candidate-Fences bleiben unverändert.
  Recovery nach bereits gespeicherter Operationssnapshot behält die vorhandene
  Durability-Prüfung; deren bewusst erlaubte spätere unabhängige Edits werden
  nicht mit dem strengeren, noch unquittierten `applying`-Fall verwechselt.

## Verifikation

| Prüfung | Ergebnis |
|---|---|
| Candidate-/State-Proof-/Durability-Suite | 44/44 bestanden |
| Action-Orchestrator | 18/18 bestanden |
| Orchestrator-Storage mit PGlite | Gate bestanden |
| Tatsächlicher Recovery-Code im Operationsharness | 16/16 bestanden |
| Vollständiges TypeScript ohne inkrementellen Cache | Exit 0 |
| ESLint für die vier geänderten Code-/Testdateien | Exit 0, keine Warnungen |
| Produktionsbuild einschließlich Lizenzgate | Exit 0, 353/353 Seiten |
| Personal-Browserregression: vollständige Textlöschung | bestanden, 19,8 s |
| Team-Browserregression: vollständige Textlöschung | bestanden, 27,0 s |

Die neuen Recovery-Orakel prüfen Text-Ersetzung und leeren Inhalt, exakten
Retry, genau eine History-Aufzeichnung und **null** Direct-Connection-Aufrufe.
Pure Yjs-Tests ergänzen Plain Text und beide Rich-Repräsentationen, Blockentfernung,
neu erzeugte Identitäten mit gleichem Text, partielle/andere Löschung trotz
gleicher Clocks, zusätzliche Peer-Edits, Pending Structs/Delete-Sets auf beiden
Seiten sowie defekte/zu große Updates. Eingabe-Bytes bleiben stets unverändert.

Im ersten Pure-Testlauf war eine Fixture-Annahme falsch: Eine logische
BlockTree-Entfernung erzeugt nicht zwingend physisch GC-fähige Structs. Die
Fixture bearbeitet den Absatz jetzt vor der Entfernung und belegt explizit
unterschiedliche Rohbytes. Kein Produktcheck wurde dafür gelockert. Der finale
Lauf ist `regression-r2`; der Produktfix bestand bereits den Operationsharness.

Die Browserläufe verwenden den normalen `read`-/`edit_file`-Pfad, sichtbare
Vorschau und Bestätigung sowie einen separat lesenden PostgreSQL-Probeprozess.
Die JSON-Anhänge beider Reports wurden zusätzlich ausgelesen: endgültiger
Inhalt `''`, Revisionen 1→2, genau ein Browser-Aktions-POST, persistierte Sequenz
0→1, unveränderter Vector, geändertes Delete-Set und verfügbare History mit
0 Bytes. Beide Vorschau-Screenshots wurden visuell geprüft.

Logs: `/tmp/fvrc1008-recovery-gc-{after,regression-r2,orchestrator-r1,typecheck-r1,lint-r1,build-r1}.log`.
Browserlogs: `/tmp/fvrc1008-recovery-gc-empty-{personal,team}-r1.log`;
HTML-Reports unter den entsprechenden `-report/index.html`-Pfaden. Der Build
enthält weiterhin 31 bestehende Turbopack-Warnungen sowie lokale Auth-/Runtime-
Warnungen; diese werden nicht als neue Fehler oder als behoben ausgegeben.

## Umgebung und Grenzen

Der `canvas-local-team-seat-dev`-Skill bestätigt einen einzelnen gesunden
verwalteten Stack mit PostgreSQL 18.4 / pgvector 0.8.3. Getestet wurde der
aktuelle Worktree auf **127.0.0.1:3000**, nicht der ältere Container auf 3100.
Browserfälle liefen einzeln mit einem Worker und mehr als 55 Sekunden Abstand.
Keine Env-/Policyänderung, kein Fixture-Reset, Containerneubau, Push oder Rollout.
Aufgeräumt wurden ausschließlich die eigenen Testdateien (Papierkorb) und
Sessions über die vorhandenen APIs.

Ein zweiter Agent prüfte den tatsächlichen Runtime-Diff, GC-Konfiguration,
Ressourcenfreigabe, Identitäts-/Löschbeweise und fehlendes Replay unabhängig
lesend, ohne konkreten Befund.

GitNexus: Vorab-Impact für `proposalRecoveryCurrentMatches` niedrig, ein
direkter Recovery-Aufrufer; Testharness ebenfalls niedrig. Staged-Analyse nach
Reindex: acht Dateien, 17 erfasste Symbole, keine erfassten Prozesse, niedriges
Risiko. Mitgemeldete Nachbarsymbole wie `position` sind nur Diff-Kontext; deren
Funktionskörper bleiben unverändert. Der gesamte Branch gegen lokales `main`
bleibt mit 208 Dateien, 1598 Symbolen und 30 Prozessen kritisch. Generierte
`AGENTS.md`-/`CLAUDE.md`-Indexzählungen werden nicht mitcommittet.

**Wichtig:** Der Operationsharness führt echten Recovery-Code und echtes Yjs
aus, simuliert aber SQL, History und Direct Connection. Die Browserläufe
belegen normale Annahme und PostgreSQL-Persistenz, keinen Prozessabsturz.
PG-S19 bleibt für echte Unterbrechungen an sämtlichen Live-/Persistenz-/History-
Grenzen und anschließendem Server-Restart offen. Auch die vollständige doppelte
Matrix, das aktuelle Produktionsimage und der manuelle Konflikteditor P12
sind damit nicht freigegeben.

### Nachfolgender echter Crashnachweis

[Proposal crash results](proposal-crash-results.md) ergänzt diesen ursprünglichen
Harness-Nachweis auf Produktcommit `73776e9dd`: Personal/Team mit tatsächlichem
SIGKILL und Neustart nach Yjs-Persistenz vor Operationsbestätigung, vor History
und nach History vor Operationsabschluss. Die drei konkreten PG-S19-Grenzen
sind damit zusätzlich im Browser auf echtem PostgreSQL geprüft; die übrigen
Crash-/Mehrprozessgrenzen und das Gesamtgate bleiben offen.
