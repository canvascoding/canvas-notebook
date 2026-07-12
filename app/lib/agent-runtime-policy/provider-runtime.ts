import 'server-only';

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream, streamSimple } from '@earendil-works/pi-ai/compat';

import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import {
  resolveProviderInstallationRuntimeAuth,
  type ProviderInstallationRuntimeAuth,
} from '@/app/lib/agent-runtime-policy/installation-credentials';
import {
  assertEffectiveRuntimeSelection,
  buildEffectiveCatalogProviders,
  resolveEffectiveAgentRuntime,
  type AiRuntimeResolutionContext,
} from '@/app/lib/agent-runtime-policy/runtime-resolver';
import {
  readPiSessionRuntimeSnapshot,
  readWorkspaceModelPolicy,
  SessionRuntimeContextRevisionConflictError,
  SessionRuntimeSnapshotConflictError,
  writePiSessionRuntimeSnapshot,
} from '@/app/lib/agent-runtime-policy/runtime-store';
import type {
  AiCatalogModel,
  AiEffectiveRuntimeResolution,
  AiProviderInstallation,
  AiResolvedRuntimeSelection,
  AiRuntimeSelection,
  AiSessionRuntimeSnapshot,
} from '@/app/lib/agent-runtime-policy/types';
import {
  CANVAS_CONTROL_PLANE_PROVIDER_ID,
  getCanvasControlPlaneCatalog,
} from '@/app/lib/managed/control-plane-models';
import { getPiModels, resolvePiModel } from '@/app/lib/pi/model-resolver';

export class AiRuntimeExecutionError extends Error {
  readonly status = 409;

  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AiRuntimeExecutionError';
  }
}

const RUNTIME_RECREATION_ERROR_CODES = new Set([
  'SESSION_RUNTIME_CHANGED',
  'RUNTIME_CATALOG_CHANGED',
  'RUNTIME_POLICY_CHANGED',
  'RUNTIME_PROVIDER_CHANGED',
  'RUNTIME_MANAGED_CATALOG_CHANGED',
]);

export function isRuntimeRecreationRequiredError(error: unknown): boolean {
  return error instanceof AiRuntimeExecutionError
    && RUNTIME_RECREATION_ERROR_CODES.has(error.code);
}

function normalizeOpenAiBaseUrl(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) {
    throw new AiRuntimeExecutionError(
      'PROVIDER_ENDPOINT_NOT_CONFIGURED',
      'The selected provider endpoint is not configured.',
    );
  }
  return configured.endsWith('/v1')
    ? configured
    : `${configured.replace(/\/+$/u, '')}/v1`;
}

function openAiCompatibleModel(
  provider: AiProviderInstallation,
  model: AiCatalogModel,
): Model<'openai-completions'> {
  return {
    id: model.id,
    name: model.name,
    provider: 'openai-compatible',
    api: 'openai-completions',
    baseUrl: normalizeOpenAiBaseUrl(provider.config.openaiCompatibleBaseUrl),
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

async function runtimeAuth(input: {
  provider: AiProviderInstallation;
  organizationId: string;
  userId: string;
}): Promise<ProviderInstallationRuntimeAuth> {
  let auth: ProviderInstallationRuntimeAuth;
  try {
    auth = await resolveProviderInstallationRuntimeAuth(input);
  } catch {
    throw new AiRuntimeExecutionError(
      'CREDENTIAL_LOOKUP_FAILED',
      'Credentials for the selected provider installation could not be read.',
    );
  }
  if (!auth.configured) {
    throw new AiRuntimeExecutionError(
      'CREDENTIAL_NOT_AVAILABLE',
      'Credentials are missing for the selected provider installation.',
    );
  }
  return auth;
}

function runtimeErrorStream(model: Model<Api>, error: unknown): AssistantMessageEventStream {
  const message = error instanceof AiRuntimeExecutionError
    ? error.message
    : 'The selected AI runtime could not start the provider request.';
  const output: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: 'error', reason: 'error', error: output }));
  return stream;
}

