# Gemeinsamer Dokumentzugriff: Editor, API, MCP, Agent und SDK

Stand: 16. Oktober 2026. Verbindliche Ergänzung des Nutzerauftrags. Die folgenden gemeinsamen Anschlüsse sind geplant und noch nicht als durchgängig implementiert oder abgenommen ausgewiesen. Erstellen gehört ausdrücklich ebenso dazu wie Lesen und Bearbeiten. Review Center und zusätzliche menschliche Annahme sind keine Voraussetzung; das experimentelle Feature bleibt ausgeschaltet.

## 1. Ziel und Reihenfolge

Ein zentraler Dokumentdienst trägt Erstellen, Identität, Lesen, Bearbeiten, Suche und Operationsstatus. Editor, Web-/Mobile-API, MCP, interne Agenten-Tools und Python-SDK verwenden dessen fachliche Fähigkeiten. Die vorhandenen Dienste und Indizes werden wiederverwendet und zusammengeführt. Ein zusätzlicher Suchweg mit abweichender Inhaltsquelle ist nicht das Ziel.

Zuerst bleiben die tatsächlichen Datei-Undo-Fehler zu bearbeiten: Im aktuellen Browserlauf erreichen beide Delete-Anfragen `applied`. Desktop-Undo endet dagegen in `needs_recovery` ohne ursprünglichen Restore-Abschlussbeleg. Mobile erreicht `undone`; die anschließende Assertion verwendet einen falschen Textselektor, obwohl Dateilistenantwort, DOM und Screenshot die zurückgekehrte Datei zeigen. Der enge Testselektor wurde auf das exakte Pfadattribut korrigiert; Wartezeit und fachliche Sichtbarkeits-/Identitäts-/Inhaltsassertions bleiben erhalten. Die frische Browserabnahme steht aus. Dokumentidentität, Generation und Inhalt nach frischem Wiederöffnen sind dadurch noch nicht gemeinsam abgenommen. Dieser Fehler darf nicht durch längere Timeouts oder gelockerte Assertions verdeckt werden.

Danach werden die gemeinsamen Dokumentfähigkeiten einschließlich MCP/Agent, Suche und SDK jeweils als vollständige vertikale Folge integriert. Parallele Quellenanalysen, Adapterarbeit und fokussierte Tests sind möglich; zusammenhängende Mutationsgrenzen werden koordiniert integriert und tatsächlich geprüft.

## 2. Vorhandene Fähigkeiten und bestätigte Lücken

| Einstieg | Heutiger Anschluss | Noch zu schließen |
| --- | --- | --- |
| HTTP/Editor | Nativer Read ohne Projektion, zentraler manueller Markdown-Create, Dokument-ID → aktueller Ort sind vorhanden. | Gemeinsamer versionierter Create-/Read-/Edit-by-ID-Vertrag für alle Aufrufer. |
| MCP Create/Import | `create_knowledge_source` und `import_knowledge_file` haben OAuth-/Workspacegrenzen, Create-only und ein Ingestjournal. | Physischer Publikationspfad und Ergebnis ohne native Dokument-ID bestätigen keine erste native Persistenz. |
| MCP Read/Edit | `read_knowledge_source` und `edit_knowledge_source` verwenden für vorhandene Dokumente kollaborative Inhalte beziehungsweise den vorbereiteten Agenten-Editkern. | Physische Stats/Bytes vor dem nativen Zugriff, pfadbasierte Auswahl und getrimmte äußere Pfadleerzeichen. Native-only und nicht exportierbares Rich bleiben Lücken. |
| Interne Agenten-Tools | Strukturreads und native Edits mit ID-/Generations-/Operationsbindung sind vorhanden. | `read`, `edit_file`, `apply_patch`, `write` verlangen teilweise vorher physische Existenz; der Create-Fallback belegt keinen gemeinsamen nativen Create. |
| Websuche | `/api/files/list?q=…` ordnet Dateiname/Pfad nach exaktem Namen, Präfix und Teilstring. | Physischer Katalog, keine gemeinsame Inhaltssuche oder Dokument-ID, keine Seitenfortsetzung. |
| MCP-Suche | `search_knowledge` liest nativen semantischen Text bereits direkt aus Yjs. | Alphabetische Kandidatenreihenfolge, harte Grenzen, keine ID/Version oder Cursor. Nachgeschalteter Endungsfilter schließt sogar native Registrypfade mit anderer Endung aus. |
| Mobile-Suche | `/api/mobile/v1/notebook?query=…&cursor=…` hat Name-/Pfad-/Inhaltssuche und Ausschnitte. | Inhalt stammt aus Markdown-Projektionen; Scan- und Inhaltsgrenzen sind kein vollständiger nativer Suchindex. |
| Agenten-Suche | `rg`, Legacy-`grep` und `glob` existieren. | Physische Dateisuche ersetzt keine Suche über den maßgeblichen nativen Dokumentbestand. |

