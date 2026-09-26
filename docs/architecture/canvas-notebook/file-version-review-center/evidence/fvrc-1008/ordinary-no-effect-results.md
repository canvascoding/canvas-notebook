# Wirkungslose Vorschlagsketten und identische unabhängige Änderungen

Stand: 26. September 2026. Ausgangscommit `b436efbad`. Teilnachweis für
PG-S12/MR-13/CR-10 in FVRC-1008; keine vollständige Gate- oder Produktionsfreigabe.

## Reproduzierter Fehler und begrenzte Korrektur

Ein gewöhnliches blockgebundenes `edit_file` erzeugt P1 „Kosten 10 → 12 EUR“.
Ein zweites, ausdrücklich vom Kandidaten P1 abgeleitetes `edit_file` erzeugt
P2 „12 → 10 EUR“. Beide Vorschläge bleiben zunächst offen. Die Auswahl von
P2 schließt P1 als anzuwendende Voraussetzung in die Vorschau ein; gemeinsam
bleibt inhaltlich und strukturell der Ausgangsstand erhalten.

Vor dem Fix erkannte der Composer korrekt `empty_effect`. Die öffentliche
Review-API gab trotzdem `PROPOSAL_CANDIDATE_CHANGED` / `unavailable` zurück:
beim erneuten Laden des gespeicherten Kandidaten verlangte sie denselben
vollständigen Yjs-Zustand wie im aktuellen Dokument. Die Hin- und Rückänderung
hinterlässt jedoch neue interne Text-IDs und Löschinformationen. Der negative
Browserlauf belegt den Fehler sowohl für P2 allein als auch für die gemeinsame
Auswahl; nur Ablehnen blieb für P2 verfügbar.

`hasProposalNullEffectProof` vereinheitlicht jetzt die Prüfung an drei Stellen:
frischer Vergleich, Laden des gespeicherten Vergleichs und Vorbereitung des
Metadatenabschlusses. Für **empty_effect** müssen Inhalts- und Strukturhash
übereinstimmen; **satisfied_elsewhere** verlangt weiterhin den vollständigen
Nachweis einschließlich CRDT-Identität. Das ist keine textbasierte Freigabe:
gleicher Markdown-Text mit neu erzeugten Block-IDs reicht ausdrücklich nicht.

Die unveränderlichen Kandidaten werden weder umgeschrieben noch auf die
aktuellen Bytes normalisiert. Quellen für spätere abhängige Vorschläge behalten
ihre tatsächlichen Identitäten. Auch die vollständige Current-/Graph-/Auswahl-
und Artifact-Bindung der Freigabe bleibt erhalten. Ein zwischenzeitlich intern
verändertes Dokument wird selbst bei wieder gleichem sichtbarem Inhalt weiterhin
als `PROPOSAL_CURRENT_CHANGED` abgewiesen.

## Gewöhnliche Browserfälle: Personal und Team

`tests/file-version-center-ordinary-no-effect.spec.ts` verwendet eigene UUID-
Dateien und Sessions, registrierte `read`-/`edit_file`-Werkzeuge, authentifizierte
APIs und sichtbare UI-Aktionen. Keine erfundenen Graphknoten, simulierten Review-
Antworten oder versteckten Editor-/Yjs-Schreibzugriffe. Review ist bei Anlage aus
und wird im Editor explizit aktiviert. Representation: `tiptap_blocks`.

### P1 und P2 heben sich auf

- P2 allein sowie beide gemeinsam zeigen einen verfügbaren, nachgewiesenen
  Nullvergleich: keine Fehlerdiagnose, keine Hunks und keine Inhaltsannahme.
- Die gemeinsame Auswahl schließt nichts automatisch und bietet keine
  Metadaten-Sammelannahme. Die UI erklärt, dass einzeln entschieden werden muss.
- P2 allein bietet **„Ohne Änderungen abschließen“** statt „Bereits vorhanden“.
  Die Bestätigung benennt ausdrücklich nur diesen Vorschlag.
