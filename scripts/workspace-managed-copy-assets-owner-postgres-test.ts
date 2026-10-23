import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { ExcalidrawCopyIntent, ExcalidrawCopyBirthReceipt } from '../app/lib/excalidraw-collaboration/copy-contract';
import type { WorkspaceOperationManagedCopyStageV4 } from '../app/lib/files/workspace-operation-managed-copy-stage';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Real authenticated service/Owner/PG18. The FS fault below calls the actual
// fsync first; no writer, row, permission, transaction or receipt is substituted.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');

async function managedCopyAssetsOwnerPostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const files = ['scripts/workspace-managed-copy-assets-owner-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-file-operation-service.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/files/workspace-operation-native-copy-phase.ts', 'app/lib/files/workspace-operation-native-copy-phase-contract.ts',
    'app/lib/files/workspace-operation-native-copy-phase-read.ts', 'app/lib/files/workspace-operation-native-copy-graph.ts',
    'app/lib/excalidraw-collaboration/copy-contract.ts', 'app/lib/excalidraw-collaboration/copy-data.ts',
    'app/lib/excalidraw-collaboration/copy-domain.ts', 'app/lib/excalidraw-collaboration/copy-history.ts',
    'app/lib/excalidraw-collaboration/copy-asset-publication.ts', 'app/lib/excalidraw-collaboration/assets.ts',
    'app/lib/db/excalidraw-copy-migration.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(file))])));
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { executeWorkspaceFileOperationService: service } = await import('../app/lib/files/workspace-file-operation-service');
    const { previewWorkspaceNativeCopyOperation: preview } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { captureExcalidrawCopyIntent, captureExcalidrawCopyBirthReceipt } = await import('../app/lib/excalidraw-collaboration/copy-data');
    const { retireExcalidrawCopyAssetOriginal, withPreparedExcalidrawCopyAssets } = await import('../app/lib/excalidraw-collaboration/copy-asset-publication');
    const { importExcalidrawDocumentFile } = await import('../app/lib/excalidraw-collaboration/portable-import');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const sourceOwner = await readPostgresWorkspaceForActorOnConnection(h.connection,
      resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId);
    assert(sourceOwner && sourceOwner.permissions.canRead && sourceOwner.permissions.canWrite);
    assert(h.source.permissions.canRead && !h.source.permissions.canWrite); assert(h.destination.permissions.canWrite);
    const staging = new WorkspaceOperationStaging();
    const group = async (name: string, action: () => Promise<void>) => { currentCase = name; await action(); groups++;
      console.log(`PASS managed-copy-assets-owner ${groups}: ${name}`); };
    const ledger = async (operationId: string) => (await h.admin.query(
      'SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
    const assetRows = async (workspaceId: string, fileId: string) => (await h.admin.query(
      'SELECT to_jsonb(a) AS body,xmin::text AS xmin FROM collaboration_excalidraw_assets a WHERE workspace_id=$1 AND file_id=$2', [workspaceId, fileId])).rows;
    const blobPath = (workspaceId: string, contentHash: string) => path.join(h.dataRoot, 'collaboration-assets/excalidraw', sha(workspaceId).slice(0, 32), contentHash);
    const blobObservation = async (file: string) => {
      const value = await fs.lstat(file, { bigint: true }); assert(value.isFile());
      return { dev: String(value.dev), ino: String(value.ino), mode: Number(value.mode & BigInt(0o7777)), uid: Number(value.uid),
        nlink: String(value.nlink), size: String(value.size), mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs), bytes: await fs.readFile(file) };
    };
    const seed = async (sameWorkspace = false) => {
      const suffix = crypto.randomUUID(), sourcePath = `asset-source-${suffix}.excalidraw`, destinationPath = `asset-copy-${suffix}.excalidraw`, assetId = `png-${suffix}`;
      const png = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), Buffer.from(suffix)]);
      const sourceScene = await importExcalidrawDocumentFile({ workspace: sourceOwner, path: sourcePath,
        actor: { userId: 'owner', actorId: 'owner', actorType: 'user', sessionId: 'session-owner' }, content: JSON.stringify({
          type: 'excalidraw', version: 2, elements: [{ id: 'image', type: 'image', fileId: assetId, version: 1, versionNonce: 1, isDeleted: false }],
          appState: { viewBackgroundColor: '#ffffff' }, files: { [assetId]: { id: assetId, mimeType: 'image/png',
            dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 123, version: 2 } } }) });
      await fs.unlink(path.join(sourceOwner.rootPath, sourcePath));
      await h.admin.query('UPDATE collaboration_excalidraw_assets SET last_referenced_at=456 WHERE workspace_id=$1 AND file_id=$2', [h.source.workspaceId, assetId]);
      const userId = sameWorkspace ? 'owner' as const : 'member' as const;
      const source: WorkspaceContext = sameWorkspace ? sourceOwner : h.source, destination: WorkspaceContext = sameWorkspace ? sourceOwner : h.destination;
      const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId, actorId: userId, sessionId: `session-${userId}` },
        sourceWorkspace: source, destinationWorkspace: destination });
      const selections = [{ sourcePath, destinationPath }], request = await h.request(destination, userId, true);
      const plan = await preview({ origin, request, selections }); assert.equal(plan.version, 3);
      return { operationId: crypto.randomUUID(), source, destination, userId, sourceScene, selections, plan, png, assetId,
        sourcePath, destinationPath, hash: sha(png) };
    };
    type Job = Awaited<ReturnType<typeof seed>>;
    const run = async (job: Job) => service({ kind: 'copy', operationId: job.operationId, expectedPlanId: job.plan.planId, selections: job.selections,
      source: { workspace: job.source, fileOptions: { workspace: job.source } },
      destination: { workspace: job.destination, fileOptions: { workspace: job.destination, mutationActorUserId: job.userId } },
      request: await h.request(job.destination, job.userId, true), actorUserId: job.userId, actorId: job.userId,
      actorDisplayName: 'Actual asset Copy principal', actorType: 'user', actorSessionId: `session-${job.userId}` });
    const complete = async (job: Job, result: Awaited<ReturnType<typeof run>>, alreadyKnown: boolean) => {
      assert.equal(result.execution.status, 'complete', String(result.execution.errorCode)); assert.equal(result.alreadyKnown, alreadyKnown);
      assert.deepEqual(result.copied, [job.destinationPath]); assert.equal(result.copyViewsFinalized, true);
      const row = await ledger(job.operationId); assert(row?.birth_json);
      const intent = captureExcalidrawCopyIntent(row.intent_json), birth = captureExcalidrawCopyBirthReceipt(row.birth_json);
      assert.deepEqual(birth.intent, intent); assert.equal(intent.documents.length, 1); assert.equal(birth.documents.length, 1);
      assert.notEqual(birth.documents[0].documentId, job.sourceScene.documentId);
      assert.equal(birth.documents[0].lifecycleGeneration, 1); assert.equal(birth.documents[0].sceneSequence, 0);
      const actual = (await h.admin.query('SELECT document_id,path,lifecycle_generation,scene_sequence,assets_json FROM collaboration_excalidraw_states WHERE document_id=$1',
        [birth.documents[0].documentId])).rows[0]; assert(actual);
      assert.equal(actual.path, job.destinationPath); assert.equal(Number(actual.lifecycle_generation), 1); assert.equal(Number(actual.scene_sequence), 0);
      assert.equal(actual.assets_json[0].fileId, job.assetId); assert.equal(actual.assets_json[0].contentHash, job.hash);
      assert.deepEqual(await fs.readFile(blobPath(job.destination.workspaceId, job.hash)), job.png);
      assert.equal(await staging.loadManagedCopyByOperationId(job.operationId), null); return { row, intent, birth };
    };
    let legitimateStage: WorkspaceOperationManagedCopyStageV4 | undefined;
    await group('actual blob rename/fsync followed by lost directory-fsync ACK preserves original inode, rejects D2 and resumes original IDs', async () => {
      const job = await seed(), target = blobPath(job.destination.workspaceId, job.hash);
      let originalIntent: ExcalidrawCopyIntent | undefined, fired = false, actualFsyncs = 0;
      let publishedIdentity: { dev: string; ino: string } | undefined;
      const descriptor = Object.getOwnPropertyDescriptor(fsSync, 'fsyncSync'); assert(descriptor?.configurable && 'value' in descriptor);
      const fsync = fsSync.fsyncSync;
      Object.defineProperty(fsSync, 'fsyncSync', { ...descriptor, value: (fd: number): void => {
        fsync(fd); // Actual syscall succeeds before the injected acknowledgement loss.
        if (fired || !originalIntent) return;
        const workspace = originalIntent.assetOriginal.ancestors[3].identity, actual = fsSync.fstatSync(fd, { bigint: true });
        if (!actual.isDirectory() || String(actual.dev) !== workspace.dev || String(actual.ino) !== workspace.ino) return;
        const expected = originalIntent.assetOriginal.blobs.find(blob => blob.contentHash === job.hash); assert(expected?.disposition === 'birth');
        const info = fsSync.lstatSync(target, { bigint: true });
        assert.equal(String(info.dev), expected.identity.dev); assert.equal(String(info.ino), expected.identity.ino);
        const privatePayload = path.join(path.dirname(target), originalIntent.assetOriginal.privateDirectory.name, job.hash);
        assert.throws(() => fsSync.lstatSync(privatePayload), { code: 'ENOENT' });
        publishedIdentity = { dev: String(info.dev), ino: String(info.ino) }; actualFsyncs++; fired = true;
        throw Object.assign(new Error('Actual owned blob directory fsync ACK lost.'), { code: 'EIO' });
      } });
      let attempt: Awaited<ReturnType<typeof run>>;
      try {
        attempt = await h.withProbe(async event => {
          if (/^\s*INSERT INTO collaboration_excalidraw_copy_receipts\b/iu.test(event.text) && event.values.includes(job.operationId)) {
            const row = (await event.raw('SELECT intent_json FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
            originalIntent = captureExcalidrawCopyIntent(row.intent_json);
          }
        }, () => run(job));
      } finally { Object.defineProperty(fsSync, 'fsyncSync', descriptor); }
      assert(fired && originalIntent && publishedIdentity); assert.equal(actualFsyncs, 1);
      assert.equal(attempt.execution.status, 'needs_recovery'); assert.deepEqual(attempt.copied, []);
      const before = await ledger(job.operationId); assert(before); assert.equal(before.birth_json, null);
      assert.deepEqual(captureExcalidrawCopyIntent(before.intent_json), originalIntent);
      assert.equal((await assetRows(job.destination.workspaceId, job.assetId)).length, 0, 'Asset SQL rows are born only in B2.');
      const staged = await staging.loadManagedCopyByOperationId(job.operationId); assert(staged); legitimateStage = staged;
      const originalBlob = await blobObservation(target); assert.equal(originalBlob.ino, publishedIdentity.ino); assert.equal(originalBlob.dev, publishedIdentity.dev);
      const privateManifest = path.join(path.dirname(target), originalIntent.assetOriginal.privateDirectory.name, 'original.json');
      const manifestBefore = await blobObservation(privateManifest);
      assert.equal(JSON.parse(manifestBefore.bytes.toString('utf8')).originalProof, originalIntent.assetOriginal.originalProof);
      const d1Hold = path.join(h.dataRoot, `held-own-blob-${crypto.randomUUID()}`), d2Hold = path.join(h.dataRoot, `held-foreign-blob-${crypto.randomUUID()}`);
      await fs.rename(target, d1Hold); await fs.writeFile(target, job.png, { flag: 'wx', mode: 0o600 });
      const d2 = await blobObservation(target); assert.notEqual(d2.ino, originalBlob.ino, 'Same bytes do not confer ownership of D2.');
      const rejected = await run(job); assert.equal(rejected.execution.status, 'needs_recovery'); assert.deepEqual(rejected.copied, []);
      assert.deepEqual(await blobObservation(target), d2, 'Recovery must not replace or remove the independent same-hash inode.');
      assert.deepEqual(await ledger(job.operationId), before); assert.deepEqual(await blobObservation(privateManifest), manifestBefore);
      assert.equal((await staging.loadManagedCopyByOperationId(job.operationId))?.payloadSha256, staged.payloadSha256);
      await fs.rename(target, d2Hold); await fs.rename(d1Hold, target); const heldD2Before = await blobObservation(d2Hold);
      const resumed = await complete(job, await run(job), true); assert.deepEqual(resumed.intent, originalIntent);
      const after = await blobObservation(target); assert.equal(after.dev, originalBlob.dev); assert.equal(after.ino, originalBlob.ino);
      assert.deepEqual(after.bytes, originalBlob.bytes); assert.deepEqual(await blobObservation(d2Hold), heldD2Before);
      assert.deepEqual(resumed.birth.documents.map(doc => [doc.documentId, doc.lineageId]), originalIntent.documents.map(doc => [doc.documentId, doc.lineageId]));
    });
    let sameWorkspace!: Job, sameBirth!: ExcalidrawCopyBirthReceipt;
    await group('genuine owner same-workspace Copy reuses exact PNG metadata, inode, xmin and last-reference without asset DML', async () => {
      sameWorkspace = await seed(true); assert.equal(sameWorkspace.source.workspaceId, sameWorkspace.destination.workspaceId);
      assert(sameWorkspace.source.permissions.canRead && sameWorkspace.source.permissions.canWrite);
      const target = blobPath(sameWorkspace.source.workspaceId, sameWorkspace.hash), before = await blobObservation(target);
      const rowsBefore = await assetRows(sameWorkspace.source.workspaceId, sameWorkspace.assetId); assert.equal(rowsBefore.length, 1);
      const sourceBefore = (await h.admin.query('SELECT to_jsonb(s) AS body,xmin::text AS xmin FROM collaboration_excalidraw_states s WHERE document_id=$1', [sameWorkspace.sourceScene.documentId])).rows;
      let assetDml = 0;
      const result = await h.withProbe(async event => {
        if (/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+collaboration_excalidraw_assets\b/iu.test(event.text)) assetDml++;
      }, () => run(sameWorkspace));
      const completedCopy = await complete(sameWorkspace, result, false); sameBirth = completedCopy.birth;
      assert.equal(assetDml, 0); assert.equal(sameBirth.assetReceipt.blobs.length, 1); assert.equal(sameBirth.assetReceipt.blobs[0].disposition, 'reuse');
      assert.deepEqual(await assetRows(sameWorkspace.source.workspaceId, sameWorkspace.assetId), rowsBefore);
      assert.equal(rowsBefore[0].body.last_referenced_at, 456);
      assert.deepEqual(await blobObservation(target), before);
      assert.deepEqual((await h.admin.query('SELECT to_jsonb(s) AS body,xmin::text AS xmin FROM collaboration_excalidraw_states s WHERE document_id=$1', [sameWorkspace.sourceScene.documentId])).rows, sourceBefore);
    });
    await group('completed Scene ledger rejects actual UPDATE/DELETE and a legitimate DTO cannot retire outside the private acknowledged owner', async () => {
      const before = await ledger(sameWorkspace.operationId); assert(before?.birth_json);
      await assert.rejects(h.admin.query('UPDATE collaboration_excalidraw_copy_receipts SET birth_json=birth_json WHERE operation_id=$1', [sameWorkspace.operationId]), { code: '55000' });
      assert.deepEqual(await ledger(sameWorkspace.operationId), before);
      await assert.rejects(h.admin.query('DELETE FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [sameWorkspace.operationId]), { code: '55000' });
      assert.deepEqual(await ledger(sameWorkspace.operationId), before);
      const legitimate = captureExcalidrawCopyBirthReceipt(before.birth_json); assert.deepEqual(legitimate, sameBirth);
      const publicBlob = blobPath(sameWorkspace.destination.workspaceId, sameWorkspace.hash), blobBefore = await blobObservation(publicBlob);
      const descriptor = Object.getOwnPropertyDescriptor(fsSync, 'openSync'); assert(descriptor?.configurable && 'value' in descriptor);
      const open = fsSync.openSync; let opens = 0;
      Object.defineProperty(fsSync, 'openSync', { ...descriptor, value: (...args: unknown[]) => { opens++; return Reflect.apply(open, fsSync, args); } });
      let callbacks = 0;
      try {
        await assert.rejects(retireExcalidrawCopyAssetOriginal(legitimate.intent.assetOriginal, legitimate), { code: 'NATIVE_COPY_OWNER_CHANGED' });
        assert(legitimateStage);
        await assert.rejects(withPreparedExcalidrawCopyAssets({ stage: legitimateStage, destinationWorkspace: h.destination }, () => { callbacks++; }),
          error => error instanceof Error && ['NATIVE_COPY_OWNER_CHANGED', 'NATIVE_COPY_OWNER_REQUIRED'].includes(String(Reflect.get(error, 'code'))));
      }
      finally { Object.defineProperty(fsSync, 'openSync', descriptor); }
      assert.equal(callbacks, 0, 'A legitimate Stage DTO alone must not create a private or public asset cap.');
      assert.equal(opens, 0, 'The fixed owner frame is required before descriptor/backend/private-manifest IO.');
      assert.deepEqual(await blobObservation(publicBlob), blobBefore); assert.deepEqual(await ledger(sameWorkspace.operationId), before);
    });
    await group('actual new private-directory parent fsync ACK failure stops before B1 and the original Stage recovers', async () => {
      const job = await seed(), target = blobPath(job.destination.workspaceId, job.hash), parentPath = path.dirname(target);
      const parentBefore = await fs.lstat(parentPath, { bigint: true }); assert(parentBefore.isDirectory());
      const namesBefore = new Set(await fs.readdir(parentPath));
      const sourceAssetsBefore = await assetRows(job.source.workspaceId, job.assetId);
      const sourceBlobBefore = await blobObservation(blobPath(job.source.workspaceId, job.hash));
      const sourceSceneRows = async () => (await h.admin.query(`
        SELECT 'scene' AS kind,to_jsonb(s) AS body,xmin::text AS xmin FROM collaboration_excalidraw_states s WHERE document_id=$1
        UNION ALL SELECT 'registry',to_jsonb(d),xmin::text FROM collaboration_documents d WHERE id=$1
        UNION ALL SELECT 'lineage',to_jsonb(l),xmin::text FROM file_collaboration_lineages l
          WHERE id=(SELECT lineage_id FROM collaboration_documents WHERE id=$1) ORDER BY kind`, [job.sourceScene.documentId])).rows;
      const sourceSceneBefore = await sourceSceneRows(); assert.equal(sourceSceneBefore.length, 3);
      await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(path.join(job.destination.rootPath, job.destinationPath)), { code: 'ENOENT' });
      let fired = false, actualFsyncs = 0;
      let directoryWitness: { path: string; dev: string; ino: string; parentDev: string; parentIno: string } | undefined;
      const descriptor = Object.getOwnPropertyDescriptor(fsSync, 'fsyncSync'); assert(descriptor?.configurable && 'value' in descriptor);
      const originalFsync = fsSync.fsyncSync;
      Object.defineProperty(fsSync, 'fsyncSync', { ...descriptor, value: (fd: number): void => {
        originalFsync(fd);
        if (fired) return;
        const actual = fsSync.fstatSync(fd, { bigint: true });
        if (!actual.isDirectory() || actual.dev !== parentBefore.dev || actual.ino !== parentBefore.ino) return;
        const namedParent = fsSync.lstatSync(parentPath, { bigint: true });
        assert.equal(actual.dev, namedParent.dev); assert.equal(actual.ino, namedParent.ino);
        const created = fsSync.readdirSync(parentPath).filter(name => !namesBefore.has(name) && /^\.copy-[a-f0-9-]{36}$/u.test(name));
        if (!created.length) return;
        assert.equal(created.length, 1);
        const privatePath = path.join(parentPath, created[0]), child = fsSync.lstatSync(privatePath, { bigint: true });
        assert(child.isDirectory()); assert.equal(Number(child.mode & BigInt(0o7777)), 0o700);
        assert.deepEqual(fsSync.readdirSync(privatePath), [], 'The real mkdir parent ACK precedes asset bytes and original.json.');
        directoryWitness = { path: privatePath, dev: String(child.dev), ino: String(child.ino), parentDev: String(actual.dev), parentIno: String(actual.ino) };
        actualFsyncs++; fired = true;
        throw Object.assign(new Error('Actual new private-directory parent fsync ACK lost.'), { code: 'EIO' });
      } });
      let attempt: Awaited<ReturnType<typeof run>>;
      try { attempt = await run(job); }
      finally { Object.defineProperty(fsSync, 'fsyncSync', descriptor); }
      assert(fired && directoryWitness); assert.equal(actualFsyncs, 1);
      console.log(JSON.stringify({ diagnostic: 'private-directory-fsync-ack', fired, actualFsyncs,
        status: attempt.execution.status, errorCode: attempt.execution.errorCode ?? null }));
      assert.equal(attempt.execution.status, 'needs_recovery', JSON.stringify({ execution: attempt.execution, directoryWitness }));
      assert.equal(attempt.execution.errorCode, 'EIO'); assert.deepEqual(attempt.copied, []);
      assert.equal(await ledger(job.operationId), undefined, 'No B1 Scene intent may survive a private-directory durability failure.');
      const native = await h.admin.query('SELECT operation_id FROM collaboration_native_copy_receipts WHERE operation_id=$1', [job.operationId]);
      assert.equal(native.rows.length, 0);
      const destinationRows = (await h.admin.query(`SELECT
        (SELECT count(*) FROM collaboration_excalidraw_states WHERE workspace_id=$1 AND path=$2)::integer AS scenes,
        (SELECT count(*) FROM collaboration_documents WHERE workspace_id=$1 AND path=$2)::integer AS registry,
        (SELECT count(*) FROM file_collaboration_lineages WHERE workspace_id=$1 AND path=$2)::integer AS lineages`,
      [job.destination.workspaceId, job.destinationPath])).rows[0];
      assert.deepEqual(destinationRows, { scenes: 0, registry: 0, lineages: 0 });
      assert.equal((await assetRows(job.destination.workspaceId, job.assetId)).length, 0);
      await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(path.join(job.destination.rootPath, job.destinationPath)), { code: 'ENOENT' });
      const operation = (await h.admin.query('SELECT status,error_code FROM workspace_file_operations WHERE operation_id=$1', [job.operationId])).rows[0];
      assert.deepEqual(operation, { status: 'recovery_required', error_code: 'EIO' });
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_steps WHERE operation_id=$1', [job.operationId])).rows[0].n, 0);
      const staged = await staging.loadManagedCopyByOperationId(job.operationId); assert(staged); assert.equal(staged.version, 4);
      assert.deepEqual(await sourceSceneRows(), sourceSceneBefore); assert.deepEqual(await assetRows(job.source.workspaceId, job.assetId), sourceAssetsBefore);
      assert.deepEqual(await blobObservation(blobPath(job.source.workspaceId, job.hash)), sourceBlobBefore);
      const recovered = await complete(job, await run(job), true);
      assert.equal(recovered.intent.stageDigest, staged.payloadSha256);
      assert.deepEqual(await sourceSceneRows(), sourceSceneBefore); assert.deepEqual(await assetRows(job.source.workspaceId, job.assetId), sourceAssetsBefore);
      assert.deepEqual(await blobObservation(blobPath(job.source.workspaceId, job.hash)), sourceBlobBefore);
    });
    await group('byte-identical replacement of the B1 original manifest inode is rejected without adopting or retiring D2', async () => {
      const job = await seed(), publicBlob = blobPath(job.destination.workspaceId, job.hash);
      const sourceAssetsBefore = await assetRows(job.source.workspaceId, job.assetId);
      const sourceBlobBefore = await blobObservation(blobPath(job.source.workspaceId, job.hash));
      const sourceRows = async () => (await h.admin.query(`
        SELECT 'scene' AS kind,to_jsonb(s) AS body,xmin::text AS xmin FROM collaboration_excalidraw_states s WHERE document_id=$1
        UNION ALL SELECT 'registry',to_jsonb(d),xmin::text FROM collaboration_documents d WHERE id=$1
        UNION ALL SELECT 'lineage',to_jsonb(l),xmin::text FROM file_collaboration_lineages l
          WHERE id=(SELECT lineage_id FROM collaboration_documents WHERE id=$1) ORDER BY kind`, [job.sourceScene.documentId])).rows;
      const sourceBefore = await sourceRows(); assert.equal(sourceBefore.length, 3);
      let intent: ExcalidrawCopyIntent | undefined, fired = false;
      const interrupted = await h.withProbe(async event => {
        if (!intent && /^\s*INSERT INTO collaboration_excalidraw_copy_receipts\b/iu.test(event.text) && event.values.includes(job.operationId)) {
          const row = (await event.raw('SELECT intent_json FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
          intent = captureExcalidrawCopyIntent(row.intent_json);
        }
        if (!fired && intent && /^\s*COMMIT\s*$/iu.test(event.text)) {
          fired = true; throw Object.assign(new Error('Actual B1 COMMIT ACK lost before any asset/path publication.'), { code: 'EIO' });
        }
      }, () => run(job));
      assert(fired && intent); assert.equal(interrupted.execution.status, 'needs_recovery', JSON.stringify(interrupted.execution));
      assert.equal(interrupted.execution.errorCode, 'NATIVE_COPY_COMMIT_UNCONFIRMED'); assert.deepEqual(interrupted.copied, []);
      const before = await ledger(job.operationId); assert(before); assert.equal(before.birth_json, null);
      assert.deepEqual(captureExcalidrawCopyIntent(before.intent_json), intent);
      const nativeBefore = (await h.admin.query('SELECT to_jsonb(r) AS body,xmin::text AS xmin FROM collaboration_native_copy_receipts r WHERE operation_id=$1', [job.operationId])).rows;
      assert.equal(nativeBefore.length, 1); assert.equal(nativeBefore[0].body.publication_status, 'native_committed');
      const targetScene = intent.documents[0]; assert(targetScene);
      const noTargetBirth = async () => {
        assert.equal((await h.admin.query(`SELECT id FROM collaboration_documents WHERE id=$1
          UNION ALL SELECT id FROM file_collaboration_lineages WHERE id=$2
          UNION ALL SELECT document_id FROM collaboration_excalidraw_states WHERE document_id=$1`, [targetScene.documentId, targetScene.lineageId])).rows.length, 0);
        assert.equal((await assetRows(job.destination.workspaceId, job.assetId)).length, 0);
        await assert.rejects(fs.lstat(publicBlob), { code: 'ENOENT' });
        await assert.rejects(fs.lstat(path.join(job.destination.rootPath, job.destinationPath)), { code: 'ENOENT' });
      };
      await noTargetBirth();
      const staged = await staging.loadManagedCopyByOperationId(job.operationId); assert(staged); assert.equal(staged.version, 4);
      const originalPath = path.join(path.dirname(publicBlob), intent.assetOriginal.privateDirectory.name, 'original.json');
      const original = await blobObservation(originalPath);
      assert.equal(JSON.parse(original.bytes.toString('utf8')).originalProof, intent.assetOriginal.originalProof);
      const heldOriginal = path.join(h.dataRoot, `held-own-manifest-${crypto.randomUUID()}`);
      await fs.rename(originalPath, heldOriginal);
      await fs.writeFile(originalPath, original.bytes, { flag: 'wx', mode: 0o600 });
      const replacement = await blobObservation(originalPath);
      assert.equal(replacement.mode, 0o600); assert.equal(replacement.nlink, '1'); assert.deepEqual(replacement.bytes, original.bytes);
      assert(replacement.dev !== original.dev || replacement.ino !== original.ino, 'Equal JSON bytes do not prove ownership of a new manifest inode.');
      const rejected = await run(job);
      console.log(JSON.stringify({ diagnostic: 'replaced-private-manifest', differentInode: true,
        status: rejected.execution.status, errorCode: rejected.execution.errorCode ?? null }));
      assert.equal(rejected.execution.status, 'needs_recovery', JSON.stringify(rejected.execution));
      assert.equal(rejected.execution.errorCode, 'EXCALIDRAW_COPY_CHANGED'); assert.deepEqual(rejected.copied, []);
      assert.deepEqual(await blobObservation(originalPath), replacement, 'Recovery preserves the independent replacement inode and contents.');
      assert.deepEqual(await ledger(job.operationId), before); await noTargetBirth();
      assert.deepEqual((await h.admin.query('SELECT to_jsonb(r) AS body,xmin::text AS xmin FROM collaboration_native_copy_receipts r WHERE operation_id=$1', [job.operationId])).rows, nativeBefore);
      assert.equal((await staging.loadManagedCopyByOperationId(job.operationId))?.payloadSha256, staged.payloadSha256);
      assert.deepEqual(await sourceRows(), sourceBefore); assert.deepEqual(await assetRows(job.source.workspaceId, job.assetId), sourceAssetsBefore);
      assert.deepEqual(await blobObservation(blobPath(job.source.workspaceId, job.hash)), sourceBlobBefore);
      // Explicit fixture repair removes only our replacement and restores the
      // exact held original inode; the product itself must not adopt D2.
      await fs.unlink(originalPath); await fs.rename(heldOriginal, originalPath);
      const restored = await blobObservation(originalPath); assert.equal(restored.dev, original.dev); assert.equal(restored.ino, original.ino);
      assert.deepEqual(restored.bytes, original.bytes);
      const resumed = await complete(job, await run(job), true); assert.deepEqual(resumed.intent, intent);
      assert.deepEqual(resumed.birth.documents.map(doc => [doc.documentId, doc.lineageId]), intent.documents.map(doc => [doc.documentId, doc.lineageId]));
      assert.deepEqual(await sourceRows(), sourceBefore); assert.deepEqual(await assetRows(job.source.workspaceId, job.assetId), sourceAssetsBefore);
      assert.deepEqual(await blobObservation(blobPath(job.source.workspaceId, job.hash)), sourceBlobBefore);
    });
  });
  assert.equal(groups, 5);
  assert.deepEqual(Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(file))]))), pins);
  completed = true; console.log(JSON.stringify({ suite: 'workspace-managed-copy-assets-owner-postgres', groups, passed: true, sourcesUnchanged: true }));
}

void managedCopyAssetsOwnerPostgresTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error(JSON.stringify({ suite: 'workspace-managed-copy-assets-owner-postgres', case: currentCase,
    name: error instanceof Error ? error.name : 'unknown', code: typeof code === 'string' && /^[a-z0-9_-]{1,96}$/iu.test(code) ? code : null,
    frames: error instanceof Error ? error.stack?.split('\n').flatMap(line => {
      const match = /\/(app\/lib\/[a-z0-9_./-]+|scripts\/[a-z0-9_./-]+):(\d+):(\d+)\)?$/iu.exec(line);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 6) : [] })); process.exitCode = 1;
});
