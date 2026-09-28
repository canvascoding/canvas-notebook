# Reine Löschung und leeres Dokument: Persistenznachweis

Stand: 26. September 2026. Ausgangscommit `ecfc33de1`. Ergänzung zu PG-S20 in
FVRC-1008; keine vollständige Gate- oder Produktionsfreigabe.

## Reale Änderung statt Nullwirkung

`tests/file-version-center-ordinary-deletion.spec.ts` legt ein eigenes Markdown-
Dokument mit genau einem Rich-Paragraphen an: `Rot bleibt. Grün entfällt.`
(ohne finalen Zeilenumbruch). Ein gewöhnliches `read(source: blocks)` liefert
seine Dokumentreferenz, stabile Block-ID und Inhalt. Der registrierte
`edit_file`-Aufruf adressiert diesen Block und ersetzt entweder den Suffix
` Grün entfällt.` oder den vollständigen Inhalt durch den leeren String.

Das ist eine echte Y.Text-Löschung über den normalen Agententoolpfad, kein
vorbereiteter Graphknoten und kein versteckter Browser-/Yjs-Schreibzugriff.
Review wird ausdrücklich eingeschaltet. Beide Werkzeugvarianten liefern
`review_required/not_applied`; vor der Bestätigung bleiben Inhalt und Revision
unverändert.

Die Fälle unterscheiden einen leeren **Dokumentinhalt** von einem fehlenden
Kandidaten. Bei vollständiger Löschung bleibt der existierende Paragraph als
leerer Rich-Block mit derselben ID erhalten. Es wird weder der Datei-Eintrag
gelöscht noch behauptet, dass die Rich-Struktur keine Knoten mehr enthält.

## Geprüfte Orakel

- Verfügbarer Graphvergleich, Status `clean`, `contentAvailable: true`,
  `noEffect: false`, echte Löschzeile und aktive Inhaltsannahme. Kein
  Nullwirkungsabschluss und kein veralteter Timeline-Fehler.
- Annahme über sichtbaren Button und Bestätigung liefert `content_changed`,
  genau den gewählten Vorschlag als `applied` und exakt eine neue Revision.
- Fester Endtext ist entweder `Rot bleibt.` oder wirklich `''`; Inhalts-,
  Struktur-, Delete-Set- und Full-State-Hash ändern sich, während der
  **State-Vector-Hash unverändert** bleibt.
- Ein separater Node-Prozess lädt ausschließlich die persistierte PostgreSQL-
  Binärsnapshot der UUID-Testdatei. Er prüft Workspace/Dokument/Pfad und die
  Zustandskonsistenz, nicht nur den Live-Raum oder die HTTP-Antwort.
- Gespeicherter kanonischer Inhalt und Content-/Structure-/Vector-/Delete-Set-
  Proof stimmen mit dem Aktionsbeleg überein. Die gespeicherte Dokumentsequenz
  steigt; der kombinierte Snapshot-Proof ist vollständig, nicht null und hat
  sich geändert. Der gespeicherte Binärzustand ist nicht als degradiert markiert.
- Der normale History-Endpunkt enthält die neue Revision mit verfügbarem
  Inhalt, korrektem SHA-256 und exakter Bytezahl. Beim leeren Dokument sind das
  **0 Bytes**, kein `metadata_only` und kein fehlender Inhalt.
- Derselbe Aktionsrequest liefert denselben Beleg; Inhalt und Revisionszahl
  bleiben erhalten. Genau ein Browser-Aktions-POST. Nach erneutem Öffnen ist
  der exakte Vorschlag historisch/nicht annehmbar, der gespeicherte
  Snapshot-Proof bleibt unverändert.

Der lokale, bereits vorhandene Leser `collaboration-e2e-storage-read.ts` wurde
nur um das UUID-Präfix `fvrc-1008-ordinary-` und einen optionalen Graph-Proof
erweitert. Weiterhin: E2E-Flag erforderlich, Datenbank ausschließlich loopback
55433, exakte Zuordnung zum angefragten Workspace/Dokument/Pfad, keine
Datenmutation. Bestehende Aufrufer bekommen ohne Option kein zusätzliches
Graph-Proof-Feld.

