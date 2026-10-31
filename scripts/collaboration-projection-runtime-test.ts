import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test, type TestContext } from 'node:test';
import ts from 'typescript';
import { CollaborationCopyPublicationPendingError, CollaborationFileOperationProjectionPendingError, CollaborationCheckpointValidationError, COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';
import { createCollaborationProjectionScheduler, type CollaborationProjectionRequest } from '../app/lib/collaboration/projection-scheduler';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type * as Runtime from '../app/lib/collaboration/projection-runtime';
import { classifyCollaborationProjectionError } from '../app/lib/collaboration/projection-errors';

type Callbacks = Parameters<typeof Runtime.createCollaborationProjectionRuntime>[0];
type ProjectionResult = Parameters<Callbacks['onProjected']>[0];
type ProjectionFailure = Parameters<Callbacks['onFailure']>[0];
type Timer = ReturnType<typeof setTimeout>;
type NotificationOptions = Extract<Parameters<typeof import('../app/lib/filesystem/workspace-file-invalidation')
  .installWorkspaceFileInvalidationNotificationListener>[0], { allWorkspaces: true }>;

async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); }

function createClock() {
  let current = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => current,
    setTimer(callback: () => void, delay: number): Timer {
      const id = ++nextId;
      timers.set(id, { at: current + delay, callback });
      return id as unknown as Timer;
    },
    clearTimer(timer: Timer) { timers.delete(timer as unknown as number); },
    async advanceTo(target: number) {
      assert.ok(target >= current);
      await settle();
      for (let count = 0; ; count++) {
        assert.ok(count < 1_000, 'background work cannot spin without a delay');
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        current = next[1].at;
        next[1].callback();
        await settle();
      }
      current = target;
      await settle();
    },
  };
}

function state(documentId = 'document-a', changes: Partial<PersistedCollaborationState> = {}): PersistedCollaborationState {
  return {
    documentId, workspaceId: 'workspace', organizationId: 'organization', path: 'document.md',
    representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: new Uint8Array([0, 0]), stateVector: new Uint8Array([0]),
    documentSequence: 2, checkpointSequence: 1, persistedAt: 1, checkpointedAt: 0,
    canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false,
    degraded: false, status: 'active', ...changes,
  };
}

class SupersededError extends Error {}

