# Native Pfadaktionen: getrennte erste und wiederholte Rename-/Move-Aufrufe

Stand: 27.10.2026. Produktgrundlage `129da07c2fe7ef045003052f0f9beae87012a6ea`,
Messwerkzeug `80e830a7621de7a2addcd6a38a70c61bb3c37fcf`.
Teil des [zentralen Dokument- und Linkservice](../document-write-database-performance-plan.md).
Die [maschinenlesbaren Daten](document-service-path-cold-warm-2026-10-27.json)
enthalten Messwerte, Repository-Quellbelege und Prüfmerkmale ohne Dokumentinhalte,
Dokument-/Benutzeridentitäten, Dokumentpfade, SQL-Texte, Parameter oder Secrets.

## Vergleich und Messgrenzen

Jede Familie und Größe startet in einem eigenen Prozess mit eigenem PostgreSQL-18-
Schema und privatem Datenverzeichnis. Der reguläre native Starter bleibt erhalten;
die übrigen Quellen entstehen über den tatsächlichen Upload-/Birth-/Projektionsdienst.
Der erste Cookie-Aufruf führt Rename oder den öffentlichen mobilen Move aus;
der zweite verwendet einen neuen ursprünglichen Operationsschlüssel und führt den
Rückweg aus. Dieser zweite Aufruf ist keine Wiederholung eines abgeschlossenen Jobs.
Vorschau, tatsächlicher Worker, unveränderte Fristen, Originalbelege, Statusantworten,
native Änderungen und physische Projektion sind aktiv. Es gibt keine Peer-Verbindung
in diesem Profiler. Die separat gerenderte Zwei-Peer-Prüfung ist im
[UI-Bericht](document-service-native-path-ui-2026-10-27.md) dokumentiert.

Die Spalten nennen SQL-Aufrufe / Pool-Ausleihen. Der Vordergrund umfasst den
ursprünglichen Ablauf mit Vorschau und Statusabfragen; das Prozessfenster enthält
zusätzlich die tatsächlich laufenden Worker-/Projektorabfragen. Der Vordergrund
ist darin bereits enthalten. Beide Werte dürfen nicht addiert werden. Administrative
Beobachtungsabfragen gehören nicht zum instrumentierten Laufzeitpool.
Der Zähler erfasst Treiberaufrufe einschließlich Transaktionskontrolle;
mehrteilige Befehlsstrings werden nicht in Einzelanweisungen zerlegt.

| Familie | Dokumente | Aufruf | Vordergrund SQL / Ausleihen | Prozess SQL / Ausleihen | Sekunden |
| --- | ---: | --- | ---: | ---: | ---: |
| move | 10 | erster Aufruf | 1382 / 149 | 4538 / 376 | 30.27 |
| move | 10 | Rückweg | 1378 / 145 | 4405 / 368 | 30.08 |
| move | 200 | erster Aufruf | 8492 / 778 | 21956 / 1233 | 90.48 |
| move | 200 | Rückweg | 8493 / 779 | 21824 / 1228 | 89.94 |
| rename | 10 | erster Aufruf | 1382 / 149 | 4406 / 372 | 30.15 |
| rename | 10 | Rückweg | 1381 / 148 | 4406 / 372 | 30.25 |
| rename | 200 | erster Aufruf | 8491 / 777 | 21826 / 1230 | 90.23 |
| rename | 200 | Rückweg | 8492 / 778 | 21830 / 1233 | 90.03 |

„Erster Aufruf“ bezeichnet die erste öffentliche Dateiaktion des frischen
Prozesses nach Aufbau und tatsächlichem Abschluss des initialen Projektionsrückstands.
Datenbank und gemeinsame Module wurden bereits durch diesen Aufbau verwendet;
eine kalte PostgreSQL-Platte, ein Browser und Next-Middleware werden nicht behauptet.
Die lokalen Zeiten sind keine Produktionslatenz-Grenzen. Hintergrundzyklen können
Fenstergrenzen überschreiten: Beispielsweise bleibt beim ersten 10er-Rename am
Fensterende eine tatsächlich laufende Abfrage/Lease sichtbar. Alle verbleibenden
Abfragen und Ressourcen sind vor dem vollständigen Fixture-Abbau geschlossen.
Die kurzen Service-/Phasenwerte sind teilweise verschachtelt und keine Summanden.

