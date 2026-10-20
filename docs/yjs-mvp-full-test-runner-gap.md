# MVP: noch offener Gesamtcheck

Stand: 20. Oktober 2026. Die lokale MVP-Abnahme ist mit Produktionsbuild, 29/29 E2E-Fällen, 42/42 Ressourcenabschlüssen und zwei echten Hostneustarts abgeschlossen. PR #176 ist auf Head `cebcbe398ebdb6770896a3ee16561d4cfd96be5f` mit sieben erfolgreichen CI-Checks freigabefähig. Der anschließende lokale Commit `d05337daa` ändert ausschließlich eine Runner-Testdatei. Produkt, E2E-Specs und Experimentalschalter bleiben dabei unverändert.

## Verbindliches Produktionsgate

[AGENTS.md](../AGENTS.md) verlangt: „Run `npm run test:all` before production deploys.“ Das Gesamtkommando wurde in der MVP-Abnahme nicht ausgeführt. Eine Ausnahme von dieser Vorgabe benötigt eine direkte Nutzerentscheidung; bis dahin gilt das ursprüngliche Gate weiter. Main-Merge, Release und Produktionsprüfung bleiben eigenständige Schritte.

## Tatsächlich geprüfter Runner-Teil

`node --test scripts/test-all-orchestration-test.mjs` endet zunächst mit Exit 1: 18/21 bestanden. Ausschließlich drei Reihenfolgeassertionen fehlen die bereits vorhandenen Vorprüfungen `test:server:shutdown` und `test:internal:scheduler`. Runner und Testdatei sind zu diesem Ausgangspunkt bytegleich mit Main `1506927038b80036749266a56fb769dcb6e6d18c`.

Nach Aktualisierung dieser Erwartungen und vier zusätzlichen echten Kindprozessproben endet derselbe Test mit Exit 0: **25/25 bestanden**, keine Skips, Fehler oder Abbrüche. Die neuen Fälle prüfen, dass beide Vorprüfungen bei Exit 23 sowohl im Owned- als auch im External-Modus vor Health und Appstart abbrechen. Ein eigener unbeteiligter Listener bleibt geöffnet. Unabhängiges Review findet keine konkreten P1/P2; GitNexus und `git diff --check` bestätigen den engen Testdateiumfang.

Diese Probe verwendet synthetische npm-/HTTP-Fixtures und bestätigt das Prozess- und Abbruchverhalten. Die vollständige App-, Datenbank-, Modell- oder Browserabnahme des Gesamtkommandos steht weiterhin aus.

## Warum eine neue Datenbank allein nicht genügt

- [test-all.mjs](../scripts/test-all.mjs) übernimmt DB/DATA und Agentkonfiguration vom Aufrufer. Der External-Modus überspringt Build und Serverstart, führt aber die mutierenden Integrationstests aus. PI verändert unter anderem die eigene Agentkonfiguration und Agent-AGENTS.md und braucht einen echten bereiten Modellpfad.
- Der abschließende Playwright-Aufruf verwendet die gesamte Defaultcollection. Statisch liegen darin **201 Spec-/Testdateikandidaten**; eine tatsächliche Collection oder Fallzählung wurde für diese Untersuchung nicht ausgeführt.
- Mehrere unbedingte Suiten benötigen unterschiedliche reale Fixtures: Sealed-Yjs mit eigener DB/OID/Receipt, ältere Collaboration-QA auf Port 4126, Connection-/Provider-QA auf Port 3001, private Plugin-/Storebelege sowie Desktop- oder iOS-/Android-Prozesse. Ein universeller ENV-/Receipt-Satz erfüllt diese Verträge nicht.
- Der bestehende [Yjs-Supervisor](../scripts/run-yjs-authority-e2e.ts) bindet jede Spec einzeln an `activeSpec`; MCP benötigt einen alleinigen Lauf und die installierte SDK-Bindung. Neustartfälle benötigen den eigenen Restart-Supervisor. Ein kopierter oder erfundener Receipt erfüllt diese Grenzen nicht.
- [integration-test.mjs](../scripts/integration-test.mjs) erwartet weiterhin erfolgreiche Papierkorb-Wiederherstellung. Die [aktuelle Releasepolicy](../app/lib/files/workspace-file-undo-policy.ts) verlangt dagegen ausdrücklich `FILE_OPERATION_UNDO_DISABLED` mit HTTP 409. Diese statische Orakellücke ist vor der tatsächlichen Vollausführung zu korrigieren; Undo bleibt ausgeschaltet.
- Der bisherige direkte `server.js`-Start des Yjs-Supervisors und der zusätzliche Terminal-/Schedulerstart durch `npm start` haben unterschiedliche Lebenszyklen. Ein fester Fullsuite-Anschluss muss diese ausdrücklich berücksichtigen.

