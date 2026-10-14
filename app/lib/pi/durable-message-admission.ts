import 'server-only';

import { randomUUID } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { resolveVerifiedAgentActorContextOnConnection } from '@/app/lib/agents/actor-context';
import { holdAgentGrantAuthority } from '@/app/lib/agents/workflow-configuration';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { withRevalidatedAgentWorkflowProjectionSourcesOnConnection,
  type AgentWorkflowRuntimeProjection } from '@/app/lib/agents/workflow-runtime';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import type { ChatBodyV1 } from '@/app/lib/chat/chat-body-contracts';
import {
  canonicalAcceptedMessageIntentHash, captureChatMessageAdmissionRequest, parseCanonicalMessageIntent, parseStoredAcceptedChatMessage,
  receiptFreeChatExtensionSelection, type StoredAcceptedChatMessage,
} from '@/app/lib/chat/durable-message-contracts';
import {
  prepareAcceptedTurnExtensionSelection, readAcceptedTurnExtensionSelection,
  withRevalidatedAcceptedTurnExtensionSelectionOnConnection, type AcceptedTurnExtensionSelection,
} from '@/app/lib/capabilities/extensions/accepted-turn-selection';
import {
  getAuthorizedAgentWorkflowPackageSelections, withRevalidatedAgentWorkflowPackageSelectionOnConnection,
  type AuthorizedAgentWorkflowPackageSelections,
} from '@/app/lib/capabilities/packages/runtime-bindings';
import { reissueAcceptedTurnRuntimeSelection } from '@/app/lib/capabilities/extensions/turn-runtime';
import { readEffectiveExtensionContext, resolveEffectiveExtensionContext } from '@/app/lib/capabilities/extensions/effective-context';
import { EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS } from '@/app/lib/capabilities/extensions/context-prompt';
import { appendEffectiveExtensionContextPrompt } from '@/app/lib/capabilities/extensions/runtime-prompt';
import { getPiTools } from './tool-registry';
import { readStoredAgentWorkspaceOnConnection } from './session-workspace-context';
import type { AgentExecutionContext } from './agent-execution-context';
import { MessageDeliveryError } from './message-delivery-receipt';
import type { ChatMessageQueueUpdate } from './durable-message-queue';

export type ChatMessageExecutionPhase = 'queued' | 'dispatching' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
export type ChatMessageQueueLane = 'prompt' | 'follow_up' | 'steer';
export type ChatMessageQueueState = Readonly<{ lane: ChatMessageQueueLane; ordinal: number; disposition: 'ready' | 'suspended' }>;
export type PreparedChatMessageAdmission = Readonly<{ kind: 'prepared_chat_message_admission' }>;
/** Provenance of an actual owned SQL row. This is not permission to execute it. */
export type OwnedAcceptedChatMessage = Readonly<{ kind: 'owned_accepted_chat_message' }>;
type MessageIdentity = StoredAcceptedChatMessage['identity'];
export type ChatMessageAdmissionIdentity = { userId: string; sessionId: string; clientMessageId: string;
  expectedAgentId?: string; expectedWorkspaceId?: string };
export type ChatMessageAdmissionInput = ChatMessageAdmissionIdentity & {
  message: StoredAcceptedChatMessage['message']; context?: ChatRequestContext | null;
  mode?: 'message' | 'steer'; selection?: unknown; body?: ChatBodyV1;
};
type ActorFrame = { sessionDbId: number; identity: MessageIdentity; context: AgentExecutionContext };
type ReceiptRow = { client_message_id: string; payload_hash: string; state: string; payload_version: unknown;
  private_payload: unknown; execution_phase: unknown; execution_revision: unknown; runtime_token: unknown;
  queue_lane: unknown; queue_ordinal: unknown; queue_disposition: unknown };
type PreparedRecord = { payload: StoredAcceptedChatMessage; hash: string; actor: ActorFrame;
  intake: AcceptedTurnExtensionSelection | null; intakeContext: AgentExecutionContext;
  runtimeContext: AgentExecutionContext; packages: AuthorizedAgentWorkflowPackageSelections;
  workflowProjection: AgentWorkflowRuntimeProjection | null };
