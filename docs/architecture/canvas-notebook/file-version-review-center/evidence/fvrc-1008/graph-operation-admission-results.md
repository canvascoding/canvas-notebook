# Graph-Vorschläge: Zulassung innerhalb einer SQL-Transaktion

Stand: 27. September 2026. **Graph-Operationszulassung separat verifiziert.**
Quellbasis: `b1fda8365` plus die hier dokumentierten Änderungen.

## Begrenzter Umfang

Dieser Schritt schließt neue Agenten-Vorschläge im Proposal Graph an die
persistente Collaboration-Admission an. Er aktiviert weder Room-Owner/Fleet
noch Lifecycle-Coordinatoren. Die vorher separat geprüften
[verbindungsgebundenen Leser](graph-scoped-read-results.md) werden jetzt vom
Graph-Runtime-Aufrufer verwendet.

- Provenance-Transaktionen kennzeichnen ihren Zweck ausdrücklich als `read`
  oder `create_operation`. Neue Vorschläge benötigen einen Workspace-
  Admission-Guard vor Graph-, Lineage-, Dokument- und State-Zeilensperren.
- Runtime und Graph-Storage teilen dieselbe äußere Transaktion. Eine
  transaktionsgebundene Leser-Fassade prüft Sitzung und Rechte frisch nach
  dem Warten. Ohne Sitzung wird die heutige Nutzerrolle erneut gelesen.
- Live-Dokumentleser und Operationsvorbereitung lesen den persistierten
  Zustand ebenfalls auf dieser Verbindung; unter den Sperren wird kein
  zusätzlicher Pool-Client ausgeliehen.
- Neue Anlage prüft Admission vor Kandidatenvorbereitung und erneut direkt
  vor dem Operations-INSERT. Operation, Proposal und Artefakte committen
  zusammen oder rollen zusammen zurück.
- Eine exakt nachgewiesene Wiederholung gibt ihren ursprünglichen Vorschlag
  auch während einer aktiven Reservation zurück. Sie liest dazu keinen
  heutigen Live-Kandidaten und erzeugt keine zweite Operation.
- Rechte-/Sitzungsprüfung bleibt auch für Wiederholungen Pflicht. Ein
  geänderter Lifecycle bleibt ungültig; der Retry ist kein Scope-Bypass.
- Bestehende Review-Transformationen behalten ihre eigenen Transaktionen;
  der zusätzliche Provenance-Parameter allein aktiviert dort keine Admission.

## Nachweise

- `npm run build`: Exit 0, einschließlich Next-TypeScript-Prüfung. Separater
  vollständiger `tsc --noEmit --incremental false`: Exit 0.
- `npm run test:proposal-graph:tools` und
  `npm run test:collaboration:lifecycle`: vollständig Exit 0.
- Provenance-Unit-Suite: 15/15; echter Provenance-/Graph-Storage-SQL-Test:
  bestanden. Operations-Bridge: 6/6 einschließlich null globaler State-Loads.
- Review-Transform-Service und Relationship-Policy (14 Gruppen): bestanden;
  keine unbeabsichtigte Erweiterung dieser gesonderten Runtime-Pfade.
- Gezieltes ESLint für Produktänderungen und Bridge: Exit 0.
- B/C-Browserpfad auf aktuellem Host-Dev: Team 1/1 (24,0 s), Personal 1/1
  (16,2 s), keine Skips. Nach Annahme C bleibt B konkret konfliktbehaftet
  statt Timeline-Fehler; beide Screenshots visuell geprüft.
- Sammelannahme: Team 1/1 (54,4 s), Personal 1/1 (55,3 s). Jeweils zehn
  unabhängige Vorschläge, drei einzeln und sieben gemeinsam angenommen;
  exakter Inhalt, keine offenen Vorschläge und genau vier neue
  Änderungsrevisionen. Beide Screenshots visuell geprüft; keine Skips.
- Bestehende Agent-Capacity-/Pool-/Admission-Suites: Exit 0.
- PGlite-Runtime-Harness: 14/14 Gruppen; explizite und gewöhnliche
  unabhängige Anlage unter Reservation, beide exakten Retry-Pfade ohne
  aktuellen Kandidaten, gleiche Verbindung für Berechtigungen/State,
  Read-Intent ohne Admission-Guard und Create-Intent mit Guard.

