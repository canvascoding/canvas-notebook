import 'server-only';

import { and, asc, desc, eq, lt, gt, or } from 'drizzle-orm';
import type { db as database } from '@/app/lib/db';
import { aiMessages, piMessages } from '@/app/lib/db/schema';
import { parsePersistedPiMessage, type PiMessageProjectionMode } from '@/app/lib/pi/message-projection';

const DEFAULT_LIMIT = 50;

export class InvalidMessagePaginationError extends Error {}

function parseCursorParam(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

export function parseMessagePagination(searchParams: URLSearchParams) {
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 200) : DEFAULT_LIMIT;
  const beforeParam = searchParams.get('before');
  const afterParam = searchParams.get('after');
  const beforeIdParam = searchParams.get('beforeId');
  const afterIdParam = searchParams.get('afterId');
  const beforeSequenceParam = searchParams.get('beforeSequence');
  const afterSequenceParam = searchParams.get('afterSequence');
  const projectionMode: PiMessageProjectionMode = searchParams.get('raw') === 'true' ? 'raw' : 'display';
  const before = parseCursorParam(beforeParam);
  const after = parseCursorParam(afterParam);
  const beforeId = parseCursorParam(beforeIdParam);
  const afterId = parseCursorParam(afterIdParam);
  const beforeSequence = parseCursorParam(beforeSequenceParam);
  const afterSequence = parseCursorParam(afterSequenceParam);

  if (
    (beforeParam !== null && Number.isNaN(before)) ||
    (afterParam !== null && Number.isNaN(after)) ||
    (beforeIdParam !== null && Number.isNaN(beforeId)) ||
    (afterIdParam !== null && Number.isNaN(afterId)) ||
    (beforeSequenceParam !== null && Number.isNaN(beforeSequence)) ||
    (afterSequenceParam !== null && Number.isNaN(afterSequence))
  ) {
    throw new InvalidMessagePaginationError('Invalid pagination cursor');
  }

  return { limit, before, after, beforeId, afterId, beforeSequence, afterSequence, projectionMode };
}

type MessagePagination = ReturnType<typeof parseMessagePagination>;

/** Read an already-authorized PI session; ordering and cursors match the messages API. */
export async function readPiSessionMessages(db: typeof database, sessionDbId: number, pagination: MessagePagination) {
  const { limit, before, after, beforeId, afterId, beforeSequence, afterSequence, projectionMode } = pagination;
  const conditions = [eq(piMessages.piSessionDbId, sessionDbId)];
  if (beforeSequence !== null) {
    conditions.push(
      beforeId !== null
        ? or(
            lt(piMessages.sequence, beforeSequence),
            and(eq(piMessages.sequence, beforeSequence), lt(piMessages.id, beforeId)),
          )!
        : lt(piMessages.sequence, beforeSequence),
    );
  } else if (before !== null) {
    conditions.push(
      beforeId !== null
        ? or(
            lt(piMessages.timestamp, before),
            and(eq(piMessages.timestamp, before), lt(piMessages.id, beforeId)),
          )!
        : lt(piMessages.timestamp, before),
    );
  }
  if (afterSequence !== null) {
    conditions.push(
      afterId !== null
        ? or(
            gt(piMessages.sequence, afterSequence),
            and(eq(piMessages.sequence, afterSequence), gt(piMessages.id, afterId)),
          )!
        : gt(piMessages.sequence, afterSequence),
    );
  } else if (after !== null) {
    conditions.push(
      afterId !== null
        ? or(
            gt(piMessages.timestamp, after),
            and(eq(piMessages.timestamp, after), gt(piMessages.id, afterId)),
          )!
        : gt(piMessages.timestamp, after),
    );
  }

  const isBackwardPage = beforeSequence !== null || before !== null || (before === null && after === null && afterSequence === null);

  // Fetch limit+1 to detect if there are more pages
  const rows = await db
    .select()
    .from(piMessages)
    .where(and(...conditions))
    .orderBy(
      isBackwardPage ? desc(piMessages.sequence) : asc(piMessages.sequence),
      isBackwardPage ? desc(piMessages.id) : asc(piMessages.id),
    )
    .limit(limit + 1);

  let hasMore = false;
  let resultRows = rows;
  if (rows.length > limit) {
    hasMore = true;
    resultRows = rows.slice(0, limit);
  }

  // Response order stays chronological even when fetched backwards for initial or older pages.
  if (isBackwardPage) {
    resultRows = [...resultRows].sort((a, b) => {
      if (a.sequence !== b.sequence) {
        return a.sequence - b.sequence;
      }
      return a.id - b.id;
    });
  }

  const mapped = resultRows.map(m => ({
    ...parsePersistedPiMessage(m.content, projectionMode),
    id: m.id,
    sequence: m.sequence,
    createdAt: new Date(m.timestamp),
  }));

  const oldestTimestamp = resultRows.length > 0 ? resultRows[0].timestamp : null;
  const newestTimestamp = resultRows.length > 0 ? resultRows[resultRows.length - 1].timestamp : null;
  const oldestMessageId = resultRows.length > 0 ? resultRows[0].id : null;
  const newestMessageId = resultRows.length > 0 ? resultRows[resultRows.length - 1].id : null;
  const oldestSequence = resultRows.length > 0 ? resultRows[0].sequence : null;
  const newestSequence = resultRows.length > 0 ? resultRows[resultRows.length - 1].sequence : null;

  return {
    success: true,
    messages: mapped,
    engine: 'pi',
    hasMoreBefore: isBackwardPage ? hasMore : false,
    hasMoreAfter: after !== null ? hasMore : false,
    oldestTimestamp,
    newestTimestamp,
    oldestMessageId,
    newestMessageId,
    oldestSequence,
    newestSequence,
  };
}