## Umgebung und Nachweise

Ein verwalteter `canvas-local-team-seat-dev`-Stack: PostgreSQL 18.4 / pgvector
0.8.3 auf 55433; aktueller Worktree als Host-Dev auf **127.0.0.1:3000**.
Der ältere Notebook-Container auf **3100** ist nicht der getestete Quellstand.
Keine Env-/Policyänderung, kein Fixture-Reset und kein neues Containerimage.
Alle Browserfälle laufen einzeln mit einem Worker und ohne parallelen
Browserlauf. Aufgeräumt werden nur die eigenen Sessions und UUID-Dateien
(Dateien per gewöhnlicher Lösch-API in den Papierkorb).

| Finaler Lauf | Ergebnis | Dauer | Revisionen | Browser-Aktions-POSTs |
|---|---|---|---|---|
| `partial-personal-r2` | bestanden | 20,5 s | 1 → 2 | 1 |
| `empty-personal-r2` | bestanden | 20,4 s | 1 → 2 | 1 |
| `partial-team-r1` | bestanden | 19,3 s | 1 → 2 | 1 |
| `empty-team-r1` | bestanden | 19,5 s | 1 → 2 | 1 |

Logs `/tmp/fvrc1008-deletion-<Laufname>.log`, HTML-Reports
`/tmp/fvrc1008-deletion-<Laufname>-report/index.html` mit JSON-Nachweisen und
Screenshot der tatsächlich sichtbaren Löschvorschau. Im ersten Personal-
Teil-Lauf war ausschließlich der letzte Historical-UI-Selektor falsch; der
produktive Apply und die Persistenzassertionen liefen vorher durch. Der
Selektor wurde am bestehenden `graph-review-historical-status` korrigiert,
nicht die Produktfunktion. Danach liefen alle vier Fälle mit dem finalen Spec.
Der frühe `empty-personal-r1` war ebenfalls grün; r2 enthält zusätzlich die
expliziten Strukturhash- und gespeicherten Reload-Assertions.

Finaler Spec-SHA-256:
`6314d3d93079ae1303e9705ca3f5eda802aca8d789f2fb4ef085a0ac2b5762c9`.

- 34 fokussierte Candidate-/State-Proof-/Durability-Tests bestanden:
  `/tmp/fvrc1008-deletion-regression-r1.log`. Enthält reine Delete-Ranges,
  Pending Deletes/Structs, ungültige/fehlende Snapshots und strukturelle
  Lösch-/Formatierungs-Konflikte. Isolierte Yjs-Fixtures, nicht echte PG-Browser.
- Vollständiges TypeScript ohne inkrementellen Cache sowie fokussiertes ESLint
  ohne Fehler/Warnungen: `/tmp/fvrc1008-deletion-typecheck-r2.log`,
  `/tmp/fvrc1008-deletion-lint-r2.log`.
- `NODE_ENV=production npm run build` einschließlich Lizenzgate bestanden,
  353/353 Seiten, Exit 0; `/tmp/fvrc1008-deletion-build-r1.log`. 31 bestehende
  Turbopack-Warnungen bleiben sichtbar. Es wurde kein Containerimage gebaut.

Kein Anwendungscode wurde für diese Nachweise geändert.

Die tatsächlichen JSON-Anhangkörper aller vier finalen Reports wurden separat
ausgelesen: feste Endtexte, unveränderter Vector, geändertes Delete-Set und
Struktur, persistierte Sequenz 0→1, jeweils verfügbare History mit 11 bzw.
0 Bytes, Revisionen 1→2 und genau ein Aktions-POST. Die Teil-/Voll-Löschvorschau
wurde anhand der Screenshots visuell geprüft. Die verwalteten vier Dienste
und der aktuelle Host-Dev sind abschließend gesund;
`/tmp/fvrc1008-deletion-stack-final.log` dokumentiert den Stack.

