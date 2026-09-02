import 'server-only';

import { ensureAgentRuntimeCatalogInitialized } from '@/app/lib/agent-runtime-policy/bootstrap-service';
import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import { isProviderInstallationCredentialAvailable } from '@/app/lib/agent-runtime-policy/installation-credentials';
import { resolveProviderAuthMethod } from '@/app/lib/agent-runtime-policy/provider-auth-policy';
import { workspaceAllowsInteractiveUserCredentials } from '@/app/lib/agent-runtime-policy/user-credential-policy';
import {
  readPiSessionRuntimeSnapshot,
  readUserWorkspaceProviderGrant,
  readUserModelPreference,
  readWorkspaceModelPolicy,
} from '@/app/lib/agent-runtime-policy/runtime-store';
import type {
  AiAppRuntimeCatalog,
  AiEffectiveCatalogProvider,
  AiEffectiveRuntimeResolution,
  AiResolvedRuntimeSelection,
  AiRuntimeResolutionIssue,
  AiRuntimeExecutionMode,
  AiRuntimePrincipal,
  AiRuntimeSelection,
  AiRuntimeSelectionSource,
  AiSessionRuntimeSnapshot,
  AiWorkspaceModelPolicy,
} from '@/app/lib/agent-runtime-policy/types';
import { getAgentProfile, normalizeManagedAgentId, type AgentProfile } from '@/app/lib/agents/registry';
import type { WorkspaceType } from '@/app/lib/workspaces/types';
import { isManagedControlPlaneAvailable } from '@/app/lib/agents/storage';

export type AiRuntimeResolutionContext = {
  organizationId: string;
  userId: string;
  workspaceId: string;
  workspaceType: WorkspaceType;
  agentId: string;
  sessionId?: string | null;
  requestedSelection?: AiRuntimeSelection | null;
  executionMode?: AiRuntimeExecutionMode;
  principal?: AiRuntimePrincipal;
};

export class AiRuntimePolicyError extends Error {
  readonly status = 409;

  constructor(
    public readonly code: AiRuntimeResolutionIssue['code'],
    message: string,
    public readonly resolution?: AiEffectiveRuntimeResolution,
  ) {
    super(message);
    this.name = 'AiRuntimePolicyError';
  }
}

function modelReferenceKey(providerInstallationId: string, modelId: string): string {
  return `${providerInstallationId}\0${modelId}`;
}

export function buildEffectiveCatalogProviders(input: {
  catalog: AiAppRuntimeCatalog;
  policy: AiWorkspaceModelPolicy | null;
  workspaceType: WorkspaceType;
  credentialAvailability?: ReadonlyMap<string, boolean>;
  userCredentialEligibility?: ReadonlyMap<string, AiEffectiveCatalogProvider['userCredentialEligibility']>;
  allowUserCredentials?: boolean;
}): AiEffectiveCatalogProvider[] {
  const allowedModels = input.policy?.allowedModels === null || input.policy?.allowedModels === undefined
    ? null
    : new Set(input.policy.allowedModels.map((reference) => (
        modelReferenceKey(reference.providerInstallationId, reference.modelId)
      )));
  const allowUserCredentials = input.allowUserCredentials
    ?? workspaceAllowsInteractiveUserCredentials({
      workspaceType: input.workspaceType,
      policy: input.policy,
    });

  return input.catalog.providers.flatMap<AiEffectiveCatalogProvider>((provider) => {
    if (!provider.enabled || (provider.credentialScope === 'user' && !allowUserCredentials)) return [];
    const models = provider.models.filter((model) => (
      model.enabled
      && (allowedModels === null || allowedModels.has(modelReferenceKey(provider.installationId, model.id)))
    ));
    if (models.length === 0) return [];
    const credentialAvailable = input.credentialAvailability?.get(provider.installationId) ?? true;
    return [{
      installationId: provider.installationId,
      providerId: provider.providerId,
      name: provider.name,
      source: provider.source,
      credentialScope: provider.credentialScope,
      authMethod: resolveProviderAuthMethod(provider.providerId, provider.config.authMethod),
      credentialAvailable,
      ...(input.userCredentialEligibility?.get(provider.installationId)
        ? { userCredentialEligibility: input.userCredentialEligibility.get(provider.installationId) }
        : {}),
      selectable: provider.status === 'ready' && credentialAvailable,
      status: provider.status,
      models,
    }];
  });
}

function normalizedRuntimePrincipal(context: AiRuntimeResolutionContext): AiRuntimePrincipal {
  const principal = context.principal;
  if (!principal) {
    return {
      type: 'user',
      userId: context.userId,
      credentialSubjectUserId: context.userId,
    };
  }
  if (
    principal.type === 'user'
    && (principal.userId !== context.userId || principal.credentialSubjectUserId !== context.userId)
  ) {
    throw new AiRuntimePolicyError(
      'PROVIDER_INSTALLATION_NOT_ALLOWED',
      'The runtime principal does not match the session owner.',
    );
  }
  return principal;
}

