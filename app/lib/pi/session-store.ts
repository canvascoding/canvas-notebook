import { db, getDatabaseProvider, openDb, type SqlConnection } from '../db';
import { legacyAiTablesExist } from '../db/legacy-ai-tables';
import { toDatabaseTimestamp } from '../db/timestamps';
import { piSessions, piMessages, aiSessions, aiMessages, sessionChannelLinks } from '../db/schema';
import { eq, and, asc, desc } from 'drizzle-orm';
import { type AgentMessage } from '@earendil-works/pi-agent-core';
import { type PiSessionSummaryState } from './history-budget';
import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';
import { piSessionReadCursorSql } from '@/app/lib/chat/read-cursor';
import {
  createSessionTitleFallback,
  DEFAULT_PI_SESSION_TITLE,
  isAutomaticSessionTitle,
  isSessionTitleGenerating,
  type PiSessionTitleGenerationState,
} from './session-titles';
import {
  createPiSystemPromptSnapshot,
  piSystemPromptSnapshotDbFields,
  type PiSystemPromptSnapshot,
} from './system-prompt-snapshot';
import { parsePersistedPiMessage, type PiMessageProjectionMode } from './message-projection';
import { projectAgentMessageForPersistence } from './visual-data-projection';
import { ensureSessionChannelLink } from '@/app/lib/channels/channel-links';
import { DEFAULT_AGENT_ID, normalizeChannelThreadKey, normalizeStoredChannelId, WEB_CHANNEL_ID, webChannelSessionKey } from '@/app/lib/channels/constants';
import {
  resolveAgentSessionWorkspaceForUser,
  type PiSessionWorkspaceFields,
  workspaceToPiSessionFields,
} from '@/app/lib/pi/session-workspace-context';
import {
  piSessionRuntimeSnapshotDbFields,
  SessionRuntimeContextRevisionConflictError,
  SessionRuntimeSnapshotConflictError,
} from '@/app/lib/agent-runtime-policy/runtime-store';
import type { AiSessionRuntimeSnapshot } from '@/app/lib/agent-runtime-policy/types';
import {
  findUnambiguousOwnedPiSessionForRuntime,
  PiSessionRuntimeAccessError,
} from '@/app/lib/pi/session-runtime-access';
import { deletePiSessionsByDbIds } from './session-deletion';

/**
 * Handles persistence for PI session snapshots (AgentMessage context).
 */

