import { and, eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { getChannelRegistry } from './registry';
import type { OutboundMessage, DeliveryTarget } from './types';
import {
  LEGACY_APP_CHANNEL_ID,
  TELEGRAM_CHANNEL_ID,
  telegramChatIdFromSessionKey,
  WEB_CHANNEL_ID,
} from './constants';
import { findLastActiveExternalLink, markChannelLinkOutbound } from './channel-links';

function toDeliveryTarget(channelId: string, channelSessionKey: string, channelThreadKey?: string): DeliveryTarget {
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

export async function deliverToLastActiveExternalChannel(
  sessionId: string,
  userId: string,
  message: OutboundMessage,
): Promise<void> {
  const session = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, userId)),
    columns: {
      channelId: true,
      channelSessionKey: true,
    },
  });

  const link = await findLastActiveExternalLink(sessionId, WEB_CHANNEL_ID);
  const channelId = link?.channelId
    ?? (session?.channelId && session.channelId !== LEGACY_APP_CHANNEL_ID ? session.channelId : null);
  const channelSessionKey = link?.channelSessionKey ?? session?.channelSessionKey ?? null;
  const channelThreadKey = link?.channelThreadKey ?? '';

  if (!channelId || !channelSessionKey) {
    return;
  }

  const channel = getChannelRegistry().get(channelId);
  if (!channel) {
    return;
  }

  await channel.deliver(message, toDeliveryTarget(channelId, channelSessionKey, channelThreadKey));
  await markChannelLinkOutbound({
    sessionId,
    userId,
    channelId,
    channelSessionKey,
    channelThreadKey,
  });
}

export async function sendTypingToLastActiveExternalChannel(sessionId: string, _userId: string): Promise<void> {
  const link = await findLastActiveExternalLink(sessionId, WEB_CHANNEL_ID);
  if (!link) return;

  const channel = getChannelRegistry().get(link.channelId);
  const typingChannel = channel as typeof channel & {
    sendTyping?: (target: DeliveryTarget) => Promise<void>;
  };
  if (!typingChannel?.sendTyping) return;

  await typingChannel.sendTyping(toDeliveryTarget(link.channelId, link.channelSessionKey, link.channelThreadKey));
}
