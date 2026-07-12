import 'server-only';

import {
  getExistingPiRuntime,
  invalidatePiRuntime,
  type PiRuntimeStatus,
} from '@/app/lib/pi/live-runtime';
import {
  withQuarantinablePiSessionOperationLock,
  type PiSessionOperationLease,
} from '@/app/lib/pi/session-operation-lock';

export type PiSessionExecutionReservation = {
  lease: PiSessionOperationLease;
  runReserved: <T>(signal: AbortSignal, operation: () => Promise<T>) => Promise<T>;
};

export class PiSessionBusyError extends Error {
  readonly code = 'PI_SESSION_BUSY';

  constructor() {
    super('The selected session is currently processing another request.');
    this.name = 'PiSessionBusyError';
  }
}

function runtimeStatusIsBusy(status: PiRuntimeStatus): boolean {
  return status.phase !== 'idle'
    || status.canAbort
    || status.pendingToolCalls > 0
    || status.followUpQueue.length > 0
    || status.steeringQueue.length > 0;
}

function assertReservationActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('The reserved session execution was aborted.');
  }
}

/**
 * Reserves a PI session for a non-live execution path. Existing active live
 * runtimes fail closed; idle runtimes are evicted so their in-memory history
 * cannot outlive database writes performed by the reserved operation.
 */
export async function withExclusivePiSessionExecution<T>(input: {
  sessionId: string;
  userId: string;
  beforeRuntimeCheck?: () => Promise<void>;
  operation: (reservation: PiSessionExecutionReservation) => Promise<T>;
}): Promise<T> {
  return withQuarantinablePiSessionOperationLock(input.sessionId, input.userId, async (lease) => {
    let reservationStarted = false;
    const runReserved: PiSessionExecutionReservation['runReserved'] = async (signal, operation) => {
      if (reservationStarted) {
        throw new Error('The selected session execution has already been reserved.');
      }
      reservationStarted = true;
      assertReservationActive(signal);
      await input.beforeRuntimeCheck?.();
      assertReservationActive(signal);
      const runtime = await getExistingPiRuntime(input.sessionId, input.userId);
      assertReservationActive(signal);
      if (runtime && runtimeStatusIsBusy(runtime.getStatus())) {
        throw new PiSessionBusyError();
      }
      if (runtime) {
        await invalidatePiRuntime(input.sessionId, input.userId);
        assertReservationActive(signal);
      }
      return operation();
    };
    return input.operation({ lease, runReserved });
  });
}