function storedRevision(value: unknown): number {
  const revision = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function resolveSessionAgentId(agentId?: string | null): string {
  return agentId?.trim() || DEFAULT_AGENT_ID;
}

function buildPiSessionLookup(sessionId: string, userId: string, agentId?: string | null) {
  return and(
    eq(piSessions.sessionId, sessionId),
    eq(piSessions.userId, userId),
    eq(piSessions.agentId, resolveSessionAgentId(agentId)),
  );
}

function extractFirstUserText(messages: AgentMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  if (!firstUserMessage) {
    return '';
  }

  if (typeof firstUserMessage.content === 'string') {
    return firstUserMessage.content;
  }

  if (!Array.isArray(firstUserMessage.content)) {
    return '';
  }

  const firstTextPart = firstUserMessage.content.find((part) => {
    return typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && typeof (part as { text?: unknown }).text === 'string';
  }) as { text: string } | undefined;

  return firstTextPart?.text ?? '';
}

function deriveSessionTitle(messages: AgentMessage[]): string {
  return createSessionTitleFallback(extractFirstUserText(messages));
}

function getAgentMessageTimestamp(message: AgentMessage): number {
  if ('timestamp' in message && typeof message.timestamp === 'number') {
    return message.timestamp;
  }

  return Date.now();
}

function attachPersistedSequence(message: AgentMessage, sequence: number): AgentMessage {
  return {
    ...(message as unknown as Record<string, unknown>),
    sequence,
  } as unknown as AgentMessage;
}

export type CreatePiSessionWithRuntimeSnapshotInput = {
  sessionId: string;
  clientRequestId?: string;
  userId: string;
  agentId: string;
  title: string;
  titleGenerationState?: PiSessionTitleGenerationState;
  workspace: PiSessionWorkspaceFields;
  runtimeSnapshot: AiSessionRuntimeSnapshot;
  systemPromptSnapshot: PiSystemPromptSnapshot;
  delegation?: {
    id: string;
    parentSessionId: string;
    depth: 1;
  };
};

export type InsertPiSessionWithRuntimeSnapshotResult = {
  id: number | string;
  created: boolean;
};

export class PiSessionClientRequestConflictError extends Error {
  constructor() {
    super('The client request ID was already used for a different session.');
    this.name = 'PiSessionClientRequestConflictError';
  }
}

function storedRuntimeSnapshotMatches(
  session: typeof piSessions.$inferSelect,
  input: CreatePiSessionWithRuntimeSnapshotInput,
): boolean {
  return session.organizationId === input.workspace.organizationId
    && session.workspaceId === input.workspace.workspaceId
    && session.workspaceType === input.workspace.workspaceType
    && session.runtimeProviderInstallationId === input.runtimeSnapshot.selection.providerInstallationId
    && session.provider === input.runtimeSnapshot.selection.providerId
    && session.model === input.runtimeSnapshot.selection.modelId
    && session.thinkingLevel === input.runtimeSnapshot.selection.thinkingLevel
    && session.runtimeCatalogRevision === input.runtimeSnapshot.catalogRevision
    && session.runtimePolicyRevision === input.runtimeSnapshot.policyRevision
    && session.runtimeSelectionSource === input.runtimeSnapshot.selectionSource;
}

export async function lockPiSessionCreationForUser(
  connection: SqlConnection,
  userId: string,
): Promise<void> {
  const forUpdate = getDatabaseProvider() === 'postgres' ? ' FOR UPDATE' : '';
  const actor = await connection.get(
    `SELECT id FROM "user" WHERE id = ? LIMIT 1${forUpdate}`,
    [userId],
  ) as { id?: string } | undefined;
  if (!actor?.id) {
    throw new Error('Session owner not found.');
  }
}

export async function withPiSessionUserStateLock<T>(
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedOperationLock('pi-session-user-state', JSON.stringify([userId]), operation);
}

/**
 * Inserts a runtime-pinned session on a caller-owned transaction/connection.
 * The caller must first serialize creation with lockPiSessionCreationForUser.
 */
export async function insertPiSessionWithRuntimeSnapshotOnConnection(
  connection: SqlConnection,
  input: CreatePiSessionWithRuntimeSnapshotInput,
): Promise<InsertPiSessionWithRuntimeSnapshotResult> {
  if (!input.workspace.organizationId) {
    throw new Error('Organization setup is required for an AI runtime session.');
  }
  const delegation = input.delegation;
  if (delegation && (!delegation.id.trim() || !delegation.parentSessionId.trim() || delegation.depth !== 1)) {
    throw new Error('Delegated worker sessions require a parent session, delegation ID, and depth 1.');
  }

  if (input.clientRequestId) {
    const requestRows = await connection.all(
      `SELECT id, agent_id, workspace_id
       FROM pi_sessions
       WHERE user_id = ? AND client_request_id = ?
       ORDER BY id ASC
       LIMIT 2`,
      [input.userId, input.clientRequestId],
    ) as Array<{ id?: number | string; agent_id?: string; workspace_id?: string | null }>;
    if (requestRows.length > 1) throw new PiSessionClientRequestConflictError();
    const existingRequest = requestRows[0];
    if (existingRequest?.id !== undefined) {
      if (existingRequest.agent_id !== input.agentId || existingRequest.workspace_id !== input.workspace.workspaceId) {
        throw new PiSessionClientRequestConflictError();
      }
      return { id: existingRequest.id, created: false };
    }
  }

  const existingRows = await connection.all(
    `SELECT id, agent_id
     FROM pi_sessions
     WHERE session_id = ? AND user_id = ?
     ORDER BY id ASC
     LIMIT 2`,
    [input.sessionId, input.userId],
  ) as Array<{ id?: number | string; agent_id?: string }>;
  if (existingRows.length > 1) {
    throw new PiSessionRuntimeAccessError(
      'Agent session ID is ambiguous across multiple agents.',
      'SESSION_AMBIGUOUS',
    );
  }
  const existing = existingRows[0];
  if (existing?.id !== undefined) {
    if (existing.agent_id !== input.agentId) {
      throw new PiSessionRuntimeAccessError(
        'Agent session ID already belongs to a different agent.',
        'SESSION_AGENT_MISMATCH',
      );
    }
    return { id: existing.id, created: false };
  }

  const now = toDatabaseTimestamp(new Date());
  const inserted = await connection.get(
    `INSERT INTO pi_sessions (
         session_id, client_request_id, user_id, agent_id, provider, model, thinking_level, title, title_generation_state,
         created_at, updated_at, system_prompt_snapshot, system_prompt_snapshot_hash,
         system_prompt_snapshot_created_at, channel_id, channel_session_key,
         session_kind, parent_session_id, delegation_id, delegation_depth,
         organization_id, customer_id, project_id, workspace_id, workspace_type,
         workspace_name, workspace_root_relative_path, runtime_provider_installation_id,
         runtime_catalog_revision, runtime_policy_revision, runtime_selection_source
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'app', NULL, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE COALESCE((
         SELECT catalog_revision
         FROM ai_runtime_defaults
         WHERE organization_id = ?
         LIMIT 1
       ), 0) = ?
       AND COALESCE((
         SELECT revision
         FROM ai_workspace_model_policies
         WHERE organization_id = ? AND workspace_id = ?
         LIMIT 1
       ), 0) = ?
       RETURNING id`,
    [
      input.sessionId,
      input.clientRequestId ?? null,
      input.userId,
      input.agentId,
      input.runtimeSnapshot.selection.providerId,
      input.runtimeSnapshot.selection.modelId,
      input.runtimeSnapshot.selection.thinkingLevel,
      input.title,
      input.titleGenerationState ?? 'manual',
      now,
      now,
      input.systemPromptSnapshot.systemPrompt,
      input.systemPromptSnapshot.systemPromptHash,
      toDatabaseTimestamp(input.systemPromptSnapshot.systemPromptCreatedAt),
      delegation ? 'delegation_worker' : 'conversation',
      delegation?.parentSessionId.trim() || null,
      delegation?.id.trim() || null,
      delegation?.depth ?? 0,
      input.workspace.organizationId,
      input.workspace.customerId,
      input.workspace.projectId,
      input.workspace.workspaceId,
      input.workspace.workspaceType,
      input.workspace.workspaceName,
      input.workspace.workspaceRootRelativePath,
      input.runtimeSnapshot.selection.providerInstallationId,
      input.runtimeSnapshot.catalogRevision,
      input.runtimeSnapshot.policyRevision,
      input.runtimeSnapshot.selectionSource,
      input.workspace.organizationId,
      input.runtimeSnapshot.catalogRevision,
      input.workspace.organizationId,
      input.workspace.workspaceId,
      input.runtimeSnapshot.policyRevision,
    ],
  ) as { id?: number | string } | undefined;

  if (inserted?.id === undefined) {
    const catalogRow = await connection.get(
      `SELECT catalog_revision AS revision
         FROM ai_runtime_defaults
         WHERE organization_id = ?
         LIMIT 1`,
      [input.workspace.organizationId],
    ) as { revision?: number | string | null } | undefined;
    const policyRow = await connection.get(
      `SELECT revision
         FROM ai_workspace_model_policies
         WHERE organization_id = ? AND workspace_id = ?
         LIMIT 1`,
      [input.workspace.organizationId, input.workspace.workspaceId],
    ) as { revision?: number | string | null } | undefined;
    throw new SessionRuntimeContextRevisionConflictError(
      storedRevision(catalogRow?.revision),
      storedRevision(policyRow?.revision),
    );
  }

  return { id: inserted.id, created: true };
}

export async function createPiSessionWithRuntimeSnapshot(
  input: CreatePiSessionWithRuntimeSnapshotInput,
): Promise<typeof piSessions.$inferSelect> {
  return withPiSessionUserStateLock(input.userId, async () => {
    const connection = await openDb();
    let transactionStarted = false;
    let insertResult: InsertPiSessionWithRuntimeSnapshotResult | null = null;
    try {
      await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      transactionStarted = true;
      await lockPiSessionCreationForUser(connection, input.userId);
      insertResult = await insertPiSessionWithRuntimeSnapshotOnConnection(connection, input);
      await connection.run('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.run('ROLLBACK');
        } catch {
          // Preserve the original session creation error.
        }
      }
      throw error;
    } finally {
      await connection.close?.();
    }

    const session = insertResult
      ? await db.query.piSessions.findFirst({ where: eq(piSessions.id, insertResult.id as number) })
      : null;
    if (!session) throw new Error('Session could not be loaded after creation.');
    if (insertResult && !insertResult.created && !input.clientRequestId && !storedRuntimeSnapshotMatches(session, input)) {
      throw new SessionRuntimeSnapshotConflictError();
    }
    return session;
  });
}

