import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeDatabaseConnections, openDb } from '@/app/lib/db';
import { createExcalidrawAgentOperation } from '@/app/lib/excalidraw-collaboration/agent-operations';
import { getExcalidrawOperation, listExcalidrawOperations, reviewExcalidrawOperation } from '@/app/lib/excalidraw-collaboration/operation-service';
import { applyExcalidrawScenePatch, applyExcalidrawScenePatchInTransaction, loadExcalidrawScene,
  loadExcalidrawSceneInTransaction, withExcalidrawSceneTransaction } from '@/app/lib/excalidraw-collaboration/repository';
import { applyExcalidrawChanges, createExcalidrawDocument } from '@/app/lib/excalidraw-collaboration/scene-service';
import { fileVersionContentStore } from '@/app/lib/file-version-center/version-content-store';
import { readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { serverPreferencesPath } from '@/app/lib/terminal-policy';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { excalidrawOperationFeedback } from '@/app/lib/excalidraw-collaboration/api-contract';

const suffix = randomUUID();
const userId = `operation-user-${suffix}`;
const managerId = `operation-manager-${suffix}`;
const organizationId = `operation-org-${suffix}`;
const rootRelativePath = `workspaces/operation-service-test/${suffix}/files`;
const workspace: WorkspaceContext = {
  workspaceId: `operation-team-${suffix}`, workspaceType: 'team', organizationId,
  rootPath: workspaceAbsoluteRoot(rootRelativePath), rootRelativePath, status: 'active', legacy: false,
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
    canManageWorkspace: true, canRunAgent: true },
};
const actor = { userId, actorId: `operation-agent-${suffix}`, actorType: 'agent' as const };
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

