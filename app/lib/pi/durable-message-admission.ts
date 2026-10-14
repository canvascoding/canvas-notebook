import 'server-only';

import { randomUUID } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { resolveVerifiedAgentActorContextOnConnection } from '@/app/lib/agents/actor-context';
import { holdAgentGrantAuthority } from '@/app/lib/agents/workflow-configuration';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { withRevalidatedAgentWorkflowProjectionSourcesOnConnection,
  type AgentWorkflowRuntimeProjection } from '@/app/lib/agents/workflow-runtime';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import {
  canonicalMessageIntentHash, captureChatMessageAdmissionRequest, parseCanonicalMessageIntent, parseStoredAcceptedChatMessage,
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

export type ChatMessageExecutionPhase = 'queued' | 'dispatching' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
export type PreparedChatMessageAdmission = Readonly<{ kind: 'prepared_chat_message_admission' }>;
/** Provenance of an actual owned SQL row. This is not permission to execute it. */
export type OwnedAcceptedChatMessage = Readonly<{ kind: 'owned_accepted_chat_message' }>;
type MessageIdentity = StoredAcceptedChatMessage['identity'];
export type ChatMessageAdmissionIdentity = { userId: string; sessionId: string; clientMessageId: string;
  expectedAgentId?: string; expectedWorkspaceId?: string };
export type ChatMessageAdmissionInput = ChatMessageAdmissionIdentity & {
  message: StoredAcceptedChatMessage['message']; context?: ChatRequestContext | null;
  mode?: 'message' | 'steer'; selection?: unknown;
};
type ActorFrame = { sessionDbId: number; identity: MessageIdentity; context: AgentExecutionContext };
type ReceiptRow = { client_message_id: string; payload_hash: string; state: string; payload_version: unknown;
  private_payload: unknown; execution_phase: unknown; execution_revision: unknown };
type PreparedRecord = { payload: StoredAcceptedChatMessage; hash: string; actor: ActorFrame;
  intake: AcceptedTurnExtensionSelection | null; intakeContext: AgentExecutionContext;
  runtimeContext: AgentExecutionContext; packages: AuthorizedAgentWorkflowPackageSelections;
  workflowProjection: AgentWorkflowRuntimeProjection | null };
type OwnedRecord = { payload: StoredAcceptedChatMessage; hash: string; sessionDbId: number;
  phase: ChatMessageExecutionPhase; executionRevision: number; actor: ActorFrame };
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
    WHERE user_id=$1 AND session_id=$2 AND archived_at IS NULL LIMIT 1${lockSession ? ' FOR SHARE' : ''}`,
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

function issueOwned(actor: ActorFrame, row: ReceiptRow, expectedHash?: string): OwnedAcceptedChatMessage {
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
  const hash = canonicalMessageIntentHash({ content: payload.message.content, context: payload.context, mode: payload.mode,
    selection: payload.extensionSelection?.publicSelection ?? null });
  if (hash !== row.payload_hash) corrupt();
  const phase = row.execution_phase as ChatMessageExecutionPhase, executionRevision = Number(row.execution_revision);
  if (!phases.has(phase) || !Number.isSafeInteger(executionRevision) || executionRevision < 1) corrupt();
  const handle = Object.freeze({ kind: 'owned_accepted_chat_message' as const });
  records.owned.set(handle, { payload, hash, sessionDbId: actor.sessionDbId, phase, executionRevision, actor });
  return handle;
}

async function receipt(database: SqlConnection, actor: ActorFrame, id: string): Promise<ReceiptRow | undefined> {
  return await database.get(`SELECT client_message_id,payload_hash,state,payload_version,private_payload,execution_phase,execution_revision
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
  const id = clientId(input.clientMessageId), captured = { ...input };
  const database = await openDb();
  try {
    const actor = await readActor(database, captured), row = await receipt(database, actor, id);
    return row ? issueOwned(actor, row) : null;
  } finally { await database.close(); }
}

/** Private provenance metadata only. Every later dispatch must recheck current execution authority. */
export function readOwnedAcceptedChatMessageData(handle: OwnedAcceptedChatMessage, context: AgentExecutionContext): Readonly<{
  payload: StoredAcceptedChatMessage; phase: ChatMessageExecutionPhase; executionRevision: number;
}> {
  const record = handle && typeof handle === 'object' ? records.owned.get(handle) : undefined;
  if (!record || actorStamp(record.actor.context) !== actorStamp(context)
    || context.agentTurnId !== undefined && context.agentTurnId !== record.payload.serverMessageId) denied();
  return Object.freeze({ payload: record.payload, phase: record.phase, executionRevision: record.executionRevision });
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
    mode: captured.mode, selection: receiptFreeChatExtensionSelection(selectionInput) });
  const timestamp = captured.message.timestamp;
  const hash = canonicalMessageIntentHash(intent);
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
      message: { role: 'user', content: intent.content, timestamp }, context: intent.context ?? {}, extensionSelection: accepted });
    if (canonicalMessageIntentHash({ content: payload.message.content, context: payload.context, mode: payload.mode,
      selection: payload.extensionSelection?.publicSelection ?? null }) !== hash) corrupt();
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

/** Atomic payload/identity admission only. Existing runtime queues are attached in the next integration step. */
export async function commitPreparedChatMessageAdmission(admission: PreparedChatMessageAdmission): Promise<OwnedAcceptedChatMessage> {
  const prepared = admission && typeof admission === 'object' ? records.prepared.get(admission) : undefined;
  if (!prepared) denied();
  const { payload, hash } = prepared;
  const identity = { userId: payload.identity.userId, sessionId: payload.identity.sessionId, clientMessageId: payload.clientMessageId,
    expectedAgentId: payload.identity.agentId, expectedWorkspaceId: payload.identity.workspaceId };
  const database = await openDb();
  let discardError: Error | undefined;
  try {
    await database.run('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const actor = await readActor(database, identity), previous = await receipt(database, actor, payload.clientMessageId);
    if (previous) {
      const replay = issueOwned(actor, previous, hash); await database.run('COMMIT'); return replay;
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
      if (existing) return issueOwned(current, existing, hash);
      await assertNoHistoricalMessage(database, current, payload.clientMessageId);
      const now = Date.now();
      const inserted = await database.get(`INSERT INTO pi_message_delivery_receipts
        (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,created_at,updated_at,
         payload_version,private_payload,execution_phase,execution_revision)
        VALUES ($1,$2,$3,'unclaimed','accepted',$4,$4,1,$5,'queued',1)
        ON CONFLICT (pi_session_db_id,client_message_id) DO NOTHING
        RETURNING client_message_id,payload_hash,state,payload_version,private_payload,execution_phase,execution_revision`,
      [current.sessionDbId, payload.clientMessageId, hash, now, JSON.stringify(payload)]) as ReceiptRow | undefined;
      const row = inserted ?? await receipt(database, current, payload.clientMessageId);
      if (!row) corrupt();
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
    await database.run('COMMIT');
    return result;
  } catch (error) {
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
        if (existing) return issueOwned(actor, existing, hash);
      } catch (replayError) {
        if (replayError instanceof MessageDeliveryError || replayError instanceof AgentWorkflowError) throw replayError;
      }
    }
    throw error;
  }
  finally { await database.close(discardError); }
}
