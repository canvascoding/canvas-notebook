import 'server-only';

import type { Api, Model } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';

import {
  CatalogRevisionConflictError,
  ProviderVerificationStoreConflictError,
  readAppRuntimeCatalog,
  updateProviderVerificationStore,
} from '@/app/lib/agent-runtime-policy/catalog-store';
import { resolveProviderInstallationRuntimeAuth } from '@/app/lib/agent-runtime-policy/installation-credentials';
import {
  AiRuntimeExecutionError,
  resolveProviderInstallationModel,
} from '@/app/lib/agent-runtime-policy/provider-runtime';
import type {
  AiCatalogModel,
  AiProviderInstallation,
  AiProviderStatus,
} from '@/app/lib/agent-runtime-policy/types';
import type { EffectiveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { testAgentModelConnection, type AgentModelTestCode } from '@/app/lib/agents/model-test';
import type { AgentProfile } from '@/app/lib/agents/registry';
import type { PiProviderConfig, PiRuntimeConfig } from '@/app/lib/pi/config';

const INSTALLATION_ID_PATTERN = /^aip_[a-f0-9]{24}$/u;
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
    const [model, auth] = await Promise.all([
      resolveProviderInstallationModel({ provider, model: providerDefault }),
      resolveProviderInstallationRuntimeAuth({
        provider,
        organizationId: input.organizationId,
        userId: input.actorUserId,
      }),
    ]);
    if (!auth.configured) {
      throw new AiRuntimeExecutionError(
        'CREDENTIAL_NOT_AVAILABLE',
        'Credentials are missing for the selected provider installation.',
      );
    }
    const effectiveConfig = probeRuntimeConfig({ provider, providerDefault, model });
    const probe = await testAgentModelConnection({
      agentId: VERIFICATION_AGENT_ID,
      deps: {
        resolveConfig: async () => effectiveConfig,
        resolveApiKey: async (requestedProvider) => (
          requestedProvider === model.provider ? auth.apiKey ?? '<authenticated>' : undefined
        ),
        complete: (probeModel, context, options) => completeSimple(probeModel, context, {
          ...options,
          ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
          env: { ...options?.env, ...auth.env },
        }),
      },
    });
    success = probe.success;
    failureCode = probe.code ?? 'MODEL_TEST_FAILED';
  } catch (error) {
    if (error instanceof ProviderVerificationError || error instanceof AiRuntimeExecutionError) {
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
