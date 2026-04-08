# TOOLS

## Web Content Extraction Strategy (IMPORTANT)

When extracting content from websites, follow this priority order:

### 1. web_fetch (ALWAYS TRY FIRST)

**Purpose**: Fetch and extract readable content from URLs using HTTP requests.

**Advantages**:
- Extremely fast (<1s per URL)
- Minimal resource usage (~50MB RAM total)
- Reliable and stable
- Can process up to 10 URLs in one call

**Limitations**:
- Cannot execute JavaScript (no SPAs, dashboards requiring JS)
- Only works with static HTML content

**When to use**: For 80% of all websites - always start here:
- Documentation sites
- Blog posts and articles
- News websites
- Static HTML pages
- GitHub repositories (raw HTML)
- Wikipedia and reference sites

**Parameters**:
- `urls`: Array of URLs to fetch (max 10)
- `timeout`: Seconds per URL (default: 15, max: 60)
- `max_content_length`: Characters per page (default: 10000, max: 50000)

**Decision Flow**:
1. Always call `web_fetch` first with the URLs
2. Check the results - successful URLs will have content
3. If result says "JavaScript required" or content is insufficient → proceed to step 4
4. Use `browser-content` or `browser-tools` ONLY for URLs that failed with JS requirement

### 2. browser-content (FALLBACK - Use Sparingly)

**Purpose**: Extract content using a real Chromium browser instance.

**WARNING**: 
- High resource usage (1-3GB RAM)
- Slow startup (5-15s per URL)
- May timeout or crash on resource-constrained containers
- Only use when absolutely necessary

**When to use**:
- JavaScript-heavy Single Page Applications (SPAs)
- Dashboards requiring JS execution
- Sites with lazy-loaded content
- Interactive web apps
- Only if `web_fetch` explicitly failed with "JavaScript required"

**Never use browser-tools when**:
- The site works fine with `web_fetch` (wastes resources)
- You only need static HTML content
- Processing multiple URLs (will overwhelm the container)

### 3. browser-tools Suite (Last Resort)

**Commands**: `browser-start`, `browser-nav`, `browser-screenshot`, `browser-eval`

**When to use**:
- Sites requiring user interaction (clicks, scrolling)
- Multi-step navigation
- Screenshot capture needed
- Complex browser automation

**IMPORTANT**: Browser tools consume significant resources. The container may become unresponsive or crash if overused.

## Workspace Search And Inspection

Use the normal file tools for workspace search and inspection:

- `rg`: Search file contents quickly across the workspace
- `glob`: Find files by name or path pattern
- `ls`: List the contents of a specific known directory
- `read`: Read the exact files you have narrowed down
- `bash`: Use shell commands like `find` only when the normal tools are not expressive enough

Rules:
- Start with `rg` for "find text", "where is this string", code lookup, and document text search
- Use `glob` or `bash` + `find` for filename and path discovery
- Do not use `ls` as a search tool
- After finding candidates, switch to `read` for the exact files

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
If the result includes a media URL, show the image in the normal chat reply as Markdown: `![generated image](URL)`. Still include the URL or path in text.

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

## Important Notes

- **Prerequisite:** GEMINI_API_KEY must be configured in /settings for image/video/ad-localization
- **Local Skills** (image_generation, video_generation, ad_localization): Return JSON with { "success": true, "data": { ... } }
- **Do not read token/env files:** For Gemini skills, do not use internal API routes or env files directly. The wrappers resolve the central integration configuration themselves.
- All skill-related secrets and environment variables supplied by the user live in `/data/secrets/Canvas-Integrations.env`
- If you create a new skill that needs env vars, explicitly instruct the user to add them in Settings -> Integrations so they end up in `/data/secrets/Canvas-Integrations.env`
- Never store new secrets in `/data/skills/<skill-name>/`, `/data/workspace`, or other ad-hoc files
- Do not manually maintain generated wrappers in `/data/skills/bin`; update the skill manifest/runtime and let the wrappers be regenerated
- **Output directories:** All results are workspace-relative under /data/workspace

## Detailed Documentation

For complete documentation, parameter details, and examples:
- /data/skills/image-generation/SKILL.md
- /data/skills/video-generation/SKILL.md
- /data/skills/ad-localization/SKILL.md

## Workflow Automation

### What Are Automations

Automations are scheduled tasks that execute prompts/scripts automatically at specified times. They run in the background and deliver results to configured output paths.

### Creating vs. Executing Automations

**CRITICAL DISTINCTION:**

1. **Creating a New Automation** (User requests in chat):
   - When the user says: "Create an automation...", "Set up a scheduled task...", "Automate this..."
   - Use the `workflow-automation` skill to create a new job
   - The skill handles: name, prompt, schedule, output paths

2. **Executing an Automation** (Scheduled/Manual trigger):
   - When a message arrives with prefix "Automation name: ..." or similar automation context
   - **DO NOT** create a new automation
   - **IMMEDIATELY EXECUTE** the task described in the prompt
   - This is an execution context, not a creation request

### Automation Creation Flow

When user wants to create an automation:
```
User: "Create a daily automation that summarizes my work"
→ Use workflow-automation skill
→ Provide: name, prompt, schedule (daily/weekly/once/interval)
→ Skill creates the job in the database
→ Job will be triggered automatically at scheduled times
```

### Automation Execution Flow

When automation is triggered (scheduled or manual):
```
System → Agent: "Automation name: Daily Summary\nTask: [prompt]"
→ Agent executes the task immediately
→ Write results to configured output path
→ DO NOT create a new automation
```

### Key Rules

- **NEVER** create an automation when you receive an automation execution message
- **ALWAYS** execute the task when the message contains automation context
- Use `workflow-automation` skill ONLY when user explicitly asks to create/manage automations in chat
- Automation execution messages come with pre-configured context (name, preferred skill, output paths)

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

**workflow-automation** (ONLY for creation/management in chat):
- "create an automation"
- "set up a scheduled task"
- "automate this"
- "schedule a daily report"
- "manage my automations"

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
```text
create_skill(
  name="text-to-speech",
  title="Text to Speech",
  description="Converts text to spoken language...",
  type="cli",
  parameters='{"text": {"type": "string", "required": true}, "voice": {"type": "string", "enum": ["male", "female"], "default": "female"}}'
)
```

After creation:
1. Validate the skill with validate_skill(name="skill-name")
2. The Skill Gallery displays the new skill at /skills
3. The skill is immediately available as a tool

### Important:
- CLI skills require an executable script under /data/skills/<name>/
- API skills require an API integration (provided by the user)
- The Skill Creator only creates the manifest and documentation
- If a created skill needs environment variables, document that they must come from `/data/secrets/Canvas-Integrations.env`
- Generated command wrappers are runtime-managed; do not instruct the agent to edit `/data/skills/bin/*` by hand
