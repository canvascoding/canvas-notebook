# Dokumentservice: aktueller Create-Vergleich mit 10 und 200 Quellen

Stand: 27.10.2026. Tatsächlicher Produktstand `0a40365484806ea83d1e906d99406ff1445bde6b`.
Dies schließt die aktuelle Create-Messbasis ab; die Abnahme des gesamten
[Serviceplans](../document-write-database-performance-plan.md) bleibt offen.
Der [maschinenlesbare Bericht](document-service-create-matrix-current-2026-10-27.json)
bindet alle Quellen und vier tatsächlichen Fixture-Ausgaben per SHA-256.

Agent und MCP laufen je Größe in einem eigenen frischen Prozess und privaten
PostgreSQL-Schema. Alle 10 beziehungsweise 200 bestehenden Quellen entstehen über
reguläre authentifizierte Uploads und abgeschlossene native/physische Projektion.
Der Agent verwendet das registrierte write-Werkzeug, MCP den wirklichen
Request/Response-Transport. Review Center und Undo sind ausdrücklich deaktiviert.
Ein LLM-Chatturn, produktive OAuth-Ausstellung, Browser/Middleware und ein kalter
PostgreSQL-Puffercache sind nicht Teil dieses Vergleichs.

Die Zellen nennen SQL-Treiberaufrufe / Pool-Ausleihen. Transaktionssteuerung ist
enthalten; mehrteilige Befehlsstrings werden nicht in Einzelanweisungen zerlegt.
Eine Ausleihe ist keine neu aufgebaute TCP-Verbindung.

| Adapter | Quellen vor erster Anlage | Erster Adaptereinstieg | Warme Anlage 1 / 2 | Ursprüngliche Wiederholung |
| --- | ---: | ---: | ---: | ---: |
| agent | 10 | 2285 / 80 | 2180 / 46; 2180 / 46 | 180 / 7 |
| agent | 200 | 2285 / 80 | 2180 / 46; 2180 / 46 | 180 / 7 |
| mcp | 10 | 2618 / 50 | 2597 / 37; 2597 / 37 | 129 / 12 |
| mcp | 200 | 2618 / 50 | 2597 / 37; 2597 / 37 | 129 / 12 |

Alle 16 Fenster bestehen. Innerhalb jedes Adapters sind SQL-Anzahl und Ausleihen
bei 10 und 200 Quellen identisch. Die lokale Dauer einer warmen Anlage liegt in
diesen Läufen ungefähr bei 3,0 Sekunden für Agent und 2,6 Sekunden für MCP.
Die Adapter haben unterschiedliche Eintritts-/Transportarbeit; daraus wird weder
eine kontrollierte Latenzverbesserung noch eine Rangfolge ihrer Geschwindigkeit
abgeleitet. Der erste MCP-Einstieg enthält initialize/tools-list; der erste
Agenteneinstieg enthält die Werkzeugregistrierung.

Jede der drei frischen Anlagen erzeugt genau ein natives Dokument. Birth und
Projektion sind abgeschlossen; ihre Revisions-ID-Felder stimmen überein. Authentifizierter
Dokument-ID-Leser und physische Datei liefern den vollständigen Originalinhalt.
Eine gesonderte Wiederholung bestätigt dieselben Dokument-, Lineage- und
Operationskennungen; Claim und gespeicherter Birth-Fingerprint werden auf Konsistenz geprüft. Alle ursprünglichen Registry-, Lineage-, Native- und
Metadatenzeilen einschließlich xmin sowie die physischen Bytes bleiben gleich.
Die Fixture-Prüfung verlangt tatsächlich null eigene Backends vor dem Schemaabbau;
Schema, Pool, Clients und eigenes Datenverzeichnis schließen vollständig. Alle
Messfenster enden ohne offene Abfragen/Verbindungen und ohne fehlgeschlagene oder
nicht unterstützte Query-Formen. Externe Fetches bleiben null.

## Offene Abnahme des gemeinsamen Services

Die Create-Zielgröße von wenigen Hundert SQL-Aufrufen ist noch nicht erreicht.
Die bisherigen Leser-/Editorberichte gelten für ihre gespeicherten Quellen,
nicht automatisch für diesen aktuellen Commit. Insbesondere sind die 18
Leserfenster der Messinventur keine 18 SQL-Aufrufe pro Öffnen. Der normale
Benutzerpfad liest Sitzung, Konto, Seat und Workspace weiterhin getrennt; dessen
Bündelung und aktuelle Laufzeitmessung bleiben erforderlich. Finale
Berechtigungs-/Expiry-/Identitätsprüfungen und echte Widerrufsfälle müssen dabei
bestehen bleiben.

Auch gemeinsame Linkverträge, gezielte Zielabhängigkeiten, normale gemeinsame
Schreibmechanik und endgültige Leistungsbudgets sind offen. Der existierende
Dokument-Cache spart erneutes Parsen, der Quellenleser lädt aber weiterhin alle
gewählten nativen Bytes und prüft sie erneut. Der spätere inkrementelle Lesepfad
muss weiterhin Zustandskorruption ohne Sequenzänderung, globale Scopefehler,
physische Außenänderungen sowie echte Neuaufbau-Parität erkennen. Lesedaten dürfen
keine Mutation autorisieren. Danach bleiben finaler Build/UI/test:all, CI/Reviews,
ein tatsächlicher Backup-/Restore-Nachweis, Original-Recovery und kontrolliertes
Release mit Prüfung aller fünf Workspaces erforderlich.
