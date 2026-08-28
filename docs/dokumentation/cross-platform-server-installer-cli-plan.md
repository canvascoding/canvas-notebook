# Cross-Platform Server Installer CLI Plan

## Verbindlicher Umsetzungsplan: Legacy-Bash-CLI zur TypeScript-CLI

Stand: 2026-08-28

Dieser Abschnitt ist der aktive Migrationsplan. Bei Widerspruechen mit aelteren
Hybrid- oder Zukunftsaussagen weiter unten in diesem Dokument gilt dieser
Abschnitt. Die Migration wird in abgeschlossenen, einzeln getesteten und einzeln
committeten Arbeitspaketen umgesetzt.

### Ziel und harte Umschaltbedingung

Die TypeScript-CLI in `cli/src/` wird die kanonische Management-CLI fuer Linux,
macOS und Windows. Der Linux-Bash-Installer darf als kleiner Bootstrapper
erhalten bleiben, aber die dauerhafte Betriebslogik soll nicht parallel in Bash
und TypeScript gepflegt werden.

Die produktive Linux-CLI wird erst umgestellt, wenn alle folgenden Bedingungen
erfuellt sind:

1. Jeder weiterhin unterstuetzte Befehl der Bash-CLI besitzt in der
   TypeScript-CLI dasselbe dokumentierte Verhalten oder eine bewusst
   dokumentierte, getestete Abloesung.
2. Alle vom Canvas Agent und von der Control Plane verwendeten Befehle,
   Argumente, Exit Codes und JSON-Ausgaben sind kompatibel.
3. Alle Einstellungen aus `canvas-notebook-config.json`, die ueber die alte CLI
   verwaltet werden koennen, sind auch ueber die neue CLI verwaltbar.
4. Bestehende Konfigurationen, Secrets, Compose-Pfade, Volumes und
   Recovery-Journale werden ohne Datenverlust uebernommen.
5. Installation und Update der neuen Linux-CLI sind verifiziert, atomar und
   rollbackfaehig.
6. Der produktive Umschaltpfad und der Rueckweg wurden gegen eine bestehende
   Installation getestet.

Bis diese Gates erfuellt sind, bleiben SQLite und Postgres im Installer
waehlbar und die Bash-CLI bleibt der produktive Linux-Pfad.

### Bestehende Implementierungen

| Rolle | Aktuelle Implementierung | Ziel |
| --- | --- | --- |
| Legacy Linux CLI | `install/bin/canvas-notebook` und `install/lib/commands/*.sh` | nach erfolgreicher Migration entfernen oder auf einen minimalen Bootstrap-/Launcher reduzieren |
| Neue CLI | `cli/src/main.ts` und `cli/src/core/*.ts` | kanonische Management-CLI auf allen Plattformen |
| Linux Bootstrap | `install.sh` und `install/lib/*.sh` | Host-Voraussetzungen, CLI-Installation und initiale Service-Einrichtung; keine duplizierte Runtime-Logik |
| Control Plane Vertrag | `/usr/local/bin/canvas-notebook`, Config JSON, Docker Compose und Health Endpoint | stabiler, versionierter CLI-Vertrag mit Capability-Ausgabe |
| Release-Artefakte | `canvas-notebook-host-cli.tar.gz` und `canvas-notebook-cli.tar.gz` | kontrollierter Uebergang zu einem kanonischen CLI-Artefakt pro Plattform |

### Architekturgrenze

Die Aufteilung folgt einem Zwei-Schichten-Modell:

```text
Orchestrierung / Policy                 Gemeinsame Betriebsmechanik
-----------------------------------     -----------------------------------
Installer entscheidet Fresh Install    Config lesen, validieren, schreiben
Control Plane bestimmt Sollzustand      Compose rendern und ausfuehren
CLI Command bestimmt Workflow           Container- und Health-Pruefungen
Agent klassifiziert Remote-Fehler        Postgres vorbereiten/reconciliieren
Plattformadapter bestimmt Host-Policy    atomare Dateien, Locks und Prozesse
```

`cli/src/main.ts` soll Befehle orchestrieren. Wiederverwendbare Mechanik kommt
in kleine Module unter `cli/src/core/`. Control Plane und Installer duerfen
nicht erneut Docker-, Postgres- oder Health-Logik implementieren, wenn die neue
CLI dafuer bereits einen stabilen Befehl anbietet.

### Verbindliche Command-Parity-Matrix

Der Status beschreibt den Stand zu Beginn dieser Migration und muss nach jedem
Arbeitspaket aktualisiert werden.

| Legacy-Befehl | Neue CLI | Status vor Migration | Erforderlicher Nachweis |
| --- | --- | --- | --- |
| `help` | `help` | vorhanden | Help- und Exit-Code-Test |
| `version` | `version`, `-V`, `--version` | vorhanden | Text- und JSON-Vertrag, CLI-Generation und Capabilities |
| `install` | `install` | Kern vorhanden | Differentialtest fuer Config, Compose, Start und Health |
| `update` | `update` | vorhanden | Image-Pinning, Deadline, Rollback und Re-Exec |
| `start`, `restart`, `stop`, `down` | vorhanden | vorhanden | Lifecycle- und Lock-Tests |
| `status`, `ps` | vorhanden | vorhanden | stabiler JSON-Mindestvertrag auch ohne Docker |
| `health` | vorhanden | vorhanden | Text, JSON und Exit Code bei Fehler |
| `logs`, `container-logs` | vorhanden | vorhanden | Argument- und Prozessbeendigungs-Test |
| `manager-log` | vorhanden | vorhanden | fehlende und vorhandene Logdatei |
| `env` | Anzeige, `--render`, `--sync`, `--edit` | vorhanden | Maskierung, Editor-Transaktion und Sync-Vertrag |
| `env --render`, `env --sync` | vorhanden | vorhanden | Config-, Postgres-, Restart- und JSON-Tests |
| `env --edit` | noch nicht vorhanden | fehlt | sicherer Editor- und anschliessender Sync-Flow |
| `backup create` | vorhanden | vorhanden | SQLite/Postgres, Output, JSON und No-Wait |
| `database status` | vorhanden | vorhanden | stabiler JSON-Vertrag |
| `database prepare-postgres` | vorhanden | vorhanden | Credentials, Readiness und pgvector |
| `database reconcile-postgres-auth` | vorhanden | vorhanden | Journal, Rollback und Wiederaufnahme |
| `database migrate-sqlite-to-postgres` | vorhanden | vorhanden | Backup-, Copy-, Cutover- und Fehlerfall |
| `admin reset-password` | vorhanden | vorhanden | Passwort nur ueber stdin, keine Secret-Persistenz |
| `swap`, `swap-sync`, `swap-apply`, `swap-enable`, `swap-disable` | noch nicht vorhanden | fehlt | Linux-Adapter, Transaktion, Ownership und Recovery |
| `caddy`, `caddy-reload`, `caddy-fix` | noch nicht vorhanden | fehlt | Linux-Adapter, Validierung und sichere Writes |
| `diagnose` | vorhanden | vorhanden | tolerante Text-/JSON-Diagnose ohne Docker |
| `config` | vorhanden | vorhanden | aktive Pfade und Plattformkonfiguration |
| `config-show` | vorhanden | vorhanden | Maskierung und `--secret-state` |
| `config-set` | Top-Level-Basiswerte, `env.*`, `swap.*` und `autoUpdate.*` | vorhanden | validierte Pfade, gekoppelte URLs und Secret-Schutz |
| `config-migrate` | vorhanden | vorhanden | Migration aus `manager.env`, Compose- und Env-Dateien ohne Credential-Rotation |
| `cli-update` | vorhanden | vorhanden | Signatur/Checksum, atomarer Austausch und Re-Exec |
| `auto-update-status`, `auto-update-enable`, `auto-update-disable`, `auto-update-sync` | noch nicht vorhanden | fehlt | Standalone-Timer und Managed-Mode-Sperre |
| `cleanup-logs` | vorhanden | vorhanden | nur eigene verwaiste Log-Follower beenden |
| `service status/install/uninstall` | vorhanden | neue Funktion | systemd Unit muss bei Fresh Install wirklich erzeugt werden |

