import { promises as fs } from 'node:fs';
import path from 'node:path';

import { db } from '../app/lib/db';
import { aiMessages, aiSessions } from '../app/lib/db/schema';
import {
  resolveAgentStorageDir,
  resolveDefaultAgentsEnvPath,
  resolveDefaultIntegrationsEnvPath,
  resolveSecretsDir,
} from '../app/lib/runtime-data-paths';

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

- Main agent: canvas-main-agent
- Scope: Canvas Notebook runtime behavior and guardrails
`,
  'MEMORY.md': `# MEMORY

- Persistent notes and long-lived decisions for the main agent.
`,
  'SOUL.md': `# SOUL

- Tone and interaction style for the main agent in Canvas Notebook.
`,
  'TOOLS.md': `# TOOLS

## Skills CLI

Canvas Notebook hat eine Skills CLI für den Agenten.

**Voraussetzung:** GEMINI_API_KEY muss in /settings konfiguriert sein.

### Image Generation
\`\`\`bash
image-generation --prompt "..." [--aspect-ratio 1:1] [--count 1] [--ref path/to/ref.png]
\`\`\`
Aspect ratios: 16:9, 1:1, 9:16, 4:3, 3:4. Count: 1–4.
Output: workspace/image-generation/generations/

### Video Generation (VEO)
\`\`\`bash
video-generation --prompt "..." [--mode text_to_video] [--aspect-ratio 16:9] [--resolution 720p]
\`\`\`
Modes: text_to_video, frames_to_video (--start-frame), references_to_video (--ref + --prompt), extend_video (--input-video).
Output: workspace/veo-studio/video-generation/ — Dauer: 3–10 Minuten.

### Ad Localization (Nano Banana)
\`\`\`bash
ad-localization --ref "nano-banana-ad-localizer/assets/ad.png" --market "Germany" --market "France"
\`\`\`
Referenzbild MUSS unter nano-banana-ad-localizer/ liegen. Bis zu 12 Märkte pro Aufruf.
Output: workspace/nano-banana-ad-localizer/localizations/

### Antwortformat
\`{ "success": true, "data": { ... } }\` oder \`{ "success": false, "error": "..." }\`
"path"-Felder sind workspace-relativ und können mit dem read-Tool geöffnet werden.

### Skill-Dokumentation
- /data/skills/README.md
- /data/skills/image-generation/README.md
- /data/skills/video-generation/README.md
- /data/skills/ad-localization/README.md
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
