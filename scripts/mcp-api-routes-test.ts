import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

import { installMcpAccessMocks } from './fixtures/mcp-test-access';

const users = new Set(['admin', 'member', 'other']);

function request(url: string, userId?: string, init: RequestInit = {}) {
  const { signal: _signal, ...requestInit } = init;
  const headers = new Headers(init.headers);
  if (userId) headers.set('x-test-user', userId);
  if (init.body) headers.set('content-type', 'application/json');
  return new NextRequest(url, { ...requestInit, headers });
}

async function body(response: Response) {
  return response.json() as Promise<{ success: boolean; error?: string; code?: string; data?: Record<string, unknown> }>;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-api-routes-'));
  process.env.CANVAS_DATA_ROOT = root;
  process.env.MCP_ALLOW_INSECURE_HTTP = 'true';
  process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true';
  const access = installMcpAccessMocks();
  access.memberships.set('admin', { organizationId: 'org-a', role: 'admin', status: 'active' });
  access.memberships.set('member', { organizationId: 'org-a', role: 'member', status: 'active' });
  access.memberships.set('other', { organizationId: 'org-a', role: 'member', status: 'active' });

  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (moduleRequest, parent, isMain) => {
    if (moduleRequest === '@/app/lib/auth' || /(?:^|\/)app\/lib\/auth$/u.test(moduleRequest)) {
      return {
        auth: {
          api: {
            getSession: async ({ headers }: { headers: Headers }) => {
              const userId = headers.get('x-test-user') || '';
              return users.has(userId) ? { user: { id: userId } } : null;
            },
          },
        },
      };
    }
    return originalLoad(moduleRequest, parent, isMain);
  };

  try {
    const configRoute = await import('../app/api/integrations/mcp-config/route');
    const definitionsRoute = await import('../app/api/integrations/mcp-definitions/route');
    const connectionsRoute = await import('../app/api/integrations/mcp-connections/route');
    const toolsRoute = await import('../app/api/integrations/mcp-tools/route');
    const oauthStartRoute = await import('../app/api/mcp/oauth/start/route');
    const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');

    const unauthenticated = await configRoute.GET(request('http://canvas.test/api/integrations/mcp-config'));
    assert.equal(unauthenticated.status, 401, 'MCP config rejects missing sessions');

    const rawMember = await configRoute.PUT(request('http://canvas.test/api/integrations/mcp-config', 'member', {
      method: 'PUT', body: JSON.stringify({ rawContent: '{"mcpServers":{}}' }),
    }));
    assert.equal(rawMember.status, 403, 'members cannot edit raw MCP configuration');
    assert.equal((await body(rawMember)).code, 'MCP_ACCESS_DENIED');

    await writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      approved: { url: 'http://127.0.0.1:65530/mcp', auth: 'none' },
    } }), { userId: 'admin' });
    const publish = await definitionsRoute.POST(request('http://canvas.test/api/integrations/mcp-definitions', 'admin', {
      method: 'POST', body: JSON.stringify({ action: 'publish', server: 'approved', name: 'Approved route fixture' }),
    }));
    assert.equal(publish.status, 200);
    const definitionId = (await body(publish)).data?.id;
    assert.equal(typeof definitionId, 'string');

    const connected = await connectionsRoute.POST(request('http://canvas.test/api/integrations/mcp-connections', 'member', {
      method: 'POST', body: JSON.stringify({ action: 'connect', definitionId, displayName: 'Member account' }),
    }));
    assert.equal(connected.status, 200, 'member can create an approved personal connection');
    const connectedData = (await body(connected)).data;
    assert.equal(typeof connectedData?.server, 'string');
    assert.equal(typeof connectedData?.connectionId, 'string');

    const ownTools = await toolsRoute.GET(request(`http://canvas.test/api/integrations/mcp-tools?server=${encodeURIComponent(String(connectedData?.server))}`, 'member'));
    assert.equal(ownTools.status, 200, 'member can inspect its own approved connection cache');

    await writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      unapproved: { url: 'http://127.0.0.1:65530/mcp', auth: 'oauth' },
    } }), { userId: 'member' });
    const unapprovedOAuth = await oauthStartRoute.GET(request('http://canvas.test/api/mcp/oauth/start?server=unapproved', 'member'));
    assert.equal(unapprovedOAuth.status, 403, 'members cannot authorize an owned server that lacks organization approval');

    const foreignRename = await connectionsRoute.POST(request('http://canvas.test/api/integrations/mcp-connections', 'other', {
      method: 'POST', body: JSON.stringify({ action: 'rename', connectionId: connectedData?.connectionId, displayName: 'Other account' }),
    }));
    assert.ok([403, 404].includes(foreignRename.status), 'foreign connection IDs are rejected without exposing another account');
    assert.match(String((await body(foreignRename)).code), /^MCP_(ACCESS_DENIED|CONNECTION_NOT_FOUND)$/u);
    console.log('mcp-api-routes-test: ok');
  } finally {
    internals._load = originalLoad;
    access.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
