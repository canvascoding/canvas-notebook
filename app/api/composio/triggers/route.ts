import { NextRequest, NextResponse } from 'next/server';

import {
  assertCanCreateRequestedAutomation,
  getAutomationRouteErrorStatus,
  requireAutomationSession,
} from '@/app/lib/automations/api';
import type { AutomationDeliveryMode, AutomationDeliverySessionMode } from '@/app/lib/automations/types';
import { createWebhookAutomationJob } from '@/app/lib/automations/store';
import { createGatewayTrigger, getGatewayTriggerTypes, listGatewayTriggers } from '@/app/lib/composio/composio-gateway';
import { getComposioUserId } from '@/app/lib/composio/composio-identity';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function logTriggerRoute(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.log(`[Composio Triggers API] ${message}`, details);
  } else {
    console.log(`[Composio Triggers API] ${message}`);
  }
}

function logTriggerRouteError(message: string, error: unknown, details?: Record<string, unknown>): void {
  console.error(`[Composio Triggers API] ${message}`, {
    ...details,
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function GET(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) return response;

  const storageScope = { userId: session.user.id };
  const toolkit = request.nextUrl.searchParams.get('toolkit') || '';
  try {
    logTriggerRoute('GET started', { toolkit: toolkit || null });
    if (toolkit) {
      const result = await getGatewayTriggerTypes(toolkit, storageScope);
      logTriggerRoute('GET trigger types completed', {
        toolkit,
        count: Array.isArray(result.triggerTypes) ? result.triggerTypes.length : 0,
      });
      return NextResponse.json({ success: true, data: result });
    }
    const result = await listGatewayTriggers(storageScope);
    logTriggerRoute('GET active triggers completed', {
      count: Array.isArray(result.triggers) ? result.triggers.length : 0,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    logTriggerRouteError('GET failed', error, { toolkit: toolkit || null });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to load Composio triggers.' },
      { status: 400 },
    );
  }
}

export async function POST(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) return response;

  const storageScope = { userId: session.user.id };
  try {
    const payload = recordValue(await request.json());
    assertCanCreateRequestedAutomation(payload, session.user);
    const name = stringValue(payload.name);
    const prompt = stringValue(payload.prompt);
    const triggerSlug = stringValue(payload.triggerSlug);
    const toolkitSlug = stringValue(payload.toolkitSlug);
    const connectedAccountId = stringValue(payload.connectedAccountId);
    const triggerConfig = recordValue(payload.triggerConfig);
    logTriggerRoute('POST started', {
      triggerSlug,
      toolkitSlug,
      hasConnectedAccountId: Boolean(connectedAccountId),
      hasTriggerConfig: Object.keys(triggerConfig).length > 0,
    });
    if (!name || !prompt || !triggerSlug) {
      return NextResponse.json({ success: false, error: 'Name, prompt, and triggerSlug are required.' }, { status: 400 });
    }

    const created = await createGatewayTrigger({
      triggerSlug,
      toolkitSlug,
      connectedAccountId: connectedAccountId || undefined,
      triggerConfig,
      notebookWebhookUrl: stringValue(payload.notebookWebhookUrl) || null,
    }, storageScope);
    const trigger = recordValue(created.trigger);
    const triggerId = stringValue(trigger.triggerId) || stringValue(trigger.trigger_id);
    if (!triggerId) {
      logTriggerRouteError('POST failed because Composio returned no trigger ID', new Error('Missing trigger ID'), { triggerSlug, toolkitSlug });
      return NextResponse.json({ success: false, error: 'Composio did not return a trigger ID.' }, { status: 502 });
    }

    const job = await createWebhookAutomationJob({
      name,
      prompt,
      workspaceContextPaths: Array.isArray(payload.workspaceContextPaths) ? payload.workspaceContextPaths.filter((entry): entry is string => typeof entry === 'string') : [],
      targetOutputPath: typeof payload.targetOutputPath === 'string' ? payload.targetOutputPath : null,
      preferredSkill: stringValue(payload.preferredSkill) || 'auto',
      agentId: stringValue(payload.agentId) || undefined,
      deliveryMode: stringValue(payload.deliveryMode) as AutomationDeliveryMode || undefined,
      deliveryChannelId: stringValue(payload.deliveryChannelId) || null,
      deliverySessionMode: stringValue(payload.deliverySessionMode) as AutomationDeliverySessionMode || undefined,
      deliverySessionId: stringValue(payload.deliverySessionId) || null,
      deliveryChannelSessionKey: stringValue(payload.deliveryChannelSessionKey) || null,
      status: payload.status === 'paused' ? 'paused' : 'active',
      composioTriggerId: triggerId,
      composioTriggerSlug: stringValue(trigger.triggerSlug) || triggerSlug,
      composioToolkitSlug: stringValue(trigger.toolkitSlug) || toolkitSlug || triggerSlug.split('_')[0]?.toLowerCase() || 'unknown',
      composioConnectedAccountId: stringValue(trigger.connectedAccountId) || connectedAccountId || '',
      composioUserId: stringValue(trigger.composioUserId) || await getComposioUserId(storageScope),
      webhookTriggerConfig: triggerConfig,
      scope: stringValue(payload.scope) as 'personal' | 'organization' | 'team' || undefined,
      workspaceId: stringValue(payload.workspaceId) || null,
    }, session.user);

    logTriggerRoute('POST completed', { triggerId, jobId: job.id, triggerSlug, toolkitSlug });
    return NextResponse.json({ success: true, data: { trigger, job } }, { status: 201 });
  } catch (error) {
    logTriggerRouteError('POST failed', error);
    const status = getAutomationRouteErrorStatus(error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create Composio trigger.' },
      { status },
    );
  }
}
