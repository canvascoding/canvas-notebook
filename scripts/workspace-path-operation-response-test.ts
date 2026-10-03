import assert from 'node:assert/strict';
import { createWorkspaceOperationBatchPlan } from '../app/lib/files/workspace-operation-batch-plan';
import { workspacePathOperationMetadata, workspacePathOperationResponse as readResponse } from '../app/lib/files/workspace-path-operation-response';
import { WorkspaceOperationBatchError, type WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationBatchExecutionResult, WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceTrashEntry } from '../app/lib/filesystem/workspace-trash';
import type { WorkspaceOperationBatchExecutionPublic } from '../app/lib/files/workspace-operation-batch-public';

const scope: WorkspaceOperationBatchScope = {
  workspace: { workspaceId: 'response-workspace', rootPath: '/private/response-test', workspaceType: 'personal',
    ownerUserId: 'owner', organizationId: null, legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
      canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {},
};

function forwardProjection(batch: WorkspaceOperationBatchRecord): WorkspaceOperationBatchExecutionPublic {
  return { mode: 'apply', receiptStatus: 'available', finalization: 'complete', steps: [
    ...batch.plan.pathSteps.map((step, index) => ({ key: `path:${index}`, phase: 'path' as const,
      kind: step.kind, path: step.sourcePath, destinationPath: step.destinationPath, state: 'applied' as const })),
    ...batch.plan.previewContents.map((document, index) => ({ key: `link:${index}`, phase: 'link' as const,
      kind: 'link_update' as const, path: document.path, state: 'applied' as const })),
  ] };
}

function workspacePathOperationResponse(batch: WorkspaceOperationBatchRecord, currentScope: WorkspaceOperationBatchScope,
  dependencies: Parameters<typeof readResponse>[2] = {}) {
  return readResponse(batch, currentScope, {
    publicExecution: async () => forwardProjection(batch), ...dependencies,
  });
}

function fixture(kind: 'move' | 'delete' | 'overwrite') {
  const actions: WorkspaceOperationBatchPlan['actions'] = kind === 'delete'
    ? [{ reviewId: 'direct-delete', kind: 'delete', selections: [{ sourcePath: 'old.md' }, { sourcePath: 'image.png' }] }]
    : [
      ...(kind === 'overwrite' ? [{ reviewId: 'direct-overwrite', kind: 'delete' as const,
        selections: [{ sourcePath: 'new.md' }] }] : []),
      { reviewId: 'direct-move', kind: 'move' as const, selections: [{ sourcePath: 'old.md', destinationPath: 'new.md' }] },
    ];
  const plan = createWorkspaceOperationBatchPlan({ snapshot: { workspaceId: scope.workspace.workspaceId, entries: [
    { path: 'old.md', kind: 'file', identity: 'private-old-identity', markdownContent: '# Private original source' },
    { path: 'image.png', kind: 'file', identity: 'private-image-identity' },
    ...(kind === 'overwrite' ? [{ path: 'new.md', kind: 'file' as const, identity: 'private-destination-identity',
      markdownContent: '# Private overwritten source' }] : []),
    { path: 'home.md', kind: 'file', identity: 'private-home-identity',
      markdownContent: '[Old](old.md) ![Image](image.png)' },
  ] }, actions });
  assert.equal(plan.readiness, 'ready');
  assert.ok(plan.previewContents.length, 'fixture actually repairs an existing Markdown document');
  const totalActions = plan.pathSteps.length + plan.previewContents.length;
  const batch: WorkspaceOperationBatchRecord = {
    batchId: 'direct-response-batch-1234567890', planId: plan.planId, workspaceId: plan.workspaceId,
    reviewIds: [], reviewRefs: [], plan, status: 'applied', actionMode: 'apply',
    authorization: { mode: 'direct', actorType: 'agent', actorUserId: 'owner', actorId: 'private-agent',
      actorDisplayName: 'Agent', actorSessionId: 'private-agent-session', requestHash: 'c'.repeat(64) },
    reviewerUserId: null, reviewerDisplayName: null, completedActions: totalActions, totalActions,
    phase: 'complete', errorCode: null, trashEntryIds: ['private-sql-cache'], leaseOwner: null, createdAt: 1, updatedAt: 2,
  };
  const execution: WorkspaceOperationBatchExecutionResult = {
    status: 'applied', completedActions: totalActions, totalActions, errorCode: null,
    trashEntryIds: plan.pathSteps.flatMap((step, index) => step.kind === 'delete' ? [`trash-${index}`] : []),
    stepResults: [
      ...plan.pathSteps.map((step, index) => ({ key: `path:${index}`, phase: 'path' as const, state: 'applied' as const,
        path: step.sourcePath, destinationPath: step.destinationPath, reviewId: step.reviewId,
        sourceIdentity: 'private-source-identity',
        ...(step.kind === 'delete' ? { trashEntryId: `trash-${index}` } : { mutationId: `filesystem-mutation-${index}` }),
      })),
      ...plan.previewContents.map((document, index) => ({ key: `link:${index}`, phase: 'link' as const,
        state: 'applied' as const, path: document.path })),
    ],
  };
  return { batch, execution };
}

function trashEntry(id: string, originalPath: string): WorkspaceTrashEntry {
  return { id, workspaceId: scope.workspace.workspaceId, workspaceType: 'personal', organizationId: null,
    ownerUserId: 'owner', originalPath, itemType: 'file', sizeBytes: 42,
    trashRelativePath: 'private/trash/storage', entryName: 'private-entry-name', fileCount: 1, directoryCount: 0,
    status: 'trashed', deletedByUserId: 'private-user-id', restoredByUserId: null, purgedByUserId: null,
    deletedAt: new Date('2026-10-03T00:00:00Z'), expiresAt: new Date('2026-11-03T00:00:00Z'),
    restoredAt: null, purgedAt: null, metadataJson: '{"private":"metadata"}' };
}

const unavailable = (error: unknown) => {
  assert.ok(error instanceof WorkspaceOperationBatchError);
  assert.equal(error.code, 'BATCH_JOURNAL_UNAVAILABLE');
  assert.equal(error.status, 409);
  return true;
};

async function main() {
  const move = fixture('move');
  let reads = 0;
  const execution = async (input: { batchId: string; scope: WorkspaceOperationBatchScope }) => {
    reads += 1;
    assert.equal(input.batchId, move.batch.batchId);
    assert.equal(input.scope, scope);
    return move.execution;
  };
  for (const status of ['preview', 'blocked', 'queued', 'applying', 'needs_review', 'needs_recovery', 'failed'] as const) {
    const batch = { ...move.batch, status, completedActions: 0, errorCode: 'PRIVATE_SAFETY_DETAIL' };
    const result = await workspacePathOperationResponse(batch, scope, { execution });
    assert.deepEqual(result, { operation: workspacePathOperationMetadata(batch) }, 'unsettled SQL status never claims mutation success');
  }
  assert.equal(reads, 0, 'unsettled status reads do not load private journal');
  const result = await workspacePathOperationResponse(move.batch, scope, { execution });
  assert.deepEqual(result.mutation, { type: 'rename', operationId: 'filesystem-mutation-0',
    workspaceId: scope.workspace.workspaceId, oldPath: 'old.md', newPath: 'new.md' });
  assert.equal(result.linkStatus, 'complete');
  assert.deepEqual(result.linkUpdates, { updatedFiles: ['home.md'], updatedLinks: 1, warnings: [] });
  assert.equal('deleted' in result, false);
  const serialized = JSON.stringify(result);
  for (const field of ['originalDocuments', 'deletedDocuments', 'previewContents', 'linkPlan', 'authorization',
    'actorSessionId', 'reviewIds', 'reviewRefs', 'sourceIdentity', 'trashRelativePath', 'metadataJson', 'requestHash']) {
    assert.equal(serialized.includes(`"${field}"`), false, `${field} must remain private`);
  }
  assert.equal(serialized.includes('private-'), false);
  assert.equal(serialized.includes('Private original source'), false);

  let forwardReads = 0;
  await workspacePathOperationResponse(move.batch, scope, { execution, publicExecution: async (input) => {
    forwardReads += 1;
    assert.equal(input.batchId, move.batch.batchId); assert.equal(input.scope, scope); assert.equal(input.plan, move.batch.plan);
    assert.equal(input.actionMode, 'apply'); assert.equal(input.status, 'applied');
    assert.equal(input.completedActions, move.batch.totalActions); assert.equal(input.phase, 'complete');
    return forwardProjection(move.batch);
  } });
  assert.equal(forwardReads, 1, 'raw complete receipts are additionally verified by the public byte-exact journal projection');
  const publicForward = forwardProjection(move.batch);
  for (const invalid of [
    null as unknown as WorkspaceOperationBatchExecutionPublic,
    { ...publicForward, mode: 'undo' as const },
    { ...publicForward, receiptStatus: 'unavailable' as const },
    { ...publicForward, receiptStatus: 'not_started' as const },
    { ...publicForward, finalization: 'pending' as const },
    { ...publicForward, steps: publicForward.steps.slice(0, 1) },
    { ...publicForward, steps: publicForward.steps.map((step) => ({ ...step, state: 'needs_check' as const })) },
  ]) {
    await assert.rejects(workspacePathOperationResponse(move.batch, scope,
      { execution, publicExecution: async () => invalid }), unavailable,
    'complete SQL and raw counts cannot override unavailable or unfinished exact journal evidence');
  }
  await assert.rejects(workspacePathOperationResponse(move.batch, scope, { execution,
    publicExecution: async () => { throw new Error('Exact journal projection unreadable'); } }), /journal projection unreadable/u);

  const paths = move.execution.stepResults!.filter((step) => step.phase === 'path');
  const links = move.execution.stepResults!.filter((step) => step.phase === 'link');
  for (const broken of [
    null, { ...move.execution, status: 'needs_recovery' as const },
    { ...move.execution, completedActions: move.execution.completedActions - 1 },
    { ...move.execution, totalActions: move.execution.totalActions + 1 },
    { ...move.execution, stepResults: undefined },
    { ...move.execution, stepResults: links },
    { ...move.execution, stepResults: [...paths.map((step) => ({ ...step, state: 'intent' as const })), ...links] },
    { ...move.execution, stepResults: [...paths.map((step) => ({ ...step, mutationId: undefined })), ...links] },
    { ...move.execution, stepResults: [...paths.map((step) => ({ ...step, mutationId: '' })), ...links] },
    { ...move.execution, stepResults: [...paths.map((step) => ({ ...step, destinationPath: 'other.md' })), ...links] },
    { ...move.execution, stepResults: [...paths, ...links, paths[0]] },
    { ...move.execution, stepResults: paths },
    { ...move.execution, stepResults: [...paths, ...links.map((step) => ({ ...step, state: 'intent' as const }))] },
    { ...move.execution, stepResults: [...paths, ...links.map((step) => ({ ...step, path: 'unrelated.md' }))] },
  ]) {
    await assert.rejects(workspacePathOperationResponse(move.batch, scope, { execution: async () => broken }), unavailable);
  }
  for (const inconsistent of [
    { ...move.batch, completedActions: 0 }, { ...move.batch, totalActions: 0 },
    { ...move.batch, phase: 'recovery' as const },
  ]) {
    await assert.rejects(workspacePathOperationResponse(inconsistent, scope, { execution }), unavailable);
  }

  const overwrite = fixture('overwrite');
  const overwritten = await workspacePathOperationResponse(overwrite.batch, scope, { execution: async () => overwrite.execution });
  assert.equal(overwritten.mutation?.operationId, 'filesystem-mutation-1', 'overwrite exposes the actual source move, not destination trash or batch identity');
  assert.equal('trashEntries' in overwritten, false);

  const deletion = fixture('delete');
  const entries = [trashEntry('trash-0', 'old.md'), trashEntry('trash-1', 'image.png')];
  const deleted = await workspacePathOperationResponse(deletion.batch, scope, {
    execution: async () => deletion.execution, trash: async () => [trashEntry('unrelated-trash', 'unrelated.md'), ...entries.slice().reverse()],
  });
  assert.deepEqual(deleted.deleted, ['old.md', 'image.png']);
  assert.deepEqual(deleted.failed, []);
  assert.deepEqual(deleted.trashEntries, entries.map((entry) => ({ id: entry.id, originalPath: entry.originalPath,
    itemType: entry.itemType, sizeBytes: entry.sizeBytes, expiresAt: entry.expiresAt.toISOString() })));
  assert.equal('mutation' in deleted, false);
  assert.equal(JSON.stringify(deleted).includes('unrelated-trash'), false);
  assert.equal(JSON.stringify(deleted).includes('private'), false);
  for (const broken of [
    { ...deletion.execution, stepResults: deletion.execution.stepResults!.map((step) => step.key === 'path:1'
      ? { ...step, trashEntryId: undefined } : step) },
    { ...deletion.execution, stepResults: deletion.execution.stepResults!.map((step) => step.key === 'path:1'
      ? { ...step, trashEntryId: 'trash-0' } : step) },
  ]) {
    await assert.rejects(workspacePathOperationResponse(deletion.batch, scope,
      { execution: async () => broken, trash: async () => entries }), unavailable);
  }
  await assert.rejects(workspacePathOperationResponse(deletion.batch, scope,
    { execution: async () => deletion.execution, trash: async () => entries.slice(0, 1) }), unavailable);
  for (const invalid of [
    { ...entries[0], originalPath: 'unrelated.md' }, { ...entries[0], workspaceId: 'foreign-workspace' },
  ]) {
    await assert.rejects(workspacePathOperationResponse(deletion.batch, scope,
      { execution: async () => deletion.execution, trash: async () => [invalid, entries[1]] }), unavailable);
  }
  for (const historicalStatus of ['restored', 'purged'] as const) {
    const statuses: string[] = [];
    const historical = await workspacePathOperationResponse(deletion.batch, scope, {
      execution: async () => deletion.execution, trash: async (input) => {
        statuses.push(input.status!);
        return input.status === historicalStatus ? entries.map((entry) => ({ ...entry, status: historicalStatus })) : [];
      },
    });
    assert.deepEqual(historical, deleted, 'later restoration or purge does not invalidate the completed historical deletion receipt');
    assert.deepEqual(statuses, historicalStatus === 'restored' ? ['trashed', 'restored'] : ['trashed', 'restored', 'purged']);
  }
  const mixed = await workspacePathOperationResponse(deletion.batch, scope, {
    execution: async () => deletion.execution, trash: async (input) => input.status === 'trashed' ? [entries[0]]
      : input.status === 'restored' ? [{ ...entries[1], status: 'restored' as const }] : [],
  });
  assert.deepEqual(mixed, deleted, 'historical lookup combines active and restored receipts for the same completed deletion');
  const offsets: number[] = [];
  const paginated = await workspacePathOperationResponse(deletion.batch, scope, {
    execution: async () => deletion.execution,
    trash: async (input) => {
      assert.equal(input.workspace, scope.workspace); assert.equal(input.limit, 1000);
      assert.equal(input.status, 'trashed');
      offsets.push(input.offset ?? 0);
      return input.offset ? entries : Array.from({ length: 1000 }, (_, index) => trashEntry(`unrelated-${index}`, 'unrelated.md'));
    },
  });
  assert.deepEqual(offsets, [0, 1000]);
  assert.deepEqual(paginated.trashEntries, deleted.trashEntries, 'all requested trash receipts survive pagination');

  for (const existing of [true, false]) {
    const ignoredPlan = createWorkspaceOperationBatchPlan({ snapshot: { workspaceId: scope.workspace.workspaceId, entries: existing ? [
      { path: 'old.md', kind: 'file', identity: 'private-existing', markdownContent: '# Target' },
      { path: 'home.md', kind: 'file', identity: 'private-backlink', markdownContent: '[Target](old.md)' },
    ] : [] }, actions: [{ reviewId: 'ignore-missing-delete', kind: 'delete', ignoreMissing: true,
      selections: existing ? [{ sourcePath: 'old.md' }, { sourcePath: 'absent.md' }] : [{ sourcePath: 'absent.md' }] }] });
    assert.equal(ignoredPlan.readiness, 'ready');
    const ignoredTotal = ignoredPlan.pathSteps.length + ignoredPlan.previewContents.length;
    const ignoredBatch = { ...deletion.batch, plan: ignoredPlan, planId: ignoredPlan.planId,
      completedActions: ignoredTotal, totalActions: ignoredTotal };
    const ignoredExecution = { ...deletion.execution, completedActions: ignoredTotal, totalActions: ignoredTotal,
      trashEntryIds: existing ? ['trash-0'] : [], stepResults: existing
        ? deletion.execution.stepResults!.filter((step) => step.key === 'path:0' || step.key === 'link:0') : [] };
    let trashReads = 0;
    const ignored = await workspacePathOperationResponse(ignoredBatch, scope, {
      execution: async () => ignoredExecution, trash: async () => { trashReads += 1; return [entries[0]]; },
    });
    assert.deepEqual(ignored.deleted, existing ? ['old.md'] : []);
    assert.deepEqual(ignored.operation.selections, ignoredPlan.actions[0].selections,
      'metadata retains the full original request including missing selections');
    assert.deepEqual(ignored.trashEntries, existing ? deleted.trashEntries!.slice(0, 1) : []);
    assert.equal(ignored.linkStatus, 'complete');
    assert.equal(trashReads, existing ? 1 : 0, 'an all-missing durable no-op has no trash evidence to load');
  }

  for (const unauthorized of [
    { ...scope, workspace: { ...scope.workspace, workspaceId: 'foreign-workspace' } },
    { ...scope, workspace: { ...scope.workspace, status: 'archived' as const } },
    { ...scope, workspace: { ...scope.workspace, permissions: { ...scope.workspace.permissions, canRead: false } } },
  ]) {
    await assert.rejects(workspacePathOperationResponse(move.batch, unauthorized, { execution }), (error: unknown) => {
      assert.ok(error instanceof WorkspaceOperationBatchError);
      assert.equal(error.code, 'BATCH_ACCESS_DENIED'); assert.equal(error.status, 403);
      return true;
    });
  }
  const inverse: WorkspaceOperationBatchExecutionPublic = {
    mode: 'undo', receiptStatus: 'available', finalization: 'complete', steps: [
      { key: 'link:0', phase: 'link', kind: 'link_update', path: 'home.md', state: 'applied' },
      { key: 'path:0', phase: 'path', kind: 'move', path: 'new.md', destinationPath: 'old.md', state: 'applied' },
    ],
  };
  const undone = { ...move.batch, status: 'undone' as const, actionMode: 'undo' as const };
  let inverseReads = 0;
  const inverseResult = await workspacePathOperationResponse(undone, scope, {
    execution: async () => { throw new Error('Undo must inspect inverse finalization rather than forward receipts'); },
    publicExecution: async (input) => {
      inverseReads += 1;
      assert.equal(input.batchId, undone.batchId); assert.equal(input.scope, scope); assert.equal(input.plan, undone.plan);
      assert.equal(input.actionMode, 'undo'); assert.equal(input.status, 'undone'); assert.equal(input.phase, 'complete');
      return inverse;
    },
  });
  assert.equal(inverseReads, 1);
  assert.deepEqual(inverseResult, { operation: workspacePathOperationMetadata(undone) },
    'completed Undo does not replay the forward move or deletion response');
  for (const broken of [
    { ...inverse, mode: 'apply' as const }, { ...inverse, receiptStatus: 'unavailable' as const },
    { ...inverse, receiptStatus: 'not_started' as const }, { ...inverse, finalization: 'pending' as const },
    { ...inverse, steps: inverse.steps.slice(0, 1) },
    { ...inverse, steps: inverse.steps.map((step) => ({ ...step, state: 'needs_check' as const })) },
  ]) {
    await assert.rejects(workspacePathOperationResponse(undone, scope, { publicExecution: async () => broken }), unavailable);
  }
  for (const inconsistent of [
    { ...undone, completedActions: 0 }, { ...undone, phase: 'recovery' as const },
  ]) {
    await assert.rejects(workspacePathOperationResponse(inconsistent, scope, { publicExecution: async () => inverse }), unavailable);
  }
  console.log('workspace path responses: exact receipts, real mutation IDs, complete trash evidence, settled-only success and private data isolation passed');
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
