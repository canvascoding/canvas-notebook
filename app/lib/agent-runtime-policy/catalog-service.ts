import 'server-only';

import { createHash } from 'node:crypto';

import {
  CatalogRevisionConflictError,
  readAppRuntimeCatalog,
  replaceAppRuntimeCatalogStore,
  type CatalogStoreProviderInput,
} from '@/app/lib/agent-runtime-policy/catalog-store';
import { validateProviderCatalogAuth } from '@/app/lib/agent-runtime-policy/provider-auth-policy';
import type {
  AiAppRuntimeCatalog,
  AiCatalogDiscovery,
  AiCatalogProviderUpdate,
  AiCatalogUpdate,
  AiCredentialScope,
  AiProviderSafeConfig,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';
import { AI_CREDENTIAL_SCOPES, AI_THINKING_LEVELS } from '@/app/lib/agent-runtime-policy/types';
import { CANVAS_CONTROL_PLANE_PROVIDER_ID } from '@/app/lib/managed/control-plane-models';
import type { PiThinkingLevel } from '@/app/lib/pi/config';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/u;
const INSTALLATION_ID_PATTERN = /^aip_[a-f0-9]{24}$/u;
const MAX_PROVIDERS = 64;
const MAX_MODELS_PER_PROVIDER = 512;
const SECRET_FIELD_PATTERN = /(secret|token|password|credential|authorization|cookie|api[_-]?key)/iu;
const SAFE_CONFIG_KEYS = new Set<keyof AiProviderSafeConfig>([
  'authMethod',
  'ollamaMode',
  'ollamaHost',
  'ollamaModelSource',
  'ollamaCustomModel',
  'ollamaAdditionalModels',
  'openaiCompatibleBaseUrl',
  'openaiCompatibleModelSource',
  'openaiCompatibleCustomModel',
]);

export class AiCatalogValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'AiCatalogValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], scope: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (allowedSet.has(key)) continue;
    throw new AiCatalogValidationError(
      SECRET_FIELD_PATTERN.test(key) ? 'SECRET_VALUE_NOT_ALLOWED' : 'INVALID_CATALOG_INPUT',
      SECRET_FIELD_PATTERN.test(key)
        ? 'Secret values are not allowed in the runtime catalog.'
        : `Unsupported ${scope} field: ${key}`,
    );
  }
}

function requiredString(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== 'string') {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', `${field} must be a string.`);
  }
  const normalized = value.trim();
  if (!pattern.test(normalized)) {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', `${field} is invalid.`);
  }
  return normalized;
}

function optionalInstallationId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, 'providerInstallationId', INSTALLATION_ID_PATTERN);
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', `${field} must be a boolean.`);
  }
  return value;
}

function thinkingLevel(value: unknown, field: string): PiThinkingLevel {
  if (typeof value !== 'string' || !AI_THINKING_LEVELS.includes(value as PiThinkingLevel)) {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', `${field} is invalid.`);
  }
  return value as PiThinkingLevel;
}

function endpoint(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new AiCatalogValidationError('INVALID_PROVIDER_CONFIG', `${field} must be a valid URL.`);
  }
  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('unsafe URL');
    }
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    throw new AiCatalogValidationError(
      'INVALID_PROVIDER_CONFIG',
      `${field} must be an HTTP(S) URL without credentials, query parameters, or fragments.`,
    );
  }
}

function customModel(value: unknown, field: string): string {
  return requiredString(value, field, MODEL_ID_PATTERN);
}

function customModels(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_MODELS_PER_PROVIDER) {
    throw new AiCatalogValidationError(
      'INVALID_PROVIDER_CONFIG',
      `${field} must be an array within the supported limit.`,
    );
  }
  return Array.from(new Set(value.map((entry) => customModel(entry, field))));
}

