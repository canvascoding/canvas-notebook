# Prozessabsturz vor Beginn der Proposal-Mutation

Stand: 26. September 2026. Produktstand `815057811`; Ergänzung des privaten
Test-Harness. Teilnachweis für PG-S19, keine vollständige FVRC-1008-Abnahme.

## Exakte Grenze und Sicherheitsnachweis

Der neue Punkt `prepared-before-apply` liegt nach dem Commit von Graph-Beleg
und synthetischer Operation, aber **vor** deren erstem `preparing → applying`
CAS-Update. Zu diesem Zeitpunkt wurde noch keine Direct Connection geöffnet.
Der erste CAS-Zählerstand ist `0`, nicht `1`.

Nur der explizite lokale IPC-Launcher installiert den Hook am PostgreSQL-
Client. Er erkennt ausschließlich die genaue SQL-Form dieses Übergangs und
prüft anschließend read-only Operation, Graph-Beleg, Dokument, Workspace,
Benutzer, Pfad, Lifecycle, Schema und unveränderte Dokumentsequenz. Die
Agentensession muss frisch und an das eigene UUID-Testdokument gebunden sein.
Fremde Queries werden unverändert delegiert. SIGKILL beendet ausschließlich
den eigenen Hostprozess, bevor die echte UPDATE-Anweisung ausgeführt wird.
Kein SQL-Write stellt einen Crashzustand her; keine Produktionsroute importiert
den Test-Hook.

Der neue Browsertest prüft Personal und Team mit normalen Agentenwerkzeugen,
sichtbarer Löschvorschau und Annahmebestätigung. Ein unabhängiger PG-Leser
prüft den Zustand auch bei gestopptem App-Server. Nach Startup-Recovery muss
die Operation `cancelled` und der ursprüngliche Auftrag terminal `failed`
mit `PROPOSAL_NO_EFFECT` sein: unveränderter Inhalt, Binärhash, Yjs-Proof und
Sequenz, keine neue Revision und kein Recovery-Replay.

Anschließend muss die UI ihren verlorenen Auftrag per Statusabfrage klären
und eine **neue ausdrückliche Annahme** ermöglichen. Diese verwendet einen
neuen Idempotenzschlüssel und erzeugt genau eine Mutation sowie eine Revision.
Der alte Auftrag bleibt auch danach fehlgeschlagen; identische Wiederholungen
des neuen Auftrags liefern denselben Erfolgsbeleg. Der historische Vorschlag
bleibt read-only erreichbar. Freigabetokens werden nicht als JSON-Beleg
angehängt.

## Ausführung

Die Fälle laufen getrennt mit einem Worker auf `127.0.0.1:3000` aus dem
aktuellen Worktree und mit der privaten Host-Dev-/Fixture-Env des
`canvas-local-team-seat-dev`-Stacks. Das ältere Containerimage auf 3100 ist
nicht die getestete Quelle. Kein Containerneubau und kein Fixture-Reset.

| Workspace | Lauf | Ergebnis |
|---|---|---|
| Personal | `personal-r2` | bestanden, 51,5 s |
| Team | `team-r1` | bestanden, 50,9 s |

Logs: `/tmp/fvrc1008-preparing-<Lauf>.log`; Reports mit den drei Screenshots
und begrenzten JSON-Belegen: `/tmp/fvrc1008-preparing-<Lauf>-report/index.html`.
Beide Reports wurden zusätzlich gelesen: `preparing → cancelled`, Sequenz
`0 → 0`, identische Binärbytes und gültiger vollständiger Yjs-Snapshot-Proof.
Erst die frische UI-Annahme verändert den Inhalt und erhöht die History von
einer auf zwei Revisionen. Screenshots der wieder bedienbaren Personal-/Team-
Reviews sowie der historischen Ansicht wurden visuell kontrolliert. Die UI
zeigt noch einen allgemeinen Fehlerhinweis zum alten Auftrag, aber die frische
Vorschau und Annahme sind verfügbar; kein bloßer Timeline-Stale-Ersatz.

Die gemeinsam genutzte Persistenzprüfung ist nach dem `code-structure`-Skill
in `tests/helpers/proposal-crash-state.ts` zusammengeführt. Sie startet den
bestehenden read-only PG-Leser und behandelt fehlende Operationsbelege vor
Aktionsanlage explizit als `null`. Deshalb werden außerdem bestehende
Post-Persistenz-Crashfälle erneut ausgeführt:

