# Gewöhnliche Rich-Markdown-Merges: Reihenfolge und Sammelannahme

Stand: 26. September 2026. Alle zwölf abschließenden seriellen Browserläufe
bestanden. Dies ist ein Teilnachweis für FVRC-1008, keine Produktionsfreigabe.

## Umgebung und unveränderte Produktbasis

- Produktcode: `542c99dc2`, aktueller Worktree auf `http://127.0.0.1:3000`.
- Echtes PostgreSQL 18.4/pgvector 0.8.3 des einzigen verwalteten lokalen Team-Seat-Stacks;
  authentifizierte Personal- und Team-Workspaces, jeweils Administrator.
- Das ältere Container-Image auf Port 3100 ist **kein** Nachweis für diesen Stand.
  Kein Container, keine Dependency und keine Runtime-Env-Datei wurde geändert.
- Jede Ausführung erstellt und entfernt ausschließlich ihre UUID-Datei und
  zugehörige Agentensitzung über reguläre authentifizierte APIs. Das bestehende
  Fixture prüft den standardmäßig ausgeschalteten Review-Modus und aktiviert
  ihn explizit über den Editor-Toggle.
- Vorschläge entstehen durch das registrierte Agentenwerkzeug `edit_file`,
  nicht durch direkt eingespielte Graphknoten. Kein LLM wird benötigt. Der
  gemeinsame Helper `tests/helpers/ordinary-agent-tool.ts` kapselt nur den
  vorhandenen Tool-Subprozess und redigiert dessen fehlerhafte Kommandoausgaben.

## Feste Orakel

`file-version-center-ordinary-tools.spec.ts` prüft das Versand-Fixture aus
PG-S01. Beide unabhängigen Vorschläge entstehen auf demselben unveränderten
Ausgangsdokument. P1 ändert Kosten von 10 auf 12 EUR und fügt einen Absatz
`Deckung: 100 EUR` ein. Q ändert die Lieferzeit von 5 auf 3 Tage. Geprüft werden
P1→Q, Q→P1 und die gemeinsame Annahme, jeweils in Personal und Team.

Der Test verlangt ausdrücklich `tiptap_blocks` und liest die echte
`live_yjs`-Struktur. Nach jedem Schritt prüft er den vollständigen festen
Markdown-Zieltext, Reihenfolge und Identitäten aller ursprünglichen Blöcke
sowie die Identität des neuen Versicherungsabsatzes. Der zweite Vergleich
enthält nur den noch offenen Effekt. Die Einzelannahmen erzeugen genau zwei
Revisionen, die Sammelannahme genau eine. Unbeteiligte Inhalte bleiben erhalten.

`file-version-center-ordinary-block-tools.spec.ts` prüft CR-03/MR-06 über den
expliziten Block-Werkzeugpfad. Aus `P1=100 Q1=200` im selben Absatz entstehen
zwei unabhängige `edit_file`-Vorschläge mit identischer `document`-/`blockId`-
Referenz. Das Ergebnis muss `P1=130 Q1=230` sein, in beiden Reihenfolgen und
als Batch. Überschrift und Absatz behalten ihre IDs. Auch hier werden
Zwischenstände, aktuelle Rest-Diffs, exakte IDs der angenommenen Vorschläge,
Revisionszahlen, Aktionsbelege und die tatsächliche Anzahl der Aktions-POSTs
geprüft, nicht bloß ein erfolgreicher HTTP-Status.

Nach der letzten Annahme muss die Oberfläche eine leere Review-Liste und die
ausgewählte aktuelle Version zeigen. Die erste Versand-Ausführung hatte alle
Merge-/Inhaltsprüfungen bestanden, scheiterte jedoch an der falschen letzten
Test-Erwartung, dass noch das Review-Panel sichtbar sein müsse. Diese Erwartung
wurde anhand des tatsächlichen Abschlusszustands korrigiert; kein Produktcode
wurde dafür verändert. Danach bestanden alle sechs Versand-Fälle, bevor die
expliziten Block-ID-Prüfungen ergänzt wurden.

