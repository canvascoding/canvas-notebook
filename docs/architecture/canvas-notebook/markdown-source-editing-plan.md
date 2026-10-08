# Markdown einfügen und verfügbare Bearbeitungsmodi

Stand: 2026-10-08. Entschiedener Umsetzungsvorschlag nach Codeprüfung und Plugin-Recherche; Produktcode noch unverändert.
Branch: `codex/markdown-source-roundtrip-plan`.

## Empfehlung

Den vorhandenen Rich-Editor um die Aktion **„Markdown einfügen …“** erweitern. Bei strukturierten Live-Dokumenten den nicht bearbeitbaren **Quelltextmodus ausblenden und gegen Aufrufe absichern**. Funktionierende Quelltextbearbeitung für textbasierte Dokumente und lokale Markdown-Felder erhalten.

Der gewünschte Ablauf lautet: Dokument anlegen → unter „Bearbeiten“ das vorhandene Einfügen-Menü öffnen → „Markdown einfügen …“ → Text hineinkopieren → „Einfügen“. Danach direkt im formatierten Dokument weiterarbeiten. Die Änderung verwendet dieselbe Tiptap-Instanz, dieselbe Yjs-Sitzung und die vorhandene Speicherung.

Die erste Version benötigt eine kleine Einfügeoberfläche, eine native Editor-Aktion und eine konsistente Regel für die angebotenen Modi. Eine zusätzliche quelltextähnliche Tiptap-Darstellung, ein kompletter Source-Entwurf mit eigener Übernahme-API, neue Repräsentationen und die Extraktion des mobilen Speicherpfads gehören nicht zu dieser Lösung.

## Belegte Ursache und vorhandene Bausteine

