---
title: 'Umsetzungsplan zu Ticket 22: MARP-YAML und Formatierung beim Editorwechsel erhalten'
status: planned
date: 2026-08-21
platforms: [web, server]
tags: [type/implementation-plan, topic/marp, topic/editor, topic/frontmatter]
---

# Umsetzungsplan: MARP-Editor-Roundtrip verlustfrei machen

## Ziel, Scope und Arbeitsmodus

Dieser Plan konkretisiert [Ticket 22](./22-marp-editor-roundtrip-verlustfrei-machen.md)
fuer den aktuellen Web-, Datei- und Collaboration-Code. Die Umsetzung erfolgt
streng sequenziell: Jede Phase wird vollstaendig implementiert, automatisiert
geprueft und als eigener fokussierter Commit abgeschlossen, bevor die naechste
Phase beginnt.

Verbindliche Produktregel ist: Ein Ansichts- oder Editorwechsel ist keine
Inhaltsaenderung. Ohne Nutzeredit darf er weder `onChange`, Dirty-State,
Autosave noch eine Dateirevision ausloesen. Rich Editing wird nur angeboten,
wenn der exakt in Produktion verwendete Parser-/Serializer-Vertrag fuer das
konkrete Dokument nachweislich sicher ist. Im Zweifel bleibt der exakte
Source-Text die Wahrheit.

Im Scope liegen:

- Web-Notebook mit MARP-Preview, TipTap-Rich-Editor und Source-Editor;
- Front Matter und Obsidian-Metadaten des Markdown-Dokuments;
- lokale Whole-File-Saves sowie die bestehende Yjs-Representation fuer
  kollaborative Markdown-Dateien;
- Dirty-State, Autosave, Revision-/SHA-Konflikte und atomarer Dateiersatz;
- automatisierte Roundtrip-Fixtures und manuelle Web-Abnahme.

Nicht im Scope liegen Ticket 21, die Expo-App, ein neuer MARP-Renderer, eine
allgemeine Markdown-Formatierungsfunktion oder eine Erweiterung des
TipTap-Schemas um beliebige HTML-/MARP-Konstrukte. Nicht sicher darstellbare
Syntax wird erhalten und im Source-Modus bearbeitet, statt fuer dieses Ticket
zwanghaft in Rich-Text-Nodes uebersetzt zu werden.

## Inventur des aktuellen Stands

### Editor- und Vorschaudatenfluss

```text
GET /api/files/read
  -> useFileStore.currentFile + stats.sha256 + revision
  -> useEditorStore.setActiveFile(path, content)
  -> draft/baseContent, isDirty=false

FileEditor
  -> isMarpMarkdown(path, draft)
  -> MARP-Preview: MarpPreview(path, draft)
  -> Markdown: MarkdownEditor(value=draft, onChange=updateCollaborativeDraft)

MarkdownEditor
  -> parseCanvasMarkdownDocument(value)
  -> splitCanvasMarkdownForRichEditor(value)
  -> exakter Front-Matter-Praefix + TipTap-Body
  -> TipTap getMarkdown() + unveraenderter Praefix
  -> useEditorStore.updateDraft(nextValue), isDirty=true

FileEditor Autosave nach 800 ms
  -> useFileStore.saveFile(path, draft)
  -> POST /api/files/write mit expectedSha256/baseRevisionId
  -> writeWorkspaceFileContent
  -> workspace-files.writeFile -> fs.writeFile(finalPath)
```

### Bereits vorhandene, weiterzuverwendende Bausteine

- `app/components/editor/FileEditor.tsx`
  - MARP wird aus Dateiname oder Inhalt erkannt;
  - MARP oeffnet standardmaessig die Slide-Preview;
  - der Preview-/Markdown-Schalter aendert nur lokalen View-State;
  - Dirty-State, 800-ms-Autosave, Save-on-Close und sichtbare externe
    Konfliktaktionen sind bereits vorhanden.
- `app/components/editor/MarkdownEditor.tsx`
  - trennt valides Front Matter vor der TipTap-Initialisierung vom Body;
  - setzt den Praefix bei `getMarkdown()` wieder vor den serialisierten Body;
  - erzwingt Source fuer ungueltiges Front Matter, Performance-Grenzen sowie
    einige nicht unterstuetzte Obsidian-Konstrukte;
  - deaktiviert den lokalen Rich-/Source-Schalter bei aktiver Collaboration.
- `app/lib/markdown/obsidian-metadata.ts`
  - erkennt BOM, CRLF/LF-Delimiter und ein geschlossenes Front Matter bis
    64 KiB;
  - verwendet `yaml.parseDocument(..., keepSourceTokens: true)`;
  - kann den unveraenderten Praefix und Body exakt wieder zusammensetzen;
  - bewahrt bei expliziten Property-Aenderungen Kommentare und unbekannte
    Felder bereits teilweise ueber den YAML-AST.
- `app/lib/markdown/obsidian-flavored-markdown.ts`
  - zwingt Obsidian-Kommentare, Block-IDs und ein zweites Front Matter im Body
    bereits in den Source-Modus.