function parseSafeConfig(value: unknown): AiProviderSafeConfig {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new AiCatalogValidationError('INVALID_PROVIDER_CONFIG', 'Provider config must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!SAFE_CONFIG_KEYS.has(key as keyof AiProviderSafeConfig)) {
      const secretLike = SECRET_FIELD_PATTERN.test(key);
      throw new AiCatalogValidationError(
        secretLike ? 'SECRET_VALUE_NOT_ALLOWED' : 'INVALID_PROVIDER_CONFIG',
        secretLike ? 'Secret values are not allowed in the runtime catalog.' : `Unsupported provider config field: ${key}`,
      );
    }
  }

  const config: AiProviderSafeConfig = {};
  if (value.authMethod !== undefined) {
    if (value.authMethod !== 'api-key' && value.authMethod !== 'oauth') {
      throw new AiCatalogValidationError('INVALID_PROVIDER_CONFIG', 'authMethod is invalid.');
    }
    config.authMethod = value.authMethod;
  }
  if (value.ollamaMode !== undefined) {
    if (value.ollamaMode !== 'local' && value.ollamaMode !== 'cloud') {
      throw new AiCatalogValidationError('INVALID_PROVIDER_CONFIG', 'ollamaMode is invalid.');
    }
    config.ollamaMode = value.ollamaMode;
  }
  if (value.ollamaHost !== undefined) config.ollamaHost = endpoint(value.ollamaHost, 'ollamaHost');
  if (value.ollamaModelSource !== undefined) {
    if (value.ollamaModelSource !== 'predefined' && value.ollamaModelSource !== 'custom') {
      throw new AiCatalogValidationError('INVALID_PROVIDER_CONFIG', 'ollamaModelSource is invalid.');
    }
    config.ollamaModelSource = value.ollamaModelSource;
  }
  if (value.ollamaCustomModel !== undefined) config.ollamaCustomModel = customModel(value.ollamaCustomModel, 'ollamaCustomModel');
  if (value.ollamaAdditionalModels !== undefined) {
    config.ollamaAdditionalModels = customModels(value.ollamaAdditionalModels, 'ollamaAdditionalModels');
  }
  if (value.openaiCompatibleBaseUrl !== undefined) {
    config.openaiCompatibleBaseUrl = endpoint(value.openaiCompatibleBaseUrl, 'openaiCompatibleBaseUrl');
  }
  if (value.openaiCompatibleModelSource !== undefined) {
    if (value.openaiCompatibleModelSource !== 'predefined' && value.openaiCompatibleModelSource !== 'custom') {
      throw new AiCatalogValidationError('INVALID_PROVIDER_CONFIG', 'openaiCompatibleModelSource is invalid.');
    }
    config.openaiCompatibleModelSource = value.openaiCompatibleModelSource;
  }
  if (value.openaiCompatibleCustomModel !== undefined) {
    config.openaiCompatibleCustomModel = customModel(value.openaiCompatibleCustomModel, 'openaiCompatibleCustomModel');
  }
  return config;
}

function parseCredentialScope(value: unknown): AiCredentialScope {
  if (typeof value !== 'string' || !AI_CREDENTIAL_SCOPES.includes(value as AiCredentialScope)) {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', 'credentialScope is invalid.');
  }
  return value as AiCredentialScope;
}

function parseProviderUpdate(value: unknown): AiCatalogProviderUpdate {
  if (!isRecord(value)) {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', 'Each provider must be an object.');
  }
  assertAllowedKeys(
    value,
    ['providerInstallationId', 'providerId', 'enabled', 'credentialScope', 'config', 'modelIds', 'defaultModelId'],
    'provider',
  );
  if (!Array.isArray(value.modelIds) || value.modelIds.length > MAX_MODELS_PER_PROVIDER) {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', 'modelIds must be an array within the supported limit.');
  }
  const modelIds = Array.from(new Set(value.modelIds.map((modelId) => requiredString(modelId, 'modelId', MODEL_ID_PATTERN))));
  const defaultModelId = value.defaultModelId === '' || value.defaultModelId === null || value.defaultModelId === undefined
    ? ''
    : requiredString(value.defaultModelId, 'defaultModelId', MODEL_ID_PATTERN);
  return {
    providerInstallationId: optionalInstallationId(value.providerInstallationId),
    providerId: requiredString(value.providerId, 'providerId', PROVIDER_ID_PATTERN),
    enabled: booleanField(value.enabled, 'enabled'),
    credentialScope: parseCredentialScope(value.credentialScope),
    config: parseSafeConfig(value.config),
    modelIds,
    defaultModelId,
  };
}