export async function savePiSession(
  sessionId: string,
  userId: string,
  provider: string,
  model: string,
  messages: AgentMessage[],
  summary?: PiSessionSummaryState,
  options?: {
    titleOverride?: string | null;
    persistedLength?: number;
    channelId?: string;
    channelSessionKey?: string | null;
    channelThreadKey?: string | null;
    agentId?: string | null;
    workspaceId?: string | null;
    runtimeSnapshot?: AiSessionRuntimeSnapshot;
    systemPromptSnapshot?: PiSystemPromptSnapshot;
    expectedSummaryRevision?: number;
  },
): Promise<PiSessionSaveResult> {
  const agentId = resolveSessionAgentId(options?.agentId);
  const session = await findUnambiguousOwnedPiSessionForRuntime({ sessionId, userId });
  if (session && session.agentId !== agentId) {
    throw new PiSessionRuntimeAccessError(
      'Agent session ID already belongs to a different agent.',
      'SESSION_AGENT_MISMATCH',
    );
  }
  const derivedTitle = deriveSessionTitle(messages);
  const normalizedTitleOverride = options?.titleOverride?.trim() || null;

  let sessionDbId: number;
  let persistedTitle: string;

  const summaryChanged = Boolean(summary && session && (
    (summary.summaryText ?? null) !== (session.summaryText ?? null)
    || (summary.summaryUpdatedAt?.getTime() ?? null) !== (session.summaryUpdatedAt?.getTime() ?? null)
    || (summary.summaryThroughTimestamp ?? null) !== (session.summaryThroughTimestamp ?? null)
    || (summary.summaryThroughSequence ?? null) !== (session.summaryThroughSequence ?? null)
  ));
  if (summaryChanged && options?.expectedSummaryRevision === undefined) {
    throw new Error('Summary persistence requires an explicit expectedSummaryRevision fence.');
  }
  if (
    summaryChanged
    && (summary!.summaryRevision !== options?.expectedSummaryRevision
      || options.expectedSummaryRevision !== session!.summaryRevision)
  ) {
    throw new Error('Summary persistence revision conflict.');
  }
  const insertedSummaryRevision = summary?.summaryText
    ? summary.summaryRevision + 1
    : summary?.summaryRevision ?? 0;
  const summaryFields = summary
    ? {
        summaryText: summary.summaryText ?? null,
        summaryUpdatedAt: summary.summaryUpdatedAt ?? null,
        summaryThroughTimestamp: summary.summaryThroughTimestamp ?? null,
        summaryThroughSequence: summary.summaryThroughSequence ?? null,
        summaryRevision: session ? session.summaryRevision : insertedSummaryRevision,
      }
    : {};

  const startIndex = options?.persistedLength ?? 0;
  const newMessages = messages.slice(startIndex);
  const hasNewAssistantMessage = newMessages.some((message) => message.role === 'assistant');
  const shouldMarkAssistantActivity = hasNewAssistantMessage && (!session || options?.persistedLength !== undefined || !session.lastMessageAt);
  const assistantActivityAt = shouldMarkAssistantActivity ? new Date() : null;
  const lastMessageAt = assistantActivityAt ?? session?.lastMessageAt ?? null;

  if (!session) {
    persistedTitle = normalizedTitleOverride || derivedTitle;
    const promptSnapshot = options?.systemPromptSnapshot ?? await createPiSystemPromptSnapshot(agentId, { userId });
    const workspace = await resolveAgentSessionWorkspaceForUser({ userId, workspaceId: options?.workspaceId ?? null });
    const [inserted] = await db.insert(piSessions).values({
      sessionId,
      userId,
      agentId,
      provider,
      model,
      ...(options?.runtimeSnapshot ? piSessionRuntimeSnapshotDbFields(options.runtimeSnapshot) : {}),
      title: persistedTitle,
      titleGenerationState: normalizedTitleOverride ? 'manual' : 'fallback',
      channelId: 'app',
      channelSessionKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastMessageAt: lastMessageAt,
      lastViewedAt: null,
      ...workspaceToPiSessionFields(workspace),
      ...piSystemPromptSnapshotDbFields(promptSnapshot),
      ...summaryFields,
    }).returning({ id: piSessions.id });
    sessionDbId = inserted.id;
  } else {
    sessionDbId = session.id;
    persistedTitle = normalizedTitleOverride || (
      isSessionTitleGenerating(session.titleGenerationState)
        ? session.title || DEFAULT_PI_SESSION_TITLE
        : isAutomaticSessionTitle(session.title)
          ? derivedTitle
          : session.title || derivedTitle
    );
    const nextTitleGenerationState = normalizedTitleOverride
      ? 'manual'
      : session.titleGenerationState ?? (isAutomaticSessionTitle(session.title) ? 'fallback' : null);
    const promptSnapshotFields = session.systemPromptSnapshot
      ? {}
      : piSystemPromptSnapshotDbFields(options?.systemPromptSnapshot ?? await createPiSystemPromptSnapshot(agentId, { userId }));
    const workspaceFields = session.workspaceId
      ? {}
      : workspaceToPiSessionFields(await resolveAgentSessionWorkspaceForUser({ userId, workspaceId: options?.workspaceId ?? null }));
    const runtimeFields = session.runtimeProviderInstallationId || !options?.runtimeSnapshot
      ? {}
      : piSessionRuntimeSnapshotDbFields(options.runtimeSnapshot);

    const updatedRows = await db.update(piSessions)
      .set({ 
        updatedAt: new Date(), 
        title: persistedTitle,
        titleGenerationState: nextTitleGenerationState,
        lastMessageAt: lastMessageAt,
        ...workspaceFields,
        ...runtimeFields,
        ...promptSnapshotFields,
      })
      .where(eq(piSessions.id, sessionDbId))
      .returning({ summaryRevision: piSessions.summaryRevision });
    if (updatedRows.length !== 1) throw new Error('Session metadata persistence conflict.');
  }

  const normalizedChannelId = normalizeStoredChannelId(options?.channelId ?? session?.channelId ?? 'app');
  await ensureSessionChannelLink({
    sessionId,
    userId,
    channelId: normalizedChannelId,
    channelSessionKey: options?.channelSessionKey
      ?? session?.channelSessionKey
      ?? (normalizedChannelId === WEB_CHANNEL_ID ? webChannelSessionKey(userId) : `${normalizedChannelId}:unknown`),
    channelThreadKey: options?.channelThreadKey ?? null,
    displayName: persistedTitle,
    isPrimary: normalizedChannelId === WEB_CHANNEL_ID,
    outboundAt: lastMessageAt,
  });

  const projectedNewMessages = newMessages.map((message, index) => ({
    role: message.role,
    content: JSON.stringify(projectAgentMessageForPersistence(message)),
    timestamp: getAgentMessageTimestamp(message),
    sequence: startIndex + index + 1,
  }));
  const connection = await openDb();
  let transactionStarted = false;
  let sequenceCheckpoint = 0;
  try {
    await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transactionStarted = true;
    const forUpdate = getDatabaseProvider() === 'postgres' ? ' FOR UPDATE' : '';
    const locked = await connection.get(
      `SELECT id FROM pi_sessions
       WHERE id = ? AND session_id = ? AND user_id = ? AND agent_id = ?
       LIMIT 1${forUpdate}`,
      [sessionDbId, sessionId, userId, agentId],
    ) as { id?: number | string } | undefined;
    if (locked?.id === undefined) throw new PiSessionRuntimeAccessError(
      'Agent session could not be restored while saving messages.',
      'SESSION_NOT_FOUND',
    );
    const beforeAudit = await connection.get(
      `SELECT COUNT(*) AS message_count, COUNT(DISTINCT sequence) AS distinct_sequence_count,
              MIN(sequence) AS minimum_sequence, MAX(sequence) AS maximum_sequence,
              SUM(CASE WHEN sequence IS NULL THEN 1 ELSE 0 END) AS null_sequence_count
       FROM pi_messages WHERE pi_session_db_id = ?`,
      [sessionDbId],
    ) as Record<string, unknown>;
    const existingCount = Number(beforeAudit.message_count ?? 0);
    const existingDistinct = Number(beforeAudit.distinct_sequence_count ?? 0);
    const existingMinimum = beforeAudit.minimum_sequence === null ? null : Number(beforeAudit.minimum_sequence);
    const existingMaximum = beforeAudit.maximum_sequence === null ? null : Number(beforeAudit.maximum_sequence);
    const existingNulls = Number(beforeAudit.null_sequence_count ?? 0);
    const existingSequenceValid = existingCount === 0 || (
      existingDistinct === existingCount
      && existingMinimum === 1
      && existingMaximum === existingCount
      && existingNulls === 0
    );
    if (!existingSequenceValid) {
      throw new Error('Persisted PI message history has a sequence integrity conflict.');
    }
    if (startIndex > 0 && existingCount !== startIndex) {
      throw new Error('Persisted PI message sequence checkpoint changed before append.');
    }
    if (startIndex === 0) {
      await connection.run('DELETE FROM pi_messages WHERE pi_session_db_id = ?', [sessionDbId]);
    }
    for (const message of projectedNewMessages) {
      await connection.run(
        `INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
         VALUES (?, ?, ?, ?, ?)`,
        [sessionDbId, message.role, message.content, message.timestamp, message.sequence],
      );
    }
    const afterAudit = await connection.get(
      `SELECT COUNT(*) AS message_count, COUNT(DISTINCT sequence) AS distinct_sequence_count,
              MIN(sequence) AS minimum_sequence, MAX(sequence) AS maximum_sequence,
              SUM(CASE WHEN sequence IS NULL THEN 1 ELSE 0 END) AS null_sequence_count
       FROM pi_messages WHERE pi_session_db_id = ?`,
      [sessionDbId],
    ) as Record<string, unknown>;
    const finalCount = Number(afterAudit.message_count ?? 0);
    const finalDistinct = Number(afterAudit.distinct_sequence_count ?? 0);
    const finalMinimum = afterAudit.minimum_sequence === null ? null : Number(afterAudit.minimum_sequence);
    sequenceCheckpoint = afterAudit.maximum_sequence === null ? 0 : Number(afterAudit.maximum_sequence);
    const finalNulls = Number(afterAudit.null_sequence_count ?? 0);
    if (
      finalCount !== sequenceCheckpoint
      || finalDistinct !== finalCount
      || (finalCount > 0 && finalMinimum !== 1)
      || finalNulls !== 0
    ) {
      throw new Error('Persisted PI message sequence checkpoint is not durable.');
    }
    await connection.run('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original message persistence error.
      }
    }
    throw error;
  } finally {
    await connection.close();
  }

  const expectedCheckpoint = startIndex + newMessages.length;
  if (sequenceCheckpoint !== expectedCheckpoint) {
    throw new Error('Persisted PI message sequence checkpoint does not match the saved history.');
  }
  newMessages.forEach((message, index) => {
    (message as unknown as { sequence: number }).sequence = startIndex + index + 1;
  });
  if (summaryChanged) {
    const updatedSummary = await db.update(piSessions)
      .set({
        summaryText: summary!.summaryText ?? null,
        summaryUpdatedAt: summary!.summaryUpdatedAt ?? null,
        summaryThroughTimestamp: summary!.summaryThroughTimestamp ?? null,
        summaryThroughSequence: summary!.summaryThroughSequence ?? null,
        summaryRevision: options!.expectedSummaryRevision! + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(piSessions.id, sessionDbId),
        eq(piSessions.summaryRevision, options!.expectedSummaryRevision!),
      ))
      .returning({ summaryRevision: piSessions.summaryRevision });
    if (updatedSummary.length !== 1) throw new Error('Summary persistence revision conflict.');
  }
  return {
    sessionDbId,
    persistedMessageCount: newMessages.length,
    sequenceCheckpoint,
    summaryRevision: summaryChanged
      ? options!.expectedSummaryRevision! + 1
      : session?.summaryRevision ?? insertedSummaryRevision,
  };
}

