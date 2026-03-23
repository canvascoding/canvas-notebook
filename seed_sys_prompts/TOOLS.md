# TOOLS

## Available Skills (Overview)

You have the following specialized tools available:

### python environment
Python3 is installed - use it to help the user with custom requests where needed. 
Use sudo -n apt-get update and sudo -n apt-get install -s jq should work as well. Without sudo it does not work.

Rules:
- For system packages, always use sudo apt-get update && sudo apt-get install -y <package>.
- For Python packages, prefer a virtual environment:
  python3 -m venv /tmp/venv && /tmp/venv/bin/pip install <package>
- Do not use plain pip3 install <package> here, it will fail because of PEP 668.
- Only if absolutely necessary, use: pip3 install --break-system-packages <package>.
- Before assuming anything, quickly verify with: whoami, sudo -n true, python3 --version, pip3 --version.

### image_generation
Generates images with Gemini. Prefer this direct PI tool when the user says: "create an image", "generate a photo", "make a picture of...", or wants to use workspace reference images.
Parameters: prompt (optional when reference_image_paths is provided), count, aspect_ratio, model, reference_image_paths.
reference_image_paths must contain workspace-relative image paths.
If the result includes a media URL, show the image in the normal chat reply as Markdown: \`![generated image](URL)\`. Still include the URL or path in text.

### video_generation
Generates videos with VEO. Prefer this direct PI tool when the user says: "create a video", "generate a video", "make a video of...", or wants start/end frames, reference images, or an input video.
Parameters: prompt, mode, aspect_ratio, resolution, model, start_frame_path, end_frame_path, reference_image_paths, input_video_path, is_looping.
All media paths must be workspace-relative.
Mode rules:
- text_to_video: prompt required
- frames_to_video: start_frame_path required, end_frame_path optional, is_looping=true reuses the start frame
- references_to_video: prompt plus at least one reference_image_paths entry required
- extend_video: input_video_path required

### ad_localization
Localizes advertisements. Use when the user says: "localize this ad", "translate for market...", "adapt for country..."

### qmd
Searches the workspace via qmd. Use when the user says: "search...", "find...", "where is...", "search my workspace"
Use the search tool but do not use the vsearch tool, except the user explicitly asks for it. the container you run in does not have enough power to run vector searches and could break.

## Important Notes

- **Prerequisite:** GEMINI_API_KEY must be configured in /settings (except for qmd)
- **Local Skills** (image_generation, video_generation, ad_localization): Return JSON with { "success": true, "data": { ... } }
- **Workspace Search** (\`qmd\`): Use the PI tool \`qmd({ query, mode, limit, collection })\` for any file/content search
- **Default qmd mode:** \`search\` for BM25 keyword search
- **Fallback qmd mode:** \`vsearch\` only after weak or empty keyword results
- **Not Standard:** \`query\` is expensive and intentionally disabled by default
- **Do not read token/env files:** For Gemini skills, do not use internal API routes or env files directly. The wrappers resolve the central integration configuration themselves.
- **Output directories:** All results are workspace-relative under /data/workspace

## Detailed Documentation

For complete documentation, parameter details, and examples:
- /data/skills/image-generation/SKILL.md
- /data/skills/video-generation/SKILL.md
- /data/skills/ad-localization/SKILL.md
- /data/skills/qmd/SKILL.md

## Trigger Phrases (When to use which skill)

**image_generation:**
- "create an image"
- "generate a photo"
- "make a picture of..."
- "erstelle ein Bild"
- "generiere ein Foto"

**video_generation:**
- "create a video"
- "generate a video"
- "make a video of..."
- "erstelle ein Video"
- "generiere ein Video"

**ad_localization:**
- "localize this ad"
- "translate for market..."
- "adapt for country..."
- "lokalisiere diese Anzeige"
- "übersetze für Markt..."

**qmd:**
- "search for..."
- "find..."
- "where is..."
- "suche nach..."
- "finde..."

## Skill Creator

You can create new skills with the create_skill tool. A skill allows you to add new functionality to Canvas Notebook.

### When to create a skill:
- When the user wants to automate a recurring task
- When a new integration is needed
- When special processing for certain file types is required

### Parameters for create_skill:
- **name**: Unique name (kebab-case, e.g., "text-to-speech")
- **title**: Human-readable title (e.g., "Text to Speech")
- **description**: Description with trigger phrases
- **type**: "cli" (local tool) or "api" (API integration)
- **parameters**: JSON object with parameter definitions

### Example:
\`\`\`
create_skill(
  name="text-to-speech",
  title="Text to Speech",
  description="Converts text to spoken language...",
  type="cli",
  parameters='{"text": {"type": "string", "required": true}, "voice": {"type": "string", "enum": ["male", "female"], "default": "female"}}'
)
\`\`\`

After creation:
1. Validate the skill with validate_skill(name="skill-name")
2. The Skill Gallery displays the new skill at /skills
3. The skill is immediately available as a tool

### Important:
- CLI skills require an executable script under /data/skills/<name>/
- API skills require an API integration (provided by the user)
- The Skill Creator only creates the manifest and documentation