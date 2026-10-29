# Dokumentservice: frische native Beobachtung bündeln

Stand: 27.10.2026. Vergleich mit `bb29011749a6d7fb2d4124bb4418da498f1165d9`.
Der [maschinenlesbare Bericht](document-service-native-observation-2026-10-27.json)
bindet tatsächliche Quellen und Testausgaben über SHA-256. Dies ist ein weiterer
Schritt des [zentralen Serviceplans](../document-write-database-performance-plan.md).

Die bisherige Publikationsprüfung liest den vollständigen nativen Beleg und lädt
danach Receipt, Katalog, Lineage und Zustand separat; der Zustand wird zuletzt
nochmals gelesen. Im tatsächlichen MCP-Kontrolllauf sind das sieben Dokumentdaten-
Abfragen an derselben Publikationsbestätigung.

Jetzt liefert ein gemeinsamer frischer SQL-Zugriff auf der echten gehaltenen
Verbindung die nativen Bytes, den unveränderten Registry-/Lineage-/Hash-Beleg und
die tatsächlichen Receipt-Spalten. Die beiden strengen Katalogabfragen bleiben
bestehen. Der gemeinsame Zugriff liegt danach; eine frühere RC-Zeile zertifiziert
keine später gelesene Zeile. Es werden keine Daten oder Rechte zwischengespeichert.
Bytea und skalare PostgreSQL-Felder behalten ihre tatsächlichen Treibertypen.

Die vorhandenen Receipt- und Zustandsvalidatoren werden als private reine Funktionen
wiederverwendet. Native SQL-Bedingungen, Receipt-Validierung und Zustandssubset-
Prüfung bleiben laut AST-Vergleich identisch; die Raw-Normalisierung hat identischen
ausführbaren Code. Der gemeinsame Zustandsmapper erhält nur einen Export-Alias;
alle 40 bestehenden Funktionen dieses Moduls bleiben bytegleich. Im Importmodul
ändern sich vier bestehende Funktionen, fünf private Helfer kommen hinzu und
108 weitere Funktionen bleiben bytegleich. Öffentliche Ergebnisobjekte bekommen
keine nativen Bytes oder zusätzlichen Felder.

Rechte-, Quellen-, Raum-, Claim- und Realm-Prüfungen bleiben erhalten. Lebensdauer,
Sperrmodi und Sperrwartezeit ändern sich nicht. Katalog-Identitätsfehler werden nach
dem vollständigen nativen/Receipt-Beleg weitergeworfen; echte SQL-Fehler werden
sofort weitergegeben. Es wird keine Schreibtransaktion aus einer Beobachtung abgeleitet.

## Echte Prüfungen

Acht tatsächliche Publikations-ACKs für registrierte Agenten-/MCP-Werkzeuge benötigen
je drei Dokumentdaten-Abfragen und behalten einen vollständigen nativen Beleg;
der gemessene MCP-Ausgangsstand benötigt sieben Abfragen. Sechs echte Änderungen auf derselben gehaltenen Verbindung nach Staging
prüfen je Akteur Versionssprung, degradierten Zustand und permanenten Fehler der
aktuellen Projektionsgeneration. Alle verhindern die Publikation. Rollback erhält
Original-ID, Lineage, vollständige Yjs-Bytes/Vektor, Generation, Sequenz und Fehlerflags;
explizite Wiederholung desselben Schlüssels veröffentlicht mit ursprünglicher Identität
und vollständigem Unicode-Inhalt. SQL-/Helferantworten werden nicht ersetzt.

Vierzehn aktuelle PostgreSQL-Suiten bestehen: neuer Native-Test, Publikationsgrenzen,
erste Projektion, expliziter Originalimport, Agent-/MCP-Speicherphase, Agent-COMMIT-
Antwortverlust, native MCP-Anlage, manuelle Anlage, Upload, freie manuelle Quellenabwehr,
MCP-Create-Principal, native MCP-Copy-Owner und 132 MCP-Snapshot-Fälle. Zusätzlich
bestehen der vollständige Markdown-Import und der ursprüngliche Pristine-Bootstrap
auf dem verwalteten lokalen PostgreSQL-18-System. Release-TypeScript, gesondertes
TypeScript mit 45 Wurzeln/5167 Quellen/keinen Diagnosen und ESLint bestehen.

## Vergleich ohne Diagnoseinstrumentierung

Vier Fixtures laufen nacheinander mit je zehn regulär angelegten Quellen. Die beiden
Produktdateien werden kontrolliert auf den Ausgangsstand gesetzt und danach exakt
wiederhergestellt. Vorherige Registry-/Lineage-/Native-/Metadatenzeilen und xmin sowie
physische Bytes bleiben erhalten. Neue Anlagen und Wiederholungen prüfen stabile IDs,
Operationsbelege und vollständigen nativen/physischen Inhalt.

| Fenster | Vorher: SQL / Ausleihen | Jetzt: SQL / Ausleihen |
| --- | ---: | ---: |
| MCP – Erster Einstieg und Anlage | 1577 / 46 | 1425 / 46 |
| MCP – Warme Anlage, beide Fenster | 1556 / 33 | 1404 / 33 |
| MCP – Ursprüngliche Wiederholung | 102 / 12 | 102 / 12 |
| AGENT – Erster Einstieg und Anlage | 2248 / 80 | 2096 / 80 |
| AGENT – Warme Anlage, beide Fenster | 2143 / 46 | 1991 / 46 |
| AGENT – Ursprüngliche Wiederholung | 180 / 7 | 180 / 7 |

MCP warm: lokal 2.06 / 2.10 s vorher, 2.04 / 2.04 s jetzt. AGENT warm: lokal 2.70 / 2.57 s vorher, 2.55 / 2.53 s jetzt. Alle Fenster enden ohne offene Abfragen/Verbindungen, fehlgeschlagene Anweisungen
oder unbekannte Queryformen; externe Fetches bleiben null. Diese begrenzten lokalen
Werte sind keine kontrollierte Netzwerklatenzabnahme; frühere 200-Quellen-Berichte
behalten ihre eigene Quellenbindung.

Die Zielbudgets bleiben unerreicht. Weitere Current-/Owner-/Zustandsbündelung,
gemeinsame Linkverträge, inkrementelle Zielabhängigkeiten und gemeinsame Schreibwege
bleiben erforderlich. Finale Build-/UI-/`test:all`-/CI-/Review-Prüfungen, Backup mit
tatsächlichem Restore-Nachweis, Original-Recovery und Release/Deployment stehen aus.
Review Center und Undo werden nicht weiterentwickelt. Produktionsdaten und
veröffentlichtes Release bleiben unverändert.
