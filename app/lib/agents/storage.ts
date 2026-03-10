import 'server-only';

import path from 'path';
import { promises as fs } from 'fs';
import { type AgentId } from './catalog';
import { DEFAULT_PI_CONFIG, type PiRuntimeConfig, validatePiConfig } from '../pi/config';
import { resolveAgentStorageDir } from '../runtime-data-paths';

export const AGENT_STORAGE_DIR = resolveAgentStorageDir();
export const PI_RUNTIME_CONFIG_FILE = 'pi-runtime-config.json';
export const PI_RUNTIME_CONFIG_PATH = path.join(AGENT_STORAGE_DIR, PI_RUNTIME_CONFIG_FILE);
export const AGENT_MANAGED_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;

export type AgentManagedFileName = (typeof AGENT_MANAGED_FILE_NAMES)[number];
export type AgentManagedFiles = Record<AgentManagedFileName, string>;

const DEFAULT_AGENT_FILE_TEMPLATES: Record<AgentManagedFileName, string> = {
  'AGENTS.md': `# AGENTS\n\n- Main agent: canvas-main-agent\n- Scope: Canvas Notebook runtime behavior and guardrails\n`,
  'MEMORY.md': `# MEMORY\n\n- Persistent notes and long-lived decisions for the main agent.\n`,
  'SOUL.md': `# SOUL\n\n- Tone and interaction style for the main agent in Canvas Notebook.\n`,
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

export type AgentConfigReadiness = {
  activeProviderId: string;
  activeProviderReady: boolean;
  pi?: {
    activeProvider: string;
    model: string;
    ready: boolean;
    authSet: boolean;
    issues: string[];
  };
};

export type AgentRuntimeConfig = {
  version: number;
  provider: {
    id: string;
    kind: 'pi';
  };
  providers: Record<string, never>;
};

const DEFAULT_AGENT_RUNTIME_CONFIG: AgentRuntimeConfig = {
  version: 1,
  provider: { id: 'pi', kind: 'pi' },
  providers: {},
};

export class AgentConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigValidationError';
  }
}

