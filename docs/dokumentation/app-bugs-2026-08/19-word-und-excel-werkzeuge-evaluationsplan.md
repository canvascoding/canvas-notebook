---
title: 'Evaluationsplan zu Ticket 19: Word- und Excel-Werkzeuge'
status: planned
date: 2026-08-21
platforms: [server, agent-runtime]
tags: [type/evaluation-plan, topic/documents, topic/spreadsheets, topic/tools]
---

# Evaluationsplan: Word- und Excel-Werkzeuge

## Ziel, Scope und aktueller Entscheid

Dieser Plan konkretisiert [Ticket 19](./19-word-und-excel-werkzeuge-evaluieren.md)
als Evaluation. Er autorisiert noch keine produktive Office-Tool-Implementierung.
Die Phasen sind strikt sequenziell; jede Phase endet mit dokumentierter Evidenz,
den zugehoerigen Tests und einem fokussierten Commit, bevor die naechste beginnt.

Der aktuelle Entscheid lautet:

- **Go** fuer eine datensparsame Bedarfserhebung und einen isolierten,
  read-only Proof of Concept ausserhalb der produktiven Tool-Registry.
- **No-Go** fuer In-place-Bearbeitung, produktive DOCX-/XLSX-Schreibtools,
  Makroformate, Legacy-Office-Formate, Passwortentschluesselung, externe
  Link-Aufloesung und eine vorschnelle Aufnahme von LibreOffice ins
  Produktionsimage.
- **Conditional Go** fuer spaetere read-only Agent-Tools nur dann, wenn alle
  Nutzungs-, Sicherheits-, Ressourcen-, Qualitaets- und Capability-Gates aus
  diesem Plan bestanden sind.
- Ein spaeterer Schreib-/Editierpfad benoetigt nach einem erfolgreichen
  read-only Entscheid eine eigene Architekturentscheidung und ein eigenes
  Umsetzungsticket. Er ist nicht stiller Bestandteil dieses Tickets.

Nicht im Scope dieser Evaluation liegen UI-Fixes am bestehenden Word- oder
Spreadsheet-Editor, Knowledge-Ingestion, Mobile-Office-Editoren oder eine
allgemeine Dokumentkonvertierungsplattform. Befunde an diesen Pfaden werden
als Randbedingungen dokumentiert, aber nicht in Ticket 19 behoben.

## Inventur des bestehenden Stands

### Agent-Runtime und Tool-Exposure

- `app/lib/pi/core-tools.ts` stellt mit `read` Text-, Bild- und PDF-Lesen
  bereit. DOCX und XLSX werden durch `bufferLooksBinary(...)` als nicht
  unterstuetzte Binaerdateien abgelehnt.
- Das oeffentliche Agent-Tool `write` ist textbasiert. Der interne Helper
  `writeAgentBinaryFile(...)` in `app/lib/pi/agent-file-operations.ts` besitzt
  bereits wichtige Bausteine fuer spaetere Binaeroutputs: Workspace-Scope,
  `expectedSha256`, Create-versus-Overwrite, Snapshot, atomaren Temp-Write,
  Read-after-write, Revision, Lock-/Collaboration-Pruefung und Audit.
- `app/lib/pi/pdf-tools.ts` und `app/lib/pdf/tool-runtime.ts` sind die naechste
  Architekturvorlage: enge Typebox-Schemas, workspace-relative Pfade,
  Signatur-/Groessenpruefung, konservative Limits, sessiongebundene
  Temp-Verzeichnisse, gefilterte Environment-Werte, Child-Process-Timeouts und
  Commit ueber die zentrale Agent-Dateischicht.
- Es gibt noch kein `office`-Toolset und keine DOCX-/XLSX-Operation in
  `app/lib/pi/toolsets.ts`, `app/lib/pi/tool-registry.ts` oder den
  Progressive-Disclosure-Gateways.
- Die Tool-Registry filtert bereits anhand effektiver Agent-Konfiguration. Ein
  Office-Tool darf spaeter nur ueber diese Registry und niemals allein durch
  Skill- oder Prompttext autorisiert werden.
- [Ticket 18](./18-agent-system-prompts-an-tools-koppeln.md) behandelt die
  noch offene Kopplung von System-Prompt und tatsaechlich effektivem Toolset.
  Die Evaluation kann unabhaengig laufen; eine produktive Registrierung von
  Office-Tools muss mit Ticket 18 koordiniert werden.

### Vorhandene Skills und Plugins

- `seed_plugins/document-suite/.canvas-plugin/plugin.json` ist der
  standardmaessig gebootstrappte `document-suite`-Plugin und referenziert unter
  anderem `docx` und `xlsx`.
- `seed_skills/docx/SKILL.md` empfiehlt `python-docx`, `lxml`, `zipfile`,
  optional LibreOffice und Poppler. Der Skill fordert Copy-first und visuelle
  Validierung, besitzt aber kein durchsetzbares Tool-Schema.
- `seed_skills/xlsx/SKILL.md` empfiehlt `openpyxl`, `pandas` und optional
  LibreOffice. Auch hier sind die Regeln Prompt-Anweisungen und keine
  serverseitige Capability-Grenze.
- Der Hauptagent erhaelt derzeit alle effektiv aktivierten Skills in den
  Prompt. `app/lib/agents/system-prompt-shared.ts` verweist fuer DOCX und
  Tabellen allgemein auf passende Parser beziehungsweise Skills, ohne eine
  konkrete vorhandene Office-Operation garantieren zu koennen.
- `bash` ist zwar als inspection-orientiert beschrieben und blockiert bekannte
  direkte Datei-Mutationskommandos, Redirects und In-place-Editoren. Ein ueber
  Bash gestartetes Python-Skript kann jedoch technisch selbst Dateien
  schreiben. Damit waere eine reine Skill-plus-Python-Loesung keine belastbare
  Ersatzimplementierung fuer Snapshot, Lock, Revision, Audit und finalen
  Permission-Check.

Folgerung: Skills bleiben fuer Workflowwissen sinnvoll, duerfen aber weder
eine nicht vorhandene Capability behaupten noch die Sicherheitsgrenze eines
spezialisierten Tools ersetzen.

### Laufzeitbibliotheken und Produktionsimage

Bereits gepinnt und im Linux-Runtime-Image installiert sind laut
`requirements/runtime-python.txt`:

- `python-docx`, `lxml` und `defusedxml` fuer DOCX-/OOXML-Struktur;
- `openpyxl`, `pandas` und `xlsxwriter` fuer XLSX-/Tabellenarbeit;
- Poppler-Werkzeuge fuer PDF-Rendering.

Bereits als Node-Abhaengigkeiten vorhanden sind unter anderem:

- `mammoth` fuer DOCX-Textextraktion;
- SheetJS `xlsx` fuer Workbook-Parsing/-Erzeugung;
- `@eigenpal/docx-js-editor` und `jspreadsheet-ce` fuer Browser-Editoren;
- `jszip` fuer ZIP-Verarbeitung.

Nicht vorhanden ist LibreOffice beziehungsweise `soffice`. Eine Aufnahme
wuerde Imagegroesse, Startup-/Updatekosten, Angriffsoberflaeche,
Font-/Renderer-Drift und Ressourcenbedarf veraendern und ist deshalb kein
Default fuer den PoC. Ausserdem dokumentiert
`team-workspace/21-third-party-license-inventory-and-notices-policy.md` einen
noch blockierenden Lizenz-/Notice-Befund fuer
`@eigenpal/docx-js-editor@0.5.3`; ein neuer Serverpfad darf nicht von diesem
Clientpaket abhaengen.

### Bestehende Datei-, Upload-, Preview- und Exportpfade

- Workspace-Uploads erlauben im Chunked-Flow bis zu 5 GiB pro Datei und 20 GiB
  pro Batch. Diese Uploadgrenzen sind fuer einen Office-Parser viel zu breit
  und duerfen nicht als Parserlimits uebernommen werden.
- Uploads pruefen Pfade, Groessen, Diskreserve, Workspace und Ownership, aber
  nicht die internen OOXML-Beziehungen, Makros, eingebetteten Objekte,
  XML-Groessen oder das Dekompressionsverhaeltnis eines DOCX/XLSX-Pakets.
- `GET /api/files/download` streamt einzelne Dateien bis 2 GiB. Die
  Office-Editoren laden Binaerdateien ueber diesen Downloadpfad.
- `GET /api/files/read` ist fuer Text auf 5 MiB begrenzt und decodiert als
  UTF-8; es ist kein Office-Parser.
- `app/api/files/preview/route.ts` rendert Medienvorschauen, aber keine
  Office-Seiten. Office-Preview geschieht clientseitig in `OfficeEditor`.
- Mobile klassifiziert DOCX und XLSX bereits als `word` beziehungsweise
  `spreadsheet`, liefert bei Binaerformaten aber nur einen Downloadpfad.
- Public Sharing kann Office-Dateien mit den gleichen clientseitigen Editoren
  read-only anzeigen; es existiert kein serverseitiger Office-Rendervertrag.
- Markdown-zu-PDF, Marp und PDF-Agenttools sind eigenstaendige, getestete
  Exportpfade. Sie koennen als Muster fuer Output-Sicherheit dienen, ersetzen
  aber keine Office-Strukturpruefung.

### Bestehende Browser-Editoren und belegte Roundtrip-Grenzen

- `app/components/editor/DocxEditor.tsx` nutzt
  `@eigenpal/docx-js-editor` clientseitig. Es gibt keinen serverseitigen
  Render- oder Roundtrip-Nachweis fuer Kommentare, Redlines, Felder,
  eingebettete Objekte oder komplexe Layouts.
- `app/components/editor/SpreadsheetEditor.tsx` liest XLSX/XLS mit SheetJS,
  reduziert Sheets im Grid auf Zellwerte beziehungsweise Formeln und erzeugt
  beim Speichern eine neue Workbook-Struktur aus zweidimensionalen Arrays.
  Styles, Bilder, Diagramme, Tabellenobjekte, Names, Validierungen,
  Druckeinstellungen, externe Beziehungen und weitere OOXML-Strukturen werden
  dabei nicht bewusst uebernommen.
- Derselbe Save-Zweig schreibt auch fuer eine geoeffnete `.xls`-Datei
  `bookType: 'xlsx'`. Damit kann XLSX-Inhalt unter einer `.xls`-Endung
  entstehen. Dieser Pfad ist fuer einen Agent-Roundtrip ungeeignet.
- Die CSV-Unterstuetzung des Browsers splittet Zeilen und Kommata manuell und
  ist kein belastbarer Referenzparser fuer komplexe CSV-Dateien.
- `app/lib/files/collaboration-policy.ts` klassifiziert DOC/DOCX/XLS/XLSX und
  weitere Binaerformate in Shared Workspaces als `exclusive_lock`. Spaetere
  Office-Writes muessen diesen Vertrag respektieren; Copy-to-new-output ist
  kein Anlass, den Quell-Lock zu umgehen, wenn die Quelle gleichzeitig
  veraendert werden soll.

Folgerung: Die Browser-Editoren sind vorhandene Nutzerpfade, aber keine
geeignete Serverbibliothek und kein Fidelity-Oracle fuer Agenttools.

### Abgeleiteter DOCX-Pfad und Knowledge-Suche

- `scripts/qmd-prepare-derived-docx.mjs` extrahiert mit Mammoth Rohtext aus
  Workspace-DOCX und schreibt abgeleitetes Markdown unter
  `/data/cache/qmd/derived/docx`.
- Der QMD-Pfad ist optional, wird ueber Startup-/Updatejobs aktualisiert und
  bildet die Originaldatei ueber `originalPath` zurueck ab.
- Er extrahiert keine verlaessliche Layout-, Kommentar-, Redline-,
  Relationship- oder Sicherheitsstruktur und hat kein XLSX-Pendant.
- Abgeleitete QMD-Daten sind fuer Suche hilfreich, duerfen aber nicht als
  autoritative, aktuelle Office-Leseantwort oder Roundtrip-Quelle gelten.

### Bestehende Tests und Testluecken

Bereits vorhanden sind Tests fuer:

- Bootstrap und Manifest des `document-suite`-Plugins;
- Aktivierung und Prompt-Aufloesung von Skills/Plugins;
- QMD-Mapping von `*.docx.md` auf den Originalpfad;
- Mobile-Klassifizierung von DOCX und XLSX;
- Workspace-Pfade, Revisionen, Locks, Agent-Binaerwrites, Snapshots und Audit;
- ZIP-Pfadtraversal, Entry-Anzahl und Dekompressionslimits fuer die explizite
  Workspace-ZIP-Extraktion;
- PDF-Tool-Schemas, Runtime, Roundtrip und Rendering;
- Third-Party-Lizenzinventar.

Es fehlen Office-spezifische Parser-, Malware-/Relationship-,
Ressourcen-, Roundtrip- und Render-Fixtures. Ebenso fehlt ein Test, der
nachweist, dass ein Office-Tool nur im effektiven Toolset berechtigter Agenten
und nur im Workspace der Session erscheint.

## Belegte und zu verifizierende Ursachen

### Durch den Codebestand belegt

1. **Capability-Luecke:** Das generische `read` kann DOCX/XLSX nicht lesen;
   Skills beschreiben einen Workflow, stellen aber keine strukturierte
   Runtime-Operation bereit.
