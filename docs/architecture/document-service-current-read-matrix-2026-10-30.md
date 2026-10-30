# Aktuelle Lesewege: HTTP, Hauptagent, Organisationsagent und MCP

Stand: 30.10.2026. Produktbasis `6302d6403755e581f0eae9e83a10e1c016aa918c`,
Diagnosebasis `c93a04acc0029b3b932b0c7d5e9ac45e622e4696`. Produktcode ist gegenüber PR #191
unverändert. Der Lese-Fixture verwendet jetzt zusätzlich denselben normalen
Organisations-Agenten, den die vorhandene Anlage-Messung unterstützt.
[Quellhashes und 24 Messfenster](document-service-current-read-matrix-2026-10-30.json).

## Ergebnis

Alle acht frischen PostgreSQL-Fixtures mit jeweils zehn oder 200 Quellen bestehen.
Jeder führt den tatsächlichen ersten Aufruf und zwei warme Lesevorgänge aus.
Vollständiger kanonischer Markdown, Ziel-ID, Lineage, Pfad, Byteanzahl und
Lesefortsetzung stimmen mit dem Original überein. Alle ursprünglichen nativen
Zeilen, Metadaten, Revisionen, Projektionen, `xmin` und Zustandsbytes bleiben
innerhalb der jeweiligen Fixture gleich.

| Einstieg | Erster Aufruf: SQL / Pool-Zähler | Warmer Aufruf: SQL / Pool-Zähler | Maximum bereiter Laufzeitverbindungen |
| --- | ---: | ---: | ---: |
| HTTP | 62 / 12 | 59 / 9 | 2 |
| Hauptagent | 204 / 37 | 99 / 3 | 2 |
| Organisationsagent | 233 / 37 | 117 / 3 | 2 |
| MCP | 95 / 32 | 74 / 19 | 3–4 |

Die SQL- und Pool-Werte sind bei zehn und 200 Quellen sowie beiden warmen
Wiederholungen identisch. Der erste Agenteneinstieg enthält die echte
Tool-Registrierung, der erste MCP-Einstieg außerdem Initialize und Tools/List.
Dieser Aufbau ist in den warmen Aufrufen nicht erneut enthalten.

Die [genaue Verbindungsdiagnose](document-service-physical-connections-2026-10-30.md)
besteht in allen 24 Fenstern ohne späten Beginn, Beobachtungsfehler oder
verbliebene eigene Laufzeitverbindung. Hier entstehen ausschließlich gepoolte
Laufzeitverbindungen; die separaten Owner-Abläufe brauchen weiterhin ihre
eigenen Editor-/Pfadmessungen. Der vorhandene Callsite-Profiler zählt jedes
ausgeführte SQL exakt mit; Stackfehler, fehlgeschlagene SQL-Aufrufe und
unbekannte Query-Formen sind null. Am Ende jedes Lesevorgangs sind keine
zugeordneten Abfragen oder Pool-Leases offen.

## Sichtbare weitere Arbeit

MCP benötigt im warmen Fenster 19 Pool-Abschlüsse bei maximal vier tatsächlich
bereiten Backends. Die Zähler beschreiben unterschiedliche Kosten. Vier der
Ausleihen werden der Lizenzrevision, zwei der Quellenbereichsermittlung und
zwei der Bereinigung der MCP-Anfragehistorie zugeordnet; allgemeine asynchrone
Einstiege bleiben als unbekannt gekennzeichnet. Auf zwei großen Ausleihen
liegen 35 und 14 SQL-Aufrufe. Diese Beobachtung erlaubt keine pauschale
Entfernung von Lizenz-, Audit- oder aktuellen Rechteprüfungen.

Der Organisationsagent braucht in diesem Reader 18 SQL-Aufrufe mehr als der
Hauptagent bei derselben Zahl von Pool-Abschlüssen. Die tatsächlichen
Mitgliedschafts-/Agentenzugriffs- und Kontextleser sind als wiederholte Aufrufer
sichtbar. Dies ist die Messgrundlage für eine gemeinsame frische
Phasenbeobachtung, kein Berechtigungs-Cache und noch keine Produkteinsparung.

## Grenzen und Datenerhalt

Die vorhandenen HTTP-Handler beziehungsweise registrierten Tool-Dispatches und
die native Lesedatenbank führen die Arbeit unverändert aus. Die HTTP-Messung
umfasst keine Next-Middleware oder Browseransicht; Agenten-Modellturn und
Produktions-OAuth-Ausstellung sind ebenfalls außerhalb dieser Fixture. Die
zusätzliche Stackdiagnose beeinflusst Laufzeiten, deshalb sind die lokalen
Zeiten in den Daten kein Produktionslatenz-Versprechen.

Alle acht Prozesse schließen eigene Clients, Pool, Schemas und temporäre Daten.
Zusätzlich bleiben die geschützten vorhandenen QA-Originalzeilen mit `xmin`,
nativen Zuständen, Dateibytes und drei Speicherankern vor und nach der Matrix
identisch. Sämtliche laufenden Container behalten ihre IDs; es gibt keinen
Container-Neustart. Review Center und Undo erhalten keine neue Funktionalität.

Die vollständigen aktuellen Anlage-, Editor- und öffentlichen Rename-/Move-
Vergleiche mit dieser Verbindungsdiagnose sowie die übrigen Pakete des
[Gesamtplans](../document-write-database-performance-plan.md) bleiben offen.
Die Leistungsbudgets sind noch nicht erreicht.
