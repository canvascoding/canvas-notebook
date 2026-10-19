# Dateiexport und Datenmigration: Testbericht vom 19.10.2026

Die Abnahme ist **nicht bestanden**. Einzelausgaben der geprüften Workspace-Typen funktionieren, der Gesamtexport und die tatsächliche Wiederherstellung haben jedoch reproduzierbare Lücken. Frisch gespeichertes natives Markdown kann im unmittelbar folgenden ZIP noch fehlen.

Getesteter Produktstand: `a9b89776ab92414e0917731717eeb83eb3bf8c80`, Worktree `99b4`, Branch `codex/export-migration-e2e`. Produktcode wurde für diese Prüfung nicht verändert.

## Aufbau und Grenzen

- Produktionsbuild mit `npm run build`, anschließend Chromium gegen den echten `server.js` auf `127.0.0.1:3001`.
- Die bestehende verwaltete PostgreSQL-Instanz wurde wiederverwendet. Zwei separate Snapshot-Datenbanken (`canvas_export_99b4_source` und `canvas_export_99b4_target`) und private DATA-Kopien isolieren Quellexport und Restore-Ziel. Es läuft jeweils nur eine dieser beiden Testanwendungen.
- Bestehende Container und der fremde Listener auf Port 3000 wurden weder ersetzt noch gestoppt. Es gab keinen Containerbuild. Die Development-Team-Lizenz wurde über die vorgesehenen lokalen Control-Plane-Dienste aktiviert und synchronisiert.
- Admin-Anmeldung mit den privaten Bootstrap-Zugangsdaten, Mitgliedsanmeldung mit dem bestehenden verwalteten Testkonto. Browser- und API-Rechte wurden separat geprüft.
- ZIP-Inhalte wurden anhand von Pfad, Dateigröße und SHA-256 kontrolliert. Der UI-Download allein gilt nicht als Erfolgsnachweis.
- Desktop: 1440 × 960; mobile Darstellung: 390 × 844. Chromium-Downloads, Screenshots und Traces wurden erfasst.
- Der Restore-Neustart wurde am Hostprozess ausgeführt. Docker-Neustart und Container-Restore wurden nicht ausgeführt. Ein vollständiger PostgreSQL-Transfer ist mit dem vorhandenen Funktionsumfang nicht möglich.

## E2E-Ergebnisse

Der abschließende Gesamtlauf am 19.10.2026 von 14:55 bis 15:00 Uhr (Europe/Berlin) umfasst **15 Tests: 10 bestanden, 5 fehlgeschlagen, 0 übersprungen**, Laufzeit 279 Sekunden. Er verwendet die korrigierte Markdown-Prüfung. Ein früherer Testmarker mit Unterstrichen war wegen Markdown-Escaping ungeeignet; daraus wurde kein Produktfehler abgeleitet. Die bereinigten Einzelstatus stehen in [results-summary.json](results-summary.json).

