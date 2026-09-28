# Mehrprozess-Crash-/Offline-Abnahme

Stand: 27. September 2026. Repräsentativer DA-06-Nachweis; keine
Runtime-Aktivierung und keine vollständige Mergefreigabe.

## Geprüfter Aufbau

- Verwalteter lokaler Team-Seat-Stack mit genau einem PostgreSQL- und einem
  Notebook-Container; kein Containerneubau und keine parallele Testumgebung.
- Zwei getrennte Node-/App-Prozesse auf `3101` und `3102` mit jeweils eigener
  dedizierter PostgreSQL-Owner-Sitzung.
- Stabiler Same-Origin-Proxy auf `3000`, damit derselbe Browser-IndexedDB-Cache
  nach dem Prozesswechsel wiederverwendet wird.
- Prozessbezogene Next-/Turbopack-Ausgaben und TypeScript-Konfigurationen. Ein
  harter Crash kann dadurch keine normale `.next`-Typausgabe oder die
  Projekt-`tsconfig.json` beschädigen.
- Exakt gescopte UUID-Markdown-Fixtures; Bereinigung über die normale Datei-API.

## Szenario

1. Prozess A beansprucht den Live-Raum; PostgreSQL bestätigt Lock, Backend-PID,
   Token-Hash und Epoch.
2. Prozess B versucht denselben Raum. Beide dedizierten Datenbanksitzungen sind
   sichtbar, aber A bleibt der einzige gültige Owner.
3. Ein zweiter Browser geht offline und ändert einen unabhängigen Block. Der
   tatsächliche IndexedDB-Yjs-Zustand wird dekodiert und geprüft.
4. Ein Agentenvorschlag ändert einen anderen Block. Die Review-Aktion wird in A
   angenommen; A wird exakt am Punkt `persisted-before-history` per `SIGKILL`
   beendet.
5. Der kanonische Agenteninhalt ist bereits dauerhaft, der alte Owner-Lock ist
   freigegeben. B übernimmt mit der nächsten Epoch.
6. Der Offline-Browser verbindet sich über denselben Origin wieder. Der
   kanonische Stand enthält Agentenänderung und unabhängige Peer-Änderung.
7. B ergänzt die beim Crash noch fehlende History und finalisiert das bestehende
   Action-Receipt. Derselbe Request bleibt idempotent und erzeugt keine zweite
   Revision.
8. Eine neue Agentenänderung wird anschließend auf B normal reviewed und
   angenommen. Recovery endet damit in echter weiterer Nutzbarkeit, nicht nur
   in Quarantäne.

## Gefundener und behobener Produktfehler

Bei `persisted-before-history` kann die Collaboration-Operation bereits
`persisted_yjs` oder sogar `checkpointed_file` erreicht haben, während
`version_revision_id` noch leer ist. Die Recovery behandelte den späteren
Durabilitätsstatus zuvor als nicht recoverbar und ließ das Action-Receipt auf
`applying` stehen.

Der Finalisierungspfad erkennt beide monoton dauerhaften Zustände, erfasst die
fehlende Kandidaten-History dedupliziert und bindet deren Revision per CAS an
die bestehende Operation. Parallel fortgeschrittene Statusupdates werden neu
gelesen; es gibt weder Candidate-Replay noch eine zweite Dokumentmutation.

## Ergebnisse

- Mehrprozess-E2E Personal: **1/1 grün** (`1.3m`).
- Mehrprozess-E2E Team: **1/1 grün** (`1.3m`).
- Bestehende Single-Process-Regression
  `Proposal process crash (personal) persisted-before-history`: **1/1 grün**.
- Candidate-Operation-Tests einschließlich fehlender History bei
  `checkpointed_file`: **18/18 grün**.
- TypeScript und fokussiertes ESLint: grün.
- `npm run build`: grün; die bekannten Build-Warnungen zu nicht gesetzter
  lokaler Auth-Origin-Konfiguration und dynamischem Dateisystem-Tracing bleiben
  unverändert und sind keine Fehler dieses Umfangs.
- Nach den Läufen: Ports `3000`, `3101`, `3102` frei; keine neuen aktiven
  `fvrc-1008-ordinary-*.md`-Fixtures.

## Reproduktionskommandos

Die privaten Env-Dateien werden mit Nodes `--env-file` geladen, nicht als
Shell-Skript ausgeführt. Personal und Team laufen strikt nacheinander:

```bash
CANVAS_APP_ROOT="$PWD" \
BASE_URL=http://127.0.0.1:3000 \
BETTER_AUTH_BASE_URL=http://127.0.0.1:3000 \
AUTH_ORIGIN=http://127.0.0.1:3000 \
E2E_EXTERNAL_SERVER=1 \
COLLABORATION_E2E=1 \
CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1 \
CANVAS_PROPOSAL_CRASH_TEST=1 \
CANVAS_COLLABORATION_MULTIPROCESS_TEST=1 \
NODE_ENV=development \
node \
  --env-file="$HOME/.local/state/canvas-local-team-seat/notebook-host-dev.env" \
  --env-file="$HOME/.local/state/canvas-local-team-seat/fixtures.env" \
  node_modules/@playwright/test/cli.js test \
  tests/file-version-center-multiprocess-crash-offline.spec.ts \
  --workers=1 --reporter=line -g '\(personal\)'

# Danach separat denselben Befehl mit -g '\(team\)'.
```

Fokussierte Regressionen:

```bash
tsx --conditions react-server scripts/proposal-graph-candidate-operation-test.ts
npm run build
```

## Noch offene DA-06-Gates

- Die übrigen definierten Crashgrenzen (`persisted-before-ack`,
  `history-before-receipt` und vorbereitende Grenzen) ebenfalls mit zwei echten
  Prozessen abnehmen.
- Rechteentzug während Recovery und konfliktierende statt unabhängige
  Peer-Änderungen in Personal und Team prüfen.
- Die vollständige Matrix aus Runtime-Bootstrap, Binärschreibern und
  Lifecycle-Admission bleibt ein separates Aktivierungs-Gate.
