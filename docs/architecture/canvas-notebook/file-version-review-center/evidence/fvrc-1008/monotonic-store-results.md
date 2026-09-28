# Monotone Yjs-Speicherung und Live-Abgleich

Stand: 27. September 2026. Ausgangscommit `2d683b6f6`, Worktree
`review-conflict-resolution`, Branch `codex/review-conflict-resolution-20260925`.
Teil von Schritt 2 des [Durable-Publication-Plans](durable-publication-plan.md).
Kein vollständiger FVRC-1008-/PG-S19-Abschluss und keine Produktionsaktivierung.

## Implementierung

`persistCollaborationYDoc` kopiert die vollständigen Yjs-Bytes und die erwartete
Identität vor dem ersten `await`. Eine kurze PostgreSQL-Transaktion sperrt die
Dokumentzeile, prüft Lifecycle, Workspace, Organisation, Pfad, Repräsentation
und Schema und vergleicht beide kausalen Zustände einschließlich Delete Sets:

- Gleich oder älter: gespeicherte Bytes und Sequenz bleiben unverändert.
- Neuer vollständiger Nachfolger: genau eine neue Sequenz.
- Unabhängige Zweige: kanonische Yjs-Vereinigung, genau eine neue Sequenz.

Ein State Vector allein genügt nicht: Reine Löschungen verändern ihn nicht.
Unvollständige, beschädigte oder nicht kanonische Updates werden nicht
gespeichert. Die neue gemeinsame Mechanik liegt nach dem `code-structure`-Skill
in einem reinen Helper; Datenbanktransaktion, Identität und Review-Regeln
bleiben bei ihren bisherigen Verantwortlichen. Es werden keine noch nicht
angenommenen Agentenvorschläge durch diesen Store automatisch angewendet.

Ein unklarer Commit wird nicht als Erfolg bestätigt. Die Verbindung wird
verworfen, auch wenn ein anschließender Rollback erfolgreich antwortet.
Ein Retry erkennt einen tatsächlich bereits gespeicherten Stand als No-op.
Auch ein verlorenes BEGIN-Ergebnis wird zurückgerollt. No-op-Speicherungen
löschen keinen strukturellen Degraded-Status und beanspruchen keine neue
History-Autorenschaft. Der strikte Agentenabschluss behält seinen eigenen
History-Retry. Ein tatsächlich zusammengeführter Stand wird als System-
Checkpoint statt vollständig als Werk des letzten Bearbeiters erfasst.

Wenn PostgreSQL dem Raum voraus ist, plant der Server einen nachgelagerten
Abgleich. Er wartet **nicht** innerhalb von `onStoreDocument` auf die Raumsperre
(Direct-Disconnect wartet dort bereits auf `saveMutex`). Der Abgleich lädt
unter der Raumsperre den aktuellen dauerhaften Stand erneut, prüft die konkrete
Rauminstanz und ihre Identität, ergänzt ihn idempotent und bestätigt erst
danach die Dauerhaftigkeit. Lokale, noch nicht gespeicherte Änderungen bleiben
erhalten. Bereits dauerhafte Ergänzungen lösen keinen weiteren Store aus.

## Automatisierte Nachweise

- Elf reine Merge-Fälle: Gleichheit, Nachfolger, Vorgänger, unabhängige
  Einfügungen, Löschungen bei gleichem Vector, unterschiedliche GC-Darstellung,
  fehlende Voraussetzungen, defekte/erweiterte/zu große Updates und getrennte
  Eingabe-/Ergebnispuffer einschließlich Node-Buffer (dessen `slice()` sonst
  keine Kopie erzeugt). Die Annahme unveränderlicher Yjs-Struct-IDs ist explizit
  dokumentiert; dies ist keine Authentizitätsprüfung absichtlich gefälschter IDs.
- Real migriertes PGlite-Schema: produktiver Store mit Identity-/Lifecycle-
  Fences, unveränderlichem Capture vor Verbindungswartezeit, erhaltenem
  Degraded-Status, Rollback, verlorenem BEGIN-/COMMIT-Ergebnis, Verbindungs-
  Discard und wiederholbarer Speicherung. PGlite beweist keine Parallelität.
