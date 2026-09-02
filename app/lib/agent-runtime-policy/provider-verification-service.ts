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
import { testAgentModelConnection, type AgentModelTestCode } from '@/app/lib/agents/model-test';

const INSTALLATION_ID_PATTERN = /^aip_[a-f0-9]{24}$/u;
const VERIFICATION_AGENT_ID = 'provider-verification';
const PROVIDER_PROBE_TIMEOUT_MS = 30_000;

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

function assertProbeActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Provider verification was aborted.');
}

function raceWithProbeSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Provider verification was aborted.'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Provider verification was aborted.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function assertProviderProbeTarget(input: {
  catalogRevision: number;
  provider: AiProviderInstallation | undefined;
  expectedCatalogRevision: number;
  expectedProviderRevision: number;
  expectedProviderId: string;
  expectedModelId: string;
}): { provider: AiProviderInstallation; targetModel: AiCatalogModel } {
  if (input.catalogRevision !== input.expectedCatalogRevision) {
    throw new ProviderVerificationError(
      'PROVIDER_VERIFICATION_TARGET_CHANGED',
      'The AI provider catalog changed while verification was running. Try again.',
      409,
    );
  }
  const provider = input.provider;
  if (
    !provider
    || provider.revision !== input.expectedProviderRevision
    || provider.providerId !== input.expectedProviderId
    || !provider.enabled
    || provider.status === 'disabled'
  ) {
    throw new ProviderVerificationError(
      'PROVIDER_VERIFICATION_TARGET_CHANGED',
      'The AI provider installation changed while verification was running. Try again.',
      409,
    );
  }
  const targetModel = provider.models.find((model) => model.enabled && model.id === input.expectedModelId);
  if (!targetModel) {
    throw new ProviderVerificationError(
      'PROVIDER_VERIFICATION_TARGET_CHANGED',
      'The selected provider model changed while verification was running. Try again.',
      409,
    );
  }
  return { provider, targetModel };
}

async function resolveCurrentProviderProbeTarget(input: {
  organizationId: string;
  providerInstallationId: string;
  expectedCatalogRevision: number;
  expectedProviderRevision: number;
  expectedProviderId: string;
  expectedModelId: string;
  signal?: AbortSignal;
}): Promise<{ provider: AiProviderInstallation; targetModel: AiCatalogModel; model: Model<Api> }> {
  assertProbeActive(input.signal);
  const catalog = await raceWithProbeSignal(readAppRuntimeCatalog(input.organizationId), input.signal);
  const target = assertProviderProbeTarget({
    catalogRevision: catalog.revision,
    provider: catalog.providers.find((candidate) => candidate.installationId === input.providerInstallationId),
    expectedCatalogRevision: input.expectedCatalogRevision,
    expectedProviderRevision: input.expectedProviderRevision,
    expectedProviderId: input.expectedProviderId,
    expectedModelId: input.expectedModelId,
  });
  const model = await raceWithProbeSignal(
    resolveProviderInstallationModel({
      provider: target.provider,
      model: target.targetModel,
    }),
    input.signal,
  );
  assertProbeActive(input.signal);

  // Model resolution can read the managed source catalog. Re-read the app
  // catalog afterwards so a concurrent disable/model change cannot race the
  // provider turn.
  const confirmedCatalog = await raceWithProbeSignal(readAppRuntimeCatalog(input.organizationId), input.signal);
  const confirmed = assertProviderProbeTarget({
    catalogRevision: confirmedCatalog.revision,
    provider: confirmedCatalog.providers.find((candidate) => candidate.installationId === input.providerInstallationId),
    expectedCatalogRevision: input.expectedCatalogRevision,
    expectedProviderRevision: input.expectedProviderRevision,
    expectedProviderId: input.expectedProviderId,
    expectedModelId: input.expectedModelId,
  });
  assertProbeActive(input.signal);
  return { ...confirmed, model };
}

