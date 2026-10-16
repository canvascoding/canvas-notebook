import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectWorkspaceOperationNativeDeleteExecution, workspaceOperationNativeDeleteExecutionResult,
  workspaceOperationNativeDeleteMutationEvidence } from '../app/lib/files/workspace-operation-batch-execution-public';
import { createWorkspaceOperationBatchExecutor } from '../app/lib/files/workspace-operation-batch-executor';
import type { WorkspaceOperationBatchScope, WorkspaceOperationNativeDeleteBatchPlan } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceOperationBatchClaim } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationOriginalDeleteObservation } from '../app/lib/files/workspace-operation-original-delete-observation';

// Declared checked journal facts exercise ONLY their pure presentation. They do
// not stand in for SQL parsing, a genuine claim, current ACL or the Owner runner.
const plan = { version: 2, kind: 'native-original-delete', workspaceId: 'projection-workspace', readiness: 'ready',
  nativeTarget: { path: ' note .md', documentId: 'private-original-D1' },
  pathSteps: [{ kind: 'delete', sourcePath: ' note .md', reviewId: 'direct-delete' }],
  previewContents: [], linkEdits: [], pathMappings: [], sourceEvidence: { private: 'private-root-and-binary' },
} as unknown as WorkspaceOperationNativeDeleteBatchPlan;
const input = { plan, actionMode: 'apply' as const, status: 'applying', completedActions: 0, phase: 'preparing' as const };
function facts(apply: WorkspaceOperationOriginalDeleteObservation['apply'], undo: WorkspaceOperationOriginalDeleteObservation['undo']):
WorkspaceOperationOriginalDeleteObservation {
  return { apply, undo, deleted: apply === 'complete' ? { trashEntryId: 'original-trash', private: 'private-delete' } : null,
    restored: undo === 'complete' ? { trashEntryId: 'original-trash', private: 'private-restore' } : null,
    deleteIntent: apply === 'absent' ? null : { private: 'private-intent' }, original: null,
    deleteReceipt: null, deleteTrashReceipt: null, restoreIntent: null, restoreReceipt: null, restoration: null,
  } as unknown as WorkspaceOperationOriginalDeleteObservation;
}
test('native absent evidence is not a completed result or invented filesystem manifest', () => {
  const observed = facts('absent', 'absent'), projected = projectWorkspaceOperationNativeDeleteExecution(input, observed);
  assert.equal(projected.receiptStatus, 'not_started'); assert.equal(projected.finalization, 'pending');
  assert.equal(projected.steps[0].state, 'pending'); assert.equal(workspaceOperationNativeDeleteExecutionResult(plan, observed), null);
  assert.equal(workspaceOperationNativeDeleteMutationEvidence(observed), 'absent');
});
test('forward intent means started and cannot manufacture an Undo beginning', () => {
  const observed = facts('started', 'unknown'), projected = projectWorkspaceOperationNativeDeleteExecution(input, observed);
  assert.equal(projected.receiptStatus, 'available'); assert.equal(projected.steps[0].state, 'needs_check');
  assert.equal(workspaceOperationNativeDeleteMutationEvidence(observed), 'started');
  assert.throws(() => workspaceOperationNativeDeleteMutationEvidence(observed, true), /BATCH_JOURNAL_UNAVAILABLE/u);
  assert.equal(projectWorkspaceOperationNativeDeleteExecution({ ...input, actionMode: 'undo' }, observed).receiptStatus, 'unavailable');
});
test('coherent original completion supplies exactly one acknowledged SQL path record', () => {
  const observed = facts('complete', 'pristine'), projected = projectWorkspaceOperationNativeDeleteExecution(input, observed);
  assert.deepEqual(projected, { mode: 'apply', receiptStatus: 'available', finalization: 'complete', steps: [
    { key: 'path:0', phase: 'path', kind: 'delete', path: ' note .md', reviewId: 'direct-delete', state: 'applied' }] });
  const result = workspaceOperationNativeDeleteExecutionResult(plan, observed)!;
  assert.equal(result.status, 'applied'); assert.equal(result.completedActions, 1); assert.equal(result.totalActions, 1);
  assert.deepEqual(result.trashEntryIds, ['original-trash']); assert.equal(result.stepResults!.length, 1);
  assert.equal(Object.hasOwn(result.stepResults![0], 'afterTree'), false);
});
test('forward history alone is pristine Undo, never a restored completion', () => {
  const observed = facts('complete', 'pristine'), projected = projectWorkspaceOperationNativeDeleteExecution({ ...input, actionMode: 'undo' }, observed);
  assert.equal(projected.receiptStatus, 'not_started'); assert.equal(projected.steps[0].kind, 'restore');
  assert.equal(workspaceOperationNativeDeleteMutationEvidence(observed, true), 'pristine');
  assert.equal(workspaceOperationNativeDeleteExecutionResult(plan, observed, true), null);
});
test('restore intent stays incomplete with original Trash identity', () => {
  const observed = facts('complete', 'started'), projected = projectWorkspaceOperationNativeDeleteExecution({ ...input, actionMode: 'undo' }, observed);
  assert.equal(projected.receiptStatus, 'available'); assert.equal(projected.finalization, 'pending');
  const result = workspaceOperationNativeDeleteExecutionResult(plan, observed, true)!;
  assert.equal(result.status, 'needs_recovery'); assert.deepEqual(result.trashEntryIds, ['original-trash']);
  assert.equal(workspaceOperationNativeDeleteMutationEvidence(observed, true), 'started');
});
test('restore completion is derived from original history without a current D2 pathname probe', () => {
  const observed = facts('complete', 'complete'), projected = projectWorkspaceOperationNativeDeleteExecution({ ...input, actionMode: 'undo' }, observed);
  assert.equal(projected.finalization, 'complete'); assert.equal(projected.steps[0].state, 'applied');
  assert.equal(projected.steps[0].path, ' note .md');
  assert.equal(workspaceOperationNativeDeleteExecutionResult(plan, observed, true)!.status, 'applied');
});
test('claimed header completion without matching original completion stays unavailable', () => {
  for (const changed of [{ completedActions: 1 }, { phase: 'complete' as const }, { status: 'applied' }]) {
    const projected = projectWorkspaceOperationNativeDeleteExecution({ ...input, ...changed }, facts('absent', 'absent'));
    assert.equal(projected.receiptStatus, 'unavailable'); assert.equal(projected.finalization, 'pending');
  }
  assert.equal(projectWorkspaceOperationNativeDeleteExecution({ ...input, actionMode: 'undo', status: 'undone' },
    facts('complete', 'pristine')).receiptStatus, 'unavailable');
});
test('unreadable evidence is unavailable even when a caller claims success', () => {
  assert.equal(projectWorkspaceOperationNativeDeleteExecution({ ...input, status: 'applied', phase: 'complete' }, null).receiptStatus, 'unavailable');
  const corrupt = facts('complete', 'complete');
  assert.throws(() => workspaceOperationNativeDeleteExecutionResult(plan, { ...corrupt, restored: null }, true));
});
test('public whitelist does not leak raw journal, native identity, scope or private source evidence', () => {
  for (const mode of ['apply', 'undo'] as const) {
    const projected = projectWorkspaceOperationNativeDeleteExecution({ ...input, actionMode: mode }, facts('complete', 'complete'));
    const text = JSON.stringify(projected);
    for (const name of ['private-', 'sourceEvidence', 'nativeTarget', 'afterTree', 'receiptDigest', 'rootPath', 'authorization']) assert(!text.includes(name));
  }
});
test('native dispatch rejects absent or forged claims before legacy lifecycle and fake store adapters', async () => {
  const workspace: WorkspaceOperationBatchScope['workspace'] = { workspaceId: plan.workspaceId, workspaceType: 'personal',
    rootPath: '/never-accessed', legacy: false, status: 'active', actor: { userId: 'user', role: 'member' },
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canCreatePublicLinks: false, canManageWorkspace: false } };
  let discriminations = 0;
  const executor = createWorkspaceOperationBatchExecutor({ readBatch: async () => { discriminations++; return null; } });
  const actualInput = { batchId: 'native_dispatch_without_grant', plan, actorUserId: 'user', actorDisplayName: 'User',
    scope: { workspace, fileOptions: { workspace } } };
  await assert.rejects(executor.execute(actualInput), /BATCH_CLAIM_REQUIRED/u);
  await assert.rejects(executor.execute({ ...actualInput, jobClaim: {} as WorkspaceOperationBatchClaim }), /claim is unavailable/u);
  assert.equal(discriminations, 0, 'A read discriminator cannot grant native execution.');
});
