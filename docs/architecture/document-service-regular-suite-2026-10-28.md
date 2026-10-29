# Dokumentservice: reguläre Linux-Gesamtsuite

Stand: 28.10.2026. Dies ist der bestandene reguläre Regressionstest als Grundlage
für den weiteren zentralen Dokument-/Linkservice-Umbau. Die übrigen Pakete des
[Gesamtplans](../document-write-database-performance-plan.md) bleiben erforderlich.

## Ausführung und Quellstände

- Tatsächlicher Aufruf: `npm run test:all`, ein Browser-Worker, null Test-Retries.
- Teststand: `24afcded51a3701bd1c10e7799e6b6424421d262`.
- Vollständig gebauter Produktstand: `d28401e6d6d479e35cebde3c559aa22621c8f9f1`.
- Image: `sha256:805d0b54f5c4713110f0d0cadf6badda722d8359b68913a3b54e682c10f60abc`.
- Laufzeit: 16:44:22–17:32:00 UTC am 28.10.2026, Exitcode 0.

Der vorhandene PostgreSQL-Stack wurde verwendet und genau ein Notebook-Container
vor dem Lauf mit demselben Image und denselben eigenen Volumes neu erzeugt.
Der externe Servermodus überspringt Build und Serverstart innerhalb von
`test:all`; die vollständigen Host-/Linux-Builds und der echte Containerstart
sind gesondert nachgewiesen. Zwischen Produkt- und Teststand unterscheiden sich
ausschließlich sechs Test-/Konfigurations-/CI-Dateien: der Bulk-Test, die beiden
Browserhelper, der Anmelde-Vertragstest, die Playwright-Konfiguration und der
Dev-Runtime-Workflow. Produktquellen wurden nicht in den Container kopiert.

## Ergebnis und Grenzen

**329 bestanden, 0 fehlgeschlagen, 268 übersprungen; insgesamt 597 Browserfälle.**
Die vollständige Einzelfallliste und die Rohprotokolle sind privat archiviert.
Die bestehende reguläre Auswahl bleibt bei 150 Dateien und 597 Fällen. Die
268 bedingten Skips betreffen verschiedene optionale oder fixturegebundene
Bereiche; sie sind nicht sämtlich Review-Center-Tests. Eigene Akzeptanzrunner
für private Fixtures bleiben wie vereinbart separat. Review Center ist in der
verwalteten Instanz deaktiviert; die normalen Prüfungen bei deaktiviertem Undo
bleiben erhalten. Beide experimentellen Funktionen werden nicht weiterentwickelt.

Die normalen Recovery-, Filetree-, Desktop-/Mobil-, Link-, Rename-/Move-,
Home-/Studio- und Chat-Prüfungen bestehen. Insbesondere besteht der zuvor rote
Chat-History-Test nach der Korrektur des Cursor-Testhelpers auch im Gesamtlauf.
Der kontrollierte Gegenvergleich verzögert die Auswahlbenachrichtigung: alter
Helper 3/3 fehlgeschlagen, korrigierter Helper 3/3 bestanden. Ohne Verzögerung
bestehen 104 gezielte Fälle mit unveränderten Assertions. Die genaue Ereignisfolge
des früheren ungetraceten Gesamtlauffehlers bleibt unbekannt.

Die neun CI-Prüfungen am Teststand sind erfolgreich. Der Dev-Runtime-Workflow
führt die sechs Birth-Storage-Fälle unter Node 24 und 26 auf Linux aus; beide
Jobs bestehen. Playwright bewahrt Fehler-Traces bei künftigen Fehlschlägen auf.
Zum Prüfzeitpunkt liegen keine PR-Reviews, Kommentare oder Review-Threads vor;
die fachliche Review-Abnahme bleibt offen.

## Datenerhalt

Die ursprüngliche 98-Byte-Lokalprobe wurde vor der Container-Ersetzung und nach
dem Gesamtlauf unabhängig beobachtet. Registry-, Native-, Birth- und Receipt-
Zeilen einschließlich `xmin` bleiben exakt gleich. Ursprüngliche Quell-/Ziel-
und Record-Bytes sowie Inodes und alle drei vorhandenen Speicheranker sind
ebenfalls identisch. Operations- und Dokumentidentitäten bleiben erhalten.

Das Browser-Artefaktarchiv enthält 18.360.320 Bytes, SHA-256:
`cf54510e59c6925bc733b7465ff29170d7c1d4ac3f9f47699412b5756b1eeb7d`.
Produktionsbackup/-restore, ursprüngliche LinkedIn-Recovery und die Einführung
in allen fünf Produktionsworkspaces bleiben eigene offene Abnahmen.

## Verbleibende Servicearbeit

Ein frischer, vollständig bereinigter Agenten-Create-Vergleich am selben
Quellstand bestätigt 1.919 SQL-Treiberaufrufe und 46 Pool-Ausleihen je warmer
Neuanlage. Die ursprüngliche idempotente Wiederholung benötigt 178/7. Die
Diagnose zählt reale Aufrufe einschließlich ihrer Quellzuordnung; ihre zusätzlich
instrumentierten Laufzeiten gelten nicht als Leistungsabnahme.

Weitere aktuelle Datenbündelung, inkrementelle Linkprojektion, gemeinsame normale
Schreibwege und abschließende Latenz-/Parallelitätsnachweise sind weiterhin
erforderlich. Nach den verbleibenden Produktänderungen sind die betroffenen
Regressionen und die endgültigen Build-/UI-/Suite-/CI-/Review-Gates erneut fällig.
Ein korrigiertes Produktionsrelease wurde mit diesem Testmeilenstein nicht veröffentlicht.
