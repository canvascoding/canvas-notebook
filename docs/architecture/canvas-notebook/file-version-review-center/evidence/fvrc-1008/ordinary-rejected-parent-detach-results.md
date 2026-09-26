# Abgelehnte Voraussetzung: abhängigen Vorschlag ausdrücklich ablösen

Stand: 26. September 2026. Konkreter Produktfix mit Personal-/Team-E2E-Nachweis
für PG-S05/PG-S14. FVRC-1008 insgesamt und P12 sind weiterhin offen.

## Befund und begrenzter Fix

Der erste echte Browserlauf reproduzierte einen UI-Fehler: P1 war abgelehnt,
P2 weiterhin offen mit `PROPOSAL_DEPENDENCY_BLOCKED`. Der Server konnte P2
ausdrücklich gegen das aktuelle Dokument ablösen, aber das Review Center
deaktivierte beide Transformationsbuttons. Zusätzlich hätte die separate
Bestätigungsprüfung den Auftrag auch nach einer Vorschau verworfen.

`GraphReviewComparison` unterscheidet jetzt den zulässigen Kontext je Aktion:

- **Ablösen:** normaler Kontext oder genau `PROPOSAL_DEPENDENCY_BLOCKED`.
- **Ersetzen:** weiterhin nur normaler Kontext, da die Voraussetzung erhalten bleibt.
- Startbutton, Vorschau-Aufruf und Bestätigung verwenden dieselbe Zuordnung.
  Die bestehenden Schreibrechte-, Auswahl-, Aktualitäts-, Lebenszyklus- und
  Aktionswiederherstellungsprüfungen bleiben bestehen.

Direktes Annehmen von P2 bleibt gesperrt. Die serverseitigen Nachweise,
Berechtigungsprüfungen und signierten Freigaben werden nicht geändert.
Ein separater Vorschlag wird erst nach ausdrücklicher Bestätigung erstellt;
danach benötigt er eine eigene Prüfung und Annahme. P1 bleibt abgelehnt und
das ursprüngliche P2 offen/blockiert. App-Stil und Layout bleiben unverändert.

## Umgebung und Quellstand

Basis `a4011716b`, darüber der oben beschriebene UI-Fix. Produktdatei-SHA-256:
`38dc66e44abe877a0086a6c2d718aafa36a294bd79c3d9e0b0b20f79127df1b0`.

Aktueller Worktree auf `http://127.0.0.1:3000`, echter PostgreSQL 18.4 mit
pgvector 0.8.3 im einzigen verwalteten Team-Seat-Stack. Beide Workspace-Fälle
verwenden den Administrator. Alle vier Stack-Dienste waren gesund. Der ältere
Notebook-Container auf 3100 ist ausdrücklich kein Nachweis für diesen Fix.
Keine Container, Dependencies oder Runtime-Env wurden verändert.

## Browser-Orakel

`tests/file-version-center-ordinary-detach.spec.ts` verwendet die gemeinsamen
authentifizierten Fixtures und die gewöhnlichen registrierten `read`-/
`edit_file`-Werkzeuge, keine direkt eingesetzten Graphknoten und kein LLM.
Review wird am standardmäßig ausgeschalteten Editor-Toggle aktiviert.
Die Datei verwendet nachweislich `tiptap_blocks`.

1. A enthält Kosten 10 EUR und Lieferzeit 5 Tage. P1 schlägt Kosten 12 EUR vor.
2. P2 liest ausdrücklich den noch offenen P1-Kandidaten und ändert den anderen
   Absatz über seine stabile Block-ID auf Lieferzeit 3 Tage. Obwohl die Edits
   textlich unabhängig sind, bleibt P2 ausdrücklich von P1 abhängig. Vor der
   Ablehnung enthält die geprüfte Anwendungsmenge P1 und P2 in dieser Reihenfolge.
3. P1 wird im Browser abgelehnt: Metadatenbeleg, keine Inhaltsrevision. P2 bleibt
   offen/blockiert, ohne Annahmeaktion. Ersetzen ist deaktiviert, Ablösen verfügbar.
4. Die verifizierte Vorschau enthält exakt A als Basis und nur die Änderung
   auf Lieferzeit 3 Tage. Kosten bleiben 10 EUR. Vorschau allein ändert weder
   Graphrevision noch Dateitext oder Revisionsanzahl.
5. Bestätigen erstellt einen neuen `detached`, review-pflichtigen Vorschlag mit
   autoritativer Quelle, `detachedFromProposalId = P2` und ohne Abhängigkeit,
   Ersetzungs- oder Auswahlgruppenbeziehung. Kein Live-Write. Die identische
   Wiederholung des signierten Erstellungsauftrags liefert denselben Beleg.
6. Der neue Vorschlag ist unabhängig prüfbar. Sein Rest-Diff enthält exakt
   Lieferzeit 5 → 3 Tage. Erst seine separate UI-Annahme schreibt den Inhalt.
7. Der vollständige Endtext ist fest vorgegeben, alle drei ursprünglichen
   Block-IDs und ihre Reihenfolge bleiben erhalten. Genau +1 Inhaltsrevision
   und drei Browser-Aktions-POSTs entstehen: Ablehnen, Ablösen, Annehmen.
   Es gibt genau einen Vorschau-POST. Der API-Retry wird gesondert geprüft.