- `app/lib/collaboration/markdown-state.ts`
  - speichert bei `tiptap_xml` Front Matter separat in `Y.Text('frontmatter')`;
  - validiert Schema, stabile IDs und einen kanonischen Rich-Roundtrip;
  - serialisiert Checkpoints wieder aus Front Matter und TipTap-Body.
- `app/lib/files/client.ts`, `app/store/file-store.ts`,
  `app/lib/files/revision-guard.ts` und `app/lib/files/write-service.ts`
  - transportieren `expectedSha256` und `baseRevisionId`;
  - Shared Workspaces lehnen fehlende oder veraltete Revisionen ab;
  - der Client pausiert Autosave nach erkanntem externem Konflikt und bietet
    Reload, Merge oder Konfliktkopie an.
- Bestehende Tests decken semantische TipTap-Nodes, Obsidian-Syntax,
  Front-Matter-Parsing, MARP-Preview/Export und File-Revision-Guards ab.

### Relevante Architekturvorgaben

- `docs/architecture/canvas-notebook/team-workspace/18-collaboration-and-file-conflict-policy.md`
  verlangt genau eine schreibbare Collaboration-Representation pro Dokument:
  `tiptap_xml` fuer sicher serialisierbares Markdown, sonst `plain_text`.
- Ein Representation-Wechsel ist laut dieser Policy keine lokale UI-Aktion,
  sondern eine serverseitige Migration bei leerem Room mit bestaetigtem
  Checkpoint und Validierung.
- Whole-File-Autosave darf bei einem aktiven Yjs-Dokument nicht als zweite
  Wahrheit parallel laufen. Der aktuelle `FileEditor` beachtet dies bereits.
- CRLF und BOM werden im Collaboration-Persistenzpfad bereits als
  Serialisierungsprofil getrennt vom kanonischen Yjs-Inhalt behandelt.

## Belegte Fehlerursachen und offene Verifikation

### Im Code belegt

1. **Kein bytegenauer Rich-Preflight:** `MarkdownEditor` entscheidet ueber
   Rich-Faehigkeit anhand weniger Guard-Regeln. Es vergleicht nicht, ob
   `TipTap.parse(body) -> getMarkdown()` den konkreten Body bytegleich
   reproduziert.
2. **Whole-Body-Serialisierung nach jedem Rich-Edit:** Sobald TipTap ein Update
   meldet, ersetzt `getMarkdown()` den gesamten Body. Abweichende Listenmarker,
   Whitespace, Tabellenlayout, HTML oder andere lexikalische Details koennen
   deshalb auch ausserhalb der beabsichtigten Aenderung normalisiert werden.
3. **Keine erklaerbare Unsupported-UI:** Source-Pflicht wird intern berechnet.
   Der Rich-Schalter ist dann deaktiviert oder Source wird erzwungen, ohne einen
   stabilen Reason-Code und ohne konkrete Warnung, welche Syntax geschuetzt
   wird.
4. **Dirty-State akzeptiert jede Meldung als Edit:**
   `useEditorStore.updateDraft` setzt immer `isDirty=true`; eine zentrale
   Gleichheits- und Origin-Pruefung fehlt. Der Rich-Editor besitzt lokale
   Gleichheitschecks, der Store-Vertrag garantiert aber nicht, dass ein
   Remount, Plugin-Update oder Moduswechsel niemals dirty wird.
5. **MARP-Erkennung hat einen zweiten Front-Matter-Parser:**
   `app/lib/marp/detect.ts` nutzt strengere Regexe als
   `parseCanvasMarkdownDocument` und akzeptiert zum Beispiel nicht alle dort
   erlaubten Delimiter-Varianten. Erkennung, Metadaten-Split und
   Rich-Faehigkeit koennen dadurch unterschiedliche Dokumentgrenzen sehen.
6. **SHA-Konfliktschutz ist im Personal Workspace wirkungslos:** Der Client
   sendet einen bekannten `expectedSha256`, aber
   `assertWorkspaceFileRevisionAllowed` kehrt fuer Workspaces ohne
   `requireExpectedRevision` vor dem Mismatch-Vergleich zurueck. Ein bekannter
   veralteter SHA wird dort nicht abgelehnt.
7. **Der finale Write ist nicht atomar:** `workspace-files.writeFile` schreibt
   mit `fs.writeFile` direkt auf den Zielpfad. Ein Prozessabbruch kann einen
   unvollstaendigen Zielinhalt hinterlassen; Revision-Check und Write liegen
   ausserdem nicht in einer gemeinsamen serverseitigen Path-Critical-Section.
8. **Vorhandene Roundtrip-Tests sind ueberwiegend semantisch:**
   `scripts/tiptap-markdown-roundtrip-test.ts` prueft Nodes und Regexe im
   Ergebnis, aber keine bytegleichen Fixture-Roundtrips und keine Kette
   Preview -> Rich -> Source -> Preview ohne Edit.

