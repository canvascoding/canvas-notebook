import 'server-only';

import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import type { AiAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/types';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { getPiRequestOutputTokenCap } from '@/app/lib/pi/context-budget';
import {
  parsePiCompactionSummaryModelIdentity,
} from '@/app/lib/pi/config';

import { createSessionCompactionBudget } from './policy';
import {
  resolvePiEffectiveCompactionPolicy,
  type PiCompactionConfigurationSource,
} from './runtime-policy';
import {
  PiOrganizationCompactionSettingsConflictError,
  readPiOrganizationCompactionSettings,
  writePiOrganizationCompactionSettings,
} from './settings-store';

export type PiCompactionSummaryModelOption = Readonly<{
  identity: string;
  providerInstallationId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}>;

export type PiCompactionRuntimeStatusPreview = Readonly<{
  modelIdentity: string;
  contextWindowTokens: number;
  outputReserveTokens: number;
  triggerTokens: number;
  targetTailTokens: number;
}>;

export type PiCompactionAdminSettings = Readonly<{
  catalogRevision: number;
  settingsRevision: number;
  persisted: Readonly<{
    /** Whether this organization has saved a policy (including an explicit main-model choice). */
    configured: boolean;
    tailMode: 'legacy' | 'lean' | null;
    /** Only a currently selectable identity may be returned. */
    summaryModel: string | null;
    summaryModelUnavailable: boolean;
  }>;
  /**
   * Safe initial values for an edit. An unconfigured organization starts from
   * the catalog-validated effective fallback; a configured null remains an
   * explicit choice of the main model.
   */
  editable: Readonly<{
    tailMode: 'legacy' | 'lean';
    summaryModel: string | null;
  }>;
  /** Configuration precedence, not a claim about a session's live resolution. */
  configuration: Readonly<{
    tailMode: 'legacy' | 'lean';
    summaryModel: string | null;
    summaryRoute: 'configured' | 'main';
    sources: Readonly<{
      tailMode: PiCompactionConfigurationSource;
      summaryModel: PiCompactionConfigurationSource;
    }>;
  }>;
  summaryModels: readonly PiCompactionSummaryModelOption[];
  preview: PiCompactionRuntimeStatusPreview | null;
}>;

function modelIdentity(providerInstallationId: string, modelId: string): string {
  return `${providerInstallationId}/${modelId}`;
}

function selectableSummaryModels(catalog: AiAppRuntimeCatalog): PiCompactionSummaryModelOption[] {
  return catalog.providers
    .filter((provider) => provider.enabled && provider.status === 'ready')
    .flatMap((provider) => provider.models
      .filter((model) => model.enabled)
      .map((model) => Object.freeze({
        identity: modelIdentity(provider.installationId, model.id),
        providerInstallationId: provider.installationId,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.name,
      })))
    .sort((left, right) => left.identity.localeCompare(right.identity));
}

function safeCatalogSummaryIdentity(
  value: string | null | undefined,
  choices: readonly PiCompactionSummaryModelOption[],
): string | null {
  return value && choices.some((candidate) => candidate.identity === value) ? value : null;
}

export function resolvePiCompactionEditableSettings(input: Readonly<{
  configured: boolean;
  persisted: Readonly<{
    tailMode: 'legacy' | 'lean' | null;
    summaryModel: string | null;
  }>;
  effective: Readonly<{
    tailMode: 'legacy' | 'lean';
    summaryModel: string | null;
  }>;
}>): Readonly<{ tailMode: 'legacy' | 'lean'; summaryModel: string | null }> {
  return Object.freeze({
    tailMode: input.persisted.tailMode ?? input.effective.tailMode,
    summaryModel: input.configured ? input.persisted.summaryModel : input.effective.summaryModel,
  });
}

function previewForCatalogDefault(
  catalog: AiAppRuntimeCatalog,
  tailMode: 'legacy' | 'lean',
): PiCompactionRuntimeStatusPreview | null {
  const selection = catalog.defaultSelection;
  if (!selection) return null;
  const provider = catalog.providers.find((candidate) => candidate.installationId === selection.providerInstallationId);
  const model = provider?.models.find((candidate) => candidate.id === selection.modelId);
  const contextWindowTokens = model?.metadata.contextWindow;
  if (!provider?.enabled || !model?.enabled || !contextWindowTokens || contextWindowTokens < 1) return null;
  const outputReserveTokens = getPiRequestOutputTokenCap({
    contextWindow: contextWindowTokens,
    maxTokens: model.metadata.maxTokens ?? 8_192,
  });
  const budget = createSessionCompactionBudget({
    contextWindowTokens,
    outputReserveTokens,
    fixedRequestTokens: 0,
    modelIdentity: modelIdentity(provider.installationId, model.id),
    config: { tailMode },
  });
  return Object.freeze({
    modelIdentity: modelIdentity(provider.installationId, model.id),
    contextWindowTokens,
    outputReserveTokens,
    triggerTokens: budget.triggerTokens,
    targetTailTokens: budget.targetTailTokens,
  });
}

export async function readPiCompactionAdminSettings(
  organizationId: string,
): Promise<PiCompactionAdminSettings> {
  const [catalog, runtimeConfig, organizationSettings] = await Promise.all([
    readAppRuntimeCatalog(organizationId),
    readPiRuntimeConfig(),
    readPiOrganizationCompactionSettings(organizationId),
  ]);
  const summaryModels = selectableSummaryModels(catalog);
  const effectivePolicy = resolvePiEffectiveCompactionPolicy({
    runtimeConfig,
    organizationConfig: organizationSettings,
  });
  const effectiveTailMode = effectivePolicy.contextBudgetPolicy.tailMode === 'lean' ? 'lean' : 'legacy';
  const persistedSummaryModel = safeCatalogSummaryIdentity(organizationSettings.summaryModel, summaryModels);
  const configuredSummaryModel = safeCatalogSummaryIdentity(effectivePolicy.summaryModel, summaryModels);
  const editable = resolvePiCompactionEditableSettings({
    configured: organizationSettings.configured,
    persisted: {
      tailMode: organizationSettings.tailMode,
      summaryModel: persistedSummaryModel,
    },
    effective: {
      tailMode: effectiveTailMode,
      summaryModel: configuredSummaryModel,
    },
  });

  return Object.freeze({
    catalogRevision: catalog.revision,
    settingsRevision: organizationSettings.revision,
    persisted: Object.freeze({
      configured: organizationSettings.configured,
      tailMode: organizationSettings.tailMode,
      summaryModel: persistedSummaryModel,
      summaryModelUnavailable: organizationSettings.summaryModel !== null && persistedSummaryModel === null,
    }),
    editable,
    configuration: Object.freeze({
      tailMode: effectiveTailMode,
      summaryModel: configuredSummaryModel,
      summaryRoute: configuredSummaryModel ? 'configured' : 'main',
      sources: effectivePolicy.sources,
    }),
    summaryModels,
    preview: previewForCatalogDefault(catalog, effectiveTailMode),
  });
}

export async function updatePiCompactionAdminSettings(input: {
  organizationId: string;
  actorUserId: string;
  tailMode: 'legacy' | 'lean';
  summaryModel: string | null;
  expectedCatalogRevision: number;
  expectedSettingsRevision: number;
}): Promise<PiCompactionAdminSettings> {
  const catalog = await readAppRuntimeCatalog(input.organizationId);
  if (catalog.revision !== input.expectedCatalogRevision) {
    throw new PiCompactionSettingsError(
      'CATALOG_REVISION_CONFLICT',
      'The model catalog changed. Reload the compaction settings before saving.',
      409,
    );
  }
  if (input.summaryModel !== null) {
    const reference = parsePiCompactionSummaryModelIdentity(input.summaryModel);
    const available = reference !== null && selectableSummaryModels(catalog).some((candidate) => (
      candidate.identity === input.summaryModel
    ));
    if (!available) {
      throw new PiCompactionSettingsError(
        'SUMMARY_MODEL_UNAVAILABLE',
        'Select an enabled, verified provider model from the current catalog.',
        400,
      );
    }
  }

  try {
    await writePiOrganizationCompactionSettings({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      expectedRevision: input.expectedSettingsRevision,
      config: {
        tailMode: input.tailMode,
        summaryModel: input.summaryModel,
      },
    });
  } catch (error) {
    if (error instanceof PiOrganizationCompactionSettingsConflictError) {
      throw new PiCompactionSettingsError(
        'SETTINGS_REVISION_CONFLICT',
        error.message,
        409,
      );
    }
    throw error;
  }
  return readPiCompactionAdminSettings(input.organizationId);
}

export class PiCompactionSettingsError extends Error {
  constructor(
    readonly code: 'CATALOG_REVISION_CONFLICT' | 'SETTINGS_REVISION_CONFLICT' | 'SUMMARY_MODEL_UNAVAILABLE',
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
    this.name = 'PiCompactionSettingsError';
  }
}
