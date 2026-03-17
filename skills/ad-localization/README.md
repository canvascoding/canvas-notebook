---
name: ad_localization
title: Werbeanzeigen lokalisieren
description: |
  Lokalisiert Werbeanzeigen-Bilder für verschiedene Zielmärkte mit Gemini.
  Bewahrt Layout, Typografie und visuelles Design — übersetzt nur den Text.
  
  Verwenden wenn der User sagt:
  - "lokalisiere diese Anzeige"
  - "übersetze für Markt..."
  - "passe an für Land..."
  - "localize this ad"
  - "translate for market..."
  
  Output: workspace/nano-banana-ad-localizer/localizations/
  
  Voraussetzungen:
  - GEMINI_API_KEY in Settings → Integrations
  - CANVAS_SKILLS_TOKEN in /data/secrets/Canvas-Integrations.env (wird vom Server automatisch generiert)
  
  Der Agent darf die Canvas-Integrations.env Datei lesen, um CANVAS_SKILLS_TOKEN zu erhalten.
  
  Wichtig: Referenzbild muss unter nano-banana-ad-localizer/ liegen
version: "1.0.0"
type: api
tool:
  name: ad_localization
  description: "Lokalisiert Werbeanzeigen für Zielmärkte"
  parameters:
    reference_image_path:
      type: string
      required: true
      description: "Pfad zum Referenzbild (muss unter nano-banana-ad-localizer/ liegen)"
    target_markets:
      type: array
      items:
        type: string
      required: true
      description: "Liste der Zielmärkte (z.B. ['Germany', 'France', 'Japan'])"
    aspect_ratio:
      type: string
      enum: ["16:9", "1:1", "9:16", "4:3", "3:4"]
      default: "16:9"
      description: "Seitenverhältnis"
    model:
      type: string
      enum: ["gemini-3.1-flash-image-preview", "gemini-2.5-flash-image-preview"]
      default: "gemini-3.1-flash-image-preview"
      description: "Zu verwendendes Gemini-Modell"
    instructions:
      type: string
      required: false
      description: "Zusätzliche Lokalisierungsanweisungen"
---

# Ad Localization Skill (Nano Banana)

Lokalisiert Werbeanzeigen-Bilder für verschiedene Zielmärkte mit Gemini.
Bewahrt Layout, Typografie und visuelles Design — übersetzt nur den Text.
Output: `workspace/nano-banana-ad-localizer/localizations/`

## Verwendung

```bash
ad-localization [options]
```

## Optionen

| Flag | Kurz | Beschreibung | Standard |
|------|------|-------------|---------|
| `--ref` | `-r` | Referenzbild (MUSS unter `nano-banana-ad-localizer/` liegen) | erforderlich |
| `--market` | `-t` | Zielmarkt/Sprache (wiederholbar, bis zu 12) | erforderlich |
| `--aspect-ratio` | `-a` | `16:9`, `1:1`, `9:16`, `4:3`, `3:4` | `16:9` |
| `--model` | `-m` | Gemini-Modell | `gemini-3.1-flash-image-preview` |
| `--instructions` | `-i` | Zusätzliche Lokalisierungsanweisungen | — |

## Wichtig: Referenzbild-Pfad

Das Referenzbild **muss** unter dem `nano-banana-ad-localizer/`-Ordner im Workspace liegen.

Gültige Pfade (workspace-relativ):
- `nano-banana-ad-localizer/assets/kampagne.png`
- `nano-banana-ad-localizer/assets/anzeige.jpg`

## Modelle

- `gemini-3.1-flash-image-preview` (Standard)
- `gemini-2.5-flash-image-preview`

## Beispiele

Lokalisierung für zwei Märkte:
```bash
ad-localization \
  --ref "nano-banana-ad-localizer/assets/campaign.png" \
  --market "Germany" \
  --market "France"
```

Mehrere Märkte mit speziellen Anweisungen:
```bash
ad-localization \
  --ref "nano-banana-ad-localizer/assets/campaign.png" \
  --market "Japan" \
  --market "South Korea" \
  --instructions "Verwende formelle Anrede. Markenname bleibt in lateinischer Schrift."
```

## Antwort

```json
{
  "success": true,
  "data": {
    "referenceImagePath": "nano-banana-ad-localizer/assets/campaign.png",
    "outputDir": "nano-banana-ad-localizer/localizations",
    "successCount": 2,
    "failureCount": 0,
    "results": [
      {
        "market": "Germany",
        "path": "nano-banana-ad-localizer/localizations/nano-banana-germany-....png",
        "metadataPath": "nano-banana-ad-localizer/localizations/nano-banana-germany-....json",
        "mediaUrl": "/media/nano-banana-ad-localizer/localizations/..."
      }
    ]
  }
}
```
