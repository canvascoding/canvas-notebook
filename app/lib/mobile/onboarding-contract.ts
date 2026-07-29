import type {
  UserOnboardingState,
  UserOnboardingTourStatus,
} from '@/app/lib/user-preferences';

export const MOBILE_ONBOARDING_ACTIONS = [
  'confirm-language',
  'confirm-workspace',
  'finish-tour',
] as const;

export type MobileOnboardingAction = typeof MOBILE_ONBOARDING_ACTIONS[number];

export type MobileOnboardingActionPayload =
  | { action: 'confirm-language' }
  | { action: 'confirm-workspace' }
  | { action: 'finish-tour'; tour: Extract<UserOnboardingTourStatus, 'completed' | 'skipped'> };

export type MobileOnboardingUpdate = Partial<
  Pick<UserOnboardingState, 'step' | 'tour'>
>;

const STEP_ORDER: Record<UserOnboardingState['step'], number> = {
  language: 0,
  workspace: 1,
  profile: 2,
  tour: 3,
  complete: 4,
};

export class MobileOnboardingTransitionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'MobileOnboardingTransitionError';
  }
}

export function parseMobileOnboardingAction(
  value: unknown,
): MobileOnboardingActionPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as { action?: unknown; tour?: unknown };

  if (payload.action === 'confirm-language') {
    return { action: payload.action };
  }
  if (payload.action === 'confirm-workspace') {
    return { action: payload.action };
  }
  if (
    payload.action === 'finish-tour'
    && (payload.tour === 'completed' || payload.tour === 'skipped')
  ) {
    return { action: payload.action, tour: payload.tour };
  }
  return null;
}

function idempotentAfter(
  current: UserOnboardingState,
  completedStep: UserOnboardingState['step'],
): boolean {
  return STEP_ORDER[current.step] > STEP_ORDER[completedStep];
}

export function resolveMobileOnboardingUpdate(
  current: UserOnboardingState,
  payload: MobileOnboardingActionPayload,
): MobileOnboardingUpdate | null {
  if (payload.action === 'confirm-language') {
    if (current.step === 'language') return { step: 'workspace' };
    if (idempotentAfter(current, 'language')) return null;
    throw new MobileOnboardingTransitionError(
      'Language setup is not available yet.',
      'LANGUAGE_STEP_NOT_READY',
    );
  }

  if (payload.action === 'confirm-workspace') {
    if (current.step === 'workspace') return { step: 'profile' };
    if (idempotentAfter(current, 'workspace')) return null;
    throw new MobileOnboardingTransitionError(
      'Confirm the account language before the personal workspace.',
      'WORKSPACE_STEP_NOT_READY',
    );
  }

  if (current.step === 'complete') return null;
  if (current.step !== 'tour' || current.profile === 'pending') {
    throw new MobileOnboardingTransitionError(
      'Complete or skip the personal profile before finishing the tour.',
      'TOUR_STEP_NOT_READY',
    );
  }
  return {
    step: 'complete',
    tour: payload.tour,
  };
}
