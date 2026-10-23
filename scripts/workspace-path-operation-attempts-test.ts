import assert from 'node:assert/strict';
import { observeOpenedDocumentAuth, openedDocumentAuthScope } from '../app/lib/collaboration/opened-document-registry';
import { reserveWorkspacePathOperationAttempt as reserve, dispatchWorkspacePathOperationAttempt as dispatch,
  abandonWorkspacePathOperationAttempt as abandon, settleWorkspacePathOperationAttempt as settle,
  bindWorkspacePathOperationAttempt as bind, observeWorkspacePathOperationAttemptCompletion as observe,
  bindWorkspacePathOperationAttemptPreview as bindPreview,
  type WorkspacePathOperationAttempt } from '../app/lib/files/workspace-path-operation-attempts';
import { readWorkspacePathOperation } from '../app/lib/files/workspace-path-operation-parser';
import type { WorkspacePathOperationPublic } from '../app/lib/files/workspace-path-operation-public';
import { renameWorkspacePath, deleteWorkspacePaths } from '../app/lib/files/client';
import { WorkspacePathOperationOutcomeUnknownError } from '../app/lib/files/workspace-path-operation-client';

function attemptTestInput(name: string, workspaceId = 'attempt-ws') {
  return { workspaceId, kind: 'rename' as const, selections: [{ sourcePath: `${name}.md`, destinationPath: `${name}-moved.md` }], planId: 'a'.repeat(64) };
}
function attemptTestOperation(input: ReturnType<typeof attemptTestInput>, batchId = `attempt-${crypto.randomUUID()}`): WorkspacePathOperationPublic {
  return { workspaceId: input.workspaceId, batchId, planId: 'b'.repeat(64), kind: 'rename', selections: input.selections,
    preparation: { previewPlanId: input.planId }, status: 'queued', phase: 'preparing', completedActions: 0, totalActions: 2, errorCode: null };
}
function completeAttemptTest(ticket: WorkspacePathOperationAttempt, input: ReturnType<typeof attemptTestInput>) {
  const operation = attemptTestOperation(input); bind(ticket, operation);
  observe(readWorkspacePathOperation({ ...operation, status: 'applied', phase: 'complete', completedActions: 2 },
    { batchId: operation.batchId, workspaceId: operation.workspaceId, planId: operation.planId }));
}

/** Mechanical client-state tests only. Auth observations/HTTP-shaped data here
 * are unit fixtures; they are not evidence of genuine authentication or B0. */
