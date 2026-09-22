import 'server-only';

import {
  DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  validatePiContextBudgetPolicy,
  type PiContextBudgetPolicy,
} from '../context-budget';
import {
  parsePiCompactionSummaryModelIdentity,
  type PiRuntimeConfig,
} from '../config';
import { readPiOrganizationCompactionSettings } from './settings-store';

export const PI_COMPACTION_TAIL_MODE_ENV = 'CANVAS_PI_COMPACTION_TAIL_MODE';
export const PI_COMPACTION_SUMMARY_MODEL_ENV = 'CANVAS_PI_COMPACTION_SUMMARY_MODEL';

export type PiCompactionConfigurationSource = 'default' | 'persisted' | 'environment';

export type PiEffectiveCompactionPolicy = Readonly<{
  contextBudgetPolicy: PiContextBudgetPolicy;
  summaryModel: string | null;
  sources: Readonly<{
    tailMode: PiCompactionConfigurationSource;
    summaryModel: PiCompactionConfigurationSource;
  }>;
}>;

type PiRuntimeCompactionConfig = Pick<PiRuntimeConfig, 'compaction'>;
type PiOrganizationCompactionConfig = {
  configured?: boolean;
  tailMode?: 'legacy' | 'lean' | null;
  summaryModel?: string | null;
};
type Environment = Readonly<Record<string, string | undefined>>;

function normalizeTailMode(value: unknown): 'legacy' | 'lean' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'legacy' || normalized === 'lean' ? normalized : null;
}

/** Model identities are configuration, never credentials or provider secrets. */
export function normalizePiCompactionSummaryModel(value: unknown): string | null {
  return parsePiCompactionSummaryModelIdentity(value)
    ? (value as string).trim()
    : null;
}

/**
 * Resolves the one immutable compaction policy used for a request/run.
 * Deployment values deliberately win so an operator can immediately roll
 * back from lean to legacy without modifying persisted settings.
 */
export function resolvePiEffectiveCompactionPolicy(input: {
  /** Organization-owned settings are the persisted source for new sessions. */
  organizationConfig?: PiOrganizationCompactionConfig | null;
  /** Instance-wide legacy/bootstrap fallback while organizations migrate. */
  runtimeConfig?: PiRuntimeCompactionConfig | null;
  environment?: Environment;
} = {}): PiEffectiveCompactionPolicy {
  const environment = input.environment ?? process.env;
  const organizationConfig = input.organizationConfig;
  const legacyConfig = input.runtimeConfig?.compaction;
  const environmentTailMode = normalizeTailMode(environment[PI_COMPACTION_TAIL_MODE_ENV]);
  const persistedTailMode = organizationConfig?.configured
    ? normalizeTailMode(organizationConfig.tailMode)
    : normalizeTailMode(legacyConfig?.tailMode);
  const environmentSummaryModel = normalizePiCompactionSummaryModel(
    environment[PI_COMPACTION_SUMMARY_MODEL_ENV],
  );
  const persistedSummaryModel = organizationConfig?.configured
    ? normalizePiCompactionSummaryModel(organizationConfig.summaryModel)
    : normalizePiCompactionSummaryModel(legacyConfig?.summaryModel);
  const hasPersistedSummaryDecision = organizationConfig?.configured === true
    || persistedSummaryModel !== null;

  const tailMode = environmentTailMode
    ?? persistedTailMode
    ?? DEFAULT_PI_CONTEXT_BUDGET_POLICY.tailMode
    ?? 'legacy';
  const summaryModel = environmentSummaryModel ?? persistedSummaryModel;

  return Object.freeze({
    contextBudgetPolicy: validatePiContextBudgetPolicy({
      ...DEFAULT_PI_CONTEXT_BUDGET_POLICY,
      tailMode,
    }),
    summaryModel,
    sources: Object.freeze({
      tailMode: environmentTailMode ? 'environment' : persistedTailMode ? 'persisted' : 'default',
      summaryModel: environmentSummaryModel ? 'environment' : hasPersistedSummaryDecision ? 'persisted' : 'default',
    }),
  });
}

export async function loadPiEffectiveCompactionPolicy(
  organizationId: string,
): Promise<PiEffectiveCompactionPolicy> {
  const { readPiRuntimeConfig } = await import('@/app/lib/agents/storage');
  const [legacyRuntimeConfig, organizationSettings] = await Promise.all([
    readPiRuntimeConfig(),
    readPiOrganizationCompactionSettings(organizationId),
  ]);
  return resolvePiEffectiveCompactionPolicy({
    runtimeConfig: legacyRuntimeConfig,
    organizationConfig: organizationSettings,
  });
}
