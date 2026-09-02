import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';

export function formatContextTokens(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }

  return `${value}`;
}

export type ContextStatusDisplay =
  | {
    source: 'pressure';
    pressureTokens: number;
    pressureSource: 'rough_estimate' | 'serialized_request';
    effectiveInputBudgetTokens: number;
    triggerTokens: number;
    targetTokens: number;
    percentOfTrigger: number;
    contextWindow: number;
  }
  | { source: 'actual'; usedTokens: number; contextWindow: number }
  | { source: 'next_request'; usedTokens: number; contextWindow: number }
  | {
    source: 'history';
    usedTokens: number;
    availableTokens: number;
    contextWindow: number;
    percent: number;
  }
  | { source: 'empty' };

/** Chooses one unambiguous value for the compact context status line. */
export function getContextStatusDisplay(status: RuntimeStatus | null): ContextStatusDisplay {
  if (!status) {
    return { source: 'empty' };
  }

  if (status.contextPressure) {
    return {
      source: 'pressure',
      pressureTokens: status.contextPressure.pressureTokens,
      pressureSource: status.contextPressure.source,
      effectiveInputBudgetTokens: status.contextPressure.effectiveInputBudgetTokens,
      triggerTokens: status.contextPressure.triggerTokens,
      targetTokens: status.contextPressure.targetTokens,
      percentOfTrigger: status.contextPressure.percentOfTrigger,
      contextWindow: status.contextWindow,
    };
  }

  const nextRequestEstimatedTokens = status.nextRequestEstimatedTokens;
  if (
    nextRequestEstimatedTokens !== null
    && nextRequestEstimatedTokens !== undefined
    && (status.phase !== 'idle' || status.nextRequestBudgetExceeded)
  ) {
    return {
      source: 'next_request',
      usedTokens: nextRequestEstimatedTokens,
      contextWindow: status.contextWindow,
    };
  }

  if (status.lastProviderInputTokens !== null && status.lastProviderInputTokens !== undefined) {
    return {
      source: 'actual',
      usedTokens: status.lastProviderInputTokens,
      contextWindow: status.contextWindow,
    };
  }

  return {
    source: 'history',
    usedTokens: status.estimatedHistoryTokens,
    availableTokens: status.availableHistoryTokens,
    contextWindow: status.contextWindow,
    percent: status.contextUsagePercent,
  };
}
