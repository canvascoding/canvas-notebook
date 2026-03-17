---
name: image_generation
title: Bilder mit Gemini generieren
description: |
  Generiert Bilder mit Gemini Image Generation.
  
  Verwenden wenn der User sagt:
  - "erstelle ein Bild"
  - "generiere ein Foto"
  - "mache ein Bild von..."
  - "create an image"
  - "generate a picture"
  
  Output: workspace/image-generation/generations/
  
  Voraussetzungen:
  - GEMINI_API_KEY in Settings → Integrations
  - CANVAS_SKILLS_TOKEN in /data/secrets/Canvas-Integrations.env (wird vom Server automatisch generiert)
  
  Der Agent darf die Canvas-Integrations.env Datei lesen, um CANVAS_SKILLS_TOKEN zu erhalten.
version: "1.0.0"
type: api
tool:
  name: image_generation
  description: "Generiert Bilder mit Gemini Image Generation"
  parameters:
    prompt:
      type: string
      required: true
      description: "Text-Prompt für die Bildgenerierung"
    count:
      type: integer
      required: true
      minimum: 1
      maximum: 4
      description: "Anzahl der zu generierenden Bilder (1-4)"
    aspect_ratio:
      type: string
      enum: ["16:9", "1:1", "9:16", "4:3", "3:4"]
      default: "1:1"
      description: "Seitenverhältnis des Bildes"
    model:
      type: string
      enum: ["gemini-3.1-flash-image-preview", "gemini-2.5-flash-image-preview"]
      default: "gemini-3.1-flash-image-preview"
      description: "Zu verwendendes Gemini-Modell"
---

# Image Generation Skill

Generiert Bilder mit Gemini Image Generation.
Output: `workspace/image-generation/generations/`

## Verwendung

```bash
image-generation [options]
```

## Optionen

| Flag | Kurz | Beschreibung | Standard |
|------|------|-------------|---------|
| `--prompt` | `-p` | Text-Prompt für die Generierung | (erforderlich, außer bei --ref) |
| `--model` | `-m` | Modell | `gemini-3.1-flash-image-preview` |
| `--aspect-ratio` | `-a` | Seitenverhältnis: `16:9`, `1:1`, `9:16`, `4:3`, `3:4` | `1:1` |
| `--count` | `-n` | Anzahl der Bilder (1–4) | `1` |
| `--ref` | `-r` | Referenzbild (workspace-relativ, wiederholbar, max. 10) | — |

## Modelle

- `gemini-3.1-flash-image-preview` (Standard)
- `gemini-2.5-flash-image-preview`

## Beispiele

Einzelnes Bild generieren:
```bash
image-generation --prompt "Eine futuristische Stadt bei Sonnenuntergang" --aspect-ratio 16:9
```

4 Variationen generieren:
```bash
image-generation --prompt "Produktfoto auf weißem Hintergrund" --count 4
```

Mit Referenzbild:
```bash
image-generation \
  --prompt "Gleicher Stil, andere Farbgebung" \
  --ref "image-generation/assets/original.png" \
  --count 2
```

## Antwort

```json
{
  "success": true,
  "data": {
    "model": "gemini-3.1-flash-image-preview",
    "aspectRatio": "1:1",
    "imageCount": 1,
    "outputDir": "image-generation/generations",
    "successCount": 1,
    "failureCount": 0,
    "results": [
      {
        "index": 0,
        "path": "image-generation/generations/img-gen-...-0-....png",
        "metadataPath": "image-generation/generations/img-gen-...-0-....json",
        "mediaUrl": "/media/image-generation/generations/..."
      }
    ]
  }
}
```

`path` ist workspace-relativ und kann direkt mit dem `read`-Tool geöffnet werden.
