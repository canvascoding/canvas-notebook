import 'server-only';
import { randomUUID } from 'node:crypto';
import { McpAccessError, assertMcpConnectionAccess } from './access';
import { callMcpAppTool, hashMcpServerConfig, readMcpAppCallMetadata, type McpAppCallMetadata } from './manager';
import { requireMobileMcpAppChannel } from './mobile-app-tickets';
import { matchesMobileMcpApproval, mobileMcpApprovalToken } from './mobile-app-approval';
import { mobileMcpAppCallStore, presentMobileMcpCall, type MobileMcpCallRecord } from './mobile-app-call-store';
import { mobileMcpDigest, readAuthorizedMobileMcpSource, type MobileMcpActor } from '@/app/lib/mobile/mcp-apps-access';
import { MOBILE_MCP_APPROVAL_TTL, readMobileMcpResult, type MobileMcpPrepare } from '@/app/lib/mobile/mcp-apps-contracts';

function metadataDigest(metadata: McpAppCallMetadata) { return mobileMcpDigest(JSON.parse(JSON.stringify(metadata))); }
async function authorizeRecord(actor: MobileMcpActor, record: MobileMcpCallRecord) {
  const source = await readAuthorizedMobileMcpSource(actor, { toolCallId: record.toolCallId, app: record.app });
  if (source.piSessionDbId !== record.piSessionDbId || source.sourceReceiptDigest !== record.sourceReceiptDigest) {
    throw new McpAccessError('The saved source changed.', 409, 'MCP_SOURCE_INVALID');
  }
  if (source.authVersion !== record.authVersion) throw new McpAccessError('The connection changed.', 409, 'MCP_CONNECTION_CHANGED');
  return source;
}
function response(actor: MobileMcpActor, record: MobileMcpCallRecord | null, approval = false) {
  const checkedAt = Date.now(), call = record ? presentMobileMcpCall(record, checkedAt) : null;
  return { success: true, contractVersion: 1, sessionId: actor.sessionId, workspaceId: actor.workspaceId, checkedAt, call,
    approval: approval && record && call?.status === 'prepared' ? { tool: record.tool, arguments: record.request.arguments,
      expiresAt: record.approvalExpiresAt, token: mobileMcpApprovalToken(record) } : null };
}
export async function prepareMobileMcpAppCall(actor: MobileMcpActor, request: MobileMcpPrepare) {
  const channel = await requireMobileMcpAppChannel(actor, request, request.hostChannelId);
  const source = await readAuthorizedMobileMcpSource(actor, request);
  let metadata: McpAppCallMetadata;
  try { metadata = await readMcpAppCallMetadata(request.app.connectionId, request.app.toolName, request.app.resourceUri, request.tool, { userId: actor.userId }); }
  catch { throw new McpAccessError('This app tool is not currently available.', 409, 'MCP_TOOL_CHANGED'); }
  if (metadata.authVersion !== source.authVersion || metadata.configHash !== channel.configHash) throw new McpAccessError('The connection changed.', 409, 'MCP_CONNECTION_CHANGED');
  const frozenRequest = { ...request, metadataDigest: metadataDigest(metadata), environmentRevision: metadata.environmentRevision };
  const requestDigest = mobileMcpDigest({ actor: { userId: actor.userId, authSessionId: actor.authSessionId,
    workspaceId: actor.workspaceId, sessionId: actor.sessionId, agentId: actor.agentId },
    sourceReceiptDigest: source.sourceReceiptDigest, authVersion: source.authVersion, request: frozenRequest });
  const now = Date.now(), approvalExpiresAt = Math.min(now + MOBILE_MCP_APPROVAL_TTL, channel.expiresAt, actor.authSessionExpiresAt);
  if (approvalExpiresAt <= now) throw new McpAccessError('The widget expired.', 409, 'MCP_HOST_EXPIRED');
  const record: MobileMcpCallRecord = { callId: randomUUID(), requestId: request.requestId, toolCallId: request.toolCallId,
    app: request.app, tool: request.tool, requestDigest, authVersion: source.authVersion, status: 'prepared',
    createdAt: now, updatedAt: now, approvalExpiresAt, executionDeadlineAt: null, executionId: null, actor,
    piSessionDbId: source.piSessionDbId, sourceReceiptDigest: source.sourceReceiptDigest, request: frozenRequest };
  const saved = await mobileMcpAppCallStore.create(record, async () => {
    const current = await requireMobileMcpAppChannel(actor, request, request.hostChannelId);
    if (current.authVersion !== source.authVersion || current.sourceReceiptDigest !== source.sourceReceiptDigest) {
      throw new McpAccessError('The source changed.', 409, 'MCP_SOURCE_INVALID');
    }
  });
  return response(actor, saved, true);
}
export async function readMobileMcpAppCall(actor: MobileMcpActor, id: { callId: string } | { requestId: string }) {
  const record = 'callId' in id ? await mobileMcpAppCallStore.get(actor, id.callId) : await mobileMcpAppCallStore.getByRequestId(actor, id.requestId);
  if (record) await authorizeRecord(actor, record);
  // The authenticated mobile chat is rechecked by the route even when no row exists.
  return response(actor, record);
}
export async function decideMobileMcpAppCall(actor: MobileMcpActor, callId: string, decision: 'approve' | 'reject', token: string) {
  const record = await mobileMcpAppCallStore.get(actor, callId);
  if (!record) throw new McpAccessError('The call is unavailable.', 404, 'MCP_SOURCE_UNAVAILABLE');
  await authorizeRecord(actor, record);
  if (!matchesMobileMcpApproval(record, token)) throw new McpAccessError('The approval is invalid.', 403, 'MCP_APPROVAL_INVALID');
  if (presentMobileMcpCall(record, Date.now()).status !== 'prepared') return response(actor, record);
  const fresh = async (metadata?: McpAppCallMetadata) => {
    await authorizeRecord(actor, record);
    const channel = await requireMobileMcpAppChannel(actor, record.request, record.request.hostChannelId);
    const { connection } = await assertMcpConnectionAccess(record.app.connectionId, { userId: actor.userId });
    if (metadata && (metadata.authVersion !== record.authVersion || metadata.configHash !== channel.configHash
      || hashMcpServerConfig(connection) !== metadata.configHash || metadataDigest(metadata) !== record.request.metadataDigest)) {
      throw new McpAccessError('The app tool or connection changed.', 409, 'MCP_TOOL_CHANGED');
    }
  };
  if (decision === 'reject') {
    const rejected = await mobileMcpAppCallStore.decide(record, decision, () => fresh());
    return response(actor, rejected.record);
  }
  let claimed: MobileMcpCallRecord | null = null, duplicate: MobileMcpCallRecord | null = null, dispatched = false;
  try {
    const rawResult = await callMcpAppTool(record.app.connectionId, record.app.toolName, record.app.resourceUri,
      record.tool, record.request.arguments, undefined, { userId: actor.userId }, {
        beforeDispatch: () => fresh(),
        expectedEnvironmentRevision: record.request.environmentRevision,
        approval: { beforeDispatch: async metadata => {
          const claim = await mobileMcpAppCallStore.decide(record, 'approve', () => fresh(metadata));
          if (!claim.claimed) { duplicate = claim.record; return false; }
          claimed = claim.record;
        }, onDispatch: () => { dispatched = true; } },
      });
    if (duplicate) return response(actor, duplicate);
    if (!claimed) throw new Error('No committed MCP call claim.');
    const result = readMobileMcpResult(rawResult);
    const saved = await mobileMcpAppCallStore.finish(claimed, { status: 'completed', result });
    return response(actor, saved);
  } catch (error) {
    if (duplicate) return response(actor, duplicate);
    if (!claimed) {
      if (error instanceof McpAccessError) throw error;
      throw new McpAccessError('The app tool is unavailable or its approval could not be committed.', 409, 'MCP_TOOL_CHANGED');
    }
    // Once dispatch starts, any transport/timeout/persistence uncertainty stays unknown.
    // Never reconstruct or retry an external action in this catch or in GET status.
    const status = dispatched ? 'unknown' : 'failed';
    try {
      const saved = await mobileMcpAppCallStore.finish(claimed, { status, errorCode: dispatched ? 'MCP_CALL_UNKNOWN' : 'MCP_TOOL_CHANGED' });
      return response(actor, saved);
    } catch {
      const saved = await mobileMcpAppCallStore.get(actor, callId);
      return response(actor, saved ?? claimed);
    }
  }
}
