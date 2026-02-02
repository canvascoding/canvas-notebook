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

### 💻 Terminal & System
- **Integriertes Terminal:** Volle Shell-Erfahrung im Browser (xterm.js + node-pty).
- **Session Management:** Persistente Terminal-Sitzungen.
- **Resizable Layout:** Flexibel anpassbare Benutzeroberfläche.

### 🛡️ Sicherheit
- **Authentifizierung:** Sicheres Login mit iron-session und bcrypt Hashing.
- **SSH-Sicherheit:** Unterstützung für Key-basierte Authentifizierung (empfohlen).
- **Schutzmechanismen:** Rate Limiting, CSRF-Schutz und Directory Traversal Protection.

---

## 🚀 Schnellstart

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