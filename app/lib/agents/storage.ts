import 'server-only';

import path from 'path';
import { promises as fs } from 'fs';
import { type AgentId } from './catalog';
import { DEFAULT_PI_CONFIG, normalizePiRuntimeConfig, type PiRuntimeConfig, validatePiConfig } from '../pi/config';
import { DISABLED_ALL_TOOLS_SENTINEL, isLegacyEnabledToolsValue } from '../pi/enabled-tools';
import { SKILL_TOOL_NAMES } from '../pi/toolsets';
import { CANVAS_CONTROL_PLANE_PROVIDER_ID, getCanvasControlPlaneCatalog } from '../managed/control-plane-models';
import { getManagedControlPlaneBaseUrl } from '../managed/control-plane-url';
import {
  resolveAgentStorageDir,
  resolveAgentsStorageRoot,
  resolveOrganizationAgentsDir,
  resolveUserAgentsDir,
} from '../runtime-data-paths';
import { getManagedAgentFileLimitBytes } from './managed-file-limits';
import {
  ensureSettingsStorageDirectory,
  readSettingsTextFileIfExists,
  resolveSettingsStoragePath,
  writeSettingsJsonFileAtomic,
} from '@/app/lib/settings-storage';
import {
  LEGACY_MAIN_AGENT_ID,
  MAIN_AGENT_ID,
  normalizeMainAgentIdAlias,
} from './main-agent';

