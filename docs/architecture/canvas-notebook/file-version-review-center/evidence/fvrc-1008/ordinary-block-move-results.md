# Blockverschiebung plus unabhängige Editoränderungen

Stand: 26. September 2026. Ausgangscommit `9b3e8d852`, unveränderter Produktcode;
neuer Test `tests/file-version-center-ordinary-block-move.spec.ts`. Teilnachweis
für CR-04/MR-05 innerhalb FVRC-1008, keine vollständige Gate-Abnahme.

## Geprüfter Ablauf

Die Fälle verwenden `tiptap_blocks`, gewöhnliche registrierte `read`-/
`edit_file`-Werkzeuge und echte APIs/Editor-UI auf dem verwalteten PostgreSQL.
Keine simulierten Antworten, vorgefertigten Vorschlagsknoten oder versteckten
Editor-/Yjs-Schreibzugriffe. Fixtures sind eigene UUID-Dateien und Sessions.

1. Sechs Markdown-Blöcke anlegen: Überschrift, Standardversand-Hinweis,
   Entwurfsabsatz, Kosten 10 EUR, Lieferzeit 5 Tage, interne Notiz.
2. Zwei unabhängige blockgebundene Vorschläge gegen denselben Ausgangsstand
   anlegen: Kosten 10 → 12 EUR und Lieferzeit 5 → 2 Tage. Die Dokumentquelle,
   Block-IDs, erwarteter Inhalts-Hash und unabhängigen Beziehungen sind geprüft.
   Vor der manuellen Änderung sind Lieferzeit-Einzelvorschlag und Zweier-Batch
   annehmbar; der aktuelle Inhalt ist unverändert.
3. Den **Zielabsatz Lieferzeit selbst** im echten Rich-Editor mit zweimal
   `Alt+Shift+ArrowUp` verschieben. Exakten Zwischeninhalt und ID-Reihenfolge
   prüfen: Die Lieferzeit behält ihre ursprüngliche Block-ID.
4. Den separaten Entwurfsabsatz über sichtbare Textauswahl und zwei Backspaces
   löschen. Die ursprüngliche Entwurfs-ID fehlt; alle anderen IDs bleiben.
5. Nach dem Standardversand-Hinweis per End/Enter/Texteingabe einen neuen
   Hinweis „Express möglich“ **vor dem verschobenen Ziel** einfügen. Er bekommt
   eine neue ID; alle verbleibenden IDs, Reihenfolge und Zwischenbytes sind
   ausdrücklich geprüft.
6. Auf Dokumentsequenz-/Checkpoint-Konvergenz warten und erst danach die
   Revisionsbasis erfassen. Editor neu laden und unveränderte Identitäten,
   Reihenfolge und sichtbaren neuen Hinweis erneut prüfen.
7. Alte Lieferzeit-Einzelannahme und alte Batchannahme liefern
   `409 / PROPOSAL_CURRENT_CHANGED`. Inhalt, Revisionszahl und der komplette
   aktuelle Zustandsnachweis bleiben unverändert. Es wird nicht einfach eine
   inzwischen andere Vorschau mit der alten Freigabe angewendet.
8. Neue Vorschau ist `clean_rebased` und zeigt nur die ausgewählte Änderung:
   entweder zuerst Lieferzeit und danach Kosten einzeln oder beide gemeinsam.
   API-Hunks prüfen exakt die hinzugefügten/entfernten Zeilen; die sichtbare
   UI prüft **jede** ausgewählte Änderung einschließlich alter und neuer Zeile.
   Kein alter Timeline-Aktualisierungsfehler, keine verdeckte Teilannahme.
9. Erfolgreiche Bestätigung: Einzelmodus exakt zwei Browser-Aktions-POSTs und
   +2 Inhaltsrevisionen; Sammelmodus ein POST und +1 Revision. Jeder Beleg
   enthält exakt die ausgewählten Vorschläge als `applied`. Identische Retries
   liefern denselben Beleg ohne zusätzliche Revision. Beide historischen
   Operationsauswahlen sind danach `applied` und haben keine neuen Aktionen.

Fixer Endinhalt einschließlich abschließendem LF:

```md
# Versand

Hinweis: Standardversand

Hinweis: Express möglich

Lieferzeit: 2 Tage

Kosten: 12 EUR

Notiz: Intern
```

