import { sql, type SQL } from 'drizzle-orm';

import { piSessions } from '@/app/lib/db/schema';

/**
 * Advances the read cursor through the latest assistant activity that exists
 * when the UPDATE executes. Keeping this expression inside the UPDATE avoids a
 * select/update race and does not depend on the app and server clocks agreeing.
 */
export function piSessionReadCursorSql(): SQL<Date> {
  return sql<Date>`CASE
    WHEN ${piSessions.lastMessageAt} IS NULL
      THEN COALESCE(${piSessions.lastViewedAt}, ${piSessions.createdAt})
    WHEN ${piSessions.lastViewedAt} IS NULL OR ${piSessions.lastMessageAt} > ${piSessions.lastViewedAt}
      THEN ${piSessions.lastMessageAt}
    ELSE ${piSessions.lastViewedAt}
  END`;
}
