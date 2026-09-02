import type { RuntimeContextPressure } from '@/app/lib/chat/runtime-status';
import type { PiContextBudgetSnapshot } from '@/app/lib/pi/context-budget';
import type { PiHistoryComposition } from '@/app/lib/pi/history-budget';

export type PiRuntimeContextStatusProjection = Readonly<{
  contextPressure: RuntimeContextPressure;
  nextRequestEstimatedTokens: number;
  nextRequestBudgetExceeded: boolean;
  nextRequestEstimateSource: 'rough_estimate' | 'serialized_request';
}>;

function toPercentOfTrigger(pressureTokens: number, triggerTokens: number): number {
  if (triggerTokens <= 0) return 0;
  return Math.max(0, Math.round((pressureTokens / triggerTokens) * 100));
}

/**
 * Projects runtime budgeting into UI-safe status values. Exact snapshots and
 * rough history projections intentionally share the same trigger denominator.
 */
export function createPiRuntimeContextStatusProjection(input: {
  composition: PiHistoryComposition;
  contextWindow: number;
  finalSnapshot?: PiContextBudgetSnapshot | null;
}): PiRuntimeContextStatusProjection {
  const snapshot = input.finalSnapshot ?? null;
  if (snapshot) {
    const fixedRequestTokens = snapshot.effectiveInstructionTokens
      + snapshot.toolSchemaTokens
      + snapshot.runtimeProviderOverheadTokens
      + snapshot.multimodalTokens
      + snapshot.safetyReserveTokens;
    const pressureTokens = Math.max(
      0,
      snapshot.estimatedTotalTokens - snapshot.outputReserveTokens - fixedRequestTokens,
    );
    const triggerTokens = snapshot.triggerHistoryTokens;
    return Object.freeze({
      contextPressure: {
        pressureTokens,
        source: 'serialized_request' as const,
        effectiveInputBudgetTokens: snapshot.hardHistoryTokens,
        triggerTokens,
        targetTokens: snapshot.targetTailTokens,
        percentOfTrigger: toPercentOfTrigger(pressureTokens, triggerTokens),
      },
      nextRequestEstimatedTokens: snapshot.estimatedTotalTokens,
      nextRequestBudgetExceeded: snapshot.contextBudgetExceeded || snapshot.payloadBudgetExceeded,
      nextRequestEstimateSource: 'serialized_request',
    });
  }

  const pressureTokens = input.composition.estimatedHistoryTokens;
  const triggerTokens = input.composition.triggerHistoryTokens;
  const fixedAndReservedTokens = Math.max(
    0,
    input.contextWindow - input.composition.availableHistoryTokens,
  );
  return Object.freeze({
    contextPressure: {
      pressureTokens,
      source: 'rough_estimate' as const,
      effectiveInputBudgetTokens: input.composition.availableHistoryTokens,
      triggerTokens,
      targetTokens: input.composition.targetHistoryTokens,
      percentOfTrigger: toPercentOfTrigger(pressureTokens, triggerTokens),
    },
    nextRequestEstimatedTokens: pressureTokens + fixedAndReservedTokens,
    nextRequestBudgetExceeded:
      input.composition.contextBudgetExceeded || input.composition.payloadBudgetExceeded,
    nextRequestEstimateSource: 'rough_estimate',
  });
}
