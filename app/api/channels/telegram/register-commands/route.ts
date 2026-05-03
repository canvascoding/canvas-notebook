import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getChannelRegistry } from '@/app/lib/channels/registry';
import { getTelegramConfigFromIntegrations } from '@/app/lib/integrations/env-config';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { TelegramChannel } from '@/app/lib/channels/telegram';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 5, windowMs: 60_000, keyPrefix: 'channels-register-commands' });
  if (!limited.ok) return limited.response;

  try {
    const config = await getTelegramConfigFromIntegrations();
    if (!config.botToken) {
      return NextResponse.json({ success: false, error: 'TELEGRAM_BOT_TOKEN not configured' }, { status: 400 });
    }

    const channel = getChannelRegistry().get('telegram');
    if (!channel) {
      return NextResponse.json({ success: false, error: 'Telegram channel not running' }, { status: 400 });
    }

    const bot = (channel as TelegramChannel).getBot();
    await bot.api.setMyCommands([
      { command: 'new', description: 'Neue Session erstellen' },
      { command: 'stop', description: 'Agent-Lauf abbrechen' },
      { command: 'compact', description: 'Context komprimieren' },
      { command: 'sessions', description: 'Sessions auflisten' },
      { command: 'switch', description: 'Zu Session wechseln' },
      { command: 'status', description: 'Session-Status anzeigen' },
    ]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] channels/telegram/register-commands error:', error);
    return NextResponse.json({ success: false, error: 'Failed to register commands' }, { status: 500 });
  }
}