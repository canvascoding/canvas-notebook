# Dokumentidentität nach Umbenennen, Verschieben und Kopieren

Stand: 26. September 2026. Produktstand `470df8ae8`, ergänzt um
`tests/file-version-center-ordinary-location.spec.ts`. Teil von FVRC-1008;
keine Gesamtfreigabe, kein neuer Produktfix und keine Produktionsaktivierung.

## Prüfumfang und Ergebnis

Der neue Browserfall erstellt mit gewöhnlichen registrierten `read`-/`edit_file`-
Tools einen Root-Vorschlag und ein abhängiges Child. Der Root ändert Kosten
10 → 12 EUR; das Child ändert auf dieser Basis Lieferzeit 5 → 3 Tage. Bis zur
expliziten UI-Annahme bleibt der aktuelle Dokumentinhalt unverändert.

Der Test führt folgende Schritte mit echten authentifizierten APIs aus:

1. Einen Link auf die ursprüngliche Lineage und die konkrete Child-Operation
   **vor** der ersten Pfadänderung erzeugen und im Review-Center öffnen.
2. Datei umbenennen und anschließend in einen eigenen UUID-Ordner verschieben.
   Nach jedem Schritt bleiben Dokument-ID, Lineage, Generation, Schema,
   Graphrevision, Operations-IDs und Inhaltsrevisionen unverändert. Der Resolver
   liefert den neuen Pfad sowohl für Dokument- als auch für Lineage-Ziele;
   der Vergleich bleibt `clean`, beide Voraussetzungen bleiben annehmbar.
3. Am alten Pfad eine neue Datei erstellen; zusätzlich den verschobenen Inhalt
   innerhalb desselben und in den jeweils anderen Workspace kopieren.
   Die Kopien haben absichtlich denselben Inhalt wie das Original vor Annahme.
4. Für alle drei Dateien eigene Collaboration-Sessions eröffnen: vier getrennte
   Lineages und vom Original verschiedene Dokument-IDs, keine geerbten
   Agentenoperationen. Der Versuch, dort die ursprüngliche Child-Operation zu
   lesen, liefert `404 / PROPOSAL_SOURCE_INVALID`. Eine für das Original
   vorbereitete Annahme liefert `400 / PROPOSAL_SCOPE_MISMATCH`.
5. Jede getrennte Datei im globalen Review-Center öffnen: leere Review-Liste,
   keine Graph-Vorschau und kein Annahme-Button. Den unveränderten alten Link
   erneut öffnen: neuer Pfad, dasselbe Child, sichtbare Root-Abhängigkeit und
   echter gemeinsamer Diff statt eines Timeline-Fehlers.
6. Child im UI annehmen und bestätigen. Exakt ein Browser-POST, Root `included`,
   Child `applied`, genau eine Inhaltsrevision. Endtext vollständig und exakt:

   ```md
   # Versand

   Kosten: 12 EUR

   Lieferzeit: 3 Tage
   ```

   Alle drei ursprünglichen Block-IDs und ihre Reihenfolge bleiben erhalten.
   Identischer Aktions-Retry liefert denselben Beleg ohne zweite Revision.
   Die getrennten Dateien behalten ihre Inhalte, Revisionen und leeren
   Review-Listen; die historische Child-Auswahl bietet keine neue Aktion.

Nur die eigenen UUID-Dateien, der eigene Ordner und die synthetische Agent-
Session werden über APIs entfernt. Vor der gemeinsamen Fixture-Bereinigung
wird das Original an seinen ursprünglichen Pfad zurückverschoben. Kein
Workspace-, Fixture- oder Datenbank-Reset.

## Laufnachweise

Ein einziger verwalteter Stack, PostgreSQL **18.4 / pgvector 0.8.3** auf 55433.
Aktueller Host-Dev auf **127.0.0.1:3000**, Prozess-CWD auf dem Implementierungs-
Worktree geprüft. Der vorhandene Notebook-Container auf **3100** ist weiterhin
das ältere Image und zählt nicht als Nachweis für diesen Quellstand.

- `location-personal-r1`: fehlgeschlagen am falschen englischen UI-Testselektor;
  kein bestandener End-to-End-Lauf. Umbenennen/Verschieben und die ersten
  Isolationsprüfungen waren bis dahin erfolgreich. Der Selektor wurde an den
  bestehenden Text „No agent changes need review.“ angepasst, nicht die App.
- `location-personal-r2`: bestanden, **26,4 s**. Vollständiger Merge und drei
  Isolationsfälle. Der Bericht wurde zusätzlich auf feste Endbytes, exakte
  Resolution-IDs, vier Lineages, drei Block-IDs, einen POST und +1 Revision
  geprüft; die Vorschau wurde visuell kontrolliert.
