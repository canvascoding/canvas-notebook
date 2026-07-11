import type {
  AiAppRuntimeCatalog,
  AiCatalogDiscovery,
  AiCatalogDiscoveryModel,
  AiCatalogProviderUpdate,
  AiCatalogUpdate,
  AiCredentialScope,
  AiProviderSafeConfig,
  AiProviderSource,
  AiProviderStatus,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';

export type CatalogInitializationAction =
  | 'existing'
  | 'managed_initialized'
  | 'legacy_migrated'
  | 'review_required'
  | 'uninitialized';

export type CatalogInitialization = {
  action: CatalogInitializationAction;
  issueCode: string | null;
};

export type AdminRuntimeCatalogData = {
  catalog: AiAppRuntimeCatalog;
  discovery: AiCatalogDiscovery;
  initialization?: CatalogInitialization;
};

export type AiCatalogProviderDraft = {
  clientKey: string;
  providerInstallationId?: string;
  providerId: string;
  name: string;
  source: AiProviderSource;
  status: AiProviderStatus;
  enabled: boolean;
  credentialScope: AiCredentialScope;
  config: AiProviderSafeConfig;
  modelIds: string[];
  defaultModelId: string;
  availableModels: AiCatalogDiscoveryModel[];
  sourceRevision: string | null;
  lastSyncedAt: string | null;
};

export type AiRuntimeCatalogDraft = {
  expectedRevision: number;
  providers: AiCatalogProviderDraft[];
  defaultSelection: AiRuntimeSelection | null;
};

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  code?: string;
  error?: string;
};

export class RuntimeCatalogClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'RuntimeCatalogClientError';
  }
}

function mergeModels(
  discovered: readonly AiCatalogDiscoveryModel[],
  configured: AiAppRuntimeCatalog['providers'][number]['models'],
): AiCatalogDiscoveryModel[] {
  const models = new Map<string, AiCatalogDiscoveryModel>();
  for (const model of configured) {
    models.set(model.id, {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      supportsVision: model.supportsVision,
      contextWindow: model.metadata.contextWindow,
      maxTokens: model.metadata.maxTokens,
    });
  }
  for (const model of discovered) {
    models.set(model.id, model);
  }
  return Array.from(models.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export function catalogDataToDraft(data: AdminRuntimeCatalogData): AiRuntimeCatalogDraft {
  return {
    expectedRevision: data.catalog.revision,
    providers: data.catalog.providers.map((provider) => ({
      clientKey: provider.installationId,
      providerInstallationId: provider.installationId,
      providerId: provider.providerId,
      name: provider.name,
      source: provider.source,
      status: provider.status,
      enabled: provider.enabled,
      credentialScope: provider.credentialScope,
      config: { ...provider.config },
      modelIds: provider.models.filter((model) => model.enabled).map((model) => model.id),
      defaultModelId: provider.models.find((model) => model.enabled && model.isProviderDefault)?.id ?? '',
      availableModels: mergeModels(data.discovery[provider.providerId]?.models ?? [], provider.models),
      sourceRevision: provider.sourceRevision,
      lastSyncedAt: provider.lastSyncedAt,
    })),
    defaultSelection: data.catalog.defaultSelection ? { ...data.catalog.defaultSelection } : null,
  };
}

export function draftToCatalogUpdate(draft: AiRuntimeCatalogDraft): AiCatalogUpdate {
  const providers: AiCatalogProviderUpdate[] = draft.providers.map((provider) => ({
    ...(provider.providerInstallationId
      ? { providerInstallationId: provider.providerInstallationId }
      : {}),
    providerId: provider.providerId,
    enabled: provider.enabled,
    credentialScope: provider.credentialScope,
    config: { ...provider.config },
    modelIds: [...provider.modelIds],
    defaultModelId: provider.defaultModelId,
  }));

  return {
    expectedRevision: draft.expectedRevision,
    providers,
    defaultSelection: draft.defaultSelection ? { ...draft.defaultSelection } : null,
  };
}

export function serializeCatalogDraft(draft: AiRuntimeCatalogDraft): string {
  return JSON.stringify(draftToCatalogUpdate(draft));
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!response.ok || !payload.success || !payload.data) {
    throw new RuntimeCatalogClientError(
      payload.error || `Request failed (${response.status}).`,
      payload.code || 'REQUEST_FAILED',
      response.status,
    );
  }
  return payload.data;
}

export function readAdminRuntimeCatalog(): Promise<AdminRuntimeCatalogData> {
  return requestJson<AdminRuntimeCatalogData>('/api/admin/agent-runtime/catalog');
}

export function updateAdminRuntimeCatalog(draft: AiRuntimeCatalogDraft): Promise<AdminRuntimeCatalogData> {
  return requestJson<AdminRuntimeCatalogData>('/api/admin/agent-runtime/catalog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draftToCatalogUpdate(draft)),
  });
}

export function syncManagedRuntimeCatalog(input: {
  expectedRevision: number;
  setAsDefault: boolean;
}): Promise<{ catalog: AiAppRuntimeCatalog }> {
  return requestJson<{ catalog: AiAppRuntimeCatalog }>('/api/admin/agent-runtime/managed-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function verifyAdminProviderInstallation(providerInstallationId: string): Promise<{
  providerInstallationId: string;
  providerId: string;
  modelId: string;
  catalogRevision: number;
}> {
  return requestJson(`/api/admin/agent-runtime/providers/${encodeURIComponent(providerInstallationId)}/verify`, {
    method: 'POST',
  });
}
