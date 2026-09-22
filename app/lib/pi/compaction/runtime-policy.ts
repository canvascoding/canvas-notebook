import 'server-only';

import {
  DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  validatePiContextBudgetPolicy,
  type PiContextBudgetPolicy,
} from '../context-budget';
import type { PiRuntimeConfig } from '../config';

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
type Environment = Readonly<Record<string, string | undefined>>;

function normalizeTailMode(value: unknown): 'legacy' | 'lean' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'legacy' || normalized === 'lean' ? normalized : null;
}

/** Model identities are configuration, never credentials or provider secrets. */
export function normalizePiCompactionSummaryModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > 512
    || /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/**
 * Resolves the one immutable compaction policy used for a request/run.
 * Deployment values deliberately win so an operator can immediately roll
 * back from lean to legacy without modifying persisted settings.
 */
export function resolvePiEffectiveCompactionPolicy(input: {
  runtimeConfig?: PiRuntimeCompactionConfig | null;
  environment?: Environment;
} = {}): PiEffectiveCompactionPolicy {
  const environment = input.environment ?? process.env;
  const persisted = input.runtimeConfig?.compaction;
  const environmentTailMode = normalizeTailMode(environment[PI_COMPACTION_TAIL_MODE_ENV]);
  const persistedTailMode = normalizeTailMode(persisted?.tailMode);
  const environmentSummaryModel = normalizePiCompactionSummaryModel(
    environment[PI_COMPACTION_SUMMARY_MODEL_ENV],
  );
  const persistedSummaryModel = normalizePiCompactionSummaryModel(persisted?.summaryModel);

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
      summaryModel: environmentSummaryModel ? 'environment' : persistedSummaryModel ? 'persisted' : 'default',
    }),
  });
}

export async function loadPiEffectiveCompactionPolicy(): Promise<PiEffectiveCompactionPolicy> {
  const { readPiRuntimeConfig } = await import('@/app/lib/agents/storage');
  return resolvePiEffectiveCompactionPolicy({ runtimeConfig: await readPiRuntimeConfig() });
}