### Vor Implementierung mit Fixtures zu verifizieren

- Ob TipTap-Initialisierung, `UniqueID` oder andere Plugins in der aktuellen
  Version ohne Nutzerinteraktion ein `onUpdate` mit geaendertem Dokument
  ausloesen.
- Welche konkreten Konstrukte der produktiven Extension-Liste bytegleich
  roundtrippen und welche normalisiert oder verworfen werden, insbesondere:
  HTML, MARP-Kommentardirektiven, Folientrenner, Code-Fences, harte Umbrueche,
  Tabellen, verschachtelte Listen, Escape-Sequenzen und trailing newline.
- Wie `yaml` 2.9 bei einer gezielten Property-Aenderung Kommentare, Quotes,
  Flow-/Block-Arrays, Anchors, unbekannte Tags, Block Scalars und CRLF
  serialisiert. Ein nur semantisch gleiches, aber breit neu formatiertes YAML
  gilt als nicht ausreichend.
- Ob ein Source-only MARP-Dokument in einem bereits als `tiptap_xml`
  initialisierten Collaboration-Dokument vorkommen kann. Dieser Zustand darf
  nicht durch einen lokalen Representation-Wechsel kaschiert werden.
- Die Plattformdetails fuer atomaren Ersatz auf Linux und macOS: Temp-Datei im
  selben Verzeichnis, Rechteuebernahme, optionales `fsync`, `rename` und
  Cleanup bei Fehlern. Windows-Verhalten ist separat zu dokumentieren, falls
  es vom POSIX-Ersatz abweicht.

## Architektur- und Sicherheitsentscheidungen

### 1. Source bleibt die kanonische verlustfreie Representation

Front Matter und Markdown-Body werden als Original-Source gehalten. TipTap ist
eine abgeleitete Bearbeitungsansicht und darf den Store erst nach einer echten
Nutzertransaktion aktualisieren. Ein Moduswechsel selbst parst hoechstens in
einen temporaeren Kandidaten; er committed keine Konvertierung.

### 2. Rich Editing nur nach demselben bytegenauen Codec-Preflight

Ein gemeinsamer Codec, zum Beispiel
`app/lib/markdown/rich-markdown-codec.ts`, kapselt die produktive Extension-
und Markdown-Konfiguration. Client-Editor, Collaboration-Initialisierung,
Checkpoint-Validierung und Tests duerfen keine auseinanderlaufenden
Parserlisten pflegen.

Der Preflight arbeitet auf dem vom Front Matter getrennten Body:

```ts
type MarkdownRichModeReason =
  | 'invalid_frontmatter'
  | 'document_too_large'
  | 'long_line'
  | 'unsafe_slash_run'
  | 'unsupported_obsidian_syntax'
  | 'unsupported_marp_directive'
  | 'unsupported_html'
  | 'parse_failed'
  | 'roundtrip_changed';

type MarkdownRichModeAnalysis =
  | {
      mode: 'rich';
      normalization: 'none';
      prefix: string;
      body: string;
    }
  | {
      mode: 'source';
      reason: MarkdownRichModeReason;
      preservation: 'byte_exact';
    };
```

`mode: rich` gilt nur, wenn der Codec den Body parsen kann und die erneute
Serialisierung **bytegleich** zum Body ist. Es gibt fuer Ticket 22 keine stille
"akzeptierte Normalisierung". Eine spaetere bewusst eingefuehrte
Normalisierung benoetigt einen benannten Profilwert, eigene Fixtures und
sichtbare Produktdokumentation.

Diese konservative Regel vermeidet einen komplexen Source-Map-/Minimal-Patch-
Serializer. Sie kann Rich Editing fuer nicht kanonisch formatiertes Markdown
reduzieren, bewahrt dafuer aber nachweisbar den Originaltext.

### 3. Preservation-Semantik pro Aktion

| Aktion | Erlaubter Diff |
| --- | --- |
| Preview/Rich/Source wechseln, fokussieren, scrollen | keiner; kompletter Datei-SHA bleibt identisch |
| Rich-Preflight scheitert | keiner; Source bleibt aktiv, Reason wird angezeigt |
| Body im Rich-Editor aendern | nur die fachlich geaenderte Markdown-Stelle und zwingend angrenzende kanonische Syntax; Front-Matter-Praefix bleibt bytegleich |
| Body im Source-Editor aendern | exakt der vom Nutzer erzeugte Source-Diff |
| Titel/Tags/Aliases im Properties-Panel aendern | nur der explizit geaenderte Property-Knoten plus zwingender lokaler YAML-Syntax; unbekannte Felder, Reihenfolge, Kommentare und Body bleiben unveraendert |
| Externe Aenderung/Revision-Konflikt | kein automatischer Write; Reload, sauberer Merge oder Konfliktkopie nach Nutzeraktion |
| Fehlgeschlagener Parse/Codec/Write | kein Teil-Commit; Originaldatei und letzter gespeicherter SHA bleiben erhalten |