- `app/components/editor/MarkdownEditor.tsx:5892` setzt `richSourceReadOnly` für kollaborative `tiptap_xml`-/`tiptap_blocks`-Dokumente. Zeilen 6033–6050 zeigen dort nur einen schreibgeschützten Export ohne schreibende Source-Bindung.
- Leere neue Markdown-Dokumente werden als Rich-Dokument initialisiert: `app/lib/collaboration/document-state-service.ts:38` und `app/lib/collaboration/session-service.ts:184`. Das gilt auch für einen einzelnen Bearbeiter.
- Source verwendet CodeMirror; Rich verwendet Tiptap. Schreibbares CodeMirror bearbeitet `Y.Text('content')` (`CodeEditor.tsx:404`), während Rich-Dokumente strukturierte Blöcke besitzen. Die aktuelle Sperre verhindert daher einen falschen zweiten Schreibpfad. Sie erklärt das gemeldete Verhalten bereits vor jedem Paste-Roundtrip.
- `MarkdownDocumentModes.tsx:92` bietet den Source-Reiter dennoch immer an. Desktop- und Mobile-Toolbar verbergen ihre Source-Aktionen bei Collaboration bereits (`MarkdownEditor.tsx:5511`, `:5550`). Die Gastansicht besitzt zusätzlich eine eigene schreibgeschützte Rich-Source-Anzeige (`GuestMarkdownEditor.tsx:80`).
- Canvas verwendet bereits `@tiptap/markdown` mit dem eigenen Parser (`app/lib/markdown/core/canvas-marked.ts`). Die installierte Version 3.31.0 unterstützt `insertContent` und `insertContentAt` mit Markdown-Inhalt. Die offiziellen [Markdown-Beispiele](https://tiptap.dev/docs/editor/markdown/examples) beschreiben auch eine eigene Paste-Extension; es ist kein zusätzlicher Dienst nötig.
- Der bestehende URL-Paste-Dialog (`MarkdownUrlPaste.tsx:18`) und native HTML-/Block-/Bild-/Code-Eingaben haben eigene Regeln. Eine globale automatische Markdown-Erkennung würde zusätzliche Überschneidungen und Heuristiken benötigen. Die gezielte Einfügeaktion hält den ersten Umfang klar.
- Das ältere [Community-Paket tiptap-markdown](https://github.com/aguingand/tiptap-markdown) bietet `transformPastedText`, sein Maintainer empfiehlt aber das offizielle Paket und plant keine weitere Bearbeitung bestehender Issues/PRs. Ein zusätzliches Paket bringt hier keinen belegten Vorteil.

## 1. Nicht nutzbaren Quelltextmodus ausblenden

Eine kleine gemeinsame Regel verwenden: Quelltext wird unterstützt, wenn der Editor lokal arbeitet oder die bestätigte Collaboration-Repräsentation `plain_text` ist. `tiptap_xml` und `tiptap_blocks` bieten Lesen/Bearbeiten an. Eine noch unbekannte Collaboration-Repräsentation bietet keinen Source-Wechsel an.

| Oberfläche/Zustand | Geplantes Verhalten |
| --- | --- |
| Rich-Live-Dokument | Quelltext-Reiter und alle Wechselaktionen ausgeblendet |
| Textbasiertes Live-Dokument | Quelltext bleibt verfügbar und bei Schreibrecht editierbar |
| Lokales Markdown-Feld, zum Beispiel ein Prompt | Funktionierende lokale Quelltextbearbeitung bleibt erhalten |
| Gastansicht | Gleiche Regel anhand der Session-Repräsentation |
| Übergebener oder nach Migration verbliebener Source-Modus bei Rich | Unmittelbar sicher auf „Lesen“ zurückfallen und Auswahlzustand konsistent halten |
| Fehlende Schreibrechte oder vorübergehende Synchronisationsprobleme | Vorhandene Schreibsperren bleiben wirksam; Verfügbarkeit der Darstellung und Schreibrechte getrennt behandeln |

`MarkdownModeBar` erhält die tatsächliche Source-Verfügbarkeit. Zusätzlich die Umschaltfunktion und die Auflösung des effektiven Modus absichern; einen verborgenen Modus nicht im Hintergrund über Props/Callbacks erreichbar lassen. Der Fallback auf Lesen löst keine versehentliche Rich-Migration aus. Die Verfügbarkeit nicht an `connection === 'live'` koppeln: Offline-Bearbeitung ist ein eigener bestehender Vertrag.

Betroffene Stellen: `MarkdownDocumentModes.tsx`, `MarkdownEditor.tsx`, `GuestMarkdownEditor.tsx`. `FileEditor` speichert keinen Source-Modus; sein Markdown-/Slides-Schalter ist davon unabhängig. `MarkdownField` ist ein lokaler controlled Caller und darf seine Source-Funktion behalten.

Abnahme: Ein neues Rich-Dokument zeigt keine nutzlose Source-Schaltfläche; ein echtes Quelldokument bleibt bearbeitbar. Ein erzwungener nicht unterstützter Modus verändert weder Inhalt noch Yjs-Repräsentation.

## 2. Kleine Aktion „Markdown einfügen …“ ergänzen

Die Aktion in das vorhandene Einfügen-Menü des Rich-Editors aufnehmen (`MarkdownEditor.tsx:4188`), in der mobilen Oberfläche entsprechend zugänglich machen. Dieselbe Komponente und Einfügelogik verwenden. Die Aktion erscheint nur bei tatsächlich bearbeitbarem Editor.

Ein einfacher Dialog enthält ein mehrzeiliges Texteingabefeld, eine konkrete Fehlermeldung bei Bedarf sowie „Abbrechen“ und „Einfügen“. Der Nutzer fügt selbst in dieses Feld ein; ein automatischer Zugriff auf die Systemzwischenablage mit eigenen Berechtigungen ist nicht nötig. Keine zusätzliche Vorschau-Engine oder laufende Dokumentkonvertierung.

Technischer Ablauf:

1. Beim Öffnen die Auswahl mit den vorhandenen Editor-Target-Helfern erfassen (`interaction-target.ts`, bestehende Dialog-Hooks). Einfügeposition nicht erst nach dem Schließen aus einem möglicherweise veränderten Fokus ableiten.
2. Eingabe mit dem vorhandenen Canvas-Markdown-Codec prüfen und parsen. Gemeinsame Größen-/Syntaxgrenzen verwenden. Überschriften, Listen, Tabellen, Codeblöcke, Links, Bilder und unterstützte Canvas-Syntax erhalten; keine neue Parserbibliothek einführen.
3. Exakt darstellbaren oder nach bestehenden Regeln sicher normalisierbaren Inhalt übernehmen. Falls eine sichere Normalisierung nötig ist, im Dialog kurz darauf hinweisen; „Einfügen“ bestätigt den formatierten Import. Unbekannte/verlustbehaftete Konvertierung blockieren und den gesamten Eingabetext sichtbar behalten.
4. Auswahl/Editorlebensdauer/Schreibrecht vor Einfügen erneut prüfen. Eine parallel veränderte Ersetzungsauswahl darf nicht überschrieben werden. Bei ungültigem Ziel bleibt der Text im Dialog erhalten, mit Hinweis auf erneute Auswahl.
5. Nur an der aufgelösten Auswahl mit einer nativen Tiptap-/ProseMirror-Transaktion einfügen. Keine Ganzdokument-Ersetzung über `setContent`, keinen zweiten Yjs-Text und keine direkte Dateischreib-API verwenden. Vorhandene Unique-ID- und Collaboration-Mechanik übernimmt die neuen Blöcke. Die gesamte Einfügung ist eine Undo-Einheit; weitere Bearbeitung läuft normal weiter.
6. Dialog erst nach erfolgreicher Editor-Übernahme schließen. Den vorhandenen Speicherstatus nutzen; eine erfolgreiche lokale Editor-Transaktion nicht als bereits bestätigte Server-Persistenz ausgeben.

Frontmatter ist eine begrenzte Ausnahme: Im Dokumentkontext erkanntes YAML-Frontmatter zunächst mit einer klaren Inline-Erklärung blockieren und die Eingabe erhalten. Dokumenteigenschaften werden separat bearbeitet; im Einfügen-Dialog darf YAML weder still entfernt noch als neue Metadaten über bestehende Eigenschaften geschrieben werden. In lokalen Feldern mit `frontmatter='content'` bleibt YAML normaler Inhalt. Ein vollständiger Dateiimport einschließlich Eigenschaften kann über den bestehenden Datei-Upload erfolgen; dafür kein neues Importsystem entwickeln.

Für Syntax, die ausschließlich im Quelltext erhalten werden kann, benennt der Dialog den Grund und verweist auf den Import der `.md`-Datei als Quelldokument. Das bisherige Dokument bleibt unangetastet. Die Schutzprüfung für fehlende Roundtrip-Treue wird nicht gelockert.

Abnahme: Vorhandenes Markdown lässt sich in ein neues Dokument und an eine Auswahl einfügen, anschließend formatiert bearbeiten und mit einer Aktion rückgängig machen. Fehlversuche löschen weder den Eingabetext noch bestehende Inhalte.

## 3. Gezielt prüfen und abschließen

- Modus-/Komponententests für Rich, Plain, lokale Felder, Gäste, Rechteentzug, Loading und einen erzwungenen alten Source-Modus ergänzen.
- Einfügeprüfungen für leeres Dokument, Ersetzung einer Auswahl, Tabellen/Listen/Code, sichere Normalisierung, unzulässige Syntax, Frontmatter und Größenlimit ergänzen.
- Lokale und Yjs-gebundene native Editor-Transaktionen prüfen: eindeutige neue Block-IDs, Erhaltung vorhandener IDs, Undo/Redo, parallele Änderung außerhalb/am Einfügeziel, Editorwechsel während geöffnetem Dialog und Wiederöffnen des Yjs-Zustands.
- Bestehende Clipboard-, URL-Paste-, lokale Dokument-/Binding- und relevante Editor-Lifecycle-Tests nutzen. Bestehende E2E-Erwartungen an schreibgeschützten Rich-Source durch dessen Abwesenheit ersetzen; Plain-/lokale Source-Tests erhalten. Bestehende Moduspositions- und Offline-Tests auf die tatsächlich verfügbaren Modi beziehen.
- Passende Typ-/Lintprüfungen und `npm run build` ausführen. Browser-Abnahme nach ausdrücklicher Freigabe: neues Dokument → Markdown einfügen → formatiert bearbeiten → Undo/Redo → Neuladen sowie zwei Clients, Gastansicht und mobile Werkzeugleiste.
- Die beiden fertigen Produktänderungen sinnvoll getrennt committen, jeweils erst nach ihren Prüfungen. Vor Symboländerungen GitNexus-Impact prüfen; vor Commits `detect_changes` und tatsächlichen Diff kontrollieren.

## Lokaler produktionsnaher Stack

Der gelesene Skill `canvas-local-team-seat-dev` („Run local Canvas production stack“) definiert den passenden verwalteten Notebook-/Control-Plane-/PostgreSQL-Stack mit zwei Testnutzern. Für spätere App-Prüfungen beide Repository-Anleitungen und die Skill-Workflowreferenz lesen, vorhandene Listener/Container prüfen und nur diesen Stack verwenden. Den Branch als Notebook-Quelle vorbereiten. Container nur nach ausdrücklicher Freigabe bauen, vorher den Host-Produktionsbuild ausführen und aus aktuellem Stand neu erstellen. Login-Daten aus der privaten lokalen Konfiguration verwenden. Browserautomation bleibt laut `AGENTS.md` und Skill ausdrücklich freigabepflichtig.

## Evidenz und Grenzen dieser Planung

Die Diagnose wurde am aktuellen Quellcode verifiziert. Der lokale Worktree besitzt noch keinen eigenen GitNexus-Index; der ältere Haupt-Checkout-Index wurde nur zur Navigation verwendet. Dessen frühere Impact-Analyse meldete `CRITICAL` für gemeinsam genutzten Editor und Codec. Vor der Implementierung den Branch indexieren und die tatsächlich geänderten Symbole erneut prüfen. Eine kleine Ergänzung am Editor vermeidet den deutlich größeren Umbau von Speicherpfaden und Repräsentationsmigrationen.

Bereits in der vorherigen Analyse bestanden 5 Source-Binding- und 22 lokale Dokument-/Owner-Tests sowie vier isolierte Source-Einfügeversuche. Diese Ergebnisse belegen den bestehenden lokalen Source-Kern.

Für die vereinfachte Empfehlung zusätzlich ausgeführt: isolierter In-Memory-Test mit JSDOM und echtem Tiptap/Yjs gegen den aktuellen Quellcode. `insertContentAt` mit Markdown-Inhalt fügte Überschrift, Fettdruck, Liste und Codeblock zwischen vorhandene Blöcke ein. Bestehende Blöcke und IDs blieben unverändert, ein zweiter Yjs-Peer konvergierte, `validateRichMarkdownYDoc` bestand und Undo/Redo stellte die vollständigen Vorher-/Nachher-Dokumente wieder her. Das belegt den vorhandenen technischen Einfügepfad; der geplante Dialog und seine Fehlerfälle sind noch nicht implementiert oder abgenommen.

Kein Produktcode verändert; kein Browser, laufender App-/Serverintegrationstest oder vollständiger Build ausgeführt.
