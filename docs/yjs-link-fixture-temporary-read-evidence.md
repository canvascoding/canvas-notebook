# Linkfixture: vorübergehend gesperrter Read nach dem Speichern

Stand: 2026-10-14. V16 ist geschlossen. Die anschließende begrenzte Fixturekorrektur ist integriert und lokal geprüft; ihre erneute vollständige Browserabnahme bleibt offen.

## Tatsächlicher Browserbefund

Der einmalige echte Produktionsbuild und Browserlauf verwendet Worktree-HEAD `81f33e86ac02a2df4df5aad4003b0b47fa9444c5`, Source-Fingerprint `aa6b994ee10547bc3bf6682497e46f3ba65fbee156b84a8f56cef2dea3cec571` und Build-Fingerprint `c05a263f3432706480b15ff6189c070417a47cb20cce19b34954e252ffc7616b`.

| Suite | Tatsächliches Ergebnis |
| --- | --- |
| Create, erstes Paste, Markdown-Einfügen, Dateiimport | 6 bestanden |
| Dokumentbreite, Fokus und native Tabellennavigation | 1 bestanden |
| Rich-Links | 1 fehlgeschlagen, bereits in der Fixturevorbereitung |
| Graceful- und Crash-Neustart | 2 nicht gestartet |

Die drei tatsächlich gestarteten Reporter ergeben acht gestartete Fälle, sieben Passes und einen Fehler; keine Skips, Testtimeouts oder Unterbrechungen. `restartCount=0`. Die neue SQL-Flagkorrektur wurde in diesem Browserlauf noch nicht durch die Neustart-Durability-Abfragen erreicht.

Die [Linkfixture](../tests/editor-rich-workspace-links.spec.ts) erstellt ihr exaktes Pipe-Ziel über JSON-Create und revisionierten Mobile-PUT. Beide Requests sowie der vorgeschaltete Originalread bestehen. Der unmittelbar folgende GET auf `/api/files/read` antwortet im erhaltenen Trace mit HTTP 503, `success=false` und genau `ROOM_OWNER_BUSY`. Die Assertion `expect(read.ok()).toBe(true)` scheitert an Zeile 53; der Aufruf stammt aus Zeile 70. Keine eigentliche Linkinteraktion wurde ausgeführt. Root hat die konkrete Networkantwort unabhängig aus dem privaten Trace gelesen; Rohpayload, Anmeldungsdaten und konkrete Fixture-IDs werden nicht in dieses Dokument übernommen.

Dies belegt eine vorübergehende Nichtverfügbarkeit des vorbereitenden Reads. Es belegt weder einen zusätzlichen Linkklickfehler noch Verlust des gespeicherten Inhalts oder die genaue interne Ownerphase.

## Vorhandenen Retryvertrag wiederverwenden

Der normale [Dokumentreader](../app/lib/files/client.ts) verwendet bereits [revalidateBusyFileRead](../app/lib/files/read-busy.ts). Diese unveränderte Produktstrategie wiederholt ausschließlich HTTP 503 mit `success=false` und dem genauen Code `ROOM_OWNER_BUSY`: höchstens vier frische Reads, Wartezeiten 100/250/500 ms und keine weitere Requestaufnahme nach zwei Sekunden seit der ersten Busy-Antwort. Das ist keine harte Begrenzung einer bereits laufenden HTTP-Anfrage.

Die enge Korrektur schließt nur den einen Fixture-GET an dieselbe Strategie an. Create, Upload und PUT werden nicht wiederholt. Auth-, Identity-, Quarantäne-, andere HTTP- und Netzwerkfehler bleiben Fehler. Der abschließende Pfad- und vollständige Inhaltsvergleich sowie alle eigentlichen Linkaktionen, Seeds und ursprünglichen Zeitlimits bleiben erhalten. Der kleine testinterne [APIResponse-Adapter](../tests/helpers/owned-busy-file-read.ts) erhält Status, Body und Header und schließt seine ursprünglichen Response-Ressourcen im `finally`.

Vor der Änderung meldet die präzise Root-Auswirkungsanalyse für `createExactDocument` LOW, einen direkten Testaufrufer und keine erfassten Produktprozesse oder Module. Root bestätigt durch Rückwandlung des vollständigen Spec-Texts gegen `81f33e86a`: ausschließlich der Helperimport und der eine Read-Aufruf einschließlich Method-zu-Property-Anpassung sind geändert. Die bestehende Produktpolicy ist bytegleich. Zwei unabhängige Source-Reviews ergeben keinen materiellen Befund.

## Lokale Abnahme der Korrektur

Der geprüfte Autorencommit `9e680eb422d2939be38b92e4915669d01516ffda` enthält genau drei Testdateien. Root übernimmt exakt diese Bytes. Die [vier Adapterfälle](../scripts/owned-busy-file-read-api-test.ts) verwenden einen echten Playwright-APIRequestContext gegen einen eigenen kurzlebigen Loopback-HTTP-Server:

1. Busy, anschließend erfolgreicher Read mit exaktem Unicode-/CRLF-Inhalt, Status, Headern einschließlich zweier Set-Cookies und geschlossenen ursprünglichen Responses.
2. Vier echte Busy-Reads, danach unveränderte letzte Fehlerantwort mit Status 503 und exakt ihrem Body.
3. Status 403 und ein anderer 503-Code jeweils ohne Wiederholung.
4. Abbruch vor dem ersten Request beziehungsweise nach der Busy-Antwort ohne neuen Request und mit geschlossenem Response.

Alle vier Gruppen bestehen unabhängig im Autorenworktree und im Hauptworktree. Der jeweilige APIContext und der eigene HTTP-Server schließen. Root bestätigt vollständiges TypeScript mit 8 GiB Heap und gezieltes ESLint. Aufruf: `node --import tsx scripts/owned-busy-file-read-api-test.ts`.

Diese lokale Matrix prüft den tatsächlichen Responseadapter und den vorhandenen begrenzten Readvertrag. Sie ist kein neuer Notebook-, Browser-, PostgreSQL- oder Neustartnachweis. Die korrigierte vollständige Zehn-Fälle-Abnahme benötigt weiterhin ihren eigenen frischen Build und tatsächlichen Browserlauf.

## Abschluss und Grenzen

Root bestätigt nach Laufende unabhängig den unveränderten echten Build, die privaten Abschluss-/Trace-/Summary-Hashes, sechs beendete bekannte Runtime-/Browser-PIDs und Gruppen plus Observer, zwei freie eigene Ports und den entfernten Lauf-Lock. Root-/DATA-Identitäten und die beiden tatsächlichen PostgreSQL-Datenbanken bleiben erhalten; Eigentümer, Role, Marker und jeweils null Sessions sind separat read-only geprüft. Die reguläre Fehlerbehandlung hat diese Daten für die Diagnose erhalten.

Andere Services und frühere eigene Belege bleiben unverändert. Diese Teilabnahme aktiviert weder den neuen nativen Session-/Dateiaktionspfad noch behebt sie den ursprünglichen Produktionsfall. Die weiteren Create/Paste/Import-Fälle aus §13.3 des [Masterplans](./yjs-document-authority-consolidation-plan.md) bleiben ausdrücklich offen.
