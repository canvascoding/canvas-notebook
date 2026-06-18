# Docling Knowledge Ingestion Plan

Stand: 2026-06-17

## Ziel

Canvas Notebook soll eine robuste Dokumenten-Ingestion fuer Knowledge Base, Retrieval und spaetere Vektor-/Graph-Suche bekommen. Docling soll dabei als optionaler, leistungsfaehiger Parser fuer komplexe Dokumente eingeplant werden, ohne die bestehende schnelle `read`-Logik unnoetig schwer zu machen.

Der Plan ist bewusst noch keine Implementierung. Er beschreibt Architektur, Settings, Risiken und einen moeglichen Rollout.

Team-/Workspace-Scope, automatische Indexierung, Secret-/PII-Scan, Knowledge Stores und Retrieval-Berechtigungen werden im Team-Workspace-Plan unter `docs/architecture/canvas-notebook/team-workspace/12-knowledge-ingestion-retrieval-policy.md` verbindlich konkretisiert. Resource Profile, Memory-/CPU-Grenzen, Queue-Backpressure und Degradation fuer kleine VMs werden unter `docs/architecture/canvas-notebook/team-workspace/13-resource-aware-ingestion-and-job-backpressure.md` konkretisiert.

## Ausgangslage in Canvas

Die aktuelle PDF-Logik ist leichtgewichtig und direkt in Agent-Tools eingebaut:

- `app/lib/pi/tool-registry.ts` nutzt `pdf-parse` / `PDFParse` fuer Text-Extraktion aus PDFs.
- Das `read`-Tool kann PDF-Text seitenbegrenzt extrahieren und fuer kleine PDFs gerenderte Seitenbilder zurueckgeben.
- Es gibt keine vollwertige OCR-Pipeline fuer gescannte PDFs.
- Es gibt keine layoutbewusste Tabellen- oder Struktur-Extraktion fuer die Knowledge Base.
- `app/lib/email/compose-agent/workspace-tools.ts` nutzt ebenfalls `pdf-parse` fuer einfache PDF-Kontextlesung im E-Mail-Agenten.
- `scripts/qmd-prepare-derived-docx.mjs` erzeugt aktuell nur fuer DOCX-Dateien abgeleitete Markdown-Dateien via `mammoth.extractRawText`.
- QMD kennt derzeit `workspace-text` und `workspace-derived`; `workspace-derived` ist auf DOCX-Derivate ausgerichtet.

Damit ist die bestehende Logik gut fuer schnelle, einfache Reads. Fuer Knowledge-Ingestion, OCR, Tabellen, komplexe PDFs und organisationsweite Suche reicht sie nicht aus.

## Docling-Einordnung

Gemeint ist IBM Docling bzw. das Docling-Projekt:

- Projekt: https://docling-project.github.io/docling/
- Unterstuetzte Formate: https://docling-project.github.io/docling/usage/supported_formats/
- Chunking: https://docling-project.github.io/docling/concepts/chunking/
- Installation und OCR/Tesseract-Hinweise: https://docling-project.github.io/docling/getting_started/installation/
- API Server / `docling-serve`: https://docling-project.github.io/docling/usage/api_server/
- Advanced Options / Threading: https://docling-project.github.io/docling/usage/advanced_options/

Docling ist in dieser Architektur nicht die Vektor-Datenbank. Docling ist der Dokumentenparser und optional Chunker. Die Vektor-Datenbank, Metadaten, Berechtigungen und das Knowledge-Graph-Modell bleiben Canvas-eigene Schichten.

## Grundsatzentscheidung

Docling soll optional und kontrolliert eingesetzt werden:

1. Die schnelle native PDF-Logik bleibt fuer normale `read`-Aufrufe erhalten.
2. Docling wird zuerst fuer Knowledge-Ingestion und schwere Dokumentenverarbeitung eingesetzt.
3. OCR, Tabellen und layoutbewusste Extraktion muessen explizit konfigurierbar sein.
4. Docling darf nicht unkontrolliert im Next.js/Node-Prozess laufen.
5. Alle Ingestion-Ergebnisse muessen mit Scope, Source und Berechtigungen gespeichert werden.

## Architekturvorschlag

### Parser-Abstraktion

Eine interne Parser-Schicht sollte mehrere Provider kapseln:

- `native`: bestehende schnelle Logik mit `pdf-parse`, `mammoth`, Textdateien.
- `docling-cli`: Docling als isolierter Child Process.
- `docling-serve`: Docling als optionaler lokaler oder entfernter Service.
- `disabled`: kein schwerer Parser verfuegbar.

Alle Provider sollten ein gemeinsames Ergebnisformat liefern:

- `sourcePath`
- `sourceType`
- `parserProvider`
- `parserVersion`
- `pages`
- `text`
- `markdown`
- `structuredJson`
- `chunks`
- `tables`
- `images`
- `warnings`
- `errors`
- `durationMs`
- `resourceProfile`

### Ingestion-Pipeline

Fuer Knowledge Base und Retrieval:

1. Datei, Ordner oder Upload als `knowledge_source` registrieren.
2. Parser anhand Settings und Datei-Typ auswaehlen.
3. Dokument extrahieren.
4. OCR nur bei Bedarf oder expliziter Einstellung.
5. Strukturierte Ausgabe in Markdown/JSON normalisieren.
6. Chunks erzeugen.
7. Secret-, PII- und Prompt-Injection-Scan ausfuehren.
8. Chunks mit Source-Referenz speichern.
9. Embeddings erzeugen.
10. Vektorindex aktualisieren.
11. Optional Entities und Relations fuer Knowledge Graph extrahieren.
12. Audit- und Statusdaten speichern.

## Settings-Plan

Neuer Settings-Bereich: `Settings -> Knowledge` oder `Settings -> Document Parsing`.

### Parser-Auswahl

- Document Parsing: `off`, `native`, `docling`, `auto`
- Docling Execution: `local cli`, `local service`, `remote service`
- Fallback: `native on docling failure`, `fail hard`, `skip file`
- Feature Scope: `read tool`, `knowledge ingestion`, `both`

Empfohlener Default fuer V1:

- Document Parsing fuer schwere Ingestion: `off`, bis Admin oder Managed Policy explizit aktiviert.
- Nach Aktivierung: `auto`.
- Docling nur fuer Knowledge-Ingestion.
- Native Fallback aktiv
- OCR aus, aber "auto when no text" optional

### PDF-Einstellungen

- Max PDF size
- Max pages per document
- Max pages for OCR
- Max page render DPI
- Text extraction mode: `fast`, `balanced`, `accurate`
- OCR mode: `off`, `auto when no text`, `force`
- OCR engine: `auto`, `tesseract`, `tesseract-cli`, `easyocr`, `rapidocr`
- OCR languages, z.B. `deu,eng`
- Table extraction: `off`, `fast`, `accurate`
- Image extraction: `off`, `references only`, `extract assets`
- Preserve page numbers: `on`
- Preserve headings/reading order: `on`

### Compute- und Sicherheitslimits

- Max concurrent parse jobs, Default `1`
- Per-file timeout
- Per-page timeout fuer OCR
- Memory budget / minimum free memory
- CPU thread limit, z.B. `OMP_NUM_THREADS`
- Optional GPU use: `off`, `auto`, `force`
- Model cache path, z.B. `/data/cache/docling`
- Temp path, z.B. `/data/cache/document-ingestion/tmp`
- Job retry count
- Kill process on timeout
- Disable Docling automatically after repeated crashes

### Statusanzeige

Settings sollten einen Statusblock zeigen:

- Feature enabled/disabled fuer Knowledge Auto-Ingestion, Docling, OCR, Embeddings und Remote Parsing.
- Docling installed: yes/no
- Docling version
- Tesseract installed: yes/no
- Available OCR languages
- Service health
- Last successful parse
- Last error
- Current queue depth
- Estimated resource profile: `available`, `degraded`, `disabled`
- Last resource/log reason code
- Link auf relevante Job-/Operational-Logs, redacted

## Compute-Risiken

Docling kann deutlich schwerer sein als unsere aktuelle PDF-Textlogik. Risiken:

- Python/PyTorch/ML-Abhaengigkeiten koennen viel RAM brauchen.
- OCR ist CPU-intensiv.
- Grosse PDFs koennen den Prozess lange blockieren.
- Schlechte Server koennen bei paralleler Verarbeitung abstuerzen.
- Modell-Downloads und Cache-Verhalten muessen kontrolliert werden.

Deshalb sollte Docling nicht synchron im Request-Pfad der Haupt-App laufen. Fuer V1 ist ein Child Process mit harten Limits akzeptabel. Fuer Produktion ist ein isolierter Service oder Sidecar besser.

