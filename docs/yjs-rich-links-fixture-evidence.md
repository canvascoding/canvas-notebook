# V10: Browserabnahme und exakte Linkfixture

## Eingefrorener Stand und tatsächliches Ergebnis

V10 prüfte `8cf79496bb64c371f3ea2618e58de1c887221dc7` im eigenen Worktree mit frischem tatsächlichem Produktionsbuild. Source-Digest: `e7701c2162d7c0d6fa9c5a303f5954e9d37f80a65dc963ff7c38c0cd68217411`; Build-Digest: `192eb4668fc208b04e8f4ef7ee17d8715a37568014e52cfac21d139050ec4d15`. Die drei bestehenden Prebuild-Schritte und der Build liefen unverändert. Root bestätigte vor START und nach Laufende unabhängig dieselben Source-/Build-Seals. Eigene Notebook-/Control-Plane-Checkouts und physische Abhängigkeiten waren geprüft; kein Container wurde gebaut.

Die sechs unveränderten Create-/Paste-/Importfälle bestehen: manuelles Create auf Homepage und im Dateibrowser, erster echter Plain-Paste, Markdown-Body-Einfügung, HTML-/Plain-Zwischenablage mit Reload, vollständiger Source-Import und gewöhnlicher Text mit History-Reopen. Der ursprüngliche Focus-/Breitenfall besteht ebenfalls, einschließlich identischer Editor-DOM-Instanz über Resize, mobilem Fokus, Safe Areas, Escape und Menü-/Tabellennavigation. Das ursprüngliche 90-Sekunden-Limit bleibt erhalten.

Der Linkfall scheitert bei der ersten Strg-Klick-Iteration an der erwarteten Kopfzeile `A|B.md`. Cmd-/Open-Menü- und nachfolgende Fragment-/Rechte-/Externalprüfungen werden deshalb nicht erreicht. Beide Neustartfälle starten nach dem Suite-Abbruch nicht. Ergebnis: acht gestartet, sieben bestanden, einer fehlgeschlagen, zwei nicht gestartet; keine Skips, Testtimeouts oder Unterbrechungen, Runner Exit 1. Das ist kein Zehn-Fälle-Pass. Die später integrierten authentisierten Reader- und pristine-Bootstrap-Grundlagen sind in diesem eingefrorenen V10-Build noch nicht enthalten.

## Belegter Testaufbaufehler und Evidenzgrenze

Die privaten tatsächlichen HTTP-/DOM-Traces zeigen:

- Der Zielupload antwortet mit HTTP 200 und `files: ["A_B.md"]`; der committed Pfad endet ebenfalls auf `Targets/A_B.md`.
- Beide erfolgreichen Linkindex-Antworten im richtigen Shared-Workspace enthalten `Targets/A_B.md`. `Targets/A|B.md` fehlt. Der Internal-Link ist im Index als missing ohne Kandidaten erfasst.
- Der tatsächliche Ausgangsanker bleibt `../Targets/A%7CB.md#Section%20A`.
- Die erste Strg-Klick-Iteration wird erreicht. Der erwartete Ziel-Read findet nicht statt; die drei aufgezeichneten Datei-Reads betreffen das Ausgangsdokument und antworten mit HTTP 200. Ein typed Busy-/503-Zielrequest ist nicht aufgezeichnet.
- Der Ausgangseditor bleibt auch im Snapshot am Ende der fehlgeschlagenen Assertion vorhanden und editierbar. Die frühere Interpretation einer verschwundenen Vorschau stützte sich auf den späteren Aufräum-Screenshot und beschreibt diesen Assertionzeitpunkt nicht.

Root bestätigte Uploadantwort, tatsächliche Indexpfade und fehlenden Ziel-Read durch eigenes Offline-Lesen des erhaltenen Traces. Der bestehende [Uploadpfad-Sanitizer](../app/lib/files/upload-paths.ts) ersetzt `|` durch `_`; [die Uploadroute](../app/api/files/upload/route.ts) speichert diesen Namen. Damit existiert das von der ursprünglichen Linkfixture erwartete Zieldokument nicht. Die indexseitige Cache-Nutzung erklärt, warum für jeden Klick kein eigener Indexrequest notwendig ist.