2. **Write-Grenzen-Luecke bei Skill-Skripten:** Direkte Python-Verarbeitung
   ueber `bash` laeuft nicht automatisch durch `writeAgentBinaryFile(...)` und
   damit nicht garantiert durch Snapshot, Lock, Revision und Dateiaudit.
3. **Lossy XLSX-Web-Roundtrip:** Der Browser-Save rekonstruiert das Workbook
   aus Grid-Daten und bewahrt nicht das vollstaendige OOXML-Paket.
4. **Fehlende Office-Preflight-Grenzen:** Die allgemeinen Uploadlimits und die
   ZIP-Extraktion schuetzen nicht automatisch einen DOCX-/XLSX-Parser.
5. **Fehlender Server-Renderer:** LibreOffice ist nicht installiert; der
   vorhandene Previewpfad liefert keinen Office-zu-PDF/PNG-Oracle.
6. **Unvollstaendige abgeleitete Suche:** QMD deckt nur DOCX-Rohtext ab und ist
   weder synchroner Parser noch XLSX-Loesung.
7. **Prompt-/Capability-Drift:** Allgemeine Prompttexte und standardmaessig
   aktivierte Office-Skills koennen Office-Faehigkeit suggerieren, obwohl kein
   Office-Tool existiert. Ticket 18 ist die vorgesehene Integrationsgrenze.

### Vor einem Produktentscheid zu verifizieren

- Wie viele aktive Workspaces DOCX/XLSX tatsaechlich wiederholt nutzen und
  welche Jobs nicht bereits durch Download, UI-Preview, CSV, Markdown oder PDF
  geloest werden.
- Ob Lesen/Zusammenfassen ausreicht oder ob Erstellen, gezieltes Editieren,
  Kommentare/Redlines, Formeln, Charts und Layout jeweils eigenstaendige
  Nachfrage besitzen.
- Welche Features `python-docx`, Mammoth und `openpyxl` bei realistischen
  Canvas-Fixtures verlaesslich lesen, welche sie nur erhalten und welche sie
  bei Save entfernen oder normalisieren.
- Ob Formeln nur als Formeltext plus gespeicherter Cachewert geliefert werden
  koennen oder ob ein Rechenengine-Bedarf besteht. Der PoC darf Formeln nicht
  selbst ausfuehren oder still neu berechnen.
- Peak-RSS, Laufzeit und Tempbedarf auf den unterstuetzten amd64-/arm64-
  Runtimeplattformen.
- Ob LibreOffice nur als Test-Oracle genuegt oder fuer geforderte
  Produktqualitaet unvermeidbar waere.
- Lizenz-, Notice-, CVE- und Supply-Chain-Status jeder neu hinzukommenden
  Komponente oder Version.

## Vergleich der Loesungsoptionen

| Option | Nutzen | Hauptgrenzen | Entscheid |
| --- | --- | --- | --- |
| Bestehende Datei-/Download-/UI-Pfade | Kein neues Agenttool; Nutzer koennen Office-Dateien bereits oeffnen oder herunterladen | Nicht agentlesbar; kein strukturiertes Ergebnis; XLSX-Save verlustbehaftet; kein Server-Render | Beibehalten, aber nicht als Agenttool wiederverwenden |
| QMD/Mammoth-Derivat | Bereits vorhandene DOCX-Volltextsuche, geringe Toolflaeche | Optional/stale, nur Rohtext, kein XLSX, keine direkte Sicherheits-/Strukturantwort | Nur Such-Fallback, nicht primaerer Office-Reader |
| Bestehende Skills plus Bash/Python | Bibliotheken sind bereits installiert; flexibel fuer Expertenfaelle | Prompt statt Policy; variable Skripte; schwer budgetierbar; Write-Broker kann umgangen werden; unklare Ergebnisse | No-Go als produktiver Standardpfad |
| Bestehende Browser-Editorbibliotheken serverseitig verwenden | Scheinbare Naehe zur UI | Client-/DOM-gebunden; XLSX-Roundtrip nachweislich lossy; DOCX-Paket hat Compliance-Befund | No-Go |
| Neue read-only Office-Service-Schicht mit gepinnten Python-Parsern | Strukturierte, begrenzte, auditierbare Reads; vorhandene Runtime-Abhaengigkeiten | Neue Parser-/Sicherheitslogik und Fixtures erforderlich; keine Layoutgarantie | Bevorzugter PoC |
| Neue produktive Create/Edit-Tools | Hoechster Funktionsumfang | Groesste Fidelity-, Konflikt-, Makro-, Ressourcen- und Rollbackrisiken | Aus Ticket 19 ausgeschlossen; eigenes Ticket nach Read-Go |
| Remote Office-/Cloud-Konverter | Potenziell hohe Fidelity | Datenabfluss, AVV/Region/Secrets, Kosten, Verfuegbarkeit, Egress | V1 No-Go |

## Architektur- und Sicherheitsentscheidungen fuer den PoC

### 1. Read-only ausserhalb der produktiven Registry

Der erste PoC wird als lokaler Test-Harness und kleine serverseitige
Service-Schicht ausgefuehrt, aber nicht in `piTools`, Toolsets, Settings,
Prompts oder den Default-Agent aufgenommen. Er erhaelt nur Fixture- oder
explizit uebergebene read-only Eingaben. Originale werden vor und nach jedem
Lauf gehasht; jede Hashaenderung ist ein harter Testfehler.

### 2. Nur OOXML ohne aktive Inhalte

Initial unterstuetzt werden ausschliesslich `.docx` und `.xlsx`, wenn Endung,
ZIP-Signatur, `[Content_Types].xml` und erwartete OOXML-Hauptteile
uebereinstimmen.

Initial sicher abzulehnen sind:

- `.doc`, `.xls`, `.docm`, `.dotm`, `.xlsm`, `.xltm`, `.xlsb` und OLE/CFB;
- passwortgeschuetzte oder verschluesselte Container;
- VBA-Projekte oder makrofaehige Content Types, auch bei falscher Endung;
- `altChunk`, ActiveX, OLE-Package/Object und unbekannte eingebettete Pakete;
- externe Templates, Data Connections, Query Tables und Relationships, die
  ohne explizite Offline-Policy nicht sicher dargestellt werden koennen;
- Container, die eine der Ressourcen- oder ZIP-Grenzen ueberschreiten.

Externe Hyperlinks duerfen als Text und normalisierte Relationship-Metadaten
gemeldet, aber nie aufgerufen, aufgeloest oder heruntergeladen werden. Formeln
werden als untrusted Daten ausgegeben und nie evaluiert. CSV-Injection ist bei
reinen Reads zu markieren; spaetere Exporte muessen Zellen mit `=`, `+`, `-`
oder `@` kontextabhaengig behandeln.

