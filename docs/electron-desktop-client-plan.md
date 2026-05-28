# Electron Desktop Client Plan

> Date: 2026-05-28
> Status: Draft

## Ziel

Canvas Notebook soll als macOS- und spaeter Windows-Desktop-App nutzbar werden. Die Desktop-App ist dabei zunaechst nur ein nativer Client fuer eine vom Nutzer selbst gehostete Canvas-Notebook-Instanz.

Die Electron-App speichert keine Projekt- oder Agent-Daten lokal als Quelle der Wahrheit. Alle fachlichen Daten, Dateien, Agent-Runtime-Zustaende, Integrationsdaten und Terminal-Sessions bleiben auf dem Server.

```text
Electron Desktop App
  native window
  server-url setup
  hosted web app view
  optional desktop bridges

Canvas Notebook Server
  Next.js app
  REST API
  WebSocket API
  auth
  storage
  agent runtime
```

## Grundentscheidung

V1 soll bewusst keine lokal gebundelte Next.js-App und keinen lokalen Node-Server starten.

Stattdessen:

1. Die Electron-App startet ein natives Desktop-Fenster.
2. Beim ersten Start gibt der Nutzer seine Server-URL ein.
3. Die App prueft den Server ueber `/api/health`.
4. Die Server-URL wird lokal in der Desktop-Konfiguration gespeichert.
5. Das Hauptfenster laedt die gehostete Webapp von dieser URL.

Beispiel:

```text
https://notebook.example.com
```

Dadurch bleiben Deployments, Updates und Daten zentral auf dem Server. Die Desktop-App ist nur die native Shell und der Connector zur bestehenden REST- und WebSocket-API.

## Warum V1 als Remote-Webapp-Shell

Vorteile:

- geringere Einstiegskomplexitaet
- keine lokale Next.js-Bundling-Strategie noetig
- keine lokale Server-Orchestrierung in Electron
- Webapp-Updates sind sofort in der Desktop-App sichtbar
- Daten bleiben zentral und geraeteuebergreifend konsistent
- macOS- und Windows-Client koennen denselben Ansatz nutzen
- Mobile/PWA bleibt als spaeterer Pfad offen

Nicht-Ziele fuer V1:

- kein lokaler Next.js-Server in Electron
- keine lokale `/data`-Ablage fuer fachliche App-Daten
- kein Offline-Modus
- keine grosse React-State-Refactor-Runde
- kein Auto-Updater
- kein Code Signing / Notarization
- kein Windows Installer
- keine Keychain-Integration, solange die bestehende Server-Session ausreicht

## V1 Funktionsumfang

### Desktop Shell

- Electron Main Process
- macOS App-Fenster mit nativer Titelleiste
- native macOS-Fensterbuttons oben links
- App-Menue mit Basisaktionen:
  - Reload
  - Back
  - Forward
  - Open in Browser
  - Reset Server URL
  - Quit
- externe Links im Systembrowser oeffnen
- Fensterzustand speichern:
  - Groesse
  - Position
  - maximiert ja/nein

### Server Setup

- erster Start zeigt eine Server-URL-Eingabe
- URL normalisieren
- HTTPS bevorzugen
- `/api/health` pruefen
- klare Fehlermeldung, wenn der Server nicht erreichbar ist
- Server-URL lokal speichern
- Server-URL spaeter zuruecksetzen oder wechseln

### Security Defaults

Electron darf der geladenen Webapp keine freien Node-Rechte geben.

Pflicht-Defaults:

```ts
nodeIntegration: false
contextIsolation: true
sandbox: true
```

IPC nur ueber eine kleine, erlaubte Preload-API:

```ts
window.canvasDesktop = {
  getServerUrl()
  setServerUrl(url)
  clearServerUrl()
  getAppVersion()
  openExternal(url)
}
```

Die Webapp bekommt keinen direkten Zugriff auf `fs`, `child_process`, Shell-Kommandos oder beliebige IPC-Kanaele.

