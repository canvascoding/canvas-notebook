import assert from 'node:assert/strict';

import { closeDatabaseConnections, openDb } from '@/app/lib/db';
import { createPostgresPool, runPostgresMigrations } from '@/app/lib/db/postgres';
import {
  acceptExcalidrawAgentOperation,
  cancelExcalidrawAgentOperation,
  createExcalidrawAgentOperation,
  ExcalidrawIdempotencyConflictError,
  rejectExcalidrawAgentOperation,
} from '@/app/lib/excalidraw-collaboration/agent-operations';
import type { ExcalidrawElementRecord } from '@/app/lib/excalidraw-collaboration/protocol';
import { storeExcalidrawAsset } from '@/app/lib/excalidraw-collaboration/assets';
import {
  applyExcalidrawScenePatch, archiveExcalidrawScenePaths, ensureExcalidrawScene,
  EXCALIDRAW_PORTABLE_MAX_BYTES, ExcalidrawSceneResyncError, loadExcalidrawScene, reactivateExcalidrawScenePath,
} from '@/app/lib/excalidraw-collaboration/repository';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

function element(id: string, version: number, versionNonce: number, overrides: Record<string, unknown> = {}): ExcalidrawElementRecord {
  return {
    id,
    type: 'rectangle',
    version,
    versionNonce,
    isDeleted: false,
    index: `a${id}`,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    angle: 0,
    opacity: 100,
    groupIds: [],
    boundElements: [],
    ...overrides,
  };
}

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const migrationPool = createPostgresPool();
  await runPostgresMigrations(migrationPool);
  await migrationPool.end();
  const suffix = `${Date.now()}-${process.pid}`;
  const documentId = `agent-document-${suffix}`;
  const workspace: WorkspaceContext = {
    workspaceId: `agent-workspace-${suffix}`,
    workspaceType: 'team',
    rootPath: process.env.DATA || process.cwd(),
    organizationId: `org-${suffix}`,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: false,
      canRunAgent: true,
    },
    legacy: false,
  };
  await ensureExcalidrawScene({
    documentId,
    workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId ?? null,
    path: 'agent.excalidraw',
    initialContent: JSON.stringify({ elements: [element('agent-target', 1, 100), element('user-target', 1, 200)], appState: {} }),
  });
  const largeDocumentId = `portable-large-${suffix}`;
  const largeScene = await ensureExcalidrawScene({
    documentId: largeDocumentId, workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null,
    path: 'large.excalidraw', initialContent: JSON.stringify({ type: 'excalidraw', elements: [], appState: {}, source: 'x'.repeat(11 * 1024 * 1024) }),
  });
  assert.equal(largeScene.documentId, largeDocumentId, 'Valid portable scenes over the obsolete 10 MiB import limit must initialize.');
  const oversizedDocumentId = `portable-oversized-${suffix}`;
  await assert.rejects(ensureExcalidrawScene({
    documentId: oversizedDocumentId, workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null,
    path: 'oversized.excalidraw', initialContent: ' '.repeat(EXCALIDRAW_PORTABLE_MAX_BYTES + 1),
  }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EXCALIDRAW_SCENE_TOO_LARGE'));
  assert.equal(await loadExcalidrawScene(oversizedDocumentId), null, 'Oversized portable import must not initialize database state.');
  const missingImageDocumentId = `missing-image-asset-${suffix}`;
  await assert.rejects(ensureExcalidrawScene({ documentId: missingImageDocumentId, workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId ?? null, path: 'missing-image.excalidraw', initialContent: JSON.stringify({
      elements: [element('missing-image', 1, 90, { type: 'image', fileId: 'missing-file', status: 'saved' })], appState: {},
    }) }), /references missing asset/u);
  assert.equal(await loadExcalidrawScene(missingImageDocumentId), null, 'An imported image without its file must not initialize a scene.');
  const imageAsset = await storeExcalidrawAsset({ workspaceId: workspace.workspaceId, fileId: 'live-image-file', mimeType: 'image/png',
    data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
  const liveImageDocumentId = `live-image-asset-${suffix}`;
  const liveImageScene = await ensureExcalidrawScene({ documentId: liveImageDocumentId, workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId ?? null, path: 'live-image.excalidraw', initialAssets: [imageAsset],
    initialContent: JSON.stringify({ elements: [element('live-image', 1, 96, { type: 'image', fileId: imageAsset.fileId, status: 'saved' })], appState: {} }) });
  await assert.rejects(applyExcalidrawScenePatch({ documentId: liveImageDocumentId, lifecycleGeneration: liveImageScene.lifecycleGeneration,
    baseSequence: liveImageScene.sceneSequence, messageId: `drop-live-image-asset-${suffix}`, elements: [], assets: [],
    actorType: 'user', actorId: 'user-a',
  }), /references missing asset/u, 'Asset-only changes must validate image references in the entire merged scene.');
  assert.equal((await loadExcalidrawScene(liveImageDocumentId))?.sceneSequence, liveImageScene.sceneSequence);
  assert.deepEqual((await loadExcalidrawScene(liveImageDocumentId))?.assets, liveImageScene.assets);

  await applyExcalidrawScenePatch({
    documentId,
    lifecycleGeneration: 1,
    baseSequence: 0,
    messageId: `user-other-${suffix}`,
    elements: [element('user-target', 2, 190, { x: 20 })],
    actorType: 'user',
    actorId: 'user-a',
  });
  const direct = await createExcalidrawAgentOperation({
    workspace,
    documentId,
    observedSceneSequence: 0,
    initiatedByUserId: 'user-a',
    actorId: 'agent-a',
    idempotencyKey: `direct-${suffix}`,
    actions: [{
      type: 'update',
      elementId: 'agent-target',
      expectedVersion: 1,
      expectedVersionNonce: 100,
      element: element('agent-target', 1, 100, { x: 99 }),
    }],
  });
  assert.equal(direct.status, 'applied', 'An unchanged target must rebase even when another element advanced the scene.');
  const directDuplicate = await createExcalidrawAgentOperation({
    workspace,
    documentId,
    observedSceneSequence: 0,
    initiatedByUserId: 'user-a',
    actorId: 'agent-a',
    idempotencyKey: `direct-${suffix}`,
    actions: direct.actions,
  });
  assert.equal(directDuplicate.operationId, direct.operationId, 'Tool retry must be idempotent.');
  await assert.rejects(createExcalidrawAgentOperation({
    workspace, documentId, observedSceneSequence: 0, initiatedByUserId: 'user-a', actorId: 'agent-a',
    idempotencyKey: `direct-${suffix}`,
    actions: [{ type: 'delete', elementId: 'agent-target', expectedVersion: 1, expectedVersionNonce: 100 }],
  }), ExcalidrawIdempotencyConflictError, 'Reusing the same key with different content must be a conflict.');
  const otherActor = await createExcalidrawAgentOperation({
    workspace, documentId, observedSceneSequence: 0, initiatedByUserId: 'user-a', actorId: 'agent-b',
    idempotencyKey: `direct-${suffix}`, actions: direct.actions,
  });
  assert.notEqual(otherActor.operationId, direct.operationId, 'Idempotency keys belong to the actor namespace.');

  const review = await createExcalidrawAgentOperation({
    workspace,
    documentId,
    observedSceneSequence: 0,
    initiatedByUserId: 'user-a',
    actorId: 'agent-a',
    idempotencyKey: `review-${suffix}`,
    actions: [{
      type: 'update',
      elementId: 'user-target',
      expectedVersion: 1,
      expectedVersionNonce: 200,
      element: element('user-target', 1, 200, { x: 88 }),
    }],
  });
  assert.equal(review.status, 'needs_review', 'Same-element human intervention must never be overwritten blindly.');
  const accepted = await acceptExcalidrawAgentOperation({ operationId: review.operationId, workspace, userId: 'user-a' });
  assert.equal(accepted.status, 'applied');
  assert.equal((await loadExcalidrawScene(documentId))?.elements.find((candidate) => candidate.id === 'user-target')?.x, 88);
  const acceptedAgain = await acceptExcalidrawAgentOperation({ operationId: review.operationId, workspace, userId: 'user-a' });
  assert.equal(acceptedAgain.status, 'applied', 'Accept retries must be idempotent.');

  const rejectReview = await createExcalidrawAgentOperation({
    workspace,
    documentId,
    observedSceneSequence: 0,
    initiatedByUserId: 'user-a',
    actorId: 'agent-a',
    idempotencyKey: `reject-${suffix}`,
    actions: [{ type: 'delete', elementId: 'user-target', expectedVersion: 1, expectedVersionNonce: 200 }],
  });
  assert.equal(rejectReview.status, 'needs_review');
  assert.equal((await rejectExcalidrawAgentOperation({ operationId: rejectReview.operationId, workspace, userId: 'user-a' })).status, 'rejected');

  const cancelReview = await createExcalidrawAgentOperation({
    workspace,
    documentId,
    observedSceneSequence: 0,
    initiatedByUserId: 'user-a',
    actorId: 'agent-a',
    idempotencyKey: `cancel-${suffix}`,
    actions: [{ type: 'delete', elementId: 'user-target', expectedVersion: 1, expectedVersionNonce: 200 }],
  });
  assert.equal((await cancelExcalidrawAgentOperation({ operationId: cancelReview.operationId, workspace, userId: 'user-a' })).status, 'cancelled');

  const intervention = await createExcalidrawAgentOperation({
    workspace,
    documentId,
    observedSceneSequence: 0,
    initiatedByUserId: 'user-a',
    actorId: 'agent-a',
    idempotencyKey: `intervention-${suffix}`,
    actions: [{ type: 'delete', elementId: 'user-target', expectedVersion: 1, expectedVersionNonce: 200 }],
  });
  let current = (await loadExcalidrawScene(documentId))!;
  const currentTarget = current.elements.find((candidate) => candidate.id === 'user-target')!;
  await applyExcalidrawScenePatch({
    documentId,
    lifecycleGeneration: 1,
    baseSequence: current.sceneSequence,
    messageId: `user-intervention-${suffix}`,
    elements: [{ ...currentTarget, version: currentTarget.version + 1, versionNonce: 5, x: 123 }],
    actorType: 'user',
    actorId: 'user-a',
  });
  const firstAccept = await acceptExcalidrawAgentOperation({ operationId: intervention.operationId, workspace, userId: 'user-a' });
  assert.equal(firstAccept.status, 'needs_review', 'A second human intervention after review creation must require renewed review.');
  const secondAccept = await acceptExcalidrawAgentOperation({ operationId: intervention.operationId, workspace, userId: 'user-a' });
  assert.equal(secondAccept.status, 'applied');
  current = (await loadExcalidrawScene(documentId))!;
  assert.equal(current.elements.find((candidate) => candidate.id === 'user-target')?.isDeleted, true);

  // The whole request must remain unapplied when one target conflicts.
  const batchConflict = await createExcalidrawAgentOperation({
    workspace, documentId, lifecycleGeneration: 1, observedSceneSequence: 0,
    initiatedByUserId: 'user-a', actorId: 'agent-a', idempotencyKey: `batch-conflict-${suffix}`,
    actions: [
      { type: 'create', element: element('must-not-exist', 1, 44) },
      { type: 'delete', elementId: 'agent-target', expectedVersion: 1, expectedVersionNonce: 100 },
    ],
  });
  assert.equal(batchConflict.status, 'needs_review');
  assert.equal((await loadExcalidrawScene(documentId))?.elements.some((entry) => entry.id === 'must-not-exist'), false);
  const readOnly = { ...workspace, permissions: { ...workspace.permissions, canWrite: false } };
  for (const transition of [acceptExcalidrawAgentOperation, rejectExcalidrawAgentOperation, cancelExcalidrawAgentOperation]) {
    await assert.rejects(transition({ workspace: readOnly, userId: 'user-a', operationId: batchConflict.operationId }), /write access/u,
      'Every review transition must recheck current write permission.');
    await assert.rejects(transition({ workspace, userId: 'other-user', operationId: batchConflict.operationId }), /not found/u,
      'A different workspace member cannot decide another user\'s operation.');
    await assert.rejects(transition({ workspace, userId: 'user-a', operationId: batchConflict.operationId,
      beforeApply: async () => readOnly }), /write access/u, 'Final authority must use fresh permissions acquired under the scene lock.');
    await assert.rejects(transition({ workspace: { ...workspace, permissions: { ...workspace.permissions, canManageWorkspace: true } },
      userId: 'former-manager', operationId: batchConflict.operationId, beforeApply: async operation => {
        assert.equal(operation.operationId, batchConflict.operationId);
        return workspace; // Management permission revoked; write permission remains.
      } }), /not found/u, 'Downgrading a manager to writer must revoke authority over another user\'s review.');
  }

  const parallelInput = {
    workspace, documentId, lifecycleGeneration: 1, observedSceneSequence: current.sceneSequence,
    initiatedByUserId: 'user-a', actorId: 'agent-a',
  };
  const beforeMissingImage = (await loadExcalidrawScene(documentId))!;
  const missingImageKey = `missing-image-patch-${suffix}`;
  await assert.rejects(createExcalidrawAgentOperation({ ...parallelInput, idempotencyKey: missingImageKey,
    actions: [
      { type: 'create', element: element('image-atomic-companion', 1, 92) },
      { type: 'create', element: element('image-without-asset', 1, 91, { type: 'image', fileId: 'nonexistent', status: 'saved' }) },
    ],
  }), /references missing asset/u);
  assert.equal((await loadExcalidrawScene(documentId))?.sceneSequence, beforeMissingImage.sceneSequence);
  assert.deepEqual((await loadExcalidrawScene(documentId))?.elements, beforeMissingImage.elements,
    'An invalid image must leave every action in the operation unapplied.');
  const missingImageDatabase = await openDb();
  try {
    assert.equal(await missingImageDatabase.get('SELECT operation_id FROM collaboration_excalidraw_agent_operations WHERE idempotency_key=$1', [missingImageKey]), undefined);
  } finally { await missingImageDatabase.close(); }
  const pendingImage = await createExcalidrawAgentOperation({ ...parallelInput, idempotencyKey: `pending-image-${suffix}`,
    actions: [{ type: 'create', element: element('pending-image', 1, 93, { type: 'image', fileId: null, status: 'pending' }) }],
  });
  assert.equal(pendingImage.status, 'applied', 'The real Excalidraw pending-image insertion contract remains valid.');
  const beforeInvalidPendingImage = (await loadExcalidrawScene(documentId))!;
  await assert.rejects(applyExcalidrawScenePatch({ documentId, lifecycleGeneration: 1,
    baseSequence: beforeInvalidPendingImage.sceneSequence, messageId: `invalid-image-null-${suffix}`,
    elements: [element('invalid-null-image', 1, 94, { type: 'image', fileId: null, status: 'saved' })],
    actorType: 'user', actorId: 'user-a',
  }), /valid asset fileId/u);
  assert.equal((await loadExcalidrawScene(documentId))?.sceneSequence, beforeInvalidPendingImage.sceneSequence);
  const deletedImage = await applyExcalidrawScenePatch({ documentId, lifecycleGeneration: 1,
    baseSequence: beforeInvalidPendingImage.sceneSequence, messageId: `deleted-image-reference-${suffix}`,
    elements: [element('deleted-image', 1, 95, { type: 'image', fileId: 'historical-missing-file', isDeleted: true })],
    actorType: 'user', actorId: 'user-a',
  });
  assert.equal(deletedImage.acceptedElements[0]?.isDeleted, true, 'Historical deleted image references do not require live assets.');
  const deniedBefore = (await loadExcalidrawScene(documentId))!;
  const deniedKey = `revoked-in-transaction-${suffix}`;
  await assert.rejects(createExcalidrawAgentOperation({ ...parallelInput, idempotencyKey: deniedKey,
    actions: [{ type: 'create', element: element('revoked-in-transaction', 1, 51) }],
    beforeApply: async () => { throw new Error('Test authority revoked inside transaction'); },
  }), /Test authority revoked inside transaction/u);
  assert.equal((await loadExcalidrawScene(documentId))?.sceneSequence, deniedBefore.sceneSequence);
  const deniedDatabase = await openDb();
  try {
    assert.equal(await deniedDatabase.get('SELECT operation_id FROM collaboration_excalidraw_agent_operations WHERE idempotency_key=$1', [deniedKey]), undefined,
      'A final authority check failure must leave neither an operation identity nor a scene delta.');
  } finally { await deniedDatabase.close(); }
  const disjoint = await Promise.all(['parallel-a', 'parallel-b'].map((id) => createExcalidrawAgentOperation({
    ...parallelInput, idempotencyKey: `${id}-${suffix}`, actions: [{ type: 'create', element: element(id, 1, 50) }],
  })));
  assert.deepEqual(disjoint.map((operation) => operation.status), ['applied', 'applied']);
  const competing = await Promise.all(['first', 'second'].map((id) => createExcalidrawAgentOperation({
    ...parallelInput, idempotencyKey: `competing-${id}-${suffix}`, actions: [{ type: 'create', element: element('competing', 1, 60) }],
  })));
  assert.deepEqual(competing.map((operation) => operation.status).sort(), ['applied', 'needs_review'],
    'Concurrent requests to the same element must apply exactly one operation.');
  const observedUpdateTarget = (await loadExcalidrawScene(documentId))!.elements.find((entry) => entry.id === 'parallel-a')!;
  const competingUpdates = await Promise.all([101, 202].map((x) => createExcalidrawAgentOperation({
    ...parallelInput, idempotencyKey: `competing-update-${x}-${suffix}`, actions: [{
      type: 'update', elementId: observedUpdateTarget.id, expectedVersion: observedUpdateTarget.version,
      expectedVersionNonce: observedUpdateTarget.versionNonce, element: { ...observedUpdateTarget, x },
    }],
  })));
  assert.deepEqual(competingUpdates.map((operation) => operation.status).sort(), ['applied', 'needs_review'],
    'Expected versions must be checked after acquiring the scene transaction lock.');
  assert.equal((await loadExcalidrawScene(documentId))!.elements.find((entry) => entry.id === 'parallel-a')?.version,
    observedUpdateTarget.version + 1, 'A conflicting concurrent update must never increment the element again.');
  const retryInput = { ...parallelInput, idempotencyKey: `concurrent-retry-${suffix}`,
    actions: [{ type: 'create' as const, element: element('concurrent-retry', 1, 70) }] };
  const concurrentRetry = await Promise.all([createExcalidrawAgentOperation(retryInput), createExcalidrawAgentOperation(retryInput)]);
  assert.equal(concurrentRetry[0].operationId, concurrentRetry[1].operationId);
  assert.equal(concurrentRetry[0].result?.sceneSequence, concurrentRetry[1].result?.sceneSequence);

  // Emulate a pre-upgrade process crash after inserting a durable preparing row.
  const connection = await openDb();
  try {
    const seedLegacy = async (id: string, key: string, target: string) => {
      const actions = [{ type: 'create' as const, element: element(target, 1, 90) }];
      await connection.run(`INSERT INTO collaboration_excalidraw_agent_operations (
        operation_id, document_id, workspace_id, lifecycle_generation, observed_scene_sequence,
        initiated_by_user_id, actor_id, idempotency_key, status, patch_json, cas_version, created_at, updated_at
      ) VALUES ($1,$2,$3,1,0,'user-a','agent-a',$4,'preparing',CAST($5 AS jsonb),0,$6,$6)`,
      [id, documentId, workspace.workspaceId, key, JSON.stringify(actions), Date.now()]);
      return { workspace, documentId, lifecycleGeneration: 1, observedSceneSequence: 0,
        initiatedByUserId: 'user-a', actorId: 'agent-a', idempotencyKey: key, actions };
    };
    const legacyInput = await seedLegacy(`legacy-preparing-${suffix}`, `legacy-${suffix}`, 'legacy-create');
    const resumed = await createExcalidrawAgentOperation(legacyInput);
    assert.equal(resumed.status, 'applied');
    assert.equal(resumed.operationId, `legacy-preparing-${suffix}`);
    assert(resumed.requestFingerprint);
    const oldAppliedId = `legacy-split-commit-${suffix}`;
    const oldAppliedInput = await seedLegacy(oldAppliedId, `legacy-split-${suffix}`, 'legacy-already-applied');
    const beforeOldApply = (await loadExcalidrawScene(documentId))!;
    const oldApplied = await applyExcalidrawScenePatch({
      documentId, lifecycleGeneration: 1, baseSequence: beforeOldApply.sceneSequence,
      messageId: `${oldAppliedId}:apply:0`, elements: [element('legacy-already-applied', 1, 90)],
      actorType: 'agent', actorId: 'agent-a', initiatedByUserId: 'user-a',
    });
    const finalized = await createExcalidrawAgentOperation(oldAppliedInput);
    assert.equal(finalized.status, 'applied');
    assert.equal((await loadExcalidrawScene(documentId))?.sceneSequence, oldApplied.state.sceneSequence,
      'A legacy apply committed before status must be finalized without advancing the scene again.');

    // Force failure at the final metadata write: the scene and new operation must both roll back.
    const failureKey = `atomic-failure-${suffix}`;
    const triggerId = `excal_atomic_${suffix.replaceAll('-', '_')}`;
    await connection.run(`CREATE FUNCTION ${triggerId}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.idempotency_key = '${failureKey}' AND NEW.status = 'applied' THEN
        RAISE EXCEPTION 'test operation status failure'; END IF; RETURN NEW; END $$`);
    await connection.run(`CREATE TRIGGER ${triggerId} BEFORE UPDATE ON collaboration_excalidraw_agent_operations
      FOR EACH ROW EXECUTE FUNCTION ${triggerId}()`);
    try {
      const beforeFailure = (await loadExcalidrawScene(documentId))!;
      await assert.rejects(createExcalidrawAgentOperation({ ...parallelInput, idempotencyKey: failureKey,
        actions: [{ type: 'create', element: element('rolled-back-element', 1, 80) }] }), /test operation status failure/u);
      const afterFailure = (await loadExcalidrawScene(documentId))!;
      assert.equal(afterFailure.sceneSequence, beforeFailure.sceneSequence);
      assert.equal(afterFailure.elements.some((entry) => entry.id === 'rolled-back-element'), false);
      const failedOperation = await connection.get('SELECT operation_id FROM collaboration_excalidraw_agent_operations WHERE idempotency_key = $1', [failureKey]);
      assert.equal(failedOperation, undefined, 'Failure must roll back operation identity and scene together.');
    } finally {
      await connection.run(`DROP TRIGGER ${triggerId} ON collaboration_excalidraw_agent_operations`);
      await connection.run(`DROP FUNCTION ${triggerId}()`);
    }
  } finally {
    await connection.close();
  }

  await assert.rejects(createExcalidrawAgentOperation({ ...parallelInput, lifecycleGeneration: 2,
    idempotencyKey: `stale-generation-${suffix}`, actions: [{ type: 'create', element: element('stale', 1, 80) }] }), /lifecycle changed/u);
  const beforeArchive = (await loadExcalidrawScene(documentId))!;
  const lifecyclePatch = { documentId, lifecycleGeneration: 1, baseSequence: beforeArchive.sceneSequence,
    messageId: `lifecycle-retry-${suffix}`, elements: [element('lifecycle-patch', 1, 87)],
    actorType: 'user' as const, actorId: 'user-a' };
  const lifecycleApplied = await applyExcalidrawScenePatch(lifecyclePatch);
  await archiveExcalidrawScenePaths({ workspaceId: workspace.workspaceId, paths: ['agent.excalidraw'] });
  await assert.rejects(applyExcalidrawScenePatch(lifecyclePatch), /unavailable/u, 'Archived scenes must not return an applied duplicate.');
  for (const transition of [acceptExcalidrawAgentOperation, rejectExcalidrawAgentOperation, cancelExcalidrawAgentOperation]) {
    await assert.rejects(transition({ workspace, userId: 'user-a', operationId: batchConflict.operationId }), /unavailable/u,
      'Archived documents must reject every outstanding review action.');
  }
  await reactivateExcalidrawScenePath({ workspaceId: workspace.workspaceId, path: 'agent.excalidraw' });
  const restored = (await loadExcalidrawScene(documentId))!;
  await assert.rejects(applyExcalidrawScenePatch(lifecyclePatch), ExcalidrawSceneResyncError,
    'A retry from an archived lifecycle cannot report an old applied snapshot.');
  await assert.rejects(applyExcalidrawScenePatch({ ...lifecyclePatch, lifecycleGeneration: restored.lifecycleGeneration }),
    ExcalidrawSceneResyncError, 'A reused message ID cannot replay an earlier lifecycle result into a new session.');
  assert.equal((await loadExcalidrawScene(documentId))?.sceneSequence, lifecycleApplied.state.sceneSequence);

  console.log(JSON.stringify({ success: true, direct: direct.status, review: accepted.status, intervention: secondAccept.status,
    disjoint: disjoint.map((operation) => operation.status), competing: competing.map((operation) => operation.status),
    atomicRollback: true, legacyRecovery: true, accessRechecked: true }));
}

void main().finally(closeDatabaseConnections);
