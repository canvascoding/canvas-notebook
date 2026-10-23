import assert from 'node:assert/strict';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';
import { undoWorkspacePathOperation, waitForWorkspacePathOperationResult, WorkspacePathOperationClientError, WorkspacePathOperationOutcomeUnknownError } from '../app/lib/files/workspace-path-operation-client';
import type { WorkspacePathOperationPublic, WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';
import { readWorkspacePathOperation } from '../app/lib/files/workspace-path-operation-parser';
import { renameWorkspacePath } from '../app/lib/files/client';
import { readWorkspaceImplicitMoveBinding, readWorkspaceImplicitMovePreparation, readWorkspaceImplicitMoveLegacyReplay,
  workspaceImplicitMovePreparationBinding } from '../app/lib/files/workspace-implicit-move-parser';
import { waitForWorkspaceImplicitMoveResponse, WorkspaceImplicitMovePendingError, WorkspaceImplicitMoveAbortedError }
  from '../app/lib/files/workspace-implicit-move-client';
import { observeOpenedDocumentAuth, openedDocumentAuthScope } from '../app/lib/collaboration/opened-document-registry';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { reserveWorkspacePathOperationAttempt, markWorkspacePathOperationAttemptImplicit, dispatchWorkspacePathOperationAttempt,
  abandonWorkspacePathOperationAttempt, settleWorkspacePathOperationAttempt } from '../app/lib/files/workspace-path-operation-attempts';

const operation = (status: WorkspacePathOperationPublic['status']): WorkspacePathOperationPublic => ({
  batchId: 'direct-client-batch-1234567890', planId: 'a'.repeat(64), workspaceId: 'workspace-client',
  status, completedActions: ['applied', 'undone'].includes(status) ? 2 : 0, totalActions: 2,
  phase: ['applied', 'undone'].includes(status) ? 'complete' : 'preparing', errorCode: null,
  kind: 'move', selections: [{ sourcePath: 'old.md', destinationPath: 'new.md' }],
});

const implicitIdentity = { actorUserId: 'implicit-client-user', workspaceId: 'workspace-client',
  operationId: 'implicit-original-request', requestId: '11111111-2222-3333-4444-555555555555', selectionDigest: 'b'.repeat(64) };
const implicitSelections = [{ sourcePath: 'old.md', destinationPath: 'new.md' }];
const implicitBinding = () => ({ version: 1 as const, kind: 'implicit-move-binding' as const, ...implicitIdentity });
const legacyReplay = () => ({ version: 1 as const, kind: 'implicit-move-legacy-replay' as const,
  actorUserId: implicitIdentity.actorUserId, workspaceId: implicitIdentity.workspaceId,
  operationId: implicitIdentity.operationId, batchId: operation('queued').batchId, planId: operation('queued').planId });
const preparation = (status: 'reserved' | 'draining' | 'recovery_required' = 'reserved') => ({
  version: 2 as const, kind: 'implicit-move-preparation' as const, state: 'pending' as const, ...implicitIdentity,
  action: 'rename' as const, selections: implicitSelections.map(selection => ({ ...selection })), status,
  canResume: status !== 'recovery_required', statusUrl: '/api/files/operations/implicit-moves/' + implicitIdentity.requestId,
  resumeUrl: '/api/files/operations/implicit-moves/' + implicitIdentity.requestId,
});
const preparationExpected = () => ({ ...implicitIdentity, action: 'rename' as const, selections: implicitSelections });
const abortedPreparation = (reason: 'user_cancelled' | 'precondition_failed' = 'precondition_failed') => ({
  version: 2 as const, kind: 'implicit-move-preparation' as const, state: 'aborted' as const, ...implicitIdentity,
  action: 'rename' as const, selections: implicitSelections.map(selection => ({ ...selection })), reason,
});

/** HTTP-shaped data and auth observations here are unit fixtures only.
 * They prove client validation, never real authentication or a committed move. */
function implicitMovePublicParserTest(): void {
  for (const status of ['reserved', 'draining', 'recovery_required'] as const) {
    const raw = preparation(status), before = JSON.stringify(raw);
    const parsed = readWorkspaceImplicitMovePreparation(raw, preparationExpected());
    assert.deepEqual(parsed, raw);
    assert.equal(JSON.stringify(raw), before, 'reading cannot mutate the source DTO');
    assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.selections) && Object.isFrozen(parsed.selections[0]));
    assert.notEqual(parsed.selections, raw.selections);
    raw.selections[0].sourcePath = 'later.md';
    assert.equal(parsed.selections[0].sourcePath, 'old.md', 'validated paths are detached from later input changes');
    assert.deepEqual(workspaceImplicitMovePreparationBinding(parsed), implicitBinding());
    assert.deepEqual(readWorkspaceImplicitMovePreparation(preparation(status), {
      actorUserId: implicitIdentity.actorUserId, workspaceId: implicitIdentity.workspaceId, requestId: implicitIdentity.requestId,
    }), preparation(status), 'discovery may initially pin account/workspace/request only');
  }
  for (const reason of ['user_cancelled', 'precondition_failed'] as const) {
    assert.deepEqual(readWorkspaceImplicitMovePreparation(abortedPreparation(reason), preparationExpected()), abortedPreparation(reason));
  }
  for (const patch of [{ version: 2 }, { kind: 'implicit-move-preparation' }, { requestId: 'not-a-uuid' },
    { selectionDigest: 'invalid' }, { actorUserId: 'user\u200b' }]) {
    assert.throws(() => readWorkspaceImplicitMoveBinding({ ...implicitBinding(), ...patch }));
  }
  const moved = { ...preparation(), action: 'move' as const };
  assert.deepEqual(readWorkspaceImplicitMovePreparation(moved, { ...preparationExpected(), action: 'move' }), moved);

  for (const patch of [
    { actorUserId: 'other-user' }, { workspaceId: 'other-workspace' }, { operationId: 'other-original-request' },
    { requestId: '66666666-7777-8888-9999-aaaaaaaaaaaa' }, { selectionDigest: 'c'.repeat(64) },
  ]) {
    assert.throws(() => readWorkspaceImplicitMoveBinding({ ...implicitBinding(), ...patch }, implicitIdentity));
    assert.throws(() => readWorkspaceImplicitMovePreparation({ ...preparation(), ...patch }, preparationExpected()));
  }
  for (const patch of [
    { version: 1 }, { version: 3 }, { kind: 'implicit-move-binding' }, { state: 'complete' }, { action: 'delete' },
    { action: 'move' }, { selections: [{ sourcePath: 'another.md', destinationPath: 'new.md' }] },
    { selections: [{ sourcePath: 'old.md', destinationPath: 'another.md' }] },
    { selections: [...implicitSelections, { sourcePath: 'more.md', destinationPath: 'more-new.md' }] },
    { requestId: implicitIdentity.requestId.toUpperCase().replace('1111', 'AAAA') }, { selectionDigest: 'B'.repeat(64) },
    { actorUserId: '' }, { workspaceId: 'x'.repeat(257) }, { operationId: 'x'.repeat(513) },
  ]) assert.throws(() => readWorkspaceImplicitMovePreparation({ ...preparation(), ...patch }, preparationExpected()));
  const paired = { ...preparation(), selections: [...implicitSelections, { sourcePath: 'second.md', destinationPath: 'second-new.md' }] };
  assert.throws(() => readWorkspaceImplicitMovePreparation({ ...paired, selections: [...paired.selections].reverse() },
    { ...preparationExpected(), selections: paired.selections }), 'selection order is part of the original request');

  const invalidPaths = ['', '.', '..', '../old.md', '/private/old.md', 'C:old.md', 'folder\\old.md', 'https://foreign/old.md',
    'one//old.md', 'one/./old.md', 'one/../old.md', 'old\u0000.md', 'old\u200b.md', '\ud800', 'a'.repeat(4097),
    '😀'.repeat(1025), Array.from({ length: 34 }, () => 'a').join('/')];
  for (const unsafePath of invalidPaths) for (const key of ['sourcePath', 'destinationPath'] as const) {
    assert.throws(() => readWorkspaceImplicitMovePreparation({ ...preparation(),
      selections: [{ ...implicitSelections[0], [key]: unsafePath }] }, {
      actorUserId: implicitIdentity.actorUserId, workspaceId: implicitIdentity.workspaceId,
    }), 'path rejection must not rely on an expected path pin');
  }
  for (const selections of [[], Array.from({ length: 1001 }, () => ({ ...implicitSelections[0] })),
    Array.from({ length: 9 }, () => ({ sourcePath: 'a'.repeat(4000), destinationPath: 'b'.repeat(4000) }))]) {
    assert.throws(() => readWorkspaceImplicitMovePreparation({ ...preparation(), selections },
      { actorUserId: implicitIdentity.actorUserId, workspaceId: implicitIdentity.workspaceId }));
  }

  for (const patch of [
    { status: 'committed' }, { status: 'reserved', canResume: false }, { status: 'draining', canResume: false },
    { status: 'recovery_required', canResume: true }, { canResume: 'true' }, { canResume: 1 },
    { statusUrl: 'https://foreign.test/api/files/operations/implicit-moves/' + implicitIdentity.requestId },
    { resumeUrl: '//foreign.test/resume' }, { resumeUrl: preparation().resumeUrl + '?resume=true' },
    { statusUrl: preparation().statusUrl + '/' },
    { statusUrl: '/api/files/operations/implicit-moves/66666666-7777-8888-9999-aaaaaaaaaaaa' },
    { resumeUrl: '/api/files/operations/batches/' + operation('queued').batchId },
  ]) assert.throws(() => readWorkspaceImplicitMovePreparation({ ...preparation(), ...patch }, preparationExpected()));
  assert.throws(() => readWorkspaceImplicitMovePreparation({ ...abortedPreparation(), reason: 'unknown' }, preparationExpected()));
  assert.throws(() => readWorkspaceImplicitMovePreparation({ ...abortedPreparation(), canResume: false }, preparationExpected()));

  let getterCalls = 0;
  const coercibleState = {};
  Object.defineProperty(coercibleState, Symbol.toPrimitive, { enumerable: true,
    get: () => { getterCalls++; return () => 'aborted'; } });
  assert.throws(() => readWorkspaceImplicitMovePreparation({ ...abortedPreparation(), state: coercibleState },
    preparationExpected()), 'state must be a literal before any value coercion');
  assert.equal(getterCalls, 0, 'state coercion accessors cannot run');
  const readers: Array<{ raw: object; read: (value: unknown) => unknown }> = [
    { raw: implicitBinding(), read: value => readWorkspaceImplicitMoveBinding(value, implicitIdentity) },
    { raw: preparation(), read: value => readWorkspaceImplicitMovePreparation(value, preparationExpected()) },
    { raw: legacyReplay(), read: value => readWorkspaceImplicitMoveLegacyReplay(value, legacyReplay()) },
  ];
  for (const { raw, read } of readers) {
    const accessor = { ...raw };
    Object.defineProperty(accessor, 'version', { enumerable: true, get: () => { getterCalls++; return 1; } });
    assert.throws(() => read(accessor)); assert.equal(getterCalls, 0, 'wire getters cannot run');
    const hidden = { ...raw }; Object.defineProperty(hidden, 'version', { enumerable: false, value: 1 });
    const symbol = { ...raw, [Symbol('extra')]: 'not-public' };
    const inherited = Object.setPrototypeOf({ ...raw }, { inherited: true });
    const nullPrototype = Object.assign(Object.create(null), raw);
    const forbidden = Object.defineProperty({ ...raw }, '__proto__', { enumerable: true, value: {} });
    for (const invalid of [null, [], hidden, symbol, inherited, nullPrototype, forbidden, { ...raw, privateText: 'private' }]) {
      assert.throws(() => read(invalid), 'exact own plain data keys are required');
    }
    const missing = { ...raw } as Record<string, unknown>; delete missing.version;
    assert.throws(() => read(missing));
  }
  const accessorSelection = { ...implicitSelections[0] };
  Object.defineProperty(accessorSelection, 'sourcePath', { enumerable: true, get: () => { getterCalls++; return 'old.md'; } });
  const accessorArray = [{ ...implicitSelections[0] }];
  Object.defineProperty(accessorArray, '0', { enumerable: true, get: () => { getterCalls++; return implicitSelections[0]; } });
  const sparse: Array<{ sourcePath: string; destinationPath: string }> = []; sparse.length = 1;
  const extraArray = [{ ...implicitSelections[0] }]; Object.defineProperty(extraArray, 'extra', { enumerable: true, value: true });
  for (const selections of [[accessorSelection], accessorArray, sparse, extraArray]) {
    assert.throws(() => readWorkspaceImplicitMovePreparation({ ...preparation(), selections }, preparationExpected()));
  }
  assert.equal(getterCalls, 0, 'selection and array accessors cannot run');

  const legacy = legacyReplay();
  assert.deepEqual(readWorkspaceImplicitMoveLegacyReplay(legacy, legacy), legacy);
  assert(Object.isFrozen(readWorkspaceImplicitMoveLegacyReplay(legacy)));
  for (const patch of [
    { actorUserId: 'other-user' }, { workspaceId: 'other-workspace' }, { operationId: 'other-request' },
    { batchId: 'other-client-batch-1234567890' }, { planId: 'd'.repeat(64) }, { version: 2 },
    { kind: 'implicit-move-binding' }, { batchId: '../private-batch' }, { planId: 'invalid' },
    { requestId: implicitIdentity.requestId }, { selectionDigest: implicitIdentity.selectionDigest },
  ]) assert.throws(() => readWorkspaceImplicitMoveLegacyReplay({ ...legacy, ...patch }, legacy));

  for (const metadata of [{ implicitBinding: implicitBinding() }, { legacyImplicitReplay: legacy }]) {
    assert.deepEqual(readWorkspacePathOperation({ ...operation('queued'), kind: 'rename', ...metadata }), {
      ...operation('queued'), kind: 'rename', ...metadata });
    assert.throws(() => readWorkspacePathOperation({ ...operation('queued'), kind: 'delete', ...metadata }));
    assert.throws(() => readWorkspacePathOperation({ ...operation('queued'), kind: 'rename', ...metadata,
      preparation: { previewPlanId: 'e'.repeat(64) } }));
  }
  assert.throws(() => readWorkspacePathOperation({ ...operation('queued'),
    implicitBinding: implicitBinding(), legacyImplicitReplay: legacy }), 'new binding and historical replay cannot coexist');
  console.log('implicit public parser: positive states, identity/path/budget/URL/own-data negatives and explicit legacy arms passed');
}

