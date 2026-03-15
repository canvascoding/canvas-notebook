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
    content: `## Provider einrichten

Canvas Notebook unterstützt verschiedene AI-Provider für die Agent-Funktionalität. Hier erfährst du, wie du sie einrichtest.

### Was sind Provider?

Provider sind Dienste, die KI-Modelle zur Verfügung stellen. Canvas Notebook unterstützt:

- **OpenAI** - GPT-4, GPT-3.5 und andere Modelle
- **Anthropic** - Claude Modelle
- **Google** - Gemini Modelle
- **Andere** - Weitere Provider können hinzugefügt werden

### Schritt-für-Schritt Anleitung

1. **API-Key besorgen**
   - Erstelle einen Account beim gewünschten Provider
   - Generiere einen API-Key in den Einstellungen

2. **In Canvas Notebook eintragen**
   - Gehe zu Einstellungen → Agent Settings
   - Wähle deinen Provider
   - Trage den API-Key ein

3. **Modell auswählen**
   - Wähle das passende Modell für deine Anforderungen
   - Speichere die Einstellungen

4. **Testen**
   - Der Doctor zeigt dir, ob alles funktioniert
   - Bei Problemen werden Hinweise angezeigt

### Tipps

- Bewahre API-Keys sicher auf
- Verwende Umgebungsvariablen für Produktivsysteme
- Teste verschiedene Modelle, um das beste Ergebnis zu erzielen`,
    videoUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    links: [
      { label: 'Zu den Einstellungen', href: '/settings?tab=agent-settings', variant: 'default' },
      { label: 'Mehr erfahren', href: '#', variant: 'outline' },
    ],
  },
  {
    id: 'file-management',
    title: 'Dateien verwalten',
    description: 'So organisierst du deine Dateien im Workspace effektiv',
    content: `## Dateien verwalten

Der Datei-Browser ist das Herzstück von Canvas Notebook. Hier erfährst du, wie du damit arbeitest.

### Übersicht

- **Dateien anzeigen** - Durchsuche den Workspace
- **Dateien öffnen** - Unterstützt viele Formate
- **Dateien bearbeiten** - Direkt im Browser
- **Neue Dateien erstellen** - Mit Templates

### Wichtige Funktionen

1. **Kontext-Menü** - Rechtsklick auf Dateien für Optionen
2. **Drag & Drop** - Dateien verschieben
3. **Schnellzugriff** - Favoriten markieren
4. **Vorschau** - Dateien vor dem Öffnen ansehen

### Unterstützte Formate

- Text-Dateien (.txt, .md)
- Code-Dateien (.js, .ts, .py, etc.)
- Bilder (.png, .jpg, .svg)
- Dokumente (.pdf, .docx)
- Und viele mehr

### Tipps für effizientes Arbeiten

- Nutze Ordner für Projektstruktur
- Verwende aussagekräftige Dateinamen
- Regelmäßig aufräumen für bessere Übersicht`,
    links: [
      { label: 'Zum Notebook', href: '/notebook', variant: 'default' },
      { label: 'Dokumentation', href: '#', variant: 'outline' },
    ],
  },
  {
    id: 'terminal-basics',
    title: 'Terminal nutzen',
    description: 'Die wichtigsten Terminal-Befehle und Quick Actions',
    content: `## Terminal nutzen

Das integrierte Terminal gibt dir direkten Zugriff auf den Workspace.

### Quick Actions

Das Terminal bietet vorgefertigte Befehle für häufige Aufgaben:

- **Datei erstellen** - Schnell neue Dateien anlegen
- **Ordner erstellen** - Verzeichnisstruktur aufbauen
- **Git-Befehle** - Versionskontrolle direkt im Terminal
- **NPM/Node** - Pakete installieren und Scripts ausführen

### Terminal-Features

1. **Befehlsverlauf** - Vorherige Befehle wiederholen
2. **Autovervollständigung** - Tab für Vorschläge
3. **Copy & Paste** - Standard-Tastenkombinationen
4. **Mehrere Tabs** - Verschiedene Sessions parallel

### Nützliche Befehle

\`\`\`bash
# Dateien auflisten
ls -la

# In Ordner wechseln
cd ordnername

# Datei erstellen
touch datei.txt

# Ordner erstellen
mkdir neuer-ordner

# Datei bearbeiten
nano datei.txt
\`\`\`

### Sicherheit

- Alle Befehle laufen im isolierten Workspace
- Kein Zugriff auf Systemdateien außerhalb des Workspace
- Befehle können nicht das System beschädigen`,
    links: [
      { label: 'Zum Terminal', href: '/terminal', variant: 'default' },
      { label: 'Befehlsreferenz', href: '#', variant: 'outline' },
    ],
  },
];
