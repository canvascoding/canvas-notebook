import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { measureDocumentDatabaseActivity, measureDocumentOperation, withDocumentOperationMetricObserver,
  type DocumentDatabaseActivityMeasurement, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

assert.equal(process.env.NODE_ENV, 'test');
const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT; assert(output && path.isAbsolute(output));
const measurements: Array<{ label: string; value: DocumentDatabaseActivityMeasurement }> = [];
const operations: DocumentOperationMeasurement[] = [];
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

await withDocumentOperationMetricObserver(value => operations.push(value), () => withNativeCopyMetadataOwnerFixture(async h => {
  // Real cookie route handlers and their actual native Move owner. Only setup
  // is an isolated SQL QA fixture; there is no invented invocation or policy.
  const { POST: rename } = await import('../app/api/files/rename/route');
  const { POST: mobileMove } = await import('../app/api/mobile/v1/files/move/route');
  const resume = await import('../app/api/files/operations/implicit-moves/[requestId]/route');
  const batch = await import('../app/api/files/operations/batches/[batchId]/route');
  const { readWorkspaceImplicitMovePreparation, readWorkspaceImplicitMoveBinding } = await import('../app/lib/files/workspace-implicit-move-parser');
  const { readWorkspacePathOperation } = await import('../app/lib/files/workspace-path-operation-parser');
  const { readPiRuntimeConfig } = await import('../app/lib/agents/storage');
  const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
  const { WORKSPACE_FILE_UNDO_ENABLED } = await import('../app/lib/files/workspace-file-undo-policy');
  const { createWorkspaceOperationBatchWorker } = await import('../app/lib/files/workspace-operation-batch-worker');
  const { Y } = await import('../app/lib/collaboration/server-runtime');
  const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
  const { createCollaborationServer } = await import('../server/collaboration-server');
  const { createCollaborationRoomOwnerOptions } = await import('../app/lib/collaboration/room-owner-options');
  await readPiRuntimeConfig(); assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
  assert.equal(WORKSPACE_FILE_UNDO_ENABLED, false);
  const targetText = '# Native target\n\n[Other](source.md)\n\nKeep all content 😀.\n';
  const incomingText = '# Incoming\n\n[Target](target.md)\n';
  const target = await h.upload('folder/target.md', Buffer.from(targetText));
  const incoming = await h.upload('folder/source.md', Buffer.from(incomingText));
  const authenticated = await h.request(h.source, 'owner', true);
  const request = (url: string, method: 'GET' | 'POST', body?: object) => new NextRequest(`http://localhost${url}`, {
    method, headers: new Headers({ ...Object.fromEntries(authenticated.headers), 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const readNative = async (documentId: string) => {
    const row = (await h.admin.query(`SELECT d.lineage_id,d.status AS registry_status,s.* FROM collaboration_documents d
      JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.id=$1 AND d.workspace_id=$2`,
    [documentId, h.source.workspaceId])).rows[0]; assert(row);
    const doc = new Y.Doc();
    try { Y.applyUpdate(doc, new Uint8Array(row.yjs_state)); return { path: String(row.path), lineageId: String(row.lineage_id),
      lifecycleGeneration: Number(row.lifecycle_generation), sequence: Number(row.document_sequence),
      checkpointSequence: Number(row.checkpoint_sequence), checkpointed: row.checkpointed_at !== null,
      status: row.status, registryStatus: row.registry_status,
      text: row.representation === 'plain_text' ? doc.getText('content').toString() : richMarkdownFromYDoc(doc) }; }
    finally { doc.destroy(); }
  };
  const initialTarget = await readNative(target.documentId), initialIncoming = await readNative(incoming.documentId);
  const run = async (label: string, action: 'rename' | 'move', oldPath: string, newPath: string,
    invoke: typeof rename): Promise<{ operationId: string; body: Record<string, unknown> }> => {
    const operationId = randomUUID();
    return measureDocumentDatabaseActivity(action, 'request', () => measureDocumentOperation(action, 'request', async () => {
      const previewResponse = await invoke(request('/api/files/rename', 'POST', { oldPath, newPath, dryRun: true }));
      const preview = await previewResponse.json(); assert.equal(previewResponse.status, 200, `Public preview failed: ${preview.code ?? 'unknown'}`);
      assert.equal(preview.plan.kind, 'native-path-change'); assert.equal(preview.plan.readiness, 'ready');
      assert.equal(preview.plan.linkAssessment.complete, true);
      let response = await invoke(request(action === 'move' ? '/api/mobile/v1/files/move' : '/api/files/rename', 'POST',
        { oldPath, newPath, idempotencyKey: operationId }));
      let pinned: ReturnType<typeof readWorkspacePathOperation> | undefined;
      let pinnedBinding: ReturnType<typeof readWorkspaceImplicitMoveBinding> | undefined;
      const deadline = Date.now() + 60_000;
      while (true) {
        const body = await response.json() as Record<string, unknown>;
        assert([200, 202].includes(response.status) && body.success === true,
          `Public file action failed: ${String(body.code ?? 'unknown')} (${response.status})`);
        if (body.preparation) {
          const preparation = readWorkspaceImplicitMovePreparation(body.preparation, { actorUserId: 'owner',
            workspaceId: h.source.workspaceId, operationId, action: 'rename',
            selections: [{ sourcePath: oldPath, destinationPath: newPath }] });
          assert(preparation.state === 'pending' && preparation.canResume, 'The original preparation cannot safely resume.');
          assert(Date.now() < deadline, 'The public preparation did not finish.');
          await new Promise(done => setTimeout(done, 500));
          response = await resume.POST(request(preparation.resumeUrl, 'POST', {}), { params: Promise.resolve({ requestId: preparation.requestId }) });
          continue;
        }
        const operation = readWorkspacePathOperation(body.operation, pinned ?? { workspaceId: h.source.workspaceId });
        assert.equal(operation.kind, 'rename');
        assert.deepEqual(operation.selections, [{ sourcePath: oldPath, destinationPath: newPath }]);
        if (!pinned) {
          pinnedBinding = readWorkspaceImplicitMoveBinding(operation.implicitBinding,
            { actorUserId: 'owner', workspaceId: h.source.workspaceId, operationId });
          pinned = operation;
        } else if (operation.implicitBinding) readWorkspaceImplicitMoveBinding(operation.implicitBinding, pinnedBinding);
        // The normal status endpoint omits this mapping. Like the existing
        // client, retain only the previously verified immutable binding after
        // checking the exact saved batch/plan/workspace; never invent one.
        if (['queued', 'applying'].includes(operation.status)) {
          assert(Date.now() < deadline, 'The public file action did not finish.');
          await new Promise(done => setTimeout(done, 500));
          response = await batch.GET(request(`/api/files/operations/batches/${operation.batchId}`, 'GET'),
            { params: Promise.resolve({ batchId: operation.batchId }) }); continue;
        }
        assert.equal(operation.status, 'applied', `Public operation stopped: ${operation.errorCode ?? operation.status}`);
        assert.equal(operation.phase, 'complete'); assert.equal(body.linkStatus, 'complete');
        // SQL completion confirms native links. The regular projector owns
        // their physical files, so include real convergence in this window.
        const projectionDeadline = Date.now() + 45_000;
        for (;;) {
          let converged = true;
          for (const id of [target.documentId, incoming.documentId]) {
            const state = await readNative(id);
            if (!state.checkpointed || state.sequence !== state.checkpointSequence) converged = false;
            try { if (await fs.readFile(path.join(h.source.rootPath, state.path), 'utf8') !== state.text) converged = false; }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') converged = false; else throw error; }
          }
          if (converged) break;
          assert(Date.now() < projectionDeadline, 'The normal durable projector did not materialize native link changes.');
          await new Promise(done => setTimeout(done, 250));
        }
        return { operationId, body };
      }
    }), value => measurements.push({ label, value }));
  };
  // The production custom server owns this worker. A bare HTTP-route fixture
  // must start the real worker too; queued jobs are not self-executing routes.
  // Retain all genuine ticks so cleanup waits for actual claim completion.
  const worker = createWorkspaceOperationBatchWorker(), ticks = new Set<Promise<unknown>>(), workerErrors: unknown[] = [];
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = createCollaborationServer(server, { roomOwner: createCollaborationRoomOwnerOptions() });
  const tick = () => {
    const pending = worker.tick(); ticks.add(pending);
    void pending.catch(error => workerErrors.push(error)).finally(() => ticks.delete(pending));
  };
  const timer = setInterval(tick, 1000); tick();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const renamed = await run('public-web-rename-including-preview-and-completion', 'rename', 'folder/target.md', 'folder/renamed.md', rename);
    assert.deepEqual(await readNative(target.documentId), { ...initialTarget, path: 'folder/renamed.md' });
    assert.equal((await readNative(incoming.documentId)).text, incomingText.replace('(target.md)', '(renamed.md)'));
    const moved = await run('public-mobile-move-including-preview-and-completion', 'move', 'folder/renamed.md', 'destination/renamed.md', mobileMove);
    const finalTarget = await readNative(target.documentId), finalIncoming = await readNative(incoming.documentId);
    assert.equal(finalTarget.lineageId, initialTarget.lineageId); assert.equal(finalIncoming.lineageId, initialIncoming.lineageId);
    assert.equal(finalTarget.status, 'active'); assert.equal(finalTarget.registryStatus, 'active');
    assert.equal(finalIncoming.status, 'active'); assert.equal(finalIncoming.registryStatus, 'active');
    assert.equal(finalTarget.path, 'destination/renamed.md');
    assert.equal(finalTarget.text, targetText.replace('(source.md)', '(../folder/source.md)'));
    assert.equal(finalIncoming.text, incomingText.replace('(target.md)', '(../destination/renamed.md)'));
    assert.equal(await fs.readFile(path.join(h.source.rootPath, finalTarget.path), 'utf8'), finalTarget.text);
    assert.equal(await fs.readFile(path.join(h.source.rootPath, finalIncoming.path), 'utf8'), finalIncoming.text);
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, 'folder/target.md')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, 'folder/renamed.md')), { code: 'ENOENT' });
    assert.notEqual(renamed.operationId, moved.operationId);
    console.log(JSON.stringify({ publicPathBaseline: true, reviewCenter: false, fileUndo: false,
      verified: 'actual-cookie-public-handlers-native-owner-and-bidirectional-links',
      measurements: measurements.map(row => ({ label: row.label, statements: row.value.statements, checkouts: row.value.checkouts })) }));
  } finally {
    clearInterval(timer); await Promise.all([...ticks]);
    assert.equal(wss.clients.size, 0, 'This path fixture must retain no transport peers.');
    await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(workerErrors.length, 0);
    console.log(JSON.stringify({ closure: 'document-public-path-runtime', workerDrained: true, serversClosed: true }));
  }
}));
await fs.writeFile(output, JSON.stringify({ version: 1, fixture: 'public-document-path-operations',
  scope: 'actual-cookie-route-handlers-preview-apply-and-terminal-status-no-next-middleware', measurements, operations }, null, 2) + '\n',
{ mode: 0o600, flag: 'wx' });
completed = true;
