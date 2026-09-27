# Review-Aktionen: Zulassung und atomare Transformationen

Stand: 27. September 2026. Quellbasis: `a834ff4a0` plus diese Änderungen.
Dieser begrenzte Schritt ist separat verifiziert. Keine Gesamtfreigabe.

## Implementierter Umfang

- Einzel- und Sammelannahme kennzeichnen ihre vorbereitende Transaktion als
  potenziell operationsanlegend. Die Workspace-Admission-Sperre wird vor
  Graph, Lineage, Dokument und State erworben. Die offene Admission wird nur
  für eine neue Operation verlangt, nicht für ein bereits gespeichertes Ergebnis.
- Review-Runtime, Graph-Storage, frische Nutzer-/Workspace-Autorisierung,
  State- und Live-Dokumentleser verwenden dieselbe SQL-Verbindung. Die aktuelle
  Nutzerrolle wird nach dem Warten erneut gelesen. State wird erst nach den
  Identitätssperren gelesen. Eine gemeinsame schreibgeschützte Leser-Fassade
  wird auch von der Agenten-Vorschlagsanlage verwendet.
- Die synthetische Annahmeoperation liest ihren State ebenfalls auf der
  übergebenen Transaktion. Das eigentliche Live-Apply und die Finalisierung
  bereits zugelassener Operationen erhalten keine nachträgliche Neuanlagesperre.
- Detach/Replace speichern neue Operation, Vorschlag, Gruppenzugehörigkeit,
  Statusauflösung und erfolgreiches Receipt in derselben initialen Transaktion.
  Es gibt keinen neu erzeugten Zwischenstand mit committed `prepared`-Receipt,
  aber noch fehlender Operation. Die bisher doppelte Proposal-Insertion entfällt.
- Historische `prepared`-Transformationen können weiterhin aufgegriffen werden.
  Wenn dafür eine neue Operation erforderlich ist, gilt derselbe Admission-Guard.
  Terminale Wiederholungen erzeugen weder eine neue Operation noch einen Vorschlag.

## Verifikation

- Runtime: 14/14; Orchestrator: 18/18; Transform-Service und Operations-Bridge
  (6/6) bestanden. Die Tests prüfen insbesondere exakt gebundene Leser,
  Ablehnung neuer Einzel-/Batchannahmen unter Reservation, Rollback ohne
  verwaistes Receipt sowie Retry und Status-Recovery bestehender Aktionen.
- `test:proposal-graph:tools`, `test:proposal-graph:review-actions`,
  `test:proposal-graph:review-ui`, `test:proposal-graph:orchestrator`,
  `test:collaboration:lifecycle` und `test:collaboration:agent-capacity`: Exit 0.
- Vollständiges `tsc --noEmit --incremental false` und gezieltes ESLint: Exit 0.
- Abschließender `npm run build`: Exit 0, einschließlich TypeScript und
  erfolgreicher Generierung der Seiten. Anschließende vollständige Typprüfung
  und gezieltes ESLint wurden ebenfalls erneut mit Exit 0 abgeschlossen.
- Neuer echter PostgreSQL-Test: 6/6 Gruppen in zwei Läufen, jeweils Exit 0.
  Reservation-first erzeugt weder Operation noch Receipt; der Graph bleibt frei
  und der Vorschlag offen. Action-first hält die Reservation bis zum
  Operationscommit auf und lässt anschließend den exakten Retry zu. Rechteentzug
  nach Guard-Wait, State-Zeilensperre bis Commit und Rollback nach
  Operationsvorbereitung sind belegt. Drei konkurrierende Aktionen schließen
  mit Pool-Maximum zwei ab, ohne einen zweiten Client unter einer eigenen
  laufenden Transaktion auszuleihen.
- Bestehender echter PostgreSQL-Test der Agenten-Vorschlagsanlage: 7/7, Exit 0.
  Nach Abschluss sind keine `canvas_pga_test_*`-/`canvas_pra_test_*`-Schemas
  übrig. Normale Datenbank: null positive Owner-Epochen, null Admission-Requests.
