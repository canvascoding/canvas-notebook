# Cross-Platform Server Installer CLI Plan

## Ausgangslage

Canvas Notebook besteht fuer Endnutzer aus zwei getrennten Schichten:

- Electron ist nur der Desktop-Client. Er oeffnet eine konfigurierte Canvas-Notebook-Server-URL.
- Der eigentliche Server laeuft als Docker-Container mit persistenter `/data`-Ablage.

Der aktuelle Installer ist fuer Linux/VPS optimiert. `install.sh` installiert und verwaltet Docker, Compose, Konfiguration, systemd, Auto-Update, optional Caddy und den Host-Befehl `canvas-notebook`.

macOS und Windows koennen heute nicht denselben Server-Installer nutzen. Fuer lokale Setups gibt es `npm run setup`, aber das ist ein Developer-/Repository-Flow und kein sauberer Endnutzer-Installer.

## Ziel

Der Docker-Container soll auf Linux, macOS und Windows installierbar und verwaltbar sein, ohne die bestehende Linux-Installation zu brechen.

Das Zielbild:

- Linux/VPS bleibt stabil und kompatibel.
- macOS bekommt einen offiziellen lokalen Docker-Desktop-basierten Server-Installer.
- Windows bekommt einen offiziellen lokalen Docker-Desktop-/WSL2-basierten Server-Installer.
- Das `canvas-notebook` CLI bietet auf allen Plattformen moeglichst dieselben Kernbefehle.
- OS-spezifische Host-Features werden ueber Adapter geloest, nicht im portablen Kern vermischt.

## Designentscheidung

Das bestehende Bash-CLI sollte nicht direkt fuer macOS und Windows erweitert werden.

Gruende:

- Bash ist fuer Windows als Primaer-CLI ungeeignet.
- Die aktuelle Bash-Implementierung nutzt Linux-Tools und Linux-Pfade wie `systemctl`, `sudo`, `jq`, `sed`, `/opt`, `/var/log` und `/etc`.
- macOS liefert standardmaessig eine alte Bash-Version aus; einige aktuelle Bash-Patterns sind dort nicht robust.
- Shell-String-Komposition fuer Docker/Compose ist auf Windows-Pfaden fehleranfaellig.

Stattdessen sollte ein neues cross-platform CLI in TypeScript/Node entstehen. Dieses CLI wird als eigenes Artefakt ausgeliefert und nutzt Docker/Compose ueber `child_process.spawn()` mit Argument-Arrays statt Shell-Strings.

Die bestehende Linux-Bash-CLI bleibt waehrend der Migration unveraendert und kann spaeter optional als Wrapper auf das neue CLI umgestellt werden.

## Zielstruktur

```text
cli/
  src/
    main.ts
    commands/
      install.ts
      update.ts
      lifecycle.ts
      status.ts
      logs.ts
      admin.ts
      database.ts
      env.ts
      config.ts
      service.ts
    core/
      docker.ts
      compose.ts
      config-store.ts
      health.ts
      secrets.ts
      paths.ts
      logging.ts
      process.ts
    platform/
      index.ts
      linux.ts
      macos.ts
      windows.ts
```

## Portabler Kern

Diese Funktionen sollen OS-neutral implementiert werden:

- Docker-Verfuegbarkeit erkennen
- Docker Desktop/Daemon Health pruefen
- Compose-Datei schreiben und validieren
- `.env` und Container-Env aus `canvas-notebook-config.json` erzeugen
- Secrets generieren
- Image pullen
- Container starten, stoppen, recreaten
- Health-Check gegen `/api/health`
- Container-Logs streamen
- Status als Text und JSON ausgeben
- Admin-Passwort per `docker exec -i` setzen
- SQLite-zu-Postgres-Migration per `docker exec` starten

Wichtig: Docker-Kommandos sollen immer mit Argument-Arrays gestartet werden:

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

Diese Befehle sollen auf allen Plattformen gleich funktionieren:

| Befehl | Plattformverhalten |
| --- | --- |
| `canvas-notebook install` | Config erzeugen, Secrets erzeugen, Image pullen, Compose schreiben, Container starten, Health abwarten |
| `canvas-notebook update` | Image pruefen/pullen, Container nur bei Bedarf recreaten, Health abwarten |
| `canvas-notebook start` | Compose-Service starten, Health abwarten |
| `canvas-notebook restart` | Compose-Service recreaten oder neu starten, Health abwarten |
| `canvas-notebook stop` | Compose-Service stoppen |
| `canvas-notebook down` | Compose-Projekt stoppen und entfernen |
| `canvas-notebook status` | Compose-/Containerstatus anzeigen |
| `canvas-notebook status --json` | Maschinenlesbaren Status liefern |
| `canvas-notebook health` | Health-Endpunkt pruefen |
| `canvas-notebook logs` | Container-Logs streamen |
| `canvas-notebook manager-log` | Host-CLI-Log anzeigen |
| `canvas-notebook env` | aktive Konfiguration anzeigen/synchronisieren |
| `canvas-notebook config-show` | `canvas-notebook-config.json` anzeigen |
| `canvas-notebook config-set` | einzelne Config-Werte setzen |
| `canvas-notebook admin reset-password` | Passwort im laufenden Container per stdin synchronisieren |
| `canvas-notebook database migrate-sqlite-to-postgres` | Migrationsscript im Container ausfuehren |

## OS-spezifische Adapter

### Linux

Linux behaelt die aktuelle Funktionalitaet:

- Installationspfad: `/opt/canvas-notebook`
- Datenpfad: bisheriger `DATA_DIR`, aktuell typischerweise im User-Home oder unter dem Installationspfad
- Logpfad: `/var/log/canvas-notebook/manager.log`
- Service: systemd `canvas-notebook.service`
- Auto-Update: systemd timer
- Optional: Caddy
- Optional: Swap-Verwaltung

Der bestehende Bash-Installer bleibt zunaechst der produktive Linux/VPS-Pfad.

### macOS

macOS nutzt Docker Desktop als Voraussetzung.

Empfohlene Pfade:

| Zweck | Pfad |
| --- | --- |
| Installationsdaten | `~/Library/Application Support/Canvas Notebook/manager` |
| Persistente App-Daten | `~/Library/Application Support/Canvas Notebook/data` |
| Config | `~/Library/Application Support/Canvas Notebook/manager/canvas-notebook-config.json` |
| Compose-Datei | `~/Library/Application Support/Canvas Notebook/manager/canvas-notebook-compose.yaml` |
| Container-Env | `~/Library/Application Support/Canvas Notebook/manager/canvas-notebook.env` |
| Logs | `~/Library/Logs/Canvas Notebook/manager.log` |

Service-Integration:

- `launchd` LaunchAgent fuer Start beim Login:
  - `~/Library/LaunchAgents/io.canvasstudios.notebook.plist`
  - ruft `canvas-notebook start --no-banner` auf
- separater LaunchAgent fuer Auto-Update:
  - ruft `canvas-notebook cli-update` und `canvas-notebook update` oder nur `canvas-notebook update` auf

Docker-Verhalten:

- `docker info` pruefen
- wenn Docker Desktop installiert, aber nicht gestartet ist: optional `open -a Docker` und readiness abwarten
- wenn Docker fehlt: klare Installationsanleitung anzeigen
- keine automatische Docker-Desktop-Installation als Standard

Nicht macOS-relevant:

- Caddy-Integration standardmaessig ausblenden
- Swap-Befehle als unsupported markieren

### Windows

Windows nutzt Docker Desktop mit WSL2 Backend als Voraussetzung.

Empfohlene Pfade:

| Zweck | Pfad |
| --- | --- |
| Installationsdaten | `%LOCALAPPDATA%\Canvas Notebook\manager` |
| Persistente App-Daten | `%LOCALAPPDATA%\Canvas Notebook\data` |
| Config | `%LOCALAPPDATA%\Canvas Notebook\manager\canvas-notebook-config.json` |
| Compose-Datei | `%LOCALAPPDATA%\Canvas Notebook\manager\canvas-notebook-compose.yaml` |
| Container-Env | `%LOCALAPPDATA%\Canvas Notebook\manager\canvas-notebook.env` |
| Logs | `%LOCALAPPDATA%\Canvas Notebook\logs\manager.log` |

Service-Integration fuer die erste Version:

- Windows Scheduled Task statt Windows Service
- Task "At logon" fuer `canvas-notebook start --no-banner`
- separater taeglicher Scheduled Task fuer `canvas-notebook update --no-banner`

Warum kein Windows Service als erste Version?

