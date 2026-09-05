import { isTerminalSystemUpdateStatus, validateSystemUpdateEvent, type SystemUpdateEvent } from '@/cli/src/core/systemUpdateContract';
import { validateSystemUpdateOperationView, type SystemUpdateOperationView } from './types';

/** One operation, shared by REST and SSE; delayed responses cannot undo completion. */
export class SystemUpdateObservation {
  operation: SystemUpdateOperationView | null = null;
  cursor = 0;
  private readonly bySequence = new Map<number, SystemUpdateEvent>();

  constructor(readonly operationId: string) {}

  get events(): SystemUpdateEvent[] { return [...this.bySequence.values()].sort((a, b) => a.sequence - b.sequence); }

  acceptOperation(value: unknown): boolean {
    const next = validateSystemUpdateOperationView(value);
    if (!next || next.operationId !== this.operationId) return false;
    const previous = this.operation;
    if (previous && (isTerminalSystemUpdateStatus(previous.status) || next.lastSequence < previous.lastSequence ||
      (next.lastSequence === previous.lastSequence && Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)))) return false;
    this.operation = next;
    return true;
  }

  acceptEvents(values: unknown[]): void {
    for (const value of values) {
      const parsed = validateSystemUpdateEvent(value);
      if (!parsed.ok || parsed.value.operationId !== this.operationId) continue;
      if (!this.bySequence.has(parsed.value.sequence)) this.bySequence.set(parsed.value.sequence, parsed.value);
    }
    // Reconnect must request gaps, even if SSE delivered a later event first.
    while (this.bySequence.has(this.cursor + 1)) this.cursor++;
  }
}
