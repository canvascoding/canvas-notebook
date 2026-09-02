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
import { omitUnsupportedTemperature } from '@/app/lib/agent-runtime-policy/request-options';
import {
  resolveProviderInstallationRuntimeAuth,
  type ProviderInstallationRuntimeAuth,
} from '@/app/lib/agent-runtime-policy/installation-credentials';
import {
  assertEffectiveRuntimeSelection,
  buildEffectiveCatalogProviders,
  resolveEffectiveAgentRuntime,
  runtimePrincipalCanUseUserCredentials,
  type AiRuntimeResolutionContext,
} from '@/app/lib/agent-runtime-policy/runtime-resolver';
import { sessionRuntimeSnapshotFromResolvedSelection } from '@/app/lib/agent-runtime-policy/runtime-snapshot';
import { workspaceAllowsInteractiveUserCredentials } from '@/app/lib/agent-runtime-policy/user-credential-policy';
import {
  readPiSessionRuntimeSnapshot,
  readUserWorkspaceProviderGrant,
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
  MANAGED_CATALOG_WARM_CACHE_MS,
  type ManagedControlPlaneCatalog,
} from '@/app/lib/managed/control-plane-models';
import {
  getPiModels,
  modelSupportsImageInput,
  resolvePiModel,
} from '@/app/lib/pi/model-resolver';
import { ollamaOpenAiBaseUrl } from '@/app/lib/agent-runtime-policy/ollama-url';
import { createVisionFallbackStreamFn } from '@/app/lib/pi/vision-fallback-stream';

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

