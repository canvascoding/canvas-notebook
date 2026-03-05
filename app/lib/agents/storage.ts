import 'server-only';

import path from 'path';
import { promises as fs } from 'fs';
import { spawnSync } from 'child_process';

import { readIntegrationsEnvState } from '@/app/lib/integrations/env-config';
import { type AgentId } from './catalog';

export const AGENT_STORAGE_DIR = '/home/node/canvas-agent';
export const AGENT_RUNTIME_CONFIG_FILE = 'agent-runtime-config.json';
export const AGENT_RUNTIME_CONFIG_PATH = path.join(AGENT_STORAGE_DIR, AGENT_RUNTIME_CONFIG_FILE);
export const AGENT_MANAGED_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;

const DEFAULT_MAIN_AGENT = 'canvas-main-agent';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';
const DEFAULT_DOCTOR_TIMEOUT_MS = 2500;

type RecordLike = Record<string, unknown>;

export type AgentManagedFileName = (typeof AGENT_MANAGED_FILE_NAMES)[number];
export type AgentProviderId = 'codex-cli' | 'claude-cli' | 'gemini-cli' | 'openrouter';
export type AgentProviderKind = 'cli' | 'openrouter';
export type OpenRouterApiKeySource = 'integrations-env' | 'process-env';

export type CliProviderConfig = {
  enabled: boolean;
  command: string;
};

export type OpenRouterProviderConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeySource: OpenRouterApiKeySource;
};

export type AgentRuntimeConfig = {
  version: 1;
  mainAgent: string;
  provider: {
    id: AgentProviderId;
    kind: AgentProviderKind;
  };
  providers: {
    'codex-cli': CliProviderConfig;
    'claude-cli': CliProviderConfig;
    'gemini-cli': CliProviderConfig;
    openrouter: OpenRouterProviderConfig;
  };
  doctor: {
    enableLivePing: boolean;
    timeoutMs: number;
  };
  updatedAt: string;
  updatedBy: string;
};

export type OpenRouterApiKeyResolution = {
  apiKey: string | null;
  isSet: boolean;
  source: OpenRouterApiKeySource | null;
  last4: string | null;
  warnings: string[];
};

export type ProviderReadiness = {
  id: AgentProviderId;
  kind: AgentProviderKind;
  enabled: boolean;
  available: boolean;
  issues: string[];
  command?: string;
  commandExists?: boolean;
  baseUrl?: string;
  model?: string;
  modelPlausible?: boolean;
  openRouterKeySet?: boolean;
};

export type AgentConfigReadiness = {
  activeProviderId: AgentProviderId;
  activeProviderReady: boolean;
  openRouterKey: {
    isSet: boolean;
    source: OpenRouterApiKeySource | null;
    last4: string | null;
    warnings: string[];
  };
  providers: Record<AgentProviderId, ProviderReadiness>;
};

export class AgentConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigValidationError';
  }
}

const providerAliases: Record<string, AgentProviderId> = {
  codex: 'codex-cli',
  'codex-cli': 'codex-cli',
  claude: 'claude-cli',
  'claude-cli': 'claude-cli',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  openrouter: 'openrouter',
};

const providerIdToAgentIdMap: Record<AgentProviderId, AgentId> = {
  'codex-cli': 'codex',
  'claude-cli': 'claude',
  'gemini-cli': 'gemini',
  openrouter: 'openrouter',
};