async function implicitMoveInitialTransportTest(): Promise<void> {
  const originalFetch = globalThis.fetch, originalAuth = openedDocumentAuthScope();
  const originalWorkspace = useWorkspaceStore.getState().activeWorkspaceId;
  observeOpenedDocumentAuth({ data: { user: { id: implicitIdentity.actorUserId }, session: { id: 'implicit-client-unit-session' } } });
  useWorkspaceStore.setState({ activeWorkspaceId: implicitIdentity.workspaceId });
  let serial = 0;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); throw new Error('Unexpected mutation or poll'); };
  const attempt = () => {
    const selections = [{ sourcePath: 'unit-' + (++serial) + '.md', destinationPath: 'unit-' + serial + '-new.md' }];
    const input = { workspaceId: implicitIdentity.workspaceId, kind: 'rename' as const, selections };
    const ticket = reserveWorkspacePathOperationAttempt(input);
    markWorkspacePathOperationAttemptImplicit(ticket); dispatchWorkspacePathOperationAttempt(ticket);
    const binding = { ...implicitBinding(), operationId: ticket.operationId };
    const legacy = { ...legacyReplay(), operationId: ticket.operationId };
    const completed = { ...operation('applied'), kind: 'rename' as const, selections };
    const context = { attempt: ticket, workspaceId: implicitIdentity.workspaceId, action: 'rename' as const, selections };
    return { ticket, binding, legacy, completed, context, input };
  };
  try {
    {
      const state = attempt();
      try {
        const reply = { historical: true as const, operation: { ...state.completed, legacyImplicitReplay: state.legacy }, linkStatus: 'complete' as const };
        const result = await waitForWorkspaceImplicitMoveResponse(Response.json(reply), state.context);
        assert.deepEqual(result, reply);
        const next = reserveWorkspacePathOperationAttempt(state.input);
        assert.notEqual(next.operationId, state.ticket.operationId, 'verified historical completion resolves the original local attempt');
        abandonWorkspacePathOperationAttempt(next);
      } finally { settleWorkspacePathOperationAttempt(state.ticket, 'rejected'); }
    }
    for (const invalid of [
      (state: ReturnType<typeof attempt>) => ({ operation: { ...state.completed, legacyImplicitReplay: state.legacy } }),
      (state: ReturnType<typeof attempt>) => ({ historical: true, operation: state.completed }),
      (state: ReturnType<typeof attempt>) => ({ historical: false, operation: { ...state.completed, legacyImplicitReplay: state.legacy } }),
      (state: ReturnType<typeof attempt>) => ({ historical: true, operation: { ...state.completed,
        legacyImplicitReplay: { ...state.legacy, actorUserId: 'other-user' } } }),
      (state: ReturnType<typeof attempt>) => ({ historical: true, operation: { ...state.completed,
        legacyImplicitReplay: { ...state.legacy, operationId: 'other-original-request' } } }),
      (state: ReturnType<typeof attempt>) => ({ historical: true, operation: { ...state.completed,
        implicitBinding: state.binding, legacyImplicitReplay: state.legacy } }),
    ]) {
      const state = attempt();
      try {
        await assert.rejects(waitForWorkspaceImplicitMoveResponse(Response.json({ ...invalid(state), linkStatus: 'complete' }), state.context),
          (error: unknown) => error instanceof WorkspacePathOperationOutcomeUnknownError
            || error instanceof Error && /^(?:Invalid implicit file preparation response|Invalid file action status response)/u.test(error.message));
      } finally { settleWorkspacePathOperationAttempt(state.ticket, 'rejected'); }
    }
    {
      const state = attempt();
      try {
        const reply = { operation: { ...state.completed, implicitBinding: state.binding }, linkStatus: 'complete' as const,
          mutation: { type: 'rename' as const, workspaceId: implicitIdentity.workspaceId, operationId: 'native-move:' + 'f'.repeat(64),
            oldPath: state.input.selections[0].sourcePath, newPath: state.input.selections[0].destinationPath } };
        assert.deepEqual(await waitForWorkspaceImplicitMoveResponse(Response.json(reply), state.context), reply);
      } finally { settleWorkspacePathOperationAttempt(state.ticket, 'rejected'); }
    }
    {
      const state = attempt();
      try {
        const pending = { ...preparation('recovery_required'), operationId: state.ticket.operationId, selections: state.input.selections };
        await assert.rejects(waitForWorkspaceImplicitMoveResponse(Response.json({ success: true, preparation: pending }, { status: 202 }), state.context),
          (error: unknown) => error instanceof WorkspaceImplicitMovePendingError && error.preparation.state === 'pending'
            && error.preparation.canResume === false);
        assert.deepEqual(state.ticket.implicitBinding, state.binding, 'a non-resumable preparation still pins the original identity');
      } finally { settleWorkspacePathOperationAttempt(state.ticket, 'rejected'); }
    }
    for (const code of ['OTHER_ABORT_CODE', 'IMPLICIT_MOVE_PREPARATION_ABORTED']) {
      const state = attempt();
      try {
        const aborted = { ...abortedPreparation(), operationId: state.ticket.operationId, selections: state.input.selections };
        await assert.rejects(waitForWorkspaceImplicitMoveResponse(Response.json({ success: false, code, preparation: aborted }, { status: 409 }), state.context),
          (error: unknown) => code === 'IMPLICIT_MOVE_PREPARATION_ABORTED'
            ? error instanceof WorkspaceImplicitMoveAbortedError : error instanceof WorkspacePathOperationOutcomeUnknownError);
        const next = reserveWorkspacePathOperationAttempt(state.input);
        if (code === 'IMPLICIT_MOVE_PREPARATION_ABORTED') assert.notEqual(next.operationId, state.ticket.operationId);
        else assert.equal(next.operationId, state.ticket.operationId, 'an arbitrary 409 code cannot resolve the original attempt');
        abandonWorkspacePathOperationAttempt(next);
      } finally { settleWorkspacePathOperationAttempt(state.ticket, 'rejected'); }
    }
    assert.equal(requests.length, 0, 'settled replies and non-resumable preparations never submit or poll');
    {
      const state = attempt();
      try {
        const mutation = { type: 'rename' as const, workspaceId: implicitIdentity.workspaceId, operationId: 'native-move:' + 'f'.repeat(64),
          oldPath: state.input.selections[0].sourcePath, newPath: state.input.selections[0].destinationPath };
        globalThis.fetch = async (url, init) => {
          requests.push({ url: String(url), init });
          assert.equal(String(url), '/api/files/operations/batches/' + state.completed.batchId);
          assert.equal(init?.method ?? 'GET', 'GET'); assert.equal(init?.body, undefined);
          return Response.json({ operation: state.completed, linkStatus: 'complete', mutation });
        };
        const queued = { ...state.completed, status: 'queued' as const, phase: 'preparing' as const, completedActions: 0,
          implicitBinding: state.binding };
        const result = await waitForWorkspaceImplicitMoveResponse(Response.json({ operation: queued }), state.context);
        assert.deepEqual(result.operation.implicitBinding, state.binding);
        assert.equal(requests.length, 1, 'the original attempt may finish through one generic batch GET with no repeated binding');
        const next = reserveWorkspacePathOperationAttempt(state.input);
        assert.notEqual(next.operationId, state.ticket.operationId, 'sticky binding permits verified completion to resolve the original attempt');
        abandonWorkspacePathOperationAttempt(next);
      } finally { settleWorkspacePathOperationAttempt(state.ticket, 'rejected'); }
    }
  } finally {
    globalThis.fetch = originalFetch;
    useWorkspaceStore.setState({ activeWorkspaceId: originalWorkspace });
    observeOpenedDocumentAuth(originalAuth ? { data: { user: { id: originalAuth.userId }, session: { id: originalAuth.sessionId } } } : null);
  }
  console.log('implicit initial transport: exact tagged historical replay, new completion, pending and exact abort code passed');
}