- Docker Desktop ist oft an die User-Session gebunden.
- Ein Windows Service laeuft in einem anderen Kontext und sieht Docker Desktop nicht immer korrekt.
- Scheduled Tasks sind fuer lokale Desktop-Installationen pragmatischer und leichter zu debuggen.

Windows-spezifische Regeln:

- keine Bash-Abhaengigkeit
- keine PowerShell-Pipelines fuer Kernlogik
- Pfade immer ueber Node `path.win32`/native APIs normalisieren
- Docker-Kommandos als `docker.exe` mit Argument-Arrays starten

## Compose-Datei

Die Compose-Datei sollte aus einem strukturierten Modell geschrieben werden. Der portable Kern darf keine Linux-Defaults wie `/opt/canvas-notebook` in die generierte Datei schreiben.

Beispiel:

```yaml
services:
  canvas-notebook:
    container_name: canvas-notebook
    image: ghcr.io/canvascoding/canvas-notebook:latest
    ports:
      - "3456:3000"
    env_file:
      - "/absolute/platform/path/canvas-notebook.env"
    volumes:
      - "/absolute/platform/path/data:/data"
    restart: unless-stopped

  postgres:
    profiles:
      - postgres
    container_name: canvas-notebook-postgres
    image: pgvector/pgvector:0.8.3-pg18
    environment:
      POSTGRES_DB: canvas_notebook
      POSTGRES_USER: canvas
      POSTGRES_PASSWORD: "${CANVAS_POSTGRES_PASSWORD}"
    volumes:
      - canvas-postgres-data:/var/lib/postgresql
    restart: unless-stopped
```

Fuer Windows muss geprueft werden, ob Compose native Windows-Pfade in der Form `C:\Users\...` stabil akzeptiert. Falls noetig, schreibt der Windows-Adapter Docker-kompatible Mount-Pfade oder nutzt Compose-Path-Konventionen, die mit Docker Desktop getestet sind.

## Config-Format

Das bestehende `canvas-notebook-config.json` sollte als Quelle der Wahrheit erhalten bleiben.

Noetige Erweiterungen:

```json
{
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
  }
}
```

Die alte Struktur muss weiterhin gelesen werden. Migrationen duerfen bestehende Linux-Installationen nicht zerstoeren.

## Image-Strategie

Fuer Performance und echte macOS-Unterstuetzung ist ein Multi-Arch-Image wichtig.

Aktuell sollte das Docker-Release auf mindestens diese Plattformen erweitert werden:

- `linux/amd64`
- `linux/arm64`

Ohne `linux/arm64` laeuft Apple Silicon entweder gar nicht sauber oder langsam ueber Emulation. Der lokale `npm run setup`-Build umgeht das teilweise, ist fuer Endnutzer aber zu langsam und nicht der gewuenschte Installationspfad.

## Performance-Anforderungen

- Der Endnutzer-Installer soll standardmaessig das prebuilt Image pullen, nicht lokal bauen.
- `update` soll den Container nur recreaten, wenn Image, Compose oder relevante Config geaendert wurde.
- Health-Checks sollen kurze Timeouts und klare Progress-Ausgaben haben.
- Status-Abfragen sollen parallelisiert werden:
  - Config lesen
  - Docker container inspect
  - Docker image inspect
  - HTTP health
- Logs werden gestreamt, aber nicht dauerhaft doppelt als orphaned follower gestartet.

## Installer-Flows

### Linux/VPS

Bestehender Flow bleibt:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh)
```

Optionaler spaeterer Schritt:

- `install.sh` installiert statt der Bash-CLI das neue Node/Standalone-CLI.
- Die systemd Units bleiben gleich, rufen aber die neue Binary auf.

### macOS

Moeglicher Endnutzer-Flow:

```bash
curl -fsSL https://canvasnotebook.app/install/macos | sh
```

Der Installer:

1. installiert oder entpackt das `canvas-notebook` CLI nach `~/bin` oder `/usr/local/bin`
2. prueft Docker Desktop
3. erzeugt Config, Secrets und Datenpfade
4. schreibt Compose-Datei
5. pullt das Image
6. startet den Container
7. legt optional LaunchAgent an
8. oeffnet `http://localhost:3456`

### Windows

Moeglicher Endnutzer-Flow:

```powershell
irm https://canvasnotebook.app/install/windows.ps1 | iex
```

Der Installer:

1. installiert oder entpackt `canvas-notebook.exe`
2. prueft Docker Desktop und WSL2 Backend
3. erzeugt Config, Secrets und Datenpfade
4. schreibt Compose-Datei
5. pullt das Image
6. startet den Container
7. legt optional Scheduled Tasks an
8. oeffnet `http://localhost:3456`

## Beziehung zu Electron

Electron sollte nicht die einzige Server-Management-Schicht sein.

Empfohlen:

- Das CLI ist die kanonische Server-Management-Schicht.
- Electron kann spaeter das CLI aufrufen, um "lokalen Server installieren/starten" anzubieten.
- Der Server-Installer muss auch ohne Electron funktionieren.

Damit bleibt die Architektur testbar:

- CLI kann headless getestet werden.
- Electron bleibt Client/UI.
- Control Plane und Host-Automatisierung koennen dasselbe CLI verwenden.

## Migrationsstrategie

### Phase 1: Paralleles CLI

- neues TypeScript-CLI erstellen
- nur portable Kernbefehle implementieren
- noch keine bestehende Linux-Bash-CLI ersetzen
- Fake-Docker-Tests fuer Command-Parity

### Phase 2: macOS Installer

- macOS-Pfade und LaunchAgent-Adapter implementieren
- Docker Desktop Detection
- prebuilt Image Pull
- manueller und automatisierter Test auf Intel und Apple Silicon

### Phase 3: Windows Installer

- Windows-Pfade und Scheduled-Task-Adapter implementieren
- Docker Desktop/WSL2 Detection
- Pfad-/Volume-Mount-Tests
- Test ohne Git/Bash-Abhaengigkeit

### Phase 4: Linux-Adapter

- systemd-Adapter im neuen CLI implementieren
- bestehende Linux-CLI-Commands gegen neue CLI vergleichen
- optional Bash-CLI als Wrapper oder Legacy-Fallback behalten

### Phase 5: Electron-Integration

- Electron Setup-Screen kann lokalen Server erkennen
- wenn kein Server konfiguriert ist: "Local server installieren/starten"
- Electron ruft CLI auf und zeigt Progress/Fehler an

## Testplan

Unit-/Script-Tests:

- Config-Migration
- Secret-Generierung
- Compose-Generierung fuer Linux/macOS/Windows
- Docker-Command-Argumente mit Fake-Docker
- `status --json`
- `admin reset-password --password-stdin`
- Update-Entscheidung: recreate nur bei geaendertem Image/Config

Manuelle OS-Tests:

- macOS Apple Silicon
- macOS Intel, falls verfuegbar
- Windows 11 mit Docker Desktop WSL2
- Ubuntu/Debian VPS bestehender Installer

Regression Guard:

- bestehende Linux-Installer-Tests duerfen nicht entfernt werden
- Linux-Bash-Pfad bleibt bis zur vollstaendigen Parity produktiv

## Risiken

| Risiko | Gegenmassnahme |
| --- | --- |
| Windows-Docker-Pfade brechen Volume-Mounts | eigene Compose-Path-Tests auf Windows |
| Docker Desktop ist installiert, aber nicht gestartet | klare Detection, Start-Hinweis, optional automatischer Start |
| Apple Silicon zieht amd64 Image | Multi-Arch-Release bauen |
| bestehende Linux-Installationen brechen | Bash-CLI zunaechst unveraendert lassen |
| Auto-Update unterscheidet sich je OS | Adapter fuer systemd, launchd und Scheduled Tasks |
| Electron und CLI driften auseinander | CLI bleibt kanonisch, Electron nutzt CLI |

## Nicht-Ziele der ersten Version

- Caddy auf macOS/Windows automatisch konfigurieren
- Windows Service als Standard installieren
- Docker Desktop automatisch und still installieren
- lokale Source-Builds als Endnutzer-Default verwenden
- Linux-Installer sofort ersetzen

## Ergebnis

Der Umbau sollte das `canvas-notebook` CLI in zwei Schichten aufteilen:

1. portabler Docker-/Compose-/Config-Kern
2. kleine OS-Adapter fuer Pfade, Service-Integration und Auto-Update

So bleibt die bestehende Linux-Funktionalitaet stabil, waehrend macOS und Windows echte Server-Installer bekommen. Performance bleibt gut, weil alle Plattformen prebuilt Multi-Arch-Images verwenden und Updates nur bei Bedarf Container recreaten.
