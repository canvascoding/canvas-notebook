import type { DeliveryTarget } from './types';
import { TELEGRAM_CHANNEL_ID, telegramChatIdFromSessionKey } from './constants';

export function buildDeliveryTarget(channelId: string, channelSessionKey: string, channelThreadKey?: string): DeliveryTarget {
  return {
    channelId,
    channelSessionKey,
    channelThreadKey,
    chatId: channelId === TELEGRAM_CHANNEL_ID
      ? telegramChatIdFromSessionKey(channelSessionKey)
      : channelSessionKey,
    threadId: channelThreadKey || undefined,
  };
}
