import { once } from 'node:events';
import http from 'node:http';

type Account = { id: string; toolkit: string; status: string };
type Call = { path: string; body: Record<string, unknown>; userId: string | null; apiKey: string | null; toolNames: string | null };
const APPS = [
  { slug: 'canva', name: 'Canva', no_auth: false },
  { slug: 'slack', name: 'Slack', no_auth: false },
  { slug: 'github', name: 'GitHub', no_auth: false },
  { slug: 'duckduckgo', name: 'DuckDuckGo', no_auth: true },
];

export async function createComposioProviderFixture() {
  const accounts = new Map<string, Account[]>();
  const calls: Call[] = [];
  const versions = new Map<string, string>();
  const inputs = new Map<string, Record<string, unknown>>();
  let unknownOutcome = false;
  let failNextToolPage = false;
  let rotateOnToolRead: (() => Promise<void>) | null = null;
  let legacyCapabilityStatus = 404;
  const baseTools = [
    { slug: 'DESIGN_CREATE', name: 'Create design', description: 'Create a design', toolkit: { slug: 'canva', name: 'Canva' },
      no_auth: false, input_parameters: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'], additionalProperties: false } },
    { slug: 'ASSET_LOOKUP', name: 'Look up assets', description: 'Look up saved assets', toolkit: { slug: 'canva', name: 'Canva' },
      no_auth: false, input_parameters: { type: 'object', properties: { folder_id: { type: 'string' } }, required: ['folder_id'] } },
    { slug: 'CHANNEL_POST', name: 'Post to a channel', description: 'Post a message', toolkit: { slug: 'slack', name: 'Slack' },
      no_auth: false, input_parameters: { type: 'object', properties: { channel: { type: 'string' }, message: { type: 'string' } }, required: ['channel', 'message'] } },
    { slug: 'REPO_READ', name: 'Read a repository', description: 'Read a repository', toolkit: { slug: 'github', name: 'GitHub' },
      no_auth: false, input_parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
    { slug: 'PUBLIC_FIND', name: 'Find a public page', description: 'Search a public page', toolkit: { slug: 'duckduckgo', name: 'DuckDuckGo' },
      no_auth: true, input_parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  ];
  const tools = () => baseTools.map((tool) => ({ ...tool, version: versions.get(tool.slug) || '20261006_00',
    input_parameters: inputs.get(tool.slug) || tool.input_parameters,
    output_parameters: { type: 'object', properties: { result: { type: 'string' } } } }));
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const url = new URL(request.url!, 'http://localhost');
    calls.push({ path: url.pathname, body, userId: url.searchParams.get('user_ids'),
      apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : null,
      toolNames: url.searchParams.get('tool_slugs') });
    const send = (payload: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); };
    if (url.pathname === '/v1/managed/composio/capabilities') return send({ error: 'SECRET-LEGACY-PROXY-BODY' }, legacyCapabilityStatus);
    if (url.pathname === '/v1/managed/composio/toolkits') return send({ toolkits: APPS.map((app) => ({ ...app, noAuth: app.no_auth })) });
    if (url.pathname === '/v1/managed/composio/status') return send({ configured: true, apiKeyValid: true, providerHealthy: true,
      connectedAccounts: (accounts.get(String(request.headers['x-canvas-composio-user-id'])) || []).map((account) => ({ id: account.id,
        toolkit: { slug: account.toolkit }, status: account.status })) });
    if (url.pathname === '/api/v3.1/auth_configs') return send({ items: [], next_cursor: null, total_pages: 1 });
    if (url.pathname === '/api/v3.1/toolkits') {
      const matching = APPS.filter((app) => !url.searchParams.has('search') || app.slug === url.searchParams.get('search'));
      const offset = url.searchParams.get('cursor') ? 2 : 0;
      const items = matching.slice(offset, offset + 2).map((app) => ({ ...app, is_local_toolkit: false, meta: { description: app.name, tools_count: 2 } }));
      return send({ items, next_cursor: offset === 0 && matching.length > 2 ? 'apps-2' : null,
        total_pages: matching.length > 2 ? 2 : 1, current_page: offset ? 2 : 1, total_items: matching.length });
    }
    if (url.pathname === '/api/v3.1/connected_accounts') return send({
      items: (accounts.get(url.searchParams.get('user_ids') || '') || []).map((account) => ({ id: account.id,
        toolkit: { slug: account.toolkit, name: APPS.find((app) => app.slug === account.toolkit)!.name },
        status: account.status, status_reason: null, is_disabled: false,
        auth_config: { id: 'fixture-auth', is_composio_managed: true, is_disabled: false },
        created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' })), next_cursor: null, total_pages: 1,
    });
    if (url.pathname === '/api/v3.1/tools') {
      if (failNextToolPage) { failNextToolPage = false; return send({ error: 'SECRET-UPSTREAM-BODY' }, 403); }
      const names = url.searchParams.get('tool_slugs')?.split(',');
      const filtered = tools().filter((tool) => tool.toolkit.slug === url.searchParams.get('toolkit_slug') && (!names || names.includes(tool.slug))
        && (!url.searchParams.get('search') || `${tool.slug} ${tool.description}`.toLowerCase().includes(url.searchParams.get('search')!.toLowerCase())));
      const offset = Number(url.searchParams.get('cursor') || '0');
      const limit = Number(url.searchParams.get('limit') || 50);
      return send({ items: filtered.slice(offset, offset + limit), next_cursor: filtered.length > offset + limit ? String(offset + limit) : null,
        total_pages: Math.ceil(filtered.length / limit) || 1 });
    }
    const tool = tools().find((item) => url.pathname === `/api/v3.1/tools/${item.slug}`);
    if (tool) {
      if (rotateOnToolRead) { const rotate = rotateOnToolRead; rotateOnToolRead = null; await rotate(); }
      return send(tool);
    }
    const execution = tools().find((item) => url.pathname === `/api/v3.1/tools/execute/${item.slug}`);
    if (execution) {
      if (unknownOutcome) { request.socket.destroy(); return; }
      const accountAllowed = execution.no_auth || (accounts.get(String(body.user_id)) || []).some((account) =>
        account.id === body.connected_account_id && account.toolkit === execution.toolkit.slug && account.status === 'ACTIVE');
      return send({ successful: accountAllowed, error: accountAllowed ? null : 'NOT_CONNECTED',
        data: { owner: body.user_id, account: body.connected_account_id, params: body.arguments, version: body.version }, log_id: 'fixture-call' });
    }
    return send({ error: `Unexpected fixture endpoint ${url.pathname}` }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { accounts, calls, versions, inputs, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    setUnknown: (value: boolean) => { unknownOutcome = value; },
    failPage: () => { failNextToolPage = true; },
    rotateOnRead: (callback: () => Promise<void>) => { rotateOnToolRead = callback; },
    setLegacyCapabilityStatus: (value: number) => { legacyCapabilityStatus = value; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