type ImplicitUnitPhase = 'preview' | 'first-post' | 'resume-post' | 'batch-get';
function implicitUnitDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function implicitUnitBounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Unit transport did not settle: ' + label)), 5000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Actual rename/attempt/client functions with controlled HTTP-shaped responses.
 * No file-store writer or real auth/persistence is simulated by these fixtures. */
async function implicitRenameResumeAndScopeRaceTest(): Promise<void> {
  const originalFetch = globalThis.fetch, originalAuth = openedDocumentAuthScope();
  const originalWorkspace = useWorkspaceStore.getState().activeWorkspaceId;
  let serial = 0;
  const makeFlow = () => {
    const id = ++serial, sessionId = 'implicit-flow-session-' + id;
    observeOpenedDocumentAuth({ data: { user: { id: implicitIdentity.actorUserId }, session: { id: sessionId } } });
    useWorkspaceStore.setState({ activeWorkspaceId: implicitIdentity.workspaceId });
    const selections = [{ sourcePath: 'flow-' + id + '.md', destinationPath: 'Archive/flow-' + id + '.md' }];
    const input = { workspaceId: implicitIdentity.workspaceId, kind: 'rename' as const, selections };
    const ticket = reserveWorkspacePathOperationAttempt(input);
    const binding = { ...implicitBinding(), operationId: ticket.operationId };
    const preview = { dryRun: true, requiresRevalidation: true, plan: { version: 3, kind: 'native-path-change',
      workspaceId: input.workspaceId, planId: 'c'.repeat(64), readiness: 'ready', pathMappings: selections,
      coverage: { complete: true, omittedSources: [], unresolvedLinks: [] }, linkEdits: [],
      linkAssessment: { complete: true, blockers: [], warnings: [] }, issues: [] } };
    const completed = { ...operation('applied'), kind: 'rename' as const, selections,
      implicitBinding: binding, batchId: 'implicit-flow-batch-' + String(id).padStart(16, '0') };
    const mutation = { type: 'rename' as const, workspaceId: input.workspaceId, operationId: 'native-move:' + 'f'.repeat(64),
      oldPath: selections[0].sourcePath, newPath: selections[0].destinationPath };
    const complete = { operation: completed, mutation, linkStatus: 'complete' as const };
    const queued = { operation: { ...completed, status: 'queued' as const, phase: 'preparing' as const, completedActions: 0 } };
    const pending = (status: 'reserved' | 'draining' | 'recovery_required' = 'reserved') => ({
      success: true, preparation: { ...preparation(status), operationId: ticket.operationId, selections },
    });
    return { sessionId, input, ticket, binding, preview, complete, queued, pending,
      resumeUrl: preparation().resumeUrl, batchUrl: '/api/files/operations/batches/' + completed.batchId };
  };
  type Flow = ReturnType<typeof makeFlow>;
  type Request = { phase: ImplicitUnitPhase; url: string; init?: RequestInit; body: Record<string, unknown> | undefined };
  const origin = (flow: Flow) => {
    observeOpenedDocumentAuth({ data: { user: { id: implicitIdentity.actorUserId }, session: { id: flow.sessionId } } });
    useWorkspaceStore.setState({ activeWorkspaceId: flow.input.workspaceId });
  };
  const classify = (flow: Flow, url: string, init?: RequestInit): Request => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(init?.credentials, 'include');
    assert.equal(new Headers(init?.headers).get(WORKSPACE_ID_HEADER), flow.input.workspaceId);
    if (url === '/api/files/rename') {
      assert.equal(init?.method, 'POST');
      if (body?.dryRun === true) {
        assert.deepEqual(body, { oldPath: flow.input.selections[0].sourcePath, newPath: flow.input.selections[0].destinationPath, dryRun: true });
        return { phase: 'preview', url, init, body };
      }
      assert.deepEqual(body, { oldPath: flow.input.selections[0].sourcePath, newPath: flow.input.selections[0].destinationPath,
        overwrite: false, idempotencyKey: flow.ticket.operationId }, 'diagnostic preview plan cannot be posted as a final immutable plan');
      return { phase: 'first-post', url, init, body };
    }
    if (url === flow.resumeUrl) {
      assert.equal(init?.method, 'POST'); assert.equal(init?.body, '{}'); assert.equal(init?.cache, 'no-store');
      assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
      return { phase: 'resume-post', url, init, body };
    }
    assert.equal(url, flow.batchUrl); assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(init?.body, undefined); assert.equal(init?.cache, 'no-store');
    return { phase: 'batch-get', url, init, body };
  };
  const invoke = (flow: Flow) => renameWorkspacePath(flow.input.selections[0].sourcePath,
    flow.input.selections[0].destinationPath, false, flow.input.workspaceId, undefined, flow.ticket);
  // Unit cleanup uses a new explicit same-account retry and the real completion
  // observer. It never resets the private attempt map or reuses a retired ticket.
  const finishRetained = async (flow: Flow) => {
    origin(flow);
    const probe = reserveWorkspacePathOperationAttempt(flow.input);
    const retained = probe.operationId === flow.ticket.operationId;
    abandonWorkspacePathOperationAttempt(probe);
    if (!retained) return;
    assert.equal(flow.ticket.implicit, true, 'a dispatched native attempt retains its implicit mode');
    const expectedUrl = flow.ticket.implicitBinding ? flow.resumeUrl : '/api/files/rename';
    const retries: Request[] = [];
    globalThis.fetch = async (url, init) => {
      const request = classify(flow, String(url), init); retries.push(request);
      assert.equal(request.url, expectedUrl); return Response.json(flow.complete);
    };
    const result = await implicitUnitBounded(renameWorkspacePath(flow.input.selections[0].sourcePath,
      flow.input.selections[0].destinationPath, false, flow.input.workspaceId), 'explicit cleanup retry');
    assert.equal(retries.length, 1, 'a known implicit attempt retries only its original endpoint');
    assert.deepEqual(result.mutation, flow.complete.mutation);
    const fresh = reserveWorkspacePathOperationAttempt(flow.input);
    assert.notEqual(fresh.operationId, flow.ticket.operationId, 'verified completion retires the retained unit request');
    abandonWorkspacePathOperationAttempt(fresh);
  };
  try {
    {
      const flow = makeFlow(), requests: Request[] = [], exposed: unknown[] = [];
      let resumeCount = 0;
      globalThis.fetch = async (url, init) => {
        const request = classify(flow, String(url), init); requests.push(request);
        assert.equal(exposed.length, 0, 'pending/resume/batch reads cannot expose a successful path mutation');
        if (request.phase === 'preview') return Response.json(flow.preview);
        if (request.phase === 'first-post') return Response.json(flow.pending(), { status: 202 });
        if (request.phase === 'resume-post') {
          resumeCount++;
          assert(resumeCount <= 2, 'the fixture has exactly two genuine resumable transitions');
          return resumeCount === 1 ? Response.json(flow.pending('draining'), { status: 202 }) : Response.json(flow.queued);
        }
        const { implicitBinding: fixtureBinding, ...genericOperation } = flow.complete.operation;
        assert.deepEqual(fixtureBinding, flow.binding);
        return Response.json({ ...flow.complete, operation: genericOperation });
      };
      try {
        const result = await implicitUnitBounded(invoke(flow).then(value => { exposed.push(value.mutation); return value; }), 'reserved -> draining -> queued -> applied');
        assert.deepEqual(requests.map(request => request.phase), ['preview', 'first-post', 'resume-post', 'resume-post', 'batch-get']);
        assert.deepEqual(requests.filter(request => request.phase === 'resume-post').map(request => request.url), [flow.resumeUrl, flow.resumeUrl]);
        assert.deepEqual(result.operation?.implicitBinding, flow.binding);
        assert.deepEqual(result.mutation, flow.complete.mutation); assert.equal(result.linkStatus, 'complete');
        assert.equal(exposed.length, 1, 'only the fully verified result exposes its mutation');
      } finally { await finishRetained(flow); }
    }
    {
      const flow = makeFlow(), requests: Request[] = [];
      globalThis.fetch = async (url, init) => {
        const request = classify(flow, String(url), init); requests.push(request);
        assert(request.phase === 'preview' || request.phase === 'first-post');
        return request.phase === 'preview' ? Response.json(flow.preview) : Response.json(flow.pending('recovery_required'), { status: 202 });
      };
      try {
        await assert.rejects(implicitUnitBounded(invoke(flow), 'recovery_required'), WorkspaceImplicitMovePendingError);
        assert.deepEqual(requests.map(request => request.phase), ['preview', 'first-post'], 'recovery_required cannot auto POST or poll');
        const retained = reserveWorkspacePathOperationAttempt(flow.input);
        assert.equal(retained.operationId, flow.ticket.operationId); assert.deepEqual(retained.implicitBinding, flow.binding);
        abandonWorkspacePathOperationAttempt(retained);
      } finally { await finishRetained(flow); }
    }

    for (const phase of ['preview', 'first-post', 'resume-post', 'batch-get'] as const) {
      for (const change of ['auth', 'workspace'] as const) {
        const flow = makeFlow(), requests: Request[] = [], exposed: unknown[] = [];
        const arrived = implicitUnitDeferred<void>(), release = implicitUnitDeferred<void>();
        let resumeCount = 0;
        globalThis.fetch = async (url, init) => {
          const request = classify(flow, String(url), init); requests.push(request);
          assert.equal(exposed.length, 0);
          if (request.phase === phase) { arrived.resolve(undefined); await release.promise; }
          if (request.phase === 'preview') return Response.json(flow.preview);
          if (request.phase === 'first-post') return Response.json(flow.pending(), { status: 202 });
          if (request.phase === 'resume-post') {
            assert.equal(++resumeCount, 1); return Response.json(flow.queued);
          }
          return Response.json(flow.complete);
        };
        const running = invoke(flow).then(result => { exposed.push(result.mutation); return { ok: true as const, result }; },
          error => ({ ok: false as const, error: error as unknown }));
        try {
          await implicitUnitBounded(Promise.race([arrived.promise, running.then(() => {
            throw new Error('Rename settled before its controlled ' + phase + ' await');
          })]), change + ' during ' + phase);
          if (change === 'auth') observeOpenedDocumentAuth({ data: { user: { id: 'different-implicit-unit-user' }, session: { id: 'different-unit-session' } } });
          else useWorkspaceStore.setState({ activeWorkspaceId: 'different-implicit-unit-workspace' });
          release.resolve(undefined);
          const outcome = await implicitUnitBounded(running, 'stale continuation ' + change + '/' + phase);
          assert.equal(outcome.ok, false, 'scope change during ' + phase + ' cannot return a successful rename');
          assert.equal(exposed.length, 0, 'no stale result may expose a path mutation');
          const expectedPhases = ['preview', 'first-post', 'resume-post', 'batch-get'].slice(0,
            ['preview', 'first-post', 'resume-post', 'batch-get'].indexOf(phase) + 1);
          assert.deepEqual(requests.map(request => request.phase), expectedPhases,
            'scope change during ' + phase + ' cannot dispatch another stale continuation');
          origin(flow);
          const retained = reserveWorkspacePathOperationAttempt(flow.input);
          if (phase === 'preview') assert.notEqual(retained.operationId, flow.ticket.operationId, 'an undispatched preview is retired locally');
          else {
            assert.equal(retained.operationId, flow.ticket.operationId, 'a dispatched uncertain action retains its original key');
            assert.equal(retained.implicit, true);
            if (phase === 'resume-post' || phase === 'batch-get') assert.deepEqual(retained.implicitBinding, flow.binding);
            else assert.equal(retained.implicitBinding, undefined, 'an unread first reply cannot invent a known request UUID');
          }
          abandonWorkspacePathOperationAttempt(retained);
        } finally {
          release.resolve(undefined); await implicitUnitBounded(running, 'drain controlled await'); await finishRetained(flow);
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    useWorkspaceStore.setState({ activeWorkspaceId: originalWorkspace });
    observeOpenedDocumentAuth(originalAuth ? { data: { user: { id: originalAuth.userId }, session: { id: originalAuth.sessionId } } } : null);
  }
  console.log('implicit rename transport: finite same-UUID resume, verified mutation, recovery stop and awaited auth/workspace guards passed');
}


async function main() {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let replies: Array<{ status?: number; body: unknown } | { status?: number; rawBody: string } | { failure: Error }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init });
    const reply = replies.shift();
    assert.ok(reply, 'unexpected extra status poll');
    if ('failure' in reply) throw reply.failure;
    return new Response('rawBody' in reply ? reply.rawBody : JSON.stringify(reply.body), {
      status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  const poll = (initial: WorkspacePathOperationResponse, timeoutMs = 1000) =>
    waitForWorkspacePathOperationResult(initial, 'workspace-client', { intervalMs: 0, timeoutMs });
  try {
    const legacy: { operation?: WorkspacePathOperationPublic; deleted: string[] } = { deleted: ['old.md'] };
    assert.equal(await waitForWorkspacePathOperationResult(legacy), legacy, 'unrelated legacy responses stay unchanged');
    const applied: WorkspacePathOperationResponse = { operation: operation('applied'), linkStatus: 'complete',
      mutation: { type: 'rename', operationId: 'actual-filesystem-mutation', workspaceId: 'workspace-client',
        oldPath: 'old.md', newPath: 'new.md' } };
    assert.deepEqual(await poll(applied), applied);
    assert.equal(requests.length, 0, 'settled success does not poll');
    const privateApplied = { ...applied, operation: { ...applied.operation,
      privatePlan: { documentText: 'private' }, errorCode: 'Private document contents https://private.test',
      selections: [{ ...applied.operation.selections[0], absolutePath: '/private/old.md' }],
    } };
    assert.deepEqual(await poll(privateApplied), applied, 'settled success validates and projects the operation before returning it');

    replies = [{ body: { operation: operation('applying') } }, { body: applied }];
    assert.deepEqual(await poll({ operation: operation('queued') }), applied);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, '/api/files/operations/batches/direct-client-batch-1234567890');
      assert.equal(request.init?.credentials, 'include');
      assert.equal(request.init?.cache, 'no-store');
      assert.equal(new Headers(request.init?.headers).get(WORKSPACE_ID_HEADER), 'workspace-client');
    }

    for (const status of ['blocked', 'needs_review', 'failed', 'needs_recovery', 'preview', 'undone'] as const) {
      const failed = { ...operation(status), errorCode: 'ACTION_SAFE_GUARD' };
      await assert.rejects(poll({ operation: failed }), (error: unknown) => {
        assert.ok(error instanceof WorkspacePathOperationClientError);
        assert.deepEqual(error.operation, failed, 'terminal failure retains durable operation identity and cause');
        assert.match(error.message, /Notification Center/u);
        return true;
      });
    }
    const failedOperation = { ...operation('failed'), errorCode: 'CURRENT_CONTENT_CHANGED',
      issues: [{ code: 'affected-html-link', path: 'Notizen.md', targetLiteral: 'Assets/image, final.png, other.png', line: 5 }] };
    replies = [{ body: { operation: { ...failedOperation, privatePlan: { documentText: 'private' },
      issues: [{ ...failedOperation.issues[0], absolutePath: '/private/Notizen.md', diagnostic: 'private detail' }] } } }];
    await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, failedOperation, 'terminal polling keeps safe issues and removes private diagnostics');
      return true;
    });

    for (const mismatch of [
      { workspaceId: 'workspace-foreign' }, { batchId: 'other-client-batch-1234567890' }, { planId: 'b'.repeat(64) },
    ]) {
      replies = [{ body: { operation: { ...operation('applied'), ...mismatch } } }];
      await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
        assert.ok(error instanceof WorkspacePathOperationClientError);
        assert.deepEqual(error.operation, operation('queued'), 'foreign successful poll payloads retain the known operation');
        assert.match(error.message, /Invalid file action status response|identity changed/u);
        return true;
      });
    }
    await assert.rejects(poll({ operation: { ...operation('queued'), workspaceId: 'workspace-foreign' } }),
      /Invalid file action status response/u);
    const invalidOperations = [null, {}, { ...operation('applied'), batchId: '../foreign' },
      { ...operation('applied'), planId: 'invalid' }, { ...operation('applied'), status: 'invented' },
      { ...operation('applied'), phase: 'preparing' }, { ...operation('applied'), completedActions: 1 },
      { ...operation('applying'), completedActions: -1 }, { ...operation('applying'), completedActions: 3 },
      { ...operation('applying'), completedActions: 0.5 }, { ...operation('applying'), totalActions: 1.5 },
      { ...operation('applying'), totalActions: Number.MAX_SAFE_INTEGER + 1 },
      { ...operation('applying'), phase: 'invented' }, { ...operation('applying'), kind: 'invented' },
      { ...operation('applying'), selections: [{ sourcePath: '../foreign.md' }] },
      { ...operation('applying'), selections: [{ sourcePath: 'old.md', destinationPath: '/private/new.md' }] },
      { ...operation('applying'), issues: [{ code: 'PRIVATE_DETAILS', path: 'Notizen.md' }] },
      ...['../private.md', '/private/data.md', 'folder\\private.md', 'https://private.test/file', 'private\u0000.md'].map((path) =>
        ({ ...operation('applying'), issues: [{ code: 'source-unreadable', path }] })),
      ...[null, 42, '', ' ', 'image\u0000.png', 'image\u200b.png', 'a'.repeat(32 * 4096 + 31 * 2 + 1)].map((targetLiteral) =>
        ({ ...operation('applying'), issues: [{ code: 'affected-html-link', path: 'HTML.md', targetLiteral }] })),
      ...[null, '5', 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((line) =>
        ({ ...operation('applying'), issues: [{ code: 'affected-html-link', path: 'HTML.md', line }] })),
    ];
    for (const invalid of invalidOperations) {
      replies = [{ body: { operation: invalid } }];
      await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
        assert.ok(error instanceof WorkspacePathOperationClientError);
        assert.deepEqual(error.operation, operation('queued'), 'malformed successful poll payloads retain the known operation');
        assert.match(error.message, /Invalid file action status response/u);
        return true;
      });
    }

    const blockedOperation = { ...operation('blocked'), errorCode: 'PREVIEW_BLOCKED',
      issues: [{ code: 'affected-html-link', path: 'HTML.md', targetLiteral: 'canvas-holdings-screenshot.png', line: 5 }] };
    replies = [{ status: 409, body: { error: 'Links could not be checked', operation: { ...blockedOperation,
      privatePlan: { content: 'private' }, issues: [{ ...blockedOperation.issues[0], rawHtml: '<private>' }] } } }];
    await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, blockedOperation, 'a rejected poll retains a validated current operation and safe cause');
      assert.equal(error.message, 'Links could not be checked');
      return true;
    });
    for (const invalid of [...invalidOperations,
      { ...blockedOperation, workspaceId: 'foreign-workspace' },
      { ...blockedOperation, batchId: 'other-client-batch-1234567890' },
      { ...blockedOperation, planId: 'b'.repeat(64) },
    ]) {
      replies = [{ status: 409, body: { error: 'Rejected status response', operation: invalid } }];
      await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
        assert.ok(error instanceof WorkspacePathOperationClientError);
        assert.deepEqual(error.operation, operation('queued'), 'rejected foreign or malformed polling payloads keep the known identity');
        assert.equal(error.message, 'Rejected status response');
        return true;
      });
    }
    const progressing = { ...operation('applying'), completedActions: 1 };
    replies = [{ body: { operation: progressing } },
      { status: 403, body: { error: 'Workspace access has changed', operation: { ...progressing, workspaceId: 'foreign-workspace' } } }];
    await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, progressing, 'rejected polling retains the most recent validated progress');
      return true;
    });

    replies = [{ status: 403, body: { error: 'Workspace access has changed' } }];
    await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.equal(error.operation.batchId, operation('queued').batchId);
      assert.equal(error.operation.status, 'queued');
      assert.equal(error.message, 'Workspace access has changed');
      return true;
    });

    replies = [{ failure: new Error('Network failure at https://private.test/?token=private-token') }];
    const beforeDisconnectedPoll: number = requests.length;
    await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, operation('queued'), 'transport failure does not discard an already queued operation');
      assert.match(error.message, /file action status|Notification Center/u);
      assert.doesNotMatch(error.message, /private|token=/u, 'raw transport diagnostics do not reach the UI');
      return true;
    });
    assert.equal(requests.length, beforeDisconnectedPoll + 1, 'polling transport failure does not retry the mutation');

    for (const malformedReply of [
      { failure: new Error('Private transport failure token=private-token') },
      ...[200, 503].flatMap((status) => [
        { status, rawBody: '{"private": <invalid-json>' },
        ...[null, [], 'private response body', 42, false].map((body) => ({ status, body })),
      ]),
      { body: { operation: { ...progressing, completedActions: 3 } } },
    ]) {
      replies = [{ body: { operation: progressing } }, malformedReply];
      const beforeMalformedPoll: number = requests.length;
      await assert.rejects(poll({ operation: operation('queued') }), (error: unknown) => {
        assert.ok(error instanceof WorkspacePathOperationClientError);
        assert.deepEqual(error.operation, progressing, 'transport and parsing failures preserve the latest validated progress');
        assert.match(error.message, /file action status|Notification Center/u);
        assert.doesNotMatch(error.message, /private|token=|invalid-json/u, 'untrusted transport and response contents stay private');
        return true;
      });
      assert.equal(requests.length, beforeMalformedPoll + 2, 'a status failure only reads the existing operation');
      for (const statusRequest of requests.slice(beforeMalformedPoll)) {
        assert.equal(statusRequest.url, '/api/files/operations/batches/direct-client-batch-1234567890');
        assert.equal(statusRequest.init?.method ?? 'GET', 'GET');
        assert.equal(statusRequest.init?.body, undefined, 'failed status reads never submit a new mutation');
      }
    }

    replies = [];
    const callsBeforeTimeout: number = requests.length;
    const durable = operation('applying');
    await assert.rejects(poll({ operation: durable }, 0), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, durable, 'timeout does not cancel or pretend to complete durable work');
      assert.match(error.message, /still running/u);
      return true;
    });
    assert.equal(requests.length, callsBeforeTimeout);

    const undone = { operation: operation('undone') };
    assert.deepEqual(await waitForWorkspacePathOperationResult(undone, 'workspace-client', { expectedOutcome: 'undone' }), undone);
    await assert.rejects(waitForWorkspacePathOperationResult(applied, 'workspace-client', { expectedOutcome: 'undone' }),
      WorkspacePathOperationClientError, 'an unchanged forward operation does not imply successful Undo');
    replies = [{ body: { operation: operation('queued') } }, { body: undone }];
    assert.deepEqual(await waitForWorkspacePathOperationResult({ operation: operation('queued') }, 'workspace-client',
      { expectedOutcome: 'undone', intervalMs: 0, timeoutMs: 1000 }), undone);

    replies = [{ body: undone }];
    await undoWorkspacePathOperation(applied.operation);
    const undoRequest = requests.at(-1)!;
    assert.equal(undoRequest.url, '/api/files/operations/batches/direct-client-batch-1234567890');
    assert.equal(undoRequest.init?.method, 'POST');
    assert.equal(undoRequest.init?.credentials, 'include');
    assert.equal(new Headers(undoRequest.init?.headers).get(WORKSPACE_ID_HEADER), 'workspace-client');
    assert.equal(new Headers(undoRequest.init?.headers).get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(undoRequest.init?.body)), { action: 'undo', planId: 'a'.repeat(64) });
    replies = [{ status: 409, body: { error: 'Current document has changed' } }];
    await assert.rejects(undoWorkspacePathOperation(applied.operation), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, applied.operation);
      assert.equal(error.message, 'Current document has changed');
      return true;
    });
    const undoBlocked = { ...operation('blocked'), errorCode: 'UNDO_CURRENT_CONTENT_CHANGED',
      issues: [{ code: 'content-changed', path: 'new.md' }] };
    replies = [{ status: 409, body: { error: 'Current document has changed', operation: { ...undoBlocked,
      privatePlan: { content: 'private' }, issues: [{ ...undoBlocked.issues[0], currentText: 'private document text' }] } } }];
    await assert.rejects(undoWorkspacePathOperation(applied.operation), (error: unknown) => {
      assert.ok(error instanceof WorkspacePathOperationClientError);
      assert.deepEqual(error.operation, undoBlocked, 'Undo rejection retains the current safe cause for the same durable operation');
      assert.equal(error.message, 'Current document has changed');
      return true;
    });
    for (const invalid of [...invalidOperations,
      { ...undoBlocked, workspaceId: 'foreign-workspace' },
      { ...undoBlocked, batchId: 'other-client-batch-1234567890' },
      { ...undoBlocked, planId: 'b'.repeat(64) },
    ]) {
      replies = [{ status: 409, body: { error: 'Rejected Undo response', operation: invalid } }];
      await assert.rejects(undoWorkspacePathOperation(applied.operation), (error: unknown) => {
        assert.ok(error instanceof WorkspacePathOperationClientError);
        assert.deepEqual(error.operation, applied.operation, 'foreign or malformed Undo rejections cannot replace the known operation');
        assert.equal(error.message, 'Rejected Undo response');
        return true;
      });
    }
    for (const body of [
      {}, { operation: { ...undone.operation, batchId: 'other-client-batch-1234567890' } },
      { operation: { ...undone.operation, planId: 'b'.repeat(64) } },
      { operation: { ...undone.operation, workspaceId: 'foreign-workspace' } },
    ]) {
      replies = [{ body }];
      await assert.rejects(undoWorkspacePathOperation(applied.operation),
        /Invalid file action status response|identity changed/u, 'Undo cannot acknowledge a missing or unrelated result');
    }
    replies = [];
    const beforeInvalidUndo: number = requests.length;
    await assert.rejects(undoWorkspacePathOperation({ ...applied.operation, batchId: '../private/batch' }),
      /Invalid file action status response/u, 'an invalid input operation never constructs an Undo request');
    assert.equal(requests.length, beforeInvalidUndo);
    implicitMovePublicParserTest();
    const boundQueued = { ...operation('queued'), implicitBinding: implicitBinding() };
    const beforeBoundPoll = requests.length;
    replies = [{ body: { operation: operation('applying') } }, { body: { operation: operation('applied'), linkStatus: 'complete' } }];
    const sticky = await poll({ operation: boundQueued });
    assert.deepEqual(sticky.operation.implicitBinding, implicitBinding(), 'generic batch GET cannot discard the verified original preparation pin');
    assert(Object.isFrozen(sticky.operation.implicitBinding));
    for (const request of requests.slice(beforeBoundPoll)) {
      assert.equal(request.init?.method ?? 'GET', 'GET'); assert.equal(request.init?.body, undefined);
      assert.equal(request.url, '/api/files/operations/batches/' + boundQueued.batchId);
    }
    for (const patch of [
      { actorUserId: 'another-user' }, { workspaceId: 'another-workspace' }, { operationId: 'another-original-request' },
      { requestId: '66666666-7777-8888-9999-aaaaaaaaaaaa' }, { selectionDigest: 'c'.repeat(64) },
    ]) {
      replies = [{ body: { operation: { ...operation('applied'), implicitBinding: { ...implicitBinding(), ...patch } } } }];
      const beforeMismatch: number = requests.length;
      await assert.rejects(poll({ operation: boundQueued }));
      assert.equal(requests.length, beforeMismatch + 1, 'a changed optional binding is rejected after one status GET');
      assert.deepEqual(boundQueued.implicitBinding, implicitBinding(), 'a forged response cannot rewrite the caller pin');
    }
    replies = [{ body: { operation: { ...operation('applied'), implicitBinding: implicitBinding() } } }];
    assert.deepEqual((await poll({ operation: boundQueued })).operation.implicitBinding, implicitBinding());
    replies = [{ body: { operation: { ...operation('applied'), legacyImplicitReplay: legacyReplay() } } }];
    await assert.rejects(poll({ operation: boundQueued }), 'a preparation mapping cannot turn into a legacy replay');

    const legacyQueued = { ...operation('queued'), legacyImplicitReplay: legacyReplay() };
    replies = [{ body: { operation: operation('applied'), linkStatus: 'complete' } }];
    const stickyLegacy = await poll({ operation: legacyQueued, historical: true });
    assert.equal(stickyLegacy.historical, true);
    assert.deepEqual(stickyLegacy.operation.legacyImplicitReplay, legacyReplay(), 'verified legacy metadata survives generic batch polling');
    assert.equal(stickyLegacy.operation.implicitBinding, undefined);
    for (const patch of [{ actorUserId: 'another-user' }, { operationId: 'another-original-request' },
      { batchId: 'other-client-batch-1234567890' }, { planId: 'c'.repeat(64) }]) {
      replies = [{ body: { operation: { ...operation('applied'), legacyImplicitReplay: { ...legacyReplay(), ...patch } } } }];
      await assert.rejects(poll({ operation: legacyQueued, historical: true }));
    }
    replies = [{ body: { operation: { ...operation('applied'), implicitBinding: implicitBinding() } } }];
    await assert.rejects(poll({ operation: legacyQueued, historical: true }));
    replies = [{ body: { operation: operation('applied'), historical: false } }];
    await assert.rejects(poll({ operation: legacyQueued, historical: true }));
    console.log('implicit generic polling: sticky exact preparation/legacy pins, foreign metadata rejected and GET-only passed');
    await implicitMoveInitialTransportTest();
    await implicitRenameResumeAndScopeRaceTest();
    console.log('workspace path client: scoped polling, settled success, durable failures, identity protection and timeout passed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
