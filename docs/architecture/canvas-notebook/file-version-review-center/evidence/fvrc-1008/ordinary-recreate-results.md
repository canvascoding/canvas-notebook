# Dokumentidentität nach Löschen und Neuanlegen

Stand: 26. September 2026. Ausgangscommit `2003c3625`, ergänzt um den
Wiederherstellungs-Hinweis in `DashboardShell` und
`tests/file-version-center-ordinary-recreate.spec.ts`. Teil von FVRC-1008;
keine Gesamtfreigabe und keine Produktionsaktivierung.

## Gefundener Fehler und begrenzte Korrektur

Ein gespeicherter Tab bindet einen Pfad an seine bestätigte Collaboration-ID.
Nach Löschen und Neuanlegen am gleichen Pfad ist diese ID nicht mehr aktiv.
Die Dateiöffnung hat das korrekt abgelehnt, URL-Aufruf und automatische
Tab-Wiederherstellung haben das Ergebnis jedoch ignoriert. Sichtbar blieben
ein alter Tab und ein leerer Editor ohne Erklärung.

`openNotebookEntry` zeigt nun den vorhandenen Fehler-Toast. Für ein fehlendes
Dokument lautet die deutsche Meldung: „Das verknüpfte Dokument ist nicht mehr
verfügbar. Wähle die aktuelle Datei im Dateibrowser aus.“ URL-Aufruf,
gespeicherter aktiver Tab und Workspace-Wiederherstellung nutzen dieselbe
Behandlung. Überholte Anfragen, Unmount und Workspace-Wechsel bleiben still.

**Kein Identitäts-Fallback:** Die bestehende Dateiöffnung, ID-Prüfung und
Review-Autorisierung bleiben unverändert. Erst eine ausdrückliche Auswahl im
Dateibrowser öffnet die aktuelle Datei am Pfad und aktualisiert die Tab-ID.
Ein alter Tab/Link darf nach einem Verschieben oder Löschen nicht unbemerkt
zu einem anderen Dokument werden.

## Browserablauf und feste Orakel

Der identische Fall läuft in Personal und Team auf echtem PostgreSQL mit
gewöhnlichen registrierten `read`-/`edit_file`-Tools, ohne LLM und ohne
simulierte Anwendungsantworten:

1. Markdown mit drei Blöcken anlegen, Review einschalten; Root-Vorschlag
   Kosten 10 → 12 EUR und abhängiges Child Lieferzeit 5 → 3 Tage erzeugen.
   Child über den ursprünglichen Lineage-/Operations-Link als annehmbar öffnen.
2. Original über die authentifizierte Datei-API in den Papierkorb verschieben.
   **Denselben Pfad und exakt dieselben ursprünglichen Bytes** neu hochladen.
3. URL mit gespeichertem alten Tab öffnen: Hinweis sichtbar, kein offener
   Ersatz-Editor/Review-Toggle. Danach bewusst die Datei im Baum auswählen.
4. Neue Dokument-ID, neue Lineage und neue Block-IDs nachweisen. Review ist
   wieder standardmäßig aus (`safe_direct`, Revision 0), keine geerbten
   Agentenoperationen, genau eine neue initiale Inhaltsrevision.
5. Alte Dokument-/Lineage-Ziele liefern `404 / FVRC_NOT_FOUND`. Eine alte
   vorbereitete Annahme gegen das neue Dokument liefert
   `400 / PROPOSAL_SCOPE_MISMATCH`, die alte Operation im neuen Dokument
   `404 / PROPOSAL_SOURCE_INVALID`. Diese Prüfungen laufen sowohl vor als
   auch nach dem späteren Merge. Der alte Review-Link zeigt den Archivfehler,
   keine Graph-Vorschau und keinen Annahme-Button.
6. Neue leere Review-Liste öffnen, Review im neuen Editor einschalten und
   einen **neuen** Root Kosten 10 → 14 EUR mit Child Lieferzeit 5 → 2 Tage
   erzeugen. Vier verschiedene Vorschlags-IDs, keine wiederverwendete alte
   Block-ID. Die Child-Vorschau zeigt exakt eine nötige Voraussetzung.
