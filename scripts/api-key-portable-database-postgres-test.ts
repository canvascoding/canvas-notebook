import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Client } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';
import { issueApiKeySecret } from '../app/lib/api-keys/secret';
import { exportPortableDatabase } from '../app/lib/migration/database-export';
import { readPortableDatabaseSchema } from '../app/lib/migration/database-schema';
import { replacePortableDatabase, stagePortableDatabase } from '../app/lib/migration/database-restore';
import type { CanvasMigrationManifest } from '../app/lib/migration/types';

// These are declared storage fixtures, never an authenticated HTTP principal.
// The existing runtime migrations initialize a nonce-owned PostgreSQL database.
// No app server, login response, license, policy reader or SQL result is replaced.
let stage = 'setup', groups = 0;
async function main() {
  assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1');
  const environment = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-api-key-portability-'));
  let fixture: Awaited<ReturnType<typeof createSharedConnectionTestDatabase>> | undefined;
  let client: Client | undefined, databaseError: Error | undefined;
  try {
    fixture = await createSharedConnectionTestDatabase(); assert.equal(fixture.native, true);
    const pool = fixture.getPostgresRuntimeQueryable(); assert(pool && 'connect' in pool);
    const connectionString = pool.options.connectionString; assert(typeof connectionString === 'string');
    assert.match(new URL(connectionString).pathname, /^\/canvas_connection_test_[a-f0-9]{32}$/u);
    Object.assign(process.env, { DATABASE_URL: connectionString, DATA: root, CANVAS_DATA_ROOT: root });
    client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    await client.connect(); const sql = client;
    const onError = (error: Error) => { databaseError ??= error; }; sql.on('error', onError);
    const check = async (name: string, test: () => Promise<void>) => {
      stage = name; await test(); groups++; console.log('API-key portable database passed: ' + name);
    };
    const identity = randomUUID(), owner = 'portable-owner-' + identity, organization = 'portable-org-' + identity;
    const now = Date.now();
    await sql.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES ($1,'Source name',$2,1,'admin',0,$3,$3)`, [owner, identity + '@portable.example.test', now]);
    await sql.query(`INSERT INTO account(id,account_id,provider_id,user_id,issuer,password,created_at,updated_at)
      VALUES ($1,$2,'credential',$2,'local:credential',$3,$4,$4)`, [randomUUID(), owner, await hashPassword(randomBytes(32).toString('hex')), now]);
    await sql.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,created_at,updated_at)
      VALUES ($1,$2,$3,$3)`, [organization, owner, now]);
    await sql.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,created_at,updated_at)
      VALUES ($1,$2,'owner','active',$3,$3)`, [organization, owner, now]);
    const seedKey = async (name: string, userId: string) => {
      const integration = randomUUID(), key = issueApiKeySecret();
      await sql.query(`INSERT INTO canvas_api_integrations(id,owner_user_id,instance_id,name,workspace_ids_json,
        actions_json,creation_request_id,revision,created_at,updated_at) VALUES ($1,$2,$3,$3,'[]','["read"]',$4,1,$5,$5)`,
      [integration, userId, name, randomUUID(), now]);
      await sql.query(`INSERT INTO canvas_api_keys(id,integration_id,secret_hash,prefix,issuance_request_id,
        created_by_session_id,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [key.id, integration, key.secretHash, key.prefix, randomUUID(), 'declared-storage-session', now + 3_600_000, now]);
      return { integration, ...key };
    };
    const sourceKey = await seedKey('source-instance-' + identity, owner);
    let snapshot: Awaited<ReturnType<typeof exportPortableDatabase>>, text: string;
    const archive = path.join(root, 'portable.jsonl.gz');
    await check('normal initialized schema exports no source API integration or credential', async () => {
      const schema = await readPortableDatabaseSchema(sql);
      assert(!schema.tables.some(table => ['canvas_api_integrations', 'canvas_api_keys'].includes(table.name)));
      assert.equal(schema.tables.find(table => table.name === 'collaboration_original_markdown_import_api_keys')?.mode, 'reset');
      for (const name of ['collaboration_documents', 'collaboration_yjs_states', 'collaboration_markdown_file_import_receipts']) {
        assert.equal(schema.tables.find(table => table.name === name)?.mode, 'copy');
      }
      snapshot = await exportPortableDatabase(archive);
      text = gunzipSync(await fs.readFile(archive)).toString('utf8');
      for (const privateValue of ['canvas_api_integrations', 'canvas_api_keys', sourceKey.integration,
        sourceKey.id, sourceKey.secretHash, sourceKey.key, 'source-instance-' + identity]) assert(!text.includes(privateValue));
    });
    await sql.query('DELETE FROM canvas_api_integrations WHERE id=$1', [sourceKey.integration]);
    const targetKey = await seedKey('target-instance-' + identity, owner);
    const targetOnly = 'target-only-' + identity;
    await sql.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES ($1,'Target only',$2,1,'user',0,$3,$3)`, [targetOnly, 'target-' + identity + '@portable.example.test', now]);
    await seedKey('target-only-instance-' + identity, targetOnly);
    await sql.query('UPDATE "user" SET name=$1 WHERE id=$2', ['Target name', owner]);
    const retained = async () => ({
      integrations: (await sql.query('SELECT row_to_json(t) AS value,xmin::text AS xmin FROM canvas_api_integrations t ORDER BY id')).rows,
      credentials: (await sql.query('SELECT row_to_json(t) AS value,xmin::text AS xmin FROM canvas_api_keys t ORDER BY id')).rows,
      organization: (await sql.query('SELECT row_to_json(t) AS value,xmin::text AS xmin FROM canvas_organization_settings t ORDER BY organization_id')).rows,
    });
    const before = await retained();
    const manifest = { users: snapshot!.header.users, source: { organizationId: organization } } as CanvasMigrationManifest;
    await check('real restore commits portable data while retaining target-only users and exact target keys', async () => {
      await sql.query('BEGIN');
      try {
        const staged = await stagePortableDatabase(sql, archive, manifest);
        assert(!staged.tables.has('canvas_api_integrations') && !staged.tables.has('canvas_api_keys'));
        await replacePortableDatabase(sql, staged);
        assert.deepEqual(await retained(), before);
        assert.equal((await sql.query('SELECT name FROM "user" WHERE id=$1', [owner])).rows[0].name, 'Source name');
        assert.equal((await sql.query('SELECT name FROM "user" WHERE id=$1', [targetOnly])).rows[0].name, 'Target only');
        await sql.query('COMMIT');
      } catch (error) { await sql.query('ROLLBACK'); throw error; }
      assert.deepEqual(await retained(), before);
      assert.equal((await sql.query('SELECT secret_hash FROM canvas_api_keys WHERE id=$1', [targetKey.id])).rows[0].secret_hash, targetKey.secretHash);
    });
    await check('real restore rollback retains target credentials and previous application values', async () => {
      await sql.query('UPDATE "user" SET name=$1 WHERE id=$2', ['Before rollback', owner]);
      await sql.query('BEGIN');
      try {
        await replacePortableDatabase(sql, await stagePortableDatabase(sql, archive, manifest));
        assert.equal((await sql.query('SELECT name FROM "user" WHERE id=$1', [owner])).rows[0].name, 'Source name');
        assert.deepEqual(await retained(), before);
      } finally { await sql.query('ROLLBACK'); }
      assert.deepEqual(await retained(), before);
      assert.equal((await sql.query('SELECT name FROM "user" WHERE id=$1', [owner])).rows[0].name, 'Before rollback');
    });
    await check('an injected credential record is rejected before application replacement', async () => {
      const lines = text!.trimEnd().split('\n');
      const injected = JSON.stringify({ table: 'canvas_api_keys', row: { id: randomUUID() } });
      const bad = path.join(root, 'injected.jsonl.gz');
      await fs.writeFile(bad, gzipSync([lines[0], injected, ...lines.slice(1)].join('\n') + '\n'), { mode: 0o600 });
      await sql.query('BEGIN');
      try { await assert.rejects(stagePortableDatabase(sql, bad, manifest), /unknown or excluded table/u); }
      finally { await sql.query('ROLLBACK'); }
      assert.deepEqual(await retained(), before);
    });
    await check('an unreviewed API-named table still fails the strict schema policy', async () => {
      await sql.query('CREATE TABLE public.canvas_api_unreviewed_fixture(id text PRIMARY KEY)');
      try { await assert.rejects(readPortableDatabaseSchema(sql), /policy needs review for table canvas_api_unreviewed_fixture/u); }
      finally { await sql.query('DROP TABLE public.canvas_api_unreviewed_fixture'); }
      assert.deepEqual(await retained(), before);
    });
    assert.equal(databaseError, undefined); sql.removeListener('error', onError);
  } finally {
    try {
      if (client) { await client.query('ROLLBACK').catch(() => undefined); await client.end(); }
    } finally {
      try { if (fixture) await fixture.close(); }
      finally {
        await fs.rm(root, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
        Object.assign(process.env, environment);
      }
    }
  }
  console.log(JSON.stringify({ groups, nativePostgres: true, storageFixturesOnly: true,
    authenticatedHttpAcceptance: false, ownedDatabaseCleanupComplete: true }));
}
main().catch(error => {
  const schemaFailure = /^(?:Database portability policy needs review for table|Preserved instance state has an unsupported dependency on) ([a-z_][a-z0-9_]*)\.$/u.exec(error.message);
  console.error(JSON.stringify({ stage, errorType: error.name, code: error.code ?? null,
    schemaTable: schemaFailure?.[1], frames: error.stack?.split('\n').slice(1, 6) }));
  process.exitCode = 1;
});
