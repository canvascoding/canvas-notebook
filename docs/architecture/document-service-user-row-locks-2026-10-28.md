# Dokumentservice: Benutzerzeilen gemeinsam sperren

Stand: 28.10.2026. Vergleichsbasis ist `547cd1ab136b249bcc38af53ff70676c021c0a43`.
Der [maschinenlesbare Nachweis](document-service-user-row-locks-2026-10-28.json)
bindet Produkt-/Testquellen und tatsächliche Testausgaben über SHA-256.
Dies ist eine weitere Teiländerung von Paket 2 des zentralen Serviceplans.

## Änderung

Die bestehende Request-/Agent-/Job-Phase sperrte jede zugehörige Benutzerzeile mit
einem eigenen SQL-Aufruf. Für die reguläre TEXT-ID werden dieselben ursprünglichen
Selektoren jetzt in einer begrenzten SQL-Abfrage abgearbeitet. Die vorhandene
Fremdschlüsselprüfung beobachtet den tatsächlichen Elterntyp unter der bestehenden
Tabellensperre. Andere ID-Typen behalten den ursprünglichen einzelnen Treiberpfad.

Die UTF-8-Reihenfolge, ausgewählte Benutzermenge, `FOR SHARE NOWAIT`, rohe
Treiberwerte und bisherige Sperr-/Flag-Prüfungen bleiben erhalten. Insbesondere
werden NUMERIC-Werte nicht über JSON gerundet. Die Typinformation bleibt privat
in der tatsächlich gehaltenen Phase; sie ersetzt keine aktuelle Berechtigung.
Die beiden geänderten Funktionskörper sind `schema` und `locks`; alle 61 übrigen
bestehenden Funktionskörper sowie die übrigen Policy-, Current-, Lebensdauer-,
Fehler- und Freigabepfade bleiben bytegleich.

## Tatsächliche PostgreSQL-Prüfungen

Die neue Suite umfasst 16 Gruppen. Für jeweils Lesen und Schreiben werden bei
2, 32 und 200 ausgewählten Benutzern sämtliche Zeilensperren mit inkompatiblen
Peer-Sperren geprüft: 468 echte PostgreSQL-Verweigerungen. Sechs erfolgreiche
Peer-Sperren auf ein unbeteiligtes, deaktiviertes Konto beweisen, dass diese
Zeile nicht zusätzlich gesperrt wird. Nach Ende der Phase wird die ausgewählte
Benutzerzeile wieder freigegeben. Gesperrte Peer-Zeilen verweigern den Zutritt.

Die regulären TEXT-Fälle benötigen jeweils eine Benutzer-Sperrabfrage statt
2, 32 oder 200. Ein tatsächlicher TEXT-Domain-Typ behält 200 einzelne Abfragen.
Ein roher NUMERIC-Nullwert bleibt erlaubt; ein winziger positiver NUMERIC-Wert
wird unverändert verweigert. Zurückgerollte Typ-/FK-Änderungen erhalten originale
Zeilen, xmin, Spaltentypen und Constraint-OIDs. Eigene Schemas, Verbindungen,
Daten und der temporäre Bundle-Ordner werden vollständig entfernt.

Zusätzlich bestehen 25 vorhandene PostgreSQL-Suiten für Principals, Mitgliedschaft,
Wartungsaufträge, Gäste, Agentenanlage einschließlich COMMIT-Antwortverlust,
Dokumentlesen/-suche/-änderung und öffentliche Freigaben. Die ersten 23 wurden
im strengen Dokument-Runner ausgeführt. Der Versuch, die Freigabe-Suite dort
aufzurufen, scheiterte vor Fixture-Start an der Runner-Zulassung; beide Freigabe-
Suiten wurden danach mit ihrem vorhandenen tatsächlichen TSX-Runner erfolgreich
geprüft. Die später ergänzte neue Testkontrolle ändert keine ihrer Produktquellen.
Gezieltes TypeScript mit 56 Wurzeln/5185 Quellen, Release-TypeScript und ESLint
bestehen. Der abschließende ergänzte Test im Integrationsarbeitsbaum meldet alle
Assertions und vollständige Bereinigung; der ursprüngliche Prozess-Handle ist
inzwischen abgelaufen, sein Exitstatus wird deshalb nicht nachträglich erfunden.

GitNexus prüft die drei gestagten Code-/Testdateien sowie den Vergleich zu `main`.
Der Index ist veraltet und ordnet zusätzliche unveränderte Symbole anhand alter
Zeilenbereiche zu. Der AST-/Bytevergleich grenzt die tatsächliche Produktänderung
auf die beiden genannten Funktionen und das private Phase-Feld ein. Das kritische
Risiko des gemeinsamen Berechtigungspfads bleibt maßgeblich.

## Offene Abnahmen

Der größere Vergleich für HTTP-/Agent-/MCP-Lesen und reguläre Neuanlage bei 10 und
200 Dokumenten läuft noch und erhält eine eigene Auswertung. Aus den gezielten
Benutzerfällen wird keine Gesamtlatenz- oder Produktionsanteils-Aussage abgeleitet.
Weitere Bündelung, inkrementelle Linkpflege, gemeinsame Schreibwege und die finalen
Build-/UI-/test:all-/CI-/Review-/Backup-/Restore-/Recovery-/Release-Prüfungen des
Gesamtplans bleiben offen. Review Center und Undo werden nicht weiterentwickelt.
