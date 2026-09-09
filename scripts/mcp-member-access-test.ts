import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { installMcpAccessMocks } from './fixtures/mcp-test-access';

async function expectStatus(task: () => Promise<unknown>, status: number | number[]): Promise<void> {
  await assert.rejects(task, (error: unknown) => {
    const actual = (error as { status?: unknown })?.status;
    return Array.isArray(status) ? status.includes(actual as number) : actual === status;
  });
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

async function startMcpServer(): Promise<{ url: string; calls: number; close: () => Promise<void> }> {
  let origin = '';
  let calls = 0;
  const handler = createMcpHandler(() => {
    const mcp = new Server({ name: 'member-access-fixture', version: '1' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
    mcp.setRequestHandler('tools/call', async () => {
      calls += 1;
      return { content: [{ type: 'text', text: 'fixture-ok' }] };
    });
    return mcp;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await handler.fetch(new Request(`${origin}${request.url}`, {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
    }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    get calls() { return calls; },
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function main() {
  const { memberships, restore } = installMcpAccessMocks();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-member-access-'));
  process.env.CANVAS_DATA_ROOT = root;
  process.env.MCP_ALLOW_INSECURE_HTTP = 'true';
  process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true';
  memberships.set('admin', { organizationId: 'org-a', role: 'admin', status: 'active' });
  memberships.set('member', { organizationId: 'org-a', role: 'member', status: 'active' });
  memberships.set('other', { organizationId: 'org-b', role: 'admin', status: 'active' });
  memberships.set('suspended', { organizationId: 'org-a', role: 'member', status: 'suspended' });

  const fixture = await startMcpServer();
  const adminScope = { userId: 'admin', organizationId: 'org-a' };
  const memberScope = { userId: 'member', organizationId: 'org-a' };
  const otherScope = { userId: 'other', organizationId: 'org-b' };
  const { MCP_SYSTEM_SCOPE } = await import('../app/lib/mcp/scope');
  const { writeMcpConfigRaw, readMcpConfig } = await import('../app/lib/mcp/config');
  const { requireMcpUserAccess, assertMcpConnectionAccess } = await import('../app/lib/mcp/access');
  const {
    publicMcpDefinitionConfig,
    publishMcpServerDefinition,
    setMcpServerDefinitionEnabled,
  } = await import('../app/lib/mcp/server-definitions');
  const { createPersonalMcpConnection, renamePersonalMcpConnection, removePersonalMcpConnection } = await import('../app/lib/mcp/personal-connections');
  const { buildDirectMcpTools } = await import('../app/lib/mcp/direct-tools');
  const { closeAllMcpServers } = await import('../app/lib/mcp/manager');

  try {
    await expectStatus(() => requireMcpUserAccess(), 401);
    await expectStatus(() => requireMcpUserAccess({ legacy: true, organizationId: 'org-a' }), 401);
    assert.equal(await requireMcpUserAccess(MCP_SYSTEM_SCOPE), null, 'only the explicit system scope is allowed without a user');
    await expectStatus(() => requireMcpUserAccess({ userId: 'suspended', organizationId: 'org-a' }), 403);

    await assert.rejects(async () => publicMcpDefinitionConfig({ command: 'node' }), /HTTP|command/i);
    await assert.rejects(async () => publicMcpDefinitionConfig({ url: fixture.url, env: { TOKEN: 'secret' } }), /cannot contain|secret/i);

    await writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      arbitrary: { url: fixture.url, auth: 'none', directTools: ['echo'] },
    } }), adminScope);
    const adminConnection = (await readMcpConfig(adminScope)).mcpServers.arbitrary;
    assert.equal((await assertMcpConnectionAccess('arbitrary', adminScope)).connection.connectionId, adminConnection.connectionId, 'an admin can use an arbitrary HTTP server');

    const definition = await publishMcpServerDefinition('org-a', 'Approved fixture', { url: fixture.url, auth: 'none', directTools: ['echo'] });
    const first = await createPersonalMcpConnection('member', definition.id, 'Member fixture');
    const second = await createPersonalMcpConnection('admin', definition.id, 'Admin fixture');
    assert.notEqual(first.connectionId, second.connectionId, 'two accounts receive distinct connection identities');
    assert.equal((await assertMcpConnectionAccess(first.connectionId, memberScope)).connection.serverDefinitionId, definition.id, 'an active member can use its own approved connection');

    const concurrentAccounts = await Promise.all([
      createPersonalMcpConnection('member', definition.id, 'Account A'),
      createPersonalMcpConnection('member', definition.id, 'Account B'),
    ]);
    assert.notEqual(concurrentAccounts[0].connectionId, concurrentAccounts[1].connectionId);
    const accounts = await readMcpConfig(memberScope);
    assert.equal(Object.keys(accounts.mcpServers).length, 3, 'concurrent account creation preserves both edits');
    const beforeRename = accounts.mcpServers[concurrentAccounts[0].server];
    await renamePersonalMcpConnection('member', concurrentAccounts[0].connectionId, 'Renamed account');
    const renamed = (await readMcpConfig(memberScope)).mcpServers[concurrentAccounts[0].server];
    assert.equal(renamed.connectionId, beforeRename.connectionId);
    assert.equal(renamed.authVersion, beforeRename.authVersion, 'a label change keeps authorization valid');
    await expectStatus(() => createPersonalMcpConnection('member', definition.id, 'renamed ACCOUNT'), 409);
    await removePersonalMcpConnection('member', concurrentAccounts[0].connectionId);
    assert.ok((await readMcpConfig(memberScope)).mcpServers[concurrentAccounts[1].server], 'removing one account preserves the other');
    await removePersonalMcpConnection('member', concurrentAccounts[1].connectionId);

    const memberConfig = await readMcpConfig(memberScope);
    await writeMcpConfigRaw(JSON.stringify({
      ...memberConfig,
      mcpServers: { ...memberConfig.mcpServers, unapproved: { url: fixture.url, auth: 'none' } },
    }), memberScope);
    await expectStatus(() => assertMcpConnectionAccess('unapproved', memberScope), 403);
    await expectStatus(() => assertMcpConnectionAccess(second.connectionId, memberScope), [403, 404]);

    memberships.set('member', { organizationId: 'org-b', role: 'member', status: 'active' });
    await expectStatus(() => assertMcpConnectionAccess(first.connectionId, memberScope), 403);
    memberships.set('member', { organizationId: 'org-a', role: 'member', status: 'active' });

    const built = await buildDirectMcpTools(memberScope);
    const direct = built.tools.find((tool) => tool.label.endsWith('.echo'));
    assert.ok(direct, 'approved definition exposes its direct tool');
    assert.match(text(await direct.execute('before-disable', {})), /fixture-ok/);
    assert.equal(fixture.calls, 1);
    await setMcpServerDefinitionEnabled('org-a', definition.id, false);
    assert.match(text(await direct.execute('after-disable', {})), /approval was removed|disabled|Error/i, 'a cached direct tool rechecks the definition at execution time');
    assert.equal(fixture.calls, 1, 'disabled definition never reaches the provider');
    await expectStatus(() => assertMcpConnectionAccess(first.connectionId, memberScope), 403);

    const adminTools = await buildDirectMcpTools(adminScope);
    const staleAdminTool = adminTools.tools.find((tool) => tool.label.endsWith('.echo'));
    assert.ok(staleAdminTool, 'the tool was built while the actor was an admin');
    memberships.set('admin', { organizationId: 'org-a', role: 'member', status: 'active' });
    assert.match(text(await staleAdminTool.execute('after-demotion', {})), /approved HTTP|Error/i, 'a role change applies to an already-built direct tool');
    assert.equal(fixture.calls, 1);

    // A separate organization cannot make a connection in org-a executable by changing only its scope.
    await expectStatus(() => assertMcpConnectionAccess(first.connectionId, otherScope), [403, 404]);
    console.log('mcp-member-access-test: ok');
  } finally {
    await closeAllMcpServers().catch(() => undefined);
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
    restore();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
