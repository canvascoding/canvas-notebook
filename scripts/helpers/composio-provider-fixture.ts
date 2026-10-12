import { once } from 'node:events';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createComposioNativeConsentFixture, parseComposioNativeConsentOptions, type ComposioNativeConsentOptions } from './composio-native-consent-fixture';

type Account = { id: string; toolkit: string; status: string };
type Call = { path: string; body: Record<string, unknown>; userId: string | null; apiKey: string | null; toolNames: string | null; toolkitSlugs: string | null };
const APPS = [
  { slug: 'canva', name: 'Canva', no_auth: false },
  { slug: 'slack', name: 'Slack', no_auth: false },
  { slug: 'github', name: 'GitHub', no_auth: false },
  { slug: 'duckduckgo', name: 'DuckDuckGo', no_auth: true },
];

export async function createComposioProviderFixture(options: { nativeConsent?: ComposioNativeConsentOptions } = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'nativeConsent')) {
    throw new Error('The Composio fixture options are invalid.');
  }
  const nativeOptions = options.nativeConsent === undefined ? undefined : parseComposioNativeConsentOptions(options.nativeConsent);
  const nativeConsent = nativeOptions === undefined ? undefined : await createComposioNativeConsentFixture(nativeOptions);
  const accounts = new Map<string, Account[]>();
  const calls: Call[] = [];
  const versions = new Map<string, string>();
  const inputs = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, string>();
  const callbacks = new Map<string, string>();
  const seededEntities = new Set<string>();
  let pendingSequence = 0;
  let unknownOutcome = false;
  let unknownManagement = false;
  let loseNextLinkAcknowledgement = false;
  let failNextToolPage = false;
  let rotateOnToolRead: (() => Promise<void>) | null = null;
  let rotateOnEndpoint: { path: string; callback: () => Promise<void> } | null = null;
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
    const url = new URL(request.url!, 'http://localhost');
    if (nativeConsent && url.pathname === '/__native/composio') {
      const supplied = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
      const expected = `Bearer ${nativeOptions!.controlToken}`;
      const authenticated = Buffer.byteLength(supplied) === Buffer.byteLength(expected)
        && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
      if (!authenticated) { response.writeHead(401, headers); response.end(JSON.stringify({ error: 'unauthorized' })); return; }
      if (request.method !== 'GET') { response.writeHead(405, { ...headers, Allow: 'GET' }); response.end(JSON.stringify({ error: 'method_not_allowed' })); return; }
      const flowHash = url.searchParams.get('flowHash') ?? undefined;
      if ([...url.searchParams.keys()].some(key => key !== 'flowHash') || url.searchParams.getAll('flowHash').length > 1
        || flowHash !== undefined && !/^[a-f0-9]{64}$/u.test(flowHash)) {
        response.writeHead(400, headers); response.end(JSON.stringify({ error: 'invalid_request' })); return;
      }
      try {
        const payload = JSON.stringify({ version: 1, nonce: nativeOptions!.fixtureNonce,
          origin: nativeConsent.origin, stats: nativeConsent.readStats(), issued: nativeConsent.readFlow(flowHash) });
        response.writeHead(200, headers); response.end(payload);
      } catch { if (!response.headersSent) response.writeHead(503, headers); response.end(JSON.stringify({ error: 'unavailable' })); }
      return;
    }
    nativeConsent?.observe('sdkRequests');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    calls.push({ path: url.pathname, body, userId: url.searchParams.get('user_ids'),
      apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : null,
      toolNames: url.searchParams.get('tool_slugs'), toolkitSlugs: url.searchParams.get('toolkit_slugs') });
    if (rotateOnEndpoint?.path === url.pathname) {
      const rotation = rotateOnEndpoint;
      rotateOnEndpoint = null;
      await rotation.callback();
    }
    const send = (payload: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); };
    if (url.pathname === '/api/v3.1/tool_router/session' && request.method === 'POST') {
      nativeConsent?.observe('sessions');
      const sessionId = `fixture-session-${sessions.size + 1}`;
      sessions.set(sessionId, String(body.user_id));
      return send({ session_id: sessionId, mcp: { url: 'https://fixture.example.test/mcp' }, tool_router_tools: [], config: { user_id: body.user_id } });
    }
    const linkingSession = url.pathname.match(/^\/api\/v3\.1\/tool_router\/session\/([^/]+)\/link$/u)?.[1];
    if (linkingSession && request.method === 'POST') {
      nativeConsent?.observe('sdkLinks');
      if (unknownManagement) { request.socket.destroy(); return; }
      const userId = sessions.get(linkingSession);
      if (!userId || !APPS.some(app => app.slug === body.toolkit)) return send({ error: 'Invalid OAuth fixture selection' }, 400);
      const id = `fixture-initiated-${++pendingSequence}`;
      const pending = { id, toolkit: String(body.toolkit), status: 'INITIATED' };
      let redirectUrl = `https://fixture.example.test/oauth/${id}`;
      if (nativeConsent) {
        try { redirectUrl = nativeConsent.issue({ profileEntityId: userId, pendingAccountId: id, toolkit: pending.toolkit, callbackUrl: String(body.callback_url) }, pending); }
        catch { return send({ error: 'Invalid owned native consent selection' }, 400); }
        if (!seededEntities.has(userId)) {
          seededEntities.add(userId);
          accounts.set(userId, [...(accounts.get(userId) || []),
            { id: `fixture-decoy-${seededEntities.size}-first`, toolkit: pending.toolkit, status: 'ACTIVE' },
            { id: `fixture-decoy-${seededEntities.size}-second`, toolkit: pending.toolkit, status: 'ACTIVE' },
            { id: `fixture-decoy-${seededEntities.size}-foreign`, toolkit: pending.toolkit === 'slack' ? 'canva' : 'slack', status: 'ACTIVE' }]);
        }
      }
      accounts.set(userId, [...(accounts.get(userId) || []), pending]);
      callbacks.set(id, String(body.callback_url));
      if (loseNextLinkAcknowledgement) { loseNextLinkAcknowledgement = false; request.socket.destroy(); return; }
      return send({ connected_account_id: id, redirect_url: redirectUrl });
    }
    const deletingAccount = url.pathname.match(/^\/api\/v3\.1\/connected_accounts\/([^/]+)$/u)?.[1];
    if (deletingAccount && request.method === 'DELETE') {
      if (unknownManagement) { request.socket.destroy(); return; }
      for (const [userId, values] of accounts) accounts.set(userId, values.filter(account => account.id !== deletingAccount));
      return send({ success: true });
    }
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
    if (url.pathname === '/api/v3.1/connected_accounts') { nativeConsent?.observe('accountReads'); return send({
      items: (accounts.get(url.searchParams.get('user_ids') || '') || []).filter(account => !url.searchParams.get('toolkit_slugs')
        || url.searchParams.get('toolkit_slugs')!.split(',').includes(account.toolkit)).map((account) => ({ id: account.id,
        toolkit: { slug: account.toolkit, name: APPS.find((app) => app.slug === account.toolkit)!.name },
        status: account.status, status_reason: null, is_disabled: false,
        auth_config: { id: 'fixture-auth', is_composio_managed: true, is_disabled: false },
        created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' })), next_cursor: null, total_pages: 1,
    }); }
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
      if (nativeConsent) { nativeConsent.observe('businessCalls'); return send({ successful: false, error: 'BUSINESS_CALL_DISABLED', data: null }, 403); }
      if (unknownOutcome) { request.socket.destroy(); return; }
      const accountAllowed = execution.no_auth || (accounts.get(String(body.user_id)) || []).some((account) =>
        account.id === body.connected_account_id && account.toolkit === execution.toolkit.slug && account.status === 'ACTIVE');
      return send({ successful: accountAllowed, error: accountAllowed ? null : 'NOT_CONNECTED',
        data: { owner: body.user_id, account: body.connected_account_id, params: body.arguments, version: body.version }, log_id: 'fixture-call' });
    }
    return send({ error: `Unexpected fixture endpoint ${url.pathname}` }, 404);
  });
  try { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  catch { await nativeConsent?.close(); throw new Error('The owned Composio fixture listener could not start.'); }
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { accounts, calls, versions, inputs, baseUrl,
    ...(nativeConsent ? { nativeConsent: { origin: nativeConsent.origin, controlUrl: `${baseUrl}/__native/composio`,
      readStats: nativeConsent.readStats, readFlow: nativeConsent.readFlow } } : {}),
    completeOAuth: (accountId: string) => {
      if (nativeConsent) throw new Error('Native consent requires the real HTTPS approval form.');
      for (const values of accounts.values()) for (const account of values) if (account.id === accountId) account.status = 'ACTIVE';
      return callbacks.get(accountId);
    },
    setUnknown: (value: boolean) => { unknownOutcome = value; },
    setUnknownManagement: (value: boolean) => { unknownManagement = value; },
    loseNextLinkAcknowledgement: () => { loseNextLinkAcknowledgement = true; },
    failPage: () => { failNextToolPage = true; },
    rotateOnRead: (callback: () => Promise<void>) => { rotateOnToolRead = callback; },
    rotateOnEndpoint: (endpoint: string, callback: () => Promise<void>) => { rotateOnEndpoint = { path: endpoint, callback }; },
    setLegacyCapabilityStatus: (value: number) => { legacyCapabilityStatus = value; },
    close: async () => { server.closeAllConnections(); await Promise.all([
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), nativeConsent?.close(),
    ]); } };
}
