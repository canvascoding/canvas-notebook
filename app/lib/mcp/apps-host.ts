import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piSessions, session as authSessions } from '@/app/lib/db/schema';
import { requireAgentAccess } from '@/app/lib/agents/access';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { assertMcpConnectionAccess, McpAccessError } from '@/app/lib/mcp/access';
import { isMcpAppFrameHost, isMcpAppsEnabled, mcpAppOrigins } from '@/app/lib/mcp/apps-config';
import { isMcpAppResourceMimeType } from '@/app/lib/mcp/apps-metadata';
import { readMcpAppResource } from '@/app/lib/mcp/manager';
import type { McpAppInvocationDetails } from '@/app/lib/mcp/apps-types';
import type { BuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';
import { requireBuiltinToolAppAccess } from '@/app/lib/tool-apps/builtin-access';
import { readBuiltinToolAppResource } from '@/app/lib/tool-apps/registry';
import { readMcpAppDescriptor } from './apps-contracts';
import type { SharedMcpAppDescriptor } from './apps-types';
import { schemaFingerprint } from '@/app/lib/integration-tools/schema';

type AppDescriptor = McpAppInvocationDetails['mcpApp'];
export type McpAppChat = { userId: string; sessionId: string; agentId: string };
type AppTicket = McpAppChat & {
  authSessionId: string;
  app: AppDescriptor | BuiltinToolAppDescriptor;
  authVersion?: number;
  workspaceId: string;
  html: string;
  expiresAt: number;
};

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const TICKET_TTL_MS = 5 * 60 * 1000;
const MAX_TICKETS = 32;
const MAX_USER_TICKETS = 8;
const runtime = globalThis as typeof globalThis & { __canvasMcpAppTickets?: Map<string, AppTicket> };
function tickets() { return runtime.__canvasMcpAppTickets ??= new Map(); }
function ticketHash(value: string) { return createHash('sha256').update(value).digest('hex'); }

export function parseMcpAppDescriptor(value: unknown): AppDescriptor {
  const app = readMcpAppDescriptor(value);
  if (!app) throw new McpAccessError('Invalid MCP app reference.', 400);
  return app;
}

export async function requireMcpAppChatAccess(input: McpAppChat): Promise<string> {
  if (!input.sessionId || input.sessionId.length > 200 || !input.agentId || input.agentId.length > 200) {
    throw new McpAccessError('An owned chat is required for MCP apps.', 403);
  }
  const session = await db.query.piSessions.findFirst({ where: and(
    eq(piSessions.sessionId, input.sessionId), eq(piSessions.userId, input.userId), eq(piSessions.agentId, input.agentId),
    isNull(piSessions.archivedAt),
  ) });
  if (!session) throw new McpAccessError('Chat is unavailable.', 403);
  try {
    const workspace = await resolveAgentSessionWorkspaceForUser({
      userId: input.userId, workspaceId: session.workspaceId, permissions: ['canRead', 'canRunAgent'],
    });
    await requireAgentAccess(input.userId, input.agentId, 'canUse', {
      workspaceId: workspace.workspaceId, organizationId: workspace.organizationId, projectId: workspace.projectId,
    });
    return workspace.workspaceId;
  } catch {
    throw new McpAccessError('Chat workspace access is unavailable.', 403);
  }
}

export async function issueMcpAppTicket(input: McpAppChat & {
  authSessionId: string; authSessionExpiresAt: Date | string; app: AppDescriptor; signal?: AbortSignal;
}) {
  if (!isMcpAppsEnabled()) throw new McpAccessError('MCP apps are disabled.', 404);
  if (input.app.version === 2) {
    const { requireSharedMcpAppAccess } = await import('./apps-shared-access');
    const app = input.app;
    await requireMcpAppAuthSession(input);
    const access = await requireSharedMcpAppAccess(input, app, undefined, input.signal);
    const beforeDispatch = async () => {
      await requireMcpAppAuthSession(input);
      await requireSharedMcpAppAccess(input, app, undefined, input.signal);
    };
    const resource = await readMcpAppResource(access.connectionId, app.toolName, app.resourceUri, access.scope,
      { beforeDispatch, expectedEnvironmentRevision: access.environmentRevision, signal: input.signal });
    const content = resource.contents.find(item => item.uri === app.resourceUri && isMcpAppResourceMimeType(item.mimeType));
    if (!content || !('text' in content) || typeof content.text !== 'string' || Buffer.byteLength(content.text) > MAX_HTML_BYTES) {
      throw new McpAccessError('The app does not provide a supported, bounded HTML resource.', 422);
    }
    await beforeDispatch();
    return storeAppTicket({ ...input, workspaceId: access.workspaceId, html: content.text });
  }
  const workspaceId = await requireMcpAppChatAccess(input);
  const scope = { userId: input.userId };
  const { connection } = await assertMcpConnectionAccess(input.app.connectionId, scope);
  const resource = await readMcpAppResource(input.app.connectionId, input.app.toolName, input.app.resourceUri, scope);
  const content = resource.contents.find((item) => item.uri === input.app.resourceUri && isMcpAppResourceMimeType(item.mimeType));
  if (!content || !('text' in content) || typeof content.text !== 'string' || Buffer.byteLength(content.text) > MAX_HTML_BYTES) {
    throw new McpAccessError('The app does not provide a supported, bounded HTML resource.', 422);
  }
  return storeAppTicket({ ...input, workspaceId, html: content.text, authVersion: connection.authVersion ?? 1 });
}

export async function issueBuiltinToolAppTicket(input: McpAppChat & {
  authSessionId: string; authSessionExpiresAt: Date | string; app: BuiltinToolAppDescriptor;
}) {
  if (!isMcpAppsEnabled()) throw new McpAccessError('Widgets are disabled.', 404);
  const workspaceId = await requireMcpAppChatAccess(input);
  const data = await requireBuiltinToolAppAccess(input, input.app);
  const html = await readBuiltinToolAppResource(input.app);
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new McpAccessError('Widget is too large.', 422);
  return { ...storeAppTicket({ ...input, workspaceId, html }),
    result: { content: [], structuredContent: data } };
}

function storeAppTicket(input: Omit<AppTicket, 'expiresAt'> & { authSessionExpiresAt: Date | string }) {
  const now = Date.now();
  const expiresAt = Math.min(now + TICKET_TTL_MS, new Date(input.authSessionExpiresAt).getTime());
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new McpAccessError('Sign in again.', 401);
  for (const [key, record] of tickets()) if (record.expiresAt <= now) tickets().delete(key);
  const owned = [...tickets()].filter(([, record]) => record.userId === input.userId);
  if (owned.length >= MAX_USER_TICKETS) tickets().delete(owned[0][0]);
  if (tickets().size >= MAX_TICKETS) tickets().delete(tickets().keys().next().value!);
  const ticket = randomBytes(32).toString('base64url');
  tickets().set(ticketHash(ticket), {
    userId: input.userId, sessionId: input.sessionId, agentId: input.agentId,
    authSessionId: input.authSessionId, app: structuredClone(input.app), workspaceId: input.workspaceId,
    authVersion: input.authVersion, html: input.html, expiresAt,
  });
  const { frameOrigin } = mcpAppOrigins();
  return { frameUrl: `${frameOrigin}/__preview/${ticket}/mcp-app/frame`, frameOrigin };
}

async function resolveMcpAppTicket(ticket: string): Promise<AppTicket | null> {
  if (!isMcpAppsEnabled() || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) return null;
  const record = tickets().get(ticketHash(ticket));
  if (!record || record.expiresAt <= Date.now()) {
    tickets().delete(ticketHash(ticket));
    return null;
  }
  await requireMcpAppAuthSession(record);
  if (await requireMcpAppChatAccess(record) !== record.workspaceId) return null;
  if ('kind' in record.app) {
    await requireBuiltinToolAppAccess(record, record.app);
  } else if (record.app.version === 2) {
    const { requireSharedMcpAppAccess } = await import('./apps-shared-access');
    if ((await requireSharedMcpAppAccess(record, record.app)).workspaceId !== record.workspaceId) return null;
  } else {
    const { connection } = await assertMcpConnectionAccess(record.app.connectionId, { userId: record.userId });
    if (connection.authVersion !== record.authVersion) return null;
  }
  if (record.expiresAt <= Date.now()) return null;
  await requireMcpAppAuthSession(record);
  if (record.expiresAt <= Date.now()) return null;
  return record;
}

async function requireMcpAppAuthSession(input: { userId: string; authSessionId: string }): Promise<void> {
  const session = await db.query.session.findFirst({ where: and(eq(authSessions.id, input.authSessionId),
    eq(authSessions.userId, input.userId), gt(authSessions.expiresAt, new Date())) });
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()
    || !Number.isFinite(new Date(session.expiresAt).getTime())) throw new McpAccessError('Sign in again.', 401);
}

