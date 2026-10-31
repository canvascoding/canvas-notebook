import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { Hocuspocus } from '@hocuspocus/server';
import type { NativeDocumentEditWriteAuthority } from '../app/lib/documents/edit-principal';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let stage = 'setup', groups = 0;
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    process.env.FILE_VERSION_CENTER_MODE = 'shadow';
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const { createApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withNativeDocumentEditApiKeyAuthority: capture, withNativeDocumentEditWriteAuthorityOnConnection: phase } =
      await import('../app/lib/documents/edit-principal');
    const { applyNativeDocumentEdit } = await import('../app/lib/documents/edit-service');
    const { readNativeDocumentEditOperationStatus } = await import('../app/lib/documents/edit-operation-status');
    const { captureNativeDocumentEditOrigin, captureNativeDocumentEditOriginal, makeNativeDocumentEditOriginal,
      nativeDocumentEditOwnerTuple } = await import('../app/lib/collaboration/native-document-edit-operation-contract');
    const { apiKeyActorId } = await import('../app/lib/api-keys/actor');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const { openDb } = await import('../app/lib/db');
    const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
    const { createCollaborationServer, flushCollaborationDocuments } = await import('../server/collaboration-server');
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const { createPlainTextYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const headers = new Headers((await h.request(h.source, 'owner')).headers); headers.set('Origin', 'http://localhost');
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Native API-key editor',
      workspaceIds: [h.source.workspaceId], actions: ['read', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
    let key = issued.key;
    const authenticate = () => authenticateApiKeyRequest(new Request('http://localhost/api/documents/edit', { headers: { 'X-Canvas-API-Key': key } }));
    let credential = await authenticate();
    const run = <T>(purpose: 'edit' | 'edit_status', consume: (authority: NativeDocumentEditWriteAuthority) => Promise<T>) =>
      capture(credential, { workspaceId: h.source.workspaceId }, 'request', purpose, consume);
    const sessionsBefore = (await h.admin.query('SELECT count(*)::int AS n FROM session')).rows[0].n;
    const originalText = 'Before native API-key edit Äpfel 😀.';
    const targetPath = 'api-key/native-edit.md';
    const target = await h.upload(targetPath, Buffer.from('Original file seed.'));
    const doc = createPlainTextYDoc(originalText);
    try { await h.admin.query(`UPDATE collaboration_yjs_states SET representation='plain_text',yjs_state=$2,state_vector=$3,
      document_sequence=document_sequence+1,checkpoint_sequence=0,checkpointed_at=NULL,canonical_hash=NULL,serialized_hash=NULL
      WHERE document_id=$1`, [target.documentId, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]); }
    finally { doc.destroy(); }
    await unlink(path.join(h.source.rootPath, targetPath));
    const read = () => readDocumentForRequest(new Request('http://localhost/api/documents/read', { headers: { 'X-Canvas-API-Key': key } }),
      { apiVersion: 1, workspaceId: h.source.workspaceId, documentId: target.documentId, format: 'text' });
    const server = http.createServer();
    const clients = new Set<Client>(), ownerSessions = new Set<Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>>();
    let runtime: Hocuspocus | undefined, wss: ReturnType<typeof createCollaborationServer> | undefined;
    const originalHooks = Hocuspocus.prototype.hooks;
    const check = async (name: string, action: () => Promise<void>) => { stage = name; await action(); groups++;
      console.log(`API-key native edit owner passed: ${name}`); };
    try {
      Hocuspocus.prototype.hooks = (async function(this: Hocuspocus, name: string, payload: Record<string, unknown>, ...args: unknown[]) {
        // Observation only; the actual Hocuspocus hook always runs.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        runtime = this; return Reflect.apply(originalHooks, this, [name, payload, ...args]);
      }) as typeof originalHooks;
      wss = createCollaborationServer(server, { roomOwner: { heartbeatMs: 1000, createSession: async onInvalidated => {
        const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: h.applicationName,
          options: `-c search_path=${h.schema},pg_catalog -c statement_timeout=15000`, connectionTimeoutMillis: 5000 });
        clients.add(client); client.on('error', () => undefined); await client.connect();
        const session = await createCollaborationRoomOwnerSession({ query: client.query.bind(client), on: client.on.bind(client),
          end: async () => { await client.end(); clients.delete(client); } }, onInvalidated);
        ownerSessions.add(session); return session;
      } } });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      await check('genuine native authority has an API-key origin and no borrowed session', async () => {
        await run('edit', authority => executeLifecycleTransaction({ openConnection: openDb,
          execute: database => phase(database, authority, async access => {
            assert.equal(access.origin.transport, 'api_key'); assert.equal(access.actorType, 'agent');
            assert.equal(access.sessionId, null); assert.equal(access.actorId, apiKeyActorId({ userId: 'owner',
              integrationId: issued.integration.id, instanceId: process.env.CANVAS_INSTANCE_ID! }));
            assert.deepEqual(captureNativeDocumentEditOrigin(access.origin), access.origin);
            assert(!Object.keys(access.origin).some(name => /session|token|secret/iu.test(name)));
            assert(!JSON.stringify(access.origin).includes(key)); access.assertActive(); await access.assertCurrent(); access.assertActive();
          }), recoverCommitted: async (_value, error) => { throw error; } }));
      });
      const before = await read();
      const selected = { apiVersion: 1 as const, workspaceId: h.source.workspaceId, documentId: target.documentId,
        expectedVersion: before.document.version, idempotencyKey: 'api-key-native-owner-1',
        patch: { kind: 'native_text_replace' as const, edits: [{ oldText: 'Before', newText: 'After' }] } };
      const actual = await run('edit', authority => applyNativeDocumentEdit(authority, selected));
      const operationId = actual.operation.operationId;
      const status = () => run('edit_status', authority => readNativeDocumentEditOperationStatus(authority,
        { apiVersion: 1, workspaceId: h.source.workspaceId, operationId }));
      const stored = async () => (await h.admin.query(`SELECT operation_id,actor_id,actor_session_id,native_edit_original_json,
        native_edit_after_json,xmin::text AS xmin FROM collaboration_agent_operations WHERE operation_id=$1`, [operationId])).rows[0];
      await check('real native writer persists the key origin, null session, After and durable result', async () => {
        assert.equal(actual.after?.outcome, 'applied'); assert.equal(actual.original.origin.transport, 'api_key');
        assert.equal(actual.original.actor.sessionId, null);
        const row = await stored(); assert.equal(row.actor_session_id, null); assert.equal(row.actor_id, actual.original.actor.actorId);
        const original = captureNativeDocumentEditOriginal(typeof row.native_edit_original_json === 'string'
          ? JSON.parse(row.native_edit_original_json) : row.native_edit_original_json);
        assert.deepEqual(original, actual.original); assert.equal((await read()).fragment, originalText.replace('Before', 'After'));
        const result = await status(); assert.equal(result.state, 'confirmed'); assert.equal(result.operationId, operationId);
        assert.equal(result.history.status, 'captured'); assert(result.history.revisionId);
        const history = (await h.admin.query(`SELECT r.created_by_user_id,r.created_by_actor_type,r.source_session_id,r.history_only,
          c.content_format,c.source FROM file_revisions r JOIN file_revision_contents c ON c.revision_id=r.id WHERE r.id=$1`,
        [result.history.revisionId])).rows[0];
        assert.deepEqual(history, { created_by_user_id: 'owner', created_by_actor_type: 'agent', source_session_id: null,
          history_only: true, content_format: 'binary', source: 'agent_apply' });
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM session')).rows[0].n, sessionsBefore);
      });
      await check('rotation preserves the owner and exact receipt; another integration cannot read its status', async () => {
        const rotated = await rotateApiKey(headers, issued.integration.id, { expectedRevision: 1, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
        key = rotated.key; credential = await authenticate();
        const originalRow = await stored();
        const repeated = await run('edit', authority => applyNativeDocumentEdit(authority, selected));
        assert.deepEqual(repeated, actual); assert.deepEqual(await stored(), originalRow); assert.equal((await status()).state, 'confirmed');
        const other = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Other native API-key editor',
          workspaceIds: [h.source.workspaceId], actions: ['read', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
        const ownCredential = credential;
        credential = await authenticateApiKeyRequest(new Request('http://localhost/api/documents/edit/status', { headers: { 'X-Canvas-API-Key': other.key } }));
        try { await assert.rejects(status(), code('DOCUMENT_NOT_FOUND')); }
        finally { credential = ownCredential; }
        assert.equal(actual.original.origin.transport, 'api_key');
        if (actual.original.origin.transport === 'api_key') {
          assert.equal(actual.original.origin.credentialId, issued.credential.id);
          assert.deepEqual(nativeDocumentEditOwnerTuple(actual.original.origin), ['api_key', 'owner', issued.integration.id, process.env.CANVAS_INSTANCE_ID]);
        }
        await revokeApiKey(headers, other.integration.id, { expectedRevision: 1, credentialId: other.credential.id });
        await revokeApiKey(headers, issued.integration.id, { expectedRevision: 2, credentialId: rotated.credential.id });
      });
      await check('revocation and forged session attribution fail without changing the original operation', async () => {
        const originalRow = await stored(); await assert.rejects(status(), code('API_KEY_INVALID')); assert.deepEqual(await stored(), originalRow);
        assert.throws(() => captureNativeDocumentEditOrigin({ ...actual.original.origin, sessionId: 'session-owner' }), code('EDIT_OUTCOME_UNCONFIRMED'));
        const { originalProof, ...body } = actual.original; assert(originalProof);
        assert.throws(() => makeNativeDocumentEditOriginal({ ...body, actor: { ...body.actor, sessionId: 'session-owner' } }), code('EDIT_OUTCOME_UNCONFIRMED'));
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM session')).rows[0].n, sessionsBefore);
      });
    } finally {
      const errors: unknown[] = [];
      try { await flushCollaborationDocuments(); } catch (error) { errors.push(error); }
      if (runtime) {
        for (const doc of [...runtime.documents.values()]) try { await runtime.unloadDocument(doc); } catch (error) { errors.push(error); }
        for (const pending of [...runtime.unloadingDocuments.values()]) try { await pending; } catch (error) { errors.push(error); }
      }
      if (wss) try { await new Promise<void>((resolve, reject) => wss!.close(error => error ? reject(error) : resolve())); } catch (error) { errors.push(error); }
      try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { errors.push(error); }
      for (const session of ownerSessions) try { await session.close(); } catch (error) { errors.push(error); }
      for (const client of clients) try { await client.end(); clients.delete(client); } catch (error) { errors.push(error); }
      Hocuspocus.prototype.hooks = originalHooks;
      assert.equal(server.listening, false); assert.equal(clients.size, 0);
      if (errors.length) throw new AggregateError(errors, 'Native API-key room cleanup failed.');
      console.log(JSON.stringify({ suite: 'api-key-native-edit-owner', roomOwnersClosed: true, listeningHttpServers: 0, reviewCenterEnabled: false }));
    }
  });
  console.log(`API-key native edit owner: ${groups} PostgreSQL/native-runtime groups passed. Public adapters and compiled acceptance remain separate.`);
}
main().catch(error => {
  const safe = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error(`API-key native edit owner failed (${stage}): ${safe}`); process.exitCode = 1;
});
