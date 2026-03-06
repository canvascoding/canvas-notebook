import 'server-only';

import path from 'path';
import { promises as fs } from 'fs';
import { spawnSync } from 'child_process';

import { readIntegrationsEnvState, replaceIntegrationsEntries } from '@/app/lib/integrations/env-config';
import { type AgentId } from './catalog';

export const AGENT_STORAGE_DIR = '/home/node/canvas-agent';
export const AGENT_RUNTIME_CONFIG_FILE = 'agent-runtime-config.json';
export const AGENT_RUNTIME_CONFIG_PATH = path.join(AGENT_STORAGE_DIR, AGENT_RUNTIME_CONFIG_FILE);
export const AGENT_MANAGED_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;

const DEFAULT_MAIN_AGENT = 'canvas-main-agent';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2:3b';
const DEFAULT_DOCTOR_TIMEOUT_MS = 2500;
const DEFAULT_AGENT_FILE_TEMPLATES: Record<AgentManagedFileName, string> = {
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

- Preferred tools and execution constraints for the main agent.
`,
};

const AGENT_SETTINGS_ENV_KEYS = {
  mainAgent: 'AGENT_MAIN_AGENT',
  providerId: 'AGENT_PROVIDER_ID',
  codexEnabled: 'AGENT_CODEX_CLI_ENABLED',
  codexCommand: 'AGENT_CODEX_CLI_COMMAND',
  claudeEnabled: 'AGENT_CLAUDE_CLI_ENABLED',
  claudeCommand: 'AGENT_CLAUDE_CLI_COMMAND',
  openRouterEnabled: 'AGENT_OPENROUTER_ENABLED',
  openRouterBaseUrl: 'AGENT_OPENROUTER_BASE_URL',
  openRouterModel: 'AGENT_OPENROUTER_MODEL',
  ollamaEnabled: 'AGENT_OLLAMA_ENABLED',
  ollamaBaseUrl: 'AGENT_OLLAMA_BASE_URL',
  ollamaModel: 'AGENT_OLLAMA_MODEL',
  doctorEnableLivePing: 'AGENT_DOCTOR_ENABLE_LIVE_PING',
  doctorTimeoutMs: 'AGENT_DOCTOR_TIMEOUT_MS',
} as const;

const LEGACY_AGENT_SETTINGS_ENV_KEYS = ['AGENT_OPENROUTER_API_KEY_SOURCE', 'AGENT_OLLAMA_API_KEY_SOURCE'] as const;
const AGENT_SETTINGS_ENV_KEY_SET = new Set<string>([
  ...Object.values(AGENT_SETTINGS_ENV_KEYS),
  ...LEGACY_AGENT_SETTINGS_ENV_KEYS,
]);

type RecordLike = Record<string, unknown>;

export type AgentManagedFileName = (typeof AGENT_MANAGED_FILE_NAMES)[number];
export type AgentProviderId = 'codex-cli' | 'claude-cli' | 'openrouter' | 'ollama';
export type AgentProviderKind = 'cli' | 'openrouter' | 'ollama';
export type OpenRouterApiKeySource = 'integrations-env';
export type OllamaApiKeySource = 'integrations-env';

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

export type OllamaProviderConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeySource: OllamaApiKeySource;
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
    openrouter: OpenRouterProviderConfig;
    ollama: OllamaProviderConfig;
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

export type OllamaApiKeyResolution = {
  apiKey: string | null;
  isSet: boolean;
  source: OllamaApiKeySource | null;
  last4: string | null;
  warnings: string[];
};

export type AgentManagedFiles = Record<AgentManagedFileName, string>;

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
  ollamaKeySet?: boolean;
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
  gemini: 'codex-cli',
  'gemini-cli': 'codex-cli',
  openrouter: 'openrouter',
  ollama: 'ollama',
};

const providerIdToAgentIdMap: Record<AgentProviderId, AgentId> = {
  'codex-cli': 'codex',
  'claude-cli': 'claude',
  openrouter: 'openrouter',
  ollama: 'ollama',
};

const agentIdToProviderIdMap: Record<AgentId, AgentProviderId> = {
  codex: 'codex-cli',
  claude: 'claude-cli',
  openrouter: 'openrouter',
  ollama: 'ollama',
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

export function resolveOllamaApiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/i, '');
}

function normalizeOllamaModel(model: string): string {
  const normalized = model.trim();
  if (!normalized) {
    return DEFAULT_OLLAMA_MODEL;
  }
  if (normalized.startsWith('ollama/')) {
    return normalized.slice('ollama/'.length);
  }
  return normalized;
}

function providerKindForId(id: AgentProviderId): AgentProviderKind {
  if (id === 'openrouter') {
    return 'openrouter';
  }
  if (id === 'ollama') {
    return 'ollama';
  }
  return 'cli';
}

function parseProviderId(value: unknown): AgentProviderId | null {
  if (!isProviderAlias(value)) {
    return null;
  }

  return providerAliases[value];
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

  const apiKeySource: OpenRouterApiKeySource = 'integrations-env';

  return {
    enabled,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKeySource,
  };
}

function normalizeOllamaProviderConfig(
  value: unknown,
  fallback: OllamaProviderConfig
): OllamaProviderConfig {
  if (value !== undefined && !isRecord(value)) {
    throw new AgentConfigValidationError('providers.ollama must be an object.');
  }

  const candidate = isRecord(value) ? value : {};

  const enabled =
    candidate.enabled === undefined
      ? fallback.enabled
      : typeof candidate.enabled === 'boolean'
        ? candidate.enabled
        : (() => {
            throw new AgentConfigValidationError('providers.ollama.enabled must be a boolean.');
          })();

  const baseUrl = normalizeNonEmptyString(candidate.baseUrl) ?? fallback.baseUrl;
  assertValidUrl(baseUrl, 'providers.ollama.baseUrl');

  const model = normalizeOllamaModel(normalizeNonEmptyString(candidate.model) ?? fallback.model);
  if (!model) {
    throw new AgentConfigValidationError('providers.ollama.model must not be empty.');
  }

  const apiKeySource: OllamaApiKeySource = 'integrations-env';

  return {
    enabled,
    baseUrl: resolveOllamaApiBase(baseUrl),
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
    openrouter: normalizeOpenRouterProviderConfig(providersInput.openrouter, current.providers.openrouter),
    ollama: normalizeOllamaProviderConfig(providersInput.ollama, current.providers.ollama),
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

function resolveManagedFilePath(fileName: AgentManagedFileName): string {
  return path.join(AGENT_STORAGE_DIR, fileName);
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

function toEnvBoolean(value: boolean): string {
  return value ? 'true' : 'false';
}

function parseEnvBoolean(value: string | undefined): boolean | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return null;
}

function parseEnvInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapIntegrationsEntries(entries: Array<{ key: string; value: string }>): Map<string, string> {
  return new Map(entries.map((entry) => [entry.key, entry.value]));
}

function buildAgentSettingsEnvEntries(config: AgentRuntimeConfig): Array<{ key: string; value: string }> {
  return [
    { key: AGENT_SETTINGS_ENV_KEYS.mainAgent, value: config.mainAgent },
    { key: AGENT_SETTINGS_ENV_KEYS.providerId, value: config.provider.id },
    { key: AGENT_SETTINGS_ENV_KEYS.codexEnabled, value: toEnvBoolean(config.providers['codex-cli'].enabled) },
    { key: AGENT_SETTINGS_ENV_KEYS.codexCommand, value: config.providers['codex-cli'].command },
    { key: AGENT_SETTINGS_ENV_KEYS.claudeEnabled, value: toEnvBoolean(config.providers['claude-cli'].enabled) },
    { key: AGENT_SETTINGS_ENV_KEYS.claudeCommand, value: config.providers['claude-cli'].command },
    { key: AGENT_SETTINGS_ENV_KEYS.openRouterEnabled, value: toEnvBoolean(config.providers.openrouter.enabled) },
    { key: AGENT_SETTINGS_ENV_KEYS.openRouterBaseUrl, value: config.providers.openrouter.baseUrl },
    { key: AGENT_SETTINGS_ENV_KEYS.openRouterModel, value: config.providers.openrouter.model },
    { key: AGENT_SETTINGS_ENV_KEYS.ollamaEnabled, value: toEnvBoolean(config.providers.ollama.enabled) },
    { key: AGENT_SETTINGS_ENV_KEYS.ollamaBaseUrl, value: config.providers.ollama.baseUrl },
    { key: AGENT_SETTINGS_ENV_KEYS.ollamaModel, value: config.providers.ollama.model },
    { key: AGENT_SETTINGS_ENV_KEYS.doctorEnableLivePing, value: toEnvBoolean(config.doctor.enableLivePing) },
    { key: AGENT_SETTINGS_ENV_KEYS.doctorTimeoutMs, value: String(config.doctor.timeoutMs) },
  ];
}

async function syncAgentSettingsToIntegrationsEnv(config: AgentRuntimeConfig): Promise<void> {
  const state = await readIntegrationsEnvState();
  const retainedEntries = state.entries
    .filter((entry) => entry.key && !AGENT_SETTINGS_ENV_KEY_SET.has(entry.key))
    .map((entry) => ({
      key: entry.key,
      value: entry.value,
    }));

  const merged = [...retainedEntries, ...buildAgentSettingsEnvEntries(config)];
  await replaceIntegrationsEntries(merged);
}

async function applyAgentSettingsFromIntegrationsEnv(config: AgentRuntimeConfig): Promise<AgentRuntimeConfig> {
  const state = await readIntegrationsEnvState();
  const envMap = mapIntegrationsEntries(state.entries);

  const providersInput: RecordLike = {};
  const codexInput: RecordLike = {};
  const claudeInput: RecordLike = {};
  const openRouterInput: RecordLike = {};
  const ollamaInput: RecordLike = {};
  const doctorInput: RecordLike = {};
  const candidate: RecordLike = {};

  const mainAgent = normalizeNonEmptyString(envMap.get(AGENT_SETTINGS_ENV_KEYS.mainAgent));
  if (mainAgent) {
    candidate.mainAgent = mainAgent;
  }

  const providerId = parseProviderId(envMap.get(AGENT_SETTINGS_ENV_KEYS.providerId));
  if (providerId) {
    candidate.provider = { id: providerId };
  }

  const codexEnabled = parseEnvBoolean(envMap.get(AGENT_SETTINGS_ENV_KEYS.codexEnabled));
  if (codexEnabled !== null) {
    codexInput.enabled = codexEnabled;
  }
  const codexCommand = normalizeNonEmptyString(envMap.get(AGENT_SETTINGS_ENV_KEYS.codexCommand));
  if (codexCommand) {
    codexInput.command = codexCommand;
  }
  if (Object.keys(codexInput).length > 0) {
    providersInput['codex-cli'] = codexInput;
  }

  const claudeEnabled = parseEnvBoolean(envMap.get(AGENT_SETTINGS_ENV_KEYS.claudeEnabled));
  if (claudeEnabled !== null) {
    claudeInput.enabled = claudeEnabled;
  }
  const claudeCommand = normalizeNonEmptyString(envMap.get(AGENT_SETTINGS_ENV_KEYS.claudeCommand));
  if (claudeCommand) {
    claudeInput.command = claudeCommand;
  }
  if (Object.keys(claudeInput).length > 0) {
    providersInput['claude-cli'] = claudeInput;
  }

  const openRouterEnabled = parseEnvBoolean(envMap.get(AGENT_SETTINGS_ENV_KEYS.openRouterEnabled));
  if (openRouterEnabled !== null) {
    openRouterInput.enabled = openRouterEnabled;
  }
  const openRouterBaseUrl = normalizeNonEmptyString(envMap.get(AGENT_SETTINGS_ENV_KEYS.openRouterBaseUrl));
  if (openRouterBaseUrl) {
    openRouterInput.baseUrl = openRouterBaseUrl;
  }
  const openRouterModel = normalizeNonEmptyString(envMap.get(AGENT_SETTINGS_ENV_KEYS.openRouterModel));
  if (openRouterModel) {
    openRouterInput.model = openRouterModel;
  }
  if (Object.keys(openRouterInput).length > 0) {
    providersInput.openrouter = openRouterInput;
  }

  const ollamaEnabled = parseEnvBoolean(envMap.get(AGENT_SETTINGS_ENV_KEYS.ollamaEnabled));
  if (ollamaEnabled !== null) {
    ollamaInput.enabled = ollamaEnabled;
  }
  const ollamaBaseUrl = normalizeNonEmptyString(envMap.get(AGENT_SETTINGS_ENV_KEYS.ollamaBaseUrl));
  if (ollamaBaseUrl) {
    ollamaInput.baseUrl = ollamaBaseUrl;
  }
  const ollamaModel = normalizeNonEmptyString(envMap.get(AGENT_SETTINGS_ENV_KEYS.ollamaModel));
  if (ollamaModel) {
    ollamaInput.model = ollamaModel;
  }
  if (Object.keys(ollamaInput).length > 0) {
    providersInput.ollama = ollamaInput;
  }

  if (Object.keys(providersInput).length > 0) {
    candidate.providers = providersInput;
  }

  const doctorEnableLivePing = parseEnvBoolean(envMap.get(AGENT_SETTINGS_ENV_KEYS.doctorEnableLivePing));
  if (doctorEnableLivePing !== null) {
    doctorInput.enableLivePing = doctorEnableLivePing;
  }
  const doctorTimeoutMs = parseEnvInteger(envMap.get(AGENT_SETTINGS_ENV_KEYS.doctorTimeoutMs));
  if (doctorTimeoutMs !== null) {
    doctorInput.timeoutMs = doctorTimeoutMs;
  }
  if (Object.keys(doctorInput).length > 0) {
    candidate.doctor = doctorInput;
  }

  if (Object.keys(candidate).length === 0) {
    return config;
  }

  const normalized = normalizeRuntimeConfigInput(candidate, config, config.updatedBy);
  return {
    ...normalized,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  };
}

async function readProviderKeyFromIntegrations(keyName: string): Promise<string | null> {
  const state = await readIntegrationsEnvState();
  const keyEntry = state.entries.find((entry) => entry.key === keyName);
  const value = keyEntry?.value?.trim() || '';
  return value || null;
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
  await fs.writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
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
        command: 'codex',
      },
      'claude-cli': {
        enabled: true,
        command: 'claude',
      },
      openrouter: {
        enabled: true,
        baseUrl: DEFAULT_OPENROUTER_BASE_URL,
        model: DEFAULT_OPENROUTER_MODEL,
        apiKeySource: 'integrations-env',
      },
      ollama: {
        enabled: true,
        baseUrl: DEFAULT_OLLAMA_BASE_URL,
        model: DEFAULT_OLLAMA_MODEL,
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

export function isPlausibleOllamaModel(model: string): boolean {
  const normalized = model.trim();
  return normalized.length > 0 && !/\s/.test(normalized);
}

export async function ensureAgentRuntimeConfigExists(updatedBy: string = 'system:bootstrap'): Promise<void> {
  await ensureStorageDirectory();
  const currentContent = await readFileIfExists(AGENT_RUNTIME_CONFIG_PATH);
  if (currentContent !== null) {
    return;
  }
  const defaults = createDefaultAgentRuntimeConfig(updatedBy);
  const hydrated = await applyAgentSettingsFromIntegrationsEnv(defaults);
  await writeJsonAtomic(AGENT_RUNTIME_CONFIG_PATH, hydrated);
  await syncAgentSettingsToIntegrationsEnv(hydrated);
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

export async function readAgentRuntimeConfig(): Promise<AgentRuntimeConfig> {
  await ensureAgentRuntimeConfigExists();
  const rawContent = await fs.readFile(AGENT_RUNTIME_CONFIG_PATH, 'utf8');

  try {
    const parsed = JSON.parse(rawContent);
    const normalized = normalizePersistedConfig(parsed);
    return applyAgentSettingsFromIntegrationsEnv(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid runtime config JSON.';
    throw new AgentConfigValidationError(`Failed to read runtime config: ${message}`);
  }
}

export async function writeAgentRuntimeConfig(input: unknown, updatedBy: string): Promise<AgentRuntimeConfig> {
  const current = await readAgentRuntimeConfig();
  const normalized = normalizeRuntimeConfigInput(input, current, updatedBy);
  await writeJsonAtomic(AGENT_RUNTIME_CONFIG_PATH, normalized);
  await syncAgentSettingsToIntegrationsEnv(normalized);
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
      ollama: {
        ...config.providers.ollama,
      },
    },
  };
}

export async function resolveOpenRouterApiKey(_config: AgentRuntimeConfig): Promise<OpenRouterApiKeyResolution> {
  void _config;
  const warnings: string[] = [];
  try {
    const fromIntegration = await readProviderKeyFromIntegrations('OPENROUTER_API_KEY');
    if (fromIntegration) {
      return {
        apiKey: fromIntegration,
        isSet: true,
        source: 'integrations-env',
        last4: maskSecretLast4(fromIntegration),
        warnings,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read integrations environment file.';
    warnings.push(message);
  }

  return {
    apiKey: null,
    isSet: false,
    source: null,
    last4: null,
    warnings,
  };
}

export async function resolveOllamaApiKey(_config: AgentRuntimeConfig): Promise<OllamaApiKeyResolution> {
  void _config;
  const warnings: string[] = [];

  try {
    const fromIntegration = await readProviderKeyFromIntegrations('OLLAMA_API_KEY');
    if (fromIntegration) {
      return {
        apiKey: fromIntegration,
        isSet: true,
        source: 'integrations-env',
        last4: maskSecretLast4(fromIntegration),
        warnings,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read integrations environment file.';
    warnings.push(message);
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
  const ollamaKey = await resolveOllamaApiKey(config);

  const codexAvailable = checkCommandAvailability(config.providers['codex-cli'].command);
  const claudeAvailable = checkCommandAvailability(config.providers['claude-cli'].command);
  const openRouterModelPlausible = isPlausibleOpenRouterModel(config.providers.openrouter.model);
  const ollamaModelPlausible = isPlausibleOllamaModel(config.providers.ollama.model);
  const ollamaKeyRequired = false;
  const ollamaKeyReady = !ollamaKeyRequired || ollamaKey.isSet;

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
    ollama: {
      id: 'ollama',
      kind: 'ollama',
      enabled: config.providers.ollama.enabled,
      available: config.providers.ollama.enabled && ollamaModelPlausible && ollamaKeyReady,
      issues: [],
      baseUrl: config.providers.ollama.baseUrl,
      model: config.providers.ollama.model,
      modelPlausible: ollamaModelPlausible,
      ollamaKeySet: ollamaKey.isSet,
    },
  };

  if (!codexAvailable) {
    providers['codex-cli'].issues.push('CLI command not available in PATH.');
  }
  if (!claudeAvailable) {
    providers['claude-cli'].issues.push('CLI command not available in PATH.');
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
  if (!ollamaModelPlausible) {
    providers.ollama.issues.push('Model string is not plausible.');
  }
  if (ollamaKeyRequired && !ollamaKey.isSet) {
    providers.ollama.issues.push('Ollama API key is missing.');
  }
  if (ollamaKey.warnings.length > 0) {
    providers.ollama.issues.push(...ollamaKey.warnings);
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
