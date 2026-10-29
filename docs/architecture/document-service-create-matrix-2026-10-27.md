# Native Create: registrierter Agent und MCP bei 10 und 200 Dokumenten

Diese Messung ist die ursprüngliche Vergleichsbasis. Der nachfolgende
[Agenten-Scope-Vergleich](document-service-agent-create-facts-2026-10-27.md)
belegt die erste weitere Bündelung bei gleichem registrierten Aufrufer und Testaufbau.

Stand: 27.10.2026. Produktgrundlage `9fee44a700e455507b0a9ecd566bc98fac8f52b7`,
Messwerkzeug `de092c88e7d707f7b19ffc88a69fd388df56ba9b`.
Teil des [zentralen Dokument- und Linkservice](../document-write-database-performance-plan.md).
Die [maschinenlesbaren Ergebnisse](document-service-create-matrix-2026-10-27.json)
enthalten Messwerte, Repository-Quellbelege und Prüfmerkmale. Dokumentinhalte,
Dokument-/Benutzeridentitäten, Dokumentpfade, SQL-Texte, Parameter und
Secrets werden nicht veröffentlicht.

## Vergleich

Jeder Adapter und jede Größe laufen in einem eigenen Prozess und privaten
PostgreSQL-18-Fixture. Alle zunächst 10 beziehungsweise 200 nativen Dokumente
entstehen über den tatsächlichen Upload-/Birth-/Projektionsdienst. Der Agent
verwendet das durch `getPiTools` registrierte `write` mit tatsächlicher gespeicherter
PI-Sitzung und Aufrufbindung. MCP verwendet den tatsächlichen JWT-/Web-Request-
Transport einschließlich `initialize`, `tools/list` und `create_knowledge_source`.
Die Original-Sitzungen, Rechte, nativen Zustände und Writer-Ergebnisse bleiben echt.
Die isoliert signierte Lizenz und Seats sind ausdrücklich Testdaten; echte
Control-Plane-Ausstellung, Browser-OAuth und ein Modellaufruf sind nicht Teil der Prüfung.

Jede Zelle nennt SQL-Aufrufe / Pool-Ausleihen / lokale Sekunden.
Der Zähler erfasst Treiber-Query-Aufrufe einschließlich Transaktionskontrolle;
mehrteilige Befehlsstrings werden nicht in Einzelanweisungen zerlegt.

| Adapter | Anfangsbestand | Erster Einstieg + neue Datei | Neue Datei warm 1 | Neue Datei warm 2 | Ursprüngliche Wiederholung |
| --- | ---: | ---: | ---: | ---: | ---: |
| agent | 10 | 5308 / 92 / 4.24 | 5203 / 58 / 3.85 | 5203 / 58 / 3.76 | 326 / 7 / 0.24 |
| agent | 200 | 5308 / 92 / 4.32 | 5203 / 58 / 3.92 | 5203 / 58 / 3.95 | 326 / 7 / 0.23 |
| mcp | 10 | 3289 / 50 / 2.96 | 3268 / 37 / 2.94 | 3268 / 37 / 2.69 | 133 / 12 / 0.14 |
| mcp | 200 | 3289 / 50 / 3.07 | 3268 / 37 / 2.89 | 3268 / 37 / 2.84 | 133 / 12 / 0.13 |

Die SQL- und Ausleihenzahlen stimmen für beide Adapter bei 10 und 200
Anfangsdokumenten in allen vier Fenstern exakt überein. Im warmen MCP-Aufruf
entfallen 1.529 der 3.268 Aufrufe auf die Katalogfamilie; im warmen Agentenaufruf
sind es 1.884 von 5.203. Die feste Familienklassifikation verwendet SQL-Merkmale
und ist eine diagnostische Heuristik, keine Autoritätsentscheidung.
Der gemeinsame Create-Engine des Main-Agent-Fixtures führt 229 aktuelle
Berechtigungsbeobachtungen mit zusammen 2.748 SQL-Aufrufen aus; sein vollständiger
Messbereich umfasst 4.994 Aufrufe. Der MCP-Create-Engine benötigt 3.224.
Diese Servicewerte sind in den vollständigen Adapterfenstern enthalten.

Der Anfangsbestand wächst durch die drei erfolgreichen Neuanlagen um drei
Dokumente. Die beiden warmen Neuanlagen laufen daher bei 11/12 beziehungsweise
201/202 vorhandenen Dokumenten; die gesonderte Wiederholung bei 13 beziehungsweise
203. Sie verwendet exakt ursprünglichen Pfad, Inhalt und Idempotenzschlüssel und
ist keine weitere Neuanlage. Die wiederholten frischen Aufrufe erzeugen jeweils
eigene Ziele und Schlüssel.

