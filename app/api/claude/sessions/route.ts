import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/app/lib/db';
import { claudeSessions } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { eq, desc } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const sessions = await db
      .select()
      .from(claudeSessions)
      .where(eq(claudeSessions.userId, session.user.id))
      .orderBy(desc(claudeSessions.createdAt))
      .limit(20);

    return NextResponse.json({ success: true, sessions });
  } catch (error) {
    console.error('[API] Failed to fetch Claude sessions:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
