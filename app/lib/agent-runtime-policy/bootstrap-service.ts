import 'server-only';

import { createHash } from 'node:crypto';

import { loadAiCatalogDiscovery } from '@/app/lib/agent-runtime-policy/catalog-discovery';
import {
  aiProviderInstallationId,
  replaceAiAppRuntimeCatalog,
} from '@/app/lib/agent-runtime-policy/catalog-service';
import {
  CatalogRevisionConflictError,
  readAppRuntimeCatalog,
  replaceAppRuntimeCatalogStore,
} from '@/app/lib/agent-runtime-policy/catalog-store';
import { isProviderInstallationCredentialAvailable } from '@/app/lib/agent-runtime-policy/installation-credentials';
import {
  getAllowedCredentialScopesForProvider,
  validateProviderCatalogAuth,
} from '@/app/lib/agent-runtime-policy/provider-auth-policy';
import {
  readUserModelPreference,
  writeUserModelPreferenceStore,
} from '@/app/lib/agent-runtime-policy/runtime-store';
import type {
  AiAppRuntimeCatalog,
  AiCatalogProviderUpdate,
  AiProviderInstallation,
  AiProviderSafeConfig,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';
import {
  DEFAULT_MANAGED_AGENT_ID,
  isManagedControlPlaneAvailable,
  PI_RUNTIME_CONFIG_FILE,
} from '@/app/lib/agents/storage';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { openDb } from '@/app/lib/db';
import {
  CANVAS_CONTROL_PLANE_PROVIDER_ID,
  getCanvasControlPlaneCatalog,
  type ManagedControlPlaneCatalog,
} from '@/app/lib/managed/control-plane-models';
import { findModelWithCompatibilityFallback } from '@/app/lib/pi/model-resolver';
import {
  normalizePiRuntimeConfig,
  validatePiConfig,
  type PiProviderConfig,
  type PiRuntimeConfig,
  type PiThinkingLevel,
} from '@/app/lib/pi/config';
import { readSettingsTextFileIfExists } from '@/app/lib/settings-storage';

type RuntimeBootstrapDatabaseState = {
  userCount: number;
  ownerUserId: string | null;
  ownerPersonalWorkspaceId: string | null;
  teamFeaturesEnabled: boolean;
};

export type AgentRuntimeBootstrapResult = {
  catalog: AiAppRuntimeCatalog;
  action: 'existing' | 'managed_initialized' | 'legacy_migrated' | 'review_required' | 'uninitialized';
  issueCode: string | null;
};

export class ManagedCatalogSyncError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 503,
  ) {
    super(message);
    this.name = 'ManagedCatalogSyncError';
  }
}

// Multiple clients can resolve their first chat runtime at the same time after
// startup. Share the repair per organization so they cannot race catalog writes.
const managedDefaultRepairRequests = new Map<string, Promise<AgentRuntimeBootstrapResult>>();

function safeProviderConfig(config: PiProviderConfig): AiProviderSafeConfig {
  return {
    ...(config.authMethod ? { authMethod: config.authMethod } : {}),
    ...(config.ollamaMode ? { ollamaMode: config.ollamaMode } : {}),
    ...(config.ollamaHost ? { ollamaHost: config.ollamaHost } : {}),
    ...(config.ollamaModelSource ? { ollamaModelSource: config.ollamaModelSource } : {}),
    ...(config.ollamaCustomModel ? { ollamaCustomModel: config.ollamaCustomModel } : {}),
    ...(config.openaiCompatibleBaseUrl ? { openaiCompatibleBaseUrl: config.openaiCompatibleBaseUrl } : {}),
    ...(config.openaiCompatibleModelSource ? { openaiCompatibleModelSource: config.openaiCompatibleModelSource } : {}),
    ...(config.openaiCompatibleCustomModel ? { openaiCompatibleCustomModel: config.openaiCompatibleCustomModel } : {}),
  };
}

function providerUpdateFromCatalog(provider: AiProviderInstallation): AiCatalogProviderUpdate {
  const providerDefault = provider.models.find((model) => model.isProviderDefault);
  if (provider.enabled && !providerDefault) {
    throw new ManagedCatalogSyncError(
      'CATALOG_PROVIDER_DEFAULT_MISSING',
      `Provider ${provider.providerId} has no provider default.`,
      409,
    );
  }
  return {
    providerInstallationId: provider.installationId,
    providerId: provider.providerId,
    enabled: provider.enabled,
    credentialScope: provider.credentialScope,
    config: provider.config,
    modelIds: provider.models.filter((model) => model.enabled).map((model) => model.id),
    defaultModelId: providerDefault?.id ?? '',
  };
}

