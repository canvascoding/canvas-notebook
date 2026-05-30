import { getTelegramConfigFromIntegrations } from '@/app/lib/integrations/env-config';

import { TELEGRAM_CHANNEL_ID, WEB_CHANNEL_ID, normalizeStoredChannelId } from './constants';

export type ChannelDeliveryReadiness = {
  ok: true;
} | {
  ok: false;
  reason: 'channel_disabled' | 'channel_not_configured';
  error: string;
};

export async function getChannelDeliveryReadiness(channelId: string): Promise<ChannelDeliveryReadiness> {
  const normalizedChannelId = normalizeStoredChannelId(channelId);

  if (normalizedChannelId === WEB_CHANNEL_ID) {
    return { ok: true };
  }

  if (normalizedChannelId === TELEGRAM_CHANNEL_ID) {
    const config = await getTelegramConfigFromIntegrations();
    if (!config.botToken) {
      return {
        ok: false,
        reason: 'channel_not_configured',
        error: 'TELEGRAM_BOT_TOKEN not configured',
      };
    }
    if (!config.channelEnabled) {
      return {
        ok: false,
        reason: 'channel_disabled',
        error: 'TELEGRAM_CHANNEL_ENABLED is false',
      };
    }
  }

  return { ok: true };
}