- Browser auf aktuellem Host-Dev: Team B/C (24,1 s), Personal B/C (16,1 s),
  Team Zehn→Drei→Sieben (55,1 s), Personal Zehn→Drei→Sieben (56,4 s), Detach
  und Replace (isolierter finaler Replace-Lauf 19,5 s) bestanden, keine Skips.
  B bleibt nach C ein konkreter Konflikt. Die Batchfälle prüfen exakte Endbytes,
  null offene Vorschläge und genau vier neue Änderungsrevisionen. Transformationen
  verändern bis zur gesonderten Annahme weder Dokument noch Inhaltshistorie.
  Die sechs zugehörigen UI-Ansichten wurden visuell geprüft.

Der neue PG-Harness verwendet reale Runtime-, Graph-, Admission-,
Autorisierungs-Verbindungs- und Operations-SQL-Mechaniken im isolierten Schema.
Autorisierungsentscheidungen, Live-Dokumentzugriff und anschließendes Apply
bleiben kontrollierte Testgrenzen: Das Apply-Fixture legt eine echte isolierte
Revision samt Operationsbeleg an, ersetzt aber keinen Live-Yjs-Apply-Test.
Dieser tatsächliche Browser-/API-/Live-Pfad ist durch die E2E-Läufe belegt.
State-Handoff wird als konkurrierender SQL-Schreiber simuliert, nicht als
vollständiges verteiltes Drain-Protokoll.

Ein unabhängiger Produktreview fand keinen verbleibenden Blocker dieses Scopes.
GitNexus wurde neu indexiert; die Prüfung des vorgesehenen Commits zeigt
17 erwartete Dateien und 151 geänderte Symbole (`low`, keine zusätzliche
Prozesskette aufgelöst). Die vorangehende Impact-Prüfung der Runtime-Aufrufer
war `medium`. Der gesamte Vergleich gegen `main` umfasst 326 Dateien und
30 Prozessketten (`critical`); dies ist ausdrücklich keine Mergefreigabe dafür.
Frühere Prüfversuche sind nicht als bestanden gezählt: Zwei Builds trafen noch
auf in Bearbeitung befindliche Test-Seams bzw. die unvollständige neue Testdatei;
ein früher Browserstart erreichte den noch nicht bereiten Host-Dev nicht. Im
gemeinsamen Detach-/Replace-Lauf trafen zwei Hintergrundabfragen des zweiten
Falls auf 429. Dieser Lauf gilt nicht als vollständig bestanden; Replace wurde
nach Ablauf des Limits separat einschließlich unveränderter Hintergrundfehler-
Assertions erfolgreich wiederholt. Limits und Fehlerbeobachter wurden nicht
abgeschwächt. Typ-/Fixturefehler des neuen Harness wurden korrigiert und danach
erneut geprüft.

Logs/Reports: `/tmp/fvrc1008-action-admission-*`; erster erfolgreicher PG-Lauf:
`/tmp/fvrc1008-proposal-review-action-admission-postgres.log`.

## Grenzen

Dieser Schritt aktiviert keine verteilten Room-Owner und keine Lifecycle-
Coordinatoren. Excalidraw-State, weitere Domainadapter, dauerhafter Candidate-
Publish und die vollständige Mehrprozess-/Crash-/Offline-Matrix bleiben offen.
FVRC-1008 und P12 bleiben deshalb unabgenommen.

Die generische FVC-Transaktion ergänzt hier keine neue automatische Recovery
nach ungewisser COMMIT-Antwort. Der identische spätere Retry prüft das gespeicherte
Receipt; er erzeugt keine zweite Anwendung. Die vollständige Aktivierung und
ihre betrieblichen Fehler-/Recovery-Verträge bleiben ein separates Gate.

Die lokale Prüfung erfolgt am aktuellen Host-Dev auf `127.0.0.1:3000` und der
verwalteten PostgreSQL-18-Instanz auf `55433`. Der unveränderte ältere Container
auf `3100` ist kein Nachweis für diese Änderungen. Kein Container-Build und
kein Push.
