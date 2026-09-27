import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import {
  CollaborationAdmissionError,
  captureCollaborationAdmissionRequest,
  collaborationAdmissionActionDigest,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
} from '../app/lib/collaboration/room-admission-contract';
import { captureCollaborationCompactionRequest } from '../app/lib/collaboration/compaction-contract';

const REQUEST_ID = 'c4094c8d-9308-4618-b6ab-d15fbef4e253';

function document(overrides: Partial<CollaborationAdmissionDocument> = {}): CollaborationAdmissionDocument {
  return { documentId: 'compact-coordinator-doc', workspaceId: 'compact-coordinator-workspace',
    organizationId: 'compact-coordinator-org', path: 'notes/compact.md', representation: 'plain_text',
    lifecycleGeneration: 7, schemaVersion: 2, status: 'active', ...overrides };
}

function request(input: Partial<Pick<CollaborationAdmissionRequest, 'requestId' | 'expectedDocuments'>> = {}) {
  const target = input.expectedDocuments?.[0] ?? document();
  const actionPayloadText = JSON.stringify({ version: 1, documentId: target.documentId,
    expectedLifecycleGeneration: target.lifecycleGeneration });
  return {
    requestId: input.requestId ?? REQUEST_ID,
    actorId: 'compaction-coordinator-test',
    action: 'compact' as const,
    actionPayloadText,
    actionDigest: collaborationAdmissionActionDigest('compact', actionPayloadText),
    scopes: [{ workspaceId: target.workspaceId, organizationId: target.organizationId,
      path: target.path, kind: 'exact' as const }],
    expectedDocuments: input.expectedDocuments ?? [target],
  };
}

type Hooks = {
  outcome?: unknown | null;
  outcomeAfterProof?: unknown;
  loadRequest?: CollaborationAdmissionRequest | null;
  reserved?: unknown;
  proofErrors?: unknown[];
  startDrainError?: unknown;
  executeError?: unknown;
  abortError?: unknown;
  outcomeValue?: unknown;
  abortValue?: unknown;
  readyError?: unknown;
  readinessErrors?: Array<unknown | null>;
  authorizeError?: unknown;
  admissionReads?: Array<unknown | null>;
  preflightRow?: { degraded: unknown; checkpoint_sequence: unknown } | null;
};

type Harness = {
  coordinator: {
    advance: (input: CollaborationAdmissionRequest, authorization: { authorize: (value: CollaborationAdmissionRequest) => Promise<void> }) => Promise<unknown>;
    resume: (requestId: string, authorization: { authorize: (value: CollaborationAdmissionRequest) => Promise<void> }) => Promise<unknown>;
  };
  events: string[];
  lockDepth: () => number;
  closedErrors: Array<Error | undefined>;
};

class MigrationError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

async function loadCoordinator(mocks: Record<string, unknown>): Promise<(options: Record<string, unknown>) => Harness['coordinator']> {
  const filename = path.resolve('app/lib/collaboration/compaction-coordinator.ts');
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports: Record<string, unknown> = {};
  const compiledModule = { exports };
  const runtimeRequire = createRequire(filename);
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'server-only') return {};
    if (Object.prototype.hasOwnProperty.call(mocks, name)) return mocks[name];
    if (name === './compaction-contract') return { captureCollaborationCompactionRequest };
    if (name === './room-admission-contract') return { captureCollaborationAdmissionRequest, CollaborationAdmissionError };
    if (name === './room-admission-outcome') return {};
    return runtimeRequire(name);
  }, compiledModule, exports);
  return exports.createCollaborationCompactionCoordinator as (options: Record<string, unknown>) => Harness['coordinator'];
}

