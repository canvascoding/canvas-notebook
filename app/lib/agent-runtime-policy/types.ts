import type { PiThinkingLevel } from '@/app/lib/pi/config';

export const AI_PROVIDER_SOURCES = ['managed', 'built-in', 'self-hosted'] as const;
export const AI_CREDENTIAL_SCOPES = ['managed', 'system', 'organization', 'user'] as const;
export const AI_PROVIDER_STATUSES = ['unverified', 'ready', 'degraded', 'disabled'] as const;
export const AI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly PiThinkingLevel[];

export type AiProviderSource = (typeof AI_PROVIDER_SOURCES)[number];
export type AiCredentialScope = (typeof AI_CREDENTIAL_SCOPES)[number];
export type AiProviderStatus = (typeof AI_PROVIDER_STATUSES)[number];

export type AiProviderSafeConfig = {
  authMethod?: 'api-key' | 'oauth';
  ollamaMode?: 'local' | 'cloud';
  ollamaHost?: string;
  ollamaModelSource?: 'predefined' | 'custom';
  ollamaCustomModel?: string;
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
  contextWindow?: number;
  maxTokens?: number;
};

export type AiCatalogDiscoveryProvider = {
  id: string;
  name: string;
  source: AiProviderSource;
  models: AiCatalogDiscoveryModel[];
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