Die ursprünglichen IDs von Überschrift, Standardhinweis, Lieferzeit, Kosten und
Notiz bleiben in dieser Reihenfolge mit der neuen Hinweis-ID dazwischen erhalten.
Der gelöschte Entwurf wird nicht wiederhergestellt; Verschiebung und neuer
Hinweis werden nicht durch einen Agenten-Snapshot überschrieben. Im Einzelmodus
ist der Zwischenstand ausdrücklich Lieferzeit 2 Tage bei weiterhin Kosten 10 EUR.

## Umgebung und Laufnachweise

Ein verwalteter Skill-Stack, PostgreSQL 18.4 / pgvector 0.8.3 auf 55433.
Aktueller Host-Dev aus dem Implementierungsworktree auf **127.0.0.1:3000**.
Das ältere Notebook-Image auf **3100** zählt nicht als aktueller Quellnachweis;
keine Container wurden neu gebaut oder ersetzt.

Die ersten Personal-Läufe bestanden (`sequential-r1`: 47,5 s;
`batch-r1`: 38,0 s). Der unabhängige Testreview fand danach eine zu schwache
UI-Assertion: Im Batch war im gerenderten Diff nur die Lieferzeit geprüft,
während API und Receipt bereits beide Änderungen prüften. Der Test prüft nun
alte/neue Zeilen **beider** Änderungen und wird für alle vier Kombinationen
auf demselben finalen Spec erneut ausgeführt. Keine Produktänderung hierfür.

Finale Läufe (jeweils ein Worker, seriell und mit mindestens 55 Sekunden Abstand):

| Lauf | Ergebnis | Dauer | Inhaltsrevisionen ab Checkpoint | Browser-POSTs |
|---|---|---|---|---|
| `block-move-personal-sequential-r2` | bestanden | 41,6 s | 4 → 6 | 2 |
| `block-move-personal-batch-r2` | bestanden | 37,2 s | 4 → 5 | 1 |
| `block-move-team-sequential-r1` | bestanden | 41,2 s | 4 → 6 | 2 |
| `block-move-team-batch-r1` | bestanden | 37,3 s | 4 → 5 | 1 |

Reports: `/tmp/fvrc1008-<Laufname>-report/index.html`; Logs:
`/tmp/fvrc1008-<Laufname>.log`. Die JSON-Anhänge enthalten tatsächliche
Dokument-/Vorschlags-/Block-IDs, alte/aktuelle Current-Proofs, exakte Zwischen-/
Endbytes, Revisionszahlen und Aktionsbelege, keine Tokens oder Credentials.

Alle vier finalen Fälle ohne Skip und ohne vom Browser-Fehlerkollektor
beobachtete Review-429-/5xx-Antworten. Die tatsächlichen JSON-Anhangkörper
wurden zusätzlich aus den HTML-Reports gelesen und mit festen Sollwerten
geprüft: vollständiger Endtext, erwartete ID-Reihenfolge, neue Hinweis-ID,
fehlende Entwurfs-ID, präzise Aktions-/Abschlussmengen und Revisionsdifferenzen.
Die endgültigen Personal-/Team-Sammelansichten sowie die zweite Einzelvorschau
im Team wurden visuell kontrolliert. Der zweite Einzel-Diff zeigt nur noch
Kosten 10 → 12 EUR und die bereits angenommene Lieferzeit als Kontext.
Ein unabhängiger Subagent hat alle vier JSON-Anhangkörper separat ausgelesen
und die festen Endbytes, IDs/Reihenfolge, ausschließlich Delivery/Cost als
`applied`, POST-Zahlen und +2/+1 Revisionsdifferenz bestätigt.

Finaler Spec-SHA-256:
`c07d01a48914083a5f6af41c8bd5eb0b08fb5029daabdff6e62602f246c6ae2c`.

Weitere bestandene Prüfungen:

- `test:editor:block-move-command`: 30 Tests.
- `test:collaboration:block-tree`: 22 Tests.
- `test:proposal-graph:candidates`: 17 Tests.
- `test:editor:local-document`: 17 Tests.
- Vollständiges TypeScript ohne inkrementellen Cache und fokussiertes ESLint
  auf finalem Spec, beide ohne Fehler/Warnungen.

