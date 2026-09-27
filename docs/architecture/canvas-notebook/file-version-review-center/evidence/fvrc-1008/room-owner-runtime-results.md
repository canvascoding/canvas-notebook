# Live-Raum-Anbindung des Ownership-Fence

Stand: 27. September 2026. Aufbauend auf `120170347`.
**Teilbaustein von FVRC-1008, keine Produktionsaktivierung oder Gesamtabnahme.**

## Umsetzung

`createCollaborationServer` kann eine Ownership-Session-Factory entgegennehmen.
Der reguläre Bootstrap liefert sie bewusst noch nicht; es gibt keinen neuen
Environment-Schalter, der die fehlenden Lifecycle-Gates umgehen könnte.

- Eine dedizierte Sitzung pro Serverinstanz, lazy geöffnet, mit begrenzter
  Initialisierungswartezeit und höchstens einem laufenden Heartbeat.
- Der Scope kopiert ausschließlich sieben skalare Identitätsfelder; große
  Yjs-/State-Vector-Snapshots werden nicht in den Owner-Handles festgehalten.
- Ein Fence gehört zur konkreten Y.Doc-Instanz. Ein anderer gleichnamiger Raum
  wartet auf die bestätigte Freigabe des Vorgängers; zwei aktive Instanzen
  bekommen keine reentrante Freigabe.
- Nach dem Claim wird erneut aus PostgreSQL geladen. Ein letzter Store des
  vorherigen Owners darf nicht durch einen älteren Vorab-Snapshot verschwinden.
- Sync-Mutationen, Direct-Connection, Live-Reader, Reconciliation und Stores
  prüfen die Raumzuständigkeit. Der Store erhält den exakten Fence als fünften
  Parameter. Nach Verlust werden keine Durability-/Projection-Acks gesendet.
- Die normale Freigabe beginnt beim tatsächlichen Destroy, nicht im
  `beforeUnloadDocument`-Hook: Neue Verbindungen können ein geplantes Unload
  noch abbrechen. `afterUnloadDocument` wartet auf die Freigabe.
- Fehler nach erfolgreichem Claim, einschließlich ungültiger Ladebytes, geben
  den Claim explizit frei. Ein während des Claims zerstörter Raum bleibt nicht
  als unsichtbarer Owner zurück.
- Sitzungsverlust sperrt alle betroffenen Räume terminal. Peers werden
  schreibgeschützt und getrennt; unbestätigte Live-Dokumente bleiben in
  Quarantäne. Kein automatischer Replay unter einem neuen Token.
- Hocuspocus verschluckt bestimmte Store-Fehler. Deshalb prüft auch der
  Direct-Aufrufer nach dem Disconnect nochmals den Runtime-Zustand.
- Die asynchrone semantische Konfliktprüfung kontrolliert bekannte lokale
  Invalidierung am Eingang und nach ihrem SQL-Read. Ein Abbruch verändert den
  Operationsbeleg nicht und erhält das Prüfungsfenster für einen späteren
  Versuch. Der Fire-and-forget-Hook behandelt Owner-Verlust ohne unhandled
  rejection. Das ist ausdrücklich noch kein atomarer SQL-Metadaten-Fence.

Die bisherigen, noch nicht aktivierten Rename-Semantiken bleiben unverändert.
Die volle Pfad-/Organisationsbindung gilt für den neuen Owner-Pfad.

## Verifikation

Erfolgreich auf dem finalen Quellstand:

- `test:collaboration:room-owner`: sieben Session-Fehlerfälle plus acht neue
  Runtime-Szenarien. Reale Y.Doc-Instanzen, simulierte Owner-Sitzung.
- Neuer `collaboration-room-owner-server-test.ts`: echter Hocuspocus-Receiver,
  DirectConnection und Unload mit simulierter Owner-/Persistenzgrenze. Prüft
  Fresh-Reread, exakten Store-Fence, Load-Fehler-Freigabe, abgebrochenes Unload,
  generischen geschluckten Speicherfehler, Direct-Rejection, gesperrte wartende
  Peer-Änderung/Reconciliation sowie Quarantäne ohne falschen Durability-Ack.
  Ein separater Fixture-Lauf beweist ausdrücklich die Reihenfolge: Direct-
  Callback verändert Live-Inhalt → finaler Store scheitert → Hocuspocus
  verschluckt den Fehler → Direct-Promise lehnt trotzdem ab. Unpersistierte
  Bytes bleiben im Raum; eine verspätete `onChange`-Prüfung endet kontrolliert.
