# Inline-Referenzen im Chat

Verbindliche UI-Präzisierung vom 14. Oktober 2026 anhand der vom Nutzer gezeigten Codex-Beispiele. Sie ersetzt die frühere separate Chat-Chipleiste im [Gesamtplan](chat-extension-reference-plan.md). Die gemeinsame Suche und das Dropdown bleiben erhalten. [Interaktiver Wireframe](wireframes/chat-extension-picker.html).

## Gewünschte Bedienung

- `/` öffnet am Cursor dieselbe gemeinsame Suche für Plugins, Skills, Composio und eigene MCPs. Leere Suche zeigt zuletzt verwendete Auswahlen; Schreiben filtert, Typfilter sind optional.
- Nach nötiger Paket-/Kontobestätigung wird ausschließlich die eingegebene Slash-Query durch **Icon und hervorgehobenen Namen direkt im Text** ersetzt. Sonstiger Text und Cursorposition bleiben erhalten. Manuelles Öffnen derselben Suche bleibt möglich.
- Es gibt keine zusätzliche Auswahlleiste über oder unter dem Composer und keinen separaten Entfernenknopf je Referenz. Backspace, Delete oder markiertes Löschen entfernen den Referenzknoten im Text. Undo/Redo behandelt ihn als Einheit.
- Nach dem Senden steht dieselbe Hervorhebung an derselben Stelle in der Nachricht. Auch Reload, Retry und Queue-Bearbeiten erhalten sie. Eine historische Referenz beweist keine heutige Nutzungsberechtigung.
- Die tatsächliche Kontextaufbereitung läuft im Hintergrund. Technische IDs, Pins, Accountbelege, Toolrezepte und Kontextblöcke werden nicht als zusätzliche Nachrichtenelemente dargestellt. Bestehende Fehler-/Einrichtungsaktionen erscheinen nur, wenn eine Handlung erforderlich ist.
- Konto und Bereich werden im vorhandenen Picker bestätigt. Details einer Inline-Referenz dürfen sie später auf Nachfrage zeigen. Zwei gleichnamige Referenzen mit verschiedenen Konten müssen unterscheidbar bleiben; gegebenenfalls erhält die sichtbare Caption einen kurzen Kontozusatz.
- Auswahl allein sendet nichts. Ein bewusst gesendetes Dokument darf auch nur eine Referenz enthalten; die üblichen Agent- und Aktionsregeln gelten weiter. Ein vollständig leerer Entwurf wird nicht gesendet.

Beispiel: `Erstelle mit [Icon Canva Workspace] einen Entwurf.` Die eckigen Klammern stehen hier nur für die Hervorhebung im Wireframe und erscheinen nicht als Markup im Produkt.

## Ein Dokument als gemeinsame Datenquelle

Der Composer führt einen kleinen versionierten Body aus geordneten Text- und Referenzknoten. Ein Referenzknoten ist atomar und trägt eine lokale Vorkommens-ID. Er verweist auf eine genaue öffentliche Auswahl beziehungsweise ein Paketbundle: Ressource, unveränderlicher Paketstand, ausgewähltes Kind, tatsächliche Verbindung, Account und Grenzen. Die lokale ID und das sichtbare Label sind keine Autorität.

Die explizite Auswahl wird ausschließlich aus den vorhandenen Referenzknoten abgeleitet. Beim Löschen des letzten Vorkommens verschwindet die zugehörige zusätzliche Turn-Auswahl. Mehrere Vorkommen derselben genauen Auswahl ergeben einen Kontext, bleiben aber einzeln im Text bearbeitbar. Unterschiedliche Accounts bleiben unterschiedliche Auswahlen. Plugin-Abhängigkeiten sind nur über tatsächlich vorhandene Paketreferenzen erreichbar. Eigenständig erwähnte Skills oder Verbindungen bleiben unabhängig davon bestehen.

Feste Zuweisungen des gewählten Spezialagenten sind davon unabhängig. Sie gehören weiterhin zu dessen Systemkontext und werden durch Löschen einer Chat-Referenz nicht entfernt. Ihre Verwaltung bleibt in den Agent-Details; dafür wird keine zusätzliche feste Ressourcenleiste über dem Composer eingeführt.

## Vorhandene Bausteine verwenden

