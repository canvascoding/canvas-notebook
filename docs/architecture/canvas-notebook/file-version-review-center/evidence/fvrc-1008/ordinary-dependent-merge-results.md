# Gewöhnliche abhängige Markdown-Vorschläge

Stand: 26. September 2026. Alle acht abschließenden Browserfälle bestanden.
Teilnachweis für FVRC-1008, keine Produktionsfreigabe.

## Aufbau und feste Orakel

`tests/file-version-center-ordinary-dependencies.spec.ts` verwendet dieselben
authentifizierten API-/Agentenwerkzeug-Helper wie die gewöhnlichen Rich-Markdown-
Tests. Produktbasis ist unverändert `542c99dc2`, Testbasis `564678bdd`.
Geprüft wird der aktuelle Worktree auf Port 3000 am einzigen verwalteten
PostgreSQL-18.4-/pgvector-0.8.3-Stack, nicht das ältere Container-Image auf 3100.
Personal und Team verwenden jeweils den Administrator. Kein LLM ist notwendig.

Alle drei Vorschläge entstehen vor der ersten Annahme auf dem unveränderten
Dokument mit Kosten 10 EUR und Lieferzeit 5 Tage:

- P1 verwendet das registrierte `edit_file`, setzt Kosten auf 12 EUR und fügt
  einen neuen Absatz `Deckung: 100 EUR` ein.
- Der registrierte `read` liest ausdrücklich den noch offenen P1-Kandidaten.
  P2 verwendet den zurückgegebenen Quellnachweis, CAS-/Kandidatenhash und die
  echte neue Block-ID für `edit_file` mit `creationKind: extends`; er ändert
  ausschließlich `100 EUR` zu `150 EUR` im neuen Absatz.
- Q ist ein unabhängiger `edit_file`-Vorschlag auf derselben autoritativen
  Quelle wie P1 und setzt die Lieferzeit auf 3 Tage.

Es werden keine Graphknoten direkt in die Datenbank geschrieben und P2 wird
nicht erst nach der Annahme von P1/Q erzeugt. Die strukturierte Darstellung
muss ausdrücklich `tiptap_blocks` sein. Bereits vor Annahme sind Quelle,
Beziehung und erhaltene/neue Block-Identitäten exakt geprüft.

| Reihenfolge | Erwartete neue Revisionen | P1 am Ende |
|---|---|---|
| P1 → Q → P2 | 3 | `applied`, nicht erneut angewendet |
| P2 einschließlich P1 → Q | 2 | `included` |
| Q → P2 einschließlich P1 | 2 | `included` |
| Alle drei gemeinsam | 1 | `applied`, ausdrücklich mit ausgewählt |

Jeder Schritt prüft den vollständigen festen Markdown-Inhalt, alle Block-IDs
und ihre Reihenfolge, den gegen den aktuellen Stand berechneten Rest-Diff,
genaue Anwendungs- und Voraussetzungsmengen, alle drei Lebenszyklen und die
exakte Revisionsdifferenz. Nach P1/Q darf P2 nur noch `Deckung: 100 EUR` gegen
`Deckung: 150 EUR` austauschen. Endstand ist in allen Fällen Kosten 12 EUR,
Deckung 150 EUR und Lieferzeit 3 Tage. Sammelannahme muss atomar eine einzige
Revision erzeugen; ihre Vorschau enthält beide endgültigen Effekte.

Abschließend sind alle drei API-Reviews ohne schreibende Aktionen. Der exakte
historische P1-Link wird zusätzlich im Browser geöffnet und muss `Applied`
beziehungsweise `Included` anzeigen, ohne erneut anzunehmen oder abzulehnen.
Die Anzahl tatsächlich gesendeter Aktions-POSTs entspricht der Schrittlänge.
Der Test entfernt nur seine eigene UUID-Datei und Agentensitzung über APIs.

## Korrigierte Testerwartung, keine Produktänderung

Der erste Personal-Lauf P1 → Q → P2 scheiterte erst nach der dritten Annahme
an einer falschen Gleichsetzung von `affectedProposalIds` und
`applyProposalIds`. Der vollständige HTML-Schrittbericht weist drei
Bestätigungsaktionen aus. Die Aktionsquittung bindet die gesamte geprüfte
Abhängigkeitsmenge: Für P2 bleibt das bereits angenommene P1 eine geprüfte
Voraussetzung, also `affectedProposalIds = [P1, P2]`. Neu angewendet und im
Ergebnis aufgelöst wird dagegen nur P2. P1 bleibt `applied`.

