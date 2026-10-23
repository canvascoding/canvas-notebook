import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceOperationBatchTotalActions, workspaceOperationNativeDeleteEffects,
  workspaceOperationNativeDeleteAppliedEffects } from '../app/lib/files/workspace-operation-native-delete-effects';
import { projectWorkspaceOperationNativeDeleteExecution, workspaceOperationNativeDeleteExecutionResult }
  from '../app/lib/files/workspace-operation-batch-execution-public';
import { workspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-response';
import type { WorkspaceOperationBatchScope, WorkspaceOperationLegacyBatchPlan, WorkspaceOperationNativeDeleteBatchPlan }
  from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationOriginalDeleteObservation } from '../app/lib/files/workspace-operation-original-delete-observation';
import type { OriginalDeleteNativeLinkReceipt } from '../app/lib/files/workspace-operation-original-delete-links';
import type { WorkspaceTrashEntry } from '../app/lib/filesystem/workspace-trash';

// Declared, previously checked plan/journal facts exercise presentation and the
// response boundary only. They prove no SQL finality, native write or authority.
const workspaceId = 'native-effects-workspace', targetPath = 'Target.md';
const sources = [{ documentId: 'private-doc-A', path: ' Source A.md', ids: ['link-A1', 'link-A2'] },
  { documentId: 'private-doc-B', path: 'Source B.md', ids: ['link-B1'] }];
function fixturePlan(): WorkspaceOperationNativeDeleteBatchPlan {
  return { version: 2, kind: 'native-original-delete', workspaceId, planId: 'effects-plan', readiness: 'ready',
    actions: [{ reviewId: 'direct-delete', kind: 'delete', selections: [{ sourcePath: targetPath }] }],
    nativeTarget: { documentId: 'private-target', path: targetPath },
    pathSteps: [{ reviewId: 'direct-delete', kind: 'delete', sourcePath: targetPath }],
    previewContents: [], originalDocuments: [], deletedDocuments: [], linkEdits: [], pathMappings: [], deletedPaths: [],
    issues: [], coverage: { complete: true, gaps: [] }, linkAssessment: { blockers: [] },
    sourceEvidence: { private: 'private-root' }, nativeGraphPlan: {
      steps: [{ linkIntents: sources.flatMap((source, index) => source.ids.map(id => ({
        action: 'unlink', nextValue: null, entityKey: `entity-${index}`, originEvidenceLinkId: id, virtualLinkKey: `virtual-${id}` }))) }],
      finalNamespace: sources.map((source, index) => ({ entityKey: `entity-${index}`, workspaceId, path: source.path, kind: 'file',
        binding: { kind: 'existing', documentEvidenceKey: `evidence-${index}`,
          namespaceEvidence: { workspaceId, path: source.path, kind: 'file', documentId: source.documentId, lifecycleGeneration: 1 } } })),
    },
  } as unknown as WorkspaceOperationNativeDeleteBatchPlan;
}
function receipts(): OriginalDeleteNativeLinkReceipt[] {
  return sources.map(source => ({ contractVersion: 2, operationId: `private-op-${source.documentId}`,
    source: { documentId: source.documentId, workspaceId, path: source.path },
    binding: { private: 'private-actor' }, before: { private: 'private-before' }, after: { private: 'private-after' },
    afterStateSnapshotBase64: 'private-binary', inverseRecipes: source.ids.map(originalLinkId => ({
      originalLinkId, source: { documentId: source.documentId, workspaceId, path: source.path } })),
  })) as unknown as OriginalDeleteNativeLinkReceipt[];
}
function facts(complete = true): WorkspaceOperationOriginalDeleteObservation {
  return { apply: complete ? 'complete' : 'started', undo: complete ? 'pristine' : 'unknown',
    deleted: complete ? { version: 2, trashEntryId: 'original-trash', nativeLinks: receipts() } : null,
    restored: null, original: null, restoration: null, deleteIntent: {}, deleteReceipt: null,
    deleteTrashReceipt: null, restoreIntent: null, restoreReceipt: null,
  } as unknown as WorkspaceOperationOriginalDeleteObservation;
}
const input = (plan = fixturePlan()) => ({ plan, actionMode: 'apply' as const, status: 'applying',
  completedActions: 0, phase: 'preparing' as const });
const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId, workspaceType: 'personal',
  rootPath: '/never-opened/private-root', status: 'active', legacy: false, ownerUserId: 'owner', organizationId: null,
  permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true,
    canRunAgent: true, canCreatePublicLinks: false } }, fileOptions: {} };
function batch(plan = fixturePlan()): WorkspaceOperationBatchRecord {
  return { batchId: 'native-effects-batch', planId: plan.planId, workspaceId, plan, status: 'applied', actionMode: 'apply',
    authorization: { mode: 'direct', actorUserId: 'owner', actorId: 'owner', actorDisplayName: 'Owner',
      actorType: 'user', requestHash: 'a'.repeat(64) }, reviewIds: [], reviewRefs: [], reviewerUserId: null,
    reviewerDisplayName: null, totalActions: 3, completedActions: 3, phase: 'complete', errorCode: null,
    trashEntryIds: ['original-trash'], leaseOwner: null, createdAt: 1, updatedAt: 2 };
}
const trash = { id: 'original-trash', workspaceId, originalPath: targetPath, itemType: 'file', sizeBytes: 42,
  expiresAt: new Date('2027-01-01T00:00:00Z') } as WorkspaceTrashEntry;