type OwnedRecord = { payload: StoredAcceptedChatMessage; hash: string; sessionDbId: number;
  phase: ChatMessageExecutionPhase; executionRevision: number; runtimeToken: string; queue: ChatMessageQueueState | null; actor: ActorFrame };
/** Server-internal bookkeeping data; neither this DTO nor its token issues authority. */
export type OwnedChatMessageExecutionSnapshot = Readonly<{
  payload: StoredAcceptedChatMessage; hash: string; sessionDbId: number;
  phase: ChatMessageExecutionPhase; executionRevision: number; runtimeToken: string; queue: ChatMessageQueueState | null;
}>;
type ReplacementTarget = Readonly<{ message: OwnedAcceptedChatMessage; previous: OwnedChatMessageExecutionSnapshot;
  desired: OwnedChatMessageExecutionSnapshot }>;
const host = globalThis as typeof globalThis & {
  __canvasDurableMessageAdmissionV1?: { prepared: WeakMap<object, PreparedRecord>; owned: WeakMap<object, OwnedRecord> };
};
const records = host.__canvasDurableMessageAdmissionV1 ??= { prepared: new WeakMap(), owned: new WeakMap() };
const phases = new Set<ChatMessageExecutionPhase>(['queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown']);

function denied(): never {
  throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The current message session or its access changed.', 403);
}
function corrupt(): never {
  throw new AgentWorkflowError('AGENT_MESSAGE_ADMISSION_CORRUPT', 'The stored message admission cannot be verified.', 409);
}
function clientId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/u.test(value)) {
    throw new MessageDeliveryError('INVALID_CLIENT_MESSAGE_ID', 'A valid client message ID is required.');
  }
  return value;
}
function actorStamp(context: AgentExecutionContext): string {
  return JSON.stringify([context.userId, context.sessionId, context.agentId, context.organizationId, context.workspaceId,
    context.workspaceType, context.workspaceRoot, context.workspaceRootRelativePath, context.projectId, context.customerId,
    context.canWrite, context.canDelete, context.canShare, context.legacy]);
}
function assertContext(identity: MessageIdentity, context: ChatRequestContext): void {
  if (context.workspace && (context.workspace.workspaceId !== identity.workspaceId
    || context.workspace.organizationId !== undefined && context.workspace.organizationId !== identity.organizationId)) denied();
}

/** Read only actual stored assignments; no default Agent/workspace or bootstrap. */
async function readActor(database: SqlConnection, input: ChatMessageAdmissionIdentity, lockSession = false): Promise<ActorFrame> {
  const session = await database.get(`SELECT id,agent_id,workspace_id FROM pi_sessions
    WHERE user_id=$1 AND session_id=$2 AND archived_at IS NULL LIMIT 1${lockSession ? ' FOR UPDATE' : ''}`,
  [input.userId, input.sessionId]) as { id: unknown; agent_id: unknown; workspace_id: unknown } | undefined;
  if (!session || typeof session.agent_id !== 'string' || !session.agent_id || typeof session.workspace_id !== 'string' || !session.workspace_id
    || input.expectedAgentId !== undefined && input.expectedAgentId !== session.agent_id
    || input.expectedWorkspaceId !== undefined && input.expectedWorkspaceId !== session.workspace_id) denied();
  const sessionDbId = Number(session.id);
  if (!Number.isSafeInteger(sessionDbId) || sessionDbId < 1) corrupt();
  const workspace = await readStoredAgentWorkspaceOnConnection(database, { userId: input.userId, sessionId: input.sessionId,
    agentId: session.agent_id, workspaceId: session.workspace_id, permissions: ['canRead', 'canRunAgent'] });
  const verified = await resolveVerifiedAgentActorContextOnConnection({ userId: input.userId, organizationId: workspace.organizationId ?? null,
    workspaceId: workspace.workspaceId, projectId: workspace.projectId ?? null }, database);
  if (verified.userId !== input.userId || verified.context.workspaceId !== workspace.workspaceId
    || verified.organizationId !== (workspace.organizationId ?? null)
    || (verified.context.projectId ?? null) !== (workspace.projectId ?? null)) denied();
  const identity: MessageIdentity = { userId: input.userId, sessionId: input.sessionId, agentId: session.agent_id,
    workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null, projectId: workspace.projectId ?? null };
  const context: AgentExecutionContext = { userId: identity.userId, sessionId: identity.sessionId, agentId: identity.agentId,
    workspaceId: identity.workspaceId, workspaceType: workspace.workspaceType, workspaceName: workspace.displayName ?? null,
    organizationId: identity.organizationId, projectId: identity.projectId, customerId: workspace.customerId ?? null,
    workspaceRoot: workspace.rootPath, workspaceRootRelativePath: workspace.rootRelativePath ?? null,
    canWrite: workspace.permissions.canWrite, canDelete: workspace.permissions.canDelete,
    canShare: workspace.permissions.canCreatePublicLinks, legacy: workspace.legacy };
  return { sessionDbId, identity, context };
}

