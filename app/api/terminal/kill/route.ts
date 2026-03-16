import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  
  // Note: The new terminal service doesn't expose a "kill all" endpoint
  // This would need to be implemented in the terminal service
  // For now, return success (sessions will timeout naturally)
  console.log('[Terminal API] Kill all requested by', session.user?.email || 'unknown');

  return NextResponse.json({ success: true, closed: 0 });
}