### 3. Prozessisolation und Ressourcenlimits

Parser laufen in einem Child Process mit gefilterter Environment und einem
sessiongebundenen Temp-Verzeichnis nach dem Muster von
`app/lib/pdf/tool-runtime.ts`. Der PoC belegt oder verwirft folgende
konservative Startwerte:

- maximal 25 MiB komprimierte Eingabedatei;
- maximal 5.000 ZIP-Entries;
- maximal 250 MiB deklarierte Gesamtdaten nach Dekompression;
- maximal 50 MiB pro ZIP-Entry und maximal 100:1 Dekompressionsverhaeltnis;
- maximal 100 Sheets und 100.000 gelesene Zellen pro XLSX-Call;
- maximal 50.000 DOCX-Absaetze, 2.000 Tabellen und 50.000 Zeichen Tooltext;
- 30 Sekunden Parser-Timeout und 512 MiB Prozessadressraum als Startbudget;
- 90 Sekunden nur fuer einen expliziten, isolierten Render-Test;
- genau ein schwerer Office-PoC-Prozess gleichzeitig.

Die Werte sind keine Produktzusage. Messdaten aus den Fixtures entscheiden,
ob sie enger werden muessen. Ein Limitfehler liefert einen stabilen Reason
Code und kein partielles Ergebnis, das Vollstaendigkeit suggeriert.

### 4. Keine Netz- und Secret-Abhaengigkeit

Der PoC benoetigt keine API-Keys. Der Child Process erhaelt keine ungefilterte
Environment, keine Secretpfade und keine Netzwerkaufgabe. Relationships,
Formeln, Bilder und eingebettete Dateien werden ausschliesslich aus dem
lokalen Paket inventarisiert.

### 5. Keine Inhalts-Telemetrie

Erlaubte aggregierte Evidenzfelder sind:

- Formatgruppe `docx` oder `xlsx`;
- Ereignistyp wie Upload, Open/Preview, Download, Agent-Anfrage oder
  Parser-Ergebnis;
- geclusterte Groessenklasse und Laufzeitklasse;
- Erfolg, Reason Code, Truncation, Resource-Profil und ungefaehre Featureflags;
- pseudonymisierter Workspace-/Tenant-Zaehler mit definierter Retention.

Nicht erhoben werden Dateiname, Pfad, Zellwerte, Dokumenttext, Formeln,
Relationship-Ziele, Kommentare, Personen- oder Firmennamen. Bestehende Daten
duerfen nur genutzt werden, wenn ihre Erhebung und der Zugriff bereits
datenschutzkonform sind. Andernfalls erfolgt die Bedarfserhebung aus
anonymisierten Support-Tags, freiwilligen Interviews und lokal berechneten
Aggregaten.

## Daten- und API-Vertraege fuer eine spaetere Conditional-Go-Umsetzung

Die folgenden Vertraege werden im PoC als reine Service-DTOs erprobt. Sie sind
noch keine freigegebenen Produkttools.

### Gemeinsamer Eingabevertrag

```ts
type OfficeInspectInput = {
  inputPath: string;          // workspace-relativ, nur .docx oder .xlsx
  maxCharacters?: number;    // serverseitig geklemmt
  includeProperties?: boolean;
};
```

`inputPath` wird serverseitig gegen den gebundenen `AgentExecutionContext`,
den mit `canRead`/`canRunAgent` aufgeloesten Session-Workspace, Symlinks und
den Workspace-Root geprueft. Client- oder LLM-Angaben zu Workspace, User,
Format oder Berechtigung sind nicht autoritativ.

### DOCX-Ergebnis

```ts
type DocxInspection = {
  format: 'docx';
  source: { path: string; sha256: string; sizeBytes: number };
  document: {
    paragraphs: Array<{ index: number; style: string | null; text: string }>;
    tables: Array<{
      index: number;
      rows: Array<Array<{ text: string; rowSpan?: number; colSpan?: number }>>;
    }>;
    headings: Array<{ level: number; text: string; paragraphIndex: number }>;
  };
  features: {
    hyperlinks: number;
    externalHyperlinks: number;
    images: number;
    comments: number;
    trackedChanges: boolean;
    fields: number;
    embeddedObjects: number;
  };
  warnings: OfficeWarning[];
  truncated: boolean;
};
```

Kommentare, Redlines, Felder und eingebettete Inhalte werden im ersten PoC
nur inventarisiert oder mit `unsupported_*` markiert. Ein Parser darf sie
nicht still als erhalten oder vollstaendig verstanden ausgeben.

### XLSX-Eingabe und Ergebnis

```ts
type XlsxInspectInput = OfficeInspectInput & {
  sheets?: Array<{
    name: string;
    ranges?: string[];        // A1-Notation, serverseitig normalisiert
  }>;
  includeFormulas?: boolean;
  includeStoredValues?: boolean;
  maxCells?: number;          // globales hartes Serverlimit bleibt autoritativ
};

type XlsxInspection = {
  format: 'xlsx';
  source: { path: string; sha256: string; sizeBytes: number };
  workbook: {
    sheets: Array<{
      name: string;
      visibility: 'visible' | 'hidden' | 'veryHidden';
      dimensions: string | null;
      cells: Array<{
        address: string;
        type: 'blank' | 'string' | 'number' | 'boolean' | 'date' | 'error' | 'formula';
        value?: string | number | boolean | null;
        formula?: string;
        storedValue?: string | number | boolean | null;
        numberFormat?: string;
      }>;
    }>;
    definedNames: number;
    tables: number;
    charts: number;
    externalLinks: number;
    dataConnections: number;
  };
  warnings: OfficeWarning[];
  truncated: boolean;
};
```

Formel und gespeicherter Wert werden getrennt. `storedValue` darf nicht als
neu berechnetes Ergebnis bezeichnet werden. Veraltete oder fehlende
Cachewerte erzeugen `formula_value_unverified`.

### Gemeinsame Warnungen und Fehler

```ts
type OfficeWarning = {
  code:
    | 'unsupported_feature'
    | 'external_relationship_blocked'
    | 'formula_value_unverified'
    | 'content_truncated'
    | 'render_unavailable'
    | 'potential_fidelity_loss';
  severity: 'info' | 'warning' | 'blocking';
  location?: string;
  message: string;
};
```

Stabile Fehlercodes muessen mindestens unterscheiden:

- `OFFICE_PATH_OUTSIDE_WORKSPACE` und `OFFICE_READ_FORBIDDEN`;
- `OFFICE_FORMAT_UNSUPPORTED` und `OFFICE_SIGNATURE_MISMATCH`;
- `OFFICE_ENCRYPTED` und `OFFICE_ACTIVE_CONTENT_BLOCKED`;
- `OFFICE_EMBEDDED_OBJECT_BLOCKED` und `OFFICE_EXTERNAL_CONTENT_BLOCKED`;
- `OFFICE_ARCHIVE_LIMIT`, `OFFICE_SIZE_LIMIT`, `OFFICE_CELL_LIMIT`;
- `OFFICE_TIMEOUT`, `OFFICE_MEMORY_LIMIT`, `OFFICE_PARSE_FAILED`;
- `OFFICE_RESULT_TRUNCATED` als erfolgreicher, klar markierter Teilstatus.

Tool-Output und Audit speichern keine Rohinhalte. Audit referenziert nur
Operation, Format, Workspace, Session, Agent, Hash, Groessenklasse, Limits,
Reason Codes, Warnungszaehler, Dauer und Erfolg.

### Spaetere Toolflaeche

Bei Conditional Go wird ein kleines `office`-Toolset mit
Progressive Disclosure bevorzugt:

- `inspect_docx` fuer strukturiertes read-only Lesen;
- `inspect_xlsx` fuer gezielte Sheet-/Range-Inspektion.

Beide Operationen sind `readOnly`, `idempotent`, standardmaessig deaktiviert
und fuer Delegation/Automation nur explizit freigebbar. Create/Edit/Render
werden nicht vorsorglich registriert. Das Toolset erscheint nur in Metadaten,
Prompt und Skillkontext, wenn es nach Registry-, Agent-, Workspace- und
Runtime-Policy effektiv verfuegbar ist.

## Read-only Proof-of-Concept

### Harness und Dateigrenzen

Der PoC soll folgende Struktur evaluieren, ohne sie bereits produktiv zu
verdrahten:

```text
app/lib/office/
  ooxml-preflight.ts
  inspection-types.ts
  tool-runtime.ts
scripts/
  office-inspection-runtime.py
  office-inspection-poc-test.ts
scripts/fixtures/office/
  benign/
  unsupported/
  malicious/
```

Der Node-Harness loest Pfad, Hash und Limits auf, kopiert die Eingabe bei
Bedarf in ein privates sessiongebundenes Temp-Verzeichnis und startet den
Python-Parser. Der Python-Prozess oeffnet die Quelle read-only, schreibt nur
JSON in Temp und liefert keine Datei in den Workspace zurueck. Tempdaten
werden in `finally` entfernt.

Die finale Implementierung darf anders geschnitten werden, wenn der PoC
belegt, dass eine kleinere Servicegrenze besser ist. Produktive Registry- oder
UI-Aenderungen sind in dieser Phase verboten.

### Fixture-Matrix

Versionierte, kleine und synthetische Fixtures decken mindestens ab:

DOCX:

- Absaetze, Headings, Listen, Tabellen, Header/Footer und Seitenumbrueche;
- Bilder, interne und externe Hyperlinks;
- Kommentare, Track Changes, Felder, Footnotes/Endnotes und Content Controls;
- komplexe Tabellen, Unicode, RTL, Emojis und fehlende Fonts;
- `altChunk`, OLE/Embedded Package, ActiveX, externe Template-Relationship;
- Makro-Content-Type unter falscher `.docx`-Endung;
- verschluesseltes, defektes, extrem verschachteltes und kompressionsstarkes
  Paket.

XLSX:

- Strings, Zahlen, Datum/Zeit, Boolean, Fehler, Leerzellen und Formeln;
- mehrere Sheets, Hidden/VeryHidden, Names, Merges, Tabellen und Filter;
- Styles, bedingte Formatierung, Validierung, Kommentare, Bilder und Charts;
- gespeicherte Formelwerte, fehlende/stale Cachewerte und volatile Formeln;
- externe Links, Data Connections, Query Tables und eingebettete Objekte;
- Makro-Content-Type unter falscher `.xlsx`-Endung;
- riesige Dimensionen, Shared-String-Fanout, viele Sheets, defektes XML,
  Zip-Bomb und verschluesseltes Paket.

Malicious Fixtures enthalten keine echte Malware und keine personenbezogenen
Daten. Sie bilden nur die Container- und Relationship-Muster reproduzierbar
nach.

### Roundtrip- und Paketvergleich

Der read-only PoC muss zuerst beweisen, dass das Original byte-identisch
bleibt. Zusaetzlich wird fuer die Entscheidung ueber ein spaeteres separates
Write-Ticket ein No-op-Roundtrip ausschliesslich auf einer Temp-Kopie
untersucht:

1. Original-SHA-256 und OOXML-Paketinventar erfassen.
2. Mit dem Kandidatenparser laden und ohne fachliche Aenderung in eine neue
   Temp-Datei speichern.
3. ZIP-Entry-Liste, Content Types, Relationships und kanonisiertes XML
   vergleichen.
4. Formatbezogene Semantik vergleichen:
   - DOCX: Absatz-/Run-Reihenfolge, Styles, Nummerierung, Sections,
     Header/Footer, Kommentare, Redlines, Felder und Medien;
   - XLSX: Zelltypen, Formeln, Cachewerte, Styles, Names, Tabellen, Charts,
     Validierungen, Merges, Visibility, Print Settings und Relationships.
5. Jede entfernte, umbenannte oder normalisierte nicht unterstuetzte Struktur
   als potenziellen Datenverlust ausweisen.

Ein erfolgreicher read-only Parser ist nicht automatisch ein erfolgreicher
Writer. Roundtrip-Verluste blockieren nur spaetere Write-Tools; sie muessen
read-only Reads als klare Unsupported-/Fidelity-Warnung begleiten.

### Render-Testplan

Rendering dient als Test-Oracle und erzeugt noch keine produktive
Render-Capability:

1. In einer isolierten Testumgebung mit gepinnter LibreOffice-Version die
   benignen Fixtures read-only zu PDF exportieren.
2. PDF mit vorhandenem Poppler zu PNG rendern.
3. Seitenzahl, Bounding-Boxen, abgeschnittene Inhalte, Tabellen, Charts,
   Header/Footer, Page Breaks, Fonts und fehlende Glyphen pruefen.
4. Original und No-op-Roundtrip mit demselben Renderer vergleichen.
5. Deterministische Bereiche per Pixel-/SSIM-Diff pruefen; font- oder
   antialiasingbedingte Abweichungen werden durch feste Image-/Fontversionen
   minimiert und zusaetzlich manuell bewertet.
6. XLSX-Sheets mit definierten Print Areas einzeln pruefen; sehr grosse Sheets
   erhalten bewusst nur strukturelle Abnahme statt einer unbrauchbaren
   Ganzseiten-Grafik.

