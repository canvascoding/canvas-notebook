import { expect, type APIResponse, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

export type ProductionWorkspace = {
  id: string; name: string; type: string; organizationId?: string | null; rootRelativePath: string;
  permissions: { canRead: boolean; canWrite: boolean; canDelete: boolean; canRunAgent: boolean };
};
export type Timeline = {
  document: { workspaceId: string; documentId: string; lineageId: string };
  policy: { requestedMode: string; effectiveMode: string; revision: number };
  entries: Array<{ kind: string; id: string; source?: string; operationId?: string }>;
};
export type McpToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};
type NativeEvent = {
  type: string; success?: boolean; error?: string;
  event?: { type: string; toolName?: string; toolCallId?: string; isError?: boolean;
    result?: { details?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> } };
};
export type NativeReceipt = { event: NonNullable<NativeEvent['event']>; disk: string; receivedAt: number };

export async function responseJson<T>(response: APIResponse, label: string): Promise<T> {
  expect(response.ok(), `${label}: HTTP ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}

export async function productionIdentity(browser: Browser, secondary = false) {
  const context = await browser.newContext({ baseURL: process.env.BASE_URL, viewport: { width: 1480, height: 1000 } });
  const email = secondary ? process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL : process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = secondary ? process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD : process.env.BOOTSTRAP_ADMIN_PASSWORD;
  try {
    expect(Boolean(email && password), 'The managed account fixture must be configured.').toBe(true);
    const deadline = Date.now() + 90_000;
    let retries = 0;
    let login: APIResponse;
    while (true) {
      login = await context.request.post('/api/auth/sign-in/email', {
        headers: { Origin: process.env.BASE_URL! }, data: { email, password },
      });
      if (login.status() !== 429 || retries >= 2) break;
      retries += 1;
      const retryAfter = login.headers()['retry-after'];
      const seconds = Number(retryAfter);
      const requestedMs = retryAfter && Number.isFinite(seconds)
        ? seconds * 1_000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 10_000;
      // Better Auth's ordinary sign-in rule is 3 requests per 10 seconds.
      // Honor its Retry-After with a bounded wait; retain the real auth policy.
      const waitMs = Math.min(60_000, Math.max(1_000, Number.isFinite(requestedMs) ? requestedMs : 10_000));
      if (Date.now() + waitMs > deadline) break;
      console.info(`[production-review] Better Auth sign-in rate limited; waiting ${waitMs}ms`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    const identity = await responseJson<{ user: { id: string; role: string } }>(login, 'Sign in through Better Auth');
    return { context, user: identity.user };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export class ProductionDocument {
  readonly headers: Record<string, string>;
  readonly filePath = `document-review-production-${randomUUID()}.md`;
  readonly physicalPath: string;
  documentId = '';
  private uploaded = false;
  constructor(readonly owner: BrowserContext, readonly workspace: ProductionWorkspace) {
    this.headers = { 'x-canvas-workspace-id': workspace.id };
    const dataRoot = process.env.DOCUMENT_REVIEW_DATA_DIR || process.env.CANVAS_DATA_ROOT || process.env.DATA;
    expect(Boolean(dataRoot), 'The current host DATA path is required for physical-file assertions.').toBe(true);
    this.physicalPath = path.resolve(dataRoot!, workspace.rootRelativePath, this.filePath);
  }
  get target() { return { kind: 'document' as const, workspaceId: this.workspace.id, documentId: this.documentId }; }
  async upload(content: string) {
    await responseJson(await this.owner.request.post('/api/files/upload', {
      headers: this.headers, multipart: { path: '.', files: {
        name: this.filePath, mimeType: 'text/markdown', buffer: Buffer.from(content),
      } },
    }), 'Upload only the UUID document');
    this.uploaded = true;
  }
  async read() {
    const payload = await responseJson<{ data: { content: string; stats: { sha256: string };
      collaboration: { document: { id: string } }; revision?: { id: string } } }>(
      await this.owner.request.get('/api/files/read', { headers: this.headers, params: { path: this.filePath } }), 'Read current document');
    this.documentId = payload.data.collaboration.document.id;
    return payload.data;
  }
  disk() { return readFileSync(this.physicalPath, 'utf8'); }
  async timeline() {
    return responseJson<Timeline>(await this.owner.request.post('/api/files/version-center/v1/resolve', {
      headers: this.headers, data: { contractVersion: 1, target: this.target, initialView: 'history', source: 'deep_link' },
    }), 'Resolve public document timeline');
  }
  async setPolicy(requestedMode: 'review_required' | 'safe_direct') {
    const timeline = await this.timeline();
    return responseJson(await this.owner.request.post('/api/files/version-center/v1/policy', {
      headers: this.headers, data: { contractVersion: 1,
        target: { kind: 'lineage', workspaceId: this.workspace.id, lineageId: timeline.document.lineageId },
        requestedMode, expectedRevision: timeline.policy.revision },
    }), 'Change the UUID document policy');
  }
  async operations() {
    const payload = await responseJson<{ operations: Array<{ operationId: string; operationStatus: string;
      proposalVersion?: string; requestedMode?: string }> }>(await this.owner.request.get('/api/files/collaboration/operations', {
      headers: this.headers, params: { documentId: this.documentId },
    }), 'Read authenticated operations');
    return payload.operations;
  }
  async open(page: Page) {
    await page.goto(`/en/notebook?path=${encodeURIComponent(this.filePath)}`);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    if (!(await editor.isVisible())) await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 60_000 });
    return editor;
  }
  async cleanup() {
    if (!this.uploaded) return;
    await responseJson(await this.owner.request.delete('/api/files/delete', {
      headers: this.headers, data: { path: this.filePath },
    }), 'Remove only the UUID document');
    this.uploaded = false;
  }
}

export async function setDocumentReview(owner: BrowserContext, enabled: boolean) {
  const payload = await responseJson<{ success: boolean; data: { documentReviewEnabled: boolean } }>(
    await owner.request.patch('/api/admin/experimental-settings', { data: { documentReviewEnabled: enabled } }), 'Set experimental review');
  expect(payload.data.documentReviewEnabled).toBe(enabled);
}

export async function connectNative(owner: BrowserContext, document: ProductionDocument) {
  const created = await responseJson<{ session: { sessionId: string; agentId: string } }>(
    await owner.request.post('/api/sessions', { headers: document.headers,
      data: { agentId: 'canvas-agent', workspaceId: document.workspace.id, title: `Production review acceptance ${document.filePath}` } }),
    'Create a normal native agent session');
  const { sessionId, agentId } = created.session;
  const events: NativeEvent[] = [];
  const receipts: NativeReceipt[] = [];
  const errors: string[] = [];
  const base = process.env.BASE_URL!;
  const cookies = (await owner.cookies(base)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const socket = new WebSocket(`${base.replace(/^http/u, 'ws')}/ws/chat`, 'canvas-chat-v1', {
    headers: { Cookie: cookies, Origin: base, ...document.headers },
  });
  socket.on('error', error => errors.push(error.message));
  socket.on('message', raw => {
    const event = JSON.parse(raw.toString()) as NativeEvent;
    events.push(event);
    if (event.type === 'agent_event' && event.event?.type === 'tool_execution_end'
      && ['edit_file', 'apply_patch'].includes(event.event.toolName || '')) {
      console.info(`[production-review] native ${event.event.toolName} ended: ${event.event.isError ? 'error' : 'success'}`);
      // Snapshot synchronously in the actual tool-end callback, before polling
      // APIs or waiting for another editor to update.
      receipts.push({ event: event.event, disk: document.disk(), receivedAt: Date.now() });
    }
  });
  try {
    await expect.poll(() => events.some(event => event.type === 'auth_success'), { timeout: 30_000 }).toBe(true);
    socket.send(JSON.stringify({ type: 'subscribe_session', sessionId, requestId: randomUUID() }));
    await expect.poll(() => events.some(event => event.type === 'subscribe_result' && event.success === true), { timeout: 30_000 }).toBe(true);
  } catch (error) {
    socket.close();
    await owner.request.delete('/api/sessions', { params: { sessionId, agentId } });
    throw error;
  }
  return {
    async turn(instruction: string) {
      console.info('[production-review] starting a normal native user task');
      const before = receipts.length;
      const savedBefore = events.filter(event => event.event?.type === 'message_saved').length;
      const eventOffset = events.length;
      socket.send(JSON.stringify({ type: 'send_message', requestId: randomUUID(), clientMessageId: randomUUID(), sessionId, agentId,
        message: { role: 'user', timestamp: Date.now(), content: instruction },
        context: { channelId: 'app', currentPage: '/notebook', activeFilePath: document.filePath,
          workspace: { workspaceId: document.workspace.id, workspaceType: document.workspace.type,
            workspaceName: document.workspace.name, organizationId: document.workspace.organizationId,
            canWrite: true, canDelete: true, canShare: false } },
      }));
      await expect.poll(() => events.slice(eventOffset).some(event => event.type === 'send_message_result'), {
        timeout: 30_000,
      }).toBe(true);
      const acknowledgment = events.slice(eventOffset).find(event => event.type === 'send_message_result');
      expect(acknowledgment?.success, acknowledgment?.error || 'Native message admission').toBe(true);
      await expect.poll(() => events.filter(event => event.event?.type === 'message_saved').length, {
        timeout: 300_000, intervals: [500, 1_000, 2_000],
      }).toBe(savedBefore + 1);
      expect(errors).toEqual([]);
      console.info(`[production-review] native task saved, ${receipts.length - before} mutation receipt(s)`);
      return receipts.slice(before);
    },
    async cleanup() {
      socket.removeAllListeners('message');
      socket.close();
      await responseJson(await owner.request.delete('/api/sessions', { params: { sessionId, agentId } }), 'Remove only the native test session');
    },
  };
}

export function assertNativePhysicalReceipt(receipt: NativeReceipt) {
  const detail = receipt.event.result?.details;
  expect(receipt.event.isError, receipt.event.result?.content?.map(item => item.text || '').join('\n')).not.toBe(true);
  expect(Boolean(detail), 'The real runtime must expose the tool result details.').toBe(true);
  const results = receipt.event.toolName === 'apply_patch' ? detail!.results as Array<Record<string, unknown>> : [detail!];
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(result.outcome).toBe('applied');
    expect(result.afterSha256).toBe(createHash('sha256').update(receipt.disk).digest('hex'));
    const collaboration = result.collaboration as { durability: string; reviewRequired: boolean };
    expect(collaboration.reviewRequired).toBe(false);
    // The operation result retains its persisted-Yjs phase; physical projection
    // is confirmed afterward. The SHA assertion above verifies the stronger
    // disk-before-success contract independently of that recorded phase.
    expect(['persisted_yjs', 'checkpointed_file']).toContain(collaboration.durability);
  }
}

export async function enableProductionMcp(owner: BrowserContext, workspace: ProductionWorkspace) {
  const current = await responseJson<{ data: { desiredEnabled: boolean; protocolVersion: string;
    capabilities: Array<{ id: string; enabled: boolean }> } }>(await owner.request.get('/api/integrations/mcp-server'), 'Read MCP configuration');
  const workspaceStatus = await responseJson<{ data: { workspace: { enabled: boolean } } }>(
    await owner.request.get('/api/integrations/mcp-server/workspaces', { params: { workspace_id: workspace.id } }), 'Read workspace MCP opt-in');
  const originalTools = current.data.capabilities.filter(item => item.enabled).map(item => item.id);
  const cleanup = async () => {
    try {
      await responseJson(await owner.request.put('/api/integrations/mcp-server/workspaces', {
        data: { workspaceId: workspace.id, enabled: workspaceStatus.data.workspace.enabled },
      }), 'Restore previous workspace MCP opt-in');
    } finally {
      await responseJson(await owner.request.patch('/api/integrations/mcp-server', {
        data: { enabled: current.data.desiredEnabled, tools: originalTools },
      }), 'Restore previous instance MCP settings');
    }
  };
  try {
    await responseJson(await owner.request.patch('/api/integrations/mcp-server', {
      data: { enabled: true, tools: [...new Set([...originalTools, 'list_workspaces', 'read_knowledge_source', 'edit_knowledge_source'])] },
    }), 'Enable MCP through admin settings');
    await responseJson(await owner.request.put('/api/integrations/mcp-server/workspaces', {
      data: { workspaceId: workspace.id, enabled: true },
    }), 'Enable MCP for the selected team workspace');
    return { protocolVersion: current.data.protocolVersion, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function authorizeProductionMcp(owner: BrowserContext, workspace: ProductionWorkspace, protocolVersion: string) {
  const base = process.env.BASE_URL!;
  const metadata = await responseJson<{ issuer: string; registration_endpoint: string; authorization_endpoint: string; token_endpoint: string }>(
    await owner.request.get('/.well-known/oauth-authorization-server/api/auth'), 'Discover OAuth metadata');
  const clientName = `Production Document Review ${randomUUID()}`;
  // This is the OAuth client's callback, intercepted in its browser. It is not
  // an application endpoint and does not bypass authorization or consent.
  const redirectUri = `http://127.0.0.1:32199/document-review/${randomUUID()}`;
  // Public MCP clients register independently of the user's browser session.
  // Sending the Canvas cookie would select authenticated client management.
  const registered = await fetch(metadata.registration_endpoint, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, application_type: 'native', redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      scope: 'openid offline_access workspace:list knowledge:read knowledge:write' }),
  });
  const registration = await registered.json() as { client_id: string; error?: string; error_description?: string };
  expect(registered.ok, `Register a normal public PKCE client: HTTP ${registered.status}; `
    + `${registration.error || ''} ${registration.error_description || ''}`).toBe(true);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomUUID();
  const authorization = new URL(metadata.authorization_endpoint);
  authorization.search = new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: redirectUri,
    scope: 'openid offline_access workspace:list knowledge:read knowledge:write', resource: `${base}/mcp`, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  const consent = await owner.newPage();
  let callback: URL | undefined;
  let connectionId: string | undefined;
  try {
    // Chromium may follow the form's 303 without invoking a new route handler.
    // Capture the real client callback navigation as well; its code is then
    // validated through the provider's ordinary PKCE token endpoint.
    consent.on('request', request => {
      const target = new URL(request.url());
      const expected = new URL(redirectUri);
      if (request.isNavigationRequest() && target.origin === expected.origin && target.pathname === expected.pathname) callback = target;
    });
    await consent.route(`${redirectUri}**`, async route => {
      callback = new URL(route.request().url());
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Authorization complete</title>Authorization complete' });
    });
    await consent.goto(authorization.toString());
    const allow = consent.locator('button[name="accept"][value="true"]');
    await expect(allow).toBeVisible();
    await allow.click();
    await expect.poll(() => Boolean(callback), { timeout: 30_000 }).toBe(true);
    expect(callback!.searchParams.get('state')).toBe(state);
    expect(callback!.searchParams.get('iss')).toBe(metadata.issuer);
    expect(Boolean(callback!.searchParams.get('code'))).toBe(true);
    const token = await responseJson<{ access_token: string }>(await owner.request.post(metadata.token_endpoint, {
      headers: { Origin: base }, form: { grant_type: 'authorization_code', client_id: registration.client_id,
        code: callback!.searchParams.get('code')!, redirect_uri: redirectUri, code_verifier: verifier, resource: `${base}/mcp` },
    }), 'Exchange the real authorization code');
    expect(Boolean(token.access_token)).toBe(true);
    const connections = await responseJson<{ data: { connections: Array<{ connectionId: string; clientName: string }> } }>(
      await owner.request.get('/api/integrations/mcp-server/connections'), 'List owned OAuth connections');
    connectionId = connections.data.connections.find(item => item.clientName === clientName)?.connectionId;
    expect(Boolean(connectionId)).toBe(true);
    await responseJson(await owner.request.put('/api/integrations/mcp-server/connections/workspaces', {
      data: { connectionId, workspaceIds: [workspace.id] },
    }), 'Grant the OAuth client only the selected team workspace');
    let sequence = 0;
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const response = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(90_000),
        headers: { Authorization: `Bearer ${token.access_token}`, Origin: base, 'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion, 'MCP-Method': method,
          ...(method === 'tools/call' ? { 'MCP-Name': String(params.name) } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params: { ...params, _meta: {
          'io.modelcontextprotocol/protocolVersion': protocolVersion,
          'io.modelcontextprotocol/clientInfo': { name: clientName, version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        } } }),
      });
      expect(response.ok, `Authenticated MCP ${method}: HTTP ${response.status}`).toBe(true);
      const payload = await response.json() as { result?: Record<string, unknown>; error?: { code: number; message: string } };
      if (payload.error) throw new Error(`MCP ${method}: ${payload.error.message}`);
      return payload.result!;
    };
    const discovered = await rpc('server/discover', {});
    expect(discovered.supportedVersions).toContain(protocolVersion);
    return {
      call: async (name: string, args: Record<string, unknown>) => await rpc('tools/call', { name, arguments: args }) as McpToolResult,
      reconnect: async () => rpc('server/discover', {}),
      async cleanup() {
        await responseJson(await owner.request.delete('/api/integrations/mcp-server/connections', { data: { connectionId } }),
          'Disconnect only the synthetic OAuth grant');
      },
    };
  } catch (error) {
    if (!connectionId) {
      const response = await owner.request.get('/api/integrations/mcp-server/connections');
      if (response.ok()) {
        const payload = await response.json() as { data: { connections: Array<{ connectionId: string; clientName: string }> } };
        connectionId = payload.data.connections.find(item => item.clientName === clientName)?.connectionId;
      }
    }
    if (connectionId) await responseJson(await owner.request.delete('/api/integrations/mcp-server/connections', { data: { connectionId } }),
      'Disconnect the synthetic OAuth grant after failed setup');
    throw error;
  } finally {
    await consent.close();
  }
}
