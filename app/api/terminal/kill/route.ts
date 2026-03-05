import { NextRequest, NextResponse } from 'next/server';
import { terminateAllSessions } from '@/server/terminal-manager';
import { auth } from '@/app/lib/auth';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  
  const ownerId = String(session.user.id || session.user.email || 'anonymous');
  const result = terminateAllSessions(ownerId);
  return NextResponse.json({ success: true, closed: result.closed });
}
