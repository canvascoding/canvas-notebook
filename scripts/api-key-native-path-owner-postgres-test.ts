import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApiKeyWorkspacePathPrincipal, ApiKeyWorkspacePathPurpose } from '../app/lib/api-keys/document-read-principal';
import type { NativeFileOperationReceipt } from '../app/lib/markdown/native-file-operation-handoff';
import type { WorkspaceOperationDeleteBatchPlan, WorkspaceOperationBatchProgress } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceOperationCohortDeletePlan } from '../app/lib/files/workspace-operation-cohort-delete-plan';
import type { CohortDeleteResult } from '../app/lib/files/workspace-operation-cohort-delete-evidence';
import type { WorkspaceOperationNativeMoveBatchPlan } from '../app/lib/files/workspace-operation-native-move-plan';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
type OwnerPlan = WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationDeleteBatchPlan | WorkspaceOperationCohortDeletePlan;

let stage = 'setup', groups = 0;
const errorCode = (error: unknown): string | undefined => {
  const value = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof value === 'string' && /^[A-Z0-9_]{1,128}$/u.test(value) ? value : undefined;
};
const absent = async (file: string) => assert.rejects(fs.lstat(file), error => errorCode(error) === 'ENOENT');
function linkHrefs(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const node = value as { marks?: unknown; content?: unknown }, result: string[] = [];
  if (Array.isArray(node.marks)) for (const mark of node.marks) {
    if (mark && typeof mark === 'object' && mark.type === 'link' && typeof mark.attrs?.href === 'string') result.push(mark.attrs.href);
  }
  if (Array.isArray(node.content)) for (const child of node.content) result.push(...linkHrefs(child));
  return result;
}
async function main() {
  process.env.FILE_VERSION_CENTER_MODE = 'off';
  process.env.BASE_URL = 'http://localhost';
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { resolveFileVersionRolloutV1 } = await import('../app/lib/file-version-center/policy-v1');
    assert.equal(resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE).capture, false);
    assert.equal((await import('../app/lib/files/workspace-file-undo-policy')).WORKSPACE_FILE_UNDO_ENABLED, false);
    await h.admin.query("UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'");
    await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [h.source.workspaceId]);
    const { createApiIntegration, updateApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspacePathPrincipal: capture, withApiKeyWorkspacePathPrincipalOnConnection: phase } =
      await import('../app/lib/api-keys/document-read-principal');
    const { captureWorkspaceOperationApiKeyJobPrincipal: holder, captureWorkspaceOperationApiKeyJobReadPrincipal: readHolder } = await import('../app/lib/workspaces/workspace-operation-api-key-job-principal');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { executeWorkspaceOperationBatch } = await import('../app/lib/files/workspace-operation-batch-executor');
    const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { advanceWorkspaceOperationNativePathAdmission } = await import('../app/lib/files/workspace-operation-native-path-admission');
    const { executeWorkspaceOperationOriginalMove } = await import('../app/lib/files/workspace-operation-original-move-runner');
    const { executeWorkspaceOperationOriginalDelete } = await import('../app/lib/files/workspace-operation-original-delete');
    const { executeWorkspaceOperationCohortDelete } = await import('../app/lib/files/workspace-operation-cohort-delete-runner');
    const { workspaceOperationBatchTotalActions } = await import('../app/lib/files/workspace-operation-native-delete-effects');
    const { readWorkspaceOperationOriginalDeleteIntentOnConnection: readDeleteIntent } = await import('../app/lib/files/workspace-operation-original-delete-repository');
    const { readWorkspaceOperationNativeMoveBatchStatus: moveStatus } = await import('../app/lib/files/workspace-operation-native-move-status');
    const { readWorkspaceOperationNativeDeleteBatchStatus: deleteStatus } = await import('../app/lib/files/workspace-operation-native-delete-status');
    const { readWorkspaceOperationPhysicalDeleteBatchStatusV5: physicalStatus } = await import('../app/lib/files/workspace-operation-physical-delete-status-v5');
    const { readWorkspaceOperationCohortDeleteStatus: cohortStatus } = await import('../app/lib/files/workspace-operation-cohort-delete-status');
    const { readWorkspaceOperationNativePathStatus: pathStatus } = await import('../app/lib/files/workspace-operation-native-path-status');
    const { openDb } = await import('../app/lib/db');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: links } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const workspaceId = h.source.workspaceId;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Actual native path owner', workspaceIds: [workspaceId],
      actions: ['move', 'delete', 'status', 'recover'], expiresAt: Date.now() + 3_600_000 });
    let activeKey = issued.key, credentialId = issued.credential.id, revision = issued.integration.revision, statusGroups = 0;
    const store = new WorkspaceOperationBatchStore();
    const run = async <T>(purpose: ApiKeyWorkspacePathPurpose, consume: (principal: ApiKeyWorkspacePathPrincipal) => Promise<T>, key = activeKey) => {
      const credential = await authenticateApiKeyRequest(new Request(`http://localhost/api/documents/${purpose.startsWith('delete_') ? 'delete' : 'move'}`, { headers: { 'X-Canvas-API-Key': key } }));
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
    const domainSnapshot = async () => {
      const tables = (await h.admin.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_|workspace_link_|workspace_trash_entries$|file_revisions$|file_revision_contents$|file_version_blobs$)' ORDER BY c.relname`, [h.schema])).rows;
      const result: Record<string, unknown> = {};
      for (const { relname } of tables) {
        assert(/^[a-z][a-z0-9_]*$/u.test(relname));
        result[relname] = (await h.admin.query(`SELECT to_jsonb(t)::text AS data,xmin::text AS row_xmin FROM "${h.schema}"."${relname}" t ORDER BY data,row_xmin`)).rows;
      }
      return result;
    };
    const samples = new Map<number, { plan: OwnerPlan; batchId: string }>();
    const operationIds = new Map<string, string>();
    const readStatus = async (plan: OwnerPlan, input: Omit<Parameters<typeof moveStatus>[0], 'expectedPlan'>) => {
      assert([2, 3, 5, 6].includes(plan.version));
      return plan.version === 3 ? moveStatus({ ...input, expectedPlan: plan })
        : plan.version === 6 ? cohortStatus({ ...input, expectedPlan: plan })
        : plan.version === 5 ? physicalStatus({ ...input, expectedPlan: plan }) : deleteStatus({ ...input, expectedPlan: plan });
    };
    const verifyStatus = async (plan: OwnerPlan, batchId: string,
      purposeOverride?: 'move_apply' | 'move_recover' | 'delete_apply' | 'delete_recover') => {
      assert([2, 3, 5, 6].includes(plan.version)); const kind = plan.version === 3 ? 'move' : 'delete';
      const purpose = purposeOverride ?? (kind === 'move' ? 'move_status' : 'delete_status');
      const expected = await store.get(batchId); assert(expected); const before = await domainSnapshot();
      const operationId = operationIds.get(batchId); assert(operationId);
      let reference: Awaited<ReturnType<typeof readStatus>> | undefined;
      for (const mode of ['numeric', 'family-scoped', 'family-operation'] as const) {
        const active = new Set<object>(); let snapshots = 0, authorizations = 0, statements = 0;
        await run(purpose, async principal => {
          const apiKeyPrincipal = readHolder({ transport: 'api-key', kind, purpose, principal });
          if (purpose.endsWith('_status')) assert.throws(() => holder(apiKeyPrincipal), error => errorCode(error) === 'API_KEY_JOB_PRINCIPAL_INVALID');
          const selected = mode === 'family-operation' ? undefined : await scope(principal, purpose);
          await h.withProbe(async event => {
            statements++; const sql = event.text.trim();
            if (/^BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE$/iu.test(sql)) authorizations++;
            if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/iu.test(sql)) {
              assert.equal(active.has(event.client), false); active.add(event.client);
              const facts = (await event.raw("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation")).rows[0];
              assert.deepEqual(facts, { readonly: 'on', isolation: 'repeatable read' });
            }
            if (active.has(event.client)) {
              assert.equal(/^\s*(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/iu.test(sql), false);
              assert.equal(/\b(?:pg_notify|NOTIFY)\b/iu.test(sql), false);
              if (/^(?:COMMIT|ROLLBACK)$/iu.test(sql)) { assert(/^COMMIT$/iu.test(sql)); active.delete(event.client); snapshots++; }
            }
          }, async () => {
            let result: Awaited<ReturnType<typeof readStatus>>;
            if (mode === 'numeric') result = await readStatus(plan, { batchId, scope: selected!, apiKeyPrincipal });
            else {
              const observed = await pathStatus(mode === 'family-operation' ? { workspaceId, operationId, apiKeyPrincipal }
                : { batchId, scope: selected!, apiKeyPrincipal }); assert(observed);
              assert.equal(observed.status.kind, plan.version === 3 ? 'move' : plan.version === 6 ? 'cohort-delete' : 'delete');
              assert.equal(observed.scope.workspace.workspaceId, workspaceId);
              assert.equal(observed.scope.fileOptions.workspace, observed.scope.workspace);
              result = observed.status.value;
            }
            assert(result); assert.equal(result.batch.status, 'applied'); assert.deepEqual(result.batch, expected); assert.equal(result.plan.planId, plan.planId);
            if (reference) assert.deepEqual(result, reference); else reference = result;
          });
        });
        assert.equal(snapshots, 1); assert.equal(authorizations, 2); assert.equal(active.size, 0);
        assert.deepEqual(await domainSnapshot(), before);
        console.log(JSON.stringify({ suite: 'api-key-native-path-status-profile', mode, version: plan.version, purpose, snapshots, authorizations, statements }));
      }
      if (!samples.has(plan.version)) samples.set(plan.version, { plan, batchId });
    };
    const applyDelete = async (plan: WorkspaceOperationDeleteBatchPlan | WorkspaceOperationCohortDeletePlan) => {
      const operationId = randomUUID();
      const applied = await run('delete_apply', async principal => {
        const selected = await scope(principal, 'delete_apply'), result = await store.createApiKeyDeleteAndClaim(principal, { operationId, plan });
        assert(result.kind === 'claimed'); const batch = result.batch; assert(batch.authorization.mode === 'api-key');
        const original = batch.authorization; assert.equal(original.actorSessionId, null); assert.equal(original.kind, 'delete');
        return store.withClaim(batch, async claim => {
          const apiKeyPrincipal = holder({ transport: 'api-key', kind: 'delete', purpose: 'delete_apply', principal });
          assert.equal((await advanceWorkspaceOperationNativePathAdmission(claim, { apiKeyPrincipal })).status, 'ready');
          const invoke = () => plan.version === 6
            ? executeWorkspaceOperationCohortDelete({ claim, workspace: selected.workspace, apiKeyPrincipal })
            : executeWorkspaceOperationOriginalDelete(claim, undefined, apiKeyPrincipal);
          const outcome = await executeWorkspaceOperationBatch({ batchId: batch.batchId, plan, scope: selected, jobClaim: claim,
            actorUserId: original.actorUserId, actorDisplayName: original.actorDisplayName,
            actorId: original.actorId, actorType: original.actorType, apiKeyPrincipal,
            onProgress: async progress => { assert(await store.heartbeatClaim(batch, progress)); } });
          assert.equal(outcome.status, 'applied'); assert.equal(outcome.completedActions, workspaceOperationBatchTotalActions(plan));
          const completion = await invoke();
          stage += ': completed history'; assert.deepEqual(await invoke(), completion);
          const trashEntryIds = 'kind' in completion ? completion.physical.map(item => item.receipt.original.trashEntryId) : [completion.trashEntryId];
          assert.deepEqual(outcome.trashEntryIds, trashEntryIds);
          const finished = await store.finishClaim(batch, { status: 'applied', completedActions: outcome.completedActions, trashEntryIds: outcome.trashEntryIds, phase: 'complete' });
          assert(finished); assert.equal(finished.status, 'applied'); assert.deepEqual(finished.authorization, original);
          const intent = await readDeleteIntent(h.connection, { schema: h.schema, batchId: batch.batchId }); assert(intent);
          assert.equal(intent.requestHash, original.requestHash); assert.equal(intent.intentText.includes(issued.key), false);
          const data = JSON.parse(intent.intentText); assert.equal(data.actor.actorId, original.actorId); assert.equal(data.actor.actorSessionId, null);
          assert.equal(data.actor.userId, 'member');
          assert.equal(Number((await h.admin.query('SELECT count(*)::int AS n FROM agents WHERE agent_id=$1', [original.actorId])).rows[0].n), 0);
          assert.equal(Number((await h.admin.query('SELECT count(*)::int AS n FROM pi_sessions WHERE agent_id=$1', [original.actorId])).rows[0].n), 0);
          return { batchId: batch.batchId, completion, original, intent };
        });
      });
      await run('delete_recover', async principal => {
        const recovered = await store.claimExistingApiKeyPath(principal, 'delete_recover', { operationId, workspaceId, planId: plan.planId });
        assert(recovered.kind === 'historical-header'); assert.equal(recovered.batch.batchId, applied.batchId);
        assert.deepEqual(recovered.batch.authorization, applied.original); assert.equal(recovered.batch.status, 'applied');
      });
      operationIds.set(applied.batchId, operationId);
      stage += ': pure status'; await verifyStatus(plan, applied.batchId);
      return applied;
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
        const selected = await scope(principal, 'move_apply'), operationId = randomUUID(), result = await store.createApiKeyMoveAndClaim(principal, { operationId, plan });
        assert(result.kind === 'claimed'); const batch = result.batch; assert(batch.authorization.mode === 'api-key');
        operationIds.set(batch.batchId, operationId);
        const original = batch.authorization; assert.equal(original.actorSessionId, null); assert.equal(original.credentialId, issued.credential.id);
        return store.withClaim(batch, async claim => {
          const apiKeyPrincipal = holder({ transport: 'api-key', kind: 'move', purpose: 'move_apply', principal });
          const executorInput = { batchId: batch.batchId, plan, scope: selected, jobClaim: claim,
            actorUserId: original.actorUserId, actorDisplayName: original.actorDisplayName,
            actorId: original.actorId, actorType: original.actorType, apiKeyPrincipal,
            onProgress: async (progress: WorkspaceOperationBatchProgress) => {
              assert(await store.heartbeatClaim(batch, progress));
              if (progress.phase === 'paths') pathCommits++;
            } };
          if (!missingProjection) {
            let queries = 0, touched = false;
            const execute = (input: unknown) => executeWorkspaceOperationBatch(input as Parameters<typeof executeWorkspaceOperationBatch>[0]);
            const before = await domainSnapshot();
            await h.withProbe(async () => { queries++; }, async () => {
              await assert.rejects(execute({ ...executorInput, apiKeyPrincipal: holder({ transport: 'api-key', kind: 'move', purpose: 'move_apply', principal: {} }) }),
                error => errorCode(error) === 'API_KEY_PRINCIPAL_REQUIRED');
              await assert.rejects(execute({ ...executorInput, apiKeyPrincipal: undefined }), /BATCH_API_KEY_AUTHORIZATION_REQUIRED/u);
              await assert.rejects(execute({ ...executorInput, mcpPrincipal: { kind: 'move', principal: {} } }),
                error => errorCode(error) === 'BATCH_CLAIM_CHANGED');
              const accessor = Object.defineProperty({ ...executorInput }, 'apiKeyPrincipal', { enumerable: true,
                get() { touched = true; return {}; } });
              await assert.rejects(execute(accessor), error => errorCode(error) === 'BATCH_CLAIM_CHANGED');
              for (const purpose of ['move_status', 'move_preview']) {
                await assert.rejects(execute({ ...executorInput, apiKeyPrincipal: { transport: 'api-key', kind: 'move', purpose, principal: {} } }),
                  error => errorCode(error) === 'API_KEY_JOB_PRINCIPAL_INVALID');
              }
              await assert.rejects(execute({ ...executorInput, actorSessionId: 'not-a-key-session' }), /BATCH_SCOPE_CHANGED/u);
              await assert.rejects(execute({ ...executorInput, actorId: 'different-actor' }), /BATCH_SCOPE_CHANGED/u);
              await assert.rejects(execute({ ...executorInput, plan: { ...plan, version: 1 } }), /BATCH_API_KEY_NATIVE_PLAN_REQUIRED/u);
              await assert.rejects(execute({ ...executorInput, jobClaim: undefined }), /BATCH_CLAIM_REQUIRED/u);
            });
            assert.equal(queries, 0); assert.equal(touched, false); assert.deepEqual(await domainSnapshot(), before);
            console.log('API-key batch executor preflight: 10 forged/missing/mixed/accessor/purpose/actor/legacy/claim inputs rejected before SQL or domain changes.');
          }
          assert.equal((await advanceWorkspaceOperationNativePathAdmission(claim, { apiKeyPrincipal })).status, 'ready');
          const outcome = await executeWorkspaceOperationBatch(executorInput);
          assert.equal(outcome.status, 'applied'); assert.equal(outcome.completedActions, workspaceOperationBatchTotalActions(plan));
          const completion = await executeWorkspaceOperationOriginalMove({ claim, workspace: selected.workspace, apiKeyPrincipal });
          stage = `${label}: completion receipts`;
          assert.equal(completion.batchId, batch.batchId); assert.equal(completion.planId, plan.planId);
          assert(completion.native); assert.equal(completion.pathReceipts.length, 1);
          const finished = await store.finishClaim(batch, { status: 'applied', completedActions: outcome.completedActions, phase: 'complete' });
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
      const preservedContent = authoritativeNativeCollaborationSnapshot(incomingAfter).content; assert(preservedContent.kind === 'rich_text');
      assert(linkHrefs(preservedContent.document).some(href => href === 'https://example.test/keep'));
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
      stage += ': pure status'; await verifyStatus(plan, applied.batchId);
      groups++; console.log(`API-key native path owner passed: ${stage}; real native Move, one incoming mutation, stable D/L/Yjs and no PI actor with review rollout off`);
    }
    for (const missingProjection of [false, true]) {
      const label = missingProjection ? 'native Delete without physical projection' : 'native Delete with physical projection'; stage = label;
      const sourcePath = `key-delete-${randomUUID()}.md`, incomingPath = `key-delete-incoming-${randomUUID()}.md`;
      const bytes = Buffer.from('# Archived key document\n\nKeep all original native bytes.\n');
      const target = await h.upload(sourcePath, bytes), incoming = await h.upload(incomingPath, Buffer.from(`[Keep label](${sourcePath}) [Web](https://example.test/keep-delete)\n`));
      await h.metadata(h.source, sourcePath, { title: 'Deleted title', isFavorite: true, pinned: true }, 'member');
      const before = await load(h.connection, target.documentId), incomingBefore = await load(h.connection, incoming.documentId); assert(before && incomingBefore);
      const registryBefore = (await h.admin.query('SELECT id,lineage_id FROM collaboration_documents WHERE id=$1', [target.documentId])).rows[0]; assert(registryBefore);
      if (missingProjection) await fs.unlink(path.join(h.source.rootPath, sourcePath));
      const plan = await run('delete_preview', async principal => buildWorkspaceOperationBatchPlan({ scope: await scope(principal, 'delete_preview'),
        actions: [{ reviewId: randomUUID(), kind: 'delete', selections: [{ sourcePath }] }] }));
      assert(plan.version === 2); assert.equal(plan.readiness, 'ready');
      stage = `${label}: execute`;
      const applied = await applyDelete(plan), completion = applied.completion; assert(!('kind' in completion));
      stage = `${label}: archive invariants`; assert(completion.native); assert.equal(completion.nativeLinks?.length, 1);
      await absent(path.join(h.source.rootPath, sourcePath));
      const raw = (await h.admin.query('SELECT status,lifecycle_generation,yjs_state,state_vector FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0]; assert(raw);
      assert.equal(raw.status, 'archived'); assert.equal(Number(raw.lifecycle_generation), before.lifecycleGeneration + 1);
      assert.deepEqual(raw.yjs_state, Buffer.from(before.yjsState)); assert.deepEqual(raw.state_vector, Buffer.from(before.stateVector));
      const registry = (await h.admin.query('SELECT id,lineage_id,path,status FROM collaboration_documents WHERE id=$1', [target.documentId])).rows[0];
      assert.deepEqual(registry, { id: target.documentId, lineage_id: registryBefore.lineage_id, path: sourcePath, status: 'archived' });
      assert.deepEqual((await h.admin.query('SELECT path,status,trash_entry_id FROM file_collaboration_lineages WHERE id=$1', [registryBefore.lineage_id])).rows,
        [{ path: sourcePath, status: 'archived', trash_entry_id: completion.trashEntryId }]);
      stage = `${label}: incoming links`;
      const after = await load(h.connection, incoming.documentId); assert(after); assert.equal(after.documentSequence, incomingBefore.documentSequence + 1);
      assert.equal(links(after).links.some(link => link.targetPathText === sourcePath), false);
      const snapshot = authoritativeNativeCollaborationSnapshot(after), content = JSON.stringify(snapshot.content);
      assert(snapshot.content.kind === 'rich_text');
      assert(content.includes('Keep label')); assert(linkHrefs(snapshot.content.document).some(href => href === 'https://example.test/keep-delete'));
      stage = `${label}: retained Trash`;
      const trash = (await h.admin.query('SELECT status,original_path,deleted_by_user_id,metadata_json FROM workspace_trash_entries WHERE id=$1', [completion.trashEntryId])).rows[0]; assert(trash);
      assert.equal(trash.status, 'trashed'); assert.equal(trash.original_path, sourcePath); assert.equal(trash.deleted_by_user_id, 'member');
      const metadata = JSON.parse(trash.metadata_json); assert.equal(metadata.payloadKind, missingProjection ? 'native_archive' : 'file');
      assert.equal(metadata.nativeDocumentId, target.documentId); assert.equal(metadata.nativeLineageId, registryBefore.lineage_id);
      const payload = path.join(h.dataRoot, completion.physical.original.trashRelativePath);
      if (missingProjection) await absent(payload); else assert.deepEqual(await fs.readFile(payload), bytes);
      assert.equal((await h.admin.query('SELECT path FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [workspaceId, sourcePath])).rows.length, 0);
      assert.equal((await h.admin.query('SELECT path FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2', [workspaceId, sourcePath])).rows.length, 0);
      groups++; console.log(`API-key native path owner passed: ${label}; genuine archive/Trash, stable native bytes and one incoming mutation, completed history without replay`);
    }
    for (const extension of ['pdf', 'png']) {
      const label = `physical ${extension.toUpperCase()} Delete`; stage = label;
      const sourcePath = `key-delete-${randomUUID()}.${extension}`, bytes = Buffer.from(extension === 'pdf' ? '%PDF-1.7\nOriginal key PDF bytes\n' : '\u0089PNG\r\n\u001a\nOriginal key image bytes');
      await fs.writeFile(path.join(h.source.rootPath, sourcePath), bytes, { mode: 0o600, flag: 'wx' });
      const incoming = await h.upload(`key-physical-incoming-${randomUUID()}.md`, Buffer.from(`[Keep file label](${sourcePath}) [Web](https://example.test/keep-physical)\n`));
      const before = await load(h.connection, incoming.documentId); assert(before);
      const plan = await run('delete_preview', async principal => buildWorkspaceOperationBatchPlan({ scope: await scope(principal, 'delete_preview'),
        actions: [{ reviewId: randomUUID(), kind: 'delete', selections: [{ sourcePath }] }] }));
      assert(plan.version === 5); assert.equal(plan.readiness, 'ready');
      stage = `${label}: execute`; const applied = await applyDelete(plan), completion = applied.completion; assert(!('kind' in completion));
      stage = `${label}: retained bytes and incoming links`;
      assert.equal(completion.native, null); assert.equal(completion.nativeLinks?.length, 1); assert(completion.physicalRegistry);
      await absent(path.join(h.source.rootPath, sourcePath));
      assert.deepEqual(await fs.readFile(path.join(h.dataRoot, completion.physical.original.trashRelativePath)), bytes);
      const after = await load(h.connection, incoming.documentId); assert(after); assert.equal(after.documentSequence, before.documentSequence + 1);
      assert.equal(links(after).links.some(link => link.targetPathText === sourcePath), false);
      const snapshot = authoritativeNativeCollaborationSnapshot(after).content; assert(snapshot.kind === 'rich_text');
      assert(linkHrefs(snapshot.document).some(href => href === 'https://example.test/keep-physical'));
      const trash = (await h.admin.query('SELECT status,original_path,metadata_json FROM workspace_trash_entries WHERE id=$1', [completion.trashEntryId])).rows[0];
      assert(trash); assert.equal(trash.status, 'trashed'); assert.equal(trash.original_path, sourcePath);
      const metadata = JSON.parse(trash.metadata_json); assert.equal(metadata.payloadKind, 'file'); assert.equal(metadata.nativeDocumentId, null);
      groups++; console.log(`API-key native path owner passed: ${label}; exact physical bytes retained, one incoming native mutation and completed history without replay`);
    }
    {
      const label = 'mixed two-root cohort Delete'; stage = label;
      const roots = [`key-cohort-a-${randomUUID()}`, `key-cohort-b-${randomUUID()}`];
      for (const root of roots) await fs.mkdir(path.join(h.source.rootPath, root), { mode: 0o700 });
      const nativePaths = [`${roots[0]}/note.md`, `${roots[1]}/virtual.md`];
      const nativeBytes = [Buffer.from('# Original cohort note\n'), Buffer.from('# Native-only cohort note\n')];
      const natives = [await h.upload(nativePaths[0], nativeBytes[0]), await h.upload(nativePaths[1], nativeBytes[1])];
      await fs.unlink(path.join(h.source.rootPath, nativePaths[1]));
      const physicalPaths = [`${roots[0]}/paper.pdf`, `${roots[1]}/photo.png`], physicalBytes = [Buffer.from('%PDF-1.7\nCohort PDF\n'), Buffer.from('Original cohort PNG bytes\n')];
      for (let index = 0; index < physicalPaths.length; index++) await fs.writeFile(path.join(h.source.rootPath, physicalPaths[index]), physicalBytes[index], { mode: 0o600, flag: 'wx' });
      const keepPath = `key-cohort-kept-${randomUUID()}.md`, keptBytes = Buffer.from('# Keep unrelated native document\n');
      const kept = await h.upload(keepPath, keptBytes); await h.metadata(h.source, keepPath, { title: 'Keep title', isFavorite: true, pinned: true }, 'member');
      const incoming = await h.upload(`key-cohort-incoming-${randomUUID()}.md`, Buffer.from([...nativePaths, ...physicalPaths, keepPath].map((file, index) => `[Label ${index}](${file})`).join(' ') + ' [Web](https://example.test/keep-cohort)\n'));
      const beforeStates = await Promise.all(natives.map(native => load(h.connection, native.documentId))); assert(beforeStates.every(Boolean));
      const incomingBefore = await load(h.connection, incoming.documentId), keptBefore = await load(h.connection, kept.documentId); assert(incomingBefore && keptBefore);
      const beforeMetadata = (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [workspaceId, keepPath])).rows;
      const beforePersonal = (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2', [workspaceId, keepPath])).rows;
      const plan = await run('delete_preview', async principal => buildWorkspaceOperationBatchPlan({ scope: await scope(principal, 'delete_preview'),
        actions: [{ reviewId: randomUUID(), kind: 'delete', selections: roots.map(sourcePath => ({ sourcePath })) }] }));
      assert(plan.version === 6); assert.equal(plan.readiness, 'ready');
      stage = `${label}: execute`; const applied = await applyDelete(plan); assert('kind' in applied.completion);
      const completion: CohortDeleteResult = applied.completion;
      stage = `${label}: archive and Trash invariants`;
      assert.equal(completion.physical.length, 2); assert.equal(completion.targets.length, 4); assert.equal(completion.nativeLinks.length, 1);
      for (const root of roots) await absent(path.join(h.source.rootPath, root));
      for (let index = 0; index < natives.length; index++) {
        const before = beforeStates[index]; assert(before);
        const raw = (await h.admin.query('SELECT status,lifecycle_generation,yjs_state,state_vector FROM collaboration_yjs_states WHERE document_id=$1', [natives[index].documentId])).rows[0];
        assert(raw); assert.equal(raw.status, 'archived'); assert.equal(Number(raw.lifecycle_generation), before.lifecycleGeneration + 1);
        assert.deepEqual(raw.yjs_state, Buffer.from(before.yjsState)); assert.deepEqual(raw.state_vector, Buffer.from(before.stateVector));
        const archived: CohortDeleteResult['targets'][number] | undefined = completion.targets.find(target => target.path === nativePaths[index]); assert(archived?.native);
        assert.equal(archived.native.after.identity.documentId, natives[index].documentId);
        const physical: CohortDeleteResult['physical'][number] | undefined = completion.physical.find(item => item.receipt.original.canonicalPath === roots[index]); assert(physical);
        const payload = path.join(h.dataRoot, physical.receipt.original.trashRelativePath);
        if (index === 0) assert.deepEqual(await fs.readFile(path.join(payload, path.basename(nativePaths[index]))), nativeBytes[index]);
        else await absent(path.join(payload, path.basename(nativePaths[index])));
        assert.deepEqual(await fs.readFile(path.join(payload, path.basename(physicalPaths[index]))), physicalBytes[index]);
        const trash: Record<string, unknown> | undefined = (await h.admin.query('SELECT status,original_path,deleted_by_user_id FROM workspace_trash_entries WHERE id=$1', [physical.receipt.original.trashEntryId])).rows[0];
        assert.deepEqual(trash, { status: 'trashed', original_path: roots[index], deleted_by_user_id: 'member' });
      }
      stage = `${label}: one incoming mutation and unrelated preservation`;
      const incomingAfter = await load(h.connection, incoming.documentId); assert(incomingAfter); assert.equal(incomingAfter.documentSequence, incomingBefore.documentSequence + 1);
      const inventory = links(incomingAfter); assert.equal(inventory.links.some(link => [...nativePaths, ...physicalPaths].includes(link.targetPathText)), false);
      assert(inventory.links.some(link => link.targetPathText === keepPath));
      const snapshot = authoritativeNativeCollaborationSnapshot(incomingAfter).content; assert(snapshot.kind === 'rich_text');
      assert(linkHrefs(snapshot.document).some(href => href === 'https://example.test/keep-cohort'));
      assert.deepEqual(await load(h.connection, kept.documentId), keptBefore); assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, keepPath)), keptBytes);
      assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [workspaceId, keepPath])).rows, beforeMetadata);
      assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2', [workspaceId, keepPath])).rows, beforePersonal);
      groups++; console.log(`API-key native path owner passed: ${label}; mixed native/physical originals retained, one source mutation and unchanged unrelated document/metadata`);
    }
    const checkRead = async (label: string, operation: () => Promise<void>) => {
      stage = label; const before = await domainSnapshot(); await operation(); assert.deepEqual(await domainSnapshot(), before);
      statusGroups++; console.log(`API-key pure status boundary passed: ${label}`);
    };
    const sample = samples.get(3); assert(sample);
    const selected = await run('move_status', principal => scope(principal, 'move_status'));
    const denied = (code: string) => (error: unknown) => errorCode(error) === code;
    await checkRead('actual Apply and Recover purposes retain their own read context for both operation kinds', async () => {
      const deletion = samples.get(6); assert(deletion);
      await verifyStatus(sample.plan, sample.batchId, 'move_apply'); await verifyStatus(sample.plan, sample.batchId, 'move_recover');
      await verifyStatus(deletion.plan, deletion.batchId, 'delete_apply'); await verifyStatus(deletion.plan, deletion.batchId, 'delete_recover');
    });
    await checkRead('forged, mixed and accessor handles cannot open a connection or borrow writer/preview authority', async () => {
      let queries = 0, touched = false;
      const fake = readHolder({ transport: 'api-key', kind: 'move', purpose: 'move_status', principal: {} });
      const input = { batchId: sample.batchId, scope: selected, expectedPlan: sample.plan, apiKeyPrincipal: fake };
      await h.withProbe(async () => { queries++; }, async () => {
        await assert.rejects(readStatus(sample.plan, input), denied('API_KEY_PRINCIPAL_REQUIRED'));
        await assert.rejects(pathStatus({ batchId: sample.batchId, scope: selected, apiKeyPrincipal: fake }), denied('API_KEY_PRINCIPAL_REQUIRED'));
        await assert.rejects(readStatus(sample.plan, { ...input, mcpPrincipal: { kind: 'move', principal: {} } } as unknown as Parameters<typeof readStatus>[1]), denied('BATCH_CLAIM_CHANGED'));
        await assert.rejects(pathStatus({ batchId: sample.batchId, scope: selected, apiKeyPrincipal: fake,
          mcpPrincipal: { kind: 'move', principal: {} } } as unknown as Parameters<typeof pathStatus>[0]), denied('BATCH_CLAIM_CHANGED'));
        const getter = Object.defineProperty({ batchId: sample.batchId, scope: selected }, 'apiKeyPrincipal', { enumerable: true,
          get() { touched = true; return fake; } });
        await assert.rejects(moveStatus(getter), denied('BATCH_CLAIM_CHANGED'));
        await assert.rejects(pathStatus(getter), denied('BATCH_CLAIM_CHANGED'));
        assert.throws(() => readHolder({ ...fake, purpose: 'move_preview' }), denied('API_KEY_JOB_PRINCIPAL_INVALID'));
        assert.throws(() => holder(fake), denied('API_KEY_JOB_PRINCIPAL_INVALID'));
      });
      assert.equal(queries, 0); assert.equal(touched, false);
    });
    await checkRead('derived operation selectors reject malformed IDs and mixed namespaces before any SQL', async () => {
      let queries = 0;
      await run('move_status', async principal => {
        const apiKeyPrincipal = readHolder({ transport: 'api-key', kind: 'move', purpose: 'move_status', principal });
        await h.withProbe(async () => { queries++; }, async () => {
          for (const operationId of ['short', 'invalid operation identifier']) {
            await assert.rejects(pathStatus({ workspaceId, operationId, apiKeyPrincipal }), denied('BATCH_SCOPE_CHANGED'));
          }
          await assert.rejects(pathStatus({ workspaceId, operationId: randomUUID(), apiKeyPrincipal,
            batchId: sample.batchId, scope: selected }), denied('BATCH_SCOPE_CHANGED'));
        });
      });
      assert.equal(queries, 0);
    });
    await checkRead('missing status grant and another genuine integration cannot read this original job', async () => {
      for (const actions of [['move'], ['move', 'status']] as const) {
        const other = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Separate status integration', workspaceIds: [workspaceId], actions: [...actions], expiresAt: Date.now() + 3_600_000 });
        await assert.rejects(run('move_status', principal => readStatus(sample.plan, { batchId: sample.batchId, scope: selected,
          apiKeyPrincipal: readHolder({ transport: 'api-key', kind: 'move', purpose: 'move_status', principal }) }), other.key),
        denied(actions.length === 1 ? 'API_KEY_ACCESS_DENIED' : 'API_KEY_JOB_AUTHORIZATION_CHANGED'));
        const operationId = operationIds.get(sample.batchId); assert(operationId);
        if (actions.length === 1) {
          await assert.rejects(run('move_status', principal => pathStatus({ workspaceId, operationId,
            apiKeyPrincipal: readHolder({ transport: 'api-key', kind: 'move', purpose: 'move_status', principal }) }), other.key), denied('API_KEY_ACCESS_DENIED'));
        } else {
          await assert.rejects(run('move_status', principal => pathStatus({ batchId: sample.batchId, scope: selected,
            apiKeyPrincipal: readHolder({ transport: 'api-key', kind: 'move', purpose: 'move_status', principal }) }), other.key), denied('API_KEY_JOB_AUTHORIZATION_CHANGED'));
          await run('move_status', async principal => assert.equal(await pathStatus({ workspaceId, operationId,
            apiKeyPrincipal: readHolder({ transport: 'api-key', kind: 'move', purpose: 'move_status', principal }) }), null), other.key);
        }
      }
    });
    await checkRead('absent status across all four profiles creates no job or history', async () => {
      assert.equal(samples.size, 4);
      for (const { plan } of samples.values()) {
        const kind = plan.version === 3 ? 'move' : 'delete', purpose = kind === 'move' ? 'move_status' : 'delete_status';
        await run(purpose, async principal => assert.equal(await readStatus(plan, { batchId: randomUUID(), scope: await scope(principal, purpose),
          apiKeyPrincipal: readHolder({ transport: 'api-key', kind, purpose, principal }) }), null));
        await run(purpose, async principal => assert.equal(await pathStatus({ workspaceId, operationId: randomUUID(),
          apiKeyPrincipal: readHolder({ transport: 'api-key', kind, purpose, principal }) }), null));
      }
    });
    const sampleOperationId = operationIds.get(sample.batchId); assert(sampleOperationId);
    const readSample = () => run('move_status', principal => pathStatus({ workspaceId, operationId: sampleOperationId,
      apiKeyPrincipal: readHolder({ transport: 'api-key', kind: 'move', purpose: 'move_status', principal }) }));
    const afterSnapshotCommit = async (change: () => Promise<void>) => {
      let snapshot = false, changed = false, exposed = false;
      const execute = () => h.withProbe(async event => {
        if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/iu.test(event.text.trim())) snapshot = true;
        if (snapshot && !changed && /^COMMIT$/iu.test(event.text.trim())) { changed = true; await change(); }
      }, async () => { const result = await readSample(); exposed = true; return result; });
      return { execute, assertDenied: () => { assert.equal(changed, true); assert.equal(exposed, false); } };
    };
    await checkRead('a changed actual read-snapshot realm is rejected without exposing history', async () => {
      let shifted = false;
      await assert.rejects(h.withProbe(async event => {
        if (!shifted && /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/iu.test(event.text.trim())) {
          shifted = true; await event.raw(`SET LOCAL search_path=pg_catalog,"${h.schema}"`);
        }
      }, readSample), denied('BATCH_SCOPE_CHANGED'));
      assert.equal(shifted, true);
    });
    await checkRead('actual action withdrawal after the snapshot denies C2 and restored grants permit a fresh request', async () => {
      const boundary = await afterSnapshotCommit(async () => {
        await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
          workspaceIds: [workspaceId], actions: ['move', 'delete', 'recover'] });
      });
      try {
        await assert.rejects(boundary.execute(), denied('API_KEY_ACCESS_DENIED')); boundary.assertDenied();
        await verifyStatus(sample.plan, sample.batchId, 'move_apply'); await verifyStatus(sample.plan, sample.batchId, 'move_recover');
      }
      finally { await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
        workspaceIds: [workspaceId], actions: ['move', 'delete', 'status', 'recover'] }); }
      await verifyStatus(sample.plan, sample.batchId);
    });
    await checkRead('rotation after the snapshot denies the old request; a new key retains immutable Original attribution', async () => {
      const original = await store.get(sample.batchId); assert(original?.authorization.mode === 'api-key');
      const boundary = await afterSnapshotCommit(async () => {
        const rotated = await rotateApiKey(manager, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
        activeKey = rotated.key; credentialId = rotated.credential.id;
      });
      await assert.rejects(boundary.execute(), denied('API_KEY_INVALID')); boundary.assertDenied();
      assert.notEqual(credentialId, issued.credential.id); await verifyStatus(sample.plan, sample.batchId);
      assert.deepEqual((await store.get(sample.batchId))?.authorization, original.authorization);
    });
    await checkRead('real key revocation after the snapshot denies C2 without exposing its prepared result', async () => {
      const boundary = await afterSnapshotCommit(async () => { await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId }); });
      await assert.rejects(boundary.execute(), denied('API_KEY_INVALID')); boundary.assertDenied();
    });
    console.log(`API-key pure status: ${statusGroups} actual grant/realm/absence/lifetime boundary groups passed.`);
  });
  console.log(`API-key native path owners: ${groups} actual Move/Delete/read-only status groups passed; public adapters and installed SDK remain separate.`);
}
function describe(error: unknown, depth = 0): unknown {
  if (!error || typeof error !== 'object' || depth > 3) return undefined;
  const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
  return { name: error instanceof Error ? error.name : 'UnknownError', code: errorCode(error), cause: describe(cause, depth + 1),
    errors: error instanceof AggregateError ? error.errors.slice(0, 3).map(item => describe(item, depth + 1)) : undefined,
    assertion: error instanceof assert.AssertionError ? { operator: error.operator, rejection: describe(error.actual, depth + 1), actual: typeof error.actual === 'number' || typeof error.actual === 'boolean' ? error.actual : typeof error.actual,
      expected: typeof error.expected === 'number' || typeof error.expected === 'boolean' ? error.expected : typeof error.expected } : undefined };
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-native-path-owner', stage, error: describe(error),
  stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s*at\b/u.test(line)).slice(0, 5) : [] })); process.exitCode = 1; });
