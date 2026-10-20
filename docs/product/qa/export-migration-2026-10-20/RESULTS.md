# Export und Datenmigration – Gesamtabnahme am 20.10.2026

Status: **bestanden – 20/20 End-to-End-Fälle**, keine Wiederholungen, keine übersprungenen Tests, keine Runner-Fehler. Laufzeit: 4 Minuten 42 Sekunden. Ausgangspunkt ist die [Abnahme mit fünf Fehlern](../export-migration-2026-10-19/RESULTS.md). Umsetzung und Einzelprüfungen stehen im [Arbeitsprotokoll](IMPLEMENTATION.md).

## Testumfang

| Bereich | Nachweis |
| --- | --- |
| Einzel-Workspace | Tatsächliche ZIP-Dateien für persönliche, Organisations-, Team- und Projekt-Workspaces; binäre Daten, Unicode-Namen und leere Ordner |
| Aktueller Editorinhalt | Frisch sichtbares Markdown und Excalidraw werden unmittelbar exportiert |
| Gesamtexport | Standardprofil und ausdrücklich bestätigtes Full-Admin-Profil; exakte Dateiauswahl, Komponenten und Secrets-Ausschluss |
| Bedienung | Schnelle Workspace-Wechsel, aktualisierte Größen, leere Zustände und sichtbare Downloadfehler; Desktop und 390 px |
| Zugriff | Eigentümer, Mitglied, Admin, fremder persönlicher Workspace und anonym; vorbereitete Downloads an Sitzung gebunden und einmalig |
| Fehlerfälle | Fehlende Dateien, Traversal, Links, Größen-/Tiefen-/Eintragsgrenzen, korrupte Archive, Version/Schema und unzulässige Zuordnung |
| Upload | Mehrteiliger Upload über 8 MiB mit anschließender Prüfung der tatsächlichen Bytes |
| Dateimigration | Vollständiges Quellarchiv auf andere ausdrücklich bestätigte Zielwurzeln, Neustart, Datei-Hashes und natives Markdown im Browser |
| Datenbankmigration | Echter PostgreSQL-Snapshot plus Workspace-Dateien, Upload, Bestätigung, Anwendung vor Serverstart und Prüfung auf der Zielinstanz |
| Nacharbeiten | Alte Sitzung ungültig, Automationen erhalten und pausiert, OAuth entfernt, Ziel-API-Key und eigene Ziel-Lizenz erhalten |
| Rücknahme | Erzwungener Dateifehler mit echtem nativem Dokument und wiederholte Rücknahme; echte SQL-Transaktion mit kontrolliertem Rollback |

## Abschließende Ergebnisse

- Produktionsbuild, gezieltes TypeScript und ESLint bestanden.
- Archiv-, Exporttreue-, Text-Checkpoint- und Restore-Prüfungen bestanden.
- Direkter PostgreSQL-Test: 133 übernommene Tabellen mit 126.229 Datensätzen. Jede übernommene Tabelle wurde gegen ihre vollständige Staging-Zeilenanzahl geprüft. Zielkonten dürfen zusätzlich bestehen bleiben. Lizenzdaten und sämtliche Trigger-Modi waren nach Austausch und Rollback unverändert.
- Tatsächlicher Dateiimport: 228 Dateien aus dem Gesamtexport in ausdrücklich andere Zielwurzeln; sämtliche Datei-Hashes stimmen und natives Markdown ist nach Neustart sichtbar.
- Tatsächlicher PostgreSQL-Import: 126.261 Datensätze aus 133 Tabellen sowie 228 Dateien übernommen. Acht binäre native Dokumentzustände sind bytegenau erhalten. Beide Quell-Automationen sind vorhanden und pausiert; Unicode einschließlich U+2028/U+2029 bleibt erhalten.
- Die eigene Zielinstanz und Ziel-Lizenz, Ziel-API-Key und Quellprojekt wurden geprüft. Alte Sitzungen sind ungültig, OAuth-Fixture-Tokens und öffentliche Freigaben entfernt. Veraltete Zieldateien bleiben nach dem vollständigen Datenbanktransfer nicht zurück.
- Desktop und 390-px-Ansicht bestanden; Importbeleg visuell geprüft. Die vier verwalteten Dienste bleiben gesund, PostgreSQL meldet 18.4 mit pgvector 0.8.3. Der fremde Dev-Prozess auf Port 3000 blieb unverändert.