Die 86 fokussierten Tests verwenden eigene In-Memory-/DOM-/Yjs-Fixtures,
nicht die verwaltete produktionsähnliche PostgreSQL-Instanz. Logs:
`/tmp/fvrc1008-block-move-{command,tree,candidates,local-document}-r1.log`,
`/tmp/fvrc1008-block-move-{typecheck,lint}-r2.log`.
Kein neuer Produktbuild für diese reine Test-/Dokumentationsänderung; letzter
Produktbuild unter `ordinary-recreate-results.md`.

Abschließender Stacknachweis `/tmp/fvrc1008-block-move-stack-final.log`:
alle vier verwalteten Dienste gesund, PostgreSQL 18.4 / pgvector 0.8.3;
aktueller Host-Dev-Healthcheck ebenfalls gesund. GitNexus-Scope vor Commit:
vier gestagte Dateien, 28 erfasste Symbole, keine betroffenen erfassten
Produktprozesse, niedriges Risiko. Gesamter Branchvergleich mit lokalem
`main`: 195 Dateien, 1512 Symbole, 30 Prozesse, kritisch. Dieser Teilnachweis
gibt den übrigen Branch nicht frei. Generierte Indexzählungen in `AGENTS.md`
und `CLAUDE.md` werden nicht mitcommittet; `git diff --check` ist sauber.

## Abgrenzung

- MR-05/CR-04: echte Rich-Absatzverschiebung zusammen mit unabhängiger Löschung
  und Einfügung vor dem Ziel. Es ist keine bloße Inhaltsumsortierung über eine
  Whole-Document-API und kein textbasierter Abgleich neu angelegter IDs.
- Einzelannahme ist Lieferzeit → Kosten; eine umgekehrte Reihenfolge ist hier
  nicht enthalten. Andere unabhängige Reihenfolgen haben eigene Nachweise.
- Kein Drag-and-drop, gleichzeitiger Peer-Move, Listen-/Tabellen-Reparenting,
  Formatrebase, Undo/Redo oder Prozess-/GC-Neustart in diesem Browserfall.
- Ein Editor-Reload ist kein Server-Neustart. Bereits vorhandene Kandidaten-
  und BlockTree-Tests belegen ihre gesonderten Mechaniken, nicht diese fehlenden
  Browser-Varianten.
- Manuelle Benutzeränderungen haben eigene Revisionen. +1/+2 wird relativ zum
  abgeschlossenen Editor-Checkpoint gemessen, nicht zur initialen Dateianlage.
- Keine Aussage über alle Diagnose-/Metadatenschreibvorgänge abgelehnter POSTs;
  zugesichert und geprüft sind kein Live-Apply/zusätzliche Inhaltsrevision und
  unveränderter Current-Proof.
- Gesamtmatrixläufe, frisches Produktionsimage und P12 bleiben offen.
  FVRC-1008 bleibt `in_progress`; keine Produktionsaktivierung oder Push.

Cleanup entfernt ausschließlich die eigene synthetische Session und verschiebt
die eigene UUID-Datei in den normalen Papierkorb (bis zum regulären Ablauf
wiederherstellbar). Kein Fixture-, Workspace- oder Datenbank-Reset.

## Wiederholung

Mit vorbereitetem Skill-Stack und bereits laufendem aktuellen Host-Dev; keine
privaten Env-Dateien ändern, keinen zweiten Server starten:

```sh
NODE_ENV=development E2E_EXTERNAL_SERVER=1 COLLABORATION_E2E=1 \
CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1 BASE_URL=http://127.0.0.1:3000 \
PLAYWRIGHT_HTML_OPEN=never PLAYWRIGHT_HTML_OUTPUT_DIR=/tmp/fvrc1008-block-move-personal-sequential-report \
node --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env \
  --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/fixtures.env \
  node_modules/@playwright/test/cli.js test tests/file-version-center-ordinary-block-move.spec.ts \
  --grep 'personal.*sequential' --workers=1 --reporter=line,html
```

Danach die Filter `personal.*batch`, `team.*sequential` und `team.*batch`
einzeln mit eigenen Reportverzeichnissen und mindestens 55 Sekunden Abstand
zwischen den Läufen ausführen.
