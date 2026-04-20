import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { listStudioGenerations } from '@/app/lib/integrations/studio-generation-service';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const generations = await listStudioGenerations(session.user.id);
    return NextResponse.json({ success: true, generations });
  } catch (error) {
    console.error('[Studio Generations] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to list generations' }, { status: 500 });
  }
}