Der Test prüft diese Mengen nun getrennt und exakt, einschließlich Anzahl der
Ergebnisauflösungen. Zusätzliche Lebenszyklusprüfungen nach jedem Schritt
sichern ab, dass offene Nachfolger nicht versehentlich mitangenommen werden.
Ein unabhängiger Quell-Review bestätigt die vier Reihenfolge-Orakel. Er ersetzt
keinen Browserlauf. Produktcode, Dependencies und Runtime-Env bleiben unverändert.

## Laufprotokoll

Jeder Fall läuft seriell mit einem Worker und Abstand zum nächsten Login.
Das gemeinsame Fixture wertet beobachtete 429-/5xx-Antworten der Review-Routen
als Fehler; direkt angesprochene APIs müssen jeweils erfolgreich antworten.
HTML-Reports enthalten redigierte JSON-Belege und historische UI-Screenshots,
keine Zugangsdaten oder Tool-Ausführungskontexte.

Reportmuster:
`/tmp/fvrc1008-dependency-{personal|team}-{parent-independent-child|child-independent|independent-child|batch}-{run}-report/index.html`.
Personal P1 → Q → P2 und P2 → Q verwenden `run=r2`, die übrigen Fälle `run=r3`.
Logs und Artefaktverzeichnisse verwenden denselben Präfix. Ein zu breiter
CLI-Namensfilter für `independent-child` hatte im ersten Serienlauf zusätzlich
`parent-independent-child` ausgewählt. Der zusätzliche Fall bestand, der
folgende Fall wurde kontrolliert unterbrochen. Dieser Lauf zählt nicht als
Reihenfolgenachweis. Der korrigierte Filter bindet die Workspace-Suite und den
vollständigen Testanfang; jeder abschließende Aufruf wählt genau einen Test.

| Reihenfolge | Personal | Team |
|---|---|---|
| P1 → Q → P2 | bestanden, 36,9 s | bestanden, 35,8 s |
| P2 → Q | bestanden, 30,2 s | bestanden, 30,0 s |
| Q → P2 | bestanden, 31,0 s | bestanden, 31,0 s |
| Gemeinsam | bestanden, 25,3 s | bestanden, 25,5 s |

Alle acht gespeicherten JSON-Belege wurden zusätzlich unabhängig aus den
HTML-Reports gelesen: Repräsentation, ursprüngliche/neue Block-Identitäten,
exakte Abhängigkeits- und Auflösungsmengen, Status und Revisions-/POST-Zahlen
stimmen. Repräsentative Personal-/Team-Abschlussansichten für direkte,
einschließende und gemeinsame Annahme wurden visuell geprüft. Kein Skip und
kein beobachteter Review-429-/5xx-Fehler in diesen abschließenden Läufen.

TypeScript und fokussiertes ESLint bestanden auf diesem Testquellstand:
`/tmp/fvrc1008-ordinary-dependency-typecheck-final.log` und
`/tmp/fvrc1008-ordinary-dependency-lint-final.log`.

Der Testquellstand ist durch SHA-256 des staged Test-Diffs gegen `564678bdd`
gebunden: `740409e009838966b539a30f161c6fa8180e1b78544cbbcad113b12e79b34ea4`.
GitNexus ordnet den lokalen Werkzeugaufruf zwei Test-Aufrufern und keinem
Produktprozess zu (niedriges Risiko). Die neue Test-/Evidence-Scopeprüfung
findet ebenfalls keine betroffenen Produktprozesse. Der gesamte Branchvergleich
zu lokalem `main` bleibt kritisch (164 Dateien, 1178 Symbole, 27 Prozesse beim
Quellstand-Check); dies ist ausdrücklich keine Freigabe des Gesamtbranches.
Ein erneuter Build ist für diese reinen Test-/Dokumentationsänderungen nicht
durchgeführt; der erfolgreiche Build der unveränderten Produktbasis steht in
`hardening-progress.md`.

## Abgrenzung

Diese Tests decken eine zweistufige Abhängigkeit plus unabhängige Änderung ab,
nicht drei Abhängigkeitsstufen, konkurrierende inkompatible Geschwister,
GC-/Server-Neustarts, Restore-Verlust einer Voraussetzung oder eine manuelle
Konfliktauflösung. Der historische UI-Abschluss wird ausdrücklich für P1,
API-Lebenszyklen und Aktionslosigkeit für alle drei Vorschläge geprüft.
Der Gesamtgate mit zwei vollständigen Matrixläufen und frischem
Produktionscontainer bleibt offen. P12 wird dadurch nicht freigegeben.
Kein Container-Rebuild, kein Push und keine Produktionsaktivierung.