Ein Befehl gilt nicht allein deshalb als fertig, weil sein Happy Path vorhanden
ist. Er muss auch die relevanten Legacy-Argumente, Automatisierungsausgaben,
Fehlercodes, Locks, Dateirechte und Recovery-Faelle abdecken.

### Konfigurationsparitaet

Vor der Umschaltung wird eine Allowlist aller schreibbaren Config-Pfade
festgelegt. Mindestens abzudecken sind:

- Top Level: `domain`, `image`, `hostPort`, `containerPort`, `dataDir`.
- Runtime Environment: freigegebene `env.*`-Schluessel.
- Sensitive Environment: ausschliesslich `config-set ... --stdin`.
- Swap: `swap.enabled`, `swap.size`, `swap.file`, `swap.swappiness`.
- Auto-Update: `autoUpdate.enabled`, `autoUpdate.schedule`.
- Plattform und Pfade: nur explizit freigegebene, validierte Felder; keine
  beliebigen absoluten Zielpfade aus untrusted Remote-Input.

Die neue CLI muss dieselbe Config-Datei als Quelle der Wahrheit verwenden. Ein
CLI-Wechsel darf keine neuen Postgres-Credentials erzeugen, bestehende Secrets
rotieren oder eine vorhandene Postgres-Identitaet (`host`, `user`, `database`,
`volume`, `container`) veraendern.

### Control-Plane- und Agent-Vertrag

Vor dem Cutover muessen mindestens diese automatisierten Aufrufe kompatibel
sein:

- `config-show --json --secret-state --no-banner`
- `config-set <key> <value>`
- `config-set <sensitive-key> --stdin`
- `env --sync --timeout <seconds> --json --no-banner`
- `database prepare-postgres --timeout <seconds> --json --no-banner`
- `database reconcile-postgres-auth --timeout <seconds> --json --no-banner`
- `database migrate-sqlite-to-postgres`
- `backup create --json`
- `update --image <pinned-ref> --no-banner`
- `start`, `restart`, `stop`, `status`, `health`
- vorlaeufig `auto-update-disable --no-banner`

Die neue `version --json`-Ausgabe soll mindestens liefern:

```json
{
  "cliVersion": "2026.x.x.x",
  "cliGeneration": "typescript",
  "configSchemaVersion": 1,
  "commands": ["config-set", "env", "database", "update"]
}
```

Der Agent soll Capabilities aus dieser Ausgabe lesen koennen. Help-Text bleibt
fuer Menschen und darf nicht der langfristige Maschinenvertrag sein.

### Linux Runtime und Paketierung

Die aktuelle portable CLI setzt Node.js auf dem Host voraus. Der Linux-Cutover
darf keine unbemerkte neue Runtime-Abhaengigkeit einfuehren. Vor Phase 7 wird
deshalb verbindlich zwischen zwei Optionen entschieden und getestet:

1. ein selbststaendiges Linux-Artefakt fuer `amd64` und `arm64`, oder
2. ein versioniertes, vom Installer verwaltetes Node-Runtime-Bundle.

Eine zufaellig vorhandene System-Node-Version ist kein belastbarer
Produktionsvertrag. Der installierte Einstiegspunkt bleibt
`/usr/local/bin/canvas-notebook`. Der eigentliche CLI-Stand wird atomar ueber
`current` und `previous` aktiviert. Nach Beginn eines mutierenden Befehls gibt es
keinen stillen Fallback auf die Legacy-CLI.

### Arbeitspakete und Gates

Es wird immer nur ein Arbeitspaket gleichzeitig umgesetzt. Das naechste Paket
beginnt erst nach Tests, Dokumentationsupdate, GitNexus-Change-Analyse und
separatem Commit des vorherigen Pakets.

#### Phase 0: Vertrag und Differential-Testharness

Status: Implementiert am 2026-08-28. Der maschinenlesbare Vertrag liegt in
`scripts/fixtures/cli-command-parity.json`; `npm run test:cli:parity` prueft das
Dispatcher-Inventar, Config-Set-Luecken sowie die gemeinsamen JSON-Vertraege
von `config-show --secret-state` und `status --json` mit isolierter
Konfiguration und Fake-Docker.

- Command- und Config-Allowlist als Test-Fixtures abbilden.
- Test-Runner fuer Legacy- und TypeScript-CLI mit isoliertem Temp-Verzeichnis
  und Fake-Docker bereitstellen.
- JSON-Mindestvertraege, Exit Codes und Secret-Redaction vergleichen.
- Fehlende Paritaet als explizite erwartete Luecken markieren.

Gate: Der Test zeigt reproduzierbar, welche Befehle gleich, teilweise oder
nicht implementiert sind, ohne echte Container zu starten.

#### Phase 1: Config-, Env- und Version-Paritaet

Status: Abgeschlossen am 2026-08-28. Das Gate ist durch den Paritaetstest sowie
die portablen CLI-, Lock-, Datenbank- und Admin-Tests nachgewiesen.

`config-set` unterstuetzt und validiert jetzt
`swap.enabled`, `swap.size`, `swap.file`, `swap.swappiness`,
`autoUpdate.enabled` und `autoUpdate.schedule`. Die Differentialtests decken
gueltige Werte und abgelehnte Fehlkonfigurationen ab.

Teilstatus 2026-08-28: `version`, `-V` und `--version` liefern jetzt den
Legacy-Build-Informationsvertrag sowie `cliGeneration`,
`configSchemaVersion` und eine maschinenlesbare Command-Liste. Die gemeinsame
Versionsauflosung behebt zugleich leere `status.image.cliVersion`-Werte in
gepackten CLI-Bundles.

Teilstatus 2026-08-28: `env` zeigt die aktive Konfiguration in Text oder JSON
mit maskierten Secrets. `env --edit` bearbeitet eine temporaere Datei mit
restriktiven Rechten, uebernimmt nur eine parsebare normalisierte Konfiguration,
schuetzt Plattform- und Zielpfade und nutzt danach denselben Apply-/Health-Pfad
wie `env --sync`.

Teilstatus 2026-08-28: `config` zeigt alle aktiven Hostpfade; `config-migrate`
uebernimmt Legacy-Werte atomar aus `manager.env`, Compose und vorhandenen
Env-Dateien. Bei `--force` bleiben bestehende Secrets und die Postgres-Identitaet
erhalten. `config-set` validiert Domain, Image, Datenpfad, URLs und Env-Namen,
verbietet die Persistenz von `BOOTSTRAP_ADMIN_PASSWORD` und behaelt numerische
Secret-Werte als Strings bei.

- `version --json` und Capability-Vertrag.
- `env`-Anzeige und `env --edit`.
- vollstaendige freigegebene `config-set`-Pfade.
- `config` und `config-migrate`.
- sichere Dateirechte, atomare Writes und keine Secret-Ausgabe.

Gate: Control-Plane-Konfiguration inklusive Swap- und Auto-Update-Feldern kann
vollstaendig mit der neuen CLI gelesen, geschrieben und gerendert werden.

#### Phase 2: Diagnose-, Log- und Host-Status-Paritaet

Status: Abgeschlossen am 2026-08-28. `status --json` behaelt seinen bisherigen
Mindestvertrag und liefert auch ohne Docker eine verwertbare Antwort.
`diagnose` ergaenzt Host-Ressourcen und Docker-Erreichbarkeit. `cleanup-logs`
beendet ausschliesslich verwaiste Prozesse mit PPID 1, deren Compose-Datei,
Projektpfad, Follow-Modus und Service exakt zu dieser Installation passen.

