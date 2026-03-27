# Canvas Skills

Skills sind lokale CLI-Werkzeuge, die der Agent über das `bash`-Tool aufrufen kann.

## Aufruf

```bash
<command> [options]
```

Die Commands werden aus den Skill-Manifests erzeugt und zur Laufzeit unter `/data/skills/bin/` bereitgestellt. In Docker werden sie zusätzlich nach Möglichkeit in `/usr/local/bin/` gespiegelt.

```bash
image-generation --prompt "..."
video-generation --prompt "..."
ad-localization --ref "..." --market "..."
brave-search "query"
transcribe /data/workspace/audio/meeting.mp3
```

## Verfügbare Skills

### Canvas-interne Skills

| Befehl | Beschreibung |
|--------|-------------|
| `image-generation` | Bilder mit Gemini generieren |
| `video-generation` | Videos mit Google VEO generieren |
| `ad-localization` | Werbeanzeigen für Zielmärkte lokalisieren |
| `qmd` | Markdown-Notizen und Dokumente im Workspace durchsuchen |

### Web & Suche

| Befehl | Beschreibung | API-Key |
|--------|-------------|---------|
| `brave-search` | Websuche via Brave API | `BRAVE_API_KEY` |
| `brave-content` | Seiteninhalt als Markdown extrahieren | `BRAVE_API_KEY` |
| `youtube-transcript` | YouTube-Transkript abrufen | – |

### Audio

| Befehl | Beschreibung | API-Key |
|--------|-------------|---------|
| `transcribe` | Sprache-zu-Text via Groq Whisper | `GROQ_API_KEY` |

### Browser-Automatisierung

| Befehl | Beschreibung |
|--------|-------------|
| `browser-start` | Chromium mit Remote-Debugging auf :9222 starten |
| `browser-nav` | Browser zu URL navigieren |
| `browser-screenshot` | Screenshot aufnehmen |
| `browser-content` | Seiteninhalt via Browser extrahieren |
| `browser-eval` | JavaScript im Browser ausführen |

### Google Workspace (manuelle Installation erforderlich)

| Befehl | Beschreibung |
|--------|-------------|
| `gccli` | Google Calendar CLI |
| `gmcli` | Gmail CLI |
| `gdcli` | Google Drive CLI |

## API-Keys konfigurieren

API-Keys für externe Skills werden zentral in Canvas Notebook unter **Settings → Integrations** gesetzt und dort in `/data/secrets/Canvas-Integrations.env` gespeichert. Neue und bestehende Skills mit Secrets müssen ihre Variablen aus genau diesem Pfad beziehen.

**Wichtig:** Der Agent soll `/data/secrets/Canvas-Integrations.env` weder direkt lesen noch interne API-Routen aufrufen. Die Skill-Runtime injiziert die zentral verwalteten Variablen automatisch in den jeweiligen Skill-Prozess.

## Output-Verzeichnisse (workspace-relativ)

- **Image Generation:** `image-generation/generations/`
- **Video Generation:** `veo-studio/video-generation/`
- **Ad Localization:** `nano-banana-ad-localizer/localizations/`

## Antwortformat

Canvas-interne Skills geben JSON zurück:

```json
{ "success": true, "data": { ... } }
```

Pi-Skills (brave-search, transcribe, youtube-transcript, browser-tools) geben direkte Text-Ausgabe zurück.

## Skill-Dokumentation

Jeder Skill hat eine `SKILL.md` in seinem Ordner:

- `/data/skills/image-generation/SKILL.md`
- `/data/skills/brave-search/SKILL.md`
- `/data/skills/transcribe/SKILL.md`
- `/data/skills/youtube-transcript/SKILL.md`
- `/data/skills/browser-tools/SKILL.md`
- `/data/skills/gccli/SKILL.md`
- `/data/skills/gmcli/SKILL.md`
- `/data/skills/gdcli/SKILL.md`
