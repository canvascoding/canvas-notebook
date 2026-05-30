import { getChannelRegistry } from './registry';
import type { OutboundMessage, DeliveryTarget } from './types';
import { WEB_CHANNEL_ID } from './constants';
import { findLastActiveExternalLink, markChannelLinkOutbound } from './channel-links';
import { buildDeliveryTarget } from './delivery-targets';
import { getChannelDeliveryReadiness } from './availability';

export async function deliverToLastActiveExternalChannel(
  sessionId: string,
  userId: string,
  message: OutboundMessage,
): Promise<void> {
  const link = await findLastActiveExternalLink(sessionId, WEB_CHANNEL_ID);
  if (!link) {
    return;
  }

  const readiness = await getChannelDeliveryReadiness({
    channelId: link.channelId,
    userId,
    channelSessionKey: link.channelSessionKey,
  });
  if (!readiness.ok) {
    return;
  }

  const channel = getChannelRegistry().get(link.channelId);
  if (!channel) {
    return;
  }

  await channel.deliver(message, buildDeliveryTarget(link.channelId, link.channelSessionKey, link.channelThreadKey));
  await markChannelLinkOutbound({
    sessionId,
    userId,
    channelId: link.channelId,
    channelSessionKey: link.channelSessionKey,
    channelThreadKey: link.channelThreadKey,
  });
}

export async function sendTypingToLastActiveExternalChannel(sessionId: string, _userId: string): Promise<void> {
  const link = await findLastActiveExternalLink(sessionId, WEB_CHANNEL_ID);
  if (!link) return;

  const readiness = await getChannelDeliveryReadiness({
    channelId: link.channelId,
    userId: _userId,
    channelSessionKey: link.channelSessionKey,
  });
  if (!readiness.ok) return;

  const channel = getChannelRegistry().get(link.channelId);
  const typingChannel = channel as typeof channel & {
    sendTyping?: (target: DeliveryTarget) => Promise<void>;
  };
  if (!typingChannel?.sendTyping) return;

  await typingChannel.sendTyping(buildDeliveryTarget(link.channelId, link.channelSessionKey, link.channelThreadKey));
}