async function readBootstrapDatabaseState(organizationId: string): Promise<RuntimeBootstrapDatabaseState> {
  const connection = await openDb();
  try {
    const userCountRow = await connection.get('SELECT COUNT(*) AS count FROM user') as { count?: number | string } | undefined;
    const organization = await connection.get(
      `SELECT owner_user_id, team_features_enabled
       FROM canvas_organization_settings
       WHERE organization_id = ?
       LIMIT 1`,
      [organizationId],
    ) as { owner_user_id?: string | null; team_features_enabled?: number | string | boolean } | undefined;
    const ownerUserId = organization?.owner_user_id?.trim() || null;
    const personalWorkspace = ownerUserId
      ? await connection.get(
          `SELECT id
           FROM canvas_workspaces
           WHERE organization_id = ? AND type = 'personal' AND owner_user_id = ? AND status = 'active'
           ORDER BY is_default DESC, created_at ASC
           LIMIT 1`,
          [organizationId, ownerUserId],
        ) as { id?: string | null } | undefined
      : undefined;
    return {
      userCount: Number(userCountRow?.count ?? 0),
      ownerUserId,
      ownerPersonalWorkspaceId: personalWorkspace?.id?.trim() || null,
      teamFeaturesEnabled: organization?.team_features_enabled === true
        || organization?.team_features_enabled === 1
        || organization?.team_features_enabled === '1',
    };
  } finally {
    await connection.close?.();
  }
}

function managedDefaultSelection(catalog: ManagedControlPlaneCatalog): AiRuntimeSelection {
  if (catalog.status !== 'ready' || !catalog.catalogRevision || !catalog.defaultModelId) {
    throw new ManagedCatalogSyncError(
      catalog.errorCode || 'MANAGED_CATALOG_INVALID',
      'Canvas Control Plane did not provide a valid catalog revision and explicit default model.',
    );
  }
  const model = catalog.models.find((candidate) => candidate.id === catalog.defaultModelId);
  if (!model) {
    throw new ManagedCatalogSyncError(
      'MANAGED_DEFAULT_NOT_IN_CATALOG',
      'Canvas Control Plane default model is not in the managed catalog.',
    );
  }
  return {
    providerInstallationId: '',
    providerId: CANVAS_CONTROL_PLANE_PROVIDER_ID,
    modelId: model.id,
    thinkingLevel: model.reasoning ? catalog.defaultThinkingLevel : 'off',
  };
}

function sameManagedCatalog(
  current: AiAppRuntimeCatalog,
  managedCatalog: ManagedControlPlaneCatalog,
  targetDefault: AiRuntimeSelection,
): boolean {
  const provider = current.providers.find((candidate) => candidate.providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID);
  if (!provider || provider.sourceRevision !== managedCatalog.catalogRevision) return false;
  const currentModels = provider.models.filter((model) => model.enabled).map((model) => model.id).sort();
  const remoteModels = managedCatalog.models.map((model) => model.id).sort();
  return JSON.stringify(currentModels) === JSON.stringify(remoteModels)
    && current.defaultSelection?.providerInstallationId === targetDefault.providerInstallationId
    && current.defaultSelection?.providerId === targetDefault.providerId
    && current.defaultSelection?.modelId === targetDefault.modelId
    && current.defaultSelection?.thinkingLevel === targetDefault.thinkingLevel;
}

