# Aktueller Main: Dokumentautorität, Extension-Verträge und Grenzen

Stand: 18. Oktober 2026. Diese Integration ist ein Zwischenschritt des Gesamtplans; allgemeine Aktivierung und abschließende Build-/Browserabnahme bleiben offen.

Notebook-main `67c509c08a204b7481fa063cf5de007de8538dd4` und Marketplace-main `54ce6573502f67f4cb6227871000aa315ab87dbe` wurden erneut gefetcht und quellenbezogen geprüft. Der Marketplace blieb unverändert und wurde nicht veröffentlicht. Ausgangspunkt im Arbeitsbranch ist `c3e16ab763cda9ead6e0163878c4857679d54666`; der lokale Mergecommit `02e1ec874a23a7faa01b573bb39dd8128fd415a1` enthält die 14 manuellen Mergeauflösungen und erhält native Dokumentautorität und die neuen Main-Verträge gemeinsam.

## Erhaltene und korrigierte Grenzen

- Web-/Mobile-Anlage, Lese- und Uploadpfade behalten den ursprünglichen authentifizierten Request, native Commit-/Pendingzustände und den zentralen Abschlussdienst. Die neuen Scene-Verträge bleiben erhalten. Eine neue Szene wird nicht als beliebiges rohes Markdown behandelt.
- `writeFileIfAbsent` unterscheidet Main-`onStaged` vor Veröffentlichung und den opaken nativen `onPublished`-Beleg danach; native Callbacks verwenden die richtige Argumentposition.
- MCP-Suche, Legacy-Read und Edit erzeugen Direktlinks aus der beim Lesen beobachteten Identität. Nach Move/Delete darf eine spätere D2 am alten Pfad nicht mit bereits gelesenem D1-Inhalt verbunden werden. Native Suchreads halten ID und Lineage aus derselben gesperrten Katalog-/Inhaltsbeobachtung. Legacy-Snapshots belegen nur die ID; ihre Lineage bleibt `null`. Physische Reads erfinden keine IDs. Die strikte native Read-v1-Verzweigung bleibt gegenüber dem Ausgangsbranch bytegleich.
- PI behält echte Invocation-Herkunft, ausgestellte Core-/Package-/Turn-/Delegationsbindungen und monotone Werkzeuggrenzen. Planning beschreibt ausschließlich tatsächlich erlaubte Operationsnamen. Die Public-Share-Policy wählt den Main-/Special-Providervertrag anhand der bereits geprüften Agentidentität.
- Die Read/Edit-Auswahl kehrt durch Main nicht zurück. Die Quellprüfung erhält direkte Bearbeitung sowie kompakte Fokus-/Breitensteuerung; eine neue gemeinsame UI-Abnahme steht aus.

Die Staginganalyse mit GitNexus meldet die erwartete kritische Reichweite des Main-Merges: 1.557 geänderte Symbole und 95 betroffene Flows, besonders Agent-/Workflow-, Plugin-, Chat- und Workspacepfade. Der Index ist nicht frisch; die Analyse ersetzt die gezielten Quellreviews und tatsächlichen Prüfungen nicht.

## Tatsächlich abgeschlossene Prüfungen

| Prüfung | Ergebnis und Grenze |
| --- | --- |
| Extension-Gesamtgate | Fünf Metadaten-/Registryprogramme auf PGlite plus vollständiger PostgreSQL-Writer bestanden. In dieser Fixture passen zehn veröffentlichte Kindskills, elf überschreiten den Kontext; beide Choice-Grenzen und exakte Create-/Update-/Preference-Rollbacks sind geprüft. Das allgemeine Limit bleibt 8 KiB und ist keine feste Zahl von Skills. |
| Registrierte Dokumentwerkzeuge | 15/15 tatsächliche MCP-/PI-Fallgruppen auf PG18 einschließlich Runtimewrapper und Requesttransport bestanden; nach der Loaderergänzung erneut unverändert bestanden. Kein vollständiger externer OAuth-/Live-Chatturn-Nachweis. |
| Public-Share-Revoke | 60/60 echte Auth-/SQL-Fälle einschließlich Main/Special, Vererbung, explizitem `__none__`, Widerruf und unklarem Commitabschluss bestanden. |
| Native DOCX-Route | Sieben fachliche Gruppen plus Cleanup bestanden: native Autorität trotz fehlender/veralteter Projektion, Fehlzustände, tatsächlicher normaler DOCX-Leseweg, Office-Recovery, Kernel-vor-SQL-Reihenfolge und Lifecycle-Reservierung. Auth-/Rateadapter bleiben hier explizite Testseams. |
| Authentifizierte Web-/Mobile-Sitzung | Ausgewählte echte Cookie-/Bearer-HTTP-Handler-Familie für Plain/XML/Blocks einschließlich Sequenz null ohne physische Datei bestanden. Kein neuer kompletter Browserlauf. |
| Manuelle Markdown-Neuanlage | Vollständige 14/14 echte Route-/Auth-/SQL-/FS-/Prozessgruppen bestanden, einschließlich Konkurrenz, Antwortverlust, Requestbindung, Recovery, Scope-/History-/Audit- und Closefehlern. |
| Angrenzende Regressionen | Multipart-Markdown 16/16, Web-/Mobile-Completed-/Pending-DTOs, native Such-/Identitätsfälle, MCP-Read 14, PI-Read 13, Legacy-Read 6, MCP-Checkpoint 3, Dateiidentität/History/Ort, exklusive Publikation, vollständiges Planning, Creator-Discovery, PI-Registry, Sandbox und tatsächlicher lokaler Raum-Census bestanden auf ihren gebundenen Quellen. |
| Compiler/Lint | Produkt-Typecheck und Scoped-Lint bestanden. Der vollständige Typecheck bleibt wegen 69 bereits in Main vorhandener Diagnosen in Testdateien rot; der Vergleich vollständiger Diagnoseblöcke zeigt keine neue Diagnose. Vier weitere Fehler des archivierten Main-Vergleichs hängen am dort fehlenden Control-Plane-Nachbarlayout; sie werden nicht als vier Produktreparaturen gezählt. |

