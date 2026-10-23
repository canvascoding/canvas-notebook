import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', assertion = 'none', passed = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `public_share_read_${crypto.randomUUID().replaceAll('-', '')}`, nonce = crypto.randomUUID();
  assert.match(schema, /^public_share_read_[a-f0-9]{32}$/u);
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-public-share-read-')));
  const rootIdentity = await stat(dataRoot);
  assert.equal(rootIdentity.uid, process.getuid!()); assert.equal(rootIdentity.mode & 0o077, 0);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>();
  let created = false, schemaOid = 0, schemaRemoved = false, dataRemoved = false, fetches = 0, pool: { end: () => Promise<void> } | undefined;
  let primaryFailure: unknown;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=public-share-read-fixture` });
    clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const check = async (name: string, operation: () => Promise<void>) => {
    stage = name; assertion = 'none'; await operation(); passed++; console.log('Public share read case passed:', JSON.stringify({ passed, name }));
  };
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${nonce}'`);
    schemaOid = Number((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].oid);
    // Genuine request/session, signed runtime license and current rights are
    // private fixture facts; no caller-created workspace grants Create access.
    Object.assign(process.env, { DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`, CANVAS_DATABASE_PROVIDER: 'postgres',
      DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_ORGANIZATION_ID: 'sharing-org',
      CANVAS_MCP_DIRECT_ENABLED: 'false', BETTER_AUTH_BASE_URL: 'http://localhost', BASE_URL: 'http://localhost',
      AUTH_COOKIE_SECURE: 'false', BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'NEXT_PHASE', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'sharing-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true,
      organizationId: 'sharing-org', capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true }, seatLimit: 3, quotas: { users: 3 },
      entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('No external network is permitted in this owned fixture.'); };
    stage = 'full migrations in own schema';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const admin = await ownClient();
    const own = async () => {
      const row = (await admin.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path,
        n.oid,obj_description(n.oid,'pg_namespace') AS nonce,n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner
        FROM pg_namespace n WHERE n.nspname=$1`, [schema])).rows[0];
      assert(row); assert.equal(Number(row.oid), schemaOid); assert.equal(row.nonce, nonce); assert.equal(row.owner, true);
      assert.equal(row.schema, schema); assert.deepEqual(row.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']);
    };
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      await own(); const result = await admin.query(sql, values); await own(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 3);
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('share-owner','Owner','owner@sharing.test',1,'admin',0,100,100)`);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('sharing-org','share-owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_create_public_links,created_at,updated_at)
      VALUES('sharing-org','share-owner','owner','active',1,1,100,100)`);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('sharing-seat','sharing-org','owner@sharing.test','share-owner','owner','active',100,100,100,100)`);
    await admin.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('sharing-org',100,100)");
    const rootRelativePath = 'teams/read-fixture', workspaceRoot = path.join(dataRoot, rootRelativePath);
    await mkdir(workspaceRoot, { recursive: true });
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('sharing-space','sharing-org','team','Sharing',$1,'active',100,100)`, [rootRelativePath]);
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
      VALUES('sharing-session',$1,'share-owner',$2,100,100)`, [sessionToken, Date.now() + 3600000]);
    const cookie = (await serializeSignedCookie('better-auth.session_token', sessionToken, process.env.BETTER_AUTH_SECRET!)).split(';')[0];
    const request = () => new NextRequest('http://localhost/api/security/public-shares', { method: 'POST',
      headers: { cookie, 'x-canvas-workspace-id': 'sharing-space' } });
    const { auth } = await import('../app/lib/auth');
    const actualSession = await auth.api.getSession({ headers: request().headers });
    assert.equal(actualSession?.session.id, 'sharing-session'); assert.equal(actualSession?.user.id, 'share-owner');
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const workspace = await readPostgresWorkspaceForActor({ userId: 'share-owner', role: 'admin' }, 'sharing-space'); assert(workspace);
    assert.equal(workspace.workspaceId, 'sharing-space'); assert.equal(workspace.workspaceType, 'team');
    assert.equal(workspace.rootPath, workspaceRoot); assert.equal(workspace.organizationId, 'sharing-org');
    assert.equal(workspace.actor?.userId, 'share-owner'); assert.equal(workspace.permissions.canRead, true);
    assert.equal(workspace.permissions.canCreatePublicLinks, true);
    // A statement trigger also sees zero-row UPDATEs. nextval is deliberately
    // nontransactional: even a failed/rolled-back hidden allocation is visible.
    await admin.query(`CREATE SEQUENCE fixture_share_write_attempts;
      CREATE TABLE fixture_share_write_audit(attempt bigint PRIMARY KEY,operation text NOT NULL);
      CREATE FUNCTION fixture_audit_share_write() RETURNS trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        INSERT INTO "${schema}".fixture_share_write_audit(attempt,operation)
          VALUES(nextval('"${schema}".fixture_share_write_attempts'::regclass),TG_OP);
        RETURN NULL;
      END; $fixture$;
      CREATE TRIGGER fixture_audit_share_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
        ON public_file_shares FOR EACH STATEMENT EXECUTE FUNCTION fixture_audit_share_write()`);
    const service = await import('../app/lib/public-sharing/public-file-shares');
    const fileRoute = await import('../app/public/files/[token]/[...filename]/route');
    const baseUrl = 'https://sharing.example.test/base/', normalizedBase = baseUrl.replace(/\/+$/u, '');
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5]);
    const snapshot = async (id: string): Promise<Record<string, unknown>> => {
      const row = (await admin.query<{ row: Record<string, unknown> }>('SELECT to_jsonb(s) AS row FROM public_file_shares s WHERE id=$1', [id])).rows[0];
      assert(row); return row.row;
    };
    const audit = async () => ({
      sequence: (await admin.query('SELECT last_value::text,is_called FROM fixture_share_write_attempts')).rows[0],
      rows: (await admin.query('SELECT attempt::text,operation FROM fixture_share_write_audit ORDER BY fixture_share_write_audit.attempt')).rows,
    });
    type Fixture = { id: string; token: string; file: string; publicPath: string; publicUrl: string };
    const publish = async (name: string, legacy = false): Promise<Fixture> => {
      const file = `${name} ü.bin`;
      await writeFile(path.join(workspaceRoot, file), bytes);
      const result = await service.createPublicFileShares({ paths: [file], request: request(), workspaceId: workspace.workspaceId, baseUrl });
      assert.equal(result.skipped.length, 0); assert.equal(result.shares.length, 1);
      const share = result.shares[0]; assert.match(share.shortCode!, /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{6}$/u);
      assert.equal(share.shortPath, `/p/${share.shortCode}`); assert.equal(share.shortUrl, `${normalizedBase}${share.shortPath}`);
      const token = decodeURIComponent(share.publicPath.split('/')[3]);
      assert.equal(share.publicPath, `/public/files/${encodeURIComponent(token)}/${encodeURIComponent(file)}`);
      assert.equal(share.publicUrl, `${normalizedBase}${share.publicPath}`);
      if (legacy) await admin.query('UPDATE public_file_shares SET short_code=NULL WHERE id=$1', [share.id]);
      return { id: share.id, token, file,
        publicPath: share.publicPath, publicUrl: share.publicUrl };
    };
    const head = (fixture: Fixture) => fileRoute.HEAD(new NextRequest(`http://localhost${fixture.publicPath}`, { method: 'HEAD' }),
      { params: Promise.resolve({ token: fixture.token, filename: [fixture.file] }) });
    const assertFallback = (share: { shortUrl: string; publicUrl: string; shortCode?: string | null; shortPath?: string; publicPath?: string }, fixture: Fixture, absolute: boolean) => {
      const expected = absolute ? `${normalizedBase}${fixture.publicPath}` : fixture.publicPath;
      assert.equal(share.publicUrl, expected); assert.equal(share.shortUrl, expected);
      if ('shortCode' in share) assert.equal(share.shortCode, null);
      if ('shortPath' in share) assert.equal(share.shortPath, fixture.publicPath);
      if ('publicPath' in share) assert.equal(share.publicPath, fixture.publicPath);
    };
    const unchanged = async (fixture: Fixture, operation: () => Promise<void>) => {
      const before = await snapshot(fixture.id), writesBefore = await audit();
      let operationFailure: unknown;
      try { await operation(); } catch (error) { operationFailure = error; }
      const writesAfter = await audit(), after = await snapshot(fixture.id);
      // Emit finite evidence even when an earlier URL assertion fails in RED.
      console.log('Public share read SQL witness:', JSON.stringify({ stage,
        attemptedWrite: !isDeepStrictEqual(writesAfter.sequence, writesBefore.sequence),
        committedWriteStatements: writesAfter.rows.length - writesBefore.rows.length, rowChanged: !isDeepStrictEqual(after, before) }));
      assert.deepEqual(writesAfter, writesBefore, 'Read must issue no INSERT/UPDATE/DELETE/TRUNCATE, including zero-row or rolled-back writes.');
      assert.deepEqual(after, before, 'Read must preserve the complete stored share, policy and counters.');
      if (operationFailure !== undefined) throw operationFailure;
    };
    for (const entry of ['list', 'annotation', 'single', 'token', 'HEAD'] as const) await check(`historical null shortcode ${entry} is fully read-only`, async () => {
      const fixture = await publish(`legacy-${entry}`, true);
      assert.equal((await snapshot(fixture.id)).short_code, null);
      await unchanged(fixture, async () => {
        if (entry === 'list') {
          const shares = await service.listPublicFileShares({ userId: 'share-owner', workspace, paths: [fixture.file], baseUrl });
          assert.equal(shares.length, 1); assert.equal(shares[0].id, fixture.id); assertFallback(shares[0], fixture, true);
        } else if (entry === 'annotation') {
          const annotations = await service.getPublicShareAnnotations([fixture.file], baseUrl, workspace);
          assert.equal(annotations.size, 1); const annotation = annotations.get(fixture.file); assert(annotation);
          assert.equal(annotation.id, fixture.id); assertFallback(annotation, fixture, true);
        } else if (entry === 'single') {
          const share = await service.getPublicFileShareForUser({ id: fixture.id, userId: 'share-owner', workspace, baseUrl });
          assert(share); assertFallback(share, fixture, true);
        } else if (entry === 'token') {
          const resolved = await service.resolvePublicShareToken(fixture.token, { recordAccess: false });
          assert.equal(resolved.ok, true); if (!resolved.ok) assert.fail('The original token must remain usable.');
          assert.equal(resolved.share.id, fixture.id); assertFallback(resolved.share, fixture, false);
        } else {
          const response = await head(fixture); assert.equal(response.status, 200);
          assert.equal(response.headers.get('content-length'), String(bytes.length)); assert.equal(await response.text(), '');
        }
      });
    });
    await check('existing short code still resolves without mutation', async () => {
      const fixture = await publish('existing-short'); const before = await snapshot(fixture.id);
      await unchanged(fixture, async () => {
        const resolved = await service.resolvePublicShareShortCode(String(before.short_code), { recordAccess: false });
        assert.equal(resolved.ok, true); if (!resolved.ok) assert.fail('An existing short code must remain usable.');
        assert.equal(resolved.share.id, fixture.id); assert.equal(resolved.share.shortPath, `/p/${before.short_code}`);
        assert.equal(resolved.share.publicPath, fixture.publicPath);
      });
    });
    await check('explicit create retains short code allocation for a historical active share', async () => {
      const fixture = await publish('create-reuse', true), before = await snapshot(fixture.id), writesBefore = await audit();
      const result = await service.createPublicFileShares({ paths: [fixture.file], request: request(), workspaceId: workspace.workspaceId, baseUrl });
      assertion = 'create_reuse_no_skips'; assert.equal(result.skipped.length, 0);
      assertion = 'create_reuse_one_share'; assert.equal(result.shares.length, 1); const share = result.shares[0];
      assertion = 'create_reuse_same_id'; assert.equal(share.id, fixture.id);
      assertion = 'create_reuse_same_url'; assert.equal(share.publicUrl, fixture.publicUrl);
      assertion = 'create_reuse_same_path'; assert.equal(share.publicPath, fixture.publicPath);
      assertion = 'create_reuse_valid_shortcode';
      assert.match(share.shortCode!, /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{6}$/u);
      const after = await snapshot(fixture.id), writesAfter = await audit();
      console.log('Public share create reuse SQL witness:', JSON.stringify({
        changedFields: Object.keys(before).filter(key => !isDeepStrictEqual(before[key], after[key])),
        committedWriteStatements: writesAfter.rows.length - writesBefore.rows.length,
        operations: writesAfter.rows.slice(writesBefore.rows.length).map(row => row.operation),
      }));
      assertion = 'create_reuse_only_shortcode_changed'; assert.deepEqual(after, { ...before, short_code: share.shortCode });
      assertion = 'create_reuse_one_update'; assert.equal(writesAfter.rows.length, writesBefore.rows.length + 1);
      assertion = 'create_reuse_update_operation';
      assert.equal(writesAfter.rows.at(-1)?.operation, 'UPDATE');
    });
    await check('new create allocates a shortcode and ordinary token access counts exactly once', async () => {
      const writesBefore = await audit(), fixture = await publish('counter-positive');
      const createdAudit = await audit(); assert.equal(createdAudit.rows.length, writesBefore.rows.length + 1);
      assert.equal(createdAudit.rows.at(-1)?.operation, 'INSERT');
      const before = await snapshot(fixture.id); assert.equal(before.access_count, 0);
      const resolved = await service.resolvePublicShareToken(fixture.token); assert.equal(resolved.ok, true);
      const after = await snapshot(fixture.id); assert.equal(after.access_count, 1); assert.equal(typeof after.last_accessed_at, 'number');
      assert.deepEqual(after, { ...before, access_count: 1, last_accessed_at: after.last_accessed_at });
      const countedAudit = await audit(); assert.equal(countedAudit.rows.length, createdAudit.rows.length + 1);
      assert.equal(countedAudit.rows.at(-1)?.operation, 'UPDATE');
      await unchanged(fixture, async () => { assert.equal((await head(fixture)).status, 200); });
    });
    for (const condition of ['expired', 'revoked', 'missing', 'stale'] as const) await check(`${condition} historical share denies reads without persisting reconciliation`, async () => {
      const fixture = await publish(`denied-${condition}`, true);
      if (condition === 'expired') await admin.query('UPDATE public_file_shares SET expires_at=$1 WHERE id=$2', [Date.now() - 1000, fixture.id]);
      if (condition === 'revoked') await admin.query("UPDATE public_file_shares SET status='revoked',revoked_at=$1 WHERE id=$2", [Date.now(), fixture.id]);
      if (condition === 'missing') await unlink(path.join(workspaceRoot, fixture.file));
      if (condition === 'stale') {
        await rename(path.join(workspaceRoot, fixture.file), path.join(workspaceRoot, `${fixture.file}.original`));
        await writeFile(path.join(workspaceRoot, fixture.file), bytes);
      }
      await unchanged(fixture, async () => {
        const listed = await service.listPublicFileShares({ userId: 'share-owner', workspace, paths: [fixture.file], baseUrl, status: 'all' });
        assert.equal(listed.length, 1); assert.equal(listed[0].status, condition);
        const single = await service.getPublicFileShareForUser({ id: fixture.id, userId: 'share-owner', workspace, baseUrl });
        assert(single); assert.equal(single.status, condition);
        assert.equal((await service.getPublicShareAnnotations([fixture.file], baseUrl, workspace)).size, 0);
        const resolved = await service.resolvePublicShareToken(fixture.token, { recordAccess: false });
        assert.equal(resolved.ok, false); if (resolved.ok) assert.fail('Unavailable historical share must deny token resolution.');
        const expectedStatus = condition === 'expired' || condition === 'revoked' ? 410 : 404;
        assert.equal(resolved.status, expectedStatus); const response = await head(fixture); assert.equal(response.status, expectedStatus); await response.arrayBuffer();
      });
    });
    assert.equal(passed, 12); assert.equal(fetches, 0); await own();
    console.log('Public share read SQL assertions complete:', JSON.stringify({ passed, fetches }));
  } catch (error) { primaryFailure = error; }
  finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
    if (pool) await cleanup(() => pool!.end());
    for (const client of clients) await cleanup(() => endClient(client));
    if (created && clients.size === 0 && cleanupErrors.length === 0) await cleanup(async () => {
      const record = (await control.query(`SELECT oid,obj_description(oid,'pg_namespace') AS nonce,
        nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
      assert(record); assert.equal(Number(record.oid), schemaOid); assert.equal(record.nonce, nonce); assert.equal(record.owner, true);
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      schemaRemoved = (await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed === true;
      assert.equal(schemaRemoved, true);
    });
    await cleanup(() => control.end());
    await cleanup(async () => {
      const current = await stat(dataRoot);
      assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino); assert.equal(current.uid, rootIdentity.uid);
      await rm(dataRoot, { recursive: true });
      await assert.rejects(stat(dataRoot), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT'); dataRemoved = true;
    });
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    console.log('Public share read owned cleanup:', JSON.stringify({ schemaRemoved, dataRemoved, openClients: clients.size, passed }));
    if (cleanupErrors.length) throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Owned public share read fixture cleanup failed.');
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  assert.equal(schemaRemoved, true); assert.equal(dataRemoved, true); complete = true;
  console.log('Public share read PostgreSQL18 finished:', JSON.stringify({ passed, schemaRemoved, dataRemoved }));
}
main().catch(error => {
  const assertionLine = error instanceof Error ? /public-share-read-only-postgres-test\.ts:(\d+):/u.exec(error.stack ?? '')?.[1] ?? null : null;
  console.error('Owned public share read fixture failed:', { stage, assertion, assertionLine, passed, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null }); process.exitCode = 1;
});