## Daten- und Lebenszyklusprüfung

Alle acht Aktionen bestehen. Ein- und ausgehende relative Links werden in beiden
Richtungen korrekt angepasst. Der Rückweg stellt die ursprünglichen Pfade und
Markdown-Bytes der beiden betroffenen Dokumente wieder her. Ihre Dokument-IDs,
Lineage und Generationen bleiben erhalten; Sequenzen dürfen durch die absichtlichen
Inhaltsänderungen steigen. Native Sequenz und physischer Checkpoint stimmen überein.
Die echte dauerhafte Projektionsdiagnose meldet keine offenen Projektionen,
Identitätskonflikte, Quarantänen oder Binärpersistenzfehler.

Alle acht beziehungsweise 198 unbeteiligten Quellen einschließlich des Starters
behalten Registry, Lineage, nativen Zustand, Metadaten, deren `xmin` und physische
Bytes. Die gemeinsame Instrumentierung bleibt vollständig aktiv; keine
Berechtigungs-, SQL-, Writer- oder Transportergebnisse werden ersetzt. Sämtliche
ursprünglichen Principal-/Transaktionsfristen bleiben unverändert.

Ein erster erweiterter Vergleich erfasste den Starter vor seinem noch offenen
regulären Initialprojektionsschritt. Der danach regulär laufende Projektor änderte
seine kanonischen Checkpoint-/Snapshot-Metadaten; die strenge Erhaltungsprüfung
meldete dies. Der endgültige Test beobachtet die reale offene Starterprojektion
und wartet vor der ersten Aktion unter der echten Workspace-Sperre auf ihren
Abschluss. Erst danach werden die unveränderlichen Ausgangszeilen und Dateihashes
aufgenommen. Der Vergleich wird nach einer Aktion nie neu aufgenommen oder gefiltert.

Das Aktionsfenster wartet neben dem physischen Checkpoint auf das tatsächliche
dauerhafte Projektionsprädikat. Der administrative Beobachter verwendet dafür
dieselbe Produktdiagnose auf der tatsächlichen Fixture-Verbindung; seine Abfragen
werden nicht als Produktabfragen gezählt. Nach geordnetem Serverende werden die
realen Workspace-Sperren abgewartet, bevor Pool und Schema schließen. Dadurch
laufen bereits begonnene Projektor-Dateiarbeiten zu Ende. Es gibt in den
abgenommenen Läufen keine Projektor-Fehlermeldung beim Abbau.

Worker, Server, Projektorfences, Pool, Clients, eigenes Schema, Datenverzeichnis
und Bundle-Ordner schließen vollständig. Alle vier Bundles enthalten denselben
Quellgraphen und denselben SHA-256; die einzeln gespeicherten Produkt-/Messquellen
bleiben über die Läufe byteidentisch. Release-TypeScript ist für diese reine
Messwerkzeugänderung nicht erneut ausgeführt; der abhängige Testgraph mit 5.129
Quelldateien liefert null Diagnosen, ESLint besteht. Review Center und Datei-Undo
sind nachweislich deaktiviert.

## Noch offener Gesamtauftrag

Diese Matrix vervollständigt das getrennte Größen-/Wiederholungsfeld für die
beschriebenen Pfadaktionen. Sie ersetzt keine Leistungsoptimierung. Die
[Create-Matrix](document-service-create-matrix-2026-10-27.md) und die bisherigen
Leser-/Editor-Messungen bleiben mit ihren jeweiligen Quell- und Messgrenzen bestehen.
Weitere aktuelle Fakten-/Verbindungsbündelung, inkrementelle Zielauflösung,
gemeinsame Schreibmechanik und die ursprüngliche Dokument-Recovery sind weiterhin
erforderlich. Finale Budgets, reguläres `test:all`, PR/CI/Reviews, geprüfte
Sicherung/Wiederherstellung sowie Release, Deployment und Prüfung aller fünf
Workspaces bleiben Teil des ursprünglichen Plans.
