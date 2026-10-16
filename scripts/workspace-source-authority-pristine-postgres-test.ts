import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

// Actual full-DDL PG18/Auth/FS collection through genuine Create and import.
// No mock catalogue, state loader, authority marker or browser/app host is used.
// Run only against the existing managed loopback PG18; it creates no app host.
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration';
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const schema = `pristine_asset_collector_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^pristine_asset_collector_[a-f0-9]{32}$/u);
  const organizationId = `collector-org-${crypto.randomUUID()}`;
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-pristine-asset-collector-')));
  const applicationName = `collector-fixture-${crypto.randomUUID()}`;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let created = false, controlConnected = false;
  let pool: { end(): Promise<void>; totalCount: number; waitingCount: number } | undefined;
  let cases = 0, fetches = 0;
  const digest = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    await control.connect(); controlConnected = true;
    const realm = (await control.query(`SELECT current_database() AS database,current_user AS role,
      d.oid::bigint AS oid,pg_get_userbyid(d.datdba) AS owner,current_setting('server_version_num') AS version
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert.equal(realm.database, 'canvas_notebook'); assert.equal(realm.role, decodeURIComponent(url.username));
    assert.equal(typeof realm.owner, 'string'); assert(realm.owner); assert(Number(realm.oid) > 0);
    assert.equal(Math.floor(Number(realm.version) / 10000), 18);
    assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS absent', [schema])).rows[0].absent, true);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    Object.assign(process.env, { DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=${applicationName}`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: organizationId, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test',
      CANVAS_TEST_NATIVE_TEXT_SESSION: '1' });
    delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY;
    delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS; delete process.env.NEXT_PHASE;
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = digest(keys.publicKey.export({ type: 'spki', format: 'der' }));
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: `collector-license-${crypto.randomUUID()}`,
      sub: process.env.CANVAS_INSTANCE_ID, instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook',
      plan: 'community', status: 'active', hostingMode: 'community', edition: 'team', licenseClass: 'commercial',
      licenseEnvironment: 'production', nonBillable: false, seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6,
      iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('No network/issuer is permitted in this isolated fixture.'); };
    const admin = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=${applicationName}` });
    admin.on('error', () => undefined); clients.add(admin); await admin.connect();
    const ownerRealm = async () => {
      const actual = (await admin.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path,
        (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS oid,pg_backend_pid() AS backend`)).rows[0];
      assert.equal(actual.schema, schema); assert.equal(Number(actual.oid), Number(realm.oid));
      assert.deepEqual(actual.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']); return actual;
    };
    const adminBackend = (await ownerRealm()).backend;
    stage = 'actual owned-schema global DDL';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      assert.equal((await ownerRealm()).backend, adminBackend);
      const result = await admin.query(sql, values); await ownerRealm(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    stage = 'real users, Team seats and Cookie/Bearer sessions';
    const now = Date.now();
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@starter.test',1,'admin',0,$1,$1),('member','Member','member@starter.test',1,'user',0,$1,$1)`, [now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES($1,'owner','team',1,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES($1,'owner','owner','active',1,100,100),($1,'member','member','active',0,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat',$1,'owner@starter.test','owner','owner','active',100,100,100,100),
      ('member-seat',$1,'member@starter.test','member','member','active',100,200,100,100)`, [organizationId]);
    await admin.query('INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES($1,100,100)', [organizationId]);
    const { personalWorkspaceRootRelativePath, organizationWorkspaceRootRelativePath } = await import('../app/lib/workspaces/contracts');
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,is_default,created_at,updated_at)
      VALUES($1,$2,'organization','Organization',$3,'active',1,100,100)`,
    [`organization-${crypto.randomUUID()}`, organizationId, organizationWorkspaceRootRelativePath(organizationId)]);
    for (const user of ['owner', 'member']) await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,
      root_relative_path,status,is_default,created_at,updated_at) VALUES($1,$2,'personal',$3,$3,$4,'active',1,100,100)`,
    [`personal-${crypto.randomUUID()}`, organizationId, user, personalWorkspaceRootRelativePath(user)]);
    const tokens = { owner: crypto.randomBytes(32).toString('hex'), member: crypto.randomBytes(32).toString('hex') };
    for (const user of ['owner', 'member'] as const) await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$5)`, [`session-${user}`, tokens[user], user, now + 3600000, now]);
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    const { getLicenseStatus } = await import('../app/lib/license');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!, process.env.CANVAS_INSTANCE_ID!)).ok, true);
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 2);
    const { auth } = await import('../app/lib/auth');
    const { openDb } = await import('../app/lib/db');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { createPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { completeWorkspaceStarterDocumentInitialization } = await import('../app/lib/workspaces/starter-document-initialization');
    const { POST: createFile } = await import('../app/api/files/create/route');
    const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../app/lib/workspaces/request-principal');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { readWorkspaceLinkSourceAuthorityOnConnection } = await import('../app/lib/markdown/workspace-source-authority-stage');
    const { persistPristineOriginalWorkspaceFileForWrite } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const headers = async (workspaceId: string, cookie: boolean) => {
      const actual = new Headers({ 'x-canvas-workspace-id': workspaceId });
      if (cookie) actual.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens.owner, process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else actual.set('authorization', `Bearer ${tokens.owner}`);
      return actual;
    };
    const request = async (workspaceId: string, cookie: boolean) => new NextRequest('http://localhost/api/files/create', {
      method: 'POST', headers: await headers(workspaceId, cookie),
    });
    const session = await auth.api.getSession({ headers: await headers('unused', true) });
    assert(session); assert.equal(session.user.id, 'owner'); const actor = resolveWorkspaceActor(session.user);
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); cases++; console.log(`Pristine asset collector PG18 passed: ${name}`);
    };
    const createdFile = async (workspace: WorkspaceContext, filePath: string, cookie: boolean) => {
      const actualHeaders = await headers(workspace.workspaceId, cookie); actualHeaders.set('content-type', 'application/json');
      const response = await createFile(new NextRequest('http://localhost/api/files/create', {
        method: 'POST', headers: actualHeaders, body: JSON.stringify({ type: 'file', path: filePath }),
      }));
      const result: unknown = await response.json().catch(() => null);
      const success = result !== null && typeof result === 'object' ? Reflect.get(result, 'success') : undefined;
      const code = result !== null && typeof result === 'object' ? Reflect.get(result, 'code') : undefined;
      if (response.status !== 200 || success !== true) console.log('Pristine asset Create public result', {
        status: response.status, success: success === true, code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : null,
      });
      assert.equal(response.status, 200); assert.equal(success, true);
      const original = await readFile(path.join(workspace.rootPath, filePath)); assert.equal(original.byteLength, 0);
      const registered = (await admin.query(`SELECT id,lineage_id,workspace_id,workspace_type,path,provider,status,state_version,yjs_state_lifecycle
        FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status='active'`, [workspace.workspaceId, filePath])).rows;
      assert.equal(registered.length, 1); const document = registered[0];
      assert.equal(document.workspace_type, workspace.workspaceType); assert.equal(document.provider, 'yjs');
      assert.equal(document.state_version, 0); assert.equal(document.yjs_state_lifecycle, 'never_initialized');
      assert.equal(typeof document.id, 'string'); assert.equal(typeof document.lineage_id, 'string');
      for (const table of ['collaboration_yjs_states', 'collaboration_yjs_state_backups', 'collaboration_agent_operations']) {
        assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE document_id=$1`, [document.id])).rows[0].count, 0);
      }
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM file_revisions WHERE lineage_id=$1', [document.lineage_id])).rows[0].count > 0, true);
      return { documentId: document.id as string, lineageId: document.lineage_id as string,
        identity: filesystemFileVersion(await stat(path.join(workspace.rootPath, filePath))) };
    };
    const collect = async (workspaceId: string, cookie: boolean) => withWorkspaceRequestPrincipal(await request(workspaceId, cookie), {
      workspaceId, permission: 'canRead',
    }, async principal => {
      const database: SqlConnection = await openDb(); let began = false, committed = false;
      try {
        await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
        // Exact existing workspace admission key, held before Principal's row
        // locks. No standalone collector wrapper or second checkout below B.
        await database.get('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
        const observation = await withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
          assert.equal(access.userId, 'owner'); assert.equal(access.workspace.workspaceId, workspaceId);
          const identity = async () => await database.get(`SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid,
            current_schema() AS schema,current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS read_only,
            (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid`) as {
              pid: number; xid: string; schema: string; isolation: string; read_only: string; database_oid: number;
            };
          const before = await identity(); assert.equal(before.schema, schema); assert.equal(Number(before.database_oid), Number(realm.oid));
          assert.equal(before.isolation, 'read committed'); assert.equal(before.read_only, 'off'); assert(before.xid);
          const key = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(workspaceId)));
          const held = await database.get(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
            AND pid=pg_backend_pid() AND database=$1 AND mode='ShareLock' AND objsubid=1
            AND classid::bigint=$2 AND objid::bigint=$3) AS held`,
          [Number(realm.oid), Number(key >> BigInt(32)), Number(key & BigInt('0xffffffff'))]) as { held: boolean };
          assert.equal(held.held, true);
          const observed = await readWorkspaceLinkSourceAuthorityOnConnection(database, access.workspace);
          assert.deepEqual(await identity(), before); await access.assertCurrent(); return observed;
        });
        await database.run('COMMIT'); committed = true; return observation;
      } catch (error) {
        if (began && !committed) {
          try { await database.run('ROLLBACK'); }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'Owned collector rollback could not be confirmed.'); }
        }
        throw error;
      } finally { await database.close(committed ? undefined : new Error('Discarding failed owned collector phase.')); }
    });
    for (const [workspaceType, cookie] of [['personal', true], ['team', false]] as const) {
      stage = `${workspaceType} genuine workspace and native starter creation`;
      const workspace = await createPostgresWorkspaceForActor(actor, { type: workspaceType, name: `Collector ${workspaceType} ${crypto.randomUUID()}` });
      assert.equal(workspace.workspaceType, workspaceType); assert.equal(workspace.permissions.canWrite, true);
      const initialized = await completeWorkspaceStarterDocumentInitialization(await request(workspace.workspaceId, cookie), workspace.workspaceId, { requireIntent: true });
      assert.equal(initialized.status, 'completed');
      const filePath = `asset-${crypto.randomUUID()}.txt`, missingPath = `missing-${crypto.randomUUID()}.txt`;
      const asset = await createdFile(workspace, filePath, cookie), missing = await createdFile(workspace, missingPath, cookie);
      await check(`${workspaceType}: real Create TXT remains an exact physical asset, never a native identity`, async () => {
        const observation = await collect(workspace.workspaceId, cookie); assert.equal(observation.stage.coverage.complete, true, JSON.stringify(observation.stage.coverage.gaps));
        assert.equal(observation.stage.executionReady, false);
        for (const [selectedPath, expected] of [[filePath, asset], [missingPath, missing]] as const) {
          const entries = observation.stage.namespace.filter(entry => entry.path === selectedPath); assert.equal(entries.length, 1);
          assert.equal(entries[0].identity, expected.identity); assert.equal(entries[0].filesystemIdentity, expected.identity);
          assert.equal(entries[0].documentId, null); assert.equal(entries[0].lifecycleGeneration, null);
          assert.equal(observation.nativeBindings.some(binding => binding.expected.path === selectedPath), false);
          assert.equal(observation.privateNativeStates.some(state => state.path === selectedPath), false);
        }
        const starter = observation.nativeBindings.find(binding => binding.expected.path === 'Erste Schritte.md'); assert(starter);
        assert.equal(starter.registry.stateLifecycle, 'initialized'); assert.equal(starter.expected.lifecycleGeneration, 1);
      });
      await check(`${workspaceType}: missing genuine pristine TXT blocks complete coverage without fabricated native state`, async () => {
        // Isolate the destructive missing-source fault. A registry-backed path
        // whose file vanished is not a supported fresh Create target; do not
        // repair its filesystem or markers to let later positive cases run.
        const missingWorkspace = await createPostgresWorkspaceForActor(actor, { type: workspaceType, name: `Missing collector ${workspaceType} ${crypto.randomUUID()}` });
        assert.equal(missingWorkspace.workspaceType, workspaceType); assert.equal(missingWorkspace.permissions.canWrite, true);
        const starter = await completeWorkspaceStarterDocumentInitialization(await request(missingWorkspace.workspaceId, cookie), missingWorkspace.workspaceId, { requireIntent: true });
        assert.equal(starter.status, 'completed');
        const absent = await createdFile(missingWorkspace, missingPath, cookie);
        await unlink(path.join(missingWorkspace.rootPath, missingPath));
        const observation = await collect(missingWorkspace.workspaceId, cookie);
        assert.equal(observation.stage.coverage.complete, false); assert.equal(observation.stage.readiness, 'blocked');
        assert(observation.stage.coverage.gaps.some(gap => gap.path === missingPath && gap.code === 'missing-physical-source'));
        assert.equal(observation.nativeBindings.some(binding => binding.expected.documentId === absent.documentId), false);
        const registered = (await admin.query('SELECT yjs_state_lifecycle,state_version FROM collaboration_documents WHERE id=$1', [absent.documentId])).rows[0];
        assert.deepEqual(registered, { yjs_state_lifecycle: 'never_initialized', state_version: 0 });
        assert.equal((await admin.query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [workspace.workspaceId, missingPath])).rows[0].id, missing.documentId);
        assert.equal(filesystemFileVersion(await stat(path.join(workspace.rootPath, missingPath))), missing.identity);
        assert.equal((await collect(workspace.workspaceId, cookie)).stage.coverage.complete, true);
      });
      let nativeBinaryHash = '', nativeVectorHash = '';
      await check(`${workspaceType}: genuine original TXT import becomes native Plain without requiring its physical projection`, async () => {
        const imported = await persistPristineOriginalWorkspaceFileForWrite(await request(workspace.workspaceId, cookie), {
          workspaceId: workspace.workspaceId, path: filePath, operationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
          expectedTarget: { kind: 'pristine', documentId: asset.documentId }, expectedFileVersion: asset.identity,
        });
        assert.equal(imported.receipt.target.documentId, asset.documentId); assert.equal(imported.receipt.target.lineageId, asset.lineageId);
        assert.equal(imported.receipt.target.representation, 'plain_text'); assert.equal(imported.receipt.target.lifecycleGeneration, 1);
        const state = (await admin.query('SELECT yjs_state,state_vector FROM collaboration_yjs_states WHERE document_id=$1', [asset.documentId])).rows[0];
        assert(Buffer.isBuffer(state.yjs_state)); assert(Buffer.isBuffer(state.state_vector));
        nativeBinaryHash = digest(state.yjs_state); nativeVectorHash = digest(state.state_vector);
        await unlink(path.join(workspace.rootPath, filePath));
        const observation = await collect(workspace.workspaceId, cookie); assert.equal(observation.stage.coverage.complete, true, JSON.stringify(observation.stage.coverage.gaps));
        const entry = observation.stage.namespace.find(value => value.path === filePath); assert(entry);
        assert.equal(entry.documentId, asset.documentId); assert.equal(entry.lifecycleGeneration, 1); assert.equal(entry.filesystemIdentity, null);
        const binding = observation.nativeBindings.find(value => value.expected.documentId === asset.documentId); assert(binding);
        assert.equal(binding.expected.lineageId, asset.lineageId); assert.equal(binding.expected.representation, 'plain_text');
        assert.equal(binding.expected.binaryHash, nativeBinaryHash); assert.equal(binding.expected.vectorHash, nativeVectorHash);
        const observedState = observation.privateNativeStates.find(value => value.documentId === asset.documentId); assert(observedState);
        assert.equal(digest(observedState.yjsState), nativeBinaryHash); assert.equal(digest(observedState.stateVector), nativeVectorHash);
      });
      await check(`${workspaceType}: actual initialized state loss stays missing-native-state, never a pristine or filesystem fallback`, async () => {
        // Explicit corruption fault in this owned schema. Do not alter registry
        // lifecycle markers, create a replacement seed or relabel an archive.
        const removed = await admin.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1 RETURNING document_id', [asset.documentId]);
        assert.equal(removed.rows.length, 1);
        const observation = await collect(workspace.workspaceId, cookie); assert.equal(observation.stage.coverage.complete, false);
        assert(observation.stage.coverage.gaps.some(gap => gap.path === filePath && gap.code === 'missing-native-state'));
        assert.equal(observation.stage.coverage.gaps.some(gap => gap.path === filePath && gap.code === 'missing-physical-source'), false);
        assert.equal(observation.nativeBindings.some(binding => binding.expected.documentId === asset.documentId), false);
        assert.equal(observation.privateNativeStates.some(state => state.documentId === asset.documentId), false);
        assert.equal((await admin.query('SELECT yjs_state_lifecycle FROM collaboration_documents WHERE id=$1', [asset.documentId])).rows[0].yjs_state_lifecycle, 'initialized');
      });
    }
    assert.equal(fetches, 0);
    console.log(`Pristine asset collector PG18: ${cases} genuine Personal/Team/Cookie/Bearer/Create/import/FS families passed; no browser or application host acceptance claimed.`);
  } finally {
    globalThis.fetch = originalFetch;
    try { if (pool) { await pool.end(); assert.equal(pool.totalCount, 0); assert.equal(pool.waitingCount, 0); } }
    finally {
      try { for (const client of clients) { await client.end(); clients.delete(client); } }
      finally {
        try {
          if (created) { await control.query(`DROP SCHEMA "${schema}" CASCADE`); assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true); }
          if (controlConnected) assert.equal(Number((await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1', [applicationName])).rows[0].count), 0);
        } finally {
          try { await control.end(); } finally {
            await rm(dataRoot, { recursive: true, force: true });
            await assert.rejects(stat(dataRoot), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
            for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
          }
        }
      }
    }
    console.log('Pristine asset collector cleanup: own schema removed, zero owned clients, DATA removed.');
  }
}
main().catch(error => {
  console.error('Owned pristine asset collector failed:', { stage, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).filter(line => line.includes('/app/lib/') || line.includes('/scripts/')) : undefined });
  process.exitCode = 1;
});