Vor dieser Umstellung verwendete `ChatComposer` eine Textarea und eine getrennte `SkillReferenceChipRow`; `useComposerReferences` fügte `/name` ein. Diese historische Ausgangsbasis ist inzwischen durch den kleinen Tiptap-Editor, gemeinsame Vier-Typen-Suche und den aus dem gespeicherten Body rendernden Verlauf ersetzt. Die separate Chat-Referenzleiste entfällt.

Tiptap ist bereits im Repository vorhanden. Der kleine Chat-Editor benötigt Text, Zeilenumbrüche, Bearbeitungshistorie und einen eigenen `extensionReference`-Knoten. Die vorhandene atomare `MarkdownMention`- und Suggestion-Mechanik liefert Cursor-/Range-/Tastaturgrundlagen. Es wird weder der ganze Dokumenteditor eingebaut noch die Identität von Personen-Mentions für Erweiterungen wiederverwendet.

Dropdown, gemeinsame Suchprojektion, Details und Accountwahl bleiben die vorgesehenen Komponenten. `PluginExtensionAvatar` liefert auch inline dieselben vorhandenen Bildquellen: Composio-Toolkitlogo, geprüfte Domain-Icons eigener MCPs, Paket-/Skill-Assets, Initialen bei fehlendem oder defektem Bild. Das Icon verändert keine Kontowahl und löst keine Tool- oder Provideraktion aus.

## Parsing und dauerhafte Übergabe

1. **Versionierter öffentlicher Bodyvertrag:** Strukturierte Text-/Referenzfolge und ihre genauen öffentlichen Bindungen gemeinsam validieren. Keine sichtbare HTML-/Markdown-Spezialsyntax. Bloßes `/Canva` oder ein blau dargestellter Name ist keine Bindung. Alte reine Nachrichten bleiben lesbar und werden nicht nachträglich anhand des heutigen Katalogs autorisiert.
2. **Serverseitige Zuordnung:** Alle Referenzen müssen auf vorhandene zulässige Auswahlobjekte zeigen; versteckte nicht referenzierte Auswahlen werden abgewiesen. Paketabhängigkeiten werden über bestehende Verträge validiert. Danach gelten unverändert aktuelle Quellen-, Rechte-, Account- und gemeinsame Budgetprüfungen. Kurzlebige Receipts und private Runtime-Handles gehören nicht in DOM, Draft, Clipboard oder Verlauf.
3. **Kanonischer Intent:** Geordnete normale Texte und genaue receiptfreie Referenzidentitäten sind maßgeblich. Andere Platzierung oder anderer Account ergeben einen anderen Intent. Flüchtige Vorkommens-IDs, Logo-URLs und reine Anzeige-/Lokalisierungsmetadaten erzeugen keine neue Aktion. Bereits angenommene alte Payloads und Hashes bleiben unverändert; die Erweiterung braucht einen ausdrücklich versionierten kompatiblen Codec.
4. **Send-Snapshot und Annahme:** Body, Ziel, Attachments und daraus abgeleitete Auswahl vor dem ersten Await einfrieren. Der Agent erhält eine passende Textprojektion und den bestehenden präzisen Kontextcompiler. Nur der tatsächlich angenommene Entwurf wird geleert; bei Ablehnung bleibt er bearbeitbar. Ungewisse Bestätigung führt zu lesendem Refresh, nicht zu einer neuen Geschäftsaktion.
5. **Draft, Handoff und Queue:** Dieselbe Struktur in `draft-storage`, `prompt-handoff`, Eingabehistorie und Queue-Bearbeiten erhalten. Retry verwendet den eingefrorenen angenommenen Stand. Ein Body darf nicht in einen String abgeflacht und später anhand von Labels wieder zusammengesetzt werden.
6. **Gesendeter Verlauf:** Angenommene Inline-Struktur zusammen mit der Nachricht speichern und aus ihr rendern. Keine getrennte Referenzzeile und keine heutige Namenssuche zur Rekonstruktion. Historische Logos dürfen nach bestehenden Regeln auf Initialen zurückfallen, ohne Account oder Ressourcenidentität umzubinden.
7. **Recents:** Erst nach dauerhafter Annahme, je eindeutiger expliziter Auswahl einmal pro Nachricht. Das Einfügen, Öffnen, Überfahren oder spätere Löschen im Entwurf zählt nicht als Nutzung.

