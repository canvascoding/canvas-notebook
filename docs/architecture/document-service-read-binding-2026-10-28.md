# Dokumentservice: frische Bindungsfakten gemeinsam lesen

Stand: 28.10.2026. Vergleich mit `8f447da007fa4b6423dcf248d1f7410843205af7`.
Der [maschinenlesbare Bericht](document-service-read-binding-2026-10-28.json)
bindet Produkt-/Testquellen und tatsächliche Ausgaben über SHA-256.
Dies gehört zu Paket 2 des [zentralen Serviceplans](../document-write-database-performance-plan.md).

## Änderung

Die private Bindungsprüfung liest tatsächlichen Realm, Auflösung ihrer sechs
Tabellen und rohe Workspace-Felder gemeinsam auf derselben gehaltenen Verbindung.
Jede ihrer bestehenden Prüfstellen fragt frisch ab. Die initiale Realm-Bindung,
Prüfungen vor/nach dem ACCESS-SHARE-Lock sowie vor/nach dem Lesen und vor Ausgabe
bleiben erhalten. Die Suche verwendet dieselbe Mechanik an ihren eigenen Grenzen.

Der reine Realm-Parser und dessen SQL bleiben exakt erhalten. Workspace-Felder
bleiben rohe Driver-Skalare mit denselben 16-KiB-Bytegrenzen; nur die sechs festen
Relationsnamen und deren Auflösungs-Bools stehen in JSONB. Realm, OID, Backend,
Transaktion, Suchpfad und aktiver Scope werden weiterhin verglichen. Ein fehlendes
gebundenes Schema/eine fehlende Tabelle bleibt ein Scope-Fehler; SQL wird auf der
abgebrochenen Transaktion nicht erneut ausgeführt. Andere Fehler folgen der
bisherigen Normalisierung. Es gibt weder Rechte-/Zeilencache noch neue DB-API,
zusätzliche Wiederholung, längere Phase oder geänderten Sperrmodus.

Zwei bestehende Funktionen ändern sich; zwei private Leser-/Parserfunktionen kommen
hinzu. Alle 21 anderen vorhandenen Funktionen einschließlich Dokument-Witness,
Versionen, Cursor, Ausgabe, Principal-Fabriken, Suchabschluss, COMMIT/Rollback und
Disposal bleiben bytegleich.

## Echte Prüfungen

Drei Kontrollen des unveränderten Ausgangsstands lesen pro tatsächlichem Aufruf
siebenmal Realm, sechsmal Relationen und sechsmal Workspace. Sechs aktuelle
Kontrollen über HTTP, registriertes Agent-Werkzeug und echtes MCP tools/call
verwenden einmal die Initialbindung und sechsmal die gemeinsame Beobachtung.

Zwölf reale Änderungen nach der fünften Bindungsantwort werden von der letzten
Prüfung erkannt: Workspace-Pfad, Suchpfad, temporäre Schattenrelation und überlange
Workspace-Felder, jeweils bei allen drei Adaptern. Drei weitere Fälle tauschen nach
dem Tabellen-Lock das tatsächliche Schema aus; die folgende kombinierte SQL-Lesung
scheitert und bleibt ein Scope-Fehler. Sämtliche Fälle verweigern die Ausgabe.
Beim Agenten wird die tatsächliche öffentliche Ausnahme seines bestehenden
Invocation-Wrappers geprüft; ein beliebiger Assertion-/Protokollfehler zählt nicht
als Ablehnung. Driver-Antworten werden nicht ersetzt.

Jeder Aufruf verwendet genau eine tatsächliche Transaktion ohne Replay. Rollback
erhält ursprüngliche Dokument-/Lineage-IDs, native Bytes, Metadaten und Projektionen
sowie sämtliche Workspace-Felder/xmin und den ursprünglichen Schema-OID. Nach jeder
Fehlerfamilie kann der Adapter erneut erfolgreich lesen. Alle zehn finalen PG-Suiten
bestehen: neuer Bindungstest, öffentlicher Leseservice, registrierter Read-Dispatch,
nativer Leser, Suchservice, Raum-Suche, Such-Dispatch, MCP-Read-Principal, Member-
Current und 132 MCP-Snapshot-Fälle. Release-TypeScript, gesondertes TypeScript mit
52 Wurzeln/5177 Quellen/keinen Diagnosen sowie ESLint bestehen.

## Vergleich ohne zusätzliche Diagnoseinstrumentierung

Zwölf separate Fixtures vergleichen Ausgangs-/aktuellen Produktstand für HTTP,
Agent und MCP mit jeweils 10 und 200 regulär angelegten nativen Dokumenten. Nur
die Produktdatei des Leseservices wird kontrolliert gewechselt und danach exakt
wiederhergestellt. Alle anderen gebundenen Quellen bleiben identisch. Je Fixture
werden erster Einstieg und zwei warme Lesevorgänge gemessen.

| Adapter | Erster Einstieg: SQL vorher → jetzt / Ausleihen | Warm, beide Fenster: SQL vorher → jetzt / Ausleihen |
| --- | ---: | ---: |
| HTTP | 91 → 79 / 12 | 88 → 76 / 9 |
| AGENT | 233 → 221 / 37 | 128 → 116 / 3 |
| MCP | 123 → 111 / 32 | 102 → 90 / 19 |

Die Werte gelten bei 10 und 200 Dokumenten identisch. Alle 18 Vergleichsfenster
sparen jeweils zwölf SQL-Anweisungen; die Zahl der Ausleihen bleibt gleich.
Der Agent-Ersteinstieg enthält zusätzlich sämtliche Abfragen seiner tatsächlichen
Registry-Initialisierung, auch außerhalb der verschachtelten Dokumentoperation.
Diese werden im vollständigen Prozessfenster mitgezählt. SQL-Zähler summieren sich
aus innerhalb und außerhalb der Operation beobachteten Anweisungen.

Alle Antworten enthalten den vollständigen kanonischen Markdown-Inhalt mit stabilen
Original-IDs innerhalb ihrer Fixture. Bestehende native/Metadaten-/Projektionszeilen
und xmin bleiben unverändert. Es verbleiben keine offenen Abfragen/Verbindungen,
fehlgeschlagenen Anweisungen oder unbekannten Queryformen. Jede Fixture schließt
und entfernt ihre eigenen Ressourcen vollständig; externe Fetches bleiben null.
Lokale Zeiten stehen im JSON, ersetzen aber keine kontrollierte Latenz- oder
Parallelitätsabnahme und keine Browser-/TCP-/Live-Agent-/Produktions-OAuth-Prüfung.

Die Abfragebudgets des Gesamtplans sind weiterhin nicht erreicht. Weitere Bündelung,
inkrementelle Linkabhängigkeiten, gemeinsame Schreibwege und die abschließenden
Build-/Desktop-/Mobil-/test:all-/CI-/Review-Prüfungen stehen aus. Backup mit echtem
Restore, Original-Recovery und Release/Deployment bleiben erforderlich. Review
Center und Undo werden nicht weiterentwickelt. Produktion bleibt unverändert.
