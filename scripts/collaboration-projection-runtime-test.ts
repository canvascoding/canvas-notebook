import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import ts from 'typescript';
import { CollaborationCheckpointValidationError, COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';
import { createCollaborationProjectionScheduler, type CollaborationProjectionRequest } from '../app/lib/collaboration/projection-scheduler';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type * as Runtime from '../app/lib/collaboration/projection-runtime';

type Callbacks = Parameters<typeof Runtime.createCollaborationProjectionRuntime>[0];
type ProjectionResult = Parameters<Callbacks['onProjected']>[0];
type ProjectionFailure = Parameters<Callbacks['onFailure']>[0];
type Timer = ReturnType<typeof setTimeout>;

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
} = {}) {
  const clock = createClock();
  const states = new Map((options.states ?? []).map((snapshot) => [snapshot.documentId, snapshot]));
  const pendingReceipts = new Set(options.pendingReceipts);
  const projected: ProjectionResult[] = [];
  const failures: ProjectionFailure[] = [];
  const attempted: PersistedCollaborationState[] = [];
  const degraded: Array<[string, number]> = [];
  const scans: string[] = [];
  const diagnostics: Array<{ level: string; data: Record<string, unknown> }> = [];
  const guestVersions: PersistedCollaborationState[] = [];
  const workspaceReads: string[] = [];
  let workspaceAvailable = true;
  const pending = (snapshot: PersistedCollaborationState) => snapshot.status === 'active'
    && (snapshot.documentSequence > snapshot.checkpointSequence || pendingReceipts.has(snapshot.documentId));
  const filename = path.resolve('app/lib/collaboration/projection-runtime.ts');
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exports = {};
  const dependencies: Record<string, unknown> = {
    'server-only': {},
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
    './checkpoint-errors': { CollaborationCheckpointValidationError, COLLABORATION_CHECKPOINT_ERROR_CODES },
    './diagnostics': { logCollaborationDiagnostic: (level: string, data: Record<string, unknown>) => diagnostics.push({ level, data }) },
    './persistence': {
      loadCollaborationState: async (documentId: string) => states.get(documentId) ?? null,
      markCollaborationDegraded: async (documentId: string, generation: number) => { degraded.push([documentId, generation]); },
    },
    './projection-repository': {
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
    guestVersions, workspaceReads, setWorkspaceAvailable: (value: boolean) => { workspaceAvailable = value; } };
}

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
    assert.deepEqual(h.failures, [{ state: state(), code: failure.code, blocksEditing: code !== 'roundtrip_unstable' }]);
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