/** Legacy messages use timestamp/id cursors instead of PI sequences. */
export async function readLegacySessionMessages(db: typeof database, sessionDbId: number, pagination: MessagePagination) {
  const { limit, before, after, beforeId, afterId } = pagination;
  const conditions = [eq(aiMessages.aiSessionDbId, sessionDbId)];
  if (before !== null) {
    conditions.push(
      beforeId !== null
        ? or(
            lt(aiMessages.createdAt, new Date(before)),
            and(eq(aiMessages.createdAt, new Date(before)), lt(aiMessages.id, beforeId)),
          )!
        : lt(aiMessages.createdAt, new Date(before)),
    );
  }
  if (after !== null) {
    conditions.push(
      afterId !== null
        ? or(
            gt(aiMessages.createdAt, new Date(after)),
            and(eq(aiMessages.createdAt, new Date(after)), gt(aiMessages.id, afterId)),
          )!
        : gt(aiMessages.createdAt, new Date(after)),
    );
  }

  const isBackwardPage = before !== null || (before === null && after === null);

  const rows = await db
    .select()
    .from(aiMessages)
    .where(and(...conditions))
    .orderBy(
      isBackwardPage ? desc(aiMessages.createdAt) : asc(aiMessages.createdAt),
      isBackwardPage ? desc(aiMessages.id) : asc(aiMessages.id),
    )
    .limit(limit + 1);

  let hasMore = false;
  let resultRows = rows;
  if (rows.length > limit) {
    hasMore = true;
    resultRows = rows.slice(0, limit);
  }

  if (isBackwardPage) {
    resultRows = [...resultRows].sort((a, b) => {
      const left = a.createdAt.getTime();
      const right = b.createdAt.getTime();
      if (left !== right) {
        return left - right;
      }
      return a.id - b.id;
    });
  }

  const oldestTimestamp = resultRows.length > 0 ? resultRows[0].createdAt.getTime() : null;
  const newestTimestamp = resultRows.length > 0 ? resultRows[resultRows.length - 1].createdAt.getTime() : null;
  const oldestMessageId = resultRows.length > 0 ? resultRows[0].id : null;
  const newestMessageId = resultRows.length > 0 ? resultRows[resultRows.length - 1].id : null;

  return {
    success: true,
    messages: resultRows,
    engine: 'legacy',
    hasMoreBefore: isBackwardPage ? hasMore : false,
    hasMoreAfter: after !== null ? hasMore : false,
    oldestTimestamp,
    newestTimestamp,
    oldestMessageId,
    newestMessageId,
  };
}