| Regression | Lauf | Ergebnis |
|---|---|---|
| Personal, `persisted-before-ack` | `regression-personal-ack-r1` | bestanden, 49,9 s |
| Team, `history-before-receipt` | `regression-team-history-r1` | bestanden, 47,0 s |

15 Probe-Tests (acht neue, sieben vorhandene), vollständiges TypeScript ohne
inkrementellen Cache und fokussiertes ESLint bestehen. Logs:
`/tmp/fvrc1008-preparing-{probes-final,typecheck-final,lint-final}.log`.
Der unabhängige zweite Code-Review fand nach Korrektur des CAS-Guards keine
weiteren konkreten Probleme im Hook und seinen E2E-Orakeln.

Der Produktionsbuild besteht mit 353/353 Seiten und bestandenem Lizenzgate.
Die bekannten 31 Turbopack-Warnungen bestehen weiter; Buildlog:
`/tmp/fvrc1008-preparing-build-final.log`. Kein Containerimage wurde gebaut.

Nach Reindex erfasst GitNexus für diesen abgegrenzten Patch zehn Dateien,
49 Symbole und keine betroffenen Produktprozesse bei niedrigem Risiko. Der
Gesamtbranch gegenüber lokalem `main` bleibt mit 217 Dateien, 1706 Symbolen
und 30 Prozessen kritisch; keine Merge-/Produktionsfreigabe. Die automatisch
erzeugten Indexzählungen in AGENTS.md/CLAUDE.md wurden nicht übernommen.

Der normale Host-Dev-Server wurde abschließend aus demselben Worktree auf
3000 wieder gestartet, ohne Crash-Launcher. Health bestätigt PostgreSQL sowie
bereite Collaboration-Persistenz und WebSockets. Alle vier unveränderten
Stack-Container bleiben gesund (PG 18.4, pgvector 0.8.3); Nachweis:
`/tmp/fvrc1008-preparing-stack-after.log`. Kein Push und kein Rollout.

Der erste Personal-Lauf (`/tmp/fvrc1008-preparing-personal-r1.log`) scheiterte
am nicht erreichten Crashpunkt. Der unabhängige Subagentenreview fand den
Grund: Der Test-Hook erlaubte anfangs nur positive CAS-Versionen, während die
echte Operation mit `0` startet. Der Hook akzeptiert jetzt sichere nichtnegative
Ganzzahlen. Ein eigener Regressionstest deckt genau den Erstübergang ab;
negative, gebrochene, unsichere und String-Werte bleiben ausgeschlossen.
Der fehlgeschlagene Lauf ersetzte keinen lebenden Prozess nach Timeout und
räumte ausschließlich seine eigene Fixture über die normalen APIs auf.
Dies war ein Harnessfehler, kein Produkt-Recovery-Fehler.

## Noch offene Grenze: Mutation möglicherweise begonnen

Dieser Nachweis gilt ausdrücklich nicht für den Zeitraum **nach** dem CAS
zu `applying` und **vor** beweisbarer Yjs-Persistenz. Zwei verschiedene Abläufe
können denselben gespeicherten Ausgangszustand hinterlassen:

- Abbruch vor dem eigentlichen Mutationscallback.
- Änderung im Live-Yjs-Dokument, Abbruch vor Speicherung; ein Peer könnte die
  Änderung bereits gesehen haben und später wieder synchronisieren.

Der aktuelle `recoverProposalGraphCandidateOperation` darf bei `applying`
ohne vollständigen Kandidatennachweis nur `PROPOSAL_RECOVERY_REQUIRED` melden.
Er wiederholt die Mutation nicht. Wenn kein passender Zustand mehr ankommt,
kann der aktive Graph-Auftrag weitere Annahmen dauerhaft blockieren. Die UI
bietet Statusprüfung bzw. Wiederholung desselben Auftrags, aber keine separat
abgesicherte Auflösung dieses ungewissen Zustands.

Gleichheit des gespeicherten Ausgangstexts reicht **nicht** aus, um einen
solchen Auftrag nachträglich als sicher unangewendet zu deklarieren. Diese
Lücke benötigt einen getrennten Recovery-/Fencing-Entwurf und E2Es mit
Peer-Reconnect: keine verlorenen Änderungen, kein Replay, keine verspätete
Übernahme eines verworfenen Kandidaten und danach wieder mögliche Aktionen.
Der vollständige PG-S19-, Mehrprozess-/Restore-/Rollback-Nachweis bleibt offen.
FVRC-1008 bleibt `in_progress`; P12 ist nicht freigegeben.