/** Materialize an exact catalog model without legacy model-name fallbacks. */
export async function resolveProviderInstallationModel(input: {
  provider: AiProviderInstallation;
  model: AiCatalogModel;
}): Promise<Model<Api>> {
  const { provider, model } = input;
  if (provider.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID) {
    const managedCatalog = await getCanvasControlPlaneCatalog();
    if (
      managedCatalog.status !== 'ready'
      || !provider.sourceRevision
      || managedCatalog.catalogRevision !== provider.sourceRevision
    ) {
      throw new AiRuntimeExecutionError(
        'RUNTIME_MANAGED_CATALOG_CHANGED',
        'The managed AI catalog changed. Sync and review the app model catalog before trying again.',
      );
    }
    const resolved = await resolvePiModel(provider.providerId, model.id, { managedCatalog });
    if (resolved.id !== model.id) {
      throw new AiRuntimeExecutionError(
        'MODEL_NOT_AVAILABLE',
        'The selected managed model is no longer available.',
      );
    }
    return resolved;
  }
  if (provider.providerId === 'openai-compatible') {
    return openAiCompatibleModel(provider, model);
  }

  const customModel = provider.providerId === 'ollama' ? model.id : undefined;
  const resolved = getPiModels(provider.providerId, customModel)
    .find((candidate) => candidate.id === model.id);
  if (!resolved) {
    throw new AiRuntimeExecutionError(
      'MODEL_NOT_AVAILABLE',
      'The selected model is no longer available from its provider.',
    );
  }
  return provider.providerId === 'ollama'
    ? applyOllamaEndpoint(provider, resolved)
    : resolved;
}

export type ExecutableAgentRuntime = {
  resolution: AiEffectiveRuntimeResolution;
  selection: AiResolvedRuntimeSelection;
  providerInstallation: AiProviderInstallation;
  catalogModel: AiCatalogModel;
  model: Model<Api>;
  getApiKey: (providerId: string) => Promise<string | undefined>;
  streamFn: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
  requiresRecreation: () => boolean;
};

function snapshotFromSelection(selection: AiResolvedRuntimeSelection): AiSessionRuntimeSnapshot {
  return {
    selection: selection.selection,
    catalogRevision: selection.catalogRevision,
    policyRevision: selection.policyRevision,
    selectionSource: selection.selectionSource,
  };
}

function snapshotMatchesExecutableSelection(
  snapshot: AiSessionRuntimeSnapshot,
  selection: AiResolvedRuntimeSelection,
): boolean {
  return snapshot.selection.providerInstallationId === selection.selection.providerInstallationId
    && snapshot.selection.providerId === selection.selection.providerId
    && snapshot.selection.modelId === selection.selection.modelId
    && snapshot.selection.thinkingLevel === selection.selection.thinkingLevel
    && snapshot.catalogRevision === selection.catalogRevision
    && snapshot.policyRevision === selection.policyRevision;
}

function sameRuntimeSelection(left: AiRuntimeSelection, right: AiRuntimeSelection): boolean {
  return left.providerInstallationId === right.providerInstallationId
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.thinkingLevel === right.thinkingLevel;
}

function sameExecutableProviderConfig(
  left: AiProviderInstallation,
  right: AiProviderInstallation,
): boolean {
  if (left.providerId !== right.providerId) return false;
  if (left.credentialScope !== right.credentialScope) return false;
  if (left.source !== right.source) return false;
  if (left.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID && left.sourceRevision !== right.sourceRevision) {
    return false;
  }
  return JSON.stringify(left.config) === JSON.stringify(right.config);
}

function sameExecutableModel(left: AiCatalogModel, right: AiCatalogModel): boolean {
  return left.id === right.id
    && left.reasoning === right.reasoning
    && left.supportsVision === right.supportsVision
    && left.thinkingLevels.length === right.thinkingLevels.length
    && left.thinkingLevels.every((level) => right.thinkingLevels.includes(level))
    && left.metadata.contextWindow === right.metadata.contextWindow
    && left.metadata.maxTokens === right.metadata.maxTokens;
}

