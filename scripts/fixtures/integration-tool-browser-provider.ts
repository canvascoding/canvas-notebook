import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

export const BROWSER_COMPOSIO_TOOL = 'CANVA_LIST_DESIGNS';
export const BROWSER_COMPOSIO_VERSION = '20261006_03';
export const BROWSER_MCP_TOOL = 'canva_find_designs';
const DATE = '2026-10-06T00:00:00.000Z';

type SafeExecution = { source: 'mcp' | 'composio'; name: string; argumentsHash: string;
  accountHash?: string; userHash?: string; versionHash?: string; exactBinding: boolean; successful: boolean };
export type IntegrationBrowserProviderCalls = { requests: number; mcpLists: number; composioToolPages: number;
  composioSchemaReads: number; composioAccountPages: number; executions: SafeExecution[] };

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function accountIdForUser(userId: string): string {
  return `stage3_account_${hash(userId).slice(0, 24)}`;
}

export function browserFixtureAccountHash(userId: string): string {
  return hash(accountIdForUser(userId));
}

export async function startIntegrationToolBrowserProvider() {
  let origin = '';
  const state: IntegrationBrowserProviderCalls = { requests: 0, mcpLists: 0, composioToolPages: 0,
    composioSchemaReads: 0, composioAccountPages: 0, executions: [] };
  const knownAccounts = new Map<string, string>();
  const account = (userId: string) => {
    const id = accountIdForUser(userId);
    knownAccounts.set(id, userId);
    return { id, toolkit: { slug: 'canva', name: 'Canva' }, status: 'ACTIVE', status_reason: null,
      auth_config: { id: 'stage3_canva_auth_config', is_composio_managed: true, is_disabled: false },
      is_disabled: false, created_at: DATE, updated_at: DATE };
  };
  const saveExecution = (execution: SafeExecution) => { state.executions.push(execution); if (state.executions.length > 100) state.executions.shift(); };
  const designs = (id: string, query: string) => [{ id, title: `Canva design matching ${query}` }];
  const designSchema = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } },
    required: ['id', 'title'], additionalProperties: false } };
  const tool = { slug: BROWSER_COMPOSIO_TOOL, name: 'List Canva designs',
    description: 'List designs. Search Canva designs by query. Designs suchen und auflisten.',
    toolkit: { slug: 'canva', name: 'Canva' }, version: BROWSER_COMPOSIO_VERSION, no_auth: false,
    input_parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1,
      description: 'Required query for the Canva design list.' } }, required: ['query'], additionalProperties: false },
    output_parameters: { type: 'object', properties: { designs: designSchema }, required: ['designs'], additionalProperties: false } };
  const handler = createMcpHandler(() => {
    const mcp = new Server({ name: 'Canva Design MCP', version: 'stage3' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler('tools/list', async () => {
      state.mcpLists += 1;
      return { tools: [{ name: BROWSER_MCP_TOOL, title: 'Find Canva designs through MCP',
        description: 'List designs. Search Canva designs by design_query. Designs suchen und auflisten.',
        inputSchema: { type: 'object', properties: { design_query: { type: 'string', minLength: 1,
          description: 'Required Canva design query for this MCP connection.' }, exact_match: { type: 'boolean' } },
          required: ['design_query'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { designs: designSchema, matched_query: { type: 'string' } },
          required: ['designs', 'matched_query'], additionalProperties: false }, annotations: { readOnlyHint: true } }] };
    });
    mcp.setRequestHandler('tools/call', async request => {
      const args = request.params.arguments || {};
      const valid = request.params.name === BROWSER_MCP_TOOL && typeof args.design_query === 'string' && args.design_query.trim().length > 0
        && Object.keys(args).every(key => key === 'design_query' || key === 'exact_match')
        && (args.exact_match === undefined || typeof args.exact_match === 'boolean');
      saveExecution({ source: 'mcp', name: request.params.name, argumentsHash: hash(JSON.stringify(args)), exactBinding: true, successful: valid });
      if (!valid) return { isError: true, content: [{ type: 'text', text: 'The design_query argument is required for this MCP tool.' }] };
      const result = { designs: designs('stage3_MCP_DESIGN', args.design_query as string), matched_query: args.design_query as string };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    });
    return mcp;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const send = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.method === 'GET' && url.pathname === '/__fixture/calls') return send(structuredClone(state));
    state.requests += 1;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 1_048_576) return send({ error: 'Fixture request too large' }, 413); chunks.push(Buffer.from(chunk)); }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/mcp') {
        const result = await handler.fetch(new Request(`${origin}/mcp`, { method: request.method,
          headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          ...(raw ? { body: raw } : {}) }));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.headers.get('content-type')?.includes('text/event-stream')) response.flushHeaders();
        if (result.body) for await (const chunk of result.body) response.write(Buffer.from(chunk));
        response.end(); return;
      }
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (request.method === 'GET' && url.pathname === '/api/v3.1/auth_configs') return send({ items: [], next_cursor: null, total_pages: 1 });
      if (request.method === 'GET' && url.pathname === '/api/v3.1/toolkits') {
        const search = url.searchParams.get('search')?.toLowerCase() || '';
        const items = !search || 'canva'.includes(search) ? [{ slug: 'canva', name: 'Canva', no_auth: false, is_local_toolkit: false,
          meta: { description: 'Canva design integration for browser acceptance.', tools_count: 1, logo: '' } }] : [];
        return send({ items, next_cursor: null, total_pages: 1, total_items: items.length, current_page: 1 });
      }
      if (request.method === 'GET' && url.pathname === '/api/v3.1/connected_accounts') {
        state.composioAccountPages += 1;
        const users = (url.searchParams.get('user_ids') || '').split(',').filter(Boolean);
        const statuses = url.searchParams.get('statuses')?.split(',');
        const items = !statuses || statuses.includes('ACTIVE') ? users.map(account) : [];
        return send({ items, next_cursor: null, total_pages: 1 });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/v3.1/connected_accounts/')) {
        const userId = knownAccounts.get(decodeURIComponent(url.pathname.slice('/api/v3.1/connected_accounts/'.length)));
        return userId ? send(account(userId)) : send({ error: 'Fixture account not found' }, 404);
      }
      if (request.method === 'GET' && url.pathname === '/api/v3.1/tools') {
        state.composioToolPages += 1;
        const names = url.searchParams.get('tool_slugs')?.split(',');
        const search = url.searchParams.get('search')?.toLowerCase() || '';
        const tokens = search.split(/\s+/u).filter(Boolean);
        const searchable = `${tool.slug} ${tool.name} ${tool.description}`.toLowerCase();
        const items = url.searchParams.get('toolkit_slug') === 'canva' && (!names || names.includes(tool.slug))
          && tokens.every(token => searchable.includes(token)) ? [tool] : [];
        return send({ items, next_cursor: null, total_pages: 1 });
      }
      if (request.method === 'GET' && url.pathname === `/api/v3.1/tools/${BROWSER_COMPOSIO_TOOL}`) {
        state.composioSchemaReads += 1; return send(tool);
      }
      if (request.method === 'POST' && url.pathname === `/api/v3.1/tools/execute/${BROWSER_COMPOSIO_TOOL}`) {
        const userId = typeof body.user_id === 'string' ? body.user_id : '';
        const accountId = typeof body.connected_account_id === 'string' ? body.connected_account_id : '';
        const version = typeof body.version === 'string' ? body.version : '';
        const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments as Record<string, unknown> : {};
        const exactBinding = Boolean(userId) && accountId === accountIdForUser(userId) && version === BROWSER_COMPOSIO_VERSION;
        const valid = exactBinding && typeof args.query === 'string' && args.query.trim().length > 0 && Object.keys(args).every(key => key === 'query');
        saveExecution({ source: 'composio', name: BROWSER_COMPOSIO_TOOL, argumentsHash: hash(JSON.stringify(args)),
          accountHash: hash(accountId), userHash: hash(userId), versionHash: hash(version), exactBinding, successful: valid });
        return send({ successful: valid, error: valid ? null : 'The fixture requires an exact active account, concrete version and query.',
          data: valid ? { designs: designs('stage3_COMPOSIO_DESIGN', args.query as string) } : {}, log_id: 'stage3-browser-acceptance' });
      }
      return send({ error: 'Fixture endpoint not found' }, 404);
    } catch {
      if (!response.headersSent) send({ error: 'Fixture request failed' }, 400);
      else response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser fixture did not acquire a loopback port.');
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | null = null;
  return { baseUrl: origin, mcpUrl: `${origin}/mcp`, calls: () => structuredClone(state), close: () => {
    closing ??= (async () => { await handler.close(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); })();
    return closing;
  } };
}

if (path.basename(process.argv[1] || '') === 'integration-tool-browser-provider.ts') {
  void startIntegrationToolBrowserProvider().then(fixture => {
    process.stdout.write(`${fixture.baseUrl}\n`);
    const shutdown = () => { void fixture.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  }).catch(() => { process.stderr.write('Could not start the integration browser provider.\n'); process.exitCode = 1; });
}