async function harness(hooks: Hooks = {}): Promise<Harness> {
  const events: string[] = [];
  const closedErrors: Array<Error | undefined> = [];
  let lockDepth = 0;
  let currentReservation: unknown = hooks.reserved;
  const readQueue = [...(hooks.admissionReads ?? [])];
  const readinessQueue = [...(hooks.readinessErrors ?? [])];
  const proveQueue = [...(hooks.proofErrors ?? [])];
  const documentValue = document();
  const reservedTarget = { document: documentValue, ownerToken: 'original-owner-token' };
  const reservation = hooks.reserved ?? { status: 'reserved', targets: [reservedTarget] };
  const outcome = hooks.outcomeValue ?? Object.freeze({ marker: 'completed-outcome' });
  let historyOutcome = hooks.outcome ?? null;

  const modules: Record<string, unknown> = {
    './compaction-handoff': {
      createCollaborationCompactionHandoffService: () => ({
        execute: async () => { events.push('execute'); if (hooks.executeError) throw hooks.executeError; return hooks.outcomeValue ?? outcome; },
        abort: async (_request: unknown, _authorization: unknown, reason: string) => {
          events.push(`abort:${reason}`); if (hooks.abortError) throw hooks.abortError; return hooks.abortValue ?? outcome;
        },
      }),
    },
    './persistence': {
      CollaborationRepresentationMigrationError: MigrationError,
      prepareCollaborationCompactionAdmission: async () => { events.push('prepare'); },
    },
    './room-admission': {
      captureCollaborationAdmissionScopeTargets: async () => {
        events.push('capture-targets');
        return [{ document: documentValue, documentSequence: 10 }];
      },
      createCollaborationAdmissionService: () => ({
        read: async () => {
          events.push('admission-read');
          if (readQueue.length > 0) return readQueue.shift() ?? null;
          return currentReservation ?? null;
        },
        reserve: async () => { events.push('reserve'); currentReservation = reservation; return reservation; },
        startDrain: async () => { events.push('start-drain'); if (hooks.startDrainError) throw hooks.startDrainError; },
      }),
    },
    './room-admission-handoff': {
      createCollaborationAdmissionHandoffService: () => ({
        readOutcome: async () => { events.push('history-read'); return historyOutcome; },
        loadRequest: async (id: string) => { events.push(`load-request:${id}`); return hooks.loadRequest ?? null; },
      }),
    },
    './room-admission-quiescence': {
      createCollaborationAdmissionQuiescenceService: () => ({
        prove: async () => {
          events.push('prove');
          if (hooks.outcomeAfterProof !== undefined) historyOutcome = hooks.outcomeAfterProof;
          const error = proveQueue.shift();
          if (error) throw error;
        },
      }),
    },
  };
  const coordinatorConstructor = await loadCoordinator(modules);
  const coordinator = coordinatorConstructor({
    openConnection: async () => {
      events.push('open-connection');
      return {
        run: async (sql: string) => { events.push(`sql:${sql}`); return { changes: 1 }; },
        get: async () => {
          events.push('state-row');
          return hooks.preflightRow === undefined ? { degraded: 0, checkpoint_sequence: 10 } : hooks.preflightRow;
        },
        all: async () => [],
        close: async (error?: Error) => { events.push('db-close'); closedErrors.push(error); },
      };
    },
    withMutationLocks: async (_workspaceIds: readonly string[], operation: () => Promise<unknown>) => {
      events.push('lock-enter');
      lockDepth += 1;
      try { return await operation(); }
      finally { lockDepth -= 1; events.push('lock-leave'); }
    },
    assertCanStartAdmission: async () => {
      events.push('readiness');
      const error = readinessQueue.length > 0 ? readinessQueue.shift() : hooks.readyError;
      if (error) throw error;
    },
  } as Record<string, unknown>);

  // Module-local factories are injected via require; constructor options remain
  // production-shaped and contain no test-only product dependency.
  return { coordinator, events, lockDepth: () => lockDepth, closedErrors };
}

function authorization(hooks: Hooks = {}, harnessValue?: Harness, expectedPath?: string) {
  return { authorize: async (value: CollaborationAdmissionRequest) => {
    harnessValue?.events.push('authorize');
    if (hooks.authorizeError) throw hooks.authorizeError;
    assert.equal(value.action, 'compact');
    if (expectedPath !== undefined) assert.equal(value.scopes[0].path, expectedPath);
  } };
}

