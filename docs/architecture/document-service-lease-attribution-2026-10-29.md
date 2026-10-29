# Tatsächliche SQL-Aufrufe je Pool-Ausleihe

## Messgrenze

Produktbasis ist `2cb21d9c53056152d4aa0af13e067e3e4b450517`.
Der opt-in Profiler `scripts/helpers/document-query-callsite-profiler.mjs`
ordnet jetzt auch Pool-Ausleihen und deren tatsächlich ausgeführte SQL-Aufrufe
zu. Er protokolliert nur Codepositionen, Funktionsnamen und Zähler. SQL-Text,
Parameter, Dokumentinhalt, Zugangsdaten und Akteur-IDs werden nicht gespeichert.

Der originale Treiber erhält dieselben Argumente und gibt dasselbe Ergebnis
zurück; auch die ursprüngliche Promise-Identität bleibt erhalten. Ein eigener
Diagnosekontext und lesende `acquire`-/`release`-Listener verbinden die SQL-Zähler
mit der tatsächlich ausgeliehenen Verbindung. Dieser Kontext enthält keine
Berechtigung und wird nicht in die Anwendung übernommen.

Der bestehende Messlauf verwendet zehn regulär angelegte native Quellen und je
vier Fenster für den echten Agent- beziehungsweise MCP-Einstieg: erster Aufruf,
zwei warme Neuanlagen und Wiederholung der Originaloperation. Review Center und
Workspace-Undo sind im Test deaktiviert. `FILE_VERSION_CENTER_MODE=shadow`
bleibt wie in den bisherigen Vergleichsläufen gesetzt; eine abschließende
Messung mit allen geforderten Standardeinstellungen steht noch aus.

## Befund

| Warme Neuanlage | Agent | MCP |
| --- | ---: | ---: |
| SQL-Treiberaufrufe insgesamt | 1219 | 919 |
| Tatsächliche Pool-Ausleihen | 37 | 30 |
| Davon als Katalog-/Kontextabfrage klassifiziert | 689 | 633 |
| Größte Publikationsverbindung | 332 | 288 |
| Separate Verbindung zur Absicherung des Dateivorgangs | 159 | 220 |
| Davon aktuelle Owner-Beobachtungen | 144 | 205 |

Beim Agenten werden zusätzlich neun Principal-Captures mit jeweils 14 SQL-Aufrufen
sichtbar, insgesamt 126. Neun weitere Ausleihen lesen jeweils eine Lizenzrevision.
Diese Beobachtung ist noch kein Nachweis, dass eine dieser Prüfungen entfallen darf.

Ein synchroner Stack allein verliert bei vielen Pool-Einstiegen die fachlichen
Aufrufer hinter dem asynchronen Adapter. Die ergänzende Zuordnung anhand der
tatsächlichen SQL-Aufrufe erfasst in beiden warmen Fenstern alle 1219 beziehungsweise
919 Anweisungen auf den beobachteten Ausleihen. Unbekannte Stackeinträge bleiben
ausdrücklich als solche markiert und werden nicht zu erfundenen Aufrufern ergänzt.

## Prüfung und nächste Änderung

Zwei frische PostgreSQL-Fixtures schließen acht Messfenster. SQL- und Pool-Zähler
stimmen in jedem Fenster exakt mit der Produktbasis und dem vorhandenen
Laufzeitzähler überein. Alle Ausleihen wurden tatsächlich erworben. Die Summe der
zugeordneten SQL-Aufrufe je Verbindung und der separat ausgewiesenen Aufrufe ohne
beobachtete Ausleihe entspricht stets der Gesamtzahl. Es gibt keine Stackfehler,
fehlgeschlagenen Anweisungen oder am Ende offenen Abfragen/Verbindungen.
Originalidentitäten, unverwandte Native-Zeilen und physische Bytes bleiben erhalten;
die Fixtures entfernen ihre eigenen Schemas, Verbindungen und temporären Daten.

Das ist ein Diagnosefortschritt, keine zusätzliche Leistungseinsparung. Die nächste
Produktänderung muss vor allem wiederholte aktuelle Prüfungen innerhalb der
Publikation und der Owner-Beobachtung reduzieren. Frische Rechteprüfungen an
tatsächlichen Schreibgrenzen, echte Sperren und bestätigte Abschlüsse bleiben
verbindlich. Danach sind wiederholte Principal-Captures und unabhängige
Projektionsverbindungen zu prüfen.

Die vorläufigen Ziele bleiben höchstens fünf SQL-Lesezugriffe je aktueller
Berechtigungsbeobachtung, höchstens zwanzig für normales Öffnen und zunächst
200–500 Anweisungen für die vollständige Neuanlage. Die endgültigen Grenzen
benötigen die vollständigen 10-/200-Quellen-, Latenz- und Parallelitätsvergleiche.
Review Center und Undo werden dafür nicht weiterentwickelt. Die übrigen Pakete,
Build-/UI-/Gesamtsuite-, Review-, Restore- und Release-Abnahmen bleiben offen.