function parseSelection(value: unknown): AiRuntimeSelection | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', 'defaultSelection must be an object or null.');
  }
  assertAllowedKeys(value, ['providerInstallationId', 'providerId', 'modelId', 'thinkingLevel'], 'defaultSelection');
  return {
    providerInstallationId: optionalInstallationId(value.providerInstallationId) || '',
    providerId: requiredString(value.providerId, 'defaultSelection.providerId', PROVIDER_ID_PATTERN),
    modelId: requiredString(value.modelId, 'defaultSelection.modelId', MODEL_ID_PATTERN),
    thinkingLevel: thinkingLevel(value.thinkingLevel, 'defaultSelection.thinkingLevel'),
  };
}

export function parseAiCatalogUpdate(value: unknown): AiCatalogUpdate {
  if (!isRecord(value)) {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', 'Catalog update must be an object.');
  }
  assertAllowedKeys(value, ['expectedRevision', 'providers', 'defaultSelection'], 'catalog');
  if (typeof value.expectedRevision !== 'number' || !Number.isInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', 'expectedRevision must be a non-negative integer.');
  }
  if (!Array.isArray(value.providers) || value.providers.length > MAX_PROVIDERS) {
    throw new AiCatalogValidationError('INVALID_CATALOG_INPUT', 'providers must be an array within the supported limit.');
  }
  return {
    expectedRevision: Number(value.expectedRevision),
    providers: value.providers.map(parseProviderUpdate),
    defaultSelection: parseSelection(value.defaultSelection),
  };
}

export function aiProviderInstallationId(
  organizationId: string,
  providerId: string,
  credentialScope: AiCredentialScope,
): string {
  const digest = createHash('sha256')
    .update(`${organizationId}\0${providerId}\0${credentialScope}`)
    .digest('hex')
    .slice(0, 24);
  return `aip_${digest}`;
}

function modelThinkingLevels(model: AiCatalogDiscovery[string]['models'][number]): PiThinkingLevel[] {
  if (model.thinkingLevels) return [...model.thinkingLevels];
  return model.reasoning
    ? AI_THINKING_LEVELS.filter((level) => level !== 'xhigh' && level !== 'max')
    : ['off'];
}

function sameProviderConfiguration(previous: CatalogStoreProviderInput | undefined, next: CatalogStoreProviderInput): boolean {
  if (!previous) return false;
  const previousModels = previous.models.map((model) => `${model.id}:${model.isProviderDefault}`).sort();
  const nextModels = next.models.map((model) => `${model.id}:${model.isProviderDefault}`).sort();
  return previous.providerId === next.providerId
    && previous.credentialScope === next.credentialScope
    && previous.enabled === next.enabled
    && JSON.stringify(previous.config) === JSON.stringify(next.config)
    && JSON.stringify(previousModels) === JSON.stringify(nextModels);
}

function validateEnabledProviderConfig(provider: AiCatalogProviderUpdate): void {
  if (!provider.enabled) return;
  if (provider.providerId === 'openai-compatible') {
    if (!provider.config.openaiCompatibleBaseUrl) {
      throw new AiCatalogValidationError(
        'INVALID_PROVIDER_CONFIG',
        'An enabled OpenAI-compatible provider requires a base URL.',
      );
    }
    if (
      provider.config.openaiCompatibleModelSource !== 'custom'
      || !provider.config.openaiCompatibleCustomModel
    ) {
      throw new AiCatalogValidationError(
        'INVALID_PROVIDER_CONFIG',
        'An enabled OpenAI-compatible provider requires a custom model ID.',
      );
    }
  }
  if (provider.providerId === 'ollama') {
    if (provider.config.ollamaMode === 'cloud' && !provider.config.ollamaHost) {
      throw new AiCatalogValidationError(
        'INVALID_PROVIDER_CONFIG',
        'Remote Ollama mode requires a server URL.',
      );
    }
    if (
      provider.config.ollamaModelSource === 'custom'
      && !provider.config.ollamaCustomModel
    ) {
      throw new AiCatalogValidationError(
        'INVALID_PROVIDER_CONFIG',
        'A custom Ollama model source requires a custom model ID.',
      );
    }
  }
}

