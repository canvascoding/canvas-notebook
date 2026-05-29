import 'server-only';

import path from 'path';
import { promises as fs } from 'fs';
import { type AgentId } from './catalog';
import { DEFAULT_PI_CONFIG, normalizePiRuntimeConfig, type PiRuntimeConfig, validatePiConfig } from '../pi/config';
import { resolveAgentStorageDir, resolveAgentsStorageRoot } from '../runtime-data-paths';

export const AGENT_STORAGE_DIR = resolveAgentStorageDir();
export const AGENTS_STORAGE_ROOT = resolveAgentsStorageRoot();
export const DEFAULT_MANAGED_AGENT_ID = 'canvas-agent';
export const PI_RUNTIME_CONFIG_FILE = 'pi-runtime-config.json';
export const PI_RUNTIME_CONFIG_PATH = path.join(AGENT_STORAGE_DIR, PI_RUNTIME_CONFIG_FILE);
export const AGENT_MANAGED_FILE_NAMES = ['AGENTS.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'] as const;
export const SPECIAL_AGENT_MANAGED_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'] as const;
export const CANVAS_INHERITED_FILE_NAMES = ['IDENTITY.md', 'USER.md'] as const;

export type AgentManagedFileName = (typeof AGENT_MANAGED_FILE_NAMES)[number];
export type AgentManagedFiles = Record<AgentManagedFileName, string>;

// Seed system prompts directory (relative to project root)
const SEED_SYS_PROMPTS_DIR = path.join(process.cwd(), 'seed_sys_prompts');

// Helper to read seed file content
async function readSeedFile(fileName: string): Promise<string | null> {
  const seedPath = path.join(SEED_SYS_PROMPTS_DIR, fileName);
  try {
    return await fs.readFile(seedPath, 'utf8');
  } catch {
    console.warn(`[storage] Seed file not found: ${seedPath}`);
    return null;
  }
}

// Check if content is effectively empty
function isContentEmpty(content: string | null): boolean {
  if (content === null) return true;
  return content.trim().length === 0;
}

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

