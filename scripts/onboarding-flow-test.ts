import assert from 'node:assert/strict';
import Module from 'node:module';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => request === 'server-only' ? {} : originalLoad(request, parent, isMain);

async function main() {
  const { createCompletedUserOnboardingState, createDefaultUserOnboardingState } = await import('../app/lib/user-preferences');
  const {
    isOnboardingLicenseRecoveryRequest,
    resolveOnboardingPhase,
  } = await import('../app/lib/onboarding/flow');
  const pending = createDefaultUserOnboardingState();
  const complete = createCompletedUserOnboardingState();

  assert.equal(pending.runtime, 'skipped');
  assert.equal(complete.runtime, 'skipped');

  assert.equal(resolveOnboardingPhase({ instanceComplete: false, isInstanceAdmin: true, userOnboarding: pending }), 'instance');
  assert.equal(resolveOnboardingPhase({ instanceComplete: false, isInstanceAdmin: false, userOnboarding: pending }), 'waiting');
  assert.equal(resolveOnboardingPhase({ instanceComplete: true, isInstanceAdmin: true, userOnboarding: pending }), 'user');
  assert.equal(resolveOnboardingPhase({ instanceComplete: true, isInstanceAdmin: false, userOnboarding: complete }), 'complete');

  assert.equal(isOnboardingLicenseRecoveryRequest({ tab: 'license' }), true);
  assert.equal(isOnboardingLicenseRecoveryRequest({ tab: ['LICENSE', 'general'] }), true);
  assert.equal(isOnboardingLicenseRecoveryRequest({ tab: 'general' }), false);
  assert.equal(isOnboardingLicenseRecoveryRequest({}), false);

  console.log('onboarding-flow-test: ok');
}

main().finally(() => {
  moduleInternals._load = originalLoad;
});
