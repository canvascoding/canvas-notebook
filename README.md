# Canvas Notebook 📔

Canvas Notebook ist eine moderne Next.js-Webanwendung, die als Online-Notizbuch fungiert – ähnlich wie Obsidian, mit leistungsfähigem Datei-Browser und integriertem Terminal.

## ✨ Features

### 📁 Datei-Management & Browser
- **Lokaler Workspace:** Direkter Zugriff auf das lokale Dateisystem im Workspace.
- **Vollständige Operationen:** Erstellen, Umbenennen, Verschieben und Löschen von Dateien und Ordnern.
- **Upload/Download:** Einfacher Dateitransfer zwischen lokalem Rechner und Workspace.

### 📝 Editor & Viewer
- **Vielseitige Editoren:** 
  - **Markdown Editor:** Mit Live-Vorschau für Notizen.
  - **Code Editor:** Syntax-Highlighting für verschiedene Programmiersprachen.
  - **Auto-Save:** Automatisches Speichern der Änderungen.
- **Media Viewer:**
  - **PDF Viewer:** Direktes Lesen von PDF-Dokumenten.
  - **Image Viewer:** Unterstützung für gängige Bildformate.
  - **Media Player:** Abspielen von Audio- und Videodateien.

### 🤖 AI Agent
- **Provider-basiert:** Codex CLI, OpenRouter und Ollama (native API) sind konfigurierbar.
- **Autonome Operationen:** Erstellen von Projekten, Ausführen von Shell-Befehlen und Bearbeiten von Code via Chat.
- **Session-Persistence:** Chat-Verläufe und Kontexte werden in einer SQLite-Datenbank gespeichert.
- **Bilder-Support:** Direkter Upload von Screenshots zur Analyse durch CLI-Provider.

### 💻 Terminal & System
- **Integriertes Terminal:** Volle Shell-Erfahrung im Browser (xterm.js + node-pty).
- **Zero-Latency:** Direkter Zugriff auf lokale PTYs (Pseudo-Terminals).
- **Session Management:** Persistente Terminal-Sitzungen.

---

## 🚀 Deployment & Produktion (Ubuntu)

Um die Anwendung auf einem Ubuntu-Server in Produktion zu nehmen, befolge diese Schritte:

### 1. System-Voraussetzungen
Ubuntu benötigt Compiler-Tools, um native Module wie `node-pty` zu bauen:
```bash
sudo apt-get update
sudo apt-get install -y build-essential python3
```

### 2. Installation & Native Module
Native Module müssen auf dem Zielsystem kompiliert werden. Kopiere **nicht** den `node_modules` Ordner von deinem Mac/Windows auf den Server.
```bash
# Auf dem Server im Projektordner:
npm install
npm rebuild node-pty --build-from-source
```

### 3. Umgebungsvariablen (.env)
Erstelle eine `.env` Datei für die Produktion:
```bash
# Wichtige Produktions-Settings
NODE_ENV=production
# Basis-Pfad für alle App-Daten (workspace, sqlite.db, skills, etc.)
DATA=/data
BETTER_AUTH_SECRET=dein_langer_random_secret
BETTER_AUTH_BASE_URL=https://deine-domain.com
BASE_URL=https://deine-domain.com
ALLOW_SIGNUP=false

# Datenbank
# SQLite wird unter ${DATA}/sqlite.db erstellt (Verzeichnis muss beschreibbar sein)
```

### 4. Nginx Konfiguration
Stelle sicher, dass dein Nginx für WebSockets konfiguriert ist. Nutze die Vorlagen in `config/nginx/`. Wichtig sind die Header für das Connection-Upgrade:
```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### 5. Start mit PM2 (Empfohlen)
Baue die Anwendung und starte sie mit einem Prozess-Manager:
```bash
npm run build
pm2 start server.js --name "canvas-notebook"
```

---

## 🚀 Schnellstart (Development)

### Voraussetzungen
- **Node.js:** >= 20.9.0
- **npm:** Aktuelle Version

### Installation
1. Repository klonen und Verzeichnis betreten.
2. Abhängigkeiten installieren:
   ```bash
   npm install
   ```

### Konfiguration
Für lokale Entwicklung eine `.env.local` Datei im Wurzelverzeichnis anlegen:

```bash
# Basis-Pfad für alle App-Daten (workspace, sqlite.db, skills, etc.)
DATA=./data

