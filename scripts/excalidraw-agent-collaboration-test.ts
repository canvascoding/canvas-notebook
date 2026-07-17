import assert from 'node:assert/strict';

import { closeDatabaseConnections } from '@/app/lib/db';
import { createPostgresPool, runPostgresMigrations } from '@/app/lib/db/postgres';
import {
  acceptExcalidrawAgentOperation,
  cancelExcalidrawAgentOperation,
  createExcalidrawAgentOperation,
  rejectExcalidrawAgentOperation,
} from '@/app/lib/excalidraw-collaboration/agent-operations';
import type { ExcalidrawElementRecord } from '@/app/lib/excalidraw-collaboration/protocol';
import { applyExcalidrawScenePatch, ensureExcalidrawScene, loadExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';
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
    actions: [{ type: 'delete', elementId: 'agent-target', expectedVersion: 1, expectedVersionNonce: 100 }],
  });
  assert.equal(directDuplicate.operationId, direct.operationId, 'Tool retry must be idempotent.');

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

  console.log(JSON.stringify({ success: true, direct: direct.status, review: accepted.status, intervention: secondAccept.status }));
}

void main().finally(closeDatabaseConnections);