function parseOwnedRecord(actor: ActorFrame, row: ReceiptRow, expectedHash?: string): OwnedRecord {
  if (row.payload_version === null || row.payload_version === undefined) {
    throw new MessageDeliveryError('MESSAGE_DELIVERY_UNCERTAIN', 'This legacy receipt has no recoverable message payload. Check the chat before sending it again.');
  }
  if (expectedHash !== undefined && row.payload_hash !== expectedHash) {
    throw new MessageDeliveryError('MESSAGE_ID_CONFLICT', 'This message ID was already used for different content or context.');
  }
  if (Number(row.payload_version) !== 1 || row.state !== 'accepted' || typeof row.private_payload !== 'string') corrupt();
  let payload: StoredAcceptedChatMessage;
  try { payload = parseStoredAcceptedChatMessage(JSON.parse(row.private_payload)); } catch { return corrupt(); }
  if (JSON.stringify(payload.identity) !== JSON.stringify(actor.identity) || payload.clientMessageId !== row.client_message_id) denied();
  const hash = canonicalAcceptedMessageIntentHash({ content: payload.message.content, context: payload.context, mode: payload.mode,
    selection: payload.extensionSelection?.publicSelection ?? null, ...(payload.body === undefined ? {} : { body: payload.body }) });
  if (hash !== row.payload_hash) corrupt();
  const phase = row.execution_phase as ChatMessageExecutionPhase, executionRevision = Number(row.execution_revision);
  if (!phases.has(phase) || !Number.isSafeInteger(executionRevision) || executionRevision < 1
    || typeof row.runtime_token !== 'string' || !row.runtime_token || row.runtime_token.length > 128) corrupt();
  let queue: ChatMessageQueueState | null = null;
  if (row.queue_lane !== null || row.queue_ordinal !== null || row.queue_disposition !== null) {
    const ordinal = Number(row.queue_ordinal);
    if (!['prompt', 'follow_up', 'steer'].includes(String(row.queue_lane))
      || !Number.isSafeInteger(ordinal) || ordinal < 1 || !['ready', 'suspended'].includes(String(row.queue_disposition))) corrupt();
    queue = Object.freeze({ lane: row.queue_lane as ChatMessageQueueLane, ordinal,
      disposition: row.queue_disposition as 'ready' | 'suspended' });
  }
  return { payload, hash, sessionDbId: actor.sessionDbId, phase, executionRevision, runtimeToken: row.runtime_token, queue, actor };
}

function issueOwned(actor: ActorFrame, row: ReceiptRow, expectedHash?: string): OwnedAcceptedChatMessage {
  const record = parseOwnedRecord(actor, row, expectedHash);
  const handle = Object.freeze({ kind: 'owned_accepted_chat_message' as const });
  records.owned.set(handle, record);
  return handle;
}

async function receipt(database: SqlConnection, actor: ActorFrame, id: string): Promise<ReceiptRow | undefined> {
  return await database.get(`SELECT client_message_id,payload_hash,state,payload_version,private_payload,execution_phase,execution_revision,runtime_token,
    queue_lane,queue_ordinal,queue_disposition
    FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1 AND client_message_id=$2`, [actor.sessionDbId, id]) as ReceiptRow | undefined;
}
async function assertNoHistoricalMessage(database: SqlConnection, actor: ActorFrame, id: string): Promise<void> {
  if (await database.get(`SELECT id FROM pi_messages WHERE pi_session_db_id=$1 AND role='user'
    AND content::jsonb ->> 'clientMessageId' = $2 LIMIT 1`, [actor.sessionDbId, id])) {
    throw new MessageDeliveryError('MESSAGE_DELIVERY_UNCERTAIN', 'This message ID exists without its original admission payload. Check the chat before sending it again.');
  }
}

