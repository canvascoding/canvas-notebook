# Editierbarer Markdown-Quelltext für Live-Dokumente

Stand: 2026-10-08. Analyse und Umsetzungsvorschlag; noch keine Änderung am Produktcode.
Branch: `codex/markdown-source-roundtrip-plan`.

## Problem und belegte Ursache

Gewünschter Ablauf: Dokument anlegen, Quelltext öffnen, vorhandenes Markdown einfügen, anschließend formatiert weiterarbeiten. Der Nutzer bestätigt, dass die Eingabe im Quelltext gesperrt ist bzw. nicht reagiert.

Die Sperre ist im aktuellen Code ausdrücklich vorgesehen:

- `app/components/editor/MarkdownEditor.tsx:5892` setzt `richSourceReadOnly` bei einer kollaborativen `tiptap_xml`- oder `tiptap_blocks`-Repräsentation. In Zeilen 6033–6050 wird der Quelltext schreibgeschützt und ohne schreibende Collaboration-Anbindung angezeigt.
- `app/lib/collaboration/document-state-service.ts:38` wählt für verlustfrei darstellbares Markdown, einschließlich leerer Dokumente, die Rich-Repräsentation. `app/lib/collaboration/session-service.ts:184` verwendet bei aktuellen Clients `tiptap_blocks`.
- `app/components/editor/MarkdownDocumentModes.tsx:26` erzeugt den angezeigten Quelltext aus der strukturierten Yjs-Quelle. Das ist eine abgeleitete Ansicht, kein zweiter gemeinsam bearbeiteter Quelltext.
- Der schreibende Texteditor verwendet dagegen `Y.Text('content')` (`app/components/editor/CodeEditor.tsx:404`). Das ist der Speicher für `plain_text`, nicht der Inhalt eines Rich-Dokuments.
- `tests/editor-empty-quote.spec.ts:175` erwartet nach der Rich-Migration ausdrücklich `contenteditable=false` im Quelltextmodus. `messages/de.json:936` erklärt den bisherigen Vertrag: Änderungen nur unter „Bearbeiten“.

Damit erklärt die Repräsentationsentscheidung das gemeldete Symptom. Ein fehlerhafter Roundtrip beim Einfügen ist für diese Eingabesperre nicht erforderlich: Die Eingabe wird bereits vorher verhindert. Die Roundtrip-Prüfung bleibt für die spätere sichere Übernahme relevant. Auch Einzelnutzer-Dokumente verwenden diesen Collaboration-Pfad.

## Alternative A: Tiptap behalten und die Darstellung umschalten

Ergänzung auf Nutzerwunsch: Zuerst prüfen, ob ein interaktiver, textorientierter Darstellungsmodus im selben Tiptap-Editor den gewünschten Ablauf besser löst. Die Entscheidung für einen separaten Quelltextentwurf ist noch nicht getroffen.

Heute wird tatsächlich der Editor gewechselt: `MarkdownEditor` rendert in Source `SourceMarkdownEditor` → `CodeEditor`/CodeMirror, in Rich dagegen `RichMarkdownEditor`/Tiptap. Die beiden bedingten React-Zweige erhalten nicht dieselbe Editor-Instanz. Der Yjs-Dokumentbesitzer ist bereits geteilt; eine gemeinsame interaktive Ansicht wäre eine Änderung der Präsentation und der Eingabeverarbeitung.

Passende Ansatzpunkte existieren bereits: Die Mermaid-NodeView schaltet zwischen Diagramm und editierbarem Code um (`MarkdownEditor.tsx:1660`), und das Blocktree-Binding schreibt bei unverändertem Dokumentinhalt nicht nach Yjs (`block-tree-editor.ts:90`). Dagegen bietet die installierte Markdown-Extension zwar Markdown-Kommandos, aber keinen Clipboard-Handler für den Import vollständiger Markdown-Dokumente. `createCanvasMarkdownExtension` konfiguriert Parser/Serializer; der `handlePaste` in `MarkdownEditor.tsx:1078` behandelt lediglich interne Block-Drag-Daten. Der Markdown-Einfügepfad ist daher ein eigenständiger Teil der Lösung.

Vorgeschlagene Umsetzung für diese Alternative:

