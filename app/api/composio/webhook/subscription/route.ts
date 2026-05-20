import { NextRequest, NextResponse } from 'next/server';

import { getComposioMode } from '@/app/lib/composio/composio-client';
import { ensureLocalWebhookSubscription, getLocalWebhookSubscription } from '@/app/lib/composio/composio-gateway';

function currentWebhookUrl(): string {
  const baseUrl = process.env.BASE_URL || process.env.APP_BASE_URL;
  const base = baseUrl
    ? baseUrl.replace(/\/+$/, '')
    : `http://localhost:${process.env.PORT || '3000'}`;
  return `${base}/api/composio/webhook`;
}

export async function GET() {
  const mode = await getComposioMode();
  if (mode !== 'local') {
    return NextResponse.json(
      { configured: false, mode, reason: mode === 'managed' ? 'Webhook subscriptions are managed by the Control Plane.' : 'Composio is not configured.' },
      { status: 403 },
    );
  }

  const subscription = await getLocalWebhookSubscription();
  const expectedUrl = currentWebhookUrl();
  if (!subscription) {
    return NextResponse.json({
      configured: false,
      webhookUrl: null,
      expectedUrl,
      urlMismatch: false,
      eventTypes: [],
      secretPreview: null,
      mode: 'local',
    });
  }

  const urlMismatch = subscription.webhookUrl !== expectedUrl;
  return NextResponse.json({
    configured: true,
    webhookUrl: subscription.webhookUrl,
    expectedUrl,
    urlMismatch,
    eventTypes: subscription.eventTypes ? JSON.parse(subscription.eventTypes) : [],
    secretPreview: subscription.secretPreview,
    subscriptionId: subscription.subscriptionId,
    status: subscription.status,
    mode: subscription.mode,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  });
}

export async function POST(request: NextRequest) {
  const mode = await getComposioMode();
  if (mode !== 'local') {
    return NextResponse.json(
      { error: mode === 'managed' ? 'Webhook subscriptions are managed by the Control Plane.' : 'Composio is not configured.' },
      { status: 403 },
    );
  }

  let rotate = false;
  try {
    const body = await request.json();
    rotate = Boolean(body.rotate);
  } catch { /* empty body is fine */ }

  try {
    const subscription = await ensureLocalWebhookSubscription({ forceRefresh: rotate });
    return NextResponse.json({
      configured: true,
      webhookUrl: subscription.webhookUrl,
      eventTypes: subscription.eventTypes ? JSON.parse(subscription.eventTypes) : [],
      secretPreview: subscription.secretPreview,
      subscriptionId: subscription.subscriptionId,
      status: subscription.status,
      mode: subscription.mode,
      rotated: rotate,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create webhook subscription' },
      { status: 502 },
    );
  }
}