/** Actual SQL reader is the sole issuer. JSON, receipt strings and copied handles cannot substitute. */
export async function readOwnedAcceptedChatMessage(input: ChatMessageAdmissionIdentity): Promise<OwnedAcceptedChatMessage | null> {
  const id = clientId(input.clientMessageId), captured = { ...input, clientMessageId: id };
  const database = await openDb();
  try {
    return await readOwnedAcceptedChatMessageOnConnection(database, captured);
  } finally { await database.close(); }
}

/** Borrowed connection; retains the same current Actor/Use and payload checks, without lifecycle operations. */
export async function readOwnedAcceptedChatMessageOnConnection(database: SqlConnection,
  input: ChatMessageAdmissionIdentity): Promise<OwnedAcceptedChatMessage | null> {
  const id = clientId(input.clientMessageId), captured = { ...input };
  const actor = await readActor(database, captured), row = await receipt(database, actor, id);
  return row ? issueOwned(actor, row) : null;
}

function executionSnapshot(record: OwnedRecord): OwnedChatMessageExecutionSnapshot {
  if (typeof record.runtimeToken !== 'string' || !record.runtimeToken) denied();
  return Object.freeze({ payload: record.payload, hash: record.hash, sessionDbId: record.sessionDbId,
    phase: record.phase, executionRevision: record.executionRevision, runtimeToken: record.runtimeToken, queue: record.queue });
}

/** A genuine held row is required; a copied snapshot or token cannot acquire an execution claim. */
export function readOwnedChatMessageExecutionSnapshot(handle: OwnedAcceptedChatMessage): OwnedChatMessageExecutionSnapshot {
  const record = handle && typeof handle === 'object' ? records.owned.get(handle) : undefined;
  if (!record) denied();
  return executionSnapshot(record);
}

/**
 * Bookkeeping only, for a previously genuine row. No new Owned handle is issued
 * and current Use is deliberately not required to settle an already-started run.
 * The caller must hold the session/receipt locks and validate its private claim.
 */
export async function readOwnedChatMessageSettlementSnapshotOnConnection(database: SqlConnection,
  handle: OwnedAcceptedChatMessage): Promise<OwnedChatMessageExecutionSnapshot | null> {
  const original = handle && typeof handle === 'object' ? records.owned.get(handle) : undefined;
  if (!original) denied();
  const parent = await database.get(`SELECT id FROM pi_sessions WHERE id=$1 AND user_id=$2 AND session_id=$3`,
    [original.sessionDbId, original.payload.identity.userId, original.payload.identity.sessionId]);
  if (!parent) denied();
  const row = await receipt(database, original.actor, original.payload.clientMessageId);
  if (!row) return null;
  const current = parseOwnedRecord(original.actor, row, original.hash);
  if (JSON.stringify(current.payload) !== JSON.stringify(original.payload)) corrupt();
  return executionSnapshot(current);
}

/** Private provenance metadata only. Every later dispatch must recheck current execution authority. */
export function readOwnedAcceptedChatMessageData(handle: OwnedAcceptedChatMessage, context: AgentExecutionContext): Readonly<{
  payload: StoredAcceptedChatMessage; phase: ChatMessageExecutionPhase; executionRevision: number; queue: ChatMessageQueueState | null;
  rowIdentity: Readonly<{ sessionDbId: number; clientMessageId: string }>;
}> {
  const record = handle && typeof handle === 'object' ? records.owned.get(handle) : undefined;
  if (!record || actorStamp(record.actor.context) !== actorStamp(context)
    || context.agentTurnId !== undefined && context.agentTurnId !== record.payload.serverMessageId) denied();
  return Object.freeze({ payload: record.payload, phase: record.phase, executionRevision: record.executionRevision, queue: record.queue,
    rowIdentity: Object.freeze({ sessionDbId: record.sessionDbId, clientMessageId: record.payload.clientMessageId }) });
}

