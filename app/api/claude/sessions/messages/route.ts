import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  // Return empty messages for now - Claude sessions are deprecated
  return NextResponse.json({ success: true, messages: [] });
}
