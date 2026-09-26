# Proposal-Recovery nach echtem Prozessabsturz

Stand: 26. September 2026. Produktstand `73776e9dd`; ergänzendes Test-Harness
dieses Commits. Teilnachweis für PG-S19, keine vollständige FVRC-1008-Abnahme.

## Aufbau und Grenzen

`tests/file-version-center-proposal-crash.spec.ts` verwendet gewöhnliche
`read`-/`edit_file`-Werkzeuge für einen Rich-Absatz, sichtbare Review-Vorschau
und Bestätigung. Der Vorschlag löscht den vollständigen Text. Das Dokument
wird wirklich über Collaboration nach PostgreSQL gespeichert; weder Yjs-
Zustände noch Operationsstatus werden durch Test-SQL hergestellt.

Ein privater IPC-Launcher startet ausschließlich seinen eigenen Host-Dev-
Prozess auf 127.0.0.1:3000. Explizite Test-Flags, Development-Modus, lokale
PostgreSQL-Datenbank auf 55433, ein freier Port und eine frische, exakt an das
UUID-Testdokument gebundene Agentensession sind erforderlich. Paralleles
Arming ist gesperrt. Die Probe delegiert fremde Vorgänge unverändert und
prüft den tatsächlich gespeicherten vollständigen Yjs-Zustand gegen die
beobachtete Mutation, bevor sie den eigenen Prozess per SIGKILL beendet.

Keine zusätzliche HTTP-Debugroute und kein Import durch den Produktstart.
Logs sind exklusiv angelegte 0600-Dateien im jeweiligen Playwright-
Artefaktverzeichnis. Raw-Serverlogs werden nicht in den Report übernommen.
Ein Beobachtungstimeout startet keinen Ersatz für einen noch lebenden Server.

Der `canvas-local-team-seat-dev`-Stack bleibt derselbe: PostgreSQL 18.4 /
pgvector 0.8.3 und Control Plane laufen unverändert. Das ältere Notebook-
Image auf 3100 ist **nicht** die getestete Quelle. Kein Container wurde neu
gebaut oder beendet, keine Env-Datei geändert und kein Fixture-Reset ausgeführt.
Aufgeräumt werden nur die eigenen UUID-Testdateien (Papierkorb) und Sessions
über die normalen APIs.

Abschließend wurde der normale Host-Dev-Server aus dem geprüften Worktree
auf 3000 wieder gestartet (ohne Crash-Launcher). Health bestätigt PostgreSQL
und einsatzbereite Collaboration-Persistenz/WebSockets. Alle vier unveränderten
Stack-Container sind gesund; Statusnachweis:
`/tmp/fvrc1008-crash-stack-after.log`.

## Drei Unterbrechungspunkte

| Punkt | Nachgewiesener Zustand vor SIGKILL | Erwartete Recovery |
|---|---|---|
| `persisted-before-ack` | Yjs gespeichert; Operation noch `applying`, kein Operationssnapshot, kein History-Capture | Gespeicherten Kandidaten einschließlich GC-Normalisierung nachweisen, ohne Live-Replay abschließen |
| `persisted-before-history` | Yjs gespeichert und Operationssnapshot quittiert; `applied_to_ydoc`, History noch nicht aufgerufen | Fehlenden History-/Aktionsabschluss genau einmal ergänzen |
| `history-before-receipt` | Yjs, Operationssnapshot und History gespeichert; Operationsstatus noch `applied_to_ydoc`, keine Revisionszuordnung im Operationsbeleg | Vorhandene History wiederverwenden, keinen zweiten Eintrag anlegen |

## Gemeinsame Orakel

1. Vor der Annahme bleibt der ursprüngliche Text erhalten; die UI zeigt die
   echte Löschzeile und eine verfügbare Annahmeaktion.
2. Der Launcher beobachtet genau einen Direct-Connection-Aufruf und eine
   Mutation für den ausgewählten Vorgang; der Prozess endet tatsächlich mit
   SIGKILL an der gewählten Grenze.