## Abschließende Läufe

Alle Läufe verwenden einen Worker, laufen nacheinander und halten Abstand zur
Vermeidung künstlicher Rate-Limit-Interferenzen. Das Fixture meldet beobachtete
429-/5xx-Antworten als Fehler. Die HTML-Reports enthalten redigierte JSON-Belege
und Screenshots; Zugangsdaten und Tool-Ausführungskontexte sind ausgeschlossen.

| Test | Personal | Team | Revisionsdifferenz |
|---|---|---|---|
| Versand P1→Q | bestanden, 22,5 s | bestanden, 22,5 s | +2 |
| Versand Q→P1 | bestanden, 25,2 s | bestanden, 21,8 s | +2 |
| Versand gemeinsam | bestanden, 17,8 s | bestanden, 17,7 s | +1 |
| Derselbe Absatz P1→Q | bestanden, 26,6 s | bestanden, 26,7 s | +2 |
| Derselbe Absatz Q→P1 | bestanden, 26,7 s | bestanden, 26,0 s | +2 |
| Derselbe Absatz gemeinsam | bestanden, 22,2 s | bestanden, 22,2 s | +1 |

Versand-Reports: `/tmp/fvrc1008-shipping-{personal|team}-{p1-q|q-p1|batch}-final-report/index.html`.
Die zugehörigen `.log`-Dateien und `-artifacts`-Verzeichnisse verwenden denselben
Präfix. Block-Werkzeug-Reports:
`/tmp/fvrc1008-block-tools-{personal|team}-{p1-q|q-p1|batch}-final-report/index.html`.

TypeScript und fokussiertes ESLint bestehen:
`/tmp/fvrc1008-rich-order-typecheck-final.log` und
`/tmp/fvrc1008-rich-order-lint-final.log`.
Kein beobachteter 429-/5xx-Fehler und kein übersprungener Fall. Repräsentative
Abschluss-Screenshots für Personal/Team und Einzel-/Sammelannahme wurden
zusätzlich visuell geprüft. Alle zwölf JSON-Belege bestätigen `tiptap_blocks`,
die Soll-Revisionsdifferenz und die Zahl der tatsächlichen Aktions-POSTs.

Der Testquellstand ist durch SHA-256 von `git diff --cached -- tests` gegen
`542c99dc2` gebunden:
`852ed8b565ae513f7ebc255c7f6c7f309ea9ca3de3b7802dbb82d3a0338d2016`.
Ein unabhängiger Quell-Review fand keine weiteren konkreten Mängel. Die
Batchvorschau wird auf beide Effekte geprüft; der gesamte Endtext und die
Blockstruktur werden danach exakt geprüft. GitNexus bestätigt für den neuen
Test-/Dokumentationsumfang niedrigen Einfluss ohne betroffenen Produktprozess.
Der gesamte Branchvergleich zu lokalem `main` bleibt kritisch (162 Dateien,
1158 Symbole, 27 Prozesse beim Quellstand-Check); daraus wird keine Freigabe
abgeleitet. Die generierten Änderungen an `AGENTS.md` und `CLAUDE.md` bleiben
außerhalb dieses Commits. Ein erneuter Produktbuild wurde für diese reinen
Test-/Dokumentationsänderungen nicht durchgeführt; der Build der unveränderten
Produktbasis ist in `hardening-progress.md` protokolliert.

## Abgrenzung

Diese Fälle beweisen weder eine manuelle Auflösung echter überlappender
Konflikte noch den vollständigen FVRC-1008-Gate. Insbesondere fehlen weiterhin
die zwei vollständigen Matrixläufe, der aktualisierte Produktionscontainer,
vollständige Crash-/Rollback-/Restore-Übergänge und Zwei-App-Prozess-Rennen.
P12 bleibt getrennt. Keine Produktivaktivierung, kein Push.
