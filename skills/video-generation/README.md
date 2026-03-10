# Video Generation Skill (VEO)

Generiert Videos mit Google VEO. Kann mehrere Minuten dauern.
Output: `workspace/veo-studio/video-generation/`

## Verwendung

```bash
/data/skills/skill video-generation [options]
```

## Optionen

| Flag | Kurz | Beschreibung | Standard |
|------|------|-------------|---------|
| `--prompt` | `-p` | Beschreibung des Videos | erforderlich (außer frames_to_video) |
| `--model` | `-m` | VEO-Modell | `veo-3.1-fast-generate-preview` |
| `--mode` | | Generierungsmodus (siehe unten) | `text_to_video` |
| `--aspect-ratio` | `-a` | `16:9` oder `9:16` | `16:9` |
| `--resolution` | | `720p`, `1080p`, `4k` | `720p` |
| `--start-frame` | | Startbild (workspace-relativ) | — |
| `--end-frame` | | Endbild (workspace-relativ) | — |
| `--input-video` | | Eingangsvideo für extend-Modus (workspace-relativ) | — |
| `--ref` | `-r` | Referenzbild (workspace-relativ, bis zu 3) | — |

## Generierungsmodi

| Modus | Beschreibung | Pflichtparameter |
|-------|-------------|-----------------|
| `text_to_video` | Aus Text-Prompt generieren (Standard) | `--prompt` |
| `frames_to_video` | Zwischen Start- und Endbild animieren | `--start-frame` |
| `references_to_video` | Aus Referenzbildern + Prompt | `--ref` + `--prompt` |
| `extend_video` | Bestehendes Video verlängern | `--input-video` |

## Beispiele

Text zu Video:
```bash
/data/skills/skill video-generation \
  --prompt "Eine sanfte Welle bricht an einem Sandstrand" \
  --aspect-ratio 16:9
```

Frames zu Video:
```bash
/data/skills/skill video-generation \
  --mode frames_to_video \
  --start-frame "veo-studio/assets/start.png" \
  --end-frame "veo-studio/assets/end.png" \
  --prompt "Sanfter Übergang zwischen den beiden Frames"
```

Mit Referenzbildern:
```bash
/data/skills/skill video-generation \
  --mode references_to_video \
  --ref "veo-studio/assets/char1.png" \
  --ref "veo-studio/assets/bg.png" \
  --prompt "Charakter läuft durch die Szene"
```

## Antwort

```json
{
  "success": true,
  "data": {
    "path": "veo-studio/video-generation/prompt-slug-veo-....mp4",
    "metadataPath": "veo-studio/video-generation/prompt-slug-veo-....json",
    "mediaUrl": "/media/veo-studio/video-generation/..."
  }
}
```

**Hinweis:** Video-Generierung dauert typischerweise 3–10 Minuten. Der CLI-Call blockiert bis zur Fertigstellung.
