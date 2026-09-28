# Vollständige Vergleichsseiten vor der Annahme

Stand: 26. September 2026. Ausgangscommit `50aa30008`. Teilnachweis für
MR-15/MR-20 in FVRC-1008; keine vollständige Gate- oder Produktionsfreigabe.

## Reproduzierter Fehler und Korrektur

Ein gewöhnlicher `write`-Vorschlag verändert 65 voneinander getrennte Stellen
eines Markdown-Dokuments. Die erste Vergleichsseite zeigt nur 64 Hunks.
Vor dem Fix war **Accept change** trotzdem aktiv: Die signierte Aktion war
vorbereitet, obwohl die letzte Änderung noch nicht in die UI geladen war.
Der negative Browserlauf dokumentiert genau diesen Zustand.

`GraphReviewComparison` erlaubt Inhaltsannahme und Bestätigung jetzt erst bei
vollständig geladenem, verfügbarem Vergleich mit Bindung und passendem Status:
kein Restcursor, keine weiteren Seiten, kein laufender Abruf und kein Fehler.
Ein nachgewiesener Nullvergleich bleibt zulässig. Metadaten-Ablehnung bleibt
von der Vollständigkeit des Inhaltsvergleichs unabhängig.

Die nächste Seite muss weiterhin exakt dieselbe Bindung tragen; zusätzlich
werden Verfügbarkeit, Status und Kandidatenverfügbarkeit geprüft. Fehlerhafte
Seiten überschreiben den bisherigen Vergleich nicht und geben ihn nicht frei.
Eine verspätete Antwort auf die vorherige Auswahl wird weiterhin verworfen.

Der Hinweis auf fehlende Änderungen und **Load more changes** stehen im
sichtbaren Aktionsbereich. Nach einem Fehler ermöglicht **Refresh comparison**
eine neue Review-Sitzung. Sie beginnt wieder mit ihrer eigenen ersten Seite;
die alten Seiten werden nicht übernommen. Beschriftungen sind deutsch/englisch,
die Bedienelemente nutzen die vorhandenen App-Komponenten und umbrechen mobil.

## Gewöhnlicher Browserablauf: Personal und Team

`tests/file-version-center-ordinary-diff-pages.spec.ts` verwendet eigene
UUID-Dateien und Sessions, registrierte `read`-/`write`-/`edit_file`-Werkzeuge,
authentifizierte APIs und tatsächliche UI-Aktionen. Representation ist
`tiptap_blocks`; die Werkzeugänderungen sind `review_required/not_applied`.
Es gibt keine simulierten Review-Antworten oder versteckten Editor-/Yjs-Edits.
Eine echte Compare-Anfrage wird gezielt verzögert und anschließend unverändert
an den Server weitergeleitet.

1. Vorschlag P ersetzt an 65 Stellen „vorher“ durch „nachher“. Seite eins
   enthält 64 Hunks, der letzte fehlt sichtbar; Annahme ist deaktiviert.
2. Die echte nächste Seite enthält genau einen Hunk, dieselbe Bindung und
   keinen Restcursor. Alle 65 Vorher-/Nachher-Texte sind in der UI vorhanden,
   Annahme ist jetzt aktiv. Dokumentinhalt und Revision sind noch unverändert.
3. Nach erneutem Öffnen wird die nächste Seite angehalten. Ein unabhängiger
   gewöhnlicher Vorschlag Q verändert nur den Graphen, nicht das Dokument.
   Graphrevision **1 → 2**, vollständiger Current-Proof unverändert.
4. Die freigegebene alte Seitenanfrage meldet
   `unavailable/PROPOSAL_CANDIDATE_CHANGED`. Die alte vorbereitete Annahme wird
   zusätzlich per API mit **409 / PROPOSAL_GRAPH_CHANGED** abgewiesen. Die UI
   behält nur die bisherigen 64 Hunks, zeigt den Fehler und bleibt gesperrt.
5. **Refresh comparison** lädt eine frische erste Seite. Erst nach deren
   letzter Seite wird Annahme wieder möglich. Annahme und Bestätigung erzeugen
   exakt den festen erwarteten Endtext und **eine** neue Inhaltsrevision.
6. Nur P wird `applied`; Q bleibt `open` und sein separater Effekt fehlt im
   Dokument. Ein identischer Retry liefert denselben Beleg ohne neue Revision.
   Genau ein Browser-Aktions-POST; die gezielte negative API-Prüfung zählt nicht
   als Browser-Aktion.

Die finale Personal-Ansicht wurde bei 1500 Pixeln, die Team-Ansicht bei 390 Pixeln
Breite geprüft. Alle Footer-Buttons bleiben innerhalb der Viewportbreite;
Annahme ist erreichbar. Fehler- und vollständige Ansichten wurden auch visuell
anhand der Report-Screenshots geprüft.

## Läufe und Nachweise

Ein verwalteter Skill-Stack mit PostgreSQL 18.4 / pgvector 0.8.3 auf 55433.
Aktueller Worktree als Host-Dev auf **127.0.0.1:3000**. Der ältere Container auf
**3100** ist kein Quellnachweis für diesen Fix. Keine Container neu gebaut,
keine Runtime-Env/Produktionspolicy geändert und keine Daten zurückgesetzt.
Aufgeräumt werden ausschließlich die test-eigenen Sessions und UUID-Dateien
(Dateien über die normale Lösch-API in den Papierkorb).

