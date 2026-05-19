import { NextRequest, NextResponse } from 'next/server';

import { requireAutomationSession } from '@/app/lib/automations/api';
import { createWebhookAutomationJob } from '@/app/lib/automations/store';
import { createGatewayTrigger, getGatewayTriggerTypes, listGatewayTriggers } from '@/app/lib/composio/composio-gateway';
import { getComposioUserId } from '@/app/lib/composio/composio-identity';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function GET(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) return response;

  try {
    const toolkit = request.nextUrl.searchParams.get('toolkit') || '';
    if (toolkit) {
      const result = await getGatewayTriggerTypes(toolkit);
      return NextResponse.json({ success: true, data: result });
    }
    const result = await listGatewayTriggers();
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to load Composio triggers.' },
      { status: 400 },
    );
  }
}

export async function POST(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) return response;

  try {
    const payload = recordValue(await request.json());
    const name = stringValue(payload.name);
    const prompt = stringValue(payload.prompt);
    const triggerSlug = stringValue(payload.triggerSlug);
    const toolkitSlug = stringValue(payload.toolkitSlug);
    const connectedAccountId = stringValue(payload.connectedAccountId);
    const triggerConfig = recordValue(payload.triggerConfig);
    if (!name || !prompt || !triggerSlug) {
      return NextResponse.json({ success: false, error: 'Name, prompt, and triggerSlug are required.' }, { status: 400 });
    }

    const created = await createGatewayTrigger({
      triggerSlug,
      toolkitSlug,
      connectedAccountId: connectedAccountId || undefined,
      triggerConfig,
      notebookWebhookUrl: stringValue(payload.notebookWebhookUrl) || null,
    });
    const trigger = recordValue(created.trigger);
    const triggerId = stringValue(trigger.triggerId) || stringValue(trigger.trigger_id);
    if (!triggerId) {
      return NextResponse.json({ success: false, error: 'Composio did not return a trigger ID.' }, { status: 502 });
    }

    const job = await createWebhookAutomationJob({
      name,
      prompt,
      workspaceContextPaths: Array.isArray(payload.workspaceContextPaths) ? payload.workspaceContextPaths.filter((entry): entry is string => typeof entry === 'string') : [],
      targetOutputPath: typeof payload.targetOutputPath === 'string' ? payload.targetOutputPath : null,
      status: payload.status === 'paused' ? 'paused' : 'active',
      composioTriggerId: triggerId,
      composioTriggerSlug: stringValue(trigger.triggerSlug) || triggerSlug,
      composioToolkitSlug: stringValue(trigger.toolkitSlug) || toolkitSlug || triggerSlug.split('_')[0]?.toLowerCase() || 'unknown',
      composioConnectedAccountId: stringValue(trigger.connectedAccountId) || connectedAccountId || '',
      composioUserId: stringValue(trigger.composioUserId) || await getComposioUserId(),
      webhookTriggerConfig: triggerConfig,
    }, session.user.id);

    return NextResponse.json({ success: true, data: { trigger, job } }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create Composio trigger.' },
      { status: 400 },
    );
  }
}