export function runtimePrincipalCanUseUserCredentials(input: {
  userId: string;
  workspaceType: WorkspaceType;
  executionMode: AiRuntimeExecutionMode;
  principal: AiRuntimePrincipal;
}): boolean {
  const ownsCredential = input.principal.type === 'user'
    && input.principal.userId === input.userId
    && input.principal.credentialSubjectUserId === input.userId;
  if (!ownsCredential) return false;

  // Team grants are deliberately interactive-only in V1. Existing personal
  // automations retain their owner-scoped credential behavior because they do
  // not cross a workspace boundary or need a team grant.
  return input.executionMode === 'interactive'
    || (input.executionMode === 'personal_automation' && input.workspaceType === 'personal');
}

function issue(
  code: AiRuntimeResolutionIssue['code'],
  message: string,
  source: AiRuntimeSelectionSource | null,
): AiRuntimeResolutionIssue {
  return { code, message, source };
}

function compatibleModel(
  provider: AiEffectiveCatalogProvider,
  modelId: string,
): AiEffectiveCatalogProvider['models'][number] | null {
  const exact = provider.models.find((candidate) => candidate.id === modelId);
  if (exact) return exact;
  if (!/:cloud$/iu.test(modelId)) return null;
  const canonicalId = modelId.replace(/:cloud$/iu, '');
  return provider.models.find((candidate) => candidate.id === canonicalId) ?? null;
}

function validateSelection(input: {
  selection: AiRuntimeSelection;
  source: AiRuntimeSelectionSource;
  providers: AiEffectiveCatalogProvider[];
  catalogRevision: number;
  policyRevision: number;
  snapshot?: AiSessionRuntimeSnapshot | null;
}): { selection: AiResolvedRuntimeSelection | null; issue: AiRuntimeResolutionIssue | null } {
  const provider = input.providers.find((candidate) => candidate.installationId === input.selection.providerInstallationId);
  if (!provider) {
    return {
      selection: null,
      issue: issue(
        'PROVIDER_INSTALLATION_NOT_ALLOWED',
        'The selected provider installation is not available in this workspace.',
        input.source,
      ),
    };
  }
  if (provider.status !== 'ready') {
    return {
      selection: null,
      issue: issue('PROVIDER_NOT_READY', 'The selected provider installation is not ready.', input.source),
    };
  }
  if (!provider.credentialAvailable) {
    return {
      selection: null,
      issue: issue('CREDENTIAL_NOT_AVAILABLE', 'Credentials are missing for the selected provider.', input.source),
    };
  }
  if (provider.providerId !== input.selection.providerId) {
    return {
      selection: null,
      issue: issue('PROVIDER_ID_MISMATCH', 'The selected provider does not match its installation.', input.source),
    };
  }
  const model = compatibleModel(provider, input.selection.modelId);
  if (!model) {
    return {
      selection: null,
      issue: issue('MODEL_NOT_ALLOWED', 'The selected model is not allowed in this workspace.', input.source),
    };
  }
  if (!model.thinkingLevels.includes(input.selection.thinkingLevel)) {
    return {
      selection: null,
      issue: issue(
        'INVALID_INTELLIGENCE',
        'The selected intelligence level is not supported by this model.',
        input.source,
      ),
    };
  }

  return {
    selection: {
      selection: model.id === input.selection.modelId
        ? input.selection
        : { ...input.selection, modelId: model.id },
      catalogRevision: input.snapshot?.catalogRevision ?? input.catalogRevision,
      policyRevision: input.snapshot?.policyRevision ?? input.policyRevision,
      selectionSource: input.source,
      credentialScope: provider.credentialScope,
    },
    issue: null,
  };
}

