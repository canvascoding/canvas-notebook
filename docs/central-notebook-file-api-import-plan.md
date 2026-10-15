# Zentrale Datei- und Dokumentoperationen: API, SDK, PDF und Sandbox

Stand: 15. Oktober 2026. Ergänzung zum [Yjs-Konsolidierungsplan](./yjs-document-authority-consolidation-plan.md), verbindlicher Scope gemäß Nutzerauftrag. Dies ist ein Umsetzungs- und Abnahmeplan; die unten genannten neuen Anschlüsse sind noch nicht als implementiert oder bestanden ausgewiesen.

U-01 aus [§0 des Hauptplans](./yjs-document-authority-consolidation-plan.md#0-zuerst-undo-verlassen-und-bestätigte-speicherung) ist lokal abgenommen: gespeichertes Undo/Wiederöffnen, abgebrochenes Verlassen und ausdrücklich erzwungenes Verlassen mit bereits committed lokaler Recovery bestehen getrennt. V14 auf Code `6d8fc7079` / QA `fbe5fb27b` besteht die enge Webmatrix mit 37/37 einschließlich zweier echter Hostneustarts; Build und eigener Ressourcenabschluss sind unabhängig bestätigt. Die folgenden zentralen Datei-/Link-, API-/SDK-, PDF- und Sandboxverträge bleiben als weitere Arbeit offen. Das experimentelle Review Center bleibt ausgeschaltet und außerhalb dieses Auftrags; autorisierte Änderungen benötigen keine zusätzliche menschliche Annahme.

## 1. Gemeinsamer Zielvertrag

UI, Agententools, kontrollierte Parser/Importe und programmatische Clients rufen dieselben serverseitigen Fähigkeiten auf. Der Server prüft Actor, aktuelle Rechte, Workspace, Dokumentidentität, Lifecycle-Generation und die jeweils nötigen Versions-/Zielvorbedingungen. Der zuständige Yjs-Raum verarbeitet Inhaltsänderungen; PostgreSQL bestätigt sie dauerhaft. Der Projector führt die Markdown-Dateiausgabe nach. Eine SDK-Bibliothek, ein Parser oder ein Agentenskript führt diese Schritte nicht selbst nachgebaut aus.

Für ein verwaltetes Notizbuchdokument sind Dokument-ID und maßgeblicher Yjs-Inhalt entscheidend. Die bestehende `.md`-Projektion bleibt interoperable Ausgabe. Dieser Anschluss erfindet keine neue Dateiendung oder zweite Dokumentautorität.

Ein Erfolg muss unterscheiden können: Inhalt dauerhaft verarbeitet, Pfad-/Lifecycle-Schritt bestätigt, verpflichtende Linkpflege abgeschlossen, Ausgabe noch ausstehend oder fehlgeschlagen. Bei unklarem COMMIT wird derselbe Operationsbeleg abgefragt; erneutes Anwenden ohne Nachweis ist verboten. Aktuelle Rechte-/Namespace-/Zielkonflikte bleiben echte Fehler und werden nicht durch eine Annahmeoberfläche ersetzt.

## 2. Quellenbasierter Bestand

| Anschluss | Vorhandene Grundlage | Noch nachzuweisen/anzuschließen |
| --- | --- | --- |
| Dateiaktionen | [workspace-file-operation-service.ts](../app/lib/files/workspace-file-operation-service.ts), [Batch-Executor](../app/lib/files/workspace-operation-batch-executor.ts), [Agentenadapter](../app/lib/pi/agent-file-operations.ts) | Durchgängig autoritative Inhalte/Linkplanung und Abschluss auch bei fehlender Markdown-Projektion; Copy benötigt neue Dokumentidentität und isolierte Lineage. |
| Native Inhaltsänderung | Vorhandene Collaboration-Reader/Writer, Admission, Ownership und Persistenz | Alle verbleibenden Adapter müssen dieselben Verträge verwenden; keine direkte Disk- oder SQL-Abkürzung. |
| PDF-Agententool | [pdf-tools.ts](../app/lib/pi/pdf-tools.ts), `pdf_to_markdown`: PDF lesen, Konvertierung, danach `writeAgentTextFile` | Parserabschluss ist noch kein nachgewiesener nativer Dokumentimport. Quelle und Ziel müssen über die lange Konvertierung gebunden bleiben. |
| PDF-Konverter | [pdf-tool-runtime.py](../scripts/pdf-tool-runtime.py) erzeugt semantisches Markdown mit Seiten-/Quellinformationen | Keine zugesicherte pixelgenaue Rekonstruktion; OCR-/Bildbedarf wird gewarnt, Bildassets werden derzeit nicht als Paket extrahiert. |
| Vorhandener Ingest | [MCP file-ingest.ts](../app/lib/mcp/server/file-ingest.ts) und Create-/Importgrundlagen des Hauptplans | `import_knowledge_file` übernimmt Quellbytes kontrolliert, ist aber keine implizite PDF-Konvertierung und kein alleiniger Nachweis eines fertigen Notizbuch-/Suchindexabschlusses. |
| Code-SDK innerhalb Skills | [Python-Bridge](../app/lib/skills/script-runtime/sdk/python/canvas_skill.py), [Node-Bridge](../app/lib/skills/script-runtime/sdk/node.cjs) | Bestehende `arguments`/`describe`/`call`-Bridges über geerbte Deskriptoren sind kein allgemeines HTTP-SDK für externe Programme. Beide sollen dieselben zentralen Toolfähigkeiten ansprechen. |
| OS-Schreibschutz | [agent-shell-sandbox.ts](../app/lib/pi/agent-shell-sandbox.ts), [Linux-Launcher](../scripts/runtime/agent-shell-sandbox.py) | Tatsächliche Gegenproben aller relevanten Launcher/Kindprozesse und Veröffentlichungspfade. Netzwerk/API und externe MCP-Server benötigen eigene serverseitige Kontrollen. |

Diese Inventur ist Quellenbeleg. Sie behauptet keine neue Produktions-, SDK-, PDF- oder plattformübergreifende Sandbox-Abnahme.

Die bestehenden Eintrittspunkte bleiben Ausgangspunkt: Rename/Move/Delete verwenden bereits den dauerhaften direkten Batchpfad, Copy einen gesonderten geschützten Dateioperationspfad; Planer und Linkschreibmechanik werden gemeinsam verwendet. Zentralisierung bedeutet, diese geprüften Fähigkeiten hinter einem konsistenten Vertrag anzubinden und Lücken zu schließen. Ein zweiter Dateiaktionsmotor für API oder SDK ist nicht vorgesehen. Bestehende Indexbudgets und ausgelassene Quellen bleiben sichtbare Coveragegrenzen; ihre Überschreitung darf nicht als erfolgreicher vollständiger Scan gelten.

Zunächst wird der bestehende direkte Non-overwrite-Vertrag vereinheitlicht. Der gesonderte bisherige Copy-Overwritepfad meldet unvollständigen Linkstatus; er darf über API/SDK nicht plötzlich als vollständig linkgepflegt gelten. Ein vorhandenes Ziel benötigt entweder einen klaren Konflikt oder einen eigens abgenommenen koordinierten Overwrite-/Lifecycle-Vertrag.

## 3. Verschieben, Kopieren, Löschen und zentrale Links

| Operation | Dokument-/Pfadwirkung | Verpflichtende Linkwirkung |
| --- | --- | --- |
| Verschieben/Umbenennen | Dokumentidentität erhalten, Ort/Lifecycle konsistent ändern; Datei und Ordner einschließlich Nachfahren | Eingehende Verweise auf neue Ziele umstellen; relative ausgehende Links aus verschobenen Quellen neu auflösen, Linktexte/Formatierung und unabhängige Edits erhalten. |
| Kopieren | Neue Dokument-ID und unabhängige CRDT-/Blocklineage aus autoritativem Inhalt erzeugen; Binärassets nach bestehendem Dateivertrag | Links innerhalb eines kopierten Pakets auf seine neuen Ziele abbilden; Links außerhalb des Pakets sinnvoll erhalten/relativieren. Eingehende Links zum Original werden nicht still auf die Kopie umgebogen. |
| Löschen | Autoritativen Inhalt und physische Artefakte sichern, archivieren/Papierkorb und Pfadfreigabe bestätigen | Überlebende Quellen gezielt nach definierter Delete-Semantik bereinigen; sichtbare Linkbeschriftung möglichst erhalten. Kein stiller unbekannter oder ausgelassener Quellenbereich. |

Ein gemeinsamer Linkgraph erfasst unterstützte Markdown-, Wiki-, Bild-, Referenz-, HTML-/Assetlinks und Anker nach den bestehenden Syntax-/Coverageverträgen. Backlinks, Navigation und Suche verwenden passende Identitäten und Invalidierung. Binärdateien einschließlich Original-PDFs sind ebenfalls mögliche Linkziele. Umbenennen/Verschieben ihrer Ziele muss dieselbe zentrale Linkpflege auslösen.

Verbindliche Grenzen: Groß-/Kleinschreibung, Unicode/URL-Escapes, Leerzeichen, Pipe-Zeichen, Ordnerbäume, Alias-/Ankertitel, gleichnamige Wiederanlage, offene/geschlossene Dokumente und fehlende/veraltete Projektionen. Cross-Workspace-Operationen prüfen beide Scopes und bleiben auf ausdrücklich unterstützte Semantik beschränkt. Keine neue Cross-Workspace-Fähigkeit wird durch einen SDK-Wrapper vorgetäuscht.

Der Koordinator meldet Dateiaktionen erst nach den vorgeschriebenen Pfad-, Link- und dauerhaften Inhaltsbelegen als abgeschlossen. Nutzer- und Agentenedits im inzwischen geänderten Dokument werden erhalten. Exportprobleme bleiben gesondert sichtbar; sie legitimieren weder stillen Linkverlust noch eine Rohdateiänderung.

## 4. Versionierte API und erstes Python-SDK

YD-13 ist verbindlicher Anschluss mit P1. Sein Schema kann parallel geplant werden; Implementierung und Freigabe benötigen die abgenommenen Kernfähigkeiten aus YD-02 bis YD-08. Ein Produktionsrollout ist keine Voraussetzung für den Schemaentwurf. Die folgenden Fähigkeitsnamen sind Arbeitsbegriffe, keine Behauptung bereits verfügbarer öffentlicher Endpunkte.

| Fähigkeit | Erforderlicher Vertrag |
| --- | --- |
| Dokument suchen/auflösen/lesen | Stabile Dokument-ID, aktueller Ort, Repräsentation und versionierter nativer oder ausdrücklich exportierter Inhalt. Paginierung bleibt an denselben Snapshot gebunden. |
| Dokument erzeugen/Markdown importieren | Create-only bzw. ausdrücklich autorisiertes bestehendes Ziel; Frontmatter/Encoding/Assets und erste native Persistenz gemäß gemeinsamem Importvertrag. |
| Text/Blöcke gezielt verändern | Dokument-ID, Generation und passende aktuelle Version/Zielvorbedingungen; serverseitige Übersetzung kontrollierter Text-/Markdown-Operationen in native Änderungen. Keine clientseitig zusammengebauten Roh-Yjs-Updates und kein Schreiben der `.md`-Projektion. |
| Verschieben/Kopieren/Löschen | Derselbe Planer/Koordinator und dieselbe vollständige Linkpflege wie im UI/Agententool; Umfang und neue Identitäten sind im Ergebnis erkennbar. |
| PDF-Konvertierung/Import anfordern | Vorhandenen Parserworkflow und den kontrollierten Import aus §5 verwenden; Auftrag und Derivat auf dieselbe Quelle binden. |
| Operation/Dauerhaftigkeit/Exportstatus lesen | Idempotenzschlüssel, Operations-ID, bekannte Teilschritte und unklarer Ausgang; „angenommen“ ist kein dauerhafter Abschluss. Statusabfrage darf Mutation nicht erneut auslösen. |

Das SDK bleibt ein dünner, versionierter Client: Authentisierung, typisierte Requests/Ergebnisse, begrenzte Fehlerbehandlung und explizites Warten auf Operationsabschluss. Keine zweite Linkauflösung, keine eigene Konfliktbehebung durch Whole-document-Overwrite und keine direkten DB-/Dateipfade. Python ist der bereits vorgesehene erste SDK-Anschluss; weitere Sprachen können auf demselben Vertrag folgen.

Authentisierung nutzt den vorhandenen autorisierten Transport, der für externe Programme passend versioniert wird. Rechte sind workspace-/aktionsgebunden, aktuelle Rechte werden serverseitig erneut geprüft. Credentials kommen aus der zentralen Secret-Verwaltung oder dem bestehenden Benutzer-/OAuth-Vertrag, niemals aus SDK-Quelltext. SDK-Beispiele enthalten keine fest eingebauten Tokens oder lokalen Server-DB-Zugänge.

Öffentliche Antworten enthalten den freigegebenen begrenzten Statusvertrag und eine geeignete opake Versionsbindung. Private Recoverymanifeste, binäre Sicherungen und serverseitige Actor-/Sessionfähigkeiten werden nicht exportiert. Ein übermitteltes `workspaceId`-/Actorobjekt vergibt keine Rechte. OAuth-/MCP-Autorität und interaktive Sessionautorität behalten ihre tatsächliche Herkunft; ein Adapter darf keine fremde Autorität durch eine konstruierte BetterAuth-Sitzung ersetzen.

Version, Lifecycle-Generation und Zustand samt Löschungen werden ausdrücklich gebunden. Neue Zustandsfelder dürfen alte Clients nicht als Dateicheckpoint missverstehen. Ein Netzwerkfehler nach möglichem COMMIT führt zur Statusabfrage derselben Operation; begrenzte sichere Retries erzeugen weder doppelte Texte noch Kopien. Auf `conflict`, Rechteverlust oder unklaren Ausgang folgt kein blinder Retry mit abgeschwächten Vorbedingungen.

## 5. Bestehendes PDF-Tool bis zum echten Notizbuchdokument

Das Tool `pdf_to_markdown` wird angeschlossen, kein zweites konkurrierendes Tool gebaut. Sein bisheriger Name und die dokumentierten Eingaben werden kompatibel weitergeführt oder ausdrücklich versioniert.

Verbindlicher Ablauf:

1. Quell-PDF im richtigen Workspace mit Berechtigung, Identität und Größen-/Seitenbudget lesen. Tatsächlich zu konvertierende Bytes einfrieren oder äquivalent beweisen; Hash und Quellprovenienz müssen zu genau diesen Bytes gehören.
2. Zielpfad und Operation zentral reservieren. „Neu erzeugen“ bleibt bis zur Veröffentlichung create-only; ein inzwischen angelegtes Ziel ist ein Konflikt. Ein vorhandenes verwaltetes Ziel benötigt den ausdrücklichen aktuellen Dokument-/Versionsvertrag.
3. Vorhandenen Parser ausschließlich gegen die gebundene Quelle ausführen; temporäre Markdown-/Assetausgaben liegen im privaten Scratch. Abbruch, defekte/verschlüsselte PDFs, leere Extraktion, Ressourcenüberschreitung und OCR-Bedarf erhalten klare Ergebnisse.
4. Vollständige Parserausgabe einschließlich zulässiger Metadaten kontrolliert prüfen und über denselben zentralen Dokumentimport in native Struktur übernehmen. Bei Neuanlage neue Dokument-ID und isolierte Lineage erzeugen und initiales Yjs dauerhaft sichern. Ein ausdrücklich gewähltes vorhandenes Ziel behält seinen gebundenen Identitäts-/Generations-/Editvertrag; kein stilles Wiederanlegen unter demselben Pfad und kein unkontrollierter `.md`-Write als Endergebnis.
5. Original-PDF, Quellhash/-identität, Parser-/Importversion und gegebenenfalls Seiten-/Assetmanifest an das Derivat binden. Quelle mit stabiler Workspace-Dateiidentität/Revision zuordnen; temporäre Download-URLs oder lokale absolute Hostpfade sind keine dauerhafte Provenienz. Das Original bleibt erhalten, soweit nicht eine eigene autorisierte Dateiaktion etwas anderes verlangt. Sein späteres Verschieben aktualisiert die aufgelöste Quellzuordnung/Links zentral, ohne den historischen Quellhash des Derivats zu verändern.
6. Extrahierte Assets, sofern unterstützt, innerhalb eines begrenzten Pakets veröffentlichen, Pfadbelegung/Hashes prüfen und Links zentral relativieren. Aktuell nicht extrahierte Bilder oder fehlende OCR bleiben sichtbare Fähigkeitenlücken; kein behaupteter vollständiger Inhalt bei nur leeren Seitenmarkern.
7. Dokument- und Assetveröffentlichung über wiederaufnehmbare Schritte/Receipts abschließen. Kein doppeltes Dokument nach Retry, keine verwaisten veröffentlichten Assets nach Abbruch; nur eigene temporäre Artefakte bereinigen.
8. Dokument regulär im Editor öffnen, weiterbearbeiten, Links indizieren/auflösen und den maßgeblichen serverseitigen Stand in frischem Kontext sowie nach Neustart nachweisen. Wissens-/Suchindexabschluss wird gesondert bestätigt, nicht aus Konvertierungserfolg abgeleitet.

Zwei konkret gelesene Anschlusslücken bestimmen die ersten Gegenfälle:

- `readPdfInput` bildet einen Hash, der Konverter öffnet danach den ursprünglichen Dateipfad erneut. Ohne Bytebindung könnte das Tool einen anderen Quellstand konvertieren als den gemeldeten Hash. Test: Quelle nach dem ersten Read ändern; Derivat und Provenienz müssen denselben eingefrorenen Stand besitzen oder der Auftrag muss nachvollziehbar scheitern.
- `overwrite:false` wird vor der Konvertierung in `preflightOutput` geprüft; der spätere Aufruf von `writeAgentTextFile` transportiert keinen Create-only-Anspruch. Besonders beim persönlichen Workspace kann ein inzwischen entstandenes Ziel sonst als normal vorhandener Stand behandelt werden. Test: konkurrierendes Ziel zwischen Preflight und Publish erzeugen; dessen Inhalt und Identität müssen unverändert bleiben.

Das sind quellenbelegte Konkurrenzmöglichkeiten, keine in dieser Planänderung ausgeführten PDF-Regressionen. Ein globaler Dateimodus oder eine spätere Hashprüfung ersetzt die zentral gehaltene Ziel-/Dokumentbindung nicht.

Transport- und Konverterbudgets werden pro Einstieg ehrlich ausgewiesen: Der heutige Workspace-Konverter begrenzt PDFs auf100MiB, der separate MCP-Binärimport auf25MiB. Daraus folgt keine bereits einheitliche End-to-End-Grenze; das akzeptierte Budget muss vor dem jeweiligen vollständigen Import geprüft werden. Unterstützte bestehende Ziele werden zusätzlich mit geöffnetem Peer und einem konkurrierenden Edit abgenommen, ohne dessen Inhalt oder Identität still zu ersetzen.

## 6. Sandbox: nur die zentrale Schnittstelle darf veröffentlichen

Untrusted Agentencode darf bestehende Notebook-Projektionen und deren Verzeichnisstruktur nicht direkt ändern, auch nicht zum scheinbar bequemen Reparieren eines Exports. Der Schutz umfasst Shellbefehle, Python/Node, Kindprozesse und untrusted Skillskripte. Ein Prompt oder eine Prüfung auf bestimmte Befehlstexte genügt nicht.

Die vorhandene Implementierung wird weiterverwendet: macOS verweigert `file-write*` außerhalb des privaten Scratch und die Ausgabe neuer Sandbox-Erweiterungen; Linux verwendet Landlock plus zusätzliche Seccomp-Grenzen für Metadatenänderungen. Fehlende oder nicht unterstützte OS-Sandbox führt zum Fehler, ohne ungeschützten `exec`-Fallback. Parser und Bibliotheken können im privaten Scratch arbeiten.

Der Schutz muss auch atomaren Dateiaustausch, `rename`, `unlink`, Verzeichnismutation, Symlink-/Hardlinkpfade, absolute Pfade und geerbte Kindprozesse abdecken. Physische Workspace-Dateien global schreibgeschützt zu setzen wäre unzureichend: Der vertrauenswürdige Projector, File Service und kontrollierte Import benötigen eigene Server-Schreibrechte. Diese Dienste werden nicht im untrusted Codeprozess nachgebaut oder über dessen Dateiberechtigungen freigegeben.

Alle governed Agententools, internen Skill-Bridge-Aufrufe und API-/MCP-Adapter müssen ihrerseits durch zentrale Rechte-, Versions- und Mutationsgates laufen. Ein Texttool mit direktem Dateifallback für ein bereits initialisiertes Dokument wäre weiterhin eine Umgehung, obwohl die Shell geschützt ist. Netzwerk und externe MCP-Server liegen außerhalb dieses OS-Dateischutzes; ihre Endpunkte müssen unabhängig dieselbe zentrale Autorisierung und Orchestrierung erzwingen. Insbesondere dürfen untrusted Prozesse keinen alternativen privilegierten DB-/Datei-Writer erhalten.

Deklarierte Skillskripte besitzen bereits einen gesonderten strengeren Prozess-/Toolbridge-Vertrag mit eigenen Lese-, Netzwerk-/Fork-, Umgebungs- und RPC-Grenzen. Diese Regeln werden erhalten und separat getestet. Die allgemeinere Bash-Sandbox erhält dadurch nicht automatisch dieselben Netzwerk- oder Lesegarantien.

## 7. Lieferreihenfolge und Abnahme

| Paket | Voraussetzung und konkreter Abschluss |
| --- | --- |
| U-01 zuerst | Die Undo-/Verlassenfälle aus Hauptplan §0 unterscheiden; kausaler letzter Apply-/Persistenzbeleg und unveränderte Sicherheitsguards. Keine pauschale Verlängerung von Sleeps/Timeouts. |
| YD-03 bis YD-07 | Copy/Sicherung, vollständiger Linkgraph, gezielte Mutationen, zentraler Dateiaktionsabschluss und Undo/Restore zusammen gemäß Hauptplan abnehmen. |
| YD-08S | Launcher-/Writerinventar und OS-Gegenproben; alle direkten Mutationsversuche abgewiesen, Scratch nutzbar, zentrale autorisierte Bearbeitung erfolgreich. |
| YD-08P | Tatsächliches `pdf_to_markdown` gegen Text-, Tabellen-, Unicode-, Link-, Scan-/Warnungs- und Fehlerfälle; Quell-/Zielraces, Retry, native Erstpersistenz und Wiederöffnung. Vorhandenes Ziel zusätzlich mit gebundener Identität/Generation, offenem Peer und Versionskonflikt prüfen. |
| YD-13 | API-Vertrag nach Kernabnahme; tatsächliches Python-SDK mit denselben Datei-/Text-/Linkfällen gegen die echte Schnittstelle. Keine Abnahme allein durch SDK-Mocks. |
| Integrierte Freigabe | Editor, Agent, Codeclient und PDF-Derivat bearbeiten denselben nativen Zustand; keine offenen Datenverlust-/Rechte-/Scope-/Wiederanlaufbefunde. Produktion bleibt ein eigener Rolloutauftrag. |

Die Pflichtmatrix ergänzt die vorhandenen Tests um folgende tatsächliche Abläufe:

- Datei und kompletter Ordner verschieben/kopieren/löschen, jeweils Links aus offenen und geschlossenen Quellen; relative ausgehende und eingehende Links, PDF-/Bildziele, unabhängiger paralleler Nutzeredit, neue Kopie ohne geteilte CRDT-Identität und anschließende Wiederöffnung.
- API/SDK liest Dokument, verändert Text gezielt und sieht denselben Inhalt im offenen Editor; weiterer UI-Edit bleibt erhalten. Versionskonflikt und Rechteentzug verhindern unzulässige Mutation. Gleiche Idempotenz bei verlorenem Response erzeugt genau eine Änderung.
- Parseroutput wird durch das tatsächliche Agententool als verwaltete Notiz angelegt; Original-/Derivatprovenienz stimmt, Weiterbearbeitung und zentrale Linkoperationen funktionieren. Quelle oder Ziel während Konvertierung ändern und tatsächlichen Abbruch/Retry prüfen.
- Shell/Python/Node/Kindprozess versucht direkte Änderung, Überschreiben, atomaren Ersatz, Rename und Löschen der `.md`-Projektion; Zielhash und native Version bleiben unverändert. Dieselbe fachliche Änderung über die zentrale Schnittstelle gelingt und wird dauerhaft bestätigt.
- Fehlende Sandbox blockiert den untrusted Prozess; ein Parser darf weiterhin temporäre Dateien im eigenen Scratch schreiben. Linux- und macOS-Nachweise bleiben getrennt, ebenso Quellen-, Unit-, Browser-, Neustart- und Produktionsbelege.

Arbeit erfolgt in vorhandenen geeigneten Worktrees. Unabhängige Inventare und getrennte Adapter können parallel bearbeitet werden; abhängige Implementierungen starten erst nach ihren geprüften Voraussetzungen. Gemeinsame Runtime-/PG-/Browserprüfungen am verwalteten Stack laufen koordiniert nacheinander. Diese Planerweiterung startet keinen neuen Container und keinen Produktionslauf.
