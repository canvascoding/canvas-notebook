import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import ts from 'typescript';
import { PgDialect } from 'drizzle-orm/pg-core';
import { NextRequest } from 'next/server';
import type { MobileMcpActor } from '../app/lib/mobile/mcp-apps-access';
import { handleHtmlPreviewBoundary } from '../server/html-preview-boundary';
import type { IncomingMessage, ServerResponse } from 'node:http';

async function load<T>(filename: string, mocks: Record<string, unknown>): Promise<T> {
  const absolute = path.resolve(filename), native = createRequire(absolute), compiled = { exports: {} };
  const source = ts.transpileModule(await fs.readFile(absolute, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function('require','module','exports',source)((name: string) => name in mocks ? mocks[name] : native(name), compiled, compiled.exports);
  return compiled.exports as T;
}
class AccessError extends Error { constructor(message: string, readonly status = 403, readonly code = 'MCP_ACCESS_DENIED') { super(message); } }
async function main() {
  const contracts = await load<typeof import('../app/lib/mobile/mcp-apps-contracts')>('app/lib/mobile/mcp-apps-contracts.ts', {
    '@/app/lib/mcp/access': { McpAccessError: AccessError },
  });
  const app = { version: 1 as const, connectionId: randomUUID(), toolName: 'provider-original', resourceUri: 'ui://test/widget.html' };
  const actor: MobileMcpActor = { userId: 'one', sessionId: 'owned-chat', workspaceId: 'workspace-one', agentId: 'bradley',
    authSessionId: 'auth-one', authSessionExpiresAt: Date.now() + 60_000 };
  const source = { toolCallId: 'normalized-parent-call', app }, origin = 'https://instance.example', frameOrigin = 'https://preview.example';
  let auth = true, owned = true, workspace = actor.workspaceId, currentVersion = 1, enabled = true, configRevision = 1;
  let authReadDelay: (() => Promise<void>) | null = null, connectionReads = 0, environmentRevision = 1;
  let environmentReadDelay: (() => Promise<void>) | null = null;
  let message: unknown = { role: 'toolResult', toolCallId: source.toolCallId, toolName: 'mcp_provider_original',
    details: { mcpApp: app, mcpToolInput: { original: 'input' }, result: { content: [], structuredContent: { view: 1 }, _meta: { onlyApp: 'metadata' } } } };
  const dialect = new PgDialect(), queried: unknown[][] = [];
  const db = { query: { session: { findFirst: async () => {
    const row = auth ? { id: actor.authSessionId, expiresAt: new Date(actor.authSessionExpiresAt) } : null;
    await authReadDelay?.(); return row;
  } },
    piSessions: { findFirst: async ({ where }: { where: Parameters<typeof dialect.sqlToQuery>[0] }) => {
      queried.push(dialect.sqlToQuery(where).params); return owned ? { id: 4, workspaceId: workspace } : null;
    } } }, select: () => ({ from: () => ({ where: (where: Parameters<typeof dialect.sqlToQuery>[0]) => {
      queried.push(dialect.sqlToQuery(where).params); return { orderBy: () => ({ limit: async () => message ? [{ content: JSON.stringify(message) }] : [] }) };
    } }) }) };
  const access = await load<typeof import('../app/lib/mobile/mcp-apps-access')>('app/lib/mobile/mcp-apps-access.ts', {
    '@/app/lib/db': { db }, '@/app/lib/mcp/access': { McpAccessError: AccessError,
      assertMcpConnectionAccess: async () => { connectionReads++; return { connection: { authVersion: currentVersion, configRevision } }; } },
    '@/app/lib/mcp/apps-host': { requireMcpAppChatAccess: async () => workspace },
    './mcp-apps-contracts': contracts,
    './tool-apps-route': { requireMobileToolAppChat: async () => ({ chat: actor, workspaceId: workspace,
      authSession: { id: actor.authSessionId, expiresAt: new Date(actor.authSessionExpiresAt) } }) },
  });
  const real = await access.readAuthorizedMobileMcpSource(actor, source);
  assert.equal(real.result._meta?.onlyApp, 'metadata'); assert.equal(real.input.original, 'input');
  assert.ok(queried.some(params => [actor.userId,actor.sessionId,actor.workspaceId,actor.agentId].every(value => params.includes(value))));
  assert.ok(queried.some(params => params.includes(source.toolCallId)));
  assert.deepEqual(await access.requireMobileMcpActor(new NextRequest(origin), actor.sessionId), actor);
  const saved = message;
  message = null; await assert.rejects(access.readAuthorizedMobileMcpSource(actor, source), { status: 425, code: 'MCP_SOURCE_NOT_SAVED' });
  for (const failure of [ { ...(saved as object), isError: true }, { ...(saved as object), details: { ...(saved as { details: object }).details, error: 'failed' } },
    { ...(saved as object), details: { ...(saved as { details: object }).details, result: { content: [], isError: true } } },
    { ...(saved as object), details: { ...(saved as { details: object }).details, mcpApp: { ...app, toolName: 'forged' } } } ]) {
    message = failure; await assert.rejects(access.readAuthorizedMobileMcpSource(actor, source), { status: 403 });
  }
  message = saved; workspace = 'other'; await assert.rejects(access.readAuthorizedMobileMcpSource(actor, source), { status: 403 }); workspace = actor.workspaceId;
  owned = false; await assert.rejects(access.readAuthorizedMobileMcpSource(actor, source), { status: 403 }); owned = true;
  auth = false; await assert.rejects(access.readAuthorizedMobileMcpSource(actor, source), { status: 401 }); auth = true;
  const originalClock = Date.now, readsBeforeExpiry = connectionReads;
  authReadDelay = async () => { Date.now = () => actor.authSessionExpiresAt + 1; };
  try { await assert.rejects(access.readAuthorizedMobileMcpSource(actor, source), { status: 401, code: 'UNAUTHORIZED' }); }
  finally { Date.now = originalClock; authReadDelay = null; }
  assert.equal(connectionReads, readsBeforeExpiry, 'A session expiring during its read denies before connection I/O.');
  const mutableActor = { ...actor }, mutableSource = { ...source, app: { ...app } };
  authReadDelay = async () => { mutableActor.userId = 'replacement'; mutableSource.app.toolName = 'forged'; };
  try { assert.equal((await access.readAuthorizedMobileMcpSource(mutableActor, mutableSource)).input.original, 'input'); }
  finally { authReadDelay = null; }
  const actualSandbox = await load<typeof import('../app/lib/mcp/apps-host')>('app/lib/mcp/apps-host.ts', {
    '@/app/lib/db': {}, '@/app/lib/agents/access': {}, '@/app/lib/pi/session-workspace-context': {}, '@/app/lib/mcp/access': {},
    '@/app/lib/mcp/manager': {}, '@/app/lib/tool-apps/builtin-access': {}, '@/app/lib/tool-apps/registry': {},
  });
  const tickets = await load<typeof import('../app/lib/mcp/mobile-app-tickets')>('app/lib/mcp/mobile-app-tickets.ts', {
    './access': { McpAccessError: AccessError, assertMcpConnectionAccess: async () => ({ connection: { authVersion: currentVersion, configRevision } }) },
    './apps-config': { isMcpAppsEnabled: () => enabled, mcpAppOrigins: () => ({ appOrigin: origin, frameOrigin }),
      isMcpAppFrameHost: (host: string) => host === 'preview.example' },
    './apps-host': actualSandbox, './manager': { hashMcpServerConfig: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      readMcpAppResource: async () => ({ contents: [{ uri: app.resourceUri, mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><button>provider</button>' }] }) },
    './env-runtime': { readMcpAvailableEnvSnapshot: async () => {
      await environmentReadDelay?.(); return { values: {}, revision: `fixture-env:${environmentRevision}` };
    } },
    '@/app/lib/mobile/mcp-apps-access': access, '@/app/lib/mobile/mcp-apps-contracts': contracts,
  });
  const render = await tickets.issueMobileMcpAppTicket(actor, source), token = render.host.url.split('/')[4];
  const returnedChannel = await tickets.requireMobileMcpAppChannel(actor, source, render.host.channelId);
  returnedChannel.actor.userId = 'forged'; returnedChannel.source.app.toolName = 'forged'; returnedChannel.input.original = 'forged';
  const unchangedChannel = await tickets.requireMobileMcpAppChannel(actor, source, render.host.channelId);
  assert.equal(unchangedChannel.actor.userId, actor.userId); assert.equal(unchangedChannel.source.app.toolName, app.toolName);
  assert.equal(unchangedChannel.input.original, 'input', 'Returned channel data does not mutate the stored ticket.');
  assert.equal(render.host.origin, origin); assert.equal(render.host.frameOrigin, frameOrigin); assert.equal(render.host.nonce.length, 43);
  const deliver = (mode: string, host = mode === 'host' ? 'instance.example' : 'preview.example') => tickets.deliverMobileMcpAppTicket(new Request(`${origin}/__preview/${token}/mobile-mcp/${mode}`, { headers: { host } }), token, mode);
  const host = await deliver('host'); assert.equal(host.status, 200); assert.match(host.headers.get('content-security-policy')!, /frame-ancestors 'none'/u);
  assert.match(host.headers.get('content-security-policy')!, /connect-src 'none'/u);
  assert.match(await host.text(), /onlyApp/u);
  const frame = await deliver('frame'); assert.equal(frame.status, 200);
  const relay = await frame.text(); assert.match(relay, /event\.source===parent&&event\.origin===config\.canvasOrigin/u);
  assert.match(relay, /event\.origin==='null'/u); assert.doesNotMatch(relay, new RegExp(render.host.nonce, 'u'));
  const document = await deliver('document'); assert.equal(document.status, 200); assert.match(document.headers.get('content-security-policy')!, /sandbox allow-scripts$/u);
  assert.equal((await deliver('host','preview.example')).status, 404); assert.equal((await deliver('frame','instance.example')).status, 404);
  currentVersion++; assert.equal((await deliver('document')).status, 404); currentVersion--;
  configRevision++; assert.equal((await deliver('host')).status, 404); configRevision--;
  environmentRevision++; assert.equal((await deliver('host')).status, 404, 'Credential environment revision changes expire an issued ticket.'); environmentRevision--;
  auth = false; assert.equal((await deliver('host')).status, 404); auth = true;
  message = null; assert.equal((await deliver('host')).status, 404); message = saved;
  enabled = false; assert.equal((await deliver('host')).status, 404); enabled = true;
  for (let i = 0; i < 8; i++) await tickets.issueMobileMcpAppTicket(actor, source);
  assert.equal((await deliver('host')).status, 404, 'Old per-user ticket is evicted.');
  const fresh = await tickets.issueMobileMcpAppTicket(actor, source);
  tickets.invalidateMobileMcpAppTickets({ userId: actor.userId, connectionId: app.connectionId });
  assert.equal((await tickets.deliverMobileMcpAppTicket(new Request(fresh.host.url, { headers: { host: 'instance.example' } }), fresh.host.url.split('/')[4], 'host')).status, 404);
  const invalidatedDuringRead = await tickets.issueMobileMcpAppTicket(actor, source);
  environmentReadDelay = async () => { tickets.invalidateMobileMcpAppTickets({ userId: actor.userId, connectionId: app.connectionId }); };
  try { await assert.rejects(tickets.requireMobileMcpAppChannel(actor, source, invalidatedDuringRead.host.channelId), { code: 'MCP_HOST_EXPIRED' }); }
  finally { environmentReadDelay = null; }
  let status = 0;
  const response = { writeHead: (value: number) => { status = value; }, end: () => undefined } as unknown as ServerResponse;
  const request = { url: `/__preview/${'a'.repeat(43)}/mobile-mcp/host`, method: 'GET', headers: {
    host: 'instance.example', cookie: 'private', authorization: 'private', 'proxy-authorization': 'private', 'x-canvas-workspace-id': 'private' } } as unknown as IncomingMessage;
  assert.equal(handleHtmlPreviewBoundary(request,response), false); assert.deepEqual(request.headers,{host:'instance.example'});
  request.method = 'POST'; assert.equal(handleHtmlPreviewBoundary(request,response), true); assert.equal(status,404);
  assert.throws(() => contracts.readMobileMcpRender({ contractVersion: 1, ...source, html: '<script>bad</script>' }));
  assert.throws(() => contracts.readMobileMcpApp({ ...app, token: 'private' }));
  assert.throws(() => contracts.readMobileMcpRender({ contractVersion: 1, toolCallId: source.toolCallId,
    app: { version: 2, connectionRef: `canvas-connection:${app.connectionId}`, toolCallId: source.toolCallId,
      toolName: app.toolName, resourceUri: app.resourceUri, bindingRevision: 'a'.repeat(64) } }), { status: 400 });
  assert.throws(() => contracts.readMobileMcpResult({ content: Array.from({ length: 1001 }, () => ({ type: 'text', text: '' })) }), { code: 'MCP_SOURCE_INVALID' });
  assert.throws(() => contracts.readMobileMcpApp({ ...app, toolName: 'bad\nname' }));
  console.log('Mobile MCP contracts: actual parser/saved-receipt logic with controlled Auth/source seams, personal-v1-only, fresh expiry, cloned tickets, bounded host/origin/CSP and revocation passed; no native/Bearer acceptance claim.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
