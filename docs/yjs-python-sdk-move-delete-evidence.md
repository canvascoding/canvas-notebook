# Python-SDK: zentrale Move-/Delete-Aktionen lokal abgenommen

Stand: 19. Oktober 2026. Codecommit Root `7fbfd5a3c0bbcceef28e42d53670746bd9ba557b`, QA `f75c6dda3f4a116727862bbe31cee340c32e4765` mit reiner Quellparität. Private Originalbelege: `/private/tmp/canvas-sdk-path-validation-4qbok3tk/`. Ein neuer kompilierter OAuth-/Browserlauf, Paketveröffentlichung und Websiteauslieferung gehören nicht zu dieser Abnahme.

## Ergebnis

Das unveröffentlichte Pythonpaket `canvas-notebook-python` bleibt bei `0.1.0.dev0`. Zusätzlich zu den vorhandenen Dokument- und Copyfunktionen bietet es acht explizite Methoden: `move_preview`, `move_apply`, `move_status`, `move_recover`, `delete_preview`, `delete_apply`, `delete_status`, `delete_recover`. Sie rufen die tatsächlichen registrierten MCP-Tools und zentralen nativen Dienste auf. Der Pythonclient besitzt keine eigene Datei-, Link- oder Yjs-Engine.

Requests werden vor dem ersten Await eingefroren und gegen den tatsächlichen öffentlichen Vertrag begrenzt: ein Workspace, kanonische unveränderte Pfade, geordnete Move-Roots beziehungsweise ein einzelnes natives Deleteziel, Caller-Operations-ID, tatsächliche Plan-ID und höchstens 65.536 escaped UTF-8 JSONbytes. Es gibt keine automatische Wiederholung, Statusabfrage oder Recovery. Ein fehlendes Mutationsergebnis behält die Caller-ID und Originalursache; ein empfangener Toolfehler bleibt ein empfangenes Ergebnis. Caller-ID, Serverbatch, Journal und belegter historischer Abschluss sind getrennt. Vorhandene Auth-, Transport-, Credential-, Versions- und Dependencyverträge bleiben unverändert.

Die 35 bestehenden Funktionskörper in `documents.py` und fünf bestehenden Funktionskörper in `models.py` bleiben strukturell unverändert. APIreferenz und Pythonanleitung unter `docs/product/en/developers/` beschreiben die tatsächlichen Opt-ins, Rechte, Einzel-Delete-Grenze und ausdrückliche Recovery. Das ist noch keine öffentliche Websiteverfügbarkeit.

## Frisches Paket und tatsächliche Prüfungen

Wheel und Sourcedistribution sind frisch gebaut und byteweise gegen die Paketquellen geprüft. Drei neue isolierte Umgebungen enthalten Basiswheel, MCP-Wheel beziehungsweise Basis-Sourcedistribution. Tatsächliche installierte Modulpfade, Archiv-URL/-SHA, Quellparität und die neuen Exporte sind geprüft; kein Editable- oder Quellbaumimport ersetzt die installierte Abnahme.

- Alle 63 installierten Unitfälle bestehen: 47 bestehende und 16 zusätzliche mechanische Move-/Delete-Fälle. Zwei getrennte Coreimporte ohne externe MCP-Abhängigkeiten bestehen jeweils 1/1.
- Strenges Mypy besteht auf sieben Modulen mit Sprachziel 3.10. 13 Pythonquellen und zwölf Dokumentationsblöcke bestehen die 3.10-Syntaxprüfung; die tatsächlichen Installationen verwenden Python 3.14, keinen behaupteten 3.10-Runtimeprozess.
- Abschließendes gezieltes TypeScript und Scoped-Lint enden jeweils mit gespeichertem Originalexit 0.
- Der bestehende Control-Plane-Dokumentationsgenerator erzeugt in einer frischen privaten Ausgabe 126 Seiten. Alle 13 vorhandenen Markdown-/Suchtests bestehen. Ein Websitebuild oder Deployment ist damit nicht belegt.

## Installiertes Wheel über echtes TCP und Originalhandler

Der finale Originallauf v7 endet nach 51,026 Sekunden mit Exit 0: neun SDK-Familien und die ursprüngliche anonyme HTTP-Grenze ergeben zehn Gruppen bei 73 echten TCP-HTTP-Anfragen. Die bisherigen sieben SDK-Familien behalten ihre Orakel. Der echte SDKclient verwendet das nachweislich installierte neue Wheel, tatsächlich signierte Fixturetokens, aktuelle SQL-Grants, Originalhandler und originale native Owner.