- Echte PostgreSQL-18-Verbindungen: `pg_blocking_pids` und `pg_stat_activity`
  belegen, dass der zweite Backend-Prozess auf die Zeilensperre des ersten
  wartet. Beide unabhängigen Zweige und beide reinen Löschungen bleiben erhalten.
  Verzögerter Vorgänger nach neuerem Commit bleibt No-op; umgekehrte Reihenfolge
  liefert denselben Endinhalt mit den erwarteten Sequenzen. Diese Ordnungsfälle
  testen den Store, **nicht** bereits den atomaren Kandidaten-Orchestrator.
- Zehn reale Hocuspocus-Receiver-Szenarien einschließlich der bestehenden
  Writer-Sperren: wartender Abgleich, Erhalt einer erst nach Speicherbeginn
  angelegten lokalen Änderung, verspätete Durability-Mitteilung, keine neue
  Sequenz, ersetzter Raum, keine falsche No-op-Autorenschaft und kein
  Store-/Direct-Disconnect-Deadlock.
- Vollständige Lifecycle-, Projektions- und Offline-Suites bestehen. Ein
  bestehender Client-Test erwartete fälschlich `ready=false`/`server_received`
  vor Remote-Sync trotz vollständig geladenem lokalen Cache. Er prüft jetzt
  `ready=true`, `remoteSynced=false`, `local_pending` und weiterhin keinen
  dauerhaften Servernachweis. Keine Client-Produktlogik dafür geändert.

Die PostgreSQL-Prüfung erzeugt ausschließlich ein eigenes zufälliges Schema
mit einer strukturgleichen Tabelle, nutzt einen darauf begrenzten `search_path`
und entfernt es nach dem Leeren des eigenen Verbindungspools. Keine bestehenden
Fixture-Zeilen, Container, Lizenzen oder Env-Dateien werden geändert.

Logs unter `/tmp/fvrc1008-store-fence-`:
`persistence-final.log`, `postgres-final.log`, `lifecycle-final.log`,
`projection-final.log`, `offline.log`, `durability-ack.log`.

## Browserprüfung und Abschlusschecks

Die bestehenden produktnahen Playwright-Fälle laufen auf dem frisch gestarteten
Host-Dev-Server `127.0.0.1:3000` aus diesem Worktree mit dem verwalteten PostgreSQL-
Stack. Das Containerimage auf 3100 ist unverändert und enthält diesen Patch
noch nicht. Ein Lauf/ein Worker gleichzeitig, mindestens 55 Sekunden Abstand
nach bestätigtem Abschluss. Eigene UUID-Dateien und Agentensitzungen werden
über normale authentifizierte APIs angelegt und wieder entfernt. Die
gewöhnlichen Agentenwerkzeuge laufen tatsächlich; kein Modellaufruf ist nötig.

| Browserfall auf finalem Quellstand | Ergebnis | Report unter `/tmp/` |
|---|---|---|
| Personal: B/C überlappen, C annehmen | bestanden, 24,3 s | `fvrc1008-store-fence-personal-conflict-final-report/index.html` |
| Team: B/C überlappen, C annehmen | bestanden, 15,6 s | `fvrc1008-store-fence-team-conflict-final-report/index.html` |
| Personal: zehn Roots, drei einzeln + sieben im Batch | bestanden, 55,8 s | `fvrc1008-store-fence-personal-batch-final-report/index.html` |
| Team: zehn Roots, drei einzeln + sieben im Batch | bestanden, 54,0 s | `fvrc1008-store-fence-team-batch-final-report/index.html` |

Bei B/C wird genau die angenommene Änderung wirksam; B bleibt mit konkretem
Konflikt offen statt Timeline-Stale. Dies belegt die bestehende Konfliktanzeige,
keinen schon fertigen manuellen Konflikteditor. Die Sammelannahme prüft exakten
Endtext, die betroffenen Proposal-IDs, vier erfolgreiche Aktionsbelege und genau
vier neue Historyrevisionen (1 → 5). Original-Retries, auch bei geschlossenem
Tool-Graph-Gate, bleiben wirkungslos; geänderte Retry-Parameter werden abgewiesen.
Die vier finalen Screenshots wurden visuell geprüft: konkrete Konfliktanzeige
bei B/C, keine offenen Reviews und fünf Historyrevisionen nach Sammelannahme.

TypeScript, fokussiertes ESLint und `npm run build` bestehen. Der finale Build
erzeugt 353 Seiten; das Lizenzgate prüft 1967 Komponenten ohne Release-Blocker.
Die bekannten Turbopack-Tracing-Warnungen bleiben unverändert. Zwischenläufe
deckten Typfehler in neuen Test-Hilfen auf (Closure-Narrowing und nicht öffentlich
typisiertes `PoolClient.processID`); sie wurden korrigiert, letzteres durch die
echte SQL-Abfrage `pg_backend_pid()`. Der abschließende Build ist grün.