async function setup(t: TestContext, options: {
  states?: PersistedCollaborationState[];
  pendingReceipts?: string[];
  project?: (snapshot: PersistedCollaborationState) => Promise<ProjectionResult>;
  scan?: (cursor: string) => Promise<CollaborationProjectionRequest[]>;
  guestVersion?: (snapshot: PersistedCollaborationState) => Promise<void>;
  lock?: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
} = {}) {
  const clock = createClock();
  const states = new Map((options.states ?? []).map((snapshot) => [snapshot.documentId, snapshot]));
  const pendingReceipts = new Set(options.pendingReceipts);
  const projected: ProjectionResult[] = [];
  const failures: ProjectionFailure[] = [];
  const attempted: PersistedCollaborationState[] = [];
  const degraded: Array<[string, number]> = [];
  const recordedFailures: PersistedCollaborationState[] = [];
  const scans: string[] = [];
  const diagnostics: Array<{ level: string; data: Record<string, unknown> }> = [];
  const guestVersions: PersistedCollaborationState[] = [];
  const workspaceReads: string[] = [];
  let workspaceAvailable = true;
  let notificationOptions!: NotificationOptions;
  let notificationStopped = false;
  let notificationPoolEnded = false;
  const notificationPool = { end: async () => { notificationPoolEnded = true; } };
  const pending = (snapshot: PersistedCollaborationState) => snapshot.status === 'active'
    && (snapshot.documentSequence > snapshot.checkpointSequence || pendingReceipts.has(snapshot.documentId));
  const filename = path.resolve('app/lib/collaboration/projection-runtime.ts');
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exports = {};
  const dependencies: Record<string, unknown> = {
    'server-only': {},
    '@/app/lib/db/postgres': { createPostgresPool: () => notificationPool },
    // Controlled notification seam only. PostgreSQL delivery and native
    // owner/COMMIT behavior are exercised by separate real database cases.
    '@/app/lib/filesystem/workspace-file-invalidation': {
      installWorkspaceFileInvalidationNotificationListener: (input: NotificationOptions) => {
        assert.equal(input.allWorkspaces, true);
        assert.equal(input.pool, notificationPool, 'the background listener cannot retain an application-pool slot');
        notificationOptions = input;
        return { ready: Promise.resolve(), resync: () => input.onResync(),
          stop: async () => { notificationStopped = true; } };
      },
    },
    '@/app/lib/files/workspace-mutation-lock': { withWorkspaceMutationLock: options.lock
      ?? (async <T>(_workspaceId: string, operation: () => Promise<T>) => operation()) },
    '@/app/lib/file-guests/versions': { recordFileGuestVersion: async (snapshot: PersistedCollaborationState) => {
      guestVersions.push(snapshot);
      await options.guestVersion?.(snapshot);
    } },
    './checkpoint': {
      CollaborationCheckpointSupersededError: SupersededError,
      materializeCollaborationCheckpoint: async (input: { state: PersistedCollaborationState; actorType: string }) => {
        assert.equal(input.actorType, 'system', 'projection is not an additional user or agent edit');
        attempted.push(input.state);
        const result = options.project ? await options.project(input.state)
          : { state: { ...input.state, checkpointSequence: input.state.documentSequence }, content: 'projected', revisionId: 'revision' };
        states.set(result.state.documentId, result.state);
        pendingReceipts.delete(result.state.documentId);
        return result;
      },
    },
    './checkpoint-errors': { CollaborationCopyPublicationPendingError, CollaborationFileOperationProjectionPendingError, CollaborationCheckpointValidationError, COLLABORATION_CHECKPOINT_ERROR_CODES },
    './projection-errors': { classifyCollaborationProjectionError },
    './diagnostics': { logCollaborationDiagnostic: (level: string, data: Record<string, unknown>) => diagnostics.push({ level, data }) },
    './persistence': {
      loadCollaborationState: async (documentId: string) => states.get(documentId) ?? null,
      markCollaborationDegraded: async (documentId: string, generation: number) => { degraded.push([documentId, generation]); },
    },
    './projection-repository': {
      recordCollaborationProjectionFailure: async (snapshot: PersistedCollaborationState, failure: { code: string; permanent: boolean; phase: string }) => {
        recordedFailures.push(snapshot);
        const current = states.get(snapshot.documentId);
        if (current && current.lifecycleGeneration === snapshot.lifecycleGeneration
          && (!failure.permanent || current.documentSequence === snapshot.documentSequence)) {
          if (failure.permanent) degraded.push([snapshot.documentId, snapshot.lifecycleGeneration]);
          states.set(snapshot.documentId,
          { ...current, degraded: failure.permanent, projectionError: { code: failure.code,
            sequence: snapshot.documentSequence, permanent: failure.permanent, phase: failure.phase } });
        }
      },
      hasPendingCollaborationProjection: async (snapshot: PersistedCollaborationState) => pending(snapshot),
      loadCollaborationProjectionWorkspace: async (snapshot: PersistedCollaborationState) => {
        workspaceReads.push(snapshot.documentId);
        return workspaceAvailable ? { workspaceId: snapshot.workspaceId } : null;
      },
      listPendingCollaborationProjections: async (cursor = '') => {
        scans.push(cursor);
        return options.scan ? options.scan(cursor) : [...states.values()]
          .filter((snapshot) => snapshot.documentId > cursor && pending(snapshot))
          .sort((a, b) => a.documentId.localeCompare(b.documentId)).slice(0, 100);
      },
    },
    './projection-scheduler': {
      createCollaborationProjectionScheduler: (input: Parameters<typeof createCollaborationProjectionScheduler>[0]) => (
        createCollaborationProjectionScheduler({ ...input, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
      ),
    },
  };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', compiled.outputText)(
    (name: string) => {
      assert.ok(name in dependencies, `unexpected runtime dependency: ${name}`);
      return dependencies[name];
    }, { exports }, exports, clock.setTimer, clock.clearTimer,
  );
  const runtimeModule = exports as typeof Runtime;
  const runtime = runtimeModule.createCollaborationProjectionRuntime({
    onProjected: (result) => projected.push(result), onFailure: (failure) => failures.push(failure),
  });
  t.after(() => runtime.dispose());
  await settle();
  return { clock, runtime, states, pendingReceipts, projected, failures, attempted, degraded, scans, diagnostics,
    signal: () => notificationStopped ? Promise.resolve() : Promise.resolve(notificationOptions.onInvalidate({ workspaceId: 'workspace' })),
    reconnect: () => notificationStopped ? Promise.resolve() : Promise.resolve(notificationOptions.onResync()),
    notificationStopped: () => notificationStopped,
    notificationPoolEnded: () => notificationPoolEnded,
    guestVersions, workspaceReads, recordedFailures, setWorkspaceAvailable: (value: boolean) => { workspaceAvailable = value; } };
}

test('a commit hint rediscovers durable work without waiting for the recovery timer', async t => {
  const h = await setup(t);
  const latest = state('hinted-document', { documentSequence: 8 });
  h.states.set(latest.documentId, latest);
  await h.signal();
  await h.clock.advanceTo(2_000);
  assert.deepEqual(h.attempted, [latest]);
  assert.deepEqual(h.scans, ['', '']);
});

test('notification reconnect scans durable work missed while disconnected', async t => {
  const h = await setup(t);
  const latest = state('missed-document', { documentSequence: 9 });
  h.states.set(latest.documentId, latest);
  await h.reconnect();
  await h.clock.advanceTo(2_000);
  assert.deepEqual(h.attempted, [latest]);
  assert.deepEqual(h.scans, ['', '']);
});

test('a burst during one recovery scan requests only one following fresh scan', async t => {
  let held = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await setup(t, { scan: async () => { if (held) await gate; return []; } });
  try {
    held = true;
    const first = h.signal(); await settle();
    const burst = Array.from({ length: 100 }, () => h.signal());
    assert.deepEqual(h.scans, ['', '']);
    held = false; release();
    await Promise.all([first, ...burst]);
    assert.deepEqual(h.scans, ['', '', '']);
    await h.clock.advanceTo(29_999);
    assert.equal(h.scans.length, 3);
  } finally { held = false; release(); }
});

test('disposal closes notifications and waits for an already running recovery scan', async t => {
  let held = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await setup(t, { scan: async () => { if (held) await gate; return []; } });
  try {
    held = true;
    const pending = h.signal(); await settle();
    let stopped = false;
    const stopping = h.runtime.dispose();
    assert.equal(stopping, h.runtime.dispose());
    void stopping.then(() => { stopped = true; });
    await settle();
    assert.equal(h.notificationStopped(), true); assert.equal(stopped, false);
    assert.equal(h.notificationPoolEnded(), false);
    await h.signal(); assert.equal(h.scans.length, 2);
    held = false; release(); await pending; await stopping;
    await h.clock.advanceTo(90_000);
    assert.equal(stopped, true); assert.equal(h.scans.length, 2);
    assert.equal(h.notificationPoolEnded(), true);
  } finally { held = false; release(); }
});

test('a signal after the last scan continuation still schedules a following fresh scan', async t => {
  for (let depth = 0; depth <= 12; depth++) {
    let held = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await setup(t, { scan: async () => { if (held) await gate; return []; } });
    try {
      held = true;
      const first = h.signal(); await settle();
      let late: Promise<void> | undefined;
      // Sweep adjacent promise continuations; the actual scan and its wrapper
      // add their own microtasks. No private recovery flag is exposed here.
      const signalAfter = (remaining: number): void => {
        if (remaining === 0) { late = h.signal(); return; }
        queueMicrotask(() => signalAfter(remaining - 1));
      };
      const arranged = gate.then(() => { signalAfter(depth); });
      held = false; release();
      await arranged; await first; await settle(); await late;
      await h.clock.advanceTo(0);
      assert.equal(h.scans.length, 3, `late signal at continuation ${depth} must not wait for the thirty-second audit`);
    } finally { held = false; release(); }
  }
});

test('projection reloads the newest durable state after enqueue', async (t) => {
  const h = await setup(t);
  const queued = state();
  h.states.set(queued.documentId, queued);
  h.runtime.enqueue(queued);
  const latest = state('document-a', { documentSequence: 7, path: 'renamed.md' });
  h.states.set(latest.documentId, latest);
  await h.clock.advanceTo(2_000);
  assert.deepEqual(h.attempted, [latest]);
  assert.equal(h.projected[0].state.checkpointSequence, 7);
  assert.deepEqual(h.guestVersions, [h.projected[0].state]);
});

test('a queued projector reloads inside the workspace lock and preserves an already finalized inode', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-projection-fence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'document.md');
  await fs.writeFile(file, 'Before');
  let release!: () => void;
  const heldLock = new Promise<void>((resolve) => { release = resolve; });
  let waiting = false;
  const h = await setup(t, { states: [state()], lock: async (_workspaceId, operation) => {
    waiting = true;
    await heldLock;
    return operation();
  }, project: async (snapshot) => {
    await fs.writeFile(`${file}.background`, 'Reviewed');
    await fs.rename(`${file}.background`, file);
    return { state: { ...snapshot, checkpointSequence: snapshot.documentSequence }, content: 'Reviewed', revisionId: 'duplicate' };
  } });
  await h.clock.advanceTo(2_000);
  assert.equal(waiting, true, 'independent projector is waiting behind the reviewed workspace operation');
  assert.equal(h.attempted.length, 0);
  // The batch uses the ordinary transactional checkpoint while owning this lock.
  await fs.writeFile(`${file}.batch`, 'Reviewed'); await fs.rename(`${file}.batch`, file);
  const confirmedInode = (await fs.stat(file)).ino;
  h.states.set('document-a', state('document-a', { checkpointSequence: 2 }));
  release();
  await settle();
  assert.equal(h.attempted.length, 0, 'finished pending work cannot replace the file a second time');
  assert.equal((await fs.stat(file)).ino, confirmedInode);
  assert.equal(await fs.readFile(file, 'utf8'), 'Reviewed');
  assert.deepEqual(h.projected, []);
  assert.deepEqual(h.failures, []);
});

