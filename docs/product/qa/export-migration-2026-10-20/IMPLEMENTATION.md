# Export- und Migrationskorrekturen

Ausgangspunkt: [Abnahme vom 19.10.2026](../export-migration-2026-10-19/RESULTS.md), Commit `3f8ea8667` mit fünf fehlgeschlagenen E2E-Fällen und einem zusätzlichen Archivfehler.

Die Arbeitsschritte werden nacheinander implementiert, geprüft und committed.

- [x] Exporte: Organisationspfad, leere Verzeichnisse und aktuelle native Text-Checkpoints für Einzel- und Gesamtexport; Benutzerordner namens `cache` bewahren.
- [ ] Fehlerbehandlung: sichtbare Downloadfehler und vollständig behandelte Output-Stream-Ablehnungen.
- [ ] Dateimigration: sichere Zuordnung, tatsächliche Anwendung vor Serverstart, Rücknahme bei Fehlern und zugesagte Nacharbeiten.
- [ ] PostgreSQL: echter Datenbanktransfer unter Erhalt der Zielinstanz und Lizenz.
- [ ] Gesamtabnahme: tatsächlicher Export auf isoliertem Ziel, Neustart und Prüfung über API und Browser.

## Validierung des Exports

- Produktionsbuild bestanden.
- Gezieltes TypeScript und ESLint bestanden.
- `migration-export-fidelity-test.ts`: Organisationsdateien, leere Ordner, Ordner namens `cache` und ausdrückliche persönliche Auswahl bestanden.
- `portable-text-checkpoints-test.ts`: Bereichsgrenzen, Wiederholung bei ersetzt gespeicherten Zuständen, Pagination, Verbindungsfreigabe und Blockierung bei Checkpoint-Fehlern bestanden.
- Bestehende Upload- und Secrets-Recovery-Tests bestanden.
- Vier gezielte Browserfälle bestanden: Einzel-ZIPs aller vier Workspace-Typen, frisch im Editor gespeichertes Markdown, Standard-/Full-Admin-Gesamtexporte und leere Verzeichnisse im Migrationsarchiv.
- Zusätzliche Browserprüfung der unveränderten Eigentümer-, Mitglieds-, Admin- und anonymen Berechtigungsgrenzen bestanden.

Die übernommene Quelldatenkopie enthielt zwei bereits quarantänierte alte Dokumente sowie weitere verwaiste native Metadaten außerhalb der neuen Testfälle. Der neue Export blockierte diese Quellen korrekt. Die beschädigten Dateien wurden privat gesichert und ihre Dokumente über die bestehende Lifecycle-Archivierung aus der aktiven Testkopie genommen. Anschließend wurden 115 weitere geerbte native Dokumenteinträge außerhalb `export-99b4/` über dieselbe Archivierung aus der aktiven Testmenge genommen. Die expliziten nativen Testdokumente bleiben aktiv. Die positive Abnahme verwendet damit gültige Testquellen; ein Export mit quarantänierter Quelle bleibt ein separat nachgewiesener Negativfall.

Private Testdaten, ZIPs und Traces liegen weiterhin unter `~/.local/state/canvas-local-team-seat/export-migration-99b4`. Der Stand der ursprünglichen Nachweise wurde vor den Folgetests privat gesichert.
