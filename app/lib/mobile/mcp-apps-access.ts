import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { db } from '@/app/lib/db';
import { piMessages, piSessions, session as authSessions } from '@/app/lib/db/schema';
import { McpAccessError, assertMcpConnectionAccess } from '@/app/lib/mcp/access';
import { readMcpAvailableEnvSnapshot } from '@/app/lib/mcp/env-runtime';
import { hashMcpServerConfig } from '@/app/lib/mcp/manager';
import type { McpScope } from '@/app/lib/mcp/scope';
import { requireMcpAppChatAccess, type McpAppChat } from '@/app/lib/mcp/apps-host';
import { readToolAppInvocation } from '@/app/lib/tool-apps/types';
import { requireMobileToolAppChat } from './tool-apps-route';
import { isMobileMcpRecord, mobileMcpCanonicalJson, readMobileMcpApp, readMobileMcpResult, MOBILE_MCP_RESULT_BYTES,
  type MobileMcpSource } from './mcp-apps-contracts';

export type MobileMcpActor = McpAppChat & { workspaceId: string; authSessionId: string; authSessionExpiresAt: number };
export type AuthorizedMobileMcpSource = {
  piSessionDbId: number; sourceReceiptDigest: string; input: Record<string, unknown>;
  result: ReturnType<typeof readMobileMcpResult>; authVersion: number;
  connectionId: string; scope: McpScope; configHash: string; environmentRevision: string;
};
export function mobileMcpDigest(value: unknown): string {
  return createHash('sha256').update(mobileMcpCanonicalJson(value)).digest('hex');
}
export async function requireMobileMcpActor(request: NextRequest, sessionId: string): Promise<MobileMcpActor> {
  const { chat, workspaceId, authSession } = await requireMobileToolAppChat(request, sessionId);
  const expiry = new Date(authSession.expiresAt).getTime();
  if (!authSession.id || !Number.isFinite(expiry) || expiry <= Date.now()) throw new McpAccessError('Sign in again.', 401, 'UNAUTHORIZED');
  return { ...chat, workspaceId, authSessionId: authSession.id, authSessionExpiresAt: expiry };
}
export async function readAuthorizedMobileMcpSource(actor: MobileMcpActor, source: MobileMcpSource,
  options: { targetToolName?: string } = {}): Promise<AuthorizedMobileMcpSource> {
  actor = { ...actor };
  options = { ...options };
  source = { toolCallId: source.toolCallId, app: readMobileMcpApp(source.app) };
  const authSession = await db.query.session.findFirst({ where: and(eq(authSessions.id, actor.authSessionId),
    eq(authSessions.userId, actor.userId), gt(authSessions.expiresAt, new Date())) });
  if (!authSession || !Number.isFinite(new Date(authSession.expiresAt).getTime())
    || new Date(authSession.expiresAt).getTime() <= Date.now()) throw new McpAccessError('Sign in again.', 401, 'UNAUTHORIZED');
  if (await requireMcpAppChatAccess(actor) !== actor.workspaceId) throw new McpAccessError('The chat workspace changed.', 403, 'MCP_ACCESS_DENIED');
  const session = await db.query.piSessions.findFirst({ where: and(eq(piSessions.sessionId, actor.sessionId),
    eq(piSessions.userId, actor.userId), eq(piSessions.agentId, actor.agentId), eq(piSessions.workspaceId, actor.workspaceId)) });
  if (!session) throw new McpAccessError('Chat is unavailable.', 403, 'MCP_ACCESS_DENIED');
  const rows = await db.select({ content: piMessages.content }).from(piMessages).where(and(
    eq(piMessages.piSessionDbId, session.id), eq(piMessages.role, 'toolResult'),
    sql`${piMessages.content}::jsonb ->> 'toolCallId' = ${source.toolCallId}`,
  )).orderBy(desc(piMessages.id)).limit(1);
  if (!rows[0]) throw new McpAccessError('The tool result is not saved yet.', 425, 'MCP_SOURCE_NOT_SAVED');
  let input: Record<string, unknown>, result: ReturnType<typeof readMobileMcpResult>;
  try {
    const message: unknown = JSON.parse(rows[0].content);
    if (!isMobileMcpRecord(message) || message.role !== 'toolResult' || message.toolCallId !== source.toolCallId
      || message.isError || message.error || !isMobileMcpRecord(message.details) || message.details.isError || message.details.error) throw new Error('failed');
    const invocation = readToolAppInvocation(message);
    if (!invocation || invocation.kind !== 'mcp' || mobileMcpCanonicalJson(invocation.descriptor) !== mobileMcpCanonicalJson(source.app)
      || !isMobileMcpRecord(invocation.input)) throw new Error('binding');
    input = JSON.parse(mobileMcpCanonicalJson(invocation.input)) as Record<string, unknown>;
    result = readMobileMcpResult(invocation.result);
    if (result.isError || Buffer.byteLength(JSON.stringify({ input, result }), 'utf8') > MOBILE_MCP_RESULT_BYTES) throw new Error('failed');
  } catch {
    throw new McpAccessError('The saved tool result cannot host this app.', 403, 'MCP_SOURCE_INVALID');
  }
  if (new Date(authSession.expiresAt).getTime() <= Date.now()) throw new McpAccessError('Sign in again.', 401, 'UNAUTHORIZED');
  let connectionId: string, scope: McpScope, environmentRevision: string;
  if (source.app.version === 2) {
    if (source.toolCallId !== source.app.toolCallId) throw new McpAccessError('The app source does not match.', 403, 'MCP_SOURCE_INVALID');
    const { requireSharedMcpAppAccess } = await import('@/app/lib/mcp/apps-shared-access');
    const shared = await requireSharedMcpAppAccess(actor, source.app, options.targetToolName);
    if (shared.workspaceId !== actor.workspaceId) throw new McpAccessError('The chat workspace changed.', 403, 'MCP_ACCESS_DENIED');
    connectionId = shared.connectionId; scope = shared.scope; environmentRevision = shared.environmentRevision;
  } else {
    connectionId = source.app.connectionId; scope = { userId: actor.userId };
    environmentRevision = '';
  }
  const { connection } = await assertMcpConnectionAccess(connectionId, scope);
  const environment = await readMcpAvailableEnvSnapshot(scope);
  if (source.app.version === 2 && environment.revision !== environmentRevision) {
    throw new McpAccessError('The connection changed.', 409, 'MCP_CONNECTION_CHANGED');
  }
  environmentRevision = environment.revision;
  const authVersion = connection.authVersion ?? 1;
  if (!Number.isSafeInteger(authVersion) || authVersion < 1) throw new McpAccessError('The connection changed.', 409, 'MCP_CONNECTION_CHANGED');
  const currentAuth = await db.query.session.findFirst({ where: and(eq(authSessions.id, actor.authSessionId),
    eq(authSessions.userId, actor.userId), gt(authSessions.expiresAt, new Date())) });
  if (!currentAuth || !Number.isFinite(new Date(currentAuth.expiresAt).getTime())
    || new Date(currentAuth.expiresAt).getTime() <= Date.now()) throw new McpAccessError('Sign in again.', 401, 'UNAUTHORIZED');
  return { piSessionDbId: session.id, sourceReceiptDigest: mobileMcpDigest({ app: source.app, input, result }), input, result, authVersion,
    connectionId, scope, configHash: hashMcpServerConfig(connection), environmentRevision };
}
