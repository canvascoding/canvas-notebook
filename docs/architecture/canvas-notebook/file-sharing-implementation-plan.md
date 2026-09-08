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
- [x] 2. Freigabe-Lebenszyklus und konkurrierende Anfragen absichern.
  - Explizites Aktualisieren von Ablaufdatum und Sicherheitsmodus, inklusive
    Entfernen des Ablaufdatums; ungültige Eingaben ablehnen.
  - Erstellen, Kurzcode-Vergabe, Zugriffszähler und Widerruf atomar absichern.
  - Temporäre Dateifehler von Widerruf/Löschen unterscheiden; eine andere Datei
    darf nicht unbeabsichtigt über einen alten Link veröffentlicht werden.
  - Cache-Verhalten mit Widerruf abstimmen und vor Ausgabe den aktuellen
    Speicherstand der kollaborativen Datei berücksichtigen.
  - Nachweis: Parallelität, Wiederholung, Ablauf, Wiederherstellung, Ersetzen,
    Verschieben und Widerruf auf SQLite und dem Postgres-Testadapter.
- [x] 3. Laufende Markdown-Kollaboration bei Rechteentzug absichern.
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

### Schritt 2

Web und Mobile unterstützen `PATCH /api/security/public-shares/:id` mit
`policyRevision`; veraltete Änderungen erhalten 409. Nicht mitgesendete Werte
bleiben erhalten, `expiresAt: null` entfernt den Ablauf. Wiederholtes Erstellen
aktualisiert ausdrücklich angegebene Werte. Eingaben werden validiert.

Ein gemeinsamer Migrationsschritt erzwingt einen aktiven Link je Workspace/Pfad
auf SQLite und PostgreSQL; bei bestehenden Duplikaten bleibt der älteste Link
erhalten, weitere werden widerrufen. Kurzcode-Vergabe und Zugriffszähler verwenden
atomare Datenbankoperationen. HEAD zählt nicht als Zugriff.
Temporär fehlende Dateien können mit ihrer ursprünglichen Identität zurückkehren.
Ersetzen bindet einen Link nur über autorisierte Schreib-Hooks neu; neues
Veröffentlichen nach Ablauf/Widerruf erzeugt einen neuen Token. Neue Dateiidentitäten
berücksichtigen Geräte-, Inode- und Erstellungszeit; ältere Identitäten bleiben
kompatibel. Inaktive Workspaces liefern keine Freigaben aus.

Textvorschau, Markdown-/Textdownload, Bildfreigabe und Export lesen den aktuellen
Yjs-Stand, auch vor dem nächsten Checkpoint. Der HTML-Exportcache verwendet dafür
einen Inhalts-Hash. Downloads prüfen geöffnete Dateideskriptoren gegen die
erwartete Identität. HTTP-Antworten werden nicht gespeichert; nach langen
Exportarbeiten wird die Freigabe erneut geprüft. Öffentliche Render-Routen
haben gemeinsame Budgets pro Prozess (10 PDF- bzw. 30 HTML-/Marp-Anfragen pro
Minute), die sich nicht durch erfundene Sitzungscookies umgehen lassen.

Erfolgreich: `test:public-share:lifecycle` (SQLite und PGlite über den tatsächlichen
Drizzle-Adapter), `test:public-share:workspace`, `test:public-share:security`,
`test:public-share:route-access`, TypeScript und ESLint. Die Tests decken 24
parallele Erstellungen, 32 parallele Zählererhöhungen, konkurrierende
Einstellungsänderungen/Widerrufe, Migration von Duplikaten, Dateiwechsel,
temporäres Fehlen, Ablauf, Web-/Mobile-Policy-Routen und aktuelle Yjs-Inhalte ab.
Zusätzlich erfolgreich: Frontmatter-, LaTeX- und Rich-Block-Exportregressionen.
Der vorhandene Rich-Block-Test hat dabei unbeabsichtigt intern Chromium gestartet;
der Lauf ist beendet und der Nutzer wurde informiert. Dies ersetzt keine
freigegebene UI-/Ende-zu-Ende-Prüfung mit mehreren Nutzern.

### Schritt 3

Die Sitzung wird gegen die aktuelle Auth-Datenbank geprüft, einschließlich
Benutzerbindung, Logout, Ablauf und Kontosperre. Die Workspace-Rechte werden
über denselben Berechtigungsresolver erneut gelesen, ohne bei jeder Nachricht
das Konto-Bootstrap auszuführen. Dokumentpfad, Generation, Repräsentation und
Schema müssen weiterhin zum Ticket passen. Die kurze Ticketlaufzeit begrenzt
den Beitritt; eine aktive Verbindung richtet sich nach der echten Sitzung.

Vor jeder eingehenden Hocuspocus-Nachricht erfolgt diese Prüfung. Ein Monitor
prüft außerdem einmal pro Sekunde offene Verbindungen und trennt dadurch auch
inaktive Leser. Parallele Prüfungen derselben Verbindung teilen nur ihre aktuell
laufende Arbeit; nach Trennung darf keine wartende Prüfung Schreibzugriff
freigeben. Bereits zuvor angenommene Änderungen werden weiterhin gespeichert.

Bei Ablehnung trennt sich der Client, setzt die Sitzung auf Lesen und behält
seinen lokalen Wiederherstellungsstand. Verspätete Status-/Synchronisations-
Ereignisse können den Zustand `denied` nicht wieder aufheben.

Erfolgreich: `test:collaboration:access`,
`scripts/code-editor-collaboration-lifecycle-test.ts`,
`scripts/file-live-collaboration-test.ts`, TypeScript und ESLint.
Die PGlite-Prüfung verwendet die tatsächlichen Session-, Workspace- und
Dokumentresolver. Sie prüft Rechteentzug, Sessionlöschung/-ablauf, Kontosperre,
falsche Dokumentgeneration sowie wartende Nachrichten und lokale Änderungen.
Die UI-/WebSocket-Abnahme mit zwei Browsern bleibt Teil von Schritt 6.