/** A shared app action belongs to the exact issued frame and original authenticated session. */
export async function requireSharedMcpAppCallTicket(input: McpAppChat & {
  authSessionId: string; app: SharedMcpAppDescriptor; ticket: unknown;
}, targetToolName: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (typeof input.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(input.ticket)) throw new McpAccessError('Reload the app before using it.', 403);
  const issued = tickets().get(ticketHash(input.ticket));
  // Check the current HTTP actor/session before resolving another actor's
  // ticket, including any workflow readiness provider metadata it may require.
  if (!issued || issued.userId !== input.userId || issued.sessionId !== input.sessionId || issued.agentId !== input.agentId
    || issued.authSessionId !== input.authSessionId || schemaFingerprint(issued.app) !== schemaFingerprint(input.app)) {
    throw new McpAccessError('This app frame is no longer available in the current session.', 403);
  }
  const record = await resolveMcpAppTicket(input.ticket);
  if (!record || record !== issued) throw new McpAccessError('This app frame is no longer available in the current session.', 403);
  const { requireSharedMcpAppAccess } = await import('./apps-shared-access');
  const access = await requireSharedMcpAppAccess(input, input.app, targetToolName, signal);
  await requireMcpAppAuthSession(input);
  signal?.throwIfAborted();
  if (record.expiresAt <= Date.now()) throw new McpAccessError('Reload the app before using it.', 403);
  return access;
}