- Gesamte `test:collaboration:lifecycle`, `test:collaboration:projection` und
  `test:collaboration:agent-durability`.
- Vollständiger TypeScript-Projektcheck (`--noEmit`), fokussiertes ESLint
  und `git diff --check`.
- `npm run build`: 353 Seiten, 31 bekannte Turbopack-Warnungen, Exit 0.
- Separater echter PostgreSQL-Ownership-Test erneut grün: mehrere Sitzungen,
  konkurrierende Claims, Row-Lock-Reihenfolge, Owner-Verlust während Write,
  Übernahme und tatsächlich committeter Claim mit verlorener Bestätigung.
  Eigenes UUID-Schema danach entfernt; keine Aktivierung im App-Datenbestand.

Vier serielle Browserregressionen am Host-Dev **127.0.0.1:3000**, mit einem
Worker, gewöhnlichen Tool-Aufrufen, echten Reviews und Screenshots:

| Workspace / Szenario | Ergebnis | Bericht unter `/tmp/` |
|---|---|---|
| Personal: überlappende B/C, C zuerst annehmen | grün, 25,7 s | `fvrc1008-live-owner-personal-conflict-report/index.html` |
| Team: überlappende B/C, C zuerst annehmen | grün, 16,3 s | `fvrc1008-live-owner-team-conflict-report/index.html` |
| Personal: zehn Vorschläge, drei einzeln + sieben im Batch | grün, 57,7 s | `fvrc1008-live-owner-personal-batch-report/index.html` |
| Team: zehn Vorschläge, drei einzeln + sieben im Batch | grün, 57,9 s | `fvrc1008-live-owner-team-batch-report/index.html` |

Der Konflikt bleibt konkret offen statt als Timeline-Fehler zu erscheinen.
Batch prüft exakten Endtext, Proposal-Zustände, vier neue Inhaltsrevisionen,
gebundene Aktionsbelege und idempotente Wiederholungen. Alle vier Screenshots
wurden angesehen. Diese Browserläufe prüfen den **noch ungefencten Default**;
die neue Ownership-Anbindung wird separat im Server-Test aktiviert. Sie sind
kein Beweis für den noch ausstehenden Zwei-App-/PostgreSQL-Cutover.

Der erste Personal-Konfliktlauf war rot, weil im separaten Tool-Worker die
lokale Graph-Policy fehlte (`durability: needs_review` statt `not_applied`).
Korrigierter Aufruf: Server **und** Worker mit `COLLABORATION_E2E=1`,
`CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1`, Worker zusätzlich `NODE_ENV=development`.
Keine Erwartung und kein Produktverhalten wurden dafür abgeschwächt.

Der Stack-Skill bestätigt weiterhin genau vier gesunde Services: älteres
Notebook-Image auf 3100, PostgreSQL 18.4/pgvector 0.8.3 auf 55433 sowie
Control Plane 4001/4004. Kein Container wurde gebaut, ersetzt oder neu gestartet.

Logs tragen den Präfix `/tmp/fvrc1008-live-owner-`:
`owner-final.log`, `runtime-final.log`, `durability-final.log`,
`lifecycle-final.log`, `projection.log`, `types-complete.log`,
`lint-complete.log`, `stack-final.log` sowie die vier Browserlogs.
Zusätzlich `build-final.log`, `postgres.log`, `preflight.log`: der lesende
Bestands-Preflight findet 883 Zustände und **0** beanspruchte Owner-Epochen.
`test:collaboration:semantic-owner:postgres` besteht in einer neu migrierten
`canvas_editor_test_<UUID>`-Datenbank: kanonische Dateiidentität über reguläre
API, echte Grant-/Operations- und Persistenzdienste, nur der Direct-Connection-
Transport als lokale Testbrücke. Entry-Abbruch und Abbruch nach SQL-Read ändern
weder Status noch CAS-Version; der Retry nutzt das erhaltene Fenster und setzt
genau einmal `semantic_conflict` mit CAS +1. Die Testdatenbank wurde danach
entfernt. Log: `operations.log`; isolierte Diagnosedateien bleiben unter
`/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/fvrc1008-semantic-owner-guard-VUzDI8`.

