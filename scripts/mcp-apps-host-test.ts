import assert from 'node:assert/strict';
import Module from 'node:module';

const userId = 'apps-user';
const sessionId = 'apps-chat';
const agentId = 'bradley';
const connectionId = '11111111-1111-4111-8111-111111111111';
const app = { version: 1 as const, connectionId, toolName: 'app-source', resourceUri: 'ui://fixture/app.html' };
const origin = 'http://localhost:3000';
const previewOrigin = 'http://preview.localhost:3000';
let enabled = true;
let chatOwned = true;
let workspaceAllowed = true;
let authSessionActive = true;
let authVersion = 1;
let html = '<!doctype html><button>fixture</button>';
const calls: Array<{ name: string; args: Record<string, unknown>; signal: AbortSignal; scope: { userId: string } }> = [];

class FixtureAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const db = {
  query: {
    piSessions: { findFirst: async () => chatOwned ? { workspaceId: 'workspace-1' } : null },
    session: { findFirst: async () => authSessionActive ? { id: 'auth-1' } : null },
  },
};

const moduleInternals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db') return { db };
  if (request.includes('agents/access')) return { requireAgentAccess: async () => undefined };
  if (request.includes('session-workspace-context')) return { resolveAgentSessionWorkspaceForUser: async () => {
    if (!workspaceAllowed) throw new Error('workspace denied');
    return { workspaceId: 'workspace-1' };
  } };
  if (request.includes('html-preview-origin')) return {
    htmlPreviewOrigins: () => ({ appOrigin: origin, previewOrigin }),
    isHtmlPreviewHost: (host: string | null) => host === 'preview.localhost:3000',
  };
  if (request.includes('mcp/access')) return {
    McpAccessError: FixtureAccessError,
    mcpErrorStatus: (error: unknown) => error instanceof FixtureAccessError ? error.status : 500,
    requireMcpUserAccess: async () => undefined,
    assertMcpConnectionAccess: async () => ({ connection: { authVersion } }),
  };
  if (request.includes('mcp/apps-config')) return { isMcpAppsEnabled: () => enabled };
  if (request.includes('mcp/apps-metadata')) return { isMcpAppResourceMimeType: (mime: unknown) => mime === 'text/html;profile=mcp-app' };
  if (request.includes('mcp/manager')) return {
    readMcpAppResource: async () => ({ contents: [{ uri: app.resourceUri, mimeType: 'text/html;profile=mcp-app', text: html }] }),
    callMcpAppTool: async (_connection: string, _source: string, _resource: string, name: string, args: Record<string, unknown>, signal: AbortSignal, scope: { userId: string }) => {
      calls.push({ name, args, signal, scope }); return { content: [{ type: 'text', text: 'approved' }], structuredContent: { approved: true } };
    },
  };
  if (request.includes('connection-health')) return { mcpReconnectDetails: async () => ({}) };
  if (request.includes('app/lib/auth')) return { auth: { api: { getSession: async () => authSessionActive ? { user: { id: userId }, session: { id: 'auth-1', expiresAt: new Date(Date.now() + 60_000) } } : null } } };
  return originalLoad(request, parent, isMain);
};

