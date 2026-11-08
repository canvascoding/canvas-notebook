import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

async function main() {
  process.env.FILE_VERSION_CENTER_MODE = 'off';
  await withNativeCopyMetadataOwnerFixture(async fixture => {
    const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { executeWorkspaceOperationOriginalDelete } = await import('../app/lib/files/workspace-operation-original-delete');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { withWorkspaceOperationJobClaimScheduling } = await import('../app/lib/files/workspace-operation-job-phase-scheduling');
    const store = new WorkspaceOperationBatchStore();
    const workspaceId = fixture.source.workspaceId;
    await fixture.admin.query("UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'");
    await fixture.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [workspaceId]);
    const member = (await fixture.admin.query('SELECT id,email,role FROM "user" WHERE id=\'member\'')).rows[0];
    for (const mode of ['release', 'revoke', 'hold'] as const) {
      // The revoked job keeps its recovery evidence and admission reservation.
      // Exercise prolonged contention in a different, independent workspace.
      const selectedWorkspaceId = mode === 'hold' ? fixture.destination.workspaceId : workspaceId;
      const workspace = await readPostgresWorkspaceForActorOnConnection(fixture.connection, resolveWorkspaceActor(member), selectedWorkspaceId);
      assert(workspace?.permissions.canDelete && workspace.permissions.canWrite);
      const sourcePath = `delete-admission-${mode}-${randomUUID()}.json`;
      const filename = path.join(workspace.rootPath, sourcePath);
      const bytes = Buffer.from('{"original":true}\n');
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      const plan = await buildWorkspaceOperationBatchPlan({ scope: { workspace, fileOptions: { workspace } },
        actions: [{ reviewId: randomUUID(), kind: 'delete', selections: [{ sourcePath }] }] });
      assert.equal(plan.version, 5);
      assert.equal(plan.readiness, 'ready');
      const batchId = randomUUID();
      await store.createDirect({ batchId, plan, authorization: { mode: 'direct', actorType: 'user', actorUserId: 'member',
        actorId: 'member', actorDisplayName: 'Delete admission fixture', requestHash: createHash('sha256').update(batchId).digest('hex'),
        jobScope: captureWorkspaceOperationJobScope(workspace) } });
      const batch = await store.claim(randomUUID());
      assert.equal(batch?.batchId, batchId);
      assert(batch);
      let intentOwner: PoolClient | undefined;
      let held = false, acquired = false, rollbacks = 0, resumes = 0, pauses = 0;
      const evidence = async () => (await fixture.admin.query(`SELECT
        (SELECT count(*)::int FROM workspace_file_operation_delete_intents WHERE batch_id=$1) AS intents,
        (SELECT count(*)::int FROM workspace_file_operation_delete_receipts WHERE batch_id=$1) AS receipts,
        (SELECT count(*)::int FROM workspace_file_operation_delete_trash_receipts WHERE batch_id=$1) AS trash`, [batchId])).rows[0];
      try {
        const execution = fixture.withProbe(async event => {
          const sql = event.text.trim();
          if (/^INSERT INTO\s+\S*workspace_file_operation_delete_intents\b/iu.test(sql) && event.values[0] === batchId) {
            assert.equal(intentOwner, undefined, 'The original durable intent must be written once');
            intentOwner = event.client;
          }
          if (event.client !== intentOwner) return;
          if (/^COMMIT$/iu.test(sql) && !acquired) {
            await fixture.admin.query('BEGIN');
            held = true;
            const lock = await fixture.admin.query("SELECT organization_id FROM canvas_organization_settings WHERE organization_id='principal-org' FOR NO KEY UPDATE NOWAIT");
            assert.equal(lock.rowCount, 1);
            acquired = true;
          }
          if (!held || !/^ROLLBACK$/iu.test(sql)) return;
          rollbacks++;
          assert.deepEqual(await readFile(filename), bytes);
          assert.deepEqual(await evidence(), { intents: 1, receipts: 0, trash: 0 });
          if (mode === 'hold') return;
          if (mode === 'revoke') await fixture.admin.query('UPDATE "user" SET banned=1 WHERE id=\'member\'');
          await fixture.admin.query('COMMIT');
          held = false;
        }, () => store.withClaim(batch, async claim => {
          const result = await withWorkspaceOperationJobClaimScheduling(claim, {
            pauseAndDrain: async () => { pauses++; }, resume: async () => { resumes++; },
          }, () => executeWorkspaceOperationOriginalDelete(claim));
          const finished = await store.finishClaim(batch, { status: 'applied', phase: 'complete', completedActions: 1, trashEntryIds: [result.trashEntryId] });
          assert.equal(finished?.status, 'applied');
          return result;
        }));
        if (mode === 'release') {
          const result = await execution;
          assert.equal(rollbacks, 1);
          await assert.rejects(readFile(filename), { code: 'ENOENT' });
          assert.deepEqual(await readFile(path.join(fixture.dataRoot, result.physical.original.trashRelativePath)), bytes);
          assert.deepEqual(await evidence(), { intents: 1, receipts: 1, trash: 1 });
        } else {
          const expected = mode === 'hold' ? ['PRINCIPAL_BUSY'] : ['PRINCIPAL_ACCESS_DENIED', 'PRINCIPAL_AUTH_REVOKED'];
          await assert.rejects(execution, error => expected.includes((error as { code?: string })?.code ?? ''));
          assert.equal(rollbacks, mode === 'hold' ? 4 : 1);
          assert.deepEqual(await readFile(filename), bytes);
          assert.deepEqual(await evidence(), { intents: 1, receipts: 0, trash: 0 });
          await store.finishClaim(batch, { status: 'needs_recovery', phase: 'recovery', errorCode: expected[0] });
        }
        assert(acquired && resumes > 0 && pauses > resumes);
        console.log(`Physical Delete policy admission passed: ${mode}; ${rollbacks} rolled-back admission attempts.`);
      } finally {
        if (held) await fixture.admin.query('ROLLBACK');
        if (mode === 'revoke') await fixture.admin.query('UPDATE "user" SET banned=0 WHERE id=\'member\'');
      }
    }
  });
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
