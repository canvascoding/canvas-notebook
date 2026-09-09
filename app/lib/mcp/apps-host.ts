import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piSessions, session as authSessions } from '@/app/lib/db/schema';
import { requireAgentAccess } from '@/app/lib/agents/access';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { htmlPreviewOrigins, isHtmlPreviewHost } from '@/app/lib/html-preview-origin';
import { assertMcpConnectionAccess, McpAccessError } from '@/app/lib/mcp/access';
import { isMcpAppsEnabled } from '@/app/lib/mcp/apps-config';
import { isMcpAppResourceMimeType } from '@/app/lib/mcp/apps-metadata';
import { readMcpAppResource } from '@/app/lib/mcp/manager';
import type { McpAppInvocationDetails } from '@/app/lib/mcp/apps-types';

type AppDescriptor = McpAppInvocationDetails['mcpApp'];
export type McpAppChat = { userId: string; sessionId: string; agentId: string };
type AppTicket = McpAppChat & {
  authSessionId: string;
  app: AppDescriptor;
  authVersion: number;
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
  const app = value as Partial<AppDescriptor> | null;
  if (!app || app.version !== 1 || typeof app.connectionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(app.connectionId)
    || typeof app.toolName !== 'string' || !app.toolName || app.toolName.length > 256
    || typeof app.resourceUri !== 'string' || !/^ui:\/\/[^\s]+$/u.test(app.resourceUri) || app.resourceUri.length > 4096) {
    throw new McpAccessError('Invalid MCP app reference.', 400);
  }
  return { version: 1, connectionId: app.connectionId, toolName: app.toolName, resourceUri: app.resourceUri };
}

export async function requireMcpAppChatAccess(input: McpAppChat): Promise<string> {
  if (!input.sessionId || input.sessionId.length > 200 || !input.agentId || input.agentId.length > 200) {
    throw new McpAccessError('An owned chat is required for MCP apps.', 403);
  }
  const session = await db.query.piSessions.findFirst({ where: and(
    eq(piSessions.sessionId, input.sessionId), eq(piSessions.userId, input.userId), eq(piSessions.agentId, input.agentId),
  ) });
  if (!session) throw new McpAccessError('Chat is unavailable.', 403);
  try {
    await requireAgentAccess(input.userId, input.agentId, 'canUse');
    const workspace = await resolveAgentSessionWorkspaceForUser({
      userId: input.userId, workspaceId: session.workspaceId, permissions: ['canRead', 'canRunAgent'],
    });
    return workspace.workspaceId;
  } catch {
    throw new McpAccessError('Chat workspace access is unavailable.', 403);
  }
}

export async function issueMcpAppTicket(input: McpAppChat & {
  authSessionId: string; authSessionExpiresAt: Date | string; app: AppDescriptor;
}) {
  if (!isMcpAppsEnabled()) throw new McpAccessError('MCP apps are disabled.', 404);
  const workspaceId = await requireMcpAppChatAccess(input);
  const scope = { userId: input.userId };
  const { connection } = await assertMcpConnectionAccess(input.app.connectionId, scope);
  const resource = await readMcpAppResource(input.app.connectionId, input.app.toolName, input.app.resourceUri, scope);
  const content = resource.contents.find((item) => item.uri === input.app.resourceUri && isMcpAppResourceMimeType(item.mimeType));
  if (!content || !('text' in content) || typeof content.text !== 'string' || Buffer.byteLength(content.text) > MAX_HTML_BYTES) {
    throw new McpAccessError('The app does not provide a supported, bounded HTML resource.', 422);
  }
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
    authSessionId: input.authSessionId, app: input.app, workspaceId,
    authVersion: connection.authVersion ?? 1, html: content.text, expiresAt,
  });
  const { previewOrigin } = htmlPreviewOrigins();
  return { frameUrl: `${previewOrigin}/__preview/${ticket}/mcp-app/frame`, frameOrigin: previewOrigin };
}

async function resolveMcpAppTicket(ticket: string): Promise<AppTicket | null> {
  if (!isMcpAppsEnabled() || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) return null;
  const record = tickets().get(ticketHash(ticket));
  if (!record || record.expiresAt <= Date.now()) {
    tickets().delete(ticketHash(ticket));
    return null;
  }
  const session = await db.query.session.findFirst({ where: and(
    eq(authSessions.id, record.authSessionId), eq(authSessions.userId, record.userId), gt(authSessions.expiresAt, new Date()),
  ) });
  if (!session) return null;
  const { connection } = await assertMcpConnectionAccess(record.app.connectionId, { userId: record.userId });
  if (connection.authVersion !== record.authVersion || await requireMcpAppChatAccess(record) !== record.workspaceId) return null;
  return record;
}

const privateHeaders = {
  'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Frame-Options': '',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
};

/** Trusted relay on the preview origin; the app itself has an opaque sandbox origin. */
export function buildMcpAppSandboxDocument(appOrigin: string, documentPath: string, nonce: string): string {
  const config = JSON.stringify({ appOrigin, documentPath }).replace(/</gu, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style nonce="${nonce}">html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style></head><body><script nonce="${nonce}">
  const config=${config};
  const frame=document.createElement('iframe');
  frame.sandbox='allow-scripts'; frame.referrerPolicy='no-referrer'; frame.title='MCP app content';
  const valid=(value)=>{try{return value&&typeof value==='object'&&!Array.isArray(value)&&value.jsonrpc==='2.0'&&JSON.stringify(value).length<=2097152;}catch{return false;}};
  window.addEventListener('message',(event)=>{
    if(!valid(event.data))return;
    if(event.source===parent&&event.origin===config.appOrigin)frame.contentWindow?.postMessage(event.data,'*');
    else if(event.source===frame.contentWindow&&event.origin==='null')parent.postMessage(event.data,config.appOrigin);
  });
  frame.src=config.documentPath;document.body.append(frame);
  parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}},config.appOrigin);
  </script></body></html>`;
}

export async function deliverMcpAppTicket(request: Request, ticket: string, mode: string): Promise<Response> {
  const unavailable = () => new Response(null, { status: 404, headers: privateHeaders });
  if (!isHtmlPreviewHost(request.headers.get('host')) || !['frame', 'document'].includes(mode)) return unavailable();
  try {
    const record = await resolveMcpAppTicket(ticket);
    if (!record) return unavailable();
    const { appOrigin, previewOrigin } = htmlPreviewOrigins();
    const nonce = randomBytes(18).toString('base64');
    const csp = mode === 'frame'
      ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${appOrigin}; sandbox allow-scripts allow-same-origin`
      : `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${appOrigin} ${previewOrigin}; sandbox allow-scripts`;
    const body = mode === 'frame'
      ? buildMcpAppSandboxDocument(appOrigin, `/__preview/${ticket}/mcp-app/document`, nonce) : record.html;
    return new Response(body, { headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp } });
  } catch { return unavailable(); }
}
