import { loadAppEnv } from '../server/load-app-env';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { db } from '../app/lib/db';
import { account, user } from '../app/lib/db/schema';
import { BOOTSTRAP_SIGNUP_ENV, getBootstrapAdminConfig } from '../app/lib/bootstrap-admin';

loadAppEnv(process.cwd());

const bootstrapAdmin = getBootstrapAdminConfig();

function isUserExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const maybeError = error as { body?: { code?: string }; message?: string };
  const code = maybeError.body?.code;
  const message = maybeError.message || '';

  return code === 'USER_ALREADY_EXISTS' || /already exists/i.test(message);
}

async function syncCredentialPassword(userId: string, password: string) {
  const now = new Date();
  const passwordHash = await hashPassword(password);
  const existingAccount = await db
    .select()
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    .limit(1);

  if (existingAccount[0]) {
    await db
      .update(account)
      .set({
        accountId: userId,
        password: passwordHash,
        updatedAt: now,
      })
      .where(eq(account.id, existingAccount[0].id));
    return;
  }

  await db.insert(account).values({
    id: randomUUID(),
    accountId: userId,
    providerId: 'credential',
    userId,
    password: passwordHash,
    createdAt: now,
    updatedAt: now,
  });
}

async function ensureBootstrapAdmin(userId: string, name: string, password: string) {
  await db
    .update(user)
    .set({ name, role: 'admin', updatedAt: new Date() })
    .where(eq(user.id, userId));

  await syncCredentialPassword(userId, password);
}

async function findUserByEmail(email: string) {
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1);
  return rows[0] ?? null;
}

async function main() {
  if (!bootstrapAdmin) {
    console.log('[bootstrap-admin] Skipped (BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD not set).');
    return;
  }

  const { email, password, name } = bootstrapAdmin;
  const existingUser = await findUserByEmail(email);

  if (existingUser) {
    await ensureBootstrapAdmin(existingUser.id, name, password);
    console.log(`[bootstrap-admin] Synced bootstrap admin user: ${email}`);
    return;
  }

  try {
    process.env[BOOTSTRAP_SIGNUP_ENV] = 'true';
    const { auth } = await import('../app/lib/auth');
    const res = await auth.api.signUpEmail({
      body: {
        email,
        password,
        name,
      },
    });

    await ensureBootstrapAdmin(res.user.id, name, password);
    console.log(`[bootstrap-admin] Created admin user: ${res.user.email}`);
  } catch (error) {
    if (isUserExistsError(error)) {
      const currentUser = await findUserByEmail(email);
      if (currentUser) {
        await ensureBootstrapAdmin(currentUser.id, name, password);
      }
      console.log(`[bootstrap-admin] User already exists, synced bootstrap admin: ${email}`);
      return;
    }

    console.error('[bootstrap-admin] Failed:', error);
    throw error;
  } finally {
    delete process.env[BOOTSTRAP_SIGNUP_ENV];
  }
}

main().catch(() => process.exit(1));
