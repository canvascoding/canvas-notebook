import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import { resolveOnboardingPhase } from '@/app/lib/onboarding/flow';
import {
  isOnboardingComplete,
  isOnboardingEnabled,
} from '@/app/lib/onboarding/status';
import {
  MobileOnboardingTransitionError,
  parseMobileOnboardingAction,
  resolveMobileOnboardingUpdate,
} from '@/app/lib/mobile/onboarding-contract';
import { getInstanceOnboardingStep } from '@/app/lib/server-settings';
import {
  createCompletedUserOnboardingState,
  getUserOnboardingState,
  updateUserOnboardingState,
  type UserOnboardingState,
} from '@/app/lib/user-preferences';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

function errorResponse(error: string, code: string, status: number) {
  return NextResponse.json(
    { success: false, error, code },
    { status, headers: responseHeaders },
  );
}

function successResponse(input: {
  enabled: boolean;
  instanceComplete: boolean;
  canManageInstance: boolean;
  instanceStep: Awaited<ReturnType<typeof getInstanceOnboardingStep>> | null;
  userOnboarding: UserOnboardingState;
}) {
  const phase = input.enabled
    ? resolveOnboardingPhase({
        instanceComplete: input.instanceComplete,
        isInstanceAdmin: input.canManageInstance,
        userOnboarding: input.userOnboarding,
      })
    : 'complete';

  return NextResponse.json(
    {
      success: true,
      data: {
        enabled: input.enabled,
        phase,
        instance: {
          complete: input.instanceComplete,
          canManage: input.canManageInstance,
          step: input.instanceStep,
        },
        user: input.userOnboarding,
      },
    },
    { headers: responseHeaders },
  );
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);

  const enabled = isOnboardingEnabled();
  if (!enabled) {
    return successResponse({
      enabled,
      instanceComplete: true,
      canManageInstance: false,
      instanceStep: null,
      userOnboarding: createCompletedUserOnboardingState(),
    });
  }

  try {
    const instanceComplete = await isOnboardingComplete();
    const canManageInstance = isAdminUser(session.user);
    const [instanceStep, userOnboarding] = await Promise.all([
      instanceComplete ? Promise.resolve(null) : getInstanceOnboardingStep(),
      getUserOnboardingState(session.user.id, {
        missing: instanceComplete ? 'complete' : 'pending',
      }),
    ]);

    return successResponse({
      enabled,
      instanceComplete,
      canManageInstance,
      instanceStep,
      userOnboarding,
    });
  } catch (error) {
    console.error('[API] Mobile onboarding state could not be loaded:', error);
    return errorResponse(
      'Onboarding state could not be loaded.',
      'ONBOARDING_STATE_UNAVAILABLE',
      500,
    );
  }
}

export async function PATCH(request: NextRequest) {
  if (!isOnboardingEnabled()) {
    return errorResponse('Onboarding is not enabled.', 'ONBOARDING_DISABLED', 403);
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'mobile-onboarding-progress',
  });
  if (!limited.ok) return limited.response;

  const payload = parseMobileOnboardingAction(
    await request.json().catch(() => null),
  );
  if (!payload) {
    return errorResponse(
      'Unsupported onboarding action.',
      'UNSUPPORTED_ONBOARDING_ACTION',
      400,
    );
  }
  if (!(await isOnboardingComplete())) {
    return errorResponse(
      'Finish instance setup before personal onboarding begins.',
      'INSTANCE_SETUP_REQUIRED',
      409,
    );
  }

  try {
    const current = await getUserOnboardingState(session.user.id);
    const update = resolveMobileOnboardingUpdate(current, payload);
    const user = update
      ? await updateUserOnboardingState(session.user.id, update)
      : current;

    return NextResponse.json(
      { success: true, data: { user } },
      { headers: responseHeaders },
    );
  } catch (error) {
    if (error instanceof MobileOnboardingTransitionError) {
      return errorResponse(error.message, error.code, error.statusCode);
    }
    console.error('[API] Mobile onboarding state could not be updated:', error);
    return errorResponse(
      'Onboarding progress could not be saved.',
      'ONBOARDING_UPDATE_FAILED',
      500,
    );
  }
}
