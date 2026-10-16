import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import { readOwnedAcceptedChatMessageOnConnection, readOwnedChatMessageExecutionSnapshot,
  readOwnedChatMessageSettlementSnapshotOnConnection, type OwnedAcceptedChatMessage,
  type OwnedChatMessageExecutionSnapshot, type ChatMessageExecutionPhase, type ChatMessageQueueState } from './durable-message-admission';
import { compareAndSetDurableChatMessage, durableMessageConflict as conflict, readCurrentDurableChatMessageWithUse,
  rethrowDurableMessageUseFailure, sameDurableChatMessageState, type DurableChatMessageRow } from './durable-message-row-state';

/** Public status only. Neither queue metadata nor a control result grants execution. */
export type ChatMessageQueueUpdate = Readonly<{ serverMessageId: string; clientMessageId: string;
  phase: ChatMessageExecutionPhase; executionRevision: number; queue: ChatMessageQueueState | null }>;
type Snapshot = OwnedChatMessageExecutionSnapshot;
type Control = 'cancel' | 'resume' | 'promote';
type Held = { message: OwnedAcceptedChatMessage; snapshot: Snapshot };
type Mutation = { held: Held; desired: Snapshot };

function denied(): never {
  throw new AgentWorkflowError('AGENT_MESSAGE_EXECUTION_DENIED', 'The queued message does not belong to the current session.', 403);
}
function uncertain(): never {
  throw new AgentWorkflowError('MESSAGE_EXECUTION_UNCERTAIN', 'The queue change could not be confirmed. Refresh its state before trying again.', 409);
}
function heldMessages(messages: readonly OwnedAcceptedChatMessage[]): readonly Held[] {
  if (!Array.isArray(messages) || !messages.length || messages.length > 128) conflict();
  const held = messages.map(message => {
    try { return { message, snapshot: readOwnedChatMessageExecutionSnapshot(message) }; }
    catch (error) { return rethrowDurableMessageUseFailure(error); }
  });
  const first = held[0].snapshot;
  if (held.some(({ snapshot }) => snapshot.sessionDbId !== first.sessionDbId
    || JSON.stringify(snapshot.payload.identity) !== JSON.stringify(first.payload.identity))) denied();
  if (new Set(held.map(item => item.snapshot.payload.clientMessageId)).size !== held.length) conflict();
  return held;
}
function queued(snapshot: Snapshot): void {
  if (snapshot.phase !== 'queued' || snapshot.runtimeToken !== 'unclaimed'
    || snapshot.executionRevision >= Number.MAX_SAFE_INTEGER) conflict();
}
function update(snapshot: Snapshot): ChatMessageQueueUpdate {
  return Object.freeze({ serverMessageId: snapshot.payload.serverMessageId, clientMessageId: snapshot.payload.clientMessageId,
    phase: snapshot.phase, executionRevision: snapshot.executionRevision, queue: snapshot.queue });
}
async function lockSession(database: SqlConnection, snapshot: Snapshot): Promise<void> {
  const { identity } = snapshot.payload;
  const row = await database.get(`SELECT id FROM pi_sessions WHERE id=$1 AND user_id=$2 AND session_id=$3
    AND agent_id=$4 AND workspace_id=$5 AND archived_at IS NULL FOR UPDATE`,
  [snapshot.sessionDbId, identity.userId, identity.sessionId, identity.agentId, identity.workspaceId]);
  if (!row) denied();
}
async function lockReceipts(database: SqlConnection, held: readonly Held[]): Promise<void> {
  for (const item of [...held].sort((a, b) => a.snapshot.payload.clientMessageId < b.snapshot.payload.clientMessageId ? -1 : 1)) {
    if (!await database.get(`SELECT client_message_id FROM pi_message_delivery_receipts
      WHERE pi_session_db_id=$1 AND client_message_id=$2 FOR UPDATE`, [item.snapshot.sessionDbId, item.snapshot.payload.clientMessageId])) conflict();
  }
}
async function currentQueued(database: SqlConnection, held: Held): Promise<DurableChatMessageRow> {
  const current = await readCurrentDurableChatMessageWithUse(database, held.snapshot);
  if (!sameDurableChatMessageState(current.snapshot, held.snapshot)) conflict();
  queued(current.snapshot);
  return current;
}
async function allocateOrdinal(database: SqlConnection, sessionDbId: number): Promise<number> {
  const row = await database.get(`UPDATE pi_sessions SET message_queue_ordinal=message_queue_ordinal+1
    WHERE id=$1 AND message_queue_ordinal<9007199254740991 RETURNING message_queue_ordinal AS ordinal`, [sessionDbId]) as { ordinal: unknown } | undefined;
  const ordinal = Number(row?.ordinal);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) conflict();
  return ordinal;
}
async function planMutations(database: SqlConnection, held: readonly Held[], control: Control): Promise<Mutation[]> {
  const mutations: Mutation[] = [];
  for (const item of held) {
    const current = await currentQueued(database, item);
    let queue = current.snapshot.queue;
    if (control === 'promote' && !queue) conflict();
    if (control === 'resume' && queue?.disposition === 'ready') conflict();
    if (control === 'resume') queue = Object.freeze({ lane: queue?.lane ?? (current.snapshot.payload.mode === 'steer' ? 'steer' : 'prompt'),
      ordinal: queue?.ordinal ?? await allocateOrdinal(database, current.snapshot.sessionDbId), disposition: 'ready' as const });
    if (control === 'promote' && queue) queue = Object.freeze({ ...queue, lane: 'steer' as const, disposition: 'ready' as const });
    mutations.push({ held: current, desired: Object.freeze({ ...current.snapshot, queue,
      phase: control === 'cancel' ? 'cancelled' as const : 'queued' as const, executionRevision: current.snapshot.executionRevision + 1 }) });
  }
  return mutations;
}

