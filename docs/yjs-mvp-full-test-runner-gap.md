# MVP: noch offener Gesamtcheck

Stand: 20. Oktober 2026. Die historische lokale MVP-Abnahme auf Root `98956a6bd` / QA `6537fbbe8` bleibt mit 29/29 E2E-Fällen, 42/42 Ressourcenprüfungen und zwei Hostneustarts belegt. Der inzwischen tatsächlich bestandene HTTP-Teil auf Root `4e798e3ec` / QA `2bcf2ad918` schließt den vollständigen `test:all` nicht. PR #176 ist auf dem damals veröffentlichten Head `fd1b54dcae9a2eec05ab342a12b381a7e7a70344` mit sieben grünen CI-Checks belegt, gegenüber Main `05e9da30fe4d8a29521223595bf58564d5daebb9` aber `DIRTY`; Policy-/Kohortenzuordnung der elf neuen MVP-Tabellen und der Downloadticket-Vertrag bleiben Integrationsblocker. Main und Produktion sind nicht freigegeben.

## Verbindliches Produktionsgate

[AGENTS.md](../AGENTS.md) verlangt: „Run `npm run test:all` before production deploys.“ Das Gesamtkommando wurde in der MVP-Abnahme nicht ausgeführt. Eine Ausnahme von dieser Vorgabe benötigt eine direkte Nutzerentscheidung; bis dahin gilt das ursprüngliche Gate weiter. Main-Merge, Release und Produktionsprüfung bleiben eigenständige Schritte.

## Tatsächlich geprüfter Runner-Teil

`node --test scripts/test-all-orchestration-test.mjs` endet zunächst mit Exit 1: 18/21 bestanden. Ausschließlich drei Reihenfolgeassertionen fehlen die bereits vorhandenen Vorprüfungen `test:server:shutdown` und `test:internal:scheduler`. Runner und Testdatei sind zu diesem Ausgangspunkt bytegleich mit Main `1506927038b80036749266a56fb769dcb6e6d18c`.

Nach Aktualisierung dieser Erwartungen und vier zusätzlichen echten Kindprozessproben endet derselbe Test mit Exit 0: **25/25 bestanden**, keine Skips, Fehler oder Abbrüche. Die neuen Fälle prüfen, dass beide Vorprüfungen bei Exit 23 sowohl im Owned- als auch im External-Modus vor Health und Appstart abbrechen. Ein eigener unbeteiligter Listener bleibt geöffnet. Unabhängiges Review findet keine konkreten P1/P2; GitNexus und `git diff --check` bestätigen den engen Testdateiumfang.

Diese Probe verwendet synthetische npm-/HTTP-Fixtures und bestätigt das Prozess- und Abbruchverhalten. Die vollständige App-, Datenbank-, Modell- oder Browserabnahme des Gesamtkommandos steht weiterhin aus.

## Bestehende Ausführungsgrenzen

