import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NativeCopyReceipt } from '../app/lib/collaboration/native-copy-persistence';
import type { WorkspaceOperationManagedCopyStageV4 } from '../app/lib/files/workspace-operation-managed-copy-stage';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Ordinary authenticated Copy service; no fabricated plan, receipt, SQL result,
// source authority or publication callback. The probe only observes real SQL.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const sha = (value: Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');

async function managedCopySharedParentPostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const files = ['scripts/workspace-managed-copy-shared-parent-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-file-operation-service.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/files/workspace-operation-native-copy-phase.ts', 'app/lib/files/workspace-operation-native-copy-phase-contract.ts',
    'app/lib/files/workspace-operation-staging.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(file))])));
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { executeWorkspaceFileOperationService: service } = await import('../app/lib/files/workspace-file-operation-service');
    const { previewWorkspaceNativeCopyOperation: preview } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { nativeCopyPhaseParentSteps } = await import('../app/lib/files/workspace-operation-native-copy-phase-contract');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const sourceOwner = await readPostgresWorkspaceForActorOnConnection(h.connection,
      resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId);
    assert(sourceOwner?.permissions.canWrite);
    const staging = new WorkspaceOperationStaging(), journal = new WorkspaceOperationJournal();
    const sourceRows = async (ids: readonly string[]) => (await h.admin.query(`
      SELECT 'native' AS kind,document_id AS id,to_jsonb(s)::text AS body,xmin::text AS xmin
        FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[])
      UNION ALL SELECT 'registry',id,to_jsonb(d)::text,xmin::text FROM collaboration_documents d WHERE id=ANY($1::text[])
      UNION ALL SELECT 'lineage',id,to_jsonb(l)::text,xmin::text FROM file_collaboration_lineages l
        WHERE id IN (SELECT lineage_id FROM collaboration_documents WHERE id=ANY($1::text[]))
      ORDER BY kind,id`, [ids])).rows;
    for (const sameWorkspace of [false, true]) {
      currentCase = sameWorkspace ? 'same-workspace owner' : 'cross-workspace member';
      const userId = sameWorkspace ? 'owner' : 'member', actorSessionId = `session-${userId}`;
      const source: WorkspaceContext = sameWorkspace ? sourceOwner : h.source, destination: WorkspaceContext = sameWorkspace ? sourceOwner : h.destination;
      assert(source.permissions.canRead && destination.permissions.canWrite);
      if (!sameWorkspace) assert.equal(source.permissions.canWrite, false);
      const suffix = crypto.randomUUID(), nativePath = `native-${suffix}.md`, pdfPath = `asset-${suffix}.pdf`;
      const parent = `shared-${suffix}`, nativeTarget = `${parent}/native.md`, pdfTarget = `${parent}/asset.pdf`;
      const native = await h.upload(nativePath, Buffer.from('# Shared parent native\n'));
      const incomingPath = `incoming-${suffix}.md`, incomingBytes = Buffer.from(`[Keep original](${nativePath})\n`);
      const incoming = await h.upload(incomingPath, incomingBytes);
      const pdf = Buffer.from('%PDF-1.7\n\0\xff\n%%EOF', 'binary');
      await fs.unlink(path.join(source.rootPath, nativePath));
      await fs.writeFile(path.join(source.rootPath, pdfPath), pdf, { mode: 0o600, flag: 'wx' });
      await assert.rejects(fs.lstat(path.join(destination.rootPath, parent)), { code: 'ENOENT' });
      const before = await sourceRows([native.documentId, incoming.documentId]);
      const selections = [{ sourcePath: nativePath, destinationPath: nativeTarget }, { sourcePath: pdfPath, destinationPath: pdfTarget }];
      const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId, actorId: userId, sessionId: actorSessionId },
        sourceWorkspace: source, destinationWorkspace: destination });
      const request = await h.request(destination, userId, true);
      assert(request.headers.get('cookie')); assert.equal(request.headers.get('authorization'), null);
      const plan = await preview({ origin, request, selections }); assert.equal(plan.version, 3);
      const operationId = crypto.randomUUID();
      const sqlFacts: Array<{ command: string; table: string | null; rows: number | null }> = [];
      let stage: WorkspaceOperationManagedCopyStageV4 | undefined;
      const diagnostic = async (execution: unknown) => {
        const operation = (await h.admin.query('SELECT status,expected_step_count,error_code FROM workspace_file_operations WHERE operation_id=$1', [operationId])).rows;
        const steps = (await h.admin.query('SELECT step_key,phase,status FROM workspace_file_operation_steps WHERE operation_id=$1 ORDER BY step_key LIMIT 32', [operationId])).rows;
        console.log(JSON.stringify({ diagnostic: 'managed-copy-shared-parent', case: currentCase, execution, operation, steps, lastSqlClasses: sqlFacts.slice(-24) }));
      };
      let result: Awaited<ReturnType<typeof service>>;
      try {
        result = await h.withProbe(async event => {
          const command = /^\s*([A-Z]+)/iu.exec(event.text)?.[1]?.toUpperCase() ?? 'OTHER';
          const table = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?\w+"?\.)?"?(\w+)\b/iu.exec(event.text)?.[1] ?? null;
          sqlFacts.push({ command, table, rows: event.result.rowCount });
          if (sqlFacts.length > 24) sqlFacts.shift();
          if (!stage && table === 'collaboration_native_copy_receipts' && event.values.includes(operationId)) {
            const captured = await staging.loadManagedCopyByOperationId(operationId); assert(captured); stage = captured;
            assert.equal(stage.version, 4); assert.equal(stage.physical.length, 2);
            const parents = nativeCopyPhaseParentSteps(stage);
            assert.equal(parents.length, 1); assert.equal(parents[0].path, parent);
            assert.equal(parents[0].producerSelectionIndex, 1); assert.deepEqual(parents[0].consumerSelectionIndexes, [0, 1]);
            assert.equal(stage.physical[0].selectionIndex, 0); assert.equal(stage.physical[0].original.staging, null);
            assert.equal(stage.physical[1].selectionIndex, 1); assert(stage.physical[1].original.staging);
          }
        }, () => service({ kind: 'copy', operationId, expectedPlanId: plan.planId, selections, request,
          source: { workspace: source, fileOptions: { workspace: source } },
          destination: { workspace: destination, fileOptions: { workspace: destination, mutationActorUserId: userId } },
          actorUserId: userId, actorId: userId, actorSessionId, actorType: 'user', actorDisplayName: 'Actual shared-parent principal' }));
      } catch (error) {
        await diagnostic({ thrownName: error instanceof Error ? error.name : 'NonError',
          code: error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined });
        throw error;
      }
      if (result.execution.status !== 'complete') await diagnostic(result.execution);
      assert.equal(result.execution.status, 'complete', JSON.stringify(result.execution)); assert(stage);
      assert.deepEqual(result.copied, [nativeTarget, pdfTarget]); assert.equal(result.alreadyKnown, false);
      const operation = await journal.get(operationId); assert(operation); assert.equal(operation.status, 'completed');
      assert.equal(operation.steps.length, operation.expectedStepCount); assert(operation.steps.every(step => step.status === 'applied'));
      assert.equal(operation.steps.filter(step => step.stepKey.startsWith('copy-parent:')).length, 1);
      const completion = operation.steps.find(step => step.stepKey === 'copy-completion'); assert(completion?.receiptJson);
      const completionBody = JSON.parse(completion.receiptJson); assert.equal(completionBody.version, 3);
      assert.equal(completionBody.stageDigest, stage.payloadSha256);
      const ledger = (await h.admin.query<{ private_result: Omit<NativeCopyReceipt, 'publicationStatus'>; publication_status: string }>(
        'SELECT private_result,publication_status FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
      assert(ledger); assert.equal(ledger.publication_status, 'published'); assert.equal(ledger.private_result.documents.length, 1);
      const clone = ledger.private_result.documents[0]; assert.equal(clone.source.documentId, native.documentId);
      assert.notEqual(clone.clone.documentId, native.documentId); assert.equal(clone.clone.path, nativeTarget);
      const stored = await load(h.connection, clone.clone.documentId); assert(stored);
      assert.equal(stored.workspaceId, destination.workspaceId); assert.equal(stored.path, nativeTarget); assert.equal(stored.status, 'active');
      assert.equal(stored.lifecycleGeneration, 1); assert.equal(stored.documentSequence, 0);
      const doc = new Y.Doc();
      try { Y.applyUpdate(doc, stored.yjsState); assert.equal(stored.representation === 'plain_text'
        ? doc.getText('content').toString() : richMarkdownFromYDoc(doc), '# Shared parent native\n'); } finally { doc.destroy(); }
      const registry = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1 AND workspace_id=$2 AND path=$3',
        [clone.clone.documentId, destination.workspaceId, nativeTarget])).rows[0];
      assert.equal(registry?.lineage_id, clone.clone.lineageId);
      assert.notEqual(registry.lineage_id, (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [native.documentId])).rows[0].lineage_id);
      assert.deepEqual(await sourceRows([native.documentId, incoming.documentId]), before, 'Source and incoming-link rows stay unchanged.');
      assert.deepEqual(await fs.readFile(path.join(source.rootPath, incomingPath)), incomingBytes);
      assert.deepEqual(await fs.readFile(path.join(source.rootPath, pdfPath)), pdf);
      assert.deepEqual(await fs.readFile(path.join(destination.rootPath, pdfTarget)), pdf);
      assert.equal((await fs.lstat(path.join(destination.rootPath, parent))).isDirectory(), true);
      await assert.rejects(fs.lstat(path.join(source.rootPath, nativePath)), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(path.join(destination.rootPath, nativeTarget)), { code: 'ENOENT' });
      assert.equal(await staging.loadManagedCopyByOperationId(operationId), null);
      groups++; console.log(`PASS managed-copy-shared-parent ${groups}: ${currentCase}`);
    }
  });
  assert.equal(groups, 2); assert.deepEqual(Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(file))]))), pins);
  completed = true; console.log(JSON.stringify({ suite: 'workspace-managed-copy-shared-parent-postgres', groups, passed: true, sourcesUnchanged: true }));
}

void managedCopySharedParentPostgresTest().catch(error => {
  console.error(JSON.stringify({ suite: 'workspace-managed-copy-shared-parent-postgres', case: currentCase,
    name: error instanceof Error ? error.name : 'NonError', message: error instanceof assert.AssertionError ? error.message : undefined }));
  process.exitCode = 1;
});
