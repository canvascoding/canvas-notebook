# Cross-Platform Server Installer CLI Plan

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

- Kompletter portabler Kern mit allen Befehlen (`install`, `update`, `start`, `stop`, `restart`, `down`, `status`, `health`, `logs`, `admin reset-password`, `database migrate-sqlite-to-postgres`, `service install/uninstall/status`, `config-show`, `config-set`, `env --sync`)
- OS-spezifische Pfad-Resolution fuer Linux (`/opt/canvas-notebook`), macOS (`~/Library/Application Support/Canvas Notebook/...`), Windows (`%LOCALAPPDATA%\Canvas Notebook\...`)
- Service-Adapter: systemd (Linux), launchd (macOS), scheduled-task (Windows)
- Multi-Arch Docker-Image (`linux/amd64,linux/arm64`) via `build-and-push.yml`
- Compose-Datei-Generierung aus `canvas-notebook-config.json`
- Secret-Generierung (`BETTER_AUTH_SECRET`, `CANVAS_INTERNAL_API_KEY`)
- SQLite-zu-Postgres-Migration
- `package-portable-cli.mjs` packt `dist-cli/` + `install/{macos.sh,windows.ps1}` + README
- `portable-cli.yml` baut das CLI-Bundle bei Tag-Push

**Was noch fehlt:**

- Remote-taugliche Install-Skripte (aktuell brauchen `install/windows.ps1` und `install/macos.sh` einen Repo-Checkout)
- CLI-Bundle als oeffentliches Release-Asset (aktuell nur Workflow-Artifact)
- Auto-Install von Node.js (winget/brew/apt)
- Auto-Install von Docker Desktop (winget/brew)
- Separater Workflow fuer CLI-Build (aktuell im `build-and-push.yml` enthalten oder verlaengert diesen)
- Tests auf Windows und macOS Runners

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

### Phase 1: Portable CLI veroeffentlichen (CURRENT)

**Status: In Arbeit**

- Portable CLI in GitHub Release als `.tar.gz` veroeffentlichen (`portable-cli.yml` anpassen)
- `package-portable-cli.mjs` um Tarball-Erzeugung erweitern
- Download-URL stabilisieren: `github.com/.../releases/latest/download/canvas-notebook-cli.tar.gz`

### Phase 2: Windows Remote-Installer

- `install/windows.ps1` als Remote-Installer neu schreiben (keine Repo-Checkout-Abhaengigkeit)
- Node.js Auto-Install via winget
- Docker Desktop Auto-Install via winget
- Portable CLI von Release-URL herunterladen + entpacken
- CLI-Wrapper in PATH installieren
- Container + Scheduled Task installieren
- Test auf `windows-latest` GH Actions Runner

### Phase 3: macOS Remote-Installer

- `install/macos.sh` als Remote-Installer neu schreiben (keine Repo-Checkout-Abhaengigkeit)
- Node.js Auto-Install via brew
- Docker Desktop Auto-Install via brew
- Portable CLI von Release-URL herunterladen + entpacken
- CLI-Wrapper in PATH installieren
- Container + LaunchAgent installieren
- Test auf `macos-latest` GH Actions Runner

### Phase 4: Linux-Hybrid (spaeter)

- `install.sh` um optionales portable CLI erweitern (wenn Node verfuegbar)
- Bash-CLI bleibt als Fallback
- Keine aktive Umstellung bis Phase 2 + 3 erfolgreich getestet

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

## Ergebnis

Der Umbau teilt das `canvas-notebook` CLI in zwei Schichten:

1. portabler Docker-/Compose-/Config-Kern (`cli/src/core/`) — bereits implementiert
2. kleine OS-Adapter fuer Pfade, Service-Integration und Auto-Update (`platform.ts`, `service.ts`) — bereits implementiert

Zusaetzlich bekommt jede Plattform einen Remote-Installer, der per Einzeiler ausgefuehrt werden kann:

- `install/windows.ps1` — laedt Node.js, Docker Desktop und das portable CLI automatisch herunter und installiert alles
- `install/macos.sh` — analog fuer macOS
- `install.sh` — bleibt fuer Linux unveraendert

So bleibt die bestehende Linux-Funktionalitaet stabil, waehrend macOS und Windows echte Server-Installer mit Einzeiler-Support bekommen. Performance bleibt gut, weil alle Plattformen prebuilt Multi-Arch-Images verwenden und Updates nur bei Bedarf Container recreaten. Die Workflows sind sauber getrennt, sodass kein Workflow einen anderen verlaengert.