export async function syncManagedAgentRuntimeCatalog(input: {
  organizationId: string;
  actorUserId: string;
  setAsDefault: boolean;
  initialOnboarding?: boolean;
  expectedRevision?: number;
}): Promise<AiAppRuntimeCatalog> {
  if (!isManagedControlPlaneAvailable()) {
    throw new ManagedCatalogSyncError(
      'MANAGED_PROVIDER_UNAVAILABLE',
      'Canvas Control Plane connection is incomplete.',
    );
  }
  const managedCatalog = await getCanvasControlPlaneCatalog();
  const managedSelection = managedDefaultSelection(managedCatalog);
  const current = await readAppRuntimeCatalog(input.organizationId);
  if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
    throw new CatalogRevisionConflictError(current.revision);
  }
  const installationId = aiProviderInstallationId(
    input.organizationId,
    CANVAS_CONTROL_PLANE_PROVIDER_ID,
    'managed',
  );
  managedSelection.providerInstallationId = installationId;

  const defaultSelection = input.initialOnboarding || input.setAsDefault || !current.defaultSelection
    ? managedSelection
    : current.defaultSelection;
  const defaultStillAvailable = defaultSelection.providerInstallationId !== installationId
    || managedCatalog.models.some((model) => model.id === defaultSelection.modelId);
  if (!defaultStillAvailable) {
    throw new ManagedCatalogSyncError(
      'MANAGED_CURRENT_DEFAULT_REMOVED',
      'The current managed default was removed. Confirm the new Control Plane default before syncing.',
      409,
    );
  }
  if (sameManagedCatalog(current, managedCatalog, defaultSelection)) return current;

  const localProviders = current.providers
    .filter((provider) => provider.providerId !== CANVAS_CONTROL_PLANE_PROVIDER_ID)
    .map(providerUpdateFromCatalog);
  const managedProvider: AiCatalogProviderUpdate = {
    providerInstallationId: installationId,
    providerId: CANVAS_CONTROL_PLANE_PROVIDER_ID,
    enabled: true,
    credentialScope: 'managed',
    config: {},
    modelIds: managedCatalog.models.map((model) => model.id),
    defaultModelId: managedCatalog.defaultModelId!,
  };
  const configs: Record<string, AiProviderSafeConfig[]> = {};
  for (const provider of localProviders) {
    (configs[provider.providerId] ??= []).push(provider.config);
  }
  const discovery = await loadAiCatalogDiscovery(configs, { managedCatalog });
  const updated = await replaceAiAppRuntimeCatalog({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    update: {
      expectedRevision: current.revision,
      providers: [...localProviders, managedProvider],
      defaultSelection,
    },
    discovery,
    migrationState: 'configured',
    readyInstallationIds: new Set([installationId]),
    sourceRevisionByInstallation: new Map([[installationId, managedCatalog.catalogRevision!]]),
  });
  await recordAuditEvent({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    source: 'agent-runtime',
    eventType: 'admin',
    entityType: 'ai_runtime_catalog',
    entityId: input.organizationId,
    action: 'ai_managed_catalog.sync',
    status: 'success',
    summary: 'Canvas Control Plane model catalog synchronized.',
    metadata: {
      catalogRevision: updated.revision,
      managedSourceRevision: managedCatalog.catalogRevision,
      modelCount: managedCatalog.models.length,
      defaultModelId: managedCatalog.defaultModelId,
      setAsDefault: input.setAsDefault || Boolean(input.initialOnboarding),
    },
  });
  return updated;
}

async function markLegacyReviewRequired(input: {
  organizationId: string;
  actorUserId: string;
  sourceHash: string;
}): Promise<AiAppRuntimeCatalog> {
  await replaceAppRuntimeCatalogStore({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    expectedRevision: 0,
    migrationState: 'review_required',
    defaultSelection: null,
    providers: [],
    legacySourceHash: input.sourceHash,
  });
  return readAppRuntimeCatalog(input.organizationId);
}

function legacyConfigFromRaw(rawContent: string): PiRuntimeConfig | null {
  try {
    const parsed = JSON.parse(rawContent) as PiRuntimeConfig;
    if (validatePiConfig(parsed)) return null;
    return normalizePiRuntimeConfig(parsed);
  } catch {
    return null;
  }
}

async function ensureMigratedOwnerPreference(input: {
  catalog: AiAppRuntimeCatalog;
  organizationId: string;
  state: RuntimeBootstrapDatabaseState;
}): Promise<void> {
  if (
    input.catalog.migrationState !== 'migrated'
    || !input.catalog.defaultSelection
    || !input.state.ownerUserId
    || !input.state.ownerPersonalWorkspaceId
    || input.state.userCount !== 1
    || input.state.teamFeaturesEnabled
  ) return;
  const key = {
    organizationId: input.organizationId,
    userId: input.state.ownerUserId,
    workspaceId: input.state.ownerPersonalWorkspaceId,
    agentId: DEFAULT_MANAGED_AGENT_ID,
  };
  if (await readUserModelPreference(key)) return;
  await writeUserModelPreferenceStore({
    ...key,
    expectedRevision: 0,
    expectedCatalogRevision: input.catalog.revision,
    expectedPolicyRevision: 0,
    selection: input.catalog.defaultSelection,
  });
}