export type PiSessionSaveResult = Readonly<{
  sessionDbId: number;
  persistedMessageCount: number;
  sequenceCheckpoint: number;
  summaryRevision: number;
}>;

export async function finalizePiSessionAfterNoop(input: {
  sessionId: string;
  userId: string;
  agentId?: string | null;
  retainedMessageCount: number;
  deleteSessionIfEmpty?: boolean;
  title?: string | null;
  titleGenerationState?: string | null;
  summary?: PiSessionSummaryState;
  expectedSummaryRevision?: number;
}): Promise<number> {
  const agentId = resolveSessionAgentId(input.agentId);
  const session = await findUnambiguousOwnedPiSessionForRuntime({
    sessionId: input.sessionId,
    userId: input.userId,
  });
  if (!session) {
    throw new PiSessionRuntimeAccessError(
      'Agent session could not be restored after a no-op run.',
      'SESSION_NOT_FOUND',
    );
  }
  if (session.agentId !== agentId) {
    throw new PiSessionRuntimeAccessError(
      'Agent session ID already belongs to a different agent.',
      'SESSION_AGENT_MISMATCH',
    );
  }

  const retainedMessageCount = Math.max(0, Math.floor(input.retainedMessageCount));
  if (input.deleteSessionIfEmpty && retainedMessageCount === 0) {
    await deletePiSessionsByDbIds([session.id]);
    return session.summaryRevision;
  }

  const summaryChanged = Boolean(input.summary && (
    (input.summary.summaryText ?? null) !== (session.summaryText ?? null)
    || (input.summary.summaryUpdatedAt?.getTime() ?? null) !== (session.summaryUpdatedAt?.getTime() ?? null)
    || (input.summary.summaryThroughTimestamp ?? null) !== (session.summaryThroughTimestamp ?? null)
    || (input.summary.summaryThroughSequence ?? null) !== (session.summaryThroughSequence ?? null)
  ));
  if (summaryChanged && input.expectedSummaryRevision === undefined) {
    throw new Error('Summary persistence requires an explicit expectedSummaryRevision fence.');
  }
  const connection = await openDb();
  let transactionStarted = false;
  try {
    await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transactionStarted = true;
    const forUpdate = getDatabaseProvider() === 'postgres' ? ' FOR UPDATE' : '';
    const locked = await connection.get(
      `SELECT id FROM pi_sessions
       WHERE id = ? AND session_id = ? AND user_id = ? AND agent_id = ?
       LIMIT 1${forUpdate}`,
      [session.id, input.sessionId, input.userId, agentId],
    ) as { id?: number | string } | undefined;
    if (locked?.id === undefined) throw new PiSessionRuntimeAccessError(
      'Agent session could not be restored after a no-op run.',
      'SESSION_NOT_FOUND',
    );
    const now = toDatabaseTimestamp(new Date());
    const summaryFlag = summaryChanged ? 1 : 0;
    const titleFlag = input.title === undefined ? 0 : 1;
    const titleStateFlag = input.titleGenerationState === undefined ? 0 : 1;
    const expectedRevision = input.expectedSummaryRevision ?? -1;
    const updateResult = await connection.run(
      `UPDATE pi_sessions
       SET updated_at = ?,
           title = CASE WHEN ? = 1 THEN ? ELSE title END,
           title_generation_state = CASE WHEN ? = 1 THEN ? ELSE title_generation_state END,
           summary_text = CASE WHEN ? = 1 THEN ? ELSE summary_text END,
           summary_updated_at = CASE WHEN ? = 1 THEN ? ELSE summary_updated_at END,
           summary_through_timestamp = CASE WHEN ? = 1 THEN ? ELSE summary_through_timestamp END,
           summary_through_sequence = CASE WHEN ? = 1 THEN ? ELSE summary_through_sequence END,
           summary_revision = CASE WHEN ? = 1 THEN summary_revision + 1 ELSE summary_revision END
       WHERE id = ? AND (? = 0 OR summary_revision = ?)`,
      [
        now,
        titleFlag,
        input.title ?? null,
        titleStateFlag,
        input.titleGenerationState ?? null,
        summaryFlag,
        input.summary?.summaryText ?? null,
        summaryFlag,
        input.summary?.summaryUpdatedAt ? toDatabaseTimestamp(input.summary.summaryUpdatedAt) : null,
        summaryFlag,
        input.summary?.summaryThroughTimestamp ?? null,
        summaryFlag,
        input.summary?.summaryThroughSequence ?? null,
        summaryFlag,
        session.id,
        summaryFlag,
        expectedRevision,
      ],
    );
    const changed = Number((updateResult as { changes?: number }).changes ?? 0);
    if (changed !== 1) throw new Error('Summary persistence revision conflict.');
    await connection.run(
      'DELETE FROM pi_messages WHERE pi_session_db_id = ? AND sequence > ?',
      [session.id, retainedMessageCount],
    );
    await connection.run('COMMIT');
    transactionStarted = false;
    return summaryChanged ? expectedRevision + 1 : session.summaryRevision;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original no-op finalization error.
      }
    }
    throw error;
  } finally {
    await connection.close();
  }
}