function agentDefaultCandidate(input: {
  agent: AgentProfile;
  catalog: AiAppRuntimeCatalog;
  providers: AiEffectiveCatalogProvider[];
}): { selection: AiRuntimeSelection | null; issue: AiRuntimeResolutionIssue | null } {
  const providerId = input.agent.defaultProvider?.trim();
  const modelId = input.agent.defaultModel?.trim();
  if (!providerId || !modelId) return { selection: null, issue: null };

  const configuredInstallationId = input.agent.defaultProviderInstallationId?.trim() || null;
  if (configuredInstallationId) {
    return {
      selection: {
        providerInstallationId: configuredInstallationId,
        providerId,
        modelId,
        thinkingLevel: input.agent.defaultThinking || 'off',
      },
      issue: null,
    };
  }

  const eligible = input.providers.filter((provider) => (
    provider.providerId === providerId && provider.models.some((model) => model.id === modelId)
  ));
  if (eligible.length === 1) {
    return {
      selection: {
        providerInstallationId: eligible[0].installationId,
        providerId,
        modelId,
        thinkingLevel: input.agent.defaultThinking || 'off',
      },
      issue: null,
    };
  }

  const catalogCandidates = input.catalog.providers.filter((provider) => (
    provider.providerId === providerId && provider.models.some((model) => model.id === modelId)
  ));
  if (eligible.length > 1 || catalogCandidates.length > 1) {
    return {
      selection: null,
      issue: issue(
        'AGENT_DEFAULT_AMBIGUOUS',
        'The agent default must identify a specific provider installation.',
        'agent_default',
      ),
    };
  }

  return {
    selection: {
      providerInstallationId: catalogCandidates[0]?.installationId || '',
      providerId,
      modelId,
      thinkingLevel: input.agent.defaultThinking || 'off',
    },
    issue: null,
  };
}

function inheritedCandidate(input: {
  agent: AgentProfile;
  catalog: AiAppRuntimeCatalog;
  policy: AiWorkspaceModelPolicy | null;
  providers: AiEffectiveCatalogProvider[];
}): {
  selection: AiRuntimeSelection | null;
  source: AiRuntimeSelectionSource | null;
  issue: AiRuntimeResolutionIssue | null;
} {
  const agentDefault = agentDefaultCandidate(input);
  if (agentDefault.issue || agentDefault.selection) {
    return { ...agentDefault, source: 'agent_default' };
  }
  if (input.policy?.defaultSelection) {
    return { selection: input.policy.defaultSelection, source: 'workspace_default', issue: null };
  }
  if (input.catalog.defaultSelection) {
    return { selection: input.catalog.defaultSelection, source: 'app_default', issue: null };
  }
  return {
    selection: null,
    source: null,
    issue: issue(
      'RUNTIME_CATALOG_NOT_CONFIGURED',
      'No app-wide AI runtime default has been configured.',
      null,
    ),
  };
}

