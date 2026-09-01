import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';

export type ContextStatusDisplay =
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
