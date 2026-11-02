import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import { frameworkTrackedRequest } from './helpers/framework-tracked-request';

let stage = 'setup', groups = 0;
async function main() {
  const sourceUrl = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/c518f7a927cff918bce35d3522fcdb046d264d7c/README.md';
  const source = await fetch(sourceUrl, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000) });
  assert.equal(source.status, 200); const sourceBytes = Buffer.from(await source.arrayBuffer());
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'create_knowledge_source,import_knowledge_file,read_knowledge_source' });
    const { NextRequest } = await import('next/server');
    const { POST: createHttp } = await import('../app/api/documents/create/route');
    const { POST: importHttp } = await import('../app/api/documents/import/route');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const { decodeDocumentCreateRequestV1 } = await import('../app/lib/documents/create-contract');
    const { documentCreateFailureV1 } = await import('../app/lib/documents/create-public-service');
    const { config } = await import('../proxy');
    const { unstable_doesMiddlewareMatch } = await import('next/experimental/testing/server');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const manager = new Headers((await h.request(h.source, 'owner')).headers); manager.set('Origin', 'http://localhost');
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Actual native create adapters',
      workspaceIds: [h.source.workspaceId], actions: ['read', 'create', 'import'], expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id, revision = 1, rpcId = 0;
    const managerToken = randomBytes(32).toString('hex');
    await h.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('create-adapter-manager',$1,'owner',$2,$3,$3)",
      [managerToken, Date.now() + 3_600_000, Date.now()]);
    const check = async (name: string, action: () => Promise<void>) => { stage = name; await action(); groups++;
      console.log(`API-key native Create adapters passed: ${name}`); };
    const selection = (filePath: string, idempotencyKey: string, content = 'Native adapters Äpfel 😀.\n') =>
      ({ apiVersion: 1, workspaceId: h.source.workspaceId, path: filePath, idempotencyKey, content });
    const post = async (action: 'create' | 'import', value: unknown, extras: Record<string, string> = {}, raw?: string | Uint8Array) => {
      const response = await (action === 'create' ? createHttp : importHttp)(frameworkTrackedRequest(new NextRequest(`http://localhost/api/documents/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Canvas-API-Key': key, ...extras },
        body: raw instanceof Uint8Array ? new Uint8Array(raw) : raw ?? JSON.stringify(value) })));
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('www-authenticate'), null);
      const body = await response.json(); assert(!JSON.stringify(body).includes(key));
      return { status: response.status, headers: response.headers, body };
    };
    const rpc = async (method: 'tools/list' | 'tools/call', params: Record<string, unknown>, modern = false) => {
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-Canvas-API-Key': key,
        'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25', ...(modern ? { 'mcp-method': method,
          ...(method === 'tools/call' ? { 'mcp-name': params.name as string } : {}) } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: { ...params, ...(modern ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'native-key-create-adapter', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}) } }) }));
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('www-authenticate'), null);
      return { status: response.status, body: await response.json() };
    };
    const mcp = (name: string, args: Record<string, unknown>, modern = false) => rpc('tools/call', { name, arguments: args }, modern);
    const mcpSelection = (value: ReturnType<typeof selection>) => ({ api_version: 1, workspace_id: value.workspaceId,
      path: value.path, content: value.content, idempotency_key: value.idempotencyKey });
    const receipt = async (operationId: string) => (await h.admin.query('SELECT to_jsonb(r) AS row,xmin::text AS xmin FROM collaboration_markdown_file_import_receipts r WHERE operation_id=$1', [operationId])).rows;
    const count = async () => Number((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_markdown_file_import_receipts')).rows[0].n);
    const read = (documentId: string) => readDocumentForRequest(new Request('http://localhost/api/documents/read', { headers: { 'X-Canvas-API-Key': key } }),
      { apiVersion: 1, workspaceId: h.source.workspaceId, documentId, format: 'markdown' });
    const control = await h.upload('adapters/protected.md', Buffer.from('Protected source.'));
    const snapshot = async () => ({ document: (await h.admin.query('SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [control.documentId])).rows,
      state: (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [control.documentId])).rows,
      bytes: await readFile(path.join(h.source.rootPath, 'adapters/protected.md')) });
    const protectedBefore = await snapshot();
    await check('strict data-only decoding and exact proxy exclusions do not open neighboring APIs', async () => {
      let getters = 0;
      assert.throws(() => decodeDocumentCreateRequestV1({ ...selection('adapters/getter.md', 'native-getter-key-1'), get content() { getters++; return 'forged'; } }, 'create', 'request'));
      assert.equal(getters, 0);
      const hostile = new Proxy({}, { getPrototypeOf() { getters++; throw new Error('Must not inspect proxy.'); } });
      assert.equal(documentCreateFailureV1(hostile).body.code, 'DOCUMENT_CREATE_UNAVAILABLE'); assert.equal(getters, 0);
      const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
      assert.equal(matches('/api/documents/create'), false); assert.equal(matches('/api/documents/import'), false);
      assert.equal(matches('/api/documents/create/status'), true); assert.equal(matches('/api/secrets'), true);
    });
    await check('both real MCP transports advertise native-only key schemas and perform filled creation', async () => {
      for (const modern of [false, true]) {
        const list = await rpc('tools/list', {}, modern); assert.equal(list.status, 200);
        for (const name of ['create_knowledge_source', 'import_knowledge_file']) {
          const descriptor = list.body.result.tools.find((tool: { name: string }) => tool.name === name); assert(descriptor);
          assert.deepEqual(descriptor.securitySchemes, [{ type: 'apiKey', in: 'header', name: 'X-Canvas-API-Key' }]);
          assert(descriptor.inputSchema.required.includes('api_version'));
          const validate = new AjvJsonSchemaValidator().getValidator(descriptor.outputSchema);
          assert.equal(validate({ apiVersion: 1, success: false, code: 'API_KEY_ACCESS_DENIED' }).valid, true);
          assert.equal(validate({ operation_id: 'legacy-file' }).valid, false);
        }
        const args = mcpSelection(selection(`adapters/mcp-${modern}.md`, `native-mcp-protocol-${modern}`));
        const result = await mcp('create_knowledge_source', args, modern); assert.equal(result.status, 200);
        assert.equal(result.body.result.isError, undefined); const created = result.body.result.structuredContent;
        assert.equal(created.outcome, 'created'); assert.equal(created.projection.status, 'current');
        const descriptor = list.body.result.tools.find((tool: { name: string }) => tool.name === 'create_knowledge_source');
        assert.equal(new AjvJsonSchemaValidator().getValidator(descriptor.outputSchema)(created).valid, true);
        assert.equal((await read(created.document.documentId)).document.version, created.document.version);
      }
    });
    const originalSelection = selection('adapters/rest.md', 'native-rest-adapter-1');
    const originalResponse = await post('create', originalSelection); assert.equal(originalResponse.status, 200);
    const original = originalResponse.body, originalReceipt = await receipt(original.operationId);
    await check('REST creation and cross-transport exact retry retain one real origin and receipt', async () => {
      assert.equal((await read(original.document.documentId)).fragment, originalSelection.content);
      const repeated = await mcp('create_knowledge_source', mcpSelection(originalSelection), true);
      assert.equal(repeated.body.result.structuredContent.operationId, original.operationId);
      assert.equal(repeated.body.result.structuredContent.outcome, 'already_created');
      assert.deepEqual(await receipt(original.operationId), originalReceipt);
      const hidden = await post('create', selection('.private/rest.md', 'native-hidden-adapter-1', ''));
      assert.equal(hidden.status, 200); assert.equal((await read(hidden.body.document.documentId)).fragment, '');
      assert((await mcp('create_knowledge_source', mcpSelection(selection('.private/rest.md', 'native-hidden-adapter-1', '')))).body.error);
    });
    await check('conflicts, invalid versions, bytes and mixed credentials cannot mutate existing content', async () => {
      const before = await count();
      for (const change of [{ content: 'Changed' }, { path: 'adapters/different.md' }]) {
        const denied = await post('create', { ...originalSelection, ...change });
        assert.equal(denied.status, 409); assert.equal(denied.body.code, 'DOCUMENT_CREATE_CONFLICT');
      }
      assert.equal((await post('create', { ...originalSelection, apiVersion: 2 })).status, 400);
      assert.equal((await post('create', { ...originalSelection, path: 'adapters/unsupported.txt' })).status, 422);
      assert.equal((await post('create', { ...originalSelection, content: 'x'.repeat(512 * 1024 + 1) })).status, 413);
      assert.equal((await post('create', { ...originalSelection, path: 'adapters/nul.md', idempotencyKey: 'native-nul-adapter-1', content: 'Invalid\u0000text' })).status, 400);
      assert.equal((await post('create', { ...originalSelection, content: '\ud800' })).status, 400);
      assert.equal((await post('create', null, {}, new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]))).status, 400);
      assert.equal((await post('create', originalSelection, { Authorization: manager.get('authorization')! })).body.code, 'API_KEY_CREDENTIALS_CONFLICT');
      assert.equal((await post('create', originalSelection, { 'X-Canvas-API-Key': 'invalid' })).status, 401);
      const missing = mcpSelection(originalSelection); delete (missing as Record<string, unknown>).api_version;
      assert((await mcp('create_knowledge_source', missing)).body.error);
      assert.equal(await count(), before); assert.deepEqual(await receipt(original.operationId), originalReceipt);
      assert.equal((await read(original.document.documentId)).fragment, originalSelection.content);
    });
    await check('real HTTPS import preserves independent source bytes and ignores an expired URL on exact retry', async () => {
      const value = { apiVersion: 1, workspaceId: h.source.workspaceId, path: 'adapters/import.md', idempotencyKey: 'native-import-adapter-1',
        file: { download_url: sourceUrl, file_id: 'native-api-adapter-readme', mime_type: 'text/markdown' } };
      const imported = await post('import', value); assert.equal(imported.status, 200);
      assert.deepEqual(await readFile(path.join(h.source.rootPath, value.path)), sourceBytes);
      const saved = await receipt(imported.body.operationId);
      assert.equal(saved[0].row.private_result.sourceHash, createHash('sha256').update(sourceBytes).digest('hex'));
      const retried = await mcp('import_knowledge_file', { api_version: 1, workspace_id: value.workspaceId, path: value.path,
        idempotency_key: value.idempotencyKey, file: { ...value.file, download_url: 'https://127.0.0.1:1/unavailable' } }, true);
      assert.equal(retried.body.result.structuredContent.operationId, imported.body.operationId);
      assert.deepEqual(await receipt(imported.body.operationId), saved);
      const unsafe = await post('import', { ...value, path: 'adapters/unsafe.md', idempotencyKey: 'native-import-unsafe-1',
        file: { ...value.file, download_url: 'https://127.0.0.1:1/private' } });
      // The existing DNS-pinned downloader deliberately hides private-host,
      // TLS and network details behind its fixed secure-download failure.
      assert.equal(unsafe.status, 503); assert.equal(unsafe.body.code, 'DOCUMENT_IMPORT_FAILED');
      const insecure = await post('import', { ...value, path: 'adapters/insecure.md', idempotencyKey: 'native-import-insecure-1',
        file: { ...value.file, download_url: 'http://localhost/private' } });
      assert.equal(insecure.status, 400); assert.equal(insecure.body.code, 'DOCUMENT_IMPORT_URL_REJECTED');
      const beforeInvalidMime = await count();
      const wrongMime = await post('import', { ...value, path: 'adapters/wrong-mime.md', idempotencyKey: 'native-import-wrong-mime-1',
        file: { ...value.file, mime_type: 'image/png' } });
      assert.equal(wrongMime.status, 400); assert.equal(wrongMime.body.code, 'INVALID_REQUEST');
      assert.equal(await count(), beforeInvalidMime);
    });
    await check('current Create and Import grants remain independent at REST and registered MCP', async () => {
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
        workspaceIds: [h.source.workspaceId], actions: ['create'] });
      assert.equal((await post('create', selection('adapters/create-only.md', 'native-create-only-1', ''))).status, 200);
      const denied = await post('import', { apiVersion: 1, workspaceId: h.source.workspaceId, path: 'adapters/denied.md',
        idempotencyKey: 'native-import-denied-1', file: { download_url: sourceUrl, file_id: 'denied' } });
      assert.equal(denied.status, 403); assert.equal(denied.body.code, 'API_KEY_ACCESS_DENIED');
      const mcpDenied = await mcp('import_knowledge_file', { api_version: 1, workspace_id: h.source.workspaceId,
        path: 'adapters/denied.md', idempotency_key: 'native-import-denied-1', file: { download_url: sourceUrl, file_id: 'denied' } });
      assert.equal(mcpDenied.body.result.structuredContent.code, 'API_KEY_ACCESS_DENIED');
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name,
        workspaceIds: [h.source.workspaceId], actions: ['read', 'create', 'import'] });
    });
    await check('real rotation, issuer logout and revocation preserve original identity without a browser session', async () => {
      const old = key, rotated = await rotateApiKey(manager, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id;
      assert.equal((await post('create', originalSelection, { 'X-Canvas-API-Key': old })).status, 401);
      assert.equal((await h.admin.query("DELETE FROM session WHERE id='session-owner'")).rowCount, 1);
      manager.set('Authorization', `Bearer ${managerToken}`);
      const retried = await post('create', originalSelection); assert.equal(retried.status, 200); assert.equal(retried.body.operationId, original.operationId);
      assert.deepEqual(await receipt(original.operationId), originalReceipt);
      await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId });
      assert.equal((await post('create', selection('adapters/revoked.md', 'native-revoked-adapter-1'))).status, 401);
      assert.equal((await rpc('tools/list', {})).status, 401);
    });
    await check('actual unauthenticated abuse limit returns a bounded native failure and retry header', async () => {
      let limited: Awaited<ReturnType<typeof post>> | undefined;
      for (let index = 0; index <= 60; index++) {
        const response = await post('create', originalSelection, { 'X-Canvas-API-Key': 'invalid' });
        if (response.status === 429) { limited = response; break; }
        assert.equal(response.status, 401);
      }
      assert(limited); assert.deepEqual(limited.body, { apiVersion: 1, success: false, code: 'API_KEY_RATE_LIMITED' });
      const retry = Number(limited.headers.get('retry-after')); assert(retry >= 1 && retry <= 60);
      assert.deepEqual(await receipt(original.operationId), originalReceipt);
    });
    assert.deepEqual(await snapshot(), protectedBefore);
  });
  console.log(`API-key native Create adapters: ${groups} genuine route/registered-MCP/PostgreSQL/FD/HTTPS groups passed; compiled deployment and installed SDK are separate.`);
}
main().catch(error => {
  console.error(JSON.stringify({ suite: 'api-key-native-create-adapters', stage, error: error instanceof Error ? error.name : 'UnknownError',
    location: error instanceof Error ? error.stack?.split('\n').find(line => line.includes('api-key-native-create-adapters-postgres-test')) : undefined,
    ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
      expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : {}) }));
  process.exitCode = 1;
});