function request(body: unknown, options: { origin?: string; type?: string } = {}): Request {
  return new Request(`${origin}/api/mcp/apps`, { method: 'POST', headers: { 'content-type': options.type ?? 'application/json', ...(options.origin === undefined ? { origin } : { origin: options.origin }) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function main(): Promise<void> {
  const { issueMcpAppTicket, deliverMcpAppTicket, parseMcpAppDescriptor } = await import('../app/lib/mcp/apps-host');
  const { POST } = await import('../app/api/mcp/apps/route');
  try {
    assert.throws(() => parseMcpAppDescriptor({ ...app, connectionId: 'bad' }), FixtureAccessError);
    const issued = await issueMcpAppTicket({ userId, sessionId, agentId, app, authSessionId: 'auth-1', authSessionExpiresAt: new Date(Date.now() + 60_000) });
    const ticket = issued.frameUrl.split('/')[4];
    assert.ok(ticket);
    const frame = await deliverMcpAppTicket(new Request(issued.frameUrl, { headers: { host: 'preview.localhost:3000' } }), ticket, 'frame');
    assert.equal(frame.status, 200);
    assert.match(frame.headers.get('content-security-policy') || '', /sandbox allow-scripts allow-same-origin/);
    assert.match(frame.headers.get('content-security-policy') || '', /frame-ancestors http:\/\/localhost:3000/);
    assert.equal(frame.headers.get('cache-control'), 'private, no-store, max-age=0');
    const frameHtml = await frame.text();
    assert.match(frameHtml, /event\.origin==='null'/);
    assert.match(frameHtml, /canvasOrigin/);
    assert.match(frameHtml, /http:\/\/localhost:3000/);
    assert.doesNotMatch(frameHtml, /config\.appOrigin/);
    assert.match(frameHtml, /frame\.sandbox='allow-scripts'/);
    const document = await deliverMcpAppTicket(new Request(issued.frameUrl, { headers: { host: 'preview.localhost:3000' } }), ticket, 'document');
    assert.equal(document.status, 200);
    assert.match(document.headers.get('content-security-policy') || '', /sandbox allow-scripts$/);
    assert.equal(await deliverMcpAppTicket(new Request(issued.frameUrl, { headers: { host: 'localhost:3000' } }), ticket, 'frame').then((r) => r.status), 404);
    assert.equal(await deliverMcpAppTicket(new Request(issued.frameUrl, { headers: { host: 'preview.localhost:3000' } }), 'bad', 'frame').then((r) => r.status), 404);
    authVersion += 1;
    assert.equal(await deliverMcpAppTicket(new Request(issued.frameUrl, { headers: { host: 'preview.localhost:3000' } }), ticket, 'document').then((r) => r.status), 404);
    authVersion = 1;
    const revoked = await issueMcpAppTicket({ userId, sessionId, agentId, app, authSessionId: 'auth-1', authSessionExpiresAt: new Date(Date.now() + 60_000) });
    authSessionActive = false;
    assert.equal(await deliverMcpAppTicket(new Request(revoked.frameUrl, { headers: { host: 'preview.localhost:3000' } }), revoked.frameUrl.split('/')[4], 'frame').then((r) => r.status), 404);
    authSessionActive = true;

    let response = await POST(request({ action: 'call', app, sessionId, agentId, tool: 'submit_chart_filter', arguments: { minimum: 2 } }));
    assert.equal(response.status, 200); assert.equal(calls.length, 1); assert.equal(calls[0].name, 'submit_chart_filter'); assert.ok(calls[0].signal instanceof AbortSignal); assert.deepEqual(calls[0].scope, { userId });
    response = await POST(request({ action: 'call', app, sessionId, agentId, tool: 'x' }, { origin: 'https://evil.test' })); assert.equal(response.status, 403);
    authSessionActive = false; response = await POST(request({ action: 'render', app, sessionId, agentId })); assert.equal(response.status, 401); authSessionActive = true;
    chatOwned = false; response = await POST(request({ action: 'render', app, sessionId, agentId })); assert.equal(response.status, 403); chatOwned = true;
    workspaceAllowed = false; response = await POST(request({ action: 'render', app, sessionId, agentId })); assert.equal(response.status, 403); workspaceAllowed = true;
    response = await POST(request('not-json')); assert.equal(response.status, 400);
    response = await POST(request({ action: 'render', app, sessionId, agentId }, { type: 'text/plain' })); assert.equal(response.status, 415);
    response = await POST(request({ action: 'render', app, sessionId, agentId, padding: 'x'.repeat(70_000) })); assert.equal(response.status, 413);
    enabled = false; response = await POST(request({ action: 'render', app, sessionId, agentId })); assert.equal(response.status, 404); enabled = true;
    html = 'x'.repeat(2 * 1024 * 1024 + 1); response = await POST(request({ action: 'render', app, sessionId, agentId })); assert.equal(response.status, 422);
  } finally { moduleInternals._load = originalLoad; }
  console.log('mcp-apps-host-test: ok');
}

main().catch((error) => { console.error(error); process.exit(1); });
