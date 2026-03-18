import { promises as fs } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'node:path';
import { loadAppEnv } from '../server/load-app-env';

// Database imports are optional - they may not be available in Docker container
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let aiMessages: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let aiSessions: any;

// Inline runtime-data-paths functions (container-safe, no external deps)
const CONTAINER_DATA_ROOT = '/data';

function directoryExists(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveCanvasDataRoot(cwd = process.cwd()): string {
  const configured = process.env.CANVAS_DATA_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  if (directoryExists(CONTAINER_DATA_ROOT)) {
    return CONTAINER_DATA_ROOT;
  }
  return path.resolve(cwd, 'data');
}

function resolveAgentStorageDir(cwd = process.cwd()): string {
  return path.join(resolveCanvasDataRoot(cwd), 'canvas-agent');
}

function resolveSecretsDir(cwd = process.cwd()): string {
  return path.join(resolveCanvasDataRoot(cwd), 'secrets');
}

function resolveDefaultIntegrationsEnvPath(cwd = process.cwd()): string {
  return path.join(resolveSecretsDir(cwd), 'Canvas-Integrations.env');
}

function resolveDefaultAgentsEnvPath(cwd = process.cwd()): string {
  return path.join(resolveSecretsDir(cwd), 'Canvas-Agents.env');
}

loadAppEnv(process.cwd());

const AGENT_STORAGE_DIR = resolveAgentStorageDir();
const SECRETS_DIR = resolveSecretsDir();
const DEFAULT_INTEGRATIONS_ENV_PATH = resolveDefaultIntegrationsEnvPath();
const DEFAULT_AGENTS_ENV_PATH = resolveDefaultAgentsEnvPath();
const LEGACY_WIPE_MARKER_PATH = path.join(AGENT_STORAGE_DIR, '.legacy-session-wipe-done');
const RUNTIME_CONFIG_PATH = path.join(AGENT_STORAGE_DIR, 'agent-runtime-config.json');

// Legacy paths for migration
const LEGACY_AGENT_STORAGE_DIR = '/home/node/canvas-agent';
const LEGACY_INTEGRATIONS_ENV_PATH = '/home/node/Canvas-Integrations.env';
const LEGACY_AGENTS_ENV_PATH = '/home/node/Canvas-Agents.env';

const MANAGED_FILE_TEMPLATES: Record<string, string> = {
  'AGENTS.md': `# AGENTS

You are an AI assistant operating within the Canvas Notebook environment.

## Workspace Location

All file operations (ls, read, write, glob, grep, bash) work within the workspace directory: /data/workspace

- When using ls without a path, it lists the contents of /data/workspace
- All relative paths are resolved from /data/workspace
- Files outside this directory are not accessible
- Use relative paths (e.g., "docs/file.md" not "/data/workspace/docs/file.md")

## Default Output Format

When no specific format is requested, create a Markdown document (.md) in the workspace. It's readable, performant, and native to Canvas Notebook.

## File Types

You can access ALL file types in the workspace:
- Images: .png, .jpg, .jpeg, .gif, .webp, .svg
- Documents: .docx, .md, .txt, .pdf
- Data: .json, .csv, .xml
- Code files: .ts, .js, .py, etc.

## Image Analysis

To analyze images, use the read tool with the image path. The image will be loaded and displayed to you for analysis.

Example:
- User: "What's in the image assets/chart.png?"
- You: Use read tool with path="assets/chart.png" to load and analyze the image

Note: Image analysis requires a vision-capable model.

## Environment

You are running in a Linux Docker container.
`,
  'TOOLS.md': `# TOOLS

## Available Skills (Overview)

You have the following specialized tools available:

### image_generation
Generates images with Gemini. Use when the user says: "create an image", "generate a photo", "make a picture of..."

### video_generation
Generates videos with VEO. Use when the user says: "create a video", "generate a video", "make a video of..."

### ad_localization
Localizes advertisements. Use when the user says: "localize this ad", "translate for market...", "adapt for country..."

### qmd
Searches the workspace via qmd. Use when the user says: "search...", "find...", "where is...", "search my workspace"

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
`,

  'SOUL.md': `# SOUL

- you are friendly, courteous, and helpful
- you also use reverse prompting to achieve the best possible results for the user
`,
  'MEMORY.md': `# MEMORY

- Diese datei wird von dir fortlaufend aktualisiert wenn du dir etwas merken sollst. es hilft Informationen über den User zu speichern. halt diese datei fortlaufend aktuell.
`,
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getIntegrationsEnvPath(): string {
  const configured = process.env.INTEGRATIONS_ENV_PATH?.trim();
  return configured || DEFAULT_INTEGRATIONS_ENV_PATH;
}

function getAgentsEnvPath(): string {
  const configured = process.env.AGENTS_ENV_PATH?.trim();
  return configured || DEFAULT_AGENTS_ENV_PATH;
}

async function migrateLegacyFiles(): Promise<void> {
  // Migrate managed markdown files from /home/node/canvas-agent to /data/canvas-agent
  if (await fileExists(LEGACY_AGENT_STORAGE_DIR)) {
    console.log(`[bootstrap-agent-runtime] Checking for legacy files in ${LEGACY_AGENT_STORAGE_DIR}...`);
    await fs.mkdir(AGENT_STORAGE_DIR, { recursive: true });
    
    for (const fileName of Object.keys(MANAGED_FILE_TEMPLATES)) {
      const legacyPath = path.join(LEGACY_AGENT_STORAGE_DIR, fileName);
      const newPath = path.join(AGENT_STORAGE_DIR, fileName);
      
      if (await fileExists(legacyPath)) {
        if (!(await fileExists(newPath))) {
          console.log(`[bootstrap-agent-runtime] Migrating ${fileName} from legacy location...`);
          await fs.copyFile(legacyPath, newPath);
          await fs.chmod(newPath, 0o600);
        }
      }
    }
    
    // Migrate legacy runtime config if exists and new one doesn't
    const legacyRuntimeConfig = path.join(LEGACY_AGENT_STORAGE_DIR, 'agent-runtime-config.json');
    if (await fileExists(legacyRuntimeConfig) && !(await fileExists(RUNTIME_CONFIG_PATH))) {
      console.log(`[bootstrap-agent-runtime] Migrating runtime config from legacy location...`);
      await fs.copyFile(legacyRuntimeConfig, RUNTIME_CONFIG_PATH);
      await fs.chmod(RUNTIME_CONFIG_PATH, 0o600);
    }
  }
  
  // Migrate legacy env files
  await fs.mkdir(SECRETS_DIR, { recursive: true });
  
  const migrations = [
    { legacy: LEGACY_INTEGRATIONS_ENV_PATH, current: getIntegrationsEnvPath(), label: 'Canvas-Integrations.env' },
    { legacy: LEGACY_AGENTS_ENV_PATH, current: getAgentsEnvPath(), label: 'Canvas-Agents.env' },
  ];
  
  for (const { legacy, current, label } of migrations) {
    if (await fileExists(legacy) && !(await fileExists(current))) {
      console.log(`[bootstrap-agent-runtime] Migrating ${label} from legacy location...`);
      await fs.copyFile(legacy, current);
      await fs.chmod(current, 0o600);
    }
  }
}

async function ensureIntegrationsEnvBootstrap(): Promise<void> {
  // Ensure secrets directory exists
  await fs.mkdir(SECRETS_DIR, { recursive: true });
  
  const envFiles = [
    { label: 'integrations', filePath: getIntegrationsEnvPath() },
    { label: 'agents', filePath: getAgentsEnvPath() },
  ];

  for (const envFile of envFiles) {
    await fs.mkdir(path.dirname(envFile.filePath), { recursive: true });

    try {
      const handle = await fs.open(envFile.filePath, 'wx', 0o600);
      await handle.close();
      await fs.chmod(envFile.filePath, 0o600);
      console.log(`[bootstrap-agent-runtime] Created ${envFile.label} env file: ${envFile.filePath}.`);
      continue;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === 'EEXIST') {
          await fs.chmod(envFile.filePath, 0o600).catch(() => undefined);
          console.log(`[bootstrap-agent-runtime] ${envFile.label} env file exists: ${envFile.filePath} (preserved).`);
          continue;
        }

        if (error.code === 'EISDIR') {
          console.warn(`[bootstrap-agent-runtime] WARNING: ${envFile.label} env path is a directory: ${envFile.filePath}.`);
          continue;
        }
      }

      throw error;
    }
  }
}