const agentIdToProviderIdMap: Record<AgentId, AgentProviderId> = {
  codex: 'codex-cli',
  claude: 'claude-cli',
  gemini: 'gemini-cli',
  openrouter: 'openrouter',
};

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isProviderAlias(value: unknown): value is string {
  return typeof value === 'string' && value in providerAliases;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeOpenRouterModel(model: string): string {
  const normalized = model.trim();
  if (!normalized) {
    return DEFAULT_OPENROUTER_MODEL;
  }

  if (normalized.startsWith('openrouter/')) {
    return normalized.slice('openrouter/'.length);
  }

  return normalized;
}

function providerKindForId(id: AgentProviderId): AgentProviderKind {
  return id === 'openrouter' ? 'openrouter' : 'cli';
}

function parseProviderId(value: unknown): AgentProviderId | null {
  if (!isProviderAlias(value)) {
    return null;
  }

  return providerAliases[value];
}

function normalizeOpenRouterApiKeySource(
  value: unknown,
  fallback: OpenRouterApiKeySource
): OpenRouterApiKeySource {
  if (value === 'integrations-env' || value === 'process-env') {
    return value;
  }
  return fallback;
}

function assertValidUrl(value: string, fieldName: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Unsupported protocol');
    }
  } catch {
    throw new AgentConfigValidationError(`${fieldName} must be a valid http(s) URL.`);
  }
}

function ensureFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  return fallback;
}

function normalizeCliProviderConfig(
  value: unknown,
  fallback: CliProviderConfig,
  defaultCommand: string,
  providerId: AgentProviderId
): CliProviderConfig {
  if (value !== undefined && !isRecord(value)) {
    throw new AgentConfigValidationError(`providers.${providerId} must be an object.`);
  }

  const candidate = isRecord(value) ? value : {};

  const enabled =
    candidate.enabled === undefined
      ? fallback.enabled
      : typeof candidate.enabled === 'boolean'
        ? candidate.enabled
        : (() => {
            throw new AgentConfigValidationError(`providers.${providerId}.enabled must be a boolean.`);
          })();

  const command =
    normalizeNonEmptyString(candidate.command) ?? normalizeNonEmptyString(fallback.command) ?? defaultCommand;

  if (!command) {
    throw new AgentConfigValidationError(`providers.${providerId}.command must not be empty.`);
  }

  return { enabled, command };
}

function normalizeOpenRouterProviderConfig(
  value: unknown,
  fallback: OpenRouterProviderConfig
): OpenRouterProviderConfig {
  if (value !== undefined && !isRecord(value)) {
    throw new AgentConfigValidationError('providers.openrouter must be an object.');
  }

  const candidate = isRecord(value) ? value : {};

  const enabled =
    candidate.enabled === undefined
      ? fallback.enabled
      : typeof candidate.enabled === 'boolean'
        ? candidate.enabled
        : (() => {
            throw new AgentConfigValidationError('providers.openrouter.enabled must be a boolean.');
          })();

  const baseUrl = normalizeNonEmptyString(candidate.baseUrl) ?? fallback.baseUrl;
  assertValidUrl(baseUrl, 'providers.openrouter.baseUrl');

  const model = normalizeOpenRouterModel(normalizeNonEmptyString(candidate.model) ?? fallback.model);
  if (!model) {
    throw new AgentConfigValidationError('providers.openrouter.model must not be empty.');
  }

  const apiKeySource = normalizeOpenRouterApiKeySource(candidate.apiKeySource, fallback.apiKeySource);

  return {
    enabled,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKeySource,
  };
}

function normalizeDoctorConfig(
  value: unknown,
  fallback: AgentRuntimeConfig['doctor']
): AgentRuntimeConfig['doctor'] {
  if (value !== undefined && !isRecord(value)) {
    throw new AgentConfigValidationError('doctor must be an object.');
  }

  const candidate = isRecord(value) ? value : {};

  const enableLivePing =
    candidate.enableLivePing === undefined
      ? fallback.enableLivePing
      : typeof candidate.enableLivePing === 'boolean'
        ? candidate.enableLivePing
        : (() => {
            throw new AgentConfigValidationError('doctor.enableLivePing must be a boolean.');
          })();

  const timeoutMs = ensureFiniteNumber(candidate.timeoutMs, fallback.timeoutMs);
  if (timeoutMs < 500 || timeoutMs > 30_000) {
    throw new AgentConfigValidationError('doctor.timeoutMs must be between 500 and 30000.');
  }

  return { enableLivePing, timeoutMs };
}

