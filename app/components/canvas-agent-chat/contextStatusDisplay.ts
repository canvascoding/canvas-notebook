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
  ) {
    return {
      source: 'next_request',
      usedTokens: nextRequestEstimatedTokens,
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

/** Shared by header, progress bar and notice, including legacy server status. */
export function getContextStatusPresentation(status: RuntimeStatus | null) {
  const display = getContextStatusDisplay(status);
  const percent = display.source === 'pressure' ? display.percentOfTrigger
    : display.source === 'next_request' || display.source === 'actual'
      ? Math.round(display.usedTokens / Math.max(1, display.contextWindow) * 100)
      : display.source === 'history' ? display.percent : 0;
  const freshness = status?.contextMeasurement?.state ?? 'current';
  const blocking = freshness === 'current' && Boolean(status?.nextRequestBudgetExceeded);
  const failed = status?.compactionStatus?.state === 'failed';
  const severity = blocking || failed ? 'critical'
    : freshness === 'current' && percent >= 80 ? 'warning' : null;
  return {
    display,
    percent,
    progressPercent: Math.min(100, Math.max(0, percent)),
    targetPercent: display.source === 'pressure'
      ? Math.min(100, Math.max(0, display.targetTokens / Math.max(1, display.triggerTokens) * 100))
      : null,
    basis: display.source === 'pressure' ? 'trigger' : 'budget',
    freshness,
    freshnessKey: freshness === 'unavailable' ? 'contextMeasurementUnavailable'
      : status?.contextMeasurement?.measuredRevision == null ? 'contextMeasurementInitial' : 'contextMeasurementUpdating',
    blocking,
    failed,
    severity,
    needsCompaction: display.source === 'pressure' && percent >= 100,
  } as const;
}