Das Muster ist aehnlich wie beim Browser-Tool: nur aktivieren, wenn der Host genug Ressourcen hat; sonst klar als nicht verfuegbar anzeigen.

Bei knappen Ressourcen gilt die Resource-Policy aus `13-resource-aware-ingestion-and-job-backpressure.md`: Jobs werden deferiert, nativ/degradiert verarbeitet, nur als Metadaten registriert oder kontrolliert abgebrochen. Sicherheitspruefungen duerfen dabei nicht uebersprungen werden; wenn Secret-/PII-Scan nicht erfolgreich laufen kann, entstehen keine Embeddings.

## Sicherheits- und Organisationsregeln

Fuer organisationsweite Knowledge Base gelten harte Regeln:

- Keine Secrets in Chunks oder Embeddings speichern.
- Secret-/PII-Scan laeuft vor Chunking und Embedding; Treffer fuehren je nach Policy zu `redact`, `quarantine`, `metadata-only` oder `block`.
- Prompt-Injection-Inhalte aus Dokumenten als untrusted source text behandeln.
- Retrieval muss vor der Rueckgabe nach Scope und ACL filtern.
- Jeder Chunk braucht `organizationId`, optional `workspaceId`, optional `userId`, `visibility`, `sourceRef`.
- Loeschen einer Source muss auch Chunks, Embeddings und Graph-Derivate entfernen.
- Admins brauchen Audit-Logs fuer Upload, Parse, Reindex, Search und Delete.
- Zusaetzlich braucht es strukturierte Operational Logs fuer Settings-Aenderungen, Resource-Budget-Entscheidungen, Parser-Starts, Timeouts, OOM/Crashes, Queue-State-Wechsel und Cleanup; diese Logs duerfen keine Dokumentinhalte, Prompts oder Secrets enthalten.
- Persoenliche Workspaces duerfen nicht in Team- oder Org-Retrieval leaken.
- E-Mail-Inhalte werden in V1 nicht automatisch in Knowledge aufgenommen.
- Studio-Medien werden in V1 nicht als Vollinhalt indexiert; nur explizite Textartefakte oder Metadaten nach Policy.

## Datenmodell-Skizze

Moegliche Tabellen oder Collections:

- `knowledge_sources`
  - `id`
  - `organizationId`
  - `workspaceId`
  - `userId`
  - `visibility`
  - `sourceType`
  - `sourcePath`
  - `contentHash`
  - `parserProvider`
  - `status`
  - `createdBy`
  - `createdAt`
  - `updatedAt`

- `knowledge_chunks`
  - `id`
  - `sourceId`
  - `organizationId`
  - `workspaceId`
  - `userId`
  - `visibility`
  - `chunkIndex`
  - `pageStart`
  - `pageEnd`
  - `text`
  - `markdown`
  - `metadata`
  - `contentHash`

- `knowledge_embeddings`
  - `chunkId`
  - `embeddingProvider`
  - `embeddingModel`
  - `vectorRef`
  - `createdAt`

- `knowledge_entities`
  - `id`
  - `organizationId`
  - `workspaceId`
  - `label`
  - `type`
  - `confidence`
  - `sourceRefs`

- `knowledge_relations`
  - `id`
  - `sourceEntityId`
  - `targetEntityId`
  - `relationType`
  - `confidence`
  - `sourceRefs`

## Integration mit QMD / Vector Search

Kurzfristig kann QMD als Prototyp fuer Suche und Embeddings dienen. Fuer echte Organisationen reicht ein globaler `/data/workspace`-Index nicht aus.

Vor einer produktiven Org-Knowledge-Base muss der Retrieval-Layer:

- Scope-Filter erzwingen
- Source-Metadaten kennen
- Deletes sauber propagieren
- private, workspace- und org-weite Inhalte trennen
- Suchergebnisse mit Zitaten und Source-Pfaden liefern

Docling sollte daher nicht einfach nur Markdown in `/data/cache/qmd/derived` schreiben. Besser ist eine neue generische Ingestion-Schicht, die QMD oder spaeter eine andere Vektor-DB als Backend nutzen kann.

## Rollout-Plan

### Phase 1: Analyse und Benchmark

- Kleine Testmenge aus PDFs, gescannten PDFs, DOCX, Tabellen-PDFs und langen Dokumenten definieren.
- Aktuelle Parser-Ausgabe gegen Docling vergleichen.
- Laufzeit, RAM, Textqualitaet, Tabellenqualitaet und OCR-Qualitaet messen.
- Noch keine UI- oder Runtime-Aenderung.

