import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { NextRequest } from 'next/server';
import type { SqlConnection } from '../app/lib/db';
import { executeLifecycleTransaction } from '../app/lib/collaboration/lifecycle-transaction';
import * as Admission from '../app/lib/collaboration/room-admission-contract';
import * as Selection from '../app/lib/files/workspace-implicit-move-selection';
import { captureWorkspaceOperationNativePlanData } from '../app/lib/files/workspace-operation-native-plan-data';
import type { WorkspaceRequestHistoricalOrigin } from '../app/lib/workspaces/request-principal';
import type * as Operation from '../app/lib/files/workspace-implicit-move-operation';
import { workspacePathImportPreparationFixture } from './workspace-path-import-preparation-plan-test';

type Mode = 'conflict' | 'success' | 'terminal' | 'mutation-conflict' | 'retry-then-mutation-conflict';
type Options = { mode?: Mode; error?: Error; closeError?: Error; duplicateKeys?: boolean;
  afterConflict?: 'selection' | 'recovery_required' | 'auth'; proofCost?: number; initialAuthCost?: number; handoffCost?: number; terminalOnConflict?: boolean;
  advanceFault?: 'principal' | 'admission' | 'raw-sql' | 'public-lookalike' | 'admission-lookalike' | 'auth' | 'schema';
  advanceAlways?: boolean; advanceCleanupFault?: 'rollback' | 'close'; advanceMutexFault?: boolean;
  afterAdvanceBusy?: 'auth' | 'schema' | 'selection'; nonAdvanceBusy?: boolean;
  advanceCommitObserveBusy?: boolean; handoffImmediate?: boolean };

/** Real public prepare/resume and their private runPhase/finish/continueSaved,
 * real immutable selection codecs and lifecycle unwind, with declared SQL,
 * Principal, Handoff and timer mechanics. This is no real PG lock, genuine
 * authorization, mutation/FS or browser acceptance evidence. No private product
 * export is added for testing. Mirrors projection-publication-guard-test.ts. */