DOM- und UTF-16-Zeichenbereiche sind abgeleitete Darstellung. Rohtext-Paste bleibt Rohtext. Ein strukturiertes internes Paste muss Referenzdaten validieren und aktuelle Verfügbarkeit vor Send erneut prüfen; es transportiert keine Belege oder privaten Berechtigungen.

## Umsetzung und Abnahme

Die bereits geprüften Annahme-, Source-, Execution-, Queue- und Replace-Dienste bleiben Grundlage. Der additive Inline-Bodyvertrag ist intern implementiert: `ChatBodyV1` enthält eine geordnete Text-/Referenzfolge und genaue öffentliche Bundles. Der äußere gespeicherte Nachrichtenvertrag und die SQL-Version bleiben V1; tatsächlich abwesender Body verwendet unverändert den alten Hash. Ein vorhandener Body bekommt eine eigene Hash-Domain. `null`, explizites `undefined`, unbekannte Felder, verwaiste Bundles und nicht referenzierte zusätzliche Auswahlen werden abgewiesen. Caption und lokale IDs bleiben Darstellung, alle übrigen Text-/Attachmentblöcke und die genaue Auswahl bleiben Teil der Nachrichtenidentität.

Bundles enthalten keine kurzlebigen Accountbelege, privaten Runtime-Handles oder Logo-URLs. Der Renderer bezieht vorhandene Icons aus der genauen zulässigen Ressourcenprojektion und fällt sonst auf Initialen zurück. Unterstützende Paketverbindungen benötigen in beide Richtungen passende explizite Mappings. Der vorhandene Turnvertrag mit höchstens fünf deduplizierten rohen Auswahlen einschließlich dieser Verbindungen bleibt bestehen; fünf sichtbare Pakete mit zusätzlichen Verbindungen sind damit noch nicht freigegeben. Eingabe und expandierte Textprojektion bleiben jeweils auf vier MiB begrenzt. Kanonische Bundles werden nur einmal gespeichert, auch wenn dieselbe Referenz oft vorkommt.

Runtime und Transport sind mit `795dfff52` angeschlossen. Home und Web-Chat verwenden jetzt den tatsächlichen Inline-Editor, gemeinsame Suche/Recents, genaue Kontoauswahl und historische Darstellung; Body, Send-Snapshot, Draft, Handoff, Retry und Queue-Bearbeiten behalten dieselbe genaue Struktur. Komponenten-, SQL-/API-, TypeScript- und Lintprüfungen bestehen. Die reale lokale Browserabnahme besteht mit frischem Produktionsbuild, 13 Fällen und anschließender unabhängiger Tool-Inspektion (`U9YbHT`); die Ergebnisse und die gefundenen Korrekturen stehen im [Umsetzungsjournal](chat-agent-extension-implementation.md#inline-oberfläche-und-gemeinsamer-chat-katalog). Vollständiger Live-Modellnachweis, sichtbarer Auflösungsweg alter/ungewisser Queuezustände und eigene native Abnahme bleiben getrennt offen.

Die Abnahme umfasst alle vier Typen, Einfügen am Anfang und mitten im Satz, mehrteilige Suche, Konto A/B, gleiche Namen, Löschen eines und des letzten Vorkommens, Undo/Redo, markiertes Ersetzen, Copy/Paste, Emoji und kombinierende Zeichen vor der Referenz, IME und mobile Tastatur. Hinzu kommen angenommener/abgelehnter Send, verlorene Bestätigung, Retry, Queue-Bearbeiten, Draftreload und Verlaufreload. Im Modelllauf müssen weiterhin tatsächliches Skill-Lesen und gezielte Tool-Discovery nachgewiesen werden.

Der aktualisierte HTML-Wireframe zeigt den Bedienvorschlag mit Beispieldaten. Seine lokale DOM-Demo ist keine Produktimplementierung, kein echtes Tiptap-Dokument und kein Beleg für den neuen Bodycodec oder vollständige Runtime-/Modellübergabe. Browserprüfungen des Wireframes bleiben von der späteren Produkt-E2E-Abnahme getrennt.