function dependencies(plan = fixturePlan()) {
  const observation = facts();
  const result = workspaceOperationNativeDeleteExecutionResult(plan, observation)!;
  const projected = projectWorkspaceOperationNativeDeleteExecution(input(plan), observation);
  return { execution: async () => result, publicExecution: async () => projected,
    trash: async () => [trash] };
}
const unavailable = (error: unknown): boolean => error instanceof Error
  && Reflect.get(error, 'code') === 'BATCH_JOURNAL_UNAVAILABLE' && Reflect.get(error, 'status') === 409;

test('native totals count distinct source documents and preserve exact paths', () => {
  const plan = fixturePlan(), effects = workspaceOperationNativeDeleteEffects(plan);
  assert.deepEqual(effects, sources.map(source => ({ documentId: source.documentId, path: source.path, updatedLinks: source.ids.length })));
  assert.equal(workspaceOperationBatchTotalActions(plan), 3);
  assert.equal(Object.isFrozen(effects), true); assert(effects.every(Object.isFrozen));
  assert.equal(plan.previewContents.length, 0); assert.equal(plan.linkEdits.length, 0);
  assert.equal(workspaceOperationBatchTotalActions({ version: 1, pathSteps: [{}, {}], previewContents: [{}] } as
    unknown as WorkspaceOperationLegacyBatchPlan), 3);
});
test('planned rows remain incomplete until actual checked completion receipts exist', () => {
  const plan = fixturePlan(), observed = facts(false);
  const projected = projectWorkspaceOperationNativeDeleteExecution(input(plan), observed);
  assert.equal(projected.finalization, 'pending'); assert.equal(projected.steps.length, 3);
  assert(projected.steps.every(step => step.state === 'needs_check'));
  const result = workspaceOperationNativeDeleteExecutionResult(plan, observed)!;
  assert.equal(result.status, 'needs_recovery'); assert.equal(result.totalActions, 3); assert.equal(result.completedActions, 0);
  assert(result.stepResults!.every(step => step.state === 'intent' && !Object.hasOwn(step, 'updatedLinks')));
  const absent = { ...observed, apply: 'absent' as const, undo: 'absent' as const, deleteIntent: null };
  assert(projectWorkspaceOperationNativeDeleteExecution(input(plan), absent).steps.every(step => step.state === 'pending'));
});
test('completion supplies one applied row per actual source receipt and counts actual inverse recipes', () => {
  const plan = fixturePlan(), observed = facts(), projected = projectWorkspaceOperationNativeDeleteExecution(input(plan), observed);
  assert.equal(projected.finalization, 'complete'); assert.equal(projected.receiptStatus, 'available');
  assert.deepEqual(projected.steps.map(step => [step.key, step.path, step.state, step.openPath]), [
    ['path:0', targetPath, 'applied', undefined], ['link:0', sources[0].path, 'applied', sources[0].path],
    ['link:1', sources[1].path, 'applied', sources[1].path] ]);
  const result = workspaceOperationNativeDeleteExecutionResult(plan, observed)!;
  assert.equal(result.totalActions, 3); assert.equal(result.completedActions, 3);
  assert.deepEqual(result.stepResults!.filter(step => step.phase === 'link').map(step => step.updatedLinks), [2, 1]);
  for (const forbidden of ['private-', 'nativeLinks', 'afterStateSnapshot', 'afterTree', 'binding', 'sourceEvidence']) {
    assert.equal(JSON.stringify({ projected, result }).includes(forbidden), false);
  }
});
test('receipt order does not change stable path step identities', () => {
  const plan = fixturePlan(), links = receipts().reverse();
  assert.deepEqual(workspaceOperationNativeDeleteAppliedEffects(plan, { version: 2, nativeLinks: links }),
    workspaceOperationNativeDeleteEffects(plan));
});
test('historical no-link completion works, but cannot complete a plan with incoming links', () => {
  const plan = fixturePlan(), old = { version: 1 as const };
  assert.throws(() => workspaceOperationNativeDeleteAppliedEffects(plan, old), /BATCH_JOURNAL_UNAVAILABLE/u);
  plan.nativeGraphPlan.steps[0].linkIntents = [];
  assert.deepEqual(workspaceOperationNativeDeleteAppliedEffects(plan, old), []);
  assert.equal(workspaceOperationBatchTotalActions(plan), 1);
});
test('missing, duplicate, foreign and wrong-source receipts cannot claim completion', () => {
  const plan = fixturePlan(), original = receipts();
  const invalid = [original.slice(0, 1), [...original, original[0]], [original[0], original[0]],
    original.map((receipt, index) => index ? { ...receipt, operationId: original[0].operationId } : receipt),
    original.map((receipt, index) => index ? { ...receipt, source: { ...receipt.source, workspaceId: 'foreign' } } : receipt),
    original.map((receipt, index) => index ? { ...receipt, source: { ...receipt.source, path: sources[0].path } } : receipt),
    original.map((receipt, index) => index ? { ...receipt, source: { ...receipt.source, path: 'Wrong.md' } } : receipt)];
  for (const nativeLinks of invalid) {
    const observed = { ...facts(), deleted: { ...facts().deleted!, nativeLinks } };
    assert.throws(() => workspaceOperationNativeDeleteAppliedEffects(plan, { version: 2, nativeLinks }), /BATCH_JOURNAL_UNAVAILABLE/u);
    assert.equal(projectWorkspaceOperationNativeDeleteExecution(input(plan), observed).receiptStatus, 'unavailable');
    assert.throws(() => workspaceOperationNativeDeleteExecutionResult(plan, observed), /BATCH_JOURNAL_UNAVAILABLE/u);
  }
});
test('actual inverse recipe identity and count must match each planned unlink', () => {
  const plan = fixturePlan();
  for (const change of ['missing', 'wrong-id', 'foreign-source'] as const) {
    const nativeLinks = receipts(), first = nativeLinks[0];
    first.inverseRecipes = change === 'missing' ? first.inverseRecipes.slice(1) : first.inverseRecipes.map((inverse, index) => index ? inverse
      : change === 'wrong-id' ? { ...inverse, originalLinkId: 'wrong' }
        : { ...inverse, source: { ...inverse.source, documentId: 'foreign' } });
    assert.throws(() => workspaceOperationNativeDeleteAppliedEffects(plan, { version: 2, nativeLinks }), /BATCH_JOURNAL_UNAVAILABLE/u);
  }
});
test('missing native namespace identity and duplicate logical links reject rather than invent source rows', () => {
  for (const change of ['missing-entity', 'missing-document', 'duplicate-link'] as const) {
    const plan = fixturePlan(), graph = plan.nativeGraphPlan;
    if (change === 'missing-entity') graph.finalNamespace = [];
    else if (change === 'missing-document' && graph.finalNamespace[0].binding.kind === 'existing') {
      graph.finalNamespace[0].binding.namespaceEvidence.documentId = null;
    } else graph.steps[0].linkIntents[1].originEvidenceLinkId = graph.steps[0].linkIntents[0].originEvidenceLinkId;
    assert.throws(() => workspaceOperationNativeDeleteEffects(plan), /BATCH_JOURNAL_UNAVAILABLE/u);
  }
});
test('response returns real native source files and total links without legacy preview payloads', async () => {
  const response = await workspacePathOperationResponse(batch(), scope, dependencies());
  assert.deepEqual(response.linkUpdates, { updatedFiles: sources.map(source => source.path), updatedLinks: 3, warnings: [] });
  assert.deepEqual(response.deleted, [targetPath]); assert.deepEqual(response.failed, []);
  assert.equal(response.operation.completedActions, 3); assert.equal(response.operation.totalActions, 3);
  for (const forbidden of ['private-', 'nativeLinks', 'afterStateSnapshot', 'afterTree', 'sourceEvidence', 'inverseRecipes']) {
    assert.equal(JSON.stringify(response).includes(forbidden), false);
  }
});
test('response rejects wrong counts and missing or malformed actual link acknowledgments', async () => {
  const original = dependencies(), execution = await original.execution();
  for (const change of ['missing-count', 'fraction', 'wrong-count', 'wrong-key', 'wrong-path'] as const) {
    const stepResults = execution.stepResults!.map(step => step.phase !== 'link' ? step : {
      ...step, ...(change === 'missing-count' ? { updatedLinks: undefined } : change === 'fraction' ? { updatedLinks: 1.5 }
        : change === 'wrong-count' ? { updatedLinks: 99 } : change === 'wrong-key' ? { key: 'wrong' } : { path: 'Wrong.md' }) });
    await assert.rejects(workspacePathOperationResponse(batch(), scope, { ...original,
      execution: async () => ({ ...execution, stepResults }) }), unavailable);
  }
  await assert.rejects(workspacePathOperationResponse({ ...batch(), totalActions: 1, completedActions: 1 }, scope, original), unavailable);
});
test('duplicate public rows cannot hide a missing source document acknowledgment', async () => {
  const original = dependencies(), projected = await original.publicExecution();
  await assert.rejects(workspacePathOperationResponse(batch(), scope, { ...original, publicExecution: async () => ({
    ...projected, steps: [projected.steps[0], projected.steps[1], projected.steps[1]] }) }), unavailable);
});
test('forward unlink receipts cannot manufacture restored link writes', () => {
  const plan = fixturePlan(), observed = { ...facts(), undo: 'complete' as const, restored: { trashEntryId: 'original-trash' } } as
    unknown as WorkspaceOperationOriginalDeleteObservation;
  assert.equal(projectWorkspaceOperationNativeDeleteExecution({ ...input(plan), actionMode: 'undo' }, observed).receiptStatus, 'unavailable');
  assert.throws(() => workspaceOperationNativeDeleteExecutionResult(plan, observed, true), /BATCH_JOURNAL_UNAVAILABLE/u);
});
