# DA-05 – Zulassung neuer Collaboration-Identitäten

Stand: 27. September 2026. Teil von FVRC-1008; **keine Aktivierung des
Owner-/Admission-Bootstraps und keine Gesamtfreigabe.**

## Geschlossene Lücke

Eine Reservation erfasst nicht nur vorhandene Dokumente, sondern auch leere
Zielpfade und ganze Verzeichnisbereiche. Neue `collaboration_documents` und
neue `collaboration_yjs_states` müssen deshalb dieselbe persistente Zulassung
prüfen wie ein neuer Owner-Claim. Eine bloße Prüfung vor der Schreibtransaktion
würde ein Rennen zwischen Check und INSERT offenlassen.

- Die Metadaten-Neuanlage hält den Workspace-Admission-Transaktionsguard über
  Scope-Prüfung und INSERT bis zum Commit der aufrufenden Dateitransaktion.
  `INSERT ... DO NOTHING` darf einen konkurrierenden Treffer nicht umschreiben;
  der danach gelesene aktive Treffer muss zu Workspace, Pfad, Provider,
  Organisation und Lineage passen.
- Die Yjs-Erstinitialisierung verwendet eine kurze dedizierte Transaktion mit
  Statement-/Lock-Timeout, Admission-Guard, erneutem Lesen auf derselben Sitzung
  und Scope-Prüfung nur bei weiterhin fehlendem Zustand. Damit sieht eine spätere
  Reservation den neuen Zustand oder verhindert seine Neuanlage.
- Beide Eingaben werden vor dem ersten Await abgetrennt. Der gemeinsame
  Writer-Scope-Vertrag verlangt kanonische, segmentgenaue Pfade und gültige IDs;
  er ist selbst keine Schreibberechtigung.

## Bereits zugelassene Arbeit bleibt möglich

Ein bestehender Yjs-Zustand wird weiterhin ohne Admission-Sperre gelesen und
gegen aktive Identität, Workspace, Organisation, Pfad und Repräsentation
geprüft. Seine Bytes werden nicht aus einer Dateiprojektion neu erzeugt.

Bestehende Dokumentmetadaten werden ausschließlich per Update der exakt zuvor
gefundenen aktiven ID aktualisiert. Es gibt keinen INSERT-Fallback, falls diese
Identität zwischen Lesen und Schreiben archiviert oder verschoben wurde.
Eine vorhandene Lineage wird nicht durch eine andere ersetzt; eine fehlende
Lineage kann weiterhin durch die kanonische Zuordnung ergänzt werden.
Finale Checkpoints benötigen weder eine neue Zulassung noch einen erneuten
Admission-Guard. Owner-Store, Release und Operationsfortsetzung sind unverändert.

Nach abgeschlossenem Delete darf eine bewusst **neue** Dokument-ID am selben
Pfad weiterhin eine neue Datei repräsentieren, sofern keine Reservation besteht.
Die archivierte alte Yjs-ID wird dadurch nicht reaktiviert.

## Sperrordnung und ungewisse Commits

Der neue Metadatenpfad nimmt nach den vorhandenen Pfad-/Lineage-Sperren den
Admission-Guard, aber danach weder Yjs-Zustands- noch Room-Locks. Der neue
Yjs-Initialisierungspfad nimmt Admission → State, aber keine Pfad-/Metadaten-
oder Room-Locks. Reserve benötigt Admission → State und keinen Pfadlock;
Owner-Claims versuchen den Room-Lock unter Admission nur nichtblockierend.
Bestehende Metadaten-Updates nehmen überhaupt keinen Admission-Guard.

Der aktuelle Handoff terminalisiert **ohne** nachträglichen Admission-Guard.
Ein zukünftiges State → Admission würde diese Ordnung verletzen und muss vor
Einführung neu analysiert werden. Aus dem jetzigen isolierten Nachweis folgt
keine Erlaubnis, neue Sperrkanten in beliebige Writer einzubauen.

Die Yjs-Initialisierung verwendet die vorhandene Lifecycle-Transaktionsmechanik:
Bei ungewissem COMMIT muss zuerst das Verwerfen der alten Sitzung bestätigt sein.
Danach ist ausschließlich ein erneuter Read zulässig; ein aktiver, exakt passender
Zustand erfüllt den Ensure-Vertrag. Es wird nicht behauptet, dass die Initialbytes
dieses Aufrufers gewonnen haben: Auch im normalen Konkurrenzfall ist der bereits
gespeicherte kanonische Zustand maßgeblich. Fehlender Zustand oder Scope-Drift
bleiben Fehler; es gibt kein automatisches Reinsert oder Reaktivieren.

## Verifikation

- `test:collaboration:admission`: grün, einschließlich neun Scope-Vertragsgruppen
  mit zwei neuen Prüfungen für die unveränderliche Writer-Identität.
- `test:collaboration:initialization-admission:postgres`: 13 abgegrenzte
  Prüfgruppen auf dem echten verwalteten PostgreSQL 18, zweimal Exit 0.
  Getrennte Backends und `pg_blocking_pids` belegen beide Sperrreihenfolgen;
  Cancellation belegt anschließende Weiterarbeit. Weitere Fälle: bestehende
  Reads/Checkpoints, literale `%`/`_`-Pfade und Subtrees, archivierte Identitäten,
  Organisations-/Lineage-Drift, Archive-/Insert-Rennen sowie abgelehnte,
  verlorene und nach fehlgeschlagenem Discard nicht rekonstruierte Commits.
  Der Harness nutzt ein erzeugtes isoliertes Schema, reale Admission-/Repository-
  und Transaktionsmechanik; die Markdown-Konvertierung wird für diese
  SQL-Vertragsprüfung durch einen Plain-Text-Y.Doc ersetzt. Das ist kein
  Mehrprozess-App-/Crash-Nachweis.
