export interface Tutorial {
  id: string;
  title: string;
  description: string;
  thumbnail?: string;
  videoUrl?: string;
  content: string;
  links: { label: string; href: string; variant?: 'default' | 'outline' }[];
}

const deTutorials: Tutorial[] = [
  {
    id: 'provider-setup',
    title: 'Provider einrichten',
    description: 'Lerne, wie du API-Provider wie OpenAI, Anthropic oder Google konfigurierst',
    content: `# Provider einrichten

Canvas Notebook unterstützt verschiedene AI-Provider für die Agent-Funktionalität. Hier erfährst du Schritt für Schritt, wie du sie einrichtest.

## Was sind Provider?

Provider sind Dienste, die KI-Modelle zur Verfügung stellen. Canvas Notebook unterstützt aktuell folgende Provider:

- **OpenAI** – GPT-4, GPT-3.5 und weitere Modelle
- **Anthropic** – Claude Modelle
- **Google** – Gemini Modelle
- **Weitere** – können bei Bedarf hinzugefügt werden

## Schritt-für-Schritt Anleitung

### 1. API-Key besorgen

Zuerst benötigst du einen API-Key von deinem gewählten Provider:

1. Erstelle einen Account beim gewünschten Provider
2. Navigiere zu den API-Einstellungen
3. Generiere einen neuen API-Key
4. Kopiere den Key sicher

### 2. In Canvas Notebook eintragen

Sobald du den API-Key hast:

1. Öffne die **Einstellungen**
2. Wähle den Tab **Agent Settings**
3. Wähle deinen Provider aus dem Dropdown
4. Füge den API-Key in das entsprechende Feld ein

### 3. Modell auswählen

Nach dem Speichern kannst du das passende Modell wählen:

- **GPT-4** – Beste Qualität, höhere Kosten
- **GPT-3.5** – Gute Balance aus Qualität und Kosten
- **Claude** – Alternative mit großem Kontextfenster
- **Gemini** – Google's multimodales Modell

### 4. Einrichtung testen

Der **Doctor** zeigt dir sofort, ob alles funktioniert:

- Grün – Alles bereit
- Gelb – Konfiguration unvollständig
- Rot – Fehler bei der Verbindung

## Tipps für die Produktion

- Bewahre API-Keys niemals im Code auf
- Nutze Umgebungsvariablen für sensible Daten
- Rotiere API-Keys regelmäßig
- Überwache deine API-Nutzung

## Häufige Probleme

| Problem | Lösung |
|---------|--------|
| "Invalid API Key" | Key kopieren und neu einfügen |
| "Rate limit exceeded" | Weniger Anfragen oder Upgrade |
| "Model not available" | Anderes Modell wählen |

Bei weiteren Fragen schaue in die Dokumentation des jeweiligen Providers.`,
    videoUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    links: [
      { label: 'Zu den Einstellungen', href: '/settings?tab=agent-settings', variant: 'default' },
      { label: 'Dokumentation', href: '#', variant: 'outline' },
    ],
  },
  {
    id: 'file-management',
    title: 'Dateien verwalten',
    description: 'So organisierst du deine Dateien im Workspace effektiv',
    content: `# Dateien verwalten

Der Datei-Browser ist das Herzstück von Canvas Notebook. Hier erfährst du alle wichtigen Funktionen.

## Übersicht

Der Datei-Browser bietet dir folgende Möglichkeiten:

- **Dateien anzeigen** – Durchsuche deinen kompletten Workspace
- **Dateien öffnen** – Unterstützt viele Formate direkt im Browser
- **Dateien bearbeiten** – Änderungen direkt speichern
- **Neue Dateien erstellen** – Mit nützlichen Templates

## Wichtige Funktionen

### Kontext-Menü

Mit einem **Rechtsklick** auf eine Datei oder einen Ordner öffnest du das Kontext-Menü:

- Umbenennen
- Kopieren
- Verschieben
- Löschen
- Herunterladen

### Drag & Drop

Dateien lassen sich einfach per Drag & Drop verschieben:

1. Klicke und halte die Datei
2. Ziehe sie auf den Zielordner
3. Lasse los – fertig!

### Schnellzugriff

Markiere häufig genutzte Dateien als Favoriten für einen schnelleren Zugriff.

## Unterstützte Formate

Canvas Notebook unterstützt eine Vielzahl von Dateiformaten:

| Kategorie | Formate |
|-----------|---------|
| Text | .txt, .md, .json, .yaml |
| Code | .js, .ts, .py, .html, .css, .java, .cpp |
| Bilder | .png, .jpg, .svg, .gif |
| Dokumente | .pdf, .docx |
| Videos | .mp4, .webm |

## Tipps für effizientes Arbeiten

1. **Ordnerstruktur** – Nutze Ordner für Projekte
2. **Aussagekräftige Namen** – Vermeide "Datei1", "Test", etc.
3. **Regelmäßig aufräumen** – Lösche nicht mehr benötigte Dateien
4. **Versionierung** – Nutze Git für Code-Dateien

## Tastenkürzel

- Strg + N - Neue Datei
- Strg + S - Speichern
- F2 - Umbenennen
- Entf - Löschen
- Strg + C / V - Kopieren / Einfügen`,
    links: [
      { label: 'Zum Notebook', href: '/notebook', variant: 'default' },
      { label: 'Dokumentation', href: '#', variant: 'outline' },
    ],
  },
  {
    id: 'terminal-basics',
    title: 'Terminal nutzen',
    description: 'Die wichtigsten Terminal-Befehle und Quick Actions',
    content: `# Terminal nutzen

Das integrierte Terminal gibt dir direkten Zugriff auf den Workspace über die Kommandozeile.

## Quick Actions

Das Terminal bietet vorgefertigte Befehle für häufige Aufgaben:

- **Datei erstellen** – Schnell neue Dateien anlegen
- **Ordner erstellen** – Verzeichnisstruktur aufbauen
- **Git-Befehle** – Versionskontrolle direkt im Terminal
- **NPM/Node** – Pakete installieren und Scripts ausführen

## Terminal-Features

### Befehlsverlauf

Nutze die **Pfeil-nach-oben** Taste, um vorherige Befehle wiederzuverwenden.

### Autovervollständigung

Drücke **Tab**, um Befehle und Dateinamen automatisch zu vervollständigen.

### Copy & Paste

Standard-Tastenkombinationen funktionieren im Terminal:

- Strg + C - Kopieren (wenn Text markiert)
- Strg + V - Einfügen
- Strg + Shift + C - Kopieren (Linux-Stil)
- Strg + Shift + V - Einfügen (Linux-Stil)

### Mehrere Tabs

Öffne mehrere Terminal-Sessions parallel für verschiedene Aufgaben.

## Nützliche Befehle

### Navigation

    # Dateien und Ordner auflisten
    ls -la

    # In Ordner wechseln
    cd ordnername

    # Einen Ordner zurück
    cd ..

    # Zum Home-Verzeichnis
    cd ~

### Dateioperationen

    # Datei erstellen
    touch datei.txt

    # Ordner erstellen
    mkdir neuer-ordner

    # Datei kopieren
    cp quelle.txt ziel.txt

    # Datei verschieben
    mv quelle.txt ziel/

    # Datei löschen
    rm datei.txt

### Textbearbeitung

    # Datei anzeigen
    cat datei.txt

    # Datei mit Editor öffnen
    nano datei.txt

    # Erste 10 Zeilen anzeigen
    head datei.txt

    # Letzte 10 Zeilen anzeigen
    tail datei.txt

## Sicherheit

- Alle Befehle laufen im isolierten Workspace
- Kein Zugriff auf Systemdateien außerhalb des Workspace
- Befehle können das Host-System nicht beschädigen
- Sandbox-Prinzip schützt dein System

## Tipps

1. **Tippfehler vermeiden** – Nutze Tab-Vervollständigung
2. **Vorsicht mit rm** – Gelöschte Dateien sind unwiderruflich weg
3. **Hilfe anzeigen** – Fast alle Befehle haben eine --help Option
4. **Man-Pages** – man befehl zeigt die Dokumentation`,
    links: [
      { label: 'Zum Terminal', href: '/terminal', variant: 'default' },
      { label: 'Befehlsreferenz', href: '#', variant: 'outline' },
    ],
  },
];

