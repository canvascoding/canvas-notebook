import { eq } from 'drizzle-orm';
import { auth } from '../app/lib/auth';
import { db } from '../app/lib/db';
import { user } from '../app/lib/db/schema';

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

  try {
    const res = await auth.api.signUpEmail({
      body: {
        email,
        password,
        name,
      },
    });

    await ensureAdminRole(email);
    console.log(`[bootstrap-admin] Created admin user: ${res.user.email}`);
  } catch (error) {
    if (isUserExistsError(error)) {
      await ensureAdminRole(email);
      console.log(`[bootstrap-admin] User already exists, ensured admin role: ${email}`);
      return;
    }

    console.error('[bootstrap-admin] Failed:', error);
    throw error;
  }
}

main().catch(() => process.exit(1));