- Echter PostgreSQL-Test: 7/7 Gruppen in zwei finalen Läufen, jeweils Exit 0.
  Drei konkurrierende Anlagen schließen mit nur zwei Pool-Clients erfolgreich
  ab; jede Operation verwendet genau ein Backend. Der Harness verweigert
  zusätzliche Default-/Fixture-Zugriffe unter einer laufenden Transaktion.
  Reservation-first verweigert neue Anlage; Graph-first lässt Reservation bis
  zum Commit warten. Exakter Retry unter der anschließenden Reservation ist
  unverändert wiederverwendbar. Berechtigungsentzug während Guard-Wait wird
  erkannt. Beide Reihenfolgen an der State-Zeilensperre und vollständiger
  Rollback nach Operations-INSERT sind belegt, einschließlich Artefakten,
  Evaluationen und Pins.

Diese PG-Tests verwenden echte Runtime-, Provenance-, Storage-, Admission-
und Operations-SQL-Implementierungen in zufällig benannten leeren Schemas.
Berechtigungen und Live-Zugriff bleiben kontrollierte Testgrenzen: Die
Autorisierungsgrenze liest eine Testfreigabe auf der übergebenen Verbindung,
der Live-Reader erzeugt ein Yjs-Dokument aus dem echten persistierten Snapshot.
Die State-Handoff-Fälle simulieren den Lifecycle-Schreiber, nicht das gesamte
Owner-Drain/Handoff-Protokoll. Der tatsächliche Hocuspocus-Reader wurde in der
Vorstufe geprüft; der echte Auth-/UI-Pfad ist durch die Browserläufe abgedeckt.

Nach Abschluss der PG-Läufe: keine übrig gebliebenen Testschemas. Das normale
`public`-Schema bleibt bei `owner_epochs=0` und `admission_requests=0`.
Vollständiger TypeScript-Check und gezieltes ESLint wurden auch nach den letzten
Harness-Ergänzungen erneut mit Exit 0 abgeschlossen. Ein unabhängiger
Produktcode-Review fand keinen verbleibenden Blocker dieser begrenzten Änderung.

GitNexus wurde vor dem Commit neu indexiert: 12 erwartete Dateien, 133
geänderte Symbole, eine betroffene Create-Prozesskette, Risiko `medium`.
Der vollständige Branch-Vergleich zu `main` bleibt mit 323 Dateien und 30
Prozessketten `critical`; diese Teilabnahme ist keine Mergefreigabe dafür.

Logs und Browserreports: `/tmp/fvrc1008-graph-admission-*`.
Zusätzlicher erster finaler PG-Log:
`/tmp/fvrc1008-proposal-agent-admission-postgres-final.log`.
Bekannte Buildwarnungen zu dynamischen FS-Imports/Auth-Konfiguration und
fehlenden lokalen Seed-Skill-Dateien im Host-Dev sind nicht Teil dieses Fixes.
Der erste manuelle Start der Provenance-Unit-Suite ohne `react-server`-Condition
wurde vom `server-only`-Guard abgewiesen; der korrekte Paket-/Server-Testlauf
bestand anschließend. Dieser Fehlstart zählt nicht als bestandener Test.

## Bewusste Grenzen

`prepareProposalGraphActionOperation` (Annahme/Sammelannahme), weitere
Lifecycle-Domainadapter, durable Candidate-Publish, Mehrprozess-Owner-
Aktivierung und die vollständige Crash-/Offline-Matrix bleiben separat offen.
Ein erfolgreicher B/C-Browserlauf belegt nicht diese fehlenden Protokollpfade.

Die bestehende Datenbank-Transaktion führt nach einer ungewissen Commit-
Antwort keine automatische Neuanlage aus. Ein späterer Aufrufer muss dieselbe
Idempotenzkennung erneut verwenden; Operation und Graph-Bezug werden dann
zusammen auf exakte Identität geprüft. Eine neue positive Commit-Recovery-
API ist nicht Bestandteil dieser Änderung.

Getestet wird am aktuellen Host-Dev auf `127.0.0.1:3000` mit der verwalteten
PostgreSQL-18-Instanz auf `55433`. Der unveränderte ältere Container auf
`3100` ist kein Nachweis für diesen Worktree. Kein Container-Build, kein Push
und keine Produktionsfreigabe. FVRC-1008 bleibt `in_progress`.
