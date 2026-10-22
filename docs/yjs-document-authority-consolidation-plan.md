# Plan: zentraler Dokumentkern und sichere Dateiaktionen

Stand: 22. Oktober 2026. Der Auftrag endet mit gemeinsamer E2E-Abnahme und Merge des eigenen PR auf Main. Der MVP ist noch nicht freigegeben. Aktuelle Arbeit und Reihenfolge stehen im [Launchplan](./yjs-document-authority-mvp-launch-plan.md); prüfbare Ergebnisse und erhaltene Originalverweise im [Abnahmeindex](./yjs-mvp-tool-and-restore-acceptance.md).

## Verbindlicher Umfang

| Bereich | Verbindlicher Vertrag | Stand |
| --- | --- | --- |
| Dokumentkern | Initialisiertes Yjs führt Inhalt; PostgreSQL bestätigt Persistenz; Markdown bleibt abgeleitete Projektion. | Grundkern, API-/MCP-/Agentenanschlüsse und frühere lokale Teilabnahmen vorhanden. Finale gemeinsame Abnahme offen. |
| Editor | Direkt editierbar unter tatsächlichen Rechten, ohne Read/Edit-Auswahl. Breite und Dokumentfokus kompakt in der Kopfzeile. | Implementiert und früher lokal geprüft; aktueller integrierter Browserlauf offen. |
| Anlage und Import | Manuelles neues Dokument, erster Text-Paste, bewusste Markdown-Einfügung sowie vollständiger Dateiimport erhalten Inhalt und Identität. | Zentrale Create-/Importwege vorhanden; finale Create/Paste/Import- und Recoveryfälle verpflichtend. |
| Lesen, Editieren, Suche | Web, REST, MCP und Agent verwenden denselben autorisierten Kern. Suche liefert begrenzte Treffer mit stabilen IDs; danach vollständiger ID-/Cursorread. | Native progressive Suche und Read/Edit/Create lokal angeschlossen. Keine Behauptung vollständiger Suche über PDF-/Scene-Inhalte. |
| Dateiaktionen | Move/Rename, Copy und Delete aktualisieren aktuelle zentrale Links, erhalten offene Ansichten und erlauben gebundene Wiederaufnahme. | Move und Copy im belegten Teilumfang abgeschlossen. Physical-Delete mit 36 PG18-Gruppen und Raw-C1 mit zehn Suiten geprüft (`71c09176f`); C2 und Cohort-Ordner-/Mehrfach-Delete offen. |
| Agentenschutz | Shell/Python/Skillprozesse dürfen initialisierte Markdownprojektionen nicht direkt verändern. Autorisierte Änderungen laufen durch die Schnittstelle. | Zentraler Agenten-Create-/Editweg und Linux-/CI-Schutz lokal belegt; finaler integrierter Stand erneut prüfen. |
| Python-SDK | Dünner Client für denselben Dienst, keine zweite Dokument-/Linkimplementierung. | Paketquellen und installierte Wheel-Tests vorhanden. Frisches finales Wheel und echter SDK-/MCP-Anschluss bleiben Pflicht. Keine veröffentlichte PyPI-Version behaupten. |

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

Normale native/gemischte Ordner mit Notizen und PNG/PDF sowie Web-Mehrfach-Delete gehören zum MVP. Der private Cohort-Anschluss ist noch kein Produkt- oder Laufzeitnachweis. Betroffenes beziehungsweise unklar bewertbares HTML/MDX, unbekannte Custom-Strukturen und nicht freigegebenes Overwrite dürfen vor Wirkung präzise blockieren. Daraus folgt kein pauschaler Ausschluss normaler Ordner.

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

Abschlussreihenfolge: aktuelles Physical-Delete-Gate vollständig grün → fixed Raw-C1 → fixed C2 → Cohort mit echten Owner-/FD-/Recoveryprüfungen → frisches SDK/Main-Integration → Originalbuild und vollständige finale Matrix → erforderliche CI-/Reviewchecks → eigener Main-Merge. Je Todo erst Abnahme und unabhängiger Ressourcenabschluss, dann das nächste Produktpaket. Unabhängige Quellenprüfungen können parallel erfolgen; nie parallele Teststacks.

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
