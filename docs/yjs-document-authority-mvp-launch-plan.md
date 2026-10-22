# MVP-Launch: zentraler Dokumentkern

Stand: 22. Oktober 2026. **Noch nicht mergebereit.** Originalbuild und MCP10 auf `ef727f241` sind grün; UI76 endet mit 35 bestanden / drei Setupfehlern / 38 nicht ausgeführt. Alle elf SharedHTML-Fälle bestehen. Die fehlgeschlagene Fixture ist geschlossen. Testfixturefix `88a9f1de8` ist übernommen; als Nächstes neuer Originalbuild und vollständige gemeinsame Abnahme. Ziel bleibt der geprüfte eigene PR auf Main; Architektur im [Masterplan](./yjs-document-authority-consolidation-plan.md), Originale im [Abnahmeindex](./yjs-mvp-tool-and-restore-acceptance.md).

## Aktueller Abnahmestand

Der Originalbuild und der echte MCP10-Lauf auf `ef727f241` bestehen mit Originalexit 0: zehn Fälle, darunter installiertes SDK in Fall 7, 18 echte OFF-/Null-Capture-Proben und alle 14 Abschlusschecks. Der anschließende UI76-Lauf endet RED: 38 ausgeführt / 35 bestanden / drei fehlgeschlagen / 38 nicht ausgeführt. Alle elf SharedHTML-Fälle einschließlich C6, Desktop/iPhone und Plaintext bestehen. Die drei Query-Loading-Fälle scheitern vor jeder Bootstrap-/History-/Retry-Prüfung am ersten echten Session-POST mit 409 `RUNTIME_CATALOG_NOT_CONFIGURED`. Nach dem gezielten Cleanup sind beide eigenen DBs, DATA/TMP und Prozesse entfernt; der Originalfehler bleibt unverändert dokumentiert. Die elf Ressourcen-/Quellenchecks bestehen, die drei Erfolgskriterien bleiben ausdrücklich rot. Restart2 und REST6 sind nicht ausgeführt.

Editorfix `e5db3c1f4` besteht Location-Client-/Store-Adoption-Units, Typprüfung 225 und Lint sowie nun die konkrete C6-Prüfung innerhalb SharedHTML11 auf `ef727f241`. Workerfix `83ffea371` besteht die ganze Owner-PG-Folge 22 einschließlich vier echter Busy-/Scheduler-Unterfälle, Scheduling47, Typprüfung 226 und Lint. Der letzte veraltete Undo-Test prüft OFF-409 und unterdrückte Ausführung. Testfixturefix `88a9f1de8` ergänzt nur die fehlende Runtime-Voraussetzung über den vorhandenen Loopback-Modellhelfer und reale Catalog-/Verify-/Default-/Restore-APIs. Alle vier Testkörper und Zeitlimits bleiben bytegleich; Lint und Syntax-/Orakelvergleich sind grün, die tatsächliche neue Browserabnahme bleibt offen. Das vorhandene Wheel `d7ffd8c2` behält seine installierten Core-1-/MCP-74-/pipcheck-/Modulparitätsbelege; SDK7 auf `ef727f241` besteht separat. Danach folgen neuer Originalbuild, ganze 94/23 plus bestehendes PI12-Agenten-Create, aktuelle CI-/Reviews und Merge des eigenen PR #176.