Der Front-Matter-Praefix umfasst BOM, Opening-Delimiter, YAML-Rohtext,
Closing-Delimiter und die vorhandenen Leerzeilen vor dem Body. Body-Edits
duerfen diesen Bereich niemals ueber einen YAML-Serializer schicken.

### 4. Unsupported Content wird sicher und erklaerbar behandelt

Der Source-Modus zeigt eine nicht-blockierende, lokalisierte Warnung mit
Reason-Code und kurzer Erklaerung, zum Beispiel: "Diese Praesentation enthaelt
MARP-Direktiven oder Formatierung, die der visuelle Editor nicht verlustfrei
abbilden kann. Der Quelltext bleibt unveraendert." Der Rich-Schalter bleibt
deaktiviert; Preview, Source-Edit und Speichern funktionieren weiter.

Die Warnung zeigt niemals Dokumentinhalt oder YAML-Werte. Reason-Codes sind
stabil und koennen getestet bzw. telemetrisch gezaehlt werden; normale Logs
enthalten nur Pfad-Scope, Reason und Dauer, keine Source-Fragmente.

### 5. MARP-Erkennung verwendet dieselbe Dokumentgrenze

`app/lib/marp/detect.ts` soll fuer Front Matter auf
`parseCanvasMarkdownDocument` beziehungsweise eine darunter extrahierte
Boundary-Funktion aufsetzen. MARP-Erkennung liest den YAML-Map-Wert `marp`
ohne das Dokument neu zu serialisieren. Dateinamens- und Kommentar-Erkennung
bleiben erhalten. Serverrouten pruefen MARP weiterhin selbst; ein Client-Flag
ist keine Autoritaet fuer Preview oder Export.

Parsergrenzen bleiben verpflichtend: maximal 64 KiB Front Matter, begrenzte
Alias-Aufloesung, keine Ausfuehrung benutzerdefinierter YAML-Tags und keine
Source-Inhalte in Fehlerlogs.

### 6. Dirty-State basiert auf Inhaltsaenderung, nicht auf Ansicht

Der Store erhaelt einen idempotenten Update-Vertrag: Ist `content === draft`,
aendert sich kein State. Editor-Adapter melden nur echte Nutzer- oder explizite
Property-Aenderungen. Initiales Parsen, externes `setContent`, Moduswechsel und
fehlgeschlagene Kandidaten bleiben `isDirty=false`.

Vor dem Eintritt in Rich wird der exakte Source-Snapshot behalten. Scheitert
Initialisierung oder Validierung, bleibt bzw. wechselt die UI in Source und
verwendet denselben Snapshot. Ein Moduswechsel erzeugt keinen Undo-Schritt;
Editor-History darf durch externe Synchronisierung nicht verschmutzt werden.
Undo/Redo innerhalb eines Editors bleibt erhalten. Ob History ueber einen
Remount hinweg erhalten werden muss, wird in Phase 2 mit einem expliziten Test
entschieden; mindestens darf ein Wechsel keine Nutzeredit verlieren oder eine
scheinbare Konvertierung in die History einfuegen.

### 7. Collaboration folgt der bestehenden Representation-Policy

Der gemeinsame Preflight bestimmt vor der ersten Session, ob Markdown
`tiptap_xml` oder `plain_text` benoetigt. Der Server fuehrt dieselbe
Klassifikation fuer den gelesenen Anfangsinhalt aus und vertraut der vom Client
angeforderten Representation nicht blind.

Ein vorhandenes Collaboration-Dokument mit abweichender Representation wird
nicht lokal umgedeutet. Die Session liefert einen stabilen Konfliktcode und
die UI bleibt read-only/degraded mit Wiederherstellungshinweis. Eine echte
Migration nutzt ausschliesslich den vorhandenen serverseitigen, quieszenten
Representation-Migrationspfad mit gesundem Checkpoint; sie ist kein normaler
Rich-/Source-Schalter.

Front Matter bleibt bei `tiptap_xml` im vorhandenen separaten Y.Text. Derselbe
bytegenaue Prefix-Vertrag gilt fuer Browser-Updates, Agent-Preflight und
Datei-Checkpoint.

### 8. Saves pruefen bekannte Revisionen und ersetzen atomar

`expectedSha256` wird immer validiert, wenn der Aufrufer ihn mitsendet, auch
im Personal Workspace. Shared Workspaces verlangen ihn weiterhin mit 428.
Ein Mismatch bleibt 409 `FILE_REVISION_CONFLICT` und fuehrt in die bestehende
Reload/Merge/Copy-UI.

Der Server serialisiert Check + Write pro `(workspaceId, path)` innerhalb des
App-Prozesses; alle Canvas-internen Datei- und Checkpoint-Writer muessen diese
gemeinsame Critical-Section verwenden. Geschrieben wird in eine zufaellige Temp-Datei im Zielverzeichnis;
erst nach vollstaendigem Write, Rechteuebernahme und erfolgreichem Flush wird
sie atomar auf den Zielpfad umbenannt. Fehler entfernen die Temp-Datei und
lassen die alte Datei bestehen. Diese Critical-Section ersetzt keine
Kooperation externer Host-Prozesse; unmittelbar vor dem Rename wird deshalb
der erwartete Ausgangs-SHA erneut geprueft. Unkoordinierte externe Writer
werden zusaetzlich weiter ueber File Watcher und nachfolgenden SHA-Vergleich
sichtbar gemacht.