async function migrateLegacyRuntimeConfig(input: {
  organizationId: string;
  actorUserId: string;
  state: RuntimeBootstrapDatabaseState;
}): Promise<AgentRuntimeBootstrapResult> {
  const legacy = await readSettingsTextFileIfExists(PI_RUNTIME_CONFIG_FILE);
  if (legacy.content === null) {
    return {
      catalog: await readAppRuntimeCatalog(input.organizationId),
      action: 'uninitialized',
      issueCode: null,
    };
  }
  const sourceHash = createHash('sha256').update(legacy.content).digest('hex');
  const config = legacyConfigFromRaw(legacy.content);
  if (!config) {
    return {
      catalog: await markLegacyReviewRequired({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        sourceHash,
      }),
      action: 'review_required',
      issueCode: 'LEGACY_RUNTIME_CONFIG_INVALID',
    };
  }
  const providerId = config.activeProvider.trim();
  const providerConfig = config.providers[providerId];
  if (
    !providerId
    || !providerConfig?.model?.trim()
    || providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID
  ) {
    return {
      catalog: await markLegacyReviewRequired({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        sourceHash,
      }),
      action: 'review_required',
      issueCode: providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID
        ? 'LEGACY_MANAGED_PROVIDER_NOT_CONNECTED'
        : 'LEGACY_RUNTIME_SELECTION_MISSING',
    };
  }

  const safeConfig = safeProviderConfig(providerConfig);
  const credentialScope = getAllowedCredentialScopesForProvider(providerId, safeConfig.authMethod).includes('system')
    ? 'system'
    : 'user';
  if (validateProviderCatalogAuth({ providerId, credentialScope, config: safeConfig })) {
    return {
      catalog: await markLegacyReviewRequired({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        sourceHash,
      }),
      action: 'review_required',
      issueCode: 'LEGACY_PROVIDER_AUTH_INVALID',
    };
  }
  if (providerId === 'openai-compatible' && !safeConfig.openaiCompatibleCustomModel) {
    safeConfig.openaiCompatibleModelSource = 'custom';
    safeConfig.openaiCompatibleCustomModel = providerConfig.model.trim();
  }
  const discovery = await loadAiCatalogDiscovery({ [providerId]: [safeConfig] });
  const discoveredProvider = discovery[providerId];
  const discoveredModel = discoveredProvider
    ? findModelWithCompatibilityFallback(discoveredProvider.models, providerConfig.model.trim())
    : undefined;
  if (!discoveredProvider || !discoveredModel) {
    return {
      catalog: await markLegacyReviewRequired({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        sourceHash,
      }),
      action: 'review_required',
      issueCode: 'LEGACY_MODEL_NOT_AVAILABLE',
    };
  }

  const installationId = aiProviderInstallationId(input.organizationId, providerId, credentialScope);
  const temporaryInstallation: AiProviderInstallation = {
    installationId,
    providerId,
    name: discoveredProvider.name,
    source: discoveredProvider.source,
    credentialScope,
    enabled: true,
    status: 'unverified',
    config: safeConfig,
    sourceRevision: null,
    lastSyncedAt: null,
    revision: 1,
    verifiedAt: null,
    verifiedByUserId: null,
    models: [],
  };
  const credentialAvailable = await isProviderInstallationCredentialAvailable({
    provider: temporaryInstallation,
    organizationId: input.organizationId,
    userId: input.state.ownerUserId || input.actorUserId,
  });
  const singleUser = input.state.userCount === 1
    && !input.state.teamFeaturesEnabled
    && Boolean(input.state.ownerUserId && input.state.ownerPersonalWorkspaceId);
  const thinkingLevel: PiThinkingLevel = discoveredModel.reasoning
    ? providerConfig.thinking || 'off'
    : 'off';
  const selection: AiRuntimeSelection = {
    providerInstallationId: installationId,
    providerId,
    modelId: discoveredModel.id,
    thinkingLevel,
  };
  const providerUpdate: AiCatalogProviderUpdate = {
    providerInstallationId: installationId,
    providerId,
    enabled: true,
    credentialScope,
    config: safeConfig,
    modelIds: [discoveredModel.id],
    defaultModelId: discoveredModel.id,
  };
  const canActivate = singleUser && credentialAvailable;
  const catalog = await replaceAiAppRuntimeCatalog({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    update: {
      expectedRevision: 0,
      providers: [providerUpdate],
      defaultSelection: canActivate ? selection : null,
    },
    discovery,
    migrationState: canActivate ? 'migrated' : 'review_required',
    legacySourceHash: sourceHash,
    readyInstallationIds: credentialAvailable ? new Set([installationId]) : undefined,
  });
  if (canActivate) {
    await ensureMigratedOwnerPreference({ catalog, organizationId: input.organizationId, state: input.state });
  }
  await recordAuditEvent({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    source: 'agent-runtime',
    eventType: 'migration',
    entityType: 'ai_runtime_catalog',
    entityId: input.organizationId,
    action: 'ai_runtime_legacy.migrate',
    status: canActivate ? 'success' : 'blocked',
    summary: canActivate
      ? 'Legacy AI runtime selection migrated.'
      : 'Legacy AI runtime selection requires admin review.',
    metadata: {
      sourceHash,
      catalogRevision: catalog.revision,
      providerId,
      modelId: discoveredModel.id,
      credentialAvailable,
      singleUser,
    },
  });
  return {
    catalog: await readAppRuntimeCatalog(input.organizationId),
    action: canActivate ? 'legacy_migrated' : 'review_required',
    issueCode: canActivate
      ? null
      : credentialAvailable
        ? 'LEGACY_TEAM_REVIEW_REQUIRED'
        : 'LEGACY_CREDENTIAL_NOT_AVAILABLE',
  };
}

