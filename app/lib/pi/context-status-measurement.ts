import type { RuntimeContextMeasurement } from '../chat/runtime-status';
import type { PiHistoryComposition } from './history-budget';
import { preparePiFinalPayload } from './multimodal-preparation';
import { createPiRuntimeContextStatusProjection, type PiRuntimeContextStatusProjection } from './runtime-context-status';

/** Display-only measurement. Never invokes a model, compacts, or persists history. */
export async function measurePiContextStatus(
  composition: PiHistoryComposition,
  input: Parameters<typeof preparePiFinalPayload>[0],
  options?: Parameters<typeof preparePiFinalPayload>[1],
): Promise<PiRuntimeContextStatusProjection> {
  // An oversized history can have an empty llmMessages projection. Do not
  // normalize that empty projection and accidentally report an empty context.
  const prepared = composition.payloadBudgetExceeded
    ? null
    : await preparePiFinalPayload(input, options);
  const projection = createPiRuntimeContextStatusProjection({
    composition,
    contextWindow: input.model.contextWindow,
    finalSnapshot: prepared?.budgetSnapshot,
  });
  const snapshot = prepared?.budgetSnapshot;
  return snapshot ? {
    ...projection,
    components: {
      instructions: snapshot.effectiveInstructionTokens,
      messages: snapshot.serializedMessageTokens,
      tools: snapshot.toolSchemaTokens,
      overhead: snapshot.runtimeProviderOverheadTokens,
      multimodal: snapshot.multimodalTokens,
      outputReserve: snapshot.outputReserveTokens,
      safetyReserve: snapshot.safetyReserveTokens,
    },
  } : projection;
}

/** One measurement per context revision; phase and token deltas are not revisions. */
export class ContextStatusMeasurementCache {
  private revision = 0;
  private attemptedRevision = -1;
  private disposed = false;
  private value: PiRuntimeContextStatusProjection | null = null;
  private measuredRevision: number | null = null;
  private measuredAt: string | null = null;
  private pending = false;

  invalidate(): void {
    this.revision += 1;
  }

  get metadata(): RuntimeContextMeasurement {
    return {
      scope: 'live',
      revision: this.revision,
      measuredRevision: this.measuredRevision,
      measuredAt: this.measuredAt,
      state: this.measuredRevision === this.revision ? 'current'
        : this.pending || this.attemptedRevision !== this.revision ? 'updating' : 'unavailable',
    };
  }

  get current(): PiRuntimeContextStatusProjection | null {
    return this.value;
  }

  refresh(
    measure: () => Promise<PiRuntimeContextStatusProjection>,
    publish: (accepted: boolean) => void,
  ): void {
    if (this.disposed || this.attemptedRevision === this.revision) return;
    const revision = this.revision;
    this.attemptedRevision = revision;
    this.pending = true;
    // Defer until the agent has finished inserting the message that emitted
    // message_end. No normalization runs synchronously on a status read.
    void Promise.resolve().then(measure).then((value) => {
      if (this.disposed || revision !== this.revision) return;
      this.value = value;
      this.measuredRevision = revision;
      this.measuredAt = new Date().toISOString();
      this.pending = false;
      publish(true);
    }, () => {
      if (this.disposed || revision !== this.revision) return;
      this.pending = false;
      publish(false);
    }).catch(() => {
      // A status subscriber failure must not invalidate a successful measurement.
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}