- Der UI-Abschluss liefert `metadata_only`, `revisionId: null` und ausschließlich
  P2 als `satisfied_elsewhere`. P1 bleibt `open` und weiterhin separat annehmbar;
  er wird nicht fälschlich `included` oder `applied`.
- Inhalt, ursprüngliche Block-IDs und kompletter Current-Proof bleiben gleich.
  Revisionszahl **1 → 1**, ein Browser-Aktions-POST. Identischer Retry liefert
  denselben Beleg. Der historische P2-Link bietet keine neuen Aktionen.

### B und C haben unabhängig denselben Effekt

- Beide gehen vom selben Ausgangsstand aus: Kosten 10 → 12 EUR. Ein Kind D
  verwendet ausdrücklich die Kandidatenquelle von B für 12 → 14 EUR.
- C wird über die echte UI angenommen: ausschließlich C `applied`, exakt eine
  zusätzliche Inhaltsrevision. B zeigt danach nachgewiesen `satisfied_elsewhere`
  und den unveränderten Button **„Als bereits vorhanden markieren“**.
- Vor und nach dem Metadatenabschluss von B bleibt D `prerequisite_lost`, offen,
  ohne Inhaltsannahme oder Nullabschluss. Cs gleich aussehender Text ersetzt
  nicht die von D erwarteten, durch B verfassten Text-IDs.
- B schließt ausschließlich als `satisfied_elsewhere`; keine weitere Revision,
  keine Änderung am vollständigen Current-Proof. Endtext exakt Kosten 12 EUR
  bei unveränderter Lieferzeit 5 Tage und unveränderten Block-IDs.
- Insgesamt **1 → 2** Revisionen, zwei Browser-Aktions-POSTs. Identische Retries
  beider Aktionen liefern dieselben Belege. B und C sind historisch nur lesbar.

## Nachweise und Umgebung

Ein verwalteter Skill-Stack, PostgreSQL 18.4 / pgvector 0.8.3 auf 55433.
Aktueller Implementierungsworktree als Host-Dev auf **127.0.0.1:3000**.
Der ältere Notebook-Container auf **3100** zählt nicht als Quellnachweis für
diesen Fix. Keine Container neu gebaut, keine Runtime-Env oder Produktions-
Policy geändert; kein LLM-Ausweichserver, keine Fixture-/Nutzerdaten-Resets.
Die Tests entfernen nur ihre eigenen Sessions und legen ihre UUID-Dateien
über die gewöhnliche Lösch-API in den Papierkorb.

| Lauf | Ergebnis | Dauer | Revisionen | Browser-Aktions-POSTs |
|---|---|---|---|---|
| `no-effect-personal-before` | erwartete Reproduktion: CANDIDATE_CHANGED | – | keine Inhaltsannahme | 0 |
| `no-effect-personal-after-r1` | bestanden | 22,5 s | 1 → 1 | 1 |
| `no-effect-team-after-r1` | bestanden | 23,0 s | 1 → 1 | 1 |
| `twin-personal-r1` | bestanden | 28,0 s | 1 → 2 | 2 |
| `twin-team-r1` | bestanden | 29,5 s | 1 → 2 | 2 |

Logs `/tmp/fvrc1008-<Laufname>.log`, Reports
`/tmp/fvrc1008-<Laufname>-report/index.html`. Je ein Worker, seriell mit mindestens
55 Sekunden Abstand; keine Skips oder beobachteten Review-429-/5xx-Antworten.
JSON-Anhänge enthalten tatsächliche Proposal-/Dokument-IDs, Diagnosen,
Revisionszahlen und Aktionsbelege; keine Tokens/Credentials. Die Belegkörper
wurden aus den HTML-Reports ausgelesen. Sichtbare Nullvergleich-/Batch- und
gesperrte Kindansichten wurden zusätzlich visuell geprüft.

Finaler Spec-SHA-256:
`91b946a8cf0dd3d494b4114fa886df28b6c10b520815b285a0743f935a8533ae`.
Der Personal-Nullfall lief vor Ergänzung des separaten Twin-Testfalls im selben
Spec; sein ausgeführter Testkörper und Produktcode wurden danach nicht geändert.

