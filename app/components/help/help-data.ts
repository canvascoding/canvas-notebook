export interface Tutorial {
  id: string;
  title: string;
  description: string;
  thumbnail?: string;
  videoUrl?: string;
  content: string;
  links: { label: string; href: string; variant?: 'default' | 'outline' }[];
}

export const tutorials: Tutorial[] = [
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
