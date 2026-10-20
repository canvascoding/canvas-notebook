# Export- und Migrationskorrekturen

Ausgangspunkt: [Abnahme vom 19.10.2026](../export-migration-2026-10-19/RESULTS.md), Commit `3f8ea8667` mit fünf fehlgeschlagenen E2E-Fällen und einem zusätzlichen Archivfehler.

Die Arbeitsschritte werden nacheinander implementiert, geprüft und committed.

- [x] Exporte: Organisationspfad, leere Verzeichnisse und aktuelle native Text-Checkpoints für Einzel- und Gesamtexport; Benutzerordner namens `cache` bewahren.
- [x] Fehlerbehandlung: sichtbare Downloadfehler und vollständig behandelte Output-Stream-Ablehnungen.
- [x] Dateimigration: sichere Zuordnung, tatsächliche Anwendung vor Serverstart, Rücknahme bei Fehlern und zugesagte Nacharbeiten.
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

## Validierung der Fehlerbehandlung

- Produktionsbuild, gezieltes TypeScript und ESLint bestanden.
- Der echte ZIP-Schreiber weist geänderte Quelldateien ab und behandelt dabei auch die Output-Promise vollständig; keine zusätzliche `unhandledRejection`.
- Vorbereitete Downloads sind an Benutzer, Sitzung und Workspace gebunden, einmalig nutzbar und nach fünf Minuten abgelaufen. Der Browser puffert das Archiv nicht im RAM.
- Vier Browserfälle bestanden: erfolgreiche Workspace-ZIPs, bestehende Zugriffsgrenzen, Nichtübertragbarkeit/Wiederverwendung vorbereiteter ZIPs und sichtbare Fehlermeldung bei abgewiesenem Download.
- Der Test-Login respektiert HTTP 429 mit einem begrenzten erneuten Versuch nach `Retry-After`; das Anmeldelimit wird nicht verändert.

## Dateimigration

- Der Upload wird anhand sicherer ZIP-Einträge, CRC, Größen, vollständigem Manifest und optionalen Datei-SHA256 geprüft. Die Freigabe bindet den unveränderten Upload an Ziel-Datenbank, DATA, Instanz und konfigurierte Secrets-Pfade.
- Das Mapping verwendet vollständige registrierte Workspace-Wurzeln. Persönliche Daten brauchen ein passendes Zielkonto; Vorschläge werden ausdrücklich bestätigt. Deaktivierte und gesperrte Ziel-Workspaces werden nicht automatisch freigegeben.
- Der tatsächliche Import läuft als eigener Prozess vor Auth, Scheduler und HTTP-Start. Ein dauerhaftes Journal, private Sicherungskopien und wiederholbare Rücknahme schützen unterbrochene Dateiaustausche. Bestehende native Dokumentzustände werden über den vorhandenen Lifecycle archiviert und bei Rücknahme wiederhergestellt.
- Dateiimporte schreiben die ausgewählten Dateien an die bestätigten Ziele. Gleichnamige Zieldateien werden ersetzt; andere vorhandene Dateien bleiben bestehen.
- Alte Sitzungen werden ungültig, aktive Automationen pausiert und OAuth-Zugänge über ihre zentralen Speicheradapter zurückgesetzt. API-Schlüssel bleiben erhalten. Zielinstanz und Lizenz werden nicht importiert.
- Unit-Prüfungen für gefährliche Pfade, Links, Checksummen, Owner-Zuordnung, abgebrochenen Austausch, wiederholte Rücknahme und OAuth/API-Key-Trennung bestanden.
- Ein zusätzlich erzwungener Fehler mit echten PostgreSQL-/Yjs-Dokumenten stellte ursprüngliche Datei, Dokumentidentität, aktiven Zustand und State-Version wieder her; Wiederholung derselben Rücknahme bestanden.

Die geerbte Testquelle enthält 660 registrierte Workspaces, davon 618 deaktiviert und 23 gesperrt. Das unveränderte erste Archiv wird korrekt blockiert. 632 vorhandene Dateiwurzeln dieser alten deaktivierten/gesperrten QA-Workspaces wurden außerhalb der aktiven Quell-Datenkopie privat gesichert; ihre Datenbankstatus bleiben unverändert. Die positive Dateiabnahme verwendet 19 vorhandene aktive Workspace-Wurzeln und 224 Dateien. Das ursprüngliche Archiv bleibt als Negativprüfung erhalten. Dieses Vorgehen ist eine Bereinigung der isolierten Testquelle, keine automatische Wiederherstellung gesperrter Produktdaten.

Die sechs Browserfälle auf der bereinigten Quelle bestanden (Gesamtexporte, Komponenten/Secrets, mehrteiliger Upload, exakte Wurzeln, gesperrte Altbestände und ungültige Archive/Zuordnungen). Zwei Ziel-Browserfälle bestanden nach dem letzten Produktionsbuild: tatsächliche Wiederherstellung nach Neustart samt zugesagten Nacharbeiten sowie vollständiger Export von 224 Dateien in andere bestätigte Workspace-Wurzeln mit anschließendem Öffnen eines nativen Markdown-Dokuments. Desktop- und 390-px-Ansichten wurden geprüft; kein horizontaler Überlauf. Gezieltes TypeScript und ESLint bestanden.