## Repository-Struktur

Vorgeschlagene neue Struktur:

```text
electron/
  main/
    main.ts
    window.ts
    menu.ts
    ipc.ts
    config-store.ts
  preload/
    index.ts
  assets/
    icon.icns
    icon.ico
```

Optional spaeter:

```text
electron/
  main/
    updater.ts
    deep-links.ts
    keychain.ts
```

Die bestehende App-Struktur bleibt unvermischt:

```text
app/
components/
server/
scripts/
```

Electron-spezifischer Code soll nicht quer durch React-Komponenten verteilt werden. Falls die Webapp spaeter Desktop-Kontext braucht, dann nur ueber kleine runtime-neutrale Adapter.

## Lokale Desktop-Konfiguration

Die Server-URL wird lokal in der Desktop-App gespeichert.

Speicherort ueber Electron:

```ts
app.getPath('userData')
```

Typische Plattformpfade:

```text
macOS:
~/Library/Application Support/Canvas Notebook/

Windows:
%APPDATA%/Canvas Notebook/

Linux:
~/.config/Canvas Notebook/
```

Beispiel fuer lokale Config:

```json
{
  "serverUrl": "https://notebook.example.com",
  "window": {
    "width": 1440,
    "height": 960,
    "maximized": false
  }
}
```

Tokens und Secrets sollten nicht in dieser Config landen. Wenn spaeter Desktop-Tokens benoetigt werden, gehoeren sie in die OS Keychain oder in ein vergleichbares sicheres Credential-Backend.

## Auth-Strategie

Fuer V1 soll die bestehende Server-Auth weiterverwendet werden.

Primaerer Pfad:

- Electron laedt die gehostete Webapp.
- Login laeuft wie im Browser gegen den Server.
- Cookies und Sessions bleiben serverseitig kontrolliert.

Zu pruefen:

- Cookie-Samesite-Verhalten im Electron-Fenster
- CORS, falls API-Requests nicht same-origin laufen
- Logout-Verhalten
- Session-Ablauf und Re-Login

Spaeterer Ausbau:

- Desktop-spezifische Token-Speicherung in der OS Keychain
- explizite Device-Sessions
- Server-URL plus Account-Verwaltung fuer mehrere Instanzen

## Design und Native Feeling

V1 rendert innen exakt die bestehende Webapp. Electron macht die UI nicht automatisch nativer oder smoother, weil die Hauptoberflaeche weiterhin Chromium, React und Next.js ist.

macOS-Fensterbuttons sind trotzdem vorhanden, weil das Fenster nativ ist.

Empfehlung fuer V1:

```text
native titlebar
```

Spaeterer Design-Ausbau:

```text
titleBarStyle: 'hiddenInset'
```

Dann kann die Webapp eine eigene kompakte Desktop-Toolbar zeichnen, muss aber oben links Platz fuer die macOS-Fensterbuttons lassen.

Smoothere Uebergaenge im Datei-Explorer oder zwischen Pages entstehen nicht automatisch durch Electron. Dafuer braucht es eine passende Webapp-Architektur:

- persistente App-Shell
- File Explorer bleibt zwischen Routen gemountet
- Zustand-Stores fuer expanded folders, selection, tabs und scroll position
- sinnvolles API-Caching
- stabile WebSocket-Reconnects
- keine unnoetigen Full Reloads oder Remounts

Diese Verbesserungen sollten separat geplant werden, weil sie Webapp und Desktop-App gemeinsam verbessern.

## Package Scripts

Vorgeschlagene Scripts:

```json
{
  "scripts": {
    "electron:dev": "electron-vite dev",
    "electron:build": "npm run build && electron-vite build",
    "electron:pack": "npm run build && electron-builder --dir",
    "electron:dist": "npm run build && electron-builder"
  }
}
```

Die genaue Toolwahl ist noch festzulegen. Moegliche Optionen:

- `electron-vite` fuer Main/Preload-Build
- `electron-builder` fuer Packaging
- alternativ `electron-forge`

