import { NextRequest, NextResponse } from 'next/server';

import { applyAutomationRateLimit, requireAutomationSession } from '@/app/lib/automations/api';
import { readHeartbeatConfig, saveHeartbeatConfig } from '@/app/lib/automations/heartbeat-config';
import type {
  AutomationDeliveryMode,
  AutomationDeliverySessionMode,
  FriendlySchedule,
} from '@/app/lib/automations/types';

type HeartbeatPutPayload = {
  agentId?: string;
  enabled?: boolean;
  schedule?: FriendlySchedule;
  deliveryMode?: AutomationDeliveryMode;
  deliveryChannelId?: string | null;
  deliverySessionMode?: AutomationDeliverySessionMode;
  deliverySessionId?: string | null;
  deliveryChannelSessionKey?: string | null;
};

function getAgentId(value: string | null | undefined): string {
  const agentId = value?.trim();
  if (!agentId) {
    throw new Error('agentId is required.');
  }
  return agentId;
}

export async function GET(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-heartbeat-get');
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const agentId = getAgentId(request.nextUrl.searchParams.get('agentId'));
    const config = await readHeartbeatConfig({
      userId: session.user.id,
      agentId,
    });
    return NextResponse.json({ success: true, data: config });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to get heartbeat config.' },
      { status: 400 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-heartbeat-put', 30);
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = (await request.json()) as HeartbeatPutPayload;
    const agentId = getAgentId(payload.agentId);
    const config = await saveHeartbeatConfig({
      userId: session.user.id,
      agentId,
      enabled: payload.enabled,
      schedule: payload.schedule,
      deliveryMode: payload.deliveryMode,
      deliveryChannelId: payload.deliveryChannelId,
      deliverySessionMode: payload.deliverySessionMode,
      deliverySessionId: payload.deliverySessionId,
      deliveryChannelSessionKey: payload.deliveryChannelSessionKey,
    });
    return NextResponse.json({ success: true, data: config });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to save heartbeat config.' },
      { status: 400 },
    );
  }
}