7. Child im UI annehmen und bestätigen: genau ein Browser-Aktions-POST,
   neuer Root `included`, neues Child `applied`, genau +1 Inhaltsrevision.
   Endinhalt vollständig und exakt:

   ```md
   # Versand

   Kosten: 14 EUR

   Lieferzeit: 2 Tage
   ```

   Die drei neuen Block-IDs bleiben erhalten. Ein identischer Retry liefert
   denselben Beleg ohne weitere Revision; die historische Child-Auswahl hat
   keine neuen Aktionen. Alte Freigaben verändern auch diesen Endstand nicht.

Die Bereinigung betrifft ausschließlich die eigene UUID-Datei und synthetische
Agentensession. Original und neu angelegte Datei liegen danach als zwei getrennte
Einträge im Papierkorb bis zum normalen Ablauf; kein endgültiges Löschen,
kein Workspace-/Fixture-/Datenbank-Reset.

## Laufnachweise

Ein verwalteter Stack, PostgreSQL **18.4 / pgvector 0.8.3** auf 55433. Aktueller
Quellstand am Host-Dev **127.0.0.1:3000**. Der bestehende Container auf **3100**
ist weiterhin ein älteres Image und kein Nachweis für diesen Fix.

- `recreate-personal-r1`: fehlgeschlagen am fehlenden Editor nach korrekter
  Ablehnung der alten ID. Dieser Lauf deckte den verschluckten Fehler auf und
  zählt nicht als bestandener E2E-Test. Der Test wurde um die ausdrückliche
  Dateibaum-Auswahl ergänzt; die Identitäts- und Merge-Orakel bleiben streng.
- `recreate-personal-r2`: bestanden, **41,7 s**.
- `recreate-team-r1`: bestanden, **41,6 s**.
- `recreate-location-regression-r1`: vorhandener Personal-Rename-/Move-/Kopien-
  Fall mit dem neuen Produktcode erneut bestanden, **30,6 s**.

Die erfolgreichen Fälle liefen seriell mit einem Worker und mindestens
55 Sekunden Abstand. Der Fehlerkollektor beobachtete keine Review-429-/5xx-
Antworten. Beide JSON-Belege wurden zusätzlich aus den HTML-Reports gelesen
und auf feste Endbytes, getrennte IDs, Standardpolicy, exakte Resolutions,
einen POST und +1 Revision geprüft. Hinweis, Archivfehler und neue gemeinsame
Vorschau wurden visuell kontrolliert.

Reports: `/tmp/fvrc1008-<Laufname>-report/index.html`; Logs entsprechend
`/tmp/fvrc1008-<Laufname>.log`. Die bestehenden Suiten
`test:notebook:open-identity`, `test:notebook:races` und `test:notebook:tabs`
bestehen (`/tmp/fvrc1008-recreate-{open-identity,races,tabs}-r1.log`).
`test:notebook:location-lifecycle` besteht mit echtem `DashboardShell` unter
StrictMode und simuliertem Netzwerk: alte ID bei URL-/Saved-Tab-Aufruf bleibt
gespeichert, kein Ersatz wird automatisch geladen, explizite Auswahl aktualisiert
die ID, verspätete alte 404 erzeugt danach weder Toast noch Rücksetzung.
Die echte Dateibaum-Auswahl ist separat in beiden E2E-Fällen geprüft.

Ein Zwischenstand des Komponententests hatte einen Typ-/Lintfehler und hielt
nach bereits erfolgreichen Assertions Query-GC-Timer offen. Dieser Lauf zählt
nicht als Erfolg. Die Timer wurden mit `async_hooks` dem Query-Cache zugeordnet;
der Test räumt nun nach Unmount den Cache auf und prüft zusätzlich, dass alle
Watcher freigegeben sind. Kein erzwungener Prozess-Exit und kein Produkt-
Timeout wurden ergänzt. Die vollständige Lifecycle-Suite endet sauber
(`/tmp/fvrc1008-recreate-location-lifecycle-r2.log`).

