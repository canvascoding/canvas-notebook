import 'server-only';

import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import {
  ProviderVerificationError,
  verifyProviderInstallation,
  type ProviderVerificationResult,
} from '@/app/lib/agent-runtime-policy/provider-verification-service';
import {
  readMemoryReviewRuntimeSettings,
  updateMemoryReviewRuntimeSettings,
  type MemoryReviewRuntimeSettings,
} from './service';

export type MemoryReviewRuntimeCatalog = {
  revision: number;
  defaultSelection: { providerInstallationId: string; modelId: string } | null;
  providers: Array<{
    installationId: string;
    providerId: string;
    name: string;
    status: string;
    models: Array<{ id: string; name: string }>;
  }>;
  settings: MemoryReviewRuntimeSettings | null;
  valid: boolean;
};

export async function readMemoryReviewRuntimeCatalog(
  organizationId: string,
): Promise<MemoryReviewRuntimeCatalog> {
  const [catalog, settings] = await Promise.all([
    readAppRuntimeCatalog(organizationId),
    readMemoryReviewRuntimeSettings(organizationId),
  ]);
  const providers = catalog.providers
    .filter((provider) => provider.enabled && provider.status === 'ready')
    .map((provider) => ({
      installationId: provider.installationId,
      providerId: provider.providerId,
      name: provider.name,
      status: provider.status,
      models: provider.models
        .filter((model) => model.enabled)
        .map((model) => ({ id: model.id, name: model.name })),
    }))
    .filter((provider) => provider.models.length > 0);
  const configuredProvider = settings
    ? providers.find((provider) => provider.installationId === settings.providerInstallationId)
    : null;
  const valid = Boolean(
    settings
    && settings.verifiedCatalogRevision === catalog.revision
    && configuredProvider?.models.some((model) => model.id === settings.modelId),
  );
  return {
    revision: catalog.revision,
    defaultSelection: catalog.defaultSelection
      ? {
          providerInstallationId: catalog.defaultSelection.providerInstallationId,
          modelId: catalog.defaultSelection.modelId,
        }
      : null,
    providers,
    settings,
    valid,
  };
}

export async function verifyAndConfigureMemoryReviewRuntime(input: {
  organizationId: string;
  actorUserId: string;
  providerInstallationId: string;
  modelId: string;
  expectedCatalogRevision: number;
  signal?: AbortSignal;
}): Promise<{
  verification: ProviderVerificationResult & { success: true };
  settings: MemoryReviewRuntimeSettings;
  reactivatedJobs: number;
}> {
  const catalog = await readAppRuntimeCatalog(input.organizationId);
  if (catalog.revision !== input.expectedCatalogRevision) {
    throw new ProviderVerificationError(
      'MEMORY_REVIEWER_CATALOG_CHANGED',
      'The AI provider catalog changed. Reload the available models and try again.',
      409,
    );
  }
  const providerInstallationId = input.providerInstallationId.trim();
  const modelId = input.modelId.trim();
  const provider = catalog.providers.find((candidate) => candidate.installationId === providerInstallationId);
  const model = provider?.models.find((candidate) => candidate.id === modelId);
  if (!provider?.enabled || provider.status !== 'ready' || !model?.enabled) {
    throw new ProviderVerificationError(
      'MEMORY_REVIEWER_MODEL_UNAVAILABLE',
      'The selected Memory Reviewer provider or model is not ready.',
      409,
    );
  }

  const verification = await verifyProviderInstallation({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    providerInstallationId,
    modelId,
    signal: input.signal,
  });
  if (!verification.success) {
    throw new ProviderVerificationError(
      verification.code,
      'The selected Memory Reviewer model could not be verified.',
      409,
    );
  }

  const verifiedAt = verification.verifiedAt ? Date.parse(verification.verifiedAt) : NaN;
  if (
    verification.catalogRevision !== input.expectedCatalogRevision
    || verification.modelId !== modelId
    || !Number.isFinite(verifiedAt)
  ) {
    throw new ProviderVerificationError(
      'MEMORY_REVIEWER_VERIFICATION_CHANGED',
      'The verified Memory Reviewer selection changed. Reload and try again.',
      409,
    );
  }
  const stored = await updateMemoryReviewRuntimeSettings({
    organizationId: input.organizationId,
    providerInstallationId,
    modelId,
    verifiedCatalogRevision: verification.catalogRevision,
    verifiedAt,
    configuredByUserId: input.actorUserId,
  });
  return { verification, ...stored };
}