Die zwei neuen Fälle erzeugen eigene native Dokumente und einen eingehenden Link. Move erhält Dokument-ID, Lineage, Yjsbytes/Statevector sowie den physischen Inode und Inhalt und schreibt den Link zentral um. Delete archiviert dieselbe native Identität, bereinigt den Link und bindet tatsächliche Trashzeile, Originalidentität, relativen Speicherort, Inode und Bytes.

Bei beiden Aktionen wird der tatsächliche Completion-INSERT auf derselben Originalverbindung beobachtet. Erst nach realem COMMIT und unabhängig bestätigter identischer Receipt-/xmin-Sichtbarkeit geht genau dessen Rückmeldung verloren. Der SDKfehler behält die Caller-ID; Status kann den belegten Abschluss neben einem noch offenen Journal anzeigen. Ein ausdrücklicher Recover setzt dieselbe Operation fort und bewahrt ursprüngliche Attribution und Receipts. Der bestehende tatsächliche Copy-B1-ACK-Verlust bleibt ebenfalls enthalten.

Acht reine Status-/abgeschlossene Wiederholungsaufrufe vergleichen sämtliche erfassten Domainzeilen einschließlich xmin und das volle eigene DATA-Inventar. Ausgenommen bleibt ausschließlich der tatsächliche betriebliche MCP-Nutzungsverlauf. Vor jedem einzelnen Request werden reale Roomstores abgewartet; beide tatsächlichen Fixture-Workspace-Sperren werden geordnet gehalten, während Originalhandler und vollständig begrenzter Originalresponsebody ausgeführt und Vorher-/Nachherbestände verglichen werden. Identische Bytes, Status und Header erreichen den Pythonclient. Dies isoliert den echten Hintergrundprojektor; eine allgemeine Sperre sämtlicher Yjs-Schreiber wird nicht behauptet. Marker verlangen genau einen beziehungsweise drei nachgewiesene Aufrufe je Phase und insgesamt acht.

Write-Scope-Abweisungen enthalten beide neuen Werkzeuge. Nach tatsächlichem Sitzungsentzug prüfen die ursprünglichen Edit-, Copy-, Move- und Deletehandler jeweils HTTP 401. Eine bloße Pythonexception ersetzt diesen Nachweis nicht. Echte OAuth-Ausstellung oder Sitzungserneuerung sind kein neuer Fall dieser Folge.

## Erhaltene Fehlversuche und Reviewkorrektur

Die ersten fünf tatsächlichen Läufe bleiben mit Originalexit 1 und ihren Quellen/Protokollen erhalten. Der erste Lauf gibt nur einen AggregateError aus; seine ursprüngliche Detailursache ist nicht direkt beobachtet. Der zweite, nur diagnostisch erweiterte Lauf stoppt in der anonymen Toolkatalog-Leseprüfung. Nur dieser vergrößerte vollständige Katalog erhält anschließend das begrenzte 1-MiB-Lesebudget; andere anonyme Antworten bleiben auf 64 KiB begrenzt. Die folgenden zwei Läufe stoppen am zeilenstrengen Census; der identisch rekonstruierte Bundlehash und dessen Source Map binden den vierten Fehler an den tatsächlichen Zeilenvergleich. Erst v5 protokolliert die fünf veränderten Domänentabellen neben parallel weiterlaufenden realen Projektionen. Die enge Incoming-Checkpoint-Warteanordnung genügt dort nicht. Der abschließende requestgebundene Census isoliert beide eigenen Workspaces und behält den vollständigen Vergleich; keine zusätzliche Domänentabelle wird ausgeschlossen. Die Projektorkonkurrenz ist damit enger belegt, die vollständige Detailursache jedes älteren Fehlversuchs wird nicht nachträglich behauptet.

Der vorletzte tatsächliche Lauf v6 besteht bereits zehn Gruppen. Ein unabhängiges Quellenreview findet danach einen unbegrenzten, Fehler verschluckenden Cancelpfad im neuen Testreader. Vor dem finalen v7 wird Cancel auf fünf Sekunden begrenzt, der Fehler im vorhandenen Fehlerkollektor erhalten und der Reader im finally freigegeben. Das Nachreview bestätigt diese Korrektur. Eine zusätzliche Stream-Cancel-Fehlerinjektion ist daraus nicht abzuleiten.

