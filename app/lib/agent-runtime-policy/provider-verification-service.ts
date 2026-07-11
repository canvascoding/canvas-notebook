import 'server-only';

import type { Api, Model } from '@earendil-works/pi-ai';

import {
  CatalogRevisionConflictError,
  ProviderVerificationStoreConflictError,
  readAppRuntimeCatalog,
  updateProviderVerificationStore,
} from '@/app/lib/agent-runtime-policy/catalog-store';
import type {
  AiCatalogModel,
  AiProviderInstallation,
  AiProviderStatus,
} from '@/app/lib/agent-runtime-policy/types';
import type { EffectiveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { testAgentModelConnection, type AgentModelTestCode } from '@/app/lib/agents/model-test';
import type { AgentProfile } from '@/app/lib/agents/registry';
import { readScopedEnvState, type EnvStorageScope } from '@/app/lib/integrations/env-config';
import { CANVAS_CONTROL_PLANE_PROVIDER_ID } from '@/app/lib/managed/control-plane-models';
import type { PiProviderConfig, PiRuntimeConfig } from '@/app/lib/pi/config';
import { getProviderApiKey, isOAuthProvider, type OAuthProviderId } from '@/app/lib/pi/oauth';
import { getAuthMethodForProvider, getProviderEnvVars } from '@/app/lib/pi/provider-help';
import { getPiModels, resolvePiModel } from '@/app/lib/pi/model-resolver';

const INSTALLATION_ID_PATTERN = /^aip_[a-f0-9]{24}$/u;
const SECRET_ENV_NAME_PATTERN = /(api[_-]?key|token|secret|password|credential)/iu;
const LOCAL_PROBE_CREDENTIAL = 'canvas-provider-verification';
const VERIFICATION_AGENT_ID = 'provider-verification';

type ProbeFailureCode = AgentModelTestCode | 'PROVIDER_MODEL_UNAVAILABLE' | 'CREDENTIAL_LOOKUP_FAILED';
type VerificationStatus = Extract<AiProviderStatus, 'ready' | 'degraded' | 'unverified'>;

type ProviderVerificationResultBase = {
  providerInstallationId: string;
  providerId: string;
  modelId: string;
  status: VerificationStatus;
  catalogRevision: number;
  providerRevision: number;
  verifiedAt: string | null;
  durationMs: number;
};

export type ProviderVerificationResult = ProviderVerificationResultBase & (
  | { success: true; code: 'PROVIDER_VERIFIED' }
  | { success: false; code: ProbeFailureCode }
);

export class ProviderVerificationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ProviderVerificationError';
  }
}

function storageScopeFor(input: {
  provider: AiProviderInstallation;
  organizationId: string;
  actorUserId: string;
}): EnvStorageScope | null {
  if (input.provider.credentialScope === 'user') {
    return { secretScope: 'user', userId: input.actorUserId };
  }
  if (input.provider.credentialScope === 'organization') {
    return { secretScope: 'organization', organizationId: input.organizationId };
  }
  // Existing app-wide provider credentials live in /data/secrets.
  return null;
}

function firstConfiguredValue(
  names: readonly string[],
  integrations: ReadonlyMap<string, string>,
  agents: ReadonlyMap<string, string>,
  includeProcessEnvironment: boolean,
): string | undefined {
  for (const name of names) {
    const value = integrations.get(name)?.trim()
      || agents.get(name)?.trim()
      || (includeProcessEnvironment ? process.env[name]?.trim() : undefined);
    if (value) return value;
  }
  return undefined;
}

async function resolveInstallationCredential(input: {
  provider: AiProviderInstallation;
  organizationId: string;
  actorUserId: string;
}): Promise<string | undefined> {
  const providerId = input.provider.providerId.toLowerCase();
  if (providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID) {
    return input.provider.credentialScope === 'managed'
      ? process.env.CANVAS_INSTANCE_TOKEN?.trim() || undefined
      : undefined;
  }

  const authMethod = getAuthMethodForProvider(providerId);
  const wantsOAuth = input.provider.config.authMethod === 'oauth'
    || (authMethod === 'oauth' && input.provider.config.authMethod !== 'api-key');
  if (wantsOAuth) {
    if (input.provider.credentialScope !== 'user' || !isOAuthProvider(providerId)) return undefined;
    return (await getProviderApiKey(providerId as OAuthProviderId, { userId: input.actorUserId }))?.apiKey;
  }

  const storageScope = storageScopeFor(input);
  const [integrationsState, agentsState] = await Promise.all([
    readScopedEnvState('integrations', storageScope),
    readScopedEnvState('agents', storageScope),
  ]);
  const integrations = new Map(integrationsState.entries.map((entry) => [entry.key, entry.value]));
  const agents = new Map(agentsState.entries.map((entry) => [entry.key, entry.value]));
  const secretNames = (getProviderEnvVars(providerId) ?? [])
    .map((entry) => entry.name)
    .filter((name) => SECRET_ENV_NAME_PATTERN.test(name));
  const configured = firstConfiguredValue(
    secretNames,
    integrations,
    agents,
    input.provider.credentialScope === 'system',
  );
  if (configured) return configured;

  // The existing PI probe requires a non-empty apiKey option even for endpoints
  // that intentionally do not authenticate requests.
  if (providerId === 'openai-compatible' || providerId === 'ollama') {
    return LOCAL_PROBE_CREDENTIAL;
  }
  return undefined;
}