test('stale generation, archived, missing and already finalized queued documents are skipped', async (t) => {
  const h = await setup(t);
  for (const id of ['stale', 'archived', 'missing', 'finalized']) h.runtime.enqueue(state(id));
  h.states.set('stale', state('stale', { lifecycleGeneration: 2 }));
  h.states.set('archived', state('archived', { status: 'archived' }));
  h.states.set('finalized', state('finalized', { checkpointSequence: 2 }));
  await h.clock.advanceTo(2_000);
  assert.deepEqual(h.attempted, []);
  assert.deepEqual(h.workspaceReads, []);
  assert.deepEqual(h.failures, []);
});

test('an unavailable workspace never receives a projection', async (t) => {
  const h = await setup(t, { states: [state()] });
  h.setWorkspaceAvailable(false);
  await h.clock.advanceTo(2_000);
  assert.deepEqual(h.attempted, []);
  assert.deepEqual(h.workspaceReads, ['document-a']);
});

test('restart recovery scans sequence gaps and unfinished receipts even at equal sequences', async (t) => {
  const h = await setup(t, {
    states: [state('gap'), state('receipt', { checkpointSequence: 2 }), state('done', { checkpointSequence: 2 }),
      state('archived', { status: 'archived' })], pendingReceipts: ['receipt'],
  });
  await h.clock.advanceTo(2_000);
  assert.deepEqual(h.attempted.map((snapshot) => snapshot.documentId), ['gap', 'receipt']);
  await h.clock.advanceTo(32_000);
  assert.deepEqual(h.scans, ['', '']);
  assert.equal(h.attempted.length, 2, 'completed projections need no repeating export');
});

