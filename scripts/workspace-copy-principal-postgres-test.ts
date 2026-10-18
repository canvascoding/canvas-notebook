import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { WorkspaceCopyPrincipalAccess } from '../app/lib/workspaces/copy-principal';

// Genuine, standalone PG18 auth fixture. Only its private schema and generated
// DATA are changed. No principal, license, invocation or authority DTO is mocked.
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', complete = false;
const domainFailure = (error: unknown): boolean => {
  if (!(error instanceof Error) || error instanceof assert.AssertionError || error instanceof TypeError || error instanceof SyntaxError) return false;
  const code = Reflect.get(error, 'code');
  if (typeof code === 'string' && /^(PRINCIPAL_|COPY_ORIGIN_|AGENT_TOOL_INVOCATION_|SEAT_)|^AGENT_ACTOR_CONTEXT_DENIED$/u.test(code)) return true;
  return error.constructor === Error && (code === undefined || code === 'WORKSPACE_PERMISSION_DENIED') && [
    'The originating agent session is unavailable in this workspace.', 'Workspace not found or inaccessible.',
    'Agent access is no longer available in this workspace.', 'Workspace permission denied',
  ].includes(error.message);
};
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

function copyPrincipalErrorDiagnostic(error: unknown): Record<string, unknown> {
  const seen = new Set<unknown>(); let remaining = 12;
  const redact = (text: string) => text
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[jwt-redacted]')
    .replace(/[a-f0-9]{32,}/giu, '[long-hex-redacted]')
    .replace(/\b(password|secret|token|authorization)\s*[=:]\s*\S+/giu, '$1=[redacted]')
    .slice(0, 600);
  const visit = (value: unknown, depth: number): Record<string, unknown> => {
    if (!(value instanceof Error)) return { name: 'NonError', type: typeof value };
    if (seen.has(value) || depth > 3 || remaining-- <= 0) return { name: 'DiagnosticBound' };
    seen.add(value);
    const code = Object.getOwnPropertyDescriptor(value, 'code')?.value;
    const result: Record<string, unknown> = { name: redact(value.name).slice(0, 80),
      code: typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(code) ? code : null, message: redact(value.message) };
    const cause = Object.getOwnPropertyDescriptor(value, 'cause');
    if (cause && Object.hasOwn(cause, 'value')) result.cause = visit(cause.value, depth + 1);
    const errors = Object.getOwnPropertyDescriptor(value, 'errors');
    if (errors && Object.hasOwn(errors, 'value') && Array.isArray(errors.value)) {
      result.errors = errors.value.slice(0, 6).map(child => visit(child, depth + 1));
    }
    return result;
  };
  return visit(error, 0);
}