test('advance preflights under a bounded mutation lock and reserves only after it is released', async () => {
  const h = await harness();
  const input = request();
  const originalPath = input.scopes[0].path;
  const pending = h.coordinator.advance(input, authorization({}, h, originalPath));
  Object.assign(input.scopes[0], { path: 'mutated.md' });
  const result = await pending as { status: string; outcome: unknown };

  assert.equal(result.status, 'completed');
  assert.equal(input.scopes[0].path, 'mutated.md');
  assert.ok(h.events.indexOf('lock-leave') >= 0);
  assert.ok(h.events.indexOf('lock-leave') < h.events.indexOf('reserve'));
  assert.ok(h.events.indexOf('db-close') < h.events.indexOf('reserve'));
  assert.equal(h.lockDepth(), 0);
  assert.equal(h.events.filter((event) => event === 'reserve').length, 1);
  assert.equal(originalPath, 'notes/compact.md');
  assert.deepEqual(h.events.filter((event) => event.startsWith('sql:')),
    ['sql:BEGIN', "sql:SET LOCAL statement_timeout = '5s'", "sql:SET LOCAL lock_timeout = '4s'"]);
});

test('historical outcomes bypass readiness, preflight, reservation, and owner proof', async () => {
  const historical = Object.freeze({ version: 1, requestId: REQUEST_ID });
  const h = await harness({ outcome: historical, readyError: new Error('readiness must not block recovery') });
  const result = await h.coordinator.advance(request(), authorization({}, h)) as { status: string; outcome: unknown };
  assert.equal(result.status, 'completed');
  assert.equal(result.outcome, historical);
  assert.deepEqual(h.events, ['authorize', 'history-read']);
});

test('authorization failure happens before history or any preflight work', async () => {
  const expected = new Error('authorization denied');
  const h = await harness();
  await assert.rejects(h.coordinator.advance(request(), authorization({ authorizeError: expected }, h)), expected);
  assert.deepEqual(h.events, ['authorize']);
  assert.equal(h.lockDepth(), 0);
});

test('start gate is rechecked after preflight and can stop reservation without holding locks', async () => {
  const gateClosed = new Error('admission readiness changed during preflight');
  const h = await harness({ readinessErrors: [null, gateClosed] });
  await assert.rejects(h.coordinator.advance(request(), authorization({}, h)), gateClosed);
  assert.equal(h.events.filter((event) => event === 'readiness').length, 2);
  assert.ok(h.events.indexOf('lock-leave') < h.events.lastIndexOf('readiness'));
  assert.equal(h.events.includes('reserve'), false);
  assert.equal(h.events.includes('prove'), false);
  assert.equal(h.lockDepth(), 0);
});

test('preflight accepts PostgreSQL string zero and bigint checkpoint, but rejects noncanonical health values', async () => {
  const valid = await harness({ preflightRow: { degraded: '0', checkpoint_sequence: '10' } });
  const accepted = await valid.coordinator.advance(request(), authorization({}, valid)) as { status: string };
  assert.equal(accepted.status, 'completed');
  assert.equal(valid.events.includes('reserve'), true);

  const rejectedRows: Array<{ degraded: unknown; checkpoint_sequence: unknown }> = [
    ...[null, '', Number.NaN, 1, '1'].map((degraded) => ({ degraded, checkpoint_sequence: '10' })),
    ...[null, '', false, Number.MAX_SAFE_INTEGER + 1, '01', '1e1', '10\n', '10\r\n'].map((checkpoint_sequence) => ({
      degraded: 0, checkpoint_sequence,
    })),
  ];
  for (const row of rejectedRows) {
    const h = await harness({ preflightRow: row });
    await assert.rejects(h.coordinator.advance(request(), authorization({}, h)), (error: unknown) => {
      assert.ok(error instanceof MigrationError);
      assert.equal(error.code, 'checkpoint_stale');
      return true;
    });
    assert.equal(h.events.includes('state-row'), true);
    assert.equal(h.events.includes('reserve'), false);
    assert.equal(h.events.includes('prove'), false);
    assert.equal(h.lockDepth(), 0);
    assert.equal(h.events.filter((event) => event === 'lock-enter').length, 1);
    assert.equal(h.events.filter((event) => event === 'lock-leave').length, 1);
    assert.equal(h.events.filter((event) => event === 'db-close').length, 1);
    assert.equal(h.closedErrors.length, 1);
    assert.ok(h.closedErrors[0] instanceof Error);
  }
});

