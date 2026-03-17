import { loadAppEnv } from '../server/load-app-env';
import { eq } from 'drizzle-orm';
import { db } from '../app/lib/db';
import { user } from '../app/lib/db/schema';
import { markOnboardingComplete } from '../app/lib/onboarding/status';

loadAppEnv(process.cwd());

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Administrator';

function isUserExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const maybeError = error as { body?: { code?: string }; message?: string };
  const code = maybeError.body?.code;
  const message = maybeError.message || '';

  return code === 'USER_ALREADY_EXISTS' || /already exists/i.test(message);
}

async function ensureAdminRole(adminEmail: string) {
  await db
    .update(user)
    .set({ role: 'admin', updatedAt: new Date() })
    .where(eq(user.email, adminEmail));
}

async function main() {
  if (!email || !password) {
    console.log('[bootstrap-admin] Skipped (BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD not set).');
    return;
  }

  // Bootstrap should work even when public sign-up is disabled.
  process.env.ONBOARDING = 'true';
  const { auth } = await import('../app/lib/auth');

  try {
    const res = await auth.api.signUpEmail({
      body: {
        email,
        password,
        name,
      },
    });

    await ensureAdminRole(email);
    await markOnboardingComplete({ method: 'bootstrap', notes: email }).catch(() => {});
    console.log(`[bootstrap-admin] Created admin user: ${res.user.email}`);
  } catch (error) {
    if (isUserExistsError(error)) {
      await ensureAdminRole(email);
      await markOnboardingComplete({ method: 'bootstrap', notes: email }).catch(() => {});
      console.log(`[bootstrap-admin] User already exists, ensured admin role: ${email}`);
      return;
    }

    console.error('[bootstrap-admin] Failed:', error);
    throw error;
  }
}

main().catch(() => process.exit(1));
