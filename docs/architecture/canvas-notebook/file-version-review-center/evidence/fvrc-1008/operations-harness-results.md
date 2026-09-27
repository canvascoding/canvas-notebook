# Operations-Integration: reparierter Testaufbau

Stand: 27. September 2026, nach `8259a11e4`.
Nur Test- und Dokumentationsänderungen; keine Produktänderung oder Aktivierung.

## Ursachen und Korrekturen

- Die alten Plain-Text-Fixtures besaßen Yjs-Zustände, aber keine kanonische
  Dateiidentität. Die heutige Review-Policy konnte deshalb keine aktive Lineage
  auflösen und verweigerte direkte Anwendung. Hauptdokument, Checkpoint-Race
  und beide Saga-Dokumente erhalten ihre Identität jetzt über
  `getFileCollaborationState({ ensureDocument: true })`.
- Neue `independentGroups`-Aufträge müssen nach aktueller Sicherheitsregel ins
  Review. Der Test prüft das ausdrücklich: keine angewendeten Ziele, keine
  Änderung an Live-Text oder gespeicherten Yjs-Bytes, kein Direct-Aufruf.
- Der bisherige Test für verspätete Bestätigung einer Teilanwendung bleibt
  erhalten. Er erzeugt einen **historischen** Teilanwendungsbeleg aus dem echten
  `applyAgentTextTargets`-Ergebnis und Snapshot in der isolierten Datenbank.
  Ein Ziel wurde angewendet, das andere kollidiert. Vor dem Speichern bleibt
  die Bestätigung aus; danach bestätigen die realen Dienste die Haltbarkeit,
  ohne den Konflikt zu löschen. Ungültige Annahme und Recovery dürfen diesen
  Beleg nicht herabstufen. Diese Fixture prüft nicht den Legacy-Revert-Payload;
  die getrennten echten Apply-/Revert-Fälle bleiben unverändert.
- Das Cleanup entfernt die zu diesem UUID-Workspace gehörenden Change-Groups
  vor ihren Operationsbelegen. Ein Fehler beim Aufräumen verdeckt die ursprüngliche
  Assertion nicht mehr im Log.
- Der Personal-Workspace-Test nutzt PostgreSQL-Platzhalter, schließt seinen
  Pool auch bei Fehlern und stellt beide Datenpfad-Variablen wieder her. Er
  verweigert nichtlokale und nicht explizit als UUID-Testdatenbank benannte DBs.

Die Low-Level-Fälle ohne vollständigen File-Tool-Beleg bleiben absichtlich
Legacy-Kompatibilitätstests. Die späteren regulären PI-Tool-Fälle prüfen
zusätzlich gebundene Dateioperationen. Kein Grant-, Policy- oder Merge-Dienst
wurde hierfür abgeschwächt oder durch einen Erfolgs-Stub ersetzt.

## Nachweis und Ausführungsprofil

`npm run test:collaboration:operations` führt beide Skripte tatsächlich aus:

1. `file-agent-operation-integration-test.ts`
2. `personal-workspace-collaboration-integration-test.ts`

Zwei vollständige serielle Läufe bestehen auf PostgreSQL 18.4 aus dem vorhandenen
verwalteten Stack auf `127.0.0.1:55433`. Jeder Lauf verwendet eine neu angelegte
Datenbank `canvas_editor_test_<32 Hex-Zeichen>` und ein neues absolutes temporäres
`DATA`/`CANVAS_DATA_ROOT`. Vor dem Start laufen die regulären
`runPostgresMigrations`; `NODE_ENV=test`, Provider `postgres`, Modus `external`.
Die private Host-Dev-Env liefert die Zugangsdaten, die nicht ausgegeben werden.
Nach dem bestätigten Prozessende wird ausschließlich diese Testdatenbank
entfernt. Keine Workspace-Fixtures und keine App-Datenbank werden zurückgesetzt.

Nachweise unter `/tmp/`:

- `fvrc1008-broad-harness-full-final.log`: beide Skripte `ok`, Prozess Exit 0,
  Datenbank `canvas_editor_test_bfdc4ec1adf54492b2e8360e99128498` entfernt.
- `fvrc1008-broad-harness-full-repeat.log`: beide Skripte erneut `ok`, Exit 0,
  Datenbank `canvas_editor_test_8a5d6b7d695a40f58e50bf55ae8debf7` entfernt.
- `fvrc1008-broad-harness-lint-final.log`: ESLint beider geänderter Skripte.
- `fvrc1008-broad-harness-types-final.log`: vollständiger TypeScript-Projektcheck.
- `fvrc1008-broad-harness-stack.log`: genau vier gesunde unveränderte Container.

Die realen PostgreSQL-Dienste werden ausgeführt; die Suite verwendet aber eine
lokale Direct-Connection-Testbrücke statt zweier App-Prozesse. Sie ersetzt
weder die Mehrprozess-/Crashabnahme noch die vollständige Browsermatrix.
Der Produktquellstand und die vier Browsernachweise aus
[Room owner runtime results](room-owner-runtime-results.md) bleiben unverändert.
Lifecycle-Entzug, Quarantäne-Recovery, atomarer Kandidatencommit und P12 bleiben
offen; FVRC-1008 bleibt `in_progress`.
