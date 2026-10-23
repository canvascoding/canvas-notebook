import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { ExcalidrawCopyIntent, ExcalidrawCopyBirthReceipt } from '../app/lib/excalidraw-collaboration/copy-contract';
import type { WorkspaceOperationManagedCopyStageV4 } from '../app/lib/files/workspace-operation-managed-copy-stage';
import type { NativeCopyReceipt } from '../app/lib/collaboration/native-copy-persistence';
import type { NativeWorkspaceFileOperationPlan } from '../app/lib/markdown/workspace-link-contract-v2';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Genuine member Cookie/Bearer -> ordinary file-operation service -> fixed
// Copy owner. Only the fixture's own PG schema/DATA and real SQL ACKs are used.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const xid32 = (value: string) => (BigInt(value) & BigInt('4294967295')).toString();
type Witness = { pid: number; xid: string };

async function managedCopyOwnerPostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const files = ['scripts/workspace-managed-copy-owner-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-file-operation-service.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/files/workspace-operation-native-copy-phase.ts', 'app/lib/files/workspace-operation-native-copy-phase-contract.ts',
    'app/lib/files/workspace-operation-native-copy-phase-read.ts', 'app/lib/files/workspace-operation-native-copy-graph.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/files/workspace-operation-staging.ts',
    'app/lib/excalidraw-collaboration/copy-domain.ts', 'app/lib/excalidraw-collaboration/copy-data.ts',
    'app/lib/excalidraw-collaboration/copy-history.ts', 'app/lib/excalidraw-collaboration/copy-asset-publication.ts',
    'app/lib/db/excalidraw-copy-migration.ts', 'app/lib/db/postgres.ts', 'app/lib/collaboration/native-copy-persistence.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(file))])));
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { executeWorkspaceFileOperationService: service } = await import('../app/lib/files/workspace-file-operation-service');
    const { previewWorkspaceNativeCopyOperation: preview } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { captureExcalidrawCopyIntent, captureExcalidrawCopyBirthReceipt } = await import('../app/lib/excalidraw-collaboration/copy-data');
    const { importExcalidrawDocumentFile } = await import('../app/lib/excalidraw-collaboration/portable-import');
    const { applyExcalidrawScenePatch } = await import('../app/lib/excalidraw-collaboration/repository');
    const { serializePortableExcalidrawSceneFromReadonlyAssets: portable } = await import('../app/lib/excalidraw-collaboration/portable-serialization');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: links } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const sourceOwner = await readPostgresWorkspaceForActorOnConnection(h.connection,
      resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId); assert(sourceOwner);
    assert(h.source.permissions.canRead && !h.source.permissions.canWrite); assert(h.destination.permissions.canWrite);
    const actor = { userId: 'owner', actorId: 'owner', actorType: 'user' as const, sessionId: 'session-owner' };
    const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' },
      sourceWorkspace: h.source, destinationWorkspace: h.destination });
    const journal = new WorkspaceOperationJournal(), staging = new WorkspaceOperationStaging();
    const group = async (name: string, action: () => Promise<void>) => { currentCase = name; await action(); groups++;
      console.log(`PASS managed-copy-owner ${groups}: ${name}`); };
    const sceneLedger = async (operationId: string) => (await h.admin.query(
      'SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
    const nativeLedger = async (operationId: string) => (await h.admin.query(
      'SELECT *,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
    const blobPath = (workspaceId: string, hash: string) => path.join(h.dataRoot, 'collaboration-assets/excalidraw', sha(workspaceId).slice(0, 32), hash);
    const sourceRows = async (ids: readonly string[], assetId: string) => (await h.admin.query(`
      SELECT 'native' AS kind,document_id AS id,to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[])
      UNION ALL SELECT 'scene',document_id,to_jsonb(s)::text,xmin::text FROM collaboration_excalidraw_states s WHERE document_id=ANY($1::text[])
      UNION ALL SELECT 'registry',id,to_jsonb(d)::text,xmin::text FROM collaboration_documents d WHERE id=ANY($1::text[])
      UNION ALL SELECT 'lineage',id,to_jsonb(l)::text,xmin::text FROM file_collaboration_lineages l WHERE id IN (SELECT lineage_id FROM collaboration_documents WHERE id=ANY($1::text[]))
      UNION ALL SELECT 'asset',file_id,to_jsonb(a)::text,xmin::text FROM collaboration_excalidraw_assets a WHERE workspace_id=$2 AND file_id=$3
      ORDER BY kind,id`, [ids, h.source.workspaceId, assetId])).rows;
    const seed = async () => {
      const suffix = crypto.randomUUID(), root = `mixed-${suffix}`, destinationPath = `copy-${suffix}`, assetId = `png-${suffix}`;
      // A PNG with an ignored trailing fixture marker keeps genuine PNG bytes
      // and gives each recovery case its own content-addressed blob birth.
      const png = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), Buffer.from(suffix)]);
      const note = await h.upload(`${root}/note.md`, Buffer.from(`# Note\n[Scene](/${root}/diagram.excalidraw) [Target](target.md) [PDF](manual.pdf)\n`));
      const target = await h.upload(`${root}/target.md`, Buffer.from('# Target\n'));
      const incoming = await h.upload(`${root}-incoming.md`, Buffer.from(`[Original scene](/${root}/diagram.excalidraw)\n`));
      await h.metadata(h.source, `${root}/note.md`, { title: 'Shared source title' });
      const pdf = Buffer.from('%PDF-1.7\n\0\xff\n%%EOF', 'binary');
      await fs.mkdir(path.join(h.source.rootPath, root, 'empty'), { recursive: true });
      await fs.writeFile(path.join(h.source.rootPath, root, 'manual.pdf'), pdf, { mode: 0o600, flag: 'wx' });
      const initial = await importExcalidrawDocumentFile({ workspace: sourceOwner, actor, path: `${root}/diagram.excalidraw`, content: JSON.stringify({
        type: 'excalidraw', version: 2, elements: [{ id: 'image', type: 'image', fileId: assetId, version: 1, versionNonce: 1, isDeleted: false }],
        appState: { viewBackgroundColor: '#ffffff' }, files: { [assetId]: { id: assetId, mimeType: 'image/png',
          dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 123, version: 2 } } }) });
      const latest = await applyExcalidrawScenePatch({ documentId: initial.documentId, lifecycleGeneration: initial.lifecycleGeneration,
        baseSequence: initial.sceneSequence, messageId: crypto.randomUUID(), actorType: 'user', actorId: 'owner', initiatedByUserId: 'owner',
        elements: [{ id: 'latest', type: 'rectangle', version: 1, versionNonce: 7, isDeleted: false, x: 42 }] });
      for (const name of ['note.md', 'target.md', 'diagram.excalidraw']) await fs.unlink(path.join(h.source.rootPath, root, name));
      await h.admin.query('UPDATE collaboration_excalidraw_assets SET last_referenced_at=456 WHERE workspace_id=$1 AND file_id=$2', [h.source.workspaceId, assetId]);
      const stored = (await h.admin.query('SELECT elements_json,shared_app_state_json,assets_json,canonical_hash FROM collaboration_excalidraw_states WHERE document_id=$1', [initial.documentId])).rows[0];
      const expectedPortable = portable({ elements: stored.elements_json, appState: stored.shared_app_state_json,
        assets: stored.assets_json, canonicalHash: stored.canonical_hash }, [{ metadata: stored.assets_json[0], bytes: png }]);
      const ids = [note.documentId, target.documentId, incoming.documentId, initial.documentId];
      const selections = [{ sourcePath: root, destinationPath }], request = await h.request(h.destination, 'member', true);
      const plan = await preview({ origin, request, selections }); assert.equal(plan.version, 3);
      return { root, destinationPath, assetId, png, pdf, ids, initial, latest, expectedPortable, selections,
        operationId: crypto.randomUUID(), plan, sourceBefore: await sourceRows(ids, assetId) };
    };
    type Job = Awaited<ReturnType<typeof seed>>;
    type Evidence = { stage?: WorkspaceOperationManagedCopyStageV4; intent?: ExcalidrawCopyIntent; birth?: ExcalidrawCopyBirthReceipt;
      b1?: Witness; writes: Array<Witness & { table: string }> };
    const run = async (job: Job) => service({ kind: 'copy', operationId: job.operationId, expectedPlanId: job.plan.planId,
      selections: job.selections, request: await h.request(h.destination, 'member', true),
      source: { workspace: h.source, fileOptions: { workspace: h.source } },
      destination: { workspace: h.destination, fileOptions: { workspace: h.destination, mutationActorUserId: 'member' } },
      actorUserId: 'member', actorId: 'member', actorSessionId: 'session-member', actorType: 'user', actorDisplayName: 'Actual managed Copy member' });
    const capture = async (job: Job, fault?: (event: MetadataSqlEvent, evidence: Evidence) => Promise<void>) => {
      const prior = await sceneLedger(job.operationId), evidence: Evidence = { writes: [],
        stage: await staging.loadManagedCopyByOperationId(job.operationId) ?? undefined,
        ...(prior ? { intent: captureExcalidrawCopyIntent(prior.intent_json) } : {}) };
      const result = await h.withProbe(async event => {
        const table = /^\s*(?:INSERT\s+INTO|UPDATE)\s+(?:"?\w+"?\.)?"?(\w+)\b/iu.exec(event.text)?.[1];
        const belongs = event.values.includes(job.operationId);
        const witness = async (): Promise<Witness> => {
          const value = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
          assert(Number.isSafeInteger(value.pid)); assert.match(value.xid, /^[1-9][0-9]*$/u); return { pid: value.pid, xid: value.xid };
        };
        if (!evidence.stage && table === 'collaboration_native_copy_receipts' && belongs) {
          const value = await staging.loadManagedCopyByOperationId(job.operationId); assert(value); evidence.stage = value;
        }
        if (table === 'collaboration_excalidraw_copy_receipts' && belongs && /^\s*INSERT\b/iu.test(event.text)) {
          const row = (await event.raw('SELECT intent_json,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
          evidence.intent = captureExcalidrawCopyIntent(row.intent_json); evidence.b1 = await witness();
          assert.equal(row.xmin, xid32(evidence.b1.xid)); assert.equal(evidence.intent.b1TransactionId, evidence.b1.xid);
          const native = (await event.raw('SELECT xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
          assert.equal(native.xmin, row.xmin); assert(evidence.stage); assert.equal(evidence.intent.stageDigest, evidence.stage.payloadSha256);
          for (const doc of evidence.intent.documents) {
            const query = `SELECT id FROM collaboration_documents WHERE id=$1 UNION ALL SELECT id FROM file_collaboration_lineages WHERE id=$2
              UNION ALL SELECT document_id FROM collaboration_excalidraw_states WHERE document_id=$1`;
            assert.equal((await event.raw(query, [doc.documentId, doc.lineageId])).rows.length, 0, 'B1 fixes IDs without creating active Scene rows.');
            assert.equal((await h.admin.query(query, [doc.documentId, doc.lineageId])).rows.length, 0);
          }
        }
        const intent = evidence.intent;
        if (intent && table) {
          const ids = intent.documents.flatMap(doc => [doc.documentId, doc.lineageId]);
          const sceneTable = ['collaboration_documents', 'file_collaboration_lineages', 'collaboration_excalidraw_states'].includes(table) && event.values.some(value => ids.includes(String(value)));
          const assetTable = table === 'collaboration_excalidraw_assets' && event.values.includes(job.assetId) && event.values.includes(h.destination.workspaceId);
          if (sceneTable || assetTable) evidence.writes.push({ table, ...await witness() });
          if (belongs && table === 'collaboration_excalidraw_copy_receipts' && /^\s*UPDATE\b/iu.test(event.text)) {
            const row = (await event.raw('SELECT birth_json FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
            if (row?.birth_json) { evidence.birth = captureExcalidrawCopyBirthReceipt(row.birth_json); evidence.writes.push({ table, ...await witness() }); }
          }
          if (belongs && table === 'collaboration_native_copy_receipts' && /^\s*UPDATE\b/iu.test(event.text)) {
            const row = (await event.raw('SELECT publication_status FROM collaboration_native_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
            if (row?.publication_status === 'published') evidence.writes.push({ table, ...await witness() });
          }
          if (belongs && table === 'workspace_file_operations') {
            const row = (await event.raw('SELECT status FROM workspace_file_operations WHERE operation_id=$1', [job.operationId])).rows[0];
            if (row?.status === 'completed') evidence.writes.push({ table, ...await witness() });
          }
        }
        await fault?.(event, evidence);
      }, () => run(job));
      return { result, evidence };
    };
    const needsRecovery = (result: Awaited<ReturnType<typeof run>>, expected?: string) => {
      assert.equal(result.execution.status, 'needs_recovery'); assert.deepEqual(result.copied, []);
      if (expected) assert.equal(result.execution.errorCode, expected);
    };
    const complete = async (job: Job, result: Awaited<ReturnType<typeof run>>, evidence: Evidence, alreadyKnown = false) => {
      assert.equal(result.execution.status, 'complete', String(result.execution.errorCode)); assert.equal(result.alreadyKnown, alreadyKnown);
      assert.deepEqual(result.copied, [job.destinationPath]); assert.equal(result.copyViewsFinalized, true);
      const original = evidence.stage; assert(original); assert.equal(original.version, 4); assert.equal(original.plan.version, 3);
      const row = await sceneLedger(job.operationId); assert(row?.birth_json);
      const intent = captureExcalidrawCopyIntent(row.intent_json), birth = captureExcalidrawCopyBirthReceipt(row.birth_json);
      assert.deepEqual(intent, evidence.intent); assert.deepEqual(birth.intent, intent); assert.equal(intent.documents.length, 1);
      assert.equal(row.xmin, xid32(birth.b2TransactionId)); assert.equal(row.b2_transaction_id, birth.b2TransactionId);
      const native = await nativeLedger(job.operationId); assert.equal(native.publication_status, 'published'); assert.equal(native.xmin, row.xmin);
      const operation = await journal.get(job.operationId); assert.equal(operation?.status, 'completed'); assert(operation);
      assert.equal(operation.steps.length, operation.expectedStepCount); assert(operation.steps.every(step => step.status === 'applied'));
      const completion = operation.steps.find(step => step.stepKey === 'copy-completion'); assert(completion?.receiptJson);
      const body = JSON.parse(completion.receiptJson); assert.equal(body.version, 3); assert.equal(body.stageDigest, original.payloadSha256);
      assert.equal(body.sceneIntentProof, intent.intentDigest); assert.equal(body.sceneBirthProof, birth.receiptProof); assert.equal(body.assetReceiptProof, birth.assetReceipt.receiptProof);
      const closing = (await h.admin.query(`SELECT xmin::text AS xmin FROM workspace_file_operations WHERE operation_id=$1
        UNION ALL SELECT xmin::text FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key='copy-completion'`, [job.operationId])).rows;
      assert.equal(closing.length, 2); assert(closing.every(value => value.xmin === row.xmin));
      const doc = intent.documents[0]; assert.notEqual(doc.documentId, job.initial.documentId); assert.notEqual(doc.lineageId, doc.sourceLineageId);
      const state = (await h.admin.query(`SELECT d.provider,d.state_version,d.lineage_id,d.xmin::text AS registry_xmin,l.xmin::text AS lineage_xmin,
        s.*,s.xmin::text AS scene_xmin FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
        JOIN collaboration_excalidraw_states s ON s.document_id=d.id WHERE d.id=$1`, [doc.documentId])).rows[0]; assert(state);
      assert.equal(state.provider, 'excalidraw'); assert.equal(Number(state.state_version), 0); assert.equal(state.lineage_id, doc.lineageId);
      assert.equal(state.registry_xmin, row.xmin); assert.equal(state.lineage_xmin, row.xmin); assert.equal(state.scene_xmin, row.xmin);
      assert.equal(Number(state.lifecycle_generation), 1); assert.equal(Number(state.scene_sequence), 0); assert.equal(Number(state.checkpoint_sequence), 0);
      for (const field of ['checkpoint_revision_id', 'checkpoint_content_hash', 'checkpointed_at', 'degraded_reason']) assert.equal(state[field], null);
      assert.equal(state.canonical_hash, job.latest.state.canonicalHash); assert(state.elements_json.some((item: { id: string }) => item.id === 'latest'));
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_yjs_states WHERE document_id=$1', [doc.documentId])).rows[0].n, 0);
      const assets = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_assets WHERE workspace_id=$1 AND file_id=$2', [h.destination.workspaceId, job.assetId])).rows;
      assert.equal(assets.length, 1); assert.equal(assets[0].xmin, row.xmin); assert.equal(assets[0].content_sha256, sha(job.png));
      const blob = blobPath(h.destination.workspaceId, sha(job.png)), info = await fs.lstat(blob);
      assert.equal(String(info.dev), birth.assetReceipt.blobs[0].identity.dev); assert.equal(String(info.ino), birth.assetReceipt.blobs[0].identity.ino);
      assert.equal(info.mode & 0o777, 0o600); assert.equal(info.nlink, 1); assert.deepEqual(await fs.readFile(blob), job.png);
      assert.deepEqual(await fs.readFile(path.join(h.destination.rootPath, job.destinationPath, 'diagram.excalidraw')), Buffer.from(job.expectedPortable));
      assert.deepEqual(await fs.readFile(path.join(h.destination.rootPath, job.destinationPath, 'manual.pdf')), job.pdf);
      assert.deepEqual(await fs.readdir(path.join(h.destination.rootPath, job.destinationPath, 'empty')), []);
      const receipt = native.private_result as Omit<NativeCopyReceipt, 'publicationStatus'>; assert.equal(receipt.documents.length, 2);
      for (const clone of receipt.documents) {
        const before = await load(h.connection, clone.source.documentId), after = await load(h.connection, clone.clone.documentId); assert(before && after);
        assert.notEqual(before.documentId, after.documentId); assert.notEqual(clone.clone.lineageId,
          (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [before.documentId])).rows[0].lineage_id);
        assert.equal(after.lifecycleGeneration, 1); assert.equal(after.workspaceId, h.destination.workspaceId); assert.equal(after.representation, before.representation);
        const sourceClients = Y.decodeStateVector(before.stateVector), targetClients = Y.decodeStateVector(after.stateVector);
        assert([...targetClients.keys()].every(client => !sourceClients.has(client)), 'Copy creates fresh Yjs client identities.');
        const inventory = links(after), previous = links(before); assert(inventory.coverage.complete && previous.coverage.complete);
        const recipes: NativeWorkspaceFileOperationPlan['mutations'] = original.plan.nativePathPlan.mutations.filter(recipe => recipe.source.documentId === before.documentId && recipe.sourcePathAfter === after.path);
        const literal = (link: typeof inventory.links[number]): string => String(link.ref.kind === 'link-mark' ? link.ref.expected.href : link.ref.expected);
        assert.deepEqual(inventory.links.map(literal), previous.links.map((link): string => recipes.find(recipe => recipe.linkId === link.id)?.nextValue ?? literal(link)));
        await assert.rejects(fs.stat(path.join(h.destination.rootPath, after.path)), { code: 'ENOENT' });
      }
      assert.deepEqual(await sourceRows(job.ids, job.assetId), job.sourceBefore, 'Source READ, incoming references and source last-reference clocks remain untouched.');
      assert.equal(await staging.loadManagedCopyByOperationId(job.operationId), null);
      return { intent, birth, receipt };
    };
    let baseline!: Job, baselineEvidence!: Evidence;
    await group('regular service completes real mixed Copy with new identities, native link rewrites, SQL Scene and owned PNG/PDF/emptydir', async () => {
      baseline = await seed(); const { result, evidence } = await capture(baseline); baselineEvidence = evidence;
      await complete(baseline, result, evidence); assert(evidence.b1 && evidence.birth);
      const required = ['file_collaboration_lineages', 'collaboration_documents', 'collaboration_excalidraw_states', 'collaboration_excalidraw_assets',
        'collaboration_excalidraw_copy_receipts', 'collaboration_native_copy_receipts', 'workspace_file_operations'];
      for (const table of required) assert(evidence.writes.some(write => write.table === table), `Actual ${table} B2 write was observed.`);
      const first = evidence.writes[0]; assert(first); assert.notEqual(first.xid, evidence.b1.xid);
      assert(evidence.writes.every(write => write.pid === first.pid && write.xid === first.xid));
      assert.equal(first.xid, evidence.birth.b2TransactionId);
    });
    await group('failure after actual B1 intent INSERT rolls back native births and Scene intent without creating active Scene', async () => {
      const job = await seed(); let fired = false;
      const attempt = await capture(job, async (event, evidence) => {
        if (!fired && evidence.intent && /^\s*INSERT INTO collaboration_excalidraw_copy_receipts\b/iu.test(event.text)) { fired = true; throw new Error('Owned actual B1 intent ACK failed.'); }
      });
      assert(fired); needsRecovery(attempt.result); assert.equal(await sceneLedger(job.operationId), undefined); assert.equal(await nativeLedger(job.operationId), undefined);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [h.destination.workspaceId, `${job.destinationPath}/diagram.excalidraw`])).rows[0].n, 0);
      await assert.rejects(fs.stat(path.join(h.destination.rootPath, job.destinationPath)), { code: 'ENOENT' });
      const retry = await capture(job); await complete(job, retry.result, retry.evidence, true);
    });
    await group('lost actual B1 COMMIT ACK retains immutable Scene IDs and original Stage for ordinary service recovery', async () => {
      const job = await seed(); let fired = false;
      const attempt = await capture(job, async (event, evidence) => {
        if (!fired && evidence.intent && !evidence.birth && /^\s*COMMIT\s*$/iu.test(event.text)) { fired = true; throw new Error('Owned B1 COMMIT ACK lost after actual SQL.'); }
      });
      assert(fired); needsRecovery(attempt.result, 'NATIVE_COPY_COMMIT_UNCONFIRMED'); assert(attempt.evidence.intent);
      const intent = captureExcalidrawCopyIntent((await sceneLedger(job.operationId)).intent_json); assert.deepEqual(intent, attempt.evidence.intent);
      assert.equal((await sceneLedger(job.operationId)).birth_json, null);
      for (const doc of intent.documents) assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_excalidraw_states WHERE document_id=$1', [doc.documentId])).rows[0].n, 0);
      const retry = await capture(job); const completeResult = await complete(job, retry.result, retry.evidence, true); assert.deepEqual(completeResult.intent, intent);
    });
    await group('actual B2 Scene INSERT failure rolls back SQL, retains published original inode/blob and recovers the same fixed IDs', async () => {
      const job = await seed(); let fired = false;
      const attempt = await capture(job, async (event, evidence) => {
        if (!fired && evidence.intent && /^\s*INSERT INTO collaboration_excalidraw_states\b/iu.test(event.text)
          && event.values.includes(evidence.intent.documents[0].documentId)) { fired = true; throw new Error('Owned actual B2 Scene INSERT ACK failed.'); }
      });
      assert(fired); needsRecovery(attempt.result); const row = await sceneLedger(job.operationId); assert(row); assert.equal(row.birth_json, null);
      const intent = captureExcalidrawCopyIntent(row.intent_json), doc = intent.documents[0];
      const missing = (await h.admin.query(`SELECT id FROM collaboration_documents WHERE id=$1 UNION ALL SELECT id FROM file_collaboration_lineages WHERE id=$2
        UNION ALL SELECT document_id FROM collaboration_excalidraw_states WHERE document_id=$1`, [doc.documentId, doc.lineageId])).rows; assert.equal(missing.length, 0);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_excalidraw_assets WHERE workspace_id=$1 AND file_id=$2', [h.destination.workspaceId, job.assetId])).rows[0].n, 0);
      const target = path.join(h.destination.rootPath, job.destinationPath, 'diagram.excalidraw'), blob = blobPath(h.destination.workspaceId, sha(job.png));
      const targetInfo = await fs.lstat(target), blobInfo = await fs.lstat(blob);
      assert.deepEqual(await fs.readFile(target), Buffer.from(job.expectedPortable)); assert.deepEqual(await fs.readFile(blob), job.png);
      const retry = await capture(job); const result = await complete(job, retry.result, retry.evidence, true);
      assert.deepEqual(result.intent, intent); assert.equal((await fs.lstat(target)).ino, targetInfo.ino); assert.equal((await fs.lstat(blob)).ino, blobInfo.ino);
    });
    await group('lost actual B2 COMMIT ACK resumes original completed receipt without a second Scene birth', async () => {
      const job = await seed(); let fired = false;
      const attempt = await capture(job, async (event, evidence) => {
        if (!fired && evidence.birth && /^\s*COMMIT\s*$/iu.test(event.text)) { fired = true; throw new Error('Owned B2 COMMIT ACK lost after actual SQL.'); }
      });
      assert(fired); needsRecovery(attempt.result, 'NATIVE_COPY_COMMIT_UNCONFIRMED');
      const before = await sceneLedger(job.operationId); assert(before?.birth_json); assert.equal((await journal.get(job.operationId))?.status, 'completed');
      let mutations = 0;
      const retry = await capture(job, async event => { if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) mutations++; });
      await complete(job, retry.result, attempt.evidence, true); assert.equal(mutations, 0); assert.deepEqual(await sceneLedger(job.operationId), before);
    });
    await group('actual source asset status drift after C1 and before B1 rejects publication, then same-original retry succeeds after restoration', async () => {
      const job = await seed(); let fired = false, originalDigest: string | undefined;
      const attempt = await capture(job, async (event, evidence) => {
        if (fired || !/^\s*INSERT INTO workspace_file_operations\b/iu.test(event.text) || !event.values.includes(job.operationId)) return;
        const original = await staging.loadManagedCopyByOperationId(job.operationId); assert(original);
        evidence.stage = original; originalDigest = original.payloadSha256; fired = true;
        // Real independent source change after C1: the Scene still contains its
        // original metadata. Only a fresh source-asset SQL check can detect it.
        const changed = await h.admin.query("UPDATE collaboration_excalidraw_assets SET status='quarantined' WHERE workspace_id=$1 AND file_id=$2",
          [h.source.workspaceId, job.assetId]); assert.equal(changed.rowCount, 1);
      });
      assert(fired && originalDigest); needsRecovery(attempt.result);
      assert.equal(await sceneLedger(job.operationId), undefined); assert.equal(await nativeLedger(job.operationId), undefined);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
        [h.destination.workspaceId, `${job.destinationPath}/diagram.excalidraw`])).rows[0].n, 0);
      await assert.rejects(fs.stat(path.join(h.destination.rootPath, job.destinationPath)), { code: 'ENOENT' });
      assert.equal((await staging.loadManagedCopyByOperationId(job.operationId))?.payloadSha256, originalDigest);
      const restored = await h.admin.query("UPDATE collaboration_excalidraw_assets SET status='available' WHERE workspace_id=$1 AND file_id=$2",
        [h.source.workspaceId, job.assetId]); assert.equal(restored.rowCount, 1);
      // Restoration has a genuinely new xmin; future Copy must preserve this
      // restored row, not pretend the adversarial UPDATE never happened.
      job.sourceBefore = await sourceRows(job.ids, job.assetId);
      const retry = await capture(job); assert.equal(retry.evidence.stage?.payloadSha256, originalDigest);
      await complete(job, retry.result, retry.evidence, true);
    });
    await group('completed history ignores current Scene edits and physical S2/D2, using genuine RR READ ONLY without current domain reads', async () => {
      const row = await sceneLedger(baseline.operationId), birth = captureExcalidrawCopyBirthReceipt(row.birth_json), doc = birth.documents[0];
      await applyExcalidrawScenePatch({ documentId: doc.documentId, lifecycleGeneration: 1, baseSequence: 0,
        messageId: crypto.randomUUID(), actorType: 'user', actorId: 'member', initiatedByUserId: 'member',
        elements: [{ id: 'editorial', type: 'rectangle', version: 1, versionNonce: 99, isDeleted: false, x: 91 }] });
      await h.metadata(h.destination, `${baseline.destinationPath}/note.md`, { title: 'Later editorial title' }, 'member');
      for (const [workspace, name] of [[h.source, baseline.root], [h.destination, baseline.destinationPath]] as const) {
        await fs.rename(path.join(workspace.rootPath, name), path.join(h.dataRoot, `historical-${crypto.randomUUID()}`));
        await fs.mkdir(path.join(workspace.rootPath, name), { mode: 0o700 });
        await fs.writeFile(path.join(workspace.rootPath, name, 'foreign.pdf'), 'Later independent file', { flag: 'wx', mode: 0o600 });
      }
      const target = path.join(h.destination.rootPath, baseline.destinationPath, 'foreign.pdf'), source = path.join(h.source.rootPath, baseline.root, 'foreign.pdf');
      const targetInfo = await fs.lstat(target), sourceInfo = await fs.lstat(source), before = await sceneLedger(baseline.operationId);
      const operationBefore = await journal.get(baseline.operationId), nativeBefore = await nativeLedger(baseline.operationId);
      const domainBefore = (await h.admin.query('SELECT to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_excalidraw_states s WHERE document_id=$1', [doc.documentId])).rows;
      const historyClients = new Set<PoolClient>(); let writes = 0, historicalQueries = 0, currentDomainReads = 0;
      const result = await h.withProbe(async event => {
        if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) writes++;
        const readsCurrentDomain = /(?:FROM|JOIN)\s+(?:"?\w+"?\.)?"?(?:collaboration_excalidraw_states|collaboration_excalidraw_assets|collaboration_documents|file_collaboration_lineages|collaboration_yjs_states)\b/iu.test(event.text);
        if (readsCurrentDomain) currentDomainReads++;
        if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/iu.test(event.text)) historyClients.add(event.client);
        if (historyClients.has(event.client)) {
          assert(!/FOR\s+(?:UPDATE|SHARE)|pg_current_xact_id\s*\(/iu.test(event.text));
          assert(!readsCurrentDomain, 'History reads original ledgers, never current D2 domain rows.');
          assert.equal((await event.raw('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0].xid, null); historicalQueries++;
          if (/^COMMIT$/iu.test(event.text)) historyClients.delete(event.client);
        }
      }, () => run(baseline));
      assert.equal(result.execution.status, 'complete'); assert.equal(result.alreadyKnown, true); assert.equal(writes, 0); assert.equal(currentDomainReads, 0);
      assert(historicalQueries > 3); assert.equal(historyClients.size, 0);
      assert.deepEqual(await sceneLedger(baseline.operationId), before); assert.deepEqual(await nativeLedger(baseline.operationId), nativeBefore);
      assert.deepEqual(await journal.get(baseline.operationId), operationBefore);
      assert.deepEqual((await h.admin.query('SELECT to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_excalidraw_states s WHERE document_id=$1', [doc.documentId])).rows, domainBefore);
      assert.equal((await fs.lstat(target)).ino, targetInfo.ino); assert.equal((await fs.lstat(source)).ino, sourceInfo.ino);
      assert.equal(await fs.readFile(target, 'utf8'), 'Later independent file'); assert.equal(await fs.readFile(source, 'utf8'), 'Later independent file');
      assert(baselineEvidence.stage); assert.equal(await staging.loadManagedCopyByOperationId(baseline.operationId), null);
    });
  });
  assert.equal(groups, 7);
  assert.deepEqual(Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(file))]))), pins);
  completed = true; console.log(JSON.stringify({ suite: 'workspace-managed-copy-owner-postgres', groups, passed: true, sourcesUnchanged: true }));
}

void managedCopyOwnerPostgresTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error(JSON.stringify({ suite: 'workspace-managed-copy-owner-postgres', case: currentCase,
    name: error instanceof Error ? error.name : 'unknown', code: typeof code === 'string' && /^[a-z0-9_-]{1,96}$/iu.test(code) ? code : null,
    frames: error instanceof Error ? error.stack?.split('\n').flatMap(line => {
      const match = /\/(app\/lib\/[a-z0-9_./-]+|scripts\/[a-z0-9_./-]+):(\d+):(\d+)\)?$/iu.exec(line);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 6) : [] })); process.exitCode = 1;
});