## Daten- und API-Vertraege

### Markdown-Dokumentvertrag

```ts
type LosslessMarkdownDocument = {
  original: string;
  prefix: string;       // byte-exaktes Front Matter inkl. Separator-Leerzeilen
  body: string;
  hasFrontmatter: boolean;
  frontmatterError: string | null;
  newline: 'lf' | 'crlf' | 'mixed' | 'none';
  hasBom: boolean;
};
```

Der Vertrag ist eine Analyseansicht und keine zweite gespeicherte Kopie. Das
Zusammensetzen von unveraendertem `prefix` und `body` muss immer wieder
`original` ergeben. Mixed Newlines werden nicht normalisiert und fuehren bei
nicht bytegleichem Codec-Preflight zu Source-only.

### Editor-Vertrag

- `MarkdownEditor.value` bleibt die autoritative Source aus dem Editor-Store.
- `onChange(nextValue)` bedeutet eine echte, vom Nutzer initiierte
  Inhaltsaenderung oder eine explizite Property-Aenderung.
- Ein optionales `onModeAnalysisChange` darf nur Status/Reason melden, keinen
  Inhalt.
- `FileEditor` muss fuer Preview und Editor denselben aktuellen `draft`
  verwenden; der View-Schalter ruft weder `updateDraft` noch `saveFile` auf.

### Write-API

Der Request von `POST /api/files/write` bleibt kompatibel:

```json
{
  "path": "slides/deck.md",
  "content": "<vollstaendiger Markdown-Text>",
  "expectedSha256": "<64 hex chars oder null>",
  "baseRevisionId": "<Revision-ID oder null>"
}
```

Verbindliche Responses:

- `200`: atomarer Ersatz abgeschlossen; Response enthaelt neuen SHA und
  Revision;
- `409 FILE_REVISION_CONFLICT`: vorhandener SHA oder `baseRevisionId` ist
  veraltet; keine Datei wurde ersetzt;
- `428 FILE_REVISION_REQUIRED`: bestehende Shared-Datei ohne erwartete
  Revision; keine Datei wurde ersetzt;
- `500`: atomarer Write/Flush/Rename ist **vor** dem Commit fehlgeschlagen;
  alter Zielinhalt bleibt erhalten, Temp-Datei wird bereinigt.

Fehler nach einem bereits erfolgreichen Rename duerfen nicht als scheinbar
fehlgeschlagener, gefahrlos wiederholbarer Write zurueckkommen. Der Service
muss Revision/Audit entweder innerhalb seines bestehenden konsistenten
Commitpfads abschliessen oder einen stabilen Fehler mit
`writeCommitted: true` und aktuellem SHA liefern. Der Client laedt dann den
Serverstand neu und wiederholt den Write nicht blind.

### Collaboration-Session

Bei `POST /api/files/collaboration/session` bleibt
`representation: plain_text | tiptap_xml` erhalten. Ergaenzt wird ein stabiler
Fehlervertrag fuer eine nicht passende oder unsichere Representation, zum
Beispiel:

```json
{
  "success": false,
  "code": "COLLABORATION_REPRESENTATION_CONFLICT",
  "requiredRepresentation": "plain_text",
  "reason": "roundtrip_changed"
}
```

Der Server gibt keine Source-Fragmente zurueck. Ein Client darf auf diesen
Fehler nicht mit einem stillen Whole-File-Autosave ausweichen.

## Geplante Dateiaenderungen

Voraussichtlich betroffen:

- `app/lib/markdown/obsidian-metadata.ts`: verlustfreier Dokumentvertrag und
  gezielte Property-Patches;
- `app/lib/markdown/rich-markdown-codec.ts` (neu): gemeinsame Extension-
  Konfiguration, Parse/Serialize und Rich-Preflight;
- `app/lib/marp/detect.ts`: gemeinsame Front-Matter-Grenze und YAML-basierte
  MARP-Erkennung;
- `app/components/editor/MarkdownEditor.tsx`: Preflight, sichere Moduswechsel,
  Warning-UI und Update-Origin;
- `app/components/editor/FileEditor.tsx` und `app/store/editor-store.ts`:
  idempotenter Dirty-/Autosave-Vertrag;
- `app/lib/collaboration/markdown-state.ts`,
  `app/lib/collaboration/session-service.ts` und ggf. Session-Route/-Client:
  gemeinsamer Codec und Representation-Guard;
- `app/lib/files/revision-guard.ts`, `app/lib/files/write-service.ts` und
  `app/lib/filesystem/workspace-files.ts`: SHA-Pruefung, Path-Serialisierung und
  atomarer Ersatz;