## Einordnung der Binärhashes

In den realen Nachweisen unterscheiden sich der vollständige Binärhash des
Kandidaten im Aktionsbeleg und der erneut geladenen PostgreSQL-Snapshot trotz
gleichem Inhalt, Struktur, State-Vector und Delete-Set. Diese Werte werden
bewusst nicht nachträglich gleichgesetzt: `waitForProposalCandidateDurability`
liefert den Proof des freigegebenen Kandidaten, nachdem
`stateConfirmsAgentOperation` den gespeicherten Zustand geprüft hat. Letzteres
verwendet `persistedUpdateIncludesAgentSnapshot`: integrierte Clocks **und**
Delete-Ranges müssen enthalten sein; Pending Structs/Deletes werden abgewiesen.
GC kann die Binärdarstellung verändern, ohne diese Wirkung zu verlieren.
Der Test fordert deshalb vollständige gespeicherte Wirkung und veränderte
gespeicherte Bytes, aber keine unbegründete Bytegleichheit zum Kandidaten.

Davon getrennt bleibt der offene PG-S19-Fall eines Absturzes **vor** dem
gespeicherten Operationssnapshot: `proposalRecoveryCurrentMatches` prüft im
Status `applying` aktuell den exakten Kandidaten-Proof. Die normalen erfolgreichen
Löschläufe beweisen keine Recovery über diese GC-/Crash-Grenze und lockern
diese Sicherheitsprüfung nicht.

Ein Subagent hat die Werkzeug-/Testorakel und anschließend diese Runtime-
Unterscheidung unabhängig lesend geprüft. Kein normaler Apply-/Receipt-Fehler
gefunden; die mögliche konservative Recovery-Verweigerung nach GC bleibt
ausdrücklich als separater PG-S19-Nachweis offen. GitNexus meldet für den
finalen Test-/Dokumentationsumfang fünf Dateien, 16 Symbole, keinen erfassten
Produktprozess und niedriges Risiko. Der Gesamtbranch gegen lokales `main`
bleibt mit 205 Dateien, 1582 Symbolen und 30 Prozessen kritisch; das ist keine
Gesamtfreigabe. Generierte `AGENTS.md`-/`CLAUDE.md`-Indexzählungen bleiben draußen.

## Grenzen

Nachtrag: [Recovery GC results](recovery-gc-results.md) dokumentiert den
anschließenden reproduzierten Fehler und engen Runtime-Fix für diesen
`applying`-Abgleich. Der echte Prozessabsturz-Nachweis bleibt offen; die oben
beschriebenen normalen Löschtests allein belegen keine Crash-Recovery.

- Dieser neue Browsernachweis gilt für blockgebundene reine **Textlöschungen**
  einschließlich des vollständig leeren Markdown-Inhalts. Eine strukturelle
  `delete_block`-Operation mit Eltern-/Kindknoten ist nicht derselbe Fall.
- Pending Delete-Sets, kausal unvollständige Updates, Garbage Collection und
  fehlende/defekte Snapshots werden in der fokussierten Unit-/Yjs-Suite geprüft;
  solche Zustände werden nicht künstlich in die verwaltete Nutzerdatenbank
  geschrieben. Der neue Browserfall belegt eine vollständig integrierte
  Löschung mit tatsächlicher PostgreSQL-Persistenz.
- Kein Prozess-/Containerabsturz oder Reopen des Serverprozesses. Ein neuer
  DB-lesender Prozess und UI-Reload sind kein Server-Restart-Test.
- Der Nachweis gilt für Datenbank-Binärpersistenz und verfügbare History;
  ein separat verzögerter Dateiexport wird hier nicht injiziert/geprüft.
- FVRC-1008, zwei vollständige Matrixläufe, frisches Image und P12 bleiben offen.
