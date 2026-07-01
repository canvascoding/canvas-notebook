import assert from 'node:assert/strict';

const previousBootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
const previousBetterAuthBaseUrl = process.env.BETTER_AUTH_BASE_URL;
process.env.BOOTSTRAP_ADMIN_EMAIL = 'bootstrap@example.test';
process.env.BETTER_AUTH_BASE_URL = previousBetterAuthBaseUrl || 'http://localhost:3000';

async function main() {
  const { resolveServerSettingsUpdatePermission } = await import('../app/lib/server-settings-policy');

  assert.deepEqual(
    resolveServerSettingsUpdatePermission(
      { email: 'user@example.test', role: 'admin' },
      { onboardingEnabled: false, onboardingComplete: true },
    ),
    { ok: true, reason: 'admin' },
  );

  assert.deepEqual(
    resolveServerSettingsUpdatePermission(
      { email: 'BOOTSTRAP@example.test', role: 'user' },
      { onboardingEnabled: false, onboardingComplete: true },
    ),
    { ok: true, reason: 'admin' },
  );

  assert.deepEqual(
    resolveServerSettingsUpdatePermission(
      { email: 'user@example.test', role: 'user' },
      { onboardingEnabled: true, onboardingComplete: false },
    ),
    { ok: true, reason: 'onboarding' },
  );

  assert.deepEqual(
    resolveServerSettingsUpdatePermission(
      { email: 'user@example.test', role: 'user' },
      { onboardingEnabled: true, onboardingComplete: true },
    ),
    { ok: false, reason: 'admin_required' },
  );

  assert.deepEqual(
    resolveServerSettingsUpdatePermission(
      { email: 'user@example.test', role: 'user' },
      { onboardingEnabled: false, onboardingComplete: false },
    ),
    { ok: false, reason: 'admin_required' },
  );

  console.log('server-settings-policy-test: ok');
}

main().finally(() => {
  if (previousBootstrapAdminEmail === undefined) {
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
  } else {
    process.env.BOOTSTRAP_ADMIN_EMAIL = previousBootstrapAdminEmail;
  }
  if (previousBetterAuthBaseUrl === undefined) {
    delete process.env.BETTER_AUTH_BASE_URL;
  } else {
    process.env.BETTER_AUTH_BASE_URL = previousBetterAuthBaseUrl;
  }
});