3. Vor dem Neustart wird die Browserseite verlassen, damit kein gecachter
   Yjs-Clientzustand die Wiederherstellung unbemerkt übernehmen kann. Ein
   separater, nur lesender Prozess prüft PostgreSQL bei gestopptem App-Server.
4. Der neue App-Prozess schließt den Vorgang zu `persisted_yjs` ab. Inhalt
   bleibt `''`; Binärhash, vollständiger Zustandsnachweis und Dokumentsequenz
   bleiben unverändert. Kein Direct-Connection-Aufruf für dieses Dokument
   darf während oder nach der Startup-Recovery auftreten.
5. Der exakt verlorene Annahmeauftrag liefert einen erfolgreichen Beleg für
   genau den Vorschlag. Ein weiterer identischer Retry liefert denselben
   Beleg; History wächst insgesamt um genau eine Revision.
6. Die Oberfläche verarbeitet ihren gespeicherten Pending-Auftrag über den
   Status-Endpunkt und bietet keine erneute Annahme an. Sie wählt zunächst
   absichtlich Current. Ein anschließender expliziter historischer Deep Link
   zeigt denselben Vorschlag als endgültig angewendet und schreibgeschützt.

## Ausführung

Sieben isolierte Probe-Tests bestehen, einschließlich fremder Dokument-/
Workspace-/Pfad-/User-Scope, unveränderter Callback-Weitergabe, genau einer
Mutation, der drei Reihenfolgen, unpassender persistierter Bytes und sicherer
Deinstallation. Der Punkt nach History akzeptiert nur `captured` oder
`already_captured` mit Revision **und** Inhaltsbindung. Disabled, unsupported,
deduplicated_checkpoint sowie fehlende Revision/Bindung können keinen
erfolgreichen Crashnachweis erzeugen. Diese Tests mocken die Infrastruktur;
sie sind nicht die unten beschriebenen PostgreSQL-Browserfälle.

Zusätzliche lokale Negativprüfungen: Produktionsmodus, fehlendes Opt-in,
Remote-/falsche Datenbank, falscher/belegter Port und fehlendes IPC verweigern
den Launcher. Fünf Helper-Prüfungen verweigern fehlendes Opt-in, fremde oder
übergeordnete Logpfade, unbekannte Dateinamen und das Überschreiben einer
vorhandenen Logdatei. Deren Bytes bleiben unverändert, kein Kindprozess startet.

Die sechs Kombinationen Personal/Team × Unterbrechungspunkt laufen einzeln
mit einem Worker auf dem verwalteten PostgreSQL. Die HTML-Reports enthalten begrenzte
JSON-Belege (`crash-boundary.json`, `crash-recovery-evidence.json`) und Screenshots
vor dem Absturz und nach der historischen Wiederöffnung.

| Workspace | Grenze | Lauf | Ergebnis |
|---|---|---|---|
| Personal | vor Operationsbestätigung | `personal-before-ack-r4` | bestanden, 47,6 s |
| Personal | vor History | `personal-before-history-r1` | bestanden, 47,9 s |
| Personal | nach History | `personal-after-history-r2` | bestanden, 47,0 s |
| Team | vor Operationsbestätigung | `team-before-ack-r1` | bestanden, 57,2 s |
| Team | vor History | `team-before-history-r1` | bestanden, 47,0 s |
| Team | nach History | `team-after-history-r1` | bestanden, 47,0 s |

Browserlogs: `/tmp/fvrc1008-crash-<Lauf>.log`, HTML-Reports:
`/tmp/fvrc1008-crash-<Lauf>-report/index.html`. Zwei frühe Personal-Erfolgsläufe
wurden nach Ergänzung der Launcher-/History-Prüfungen wiederholt. Die JSON-
Belege wurden separat aus den Reports gelesen und überprüft; repräsentative
Personal- und Team-Screenshots vor/nach Crash wurden visuell kontrolliert.