Die Gesamtabnahme deckte zusätzlich eine fehlerhafte Abhängigkeitsregel auf: Ein optionaler Verweis auf eine ausgeschlossene Verbindung löschte zuvor die gesamte Automation aus dem Snapshot. Solche Verweise werden jetzt geleert; Pflichtabhängigkeiten brauchen eine ausdrücklich geprüfte Richtlinie. Dauerhafte Operations-, Vorschlags- und Bestätigungshistorien werden übernommen. Historische Zustände werden innerhalb der Transaktion ohne die Regeln für *neue* Zustandsübergänge geladen; Fremdschlüssel, Prüfvorgaben und generierte Spalten bleiben wirksam. Alle vorherigen Trigger-Modi werden vor dem Commit wiederhergestellt. Ein weiterer Test sichert Unicode-Zeilen-/Absatztrenner und unveränderte binäre Yjs-Zustände ab.

## Umgebung und Grenzen

- Ein verwalteter lokaler Stack mit PostgreSQL 18/pgvector und Control Plane. Ein zusätzlicher, ausschließlich eigener Hostprozess auf `127.0.0.1:3001` verwendet nacheinander die getrennten Datenbanken `canvas_export_99b4_source` und `canvas_export_99b4_target` und private Datenwurzeln. Kein Container wurde gebaut und keine parallele Testumgebung gestartet.
- Die Zielinstanz hat eine eigene Instanz-ID und eine über die regulären lokalen Aktivierungs-/Claim-/Development-Team-Flows erteilte Entwicklungslizenz. Lizenzzustand wurde nicht per SQL hergestellt.
- Die geerbte Quellkopie wurde vor den positiven Tests kontrolliert bereinigt: alte beschädigte/verwaiste native Dokumente archiviert und Dateiwurzeln deaktivierter/gesperrter alter QA-Workspaces privat gesichert. Das unveränderte ursprüngliche Archiv bleibt als blockierter Negativfall erhalten. Details und Zahlen stehen im Arbeitsprotokoll. Die positiven Tests belegen gültige Quellen; sie belegen keine automatische Reparatur beschädigter Altbestände.
- Datenbanktransfer erfordert dieselbe Organisation und dasselbe geprüfte Schema. Ein bestehendes Zielkonto mit derselben E-Mail braucht dieselbe Benutzer-ID. Abweichende Benutzer-/Workspace-Zuordnung ist im Dateitransfer möglich. Datenbankauswahl erfordert Full Admin und ausdrücklich eingeschlossene persönliche Daten.
- Das Archiv ist privat und unverschlüsselt. Verwaltete Zugangsdaten werden ausgeschlossen/zurückgesetzt; unveränderte Benutzerinhalte und Chatverläufe können früher hineinkopierte Links oder Zugangsdaten enthalten.
- Browser- und API-Abnahme erfolgten lokal. Remote-CI, Deployment, physische Geräte und erneute Anmeldung bei externen OAuth-Anbietern sind nicht Teil dieses Nachweises. Es wurde nichts gepusht oder veröffentlicht.

Die abschließende GitNexus-Prüfung der letzten Korrektur umfasst zwölf erwartete Symbole in fünf Code-/Testdateien, Risiko niedrig. Der gesamte Auftrag seit `a9b89776a` ist wegen seiner zentralen Export-/Importwege als hoch eingestuft; die neun gemeldeten Zugriffsabläufe sind durch die Berechtigungs- und Transferfälle abgedeckt. Der Vergleich mit dem inzwischen weiterentwickelten lokalen `main` umfasst zusätzlich fremde Änderungen und ist kein isolierter Änderungsumfang dieses Auftrags.

ZIPs, private Rohprotokolle und Screenshots liegen außerhalb des Repositories unter `~/.local/state/canvas-local-team-seat/export-migration-99b4`. In Git stehen ausschließlich Testlogik und dieser bereinigte Bericht. Der eigene Testserver ist beendet; 48 Quell- und eine Ziel-Test-Sitzung wurden zum Abschluss ausschließlich in den beiden isolierten Datenbanken widerrufen.