Die aktuelle MCP-Suche begrenzt sich auf 400 Kandidaten, 256 KiB je Quelle und 25 Treffer. Mobile durchsucht bis zu 5.000 Dateipfade, davon höchstens 200 Inhalte bis 512 KiB. Diese Grenzen werden bei der Zusammenführung ausdrücklich als Coverage-/Fortsetzungsproblem behandelt; daraus darf kein unbelegtes „keine Treffer im gesamten Workspace“ werden.

Quelleneinstiege: `app/lib/mcp/server/workspace-tools.ts`, `app/lib/mcp/server/file-ingest.ts`, `app/lib/collaboration/workspace-search-reader.ts`, `app/lib/filesystem/file-reference-search.ts`, `app/lib/mobile/notebook.ts`, `app/lib/pi/core-tools.ts`, `app/lib/pi/agent-file-operations.ts` und `app/lib/collaboration/agent-file-edits.ts`. Der vorhandene `executePreparedCollaborationTextEdit`-/`applyPersistedAgentTextOperation`-Kern wird wiederverwendet. Ein Strukturread darf künftig nicht allein wegen fehlender verlustfreier Markdown-Serialisierung scheitern, wenn der native Zustand vollständig und zulässig lesbar ist.

## 3. Dokumentidentität und Lesen

- Ein verwaltetes Dokument besitzt eine stabile Dokument-ID im Workspace. Pfad und Titel sind Eigenschaften; Rename/Move behalten die ID, Copy und eine wirkliche Neuanlage erhalten eine neue ID. Ein später am alten Pfad angelegtes anderes Dokument wird nie stillschweigend zum ursprünglichen Ziel.
- Der Read nach ID löst den aktuellen Ort zentral unter aktuellen Rechten auf und liest den maßgeblichen nativen Zustand. Eine fehlende, veraltete oder nicht verlustfrei erzeugbare Markdown-Projektion ist kein Ersatz für diesen Zustand.
- Das Ergebnis nennt ID, aktuellen Pfad/Titel, Repräsentation und opake Version. Markdown ist eine explizite Ausgabeform. Falls diese Form nicht verlustfrei verfügbar ist, bleiben zulässige native Struktur und semantischer Text erreichbar; das Exportproblem wird ausgewiesen.
- Kleine Dokumente können vollständig geliefert werden. Große Dokumente werden mit klaren Größenangaben und einer Fortsetzung vollständig lesbar. Alle Teile gehören zu derselben ausgewiesenen Version; bei nicht mehr lesbarer Version gibt es einen eindeutigen Konflikt statt vermischter Textstände.
- Jeder Read und jede Fortsetzung prüfen erneut die aktuelle Workspace-/Dokumentberechtigung. Suchtreffer, IDs, Cursor und frühere erfolgreiche Zugriffe sind keine Schreib- oder dauerhaften Lesefreigaben. Gelöschte beziehungsweise verschobene Ziele werden anhand ihrer tatsächlichen Lifecycle-Zuordnung behandelt.

## 4. Gemeinsame Suche mit brauchbarer Relevanz