test('restart recovery paginates past one hundred pending documents', async (t) => {
  const documents = Array.from({ length: 101 }, (_, index) => state(`document-${String(index).padStart(3, '0')}`));
  const h = await setup(t, { states: documents });
  assert.deepEqual(h.scans, ['', 'document-099']);
  await h.clock.advanceTo(2_000);
  assert.equal(h.projected.length, 101);
  assert.equal(new Set(h.attempted.map((snapshot) => snapshot.documentId)).size, 101);
});

test('recovery scan failure is logged and retried without document contents', async (t) => {
  let scanCount = 0;
  const h = await setup(t, { states: [state()], scan: async () => {
    if (++scanCount === 1) throw new Error('private document text and credentials');
    return [state()];
  } });
  assert.equal(h.diagnostics[0].data.event, 'projection_recovery_failed');
  assert.ok(!JSON.stringify(h.diagnostics).includes('private'));
  await h.clock.advanceTo(32_000);
  assert.equal(h.projected.length, 1);
});

for (const code of ['schema_invalid', 'stable_id_missing', 'stable_id_duplicate', 'roundtrip_unstable'] as const) {
  test(`${code} only blocks editing when the durable document structure is invalid`, async (t) => {
    const failure = new CollaborationCheckpointValidationError(code);
    const h = await setup(t, { states: [state()], project: async () => { throw failure; } });
    await h.clock.advanceTo(2_000);
    assert.deepEqual(h.failures, [{ state: state(), ...classifyCollaborationProjectionError(failure) }]);
    assert.deepEqual(h.degraded, code === 'roundtrip_unstable' ? [] : [['document-a', 1]]);
    assert.deepEqual(h.projected, []);
    assert.equal(h.diagnostics.at(-1)?.data.attempt, 1);
    assert.equal(h.states.get('document-a')?.checkpointSequence, 1);
  });
}

