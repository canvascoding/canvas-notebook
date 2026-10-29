# Dokumentservice: exakte Mitgliedschaftswerte

Stand: 29.10.2026. Die gemeinsame aktuelle Konto-/Mitgliedschaftsbeobachtung
übertrug bisher ihre Ergebnisse als JSON. PostgreSQL-NUMERIC-Werte wie
`1.00000000000000000001` kamen dadurch als JavaScript-Zahl `1` an. Die bestehende
skalare Entscheidungsfunktion bewertet die ursprüngliche Zeichenkette anders.
Das betraf den zurückgegebenen Share-Flag und die Kontoentscheidung. Die normalen
INTEGER-Kontrollen stimmen bereits vor der Änderung überein; ein ausgenutzter
Share-Zugriff ist damit nicht nachgewiesen.

## Änderung und Grenzen

Der ungesperrte Leser liefert typisierte skalare Spalten aus genau einer echten
SQL-Beobachtung auf der vom Aufrufer gehaltenen Verbindung. Eine garantierte
Ankerzeile und eigene Presence-Spalten erhalten die Unterscheidung zwischen
fehlendem Konto, fehlender Konfiguration und leeren Mitgliedschaften. Materialisierte
CTEs und skalare Unterabfragen erhalten die Konto-/Konfigurationsbeobachtung,
ohne Flag-Werte in JSON umzuwandeln. Es gibt keine eigenen Decoder oder Codecs.

Die reine Entscheidungsfunktion, `flag` und der vollständige frühere Leser sind
bytegleich erhalten. Auch die gesamte gesperrte Verzweigung bleibt bytegleich:
Konfiguration, Benutzer und Mitgliedschaften werden weiterhin in dieser Reihenfolge
mit drei `FOR SHARE`-Abfragen gelesen. Der Helfer schreibt nicht, steuert keine
Transaktion und leiht oder schließt keine Verbindung.

GitNexus bewertet den Leser als CRITICAL: ein direkter Aufrufer, 116 betroffene
Symbole, drei Prozesse und zehn Bereiche. Der direkte Aufrufer ist der verifizierte
Agent-Kontext. Unter den zwölf untersuchten Produktfunktionen verändert sich nur
`readActorMembershipAuthorityOnConnection`; die elf anderen bleiben bytegleich.

## Tatsächlicher PostgreSQL-Nachweis

Die erweiterte Suite `actor-membership-authority-postgres-test.ts` reproduziert
den Fehler vor der Produktänderung: Der ungesperrte Leser liefert für den
präzisen Wert oberhalb von eins `canShare: true`, der bestehende skalare Leser
`false`. Mit der Korrektur bestehen alle 24 Varianten, davon 13 unveränderte und
elf zusätzliche NUMERIC-/Domain-/Boolean-Fälle. Auch skaliertes `1.000…` behält
die bisherige lexikalische Flag-Entscheidung; es erfolgt keine Normalisierung.

Jede Variante vergleicht beide Lesemodi mit dem vollständigen bisherigen Leser.
Rohe PostgreSQL-Werte werden zusätzlich direkt gelesen und auf exakte Strings
beziehungsweise native Booleans geprüft. Bei den Konto-Fällen wird auch der
tatsächliche verifizierte Agent-Kontext auf derselben Verbindung ausgeführt.
Ungesperrt bleibt es bei einer SQL-Abfrage, gesperrt bei drei. Drei echte
konkurrierende Zeilenänderungen werden durch die bestehenden Sperren abgewiesen;
der eigene anschließende Rechteentzug wird sofort beobachtet.

Vor und nach den Aufrufen bleiben rohe Zeilen einschließlich `xmin`, Spaltentypen
und Defaults unverändert. Alle eigenen Datentyp- und Datenänderungen werden durch
Rollback exakt wiederhergestellt. Private Schemas, Datenverzeichnisse und Clients
werden bereinigt; es gibt keine externen Fetches.

Außerdem bestehen 15 vorhandene echte Agent-Policy-Gruppen und 15 tatsächliche
registrierte Agent-/MCP-Lesegruppen einschließlich Rechteentzug und Originalbytes.
Der vorhandene PGlite-Agent-Kontexttest und die drei Verbindungs-/Sitzungs-/
Dokument-Unit-Suiten bestehen. Eine einzelne Unit-Fixture liefert dieselben
bekannten Berechtigungsdaten jetzt über die typisierte Ergebniszeile; sie ist kein
SQL- oder Autoritätsnachweis. Release-TypeScript, die erweiterte Typprüfung mit
24 Wurzeln und 5.101 Quelldateien sowie ESLint bestehen.

## Verbleibende Abnahme

Der vollständige Build, der frisch gebaute Linux-Start und die betroffenen
Agent-Oberflächen müssen mit diesem Produktstand noch geprüft werden. Diese
Korrektur ist kein neuer Leistungsbenchmark. Weitere strukturelle Bündelung,
inkrementelle Linkpflege, gemeinsame Schreibwege und sämtliche abschließenden
Gates des [Gesamtplans](../document-write-database-performance-plan.md) bleiben offen.
