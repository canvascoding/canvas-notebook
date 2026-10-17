import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { AgentWorkflowError, isAgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { isAgentActorContextError } from '@/app/lib/agents/actor-context';
import { readOwnedAcceptedChatMessageOnConnection, readOwnedChatMessageExecutionSnapshot,
  type OwnedAcceptedChatMessage, type OwnedChatMessageExecutionSnapshot } from './durable-message-admission';

export type DurableChatMessageRow = { message: OwnedAcceptedChatMessage; snapshot: OwnedChatMessageExecutionSnapshot };

export function durableMessageConflict(): never {
  throw new AgentWorkflowError('MESSAGE_EXECUTION_CONFLICT', 'The message or its session queue changed. Check its current state.', 409);
}
export function rethrowDurableMessageUseFailure(error: unknown): never {
  if (isAgentWorkflowError(error) && error.status === 403 || isAgentActorContextError(error)
    || error instanceof Error && ((error as Error & { code?: string }).code === 'WORKSPACE_PERMISSION_DENIED'
      || ['Workspace not found or inaccessible.', 'The originating agent session is unavailable in this workspace.',
        'Agent access is no longer available in this workspace.'].includes(error.message))) {
    throw new AgentWorkflowError('AGENT_MESSAGE_EXECUTION_DENIED', 'The message has no current execution access.', 403);
  }
  throw error;
}
export function sameDurableChatMessage(left: OwnedChatMessageExecutionSnapshot, right: OwnedChatMessageExecutionSnapshot): boolean {
  return left.sessionDbId === right.sessionDbId && left.hash === right.hash && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}
export function sameDurableChatMessageState(left: OwnedChatMessageExecutionSnapshot, right: OwnedChatMessageExecutionSnapshot): boolean {
  return sameDurableChatMessage(left, right) && left.phase === right.phase && left.executionRevision === right.executionRevision
    && left.runtimeToken === right.runtimeToken && left.queue?.lane === right.queue?.lane
    && left.queue?.ordinal === right.queue?.ordinal && left.queue?.disposition === right.queue?.disposition;
}
export async function readCurrentDurableChatMessageWithUse(database: SqlConnection,
  original: OwnedChatMessageExecutionSnapshot): Promise<DurableChatMessageRow> {
  const { identity, clientMessageId } = original.payload;
  let message: OwnedAcceptedChatMessage | null;
  try {
    message = await readOwnedAcceptedChatMessageOnConnection(database, { userId: identity.userId, sessionId: identity.sessionId,
      clientMessageId, expectedAgentId: identity.agentId, expectedWorkspaceId: identity.workspaceId });
  } catch (error) { return rethrowDurableMessageUseFailure(error); }
  if (!message) durableMessageConflict();
  const snapshot = readOwnedChatMessageExecutionSnapshot(message);
  if (!sameDurableChatMessage(snapshot, original)) durableMessageConflict();
  return { message, snapshot };
}

/** Session/receipt locks belong to the caller. CAS preserves original payload and intent hash. */
export async function compareAndSetDurableChatMessage(database: SqlConnection,
  previous: OwnedChatMessageExecutionSnapshot, desired: OwnedChatMessageExecutionSnapshot): Promise<void> {
  if (!sameDurableChatMessage(previous, desired) || previous.executionRevision >= Number.MAX_SAFE_INTEGER
    || desired.executionRevision !== previous.executionRevision + 1) durableMessageConflict();
  const row = await database.get(`UPDATE pi_message_delivery_receipts
    SET execution_phase=$1,execution_revision=$2,runtime_token=$3,updated_at=$4,queue_lane=$5,queue_ordinal=$6,queue_disposition=$7
    WHERE pi_session_db_id=$8 AND client_message_id=$9 AND payload_hash=$10 AND execution_phase=$11
      AND execution_revision=$12 AND runtime_token=$13 AND queue_lane IS NOT DISTINCT FROM $14
      AND queue_ordinal IS NOT DISTINCT FROM $15 AND queue_disposition IS NOT DISTINCT FROM $16
      AND state='accepted' AND payload_version=1 RETURNING client_message_id`,
  [desired.phase, desired.executionRevision, desired.runtimeToken, Date.now(), desired.queue?.lane ?? null,
    desired.queue?.ordinal ?? null, desired.queue?.disposition ?? null, previous.sessionDbId, previous.payload.clientMessageId,
    previous.hash, previous.phase, previous.executionRevision, previous.runtimeToken, previous.queue?.lane ?? null,
    previous.queue?.ordinal ?? null, previous.queue?.disposition ?? null]);
  if (!row) durableMessageConflict();
}