- `diagnose` Text/JSON.
- `cleanup-logs`.
- Status-/Health-/Version-JSON gegen Agent-Vertrag haerten.
- Verhalten bei fehlendem oder nicht erreichbarem Docker testen.

Gate: Read-only Remote-Diagnose ist mindestens so aussagekraeftig und tolerant
wie in der Bash-CLI.

#### Phase 3: Swap-Paritaet

- Linux-spezifischen Swap-Service portieren.
- bestehende Ownership-, Transaktions- und Recovery-Regeln uebernehmen.
- macOS/Windows liefern einen klaren Unsupported-Fehler ohne Seiteneffekt.

Gate: bestehende Bash-Swap-Tests besitzen ein gleichwertiges TypeScript-Gegenstueck.

#### Phase 4: Caddy-Paritaet

- Status, Render/Reload und bekannte Reparaturen portieren.
- Config-Validierung vor Reload und atomare Caddyfile-Writes.
- Linux-only Verhalten explizit machen.

Gate: Caddy-Konfiguration kann ohne Aufruf der Legacy-Command-Module verwaltet werden.

#### Phase 5: Auto-Update- und Service-Paritaet

- Standalone-Auto-Update-Kommandos portieren.
- Managed Mode verhindert weiterhin lokale autonome Updates.
- systemd Unit und Timer koennen nicht nur aktiviert, sondern sicher erzeugt,
  aktualisiert und entfernt werden.

Gate: Installer, systemd und Control Plane benoetigen keine Legacy-Befehle mehr.

#### Phase 6: Linux-Paket, Bootstrap und Rollback

- kanonisches Linux-Artefakt fuer `amd64` und `arm64` bauen.
- Checksum und Archiv-Allowlist pruefen.
- atomaren `current`/`previous`-Launcher implementieren.
- Bash-Installer installiert die neue CLI, bleibt aber fuer bestehende Systeme
  rollbackfaehig.

Gate: Fresh Install, In-place-Upgrade und Rueckkehr zur vorherigen CLI-Version
sind getestet.

#### Phase 7: Control-Plane-Canary und Cutover

- Agent erkennt CLI-Generation und Capabilities.
- Host-CLI-Artefakt-Validator akzeptiert das neue, versionierte Layout.
- einzelne Managed VMs als Canary aktualisieren.
- Update, Config-Sync, Backup und Datenbankoperationen pruefen.

Gate: mindestens ein vollstaendiger Managed-Release- und Rollback-Zyklus ohne
Legacy-Ausfuehrung.

#### Phase 8: Legacy-Bash-CLI aus dem Betrieb nehmen

- Bash-Command-Module einfrieren und danach entfernen.
- Installer-, Produkt- und Betriebsdokumentation aktualisieren.
- Legacy-Erkennung bleibt nur so lange bestehen, wie Bestandsmigrationen sie
  benoetigen.

Gate: `/usr/local/bin/canvas-notebook` startet ausschliesslich die neue CLI und
alle unterstuetzten Installationen melden die neue CLI-Generation.

#### Phase 9: Postgres als Standard und spaeter einzige Neuinstallation

Diese Phase beginnt erst nach dem CLI-Cutover:

1. Postgres-Lifecycle ausschliesslich in der neuen CLI konsolidieren.
2. Doppelte Postgres-Startlogik aus Control-Plane-Bootstrap entfernen.
3. SQLite/Postgres zunaechst weiter im Standalone-Installer anbieten.
4. Neue Managed Apps standardmaessig mit Postgres provisionieren.
5. Standalone-Installer auf Postgres als Default umstellen.
6. SQLite-Auswahl nach erfolgreicher Bestandsmigration ausblenden.
7. SQLite-Migration, Backup und Restore weiter unterstuetzen, bis der
   Bestands-Cutover abgeschlossen ist.

Die Control Plane ist bei Managed Installationen fuer Sollzustand und Secrets
zustaendig. Die neue CLI ist fuer Compose, Postgres-Readiness, pgvector und
Credential-Reconciliation zustaendig.

### Companion-Service-Erweiterung

Postgres ist der erste Companion Service. Der spaetere Headful-Linux-Container
wird nicht Bestandteil der CLI-Paritaetsmigration. Die neue CLI soll aber eine
kleine statische Service-Grenze vorbereiten:

```text
Runtime Policy -> erlaubte Companion Services -> CLI Lifecycle/Health
                                      |-> postgres
                                      `-> headful (spaetere Phase)
```

Es werden keine beliebigen Docker-Definitionen aus Remote-Input akzeptiert.
Jeder Companion besitzt eine statisch bekannte Compose-Definition, eigene
Konfiguration, Healthchecks, Volumes und Secret-Regeln.

### Teststrategie pro Arbeitspaket

Pflicht vor jedem Commit mit Codeaenderungen:

1. gezielte Unit-/Script-Tests fuer das Paket,
2. `npm run cli:build`,
3. `npm run test:cli:portable`,
4. betroffene Legacy-CLI-Tests als Vergleich,
5. `npm run lint`, soweit das Paket TypeScript-/Lint-Scope beruehrt,
6. GitNexus `detect_changes()` gegen den erwarteten Scope.

Container werden nur nach expliziter Freigabe gebaut oder fuer einen echten
Container-Testlauf gestartet. Vor jedem Container-Build ist `npm run build`
Pflicht. Es darf nie mehr als ein Test-Container parallel laufen, und jeder neue
Testlauf muss den aktuellen Stand neu erstellen. Playwright ist fuer diese
CLI-Arbeit nicht erforderlich; falls spaeter Installer-UI integriert wird, wird
es nur nach expliziter Freigabe verwendet.

### Commit- und Fortschrittsregeln

- Ein Commit pro abgeschlossenem Arbeitspaket oder klar abgegrenztem Teilpaket.
- Kein Misch-Commit aus Dokumentation, mehreren CLI-Subsystemen und
  Control-Plane-Cutover.
- Kein Push ohne expliziten Auftrag oder PR-Arbeit.
- Nach jedem Paket wird diese Matrix aktualisiert.
- Die produktive CLI-Umschaltung ist ein eigenes Paket und nie ein Nebeneffekt
  eines Feature-Commits.

## Ausgangslage

Canvas Notebook besteht fuer Endnutzer aus zwei getrennten Schichten:

- Electron ist nur der Desktop-Client. Er oeffnet eine konfigurierte Canvas-Notebook-Server-URL.
- Der eigentliche Server laeuft als Docker-Container mit persistenter `/data`-Ablage.

Der aktuelle Installer ist fuer Linux/VPS optimiert. `install.sh` installiert und verwaltet Docker, Compose, Konfiguration, systemd, Auto-Update, optional Caddy und den Host-Befehl `canvas-notebook`.

macOS und Windows koennen heute nicht denselben Server-Installer nutzen. Fuer lokale Setups gibt es `npm run setup`, aber das ist ein Developer-/Repository-Flow und kein sauberer Endnutzer-Installer.

### Aktueller Implementierungsstand

Das portable CLI ist bereits implementiert in `cli/src/` mit folgender Struktur:

```text
cli/
  src/
    main.ts              # Entry Point, Command-Dispatcher
    core/
      config.ts          # Config-Store, Secrets, Env-Generierung
      compose.ts         # Compose-Datei-Generierung
      docker.ts          # Docker/Compose-Wrapper
      platform.ts        # OS-Detection, Pfad-Resolution, Service-Mode
      process.ts         # Command-Runner (spawn mit Argument-Arrays)
      service.ts          # Service-Adapter (systemd, launchd, scheduled-task)
      types.ts           # TypeScript-Typen
