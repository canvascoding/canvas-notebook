# Canvas Skills

Skills sind CLI-Werkzeuge, die der Agent über das `bash`-Tool aufrufen kann, um die eingebauten Micro-SaaS-Integrationen von Canvas Notebook zu nutzen.

## Aufruf

Die Skills sind direkt als Befehle verfügbar (in `/usr/local/bin/` installiert):

```bash
image-generation --prompt "..."
video-generation --prompt "..."
ad-localization --ref "..." --market "..."
```

Alternativ über den vollständigen Pfad:

```bash
/data/skills/skill <skill-name> [options]
```

## Verfügbare Skills

| Befehl | Beschreibung |
|--------|-------------|
| `image-generation` | Bilder mit Gemini generieren |
| `video-generation` | Videos mit Google VEO generieren |
| `ad-localization` | Werbeanzeigen für Zielmärkte lokalisieren |
| `qmd` | Markdown-Notizen und Dokumente im Workspace durchsuchen |

## Output-Verzeichnisse (workspace-relativ)

- **Image Generation:** `image-generation/generations/`
- **Video Generation:** `veo-studio/video-generation/`
- **Ad Localization:** `nano-banana-ad-localizer/localizations/`

## Voraussetzungen

**Erforderliche Konfiguration:**

1. **GEMINI_API_KEY** - Muss in Canvas Notebook unter Settings → Integrations konfiguriert sein
2. **CANVAS_SKILLS_TOKEN** - Wird vom Server automatisch in `/data/secrets/Canvas-Integrations.env` generiert

**Wichtig:** Der Agent darf die Datei `/data/secrets/Canvas-Integrations.env` lesen, um CANVAS_SKILLS_TOKEN zu erhalten. Dieser Token wird für die interne API-Authentifizierung benötigt.

- Server muss laufen (CLI kommuniziert mit `localhost:3000`)

## Antwortformat

Die meisten Skills geben JSON zurück:

```json
{ "success": true, "data": { ... } }
```

oder bei Fehler:

```json
{ "success": false, "error": "Fehlermeldung" }
```

Die `path`-Felder in der Antwort sind workspace-relativ und können mit dem `read`-Tool geöffnet werden.

**Ausnahme:** `qmd` ist ein lokales CLI-Tool und gibt direkte Text-/JSON-Ausgabe zurück (kein API-Call nötig).

## Skill-Dokumentation

- `/data/skills/image-generation/README.md`
- `/data/skills/video-generation/README.md`
- `/data/skills/ad-localization/README.md`
- `/data/skills/qmd/README.md`
