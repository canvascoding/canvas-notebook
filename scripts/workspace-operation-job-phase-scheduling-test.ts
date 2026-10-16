import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import { WorkspaceOperationBatchStore, type WorkspaceOperationBatchClaim } from '../app/lib/files/workspace-operation-batch-store';
import { createWorkspaceOperationBatchWorker } from '../app/lib/files/workspace-operation-batch-worker';
import { withWorkspaceOperationJobClaimPhase as phase, withWorkspaceOperationJobClaimScheduling as scheduling,
  WorkspaceOperationJobPhaseSchedulingError } from '../app/lib/files/workspace-operation-job-phase-scheduling';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { runPgliteFixture } from './helpers/pglite-pool-harness';

// Real embedded SQL mints the original Store claims. Controlled interval calls
// prove scheduling, not independent PostgreSQL backends, Owner-B or file writes.
const sources = ['app/lib/files/workspace-operation-job-phase-scheduling.ts',
  'app/lib/files/workspace-operation-batch-worker.ts', 'scripts/workspace-operation-job-phase-scheduling-test.ts'];
const hashes = () => Promise.all(sources.map(async file => createHash('sha256').update(await readFile(file)).digest('hex')));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const includesError = (error: unknown, expected: unknown): boolean => error === expected
  || error instanceof AggregateError && error.errors.some(child => includesError(child, expected));
const code = (expected: string) => (error: unknown): boolean => error instanceof Error
  && (Object.getOwnPropertyDescriptor(error, 'code')?.value === expected
    || error instanceof AggregateError && error.errors.some(child => code(expected)(child)));
const noScheduling = { pauseAndDrain: async () => undefined, resume: async () => undefined };
const result = { status: 'applied' as const, completedActions: 1, totalActions: 1, trashEntryIds: [], errorCode: null };

function manualWorkerIntervals() {
  const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setInterval')!;
  const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'clearInterval')!;
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  const intervals = new Map<ReturnType<typeof setInterval>, () => void>();
  let onClear: (() => void) | undefined;
  const set = ((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 20_000) return Reflect.apply(originalSet, globalThis, [callback, delay, ...args]);
    const token = { unref: () => token } as ReturnType<typeof setInterval>;
    intervals.set(token, callback); return token;
  }) as typeof setInterval;
  const clear = ((token: ReturnType<typeof setInterval>) => {
    if (!intervals.delete(token)) return originalClear(token);
    onClear?.();
  }) as typeof clearInterval;
  Object.defineProperty(globalThis, 'setInterval', { ...setDescriptor, value: set });
  Object.defineProperty(globalThis, 'clearInterval', { ...clearDescriptor, value: clear });
  let restored = false;
  return {
    get size() { return intervals.size; },
    first() { assert.equal(intervals.size, 1); return [...intervals.values()][0]; },
    observeClear(operation: () => void) { onClear = operation; },
    restore() {
      if (restored) return; restored = true;
      Object.defineProperty(globalThis, 'setInterval', setDescriptor);
      Object.defineProperty(globalThis, 'clearInterval', clearDescriptor);
      assert.equal(intervals.size, 0, 'every owned worker interval must have been cleared');
    },
  };
}

