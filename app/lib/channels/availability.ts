import { getTelegramConfigFromIntegrations } from '@/app/lib/integrations/env-config';

import { getBinding } from './telegram/link-token';
import { TELEGRAM_CHANNEL_ID, WEB_CHANNEL_ID, normalizeStoredChannelId, telegramChatIdFromSessionKey } from './constants';

export type ChannelDeliveryReadiness = {
  ok: true;
} | {
  ok: false;
  reason: 'channel_disabled' | 'channel_not_configured' | 'channel_unlinked';
  error: string;
};

export async function getChannelDeliveryReadiness(input: string | {
  channelId: string;
  userId?: string | null;
  channelSessionKey?: string | null;
}): Promise<ChannelDeliveryReadiness> {
  const channelId = typeof input === 'string' ? input : input.channelId;
  const userId = typeof input === 'string' ? null : input.userId?.trim() || null;
  const channelSessionKey = typeof input === 'string' ? null : input.channelSessionKey?.trim() || null;
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

    if (userId && channelSessionKey) {
      const chatId = telegramChatIdFromSessionKey(channelSessionKey);
      const binding = await getBinding(TELEGRAM_CHANNEL_ID, chatId);
      if (!binding || binding.userId !== userId) {
        return {
          ok: false,
          reason: 'channel_unlinked',
          error: 'Telegram channel is no longer linked for this user',
        };
      }
    }
  }

  return { ok: true };
}
