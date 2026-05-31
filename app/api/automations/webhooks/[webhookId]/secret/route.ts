import { NextRequest, NextResponse } from 'next/server';

import { applyAutomationRateLimit, requireAutomationSession } from '@/app/lib/automations/api';
import { rotateAutomationWebhookSecret } from '@/app/lib/automations/store';

type RouteContext = {
  params: Promise<{ webhookId: string }>;
};

function webhookUrlForRequest(request: NextRequest, webhookId: string): string {
  return new URL(`/api/automations/webhooks/${encodeURIComponent(webhookId)}`, request.nextUrl.origin).toString();
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-custom-webhooks-secret-post', 10);
  if (!limited.ok) {
    return limited.response;
  }

  const { webhookId } = await context.params;
  const rotated = await rotateAutomationWebhookSecret(webhookId, session.user.id);
  if (!rotated) {
    return NextResponse.json({ success: false, error: 'Webhook not found.' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    data: {
      job: rotated.job,
      secret: rotated.secret,
      webhookUrl: webhookUrlForRequest(request, webhookId),
    },
  });
}