function openAiCompatibleModel(
  provider: AiProviderInstallation,
  model: AiCatalogModel,
): Model<'openai-completions'> {
  const configuredBaseUrl = provider.config.openaiCompatibleBaseUrl?.trim();
  if (!configuredBaseUrl) {
    throw new ProviderVerificationError(
      'PROVIDER_ENDPOINT_NOT_CONFIGURED',
      'The provider endpoint is not configured.',
      409,
    );
  }
  const baseUrl = configuredBaseUrl.endsWith('/v1')
    ? configuredBaseUrl
    : `${configuredBaseUrl.replace(/\/+$/u, '')}/v1`;
  return {
    id: model.id,
    name: model.name,
    provider: 'openai-compatible',
    api: 'openai-completions',
    baseUrl,
    reasoning: model.reasoning,
    input: model.supportsVision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.metadata.contextWindow ?? 128_000,
    maxTokens: model.metadata.maxTokens ?? 8_192,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsLongCacheRetention: false,
    },
  };
}

function isOllamaCloudHost(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === 'cloud.ollama.com';
  } catch {
    return value.trim().toLowerCase() === 'cloud.ollama.com';
  }
}

function applyOllamaEndpoint(
  provider: AiProviderInstallation,
  model: Model<Api>,
): Model<Api> {
  const configuredHost = provider.config.ollamaHost?.trim();
  const baseUrl = configuredHost && !isOllamaCloudHost(configuredHost)
    ? (configuredHost.endsWith('/v1') ? configuredHost : `${configuredHost.replace(/\/+$/u, '')}/v1`)
    : 'http://localhost:11434/v1';
  return {
    ...model,
    baseUrl,
    compat: {
      ...model.compat,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsLongCacheRetention: false,
    },
  } as Model<Api>;
}

async function resolveVerificationModel(
  provider: AiProviderInstallation,
  providerDefault: AiCatalogModel,
): Promise<Model<Api>> {
  if (provider.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID) {
    const model = await resolvePiModel(provider.providerId, providerDefault.id);
    if (model.id !== providerDefault.id) {
      throw new ProviderVerificationError(
        'PROVIDER_DEFAULT_MODEL_UNAVAILABLE',
        'The configured provider default is no longer available.',
        409,
      );
    }
    return model;
  }
  if (provider.providerId === 'openai-compatible') {
    return openAiCompatibleModel(provider, providerDefault);
  }

  const customModel = provider.providerId === 'ollama' ? providerDefault.id : undefined;
  const model = getPiModels(provider.providerId, customModel)
    .find((candidate) => candidate.id === providerDefault.id);
  if (!model) {
    throw new ProviderVerificationError(
      'PROVIDER_DEFAULT_MODEL_UNAVAILABLE',
      'The configured provider default is no longer available.',
      409,
    );
  }
  return provider.providerId === 'ollama' ? applyOllamaEndpoint(provider, model) : model;
}

function probeRuntimeConfig(input: {
  provider: AiProviderInstallation;
  providerDefault: AiCatalogModel;
  model: Model<Api>;
}): EffectiveAgentRuntimeConfig {
  const now = new Date().toISOString();
  const providerConfig: PiProviderConfig = {
    id: input.provider.providerId,
    model: input.providerDefault.id,
    thinking: 'off',
    enabledTools: [],
    ...input.provider.config,
  };
  const piConfig: PiRuntimeConfig = {
    version: 2,
    activeProvider: input.provider.providerId,
    providers: { [input.provider.providerId]: providerConfig },
    enabledSkills: [],
    updatedAt: now,
    updatedBy: 'system:provider-verification',
  };
  const agent: AgentProfile = {
    id: 0,
    agentId: VERIFICATION_AGENT_ID,
    name: 'Provider verification',
    iconId: 'bot',
    type: 'system',
    removable: false,
    defaultProviderInstallationId: input.provider.installationId,
    defaultProvider: input.provider.providerId,
    defaultModel: input.providerDefault.id,
    defaultThinking: 'off',
    enabledTools: [],
    relevantSkills: [],
    relevantConnections: [],
    createdAt: now,
    updatedAt: now,
  };
  return {
    agent,
    agentId: VERIFICATION_AGENT_ID,
    isMainAgent: false,
    piConfig,
    mainPiConfig: piConfig,
    activeProvider: input.provider.providerId,
    providerConfig,
    model: input.model,
    thinkingLevel: 'off',
    enabledTools: [],
    overrideState: { model: true, tools: false },
    setupState: {
      providerConfigured: true,
      modelConfigured: true,
      managedControlPlaneAvailable: input.provider.credentialScope === 'managed',
      issues: [],
    },
  };
}