Weitere Nachweise:

- 75 bestehende fokussierte Tests für Composer, Auswertung, Compare, Runtime,
  Action-Runtime und Orchestrator: `/tmp/fvrc1008-no-effect-regression-r1.log`.
- Fünf neue Nachweistests einschließlich echter Plain-/Rich-Yjs-Komposition,
  neu angelegter Blockidentitäten und semantisch gleicher Current-Drift. Im
  bestehenden `test:proposal-graph:review-projection`-Gate registriert; gesamter
  Lauf bestanden: `/tmp/fvrc1008-no-effect-review-projection-r1.log`.
- UI-Komponentensuite bestanden nach Anpassung der explizit geänderten
  Empty-Effect-Beschriftung: `/tmp/fvrc1008-no-effect-component-r2.log`.
- Vollständiges TypeScript ohne inkrementellen Cache sowie fokussiertes ESLint
  ohne Fehler/Warnungen: `/tmp/fvrc1008-no-effect-typecheck-r2.log` und
  `/tmp/fvrc1008-no-effect-lint-r1.log`.
- `NODE_ENV=production npm run build` einschließlich Lizenzgate bestanden,
  353/353 Seiten, Exit 0: `/tmp/fvrc1008-no-effect-build-r1.log`. Das baut kein
  Containerimage und ist kein Browserlauf gegen einen Produktionsprozess.
- Vollständiges `npm run lint`: keine Fehler, sieben bestehende Warnungen
  außerhalb der geänderten Dateien; `/tmp/fvrc1008-no-effect-full-lint-r1.log`.

Die fokussierten Programme benutzen getrennte In-Memory-/DOM-Fixtures; sie sind
keine zusätzlichen PostgreSQL-Browserläufe. Auth-/Base-URL-Warnungen in einigen
isolierten Programmen wurden nicht als Produktionsbeleg behandelt.

Ein unabhängiger Subagent prüfte die drei Produktaufrufer, den gemeinsamen
Nachweis, UI-Texte und Tests sowie die tatsächlichen JSON-Anhangkörper aller
vier positiven Browserfälle. Kein materieller Korrektheits-/Sicherheitsbefund.
Beim gesperrten Kind fehlen Annahme und Nullabschluss; Ablehnen oder getrennte
Transformationsaktionen dürfen weiterhin angeboten werden.
Alle vier verwalteten Dienste und der aktuelle Host-Dev sind abschließend
gesund; Stacknachweis `/tmp/fvrc1008-no-effect-stack-final.log`.

GitNexus wurde vollständig neu indiziert. Der gestagte Fix umfasst 14 Dateien,
44 erfasste Symbole und einen erfassten Prozess bei mittlerem Risiko. Der gesamte
Branchvergleich zum lokalen `main` bleibt mit 200 Dateien, 1548 Symbolen und
30 Prozessen kritisch; dieser Teilnachweis ist keine Freigabe dieses Gesamtumfangs.
Generierte Indexzählungen in `AGENTS.md`/`CLAUDE.md` bleiben außerhalb des Commits.

## Grenzen

- Echte widersprüchliche Änderungen, etwa unabhängig 10 → 12 und 10 → 15,
  werden durch diesen Fix nicht automatisch vereinigt. Ein manueller
  Konflikteditor P12 ist weiterhin separat geplant.
- Keine neue Mehrfach-Metadatenabschluss-API. Ein Null-Batch prüft nur; der
  vorhandene explizite Abschluss ist weiter auf einen ausgewählten Vorschlag
  beschränkt. Voraussetzungsknoten werden nicht stillschweigend genehmigt.
- Der gespeicherte Abschluss-Lifecycle bleibt `satisfied_elsewhere`; die
  aktuellen UI-Aktionshinweise unterscheiden den wirkungslosen Kettenfall.
- Kein Zweier-Peer-/Prozessabsturztest und kein frisches Containerimage in diesen
  vier Fällen. Gesamtmatrix, zwei vollständige UI-Durchläufe und Release-Gates
  bleiben getrennte offene Aufgaben von FVRC-1008.
