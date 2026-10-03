import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { createWorkspaceOperationBatchPlan, workspaceOperationBatchPublicPreview } from '../app/lib/files/workspace-operation-batch-plan';
import { projectWorkspaceOperationBatchExecution, type WorkspaceOperationBatchPublicJournal } from '../app/lib/files/workspace-operation-batch-execution-public';
import type { WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import type * as Service from '../app/lib/files/workspace-operation-batch-service';
import { groupWorkspaceLinkWrites } from '../app/lib/markdown/workspace-link-write-groups';

async function main() {
  const plan = createWorkspaceOperationBatchPlan({ snapshot: { workspaceId: 'ledger-workspace', entries: [
    { path: 'old.md', identity: 'private-inode-old', kind: 'file', markdownContent: '# Private source' },
    { path: 'trash.md', identity: 'private-inode-trash', kind: 'file', markdownContent: '# Private trash' },
    { path: 'home.md', identity: 'private-inode-home', kind: 'file', markdownContent: '[Old](old.md) [Trash](trash.md)' },
  ] }, actions: [
    { reviewId: 'move-review', kind: 'move', selections: [{ sourcePath: 'old.md', destinationPath: 'new.md' }] },
    { reviewId: 'delete-review', kind: 'delete', selections: [{ sourcePath: 'trash.md' }] },
  ] });
  assert.equal(plan.readiness, 'ready');
  const input = { plan, actionMode: 'apply' as const, status: 'needs_recovery', completedActions: 0, phase: 'recovery' as const };
  const pathSteps = plan.pathSteps.map((step, index) => ({ key: `path:${index}`, state: 'applied' as const,
    receipt: { afterTree: [{ identity: 'private-inode', sha256: 'private-hash' }],
      ...(step.kind === 'delete' ? { trashEntryId: 'private-trash' } : { mutationId: 'private-mutation' }) } }));
  const groups = groupWorkspaceLinkWrites(plan.linkPlan);
  const linkSteps = groups.map((group, index) => ({
    key: `link:${index}`, state: 'applied' as const,
    receipt: { path: group.path, workspaceId: plan.workspaceId, status: 'applied', beforeSha256: group.beforeSha256, afterSha256: group.afterSha256 },
  }));
  const journal: WorkspaceOperationBatchPublicJournal = { status: 'needs_recovery', steps: [...pathSteps, ...linkSteps], undoSteps: [], undoPlan: null };
  const allAcknowledged = projectWorkspaceOperationBatchExecution(input, journal);
  assert.equal(allAcknowledged.receiptStatus, 'available'); assert.equal(allAcknowledged.finalization, 'pending');
  assert.ok(allAcknowledged.steps.every((step) => step.state === 'applied'), 'acknowledged steps do not imply final checkpoint completion');
  const complete = projectWorkspaceOperationBatchExecution(input, { ...journal, status: 'applied' });
  assert.equal(complete.finalization, 'complete');
  const serialized = JSON.stringify(complete);
  assert.equal(serialized.includes('private-'), false);
  for (const field of ['content', 'sha256', 'identity', 'mutationId', 'trashEntryId', 'afterTree', 'backupId']) {
    assert.equal(serialized.includes(`"${field}"`), false, field);
  }
  const partial = projectWorkspaceOperationBatchExecution(input, { ...journal,
    steps: [pathSteps[0], { key: pathSteps[1].key, state: 'intent', receipt: null }] });
  assert.deepEqual(partial.steps.map((step) => step.state), ['applied', 'needs_check', 'pending']);
  assert.equal(partial.steps.find((step) => step.phase === 'link')?.openPath, 'home.md', 'pending unaffected backlink document still has a known location');
  const movingDocument = createWorkspaceOperationBatchPlan({ snapshot: { workspaceId: plan.workspaceId, entries: [
    { path: 'notes', identity: 'dir-notes', kind: 'directory' },
    { path: 'notes/home.md', identity: 'file-home', kind: 'file', markdownContent: '[Target](../target.md)' },
    { path: 'target.md', identity: 'file-target', kind: 'file', markdownContent: '# Target' },
  ] }, actions: [{ reviewId: 'move-document', kind: 'move', selections: [{ sourcePath: 'notes', destinationPath: 'nested/moved-notes' }] }] });
  const movingInput = { ...input, plan: movingDocument };
  const noPathIntent = projectWorkspaceOperationBatchExecution(movingInput, { ...journal, steps: [] });
  assert.equal(noPathIntent.steps.find((step) => step.phase === 'link')?.openPath, 'notes/home.md');
  const uncertainPath = projectWorkspaceOperationBatchExecution(movingInput, { ...journal,
    steps: [{ key: 'path:0', state: 'intent', receipt: null }] });
  assert.equal(uncertainPath.steps.find((step) => step.phase === 'link')?.openPath, undefined, 'a path intent cannot assert either physical location');
  const appliedPath = projectWorkspaceOperationBatchExecution(movingInput, { ...journal,
    steps: [{ key: 'path:0', state: 'applied', receipt: { afterTree: [{ identity: 'private-directory' }], mutationId: 'private-directory-move' } }] });
  assert.equal(appliedPath.steps.find((step) => step.phase === 'link')?.openPath, 'nested/moved-notes/home.md');
  const notStarted = projectWorkspaceOperationBatchExecution({ ...input, status: 'needs_review', phase: 'preparing' }, null);
  assert.equal(notStarted.receiptStatus, 'not_started'); assert.ok(notStarted.steps.every((step) => step.state === 'pending'));
  for (const broken of [
    null,
    { ...journal, status: 'unknown-journal-status' },
    { ...journal, steps: [] },
    { ...journal, status: 'applied', steps: [pathSteps[0]] },
    { ...journal, steps: [...journal.steps, pathSteps[0]] },
    { ...journal, steps: [{ key: 'path:999', state: 'applied' as const, receipt: pathSteps[0].receipt }] },
    { ...journal, steps: [{ ...pathSteps[0], receipt: null }] },
    { ...journal, steps: [...pathSteps, { ...linkSteps[0], receipt: null }] },
    { ...journal, steps: [...pathSteps, { ...linkSteps[0], receipt: { ...linkSteps[0].receipt, beforeSha256: 'f'.repeat(64) } }] },
    { ...journal, steps: [...pathSteps, { ...linkSteps[0], receipt: { ...linkSteps[0].receipt, afterSha256: 'f'.repeat(64) } }] },
  ]) {
    const unknown = projectWorkspaceOperationBatchExecution({ ...input, completedActions: 1 }, broken);
    assert.equal(unknown.receiptStatus, 'unavailable'); assert.equal(unknown.finalization, 'pending');
    assert.ok(unknown.steps.every((step) => step.state === 'needs_check'));
  }
  assert.equal(projectWorkspaceOperationBatchExecution(input, journal, true).receiptStatus, 'unavailable');
  const alreadyApplied = projectWorkspaceOperationBatchExecution(input, { ...journal, status: 'applied',
    steps: [...pathSteps, ...linkSteps.map((step) => ({ ...step, receipt: { ...step.receipt, status: 'already-applied' } }))] });
  assert.equal(alreadyApplied.receiptStatus, 'available'); assert.equal(alreadyApplied.finalization, 'complete');
  assert.ok(alreadyApplied.steps.filter((step) => step.phase === 'link').every((step) => step.openPath === step.path));
  const refusedUndo = projectWorkspaceOperationBatchExecution({ ...input, actionMode: 'undo', status: 'applied' }, { ...journal, status: 'applied' });
  assert.equal(refusedUndo.mode, 'apply'); assert.equal(refusedUndo.finalization, 'complete');
  const inverseContents = groups.map((group) => ({ workspaceId: group.workspaceId, path: group.path,
    content: plan.originalDocuments.find((document) => document.path === group.sourcePathBefore)!.content }));
  const undoPlan = { ...plan.linkPlan, previewContents: inverseContents, linkEdits: groups.map((group, index) => ({
    ...group.edits[0], sourcePathBefore: group.path, expectedContentHash: group.afterSha256,
    previousTargetLiteral: group.afterContent, nextTargetLiteral: inverseContents[index].content,
    targetRange: { startUtf16: 0, endUtf16: group.afterContent.length, startUtf8Byte: 0, endUtf8Byte: Buffer.byteLength(group.afterContent) },
  })) };
  const inverseLinks = groupWorkspaceLinkWrites(undoPlan).map((group, index) => ({ key: `link:${index}`, state: 'applied' as const,
    receipt: { path: group.path, workspaceId: group.workspaceId, status: 'already-applied', beforeSha256: group.beforeSha256, afterSha256: group.afterSha256 } }));
  const inverse = projectWorkspaceOperationBatchExecution({ ...input, actionMode: 'undo', status: 'undone' },
    { ...journal, status: 'undone', undoPlan, undoSteps: [...pathSteps, ...inverseLinks] });
  assert.equal(inverse.mode, 'undo'); assert.equal(inverse.finalization, 'complete');
  assert.ok(inverse.steps.some((step) => step.kind === 'restore' && step.path === 'trash.md'));
  assert.ok(inverse.steps.some((step) => step.kind === 'move' && step.path === 'new.md' && step.destinationPath === 'old.md'));

  const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: plan.workspaceId, rootPath: '/no-live-file-probes',
    workspaceType: 'personal', organizationId: null, ownerUserId: 'reader', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: false, canDelete: false, canRunAgent: false, canManageWorkspace: false, canCreatePublicLinks: false } }, fileOptions: {} };
  const batch: WorkspaceOperationBatchRecord = { batchId: 'public-ledger-batch-1234567890', planId: plan.planId, workspaceId: plan.workspaceId,
    authorization: { mode: 'review' },
    reviewIds: plan.actions.map((action) => action.reviewId), reviewRefs: [], plan, status: 'applied', actionMode: 'apply',
    reviewerUserId: 'reviewer', reviewerDisplayName: 'Reviewer', completedActions: 3, totalActions: 3, phase: 'complete',
    errorCode: null, trashEntryIds: [], leaseOwner: null, createdAt: 1, updatedAt: 2 };
  let journalReads = 0;
  const service = { exports: {} as typeof Service };
  const source = ts.transpileModule(await fs.readFile(path.resolve('app/lib/files/workspace-operation-batch-service.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'server-only') return {};
    if (name === 'node:crypto') return {};
    if (name.endsWith('/db') || name.endsWith('/workspace-mutation-lock') || name.endsWith('/workspace-operation-review-service')
      || name.endsWith('/workspace-operation-batch-approval-fence')) return {};
    if (name.endsWith('/workspace-operation-batch-plan')) return { workspaceOperationBatchPublicPreview };
    if (name.endsWith('/workspace-operation-batch-store')) return { WorkspaceOperationBatchStore: class { async get() { return batch; } } };
    if (name.endsWith('/workspace-operation-batch-executor')) return {
      getWorkspaceOperationBatchExecutionPublic: async () => { journalReads += 1; return complete; },
      assertWorkspaceOperationBatchUndoAvailable: async () => { throw new Error('Unexpected live Undo probe for read-only caller'); },
    };
    throw new Error(`Unexpected service dependency: ${name}`);
  }, service, service.exports);
  assert.equal('execution' in (await service.exports.getWorkspaceOperationBatchReview(batch.batchId))!, false);
  assert.equal(journalReads, 0, 'unscoped authorization lookup never reads or exposes private journal');
  assert.equal(await service.exports.getWorkspaceOperationBatchReview(batch.batchId, { ...scope, workspace: { ...scope.workspace, workspaceId: 'other' } }), null);
  assert.equal(await service.exports.getWorkspaceOperationBatchReview(batch.batchId, { ...scope, workspace: { ...scope.workspace, status: 'archived' } }), null);
  assert.equal(await service.exports.getWorkspaceOperationBatchReview(batch.batchId, { ...scope,
    workspace: { ...scope.workspace, permissions: { ...scope.workspace.permissions, canRead: false } } }), null);
  assert.equal(journalReads, 0);
  for (const status of ['queued', 'applying', 'preview', 'blocked'] as const) {
    batch.status = status;
    assert.equal('execution' in (await service.exports.getWorkspaceOperationBatchReview(batch.batchId, scope))!, false);
  }
  assert.equal(journalReads, 0, 'active status polls never load full private journal');
  for (const status of ['applied', 'undone', 'needs_review', 'needs_recovery', 'failed'] as const) {
    batch.status = status;
    assert.deepEqual((await service.exports.getWorkspaceOperationBatchReview(batch.batchId, scope))!.execution, complete);
  }
  assert.equal(journalReads, 5);
  console.log('batch public execution: exact forward/inverse receipts, incomplete finalization, malformed journal fail-closed, scoped settled-only reads and no private evidence leaks passed');
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
