# Genaue Zählung bereiter Laufzeitverbindungen

Stand: 30.10.2026. Produktbasis: `6302d6403755e581f0eae9e83a10e1c016aa918c`.
Teil des [Dokumentservice-Plans](../document-write-database-performance-plan.md).
[Quellhashes und Kontrollwerte](document-service-physical-connections-2026-10-30.json).

Der zusätzliche opt-in Profiler beobachtet die tatsächlichen Connect-/End-Ereignisse
registrierter PostgreSQL-Laufzeitclients. Er zählt ruhende Pool-Verbindungen sowie
direkte Owner-Verbindungen und weist laufende Verbindungsversuche separat aus.
Damit lässt sich das Maximum bereiter Laufzeitverbindungen einschließlich bereits
vor dem Messfenster geöffneter Clients bestimmen. TCP-/Authentifizierungsversuche
vor erfolgreicher Anmeldung sind keine bereits bereiten Verbindungen.

Die bestehende SQL-Instrumentierung, ihre Callback-/Promise-Semantik und
Berechtigungsprüfungen bleiben erhalten. Der Profiler fügt keine SQL-Abfrage hinzu
und speichert keine Abfragetexte, Parameter, Inhalte, Akteur-IDs oder Zugangsdaten.
Er ist nur im ausdrücklich aktivierten, begrenzten real-source Dispatch-Prozess
aktiv. Der Produktcode importiert ihn nicht. Die Ereignisverträge wurden gegen
die installierte pg-Version 8.22.0 und die
[offizielle Pool-Dokumentation](https://node-postgres.com/apis/pool) geprüft.

## Tatsächliche Kontrolle

Sieben echte PostgreSQL-18-Fenster bestehen einzeln sowie kombiniert mit dem
vorhandenen SQL-Callsite-Profiler, insgesamt 14 Kontrollfenster:

- Ruhender Pool und vorübergehende direkte Verbindung.
- Wachstum des Pools mit echten Callback- und Promise-Aufrufen.
- Verbindungsbeginn vor und erfolgreiche Anmeldung innerhalb eines Messfensters.
- Äußeres und darin überlappendes inneres Fenster.
- Späte Registrierung einer bestehenden Verbindung und Schließen ohne eigene Query.
- Fehlgeschlagene Anmeldung an einer nachweislich fehlenden Testdatenbank.

Die erwarteten Spitzenwerte von vier beziehungsweise fünf bereiten Verbindungen
stimmen exakt; kontrollierte Lebensdauerpunkte werden zusätzlich gegen
`pg_stat_activity` geprüft. Die beiden überlappenden Fenster zählen denselben
Client unabhängig für ihr jeweiliges Maximum. Unregistrierte Kontrollclients
bleiben außerhalb der Laufzeitzählung. Ursprüngliche SQL- und Connect-Fehler
bleiben erhalten; Callback-Aufrufe geben weiterhin den originalen Rückgabewert
zurück. Alle nichtleeren SQL-/Pool-Fenster des kombinierten Laufs haben exakt
übereinstimmende SQL-Zähler.

Beide Läufe schließen sämtliche eigenen Clients und Pool-Verbindungen. Keine
Beobachtung schlägt fehl, kein Fenster beginnt vor der Instrumentierung und kein
Messfenster bleibt offen. Der Kontrolltest schreibt weder Tabellen noch Dokumente.
Die geschützten QA-Originalzeilen mit `xmin`, nativen Zuständen, Dateibytes und
drei Speicherankern sowie alle laufenden Container-IDs bleiben unverändert.
Syntax, gezieltes ESLint und die Typprüfung der neuen Testdatei samt ihrem
tatsächlichen Importgraphen bestehen.

## Verwendung und verbleibender Messauftrag

Die vorhandenen Baseline-Läufe können zusätzlich mit
`NODE_OPTIONS=--import=./scripts/helpers/document-physical-connection-profiler.mjs`
aufgerufen werden. Ihr absoluter privater
`CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT`-Pfad erhält zusätzlich eine
`.connections.json`-Datei. Ohne diese Aktivierung entsteht keine neue Produktarbeit.
Unvollständige Beobachtung, ein bereits vorher laufendes Fenster oder eigene
verbliebene Verbindungen machen die Diagnose am Prozessende ausdrücklich ungültig.

Der vorangehende [Editor-Vergleich](document-service-editor-current-baseline-2026-10-30.md)
verwendet noch 100-ms-Stichproben und damit Untergrenzen. Die neue Diagnose muss
für die vollständigen aktuellen Aufrufervergleiche erst angewendet werden.
Dieser Schritt reduziert keine Produktabfragen und erfüllt die Leistungsbudgets
noch nicht. Faktenbündelung, begrenzte native Body-Lesungen, gemeinsame Schreibwege
und alle übrigen Abnahmen bleiben offen. Review Center und Undo erhalten keine
neue Funktionalität.