export function isManagedControlPlaneAvailable(): boolean {
  return (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' ||
    Boolean(process.env.CANVAS_CONTROL_PLANE_URL?.trim() && process.env.CANVAS_INSTANCE_TOKEN?.trim())
  );
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withRuntimeProviderDefaults(config: PiRuntimeConfig): PiRuntimeConfig {
  const next = normalizePiRuntimeConfig(deepClone(config));
  if (isManagedControlPlaneAvailable() && !next.providers['canvas-control-plane']) {
    next.providers['canvas-control-plane'] = {
      id: 'canvas-control-plane',
      model: '',
      thinking: 'medium',
      enabledTools: [],
    };
  }
  return next;
}

function createUnconfiguredPiRuntimeConfig(): PiRuntimeConfig {
  const next = deepClone(DEFAULT_PI_CONFIG);
  next.providers = Object.fromEntries(
    Object.entries(next.providers).map(([providerId, providerConfig]) => [
      providerId,
      {
        ...providerConfig,
        model: '',
      },
    ]),
  );
  return withRuntimeProviderDefaults(next);
}

async function ensureStorageDirectory(): Promise<void> {
  await fs.mkdir(AGENT_STORAGE_DIR, { recursive: true });
}

function normalizeManagedAgentId(agentId?: string | null): string {
  const normalized = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
  if (!normalized) {
    return DEFAULT_MANAGED_AGENT_ID;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new AgentConfigValidationError('Invalid agentId.');
  }
  return normalized;
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

function resolveAgentScopedStorageDir(agentId?: string | null): string {
  return path.join(AGENTS_STORAGE_ROOT, normalizeManagedAgentId(agentId));
}

function resolveManagedFilePath(fileName: AgentManagedFileName, agentId?: string | null): string {
  return path.join(resolveAgentScopedStorageDir(agentId), fileName);
}

function resolveLegacyManagedFilePath(fileName: AgentManagedFileName): string {
  return path.join(AGENT_STORAGE_DIR, fileName);
}

function shouldMigrateLegacyCanvasAgentFiles(agentId?: string | null): boolean {
  return normalizeManagedAgentId(agentId) === DEFAULT_MANAGED_AGENT_ID;
}

function getOwnedManagedFileNames(agentId?: string | null): readonly AgentManagedFileName[] {
  return normalizeManagedAgentId(agentId) === DEFAULT_MANAGED_AGENT_ID
    ? AGENT_MANAGED_FILE_NAMES
    : SPECIAL_AGENT_MANAGED_FILE_NAMES;
}

export function isManagedAgentFileName(fileName: unknown): fileName is AgentManagedFileName {
  return typeof fileName === 'string' && (AGENT_MANAGED_FILE_NAMES as readonly string[]).includes(fileName);
}

export function isWritableManagedAgentFileName(fileName: AgentManagedFileName, agentId?: string | null): boolean {
  return getOwnedManagedFileNames(agentId).includes(fileName);
}

async function migrateLegacyCanvasAgentFileIfNeeded(
  fileName: AgentManagedFileName,
  targetPath: string,
  existingContent: string | null,
): Promise<string | null> {
  if (!isContentEmpty(existingContent)) {
    return existingContent;
  }

  const legacyContent = await readFileIfExists(resolveLegacyManagedFilePath(fileName));
  if (isContentEmpty(legacyContent)) {
    return existingContent;
  }

  await writeTextAtomic(targetPath, legacyContent ?? '');
  return legacyContent;
}

export async function ensureAgentManagedFilesExist(agentId?: string | null): Promise<void> {
  await fs.mkdir(resolveAgentScopedStorageDir(agentId), { recursive: true });
  if (shouldMigrateLegacyCanvasAgentFiles(agentId)) {
    await ensureStorageDirectory();
  }

  for (const fileName of getOwnedManagedFileNames(agentId)) {
    const filePath = resolveManagedFilePath(fileName, agentId);
    let existing = await readFileIfExists(filePath);

    // Skip if file exists and has content
    if (!isContentEmpty(existing)) {
      continue;
    }

    if (shouldMigrateLegacyCanvasAgentFiles(agentId)) {
      existing = await migrateLegacyCanvasAgentFileIfNeeded(fileName, filePath, existing);
      if (!isContentEmpty(existing)) {
        continue;
      }
    }

    // Read seed content and write if available
    const seedContent = await readSeedFile(fileName);
    if (seedContent !== null) {
      await writeTextAtomic(filePath, seedContent);
    }
  }
}

export async function readManagedAgentFile(fileName: AgentManagedFileName, agentId?: string | null): Promise<string> {
  await ensureAgentManagedFilesExist(agentId);
  const filePath = resolveManagedFilePath(fileName, agentId);
  const content = await readFileIfExists(filePath);

  if (!isContentEmpty(content)) {
    return content ?? '';
  }

  if (shouldMigrateLegacyCanvasAgentFiles(agentId)) {
    const migratedContent = await migrateLegacyCanvasAgentFileIfNeeded(fileName, filePath, content);
    if (!isContentEmpty(migratedContent)) {
      return migratedContent ?? '';
    }
  }

  // If file is empty, try to return seed content
  if (isContentEmpty(content)) {
    const seedContent = await readSeedFile(fileName);
    if (seedContent !== null) {
      return seedContent;
    }
  }

  return content ?? '';
}

export async function readManagedAgentFiles(agentId?: string | null): Promise<AgentManagedFiles> {
  await ensureAgentManagedFilesExist(agentId);

  const entries = await Promise.all(
    AGENT_MANAGED_FILE_NAMES.map(async (fileName) => {
      const content = await readManagedAgentFile(fileName, agentId);
      return [fileName, content] as const;
    })
  );

  return Object.fromEntries(entries) as AgentManagedFiles;
}

export async function readRuntimeManagedAgentFiles(agentId?: string | null): Promise<AgentManagedFiles> {
  const normalizedAgentId = normalizeManagedAgentId(agentId);
  if (normalizedAgentId === DEFAULT_MANAGED_AGENT_ID) {
    return readManagedAgentFiles(DEFAULT_MANAGED_AGENT_ID);
  }

  const entries = await Promise.all(
    AGENT_MANAGED_FILE_NAMES.map(async (fileName) => {
      const inherited = (CANVAS_INHERITED_FILE_NAMES as readonly string[]).includes(fileName);
      const sourceAgentId = inherited ? DEFAULT_MANAGED_AGENT_ID : normalizedAgentId;
      const content = await readManagedAgentFile(fileName, sourceAgentId);
      return [fileName, content] as const;
    }),
  );

  return Object.fromEntries(entries) as AgentManagedFiles;
}

export async function writeManagedAgentFile(fileName: AgentManagedFileName, content: string, agentId?: string | null): Promise<string> {
  await ensureAgentManagedFilesExist(agentId);
  const filePath = resolveManagedFilePath(fileName, agentId);
  await writeTextAtomic(filePath, content);
  return readManagedAgentFile(fileName, agentId);
}

/**
 * Reads PI runtime configuration.
 */
export async function readPiRuntimeConfig(): Promise<PiRuntimeConfig> {
  await ensureStorageDirectory();
  const rawContent = await readFileIfExists(PI_RUNTIME_CONFIG_PATH);
  if (rawContent === null) {
    return createUnconfiguredPiRuntimeConfig();
  }

  try {
    const config = JSON.parse(rawContent) as PiRuntimeConfig;
    return withRuntimeProviderDefaults(config);
  } catch {
    return createUnconfiguredPiRuntimeConfig();
  }
}

/**
 * Writes PI runtime configuration.
 */
export async function writePiRuntimeConfig(config: PiRuntimeConfig): Promise<PiRuntimeConfig> {
  const normalizedConfig = withRuntimeProviderDefaults(config);
  const validationError = validatePiConfig(normalizedConfig);
  if (validationError) {
    throw new AgentConfigValidationError(validationError);
  }

  await ensureStorageDirectory();
  const payload = {
    ...normalizedConfig,
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

export async function buildAgentConfigReadiness(): Promise<AgentConfigReadiness> {
  let piReadiness: AgentConfigReadiness['pi'] | undefined;
  try {
    const piConfig = await readPiRuntimeConfig();
    const piProvider = piConfig.providers[piConfig.activeProvider];
    const { resolvePiApiKey } = await import('../pi/api-key-resolver');
    const apiKey = await resolvePiApiKey(piConfig.activeProvider);
    
    const piIssues: string[] = [];
    if (!apiKey) {
      piIssues.push(`API key for PI provider "${piConfig.activeProvider}" is missing.`);
    }
    if (!piProvider?.model) {
      piIssues.push(`No model selected for PI provider "${piConfig.activeProvider}".`);
    }

    piReadiness = {
      activeProvider: piConfig.activeProvider,
      model: piProvider?.model || '',
      ready: piIssues.length === 0,
      authSet: !!apiKey,
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

export async function writeAgentRuntimeConfig(): Promise<AgentRuntimeConfig> {
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