Die gewöhnlichen JSON-/Asset-Arme sind nicht pauschal ausgeschlossen. Für Rename/Copy/Delete muss der echte Lauf die konkreten aktuellen Verträge prüfen; aus dem statischen Undo-Konflikt wird kein früheres Scheitern dieser Aktionen abgeleitet.

Die statische Bestandsaufnahme bindet alle 201 Pfade mit einzelnen SHA-256-Werten und dem Config-Hash. Privater Beleg: `/private/tmp/canvas-test-all-static-inventory-d05337daa-20261020.json`, SHA-256 `ae26554b8f90bee72f638be0faa8be6f2a0e35c023e258a088c6f7c9370ccf3a`. Die Originalausgaben der Runner-Gegenprobe sind separat erhalten: Baseline `cd10431d5ed34f9983175bf0210b13335c7b4cea4de82e611f2a97c2cda2ebba`, korrigierter Lauf `5a5e26d2db37b79831e8b7f4fe4222314c73482ad97a67ad738ddb976ec30636`. Diese Dateiinventur ersetzt keine tatsächliche Playwright-Collection.

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

Node-Syntaxprüfung, Scoped-ESLint und unabhängiges enges Review bestehen. Produktpolicy, Restore-Route und Experimentalschalter sind unverändert. Diese synthetischen HTTP-Proben bestätigen das korrigierte Testorakel; ein tatsächlicher App-/DB-Integrationstest und das vollständige `npm run test:all` stehen weiter aus. Die bestehende Cleanup-Toleranz für sonstige 2xx-Antworten oder fehlende `failed`-Felder wurde nicht als vollständiger physischer Löschbeleg gewertet.

## Umsetzung bei unverändertem Gesamtgate

1. Vollständigen ursprünglichen Collectionbestand und deklarierte Fall-IDs erfassen; vorhandene optionale Bedingungen ausdrücklich erhalten.
2. Jede Spec genau einer passenden bestehenden Fixture-Familie zuordnen. Die Mengen müssen disjunkt und zusammen vollständig sein. Neue, mehrdeutige oder unzugeordnete Specs stoppen den Lauf.
3. Familien seriell mit eigenen DB-/DATA-/Agent-/Providerbelegen ausführen. Den vorhandenen identitätsgebundenen Lebenszyklus wiederverwenden; keine gemeinsame manuelle Testdatenbank und keinen zweiten Containerstack erzeugen.
4. MCP und Neustarts unter ihren jeweiligen echten Supervisoren ausführen. Zwischen Familien eigene Prozesse, Listener und Datenbanken nachweislich schließen.
5. Sämtliche ursprünglichen Fälle und vorhandenen optionalen Skipgründe aggregieren. Keine neue Spec-Ausnahme, fingierte Bestätigung oder übernommene Erfolgsmeldung verwenden.
6. Das tatsächliche `npm run test:all` und seine Originalausgaben belegen; erst danach ist dieses Produktionsgate erfüllt.

SDK-/PDF-/Such-/Skill-Erweiterungen und alle sieben breiteren Roadmap-Pakete bleiben separat offen. Review Center und Dateiaktions-Undo bleiben ausgeschaltet.
