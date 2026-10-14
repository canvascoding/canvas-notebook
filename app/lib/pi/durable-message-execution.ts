import 'server-only';

import { randomUUID } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { AgentWorkflowError, isAgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { isAgentActorContextError } from '@/app/lib/agents/actor-context';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import {
  readOwnedAcceptedChatMessageOnConnection,
  readOwnedChatMessageExecutionSnapshot,
  readOwnedChatMessageSettlementSnapshotOnConnection,
  type OwnedAcceptedChatMessage,
  type OwnedChatMessageExecutionSnapshot,
} from './durable-message-admission';
import type { RegisteredPiRuntimeExecutionOwner } from './live-runtime';

export type ChatMessageExecutionClaim = Readonly<{ kind: 'chat_message_execution_claim' }>;
export type ChatMessageExecutionOutcome = 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
export type ChatMessageExecutionSettlement = Readonly<{
  kind: 'chat_message_execution_settlement'; phase: ChatMessageExecutionOutcome; executionRevision: number;
}>;
type Snapshot = OwnedChatMessageExecutionSnapshot;
type OwnerData = Readonly<{ token: string; userId: string; sessionId: string; agentId: string; workspaceId: string }>;
type CurrentRow = { message: OwnedAcceptedChatMessage; snapshot: Snapshot };
type ClaimRecord = CurrentRow & { owner: RegisteredPiRuntimeExecutionOwner; ownerData: OwnerData };
const host = globalThis as typeof globalThis & {
  __canvasDurableMessageExecutionClaimsV1?: WeakMap<object, ClaimRecord>;
};
const claims = host.__canvasDurableMessageExecutionClaimsV1 ??= new WeakMap<object, ClaimRecord>();
const outcomes = new Set<ChatMessageExecutionOutcome>(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);

function denied(): never {
  throw new AgentWorkflowError('AGENT_MESSAGE_EXECUTION_DENIED', 'The message has no current registered execution owner.', 403);
}
function conflict(): never {
  throw new AgentWorkflowError('MESSAGE_EXECUTION_CONFLICT', 'The message or another execution in this session changed. Check its current state.', 409);
}
function uncertain(): never {
  throw new AgentWorkflowError('MESSAGE_EXECUTION_UNCERTAIN', 'The execution transition could not be confirmed. Do not start or repeat the message automatically.', 409);
}
function throwUseFailure(error: unknown): never {
  if (isAgentWorkflowError(error) && error.status === 403 || isAgentActorContextError(error)
    || error instanceof Error && ((error as Error & { code?: string }).code === 'WORKSPACE_PERMISSION_DENIED'
      || ['Workspace not found or inaccessible.', 'The originating agent session is unavailable in this workspace.',
        'Agent access is no longer available in this workspace.'].includes(error.message))) return denied();
  throw error;
}
function heldSnapshot(message: OwnedAcceptedChatMessage): Snapshot {
  try { return readOwnedChatMessageExecutionSnapshot(message); }
  catch (error) { return throwUseFailure(error); }
}
function nextRevision(snapshot: Snapshot): number {
  if (snapshot.executionRevision >= Number.MAX_SAFE_INTEGER) return conflict();
  return snapshot.executionRevision + 1;
}
function sameMessage(left: Snapshot, right: Snapshot): boolean {
  return left.sessionDbId === right.sessionDbId && left.hash === right.hash
    && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}
function sameState(left: Snapshot, right: Snapshot): boolean {
  return sameMessage(left, right) && left.phase === right.phase
    && left.executionRevision === right.executionRevision && left.runtimeToken === right.runtimeToken;
}
function sameOwner(left: OwnerData, right: OwnerData): boolean {
  return left.token === right.token && left.userId === right.userId && left.sessionId === right.sessionId
    && left.agentId === right.agentId && left.workspaceId === right.workspaceId;
}
function ownerMatchesMessage(owner: OwnerData, snapshot: Snapshot): boolean {
  const identity = snapshot.payload.identity;
  return owner.userId === identity.userId && owner.sessionId === identity.sessionId
    && owner.agentId === identity.agentId && owner.workspaceId === identity.workspaceId;
}
async function currentOwner(owner: RegisteredPiRuntimeExecutionOwner): Promise<OwnerData> {
  const { readRegisteredPiRuntimeExecutionOwner } = await import('./live-runtime');
  try { return await readRegisteredPiRuntimeExecutionOwner(owner); }
  catch (error) {
    if (isAgentWorkflowError(error) && error.code === 'AGENT_MESSAGE_EXECUTION_OWNER_CHANGED') return denied();
    throw error;
  }
}
async function assertOwner(owner: RegisteredPiRuntimeExecutionOwner, expected: OwnerData, snapshot: Snapshot): Promise<void> {
  const actual = await currentOwner(owner);
  if (!sameOwner(actual, expected) || !ownerMatchesMessage(actual, snapshot)) denied();
}
function issueClaim(current: CurrentRow, owner: RegisteredPiRuntimeExecutionOwner, ownerData: OwnerData): ChatMessageExecutionClaim {
  const handle = Object.freeze({ kind: 'chat_message_execution_claim' as const });
  claims.set(handle, { ...current, owner, ownerData });
  return handle;
}
function claimRecord(handle: ChatMessageExecutionClaim): ClaimRecord {
  const record = handle && typeof handle === 'object' ? claims.get(handle) : undefined;
  if (!record) denied();
  return record;
}

/** One SQL lock order for every execution transition: actual session, then its receipt. */
async function lockRows(database: SqlConnection, original: Snapshot, requireUse: boolean): Promise<void> {
  const { identity, clientMessageId } = original.payload;
  const session = await database.get(`SELECT id FROM pi_sessions WHERE id=$1 AND user_id=$2 AND session_id=$3
    ${requireUse ? 'AND agent_id=$4 AND workspace_id=$5 AND archived_at IS NULL' : ''} FOR UPDATE`,
  [original.sessionDbId, identity.userId, identity.sessionId, ...(requireUse ? [identity.agentId, identity.workspaceId] : [])]);
  if (!session) denied();
  const row = await database.get(`SELECT client_message_id FROM pi_message_delivery_receipts
    WHERE pi_session_db_id=$1 AND client_message_id=$2 FOR UPDATE`, [original.sessionDbId, clientMessageId]);
  if (!row) conflict();
}
async function assertSessionAvailable(database: SqlConnection, snapshot: Snapshot): Promise<void> {
  const other = await database.get(`SELECT client_message_id FROM pi_message_delivery_receipts
    WHERE pi_session_db_id=$1 AND client_message_id<>$2 AND execution_phase IN ('dispatching','running') LIMIT 1`,
  [snapshot.sessionDbId, snapshot.payload.clientMessageId]);
  // Even the same runtime must settle its prior message at a verified handoff.
  // A timestamp, missing RAM instance or token copied from SQL never permits stealing it.
  if (other) conflict();
}
async function readCurrentWithUse(database: SqlConnection, original: Snapshot): Promise<CurrentRow> {
  const { identity, clientMessageId } = original.payload;
  let message: OwnedAcceptedChatMessage | null;
  try {
    message = await readOwnedAcceptedChatMessageOnConnection(database, { userId: identity.userId, sessionId: identity.sessionId,
      clientMessageId, expectedAgentId: identity.agentId, expectedWorkspaceId: identity.workspaceId });
  } catch (error) { return throwUseFailure(error); }
  if (!message) conflict();
  const snapshot = readOwnedChatMessageExecutionSnapshot(message);
  if (!sameMessage(original, snapshot)) conflict();
  return { message, snapshot };
}

/** Commit awaits can invalidate the owner or revoke Use after the in-transaction checks. */
async function confirmCommittedUse(current: CurrentRow, owner: RegisteredPiRuntimeExecutionOwner,
  ownerData: OwnerData): Promise<CurrentRow & { claim: ChatMessageExecutionClaim }> {
  // This private claim has not escaped; no caller can start a model/tool yet.
  const claim = issueClaim(current, owner, ownerData);
  try {
    const database = await openDb();
    let fresh: CurrentRow;
    try { fresh = await readCurrentWithUse(database, current.snapshot); }
    finally { await database.close(); }
    if (!sameState(fresh.snapshot, current.snapshot)) conflict();
    await assertOwner(owner, ownerData, fresh.snapshot);
    claims.set(claim, { ...fresh, owner, ownerData });
    return { ...fresh, claim };
  } catch (error) {
    // Known pre-start failure: settle this exact committed claim without Use.
    // If cancellation itself is unconfirmed, preserve an explicit uncertain error.
    try { await finishClaimedChatMessageExecution(claim, 'cancelled'); }
    catch { return uncertain(); }
    throw error;
  }
}
async function compareAndSet(database: SqlConnection, previous: Snapshot, desired: Snapshot): Promise<void> {
  const row = await database.get(`UPDATE pi_message_delivery_receipts
    SET execution_phase=$1,execution_revision=$2,runtime_token=$3,updated_at=$4
    WHERE pi_session_db_id=$5 AND client_message_id=$6 AND payload_hash=$7 AND execution_phase=$8
      AND execution_revision=$9 AND runtime_token=$10 AND state='accepted' AND payload_version=1
    RETURNING client_message_id`, [desired.phase, desired.executionRevision, desired.runtimeToken, Date.now(), previous.sessionDbId,
    previous.payload.clientMessageId, previous.hash, previous.phase, previous.executionRevision, previous.runtimeToken]);
  if (!row) conflict();
}

/** No callback may start a model/tool. Claims are issued only after confirmed COMMIT/recovery. */
async function transitionWithUse(input: {
  previous: Snapshot; desired: Snapshot; owner: RegisteredPiRuntimeExecutionOwner; ownerData: OwnerData;
}): Promise<CurrentRow> {
  return executeLifecycleTransaction({ openConnection: openDb,
    execute: async database => {
      await lockRows(database, input.previous, true);
      const current = await readCurrentWithUse(database, input.previous);
      if (!sameState(current.snapshot, input.previous)) conflict();
      await assertSessionAvailable(database, current.snapshot);
      await assertOwner(input.owner, input.ownerData, current.snapshot);
      await compareAndSet(database, current.snapshot, input.desired);
      const confirmed = await readCurrentWithUse(database, input.desired);
      if (!sameState(confirmed.snapshot, input.desired)) conflict();
      await assertOwner(input.owner, input.ownerData, confirmed.snapshot);
      return confirmed;
    },
    recoverCommitted: async desired => {
      const database = await openDb();
      try {
        // Confirm only this attempt's committed transition first. Rights or
        // registration may have disappeared with the ACK; the common post-commit
        // check must still be able to cancel a known, never-published start.
        const actual = await readOwnedChatMessageSettlementSnapshotOnConnection(database, desired.message);
        if (!actual || !sameState(actual, desired.snapshot)) uncertain();
        // Reuse the original privately issued pre-COMMIT handle, kept internal
        // until fresh Use/registration succeeds. Bookkeeping issues no Owned grant.
        return desired;
      } finally { await database.close(); }
    },
  });
}

/** Safe unbegun rows only. Each call has its own token, including two calls by the same runtime. */
export async function claimOwnedChatMessageExecution(message: OwnedAcceptedChatMessage,
  owner: RegisteredPiRuntimeExecutionOwner): Promise<ChatMessageExecutionClaim> {
  const previous = heldSnapshot(message), ownerData = await currentOwner(owner);
  if (!ownerMatchesMessage(ownerData, previous)) denied();
  if (previous.phase !== 'queued' || previous.runtimeToken !== 'unclaimed') conflict();
  const desired = Object.freeze({ ...previous, phase: 'dispatching' as const,
    executionRevision: nextRevision(previous), runtimeToken: randomUUID() });
  const current = await transitionWithUse({ previous, desired, owner, ownerData });
  return (await confirmCommittedUse(current, owner, ownerData)).claim;
}

/** One-shot start. The fresh Running-Owned message is the only correct input for the source reissuer. */
export async function startClaimedChatMessageExecution(handle: ChatMessageExecutionClaim): Promise<Readonly<{
  claim: ChatMessageExecutionClaim; message: OwnedAcceptedChatMessage;
}>> {
  const previous = claimRecord(handle);
  if (previous.snapshot.phase !== 'dispatching') conflict();
  await assertOwner(previous.owner, previous.ownerData, previous.snapshot);
  const desired = Object.freeze({ ...previous.snapshot, phase: 'running' as const, executionRevision: nextRevision(previous.snapshot) });
  const current = await transitionWithUse({ previous: previous.snapshot, desired, owner: previous.owner, ownerData: previous.ownerData });
  const confirmed = await confirmCommittedUse(current, previous.owner, previous.ownerData);
  return Object.freeze({ claim: confirmed.claim, message: confirmed.message });
}

/**
 * Terminal bookkeeping for a genuine claim, also after rights/registration loss.
 * The runtime must await actual tool/persistence settlement before calling this.
 * failed/cancelled do not assert absence of earlier side effects.
 */
export async function finishClaimedChatMessageExecution(handle: ChatMessageExecutionClaim,
  outcome: ChatMessageExecutionOutcome): Promise<ChatMessageExecutionSettlement> {
  const record = claimRecord(handle), previous = record.snapshot;
  if (!outcomes.has(outcome) || previous.phase !== 'dispatching' && previous.phase !== 'running'
    || previous.phase === 'dispatching' && outcome !== 'failed' && outcome !== 'cancelled') conflict();
  const desired = Object.freeze({ ...previous, phase: outcome, executionRevision: nextRevision(previous) });
  const result = await executeLifecycleTransaction({ openConnection: openDb,
    execute: async database => {
      await lockRows(database, previous, false);
      const current = await readOwnedChatMessageSettlementSnapshotOnConnection(database, record.message);
      if (!current || !sameMessage(current, previous)) conflict();
      // Repeating identical settlement is harmless; repeating a start never is.
      if (sameState(current, desired)) return current;
      if (!sameState(current, previous)) conflict();
      await compareAndSet(database, current, desired);
      const confirmed = await readOwnedChatMessageSettlementSnapshotOnConnection(database, record.message);
      if (!confirmed || !sameState(confirmed, desired)) conflict();
      return confirmed;
    },
    recoverCommitted: async expected => {
      const database = await openDb();
      try {
        const actual = await readOwnedChatMessageSettlementSnapshotOnConnection(database, record.message);
        if (!actual || !sameState(actual, expected)) uncertain();
        return actual;
      } finally { await database.close(); }
    },
  });
  return Object.freeze({ kind: 'chat_message_execution_settlement', phase: outcome, executionRevision: result.executionRevision });
}
