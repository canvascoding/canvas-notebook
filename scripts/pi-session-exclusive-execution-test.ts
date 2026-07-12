import assert from 'node:assert/strict';
import Module from 'node:module';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

type TestRuntime = {
  getStatus: () => {
    phase: string;
    canAbort: boolean;
    pendingToolCalls: number;
    followUpQueue: unknown[];
    steeringQueue: unknown[];
  };
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function main() {
  const moduleInternals = Module as typeof Module & { _load: LoadFn };
  const originalLoad = moduleInternals._load;
  let currentRuntime: TestRuntime | null = null;
  let runtimeLookupOverride: Promise<TestRuntime | null> | null = null;
  const invalidations: string[] = [];

  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request.endsWith('/pi/live-runtime')) {
      return {
        getExistingPiRuntime: async () => runtimeLookupOverride ?? currentRuntime,
        invalidatePiRuntime: async (sessionId: string, userId: string) => {
          invalidations.push(`${userId}:${sessionId}`);
          currentRuntime = null;
          return true;
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const {
      PiSessionBusyError,
      withExclusivePiSessionExecution,
    } = await import('../app/lib/pi/session-exclusive-execution');
    const {
      AutomationLoopShutdownError,
      runWithAutomationTimeout,
    } = await import('../app/lib/automations/run-timeout');
    const runReserved = <T>(
      reservation: {
        runReserved: <Result>(signal: AbortSignal, operation: () => Promise<Result>) => Promise<Result>;
      },
      operation: () => Promise<T>,
    ) => reservation.runReserved(new AbortController().signal, operation);

    let noRuntimeOperationRan = false;
    await withExclusivePiSessionExecution({
      sessionId: 'no-runtime',
      userId: 'user',
      operation: (reservation) => runReserved(reservation, async () => {
        noRuntimeOperationRan = true;
      }),
    });
    assert.equal(noRuntimeOperationRan, true);

    currentRuntime = {
      getStatus: () => ({
        phase: 'idle',
        canAbort: false,
        pendingToolCalls: 0,
        followUpQueue: [],
        steeringQueue: [],
      }),
    };
    const idleOrder: string[] = [];
    await withExclusivePiSessionExecution({
      sessionId: 'idle-runtime',
      userId: 'user',
      operation: (reservation) => runReserved(reservation, async () => {
        idleOrder.push('operation');
        assert.equal(currentRuntime, null, 'the idle in-memory runtime must be evicted before database writes');
      }),
    });
    assert.deepEqual(invalidations, ['user:idle-runtime']);
    assert.deepEqual(idleOrder, ['operation']);

    currentRuntime = {
      getStatus: () => ({
        phase: 'idle',
        canAbort: false,
        pendingToolCalls: 0,
        followUpQueue: [],
        steeringQueue: [],
      }),
    };
    let lostClaimOperationRan = false;
    await assert.rejects(
      withExclusivePiSessionExecution({
        sessionId: 'lost-claim',
        userId: 'user',
        beforeRuntimeCheck: async () => {
          throw new Error('claim lost');
        },
        operation: (reservation) => runReserved(reservation, async () => {
          lostClaimOperationRan = true;
        }),
      }),
      /claim lost/,
    );
    assert.equal(lostClaimOperationRan, false);
    assert.deepEqual(
      invalidations,
      ['user:idle-runtime'],
      'claim revalidation must run before an idle live runtime is invalidated',
    );

    currentRuntime = {
      getStatus: () => ({
        phase: 'streaming',
        canAbort: true,
        pendingToolCalls: 0,
        followUpQueue: [],
        steeringQueue: [],
      }),
    };
    let busyOperationRan = false;
    await assert.rejects(
      withExclusivePiSessionExecution({
        sessionId: 'busy-runtime',
        userId: 'user',
        operation: (reservation) => runReserved(reservation, async () => {
          busyOperationRan = true;
        }),
      }),
      (error: unknown) => error instanceof PiSessionBusyError,
    );
    assert.equal(busyOperationRan, false);
    assert.deepEqual(invalidations, ['user:idle-runtime']);

    currentRuntime = null;
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const serializedOrder: string[] = [];
    const first = withExclusivePiSessionExecution({
      sessionId: 'serialized',
      userId: 'user',
      operation: (reservation) => runReserved(reservation, async () => {
        serializedOrder.push('first:start');
        firstEntered.resolve();
        await releaseFirst.promise;
        serializedOrder.push('first:end');
      }),
    });
    await firstEntered.promise;
    const second = withExclusivePiSessionExecution({
      sessionId: 'serialized',
      userId: 'user',
      operation: (reservation) => runReserved(reservation, async () => {
        serializedOrder.push('second');
      }),
    });
    await Promise.resolve();
    assert.deepEqual(serializedOrder, ['first:start']);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(serializedOrder, ['first:start', 'first:end', 'second']);

    currentRuntime = null;
    const releaseRuntimeLookup = deferred();
    runtimeLookupOverride = releaseRuntimeLookup.promise.then(() => null);
    await assert.rejects(
      withExclusivePiSessionExecution({
        sessionId: 'runtime-preflight-timeout',
        userId: 'user',
        operation: async (reservation) => {
          try {
            return await runWithAutomationTimeout({
              timeoutMs: 5,
              abortGraceMs: 10,
              operation: (signal) => reservation.runReserved(signal, async () => undefined),
            });
          } catch (error) {
            if (error instanceof AutomationLoopShutdownError) {
              reservation.lease.holdUntil(error.operationSettlement);
            }
            throw error;
          }
        },
      }),
      (error: unknown) => error instanceof AutomationLoopShutdownError,
    );
    let preflightFollowerRan = false;
    const preflightFollower = withExclusivePiSessionExecution({
      sessionId: 'runtime-preflight-timeout',
      userId: 'user',
      operation: (reservation) => runReserved(reservation, async () => {
        preflightFollowerRan = true;
      }),
    });
    await Promise.resolve();
    assert.equal(preflightFollowerRan, false, 'a timed-out runtime preflight must keep the session quarantined');
    runtimeLookupOverride = null;
    releaseRuntimeLookup.resolve();
    await preflightFollower;
    assert.equal(preflightFollowerRan, true);

    const releaseQuarantine = deferred();
    let quarantinedFollowerRan = false;
    await withExclusivePiSessionExecution({
      sessionId: 'quarantined',
      userId: 'user',
      operation: (reservation) => runReserved(reservation, async () => {
        reservation.lease.holdUntil(releaseQuarantine.promise);
      }),
    });
    const quarantinedFollower = withExclusivePiSessionExecution({
      sessionId: 'quarantined',
      userId: 'user',
      operation: (reservation) => runReserved(reservation, async () => {
        quarantinedFollowerRan = true;
      }),
    });
    await Promise.resolve();
    assert.equal(
      quarantinedFollowerRan,
      false,
      'the operation callback may return while the session remains quarantined',
    );
    releaseQuarantine.resolve();
    await quarantinedFollower;
    assert.equal(quarantinedFollowerRan, true);

    console.log('pi-session-exclusive-execution-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

void main();