- `messages/de.json` und `messages/en.json`: Warnungen und Fehlertexte;
- `tests/fixtures/markdown-roundtrip/` sowie fokussierte Script-/Komponenten-
  und spaeter freigegebene E2E-Tests.

Eine Datenbankmigration ist nach aktueller Inventur nicht erforderlich.
Bestehende File-Revisions- und Collaboration-Tabellen bleiben unveraendert.

## Strikt sequenzielle Implementierungsphasen

### Phase 1: Fixture-Matrix und gemeinsamer Rich-Codec

- Byte-Fixtures fuer LF, CRLF, BOM, fehlende letzte Newline, Leerzeilen nach
  Front Matter und wiederholtes Umschalten anlegen.
- Front-Matter-Varianten aufnehmen: Kommentare, unbekannte MARP-Felder,
  Reihenfolge, Flow-/Block-Arrays, Quotes, Zahlen/Booleans, Block Scalars
  (`|`, `>`), Anchors/Aliases und verschachtelte Maps.
- Body-Varianten aufnehmen: MARP global/local directives, Folientrenner,
  HTML, Kommentare, Code-Fences mit `---`, Tabellen, Task Lists,
  verschachtelte Listen, harte Umbrueche, Escapes und Whitespace.
- Gemeinsame produktive Codec-Konfiguration extrahieren; Client und
  Collaboration-Server verwenden dieselben Nodes, Marks und Markdown-Optionen.
- `analyzeMarkdownRichMode` implementieren und fuer jede Fixture Rich-safe oder
  Source-only samt Reason pruefen.
- Bestehende semantische Tests beibehalten; neue Tests vergleichen zusaetzlich
  komplette Strings bzw. SHA-256.
- Verifikation: neuer Fixture-Test,
  `npm run test:editor:markdown`, `npm run test:markdown:obsidian` und
  `npm run build`.
- Commit: `Define lossless Markdown roundtrip contract`.

### Phase 2: Sichere Moduswechsel, Warnungen und Dirty-State

- `MarkdownEditor` vor Rich-Eintritt gegen den gemeinsamen Codec pruefen.
- Source-only-Reason lokalisiert und barrierearm anzeigen; deaktivierten
  Rich-Schalter mit demselben Grund erklaeren.
- View-/Moduswechsel so kapseln, dass sie weder `onChange` noch Store-Update
  ausloesen.
- `updateDraft` idempotent machen und Editor-Updates nach Origin trennen.
- Exakten Source-Snapshot bis zur erfolgreichen Rich-Initialisierung behalten;
  Parse-/Mountfehler fuehren ohne Draft-Diff zurueck in Source.
- Externe `setContent`-Synchronisierung ohne History-/Dirty-Eintrag anwenden;
  Undo/Redo und Remount-Verhalten mit einem Komponenten-Test festschreiben.
- JSDOM-/React-Test fuer Preview/Rich/Source-Zyklen ohne `onChange`, ohne
  Dirty-State und ohne Autosave-Planung ergaenzen.
- Verifikation: neue Komponenten-/Store-Tests, betroffene Editor-Tests und
  `npm run build`.
- Commit: `Guard Markdown editor mode switches`.

### Phase 3: Front-Matter- und Body-Preservation

- Body-Updates ausschliesslich mit dem unveraenderten Prefix des jeweils
  neuesten akzeptierten Drafts zusammensetzen.
- Race zwischen Property-Panel-Edit und TipTap-Update durch generation-/value-
  gebundene Updates verhindern; kein Callback darf einen aelteren Prefix
  wieder einsetzen.
- Property-Panel-Aenderungen als gezielte YAML-AST-/Source-Range-Patches
  ausfuehren. Breite Reformatierung bei komplexen Dokumenten ist verboten;
  falls ein Zielknoten nicht lokal sicher patchbar ist, wird auf Source
  verwiesen und nichts geaendert.
- YAML-Kommentare, unbekannte Keys, Reihenfolge, Arrays und mehrzeilige Werte
  mit Before/After-Fixtures bytegenau ausserhalb des Zielknotens pruefen.
- Wiederholte Rich-Edits duerfen keinen akkumulierten Whitespace-Diff erzeugen.
- Verifikation: Preservation-Fixtures,
  `npm run test:markdown:obsidian`, `npm run test:editor:markdown` und
  `npm run build`.
- Commit: `Preserve Markdown frontmatter and source formatting`.

### Phase 4: MARP-Erkennung und Collaboration-Representation

- MARP-Front-Matter-Erkennung auf die gemeinsame Dokumentgrenze umstellen und
  Dateiname, YAML-Wert und Kommentar-Direktive als getrennte, getestete
  Erkennungswege behalten.
- Rich-/Source-Klassifikation vor der ersten Collaboration-Session anwenden.
- Serverseitig `tiptap_xml` nur akzeptieren, wenn der aktuelle Dateiinhalt den
  bytegenauen Rich-Preflight besteht; ansonsten stabilen Representation-
  Konflikt liefern.