Die finale fokussierte Prüfung besteht: sieben Probe-Tests, 18 Orchestrator-
Tests, PGlite-Orchestrator-Storagegate und 16 Operationsharness-Tests,
vollständiges TypeScript ohne inkrementellen Cache, ESLint und Produktionsbuild
mit 353/353 Seiten sowie bestandenem Lizenzgate. Der Build enthält die bereits
bekannten 31 Turbopack-Warnungen; diese werden nicht als behoben ausgegeben.
Logs: `/tmp/fvrc1008-crash-{probe-final-r2,orchestrator-final,typecheck-final-r2,lint-final-r2,build-final-r2}.log`.

Reproduktion: private Host-Dev- und Fixture-Env über `node --env-file` laden;
`E2E_EXTERNAL_SERVER=1`, `COLLABORATION_E2E=1`,
`CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1`, `CANVAS_PROPOSAL_CRASH_TEST=1`,
`BASE_URL=http://127.0.0.1:3000`, `NODE_ENV=development` setzen. Dann genau einen
Fall mit Playwright `--workers=1 --grep '<workspace>.*<point>'` wählen.
Port 3000 muss zuvor frei sein; das Harness besitzt Start, Crash und Stop.

Der unabhängige Subagentenreview prüfte Arming-Race, exakte Fixture-/Persistenz-
Prüfung, Wrapper-Delegation, Logpfade und Erfolgskriterien. Neue Symbole waren
vor dem Reindex noch unbekannt; nach dem vollständigen Indexaufbau ist der
finale Probe-Code mit seinen History-Guards explizit auflösbar. Die finale
Staged-Analyse einschließlich Nachweisen erfasst zehn Dateien, 72 Symbole und
keine betroffenen Produktprozesse bei niedrigem Risiko. Der gesamte Branch
gegen lokales `main` bleibt mit 212 Dateien, 1666 Symbolen und 30 Prozessen
kritisch. Keine Mergefreigabe daraus.
Die automatisch erzeugten Indexzählungen in AGENTS.md/CLAUDE.md wurden
zurückgenommen; nur die vorgesehenen Tests und Nachweise werden committet.

## Bei der Testentwicklung korrigiert

- `result_json` ist vor dem Operationssnapshot legitim SQL-NULL. Der
  unabhängige Testleser gibt dafür jetzt `resultHash: null` aus, statt den
  tatsächlichen Crashnachweis beim Hashen abzubrechen. Kein Produktfix.
- Die erste UI-Assertion erwartete direkt den historischen Vorschlag.
  Tatsächlich konvergiert die bestehende Lost-Response-Logik zuerst zu Current.
  Der Test prüft nun diesen Statusabschluss und danach separat den erneuten
  historischen Deep Link; Produktverhalten wurde nicht abgeschwächt.
- TypeScript darf nicht gleichzeitig mit den absichtlich abgebrochenen und
  neu startenden Next.js-Prozessen generierte Routentypen lesen. Ein früher
  Versuch scheiterte an `.next/dev/types/routes.d.ts`; der finale Check wird
  ohne laufenden App-Prozess ausgeführt.
- Ein Build erwischte einen unvollständigen Zwischenstand während der
  ergänzten Unit-Fixture (Referenz vor Deklaration). Nach Abschluss des
  Subagenten-Patches wurde der Build separat auf dem fertigen Stand wiederholt.

## Nicht daraus ableiten

Dies ist ein echter **App-Prozess**-Crash mit weiterlaufendem PostgreSQL,
kein Datenbank-, Container-, VM- oder Stromausfall. Noch nicht abgedeckt sind
die übrigen Grenzen vor Live-Mutation bzw. vor bestätigter Yjs-Persistenz,
konkurrierende Peer-Edits während des Neustarts und die vollständige
Mehrprozess-/Restore-/Rollback-Matrix. Die negativen GC-/Teilzustands-/Peer-
Beweise bleiben getrennte Lower-Level-Tests aus [recovery-gc-results.md](recovery-gc-results.md).

FVRC-1008 bleibt `in_progress`; zwei Gesamtmatrixläufe, ein aktuelles
Produktionsimage und der separate manuelle Konflikteditor P12 sind nicht
freigegeben. Kein Push und keine Produktionsaktivierung.
