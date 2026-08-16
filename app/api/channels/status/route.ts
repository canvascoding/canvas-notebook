import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getChannelManager } from '@/app/lib/channels/manager';
import { WEB_CHANNEL_ID } from '@/app/lib/channels/constants';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const manager = getChannelManager();
    const managerStatuses = manager.getChannelStatuses();

    const channels = Object.entries(managerStatuses).map(([id, status]) => ({
      id,
      ...status,
    }));

    if (!channels.some((c) => c.id === WEB_CHANNEL_ID)) {
      channels.unshift({
        id: WEB_CHANNEL_ID,
        running: true,
        connected: true,
        mode: 'websocket',
      });
    }

    return NextResponse.json({
      success: true,
      channels,
    });
  } catch (error) {
    console.error('[API] channels/status error:', error);
    return NextResponse.json({ success: false, error: 'Failed to get channel status' }, { status: 500 });
  }
}