Die gemeinsame Suche umfasst Dateiname, Titel, aktuellen Pfad und semantischen Dokumenttext. Für native Dokumente gilt Registry-/Dokumenttyp vor Dateiendung. Nicht exportierbares Rich und native Dokumente ohne Projektion gehören in denselben Bestand. Physische sonstige Dateien werden als eigener tatsächlicher Quelltyp behandelt; ungeparste Binärdateien erhalten keinen erfundenen Volltext.

Als erste nachvollziehbare Relevanzordnung sind exakte Titel-/Namens- und Phrasentreffer, anschließend Worttreffer mit höherem Titelgewicht und danach Präfix-/Toleranztreffer vorgesehen. Mehrwortanfragen, deutsche Umlaute, Groß-/Kleinschreibung, Wortformen und exakte Bezeichner werden anhand einer festen Suchsuite bewertet. Optionale semantische Suche ergänzt diese Ordnung erst nach belegtem Mehrwert und mit sichtbarer Verfügbarkeit; sie ersetzt weder exakte Suche noch Berechtigungsfilter.

Filter betreffen insbesondere Workspace, Ordner, Dokumenttyp und gegebenenfalls Änderungszeit. Sortierung und Fortsetzung sind deterministisch; gleiche Relevanz erhält einen stabilen Tie-Breaker. Eine begrenzte Menge zuerst alphabetisch gewählter Dateien darf nicht als Relevanzranking über den gesamten Workspace ausgegeben werden.

Ein Treffer liefert mindestens Dokument-ID beziehungsweise eindeutige Ressourcenidentität, Titel, Pfad, Typ, kurze relevante Ausschnitte und passende Fundstellen. Version und Indexfrische machen sichtbar, auf welchen Text sich der Treffer bezieht. Vollständiger Inhalt wird zunächst nicht mitgeschickt. Die Antwort nennt Cursor, tatsächliche Suchabdeckung, ausgelassene beziehungsweise fehlgeschlagene Quellen und Grenzen. Unvollständiger Scan und unvollständig aktualisierter Index sind von einer vollständigen Nulltreffermenge unterscheidbar.

Native Textgewinnung aus `workspace-search-reader` und vorhandene Such-/Indexinfrastruktur sind der Ausgangspunkt. Nach Create, Edit, PDF-Import, Move/Rename, Copy, Delete und Undo müssen Katalog und Suchindex dieselben IDs, Lifecycle-Zustände und ausgewiesenen Dokumentversionen verwenden. Projektionserfolg darf nicht die Bedingung für Suchbarkeit sein.

## 5. Progressive Disclosure: finden → auswählen → lesen → ändern

1. Die Runtime sieht kurze Skill-/Toolbeschreibungen und die Pflicht, verwaltete Dokumente zentral zu bearbeiten. Die vollständige API-Dokumentation steht nicht im Systemprompt.
2. Bei Bedarf lädt der Agent den Standard-Skill und genau die benötigten Schemata. Vorhandene Gateway-Discovery `search → describe → call` wird dafür genutzt; sie ist von der eigentlichen Dokumentsuche zu unterscheiden.
3. Die Dokumentsuche liefert eine begrenzte Trefferliste mit IDs und kurzen Ausschnitten.
4. Der Agent lädt nur ausgewählte Dokumente über ihre ID vollständig beziehungsweise versionsgebunden in Teilen nach.
5. Eine Änderung adressiert genau diese ID und die erwartete Version/Generation beziehungsweise gültige Strukturziele. Veralteter Kontext erzeugt einen Konflikt, keinen blinden Whole-file-Overwrite.
6. Das Ergebnis enthält den dauerhaften Operationsstatus und die neue Version. Bei verlorener Antwort wird dieselbe Operation abgefragt oder wiederaufgenommen; die Mutation wird nicht mit neuer ID wiederholt.

SDK und Skill enthalten lauffähige Python-Beispiele für Suche, Read-by-ID, leere und inhaltsgefüllte Neuanlage, Markdownimport, strukturierte Änderung und Operationsstatus. Die interne Python-FD-Toolbridge ist vorhanden, ersetzt jedoch kein veröffentlichtes externes HTTP-SDK. Der Marketplace-Kandidat bleibt bis zur tatsächlichen Installation, Runtime-Discovery und Durchstichprüfung als vorbereitet gekennzeichnet.

