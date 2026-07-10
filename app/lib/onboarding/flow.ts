import 'server-only';

import type { UserOnboardingState } from '@/app/lib/user-preferences';

export type OnboardingPhase = 'instance' | 'waiting' | 'user' | 'complete';

/**
 * Pure routing policy for the two onboarding scopes. Authorization is checked
 * before this function is called; this only decides which persisted progress
 * belongs to the current screen.
 */
export function resolveOnboardingPhase(input: {
  instanceComplete: boolean;
  isInstanceAdmin: boolean;
  userOnboarding: UserOnboardingState;
}): OnboardingPhase {
  if (!input.instanceComplete) {
    return input.isInstanceAdmin ? 'instance' : 'waiting';
  }
  return input.userOnboarding.step === 'complete' ? 'complete' : 'user';
}