export async function loadPiSession(
  sessionId: string,
  userId: string,
  agentId?: string | null,
  options?: { projectionMode?: PiMessageProjectionMode },
): Promise<AgentMessage[] | null> {
  const session = await db.query.piSessions.findFirst({
    where: buildPiSessionLookup(sessionId, userId, agentId),
  });

  if (session) {
    const messages = await db.select()
      .from(piMessages)
      .where(eq(piMessages.piSessionDbId, session.id))
      .orderBy(asc(piMessages.sequence), asc(piMessages.id));

    return messages.map(m => attachPersistedSequence(parsePersistedPiMessage(m.content, options?.projectionMode ?? 'context'), m.sequence));
  }

  if (resolveSessionAgentId(agentId) !== DEFAULT_AGENT_ID) {
    return null;
  }

  if (!(await legacyAiTablesExist())) {
    return null;
  }

  // Best-effort migration from legacy aiSessions
  const legacySession = await db.query.aiSessions.findFirst({
    where: and(eq(aiSessions.sessionId, sessionId), eq(aiSessions.userId, userId))
  });

  if (legacySession) {
    const legacyMessages = await db.select()
      .from(aiMessages)
      .where(eq(aiMessages.aiSessionDbId, legacySession.id))
      .orderBy(asc(aiMessages.createdAt));

    return legacyMessages.map<AgentMessage>(m => {
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: m.content }],
          api: 'legacy',
          provider: 'legacy',
          model: legacySession.model,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: m.createdAt.getTime(),
        } as AgentMessage;
      }
      return {
        role: 'user',
        content: m.content,
        timestamp: m.createdAt.getTime(),
      } as AgentMessage;
    });
  }

  return null;
}

