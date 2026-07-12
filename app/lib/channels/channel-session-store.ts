import { getDatabaseProvider, openDb, type SqlConnection } from '@/app/lib/db';
import { toDatabaseTimestamp } from '@/app/lib/db/timestamps';
import {
  insertPiSessionWithRuntimeSnapshotOnConnection,
  lockPiSessionCreationForUser,
  withPiSessionUserStateLock,
  type CreatePiSessionWithRuntimeSnapshotInput,
} from '@/app/lib/pi/session-store';
import { normalizeChannelContext, type ChannelContextKey } from './channel-context';

type ChannelResolutionStateInput = ChannelContextKey & {
  displayName?: string | null;
  inboundAt?: Date | null;
};

type ChannelLinkStateInput = ChannelResolutionStateInput & { sessionId: string };

export type ChannelSessionStoreInput = CreatePiSessionWithRuntimeSnapshotInput & ChannelContextKey & {
  displayName?: string | null;
  inboundAt?: Date | null;
};

export type ChannelSessionStoreResult = {
  sessionId: string;
  created: boolean;
};

async function withChannelWriteTransaction<T>(
  userId: string,
  operation: (connection: SqlConnection) => Promise<T>,
): Promise<T> {
  return withPiSessionUserStateLock(userId, async () => {
    const connection = await openDb();
    let transactionStarted = false;
    try {
      await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      transactionStarted = true;
      await lockPiSessionCreationForUser(connection, userId);
      const result = await operation(connection);
      await connection.run('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.run('ROLLBACK');
        } catch {
          // Preserve the original channel-state error.
        }
      }
      throw error;
    } finally {
      await connection.close?.();
    }
  });
}

async function findOwnedSessionOnConnection(
  connection: SqlConnection,
  input: { sessionId: string; userId: string; agentId: string },
): Promise<string | null> {
  const row = await connection.get(
    `SELECT session_id
     FROM pi_sessions
     WHERE session_id = ? AND user_id = ? AND agent_id = ?
     ORDER BY id ASC
     LIMIT 1`,
    [input.sessionId, input.userId, input.agentId],
  ) as { session_id?: string } | undefined;
  return row?.session_id ?? null;
}

async function findActiveOwnedSessionOnConnection(
  connection: SqlConnection,
  input: ChannelContextKey,
): Promise<string | null> {
  const context = normalizeChannelContext(input);
  const row = await connection.get(
    `SELECT active.session_id
     FROM channel_active_sessions active
     INNER JOIN pi_sessions session
       ON session.session_id = active.session_id
      AND session.user_id = active.user_id
      AND session.agent_id = active.agent_id
     WHERE active.user_id = ?
       AND active.agent_id = ?
       AND active.channel_id = ?
       AND active.channel_session_key = ?
       AND active.channel_thread_key = ?
     ORDER BY active.id ASC
     LIMIT 1`,
    [
      context.userId,
      context.agentId,
      context.channelId,
      context.channelSessionKey,
      context.channelThreadKey,
    ],
  ) as { session_id?: string } | undefined;
  return row?.session_id ?? null;
}

async function findLatestLinkedOwnedSessionOnConnection(
  connection: SqlConnection,
  input: ChannelContextKey,
): Promise<string | null> {
  const context = normalizeChannelContext(input);
  const row = await connection.get(
    `SELECT link.session_id
     FROM session_channel_links link
     INNER JOIN pi_sessions session
       ON session.session_id = link.session_id
      AND session.user_id = link.user_id
      AND session.agent_id = ?
     WHERE link.user_id = ?
       AND link.channel_id = ?
       AND link.channel_session_key = ?
       AND link.channel_thread_key = ?
     ORDER BY
       CASE WHEN link.last_inbound_at IS NULL THEN 1 ELSE 0 END ASC,
       link.last_inbound_at DESC,
       link.updated_at DESC,
       link.id DESC
     LIMIT 1`,
    [
      context.agentId,
      context.userId,
      context.channelId,
      context.channelSessionKey,
      context.channelThreadKey,
    ],
  ) as { session_id?: string } | undefined;
  return row?.session_id ?? null;
}

async function ensureChannelLinkOnConnection(
  connection: SqlConnection,
  input: ChannelLinkStateInput,
): Promise<void> {
  const context = normalizeChannelContext(input);
  const now = toDatabaseTimestamp(new Date());
  await connection.run(
    `INSERT INTO session_channel_links (
       session_id, user_id, channel_id, channel_session_key, channel_thread_key,
       display_name, is_primary, delivery_policy, last_inbound_at,
       last_outbound_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 0, 'last_active', ?, NULL, ?, ?)
     ON CONFLICT (user_id, session_id, channel_id, channel_session_key, channel_thread_key)
     DO UPDATE SET
       display_name = COALESCE(excluded.display_name, session_channel_links.display_name),
       last_inbound_at = COALESCE(excluded.last_inbound_at, session_channel_links.last_inbound_at),
       updated_at = excluded.updated_at`,
    [
      input.sessionId,
      context.userId,
      context.channelId,
      context.channelSessionKey,
      context.channelThreadKey,
      input.displayName ?? null,
      input.inboundAt ? toDatabaseTimestamp(input.inboundAt) : now,
      now,
      now,
    ],
  );
}

