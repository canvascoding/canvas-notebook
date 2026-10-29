# Dokumentservice: doppelte Publikationsprüfungen bündeln

Stand: 27.10.2026. Vergleich mit `ed0ffb21155fc46f89dd419bf3c0fd6dea7ac98b`.
Der [maschinenlesbare Bericht](document-service-publication-boundaries-2026-10-27.json)
bindet Produktquellen, Testquellen und tatsächliche Ausgaben über SHA-256.
Dies ist ein weiterer Schritt des [zentralen Serviceplans](../document-write-database-performance-plan.md).

## Verursacher der Aufrufe

Die Diagnose hängt am tatsächlichen PostgreSQL-Treiber innerhalb der bestehenden
Operationsmessung. Quellkarten und AST-Funktionsbereiche ordnen die Aufrufe ihren
Aufrufern zu. Alle vier Fenster stimmen exakt mit der unabhängigen vorhandenen
Messung überein; Stackfehler sind null. Es werden nur Codeorte und Zähler gespeichert,
keine SQL-Texte, Parameter, Dokumentpfade oder Nutzerkennungen. Das opt-in Skript
wird nicht vom Produkt geladen; seine Laufzeiten sind keine Leistungsabnahme.

| Codepfad bei warmer MCP-Anlage | Vorher | Jetzt |
| --- | ---: | ---: |
| Aktuelle MCP-Berechtigungsfakten | 382 | 244 |
| Lifecycle-Owner und gehaltene Verbindung/Sperre | 313 | 240 |
| Dokument-/Native-/Wiederaufnahme-Leser | 249 | 237 |
| MCP-Schema-Prüfer | 224 | 155 |

Die vier Pfade verursachen aktuell 876 von 1556 Aufrufen (56 %). Weitere Herkunfts-,
Realm- und Publikationsprüfungen kommen hinzu. Der dominante Befund sind wiederholte
Prüfketten in verschachtelten Schichten. Die Diagnosegruppe `catalogue` umfasst
SQL mit PostgreSQL-Systemkatalogen, Schema- oder Transaktionsidentität und kann
auch aktuelle Rechtefakten enthalten; sie bezeichnet nicht den Markdown-Linkindex.
Dies weist keine Anteile am gesamten Produktivverkehr nach. Review Center und Undo
sind keine Hauptverursacher dieses gemessenen Create-Ablaufs.

## Änderung und echte Grenze

Die festen Agenten-/MCP-Speicherprüfer verwenden eine gemeinsame private Mechanik.
In der vorhandenen nativen Publikationsphase führt deren vollständige Prüfung
bereits die aktuellen Rechte-, Owner-, Quellen-, Claim- und nativen Versionsprüfungen
aus. Unmittelbar benachbarte Aufrufe desselben vollständigen Validators werden
entfernt. Der Coordinator übernimmt für MCP dieselbe bereits bestehende Behandlung
wie für Agenten: Die vollständige Prüfung bleibt am tatsächlichen Speicher-ACK;
der anschließende Callback prüft weiterhin offene Originaloperationen und den Owner.

Der MCP-Herkunftsvalidator ruft selbst echtes Current auf. Sein benachbarter zweiter
Current-Aufruf entfällt. Agenten behalten ihre tatsächlichen Prüfungen vor/nach der
Profil-/Konfigurationsbeobachtung; Request-Pfade behalten ihr explizites Current.
Andere Phasen bleiben frisch. Kein neuer öffentlicher Skip-Schalter, keine
zwischengespeicherten Rechte oder Zeilen und keine Änderung der fünf Sekunden
Lebensdauer, der 50-ms-Sperrwartezeit oder der Sperrmodi werden eingeführt.
Vier bestehende Funktionen ändern sich; ein privater Helfer kommt hinzu.
107 weitere bestehende Persistenzfunktionen bleiben bytegleich.

## Prüfungen

