import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getChannelManager } from '@/app/lib/channels/manager';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const manager = getChannelManager();
    await manager.restart();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] channels/restart error:', error);
    return NextResponse.json({ success: false, error: 'Failed to restart channels' }, { status: 500 });
  }
}