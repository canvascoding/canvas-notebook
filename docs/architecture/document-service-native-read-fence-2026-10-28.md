# Dokumentservice: nativen Realm und gehaltene Sperre gemeinsam beobachten

Stand: 28.10.2026. Vergleich mit `6dd003bcaa121cef0f7e302b1aa5a838b46c88f0`.
Der [maschinenlesbare Bericht](document-service-native-read-fence-2026-10-28.json)
bindet Produkt-/Testquellen und echte Ausgaben über SHA-256. Dies gehört zu Paket 2
des [zentralen Serviceplans](../document-write-database-performance-plan.md).

## Verursacher und Änderung

Ein optionaler Beobachter am tatsächlichen SQL-Treiber ordnet alle 79/76/76
Anweisungen des bisherigen HTTP-Ersteinstiegs und der beiden warmen Aufrufe exakt
zu; Stackfehler sind null. Der native Leser verursacht jeweils 24 Anweisungen.
Diese Diagnose speichert Codeorte und Zähler, keine SQL-Parameter oder Inhalte.
Ihre Laufzeiten werden nicht als Leistungsabnahme verwendet und ihre Anteile
belegen keinen Anteil am gesamten Produktionsverkehr.

Der native Leser beobachtet tatsächlichen Realm, Auflösung seiner acht Tabellen
und gehaltene Shared-Advisory-Lock-Modi gemeinsam auf derselben Verbindung.
Beide ursprünglichen Grenzen des Header-Lesers und alle drei des Body-Lesers
bleiben bestehen. Eine fremde Verbindung, ein anderer Transaktionsbeleg, geänderter
Suchpfad oder andere Relationsauflösung können die Beobachtung nicht erfüllen.
Die Sperre muss tatsächlich granted sein und zu Datenbank, Workspace-Schlüssel,
Backend und dessen Startzeit gehören. Zusätzlicher Exclusive-Modus bleibt verboten.

Der initiale Realm-SQL-Text und reine Parser bleiben exakt erhalten. Im JSONB
stehen nur die festen Relationsnamen/Auflösungs-Bools und tatsächlichen Lock-Modi;
native Inhalte und Workspace-Felder behalten ihre bisherigen rohen Driver-Typen.
Workspace-, Header-, Admission-, Budget-, Binär-, Versions- und Ausgabeprüfungen
bleiben unverändert. Die beiden öffentlichen Reader unterscheiden sich nachweislich
nur durch die Ersetzung der jeweils unmittelbar benachbarten Prüfpaare. Zwei private
Validatoren werden durch eine gemeinsame Beobachtung ersetzt. Es entstehen keine
Rechte-/Daten-Caches, öffentlichen Skip-Optionen oder neuen DB-APIs; Transaktionen,
Sperrmodi, Lebensdauer, COMMIT/Disposal und Fehlerbehandlung bleiben erhalten.

## Echte Prüfungen

Drei Ausgangskontrollen über HTTP, registrierten Agent und tatsächliches MCP
lesen für den nativen Body viermal Realm, dreimal Relationsauflösung und dreimal
Lock-Modi. Aktuelle Kontrollen verwenden einmal die Initialbindung und drei frische
gemeinsame Beobachtungen. Sechs erfolgreiche Kontrollen und 24 reale Fehlerfälle
bestehen. Neun neue Fälle ändern nach der zweiten nativen Beobachtung den Suchpfad,
erzeugen eine temporäre Schattenrelation oder erwerben tatsächlich zusätzlich den
exklusiven Lock auf demselben Backend. Die letzte native Beobachtung verweigert
die Ausgabe; Rollback erhält Original-IDs, native Bytes, Metadaten/Projektionen
und Workspace-xmin. Ein späterer frischer Aufruf liest erfolgreich.