- Tiptap und die bestehende Yjs-Anbindung über beide Darstellungen hinweg gemountet lassen. Der Wechsel ändert ausschließlich einen lokalen Präsentationszustand, nicht Dokument, Schema, Repräsentation oder Collaboration-Sitzung.
- Über Typografie, Decorations und gezielte NodeViews eine schlichte, quelltextähnliche Ansicht anbieten: gleichmäßige Schriftgrößen, reduzierte Blockdarstellung, gegebenenfalls sichtbare Markdown-Markierungen. Bestehende strukturierte Textänderungen, Cursor und Undo bleiben an derselben Dokumentinstanz.
- Den ursprünglichen Einfügefall direkt lösen: eine eindeutige Aktion „Als Markdown einfügen“ im aktiven Tiptap-Editor, die Markdown mit dem vorhandenen Canvas-Parser validiert und als strukturierte Transaktion an der aktuellen Auswahl einfügt. Der installierte `@tiptap/markdown`-Stand bietet dafür `insertContent`/`insertContentAt` mit `contentType: 'markdown'`. Für den vollständigen Dokumentimport Frontmatter gesondert behandeln; mitten im Dokument darf eingefügtes YAML nicht versehentlich die Dokumenteigenschaften ersetzen.
- Clipboard-HTML, reinen Markdown-Text, normale Texte, URLs, Bilder und Einfügen innerhalb eines Codeblocks unterscheiden. Eine bloße Änderung der Schrift aktiviert noch keine Markdown-Paste-Verarbeitung. Bestehende URL-/Bild-Aktionen und Rich-HTML-Paste dürfen nicht versehentlich übernommen oder doppelt ausgeführt werden.
- Beim Einfügen nur den eingefügten Inhalt parsen; beim Wechsel der Darstellung keine vollständige Serialisierung und erneute `setContent`-Initialisierung. Eine Paste-Aktion soll eine Undo-Einheit bilden und parallel bearbeitete Blöcke erhalten.

Die Grenze dieser Alternative ist konkret: Im Rich-Modell ist eine Überschrift ein Knoten mit `level`, Fettdruck eine Markierung und ein Codeblock ein Knoten mit Sprache. Die Zeichen `#`, `**` oder Codezäune werden beim Markdown-Export erzeugt. Visuell eingeblendete Zeichen haben zunächst keine eigenen editierbaren Dokumentpositionen. Sie können daher nicht allein durch CSS wie echter Quelltext markiert, gelöscht oder in ungültigen Zwischenständen bearbeitet werden. Eine solche Ansicht darf nicht ohne diesen Unterschied als exakter Quelltexteditor bezeichnet werden.

Soll auch das direkte Bearbeiten dieser Syntaxzeichen möglich sein, ist zusätzlich eine Zuordnung von Syntaxänderungen zu strukturierten Transaktionen nötig, eventuell mit kleinen Entwürfen pro Block. Das ist eine weitere technische Variante und muss insbesondere bei Tabellen, verschachtelten Listen, Frontmatter und blockübergreifenden Markierungen separat bewiesen werden. Gleiche Tiptap-Komponente mit einem neuen reinen Textschema wäre dagegen ein Wechsel des Dokumentmodells und erfüllt die gewünschte reine Darstellungsänderung nicht.