Der Testbericht nennt Renderer-Version, Architektur, Fonts und alle
Abweichungen. Wenn LibreOffice nur fuer Tests benoetigt wird, bleibt es aus dem
Produktionsimage. Wenn Produktqualitaet ohne LibreOffice nicht belegbar ist,
ist dies ein eigener Kosten-/Ressourcenentscheid und kein stiller PoC-Ausbau.

## Belastbare Go/No-Go-Gates

### Bedarfsgate

Pro Format gilt ein Produkt-Go nur, wenn innerhalb eines festgelegten
90-Tage-Fensters mindestens zwei der folgenden drei Evidenzarten erfuellt sind:

1. mindestens 5 Prozent der aktiven Workspaces nutzen das Format an mindestens
   drei verschiedenen Tagen innerhalb eines 30-Tage-Teilfensters;
2. mindestens zehn inhaltlich verschiedene Support-/Featurefaelle aus
   mindestens fuenf Tenants beschreiben wiederkehrende Office-Jobs;
3. mindestens fuenf freiwillige Nutzerinterviews bestaetigen einen mindestens
   woechentlichen Job, der mit bestehenden Datei-/PDF-/CSV-Pfaden nicht
   ausreichend geloest wird.

Zusaetzlich muessen die zwei haeufigsten Jobs je Format benannt sein und
zusammen mindestens 80 Prozent der klassifizierten Office-Anfragen abdecken.
Werden die Schwellen wegen kleiner Grundgesamtheit nicht erreicht, bleibt das
Ergebnis `insufficient_evidence`, nicht automatisch Go.

### Sicherheitsgate

- 100 Prozent der Workspace-/Permission-/Symlink-Negativtests werden
  blockiert.
- 100 Prozent der Makro-, ActiveX-, OLE-, External-Content-, Encryption- und
  Zip-Bomb-Fixtures werden vor semantischer Verarbeitung sicher abgelehnt oder
  als explizit blockierend markiert.
- Kein Test erzeugt einen Netzwerkzugriff, fuehrt eine Formel aus oder laedt
  externe Relationships.
- Originalhashes bleiben in 100 Prozent der read-only Tests unveraendert.
- Logs, Audit und Fehlermeldungen enthalten keine Dokumenttexte, Zellwerte,
  Formeln, Dateinamen, Pfade oder Relationship-Ziele.
- Abbruch, Timeout und Parser-Crash entfernen Tempdaten und hinterlassen keine
  partielle Workspace-Datei.

Ein einzelner stiller Sicherheits- oder Originalmutationsfehler ist No-Go.

### Qualitaetsgate fuer read-only

- Alle benignen Fixtures oeffnen ohne Repair-Warnung im Referenzrenderer.
- DOCX-Absatz-, Heading- und Tabellenreihenfolge sowie XLSX-Zelltypen,
  Formeln und gespeicherte Werte stimmen fuer die unterstuetzte Fixture-Matrix
  zu 100 Prozent mit den erwarteten strukturellen Goldens ueberein.
- Nicht unterstuetzte Features werden zu 100 Prozent als Warnung oder
  blockierender Fehler ausgegeben; stiller Verlust ist nicht erlaubt.
- Truncation ist deterministisch, wird im Ergebnis markiert und respektiert
  globale Zeichen-/Zelllimits.
- Mindestens 95 Prozent der realistischen, freigegebenen anonymisierten
  Testdokumente liefern ohne Parserfehler ein nuetzliches Ergebnis. Die
  restlichen Faelle muessen einen stabilen, erklaerbaren Reason Code liefern.

### Ressourcen- und Betriebs-Gate

Auf beiden produktiv unterstuetzten Architekturen gilt fuer eine 10-MiB-
Standardfixture nach Warm-up:

- p95 Parserlaufzeit hoechstens 10 Sekunden;
- p95 Peak-RSS des Child Process hoechstens 384 MiB;
- harter Timeout spaetestens nach 30 Sekunden;
- keine zweite schwere Office-Verarbeitung parallel;
- Tempdaten nach Erfolg, Fehler, Timeout und Abbruch vollstaendig entfernt;
- keine neue Runtime-Abhaengigkeit fuer den read-only Pfad, sofern die
  vorhandenen gepinnten Pythonpakete ausreichen.

Erfordert der Reader LibreOffice oder vergroessert eine neue Abhaengigkeit das
Produktionsimage um mehr als 50 MiB, braucht dies einen separaten Architektur-
und Releaseentscheid. Es ist fuer Ticket 19 zunaechst No-Go.

### Capability- und Produkt-Gate

- Office-Operationen sind default `off` und nur fuer explizit berechtigte
  Agenten aktivierbar.
- Effektive Toolnamen, Toolset-Metadaten, Prompttext und Skillhinweise stimmen
  in Hauptagent, Specialized Agent, Delegation und Automation ueberein.
- Ein Agent ohne Office-Tool behauptet keine strukturierte Office-Faehigkeit
  und kann die Operation auch bei manipuliertem Prompt/Config nicht aufrufen.
- Die Aktivierung erweitert keine Workspace-Rechte und umgeht keine
  serverseitige Read-Pruefung.
- Lizenz-/Notice-/CVE-Gates sind fuer alle ausgelieferten Komponenten gruen.

### Write-Go als separates spaeteres Gate

Ein spaeterer Write-Entscheid benoetigt zusaetzlich:

- ausschliesslich Copy-to-new-output als Default; kein In-place-Write;
- `expectedSha256`, Lock, Revision, Snapshot, atomarer Commit, Audit und
  Read-after-write ueber `writeAgentBinaryFile(...)` oder eine gleichwertige
  zentrale Broker-Schicht;
- 100 Prozent Erhalt aller als unterstuetzt deklarierten OOXML-Strukturen;
- Render-/Roundtrip-Abnahme ohne nicht erklaerte visuelle oder semantische
  Differenz;
- klare Blockierung jedes nicht sicher erhaltbaren Features;
- eigener Feature Flag, eigene Rollback-Anleitung und eigenes Ticket.

Ohne diese Nachweise bleibt Schreiben No-Go, selbst wenn Lesen freigegeben
wird.

## Strikt sequenzielle Evaluations- und Implementierungsphasen

### Phase 0: Plan und Evidenzschema

- Diesen Evaluationsplan reviewen und die Produktverantwortlichen fuer
  Bedarf, Security, Runtime und Compliance benennen.
- 90-Tage-Fenster, aktive-Workspace-Definition und zulaessige aggregierte
  Felder vor Datenauswertung festschreiben.
- Keine neue Telemetrie einschalten, bevor Datenschutz, Retention und
  Tenant-Aggregation freigegeben sind.
- Verifikation: Dokumentationsreview, Linkpruefung und `git diff --check`.
- Commit: `Plan Office tool evaluation`.

### Phase 1: Datensparsame Bedarfserhebung