```

**Was bereits funktioniert:**

- Portabler Kern fuer die zentralen Befehle (`install`, `update`, `start`, `stop`, `restart`, `down`, `status`, `health`, `logs`, `admin reset-password`, `database migrate-sqlite-to-postgres`, `service install/uninstall/status`, `config-show`, eingeschraenktes `config-set`, `env --sync`). Die noch fehlende Linux-/Legacy-Paritaet ist in der verbindlichen Matrix oben festgehalten.
- OS-spezifische Pfad-Resolution fuer Linux (`/opt/canvas-notebook`), macOS (`~/Library/Application Support/Canvas Notebook/...`), Windows (`%LOCALAPPDATA%\Canvas Notebook\...`)
- Service-Adapter: systemd (Linux), launchd (macOS), scheduled-task (Windows)
- Multi-Arch Docker-Image (`linux/amd64,linux/arm64`) via `build-and-push.yml`
- Compose-Datei-Generierung aus `canvas-notebook-config.json`
- Secret-Generierung (`BETTER_AUTH_SECRET`, `CANVAS_INTERNAL_API_KEY`)
- SQLite-zu-Postgres-Migration
- `package-portable-cli.mjs` packt `dist-cli/` + `install/{macos.sh,windows.ps1}` + README
- `portable-cli.yml` baut das CLI-Bundle bei Tag-Push

**Was noch fehlt:**

- die in der verbindlichen Command-Parity-Matrix aufgefuehrten Legacy-Befehle und Config-Pfade
- Differentialtests zwischen Bash- und TypeScript-CLI
- Tests auf Windows und macOS Runners
- ein atomarer Linux-Cutover mit verifiziertem Runtime-Artefakt und Rollback

### Stand 2026-07-07

Der aktuelle Stand bleibt bewusst zweigleisig:

- **Linux/VPS Production:** Der bestehende Bash-Installer und die bestehende Bash-CLI bleiben der produktive Pfad. `install.sh` installiert weiterhin `/usr/local/bin/canvas-notebook` aus `install/bin/canvas-notebook` mit den vorhandenen Linux-Funktionen fuer systemd, Auto-Update, Caddy, Swap, Config-Migrationen und Control-Plane-Kompatibilitaet.
- **macOS/Windows Desktop-Server:** Die neue TypeScript-CLI ist die portable Management-Schicht fuer lokale Docker-Desktop-Installationen. Die Remote-Installer `install/macos.sh` und `install/windows.ps1` laden das Release-Bundle `canvas-notebook-cli.tar.gz`, pruefen `canvas-notebook-cli.sha256`, installieren einen User-local Wrapper und rufen danach die TypeScript-CLI auf.
- **Release-Asset:** `portable-cli.yml` veroeffentlicht das CLI-Bundle und die SHA256-Datei als GitHub Release Assets. Damit koennen die Remote-Installer ohne Repository-Checkout funktionieren.
- **PowerShell-Pruefung:** Der Windows-Installer kann mit `pwsh` auf macOS syntaktisch geparst werden. Das prueft nur PowerShell-Syntax; Windows-spezifisches Verhalten wie `winget`, `schtasks.exe`, `wsl.exe`, Docker Desktop mit WSL2 und User-PATH muss weiterhin auf Windows getestet werden.
- **Noch nicht bewiesen:** Ein echter End-to-End-Lauf auf macOS und Windows mit Docker Desktop, Service-Installation, Wrapper-Aufruf `canvas-notebook`, Container-Start, Health-Check, Admin-Reset und Update-Flow steht noch aus.

Aktuelle Entscheidung: Es gibt keine sofortige Linux-Umstellung auf die TypeScript-CLI. Die TypeScript-CLI ist fuer Linux vorbereitet, aber der Bash-Pfad bleibt stabiler Production-Default, bis macOS/Windows verifiziert sind und Linux-Feature-Parity dokumentiert ist.

## Ziel

Der Docker-Container soll auf Linux, macOS und Windows per Einzeiler installierbar und verwaltbar sein, ohne die bestehende Linux-Installation zu brechen.

Das Zielbild:

- Linux/VPS bleibt stabil und kompatibel (Bash-CLI bleibt als produktiver Pfad, portable CLI als Ergaenzung wenn Node verfuegbar).
- macOS bekommt einen offiziellen lokalen Docker-Desktop-basierten Server-Installer mit Einzeiler.
- Windows bekommt einen offiziellen lokalen Docker-Desktop-/WSL2-basierten Server-Installer mit Einzeiler.
- Node.js und Docker Desktop werden automatisch installiert, falls sie fehlen.
- Das `canvas-notebook` CLI bietet auf allen Plattformen dieselben Kernbefehle.
- OS-spezifische Host-Features werden ueber Adapter geloest, nicht im portablen Kern vermischt.

### Ziel-Einzeiler

```powershell
# Windows (PowerShell) - keine Admin-Rechte noetig
irm https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/windows.ps1 | iex
```

```bash
# macOS (Terminal)
curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/macos.sh | bash
```

```bash
# Linux (bestehend, bleibt unverteilt)
curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh | bash
```

### Entscheidungen

| Entscheidung | Wahl | Begruendung |
| --- | --- | --- |
| Download-URL | `raw.githubusercontent.com/canvascoding/canvas-notebook/main/...` | Direkt aus dem oeffentlichen GitHub-Repo, kein zusaetzlicher Server/CDN noetig |
| Linux-Strategie | Hybrid (Bash-CLI + portable CLI) | Bash-CLI bleibt produktiv, portable CLI als Ergaenzung wenn Node verfuegbar. Keine Umstellung bis das neue CLI vollstaendig getestet ist |
| Docker Desktop Auto-Install | Automatisch installieren (winget/brew) | Endnutzer-Einzeiler soll ohne manuelle Vorabhaengigkeiten funktionieren |
| Node.js Auto-Install | Automatisch installieren (winget/brew/apt) | Endnutzer-Einzeiler soll ohne manuelle Vorabhaengigkeiten funktionieren |

## Designentscheidung

Das bestehende Bash-CLI sollte nicht direkt fuer macOS und Windows erweitert werden.

Gruende:

- Bash ist fuer Windows als Primaer-CLI ungeeignet.
- Die aktuelle Bash-Implementierung nutzt Linux-Tools und Linux-Pfade wie `systemctl`, `sudo`, `jq`, `sed`, `/opt`, `/var/log` und `/etc`.
- macOS liefert standardmaessig eine alte Bash-Version aus; einige aktuelle Bash-Patterns sind dort nicht robust.
- Shell-String-Komposition fuer Docker/Compose ist auf Windows-Pfaden fehleranfaellig.

Stattdessen wird ein neues cross-platform CLI in TypeScript/Node eingesetzt. Dieses CLI wird als eigenes Artefakt ausgeliefert und nutzt Docker/Compose ueber `child_process.spawn()` mit Argument-Arrays statt Shell-Strings.

Die bestehende Linux-Bash-CLI bleibt waehrend der Migration unveraendert und kann spaeter optional als Wrapper auf das neue CLI umgestellt werden.

## Architektur: Trennung von Workflows

Der bisherige `build-and-push.yml` Workflow baut das Docker-Image multi-arch (`linux/amd64,linux/arm64`) auf einem einzigen `ubuntu-latest` Runner. Die arm64-Schicht wird vollstaendig durch QEMU emuliert (`npm run build` dauert 22 Min statt 4 Min nativ). Zusaetzlich kostet der GHA-Cache-Export mit `mode=max` ~13,5 Min und Provenance/SBOM-Attestationen ~2 Min. Ein Build dauerte insgesamt **54 Minuten**.

**Loesung:** Komplett separate Workflows mit nativen Runnern:

| Workflow | Trigger | Runner | Zweck | Dauer |
| --- | --- | --- | --- | --- |
| `build-amd64.yml` | Tag `v*`, woechentlicher Cron, `workflow_dispatch` | `ubuntu-latest` (nativ amd64) | Nur amd64 Image bauen + pushen (`:amd64` Tag) | ~4-5 Min |
| `build-arm64.yml` | Tag `v*`, `workflow_dispatch` | `ubuntu-24.04-arm` (nativ arm64) | Nur arm64 Image bauen + pushen (`:arm64` Tag), kein QEMU | ~5-6 Min |
| `manifest-merge.yml` | `workflow_run` nach beiden Builds, `workflow_dispatch` | `ubuntu-latest` | Multi-Arch-Manifest erstellen (`:latest` + `:v*`), Control Plane Webhook | ~30s |
| `portable-cli.yml` | Tag `v*`, `workflow_dispatch` | `ubuntu-latest` | Portable CLI bauen + testen + packen + als Release-Asset | ~3 Min |
| `electron-build.yml` | `workflow_dispatch` | `macos-latest`, `windows-latest`, `ubuntu-latest` | Electron Desktop-Builds | ~15 Min |

### Szenarien

| Szenario | Was passiert | Dauer |
| --- | --- | --- |
| **Schneller Fix** (`workflow_dispatch` auf `build-amd64.yml`) | Nur amd64 wird gebaut + gepusht (`:amd64` Tag) | ~4-5 Min |
| **Release** (Tag `v*` pushen) | `build-amd64.yml` + `build-arm64.yml` + `portable-cli.yml` feuern parallel; nach beide Builds -> `manifest-merge.yml` erstellt `:latest` + `:v*` | ~6 Min gesamt (parallel) |
| **Woechentlicher Cron** | Nur `build-amd64.yml` (arm64 nicht in Cron) | ~4-5 Min |
| **Nur arm64 neu bauen** | `workflow_dispatch` auf `build-arm64.yml`, dann `manifest-merge.yml` manuell | ~6 Min |

### Optimierungen pro Build-Workflow

- **Kein QEMU:** arm64 baut nativ auf `ubuntu-24.04-arm` Runner (5,5x schneller als Emulation)
- **Cache `mode=min`:** Nur finale Layer cachen, nicht alle intermediate (~10 Min gespart)
- **Provenance/SBOM deaktiviert:** `provenance: mode=disabled`, `sbom: false` (~2 Min gespart)
- **Cache-Scopes:** `scope=amd64` und `scope=arm64` damit die Caches sich nicht in die Quere kommen
- **Image-Tags:** Single-Arch-Builds pushen als `:amd64` bzw. `:arm64`; Merge-Job erstellt `:latest` und `:v2026.x.x` als Multi-Arch-Manifest
- **Control Plane Webhook:** Wandert in `manifest-merge.yml` — erst nach erfolgreichem Merge beider Plattformen wird der Webhook gesendet

### Ersparnis

| Szenario | Vorher | Nachher |
| --- | --- | --- |
| Schneller Fix (nur amd64) | 54 Min (beide Plattformen via QEMU) | ~5 Min |
| Release (beide Plattformen) | 54 Min (sequenziell via QEMU) | ~6 Min (parallel, nativ) |

Jeder Workflow laeuft unabhaengig und parallel bei Tag-Push. Kein Workflow blockiert einen anderen.

## Portabler Kern

Diese Funktionen sind OS-neutral implementiert (bereits vorhanden in `cli/src/core/`):

- Docker-Verfuegbarkeit erkennen (`docker.ts`)
- Docker Desktop/Daemon Health pruefen (`docker.ts`)
- Compose-Datei schreiben und validieren (`compose.ts`)
- `.env` und Container-Env aus `canvas-notebook-config.json` erzeugen (`config.ts`)
- Secrets generieren (`config.ts: randomSecret()`, `ensureSecrets()`)
- Image pullen (`docker.ts`)
- Container starten, stoppen, recreaten (`main.ts`)
- Health-Check gegen `/api/health` (`docker.ts: waitUntilHealthy()`)
- Container-Logs streamen (`main.ts`)
- Status als Text und JSON ausgeben (`main.ts: statusJson()`)
- Admin-Passwort per `docker exec -i` setzen (`main.ts: admin()`)
- SQLite-zu-Postgres-Migration per `docker exec` starten (`main.ts: database()`)

Wichtig: Docker-Kommandos werden immer mit Argument-Arrays gestartet:

```ts
spawn("docker", ["compose", "-f", composeFile, "up", "-d", "--force-recreate"], {
  cwd: installDir,
  stdio: "inherit",
});
```

Keine Shell-Konstrukte wie:

```ts
exec(`docker compose -f "${composeFile}" up -d`);
```

Das ist besonders wichtig fuer Windows-Pfade, Leerzeichen in User-Verzeichnissen und sichere Passwortuebergabe.

## Command-Parity

Diese Befehle funktionieren auf allen Plattformen gleich (bereits implementiert):

| Befehl | Plattformverhalten |
| --- | --- |
| `canvas-notebook install` | Config erzeugen, Secrets erzeugen, Image pullen, Compose schreiben, Container starten, Health abwarten |
| `canvas-notebook update` | Image pruefen/pullen, Container nur bei Bedarf recreaten, Health abwarten |
| `canvas-notebook start` | Compose-Service starten, Health abwarten |
| `canvas-notebook restart` | Compose-Service recreaten, Health abwarten |
| `canvas-notebook stop` | Compose-Service stoppen |
| `canvas-notebook down` | Compose-Projekt stoppen und entfernen |
| `canvas-notebook status` | Compose-/Containerstatus anzeigen |
| `canvas-notebook status --json` | Maschinenlesbaren Status liefern |
| `canvas-notebook health` | Health-Endpunkt pruefen |
| `canvas-notebook logs` | Container-Logs streamen |
| `canvas-notebook manager-log` | Host-CLI-Log anzeigen |
| `canvas-notebook env --sync` | Env-Dateien regenerieren |
| `canvas-notebook config-show` | `canvas-notebook-config.json` anzeigen |
| `canvas-notebook config-set <key> <value>` | einzelne Config-Werte setzen |
| `canvas-notebook admin reset-password` | Passwort im laufenden Container per stdin synchronisieren |
| `canvas-notebook database migrate-sqlite-to-postgres` | Migrationsscript im Container ausfuehren |
| `canvas-notebook service status\|install\|uninstall` | OS-spezifischen Service installieren/entfernen |

## OS-spezifische Adapter

### Linux

Linux behaelt die aktuelle Funktionalitaet:

- Installationspfad: `/opt/canvas-notebook`
- Datenpfad: `~/canvas-notebook-data` (portable CLI) oder `CANVAS_DATA_DIR` (Bash-CLI)
- Logpfad: `/var/log/canvas-notebook/manager.log` (portable CLI) oder `CANVAS_MANAGER_LOG_DIR`
- Service: systemd `canvas-notebook.service`
- Auto-Update: systemd timer
- Optional: Caddy
- Optional: Swap-Verwaltung

Der bestehende Bash-Installer (`install.sh`) bleibt zunaechst der produktive Linux/VPS-Pfad.

**Hybrid-Strategie:** Wenn Node.js verfuegbar ist, kann das portable CLI zusaetzlich heruntergeladen und genutzt werden. Die Bash-CLI bleibt als Fallback. Erst wenn das portable CLI vollstaendig auf Windows und macOS getestet ist, wird Linux aktiv umgestellt.

### macOS

macOS nutzt Docker Desktop als Voraussetzung.

Empfohlene Pfade (bereits implementiert in `platform.ts`):

| Zweck | Pfad |
| --- | --- |
| Installationsdaten | `~/Library/Application Support/Canvas Notebook/manager` |
| Persistente App-Daten | `~/Library/Application Support/Canvas Notebook/data` |
| Config | `~/Library/Application Support/Canvas Notebook/manager/canvas-notebook-config.json` |
| Compose-Datei | `~/Library/Application Support/Canvas Notebook/manager/canvas-notebook-compose.yaml` |
| Container-Env | `~/Library/Application Support/Canvas Notebook/manager/canvas-notebook.env` |
| Logs | `~/Library/Logs/Canvas Notebook/manager.log` |

Service-Integration (bereits implementiert in `service.ts`):

- `launchd` LaunchAgent fuer Start beim Login:
  - `~/Library/LaunchAgents/io.canvasstudios.notebook.plist`
  - ruft `canvas-notebook start --no-banner` auf
- separater LaunchAgent fuer Auto-Update (spaeter)

Docker-Verhalten:

- `docker info` pruefen
- wenn Docker Desktop installiert, aber nicht gestartet: `open -a Docker` und readiness abwarten
- wenn Docker fehlt: **automatische Installation** via `brew install --cask docker` (oder direkter Download als Fallback)

Node.js-Verhalten:

- `command -v node` pruefen
- wenn Node fehlt: **automatische Installation** via `brew install node` (oder direkter Download als Fallback)

Nicht macOS-relevant:

- Caddy-Integration standardmaessig ausblenden
- Swap-Befehle als unsupported markieren

### Windows

Windows nutzt Docker Desktop mit WSL2 Backend als Voraussetzung.

Empfohlene Pfade (bereits implementiert in `platform.ts`):

| Zweck | Pfad |
| --- | --- |
| Installationsdaten | `%LOCALAPPDATA%\Canvas Notebook\manager` |
| Persistente App-Daten | `%LOCALAPPDATA%\Canvas Notebook\data` |
| Config | `%LOCALAPPDATA%\Canvas Notebook\manager\canvas-notebook-config.json` |
| Compose-Datei | `%LOCALAPPDATA%\Canvas Notebook\manager\canvas-notebook-compose.yaml` |
| Container-Env | `%LOCALAPPDATA%\Canvas Notebook\manager\canvas-notebook.env` |
| Logs | `%LOCALAPPDATA%\Canvas Notebook\logs\manager.log` |

Service-Integration (bereits implementiert in `service.ts`):

- Windows Scheduled Task statt Windows Service
- Task "At logon" (`/SC ONLOGON`) fuer `canvas-notebook start --no-banner`
- separater taeglicher Scheduled Task fuer `canvas-notebook update --no-banner` (spaeter)

Warum kein Windows Service als erste Version?

- Docker Desktop ist oft an die User-Session gebunden.
- Ein Windows Service laeuft in einem anderen Kontext und sieht Docker Desktop nicht immer korrekt.
- Scheduled Tasks sind fuer lokale Desktop-Installationen pragmatischer und leichter zu debuggen.

Docker-Verhalten:

- `docker info` pruefen
- wenn Docker Desktop installiert, aber nicht gestartet: `Start-Process "Docker Desktop.exe"` und readiness abwarten (90 x 2s = 3 Min)
- wenn Docker fehlt: **automatische Installation** via `winget install Docker.DockerDesktop --accept-package-agreements`
- Fallback: direkter Download von `https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe` + silent install (`Start-Process -ArgumentList "install","--quiet"`)
- WSL2-Status pruefen (`wsl --status`), Hinweis falls nicht aktiv

Node.js-Verhalten:

- `Get-Command node` pruefen
- wenn Node fehlt: **automatische Installation** via `winget install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements`
- Fallback: direkter MSI-Download von `nodejs.org/dist/v22.../node-v22...-x64.msi` + silent install (`msiexec /i ... /quiet`)
- PATH-Refresh im aktuellen Process nach Installation

Windows-spezifische Regeln:

- keine Bash-Abhaengigkeit
- keine PowerShell-Pipelines fuer Kernlogik
- Pfade immer ueber Node `path.win32`/native APIs normalisieren
- Docker-Kommandos als `docker.exe` mit Argument-Arrays starten
- Compose-Datei-Pfade mit Backslash-to-Forwardslash-Konvertierung (`platform.ts: composePath()`)

## Compose-Datei

Die Compose-Datei wird aus einem strukturierten Modell geschrieben (`compose.ts: renderComposeFile()`). Der portable Kern schreibt keine Linux-Defaults wie `/opt/canvas-notebook` in die generierte Datei.

Aktuelle Implementierung:

```yaml
services:
  canvas-notebook:
    container_name: canvas-notebook
    image: ${CANVAS_IMAGE:-ghcr.io/canvascoding/canvas-notebook:latest}
    ports:
      - "${HOST_PORT:-3456}:${CONTAINER_PORT:-3000}"
    env_file:
      - "/absolute/platform/path/canvas-notebook.env"
    depends_on:
      postgres:
        condition: service_healthy
        required: false
    volumes:
      - "${DATA_DIR:-./data}:/data"
    restart: unless-stopped

  postgres:
    profiles:
      - postgres
    container_name: canvas-notebook-postgres
    image: ${CANVAS_POSTGRES_IMAGE:-pgvector/pgvector:0.8.3-pg18}
    environment:
      POSTGRES_DB: ${CANVAS_POSTGRES_DB:-canvas_notebook}
      POSTGRES_USER: ${CANVAS_POSTGRES_USER:-canvas}
      POSTGRES_PASSWORD: ${CANVAS_POSTGRES_PASSWORD:-unused-sqlite-profile-disabled}
    volumes:
      - canvas-postgres-data:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped

volumes:
  canvas-postgres-data:
    name: ${CANVAS_POSTGRES_DATA_VOLUME:-canvas-postgres-data}
```

Fuer Windows werden Compose-Pfade bereits konvertiert (`composePath()` in `platform.ts` ersetzt Backslashes durch Forwardslashes). Das ist mit Docker Desktop getestet und stabil.

## Config-Format

Das bestehende `canvas-notebook-config.json` ist die Quelle der Wahrheit (bereits implementiert in `config.ts`).

Struktur:

```json
{
  "domain": "",
  "image": "ghcr.io/canvascoding/canvas-notebook:latest",
  "hostPort": 3456,
  "containerPort": 3000,
  "dataDir": "",
  "platform": {
    "os": "linux | macos | windows",
    "serviceMode": "systemd | launchd | scheduled-task | none"
  },
  "paths": {
    "installDir": "",
    "dataDir": "",
    "logFile": "",
    "composeFile": "",
    "containerEnvFile": "",
    "composeEnvFile": ""
  },
  "swap": {
    "enabled": false,
    "size": "2G",
    "file": "/swapfile"
  },
  "autoUpdate": {
    "enabled": true,
    "schedule": "*-*-* 04:00:00"
  },
  "env": {
    "BETTER_AUTH_SECRET": "",
    "CANVAS_INTERNAL_API_KEY": "",
    "BETTER_AUTH_BASE_URL": "",
    "BASE_URL": "",
    "PORT": "3000",
    "HOSTNAME": "0.0.0.0",
    "NODE_ENV": "production",
    "DATA": "/data",
    "LOG_LEVEL": "info",
    "ONBOARDING": true,
    "ALLOW_SIGNUP": false,
    "CANVAS_DEPLOYMENT_MODE": "single_user",
    "CANVAS_DATABASE_PROVIDER": "sqlite",
    "DATABASE_URL": ""
  }
}
```

Die alte Struktur wird weiterhin gelesen (`normalizeConfig()` ist abwaerts kompatibel). Migrationen duerfen bestehende Linux-Installationen nicht zerstoeren.

## Image-Strategie

Fuer Performance und echte macOS-Unterstuetzung ist ein Multi-Arch-Image wichtig.

Aktuell gebaut (bereits implementiert in `build-and-push.yml`):

- `linux/amd64`
- `linux/arm64`

Ohne `linux/arm64` laeuft Apple Silicon entweder gar nicht sauber oder langsam ueber Emulation.

## Performance-Anforderungen

- Der Endnutzer-Installer pullt standardmaessig das prebuilt Image, nicht lokal bauen.
- `update` recreatet den Container nur, wenn Image, Compose oder relevante Config geaendert wurde (`docker.ts: needsRecreate()`).
- Health-Checks haben kurze Timeouts und klare Progress-Ausgaben.
- Status-Abfragen werden parallelisiert (`main.ts: statusJson()` nutzt `Promise.all`):
  - Config lesen
  - Docker container inspect
  - Docker image inspect
  - HTTP health
- Logs werden gestreamt, aber nicht dauerhaft doppelt als orphaned follower gestartet.

## Installer-Flows

### Linux/VPS

Bestehender Flow bleibt (bereits als Einzeiler funktionsfaehig):

```bash
curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh | bash
```

Der Installer:
1. installiert Docker via `get.docker.com` falls fehlt
2. installiert die Bash-CLI nach `/opt/canvas-notebook`
3. erzeugt Config, Secrets und Datenpfade
4. schreibt Compose-Datei
5. pullt das Image
6. startet den Container
7. legt systemd Service + Auto-Update Timer an
8. konfiguriert optional Caddy und Swap

**Hybrid-Erweiterung (spaeter):** Wenn Node.js verfuegbar ist, kann das portable CLI zusaetzlich heruntergeladen und genutzt werden. Keine aktive Umstellung bis das portable CLI vollstaendig auf Windows und macOS getestet ist.

### macOS

Einzeiler-Flow:

```bash
curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/macos.sh | bash
```

Der Installer:
1. **Node.js pruefen/installieren** — `command -v node` pruefen; falls fehlt: `brew install node` (Homebrew); Fallback: direkter Download von `nodejs.org/dist/.../node-v22...-darwin-arm64.tar.gz` nach `/usr/local`
2. **Docker Desktop pruefen/installieren** — `docker info` pruefen; falls fehlt: `brew install --cask docker` (Homebrew); Fallback: direkter Download von `https://desktop.docker.com/mac/main/arm64/Docker.dmg` + mount + `cp -R Docker.app /Applications/`; starten + warten (`open -a Docker`, max. 90 x 2s)
3. **Portable CLI herunterladen** — `https://github.com/canvascoding/canvas-notebook/releases/latest/download/canvas-notebook-cli.tar.gz` nach `~/Library/Application Support/Canvas Notebook/cli/` entpacken
4. **CLI-Wrapper installieren** — `~/.local/bin/canvas-notebook` → `exec node "...\dist-cli\main.js" "$@"`; PATH hinzufuegen
5. **Container installieren** — `node main.js install` (generiert Config, pullt Image, startet Container)
6. **Service installieren** — `node main.js service install` (LaunchAgent)
7. **Browser oeffnen** — `open "http://localhost:3456"`

