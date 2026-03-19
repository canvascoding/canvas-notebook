---
name: video-generation
description: Generates videos using the local Canvas video-generation wrapper. Use when user asks for video creation, "create a video of...", "generate a video". Output goes to workspace/veo-studio/video-generation/. Requires GEMINI_API_KEY in settings. Note: Takes 3-10 minutes.
---

# Video Generation

Generates videos using the local Canvas video-generation wrapper.

## When to Use

Use this skill when the user requests:
- "Create a video"
- "Generate a video"
- "Make a video of..."
- "Create a video of..."

## Parameters

- **prompt** (optional): Text description of the video to generate. Required for `text_to_video` and `references_to_video`.
- **mode**: Generation mode (text_to_video, frames_to_video, references_to_video, extend_video). Default: text_to_video
- **aspect_ratio**: Aspect ratio (16:9, 9:16). Default: 16:9
- **resolution**: Resolution (720p, 1080p, 4k). Default: 720p
- **model**: Model to use (veo-3.1-fast-generate-preview, veo-3.1-generate-preview). Default: veo-3.1-fast-generate-preview
- **start_frame**: Workspace-relative path to start frame (for frames_to_video mode)
- **end_frame**: Workspace-relative path to end frame (for frames_to_video mode)
- **reference_image_paths**: Workspace-relative reference image paths (for references_to_video mode)
- **input_video**: Workspace-relative path to input video (for extend_video mode)
- **is_looping**: Reuse the start frame as the end frame in `frames_to_video` mode

## Output

Videos are saved to: `workspace/veo-studio/video-generation/`

## Agent Usage Rules

- Use the local `video-generation` command directly.
- Do not call internal Canvas API routes for this skill.
- Do not read env files or manually load `GEMINI_API_KEY`; the wrapper resolves the configured key centrally.

## Examples

Text to video:
```
video-generation --prompt "A gentle wave breaking on a sandy beach" --aspect-ratio 16:9
```

Frames to video:
```
video-generation \
  --mode frames_to_video \
  --start-frame "veo-studio/assets/start.png" \
  --end-frame "veo-studio/assets/end.png" \
  --prompt "Smooth transition between the two frames"
```

With reference images:
```
video-generation \
  --mode references_to_video \
  --ref "veo-studio/assets/char1.png" \
  --ref "veo-studio/assets/bg.png" \
  --prompt "Character walking through the scene"
```

## Requirements

- GEMINI_API_KEY must be configured in settings
- Video generation typically takes 3-10 minutes
