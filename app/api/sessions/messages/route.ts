import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { aiSessions, aiMessages } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { eq, asc, and } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const model = searchParams.get('model') || 'claude';

  if (!sessionId) {
    return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
  }

  try {
    const dbSessions = await db
      .select()
      .from(aiSessions)
      .where(and(
          eq(aiSessions.sessionId, sessionId),
          eq(aiSessions.model, model)
      ))
      .limit(1);

    if (dbSessions.length === 0) {
      return NextResponse.json({ success: true, messages: [] });
    }

    const messages = await db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.aiSessionDbId, dbSessions[0].id))
      .orderBy(asc(aiMessages.createdAt));

    return NextResponse.json({ success: true, messages });
  } catch (error) {
    console.error('[API] Failed to fetch messages:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