async function materializeResolution(
  resolution: AiEffectiveRuntimeResolution,
  context: AiRuntimeResolutionContext,
): Promise<ExecutableAgentRuntime | null> {
  const [catalog, policy] = await Promise.all([
    readAppRuntimeCatalog(resolution.context.organizationId),
    readWorkspaceModelPolicy(
      resolution.context.organizationId,
      resolution.context.workspaceId,
    ),
  ]);
  if (
    catalog.revision !== resolution.catalogRevision
    || (policy?.revision ?? 0) !== resolution.policyRevision
  ) {
    return null;
  }

  const selection = assertEffectiveRuntimeSelection(resolution);
  const providerInstallation = catalog.providers.find((provider) => (
    provider.installationId === selection.selection.providerInstallationId
  ));
  if (!providerInstallation || providerInstallation.providerId !== selection.selection.providerId) {
    throw new AiRuntimeExecutionError(
      'PROVIDER_INSTALLATION_NOT_AVAILABLE',
      'The selected provider installation is no longer available.',
    );
  }
  const catalogModel = providerInstallation.models.find((model) => (
    model.id === selection.selection.modelId && model.enabled
  ));
  if (!catalogModel) {
    throw new AiRuntimeExecutionError(
      'MODEL_NOT_AVAILABLE',
      'The selected model is no longer available.',
    );
  }

  const [model] = await Promise.all([
    resolveProviderInstallationModel({ provider: providerInstallation, model: catalogModel }),
    runtimeAuth({
      provider: providerInstallation,
      organizationId: resolution.context.organizationId,
      userId: resolution.context.userId,
    }),
  ]);

  let recreationRequired = false;
  const assertRuntimeExecutionState = async (expectedRevisions?: {
    catalogRevision: number;
    policyRevision: number;
  }): Promise<AiProviderInstallation> => {
    // Fetch the remote managed revision first, then read both local policy
    // records. That leaves the final local authorization decision as close as
    // possible to the provider call while still validating the remote source.
    let managedCatalog: Awaited<ReturnType<typeof getCanvasControlPlaneCatalog>> | null = null;
    if (providerInstallation.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID) {
      try {
        managedCatalog = await getCanvasControlPlaneCatalog();
      } catch {
        throw new AiRuntimeExecutionError(
          'RUNTIME_MANAGED_CATALOG_CHANGED',
          'The managed AI catalog could not be validated. Sync and review the app model catalog before trying again.',
        );
      }
    }

    const [latestCatalog, latestPolicy] = await Promise.all([
      readAppRuntimeCatalog(resolution.context.organizationId).catch(() => {
        throw new AiRuntimeExecutionError(
          'RUNTIME_CATALOG_CHANGED',
          'The AI runtime catalog could not be validated before the provider request started. Try again.',
        );
      }),
      readWorkspaceModelPolicy(
        resolution.context.organizationId,
        resolution.context.workspaceId,
      ).catch(() => {
        throw new AiRuntimeExecutionError(
          'RUNTIME_POLICY_CHANGED',
          'The workspace AI runtime policy could not be validated before the provider request started. Try again.',
        );
      }),
    ]);

    if (expectedRevisions && latestCatalog.revision !== expectedRevisions.catalogRevision) {
      throw new AiRuntimeExecutionError(
        'RUNTIME_CATALOG_CHANGED',
        'The AI runtime catalog changed before the provider request started. Try again.',
      );
    }
    if (expectedRevisions && (latestPolicy?.revision ?? 0) !== expectedRevisions.policyRevision) {
      throw new AiRuntimeExecutionError(
        'RUNTIME_POLICY_CHANGED',
        'The workspace AI runtime policy changed before the provider request started. Try again.',
      );
    }

    const latestProvider = latestCatalog.providers.find((candidate) => (
      candidate.installationId === providerInstallation.installationId
    ));
    const latestModel = latestProvider?.models.find((candidate) => candidate.id === catalogModel.id);
    if (
      !latestProvider
      || !latestModel
      || !latestProvider.enabled
      || latestProvider.status !== 'ready'
      || !latestModel.enabled
      || !sameExecutableProviderConfig(latestProvider, providerInstallation)
      || !sameExecutableModel(latestModel, catalogModel)
    ) {
      throw new AiRuntimeExecutionError(
        'RUNTIME_PROVIDER_CHANGED',
        'The selected provider installation changed before the request started. Try again.',
      );
    }

    const allowedProvider = buildEffectiveCatalogProviders({
      catalog: latestCatalog,
      policy: latestPolicy,
      workspaceType: context.workspaceType,
    }).find((candidate) => candidate.installationId === providerInstallation.installationId);
    const allowedModel = allowedProvider?.models.find((candidate) => candidate.id === catalogModel.id);
    if (!allowedModel) {
      throw new AiRuntimeExecutionError(
        'RUNTIME_POLICY_CHANGED',
        'The selected provider model is no longer allowed by the workspace policy. Select an available model and try again.',
      );
    }
    if (!allowedModel.thinkingLevels.includes(selection.selection.thinkingLevel)) {
      throw new AiRuntimeExecutionError(
        'RUNTIME_PROVIDER_CHANGED',
        'The selected intelligence level is no longer supported by the provider model. Select an available level and try again.',
      );
    }

    if (latestProvider.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID) {
      if (
        !managedCatalog
        || managedCatalog.status !== 'ready'
        || !latestProvider.sourceRevision
        || managedCatalog.catalogRevision !== latestProvider.sourceRevision
      ) {
        throw new AiRuntimeExecutionError(
          'RUNTIME_MANAGED_CATALOG_CHANGED',
          'The managed AI catalog changed. Sync and review the app model catalog before trying again.',
        );
      }
    }

    return latestProvider;
  };

  const resolveRequestAuth = async (): Promise<ProviderInstallationRuntimeAuth> => {
    // Resolve the effective selection first so concurrent session changes are
    // rejected before touching provider credentials.
    const latestResolution = await resolveEffectiveAgentRuntime(context);
    let latestSelection: AiResolvedRuntimeSelection;
    try {
      latestSelection = assertEffectiveRuntimeSelection(latestResolution);
    } catch {
      throw new AiRuntimeExecutionError(
        'SESSION_RUNTIME_CHANGED',
        'The session runtime is no longer allowed. Select an available model and try again.',
      );
    }
    if (!sameRuntimeSelection(latestSelection.selection, selection.selection)) {
      throw new AiRuntimeExecutionError(
        'SESSION_RUNTIME_CHANGED',
        'The session runtime changed before the provider request started. Try again.',
      );
    }

    const requestRevisions = {
      catalogRevision: latestResolution.catalogRevision,
      policyRevision: latestResolution.policyRevision,
    };
    const latestProvider = await assertRuntimeExecutionState(requestRevisions);
    const auth = await runtimeAuth({
      provider: latestProvider,
      organizationId: resolution.context.organizationId,
      userId: resolution.context.userId,
    });

    // Credential/OAuth lookup can perform filesystem, database, or network
    // work. Revalidate catalog, workspace policy, and managed source revision
    // after it completes so revocations during that window fail closed.
    await assertRuntimeExecutionState(requestRevisions);
    return auth;
  };

  return {
    resolution,
    selection,
    providerInstallation,
    catalogModel,
    model,
    getApiKey: async (requestedProviderId) => {
      if (
        requestedProviderId !== model.provider
        && requestedProviderId !== providerInstallation.providerId
      ) {
        return undefined;
      }
      try {
        const auth = await resolveRequestAuth();
        return auth.apiKey ?? '<authenticated>';
      } catch (error) {
        recreationRequired ||= isRuntimeRecreationRequiredError(error);
        return undefined;
      }
    },
    streamFn: async (requestedModel, requestContext, options) => {
      try {
        if (requestedModel.id !== model.id || requestedModel.provider !== model.provider) {
          throw new AiRuntimeExecutionError(
            'RUNTIME_PROVIDER_CHANGED',
            'The active runtime model changed before the provider request started. Try again.',
          );
        }
        const auth = await resolveRequestAuth();
        return streamSimple(requestedModel, requestContext, {
          ...options,
          ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
          env: { ...options?.env, ...auth.env },
        });
      } catch (error) {
        recreationRequired ||= isRuntimeRecreationRequiredError(error);
        return runtimeErrorStream(requestedModel, error);
      }
    },
    requiresRecreation: () => recreationRequired,
  };
}

