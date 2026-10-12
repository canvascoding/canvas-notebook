import 'server-only';
import { randomUUID } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import { McpAccessError } from './access';
import type { MobileMcpActor } from '@/app/lib/mobile/mcp-apps-access';
import { MOBILE_MCP_EXECUTION_TTL, readMobileMcpResult,
  type MobileMcpCall, type MobileMcpPrepare } from '@/app/lib/mobile/mcp-apps-contracts';

export type MobileMcpCallRecord = Omit<MobileMcpCall, 'status'> & {
  status: Exclude<MobileMcpCall['status'], 'expired'>; actor: MobileMcpActor; piSessionDbId: number;
  sourceReceiptDigest: string; request: MobileMcpPrepare & { metadataDigest: string; environmentRevision: string };
  executionId: string | null; connectionId: string;
};
type Row = Record<string, unknown>;
function decode(row: unknown): MobileMcpCallRecord | null {
  if (!row) return null;
  const r = row as Row, request = JSON.parse(String(r.request_json)) as MobileMcpCallRecord['request'];
  return { callId: String(r.call_id), requestId: String(r.request_id), toolCallId: String(r.source_tool_call_id),
    app: request.app, tool: request.tool, requestDigest: String(r.request_digest), authVersion: Number(r.auth_version), connectionId: String(r.connection_id),
    status: r.status as MobileMcpCallRecord['status'], createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    approvalExpiresAt: Number(r.approval_expires_at), executionDeadlineAt: r.execution_deadline_at === null ? null : Number(r.execution_deadline_at),
    executionId: r.execution_id === null ? null : String(r.execution_id),
    actor: { userId: String(r.actor_user_id), authSessionId: String(r.auth_session_id), workspaceId: String(r.workspace_id),
      sessionId: String(r.session_id), agentId: String(r.agent_id), authSessionExpiresAt: 0 },
    piSessionDbId: Number(r.pi_session_db_id), sourceReceiptDigest: String(r.source_receipt_digest), request,
    ...(r.result_json ? { result: readMobileMcpResult(JSON.parse(String(r.result_json))) } : {}),
    ...(r.error_code ? { errorCode: String(r.error_code) } : {}) };
}
const scopeSql = 'actor_user_id=$1 AND auth_session_id=$2 AND workspace_id=$3 AND session_id=$4 AND agent_id=$5';
function scope(actor: MobileMcpActor) { return [actor.userId, actor.authSessionId, actor.workspaceId, actor.sessionId, actor.agentId]; }
function conflict(): never { throw new McpAccessError('This call identity is already bound to another request.', 409, 'MCP_CALL_CONFLICT'); }
export class MobileMcpAppCallStore {
  constructor(private openConnection: () => Promise<SqlConnection> = openDb) {}
  private async read(where: string, params: unknown[]): Promise<MobileMcpCallRecord | null> {
    const connection = await this.openConnection();
    try { return decode(await connection.get(`SELECT * FROM mobile_mcp_app_calls WHERE ${where}`, params)); }
    finally { await connection.close(); }
  }
  get(actor: MobileMcpActor, callId: string) { return this.read(`${scopeSql} AND call_id=$6`, [...scope(actor), callId]); }
  getByRequestId(actor: MobileMcpActor, requestId: string) { return this.read(`${scopeSql} AND request_id=$6`, [...scope(actor), requestId]); }
  async create(record: MobileMcpCallRecord, beforeInsert: () => Promise<void>): Promise<MobileMcpCallRecord> {
    return executeLifecycleTransaction({ openConnection: this.openConnection,
      execute: async database => {
        await beforeInsert();
        await database.run(`INSERT INTO mobile_mcp_app_calls
          (call_id,actor_user_id,auth_session_id,workspace_id,pi_session_db_id,session_id,agent_id,source_tool_call_id,
           source_receipt_digest,connection_id,auth_version,request_id,request_digest,request_json,status,created_at,updated_at,approval_expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'prepared',$15,$15,$16)
          ON CONFLICT (actor_user_id,request_id) DO NOTHING`, [record.callId, record.actor.userId, record.actor.authSessionId,
          record.actor.workspaceId, record.piSessionDbId, record.actor.sessionId, record.actor.agentId, record.toolCallId,
          record.sourceReceiptDigest, record.connectionId, record.authVersion, record.requestId, record.requestDigest,
          JSON.stringify(record.request), record.createdAt, record.approvalExpiresAt]);
        const current = decode(await database.get('SELECT * FROM mobile_mcp_app_calls WHERE actor_user_id=$1 AND request_id=$2 FOR UPDATE',
          [record.actor.userId, record.requestId]));
        if (!current || current.requestDigest !== record.requestDigest || current.actor.authSessionId !== record.actor.authSessionId
          || current.actor.workspaceId !== record.actor.workspaceId || current.actor.sessionId !== record.actor.sessionId) return conflict();
        return current;
      }, recoverCommitted: async value => {
        const saved = await this.get(record.actor, value.callId);
        if (!saved || saved.requestDigest !== record.requestDigest) throw new Error('MCP preparation commit is unconfirmed.');
        return saved;
      } });
  }
  /** The returned unique execution identity is durable proof before external dispatch. */
  async decide(record: MobileMcpCallRecord, decision: 'approve' | 'reject', beforeClaim: () => Promise<void>, now = Date.now()) {
    const executionId = randomUUID();
    type Claim = { record: MobileMcpCallRecord; claimed: boolean };
    return executeLifecycleTransaction<Claim>({ openConnection: this.openConnection,
      execute: async database => {
        const current = decode(await database.get(`SELECT * FROM mobile_mcp_app_calls WHERE ${scopeSql} AND call_id=$6 FOR UPDATE`,
          [...scope(record.actor), record.callId]));
        if (!current || current.requestDigest !== record.requestDigest) return conflict();
        if (current.status !== 'prepared') return { record: current, claimed: false };
        await beforeClaim();
        const checkedAt = Math.max(now, Date.now());
        if (current.approvalExpiresAt <= checkedAt) throw new McpAccessError('The approval expired.', 409, 'MCP_APPROVAL_EXPIRED');
        await database.run(`UPDATE mobile_mcp_app_calls SET status=$2,updated_at=$3,execution_id=$4,execution_deadline_at=$5
          WHERE call_id=$1 AND status='prepared'`, [current.callId, decision === 'approve' ? 'executing' : 'rejected', checkedAt,
          decision === 'approve' ? executionId : null, decision === 'approve' ? checkedAt + MOBILE_MCP_EXECUTION_TTL : null]);
        const saved = decode(await database.get('SELECT * FROM mobile_mcp_app_calls WHERE call_id=$1', [current.callId]))!;
        return { record: saved, claimed: decision === 'approve' };
      }, recoverCommitted: async value => {
        const saved = await this.get(record.actor, record.callId);
        if (!saved || saved.requestDigest !== record.requestDigest || saved.status !== value.record.status
          || (value.claimed && saved.executionId !== executionId)) throw new Error('MCP approval commit is unconfirmed; no dispatch authorized.');
        return { record: saved, claimed: value.claimed };
      } });
  }
  async finish(record: MobileMcpCallRecord, outcome: { status: 'completed'; result: MobileMcpCall['result'] }
    | { status: 'failed' | 'unknown'; errorCode: string }): Promise<MobileMcpCallRecord> {
    const result = outcome.status === 'completed' ? readMobileMcpResult(outcome.result) : undefined;
    return executeLifecycleTransaction({ openConnection: this.openConnection,
      execute: async database => {
        await database.run(`UPDATE mobile_mcp_app_calls SET status=$3,result_json=$4,error_code=$5,updated_at=$6
          WHERE call_id=$1 AND execution_id=$2 AND status='executing'`, [record.callId, record.executionId, outcome.status,
          result ? JSON.stringify(result) : null, outcome.status === 'completed' ? null : outcome.errorCode, Date.now()]);
        const saved = decode(await database.get(`SELECT * FROM mobile_mcp_app_calls WHERE ${scopeSql} AND call_id=$6`, [...scope(record.actor), record.callId]));
        if (!saved || saved.executionId !== record.executionId || saved.status !== outcome.status) throw new Error('MCP result commit is unconfirmed.');
        return saved;
      }, recoverCommitted: async value => {
        const saved = await this.get(record.actor, record.callId);
        if (!saved || saved.executionId !== record.executionId || saved.status !== value.status) throw new Error('MCP result commit is unconfirmed.');
        return saved;
      } });
  }
}
export const mobileMcpAppCallStore = new MobileMcpAppCallStore();
/** Reads never update lifecycle or reclaim an interrupted external call. */
export function presentMobileMcpCall(record: MobileMcpCallRecord, checkedAt: number): MobileMcpCall {
  let status: MobileMcpCall['status'] = record.status;
  if (status === 'prepared' && record.approvalExpiresAt <= checkedAt) status = 'expired';
  if (status === 'executing' && record.executionDeadlineAt !== null && record.executionDeadlineAt <= checkedAt) status = 'unknown';
  return { callId: record.callId, requestId: record.requestId, toolCallId: record.toolCallId, app: record.app, tool: record.tool,
    requestDigest: record.requestDigest, authVersion: record.authVersion, status, createdAt: record.createdAt,
    updatedAt: record.updatedAt, approvalExpiresAt: record.approvalExpiresAt, executionDeadlineAt: record.executionDeadlineAt,
    ...(status === 'completed' && record.result ? { result: record.result } : {}),
    ...(status === 'unknown' ? { errorCode: 'MCP_CALL_UNKNOWN' } : record.errorCode ? { errorCode: record.errorCode } : {}) };
}