function previousVerificationTimestamp(provider: AiProviderInstallation): number | null {
  if (!provider.verifiedAt) return null;
  const value = Date.parse(provider.verifiedAt);
  return Number.isFinite(value) ? value : null;
}

function failedStatus(provider: AiProviderInstallation): Exclude<VerificationStatus, 'ready'> {
  return provider.status === 'ready' || provider.status === 'degraded' || Boolean(provider.verifiedAt)
    ? 'degraded'
    : 'unverified';
}

export async function verifyProviderInstallation(input: {
  organizationId: string;
  actorUserId: string;
  providerInstallationId: string;
}): Promise<ProviderVerificationResult> {
  const installationId = input.providerInstallationId.trim();
  if (!INSTALLATION_ID_PATTERN.test(installationId)) {
    throw new ProviderVerificationError(
      'INVALID_PROVIDER_INSTALLATION_ID',
      'The provider installation ID is invalid.',
      400,
    );
  }

  const catalog = await readAppRuntimeCatalog(input.organizationId);
  const provider = catalog.providers.find((candidate) => candidate.installationId === installationId);
  if (!provider) {
    throw new ProviderVerificationError(
      'PROVIDER_INSTALLATION_NOT_FOUND',
      'Provider installation not found.',
      404,
    );
  }
  if (!provider.enabled || provider.status === 'disabled') {
    throw new ProviderVerificationError(
      'PROVIDER_INSTALLATION_DISABLED',
      'Enable the provider installation before verifying it.',
      409,
    );
  }
  const providerDefault = provider.models.find((model) => model.enabled && model.isProviderDefault);
  if (!providerDefault) {
    throw new ProviderVerificationError(
      'PROVIDER_DEFAULT_MODEL_MISSING',
      'The provider has no enabled default model in the app catalog.',
      409,
    );
  }

  const startedAt = Date.now();
  let success = false;
  let failureCode: ProbeFailureCode = 'MODEL_TEST_FAILED';
  try {
    const [model, credential] = await Promise.all([
      resolveVerificationModel(provider, providerDefault),
      resolveInstallationCredential({
        provider,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
      }),
    ]);
    const effectiveConfig = probeRuntimeConfig({ provider, providerDefault, model });
    const probe = await testAgentModelConnection({
      agentId: VERIFICATION_AGENT_ID,
      deps: {
        resolveConfig: async () => effectiveConfig,
        resolveApiKey: async (requestedProvider) => (
          requestedProvider === model.provider ? credential : undefined
        ),
      },
    });
    success = probe.success;
    failureCode = probe.code ?? 'MODEL_TEST_FAILED';
  } catch (error) {
    if (error instanceof ProviderVerificationError) {
      failureCode = 'PROVIDER_MODEL_UNAVAILABLE';
    } else {
      failureCode = 'CREDENTIAL_LOOKUP_FAILED';
    }
  }

  const updatedAt = Date.now();
  const priorVerifiedAt = previousVerificationTimestamp(provider);
  const status: VerificationStatus = success ? 'ready' : failedStatus(provider);
  const verifiedAt = success ? updatedAt : priorVerifiedAt;
  const verifiedByUserId = success ? input.actorUserId : provider.verifiedByUserId;
  const stored = await updateProviderVerificationStore({
    organizationId: input.organizationId,
    providerInstallationId: installationId,
    actorUserId: input.actorUserId,
    expectedCatalogRevision: catalog.revision,
    expectedProviderRevision: provider.revision,
    status,
    verifiedAt,
    verifiedByUserId,
    updatedAt,
  });

  const result = {
    providerInstallationId: installationId,
    providerId: provider.providerId,
    modelId: providerDefault.id,
    status: stored.status,
    catalogRevision: stored.catalogRevision,
    providerRevision: stored.providerRevision,
    verifiedAt: stored.verifiedAt ? new Date(stored.verifiedAt).toISOString() : null,
    durationMs: Math.max(0, updatedAt - startedAt),
  };
  return success
    ? { ...result, success: true, code: 'PROVIDER_VERIFIED' }
    : { ...result, success: false, code: failureCode };
}

export function providerVerificationErrorResponse(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (
    error instanceof ProviderVerificationError
    || error instanceof CatalogRevisionConflictError
    || error instanceof ProviderVerificationStoreConflictError
  ) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: 'PROVIDER_VERIFICATION_FAILED',
    message: 'Provider verification failed.',
  };
}

export function providerProbeFailureHttpStatus(code: ProbeFailureCode): number {
  if (code === 'API_KEY_MISSING') return 400;
  if (code === 'MODEL_TEST_TIMEOUT') return 504;
  if (code === 'MODEL_NOT_CONFIGURED' || code === 'PROVIDER_MODEL_UNAVAILABLE') return 409;
  return 502;
}