## 6. Erstellen und Bearbeiten über alle Zugänge

MCP, interne Agenten-Tools und SDK erhalten echte Adapter für leere Dokumente, neue Dokumente mit Text/Markdown und Import. Ein erfolgreicher Create bestätigt native Dokument-ID, Workspace, aktuelle Version und die dauerhaft bestätigte Operation. Er liefert nicht nur einen physischen Dateipfad oder eine Revisions-ID. Nicht leere API-/Parserquellen benötigen ihren echten Quell- und Erzeugungsbeleg; Upload und Manual-Empty werden nicht vorgetäuscht.

Alle Adapter verwenden denselben fachlichen Erzeugungs-/Editkern, behalten aber ihre tatsächliche Authentisierungsherkunft: interaktive Anfrage, MCP-Verbindung mit Token-Scope und Workspacefreigabe oder aktuelle Agenten-Toolinvocation. Rechte, Lizenz/Seat, Generation und Version werden am tatsächlichen Mutationsschritt geprüft. Ein beliebiger Python-ExecutionContext erzeugt keine dieser Freigaben.

Direkte Agentenänderungen an verwalteten Markdown-Dateien bleiben in der Sandbox schreibgeschützt. Vorhandene native Writer-Sperren dürfen bei der Integration nicht als Fallback umgangen werden. Auch bei fehlender Projektion, Parserfehlern oder Konflikten bleiben zentrale Orchestrierung und gespeicherter Yjs-Zustand maßgeblich.

## 7. PDF und gemeinsame Abnahme

Das vorhandene PDF-to-Markdown-Tool wird an denselben zentralen Create-/Importvertrag angeschlossen. Parserausgaben bleiben zunächst echte temporäre Ergebnisse; anschließend entstehen eine native Notizbuchdatei und deren dauerhafter Beleg. Original-PDF, Dokument-ID und Herkunft werden nachvollziehbar verbunden. Agenten schreiben die Markdown-Ausgabe nicht direkt an der Orchestrierung vorbei in den Workspace.

Die verbindliche Testmatrix umfasst:

- Suche → Treffer-ID → vollständiger Read → Edit über MCP, interne Agenten-Tools und Python/SDK; derselbe Inhalt erscheint im offenen Editor und nach frischem Wiederöffnen.
- Neue leere und inhaltsgefüllte Dokumente, manuelles Einfügen, Markdowndateiimport und PDF-to-Markdown → native Neuanlage → Suche/Read/Edit. Wiederholte Anfragen erzeugen keine versehentlichen Duplikate.
- Plain, XML und Blocks; native-only, veraltete oder fehlende Projektion und gültiges nicht exportierbares Rich. Keine still ausgelassenen nativen Treffer.
- Rename/Move bei gleicher ID, Copy bei neuer ID, Delete/Undo, eine andere Neuanlage am alten Pfad sowie korrekte zentrale Linkpflege und Suchindexaktualisierung.
- Mehrwort-, Phrasen-, Titel-, Namens-, Pfad-, Umlaut-/Wortform- und Nulltrefferfälle; Ranking gegen feste Erwartungen, deterministische Seiten und ehrliche Coverage bei Grenzen/Indexverzug.
- Große vollständig gelesene Dokumente, Versionswechsel zwischen Seiten, paralleler Peeredit, aktueller Rechteentzug, fremder Workspace und verlorene Commit-/HTTP-Antwort. Konflikte und unbestätigte Zustände dürfen keinen Erfolg vortäuschen.
- Natürliche Skill-/Schemadiscovery in frischer Runtime ohne vorab eingebettete Vollanleitung; Rohdateisperre bleibt aktiv und Review Center bleibt aus.

Erst diese gemeinsame Abnahme bestätigt, dass Editor, MCP, Agent und SDK tatsächlich dieselben Dokumente verwalten. Einzelne bestehende Tools und lokale Teiltests schließen diesen Auftrag nicht ab.