async function upsertActiveSessionOnConnection(
  connection: SqlConnection,
  input: ChannelContextKey & { sessionId: string },
): Promise<void> {
  const context = normalizeChannelContext(input);
  await connection.run(
    `INSERT INTO channel_active_sessions (
       user_id, agent_id, channel_id, channel_session_key,
       channel_thread_key, session_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, agent_id, channel_id, channel_session_key, channel_thread_key)
     DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    [
      context.userId,
      context.agentId,
      context.channelId,
      context.channelSessionKey,
      context.channelThreadKey,
      input.sessionId,
      toDatabaseTimestamp(new Date()),
    ],
  );
}

async function synchronizePrimaryLinkOnConnection(
  connection: SqlConnection,
  input: ChannelContextKey,
): Promise<void> {
  const context = normalizeChannelContext(input);
  await connection.run(
    `UPDATE session_channel_links
     SET is_primary = CASE WHEN session_id = (
       SELECT active.session_id
       FROM channel_active_sessions active
       WHERE active.user_id = ?
         AND active.agent_id = ?
         AND active.channel_id = ?
         AND active.channel_session_key = ?
         AND active.channel_thread_key = ?
       LIMIT 1
     ) THEN 1 ELSE 0 END
     WHERE user_id = ?
       AND channel_id = ?
       AND channel_session_key = ?
       AND channel_thread_key = ?`,
    [
      context.userId,
      context.agentId,
      context.channelId,
      context.channelSessionKey,
      context.channelThreadKey,
      context.userId,
      context.channelId,
      context.channelSessionKey,
      context.channelThreadKey,
    ],
  );
}

async function activateSessionOnConnection(
  connection: SqlConnection,
  input: ChannelLinkStateInput,
): Promise<void> {
  await ensureChannelLinkOnConnection(connection, input);
  await upsertActiveSessionOnConnection(connection, input);
  await synchronizePrimaryLinkOnConnection(connection, input);
}

async function resolveExistingChannelSessionOnConnection(
  connection: SqlConnection,
  input: ChannelResolutionStateInput,
): Promise<string | null> {
  const context = normalizeChannelContext(input);
  const activeSessionId = await findActiveOwnedSessionOnConnection(connection, context);
  if (activeSessionId) {
    await ensureChannelLinkOnConnection(connection, {
      ...context,
      sessionId: activeSessionId,
      displayName: input.displayName,
      inboundAt: input.inboundAt,
    });
    await synchronizePrimaryLinkOnConnection(connection, context);
    return activeSessionId;
  }

  const latestSessionId = await findLatestLinkedOwnedSessionOnConnection(connection, context);
  if (!latestSessionId) return null;
  await activateSessionOnConnection(connection, {
    ...context,
    sessionId: latestSessionId,
    displayName: input.displayName,
    inboundAt: input.inboundAt,
  });
  return latestSessionId;
}

export async function setActiveChannelSessionState(
  input: ChannelContextKey & { sessionId: string },
): Promise<void> {
  const context = normalizeChannelContext(input);
  await withChannelWriteTransaction(context.userId, async (connection) => {
    const sessionId = await findOwnedSessionOnConnection(connection, {
      sessionId: input.sessionId,
      userId: context.userId,
      agentId: context.agentId,
    });
    if (!sessionId) {
      throw new Error('Session not found.');
    }
    await upsertActiveSessionOnConnection(connection, { ...context, sessionId });
    await synchronizePrimaryLinkOnConnection(connection, context);
  });
}

export async function activateOwnedChannelSessionState(
  input: ChannelLinkStateInput,
): Promise<string | null> {
  const context = normalizeChannelContext(input);
  return withChannelWriteTransaction(context.userId, async (connection) => {
    const sessionId = await findOwnedSessionOnConnection(connection, {
      sessionId: input.sessionId,
      userId: context.userId,
      agentId: context.agentId,
    });
    if (!sessionId) {
      return null;
    }
    await activateSessionOnConnection(connection, {
      ...context,
      sessionId,
      displayName: input.displayName,
      inboundAt: input.inboundAt,
    });
    return sessionId;
  });
}

export async function resolveExistingChannelSessionState(
  input: ChannelResolutionStateInput,
): Promise<string | null> {
  const context = normalizeChannelContext(input);
  return withChannelWriteTransaction(context.userId, (connection) => (
    resolveExistingChannelSessionOnConnection(connection, input)
  ));
}

export async function createAndActivateChannelSessionState(
  input: ChannelSessionStoreInput,
): Promise<ChannelSessionStoreResult> {
  const context = normalizeChannelContext(input);
  return withChannelWriteTransaction(context.userId, async (connection) => {
    const inserted = await insertPiSessionWithRuntimeSnapshotOnConnection(connection, input);
    await activateSessionOnConnection(connection, {
      ...context,
      sessionId: input.sessionId,
      displayName: input.displayName,
      inboundAt: input.inboundAt,
    });
    return { sessionId: input.sessionId, created: inserted.created };
  });
}

export async function resolveOrCreateChannelSessionState(
  input: ChannelSessionStoreInput,
): Promise<ChannelSessionStoreResult> {
  const context = normalizeChannelContext(input);
  return withChannelWriteTransaction(context.userId, async (connection) => {
    const existingSessionId = await resolveExistingChannelSessionOnConnection(connection, input);
    if (existingSessionId) return { sessionId: existingSessionId, created: false };

    const inserted = await insertPiSessionWithRuntimeSnapshotOnConnection(connection, input);
    await activateSessionOnConnection(connection, {
      ...context,
      sessionId: input.sessionId,
      displayName: input.displayName,
      inboundAt: input.inboundAt,
    });
    return { sessionId: input.sessionId, created: inserted.created };
  });
}