| Lauf | Ergebnis | Dauer | Revisionen | Browser-Aktions-POSTs |
|---|---|---|---|---|
| `personal-before` | erwarteter Fehler: Annahme bei 64/65 Hunks aktiv | – | keine Annahme | 0 |
| `personal-r3` | bestanden, finaler Spec | 27,3 s | 1 → 2 | 1 |
| `team-r1` | bestanden, finaler Spec, 390 px | 24,6 s | 1 → 2 | 1 |
| `no-effect-regression-r1` | bestehender Personal-Nullwirkungsfall bestanden | 22,4 s | 1 → 1 | 1 |

Logs `/tmp/fvrc1008-diff-pages-<Laufname>.log`, Reports
`/tmp/fvrc1008-diff-pages-<Laufname>-report/index.html`. Ein Worker, serielle
Browserläufe mit mindestens 55 Sekunden Abstand. Die tatsächlichen JSON-Belege
des finalen Personal-/Team-Reports wurden ausgelesen: Seiten 64+1, gesperrte
Annahme, Graphwechsel bei gleichem Current, negative Diagnose/409, Q offen,
Revisionen 1→2 und exakter Endtext. Keine Tokens/Credentials in den Anhängen.

Finaler Spec-SHA-256:
`a7c433e72f8adb2e6787f7d1098466a770902cc474b6d9d07894bf5e17fdd5e6`.

Weitere Validierung:

- 39 fokussierte Compare-/Client-/Contract-/Nullwirkungs-Tests bestanden:
  `/tmp/fvrc1008-diff-pages-regression-r1.log`.
- Erweiterte UI-Komponentensuite bestanden:
  `/tmp/fvrc1008-diff-pages-component-r1.log`. Prüft zusätzlich gemeinsame
  Annahme, laufende Abrufe, späte Antworten der alten Auswahl, Transportfehler,
  nicht verfügbare Seiten, geänderte Bindung und den frischen ersten Vergleich.
  Ablehnen bleibt möglich, Annahme/Bestätigung sind entsprechend gesperrt.
- Vollständiges TypeScript ohne inkrementellen Cache und fokussiertes ESLint
  ohne Fehler/Warnungen: `/tmp/fvrc1008-diff-pages-typecheck-r3.log` und
  `/tmp/fvrc1008-diff-pages-lint-r2.log`.
- Vollständiges `npm run lint`: keine Fehler, sieben bestehende Warnungen
  außerhalb der geänderten Dateien; `/tmp/fvrc1008-diff-pages-full-lint-r1.log`.
- `NODE_ENV=production npm run build` inklusive Lizenzgate bestanden, Exit 0:
  `/tmp/fvrc1008-diff-pages-build-r2.log`, 353/353 Seiten. 31 Turbopack-Warnungen
  bleiben sichtbar. Lauf r1 scheiterte an einem zeitgleich
  bearbeiteten Typfehler im neuen Komponententest; dieser wurde vor dem finalen
  Suite-/Typecheck-/Buildlauf korrigiert. Kein Containerbuild.
- Ein Subagent ergänzte ausschließlich die Komponentenregression und prüfte
  den Produkt-Diff zusätzlich lesend: kein weiterer materieller Befund.

Die fokussierten Programme verwenden isolierte DOM-/In-Memory-Fixtures;
sie sind keine zusätzlichen PostgreSQL-Browserläufe.

Alle vier verwalteten Dienste sind abschließend gesund, ebenso der aktuelle
Host-Dev; `/tmp/fvrc1008-diff-pages-stack-final.log` dokumentiert den Stack.
GitNexus wurde vollständig neu indiziert. Der gestagte Fix umfasst acht Dateien
und 25 erfasste Symbole, ohne zugeordneten geänderten Prozess, bei niedrigem
Risiko. Der gesamte Branchvergleich zum lokalen `main` bleibt mit 202 Dateien,
1565 Symbolen und 30 Prozessen kritisch. Die zuvor geprüften direkten UI-Aufrufer
und Browserfälle bleiben relevant; ein leerer Prozesszähler ist kein Nachweis
fehlender UI-Auswirkungen. Generierte Indexzählungen in `AGENTS.md`/`CLAUDE.md`
sind nicht Teil des Commits.

## Grenzen

- Vollständig **geladen** bedeutet nicht, dass ein Mensch jeden Hunk gelesen
  hat. Es gibt keine Behauptung einer serverseitigen Lesebestätigung; die
  serverseitigen Current-/Graph-/Auswahl-Fences bleiben separat erhalten.
- Der neue Browsernachweis deckt Paging und Graph-Drift ab, nicht sämtliche
  Byte-, Zeit-, Graphgrößen- und Ablaufgrenzen von MR-20.
- Späte Antworten nach Auswahlwechsel und unterschiedliche Fehlerklassen sind
  zusätzlich Komponentenfälle mit simulierten Netzwerkgrenzen, keine weiteren
  PostgreSQL-Browserfälle. Nicht jede Berechtigungs-/Workspace-Variante ist mit
  Pagination kombiniert.
- Kein frisches Containerimage, kein vollständiger zweiter Matrixdurchlauf
  und keine Abnahme von FVRC-1008. Der manuelle Konflikteditor P12 bleibt separat
  geplant. Dieser UI-Fix vereinigt keine echten inhaltlichen Konflikte automatisch.