Der finale Produktbuild besteht mit **353 Seiten**
(`/tmp/fvrc1008-recreate-build-r2.log`). Vollständiges Lint: **0 Fehler**, sieben
bestehende Warnungen außerhalb dieses Fixes
(`/tmp/fvrc1008-recreate-lint-full-r2.log`); gezieltes finales Lint separat in
`/tmp/fvrc1008-recreate-lint-final.log`. TypeScript ohne inkrementellen Cache:
`/tmp/fvrc1008-recreate-typecheck-r3.log`. Alle vier Stackdienste und die
aktuellen Host-Dev-Healthchecks sind gesund; Stacknachweis
`/tmp/fvrc1008-recreate-stack-final.log`.

SHA-256 des in beiden erfolgreichen Recreate-Läufen unverändert ausgeführten
Browserspecs: `372be2fdd4bdce9f015055bd57ccdceb17ac47fc60b4533c51394cfc2bed32be`.
Der unabhängige Quellreview fand keinen konkreten Produktfehler; seine
zusätzliche Assertion zur unverändert gespeicherten alten Tab-ID wurde in
den Lifecycle-Test aufgenommen. Der Code-Structure-Ansatz beschränkt die
gemeinsame Fehlerbehandlung auf automatische Einstiege und lässt die
bestehenden Identitäts-/Öffnungsregeln unangetastet.

GitNexus nach Neuindexierung: acht gestagte Dateien, 34 Symbole, drei betroffene
Notebook-Prozesse, mittleres Risiko. Gesamter Branchvergleich zum lokalen
`main`: 191 Dateien, 1469 Symbole, 30 Prozesse, kritisch. Dieser einzelne Fix
ist keine Freigabe der übrigen Merge-/Berechtigungsänderungen. Generierte
Indexzählungen in `AGENTS.md`/`CLAUDE.md` bleiben außerhalb des Commits.

## Grenzen und offene Gates

- MR-17 ist zusammen mit `ordinary-location-results.md` für die geprüften
  authentifizierten Datei-API-Lebenszyklen in Personal und Team abgedeckt.
  Das ist kein Test des separaten Agenten-Tools `move_path`, eines
  Rename-/Apply-Rennens oder einer gleichzeitigen Delete-/Apply-Operation.
- Alte Ziele wurden über Dokument-ID und Lineage geprüft, nicht als bloßes
  `kind: path`-Review-Ziel. Die Wiederöffnung im Dateibrowser ist ein bewusster
  neuer Auswahlvorgang und kein Review-Pfad-Fallback.
- Das Löschen der gesamten Datei ist nicht gleichbedeutend mit CR-05/MR-08
  (einen einzelnen Block löschen und identischen Text neu einfügen). Diese
  Szenarien werden durch diesen Nachweis nicht hochgestuft.
- Kein Trash-Restore, Generation-/Schema-Wechsel oder Prozess-Crash getestet.
  Zwei vollständige Gesamtmatrixläufe, frisches Produktionsimage und P12
  bleiben offen. FVRC-1008 bleibt `in_progress`.

## Wiederholung

Mit bereits vorbereitetem Skill-Stack und aktuellem Host-Dev; keine privaten
Env-Dateien ändern und keinen zweiten App-Server starten:

```sh
NODE_ENV=development E2E_EXTERNAL_SERVER=1 COLLABORATION_E2E=1 \
CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1 BASE_URL=http://127.0.0.1:3000 \
PLAYWRIGHT_HTML_OPEN=never PLAYWRIGHT_HTML_OUTPUT_DIR=/tmp/fvrc1008-recreate-personal-report \
node --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env \
  --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/fixtures.env \
  node_modules/@playwright/test/cli.js test tests/file-version-center-ordinary-recreate.spec.ts \
  --grep personal --workers=1 --reporter=line,html
```

Danach mindestens 55 Sekunden Abstand, `--grep team` und ein separates
Reportverzeichnis verwenden. Keine Container gebaut, nichts gepusht.
