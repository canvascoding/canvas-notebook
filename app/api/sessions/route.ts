import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { aiSessions, aiMessages } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { eq, desc, and } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const model = searchParams.get('model') || 'claude';

  try {
    const sessions = await db
      .select()
      .from(aiSessions)
      .where(and(
          eq(aiSessions.userId, session.user.id),
          eq(aiSessions.model, model)
      ))
      .orderBy(desc(aiSessions.createdAt))
      .limit(20);

    return NextResponse.json({ success: true, sessions });
  } catch (error) {
    console.error('[API] Failed to fetch sessions:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const model = searchParams.get('model');

  if (!sessionId || !model) {
    return NextResponse.json({ success: false, error: 'Session ID and model required' }, { status: 400 });
  }

  try {
    // 1. Find the session DB ID first to delete messages
    const dbSessions = await db
      .select()
      .from(aiSessions)
      .where(and(
        eq(aiSessions.sessionId, sessionId),
        eq(aiSessions.model, model),
        eq(aiSessions.userId, session.user.id)
      ))
      .limit(1);

    if (dbSessions.length === 0) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    const dbId = dbSessions[0].id;

    // 2. Delete messages associated with this session
    await db.delete(aiMessages).where(eq(aiMessages.aiSessionDbId, dbId));

    // 3. Delete the session
    await db.delete(aiSessions).where(eq(aiSessions.id, dbId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] Failed to delete session:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
