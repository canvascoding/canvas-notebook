# Dokumentservice: Owner-Fakten gemeinsam lesen

Stand: 27.10.2026. Vergleich mit `2fb7fe10366a05f8c73ebc85f190c002ff9712d1`.
Der [maschinenlesbare Bericht](document-service-owner-facts-2026-10-27.json)
bindet tatsächliche Quellen und Ausgaben über SHA-256. Dieser Schritt gehört zum
[zentralen Serviceplan](../document-write-database-performance-plan.md).

Die bestehende private Owner-Beobachtung bietet zusätzlich eine feste Lesung von
Verbindung, exklusiver Sperre und rohen Workspace-/Realm-Fakten in derselben echten
SQL-Anweisung. Beide öffentlichen Datenleser verwenden dieselbe private Capture-,
Lease-, Verifier- und Kontextprüfung vor/nach dem Lesen sowie dasselbe Pending-
Tracking. Sie liefern Fakten und keine Berechtigung oder Schreibfähigkeit. Ein
öffentliches Lease-Objekt oder kopierte Verbindungen können keinen Owner auswählen.
Der bisherige Standardleser behält seinen SQL-Text und seine Fakten unverändert.

Der Original-Workspace-Prüfer validiert den tatsächlichen Owner und dessen Workspace
mit der gemeinsamen Beobachtung; vier unmittelbar davor liegende Owner-Aufrufe
entfallen. Seine vorhandenen Scope-Felder bleiben streng verglichen, zusätzlich
muss die gelesene Workspace-ID übereinstimmen. Bei SQL-Schema-/Lookup-Fehlern prüft
er den tatsächlichen Owner frisch, damit der bisherige Owner-Fehler Vorrang behält.
Dabei werden keine Schreibbefehle oder Transaktionen wiederholt.

Die feste MCP-Quelle prüft den tatsächlichen Owner bereits nach der Realm-Lesung.
Nur dort entfällt dessen benachbarte frühere Prüfung. Agentenquellen prüfen Aufruf
und Bytes; ihre separate Owner-Prüfung bleibt bestehen. Auch Request-Pfade und
quellenfreie Projektionsprüfungen behalten ihren Owner. Es gibt keine gespeicherten
Rechte, Daten oder längere Lebensdauer; Sperrmodi, fünf Sekunden Phasenfrist und
50-ms-Sperrwartezeit bleiben unverändert. Die native Beobachtung bleibt bytegleich.

## Echte Prüfungen

Zwei Ausgangskontrollen messen vier Owner-/Scope-Lesungen beim MCP und drei beim
Agenten an der Publikationsbestätigung. Nach der Änderung verwenden zwölf echte
Bestätigungen je drei Owner-Lesungen, weiterhin drei native/Katalog-Lesungen und
einen vollständigen nativen Beleg. Sechs echte native Fehler, zwei tatsächliche
exklusive Owner-Unlocks und zwei wirkliche Owner-Schemawechsel nach Staging
verhindern die Publikation. Nach Rollback und expliziter Wiederholung bleiben
Original-ID, Lineage, native Bytes/Vektor, Generation, Sequenz, Fehlerflags und
vollständiger physischer Unicode-Inhalt erhalten. Driver-Antworten werden nicht ersetzt.

Der neue Workspace-Leser besteht elf PostgreSQL-Fälle: frische tatsächliche
Same-Owner-Workspace-Änderungen mit Rollback und unveränderten xmin, fremde echte
Verbindungen, kopierte Fassaden, gefälschte Leases, Verifier-Wechsel vor/während
Antwort, Schemawechsel, Unlock, Shared-Lock-Ersatz, geschlossene Kontexte und
entkoppelte ausstehende Antworten. Die zehn bisherigen reinen Owner-Fälle und
die private Source-Owner-Suite bestehen ebenfalls.

Alle achtzehn aktuellen PostgreSQL-Suiten bestehen, einschließlich erster
Projektion, Originalimport, Agent-/MCP-Speicherphase, COMMIT-Antwortverlust,
Create/Upload, nativer Copy und 132 MCP-Snapshot-Fällen. Zwei zusätzliche verwaltete
PG18-Suiten bestehen: vollständiger Markdown-Import und 29 ursprüngliche Bootstrap-
Testfamilien. Release-TypeScript, gesondertes TypeScript mit 47 Wurzeln/5169 Quellen/
keinen Diagnosen sowie ESLint bestehen. Der Quellvergleich bestätigt identische
Standard-Owner-SQL-, Capture- und Pending-Prüfungen. 111 andere Import- und 13 andere
Guard-Funktionen bleiben bytegleich; der frühere Native-Test ändert nur Einrückung
mit identischem ausführbarem Code.

## Vergleich ohne Diagnoseinstrumentierung

Vier Fixtures laufen nacheinander mit je zehn regulär angelegten Quellen. Die beiden
Produktdateien werden kontrolliert auf den Ausgangsstand gesetzt und danach exakt
wiederhergestellt. Vorherige Registry-/Lineage-/Native-/Metadatenzeilen und xmin sowie
physische Bytes bleiben erhalten. Anlagen und ursprüngliche Wiederholungen prüfen
stabile IDs, Operationsbelege und vollständigen nativen/physischen Inhalt.

| Fenster | Vorher: SQL / Ausleihen | Jetzt: SQL / Ausleihen |
| --- | ---: | ---: |
| MCP – Erster Einstieg und Anlage | 1425 / 46 | 1333 / 46 |
| MCP – Warme Anlage, beide Fenster | 1404 / 33 | 1312 / 33 |
| MCP – Ursprüngliche Wiederholung | 102 / 12 | 102 / 12 |
| AGENT – Erster Einstieg und Anlage | 2096 / 80 | 2036 / 80 |
| AGENT – Warme Anlage, beide Fenster | 1991 / 46 | 1931 / 46 |
| AGENT – Ursprüngliche Wiederholung | 180 / 7 | 180 / 7 |

MCP warm: lokal 2.09 / 2.02 s vorher, 2.01 / 2.02 s jetzt. AGENT warm: lokal 2.61 / 2.58 s vorher, 2.59 / 2.49 s jetzt. Alle Fenster enden ohne offene Abfragen/Verbindungen, fehlgeschlagene Anweisungen
oder unbekannte Queryformen; externe Fetches bleiben null. Diese begrenzten lokalen
Werte ersetzen keine kontrollierte Antwortlatenz-/Parallelitätsabnahme. Frühere
200-Quellen-Berichte behalten ihre eigene Quellenbindung.

Die finalen Budgets sind nicht erreicht. Weitere Bündelung, gemeinsame Linkverträge,
inkrementelle Zielabhängigkeiten und gemeinsame Schreibwege bleiben erforderlich.
Finale Build-/UI-/`test:all`-/CI-/Review-Prüfungen, Backup mit tatsächlichem Restore,
Original-Recovery und Release/Deployment stehen weiterhin aus. Review Center und
Undo werden nicht weiterentwickelt. Produktion und veröffentlichtes Release bleiben
unverändert.