function buildUserRef(updatedBy: string | undefined): string {
  const normalized = normalizeNonEmptyString(updatedBy);
  return normalized ?? 'system:unknown';
}

function normalizeIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return new Date(parsed).toISOString();
}

function normalizeRuntimeConfigInput(
  input: unknown,
  current: AgentRuntimeConfig,
  updatedBy: string
): AgentRuntimeConfig {
  if (input !== undefined && !isRecord(input)) {
    throw new AgentConfigValidationError('Config payload must be an object.');
  }

  const candidate = isRecord(input) ? input : {};

  if (candidate.version !== undefined && candidate.version !== 1) {
    throw new AgentConfigValidationError('Only config version 1 is supported.');
  }

  if (candidate.mainAgent !== undefined && !normalizeNonEmptyString(candidate.mainAgent)) {
    throw new AgentConfigValidationError('mainAgent must be a non-empty string.');
  }

  const providersInput = isRecord(candidate.providers) ? candidate.providers : {};
  const providers: AgentRuntimeConfig['providers'] = {
    'codex-cli': normalizeCliProviderConfig(
      providersInput['codex-cli'],
      current.providers['codex-cli'],
      'codex',
      'codex-cli'
    ),
    'claude-cli': normalizeCliProviderConfig(
      providersInput['claude-cli'],
      current.providers['claude-cli'],
      'claude',
      'claude-cli'
    ),
    'gemini-cli': normalizeCliProviderConfig(
      providersInput['gemini-cli'],
      current.providers['gemini-cli'],
      'gemini',
      'gemini-cli'
    ),
    openrouter: normalizeOpenRouterProviderConfig(providersInput.openrouter, current.providers.openrouter),
  };

  const providerInput = isRecord(candidate.provider) ? candidate.provider : {};
  const parsedProviderId = providerInput.id === undefined ? null : parseProviderId(providerInput.id);
  if (providerInput.id !== undefined && !parsedProviderId) {
    throw new AgentConfigValidationError('provider.id is invalid.');
  }
  const providerId = parsedProviderId ?? current.provider.id;
  const expectedKind = providerKindForId(providerId);
  if (providerInput.kind !== undefined && providerInput.kind !== expectedKind) {
    throw new AgentConfigValidationError(
      `provider.kind must be "${expectedKind}" for provider "${providerId}".`
    );
  }

  if (!providers[providerId].enabled) {
    throw new AgentConfigValidationError(`provider.id "${providerId}" is disabled in providers config.`);
  }

  const mainAgent = normalizeNonEmptyString(candidate.mainAgent) ?? current.mainAgent;
  const doctor = normalizeDoctorConfig(candidate.doctor, current.doctor);

  return {
    version: 1,
    mainAgent,
    provider: {
      id: providerId,
      kind: expectedKind,
    },
    providers,
    doctor,
    updatedAt: new Date().toISOString(),
    updatedBy: buildUserRef(updatedBy),
  };
}

