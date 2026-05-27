import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { getActiveChannelSession } from '@/app/lib/channels/active-sessions';
import { ensureSessionChannelLink } from '@/app/lib/channels/channel-links';
import { WEB_CHANNEL_ID, webChannelSessionKey } from '@/app/lib/channels/constants';

import type { AutomationJobRecord } from './types';

export type AutomationDeliveryResolution = {
  sessionId: string;
  mode: 'new_session' | 'fixed_session' | 'channel_active';
  channelId: string;
  channelSessionKey: string;
  warnings: string[];
  activeDelivery: boolean;
};

function defaultWebChannelSessionKey(userId: string): string {
  return webChannelSessionKey(userId);
}

function resolveDeliveryChannel(job: AutomationJobRecord, userId: string) {
  if (job.deliveryMode === 'silent') {
    return {
      channelId: WEB_CHANNEL_ID,
      channelSessionKey: defaultWebChannelSessionKey(userId),
      activeDelivery: false,
    };
  }

  const channelId = job.deliveryChannelId?.trim() || WEB_CHANNEL_ID;
  const channelSessionKey = job.deliveryChannelSessionKey?.trim()
    || (channelId === WEB_CHANNEL_ID ? defaultWebChannelSessionKey(userId) : '');

  return {
    channelId,
    channelSessionKey,
    activeDelivery: true,
  };
}

async function verifySessionOwnership(input: {
  sessionId: string;
  userId: string;
  agentId: string;
}): Promise<boolean> {
  const row = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
      eq(piSessions.agentId, input.agentId),
    ),
    columns: { id: true },
  });

  return Boolean(row);
}

export async function resolveAutomationDeliveryTarget(input: {
  job: AutomationJobRecord;
  userId: string;
  defaultSessionId: string;
}): Promise<AutomationDeliveryResolution> {
  const { job, userId, defaultSessionId } = input;
  const warnings: string[] = [];
  const delivery = resolveDeliveryChannel(job, userId);

  let sessionId = defaultSessionId;
  let mode: AutomationDeliveryResolution['mode'] = 'new_session';

  if (job.deliverySessionMode === 'fixed_session') {
    const fixedSessionId = job.deliverySessionId?.trim();
    if (fixedSessionId && await verifySessionOwnership({ sessionId: fixedSessionId, userId, agentId: job.agentId })) {
      sessionId = fixedSessionId;
      mode = 'fixed_session';
    } else {
      warnings.push('Fixed delivery session was missing or not accessible for this agent; created a new automation session instead.');
    }
  } else if (job.deliverySessionMode === 'channel_active') {
    if (delivery.channelSessionKey) {
      const activeSessionId = await getActiveChannelSession({
        channelId: delivery.channelId,
        channelSessionKey: delivery.channelSessionKey,
      });
      if (activeSessionId && await verifySessionOwnership({ sessionId: activeSessionId, userId, agentId: job.agentId })) {
        sessionId = activeSessionId;
        mode = 'channel_active';
      } else {
        warnings.push('No active delivery session was available for this channel and agent; created a new automation session instead.');
      }
    } else {
      warnings.push('Delivery channel session key is required for channel_active delivery; created a new automation session instead.');
    }
  }

  await ensureSessionChannelLink({
    sessionId,
    userId,
    channelId: delivery.channelId,
    channelSessionKey: delivery.channelSessionKey || defaultWebChannelSessionKey(userId),
    isPrimary: delivery.channelId === WEB_CHANNEL_ID,
    deliveryPolicy: job.deliveryMode === 'silent' ? 'muted' : 'last_active',
  });

  return {
    sessionId,
    mode,
    channelId: delivery.channelId,
    channelSessionKey: delivery.channelSessionKey || defaultWebChannelSessionKey(userId),
    warnings,
    activeDelivery: delivery.activeDelivery,
  };
}