- Bestehende Admission-Kompaktierung: alle 35 abgegrenzten PostgreSQL-
  Prüfgruppen erneut grün. Lifecycle-, Repository-, Policy-, Target-Lifecycle-
  und Notebook-Mutations-Regressionen ebenfalls grün.
- Vollständiger TypeScript-Check, gezieltes ESLint und `npm run build`: Exit 0.
- Gewöhnlicher Tool-/Browserpfad B/C, jeweils vom selben A ausgehend:
  Team 1/1 (23,5 s), Personal 1/1 (15,7 s). C wird genau einmal angenommen;
  B bleibt offen mit konkretem Konflikt, ohne Timeline-Fehler, ohne Annahme-
  Freigabe und ohne zweite Inhaltsrevision. Beide Screenshots visuell geprüft.
- Zehn gewöhnliche `edit_file`-Roots im Team: 1/1 (54,2 s). Drei Änderungen
  einzeln in nicht sequenzieller Reihenfolge, danach genau die übrigen sieben
  gemeinsam; exakter Endtext und genau vier neue Inhaltsrevisionen. Original-
  Retry bleibt unverändert/idempotent, abweichender Retry wird abgelehnt.
  Screenshot visuell geprüft. Die drei Browserfälle liefen seriell mit
  einem Worker und mindestens 55 Sekunden Abstand nach bestätigtem Abschluss.

Lokale Protokolle: `/tmp/fvrc1008-initialization-admission-postgres.log`,
`/tmp/fvrc1008-initialization-admission-postgres-repeat.log`,
`/tmp/fvrc1008-initialization-compaction-regression.log`,
`/tmp/fvrc1008-initialization-types-final.log`,
`/tmp/fvrc1008-initialization-lint-final.log` und
`/tmp/fvrc1008-initialization-build-final.log`.

Browser: aktueller Worktree im Host-Dev auf `127.0.0.1:3000`, verwalteter
PostgreSQL-/Control-Plane-Stack. Keine Containeränderung; der ältere Notebook-
Container auf `3100` ist **nicht** dieser Code-Nachweis. Echte Tool-Facade,
Review-UI und Datei-/Versionsprüfungen, aber deterministische Tool-Aufrufe
statt eines externen Live-LLM. Ein erster Lauf scheiterte vor Testausführung
an Health-/Auth-404 des Dev-Servers. Nach geordnetem Neustart mit explizitem
`NODE_ENV=development` war Health 200 und der neue Lauf grün. Der fehlgeschlagene
Report bleibt erhalten; er wird nicht als bestandener Test gezählt.

Reports: `/tmp/fvrc1008-initialization-retry-team-conflict-report/index.html`,
`/tmp/fvrc1008-initialization-personal-conflict-report/index.html` und
`/tmp/fvrc1008-initialization-team-batch-report/index.html`.
Read-only Prüfung: keine produktiven Owner-Epochen oder Admission-Requests
angelegt (`0`/`0`), keine Schema-Reste der beiden PG-Harnesses. Vier bereits
in älteren Dev-Logs vorhandene verwaiste Projection-Fixtures melden beim
Start weiterhin `COLLABORATION_CHECKPOINT_FAILED`; deren Daten wurden nicht
umgeschrieben oder als Bestandteil dieses Schritts bereinigt.

GitNexus: Index erneuert, staged Scope auf die zehn erwarteten Dateien geprüft.
Die vorausgehende Symbolanalyse bewertet die zentralen Initialisierungspfade
als kritisch (28 beziehungsweise 74 indirekt betroffene Symbole). Der
Gesamtvergleich mit `main` betrifft weiterhin 308 Dateien/30 Ausführungspfade
und ist ebenfalls kritisch; die fokussierten Nachweise sind keine Freigabe
des Gesamtbranches. Kein Push, Merge oder Containerneubau.

## Verbleibende Aktivierungsgrenzen

- Neue Agentenoperationen benötigen noch denselben atomaren Admission-Check,
  ohne bereits zugelassene Operationen und deren idempotente Retries zu sperren.
  Die Legacy-Create-Phase ist heute statementweise; Graph-Erstellung besitzt
  bereits eine Transaktion und braucht die korrekte äußere Guard-Reihenfolge.
- Die Excalidraw-Szene und ihre separaten Agentenoperationen sind nicht durch
  den neuen Yjs-Initialisierungsschutz abgedeckt. Der gemeinsame Dokument-
  Metadatenpfad allein beweist keine providerübergreifende Aktivierungsreife.
- Dateisystem-Neuanlage/Move/Restore, Repräsentationswechsel und übrige
  Lifecycle-Domainpfade bleiben im [Gesamtplan](distributed-admission-plan.md).
- Kein Fleet-Gate, kein regulärer Owner-Bootstrap, keine vollständige
  Mehrprozess-/Crash-/Offline-Matrix und kein P12-Abschluss durch diesen Schritt.
