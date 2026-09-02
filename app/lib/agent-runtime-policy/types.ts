import type { PiThinkingLevel } from '@/app/lib/pi/config';

export const AI_PROVIDER_SOURCES = ['managed', 'built-in', 'self-hosted'] as const;
export const AI_CREDENTIAL_SCOPES = ['managed', 'system', 'organization', 'user'] as const;
export const AI_PROVIDER_STATUSES = ['unverified', 'ready', 'degraded', 'disabled'] as const;
export const AI_RUNTIME_EXECUTION_MODES = [
  'interactive',
  'external_channel',
  'delegation',
  'personal_automation',
  'organization_automation',
] as const;
export const AI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly PiThinkingLevel[];

export type AiProviderSource = (typeof AI_PROVIDER_SOURCES)[number];
export type AiCredentialScope = (typeof AI_CREDENTIAL_SCOPES)[number];
export type AiProviderStatus = (typeof AI_PROVIDER_STATUSES)[number];
export type AiRuntimeExecutionMode = (typeof AI_RUNTIME_EXECUTION_MODES)[number];

export type AiRuntimePrincipal =
  | {
      type: 'user';
      userId: string;
      credentialSubjectUserId: string;
    }
  | {
      type: 'organization_service';
      serviceActorId: string;
      responsibleUserId: string;
      credentialSubjectUserId: null;
    };

export type AiProviderSafeConfig = {
  authMethod?: 'api-key' | 'oauth';
  ollamaMode?: 'local' | 'cloud';
  ollamaHost?: string;
  ollamaModelSource?: 'predefined' | 'custom';
  ollamaCustomModel?: string;
  ollamaAdditionalModels?: string[];
  openaiCompatibleBaseUrl?: string;
  openaiCompatibleModelSource?: 'predefined' | 'custom';
  openaiCompatibleCustomModel?: string;
};

export type AiCatalogModelMetadata = {
  contextWindow?: number;
  maxTokens?: number;
};

export type AiCatalogModel = {
  id: string;
  name: string;
  enabled: boolean;
  isProviderDefault: boolean;
  reasoning: boolean;
  supportsVision: boolean;
  thinkingLevels: PiThinkingLevel[];
  metadata: AiCatalogModelMetadata;
  revision: number;
};

export type AiProviderInstallation = {
  installationId: string;
  providerId: string;
  name: string;
  source: AiProviderSource;
  credentialScope: AiCredentialScope;
  enabled: boolean;
  status: AiProviderStatus;
  config: AiProviderSafeConfig;
  sourceRevision: string | null;
  lastSyncedAt: string | null;
  revision: number;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  models: AiCatalogModel[];
};

export type AiRuntimeSelection = {
  providerInstallationId: string;
  providerId: string;
  modelId: string;
  thinkingLevel: PiThinkingLevel;
};

export type AiModelReference = Pick<AiRuntimeSelection, 'providerInstallationId' | 'modelId'>;

export type AiRuntimeSelectionSource =
  | 'session'
  | 'user_preference'
  | 'agent_default'
  | 'workspace_default'
  | 'app_default';

export type AiAppRuntimeCatalog = {
  organizationId: string;
  revision: number;
  migrationState: 'uninitialized' | 'review_required' | 'configured' | 'migrated';
  legacySourceHash: string | null;
  defaultSelection: AiRuntimeSelection | null;
  providers: AiProviderInstallation[];
  updatedAt: string | null;
  updatedByUserId: string | null;
};

export type AiCatalogDiscoveryModel = {
  id: string;
  name: string;
  reasoning: boolean;
  supportsVision: boolean;
  thinkingLevels?: PiThinkingLevel[];
  contextWindow?: number;
  maxTokens?: number;
};

export type AiCatalogDiscoveryProvider = {
  id: string;
  name: string;
  source: AiProviderSource;
  models: AiCatalogDiscoveryModel[];
  installationIds?: Partial<Record<AiCredentialScope, string>>;
};

export type AiCatalogDiscovery = Record<string, AiCatalogDiscoveryProvider>;

export type AiCatalogProviderUpdate = {
  providerInstallationId?: string;
  providerId: string;
  enabled: boolean;
  credentialScope: AiCredentialScope;
  config: AiProviderSafeConfig;
  modelIds: string[];
  defaultModelId: string;
};

export type AiCatalogUpdate = {
  expectedRevision: number;
  providers: AiCatalogProviderUpdate[];
  defaultSelection: AiRuntimeSelection | null;
};

export type AiWorkspaceModelPolicy = {
  organizationId: string;
  workspaceId: string;
  allowedModels: AiModelReference[] | null;
  defaultSelection: AiRuntimeSelection | null;
  allowUserCredentials: boolean;
  revision: number;
  updatedByUserId: string | null;
  updatedAt: string | null;
};

export type AiUserModelPreference = {
  organizationId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  selection: AiRuntimeSelection;
  revision: number;
  updatedAt: string;
};

export type AiUserWorkspaceProviderGrant = {
  id: string;
  organizationId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  providerInstallationId: string;
  allowedExecutionModes: AiRuntimeExecutionMode[];
  status: 'active' | 'revoked';
  revision: number;
  grantedAt: string;
  revokedAt: string | null;
  updatedAt: string;
};

export type AiSessionRuntimeSnapshot = {
  selection: AiRuntimeSelection;
  catalogRevision: number;
  policyRevision: number;
  selectionSource: AiRuntimeSelectionSource;
};

export type AiResolvedRuntimeSelection = AiSessionRuntimeSnapshot & {
  credentialScope: AiCredentialScope;
};

export type AiUserCredentialEligibility = {
  state: 'ready' | 'not_connected' | 'consent_required';
  connected: boolean;
  consentGranted: boolean;
  grantRevision: number | null;
};

export type AiEffectiveCatalogProvider = {
  installationId: string;
  providerId: string;
  name: string;
  source: AiProviderSource;
  credentialScope: AiCredentialScope;
  authMethod?: 'api-key' | 'oauth';
  credentialAvailable: boolean;
  userCredentialEligibility?: AiUserCredentialEligibility;
  selectable: boolean;
  status: AiProviderStatus;
  models: AiCatalogModel[];
};

export type AiRuntimeResolutionIssue = {
  code:
    | 'RUNTIME_CATALOG_NOT_CONFIGURED'
    | 'NO_ALLOWED_MODELS'
    | 'PROVIDER_INSTALLATION_NOT_ALLOWED'
    | 'PROVIDER_NOT_READY'
    | 'CREDENTIAL_NOT_AVAILABLE'
    | 'MODEL_NOT_ALLOWED'
    | 'INVALID_INTELLIGENCE'
    | 'PROVIDER_ID_MISMATCH'
    | 'AGENT_DEFAULT_AMBIGUOUS';
  message: string;
  source: AiRuntimeSelectionSource | null;
};

export type AiEffectiveRuntimeResolution = {
  context: {
    organizationId: string;
    userId: string;
    workspaceId: string;
    workspaceType: 'personal' | 'organization' | 'team' | 'project';
    agentId: string;
    executionMode: AiRuntimeExecutionMode;
    principal: AiRuntimePrincipal;
  };
  catalogRevision: number;
  policyRevision: number;
  providers: AiEffectiveCatalogProvider[];
  inheritedSelection: AiResolvedRuntimeSelection | null;
  preference: AiUserModelPreference | null;
  effectiveSelection: AiResolvedRuntimeSelection | null;
  source: AiRuntimeSelectionSource | null;
  valid: boolean;
  issues: AiRuntimeResolutionIssue[];
};
