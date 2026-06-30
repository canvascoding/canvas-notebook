import 'server-only';

import {
  getHeartbeatJob,
  upsertHeartbeatJob,
} from './store';
import { DEFAULT_USER_TIME_ZONE } from '@/app/lib/time-zones';
import { getServerPreferredTimeZone } from '@/app/lib/server-settings';
import type {
  AutomationDeliveryMode,
  AutomationDeliverySessionMode,
  AutomationJobRecord,
  AutomationRunStatus,
  FriendlySchedule,
} from './types';

export type HeartbeatConfig = {
  configured: boolean;
  enabled: boolean;
  agentId: string;
  schedule: FriendlySchedule | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: AutomationRunStatus | null;
  jobId: string | null;
  deliveryMode: AutomationDeliveryMode;
  deliveryChannelId: string | null;
  deliverySessionMode: AutomationDeliverySessionMode;
  deliverySessionId: string | null;
  deliveryChannelSessionKey: string | null;
};

export type SaveHeartbeatConfigInput = {
  userId: string;
  agentId: string;
  enabled?: boolean;
  schedule?: FriendlySchedule;
  deliveryMode?: AutomationDeliveryMode;
  deliveryChannelId?: string | null;
  deliverySessionMode?: AutomationDeliverySessionMode;
  deliverySessionId?: string | null;
  deliveryChannelSessionKey?: string | null;
};

export function getDefaultHeartbeatSchedule(timeZone = DEFAULT_USER_TIME_ZONE): FriendlySchedule {
  return {
    kind: 'interval',
    every: 60,
    unit: 'minutes',
    timeZone,
    workingHours: {
      enabled: true,
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '09:00',
      end: '18:00',
      timeZone,
    },
  };
}

function serializeHeartbeatConfig(job: AutomationJobRecord | null, agentId: string): HeartbeatConfig {
  if (!job) {
    return {
      configured: false,
      enabled: false,
      agentId,
      schedule: null,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: null,
      jobId: null,
      deliveryMode: 'last_active',
      deliveryChannelId: null,
      deliverySessionMode: 'channel_active',
      deliverySessionId: null,
      deliveryChannelSessionKey: null,
    };
  }

  return {
    configured: true,
    enabled: job.status === 'active',
    agentId: job.agentId,
    schedule: job.schedule,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    lastRunStatus: job.lastRunStatus,
    jobId: job.id,
    deliveryMode: job.deliveryMode,
    deliveryChannelId: job.deliveryChannelId,
    deliverySessionMode: job.deliverySessionMode,
    deliverySessionId: job.deliverySessionId,
    deliveryChannelSessionKey: job.deliveryChannelSessionKey,
  };
}

export async function readHeartbeatConfig(input: {
  userId: string;
  agentId: string;
}): Promise<HeartbeatConfig> {
  const job = await getHeartbeatJob(input);
  return serializeHeartbeatConfig(job, input.agentId);
}

export async function saveHeartbeatConfig(input: SaveHeartbeatConfigInput): Promise<HeartbeatConfig> {
  const existing = await getHeartbeatJob({
    userId: input.userId,
    agentId: input.agentId,
  });

  const preferredTimeZone = await getServerPreferredTimeZone();
  const schedule = input.schedule ?? existing?.schedule ?? getDefaultHeartbeatSchedule(preferredTimeZone);
  const enabled = input.enabled ?? (existing?.status === 'active');
  const deliveryMode = input.deliveryMode ?? existing?.deliveryMode ?? 'last_active';
  const job = await upsertHeartbeatJob({
    userId: input.userId,
    agentId: input.agentId,
    enabled,
    schedule,
    deliveryMode,
    deliveryChannelId: input.deliveryChannelId === undefined
      ? existing?.deliveryChannelId ?? (deliveryMode === 'web' ? 'web' : null)
      : input.deliveryChannelId,
    deliverySessionMode: input.deliverySessionMode ?? existing?.deliverySessionMode ?? 'channel_active',
    deliverySessionId: input.deliverySessionId === undefined ? existing?.deliverySessionId ?? null : input.deliverySessionId,
    deliveryChannelSessionKey: input.deliveryChannelSessionKey === undefined ? existing?.deliveryChannelSessionKey ?? null : input.deliveryChannelSessionKey,
  });

  return serializeHeartbeatConfig(job, input.agentId);
}