export async function verifyProviderInstallation(input: {
  organizationId: string;
  actorUserId: string;
  providerInstallationId: string;
  modelId?: string;
  signal?: AbortSignal;
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
  const requestedModelId = input.modelId?.trim();
  const targetModel = requestedModelId
    ? provider.models.find((model) => model.enabled && model.id === requestedModelId)
    : provider.models.find((model) => model.enabled && model.isProviderDefault);
  if (!targetModel) {
    throw new ProviderVerificationError(
      requestedModelId ? 'PROVIDER_MODEL_UNAVAILABLE' : 'PROVIDER_DEFAULT_MODEL_MISSING',
      requestedModelId
        ? 'The selected model is not enabled in the app catalog.'
        : 'The provider has no enabled default model in the app catalog.',
      409,
    );
  }

  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS);
  const probeSignal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  let success = false;
  let failureCode: ProbeFailureCode = 'MODEL_TEST_FAILED';
  try {
    const targetInput = {
      organizationId: input.organizationId,
      providerInstallationId: installationId,
      expectedCatalogRevision: catalog.revision,
      expectedProviderRevision: provider.revision,
      expectedProviderId: provider.providerId,
      expectedModelId: targetModel.id,
      signal: probeSignal,
    };
    const initialTarget = await resolveCurrentProviderProbeTarget(targetInput);
    const remainingTimeoutMs = PROVIDER_PROBE_TIMEOUT_MS - (Date.now() - startedAt);
    if (remainingTimeoutMs <= 0) {
      failureCode = 'MODEL_TEST_TIMEOUT';
      throw new Error('Provider verification exceeded its time budget before the probe started.');
    }
    const preflightFailure: {
      error: unknown;
      stage: 'credential' | 'target' | null;
    } = {
      error: null,
      stage: null,
    };
    const probe = await testAgentModelConnection({
      agentId: VERIFICATION_AGENT_ID,
      provider: provider.providerId,
      model: initialTarget.model,
      timeoutMs: remainingTimeoutMs,
      signal: probeSignal,
      complete: async (_probeModel, context, options) => {
        let stage: 'credential' | 'target' = 'target';
        try {
          // Each retry gets a fresh catalog/model snapshot and fresh scoped
          // credentials. Nothing credential-bearing is cached across attempts.
          const beforeAuth = await resolveCurrentProviderProbeTarget({
            ...targetInput,
            signal: options?.signal,
          });
          stage = 'credential';
          const auth = await raceWithProbeSignal(
            resolveProviderInstallationRuntimeAuth({
              provider: beforeAuth.provider,
              organizationId: input.organizationId,
              userId: input.actorUserId,
            }),
            options?.signal,
          );
          if (!auth.configured) {
            throw new AiRuntimeExecutionError(
              'CREDENTIAL_NOT_AVAILABLE',
              'Credentials are missing for the selected provider installation.',
            );
          }
          stage = 'target';
          const ready = await resolveCurrentProviderProbeTarget({
            ...targetInput,
            signal: options?.signal,
          });
          assertProbeActive(options?.signal);
          const authenticatedModel = auth.baseUrl
            ? { ...ready.model, baseUrl: auth.baseUrl }
            : ready.model;
          return completeSimple(authenticatedModel, context, {
            ...options,
            ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
            ...((auth.headers || options?.headers)
              ? { headers: { ...auth.headers, ...options?.headers } }
              : {}),
            env: { ...options?.env, ...auth.env },
          });
        } catch (error) {
          preflightFailure.error = error;
          preflightFailure.stage = stage;
          throw error;
        }
      },
    });
    if (preflightFailure.error) {
      if (probeSignal.aborted) {
        failureCode = input.signal?.aborted ? 'MODEL_TEST_ABORTED' : 'MODEL_TEST_TIMEOUT';
      } else if (
        preflightFailure.stage === 'credential'
        && !(preflightFailure.error instanceof ProviderVerificationError)
        && !(preflightFailure.error instanceof AiRuntimeExecutionError)
      ) {
        failureCode = 'CREDENTIAL_LOOKUP_FAILED';
      } else {
        throw preflightFailure.error;
      }
    } else {
      failureCode = probe.code ?? 'MODEL_TEST_FAILED';
      if (
        failureCode === 'MODEL_TEST_ABORTED'
        && !input.signal?.aborted
        && timeoutSignal.aborted
      ) {
        failureCode = 'MODEL_TEST_TIMEOUT';
      }
    }
    success = probe.success;
  } catch (error) {
    if (failureCode === 'MODEL_TEST_TIMEOUT') {
      // Preserve the explicit hard-budget failure assigned above.
    } else if (probeSignal.aborted) {
      failureCode = input.signal?.aborted ? 'MODEL_TEST_ABORTED' : 'MODEL_TEST_TIMEOUT';
    } else if (
      error instanceof ProviderVerificationError
      && error.code === 'PROVIDER_VERIFICATION_TARGET_CHANGED'
    ) {
      throw error;
    } else if (error instanceof ProviderVerificationError || error instanceof AiRuntimeExecutionError) {
      failureCode = 'PROVIDER_MODEL_UNAVAILABLE';
    } else {
      failureCode = 'CREDENTIAL_LOOKUP_FAILED';
    }
  }

  if (failureCode === 'MODEL_TEST_ABORTED') {
    throw new ProviderVerificationError(
      'PROVIDER_VERIFICATION_ABORTED',
      'Provider verification was aborted.',
      408,
    );
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
    modelId: targetModel.id,
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
  if (code === 'MODEL_TEST_ABORTED') return 408;
  if (code === 'MODEL_TEST_TIMEOUT') return 504;
  if (code === 'MODEL_NOT_CONFIGURED' || code === 'PROVIDER_MODEL_UNAVAILABLE') return 409;
  return 502;
}
