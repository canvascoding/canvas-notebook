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

## Output-Verzeichnisse (workspace-relativ)

- **Image Generation:** `image-generation/generations/`
- **Video Generation:** `veo-studio/video-generation/`
- **Ad Localization:** `nano-banana-ad-localizer/localizations/`

## Voraussetzungen

- GEMINI_API_KEY muss in Canvas Notebook unter `/settings` konfiguriert sein
- Server muss laufen (CLI kommuniziert mit `localhost:3000`)

## Antwortformat

Alle Skills geben JSON zurück:

```json
{ "success": true, "data": { ... } }
```

oder bei Fehler:

```json
{ "success": false, "error": "Fehlermeldung" }
```

Die `path`-Felder in der Antwort sind workspace-relativ und können mit dem `read`-Tool geöffnet werden.

## Skill-Dokumentation

- `/data/skills/image-generation/README.md`
- `/data/skills/video-generation/README.md`
- `/data/skills/ad-localization/README.md`