function maskSecretLast4(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

async function ensureStorageDirectory(): Promise<void> {
  await fs.mkdir(AGENT_STORAGE_DIR, { recursive: true });
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
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

function normalizePersistedConfig(input: unknown): AgentRuntimeConfig {
  if (!isRecord(input)) {
    throw new AgentConfigValidationError('Runtime config file must contain a JSON object.');
  }

  const defaultConfig = createDefaultAgentRuntimeConfig('system:bootstrap');
  const persistedBy = buildUserRef(typeof input.updatedBy === 'string' ? input.updatedBy : undefined);
  const normalized = normalizeRuntimeConfigInput(input, defaultConfig, persistedBy);
  return {
    ...normalized,
    updatedAt: normalizeIsoTimestamp(input.updatedAt, defaultConfig.updatedAt),
    updatedBy: persistedBy,
  };
}

function firstCommandToken(command: string): string {
  return command.trim().split(/\s+/)[0] || '';
}

function checkCommandAvailability(command: string): boolean {
  const token = firstCommandToken(command);
  if (!token) {
    return false;
  }

  const result = spawnSync('which', [token], { stdio: 'ignore' });
  return result.status === 0;
}

async function readOpenRouterKeyFromIntegrations(): Promise<string | null> {
  const state = await readIntegrationsEnvState();
  const keyEntry = state.entries.find((entry) => entry.key === 'OPENROUTER_API_KEY');
  const value = keyEntry?.value?.trim() || '';
  return value || null;
}

export function createDefaultAgentRuntimeConfig(updatedBy: string = 'system:bootstrap'): AgentRuntimeConfig {
  return {
    version: 1,
    mainAgent: DEFAULT_MAIN_AGENT,
    provider: {
      id: 'codex-cli',
      kind: 'cli',
    },
    providers: {
      'codex-cli': {
        enabled: true,
        command: process.env.CODEX_CLI_COMMAND?.trim() || 'codex',
      },
      'claude-cli': {
        enabled: true,
        command: process.env.CLAUDE_CLI_COMMAND?.trim() || 'claude',
      },
      'gemini-cli': {
        enabled: true,
        command: process.env.GEMINI_CLI_COMMAND?.trim() || 'gemini',
      },
      openrouter: {
        enabled: true,
        baseUrl: process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL,
        model: normalizeOpenRouterModel(process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL),
        apiKeySource: 'integrations-env',
      },
    },
    doctor: {
      enableLivePing: true,
      timeoutMs: DEFAULT_DOCTOR_TIMEOUT_MS,
    },
    updatedAt: new Date().toISOString(),
    updatedBy: buildUserRef(updatedBy),
  };
}

export function providerIdToAgentId(providerId: AgentProviderId): AgentId {
  return providerIdToAgentIdMap[providerId];
}

export function agentIdToProviderId(agentId: AgentId): AgentProviderId {
  return agentIdToProviderIdMap[agentId];
}

export function isManagedAgentFileName(fileName: unknown): fileName is AgentManagedFileName {
  return typeof fileName === 'string' && AGENT_MANAGED_FILE_NAMES.includes(fileName as AgentManagedFileName);
}

export function isPlausibleOpenRouterModel(model: string): boolean {
  const normalized = model.trim();
  return /^[^/\s]+\/[^/\s]+$/.test(normalized);
}

export async function ensureAgentRuntimeConfigExists(updatedBy: string = 'system:bootstrap'): Promise<void> {
  await ensureStorageDirectory();
  const currentContent = await readFileIfExists(AGENT_RUNTIME_CONFIG_PATH);
  if (currentContent !== null) {
    return;
  }
  await writeJsonAtomic(AGENT_RUNTIME_CONFIG_PATH, createDefaultAgentRuntimeConfig(updatedBy));
}

export async function readAgentRuntimeConfig(): Promise<AgentRuntimeConfig> {
  await ensureAgentRuntimeConfigExists();
  const rawContent = await fs.readFile(AGENT_RUNTIME_CONFIG_PATH, 'utf8');

  try {
    const parsed = JSON.parse(rawContent);
    return normalizePersistedConfig(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid runtime config JSON.';
    throw new AgentConfigValidationError(`Failed to read runtime config: ${message}`);
  }
}

export async function writeAgentRuntimeConfig(input: unknown, updatedBy: string): Promise<AgentRuntimeConfig> {
  const current = await readAgentRuntimeConfig();
  const normalized = normalizeRuntimeConfigInput(input, current, updatedBy);
  await writeJsonAtomic(AGENT_RUNTIME_CONFIG_PATH, normalized);
  return normalized;
}

export function sanitizeAgentRuntimeConfig(config: AgentRuntimeConfig): AgentRuntimeConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      openrouter: {
        ...config.providers.openrouter,
      },
    },
  };
}