/** Replay is resolved before expiring account receipts or provider metadata are touched. */
export async function prepareChatMessageAdmission(input: ChatMessageAdmissionInput): Promise<
  { kind: 'replay'; message: OwnedAcceptedChatMessage } | { kind: 'prepared'; admission: PreparedChatMessageAdmission }
> {
  let captured: ReturnType<typeof captureChatMessageAdmissionRequest>;
  try { captured = captureChatMessageAdmissionRequest(input); }
  catch { throw new AgentWorkflowError('AGENT_MESSAGE_ADMISSION_INVALID', 'A bounded user message and exact selection are required.', 400); }
  const id = clientId(captured.clientMessageId), identity = { userId: captured.userId, sessionId: captured.sessionId,
    clientMessageId: id, ...(captured.expectedAgentId === undefined ? {} : { expectedAgentId: captured.expectedAgentId }),
    ...(captured.expectedWorkspaceId === undefined ? {} : { expectedWorkspaceId: captured.expectedWorkspaceId }) };
  const selectionInput = captured.selection;
  const intent = parseCanonicalMessageIntent({ content: captured.message.content, context: captured.context,
    mode: captured.mode, selection: receiptFreeChatExtensionSelection(selectionInput),
    ...(captured.body === undefined ? {} : { body: captured.body }) });
  const timestamp = captured.message.timestamp;
  const hash = canonicalAcceptedMessageIntentHash(intent);
  const initial = await openDb();
  let actor: ActorFrame;
  try {
    actor = await readActor(initial, identity); assertContext(actor.identity, intent.context ?? {});
    const existing = await receipt(initial, actor, id);
    if (existing) return { kind: 'replay', message: issueOwned(actor, existing, hash) };
    await assertNoHistoricalMessage(initial, actor, id);
  } finally { await initial.close(); }
  // No lease is retained while real source services and metadata are prepared.
  try {
    const serverMessageId = randomUUID();
    const intakeContext: AgentExecutionContext = { ...actor.context, agentTurnId: serverMessageId,
      ...(intent.selection ? { turnExtensions: intent.selection } : {}) };
    const intake = intent.selection ? await prepareAcceptedTurnExtensionSelection(intakeContext, selectionInput) : null;
    const accepted = intake ? readAcceptedTurnExtensionSelection(intake, intakeContext) : null;
    const packages = await getAuthorizedAgentWorkflowPackageSelections(intakeContext);
    const runtimeContext = { ...intakeContext };
    if (intake) runtimeContext.turnExtensionSource = await reissueAcceptedTurnRuntimeSelection(runtimeContext, intake, intakeContext,
      { packageSelection: packages });
    const effective = await resolveEffectiveExtensionContext(runtimeContext, { packageSelection: packages });
    const presentation = readEffectiveExtensionContext(effective);
    if (!presentation) denied();
    const tools = await getPiTools(identity.userId, actor.identity.agentId, identity.sessionId,
      { executionContext: effective, strictAuthorization: true, metadataOnlyExternal: true,
        planningMode: intent.context?.planningMode === true });
    // Use the actual runtime renderer, including explicit child-Skill paths.
    appendEffectiveExtensionContextPrompt('', effective, tools, '\ud800'.repeat(EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS));
    const payload = parseStoredAcceptedChatMessage({ version: 1, kind: 'accepted_chat_message', identity: actor.identity,
      serverMessageId, clientMessageId: id, mode: intent.mode,
      message: { role: 'user', content: intent.content, timestamp }, context: intent.context ?? {}, extensionSelection: accepted,
      ...(intent.body === undefined ? {} : { body: intent.body }) });
    if (canonicalAcceptedMessageIntentHash({ content: payload.message.content, context: payload.context, mode: payload.mode,
      selection: payload.extensionSelection?.publicSelection ?? null, ...(payload.body === undefined ? {} : { body: payload.body }) }) !== hash) corrupt();
    const admission = Object.freeze({ kind: 'prepared_chat_message_admission' as const });
    records.prepared.set(admission, { payload, hash, actor, intake, intakeContext, runtimeContext, packages,
      workflowProjection: presentation.workflowProjection });
    return { kind: 'prepared', admission };
  } catch (error) {
    // Another identical request may have committed while this one's old receipt
    // expired or its source preparation failed. Matching durable replay wins.
    const retry = await openDb();
    try {
      const current = await readActor(retry, identity), existing = await receipt(retry, current, id);
      if (existing) return { kind: 'replay', message: issueOwned(current, existing, hash) };
    } finally { await retry.close(); }
    throw error;
  }
}

