# Inkrementelle Zielauflösung im lesenden Dokumentindex

Stand: 30.10.2026. Geprüfter Produktstand:
`64532d709e4eec53e4f527d2e85be5c5a275029b`, einschließlich der MCP-Korrekturen aus PR #189 und der Sicherheitsänderungen aus PR #190.
[PR #191](https://github.com/canvascoding/canvas-notebook/pull/191) enthält diesen
Teilschritt des [zentralen Dokumentservice-Plans](../document-write-database-performance-plan.md).

## Verhalten und Grenzen

Der vorhandene Quellenbeobachter wählt weiterhin bei jedem Aufruf die aktuellen
Quellen und prüft Berechtigungen, Identitäten, Bereichszuordnung und Zustand.
Die neue begrenzte Projektion behält ausschließlich Ergebnisse der Zielauflösung.
Ändern sich Quelle oder relevante Zielabhängigkeiten, werden die bestehenden
kanonischen Resolver erneut verwendet. Aktuelle Kanten-IDs, Fragmente, Aliase und
Vorschaudaten werden in jedem Ergebnis aus dem aktuellen Aufruf aufgebaut.

Die Zielprojektion ist insgesamt auf 64 Workspaces, 8 MiB serialisierte Projektionsdaten und 20.000 Links
begrenzt. Sie speichert keine Principals, positiven Rechteentscheidungen, nativen
Positionen, Quellenstages oder Mutationsrezepte. Der vorhandene vollständige
Neuaufbau umgeht sowohl Extraktions- als auch Zielprojektion und überschreibt dabei
den warmen Cache nicht. Schreib- und Publikationsprüfungen bleiben unverändert.

Dieser Schritt spart wiederholte Zielauflösung. Er reduziert weder SQL-Aufrufe
noch das Laden nativer Zustandsbytes. Begrenzte Kopf-/Body-Lesungen, weitere
Bündelung aktueller Fakten, gemeinsame Schreibwege, endgültige Leistungsbudgets
und die übrigen Abnahmen des Gesamtplans bleiben offen. Review Center und Undo
sind außerhalb der Umsetzung. Der Prüflauf verwendet ausgeschaltetes Review Center.

## Messung am echten HTTP-/PostgreSQL-Leser

Die isolierte Fixture durchläuft die Cookie-authentifizierte Route und vergleicht
jede relevante Ausgabe vollständig mit dem Neuaufbau. Alle Messungen, Builds und UI-Abnahmen verwenden den oben genannten
kombinierten Produktstand.

| Beobachtung | Quellen neu aufgelöst | Quellen wiederverwendet | Links neu aufgelöst | SQL / Ausleihen |
| --- | ---: | ---: | ---: | ---: |
| 10 Quellen, warm | 0 | 10 | 0 | 36 / 7 |
| 200 Quellen, warm | 0 | 200 | 0 | 36 / 7 |
| Eine Quelle geändert, 200 Dokumente | 1 | 199 | 2 | 36 / 7 |
| Neues bisher fehlendes Ziel, 201 Dokumente | 201 | 0 | 201 | 36 / 7 |
| Externe physische Änderung, 202 Dokumente | 2 | 200 | 3 | 38 / 7 |
| Vollständiger Vergleichsaufbau, 200 Quellen | 200 | 0 | 200 | 36 / 7 |

Das neue Ziel betrifft hier absichtlich die bisher fehlende gemeinsame Abhängigkeit
aller Quellen; daher ist deren vollständige Neuauflösung erforderlich. Beim
Ausbau von 10 auf 200 Quellen werden zehn bereits vorhandene Quellen übernommen
und 190 neu aufgelöst. Dieser Ausbau ist kein vollständig kalter 200-Quellen-Lauf.
Der erste 10-Quellen-Aufruf benötigt 39 SQL-Aufrufe / zehn Ausleihen. Die warmen
Werte und der jeweils gleiche Neuaufbau zeigen ausdrücklich keinen SQL-Gewinn.

Inaktive und ungültige native Quellen werden weiterhin mit Diagnose ausgelassen;
die übrigen geprüften Quellen bleiben verfügbar. Ein globaler Bereichskonflikt
liefert trotz vorher warmem Cache null Dokumente. Wiederhergestellte Quellen,
physische Änderungen und die warmen Ergebnisse entsprechen dem vollständigen
Neuaufbau.

## Prüfungen

- 102 gezielte Fälle bestehen: Dokumentindex 16, Zielprojektion 13,
  Leseprojektion 7, native Linkauflösung 13 und Quellenbeobachter 53.
- Die echte Route mit PostgreSQL besteht bei 10 und 200 Quellen einschließlich
  Änderungen, fehlender/neuer Ziele, ungültiger nativer Bytes und globalem
  Bereichsfehler. Originalzeilen mit `xmin`, Dateibytes und Speicheranker bleiben
  vor und nach diesen Prüfungen identisch.
- Zwölf zusätzliche Fälle mit kodierten relativen Zielen entsprechen in 48
  Beobachtungen dem Neuaufbau. Dazu gehören Leerzeichen, Prozentzeichen, Unicode,
  kodierte Trennzeichen und absichtlich nicht aufgelöste Query-Ziele.
- Der vollständige Host-Produktionsbuild und das Linux-Image bestehen am exakten
  Produktstand. Das neu erstellte Image startet gesund; 17 betroffene Produktdateien
  stimmen im Container mit den Quellen überein. Alle drei Speicheranker stimmen
  mit den tatsächlichen Verzeichnissen überein. Die elf anderen laufenden
  Container behalten ihre IDs.
- 15 echte Linux-Speicherfälle für den Abschluss der Markdown-Anlage bestehen.
- Die Burst-Messung des Benachrichtigungstests verwendet jetzt Startzeiten der
  Browseranfragen und behält die strenge Ein-Abfrage-Prüfung bei. Drei gezielte
  Wiederholungen, die ganze Benachrichtigungsdatei und der entsprechende Fall im
  aktuellen Gesamtlauf bestehen ohne Browser-Retries. Der natürliche Ursprung
  des früher beobachteten Zusatzrequests ist damit nicht als bewiesen anzusehen.

## Abnahme dieses Teilschritts

Der tatsächliche reguläre `npm run test:all`-Lauf besteht mit 331 erfolgreichen
Browserfällen, null Fehlern und 269 bedingten Skips der unveränderten
Suite-Auswahl. Die gegenüber dem früheren Stand zusätzliche bedingte
HEIF-Prüfung wird im folgenden Abnahmelauf ausdrücklich ausgeführt.

Der zusätzliche Lauf besteht mit allen sieben Recovery-/Linkfällen sowie der
HEIF-Konvertierung und Bildanzeige: acht erfolgreiche Fälle, null Fehler, Flakes,
Retries oder Skips. Die realen Fälle decken unterbrochene Erstverbindungen,
verlorene Create-Antworten und explizite Wiederaufnahme mit derselben UUID,
mobile Speicherwiederholung bei späteren Peer-Änderungen sowie dauerhafte
Linkreparaturen nach Umbenennen und Verschieben ab. Die reguläre Suite prüft
zusätzlich OAuth mit PKCE, Refresh und sofortigem Grant-Widerruf sowie den
aktualisierten Mermaid-/KaTeX-Renderer.

Vor und nach dem vollständigen Lauf bleiben die geschützten Originalzeilen
inklusive `xmin`, ursprüngliche Operationsbelege, native Zustände, Datei- und
Quellbytes sowie Speicheranker exakt gleich. Die abschließenden Snapshots und
Archivprüfsummen wurden zusätzlich unabhängig verglichen. Die elf übrigen
laufenden Container behalten ihre IDs. Beide echten Fixture-Anmeldungen und
ihr abgeschlossener Onboarding-Zustand wurden vorab geprüft; das Review Center
ist in den gespeicherten Settings ausgeschaltet.

Der Auth-Provider protokolliert beim Produktionsbuild eine zurückgestellte
Datenbankinitialisierung, weil dieser Build absichtlich keine Datenbankverbindung
erlaubt. Der gesunde echte Start, beide Anmeldungen und die OAuth-Prüfung
belegen die davon getrennte Laufzeitfunktion. Am geprüften Produktcommit sind
alle sechs GitHub-Prüfungen erfolgreich; vor einem Merge werden die aktuellen
Prüfungen und sämtliche Review-Kommentare erneut kontrolliert.

Damit ist die begrenzte inkrementelle Zielauflösung als Teilschritt geprüft.
Die übrigen Leistungsbudgets, Faktenbündelung, begrenzten nativen Body-Lesungen,
gemeinsamen Schreibwege und abschließenden Produktionsabnahmen des Gesamtplans
bleiben erforderlich. Ein neues Produktionsrelease wird hierdurch nicht behauptet.
