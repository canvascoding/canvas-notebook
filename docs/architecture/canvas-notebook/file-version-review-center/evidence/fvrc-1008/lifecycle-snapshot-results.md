# Lifecycle snapshot fence — bounded hardening

## Behobener Fehler

Kompaktierung und Repräsentationswechsel bereiteten ihren neuen Yjs-Zustand aus
einem vor der SQL-Transaktion gelesenen Snapshot vor. Ein konkurrierender Store
konnte inzwischen neuere Bytes in derselben Lifecycle-Generation speichern.
Die bisherigen UPDATE-Bedingungen erkannten diesen Fall nicht zuverlässig:
Die Umwandlung konnte anschließend den neueren Stand überschreiben.

Beide Pfade verwenden jetzt dieselbe Prüfung in `persistence.ts`:

1. Den aktuellen Datensatz mit `SELECT ... FOR UPDATE` sperren.
2. Alle gemappten Metadaten sowie **Yjs-Bytes und State-Vector** mit dem
   vorbereiteten Eingabestand vergleichen. Nur der Vector reicht bei reinen
   Löschungen nicht aus.
3. Bei Abweichungen mit `state_changed` abbrechen. Keine Backup-Zeile und kein
   externer Checkpoint-Callback werden vorher ausgeführt. Die im Formatwechsel
   bereits transaktional markierte Operations-Expiration wird zurückgerollt.
4. Backup und nächste Sequenz vom geprüften, gesperrten Vorgänger ableiten;
   die Zeilensperre bis COMMIT/ROLLBACK halten. Der UPDATE prüft die Sequenz
   zusätzlich explizit.

Die vorhandene Lock-Reihenfolge **Operation → Zustand** bleibt erhalten.
GitNexus meldet LOW für Kompaktierung (ein direkter Aufrufer) und HIGH für den
gemeinsamen Formatwechsel (zwei direkte Aufrufer, darunter die Session-Erstellung).

Ein Datensatz mit Owner-Epoche ungleich null oder nicht leeren Owner-Feldern
wird mit `room_active` abgelehnt. Das gilt auch für bereits freigegebene
Owner-Token: Sie beweisen kein erfolgreiches Speichern aller Live-Änderungen.
Dies ist ausdrücklich eine vorläufige sichere Sperre bis zum vollständigen
Lifecycle-Handoff, keine fertige Mehrprozess-Drain-Implementierung.

## Nachweise

- Vollständige `test:collaboration:lifecycle` und `test:collaboration:projection`.
- Echte PostgreSQL-Projection-Lifecycle-Integration: sechs Szenarien mit
  Dateisystem, Rename/Trash/Restore und normalem Formatwechsel bestanden.
- Vollständige `test:collaboration:operations`, einschließlich Personal-
  Workspace-Integration, in einer frisch migrierten UUID-Testdatenbank bestanden.
- TypeScript-Projektcheck, fokussiertes ESLint und `npm run build` bestanden.
- Browserregressionen „gewöhnliche, überlappende B/C-Vorschläge; C zuerst
  annehmen“ auf 3000: Personal **24,1 s**, Team **15,9 s**, jeweils bestanden.
  B bleibt `open`/`conflicted`, Annahme ist gesperrt, C bleibt im exakten
  Dokumentinhalt erhalten, genau eine neue Inhaltsrevision. Keine Timeline-
  Fehlermeldung und kein irreführendes Null-Diff. Beide Screenshots angesehen.
- Batch „zehn normale `edit_file`-Vorschläge, drei einzeln und sieben gemeinsam“:
  Personal **54,1 s**, Team **53,7 s**, bestanden; exakter Endtext, keine offenen
  Reviews und vier neue Inhaltsrevisionen. Beide Screenshots angesehen.
- Neue deterministische PostgreSQL-Konkurrenzsuite in endgültiger Fassung
  zweimal bestanden (Subagent und unabhängiger Hauptagent-Lauf, keine Skips).
  Sieben Prüfgruppen einschließlich einer Matrix mit **17 einzeln geänderten
  Feldern**, Details unten.

Die Integrationstests verwendeten ausschließlich neue
`canvas_editor_test_<UUID>`-Datenbanken und entfernten diese anschließend.
Der verwaltete Stack blieb unverändert: vier gesunde Container, PostgreSQL
18.4/pgvector 0.8.3 auf 55433. Aktueller Host-Dev-Code läuft auf **3000**, das
ältere Notebook-Image weiterhin auf **3100**. Kein Container-Rebuild, kein
Fixture-Reset und kein Push.

Logs dieser Runde: `/tmp/fvrc1008-lifecycle-snapshot-` mit Suffixen
`unit.log`, `projection-unit.log`, `projection-pg.log`, `operations.log`,
`types.log`, `lint.log`, `build.log`, `stack.log` und `dev.log`.
Abschließende vollständige Checks: `types-final.log`, `lint-final.log`.
Browserberichte: `personal-report/index.html`, `team-report/index.html`,
`personal-batch-report/index.html`, `team-batch-report/index.html`;
entsprechende `*-browser.log` unter demselben
Präfix. Die Läufe waren seriell mit einem Worker und mindestens 55 Sekunden
Abstand. Sie belegen weiterhin den ungefencten Default, nicht den noch
deaktivierten Mehrprozess-Ownership-Cutover.