# Auth
BETTER_AUTH_SECRET=your_32_byte_secret
BETTER_AUTH_BASE_URL=http://localhost:3000
ALLOW_SIGNUP=false
```

### Development-Server starten
```bash
npm run dev
```
Wenn Port `3000` bereits vom Test-Container belegt ist, wechselt der Dev-Start automatisch auf einen freien lokalen Port ab `3001`.

Für Docker/Compose eine separate `.env.docker.local` verwenden, z. B. auf Basis von `.env.docker.example`.

---

## 🏗️ Tech Stack

- **Frontend:** Next.js (App Router), React, TypeScript
- **Styling:** Tailwind CSS, shadcn/ui, Radix UI, Lucide Icons
- **State:** Zustand
- **Backend:** Next.js API Routes, Node.js Custom Server (für WebSockets)
- **Terminal:** xterm.js, node-pty

---

## 🧪 Testing

Das Projekt verfügt über eine umfassende Test-Suite:

- **Smoke Tests:** `npm run test:smoke` (Schnelle Funktionsprüfung)
- **Integration Tests:** `npm run test:integration` (API-Tests)
- **E2E Tests:** `npm run test:e2e` (Vollständige UI-Tests mit Playwright)
- **All-in-One:** `npm run test:all`

Für `test:smoke` und `test:integration` werden Login-Credentials via
`TEST_LOGIN_EMAIL` und `TEST_LOGIN_PASSWORD` erwartet.
`test:all` setzt dafür automatisch einen Bootstrap-Admin, falls nicht bereits gesetzt.

---

## 🐳 Docker

### Image bauen
```bash
docker build -t canvas-notebook:local .
```

### Warum `sqlite.db` in `.dockerignore` steht
`sqlite.db` wird absichtlich **nicht** ins Image eingebaut.
Die Datenbank liegt zur Laufzeit unter `/data/sqlite.db` und bleibt über ein Volume oder Bind-Mount persistent.
Der Workspace liegt unter `/data/workspace` und bleibt dort ebenfalls persistent. Automationen verwenden einen internen App-Scheduler; es wird kein Linux-`cron` oder `crontab` im Container installiert oder vorausgesetzt.

### Container lokal starten (Bind-Mount auf `./data`)
```bash
docker run --rm -p 3000:3000 \
  --env-file .env.docker.local \
  -e HOSTNAME=0.0.0.0 \
  -e BETTER_AUTH_SECRET=change-me-long-random-secret \
  -e DATA=/data \
  -e ALLOW_SIGNUP=false \
  -v "$(pwd)/data:/data" \
  canvas-notebook:local
```

### Container lokal starten (Named Volume)
```bash
docker volume create canvas_notebook_data

docker run --rm -p 3000:3000 \
  --env-file .env.docker.local \
  -e HOSTNAME=0.0.0.0 \
  -e BETTER_AUTH_SECRET=change-me-long-random-secret \
  -e DATA=/data \
  -e ALLOW_SIGNUP=false \
  --mount source=canvas_notebook_data,target=/data \
  canvas-notebook:local