8. Das ursprüngliche P2 bleibt blockiert; P1 ist über seinen exakten historischen
   Link weiterhin abgelehnt und ohne Mutationsaktionen sichtbar.

## Ergebnisse

Serielle Einzelfälle, ein Worker und Abstand zwischen den Läufen. Die gemeinsame
Fehlerbeobachtung prüft Review-429-/5xx-Antworten; alle direkten APIs werden auf
ihren erwarteten Status geprüft. Kein Skip und kein beobachteter Review-429-/
5xx-Fehler in den abschließenden bestandenen Läufen.

| Browserfall | Ergebnis | Bericht unter `/tmp/` |
|---|---|---|
| Gewöhnliches P1 ablehnen → P2 ablösen → separat annehmen, Personal | bestanden, 26,9 s | `fvrc1008-detach-personal-r2-report/index.html` |
| Derselbe Ablauf, Team | bestanden, 30,4 s | `fvrc1008-detach-team-r2-report/index.html` |
| Wiederholung Personal mit zusätzlichem Vorschau-Screenshot | bestanden, 26,5 s | `fvrc1008-detach-personal-r3-report/index.html` |
| Wiederholung Team mit zusätzlichem Vorschau-Screenshot | bestanden, 26,3 s | `fvrc1008-detach-team-r3-report/index.html` |
| Bestehender normaler Ablösen-Ablauf | bestanden, 18,4 s | `fvrc1008-detach-transform-detach-r1-report/index.html` |
| Bestehender normaler Ersetzen-Ablauf | bestanden, 20,2 s | `fvrc1008-detach-transform-replace-r1-report/index.html` |

Alle vier neuen JSON-Belege wurden zusätzlich unabhängig aus den HTML-Reports
geprüft: Workspace/Darstellung, exakte Belegtypen, neues Vorschlagsziel,
Herkunftsverweis, +1 Revision und POST-Anzahlen. Vorschau-Screenshots beider
Workspaces sowie die historische Personal-Ansicht wurden visuell kontrolliert.
Die beiden Wiederholungen sind keine zwei vollständigen Gesamtmatrixläufe.
Der anfängliche rote Lauf
zählte nicht als Erfolg; seine eigene UUID-Datei wurde nach Prüfung des
unveränderten Inhalts über die normale Lösch-API entfernt.

Weitere Prüfungen bestanden:

- `npm run test:proposal-graph:review-ui`: normale Ablösen-/Ersetzen-Vorschau,
  blockierter offener Nachfolger mit Vorschau/Abbrechen/Bestätigen, alle anderen
  Kontextfehler weiterhin gesperrt. Auch Nur-Lesen, veraltete/neu ladende Ansicht,
  geschlossener Vorschlag, ausstehende Aktionsidentität, Gesamtauswahl und
  Zweigauswahl geben keine Transformationsaktion frei.
- `npm run test:proposal-graph:review-actions`: bestehende Server-, Vertrags-,
  Autorisierungs-, Transformations- und Aktionsprüfungen.
- TypeScript ohne inkrementellen Cache, fokussiertes ESLint und Diff-Prüfung.
- `NODE_ENV=production npm run build`: erfolgreich, 353 Seiten, Lizenzprüfung
  bestanden. Die bekannten Build-/Runtime-Warnungen bleiben im Log sichtbar.

Logs: `/tmp/fvrc1008-detach-review-ui-final.log`,
`/tmp/fvrc1008-detach-review-actions-r1.log`,
`/tmp/fvrc1008-detach-typecheck-final.log`,
`/tmp/fvrc1008-detach-lint-final.log`, `/tmp/fvrc1008-detach-build-r1.log`.

Der unabhängige Subagenten-Review prüfte Produkt- und Testquelltext und fand
keinen konkreten Sicherheits- oder Orakelfehler; er führte die Läufe nicht
selbst erneut aus. GitNexus vor Commit: lokaler Umfang 6 Dateien/25 Symbole,
keine zusätzlich erfassten Ausführungsprozesse, Risiko niedrig. Der vollständige
Branchvergleich gegen `main` bleibt dagegen kritisch: 168 Dateien, 1219 Symbole,
27 betroffene Prozesse. Die enge Freigabe des Fixes ersetzt keine Branchfreigabe.

SHA-256 der abschließend getesteten Quellen:

- `tests/file-version-center-ordinary-detach.spec.ts`:
  `991205a5653ea9f0697bf3ed6af30b4078b309007c085efa6fca2334321a4fc1`
- `scripts/file-version-center-graph-review-test.tsx`:
  `aec2e906d026d549cc46346cbb3df4d6c70d6dd8e9e1235956e00c6834934a04`

## Grenzen

Das ist ein erfolgreicher Merge eines ausdrücklich abgelösten, unabhängig
adressierbaren Nachfolger-Edits, kein automatisches Auflösen beliebiger
Textkonflikte. Fehlen die benötigten Ziele oder sind sie widersprüchlich,
muss die serverseitige Prüfung weiterhin sicher ablehnen. Der manuelle
Konflikteditor aus P12 ist damit nicht fertiggestellt. Zwei vollständige
Gesamtmatrixläufe, weitere Crash-/Mehrprozess-/Berechtigungsszenarien und der
Nachweis auf einem frisch gebauten Produktionsimage bleiben offen. Kein Push
und keine Produktionsaktivierung.