### Isolierte PostgreSQL-Konkurrenzsuite

`scripts/collaboration-lifecycle-snapshot-concurrency-test.ts` führt den echten
Persistenz-, Merge- und Owner-Fence-Quellcode gegen getrennte PG18-Verbindungen
aus. Kontrollierte Gates vor BEGIN bzw. nach `FOR UPDATE` erzwingen die Rennen;
`pg_blocking_pids` belegt die tatsächlich wartende zweite Verbindung.

- Ein neuerer regulärer Store mit reiner Löschung bleibt erhalten, obwohl
  der State-Vector unverändert ist.
- Separater Byte-only-Fall: identische Metadaten und identischer Vector,
  aber anderes Delete-Set. Damit ist die Prüfung der Yjs-Bytes selbst belegt.
- Checkpoint-/Health-Änderung verhindert Normalisierung; Operationsstatus
  und CAS bleiben nach Rollback unverändert, `write`/`restore`/`finalize` je null.
- Einzelne Änderungen an Scope, Pfad, Repräsentation, Generation, Schema,
  Sequenzen, Zeitstempeln, Hashes, Encoding, Health, Status und Vector brechen ab.
- Aktive und freigegebene Owner-Epochen sowie widersprüchliche Owner-Felder
  bei Epoche null werden ohne committete Expiration oder Backup abgelehnt.
- Beide unveränderten Happy Paths erzeugen genau ein Backup mit den exakten
  Vorgängerbytes, Vector, Generation und Sequenz; neue Sequenz jeweils +1.
- Umgekehrte Reihenfolge: Die Umwandlung hält den Row-Lock; der Store wartet
  nachweislich und wird nach dem Lifecycle-Wechsel als veraltet abgewiesen.

Lokale Raum-/Workspace-Locks und Markdown-Codecs sind für diesen eng begrenzten
Konkurrenztest injiziert. Er beweist weder echte Rich-Serialisierung noch
Mehrprozess-Raum-Drain. Die normale Rich-Migration wird separat durch die
oben genannte vollständige Projection-Lifecycle-Integration abgedeckt.

Reproduktion mit dem privaten verwalteten Profil (keine Secrets in der Ausgabe):

```sh
NODE_ENV=test node \
  --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env \
  --import tsx --conditions react-server \
  scripts/collaboration-lifecycle-snapshot-concurrency-test.ts
```

Alternativ mit bereits geladenem Profil:
`npm run test:collaboration:lifecycle-snapshot:postgres`.
Der Harness verweigert andere Datenbankziele und arbeitet ausschließlich in
eigenen `canvas_lifecycle_snapshot_test_<UUID>`-Schemas.
Logs: `concurrency.log` und `concurrency-repeat.log` unter dem obigen Präfix.
Der unabhängige Cleanup-Check (`cleanup.log`) bestätigt danach **0** verbliebene
Testschemas, **0** der beiden temporären Integrationstest-Datenbanken und
weiterhin **0** aktivierte Owner-Epochen im App-Datenbestand.

## Weiterhin offen — kein Crash-/Rollout-Gate erfüllt

- Prozessübergreifendes Sperren neuer Raumöffnungen, Drain mit dauerhaftem
  Speicherbeleg und Lifecycle-Entzug vor Rename/Delete/Restore/Formatwechsel.
  Ein leerer lokaler Raum oder verschwundener Advisory-Lock genügt nicht.
- Operationsanlage ist noch nicht durch denselben Admission-Fence geschützt.
  Neue Operationen können zwischen Pending-Abfrage/Expiration und State-Lock
  entstehen. Dieser Patch verhindert veraltete Byte-Überschreibungen, nicht
  sämtliche veralteten Operationsmetadaten.
- Bestehende Commit-/Rollback-Ungewissheit der Lifecycle-Transaktionen:
  Insbesondere darf eine verlorene Bestätigung eines tatsächlich erfolgreichen
  Normalisierungs-COMMIT künftig keine Rückschreibung der alten Datei auslösen.
  Dafür sind ein dauerhafter Ergebnisbeleg und gezielte Recovery-/Fault-Tests
  erforderlich; dieser Patch löst das nicht.
  **Nachtrag:** Diese begrenzte Lücke ist im Folgepatch mit Commit-Beleg und
  Post-Commit-Projektion behandelt; Nachweise und verbleibende Crash-Grenzen
  stehen in [lifecycle-commit-recovery-results.md](lifecycle-commit-recovery-results.md).
- Atomarer Kandidatencommit **vor** Live-Publish, vollständige PG-/MR-Abnahme
  und manueller Konflikteditor P12 bleiben offen. Owner-Aktivierung im normalen
  Bootstrap bleibt aus; gemischter Betrieb mit alten Servern ist nicht freigegeben.

FVRC-1008 bleibt `in_progress`.
