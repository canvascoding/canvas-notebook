import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import type { WorkspaceOperationNativeCopyPlan } from '../app/lib/files/workspace-operation-native-copy-plan';
import type { WorkspaceOperationNativeCopyStage } from '../app/lib/files/workspace-operation-native-copy-stage';
import type { WorkspaceOperationManagedCopyPlan } from '../app/lib/files/workspace-operation-managed-copy-plan';
import type { WorkspaceOperationManagedCopyStageV4 } from '../app/lib/files/workspace-operation-managed-copy-stage';
import type { WorkspaceOperationStepRecord } from '../app/lib/files/workspace-operation-journal';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

function nativeCopyMetadataFailureDiagnostic(error: unknown): Record<string, unknown> {
  const seen = new Set<unknown>(); let remaining = 10;
  const redact = (value: string) => value.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[jwt-redacted]')
    .replace(/\b(password|secret|token|authorization)\s*[=:]\s*\S+/giu, '$1=[redacted]').slice(0, 500);
  const visit = (value: unknown, depth: number): Record<string, unknown> => {
    if (!(value instanceof Error)) return { type: typeof value };
    if (seen.has(value) || depth > 3 || remaining-- <= 0) return { name: 'DiagnosticBound' };
    seen.add(value);
    const code: unknown = Object.getOwnPropertyDescriptor(value, 'code')?.value;
    const result: Record<string, unknown> = { name: redact(value.name).slice(0, 80), message: redact(value.message),
      code: typeof code === 'string' && /^[A-Za-z0-9_]{1,96}$/u.test(code) ? code : null };
    const cause = Object.getOwnPropertyDescriptor(value, 'cause');
    if (cause && Object.hasOwn(cause, 'value')) result.cause = visit(cause.value, depth + 1);
    if (value instanceof AggregateError) result.errors = [...value.errors].slice(0, 6).map(item => visit(item, depth + 1));
    return result;
  };
  return visit(error, 0);
}