function buildDefaultConfig() {
  return {
    version: 1,
    mainAgent: 'canvas-main-agent',
    provider: {
      id: 'codex-cli',
      kind: 'cli',
    },
    providers: {
      'codex-cli': {
        enabled: true,
        command: 'codex',
      },
      'claude-cli': {
        enabled: true,
        command: 'claude',
      },
      openrouter: {
        enabled: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-sonnet-4.5',
        apiKeySource: 'agents-env',
      },
      ollama: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:11434',
        model: 'llama3.2:3b',
        apiKeySource: 'agents-env',
      },
    },
    doctor: {
      enableLivePing: true,
      timeoutMs: 2500,
    },
    updatedAt: new Date().toISOString(),
    updatedBy: 'system:bootstrap',
  };
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
  await fs.writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(payload, null, 2));
}

async function ensureAgentStorageBootstrap(): Promise<void> {
  await fs.mkdir(AGENT_STORAGE_DIR, { recursive: true });

  for (const [fileName, template] of Object.entries(MANAGED_FILE_TEMPLATES)) {
    const targetPath = path.join(AGENT_STORAGE_DIR, fileName);
    if (await fileExists(targetPath)) {
      continue;
    }
    await writeTextAtomic(targetPath, template);
    console.log(`[bootstrap-agent-runtime] Created ${fileName} with default template.`);
  }

  if (!(await fileExists(RUNTIME_CONFIG_PATH))) {
    await writeJsonAtomic(RUNTIME_CONFIG_PATH, buildDefaultConfig());
    console.log(`[bootstrap-agent-runtime] Created default runtime config.`);
  }
}