Projektregel:

- vor Packaging immer `npm run build`
- fuer Electron keinen Container bauen
- Dev Server nur auf `localhost:3000`
- keinen neuen Dev Server starten, wenn bereits einer laeuft

## Testplan fuer V1

Minimal:

1. `npm run build`
2. Electron Dev Shell starten
3. Server-URL setzen
4. `/api/health` pruefen
5. Webapp im Electron-Fenster laden
6. Login pruefen
7. REST-Aufruf in der App pruefen
8. WebSocket-Funktion pruefen
9. Native Notification bei eingehender Chat-/Agent-Meldung pruefen, wenn das Electron-Fenster im Hintergrund ist
10. Klick auf Notification pruefen: App fokussiert sich und oeffnet die Session
11. Server-URL zuruecksetzen und neu setzen
12. externe Links oeffnen im Systembrowser

UI- und E2E-Pruefungen sollen gemaess Repository-Regel nur mit Playwright oder vergleichbaren Browser-Tools laufen, wenn das explizit freigegeben wurde oder vorher gefragt wurde.

## Notifications in V1

Die Electron-App zeigt native OS-Notifications fuer Chat-/Agent-Meldungen, wenn die App laeuft und das Webapp-Fenster im Hintergrund oder nicht fokussiert ist. Die Notification nutzt den bestehenden WebSocket-Notification-Event der Webapp und wird ueber eine sichere Preload-Bridge an den Electron-Main-Prozess weitergereicht.

Einschraenkung: Das ist kein echter Push bei komplett beendeter App. Dafuer waere spaeter ein separater Push-/APNs-/FCM-Flow noetig.

## V2 Ausbaustufe

Nach erfolgreichem V1-MVP:

- native Downloads mit Save Dialog
- native Upload-/Open-File-Dialoge
- erweiterte Notification-Einstellungen und optional echter Push fuer beendete Apps
- App-Menue-Commands fuer wichtige Aktionen
- globale oder lokale Shortcuts
- OS Keychain fuer Desktop-Tokens
- Deep Links wie `canvas-notebook://workspace/...`
- optional Tray/Menu-Bar-Funktionen
- Packaging fuer macOS `.dmg` und `.zip`
- Windows Packaging vorbereiten

## V3 Ausbaustufe

Optional spaeter:

- lokale, gebundelte Client-UI statt gehosteter Webapp
- UI spricht remote REST/WS APIs
- mehr Kontrolle ueber Performance, App-Shell und Desktop-spezifische Layouts
- Auto-Updater
- Code Signing
- macOS Notarization
- Windows Installer und Signing

Diese Stufe ist deutlich komplexer und sollte erst angegangen werden, wenn V1 validiert ist und konkrete Desktop-spezifische Anforderungen sichtbar sind.

## Offene Entscheidungen

- Electron Toolchain: `electron-vite` plus `electron-builder` oder `electron-forge`
- finaler App-Name und App-ID
- Icon-Assets
- minimale macOS-Version
- Windows-Support direkt in V1 oder erst V2
- ob die Server-URL nur per Setup-Screen oder auch per Settings-Seite in der Webapp gewechselt wird
- ob `/api/health` fuer Desktop eine API-Version liefern soll
- ob spaeter eine eigene Desktop-Session im Backend modelliert wird

## Empfohlene Umsetzungsschritte

1. Electron-Grundstruktur anlegen.
2. Main Process, Window, Menu und Config Store bauen.
3. Setup-Fenster oder Setup-View fuer Server-URL implementieren.
4. Healthcheck gegen `/api/health` einbauen.
5. Hauptfenster laedt gespeicherte Server-URL.
6. externe Links in den Systembrowser auslagern.
7. Build- und Package-Scripts einbauen.
8. `npm run build` ausfuehren.
9. Manuelle Desktop-Smoke-Pruefung.
10. Erst danach V2-native Bridges planen.
