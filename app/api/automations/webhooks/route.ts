import { NextRequest, NextResponse } from 'next/server';

import { applyAutomationRateLimit, assertCanCreateRequestedAutomation, requireAutomationSession } from '@/app/lib/automations/api';
import { createCustomWebhookAutomationJob } from '@/app/lib/automations/store';

function webhookUrlForRequest(request: NextRequest, webhookId: string): string {
  return new URL(`/api/automations/webhooks/${encodeURIComponent(webhookId)}`, request.nextUrl.origin).toString();
}

export async function POST(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) {
    return response;
  }

  const limited = applyAutomationRateLimit(request, 'automations-custom-webhooks-post', 20);
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    assertCanCreateRequestedAutomation(payload, session.user.id);
    const created = await createCustomWebhookAutomationJob(payload, session.user.id);
    const webhookId = created.job.customWebhookId;
    return NextResponse.json({
      success: true,
      data: {
        job: created.job,
        secret: created.secret,
        webhookUrl: webhookId ? webhookUrlForRequest(request, webhookId) : null,
      },
    }, { status: 201 });
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 400;
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create webhook automation.' },
      { status },
    );
  }
}
