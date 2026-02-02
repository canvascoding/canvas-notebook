# Canvas Notebook 📔

Canvas Notebook ist eine moderne Next.js-Webanwendung, die als Online-Notizbuch fungiert – ähnlich wie Obsidian, aber mit tiefer SSH-Integration, einem leistungsfähigen Datei-Browser und einem integrierten Terminal.

## ✨ Features

### 📁 Datei-Management & Browser
- **Hybrider Zugriff:** Unterstützung für lokales Dateisystem oder Remote-Zugriff via SSH/SFTP.
- **Vollständige Operationen:** Erstellen, Umbenennen, Verschieben und Löschen von Dateien und Ordnern.
- **Upload/Download:** Einfacher Dateitransfer zwischen lokalem Rechner und Workspace.
- **Connection Pooling:** Optimierte SSH-Verbindungen für hohe Performance.

### 📝 Editor & Viewer
- **Vielseitige Editoren:** 
  - **Markdown Editor:** Mit Live-Vorschau für Notizen.
  - **Code Editor:** Syntax-Highlighting für verschiedene Programmiersprachen.
  - **Auto-Save:** Automatisches Speichern der Änderungen.
- **Media Viewer:**
  - **PDF Viewer:** Direktes Lesen von PDF-Dokumenten.
  - **Image Viewer:** Unterstützung für gängige Bildformate.
  - **Media Player:** Abspielen von Audio- und Videodateien.

### 🤖 Claude AI Agent (Neu)
- **Integriertes Claude Code CLI:** Claude arbeitet direkt in deinem Workspace.
- **Autonome Operationen:** Erstellen von Projekten, Ausführen von Shell-Befehlen und Bearbeiten von Code via Chat.
- **Session-Persistence:** Chat-Verläufe und Kontexte werden in einer SQLite-Datenbank gespeichert.
- **Bilder-Support:** Direkter Upload von Screenshots zur Analyse durch Claude.

### 💻 Terminal & System
- **Integriertes Terminal:** Volle Shell-Erfahrung im Browser (xterm.js + node-pty).
- **Zero-Latency:** Direkter Zugriff auf lokale PTYs (Pseudo-Terminals) ohne SSH-Overhead in der lokalen Umgebung.
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
SSH_BASE_PATH=/absoluter/pfad/zum/workspace
BETTER_AUTH_URL=https://deine-domain.com
NEXT_PUBLIC_WS_URL=wss://deine-domain.com

# Datenbank
# SQLite wird automatisch in der Datei sqlite.db erstellt
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
Erstellen Sie eine `.env.local` Datei im Wurzelverzeichnis (siehe `.env.example` oder bestehende Dokumentation):

```bash
# File System Modus
SSH_USE_LOCAL_FS=true
SSH_BASE_PATH=/pfad/zu/deinem/workspace

# App Login
APP_USERNAME=admin
APP_PASSWORD_HASH=your_bcrypt_hash
SESSION_SECRET=your_32_character_secret
```

### Development-Server starten
```bash
npm run dev
```
Die App ist nun unter [http://localhost:3000](http://localhost:3000) erreichbar.

---

## 🏗️ Tech Stack

- **Frontend:** Next.js (App Router), React, TypeScript
- **Styling:** Tailwind CSS, shadcn/ui, Radix UI, Lucide Icons
- **State:** Zustand
- **Backend:** Next.js API Routes, Node.js Custom Server (für WebSockets)
- **SSH/SFTP:** ssh2, ssh2-sftp-client
- **Terminal:** xterm.js, node-pty

---

## 🧪 Testing

Das Projekt verfügt über eine umfassende Test-Suite:

- **Smoke Tests:** `npm run test:smoke` (Schnelle Funktionsprüfung)
- **Integration Tests:** `npm run test:integration` (API-Tests)
- **E2E Tests:** `npm run test:e2e` (Vollständige UI-Tests mit Playwright)
- **All-in-One:** `npm run test:all`

---

## 📂 Projektstruktur

- `app/`: Next.js App Router (Pages & API Routes)
- `components/`: UI-Komponenten (shadcn/ui & Custom Components)
- `lib/`: Hilfsfunktionen für SSH, Auth und Utilities
- `server/`: Custom Server-Logik für Terminals und Sessions
- `store/`: Zustandshaltung mit Zustand
- `scripts/`: Hilfsskripte für Deployment und Setup

---

## 📄 Lizenz

Privates Projekt - Canvas Studios. Alle Rechte vorbehalten.