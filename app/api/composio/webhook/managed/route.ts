import { NextRequest, NextResponse } from 'next/server';

import { dispatchAutomationRunExecution } from '@/app/lib/automations/dispatch';
import {
  createPendingAutomationRun,
  getAutomationJobByComposioTriggerId,
  getComposioWebhookEventByKeys,
  markComposioWebhookEventDispatched,
  recordComposioWebhookEvent,
} from '@/app/lib/automations/store';

function bearerToken(request: NextRequest): string {
  const authorization = request.headers.get('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(request: NextRequest) {
  if (process.env.CANVAS_MANAGED_SERVICES_ENABLED !== 'true') {
    return NextResponse.json({ accepted: false, reason: 'managed_services_disabled' }, { status: 403 });
  }

  const expectedToken = process.env.CANVAS_INSTANCE_TOKEN?.trim();
  if (!expectedToken || bearerToken(request) !== expectedToken) {
    return NextResponse.json({ accepted: false, reason: 'unauthorized' }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = await request.json();
    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return NextResponse.json({ accepted: false, reason: 'invalid_json' }, { status: 400 });
  }

  const eventId = stringValue(payload.eventId) || request.headers.get('x-canvas-managed-event-id') || '';
  const webhookId = stringValue(payload.webhookId) || eventId;
  const triggerId = stringValue(payload.triggerId);
  const triggerSlug = stringValue(payload.triggerSlug);
  const toolkitSlug = stringValue(payload.toolkitSlug);
  const connectedAccountId = stringValue(payload.connectedAccountId);
  const composioUserId = stringValue(payload.composioUserId);
  const eventData = payload.payload ?? {};

  if (!triggerId || !eventId) {
    return NextResponse.json({ accepted: false, reason: 'missing_event_identity' }, { status: 400 });
  }

  const duplicate = await getComposioWebhookEventByKeys({ eventId, webhookId });
  if (duplicate) {
    return NextResponse.json({ accepted: false, reason: 'duplicate' });
  }

  const job = await getAutomationJobByComposioTriggerId(triggerId);
  if (!job) {
    await recordComposioWebhookEvent({
      eventId,
      webhookId,
      triggerId,
      source: 'managed',
      status: 'ignored',
      error: 'unknown_trigger',
      metadataJson: { payload },
    });
    return NextResponse.json({ accepted: false, reason: 'unknown_trigger' });
  }

  if (job.status !== 'active') {
    await recordComposioWebhookEvent({
      eventId,
      webhookId,
      triggerId,
      jobId: job.id,
      source: 'managed',
      status: 'ignored',
      error: 'paused',
      metadataJson: { payload },
    });
    return NextResponse.json({ accepted: false, reason: 'paused' });
  }

  if (
    (job.composioUserId && composioUserId && job.composioUserId !== composioUserId) ||
    (job.composioConnectedAccountId && connectedAccountId && job.composioConnectedAccountId !== connectedAccountId)
  ) {
    await recordComposioWebhookEvent({
      eventId,
      webhookId,
      triggerId,
      jobId: job.id,
      source: 'managed',
      status: 'rejected',
      error: 'ownership_mismatch',
      metadataJson: { payload },
    });
    return NextResponse.json({ accepted: false, reason: 'ownership_mismatch' }, { status: 403 });
  }

  const eventRecord = await recordComposioWebhookEvent({
    eventId,
    webhookId,
    triggerId,
    jobId: job.id,
    source: 'managed',
    status: 'accepted',
    metadataJson: { payload },
  });
  const run = await createPendingAutomationRun(job.id, 'webhook', {
    metadataJson: {
      webhook: {
        provider: 'composio',
        source: 'managed',
        eventId,
        webhookId,
        triggerId,
        triggerSlug: triggerSlug || job.composioTriggerSlug || 'unknown',
        toolkitSlug: toolkitSlug || job.composioToolkitSlug || 'unknown',
        connectedAccountId: connectedAccountId || job.composioConnectedAccountId || null,
        composioUserId: composioUserId || job.composioUserId || null,
        timestamp: new Date().toISOString(),
        data: eventData,
      },
    },
  });
  await markComposioWebhookEventDispatched(eventRecord.id, run.id);
  dispatchAutomationRunExecution(run.id);
  return NextResponse.json({ accepted: true, runId: run.id });
}
