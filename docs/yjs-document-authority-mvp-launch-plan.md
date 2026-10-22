# MVP-Launch: zentraler Dokumentkern

Stand: 22. Oktober 2026, letzter Laufabschluss um 01:41:15 UTC. **Noch nicht mergebereit.** Ziel bleibt der geprüfte eigene PR auf Main nach E2E. Dies ist die kurze Abschlussliste; Architektur im [Masterplan](./yjs-document-authority-consolidation-plan.md), Originale im [Abnahmeindex](./yjs-mvp-tool-and-restore-acceptance.md).

## Aktueller Abnahmestand

Die unverkleinerte Physical-Ownerfolge Session 79724 besteht mit Originalexit 0 / allen 36 Gruppen, Selector unset, Profiler aus und Revisionen OFF. Log `owner-physical36-settled-observer31-full36.log`, SHA `dae344a9e5433f79f0478d781716d8a6c501e05deb1f303628b7e172a0ab0f08`. Der unabhängige Abschluss um 23:39:13.419 UTC bestätigt 155 unveränderte Pins, vier geschlossene Raumruntimes / einen Owner / zehn Sockets, entfernte Schema-OID 15766967, DATA und Compiler sowie keine eigenen Backends oder vorbereiteten Transaktionen; Read-only-Prüfung zurückgerollt und Verbindung geschlossen. Gate 1 ist damit geprüft. Raw-C1 ist in `71c09176f` übernommen und mit Binding 13, neun PostgreSQL-Suiten sowie finalem Typcheck und Lint geprüft. C2 ist in `ff8f28079` mit sieben Suiten grün und unabhängig geschlossen. Cohort, finales Browser-MVP und Main-Merge bleiben offen; keine Gesamtabnahme.

Der vorausgehende Lauf 33518 bleibt RED30 (Log-SHA `a82cda2fc8aaecc24f5fcacb809d958e79356480597d7b99c923873b32195e2a`): Die exakte Rekonstruktion lokalisierte einen Dateisystemvergleich mit Baseline vor der vorhandenen Projektionsgrenze. Die minimale Beobachterfensterkorrektur (Owner-Test-SHA `07d804cb74b35cf51a9d82fe22f1572dd88dd2e6a7395892aee062916518c657`) ist übernommen und nun durch die vollständige 36er-Folge geprüft.

Die begrenzte Physical5-Planfragmentoptimierung ist in Store und Claimtest übernommen: Nur byteidentische unveränderliche Originalplanfragmente werden wiederverwendet; Current-, SQL-, Rechte- und Expiryprüfungen bleiben bytegleich. TSC 76163 und Lint 82201 enden mit Exit 0. Die echte Claimfolge 21144 besteht auf PG18 mit 40 Familien / Originalexit 0, unabhängig geschlossen um 22:50:24.047 UTC mit 155 unveränderten Pins und entfernten eigenen Ressourcen (Log-SHA `65d48fd8a3fedc2756320fc774b49136b597c1c3170c3fd511bb3acb7c64c8e8`). Frühere Pure25-/Web1-Erfolge bleiben Teilbelege; die älteren REDs bleiben RED. Als Nächstes folgt Cohort samt seinen vorgesehenen Abnahmen.

Produktionsdiagnose auf Version `2026.10.17.2`: OAuth-Probe und beide betroffenen Dokumente wurden erfolgreich als `live_yjs` gelesen (gemeldete Größen 7.787 / 22.135). Die zwei fehlerbezogenen Control-Plane-Logabfragen über sieben Tage lieferten jeweils null Treffer. Das beweist keinen Fix: Eine Move-/Delete-Vorschau oder Dateiaktion wurde in Produktion nicht ausgeführt.

## Verbindliche Reihenfolge

