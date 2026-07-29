import assert from 'node:assert/strict';

import {
  MobileOnboardingTransitionError,
  parseMobileOnboardingAction,
  resolveMobileOnboardingUpdate,
} from '../app/lib/mobile/onboarding-contract';
import type { UserOnboardingState } from '../app/lib/user-preferences';

function state(
  updates: Partial<UserOnboardingState> = {},
): UserOnboardingState {
  return {
    version: 4,
    step: 'language',
    runtime: 'skipped',
    profile: 'pending',
    tour: 'pending',
    updatedAt: '2026-07-29T12:00:00.000Z',
    ...updates,
  };
}

assert.deepEqual(
  parseMobileOnboardingAction({ action: 'confirm-language' }),
  { action: 'confirm-language' },
);
assert.deepEqual(
  parseMobileOnboardingAction({ action: 'finish-tour', tour: 'skipped' }),
  { action: 'finish-tour', tour: 'skipped' },
);
assert.equal(
  parseMobileOnboardingAction({ action: 'finish-tour', tour: 'pending' }),
  null,
);
assert.equal(parseMobileOnboardingAction({ action: 'unknown' }), null);

assert.deepEqual(
  resolveMobileOnboardingUpdate(
    state(),
    { action: 'confirm-language' },
  ),
  { step: 'workspace' },
);
assert.deepEqual(
  resolveMobileOnboardingUpdate(
    state({ step: 'workspace' }),
    { action: 'confirm-workspace' },
  ),
  { step: 'profile' },
);
assert.equal(
  resolveMobileOnboardingUpdate(
    state({ step: 'profile' }),
    { action: 'confirm-language' },
  ),
  null,
);
assert.deepEqual(
  resolveMobileOnboardingUpdate(
    state({ step: 'tour', profile: 'completed' }),
    { action: 'finish-tour', tour: 'completed' },
  ),
  { step: 'complete', tour: 'completed' },
);
assert.equal(
  resolveMobileOnboardingUpdate(
    state({
      step: 'complete',
      profile: 'skipped',
      tour: 'skipped',
    }),
    { action: 'finish-tour', tour: 'completed' },
  ),
  null,
);

assert.throws(
  () => resolveMobileOnboardingUpdate(
    state(),
    { action: 'confirm-workspace' },
  ),
  (error: unknown) => (
    error instanceof MobileOnboardingTransitionError
    && error.code === 'WORKSPACE_STEP_NOT_READY'
  ),
);
assert.throws(
  () => resolveMobileOnboardingUpdate(
    state({ step: 'tour', profile: 'pending' }),
    { action: 'finish-tour', tour: 'completed' },
  ),
  (error: unknown) => (
    error instanceof MobileOnboardingTransitionError
    && error.code === 'TOUR_STEP_NOT_READY'
  ),
);

console.log('Mobile onboarding contract tests passed');