export async function loadPiSessionWithSummary(
  sessionId: string,
  userId: string,
  agentId?: string | null,
  options?: { projectionMode?: PiMessageProjectionMode },
): Promise<{ messages: AgentMessage[]; summary: PiSessionSummaryState } | null> {
  const session = await db.query.piSessions.findFirst({
    where: buildPiSessionLookup(sessionId, userId, agentId),
  });

  if (!session) {
    return null;
  }

  const rows = await db.select()
    .from(piMessages)
    .where(eq(piMessages.piSessionDbId, session.id))
    .orderBy(asc(piMessages.sequence), asc(piMessages.id));

  return {
    messages: rows.map(m => attachPersistedSequence(parsePersistedPiMessage(m.content, options?.projectionMode ?? 'context'), m.sequence)),
    summary: {
      summaryText: session.summaryText ?? null,
      summaryUpdatedAt: session.summaryUpdatedAt ?? null,
      summaryThroughTimestamp: session.summaryThroughTimestamp ?? null,
      summaryThroughSequence: session.summaryThroughSequence ?? null,
      summaryRevision: session.summaryRevision,
    },
  };
}

export async function markPiSessionAsRead(sessionId: string, userId: string, agentId?: string | null): Promise<void> {
  await db.update(piSessions)
    .set({ lastViewedAt: piSessionReadCursorSql() })
    .where(buildPiSessionLookup(sessionId, userId, agentId));
}