**Wichtig:** Das Skript muss ohne Repo-Checkout funktionieren (keine relativen Pfad-Referenzen). Alles wird aus Downloads bezogen.

### Windows

Einzeiler-Flow:

```powershell
irm https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/windows.ps1 | iex
```

Der Installer:
1. **Node.js pruefen/installieren** — `Get-Command node` pruefen; falls fehlt: `winget install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements`; Fallback: direkter MSI-Download von `nodejs.org/dist/v22.../node-v22...-x64.msi` + `msiexec /i ... /quiet`; PATH-Refresh im aktuellen Process
2. **Docker Desktop pruefen/installieren** — `docker info` pruefen; falls fehlt: `winget install Docker.DockerDesktop --accept-package-agreements`; Fallback: direkter Download von `https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe` + `Start-Process -ArgumentList "install","--quiet"`; WSL2-Status pruefen (`wsl --status`); Docker Desktop starten + warten (max. 90 x 2s = 3 Min)
3. **Portable CLI herunterladen** — `$cliUrl = "https://github.com/canvascoding/canvas-notebook/releases/latest/download/canvas-notebook-cli.tar.gz"`; nach `%LOCALAPPDATA%\Canvas Notebook\cli\` entpacken (`tar -xzf`, ab Windows 10 1803 verfuegbar)
4. **CLI-Wrapper installieren** — `canvas-notebook.cmd` in `%LOCALAPPDATA%\Canvas Notebook\bin\` → `node "...\dist-cli\main.js" %*`; PATH per `[Environment]::SetEnvironmentVariable("Path", ..., "User")` hinzufuegen
5. **Container installieren** — `node main.js install` (generiert Config, pullt Image, startet Container)
6. **Service installieren** — `node main.js service install` (Scheduled Task `ONLOGON`)
7. **Browser oeffnen** — `Start-Process "http://localhost:3456"`

**Wichtig:** Das Skript muss ohne Repo-Checkout funktionieren (keine `$PSScriptRoot/..` Referenzen). Alles wird aus Downloads bezogen. Keine Admin-Rechte erforderlich (winget installiert pro-User, Docker Desktop installiert in User-Context).

## Release-Asset-Strategie

Das portable CLI-Bundle muss oeffentlich herunterladbar sein, damit die Install-Skripte es von einer stabilen URL ziehen koennen.

### Download-URL

```
https://github.com/canvascoding/canvas-notebook/releases/latest/download/canvas-notebook-cli.tar.gz
```

### Workflow-Anpassung (`portable-cli.yml`)

Der Workflow wird angepasst, um das CLI-Bundle als GitHub Release-Asset zu veroeffentlichen:

1. `npm run cli:build` (tsc-Kompilierung)
2. `npm run test:cli:portable` (Cross-Platform-Tests)
3. `npm run cli:package` (Bundle packen nach `dist-portable-cli/canvas-notebook-cli/`)
4. `tar -czf canvas-notebook-cli.tar.gz -C dist-portable-cli canvas-notebook-cli` (Tarball erzeugen)
5. `softprops/action-gh-release@v2` (Tarball an GitHub Release anhaengen)

Der Workflow triggert bei Tag-Push `v*` (wie bisher). Der GitHub Release wird automatisch erstellt, wenn er noch nicht existiert.

### `package-portable-cli.mjs` Anpassung

Das Script erzeugt zusaetzlich eine `.tar.gz`-Datei neben dem Ordner:

```js
await run('tar', ['-czf', 'dist-portable-cli/canvas-notebook-cli.tar.gz', '-C', 'dist-portable-cli', 'canvas-notebook-cli']);
```

## Beziehung zu Electron

Electron ist nicht die einzige Server-Management-Schicht.

Empfohlen:

- Das CLI ist die kanonische Server-Management-Schicht.
- Electron kann spaeter das CLI aufrufen, um "lokalen Server installieren/starten" anzubieten.
- Der Server-Installer muss auch ohne Electron funktionieren.

Damit bleibt die Architektur testbar:

- CLI kann headless getestet werden.
- Electron bleibt Client/UI.
- Control Plane und Host-Automatisierung koennen dasselbe CLI verwenden.

## Migrationsstrategie

### Phase 1: Portable CLI veroeffentlichen

**Status: Implementiert**

- Portable CLI in GitHub Release als `.tar.gz` veroeffentlichen (`portable-cli.yml` anpassen)
- `package-portable-cli.mjs` um Tarball-Erzeugung erweitern
- Download-URL stabilisieren: `github.com/.../releases/latest/download/canvas-notebook-cli.tar.gz`

### Phase 2: Windows Remote-Installer

**Status: Implementiert, echte Windows-Runner-/Manual-OS-Verifikation ausstehend**

- `install/windows.ps1` als Remote-Installer neu schreiben (keine Repo-Checkout-Abhaengigkeit)
- Node.js Auto-Install via winget
- Docker Desktop Auto-Install via winget
- Portable CLI von Release-URL herunterladen + entpacken
- CLI-Wrapper in PATH installieren
- Container + Scheduled Task installieren
- Test auf `windows-latest` GH Actions Runner

### Phase 3: macOS Remote-Installer

**Status: Implementiert, echte macOS-Runner-/Manual-OS-Verifikation ausstehend**

- `install/macos.sh` als Remote-Installer neu schreiben (keine Repo-Checkout-Abhaengigkeit)
- Node.js Auto-Install via brew
- Docker Desktop Auto-Install via brew
- Portable CLI von Release-URL herunterladen + entpacken
- CLI-Wrapper in PATH installieren
- Container + LaunchAgent installieren
- Test auf `macos-latest` GH Actions Runner

### Phase 4: Linux-Hybrid (spaeter)

**Status: Ausgesetzt bis Windows/macOS verifiziert und Linux-Parity bewertet ist**

- `install.sh` um optionales portable CLI erweitern (wenn Node verfuegbar)
- Bash-CLI bleibt als Fallback
- Keine aktive Umstellung bis Phase 2 + 3 erfolgreich getestet

Linux-Migrationspfad:

1. Bash-CLI bleibt `/usr/local/bin/canvas-notebook` und produktiver Default.
2. TypeScript-CLI wird optional neben der Bash-CLI installierbar, ohne den bestehenden Befehl zu ersetzen.
3. Feature-Parity gegen Bash dokumentieren: systemd, Auto-Update-Timer, Caddy, Swap, Config-Migrationen, CLI-Update, Logs, Admin, Database-Provider, Control-Plane-Kompatibilitaet.
4. Erst danach kann `install.sh` zum reinen Bootstrapper werden und die TypeScript-CLI als kanonische Management-Schicht installieren.
5. Wenn der neue Pfad stabil ist, kann die Bash-CLI entweder Wrapper bleiben oder als Legacy-Fallback erhalten werden.

### Phase 5: README + Doku

- README mit drei Einzeilern (Windows/macOS/Linux) aktualisieren
- Installationsanleitung fuer alle OS dokumentieren

### Phase 6: Electron-Integration (spaeter)

- Electron Setup-Screen kann lokalen Server erkennen
- wenn kein Server konfiguriert ist: "Local server installieren/starten"
- Electron ruft CLI auf und zeigt Progress/Fehler an

## Testplan

### Unit-/Script-Tests (bestehend + zu erweitern)

- Config-Migration (`test:cli:portable`)
- Secret-Generierung
- Compose-Generierung fuer Linux/macOS/Windows
- Docker-Command-Argumente mit Fake-Docker
- `status --json`
- `admin reset-password --password-stdin`
- Update-Entscheidung: recreate nur bei geaendertem Image/Config

### CI-Tests (neu)

- `install/windows.ps1` auf `windows-latest` GH Actions Runner testen
- `install/macos.sh` auf `macos-latest` GH Actions Runner testen
- `portable-cli.yml` Build + Release-Asset-Upload verifizieren

### Manuelle OS-Tests

- macOS Apple Silicon
- macOS Intel, falls verfuegbar
- Windows 11 mit Docker Desktop WSL2
- Ubuntu/Debian VPS bestehender Installer

### Regression Guard

- bestehende Linux-Installer-Tests duerfen nicht entfernt werden
- Linux-Bash-Pfad bleibt bis zur vollstaendigen Parity produktiv
- `build-and-push.yml` darf nicht durch CLI-Build verlaengert werden

## Risiken

| Risiko | Gegenmassnahme |
| --- | --- |
| Windows-Docker-Pfade brechen Volume-Mounts | `composePath()` konvertiert Backslashes zu Forwardslashes (bereits implementiert) |
| Docker Desktop ist installiert, aber nicht gestartet | klare Detection, automatischer Start (`open -a Docker` / `Start-Process`), readiness abwarten (90 x 2s) |
| Docker Desktop fehlt komplett | automatische Installation via winget (Windows) / brew (macOS), Fallback: direkter Download |
| Node.js fehlt | automatische Installation via winget (Windows) / brew (macOS) / apt (Linux), Fallback: direkter Download |
| Apple Silicon zieht amd64 Image | Multi-Arch-Release bauen (bereits implementiert: `linux/amd64,linux/arm64`) |
| bestehende Linux-Installationen brechen | Bash-CLI zunaechst unveraendert lassen, Hybrid-Strategie |
| Auto-Update unterscheidet sich je OS | Adapter fuer systemd, launchd und Scheduled Tasks (bereits implementiert in `service.ts`) |
| Electron und CLI driften auseinander | CLI bleibt kanonisch, Electron nutzt CLI |
| winget nicht verfuegbar (aeltere Windows-Versionen) | Fallback auf direkten MSI-Download + silent install |
| brew nicht verfuegbar (frische macOS-Installation) | Fallback auf direkten Download + manuelles Entpacken |
| Workflow-Laufzeit zu lang | Saubere Trennung: `build-and-push.yml` (Docker), `portable-cli.yml` (CLI), `electron-build.yml` (Desktop) — jeweils unabhaengig |
| GitHub Release existiert noch nicht bei Tag-Push | `softprops/action-gh-release@v2` erstellt Release automatisch als Draft falls noetig |

## Nicht-Ziele der ersten Version

- Caddy auf macOS/Windows automatisch konfigurieren
- Windows Service als Standard installieren (Scheduled Task ist pragmatischer)
- lokale Source-Builds als Endnutzer-Default verwenden
- Linux-Installer sofort ersetzen (Hybrid-Strategie, Bash-CLI bleibt)
- Auto-Update Scheduled Task / LaunchAgent auf Windows/macOS (nur Start-bei-Login in erster Version)

## Naechste Schritte

1. CI-Syntax-Checks fuer Installer ergaenzen:
   - `bash -n install/macos.sh`
   - PowerShell Parsercheck fuer `install/windows.ps1` mit `pwsh`
   - Tarball-/Checksum-/Extract-Test fuer `dist-portable-cli`
2. Echte OS-Verifikation:
   - macOS Apple Silicon mit Docker Desktop
   - Windows 11 mit Docker Desktop und WSL2
   - optional macOS Intel, falls Runner oder Hardware verfuegbar ist
3. End-to-End-Checkliste pro OS:
   - Remote-Installer per Einzeiler
   - Node/Docker-Detection und ggf. Auto-Install
   - `canvas-notebook` Wrapper direkt im Terminal/PowerShell nutzbar
   - Container startet auf `http://localhost:3456`
   - `canvas-notebook status`, `health`, `logs`, `update`, `service status`
   - `admin reset-password --password-stdin`
