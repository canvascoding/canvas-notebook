import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-health-monitor-'));
  process.env.CANVAS_DATA_ROOT = root;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.MCP_ALLOW_INSECURE_HTTP = 'true';
  process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true';
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => {
    if (request.endsWith('/license/seat-limit')) return { assertUserSeatAccess: async ({ userId }: { userId: string }) => { if (userId === 'inactive') throw new Error('inactive'); } };
    if (request.endsWith('/organization/permissions')) return { assertUserOrganizationAdmin: async () => undefined };
    if (request.endsWith('/user-preferences')) return { getUserPreferredLocale: async () => 'de' };
    return originalLoad(request, parent, isMain);
  };
  let origin = '';
  const calls: Array<{ path: string; method: string }> = [];
  const handler = createMcpHandler(() => new Server({ name: 'health-fixture', version: '1' }), { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    calls.push({ path: request.url!, method: body ? JSON.parse(body).method : request.method });
    const result = await handler.fetch(new Request(`${origin}${request.url}`, {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      ...(body ? { body } : {}),
    }));
    response.writeHead(result.status, Object.fromEntries(result.headers)).end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  const { writeMcpConfigRaw, readMcpConfig } = await import('../app/lib/mcp/config');
  const { closeAllMcpServers } = await import('../app/lib/mcp/manager');
  const { runMcpConnectionHealthChecks } = await import('../app/lib/mcp/health-monitor');
  const { listMcpConnectionAttention, markMcpConnectionAttentionRead } = await import('../app/lib/mcp/connection-attention');
  const { recordMcpConnectionObservation } = await import('../app/lib/mcp/connection-health');
  try {
    for (const userId of ['active', 'inactive']) {
      await writeMcpConfigRaw(JSON.stringify({ mcpServers: {
        remote: { url: `${origin}/${userId}` },
        disabled: { url: `${origin}/disabled`, enabled: false },
        local: { command: 'must-never-start-from-health-monitor' },
      } }), { userId });
    }
    const now = Date.now();
    assert.equal(await runMcpConnectionHealthChecks(now), 1);
    assert(calls.length >= 1);
    assert(calls.every((call) => call.path === '/active' && call.method === 'server/discover'), 'only authorized active HTTP connections receive protocol probes');
    const count = calls.length;
    assert.equal(await runMcpConnectionHealthChecks(now + 1000), 0, 'global lease prevents overlapping passes');
    assert.equal(await runMcpConnectionHealthChecks(now + 61_000), 0, 'per-connection next-check reservation survives a new pass');
    assert.equal(calls.length, count);

    const scope = { userId: 'active' };
    const connection = (await readMcpConfig(scope)).mcpServers.remote;
    await recordMcpConnectionObservation(connection, scope, { kind: 'failure', code: 'network_error' }, { now });
    await recordMcpConnectionObservation(connection, scope, { kind: 'failure', code: 'network_error' }, { now: now + 150_000 });
    await recordMcpConnectionObservation(connection, scope, { kind: 'failure', code: 'network_error' }, { now: now + 300_000 });
    const notifications = await listMcpConnectionAttention({ userId: 'active', now: now + 300_000 });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].target.connectionId, connection.connectionId);
    assert.equal(notifications[0].unread, true);
    assert.equal(calls.length, count, 'notification reads never contact the provider');
    assert.deepEqual(await listMcpConnectionAttention({ userId: 'inactive' }), []);
    assert.equal((await markMcpConnectionAttentionRead({ userId: 'inactive', itemId: notifications[0].id })).updated, 0, 'foreign notification cannot be marked read');
    assert.equal((await markMcpConnectionAttentionRead({ userId: 'active', itemId: notifications[0].id })).updated, 1);
    assert.equal((await listMcpConnectionAttention({ userId: 'active' }))[0].unread, false);
    await recordMcpConnectionObservation(connection, scope, { kind: 'success' });
    assert.deepEqual(await listMcpConnectionAttention({ userId: 'active' }), [], 'recovery removes the incident after reload');
    console.log('mcp-health-monitor-test: ok');
  } finally {
    internals._load = originalLoad;
    await closeAllMcpServers();
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
