import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import type { Tool } from '@modelcontextprotocol/client';
import { z } from 'zod';

export const CREATOR_COMPANY_DOMAIN = 'example.testcompany';
export const CREATOR_HUBSPOT_TOOL = 'HUBSPOT_GET_COMPANY';
export const CREATOR_CANVA_TOOL = 'CANVA_LIST_DESIGNS';
export const CREATOR_RESEARCH_TOOL = 'research_company';
export const CREATOR_SOURCE_TOOL = 'get_research_source';
const INITIAL_VERSION = '20261016_01';
const ROTATED_VERSION = '20261016_02';
const DATE = '2026-10-16T00:00:00.000Z';
const sources = [
  { id: 'company-profile', title: 'Controlled company profile', url: 'https://example.testcompany/about',
    text: 'Acme Research GmbH researches industrial analytics in Berlin.' },
  { id: 'company-update', title: 'Controlled company update', url: 'https://example.testcompany/research',
    text: 'The company has 42 employees and is piloting an energy-efficiency analytics platform.' },
];
const company = { id: 'creator-fixture-acme', name: 'Acme Research GmbH', domain: CREATOR_COMPANY_DOMAIN,
  industry: 'Industrial analytics', employees: 42, headquarters: 'Berlin, Germany' };
const facts = ['The company researches industrial analytics.', 'The company has 42 employees.',
  'The company is piloting an energy-efficiency analytics platform.'];
