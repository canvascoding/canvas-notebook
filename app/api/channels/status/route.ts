import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getChannelManager } from '@/app/lib/channels/manager';
import { getTelegramConfigFromIntegrations } from '@/app/lib/integrations/env-config';
import { getBinding } from '@/app/lib/channels/telegram/link-token';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const manager = getChannelManager();
    const managerStatuses = manager.getChannelStatuses();

    const telegramConfig = await getTelegramConfigFromIntegrations();
    const telegramBinding = telegramConfig.botToken
      ? await getBinding('telegram', session.user.id).catch(() => null)
      : null;

    const channels = Object.entries(managerStatuses).map(([id, status]) => ({
      id,
      ...status,
    }));

    if (!channels.some((c) => c.id === 'telegram')) {
      channels.push({
        id: 'telegram',
        running: false,
        connected: false,
        mode: telegramConfig.botToken ? 'polling' : undefined,
        lastError: !telegramConfig.botToken ? 'TELEGRAM_BOT_TOKEN not configured' : !telegramConfig.channelEnabled ? 'TELEGRAM_CHANNEL_ENABLED is false' : undefined,
      });
    }

    return NextResponse.json({
      success: true,
      channels,
      telegram: {
        configured: !!telegramConfig.botToken,
        enabled: telegramConfig.channelEnabled,
        linked: !!telegramBinding,
        linkedUserName: telegramBinding?.channelUserName ?? null,
      },
    });
  } catch (error) {
    console.error('[API] channels/status error:', error);
    return NextResponse.json({ success: false, error: 'Failed to get channel status' }, { status: 500 });
  }
}