Zehn aktuelle Lese-/Such-/Rechte-PG-Suiten und drei Edit-PG-Suiten bestehen. Letztere
verwenden echte Principals, registrierte Werkzeuge, einen wirklichen Raum-Owner
und akzeptierte WebSocket-Änderungen. Sie prüfen native Versionsbelege, Konflikte,
Block-/Tabellenaktionen, reine Statuslesung und ursprüngliche Operationen bei Retry.
Driver-Antworten oder Berechtigungen werden nicht durch positive Fakes ersetzt.

Der zusätzliche Owner-Test hatte bereits am unveränderten Ausgangsstand eine
veraltete ACK-Verlust-Injektion: Er erwartete die SID an Parameter 1 des früheren
Sitzungs-SELECTs. Die gemeinsame Member-Beobachtung verwendet Parameter 3. Nur
Kommentar/Abfrageselektor und zusätzliche Prüfungen der wirklichen Antwortzeile
werden angepasst. Alle ursprünglichen Unconfirmed-/Operation-ID-/After-/Retry-
und Einzelanwendungs-Assertions bleiben bytegleich. Mit dem korrigierten Hook
bestehen am Ausgangsstand alle zehn Owner-Gruppen und anschließend die aktuelle
Edit-Suite. Die Probe wirft erst nach einem tatsächlichen erfolgreichen SQL-Ergebnis.
GitNexus meldet für die exportierte Testfunktion ein partielles kritisches Risiko;
dies wurde vor der Änderung gemeldet und der kleine tatsächliche Diff separat geprüft.

Release-TypeScript, gesondertes TypeScript mit 55 Wurzeln/5184 Quellen/keinen
Diagnosen, ESLint und die Quellvergleiche bestehen. Es werden keine Prüfungen
ausgeschaltet oder neue Skip-Filter eingeführt.

## Vergleich ohne zusätzliche Diagnoseinstrumentierung

Zwölf nacheinander ausgeführte Fixtures vergleichen Ausgangs-/aktuellen Stand
für HTTP, Agent und MCP mit jeweils 10 und 200 regulär angelegten nativen Dokumenten.
Nur die Produktdatei des nativen Lesers wird kontrolliert gewechselt und danach
exakt wiederhergestellt. Jede Fixture misst Einstieg und zwei warme Lesevorgänge.

| Adapter | Einstieg: SQL vorher → jetzt / Ausleihen | Warm, beide Fenster: SQL vorher → jetzt / Ausleihen |
| --- | ---: | ---: |
| HTTP | 79 → 73 / 12 | 76 → 70 / 9 |
| AGENT | 221 → 215 / 37 | 116 → 110 / 3 |
| MCP | 111 → 105 / 32 | 90 → 84 / 19 |

Die Werte sind bei 10 und 200 Dokumenten identisch. Alle 18 Vergleichsfenster
sparen sechs weitere SQL-Aufrufe; Ausleihen bleiben unverändert. Sämtliche Agent-
Registry-Abfragen werden im vollständigen Prozessfenster mitgezählt. Jede Antwort
enthält den vollständigen kanonischen Markdown-Inhalt mit den Original-IDs ihrer
Fixture; vorhandene Zeilen/xmin und Bytes bleiben unverändert. Sämtliche eigenen
Schemas, Daten, Verbindungen und Abfragen schließen vollständig, externe Fetches
bleiben null. Die lokalen Zeiten im JSON beweisen keine kontrollierte Latenz- oder
Parallelitätsabnahme und ersetzen keine Browser-/TCP-/Live-Agent-/Produktions-OAuth-
Prüfung.

Der Gesamtplan bleibt offen: weitere Bündelung, inkrementelle Linkabhängigkeiten,
gemeinsame normale Schreibwege und endgültige Budgets sowie finale Build-/Desktop-/
Mobil-/test:all-/CI-/Review-Abnahme. Backup mit tatsächlichem Restore, ursprüngliche
Dokument-Recovery und Release/Deployment stehen aus. Review Center und Undo werden
nicht weiterentwickelt. Produktion bleibt unverändert.
