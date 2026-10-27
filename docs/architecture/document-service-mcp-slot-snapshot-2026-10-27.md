# Dokumentservice: aktuelle MCP-Fakten und SQL-Planwiederverwendung

Stand: 27.10.2026. Vergleich mit `bcf4b38b4d6090eab7ce816c6d13cc9e860382d1`.
Der [maschinenlesbare Bericht](document-service-mcp-slot-snapshot-2026-10-27.json)
bindet tatsächliche Produkt-/Testquellen, Vergleiche und Ausgaben per SHA-256.
Dies ist ein weiterer Schritt des [Serviceplans](../document-write-database-performance-plan.md),
keine Abnahme von Paket 2 oder des Gesamtplans.

## Gemeinsame MCP-Prüfung

Eine aktuelle Prüfung eines festen MCP-Workspace-Slots braucht drei statt sechs
SQL-Treiberaufrufe. Die bisherige Schema-/Kontextprüfung vor dem asynchronen Laden
der Einstellungen bleibt erhalten. Zwei vollständige frische Beobachtungen lesen
danach Konto, Sitzung, OAuth-Client, aktuellen Consent, Token-/Grant-Widerruf,
Workspace-Freigabe, Seat, Workspace-Rechte und tatsächlichen Verbindungskontext.
Die vorhandenen reinen Grant-, Seat- und Workspace-Entscheidungen werden verwendet.
Ein anfänglicher/finaler Ursprung muss weiterhin übereinstimmen. Copy behält
seine stärkere Zielprüfung sowie die bisherige umgekehrte Abschlussreihenfolge.

Die vorhandene `SqlConnection.getPrepared`-Mechanik verwendet den SQL-Plan erneut.
Jeder Aufruf führt den tatsächlichen SELECT erneut auf derselben gehaltenen
Verbindung aus. Es gibt keinen Berechtigungs-/Datencache, keine zusätzliche
Verbindung und keine neue Autorität. Adapter ohne diese Methode lesen weiterhin
frisch mit `get`. Fünf Sekunden Phasenlebensdauer und 50 ms Sperrwartezeit bleiben.

Ein fester JSONB-Rückgabetyp verhindert den PostgreSQL-Fehler eines wechselnden
Ergebnistyps bei tatsächlichen Spaltentypänderungen. Kritische NUMERIC-Werte bleiben
exakte Zeichenketten; sie dürfen bei der JSON-Dekodierung weder auf `1` runden noch
zu einer Berechtigung werden. Nicht unterstützte skalare Typen werden als
Schemafehler abgewiesen. Die vorhandene rohe Stringbegrenzung bleibt erhalten,
bevor ein gemeinsamer Grant-Datensatz den Prozess erreicht. Datenrelationen sind
fest an das ursprüngliche Schema gebunden; der echte Suchpfad wird weiter geprüft.

Die ursprünglichen eigenständigen Schema- und Grant-SQL-Strings sind zur Laufzeit
bytegleich. Die gemeinsame Grant-Abfrage erhält lediglich feste Parameterordinale.
39 andere bestehende Funktionen des MCP-Principals sowie 13 andere Funktionen des
Token-Verifiers bleiben bytegleich; Datenbank-API und Entscheidungsfunktionen ändern
sich nicht.

## Tatsächliche Nachweise

132 neue Fälle laufen mit echter serverseitiger Planwiederverwendung und mit dem
normalen Fallback-Leser, jeweils für Lesen, Anlegen und Bearbeiten. Echte Änderungen zwischen
Antworten prüfen Konto-/Sitzungs-/Client-/Consent-/Token-/Grant-/Seat-/Workspace-
Widerruf, Rechteverlust, Suchpfad, überschattete/fehlende Tabellen, exakte NUMERIC-
Werte und nicht unterstützte Typen. Die Bearbeitung prüft auch ihre aktive
Sitzungsbindung. Reiner Schreibverlust lässt Lesen weiter zu.
Die geprüften Autoritäts-/Native-Zeilen einschließlich xmin und die tatsächlichen
Spaltentypen bleiben nach Kontrolle beziehungsweise Rollback gleich. Positive
SQL-Antworten werden nicht ersetzt.