| Gate | Noch zu erledigen | Erfolgskriterium |
| --- | --- | --- |
| 1. Physical-Delete | **Geprüft:** Session 79724, 36/36 / Originalexit 0, unabhängig geschlossen. | Alle 36 Gruppen, Originalexit 0, Quellen unverändert, Ressourcen unabhängig geschlossen; aktuelle Rechteentzüge, Rollback, SID-B und D2 erhalten. |
| 2. Raw-C1 | **Geprüft und committet:** `71c09176f`, alle zehn vorgesehenen Suiten grün und unabhängig geschlossen. | Binding 13, Raw-PG 11, Vorbereitung 10 / Public 8 / Web 9 / Atomic 8, Copy 26 / Metadaten 15 / HTML 10 / Assets 5. Belege behalten ihren jeweiligen Quellstand; keine Snapshot-als-Update-Interpretation. |
| 3. C2 | **Geprüft und committet:** `ff8f28079`, sieben Suiten grün und unabhängig geschlossen. | Binding 19 / Pure HTML 15 / Raw-PG 14 / Copy 26 / Metadaten 15 / HTML 10 / Assets 5. Eine physische Markdown-Datei im selben Workspace mit vollständig geprüftem statischem oder externem HTML; lokale HTML-Links bleiben im MVP blockiert. Originale Birth-/Import-/Receiptbindung und historische Reads erhalten. |
| 4. Cohort | Normalen nativen/gemischten Ordner-Delete und Web-Mehrfach-Delete zentral integrieren. | Alle 43 Ownerfälle, vorhandene FD-/Planfamilien, Teil-FS/B2/ACK-Recovery, originale Identitäten, aktuelle Links, offene Räume und kein D2-/Pfad-Revival. Nicht verfügbare optionale FD-Proben bleiben ausdrücklich offen. |
| 5. Gemeinsamer Stand | Finales SDK-Wheel binden, neuestes Main konfliktfrei integrieren, Source-/Teststände und ganze Specs zusammenführen. | Keine alten Paketbasen/ganzen privaten Dateien über aktuelle Root-Hunks kopieren; Originalbelege und Companionänderungen erhalten. |
| 6. Build und E2E | Frischer Originalbuild, danach serielle eigene Runtimegruppen mit OFF-Konfiguration. | Ganze finale Specs, REST separat, MCP 10 allein mit frischem SDK, zwei echte Neustarts, unabhängiger Abschluss jeder Runtime. |
| 7. PR und Main | Eigenen PR aktualisieren, erforderliche CI-/Reviewbefunde abschließen. | Erforderliche Checks am endgültigen Head grün, keine offenen actionable Threads; danach Merge und Remote-Main verifizieren. |

Die angegebenen Cohort-Zahlen sind deklarierte Abnahmepflichten, keine bereits erfolgreichen Läufe. C2-Belege bleiben an ihren jeweiligen tatsächlichen Quellstand gebunden. Jeder Schritt wird erst nach seiner konkreten Abnahme committet/geschlossen. Kein Fertigstellungstermin wird aus privaten Source-Proofs oder laufenden Tests abgeleitet.

## Unverzichtbarer MVP-Umfang

- Direkt editierbarer Web-/Gast-/Formulareditor; manuelles Create, erster Text-Paste, Markdown-Bodyeinfügung und vollständiger Dateimport mit Weiterbearbeitung und Reload.
- Zentraler API-/MCP-/Agenten-Create/Read/Edit-Zugriff und progressive native Suche: begrenzte Treffer, stabile IDs, vollständiges kontrolliertes Weiterlesen.
- Sichere Move/Rename/Copy/Delete-Aktionen samt zentraler Linkpflege, normalen unterstützten Ordnern/Assets, offenen Ansichten und Wiederaufnahme desselben ursprünglichen Auftrags.
- Tatsächlicher Agenten-Schreibschutz für verwaltete Projektionen. Kein erfolgreicher Raw-FS-Fallback darf zentrale Orchestrierung umgehen.
- Optionale Revisionen, Review Center und Dateiaktions-Undo OFF; Änderungen funktionieren ohne zusätzliche Annahme.

