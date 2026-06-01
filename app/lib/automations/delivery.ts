import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { getActiveChannelSession, getLatestActiveChannelSession, getRecentActiveChannelSessions } from '@/app/lib/channels/active-sessions';
import { getChannelDeliveryReadiness } from '@/app/lib/channels/availability';
import { ensureSessionChannelLink, markChannelLinkOutbound } from '@/app/lib/channels/channel-links';
import { WEB_CHANNEL_ID, webChannelSessionKey } from '@/app/lib/channels/constants';
import { buildDeliveryTarget } from '@/app/lib/channels/delivery-targets';
import { getChannelRegistry } from '@/app/lib/channels/registry';

import type { AutomationJobRecord } from './types';

const JOB_PAUSING_DELIVERY_FAILURES = new Set([
  'missing_channel_session_key',
  'channel_not_registered',
  'channel_disabled',
  'channel_not_configured',
  'channel_unlinked',
]);

export type AutomationDeliveryResolution = {
  sessionId: string;
  mode: 'new_session' | 'fixed_session' | 'channel_active';
  channelId: string;
  channelSessionKey: string;
  warnings: string[];
  activeDelivery: boolean;
};

export type AutomationDeliveryDispatchResult = {
  attempted: boolean;
  delivered: boolean;
  skippedReason: string | null;
  error: string | null;
};

function defaultWebChannelSessionKey(userId: string): string {
  return webChannelSessionKey(userId);
}

