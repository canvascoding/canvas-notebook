import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { aiSessions, aiMessages, piSessions, piMessages } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { asc, eq } from 'drizzle-orm';

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
    // Try PI session first
    const dbPiSessions = await db
      .select()
      .from(piSessions)
      .where(eq(piSessions.sessionId, sessionId))
      .limit(1);

    if (dbPiSessions.length > 0) {
      const messages = await db
        .select()
        .from(piMessages)
        .where(eq(piMessages.piSessionDbId, dbPiSessions[0].id))
        .orderBy(asc(piMessages.timestamp));

      // Return PI messages, client needs to know they are PI format (JSON)
      return NextResponse.json({ 
        success: true, 
        messages: messages.map(m => ({
          ...JSON.parse(m.content),
          id: m.id,
          createdAt: new Date(m.timestamp),
        })),
        engine: 'pi'
      });
    }

    // Fallback to legacy
    const dbAiSessions = await db
      .select()
      .from(aiSessions)
      .where(eq(aiSessions.sessionId, sessionId))
      .limit(1);

    if (dbAiSessions.length === 0) {
      return NextResponse.json({ success: true, messages: [] });
    }

    const messages = await db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.aiSessionDbId, dbAiSessions[0].id))
      .orderBy(asc(aiMessages.createdAt));

    return NextResponse.json({ success: true, messages, engine: 'legacy' });
  } catch (error) {
    console.error('[API] Failed to fetch messages:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