Cohort ist mit Session 60920 tatsächlich **43/43 / Originalexit 0** bestanden. `independent-postcheck-cohort-stored-plan-full-actual.json` bestätigt um 11:29:29.587 UTC die unveränderten 216 Pins (`72e7aa50d39f0785f77a02b89fdc81819a1a3fb613a5c3144727ca5a44193546`), fünf geschlossene Raumruntimes / zwei Owner / zwölf Sockets, entfernte Schema-OID 16144270, DATA und Compiler sowie keine eigenen Backends oder vorbereiteten Transaktionen. Report-SHA `5c42d49c85a21dcc19aa4881efdab0764875fc4160b368e1293a806eb1093793`, Log-SHA `2d226ad04e67248800fa4935eff467044dec9c14f7549fa6222f4d7b6697b5c9`. FD Session 66798 endet ebenfalls mit Originalexit 0: **46 registrierte Tests, 45 bestanden / ein optionaler macOS-EXDEV-Skip / kein Fehler**, unabhängig geschlossen um 11:33:12.797 UTC; kein 48er- oder vollständig ausgeführter 46er-Nachweis. Auf dem Backendstand bestehen Typcheck, gezieltes Lint, ganze Pure28 und Collector47; jeder Beleg behält seine eigene Quellenbindung.

Die begrenzte Store-Wiederverwendung betrifft nur exakt byteidentische historische Cohort6-Plantexte (höchstens vier Einträge / 16 MiB) mit unverändertem striktem Decoder pro Zugriff. Current-, Auth-, Claim- und SQL-Prüfungen bleiben frisch; das Produktmemo im Collector ist zurückgenommen. Web-Case38 schließt B2 in dieser echten Fixture mit 3.569 ms / 1.411 SQL-Abfragen / 46 vollständigen Checks ab. Die 5-Sekunden-Grenze bleibt unverändert; daraus folgt keine allgemeine Laufzeitgarantie. Frühere `25P04`-REDs bleiben historische REDs.

Die unverkleinerte Physical-Ownerfolge Session 79724 besteht mit Originalexit 0 / allen 36 Gruppen, Selector unset, Profiler aus und Revisionen OFF. Log `owner-physical36-settled-observer31-full36.log`, SHA `dae344a9e5433f79f0478d781716d8a6c501e05deb1f303628b7e172a0ab0f08`. Der unabhängige Abschluss um 23:39:13.419 UTC bestätigt 155 unveränderte Pins, vier geschlossene Raumruntimes / einen Owner / zehn Sockets, entfernte Schema-OID 15766967, DATA und Compiler sowie keine eigenen Backends oder vorbereiteten Transaktionen; Read-only-Prüfung zurückgerollt und Verbindung geschlossen. Gate 1 ist damit geprüft. Raw-C1 ist in `71c09176f` übernommen und mit Binding 13, neun PostgreSQL-Suiten sowie finalem Typcheck und Lint geprüft. C2 ist in `ff8f28079` mit sieben Suiten grün und unabhängig geschlossen. Cohort ist inzwischen separat geprüft und committet; finales Browser-MVP und Main-Merge bleiben offen, keine Gesamtabnahme.

Der vorausgehende Lauf 33518 bleibt RED30 (Log-SHA `a82cda2fc8aaecc24f5fcacb809d958e79356480597d7b99c923873b32195e2a`): Die exakte Rekonstruktion lokalisierte einen Dateisystemvergleich mit Baseline vor der vorhandenen Projektionsgrenze. Die minimale Beobachterfensterkorrektur (Owner-Test-SHA `07d804cb74b35cf51a9d82fe22f1572dd88dd2e6a7395892aee062916518c657`) ist übernommen und nun durch die vollständige 36er-Folge geprüft.

Die begrenzte Physical5-Planfragmentoptimierung ist in Store und Claimtest übernommen: Nur byteidentische unveränderliche Originalplanfragmente werden wiederverwendet; Current-, SQL-, Rechte- und Expiryprüfungen bleiben bytegleich. TSC 76163 und Lint 82201 enden mit Exit 0. Die echte Claimfolge 21144 besteht auf PG18 mit 40 Familien / Originalexit 0, unabhängig geschlossen um 22:50:24.047 UTC mit 155 unveränderten Pins und entfernten eigenen Ressourcen (Log-SHA `65d48fd8a3fedc2756320fc774b49136b597c1c3170c3fd511bb3acb7c64c8e8`). Frühere Pure25-/Web1-Erfolge bleiben Teilbelege; die älteren REDs bleiben RED. Diese älteren Belege bleiben an ihre tatsächlichen Quellstände gebunden; die jüngste Cohort-Abnahme steht separat oben.

