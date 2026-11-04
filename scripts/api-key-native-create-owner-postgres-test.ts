import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let stage = 'setup', groups = 0;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
async function main() {
  const sourceUrl = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/c518f7a927cff918bce35d3522fcdb046d264d7c/README.md';
  const response = await fetch(sourceUrl, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200); assert.equal(response.url, sourceUrl); assert(response.body);
  const chunks: Uint8Array[] = [], reader = response.body.getReader(); let size = 0;
  try { for (;;) { const value = await reader.read(); if (value.done) break; size += value.value.byteLength;
    assert(size <= 10000); chunks.push(value.value); } } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  const sourceBytes = Buffer.concat(chunks); assert(sourceBytes.length >= 128);
  const helperPath = path.resolve('scripts/runtime/markdown-create-birth.py'), helperHash = sha(await readFile(helperPath));
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'read_knowledge_source,create_knowledge_source,import_knowledge_file' });
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const { createApiIntegration, updateApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { persistAndProjectApiKeyMarkdownCreate: createNative, assertAuthenticatedApiKeyMarkdownBirthStorageAllowed } =
      await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { observeMarkdownCreateBirth, apiKeyMarkdownCreateAttribution } = await import('../app/lib/files/markdown-create-birth');
    const { captureApiKeyDocumentCreateOrigin } = await import('../app/lib/api-keys/document-create-origin');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const headers = new Headers((await h.request(h.source, 'owner')).headers); headers.set('Origin', 'http://localhost');
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Native key creator', workspaceIds: [h.source.workspaceId],
      actions: ['read', 'create', 'import'], expiresAt: Date.now() + 3_600_000 });
    const managerToken = randomBytes(32).toString('hex');
    await h.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('key-create-manager',$1,'owner',$2,$3,$3)",
      [managerToken, Date.now() + 3_600_000, Date.now()]);
    const sessionsBefore = (await h.admin.query('SELECT count(*)::int AS n FROM session')).rows[0].n;
    let key = issued.key, credentialId = issued.credential.id, revision = 1;
    const authenticate = () => authenticateApiKeyRequest(new Request('http://localhost/api/documents/create', { headers: { 'X-Canvas-API-Key': key } }));
    let credential = await authenticate();
    const create = (filePath: string, content: string, idempotencyKey: string, entryPoint: 'request' | 'mcp' = 'request') =>
      createNative(credential, { tool: 'create_knowledge_source', workspaceId: h.source.workspaceId, path: filePath, content, idempotencyKey }, entryPoint);
    const read = (documentId: string) => readDocumentForRequest(new Request('http://localhost/api/documents/read', { headers: { 'X-Canvas-API-Key': key } }),
      { apiVersion: 1, workspaceId: h.source.workspaceId, documentId, format: 'markdown' });
    const receipt = async (operationId: string) => (await h.admin.query(`SELECT r.*,r.xmin::text AS xmin FROM collaboration_markdown_file_import_receipts r
      WHERE workspace_id=$1 AND operation_id=$2`, [h.source.workspaceId, operationId])).rows[0];
    const stored = async (documentId: string) => ({
      document: (await h.admin.query('SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [documentId])).rows,
      state: (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [documentId])).rows,
      revisions: (await h.admin.query('SELECT to_jsonb(r) AS row,xmin::text AS xmin FROM file_revisions r WHERE lineage_id=(SELECT lineage_id FROM collaboration_documents WHERE id=$1) ORDER BY id', [documentId])).rows,
    });
    const controlPath = 'key-create/protected.md', controlBytes = Buffer.from('Protected original native document.');
    const control = await h.upload(controlPath, controlBytes), controlBefore = await stored(control.documentId);
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++;
      console.log(`API-key native Create owner passed: ${name}`); };
    let result: Awaited<ReturnType<typeof create>>;
    const text = 'Native key creation Äpfel 😀 日本語.\n', createdPath = 'key-create/new.md', stableKey = 'api-key-native-create-1';
    await check('real filled native birth, file, revision, projection and key origin have no borrowed session', async () => {
      result = await create(createdPath, text, stableKey);
      assert.equal(result.apiVersion, 1); assert.equal(result.outcome, 'created'); assert.equal(result.projection.status, 'current');
      const current = await read(result.document.documentId); assert.equal(current.document.version, result.document.version);
      assert.equal(current.fragment, text); assert.deepEqual(await readFile(path.join(h.source.rootPath, createdPath)), Buffer.from(text));
      const row = await receipt(result.operationId); assert.equal(row.actor_session_id, null); assert.equal(row.actor_user_id, 'owner');
      assert.equal(row.private_result.sourceHash, sha(text)); assert.equal(row.private_result.sourceBytes, Buffer.byteLength(text));
      const birth = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId: result.operationId });
      assert(birth.complete && birth.revisionId && birth.serializedHash);
      const origin = captureApiKeyDocumentCreateOrigin(birth.intent.origin); assert(origin);
      assert.equal(origin.kind, 'api_key'); assert.equal(origin.integrationId, issued.integration.id); assert.equal(origin.credentialId, issued.credential.id);
      assert.equal(origin.entryPoint, 'request'); assert.equal(origin.purpose, 'create');
      assert(!Object.keys(origin).some(name => /session|client|token|secret/iu.test(name)));
      const binding = apiKeyMarkdownCreateAttribution(birth.intent); assert.equal(binding.actorSessionId, null);
      assert(!JSON.stringify(birth.intent).includes(key));
      const revisionRow = (await h.admin.query('SELECT created_by_user_id,created_by_actor_type,source_session_id FROM file_revisions WHERE id=$1', [birth.revisionId])).rows[0];
      assert.deepEqual(revisionRow, { created_by_user_id: 'owner', created_by_actor_type: 'agent', source_session_id: null });
    });
    await check('identical retry, actual rotation and the MCP entry retain exact original receipts and native rows', async () => {
      const before = await stored(result.document.documentId), original = await receipt(result.operationId);
      assert.equal((await create(createdPath, text, stableKey)).operationId, result.operationId);
      const rotated = await rotateApiKey(headers, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id; credential = await authenticate();
      const repeated = await create(createdPath, text, stableKey, 'mcp'); assert.equal(repeated.operationId, result.operationId); assert.equal(repeated.outcome, 'already_created');
      assert.deepEqual(repeated.document, result.document); assert.deepEqual(await stored(result.document.documentId), before);
      assert.deepEqual(await receipt(result.operationId), original);
      const birth = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId: result.operationId });
      assert.equal((birth.intent.origin as Record<string, unknown>).credentialId, issued.credential.id);
    });
    await check('changed content and copied historical source data cannot confer authority or rewrite the original', async () => {
      const before = await stored(result.document.documentId), original = await receipt(result.operationId);
      await assert.rejects(create(createdPath, text + 'changed', stableKey), code('MARKDOWN_IMPORT_REQUEST_CONFLICT'));
      await assert.rejects(create('key-create/changed-path.md', text, stableKey), code('MARKDOWN_IMPORT_REQUEST_CONFLICT'));
      const birth = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId: result.operationId });
      assert.equal(captureApiKeyDocumentCreateOrigin({ ...(birth.intent.origin as object), sessionId: 'session-owner' }), null);
      assert.throws(() => apiKeyMarkdownCreateAttribution({ ...birth.intent, source: { ...(birth.intent.source as object), actorSessionId: 'session-owner' } }),
        code('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED'));
      await assert.rejects(assertAuthenticatedApiKeyMarkdownBirthStorageAllowed({ workspaceRoot: h.source.rootPath, targetPath: createdPath,
        origin: birth.intent.origin as Record<string, unknown>, source: birth.intent.source as Record<string, unknown>, operationId: result.operationId }, 'entry'),
      code('MARKDOWN_IMPORT_INVALID_INPUT'));
      assert.deepEqual(await stored(result.document.documentId), before); assert.deepEqual(await receipt(result.operationId), original);
    });
    await check('Create without Read can create an actual empty native document, but cannot import or borrow another integration', async () => {
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
        workspaceIds: [h.source.workspaceId], actions: ['create'] });
      const empty = await create('key-create/empty.md', '', 'api-key-native-empty-1');
      assert.equal((await readFile(path.join(h.source.rootPath, 'key-create/empty.md'))).length, 0);
      const checked = await readDocumentForRequest(await h.request(h.source, 'owner'),
        { apiVersion: 1, workspaceId: h.source.workspaceId, documentId: empty.document.documentId, format: 'markdown' });
      assert.equal(checked.fragment, ''); assert.equal(checked.document.version, empty.document.version);
      await assert.rejects(createNative(credential, { tool: 'import_knowledge_file', workspaceId: h.source.workspaceId, path: 'key-create/denied.md',
        idempotencyKey: 'api-key-denied-import-1', file: { download_url: sourceUrl, file_id: 'denied-before-download' } }, 'request'), code('API_KEY_ACCESS_DENIED'));
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
        workspaceIds: [h.source.workspaceId], actions: ['read', 'create', 'import'] });
      const other = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Other genuine key creator',
        workspaceIds: [h.source.workspaceId], actions: ['create'], expiresAt: Date.now() + 3_600_000 });
      const otherCredential = await authenticateApiKeyRequest(new Request('http://localhost/api/documents/create',
        { headers: { 'X-Canvas-API-Key': other.key } }));
      const original = await receipt(result.operationId), before = await stored(result.document.documentId);
      await assert.rejects(createNative(otherCredential, { tool: 'create_knowledge_source', workspaceId: h.source.workspaceId,
        path: createdPath, content: text, idempotencyKey: stableKey }, 'request'),
      error => code('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED')(error) || code('MARKDOWN_IMPORT_TARGET_CHANGED')(error));
      assert.deepEqual(await receipt(result.operationId), original); assert.deepEqual(await stored(result.document.documentId), before);
      await revokeApiKey(headers, other.integration.id, { expectedRevision: 1, credentialId: other.credential.id });
    });
    await check('actual HTTPS import binds original bytes and returns before an unusable URL on retry', async () => {
      const selection = { tool: 'import_knowledge_file' as const, workspaceId: h.source.workspaceId, path: 'key-create/imported.md',
        idempotencyKey: 'api-key-native-import-1', file: { download_url: sourceUrl, file_id: 'api-key-readme-c518f7a9', mime_type: 'text/markdown' } };
      const imported = await createNative(credential, selection, 'mcp'); assert.equal(imported.outcome, 'created');
      const original = await receipt(imported.operationId), nativeBefore = await stored(imported.document.documentId);
      assert.equal(original.private_result.sourceHash, sha(sourceBytes)); assert.equal(original.private_result.sourceBytes, sourceBytes.length);
      const retry = await createNative(credential, { ...selection, file: { ...selection.file, download_url: 'https://127.0.0.1:1/expired' } }, 'request');
      assert.equal(retry.outcome, 'already_created'); assert.equal(retry.operationId, imported.operationId);
      assert.deepEqual(await receipt(imported.operationId), original); assert.deepEqual(await stored(imported.document.documentId), nativeBefore);
      const birth = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId: imported.operationId });
      assert.equal((birth.intent.origin as Record<string, unknown>).purpose, 'import');
      assert(!JSON.stringify(birth.intent).includes(sourceUrl)); assert(!JSON.stringify(birth.intent).includes('download_url'));
    });
    await check('lost actual native COMMIT acknowledgement recovers the original receipt without a second insert', async () => {
      let writer: unknown, injected = false, inserts = 0;
      const completed = await h.withProbe(async event => {
        if (event.text.includes('INSERT INTO collaboration_markdown_file_import_receipts')) { writer = event.client; inserts++; }
        if (!injected && writer === event.client && event.text.trim() === 'COMMIT') { injected = true; throw new Error('Owned acknowledgement lost after successful native COMMIT.'); }
      }, () => create('key-create/ack-lost.md', 'Durable key creation after lost COMMIT.\n', 'api-key-native-create-lost-1'));
      assert(injected); assert.equal(inserts, 1); assert.equal(completed.outcome, 'created'); assert.equal(completed.projection.status, 'current');
      assert.equal((await read(completed.document.documentId)).document.version, completed.document.version);
    });
    await check('the native request entry admits a hidden workspace path while MCP cannot borrow its original permission', async () => {
      const hiddenPath = '.private/key-created.md', hiddenKey = 'api-key-rest-hidden-create-1';
      const hidden = await create(hiddenPath, 'Hidden native REST source.\n', hiddenKey);
      const before = await stored(hidden.document.documentId), original = await receipt(hidden.operationId);
      assert.equal((await read(hidden.document.documentId)).fragment, 'Hidden native REST source.\n');
      assert.equal(await readFile(path.join(h.source.rootPath, hiddenPath), 'utf8'), 'Hidden native REST source.\n');
      await assert.rejects(create(hiddenPath, 'Hidden native REST source.\n', hiddenKey, 'mcp'), code('MCP_INGEST_INVALID_PATH'));
      assert.deepEqual(await stored(hidden.document.documentId), before); assert.deepEqual(await receipt(hidden.operationId), original);
    });
    await check('rotation after native COMMIT fences the old key and explicitly resumes the original projection', async () => {
      const pendingPath = 'key-create/rotated-pending.md', pendingText = 'Original durable creation awaits its projection.\n';
      let writer: unknown, rotated: Awaited<ReturnType<typeof rotateApiKey>> | undefined, inserts = 0;
      await assert.rejects(h.withProbe(async event => {
        if (event.text.includes('INSERT INTO collaboration_markdown_file_import_receipts')) { writer = event.client; inserts++; }
        if (!rotated && writer === event.client && event.text.trim() === 'COMMIT') {
          rotated = await rotateApiKey(headers, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
        }
      }, () => create(pendingPath, pendingText, 'api-key-native-create-rotate-1')), code('API_KEY_INVALID'));
      assert(rotated); assert.equal(inserts, 1);
      await assert.rejects(lstat(path.join(h.source.rootPath, pendingPath)), code('ENOENT'));
      const pending = (await h.admin.query('SELECT operation_id,private_result FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1',
        [h.source.workspaceId])).rows.find(row => row.private_result.target.path === pendingPath); assert(pending);
      const original = await receipt(pending.operation_id), documentId = pending.private_result.target.documentId;
      const bytesBefore = (await h.admin.query('SELECT yjs_state,state_vector,document_sequence,lifecycle_generation FROM collaboration_yjs_states WHERE document_id=$1', [documentId])).rows;
      const birthBefore = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId: pending.operation_id });
      assert.equal(birthBefore.complete, false);
      key = rotated.key; credentialId = rotated.credential.id; credential = await authenticate();
      let repeatedInserts = 0;
      const resumed = await h.withProbe(async event => { if (event.text.includes('INSERT INTO collaboration_markdown_file_import_receipts')) repeatedInserts++; },
        () => create(pendingPath, pendingText, 'api-key-native-create-rotate-1', 'mcp'));
      assert.equal(resumed.operationId, pending.operation_id); assert.equal(resumed.document.documentId, documentId); assert.equal(resumed.projection.status, 'current');
      assert.equal(repeatedInserts, 0); assert.deepEqual(await receipt(pending.operation_id), original);
      assert.deepEqual((await h.admin.query('SELECT yjs_state,state_vector,document_sequence,lifecycle_generation FROM collaboration_yjs_states WHERE document_id=$1', [documentId])).rows, bytesBefore);
      const birthAfter = await observeMarkdownCreateBirth({ workspaceRoot: h.source.rootPath, workspaceId: h.source.workspaceId, operationId: pending.operation_id });
      assert(birthAfter.complete); assert.deepEqual(birthAfter.intent, birthBefore.intent);
      assert.equal(await readFile(path.join(h.source.rootPath, pendingPath), 'utf8'), pendingText);
    });
    await check('actual logout retains creation; revoked key and disabled MCP tools cannot create', async () => {
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source';
      await assert.rejects(create('key-create/disabled.md', 'Denied.', 'api-key-disabled-create-1', 'mcp'), code('API_KEY_TOOL_DISABLED'));
      assert.equal((await h.admin.query("DELETE FROM session WHERE id='session-owner'")).rowCount, 1);
      headers.set('Authorization', `Bearer ${managerToken}`);
      const independent = await create('key-create/after-logout.md', 'Key works after logout.\n', 'api-key-native-create-logout-1');
      assert.equal(independent.outcome, 'created'); assert.equal((await receipt(independent.operationId)).actor_session_id, null);
      await revokeApiKey(headers, issued.integration.id, { expectedRevision: revision, credentialId });
      await assert.rejects(create('key-create/revoked.md', 'Denied.', 'api-key-revoked-create-1'), code('API_KEY_INVALID'));
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM session')).rows[0].n, sessionsBefore - 1);
    });
    assert.deepEqual(await stored(control.documentId), controlBefore);
    assert.deepEqual(await readFile(path.join(h.source.rootPath, controlPath)), controlBytes);
    assert.equal(sha(await readFile(helperPath)), helperHash);
  });
  console.log(`API-key native Create owner: ${groups} actual PostgreSQL/FD/Birth/HTTPS groups passed. Public adapters and installed SDK remain separate.`);
}
main().catch(error => {
  const message = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error(`API-key native Create owner failed (${stage}): ${message}`); process.exitCode = 1;
});
