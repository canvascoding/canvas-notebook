import assert from 'node:assert/strict';
import http from 'node:http';
import { NextRequest } from 'next/server';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import { mcpIconSourceBinding } from '../app/lib/mcp/icon-source';

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#246"/></svg>');
async function main() {
  assert(process.env.NODE_ENV === 'test' && process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST === '1', 'This acceptance requires a real owned PostgreSQL fixture');
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: true });
  const receipts: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];
  let holdImage = false, heldResponse: http.ServerResponse | undefined;
  let acceptHeld!: () => void;
  const held = new Promise<void>(resolve => { acceptHeld = resolve; });
  const provider = http.createServer((request, response) => {
    receipts.push({ path: request.url || '', headers: request.headers });
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<html><head><link rel="icon" href="/${holdImage ? 'held' : 'logo'}.svg"></head></html>`);
    } else if (request.url === '/logo.svg' || request.url === '/held.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      if (request.url === '/held.svg') { heldResponse = response; acceptHeld(); }
      else response.end(svg);
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert(fixture.native);
    const iconRoute = await import('../app/api/plugins/mcp-icons/[selectionId]/route');
    const configRoute = await import('../app/api/integrations/mcp-config/route');
    const { readMcpConfig } = await import('../app/lib/mcp/config');
    const { publishMcpServerDefinition } = await import('../app/lib/mcp/server-definitions');
    const { createPersonalMcpConnection } = await import('../app/lib/mcp/personal-connections');
    const { createSharedMcpConnection, resolveSharedMcpBackend } = await import('../app/lib/mcp/shared-connections');
    const request = (pathname: string, userId = 'owner', method = 'GET', body?: unknown) => new NextRequest(new URL(pathname, 'http://localhost:3001'), {
      method, headers: fixture.headers(userId), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const get = (selectionId: string, binding: string, userId = 'owner', suffix = '') => iconRoute.GET(
      request(`/api/plugins/mcp-icons/${encodeURIComponent(selectionId)}?binding=${binding}&workspaceId=personal-${userId}${suffix}`, userId),
      { params: Promise.resolve({ selectionId }) });
    const assertImage = async (response: Response) => {
      assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'image/svg+xml');
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store'); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer'); assert(response.headers.get('Content-Security-Policy')?.includes('sandbox'));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), svg);
    };
    const saved = await configRoute.PUT(request('/api/integrations/mcp-config', 'owner', 'PUT', {
      rawContent: JSON.stringify({ mcpServers: { 'Actual personal MCP': { url: `${origin}/mcp`, auth: 'none', headersFromEnv: { Authorization: 'MCP_ICON_FIXTURE_TOKEN' } } } }),
    }));
    assert.equal(saved.status, 200, 'The real personal configuration API creates the source');
    let config = await readMcpConfig({ userId: 'owner' });
    const personal = config.mcpServers['Actual personal MCP']; assert(personal.connectionId);
    const personalId = `mcp-personal:${personal.connectionId}`, personalBinding = mcpIconSourceBinding(personalId, personal);
    await Promise.all(Array.from({ length: 2 }, async () => assertImage(await get(personalId, personalBinding))));
    assert.equal(receipts.filter(value => value.path === '/logo.svg').length, 1, 'The actual lazy image route discovers and saves the cold source once');
    const afterCold = receipts.length; await assertImage(await get(personalId, personalBinding)); assert.equal(receipts.length, afterCold, 'Real cached byte read issues no provider request');
    assert.equal((await get(personalId, personalBinding, 'alice')).status, 404, 'Another actor cannot enumerate a personal image in the owner storage');
    const unreadableWorkspace = request(`/api/plugins/mcp-icons/x?binding=${personalBinding}&workspaceId=personal-bob`);
    unreadableWorkspace.headers.set('x-canvas-workspace-id', 'personal-bob');
    assert.equal((await iconRoute.GET(unreadableWorkspace, { params: Promise.resolve({ selectionId: personalId }) })).status, 403, 'Current workspace Read authority is checked independently of owned MCP identity');
    assert.equal((await get(personalId, personalBinding, 'owner', `&binding=${personalBinding}`)).status, 400, 'Duplicate source selectors rejected');
    assert.equal((await get(personalId, personalBinding, 'owner', '&privatePath=anything')).status, 400);
    const conflicting = request(`/api/plugins/mcp-icons/x?binding=${personalBinding}&workspaceId=personal-alice`);
    assert.equal((await iconRoute.GET(conflicting, { params: Promise.resolve({ selectionId: personalId }) })).status, 400, 'Conflicting header/workspace selectors rejected');
    assert.equal((await iconRoute.GET(new NextRequest(`http://localhost:3001/api/plugins/mcp-icons/x?binding=${personalBinding}`),
      { params: Promise.resolve({ selectionId: personalId }) })).status, 401);
    const changedConfig = { ...config, mcpServers: { ...config.mcpServers, 'Actual personal MCP': { ...personal, url: `${origin}/other-mcp` } } };
    assert.equal((await configRoute.PUT(request('/api/integrations/mcp-config', 'owner', 'PUT', { rawContent: JSON.stringify(changedConfig) }))).status, 200);
    assert.equal((await get(personalId, personalBinding)).status, 409, 'Old image URLs cannot load a changed connection source');
    assert.equal(receipts.length, afterCold);
    const definition = await publishMcpServerDefinition(fixture.organizationId, 'Actual approved MCP', { url: `${origin}/approved-mcp`, auth: 'none' });
    const definitionId = `mcp-definition:${definition.id}`;
    const definitionConfig = { ...definition.config, organizationId: definition.organizationId, serverDefinitionId: definition.id };
    await assertImage(await get(definitionId, mcpIconSourceBinding(definitionId, definitionConfig, definition.revision), 'alice'));
    const approved = await createPersonalMcpConnection('alice', definition.id, 'Actual member MCP');
    config = await readMcpConfig({ userId: 'alice' });
    const memberConfig = Object.values(config.mcpServers).find(value => value.connectionId === approved.connectionId); assert(memberConfig);
    await assertImage(await get(`mcp-personal:${approved.connectionId}`, mcpIconSourceBinding(`mcp-personal:${approved.connectionId}`, memberConfig), 'alice'));
    const grants = [{ targetType: 'user' as const, targetId: 'alice', canUse: true, canManage: false, allowedToolNames: null }];
    for (const ownership of [{ type: 'organization' as const, organizationId: fixture.organizationId },
      { type: 'team' as const, organizationId: fixture.organizationId, workspaceId: 'store-team' }]) {
      const shared = await createSharedMcpConnection(fixture.owner, { ownership, displayName: 'Actual shared MCP', config: { url: `${origin}/shared-mcp`, auth: 'none' },
        grants, accessMode: 'restricted', secrets: [] });
      const backend = await resolveSharedMcpBackend(fixture.alice, shared.resource.connectionRef, 'inspect');
      assert.equal(backend.authorization.access.canRead, true); assert.equal(backend.authorization.access.canManage, false);
      const resource = backend.authorization.resource, stamp = `${resource.metadataRevision}:${resource.grantsRevision}:${resource.bindingRevision}`;
      const binding = mcpIconSourceBinding(resource.connectionRef, backend.connection, stamp);
      await assertImage(await get(resource.connectionRef, binding, 'alice'));
      await fixture.sql.run('UPDATE integration_connection_grants SET can_use=0 WHERE connection_ref=$1 AND target_id=$2', [resource.connectionRef, 'alice']);
      await fixture.sql.run('UPDATE integration_connection_resources SET grants_revision=grants_revision+1 WHERE connection_ref=$1', [resource.connectionRef]);
      assert.equal((await get(resource.connectionRef, binding, 'alice')).status, 404, 'Late resource read revocation denies the exact previously successful image URL');
    }
    const late = await createSharedMcpConnection(fixture.owner, { ownership: { type: 'organization', organizationId: fixture.organizationId },
      displayName: 'Actual late-revocation source', config: { url: `${origin}/late-mcp`, auth: 'none' }, grants, accessMode: 'restricted', secrets: [] });
    const beforeLate = await resolveSharedMcpBackend(fixture.alice, late.resource.connectionRef, 'inspect');
    const resource = beforeLate.authorization.resource;
    const lateBinding = mcpIconSourceBinding(resource.connectionRef, beforeLate.connection, `${resource.metadataRevision}:${resource.grantsRevision}:${resource.bindingRevision}`);
    holdImage = true;
    const pending = get(resource.connectionRef, lateBinding, 'alice'); await held;
    await fixture.sql.run('UPDATE integration_connection_grants SET can_use=0 WHERE connection_ref=$1 AND target_id=$2', [resource.connectionRef, 'alice']);
    await fixture.sql.run('UPDATE integration_connection_resources SET grants_revision=grants_revision+1 WHERE connection_ref=$1', [resource.connectionRef]);
    heldResponse!.end(svg);
    const denied = await pending; assert.equal(denied.status, 404); assert.equal(denied.headers.get('Content-Type')?.includes('image/'), false);
    assert(!String(await denied.text()).includes(origin), 'No endpoint/path/configuration is present in denied responses');
    const beforeBlocked = receipts.length;
    process.env.NODE_ENV = 'production'; process.env.MCP_ALLOW_PRIVATE_NETWORK = 'false'; process.env.MCP_ALLOW_INSECURE_HTTP = 'false';
    const freshPersonal = (await readMcpConfig({ userId: 'owner' })).mcpServers['Actual personal MCP'];
    const blocked = await get(personalId, mcpIconSourceBinding(personalId, freshPersonal));
    assert.equal(blocked.status, 204); assert.equal((await blocked.arrayBuffer()).byteLength, 0);
    assert.equal(receipts.length, beforeBlocked, 'Production guarded HTTP rejects the private/insecure domain before opening its socket');
    for (const receipt of receipts) { assert.equal(receipt.headers.authorization, undefined); assert.equal(receipt.headers.cookie, undefined); assert(!receipt.path.includes('PRIVATE')); }
    assert(!receipts.some(value => value.path.includes('mcp')), 'Image discovery never invokes an MCP/business endpoint');
    assert.equal(fixture.providerRequests(), 0, 'No out-of-fixture SDK/fetch calls occurred');
    console.log('PASS native real MCP icon route: actual cold HTML/SVG transport, local cache, exact personal/definition/org/team scope, ordinary member Read without Manage, stale source409, duplicate/header selectors, 401/403/404 and late-read-revocation while HTTP is pending. No MCP/business/provider-credential calls.');
  } finally {
    heldResponse?.end(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve())); await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