function validateProviderAuthPolicy(provider: AiCatalogProviderUpdate): void {
  const issue = validateProviderCatalogAuth(provider);
  if (issue === 'INVALID_PROVIDER_AUTH_METHOD') {
    throw new AiCatalogValidationError(
      issue,
      `Authentication method is not supported by provider ${provider.providerId}.`,
    );
  }
  if (issue === 'OAUTH_REQUIRES_USER_SCOPE') {
    throw new AiCatalogValidationError(
      'INVALID_CREDENTIAL_SCOPE',
      `OAuth provider ${provider.providerId} requires per-user credentials.`,
    );
  }
}

function materializeProviders(params: {
  organizationId: string;
  update: AiCatalogUpdate;
  discovery: AiCatalogDiscovery;
  previous: AiAppRuntimeCatalog;
  readyInstallationIds?: ReadonlySet<string>;
  sourceRevisionByInstallation?: ReadonlyMap<string, string>;
}): CatalogStoreProviderInput[] {
  const bindings = new Set<string>();
  const previousById = new Map(params.previous.providers.map((provider) => [provider.installationId, {
    ...provider,
    verifiedAt: provider.verifiedAt ? Date.parse(provider.verifiedAt) : null,
    lastSyncedAt: provider.lastSyncedAt ? Date.parse(provider.lastSyncedAt) : null,
  }]));

  return params.update.providers.map((provider) => {
    validateEnabledProviderConfig(provider);
    validateProviderAuthPolicy(provider);
    const discoveryProvider = params.discovery[provider.providerId];
    if (!discoveryProvider) {
      throw new AiCatalogValidationError('PROVIDER_NOT_AVAILABLE', `Provider is not available: ${provider.providerId}`);
    }
    if (provider.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID && provider.credentialScope !== 'managed') {
      throw new AiCatalogValidationError('INVALID_CREDENTIAL_SCOPE', 'Canvas Control Plane requires managed credentials.');
    }
    if (provider.providerId !== CANVAS_CONTROL_PLANE_PROVIDER_ID && provider.credentialScope === 'managed') {
      throw new AiCatalogValidationError('INVALID_CREDENTIAL_SCOPE', 'Managed credential scope is reserved for Canvas Control Plane.');
    }
    const bindingKey = `${provider.providerId}\0${provider.credentialScope}`;
    if (bindings.has(bindingKey)) {
      throw new AiCatalogValidationError('DUPLICATE_PROVIDER_BINDING', 'A provider credential binding may only appear once.');
    }
    bindings.add(bindingKey);
    const installationId = aiProviderInstallationId(
      params.organizationId,
      provider.providerId,
      provider.credentialScope,
    );
    if (provider.providerInstallationId && provider.providerInstallationId !== installationId) {
      throw new AiCatalogValidationError(
        'INVALID_PROVIDER_INSTALLATION',
        'Provider installation does not match its app and credential scope.',
      );
    }
    const discoveredModels = new Map(discoveryProvider.models.map((model) => [model.id, model]));
    if (provider.enabled && provider.modelIds.length === 0) {
      throw new AiCatalogValidationError('PROVIDER_HAS_NO_MODELS', `Enabled provider has no allowed models: ${provider.providerId}`);
    }
    if (provider.modelIds.length > 0 && !provider.modelIds.includes(provider.defaultModelId)) {
      throw new AiCatalogValidationError('INVALID_PROVIDER_DEFAULT', `Provider default is not in the model allowlist: ${provider.providerId}`);
    }
    const models = provider.modelIds.map((modelId) => {
      const model = discoveredModels.get(modelId);
      if (!model) {
        throw new AiCatalogValidationError('MODEL_NOT_AVAILABLE', `Model is not available for ${provider.providerId}: ${modelId}`);
      }
      return {
        id: model.id,
        name: model.name,
        enabled: true,
        isProviderDefault: model.id === provider.defaultModelId,
        reasoning: model.reasoning,
        supportsVision: model.supportsVision,
        thinkingLevels: modelThinkingLevels(model),
        metadata: {
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        },
        revision: params.update.expectedRevision + 1,
      };
    });
    const next: CatalogStoreProviderInput = {
      installationId,
      providerId: provider.providerId,
      name: discoveryProvider.name,
      source: discoveryProvider.source,
      credentialScope: provider.credentialScope,
      enabled: provider.enabled,
      status: provider.enabled
        ? (provider.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID
            || provider.credentialScope === 'user'
            || params.readyInstallationIds?.has(installationId)
            ? 'ready'
            : 'unverified')
        : 'disabled',
      config: provider.config,
      sourceRevision: params.sourceRevisionByInstallation?.get(installationId)
        ?? previousById.get(installationId)?.sourceRevision
        ?? null,
      lastSyncedAt: params.sourceRevisionByInstallation?.has(installationId)
        ? Date.now()
        : previousById.get(installationId)?.lastSyncedAt ?? null,
      revision: params.update.expectedRevision + 1,
      verifiedAt: (
        provider.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID
        || params.readyInstallationIds?.has(installationId)
      ) && provider.enabled ? Date.now() : null,
      verifiedByUserId: null,
      models,
    };
    const previous = previousById.get(installationId);
    if (
      sameProviderConfiguration(previous, next)
      && previous
      && !params.readyInstallationIds?.has(installationId)
      && !params.sourceRevisionByInstallation?.has(installationId)
    ) {
      next.status = previous.status;
      next.verifiedAt = previous.verifiedAt;
      next.verifiedByUserId = previous.verifiedByUserId;
    }
    return next;
  });
}

