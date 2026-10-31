# Erste Workspace-Fakten beim HTTP-Dokumentlesen

Der HTTP-Dokumentleser liest die Einrichtung, den aktuellen Benutzer, den
Organisationseigentümer und den gewählten Workspace einschließlich seiner
Rechte jetzt gemeinsam. Der reguläre erste Workspace-Schritt benötigt eine
SQL-Abfrage statt fünf; Team-/Projektmitgliedschaften sind ebenfalls enthalten.

Nur der feste HTTP-Leseweg verwendet dieses Profil. Die gemeinsame
Anmeldeprüfung über Better Auth einschließlich Account-/Seat-Prüfung bleibt
erhalten. Andere Request-Principals und der Kollaborationszutritt verwenden
weiterhin den bisherigen initialen Resolver. Herkunftserfassung nach der
Lizenzprüfung, aktuelle Rechte während der Dokumentphase, native Identität,
Bindings, Metadaten und die abschließenden Prüfungen bleiben erhalten.

Die Abfrage übernimmt die vorhandene skalare Workspace-Projektion und deren
Entscheidung. Sie erzeugt weder eine Berechtigung noch einen Cache und führt
keine Bootstrap-Schreibvorgänge aus. NUMERIC-Werte werden weiterhin als echte
Treiberwerte ausgewertet. Fehlender Benutzer, fehlende Organisation,
Umgebungskonflikt und fehlender Eigentümer behalten ihre bisherige Priorität.

Ein älteres Schema kann getrennt gebundene IDs unterstützen, obwohl ein Join
zwischen zwei Spaltentypen nicht funktioniert. Für benannte PostgreSQL-
Parse-/Typfehler wird deshalb der bestehende sequenzielle Resolver auf derselben
Verbindung ausgeführt. Dies ist etwa mit UUID-Eigentümer und Text-Benutzer-ID
sowie fehlenden optionalen Mitgliedstabellen geprüft. Dieser Ausnahmeweg
benötigt sechs statt fünf Abfragen. Verbindungsausfälle, Zeitüberschreitungen
und unklare Bestätigungen lösen keinen solchen Wiederholungsversuch aus.

## Nachweise am Quellstand

Die Ausgangsbasis ist `820341269`, einschließlich des CLI-Lockfile-Fixes und der
Release-Metadaten für 2026.10.31.1. Eine neue Installation und der tatsächliche
HTTP-/Agent-/MCP-Vergleich auf dieser Basis bestehen. Für die Änderung bestehen:

- Vier bestehende PostgreSQL-Suiten: Request-Principal (66 Gruppen),
  authentifizierter nativer Sitzungsleser (24), öffentlicher Dokumentleser (23)
  und registrierter Agent-/MCP-Dispatch (15).
- 34 neue Fälle mit echten PostgreSQL-Ergebnissen und echter Cookie-Anmeldung:
  persönliche, Organisations-, Team- und Projekt-Workspaces, Widerrufe,
  Archivierung, fehlende Einrichtung, Fehlerpriorität, Schema-Kompatibilität,
  genaue NUMERIC-Werte sowie verlorene Bestätigung und Timeout ohne Wiederholung.
- Fünf frische Vergleichs-Fixtures mit 15 vollständig beobachteten Fenstern.
  SQL- und Verbindungsmessung stimmen mit den tatsächlichen Aufrufen überein;
  die ursprünglichen Daten, Operationsbelege, Dateianker und Container bleiben
  unverändert.
- Vollständige gezielte TypeScript-Prüfung mit 5.119 Importdateien und null
  Fehlern sowie ESLint für die geänderten Dateien.

| Warmer Abruf | SQL vorher | SQL danach | Verbindungsausleihen |
| --- | ---: | ---: | ---: |
| HTTP, 10 und 200 Dokumente | 59 | 55 | 8 |
| Hauptagent, 10 Dokumente | 99 | 99 | 3 |
| Organisationsagent, 10 Dokumente | 117 | 117 | 3 |
| MCP, 10 Dokumente | 74 | 74 | 19 |

Beim ersten HTTP-Einstieg sinkt die Anzahl von 62 auf 58, bei weiterhin elf
Ausleihen. Der neue Fehlerfalltest erwartete zunächst einen rohen
Verbindungsfehlercode; der bestehende Datenbankadapter liefert dafür korrekt
`postgres_unavailable`. Nach Korrektur dieser Erwartung bestehen alle 34 Fälle.
Die Produktquellen der vier zuvor erfolgreichen Suiten sind bytegleich geprüft.

Private Messbelege liegen in `http-initial-facts-1793435466204` (Ausgangsbasis),
`http-initial-facts-1793435867498` (bestehende Suiten) und
`http-initial-facts-1793436049088` (Vergleich und abschließender Fehlerfalltest)
im bestehenden privaten Dokument-Service-Abnahmeverzeichnis.

Die GitNexus-Prüfung vor dem Commit stuft den Umfang als hoch ein; die anfängliche
Analyse des gemeinsamen Request-Principals war kritisch. Die betroffenen echten
Anmelde-/Dateiaufrufer sind geprüft. Sechs zusätzlich als berührt gemeldete
Nachbarsymbole sind anhand ihrer vollständigen TypeScript-Definitionen bytegleich
zum Basiscommit; die Zeilenverschiebung erweitert den tatsächlichen Umfang nicht.

## Verbleibende Abnahme

Produktionsbuild, neues Linux-Image, Start-/Browserprüfung und PR-/CI-Abnahme
dieses Quellstands stehen noch aus. Die älteren Image-/Browsernachweise werden
nicht als Nachweis für diese Änderung verwendet. Kein neues Release oder
Produktionsdeployment wurde damit ausgeführt.

Dies ist ein weiterer Teil von Paket 2. Gemeinsame Fakten in den übrigen Phasen,
selektive Body-Lesungen, gemeinsame Schreibmechanik und die abschließenden
Leistungsbudgets bleiben offen. Review Center und Undo sind nicht Bestandteil
dieser Änderung.