async function runLegacySessionCleanupIfNeeded(): Promise<void> {
  if (await fileExists(LEGACY_WIPE_MARKER_PATH)) {
    console.log(`[bootstrap-agent-runtime] Legacy wipe skipped (marker exists: ${LEGACY_WIPE_MARKER_PATH}).`);
    return;
  }

  const deletedMessages = await db.delete(aiMessages).returning({ id: aiMessages.id });
  const deletedSessions = await db.delete(aiSessions).returning({ id: aiSessions.id });

  const markerContent = {
    doneAt: new Date().toISOString(),
    deleted: {
      aiMessages: deletedMessages.length,
      aiSessions: deletedSessions.length,
    },
  };

  await fs.writeFile(LEGACY_WIPE_MARKER_PATH, `${JSON.stringify(markerContent, null, 2)}\n`, 'utf8');

  console.log(
    `[bootstrap-agent-runtime] Legacy wipe done (messages=${deletedMessages.length}, sessions=${deletedSessions.length}).`,
  );
}

async function main() {
  // Load database modules dynamically after env bootstrap so DATA/path aliases are available.
  try {
    const dbModule = await import('../app/lib/db/index');
    const schemaModule = await import('../app/lib/db/schema');
    db = dbModule.db;
    aiMessages = schemaModule.aiMessages;
    aiSessions = schemaModule.aiSessions;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Database module not available during bootstrap-agent-runtime: ${message}`);
  }

  // First migrate any legacy files from old locations
  await migrateLegacyFiles();
  
  // Then ensure new files exist
  await ensureIntegrationsEnvBootstrap();
  await ensureAgentStorageBootstrap();
  await runLegacySessionCleanupIfNeeded();

  console.log('[bootstrap-agent-runtime] Agent runtime bootstrap complete.');
  console.log(`[bootstrap-agent-runtime] Agent files location: ${AGENT_STORAGE_DIR}`);
  console.log(`[bootstrap-agent-runtime] Secrets location: ${SECRETS_DIR}`);
}

main().catch((error) => {
  console.error('[bootstrap-agent-runtime] Failed:', error);
  process.exit(1);
});