Grundlage: aktueller Canvas-Code und installierte Tiptap-Version 3.31.0; die offiziellen Dokumentationen bestätigen [Markdown-Einfügen](https://tiptap.dev/docs/editor/markdown/api/editor) und [eigene interaktive NodeViews](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views). Die Einschätzung zur vollständigen Quelltextbearbeitung folgt aus dem hier verwendeten Schema; ein fertiger Umschalter für diesen Anwendungsfall wurde in der eingebundenen Implementierung nicht gefunden.

## Alternative B: Exakter Quelltextentwurf mit geprüfter Übernahme

Diese Variante bleibt für echte Quelltextbearbeitung einschließlich beliebiger Zwischenstände erhalten. Sie wird erst nach dem Vergleich mit Alternative A ausgewählt oder gezielt als Ergänzung verwendet.

1. „Quelltext“ öffnet für Nutzer mit Schreibrecht einen editierbaren Entwurf. Einfügen und Tippen erhalten zunächst den exakten Text.
2. Bei Änderungen erscheinen „Übernehmen“ und „Verwerfen“. „Übernehmen“ aktualisiert das vorhandene Live-Dokument; danach ist der Wechsel zu „Bearbeiten“ oder „Lesen“ möglich. Ein Moduswechsel darf einen ungeprüften Entwurf nicht unbemerkt verwerfen oder als gespeichert darstellen.
3. Sichere Formatnormalisierungen werden vor der Übernahme ausdrücklich angeboten. Nicht verlustfrei darstellbares Markdown bleibt im Entwurf erhalten, mit konkreter Erklärung und einer Möglichkeit, eine separate Markdown-Datei mit dem exakten Inhalt anzulegen.
4. Wenn sich das Live-Dokument zwischenzeitlich geändert hat, bleibt der Entwurf erhalten und die Übernahme meldet einen Konflikt. Ein veralteter kompletter Quelltext darf keine fremden Änderungen überschreiben.

Bestehende `plain_text`-Dokumente behalten ihre direkte kollaborative Textbearbeitung. Die neue Entwurfs-/Übernahmefunktion ergänzt den bislang gesperrten Rich-Fall. Schreibgeschützte Freigaben bleiben schreibgeschützt.

## Umsetzung in abgeschlossenen Schritten

### 1. Verhalten festschreiben und Tiptap-Alternative zuerst prüfen

- Den Fall „neues leeres Markdown-Dokument → Quelltext → vollständiges Markdown einfügen“ als Regression ergänzen.
- Bestehende Erwartungen an absichtlich schreibgeschützten Rich-Quelltext an den neuen Vertrag anpassen; echte fehlende Schreibrechte weiterhin prüfen.
- Dokumentidentität, Lebenszyklus, Ausgangsinhalt und Revision des Entwurfs explizit modellieren.
- Einen begrenzten Tiptap-Prototyp für Überschrift, Fettdruck, Liste und Codeblock planen: Darstellungswechsel ohne neue Editor-/Yjs-Instanz, vollständiges Markdown-Paste, Fortsetzen der Bearbeitung, gemeinsames Undo und ein parallel schreibender Client.
- Danach die Entscheidung festhalten: Reicht die interaktive Textdarstellung plus korrektes Markdown-Paste für den gewünschten Alltag, Alternative A ausarbeiten. Werden direkt editierbare Syntaxzeichen und exakte beliebige Quelltextstände benötigt, die Grenze zeigen und Alternative B oder einen begrenzten Blockentwurf wählen. Nicht beide vollständigen Architekturen vorsorglich bauen.

Abnahme: Die Regression unterscheidet die derzeitige Produktsperre von Berechtigungs-, Verbindungs- und Roundtrip-Fehlern. Für Alternative A sind gleiche Editor-/Yjs-Identität, funktionierendes Paste und Undo konkret nachgewiesen. Die Entscheidung erfolgt vor einem größeren Umbau.

Die folgenden Schritte 2–4 beschreiben den bereits untersuchten Übernahmepfad für Alternative B, falls sie benötigt wird. Bei Auswahl von A wird stattdessen deren Präsentations-/Paste-Pfad oben umgesetzt und mit Schritt 5 abgenommen.

### 2. Vorhandenen sicheren Übernahmepfad wiederverwenden

`app/lib/mobile/notebook.ts:403` enthält mit `saveMobileCollaborativeNotebookDocument` bereits einen geeigneten Ablauf: Inhalts-Hash und Revision prüfen, den aktuellen Yjs-Zustand klonen, Änderung vorbereiten und validieren, einen wiederholbaren Änderungsauftrag speichern, den unveränderten Ausgangszustand vor der Live-Übernahme erneut prüfen und Yjs-Persistenz bestätigen.

- Nur die gemeinsamen technischen Teile für Desktop und Mobile extrahieren. Authentifizierung, Workspace-/Dokumentrechte und produktspezifische Fehlerzuordnung bleiben an den jeweiligen API-Grenzen.
- `replaceRichMarkdownInYDoc` in `app/lib/collaboration/markdown-state.ts:79` wiederverwenden: vorhandene Block-Identitäten und Textfragmente werden soweit zuordenbar erhalten; es entsteht keine konkurrierende `content`-Wahrheit.
- Desktop-Auftrag an Workspace, Dokument-ID, Lebenszyklus, Ausgangsinhalt/-zustand und Idempotenzschlüssel binden. Netzwerk-Retries dürfen dieselbe Änderung nicht zweimal anwenden. Erfolg erst nach bestätigter dauerhafter Übernahme melden; ausstehende Datei-Projektion getrennt darstellen.
- Vorhandene Mobile-Verträge nach der Extraktion unverändert prüfen. Die bisherige Ausnahme für einen entfernten abschließenden Zeilenumbruch (`notebook.ts:458`) nicht unbemerkt als Desktop-Vertrag übernehmen: Desktop verlangt exakte Erhaltung oder eine bestätigte Normalisierung.
- Kein gewöhnliches Ganzdatei-Schreiben neben einer aktiven Yjs-Sitzung und keine automatische Rich→Plain-Migration.

Abnahme: Übernahme, Konflikte, Wiederholungen und Fehler nach vorbereiteter Änderung sind ohne Datenverlust nachweisbar.

### 3. Quelltextentwurf an die Oberfläche anbinden

- Den vorhandenen lokalen Markdown-Dokumentkern für den Entwurf nutzen, vom Live-Dokument getrennt und nach Dokument/Lebenszyklus isoliert.
- Entfernte Updates dürfen einen aktiven Entwurf nicht über `externalValueSync='always'` ersetzen. Solche Updates markieren eine veraltete Basis und bleiben für einen späteren Vergleich verfügbar.
- Nach bestätigter Server-Übernahme Entwurf und Übernahmebeleg behalten, bis auch das lokale Yjs-Dokument die bestätigte Änderung enthält. Eigene bestätigte Updates anhand des Auftrags zuordnen; sie dürfen weder als fremder Konflikt erscheinen noch den Quelltext vorübergehend auf eine ältere Projektion zurücksetzen.
- Entwurf beim Moduswechsel erhalten. Beim Schließen/Wechseln eine verlustfreie Wiederherstellung oder eine ausdrückliche Verwerfentscheidung gewährleisten.
- Schreibrechte und tatsächliche Synchronisationsprobleme weiterhin berücksichtigen; ein vorübergehender Übernahmefehler darf den eingefügten Text nicht löschen.
- „Übernehmen“, „Verwerfen“, ausstehende Übernahme und Konflikt verständlich anzeigen. Quelltext wird nicht auf jedem Tastendruck erneut in Rich-Inhalt geschrieben.
- Undo/Redo ausdrücklich implementieren: Entwurfshistorie und übernommene Dokumentänderung unterscheiden. Server-Änderungen landen derzeit nicht automatisch in der lokalen `BlockTreeHistory`, die registrierte lokale Origins verfolgt (`block-tree-history.ts:38`). Eine übernommene Quelltextänderung muss gezielt rückgängig gemacht werden können, ohne spätere Änderungen anderer Nutzer zu überschreiben.

Abnahme: Einfügen funktioniert im neuen Dokument und der Text bleibt bei Fehlern, Moduswechseln und Konflikten verfügbar.

### 4. Roundtrip und nicht unterstützte Syntax behandeln

- Den vorhandenen Codec und `analyzeMarkdownRichMode` benutzen, ohne seine Sicherheitsprüfungen pauschal zu lockern.
- Exakt darstellbar: übernehmen. Sicher normalisierbar: Änderung erklären und bestätigen lassen. Verlustbehaftet/ungültig: Entwurf erhalten und Ursache benennen.
- Für die separate Markdown-Datei den vollständigen Inhalt vor der ersten Collaboration-Sitzung speichern; damit kann die bestehende Repräsentationsauswahl verlustbehaftete Rich-Konvertierung vermeiden. Der Nutzer wählt diese Datei ausdrücklich.
- YAML, Listen, Tabellen, Codeblöcke, Links, Bilder, Unicode, CRLF/LF, abschließende und mehrfache Leerzeilen sowie nicht unterstützte HTML-/Markdown-Syntax abdecken.

Abnahme: Kein stiller Format- oder Inhaltsverlust; eine abgelehnte Rich-Übernahme lässt den Originaltext vollständig zugänglich.

### 5. Integration und UI abnehmen

- Fokussierte Tests für lokalen Entwurf, Codec, gemeinsame Übernahme und bestehende Mobile-Speicherung ausführen; passende Lint-/Typprüfungen und `npm run build` ergänzen.
- Browser-Abnahme nach ausdrücklicher Freigabe gemäß `AGENTS.md`: neues Dokument anlegen, Markdown einfügen, übernehmen, Lesen/Bearbeiten/Quelltext wechseln und nach Neuladen prüfen.
- Zusätzlich zwei Clients, Änderung der Basis während einer Übernahme, verlorene Antwort mit Wiederholung, Antwort vor/nach WebSocket-Update, ausstehende lokale Rich-Änderungen, Verbindungsabbruch, Undo/Redo sowie schreibgeschützte Freigabe prüfen. Scroll-/Cursorposition beim Moduswechsel und lokale Markdown-Felder dürfen nicht regressieren.
- Für Alternative A zusätzlich nachweisen: Darstellungswechsel erzeugt keine Dokumentänderung und keine neue Sitzung/History; markierte Syntax besitzt verständliches Cursor-/Kopierverhalten; Markdown-Paste an Auswahl und in leeres Dokument funktioniert, während Codeblock-/URL-/HTML-/Bild-Paste unverändert sinnvoll bleibt. Originaltext bei abgelehnter Konvertierung zugänglich halten.
- Für ein erforderliches lokales App-Setup ausschließlich den Skill `canvas-local-team-seat-dev` verwenden. Containerbau bleibt eine separate ausdrückliche Freigabe.
- Schritte nacheinander abschließen und sinnvoll getrennt committen; vor jedem Commit GitNexus `detect_changes` und den tatsächlichen Diff prüfen.

Abnahme: Der vollständige gewünschte Einfügeablauf funktioniert mit bestätigter Persistenz und ohne Überschreiben paralleler Bearbeitung.

## Lokaler produktionsnaher Stack

Der vom Nutzer erwähnte Skill ist im verfügbaren Katalog `canvas-local-team-seat-dev` („Run local Canvas production stack“); seine Anleitung wurde gelesen. Er definiert Notebook, Control Plane und PostgreSQL/pgvector als einen verwalteten Stack, einschließlich zweier Nutzer für den gemeinsamen Test-Workspace. Damit eignet er sich gerade für die Zwei-Client-Abnahme beider Alternativen.

Vor einer späteren Ausführung: beide Repository-Anleitungen und die Skill-Workflowreferenz lesen, vorhandene Listener/Container prüfen, nur diesen einen Stack verwenden und den gewählten Branch als Notebook-Quelle vorbereiten. Der dokumentierte Notebook-Container liegt auf `127.0.0.1:3100`; dies ist eine Skill-Vorgabe, kein in dieser Analyse verifizierter Laufzustand. Bei ausdrücklich freigegebenem Containerbau zuerst den Host-Produktionsbuild ausführen und anschließend den Notebook-Container aus aktuellem Stand neu erstellen (`start-local.sh --target notebook`). Login-Daten aus der privaten lokalen Konfiguration verwenden und nicht in Artefakte schreiben. Browserautomation benötigt weiterhin die ausdrückliche Freigabe laut `AGENTS.md` und Skill.

## Wirkungsbereich und Analysegrenzen

Der aktuelle Worktree hat keinen eigenen GitNexus-Index. Zur Navigation wurde der ältere Index des Haupt-Checkouts benutzt; alle entscheidenden Aussagen wurden am aktuellen Quellcode geprüft. Vor einer Implementierung ist der Index für diesen Branch zu aktualisieren und die Impact-Analyse für die tatsächlich zu ändernden Symbole erneut durchzuführen.

Die vorhandene Impact-Analyse meldet `CRITICAL` für den gemeinsamen Editor-Einstieg (7 direkte Aufrufer, 23 betroffene Symbole; unter anderem Datei-Editor, Markdown-Felder, öffentliche Vorschau und Einstellungen) und für `analyzeMarkdownRichMode` (15 direkte Aufrufer, 34 Symbole bei Tiefe 2; unter anderem Sitzungswahl und Migration). Diese Zahlen sind ein Hinweis auf den gemeinsamen Wirkungsbereich, keine aktuelle Vollständigkeitsgarantie. Der erste Schritt soll deshalb die kollaborative Rich-Quelltextbearbeitung gezielt ergänzen.

Während dieser Analyse ausgeführt: bestehende lokale Source-Binding-Tests 5/5 und Dokument-/Owner-Tests 22/22 erfolgreich. Zusätzliche isolierte Einfügeversuche in ein leeres lokales Dokument erhielten normales Markdown, normalisierbare Tabellen, nicht unterstütztes HTML und zusätzliche Leerzeilen exakt; Undo/Redo funktionierte. Ausführung gegen den aktuellen Quellcode mit vorhandenen, zur Lockdatei passenden Abhängigkeiten des Haupt-Checkouts, ohne Installation in diesem Worktree.

Nicht ausgeführt: Browser-/App-E2E, vollständiger Build, laufende Server-/Yjs-Integration. Es wurde kein Container gebaut oder gestartet und kein Produktcode geändert. Die Tests belegen den lokalen Entwurfsbaustein; die Diagnose der Rich-Quelltextsperre ist durch aktuellen Code und die vorhandene E2E-Erwartung belegt.