| Prüfung | Ergebnis | Nachweis |
| --- | --- | --- |
| Einzelner Workspace: persönlich, Organisation, Team, Projekt | Bestanden | Reale ZIP-Downloads stimmen mit den Quelldateien einschließlich Binärdaten, Unicode, Leerzeichen und leeren Ordnern überein; ausgewählter und aktiver Workspace unterscheiden sich. |
| Schneller Auswahlwechsel, neue Statistik, leerer Workspace, mobile Ansicht | Bestanden | Endauswahl, erneutes Laden und deaktivierte Leerexport-Aktion; keine horizontale Überbreite. |
| Eigentümer, Mitglied, Admin, fremder persönlicher Workspace, anonym | Bestanden | Berechtigte Einzeldownloads; erwartete 400/401/403/404/410 und sichtbarer Admin-Hinweis. |
| Fehlende Pfade, Traversal, Symlink, Größen-, Tiefen- und Eintragslimits | Bestanden | Echte HTTP-Anfragen lehnen die vorbereiteten Grenzfälle ab. |
| Aktuelle native Excalidraw-Szene | Bestanden | Neu angelegte Szene und angewandte Rechteckänderung erscheinen mit den aktuellen Elementen im ZIP. |
| Aktuelles natives Markdown | Fehler | Sichtbare Änderung und dauerhafter Serverinhalt sind bestätigt; unmittelbar exportiertes ZIP enthält noch alte Dateibytes. Siehe F3. |
| Standard, Full Admin ohne/mit persönlichen Workspaces | Fehler | Profile werden korrekt gesetzt; im vollständigen Export fehlen Organisationsdateien. Siehe F1. |
| Komponenten, Reconnect-Manifest und Secrets-Ausschluss | Bestanden | Studio-Assets/-Outputs, Uploads, Agent-Dateien und Skills enthalten; privater Sentinel und echter Public-Link-Token fehlen im gesamten Archiv. |
| Datenbankauswahl und PostgreSQL-Inspektion | Bestanden als Sperrprüfung | Manifest enthält `backupKind=none`, `artifactPath=null`; UI blockiert Restore. Keine erfolgreiche DB-Migration. |
| Mehrteiliger UI-Upload | Bestanden | ZIP mit mehr als 8 MiB, Teile 0 und 1, vollständiger SHA-256 identisch, Dry Run bereit. |
| Rückimport des tatsächlichen vollständigen Exports | Bestanden als Sperrprüfung | Unaufgelöstes Projekt-/Workspace-Mapping blockiert Restore; keine stille Zuordnung. |
| Beschädigtes ZIP, Version, Schema, unsichere Pfade, fehlende/kurze Chunks, fremde Zuordnungen | Bestanden | Inspektion oder Upload blockiert; falsche Bestätigung erzeugt keinen Pending-Restore. Normale Ratenlimits bleiben wirksam. |
| Leere Ordner im Migrationsarchiv | Fehler | Im Quelldateibaum vorhanden, im Gesamtexport nicht enthalten. Siehe F4. |
| Sichtbarer Fehler nach abgewiesenem ZIP-Download | Fehler | Backend liefert 400, Chromium meldet abgebrochenen Download, UI zeigt keinen Fehler. Siehe F5. |
| Bereiter Datei-Restore mit echtem Anwendungsneustart | Fehler | Pending-Auftrag wird geschrieben, aber Zielinhalt und zugesagte Folgezustände bleiben unverändert. Siehe F2. |

## Reproduzierte Fehler

### F1 – P1: Organisations-Workspaces fehlen im Gesamtexport

Der Full-Admin-Export mit ausdrücklich eingeschlossenen persönlichen Workspaces meldet Erfolg. Alle drei vorbereiteten Dateien des Organisations-Workspace fehlen. Derselbe Workspace ist beim Einzel-ZIP vollständig. Persönlicher Admin-Workspace, persönlicher Mitglieds-Workspace, Team und Projekt sind im geprüften Gesamtexport enthalten.