Der ältere Terminalstatus-Testaufbau lud die inzwischen hinzugekommenen
Server-Abhängigkeiten außerhalb seines Compile-Harness. Er bindet jetzt die
echten Module `persistence-merge` und `room-owner` ein; die SQLite-Fixture
enthält die inaktive Owner-Epoche 0. `.ts`-Module werden nicht mehr als JSX
transpiliert. Keine Merge-/Fence-No-ops und keine abgeschwächten Assertions.
Die danach vollständig erneut ausgeführte Durability-Suite ist grün.

Nicht als grün gewertet: Die ältere breite
`file-agent-operation-integration-test.ts`-Suite erreicht die neue Prüfung
nicht. Frische DBs benötigen zuerst die regulären Startmigrationen. Danach
fehlt in ihrem frühen Direktfreigabe-Fixture eine kanonische Dateiversions-
Identität; nach diagnostischer Korrektur folgt ein weiterer veralteter
`independentGroups`-Vertrag (heutige Policy erzwingt dort Review). Die temporäre
Fixture-Korrektur wurde vollständig zurückgenommen, die breite Suite bleibt
unverändert. Ihre Aktualisierung ist separat offen; weder Assertions noch
Produkt-Schutzregeln wurden abgeschwächt. Alle hierfür erzeugten Datenbanken
wurden entfernt, die verwalteten Workspace-Daten nicht zurückgesetzt.

GitNexus nach Reindex und abschließendem Staged-Scan: neuer Commitumfang
12 Dateien / 142 indexierte Symbole / keine
zusätzlich erfassten Prozessketten, LOW. Der gesamte bestehende Feature-Branch
gegen `main` bleibt CRITICAL (244 Dateien / 30 Prozessketten); diese lokale
Prüfung ersetzt seine Gesamtfreigabe nicht.

## Verbindliche Aktivierungsgrenzen / nächste Arbeit

Quarantäne verhindert falsche Bestätigungen; sie ist **noch kein vollständiger
Wiederanlauf**. Sichere Weiterarbeit nach Verlust, einschließlich Erhalt
unabhängiger Offline-Änderungen, muss vor Aktivierung implementiert und mit
zwei echten App-Prozessen bewiesen werden. Die separat bereits getesteten
PostgreSQL-Primitivtests ersetzen diese Live-Integration nicht.

Der Lifecycle-Audit findet weitere ungefencte Schreiber: Kompaktierung,
Repräsentationswechsel, Archivierung, Rename/Move, Restore sowie Copy mit
bestehendem Ziel. Bei Subtrees müssen Quell- und Zielmenge berücksichtigt
werden, beim Restore auch das bisher aktive Ziel und die archivierte Quelle.

Die notwendige Entzugsreihenfolge ist:

1. Dauerhafte Revocation-Reservation; neue Claims sperren, alten finalen Store
   weiterhin erlauben. Token/Epoch nicht vor diesem Store invalidieren.
2. Owner prozessübergreifend benachrichtigen, unter der lokalen Mutationssperre
   quieszen, final speichern, entladen und freigeben.
3. Lifecycle-Writer nimmt dieselben Advisory-Locks in stabiler Reihenfolge,
   dann Workspace-Lock, Pfadlocks und Zustandszeilen; Scope erneut prüfen.
4. Mutation/Commit, anschließend Reservation und Guards freigeben.

Wichtig: Bereits äußere Rename/Delete/Restore-/Agent-/Copy-Aufrufer nehmen
Workspace-Locks. Ein Entzug erst innerhalb von `collaboration-policy.ts` wäre
zu spät: Der finale History-Capture benötigt selbst den Workspace-Lock und
könnte sonst mit dem wartenden Lifecycle-Aufrufer deadlocken. Während des
Room-Drain keine Workspace-, Pfad- oder Zustandszeilensperre halten.

Es fehlen außerdem atomarer Kandidatencommit vor Live-Publish, Crash-Recovery,
versionsgebundenes Fleet-/Rollback-Gate, volle PG-S-/MR-Abnahme und P12.
Keine Aktivierung bei gleichzeitig laufenden alten Servern; kein Container-
Neubau und kein Push in diesem Arbeitsschritt.