Die erste private Dokumentationsausführung scheitert am falsch auf das nicht vorhandene Web-Unterverzeichnis gerichteten node_modules-Link. Die korrigierte eigene Verknüpfung verwendet das bestehende Control-Plane-Monorepo-node_modules; Generator und Tests bestehen anschließend. Die ursprünglichen negativen Protokolle bleiben erhalten. Paket-, Produkt- und Berechtigungsverträge werden dafür nicht geändert.

## Belege und Abschluss

`runtime-inputs-v7.json` bindet 90 tatsächliche Runtime-/Paket-/Dokumentationsquellen. `validated-summary-v1.json` bindet die 18 erfolgreichen abschließenden Programme/Artefaktprüfungen; frühere fehlgeschlagene Programme werden dadurch nicht umbenannt.

| Artefakt | SHA-256 |
| --- | --- |
| Neues Wheel, 34.279 Bytes | `bfad673788d658dff47f4b00ac747d5873ec272d057855ed1fd53153726d2897` |
| Neue Sourcedistribution, 47.932 Bytes | `4ca48ef405707848ab58abf0a499dc490ae21ba8ed0f0ff38cbbac3e4a2a4be9` |
| Finale tatsächliche Harnessquelle | `1105d3cdce1d20a34abc20fc8757b29ee6e1e4ffe5a0cff3d30adc2ead25135e` |
| Originalprotokoll v7 | `39c5fb7ed956e8eb4d1d6197a36a0e8c320ae082b887474d563377904985ef78` |
| Validierungsübersicht | `615bf1d045c8075f40508aea44de17cf3337f9e9521bf13ec37fe60792228e36` |

`resources-after-v7.json` und `all-attempts-resource-closure.json` bestätigen alle sieben bekannten Originalläufe, 14 abwesende originale Fixture-/Bundlepfade, 14 bekannte abwesende Prozesse samt Originalprozessgruppen sowie ECONNREFUSED am tatsächlich protokollierten letzten Port 62088. Eigene Testschemas und Backends sind abwesend; dieselben vier verwalteten Dienste bleiben gesund und drei Gesundheitsantworten liefern HTTP 200. Die Inventur ist READ ONLY mit XID null. Kein unbekannter historischer Prozessverlauf wird daraus abgeleitet.

Die erste inkrementelle GitNexus-Aktualisierung endet mit dem Indexfehler `Failed calling LOWER: Invalid UTF-8`. Der vollständige Neuaufbau endet nach 113,440 Sekunden mit Originalexit 0; beide Originalprotokolle bleiben erhalten. Automatisch erzeugte Änderungen ausschließlich im GitNexus-Abschnitt von AGENTS.md/CLAUDE.md sind privat gesichert und auf den unveränderten Commitstand zurückgesetzt. Die frischen gestagten Änderungsprüfungen beider Worktrees erfassen zehn Dateien und 197 Symbole bei LOW, ohne zugeordnete Abläufe; diese fehlende dynamische Zuordnung bedeutet keine behauptete Nullreichweite. `code-commit-parity.json` bestätigt dieselben 90 Quellen in beiden Commits und ausschließlich die drei geschützten Root-/QA-Unterschiede mit binärem Diff-SHA-256 `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`. Root bleibt am nativen Aktivierungsgate aus, QA an. QA belegt Quellparität und keinen zweiten SDK-Originallauf.

Noch offen sind der frische kompilierte Move-/Delete-OAuth-/Browseranschluss, weitere Datei-/Ordner-/Scene-Lifecyclefälle, Legacy-/raw-Markdown, interne native Agentenneuanlage und kontrollierter Runtimeadapter, PDFimport, breitere Suche, Standard-Skill, übrige Sandboxwege und gemeinsame Endabnahme. Der ursprüngliche Produktionsfall PREVIEW_BLOCKED ist weiterhin nicht als behoben nachgewiesen. Dateiaktions-Undo, Review Center und allgemeine Aktivierung bleiben aus; keine Paketveröffentlichung, kein Push, PR oder Produktionsrollout.
