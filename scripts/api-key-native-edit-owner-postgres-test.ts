import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { NativeDocumentEditWriteAuthority } from '../app/lib/documents/edit-principal';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import { withNativeApiKeyEditRuntime } from './helpers/native-api-key-edit-runtime';

let stage = 'setup', groups = 0;
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    process.env.FILE_VERSION_CENTER_MODE = 'shadow';
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'read_knowledge_source,edit_knowledge_source' });
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const { createApiIntegration, rotateApiKey, revokeApiKey, updateApiIntegration } = await import('../app/lib/api-keys/management');
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
    const { flushCollaborationDocuments } = await import('../server/collaboration-server');
    const { createPlainTextYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { NextRequest } = await import('next/server');
    const { POST: editHttp } = await import('../app/api/documents/edit/route');
    const { POST: statusHttp } = await import('../app/api/documents/edit/status/route');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const headers = new Headers((await h.request(h.source, 'owner')).headers); headers.set('Origin', 'http://localhost');
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Native API-key editor',
      workspaceIds: [h.source.workspaceId], actions: ['read', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, activeCredentialId = issued.credential.id, managementRevision = 1;
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
    const post = async (action: 'edit' | 'status', value: unknown, extras: Record<string, string> = {}, selectedKey = key) => {
      const request = new NextRequest(`http://localhost/api/documents/edit${action === 'status' ? '/status' : ''}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Canvas-API-Key': selectedKey, ...extras }, body: JSON.stringify(value) });
      const response = await (action === 'edit' ? editHttp(request) : statusHttp(request));
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    let rpcId = 0;
    const rpc = async (method: 'tools/list' | 'tools/call', params: Record<string, unknown>, modern = false) => {
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-Canvas-API-Key': key,
        'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25', ...(modern ? { 'mcp-method': method,
          ...(method === 'tools/call' ? { 'mcp-name': params.name as string } : {}) } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: { ...params, ...(modern ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'native-key-edit-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}) } }) }));
      return { status: response.status, body: await response.json() };
    };
    const mcp = (args: Record<string, unknown>, modern = false) => rpc('tools/call', { name: 'edit_knowledge_source', arguments: args }, modern);
    const check = async (name: string, action: () => Promise<void>) => { stage = name; await action(); groups++;
      console.log(`API-key native edit owner passed: ${name}`); };
    await withNativeApiKeyEditRuntime(h, async ({ runtime }) => {
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
        key = rotated.key; credential = await authenticate(); activeCredentialId = rotated.credential.id; managementRevision = 2;
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
      });
      let publicOperationId: string;
      await check('real REST Edit/Status, exact retry and stale version retain bounded results', async () => {
        const current = await read();
        const value = { ...selected, expectedVersion: current.document.version, idempotencyKey: 'api-key-rest-edit-1',
          patch: { kind: 'native_text_replace', edits: [{ oldText: 'After', newText: 'REST' }] } };
        const response = await post('edit', value); assert.equal(response.status, 200); assert.equal(response.body.state, 'confirmed');
        publicOperationId = response.body.operationId; assert(publicOperationId);
        assert(!JSON.stringify(response.body).includes(issued.integration.id)); assert(!JSON.stringify(response.body).includes(key));
        const repeated = await post('edit', value); assert.equal(repeated.status, 200);
        assert.equal(repeated.body.operationId, publicOperationId); assert.deepEqual(repeated.body.effect, response.body.effect);
        const status = await post('status', { apiVersion: 1, workspaceId: h.source.workspaceId, operationId: publicOperationId });
        assert.equal(status.status, 200); assert.equal(status.body.state, 'confirmed');
        const stale = await post('edit', { ...value, idempotencyKey: 'api-key-rest-stale-1' });
        assert.equal(stale.status, 409); assert.equal(stale.body.code, 'DOCUMENT_VERSION_CONFLICT');
        const invalid = await post('edit', value, {}, 'invalid'); assert.equal(invalid.status, 401); assert.equal(invalid.body.code, 'API_KEY_INVALID');
        const bearer = headers.get('authorization'); assert(bearer);
        const mixed = await post('edit', value, { Authorization: bearer });
        assert.equal(mixed.status, 401); assert.equal(mixed.body.code, 'API_KEY_CREDENTIALS_CONFLICT');
      });
      await check('legacy and modern MCP advertise native-only Edit/Status and execute actual writes', async () => {
        for (const modern of [false, true]) {
          const listing = await rpc('tools/list', {}, modern); assert.equal(listing.status, 200);
          const descriptor = listing.body.result.tools.find((tool: { name: string }) => tool.name === 'edit_knowledge_source'); assert(descriptor);
          assert.deepEqual(descriptor.securitySchemes, [{ type: 'apiKey', in: 'header', name: 'X-Canvas-API-Key' }]);
          const inputValidator = new AjvJsonSchemaValidator().getValidator(descriptor.inputSchema);
          const outputValidator = new AjvJsonSchemaValidator().getValidator(descriptor.outputSchema);
          const current = await read(); const suffix = modern ? ' modern' : ' legacy';
          const input = { api_version: 1, action: 'edit', workspace_id: h.source.workspaceId, document_id: target.documentId,
            expected_version: current.document.version, idempotency_key: `api-key-mcp-${modern ? 'modern' : 'legacy'}-1`,
            patch: { kind: 'native_text_replace', edits: [{ oldText: current.fragment, newText: current.fragment + suffix }] } };
          assert.equal(inputValidator(input).valid, true);
          const response = await mcp(input, modern); assert.equal(response.status, 200); assert.equal(response.body.result?.isError, undefined);
          const value = response.body.result.structuredContent; assert.equal(value.state, 'confirmed'); assert.equal(outputValidator(value).valid, true);
          const args = { api_version: 1, action: 'status', workspace_id: h.source.workspaceId, operation_id: value.operationId };
          assert.equal(inputValidator(args).valid, true);
          const status = await mcp(args, modern); assert.equal(status.body.result.isError, undefined);
          assert.equal(status.body.result.structuredContent.operationId, value.operationId);
          const cross = await post('status', { apiVersion: 1, workspaceId: h.source.workspaceId, operationId: value.operationId });
          assert.equal(cross.status, 200);
          const row = (await h.admin.query('SELECT native_edit_original_json FROM collaboration_agent_operations WHERE operation_id=$1', [value.operationId])).rows[0];
          const origin = (typeof row.native_edit_original_json === 'string' ? JSON.parse(row.native_edit_original_json) : row.native_edit_original_json).origin;
          assert.equal(origin.transport, 'api_key'); assert.equal(origin.entryPoint, 'mcp');
          const legacy = { workspace_id: h.source.workspaceId, path: targetPath, old_text: 'unsafe', new_text: 'unsafe', expected_sha256: 'a'.repeat(64) };
          assert.equal(inputValidator(legacy).valid, false);
          assert((await mcp(legacy, modern)).body.error);
          assert.equal(outputValidator({ apiVersion: 1, success: false, code: 'API_KEY_INVALID', operationId: value.operationId }).valid, true);
        }
      });
      await check('MCP native writes reject an actual hidden registry path before mutation', async () => {
        const hidden = await h.upload('api-key/hidden.md', Buffer.from('Hidden native test document.'));
        const current = await readDocumentForRequest(new Request('http://localhost/api/documents/read', { headers: { 'X-Canvas-API-Key': key } }),
          { apiVersion: 1, workspaceId: h.source.workspaceId, documentId: hidden.documentId, format: 'text' });
        const hiddenPath = '.private/native.md';
        await h.admin.query('UPDATE file_collaboration_lineages SET path=$2 WHERE id=(SELECT lineage_id FROM collaboration_documents WHERE id=$1)', [hidden.documentId, hiddenPath]);
        await h.admin.query('UPDATE collaboration_documents SET path=$2 WHERE id=$1', [hidden.documentId, hiddenPath]);
        await h.admin.query('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [hidden.documentId, hiddenPath]);
        await h.admin.query('UPDATE workspace_file_metadata SET path=$3 WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, 'api-key/hidden.md', hiddenPath]);
        const original = (await h.admin.query('SELECT yjs_state,document_sequence,xmin::text AS xmin FROM collaboration_yjs_states WHERE document_id=$1', [hidden.documentId])).rows[0];
        const denied = await mcp({ api_version: 1, action: 'edit', workspace_id: h.source.workspaceId, document_id: hidden.documentId,
          expected_version: current.document.version, idempotency_key: 'api-key-hidden-native-1',
          patch: { kind: 'native_text_replace', edits: [{ oldText: 'Hidden', newText: 'Denied' }] } });
        assert.equal(denied.body.result.isError, true); assert.equal(denied.body.result.structuredContent.code, 'ACCESS_DENIED');
        assert.deepEqual((await h.admin.query('SELECT yjs_state,document_sequence,xmin::text AS xmin FROM collaboration_yjs_states WHERE document_id=$1', [hidden.documentId])).rows[0], original);
      });
      await check('actual removed actions and key budget produce safe 403/429, without session fallback', async () => {
        await updateApiIntegration(headers, issued.integration.id, { expectedRevision: managementRevision++, name: issued.integration.name,
          workspaceIds: [h.source.workspaceId], actions: ['read', 'edit'] });
        const denied = await post('status', { apiVersion: 1, workspaceId: h.source.workspaceId, operationId: publicOperationId });
        assert.equal(denied.status, 403); assert.equal(denied.body.code, 'API_KEY_ACCESS_DENIED');
        await updateApiIntegration(headers, issued.integration.id, { expectedRevision: managementRevision++, name: issued.integration.name,
          workspaceIds: [h.source.workspaceId], actions: ['read'] });
        const current = await read();
        const write = await post('edit', { ...selected, expectedVersion: current.document.version, idempotencyKey: 'api-key-denied-edit-1' });
        assert.equal(write.status, 403); assert.equal(write.body.code, 'API_KEY_ACCESS_DENIED');
        await updateApiIntegration(headers, issued.integration.id, { expectedRevision: managementRevision++, name: issued.integration.name,
          workspaceIds: [h.source.workspaceId], actions: ['read', 'edit', 'status'] });
        const bucket = `document-api-key:key:${activeCredentialId}`;
        assert.equal((await h.admin.query('UPDATE security_public_rate_limits SET count=240,reset_at=$2 WHERE bucket_key=$1', [bucket, Date.now() + 60_000])).rowCount, 1);
        try {
          const limited = await post('status', { apiVersion: 1, workspaceId: h.source.workspaceId, operationId: publicOperationId });
          assert.equal(limited.status, 429); assert.equal(limited.body.code, 'API_KEY_RATE_LIMITED');
          assert(Number(limited.headers.get('retry-after')) >= 1 && Number(limited.headers.get('retry-after')) <= 60);
        } finally { await h.admin.query('UPDATE security_public_rate_limits SET count=0 WHERE bucket_key=$1', [bucket]); }
      });
      await check('actual member seat and workspace write withdrawal deny before any edit', async () => {
        assert.equal((await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [h.source.workspaceId])).rowCount, 1);
        const memberHeaders = new Headers((await h.request(h.source, 'member')).headers); memberHeaders.set('Origin', 'http://localhost');
        const member = await createApiIntegration(memberHeaders, { requestId: randomUUID(), name: 'Member key authority',
          workspaceIds: [h.source.workspaceId], actions: ['read', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
        const request = { apiVersion: 1, workspaceId: h.source.workspaceId, operationId: publicOperationId };
        const active = await post('status', request, {}, member.key);
        assert.equal(active.status, 404); assert.equal(active.body.code, 'DOCUMENT_NOT_FOUND', 'A current member cannot borrow another integration owner.');
        await h.admin.query("UPDATE team_memberships SET status='suspended' WHERE user_id='member'");
        try { assert.equal((await post('status', request, {}, member.key)).status, 403); }
        finally { await h.admin.query("UPDATE team_memberships SET status='active' WHERE user_id='member'"); }
        await h.admin.query("UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", [h.source.workspaceId]);
        const denied = await post('status', request, {}, member.key); assert.equal(denied.status, 403); assert.equal(denied.body.code, 'API_KEY_ACCESS_DENIED');
        await revokeApiKey(memberHeaders, member.integration.id, { expectedRevision: 1, credentialId: member.credential.id });
      });
      await check('lost actual write COMMIT acknowledgement retains the one real operation and never replays targets', async () => {
        const current = await read(), nextText = current.fragment + ' ACK-durable';
        const value = { ...selected, expectedVersion: current.document.version, idempotencyKey: 'api-key-real-commit-ack-loss-1',
          patch: { kind: 'native_text_replace', edits: [{ oldText: current.fragment, newText: nextText }] } };
        const countBefore = Number((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_agent_operations WHERE document_id=$1', [target.documentId])).rows[0].n);
        let writer: unknown, knownId: string | undefined, injected = false;
        const response = await h.withProbe(async event => {
          if (/INSERT INTO collaboration_agent_native_edit_payloads/iu.test(event.text)
            && runtime()?.documents.get(target.documentId)?.getText('content').toString() === nextText) {
            writer = event.client; assert.equal(typeof event.values[0], 'string'); knownId = event.values[0] as string;
          }
          if (!injected && writer && event.client === writer && event.text.trim() === 'COMMIT') {
            assert.equal(event.result.command, 'COMMIT'); injected = true;
            throw new Error('OWNED_NATIVE_API_KEY_WRITE_COMMIT_ACK_LOSS');
          }
        }, () => post('edit', value));
        assert(injected && knownId); assert([200, 503].includes(response.status)); assert.equal(response.body.operationId, knownId);
        if (response.status === 503) assert(['EDIT_OUTCOME_UNCONFIRMED', 'DOCUMENT_EDIT_UNAVAILABLE'].includes(response.body.code));
        await flushCollaborationDocuments(); assert.equal((await read()).fragment, nextText);
        const observed = await post('status', { apiVersion: 1, workspaceId: h.source.workspaceId, operationId: knownId });
        assert.equal(observed.status, 200); assert.equal(observed.body.state, 'confirmed');
        assert.equal(Number((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_agent_operations WHERE document_id=$1', [target.documentId])).rows[0].n), countBefore + 1);
      });
      await check('actual expiry after the completed write preserves its reference for status after rotation', async () => {
        const current = await read(), nextText = current.fragment + ' expiry-durable';
        const value = { ...selected, expectedVersion: current.document.version, idempotencyKey: 'api-key-post-write-expiry-1',
          patch: { kind: 'native_text_replace', edits: [{ oldText: current.fragment, newText: nextText }] } };
        const expiresAt = Date.now() + 4000;
        await h.admin.query('UPDATE canvas_api_keys SET expires_at=$2 WHERE id=$1', [activeCredentialId, expiresAt]);
        let delayed = false, knownId: string | undefined;
        const response = await h.withProbe(async event => {
          if (delayed || !event.text.includes('WITH selected AS') || !event.text.includes('native_edit_original_json AS original')) return;
          assert.equal(typeof event.values[0], 'string'); knownId = event.values[0] as string;
          assert((await h.admin.query('SELECT native_edit_after_json FROM collaboration_agent_operations WHERE operation_id=$1', [knownId])).rows[0]?.native_edit_after_json);
          delayed = true; await new Promise(resolve => setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 20)));
        }, () => post('edit', value));
        assert(delayed && knownId); assert.equal(response.status, 401); assert.equal(response.body.code, 'API_KEY_INVALID');
        assert.equal(response.body.operationId, knownId); assert(!JSON.stringify(response.body).includes(key));
        const rotated = await rotateApiKey(headers, issued.integration.id, { expectedRevision: managementRevision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
        key = rotated.key; activeCredentialId = rotated.credential.id; credential = await authenticate();
        await flushCollaborationDocuments(); assert.equal((await read()).fragment, nextText);
        const observed = await post('status', { apiVersion: 1, workspaceId: h.source.workspaceId, operationId: knownId });
        assert.equal(observed.status, 200); assert.equal(observed.body.state, 'confirmed');
      });
      await check('revocation and forged session attribution fail without changing the original operation', async () => {
        await revokeApiKey(headers, issued.integration.id, { expectedRevision: managementRevision, credentialId: activeCredentialId });
        const originalRow = await stored(); await assert.rejects(status(), code('API_KEY_INVALID')); assert.deepEqual(await stored(), originalRow);
        assert.equal((await post('status', { apiVersion: 1, workspaceId: h.source.workspaceId, operationId })).status, 401);
        assert.throws(() => captureNativeDocumentEditOrigin({ ...actual.original.origin, sessionId: 'session-owner' }), code('EDIT_OUTCOME_UNCONFIRMED'));
        const { originalProof, ...body } = actual.original; assert(originalProof);
        assert.throws(() => makeNativeDocumentEditOriginal({ ...body, actor: { ...body.actor, sessionId: 'session-owner' } }), code('EDIT_OUTCOME_UNCONFIRMED'));
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM session')).rows[0].n, sessionsBefore);
      });
      await check('deleting the actual issuing session leaves key-only native Edit and Status usable', async () => {
        const independent = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Session-independent native key',
          workspaceIds: [h.source.workspaceId], actions: ['read', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
        const current = await readDocumentForRequest(new Request('http://localhost/api/documents/read', { headers: { 'X-Canvas-API-Key': independent.key } }),
          { apiVersion: 1, workspaceId: h.source.workspaceId, documentId: target.documentId, format: 'text' });
        assert.equal((await h.admin.query("DELETE FROM session WHERE id='session-owner'")).rowCount, 1);
        const value = { ...selected, expectedVersion: current.document.version, idempotencyKey: 'api-key-after-issuing-session-1',
          patch: { kind: 'native_text_replace', edits: [{ oldText: current.fragment, newText: current.fragment + ' after-logout' }] } };
        const response = await post('edit', value, {}, independent.key); assert.equal(response.status, 200); assert.equal(response.body.state, 'confirmed');
        const observed = await post('status', { apiVersion: 1, workspaceId: h.source.workspaceId, operationId: response.body.operationId }, {}, independent.key);
        assert.equal(observed.status, 200); assert.equal(observed.body.state, 'confirmed');
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM session')).rows[0].n, sessionsBefore - 1);
        assert.equal((await h.admin.query('SELECT actor_session_id FROM collaboration_agent_operations WHERE operation_id=$1',
          [response.body.operationId])).rows[0].actor_session_id, null);
        // This key's genuine manager session is now absent. The complete owned
        // fixture schema, including its credentials, is removed after runtime shutdown.
      });
    });
  });
  console.log(`API-key native edit owner: ${groups} PostgreSQL/native-runtime/route/MCP groups passed. Installed SDK writes and compiled acceptance remain separate.`);
}
main().catch(error => {
  const safe = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error(`API-key native edit owner failed (${stage}): ${safe}`); process.exitCode = 1;
});