- Bestehende, rechtmaessig erhobene Aggregatdaten und Support-Tags auswerten;
  keine Dokumentinhalte oder Rohpfade nacherheben.
- Office-Anfragen in Jobs klassifizieren: lesen/zusammenfassen, Struktur
  extrahieren, erstellen, gezielt bearbeiten, kommentieren/redlinen,
  Formeln/Analyse, Render/Export.
- Bestehende Alternativen pro Job dokumentieren und den ungedeckten Bedarf
  quantifizieren.
- Bedarfsgate getrennt fuer DOCX und XLSX bewerten.
- Ergebnis als versionierte Evidence-/Decision-Datei neben diesem Plan
  speichern.
- Commit: `Document Office usage evidence`.

Abbruchbedingung: Erreicht kein Format das Bedarfsgate, endet Ticket 19 mit
No-Go und einer spaeteren Neubewertungsschwelle. Es wird kein PoC gebaut.

### Phase 2: Fixture- und Sicherheitskorpus

- Kleine synthetische benign/unsupported/malicious Fixtures erstellen.
- Erwartete Struktur, Risiken, Warnungen und Ablehnungsgrund je Fixture in
  einer Manifestdatei definieren.
- Fixture-Generatoren und Binaerartefakte reproduzierbar versionieren; keine
  Kunden- oder Produktionsdokumente committen.
- Vorhandene ZIP-/Path-Guard-Tests als Muster verwenden, aber Office-Preflight
  separat testen.
- Commit: `Add Office evaluation fixtures`.

### Phase 3: Isolierter read-only PoC

- OOXML-Preflight, Python-Child-Process und DTO-Normalisierung implementieren.
- Nur `python-docx`/`lxml` beziehungsweise `openpyxl` evaluieren; keine neue
  Runtime-Abhaengigkeit und keine Tool-Registry-Aenderung.
- Hash-Unveraenderlichkeit, Timeout, Abbruch, Temp-Cleanup und Limits testen.
- Struktur-Goldens fuer DOCX und XLSX vergleichen.
- Commit: `Evaluate read-only Office parsing`.

Abbruchbedingung: Sicherheits-, Originalmutations- oder harte Ressourcenfehler
beenden den PoC mit No-Go. Es folgt keine produktive Integration.

### Phase 4: Roundtrip- und Render-Evaluation

- No-op-Roundtrips ausschliesslich in Temp erzeugen und paketsemantisch
  vergleichen.
- In isolierter Testumgebung LibreOffice/Poppler-Referenzrenders erzeugen,
  Versionen festhalten und visuell sowie automatisiert vergleichen.
- Read-Fidelity und potentielle Write-Fidelity getrennt bewerten.
- Den Zusatzaufwand fuer Renderer, Fonts, Multi-Arch, Imagegroesse und
  Wartung messen.
- Commit: `Document Office fidelity results`.

### Phase 5: Go/No-Go-ADR

- Bedarf, Sicherheit, Qualitaet, Ressourcen, Compliance und Wartungsaufwand in
  einer Entscheidungsmatrix zusammenfuehren.
- Fuer DOCX-read, XLSX-read und spaetere Writes getrennt entscheiden.
- Bei No-Go Alternativen benennen: bestehende UI, QMD-DOCX-Suche, CSV/Markdown,
  PDF-Export oder explizite manuelle Skill-Nutzung ohne Produktzusage.
- Bei Conditional Go exakte unterstuetzte Features, Limits und Warnungen
  einfrieren; alles andere bleibt unsupported.
- Ticket und Index erst nach abgeschlossenem Entscheid aktualisieren.
- Commit: `Record Office tool decision`.

### Phase 6: Optionale read-only Produktintegration nach Go

Diese Phase beginnt nur mit freigegebener ADR und ist der erste
Produktionscode-Schritt:

- `app/lib/office/*` als server-only Service hardenen.
- `inspect_docx` und/oder `inspect_xlsx` in ein kleines, default-off
  `office`-Toolset aufnehmen.
- Tool-Registry, Metadaten, Settings und Progressive Disclosure anbinden.
- Effektiven Prompt/Skillkontext gemeinsam mit Ticket 18 testen.
- Audit, Runtime-Revalidation, Rate Limit und Workspace-Isolation integrieren.
- Keine Write-, Render- oder Convert-Operation hinzufuegen.
- Commit: `Add gated read-only Office tools`.

### Phase 7: Produktabnahme oder Rollback

- Alle automatisierten Office-, Registry-, Workspace-, Security-, Resource-
  und Prompt-Matrix-Tests ausfuehren.
- `npm run lint` fuer betroffene Dateien und `npm run build` ausfuehren.
- UI-/E2E-Pruefung mit Playwright oder Chrome nur nach expliziter Freigabe und
  nur auf dem bereits laufenden oder einmalig auf `localhost:3000`
  gestarteten Dev-Server; keinen Container ohne expliziten Auftrag bauen.
- Feature Flag zunaechst nur fuer interne Testagenten aktivieren.
- Bei Regression Flag deaktivieren und Office-Operationen aus dem effektiven
  Toolset entfernen; read-only erzeugt keine zu migrierenden Nutzerdaten.
- Commit: `Verify gated Office tool rollout` oder Rollback-Commit.

## Konkreter automatisierter Testplan

### Parser und Preflight

- Signatur, Content Types und Hauptteile stimmen mit der Endung ueberein.
- Makro-/OLE-/ActiveX-/External-Content-/Encryption-Fixtures werden korrekt
  klassifiziert und blockiert.
- XML-Entity-, Shared-String-, Dimension-, Entry-, Groessen- und
  Kompressionslimits greifen vor unkontrollierter Verarbeitung.
- DOCX-Struktur und XLSX-Zelltypen/Formeln entsprechen den Goldens.
- Unsupported Features erzeugen stabile Warnungen statt stiller Auslassung.
- Range-, Sheet-, Zeichen- und Zelllimits truncaten deterministisch.

### Scope, Berechtigung und Audit

- Personal-, Organization-, Team- und Project-Workspace-Reads bleiben im
  gebundenen Workspace.
- Fremde Workspaces, fehlendes `canRead`, Symlinks nach aussen, absolute Pfade
  und Traversal werden blockiert.
- Permission-Entzug zwischen Tool-Aufbau und Call blockiert den Call.
- Delegation/Automation erhaelt Office nur bei expliziter Toolsetfreigabe.
- Audit enthaelt Hash, Format, Limits und Reason Codes, aber keine Inhalte oder
  sensitiven Pfade.

### Ressourcen und Cleanup