// Actual authenticated Copy owner + production migrations + FD publication.
// Direct SQL below is explicitly adversarial stored data, never an ACL grant.
let currentCase = 'setup', groups = 0, testCompleted = false;
process.once('beforeExit', () => { if (!testCompleted) process.exitCode = 1; });
async function runNativeCopyMetadataOwnerPostgresTest(): Promise<void> {
  const files = ['scripts/workspace-operation-native-copy-metadata-owner-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-native-copy-metadata.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/files/workspace-operation-native-copy-stage.ts', 'app/lib/files/workspace-operation-staging.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/files/workspace-operation-managed-copy-plan.ts',
    'app/lib/files/workspace-operation-copy-source-observation.ts', 'app/lib/excalidraw-collaboration/copy-data.ts',
    'app/lib/excalidraw-collaboration/copy-domain.ts', 'app/lib/excalidraw-collaboration/copy-history.ts',
    'app/lib/excalidraw-collaboration/copy-asset-publication.ts', 'app/lib/db/excalidraw-copy-migration.ts',
    'app/lib/files/workspace-operation-native-copy-phase.ts', 'app/lib/files/workspace-operation-native-copy-phase-contract.ts',
    'app/lib/files/workspace-operation-native-copy-phase-read.ts', 'app/lib/files/workspace-file-metadata.ts',
    'app/lib/workspaces/copy-principal.ts', 'app/lib/collaboration/native-copy-persistence.ts', 'app/lib/db/postgres.ts',
    'app/lib/db/schema.ts', 'app/lib/workspaces/starter-document-initialization-api.ts',
    'app/lib/collaboration/markdown-file-import-persistence.ts', 'app/lib/filesystem/prepared-workspace-path-copy.ts',
    'app/lib/filesystem/prepared-workspace-path-copy-contract.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, crypto.createHash('sha256').update(await readFile(file)).digest('hex')])));
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { previewWorkspaceNativeCopyOperation: preview, executeWorkspaceNativeCopyOperation: execute } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { WorkspaceOperationJournal, serializeWorkspaceOperationRequest } = await import('../app/lib/files/workspace-operation-journal');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { nativeCopyPhaseAdmissions, nativeCopyPhaseStepCount, nativeCopyPhaseCompletionFence } = await import('../app/lib/files/workspace-operation-native-copy-phase-contract');
    const { nativeCopyMetadataWitness, nativeCopyMetadataCompletionWitness, nativeCopyMetadataCompositeDigest, decodeNativeCopyMetadataCompletionWitness } = await import('../app/lib/files/workspace-operation-native-copy-metadata');
    const { prepareNativeCopyStage, decodeNativeCopyStage } = await import('../app/lib/files/workspace-operation-native-copy-stage');
    const { prepareManagedCopyStage } = await import('../app/lib/files/workspace-operation-managed-copy-stage');
    const { captureExcalidrawCopyIntent, captureExcalidrawCopyBirthReceipt } = await import('../app/lib/excalidraw-collaboration/copy-data');
    const { nativeLinkJsonProof: proof } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const journal = new WorkspaceOperationJournal(), staging = new WorkspaceOperationStaging();
    const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' },
      sourceWorkspace: h.source, destinationWorkspace: h.destination });
    type Job = { operationId: string; origin: WorkspaceOperationCopyOrigin; selections: Array<{ sourcePath: string; destinationPath: string }>; expectedPlanId: string; plan: WorkspaceOperationNativeCopyPlan | WorkspaceOperationManagedCopyPlan };
    const group = async (name: string, action: () => Promise<void>) => { currentCase = name; await action(); groups++; console.log(`PASS native-copy-metadata-owner ${groups}: ${name}`); };
    const newJob = async (sourcePath: string, destinationPath = `copy-${crypto.randomUUID()}.md`): Promise<Job> => {
      const selections = [{ sourcePath, destinationPath }], plan = await preview({ origin, request: await h.request(), selections });
      assert(plan.version === 3);
      return { operationId: crypto.randomUUID(), origin, selections, expectedPlanId: plan.planId, plan };
    };
    const run = async (job: Job) => execute({ ...job, request: await h.request(undefined, 'member', true) });
    const row = async (operationId: string) => (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
    const titles = async (workspaceId: string, targetPath: string) => (await h.admin.query('SELECT path,title,created_at,updated_at,xmin::text AS xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [workspaceId, targetPath])).rows;
    const exactStage = async (job: Job) => { const value = await staging.loadManagedCopyByOperationId(job.operationId); assert(value); return value; };
    const complete = async (job: Job, result: Awaited<ReturnType<typeof run>>, stage: WorkspaceOperationManagedCopyStageV4, expectedAlreadyKnown = false) => {
      assert.equal(result.alreadyKnown, expectedAlreadyKnown);
      assert.equal(result.execution.status, 'complete', JSON.stringify(result.execution));
      assert.equal(stage.version, 4); assert.equal(stage.plan.version, 3);
      const ledger = await row(job.operationId); assert.equal(ledger.publication_status, 'published'); assert.equal(ledger.publication_fingerprint, stage.payloadSha256);
      const operation = await journal.get(job.operationId); assert(operation); assert.equal(operation.status, 'completed');
      const completion = operation.steps.find(step => step.stepKey === 'copy-completion'); assert(completion?.receiptJson);
      const body = JSON.parse(completion.receiptJson); assert.equal(body.version, 3);
      assert.equal(body.stageDigest, stage.payloadSha256);
      const rebuilt = prepareManagedCopyStage({ operationId: stage.identity.operationId, request: stage.request, plan: stage.plan,
        physical: stage.physical, nativeRecords: stage.nativeRecords, sceneRecords: stage.sceneRecords, sceneAssets: stage.sceneAssets, metadata: stage.metadata });
      assert.equal(rebuilt.manifest.payloadSha256, stage.payloadSha256);
      assert.deepEqual(body.metadata, nativeCopyMetadataCompletionWitness(stage.metadata, Number(ledger.created_at)));
      assert.equal(body.metadata.snapshotProof, nativeCopyMetadataWitness(stage.metadata).snapshotProof);
      const sceneRows = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [job.operationId])).rows;
      assert.equal(sceneRows.length, 1); const sceneRow = sceneRows[0];
      const intent = captureExcalidrawCopyIntent(sceneRow.intent_json), birth = captureExcalidrawCopyBirthReceipt(sceneRow.birth_json);
      assert.deepEqual(birth.intent, intent); assert.equal(intent.nativeReceiptProof, proof(ledger.private_result));
      assert.deepEqual(intent.documents, []); assert.deepEqual(birth.documents, []); assert.deepEqual(intent.assetOriginal.metadata, []);
      assert.deepEqual(birth.assetReceipt.blobs, []); assert.equal(intent.stageDigest, stage.payloadSha256); assert.equal(sceneRow.xmin, ledger.xmin);
      assert.equal(body.sceneIntentProof, intent.intentDigest); assert.equal(body.sceneBirthProof, birth.receiptProof);
      assert.equal(body.assetReceiptProof, birth.assetReceipt.receiptProof);
      const requests = nativeCopyPhaseAdmissions(stage, ledger.private_result);
      assert(requests.length > 0);
      for (const request of requests) {
        const stored = (await h.admin.query('SELECT status,outcome_text,xmin::text AS xmin FROM collaboration_admission_requests WHERE request_id=$1', [request.requestId])).rows[0];
        assert.equal(stored?.status, 'committed'); assert.equal(stored.xmin, ledger.xmin);
        assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_admission_targets WHERE request_id=$1 AND active', [request.requestId])).rows[0].n, 0);
        assert.equal(typeof stored.outcome_text, 'string'); assert(JSON.parse(stored.outcome_text));
      }
      const completionXmin = (await h.admin.query("SELECT xmin::text AS xmin FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key='copy-completion'", [job.operationId])).rows[0].xmin;
      assert.equal(completionXmin, ledger.xmin);
      return { ledger, completion, body };
    };
    const capture = async <T>(job: Job, action: () => Promise<T>) => {
      let stage: WorkspaceOperationManagedCopyStageV4 | undefined;
      const value = await h.withProbe(async event => {
        if (!stage && /^\s*INSERT\s+INTO\s+(?:"?\w+"?\.)?"?collaboration_native_copy_receipts\b/iu.test(event.text)) stage = await exactStage(job);
      }, action);
      assert(stage); return { value, stage };
    };
    const interrupted = async (job: Job, code: string) => {
      const result = await run(job); assert.equal(result.execution.status, 'needs_recovery'); assert.equal(result.execution.errorCode, code);
      assert.equal((await journal.get(job.operationId))?.status, 'recovery_required'); assert.deepEqual(result.copied, []); return result;
    };
    const sourcePath = 'metadata-original.md', sourceBytes = Buffer.from('\uFEFF---\r\ntitle: YAML title remains content\r\n---\r\n# Actual imported document\r\n');
    const sourceIdentity = await h.upload(sourcePath, sourceBytes);
    await h.metadata(h.source, sourcePath, { title: 'Shared database title', isFavorite: true, pinned: true });
    let completedJob: Job | undefined, completedStage: WorkspaceOperationManagedCopyStageV4 | undefined;
    let legacyCompletedJob: Job | undefined, legacyCompletedStage: Extract<WorkspaceOperationNativeCopyStage, { version: 3 }> | undefined;

    await group('real READ-only source, cookie destination writer, DB title differs from unchanged YAML; personal state is neither read nor copied', async () => {
      const job = await newJob(sourcePath); let original: WorkspaceOperationManagedCopyStageV4 | undefined, sourcePersonalReads = 0;
      const writes: Array<{ table: string; pid: number; xid: string }> = [];
      const result = await h.withProbe(async event => {
        if (/workspace_file_user_states/iu.test(event.text) && /^\s*(?:SELECT|WITH)\b/iu.test(event.text) && event.values[0] === h.source.workspaceId) sourcePersonalReads++;
        if (!original && /^\s*INSERT INTO collaboration_native_copy_receipts\b/iu.test(event.text)) original = await exactStage(job);
        const table = /^\s*(?:INSERT\s+INTO|UPDATE)\s+(?:"?\w+"?\.)?"?(workspace_file_metadata|workspace_file_operations|collaboration_native_copy_receipts)\b/iu.exec(event.text)?.[1];
        if (table && event.values.includes(job.operationId) || table === 'workspace_file_metadata') {
          const witness = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
          writes.push({ table: table!, pid: witness.pid, xid: witness.xid });
        }
      }, () => run(job)); assert(original);
      const { ledger } = await complete(job, result, original); assert.equal(sourcePersonalReads, 0);
      const target = (await titles(h.destination.workspaceId, job.selections[0].destinationPath))[0];
      assert.equal(target.title, 'Shared database title'); assert.equal(Number(target.created_at), Number(ledger.created_at)); assert.equal(Number(target.updated_at), Number(ledger.created_at));
      assert.equal(target.xmin, ledger.xmin);
      const metadataWrite = writes.find(value => value.table === 'workspace_file_metadata'); assert(metadataWrite);
      assert(writes.some(value => value.table === 'collaboration_native_copy_receipts' && value.pid === metadataWrite.pid && value.xid === metadataWrite.xid));
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2', [h.destination.workspaceId, target.path])).rows[0].n, 0);
      assert.deepEqual(await readFile(path.join(h.source.rootPath, sourcePath)), sourceBytes);
      assert.equal((await h.admin.query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, sourcePath])).rows[0].id, sourceIdentity.documentId);
      completedJob = job; completedStage = original;
    });
    await group('stored historical NULL source row stays in original snapshot, but creates no target null annotation', async () => {
      const name = 'historical-null.md'; await h.upload(name, Buffer.from('# NULL title fixture\n'));
      await h.admin.query('INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,NULL,101,109)', [h.source.workspaceId, name]);
      const job = await newJob(name), { value, stage } = await capture(job, () => run(job));
      await complete(job, value, stage); assert.equal(stage.version, 4);
      assert.deepEqual(stage.metadata.sourceRows, [{ path: name, title: null, createdAt: 101, updatedAt: 109 }]);
      assert.equal((await titles(h.destination.workspaceId, job.selections[0].destinationPath)).length, 0);
    });
    for (const kind of ['shared-null', 'foreign-false-null', 'foreign-favorite'] as const) await group(`target orphan ${kind} blocks before durable Copy stage or clone birth`, async () => {
      const target = `orphan-${crypto.randomUUID()}.md`, selections = [{ sourcePath, destinationPath: target }], operationId = crypto.randomUUID();
      if (kind === 'shared-null') await h.admin.query('INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,NULL,100,100)', [h.destination.workspaceId, target]);
      else await h.admin.query('INSERT INTO workspace_file_user_states(workspace_id,user_id,path,is_favorite,pinned_at,created_at,updated_at) VALUES($1,$2,$3,$4,NULL,100,100)', [h.destination.workspaceId, 'owner', target, kind === 'foreign-favorite' ? 1 : 0]);
      try {
        await assert.rejects(execute({ origin, request: await h.request(), operationId, selections }), error => error instanceof Error && Reflect.get(error, 'code') === 'NATIVE_COPY_METADATA_CHANGED');
        assert.equal(await journal.get(operationId), null); assert.equal(await staging.loadManagedCopyByOperationId(operationId), null); assert.equal(await row(operationId), undefined);
      } finally {
        await h.admin.query('DELETE FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.destination.workspaceId, target]);
        await h.admin.query('DELETE FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2', [h.destination.workspaceId, target]);
      }
    });
    await group('native-only missing logical parent rejects its exact orphan annotation, while unrelated sibling data remains untouched', async () => {
      const parent = `logical-${crypto.randomUUID()}`, target = `${parent}/note.md`, sibling = `${parent}/unselected.md`;
      await h.admin.query('INSERT INTO workspace_file_user_states(workspace_id,user_id,path,is_favorite,pinned_at,created_at,updated_at) VALUES($1,$2,$3,0,NULL,100,100),($1,$2,$4,0,NULL,100,100)', [h.destination.workspaceId, 'owner', parent, sibling]);
      try {
        await assert.rejects(execute({ origin, request: await h.request(), operationId: crypto.randomUUID(), selections: [{ sourcePath, destinationPath: target }] }), error => error instanceof Error && Reflect.get(error, 'code') === 'NATIVE_COPY_METADATA_CHANGED');
        await h.admin.query('DELETE FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2', [h.destination.workspaceId, parent]);
        const job = await newJob(sourcePath, target), { value, stage } = await capture(job, () => run(job)); await complete(job, value, stage);
        assert.equal(stage.version, 4); assert.deepEqual(stage.metadata.exactVacancyPaths, [parent]);
        assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2', [h.destination.workspaceId, sibling])).rows[0].n, 1);
        await assert.rejects(readFile(path.join(h.destination.rootPath, target)), { code: 'ENOENT' });
      } finally { await h.admin.query('DELETE FROM workspace_file_user_states WHERE workspace_id=$1 AND path=ANY($2::text[])', [h.destination.workspaceId, [parent, sibling]]); }
    });
    await group('lost actual B1 COMMIT acknowledgement recovers original title after legitimate source-title change', async () => {
      const job = await newJob(sourcePath); let birth = false, fired = false, original: WorkspaceOperationManagedCopyStageV4 | undefined;
      await h.withProbe(async event => {
        if (/^\s*INSERT INTO collaboration_native_copy_receipts\b/iu.test(event.text)) { birth = true; original = await exactStage(job); }
        if (birth && !fired && /^\s*COMMIT\s*$/iu.test(event.text)) { fired = true; throw new Error('Owned B1 COMMIT acknowledgement lost.'); }
      }, () => interrupted(job, 'NATIVE_COPY_COMMIT_UNCONFIRMED'));
      assert(fired && original); assert.equal((await row(job.operationId)).publication_status, 'native_committed');
      await h.metadata(h.source, sourcePath, { title: 'Later legitimate source title' });
      const result = await run(job); await complete(job, result, original, true);
      assert.equal((await titles(h.destination.workspaceId, job.selections[0].destinationPath))[0].title, 'Shared database title');
      assert.equal((await titles(h.source.workspaceId, sourcePath))[0].title, 'Later legitimate source title');
    });
    await group('completed original history survives later legitimate target title edit and source title change without replaying metadata', async () => {
      assert(completedJob && completedStage);
      await h.metadata(h.destination, completedJob.selections[0].destinationPath, { title: 'Target editorial title' }, 'member');
      const before = await row(completedJob.operationId), retry = await run(completedJob);
      assert.equal(retry.execution.status, 'complete'); assert.equal(retry.alreadyKnown, true);
      assert.deepEqual(await row(completedJob.operationId), before);
      assert.equal((await titles(h.destination.workspaceId, completedJob.selections[0].destinationPath))[0].title, 'Target editorial title');
    });
    await group('adversarial source title drift after durable original intent is rejected before C3 birth and does not adopt today title', async () => {
      const job = await newJob(sourcePath); let fired = false;
      const before = (await titles(h.source.workspaceId, sourcePath))[0];
      try {
        await h.withProbe(async event => {
          if (!fired && /^\s*INSERT\s+INTO\s+workspace_file_operations\b/iu.test(event.text)) {
            fired = true; await h.admin.query('UPDATE workspace_file_metadata SET title=$3,updated_at=updated_at+1 WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, sourcePath, 'Adversarial later title']);
          }
        }, () => interrupted(job, 'NATIVE_COPY_METADATA_CHANGED'));
        assert(fired); assert.equal(await row(job.operationId), undefined); assert.equal((await titles(h.destination.workspaceId, job.selections[0].destinationPath)).length, 0);
      } finally { await h.admin.query('UPDATE workspace_file_metadata SET title=$3,created_at=$4,updated_at=$5 WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, sourcePath, before.title, before.created_at, before.updated_at]); }
    });
    await group('actual B2 title INSERT failure rolls back metadata, ledger publication and completion together; retry uses original C3 birth time', async () => {
      const job = await newJob(sourcePath); let fired = false, stage: WorkspaceOperationManagedCopyStageV4 | undefined;
      await h.withProbe(async event => {
        if (/^\s*INSERT INTO collaboration_native_copy_receipts\b/iu.test(event.text)) stage = await exactStage(job);
        if (!fired && /^\s*INSERT\s+INTO\s+(?:"?\w+"?\.)?"?workspace_file_metadata\b/iu.test(event.text) && event.values[0] === h.destination.workspaceId) {
          fired = true; throw new Error('Owned metadata INSERT acknowledgement failure.');
        }
      }, () => interrupted(job, 'NATIVE_COPY_PUBLICATION_UNCONFIRMED'));
      assert(fired && stage); const birth = await row(job.operationId); assert.equal(birth.publication_status, 'native_committed');
      assert.equal((await titles(h.destination.workspaceId, job.selections[0].destinationPath)).length, 0);
      assert.equal((await journal.get(job.operationId))?.steps.some(step => step.stepKey === 'copy-completion'), false);
      const { ledger } = await complete(job, await run(job), stage, true); assert.equal(ledger.created_at, birth.created_at);
      assert.equal(Number((await titles(h.destination.workspaceId, job.selections[0].destinationPath))[0].created_at), Number(birth.created_at));
    });
    await group('genuine persisted Legacy StageV3/PlanV2/PreparedV2 recovers fixed native IDs and frozen titles after actual B1 ACK loss', async () => {
      const fresh = await newJob(sourcePath), originalTitle = (await titles(h.source.workspaceId, sourcePath))[0].title;
      const { readWorkspaceLinkSourceAuthorityOnConnection } = await import('../app/lib/markdown/workspace-source-authority-stage');
      const { createWorkspaceOperationNativeCopyPlanV2 } = await import('../app/lib/files/workspace-operation-native-copy-plan');
      const { withPreparedWorkspacePathCopy, readPreparedWorkspacePathCopy } = await import('../app/lib/filesystem/prepared-workspace-path-copy');
      const { captureNativeCopyMetadataSnapshotOnConnection } = await import('../app/lib/files/workspace-operation-native-copy-metadata');
      const observations = await Promise.all([h.source, h.destination].map(workspace => readWorkspaceLinkSourceAuthorityOnConnection(h.connection, workspace)));
      const plan = createWorkspaceOperationNativeCopyPlanV2({ sourceScope: { workspace: h.source, fileOptions: {} },
        destinationScope: { workspace: h.destination, fileOptions: {} }, selections: fresh.selections,
        sourceObservation: observations[0], destinationObservation: observations[1] });
      const job: Job = { ...fresh, plan, expectedPlanId: plan.planId };
      const nativeRecords = observations.flatMap(observation => observation.privateNativeStates.map(state => {
        const binding = observation.nativeBindings.find(item => item.expected.documentId === state.documentId); assert(binding);
        return { lineageId: binding.expected.lineageId, state };
      }));
      const physical = await withPreparedWorkspacePathCopy({ sourceWorkspace: h.source, destinationWorkspace: h.destination,
        sourcePath, destinationPath: job.selections[0].destinationPath, sourceKind: 'regular_file', projectionPaths: [sourcePath],
        sourceProjectionPolicy: 'native-derived-leaves-v2' }, async cap => {
        const original = readPreparedWorkspacePathCopy(cap); assert.equal(original.version, 2); return [{ selectionIndex: 0, original }];
      });
      const metadata = await captureNativeCopyMetadataSnapshotOnConnection(h.connection, { plan, physical });
      const request = { kind: 'copy' as const, origin, selections: job.selections };
      const prepared = prepareNativeCopyStage({ operationId: job.operationId, request, plan, physical, nativeRecords, metadata });
      const legacy = decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
      assert.equal(legacy.version, 3); if (legacy.version !== 3) assert.fail('Actual historical Stage V3 required.');
      assert.equal(legacy.plan.version, 2); assert.equal(await journal.get(job.operationId), null); assert.equal(await row(job.operationId), undefined);
      await staging.stageNativeCopy({ operationId: job.operationId, request, plan, physical, nativeRecords, metadata });
      assert.deepEqual(await staging.loadNativeCopy(legacy.identity), legacy);
      await journal.prepare({ operationId: job.operationId, planId: plan.planId, sourceWorkspaceId: h.source.workspaceId,
        destinationWorkspaceId: h.destination.workspaceId, actor: { type: 'user', id: 'member' }, request,
        expectedStepCount: nativeCopyPhaseStepCount(legacy) });
      let born = false, fired = false;
      await h.withProbe(async event => {
        if (/^\s*INSERT INTO collaboration_native_copy_receipts\b/iu.test(event.text) && event.values.includes(job.operationId)) born = true;
        if (born && !fired && /^\s*COMMIT\s*$/iu.test(event.text)) { fired = true; throw new Error('Actual legacy Stage V3 B1 COMMIT ACK lost.'); }
      }, () => interrupted(job, 'NATIVE_COPY_COMMIT_UNCONFIRMED'));
      assert(fired); const initialBirth = await row(job.operationId); assert.equal(initialBirth.publication_status, 'native_committed');
      await h.metadata(h.source, sourcePath, { title: 'Later legitimate title after legacy V3 B1' });
      const result = await run(job); assert.equal(result.execution.status, 'complete'); assert.equal(result.alreadyKnown, true);
      const stored = await journal.get(job.operationId), completion = stored?.steps.find(step => step.stepKey === 'copy-completion'); assert(completion?.receiptJson);
      const body = JSON.parse(completion.receiptJson), ledger = await row(job.operationId);
      assert.equal(body.version, 2); assert.equal(body.coreV2StageDigest, legacy.coreV2StageDigest);
      assert.equal(ledger.publication_fingerprint, legacy.payloadSha256); assert.deepEqual(ledger.private_result, initialBirth.private_result);
      assert.deepEqual(body.metadata, nativeCopyMetadataCompletionWitness(legacy.metadata, Number(ledger.created_at)));
      assert.equal(legacy.payloadSha256, nativeCopyMetadataCompositeDigest(legacy.coreV2StageDigest, nativeCopyMetadataWitness(legacy.metadata)));
      assert.equal((await titles(h.destination.workspaceId, job.selections[0].destinationPath))[0].title, originalTitle);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0].n, 0);
      assert.equal(await staging.loadNativeCopyByOperationId(job.operationId), null);
      const before = await row(job.operationId); let writes = 0;
      const repeated = await h.withProbe(async event => { if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) writes++; }, () => run(job));
      assert.equal(repeated.execution.status, 'complete'); assert.equal(repeated.alreadyKnown, true); assert.equal(writes, 0);
      assert.deepEqual(await row(job.operationId), before); await h.metadata(h.source, sourcePath, { title: originalTitle });
      legacyCompletedJob = job; legacyCompletedStage = legacy;
    });
    await group('self-consistent CompletionV2/fence substitutions fail immutable C3 fingerprint or birth-time binding; malformed after-proof also fails', async () => {
      // Preserve the original adversarial V2 algorithm against a genuinely
      // stored old-format Stage V3, rather than inventing a V4 core digest.
      const completedJob = legacyCompletedJob, completedStage = legacyCompletedStage;
      assert(completedJob); const operation = await journal.get(completedJob.operationId), completion = operation?.steps.find(step => step.stepKey === 'copy-completion'); assert(completion?.receiptJson);
      const original = JSON.parse(completion.receiptJson), originalLedger = await row(completedJob.operationId);
      for (const field of ['snapshotProof', 'copyCreatedAt', 'afterIntentProof', 'coreV2StageDigest'] as const) {
        const body = structuredClone(original);
        if (field === 'coreV2StageDigest') body[field] = 'f'.repeat(64);
        else if (field === 'copyCreatedAt') { assert(completedStage?.version === 3); body.metadata = nativeCopyMetadataCompletionWitness(completedStage.metadata, body.metadata.copyCreatedAt + 1); }
        else body.metadata[field] = 'f'.repeat(64);
        const substitutedIdentity = field === 'snapshotProof' || field === 'coreV2StageDigest';
        const witness = { version: body.metadata.version, kind: body.metadata.kind, snapshotProof: body.metadata.snapshotProof,
          sourceRowCount: body.metadata.sourceRowCount, copiedTitleCount: body.metadata.copiedTitleCount };
        if (substitutedIdentity) {
          body.metadata.afterIntentProof = proof({ version: 1, kind: 'native-copy-title-after', metadataWitness: witness, copyCreatedAt: body.metadata.copyCreatedAt });
          body.stageDigest = nativeCopyMetadataCompositeDigest(body.coreV2StageDigest, witness);
          assert.notEqual(body.stageDigest, original.stageDigest);
        }
        const beforeFence = nativeCopyPhaseCompletionFence({ canonicalRequestHash: body.canonicalRequestHash, planId: body.planId, stageDigest: body.stageDigest });
        if (field !== 'afterIntentProof') {
          assert.deepEqual(decodeNativeCopyMetadataCompletionWitness(body.metadata), body.metadata);
          assert.equal(nativeCopyMetadataCompositeDigest(body.coreV2StageDigest, witness), body.stageDigest);
          if (!substitutedIdentity) assert.equal(body.stageDigest, completion.afterFence);
        }
        let observedPublicationFingerprint: string | undefined;
        await h.admin.query('UPDATE workspace_file_operation_steps SET receipt_json=$3,after_fence=$4,before_fence=$5 WHERE operation_id=$1 AND step_key=$2',
          [completedJob.operationId, 'copy-completion', JSON.stringify(body), body.stageDigest, beforeFence]);
        try {
          const expectedCode = substitutedIdentity ? 'NATIVE_COPY_HISTORY_SCOPE_CHANGED' : field === 'copyCreatedAt' ? 'NATIVE_COPY_PHASE_CHANGED' : 'NATIVE_COPY_METADATA_INVALID';
          await h.withProbe(async event => {
            if (/collaboration_native_copy_receipts/iu.test(event.text)) {
              const stored = event.result.rows.find(value => value.publication_fingerprint === originalLedger.publication_fingerprint);
              if (stored) observedPublicationFingerprint = stored.publication_fingerprint;
            }
          }, async () => { await assert.rejects(run(completedJob!), error => error instanceof Error && Reflect.get(error, 'code') === expectedCode); });
          if (substitutedIdentity || field === 'copyCreatedAt') assert.equal(observedPublicationFingerprint, originalLedger.publication_fingerprint);
          assert.deepEqual(await row(completedJob.operationId), originalLedger, 'The immutable C3 ledger/body/xmin are never modified by fixture substitutions or history reads.');
        } finally {
          await h.admin.query('UPDATE workspace_file_operation_steps SET receipt_json=$3,after_fence=$4,before_fence=$5 WHERE operation_id=$1 AND step_key=$2',
            [completedJob.operationId, 'copy-completion', completion.receiptJson, completion.afterFence, completion.beforeFence]);
          const restored: WorkspaceOperationStepRecord | undefined = (await journal.get(completedJob.operationId))?.steps.find(step => step.stepKey === 'copy-completion'); assert(restored);
          assert.equal(restored.receiptJson, completion.receiptJson); assert.equal(restored.beforeFence, completion.beforeFence); assert.equal(restored.afterFence, completion.afterFence);
        }
      }
      assert.equal((await run(completedJob)).execution.status, 'complete');
    });
    await group('fresh CompletionV3 rejects substituted Scene intent/birth/asset proofs without changing either immutable ledger', async () => {
      assert(completedJob && completedStage); assert.equal(completedStage.version, 4);
      const operation = await journal.get(completedJob.operationId), completion = operation?.steps.find(step => step.stepKey === 'copy-completion'); assert(completion?.receiptJson);
      const original = JSON.parse(completion.receiptJson); assert.equal(original.version, 3);
      const nativeBefore = await row(completedJob.operationId), sceneBefore = (await h.admin.query(
        'SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [completedJob.operationId])).rows;
      for (const field of ['sceneIntentProof', 'sceneBirthProof', 'assetReceiptProof'] as const) {
        const body = structuredClone(original); body[field] = 'f'.repeat(64);
        await h.admin.query('UPDATE workspace_file_operation_steps SET receipt_json=$3 WHERE operation_id=$1 AND step_key=$2',
          [completedJob.operationId, 'copy-completion', JSON.stringify(body)]);
        try {
          let writes = 0;
          await h.withProbe(async event => { if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) writes++; },
            () => assert.rejects(run(completedJob!), error => error instanceof Error && Reflect.get(error, 'code') === 'NATIVE_COPY_PHASE_CHANGED'));
          assert.equal(writes, 0); assert.deepEqual(await row(completedJob.operationId), nativeBefore);
          assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [completedJob.operationId])).rows, sceneBefore);
        } finally {
          await h.admin.query('UPDATE workspace_file_operation_steps SET receipt_json=$3 WHERE operation_id=$1 AND step_key=$2',
            [completedJob.operationId, 'copy-completion', completion.receiptJson]);
        }
      }
      const result = await run(completedJob); assert.equal(result.execution.status, 'complete'); assert.equal(result.alreadyKnown, true);
    });
    await group('genuine persisted V2 Stage uses the unchanged title-neutral recovery branch and never retrofits source title', async () => {
      const job = await newJob(sourcePath);
      const { readWorkspaceLinkSourceAuthorityOnConnection } = await import('../app/lib/markdown/workspace-source-authority-stage');
      const { withPreparedWorkspacePathCopy, readPreparedWorkspacePathCopy } = await import('../app/lib/filesystem/prepared-workspace-path-copy');
      const { createWorkspaceOperationNativeCopyPlanV1 } = await import('../app/lib/files/workspace-operation-native-copy-plan');
      const observations = await Promise.all([h.source, h.destination].map(workspace => readWorkspaceLinkSourceAuthorityOnConnection(h.connection, workspace)));
      // A historical Stage needs its historical plan even when today's preview
      // uses Managed V3. Construct V1 from these genuine observations, without changing
      // the current-owner factory or relaxing the Plan/Original version guard.
      const legacyPlan = createWorkspaceOperationNativeCopyPlanV1({ sourceScope: { workspace: h.source, fileOptions: {} },
        destinationScope: { workspace: h.destination, fileOptions: {} }, selections: job.selections,
        sourceObservation: observations[0], destinationObservation: observations[1] });
      const legacyJob: Job = { ...job, plan: legacyPlan, expectedPlanId: legacyPlan.planId };
      const nativeRecords = observations.flatMap(observation => observation.privateNativeStates.map(state => {
        const binding = observation.nativeBindings.find(item => item.expected.documentId === state.documentId); assert(binding);
        return { lineageId: binding.expected.lineageId, state };
      }));
      const physical = await withPreparedWorkspacePathCopy({ sourceWorkspace: h.source, destinationWorkspace: h.destination,
        sourcePath, destinationPath: job.selections[0].destinationPath, sourceKind: 'regular_file', projectionPaths: [sourcePath] },
      async cap => [{ selectionIndex: 0, original: readPreparedWorkspacePathCopy(cap) }]);
      // Explicit legacy serialized-data fixture from actual current C1/FD/state
      // observations. No Managed V3/Stage V4 header or foreign reservation exists here.
      // These data grant no current permission: the owner reauthenticates.
      const legacyId = job.operationId, request = { kind: 'copy' as const, origin, selections: job.selections };
      const prepared = prepareNativeCopyStage({ operationId: legacyId, request, plan: legacyPlan, physical, nativeRecords });
      const legacy = decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity); assert.equal(legacy.version, 2);
      assert.equal(legacy.plan.version, 1); assert.equal(legacy.physical[0].original.version, 1);
      assert.equal(await journal.get(legacyId), null); assert.equal(await row(legacyId), undefined);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_admission_requests r JOIN collaboration_admission_scopes s ON s.request_id=r.request_id WHERE s.workspace_id=$1 AND r.status NOT IN ($2,$3)', [h.destination.workspaceId, 'committed', 'cancelled'])).rows[0].n, 0);
      await staging.stageNativeCopy({ operationId: legacyId, request: legacy.request, plan: legacy.plan, physical: legacy.physical, nativeRecords: legacy.nativeRecords });
      const serialized = serializeWorkspaceOperationRequest(legacy.request);
      await journal.prepare({ operationId: legacyId, planId: legacy.plan.planId, sourceWorkspaceId: h.source.workspaceId, destinationWorkspaceId: h.destination.workspaceId,
        actor: { type: 'user', id: 'member' }, request: legacy.request, expectedStepCount: nativeCopyPhaseStepCount(legacy) });
      assert.equal(serialized.requestHash, legacy.identity.canonicalRequestHash);
      const result = await run(legacyJob); assert.equal(result.execution.status, 'complete', JSON.stringify(result.execution));
      const stored = await journal.get(legacyId), completion = stored?.steps.find(step => step.stepKey === 'copy-completion'); assert(completion?.receiptJson);
      assert.equal(JSON.parse(completion.receiptJson).version, 1);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [legacyId])).rows[0].n, 0);
      assert.equal((await titles(h.destination.workspaceId, legacyJob.selections[0].destinationPath)).length, 0);
      assert.equal((await titles(h.source.workspaceId, sourcePath))[0].title, 'Later legitimate source title');
      const originalLedger = await row(legacyId); let historicalWrites = 0;
      const repeated = await h.withProbe(async event => { if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) historicalWrites++; }, () => run(legacyJob));
      assert.equal(repeated.execution.status, 'complete'); assert.equal(repeated.alreadyKnown, true); assert.equal(historicalWrites, 0);
      assert.deepEqual(await row(legacyId), originalLedger); assert.equal(await staging.loadNativeCopyByOperationId(legacyId), null);
    });
    await group('real asset catalogue and stored-title SQL budget: 2048 rows fit; quote/backslash SQL JSON beyond1MiB is rejected before payload transfer', async () => {
      // A bounded SQL/format/real-FD probe, not 2048 native clones or a public
      // metadata API write. Historical rows are intentionally inserted directly.
      const folder = `budget-${crypto.randomUUID()}-${'x'.repeat(145)}`;
      await mkdir(path.join(h.source.rootPath, folder), { mode: 0o700 });
      const paths = [folder];
      for (let index = 0; index < 2047; index++) {
        const filePath = `${folder}/${String(index).padStart(4, '0')}.bin`;
        await writeFile(path.join(h.source.rootPath, filePath), Buffer.alloc(0), { mode: 0o600, flag: 'wx' }); paths.push(filePath);
      }
      const rows = paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(filePath => ({ path: filePath, title: 'Q'.repeat(160), createdAt: 100, updatedAt: 101 }));
      const setRows = async () => h.admin.query(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at)
        SELECT $1,x.path,x.title,x.created_at,x.updated_at FROM jsonb_to_recordset($2::jsonb)
        AS x(path text,title text,created_at bigint,updated_at bigint)
        ON CONFLICT(workspace_id,path) DO UPDATE SET title=excluded.title`, [h.source.workspaceId, JSON.stringify(rows.map(value => ({ path: value.path, title: value.title, created_at: value.createdAt, updated_at: value.updatedAt })))]);
      await setRows();
      const job = await newJob(folder, `budget-copy-${crypto.randomUUID()}`);
      assert.equal(job.plan.nativePathPlan.pathMappings.length, 2048);
      const { withPreparedWorkspacePathCopy, readPreparedWorkspacePathCopy, discardPreparedWorkspacePathCopy } = await import('../app/lib/filesystem/prepared-workspace-path-copy');
      const { captureNativeCopyMetadataSnapshotOnConnection } = await import('../app/lib/files/workspace-operation-native-copy-metadata');
      await withPreparedWorkspacePathCopy({ sourceWorkspace: h.source, destinationWorkspace: h.destination,
        sourcePath: folder, destinationPath: job.selections[0].destinationPath, sourceKind: 'directory' }, async cap => {
        try {
          const physical = [{ selectionIndex: 0, original: readPreparedWorkspacePathCopy(cap) }];
          const accepted = await captureNativeCopyMetadataSnapshotOnConnection(h.connection, { plan: job.plan, physical });
          assert.equal(accepted.sourceRows.length, 2048); assert(Buffer.byteLength(JSON.stringify(accepted)) < 1024 ** 2);
          const missing = 1024 ** 2 - 1 - Buffer.byteLength(JSON.stringify(accepted)); assert(missing > 0 && missing < rows.length * 160);
          let remaining = missing;
          for (const value of rows) { const count = Math.min(160, remaining); value.title = Array.from({ length: count }, (_, index) => index % 2 ? '\\' : '"').join('') + 'Q'.repeat(160 - count); remaining -= count; if (!remaining) break; }
          assert.equal(remaining, 0); await setRows();
          const negative = { ...accepted, sourceRows: rows };
          assert.equal(Buffer.byteLength(JSON.stringify(negative)), 1024 ** 2 - 1);
          const actualSqlBytes = Number((await h.admin.query(`SELECT octet_length(jsonb_agg(jsonb_build_object('path',path,'title',title,
            'createdAt',created_at,'updatedAt',updated_at) ORDER BY path COLLATE "C")::text) AS bytes FROM workspace_file_metadata
            WHERE workspace_id=$1 AND path=ANY($2::text[])`, [h.source.workspaceId, paths])).rows[0].bytes);
          assert(actualSqlBytes > 1024 ** 2);
          let boundedPayload: unknown = 'not-observed';
          const observed: SqlConnection = { ...h.connection, get: async (sql, values) => {
            const value = await h.connection.get(sql, values);
            if (sql.includes('WITH original AS MATERIALIZED') && value && typeof value === 'object') boundedPayload = Reflect.get(value, 'rows');
            return value;
          } };
          await assert.rejects(captureNativeCopyMetadataSnapshotOnConnection(observed, { plan: job.plan, physical }),
            error => error instanceof Error && Reflect.get(error, 'code') === 'NATIVE_COPY_METADATA_TOO_LARGE');
          assert.equal(boundedPayload, null, 'The actual SQL CASE gate must withhold oversized row JSON.');
          assert.equal(await row(job.operationId), undefined); assert.equal(await journal.get(job.operationId), null);
        } finally { await discardPreparedWorkspacePathCopy(cap); }
      });
      // Source SQL still fits; a much longer valid destination must fail its
      // maximum-after-row budget before any target publication or DB birth.
      for (const value of rows) value.title = 'Q'.repeat(160); await setRows();
      const longDestination = `after-${'y'.repeat(248)}/${'z'.repeat(240)}`;
      const longJob = await newJob(folder, longDestination);
      const maximumAfter = rows.map(value => ({ path: value.path === folder ? longDestination : longDestination + value.path.slice(folder.length),
        title: value.title, createdAt: Number.MAX_SAFE_INTEGER - 1, updatedAt: Number.MAX_SAFE_INTEGER - 1 }));
      assert(Buffer.byteLength(JSON.stringify(maximumAfter)) + 8 * maximumAfter.length > 1024 ** 2);
      await withPreparedWorkspacePathCopy({ sourceWorkspace: h.source, destinationWorkspace: h.destination,
        sourcePath: folder, destinationPath: longDestination, sourceKind: 'directory' }, async cap => {
        try {
          await assert.rejects(captureNativeCopyMetadataSnapshotOnConnection(h.connection, { plan: longJob.plan,
            physical: [{ selectionIndex: 0, original: readPreparedWorkspacePathCopy(cap) }] }),
          error => error instanceof Error && Reflect.get(error, 'code') === 'NATIVE_COPY_METADATA_TOO_LARGE');
          await assert.rejects(readFile(path.join(h.destination.rootPath, longDestination)), { code: 'ENOENT' });
          assert.equal(await row(longJob.operationId), undefined);
        } finally { await discardPreparedWorkspacePathCopy(cap); }
      });
    });
    assert.equal(groups, 15); console.log(JSON.stringify({ assertions: 'native-copy-metadata-owner', groups, pins }));
  }); } finally {
    for (const [file, hash] of Object.entries(pins)) assert.equal(crypto.createHash('sha256').update(await readFile(file)).digest('hex'), hash, `Source changed: ${file}`);
  }
  testCompleted = true;
  console.log(JSON.stringify({ test: 'workspace-operation-native-copy-metadata-owner-postgres-test', groups, sourcePinsUnchanged: true, fixtureCompleted: true }));
}
runNativeCopyMetadataOwnerPostgresTest().catch(error => {
  // Only a bounded safe summary; credentials, query params and raw bodies stay private.
  console.error(JSON.stringify({ failedCase: currentCase, groups, name: error instanceof Error ? error.name : typeof error,
    code: error instanceof Error && typeof Reflect.get(error, 'code') === 'string' ? Reflect.get(error, 'code') : null,
    diagnostic: nativeCopyMetadataFailureDiagnostic(error),
    assertion: error instanceof assert.AssertionError ? { actual: error.actual, expected: error.expected, operator: error.operator } : null }));
  process.exitCode = 1;
});
