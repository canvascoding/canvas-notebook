# Bewertung der gebündelten Principal-Zeilensperren

Basis: `5616e93037d7aae605d71c35bb4c674a6d4c5625`.
Die untersuchte Produktvariante wird nicht übernommen. Die Laufzeitdateien sind
vollständig und bytegleich auf die Basis zurückgestellt.

Die Variante bündelte Mitgliedschaften, Berechtigungen, Konten, Workspace und
Projekt in einer gemeinsamen PostgreSQL-Abfrage mit echten Zeilensperren.
Ein vorgeschalteter Datenleser war notwendig, um bei gleichzeitig ungültigen
Kontodaten und einer belegten späteren Zeilensperre die bisherige Fehlerreihenfolge
zu erhalten. Andere Schlüsseltypen behielten die ursprünglichen Selektoren.

Alle 44 gezielten PostgreSQL-Suiten bestanden; sechs frische Vorher-/Nachher-
Fixtures schlossen 22 Messfenster. Native Identitäten, Originalbelege, Zeilen/xmin
und physische Inhalte blieben unverändert. Die tatsächlichen Treiber- und
Callsite-Zähler stimmen überein. Keine Abfragen oder Verbindungen bleiben offen.

| Warmer einzelner Vorgang | Basis SQL / Ausleihen | Variante SQL / Ausleihen | Lokale Laufzeit Basis → Variante |
| --- | ---: | ---: | --- |
| Agent-Neuanlage, zwei Fenster | 1058 / 34 | 1026 / 34 | 1911/1906 → 2005/2041 ms |
| MCP-Neuanlage, Kontrollpfad | 702 / 29 | 702 / 29 | 1513/1484 → 1500/1538 ms |
| HTTP-Dokumentlesen, zwei Fenster | 69 / 9 | 65 / 9 | 86/86 → 88/90 ms |

Diese wenigen lokalen Laufzeiten sind Diagnosewerte. Sie belegen keinen Gewinn;
die kleine SQL-Ersparnis rechtfertigt die zusätzliche Abfrage-, Dekodierungs- und
Kompatibilitätslogik nicht. Die Variante wird deshalb verworfen. Die bisherigen
abgenommenen Messwerte und offenen Budgets ändern sich dadurch nicht. Der
vollständige Größen-/Latenzvergleich und die übrigen Servicepakete bleiben offen.

Vier neue echte PostgreSQL-Regressionen bleiben erhalten: für Lesen und Schreiben
jeweils ein ungültiger Kontowert mit einer früheren Mitgliedschaftssperre sowie
mit einer späteren Workspace-Sperre. Die bisherige Priorität bleibt BUSY bzw.
SCOPE_CHANGED. Die bisherigen 16 Gruppen einschließlich 468 tatsächlicher
Peer-Zeilensperren, sechs erlaubter unabhängiger Zeilensperren sowie exakter
NUMERIC-/Domain-Verträglichkeit bleiben erhalten. Kein positiver SQL- oder
IO-Rückgabewert wird ersetzt.

Ein abschließender lesender Audit bestätigt die Abwesenheit von 54 einzeln
protokollierten Testschemas, Backends und Datenverzeichnissen einschließlich
verworfener Versuche. Für neun ältere Fixture-Familien ergänzen tatsächliche
Cleanup-Aussagen und die Abwesenheit ihrer Schema-/Backend-/Temp-Datenfamilien
die teilweise fehlenden individuellen Besitzberichte. Das eigene Basisarchiv
ist anhand seiner ursprünglichen Verzeichnisidentität geprüft und entfernt.

Der nächste strukturelle Schwerpunkt sind die wiederholten Kontextaufbauten und
Verbindungsausleihen beim normalen Dokumentöffnen. Rechteentzug, ursprüngliche
Wiederaufnahme und tatsächliche IO-Grenzen bleiben Teil des Vertrags. Review
Center und Undo erhalten keine neue Funktionalität.