- Bestehende `tiptap_xml`-Checkpoints auf denselben Codec und exakten
  Front-Matter-Prefix pruefen. Kein lokaler Fallback auf `plain_text` und kein
  Whole-File-Autosave bei Collaboration-Fehlern.
- Test fuer initiales Source-only-MARP, bestehende falsche Representation,
  Checkpoint-Roundtrip, CRLF/BOM und fehlgeschlagene Migration ergaenzen.
- Verifikation: MARP-Detection-/Preview-Tests,
  `npm run test:files:collaboration`, `npm run test:editor:markdown` und
  `npm run build`.
- Commit: `Align Marp editing with collaboration representation`.

### Phase 5: Konfliktsichere atomare Saves

- Mitgesendeten `expectedSha256` in allen Workspace-Typen pruefen; nur die
  Pflicht zum Mitsenden bleibt Shared-Workspace-spezifisch.
- Serverweite per-Path-Critical-Section um initiale Revision-Pruefung,
  unmittelbar erneute Pre-Rename-Pruefung, atomaren Ersatz und neue Revision
  legen.
- Same-directory Temp-Write, Rechte, Flush, Rename und Fehler-Cleanup in einer
  kleinen Filesystem-Funktion kapseln; keine Temp-Datei ueber Workspace-
  Grenzen oder Symlink-Aufloesungen zulassen.
- Fehlerpfad testen: veralteter Personal-SHA, konkurrierende App-Saves,
  externe Aenderung vor Rename, simuliertes Write-/Rename-Versagen und
  unveraenderte Zieldatei nach jedem Fehler vor dem Commit. Ein separater Test
  fuer Fehler nach dem Rename muss `writeCommitted: true` und einen
  anschliessend eindeutig ladbaren Serverstand belegen.
- Bestehende Reload/Merge/Copy-UI und Shared-Workspace-428-Vertrag unveraendert
  weiterverwenden.
- Verifikation: Revision-/Write-Service-/Filesystem-Tests,
  `npm run test:file-watcher`, relevante Collaboration-Tests und
  `npm run build`.
- Commit: `Make Markdown saves atomic and revision safe`.

### Phase 6: Integrierte Abnahme und Dokumentation

- Fixture-Kette Preview -> Rich -> Source -> Preview mehrfach ausfuehren und
  gespeicherten SHA vor/nach dem Zyklus vergleichen.
- Einen erlaubten Rich-Body-Edit pro Rich-safe Fixture ausfuehren und den Diff
  gegen die Preservation-Matrix pruefen.
- Jede Source-only-Fixture auf Warnung, erhaltenen Source-Text und weiterhin
  funktionierende MARP-Preview pruefen.
- Manuelle Abnahme auf Desktop und responsiver Mobile-Web-Breite dokumentieren.
  Browser-/Playwright-E2E erst nach expliziter Nutzerfreigabe ausfuehren; bei
  Freigabe die vorhandene App auf `localhost:3000` verwenden und keinen zweiten
  Dev-Server starten.
- `npm run build` als finales Gate ausfuehren; kein Container-Build fuer dieses
  Ticket, sofern er nicht separat angefordert wird.
- Ticket und Tracker erst nach vollstaendiger Abnahme auf erledigt setzen.
- Commit: `Document lossless Marp editor acceptance`.

## Automatisierte Abnahmekriterien

1. Jede Fixture erfuellt
   `compose(split(original)) === original` inklusive BOM, Newlines und finaler
   Newline.
2. Fuer jede als Rich-safe klassifizierte Fixture gilt
   `serialize(parse(body)) === body`; der Test verwendet dieselbe Extension-
   Factory wie der produktive Editor und Collaboration-Checkpoint.
3. Jede nicht bytegleich roundtrippende Fixture wird Source-only mit stabilem
   Reason-Code; der Originaltext bleibt unveraendert.
4. Mindestens drei komplette Preview/Rich/Source-Zyklen ohne Edit erzeugen
   keinen `onChange`, keinen Dirty-State, keinen Autosave und keinen SHA-Diff.
5. Ein Rich-Body-Edit behaelt den Front-Matter-Prefix bytegleich. Unbekannte
   YAML-Felder, Kommentare, Reihenfolge, Arrays und Block Scalars bleiben
   erhalten.
6. Eine gezielte Property-Aenderung veraendert keinen Body und keine
   unbeteiligten YAML-Knoten; unsicher patchbare Properties werden abgelehnt,
   nicht breit reserialisiert.
7. Unsupported MARP-Direktiven, HTML und Obsidian-Syntax zeigen eine Warnung,
   bleiben im Source erhalten und rendern weiterhin in der Preview.
8. Fehlgeschlagene Konvertierung oder Rich-Initialisierung laesst Draft,
   Dirty-State, Undo-Ausgang und gespeicherte Datei unveraendert.
9. `tiptap_xml` wird serverseitig fuer Source-only-Inhalt abgelehnt; der Client
   faellt nicht auf Whole-File-Autosave zurueck.
