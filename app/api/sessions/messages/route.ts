import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { aiSessions, aiMessages, piSessions, piMessages } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { and, asc, desc, eq, lt, gt } from 'drizzle-orm';

const DEFAULT_LIMIT = 50;

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');

  if (!sessionId) {
    return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
  }

  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 200) : DEFAULT_LIMIT;
  const beforeParam = searchParams.get('before');
  const afterParam = searchParams.get('after');
  const before = beforeParam ? parseInt(beforeParam, 10) : null;
  const after = afterParam ? parseInt(afterParam, 10) : null;

  if ((beforeParam !== null && Number.isNaN(before)) || (afterParam !== null && Number.isNaN(after))) {
    return NextResponse.json({ success: false, error: 'Invalid before/after timestamp' }, { status: 400 });
  }

  try {
    // Try PI session first (ownership enforced)
    const dbPiSessions = await db
      .select()
      .from(piSessions)
      .where(and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id)))
      .limit(1);

    if (dbPiSessions.length > 0) {
      const conditions = [eq(piMessages.piSessionDbId, dbPiSessions[0].id)];
      if (before !== null) conditions.push(lt(piMessages.timestamp, before));
      if (after !== null) conditions.push(gt(piMessages.timestamp, after));

      // Fetch limit+1 to detect if there are more pages
      const rows = await db
        .select()
        .from(piMessages)
        .where(and(...conditions))
        .orderBy(before !== null ? desc(piMessages.timestamp) : asc(piMessages.timestamp))
        .limit(limit + 1);

      let hasMore = false;
      let resultRows = rows;
      if (rows.length > limit) {
        hasMore = true;
        resultRows = rows.slice(0, limit);
      }

      // If fetching older messages (before), they come in descending order — re-sort ascending
      if (before !== null) {
        resultRows = [...resultRows].sort((a, b) => a.timestamp - b.timestamp);
      }

      const mapped = resultRows.map(m => ({
        ...JSON.parse(m.content),
        id: m.id,
        createdAt: new Date(m.timestamp),
      }));

      const oldestTimestamp = resultRows.length > 0 ? resultRows[0].timestamp : null;
      const newestTimestamp = resultRows.length > 0 ? resultRows[resultRows.length - 1].timestamp : null;

      return NextResponse.json({
        success: true,
        messages: mapped,
        engine: 'pi',
        hasMoreBefore: before !== null ? hasMore : (oldestTimestamp !== null ? true : false),
        hasMoreAfter: after !== null ? hasMore : false,
        oldestTimestamp,
        newestTimestamp,
      });
    }

    // Fallback to legacy (ownership enforced)
    const dbAiSessions = await db
      .select()
      .from(aiSessions)
      .where(and(eq(aiSessions.sessionId, sessionId), eq(aiSessions.userId, session.user.id)))
      .limit(1);

    if (dbAiSessions.length === 0) {
      return NextResponse.json({ success: true, messages: [], hasMoreBefore: false, hasMoreAfter: false, oldestTimestamp: null, newestTimestamp: null });
    }

    const conditions = [eq(aiMessages.aiSessionDbId, dbAiSessions[0].id)];
    if (before !== null) conditions.push(lt(aiMessages.createdAt, new Date(before)));
    if (after !== null) conditions.push(gt(aiMessages.createdAt, new Date(after)));

    const rows = await db
      .select()
      .from(aiMessages)
      .where(and(...conditions))
      .orderBy(before !== null ? desc(aiMessages.createdAt) : asc(aiMessages.createdAt))
      .limit(limit + 1);

    let hasMore = false;
    let resultRows = rows;
    if (rows.length > limit) {
      hasMore = true;
      resultRows = rows.slice(0, limit);
    }

    if (before !== null) {
      resultRows = [...resultRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }

    const oldestTimestamp = resultRows.length > 0 ? resultRows[0].createdAt.getTime() : null;
    const newestTimestamp = resultRows.length > 0 ? resultRows[resultRows.length - 1].createdAt.getTime() : null;

    return NextResponse.json({
      success: true,
      messages: resultRows,
      engine: 'legacy',
      hasMoreBefore: before !== null ? hasMore : (oldestTimestamp !== null ? true : false),
      hasMoreAfter: after !== null ? hasMore : false,
      oldestTimestamp,
      newestTimestamp,
    });
  } catch (error) {
    console.error('[API] Failed to fetch messages:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
