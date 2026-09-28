# Gleicher Text nach echter Absatz-Neuanlage

Stand: 26. September 2026. Produktcode unverändert auf `da8c01744`, ergänzt um
`tests/file-version-center-ordinary-block-recreate.spec.ts`. Teilnachweis für
FVRC-1008, insbesondere CR-05/MR-08; keine Gesamt- oder Produktionsfreigabe.

## Ablauf und feste Orakel

Personal und Team verwenden echte `tiptap_blocks`, gewöhnliche registrierte
`read`-/`edit_file`-Werkzeuge, authentifizierte APIs und den sichtbaren Editor.
Es werden keine Vorschlagsknoten vorgefertigt, keine Anwendungsantworten
simuliert und keine Editor-/Yjs-Interna zum Verändern des Dokuments benutzt.
Die DOM-Auswahl markiert lediglich den sichtbaren Absatztext; die Änderung
erfolgt mit Tastaturaktionen.

1. Markdown mit Überschrift, Hinweis, Kosten 10 EUR und Lieferzeit 5 Tage
   anlegen; Review ausdrücklich einschalten. Zwei unabhängige Vorschläge auf
   demselben Ausgangsdokument anlegen: zuerst Q (Lieferzeit 5 → 2 Tage),
   danach B (Kosten 10 → 12 EUR). Beide blockgebundenen Quellen werden geprüft.
   Einzel-B und gemeinsamer Batch besitzen vor der manuellen Änderung gültige
   Annahmefreigaben; der aktuelle Inhalt ist unverändert.
2. Im Rich-Editor den Kostenabsatz auswählen, Text und leeren Absatz löschen.
   Exakte Zwischenbytes und die drei verbleibenden ursprünglichen Block-IDs
   prüfen. Danach am selben Ort einen neuen Absatz mit **demselben Text**
   einfügen. Dokument-ID und komplette Markdown-Bytes/Hash sind wie zuvor;
   der Kostenabsatz hat eine neue ID, alle Nachbar-IDs bleiben erhalten.
3. Auf den dauerhaften Collaboration-Checkpoint warten, dann erst den
   Revisionsausgangswert erfassen. B ist `conflicted` mit
   `PROPOSAL_BATCH_CONFLICT`, bleibt `open` und hat keine Annahmefreigabe.
   Sein Kandidat ist nicht verfügbar, kein belegter Nulleffekt und hat keine
   Diff-Hunks. Die Vergleichsbindung bleibt für die Diagnose erhalten.
4. Q ist `clean_rebased`. Der aktuelle `contentHash` ist identisch mit dem
   alten, aber `structureHash` und `fullStateHash` unterscheiden sich.
   Beide **alten** vorbereiteten Annahmen (Einzel-B und Q+B) liefern
   `409 / PROPOSAL_CURRENT_CHANGED`; Inhalt und Revisionen bleiben unverändert.
5. Q+B erneut über API und „Review all changes“ im UI prüfen: konkrete
   Konfliktdiagnose, beide Vorschläge offen, kein Annahme-Button und kein
   Browser-Aktions-POST. Volltext, Revisionszahl und kompletter aktueller
   Zustandsnachweis bleiben gleich. Kein alter Timeline-Aktualisierungsfehler.
6. Q ausdrücklich separat öffnen und mit seiner neuen Vorschau bestätigen:
   genau ein Browser-Aktions-POST, erfolgreicher Beleg mit ausschließlich Q
   als `applied`, genau +1 Inhaltsrevision. Ein identischer API-Retry gibt
   denselben Beleg ohne zusätzliche Revision zurück. B bleibt offen und
   konfligierend, ohne Annahme-Button. Neuer Kostenblock und alle Nachbar-IDs
   bleiben erhalten. Exakter Endtext einschließlich abschließendem LF:

   ```md
   # Versand

   Hinweis: Standardversand

   Kosten: 10 EUR

   Lieferzeit: 2 Tage
   ```

Die Revisionsdifferenz wird **nach** dem Editor-Checkpoint gemessen; die
manuellen Benutzeränderungen haben eigene Revisionen. In beiden Läufen war
der gemessene Stand vor/nach Annahme 3 → 4. Die Anzahl dieser vorherigen
Revisionen ist bewusst kein festes Testorakel.

## Laufnachweise

Ein verwalteter Skill-Stack mit PostgreSQL **18.4 / pgvector 0.8.3** auf 55433.
Der aktuelle Host-Dev läuft aus dem Implementierungsworktree auf
**127.0.0.1:3000**. Das ältere Notebook-Image auf **3100** wurde nicht neu gebaut
und zählt nicht als Nachweis des aktuellen Quellstands.

- `block-recreate-personal-r1`: fehlgeschlagen an der falschen Testannahme,
  ein kombinierter Root-Batch sei `clean`. Nach Komposition des ersten Root
  ist der Scratch-Zustand für den zweiten bereits verändert: korrekt ist
  `clean_rebased`. Kein Produktcode wurde hierfür verändert.
- `block-recreate-personal-r2`: echte Löschung/Neuanlage und Konfliktprüfung
  erfolgreich erreicht, danach falsche Zusatzannahme `binding: null` im Test.
  Der Compare-Service erhält die Evaluationsbindung auch bei Konflikten;
  sie ist keine Annahmefreigabe. Korrigiert auf exakte Auswahlbindung,
  unveränderten Current-Proof und weiterhin fehlende Annahme/Kandidaten.
  Beide Entwicklungsfehlläufe zählen nicht als bestandene E2E-Nachweise.