async function repairMissingManagedDefault(input: {
  organizationId: string;
  actorUserId: string;
  expectedRevision: number;
}): Promise<AgentRuntimeBootstrapResult> {
  try {
    const catalog = await syncManagedAgentRuntimeCatalog({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      expectedRevision: input.expectedRevision,
      setAsDefault: true,
    });
    return { catalog, action: 'managed_initialized', issueCode: null };
  } catch (error) {
    if (error instanceof CatalogRevisionConflictError) {
      return {
        catalog: await readAppRuntimeCatalog(input.organizationId),
        action: 'existing',
        issueCode: null,
      };
    }
    if (error instanceof ManagedCatalogSyncError) {
      return {
        catalog: await readAppRuntimeCatalog(input.organizationId),
        action: 'uninitialized',
        issueCode: error.code,
      };
    }
    throw error;
  }
}

export async function ensureAgentRuntimeCatalogInitialized(input: {
  organizationId: string;
  actorUserId: string;
}): Promise<AgentRuntimeBootstrapResult> {
  const pendingRepair = managedDefaultRepairRequests.get(input.organizationId);
  if (pendingRepair) return pendingRepair;

  const [current, state] = await Promise.all([
    readAppRuntimeCatalog(input.organizationId),
    readBootstrapDatabaseState(input.organizationId),
  ]);
  const managedControlPlaneAvailable = isManagedControlPlaneAvailable();
  const shouldRepairMissingManagedDefault = current.revision > 0
    && !current.defaultSelection
    && managedControlPlaneAvailable;
  if (shouldRepairMissingManagedDefault) {
    const concurrentRepair = managedDefaultRepairRequests.get(input.organizationId);
    if (concurrentRepair) return concurrentRepair;

    const repairRequest = repairMissingManagedDefault({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      expectedRevision: current.revision,
    });
    const trackedRepairRequest = repairRequest.finally(() => {
      if (managedDefaultRepairRequests.get(input.organizationId) === trackedRepairRequest) {
        managedDefaultRepairRequests.delete(input.organizationId);
      }
    });
    managedDefaultRepairRequests.set(input.organizationId, trackedRepairRequest);
    return trackedRepairRequest;
  }
  if (current.revision > 0) {
    await ensureMigratedOwnerPreference({ catalog: current, organizationId: input.organizationId, state });
    return { catalog: current, action: 'existing', issueCode: null };
  }

  try {
    if (managedControlPlaneAvailable) {
      const catalog = await syncManagedAgentRuntimeCatalog({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        expectedRevision: current.revision,
        setAsDefault: true,
        initialOnboarding: current.revision === 0,
      });
      return { catalog, action: 'managed_initialized', issueCode: null };
    }
    return await migrateLegacyRuntimeConfig({ ...input, state });
  } catch (error) {
    if (error instanceof CatalogRevisionConflictError) {
      return {
        catalog: await readAppRuntimeCatalog(input.organizationId),
        action: 'existing',
        issueCode: null,
      };
    }
    if (error instanceof ManagedCatalogSyncError) {
      return {
        catalog: await readAppRuntimeCatalog(input.organizationId),
        action: 'uninitialized',
        issueCode: error.code,
      };
    }
    throw error;
  }
}
