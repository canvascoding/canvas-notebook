import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { claudeSessions, claudeMessages } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { eq, asc } from 'drizzle-orm';

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

  try {
    // 1. Find session DB ID
    const dbSessions = await db
      .select()
      .from(claudeSessions)
      .where(eq(claudeSessions.sessionId, sessionId))
      .limit(1);

    if (dbSessions.length === 0) {
      return NextResponse.json({ success: true, messages: [] });
    }

    // 2. Fetch messages
    const messages = await db
      .select()
      .from(claudeMessages)
      .where(eq(claudeMessages.claudeSessionDbId, dbSessions[0].id))
      .orderBy(asc(claudeMessages.createdAt));

    return NextResponse.json({ success: true, messages });
  } catch (error) {
    console.error('[API] Failed to fetch Claude messages:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
