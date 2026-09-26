# PostgreSQL-Raumzuständigkeit: getesteter, noch inaktiver Baustein

Stand: 27. September 2026. Ausgangscommit `c5117687e`, Worktree
`review-conflict-resolution`. Teil von Schritt 2 des
[Durable-Publication-Plans](durable-publication-plan.md), kein Abschluss von
FVRC-1008, keine Produktionsaktivierung und noch kein manueller Konflikteditor.

## Vertrag

Vier additive Felder in `collaboration_yjs_states` speichern eine steigende
Epoch, einen zufälligen Claim-Token, die PostgreSQL-Backend-PID und dessen
exakten Startzeitpunkt. Epoch 0 bedeutet noch nicht aktivierte Ownership.
Freigabe löscht den Token, niemals die Epoch. Ein neuer Claim erhöht die Epoch.

`createCollaborationRoomOwnerSession` übernimmt eine dedizierte, bereits
verbundene PostgreSQL-Client-Sitzung. Sie darf nicht als Pool-Checkout verwendet
oder zwischen Operationen zurückgegeben werden. Eine Sitzung hält mehrere
64-Bit-Advisory-Locks, nicht eine Verbindung pro Datei. Die Schlüssel sind
domänengetrennte SHA-256-Ableitungen. Doppelte lokale Claims und auch eine
lokale Hashkollision werden abgewiesen, damit keine rekursiven Locks entstehen.
Andere Sitzungen erhalten unmittelbar `ROOM_OWNER_BUSY` statt blockierend auf
einen beliebig lange geöffneten Raum zu warten.

Claim: Advisory-Try-Lock → Dokumentzeile `FOR UPDATE` → vollständige aktive
Dokumentidentität prüfen → Epoch/Token/Backend speichern → bestätigter COMMIT
→ eingefrorenen lokalen Nachweis zurückgeben. Scope wird vor dem Einreihen
kopiert. Schreiben: dieselbe Zeilensperre → Scope/Epoch/Token/PID/Startzeit und
den tatsächlich noch gehaltenen Advisory-Lock prüfen → schreiben/COMMIT.
PID allein wäre wegen Wiederverwendung kein ausreichender Nachweis.

Freigabe: Queue-Platz reservieren → lokaler Nachweis ungültig → dieselbe
Zeilensperre → ausschließlich eigenen Token entfernen → COMMIT → Advisory-
Unlock. Eine volle Queue lehnt vor der lokalen Invalidierung ab; derselbe
Handle bleibt für einen Retry gültig. Ein alter Handle darf den Nachfolger
nicht entsperren. Die Zeilensperre ordnet laufenden Write und Übernahme: Der
vorherige Write wird entweder vorher abgeschlossen oder mit altem Nachweis
abgewiesen. Eine Übernahme kann ihn nicht unsichtbar überschreiben.

Alle Befehle einer Sitzung sind seriell. Queryfehler, fehlende Antworten nach
5 Sekunden sowie `error`/`end` invalidieren sämtliche Handles; unsichere
Sitzungen werden geschlossen, nicht neu verbunden oder blind wiederholt.
Auch ein tatsächlich gespeicherter Claim ohne COMMIT-Antwort wird nicht an
den Aufrufer bestätigt. Ein frischer Owner übernimmt anschließend mit höherer
Epoch. Es gibt maximal 256 gehaltene Locks und 256 wartende/laufende Befehle;
auch bereits zur Freigabe vorgemerkte Locks zählen zur Grenze.

`persistCollaborationYDoc` prüft den optionalen Nachweis innerhalb seiner
bestehenden kurzen Transaktion. Ein bereits beanspruchtes Dokument akzeptiert
auch nach Freigabe keinen ungefencten Write oder No-op mehr. Für Epoch 0 bleibt
der bisherige Pfad bestehen. Nachweis und Scope werden vor dem ersten `await`
kopiert. Keine Netzwerkadresse, kein Passwort und kein neuer Konfigurations-Key
werden hier eingeführt.

## Nachweise

- Sieben Sitzungs-Fehlerfälle mit bewusst begrenztem Client-Fake: doppelte
  Claims, kopierter Scope, sofortige/stale Freigabe, volle Queue mit erfolgreichem
  Freigabe-Retry, verlorene COMMIT-Antwort, Query-/Sitzungsfehler und Timeout.
  Das ist kein Beweis für PostgreSQL-Lockverhalten.
