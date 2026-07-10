import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-onboarding-preferences-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataDir;

  try {
    const {
      getUserOnboardingState,
      getUserPreferences,
      setUserPreferredLocale,
      updateUserOnboardingState,
    } = await import('../app/lib/user-preferences');
    const {
      getInstanceOnboardingStep,
      getServerPreferredTimeZone,
      setInstanceOnboardingStep,
      setServerPreferredTimeZone,
    } = await import('../app/lib/server-settings');

    const initial = await getUserOnboardingState('user-a');
    assert.equal(initial.step, 'language');
    assert.equal(initial.profile, 'pending');
    assert.equal(initial.tour, 'pending');

    await setUserPreferredLocale('user-a', 'en');
    const afterLanguage = await updateUserOnboardingState('user-a', { step: 'profile' });
    assert.equal(afterLanguage.step, 'profile');
    assert.equal(afterLanguage.profile, 'pending');
    assert.equal((await getUserPreferences('user-a')).locale, 'en');

    const afterProfile = await updateUserOnboardingState('user-a', { profile: 'completed', step: 'tour' });
    assert.equal(afterProfile.profile, 'completed');
    assert.equal(afterProfile.step, 'tour');
    assert.equal((await getUserOnboardingState('user-b')).step, 'language');

    assert.equal(await getInstanceOnboardingStep(), 'language');
    await setInstanceOnboardingStep('owner-a', 'provider');
    assert.equal(await getInstanceOnboardingStep(), 'provider');
    await setServerPreferredTimeZone('owner-a', 'UTC');
    assert.equal(await getServerPreferredTimeZone(), 'UTC');

    console.log('onboarding-preferences-test: ok');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