function replacementConflict(): never {
  throw new AgentWorkflowError('MESSAGE_EXECUTION_CONFLICT', 'The expected replacement queue changed. Refresh before replacing it.', 409);
}
function replacementTargets(prepared: PreparedRecord, messages: readonly OwnedAcceptedChatMessage[]): readonly ReplacementTarget[] {
  if (!Array.isArray(messages) || messages.length > 128) replacementConflict();
  const targets = messages.map(message => {
    const record = message && typeof message === 'object' ? records.owned.get(message) : undefined;
    if (!record || record.sessionDbId !== prepared.actor.sessionDbId
      || JSON.stringify(record.payload.identity) !== JSON.stringify(prepared.payload.identity)) denied();
    if (record.payload.clientMessageId === prepared.payload.clientMessageId || record.phase !== 'queued'
      || record.runtimeToken !== 'unclaimed' || record.executionRevision >= Number.MAX_SAFE_INTEGER) replacementConflict();
    const previous = executionSnapshot(record);
    return Object.freeze({ message, previous, desired: Object.freeze({ ...previous,
      phase: 'cancelled' as const, executionRevision: previous.executionRevision + 1 }) });
  });
  if (new Set(targets.map(target => target.previous.payload.clientMessageId)).size !== targets.length) replacementConflict();
  return Object.freeze(targets);
}
async function verifyReplacement(database: SqlConnection, targets: readonly ReplacementTarget[]): Promise<void> {
  const { sameDurableChatMessageState, readCurrentDurableChatMessageWithUse } = await import('./durable-message-row-state');
  for (const target of targets) {
    const actual = await readCurrentDurableChatMessageWithUse(database, target.previous);
    if (!sameDurableChatMessageState(actual.snapshot, target.desired)) replacementConflict();
  }
}
function cancellationUpdate(target: ReplacementTarget): ChatMessageQueueUpdate {
  const snapshot = target.desired;
  return Object.freeze({ serverMessageId: snapshot.payload.serverMessageId, clientMessageId: snapshot.payload.clientMessageId,
    phase: snapshot.phase, executionRevision: snapshot.executionRevision, queue: snapshot.queue });
}

/** A new admission and the exact old queued set share one source-fenced commit. */
export async function commitPreparedChatMessageReplacement(admission: PreparedChatMessageAdmission,
  messages: readonly OwnedAcceptedChatMessage[], options: Readonly<{ lane?: 'prompt' | 'follow_up' }> = {}): Promise<Readonly<{
    message: OwnedAcceptedChatMessage; cancelled: readonly ChatMessageQueueUpdate[];
  }>> {
  const prepared = admission && typeof admission === 'object' ? records.prepared.get(admission) : undefined;
  if (!prepared) denied();
  const targets = replacementTargets(prepared, messages);
  const message = await commitPreparedChatMessageAdmission(admission,
    { lane: options.lane ?? 'prompt', replacement: targets.map(target => target.message) });
  return Object.freeze({ message, cancelled: Object.freeze(targets.map(cancellationUpdate)) });
}

