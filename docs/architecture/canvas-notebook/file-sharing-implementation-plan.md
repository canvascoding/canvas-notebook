# Dateifreigaben und Markdown-Gastzugriff

Ausgangsstand: `84c240543c2f661d21819eca0ab0ee1c9db096f7`.
Branch: `codex/file-sharing-and-markdown-guests`.

## Verbindlicher Umfang und Reihenfolge

Jeder Schritt wird implementiert, mit den angegebenen Nachweisen geprüft und
einzeln committed, bevor der nächste beginnt. Öffentliche Leselinks bleiben
standardmäßig schreibgeschützt. Eingeladene Gäste erhalten Zugriff auf eine
konkrete Markdown-Datei, ohne dadurch Mitglieder des gesamten Workspace zu werden.

- [x] 0. Befunde, Verhalten und Abnahme dokumentieren; Arbeitsbranch erstellen.
- [x] 1. Bestehende Sicherheits- und Auslieferungsfehler beheben.
  - Nur tatsächlich eingebettete Markdown-Bilder öffentlich ausliefern; Code,
    Kommentare, escaped Syntax und nicht verwendete Referenzen ausschließen.
  - Fremde Freigaben nur mit Verwaltungsrecht verändern; Web, Mobile und Agent
    verwenden dieselben Regeln.
  - Eigene HTML-Vorschau bei erhaltener Sandbox zulassen.
  - Unicode-Dateinamen und gültige Byte-Ranges zuverlässig ausliefern.
  - Nachweis: negative Asset-Routentests, Rechte-Matrix, Header-/Range-Tests.
- [ ] 2. Freigabe-Lebenszyklus und konkurrierende Anfragen absichern.
  - Explizites Aktualisieren von Ablaufdatum und Sicherheitsmodus, inklusive
    Entfernen des Ablaufdatums; ungültige Eingaben ablehnen.
  - Erstellen, Kurzcode-Vergabe, Zugriffszähler und Widerruf atomar absichern.
  - Temporäre Dateifehler von Widerruf/Löschen unterscheiden; eine andere Datei
    darf nicht unbeabsichtigt über einen alten Link veröffentlicht werden.
  - Cache-Verhalten mit Widerruf abstimmen und vor Ausgabe den aktuellen
    Speicherstand der kollaborativen Datei berücksichtigen.
  - Nachweis: Parallelität, Wiederholung, Ablauf, Wiederherstellung, Ersetzen,
    Verschieben und Widerruf auf SQLite und dem Postgres-Testadapter.
- [ ] 3. Laufende Markdown-Kollaboration bei Rechteentzug absichern.
  - Aktuelle Sitzung, Dateiidentität und Rechte auch nach Verbindungsaufbau
    berücksichtigen; widerrufene Teilnehmer zeitnah trennen.
  - Bestehende Schutzmechanismen für Lebenszyklus, Reconnect, Checkpoints und
    Agentbearbeitung erhalten.
  - Nachweis: Entzug von Lesen/Schreiben, Logout, parallele Updates und Reconnect.
- [ ] 4. Dateibezogenen Markdown-Gastzugriff implementieren.
  - Verwaltbare Einladungen mit Lesen/Bearbeiten und optionalem Ablauf.
  - Identität des eingeladenen Gasts prüfen; Berechtigung nur für diese Datei
    und ihre ausdrücklich benötigten Assets, ohne Workspace- oder Agentzugriff.
  - Bestehenden Yjs-/Hocuspocus-Editor verwenden; Widerruf gilt auch für bereits
    offene Gastsitzungen. Versionsverlauf und Wiederherstellung integrieren.
  - Nachweis: zwei Teilnehmer bearbeiten dasselbe Dokument; Fremddateien,
    manipulierte Tickets, abgelaufene und widerrufene Einladungen bleiben gesperrt.
- [ ] 5. Teilen aus User-Perspektive integrieren.
  - Gemeinsamer Einstieg für Link teilen, Personen einladen und Exportieren.
  - Rechte, Ablauf, veröffentlichte Assets und Auswirkungen von Umbenennen/
    Verschieben anzeigen; bestehende Einstellungen korrekt vorbelegen.
  - Veraltete Ladeantworten bei Workspace-/Dateiwechsel ignorieren; Fehler,
    Teilfehler, Speichern, Offlinezustand und Widerruf verständlich anzeigen.
  - Gastansicht, interne Ansicht und öffentliche Lesevorschau berücksichtigen.
  - Nachweis: UI-Prüfung einschließlich schmalem Viewport, Tastaturbedienung und
    der Zustände Erstellen, Ändern, Widerrufen und Wiederholen.
- [ ] 6. Gesamtprüfung und Push.
  - Produktionsbuild, relevante Regressionstests und Ende-zu-Ende-Prüfung mit
    zwei Nutzern: gleichzeitiges Schreiben, Verbindungsabbruch, Rechteentzug,
    Ablauf, Umbenennen und Teilen unmittelbar nach einer Änderung.
  - Routen-Matrix für Web/Mobile, Vorschau, Download, Assets, Exporte und
    Kollaborationszugriff dokumentieren; unerwartete Änderungen ausschließen.
  - Saubere Commit-Historie und Arbeitsbaum prüfen; Branch pushen und Remote-SHA
    mit dem lokal geprüften Commit abgleichen.

## Ausführungsregeln

GitNexus-Impact vor Symboländerungen und `detect_changes` vor jedem Commit.
Kein Containerbau ohne ausdrückliche Freigabe. Lokale Laufzeit nur über den
Skill `canvas-local-team-seat-dev`; niemals parallele Test-Stacks. Browserprüfung
gemäß der ausdrücklichen Playwright-/Browserfreigabe in `AGENTS.md`.
Tests verwenden synthetische Konten; keine Einladungen an reale Personen senden.

## Nachweise

Die konkret ausgeführten Tests und verbleibenden offenen Abnahmepunkte werden
hier nach jedem abgeschlossenen Schritt ergänzt. Eine grüne Teilprüfung ersetzt
nicht die Gesamtprüfung einschließlich Gastbearbeitung und UI.

### Schritt 1

Markdown- und HTML-Bilder werden aus Syntaxbäumen gesammelt und an denselben
Quellpositionen umgeschrieben. Code, Kommentare, unbenutzte Definitionen und
Frontmatter autorisieren keine Assets. Der gemeinsame Obsidian-Scanner erhält
UTF-16-Offsets auch bei Emoji. HTML-Sandboxen erlauben die eigene Vorschauseite.
Datei- und PDF-Downloads verwenden einen gemeinsamen Unicode-fähigen Header.
Änderungen fremder Sicherheitsmodi prüfen die Verwaltungsberechtigung.

Erfolgreich: `test:public-share:security`, `test:public-share:workspace`,
`test:public-share:route-access`, `scripts/obsidian-flavored-markdown-test.ts`,
`scripts/markdown-core-test.ts`, `scripts/file-live-collaboration-test.ts`,
TypeScript-Prüfung, ESLint für geänderte Dateien und `test:licenses`.
Die Asset-Routentests prüfen explizit HTTP 404 für ansonsten vorhandene,
nur in Code/Kommentaren erwähnte Bilder. Rechte-Tests erlauben den Manager und
verweigern dem Projektleser die Änderung eines fremden Links.
Die tatsächliche Browser-Einbettung und der PDF-Renderer bleiben Bestandteil
der abschließenden UI-/Ende-zu-Ende-Abnahme.