export async function resolveEffectiveAgentRuntime(
  contextInput: AiRuntimeResolutionContext,
): Promise<AiEffectiveRuntimeResolution> {
  const context = {
    ...contextInput,
    agentId: normalizeManagedAgentId(contextInput.agentId),
    executionMode: contextInput.executionMode ?? 'interactive' as const,
  };
  const principal = normalizedRuntimePrincipal(context);
  const executionAllowsUserCredentials = runtimePrincipalCanUseUserCredentials({
    userId: context.userId,
    workspaceType: context.workspaceType,
    executionMode: context.executionMode,
    principal,
  });

  // A managed instance may receive its first chat request before anyone opens
  // the AI provider settings. Initialize the Control Plane catalog here so a
  // connected Control Plane is usable immediately after startup. Existing
  // catalogs are left untouched, and local/legacy runtimes keep their
  // admin-controlled migration path.
  if (isManagedControlPlaneAvailable()) {
    await ensureAgentRuntimeCatalogInitialized({
      organizationId: context.organizationId,
      actorUserId: context.userId,
    });
  }

  const [catalog, policy, preference, agent, persistedSession] = await Promise.all([
    readAppRuntimeCatalog(context.organizationId),
    readWorkspaceModelPolicy(context.organizationId, context.workspaceId),
    principal.type === 'user' && executionAllowsUserCredentials
      ? readUserModelPreference({
        organizationId: context.organizationId,
        userId: principal.credentialSubjectUserId,
        workspaceId: context.workspaceId,
        agentId: context.agentId,
      })
      : Promise.resolve(null),
    getAgentProfile(context.agentId),
    context.sessionId
      ? readPiSessionRuntimeSnapshot({
          sessionId: context.sessionId,
          userId: context.userId,
          agentId: context.agentId,
        })
      : Promise.resolve(null),
  ]);
  if (!agent) throw new Error('Agent not found.');

  const workspaceAllowsUserCredentials = workspaceAllowsInteractiveUserCredentials({
    workspaceType: context.workspaceType,
    policy,
  });
  const providerCredentialStates = await Promise.all(catalog.providers.map(async (provider) => {
    if (provider.credentialScope === 'user' && !executionAllowsUserCredentials) {
      return {
        installationId: provider.installationId,
        credentialAvailable: false,
        userCredentialEligibility: undefined,
      };
    }
    if (provider.credentialScope === 'user' && !workspaceAllowsUserCredentials) {
      return {
        installationId: provider.installationId,
        credentialAvailable: false,
        userCredentialEligibility: undefined,
      };
    }
    const credentialConnected = await isProviderInstallationCredentialAvailable({
      provider,
      organizationId: context.organizationId,
      userId: principal.type === 'user' ? principal.credentialSubjectUserId : context.userId,
    });
    if (provider.credentialScope !== 'user') {
      return {
        installationId: provider.installationId,
        credentialAvailable: credentialConnected,
        userCredentialEligibility: undefined,
      };
    }

    const grant = context.workspaceType === 'personal'
      ? null
      : await readUserWorkspaceProviderGrant({
        organizationId: context.organizationId,
        userId: principal.type === 'user' ? principal.credentialSubjectUserId : context.userId,
        workspaceId: context.workspaceId,
        agentId: context.agentId,
        providerInstallationId: provider.installationId,
      });
    const consentGranted = context.workspaceType === 'personal' || Boolean(
      grant
      && grant.status === 'active'
      && grant.allowedExecutionModes.includes(context.executionMode),
    );
    return {
      installationId: provider.installationId,
      credentialAvailable: credentialConnected && consentGranted,
      userCredentialEligibility: {
        state: !consentGranted
          ? 'consent_required' as const
          : credentialConnected ? 'ready' as const : 'not_connected' as const,
        connected: credentialConnected,
        consentGranted,
        grantRevision: grant?.revision ?? null,
      },
    };
  }));
  const credentialAvailability = new Map(providerCredentialStates.map((state) => [
    state.installationId,
    state.credentialAvailable,
  ] as const));
  const userCredentialEligibility = new Map(providerCredentialStates.flatMap((state) => (
    state.userCredentialEligibility
      ? [[state.installationId, state.userCredentialEligibility] as const]
      : []
  )));
  const providers = buildEffectiveCatalogProviders({
    catalog,
    policy,
    workspaceType: context.workspaceType,
    credentialAvailability,
    userCredentialEligibility,
    allowUserCredentials: executionAllowsUserCredentials && workspaceAllowsUserCredentials,
  });
  const policyRevision = policy?.revision ?? 0;
  const baseIssues: AiRuntimeResolutionIssue[] = [];
  if (providers.length === 0 && catalog.providers.some((provider) => provider.enabled)) {
    baseIssues.push(issue('NO_ALLOWED_MODELS', 'No AI models are available in this workspace.', null));
  }

  const inherited = inheritedCandidate({ agent, catalog, policy, providers });
  let inheritedSelection: AiResolvedRuntimeSelection | null = null;
  let inheritedIssue: AiRuntimeResolutionIssue | null = inherited.issue;
  if (inherited.selection && inherited.source) {
    const validation = validateSelection({
      selection: inherited.selection,
      source: inherited.source,
      providers,
      catalogRevision: catalog.revision,
      policyRevision,
    });
    inheritedSelection = validation.selection;
    inheritedIssue = validation.issue;
  }

  const explicit = context.requestedSelection
    ? { selection: context.requestedSelection, source: 'session' as const, snapshot: null }
    : persistedSession && executionAllowsUserCredentials
      ? {
          selection: persistedSession.selection,
          source: persistedSession.selectionSource,
          snapshot: persistedSession,
        }
      : preference
        ? { selection: preference.selection, source: 'user_preference' as const, snapshot: null }
        : null;

  let effectiveSelection = inheritedSelection;
  let source = inherited.source;
  const issues = [...baseIssues];
  if (explicit) {
    const validation = validateSelection({
      selection: explicit.selection,
      source: explicit.source,
      providers,
      catalogRevision: catalog.revision,
      policyRevision,
      snapshot: explicit.snapshot,
    });
    effectiveSelection = validation.selection;
    source = explicit.source;
    if (validation.issue) issues.push(validation.issue);
  } else if (inheritedIssue) {
    issues.push(inheritedIssue);
  }

  return {
    context: {
      organizationId: context.organizationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      workspaceType: context.workspaceType,
      agentId: context.agentId,
      executionMode: context.executionMode,
      principal,
    },
    catalogRevision: catalog.revision,
    policyRevision,
    providers,
    inheritedSelection,
    preference,
    effectiveSelection,
    source,
    valid: Boolean(effectiveSelection) && issues.length === 0,
    issues,
  };
}

export function assertEffectiveRuntimeSelection(
  resolution: AiEffectiveRuntimeResolution,
): AiResolvedRuntimeSelection {
  if (resolution.valid && resolution.effectiveSelection) return resolution.effectiveSelection;
  const firstIssue = resolution.issues[0] || issue(
    'RUNTIME_CATALOG_NOT_CONFIGURED',
    'No valid AI runtime selection is available.',
    resolution.source,
  );
  throw new AiRuntimePolicyError(firstIssue.code, firstIssue.message, resolution);
}