export async function updatePiSessionLastMessageAt(sessionId: string, userId: string, timestamp: Date, agentId?: string | null): Promise<void> {
  const session = await db.query.piSessions.findFirst({
    where: buildPiSessionLookup(sessionId, userId, agentId),
  });

  if (session) {
    await db.update(piSessions)
      .set({ lastMessageAt: timestamp, updatedAt: new Date() })
      .where(eq(piSessions.id, session.id));
  }
}

export async function loadPiSessionByChannelKey(
  channelId: string,
  channelSessionKey: string,
  options?: { projectionMode?: PiMessageProjectionMode },
): Promise<AgentMessage[] | null> {
  const normalizedChannelId = normalizeStoredChannelId(channelId);
  const link = await db.query.sessionChannelLinks.findFirst({
    where: and(
      eq(sessionChannelLinks.channelId, normalizedChannelId),
      eq(sessionChannelLinks.channelSessionKey, channelSessionKey),
      eq(sessionChannelLinks.channelThreadKey, normalizeChannelThreadKey(null)),
    ),
    orderBy: [
      desc(sessionChannelLinks.isPrimary),
      desc(sessionChannelLinks.lastInboundAt),
      desc(sessionChannelLinks.updatedAt),
      desc(sessionChannelLinks.id),
    ],
    columns: { sessionId: true },
  });

  if (!link) return null;

  const session = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, link.sessionId),
  });

  if (!session) return null;

  const rows = await db.select()
    .from(piMessages)
    .where(eq(piMessages.piSessionDbId, session.id))
    .orderBy(asc(piMessages.sequence), asc(piMessages.id));

  return rows.map(m => attachPersistedSequence(parsePersistedPiMessage(m.content, options?.projectionMode ?? 'context'), m.sequence));
}
