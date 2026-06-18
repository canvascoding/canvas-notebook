# Resource-aware Ingestion und Job Backpressure

Stand: 2026-06-18

## Zweck

Dieses Dokument legt fest, wie Canvas Notebook mit kleinen oder knapp ausgestatteten Servern umgeht. Es konkretisiert die Resource-Grenzen fuer Knowledge-Ingestion, Docling/OCR, Embeddings, spaetere Knowledge-Graph-Jobs und andere schwere Background Jobs.

Es ergaenzt die Aufgaben `25`, `26`, `30`, `35` und `36` im Aufgabenindex.

## Grundentscheidung

RAM und CPU sind produktkritische Ressourcen. Parsing, OCR, Embedding-Erzeugung und Knowledge-Graph-Aufbau duerfen deshalb nie unkontrolliert im Request-Pfad oder im Hauptprozess der App laufen.

Regeln:

- Schwere Dokumentenverarbeitung laeuft ausschliesslich ueber Background Jobs.
- Docling/OCR laeuft isoliert als Child Process, lokaler Service oder Sidecar, nicht eingebettet im Next.js/Node-Hauptprozess.
- Default fuer V1 ist konservativ: ein schwerer Parse-Job gleichzeitig.
- Bei knappen Ressourcen wird nicht geraten oder trotzdem gestartet, sondern Jobs werden pausiert, degradiert oder kontrolliert abgebrochen.
- Resource-Entscheidungen werden sichtbar im UI, im Job-Status und im Control Plane gemeldet.
- Resource-Limits duerfen Sicherheitspruefungen nicht umgehen. Wenn Secret-/PII-Scan oder ACL-Pruefung nicht laufen kann, wird nicht indexiert.

## Resource Profile

Die Instanz bekommt ein effektives Resource Profile. Dieses kann vom Control Plane vorgeschlagen, aus Host-/Container-Metriken abgeleitet und durch Admin-Settings begrenzt werden.

| Profile | Typische Umgebung | Default-Verhalten |
|---|---|---|
| `low` | wenig RAM oder wenig CPU | Native Parser bevorzugen, Docling/OCR aus oder streng limitiert, Embedding-Batches klein, Jobs aggressiv pausieren |
| `standard` | ausreichend RAM fuer kleine Teams | Docling optional, max. ein schwerer Parse-Job, OCR nur `auto when no text`, harte Seiten-/Dateilimits |
| `large` | groessere VM oder dedizierte Worker | mehr Queue-Durchsatz moeglich, aber weiterhin per Budget und ACL begrenzt |
| `disabled` | Dependencies fehlen oder wiederholte Crashes | nur Metadata/Native-Fallback, kein Docling/OCR, klare Admin-Warnung |

Die konkreten Schwellenwerte muessen konfigurierbar sein. Wichtiger als fixe Zahlen ist, dass der Runtime-Resolver den tatsaechlichen Container- und Host-Zustand beruecksichtigt.

## Resource Budget Resolver

Vor jedem schweren Job wird ein Budget berechnet.

Input:

- Container Memory Limit und aktuell verfuegbarer Speicher.
- Host Memory, sofern durch den Agent gemeldet.
- CPU Count, aktuelle Load und laufende Worker.
- Disk frei, Temp- und Cache-Groesse.
- Queue-Tiefe und aktive Jobs pro Organization/User/Workspace.
- Dateigroesse, Seitenzahl, Dateityp und erwarteter OCR-Bedarf.
- Admin-Settings: max. Concurrency, max. Dateigroesse, max. Seiten, OCR-Modus, Timeouts.
- Managed-Quota aus dem Control Plane, falls vorhanden.

Output:

- `canStart`: true/false.
- `mode`: `full`, `native-only`, `metadata-only`, `deferred`, `blocked`.
- Parser Provider: `native`, `docling-cli`, `docling-service`, `disabled`.
- OCR Mode: `off`, `auto`, `force-blocked`.
- Embedding Batch Size.
- Timeout und Retry-Policy.
- Human-readable `reasonCode`, z. B. `low_memory`, `cpu_saturated`, `file_too_large`, `ocr_disabled`, `disk_low`, `dependency_missing`.