- `location-team-r1`: bestanden, **28,9 s**, einschließlich der zusätzlichen
  Wiederverwendung des schon vor dem Umbenennen geöffneten Links.
- `location-personal-r3`: finaler Personal-Wiederholungslauf auf demselben
  endgültigen Teststand wie Team, bestanden, **32,8 s**. Die JSON-Belege beider
  finaler Reports wurden zusätzlich aus den HTML-Archiven gelesen und auf
  festes Endergebnis, exakte Resolution-IDs, +1 Revision, drei Block-IDs, vier
  getrennte Lineages, einen POST und den Original-Link geprüft. Beide finalen
  Vorschauen wurden visuell geprüft. Keine beobachteten Review-429-/5xx-Antworten.

Berichte: `/tmp/fvrc1008-<Laufname>-report/index.html`, Logs entsprechend
`/tmp/fvrc1008-<Laufname>.log`. Die Browserläufe sind seriell, ein Worker,
mindestens 55 Sekunden Abstand zwischen den Fällen. Anwendungsantworten werden
nicht simuliert. Die Tools laufen ohne LLM über den vorhandenen Child-Prozess-
Treiber; kein neuer Same-Process-Launcher ist für reine Vorschläge erforderlich.

Ergänzend besteht `scripts/file-version-target-lifecycle-test.ts` auf isoliertem
PGlite, nicht auf der verwalteten Produktionsdatenbank. Der erste Lauf bestand
mit einer Auth-Konfigurationswarnung; der Wiederholungslauf mit expliziter
lokaler Base-URL besteht ohne diese Warnung
(`/tmp/fvrc1008-location-query-r2.log`). Er ersetzt nicht den oben genannten
realen PostgreSQL-/Browsernachweis. Gezielter ESLint, vollständiges TypeScript
ohne inkrementellen Cache und `git diff --check` bestehen;
Logs: `/tmp/fvrc1008-location-{lint,typecheck}-r2.log`.
Alle vier Stackdienste bleiben gesund (`/tmp/fvrc1008-location-stack-final.log`).
Der unabhängige Quellreview fand keinen konkreten Orakel-/Cleanup-Fehler.

SHA-256 des unverändert ausgeführten endgültigen Browserspecs:
`acc67973a8ce90bc5d564518b579f8ac71fb842be08ff24b7d583c0237ee28ed`.

GitNexus nach vollständiger Neuindexierung: staged vier Dateien, 27 Symbole,
keine betroffenen Produktprozesse, niedriges Risiko. Der gesamte Vergleich zum
lokalen `main` bleibt mit 187 Dateien, 1440 Symbolen und 27 Prozessen kritisch;
dieser Testcommit ist keine Freigabe der vorherigen Merge-/Berechtigungsänderungen.
Generierte Indexzählungen in `AGENTS.md` und `CLAUDE.md` bleiben uncommitted.

## Grenzen

- PG-S27 ist für den authentifizierten Datei-API-Pfad mit gewöhnlichen
  abhängigen Vorschlägen in Personal und Team abgedeckt. Dies testet nicht den
  separaten Agenten-Dateioperationstoolpfad `move_path`.
- MR-17 bleibt teilweise offen: Delete/Recreate des **ursprünglichen** Dokuments
  mit bereits vorhandenen Vorschlägen ist ein eigener Lebenszyklusfall. Eine
  neue Datei am früheren Pfad nach Move ist nicht derselbe Fall.
- Kein neuer Browsernachweis für eine gleichzeitig laufende Rename-/Apply-
  Operation, Ordner-Rename, Overwrite oder Crash-/Recovery-Grenzen.
- Kein neuer Produktionsbuild nötig für diese reine Test-/Dokumentations-
  Ergänzung. Der letzte erfolgreiche unveränderte Produktbuild steht in
  `ordinary-toggle-results.md`. Zwei vollständige Gesamtmatrixläufe, frisches
  Produktionsimage und P12 bleiben offen; FVRC-1008 bleibt `in_progress`.

## Wiederholung

Mit bereits vorbereitetem Skill-Stack und aktuellem normalem Host-Dev (kein
zweiter App-Server; keine private Env-Datei ändern):

```sh
NODE_ENV=development E2E_EXTERNAL_SERVER=1 COLLABORATION_E2E=1 \
CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1 BASE_URL=http://127.0.0.1:3000 \
PLAYWRIGHT_HTML_OPEN=never PLAYWRIGHT_HTML_OUTPUT_DIR=/tmp/fvrc1008-location-personal-report \
node --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env \
  --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/fixtures.env \
  node_modules/@playwright/test/cli.js test tests/file-version-center-ordinary-location.spec.ts \
  --grep personal --workers=1 --reporter=line,html
```

Danach mindestens 55 Sekunden Abstand; `--grep team` und ein separates
Reportverzeichnis verwenden. Es wurden keine Container gebaut und nichts gepusht.
