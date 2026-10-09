import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpAccessError, assertMcpConnectionAccess } from './access';
import { isMcpAppFrameHost, isMcpAppsEnabled, mcpAppOrigins } from './apps-config';
import { buildMcpAppSandboxDocument } from './apps-host';
import { isMcpAppResourceMimeType } from './apps-metadata';
import { hashMcpServerConfig, readMcpAppResource } from './manager';
import { readMcpAvailableEnvSnapshot } from './env-runtime';
import { readAuthorizedMobileMcpSource, type MobileMcpActor } from '@/app/lib/mobile/mcp-apps-access';
import { MOBILE_MCP_RESULT_BYTES, readMobileMcpApp, type MobileMcpSource } from '@/app/lib/mobile/mcp-apps-contracts';

type MobileMcpTicket = {
  actor: MobileMcpActor; source: MobileMcpSource; sourceReceiptDigest: string; authVersion: number; configHash: string; environmentRevision: string;
  channelId: string; nonce: string; expiresAt: number; html: string;
  input: Record<string, unknown>; result: Awaited<ReturnType<typeof readAuthorizedMobileMcpSource>>['result'];
};
const runtime = globalThis as typeof globalThis & { __canvasMobileMcpTickets?: Map<string, MobileMcpTicket> };
const tickets = () => runtime.__canvasMobileMcpTickets ??= new Map();
const hash = (ticket: string) => createHash('sha256').update(ticket).digest('hex');
let bundle: Promise<string> | undefined;
function hostBundle() { return bundle ??= readFile(path.join(process.cwd(), 'public/_canvas-tool-apps/mobile-mcp-host-v1.js'), 'utf8')
  .catch(error => { bundle = undefined; throw error; }); }
