import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Pool, types } from 'pg';
import ts from 'typescript';
import type { SqlConnection } from '../app/lib/db';
import type * as Permissions from '../app/lib/organization/permissions';

const PREFIX = 'canvas_permission_mutation_test_';
const SCHEMA = new RegExp(`^${PREFIX}[0-9a-f]{32}$`, 'u');
const TABLES = ['user', 'canvas_organization_settings', 'organization_user_permissions'] as const;

function managedDatabase(): URL {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) {
    throw new Error('This regression requires the managed PostgreSQL connection; it never passes by skipping.');
  }
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '55433' || decodeURIComponent(url.pathname) !== '/canvas_notebook') {
    throw new Error('Permission mutation fixtures accept only managed loopback PG18 at 55433/canvas_notebook.');
  }
  return url;
}

/** Only the connection and unused HTTP/session boundaries are substituted; mutation/guards/provisioning are production code. */
async function productionPermissions(pool: Pool): Promise<typeof Permissions> {
  const filename = path.resolve('app/lib/organization/permissions.ts');
  const require = createRequire(filename);
  const openConnection = async (): Promise<SqlConnection> => {
    const client = await pool.connect();
    return {
      get: async (sql, params) => (await client.query(sql, params)).rows[0],
      all: async (sql, params) => (await client.query(sql, params)).rows,
      run: async (sql, params) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
      close: async error => { client.release(error); },
    };
  };
  const resolve = (name: string) => {
    if (name === '@/app/lib/db') return { openDb: openConnection };
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async () => { throw new Error('No HTTP/session fixture.'); } } } };
    if (name === '@/app/lib/admin-auth') return admin;
    if (name === '@/app/lib/organization/team-membership' || name === '@/app/lib/workspaces/postgres-runtime') {
      return new Proxy({}, { get() { throw new Error('Unexpected unrelated membership/runtime operation.'); } });
    }
    return require(name);
  };
  const compile = async (file: string) => {
    const javascript = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const exports: Record<string, unknown> = {};
    new Function('require', 'exports', javascript)(resolve, exports);
    return exports;
  };
  const admin = await compile(path.resolve('app/lib/admin-auth.ts'));
  return await compile(filename) as typeof Permissions;
}

