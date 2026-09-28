# Lokale Raum-Mutationssperre: Nachweise und Grenzen

Stand: 26./27. September 2026. Ausgangscommit `da4d5c052`, aktueller Patch auf
`codex/review-conflict-resolution-20260925`. Schritt 1 des
[Durable-Publication-Plans](durable-publication-plan.md), kein vollständiger
PG-S19-/FVRC-1008-Abschluss.

## Produktänderung

Writer-SyncStep2 und -Update sowie Direct Connections verwenden dieselbe
FIFO-Sperre für die konkrete Y.Doc-Rauminstanz. Die Sperre bleibt über
asynchrone Prüfungen hinweg bestehen; vor einer Mutation wird der Zugriff
nach der Wartezeit erneut geprüft. Empfangsfehler und Vorprüfungsfehler geben
sie frei. Die Direct Connection hält sie bis Operationsbestätigung und
Disconnect-Speicherung. Pro Raum warten maximal 64, pro Prozess 1024 Aufträge;
30 Sekunden begrenzen nur das Warten, nie die Laufzeit des aktuellen Besitzers.

Der unabhängige Review fand eine zu breite erste Fassung: Auch Präsenz- und
Leseverkehr hätte hinter einem langsamen Store gewartet. Die endgültige
Fassung sperrt nur Writer-Mutationen. SyncStep1, Stateless sowie Read-only-
Update/SyncStep2 bleiben ohne Mutationssperre bedienbar. Die gemeinsame
Mechanik ist nach dem `code-structure`-Skill separat gekapselt; Rechte und
Dokumentidentität verbleiben im Server.

## Automatisierte Serverprüfungen

`npm run test:collaboration:room-mutation` besteht:

- Zehn isolierte Fälle: FIFO, unabhängige Raumidentitäten, idempotente/alte
  Freigaben, Wartezeitüberschreitung, Queue-Limits und deren Bereinigung,
  synchrone/asynchrone Fehler, zwei separat ausgewertete Modul-Bundles mit
  derselben globalen Sperre, sichere Parametergrenzen und kein automatisches
  Freigeben laufender kritischer Abschnitte.
- Acht Integrationsszenarien mit echten Hocuspocus-Connection-/MessageReceiver-
  Klassen und binären Yjs-Nachrichten: zwei Sockets warten auf Direct-Receipt;
  ein bereits laufender Empfang blockiert Direct; Guest-Policy-Ablehnung,
  entzogener Zugriff, geschlossener wartender Socket und ungültige Yjs-Nachricht
  blockieren Folgeänderungen nicht; ein anderer Raum bleibt unabhängig;
  früherer Store mit saveMutex und Direct-Disconnect erzeugen keinen Deadlock.
- Im Direct-Receipt-Fall passieren SyncStep1, Stateless und beide Read-only-
  Sync-Untertypen die echte Receiver-Schleife, während Writer-Nachrichten
  weiterhin warten. Keine unerlaubte Inhaltsänderung.

Diese Integration bindet keinen Port und verwendet Persistence-/Auth-Doubles.
Sie belegt die echte Bibliotheks-Hookreihenfolge, nicht PostgreSQL-Dauerhaftigkeit
oder Mehrprozess-Exklusivität. Die vollständige bestehende Lifecycle-Suite
besteht ebenfalls, einschließlich zwölf Direct-Lifecycle-Fällen, realen
Raum-Generationsrennen und Editor-/PDF-Schließen-Regressionen. Die neue Suite
ist in `test:collaboration:lifecycle` eingebunden.

Logs: `/tmp/fvrc1008-room-barrier-{focused,lifecycle}-final.log`.

## Browser mit dem verwalteten PostgreSQL-Stack

Getestet wird der neu gestartete Host-Dev-Server auf `127.0.0.1:3000` aus
diesem Worktree, nicht das ältere Containerimage auf 3100. Einzelne Läufe,
ein Worker, mindestens 55 Sekunden Abstand nach bestätigtem Abschluss.
Normale Agentenwerkzeuge, echte UI-Bestätigung, isolierte eigene UUID-Fixtures;
kein Fixture-Reset oder Containerneubau.

| Fall | Ergebnis | Report |
|---|---|---|
| Personal: überlappende B/C, C annehmen | bestanden, 23,9 s | `/tmp/fvrc1008-room-barrier-personal-conflict-r1-report/index.html` |
| Team: überlappende B/C, C annehmen | bestanden, 15,7 s | `/tmp/fvrc1008-room-barrier-team-conflict-r1-report/index.html` |
| Personal: zehn Roots, drei Einzelannahmen und Siebener-Batch | bestanden, 54,8 s | `/tmp/fvrc1008-room-barrier-personal-batch-r1-report/index.html` |
| Team: zehn Roots, drei Einzelannahmen und Siebener-Batch | bestanden, 54,7 s | `/tmp/fvrc1008-room-barrier-team-batch-r1-report/index.html` |