const slotSchema = z.enum(['actor-a', 'actor-b']);
const toolkitSchema = z.enum(['hubspot', 'canva']);
const providerSchema = z.enum(['composio', 'mcp']);
const controlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('register_entity'), slot: slotSchema, entity: z.string().min(1).max(512) }).strict(),
  z.object({ action: z.literal('revoke_account'), slot: slotSchema, toolkit: toolkitSchema, revoked: z.boolean() }).strict(),
  z.object({ action: z.literal('availability'), provider: providerSchema, available: z.boolean() }).strict(),
  z.object({ action: z.literal('schema'), provider: providerSchema, rotated: z.boolean() }).strict(),
]);
export type CreatorProviderControl = z.infer<typeof controlSchema>;
type Actor = { entity: string; accounts: Map<string, { id: string; revoked: boolean }> };
type SafeCall = { sequence: number; provider: 'composio' | 'mcp'; operation: string; tool?: string;
  actorSlot?: 'actor-a' | 'actor-b'; entityHash?: string; accountHash?: string; argumentsHash?: string;
  versionHash?: string; exactBinding?: boolean; successful?: boolean; code?: string };

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Controlled provider only: no credentials are read, saved, reflected or verified. */
export async function startCreatorE2eProviderFixture() {
  const nonce = randomUUID();
  const actors = new Map<'actor-a' | 'actor-b', Actor>();
  const available = { composio: true, mcp: true };
  const rotated = { composio: false, mcp: false };
  const calls: SafeCall[] = [];
  let sequence = 0;
  let origin = '';
  const record = (call: Omit<SafeCall, 'sequence'>) => {
    calls.push({ sequence: ++sequence, ...call });
    if (calls.length > 300) calls.shift();
  };
  const version = () => rotated.composio ? ROTATED_VERSION : INITIAL_VERSION;
  const actorEntry = (entity: string) => [...actors.entries()].find(([, actor]) => actor.entity === entity);
  const account = (actor: Actor, toolkit: 'hubspot' | 'canva') => {
    const entry = actor.accounts.get(toolkit)!;
    return { id: entry.id, user_id: actor.entity, toolkit: { slug: toolkit, name: toolkit === 'hubspot' ? 'HubSpot' : 'Canva' },
      status: entry.revoked ? 'REVOKED' : 'ACTIVE', status_reason: null, is_disabled: entry.revoked,
      auth_config: { id: `creator_fixture_${toolkit}_config`, is_composio_managed: true, is_disabled: false },
      created_at: DATE, updated_at: DATE };
  };
  const tools = () => [
    { slug: CREATOR_HUBSPOT_TOOL, name: 'Get company by domain',
      description: 'Read a CRM company by domain. Readonly company profile lookup; no CRM writes.',
      toolkit: { slug: 'hubspot', name: 'HubSpot' }, version: version(), no_auth: false,
      input_parameters: { type: 'object', properties: { domain: { type: 'string', enum: [CREATOR_COMPANY_DOMAIN] },
        ...(rotated.composio ? { research_depth: { type: 'string', enum: ['brief'] } } : {}) },
      required: rotated.composio ? ['domain', 'research_depth'] : ['domain'], additionalProperties: false },
      output_parameters: { type: 'object', properties: { company: { type: 'object' } }, required: ['company'], additionalProperties: false } },
    { slug: CREATOR_CANVA_TOOL, name: 'List company brief designs',
      description: 'Read existing company brief designs. Readonly; no design creation or mutation.',
      toolkit: { slug: 'canva', name: 'Canva' }, version: version(), no_auth: false,
      input_parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['query'], additionalProperties: false },
      output_parameters: { type: 'object', properties: { designs: { type: 'array', items: { type: 'object' } } }, required: ['designs'], additionalProperties: false } },
  ];
  const control = (value: unknown) => {
    const input = controlSchema.parse(value);
    if (input.action === 'register_entity') {
      const existing = actors.get(input.slot);
      if (existing && existing.entity !== input.entity) throw new Error('Actor slot is already registered.');
      if (actorEntry(input.entity)?.[0] && actorEntry(input.entity)?.[0] !== input.slot) throw new Error('Entity is already assigned to another slot.');
      if (!existing) actors.set(input.slot, { entity: input.entity,
        accounts: new Map(['hubspot', 'canva'].map(toolkit => [toolkit, { id: `creator_${toolkit}_${randomUUID()}`, revoked: false }])) });
    } else if (input.action === 'revoke_account') {
      const entry = actors.get(input.slot)?.accounts.get(input.toolkit);
      if (!entry) throw new Error('Actor slot is not registered.');
      entry.revoked = input.revoked;
    } else if (input.action === 'availability') available[input.provider] = input.available;
    else { rotated[input.provider] = input.rotated; if (input.provider === 'mcp') handler.notify.toolsChanged(); }
  };
  const status = () => ({ schemaVersion: 1, nonce, available: { ...available }, rotated: { ...rotated },
    composioVersion: version(), requests: sequence,
    actors: [...actors.entries()].map(([slot, actor]) => ({ slot, entityHash: hash(actor.entity),
      accounts: [...actor.accounts.entries()].map(([toolkit, entry]) => ({ toolkit, accountHash: hash(entry.id), active: !entry.revoked })) })),
    calls: structuredClone(calls) });
  const handler = createMcpHandler(() => {
    const mcp = new Server({ name: 'Creator Company Research', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    mcp.setRequestHandler('tools/list', async () => {
      record({ provider: 'mcp', operation: 'tools/list', successful: true });
      const metadata: Tool[] = [
        { name: CREATOR_RESEARCH_TOOL, title: 'Research a company',
          description: 'Read three controlled company research facts and two sources for a company domain.',
          inputSchema: { type: 'object', properties: { domain: { type: 'string', enum: [CREATOR_COMPANY_DOMAIN] },
            ...(rotated.mcp ? { source_limit: { type: 'integer', enum: [2] } } : {}) },
          required: rotated.mcp ? ['domain', 'source_limit'] : ['domain'], additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
        { name: CREATOR_SOURCE_TOOL, title: 'Read a research source', description: 'Read the exact controlled research source by its ID.',
          inputSchema: { type: 'object', properties: { source_id: { type: 'string', enum: sources.map(source => source.id) } }, required: ['source_id'], additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      ];
      return { tools: metadata };
    });
    mcp.setRequestHandler('tools/call', async request => {
      const args = request.params.arguments ?? {};
      const research = request.params.name === CREATOR_RESEARCH_TOOL && args.domain === CREATOR_COMPANY_DOMAIN
        && Object.keys(args).every(key => key === 'domain' || rotated.mcp && key === 'source_limit')
        && (!rotated.mcp || args.source_limit === 2);
      const source = request.params.name === CREATOR_SOURCE_TOOL && Object.keys(args).length === 1
        && sources.find(item => item.id === args.source_id);
      const valid = Boolean(research || source);
      record({ provider: 'mcp', operation: 'tools/call', tool: [CREATOR_RESEARCH_TOOL, CREATOR_SOURCE_TOOL].includes(request.params.name) ? request.params.name : 'unknown',
        argumentsHash: hash(JSON.stringify(args)), successful: valid, ...(valid ? {} : { code: 'INVALID_ARGUMENTS' }) });
      if (!valid) return { isError: true, content: [{ type: 'text', text: 'The current readonly tool schema is required.' }] };
      const result = research ? { company: company.name, domain: company.domain, facts, sources, controlledFixture: true } : { source, controlledFixture: true };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    });
    return mcp;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    const send = (value: unknown, code = 200) => {
      response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/__fixture/status') return send(status());
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) return send({ error: 'Fixture request too large.' }, 413);
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      if (request.method === 'POST' && url.pathname === '/__fixture/control') {
        if (request.headers.origin && request.headers.origin !== origin || request.headers['content-type'] !== 'application/json'
          || body.nonce !== nonce || Object.keys(body).some(key => key !== 'nonce' && key !== 'control')) return send({ error: 'Invalid fixture control.' }, 403);
        control(body.control); return send(status());
      }
      const provider = url.pathname === '/mcp' ? 'mcp' : 'composio';
      if (!available[provider]) {
        record({ provider, operation: 'unavailable', successful: false, code: 'PROVIDER_UNAVAILABLE' });
        return send({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'Controlled provider is unavailable.' } }, 503);
      }
      if (url.pathname === '/mcp') {
        const result = await handler.fetch(new Request(`${origin}/mcp`, { method: request.method,
          headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          ...(raw ? { body: raw } : {}) }));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.headers.get('content-type')?.includes('text/event-stream')) response.flushHeaders();
        if (result.body) for await (const chunk of result.body) response.write(Buffer.from(chunk));
        response.end(); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/v3.1/auth_configs') return send({ items: [], next_cursor: null, total_pages: 1 });
      if (request.method === 'GET' && url.pathname === '/api/v3.1/toolkits') {
        record({ provider, operation: 'toolkits/list', successful: true });
        const search = (url.searchParams.get('search') || '').toLowerCase();
        const items = ['hubspot', 'canva'].filter(slug => !search || slug.includes(search)).map(slug => ({ slug,
          name: slug === 'hubspot' ? 'HubSpot' : 'Canva', no_auth: false, is_local_toolkit: false,
          meta: { description: slug === 'hubspot' ? 'Readonly CRM company profiles for controlled Creator acceptance.' : 'Readonly company brief designs for controlled Creator acceptance.', tools_count: 1, logo: '' } }));
        return send({ items, next_cursor: null, total_pages: 1, total_items: items.length, current_page: 1 });
      }
      if (request.method === 'GET' && url.pathname === '/api/v3.1/connected_accounts') {
        record({ provider, operation: 'connected_accounts/list', successful: true });
        const entities = (url.searchParams.get('user_ids') || '').split(',');
        const toolkits = url.searchParams.get('toolkit_slugs')?.split(',');
        const statuses = url.searchParams.get('statuses')?.split(',');
        const items = [...actors.values()].filter(actor => entities.includes(actor.entity)).flatMap(actor => (['hubspot', 'canva'] as const)
          .filter(toolkit => !toolkits || toolkits.includes(toolkit)).map(toolkit => account(actor, toolkit)))
          .filter(item => !statuses || statuses.includes(item.status));
        return send({ items, next_cursor: null, total_pages: 1 });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/v3.1/connected_accounts/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/v3.1/connected_accounts/'.length));
        const found = [...actors.values()].flatMap(actor => (['hubspot', 'canva'] as const).map(toolkit => account(actor, toolkit))).find(item => item.id === id);
        record({ provider, operation: 'connected_accounts/get', successful: Boolean(found) });
        return found ? send(found) : send({ error: 'Fixture account not found.' }, 404);
      }
      if (request.method === 'GET' && url.pathname === '/api/v3.1/tools') {
        record({ provider, operation: 'tools/list', successful: true });
        const slugs = url.searchParams.get('tool_slugs')?.split(',');
        const tokens = (url.searchParams.get('search') || '').toLowerCase().split(/\s+/u).filter(Boolean);
        const items = tools().filter(tool => (!url.searchParams.get('toolkit_slug') || tool.toolkit.slug === url.searchParams.get('toolkit_slug'))
          && (!slugs || slugs.includes(tool.slug)) && tokens.every(token => `${tool.slug} ${tool.name} ${tool.description}`.toLowerCase().includes(token)));
        return send({ items, next_cursor: null, total_pages: 1 });
      }
      const schemaTool = tools().find(tool => url.pathname === `/api/v3.1/tools/${tool.slug}`);
      if (request.method === 'GET' && schemaTool) {
        record({ provider, operation: 'tools/schema', tool: schemaTool.slug, successful: true }); return send(schemaTool);
      }
      const executeTool = tools().find(tool => url.pathname === `/api/v3.1/tools/execute/${tool.slug}`);
      if (request.method === 'POST' && executeTool) {
        const entity = typeof body.user_id === 'string' ? body.user_id : '';
        const id = typeof body.connected_account_id === 'string' ? body.connected_account_id : '';
        const requestedVersion = typeof body.version === 'string' ? body.version : '';
        const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments as Record<string, unknown> : {};
        const entry = actorEntry(entity);
        const activeAccount = entry?.[1].accounts.get(executeTool.toolkit.slug);
        const exactBinding = Boolean(activeAccount && !activeAccount.revoked && activeAccount.id === id);
        const validArgs = executeTool.slug === CREATOR_HUBSPOT_TOOL ? args.domain === CREATOR_COMPANY_DOMAIN
          && Object.keys(args).every(key => key === 'domain' || rotated.composio && key === 'research_depth')
          && (!rotated.composio || args.research_depth === 'brief')
          : typeof args.query === 'string' && args.query.trim().length > 0 && args.query.length <= 200 && Object.keys(args).length === 1;
        const successful = exactBinding && requestedVersion === version() && validArgs;
        const code = !exactBinding ? 'ACCOUNT_BINDING_DENIED' : requestedVersion !== version() ? 'SCHEMA_STALE' : !validArgs ? 'INVALID_ARGUMENTS' : undefined;
        record({ provider, operation: 'tools/execute', tool: executeTool.slug, ...(entry ? { actorSlot: entry[0] } : {}),
          entityHash: hash(entity), accountHash: hash(id), argumentsHash: hash(JSON.stringify(args)), versionHash: hash(requestedVersion), exactBinding, successful, ...(code ? { code } : {}) });
        return send({ successful, error: code || null, data: successful ? executeTool.slug === CREATOR_HUBSPOT_TOOL
          ? { company, controlledFixture: true } : { designs: [{ id: 'creator-fixture-brief', title: 'Acme Research company brief' }], controlledFixture: true } : {}, log_id: `creator-fixture-${sequence}` });
      }
      return send({ error: 'Fixture endpoint not found.' }, 404);
    } catch {
      if (!response.headersSent) send({ error: 'Invalid controlled fixture request.' }, 400);
      else response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Creator fixture did not acquire a loopback port.');
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return { baseUrl: origin, mcpUrl: `${origin}/mcp`, controlUrl: `${origin}/__fixture/control`, statusUrl: `${origin}/__fixture/status`, nonce,
    status, control, close: () => closing ??= (async () => {
      await handler.close(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    })() };
}
