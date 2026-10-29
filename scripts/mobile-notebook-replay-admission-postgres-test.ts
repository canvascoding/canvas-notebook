import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
await withNativeCopyMetadataOwnerFixture(async h => {
  const { requireRequestWorkspace, workspaceFileOptions } = await import('../app/lib/workspaces/request');
  const { readMobileNotebookDocument, saveMobileNotebookDocument } = await import('../app/lib/mobile/notebook');
  const { readMobileNotebookOperation } = await import('../app/lib/mobile/notebook-operations');
  const { mobileNotebookErrorResponse } = await import('../app/lib/mobile/notebook-route');
  const { createCollaborationServer } = await import('../server/collaboration-server');
  const { createCollaborationRoomOwnerOptions } = await import('../app/lib/collaboration/room-owner-options');
  const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
  const selected = await requireRequestWorkspace(await h.request(h.source, 'owner', true), { permissions: 'canWrite' });
  if (selected.response) assert.fail('Genuine owner request must succeed.');
  const native = await h.upload('mobile-replay/original.md', Buffer.from('Original'));
  const input = { workspace: selected.workspace, fileOptions: workspaceFileOptions(selected.workspace),
    actorUserId: selected.session.user.id, actorSessionId: String(selected.session.session.id), path: 'mobile-replay/original.md' };
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = createCollaborationServer(server, { roomOwner: createCollaborationRoomOwnerOptions() });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = await readMobileNotebookDocument(input);
    const firstInput = { ...input, content: 'Applied', expectedSha256: base.sha256,
      baseRevisionId: base.revisionId, idempotencyKey: randomUUID() };
    const first = await saveMobileNotebookDocument(firstInput); assert(first.saveReceipt?.durable);
    const latest = await readMobileNotebookDocument(input);
    const peer = await saveMobileNotebookDocument({ ...input, content: 'Peer replaced all mobile text',
      expectedSha256: latest.sha256, baseRevisionId: latest.revisionId, idempotencyKey: randomUUID() });
    assert(peer.saveReceipt?.durable); assert.equal(peer.content, 'Peer replaced all mobile text');
    const physicalFile = path.join(h.source.rootPath, input.path);
    const projectionDeadline = Date.now() + 15_000;
    while ((await readFile(physicalFile, 'utf8')).trim() !== peer.content) {
      assert(Date.now() < projectionDeadline, 'Complete the genuine peer checkpoint before freezing replay evidence.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const snapshot = async () => ({
      native: (await h.admin.query('SELECT yjs_state,state_vector,document_sequence,lifecycle_generation FROM collaboration_yjs_states WHERE document_id=$1', [native.documentId])).rows,
      originalReceipt: await readMobileNotebookOperation(first.saveReceipt!.operationId),
      originalReceiptIdentity: (await h.admin.query('SELECT operation_id,xmin::text AS xmin FROM mobile_notebook_operations WHERE operation_id=$1', [first.saveReceipt!.operationId])).rows,
      bytes: await readFile(physicalFile),
    });
    const before = await snapshot(); assert.equal(before.originalReceipt?.yjs_update, null);
    await h.admin.query('BEGIN');
    await h.admin.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(h.source.workspaceId)]);
    try {
      // This independently held real PG reader remains live through admission,
      // original receipt verification and the fixed result-completion read.
      const retried = await saveMobileNotebookDocument(firstInput);
      assert.equal(retried.content, peer.content); assert.equal(retried.saveReceipt?.operationId, first.saveReceipt!.operationId);
      assert.equal(retried.saveReceipt?.durable, true); assert.deepEqual(await snapshot(), before);
      await assert.rejects(saveMobileNotebookDocument({ ...firstInput, content: 'Changed original key' }),
        error => error instanceof Error && Reflect.get(error, 'code') === 'IDEMPOTENCY_CONFLICT');
      assert.deepEqual(await snapshot(), before);
      const current = await readMobileNotebookDocument(input);
      const operationsBefore = (await h.admin.query('SELECT count(*)::integer AS n FROM mobile_notebook_operations WHERE document_id=$1', [native.documentId])).rows[0].n;
      const busyResponses: Response[] = [];
      await assert.rejects(saveMobileNotebookDocument({ ...input, content: 'Unapplied mutation must remain strict',
        expectedSha256: current.sha256, baseRevisionId: current.revisionId, idempotencyKey: randomUUID() }),
        error => {
          assert(error instanceof Error && Reflect.get(error, 'code') === 'ADMISSION_CONFLICT');
          const busyResponse = mobileNotebookErrorResponse(error, 'Actual unaccepted mutation'); busyResponses.push(busyResponse);
          assert.equal(busyResponse.status, 503); assert.equal(busyResponse.headers.get('Cache-Control'), 'no-store, max-age=0');
          return true;
        });
      assert.equal(busyResponses.length, 1);
      const busyBody = await busyResponses[0].json(); assert.equal(busyBody.success, false); assert.equal(busyBody.code, 'COLLABORATION_BUSY');
      assert.equal(typeof busyBody.error, 'string');
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM mobile_notebook_operations WHERE document_id=$1', [native.documentId])).rows[0].n, operationsBefore);
      assert.deepEqual(await snapshot(), before);
      console.log('PASS real shared-reader replay: original receipt and later peer edit preserved; conflicting key denied.');
    } finally { await h.admin.query('ROLLBACK'); }
    await h.admin.query('BEGIN');
    await h.admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey(h.source.workspaceId)]);
    try {
      await assert.rejects(saveMobileNotebookDocument(firstInput), error => error instanceof Error && Reflect.get(error, 'code') === 'ADMISSION_CONFLICT');
      assert.deepEqual(await snapshot(), before);
    } finally { await h.admin.query('ROLLBACK'); }
    const expiry = (await h.admin.query('SELECT expires_at FROM session WHERE id=$1', [input.actorSessionId])).rows[0].expires_at;
    try {
      await h.admin.query('UPDATE session SET expires_at=1 WHERE id=$1', [input.actorSessionId]);
      await assert.rejects(saveMobileNotebookDocument(firstInput), error => error instanceof Error && Reflect.get(error, 'code') === 'COLLABORATION_ACCESS_REVOKED');
      assert.deepEqual(await snapshot(), before);
    } finally { await h.admin.query('UPDATE session SET expires_at=$2 WHERE id=$1', [input.actorSessionId, expiry]); }
    console.log('Mobile replay PG: real shared-reader receipt verification, later peer deletion, fingerprint binding, exclusive owner denial and expired user denial passed.');
  } finally {
    await h.admin.query('ROLLBACK');
    await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
completed = true;