/** Resolve policy, exact installation, exact model and scoped credential atomically enough to fail closed on catalog churn. */
export async function resolveExecutableAgentRuntime(
  context: AiRuntimeResolutionContext,
): Promise<ExecutableAgentRuntime> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolution = await resolveEffectiveAgentRuntime(context);
    const runtime = await materializeResolution(resolution, context);
    if (runtime) return runtime;
  }
  throw new AiRuntimeExecutionError(
    'RUNTIME_CATALOG_CHANGED',
    'The AI runtime catalog changed while the session was starting. Try again.',
  );
}

/** Pin inherited/user defaults on first execution so later preference changes do not alter an existing chat. */
export async function resolveAndPinSessionRuntime(
  context: AiRuntimeResolutionContext & { sessionId: string },
): Promise<ExecutableAgentRuntime> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const runtime = await resolveExecutableAgentRuntime(context);
    const stored = await readPiSessionRuntimeSnapshot({
      sessionId: context.sessionId,
      userId: context.userId,
      agentId: context.agentId,
    });
    // A PATCH may have pinned/replaced the session after the first resolution.
    // Re-resolve only when the persisted selection differs from the model we
    // just materialized, so the snapshot that won the race also wins execution.
    if (stored) {
      return snapshotMatchesExecutableSelection(stored, runtime.selection)
        ? runtime
        : resolveExecutableAgentRuntime(context);
    }

    try {
      await writePiSessionRuntimeSnapshot({
        sessionId: context.sessionId,
        userId: context.userId,
        agentId: context.agentId,
        snapshot: snapshotFromSelection(runtime.selection),
        expectedSnapshot: null,
        contextRevision: {
          organizationId: context.organizationId,
          workspaceId: context.workspaceId,
          expectedCatalogRevision: runtime.resolution.catalogRevision,
          expectedPolicyRevision: runtime.resolution.policyRevision,
        },
      });
      return runtime;
    } catch (error) {
      if (
        !(error instanceof SessionRuntimeSnapshotConflictError)
        && !(error instanceof SessionRuntimeContextRevisionConflictError)
      ) {
        throw error;
      }
    }
  }
  throw new AiRuntimeExecutionError(
    'SESSION_RUNTIME_PIN_CONFLICT',
    'The session runtime changed while it was starting. Try again.',
  );
}
