# Dokumentservice: genaue skalare Werte in gemeinsamen Snapshots

Stand: 27.10.2026, auf Basis von `947b1af3307a6aab9f3a231398829ffc9ae5b630`.
Der [maschinenlesbare Bericht](document-service-scalar-snapshots-2026-10-27.json)
bindet Produktquellen, Tests und Messausgaben über SHA-256. Dies schließt die
nach der MCP-Bündelung gefundene Wertabweichung, nicht den gesamten
[Dokument-/Linkserviceplan](../document-write-database-performance-plan.md).

## Nachgewiesener Fehler

PostgreSQL liefert NUMERIC als exakten String. Ein verschachteltes `to_jsonb`
machte daraus eine JavaScript-Zahl. So wurde etwa `1.00000000000000000001` zu `1`.
Der gemeinsame Workspace-Entscheider akzeptiert für diese Rechte nur die Zahl
`1`; die gewöhnliche skalare Abfrage lehnte den tatsächlichen String ab, während
der gebündelte Leser ein Schreibrecht daraus machte. Auch NUMERIC `1` wich wegen
des skalaren Stringtyps vom bisherigen Entscheider ab.

Echte Änderungen auf der bereits gehaltenen Benutzerverbindung und beim
authentifizierten Nicht-Admin-Agenten reproduzieren diese Abweichung. Beim Agenten
verdeckte JSON-Rundung außerdem tatsächliche Bruchteile in Profil- und Workflow-
Revisionen. Die ungeänderten skalaren Revisionsprüfer lehnen diese Strings ab.
Der Agenten-Basislauf akzeptierte sechs untersuchte Änderungen; alle wurden vor
COMMIT zurückgerollt und die ursprünglichen Zeilen/xmin/Spaltentypen geprüft.

## Gemeinsame Korrektur

`postgresScalarSnapshotSql` kapselt ausschließlich die Datenübertragung. Feste
interne Feldlisten erhalten NUMERIC als exakte Strings. Noch nicht belegte Typen
wie Domains und DATE werden über einen privaten Typmarker als Schemafehler
abgewiesen. Der Helfer erzeugt SQL und trifft keine Berechtigungsentscheidung.

Alle 19 skalaren Workspace-Felder sind zentral definiert. Benutzer- und Agenten-
Create-Leser verwenden diese gleiche Projektion. Agentenprofil-/Sitzungszahlen,
Kontosperre und Seat-Werte werden ebenfalls exakt übertragen. Die vorhandenen
reinen Konto-, Seat-, Profil-, Sitzungs- und Workspace-Entscheider bleiben bestehen.

Agenten-Create verwendet für seine ausschließlich aus JSONB-Spalten bestehende
Antwort die vorhandene Planwiederverwendung. Ergebnisse werden bei jeder Prüfung
frisch auf der gehaltenen Verbindung gelesen. Adapter ohne diese Methode lesen
gewöhnlich weiter. Weder Datenbank-API noch Lebensdauer, Sperren, Widerrufsprüfung
oder Autorität werden erweitert; es entsteht kein Berechtigungs- oder Zeilencache.

MCP verwendet denselben Helfer. Der tatsächlich erzeugte MCP-SQL-Text bleibt
bytegleich. Von den bestehenden Funktionen ändern sich nur die zwei Benutzer-/
Agenten-Snapshot-Leser und der delegierende MCP-SQL-Helfer: 61 weitere Principal-,
79 Workspace- und 45 MCP-Funktionen bleiben bytegleich.

## Prüfungen und verbleibende Abnahme

46 echte Benutzerfälle prüfen unter anderem beide frischen Beobachtungen,
Widerruf zwischen Antworten, numerische Lese-/Schreibrechte und unbekannte Domains.
Lesen bleibt nach reinem Schreibrechtsverlust erlaubt. 14 Agentenfälle prüfen
vorbereitete und gewöhnliche Leser, genaue Rechte/Profile und unbekannte Typen.
132 MCP-Fälle bestätigen die bisherige Read/Create/Edit-Prüfung beider Leser.
Originale SQL-Antworten werden nicht ersetzt. Auch unerwartet akzeptierte
Negativfälle werfen vor COMMIT; tatsächliche Zeilen/xmin und Spaltentypen bleiben
nach Rollback erhalten.

Alle zwölf gebundenen PostgreSQL-Suiten bestehen, darunter Benutzer-/Metadaten,
Agentenscope, initiale/finale Beobachtung, Session-Transport, native Räume,
Maintenance, MCP-Copy und native Create/Copy-Owner. Zusätzlich bestehen 23 echte
WebSocket-Familien einschließlich Read-only, Quarantäne, Busy und Wiederverbindung.
Release-TypeScript, gesondertes TypeScript mit 42 Wurzeln/5164 Quellen/keinen
Diagnosen sowie ESLint ohne Warnungen bestehen.

Die separaten Abfrage-/Laufzeitmessungen mit zehn Quellen stehen im Maschinenbericht:

| Ablauf | Warm: SQL-Aufrufe / Pool-Ausleihen | Lokale Dauer |
| --- | ---: | ---: |
| Agenten-Neuanlage | 2180 / 46, beide Wiederholungen | 2,59 / 2,66 s |
| MCP-Neuanlage | 1976 / 37, beide Wiederholungen | 2,41 / 2,39 s |
| HTTP-Öffnen | 88 / 9, beide Wiederholungen | 76,62 / 73,65 ms |

Die ursprüngliche Agenten-/MCP-Wiederholung bleibt bei 180 / 7 beziehungsweise
102 / 12. Alle drei Fixtures schließen ohne offene Abfragen/Verbindungen oder
externe Fetches. Der Auswerter musste für HTTP dessen tatsächlich anderes
Ergebnisformat berücksichtigen; alle drei Fixture-Prozesse waren bereits
erfolgreich abgeschlossen und wurden für diese Auswertung nicht erneut gestartet.

Diese Werte sind begrenzte lokale Nachweise, keine allgemeine Leistungsabnahme.
Frühere 200-Quellen-Läufe behalten ihre eigene
Quellenbindung. Weitere gemeinsame Phasen-/Registry-/Zustandsbündelung,
inkrementelle Linkabhängigkeiten und normale gemeinsame Schreibwege fehlen
weiterhin. Abschließender Build, Desktop-/Mobile-UI, reguläres `test:all`, CI und
Reviews am finalen Stand, Backup/Restore, ursprüngliche Dokument-Recovery und
Release/Deployment bleiben offen. Review Center und Undo werden nicht
weiterentwickelt; Produktionsdaten und veröffentlichtes Release bleiben erhalten.
