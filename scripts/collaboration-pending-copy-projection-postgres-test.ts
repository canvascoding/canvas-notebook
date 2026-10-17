/** PendingCopy projection/recovery regression: one owned PG18 fixture per mode/process.
 * Preserve actual Projector and original retry observations before safety assertions.
 * Invoke through the existing fenced private managed runner.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

type Fixture = Parameters<Parameters<typeof withNativeCopyMetadataOwnerFixture>[0]>[0];
const repo = path.resolve(process.cwd());
const modes = ['published-control', 'pending-control', 'pending-projector'] as const;
type Mode = typeof modes[number];
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const code = (error: unknown): string | null => {
  const value = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value) ? value : null;
};
async function fileObservation(filename: string) {
  try {
    const before = await lstat(filename); assert(before.isFile() && !before.isSymbolicLink());
    const bytes = await readFile(filename), after = await lstat(filename);
    const identity = ({ dev, ino, mode, uid, nlink, size, mtimeMs, ctimeMs }: typeof before) => ({ dev, ino, mode, uid, nlink, size, mtimeMs, ctimeMs });
    assert.deepEqual(identity(after), identity(before));
    return { present: true, identity: identity(after), bytesSha256: hash(bytes) };
  } catch (error) { if (code(error) === 'ENOENT') return { present: false }; throw error; }
}
async function annotationSnapshot(h: Fixture, workspaceId: string, file: string) {
  return {
    titles: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2 ORDER BY path', [workspaceId, file])).rows,
    personal: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2 ORDER BY user_id', [workspaceId, file])).rows,
  };
}
async function documentSnapshot(h: Fixture, workspaceId: string, file: string, root: string) {
  const documents = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 ORDER BY id', [workspaceId, file])).rows;
  const states = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2 ORDER BY document_id', [workspaceId, file])).rows;
  return { documents, states, annotations: await annotationSnapshot(h, workspaceId, file), file: await fileObservation(path.join(root, file)) };
}
async function main(): Promise<void> {
  assert.equal(process.argv.length, 4);
  const mode = process.argv[2] as Mode; assert(modes.includes(mode));
  const reportRoot = process.argv[3], rootStat = await lstat(reportRoot);
  assert(path.isAbsolute(reportRoot) && await realpath(reportRoot) === reportRoot && rootStat.isDirectory()
    && !rootStat.isSymbolicLink() && rootStat.uid === process.getuid?.() && (rootStat.mode & 0o777) === 0o700);
  const write = async (suffix: string, value: unknown) => writeFile(path.join(reportRoot, `${mode}-${suffix}.json`), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  const sourcePaths = ['scripts/helpers/native-copy-metadata-owner-fixture.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/files/workspace-operation-native-copy-phase.ts', 'app/lib/files/workspace-operation-native-copy-phase-contract.ts',
    'app/lib/files/workspace-operation-native-copy-stage.ts', 'app/lib/files/workspace-operation-staging.ts',
    'app/lib/collaboration/persistence.ts', 'app/lib/collaboration/checkpoint.ts', 'app/lib/collaboration/projection-repository.ts',
    'app/lib/collaboration/projection-identity.ts', 'app/lib/collaboration/room-admission.ts',
    'app/lib/files/collaboration-policy.ts', 'app/lib/files/collaboration-repository/document-repository.ts',
    'app/lib/files/collaboration-repository/transaction.ts', 'app/lib/files/collaboration-repository/lineage-revision-repository.ts',
    'app/lib/filesystem/workspace-files.ts', 'app/lib/secrets/file-mutation-lock.ts', 'app/lib/filesystem/prepared-workspace-path-copy.ts'];
  const pins = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await readFile(path.join(repo, file)))])));
  const beforePins = await pins(); await write('source-before', beforePins);
  try {
    await withNativeCopyMetadataOwnerFixture(async h => {
      const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
      const { previewWorkspaceNativeCopyOperation, executeWorkspaceNativeCopyOperation } = await import('../app/lib/files/workspace-operation-native-copy-owner');
      const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
      const { nativeCopyPhaseAdmissions } = await import('../app/lib/files/workspace-operation-native-copy-phase-contract');
      const { loadCollaborationState } = await import('../app/lib/collaboration/persistence');
      const { materializeCollaborationCheckpoint } = await import('../app/lib/collaboration/checkpoint');
      const { hasPendingCollaborationProjection, loadCollaborationProjectionWorkspace } = await import('../app/lib/collaboration/projection-repository');
      const { assertCollaborationAdmissionOpen, lockCollaborationAdmissionWorkspace } = await import('../app/lib/collaboration/room-admission');
      const { WORKSPACE_STARTER_DOCUMENT_NAME } = await import('../app/lib/workspaces/starter-document');
      const sourcePath = `projector-source-${randomUUID()}.md`, destinationPath = `projector-copy-${randomUUID()}.md`;
      const neighborPath = `projector-neighbor-${randomUUID()}.md`, sourceBytes = Buffer.from('# Original projector source\n\nStable native content.\n');
      const source = await h.upload(sourcePath, sourceBytes); await h.upload(neighborPath, Buffer.from('# Unrelated neighbor\n'));
      await h.metadata(h.source, sourcePath, { title: 'Original shared Copy title', isFavorite: true, pinned: true });
      const preservedBefore = await documentSnapshot(h, h.source.workspaceId, sourcePath, h.source.rootPath);
      const neighborBefore = await documentSnapshot(h, h.source.workspaceId, neighborPath, h.source.rootPath);
      const targetNeighborBefore = await documentSnapshot(h, h.destination.workspaceId, WORKSPACE_STARTER_DOCUMENT_NAME, h.destination.rootPath);
      const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' }, sourceWorkspace: h.source, destinationWorkspace: h.destination });
      const selections = [{ sourcePath, destinationPath }], plan = await previewWorkspaceNativeCopyOperation({ origin, selections, request: await h.request(h.destination, 'member', true) });
      const operationId = randomUUID();
      const owner = async () => executeWorkspaceNativeCopyOperation({ operationId, origin, selections, expectedPlanId: plan.planId, request: await h.request(h.destination, 'member', true) });
      const ledger = async () => (await h.admin.query(`SELECT workspace_id,operation_id,private_result,publication_status,
        request_fingerprint,publication_fingerprint,created_at,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2`, [h.destination.workspaceId, operationId])).rows[0];
      const steps = async () => (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_operation_steps WHERE operation_id=$1 ORDER BY step_key', [operationId])).rows;
      const header = async () => (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_operations WHERE operation_id=$1', [operationId])).rows;
      const assertUnrelated = async () => {
        assert.deepEqual(await documentSnapshot(h, h.source.workspaceId, sourcePath, h.source.rootPath), preservedBefore);
        assert.deepEqual(await documentSnapshot(h, h.source.workspaceId, neighborPath, h.source.rootPath), neighborBefore);
        assert.deepEqual(await documentSnapshot(h, h.destination.workspaceId, WORKSPACE_STARTER_DOCUMENT_NAME, h.destination.rootPath), targetNeighborBefore);
        assert.equal((await loadCollaborationState(source.documentId))?.documentId, source.documentId);
      };
      if (mode === 'published-control') {
        const result = await owner(); assert.equal(result.execution.status, 'complete');
        const birth = await ledger(); assert.equal(birth.publication_status, 'published');
        const cloneId = birth.private_result.documents[0].clone.documentId, state = await loadCollaborationState(cloneId); assert(state);
        const workspace = await loadCollaborationProjectionWorkspace(state); assert(workspace); assert.equal(workspace.workspaceId, h.destination.workspaceId);
        const beforeProjectionLedger = await ledger(), beforeProjectionHeader = await header(), beforeProjectionSteps = await steps();
        const output = await materializeCollaborationCheckpoint({ state, workspace, actorType: 'system' });
        const after = await loadCollaborationState(cloneId); assert(after);
        assert.deepEqual(after.yjsState, state.yjsState); assert.deepEqual(after.stateVector, state.stateVector); assert.equal(after.documentSequence, state.documentSequence);
        assert.deepEqual(await readFile(path.join(h.destination.rootPath, destinationPath)), Buffer.from(output.content));
        assert.equal(await hasPendingCollaborationProjection(after), false);
        const projection = (await h.admin.query('SELECT revision_id,finalized FROM collaboration_file_projections WHERE document_id=$1', [cloneId])).rows[0];
        assert.equal(Number(projection.finalized), 1); assert.equal(projection.revision_id, output.revisionId);
        assert.deepEqual(await ledger(), beforeProjectionLedger); assert.deepEqual(await header(), beforeProjectionHeader); assert.deepEqual(await steps(), beforeProjectionSteps);
        await assertUnrelated(); await write('observations', { publication: 'published', projected: true, cloneId, pendingAfter: false }); return;
      }
      let fired = false;
      const lost = Object.assign(new Error('Owned actual B1 COMMIT ACK loss for PendingCopy Projector probe.'), { code: 'EIO' });
      const interrupted = await h.withProbe(async event => {
        if (fired || !/^\s*COMMIT\s*$/iu.test(event.text)) return;
        const row = (await event.raw('SELECT private_result,publication_status FROM collaboration_native_copy_receipts WHERE operation_id=$1 AND workspace_id=$2', [operationId, h.destination.workspaceId])).rows[0];
        if (row?.publication_status !== 'native_committed') return;
        const paths = (await event.raw("SELECT step_key,status FROM workspace_file_operation_steps WHERE operation_id=$1 AND phase='path' ORDER BY step_key", [operationId])).rows;
        if (!paths.length || paths.some(value => value.status !== 'intent')) return;
        fired = true; throw lost; // Actual COMMIT already ran; only its acknowledgement is lost.
      }, owner);
      // Both awaits returned: no Projector invocation inherits an Owner/SQL-hook frame or lease.
      assert(fired); assert.equal(interrupted.execution.status, 'needs_recovery');
      assert.equal(interrupted.execution.errorCode, 'NATIVE_COPY_COMMIT_UNCONFIRMED');
      assert.equal((await header())[0].status, 'recovery_required');
      const birth = await ledger(); assert.equal(birth.publication_status, 'native_committed');
      const store = new WorkspaceOperationStaging(), stage = await store.loadNativeCopyByOperationId(operationId); assert(stage);
      assert.equal(stage.physical.length, 1); assert.equal(stage.physical[0].original.staging, null);
      assert((await steps()).some(step => step.step_key === 'copy-path:0' && step.status === 'intent'));
      assert(!(await steps()).some(step => step.step_key === 'copy-completion'));
      const initialCloneIds = birth.private_result.documents.map((document: { clone: { documentId: string } }) => document.clone.documentId);
      assert.equal(initialCloneIds.length, 1); const cloneId = initialCloneIds[0];
      const requests = nativeCopyPhaseAdmissions(stage, { ...birth.private_result, publicationStatus: 'native_committed' });
      assert(requests.length > 0); const requestIds = requests.map(value => value.requestId);
      const admissionRows = async () => ({
        requests: (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_admission_requests WHERE request_id=ANY($1::text[]) ORDER BY request_id', [requestIds])).rows,
        scopes: (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_admission_scopes WHERE request_id=ANY($1::text[]) ORDER BY request_id,ordinal', [requestIds])).rows,
        targets: (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_admission_targets WHERE request_id=ANY($1::text[]) ORDER BY request_id,document_id', [requestIds])).rows,
      });
      const pendingSnapshot = async () => ({ target: await documentSnapshot(h, h.destination.workspaceId, destinationPath, h.destination.rootPath),
        ledger: await ledger(), header: await header(), steps: await steps(), admissions: await admissionRows(),
        projections: (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_file_projections WHERE document_id=$1', [cloneId])).rows });
      const before = await pendingSnapshot(); assert.equal(before.target.file.present, false);
      assert.equal(before.admissions.requests.length, requests.length); assert(before.admissions.targets.some(row => row.document_id === cloneId && row.active === true));
      const query = async (sql: string, values?: unknown[]) => (await h.admin.query(sql, values)).rows;
      await h.admin.query('BEGIN');
      try {
        await lockCollaborationAdmissionWorkspace(query, h.destination.workspaceId);
        await assert.rejects(assertCollaborationAdmissionOpen(query, { workspaceId: h.destination.workspaceId, path: destinationPath, documentId: cloneId }), error => code(error) === 'ADMISSION_CONFLICT');
      } finally { await h.admin.query('ROLLBACK'); }
      const state = await loadCollaborationState(cloneId); assert(state); assert.equal(await hasPendingCollaborationProjection(state), true);
      const workspace = await loadCollaborationProjectionWorkspace(state); assert(workspace);
      assert.equal(workspace.workspaceId, h.destination.workspaceId); assert.equal(workspace.rootPath, h.destination.rootPath);
      let projectorResult: Awaited<ReturnType<typeof materializeCollaborationCheckpoint>> | undefined, projectorError: unknown;
      if (mode === 'pending-projector') try { projectorResult = await materializeCollaborationCheckpoint({ state, workspace, actorType: 'system' }); }
      catch (error) { projectorError = error; }
      const afterProjector = await pendingSnapshot();
      // Always attempt the original Owner retry BEFORE desired-safety assertions,
      // so the unfixed baseline preserves both actual Projector and retry results.
      let retryResult: Awaited<ReturnType<typeof owner>> | undefined, retryError: unknown;
      try { retryResult = await owner(); } catch (error) { retryError = error; }
      const afterRetry = await pendingSnapshot();
      await write('observations', { mode, operationId, initialCloneIds, admissionConflict: true, fired,
        projectorReturned: Boolean(projectorResult), projectorError: { name: projectorError instanceof Error ? projectorError.name : null, code: code(projectorError) },
        retry: retryResult?.execution ?? null, retryError: { name: retryError instanceof Error ? retryError.name : null, code: code(retryError) },
        before, afterProjector, afterRetry });
      console.log(JSON.stringify({ diagnostic: 'pending-copy-projector', mode, projectorReturned: Boolean(projectorResult),
        projectorCode: code(projectorError), targetBefore: before.target.file.present, targetAfterProjector: afterProjector.target.file.present,
        retryStatus: retryResult?.execution.status ?? null, retryCode: retryResult?.execution.errorCode ?? code(retryError) }));
      await assertUnrelated();
      // These are intended invariants. Baseline failure is retained as RED, never a feature PASS.
      assert.deepEqual(afterProjector, before, 'PendingCopy Projector must leave target bytes, projection receipts, native state, metadata, ledger, Journal and admission rows unchanged.');
      assert.equal(projectorResult, undefined, 'PendingCopy must not return a confirmed materialized checkpoint.');
      assert.equal(retryError, undefined); assert(retryResult); assert.equal(retryResult.execution.status, 'complete');
      assert.equal(retryResult.alreadyKnown, true); assert.equal(afterRetry.ledger.publication_status, 'published');
      assert.deepEqual(afterRetry.ledger.private_result, birth.private_result);
      for (const field of ['request_fingerprint', 'publication_fingerprint', 'created_at']) assert.equal(afterRetry.ledger[field], birth[field]);
      assert.deepEqual(afterRetry.ledger.private_result.documents.map((document: { clone: { documentId: string } }) => document.clone.documentId), initialCloneIds);
      assert.equal(afterRetry.header[0].status, 'completed'); assert(afterRetry.steps.some(step => step.step_key === 'copy-completion' && step.status === 'applied'));
      assert.equal(afterRetry.target.annotations.titles.length, 1); assert.equal(afterRetry.target.annotations.titles[0].title, 'Original shared Copy title');
      assert.deepEqual(afterRetry.target.annotations.personal, []);
      assert(afterRetry.admissions.requests.every(row => row.status === 'committed' && typeof row.outcome_text === 'string'));
      assert(afterRetry.admissions.targets.every(row => row.active === false));
    });
  } finally { const afterPins = await pins(); await write('source-after', afterPins); assert.deepEqual(afterPins, beforePins); }
  console.log(JSON.stringify({ suite: 'pending-copy-projector-draft', case: mode, passed: true }));
}
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
void main().then(() => { completed = true; }).catch(error => {
  console.error(JSON.stringify({ suite: 'pending-copy-projector-draft', passed: false,
    name: error instanceof Error ? error.name : 'unknown', code: code(error) })); process.exitCode = 1;
});
