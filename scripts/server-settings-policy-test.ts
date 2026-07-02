import assert from 'node:assert/strict';
import Module from 'node:module';

const previousBootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
const previousBetterAuthBaseUrl = process.env.BETTER_AUTH_BASE_URL;
process.env.BOOTSTRAP_ADMIN_EMAIL = 'bootstrap@example.test';
process.env.BETTER_AUTH_BASE_URL = previousBetterAuthBaseUrl || 'http://localhost:3000';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalModuleLoad = moduleInternals._load;

async function assertOnboardingStatusFallbackKeepsOnboardingOpen() {
  const originalLoad = moduleInternals._load;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];

  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'drizzle-orm') {
      return {
        eq: () => ({}),
      };
    }
    if (request === '@/app/lib/db') {
      return {
        db: {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => {
                  throw new Error('database unavailable');
                },
              }),
            }),
          }),
        },
      };
    }
    if (request === '@/app/lib/db/schema') {
      return {
        onboardingLog: {
          method: 'method',
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const { getOnboardingCompletionStatus, isOnboardingComplete } = await import('../app/lib/onboarding/status');
    const status = await getOnboardingCompletionStatus('[server-settings-policy-test]');
    assert.equal(status.complete, false);
    assert.equal(status.source, 'fallback');
    assert.equal(await isOnboardingComplete(), false);
    assert.match(String(warnings[0]?.[0] ?? ''), /Failed to read onboarding completion status/);
  } finally {
    console.warn = originalWarn;
    moduleInternals._load = originalLoad;
  }
}

async function main() {
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalModuleLoad(request, parent, isMain);
  };

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

  await assertOnboardingStatusFallbackKeepsOnboardingOpen();

  assert.deepEqual(
    resolveServerSettingsUpdatePermission(
      { email: 'user@example.test', role: 'user' },
      { onboardingEnabled: true, onboardingComplete: false },
    ),
    { ok: true, reason: 'onboarding' },
  );

  console.log('server-settings-policy-test: ok');
}

main().finally(() => {
  moduleInternals._load = originalModuleLoad;
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
