import { promises as fs } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'node:path';
import { loadAppEnv } from '../server/load-app-env';
import { isOnboardingComplete } from '../app/lib/onboarding/status';

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
    return path.resolve(/*turbopackIgnore: true*/ configured);
  }
  if (directoryExists(CONTAINER_DATA_ROOT)) {
    return CONTAINER_DATA_ROOT;
  }
  return path.resolve(/*turbopackIgnore: true*/ cwd, 'data');
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

// Seed system prompts directory (relative to project root)
const SEED_SYS_PROMPTS_DIR = path.join(process.cwd(), 'seed_sys_prompts');

// All managed files (excluding BOOTSTRAP.md which is only for initial setup)
const MANAGED_FILE_NAMES = ['AGENTS.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'] as const;

// Helper to read seed file content
async function readSeedFile(fileName: string): Promise<string | null> {
  const seedPath = path.join(SEED_SYS_PROMPTS_DIR, fileName);
  try {
    return await fs.readFile(seedPath, 'utf8');
  } catch {
    console.warn(`[bootstrap-agent-runtime] Seed file not found: ${seedPath}`);
    return null;
  }
}

// Check if content is effectively empty
function isContentEmpty(content: string | null): boolean {
  if (content === null) return true;
  return content.trim().length === 0;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
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
    
    for (const fileName of MANAGED_FILE_NAMES) {
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

  // Check onboarding status for BOOTSTRAP.md handling
  const onboardingComplete = await isOnboardingComplete().catch(() => false);

  for (const fileName of MANAGED_FILE_NAMES) {
    const targetPath = path.join(AGENT_STORAGE_DIR, fileName);
    const existingContent = await readFileIfExists(targetPath);

    // Skip if file exists and has content
    if (!isContentEmpty(existingContent)) {
      continue;
    }

    // Read seed content
    const seedContent = await readSeedFile(fileName);
    if (seedContent === null) {
      console.warn(`[bootstrap-agent-runtime] Seed content not found for ${fileName}, skipping.`);
      continue;
    }

    await writeTextAtomic(targetPath, seedContent);
    console.log(`[bootstrap-agent-runtime] Created ${fileName} with seed content.`);
  }

  // Handle BOOTSTRAP.md separately - only copy if onboarding not complete
  if (!onboardingComplete) {
    const bootstrapTargetPath = path.join(AGENT_STORAGE_DIR, 'BOOTSTRAP.md');
    const existingBootstrap = await readFileIfExists(bootstrapTargetPath);

    if (isContentEmpty(existingBootstrap)) {
      const bootstrapSeed = await readSeedFile('BOOTSTRAP.md');
      if (bootstrapSeed !== null) {
        await writeTextAtomic(bootstrapTargetPath, bootstrapSeed);
        console.log(`[bootstrap-agent-runtime] Created BOOTSTRAP.md with seed content.`);
      }
    }
  } else {
    console.log(`[bootstrap-agent-runtime] Skipping BOOTSTRAP.md (onboarding completed).`);
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