async function ensureStorageDirectory(): Promise<void> {
  await fs.mkdir(AGENT_STORAGE_DIR, { recursive: true });
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
  await fs.writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

function resolveManagedFilePath(fileName: AgentManagedFileName): string {
  return path.join(AGENT_STORAGE_DIR, fileName);
}

export function isManagedAgentFileName(fileName: unknown): fileName is AgentManagedFileName {
  return typeof fileName === 'string' && (AGENT_MANAGED_FILE_NAMES as readonly string[]).includes(fileName);
}

export async function ensureAgentManagedFilesExist(): Promise<void> {
  await ensureStorageDirectory();

  for (const fileName of AGENT_MANAGED_FILE_NAMES) {
    const filePath = resolveManagedFilePath(fileName);
    const existing = await readFileIfExists(filePath);
    if (existing !== null) {
      continue;
    }
    await writeTextAtomic(filePath, DEFAULT_AGENT_FILE_TEMPLATES[fileName]);
  }
}

export async function readManagedAgentFile(fileName: AgentManagedFileName): Promise<string> {
  await ensureAgentManagedFilesExist();
  const filePath = resolveManagedFilePath(fileName);
  const content = await readFileIfExists(filePath);
  return content ?? DEFAULT_AGENT_FILE_TEMPLATES[fileName];
}

export async function readManagedAgentFiles(): Promise<AgentManagedFiles> {
  await ensureAgentManagedFilesExist();

  const entries = await Promise.all(
    AGENT_MANAGED_FILE_NAMES.map(async (fileName) => {
      const content = await readManagedAgentFile(fileName);
      return [fileName, content] as const;
    })
  );

  return Object.fromEntries(entries) as AgentManagedFiles;
}

export async function writeManagedAgentFile(fileName: AgentManagedFileName, content: string): Promise<string> {
  await ensureAgentManagedFilesExist();
  const filePath = resolveManagedFilePath(fileName);
  await writeTextAtomic(filePath, content);
  return readManagedAgentFile(fileName);
}

/**
 * Reads PI runtime configuration.
 */
export async function readPiRuntimeConfig(): Promise<PiRuntimeConfig> {
  await ensureStorageDirectory();
  const rawContent = await readFileIfExists(PI_RUNTIME_CONFIG_PATH);
  if (rawContent === null) {
    return DEFAULT_PI_CONFIG;
  }

  try {
    return JSON.parse(rawContent) as PiRuntimeConfig;
  } catch {
    return DEFAULT_PI_CONFIG;
  }
}

/**
 * Writes PI runtime configuration.
 */
export async function writePiRuntimeConfig(config: PiRuntimeConfig): Promise<PiRuntimeConfig> {
  const validationError = validatePiConfig(config);
  if (validationError) {
    throw new AgentConfigValidationError(validationError);
  }

  await ensureStorageDirectory();
  const payload = {
    ...config,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(PI_RUNTIME_CONFIG_PATH, payload);
  return payload;
}

// Compatibility helpers for transition
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function readAgentRuntimeConfig(): Promise<AgentRuntimeConfig> {
  return DEFAULT_AGENT_RUNTIME_CONFIG;
}

export function sanitizeAgentRuntimeConfig(config: unknown): AgentRuntimeConfig {
  if (!isRecord(config)) {
    return DEFAULT_AGENT_RUNTIME_CONFIG;
  }

  const providerValue = isRecord(config.provider) ? config.provider : null;
  const providerId =
    providerValue && typeof providerValue.id === 'string' && providerValue.id.trim().length > 0
      ? providerValue.id
      : DEFAULT_AGENT_RUNTIME_CONFIG.provider.id;

  return {
    version: typeof config.version === 'number' ? config.version : DEFAULT_AGENT_RUNTIME_CONFIG.version,
    provider: {
      id: providerId,
      kind: 'pi',
    },
    providers: {},
  };
}

export async function buildAgentConfigReadiness(_config: AgentRuntimeConfig): Promise<AgentConfigReadiness> {
  let piReadiness: AgentConfigReadiness['pi'] | undefined;
  try {
    const piConfig = await readPiRuntimeConfig();
    const piProvider = piConfig.providers[piConfig.activeProvider];
    const { resolvePiApiKey } = await import('../pi/api-key-resolver');
    const apiKey = await resolvePiApiKey(piConfig.activeProvider);
    
    const piIssues: string[] = [];
    if (!apiKey && piConfig.activeProvider !== 'ollama') {
      piIssues.push(`API key for PI provider "${piConfig.activeProvider}" is missing.`);
    }
    if (!piProvider?.model) {
      piIssues.push(`No model selected for PI provider "${piConfig.activeProvider}".`);
    }

    piReadiness = {
      activeProvider: piConfig.activeProvider,
      model: piProvider?.model || '',
      ready: piIssues.length === 0,
      authSet: !!apiKey || piConfig.activeProvider === 'ollama',
      issues: piIssues,
    };
  } catch (error) {
    piReadiness = {
      activeProvider: 'unknown',
      model: '',
      ready: false,
      authSet: false,
      issues: [error instanceof Error ? error.message : 'Failed to check PI readiness.'],
    };
  }

  return {
    activeProviderId: piReadiness?.activeProvider || 'pi',
    activeProviderReady: piReadiness?.ready || false,
    pi: piReadiness,
  };
}

export async function writeAgentRuntimeConfig(_input: unknown, _updatedBy: string): Promise<AgentRuntimeConfig> {
  return readAgentRuntimeConfig();
}

export async function migrateLegacyAgentEnvIfNeeded(): Promise<void> {
  // No-op in PI-first mode
}

export function providerIdToAgentId(providerId: string): AgentId {
  // Map legacy provider IDs to AgentIds
  if (providerId === 'claude-cli') return 'codex'; // Claude CLI uses codex agent in PI mode
  if (providerId === 'codex-cli') return 'codex';
  // Only allow valid AgentIds from catalog
  if (providerId === 'codex' || providerId === 'openrouter' || providerId === 'ollama') {
    return providerId as AgentId;
  }
  // Default to codex for unknown providers in PI mode
  return 'codex';
}