HTML/MDX/Custom-Strukturen und besondere Overwrite-/Cross-Workspace-Fälle dürfen im nicht freigegebenen Schnitt präzise vor Wirkung blockieren. Normale native/gemischte Ordner werden dadurch nicht aus dem MVP entfernt.

## Finale Prüfung

Die [bestehende E2E-Matrix](./yjs-mvp-e2e-matrix.md) zählt nach privaten Viewerfällen 80 geplante Fälle in 20 ganzen Specs plus 6 separate REST-Fälle. Zwei ebenfalls private Cohort-Browserfälle erweitern den Plan voraussichtlich auf 82; verbindlich sind erst finale Quellenübernahme und echte Discovery. Keine fokussierte Probe, kein Skip und kein älterer Browserpass ersetzen die komplette Auswahl. MCP 10 muss nach dem vorbereiteten OFF-Anschluss mit effektiver Revision-OFF-Konfiguration und Null-Capture-Orakel laufen; frühere Shadow-Evidenz zählt nicht dafür.

Für den Main-Merge gelten der finale Originalbuild, die gebundene MVP-E2E-Auswahl und die tatsächlich erforderlichen CI-/Reviewprüfungen am endgültigen Head. Der originale `npm run test:all` ist weiterhin nicht grün und durch diese Teilabnahme nicht abgedeckt: zuletzt 234 bestanden, 218 fehlgeschlagen, 269 übersprungen, 88 nicht ausgeführt. Seine konkreten Befunde bleiben zu erklären oder zu beheben; vor jedem späteren Produktionsdeploy ist `npm run test:all` gemäß Repositoryvorgabe erforderlich. [Erhaltene Lücke](./yjs-mvp-full-test-runner-gap.md).

Der letzte dokumentierte Remoteabgleich nennt eigenen PR [#176](https://github.com/canvascoding/canvas-notebook/pull/176) konfliktbehaftet und Main `14c1a6c6a5f89d98523283a2c7f96aeba8c0eb4c`. Vor der finalen Integration erneut prüfen. Frühere CI-Erfolge decken nur ihren veröffentlichten Head ab. Produktionsauslieferung und die Behebung des ursprünglichen Produktionsfalls werden erst separat auf tatsächlich ausgelieferter Version bestätigt.

Bestehende spätere Arbeiten wie SDK-Paketveröffentlichung, vollständiger PDF-Parserimport, breitere Suche und Standard-Skill werden hier nicht erweitert und nicht vorsorglich zu neuen Launchpaketen gemacht. Bereits geparster PDF-Text und vorhandene SDK-Quellen beweisen diese vollständigen Anschlüsse nicht.


<details>
<summary>Erhaltene historische Abschnittsanker</summary>

Die früheren Abschnittsnummern führen zum konsolidierten historischen [Evidenzindex](./yjs-mvp-tool-and-restore-acceptance.md#historische-evidenz-lesen). Maßgeblich sind die aktuellen Verträge oben.

<a id="aktuelle-entscheidung-für-den-launch"></a>
<a id="komplexität-und-bewusste-mvp-grenze"></a>
<a id="ergänzung-linkindex-und-offene-ansichten"></a>
<a id="bisherige-teilnachweise-und-historische-fehlerstände"></a>
<a id="historischer-ausgangspunkt"></a>
<a id="erster-veröffentlichungsumfang"></a>
<a id="verbindliche-launch-gates"></a>
<a id="m1--alltägliche-bestehende-dokumente-und-dateiaktionen"></a>
<a id="m2--produktionsaktivierung-und-einheitlicher-schreibweg"></a>
<a id="m3--gemeinsame-abnahme-und-main-merge"></a>
<a id="nachgelagerte-roadmap-weiter-offen"></a>
<a id="nächster-umsetzungsschritt"></a>

</details>
