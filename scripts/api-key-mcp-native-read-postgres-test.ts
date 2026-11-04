import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', cases = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyDocumentReadPrincipal: capture, withApiKeyDocumentReadPrincipalOnConnection: phase } =
      await import('../app/lib/api-keys/document-read-principal');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const token = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0].token;
    const headers = new Headers({ Authorization: `Bearer ${token}`, Origin: 'http://localhost' });
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Native MCP key',
      workspaceIds: [fixture.workspaceId], expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id, rpcId = 0;
    const target = await fixture.seed({ representation: 'plain_text', text: 'Keyneedle 😀 native MCP content', filePath: 'mcp/native.payload' });
    const hidden = await fixture.seed({ representation: 'plain_text', text: 'Hidden content', filePath: '.private/hidden.md' });
    const baseline = await fixture.snapshot();
    const rpc = async (method: string, params: Record<string, unknown>, modern = false, selected = key,
      extra: Record<string, string> = {}) => {
      const id = ++rpcId;
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-Canvas-API-Key': selected,
        'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25',
        ...(modern ? { 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}) } : {}), ...extra,
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, ...(modern ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'api-key-native-read-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}) } }) }));
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const responseText = await response.text();
      const body = responseText ? JSON.parse(responseText) : null;
      if (response.status === 200) { assert.equal(body.id, id); assert.equal(body.jsonrpc, '2.0'); }
      return { status: response.status, body };
    };
    const args = (extra: Record<string, unknown> = {}) => ({ workspace_id: fixture.workspaceId, document_id: target.documentId,
      format: 'text', max_bytes: 16, ...extra });
    const call = (name: string, input: unknown, modern = false) => rpc('tools/call', { name, arguments: input }, modern);
    const check = async (name: string, consume: () => Promise<void>) => {
      stage = name; await consume(); cases++; console.log(`API-key MCP native read passed: ${name}`);
    };
    await check('both real protocol transports advertise native key adapters with honest auth/error schemas', async () => {
      for (const modern of [false, true]) {
        const list = await rpc('tools/list', {}, modern); assert.equal(list.status, 200);
        const tools = list.body.result.tools; assert.deepEqual(tools.map((tool: { name: string }) => tool.name).sort(), ['read_knowledge_source', 'search_knowledge']);
        const descriptor = tools.find((tool: { name: string }) => tool.name === 'read_knowledge_source');
        assert.deepEqual(descriptor.securitySchemes, [{ type: 'apiKey', in: 'header', name: 'X-Canvas-API-Key' }]);
        const validate = new AjvJsonSchemaValidator().getValidator(descriptor.outputSchema);
        const result = await call('read_knowledge_source', args(), modern); assert.equal(result.status, 200);
        assert.equal(result.body.result.isError, undefined); assert.equal(result.body.result.structuredContent.document.documentId, target.documentId);
        assert.equal(validate(result.body.result.structuredContent).valid, true);
        assert.equal(validate({ apiVersion: 1, success: false, code: 'API_KEY_ACCESS_DENIED' }).valid, true);
      }
    });
    await check('stable-integration cursor survives atomic rotation and native search uses the same data', async () => {
      const start = await call('read_knowledge_source', args()); const first = start.body.result.structuredContent; assert(first.nextCursor);
      const rotated = await rotateApiKey(headers, issued.integration.id, { requestId: randomUUID(), expectedRevision: 1, expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id;
      const next = await call('read_knowledge_source', args({ cursor: first.nextCursor }));
      assert.equal(next.status, 200); assert.equal(next.body.result.structuredContent.byteOffset, first.byteLength);
      assert.equal(next.body.result.structuredContent.document.version, first.document.version);
      const found = await call('search_knowledge', { api_version: 1, workspace_id: fixture.workspaceId, path: 'mcp', query: 'Keyneedle' }, true);
      assert.equal(found.status, 200); assert.equal(found.body.result.isError, undefined);
      assert.deepEqual(found.body.result.structuredContent.hits.map((hit: { document: { documentId: string } }) => hit.document.documentId), [target.documentId]);
    });
    await check('invalid or mixed credentials reject before protocol/tool dispatch and hidden paths stay denied', async () => {
      for (const modern of [false, true]) {
        const bad = await rpc('tools/list', {}, modern, 'invalid'); assert.equal(bad.status, 401); assert.equal(bad.body.code, 'API_KEY_INVALID');
        const mixed = await rpc('tools/list', {}, modern, key, { Authorization: `Bearer ${token}` });
        assert.equal(mixed.status, 401); assert.equal(mixed.body.code, 'API_KEY_CREDENTIALS_CONFLICT');
      }
      const result = await call('read_knowledge_source', args({ document_id: hidden.documentId }));
      assert.equal(result.body.result.isError, true); assert.equal(result.body.result.structuredContent.code, 'ACCESS_DENIED');
      const legacy = await call('read_knowledge_source', { workspace_id: fixture.workspaceId, path: target.filePath });
      assert(legacy.body.error); assert.equal(legacy.body.error.code, -32602);
    });
    await check('current grant reduction rejects on subsequent RPC and cannot borrow OAuth permissions', async () => {
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 2, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['status'] });
      const denied = await call('read_knowledge_source', args(), true);
      assert.equal(denied.status, 200); assert.equal(denied.body.result.isError, true);
      assert.equal(denied.body.result.structuredContent.code, 'API_KEY_ACCESS_DENIED');
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 3, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['read'] });
      await fixture.admin.query('DELETE FROM oauth_consent'); await fixture.admin.query('DELETE FROM mcp_direct_workspace_grant');
      const independent = await call('read_knowledge_source', args()); assert.equal(independent.body.result.isError, undefined);
    });
    await check('tool toggle during actual held key phase denies even an already authenticated connection', async () => {
      const proof = await authenticateApiKeyRequest(new Request('http://localhost/mcp', { headers: { 'X-Canvas-API-Key': key } }));
      const client = await (getPostgresRuntimeQueryable() as unknown as Pool).connect();
      const database: SqlConnection = {
        get: async (sql, values) => (await client.query(sql, values)).rows[0],
        all: async (sql, values) => (await client.query(sql, values)).rows,
        run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
        close: () => { throw new Error('Caller owns the connection.'); },
      };
      const tools = process.env.CANVAS_MCP_DIRECT_TOOLS;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        await assert.rejects(capture(proof, { workspaceId: fixture.workspaceId, purpose: 'read', mcp: true }, () => undefined,
          principal => phase(database, principal, async access => {
            process.env.CANVAS_MCP_DIRECT_TOOLS = 'search_knowledge'; await access.assertCurrent();
          })), error => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'API_KEY_TOOL_DISABLED'));
      } finally { process.env.CANVAS_MCP_DIRECT_TOOLS = tools; await client.query('ROLLBACK'); client.release(); }
      const enabled = process.env.CANVAS_MCP_DIRECT_ENABLED;
      try { process.env.CANVAS_MCP_DIRECT_ENABLED = 'false'; assert.equal((await rpc('tools/list', {})).status, 404); }
      finally { process.env.CANVAS_MCP_DIRECT_ENABLED = enabled; }
    });
    await check('logout keeps key usable; explicit revocation denies both protocols', async () => {
      await revokeApiKey(headers, issued.integration.id, { expectedRevision: 4, credentialId });
      for (const modern of [false, true]) assert.equal((await rpc('tools/list', {}, modern)).status, 401);
      // The first suite proved logout independence with current held phases;
      // here a second real issued key proves the full transport path as well.
      const second = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Logout key',
        workspaceIds: [fixture.workspaceId], expiresAt: Date.now() + 3_600_000 }); key = second.key;
      await fixture.admin.query("DELETE FROM session WHERE id='reader-session'");
      assert.equal((await call('read_knowledge_source', args(), true)).body.result.isError, undefined);
      await fixture.admin.query('UPDATE canvas_api_keys SET expires_at=created_at+1 WHERE id=$1', [second.credential.id]);
      assert.equal((await rpc('tools/list', {}, true)).status, 401);
    });
    assert.deepEqual(await fixture.snapshot(), baseline, 'Key MCP reads/search preserve document/Yjs/metadata/projection identities and contents.');
  });
  console.log(`API-key MCP native read PostgreSQL: ${cases} groups passed. Compiled TCP and installed SDK acceptance remains separate.`);
}
main().catch(error => {
  const message = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error(`API-key MCP native read failed (${stage}): ${message}`); process.exitCode = 1;
});