- Harte Datei-, Entry-, Expanded-Size-, Cell- und Ergebnislimits.
- Timeout, AbortSignal, Child-Process-Exit, Memory-Limit und Crash.
- Genau ein schwerer Office-Prozess gleichzeitig; weiterer Call wird
  kontrolliert queued oder abgelehnt.
- Temp-Cleanup nach Erfolg, Parserfehler, Timeout, Abort und Prozesscrash.
- Wiederholte Fehler vergroessern weder Cache noch Workspace.

### Roundtrip und Render

- Original-SHA bleibt immer gleich.
- Temp-Roundtrip wird strukturell und auf OOXML-Entry-Ebene verglichen.
- Verlust von Relationship, Style, Chart, Comment, Redline, Validation oder
  Field ist explizit sichtbar.
- Referenzrender prueft Seiten/Sheets, Tabellen, Charts, Fonts, Glyphen,
  Header/Footer und Page Breaks.
- Renderer-/Fontversionen sind im Testergebnis festgehalten.

### Tool- und Promptmatrix nach Conditional Go

- Tool-Metadaten gruppieren Office korrekt und markieren read-only.
- Defaultagent ohne aktiviertes Office, aktivierter Hauptagent,
  Specialized Agent, Delegation und Automation ergeben die erwartete
  Schnittmenge.
- Prompt nennt keine Office-Operation, die nicht im effektiven Toolset liegt.
- Skill-Dateien sind nur lesbar, wenn der Skill effektiv ausgewaehlt ist.
- Manipulierte Agentenkonfiguration erweitert weder Tool- noch Workspace-Recht.

Geeignete neue Testdateien nach Go waeren:

- `scripts/office-ooxml-preflight-test.ts`;
- `scripts/office-inspection-runtime-test.ts`;
- `scripts/office-inspection-tools-test.ts`;
- `scripts/office-roundtrip-render-test.ts`;
- Erweiterungen von `scripts/pi-tool-registry-test.ts`,
  `scripts/agent-session-workspace-context-test.ts`,
  `scripts/file-collaboration-policy-test.ts` und den Prompt-Matrix-Tests aus
  Ticket 18.

## Manuelle Abnahmekriterien

Fuer den reinen PoC ohne Produktintegration:

- Security und Produkt pruefen den Fixture- und Warnungskatalog.
- Ein Reviewer vergleicht strukturierten Output mit Word/Excel-
  Referenzansicht, ohne Originale zu speichern oder hochzuladen.
- Render-Goldens werden fuer mindestens eine einfache und eine komplexe Datei
  je Format auf Clipping, fehlende Inhalte und Warnungsparitaet geprueft.
- Der Entscheidbericht trennt klar zwischen read-only Nutzen und nicht
  nachgewiesener Write-Fidelity.

Nach Conditional Go fuer produktive read-only Tools:

- Ein berechtigter Testagent kann eine kleine DOCX/XLSX im eigenen Workspace
  gezielt inspizieren und erhaelt Struktur plus Warnungen.
- Derselbe Agent kann weder externe Inhalte laden noch ein Original oder eine
  neue Office-Datei schreiben.
- Ein nicht berechtigter Agent sieht weder Tool noch Capability-Behauptung.
- Shared-Workspace-, Permission- und Workspace-Wechsel werden manuell
  gegengeprueft.
- UI-/Browsertests erfolgen nur nach expliziter Freigabe gemaess
  Repository-Regeln.

## Risiken, Migration und Rollback

| Risiko | Gegenmassnahme |
| --- | --- |
| Stiller OOXML-Verlust | Read-only zuerst; Unsupported-Inventar; getrenntes Write-Gate; Paket- und Rendervergleich |
| Makros oder aktive Inhalte | Nur `.docx`/`.xlsx`; Content-Type-Preflight; harte Ablehnung vor Parser |
| Externe Links/Data Connections | Nie aufloesen; nur zaehlen/markieren; Remote Parsing default verboten |
| Zip-Bomb/XML-Fanout | Komprimierte und expandierte Limits, Entry-/Ratio-/Cell-Limits, Child-Process-Budget |
| Formel-/CSV-Injection | Formeln nie evaluieren; als untrusted markieren; spaetere Exporte separat absichern |
| Parser-Crash/OOM | Child Process, Timeout, Memory-Limit, Concurrency 1, Temp-Cleanup |
| Workspace- oder Rechteleck | AgentExecutionContext, realpath/Symlink-Guard, Revalidation pro Call, negativer Scope-Test |
| Prompt behauptet nicht vorhandene Tools | Registry als Autoritaet; produktive Integration mit Ticket 18 |
| Skill umgeht Write-Broker | Skills nur Guidance; keine produktive Office-Mutation ueber Bash/Python |
| Dependency-/Lizenzrisiko | Vorhandene gepinnte Pythonpakete bevorzugen; Compliance-Gate; Eigenpal nicht serverseitig wiederverwenden |
| Image-/Updatekosten durch LibreOffice | Nur isolierter Test-Oracle; separate ADR vor Produktionsaufnahme |
| Inhaltsleck durch Telemetrie | Nur Format-/Zaehler-/Reason-Code-Aggregate; keine Pfade, Namen, Inhalte oder Formeln |

Der read-only Pfad benoetigt keine Datenbankschema-Migration und erzeugt keine
persistenten Dokumentderivate. Ein Rollback besteht aus dem Deaktivieren des
Feature Flags und Entfernen des `office`-Toolsets aus der effektiven Registry.
Bestehende Office-Dateien, QMD-Derivate und UI-Pfade bleiben unveraendert.

Ein spaeterer Write-Pfad darf keine Migration von Originaldateien durchfuehren.
Outputs werden als neue Dateien erzeugt. Rollback verwendet den zentralen
Snapshot-/Revision-Mechanismus; In-place-Migrationen oder automatische
Workbook-/Dokument-Upgrades bleiben ausgeschlossen.

## Abschlusskriterien fuer Ticket 19

Ticket 19 kann nach der Evaluation geschlossen werden, wenn:

- Bedarfsevidenz ohne Dokumentinhalte erhoben und gegen das Bedarfsgate
  bewertet ist;
- DOCX und XLSX getrennte Go/No-Go-Entscheidungen besitzen;
- der read-only PoC nachweislich keine Originaldatei veraendert;
- Security-, Ressourcen-, Fidelity-, Roundtrip- und Renderbericht vorliegen;
- unterstuetzte und blockierte Features sowie exakte Limits dokumentiert sind;
- eine Conditional-Go-Toolflaeche oder die begruendete No-Go-Alternative
  feststeht;
- produktive Writes entweder explizit abgelehnt oder in ein separates Ticket
  mit eigenen Gates verschoben wurden;
- Ticket und [Index](./README.md) den finalen Entscheid referenzieren;
- jeder Evaluationsschritt als fokussierter Commit nachvollziehbar ist.
