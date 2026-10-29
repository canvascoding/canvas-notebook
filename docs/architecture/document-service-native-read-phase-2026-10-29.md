# Gemeinsame native Lesephase und begrenzte ID-Abfragen

Stand: 29.10.2026. Ausgangsstand ist `2a941f0c038096efac9c8477b1a1b475c59fe0ff`.
Dies ist eine weitere Umsetzung innerhalb von Paket 2 des
[Gesamtplans](../document-write-database-performance-plan.md), keine Gesamtabnahme.
Review Center und Undo werden nicht weiterentwickelt.

## Änderung und Grenzen

Der bestehende native Dokumentleser beobachtet Realm, Relationsauflösung,
tatsächlich gehaltenen Shared-Lifecycle-Lock, Workspace, Registry/Lineage,
begrenzte Zustandsmetadaten und Reservierungen gemeinsam auf seiner echten
gehaltenen Verbindung. Start, Zustandsladen und Abschluss bleiben getrennte
Beobachtungen. Die zusätzliche unabhängige Realm-/Relations-/Lockprüfung nach
dem abschließenden Dokumentkopf bleibt erhalten; sie wird nicht aus einem
früheren Ergebnis bestätigt. Echte Authentifizierung, frische Principal-Abschlüsse,
nativer Binär-/Schema-/Versionsvergleich und bestätigter COMMIT/Close bleiben
bei den bisherigen Besitzern. Kein Berechtigungs- oder Zeilencache wird eingeführt.

Workspace- und Headerwerte behalten die PostgreSQL-Treibertypen und bisherigen
Text-/Binärgrenzen. Die vorhandenen Headerentscheidungen sind bytegleich.
Die Reservierungsbedingungen liegen gemeinsam in
`app/lib/collaboration/room-admission-predicates.ts`; ihre erzeugten bisherigen
SQL-Ausdrücke und alle Funktionskörper in `room-admission.ts` sind bytegleich.
Der Testtreiber verlangt das neue Modul ausdrücklich als tatsächlichen Quelleingang.
Bestehende Testfälle, Erwartungen, Auswahl, Fristen und Retries bleiben unverändert.

Zusätzlich werden Registry und nativer Zustand vor ihrem FULL JOIN jeweils auf
die selektierte Dokument-ID begrenzt. Das gilt auch für die drei Dokumentbelege
des öffentlichen Lesediensts. Der Workspace-Filter bleibt außerhalb des Joins,
damit widersprüchliche oder verwaiste Zuordnungen weiterhin sichtbar und ablehnbar
bleiben. Es gibt keinen neuen Index: Tatsächliche PostgreSQL-Pläne bei 200 Quellen
zeigen an allen sechs Lesestellen je einen Indexzugriff mit einer Ergebniszeile
pro Tabelle; zuvor lasen die drei nativen Beobachtungen jeweils beide Tabellen
mit je 200 Zeilen.

## Messung

18 separate Läufe vergleichen den unveränderten Ausgangsstand und die Umsetzung:
HTTP, registrierter Agent und MCP, jeweils Erstaufruf und zwei warme Lesevorgänge
bei 10 und 200 regulären nativen Quellen. Sechs dieser Läufe prüfen zusätzlich
200 Quellen mit 2 ms Verzögerung je tatsächlicher erfolgreicher PostgreSQL-Antwort.
Originalantworten und Fehler bleiben erhalten; es werden keine SQL-Anweisungen
hinzugefügt. Das ist eine Sensitivitätsprüfung, keine gemessene Produktions-RTT.
Quell-Hashes, Originalidentität/-bytes und vollständiger Markdown-Inhalt sind geprüft.
Alle eigenen Ressourcen schließen; Messungen laufen ohne parallele Builds/Tests.

Warme vollständige Adapter-Lesefenster bei 10 **und** 200 Quellen:

| Adapter | SQL vorher → nachher | Ausleihen vorher → nachher |
| --- | --- | --- |
| HTTP `/api/documents/read` | 69 → 59 | 9 → 9 |
| Registrierter Agent | 109 → 99 | 3 → 3 |
| MCP | 84 → 74 | 19 → 19 |

Das sind API-/Tool-Lesefenster, keine gesamte Editor-Startzeit. Die Erstaufrufe
beinhalten den jeweiligen Adapterstart, keinen geleerten Datenbank-Seitencache.

Warme Fenster mit 2 ms Antwortverzögerung, Millisekunden; je zwei Beobachtungen:

| Adapter | Vorher | Nachher |
| --- | --- | --- |
| HTTP | 250.27–252.42 | 221.54–230.61 |
| Agent | 375.48–396.47 | 336.14–357.87 |
| MCP | 289.59–318.57 | 275.13–279.67 |

Ohne zusätzliche Verzögerung streuen die kleinen lokalen Laufzeiten. Ein
Zehn-Quellen-HTTP-Paar war mit 86.14–87.84 ms langsamer als 67.59–72.89 ms;
der Befund bleibt im Bericht. Fünf vorab festgelegte weitere Paare mit wechselnder
Reihenfolge ergeben je zehn warme Beobachtungen: Median
70.38 → 69.23 ms, Mittelwert
70.10 → 70.30 ms. Lokal ist damit kein
wesentlicher allgemeiner Latenzgewinn nachgewiesen. Belegt sind weniger Roundtrips,
gezielte ID-Zugriffe und die Verbesserung unter der begrenzten Antwortlatenz.
Dies ist kein Produktions-p95- oder Lastnachweis.

## Korrektheit und noch offene Abnahme