export async function workspacePathOperationAttemptsTest(): Promise<void> {
  const original = openedDocumentAuthScope(); let groups = 0;
  observeOpenedDocumentAuth({ data: { user: { id: 'attempt-user' }, session: { id: 'SID-A' } } });
  try {
    {
      const input = attemptTestInput('store-reserves-before-real-preview'), a = reserve({ ...input, planId: undefined });
      const b = reserve({ ...input, planId: undefined });
      const boundByReserve = reserve(input); assert.equal(boundByReserve.operationId, a.operationId); abandon(boundByReserve);
      bindPreview(a, input.planId); assert.equal(a.planId, input.planId); assert.equal(b.planId, input.planId);
      dispatch(a); settle(a, 'unknown'); abandon(b);
      const c = reserve({ ...input, planId: undefined }); assert.equal(c.operationId, a.operationId); assert.equal(c.planId, input.planId);
      assert.throws(() => bindPreview(c, 'f'.repeat(64)), /preview changed/u); abandon(c); completeAttemptTest(a, input); groups++;
    }
    {
      const input = attemptTestInput('A-dispatch-B-local-abort'), a = reserve(input); dispatch(a);
      const b = reserve(input); abandon(b); const c = reserve(input);
      assert.equal(c.operationId, a.operationId); assert.equal(c.planId, a.planId);
      abandon(c); completeAttemptTest(a, input); groups++;
    }
    {
      const input = attemptTestInput('A-unknown-B-known-rejection'), a = reserve(input); dispatch(a); settle(a, 'unknown');
      const b = reserve(input); dispatch(b); settle(b, 'rejected'); const c = reserve(input);
      assert.equal(c.operationId, a.operationId); abandon(c); completeAttemptTest(a, input); groups++;
    }
    {
      const input = attemptTestInput('A-outstanding-B-known-rejection'), a = reserve(input); dispatch(a);
      const b = reserve(input); dispatch(b); settle(b, 'rejected'); const c = reserve(input);
      assert.equal(c.operationId, a.operationId); abandon(c); completeAttemptTest(a, input); groups++;
    }
    {
      const input = attemptTestInput('late-A-after-B-original-completion'), a = reserve(input), b = reserve(input);
      dispatch(a); dispatch(b); completeAttemptTest(b, input);
      const c = reserve(input); assert.notEqual(c.operationId, a.operationId);
      settle(a, 'unknown'); abandon(a); settle(b, 'rejected');
      const d = reserve(input); assert.equal(d.operationId, c.operationId);
      abandon(c); abandon(d); groups++;
    }
    {
      const input = attemptTestInput('resolved-entry-retired-local-ticket'), a = reserve(input), b = reserve(input);
      dispatch(a); completeAttemptTest(a, input);
      assert.throws(() => dispatch(b), /changed/u, 'a pre-completion local ticket cannot dispatch after global completion');
      abandon(b); const c = reserve(input); assert.notEqual(c.operationId, a.operationId); abandon(c); groups++;
    }
    {
      const input = attemptTestInput('only-local-reservations'), a = reserve(input), b = reserve(input);
      abandon(a); const c = reserve(input); assert.equal(c.operationId, b.operationId);
      abandon(b); abandon(c); const d = reserve(input); assert.notEqual(d.operationId, a.operationId); abandon(d); groups++;
    }
    {
      const input = attemptTestInput('sole-known-prewrite-rejection'), a = reserve(input); dispatch(a); settle(a, 'rejected');
      const b = reserve({ ...input, planId: 'c'.repeat(64) }); assert.notEqual(b.operationId, a.operationId);
      assert.equal(b.planId, 'c'.repeat(64)); abandon(b); groups++;
    }
    {
      const input = attemptTestInput('session-rotation-and-partitions'), a = reserve(input), localA = reserve(input);
      dispatch(a); settle(a, 'unknown');
      observeOpenedDocumentAuth({ data: null });
      observeOpenedDocumentAuth({ data: { user: { id: 'attempt-user' }, session: { id: 'SID-B' } } });
      assert.throws(() => dispatch(localA), /session changed/u); abandon(localA);
      const b = reserve(input); assert.equal(b.operationId, a.operationId); assert.equal(b.planId, a.planId); abandon(b);
      const otherWorkspace = reserve({ ...input, workspaceId: 'foreign-ws' }); assert.notEqual(otherWorkspace.operationId, a.operationId); abandon(otherWorkspace);
      observeOpenedDocumentAuth({ data: { user: { id: 'foreign-user' }, session: { id: 'foreign-SID' } } });
      const foreign = reserve(input); assert.notEqual(foreign.operationId, a.operationId); abandon(foreign);
      observeOpenedDocumentAuth({ data: { user: { id: 'attempt-user' }, session: { id: 'SID-B' } } });
      completeAttemptTest(a, input); groups++;
    }
    {
      const input = attemptTestInput('unknown-retains-original-plan'), a = reserve(input); dispatch(a); settle(a, 'unknown');
      assert.throws(() => reserve({ ...input, planId: 'c'.repeat(64) }), /unresolved/u);
      const b = reserve(input); assert.equal(b.operationId, a.operationId); abandon(b); completeAttemptTest(a, input); groups++;
    }
    {
      const input = attemptTestInput('202-unknown-then-notification-completion'), a = reserve(input); dispatch(a);
      const queued = readWorkspacePathOperation(attemptTestOperation(input),
        { workspaceId: input.workspaceId, planId: input.planId, allowPreparation: true });
      bind(a, queued); settle(a, 'unknown'); observe(queued);
      const b = reserve(input); assert.equal(b.operationId, a.operationId); abandon(b);
      const completed: WorkspacePathOperationPublic = { ...queued, status: 'applied', phase: 'complete', completedActions: 2 };
      for (const wrong of [{ ...completed, batchId: `foreign-${crypto.randomUUID()}` },
        { ...completed, planId: 'd'.repeat(64) }, { ...completed, workspaceId: 'foreign-ws' },
        { ...completed, selections: [{ sourcePath: 'foreign.md', destinationPath: 'elsewhere.md' }] }]) observe(wrong);
      const c = reserve(input); assert.equal(c.operationId, a.operationId); abandon(c);
      observeOpenedDocumentAuth({ data: { user: { id: 'foreign-user' }, session: { id: 'foreign-SID' } } }); observe(completed);
      observeOpenedDocumentAuth({ data: { user: { id: 'attempt-user' }, session: { id: 'SID-C' } } });
      const d = reserve(input); assert.equal(d.operationId, a.operationId); abandon(d);
      assert.throws(() => readWorkspacePathOperation({ ...completed, planId: 'e'.repeat(64), preparation: { previewPlanId: queued.planId } },
        { workspaceId: queued.workspaceId, batchId: queued.batchId, planId: queued.planId }), /Invalid/u,
      'polling remains pinned to the real native plan despite a fabricated preview mapping');
      observe(readWorkspacePathOperation(completed, { batchId: queued.batchId, workspaceId: queued.workspaceId, planId: queued.planId }));
      const e = reserve(input); assert.notEqual(e.operationId, a.operationId); abandon(e); groups++;
    }
    {
      const input = attemptTestInput('actual-client-autopreview-then-unknown-retry'), originalFetch = globalThis.fetch;
      const requests: Array<{ idempotencyKey?: string; planId?: string; dryRun?: boolean }> = [];
      let previews = 0, mutations = 0;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { idempotencyKey?: string; planId?: string; dryRun?: boolean };
        if (body.dryRun) {
          previews++; return Response.json({ dryRun: true, requiresRevalidation: true, plan: { planId: input.planId, readiness: 'ready' } });
        }
        requests.push(body); mutations++;
        if (mutations === 1) throw new Error('Fixture transport outcome unknown');
        return Response.json({ operation: { ...attemptTestOperation(input), status: 'applied', phase: 'complete', completedActions: 2 } });
      };
      try {
        const storeTicket = reserve({ ...input, planId: undefined });
        await assert.rejects(renameWorkspacePath(input.selections[0].sourcePath, input.selections[0].destinationPath, false,
          input.workspaceId, undefined, storeTicket), /outcome unknown/u);
        const completed = await renameWorkspacePath(input.selections[0].sourcePath, input.selections[0].destinationPath, false, input.workspaceId);
        assert.equal(completed.operation?.status, 'applied'); assert.equal(previews, 1, 'unknown retry does not reread/preview the source');
        assert.equal(mutations, 2); assert.equal(requests[1].idempotencyKey, requests[0].idempotencyKey);
        assert.equal(requests[1].planId, input.planId); assert.equal(requests[0].planId, input.planId);
        const next = reserve(input); assert.notEqual(next.operationId, requests[0].idempotencyKey); abandon(next);
      } finally { globalThis.fetch = originalFetch; }
      groups++;
    }
    for (const kind of ['rename', 'delete'] as const) {
      const input = attemptTestInput(`${kind}-missing-proof-then-historical`), originalFetch = globalThis.fetch;
      const sent: Array<{ idempotencyKey?: string }> = []; let count = 0;
      globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as { idempotencyKey?: string }); count++;
        if (count === 1) return Response.json({ success: true, deleted: [input.selections[0].sourcePath],
          mutation: { type: 'rename', workspaceId: input.workspaceId, oldPath: input.selections[0].sourcePath,
            newPath: input.selections[0].destinationPath, operationId: 'unconfirmed-effect' } });
        return Response.json({ historical: true, operation: { ...attemptTestOperation(input), kind,
          selections: kind === 'rename' ? input.selections : input.selections.map(({ sourcePath }) => ({ sourcePath })),
          status: 'applied', phase: 'complete', completedActions: 2 } });
      };
      try {
        await assert.rejects(kind === 'rename'
          ? renameWorkspacePath(input.selections[0].sourcePath, input.selections[0].destinationPath, false, input.workspaceId, input.planId)
          : deleteWorkspacePaths([input.selections[0].sourcePath], input.workspaceId, input.planId), error => {
            assert(error instanceof WorkspacePathOperationOutcomeUnknownError);
            assert.equal(error.operationId, sent[0].idempotencyKey); assert.equal(error.planId, input.planId); return true;
          });
        const result = kind === 'rename'
          ? await renameWorkspacePath(input.selections[0].sourcePath, input.selections[0].destinationPath, false, input.workspaceId, input.planId)
          : await deleteWorkspacePaths([input.selections[0].sourcePath], input.workspaceId, input.planId);
        assert.equal(result.historical, true, 'the verified historical fact reaches the store instead of another optimistic mutation');
        assert.equal(result.operation?.status, 'applied'); assert.equal(sent[1].idempotencyKey, sent[0].idempotencyKey);
      } finally { globalThis.fetch = originalFetch; }
      groups++;
    }
    for (const kind of ['rename', 'delete'] as const) {
      const input = attemptTestInput(`${kind}-ordinary-native-historical`), originalFetch = globalThis.fetch;
      const selections = kind === 'rename' ? input.selections : input.selections.map(({ sourcePath }) => ({ sourcePath }));
      const ticket = reserve({ ...input, kind, selections }); dispatch(ticket);
      const queued: WorkspacePathOperationPublic = { ...attemptTestOperation(input), kind, selections, planId: input.planId };
      delete queued.preparation;
      bind(ticket, queued); settle(ticket, 'unknown');
      const completed: WorkspacePathOperationPublic = { ...queued, status: 'applied', phase: 'complete', completedActions: 2 };
      const wrong = [{ ...completed, batchId: `foreign-${crypto.randomUUID()}` },
        { ...completed, planId: 'c'.repeat(64) }, { ...completed, workspaceId: 'foreign-ws' },
        { ...completed, kind: kind === 'rename' ? 'delete' : 'rename' },
        { ...completed, selections: kind === 'rename'
          ? [{ sourcePath: 'foreign.md', destinationPath: 'foreign-moved.md' }] : [{ sourcePath: 'foreign.md' }] }];
      const sent: Array<{ idempotencyKey?: string; planId?: string }> = []; let count = 0;
      globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as { idempotencyKey?: string; planId?: string });
        const operation = count < wrong.length ? wrong[count] : completed; count++;
        return Response.json({ historical: true, operation });
      };
      try {
        for (let index = 0; index < wrong.length; index++) {
          await assert.rejects(kind === 'rename'
            ? renameWorkspacePath(input.selections[0].sourcePath, input.selections[0].destinationPath, false, input.workspaceId, input.planId)
            : deleteWorkspacePaths([input.selections[0].sourcePath], input.workspaceId, input.planId));
        }
        const result = kind === 'rename'
          ? await renameWorkspacePath(input.selections[0].sourcePath, input.selections[0].destinationPath, false, input.workspaceId, input.planId)
          : await deleteWorkspacePaths([input.selections[0].sourcePath], input.workspaceId, input.planId);
        assert.equal(result.historical, true); assert.equal(result.operation?.preparation, undefined);
        assert.equal(result.operation?.status, 'applied'); assert.equal(result.operation?.batchId, queued.batchId);
        assert.equal(sent.length, wrong.length + 1);
        for (const request of sent) {
          assert.equal(request.idempotencyKey, ticket.operationId); assert.equal(request.planId, input.planId);
        }
      } finally { globalThis.fetch = originalFetch; }
      groups++;
    }
    assert.equal(groups, 16); console.log(JSON.stringify({ suite: 'workspace-path-operation-attempts', groups, passed: true, scope: 'mechanical unit fixtures only' }));
  } finally {
    observeOpenedDocumentAuth(original ? { data: { user: { id: original.userId }, session: { id: original.sessionId } } } : { data: null });
  }
}
