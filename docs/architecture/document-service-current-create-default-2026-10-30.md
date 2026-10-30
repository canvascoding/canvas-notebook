# Anlage im ausgeschalteten Standardmodus

Stand: 30.10.2026. Produktbasis `6302d6403755e581f0eae9e83a10e1c016aa918c`.
[Quellhashes und zwölf Messfenster](document-service-current-create-default-2026-10-30.json).

Der alte Anlage-Profiler setzte `FILE_VERSION_CENTER_MODE=shadow` innerhalb
der Fixture fest. Die normale App verwendet bei fehlender Vorgabe `off`;
auch der bestehende lokale Notebook-Container setzt keine abweichende Vorgabe.
Der Messlauf erzwingt diesen Schattenmodus jetzt nicht mehr und protokolliert
den tatsächlich gewählten Modus. Für historische Kontrollen bleibt eine
ausdrückliche `shadow`-Vorgabe möglich. Der Produktcode ist unverändert.

## Tatsächlicher Standardlauf

Alle drei frischen PostgreSQL-18-Fixtures verwenden `off` und zehn über den
normalen Upload-/Birth-/Projektionsweg angelegte Quellen. Der vorhandene
Organisations-Agent wird durch die echte Profil-Factory und gespeicherte
Mitgliedschaft erzeugt. Der jeweils registrierte Agent- oder MCP-Einstieg legt
drei neue Dokumente an und wiederholt die erste ursprüngliche Operation.
Review Center und Datei-Undo sind durch die bestehenden Testassertionen
ausgeschaltet. Modellturns und Produktions-OAuth-Ausstellung werden nicht behauptet.

| Einstieg | Erste Anlage: SQL / Pool-Zähler | Warme Anlage: SQL / Pool-Zähler | Original-Retry: SQL / Pool-Zähler |
| --- | ---: | ---: | ---: |
| Hauptagent | 1163 / 68 | 1058 / 34 | 168 / 7 |
| Organisationsagent | 1336 / 68 | 1220 / 34 | 194 / 7 |
| MCP | 696 / 38 | 675 / 25 | 91 / 12 |

Beide warmen Anlagen stimmen je Einstieg in SQL- und Pool-Zahl überein. Die
[genaue Verbindungsdiagnose](document-service-physical-connections-2026-10-30.md)
misst maximal vier bereite Laufzeitverbindungen, beim Retry maximal drei. Diese
Create-Fenster verwenden gepoolte Clients. Alle zwölf SQL-Callsite-Zähler stimmen
exakt überein; Beobachtungs-/Stackfehler, fehlgeschlagene Anweisungen, unbekannte
Query-Formen und am Fensterende offene zugeordnete Queries/Leases sind null.

Die Originaloperation behält ihre Identität und ihre vollständigen Bytes; die
Wiederholung erzeugt kein weiteres Dokument. Alle zuvor vorhandenen nativen,
Registry-/Lineage- und Metadatenzeilen mit `xmin` sowie physischen Quelldateien
bleiben unverändert. Eigene Clients, Pool, Schema und Datenverzeichnis schließen.
Die zusätzliche äußere Prüfung bestätigt die unveränderten geschützten
QA-Originalzeilen, nativen Zustände, Dateibytes und drei Speicheranker; alle
laufenden Container behalten ihre IDs.

## Bedeutung für die weitere Umsetzung

Auch im gewünschten ausgeschalteten Zustand benötigen die beiden Agenten weit
über tausend SQL-Aufrufe pro warmer Anlage. Die Aufgaben des gemeinsamen
Dokumentservice bleiben daher erforderlich. Der neue Standardlauf ist keine
Produkteinsparung und darf nicht als Vorher-/Nachher-Gewinn gegen historische
Schattenmodus-Läufe anderer Produktstände ausgewiesen werden.

Die aktuellen 200-Quellen-Anlagen, Editor-Fenster und öffentlichen Rename-/Move-
Fenster mit genauer Verbindungszählung bleiben für die vollständige Messgrundlage
offen. Review Center und Undo werden nicht weiterentwickelt. Leistungsbudgets,
Faktenbündelung, begrenzte native Body-Lesungen, gemeinsame Schreibwege und die
übrigen Abnahmen des [Gesamtplans](../document-write-database-performance-plan.md)
sind weiterhin erforderlich.