Die zentralen [Komponentenpfade](../../../../app/lib/migration/component-paths.ts#L20) erfassen `workspace` sowie `workspaces/team`, `workspaces/project` und `workspaces/personal`; `workspaces/organization` fehlt.

Nachweis: `all-workspace-comparison.json`, `all-workspaces.zip`, Screenshot `04-full-admin-export.png`.

### F2 – P1: Restore wird nach dem Neustart nicht angewandt

Ein synthetisches, gültiges Dateiarchiv mit einem unterstützten Legacy-Workspace-Pfad besteht den Dry Run. Das ist ein gezielter Restore-Ausführungstest; der tatsächlich erzeugte Mehr-Workspace-Export wird separat wegen unaufgelöster Projektzuordnung blockiert.

Die UI bestätigt `FULL_RESTORE`, die API liefert 200 und schreibt den Pending-Auftrag mit Modus 0600. Nach Stoppen und erneutem Starten des echten Zielservers gilt weiterhin:

- Zieldatei enthält `TARGET BEFORE RESTORE`, statt des archivierten Quelltexts.
- Pending-Auftrag bleibt liegen.
- Vorherige Sitzung bleibt gültig, OAuth-Testmarker bleibt erhalten und die eigens angelegte, erst 2099 fällige Automation bleibt aktiv.
- Zielinstanz und tatsächlich gespeicherte Lizenzidentität bleiben erhalten; diese beiden Erhaltungsprüfungen bestehen.

[restore-service.ts](../../../../app/lib/migration/restore-service.ts#L14) schreibt den Auftrag. Im untersuchten Repository gibt es keinen Ausführungspfad, der diesen Pending-Restore beim Start konsumiert. Der Host meldet `restartScheduled=false`; deshalb wurde für die Prüfung ausdrücklich manuell neu gestartet. Der Docker-spezifische Zweig beendet lediglich den Prozess und wurde nicht ausgeführt.

Nachweis: `restore-result.json`, `synthetic-restore-executor.zip`, Screenshot `07-restore-staged.png`, Ziel-Trace.

### F3 – P1: ZIP kann bestätigten neuen Markdown-Inhalt verlieren

Eine neue Markdown-Datei wird über die App-API angelegt und im sichtbaren nativen Editor geändert. Vor der Eingabe ist die Verbindung `live` und `remoteSynced=true`. Danach enthält `/api/files/read` den neuen eindeutigen Textmarker. Der unmittelbar folgende Workspace-Download enthält dennoch die alte, im fokussierten Nachweis sogar leere Dateiversion. ZIP und physische Datei haben denselben alten SHA-256.

Damit ist der aktuelle dauerhafte Dokumentzustand bestätigt. Es handelt sich nicht um eine bloß lokal sichtbare, noch unbestätigte Eingabe. Der Fehler betrifft das Zeitfenster zwischen Dokumentpersistenz und Dateiprojektion: Der [ZIP-Download](../../../../app/api/files/download/route.ts#L198) liest die physische Datei. Die getestete native Excalidraw-Materialisierung besteht separat.

Nachweis: `markdown-export-result.json`, zusätzlicher fokussierter Nachweis `markdown-export-confirmed.json`, `workspace-current-markdown.zip`, Screenshot `08-current-markdown-editor.png` und Trace. Ein früherer ungeeigneter Testmarker wurde ersetzt und der Test wiederholt.

### F4 – P2: Leere Verzeichnisse gehen im Migrationsarchiv verloren

Der Einzel-Workspace-Export bewahrt den leeren Testordner. Das Migrationsarchiv enthält ihn nicht. [collectFiles](../../../../app/lib/migration/export-service.ts#L134) traversiert Verzeichnisse, legt jedoch nur Dateieinträge an.

### F5 – P2: Abgewiesener Download bleibt im UI ohne Fehlermeldung

Ein Symlink im ausgewählten Workspace führt reproduzierbar zu HTTP 400 (`ARCHIVE_SYMBOLIC_LINK`). Der reale Browser-Download endet mit `canceled`; die Settings bleiben geöffnet und zeigen die Serverfehlermeldung nicht an. [handleDownload](../../../../app/components/settings/WorkspaceExportCard.tsx#L158) startet einen Anchor-Download, dessen HTTP-Fehler nicht in den UI-Zustand übernommen wird.

Nachweis: `download-error-result.json`, Screenshot `10-download-error-desktop.png` und Quell-Trace.

### F6 – P2: Unbehandelte Promise-Ablehnung bei währenddessen geänderter Datei

Der ergänzende fokussierte Test ruft den echten Archivplaner und ZIP-Schreiber auf. Dateinamenskollisionen und nach der Planung geänderte Dateien werden korrekt abgewiesen. Beim zweiten Fall bleibt jedoch eine zusätzliche `unhandledRejection` des Output-Streams übrig. Ein Prozessabsturz wurde damit nicht nachgewiesen.

[writeArchive](../../../../app/api/files/download/route.ts#L198) erzeugt `finished(output)` vor der Schleife; der Fehlerpfad behandelt dessen spätere Ablehnung nicht vollständig. Für eine auf macOS nicht physisch anlegbare Groß-/Kleinschreibungskollision wird allein das Verzeichnislisting simuliert; die echte Planung bleibt unverändert.

Nachweis: `archive-contract.log` und [workspace-download-archive-test.ts](../../../../scripts/workspace-download-archive-test.ts).

## Weitere Validierung

| Prüfung | Ergebnis |
| --- | --- |
| `npm run build` | Bestanden |
| `npm run test:migration:upload` | Bestanden |
| `npm run test:workspace:switcher-ui` | Bestanden |
| `npm run test:secrets:recovery` | Bestanden |
| TypeScript für die neuen Test-, Helper- und Config-Dateien | Bestanden |
| ESLint für diese Dateien | Bestanden |
| Globales TypeScript | Nicht grün: 61 vorhandene Diagnosen auch bei Ausschluss sämtlicher neuer Dateien. |
| Archivvertragstest | Zwei Schutzprüfungen bestanden; zusätzliche unbehandelte Promise-Ablehnung reproduziert, Exit 1. |

Der Datenbankexport erzeugt derzeit keinen PostgreSQL-Dump ([export-service.ts](../../../../app/lib/migration/export-service.ts#L491)). Ein vollständiger DB-Umzug, produktive Migration oder Remote-CI-Erfolg wird hier nicht behauptet. Die Abnahme bleibt wegen F1–F5 rot; F6 ist ein zusätzliches fokussiertes Ergebnis.

## Wiederholung und Evidenz

Die neue Suite ist ausdrücklich opt-in. Sie erwartet die privaten Snapshot-Umgebungen, ein gültiges Development-Team-Setup mit Admin-/Mitgliedskonto und einen Produktionsbuild dieses Checkouts. Die ENV-Dateien werden nicht ins Repository übernommen.

1. Verwalteten Stack gemäß `canvas-local-team-seat-dev` prüfen. Die bestehenden Dienste und belegten Ports inventarisieren.
2. Quelldaten in zwei separate private DATA-Verzeichnisse und Datenbanken kopieren. Bootstrap-Zugänge und DB-Verbindungen aus der privaten verwalteten Konfiguration übernehmen. Keine Produktionsziele verwenden.
3. `source.env` und `target.env` unter dem privaten Zustandsverzeichnis vorbereiten. Der Helper verweigert andere Datenbanknamen, DATA-Wurzeln und HTTP-Ports. Relative/absolute DATA-Overrides müssen auf die jeweilige Kopie zeigen. Admin und Mitglied müssen im Snapshot aktiviert sein; Lizenzaktivierung erfolgt über die vorgesehenen Dienste.
4. Mit der privaten Quellumgebung `npm run build` ausführen. Der Test selbst startet und stoppt nur seinen eigenen Prozess auf Port 3001.
5. Aus dem Repository ausführen:

```sh
EXPORT_MIGRATION_ACCEPTANCE=1 npx playwright test \
  --config tests/playwright/playwright.export-migration-acceptance.config.ts
npx tsx --conditions react-server scripts/workspace-download-archive-test.ts
```

Standardzustand: `~/.local/state/canvas-local-team-seat/export-migration-99b4`, alternativ `EXPORT_MIGRATION_STATE_DIR`. Die Datenbanknamen und Loopback-Adresse sind zusätzlich fest gegen unbeabsichtigte andere Ziele abgesichert. Quellexporte und synthetische Prüfarchive sind an ihren Dateinamen unterscheidbar.

ZIPs, komplette Playwright-Ergebnisse, Traces, Screenshots, ENV-Dateien und Laufzeitlogs bleiben privat. Sie können echte kopierte Inhalte und Sitzungsdaten enthalten und werden nicht committed. Im Repository liegen ausschließlich Tests und dieser bereinigte Bericht. Test-Sitzungen wurden nach Abschluss nur in den beiden Snapshot-Datenbanken widerrufen; der eigene Browser und Testprozess sind beendet und Port 3001 ist frei. Die vier verwalteten Dienste sind gesund; der vorhandene Listener auf Port 3000 ist erhalten. Die Snapshots und privaten Nachweise bleiben zur Fehleranalyse erhalten.
