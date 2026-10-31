import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', cases = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    process.env.CANVAS_MCP_DIRECT_TOOLS = 'list_workspaces,read_knowledge_source,search_knowledge';
    const { GET } = await import('../app/api/workspaces/route');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { createApiIntegration, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const session = (await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0];
    const headers = new Headers({ Authorization: `Bearer ${session.token}`, Origin: 'http://localhost' });
    stage = 'original session listing';
    const sessionResponse = await GET(new Request('http://localhost/api/workspaces', { headers }));
    assert.equal(sessionResponse.status, 200); const sessionList = await sessionResponse.json();
    assert.equal(sessionList.success, true); assert.equal(typeof sessionList.canCreateSharedWorkspaces, 'boolean');
    assert(sessionList.workspaces.some((entry: { id: string }) => entry.id === fixture.workspaceId));
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Workspace listing adapters',
      workspaceIds: [fixture.workspaceId], expiresAt: Date.now() + 3_600_000 });
    await fixture.seed(); const baseline = await fixture.snapshot();
    const get = async (key = issued.key, extra: Record<string, string> = {}) => {
      const response = await GET(new Request('http://localhost/api/workspaces', { headers: { 'X-Canvas-API-Key': key, ...extra } }));
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      return { status: response.status, body: await response.json() };
    };
    let id = 0;
    const rpc = async (method: 'tools/list' | 'tools/call', params: Record<string, unknown>, modern = false) => {
      const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-Canvas-API-Key': issued.key,
        'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25', ...(modern ? { 'mcp-method': method,
          ...(method === 'tools/call' ? { 'mcp-name': 'list_workspaces' } : {}) } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, ...(modern ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'key-workspace-list-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}) } }) }));
      assert.equal(response.headers.get('cache-control'), 'no-store'); return { status: response.status, body: await response.json() };
    };
    const check = async (name: string, operation: () => Promise<void>) => { stage = name; await operation(); cases++;
      console.log(`API-key workspace-list adapters passed: ${name}`); };
    let expected: unknown;
    await check('REST exposes only the actual explicit workspace metadata; original session contract is preserved', async () => {
      const result = await get(); assert.equal(result.status, 200); assert.equal(result.body.apiVersion, 1); assert.equal(result.body.success, true);
      assert.equal(result.body.workspaces.length, 1); const workspace = result.body.workspaces[0]; expected = result.body.workspaces;
      assert.equal(workspace.id, fixture.workspaceId); assert.equal(workspace.type, 'organization');
      assert.deepEqual(Object.keys(workspace).sort(), ['description', 'id', 'is_default', 'name', 'type']);
      assert(!JSON.stringify(result.body).includes(fixture.dataRoot)); assert(!JSON.stringify(result.body).includes(issued.key));
      assert.equal(Object.hasOwn(result.body, 'canCreateSharedWorkspaces'), false);
    });
    await check('legacy and modern real MCP transports advertise and execute the same current list', async () => {
      for (const modern of [false, true]) {
        const listing = await rpc('tools/list', {}, modern); assert.equal(listing.status, 200);
        const descriptor = listing.body.result.tools.find((entry: { name: string }) => entry.name === 'list_workspaces'); assert(descriptor);
        const validate = new AjvJsonSchemaValidator().getValidator(descriptor.outputSchema);
        const response = await rpc('tools/call', { name: 'list_workspaces', arguments: {} }, modern);
        assert.equal(response.status, 200); assert.equal(response.body.result.isError, undefined);
        assert.deepEqual(response.body.result.structuredContent, { workspaces: expected });
        assert.equal(validate(response.body.result.structuredContent).valid, true);
        assert.equal(validate({ apiVersion: 1, success: false, code: 'ACCESS_DENIED' }).valid, true);
      }
    });
    await check('invalid/mixed keys deny without session fallback and read grant removal affects both adapters', async () => {
      const invalid = await get('invalid'); assert.equal(invalid.status, 401); assert.equal(invalid.body.code, 'API_KEY_INVALID');
      const mixed = await get(issued.key, { Authorization: `Bearer ${session.token}` });
      assert.equal(mixed.status, 401); assert.equal(mixed.body.code, 'API_KEY_CREDENTIALS_CONFLICT');
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 1, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['status'] });
      const denied = await get(); assert.equal(denied.status, 403); assert.equal(denied.body.code, 'API_KEY_ACCESS_DENIED');
      const mcp = await rpc('tools/call', { name: 'list_workspaces', arguments: {} }, true);
      assert.equal(mcp.body.result.isError, true); assert.equal(mcp.body.result.structuredContent.code, 'API_KEY_ACCESS_DENIED');
      await updateApiIntegration(headers, issued.integration.id, { expectedRevision: 2, name: issued.integration.name,
        workspaceIds: [fixture.workspaceId], actions: ['read'] });
    });
    await check('actual current seat and archive policy survive endpoint adaptation', async () => {
      await fixture.admin.query("UPDATE team_memberships SET status='suspended' WHERE user_id='reader'");
      try { const denied = await get(); assert.equal(denied.status, 403); assert.equal(denied.body.code, 'ACCESS_DENIED'); }
      finally { await fixture.admin.query("UPDATE team_memberships SET status='active' WHERE user_id='reader'"); }
      await fixture.admin.query("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [fixture.workspaceId]);
      try {
        assert.deepEqual((await get()).body.workspaces, []);
        const mcp = await rpc('tools/call', { name: 'list_workspaces', arguments: {} }); assert.deepEqual(mcp.body.result.structuredContent, { workspaces: [] });
      } finally { await fixture.admin.query("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [fixture.workspaceId]); }
      await revokeApiKey(headers, issued.integration.id, { expectedRevision: 3, credentialId: issued.credential.id });
      assert.equal((await get()).status, 401); assert.equal((await rpc('tools/list', {})).status, 401);
    });
    assert.deepEqual(await fixture.snapshot(), baseline);
  });
  console.log(`API-key workspace-list adapters: ${cases} PostgreSQL/route/protocol groups passed. Compiled-container acceptance remains separate.`);
}
main().catch(error => {
  console.error(JSON.stringify({ suite: 'api-key-workspace-list-adapters', passed: false, stage,
    error: error instanceof Error ? error.name : 'UnknownError' })); process.exitCode = 1;
});
