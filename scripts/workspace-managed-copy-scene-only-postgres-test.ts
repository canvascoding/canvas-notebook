import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { ExcalidrawCopyIntent, ExcalidrawCopyBirthReceipt } from '../app/lib/excalidraw-collaboration/copy-contract';
import type { ExcalidrawAssetMetadata } from '../app/lib/excalidraw-collaboration/protocol';
import type { WorkspaceOperationManagedCopyStageV4 } from '../app/lib/files/workspace-operation-managed-copy-stage';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Genuine zero-Yjs workspaces, member Cookie and the ordinary Copy service.
// Only private fixture setup and actual SQL acknowledgement observations vary.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const xid32 = (value: string) => (BigInt(value) & BigInt('4294967295')).toString();
type Witness = { pid: number; xid: string };

async function managedCopySceneOnlyPostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const files = ['scripts/workspace-managed-copy-scene-only-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-file-operation-service.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/files/workspace-operation-native-copy-phase.ts', 'app/lib/files/workspace-operation-native-copy-phase-contract.ts',
    'app/lib/files/workspace-operation-native-copy-phase-read.ts', 'app/lib/files/workspace-operation-native-copy-graph.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/files/workspace-operation-staging.ts',
    'app/lib/excalidraw-collaboration/copy-domain.ts', 'app/lib/excalidraw-collaboration/copy-data.ts',
    'app/lib/excalidraw-collaboration/copy-history.ts', 'app/lib/excalidraw-collaboration/copy-asset-publication.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(file))])));
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { executeWorkspaceFileOperationService: service } = await import('../app/lib/files/workspace-file-operation-service');
    const { previewWorkspaceNativeCopyOperation: preview } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { captureExcalidrawCopyIntent, captureExcalidrawCopyBirthReceipt } = await import('../app/lib/excalidraw-collaboration/copy-data');
    const { importExcalidrawDocumentFile: importScene } = await import('../app/lib/excalidraw-collaboration/portable-import');
    const { serializePortableExcalidrawSceneFromReadonlyAssets: portable } = await import('../app/lib/excalidraw-collaboration/portable-serialization');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { createPostgresWorkspaceForActor, readPostgresWorkspaceForActorOnConnection,
      upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { WORKSPACE_STARTER_DOCUMENT_NAME } = await import('../app/lib/workspaces/starter-document');
    const { readWorkspaceStarterInitializationIntent } = await import('../app/lib/workspaces/starter-document-initialization-store');
    const owner = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
    const member = resolveWorkspaceActor({ id: 'member', role: 'user', email: 'member@principal.test' });
    const sourceOwner = await createPostgresWorkspaceForActor(owner, { type: 'team', name: `Scene-only source ${crypto.randomUUID()}` });
    const destinationOwner = await createPostgresWorkspaceForActor(owner, { type: 'team', name: `Scene-only destination ${crypto.randomUUID()}` });
    await upsertPostgresWorkspaceMemberForActor(owner, sourceOwner.workspaceId, { userId: 'member', canRead: true, canWrite: false, canManage: false });
    await upsertPostgresWorkspaceMemberForActor(owner, destinationOwner.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    const source = await readPostgresWorkspaceForActorOnConnection(h.connection, member, sourceOwner.workspaceId);
    const destination = await readPostgresWorkspaceForActorOnConnection(h.connection, member, destinationOwner.workspaceId); assert(source && destination);
    assert(source.permissions.canRead && !source.permissions.canWrite); assert(destination.permissions.canRead && destination.permissions.canWrite);
    const workspaceIds = [source.workspaceId, destination.workspaceId];
    const noYjs = async () => {
      const rows = (await h.admin.query(`SELECT w.id,
        (SELECT count(*)::integer FROM collaboration_yjs_states s WHERE s.workspace_id=w.id) AS states,
        (SELECT count(*)::integer FROM collaboration_documents d WHERE d.workspace_id=w.id AND d.provider='yjs') AS documents
        FROM canvas_workspaces w WHERE w.id=ANY($1::text[]) ORDER BY w.id`, [workspaceIds])).rows;
      assert.equal(rows.length, 2); for (const row of rows) { assert.equal(row.states, 0); assert.equal(row.documents, 0); }
    };
    // The shared fixture initializes its own starter notebooks. These separate
    // real workspaces have never initialized a starter. Remove only their exact
    // newly observed starter files; immutable SQL expectations remain untouched.
    const starters = [];
    for (const selected of [source, destination]) {
      const intent = await readWorkspaceStarterInitializationIntent(h.connection, selected.workspaceId); assert(intent);
      assert.equal(intent.seedDisposition, 'created'); assert.equal(intent.path, WORKSPACE_STARTER_DOCUMENT_NAME);
      const filename = path.join(selected.rootPath, intent.path), bytes = await fs.readFile(filename), info = await fs.lstat(filename);
      assert(info.isFile() && !info.isSymbolicLink()); assert.equal(sha(bytes), intent.sourceSha256); assert.equal(bytes.length, intent.sourceBytes);
      assert.deepEqual(await fs.readdir(selected.rootPath), [intent.path]); await noYjs();
      await fs.unlink(filename); assert.deepEqual(await fs.readdir(selected.rootPath), []);
      starters.push({ workspaceId: selected.workspaceId, intent });
    }
    const actor = { userId: 'owner', actorId: 'owner', actorType: 'user' as const, sessionId: 'session-owner' };
    const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' },
      sourceWorkspace: source, destinationWorkspace: destination });
    const journal = new WorkspaceOperationJournal(), staging = new WorkspaceOperationStaging();
    const absent = async (filename: string) => assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
    const rows = async (workspaceId: string) => (await h.admin.query(`
      SELECT 'scene' AS kind,document_id AS id,to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_excalidraw_states s WHERE workspace_id=$1
      UNION ALL SELECT 'registry',id,to_jsonb(d)::text,xmin::text FROM collaboration_documents d WHERE workspace_id=$1
      UNION ALL SELECT 'lineage',id,to_jsonb(l)::text,xmin::text FROM file_collaboration_lineages l WHERE workspace_id=$1
      UNION ALL SELECT 'asset',file_id,to_jsonb(a)::text,xmin::text FROM collaboration_excalidraw_assets a WHERE workspace_id=$1
      ORDER BY kind,id`, [workspaceId])).rows;
    const ledger = async (operationId: string) => (await h.admin.query(
      'SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
    const nativeLedger = async (operationId: string) => (await h.admin.query(
      'SELECT *,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
    const blobPath = (workspaceId: string, hash: string) => path.join(h.dataRoot, 'collaboration-assets/excalidraw', sha(workspaceId).slice(0, 32), hash);
    const file = async (filename: string) => {
      const info = await fs.lstat(filename); assert(info.isFile() && !info.isSymbolicLink());
      return { dev: String(info.dev), ino: String(info.ino), mode: info.mode, nlink: info.nlink,
        size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, bytes: (await fs.readFile(filename)).toString('base64') };
    };
    const storedScene = async (documentId: string) => {
      const row = (await h.admin.query(`SELECT d.lineage_id,s.* FROM collaboration_documents d
        JOIN collaboration_excalidraw_states s ON s.document_id=d.id WHERE d.id=$1`, [documentId])).rows[0]; assert(row); return row;
    };
    type Scene = { documentId: string; sourcePath: string; destinationPath: string; lineageId: string;
      state: Awaited<ReturnType<typeof storedScene>>; expectedPortable: string };
    const scene = async (sourcePath: string, destinationPath: string, content: string, png?: Buffer): Promise<Scene> => {
      const imported = await importScene({ workspace: sourceOwner, actor, path: sourcePath, content });
      const state = await storedScene(imported.documentId); assert.equal(state.status, 'active');
      const expectedPortable = portable({ elements: state.elements_json, appState: state.shared_app_state_json,
        assets: state.assets_json, canonicalHash: state.canonical_hash }, state.assets_json.map((metadata: ExcalidrawAssetMetadata) => {
        assert(png); return { metadata, bytes: png };
      }));
      await fs.unlink(path.join(source.rootPath, sourcePath));
      return { documentId: imported.documentId, sourcePath, destinationPath, lineageId: state.lineage_id, state, expectedPortable };
    };
    const job = async (sourcePath: string, destinationPath: string, scenes: Scene[]) => {
      const selections = [{ sourcePath, destinationPath }], request = await h.request(destination, 'member', true);
      assert(request.headers.get('cookie')); assert.equal(request.headers.get('authorization'), null);
      const plan = await preview({ origin, request, selections }); assert.equal(plan.version, 3);
      assert.equal(plan.cloneRequirements.length, 0); assert.equal(plan.sourceEvidence.nativeBindings.length, 0);
      assert.equal(plan.destinationEvidence.nativeBindings.length, 0); assert.equal(plan.sceneCopyRequirements.length, scenes.length);
      return { operationId: crypto.randomUUID(), plan, selections, destinationPath, scenes };
    };
    type Job = Awaited<ReturnType<typeof job>>;
    type Evidence = { stage?: WorkspaceOperationManagedCopyStageV4; intent?: ExcalidrawCopyIntent; birth?: ExcalidrawCopyBirthReceipt;
      b1?: Witness; writes: Array<Witness & { table: string }> };
    const run = async (selected: Job) => service({ kind: 'copy', operationId: selected.operationId, expectedPlanId: selected.plan.planId,
      selections: selected.selections, request: await h.request(destination, 'member', true),
      source: { workspace: source, fileOptions: { workspace: source } },
      destination: { workspace: destination, fileOptions: { workspace: destination, mutationActorUserId: 'member' } },
      actorUserId: 'member', actorId: 'member', actorSessionId: 'session-member', actorType: 'user', actorDisplayName: 'Actual Scene-only member' });
    const capture = async (selected: Job) => {
      const evidence: Evidence = { writes: [] };
      const result = await h.withProbe(async (event: MetadataSqlEvent) => {
        const table = /^\s*(?:INSERT\s+INTO|UPDATE)\s+(?:"?\w+"?\.)?"?(\w+)\b/iu.exec(event.text)?.[1];
        const belongs = event.values.includes(selected.operationId);
        const witness = async (): Promise<Witness> => {
          const row = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
          assert(Number.isSafeInteger(row.pid)); assert.match(row.xid, /^[1-9][0-9]*$/u); return { pid: row.pid, xid: row.xid };
        };
        if (!evidence.stage && table === 'collaboration_native_copy_receipts' && belongs) {
          const original = await staging.loadManagedCopyByOperationId(selected.operationId); assert(original); evidence.stage = original;
          assert.equal(original.version, 4); assert.deepEqual(original.nativeRecords, []); assert.equal(original.sceneRecords.length, selected.scenes.length);
        }
        if (table === 'collaboration_excalidraw_copy_receipts' && belongs && /^\s*INSERT\b/iu.test(event.text)) {
          const row = (await event.raw('SELECT intent_json,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [selected.operationId])).rows[0];
          evidence.intent = captureExcalidrawCopyIntent(row.intent_json); evidence.b1 = await witness();
          assert.equal(row.xmin, xid32(evidence.b1.xid)); assert.equal(evidence.intent.b1TransactionId, evidence.b1.xid);
          const native = (await event.raw('SELECT private_result,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [selected.operationId])).rows[0];
          assert.equal(native.xmin, row.xmin); assert.deepEqual(native.private_result.documents, []);
          assert(evidence.stage); assert.equal(evidence.intent.stageDigest, evidence.stage.payloadSha256);
          for (const doc of evidence.intent.documents) {
            const query = `SELECT id FROM collaboration_documents WHERE id=$1 UNION ALL SELECT id FROM file_collaboration_lineages WHERE id=$2
              UNION ALL SELECT document_id FROM collaboration_excalidraw_states WHERE document_id=$1`;
            assert.equal((await event.raw(query, [doc.documentId, doc.lineageId])).rows.length, 0);
            assert.equal((await h.admin.query(query, [doc.documentId, doc.lineageId])).rows.length, 0);
          }
          assert.equal((await event.raw('SELECT count(*)::integer AS n FROM collaboration_yjs_states WHERE workspace_id=ANY($1::text[])', [workspaceIds])).rows[0].n, 0);
          await noYjs();
        }
        const intent = evidence.intent;
        if (intent && table) {
          const ids = intent.documents.flatMap(doc => [doc.documentId, doc.lineageId]);
          if (['collaboration_documents', 'file_collaboration_lineages', 'collaboration_excalidraw_states'].includes(table)
            && event.values.some(value => ids.includes(String(value)))) evidence.writes.push({ table, ...await witness() });
          if (table === 'collaboration_excalidraw_assets' && event.values.includes(destination.workspaceId)
            && event.values.some(value => intent.assetOriginal.metadata.some(metadata => metadata.fileId === value))) evidence.writes.push({ table, ...await witness() });
          if (belongs && table === 'collaboration_excalidraw_copy_receipts' && /^\s*UPDATE\b/iu.test(event.text)) {
            const row = (await event.raw('SELECT birth_json FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [selected.operationId])).rows[0];
            if (row?.birth_json) { evidence.birth = captureExcalidrawCopyBirthReceipt(row.birth_json); evidence.writes.push({ table, ...await witness() }); }
          }
          if (belongs && table === 'collaboration_native_copy_receipts' && /^\s*UPDATE\b/iu.test(event.text)) evidence.writes.push({ table, ...await witness() });
          if (belongs && table === 'workspace_file_operations') {
            const row = (await event.raw('SELECT status FROM workspace_file_operations WHERE operation_id=$1', [selected.operationId])).rows[0];
            if (row?.status === 'completed') evidence.writes.push({ table, ...await witness() });
          }
        }
      }, () => run(selected));
      return { result, evidence };
    };
    const complete = async (selected: Job, attempt: Awaited<ReturnType<typeof capture>>) => {
      const { result, evidence } = attempt; assert.equal(result.execution.status, 'complete', String(result.execution.errorCode));
      assert.equal(result.alreadyKnown, false); assert.equal(result.copyViewsFinalized, true); assert.deepEqual(result.copied, [selected.destinationPath]);
      assert(evidence.stage && evidence.intent && evidence.birth && evidence.b1);
      const original = evidence.stage, row = await ledger(selected.operationId); assert(row?.birth_json);
      const intent = captureExcalidrawCopyIntent(row.intent_json), birth = captureExcalidrawCopyBirthReceipt(row.birth_json);
      assert.deepEqual(intent, evidence.intent); assert.deepEqual(birth, evidence.birth); assert.equal(intent.documents.length, selected.scenes.length);
      assert.equal(row.xmin, xid32(birth.b2TransactionId)); assert.notEqual(birth.b2TransactionId, evidence.b1.xid);
      assert.equal(intent.nativeRequestFingerprint, (await nativeLedger(selected.operationId)).request_fingerprint);
      const native = await nativeLedger(selected.operationId); assert.equal(native.publication_status, 'published'); assert.equal(native.xmin, row.xmin);
      assert.deepEqual(native.private_result.documents, []); assert.deepEqual(original.nativeRecords, []);
      const operation = await journal.get(selected.operationId); assert(operation); assert.equal(operation.status, 'completed');
      assert.equal(operation.steps.length, operation.expectedStepCount); assert(operation.steps.every(step => step.status === 'applied'));
      const completion = operation.steps.find(step => step.stepKey === 'copy-completion'); assert(completion?.receiptJson);
      const body = JSON.parse(completion.receiptJson); assert.equal(body.version, 3); assert.equal(body.stageDigest, original.payloadSha256);
      assert.equal(body.sceneIntentProof, intent.intentDigest); assert.equal(body.sceneBirthProof, birth.receiptProof);
      assert.equal(body.assetReceiptProof, birth.assetReceipt.receiptProof);
      const closing = (await h.admin.query(`SELECT xmin::text AS xmin FROM workspace_file_operations WHERE operation_id=$1
        UNION ALL SELECT xmin::text FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key='copy-completion'`, [selected.operationId])).rows;
      assert.equal(closing.length, 2); assert(closing.every(value => value.xmin === row.xmin));
      assert(evidence.writes.length); const first = evidence.writes[0];
      assert(evidence.writes.every(value => value.pid === first.pid && value.xid === birth.b2TransactionId)); assert.equal(first.pid, evidence.b1.pid);
      for (const table of ['collaboration_documents', 'file_collaboration_lineages', 'collaboration_excalidraw_states']) {
        assert.equal(evidence.writes.filter(value => value.table === table).length, selected.scenes.length);
      }
      for (const table of ['collaboration_excalidraw_copy_receipts', 'collaboration_native_copy_receipts', 'workspace_file_operations']) {
        assert.equal(evidence.writes.filter(value => value.table === table).length, 1);
      }
      const sourceIds = new Set(selected.scenes.map(value => value.documentId)), sourceLineages = new Set(selected.scenes.map(value => value.lineageId));
      const newIds = new Set<string>(), newLineages = new Set<string>();
      for (const expected of selected.scenes) {
        const doc = intent.documents.find(value => value.sourceDocumentId === expected.documentId); assert(doc);
        assert.equal(doc.sourceWorkspaceId, source.workspaceId); assert.equal(doc.destinationWorkspaceId, destination.workspaceId);
        assert.equal(doc.sourcePath, expected.sourcePath); assert.equal(doc.destinationPath, expected.destinationPath);
        assert.equal(doc.sourceLineageId, expected.lineageId); assert.equal(doc.sourceGeneration, Number(expected.state.lifecycle_generation));
        assert.equal(doc.sourceSceneSequence, Number(expected.state.scene_sequence)); assert.equal(doc.sourceCanonicalHash, expected.state.canonical_hash);
        assert(!sourceIds.has(doc.documentId) && !sourceLineages.has(doc.lineageId));
        const originalScene = original.sceneRecords.find(value => value.header.id === expected.documentId); assert(originalScene);
        assert.equal(doc.sourceContentProof, originalScene.contentProof);
        assert(!newIds.has(doc.documentId) && !newLineages.has(doc.lineageId)); newIds.add(doc.documentId); newLineages.add(doc.lineageId);
        const target = (await h.admin.query(`SELECT d.provider,d.state_version,d.lineage_id,d.xmin::text AS registry_xmin,l.xmin::text AS lineage_xmin,
          l.created_at AS lineage_created_at,s.*,s.xmin::text AS scene_xmin FROM collaboration_documents d
          JOIN file_collaboration_lineages l ON l.id=d.lineage_id JOIN collaboration_excalidraw_states s ON s.document_id=d.id WHERE d.id=$1`, [doc.documentId])).rows[0]; assert(target);
        assert.equal(target.provider, 'excalidraw'); assert.equal(target.lineage_id, doc.lineageId); assert.equal(target.workspace_id, destination.workspaceId);
        assert.equal(target.path, expected.destinationPath); assert.equal(Number(target.state_version), 0); assert.equal(Number(target.lifecycle_generation), 1);
        assert.equal(Number(target.scene_sequence), 0); assert.equal(Number(target.checkpoint_sequence), 0);
        assert.equal(target.registry_xmin, row.xmin); assert.equal(target.lineage_xmin, row.xmin); assert.equal(target.scene_xmin, row.xmin);
        assert.equal(target.canonical_hash, expected.state.canonical_hash); assert.deepEqual(target.elements_json, expected.state.elements_json);
        assert.deepEqual(target.shared_app_state_json, expected.state.shared_app_state_json); assert.deepEqual(target.assets_json, expected.state.assets_json);
        for (const field of ['checkpoint_revision_id', 'checkpoint_content_hash', 'checkpointed_at', 'degraded_reason']) assert.equal(target[field], null);
        const receipt = birth.documents.find(value => value.documentId === doc.documentId); assert(receipt);
        assert.equal(Number(target.persisted_at), receipt.persistedAt); assert.equal(Number(target.lineage_created_at), receipt.persistedAt);
        const derived = original.physical.flatMap(value => value.original.version === 3 ? value.original.derivedFiles : []).find(value => value.documentId === expected.documentId); assert(derived);
        assert.equal(derived.sha256, sha(expected.expectedPortable)); assert.equal(derived.sizeBytes, Buffer.byteLength(expected.expectedPortable));
        assert.deepEqual(await fs.readFile(path.join(destination.rootPath, expected.destinationPath)), Buffer.from(expected.expectedPortable));
        await absent(path.join(source.rootPath, expected.sourcePath));
      }
      assert.equal(await staging.loadManagedCopyByOperationId(selected.operationId), null); await noYjs(); return { birth, original };
    };
    const history = async (selected: Job) => {
      const before = { source: await rows(source.workspaceId), destination: await rows(destination.workspaceId),
        ledger: await ledger(selected.operationId), native: await nativeLedger(selected.operationId), journal: await journal.get(selected.operationId) };
      const targets = await Promise.all(selected.scenes.map(async value => [value.destinationPath, await file(path.join(destination.rootPath, value.destinationPath))] as const));
      const clients = new Set<PoolClient>(); let historicalQueries = 0, writes = 0, currentReads = 0;
      const result = await h.withProbe(async event => {
        if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) writes++;
        const current = /(?:FROM|JOIN)\s+(?:"?\w+"?\.)?"?(?:collaboration_excalidraw_states|collaboration_excalidraw_assets|collaboration_documents|file_collaboration_lineages|collaboration_yjs_states)\b/iu.test(event.text);
        if (current) currentReads++;
        if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/iu.test(event.text)) clients.add(event.client);
        if (clients.has(event.client)) {
          assert(!/FOR\s+(?:UPDATE|SHARE)|pg_current_xact_id\s*\(/iu.test(event.text)); assert.equal(current, false);
          if (/^COMMIT$/iu.test(event.text)) {
            assert.equal((await event.raw('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0].xid, null);
            clients.delete(event.client);
          } else {
            const actual = (await event.raw(`SELECT pg_current_xact_id_if_assigned()::text AS xid,
              current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only`)).rows[0];
            assert.deepEqual(actual, { xid: null, isolation: 'repeatable read', read_only: 'on' });
          }
          historicalQueries++;
        }
      }, () => run(selected));
      assert.equal(result.execution.status, 'complete'); assert.equal(result.alreadyKnown, true); assert.equal(result.plan, null);
      assert.deepEqual(result.copied, [selected.destinationPath]);
      assert.equal(writes, 0); assert.equal(currentReads, 0); assert(historicalQueries > 3); assert.equal(clients.size, 0);
      assert.deepEqual({ source: await rows(source.workspaceId), destination: await rows(destination.workspaceId),
        ledger: await ledger(selected.operationId), native: await nativeLedger(selected.operationId), journal: await journal.get(selected.operationId) }, before);
      for (const [name, previous] of targets) assert.deepEqual(await file(path.join(destination.rootPath, name)), previous);
      await noYjs();
    };
    const group = async (name: string, operation: () => Promise<void>) => { currentCase = name; await operation(); groups++;
      console.log(`PASS managed-copy-scene-only ${groups}: ${name}`); };
    await group('empty initialized Scene copies from READ-only source with no projection and no Yjs into a genuine B2 birth and history', async () => {
      await noYjs(); const sourcePath = 'empty.excalidraw', destinationPath = 'empty-copy.excalidraw';
      const empty = await scene(sourcePath, destinationPath, JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }));
      assert.deepEqual(empty.state.elements_json, []); assert.deepEqual(empty.state.assets_json, []); assert.equal(Number(empty.state.scene_sequence), 0);
      const before = await rows(source.workspaceId); assert.deepEqual(await fs.readdir(source.rootPath), []);
      const selected = await job(sourcePath, destinationPath, [empty]), attempt = await capture(selected);
      const { birth, original } = await complete(selected, attempt);
      assert.deepEqual(original.sceneAssets, []); assert.deepEqual(birth.intent.assetOriginal.metadata, []); assert.deepEqual(birth.assetReceipt.blobs, []);
      assert.equal(attempt.evidence.writes.filter(value => value.table === 'collaboration_excalidraw_assets').length, 0);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_excalidraw_assets WHERE workspace_id=$1', [destination.workspaceId])).rows[0].n, 0);
      assert.deepEqual(await rows(source.workspaceId), before); assert.deepEqual(await fs.readdir(source.rootPath), []); await history(selected);
    });
    await group('registry-only folder copies two Scenes sharing one PNG into two new identities and one exact target asset/blob', async () => {
      await noYjs(); const root = 'virtual-scenes', destinationPath = 'virtual-copy', assetId = `shared-${crypto.randomUUID()}`;
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      const content = (id: string) => JSON.stringify({ type: 'excalidraw', version: 2,
        elements: [{ id, type: 'image', fileId: assetId, version: 1, versionNonce: 1, isDeleted: false }], appState: {},
        files: { [assetId]: { id: assetId, mimeType: 'image/png', dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 123, version: 2 } } });
      await fs.mkdir(path.join(source.rootPath, root), { mode: 0o700 });
      const scenes = [await scene(`${root}/first.excalidraw`, `${destinationPath}/first.excalidraw`, content('first-image'), png),
        await scene(`${root}/second.excalidraw`, `${destinationPath}/second.excalidraw`, content('second-image'), png)];
      assert.deepEqual(scenes[0].state.assets_json, scenes[1].state.assets_json); assert.equal(scenes[0].state.assets_json[0].fileId, assetId);
      assert.deepEqual(await fs.readdir(path.join(source.rootPath, root)), []); await fs.rmdir(path.join(source.rootPath, root));
      await absent(path.join(source.rootPath, root)); assert.deepEqual(await fs.readdir(source.rootPath), []);
      const sourceBlob = blobPath(source.workspaceId, sha(png)), sourceFile = await file(sourceBlob), sourceBefore = await rows(source.workspaceId);
      const selected = await job(root, destinationPath, scenes);
      const virtual = selected.plan.sourceEvidence.stage.namespace.find(value => value.path === root); assert(virtual);
      assert.equal(virtual.kind, 'directory'); assert.equal(virtual.filesystemIdentity, null);
      const attempt = await capture(selected), { birth, original } = await complete(selected, attempt);
      assert.equal(original.sceneAssets.length, 1); assert.equal(original.sceneAssets[0].asset.metadata.fileId, assetId);
      assert.equal(original.physical[0].original.source.kind, 'projection_absent'); assert.equal(original.physical[0].original.staging?.payload.kind, 'directory');
      assert.equal(birth.assetReceipt.blobs.length, 1); assert.equal(birth.intent.assetOriginal.metadata.length, 1);
      assert.equal(attempt.evidence.writes.filter(value => value.table === 'collaboration_excalidraw_assets').length, 1);
      const assets = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_assets WHERE workspace_id=$1', [destination.workspaceId])).rows;
      assert.equal(assets.length, 1); assert.equal(assets[0].file_id, assetId); assert.equal(assets[0].xmin, xid32(birth.b2TransactionId));
      const metadata: ExcalidrawAssetMetadata = scenes[0].state.assets_json[0];
      assert.equal(assets[0].content_sha256, metadata.contentHash); assert.equal(assets[0].mime_type, metadata.mimeType);
      assert.equal(Number(assets[0].size_bytes), metadata.sizeBytes); assert.equal(Number(assets[0].version), metadata.version); assert.equal(Number(assets[0].created_at), metadata.createdAt);
      const targetBlob = blobPath(destination.workspaceId, sha(png)), targetFile = await file(targetBlob), receipt = birth.assetReceipt.blobs[0];
      assert.equal(targetFile.dev, receipt.identity.dev); assert.equal(targetFile.ino, receipt.identity.ino); assert.equal(targetFile.mode & 0o777, 0o600);
      assert.equal(targetFile.nlink, 1); assert.equal(targetFile.bytes, png.toString('base64')); assert.notEqual(`${targetFile.dev}:${targetFile.ino}`, `${sourceFile.dev}:${sourceFile.ino}`);
      assert.deepEqual((await fs.readdir(path.dirname(targetBlob))).filter(name => /^[a-f0-9]{64}$/u.test(name)), [sha(png)]);
      assert.deepEqual(await file(sourceBlob), sourceFile); assert.deepEqual(await rows(source.workspaceId), sourceBefore);
      await absent(path.join(source.rootPath, root)); await history(selected);
      assert.deepEqual(await file(sourceBlob), sourceFile); assert.deepEqual(await file(targetBlob), targetFile);
    });
    await noYjs();
    for (const { workspaceId, intent } of starters) assert.deepEqual(await readWorkspaceStarterInitializationIntent(h.connection, workspaceId), intent);
  });
  assert.equal(groups, 2);
  assert.deepEqual(Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(file))]))), pins);
  completed = true; console.log(JSON.stringify({ suite: 'workspace-managed-copy-scene-only-postgres', groups, passed: true, sourcesUnchanged: true }));
}

void managedCopySceneOnlyPostgresTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error(JSON.stringify({ suite: 'workspace-managed-copy-scene-only-postgres', case: currentCase,
    name: error instanceof Error ? error.name : 'unknown', code: typeof code === 'string' && /^[a-z0-9_-]{1,96}$/iu.test(code) ? code : null,
    frames: error instanceof Error ? error.stack?.split('\n').flatMap(line => {
      const match = /\/(app\/lib\/[a-z0-9_./-]+|scripts\/[a-z0-9_./-]+):(\d+):(\d+)\)?$/iu.exec(line);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 6) : [] })); process.exitCode = 1;
});