## Backpressure-Verhalten

Wenn Ressourcen knapp sind, muss das System stabil bleiben und dem User ehrlich sagen, was passiert.

Job-Zustaende:

- `queued`: Job wartet normal.
- `deferred_low_resources`: Job wird spaeter versucht, weil Memory/CPU/Disk knapp sind.
- `running_degraded`: Job laeuft mit Native Parser, ohne OCR oder mit kleinerem Batch.
- `metadata_only`: Quelle wird registriert, aber Inhalt wird nicht geparst oder embedded.
- `failed_resource_limit`: Job wurde wegen Timeout, Memory, Dateigroesse oder Seitenlimit beendet.
- `disabled_by_policy`: Admin/Managed Policy erlaubt den schweren Job nicht.

Regeln:

- Neue schwere Jobs starten nur, wenn das Resource Budget reicht.
- Laufende Child Processes werden bei Timeout oder Memory-Limit beendet.
- Wiederholte Crashes deaktivieren den schweren Parser automatisch bis zur Admin- oder Health-Recovery.
- Reindex-Jobs haben niedrigere Prioritaet als User-sichtbare File-/Upload-Aktionen.
- Team- und Organization-Jobs duerfen Personal-Jobs eines Users nicht unendlich verdraengen; es braucht Fairness pro Scope.
- Queue-Wachstum muss begrenzt werden. Wenn eine Queue zu gross wird, werden neue Ingestion-Jobs fuer diesen Scope voruebergehend abgelehnt oder nur als `metadata_only` registriert.

## Degradation Ladder

Bei knappen Ressourcen gilt diese Reihenfolge:

1. Embedding Batch Size reduzieren.
2. OCR deaktivieren oder auf wenige Seiten begrenzen.
3. Native Text-Parser statt Docling nutzen.
4. Nur Metadaten und Source-Referenz speichern.
5. Job deferieren.
6. Job blockieren und Admin/User mit Grund informieren.

Keine Degradation darf dazu fuehren, dass ungescannte Inhalte embedded oder ACL-Filter uebersprungen werden.

## Knowledge-Ingestion-Regeln

Fuer Knowledge-Ingestion gelten zusaetzlich:

- Secret-/PII-/Prompt-Injection-Scan bleibt Pflicht vor Chunking und Embedding.
- Wenn ein Dokument wegen Ressourcen nicht voll geparst werden kann, wird kein Teil-Embedding ohne klare Source-/Scan-Metadaten erzeugt.
- Gescanntes PDF mit OCR-Bedarf darf bei `low` Profile standardmaessig `metadata_only` oder `deferred_low_resources` werden.
- Tabellen-/Layout-Extraktion ist optional und darf bei knappen Ressourcen entfallen.
- Grosse Dokumente koennen abschnittsweise verarbeitet werden, solange Checkpoint, ACL und Scan-Status pro Abschnitt persistiert werden.
- Jeder Chunk speichert Resource-Metadaten: `resourceProfile`, `parseMode`, `budgetDecision`, `durationMs`, `memoryLimit`, `retryCount`.

## UI und Admin Settings

Admin-UI fuer Knowledge/Parsing muss Resource-Zustand zeigen:

- Resource Profile: `available`, `degraded`, `disabled`.
- Docling/OCR Status und letzte Fehlermeldung.
- Queue Depth pro Job-Typ.
- Aktive schwere Jobs.
- Letzte Resource-Limit-Abbrueche.
- Empfohlene Aktion: OCR deaktivieren, Dateilimit senken, Cache bereinigen, groesseren Plan waehlen.

Admin-Settings:

- Docling aktiv/inaktiv.
- OCR `off`, `auto when no text`, `force` nur mit Warnung.
- Max concurrent heavy jobs.
- Max document size.
- Max pages.
- Max OCR pages.
- Per-file Timeout.
- Memory Guard: minimum free memory oder max. Worker Memory.
- Wartungsfenster fuer Reindex/Vacuum/grosse Cleanup-Jobs.

Normale User sollen keinen technischen Debug-Dump sehen, aber klar erkennen:

- Datei wurde indexiert.
- Datei wartet auf Ressourcen.
- Datei wurde nur als Metadaten aufgenommen.
- Datei wurde wegen Limits nicht verarbeitet.

## Control Plane und Managed Mode

Das Control Plane muss nicht nur Disk, sondern auch Compute-/Memory-Risiken sehen.

Der Agent sollte melden:

- Host RAM total/available.
- Container Memory Limit und aktuelle Nutzung, falls verfuegbar.
- CPU Count und Load.
- Disk frei und Temp-/Cache-Groessen.
- Job Queue Depth nach Typ.
- Anzahl aktiver schwerer Parser/Embedding-Jobs.
- Parser Status: `available`, `degraded`, `disabled`.
- OOM-/Timeout-/Crash-Zaehler.
- Letzte `reasonCode`s fuer Backpressure.

Managed Config kann daraus Defaults setzen:

- `CANVAS_RESOURCE_PROFILE`.
- Max concurrent heavy jobs.
- Parser/OCR Feature Flags.
- Max file/page limits.
- Maintenance Window.
- Alerts fuer `resource_degraded`, `resource_critical`, `parser_disabled`.

## Storage- und Cleanup-Bezug

Compute-Limits reichen nicht, wenn Temp und Cache voll laufen.

Zusatzregeln:

- Parser-Temp liegt unter `/data/cache/document-ingestion/tmp` oder einem expliziten konfigurierten Pfad.
- Model-/Parser-Cache liegt unter `/data/cache/docling`.
- Temp-Dateien werden nach Job-Ende immer bereinigt.
- Abgebrochene Jobs bekommen Cleanup-Recovery beim naechsten Start.
- Cache-Groessen fliessen in Storage Monitoring und Admin Cleanup ein.
- Bei `storage_critical` werden schwere Parse-, OCR-, Reindex-, Import- und Backup-Jobs blockiert oder nur nach Admin-Bestaetigung gestartet.

## Automations und andere Background Jobs

Die Resource-Policy gilt nicht nur fuer Knowledge-Ingestion.

Betroffen sind:

- Personal und Organization Automations.
- Scheduled Reindex.
- Bulk Import/Export.
- Studio-Batch-Operationen.
- Backup/Restore-Vorbereitung.
- Cleanup/Vacuum/Maintenance.

Diese Jobs muessen Scope, Actor und Resource-Budget speichern. Organization-weite Jobs duerfen User-interaktive Arbeit nicht dauerhaft blockieren. Niedrig priorisierte Jobs laufen bevorzugt in Wartungsfenstern.

## Tests

Pflichttests:

- Low-Resource-Profil deaktiviert Docling/OCR oder setzt Jobs auf `deferred_low_resources`.
- Max concurrent heavy jobs wird eingehalten.
- Datei ueber Seiten-/Groessenlimit wird nicht voll geparst.
- OCR wird bei `low` Profile nicht automatisch gestartet.
- Child Process wird bei Timeout beendet und Job wird als `failed_resource_limit` markiert.
- Wiederholte Parser-Crashes setzen Parser Status auf `disabled`.
- Embeddings werden nicht erzeugt, wenn Secret-/PII-Scan wegen Ressourcen nicht erfolgreich war.
- ACL-/Scope-Filter bleiben auch bei degradierter Ingestion aktiv.
- Admin-UI zeigt Queue Depth, Parser Status und letzten Resource-Grund.
- Control Plane Report enthaelt Memory/CPU/Queue/Parser-Status.
- Cleanup entfernt Temp-Dateien nach erfolgreichen und abgebrochenen Jobs.

## Umsetzungsgate

Vor produktiver automatischer Knowledge-Ingestion muessen diese Bausteine stehen:

1. Background Job Queue mit Scope, Actor und Resource-Metadaten.
2. Resource Budget Resolver.
3. Harte Parser-/OCR-Limits.
4. Degradation und Backpressure-Zustaende.
5. Admin-Statusanzeige.
6. Control-Plane-Metriken fuer Memory, CPU, Queue und Parser-Status.
7. Tests fuer Low-Resource- und Crash-Faelle.

Ohne diese Gates darf automatische Ingestion nur fuer kleine Native-Parser-Faelle aktiviert werden.