- Echte PostgreSQL-18-Backends: Konkurrenz, mehrere Dokumente pro Sitzung,
  Claim/Freigabe/Übernahme, ungültige Scope-/Lifecycle-/Backend-Nachweise,
  Tokenpflicht nach Freigabe sowie positive Writes des Nachfolgers.
- `pg_blocking_pids` belegt, dass Claim und Freigabe auf einen laufenden
  zeilengesperrten Write warten. Exakte Sequenzen bleiben bei Ablehnung erhalten.
- Der Test beendet ausschließlich seine eigene Owner-Backend-Verbindung;
  lokaler Handle und dauerhafter Write werden schon vor einer Übernahme
  abgewiesen. Danach kann der Nachfolger tatsächlich schreiben.
- Besitzerverlust während eines bereits autorisierten, noch zeilengesperrten
  Writes invalidiert drei lokale Handles. Der neue Owner hält bereits den
  Advisory-Lock, wartet aber nachweislich auf die Zeile. Erst nach Commit der
  Sequenz 1 übernimmt er mit höherer Epoch; alter Nachweis bleibt gesperrt,
  neuer Nachweis schreibt Sequenz 2. Auch dieser Verlustfall bleibt nutzbar.
- Eine echte COMMIT-Ausführung mit anschließend injiziertem Antwortverlust
  belegt gespeicherte Epoch 1, keine bestätigte Ownership und erfolgreiche
  frische Übernahme mit Epoch 2.
- Der produktive `persistCollaborationYDoc` läuft mit einem auf das Testschema
  begrenzten Verbindungsadapter: fehlender/alter Token wird abgewiesen,
  gültiger Token schreibt exakten Yjs-Inhalt und Sequenzen 1 beziehungsweise 2
  vor/nach Übergabe. Dies sind getrennte PostgreSQL-Backends, ausdrücklich
  noch keine zwei vollständigen App-/OS-Prozesse.

Der PG-Test erzeugt ausschließlich sein eigenes UUID-Schema, setzt einen darauf
begrenzten `search_path` und entfernt dieses nach dem Schließen eigener
Verbindungen. Keine Fixture-, Lizenz- oder Bestandsdokumente werden verändert.
Der bestehende PGlite-Persistenztest prüft den realen Migrationslauf; die reine
SQL-Projektionsfixture erhält nur die neuen inaktiven Default-Felder.

Logs: `/tmp/fvrc1008-owner-{session,postgres,persistence,lifecycle,projection}.log`.
Finale Wiederholung einschließlich Verlust während Write:
`/tmp/fvrc1008-owner-postgres-final.log` und
`/tmp/fvrc1008-owner-lifecycle-final.log`.
Testbefehle: `npm run test:collaboration:room-owner` und mit dem privaten
verwalteten PostgreSQL-Env `npm run test:collaboration:room-owner:postgres`.
Der Sitzungstest ist in die Lifecycle-Suite eingebunden.

## Browser-Regressionen und Abschlussprüfung

Vier serielle Playwright-Läufe mit einem Worker und mindestens 55 Sekunden
Abstand nach bestätigtem Abschluss laufen auf dem aktuellen Host-Dev-Quellstand
unter `http://127.0.0.1:3000`. Der verwaltete PostgreSQL-/Control-Plane-Stack bleibt
bestehen; das ältere Containerimage auf Port 3100 enthält diesen Patch nicht.
Eigene UUID-Dateien und Agentensitzungen werden über authentifizierte APIs
erstellt und entfernt. Gewöhnliche Agentenwerkzeuge werden wirklich ausgeführt,
ohne Abhängigkeit von einem Modellaufruf.

| Fall | Ergebnis | Report unter `/tmp/` |
|---|---|---|
| Personal: B/C überlappen, C zuerst annehmen | bestanden, 25,2 s | `fvrc1008-owner-personal-conflict-report/index.html` |
| Team: B/C überlappen, C zuerst annehmen | bestanden, 16,6 s | `fvrc1008-owner-team-conflict-report/index.html` |
| Personal: zehn Vorschläge, drei einzeln + sieben im Batch | bestanden, 54,9 s | `fvrc1008-owner-personal-batch-report/index.html` |
| Team: zehn Vorschläge, drei einzeln + sieben im Batch | bestanden, ca. 1 min | `fvrc1008-owner-team-batch-report/index.html` |

B bleibt offen mit konkretem Konflikt statt Timeline-Fehler. Die Sammelannahme
prüft exakten Endtext, vier Aktionsbelege, vier neue Historyrevisionen (1 → 5),
keine offenen Reviews sowie wirkungslose Original-Retries auch bei deaktiviertem
Tool-Graph-Gate. Alle vier Ergebnisscreenshots wurden visuell geprüft. Das sind
gezielte Regressionen, keine vollständige PG-S-/MR-Matrix und kein P12-Nachweis.

