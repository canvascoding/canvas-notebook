import { NextRequest, NextResponse } from 'next/server';

import { dispatchAutomationRunExecution } from '@/app/lib/automations/dispatch';
import {
  getAutomationWebhookEventByKeys,
  getAutomationWebhookTriggerWithJob,
  markAutomationWebhookEventDispatched,
  markAutomationWebhookEventStatus,
  recordAutomationWebhookEvent,
  scheduleAutomationJobRun,
} from '@/app/lib/automations/store';
import { verifyAutomationWebhookSecret } from '@/app/lib/automations/webhook-secret';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

type RouteContext = {
  params: Promise<{ webhookId: string }>;
};

function bearerToken(request: NextRequest): string {
  const authorization = request.headers.get('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getPayloadEventId(payload: Record<string, unknown>): string {
  return stringValue(payload.eventId || payload.event_id || payload.id);
}

function payloadByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function parseWebhookPayload(request: NextRequest): Promise<{
  bodyBytes: number;
  payload: Record<string, unknown>;
}> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new Error('payload_too_large');
  }

  const rawBody = await request.text();
  const bodyBytes = payloadByteLength(rawBody);
  if (bodyBytes > MAX_WEBHOOK_BODY_BYTES) {
    throw new Error('payload_too_large');
  }

  if (!rawBody.trim()) {
    return { bodyBytes, payload: {} };
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return { bodyBytes, payload: { body: rawBody } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error('invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_json_object');
  }
  return { bodyBytes, payload: parsed as Record<string, unknown> };
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { webhookId } = await context.params;
  const limited = rateLimit(request, {
    keyPrefix: `automation-webhook:${webhookId}`,
    limit: 30,
    windowMs: 60_000,
  });
  if (!limited.ok) {
    return limited.response;
  }

  const triggerWithJob = await getAutomationWebhookTriggerWithJob(webhookId);
  if (!triggerWithJob || triggerWithJob.trigger.status !== 'active') {
    return NextResponse.json({ accepted: false, reason: 'not_found' }, { status: 404 });
  }

  if (!verifyAutomationWebhookSecret(bearerToken(request), triggerWithJob.trigger.secretHash)) {
    return NextResponse.json({ accepted: false, reason: 'unauthorized' }, { status: 401 });
  }

  let parsed: { bodyBytes: number; payload: Record<string, unknown> };
  try {
    parsed = await parseWebhookPayload(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid_payload';
    return NextResponse.json(
      { accepted: false, reason },
      { status: reason === 'payload_too_large' ? 413 : 400 },
    );
  }

  const job = triggerWithJob.job;
  const eventId = request.headers.get('x-canvas-event-id')?.trim() || getPayloadEventId(parsed.payload) || null;
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() || null;

  const duplicate = await getAutomationWebhookEventByKeys({ webhookId, eventId, idempotencyKey });
  if (duplicate) {
    return NextResponse.json({
      accepted: false,
      reason: 'duplicate',
      runId: duplicate.runId,
    });
  }

  const eventMetadata = {
    eventId,
    idempotencyKey,
    bodyBytes: parsed.bodyBytes,
    payloadKeys: Object.keys(parsed.payload).slice(0, 50),
  };

  if (job.status !== 'active') {
    await recordAutomationWebhookEvent({
      webhookId,
      jobId: job.id,
      eventId,
      idempotencyKey,
      status: 'ignored',
      error: 'paused',
      metadataJson: eventMetadata,
    });
    return NextResponse.json({ accepted: false, reason: 'paused' }, { status: 202 });
  }

  const eventRecord = await recordAutomationWebhookEvent({
    webhookId,
    jobId: job.id,
    eventId,
    idempotencyKey,
    status: 'accepted',
    metadataJson: eventMetadata,
  });

  const timestamp = new Date().toISOString();
  const run = await scheduleAutomationJobRun(job.id, 'webhook', new Date(), {
    metadataJson: {
      webhook: {
        provider: 'custom',
        source: 'custom',
        eventId: eventId || eventRecord.id,
        webhookId,
        triggerId: webhookId,
        triggerSlug: 'custom_webhook',
        toolkitSlug: 'custom',
        timestamp,
        data: parsed.payload,
      },
    },
  });

  if (!run) {
    await markAutomationWebhookEventStatus(eventRecord.id, 'skipped', 'in_flight');
    return NextResponse.json({ accepted: false, reason: 'in_flight' }, { status: 202 });
  }

  await markAutomationWebhookEventDispatched(eventRecord.id, run.id);
  dispatchAutomationRunExecution(run.id);

  return NextResponse.json({ accepted: true, runId: run.id }, { status: 202 });
}
