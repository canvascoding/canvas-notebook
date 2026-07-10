import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { testAgentModelConnection } from '@/app/lib/agents/model-test';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { auth } from '@/app/lib/auth';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { markInstanceProviderVerified } from '@/app/lib/server-settings';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  if (!isOnboardingEnabled()) {
    return NextResponse.json({ success: false, error: 'Onboarding is disabled.' }, { status: 403 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdminUser(session.user)) {
    return NextResponse.json({ success: false, error: 'Forbidden: owner or admin required.' }, { status: 403 });
  }
  if (await isOnboardingComplete()) {
    return NextResponse.json({ success: false, error: 'Instance onboarding is already complete.' }, { status: 409 });
  }

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'onboarding-provider-verify',
  });
  if (!limited.ok) return limited.response;

  const result = await testAgentModelConnection({ agentId: DEFAULT_MANAGED_AGENT_ID });
  if (!result.success) {
    return NextResponse.json({
      success: false,
      code: result.code || 'MODEL_TEST_FAILED',
      error: 'Could not verify the configured model. Check the provider, model, and credentials.',
    }, { status: 400 });
  }

  const settings = await markInstanceProviderVerified(session.user.id);
  return NextResponse.json({
    success: true,
    data: {
      providerVerifiedAt: settings.providerVerifiedAt,
      model: result.model,
      provider: result.provider,
    },
  });
}