Zusätzlich bestehen 20 Read-, acht Create-, neun Copy-, zwölf Path-Principal-,
15 native Create- und zehn native Copy-Owner-Testfamilien. Alle eigenen Ressourcen
schließen vollständig. Für native Workspace-Erstellung verwendet der lokale
macOS-Test den physischen TMPDIR-Pfad; der unveränderte Sicherheitsleser lehnt den
`/var`-Symlink ab. Kein Produkt- oder Fixture-Sicherheitscheck wurde abgeschwächt.
Die tatsächliche PostgreSQL-Sicht zeigt fünf Custom- und fünf Generic-Pläne nach
wiederholten frischen Abfragen. Im vollständigen MCP-Lauf sind alle 1260 erfassten
Snapshot-Abfragen benannt vorbereitet, keine ist unbenannt.

Release-TypeScript, gesonderte Test-TypeScript-Prüfung mit 41 Wurzeln und 5162
Quellen sowie ESLint ohne Warnungen bestehen. Build, Browser-UI und reguläres
`test:all` bleiben finale Prüfungen für den vollständigen Service.

## Vergleiche

Alle vier Fixtures bestehen: alter MCP-Stand mit zehn Quellen, neuer MCP-Stand mit
zehn/200 Quellen und neuer Agent-Stand mit zehn Quellen. Vorhandene Quellen entstehen
über reguläre authentifizierte Uploads und abgeschlossene Projektion. Jeder neue
Vorgang erzeugt genau ein natives Dokument mit vollständigem Inhalt; ursprüngliche
Registry-/Lineage-/Native-/Metadatenzeilen/xmin und physische Bytes bleiben erhalten.
Die ursprüngliche Wiederholung behält Dokument-/Lineage-/Operationsidentität.

Die Zellen nennen SQL-Treiberaufrufe / Pool-Ausleihen inklusive Transaktionssteuerung.

| MCP-Fenster | Vorher, zehn Quellen | Jetzt, zehn und 200 Quellen |
| --- | ---: | ---: |
| Erster Einstieg und Neuanlage | 2618 / 50 | 1997 / 50 |
| Warme Neuanlage, beide Wiederholungen | 2597 / 37 | 1976 / 37 |
| Ursprüngliche Wiederholung | 129 / 12 | 102 / 12 |

Der zehn-Quellen-Vergleich liegt lokal warm vorher bei 2,60–2,66 s, jetzt bei
2,36–2,39 s; die gemessene Datenbankzeit sinkt von 1,51–1,56 s auf 1,23–1,26 s.
Bei 200 Quellen liegen die zwei neuen warmen Läufe bei 2,36 und 2,65 s. Das sind
begrenzte lokale Messungen, keine allgemeine Latenzabnahme oder eine kontrollierte
Netzwerklatenzprüfung. Der Agent-Vergleich behält 2180 / 46 warm und 180 / 7 beim
Retry. Alle Messfenster enden ohne offene Abfragen/Verbindungen und ohne
fehlgeschlagene oder nicht unterstützte Abfrageformen; externe Fetches bleiben null.

Ein anfänglicher unvorbereiteter Drei-Abfragen-Kandidat wurde trotz gleicher
1976 Aufrufe verworfen: Er dauerte ungefähr 3,5 s. Tatsächliches EXPLAIN ANALYZE
mit Buffers zeigte überwiegend Planungsaufwand von ungefähr 1,6–1,8 ms gegenüber
0,3–0,5 ms Ausführung je gebündelter Abfrage. Die vorhandene Planwiederverwendung
behebt diesen gemessenen Nachteil; bloß weniger Aufrufe wären keine Abnahme gewesen.

## Verbleibende Arbeit

Die Gegenprüfung reproduziert im unveröffentlichten Member- und Agent-Create-
Workspace-Leser eine abweichende Bewertung von echten NUMERIC- und JSON-Werten.
Die präzise Konvertierung muss vor Merge/Release gemeinsam wiederverwendet und
dort korrigiert werden. Diese Nachweise bedeuten keine Freigabe der übrigen
Snapshot-Leser. Weitere Phasen-/Verbindungs- und Registry-/Zustandsbündelung bleiben
erforderlich; 1976 beziehungsweise 2180 Aufrufe erfüllen die vorgesehenen Create-
Budgets noch nicht. Inkrementelle Links, normale gemeinsame Schreibwege, finale
Vergleiche/Build/UI/Suite/CI/Reviews, Backup/Restore, Original-Recovery und
kontrolliertes Release bleiben offen. Review Center und Undo werden nicht
weiterentwickelt; Produktionsdaten und veröffentlichtes Release bleiben unverändert.
