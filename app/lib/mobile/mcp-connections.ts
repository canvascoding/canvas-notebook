import 'server-only';

import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/app/lib/db';
import { normalizeDatabaseTimestamp } from '@/app/lib/db/timestamps';
import { assertMcpConnectionAccess, requireMcpUserAccess, type McpActor } from '@/app/lib/mcp/access';
import { hashMcpAuthConfig } from '@/app/lib/mcp/connection-identity';
import { closeMcpServer, getMcpRuntimeStatus, listMcpTools } from '@/app/lib/mcp/manager';
import { getMcpOAuthStatus } from '@/app/lib/mcp/oauth';
import type { McpServerConfig } from '@/app/lib/mcp/config';
import { requireRequestWorkspace, requireSessionWorkspace, type RequestWorkspaceSession } from '@/app/lib/workspaces/request';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { mobileFileReviewWorkspaceId, readMobileFileReviewJson } from './file-review-route';

export const MOBILE_MCP_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Cookie, X-Canvas-Workspace-Id', 'X-Content-Type-Options': 'nosniff' };
export const MOBILE_MCP_CONNECTION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export type MobileMcpContext = { userId: string; authSessionId: string; workspaceId: string; actor: McpActor };
const contextProofs = new WeakMap<MobileMcpContext, { session: RequestWorkspaceSession; userId: string; authSessionId: string; workspaceId: string; organizationId: string | null }>();
export class MobileMcpError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
export function mobileMcpResponse(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) throw new MobileMcpError('RESPONSE_TOO_LARGE', 'The connection response is too large.', 413);
  return NextResponse.json({ success: true, contractVersion: 1, ...value as Record<string, unknown> }, { headers: MOBILE_MCP_HEADERS });
}
export function mobileMcpErrorResponse(error: unknown) {
  const status = (error as { status?: unknown })?.status;
  const safeStatus = typeof status === 'number' && status >= 400 && status <= 599 ? status : 500;
  const code = (error as { code?: unknown })?.code;
  return NextResponse.json({ success: false, contractVersion: 1,
    code: typeof code === 'string' && /^[A-Za-z0-9_]{1,100}$/u.test(code) ? code : 'MCP_UNAVAILABLE',
    error: error instanceof MobileMcpError ? error.message : 'The MCP connection is unavailable.' },
  { status: safeStatus, headers: MOBILE_MCP_HEADERS });
}
async function assertMobileMcpSession(context: MobileMcpContext): Promise<void> {
  const proof = contextProofs.get(context);
  if (!proof || proof.userId !== context.userId || proof.authSessionId !== context.authSessionId
    || proof.workspaceId !== context.workspaceId || context.actor.userId !== proof.userId) {
    throw new MobileMcpError('UNAUTHORIZED', 'An authenticated matching session is required.', 401);
  }
  const database = await openDb();
  try {
    const row = await database.get('SELECT s.user_id,s.expires_at,u.banned FROM "session" s JOIN "user" u ON u.id=s.user_id WHERE s.id=$1',
      [proof.authSessionId]) as { user_id?: unknown; expires_at?: unknown; banned?: unknown } | undefined;
    const expiry = normalizeDatabaseTimestamp(Number(row?.expires_at));
    if (!row || row.user_id !== proof.userId || !Number.isFinite(expiry) || expiry <= Date.now()
      || row.banned === true || Number(row.banned) === 1) {
      throw new MobileMcpError('UNAUTHORIZED', 'The original authenticated session is unavailable.', 401);
    }
  } finally { await database.close(); }
}
/** Reuses current workspace and MCP authority; a serialized context grants nothing. */
export async function revalidateMobileMcpContext(context: MobileMcpContext): Promise<McpActor> {
  await assertMobileMcpSession(context);
  const proof = contextProofs.get(context)!;
  const authorized = await requireSessionWorkspace(proof.session, { workspaceId: proof.workspaceId, permissions: 'canRead' });
  if (authorized.response || authorized.workspace.workspaceId !== proof.workspaceId
    || (authorized.workspace.status ?? 'active') !== 'active') {
    throw new MobileMcpError('WORKSPACE_UNAVAILABLE', 'The active workspace is unavailable.', authorized.response?.status ?? 403);
  }
  const actor = await requireMcpUserAccess({ userId: proof.userId });
  if (!actor || actor.userId !== proof.userId || actor.organizationId !== proof.organizationId) {
    throw new MobileMcpError('UNAUTHORIZED', 'The original MCP account context is unavailable.', 403);
  }
  await assertMobileMcpSession(context);
  return actor;
}
export async function requireMobileMcpContext(request: NextRequest): Promise<MobileMcpContext> {
  const workspaceId = mobileFileReviewWorkspaceId(request);
  const query = request.nextUrl.searchParams;
  if ([...query.keys()].some(key => key !== 'workspaceId') || query.getAll('workspaceId').length > 1
    || query.has('workspaceId') && query.get('workspaceId') !== workspaceId) {
    throw new MobileMcpError('INVALID_REQUEST', 'The workspace request is invalid.', 400);
  }
  const authorized = await requireRequestWorkspace(request, { workspaceId, permissions: 'canRead' });
  if (authorized.response) throw new MobileMcpError(authorized.response.status === 401 ? 'UNAUTHORIZED' : 'WORKSPACE_UNAVAILABLE', 'The active workspace is unavailable.', authorized.response.status);
  if (authorized.workspace.workspaceId !== workspaceId || (authorized.workspace.status ?? 'active') !== 'active') throw new MobileMcpError('WORKSPACE_UNAVAILABLE', 'The active workspace is unavailable.', 403);
  const authSessionId = authorized.session.session.id;
  if (typeof authSessionId !== 'string' || !authSessionId || authSessionId.length > 200) throw new MobileMcpError('UNAUTHORIZED', 'An authenticated session is required.', 401);
  const actor = await requireMcpUserAccess({ userId: authorized.session.user.id });
  if (!actor) throw new MobileMcpError('UNAUTHORIZED', 'An authenticated MCP account is required.', 401);
  const limited = rateLimit(request, { limit: request.method === 'GET' ? 90 : 30, windowMs: 60_000,
    keyPrefix: `mobile-mcp-${request.method}`, verifiedUserId: actor.userId });
  if (!limited.ok) throw new MobileMcpError('RATE_LIMITED', 'Please wait before trying again.', 429);
  const context = Object.freeze({ userId: actor.userId, authSessionId, workspaceId, actor: Object.freeze(actor) });
  contextProofs.set(context, { session: authorized.session, userId: actor.userId, authSessionId, workspaceId, organizationId: actor.organizationId });
  await revalidateMobileMcpContext(context);
  return context;
}
export async function readMobileMcpJson(request: Request, keys: string[]) {
  const body = await readMobileFileReviewJson(request, 16 * 1024);
  if (body.contractVersion !== 1 || Object.keys(body).some(key => !['contractVersion', ...keys].includes(key))) throw new MobileMcpError('INVALID_REQUEST', 'The connection request is invalid.', 400);
  return body;
}
export async function requireMobileMcpConnection(context: MobileMcpContext, connectionId: string, allowDisabled = false) {
  if (!MOBILE_MCP_CONNECTION_ID.test(connectionId)) throw new MobileMcpError('MCP_CONNECTION_NOT_FOUND', 'The connection is unavailable.', 404);
  const actor = await revalidateMobileMcpContext(context);
  const selected = await assertMcpConnectionAccess(connectionId, { userId: context.userId }, { allowDisabled, actor });
  if (selected.connection.connectionId !== connectionId || selected.connection.ownerUserId !== context.userId) throw new MobileMcpError('MCP_CONNECTION_NOT_FOUND', 'The connection is unavailable.', 404);
  await revalidateMobileMcpContext(context);
  return selected;
}
export function mobileMcpConnectionRevision(connection: McpServerConfig) {
  return createHash('sha256').update(JSON.stringify([connection.connectionId, connection.ownerUserId,
    connection.organizationId ?? null, connection.authVersion ?? 1, connection.enabled !== false, hashMcpAuthConfig(connection)])).digest('hex');
}
export async function readMobileMcpConnections(context: MobileMcpContext, connectionId?: string) {
  if (connectionId && !MOBILE_MCP_CONNECTION_ID.test(connectionId)) throw new MobileMcpError('MCP_CONNECTION_NOT_FOUND', 'The connection is unavailable.', 404);
  await revalidateMobileMcpContext(context);
  const runtime = await getMcpRuntimeStatus(connectionId, { userId: context.userId });
  if (runtime.servers.length > 100) throw new MobileMcpError('RESPONSE_TOO_LARGE', 'Too many connections are available for this view.', 413);
  const connections = await Promise.all(runtime.servers.map(async entry => {
    if (!entry.connectionId || !MOBILE_MCP_CONNECTION_ID.test(entry.connectionId)) throw new MobileMcpError('INVALID_CONNECTION', 'The connection could not be verified.', 502);
    const selected = entry.accessAllowed ? await requireMobileMcpConnection(context, entry.connectionId, true) : null;
    const oauth = selected ? await getMcpOAuthStatus(entry.connectionId, undefined, { userId: context.userId }) : null;
    return { connectionId: entry.connectionId, displayName: entry.displayName.slice(0, 200), enabled: entry.enabled,
      accessAllowed: entry.accessAllowed, connected: entry.connected, transport: entry.transport,
      revision: selected ? mobileMcpConnectionRevision(selected.connection) : null,
      authVersion: selected?.connection.authVersion ?? 1, requiresAuth: oauth?.requiresAuth ?? false,
      authStatus: oauth?.authStatus ?? 'not_authorized', reachability: entry.health?.reachability ?? 'unknown',
      lastErrorCode: entry.health?.lastErrorCode ?? (entry.accessAllowed ? null : 'MCP_ACCESS_DENIED'),
      lastCheckedAt: entry.health?.lastCheckedAt ?? null, cachedToolCount: entry.cachedToolCount,
      allowedActions: selected && entry.enabled ? ['test', 'reconnect', ...(oauth?.requiresAuth ? ['authorize'] : [])] : [],
    };
  }));
  for (const entry of connections) if (entry.revision) {
    const current = await requireMobileMcpConnection(context, entry.connectionId, true);
    if (mobileMcpConnectionRevision(current.connection) !== entry.revision) throw new MobileMcpError('MCP_CONNECTION_CHANGED', 'The connection changed. Reload its current state.', 409);
  }
  await revalidateMobileMcpContext(context);
  if (connectionId && (connections.length !== 1 || connections[0].connectionId !== connectionId)) throw new MobileMcpError('MCP_CONNECTION_NOT_FOUND', 'The connection is unavailable.', 404);
  return { workspaceId: context.workspaceId, checkedAt: Date.now(), connections };
}
/** Explicit user action lists tools only; it never invokes an MCP business tool. */
export async function testMobileMcpConnection(context: MobileMcpContext, connectionId: string, input: { action: unknown; revision: unknown }) {
  if (input.action !== 'test' && input.action !== 'reconnect') throw new MobileMcpError('INVALID_REQUEST', 'Choose a connection action.', 400);
  const selected = await requireMobileMcpConnection(context, connectionId);
  if (input.revision !== mobileMcpConnectionRevision(selected.connection)) throw new MobileMcpError('MCP_CONNECTION_CHANGED', 'The connection changed. Reload its current state.', 409);
  if (input.action === 'reconnect') await closeMcpServer(connectionId, { userId: context.userId });
  const tools = await listMcpTools(connectionId, { scope: { userId: context.userId } });
  const current = await requireMobileMcpConnection(context, connectionId);
  if (mobileMcpConnectionRevision(current.connection) !== input.revision) throw new MobileMcpError('MCP_CONNECTION_CHANGED', 'The connection changed. Reload its current state.', 409);
  return { ...await readMobileMcpConnections(context, connectionId), toolCount: tools.length };
}