async function fixture(options: Options = {}) {
  // Load only the actual error-class declaration into the existing declared
  // Principal seam. Importing the authority module would initialize real auth.
  const principalSource = ts.createSourceFile('request-principal.ts', await readFile(
    path.resolve('app/lib/workspaces/request-principal.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const principalClass = principalSource.statements.find(statement => ts.isClassDeclaration(statement)
    && statement.name?.text === 'WorkspaceRequestPrincipalError');
  assert(principalClass && ts.isClassDeclaration(principalClass));
  const principalExports = {} as { WorkspaceRequestPrincipalError: typeof import('../app/lib/workspaces/request-principal').WorkspaceRequestPrincipalError };
  new Function('exports', ts.transpileModule(principalClass.getText(principalSource), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(principalExports);
  const PrincipalError = principalExports.WorkspaceRequestPrincipalError;
  assert.equal(typeof PrincipalError, 'function');
  const base = workspacePathImportPreparationFixture({ native: [['folder/note.md', '# Note\n'], ['backlink.md', '# Other\n']], raw: [] });
  const origin: WorkspaceRequestHistoricalOrigin = { userId: base.scope.ownerUserId!, sessionId: 'fixture-session', impersonatedBy: null,
    workspaceId: base.scope.workspaceId, workspaceType: base.scope.workspaceType, organizationId: base.scope.organizationId,
    customerId: base.scope.customerId, projectId: base.scope.projectId, ownerUserId: base.scope.ownerUserId,
    rootPath: base.scope.rootPath, rootRelativePath: base.scope.rootRelativePath!, legacy: false, status: 'active',
    schema: 'fixture_schema', schemaOid: 101, searchPath: 'fixture_schema, pg_catalog', databaseOid: 201 };
  const input = { workspaceId: base.scope.workspaceId, operationId: 'coordinator-fixture-operation', kind: 'move' as const,
    selections: [{ sourcePath: 'folder/note.md', destinationPath: 'target/note.md' }] };
  const captured = Selection.captureWorkspaceImplicitMoveSelection({ operationId: input.operationId, kind: input.kind,
    selections: input.selections, origin, scope: base.scope, observation: base.observation });
  const changed = Selection.captureWorkspaceImplicitMoveSelection({ operationId: input.operationId, kind: input.kind,
    selections: [{ sourcePath: 'folder/note.md', destinationPath: 'other/note.md' }], origin, scope: base.scope, observation: base.observation });
  assert(captured.request.expectedDocuments.length >= 2, 'duplicate-key regression needs distinct selected documents');
  const identity = Selection.getWorkspaceImplicitMoveSelectionBatchIdentity(captured.selection);
  const final = Admission.captureCollaborationAdmissionRequest({ ...captured.request, requestId: 'd1d34518-a42f-4f9a-896b-a12ba351aa23' });
  const planId = 'a'.repeat(64), preparationDigest = 'b'.repeat(64);
  const plan = { planIdentityVersion: 4, planId, sourceEvidence: { workspaceScope: base.scope },
    actions: [{ kind: input.kind, selections: input.selections }] };
  const batch = { batchId: identity.batchId, planId, workspaceId: base.scope.workspaceId, actionMode: 'apply', plan,
    authorization: { mode: 'direct', actorType: 'user', actorId: origin.userId, actorUserId: origin.userId,
      requestHash: identity.requestHash, jobScope: base.scope }, reviewIds: [], reviewRefs: [], reviewerUserId: null,
    reviewerDisplayName: null, totalActions: 1, completedActions: 0, createdAt: 100, updatedAt: 100, status: 'queued', phase: 'preparing' };
  const finalResult = { kind: 'implicitNativeMoveV1', batchId: identity.batchId, planId, preparationDigest,
    finalRequestId: final.request.requestId, finalRequestDigest: final.requestDigest, selectionDigest: captured.selectionDigest };
  const original = new NextRequest('https://fixture.invalid/api/files/rename');
  const failure = options.error ?? new Admission.CollaborationAdmissionError('ADMISSION_CONFLICT');
  const state = { now: 0, status: 'draining', stored: captured, outcome: null as null | Record<string, unknown>, revoked: false,
    principalDepth: 0, kernelDepth: 0, handoffDepth: 0, phaseDepth: 0, authCalls: 0, attempts: 0, mutations: 0,
    proofs: 0, sleeps: [] as number[], events: [] as string[], requests: [] as Admission.CollaborationAdmissionRequest[],
    advanceAttempts: 0, advanceFailures: 0, advanceRequestIds: [] as string[], advanceAuthCalls: [] as number[],
    commitFaultFired: false, nonAdvanceFaultFired: false, schemaRevoked: false };
  const connections = new Set<SqlConnection>(), handoffGets = new WeakSet<SqlConnection['get']>();
  const advanceConnections = new WeakSet<SqlConnection>();
  const advanceFailure = options.advanceFault === 'admission' ? new Admission.CollaborationAdmissionError('ADMISSION_CONFLICT')
    : options.advanceFault === 'raw-sql' ? Object.assign(new Error('Declared raw SQL failure.'), { code: '55P03' })
      : options.advanceFault === 'public-lookalike' ? Object.assign(new Error('Declared public-code lookalike.'), { code: 'IMPLICIT_MOVE_BUSY' })
        : options.advanceFault === 'admission-lookalike' ? Object.assign(new Error('Declared admission-code lookalike.'), { code: 'ADMISSION_CONFLICT' })
          : new PrincipalError(options.advanceFault === 'auth' ? 'PRINCIPAL_AUTH_REVOKED'
            : options.advanceFault === 'schema' ? 'PRINCIPAL_SCHEMA_INVALID' : 'PRINCIPAL_BUSY');
  const workspace = { ...base.scope, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true } };
  const assertUnwound = () => {
    assert.equal(connections.size, 0); assert.equal(state.principalDepth, 0); assert.equal(state.kernelDepth, 0);
    assert.equal(state.handoffDepth, 0); assert.equal(state.phaseDepth, 0);
  };
  const header = () => { const current = Admission.captureCollaborationAdmissionRequest(state.stored.request);
    return { request_id: current.request.requestId, request_digest: current.requestDigest, intent_text: current.intentText,
      status: state.status, revision: 6 }; };
  const openDb = async (): Promise<SqlConnection> => {
    let closed = false;
    const database: SqlConnection = {
      run: async sql => {
        assert.equal(closed, false); assert.match(sql, /^(?:BEGIN|COMMIT|ROLLBACK|SET |LOCK TABLE )/u); state.events.push(sql.split(' ')[0]);
        if (advanceConnections.has(database) && sql === 'ROLLBACK' && options.advanceCleanupFault === 'rollback') throw advanceFailure;
        if (advanceConnections.has(database) && sql === 'COMMIT' && options.advanceCommitObserveBusy && !state.commitFaultFired) {
          state.commitFaultFired = true; throw new Admission.CollaborationAdmissionError('ADMISSION_CONFLICT');
        }
      },
      get: async (sql, values = []) => {
        assert.equal(closed, false);
        if (sql.includes('current_schema() AS schema')) return { schema: origin.schema, schema_oid: origin.schemaOid,
          database_oid: origin.databaseOid, search_path: origin.searchPath };
        if (sql.includes('workspace_path_import_preparations')) return undefined;
        if (sql.includes('collaboration_admission_requests')) {
          if (values[0] === final.request.requestId) return { request_id: final.request.requestId, request_digest: final.requestDigest, intent_text: final.intentText, status: 'reserved' };
          assert.equal(values[0], captured.request.requestId);
          if (sql.includes('SELECT request_digest,intent_text,status,revision') && sql.includes('FOR UPDATE')) {
            advanceConnections.add(database); state.advanceAttempts++;
            state.advanceRequestIds.push(String(values[0])); state.advanceAuthCalls.push(state.authCalls);
            if (options.advanceFault && (state.advanceAttempts === 1 || options.advanceAlways)) {
              state.advanceFailures++; state.events.push('advance:failed');
              if (options.afterAdvanceBusy === 'auth') state.revoked = true;
              if (options.afterAdvanceBusy === 'schema') state.schemaRevoked = true;
              if (options.afterAdvanceBusy === 'selection') state.stored = changed;
              throw advanceFailure;
            }
            state.events.push('advance:ready');
          } else if ((options.nonAdvanceBusy || state.commitFaultFired && options.advanceCommitObserveBusy) && !state.nonAdvanceFaultFired) {
            state.nonAdvanceFaultFired = true; throw advanceFailure;
          }
          return header();
        }
        if (sql.includes('workspace_file_operation_batches')) return { plan_json: 'declared-stored-plan', authorization_json: 'declared-stored-authorization' };
        if (sql.includes('collaboration_admission_targets')) return { status: 'released', active: true, snapshot_text: 'declared-target' };
        throw new Error('Unexpected coordinator SQL get in pure fixture.');
      },
      all: async (sql, values = []) => {
        assert.equal(closed, false);
        if (sql.includes('collaboration_admission_targets')) return final.request.expectedDocuments.map(document =>
          ({ document_id: document.documentId, active: true, status: 'reserved', snapshot_text: 'declared-target' }));
        if (sql === 'fixture-admission') { assert.deepEqual(values, [base.scope.workspaceId]); return [{ locked: true }]; }
        if (sql.includes('pg_catalog.unnest')) return (values[1] as string[]).map((name, index) => ({ name, oid: index + 301,
          schema_oid: origin.schemaOid, relkind: 'r', relpersistence: 'p', relrowsecurity: false, relforcerowsecurity: false, resolved: index + 301 }));
        throw new Error('Unexpected coordinator SQL all in pure fixture.');
      },
      close: async () => {
        assert.equal(closed, false); closed = true; connections.delete(database); state.events.push('close');
        if (advanceConnections.has(database) && state.advanceFailures > 0 && options.advanceCleanupFault === 'close') throw advanceFailure;
        if (handoffGets.has(database.get) && options.closeError) throw options.closeError;
      },
    };
    connections.add(database); return database;
  };
  const unexpected = () => { throw new Error('A saved-selection retry must not replan, reserve anew, abort or manufacture a batch.'); };
  const withMutationLock = async (workspaceId: string, run: () => Promise<unknown>) => {
    assert.equal(workspaceId, base.scope.workspaceId); assert.equal(state.kernelDepth, 0); state.kernelDepth++;
    try {
      const result = await run();
      if (state.advanceFailures > 0 && options.advanceMutexFault) throw advanceFailure;
      return result;
    } finally { state.kernelDepth--; }
  };
  const mocks: Record<string, unknown> = {
    'server-only': {}, 'next/server': { NextRequest }, 'node:crypto': { createHash: (await import('node:crypto')).createHash },
    'node:util': { isDeepStrictEqual: (await import('node:util')).isDeepStrictEqual }, '../db': { openDb },
    '../collaboration/lifecycle-transaction': { executeLifecycleTransaction },
    '../collaboration/native-text-session-activation': { authenticatedNativeTextSessionEnabled: () => true },
    '../collaboration/room-admission-contract': Admission,
    '../collaboration/room-owner': { lockIdentity: (documentId: string) => ({ key: options.duplicateKeys ? '42' : documentId }) },
    '../collaboration/room-admission': { reserveCollaborationAdmissionOnConnection: unexpected, startCollaborationAdmissionDrainOnConnection: unexpected,
      tryLockCollaborationAdmissionWorkspace: async (query: (sql: string, values: unknown[]) => Promise<unknown>, workspaceId: string) => query('fixture-admission', [workspaceId]),
      decodeCollaborationAdmissionTarget: () => ({ ownerToken: null }) },
    '../collaboration/room-admission-quiescence': { proveCollaborationAdmissionQuiescenceOnConnection: async () => {
      state.proofs++; state.now += options.proofCost ?? 0; return { proofText: 'declared-proof' }; } },
    '../collaboration/room-admission-outcome': { readHistoricalCollaborationAdmissionOutcomeOnConnection: async () => state.outcome },
    '../collaboration/room-admission-handoff': { createCollaborationAdmissionHandoffService: (mechanics: {
      openConnection: () => Promise<SqlConnection>; withMutationLocks: (ids: string[], run: () => Promise<unknown>) => Promise<unknown>;
    }) => ({ abort: unexpected, execute: async (request: Admission.CollaborationAdmissionRequest, domain: {
      authorize: (request: Admission.CollaborationAdmissionRequest) => Promise<void>; prepare: (database: SqlConnection) => Promise<void>;
      mutate: (database: SqlConnection) => Promise<unknown>; withMutationTransaction: (database: SqlConnection, run: () => Promise<unknown>) => Promise<unknown>;
    }) => {
      assertUnwound(); state.attempts++; state.requests.push(structuredClone(request)); state.events.push('handoff');
      await domain.authorize(request);
      const database = await mechanics.openConnection(); handoffGets.add(database.get); state.handoffDepth++;
      try {
        state.now += options.handoffCost ?? 0;
        if (options.duplicateKeys || options.mode !== 'terminal' && options.mode !== 'success' || state.attempts === 1 && !options.handoffImmediate) {
          if (options.mode === 'mutation-conflict' || options.mode === 'retry-then-mutation-conflict' && state.attempts > 1) return await mechanics.withMutationLocks([base.scope.workspaceId], () =>
            domain.withMutationTransaction(database, async () => { await domain.prepare(database); return domain.mutate(database); }));
          if (options.afterConflict === 'selection') state.stored = changed;
          if (options.afterConflict === 'recovery_required') state.status = 'recovery_required';
          if (options.afterConflict === 'auth') state.revoked = true;
          if (options.terminalOnConflict) { state.status = 'committed'; state.outcome = { version: 2, reasonCode: 'user_cancelled' }; }
          throw failure;
        }
        return await mechanics.withMutationLocks([base.scope.workspaceId], () => domain.withMutationTransaction(database, async () => {
          await domain.prepare(database);
          const result = options.mode === 'success' ? await domain.mutate(database) : undefined;
          // Durable artifacts below are explicit fixture replies, not real mutation evidence.
          state.status = 'committed'; state.outcome = options.mode === 'success'
            ? { version: 1, result } : { version: 2, reasonCode: 'user_cancelled' }; return state.outcome;
        }));
      } finally { state.handoffDepth--; await database.close(new Error('Declared handoff discard.')); }
    } }) },
    '../workspaces/request-principal': {
      WorkspaceRequestPrincipalError: PrincipalError,
      withWorkspaceRequestPrincipalOriginalOrigin: async (request: NextRequest, requested: unknown,
        observe: (origin: WorkspaceRequestHistoricalOrigin) => void, run: (principal: object) => Promise<unknown>) => {
        assert.equal(request, original); assert.deepEqual(requested, { workspaceId: base.scope.workspaceId, permission: 'canWrite' });
        assert.equal(state.handoffDepth, 0, 'fresh observe/authorize runs after old handoff scope');
        state.authCalls++; if (state.authCalls === 1) state.now += options.initialAuthCost ?? 0;
        if (state.revoked) throw Object.assign(new Error('Declared current access denial.'), { code: 'PRINCIPAL_ACCESS_DENIED' });
        if (state.schemaRevoked) throw new PrincipalError('PRINCIPAL_SCHEMA_INVALID');
        observe(origin); state.principalDepth++;
        try { return await run({}); } finally { state.principalDepth--; }
      },
      withWorkspaceRequestPrincipalOnConnection: async (_database: SqlConnection, _principal: object, run: (access: unknown) => Promise<unknown>) =>
        run({ userId: origin.userId, sessionId: origin.sessionId, workspace, assertCurrent: async () => { assert.equal(state.revoked, false); } }),
    },
    '../markdown/workspace-source-authority-stage': { readWorkspaceLinkSourceAuthorityOnConnection: unexpected },
    './workspace-operation-native-plan-data': { captureWorkspaceOperationNativePlanData },
    './workspace-operation-job-scope': { captureWorkspaceOperationJobScope: () => base.scope },
    './workspace-operation-native-move-plan': { createWorkspaceOperationNativeMoveBatchPlanV4: unexpected,
      decodeWorkspaceOperationNativeMoveBatchPlan: (stored: unknown) => { assert.deepEqual(stored, plan); return plan; } },
    './workspace-operation-native-delete-effects': { workspaceOperationBatchTotalActions: () => 1 },
    './workspace-operation-original-move-preparation': { readWorkspaceOperationOriginalMovePreparationOnConnection: async () => ({
      preparation: { version: 3, requestId: final.request.requestId, requestDigest: final.requestDigest }, preparationDigest, request: final.request }) },
    './workspace-operation-batch-store': { decodeWorkspaceOperationBatchRecord: () => batch },
    './workspace-path-operation-service': { getExistingDirectWorkspacePathOperation: unexpected },
    './workspace-mutation-lock': { withWorkspaceMutationLock: withMutationLock },
    './workspace-operation-failure-diagnostics': { reportWorkspaceOperationFailureDiagnostics: () => undefined },
    './workspace-implicit-move-selection': Selection,
    './workspace-implicit-move-phase': {
      prepareWorkspaceImplicitMoveOperationOnConnection: () => { state.mutations++; if (options.mode === 'success') return finalResult; throw failure; },
      withWorkspaceImplicitMoveHandoffTransactionOnConnection: async (_database: SqlConnection, _input: unknown, run: () => Promise<unknown>) => {
        state.phaseDepth++; try { return await run(); } finally { state.phaseDepth--; }
      },
    },
  };
  const compiled = ts.transpileModule(await readFile(path.resolve('app/lib/files/workspace-implicit-move-operation.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exported = {};
  new Function('require', 'module', 'exports', 'Date', 'setTimeout', compiled)((name: string) => {
    assert(Object.hasOwn(mocks, name), `Unexpected runtime import ${name}`); return mocks[name];
  }, { exports: exported }, exported, { now: () => state.now }, (resolve: () => void, milliseconds: number) => {
    assertUnwound(); assert(milliseconds > 0 && milliseconds <= 100); state.sleeps.push(milliseconds); state.now += milliseconds; resolve();
  });
  const api = exported as typeof Operation;
  const invoke = (entry: 'prepare' | 'resume', waitMs = 250) => entry === 'prepare'
    ? api.prepareWorkspaceImplicitMoveOperation(original, input, waitMs)
    : api.resumeWorkspaceImplicitMoveOperation(original, { workspaceId: input.workspaceId, requestId: captured.request.requestId }, waitMs);
  return { state, failure, captured, invoke, assertUnwound, advanceFailure };
}

for (const entry of ['prepare', 'resume'] as const) {
  test(`${entry}: typed pre-mutation conflict resumes only the original sealed request after full unwind`, async () => {
    const h = await fixture({ mode: 'success' });
    const result = await h.invoke(entry);
    assert.equal(result.state, 'batch'); assert.equal(result.operationId, h.captured.selection.operationId);
    assert.equal(result.requestId, h.captured.request.requestId); assert.equal(h.state.attempts, 2);
    assert.equal(h.state.mutations, 1); assert.deepEqual(h.state.sleeps, [100]);
    assert.deepEqual(h.state.requests, [h.captured.request, h.captured.request]);
    assert(h.state.authCalls >= 7, 'every attempt and recovery obtains a fresh observed Principal'); h.assertUnwound();
  });

  test(`${entry}: persistent typed conflict returns same pending identity at the original total deadline`, async () => {
    const h = await fixture({ initialAuthCost: 50 });
    const result = await h.invoke(entry, 250);
    assert.equal(result.state, 'pending'); assert.equal(result.operationId, h.captured.selection.operationId);
    assert.equal(result.requestId, h.captured.request.requestId); assert.equal(h.state.now, 250);
    assert.equal(h.state.attempts, 2); assert.equal(h.state.mutations, 0); assert.deepEqual(h.state.sleeps, [100, 100]);
    assert(h.state.requests.every(request => Admission.captureCollaborationAdmissionRequest(request).intentText
      === Admission.captureCollaborationAdmissionRequest(h.captured.request).intentText)); h.assertUnwound();
  });
}

test('proof work exhausting the existing deadline cannot start final Handoff', async () => {
  const h = await fixture({ proofCost: 25 }); const result = await h.invoke('resume', 50);
  assert.equal(result.state, 'pending'); assert.equal(h.state.attempts, 0); assert.equal(h.state.now, 50);
  assert.equal(h.state.mutations, 0); assert.deepEqual(h.state.sleeps, []); h.assertUnwound();
});

const rejectedCases: readonly (readonly [string, Options])[] = [
  ['lookalike error code', { error: Object.assign(new Error('Declared SQL failure.'), { code: 'ADMISSION_CONFLICT' }) }],
  ['unknown SQL busy code', { error: Object.assign(new Error('Declared SQL busy.'), { code: '55P03' }) }],
  ['aggregate containing admission conflict', { error: new AggregateError([new Admission.CollaborationAdmissionError('ADMISSION_CONFLICT')]) }],
  ['other genuine admission error', { error: new Admission.CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED') }],
  ['duplicate advisory keys', { duplicateKeys: true }],
  ['entered synchronous mutation', { mode: 'mutation-conflict' }],
  ['fresh changed sealed selection', { afterConflict: 'selection' }],
  ['fresh recovery-required status', { afterConflict: 'recovery_required' }],
  ['admission-shaped disposal failure', { closeError: new Admission.CollaborationAdmissionError('ADMISSION_CONFLICT') }],
  ['disposal failure despite fresh terminal history', { closeError: new Admission.CollaborationAdmissionError('ADMISSION_CONFLICT'), terminalOnConflict: true }],
  ['aggregate despite fresh terminal history', { error: new AggregateError([new Admission.CollaborationAdmissionError('ADMISSION_CONFLICT')]), terminalOnConflict: true }],
];
for (const [label, options] of rejectedCases) test(`${label} never becomes a retry or Pending success`, async () => {
  const h = await fixture(options);
  await assert.rejects(h.invoke('prepare'), (error: unknown) => {
    assert(error instanceof Error && 'code' in error);
    assert.equal(error.code, options.error instanceof AggregateError || options.closeError !== undefined
      ? 'IMPLICIT_MOVE_DISPOSAL_UNCONFIRMED' : 'IMPLICIT_MOVE_OUTCOME_UNCONFIRMED');
    assert.equal(error.cause, options.closeError ?? h.failure); return true;
  });
  assert.equal(h.state.attempts, 1); assert.equal(h.state.mutations, options.mode === 'mutation-conflict' ? 1 : 0);
  assert.deepEqual(h.state.sleeps, []); h.assertUnwound();
});

test('fresh current access denial after the conflict remains an access error', async () => {
  const h = await fixture({ afterConflict: 'auth' });
  await assert.rejects(h.invoke('resume'), { code: 'IMPLICIT_MOVE_ACCESS_DENIED', status: 403 });
  assert.equal(h.state.attempts, 1); assert.equal(h.state.mutations, 0); assert.deepEqual(h.state.sleeps, []); h.assertUnwound();
});


test('a conflict after the retry enters mutate synchronously exactly once and cannot retry again', async () => {
  const h = await fixture({ mode: 'retry-then-mutation-conflict' });
  await assert.rejects(h.invoke('resume'), (error: unknown) => {
    assert(error instanceof Error && 'code' in error); assert.equal(error.code, 'IMPLICIT_MOVE_OUTCOME_UNCONFIRMED');
    assert.equal(error.cause, h.failure); return true;
  });
  assert.equal(h.state.attempts, 2); assert.equal(h.state.mutations, 1); assert.deepEqual(h.state.sleeps, [100]);
  assert.deepEqual(h.state.requests, [h.captured.request, h.captured.request]); h.assertUnwound();
});

test('a final conflict consuming the remaining deadline does not start another scope or sleep outside it', async () => {
  const h = await fixture({ handoffCost: 250 }); const result = await h.invoke('prepare', 250);
  assert.equal(result.state, 'pending'); assert.equal(h.state.now, 250); assert.equal(h.state.attempts, 1);
  assert.equal(h.state.mutations, 0); assert.deepEqual(h.state.sleeps, []); h.assertUnwound();
});


test('a fresh concurrent terminal cancellation is read without invoking a new mutation', async () => {
  const h = await fixture({ mode: 'terminal' }); const result = await h.invoke('resume');
  assert.equal(result.state, 'aborted'); assert.equal(h.state.attempts, 2); assert.equal(h.state.mutations, 0);
  assert.deepEqual(h.state.requests, [h.captured.request, h.captured.request]); h.assertUnwound();
});

for (const entry of ['prepare', 'resume'] as const) for (const advanceFault of ['principal', 'admission'] as const) {
  test(`${entry}: a genuine ${advanceFault} ADVANCE Busy retries the same sealed command only after rollback and close`, async () => {
    const h = await fixture({ mode: 'success', handoffImmediate: true, advanceFault });
    const result = await h.invoke(entry, 250);
    assert.equal(result.state, 'batch'); assert.equal(result.requestId, h.captured.request.requestId);
    assert.equal(result.operationId, h.captured.selection.operationId);
    assert.equal(h.state.advanceFailures, 1); assert(h.state.advanceAttempts >= 2);
    assert(h.state.advanceRequestIds.every(id => id === h.captured.request.requestId));
    assert(h.state.advanceAuthCalls[1] > h.state.advanceAuthCalls[0], 'The retry must acquire a fresh observed Principal.');
    const firstFailure = h.state.events.indexOf('advance:failed');
    assert.deepEqual(h.state.events.slice(firstFailure, firstFailure + 3), ['advance:failed', 'ROLLBACK', 'close']);
    assert.equal(h.state.attempts, 1); assert.equal(h.state.mutations, 1); assert.deepEqual(h.state.sleeps, [100]);
    assert.deepEqual(h.state.requests, [h.captured.request]); h.assertUnwound();
  });
}

for (const advanceFault of ['principal', 'admission'] as const) {
  test(`persistent genuine ${advanceFault} ADVANCE Busy preserves Pending and the original total deadline`, async () => {
    const h = await fixture({ mode: 'success', handoffImmediate: true, advanceFault, advanceAlways: true, initialAuthCost: 50 });
    const result = await h.invoke('prepare', 250);
    assert.equal(result.state, 'pending'); assert.equal(result.requestId, h.captured.request.requestId);
    assert.equal(result.operationId, h.captured.selection.operationId); assert.equal(h.state.now, 250);
    assert.equal(h.state.advanceAttempts, 2); assert.equal(h.state.advanceFailures, 2);
    assert.deepEqual(h.state.sleeps, [100, 100]); assert.equal(h.state.attempts, 0); assert.equal(h.state.mutations, 0);
    assert(h.state.advanceRequestIds.every(id => id === h.captured.request.requestId)); h.assertUnwound();
  });
}

const rejectedAdvanceCases: readonly (readonly [string, Options])[] = [
  ['raw SQL code without typed Principal provenance', { advanceFault: 'raw-sql' }],
  ['public Busy lookalike without a private marker', { advanceFault: 'public-lookalike' }],
  ['admission code lookalike without class provenance', { advanceFault: 'admission-lookalike' }],
  ['genuine current authentication failure', { advanceFault: 'auth' }],
  ['genuine current schema failure', { advanceFault: 'schema' }],
  ['rollback failure containing the same genuine Busy', { advanceFault: 'principal', advanceCleanupFault: 'rollback' }],
  ['close failure rethrowing the identical genuine Busy', { advanceFault: 'principal', advanceCleanupFault: 'close' }],
  ['mutex unwind rethrowing the identical genuine Busy', { advanceFault: 'principal', advanceMutexFault: true }],
  ['unknown ADVANCE COMMIT followed by Busy in nested observation', { advanceCommitObserveBusy: true }],
];
for (const [label, options] of rejectedAdvanceCases) test(`${label} never starts another ADVANCE or final mutation`, async () => {
  const h = await fixture({ mode: 'success', handoffImmediate: true, ...options });
  await assert.rejects(h.invoke('resume', 250), (error: unknown) => {
    if (options.advanceCleanupFault === 'rollback') {
      assert(error instanceof AggregateError); assert.deepEqual(error.errors, [h.advanceFailure, h.advanceFailure]);
    } else if (options.advanceFault === 'public-lookalike') assert.equal(error, h.advanceFailure);
    else {
      assert(error instanceof Error && 'code' in error && 'status' in error);
      assert.equal(error.code, options.advanceFault === 'auth' ? 'IMPLICIT_MOVE_AUTH_REQUIRED'
        : options.advanceFault === 'schema' ? 'IMPLICIT_MOVE_PRINCIPAL_UNCONFIRMED' : 'IMPLICIT_MOVE_BUSY');
      assert.equal(error.status, options.advanceFault === 'auth' ? 401 : 503);
      assert.equal(error.cause, h.advanceFailure);
    }
    return true;
  });
  assert.equal(h.state.advanceAttempts, 1); assert.equal(h.state.attempts, 0); assert.equal(h.state.mutations, 0);
  assert.deepEqual(h.state.sleeps, []); h.assertUnwound();
});

for (const entry of ['prepare', 'resume'] as const) test(`${entry}: genuine Busy outside ADVANCE cannot obtain retry provenance`, async () => {
  const h = await fixture({ mode: 'success', handoffImmediate: true, nonAdvanceBusy: true });
  await assert.rejects(h.invoke(entry, 250), { code: 'IMPLICIT_MOVE_BUSY', status: 503 });
  assert.equal(h.state.advanceAttempts, 0); assert.equal(h.state.attempts, 0); assert.equal(h.state.mutations, 0);
  assert.deepEqual(h.state.sleeps, []); h.assertUnwound();
});

for (const afterAdvanceBusy of ['auth', 'schema', 'selection'] as const) test(`fresh ${afterAdvanceBusy} change after settled ADVANCE Busy stops the retained command`, async () => {
  const h = await fixture({ mode: 'success', handoffImmediate: true, advanceFault: 'principal', afterAdvanceBusy });
  await assert.rejects(h.invoke('resume', 250), {
    code: afterAdvanceBusy === 'auth' ? 'IMPLICIT_MOVE_ACCESS_DENIED'
      : afterAdvanceBusy === 'schema' ? 'IMPLICIT_MOVE_PRINCIPAL_UNCONFIRMED' : 'IMPLICIT_MOVE_HISTORY_CHANGED',
    status: afterAdvanceBusy === 'auth' ? 403 : afterAdvanceBusy === 'schema' ? 503 : 409,
  });
  assert.equal(h.state.advanceFailures, 1); assert.equal(h.state.advanceAttempts, 1);
  assert.equal(h.state.attempts, 0); assert.equal(h.state.mutations, 0); assert.deepEqual(h.state.sleeps, [100]);
  h.assertUnwound();
});
