import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const portable = (id: string) => JSON.stringify({ type: 'excalidraw', version: 2,
  elements: [{ id: `image-${id}`, type: 'image', fileId: id, version: 1, versionNonce: 1, isDeleted: false }],
  appState: { viewBackgroundColor: '#ffffff' }, files: { [id]: { id, mimeType: 'image/png',
    dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 42, version: 1 } } });

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { openDb } = await import('../app/lib/db');
    const { reserveCollaborationAdmissionOnConnection, createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { collaborationAdmissionActionDigest, collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { createExcalidrawDocument: create, getExcalidrawDocument: get } = await import('../app/lib/excalidraw-collaboration/scene-service');
    const { importExcalidrawDocumentFile: importScene } = await import('../app/lib/excalidraw-collaboration/portable-import');
    const { ExcalidrawLifecycleUnavailableError } = await import('../app/lib/excalidraw-collaboration/lifecycle-availability');
    const { WorkspaceFileLifecycleBusyError } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { getFileCollaborationState } = await import('../app/lib/files/collaboration-policy');
    const { renameWorkspacePath } = await import('../app/lib/files/rename-service');
    const workspace = h.destination, actor = { userId: 'member', actorId: 'member', actorType: 'user' as const, sessionId: 'session-member' };
    const admission = createCollaborationAdmissionService({ openConnection: openDb });
    const tables = ['file_collaboration_lineages', 'collaboration_documents', 'file_revisions', 'file_revision_contents', 'file_version_blobs',
      'collaboration_excalidraw_states', 'collaboration_excalidraw_operations', 'collaboration_excalidraw_assets',
      'collaboration_excalidraw_agent_operations', 'collaboration_excalidraw_creates', 'collaboration_excalidraw_checkpoint_intents',
      'collaboration_excalidraw_restores', 'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets'];
    const rows = async () => {
      const result: Record<string, unknown> = {};
      for (const table of tables) result[table] = (await h.admin.query(`SELECT to_jsonb(t) AS row, xmin::text AS xmin FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      return result;
    };
    const files = async (roots = [workspace.rootPath, path.join(h.dataRoot, 'collaboration-assets', 'excalidraw')]) => {
      const result: Record<string, unknown> = {};
      const visit = async (file: string): Promise<void> => {
        const stat = await fs.lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) { result[file] = null; return; }
        assert(!stat.isSymbolicLink());
        result[file] = { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
          ...(stat.isFile() ? { bytes: (await fs.readFile(file)).toString('base64') } : {}) };
        if (stat.isDirectory()) for (const entry of (await fs.readdir(file)).sort()) await visit(path.join(file, entry));
      };
      for (const root of roots) await visit(root);
      return result;
    };
    const reserve = async (reservedPath: string, kind: 'exact' | 'subtree' = 'exact') => {
      const actionPayloadText = JSON.stringify({ test: 'excalidraw-lifecycle-availability', path: reservedPath, kind });
      const request: CollaborationAdmissionRequest = { requestId: randomUUID(), actorId: actor.actorId, action: 'copy_replace', actionPayloadText,
        actionDigest: collaborationAdmissionActionDigest('copy_replace', actionPayloadText),
        scopes: [{ workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null, path: reservedPath, kind }], expectedDocuments: [] };
      await h.connection.run('BEGIN');
      try { const reserved = await reserveCollaborationAdmissionOnConnection(h.connection, request);
        assert.equal(reserved.status, 'reserved'); assert.deepEqual(reserved.targets, []); await h.connection.run('COMMIT');
      } catch (error) { await h.connection.run('ROLLBACK'); throw error; }
      // A distinct production checkout observes the committed reservation; no open fixture TX remains.
      assert.equal((await admission.read(request))?.status, 'reserved');
      return request;
    };
    const release = async (request: CollaborationAdmissionRequest, status: 'cancelled' | 'committed' = 'cancelled') => {
      if (status === 'cancelled') { assert.equal((await admission.cancel(request, 1)).status, status); return; }
      // Arrange a terminal header with real SQL for an empty Yjs target set. This is
      // an availability test, not proof of a Copy mutation or handoff completion.
      await h.connection.run('BEGIN');
      try {
        await h.connection.get('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey(workspace.workspaceId)]);
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_admission_targets WHERE request_id=$1', [request.requestId])).rows[0].n, 0);
        assert.equal((await h.admin.query(`UPDATE collaboration_admission_requests SET status='committed', revision=revision+1,
          completed_at=$2, outcome_text='{}' WHERE request_id=$1 AND status='reserved'`, [request.requestId, Date.now()])).rowCount, 1);
        await h.connection.run('COMMIT');
      } catch (error) { await h.connection.run('ROLLBACK'); throw error; }
      assert.equal((await admission.read(request))?.status, status);
    };
    const busy = async (operation: () => Promise<unknown>) => {
      const beforeRows = await rows(), beforeFiles = await files();
      await assert.rejects(operation, (error: unknown) => {
        assert(error instanceof ExcalidrawLifecycleUnavailableError); assert.equal(error.code, 'EXCALIDRAW_FILE_LIFECYCLE_BUSY');
        assert.equal(error.status, 409); assert(error.cause instanceof WorkspaceFileLifecycleBusyError); return true;
      });
      assert.deepEqual(await rows(), beforeRows, 'Busy must precede any identity, journal, revision, Scene or asset DML (including last_referenced_at/xmin).');
      assert.deepEqual(await files(), beforeFiles, 'Busy must preserve bytes/inodes and publish no portable file, temporary file or asset blob.');
    };
    let groups = 0;
    const group = async (name: string, operation: () => Promise<void>) => { await operation(); console.log(`ok ${++groups} - ${name}`); };

    await group('registered and unregistered portable bootstrap remain untouched until cancellation', async () => {
      for (const registered of [true, false]) {
        const target = `${registered ? 'registered' : 'unregistered'}.excalidraw`, assetId = `${registered ? 'registered' : 'unregistered'}-asset`;
        await fs.writeFile(path.join(workspace.rootPath, target), portable(assetId));
        const document = registered ? (await getFileCollaborationState({ workspace, path: target, ensureDocument: true })).document : null;
        if (registered) { assert.equal(document?.provider, 'excalidraw'); assert(document); }
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_excalidraw_states WHERE workspace_id=$1 AND path=$2', [workspace.workspaceId, target])).rows[0].n, 0);
        const request = await reserve(target);
        await busy(() => get({ workspace, path: target, actor }));
        if (document) await busy(() => get({ workspace, documentId: document.id, actor }));
        await release(request);
        const result = await get({ workspace, path: target, actor });
        if (document) assert.equal(result.documentId, document.id);
        assert.equal(result.assets[0].fileId, assetId); assert.equal(result.elements[0].id, `image-${assetId}`);
      }
    });
    await group('fresh create and portable import cannot publish before a terminal release', async () => {
      const createPath = 'fresh-create.excalidraw', importPath = 'fresh-import.excalidraw';
      const input = { workspace, actor, path: createPath, idempotencyKey: randomUUID() };
      const createRequest = await reserve(createPath), importRequest = await reserve(importPath);
      await busy(() => create(input));
      await busy(() => importScene({ workspace, actor, path: importPath, content: portable('fresh-import-asset') }));
      await busy(() => get({ workspace, path: createPath, actor }));
      await release(createRequest); assert.equal((await create(input)).path, createPath);
      await release(importRequest, 'committed');
      const imported = await importScene({ workspace, actor, path: importPath, content: portable('fresh-import-asset') });
      assert.equal(imported.path, importPath); assert.equal(imported.assets[0].fileId, 'fresh-import-asset');
    });
    await group('initialized reads and completed-create retries do not touch assets or revisions while reserved', async () => {
      const initialized = await importScene({ workspace, actor, path: 'initialized.excalidraw', content: portable('initialized-asset') });
      const request = await reserve(initialized.path);
      await busy(() => get({ workspace, path: initialized.path, actor }));
      await busy(() => get({ workspace, documentId: initialized.documentId, actor }));
      await release(request, 'committed'); assert.equal((await get({ workspace, documentId: initialized.documentId, actor })).documentId, initialized.documentId);
      const input = { workspace, actor, path: 'completed-create.excalidraw', idempotencyKey: randomUUID() };
      const created = await create(input), createRequest = await reserve(created.path);
      await busy(() => create(input)); await release(createRequest);
      assert.equal((await create(input)).documentId, created.documentId);
    });
    await group('subtree reservations cover descendants and permit unrelated sibling prefixes', async () => {
      await fs.mkdir(path.join(workspace.rootPath, 'reserved-tree'), { recursive: true });
      await fs.writeFile(path.join(workspace.rootPath, 'reserved-tree/raw.excalidraw'), portable('subtree-asset'));
      const request = await reserve('reserved-tree', 'subtree');
      await busy(() => get({ workspace, path: 'reserved-tree/raw.excalidraw', actor }));
      await busy(() => create({ workspace, actor, path: 'reserved-tree/new.excalidraw', idempotencyKey: randomUUID() }));
      await busy(() => importScene({ workspace, actor, path: 'reserved-tree/import.excalidraw', content: portable('subtree-import-asset') }));
      const unrelated = await create({ workspace, actor, path: 'reserved-tree-sibling.excalidraw', idempotencyKey: randomUUID() });
      assert.equal(unrelated.path, 'reserved-tree-sibling.excalidraw');
      await release(request); assert.equal((await get({ workspace, path: 'reserved-tree/raw.excalidraw', actor })).assets[0].fileId, 'subtree-asset');
    });
    await group('historical create follows moved D1 while old-path D2 is reserved', async () => {
      const input = { workspace, actor, path: 'historical.excalidraw', idempotencyKey: randomUUID() }, movedPath = 'historical-moved.excalidraw';
      const d1 = await create(input);
      await renameWorkspacePath({ workspace, oldPath: input.path, newPath: movedPath, overwrite: false, fileOptions: { workspace } });
      const d2 = await create({ ...input, idempotencyKey: randomUUID() }); assert.notEqual(d1.documentId, d2.documentId);
      const oldReservation = await reserve(input.path);
      const d2Rows = async () => (await h.admin.query(`SELECT to_jsonb(d) AS document,d.xmin::text AS document_xmin,
        to_jsonb(s) AS scene,s.xmin::text AS scene_xmin,to_jsonb(l) AS lineage,l.xmin::text AS lineage_xmin
        FROM collaboration_documents d JOIN collaboration_excalidraw_states s ON s.document_id=d.id
        JOIN file_collaboration_lineages l ON l.id=d.lineage_id WHERE d.id=$1`, [d2.documentId])).rows;
      const beforeRows = await d2Rows(), beforeFiles = await files([path.join(workspace.rootPath, input.path)]);
      const retry = await create(input); assert.equal(retry.documentId, d1.documentId); assert.equal(retry.path, movedPath);
      assert.deepEqual(await d2Rows(), beforeRows); assert.deepEqual(await files([path.join(workspace.rootPath, input.path)]), beforeFiles);
      const currentReservation = await reserve(movedPath);
      await busy(() => create(input)); await busy(() => get({ workspace, documentId: d1.documentId, actor }));
      await release(currentReservation); await release(oldReservation);
      assert.equal((await create(input)).documentId, d1.documentId);
    });
    await group('preparing receipt with no document checks its stored path before any DML', async () => {
      const originalPath = 'pending-original.excalidraw', storedPath = 'pending-moved.excalidraw', idempotencyKey = randomUUID();
      // Adversarial durable receipt arrangement: request fingerprint retains the original path.
      await h.admin.query(`INSERT INTO collaboration_excalidraw_creates
        (workspace_id,actor_user_id,actor_id,idempotency_key,request_fingerprint,path,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [workspace.workspaceId, actor.userId, actor.actorId, idempotencyKey,
        createHash('sha256').update(JSON.stringify({ workspaceId: workspace.workspaceId, path: originalPath })).digest('hex'), storedPath, Date.now()]);
      const request = await reserve(storedPath);
      await busy(() => create({ workspace, actor, path: originalPath, idempotencyKey }));
      await release(request);
      const imported = await importScene({ workspace, actor, path: storedPath, content: portable('pending-release-asset') });
      assert.equal(imported.path, storedPath);
    });
    assert.equal(groups, 6);
    console.log('Excalidraw durable-reservation availability: 6 PostgreSQL service groups passed; no HTTP authorization or full Copy completion claim.');
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