- [test-all.mjs](../scripts/test-all.mjs) übernimmt DB/DATA und Agentkonfiguration vom Aufrufer. Der External-Modus überspringt Build und Serverstart, führt aber die mutierenden Integrationstests aus. PI verändert unter anderem die eigene Agentkonfiguration und Agent-AGENTS.md und braucht einen echten bereiten Modellpfad.
- Der abschließende Playwright-Aufruf verwendet die gesamte Defaultcollection. Die tatsächliche reine Collection auf Root `4e798e3ec` endet mit Exit 0 und zählt **789 Fälle in 201 Dateien**. Das ist keine Ausführung dieser Tests. Originale: `/private/tmp/canvas-mvp-default-playwright-collection-20261020`; Terminal-SHA `75f27346404db67aff7af7061deb23822d2675b0a7944c19185247b54b4d78d8`, Zusammenfassung-SHA `07576d6fa1635ba27fb9664e4e0dd246db163b8560edf5290dda2e2be68ff6f5`.
- Mehrere unbedingte Suiten benötigen unterschiedliche reale Fixtures: Sealed-Yjs mit eigener DB/OID/Receipt, ältere Collaboration-QA auf Port 4126, Connection-/Provider-QA auf Port 3001, private Plugin-/Storebelege sowie Desktop- oder iOS-/Android-Prozesse. Ein universeller ENV-/Receipt-Satz erfüllt diese Verträge nicht.
- Der bestehende [Yjs-Supervisor](../scripts/run-yjs-authority-e2e.ts) bindet jede Spec einzeln an `activeSpec`; MCP benötigt einen alleinigen Lauf und die installierte SDK-Bindung. Neustartfälle benötigen den eigenen Restart-Supervisor. Ein kopierter oder erfundener Receipt erfüllt diese Grenzen nicht.
- Die frühere Restore-Orakellücke in [integration-test.mjs](../scripts/integration-test.mjs) ist korrigiert und inzwischen auch gegen die echte eigene App-/DB-Instanz bestanden: exaktes `409 / FILE_OPERATION_UNDO_DISABLED`, gelöschter Pfad weiterhin 404, Kopie intakt. Die [Releasepolicy](../app/lib/files/workspace-file-undo-policy.ts) und Undo-OFF bleiben unverändert.
- Der vorhandene Yjs-Supervisor hat jetzt einen festen, ausdrücklich vom Browser getrennten HTTP-Modus für `npm run test:integration`; dessen Erfolg ist belegt. Das ersetzt weder den vollständigen `npm run test:all`-Aufruf noch dessen Modell-/PI-/Terminal-/Scheduler- und Browserteile. Unterschiedliche tatsächliche Lebenszyklen sind bei konkreten Vollausführungsfehlern zu prüfen, keine pauschale Voraussetzung für einen neuen Universalrunner.

Die gewöhnlichen JSON-/Asset-Arme sind nicht pauschal ausgeschlossen. Für Rename/Copy/Delete muss der echte Lauf die konkreten aktuellen Verträge prüfen; aus dem statischen Undo-Konflikt wird kein früheres Scheitern dieser Aktionen abgeleitet.

Die statische Bestandsaufnahme bindet alle 201 Pfade mit einzelnen SHA-256-Werten und dem Config-Hash. Privater Beleg: `/private/tmp/canvas-test-all-static-inventory-d05337daa-20261020.json`, SHA-256 `ae26554b8f90bee72f638be0faa8be6f2a0e35c023e258a088c6f7c9370ccf3a`. Die Originalausgaben der Runner-Gegenprobe sind separat erhalten: Baseline `cd10431d5ed34f9983175bf0210b13335c7b4cea4de82e611f2a97c2cda2ebba`, korrigierter Lauf `5a5e26d2db37b79831e8b7f4fe4222314c73482ad97a67ad738ddb976ec30636`. Diese damalige Dateiinventur war keine tatsächliche Playwright-Collection; die später ausgeführte reine Collection ist oben separat belegt.

## Restore-Erwartung im Integrationstest korrigiert

Der unveränderte Integrationstest aus Main (Datei-SHA `2625beaef9cad372edc56e9d3147fc26d0d92ec44bda5af1073a18e839f5bf3e`) scheitert in einer tatsächlichen eigenen synthetischen HTTP-Probe an der korrekten Antwort `409 / FILE_OPERATION_UNDO_DISABLED`: Child-Exit 1 nach elf Requests, ohne Fixturefehler in diesem maßgeblichen Fall. Der Originalbericht bleibt erhalten (`canvas-integration-http-contract-c9K9rC/report.json`, SHA `89ae868e03718a435f1892bfd4b3cd265cf14c89af73d7dc09ff7786aad5a3ca`).

Die korrigierte Testdatei (SHA `7707a881379dc9820a7bd68277e5f86c8e00053ce2626b2097e40c6902d5201c`) verlangt den exakten Fehlercode und Status. Anschließend müssen die gelöschte Quelle weiterhin 404 und die Kopie unveränderten Inhalt liefern. Cleanup betrifft nur das noch vorhandene Kopierverzeichnis und weist auch HTTP 200 mit nicht leerem `failed` zurück. Die tatsächliche Ausführung der integrierten Root-Datei besteht alle sechs Vertragsfälle:

| Probe | erwarteter und tatsächlicher Script-Exit | Requests |
| --- | --- | --- |
| Korrektes Undo-OFF-Verhalten | 0 | 14 |
| Unerwarteter Restore-Erfolg | 1 | 11 |
| Falscher Fehlercode bei 409 | 1 | 11 |
| Gelöschte Quelle taucht wieder auf | 1 | 12 |
| Kopie verändert | 1 | 13 |
| Cleanup meldet 200 mit fehlgeschlagenem Eintrag | 1 | 14 |

Alle sechs Kindprozesse und eigenen HTTP-Server sind geschlossen; keine offenen Sockets, Timeouts oder Fixturefehler. Der tatsächliche Root-Bericht ist `canvas-integration-http-contract-8P7yEP/report.json`, SHA `82c7cf9967cbe8d3bded1347f44c171d65bf2374e729af8c3d6d756c50784d27`; Originale liegen unter dem privaten Host-TMP. Der separat vor Integration geprüfte Candidate-Bericht `canvas-integration-http-contract-FxJdtT/report.json` hat SHA `9daa6efa58c90fda08083c32ecc989d2b30ee541249ea232c3be41d4dc45e7b4`. Der private V2-Driver bleibt auf SHA `3b2a021d8334abd07f3ec9e67b7b5baba2269c2fd62659626c31972ecf4a119a` gebunden; seine einzige Korrektur vor Erststart betrifft den schon im Original gesetzten JSON-Header des leeren Restore-POSTs. V1 wurde nicht ausgeführt und bleibt erhalten.

Node-Syntaxprüfung, Scoped-ESLint und unabhängiges enges Review bestehen. Produktpolicy, Restore-Route und Experimentalschalter sind unverändert. Diese synthetischen HTTP-Proben bestätigen das korrigierte Testorakel. Der spätere tatsächliche App-/DB-Integrationstest ist inzwischen separat bestanden; das vollständige `npm run test:all` bleibt offen. Die bestehende Cleanup-Toleranz für sonstige 2xx-Antworten oder fehlende `failed`-Felder wurde nicht als vollständiger physischer Löschbeleg gewertet.

## Umsetzung bei unverändertem Gesamtgate

Der echte HTTP-Originalprozess endet mit Exit 0, **1/1 Script und 11/11 unabhängigen Prüfungen**, einschließlich geschlossener eigener DB-/DATA-/TMP-/Prozessressourcen. Die drei separaten Faults Exit23, SIGTERM und echte 120000-ms-Deadline bleiben Original-Exit 1; jeweils 12/12 strikte Failureprüfungen und die anschließende unabhängige Cleanup-Closure sind bestanden. Shims führen kein Anwendungsscript aus und sind keine App-/Browser-/Gesamtabnahme. Das korrigierte private Abbruch-Chronologieorakel verändert keine Produktquelle. [Gebundene Originale und Grenzen](./yjs-owned-http-integration-evidence.md).

Nach Main-Integration und gemeinsamer Build-/Browserabnahme das **vorhandene Gesamtkommando in der eigenen isolierten Instanz mit bereitem Modellpfad wirklich ausführen** und konkrete Fehler beheben. Den vorhandenen verwalteten Stack und seine isolierten DB-/DATA-/Konto-/Agentbelege verwenden, ohne Containerbuild oder zweiten Stack. Die bisherige Überlegung einer neuen vollständigen Familienorchestrierung ist keine Voraussetzung vor diesem Lauf. Originalausgaben, tatsächliche Exits und eigener Ressourcenabschluss sind zu erhalten; weder reine Collection noch Teilprüfungen ersetzen `npm run test:all`.

Der aktuelle Fokus-Browserlauf scheiterte am alten `chat-input`-Selector. Der reine Selectorfix ist inzwischen lokal angewendet, aber noch nicht erneut im Browser abgenommen. Das ist ein offener konkreter Befund, kein neuer Anwendungserfolg. SDK-/PDF-/Such-/Skill-Erweiterungen und alle sieben breiteren Roadmap-Pakete bleiben separat offen. Review Center und Dateiaktions-Undo bleiben ausgeschaltet. Ohne direkte Nutzerentscheidung gilt das Produktionsgate unverändert weiter.