Alle aufgeführten Laufbelege halten ihre tatsächlichen Exits und unveränderten Quellen während des jeweiligen Laufs fest. Unabhängige Ressourcenprüfungen bestätigen den Abschluss der neuen PG-/Datei-/Prozessfixtures und unveränderte verwaltete Dienste. Die Tabellenzeilen stammen aus mehreren getrennten Läufen und sind keine Behauptung eines einzigen gemeinsamen Gesamt-E2E.

## Ursprüngliche rote Ergebnisse und Testlaufzeitkorrekturen

PGlite teilt zwischen scheinbaren Verbindungen ein Backend. Die tatsächliche Parallelinspektion nach einem Agentupdate konnte deshalb den Savepoint eines anderen Resolvers beenden (`25P01`, `SAVEPOINT canvas_ready_bootstrap`). Der reale PostgreSQL-Gegenlauf besteht. Der vollständige Gate verlangt nun ausdrücklich beide Teile: `test:extensions:context-preflight:metadata` und `test:extensions:context-preflight:writes:postgres`; `test:extensions:context-preflight` führt beide aus. Keine Budget-/Rollbackassertion wurde entfernt und kein Produktresolver für den Test serialisiert.

Die installierten PI-Pakete besitzen Import-only-Exports. Der tatsächliche ESM-Testgraph und im separaten Create-Kindprozess echte vorab importierte Paketnamespace-Objekte schließen den CJS-Ladefehler; Produkt-/Auth-/DB-/Principalmodule werden nicht durch Ergebnisattrappen ersetzt. Der feste Dokumentleserunner unterstützt zwei ausdrücklich erlaubte Suiten und hält deren tatsächliche kritische Quellmodule jeweils genau einmal. DOCX-Route und Legacy-Edit-Harness erhalten die neuen Abhängigkeiten; unerwartete Scenepfade beziehungsweise späte Pfad-ID-Lookups scheitern per Sentinel. Der DOCX-Cleanup normalisiert die reine SQL-Zählerdarstellung und schließt seine Ressourcen auch bei einer fehlgeschlagenen Assertion.

Originale liegen unter `/private/tmp/canvas-yjs-main-integration-cgi63j3r/`. `integration-proof-index.json` bindet Exits, Quellen und Logchecksummen. Dazu gehören ausdrücklich auch frühere ESM-/Fixturefehler, ein wegen der fehlerhaften Cleanup-Assertion kontrolliert beendeter eigener DOCX-Prozess und dessen nachgeprüfte Ressourcenbereinigung. Diese roten Ergebnisse werden nicht nachträglich als erfolgreiche Tests dargestellt.

## Standard-Skill und verbleibende Arbeit

Der Documents-Skill verwendet aktuelle Runtime-Discovery über `canvas_extensions` mit `action: call`, `operation: search_canvas_extensions` und `arguments.purpose: runtime`. Anschließend liest der Agent die tatsächlich autorisierte zurückgegebene Skillquelle und nur benötigte Referenzen. `action: search` entdeckt Gatewayoperationsnamen. Authoring-Metadaten verleihen keine Runtime-Leserechte. Der vorhandene Core-Loader, vollständiges Paketinventar, aktuelle Use-Rechte und echte Checksum-/Runtimebelege werden wiederverwendet; feste/leere Auswahl sowie Delegations- und Mailgrenzen bleiben wirksam.

Der unpublizierte Kandidat `75718fc7` benötigt aktualisierte Beispiele für native IDs, volle Version, opaken UTF-8-Cursor und klare Legacy-Grenzen. Native Read-Versionen sind keine Legacy-Edit-SHA-Guards. Ein interner Pythonlauf besitzt acht Toolcalls und begrenzte Frames; daraus folgt kein unbegrenzter vollständiger Dokumentread mit anschließender Mutation. SDK-/Such-/Create-/Edit-Fähigkeiten dürfen erst nach tatsächlichem Anschluss dokumentiert werden. Marketplace- und Seedbytes werden vor Auslieferung exakt abgeglichen; veröffentlichte Versionen bleiben unverändert.

Offen bleiben insbesondere der gemeinsame Suchkorpus mit Ranking und ehrlicher Abdeckung, vollständige Create-/Import-/Edit-Transporte, externes HTTP-/Python-SDK, reguläre Standard-Skill-Auslieferung, PDF-Provenienz/Import und weitere Sandboxlauncher. Main ergänzt Scene-Autorität: gemischte Yjs-/Scene-Copyoperationen benötigen den zentralen Owneranschluss einschließlich dauerhafter Herkunft/Receipts/Recovery; der enge Legacy-Guard allein deckt den nativen Owner nicht ab. Allgemeines natives Aktivierungsgate, Datei-/Ordner-Undo für alle Formate und Review Center bleiben ausgeschaltet. Ein neuer Originalbuild, gemeinsamer Browser-/Gesamt-E2E-Nachweis und PR-Veröffentlichung sind nicht durch diese Integration erledigt.