- `block-recreate-personal-r3`: bestanden, **29,1 s**.
- `block-recreate-team-r1`: bestanden, **29,0 s**.

Die beiden finalen Fälle liefen seriell, jeweils ein Worker, mit mehr als
55 Sekunden Abstand. Keine Skips oder vom Fehlerkollektor beobachteten
Review-429-/5xx-Antworten. Reports unter
`/tmp/fvrc1008-<Laufname>-report/index.html`, Logs entsprechend
`/tmp/fvrc1008-<Laufname>.log`. JSON-Belege enthalten die tatsächlichen
Dokument-/Vorschlags-/Block-IDs, alten/neuen Current-Proofs, exakte Endbytes,
Revisionszahlen und den Aktionsbeleg; keine Sitzungstokens oder Credentials.
Die Personal-Editor-/Batchansicht und die finale Team-Konfliktansicht wurden
visuell geprüft: konkrete Konfliktmeldung, kein falscher Null-Diff und keine
unerlaubte Annahmeaktion.

Ein unabhängiger Subagent hat die tatsächlichen JSON-Anhangkörper aus den
eingebetteten HTML-Report-ZIPs gelesen und für beide Läufe Endtext, neue Ziel-ID,
erhaltene Nachbar-IDs, gleiche Content-Hashes, verschiedene Struktur-/Full-State-
Hashes, geblockten Batch, genau einen POST, 3 → 4 Revisionen und ausschließlich
Qs erfolgreiche Resolution bestätigt. Die verkürzten Report-Metadaten allein
enthalten diese Körper nicht; sie liegen im dateispezifischen Test-JSON unter
`results[].attachments[].body`.

Unveränderter Spec-SHA-256 in beiden finalen Läufen:
`3616e25005cfd88f56e55c9ccd6ff47aa379727f8379ed0830bc2c0b9578960c`.

Weitere bestandene Prüfungen (Logs `/tmp/fvrc1008-block-recreate-…`):

- `evaluation-r1.log`: 14 Evaluator-Tests, ohne Datenbank.
- `candidates-r1.log`: 17 Kandidaten-/Yjs-Tests.
- `compare-service-r1.log`: sechs Compare-Service-Tests.
- `typecheck-r2.log`: vollständiges TypeScript ohne inkrementellen Cache.
- `lint-r3.log`: fokussiertes ESLint, keine Fehler/Warnungen.
- `git diff --check` sauber. Kein neuer Produktbuild für diese reine
  Test-/Dokumentationsänderung; letzter Produktbuild siehe
  `ordinary-recreate-results.md`.

Alle vier Stackdienste und der aktuelle Host-Dev-Healthcheck sind gesund;
Stackprotokoll: `/tmp/fvrc1008-block-recreate-stack-final.log`. GitNexus nach
Neuindexierung: vier gestagte Dateien, 28 erfasste Symbole, keine betroffenen
erfassten Produktprozesse, niedriges Risiko. Der gesamte Branchvergleich mit
lokalem `main` umfasst 193 Dateien, 1490 Symbole und 30 Prozesse, kritisch.
Dieser Teilnachweis ist keine Freigabe des gesamten Branches. Generierte
Indexzählungen in `AGENTS.md`/`CLAUDE.md` bleiben außerhalb des Commits.

## Grenzen

- CR-05/MR-08 haben jetzt positive Browsernachweise für echte Rich-Absatz-
  Neuerstellung in Personal/Team, nicht nur Plain-Text-Evaluator-Tests.
- Der unabhängige Vorschlag wird tatsächlich übernommen. Das ist mehr als
  sichere Verweigerung, aber **kein** manueller Merge des Konfliktvorschlags.
- Die gemischte Auswahl bleibt vollständig unangewendet. Dies belegt weder
  eine interne Scratch-Reihenfolge noch das PG-S21-Rennen „letztes Mitglied
  ändert sich während der abschließenden Live-Prüfung“.
- Keine Aussage, dass verweigerte POSTs überhaupt keine Diagnose-/Metadaten-
  Einträge erzeugen; geprüft sind kein Live-Apply, unveränderte Current-Proofs,
  offene Lebenszyklen und keine zusätzliche Inhaltsrevision.
- Kein Absatz-Move, Undo/Redo, Garbage-Collection-/Prozess-Restart oder
  gleichzeitiger Peer-Edit in diesem Fall. Zwei komplette Gesamtmatrixläufe,
  ein frisches Produktionsimage und P12 bleiben offen; FVRC-1008 bleibt
  `in_progress`.

Cleanup löscht nur die eigene synthetische Session und verschiebt die eigene
UUID-Datei über die normale API in den Papierkorb (wiederherstellbar bis zum
regulären Ablauf). Kein Fixture-/Workspace-/Datenbank-Reset, kein Push,
keine Container- oder Produktionskonfigurationsänderung.

## Wiederholung

Mit dem vorbereiteten Skill-Stack und aktuellem Host-Dev, ohne zweiten Server
oder private Env-Änderung:

```sh
NODE_ENV=development E2E_EXTERNAL_SERVER=1 COLLABORATION_E2E=1 \
CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1 BASE_URL=http://127.0.0.1:3000 \
PLAYWRIGHT_HTML_OPEN=never PLAYWRIGHT_HTML_OUTPUT_DIR=/tmp/fvrc1008-block-recreate-personal-report \
node --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env \
  --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/fixtures.env \
  node_modules/@playwright/test/cli.js test tests/file-version-center-ordinary-block-recreate.spec.ts \
  --grep personal --workers=1 --reporter=line,html
```

Danach mindestens 55 Sekunden Abstand, `--grep team` und eigenes Reportziel.