async function main(): Promise<void> {
  const schema = `${PREFIX}${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, SCHEMA);
  const admin = new Pool({ connectionString: managedDatabase().toString(), max: 1, connectionTimeoutMillis: 3000, allowExitOnIdle: true });
  let fixture: Pool | undefined;
  let created = false;
  try {
    const version = await admin.query("SELECT current_setting('server_version_num')::int AS version,current_database() AS database");
    assert.equal(Math.floor(version.rows[0].version / 10000), 18);
    assert.equal(version.rows[0].database, 'canvas_notebook');
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    fixture = new Pool({ connectionString: managedDatabase().toString(), max: 2, allowExitOnIdle: true,
      connectionTimeoutMillis: 3000, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=3000`,
      types: { getTypeParser: (oid, format) => oid === types.builtins.INT8 ? (value: string) => Number.parseInt(value, 10) : types.getTypeParser(oid, format) },
      application_name: 'permission-mutation-isolated-fixture' });
    for (const table of TABLES) await fixture.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`);
    for (const user of ['owner', 'admin', 'member', 'external', 'inactive', 'unrelated']) {
      await fixture.query(`INSERT INTO "user" (id,name,email,email_verified,role,created_at,updated_at)
        VALUES ($1,$1,$2,1,$3,1,1)`, [user, `${schema}-${user}@example.test`, ['owner', 'admin'].includes(user) ? 'admin' : 'user']);
    }
    await fixture.query(`INSERT INTO canvas_organization_settings
      (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES ('org-one','owner','team',1,1,1), ('org-two','unrelated','team',1,2,2)`);
    const { ensureOrganizationPermissionRow } = await import('../app/lib/organization/permission-provisioning');
    const provisioning = { get: async (sql: string, params?: unknown[]) => (await fixture!.query(sql, params)).rows[0],
      run: async (sql: string, params?: unknown[]) => { await fixture!.query(sql, params); } };
    for (const user of ['owner', 'admin', 'member', 'external', 'inactive', 'unrelated']) {
      await ensureOrganizationPermissionRow(provisioning, { organizationId: 'org-one', userId: user,
        role: user === 'owner' ? 'owner' : user === 'admin' ? 'admin' : user === 'external' ? 'external' : 'member', activateExisting: false, now: 1 });
    }
    await ensureOrganizationPermissionRow(provisioning, { organizationId: 'org-two', userId: 'member', role: 'member', activateExisting: false, now: 1 });
    await fixture.query("UPDATE organization_user_permissions SET status='archived' WHERE user_id='inactive'");
    const permissions = await productionPermissions(fixture);
    const { updateOrganizationPermissions: update, OrganizationPermissionMutationError: MutationError } = permissions;
    const rows = async () => (await fixture!.query('SELECT * FROM organization_user_permissions ORDER BY organization_id,user_id')).rows;
    const snapshot = await rows();
    let result = await update({ actorUserId: 'owner', targetUserId: 'member', permissions: { canWriteTeamWorkspace: true } });
    assert.equal(result.permissions.canWriteTeamWorkspace, true);
    assert.equal(result.permissions.canDeleteTeamFiles, false);
    assert.equal(result.organizationId, 'org-one'); assert.equal(result.userId, 'member');
    assert.ok(result.updatedAt! > 1);
    result = await update({ actorUserId: 'owner', targetUserId: 'member', permissions: {
      canWriteTeamWorkspace: false, canDeleteTeamFiles: true, canExport: true, canManageBackups: false,
    } });
    assert.equal(result.permissions.canWriteTeamWorkspace, false);
    assert.equal(result.permissions.canDeleteTeamFiles, true); assert.equal(result.permissions.canExport, true);
    assert.equal(result.permissions.canManageBackups, false);
    assert.deepEqual((await rows()).filter(row => row.organization_id !== 'org-one' || row.user_id !== 'member'),
      snapshot.filter(row => row.organization_id !== 'org-one' || row.user_id !== 'member'), 'Other users and organization rows retain every field.');
    const beforeEmpty = await rows();
    await update({ actorUserId: 'owner', targetUserId: 'member', permissions: {} });
    assert.deepEqual(await rows(), beforeEmpty, 'Empty patch does not update timestamps or permissions.');
    await fixture.query("UPDATE organization_user_permissions SET can_manage_organization_memory=0 WHERE user_id='admin' AND organization_id='org-one'");
    const beforeDenied = await rows();
    for (const [actorUserId, targetUserId, patch, code] of [
      ['member', 'unrelated', { canExport: true }, 'ORGANIZATION_PERMISSION_DENIED'],
      ['admin', 'member', { canManageOrganizationMemory: true }, 'PERMISSION_NOT_OWNED'],
      ['owner', 'owner', { canExport: false }, 'LAST_OWNER'],
      ['owner', 'external', { canExport: true }, 'EXTERNAL_NO_ORG_PERMISSIONS'],
      ['owner', 'inactive', { canExport: true }, 'USER_ARCHIVED'],
    ] as const) {
      await assert.rejects(update({ actorUserId, targetUserId, permissions: patch }),
        error => error instanceof MutationError && error.code === code);
      assert.deepEqual(await rows(), beforeDenied, `Denied ${code} rolls back all changes.`);
    }
    // The transaction was released after each rejection; a legitimate delegated mutation still succeeds.
    result = await update({ actorUserId: 'admin', targetUserId: 'member', permissions: { canExport: false } });
    assert.equal(result.permissions.canExport, false);
    console.log('PostgreSQL permission mutations passed: one/multiple fields, true/false, scope, empty patch, delegation, owner/external/inactive protection and rollback.');
  } finally {
    await fixture?.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
