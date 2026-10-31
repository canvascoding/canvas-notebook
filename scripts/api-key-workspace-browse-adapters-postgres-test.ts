import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', cases = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const tools = ['get_workspace_overview', 'list_knowledge_tree', 'get_knowledge_manifest'] as const;
    const purposes = ['overview', 'tree', 'manifest'] as const;
    process.env.CANVAS_MCP_DIRECT_TOOLS = tools.join(',');
    const { POST } = await import('../app/api/documents/browse/route');
    const { NextRequest } = await import('next/server');
    const { unstable_doesMiddlewareMatch: matches } = await import('next/dist/experimental/testing/server/middleware-testing-utils');
    const { config } = await import('../proxy');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { createApiIntegration, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const { decodeWorkspaceBrowseRequestV1: decode } = await import('../app/lib/documents/browse-contract');
    const session = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0];
    const headers = new Headers({ Authorization: `Bearer ${session.token}`, Origin: 'http://localhost' });
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Workspace browse adapters',
      workspaceIds: [fixture.workspaceId], expiresAt: Date.now() + 3_600_000 });
    const native = await fixture.seed({ filePath: 'native.md', text: 'Authoritative native text Äpfel 😀' });
    await writeFile(path.join(fixture.workspaceRoot, native.filePath), 'lagging physical projection');
    const bytes = Buffer.from([0, 255, 3, 4]);
    await writeFile(path.join(fixture.workspaceRoot, 'bytes.bin'), bytes);
    await mkdir(path.join(fixture.workspaceRoot, '.private'));
    await writeFile(path.join(fixture.workspaceRoot, '.private', 'secret.txt'), 'hidden');
    await symlink('/etc/passwd', path.join(fixture.workspaceRoot, 'alias.txt'));
    const baseline = await fixture.snapshot();
    const selection = (purpose: typeof purposes[number], extra = {}) => ({ apiVersion: 1, workspaceId: fixture.workspaceId, purpose, ...extra });
    const post = async (input: unknown, extraHeaders: Record<string, string> = {}, key: string | null = issued.key, raw = false) => {
      const response = await POST(new NextRequest('http://localhost/api/documents/browse', { method: 'POST', headers: {
        'content-type': 'application/json', ...(key === null ? {} : { 'X-Canvas-API-Key': key }), ...extraHeaders,
      }, body: raw ? input as string : JSON.stringify(input) }));
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      return { status: response.status, body: await response.json() };
    };
    let id = 0;
    const rpc = async (method: 'tools/list' | 'tools/call', params: Record<string, unknown>, modern = false) => {
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-Canvas-API-Key': issued.key,
        'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25', ...(modern ? { 'mcp-method': method,
          ...(method === 'tools/call' ? { 'mcp-name': params.name as string } : {}) } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, ...(modern ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'key-browse-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}) } }) }));
      return { status: response.status, body: await response.json() };
    };
    const call = (name: string, args: Record<string, unknown> = {}, modern = false) =>
      rpc('tools/call', { name, arguments: { workspace_id: fixture.workspaceId, ...args } }, modern);
    const check = async (name: string, operation: () => Promise<void>) => { stage = name; await operation(); cases++;
      console.log(`API-key workspace-browse adapters passed: ${name}`); };
    await check('exact handler boundary, bounded malformed input and selectors cannot supply authority', async () => {
      assert.equal(matches({ config, url: 'http://localhost/api/documents/browse' }), false);
      assert.equal(matches({ config, url: 'http://localhost/api/documents/browse/extra' }), true);
      assert.equal((await post('{broken', {}, null, true)).body.code, 'INVALID_BROWSE_REQUEST');
      assert.equal((await post(' '.repeat(32 * 1024 + 1), {}, null, true)).status, 413);
      let getters = 0;
      const accessor = Object.defineProperty(selection('tree'), 'path', { enumerable: true, get() { getters++; return '.'; } });
      for (const value of [accessor, new Proxy(selection('tree'), {}), { ...selection('tree'), actor: 'owner' },
        selection('tree', { path: '.private' }), selection('tree', { path: '../outside' }), selection('manifest', { maxEntries: 21 }),
        selection('overview', { path: '.' }), selection('tree', { cursor: null })]) {
        assert.throws(() => decode(value), error => Reflect.get(error as object, 'code') === 'INVALID_BROWSE_REQUEST');
      }
      assert.equal(getters, 0);
      assert.equal((await post(selection('tree', { workspaceId: 'foreign' }))).status, 403);
      assert.equal((await post(selection('tree'), { Authorization: `Bearer ${session.token}` })).status, 401);
      assert.equal((await post(selection('tree'), {}, 'invalid')).status, 401);
    });
    await check('genuine member and key read shared tree, overview and distinct physical/native hashes', async () => {
      for (const purpose of purposes) {
        const key = await post(selection(purpose)); assert.equal(key.status, 200);
        const member = await post(selection(purpose), { Authorization: `Bearer ${session.token}` }, null); assert.equal(member.status, 200);
        if (purpose === 'overview') {
          assert.deepEqual(key.body.contents, { top_level_files: 2, top_level_folders: 0, file_types: ['bin', 'md'] });
          assert.equal(key.body.capabilities.authentication_method, 'api_key');
          assert.equal(member.body.capabilities.authentication_method, 'session'); assert.deepEqual(member.body.contents, key.body.contents);
        } else {
          assert.deepEqual(member.body, key.body);
          assert.deepEqual(key.body.entries.map((entry: { path: string }) => entry.path), ['bytes.bin', 'native.md']);
          assert(key.body.entries.every((entry: { document_url: string }) => entry.document_url));
          if (purpose === 'manifest') {
            const binary = key.body.entries[0]; assert.equal(binary.sha256, createHash('sha256').update(bytes).digest('hex'));
            const nativeEntry = key.body.entries[1]; assert.equal(nativeEntry.document_id, native.documentId);
            assert.equal(nativeEntry.document.hash_basis, 'authoritative_markdown_utf8');
            assert.equal(nativeEntry.document.sha256, createHash('sha256').update('Authoritative native text Äpfel 😀').digest('hex'));
            assert.notEqual(nativeEntry.sha256, nativeEntry.document.sha256);
          }
        }
        assert(!JSON.stringify(key.body).includes(fixture.dataRoot)); assert(!JSON.stringify(key.body).includes(issued.key));
      }
    });
    await check('legacy and modern real MCP publish valid schemas and preserve the shared data', async () => {
      for (const modern of [false, true]) {
        const listing = await rpc('tools/list', {}, modern); assert.equal(listing.status, 200);
        for (let index = 0; index < tools.length; index++) {
          const descriptor = listing.body.result.tools.find((entry: { name: string }) => entry.name === tools[index]); assert(descriptor);
          assert.deepEqual(descriptor.securitySchemes, [{ type: 'apiKey', in: 'header', name: 'X-Canvas-API-Key' }]);
          const response = await call(tools[index], {}, modern); assert.equal(response.status, 200);
          assert.equal(response.body.result.isError, undefined);
          const rest = (await post(selection(purposes[index]))).body; delete rest.apiVersion;
          assert.deepEqual(response.body.result.structuredContent, rest);
          const validate = new AjvJsonSchemaValidator().getValidator(descriptor.outputSchema);
          assert.equal(validate(rest).valid, true);
          assert.equal(validate({ apiVersion: 1, success: false, code: 'WORKSPACE_TREE_CHANGED' }).valid, true);
        }
        assert((await call('list_knowledge_tree', { path: '.private' }, modern)).body.error);
      }
    });
    await check('bounded pagination, stale cursor and oversized manifest hashes are explicit', async () => {
      const paths: string[] = []; let cursor: string | undefined;
      do {
        const page = await post(selection('manifest', { maxEntries: 1, maxDepth: 0, ...(cursor ? { cursor } : {}) }));
        assert.equal(page.status, 200); paths.push(...page.body.entries.map((entry: { path: string }) => entry.path));
        cursor = page.body.next_cursor || undefined;
      } while (cursor);
      assert.deepEqual(paths, ['bytes.bin', 'native.md']);
      const before = (await post(selection('tree', { maxEntries: 1, maxDepth: 0 }))).body;
      await writeFile(path.join(fixture.workspaceRoot, 'added.txt'), 'changed');
      const changed = await post(selection('tree', { maxEntries: 1, maxDepth: 0, cursor: before.next_cursor }));
      assert.equal(changed.status, 409); assert.equal(changed.body.code, 'WORKSPACE_TREE_CHANGED');
      const huge = path.join(fixture.workspaceRoot, 'huge.bin'); await writeFile(huge, ''); await truncate(huge, 101 * 1024 * 1024);
      const manifest = (await post(selection('manifest'))).body;
      assert.equal(manifest.entries.find((entry: { path: string }) => entry.path === 'huge.bin').error, 'MANIFEST_FILE_TOO_LARGE');
      assert.equal(manifest.coverage.complete, false);
    });
    await check('current action, seat, archive and revocation deny independently of OAuth consent', async () => {
      await fixture.admin.query('DELETE FROM mcp_direct_workspace_grant WHERE workspace_id=$1', [fixture.workspaceId]);
      assert.equal((await call('get_workspace_overview')).body.result.isError, undefined);
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 1, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['status'] });
      for (let index = 0; index < purposes.length; index++) {
        assert.equal((await post(selection(purposes[index]))).status, 403);
        assert.equal((await call(tools[index])).body.result.structuredContent.code, 'API_KEY_ACCESS_DENIED');
      }
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 2, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['read'] });
      await fixture.admin.query("UPDATE team_memberships SET status='suspended' WHERE user_id='reader'");
      try { assert.equal((await post(selection('overview'))).status, 403); }
      finally { await fixture.admin.query("UPDATE team_memberships SET status='active' WHERE user_id='reader'"); }
      await fixture.admin.query("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [fixture.workspaceId]);
      try { assert.equal((await post(selection('tree'))).status, 403); }
      finally { await fixture.admin.query("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [fixture.workspaceId]); }
      await revokeApiKey(headers, issued.integration.id, { expectedRevision: 3, credentialId: issued.credential.id });
      assert.equal((await post(selection('overview'))).status, 401); assert.equal((await rpc('tools/list', {})).status, 401);
    });
    assert.deepEqual(await fixture.snapshot(), baseline);
  });
  console.log(`API-key workspace-browse adapters: ${cases} PostgreSQL/route/protocol groups passed; compiled-container acceptance remains separate.`);
}
main().catch(error => {
  const message = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error(`API-key workspace-browse adapters failed (${stage}): ${message}`); process.exitCode = 1;
});
