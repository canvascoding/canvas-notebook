import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

const SCOPES = 'openid offline_access workspace:list knowledge:tree knowledge:search knowledge:read knowledge:write knowledge:assets';
type JsonRecord = Record<string, unknown>;
export type IngestE2EWorkspace = { id: string; rootRelativePath: string; name: string };
export type IngestE2EToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }>;
  structuredContent?: JsonRecord; _meta?: JsonRecord };

export async function requireIngestE2EJson<T>(response: APIResponse, label: string): Promise<T> {
  assert.ok(response.ok(), `${label}: HTTP ${response.status()}`);
  return response.json() as Promise<T>;
}

/** A public client uses real browser consent and PKCE, then ordinary workspace grants. */
export async function authorizeIngestE2EMcp(owner: BrowserContext, baseURL: string, workspaceId: string, protocolVersion: string) {
  const metadata = await requireIngestE2EJson<{ issuer: string; registration_endpoint: string;
    authorization_endpoint: string; token_endpoint: string }>(
    await owner.request.get('/.well-known/oauth-authorization-server/api/auth'), 'OAuth discovery');
  const clientName = `MCP file ingest E2E ${randomUUID()}`;
  const redirectUri = `http://127.0.0.1:32199/mcp-file-ingest/${randomUUID()}`;
  const registered = await fetch(metadata.registration_endpoint, {
    method: 'POST', headers: { Origin: baseURL, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(90_000), body: JSON.stringify({ client_name: clientName,
      application_type: 'native', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPES }),
  });
  assert.ok(registered.ok, `Public OAuth registration: HTTP ${registered.status}`);
  const registration = await registered.json() as { client_id: string };
  assert.equal(typeof registration.client_id, 'string');
  const verifier = randomBytes(32).toString('base64url');
  const state = randomUUID();
  const authorization = new URL(metadata.authorization_endpoint);
  authorization.search = new URLSearchParams({ response_type: 'code', client_id: registration.client_id,
    redirect_uri: redirectUri, scope: SCOPES, resource: `${baseURL}/mcp`, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  const page = await owner.newPage();
  let callback: URL | undefined;
  let connectionId: string | undefined;
  let accessToken = '';
  try {
    page.on('request', request => {
      const target = new URL(request.url());
      const expected = new URL(redirectUri);
      if (request.isNavigationRequest() && target.origin === expected.origin && target.pathname === expected.pathname) callback = target;
    });
    await page.route(`${redirectUri}**`, async route => {
      callback = new URL(route.request().url());
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Authorization complete</title>Authorization complete' });
    });
    await page.goto(authorization.toString(), { timeout: 180_000 });
    const accept = page.locator('button[name="accept"][value="true"]');
    await expect(accept).toBeVisible({ timeout: 90_000 });
    await accept.click();
    await expect.poll(() => Boolean(callback), { timeout: 90_000 }).toBe(true);
    assert.equal(callback!.searchParams.get('state'), state);
    assert.equal(callback!.searchParams.get('iss'), metadata.issuer);
    assert.ok(callback!.searchParams.get('code'), 'Real consent must return an authorization code.');
    const exchanged = await requireIngestE2EJson<{ access_token: string }>(await owner.request.post(metadata.token_endpoint, {
      headers: { Origin: baseURL }, form: { grant_type: 'authorization_code', client_id: registration.client_id,
        code: callback!.searchParams.get('code')!, redirect_uri: redirectUri, code_verifier: verifier,
        resource: `${baseURL}/mcp` }, timeout: 90_000,
    }), 'PKCE exchange');
    assert.ok(typeof exchanged.access_token === 'string' && exchanged.access_token.length > 0,
      'The real token endpoint must return an access token.');
    accessToken = exchanged.access_token;
    const connections = await requireIngestE2EJson<{ data: { connections: Array<{ connectionId: string; clientName: string }> } }>(
      await owner.request.get('/api/integrations/mcp-server/connections'), 'List synthetic OAuth connection');
    connectionId = connections.data.connections.find(item => item.clientName === clientName)?.connectionId;
    assert.ok(connectionId, 'Real consent must create the synthetic client connection.');
    await requireIngestE2EJson(await owner.request.put('/api/integrations/mcp-server/connections/workspaces', {
      data: { connectionId, workspaceIds: [workspaceId] },
    }), 'Grant only the owned test workspace');
  } finally { await page.close(); }
  let sequence = 0;
  let revoked = false;
  async function rpc(method: string, params: JsonRecord = {}) {
    const response = await fetch(`${baseURL}/mcp`, {
      method: 'POST', signal: AbortSignal.timeout(180_000),
      headers: { Authorization: `Bearer ${accessToken}`, Origin: baseURL, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion,
        'MCP-Method': method, ...(method === 'tools/call' ? { 'MCP-Name': String(params.name) } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': protocolVersion,
        'io.modelcontextprotocol/clientInfo': { name: clientName, version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    });
    // Return protocol errors as tool failures so negative paths can be asserted
    // without logging submitted arguments, OAuth credentials or signed URLs.
    const payload = await response.json() as { result?: JsonRecord; error?: { code: number; message: string } };
    if (payload.error) return { isError: true, structuredContent: { rpc_error: payload.error.code },
      content: [{ type: 'text', text: payload.error.message }] };
    if (!response.ok) return { isError: true, structuredContent: { http_status: response.status },
      content: [{ type: 'text', text: `MCP request rejected with HTTP ${response.status}` }] };
    assert.ok(payload.result, `MCP ${method} must return a result.`);
    return payload.result;
  }
  return {
    rpc,
    call: async (name: string, args: JsonRecord) => await rpc('tools/call', { name, arguments: args }) as IngestE2EToolResult,
    async revoke() {
      if (revoked) return;
      await requireIngestE2EJson(await owner.request.delete('/api/integrations/mcp-server/connections', {
        data: { connectionId },
      }), 'Revoke only the synthetic OAuth connection');
      revoked = true;
    },
  };
}

export function requireIngestE2ESuccess(result: IngestE2EToolResult, label: string): JsonRecord {
  assert.notEqual(result.isError, true, `${label}: ${result.content?.map(item => item.text || '').join('\n') || 'tool failure'}`);
  assert.ok(result.structuredContent, `${label}: a verified structured receipt is required.`);
  return result.structuredContent;
}

export function requireIngestE2EFailure(result: IngestE2EToolResult, code?: string) {
  assert.equal(result.isError, true, 'The rejected operation must report a tool/protocol error.');
  if (code) assert.equal(result.structuredContent?.code, code);
}

export async function openIngestE2EEditor(page: Page, workspaceId: string, filePath: string) {
  await page.addInitScript(({ id, origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, { id: workspaceId, origin: process.env.BASE_URL! });
  await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(filePath)}`,
    { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const editor = page.locator('.tiptap-editor-shell .ProseMirror');
  if (!(await editor.isVisible())) {
    await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true })
      .click({ timeout: 90_000 });
  }
  await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 90_000 });
  return editor;
}

export async function inspectIngestE2EEditor(page: Page) {
  const json = await page.locator('.tiptap-editor-shell .ProseMirror').evaluate(element =>
    (element as HTMLElement & { editor: { getJSON(): JsonRecord } }).editor.getJSON());
  const nodeTypes = new Set<string>();
  const markTypes = new Set<string>();
  const texts: string[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const node = value as { type?: string; text?: string; marks?: Array<{ type: string }>; content?: unknown[] };
    if (node.type) nodeTypes.add(node.type);
    if (node.text) texts.push(node.text);
    for (const mark of node.marks ?? []) markTypes.add(mark.type);
    for (const child of node.content ?? []) visit(child);
  }
  visit(json);
  return { json, nodeTypes: [...nodeTypes], markTypes: [...markTypes], text: texts.join(' ') };
}