const privateHeaders = {
  'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Frame-Options': '',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
};

/** Trusted Canvas relay; the provider app itself has an opaque sandbox origin. */
export function buildMcpAppSandboxDocument(canvasOrigin: string, documentPath: string, nonce: string): string {
  // This relay is trusted Canvas code. Its parent is the Canvas page, so
  // incoming parent messages and replies are intentionally bound to Canvas's
  // application origin. The nested app document below has an opaque origin.
  const config = JSON.stringify({ canvasOrigin, documentPath }).replace(/</gu, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style nonce="${nonce}">html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style></head><body><script nonce="${nonce}">
  const config=${config};
  const frame=document.createElement('iframe');
  frame.sandbox='allow-scripts'; frame.referrerPolicy='no-referrer'; frame.title='MCP app content';
  const valid=(value)=>{try{return value&&typeof value==='object'&&!Array.isArray(value)&&value.jsonrpc==='2.0'&&JSON.stringify(value).length<=2097152;}catch{return false;}};
  window.addEventListener('message',(event)=>{
    if(!valid(event.data))return;
    if(event.source===parent&&event.origin===config.canvasOrigin)frame.contentWindow?.postMessage(event.data,'*');
    else if(event.source===frame.contentWindow&&event.origin==='null')parent.postMessage(event.data,config.canvasOrigin);
  });
  frame.src=config.documentPath;document.body.append(frame);
  parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}},config.canvasOrigin);
  </script></body></html>`;
}

export async function deliverMcpAppTicket(request: Request, ticket: string, mode: string): Promise<Response> {
  const unavailable = () => new Response(null, { status: 404, headers: privateHeaders });
  if (!isMcpAppFrameHost(request.headers.get('host')) || !['frame', 'document'].includes(mode)) return unavailable();
  try {
    const record = await resolveMcpAppTicket(ticket);
    if (!record) return unavailable();
    const { appOrigin, frameOrigin } = mcpAppOrigins();
    const frameAncestors = [...new Set([appOrigin, frameOrigin])].join(' ');
    const nonce = randomBytes(18).toString('base64');
    const csp = mode === 'frame'
      ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${appOrigin}; sandbox allow-scripts allow-same-origin`
      : `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${frameAncestors}; sandbox allow-scripts`;
    const body = mode === 'frame'
      ? buildMcpAppSandboxDocument(appOrigin, `/__preview/${ticket}/mcp-app/document`, nonce) : record.html;
    return new Response(body, { headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp } });
  } catch { return unavailable(); }
}