export async function resolveOpenRouterApiKey(config: AgentRuntimeConfig): Promise<OpenRouterApiKeyResolution> {
  const warnings: string[] = [];
  const hinted = config.providers.openrouter.apiKeySource;
  const orderedSources = Array.from(new Set<OpenRouterApiKeySource>([hinted, 'integrations-env', 'process-env']));

  for (const source of orderedSources) {
    if (source === 'integrations-env') {
      try {
        const fromIntegration = await readOpenRouterKeyFromIntegrations();
        if (fromIntegration) {
          return {
            apiKey: fromIntegration,
            isSet: true,
            source,
            last4: maskSecretLast4(fromIntegration),
            warnings,
          };
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to read integrations environment file.';
        warnings.push(message);
      }
      continue;
    }

    const fromProcessEnv = process.env.OPENROUTER_API_KEY?.trim() || '';
    if (fromProcessEnv) {
      return {
        apiKey: fromProcessEnv,
        isSet: true,
        source,
        last4: maskSecretLast4(fromProcessEnv),
        warnings,
      };
    }
  }

  return {
    apiKey: null,
    isSet: false,
    source: null,
    last4: null,
    warnings,
  };
}

export async function buildAgentConfigReadiness(config: AgentRuntimeConfig): Promise<AgentConfigReadiness> {
  const openRouterKey = await resolveOpenRouterApiKey(config);

  const codexAvailable = checkCommandAvailability(config.providers['codex-cli'].command);
  const claudeAvailable = checkCommandAvailability(config.providers['claude-cli'].command);
  const geminiAvailable = checkCommandAvailability(config.providers['gemini-cli'].command);
  const openRouterModelPlausible = isPlausibleOpenRouterModel(config.providers.openrouter.model);

  const providers: Record<AgentProviderId, ProviderReadiness> = {
    'codex-cli': {
      id: 'codex-cli',
      kind: 'cli',
      enabled: config.providers['codex-cli'].enabled,
      available: config.providers['codex-cli'].enabled && codexAvailable,
      issues: [],
      command: config.providers['codex-cli'].command,
      commandExists: codexAvailable,
    },
    'claude-cli': {
      id: 'claude-cli',
      kind: 'cli',
      enabled: config.providers['claude-cli'].enabled,
      available: config.providers['claude-cli'].enabled && claudeAvailable,
      issues: [],
      command: config.providers['claude-cli'].command,
      commandExists: claudeAvailable,
    },
    'gemini-cli': {
      id: 'gemini-cli',
      kind: 'cli',
      enabled: config.providers['gemini-cli'].enabled,
      available: config.providers['gemini-cli'].enabled && geminiAvailable,
      issues: [],
      command: config.providers['gemini-cli'].command,
      commandExists: geminiAvailable,
    },
    openrouter: {
      id: 'openrouter',
      kind: 'openrouter',
      enabled: config.providers.openrouter.enabled,
      available: config.providers.openrouter.enabled && openRouterKey.isSet && openRouterModelPlausible,
      issues: [],
      baseUrl: config.providers.openrouter.baseUrl,
      model: config.providers.openrouter.model,
      modelPlausible: openRouterModelPlausible,
      openRouterKeySet: openRouterKey.isSet,
    },
  };

  if (!codexAvailable) {
    providers['codex-cli'].issues.push('CLI command not available in PATH.');
  }
  if (!claudeAvailable) {
    providers['claude-cli'].issues.push('CLI command not available in PATH.');
  }
  if (!geminiAvailable) {
    providers['gemini-cli'].issues.push('CLI command not available in PATH.');
  }
  if (!openRouterModelPlausible) {
    providers.openrouter.issues.push('Model string is not plausible.');
  }
  if (!openRouterKey.isSet) {
    providers.openrouter.issues.push('OpenRouter API key is missing.');
  }
  if (openRouterKey.warnings.length > 0) {
    providers.openrouter.issues.push(...openRouterKey.warnings);
  }

  return {
    activeProviderId: config.provider.id,
    activeProviderReady: providers[config.provider.id].available,
    openRouterKey: {
      isSet: openRouterKey.isSet,
      source: openRouterKey.source,
      last4: openRouterKey.last4,
      warnings: openRouterKey.warnings,
    },
    providers,
  };
}