Beide Fälle prüfen exakten Endinhalt, genau einen Aktions-POST und genau eine
neue Historyrevision. B bleibt offen als `conflicted` mit konkretem Grund statt
Timeline-Stale. Das ist bestehendes Produktverhalten als Regression gegen die
neue Sperre, kein neu implementierter manueller Konflikteditor.

Die Sammelannahme prüft alle zehn gewünschten Textänderungen im Enddokument
und genau vier neue Revisionen (`accept`, `accept`, `accept`, `batch_accept`).
Die Oberfläche zeigt anschließend keine offenen Agentenreviews mehr. Die
Screenshots der beiden Konfliktfälle und beider Sammelannahmen wurden
auch visuell geprüft; JSON-Belege bestätigen die exakten Revisionszahlen.

Getestete Produktdateien (SHA-256), beide zuletzt vor Start des Hostprozesses geändert:

- `app/lib/collaboration/room-mutation-lock.ts`:
  `fa14c616c53091e21cc48901924bd056219e6ce744448c7cf72171950e363e95`
- `server/collaboration-server.ts`:
  `36df7457de954449788c79b21192896451ff0d4a35ce3d280744b62d84052de8`

Der Receiver-Test wartet vor dem Reverse-Race explizit darauf, dass Direct
bereits die Workspace-Sperre erworben und die Raumsperre angefordert hat.
Damit kann ein noch nicht gestarteter Dateisperren-Prozess keinen scheinbar
bestandenen Test erzeugen. Fehler-Cleanup gibt alle Test-Gates und Leases
frei und wartet begrenzt auf die offenen Operationen.

## Abschlussprüfungen

Vollständiges TypeScript ohne inkrementellen Cache und fokussiertes ESLint
bestehen (`/tmp/fvrc1008-room-barrier-{typecheck,lint}-final.log`). Während
gleichzeitiger Dev-Typgenerierung hatte ein Subagent zwischenzeitlich Fehler
in generierten Next-Validator-Dateien gesehen; der abschließende unabhängige
Lauf erfolgt bei gestopptem Dev-Server und ist grün. Ein zwischenzeitlicher
Lintfehler im neuen Test (`const module`) wurde ebenfalls korrigiert und
erneut geprüft.

`npm run build` besteht mit 353/353 Seiten und Lizenzgate. Die bekannten 31
Turbopack-Warnungen sowie die Build-Meldung zur hier nicht konfigurierten
direkten MCP-OAuth-Basisadresse bleiben sichtbar; keine neue Laufzeitfreigabe
wird daraus abgeleitet. Log: `/tmp/fvrc1008-room-barrier-build-final.log`.

Nach Reindex erfasst GitNexus für den gestagten Patch elf Dateien und 110
Symbole ohne betroffene indexierte Prozesse, Risiko niedrig. Der gesamte
Feature-Branch gegenüber lokalem `main` umfasst weiterhin 225 Dateien,
1814 Symbole und 30 Prozesse, Risiko kritisch. Diese getrennte Bewertung wurde
mitgeteilt; kein Merge oder Push. Generierte Indexzählungen in AGENTS.md und
CLAUDE.md sind nicht Teil des Patches.

Alle vier unveränderten Stack-Container sind gesund, PostgreSQL 18.4 und
pgvector 0.8.3 bestätigt (`/tmp/fvrc1008-room-barrier-stack-after.log`). Kein
Containerimage gebaut, keine Dependency-/Lockfile-/Runtime-Env-Änderung und
keine Produktionsaktivierung.

Der normale Host-Dev-Server auf 3000 wurde nach dem Build wieder gestartet;
Health bestätigt PostgreSQL sowie bereite Collaboration-WebSockets und
Persistenz (`/tmp/fvrc1008-room-barrier-health-after.json`).

## Noch offen

Die aktuelle Veröffentlichung erfolgt weiterhin vor dem endgültigen
PostgreSQL-Commit. Diese Sperre schließt die dokumentierte `applying`-
Crashlücke daher nicht. Whole-Room-Store-CAS, gefencete Mehrprozess-Owner,
atomarer Kandidaten-/Operationscommit vor Live-Publish und die zugehörigen
Peer-Reconnect-Crashfälle folgen gemäß dem verlinkten Plan. Legacy-Ungewissheit
wird nicht unsicher aufgehoben. FVRC-1008 bleibt `in_progress`, P12 offen.