async function query<Row>(sql: string, parameters: unknown[] = []): Promise<Row[]> {
  const database = await openDb();
  try { return await database.all(sql, parameters) as Row[]; } finally { await database.close(); }
}
async function execute(sql: string, parameters: unknown[] = []) {
  const database = await openDb();
  try { await database.run(sql, parameters); } finally { await database.close(); }
}
async function authority(currentUserId = userId): Promise<WorkspaceContext> {
  const [member] = await query<{ status: string; can_read: boolean; can_write: boolean; can_manage: boolean }>(
    'SELECT status,can_read,can_write,can_manage FROM canvas_workspace_members WHERE workspace_id=$1 AND user_id=$2',
    [workspace.workspaceId, currentUserId]);
  return { ...workspace, actor: { userId: currentUserId, role: 'member' }, permissions: { ...workspace.permissions,
    canRead: member?.status === 'active' && Boolean(member.can_read),
    canWrite: member?.status === 'active' && Boolean(member.can_write),
    canManageWorkspace: member?.status === 'active' && Boolean(member.can_manage) } };
}
async function waitForBlockedConnection(blockerPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [blockerPid]);
    if (rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The review did not wait on the real PostgreSQL lock.');
}

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/canvas_(?:editor|excalidraw)_test_[a-f0-9]{16}$/u);
  assert.match(process.env.CANVAS_DATA_ROOT ?? '', /canvas-excal-review-/u,
    'Run with a dedicated filesystem root so feature toggles cannot affect the managed browser stack.');
  const policyPath = serverPreferencesPath();
  await fs.mkdir(path.dirname(policyPath), { recursive: true });
  const reviewEnabled = async (enabled: boolean) => {
    await fs.writeFile(policyPath, JSON.stringify({ version: 1, settings: { documentReviewEnabled: enabled } }));
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, enabled);
  };
  await fs.rm(policyPath, { force: true });
  assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false, 'Absent configuration is disabled.');
  // The existing managed test database is already migrated. Never race DDL with another suite.
  for (const id of [userId, managerId]) await execute(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
    VALUES ($1,'Operation service test',$2,1,$3,$3)`, [id, `${id}@example.test`, Date.now()]);
  await execute(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
    VALUES ($1,$2,'team',1,$3,$3)`, [organizationId, userId, Date.now()]);
  await execute(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
    VALUES ($1,$2,'team',$3,'Operation service test','active',$4,$4)`, [workspace.workspaceId, organizationId, rootRelativePath, Date.now()]);
  for (const id of [userId, managerId]) await execute(`INSERT INTO canvas_workspace_members
    (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at)
    VALUES ($1,$2,$3,'member','active',1,1,1,$4,$4)`, [organizationId, workspace.workspaceId, id, Date.now()]);
  await fs.mkdir(workspace.rootPath, { recursive: true });
  try {
    const created = await createExcalidrawDocument({ workspace, actor, path: 'closed-review.excalidraw', idempotencyKey: randomUUID() });
    await applyExcalidrawChanges({ workspace, actor, documentId: created.documentId,
      lifecycleGeneration: created.lifecycleGeneration, observedSceneSequence: 0, idempotencyKey: randomUUID(),
      actions: [{ type: 'create', element: { id: 'target', type: 'rectangle', version: 1,
        versionNonce: 10, isDeleted: false, x: 1, y: 1, width: 20, height: 20 } }] });
    const initial = await loadExcalidrawScene(created.documentId);
    assert(initial);
    const target = initial.elements.find(element => element.id === 'target')!;
    await applyExcalidrawScenePatch({ documentId: created.documentId, lifecycleGeneration: 1,
      baseSequence: initial.sceneSequence, messageId: randomUUID(), actorType: 'user', actorId: userId,
      elements: [{ ...target, version: target.version + 1, versionNonce: 100, x: 2 }] });

    async function pendingReview() {
      const state = await loadExcalidrawScene(created.documentId);
      assert(state);
      const current = state.elements.find(element => element.id === 'target')!;
      const operation = await createExcalidrawAgentOperation({ workspace, documentId: state.documentId,
        lifecycleGeneration: state.lifecycleGeneration, observedSceneSequence: state.sceneSequence,
        initiatedByUserId: userId, actorId: actor.actorId, idempotencyKey: randomUUID(), actions: [{
          type: 'update', elementId: 'target', expectedVersion: current.version - 1,
          expectedVersionNonce: 1, element: { ...current, x: 500 } }] });
      assert.equal(operation.status, 'needs_review');
      return operation;
    }
    const disabledReview = await pendingReview();
    const disabledState = await loadExcalidrawScene(created.documentId);
    const disabledSnapshot = await getExcalidrawOperation({ workspace: await authority(), userId, operationId: disabledReview.operationId });
    assert.equal(disabledSnapshot.status, 'needs_review');
    assert.equal(disabledSnapshot.reviewHint, null);
    assert.match(disabledSnapshot.conflictHint ?? '', /Read the current scene.*new idempotency key/u);
    const disabledFeedback = excalidrawOperationFeedback(disabledSnapshot);
    assert.equal(disabledFeedback.reviewAvailable, false);
    assert.equal(disabledFeedback.reviewHint, null);
    for (const decision of ['accept', 'reject'] as const) {
      const decisionInput = decision === 'accept' ? { decision, expectedCasVersion: disabledReview.casVersion } : { decision };
      await assert.rejects(reviewExcalidrawOperation({ workspace: await authority(), userId,
        operationId: disabledReview.operationId, ...decisionInput }), code('DOCUMENT_REVIEW_DISABLED'));
      const unchanged = await getExcalidrawOperation({ workspace: await authority(), userId, operationId: disabledReview.operationId });
      assert.equal(unchanged.status, 'needs_review'); assert.equal(unchanged.casVersion, disabledReview.casVersion);
      assert.equal((await loadExcalidrawScene(created.documentId))?.canonicalHash, disabledState?.canonicalHash);
    }
    const cancelledWhileDisabled = await reviewExcalidrawOperation({ workspace: await authority(), userId,
      operationId: disabledReview.operationId, decision: 'cancel', beforeApply: () => authority() });
    assert.equal(cancelledWhileDisabled.status, 'cancelled');
    assert.equal((await loadExcalidrawScene(created.documentId))?.canonicalHash, disabledState?.canonicalHash);
    await reviewEnabled(true);
    assert.ok(excalidrawOperationFeedback({ ...disabledSnapshot, status: 'needs_review' }).reviewHint);
    for (const decision of ['accept', 'reject'] as const) {
      const pending = await pendingReview();
      const before = await loadExcalidrawScene(created.documentId);
      let release!: () => void;
      let held!: (pid: number) => void;
      const locked = new Promise<number>(resolve => { held = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const blocker = withExcalidrawSceneTransaction(created.documentId, async transaction => {
        held((await transaction.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
        await gate;
      });
      const blockerPid = await locked;
      const decisionInput = decision === 'accept' ? { decision, expectedCasVersion: pending.casVersion } : { decision };
      const response = reviewExcalidrawOperation({ workspace: await authority(), userId, operationId: pending.operationId,
        ...decisionInput, beforeApply: () => authority() });
      const refused = assert.rejects(response, code('DOCUMENT_REVIEW_DISABLED'));
      try { await waitForBlockedConnection(blockerPid); await reviewEnabled(false); }
      finally { release(); await blocker; }
      await refused;
      assert.equal((await loadExcalidrawScene(created.documentId))?.canonicalHash, before?.canonicalHash);
      const unchanged = await getExcalidrawOperation({ workspace: await authority(), userId, operationId: pending.operationId });
      assert.equal(unchanged.status, 'needs_review'); assert.equal(unchanged.casVersion, pending.casVersion);
      await reviewEnabled(true);
    }
    const callbackRevoked = await pendingReview();
    await assert.rejects(reviewExcalidrawOperation({ workspace: await authority(), userId,
      operationId: callbackRevoked.operationId, decision: 'accept', expectedCasVersion: callbackRevoked.casVersion,
      beforeApply: async () => { await reviewEnabled(false); return authority(); } }), code('DOCUMENT_REVIEW_DISABLED'));
    assert.equal((await getExcalidrawOperation({ workspace: await authority(), userId, operationId: callbackRevoked.operationId })).casVersion,
      callbackRevoked.casVersion, 'A disable during fresh authority cannot mutate the stored review.');
    await reviewEnabled(true);
    const firstReview = await pendingReview();
    const accepted = await reviewExcalidrawOperation({ workspace: await authority(), userId,
      operationId: firstReview.operationId, decision: 'accept', expectedCasVersion: firstReview.casVersion,
      sessionId: 'trusted-session', beforeApply: () => authority() });
    assert.equal(accepted.status, 'applied');
    assert.equal(accepted.checkpoint.status, 'saved', 'Accept must checkpoint a closed editor.');
    const bytes = await fs.readFile(path.join(workspace.rootPath, created.path));
    assert.equal(JSON.parse(bytes.toString()).elements.find((element: { id: string }) => element.id === 'target').x, 500);
    const collaboration = await readFileCollaborationState({ workspace, path: created.path });
    assert(collaboration.lineageId && accepted.checkpoint.revisionId);
    const version = await fileVersionContentStore.readRevisionContent({ workspaceId: workspace.workspaceId,
      lineageId: collaboration.lineageId, revisionId: accepted.checkpoint.revisionId });
    assert.deepEqual(version?.content, bytes, 'Headless acceptance retains its actual checkpoint bytes.');

    for (const decision of ['reject', 'cancel'] as const) {
      const pending = await pendingReview();
      const snapshot = await reviewExcalidrawOperation({ workspace: await authority(), userId, operationId: pending.operationId,
        decision, beforeApply: () => authority() });
      assert.equal(snapshot.status, decision === 'reject' ? 'rejected' : 'cancelled');
      assert.equal((await getExcalidrawOperation({ workspace: await authority(), userId, operationId: pending.operationId })).status, snapshot.status);
    }

    const revokedReview = await pendingReview();
    let releaseScene!: () => void;
    let markSceneHeld!: (pid: number) => void;
    const sceneHeld = new Promise<number>(resolve => { markSceneHeld = resolve; });
    const sceneGate = new Promise<void>(resolve => { releaseScene = resolve; });
    const sceneBlocker = withExcalidrawSceneTransaction(created.documentId, async transaction => {
      const row = await transaction.get('SELECT pg_backend_pid() AS pid') as { pid: number };
      markSceneHeld(row.pid); await sceneGate;
    });
    const sceneBlockerPid = await sceneHeld;
    let freshCalls = 0;
    const revoked = reviewExcalidrawOperation({ workspace: await authority(), userId, operationId: revokedReview.operationId,
      decision: 'accept', expectedCasVersion: revokedReview.casVersion,
      beforeApply: async () => { freshCalls += 1; return authority(); } });
    const denied = assert.rejects(revoked, code('EXCALIDRAW_PERMISSION_DENIED'));
    await waitForBlockedConnection(sceneBlockerPid);
    assert.equal(freshCalls, 0, 'Authority must be refreshed after waiting for the scene lock.');
    await execute('UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id=$2', [workspace.workspaceId, userId]);
    releaseScene(); await sceneBlocker; await denied;
    assert.equal(freshCalls, 1);
    await execute('UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id=$2', [workspace.workspaceId, userId]);
    assert.equal((await getExcalidrawOperation({ workspace: await authority(), userId, operationId: revokedReview.operationId })).status, 'needs_review');

    const managerWorkspace = await authority(managerId);
    const rowBlocker = await openDb();
    try {
      await rowBlocker.run('BEGIN');
      const row = await rowBlocker.get('SELECT pg_backend_pid() AS pid') as { pid: number };
      await rowBlocker.get('SELECT operation_id FROM collaboration_excalidraw_agent_operations WHERE operation_id=$1 FOR UPDATE', [revokedReview.operationId]);
      let managerCalls = 0;
      const revokedManager = reviewExcalidrawOperation({ workspace: managerWorkspace, userId: managerId,
        operationId: revokedReview.operationId, decision: 'accept', expectedCasVersion: revokedReview.casVersion,
        beforeApply: async () => { managerCalls += 1; return authority(managerId); } });
      const managerDenied = assert.rejects(revokedManager, code('EXCALIDRAW_OPERATION_NOT_FOUND'));
      await waitForBlockedConnection(row.pid);
      assert.equal(managerCalls, 0, 'Actor/manager authority must be refreshed after the operation row lock too.');
      await execute('UPDATE canvas_workspace_members SET can_manage=0 WHERE workspace_id=$1 AND user_id=$2', [workspace.workspaceId, managerId]);
      await rowBlocker.run('COMMIT'); await managerDenied;
      assert.equal(managerCalls, 1);
    } finally { await rowBlocker.run('ROLLBACK').catch(() => undefined); await rowBlocker.close(); }

    const intervention = await pendingReview();
    const current = await loadExcalidrawScene(created.documentId);
    assert(current);
    const currentTarget = current.elements.find(element => element.id === 'target')!;
    await withExcalidrawSceneTransaction(created.documentId, async transaction => {
      const latest = await loadExcalidrawSceneInTransaction(transaction, created.documentId, false, true);
      assert(latest);
      await applyExcalidrawScenePatchInTransaction(transaction, { documentId: created.documentId, lifecycleGeneration: 1,
        baseSequence: latest.sceneSequence, messageId: randomUUID(), actorType: 'user', actorId: userId,
        elements: [{ ...currentTarget, version: currentTarget.version + 1, versionNonce: 101, x: 700 }] });
    });
    const stillReview = await reviewExcalidrawOperation({ workspace: await authority(), userId,
      operationId: intervention.operationId, decision: 'accept', expectedCasVersion: intervention.casVersion, beforeApply: () => authority() });
    assert.equal(stillReview.status, 'needs_review');
    assert(stillReview.reviewHint && stillReview.documentUrl.includes(created.path));
    assert.equal((await loadExcalidrawScene(created.documentId))?.elements.find(element => element.id === 'target')?.x, 700);
    const interventionSequence = stillReview.sceneSequence;
    assert(stillReview.casVersion > intervention.casVersion);
    await assert.rejects(reviewExcalidrawOperation({ workspace: await authority(), userId,
      operationId: intervention.operationId, decision: 'accept', expectedCasVersion: intervention.casVersion,
      beforeApply: () => authority() }), code('EXCALIDRAW_REVIEW_STALE'),
    'Identical acceptance retries cannot approve newly refreshed targets that were never displayed.');
    assert.equal((await loadExcalidrawScene(created.documentId))?.sceneSequence, interventionSequence);
    const currentReview = await getExcalidrawOperation({ workspace: await authority(), userId, operationId: intervention.operationId });
    assert.equal(currentReview.status, 'needs_review');
    assert.equal(currentReview.casVersion, stillReview.casVersion);
    const freshlyAccepted = await reviewExcalidrawOperation({ workspace: await authority(), userId,
      operationId: intervention.operationId, decision: 'accept', expectedCasVersion: currentReview.casVersion,
      beforeApply: () => authority() });
    assert.equal(freshlyAccepted.status, 'applied');
    assert.equal(freshlyAccepted.sceneSequence, interventionSequence + 1);
    const acknowledged = await reviewExcalidrawOperation({ workspace: await authority(), userId,
      operationId: intervention.operationId, decision: 'accept', expectedCasVersion: intervention.casVersion,
      beforeApply: () => authority() });
    assert.equal(acknowledged.status, 'applied');
    assert.equal(acknowledged.sceneSequence, freshlyAccepted.sceneSequence, 'Already applied retries return status without applying again.');

    const failedCheckpoint = await pendingReview();
    const externalBytes = Buffer.concat([await fs.readFile(path.join(workspace.rootPath, created.path)), Buffer.from('\n\n')]);
    await fs.writeFile(path.join(workspace.rootPath, created.path), externalBytes);
    const appliedWithFailure = await reviewExcalidrawOperation({ workspace: await authority(), userId,
      operationId: failedCheckpoint.operationId, decision: 'accept', expectedCasVersion: failedCheckpoint.casVersion,
      beforeApply: () => authority() });
    assert.equal(appliedWithFailure.status, 'applied', 'Checkpoint publication failure cannot roll back a committed scene operation.');
    assert.equal(appliedWithFailure.checkpoint.status, 'failed');
    assert.deepEqual(await fs.readFile(path.join(workspace.rootPath, created.path)), externalBytes);
    const retrieved = await getExcalidrawOperation({ workspace: await authority(), userId, operationId: failedCheckpoint.operationId,
      beforeRead: () => authority() });
    assert.equal(retrieved.status, 'applied'); assert.equal(retrieved.checkpoint.status, 'failed');
    assert((await listExcalidrawOperations({ workspace: await authority(), userId, documentId: created.documentId,
      beforeRead: () => authority() })).some(operation => operation.operationId === failedCheckpoint.operationId && operation.checkpoint.status === 'failed'));
    const staleReadWorkspace = await authority();
    await execute('UPDATE canvas_workspace_members SET can_read=0 WHERE workspace_id=$1 AND user_id=$2', [workspace.workspaceId, userId]);
    await assert.rejects(getExcalidrawOperation({ workspace: staleReadWorkspace, userId,
      operationId: failedCheckpoint.operationId, beforeRead: () => authority() }), code('EXCALIDRAW_PERMISSION_DENIED'));
    console.log('Excalidraw default-off review gate, disabled cancellation, flag revocation under locks, closed review/history, actual status, permission revocation and renewed intervention verified.');
  } finally {
    await fs.rm(policyPath, { force: true });
    await execute("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [workspace.workspaceId]);
    await fs.rm(workspace.rootPath, { recursive: true, force: true });
  }
}

main().finally(() => closeDatabaseConnections()).catch(error => { console.error(error); process.exitCode = 1; });