Eine zusätzliche Buffer-Prüfung fand, dass Node-`Buffer.slice()` seine Quelle
teilt. Der Helper kopiert jetzt ausdrücklich per `new Uint8Array(source)`;
eigener Regressionstest, erneuter Build und die obigen finalen Browserläufe
beziehen diese Korrektur ein. Ein früherer grüner Personal-Lauf ohne diese
Korrektur wird nicht als finaler Quellstand gezählt.

SHA-256 der getesteten Produktdateien:

- `persistence.ts`: `f1689cd037d5daf264fe5232491087db487c0c1a0fa3d5e3cd019f11120c194e`
- `persistence-merge.ts`: `f47765ad257fc7429c6641faf964d854200dacc9b426f314786b3e06353383a6`
- `collaboration-server.ts`: `6fac77699f6df72942ff80d1ebc0c521b430b09b49f12ec491348ff44a3e2cda`

GitNexus stuft den zentralen Decoder-Aufrufpfad als hohes Risiko ein (ein
direkter Aufrufer, zwölf betroffene Symbole inklusive Store/Server/Tests).
Der gestagte Einzelpatch umfasst 14 Dateien/94 Symbole ohne betroffene indexierte
Prozesse, Risiko niedrig. Der gesamte Branch gegen lokales `main` umfasst
233 Dateien/1894 Symbole/30 Prozesse, Risiko kritisch. Beides wurde getrennt
kommuniziert; keine vollständige Branch-Abnahme, kein Push oder Merge.

Alle vier unveränderten Stack-Container sind gesund; PostgreSQL 18.4/pgvector
0.8.3 und Host-Dev-Health bestätigen den vorgesehenen Stack. Keine Dependency-,
Lockfile-, Secret- oder Containeränderung. Logs: `build-final.log`,
`typecheck-final.log`, `lint-final.log`, `stack-final.log` und `health-final.json`
mit demselben `/tmp/fvrc1008-store-fence-`-Präfix.

## Größenlimit und Rollout-Voraussetzung

Der neue Decoder begrenzt jeden vollständigen Snapshot auf 64 MiB; das ist
ein **neues** Ressourcenlimit, kein schon garantierter Bestandsdatenvertrag.
Zwei begrenzte Eingaben dürfen vor Kanonisierung vorübergehend bis 128 MiB
Binärdaten erzeugen; das gespeicherte Ergebnis muss wieder innerhalb 64 MiB
liegen. Yjs-Tombstones zählen mit, nicht nur sichtbarer Markdown-Text.

Vor einer Aktivierung müssen Bestandsdaten ausschließlich lesend geprüft werden:

```sql
SELECT document_id, octet_length(yjs_state) AS binary_bytes
FROM collaboration_yjs_states
WHERE octet_length(yjs_state) >= 48 * 1024 * 1024
ORDER BY binary_bytes DESC;
```

Bei einem Snapshot über 64 MiB nicht aktivieren: Zuerst die vorhandene sichere
Kompaktierung bei leerem Raum prüfen oder das Limit explizit neu bewerten.
Headroom muss auch nach der Einführung überwacht werden. Keine automatische
Kompaktierung oder Löschung als Bestandteil dieses Patches.

Lokaler Read-only-Preflight vor den Browserläufen: 869 Snapshot-Zeilen,
größter Stand 463.125 Bytes, keine Warn-/Überlimit-Zeilen und kein verbliebenes
Testschema. Das ist **kein** Nachweis für Produktionsdaten.

## Verbleibende Grenzen

Die Live-Veröffentlichung eines Agentenkandidaten geschieht weiterhin vor
seinem endgültigen Datenbankcommit. Der neue Store verhindert Rückschritte,
schließt aber diese Crashlücke nicht. Mehrprozess-Owner mit Fencing, atomarer
Kandidaten-/Operationsbeleg vor Veröffentlichung, persistierte History-
Provenienz und die dazugehörige Crash-/Reconnect-Matrix bleiben offen.
Keine Freigabe ungewisser Altaufträge nur aufgrund gleichen Texts.
FVRC-1008 bleibt `in_progress`; P12 bleibt separat offen.