test('resume rejects unknown request and canonically rebinds a loaded request', async () => {
  const unknown = await harness();
  await assert.rejects(unknown.coordinator.resume(REQUEST_ID, authorization({}, unknown)),
    (error: unknown) => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_REQUEST_CHANGED');
  assert.deepEqual(unknown.events, [`load-request:${REQUEST_ID}`]);

  const stored = request();
  const loaded = await harness({ loadRequest: stored, outcome: Object.freeze({ version: 1, requestId: REQUEST_ID }) });
  const result = await loaded.coordinator.resume(REQUEST_ID, authorization({}, loaded)) as { status: string };
  assert.equal(result.status, 'completed');
  assert.deepEqual(loaded.events, [`load-request:${REQUEST_ID}`, 'authorize', 'history-read']);

  const mismatched = await harness({ loadRequest: request({ requestId: '8a494245-5bc2-4d13-b93a-7b2a0fd9c33e' }) });
  await assert.rejects(mismatched.coordinator.resume(REQUEST_ID, authorization({}, mismatched)),
    (error: unknown) => error instanceof CollaborationAdmissionError);
});

test('owner-token conflict starts drain then reproves, while tokenless conflict stays pending without drain', async () => {
  const conflict = new CollaborationAdmissionError('ADMISSION_CONFLICT');
  const draining = await harness({ proofErrors: [conflict] });
  const completed = await draining.coordinator.advance(request(), authorization({}, draining)) as { status: string };
  assert.equal(completed.status, 'completed');
  assert.ok(draining.events.indexOf('prove') < draining.events.indexOf('start-drain'));
  assert.equal(draining.events.filter((event) => event === 'prove').length, 2);
  assert.ok(draining.events.includes('start-drain'));

  const tokenlessReservation = { status: 'reserved', targets: [{ document: document(), ownerToken: null }] };
  const pending = await harness({ reserved: tokenlessReservation, proofErrors: [conflict] });
  const progress = await pending.coordinator.advance(request(), authorization({}, pending)) as { status: string; phase: string };
  assert.equal(progress.status, 'pending');
  assert.equal(progress.phase, 'quiescence');
  assert.equal(pending.events.includes('start-drain'), false);
  assert.equal(pending.events.filter((event) => event === 'prove').length, 1);
});

test('only a proven pending agent operation is converted into a precondition abort', async () => {
  const pendingOperation = new MigrationError('agent review pending', 'agent_operation_pending');
  const h = await harness({ executeError: pendingOperation });
  const result = await h.coordinator.advance(request(), authorization({}, h)) as { status: string };
  assert.equal(result.status, 'completed');
  assert.ok(h.events.includes('abort:precondition_failed'));

  const otherFailure = new MigrationError('ordinary migration error', 'checkpoint_stale');
  const failing = await harness({ executeError: otherFailure });
  await assert.rejects(failing.coordinator.advance(request(), authorization({}, failing)), otherFailure);
  assert.equal(failing.events.some((event) => event.startsWith('abort:')), false);
});

test('an unexpected handoff error is never converted by a fresh historical read', async () => {
  const uncertainClose = new AggregateError([new Error('commit uncertain'), new Error('close failed')], 'handoff session failed');
  const historical = Object.freeze({ version: 1, requestId: REQUEST_ID });
  const h = await harness({ executeError: uncertainClose, outcomeAfterProof: historical });
  await assert.rejects(h.coordinator.advance(request(), authorization({}, h)), uncertainClose);
  assert.equal(h.events.filter((event) => event === 'history-read').length, 1,
    'only the initial history read may happen; unexpected execution errors must pass through');
  assert.ok(h.events.indexOf('prove') < h.events.indexOf('execute'));
});