function unavailable(): never { throw new McpAccessError('The widget expired. Reload it.', 409, 'MCP_HOST_EXPIRED'); }
function sameActor(a: MobileMcpActor, b: MobileMcpActor) {
  return a.userId === b.userId && a.authSessionId === b.authSessionId && a.workspaceId === b.workspaceId
    && a.sessionId === b.sessionId && a.agentId === b.agentId;
}
export function invalidateMobileMcpAppTickets(input: { userId: string; connectionId: string }): void {
  for (const [key, record] of tickets()) if (record.actor.userId === input.userId && record.source.app.connectionId === input.connectionId) tickets().delete(key);
}
export async function requireMobileMcpAppChannel(actor: MobileMcpActor, source: MobileMcpSource, channelId: string): Promise<MobileMcpTicket> {
  actor = { ...actor };
  source = { toolCallId: source.toolCallId, app: readMobileMcpApp(source.app) };
  const record = [...tickets().values()].find(ticket => ticket.channelId === channelId && sameActor(actor, ticket.actor)
    && ticket.source.toolCallId === source.toolCallId && JSON.stringify(ticket.source.app) === JSON.stringify(source.app));
  if (!record || record.expiresAt <= Date.now() || !isMcpAppsEnabled()) return unavailable();
  const receipt = await readAuthorizedMobileMcpSource(actor, source);
  const { connection } = await assertMcpConnectionAccess(source.app.connectionId, { userId: actor.userId });
  const environment = await readMcpAvailableEnvSnapshot({ userId: actor.userId });
  if (receipt.sourceReceiptDigest !== record.sourceReceiptDigest || receipt.authVersion !== record.authVersion
    || hashMcpServerConfig(connection) !== record.configHash || environment.revision !== record.environmentRevision
    || record.expiresAt <= Date.now() || ![...tickets().values()].includes(record)) return unavailable();
  return { ...record, actor: { ...record.actor }, source: { ...record.source, app: { ...record.source.app } },
    input: JSON.parse(JSON.stringify(record.input)), result: JSON.parse(JSON.stringify(record.result)) };
}
export async function issueMobileMcpAppTicket(actor: MobileMcpActor, source: MobileMcpSource) {
  actor = { ...actor };
  source = { toolCallId: source.toolCallId, app: readMobileMcpApp(source.app) };
  const receipt = await readAuthorizedMobileMcpSource(actor, source);
  const { connection } = await assertMcpConnectionAccess(source.app.connectionId, { userId: actor.userId });
  const configHash = hashMcpServerConfig(connection);
  const environment = await readMcpAvailableEnvSnapshot({ userId: actor.userId });
  const resource = await readMcpAppResource(source.app.connectionId, source.app.toolName, source.app.resourceUri, { userId: actor.userId }, {
    expectedEnvironmentRevision: environment.revision,
    beforeDispatch: async () => { await readAuthorizedMobileMcpSource(actor, source); },
  });
  const content = resource.contents.find(item => item.uri === source.app.resourceUri && isMcpAppResourceMimeType(item.mimeType));
  if (!content || !('text' in content) || typeof content.text !== 'string' || Buffer.byteLength(content.text, 'utf8') > MOBILE_MCP_RESULT_BYTES) {
    throw new McpAccessError('The MCP app does not provide supported HTML.', 422, 'MCP_SOURCE_UNAVAILABLE');
  }
  await hostBundle();
  const current = await readAuthorizedMobileMcpSource(actor, source);
  const fresh = await assertMcpConnectionAccess(source.app.connectionId, { userId: actor.userId });
  const currentEnvironment = await readMcpAvailableEnvSnapshot({ userId: actor.userId });
  if (receipt.sourceReceiptDigest !== current.sourceReceiptDigest || receipt.authVersion !== current.authVersion
    || hashMcpServerConfig(fresh.connection) !== configHash || currentEnvironment.revision !== environment.revision) {
    throw new McpAccessError('The connection changed.', 409, 'MCP_CONNECTION_CHANGED');
  }
  const checkedAt = Date.now(), expiresAt = Math.min(checkedAt + 300_000, actor.authSessionExpiresAt);
  if (expiresAt <= checkedAt) throw new McpAccessError('Sign in again.', 401, 'UNAUTHORIZED');
  for (const [key, record] of tickets()) if (record.expiresAt <= checkedAt) tickets().delete(key);
  const owned = [...tickets()].filter(([, record]) => record.actor.userId === actor.userId);
  if (owned.length >= 8) tickets().delete(owned[0][0]);
  if (tickets().size >= 32) tickets().delete(tickets().keys().next().value!);
  const ticket = randomBytes(32).toString('base64url'), channelId = randomUUID(), nonce = randomBytes(32).toString('base64url');
  tickets().set(hash(ticket), { actor, source, sourceReceiptDigest: receipt.sourceReceiptDigest, authVersion: receipt.authVersion,
    configHash, environmentRevision: environment.revision, channelId, nonce, expiresAt, html: content.text, input: receipt.input, result: receipt.result });
  const { appOrigin, frameOrigin } = mcpAppOrigins();
  return { checkedAt, authVersion: receipt.authVersion,
    host: { url: `${appOrigin}/__preview/${ticket}/mobile-mcp/host`, origin: appOrigin, frameOrigin, channelId, nonce, expiresAt } };
}
const privateHeaders = {
  'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
};
function safeJson(value: unknown) { return JSON.stringify(value).replace(/</gu, '\\u003c'); }
export async function deliverMobileMcpAppTicket(request: Request, ticket: string, mode: string): Promise<Response> {
  const missing = () => new Response(null, { status: 404, headers: privateHeaders });
  if (!/^[A-Za-z0-9_-]{43}$/u.test(ticket) || !['host','frame','document'].includes(mode)) return missing();
  try {
    const { appOrigin, frameOrigin } = mcpAppOrigins();
    const configuredHost = mode === 'host' ? new URL(appOrigin).host : new URL(frameOrigin).host;
    if (request.headers.get('host') !== configuredHost || (mode !== 'host' && !isMcpAppFrameHost(request.headers.get('host')))) return missing();
    const record = tickets().get(hash(ticket));
    if (!record) return missing();
    await requireMobileMcpAppChannel(record.actor, record.source, record.channelId);
    const scriptNonce = randomBytes(18).toString('base64');
    let body: string, csp: string;
    if (mode === 'host') {
      const config = { channelId: record.channelId, nonce: record.nonce, frameOrigin,
        frameUrl: `${frameOrigin}/__preview/${ticket}/mobile-mcp/frame`, input: record.input, result: record.result };
      body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style nonce="${scriptNonce}">html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style></head><body><script nonce="${scriptNonce}">window.__CANVAS_MOBILE_MCP_HOST__=${safeJson(config)};</script><script nonce="${scriptNonce}">${(await hostBundle()).replace(/<\/script/giu, '<\\/script')}</script></body></html>`;
      csp = `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; frame-src ${frameOrigin}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
    } else if (mode === 'frame') {
      body = buildMcpAppSandboxDocument(appOrigin, `/__preview/${ticket}/mobile-mcp/document`, scriptNonce);
      csp = `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${appOrigin}; sandbox allow-scripts allow-same-origin`;
    } else {
      body = record.html;
      csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${[...new Set([appOrigin, frameOrigin])].join(' ')}; sandbox allow-scripts`;
    }
    return new Response(body, { headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp } });
  } catch { return missing(); }
}