Produktionsdiagnose auf Version `2026.10.17.2`: OAuth-Probe und beide betroffenen Dokumente wurden erfolgreich als `live_yjs` gelesen (gemeldete Größen 7.787 / 22.135). Die zwei fehlerbezogenen Control-Plane-Logabfragen über sieben Tage lieferten jeweils null Treffer. Das beweist keinen Fix: Eine Move-/Delete-Vorschau oder Dateiaktion wurde in Produktion nicht ausgeführt.

## Verbindliche Reihenfolge

| Gate | Noch zu erledigen | Erfolgskriterium |
| --- | --- | --- |
| 1. Physical-Delete | **Geprüft:** Session 79724, 36/36 / Originalexit 0, unabhängig geschlossen. | Alle 36 Gruppen, Originalexit 0, Quellen unverändert, Ressourcen unabhängig geschlossen; aktuelle Rechteentzüge, Rollback, SID-B und D2 erhalten. |
| 2. Raw-C1 | **Geprüft und committet:** `71c09176f`, alle zehn vorgesehenen Suiten grün und unabhängig geschlossen. | Binding 13, Raw-PG 11, Vorbereitung 10 / Public 8 / Web 9 / Atomic 8, Copy 26 / Metadaten 15 / HTML 10 / Assets 5. Belege behalten ihren jeweiligen Quellstand; keine Snapshot-als-Update-Interpretation. |
| 3. C2 | **Geprüft und committet:** `ff8f28079`, sieben Suiten grün und unabhängig geschlossen. | Binding 19 / Pure HTML 15 / Raw-PG 14 / Copy 26 / Metadaten 15 / HTML 10 / Assets 5. Eine physische Markdown-Datei im selben Workspace mit vollständig geprüftem statischem oder externem HTML; lokale HTML-Links bleiben im MVP blockiert. Originale Birth-/Import-/Receiptbindung und historische Reads erhalten. |
| 4. Cohort | **Geprüft und committet:** `59fd6cf35`, Owner 43/43 und FD 45 bestanden / ein optionaler EXDEV-Skip, Originalexits 0, unabhängig geschlossen. | Ganze Ownerauswahl, vorhandene FD-/Planfamilien, Teil-FS/B2/ACK-Recovery, originale Identitäten, aktuelle Links, offene Räume und kein D2-/Pfad-Revival geprüft. FD registriert 46, nicht 48; der plattformbedingt ausgelassene echte EXDEV-Fall bleibt ausdrücklich unbelegt. |
| 5. Gemeinsamer Stand | **Integriert:** Folgecommit `4499fc4ab`, Main über `cc737e2e8` und die gezielt grünen Fixes `13ca` / `4530a6709` / `24fad722e`. SharedHTML-Testkorrektur `de9276cd2`, Typen/Lint und Discovery 11/1 grün; SharedHTML11 besteht auf `ef727f241`. | Alte Build-/Laufbindungen bleiben erhalten; vorhandenes SDK nur mit verifizierten unveränderten Eingaben wiederverwenden. |
| 6. Build und E2E | **Jetzt:** Testfixturefix `88a9f1de8` ist übernommen; neuer Originalbuild, dann MCP10, UI76, Restart2 und REST6 seriell neu an den finalen Stand binden und vollständig ausführen. | 94 Fälle / 23 Specs, MCP mit gebundenem installiertem SDK und OFF-/Null-Capture-Orakeln, zwei echte Neustarts; Originalexits und unabhängiger Abschluss jeder Runtime. |
| 7. PR und Main | Eigenen PR aktualisieren, erforderliche CI-/Reviewbefunde abschließen. | Erforderliche Checks am endgültigen Head grün, keine offenen actionable Threads; danach Merge und Remote-Main verifizieren. |

