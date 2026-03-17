---
name: image-generation
description: Generates images using Gemini Image Generation. Use when user asks for image creation, picture generation, "create an image of...", "generate a photo". Output goes to workspace/image-generation/generations/. Requires GEMINI_API_KEY in settings.
---

# Image Generation

Generates images using Gemini Image Generation.

## When to Use

Use this skill when the user requests:
- "Create an image"
- "Generate a photo"
- "Make a picture of..."
- "Create an image of..."
- "Generate a picture"

## Parameters

- **prompt** (required): Text description of the image to generate
- **aspect_ratio**: Aspect ratio of the image (16:9, 1:1, 9:16, 4:3, 3:4). Default: 1:1
- **count**: Number of images to generate (1-4). Default: 1
- **model**: Model to use (gemini-3.1-flash-image-preview, gemini-2.5-flash-image). Default: gemini-3.1-flash-image-preview

## Output

Images are saved to: `workspace/image-generation/generations/`

## Examples

Generate a single image:
```
image-generation --prompt "A futuristic city at sunset" --aspect-ratio 16:9
```

Generate 4 variations:
```
image-generation --prompt "Product photo on white background" --count 4
```

With reference image:
```
image-generation \
  --prompt "Same style, different color scheme" \
  --ref "image-generation/assets/original.png" \
  --count 2
```

## Requirements

- GEMINI_API_KEY must be configured in settings