async function resolveDeliveryChannel(job: AutomationJobRecord, userId: string) {
  const warnings: string[] = [];
  if (job.deliveryMode === 'last_active') {
    const recentSessions = await getRecentActiveChannelSessions({
      userId,
      agentId: job.agentId,
      limit: 20,
    });

    for (const recentSession of recentSessions) {
      const channelId = recentSession.channelId || WEB_CHANNEL_ID;
      const channelSessionKey = recentSession.channelSessionKey?.trim()
        || (channelId === WEB_CHANNEL_ID ? defaultWebChannelSessionKey(userId) : '');
      if (!channelSessionKey) {
        continue;
      }

      if (channelId !== WEB_CHANNEL_ID) {
        const readiness = await getChannelDeliveryReadiness({
          channelId,
          userId,
          channelSessionKey,
        });
        if (!readiness.ok) {
          warnings.push(`Last active channel "${channelId}" is unavailable (${readiness.reason}); falling back.`);
          continue;
        }
      }

      return {
        channelId,
        channelSessionKey,
        activeDelivery: true,
        warnings,
      };
    }

    warnings.push('No deliverable last active channel was available; falling back to web.');
    return {
      channelId: WEB_CHANNEL_ID,
      channelSessionKey: defaultWebChannelSessionKey(userId),
      activeDelivery: true,
      warnings,
    };
  }

  const channelId = job.deliveryMode === 'silent'
    ? WEB_CHANNEL_ID
    : job.deliveryChannelId?.trim() || WEB_CHANNEL_ID;
  const channelSessionKey = job.deliveryChannelSessionKey?.trim()
    || (channelId === WEB_CHANNEL_ID ? defaultWebChannelSessionKey(userId) : '');

  return {
    channelId,
    channelSessionKey,
    activeDelivery: true,
    warnings,
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
  const delivery = await resolveDeliveryChannel(job, userId);
  warnings.push(...delivery.warnings);

  if (delivery.channelId !== WEB_CHANNEL_ID && !delivery.channelSessionKey) {
    const latest = await getLatestActiveChannelSession({
      userId,
      channelId: delivery.channelId,
      agentId: job.agentId,
    });
    if (latest) {
      delivery.channelSessionKey = latest.channelSessionKey;
    }
  }

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
        agentId: job.agentId,
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

  const resolvedChannelSessionKey = delivery.channelSessionKey
    || (delivery.channelId === WEB_CHANNEL_ID ? defaultWebChannelSessionKey(userId) : '');

  if (resolvedChannelSessionKey) {
    await ensureSessionChannelLink({
      sessionId,
      userId,
      channelId: delivery.channelId,
      channelSessionKey: resolvedChannelSessionKey,
      isPrimary: delivery.channelId === WEB_CHANNEL_ID,
      deliveryPolicy: 'last_active',
    });
  }

  return {
    sessionId,
    mode,
    channelId: delivery.channelId,
    channelSessionKey: resolvedChannelSessionKey,
    warnings,
    activeDelivery: delivery.activeDelivery,
  };
}

export function getAutomationDeliveryFailureMessage(
  resolution: AutomationDeliveryResolution,
  dispatch: AutomationDeliveryDispatchResult,
): string | null {
  if (!resolution.activeDelivery || dispatch.delivered) {
    return null;
  }

  if (dispatch.skippedReason === 'empty_result') {
    return null;
  }

  if (dispatch.skippedReason === 'missing_channel_session_key') {
    return `Automation delivery to channel "${resolution.channelId}" failed: no channel session key is available.`;
  }

  if (dispatch.skippedReason === 'channel_not_registered') {
    return `Automation delivery to channel "${resolution.channelId}" failed: channel is not registered.`;
  }

  if (dispatch.skippedReason === 'channel_disabled') {
    return `Automation delivery to channel "${resolution.channelId}" failed: channel is disabled.`;
  }

  if (dispatch.skippedReason === 'channel_not_configured') {
    return `Automation delivery to channel "${resolution.channelId}" failed: channel is not configured.`;
  }

  if (dispatch.skippedReason === 'channel_unlinked') {
    return `Automation delivery to channel "${resolution.channelId}" failed: channel is no longer linked.`;
  }

  if (dispatch.attempted) {
    return `Automation delivery to channel "${resolution.channelId}" failed${dispatch.error ? `: ${dispatch.error}` : '.'}`;
  }

  if (dispatch.skippedReason) {
    return `Automation delivery to channel "${resolution.channelId}" was skipped: ${dispatch.skippedReason}.`;
  }

  return null;
}

export function shouldPauseAutomationAfterDeliveryFailure(dispatch?: AutomationDeliveryDispatchResult): boolean {
  return Boolean(dispatch?.skippedReason && JOB_PAUSING_DELIVERY_FAILURES.has(dispatch.skippedReason));
}

export async function dispatchAutomationResult(input: {
  job: AutomationJobRecord;
  userId: string;
  resolution: AutomationDeliveryResolution;
  text: string;
}): Promise<AutomationDeliveryDispatchResult> {
  const text = input.text.trim();

  if (!input.resolution.activeDelivery) {
    return {
      attempted: false,
      delivered: false,
      skippedReason: 'inactive_delivery',
      error: null,
    };
  }

  if (!text) {
    return {
      attempted: false,
      delivered: false,
      skippedReason: 'empty_result',
      error: null,
    };
  }

  if (input.resolution.channelId === WEB_CHANNEL_ID) {
    await markChannelLinkOutbound({
      sessionId: input.resolution.sessionId,
      userId: input.userId,
      channelId: WEB_CHANNEL_ID,
      channelSessionKey: input.resolution.channelSessionKey,
    });
    return {
      attempted: true,
      delivered: true,
      skippedReason: null,
      error: null,
    };
  }

  if (!input.resolution.channelSessionKey.trim()) {
    return {
      attempted: false,
      delivered: false,
      skippedReason: 'missing_channel_session_key',
      error: 'Delivery channel session key is required for external channels.',
    };
  }

  const readiness = await getChannelDeliveryReadiness({
    channelId: input.resolution.channelId,
    userId: input.userId,
    channelSessionKey: input.resolution.channelSessionKey,
  });
  if (!readiness.ok) {
    return {
      attempted: false,
      delivered: false,
      skippedReason: readiness.reason,
      error: readiness.error,
    };
  }

  const channel = getChannelRegistry().get(input.resolution.channelId);
  if (!channel) {
    return {
      attempted: false,
      delivered: false,
      skippedReason: 'channel_not_registered',
      error: null,
    };
  }

  const result = await channel.deliver(
    { role: 'assistant', content: text },
    buildDeliveryTarget(
      input.resolution.channelId,
      input.resolution.channelSessionKey,
    ),
  );

  if (result.ok) {
    await markChannelLinkOutbound({
      sessionId: input.resolution.sessionId,
      userId: input.userId,
      channelId: input.resolution.channelId,
      channelSessionKey: input.resolution.channelSessionKey,
    });
  }

  return {
    attempted: true,
    delivered: result.ok,
    skippedReason: null,
    error: result.error ?? null,
  };
}