/** Borrowed transaction; caller holds the Session lock after source/Agent locks.
 * Used by atomic Replace. It neither commits nor recovers or issues a Claim. */
export async function cancelOwnedQueuedChatMessagesOnConnection(database: SqlConnection,
  messages: readonly OwnedAcceptedChatMessage[], expectedSessionDbId: number): Promise<readonly Mutation[]> {
  const held = heldMessages(messages);
  if (held[0].snapshot.sessionDbId !== expectedSessionDbId) denied();
  await lockReceipts(database, held);
  const mutations = await planMutations(database, held, 'cancel');
  await applyMutations(database, mutations);
  return mutations;
}
async function applyMutations(database: SqlConnection, mutations: readonly Mutation[]): Promise<void> {
  for (const mutation of mutations) await compareAndSetDurableChatMessage(database, mutation.held.snapshot, mutation.desired);
  // Fresh Use after the final write; failure rolls back the complete batch.
  for (const mutation of mutations) {
    const actual = await readCurrentDurableChatMessageWithUse(database, mutation.desired);
    if (!sameDurableChatMessageState(actual.snapshot, mutation.desired)) conflict();
  }
}

async function controlQueued(messages: readonly OwnedAcceptedChatMessage[], control: Control): Promise<readonly ChatMessageQueueUpdate[]> {
  const held = heldMessages(messages);
  if (control === 'promote' && held.length !== 1) conflict();
  const mutations = await executeLifecycleTransaction({ openConnection: openDb,
    execute: async database => {
      await lockSession(database, held[0].snapshot);
      const affected = [...held];
      if (control === 'promote') {
        const target = await currentQueued(database, held[0]);
        if (!target.snapshot.queue) conflict();
        const unordered = await database.get(`SELECT client_message_id FROM pi_message_delivery_receipts
          WHERE pi_session_db_id=$1 AND execution_phase='queued' AND queue_ordinal IS NULL LIMIT 1`, [target.snapshot.sessionDbId]);
        if (unordered) conflict();
        const older = await database.all(`SELECT client_message_id FROM pi_message_delivery_receipts
          WHERE pi_session_db_id=$1 AND execution_phase='queued' AND queue_disposition='ready' AND queue_ordinal<$2
          ORDER BY queue_ordinal`, [target.snapshot.sessionDbId, target.snapshot.queue.ordinal]) as { client_message_id: string }[];
        const { identity } = target.snapshot.payload;
        for (const row of older) {
          const message = await readOwnedAcceptedChatMessageOnConnection(database, { userId: identity.userId, sessionId: identity.sessionId,
            clientMessageId: row.client_message_id, expectedAgentId: identity.agentId, expectedWorkspaceId: identity.workspaceId });
          if (!message) conflict();
          affected.push({ message, snapshot: readOwnedChatMessageExecutionSnapshot(message) });
        }
      }
      await lockReceipts(database, affected);
      const desired = await planMutations(database, held, control);
      for (const older of affected.slice(held.length)) {
        const current = await currentQueued(database, older);
        if (!current.snapshot.queue) conflict();
        desired.push({ held: current, desired: Object.freeze({ ...current.snapshot,
          queue: Object.freeze({ ...current.snapshot.queue, disposition: 'suspended' as const }), executionRevision: current.snapshot.executionRevision + 1 }) });
      }
      await applyMutations(database, desired);
      return desired;
    },
    recoverCommitted: async desired => {
      const database = await openDb();
      try {
        // Bookkeeping only: confirm the entire private vector, including every
        // suspended row. Never repeat writes or manufacture a new Owned grant.
        for (const mutation of desired) {
          const actual = await readOwnedChatMessageSettlementSnapshotOnConnection(database, mutation.held.message);
          if (!actual || !sameDurableChatMessageState(actual, mutation.desired)) uncertain();
        }
        return desired;
      } finally { await database.close(); }
    },
  });
  return Object.freeze(mutations.map(mutation => update(mutation.desired)));
}

export async function cancelOwnedQueuedChatMessages(messages: readonly OwnedAcceptedChatMessage[]): Promise<readonly ChatMessageQueueUpdate[]> {
  return controlQueued(messages, 'cancel');
}
export async function resumeOwnedQueuedChatMessages(messages: readonly OwnedAcceptedChatMessage[]): Promise<readonly ChatMessageQueueUpdate[]> {
  return controlQueued(messages, 'resume');
}
export async function promoteOwnedQueuedChatMessage(message: OwnedAcceptedChatMessage): Promise<Readonly<{
  message: ChatMessageQueueUpdate; suspended: readonly ChatMessageQueueUpdate[];
}>> {
  const changed = await controlQueued([message], 'promote');
  return Object.freeze({ message: changed[0], suspended: Object.freeze(changed.slice(1)) });
}
