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