Owner43 und FD46 bleiben tatsächliche getrennte Backendnachweise; der FD-Skip bleibt ausdrücklich unbelegt. Die gemeinsame 94/23-Abnahme auf dem neuen Finalbuild ist offen. Der rote UI76-Versuch und die anschließenden gezielten Fixprüfungen werden nicht zu einem bestandenen Gesamtlauf zusammengezählt. Jeder Schritt wird erst nach seiner konkreten Abnahme committet/geschlossen.

## Unverzichtbarer MVP-Umfang

- Direkt editierbarer Web-/Gast-/Formulareditor; manuelles Create, erster Text-Paste, Markdown-Bodyeinfügung und vollständiger Dateimport mit Weiterbearbeitung und Reload.
- Zentraler API-/MCP-/Agenten-Create/Read/Edit-Zugriff und progressive native Suche: begrenzte Treffer, stabile IDs, vollständiges kontrolliertes Weiterlesen.
- Sichere Move/Rename/Copy/Delete-Aktionen samt zentraler Linkpflege, normalen unterstützten Ordnern/Assets, offenen Ansichten und Wiederaufnahme desselben ursprünglichen Auftrags.
- Tatsächlicher Agenten-Schreibschutz für verwaltete Projektionen. Kein erfolgreicher Raw-FS-Fallback darf zentrale Orchestrierung umgehen.
- Optionale Revisionen, Review Center und Dateiaktions-Undo OFF; Änderungen funktionieren ohne zusätzliche Annahme.

HTML/MDX/Custom-Strukturen und besondere Overwrite-/Cross-Workspace-Fälle dürfen im nicht freigegebenen Schnitt präzise vor Wirkung blockieren. Normale native/gemischte Ordner werden dadurch nicht aus dem MVP entfernt.

## Finale Prüfung

Die [bestehende E2E-Matrix](./yjs-mvp-e2e-matrix.md) wird auf dem neuen Originalbuild vollständig geprüft: UI76 in 20 Specs, MCP10 allein, Restart2 mit zwei echten Neustarts und separate REST6 ergeben 94 Fälle in 23 ganzen Specs. Der vorherige f890-MCP10-Erfolg bleibt an seinen Build gebunden; der UI76-RED wird nicht umgedeutet. Die aktuellen Controller werden mit den neuen echten Builddaten gebunden und seriell ausgeführt. Effektive Revisionen OFF und Null-Capture bleiben Pflicht. Discovery, gezielte Units und Fixture-Cleanup ersetzen diese neue Runtimeabnahme nicht.

Für den Main-Merge gelten der finale Originalbuild, die gebundene MVP-E2E-Auswahl und die tatsächlich erforderlichen CI-/Reviewprüfungen am endgültigen Head. Der originale `npm run test:all` ist weiterhin nicht grün und durch diese Teilabnahme nicht abgedeckt: zuletzt 234 bestanden, 218 fehlgeschlagen, 269 übersprungen, 88 nicht ausgeführt. Seine konkreten Befunde bleiben zu erklären oder zu beheben; vor jedem späteren Produktionsdeploy ist `npm run test:all` gemäß Repositoryvorgabe erforderlich. [Erhaltene Lücke](./yjs-mvp-full-test-runner-gap.md).

Der Remoteabgleich am 22. Oktober bestätigt Main `14c1a6c6a5f89d98523283a2c7f96aeba8c0eb4c` weiterhin als lokalen Vorfahren. Der eigene PR ist [#176](https://github.com/canvascoding/canvas-notebook/pull/176). Aktueller PR-Head, Mergefähigkeit, erforderliche Checks und Reviews sind vor dem Merge erneut zu prüfen. Frühere CI-Erfolge decken nur ihren veröffentlichten Head ab. Produktionsauslieferung und die Behebung des ursprünglichen Produktionsfalls werden separat auf tatsächlich ausgelieferter Version bestätigt.

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