Der erste Aufruf enthält die jeweilige Toolregistrierung beziehungsweise MCP-
Initialisierung. Der normale Upload-Aufbau hat vorher bereits Datenbank und
gemeinsame Module verwendet. „Erster Einstieg“ bedeutet den ersten Adapteraufruf
dieses frischen Prozesses, keine kalte PostgreSQL-Platte oder identische einzelne
RPCs zwischen Agent und MCP. Die Datenbank-Aktivitätsfenster enthalten den ganzen
registrierten Aufruf. Die zusätzlich gespeicherten Create-Engine-/Phasenwerte
liegen teilweise ineinander und dürfen nicht addiert werden. Pool-Ausleihen sind
keine neu aufgebauten TCP-Verbindungen. Die lokalen Zeiten sind keine
Produktionslatenz-Grenzen oder kontrollierten Vorher-/Nachher-Benchmarks.

Der Agent verwendet den tatsächlichen Main-Agent-Fixture. Der ältere verzögerte
PI-Test verwendet einen eingeschränkten Agenten und andere Eingangsdaten. Seine
6.452 Anweisungen sind daher kein direkter Vorherwert dieser Messung.

## Korrektheit und Quellenbindung

Alle vier Fixtures bestehen. Jede neue Datei besitzt genau eine native Identität,
einen ursprünglichen Importbeleg, eine vollständige tatsächliche Birth-Bindung und
eine abgeschlossene Projektion. Die ursprüngliche Attribution nennt den wirklichen
PI- beziehungsweise OAuth-Sitzungskontext. Der authentifizierte Dokument-ID-Leser
liefert den vollständigen erwarteten Markdown-Inhalt; die physische Datei stimmt
bytegenau überein. Die Originalwiederholung behält Dokument-ID, Lineage und
Operations-ID und erhöht die Dokumentanzahl nicht.

Sämtliche 10 beziehungsweise 200 vorherigen nativen Dokumente behalten Registry,
Lineage, nativen Zustand, Metadaten und deren `xmin`. Ihre physischen Bytes bleiben
unverändert. Alle gemessenen Fenster schließen ohne offene Queries/Leases,
unbekannte Query-Formen oder fehlgeschlagene SQL-Aufrufe. Danach schließen Pool
und Clients, das eigene Schema und Datenverzeichnis werden entfernt und der
Runner entfernt seinen eigenen Bundle-Ordner. Die großen Fixtures laufen strikt
nacheinander. Typprüfung mit tatsächlichen Projektdeklarationen umfasst 5.086
Quelldateien ohne Diagnose; ESLint besteht. Review Center und Datei-Undo bleiben aus.

Alle vier unabhängigen Bundles enthalten denselben Quellgraphen mit 1.291 Eingängen und
denselben SHA-256. Die einzelnen Produkt-/Werkzeugquellen bleiben über sämtliche
Messungen byteidentisch. Der Werkzeugcommit fügt nur den Messlauf und dessen
Runner-Zulassung hinzu; Produktcode wird dabei nicht verändert.

## Folgerung und verbleibender Auftrag

Die vollständige Tabelle grenzt den festen Aufwand der geprüften Neuanlage gegen
die untersuchte Bestandsgröße ab. Katalog-, Account-, Sitzungs- und Workspace-
Gruppen sowie die wiederholten aktuellen Berechtigungsbeobachtungen bleiben
konkrete Ansatzpunkte für die nächste Bündelung auf der tatsächlich gehaltenen
Verbindung. Aktuelle Rechte, ursprüngliche Bindungen, Realm, Sperren und die
bestehenden Fristen müssen dabei erhalten bleiben.

Separate kalte und warme Rename-/Move-Aktionen, die übrige Bündelung und endgültige
Budgets, inkrementelle Zielauflösung, gemeinsame Schreibmechanik und die
ursprüngliche Dokument-Recovery bleiben erforderlich. Reguläres `test:all` am
endgültigen Stand, PR/CI/Reviews, geprüfte Sicherung/Wiederherstellung sowie Release,
Deployment und Abnahme aller fünf Workspaces sind weiterhin offen. Dieser Bericht
nimmt ausschließlich die beschriebene Create-Messmatrix ab.
