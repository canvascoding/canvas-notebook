import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApiKeyWorkspacePathPrincipal, ApiKeyWorkspacePathPurpose } from '../app/lib/api-keys/document-read-principal';
import type { NativeFileOperationReceipt } from '../app/lib/markdown/native-file-operation-handoff';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let stage = 'setup', groups = 0;
const errorCode = (error: unknown): string | undefined => {
  const value = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof value === 'string' && /^[A-Z0-9_]{1,128}$/u.test(value) ? value : undefined;
};
const absent = async (file: string) => assert.rejects(fs.lstat(file), error => errorCode(error) === 'ENOENT');
async function main() {
  process.env.FILE_VERSION_CENTER_MODE = 'off';
  process.env.BASE_URL = 'http://localhost';
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { resolveFileVersionRolloutV1 } = await import('../app/lib/file-version-center/policy-v1');
    assert.equal(resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE).capture, false);
    assert.equal((await import('../app/lib/files/workspace-file-undo-policy')).WORKSPACE_FILE_UNDO_ENABLED, false);
    await h.admin.query("UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'");
    await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [h.source.workspaceId]);
    const { createApiIntegration } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspacePathPrincipal: capture, withApiKeyWorkspacePathPrincipalOnConnection: phase } =
      await import('../app/lib/api-keys/document-read-principal');
    const { captureWorkspaceOperationApiKeyJobPrincipal: holder } = await import('../app/lib/workspaces/workspace-operation-api-key-job-principal');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { advanceWorkspaceOperationNativePathAdmission } = await import('../app/lib/files/workspace-operation-native-path-admission');
    const { executeWorkspaceOperationOriginalMove } = await import('../app/lib/files/workspace-operation-original-move-runner');
    const { openDb } = await import('../app/lib/db');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: links } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const workspaceId = h.source.workspaceId;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Actual native path owner', workspaceIds: [workspaceId],
      actions: ['move', 'delete', 'status', 'recover'], expiresAt: Date.now() + 3_600_000 });
    const store = new WorkspaceOperationBatchStore();
    const run = async <T>(purpose: ApiKeyWorkspacePathPurpose, consume: (principal: ApiKeyWorkspacePathPrincipal) => Promise<T>) => {
      const credential = await authenticateApiKeyRequest(new Request('http://localhost/api/documents/move', { headers: { 'X-Canvas-API-Key': issued.key } }));
      return capture(credential, { workspaceId, purpose, source: 'request' }, consume);
    };
    const scope = async (principal: ApiKeyWorkspacePathPrincipal, purpose: ApiKeyWorkspacePathPurpose) => {
      const db = await openDb(); let failure: Error | undefined;
      try {
        await db.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        const result = await phase(db, principal, purpose, async access => {
          await access.assertCurrent(); return { workspace: access.workspace, fileOptions: { workspace: access.workspace } };
        });
        await db.run('COMMIT'); return result;
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Current key scope failed.');
        try { await db.run('ROLLBACK'); } catch (rollback) { failure = new AggregateError([failure, rollback]); }
        throw failure;
      } finally { await db.close(failure); }
    };
    for (const missingProjection of [false, true]) {
      const label = missingProjection ? 'native Move without physical projection' : 'native Move with physical projection'; stage = label;
      const prefix = `key-native-${randomUUID()}`, sourcePath = `${prefix}.md`, destinationPath = `${prefix}-moved.md`, incomingPath = `${prefix}-incoming.md`;
      const target = await h.upload(sourcePath, Buffer.from('# Original key target\n\nPreserve the real native content.\n'));
      const incoming = await h.upload(incomingPath, Buffer.from(`[Target](${sourcePath}) [Web](https://example.test/keep)\n`));
      const title = `Native ${prefix}`; await h.metadata(h.source, sourcePath, { title, isFavorite: true, pinned: true }, 'member');
      stage = `${label}: seed personal metadata`;
      const personalBefore = (await h.admin.query('SELECT is_favorite,pinned_at FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2 AND user_id=\'member\'', [workspaceId, sourcePath])).rows;
      assert.equal(personalBefore.length, 1); assert.equal(Number(personalBefore[0].is_favorite), 1); assert(personalBefore[0].pinned_at !== null);
      const before = await load(h.connection, target.documentId), incomingBefore = await load(h.connection, incoming.documentId); assert(before && incomingBefore);
      const registryBefore = (await h.admin.query('SELECT id,lineage_id FROM collaboration_documents WHERE id=$1', [target.documentId])).rows[0]; assert(registryBefore);
      const bytes = await fs.readFile(path.join(h.source.rootPath, sourcePath));
      if (missingProjection) await fs.unlink(path.join(h.source.rootPath, sourcePath));
      const receiptsBefore = Number((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_native_file_operation_receipts')).rows[0].n);
      const plan = await run('move_preview', async principal => buildWorkspaceOperationBatchPlan({ scope: await scope(principal, 'move_preview'),
        actions: [{ reviewId: randomUUID(), kind: 'move', selections: [{ sourcePath, destinationPath }] }] }));
      assert(plan.version === 3); assert.equal(plan.readiness, 'ready');
      let pathCommits = 0;
      stage = `${label}: execute`;
      const applied = await run('move_apply', async principal => {
        const selected = await scope(principal, 'move_apply'), result = await store.createApiKeyMoveAndClaim(principal, { operationId: randomUUID(), plan });
        assert(result.kind === 'claimed'); const batch = result.batch; assert(batch.authorization.mode === 'api-key');
        const original = batch.authorization; assert.equal(original.actorSessionId, null); assert.equal(original.credentialId, issued.credential.id);
        return store.withClaim(batch, async claim => {
          const apiKeyPrincipal = holder({ transport: 'api-key', kind: 'move', purpose: 'move_apply', principal });
          assert.equal((await advanceWorkspaceOperationNativePathAdmission(claim, { apiKeyPrincipal })).status, 'ready');
          const completion = await executeWorkspaceOperationOriginalMove({ claim, workspace: selected.workspace, apiKeyPrincipal,
            onPathCommitted: async () => { pathCommits++; } });
          stage = `${label}: completion receipts`;
          assert.equal(completion.batchId, batch.batchId); assert.equal(completion.planId, plan.planId);
          assert(completion.native); assert.equal(completion.pathReceipts.length, 1);
          const finished = await store.finishClaim(batch, { status: 'applied', completedActions: 1, phase: 'complete' });
          assert(finished); assert.equal(finished.status, 'applied'); assert.deepEqual(finished.authorization, original);
          return { batchId: batch.batchId, actorId: original.actorId, native: completion.native };
        });
      });
      stage = `${label}: path progress`;
      assert.equal(pathCommits, 1); await absent(path.join(h.source.rootPath, sourcePath));
      const after = await load(h.connection, target.documentId), incomingAfter = await load(h.connection, incoming.documentId); assert(after && incomingAfter);
      assert.equal(after.path, destinationPath); assert.equal(after.lifecycleGeneration, before.lifecycleGeneration);
      assert.deepEqual(Buffer.from(after.yjsState), Buffer.from(before.yjsState)); assert.deepEqual(Buffer.from(after.stateVector), Buffer.from(before.stateVector));
      stage = `${label}: incoming native change`;
      assert.equal(incomingAfter.documentSequence, incomingBefore.documentSequence + 1);
      const inventory = links(incomingAfter); assert(inventory.links.some(link => link.targetPathText === destinationPath));
      assert.equal(inventory.links.some(link => link.targetPathText === sourcePath), false);
      assert(JSON.stringify(authoritativeNativeCollaborationSnapshot(incomingAfter).content).includes('https://example.test/keep'));
      const registryAfter = (await h.admin.query('SELECT id,lineage_id,path,status FROM collaboration_documents WHERE id=$1', [target.documentId])).rows[0];
      assert.equal(registryAfter.id, registryBefore.id); assert.equal(registryAfter.lineage_id, registryBefore.lineage_id);
      assert.equal(registryAfter.path, destinationPath); assert.equal(registryAfter.status, 'active');
      assert.deepEqual((await h.admin.query('SELECT path,status FROM file_collaboration_lineages WHERE id=$1', [registryBefore.lineage_id])).rows, [{ path: destinationPath, status: 'active' }]);
      if (missingProjection) await absent(path.join(h.source.rootPath, destinationPath));
      else assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, destinationPath)), bytes);
      assert.deepEqual((await h.admin.query('SELECT title FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [workspaceId, destinationPath])).rows, [{ title }]);
      stage = `${label}: moved personal metadata`;
      const personal = (await h.admin.query('SELECT is_favorite,pinned_at FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2 AND user_id=\'member\'', [workspaceId, destinationPath])).rows;
      assert.equal(personal.length, 1); assert.equal(Number(personal[0].is_favorite), 1); assert(personal[0].pinned_at !== null);
      stage = `${label}: native Move and link receipts`;
      const receiptRows = (await h.admin.query('SELECT mutation_id,document_id,request_id,changes_bundle_proof,receipt_text,receipt_digest FROM collaboration_native_file_operation_receipts WHERE operation_id=$1 ORDER BY mutation_id COLLATE "C"', [applied.native.operationId])).rows;
      assert.equal(receiptRows.length, 2);
      assert.equal(Number((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_native_file_operation_receipts')).rows[0].n), receiptsBefore + 2);
      assert.deepEqual(receiptRows.map(row => ({ mutationId: row.mutation_id, receiptDigest: row.receipt_digest })),
        [...applied.native.receipts].sort((left, right) => left.mutationId < right.mutationId ? -1 : left.mutationId > right.mutationId ? 1 : 0));
      const nativeReceipts = receiptRows.map(row => {
        assert.equal(row.request_id, applied.native.requestId); assert.equal(row.changes_bundle_proof, applied.native.changesBundleProof);
        assert.equal(row.receipt_digest, createHash('sha256').update(row.receipt_text).digest('hex'));
        const receipt = JSON.parse(row.receipt_text) as NativeFileOperationReceipt;
        assert.equal(receipt.operationId, applied.native.operationId); assert.equal(receipt.source.documentId, row.document_id);
        assert.equal(receipt.actor.actorId, applied.actorId); assert.equal(receipt.actor.actorSessionId, null); assert.equal(receipt.action, 'move');
        return receipt;
      });
      assert.deepEqual(nativeReceipts.map(receipt => receipt.kind).sort(), ['link', 'move']);
      assert.equal(nativeReceipts.find(receipt => receipt.kind === 'move')?.source.documentId, target.documentId);
      assert.equal(nativeReceipts.find(receipt => receipt.kind === 'link')?.source.documentId, incoming.documentId);
      assert.equal(Number((await h.admin.query('SELECT count(*)::int AS n FROM agents WHERE agent_id=$1', [applied.actorId])).rows[0].n), 0);
      assert.equal(Number((await h.admin.query('SELECT count(*)::int AS n FROM pi_sessions WHERE agent_id=$1', [applied.actorId])).rows[0].n), 0);
      groups++; console.log(`API-key native path owner passed: ${stage}; real native Move, one incoming mutation, stable D/L/Yjs and no PI actor with review rollout off`);
    }
  });
  console.log(`API-key native path owners: ${groups} actual Move groups passed; Delete, status/recovery/public adapters and installed SDK remain separate.`);
}
function describe(error: unknown, depth = 0): unknown {
  if (!error || typeof error !== 'object' || depth > 3) return undefined;
  const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
  return { name: error instanceof Error ? error.name : 'UnknownError', code: errorCode(error), cause: describe(cause, depth + 1),
    errors: error instanceof AggregateError ? error.errors.slice(0, 3).map(item => describe(item, depth + 1)) : undefined,
    assertion: error instanceof assert.AssertionError ? { operator: error.operator, actual: typeof error.actual === 'number' || typeof error.actual === 'boolean' ? error.actual : typeof error.actual,
      expected: typeof error.expected === 'number' || typeof error.expected === 'boolean' ? error.expected : typeof error.expected } : undefined };
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-native-path-owner', stage, error: describe(error),
  stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s*at\b/u.test(line)).slice(0, 5) : [] })); process.exitCode = 1; });
