import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspaceFileOperationExecutor } from '../app/lib/files/workspace-file-operation-executor';
import { serializeWorkspaceOperationRequest, type WorkspaceOperationRequest,
  type WorkspaceOperationWithSteps } from '../app/lib/files/workspace-operation-journal';
import { captureWorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import type { WorkspaceFileOperationPreview } from '../app/lib/markdown/workspace-file-operation-planner';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const workspace = (workspaceId: string): WorkspaceContext => ({ workspaceId, workspaceType: 'personal',
  rootPath: `/fixture/${workspaceId}`, rootRelativePath: `users/user/${workspaceId}`, ownerUserId: 'user', legacy: false,
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
    canRunAgent: true, canManageWorkspace: true } });
const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'user', actorId: 'user', sessionId: 'original' },
  sourceWorkspace: workspace('source'), destinationWorkspace: workspace('target') });
const request: WorkspaceOperationRequest = { kind: 'copy', selections: [{ sourcePath: 'a.md', destinationPath: 'Copies/a.md' }], origin };
const preview: WorkspaceFileOperationPreview = { contractVersion: 1, planId: 'a'.repeat(64), kind: 'copy', status: 'planned',
  readiness: 'ready', issues: [], recoveryReady: true, pathMappings: [], linkEdits: [], previewContents: [],
  expectedPathState: [], collisions: [], coverage: { complete: true, omittedSources: [], unresolvedLinks: [] } };

function fixture(durableRequest = request) {
  let forbiddenCalls = 0;
  const forbidden = async (): Promise<never> => { forbiddenCalls++; throw new Error('must not mutate completed operation'); };
  const record: WorkspaceOperationWithSteps = { operationId: 'origin-copy-operation-123456789', planId: preview.planId,
    ...serializeWorkspaceOperationRequest(durableRequest), actor: { type: 'user', id: 'user' },
    sourceWorkspaceId: 'source', destinationWorkspaceId: 'target', expectedStepCount: 1,
    status: 'completed', phase: 'completed', revision: 3, errorCode: null, createdAt: 1, updatedAt: 2,
    steps: [{ operationId: 'origin-copy-operation-123456789', stepKey: 'path:original', phase: 'path', status: 'applied',
      beforeFence: 'before', afterFence: 'after', backupRef: null, receiptJson: '{}', createdAt: 1, updatedAt: 2 }] };
  const executor = createWorkspaceFileOperationExecutor({
    journal: { get: async () => record, prepare: forbidden, beginStep: forbidden, finishStep: forbidden,
      complete: forbidden, fail: forbidden, resume: forbidden },
    staging: { stage: forbidden, load: async () => { throw new Error('already retired'); }, removeCompleted: async () => {} },
    adapters: { rebuildPlan: forbidden, path: { probe: forbidden, apply: forbidden, probeSelection: forbidden, applySelection: forbidden },
      links: { preflight: forbidden, probe: forbidden, apply: forbidden } },
  });
  const input = { operationId: record.operationId, actor: record.actor, request: durableRequest, preview,
    sourceWorkspaceId: 'source', destinationWorkspaceId: 'target', originalDocuments: [] };
  return { executor, record, input, calls: () => forbiddenCalls };
}

test('completed exact original request survives retired staging without any mutation', async () => {
  const f = fixture(); assert.equal((await f.executor.execute(f.input)).status, 'complete'); assert.equal(f.calls(), 0);
});

test('every changed original actor/session/scope conflicts before completed-operation shortcut', async () => {
  for (const change of [
    { ...origin, actor: { ...origin.actor, sessionId: 'replacement' } },
    { ...origin, actor: { ...origin.actor, type: 'agent' as const, actorId: 'agent' } },
    { ...origin, sourceScope: { ...origin.sourceScope, rootPath: '/fixture/changed' } },
    { ...origin, destinationScope: { ...origin.destinationScope, ownerUserId: 'other' } },
  ]) {
    const f = fixture();
    await assert.rejects(f.executor.execute({ ...f.input, request: { ...request, origin: change } }), { code: 'OPERATION_ID_CONFLICT' });
    assert.equal(f.calls(), 0);
  }
});

test('origin presence cannot be added to or removed from an existing request', async () => {
  const { origin: _origin, ...legacy } = request;
  for (const [durable, supplied] of [[request, legacy], [legacy, request]]) {
    const f = fixture(durable);
    await assert.rejects(f.executor.execute({ ...f.input, request: supplied }), { code: 'OPERATION_ID_CONFLICT' });
    assert.equal(f.calls(), 0);
  }
});

test('stored exact request hash and canonical bytes are independently checked', async () => {
  for (const corrupt of [(f: ReturnType<typeof fixture>) => { f.record.requestHash = 'f'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.record.requestJson += ' '; }]) {
    const f = fixture(); corrupt(f);
    await assert.rejects(f.executor.execute(f.input), { code: 'OPERATION_ID_CONFLICT' }); assert.equal(f.calls(), 0);
  }
});

test('origin identity must also agree with actual journal actor and workspace IDs', async () => {
  for (const changed of [{ ...origin, actor: { ...origin.actor, userId: 'other', actorId: 'other' } },
    { ...origin, sourceScope: { ...origin.sourceScope, workspaceId: 'other' } }]) {
    const f = fixture({ ...request, origin: changed });
    await assert.rejects(f.executor.execute(f.input), { code: 'OPERATION_ID_CONFLICT' }); assert.equal(f.calls(), 0);
  }
});

test('accessor origin is rejected without invoking it', async () => {
  const f = fixture(); let invoked = 0;
  const supplied = { ...request }; Object.defineProperty(supplied, 'origin', { enumerable: true, get() { invoked++; return origin; } });
  await assert.rejects(f.executor.execute({ ...f.input, request: supplied }), { code: 'OPERATION_ID_CONFLICT' });
  assert.equal(invoked, 0); assert.equal(f.calls(), 0);
});

test('old completed requests remain readable without fabricating an origin', async () => {
  const { origin: _origin, ...legacy } = request;
  const f = fixture(legacy); assert.equal((await f.executor.execute(f.input)).status, 'complete');
  assert.equal(Object.hasOwn(JSON.parse(f.record.requestJson), 'origin'), false); assert.equal(f.calls(), 0);
});
