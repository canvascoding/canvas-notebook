import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { verifyPassword } from 'better-auth/crypto';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-auth-setup-'));
process.env.DATA = dataDir;

async function main() {
  const {
    createInitialOwner,
    hasAnyAuthUser,
    InitialOwnerSetupError,
  } = await import('../app/lib/auth-setup');

  assert.equal(hasAnyAuthUser(), false);

  const owner = await createInitialOwner({
    name: ' Setup Admin ',
    email: 'SETUP@example.test ',
    password: 'SetupPassword123!',
  });

  assert.equal(owner.name, 'Setup Admin');
  assert.equal(owner.email, 'setup@example.test');
  assert.equal(hasAnyAuthUser(), true);

  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  const users = sqlite.prepare('SELECT id, name, email, role, email_verified AS emailVerified FROM user').all() as Array<{
    id: string;
    name: string;
    email: string;
    role: string | null;
    emailVerified: number;
  }>;
  assert.equal(users.length, 1);
  assert.equal(users[0].id, owner.id);
  assert.equal(users[0].name, 'Setup Admin');
  assert.equal(users[0].email, 'setup@example.test');
  assert.equal(users[0].role, 'admin');
  assert.equal(users[0].emailVerified, 1);

  const accounts = sqlite.prepare(`
    SELECT account_id AS accountId, provider_id AS providerId, user_id AS userId, password
    FROM account
  `).all() as Array<{
    accountId: string;
    providerId: string;
    userId: string;
    password: string | null;
  }>;
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountId, owner.id);
  assert.equal(accounts[0].providerId, 'credential');
  assert.equal(accounts[0].userId, owner.id);
  assert.ok(accounts[0].password);
  assert.equal(await verifyPassword({ hash: accounts[0].password!, password: 'SetupPassword123!' }), true);
  sqlite.close();

  await assert.rejects(
    () => createInitialOwner({
      name: 'Second Admin',
      email: 'second@example.test',
      password: 'SecondPassword123!',
    }),
    (error) => error instanceof InitialOwnerSetupError && error.code === 'ALREADY_CONFIGURED',
  );

  execFileSync('node', ['scripts/bootstrap-admin.js'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: {
      ...process.env,
      DATA: dataDir,
      BOOTSTRAP_ADMIN_EMAIL: 'override@example.test',
      BOOTSTRAP_ADMIN_PASSWORD: 'OverridePassword123!',
      BOOTSTRAP_ADMIN_NAME: 'Override Admin',
    },
  });

  const migrated = new Database(path.join(dataDir, 'sqlite.db'));
  const migratedUsers = migrated.prepare('SELECT id, name, email, role FROM user').all() as Array<{
    id: string;
    name: string;
    email: string;
    role: string | null;
  }>;
  assert.equal(migratedUsers.length, 1);
  assert.equal(migratedUsers[0].id, owner.id);
  assert.equal(migratedUsers[0].name, 'Override Admin');
  assert.equal(migratedUsers[0].email, 'override@example.test');
  assert.equal(migratedUsers[0].role, 'admin');

  const migratedAccount = migrated.prepare(`
    SELECT account_id AS accountId, user_id AS userId, password
    FROM account
    WHERE provider_id = 'credential'
  `).get() as { accountId: string; userId: string; password: string | null };
  assert.equal(migratedAccount.accountId, owner.id);
  assert.equal(migratedAccount.userId, owner.id);
  assert.ok(migratedAccount.password);
  assert.equal(await verifyPassword({ hash: migratedAccount.password!, password: 'OverridePassword123!' }), true);
  migrated.close();

  execFileSync('node', ['scripts/bootstrap-admin.js', '--email', 'cli-reset@example.test', '--name', 'CLI Reset Admin', '--password-stdin'], {
    cwd: process.cwd(),
    input: 'CliResetPassword123!\n',
    stdio: 'pipe',
    env: {
      ...process.env,
      DATA: dataDir,
      BOOTSTRAP_ADMIN_EMAIL: '',
      BOOTSTRAP_ADMIN_PASSWORD: '',
      BOOTSTRAP_ADMIN_NAME: '',
    },
  });

  const cliReset = new Database(path.join(dataDir, 'sqlite.db'));
  const cliResetUsers = cliReset.prepare('SELECT id, name, email, role FROM user').all() as Array<{
    id: string;
    name: string;
    email: string;
    role: string | null;
  }>;
  assert.equal(cliResetUsers.length, 1);
  assert.equal(cliResetUsers[0].id, owner.id);
  assert.equal(cliResetUsers[0].name, 'CLI Reset Admin');
  assert.equal(cliResetUsers[0].email, 'cli-reset@example.test');
  assert.equal(cliResetUsers[0].role, 'admin');

  const cliResetAccount = cliReset.prepare(`
    SELECT account_id AS accountId, user_id AS userId, password
    FROM account
    WHERE provider_id = 'credential'
  `).get() as { accountId: string; userId: string; password: string | null };
  assert.equal(cliResetAccount.accountId, owner.id);
  assert.equal(cliResetAccount.userId, owner.id);
  assert.ok(cliResetAccount.password);
  assert.equal(await verifyPassword({ hash: cliResetAccount.password!, password: 'CliResetPassword123!' }), true);
  cliReset.close();

  console.log('auth setup tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
