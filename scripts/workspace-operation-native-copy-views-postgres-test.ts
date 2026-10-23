import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NativeCopyViewOutcome } from '../app/lib/files/workspace-operation-copy-view-finalizer';
import type { WorkspaceOperationManagedCopyPlan } from '../app/lib/files/workspace-operation-managed-copy-plan';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Actual authenticated Service/Owner, full PG18 migrations and FD stages.
// Only event delivery is observed; no principal, SQL result, COMMIT or private
// outcome is substituted. Cache entries below are explicit stale-view fixtures.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const digest = (value: Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
function failure(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error) || depth > 3) return { name: 'bounded' };
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value, cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
  return { name: error.name, code: typeof code === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(code) ? code : null,
    frames: error.stack?.split('\n').flatMap(line => {
      const match = /\/(app\/lib\/[A-Za-z0-9_./-]+|scripts\/[A-Za-z0-9_./-]+):(\d+):(\d+)\)?$/u.exec(line);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 4), ...(cause instanceof Error ? { cause: failure(cause, depth + 1) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.slice(0, 4).map(item => failure(item, depth + 1)) } : {}) };
}
async function nativeCopyViewsPostgresTest(): Promise<void> {
  const files = ['scripts/workspace-operation-native-copy-views-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-native-copy-owner.ts', 'app/lib/files/workspace-operation-native-copy-phase.ts',
    'app/lib/files/workspace-operation-copy-view-finalizer.ts', 'app/lib/files/workspace-file-operation-service.ts',
    'app/lib/files/workspace-operation-native-copy-public.ts', 'app/lib/api/route-helpers.ts',
    'app/lib/filesystem/file-watcher.ts', 'app/lib/utils/file-tree-cache.ts', 'app/lib/filesystem/file-reference-cache.ts',
    'app/lib/files/workspace-operation-native-copy-metadata.ts', 'app/lib/files/workspace-operation-native-copy-stage.ts',
    'app/lib/files/workspace-operation-native-copy-phase-contract.ts', 'app/lib/files/workspace-operation-native-copy-phase-read.ts',
    'app/lib/files/workspace-operation-staging.ts', 'app/lib/files/workspace-operation-journal.ts',
    'app/lib/workspaces/copy-principal.ts', 'app/lib/collaboration/native-copy-persistence.ts',
    'app/lib/collaboration/native-copy-historical-receipt.ts', 'app/lib/collaboration/markdown-file-import-persistence.ts',
    'scripts/workspace-operation-native-copy-owner-postgres-test.ts', 'scripts/workspace-operation-native-copy-metadata-owner-postgres-test.ts',
    'scripts/workspace-operation-original-delete-postgres-test.ts', 'scripts/workspace-operation-original-delete-metadata-postgres-test.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(file))])));
  console.log(JSON.stringify({ suite: 'native-copy-views', sourcePins: pins }));
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { previewWorkspaceNativeCopyOperation, executeWorkspaceNativeCopyOperation, readWorkspaceNativeCopyViewOutcome } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { executeWorkspaceFileOperationService } = await import('../app/lib/files/workspace-file-operation-service');
    const { fileTreeCache, buildFileTreeCacheKey } = await import('../app/lib/utils/file-tree-cache');
    await import('../app/lib/filesystem/file-reference-cache');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const journal = new WorkspaceOperationJournal();
    const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' },
      sourceWorkspace: h.source, destinationWorkspace: h.destination });
    const sourcePath = `views-source-${crypto.randomUUID()}.md`, sourceBytes = Buffer.from('# View source\n\nGenuine imported content.\n');
    const source = await h.upload(sourcePath, sourceBytes); await h.metadata(h.source, sourcePath, { title: 'Shared source title' });
    type Job = { operationId: string; selections: Array<{ sourcePath: string; destinationPath: string }>; plan: WorkspaceOperationManagedCopyPlan };
    const newJob = async (): Promise<Job> => {
      const selections = [{ sourcePath, destinationPath: `views-copy-${crypto.randomUUID()}.md` }];
      const plan = await previewWorkspaceNativeCopyOperation({ origin, request: await h.request(h.destination, 'member', true), selections });
      assert.equal(plan.version, 3);
      return { operationId: crypto.randomUUID(), selections, plan };
    };
    const service = async (job: Job) => executeWorkspaceFileOperationService({ kind: 'copy', operationId: job.operationId,
      expectedPlanId: job.plan.planId, selections: job.selections, request: await h.request(h.destination, 'member', true),
      source: { workspace: h.source, fileOptions: { workspace: h.source } },
      destination: { workspace: h.destination, fileOptions: { workspace: h.destination, mutationActorUserId: 'member' } },
      actorUserId: 'member', actorId: 'member', actorType: 'user', actorDisplayName: 'Actual view fixture member', actorSessionId: 'session-member' });
    const owner = async (job: Job) => executeWorkspaceNativeCopyOperation({ operationId: job.operationId, expectedPlanId: job.plan.planId,
      origin, request: await h.request(h.destination, 'member', true), selections: job.selections });
    const ledger = async (job: Job) => (await h.admin.query('SELECT publication_status,publication_fingerprint,created_at,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
    const receipt = async (job: Job) => (await h.admin.query("SELECT receipt_json,before_fence,after_fence,xmin::text AS xmin FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key='copy-completion'", [job.operationId])).rows[0];
    const sourceBefore = (await h.admin.query('SELECT yjs_state,state_vector,document_sequence,status FROM collaboration_yjs_states WHERE document_id=$1', [source.documentId])).rows[0];
    const runtime = globalThis as typeof globalThis & { __canvasFileWatcherService?: unknown };
    const previousWatcher = Object.getOwnPropertyDescriptor(runtime, '__canvasFileWatcherService');
    const events: Array<{ workspaceId: string; path: string; type: string }> = [];
    Object.defineProperty(runtime, '__canvasFileWatcherService', { configurable: true, writable: true,
      value: { publishMutation: (value: { workspace: { workspaceId: string }; relativePath: string; type: string }) => {
        events.push({ workspaceId: value.workspace.workspaceId, path: value.relativePath, type: value.type });
      } } });
    const references = Reflect.get(globalThis, Symbol.for('canvas.file-reference-cache.v2')) as {
      cacheEntries: Map<string, { entries: unknown[]; expiresAt: number }>; pendingBuilds: Map<string, Promise<unknown[]>> };
    assert(references?.cacheEntries instanceof Map); assert(references.pendingBuilds instanceof Map);
    const foreignWorkspaceId = `unrelated-view-${crypto.randomUUID()}`, workspaceIds = [h.source.workspaceId, h.destination.workspaceId, foreignWorkspaceId];
    const treeKeys = (id: string) => [buildFileTreeCacheKey('.', 1, id), buildFileTreeCacheKey('unrelated/nested', 3, id)];
    const seedViews = () => {
      for (const id of workspaceIds) {
        for (const key of treeKeys(id)) fileTreeCache.set(key, []);
        references.cacheEntries.set(id, { entries: [], expiresAt: Date.now() + 60_000 }); references.pendingBuilds.set(id, Promise.resolve([]));
      }
      return events.length;
    };
    const assertViews = (refreshed: boolean) => {
      for (const id of workspaceIds) {
        const retained = id !== h.destination.workspaceId || !refreshed;
        for (const key of treeKeys(id)) assert.equal(fileTreeCache.get(key) !== undefined, retained, `Cache scope ${id === h.destination.workspaceId ? 'target' : 'other'}`);
        assert.equal(references.cacheEntries.has(id), retained); assert.equal(references.pendingBuilds.has(id), retained);
      }
    };
    const assertPublic = (value: unknown) => {
      const json = JSON.stringify(value);
      for (const key of ['viewOutcome', 'publicationOutcome', 'nativeReceipt', 'snapshotProof', 'coreV2StageDigest', 'metadataSnapshot', 'afterIntentProof']) {
        assert.equal(json.includes(`"${key}"`), false, `Private field ${key} must not be returned by the common service.`);
      }
    };
    const assertCompleted = async (job: Job) => {
      const birth = await ledger(job), completion = await receipt(job); assert(birth && completion);
      assert.equal(birth.publication_status, 'published'); assert.equal((await journal.get(job.operationId))?.status, 'completed');
      assert.equal(completion.xmin, birth.xmin, 'Actual publication and completion share B2.');
      const target = (await h.admin.query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status=$3',
        [h.destination.workspaceId, job.selections[0].destinationPath, 'active'])).rows[0]; assert(target); assert.notEqual(target.id, source.documentId);
      return { birth, completion, target };
    };
    const assertFreshEvents = (before: number, job: Job) => assert.deepEqual(events.slice(before), [
      { workspaceId: h.destination.workspaceId, path: job.selections[0].destinationPath, type: 'add' }]);
    const group = async (name: string, action: () => Promise<void>) => { currentCase = name; await action(); groups++; console.log(`PASS native-copy-views ${groups}: ${name}`); };
    try {
      let first: Job | undefined;
      await group('fresh common service publishes once and invalidates only the genuine cross-workspace target', async () => {
        const job = await newJob(), before = seedViews(), result = await service(job);
        assert.equal(result.execution.status, 'complete'); assert.equal(result.alreadyKnown, false); assert.equal(result.copyViewsFinalized, true);
        await assertCompleted(job); assertFreshEvents(before, job); assertViews(true); assertPublic(result); first = job;
      });
      await group('completed history refreshes target caches without another add event or current-row mutation', async () => {
        assert(first); const original = await assertCompleted(first), before = seedViews(), result = await service(first);
        assert.equal(result.execution.status, 'complete'); assert.equal(result.alreadyKnown, true); assert.equal(result.plan, null);
        assert.equal(result.copyViewsFinalized, true); assert.equal(events.length, before); assertViews(true); assertPublic(result);
        assert.deepEqual(await assertCompleted(first), original);
      });
      await group('actual B2 rollback has no publication; pending alreadyKnown recovery publishes and refreshes views', async () => {
        const job = await newJob(), before = seedViews(); let fired = false;
        const interrupted = await h.withProbe(async event => {
          if (!fired && /^\s*INSERT\s+INTO\s+(?:"?\w+"?\.)?"?workspace_file_metadata\b/iu.test(event.text)
            && event.values[0] === h.destination.workspaceId && Array.isArray(event.values[1]) && event.values[1].includes(job.selections[0].destinationPath)) {
            fired = true; throw new Error('Owned actual B2 metadata INSERT acknowledgement failure.');
          }
        }, () => service(job));
        assert(fired); assert.equal(interrupted.execution.status, 'needs_recovery'); assert.equal(interrupted.execution.errorCode, 'NATIVE_COPY_PUBLICATION_UNCONFIRMED');
        assert.equal((await ledger(job)).publication_status, 'native_committed'); assert.equal(await receipt(job), undefined);
        assert.equal(events.length, before); assertViews(false); assertPublic(interrupted);
        const recovered = await service(job); assert.equal(recovered.alreadyKnown, true); assert.equal(recovered.execution.status, 'complete');
        await assertCompleted(job); assertFreshEvents(before, job); assertViews(true); assertPublic(recovered);
      });
      await group('actual B2 COMMIT followed by lost ACK makes no fresh claim; historical retry only invalidates caches', async () => {
        const job = await newJob(), before = seedViews(); let b2Write = false, fired = false;
        const interrupted = await h.withProbe(async event => {
          if (/^\s*INSERT\s+INTO\s+(?:"?\w+"?\.)?"?workspace_file_metadata\b/iu.test(event.text)
            && event.values[0] === h.destination.workspaceId && Array.isArray(event.values[1]) && event.values[1].includes(job.selections[0].destinationPath)) b2Write = true;
          if (b2Write && !fired && /^\s*COMMIT\s*$/iu.test(event.text) && (await ledger(job))?.publication_status === 'published') {
            fired = true; throw new Error('Owned actual B2 COMMIT acknowledgement loss.');
          }
        }, () => service(job));
        assert(fired); assert.equal(interrupted.execution.status, 'needs_recovery'); assert.equal(interrupted.execution.errorCode, 'NATIVE_COPY_COMMIT_UNCONFIRMED');
        const original = await assertCompleted(job); assert.equal(events.length, before); assertViews(false); assertPublic(interrupted);
        const recovered = await service(job); assert.equal(recovered.execution.status, 'complete'); assert.equal(recovered.alreadyKnown, true);
        assert.equal(events.length, before); assertViews(true); assert.deepEqual(await assertCompleted(job), original); assertPublic(recovered);
      });
      await group('successful B2 ACK retains proven publication when the following real Owner query fails', async () => {
        const job = await newJob(), before = seedViews(); let b2Write = false, acknowledged = false, fired = false;
        const interrupted = await h.withProbe(async event => {
          if (/^\s*INSERT\s+INTO\s+(?:"?\w+"?\.)?"?workspace_file_metadata\b/iu.test(event.text)
            && event.values[0] === h.destination.workspaceId && Array.isArray(event.values[1]) && event.values[1].includes(job.selections[0].destinationPath)) b2Write = true;
          if (b2Write && !acknowledged && /^\s*COMMIT\s*$/iu.test(event.text) && (await ledger(job))?.publication_status === 'published') {
            acknowledged = true; return; // The actual COMMIT resolves normally.
          }
          if (acknowledged && !fired && /^\s*SELECT\b/iu.test(event.text)) { fired = true; throw new Error('Owned query failure after confirmed B2 COMMIT.'); }
        }, () => service(job));
        assert(acknowledged && fired); assert.equal(interrupted.execution.status, 'needs_recovery');
        assert.equal(interrupted.execution.errorCode, 'NATIVE_COPY_COMMIT_UNCONFIRMED');
        const original = await assertCompleted(job); assertFreshEvents(before, job); assertViews(true); assertPublic(interrupted);
        const again = seedViews(), recovered = await service(job); assert.equal(recovered.execution.status, 'complete');
        assert.equal(events.length, again); assertViews(true); assert.deepEqual(await assertCompleted(job), original);
      });
      await group('real folder and created-parent facts bind exact Owner result objects; history has no fresh entries', async () => {
        const folder = `views-folder-${crypto.randomUUID()}`, parent = `views-parent-${crypto.randomUUID()}`, destination = `${parent}/copy`;
        const child = await h.upload(`${folder}/child.md`, Buffer.from('# Native folder child\n'));
        const childBefore = (await h.admin.query('SELECT yjs_state,state_vector,document_sequence,status FROM collaboration_yjs_states WHERE document_id=$1', [child.documentId])).rows[0];
        const selections = [{ sourcePath: folder, destinationPath: destination }];
        const plan = await previewWorkspaceNativeCopyOperation({ origin, request: await h.request(h.destination, 'member', true), selections });
        assert.equal(plan.version, 3);
        const job: Job = { operationId: crypto.randomUUID(), selections, plan }, before = events.length;
        const result = await owner(job), outcome = readWorkspaceNativeCopyViewOutcome(result);
        assert.equal(result.execution.status, 'complete'); const birth = await ledger(job), completion = await receipt(job);
        assert(birth && completion); assert.equal(birth.publication_status, 'published'); assert.equal(birth.xmin, completion.xmin);
        assert.equal((await journal.get(job.operationId))?.status, 'completed');
        assert.equal((await lstat(path.join(h.destination.rootPath, parent))).isDirectory(), true);
        assert.equal((await lstat(path.join(h.destination.rootPath, destination))).isDirectory(), true);
        const copiedChild = (await h.admin.query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status=$3',
          [h.destination.workspaceId, `${destination}/child.md`, 'active'])).rows[0]; assert(copiedChild); assert.notEqual(copiedChild.id, child.documentId);
        assert.deepEqual(outcome, { kind: 'published', destinationWorkspaceId: h.destination.workspaceId,
          entries: [{ path: parent, type: 'addDir' }, { path: destination, type: 'addDir' }, { path: `${destination}/child.md`, type: 'add' }] } satisfies NativeCopyViewOutcome);
        assert.equal(readWorkspaceNativeCopyViewOutcome({ ...result }), null);
        assert.equal(readWorkspaceNativeCopyViewOutcome(JSON.parse(JSON.stringify(outcome))), null);
        assert.equal(Object.hasOwn(result, 'viewOutcome'), false); assert.equal(events.length, before, 'Owner records facts; the common service delivers views.');
        const historical = await owner(job); assert.equal(historical.alreadyKnown, true);
        assert.deepEqual(readWorkspaceNativeCopyViewOutcome(historical), { kind: 'historical', destinationWorkspaceId: h.destination.workspaceId });
        assert.equal(events.length, before);
        assert.deepEqual((await h.admin.query('SELECT yjs_state,state_vector,document_sequence,status FROM collaboration_yjs_states WHERE document_id=$1', [child.documentId])).rows[0], childBefore);
      });
      assert.equal(groups, 6);
      assert.deepEqual((await h.admin.query('SELECT yjs_state,state_vector,document_sequence,status FROM collaboration_yjs_states WHERE document_id=$1', [source.documentId])).rows[0], sourceBefore);
    } finally {
      if (previousWatcher) Object.defineProperty(runtime, '__canvasFileWatcherService', previousWatcher); else Reflect.deleteProperty(runtime, '__canvasFileWatcherService');
      for (const id of workspaceIds) { for (const key of treeKeys(id)) fileTreeCache.delete(key); references.cacheEntries.delete(id); references.pendingBuilds.delete(id); }
    }
  }); }
  finally {
    const after = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(file))])));
    assert.deepEqual(after, pins, 'All direct sources and original suites retain their initial bytes.');
    console.log(JSON.stringify({ suite: 'native-copy-views', sourcesUnchanged: true, sourcePins: after }));
  }
  assert.equal(groups, 6); completed = true; console.log(JSON.stringify({ suite: 'native-copy-views', groups, passed: true }));
}
nativeCopyViewsPostgresTest().catch(error => { console.error(JSON.stringify({ suite: 'native-copy-views', currentCase, groups, passed: false, error: failure(error) })); process.exitCode = 1; });
