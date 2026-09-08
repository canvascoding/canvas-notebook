import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db, openDb } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { toDatabaseTimestamp } from '@/app/lib/db/timestamps';
import type { AiSessionRuntimeSnapshot } from '@/app/lib/agent-runtime-policy/types';
import { WEB_CHANNEL_ID, webChannelSessionKey } from '@/app/lib/channels/constants';
import { legacyAiTablesExist } from '@/app/lib/db/legacy-ai-tables';
import { DEFAULT_PI_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import {
  lockPiSessionCreationForUser,
  withPiSessionUserStateLock,
} from '@/app/lib/pi/session-user-state-lock';
import type { PiSystemPromptSnapshot } from '@/app/lib/pi/system-prompt-snapshot';

const SESSION_TITLE_STORAGE_MAX_LENGTH = 120;
const FORK_ORDINAL_LIMIT = 100_000;
const FORK_SUFFIX_PATTERN = /^(.*) \((\d+)\)$/u;

type ForkSessionRow = {
  id: number | string;
  session_id: string;
  user_id: string;
  agent_id: string;
  title: string | null;
  title_generation_state: string | null;
  session_kind: string;
  forked_from_session_id: string | null;
  forked_from_sequence: number | string | null;
  summary_text: string | null;
  summary_updated_at: number | string | null;
  summary_through_timestamp: number | string | null;
  summary_through_sequence: number | string | null;
  summary_revision: number | string | null;
  organization_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  workspace_id: string | null;
  workspace_type: string | null;
  workspace_name: string | null;
  workspace_root_relative_path: string | null;
};

type ForkMessageRow = {
  role: string;
  content: string;
  timestamp: number | string;
  sequence: number | string;
};

export type ForkPiSessionInput = {
  sourceSessionId: string;
  targetSessionId: string;
  clientRequestId: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  workspaceType: string;
  throughSequence: number;
  runtimeSnapshot: AiSessionRuntimeSnapshot;
  systemPromptSnapshot: PiSystemPromptSnapshot;
  now?: Date;
};

export type ForkPiSessionResult = {
  session: typeof piSessions.$inferSelect;
  created: boolean;
  copiedMessageCount: number;
  throughSequence: number;
};

export class PiSessionForkError extends Error {
  constructor(
    readonly code:
      | 'FORK_REQUEST_CONFLICT'
      | 'INVALID_FORK_POINT'
      | 'SESSION_HISTORY_CORRUPT'
      | 'SESSION_NOT_FOUND'
      | 'SESSION_NOT_FORKABLE'
      | 'SESSION_TITLE_PENDING'
      | 'SESSION_WORKSPACE_MISMATCH',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PiSessionForkError';
  }
}

function integer(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function changedRows(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const result = value as { changes?: unknown; rowCount?: unknown };
  return integer(result.changes ?? result.rowCount);
}

function normalizedSourceTitle(value: string | null): string {
  return value?.trim() || DEFAULT_PI_SESSION_TITLE;
}

function forkTitleBase(sourceTitle: string, sourceIsFork: boolean): string {
  if (!sourceIsFork) return sourceTitle;
  const match = FORK_SUFFIX_PATTERN.exec(sourceTitle);
  const ordinal = match ? Number.parseInt(match[2], 10) : 0;
  return match && ordinal >= 2 && match[1].trim() ? match[1].trim() : sourceTitle;
}

export function formatForkSessionTitle(baseTitle: string, ordinal: number): string {
  const suffix = ` (${ordinal})`;
  const availableLength = Math.max(1, SESSION_TITLE_STORAGE_MAX_LENGTH - suffix.length);
  return `${baseTitle.slice(0, availableLength).trimEnd()}${suffix}`;
}

export function resolveForkSessionTitle(input: {
  sourceTitle: string | null;
  sourceIsFork: boolean;
  existingTitles: Iterable<string | null>;
}): string {
  const sourceTitle = normalizedSourceTitle(input.sourceTitle);
  const baseTitle = forkTitleBase(sourceTitle, input.sourceIsFork);
  const existingTitles = new Set(
    Array.from(input.existingTitles, (title) => title?.trim()).filter((title): title is string => Boolean(title)),
  );

  for (let ordinal = 2; ordinal <= FORK_ORDINAL_LIMIT; ordinal += 1) {
    const candidate = formatForkSessionTitle(baseTitle, ordinal);
    if (!existingTitles.has(candidate)) return candidate;
  }

  throw new PiSessionForkError(
    'FORK_REQUEST_CONFLICT',
    'No available fork title could be generated.',
    409,
  );
}

function isForkableAssistantMessage(content: string): boolean {
  try {
    const message = JSON.parse(content) as { content?: unknown; stopReason?: unknown };
    if (message.stopReason === 'aborted' || message.stopReason === 'error') return false;
    if (!Array.isArray(message.content)) return true;
    return !message.content.some((part) => (
      part !== null
      && typeof part === 'object'
      && 'type' in part
      && ((part as { type?: unknown }).type === 'toolCall' || (part as { type?: unknown }).type === 'tool_use')
    ));
  } catch {
    return false;
  }
}

function sourceWorkspaceMatches(source: ForkSessionRow, workspaceId: string, workspaceType: string): boolean {
  if (source.workspace_id) return source.workspace_id === workspaceId;
  return workspaceType === 'personal';
}

async function loadCreatedSession(
  sessionId: string,
  userId: string,
  agentId: string,
): Promise<typeof piSessions.$inferSelect> {
  const session = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, sessionId),
      eq(piSessions.userId, userId),
      eq(piSessions.agentId, agentId),
    ),
  });
  if (!session) throw new Error('Forked session could not be loaded after creation.');
  return session;
}

