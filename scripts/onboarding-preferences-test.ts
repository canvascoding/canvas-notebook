import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => request === 'server-only' ? {} : originalLoad(request, parent, isMain);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-onboarding-preferences-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataDir;

  try {
    const {
      getUserOnboardingState,
      getUserPreferences,
      initializeUserOnboarding,
      setUserPreferredLocale,
      updateUserOnboardingState,
    } = await import('../app/lib/user-preferences');
    const {
      getInstanceOnboardingStep,
      getServerSettings,
      getServerPreferredTimeZone,
      markInstanceProviderVerified,
      setInstanceOnboardingStep,
      setServerPreferredTimeZone,
    } = await import('../app/lib/server-settings');

    const initial = await getUserOnboardingState('user-a');
    assert.equal(initial.step, 'complete');
    assert.equal(initial.runtime, 'skipped');
    assert.equal(initial.profile, 'skipped');
    assert.equal(initial.tour, 'completed');

    const initialized = await initializeUserOnboarding('user-a');
    assert.equal(initialized.step, 'language');
    assert.equal(initialized.runtime, 'skipped');
    assert.equal(initialized.profile, 'pending');
    assert.equal(initialized.tour, 'pending');

    const [, afterLanguage] = await Promise.all([
      setUserPreferredLocale('user-a', 'en'),
      updateUserOnboardingState('user-a', { step: 'workspace' }),
    ]);
    assert.equal(afterLanguage.step, 'workspace');
    assert.equal(afterLanguage.profile, 'pending');
    assert.equal((await getUserPreferences('user-a')).locale, 'en');

    const afterWorkspace = await updateUserOnboardingState('user-a', { step: 'profile' });
    assert.equal(afterWorkspace.step, 'profile');
    assert.equal(afterWorkspace.runtime, 'skipped');

    const afterProfile = await updateUserOnboardingState('user-a', { profile: 'completed', step: 'tour' });
    assert.equal(afterProfile.profile, 'completed');
    assert.equal(afterProfile.step, 'tour');
    assert.equal((await getUserOnboardingState('user-b')).step, 'complete');

    const parallelUserIds = Array.from({ length: 25 }, (_, index) => `parallel-user-${index}`);
    await Promise.all(parallelUserIds.map((userId) => initializeUserOnboarding(userId)));
    const parallelStates = await Promise.all(
      parallelUserIds.map((userId) => getUserOnboardingState(userId)),
    );
    assert.ok(parallelStates.every((state) => state.step === 'language'));

    assert.equal(await getInstanceOnboardingStep(), 'server');
    await setInstanceOnboardingStep('owner-a', 'provider');
    assert.equal(await getInstanceOnboardingStep(), 'provider');
    await markInstanceProviderVerified('owner-a', {
      catalogRevision: 4,
      providerInstallationId: 'aip_0123456789abcdef01234567',
    });
    assert.equal((await getServerSettings()).providerVerifiedBy, 'owner-a');
    assert.equal((await getServerSettings()).providerVerifiedCatalogRevision, 4);
    assert.equal((await getServerSettings()).providerVerifiedInstallationId, 'aip_0123456789abcdef01234567');
    await setServerPreferredTimeZone('owner-a', 'UTC');
    assert.equal(await getServerPreferredTimeZone(), 'UTC');

    const settingsDir = path.join(dataDir, 'settings');
    await mkdir(settingsDir, { recursive: true });
    await writeFile(path.join(settingsDir, 'user-preferences.json'), JSON.stringify({
      version: 1,
      users: {
        'legacy-profile': {
          onboarding: {
            version: 2,
            step: 'profile',
            profile: 'pending',
            tour: 'pending',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        'legacy-complete': {
          onboarding: {
            version: 2,
            step: 'complete',
            profile: 'skipped',
            tour: 'completed',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        'legacy-runtime': {
          onboarding: {
            version: 3,
            step: 'runtime',
            runtime: 'pending',
            profile: 'pending',
            tour: 'pending',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    }), 'utf8');
    const migratedProfile = await getUserOnboardingState('legacy-profile');
    assert.equal(migratedProfile.version, 4);
    assert.equal(migratedProfile.step, 'profile');
    assert.equal(migratedProfile.runtime, 'skipped');
    const migratedComplete = await getUserOnboardingState('legacy-complete');
    assert.equal(migratedComplete.step, 'complete');
    assert.equal(migratedComplete.runtime, 'skipped');
    const migratedRuntime = await getUserOnboardingState('legacy-runtime');
    assert.equal(migratedRuntime.version, 4);
    assert.equal(migratedRuntime.step, 'profile');
    assert.equal(migratedRuntime.runtime, 'skipped');

    console.log('onboarding-preferences-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