`npm run build` besteht mit 353 Seiten; die 31 bekannten Turbopack-Warnungen
bleiben bestehen. Vollständige Lifecycle-/Projektions-Suites, der vorhandene
reale PostgreSQL-Store-Concurrency-Test, fokussiertes ESLint und abschließendes
`tsc --noEmit --incremental false` bestehen. Eine beschädigte generierte
`.next/dev/types/validator.ts` wurde durch Sicherung der generierten Typen und
`next typegen` bei gestopptem eigenem Dev-Server behoben, ohne Produktänderung.
Die erneute Typprüfung ist grün. Logs tragen den Präfix `/tmp/fvrc1008-owner-`:
`build.log`, `typecheck-final.log`, `typegen.log`, `lint-final.log`,
`store-concurrency-final.log`, `stack-final.log`, `health-final.json`.

Read-only-Preflight: 877 Bestandszeilen, **keine** aktivierte Ownership-Epoch,
keine verbliebenen Ownership-Testschema. Alle vier unveränderten Container
sind gesund (PostgreSQL 18.4, pgvector 0.8.3). Keine Dependency-, Lockfile-,
Secret-, Lizenz- oder Containeränderung; kein Push und keine Produktionsfreigabe.

GitNexus: zentraler Migrationslauf kritisch (42 direkte Aufrufer), bestehender
Store mittel (9 direkte Aufrufer). Der abgegrenzte gestagte Patch umfasst
12 Dateien/106 Symbole/0 indexierte Prozesse, niedrig. Der gesamte Branch
gegen lokales `main` bleibt kritisch: 239 Dateien/2000 Symbole/30 Prozesse.
Der zunächst fehlgeschlagene inkrementelle Indexlauf wurde durch einen
erfolgreichen vollständigen Neuaufbau ersetzt; keine Quellcodeänderung dafür.

SHA-256 des getesteten Produktstands:

- `room-owner.ts`: `67041e4df97ef89b775196f2d345c14aedccdc45a2b1563667b0604cee5c2d3e`
- `persistence.ts`: `c6a6cce9fb50414b036054fca99d8423db8d0e17c4f0d086fe47036b6094fe01`
- `collaboration-room-owner-migration.ts`: `757973c37b6edf8222d8cddcca72ed31a0855a93353bbd9dc28d9c7b92809283`
- `postgres.ts`: `0ccc9ca6260c3d1501146b1325d684efa152c2afc52eb30668394ee6f97f7ccf`

## Vor Aktivierung weiterhin erforderlich

1. Einen gemeinsamen Owner-Manager an Admission/Load, konkrete Rauminstanz,
   Mutationssperre und tatsächliches Unload anschließen. Heartbeat/Verbindungs-
   Überwachung, begrenzter Reconnect und Diagnose für ausgelastete Lockkapazität.
2. Rename, Archivierung, Restore, Repräsentationswechsel und Kompaktierung
   benötigen prozessübergreifendes Entziehen, Stilllegen und Freigeben. Nicht
   unter gehaltener SQL-Zeilensperre auf den Advisory-Lock warten. Lokale
   Connection-Zähler beweisen keine global leeren Räume.
3. Alle übrigen Yjs-Binärschreiber und den atomaren Kandidaten-/Operations-
   Commit an dieselben Fences binden. Erst dauerhaft speichern, dann senden;
   History und Graph-Abschluss idempotent nachholen. Legacy-Recovery bleibt
   konservativ; dieser Baustein beweist keine Unwirksamkeit alter Aufträge.
4. Aktivierung nur mit Session-Pooling/direktem PostgreSQL, nicht Transaction-
   Pooling; alle alten App-Prozesse vorher entleeren/ablösen. Alte Server
   ignorieren neue Felder und dürfen nicht gemischt weiterlaufen.
5. Zwei echte App-Prozesse, Crash vor/nach Commit und Publish, Peer-Reconnect,
   Offline-Daten und weitere erfolgreiche Aktionen; anschließend volle PG-S-/
   MR-Matrix zweimal. Produktionsimage/Containerneubau nur nach Freigabe.

Der Constructor hat bewusst noch keinen Runtime-Aufrufer. Browser-Regressionen
testen daher den unveränderten inaktiven Pfad, nicht aktivierte Raumzuständigkeit.