export async function forkPiSession(input: ForkPiSessionInput): Promise<ForkPiSessionResult> {
  const includeLegacyTitles = input.workspaceType === 'personal' && await legacyAiTablesExist();

  return withPiSessionUserStateLock(input.userId, async () => {
    const connection = await openDb();
    let transactionStarted = false;
    let targetSessionId = input.targetSessionId;
    let copiedMessageCount = 0;
    let created = false;

    try {
      await connection.run('BEGIN');
      transactionStarted = true;
      await lockPiSessionCreationForUser(connection, input.userId);

      const existingRequestRows = await connection.all(
        `SELECT id, session_id, user_id, agent_id, workspace_id, session_kind,
                forked_from_session_id, forked_from_sequence
         FROM pi_sessions
         WHERE user_id = ? AND client_request_id = ?
         ORDER BY id ASC
         LIMIT 2`,
        [input.userId, input.clientRequestId],
      ) as ForkSessionRow[];
      if (existingRequestRows.length > 1) {
        throw new PiSessionForkError('FORK_REQUEST_CONFLICT', 'Fork request ID is ambiguous.', 409);
      }
      const existingRequest = existingRequestRows[0];
      if (existingRequest) {
        if (
          existingRequest.agent_id !== input.agentId
          || existingRequest.workspace_id !== input.workspaceId
          || existingRequest.session_kind !== 'conversation'
          || existingRequest.forked_from_session_id !== input.sourceSessionId
          || integer(existingRequest.forked_from_sequence) !== input.throughSequence
        ) {
          throw new PiSessionForkError(
            'FORK_REQUEST_CONFLICT',
            'The fork request ID was already used for a different session.',
            409,
          );
        }
        targetSessionId = existingRequest.session_id;
        const countRow = await connection.get(
          'SELECT COUNT(*) AS message_count FROM pi_messages WHERE pi_session_db_id = ?',
          [existingRequest.id],
        ) as { message_count?: unknown } | undefined;
        copiedMessageCount = integer(countRow?.message_count);
        await connection.run('COMMIT');
        transactionStarted = false;
        return {
          session: await loadCreatedSession(targetSessionId, input.userId, input.agentId),
          created: false,
          copiedMessageCount,
          throughSequence: input.throughSequence,
        };
      }

      const source = await connection.get(
        `SELECT id, session_id, user_id, agent_id, title, title_generation_state,
                session_kind, forked_from_session_id, forked_from_sequence,
                summary_text, summary_updated_at, summary_through_timestamp,
                summary_through_sequence, summary_revision,
                organization_id, customer_id, project_id, workspace_id, workspace_type,
                workspace_name, workspace_root_relative_path
         FROM pi_sessions
         WHERE session_id = ? AND user_id = ? AND agent_id = ?
         LIMIT 1 FOR UPDATE`,
        [input.sourceSessionId, input.userId, input.agentId],
      ) as ForkSessionRow | undefined;
      if (!source) {
        throw new PiSessionForkError('SESSION_NOT_FOUND', 'Session not found.', 404);
      }
      if (source.session_kind !== 'conversation') {
        throw new PiSessionForkError('SESSION_NOT_FORKABLE', 'Only conversation sessions can be forked.', 409);
      }
      if (!sourceWorkspaceMatches(source, input.workspaceId, input.workspaceType)) {
        throw new PiSessionForkError(
          'SESSION_WORKSPACE_MISMATCH',
          'Session is outside the active workspace.',
          403,
        );
      }
      if (source.title_generation_state === 'pending' || source.title_generation_state === 'generating') {
        throw new PiSessionForkError(
          'SESSION_TITLE_PENDING',
          'Wait for the session title to finish generating before forking.',
          409,
        );
      }

      const selectedMessage = await connection.get(
        `SELECT role, content, timestamp, sequence
         FROM pi_messages
         WHERE pi_session_db_id = ? AND sequence = ?
         LIMIT 1`,
        [source.id, input.throughSequence],
      ) as ForkMessageRow | undefined;
      if (
        !selectedMessage
        || selectedMessage.role !== 'assistant'
        || !isForkableAssistantMessage(selectedMessage.content)
      ) {
        throw new PiSessionForkError(
          'INVALID_FORK_POINT',
          'Choose a completed assistant response as the fork point.',
          409,
        );
      }

      const historyAudit = await connection.get(
        `SELECT COUNT(*) AS message_count,
                COUNT(DISTINCT sequence) AS distinct_sequence_count,
                MIN(sequence) AS minimum_sequence,
                MAX(sequence) AS maximum_sequence
         FROM pi_messages
         WHERE pi_session_db_id = ? AND sequence <= ?`,
        [source.id, input.throughSequence],
      ) as Record<string, unknown>;
      const prefixCount = integer(historyAudit.message_count);
      if (
        prefixCount !== input.throughSequence
        || integer(historyAudit.distinct_sequence_count) !== prefixCount
        || integer(historyAudit.minimum_sequence) !== 1
        || integer(historyAudit.maximum_sequence) !== input.throughSequence
      ) {
        throw new PiSessionForkError(
          'SESSION_HISTORY_CORRUPT',
          'The session history cannot be forked because its message sequence is incomplete.',
          409,
        );
      }

      const workspaceCondition = input.workspaceType === 'personal'
        ? '(workspace_id = ? OR workspace_id IS NULL)'
        : 'workspace_id = ?';
      const titleRows = await connection.all(
        `SELECT title
         FROM pi_sessions
         WHERE user_id = ? AND session_kind = 'conversation' AND ${workspaceCondition}`,
        [input.userId, input.workspaceId],
      ) as Array<{ title?: string | null }>;
      if (includeLegacyTitles) {
        const legacyTitleRows = await connection.all(
          'SELECT title FROM ai_sessions WHERE user_id = ?',
          [input.userId],
        ) as Array<{ title?: string | null }>;
        titleRows.push(...legacyTitleRows);
      }
      const title = resolveForkSessionTitle({
        sourceTitle: source.title,
        sourceIsFork: Boolean(source.forked_from_session_id),
        existingTitles: titleRows.map((row) => row.title ?? null),
      });

      const now = input.now ?? new Date();
      const nowTimestamp = toDatabaseTimestamp(now);
      const summaryThroughSequence = integer(source.summary_through_sequence);
      const copySummary = Boolean(source.summary_text) && summaryThroughSequence > 0
        && summaryThroughSequence <= input.throughSequence;
      const inserted = await connection.get(
        `INSERT INTO pi_sessions (
           session_id, client_request_id, user_id, agent_id, provider, model, thinking_level,
           title, title_generation_state, created_at, updated_at,
           summary_text, summary_updated_at, summary_through_timestamp,
           summary_through_sequence, summary_revision,
           system_prompt_snapshot, system_prompt_snapshot_hash, system_prompt_snapshot_created_at,
           last_message_at, last_viewed_at, archived_at, channel_id, channel_session_key,
           session_kind, parent_session_id, forked_from_session_id, forked_from_sequence,
           delegation_id, delegation_depth,
           organization_id, customer_id, project_id, workspace_id, workspace_type,
           workspace_name, workspace_root_relative_path,
           runtime_provider_installation_id, runtime_catalog_revision,
           runtime_policy_revision, runtime_selection_source
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'app', NULL,
           'conversation', NULL, ?, ?, NULL, 0,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )
         RETURNING id`,
        [
          input.targetSessionId,
          input.clientRequestId,
          input.userId,
          input.agentId,
          input.runtimeSnapshot.selection.providerId,
          input.runtimeSnapshot.selection.modelId,
          input.runtimeSnapshot.selection.thinkingLevel,
          title,
          nowTimestamp,
          nowTimestamp,
          copySummary ? source.summary_text : null,
          copySummary ? source.summary_updated_at : null,
          copySummary ? source.summary_through_timestamp : null,
          copySummary ? source.summary_through_sequence : null,
          copySummary ? integer(source.summary_revision) : 0,
          input.systemPromptSnapshot.systemPrompt,
          input.systemPromptSnapshot.systemPromptHash,
          toDatabaseTimestamp(input.systemPromptSnapshot.systemPromptCreatedAt),
          nowTimestamp,
          nowTimestamp,
          input.sourceSessionId,
          input.throughSequence,
          source.organization_id,
          source.customer_id,
          source.project_id,
          input.workspaceId,
          input.workspaceType,
          source.workspace_name,
          source.workspace_root_relative_path,
          input.runtimeSnapshot.selection.providerInstallationId,
          input.runtimeSnapshot.catalogRevision,
          input.runtimeSnapshot.policyRevision,
          input.runtimeSnapshot.selectionSource,
        ],
      ) as { id?: number | string } | undefined;
      if (inserted?.id === undefined) throw new Error('Forked session could not be created.');

      const copyResult = await connection.run(
        `INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
         SELECT ?, role, content, timestamp, sequence
         FROM pi_messages
         WHERE pi_session_db_id = ? AND sequence <= ?
         ORDER BY sequence ASC, id ASC`,
        [inserted.id, source.id, input.throughSequence],
      );
      copiedMessageCount = changedRows(copyResult);
      if (copiedMessageCount !== input.throughSequence) {
        throw new Error('Forked session message copy was incomplete.');
      }

      const channelSessionKey = webChannelSessionKey(input.userId);
      await connection.run(
        `UPDATE session_channel_links
         SET is_primary = 0, updated_at = ?
         WHERE user_id = ? AND channel_id = ? AND channel_session_key = ? AND channel_thread_key = ''`,
        [nowTimestamp, input.userId, WEB_CHANNEL_ID, channelSessionKey],
      );
      await connection.run(
        `INSERT INTO session_channel_links (
           session_id, user_id, channel_id, channel_session_key, channel_thread_key,
           display_name, is_primary, delivery_policy, last_inbound_at, last_outbound_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, '', ?, 1, 'last_active', NULL, NULL, ?, ?)`,
        [input.targetSessionId, input.userId, WEB_CHANNEL_ID, channelSessionKey, title, nowTimestamp, nowTimestamp],
      );

      await connection.run('COMMIT');
      transactionStarted = false;
      created = true;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.run('ROLLBACK');
        } catch {
          // Preserve the original fork error.
        }
      }
      throw error;
    } finally {
      await connection.close();
    }

    return {
      session: await loadCreatedSession(targetSessionId, input.userId, input.agentId),
      created,
      copiedMessageCount,
      throughSequence: input.throughSequence,
    };
  });
}
