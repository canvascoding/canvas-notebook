import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';

/** Exercise the actual bootstrap CLI, transaction and membership service. */
async function main(): Promise<void> {
  assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1');
  assert.equal(process.env.NODE_ENV, 'test');
  const fixture = await createSharedConnectionTestDatabase();
  assert.equal(fixture.native, true);
  const database = await fixture.openDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-bootstrap-owner-'));
  const envFile = path.join(root, 'empty.env');
  await fs.writeFile(envFile, '', { mode: 0o600 });
  try {
    const selected = await database.get('SELECT current_database() AS name') as { name: string };
    assert.match(selected.name, /^canvas_connection_test_[a-f0-9]{32}$/u);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = '/' + selected.name;
    const require = createRequire(import.meta.url);
    const email = `bootstrap-${randomBytes(8).toString('hex')}@example.test`;
    const env = { ...process.env, CANVAS_ENV_FILE: envFile, DATABASE_URL: url.toString(),
      DATA: root, CANVAS_DATA_ROOT: root, CANVAS_DATABASE_PROVIDER: 'postgres',
      CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'true', CANVAS_DEPLOYMENT_MODE: 'team',
      CANVAS_TEAM_FEATURES_ENABLED: 'true', BOOTSTRAP_ADMIN_EMAIL: email,
      BOOTSTRAP_ADMIN_PASSWORD: randomBytes(32).toString('base64url'), BOOTSTRAP_ADMIN_NAME: 'Initial CLI owner',
      BOOTSTRAP_ADMIN_ENSURE_ONLY: 'false' };
    const bootstrap = (ensure = false) => spawnSync(process.execPath,
      [require.resolve('tsx/cli'), '--conditions', 'react-server', 'scripts/bootstrap-admin-postgres.ts'],
      { cwd: process.cwd(), env: { ...env, BOOTSTRAP_ADMIN_ENSURE_ONLY: String(ensure) },
        encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const stamps = () => database.all('SELECT *,xmin::text AS row_version FROM team_memberships ORDER BY id');

    // A real failure in the new membership step must roll back the entire owner.
    await database.run(`CREATE FUNCTION fail_bootstrap_owner() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'owned first-owner fault'; END $$`);
    await database.run(`CREATE TRIGGER fail_bootstrap_owner BEFORE INSERT ON team_memberships
      FOR EACH ROW EXECUTE FUNCTION fail_bootstrap_owner()`);
    const failed = bootstrap();
    assert.notEqual(failed.status, 0, 'The actual first-owner membership insertion must execute.');
    assert.match(failed.stderr, /owned first-owner fault/u);
    for (const table of ['user', 'account', 'canvas_organization_settings', 'organization_user_permissions', 'canvas_workspaces', 'team_memberships']) {
      const count = await database.get(`SELECT count(*)::integer AS n FROM "${table}"`) as { n: number };
      assert.equal(count.n, 0, `Failed first-owner initialization must roll back ${table}.`);
    }
    await database.run('DROP TRIGGER fail_bootstrap_owner ON team_memberships');
    await database.run('DROP FUNCTION fail_bootstrap_owner()');

    const created = bootstrap(); assert.equal(created.status, 0, created.stderr);
    const memberships = await stamps(); assert.equal(memberships.length, 1);
    const membership = memberships[0] as Record<string, unknown>;
    assert.equal(membership.role, 'owner'); assert.equal(membership.status, 'active');
    assert(membership.accepted_at && membership.activated_at);
    const owner = await database.get('SELECT id,email,role FROM "user"') as { id: string; email: string; role: string };
    assert.equal(owner.email, email); assert.equal(owner.role, 'admin'); assert.equal(membership.user_id, owner.id);
    const transitions = await database.all('SELECT * FROM team_membership_transitions');
    assert.equal(transitions.length, 1); assert.equal(Reflect.get(transitions[0]!, 'source'), 'first_owner');

    const repeat = bootstrap(); assert.equal(repeat.status, 0, repeat.stderr);
    assert.deepEqual(await stamps(), memberships, 'Credential synchronization must preserve membership identity and xmin.');
    assert.deepEqual(await database.all('SELECT * FROM team_membership_transitions'), transitions);
    const ensure = bootstrap(true); assert.equal(ensure.status, 0, ensure.stderr);
    assert.deepEqual(await stamps(), memberships, '--ensure must not create another owner membership.');

    // Existing accounts are never reactivated through deployment bootstrap.
    await database.run("UPDATE team_memberships SET status='suspended' WHERE id=$1", [membership.id]);
    await database.run('UPDATE "user" SET banned=1 WHERE id=$1', [owner.id]);
    const suspended = await stamps();
    for (const ensureOnly of [false, true]) {
      const result = bootstrap(ensureOnly); assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await stamps(), suspended);
      const user = await database.get('SELECT banned FROM "user" WHERE id=$1', [owner.id]) as { banned: number };
      assert.equal(user.banned, 1);
      assert.deepEqual(await database.all('SELECT * FROM team_membership_transitions'), transitions);
    }
    console.log('PASS actual PostgreSQL bootstrap: atomic first owner, active membership, repeat/ensure idempotence and suspended-account preservation.');
  } finally {
    await database.close(); await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