async function main(): Promise<void> {
  const pinned = await hashes(), sql = new PGlite();
  let openConnections = 0, families = 0;
  const connect = async (): Promise<SqlConnection> => {
    openConnections += 1; let closed = false;
    return {
      get: async (query, values) => (await sql.query(query, values)).rows[0],
      all: async (query, values) => (await sql.query(query, values)).rows,
      run: async (query, values) => { const answer = await sql.query(query, values); return { changes: answer.affectedRows ?? 0 }; },
      close: () => { assert.equal(closed, false); closed = true; openConnections -= 1; },
    };
  };
  const store = new WorkspaceOperationBatchStore(connect);
  const create = async () => {
    const workspaceId = `scheduling-${randomUUID()}`;
    const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId, workspaceType: 'personal',
      ownerUserId: 'scheduling-user', rootPath: `/scheduling-fixture/${workspaceId}`, legacy: false, status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
        canManageWorkspace: true, canRunAgent: true } }, fileOptions: {} };
    scope.fileOptions.workspace = scope.workspace;
    const plan: WorkspaceOperationBatchPlan = { version: 1, workspaceId, planId: 'a'.repeat(64), readiness: 'ready',
      actions: [{ reviewId: 'scheduling-action', kind: 'delete', selections: [{ sourcePath: ' original.md' }] }],
      pathSteps: [{ reviewId: 'scheduling-action', kind: 'delete', sourcePath: ' original.md' }], pathMappings: [],
      deletedPaths: [], linkEdits: [], originalDocuments: [], previewContents: [], expectedPathState: [],
      coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
      linkAssessment: { version: 1, complete: true, blockers: [], warnings: [] }, issues: [], linkPlan: {} as never };
    const row = await store.createDirect({ batchId: randomUUID(), plan, authorization: { mode: 'direct', actorUserId: 'scheduling-user',
      actorId: 'scheduling-user', actorType: 'user', actorDisplayName: 'Scheduling user', requestHash: 'b'.repeat(64),
      jobScope: captureWorkspaceOperationJobScope(scope.workspace) } });
    return { row, scope, plan };
  };
  const runClaim = async <T>(operation: (claim: WorkspaceOperationBatchClaim) => Promise<T>) => {
    await create(); const original = await store.claim(randomUUID()); assert(original);
    return store.withClaim(original, operation);
  };
  const family = async (label: string, operation: () => Promise<void>) => {
    await sql.exec('TRUNCATE workspace_file_operation_reviews,workspace_file_operation_batches');
    await operation(); assert.equal(openConnections, 0); families += 1;
    console.log(`phase scheduling: ${label} passed`);
  };
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await sql.exec(statement);
    await family('standalone real claim permits consecutive phases without minting a schedule', async () => {
      await runClaim(async claim => {
        assert.equal(await phase(claim, async () => 'first'), 'first');
        assert.equal(await phase(claim, async () => 'second'), 'second');
      });
    });
    await family('forged claim cannot register or reach a phase callback', async () => {
      let reached = false;
      await assert.rejects(runClaim(async () => {
        await assert.rejects(scheduling({} as WorkspaceOperationBatchClaim, noScheduling, async () => { reached = true; }), code('BATCH_CLAIM_REQUIRED'));
      }), code('BATCH_CLAIM_REQUIRED'));
      await assert.rejects(phase({} as WorkspaceOperationBatchClaim, async () => { reached = true; }), code('BATCH_CLAIM_REQUIRED'));
      assert.equal(reached, false);
    });
    await family('registered serial phases pause resume and finally drain in order', async () => {
      const order: string[] = [];
      await runClaim(claim => scheduling(claim, { pauseAndDrain: async () => { order.push('pause'); },
        resume: async () => { order.push('resume'); } }, async () => {
        assert.equal(await phase(claim, async () => { order.push('phase1'); return 1; }), 1);
        order.push('fs'); await phase(claim, async () => { order.push('phase2'); });
      }));
      assert.deepEqual(order, ['pause', 'phase1', 'resume', 'fs', 'pause', 'phase2', 'resume', 'pause']);
    });
    await family('inflight pause is actually drained before operation enters', async () => {
      const started = deferred(), release = deferred(); let entered = false;
      await runClaim(claim => scheduling(claim, { pauseAndDrain: async () => { started.resolve(); await release.promise; },
        resume: async () => undefined }, async () => {
        const pending = phase(claim, async () => { entered = true; });
        await started.promise; assert.equal(entered, false); release.resolve(); await pending;
      }));
      assert.equal(entered, true);
    });
    await family('caught nested phase poisons the registered invocation', async () => {
      await assert.rejects(runClaim(claim => scheduling(claim, noScheduling, async () => {
        await assert.rejects(phase(claim, async () => {
          await assert.rejects(phase(claim, async () => assert.fail('nested phase entered')), code('JOB_PHASE_SCHEDULING_REENTRANT'));
        }), code('JOB_PHASE_SCHEDULING_REENTRANT'));
      })), code('JOB_PHASE_SCHEDULING_REENTRANT'));
    });
    await family('parallel phase from sibling context poisons and drains original phase', async () => {
      const started = deferred(), release = deferred(); let settled = false;
      await assert.rejects(runClaim(claim => scheduling(claim, noScheduling, async () => {
        const original = phase(claim, async () => { started.resolve(); await release.promise; settled = true; });
        await started.promise;
        await assert.rejects(phase(claim, async () => assert.fail('parallel phase entered')), code('JOB_PHASE_SCHEDULING_REENTRANT'));
        release.resolve(); await assert.rejects(original, code('JOB_PHASE_SCHEDULING_REENTRANT'));
      })), code('JOB_PHASE_SCHEDULING_REENTRANT'));
      assert.equal(settled, true);
    });
    await family('detached phase is awaited and cannot produce success', async () => {
      const started = deferred(), release = deferred(), returning = deferred(); let finished = false;
      const pending = runClaim(claim => scheduling(claim, noScheduling, async () => {
        void phase(claim, async () => { started.resolve(); await release.promise; finished = true; }).catch(() => undefined);
        await started.promise; returning.resolve();
      }));
      await returning.promise; assert.equal(finished, false); release.resolve();
      await assert.rejects(pending, code('JOB_PHASE_SCHEDULING_DETACHED')); assert.equal(finished, true);
    });
    await family('retained registered phase cannot fall back to standalone before claim closes', async () => {
      await runClaim(async claim => {
        let retained!: () => Promise<void>;
        await scheduling(claim, noScheduling, async () => { retained = () => phase(claim, async () => assert.fail('retained phase entered')); });
        await assert.rejects(retained(), code('JOB_PHASE_SCHEDULING_REQUIRED'));
      });
    });
    await family('retained phase context cannot enter a new phase after settlement', async () => {
      const late = deferred(); let escaped: Promise<void> | undefined;
      await runClaim(async claim => {
        await scheduling(claim, noScheduling, async () => {
          await phase(claim, async () => {
            escaped = (async () => { await late.promise; await assert.rejects(phase(claim,
              async () => assert.fail('escaped phase entered')), code('JOB_PHASE_SCHEDULING_REENTRANT')); })();
          });
        });
        late.resolve(); await escaped;
      });
    });
    await family('invalid hook accessors are not invoked', async () => {
      let touched = false;
      await assert.rejects(runClaim(claim => scheduling(claim, { get pauseAndDrain() { touched = true; return async () => undefined; },
        resume: async () => undefined }, async () => assert.fail('invalid hooks entered'))), code('JOB_PHASE_SCHEDULING_REQUIRED'));
      assert.equal(touched, false);
    });
    for (const value of [undefined, null, false]) await family(`non-Error callback rejection ${String(value)} stays failed`, async () => {
      await assert.rejects(runClaim(claim => scheduling(claim, noScheduling, () => phase(claim, async () => { throw value; }))),
        code('JOB_PHASE_SCHEDULING_FAILED'));
    });
    await family('ordinary primary identity survives successful cleanup', async () => {
      const primary = new Error('Expected controlled primary failure.');
      await assert.rejects(runClaim(claim => scheduling(claim, noScheduling, () => phase(claim, async () => { throw primary; }))),
        error => error === primary);
    });
    await family('uncertain primary status and code survive resume and final drain failures', async () => {
      const primary = Object.assign(new Error('Controlled uncertain phase result.'), { code: 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED', status: 503 });
      const resumed = Object.assign(new Error('Controlled resume failure.'), { code: 'RESUME_FAILED', status: 409 });
      const drained = new Error('Controlled final drain failure.'); let pauses = 0;
      await assert.rejects(runClaim(claim => scheduling(claim, { pauseAndDrain: async () => { if (++pauses === 2) throw drained; },
        resume: async () => { throw resumed; } }, () => phase(claim, async () => { throw primary; }))), error => {
        assert(error instanceof AggregateError); assert.equal(Object.getOwnPropertyDescriptor(error, 'status')?.value, 503);
        assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED');
        for (const expected of [primary, resumed, drained]) assert(includesError(error, expected)); return true;
      });
    });
    await family('uncertain cleanup upgrades a confirmed ordinary primary failure', async () => {
      const primary = Object.assign(new Error('Controlled ordinary failure.'), { code: 'ORDINARY_FAILURE', status: 409 });
      const cleanup = Object.assign(new Error('Controlled unconfirmed disposal.'), { code: 'DISPOSAL_UNCONFIRMED', status: 503 });
      await assert.rejects(runClaim(claim => scheduling(claim, { pauseAndDrain: async () => undefined,
        resume: async () => { throw cleanup; } }, () => phase(claim, async () => { throw primary; }))), error => {
        assert(error instanceof AggregateError); assert.equal(Object.getOwnPropertyDescriptor(error, 'status')?.value, 503);
        assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, 'DISPOSAL_UNCONFIRMED');
        assert(includesError(error, primary)); assert(includesError(error, cleanup)); return true;
      });
    });
    await family('caught late phase during final asynchronous cleanup still rejects', async () => {
      await assert.rejects(runClaim(async claim => {
        let finalPause = false;
        await scheduling(claim, { pauseAndDrain: async () => {
          if (finalPause) await assert.rejects(phase(claim, async () => assert.fail('late cleanup phase entered')),
            code('JOB_PHASE_SCHEDULING_REQUIRED'));
        }, resume: async () => undefined }, async () => { finalPause = true; });
      }), code('JOB_PHASE_SCHEDULING_REQUIRED'));
    });
    await family('actual Worker drains periodic heartbeat then renews between complete phases', async () => {
      const fixture = await create(), timers = manualWorkerIntervals();
      const heartbeat = store.heartbeatClaim.bind(store), renewalStarted = deferred(), renewalRelease = deferred();
      let insidePhase = false, hold = false, heartbeats = 0, lastHeartbeat: Promise<boolean> | undefined;
      store.heartbeatClaim = (original, progress) => {
        lastHeartbeat = (async () => {
          assert.equal(insidePhase, false, 'no heartbeat starts while the bounded phase is active'); heartbeats += 1;
          if (hold) { hold = false; renewalStarted.resolve(); await renewalRelease.promise; }
          return heartbeat(original, progress);
        })(); return lastHeartbeat;
      };
      try {
        const worker = createWorkspaceOperationBatchWorker({ store, resolveScope: async () => fixture.scope,
          lock: async (_workspaceId, operation) => operation(), buildPlan: async () => fixture.plan,
          hasExecution: async () => false, dependentReviews: async () => undefined, projectFileViews: () => undefined,
          execute: async input => {
            assert(input.jobClaim); const before = heartbeats, oldInterval = timers.first();
            hold = true; oldInterval(); await renewalStarted.promise;
            const cleared = deferred(), entered = deferred(), phaseRelease = deferred();
            timers.observeClear(cleared.resolve); let enteredPhase = false;
            const pending = phase(input.jobClaim, async () => {
              enteredPhase = true; insidePhase = true; entered.resolve();
              try { await phaseRelease.promise; } finally { insidePhase = false; }
            });
            await cleared.promise; assert.equal(enteredPhase, false); assert.equal(timers.size, 0);
            renewalRelease.resolve(); await entered.promise; const pausedCount = heartbeats;
            oldInterval(); await Promise.resolve(); assert.equal(heartbeats, pausedCount);
            phaseRelease.resolve(); await pending; assert.equal(heartbeats, before + 2); assert.equal(timers.size, 1);
            timers.first()(); await lastHeartbeat; assert.equal(heartbeats, before + 3, 'periodic renewal remains enabled during later FS work');
            await phase(input.jobClaim, async () => { insidePhase = true; assert.equal(timers.size, 0); insidePhase = false; });
            assert.equal(heartbeats, before + 4); return result;
          } });
        assert.equal(await worker.tick(), true); assert.equal(timers.size, 0);
        assert.equal((await store.get(fixture.row.batchId))?.status, 'applied');
      } finally { store.heartbeatClaim = heartbeat; timers.restore(); }
    });
    await family('actual Worker cannot finish success after a caught phase failure', async () => {
      const fixture = await create(), primary = new WorkspaceOperationJobPhaseSchedulingError('JOB_PHASE_SCHEDULING_FAILED');
      let projections = 0;
      const worker = createWorkspaceOperationBatchWorker({ store, resolveScope: async () => fixture.scope,
        lock: async (_workspaceId, operation) => operation(), buildPlan: async () => fixture.plan,
        hasExecution: async () => true, mutationEvidence: async () => 'started',
        dependentReviews: async () => assert.fail('failed execution cannot update dependent reviews'),
        projectFileViews: () => { projections += 1; }, execute: async input => {
          assert(input.jobClaim); await assert.rejects(phase(input.jobClaim, async () => { throw primary; }), error => error === primary);
          return result;
        } });
      assert.equal(await worker.tick(), true); assert.equal(projections, 0);
      const persisted = await store.get(fixture.row.batchId); assert(persisted);
      assert.equal(persisted.status, 'needs_recovery'); assert.equal(persisted.errorCode, primary.code);
    });
    await family('actual Worker Undo receives identical scheduling without original agent grants', async () => {
      const fixture = await create(), original = await store.claim(randomUUID()); assert(original);
      await store.finish(original.batchId, original.leaseOwner!, { status: 'applied', completedActions: 1 });
      await store.enqueue({ batchId: fixture.row.batchId, planId: fixture.plan.planId,
        userId: 'scheduling-user', displayName: 'Scheduling user', action: 'undo' });
      const timers = manualWorkerIntervals(); let calls = 0;
      try {
        const worker = createWorkspaceOperationBatchWorker({ store, resolveScope: async () => fixture.scope,
          lock: async (_workspaceId, operation) => operation(), hasExecution: async () => true, mutationEvidence: async () => 'complete',
          dependentReviews: async () => undefined, projectFileViews: () => undefined, undo: async input => {
            assert(input.jobClaim); assert.equal(input.actorType, 'user');
            await phase(input.jobClaim, async () => { assert.equal(timers.size, 0); calls += 1; });
            assert.equal(timers.size, 1); return result;
          } });
        assert.equal(await worker.tick(), true); assert.equal(calls, 1);
        assert.equal((await store.get(fixture.row.batchId))?.status, 'undone');
      } finally { timers.restore(); }
    });
    console.log(`phase scheduling: ${families} embedded SQL and controlled scheduling families passed`);
  } finally {
    try { assert.equal(openConnections, 0); await sql.close(); }
    finally { assert.deepEqual(await hashes(), pinned); }
  }
}

void runPgliteFixture({ label: 'workspace-operation-job-phase-scheduling-test', operation: main,
  successMessage: 'workspace-operation-job-phase-scheduling-test: all scheduling assertions and cleanup passed' });