```

### Mit Docker Compose (empfohlen)
```bash
cp .env.docker.example .env.docker.local
docker compose up -d --build
```

### Deployment wie n8n (vorgebautes GHCR-Image)
Wenn EasyPanel nur ein Docker-Image pullen soll (ohne Build auf dem Server), nutze das GitHub-Workflow-File:
`/.github/workflows/build-and-push-ghcr.yml`

Der Flow:
1. Push nach `main`
2. GitHub Actions baut das Image
3. Push nach `ghcr.io/<github-user>/<repo>` mit Tags wie `latest` und `sha-...`
4. EasyPanel nutzt als Source `Docker image` statt `GitHub`

Wichtige Hinweise:
- Das in EasyPanel eingetragene Image ist z. B. `ghcr.io/<github-user>/<repo>:latest`.
- Wenn dein EasyPanel-Dialog nur öffentliche Images erlaubt, stelle das GHCR-Package auf `Public`.
- Bei `Source: Docker image` wird in EasyPanel nicht erneut gebaut, sondern nur gepullt und gestartet.
- Optionaler Auto-Deploy: Lege in GitHub unter `Settings -> Secrets and variables -> Actions` ein Secret `EASYPANEL_DEPLOY_WEBHOOK_URL` an. Nach erfolgreichem GHCR-Build triggert der Workflow dann automatisch den EasyPanel Deploy-Webhook.

### Optionale CLI-Tools beim Container-Start
Beim Start prüft der Container, ob optionale AI-CLI-Tools (`codex`, `ollama`) im `PATH` verfügbar sind.

Falls `codex` fehlt, wird es einmalig nachinstalliert:
`npm i -g @openai/codex@latest`

Falls `ollama` fehlt, wird die offizielle Ollama-CLI via `https://ollama.com/install.sh` installiert.

Mit einem persistenten Mount auf `/home/node` bleiben die user-scope CLI-Installationen erhalten und werden bei späteren Starts wiederverwendet.
In `compose.yaml` wird fuer Ollama zusaetzlich ein eigenes Volume auf `/ollama` gemountet; ueber `OLLAMA_MODELS=/ollama/models` bleiben dort Modelle und Ollama-Daten persistent, ohne `/usr/local` zu mounten.

Das Login kann danach manuell im Container erfolgen (z. B. per `codex login`).
Falls du die Auto-Install deaktivieren willst, setze:
```bash
-e AI_CLI_AUTO_INSTALL=false
```
Legacy bleibt kompatibel: `CODEX_AUTO_INSTALL` wird weiterhin als Fallback unterstützt.

Falls du den Ollama-Install deaktivieren willst, setze:
```bash
-e OLLAMA_CLI_AUTO_INSTALL=false
```

### Initiales User-Onboarding (ohne UI-Benutzermanagement)
Es gibt zwei Wege für den ersten Account:

1. Einmalig Signup aktivieren, dann wieder deaktivieren
```bash
docker run --rm -p 3000:3000 \
  --env-file .env.local \
  -e HOSTNAME=0.0.0.0 \
  -e BETTER_AUTH_SECRET=change-me-long-random-secret \
  -e DATA=/data \
  -e ALLOW_SIGNUP=true \
  -v "$(pwd)/data:/data" \
  canvas-notebook:local
```
Danach Account über `http://localhost:3000/sign-up` erstellen und `ALLOW_SIGNUP` wieder auf `false` setzen.

2. Admin beim Start automatisch anlegen (idempotent)
```bash
docker run --rm -p 3000:3000 \
  --env-file .env.local \
  -e HOSTNAME=0.0.0.0 \
  -e BETTER_AUTH_SECRET=change-me-long-random-secret \
  -e DATA=/data \
  -e ALLOW_SIGNUP=false \
  -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD=change-me \
  -e BOOTSTRAP_ADMIN_NAME=Administrator \
  -v "$(pwd)/data:/data" \
  canvas-notebook:local
```
Der Bootstrap läuft bei jedem Start, legt den User aber nur an, wenn er fehlt.

### Kurzer Funktionstest
```bash
curl -I http://localhost:3000/login
```

---

## 📂 Projektstruktur

- `app/`: Next.js App Router (Pages & API Routes)
- `components/`: UI-Komponenten (shadcn/ui & Custom Components)
- `lib/`: Hilfsfunktionen für Dateisystem, Auth und Utilities
- `server/`: Custom Server-Logik für Terminals und Sessions
- `store/`: Zustandshaltung mit Zustand
- `scripts/`: Hilfsskripte für Deployment und Setup

---

## 📄 Lizenz

Privates Projekt - Canvas Notebook. Alle Rechte vorbehalten.
