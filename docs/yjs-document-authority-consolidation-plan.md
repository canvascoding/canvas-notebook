# Plan: zentraler Dokumentkern und sichere Dateiaktionen

Stand: 23. Oktober 2026. **MVP-Abnahmestatus.** Produktstand `7c24a631860787d668aea288b6573d7a48e3b6f0`. Originalbuild98775/94a4b3, Quellen- und Artefaktprüfung sind bestanden. Die funktionale MVP-Abnahme ist im unveränderten Umfang mit 94 bestandenen Fällen in 23 ganzen Specs abgeschlossen: originale8e2-MCP10/1 und UI67/17 werden aufgrund belegter Produkt-/Orakelparität wiederverwendet (77/18); auf7c24 sind Rest-UI9/3 sowie Restart2/1 und REST6/1 neu bestanden (17/5). Dies ist die ausdrücklich erlaubte Komposition mehrerer echter Läufe, kein einzelner frischer Whole94-Lauf. Der ursprüngliche8e2-UI76-RED67/3/6 bleibt unverändert. Rest-UI9 endet mit Original4778/49c0a6 Exit0,9/9 und14/14 Abschlusschecks. Die gemeinsame remaining10-Runtime endet mit Original33018/94b3ac Exit0,10/10 und14/14 Abschlusschecks: Restart2 zuerst mit zwei echten Neustarts, danach REST6 und zuletzt Metadata2. Nur die acht Restart-/REST-Fälle zählen zu94; Metadata2 ist ein bestandener Zusatztest. PI12 ist separat mit Original47754/d72e6c Exit0 und12/12 bestanden;42 kritische Quellen unverändert, tatsächliches Bundle1273. Der unabhängige Abschluss bestätigt PG18 RR/RO, initial/final XIDnull, SchemaName/OID abwesend, drei App-Backends0, vorbereitete Transaktionen0, ROLLBACK und abgewartetes Client-Ende. Die verpassten anfänglichen DATA-/Compiler-/PID-Identitäten bleiben ausdrücklich NULL; keine vollständige Startup-Erfassung wird behauptet. Die vier von Root visuell geprüften Bilder bleiben Originalaufnahmen von8e2 mit belegter Produktparität, keine neuen7c24-Aufnahmen. Der Code-CI-Snapshot auf7c24 ist mit sieben erfolgreichen Checks abgeschlossen. Er nimmt den späteren Dokumentations-Head nicht vorweg: dessen erforderliche CI, vollständige Reviews, Main-Frische und tatsächlicher Merge/Remote-Main-Abschluss sind über [PR #176](https://github.com/canvascoding/canvas-notebook/pull/176) noch frisch zu prüfen. Keine Main-/Produktionsfreigabe oder künftige Commit-/Merge-SHA wird vorweggenommen. A4 (`a4a725d0d`) behält Build, History-Unit18, gezielte Typprüfung und PG43/43 mit 220 Pins sowie unabhängigem Ressourcenabschluss. MCP10 besteht dort 10/10 und alle 14 Abschlusschecks. UI76 bleibt RED49/1/26; nach eigener Bereinigung sind elf Ressourcen-/Quellenchecks wahr, die drei ursprünglichen Abnahmechecks bleiben falsch. Diese Ergebnisse werden nicht auf den neuen Produktstand übertragen. EB9 (`eb9e9c304`) besteht Build und MCP10/10 mit allen 14 Abschlusschecks; UI76 bleibt RED62/2/12. Beide Fehler erfassen nachweislich die Preview-Antwort statt Apply. Nach eigener Bereinigung sind die elf Ressourcen-/Quellenchecks wahr; die drei ursprünglichen Abnahmechecks bleiben falsch. Revisionen, Review Center und Dateiaktions-Undo bleiben OFF. Reihenfolge im [Launchplan](./yjs-document-authority-mvp-launch-plan.md), Originalbelege im [Abnahmeindex](./yjs-mvp-tool-and-restore-acceptance.md).

## Verbindlicher Umfang

| Bereich | Verbindlicher Vertrag | Stand |
| --- | --- | --- |
| Dokumentkern | Initialisiertes Yjs führt Inhalt; PostgreSQL bestätigt Persistenz; Markdown bleibt abgeleitete Projektion. | Grundkern und Anschlüsse sind vorhanden. Original `8e2d7096b`-Build, gezielte Matcher-Typprüfung, Quellen-/Artefaktprüfung und MCP10 sind bestanden; Produktparität zu `7c24a631` ist belegt. Gemeinsame Abnahme bestanden:94 Fälle/23 ganze Specs in der erlaubten Komposition77+17. |
| Editor | Direkt editierbar unter tatsächlichen Rechten, ohne Read/Edit-Auswahl. Breite und Dokumentfokus kompakt in der Kopfzeile. | Implementiert und mit früheren Einzelbelegen geprüft. Manual15 auf `8e2d7096b` und Recovery2 sind innerhalb der wiederverwendeten 67/17 bestanden; drei originale Editorbilder von `8e2d7096b` sind visuell geprüft. UI76 ist kombiniert mit76 Fällen in20 Specs bestanden:67 originale Fälle plus neun neue; kein neuer einzelnerWholeUI76-Lauf. |
| Anlage und Import | Manuelles neues Dokument, erster Text-Paste, bewusste Markdown-Einfügung sowie vollständiger Dateiimport erhalten Inhalt und Identität. | Create/Paste/Import15 und ManualRecovery2 sind original auf `8e2d7096b` bestanden und mit Quellparität wiederverwendbar. UI76 ist kombiniert mit76 Fällen in20 Specs bestanden:67 Originalfälle plus neun neue; kein neuer einzelnerWholeUI76-Lauf. |
| Lesen, Editieren, Suche | Web, REST, MCP und Agent verwenden denselben autorisierten Kern. Suche liefert begrenzte Treffer mit stabilen IDs; danach vollständiger ID-/Cursorread. | Native progressive Suche und ID-Read sowie Create/Edit sind durch den originalen `8e2d7096b`-MCP10-/SDK7-Lauf mit Produktparität belegt; REST6 ist 6/6 bestanden als mittlere Spec der gemeinsamen remaining10-Runtime, deren14 Abschlusschecks sind wahr. Keine vollständige Suche über PDF-/Scene-Inhalte behauptet. |
| Dateiaktionen | Move/Rename, Copy und Delete aktualisieren aktuelle zentrale Links, erhalten offene Ansichten und erlauben gebundene Wiederaufnahme. | Move und Copy sind im belegten Teilumfang geprüft. Physical36, Raw-C1 (`71c09176f`), C2 (`ff8f28079`) und Cohort (`59fd6cf35`) behalten ihre Originalbelege. FD46: 45 bestanden, ein ausdrücklich benannter macOS-EXDEV-Skip, kein Fehler. History-PG43/43 mit 220 Pins bleibt an A4 gebunden. EB9-UI76 ist RED62/2/12 und unabhängig bereinigt; der Apply-Responsefilter ist korrigiert, alle Fachorakel bleiben erhalten. Gemeinsame E2E-Abnahme bestanden:94 Fälle/23 ganze Specs in der erlaubten Komposition77+17. |
| Agentenschutz | Shell/Python/Skillprozesse dürfen initialisierte Markdownprojektionen nicht direkt verändern. Autorisierte Änderungen laufen durch die Schnittstelle. | Frühere Agenten- und Linux-Schutzbelege behalten ihre Bindung. Rest-UI9 einschließlich Sandbox1 besteht9/9: Original4778/49c0a6 Exit0 und14/14 Abschlusschecks. PI12 besteht separat12/12: Original47754/d72e6c Exit0,42 Quellen unverändert und unabhängig geschlossen. |
| Python-SDK | Dünner Client für denselben Dienst, keine zweite Dokument-/Linkimplementierung. | Das Wheel `d7ffd8c2` wurde auf `f89086b2e` gebaut und installiert; Core 1 / MCP 74 und pipchecks bleiben historisch. SDK17, PI42, OAuth-Helfer und installierte Modulbytes sind auf dem Originalstand `8e2d7096b` identisch belegt; der originale `8e2d7096b`-SDK7-/OAuth-/Create-/Edit-/Editor-Reload-Nachweis besteht mit belegter Produktparität. Keine SDK-Move-/Delete-, vollständige PDF-Parser- oder veröffentlichte PyPI-Abnahme behauptet. |

## Autorität und Dauerhaftigkeit

1. Ein initialisiertes Dokument wird niemals aus einer älteren oder leeren `.md`-Datei neu aufgebaut. Fehlende Yjs-Daten sind ein Konflikt. Ein geschlossener Raum ändert die Autorität nicht.
2. Sichtbarkeit, dauerhaft gespeicherter Inhalt, Pfadabschluss und Dateiprojektion sind getrennte Zustände. Ein Exportfehler macht bestätigte native Persistenz nicht rückgängig.
3. Reads binden Identität, Generation, echte Yjs-Bytes, Vector und löschungsinklusiven Zustandsbeleg an denselben Read. Neue Live-Inhalte erhalten keinen alten Persistenzbeleg.
4. Strukturelles Lesen und native Linkpflege benötigen keinen erfolgreichen Markdownexport. Export bleibt separat streng auf Verlustfreiheit geprüft.
5. API, MCP, Agent und SDK erhalten dieselben aktuellen Rechte-, Ownership-, Admission-, Byte- und Konfliktprüfungen. Keine Disk-Rückfalloption umgeht den Kern.
6. Kopien erhalten neue Dokument-/Lineage-/Blockidentitäten. Ein späteres D2 am alten Pfad übernimmt weder alte Identität noch Operationsbelege.

## Dateiaktionen und zentrale Links

Das bestehende aktuelle Linkinventar und der native Graph bleiben die Grundlage. Vorschau liest vollständig und schreibt nicht. Der Plan bindet Auswahl, Quellen, Zielauflösung und Coverage; unbekannte oder unlesbare Quellen werden nicht still ausgelassen.

Der zentrale Owner behält den Ablauf: ursprüngliche Auswahl und Rechte binden → Räume drainen und aktuelle Zustände prüfen → dauerhaften ursprünglichen Intent speichern → gepinnte FD-Dateiaktion → native Link-/Archiv-/Metadatenänderungen und Abschlussbeleg atomar bestätigen. Der Status unterscheidet ausstehend, bestätigt, Konflikt und unklaren Ausgang. Ein erfolgreicher FS-Rename allein bestätigt keine Notebookoperation.

Wiederaufnahme verwendet denselben ursprünglichen Auftrag mit frischen Rechten. Sie behandelt teilweise FS-Wirkung, B2-Rollback und verlorene COMMIT-Bestätigung, ohne blind erneut anzuwenden oder heutige D2-Bytes als historische Originale zu übernehmen. Geschlossene und geöffnete Räume, gemeinsame Backlinkquellen und konkurrierende Nutzeränderungen gehören zur Abnahme.

Normale native/gemischte Ordner mit Notizen und PNG/PDF sowie Web-Mehrfach-Delete gehören zum MVP. Der Cohort-Backendanschluss ist in `59fd6cf35` mit der ganzen 43er-Ownerfolge und den vorhandenen FD-/Planfamilien geprüft; die finale Browserabnahme ist durch die oben gebundene94/23-Komposition abgeschlossen. Betroffenes beziehungsweise unklar bewertbares HTML/MDX, unbekannte Custom-Strukturen und nicht freigegebenes Overwrite dürfen vor Wirkung präzise blockieren. Daraus folgt kein pauschaler Ausschluss normaler Ordner.

Kein neuer persistenter universeller Linkindex oder versionierter Linkgraph wird für den Launch gebaut. Vorhandene aktuelle Daten und gezielte Abfragen werden genutzt; Effizienzänderungen brauchen konkrete Messungen unter unveränderten Schutz- und Zeitgrenzen.

## Neues Dokument, Paste und Markdown

- Neues Dokument über den tatsächlichen UI-Einstieg öffnen und nachweislich die richtige native Identität initialisieren. Der erste Paste darf weder verloren gehen noch durch einen späteren leeren Bootstrap überschrieben werden.
- Normales Paste behält die vorhandenen Text-/HTML-/URL-/Wiki-/Mention-/Code-Regeln. Es gibt keine neue automatische Voll-Markdown-Erkennung.
- „Markdown einfügen“ übernimmt bewusst unterstützten Body an der aktuellen Auswahl. Frontmatter oder nicht sicher unterstützter Inhalt wird nicht still gekürzt; der Entwurf bleibt erhalten.
- Vollständige `.md`-Dateien gehen durch den kontrollierten Import mit Zielbindung, Metadaten und definiertem Source-Vertrag. BOM/CRLF, Unicode, relative Links und Assets sowie Kollision, Retry, Rechteentzug und spätere Nutzeränderungen werden geprüft.
- Danach weiter editieren, schließen, neu öffnen und reloaden; zusätzlich aus Serverpersistenz und in frischem Browserkontext lesen. Zwei eigenständige Paste-Aktionen bleiben zwei Eingaben; ein Importretry wird dedupliziert.

Der vorhandene PDF-Helper ist davon getrennt: bereits geparster Text kann zentral angelegt werden. Die vollständige Kette vom echten PDF über Parser/OCR/Assets zum bearbeitbaren Notebook mit Quell-/Derivatbindung ist weiter offen und wird nicht aus erzeugten Markdownbytes oder einem bewegten PDF abgeleitet. Sie ist kein zusätzliches neues Launchpaket.

## Editor und Oberflächen

Read/Edit-Auswahl entfällt auf Dokument-, Formular- und Gasteditoren; tatsächliche Schreibrechte bleiben maßgeblich. Reine fachliche Vorschauen und Binäransichten behalten ihre Funktion. Unterstütztes Source liegt im vorhandenen Mehr-Menü; Rich-Yjs wird nicht für einen Darstellungswechsel umgeschrieben.

Der horizontale Button steuert Dokumentbreite, keine Panelorientierung. Fokus blendet Notebookpanels aus, keine Browser-Fullscreen-API. Breite/Fokus sitzen auf Desktop in der Dokumentkopfzeile, bei engem Platz im vorhandenen Menü. Mobil, Gast und Formularfelder erhalten nur sinnvolle Aktionen. Tastatur, Escape, Auswahl, Scroll, Draft-Owner, lange Titel und Safe Areas dürfen keine zweite Sitzung oder Inhaltsmutation erzeugen.

## Ausdrücklich ausgeschaltet

Optionale Revisionen bleiben OFF und werden in diesem Auftrag nicht weiter gebaut. Review Center und Dateiaktions-Undo bleiben OFF; gewöhnliche Änderungen verlangen keine zusätzliche Annahme. Das bestehende Editor-Text-Undo bleibt davon getrennt. Unveränderliche Operations-/Import-/Recoverybelege und aktuelle Konfliktprüfungen bleiben erforderlich; sie sind keine optionale Dokumenthistorie.

Beim finalen Build und jeder Runtime werden der effektive OFF-Modus, die deaktivierte Review-Verfügbarkeit und der zentrale Undo-OFF-Vertrag geprüft. Alte Shadow-Läufe oder grüne Checks eines älteren PR-Heads ersetzen das nicht. Produktivschalter und ursprünglicher Produktionsfehler bleiben bis zur tatsächlichen Auslieferung separat unbestätigt.

## Abschluss und Grenzen

Abschlussreihenfolge: Originalbuild und unabhängige Quellen-/Artefaktprüfung sind bestanden. Die funktionale MVP-Abnahme ist im unveränderten Umfang mit 94 bestandenen Fällen in 23 ganzen Specs abgeschlossen: originale8e2-MCP10/1 und UI67/17 werden aufgrund belegter Produkt-/Orakelparität wiederverwendet (77/18); auf7c24 sind Rest-UI9/3 sowie Restart2/1 und REST6/1 neu bestanden (17/5). Dies ist die ausdrücklich erlaubte Komposition mehrerer echter Läufe, kein einzelner frischer Whole94-Lauf. Der ursprüngliche8e2-UI76-RED67/3/6 bleibt unverändert. Rest-UI9 endet mit Original4778/49c0a6 Exit0,9/9 und14/14 Abschlusschecks. Die gemeinsame remaining10-Runtime endet mit Original33018/94b3ac Exit0,10/10 und14/14 Abschlusschecks: Restart2 zuerst mit zwei echten Neustarts, danach REST6 und zuletzt Metadata2. Nur die acht Restart-/REST-Fälle zählen zu94; Metadata2 ist ein bestandener Zusatztest. PI12 ist separat mit Original47754/d72e6c Exit0 und12/12 bestanden;42 kritische Quellen unverändert, tatsächliches Bundle1273. Der unabhängige Abschluss bestätigt PG18 RR/RO, initial/final XIDnull, SchemaName/OID abwesend, drei App-Backends0, vorbereitete Transaktionen0, ROLLBACK und abgewartetes Client-Ende. Die verpassten anfänglichen DATA-/Compiler-/PID-Identitäten bleiben ausdrücklich NULL; keine vollständige Startup-Erfassung wird behauptet. Abschließende Dokumentation und vier Originalbilder vorbereiten; danach die noch offenen finalen CI-/Review-/Main-Schritte über [PR #176](https://github.com/canvascoding/canvas-notebook/pull/176) abschließen. ADVANCE `7c40597a9`, Archivstand `59d9c7a87` und spätere PG43-Belege behalten ihre ursprüngliche Bindung. Frühere Build-/MCP10-Erfolge auf `92015fc56`, `6488d372e`, `ef727f241` und `63edd01f` sowie UI76-REDs bleiben historisch. `2003929e4` bleibt RED61/1/14, `0b0f0f560` RED26/2/48, DD8 RED27/1/48 A4 RED49/1/26 und EB9 RED62/2/12; ihre Ressourcen sind geschlossen. SDK-/Quellenparität und Cleanup allein sind keine neue Produktabnahme; die erlaubte vollständige94/23-Komposition ist gesondert belegt. Jeweils nur eine Runtime bis zu ihrem vollständigen Abschluss.

Die [Launch-Gates](./yjs-document-authority-mvp-launch-plan.md) bleiben verbindlich. [E2E-Matrix](./yjs-mvp-e2e-matrix.md), [finale Abnahmevorbereitung](./yjs-mvp-final-acceptance-evidence.md) und [roter Gesamtcheck](./yjs-mvp-full-test-runner-gap.md) werden auf dem finalen Stand abgeglichen. Historische Zählungen oder private Source-Pakete sind keine aktuelle Freigabe.

Die ursprüngliche Produktionsmeldung `PREVIEW_BLOCKED / uninspected-source` ist nicht als behoben nachgewiesen. Kontrollierte lokale Gegenfälle und aktueller Produktionsread sind getrennte Belege. Ohne echte erneute Aktion auf der ausgelieferten Version wird keine Produktionsbehebung behauptet.


<details>
<summary>Erhaltene historische Abschnittsanker</summary>

Die früheren Abschnittsnummern führen zum konsolidierten historischen [Evidenzindex](./yjs-mvp-tool-and-restore-acceptance.md#historische-evidenz-lesen). Maßgeblich sind die aktuellen Verträge oben.

<a id="komplexität-begrenzen-verbindliche-trennung-für-das-mvp"></a>
<a id="nutzerergänzung-persistenter-linkindex-und-offen-bleibende-dokumente"></a>
<a id="plan-yjs-dokumentautorität-und-sichere-dateiaktionen-konsolidieren"></a>
<a id="restarbeiten-bis-zum-vollständigen-ergebnis"></a>
<a id="verbindlicher-aktueller-status"></a>
<a id="quellengebundene-historie-der-umsetzung-und-nachweise"></a>
<a id="0-zuerst-undo-verlassen-und-bestätigte-speicherung"></a>
<a id="1-ausgangspunkt-und-überprüfter-fehlerfall"></a>
<a id="11-was-in-dieser-untersuchung-bestätigt-wurde"></a>
<a id="12-was-dieser-fall-architektonisch-zeigt"></a>
<a id="2-zielbild-und-verbindliche-invarianten"></a>
<a id="3-bestandsaufnahme-vorhandene-grundlagen-und-lücken"></a>
<a id="31-vorläufige-auswirkungsanalyse"></a>
<a id="4-geltungsbereich-und-abgrenzung"></a>
<a id="41-bestandteil-der-konsolidierung"></a>
<a id="42-eigenständige-verträge-die-erhalten-bleiben"></a>
<a id="43-nachgelagerte-beziehungsweise-ausgeschlossene-arbeiten"></a>
<a id="5-gemeinsame-interne-document-service-fähigkeiten"></a>
<a id="51-vorgeschlagene-fähigkeiten"></a>
<a id="52-snapshot--und-frischevertrag"></a>
<a id="53-autoritätsklassen-und-initialisierung"></a>
<a id="6-linkprüfung-ohne-pflicht-zur-markdown-projektion"></a>
<a id="61-repräsentationsspezifische-prüfung"></a>
<a id="62-link-referenzen-und-vorbedingungen"></a>
<a id="63-vollständigkeit-und-betroffene-quellen"></a>
<a id="64-gezielte-mutation"></a>
<a id="7-dateiaktions-koordinator-sicherer-zielablauf"></a>
<a id="71-planen"></a>
<a id="72-ausführen-und-bestätigen"></a>
<a id="73-abschlussvertrag"></a>
<a id="74-retry-konflikte-und-unklarer-ausgang"></a>
<a id="8-backup-copy-delete-undo-und-restore"></a>
<a id="81-autoritative-recovery-artefakte-als-p0-voraussetzung"></a>
<a id="82-copy-und-initialer-import"></a>
<a id="83-delete-und-papierkorb"></a>
<a id="84-undo-und-restore"></a>
<a id="85-neues-dokument-text-einfügen-und-markdown-importieren"></a>
<a id="86-pdf-konvertierung-ist-ein-kontrollierter-dokumentimport"></a>
<a id="9-writer-reader-und-abgeleitete-verbraucher-vereinheitlichen"></a>
<a id="10-ui-fehlerverträge-und-observability"></a>
<a id="101-nutzerverständliche-zustände"></a>
<a id="102-direkt-editierbarer-inhalt-als-standard"></a>
<a id="103-platzierung-von-dokumentbreite-und-vollbildfokus"></a>
<a id="104-fachliche-fehlerklassen"></a>
<a id="105-messbarkeit"></a>
<a id="11-leistungs--und-konsistenzoptimierung"></a>
<a id="12-umsetzung-im-worktree-mit-abhängigkeiten-und-abschluss-gates"></a>
<a id="121-checkliste-für-die-gemeinsame-fortschreibung"></a>
<a id="122-konkrete-ui-liefergegenstände-innerhalb-yd-10"></a>
<a id="123-worktree-regeln-und-parallelisierbare-pakete"></a>
<a id="13-verpflichtende-abnahmematrix"></a>
<a id="131-bestehende-testgrundlagen"></a>
<a id="132-integrierte-prüfungen-und-umgebungsregeln"></a>
<a id="133-verbindlicher-manueller-createpasteimport-abnahmelauf"></a>
<a id="14-migration-rückstände-und-rollout"></a>
<a id="141-additive-verträge-zuerst"></a>
<a id="142-vor-dem-rollout-lesen-und-messen"></a>
<a id="143-kontrollierte-aktivierung"></a>
<a id="144-rollback-ohne-zweite-wahrheit"></a>
<a id="15-separate-behandlung-des-aktuellen-transkripts"></a>
<a id="16-offene-entscheidungen-für-unsere-gemeinsame-prüfung"></a>
<a id="161-umsetzungsvorgaben-und-yd-00-nachweis"></a>
<a id="162-implementierungsnachweise-und-verbleibende-abnahmen"></a>
<a id="history-lineage-deterministischer-gegenfall-und-korrekturentwurf"></a>
<a id="v12-historykorrektur-im-browser-bestätigt-link-fixture-vor-navigation-gestoppt"></a>
<a id="v13-frisches-wiederöffnen-bringt-entfernte-eigenänderung-zurück"></a>
<a id="v14-u-01-und-enge-web-abnahme-i-07-bestanden"></a>
<a id="yd-08s-privilegierte-suchprozesse-gegen-options-konfigurationseinfluss-abgesichert"></a>
<a id="native-dateiaktionsbelege-explizite-formatgrenze-vor-dem-koordinatoranschluss"></a>
<a id="17-änderungs--und-nachweisprotokoll"></a>
<a id="historische-zwischenstände-vor-v14"></a>

</details>
