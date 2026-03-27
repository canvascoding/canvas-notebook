---
name: ad-localization
description: Localizes ad images for target markets using the local Canvas ad-localization wrapper. Preserves layout, typography, and visual design - translates only the text. Use when user asks for "localize this ad", "translate for market...", "adapt for country...". Output goes to workspace/nano-banana-ad-localizer/localizations/. Requires GEMINI_API_KEY in settings. Reference image must be under nano-banana-ad-localizer/.
---

# Ad Localization

Localizes ad images for target markets using the local Canvas ad-localization wrapper. Preserves layout, typography, and visual design - translates only the text.

## When to Use

Use this skill when the user requests:
- "Localize this ad"
- "Translate for market..."
- "Adapt for country..."
- "Localize this advertisement"

## Parameters

- **reference_image_path** (required): Path to reference image (must be under nano-banana-ad-localizer/)
- **target_markets** (required): List of target markets (e.g., ["Germany", "France", "Japan"])
- **aspect_ratio**: Aspect ratio (16:9, 1:1, 9:16, 4:3, 3:4). Default: 16:9
- **model**: Model to use (gemini-3.1-flash-image-preview, gemini-2.5-flash-image). Default: gemini-3.1-flash-image-preview
- **instructions**: Additional localization instructions

## Output

Localized ads are saved to: `workspace/nano-banana-ad-localizer/localizations/`

## Agent Usage Rules

- Use the local `ad-localization` command directly.
- Do not call internal Canvas API routes for this skill.
- Do not read env files or manually load `GEMINI_API_KEY`; the wrapper resolves the configured key centrally.
- If this skill or a new related skill needs secrets, they must be stored centrally in `/data/secrets/Canvas-Integrations.env`.

## Examples

Localize for two markets:
```
ad-localization \
  --ref "nano-banana-ad-localizer/assets/campaign.png" \
  --market "Germany" \
  --market "France"
```

Multiple markets with special instructions:
```
ad-localization \
  --ref "nano-banana-ad-localizer/assets/campaign.png" \
  --market "Japan" \
  --market "South Korea" \
  --instructions "Use formal address. Brand name stays in Latin script."
```

## Requirements

- GEMINI_API_KEY must be configured in settings and is stored centrally in `/data/secrets/Canvas-Integrations.env`
- Reference image must be under nano-banana-ad-localizer/ directory