function resolveDefaultSelection(
  selection: AiRuntimeSelection | null,
  providers: CatalogStoreProviderInput[],
): AiRuntimeSelection | null {
  if (!selection) return null;
  const candidates = providers.filter((provider) => (
    provider.providerId === selection.providerId
    && provider.enabled
    && (!selection.providerInstallationId || provider.installationId === selection.providerInstallationId)
  ));
  if (candidates.length !== 1) {
    throw new AiCatalogValidationError('INVALID_APP_DEFAULT', 'App default provider installation is missing or ambiguous.');
  }
  const provider = candidates[0];
  const model = provider.models.find((candidate) => candidate.id === selection.modelId && candidate.enabled);
  if (!model) {
    throw new AiCatalogValidationError('INVALID_APP_DEFAULT', 'App default model is not allowed.');
  }
  if (!model.thinkingLevels.includes(selection.thinkingLevel)) {
    throw new AiCatalogValidationError('INVALID_APP_DEFAULT', 'App default intelligence is not supported by the selected model.');
  }
  return {
    ...selection,
    providerInstallationId: provider.installationId,
  };
}

export async function replaceAiAppRuntimeCatalog(params: {
  organizationId: string;
  actorUserId: string;
  update: AiCatalogUpdate;
  discovery: AiCatalogDiscovery;
  migrationState?: AiAppRuntimeCatalog['migrationState'];
  legacySourceHash?: string | null;
  readyInstallationIds?: ReadonlySet<string>;
  sourceRevisionByInstallation?: ReadonlyMap<string, string>;
}): Promise<AiAppRuntimeCatalog> {
  const previous = await readAppRuntimeCatalog(params.organizationId);
  const providers = materializeProviders({
    organizationId: params.organizationId,
    update: params.update,
    discovery: params.discovery,
    previous,
    readyInstallationIds: params.readyInstallationIds,
    sourceRevisionByInstallation: params.sourceRevisionByInstallation,
  });
  const defaultSelection = resolveDefaultSelection(params.update.defaultSelection, providers);
  await replaceAppRuntimeCatalogStore({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    expectedRevision: params.update.expectedRevision,
    migrationState: params.migrationState ?? (defaultSelection ? 'configured' : 'uninitialized'),
    defaultSelection,
    providers,
    legacySourceHash: params.legacySourceHash,
  });
  return readAppRuntimeCatalog(params.organizationId);
}

export function catalogErrorResponse(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof CatalogRevisionConflictError || error instanceof AiCatalogValidationError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return { status: 500, code: 'CATALOG_UPDATE_FAILED', message: 'Failed to update the AI runtime catalog.' };
}