10. Veraltete mitgesendete SHA-Werte liefern in Personal- und Shared-
    Workspaces 409; fehlender erforderlicher Shared-SHA liefert 428.
11. Simulierte Write-, Flush- und Rename-Fehler vor dem Commit lassen den alten
    Dateiinhalt vollstaendig erhalten und keine verwaiste Temp-Datei zurueck;
    ein Fehler nach dem Commit wird als committed ausgewiesen und nicht blind
    wiederholt.
12. Alle betroffenen fokussierten Tests, Collaboration-Tests und
    `npm run build` sind gruen.

## Manuelle Abnahmekriterien

- Eine realistische MARP-Datei mit komplexem YAML oeffnen, mehrfach zwischen
  Slides, Rich (falls freigegeben) und Source wechseln, schliessen und erneut
  oeffnen. Ohne Edit bleibt der Datei-SHA identisch und der Header zeigt nie
  "ungespeicherte Aenderungen".
- Bei einer Rich-safe-Datei genau einen Absatz aendern. Der sichtbare
  Source-Diff enthaelt nur diese Aenderung; Front Matter und andere Slides sind
  unveraendert.
- Eine Datei mit lokalen MARP-Kommentardirektiven, Raw HTML und absichtlich
  nicht kanonischem Whitespace oeffnen. Rich ist erklaert deaktiviert, Source
  und Preview funktionieren, kein automatischer Rewrite findet statt.
- Titel oder Tags einer einfachen Property gezielt aendern. Kommentare,
  unbekannte Keys, Reihenfolge, Arrays und mehrzeilige Werte visuell und im
  Diff pruefen.
- Dieselbe Datei parallel extern aendern und danach lokal speichern. Autosave
  stoppt, die Konfliktleiste erscheint, und ohne explizite Aktion wird keine
  Version ueberschrieben.
- Einen simulierten Save-Fehler ausloesen. Nach Reload ist entweder die alte
  vollstaendige Datei oder der neue vollstaendige Commit vorhanden, niemals
  ein Teilinhalt.

## Risiken, Migration und Rollback

| Risiko | Gegenmassnahme |
| --- | --- |
| Konservativer Preflight reduziert Rich-Verfuegbarkeit | Source und Preview bleiben voll funktionsfaehig; Reason wird erklaert; Rich-Freigabe wird fixturebasiert erweitert statt pauschal gelockert. |
| Client- und Server-Codec driften auseinander | Eine gemeinsame Extension-/Codec-Factory und ein Paritaetstest sind Pflicht. |
| Property-Patch trifft komplexe YAML-Syntax falsch | AST-Ranges validieren, Ergebnis erneut parsen, unveraenderte Bereiche vergleichen; bei Unsicherheit ohne Mutation abbrechen. |
| Aelteres `tiptap_xml`-Dokument ist fuer Source-only-Inhalt gebunden | Kein automatischer Wechsel; sichtbarer Konflikt und vorhandener quieszenter Migrationspfad mit Checkpoint. |
| Atomarer Rename verhaelt sich plattformspezifisch | Same-directory-Tests auf unterstuetzten Plattformen; alter Inhalt muss bei jedem Fehler erhalten bleiben. |
| Externer Prozess schreibt ausserhalb der App-Critical-Section | SHA unmittelbar vor Commit erneut pruefen, Watcher-Konflikt erhalten und Limitierung dokumentieren; kein behaupteter globaler Lock. |
| Neue Dirty-Origin-Logik unterdrueckt echte Edits | Komponenten- und Store-Tests fuer Tippen, Property-Edit, Paste, Undo, externe Synchronisierung und schnellen Folgesave. |

Es ist keine Datenmigration vorgesehen. Bereits gespeicherte Markdown-Dateien
werden nicht vorab normalisiert oder umgeschrieben. Rollout ist dadurch
konservativ: Unsichere Dokumente wechseln lediglich in Source-only.

Rollback erfolgt commitweise in umgekehrter Phasenreihenfolge. Vor allem die
Codec-/Preservation-Fixtures bleiben auch bei einem UI-Rollback bestehen. Ein
Rollback darf keine neue Normalisierung ueber Bestandsdateien laufen lassen.
Falls der atomare Write-Pfad separat zurueckgenommen werden muss, bleiben die
strengere SHA-Pruefung und ihre Konflikttests nach Moeglichkeit aktiv; es gibt
keine Schema- oder Datenmigration zurueckzusetzen.

## Definition of Done

Ticket 22 ist erst abgeschlossen, wenn alle automatisierten Kriterien erfuellt
sind, die manuelle Abnahme dokumentiert ist, `npm run build` erfolgreich war
und ein no-edit Roundtrip fuer jede Referenzdatei denselben SHA-256 liefert.
"Semantisch gleich" allein reicht fuer den no-edit-Fall nicht. Jeder erlaubte
Diff nach einem Nutzeredit ist anhand der Preservation-Matrix erklaerbar und
enthalt weder verlorenes Front Matter noch unerwartete Formatierungs- oder
Whitespace-Aenderungen.