async function runWorkspaceCopyPrincipalPostgresFixture(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const schema = `copy_principal_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^copy_principal_[a-f0-9]{32}$/u);
  const applicationName = `copy-principal-${crypto.randomUUID().replaceAll('-', '')}`;
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-copy-principal-'));
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000', application_name: `${applicationName}-admin` });
  const clients = new Set<Client>();
  let created = false, schemaOid: string | undefined, pool: { end: () => Promise<void> } | undefined;
  let groups = 0, fetches = 0, opened = 0, closed = 0, failed = false, primary: unknown;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000, application_name: applicationName,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100` });
    client.on('error', () => undefined); // A genuine PG18 transaction timeout may close this owned client.
    clients.add(client); opened++; await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); if (clients.delete(client)) closed++; };
  const check = async (name: string, operation: () => Promise<void>) => {
    stage = name; await operation(); groups++; console.log(`PASS copy-principal ${groups}: ${name}`);
  };
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    const identity = (await control.query('SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
    assert.equal(identity.owned, true); schemaOid = identity.oid;
    console.log(JSON.stringify({ fixture: 'workspace-copy-principal', schema, schemaOid, applicationName, dataRoot, pid: process.pid }));
    Object.assign(process.env, { DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`, PGAPPNAME: applicationName,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: 'principal-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS', 'NEXT_PHASE']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'copy-principal-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('Network use is forbidden in this owned fixture.'); };
    stage = 'actual full migrations';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const admin = await ownClient();
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      const before = (await admin.query("SELECT current_schema() AS schema,current_setting('search_path') AS path")).rows[0];
      assert.equal(before.schema, schema); assert.deepEqual(before.path.split(',').map((v: string) => v.trim()), [schema, 'pg_catalog']);
      const result = await admin.query(sql, values);
      assert.equal((await admin.query('SELECT current_schema() AS schema')).rows[0].schema, schema); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!, process.env.CANVAS_INSTANCE_ID!)).ok, true);
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 2);
    const now = Date.now();
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@principal.test',1,'admin',0,$1,$1),('member','Member','member@principal.test',1,'user',0,$1,$1),
      ('inactive','Inactive','inactive@principal.test',1,'user',0,$1,$1)`, [now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('principal-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES('principal-org','owner','owner','active',1,100,100),('principal-org','member','member','active',0,100,100),
      ('principal-org','inactive','member','disabled',0,100,100)`);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','principal-org','owner@principal.test','owner','owner','active',100,100,100,100),
      ('member-seat','principal-org','member@principal.test','member','member','active',100,200,100,100),
      ('inactive-seat','principal-org','inactive@principal.test','inactive','member','suspended',100,50,100,100)`);
    await admin.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('principal-org',100,100)");
    const { createPostgresWorkspaceForActor, upsertPostgresWorkspaceMemberForActor, readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const actor = (userId = 'member') => resolveWorkspaceActor({ id: userId, role: userId === 'owner' ? 'admin' : 'user', email: `${userId}@principal.test` });
    const sourceOwner = await createPostgresWorkspaceForActor(actor('owner'), { type: 'team', name: 'Copy principal read source' });
    const destinationOwner = await createPostgresWorkspaceForActor(actor('owner'), { type: 'team', name: 'Copy principal write destination' });
    await upsertPostgresWorkspaceMemberForActor(actor('owner'), sourceOwner.workspaceId, { userId: 'member', canRead: true, canWrite: false, canManage: false });
    await upsertPostgresWorkspaceMemberForActor(actor('owner'), destinationOwner.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    const rawConnection = (client: Client): SqlConnection => ({
      get: async (sql, values) => (await client.query(sql, values)).rows[0], all: async (sql, values) => (await client.query(sql, values)).rows,
      run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }), close: () => assert.fail('Caller connection was closed.'),
    });
    const workspace = async (id: string, userId = 'member') => {
      const value = await readPostgresWorkspaceForActorOnConnection(rawConnection(admin), actor(userId), id); assert(value); return value;
    };
    const source = await workspace(sourceOwner.workspaceId), destination = await workspace(destinationOwner.workspaceId);
    assert.equal(source.permissions.canRead, true); assert.equal(source.permissions.canWrite, false); assert.equal(destination.permissions.canWrite, true);
    const tokens = new Map<string, string>();
    for (const userId of ['owner', 'member']) {
      const token = crypto.randomBytes(32).toString('hex'); tokens.set(userId, token);
      await admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
        [`session-${userId}`, token, userId, now + 3600000, now]);
    }
    await admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
      ['original-member-session', crypto.randomBytes(32).toString('hex'), 'member', now - 1000, now - 7200000]);
    const request = async (cookie = false, userId = 'member') => {
      const token = tokens.get(userId); assert(token);
      const headers = new Headers({ 'x-canvas-workspace-id': source.workspaceId });
      if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', token, process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization', `Bearer ${token}`);
      return new NextRequest('http://localhost/api/files/copy', { method: 'POST', headers });
    };
    const { auth } = await import('../app/lib/auth');
    const { captureWorkspaceOperationCopyOrigin, captureWorkspaceOperationCopyMcpOrigin } =
      await import('../app/lib/files/workspace-operation-copy-origin');
    const { withWorkspaceCopyRequestOnConnection: memberCopy, withWorkspaceCopyAgentOnConnection: agentCopy } = await import('../app/lib/workspaces/copy-principal');
    const memberOrigin = (a = source, b = destination) => captureWorkspaceOperationCopyOrigin({
      actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'original-member-session' }, sourceWorkspace: a, destinationWorkspace: b,
    });
    await admin.query('CREATE TABLE copy_principal_writes(id text PRIMARY KEY,backend integer NOT NULL,xid text NOT NULL)');
    const transaction = async <T>(operation: (database: SqlConnection, client: Client, sql: string[], xid: string) => Promise<T>,
      options: { commit?: boolean; firstQuery?: () => Promise<void>; begin?: string } = {}) => {
      const client = await ownClient(), sql: string[] = []; let ended = false, first = true;
      try {
        await client.query(options.begin ?? 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        const identity = (await client.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
        const query = async (statement: string, values?: unknown[]) => {
          assert(!/^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/iu.test(statement), 'Copy principal must not control caller B.');
          sql.push(statement); if (first) { first = false; await options.firstQuery?.(); } return client.query(statement, values);
        };
        const database: SqlConnection = { get: async (s, v) => (await query(s, v)).rows[0], all: async (s, v) => (await query(s, v)).rows,
          run: async (s, v) => ({ changes: (await query(s, v)).rowCount ?? 0 }), close: () => assert.fail('Copy principal closed caller B.') };
        const value = await operation(database, client, sql, identity.xid);
        const after = (await client.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0]; assert.deepEqual(after, identity);
        await client.query(options.commit ? 'COMMIT' : 'ROLLBACK'); ended = true; return value;
      } finally { if (!ended) await client.query('ROLLBACK').catch(() => undefined); await endClient(client); }
    };
    const write = async (database: SqlConnection, id: string, xid: string) => {
      await database.run('INSERT INTO copy_principal_writes SELECT $1,pg_backend_pid(),pg_current_xact_id()::text', [id]);
      const row = await database.get('SELECT xid,xmin::text AS xmin FROM copy_principal_writes WHERE id=$1', [id]) as { xid: string; xmin: string };
      assert.equal(row.xid, xid); assert.equal(row.xmin, (BigInt(xid) % BigInt('4294967296')).toString());
    };
    const absent = async (id: string) => assert.equal((await admin.query('SELECT count(*)::integer AS count FROM copy_principal_writes WHERE id=$1', [id])).rows[0].count, 0);
    const phases = (sql: string[]) => sql.filter(s => /^SET LOCAL statement_timeout=/u.test(s)).length;
    await check('MCP history cannot borrow a Web or PI principal before any SQL or writer runs', async () => {
      // Historical DTO only: this is deliberately not an OAuth authorization test.
      const original = captureWorkspaceOperationCopyMcpOrigin({ userId: 'member', clientId: 'copy-fixture-client',
        sessionId: 'original-mcp-session', sourceWorkspace: source, destinationWorkspace: source });
      const before = JSON.stringify(original), actual = await request(); let calls = 0;
      await transaction(async (database, _client, sql) => {
        for (const apply of [
          () => memberCopy(database, actual, original, async () => { calls++; }),
          () => agentCopy(database, original, async () => { calls++; }),
        ]) {
          await assert.rejects(apply(), error => error instanceof Error && Reflect.get(error, 'code') === 'COPY_ORIGIN_CHANGED');
        }
        assert.equal(calls, 0); assert.deepEqual(sql, []);
      });
      assert.equal(JSON.stringify(original), before);
      assert.equal((await admin.query('SELECT count(*)::integer AS count FROM copy_principal_writes')).rows[0].count, 0);
    });
    await check('real Cookie and Bearer allow a read-only source and a different writable destination on one B', async () => {
      for (const cookie of [false, true]) {
        const actual = await request(cookie), original = memberOrigin(), proof = JSON.stringify(original), id = `member-${cookie}`;
        assert.equal((await auth.api.getSession({ headers: actual.headers }))?.session.id, 'session-member');
        await transaction(async (database, _client, sql, xid) => {
          const result = await memberCopy(database, actual, original, async access => {
            assert.equal(Object.isFrozen(access), true); assert.equal(Object.isFrozen(access.currentActor), true);
            assert.equal(Object.isFrozen(access.sourceWorkspace), true); assert.equal(Object.isFrozen(access.destinationWorkspace), true);
            assert.equal('assertCurrent' in access, false); assert.equal(access.sourceWorkspace.permissions.canWrite, false);
            assert.equal(access.sourceWorkspace.workspaceId, source.workspaceId); assert.equal(access.destinationWorkspace.workspaceId, destination.workspaceId);
            assert.equal(access.destinationWorkspace.permissions.canWrite, true);
            assert.deepEqual(access.currentActor, { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' });
            assert.deepEqual(access.originalOrigin, original); assert.equal(access.originalOrigin.actor.sessionId, 'original-member-session');
            await write(database, id, xid); await absent(id); return 'caller-value';
          });
          assert.equal(result, 'caller-value'); assert.equal(phases(sql), 3); assert.equal(JSON.stringify(original), proof);
        }, { commit: true });
        assert.equal((await admin.query('SELECT count(*)::integer AS count FROM copy_principal_writes WHERE id=$1', [id])).rows[0].count, 1);
      }
    });
    await check('same workspace uses one actual WRITE phase and rejects a read-only same-workspace source', async () => {
      await transaction(async (database, _client, sql, xid) => {
        await memberCopy(database, await request(), memberOrigin(destination, destination), async access => {
          assert.equal(access.sourceWorkspace, access.destinationWorkspace); await write(database, 'same-workspace', xid);
        }); assert.equal(phases(sql), 1);
      }, { commit: true });
      let calls = 0;
      await assert.rejects(transaction(database => memberCopy(database, new NextRequest('http://localhost/api/files/copy', {
        headers: { authorization: `Bearer ${tokens.get('member')}` },
      }), memberOrigin(source, source), async () => { calls++; })), domainFailure); assert.equal(calls, 0);
    });
    await check('current actor and complete original workspace scopes cannot be substituted', async () => {
      let calls = 0;
      await assert.rejects(transaction(async database => memberCopy(database, await request(false, 'owner'), memberOrigin(), async () => { calls++; })), domainFailure);
      for (const key of ['sourceScope', 'destinationScope'] as const) {
        const original = memberOrigin(), changed = { ...original, [key]: { ...original[key], rootPath: `${original[key].rootPath}/other` } };
        await assert.rejects(transaction(async database => memberCopy(database, await request(), changed, async () => { calls++; })), domainFailure);
      }
      assert.equal(calls, 0);
    });
    await check('source READ or destination WRITE revoked after capture cannot enter the writer', async () => {
      for (const [workspaceId, field] of [[source.workspaceId, 'can_read'], [destination.workspaceId, 'can_write']] as const) {
        let calls = 0;
        try {
          await assert.rejects(transaction(async database => memberCopy(database, await request(), memberOrigin(), async () => { calls++; }), {
            firstQuery: async () => { await admin.query(`UPDATE canvas_workspace_members SET ${field}=0 WHERE workspace_id=$1 AND user_id='member'`, [workspaceId]); },
          }), domainFailure); assert.equal(calls, 0);
        } finally { await admin.query(`UPDATE canvas_workspace_members SET ${field}=1 WHERE workspace_id=$1 AND user_id='member'`, [workspaceId]); }
      }
    });
    await check('source, destination and current-session self-revocations reject and roll back the actual write', async () => {
      const mutations = [
        { sql: "UPDATE canvas_workspace_members SET can_read=0 WHERE workspace_id=$1 AND user_id='member'", values: [source.workspaceId] },
        { sql: "UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", values: [destination.workspaceId] },
        { sql: "UPDATE session SET expires_at=1 WHERE id='session-member'", values: [] },
      ];
      for (const [index, mutation] of mutations.entries()) {
        const id = `self-revoke-${index}`; let calls = 0;
        await assert.rejects(transaction(async (database, _client, _sql, xid) => memberCopy(database, await request(), memberOrigin(), async () => {
          calls++; await write(database, id, xid); await database.run(mutation.sql, mutation.values);
        })), domainFailure); assert.equal(calls, 1); await absent(id);
      }
      assert.equal((await workspace(source.workspaceId)).permissions.canRead, true);
      assert.equal((await workspace(destination.workspaceId)).permissions.canWrite, true);
      assert(Number((await admin.query("SELECT expires_at FROM session WHERE id='session-member'")).rows[0].expires_at) > Date.now());
    });
    await check('source locks survive its completed phase and both existing and missing ACL predicates block a peer', async () => {
      await transaction(async database => memberCopy(database, await request(), memberOrigin(), async () => {
        for (const mutation of [
          { sql: "UPDATE canvas_workspace_members SET can_read=0 WHERE workspace_id=$1 AND user_id='member'", values: [source.workspaceId] },
          { sql: "UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", values: [destination.workspaceId] },
          { sql: "INSERT INTO canvas_workspace_members(workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES($1,'inactive','member','active',1,1,0,100,100)", values: [source.workspaceId] },
        ]) {
          const peer = await ownClient();
          try {
            await peer.query('BEGIN'); await assert.rejects(peer.query(mutation.sql, mutation.values), { code: '55P03' });
          } finally { await peer.query('ROLLBACK'); await endClient(peer); }
        }
      }));
    });
    await check('callback failure remains primary and all its domain writes roll back', async () => {
      const marker = new Error('Deliberate Copy caller failure'); let calls = 0;
      await assert.rejects(transaction(async (database, _client, _sql, xid) => memberCopy(database, await request(), memberOrigin(), async () => {
        calls++; await write(database, 'callback-failure', xid); throw marker;
      })), error => error === marker); assert.equal(calls, 1); await absent('callback-failure');
    });
    await check('actual request and original inputs are detached before the first await', async () => {
      await transaction(async (database, _client, _sql, xid) => {
        const actual = await request(), original = structuredClone(memberOrigin()), expected = structuredClone(original);
        const pending = memberCopy(database, actual, original, async access => {
          assert.deepEqual(access.originalOrigin, expected); assert.equal(access.currentActor.userId, 'member'); await write(database, 'detached', xid);
        });
        actual.headers.set('authorization', 'Bearer forged'); actual.headers.set('x-canvas-workspace-id', 'forged');
        Reflect.set(original.actor, 'userId', 'owner'); Reflect.set(original.actor, 'sessionId', 'forged');
        Reflect.set(original.sourceScope, 'rootPath', '/forged'); Reflect.set(original.destinationScope, 'workspaceId', 'forged');
        await pending;
      }, { commit: true });
    });
    await check('same-B transaction and literal search-path drift fail closed', async () => {
      for (const drift of [`SET LOCAL search_path=${schema},pg_catalog,pg_temp`, 'ROLLBACK; BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE']) {
        let calls = 0;
        await assert.rejects(transaction(async (database, client) => memberCopy(database, await request(), memberOrigin(), async () => {
          calls++; await client.query(drift);
        })), domainFailure); assert.equal(calls, 1);
      }
    });
    await check('expired current credentials and RC read-only B cannot borrow original authority', async () => {
      let calls = 0;
      try {
        await admin.query("UPDATE session SET expires_at=1 WHERE id='session-member'");
        await assert.rejects(transaction(async database => memberCopy(database, await request(), memberOrigin(), async () => { calls++; })), domainFailure);
      } finally {
        // BetterAuth really deletes an expired session during getSession. A
        // plain UPDATE cannot restore that row for the next genuine request.
        await admin.query(`INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at)
          VALUES('session-member',$1,'member',$2,$3,$3)
          ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at`,
        [tokens.get('member'), now + 3600000, now]);
        assert.equal((await admin.query("SELECT count(*)::integer AS count FROM session WHERE id='session-member' AND expires_at>$1", [Date.now()])).rows[0].count, 1);
      }
      const client = await ownClient();
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
        await assert.rejects(memberCopy(rawConnection(client), await request(), memberOrigin(), async () => { calls++; }), domainFailure);
      } finally { await client.query('ROLLBACK'); await endClient(client); }
      assert.equal(calls, 0);
    });

    // This is the actual native DB/journal foundation, not a physical file
    // publication or link-owner test. Its one journal step records only this
    // native DB probe; the clone receipt remains native_committed.
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { readNativeWorkspaceRecoveryRecords } = await import('../app/lib/collaboration/workspace-native-recovery');
    const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
    const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { persistNativeWorkspaceCopiesOnConnection } = await import('../app/lib/collaboration/native-copy-persistence');
    const { prepareWorkspaceOperationOnConnection, beginWorkspaceOperationStepOnConnection,
      finishWorkspaceOperationStepOnConnection, completeWorkspaceOperationOnConnection,
      readWorkspaceOperationJournalOnConnection } = await import('../app/lib/files/workspace-operation-journal');
    const sourceDocumentId = `principal-source-${crypto.randomUUID()}`, sourceLineageId = `principal-lineage-${crypto.randomUUID()}`;
    const sourcePath = 'source-native.md', nativeDocument = new Y.Doc();
    try {
      nativeDocument.getText('content').insert(0, 'Genuine Copy principal\t😀\r\n');
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'team','principal-org',$3,'active',1)`, [sourceLineageId, source.workspaceId, sourcePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'team','principal-org',$4,'yjs',0,'initialized','active',1,1)`,
      [sourceDocumentId, sourceLineageId, source.workspaceId, sourcePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,
        schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status)
        VALUES($1,$2,'principal-org',$3,'plain_text',1,1,$4,$5,3,1,0,'crlf',1,0,'active')`,
      [sourceDocumentId, source.workspaceId, sourcePath, Buffer.from(Y.encodeStateAsUpdate(nativeDocument)), Buffer.from(Y.encodeStateVector(nativeDocument))]);
    } finally { nativeDocument.destroy(); }
    const nativeRecords = await readNativeWorkspaceRecoveryRecords(rawConnection(admin), source, sourcePath);
    assert.equal(nativeRecords.length, 1); const originalNative = nativeRecords[0];
    const originalSnapshot = authoritativeNativeCollaborationSnapshot(originalNative.state);
    const actualNativeCopy = async (database: SqlConnection, current: WorkspaceCopyPrincipalAccess, operationId: string, targetPath: string, xid: string) => {
      assert.equal(current.sourceWorkspace.permissions.canWrite, false);
      const planId = crypto.createHash('sha256').update(JSON.stringify({ operationId, sourcePath, targetPath, probe: 'native-db-only' })).digest('hex');
      const prepared = await prepareWorkspaceOperationOnConnection(database, { operationId, planId,
        actor: { type: current.originalOrigin.actor.type, id: current.originalOrigin.actor.userId },
        request: { kind: 'copy', selections: [{ sourcePath, destinationPath: targetPath }], origin: current.originalOrigin },
        sourceWorkspaceId: current.sourceWorkspace.workspaceId, destinationWorkspaceId: current.destinationWorkspace.workspaceId, expectedStepCount: 1 });
      assert.equal(JSON.parse(prepared.requestJson).origin.actor.sessionId, 'original-member-session');
      const step = { operationId, stepKey: 'native-db-probe', phase: 'path' as const,
        beforeFence: `native-source:${originalSnapshot.version.stateProof}`, afterFence: `native-db-target:${targetPath}` };
      await beginWorkspaceOperationStepOnConnection(database, step);
      const receipt = await persistNativeWorkspaceCopiesOnConnection(database, { operationId,
        actorUserId: current.originalOrigin.actor.userId, actorSessionId: current.originalOrigin.actor.sessionId,
        kind: 'native_clone', sourceWorkspace: current.sourceWorkspace, targetWorkspace: current.destinationWorkspace,
        targetScopes: [targetPath], copies: [{ source: originalNative, targetPath }], expectedTargets: [], publicationFingerprint: planId });
      assert.equal(receipt.publicationStatus, 'native_committed'); assert.equal(receipt.documents.length, 1);
      const cloned = receipt.documents[0].clone;
      assert.notEqual(cloned.documentId, originalNative.state.documentId); assert.notEqual(cloned.lineageId, originalNative.lineageId);
      const state = await loadCollaborationStateOnConnection(database, cloned.documentId); assert(state);
      assert.equal(state.path, targetPath); assert.equal(state.documentSequence, 0); assert.equal(state.lifecycleGeneration, 1);
      assert.equal(state.newlineStyle, 'crlf'); assert.equal(state.hasBom, true);
      assert.deepEqual(authoritativeNativeCollaborationSnapshot(state).content, originalSnapshot.content);
      await finishWorkspaceOperationStepOnConnection(database, { ...step,
        receipt: { kind: 'native-db-only', requestFingerprint: receipt.requestFingerprint, cloneDocumentId: cloned.documentId } });
      assert.equal((await completeWorkspaceOperationOnConnection(database, operationId)).status, 'completed');
      const journal = await readWorkspaceOperationJournalOnConnection(database, operationId); assert(journal);
      assert.equal(journal.steps.length, 1); assert.equal(journal.steps[0].status, 'applied');
      assert.deepEqual(JSON.parse(journal.requestJson).origin, current.originalOrigin);
      const rows = await database.all(`SELECT 'operation' AS kind,xmin::text AS xmin FROM workspace_file_operations WHERE operation_id=$1
        UNION ALL SELECT 'step',xmin::text FROM workspace_file_operation_steps WHERE operation_id=$1
        UNION ALL SELECT 'receipt',xmin::text FROM collaboration_native_copy_receipts WHERE operation_id=$1 AND workspace_id=$2
        UNION ALL SELECT 'document',xmin::text FROM collaboration_documents WHERE id=$3
        UNION ALL SELECT 'state',xmin::text FROM collaboration_yjs_states WHERE document_id=$3
        UNION ALL SELECT 'lineage',xmin::text FROM file_collaboration_lineages WHERE id=$4`,
      [operationId, destination.workspaceId, cloned.documentId, cloned.lineageId]) as Array<{ kind: string; xmin: string }>;
      assert.equal(rows.length, 6); assert(rows.every(row => row.xmin === (BigInt(xid) % BigInt('4294967296')).toString()));
      const ledger = await database.get('SELECT actor_user_id,actor_session_id FROM collaboration_native_copy_receipts WHERE operation_id=$1 AND workspace_id=$2',
        [operationId, destination.workspaceId]) as Record<string, unknown>;
      assert.equal(ledger.actor_user_id, 'member'); assert.equal(ledger.actor_session_id, 'original-member-session');
      assert.equal(current.currentActor.sessionId, 'session-member');
      return cloned;
    };
    await check('genuine cross-workspace READ-WRITE B atomically binds original Journal and fresh native clone to the caller XID', async () => {
      const operationId = crypto.randomUUID(), targetPath = 'copied-native-committed.md';
      const cloned = await transaction(async (database, _client, _sql, xid) => memberCopy(database, await request(), memberOrigin(),
        current => actualNativeCopy(database, current, operationId, targetPath, xid)), { commit: true });
      assert.equal((await admin.query('SELECT status FROM workspace_file_operations WHERE operation_id=$1', [operationId])).rows[0].status, 'completed');
      assert.equal((await admin.query('SELECT publication_status FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0].publication_status, 'native_committed');
      assert.equal((await admin.query('SELECT id FROM collaboration_documents WHERE id=$1', [cloned.documentId])).rows[0].id, cloned.documentId);
    });
    await check('source ACL self-drop after the real Journal and clone writes rolls back operation, steps, native state and receipt together', async () => {
      const operationId = crypto.randomUUID(), targetPath = 'copied-native-rolled-back.md';
      let cloned: Awaited<ReturnType<typeof actualNativeCopy>> | undefined;
      await assert.rejects(transaction(async (database, _client, _sql, xid) => memberCopy(database, await request(), memberOrigin(), async current => {
        cloned = await actualNativeCopy(database, current, operationId, targetPath, xid);
        await database.run("UPDATE canvas_workspace_members SET can_read=0 WHERE workspace_id=$1 AND user_id='member'", [source.workspaceId]);
      })), domainFailure);
      assert(cloned, 'The real native clone must exist inside B before the final source phase rejects.');
      const counts = (await admin.query(`SELECT
        (SELECT count(*) FROM workspace_file_operations WHERE operation_id=$1)::integer AS operations,
        (SELECT count(*) FROM workspace_file_operation_steps WHERE operation_id=$1)::integer AS steps,
        (SELECT count(*) FROM collaboration_native_copy_receipts WHERE operation_id=$1)::integer AS receipts,
        (SELECT count(*) FROM collaboration_documents WHERE id=$2)::integer AS documents,
        (SELECT count(*) FROM collaboration_yjs_states WHERE document_id=$2)::integer AS states,
        (SELECT count(*) FROM file_collaboration_lineages WHERE id=$3)::integer AS lineages`,
      [operationId, cloned.documentId, cloned.lineageId])).rows[0];
      assert.deepEqual(counts, { operations: 0, steps: 0, receipts: 0, documents: 0, states: 0, lineages: 0 });
      assert.equal((await workspace(source.workspaceId)).permissions.canRead, true);
      assert.equal((await admin.query('SELECT count(*)::integer AS count FROM collaboration_documents WHERE id=$1', [sourceDocumentId])).rows[0].count, 1);
    });

    stage = 'genuine PI and agent grants';
    const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
    await admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'System','main','legacy','organization','principal-org','["copy_path"]',100,100),
      ('copy-special','Copy special','special','restricted','organization','principal-org','["copy_path"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [MAIN_AGENT_ID]);
    await admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
      VALUES('copy-special','principal-org','owner','active',1,100,100),('copy-special','principal-org','member','inactive',0,100,100)`);
    await admin.query(`INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,created_at,updated_at)
      VALUES('copy-grant','copy-special','principal-org','workspace',$1,1,100,100)`, [destination.workspaceId]);
    const seedPi = async (sessionId: string, userId: string, agentId: string) => {
      await admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
        workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
        VALUES($1,$2,$3,'fixture','fixture','principal-org',$4,'team','Copy destination',$5,100,100)`,
      [sessionId, userId, agentId, destination.workspaceId, destination.rootRelativePath]);
    };
    await seedPi('pi-current-special', 'member', 'copy-special'); await seedPi('pi-original-special', 'member', 'copy-special');
    await seedPi('pi-current-main', 'owner', MAIN_AGENT_ID);
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
    const agentContext = async (special = true): Promise<AgentExecutionContext> => {
      const userId = special ? 'member' : 'owner', selected = await workspace(destination.workspaceId, userId);
      return { userId, sessionId: special ? 'pi-current-special' : 'pi-current-main', agentId: special ? 'copy-special' : null,
        agentTurnId: 'copy-fixture-turn', workspaceId: selected.workspaceId, workspaceType: selected.workspaceType,
        workspaceName: selected.displayName ?? null, organizationId: selected.organizationId ?? null, customerId: selected.customerId ?? null,
        projectId: selected.projectId ?? null, workspaceRoot: selected.rootPath, workspaceRootRelativePath: selected.rootRelativePath ?? null,
        canWrite: false, canDelete: false, canShare: false, legacy: false };
    };
    const agentOrigin = async (special = true): Promise<WorkspaceOperationCopyOrigin> => {
      const selected = await workspace(destination.workspaceId, special ? 'member' : 'owner');
      return captureWorkspaceOperationCopyOrigin({ actor: { type: 'agent', userId: special ? 'member' : 'owner',
        actorId: special ? 'copy-special' : MAIN_AGENT_ID, sessionId: special ? 'pi-original-special' : 'pi-original-main' },
      sourceWorkspace: selected, destinationWorkspace: selected });
    };
    const invoke = async <T>(operation: () => Promise<T>, options: { special?: boolean; abort?: AbortController } = {}) => {
      const context = await agentContext(options.special ?? true);
      return runWithAgentExecutionContext(context, () => withAgentToolInvocation(context,
        { toolName: 'copy_path', toolCallId: 'copy-fixture-call', signal: options.abort?.signal }, operation));
    };
    await check('genuine restricted and default PI copy_path invocations keep original and current session distinct', async () => {
      for (const special of [true, false]) {
        const original = await agentOrigin(special), id = `agent-${special}`;
        await invoke(() => transaction(async (database, _client, sql, xid) => {
          await agentCopy(database, original, async access => {
            assert.equal(access.currentActor.type, 'agent'); assert.equal(access.currentActor.actorId, special ? 'copy-special' : MAIN_AGENT_ID);
            assert.equal(access.currentActor.sessionId, special ? 'pi-current-special' : 'pi-current-main');
            assert.deepEqual(access.originalOrigin, original); assert.notEqual(access.originalOrigin.actor.sessionId, access.currentActor.sessionId);
            assert.equal(access.sourceWorkspace.workspaceId, destination.workspaceId); assert.equal(access.destinationWorkspace.permissions.canWrite, true);
            assert.equal('assertCurrent' in access, false); await write(database, id, xid);
          }); assert.equal(phases(sql), 1);
        }, { commit: true }), { special });
      }
    });
    await check('ordinary agent ALS, cross-workspace copy and another original agent cannot mint Copy authority', async () => {
      const context = await agentContext(), original = await agentOrigin(); let calls = 0;
      await assert.rejects(runWithAgentExecutionContext(context, () => transaction(database => agentCopy(database, original, async () => { calls++; }))), domainFailure);
      const cross = captureWorkspaceOperationCopyOrigin({ actor: original.actor, sourceWorkspace: source, destinationWorkspace: destination });
      await assert.rejects(invoke(() => transaction(database => agentCopy(database, cross, async () => { calls++; }))), domainFailure);
      await assert.rejects(invoke(() => transaction(database => agentCopy(database,
        { ...original, actor: { ...original.actor, actorId: MAIN_AGENT_ID } }, async () => { calls++; }))), domainFailure);
      assert.equal(calls, 0);
    });
    await check('actual restricted-agent grant revoked after capture rejects before the writer', async () => {
      const original = await agentOrigin(); let calls = 0;
      try {
        await assert.rejects(invoke(() => transaction(database => agentCopy(database, original, async () => { calls++; }), {
          firstQuery: async () => { await admin.query("UPDATE agent_grants SET can_use=0 WHERE id='copy-grant'"); },
        })), domainFailure); assert.equal(calls, 0);
      } finally { await admin.query("UPDATE agent_grants SET can_use=1 WHERE id='copy-grant'"); }
    });
    await check('real PI archive and invocation abort inside B reject and roll back actual writes', async () => {
      for (const mode of ['archive', 'abort'] as const) {
        const original = await agentOrigin(), abort = new AbortController(), id = `agent-${mode}`; let calls = 0;
        await assert.rejects(invoke(() => transaction((database, _client, _sql, xid) => agentCopy(database, original, async () => {
          calls++; await write(database, id, xid);
          if (mode === 'archive') await database.run("UPDATE pi_sessions SET archived_at=100 WHERE session_id='pi-current-special'");
          else abort.abort();
        })), { abort }), domainFailure); assert.equal(calls, 1); await absent(id);
      }
      assert.equal((await admin.query("SELECT archived_at FROM pi_sessions WHERE session_id='pi-current-special'")).rows[0].archived_at, null);
    });
    assert.equal(groups, 17); assert.equal(fetches, 0);
  } catch (error) { failed = true; primary = error; }
  finally {
    globalThis.fetch = originalFetch;
    const cleanup: unknown[] = [];
    try { await pool?.end(); } catch (error) { cleanup.push(error); }
    for (const client of [...clients]) try { await endClient(client); } catch (error) { cleanup.push(error); }
    try {
      assert.equal((await control.query('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1', [applicationName])).rows[0].count, 0);
      if (created) {
        const identity = (await control.query('SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
        assert.equal(identity?.oid, schemaOid); assert.equal(identity?.owned, true);
        await control.query(`DROP SCHEMA "${schema}" CASCADE`);
        assert.equal((await control.query('SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname=$1 OR oid::text=$2', [schema, schemaOid])).rows[0].count, 0);
      }
    } catch (error) { cleanup.push(error); }
    try { await control.end(); } catch (error) { cleanup.push(error); }
    try { await rm(dataRoot, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Owned Copy principal cleanup failed.');
    if (failed) throw primary;
  }
  assert.equal(opened, closed);
  console.log(JSON.stringify({ test: 'workspace-copy-principal-postgres-test', groups, schema, schemaOid,
    applicationName, schemaRemoved: true, poolClosed: true, clientsClosed: true, opened, closed, fetches, dataRemoved: true }));
  complete = true;
}

runWorkspaceCopyPrincipalPostgresFixture().catch(error => {
  console.error('Owned Copy principal fixture failed:', JSON.stringify({ stage, diagnostic: copyPrincipalErrorDiagnostic(error) }));
  process.exitCode = 1;
});