Der neue Test verwendet echte registrierte MCP- und Agentenwerkzeuge sowie den
wirklichen Python-Speicherhelfer. Im bisherigen MCP-Pfad beobachtet der positive
Kontrolllauf zwei vollständige native Belege am selben `before_link`-ACK. Der neue
Stand behält genau einen vollständigen Beleg; insgesamt werden vier echte
Publikationsbestätigungen für beide Akteure geprüft.

Zwei Rennen ändern nach der Staging-Bestätigung die tatsächliche native Sequenz
auf derselben gehaltenen Verbindung. Die nächste erhaltene Prüfung verweigert die
Publikation. Rollback erhält Original-ID, Lineage, Yjs-Bytes, Vektor, Generation und
Sequenz; eine explizite Wiederholung desselben Schlüssels veröffentlicht mit denselben
IDs und vollständigem Unicode-Inhalt. Positive SQL-/Helferantworten werden nicht ersetzt.

Alle zehn bisherigen PostgreSQL-Suiten bestehen: MCP-/Agenten-Speicherphase,
Agenten-COMMIT-Antwortverlust, native MCP-Anlage, manuelle Anlage, Upload,
freie manuelle Quellenabwehr, MCP-Create-Principal, native MCP-Copy-Owner und
132 MCP-Snapshot-Fälle. Die Fixtures schließen ihre eigenen Ressourcen.
Release-TypeScript, gesondertes TypeScript mit 44 Wurzeln/5166 Quellen/keinen
Diagnosen und ESLint ohne Warnungen bestehen.

## Vergleich ohne Diagnoseinstrumentierung

Vier Fixtures laufen nacheinander, jeweils mit zehn regulär angelegten Quellen:
bisheriger/neuer MCP-Pfad sowie bisheriger/neuer Agentenpfad. Nur die eine betroffene
Produktdatei wird auf den Baseline-Stand gesetzt und anschließend bytegenau
wiederhergestellt. Quellen bleiben innerhalb jedes Laufs über Hashes fest gebunden.
Bestehende Registry-/Lineage-/Native-/Metadatenzeilen und xmin sowie physische Bytes
bleiben erhalten. Neue Anlagen und ursprüngliche Wiederholungen prüfen vollständigen
nativen/physischen Inhalt sowie stabile Operations-, Dokument- und Lineage-Identität.

| Fenster | Vorher: SQL / Ausleihen | Jetzt: SQL / Ausleihen |
| --- | ---: | ---: |
| MCP – Erster Einstieg und Anlage | 1892 / 46 | 1577 / 46 |
| MCP – Warme Anlage, beide Fenster | 1871 / 33 | 1556 / 33 |
| MCP – Ursprüngliche Wiederholung | 102 / 12 | 102 / 12 |
| AGENT – Erster Einstieg und Anlage | 2285 / 80 | 2248 / 80 |
| AGENT – Warme Anlage, beide Fenster | 2180 / 46 | 2143 / 46 |
| AGENT – Ursprüngliche Wiederholung | 180 / 7 | 180 / 7 |

MCP warm: lokal 2.32 / 2.31 s vorher und 2.04 / 2.04 s jetzt. AGENT warm: lokal 2.72 / 2.50 s vorher und 2.64 / 2.49 s jetzt. Alle Fenster enden ohne offene Abfragen/Verbindungen, fehlgeschlagene Anweisungen
oder unbekannte Queryformen; externe Fetches bleiben null. Dies sind begrenzte lokale
Werte, keine kontrollierte Netzwerklatenzabnahme. Frühere 200-Quellen-Berichte behalten
ihre eigene Quellenbindung.

Die Zielbudgets bleiben unerreicht. Weitere Current-/Owner-/Zustandsbündelung,
gemeinsame Linkverträge, inkrementelle Zielabhängigkeiten und normale gemeinsame
Schreibwege bleiben erforderlich. Finale Build-/Desktop-/Mobil-/`test:all`-/CI-/Review-
Prüfungen, Backup mit tatsächlichem Restore-Nachweis, ursprüngliche Dokument-Recovery
und Release/Deployment stehen weiterhin aus. Review Center und Undo werden nicht
weiterentwickelt. Produktionsdaten und veröffentlichtes Release bleiben unverändert.