function applyOllamaEndpoint(
  provider: AiProviderInstallation,
  model: Model<Api>,
): Model<Api> {
  const baseUrl = ollamaOpenAiBaseUrl(provider.config.ollamaHost);
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
  context: AiEffectiveRuntimeResolution['context'];
}): Promise<ProviderInstallationRuntimeAuth> {
  if (
    input.provider.credentialScope === 'user'
    && !runtimePrincipalCanUseUserCredentials(input.context)
  ) {
    throw new AiRuntimeExecutionError(
      'USER_CREDENTIAL_EXECUTION_FORBIDDEN',
      'Personal provider credentials are not available for this runtime principal.',
    );
  }
  const credentialUserId = input.context.principal.type === 'user'
    ? input.context.principal.credentialSubjectUserId
    : input.context.userId;
  let auth: ProviderInstallationRuntimeAuth;
  try {
    auth = await resolveProviderInstallationRuntimeAuth({
      provider: input.provider,
      organizationId: input.context.organizationId,
      userId: credentialUserId,
    });
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

function managedCatalogChangedError(message = 'The selected managed model changed or was removed. Sync and review the app model catalog before trying again.') {
  return new AiRuntimeExecutionError('RUNTIME_MANAGED_CATALOG_CHANGED', message);
}

function sameModelInput(left: Model<Api>, right: Model<Api>): boolean {
  return left.input.length === right.input.length
    && left.input.every((input) => right.input.includes(input));
}

function sameManagedCatalogModel(
  catalogModel: AiCatalogModel,
  managedModel: Model<Api>,
): boolean {
  return catalogModel.id === managedModel.id
    && catalogModel.reasoning === managedModel.reasoning
    && catalogModel.supportsVision === modelSupportsImageInput(managedModel)
    && catalogModel.metadata.contextWindow === managedModel.contextWindow
    && catalogModel.metadata.maxTokens === managedModel.maxTokens;
}

function sameManagedRuntimeModel(left: Model<Api>, right: Model<Api>): boolean {
  return left.id === right.id
    && left.provider === right.provider
    && left.api === right.api
    && left.baseUrl === right.baseUrl
    && left.reasoning === right.reasoning
    && sameModelInput(left, right)
    && left.contextWindow === right.contextWindow
    && left.maxTokens === right.maxTokens
    && JSON.stringify(left.compat) === JSON.stringify(right.compat);
}

async function resolveManagedCatalogModel(input: {
  provider: AiProviderInstallation;
  model: AiCatalogModel;
  managedCatalog: ManagedControlPlaneCatalog;
}): Promise<Model<Api>> {
  const { provider, model, managedCatalog } = input;
  if (
    managedCatalog.status !== 'ready'
    || !managedCatalog.catalogRevision
    || !provider.sourceRevision
  ) {
    throw managedCatalogChangedError(
      'The managed AI catalog could not be validated. Sync and review the app model catalog before trying again.',
    );
  }

  let resolved: Model<Api>;
  try {
    resolved = await resolvePiModel(provider.providerId, model.id, { managedCatalog });
  } catch {
    throw managedCatalogChangedError();
  }
  if (resolved.id !== model.id || !sameManagedCatalogModel(model, resolved)) {
    throw managedCatalogChangedError();
  }
  return resolved;
}

/** Materialize an exact catalog model without legacy model-name fallbacks. */
export async function resolveProviderInstallationModel(input: {
  provider: AiProviderInstallation;
  model: AiCatalogModel;
}, options: { managedCatalogMaxAgeMs?: number } = {}): Promise<Model<Api>> {
  const { provider, model } = input;
  if (provider.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID) {
    const managedCatalog = await getCanvasControlPlaneCatalog({
      maxAgeMs: options.managedCatalogMaxAgeMs,
    });
    return resolveManagedCatalogModel({ provider, model, managedCatalog });
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
    resolveProviderInstallationModel(
      { provider: providerInstallation, model: catalogModel },
      { managedCatalogMaxAgeMs: MANAGED_CATALOG_WARM_CACHE_MS },
    ),
    runtimeAuth({
      provider: providerInstallation,
      context: resolution.context,
    }),
  ]);

  let recreationRequired = false;
  const assertRuntimeExecutionState = async (expectedRevisions?: {
    catalogRevision: number;
    policyRevision: number;
  }, options: { validateManagedCatalog?: boolean } = {}): Promise<AiProviderInstallation> => {
    // The pre-credential pass validates local policy without network work. The
    // final pass fetches the remote managed model first, then re-reads local
    // policy so revocations remain fail-closed and close to the provider call.
    let managedCatalog: Awaited<ReturnType<typeof getCanvasControlPlaneCatalog>> | null = null;
    if (
      options.validateManagedCatalog !== false
      && providerInstallation.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID
    ) {
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

    // The credential lookup below may refresh OAuth state or otherwise await
    // I/O. Re-read the owner grant immediately before the provider request so
    // a revocation during that window cannot authorize the stale credential.
    if (latestProvider.credentialScope === 'user' && context.workspaceType !== 'personal') {
      const principal = resolution.context.principal;
      if (!runtimePrincipalCanUseUserCredentials(resolution.context) || principal.type !== 'user') {
        throw new AiRuntimeExecutionError(
          'RUNTIME_POLICY_CHANGED',
          'Personal provider credentials are no longer allowed for this runtime principal. Try again.',
        );
      }
      const grant = await readUserWorkspaceProviderGrant({
        organizationId: resolution.context.organizationId,
        userId: principal.credentialSubjectUserId,
        workspaceId: resolution.context.workspaceId,
        agentId: resolution.context.agentId,
        providerInstallationId: latestProvider.installationId,
      });
      if (
        !grant
        || grant.status !== 'active'
        || !grant.allowedExecutionModes.includes(resolution.context.executionMode)
      ) {
        throw new AiRuntimeExecutionError(
          'RUNTIME_POLICY_CHANGED',
          'The personal provider credential grant is no longer active. Try again.',
        );
      }
    }

    const allowedProvider = buildEffectiveCatalogProviders({
      catalog: latestCatalog,
      policy: latestPolicy,
      workspaceType: context.workspaceType,
      allowUserCredentials: runtimePrincipalCanUseUserCredentials(resolution.context)
        && workspaceAllowsInteractiveUserCredentials({
          workspaceType: context.workspaceType,
          policy: latestPolicy,
        }),
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

    if (
      options.validateManagedCatalog !== false
      && latestProvider.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID
    ) {
      if (!managedCatalog) {
        throw managedCatalogChangedError(
          'The managed AI catalog could not be validated. Sync and review the app model catalog before trying again.',
        );
      }
      const latestManagedModel = await resolveManagedCatalogModel({
        provider: latestProvider,
        model: latestModel,
        managedCatalog,
      });
      if (!sameManagedRuntimeModel(model, latestManagedModel)) {
        throw managedCatalogChangedError();
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
    const latestProvider = await assertRuntimeExecutionState(requestRevisions, {
      validateManagedCatalog: false,
    });
    const auth = await runtimeAuth({
      provider: latestProvider,
      context: latestResolution.context,
    });

    // Credential/OAuth lookup can perform filesystem, database, or network
    // work. Revalidate catalog, workspace policy, and the selected managed
    // model after it completes so revocations during that window fail closed.
    await assertRuntimeExecutionState(requestRevisions, {
      validateManagedCatalog: true,
    });
    return auth;
  };

  const authenticatedStreamFn: ExecutableAgentRuntime['streamFn'] = async (requestedModel, requestContext, options) => {
    try {
      if (requestedModel.id !== model.id || requestedModel.provider !== model.provider) {
        throw new AiRuntimeExecutionError(
          'RUNTIME_PROVIDER_CHANGED',
          'The active runtime model changed before the provider request started. Try again.',
        );
      }
      const auth = await resolveRequestAuth();
      const authenticatedModel = auth.baseUrl
        ? { ...requestedModel, baseUrl: auth.baseUrl }
        : requestedModel;
      return streamSimple(authenticatedModel, requestContext, {
        ...omitUnsupportedTemperature(authenticatedModel, options),
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...((auth.headers || options?.headers)
          ? { headers: { ...auth.headers, ...options?.headers } }
          : {}),
        env: { ...options?.env, ...auth.env },
      });
    } catch (error) {
      recreationRequired ||= isRuntimeRecreationRequiredError(error);
      return runtimeErrorStream(requestedModel, error);
    }
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
    streamFn: createVisionFallbackStreamFn(authenticatedStreamFn, createAssistantMessageEventStream),
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
        snapshot: sessionRuntimeSnapshotFromResolvedSelection(runtime.selection),
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