### Phase 2: Parser-Abstraktion

- Gemeinsames Ergebnisformat definieren.
- Native Parser unter diese Schnittstelle legen.
- Tests fuer einfache PDFs, leere/scanned PDFs und DOCX.
- Keine Verhaltensaenderung fuer bestehende Tools.

### Phase 3: Docling hinter Feature Flag

- `docling-cli` als experimentellen Provider anbinden.
- Default `off`, Aktivierung nur ueber Admin-Setting oder Managed Policy.
- Health Check und Statusdaten einbauen.
- Harte Limits fuer Timeout, Dateigroesse, Seitenzahl und Concurrency.
- Resource Budget Resolver fuer Memory, CPU, Disk, Queue-Tiefe und Container-Limits anbinden.
- Backpressure-Zustaende wie `deferred_low_resources`, `metadata_only` und `failed_resource_limit` persistieren.
- Strukturierte Logs fuer Resource-Entscheidungen, Parser-Exit, Timeout, Crash und automatische Deaktivierung schreiben.
- Native Fallback aktivieren.

### Phase 4: Settings UI

- Parser-Modus, OCR, Limits und Status sichtbar machen.
- Toggles fuer Knowledge Auto-Ingestion, Heavy Parsing, Docling, OCR, Embeddings und Remote Parsing sichtbar machen.
- Direkter Hinweis, wenn Host-Ressourcen oder Dependencies fehlen.
- Remote-Service/API-Key nur ueber zentrale Integrations-Env verwalten, falls benoetigt.

### Phase 5: Knowledge-Ingestion

- Upload/Ordner-Scan fuer Knowledge Sources.
- Background Job Queue fuer Parsing.
- Chunks, Source-Metadaten und Status persistieren.
- Erste Suche ueber bestehendes Suchbackend oder QMD-Prototyp.

### Phase 6: Org-Scope und Vektorindex

- Organisation, Workspace, User und Visibility erzwingen.
- Vektorindex nur mit ACL-faehigen Metadaten verwenden.
- Delete/Reindex/Audit vollstaendig abbilden.

### Phase 7: Knowledge Graph

- Entity- und Relation-Extraktion auf Basis der Chunks.
- Review/Confidence-Modell.
- Agent-Retrieval kann neben Vektor-Snippets auch Graph-Kontext nutzen.

## Offene Entscheidungen

- Soll V1 nur lokale Verarbeitung erlauben oder auch einen remote Docling-Service?
- Welche Vektor-DB soll langfristig verwendet werden?
- Soll QMD nur Prototyp bleiben oder als produktives Backend erweitert werden?
- Welche OCR-Sprachen sollen standardmaessig installiert sein?
- Wie gross darf ein Dokument pro Organization/Workspace maximal sein?
- Wie werden Kosten und Compute pro Organization sichtbar gemacht?
- Ab wann darf der normale `read`-Tool-Pfad Docling automatisch nutzen?

## Empfehlung fuer V1

Docling zuerst als optionale Knowledge-Ingestion-Pipeline einbauen, nicht als Default fuer `read`.

Konservativer V1-Default:

- Schwere Knowledge-Ingestion default `off`.
- Native Parser bleibt Standard.
- Docling nur fuer Knowledge-Ingestion.
- Docling default `off`, Aktivierung ueber Admin-Setting oder Managed Policy.
- Docling lokal/CLI/Sidecar, nicht remote als Default.
- OCR default `off`, Option `auto when no text`.
- Embedding-Indexing default `off`, bis Scan, ACL und Store bereit sind.
- Max concurrent Docling jobs: `1`.
- Harte Timeouts und Dateigroessenlimits.
- Resource Profile `low` muss Docling/OCR automatisch deaktivieren oder stark begrenzen koennen.
- Queue-Backpressure statt synchroner Verarbeitung oder paralleler schwerer Jobs.
- Native Fallback bei Fehler.
- Statusanzeige in Settings.
- Strukturierte redacted Logs fuer Settings, Resource-Entscheidungen, Queue, Parser und Cleanup.
- Keine organisationsweite Vektor-Suche ohne Scope-/ACL-Metadaten.
- Automatische Indexierung fuer Personal Knowledge und policy-gesteuerte Team Knowledge.
