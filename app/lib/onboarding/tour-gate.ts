import 'server-only';

import type { UserOnboardingTourStatus } from '@/app/lib/user-preferences';
import { isOnboardingHintsEnabled } from '@/app/lib/onboarding/status';

/**
 * Keeps the persisted tour state aligned with the instance-wide opt-in. This
 * also protects deployments from clients that were loaded before a config
 * change and still try to start the guided tour.
 */
export function resolveGuidedTourStatus(
  requestedStatus: UserOnboardingTourStatus | undefined,
): UserOnboardingTourStatus | undefined {
  if (requestedStatus === 'started' && !isOnboardingHintsEnabled()) {
    return 'skipped';
  }
  return requestedStatus;
}