Das ist ein nachgewiesener Aufbaufehler; die Ausführung des Klickhandlers ist damit noch nicht belegt. In den vorhandenen Snapshots und zwölf vorhandenen Screencastframes bis 9,36 Sekunden nach dem Klick ist keine Missing-Target-Toast erkennbar. Ein zusätzlicher Handler-/Lifecyclefehler bleibt deshalb möglich. Der einzige aufgezeichnete PageError entsteht erst nach `about:blank` im Aufräumen. Es wurde für diese Offline-Diagnose keine Runtime erneut gestartet.

## Fokussierte Fixturekorrektur und nächste Abnahme

Die [Linkfixture](../tests/editor-rich-workspace-links.spec.ts) erzeugt ausschließlich das Literal-Pipe-Zieldokument über die vorhandene JSON-Create-API. Danach liest sie dessen tatsächliche Revision und speichert den bisherigen unveränderten Inhalt über die bestehende Mobile-Dokument-API mit SHA-/Revisionprüfung. Ein echter Datei-Read muss vor dem ersten Browserklick den exakten Pfad und Inhalt bestätigen. Source- und private Vergleichsdatei behalten den bisherigen Uploadweg.

Zielname, Markdown-Href, Inhalt, Workspaces, Strg-/Cmd-/Open-Menü-, Fragment-, Private-/External-, Undo-/Inhalts-Assertions und sämtliche Zeitlimits bleiben erhalten. Die Produkt-Sanitizerregel wird nicht für den Test geändert. Der zusätzlich notwendige Create-Request verwendet die vorhandene Budgethilfe. Der neue Aufbau orientiert sich an der bereits tatsächlich bestandenen Focus-Fixture und dem bestehenden Unicode-Create-Vertrag der Chat-Link-Fixture.

Diese Sourcekorrektur braucht einen neuen tatsächlichen Build und einen neuen eigenen Browserlauf. V10 wird weder rückwirkend als erfolgreich ausgegeben noch durch eine lokale Prüfung ersetzt. Die drei anderen ursprünglichen Suites bleiben bytegleich.

Root bestätigt vollständiges TypeScript mit 8 GiB, fokussiertes ESLint, die bestehende Navigation-Clientprüfung und die tatsächliche lokale React-/Rich-Editor-Linkprüfung. Letztere verwendet eine simulierte Navigation und JSDOM-Geometrie; sie ersetzt keine Browser-/Serverabnahme. Der unabhängige Textvergleich erlaubt in der Link-Suite ausschließlich den neuen Setuphelfer und den ersetzten Target-Setupaufruf. Alle nachfolgenden Browserassertions sind bytegleich. Die frische GitNexus-Auswirkungsprüfung meldet drei Testsymbole, drei Dateien, keine Produktabläufe und niedriges Risiko.

## Geschlossene eigene Runtime

Der Runner ist beendet. Root bestätigte unabhängig: ursprüngliche Supervisor-/Notebook-/Issuer-PIDs abwesend, eigene Host-/Issuer-Prozessgruppen leer, eigener Port frei, Runtime-Lock entfernt, gleiche erhaltene Root-/DATA-Identität und beide exakten Datenbank-OIDs mit passenden Eigentumsmarkern und null Sessions. Die synthetische Fixture und privaten Fehlertraces bleiben für Diagnose erhalten. Fremde und kanonische Dienste wurden nicht umgestellt. Eine getrennte Browser-PID wurde nicht festgehalten; daraus wird kein zusätzlicher PID-Nachweis abgeleitet.

Raw-Trace, Headers, Cookies, Bodies und vollständige Request-URLs bleiben ausschließlich privat. Dieser Nachweis enthält keine Produktionsreparatur oder Freigabe der zentralen noch inaktiven Dateioperations-Grundlagen.
