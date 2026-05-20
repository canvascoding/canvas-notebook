import { NextRequest, NextResponse } from 'next/server';

import { getComposio } from '@/app/lib/composio/composio-client';
import { getComposioMode } from '@/app/lib/composio/composio-client';
import { decryptWebhookSecret } from '@/app/lib/composio/composio-webhook-secret';
import { dispatchAutomationRunExecution } from '@/app/lib/automations/dispatch';
import {
  createPendingAutomationRun,
  getAutomationJobByComposioTriggerId,
  getComposioWebhookEventByKeys,
  markComposioWebhookEventDispatched,
  recordComposioWebhookEvent,
  updateAutomationJob,
} from '@/app/lib/automations/store';
import { db } from '@/app/lib/db';
import { composioWebhookSubscriptions } from '@/app/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(request: NextRequest) {
  const mode = await getComposioMode();
  if (mode !== 'local') {
    return NextResponse.json(
      { accepted: false, reason: 'local_mode_only' },
      { status: 403 },
    );
  }

  const rawBody = await request.text();
  const webhookId = request.headers.get('webhook-id') || '';
  const signature = request.headers.get('webhook-signature') || '';
  const timestamp = request.headers.get('webhook-timestamp') || '';

  const [subscription] = await db
    .select()
    .from(composioWebhookSubscriptions)
    .where(eq(composioWebhookSubscriptions.status, 'active'))
    .orderBy(desc(composioWebhookSubscriptions.updatedAt))
    .limit(1);

  if (!subscription) {
    return NextResponse.json(
      { accepted: false, reason: 'no_webhook_subscription' },
      { status: 503 },
    );
  }

  const composio = await getComposio();
  if (!composio) {
    return NextResponse.json(
      { accepted: false, reason: 'composio_not_configured' },
      { status: 503 },
    );
  }

  let verified: Awaited<ReturnType<typeof composio.triggers.verifyWebhook>>;
  try {
    const secret = await decryptWebhookSecret(subscription.encryptedSecret);
    verified = await composio.triggers.verifyWebhook({
      id: webhookId,
      payload: rawBody,
      signature,
      timestamp,
      secret,
    });
  } catch (error) {
    console.error('[Composio Webhook] Signature verification failed', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { accepted: false, reason: 'invalid_signature' },
      { status: 401 },
    );
  }

  let rawPayload: Record<string, unknown>;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    rawPayload = (typeof verified.rawPayload === 'object' && verified.rawPayload !== null)
      ? verified.rawPayload as Record<string, unknown>
      : {};
  }
  const verifiedRecord = verified.payload as Record<string, unknown> ?? {};

  const metadata = typeof rawPayload.metadata === 'object' && rawPayload.metadata !== null
    ? rawPayload.metadata as Record<string, unknown>
    : {};
  const data = typeof rawPayload.data === 'object' && rawPayload.data !== null
    ? rawPayload.data as Record<string, unknown>
    : {};

  const eventType = stringValue(rawPayload.type || verifiedRecord.triggerSlug || 'unknown');
  const eventId = stringValue(rawPayload.id || metadata.event_id || metadata.eventId || webhookId);
  const triggerId = stringValue(
    metadata.trigger_id || metadata.triggerId || data.trigger_id || data.triggerId || verifiedRecord.id || verifiedRecord.uuid,
  );
  const triggerSlug = stringValue(
    metadata.trigger_slug || metadata.triggerSlug || data.trigger_slug || data.triggerSlug || verifiedRecord.triggerSlug,
  );
  const connectedAccountId = stringValue(
    metadata.connected_account_id || metadata.connectedAccountId || data.connected_account_id || data.connectedAccountId,
  );
  const composioUserId = stringValue(
    metadata.user_id || metadata.userId || metadata.composio_user_id || data.user_id || data.userId || verifiedRecord.userId,
  );

  if (!triggerId || !eventId) {
    return NextResponse.json(
      { accepted: false, reason: 'missing_event_identity' },
      { status: 400 },
    );
  }

  const duplicate = await getComposioWebhookEventByKeys({ eventId, webhookId });
  if (duplicate) {
    return NextResponse.json({ accepted: false, reason: 'duplicate' });
  }

  if (eventType === 'composio.connected_account.expired') {
    await recordComposioWebhookEvent({
      eventId,
      webhookId,
      triggerId,
      source: 'local',
      status: 'account_expired',
      metadataJson: { eventType, rawPayload: JSON.stringify(rawPayload).slice(0, 10000), verifiedPayload: verifiedRecord },
    });
    if (triggerId) {
      const job = await getAutomationJobByComposioTriggerId(triggerId);
      if (job && job.status === 'active') {
        await updateAutomationJob(job.id, { status: 'paused' });
        console.log(`[Composio Webhook] Paused job ${job.id} because connected account expired`);
      }
    }
    return NextResponse.json({ accepted: true, action: 'account_expired' });
  }

  if (eventType === 'composio.trigger.disabled') {
    await recordComposioWebhookEvent({
      eventId,
      webhookId,
      triggerId,
      source: 'local',
      status: 'trigger_disabled',
      metadataJson: { eventType, rawPayload: JSON.stringify(rawPayload).slice(0, 10000), verifiedPayload: verifiedRecord },
    });
    if (triggerId) {
      const job = await getAutomationJobByComposioTriggerId(triggerId);
      if (job && job.status === 'active') {
        await updateAutomationJob(job.id, { status: 'paused' });
        console.log(`[Composio Webhook] Paused job ${job.id} because trigger was disabled`);
      }
    }
    return NextResponse.json({ accepted: true, action: 'trigger_disabled' });
  }

  const job = await getAutomationJobByComposioTriggerId(triggerId);
  if (!job) {
    await recordComposioWebhookEvent({
      eventId,
      webhookId,
      triggerId,
      source: 'local',
      status: 'ignored',
      error: 'unknown_trigger',
      metadataJson: { eventType, rawPayload: JSON.stringify(rawPayload).slice(0, 10000) },
    });
    return NextResponse.json(
      { accepted: false, reason: 'unknown_trigger' },
      { status: 404 },
    );
  }

  if (job.status !== 'active') {
    await recordComposioWebhookEvent({
      eventId,
      webhookId,
      triggerId,
      jobId: job.id,
      source: 'local',
      status: 'ignored',
      error: 'paused',
      metadataJson: { eventType, rawPayload: JSON.stringify(rawPayload).slice(0, 10000) },
    });
    return NextResponse.json(
      { accepted: false, reason: 'paused' },
      { status: 403 },
    );
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
      source: 'local',
      status: 'rejected',
      error: 'ownership_mismatch',
      metadataJson: { eventType, composioUserId, connectedAccountId, rawPayload: JSON.stringify(rawPayload).slice(0, 10000) },
    });
    return NextResponse.json(
      { accepted: false, reason: 'ownership_mismatch' },
      { status: 403 },
    );
  }

  const eventRecord = await recordComposioWebhookEvent({
    eventId,
    webhookId,
    triggerId,
    jobId: job.id,
    source: 'local',
    status: 'accepted',
    metadataJson: { rawPayload: JSON.stringify(rawPayload).slice(0, 10000) },
  });

  const run = await createPendingAutomationRun(job.id, 'webhook', {
    metadataJson: {
      webhook: {
        provider: 'composio',
        source: 'local',
        eventId,
        webhookId,
        triggerId,
        triggerSlug: triggerSlug || job.composioTriggerSlug || 'unknown',
        toolkitSlug: job.composioToolkitSlug || 'unknown',
        connectedAccountId: connectedAccountId || job.composioConnectedAccountId || null,
        composioUserId: composioUserId || job.composioUserId || null,
        timestamp: new Date().toISOString(),
        data,
      },
    },
  });

  await markComposioWebhookEventDispatched(eventRecord.id, run.id);
  dispatchAutomationRunExecution(run.id);

  return NextResponse.json({ accepted: true, runId: run.id });
}