test('filesystem failure preserves editing and retries in the background', async (t) => {
  const h = await setup(t, { states: [state()], project: async () => { throw new Error('secret-path/document.md'); } });
  await h.clock.advanceTo(3_000);
  assert.equal(h.attempted.length, 2);
  assert.ok(h.failures.every((failure) => !failure.blocksEditing && failure.code === COLLABORATION_CHECKPOINT_ERROR_CODES.failed));
  assert.deepEqual(h.degraded, []);
  assert.ok(!JSON.stringify(h.diagnostics).includes('secret-path'));
});

test('permanent schema quarantine pauses retries and restart scans until a new lifecycle', async (t) => {
  const h = await setup(t, { states: [state()], project: async (snapshot) => {
    if (snapshot.lifecycleGeneration === 1) throw new CollaborationCheckpointValidationError('schema_invalid');
    return { state: { ...snapshot, checkpointSequence: snapshot.documentSequence }, revisionId: 'new', content: 'valid' };
  } });
  await h.clock.advanceTo(600_000);
  assert.equal(h.attempted.length, 1); assert.equal(h.failures.length, 1);
  const recovered = state('document-a', { lifecycleGeneration: 2 });
  h.states.set(recovered.documentId, recovered); h.runtime.enqueue(recovered);
  await h.clock.advanceTo(602_000);
  assert.equal(h.projected.length, 1); assert.equal(h.projected[0].state.lifecycleGeneration, 2);
});

test('legacy degraded state is never projected after restart', async (t) => {
  const h = await setup(t, { states: [state('document-a', { degraded: true })] });
  await h.clock.advanceTo(600_000); assert.deepEqual(h.attempted, []);
});