4. Linux-Migration erst nach erfolgreicher Desktop-Verifikation vorbereiten:
   - kein Austausch des produktiven Bash-Pfads
   - optionaler Parallel-Install der TypeScript-CLI
   - dokumentierte Parity-Matrix vor jeder Umstellung

## Ergebnis

Der Umbau teilt das `canvas-notebook` CLI in zwei Schichten:

1. portabler Docker-/Compose-/Config-Kern (`cli/src/core/`) — bereits implementiert
2. kleine OS-Adapter fuer Pfade, Service-Integration und Auto-Update (`platform.ts`, `service.ts`) — bereits implementiert

Zusaetzlich bekommt jede Plattform einen Remote-Installer, der per Einzeiler ausgefuehrt werden kann:

- `install/windows.ps1` — laedt Node.js, Docker Desktop und das portable CLI automatisch herunter und installiert alles
- `install/macos.sh` — analog fuer macOS
- `install.sh` — bleibt fuer Linux unveraendert

So bleibt die bestehende Linux-Funktionalitaet stabil, waehrend macOS und Windows echte Server-Installer mit Einzeiler-Support bekommen. Performance bleibt gut, weil alle Plattformen prebuilt Multi-Arch-Images verwenden und Updates nur bei Bedarf Container recreaten. Die Workflows sind sauber getrennt, sodass kein Workflow einen anderen verlaengert.