const enTutorials: Tutorial[] = [
  {
    id: 'provider-setup',
    title: 'Set Up a Provider',
    description: 'Learn how to configure API providers such as OpenAI, Anthropic, or Google',
    content: `# Set Up a Provider

Canvas Notebook supports multiple AI providers for agent functionality. This guide walks you through the setup step by step.

## What are providers?

Providers are services that offer AI models. Canvas Notebook currently supports:

- **OpenAI** - GPT-4, GPT-3.5, and other models
- **Anthropic** - Claude models
- **Google** - Gemini models
- **More** - can be added when needed

## Step-by-step guide

### 1. Get an API key

First, you need an API key from your chosen provider:

1. Create an account with the provider you want to use
2. Open the API settings
3. Generate a new API key
4. Store the key securely

### 2. Add it to Canvas Notebook

Once you have the API key:

1. Open **Settings**
2. Select the **Agent Settings** tab
3. Choose your provider from the dropdown
4. Paste the API key into the corresponding field

### 3. Choose a model

After saving, you can choose the appropriate model:

- **GPT-4** - Best quality, higher cost
- **GPT-3.5** - Good balance between quality and cost
- **Claude** - Alternative with a large context window
- **Gemini** - Google's multimodal model

### 4. Test the setup

The **Doctor** immediately shows whether everything is working:

- Green - Everything ready
- Yellow - Configuration incomplete
- Red - Connection error

## Production tips

- Never store API keys in code
- Use environment variables for sensitive data
- Rotate API keys regularly
- Monitor your API usage

## Common issues

| Problem | Solution |
|---------|----------|
| "Invalid API Key" | Copy the key again and paste it in fresh |
| "Rate limit exceeded" | Reduce requests or upgrade your plan |
| "Model not available" | Choose a different model |

If you need more help, check the documentation for the specific provider.`,
    videoUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    links: [
      { label: 'Open Settings', href: '/settings?tab=agent-settings', variant: 'default' },
      { label: 'Documentation', href: '#', variant: 'outline' },
    ],
  },
  {
    id: 'file-management',
    title: 'Manage Files',
    description: 'How to organize your workspace files effectively',
    content: `# Manage Files

The file browser is the core of Canvas Notebook. Here are the most important features.

## Overview

The file browser lets you:

- **View files** - Browse your entire workspace
- **Open files** - Many formats work directly in the browser
- **Edit files** - Save changes immediately
- **Create new files** - With useful templates

## Important features

### Context menu

Use a **right click** on a file or folder to open the context menu:

- Rename
- Copy
- Move
- Delete
- Download

### Drag and drop

Files can be moved with drag and drop:

1. Click and hold the file
2. Drag it to the target folder
3. Release it

### Quick access

Mark frequently used files as favorites for faster access.

## Supported formats

Canvas Notebook supports many file formats:

| Category | Formats |
|----------|---------|
| Text | .txt, .md, .json, .yaml |
| Code | .js, .ts, .py, .html, .css, .java, .cpp |
| Images | .png, .jpg, .svg, .gif |
| Documents | .pdf, .docx |
| Videos | .mp4, .webm |

## Tips for efficient work

1. **Folder structure** - Use folders for projects
2. **Clear names** - Avoid names like "File1" or "Test"
3. **Clean up regularly** - Delete files you no longer need
4. **Version control** - Use Git for code files

## Keyboard shortcuts

- Ctrl + N - New file
- Ctrl + S - Save
- F2 - Rename
- Delete - Delete
- Ctrl + C / V - Copy / Paste`,
    links: [
      { label: 'Open Notebook', href: '/notebook', variant: 'default' },
      { label: 'Documentation', href: '#', variant: 'outline' },
    ],
  },
  {
    id: 'terminal-basics',
    title: 'Use the Terminal',
    description: 'The most important terminal commands and quick actions',
    content: `# Use the Terminal

The integrated terminal gives you direct command-line access to the workspace.

## Quick actions

The terminal offers ready-made commands for common tasks:

- **Create file** - Add new files quickly
- **Create folder** - Build directory structures
- **Git commands** - Work with version control directly in the terminal
- **NPM/Node** - Install packages and run scripts

## Terminal features

### Command history

Use the **Up Arrow** key to reuse previous commands.

### Autocomplete

Press **Tab** to autocomplete commands and file names.

### Copy & paste

Standard shortcuts work in the terminal:

- Ctrl + C - Copy (when text is selected)
- Ctrl + V - Paste
- Ctrl + Shift + C - Copy (Linux style)
- Ctrl + Shift + V - Paste (Linux style)

### Multiple tabs

Open multiple terminal sessions in parallel for different tasks.

## Useful commands

### Navigation

    # List files and folders
    ls -la

    # Change into a folder
    cd foldername

    # Go back one level
    cd ..

    # Go to the home directory
    cd ~

### File operations

    # Create a file
    touch file.txt

    # Create a folder
    mkdir new-folder

    # Copy a file
    cp source.txt target.txt

    # Move a file
    mv source.txt target/

    # Delete a file
    rm file.txt

### Text editing

    # Show a file
    cat file.txt

    # Open a file in an editor
    nano file.txt

    # Show the first 10 lines
    head file.txt

    # Show the last 10 lines
    tail file.txt

## Safety

- All commands run inside the isolated workspace
- No access to system files outside the workspace
- Commands cannot damage the host system
- The sandbox principle protects your environment

## Tips

1. **Avoid typos** - Use tab completion
2. **Be careful with rm** - Deleted files are gone for good
3. **Show help** - Most commands support a --help option
4. **Man pages** - man command shows the documentation`,
    links: [
      { label: 'Open Terminal', href: '/terminal', variant: 'default' },
      { label: 'Command Reference', href: '#', variant: 'outline' },
    ],
  },
];

export function getTutorials(locale: string): Tutorial[] {
  return locale === 'en' ? enTutorials : deTutorials;
}