test('a late permanent failure cannot freeze a newer durable snapshot in the same generation', async (t) => {
  const h = await setup(t, { states: [state()], project: async (snapshot) => {
    if (snapshot.documentSequence === 2) {
      h.states.set(snapshot.documentId, state(snapshot.documentId, { documentSequence: 3 }));
      throw new CollaborationCheckpointValidationError('schema_invalid');
    }
    return { state: { ...snapshot, checkpointSequence: snapshot.documentSequence }, content: 'new', revisionId: 'new' };
  } });
  await h.clock.advanceTo(4_000);
  assert.deepEqual(h.attempted.map((snapshot) => snapshot.documentSequence), [2, 3]);
  assert.deepEqual(h.failures, []); assert.deepEqual(h.degraded, []);
  assert.equal(h.projected[0].state.documentSequence, 3);
});

test('serializer failure stays transient and preserves editing', async (t) => {
  const h = await setup(t, { states: [state()], project: async () => { throw new CollaborationCheckpointValidationError('serialization_failed'); } });
  await h.clock.advanceTo(3_000);
  assert.equal(h.attempted.length, 2); assert.equal(h.failures[0].permanent, false);
  assert.equal(h.failures[0].blocksEditing, false); assert.deepEqual(h.degraded, []);
});

test('a superseded export reloads and queues the new generation without a failure notification', async (t) => {
  const h = await setup(t, { states: [state()], project: async (snapshot) => {
    if (snapshot.lifecycleGeneration === 1) {
      h.states.set(snapshot.documentId, state(snapshot.documentId, { lifecycleGeneration: 2, documentSequence: 1, checkpointSequence: 0 }));
      throw new SupersededError();
    }
    return { state: { ...snapshot, checkpointSequence: snapshot.documentSequence }, content: 'new', revisionId: 'new-revision' };
  } });
  await h.clock.advanceTo(4_000);
  assert.deepEqual(h.attempted.map((snapshot) => snapshot.lifecycleGeneration), [1, 2]);
  assert.deepEqual(h.failures, []);
  assert.equal(h.projected[0].state.lifecycleGeneration, 2);
  assert.ok(h.diagnostics.some((entry) => entry.data.event === 'projection_superseded'));
});

test('projection results with a newer durable sequence schedule the remaining gap', async (t) => {
  let count = 0;
  const h = await setup(t, { states: [state()], project: async (snapshot) => ({
    state: ++count === 1 ? { ...snapshot, documentSequence: 3, checkpointSequence: 2 }
      : { ...snapshot, checkpointSequence: snapshot.documentSequence }, content: 'projected', revisionId: String(count),
  }) });
  await h.clock.advanceTo(4_000);
  assert.deepEqual(h.attempted.map((snapshot) => snapshot.documentSequence), [2, 3]);
  assert.deepEqual(h.projected.map((result) => result.state.checkpointSequence), [2, 3]);
});

test('guest version failure does not roll back or retry a completed projection', async (t) => {
  const h = await setup(t, { states: [state()], guestVersion: async () => { throw new Error('guest version'); } });
  await h.clock.advanceTo(32_000);
  assert.equal(h.projected.length, 1);
  assert.equal(h.attempted.length, 1);
  assert.deepEqual(h.failures, []);
  assert.ok(h.diagnostics.some((entry) => entry.data.event === 'guest_version_failed'));
});

test('disposal stops recovery and queued projections', async (t) => {
  const h = await setup(t, { states: [state()] });
  h.runtime.dispose();
  h.runtime.enqueue(state());
  await h.clock.advanceTo(100_000);
  assert.deepEqual(h.attempted, []);
  assert.deepEqual(h.scans, ['']);
});

