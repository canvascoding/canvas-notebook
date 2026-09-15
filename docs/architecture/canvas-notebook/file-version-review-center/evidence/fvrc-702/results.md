# FVRC-702 Rollout evidence

Datum: 15. September 2026

## Umfang und Datenschutz

Der Nachweis lief gegen den einzelnen verwalteten, nur an Loopback gebundenen lokalen Team-Seat-Stack mit PostgreSQL. Jeder Moduswechsel verwendete zuerst einen erfolgreichen Host-Build und danach einen frischen Build/Recreate des Notebook-Containers. Die unten gespeicherten Ergebnisse enthalten ausschließlich aggregierte Zaehler, Laufzeiten und boolesche Gates, aber keine Dokumentinhalte, Pfade, Objekt-IDs, Nutzerkennungen oder Secrets.

## Shadow-Capture-Bericht

Der echte Shadow-Canary importierte ein Markdown-Dokument ueber den regulaeren Upload-Pfad, initialisierte den autoritativen Collaboration-Stand und pruefte einen abschliessenden Dokumentzugriff. Das erzeugte NDJSON-Ereignis wurde unmittelbar durch `scripts/file-version-center-shadow-report.ts` gegen die echte Datenbank ausgewertet.

| Messwert | Ergebnis |
| --- | ---: |
| Capture-Runs | 1 |
| Neue gebundene Versionen | 1 |
| Neue eindeutige Blobs | 0 |
| Neu gespeicherte Bytes | 0 |
| Capture-P95 | 72 ms |
| Read-Requests | 2 |
| Read-P95 | 41 ms |
| Deduplizierung | 100 % |

Die Capture-Latenz misst konservativ die gesamte authentifizierte Import- oder Write-Requestdauer inklusive Autorisierung, Dateipublikation, Ledger und Versionsbindung, nicht nur den internen Capture-Schritt. Null neue Blob-Bytes sind der erwartete Cross-Lineage-Deduplizierungsfall; die neue immutable Versionsbindung belegt trotzdem einen echten Capture.

Der aggregierte Speichersnapshot nach dem Shadow-Canary ergab zwei Workspaces, fuenf Lineages, 15 gebundene Versionen, 11 eindeutige Blobs, 3.203 Raw-Bytes und 2.157 gespeicherte Bytes. Maxima waren 495 Raw-Bytes pro Version, 281 Bytes pro Blob, 2.100 Bytes pro Lineage, 2.100 Bytes pro Workspace und 11 Versionen pro Lineage. Damit lagen alle FVRC-002-Grenzen und das konservative lokale Latenzbudget von 1.000 ms innerhalb der Limits; der Evaluator meldete alle Gates als bestanden.

## Modusfolge und datenbewahrender Rollback

Der identische persistierte Markdown-Canary wurde in der Reihenfolge `shadow` → `read_only` → `off` verwendet. Erst der Off-Smoke entfernte ihn. Fuer die Capture-eigenen Tabellen lag der Shadow-Uebergang bei 11 → 11 Blobs und 14 → 15 Revision-Contents. Die drei nicht vom Capture mutierten Zaehler wurden erstmals unmittelbar nach dem Shadow-Schritt aggregiert und blieben in beiden folgenden Uebergaengen exakt stabil.

| Zeitpunkt | Blobs | Revision-Contents | Offene Reviews | Policies | Restore-Receipts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Nach Shadow / vor Read-only | 11 | 15 | 0 | 1 | 1 |
| Nach Read-only | 11 | 15 | 0 | 1 | 1 |
| Vor Off | 11 | 15 | 0 | 1 | 1 |
| Nach Off | 11 | 15 | 0 | 1 | 1 |

Im Modus `read_only` waren History und Compare positiv nutzbar. Restore und Policy-Mutation wurden serverseitig mit `FVRC_CAPABILITY_UNAVAILABLE` abgewiesen. Im Modus `off` blieben regulaeres Erstellen, Schreiben und Lesen einer Datei sowie die bestehende Collaboration-Agent-Review-Route nutzbar; alle FVRC-Capabilities waren verborgen und meldeten `rollout_disabled`. Nach dem Off-Smoke war der persistierte Canary entfernt, waehrend alle gespeicherten Versions-, Review-, Policy- und Receipt-Daten erhalten blieben. Es wurde keine Down-Migration und keine Datenloeschung fuer den Rollback verwendet.

## Verifikation und Betriebszustand

- `npm run test:file-version-center:rollout`: Modusmatrix, Env-Fail-closed, Grenz- und Evaluator-Tests sowie bestehende Collaboration-Approval-Route im Off-Modus bestanden.
- `npm run test:file-version-center:hardening` und `npm run test:collaboration:agent-approval`: bestanden.
- `npm run testenv:fixtures`: mit dem konfigurierten Provider bestanden; keine externe Modellanfrage war Teil dieses Rollout-Gates.
- Changed-file ESLint, `npx tsc --noEmit`, JSON-Validierung und `git diff --check`: bestanden.
- Der finale verwaltete Host- und Container-Build im Modus `full` war erfolgreich. Notebook, Control-Plane-API, Control-Plane-UI und PostgreSQL sowie ihre HTTP-/DB-Healthchecks waren gesund und nur an Loopback gebunden.

Die bereits in FVRC-701 dokumentierte externe Ollama-502 ist ein separater Provider-Befund. Sie wurde in FVRC-702 nicht erneut als Rollout-Gate ausgefuehrt und beeinflusste weder Build, Stackgesundheit, Shadow-Messung noch Rollback-Nachweis.