Die fünf unveränderten betroffenen Integrationssuiten bestehen: 26 native
Lesefamilien, 6 Kontroll- und 24 Fehlerfälle über HTTP/Agent/MCP, 21 öffentliche
Lesedienstfälle, 9 echte Edit-Principal-Familien und 8 registrierte Edit-Gruppen.
Geprüft sind unter anderem tatsächliche Backend-/Transaktions-/Schemaänderungen,
fehlende Zustände, beschädigte Bytes, Metadaten, echtes exklusives Admission,
Rechte-/Sitzungsentzug sowie verlorene COMMIT-/ROLLBACK-Antworten und Close-Fehler.
Die echte Admission-Suite bestätigt zusätzlich Exact-/Subtree-/Leerscope-Grenzen,
Reservierungen, Owner-Fencing und Wiederaufnahme. Originalzeilen und Inhalte bleiben
unverändert; sämtliche eigenen Schemas, Clients und DATA-Verzeichnisse schließen.

Release-Typecheck plus sechs betroffene Test-/Messquellen und ESLint bestehen.
Ein zusätzlich gestarteter breiter Typecheck aller Skripte meldet 81 Diagnosen:
Der unveränderte archivierte Ausgangsstand hat dieselben Fundstellen, Codes und
Erstmeldungen; sie liegen außerhalb der geänderten Produktdateien. Dies wird nicht
als bestandene allgemeine Skript-Typprüfung dargestellt.

Die vollständigen lokalen Nachweise liegen in der verwalteten Artefaktablage unter
`owned-linux-fixture-1793174893918/native-read-phase-20261029/final/`:
`focused-validation.json`, `paired-read-matrix.json`, `http10-repeat/result.json`,
`explain-plans.json` und `baseline-source.json`. Der ursprüngliche Versuch mit einer
zusätzlichen redundanten Abschluss-Katalogbeobachtung bleibt daneben getrennt
als Diagnose erhalten und ist keine aktuelle Abnahme.

Am Produktstand `0e088417588b780ccc3ea24e36e9c3c0eb63869b` bestehen jetzt auch
vollständiger Host-/Linux-Build, Start mit derselben Datenbank und denselben
Volumes, alle neun CI-Prüfungen und vier Browserfälle. Der Browserlauf benötigt
88.873 Sekunden, mit null fehlgeschlagenen/übersprungenen/flaky Fällen und null
Playwright-Fallwiederholungen. Eine unveränderte begrenzte Anmeldung wiederholt
nach einer tatsächlichen HTTP-429-Antwort einmal nach sechs Sekunden.

Die Browserprüfung liest den aktuellen nativen Inhalt mit fünf echten
`/api/documents/read`-Abrufen aus beiden geöffneten Editoren, nach Änderungen
beider Benutzer sowie aus einer frischen Ansicht mit Leserechten. Diese wird
zusätzlich mit 390 × 844 Pixeln geprüft. Die API-Prüfung vergleicht IDs,
Generation, Workspace, Pfad und vollständigen Inhalt. Der reale
Schreibrechteentzug sperrt die alte Sitzung; der Owner schreibt weiter. Der
bestehende mobile Save-/Exportfehler-/Peer-Replay-Fall und die beiden
Agenten-Zugriffs-/Widerrufsfälle bestehen ebenfalls. `documentReviewEnabled=false`
ist am tatsächlichen Server geprüft. Die 15 Linux-Speichertests bestehen.
Originalzeilen/xmin, Dateibytes und Speicheranker sowie die elf anderen Container
bleiben erhalten. Desktop- und Mobil-Screenshots sind visuell geprüft; die
bereits bekannte kurzzeitige Presence-Markierung über einem Teil der ersten
mobilen Textzeile bleibt als Beobachtung dokumentiert, ohne neue UI-Änderung.

Das geprüfte Image ist
`sha256:6e521077792702c49a7655ca4e41bceeef3c1071907023db32e01ab6fa68d654`,
der Container `803c1d0579266e1c861a48c4fa2fd796dc75d563a4a130ccaf50e6678caf7740`.
Nachweise: `linux-document-image-1793285621647-result.json`,
`native-read-linux-update-1793285619566-progress.json` und
`native-read-ui-linux-1793286620341-result.json` in der verwalteten Artefaktablage.
Die Zusatz-Browserquelle ist ausschließlich im privaten Testtreiber gepinnt,
SHA-256 `434f583a57faec34472cf5cec26b69a421e6f989e82fa6aebdb48f8922365b3b`;
Anwendungscode wird nicht überlagert.

Die Buildlaufzeiten sind gegenüber dem vorherigen Produktstand gestiegen:
Host 236.374 → 492.698 Sekunden, Linux 353.170 → 866.464 Sekunden. Die Ursache
ist noch nicht isoliert. Das Image wächst dabei lediglich von 12755322863 auf
12755802742 Bytes (479879 Bytes); es gibt keinen Nachweis einer entsprechenden
Größenzunahme des ausgelieferten Produkts. Die erfolgreiche Ausführung innerhalb
des freigegebenen Limits ist kein Beleg für unveränderten Compileraufwand.

Die vorläufige HTTP-Grenze von 20 SQL-Aufrufen ist mit 59 noch nicht erreicht.
Create ist hier nicht neu gemessen; der letzte akzeptierte Stand bleibt Agent
1058/34 und MCP 702/29. Weitere strukturelle Bündelung, inkrementelle Linkabhängigkeiten,
gemeinsame normale Schreibwege und sämtliche übrigen Pakete des Gesamtplans
bleiben offen, einschließlich regulärer finaler Gesamtsuite, PR/CI/Reviews/Main,
frischem Produktionsbackup mit echtem Restore, verlustfreier Reparatur und Release.
