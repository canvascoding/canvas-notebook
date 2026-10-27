# Agent Create: aktuelle Scope-Daten gemeinsam lesen

Stand: 27.10.2026. Vergleich mit der [abgeschlossenen Create-Matrix](document-service-create-matrix-2026-10-27.md).
Produktgrundlage `fdbd3136575fd29244298a33ecf1e3a954675b59`; die einzige geänderte Produktdatei ist
`app/lib/workspaces/request-principal.ts`. Der [maschinenlesbare Bericht](document-service-agent-create-facts-2026-10-27.json)
bindet die tatsächlichen Quellen und Messwerte ohne Inhalte, Dokument-/Benutzeridentitäten,
Dokumentpfade, SQL-Texte, Parameter oder Secrets.

## Änderung

Der reguläre Agenten-Neuanlagepfad liest Workspace, ursprüngliche PI-Sitzung,
Agentenprofil und Konto bei jeder notwendigen Current-Prüfung in einem frischen
SQL-Snapshot auf seiner bereits gehaltenen und gesperrten Verbindung. Die
Sitzungs- und Profilvalidatoren sind unverändert als reine Funktionen extrahiert;
der normale Principal und Job-Aufrufer behalten ihre bisherigen Lesewege.
Seat-/Workspace-/Agentenrichtlinien, Realm- und Transaktionsprüfungen, Fristen,
Widerrufsbehandlung und dauerhafte Originalbelege bleiben aktiv. Die gelesenen
Zeilen sind nur lokale Werte dieses Aufrufs; es gibt keinen Cache über Prüfungen.

## Gleicher Aufrufer und gleiche Testdaten

Beide Größen laufen in frischen privaten PostgreSQL-18-Fixtures mit dem bestehenden
registrierten `write` und tatsächlichen normalen Uploads. Der identische Testaufbau
prüft vollständigen nativen Inhalt, Original-Birth und Projektion, authentifizierten
Dokument-ID-Leser, alle ursprünglichen Registry-/Native-/Metadaten-/xmin-/Dateistände
und eine gesonderte ursprüngliche Wiederholung ohne zweite Anlage. Alle Ressourcen
werden vollständig geschlossen. Die Kontrollläufe sind 49 normale Principal-,
26 Original-Origin-, 48 aktuelle Scope-Fälle und zwölf native PI-Create-Gruppen;
darin bleiben unbestätigtes COMMIT, Reentranz, abgelaufene oder vertauschte Kontexte,
Rechte-/Toolwiderruf und vollständiger Rollback geprüft.

Die Tabelle nennt SQL-Aufrufe vor/nach der Änderung; Pool-Ausleihen bleiben gleich.

| Anfangsbestand | Erster Adapteraufruf | Warme Neuanlage 1 / 2 | Ursprüngliche Wiederholung | Ausleihen erster / warm / Wiederholung |
| --- | ---: | ---: | ---: | ---: |
| 10 | 5308 → 4597 | 5203 → 4492 / 5203 → 4492 | 326 → 284 | 92 / 58 / 7 |
| 200 | 5308 → 4597 | 5203 → 4492 / 5203 → 4492 | 326 → 284 | 92 / 58 / 7 |

Die 229 aktuellen Autorisierungsbeobachtungen im Create-Engine bleiben erhalten;
ihre SQL-Aufrufe sinken von 2.748 auf 2.061 (25 Prozent). Das vollständige
Create-Engine-Fenster sinkt von 4.994 auf 4.307 Aufrufe. Der vollständige warme
Adapteraufruf sinkt von 5.203 auf 4.492 (rund 13,7 Prozent). Seine Messgrenze enthält
weitere echte Prüfungen außerhalb des Create-Engine; deshalb beträgt seine
Einsparung 711 und diejenige des Engine 687. Diese verschachtelten Werte werden
nicht addiert. Die ersten drei Fenster je Größe betreffen frische Neuanlagen; die
Originalwiederholung wird gesondert gemessen.

Release-TypeScript und die abhängigkeitsgeschlossene Typprüfung des Testmoduls
(5.071 Quelldateien, 23 Wurzeln) liefern null Diagnosen; ESLint besteht. Die
Messungen belegen weniger Abfragen. Sie belegen weder einen kontrollierten
Latenzgewinn noch eine verringerte Zahl von Pool-Ausleihen. Jeder Aufruferlauf
beginnt in einem neuen Node-Prozess; der PostgreSQL-Puffercache wird nicht geleert. Das isolierte Lizenzzertifikat
ist ein Testwert; produktive Lizenz-/OAuth-Ausstellung und Modellaufrufe sind
nicht Teil des Vergleichs.

Weitere Berechtigungs-/Realm-Bündelung, inkrementelle Zielauflösung, gemeinsame
normale Schreibmechanik, Original-Recovery und endgültige Leistungsbudgets bleiben
offen. Der finale Produktstand braucht erneut Build/UI, reguläres `test:all`,
PR/CI/Reviews, einen tatsächlichen Backup-/Restore-Nachweis und kontrolliertes
Deployment in allen fünf Workspaces. Review Center und Undo werden nicht weiterentwickelt.
