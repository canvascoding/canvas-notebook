# Agentensuche: Argumente und externe ripgrep-Konfiguration

Stand: 15. Oktober 2026. Enger abgeschlossener Sicherheitsbaustein innerhalb YD-08S, auf Basis `4020b3078035c9b50a691448e99cb9f49054b83a`. Kein Abschluss der gesamten Sandbox-/Dokumentabnahme.

## Befund und Korrektur

Das registrierte Legacytool `grep` übergab seinen Suchausdruck ohne Argumentgrenze an den privilegierten `rg`-Prozess. Ein Ausdruck `--pre=<Programm>` wurde als Option interpretiert und konnte einen weiteren Prozess außerhalb der Bash-/Skill-Sandbox starten. `execFile` verhindert Shellinterpolation, aber diese Interpretation durch das aufgerufene Programm nicht.

Zusätzlich konnten die Suchtools `grep`, `rg` und `glob` über `RIPGREP_CONFIG_PATH` zusätzliche Optionen oder Inputpfade erhalten. Die vorgelagerte Prüfung des angefragten Pfads begrenzte solche zusätzlichen Pfade nicht.

Die Korrektur betrifft ausschließlich drei Argumentlisten und ihre erklärenden Kommentare:

- `grep`: `--no-config -n -- <pattern> <target>`.
- `rg`: vor den bestehenden Optionen zusätzlich `--no-config`; die vorhandene `--`-Grenze bleibt bestehen.
- `glob`: `--no-config --files -g <pattern> -- <root>`.

Pfadauflösung, Zugriffsprüfung, Arbeitsverzeichnis, Abbruchsignal, Ausgabe und Fehlerverträge bleiben erhalten. Die Suche in archivierten Toolausgaben war bereits mit `--no-config` und expliziter Musterbindung abgesichert und bleibt unverändert. Abhängigkeiten und Lockdateien ändern sich nicht.

## Tatsächliche Gegenprobe

[`agent-search-process-test.ts`](../scripts/agent-search-process-test.ts) importiert die tatsächlich registrierten Tools, ihre echte Pfadprüfung und unverändertes `execFile`. Das installierte ripgrep wird wirklich gestartet; weder Argumente, Arbeitsverzeichnis, Prozessausführung noch Ausgabe sind ersetzt. Nur der konfigurierte Datenbankimport wird auf eine eigene In-memory-PGlite mit echten Migrationen umgeleitet. Der Test verwendet einen eigenen lesenden ALS-Kontext ohne Schreib-/Löschrechte.

Alle Dateien liegen in einem eigenen privaten temporären Baum. Im Legacy-Gegenfall setzt die Konfiguration einen ausdrücklichen Regex und ausschließlich die eigene Inputdatei; dadurch sind auch beim ursprünglichen `cwd:'/'` sämtliche positionalen Argumente eigene Inputpfade. Eine zusätzliche maximale Tiefe verhindert Rekursion. Die getrennten Konfigurationsfälle der anderen Tools verwenden ebenfalls ausschließlich eigene Dateien. Das harmlose Preprocessorprogramm prüft vor jedem Schreiben Argumentzahl und exakte kanonische Inputidentität; es kann nur das festgelegte synthetische Markdownziel verändern. Input und Ziel werden nach jeder erfolgreichen Gruppe bytegenau geprüft, Kontext und Konfiguration zwischen den Fällen getrennt sowie eigene Datenbank und Dateibaum im `finally` entfernt.

Der finale Test mit SHA256 `7027b2704cc666c605921add3ace9fb8b9cc263fa26918722f27ab074fc2cf2b` wurde unverändert gegen beide Produktstände ausgeführt:

| Lauf | Beobachtung |
| --- | --- |
| Ursprüngliche drei Argumentlisten | Exit 1; sieben Gruppen bestehen, sechs verletzen die Anforderungen. Tatsächliche Markerwrites über Legacy-Option und geladene Konfiguration sowie zusätzliche eigene Fremdpfade bei allen drei Tools sind nachgewiesen. |
| Gehärtete Argumentlisten | Exit 0; alle 13 Gruppen bestehen. Optionsähnliche Muster liefern exakte Suchtreffer, keine Markerwrites oder zusätzlichen Pfade. |

Weitere Fälle prüfen reguläre Regexsuche, keinen Treffer, ungültigen Regex, echte Pfadverweigerung mit exakter Errorantwort, fehlenden Pfad, vorab abgebrochenes Signal sowie Case-/Glob-/Hidden-/Trefferlimitoptionen. Ein erfolgreicher Inhalt mit dem Wort „workspace“ kann nicht als verweigerter Zugriff gezählt werden.

## Integration und Grenzen

- `npm run test:pi:tools`: Exit 0; bestehende vollständige Registryprüfung und anschließend die neue 13er-Suite. Der separate Einstieg heißt `npm run test:pi:search-process`.
- Bestehender `tool-output-search-test.ts`: Exit 0, einschließlich echter `rg`-Toolroute, großer Unicode-Ausgabe, Ergebnisbegrenzung, Isolation und Abbruch.
- Vollständiges `tsc --noEmit --incremental false` mit 8 GiB sowie ESLint für beide Produktmodule und die neue Suite: jeweils Exit 0.
- Unabhängige Quellenprüfung: keine offenen konkreten P1/P2 nach Präzisierung der Pfad-/Abbruchassertions.

Die isolierten Importläufe zeigen bestehende Meldungen über fehlende Auth-/MCP-Basis-URL, Lizenzkontext und Node-localStorage. Diese Meldungen sind kein Nachweis eingerichteter externer Dienste. Es wurde kein konfigurierter PostgreSQL-Server für diese neue Suite geöffnet.

Dies belegt echte Tool-/ripgrep-/OS-Prozessausführung auf macOS, aber noch keine Genuine-Session-/PG-/Yjs-Gegenprobe eines verwalteten Dokuments, keinen Linux-Lauf und keinen laufenden Kindprozess-Drain. Der vorab abgebrochene Fall belegt ausschließlich Vorstartabbruch. Für den vollständigen YD-08S-Abschluss fehlen weiterhin die gemeinsame native Markdown-Mutationsmatrix und der anschließende erfolgreiche zentrale autorisierte Edit über die echten Runtime-/Skillverträge. Die abschließende integrierte Browser-/Neustartabnahme und ein Produktionsrollout werden hier nicht behauptet.