export const AGENT_STORAGE_DIR = resolveAgentStorageDir();
export const AGENTS_STORAGE_ROOT = resolveAgentsStorageRoot();
export const DEFAULT_MANAGED_AGENT_ID = MAIN_AGENT_ID;
export { LEGACY_MAIN_AGENT_ID } from './main-agent';
export const EMAIL_MANAGED_AGENT_ID = 'email-agent';
export const SYSTEM_MANAGED_AGENT_IDS = [DEFAULT_MANAGED_AGENT_ID, EMAIL_MANAGED_AGENT_ID] as const;
export const PI_RUNTIME_CONFIG_FILE = 'pi-runtime-config.json';
export const PI_RUNTIME_CONFIG_PATH = resolveSettingsStoragePath(PI_RUNTIME_CONFIG_FILE);
const LEGACY_HEARTBEAT_FILE_NAME = 'HEARTBEAT.md' as const;
export const AGENT_MANAGED_FILE_NAMES = ['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;
export const SPECIAL_AGENT_MANAGED_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;
export const CANVAS_INHERITED_FILE_NAMES = ['USER.md'] as const;
export const ORGANIZATION_AGENT_DEFINITION_FILE_NAMES = ['AGENTS.md', 'SOUL.md', 'TOOLS.md'] as const;

export type AgentManagedFileName = (typeof AGENT_MANAGED_FILE_NAMES)[number];
export type AgentManagedFiles = Record<AgentManagedFileName, string>;
export type AgentStorageScope = {
  userId?: string | null;
  userName?: string | null;
  organizationId?: string | null;
  role?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  agentScopeType?: 'user' | 'organization' | 'system' | null;
  ownerUserId?: string | null;
};

// Seed system prompts directory (relative to project root)
const SEED_SYS_PROMPTS_DIR = path.join(process.cwd(), 'seed_sys_prompts');

// Helper to read seed file content
async function readSeedFile(fileName: string, agentId?: string | null): Promise<string | null> {
  if (!AGENT_MANAGED_FILE_NAMES.includes(fileName as AgentManagedFileName)) {
    throw new Error('Invalid managed agent file name');
  }
  const normalizedAgentId = normalizeManagedAgentId(agentId);
  const candidatePaths = normalizedAgentId === EMAIL_MANAGED_AGENT_ID
    ? [path.join(SEED_SYS_PROMPTS_DIR, EMAIL_MANAGED_AGENT_ID, fileName), path.join(SEED_SYS_PROMPTS_DIR, fileName)]
    : [path.join(SEED_SYS_PROMPTS_DIR, fileName)];
  for (const seedPath of candidatePaths) {
    try {
      return await fs.readFile(seedPath, 'utf8');
    } catch {
      // Try the generic seed when this is a specialized agent.
    }
  }
  console.warn(`[storage] Seed file not found: ${candidatePaths[0]}`);
  return null;
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
  return Boolean(getManagedControlPlaneBaseUrl() && process.env.CANVAS_INSTANCE_TOKEN?.trim());
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withSkillToolDefaultsMigration(config: PiRuntimeConfig): PiRuntimeConfig {
  if (config.runtimeMigrations?.skillToolsDefaultEnabled) {
    return config;
  }

  const next = deepClone(config);
  for (const providerConfig of Object.values(next.providers)) {
    const enabledTools = Array.isArray(providerConfig.enabledTools) ? providerConfig.enabledTools : [];
    if (
      enabledTools.length === 0 ||
      enabledTools.includes(DISABLED_ALL_TOOLS_SENTINEL) ||
      isLegacyEnabledToolsValue(enabledTools)
    ) {
      continue;
    }

    const enabledSet = new Set(enabledTools);
    for (const toolName of SKILL_TOOL_NAMES) {
      if (!enabledSet.has(toolName)) {
        enabledTools.push(toolName);
        enabledSet.add(toolName);
      }
    }
    providerConfig.enabledTools = enabledTools;
  }

  next.runtimeMigrations = {
    ...next.runtimeMigrations,
    skillToolsDefaultEnabled: true,
  };
  return next;
}

function withRuntimeProviderDefaults(config: PiRuntimeConfig): PiRuntimeConfig {
  const next = withSkillToolDefaultsMigration(normalizePiRuntimeConfig(deepClone(config)));
  if (isManagedControlPlaneAvailable() && !next.providers[CANVAS_CONTROL_PLANE_PROVIDER_ID]) {
    next.providers[CANVAS_CONTROL_PLANE_PROVIDER_ID] = {
      id: CANVAS_CONTROL_PLANE_PROVIDER_ID,
      model: '',
      thinking: 'medium',
      enabledTools: [],
    };
  }
  return next;
}

async function withManagedRuntimeDefaults(config: PiRuntimeConfig): Promise<PiRuntimeConfig> {
  const next = withRuntimeProviderDefaults(config);
  if (!isManagedControlPlaneAvailable()) {
    return next;
  }

  const activeProviderConfig = next.providers[next.activeProvider];
  if (activeProviderConfig?.model?.trim()) {
    return next;
  }

  const existingManagedConfig = next.providers[CANVAS_CONTROL_PLANE_PROVIDER_ID];
  const configuredManagedModel = existingManagedConfig?.model?.trim();
  const managedCatalog = configuredManagedModel ? null : await getCanvasControlPlaneCatalog();
  const discoveredManagedModel = configuredManagedModel
    || (managedCatalog?.status === 'ready' ? managedCatalog.defaultModelId : null)
    || '';

  if (!discoveredManagedModel) {
    return next;
  }

  return {
    ...next,
    activeProvider: CANVAS_CONTROL_PLANE_PROVIDER_ID,
    providers: {
      ...next.providers,
      [CANVAS_CONTROL_PLANE_PROVIDER_ID]: {
        ...existingManagedConfig,
        id: CANVAS_CONTROL_PLANE_PROVIDER_ID,
        model: discoveredManagedModel,
        thinking: existingManagedConfig?.thinking || managedCatalog?.defaultThinkingLevel || 'off',
        enabledTools: existingManagedConfig?.enabledTools || [],
      },
    },
  };
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
  await ensureSettingsStorageDirectory();
}

async function ensureLegacyAgentStorageDirectory(): Promise<void> {
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
  return normalizeMainAgentIdAlias(normalized);
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

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
  await fs.writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

function resolveAgentStorageRootForScope(
  fileName: AgentManagedFileName | typeof LEGACY_HEARTBEAT_FILE_NAME,
  agentId?: string | null,
  scope?: AgentStorageScope | null,
): string {
  const normalizedAgentId = normalizeManagedAgentId(agentId);
  if (normalizedAgentId === EMAIL_MANAGED_AGENT_ID) {
    return AGENTS_STORAGE_ROOT;
  }
  if (normalizedAgentId !== DEFAULT_MANAGED_AGENT_ID && scope?.agentScopeType === 'organization') {
    const organizationId = scope.organizationId?.trim();
    if (!organizationId) {
      throw new AgentConfigValidationError('organizationId is required for organization agent storage.');
    }
    if ((ORGANIZATION_AGENT_DEFINITION_FILE_NAMES as readonly string[]).includes(fileName)) {
      return path.join(resolveOrganizationAgentsDir(organizationId), normalizedAgentId, 'definition');
    }
    const userId = scope.userId?.trim();
    if (!userId) {
      throw new AgentConfigValidationError(`${fileName} requires an executing user scope.`);
    }
    return resolveUserAgentsDir(userId);
  }

  if (normalizedAgentId !== DEFAULT_MANAGED_AGENT_ID && scope?.agentScopeType === 'user') {
    const ownerUserId = scope.ownerUserId?.trim() || scope.userId?.trim();
    if (!ownerUserId) {
      // Profiles created before scoped ownership was introduced keep their
      // legacy shared storage location until a migration assigns an owner.
      return AGENTS_STORAGE_ROOT;
    }
    return resolveUserAgentsDir(ownerUserId);
  }

  const userId = scope?.userId?.trim();
  return userId ? resolveUserAgentsDir(userId) : AGENTS_STORAGE_ROOT;
}

function resolveScopedChildPath(root: string, childName: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, childName);
  const relativePath = path.relative(resolvedRoot, resolvedPath);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new AgentConfigValidationError(`Invalid ${label}.`);
  }

  return resolvedPath;
}

function resolveAgentScopedStorageDir(
  fileName: AgentManagedFileName | typeof LEGACY_HEARTBEAT_FILE_NAME,
  agentId?: string | null,
  scope?: AgentStorageScope | null,
): string {
  const root = resolveAgentStorageRootForScope(fileName, agentId, scope);
  if (
    normalizeManagedAgentId(agentId) !== DEFAULT_MANAGED_AGENT_ID
    && scope?.agentScopeType === 'organization'
    && (ORGANIZATION_AGENT_DEFINITION_FILE_NAMES as readonly string[]).includes(fileName)
  ) {
    return root;
  }
  return resolveScopedChildPath(root, normalizeManagedAgentId(agentId), 'agentId');
}

function resolveManagedFilePath(
  fileName: AgentManagedFileName | typeof LEGACY_HEARTBEAT_FILE_NAME,
  agentId?: string | null,
  scope?: AgentStorageScope | null,
): string {
  return resolveScopedChildPath(resolveAgentScopedStorageDir(fileName, agentId, scope), fileName, 'agent managed file');
}

function resolveLegacyManagedFilePath(fileName: AgentManagedFileName | typeof LEGACY_HEARTBEAT_FILE_NAME): string {
  return path.join(AGENT_STORAGE_DIR, fileName);
}

function resolveLegacyMainAgentScopedFilePath(
  fileName: AgentManagedFileName | typeof LEGACY_HEARTBEAT_FILE_NAME,
  scope?: AgentStorageScope | null,
): string {
  const root = resolveAgentStorageRootForScope(fileName, DEFAULT_MANAGED_AGENT_ID, scope);
  const directory = resolveScopedChildPath(root, LEGACY_MAIN_AGENT_ID, 'legacy main agentId');
  return resolveScopedChildPath(directory, fileName, 'legacy main-agent managed file');
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

export function validateManagedAgentFileContent(fileName: AgentManagedFileName, content: string): void {
  if (typeof content !== 'string') {
    throw new AgentConfigValidationError(`${fileName} must be text.`);
  }

  const maxBytes = getManagedAgentFileLimitBytes(fileName);
  const actualBytes = Buffer.byteLength(content, 'utf8');
  if (actualBytes > maxBytes) {
    throw new AgentConfigValidationError(`${fileName} is too large (${actualBytes} bytes). The limit is ${maxBytes} bytes.`);
  }
}

async function migrateLegacyCanvasAgentFileIfMissing(
  fileName: AgentManagedFileName,
  targetPath: string,
  existingContent: string | null,
  scope?: AgentStorageScope | null,
): Promise<string | null> {
  if (existingContent !== null) {
    return existingContent;
  }

  const sourcePaths = [resolveLegacyMainAgentScopedFilePath(fileName, scope)];
  if (!scope?.userId) {
    sourcePaths.push(resolveLegacyManagedFilePath(fileName));
  }
  for (const sourcePath of sourcePaths) {
    const legacyContent = await readFileIfExists(sourcePath);
    if (legacyContent === null) continue;
    await writeTextAtomic(targetPath, legacyContent);
    return legacyContent;
  }
  return null;
}

export async function ensureAgentManagedFilesExist(agentId?: string | null, scope?: AgentStorageScope | null): Promise<void> {
  const shouldUseLegacyMigration = shouldMigrateLegacyCanvasAgentFiles(agentId);
  if (shouldUseLegacyMigration && !scope?.userId) {
    await ensureLegacyAgentStorageDirectory();
  }

  for (const fileName of getOwnedManagedFileNames(agentId)) {
    const filePath = resolveManagedFilePath(fileName, agentId, scope);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let existing = await readFileIfExists(filePath);

    // A present empty file is intentional, for example after resetting USER.md or MEMORY.md.
    if (existing !== null) {
      continue;
    }

    if (shouldUseLegacyMigration) {
      existing = await migrateLegacyCanvasAgentFileIfMissing(fileName, filePath, existing, scope);
      if (existing !== null) {
        continue;
      }
    }

    // Read seed content and write if available
    const seedContent = await readSeedFile(fileName, agentId);
    if (seedContent !== null) {
      await writeTextAtomic(filePath, seedContent);
    }
  }
}

export async function readManagedAgentFile(
  fileName: AgentManagedFileName,
  agentId?: string | null,
  scope?: AgentStorageScope | null,
): Promise<string> {
  await ensureAgentManagedFilesExist(agentId, scope);
  const filePath = resolveManagedFilePath(fileName, agentId, scope);
  const content = await readFileIfExists(filePath);

  return content ?? '';
}

/**
 * Reads prior shared storage locations without creating scoped files or seeds.
 * This is only for one-time migrations that must preserve pre-user-scope data.
 */
export async function readLegacyManagedAgentFileContents(
  fileName: AgentManagedFileName,
  agentId?: string | null,
): Promise<string[]> {
  const sourcePaths = [resolveManagedFilePath(fileName, agentId)];
  if (shouldMigrateLegacyCanvasAgentFiles(agentId)) {
    sourcePaths.push(
      resolveLegacyMainAgentScopedFilePath(fileName),
      resolveLegacyManagedFilePath(fileName),
    );
  }
  const contents = await Promise.all(sourcePaths.map((filePath) => readFileIfExists(filePath)));
  return [...new Set(contents.filter((content): content is string => content !== null))];
}

/**
 * Reads the retired HEARTBEAT.md directly, without creating a missing file or
 * exposing it through the managed-files API. It exists only for the one-time
 * migration to workspace automations.
 */
export async function readLegacyHeartbeatInstructions(input: {
  userId: string;
  agentId?: string | null;
}): Promise<string> {
  const scopedPath = resolveManagedFilePath(LEGACY_HEARTBEAT_FILE_NAME, input.agentId, { userId: input.userId });
  const scopedContent = await readFileIfExists(scopedPath);
  if (scopedContent !== null) return scopedContent;

  if (shouldMigrateLegacyCanvasAgentFiles(input.agentId)) {
    const legacyScopedContent = await readFileIfExists(
      resolveLegacyMainAgentScopedFilePath(LEGACY_HEARTBEAT_FILE_NAME, { userId: input.userId }),
    );
    if (legacyScopedContent !== null) return legacyScopedContent;
    return (await readFileIfExists(resolveLegacyManagedFilePath(LEGACY_HEARTBEAT_FILE_NAME))) ?? '';
  }

  return '';
}

/** Removes the retired file after its content has been persisted in an automation. */
export async function removeLegacyHeartbeatInstructions(input: {
  userId: string;
  agentId?: string | null;
}): Promise<void> {
  const scopedPath = resolveManagedFilePath(LEGACY_HEARTBEAT_FILE_NAME, input.agentId, { userId: input.userId });
  await fs.rm(scopedPath, { force: true });

  if (shouldMigrateLegacyCanvasAgentFiles(input.agentId)) {
    await fs.rm(
      resolveLegacyMainAgentScopedFilePath(LEGACY_HEARTBEAT_FILE_NAME, { userId: input.userId }),
      { force: true },
    );
    await fs.rm(resolveLegacyManagedFilePath(LEGACY_HEARTBEAT_FILE_NAME), { force: true });
  }
}

export async function resetManagedAgentFile(
  fileName: AgentManagedFileName,
  agentId?: string | null,
  scope?: AgentStorageScope | null,
): Promise<string> {
  const filePath = resolveManagedFilePath(fileName, agentId, scope);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const seedContent = await readSeedFile(fileName, agentId);

  await writeTextAtomic(filePath, seedContent ?? '');
  return (await readFileIfExists(filePath)) ?? '';
}

export async function readManagedAgentFiles(agentId?: string | null, scope?: AgentStorageScope | null): Promise<AgentManagedFiles> {
  await ensureAgentManagedFilesExist(agentId, scope);

  const entries = await Promise.all(
    AGENT_MANAGED_FILE_NAMES.map(async (fileName) => {
      const inherited = normalizeManagedAgentId(agentId) !== DEFAULT_MANAGED_AGENT_ID
        && (CANVAS_INHERITED_FILE_NAMES as readonly string[]).includes(fileName);
      const content = await readManagedAgentFile(
        fileName,
        inherited ? DEFAULT_MANAGED_AGENT_ID : agentId,
        inherited ? { ...scope, agentScopeType: undefined, ownerUserId: undefined } : scope,
      );
      return [fileName, content] as const;
    })
  );

  return Object.fromEntries(entries) as AgentManagedFiles;
}

export async function readRuntimeManagedAgentFiles(agentId?: string | null, scope?: AgentStorageScope | null): Promise<AgentManagedFiles> {
  const normalizedAgentId = normalizeManagedAgentId(agentId);
  if (normalizedAgentId === DEFAULT_MANAGED_AGENT_ID) {
    return readManagedAgentFiles(DEFAULT_MANAGED_AGENT_ID, scope);
  }

  const entries = await Promise.all(
    AGENT_MANAGED_FILE_NAMES.map(async (fileName) => {
      const inherited = (CANVAS_INHERITED_FILE_NAMES as readonly string[]).includes(fileName);
      const sourceAgentId = inherited ? DEFAULT_MANAGED_AGENT_ID : normalizedAgentId;
      const content = await readManagedAgentFile(
        fileName,
        sourceAgentId,
        inherited ? { ...scope, agentScopeType: undefined, ownerUserId: undefined } : scope,
      );
      return [fileName, content] as const;
    }),
  );

  return Object.fromEntries(entries) as AgentManagedFiles;
}

export async function writeManagedAgentFile(
  fileName: AgentManagedFileName,
  content: string,
  agentId?: string | null,
  scope?: AgentStorageScope | null,
): Promise<string> {
  validateManagedAgentFileContent(fileName, content);
  await ensureAgentManagedFilesExist(agentId, scope);
  const filePath = resolveManagedFilePath(fileName, agentId, scope);
  await writeTextAtomic(filePath, content);
  return readManagedAgentFile(fileName, agentId, scope);
}

export async function deleteManagedAgentDefinitionStorage(
  agentId?: string | null,
  scope?: AgentStorageScope | null,
): Promise<void> {
  const normalizedAgentId = normalizeManagedAgentId(agentId);
  if (normalizedAgentId === DEFAULT_MANAGED_AGENT_ID) {
    throw new AgentConfigValidationError('Bradley storage cannot be deleted.');
  }
  const sampleFile: AgentManagedFileName = scope?.agentScopeType === 'organization' ? 'AGENTS.md' : 'MEMORY.md';
  const directory = resolveAgentScopedStorageDir(sampleFile, normalizedAgentId, scope);
  const target = scope?.agentScopeType === 'organization' ? path.dirname(directory) : directory;
  await fs.rm(target, { recursive: true, force: true });
}

/**
 * Reads PI runtime configuration.
 */
export async function readPiRuntimeConfig(): Promise<PiRuntimeConfig> {
  await ensureStorageDirectory();
  const { content: rawContent } = await readSettingsTextFileIfExists(PI_RUNTIME_CONFIG_FILE);
  if (rawContent === null) {
    return withManagedRuntimeDefaults(createUnconfiguredPiRuntimeConfig());
  }

  try {
    const config = JSON.parse(rawContent) as PiRuntimeConfig;
    return withManagedRuntimeDefaults(config);
  } catch {
    return withManagedRuntimeDefaults(createUnconfiguredPiRuntimeConfig());
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
  await writeSettingsJsonFileAtomic(PI_RUNTIME_CONFIG_FILE, payload);
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

export async function buildAgentConfigReadiness(scope?: AgentStorageScope | null): Promise<AgentConfigReadiness> {
  let piReadiness: AgentConfigReadiness['pi'] | undefined;
  try {
    const piConfig = await readPiRuntimeConfig();
    const piProvider = piConfig.providers[piConfig.activeProvider];
    const { resolvePiApiKey } = await import('../pi/api-key-resolver');
    const apiKey = await resolvePiApiKey(piConfig.activeProvider, { userId: scope?.userId });
    
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