/** Atomic admission kernel. Replacement targets are server-internal genuine SQL handles. */
export async function commitPreparedChatMessageAdmission(admission: PreparedChatMessageAdmission,
  options: Readonly<{ lane?: ChatMessageQueueLane; replacement?: readonly OwnedAcceptedChatMessage[] }> = {}): Promise<OwnedAcceptedChatMessage> {
  const prepared = admission && typeof admission === 'object' ? records.prepared.get(admission) : undefined;
  if (!prepared) denied();
  const { payload, hash } = prepared;
  const targets = options.replacement === undefined ? null : replacementTargets(prepared, options.replacement);
  const lane = options.lane ?? (payload.mode === 'steer' ? 'steer' : 'prompt');
  if (!['prompt', 'follow_up', 'steer'].includes(lane) || (payload.mode === 'steer') !== (lane === 'steer')) {
    throw new AgentWorkflowError('AGENT_MESSAGE_ADMISSION_INVALID', 'The initial queue lane does not match the admitted message mode.', 400);
  }
  const identity = { userId: payload.identity.userId, sessionId: payload.identity.sessionId, clientMessageId: payload.clientMessageId,
    expectedAgentId: payload.identity.agentId, expectedWorkspaceId: payload.identity.workspaceId };
  const database = await openDb();
  let discardError: Error | undefined;
  let closed = false, commitAttempted = false;
  let commitResult: OwnedAcceptedChatMessage | undefined;
  const commit = async (message: OwnedAcceptedChatMessage) => {
    commitResult = message; commitAttempted = true; await database.run('COMMIT');
  };
  const replay = async (connection: SqlConnection, actor: ActorFrame, row: ReceiptRow): Promise<OwnedAcceptedChatMessage> => {
    const message = issueOwned(actor, row, hash);
    if (targets) await verifyReplacement(connection, targets);
    return message;
  };
  try {
    await database.run('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const actor = await readActor(database, identity), previous = await receipt(database, actor, payload.clientMessageId);
    if (previous) {
      const message = await replay(database, actor, previous); await commit(message); return message;
    }
    const insert = async (): Promise<OwnedAcceptedChatMessage> => {
      // The outer fence holds all shared connections in one global order,
      // then personal sources and packages, before these Agent/session locks.
      if (!await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [payload.identity.agentId])) denied();
      await holdAgentGrantAuthority(database, { userId: payload.identity.userId, source: 'system',
        sourceAgentId: payload.identity.agentId, sessionId: payload.identity.sessionId,
        organizationId: payload.identity.organizationId, workspaceId: payload.identity.workspaceId,
        projectId: payload.identity.projectId }, prepared.packages.snapshot.agent);
      await database.all('SELECT agent_id FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2 FOR SHARE',
        [payload.identity.agentId, payload.identity.userId]);
      // Keep the exact stored assignment alive through COMMIT and repeat Use.
      const current = await readActor(database, identity, true);
      if (current.sessionDbId !== prepared.actor.sessionDbId || actorStamp(current.context) !== actorStamp(prepared.actor.context)) denied();
      const existing = await receipt(database, current, payload.clientMessageId);
      if (existing) return replay(database, current, existing);
      await assertNoHistoricalMessage(database, current, payload.clientMessageId);
      // Allocate under the exclusive Session lock, after all source/Agent locks.
      // Never upgrade a held Session SHARE lock in a concurrent admission.
      const maximum = await database.get(`UPDATE pi_sessions SET message_queue_ordinal=message_queue_ordinal+1
        WHERE id=$1 AND message_queue_ordinal<9007199254740991 RETURNING message_queue_ordinal AS ordinal`,
      [current.sessionDbId]) as { ordinal: unknown } | undefined;
      const ordinal = Number(maximum?.ordinal);
      if (!Number.isSafeInteger(ordinal) || ordinal < 1) corrupt();
      const now = Date.now();
      const inserted = await database.get(`INSERT INTO pi_message_delivery_receipts
        (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,created_at,updated_at,
         payload_version,private_payload,execution_phase,execution_revision,queue_lane,queue_ordinal,queue_disposition)
        VALUES ($1,$2,$3,'unclaimed','accepted',$4,$4,1,$5,'queued',1,$6,$7,'ready')
        ON CONFLICT (pi_session_db_id,client_message_id) DO NOTHING
        RETURNING client_message_id,payload_hash,state,payload_version,private_payload,execution_phase,execution_revision,runtime_token,
          queue_lane,queue_ordinal,queue_disposition`,
      [current.sessionDbId, payload.clientMessageId, hash, now, JSON.stringify(payload), lane, ordinal]) as ReceiptRow | undefined;
      const row = inserted ?? await receipt(database, current, payload.clientMessageId);
      if (!row) corrupt();
      if (!inserted) return replay(database, current, row);
      if (targets?.length) {
        const { cancelOwnedQueuedChatMessagesOnConnection } = await import('./durable-message-queue');
        await cancelOwnedQueuedChatMessagesOnConnection(database, targets.map(target => target.message), current.sessionDbId);
        await verifyReplacement(database, targets);
      }
      return issueOwned(current, row, hash);
    };
    const additionalSharedRefs = (payload.extensionSelection?.privateFixedBindings ?? [])
      .flatMap(binding => binding.entry.target.kind === 'shared' ? [binding.entry.target.connectionRef] : []);
    const packagesAndAgent = () => withRevalidatedAgentWorkflowPackageSelectionOnConnection(database,
      prepared.runtimeContext, prepared.packages, insert);
    const result = await withRevalidatedAgentWorkflowProjectionSourcesOnConnection(database, prepared.runtimeContext,
      prepared.workflowProjection, { additionalSharedRefs }, () => prepared.intake
        ? withRevalidatedAcceptedTurnExtensionSelectionOnConnection(database, prepared.intakeContext, prepared.intake, packagesAndAgent)
        : packagesAndAgent());
    await commit(result);
    return result;
  } catch (error) {
    if (commitAttempted) {
      // A failed COMMIT response does not reveal whether it committed. Discard
      // before any recovery checkout; never retry or return this lease normally.
      closed = true;
      try { await database.close(new Error('Discarding unconfirmed message admission commit.', { cause: error })); }
      catch (discardFailure) {
        throw new AggregateError([error, discardFailure], 'Message admission commit connection could not be discarded.');
      }
      const recovery = await openDb();
      try {
        const current = await readActor(recovery, identity), existing = await receipt(recovery, current, payload.clientMessageId);
        if (!existing || !commitResult) throw new AgentWorkflowError('MESSAGE_EXECUTION_UNCERTAIN', 'The message admission could not be confirmed. Refresh before retrying.', 409);
        try {
          const message = await replay(recovery, current, existing);
          const { sameDurableChatMessageState } = await import('./durable-message-row-state');
          // Pin the actual pre-COMMIT result, including a concurrent winner's
          // Server ID. A later claim/control needs a readonly refresh instead.
          if (!sameDurableChatMessageState(readOwnedChatMessageExecutionSnapshot(message), readOwnedChatMessageExecutionSnapshot(commitResult))) {
            throw new AgentWorkflowError('MESSAGE_EXECUTION_UNCERTAIN', 'The admitted message changed before confirmation. Refresh its state.', 409);
          }
          return message;
        }
        catch (proofError) {
          if (proofError instanceof AgentWorkflowError && proofError.code === 'MESSAGE_EXECUTION_CONFLICT') {
            throw new AgentWorkflowError('MESSAGE_EXECUTION_UNCERTAIN', 'The complete replacement could not be confirmed. Refresh its state.', 409);
          }
          throw proofError;
        }
      } finally { await recovery.close(); }
    }
    let rolledBack = false;
    try { await database.run('ROLLBACK'); rolledBack = true; }
    catch (rollbackError) {
      // A lease whose transaction end is unknown must never return to the pool.
      discardError = rollbackError instanceof Error ? rollbackError : new Error('Message admission rollback could not be confirmed.');
    }
    if (rolledBack) {
      try {
        // A concurrent identical claimant may have won the unique key or a
        // serializable race. Confirm that actual committed row on a fresh
        // snapshot; never rerun source preparation or dispatch here.
        const actor = await readActor(database, identity), existing = await receipt(database, actor, payload.clientMessageId);
        if (existing) return await replay(database, actor, existing);
      } catch (replayError) {
        if (replayError instanceof MessageDeliveryError || replayError instanceof AgentWorkflowError) throw replayError;
      }
      // Only a confirmed pre-COMMIT rollback is a normal optimistic conflict.
      // Never reinterpret an unconfirmed COMMIT or retry a business action.
      if (error && typeof error === 'object' && 'code' in error && (error.code === '40001' || error.code === '40P01')) {
        throw new AgentWorkflowError('MESSAGE_EXECUTION_CONFLICT', 'The message session changed concurrently. Refresh before retrying.', 409);
      }
    }
    throw error;
  }
  finally { if (!closed) await database.close(discardError); }
}
