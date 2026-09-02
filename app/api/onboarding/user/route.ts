import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveGuidedTourStatus } from '@/app/lib/onboarding/tour-gate';
import { resolveEffectiveAgentRuntime } from '@/app/lib/agent-runtime-policy/runtime-resolver';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import {
  getUserOnboardingState,
  updateUserOnboardingState,
  type UserOnboardingRuntimeStatus,
  type UserOnboardingStep,
  type UserOnboardingTourStatus,
} from '@/app/lib/user-preferences';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';

const USER_ONBOARDING_STEPS = new Set<UserOnboardingStep>(['language', 'workspace', 'profile', 'tour', 'complete']);
const USER_ONBOARDING_RUNTIME_STATUSES = new Set<UserOnboardingRuntimeStatus>(['completed', 'skipped']);
const USER_ONBOARDING_TOUR_STATUSES = new Set<UserOnboardingTourStatus>(['pending', 'started', 'skipped', 'completed']);

function parsePayload(value: unknown): {
  step?: UserOnboardingStep;
  runtime?: UserOnboardingRuntimeStatus;
  tour?: UserOnboardingTourStatus;
  workspaceId?: string;
  agentId?: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as { step?: unknown; runtime?: unknown; tour?: unknown; workspaceId?: unknown; agentId?: unknown };
  const step = typeof payload.step === 'string' && USER_ONBOARDING_STEPS.has(payload.step as UserOnboardingStep)
    ? payload.step as UserOnboardingStep
    : undefined;
  const tour = typeof payload.tour === 'string' && USER_ONBOARDING_TOUR_STATUSES.has(payload.tour as UserOnboardingTourStatus)
    ? payload.tour as UserOnboardingTourStatus
    : undefined;
  const runtime = typeof payload.runtime === 'string'
    && USER_ONBOARDING_RUNTIME_STATUSES.has(payload.runtime as UserOnboardingRuntimeStatus)
    ? payload.runtime as UserOnboardingRuntimeStatus
    : undefined;
  const workspaceId = typeof payload.workspaceId === 'string' && payload.workspaceId.trim()
    ? payload.workspaceId.trim()
    : undefined;
  const agentId = typeof payload.agentId === 'string' && payload.agentId.trim()
    ? payload.agentId.trim()
    : undefined;
  return step || runtime || tour
    ? {
        ...(step ? { step } : {}),
        ...(runtime ? { runtime } : {}),
        ...(tour ? { tour } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(agentId ? { agentId } : {}),
      }
    : null;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const onboarding = await getUserOnboardingState(session.user.id);
  return NextResponse.json({ success: true, data: onboarding });
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'onboarding-user-progress',
  });
  if (!limited.ok) return limited.response;

  const updates = parsePayload(await request.json().catch(() => null));
  if (!updates) {
    return NextResponse.json({ success: false, error: 'Unsupported onboarding update.' }, { status: 400 });
  }

  const current = await getUserOnboardingState(session.user.id);
  const tour = resolveGuidedTourStatus(updates.tour);
  if (updates.runtime !== undefined && updates.step !== 'profile') {
    return NextResponse.json(
      { success: false, error: 'A runtime choice must continue to the personal profile.' },
      { status: 409 },
    );
  }

  if (updates.runtime === 'completed') {
    if (!updates.workspaceId || !updates.agentId) {
      return NextResponse.json(
        { success: false, error: 'A saved workspace and agent runtime preference is required.' },
        { status: 400 },
      );
    }
    try {
      const workspace = await resolveAgentSessionWorkspaceForUser({
        userId: session.user.id,
        workspaceId: updates.workspaceId,
        permissions: ['canRead', 'canRunAgent'],
      });
      if (!workspace.organizationId) throw new Error('Organization setup required.');
      const agentId = normalizeManagedAgentId(updates.agentId);
      const resolution = await resolveEffectiveAgentRuntime({
        organizationId: workspace.organizationId,
        userId: session.user.id,
        workspaceId: workspace.workspaceId,
        workspaceType: workspace.workspaceType,
        agentId,
        sessionId: null,
        requestedSelection: null,
      });
      if (!resolution.valid || !resolution.preference) {
        return NextResponse.json(
          { success: false, error: 'Save a valid personal runtime preference before continuing.' },
          { status: 409 },
        );
      }
    } catch {
      return NextResponse.json(
        { success: false, error: 'The selected runtime context is invalid or inaccessible.' },
        { status: 409 },
      );
    }
  }

  if (
    current.profile === 'pending' &&
    (updates.step === 'tour' || updates.step === 'complete' || tour !== undefined)
  ) {
    return NextResponse.json(
      { success: false, error: 'Complete or skip the personal profile before starting the tour.' },
      { status: 409 },
    );
  }

  if (current.profile === 'pending' && updates.step === 'profile' && current.step !== 'workspace' && current.step !== 'profile') {
    return NextResponse.json(
      { success: false, error: 'Confirm the personal workspace before starting the profile.' },
      { status: 409 },
    );
  }

  // Profile completion is intentionally server-owned. A client may guide or
  // finish a tour, but cannot claim that the agent profile was written.
  const onboarding = await updateUserOnboardingState(session.user.id, {
    ...(updates.step ? { step: updates.step } : {}),
    ...(updates.runtime ? { runtime: updates.runtime } : {}),
    ...(tour ? { tour } : {}),
  });
  return NextResponse.json({ success: true, data: onboarding });
}