test('disposal permits the running filesystem operation to finish but suppresses callbacks and follow-up exports', async (t) => {
  let finish!: (result: ProjectionResult) => void;
  const gate = new Promise<ProjectionResult>((resolve) => { finish = resolve; });
  const h = await setup(t, { states: [state()], project: () => gate });
  await h.clock.advanceTo(2_000);
  assert.equal(h.attempted.length, 1);
  h.runtime.dispose();
  finish({ state: state('document-a', { documentSequence: 3, checkpointSequence: 2 }), content: 'projected', revisionId: 'revision' });
  await h.clock.advanceTo(100_000);
  assert.equal(h.attempted.length, 1);
  assert.deepEqual(h.projected, []);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.scans, ['']);
});

test('pending Copy publication stays untouched until the next recovery scan and then projects normally', async (t) => {
  const original = state();
  let published = false;
  const h = await setup(t, { states: [original], project: async (snapshot) => {
    if (!published) throw new CollaborationCopyPublicationPendingError();
    return { state: { ...snapshot, checkpointSequence: snapshot.documentSequence }, content: 'published copy', revisionId: 'published-revision' };
  } });
  await h.clock.advanceTo(2_000);
  assert.deepEqual(h.attempted, [original]);
  assert.equal(h.states.get(original.documentId), original, 'pending publication must not alter the durable projection state');
  assert.deepEqual([...h.projected], []);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.recordedFailures, [], 'pending is not a database projection failure');
  assert.deepEqual(h.degraded, []);
  assert.deepEqual(h.guestVersions, []);
  assert.deepEqual([...h.diagnostics], []);
  await h.clock.advanceTo(29_999);
  assert.deepEqual(h.attempted, [original], 'the pending error must not schedule an immediate/backoff retry');
  assert.deepEqual(h.scans, ['']);
  published = true;
  await h.clock.advanceTo(30_000);
  assert.deepEqual(h.scans, ['', ''], 'the unchanged thirty-second recovery scan rediscovers pending publication');
  assert.deepEqual(h.attempted, [original]);
  await h.clock.advanceTo(32_000);
  assert.deepEqual(h.attempted, [original, original]);
  assert.equal(h.projected.length, 1);
  assert.equal(h.projected[0].revisionId, 'published-revision');
  assert.equal(h.projected[0].state.checkpointSequence, original.documentSequence);
  assert.deepEqual(h.guestVersions, [h.projected[0].state]);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.recordedFailures, []);
  assert.deepEqual(h.degraded, []);
  assert.equal(h.diagnostics.some((entry) => entry.data.event === 'projection_failed'), false);
});

test('pending Original file operation defers without failure or acknowledgement and the unchanged recovery scan resumes it', async (t) => {
  const original = state(); let complete = false;
  const h = await setup(t, { states: [original], project: async snapshot => {
    if (!complete) throw new CollaborationFileOperationProjectionPendingError();
    return { state: { ...snapshot, checkpointSequence: snapshot.documentSequence }, content: 'completed operation', revisionId: 'operation-revision' };
  } });
  await h.clock.advanceTo(2_000);
  assert.deepEqual(h.attempted, [original]); assert.equal(h.states.get(original.documentId), original);
  assert.deepEqual([...h.projected], []); assert.deepEqual(h.failures, []); assert.deepEqual(h.recordedFailures, []);
  assert.deepEqual(h.degraded, []); assert.deepEqual(h.guestVersions, []); assert.deepEqual([...h.diagnostics], []);
  await h.clock.advanceTo(29_999); assert.deepEqual(h.attempted, [original]);
  complete = true; await h.clock.advanceTo(30_000); await h.clock.advanceTo(32_000);
  assert.deepEqual(h.attempted, [original, original]); assert.equal(h.projected.length, 1);
  assert.equal(h.projected[0].revisionId, 'operation-revision'); assert.deepEqual(h.recordedFailures, []);
  assert.deepEqual(h.failures, []); assert.deepEqual(h.degraded, []);
  assert.equal(h.diagnostics.some(entry => entry.data.event === 'projection_failed'), false);
});
