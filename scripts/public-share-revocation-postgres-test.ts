import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import * as Y from 'yjs';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', passed = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
type Row = Record<string, unknown>;

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `public_revoke_${crypto.randomUUID().replaceAll('-', '')}`, nonce = crypto.randomUUID();
  assert.match(schema, /^public_revoke_[a-f0-9]{32}$/u);
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-public-share-revoke-'))), rootIdentity = await stat(dataRoot);
  assert.equal(rootIdentity.uid, process.getuid!()); assert.equal(rootIdentity.mode & 0o077, 0);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>();
  let created = false, schemaOid = 0, schemaRemoved = false, dataRemoved = false, fetches = 0;
  let pool: { end: () => Promise<void> } | undefined, primaryFailure: unknown;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=public-revoke-fixture` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const check = async (name: string, operation: () => Promise<void>) => {
    stage = name; await operation(); passed++; console.log('Public revoke case passed:', JSON.stringify({ passed, name }));
  };
  const isOwnClient = (client: Client) => {
    const parameters: unknown = Reflect.get(client, 'connectionParameters');
    return !!parameters && typeof parameters === 'object'
      && String(Reflect.get(parameters, 'options') ?? '').includes(`search_path=${schema},pg_catalog`);
  };
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${nonce}'`);
    schemaOid = Number((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].oid);
    Object.assign(process.env, { DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`, CANVAS_DATABASE_PROVIDER: 'postgres',
      DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost',
      BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
      CANVAS_ORGANIZATION_ID: 'revoke-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'NEXT_PHASE', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'revoke-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true,
      organizationId: 'revoke-org', capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true }, seatLimit: 3, quotas: { users: 3 },
      entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('No network is permitted in the owned revocation fixture.'); };
    const admin = await ownClient();
    const own = async () => {
      const row = (await admin.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path,
        n.oid,obj_description(n.oid,'pg_namespace') AS nonce,n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner
        FROM pg_namespace n WHERE n.nspname=$1`, [schema])).rows[0];
      assert(row); assert.equal(row.schema, schema); assert.equal(Number(row.oid), schemaOid); assert.equal(row.nonce, nonce); assert.equal(row.owner, true);
      assert.deepEqual(row.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']);
    };
    stage = 'original full migrations in owned schema';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      await own(); const result = await admin.query(sql, values); await own(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const database = await import('../app/lib/db');
    const runtime = database.getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 3);
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at) VALUES
      ('owner','Owner','owner@revoke.test',1,'admin',0,100,100),('member','Member','member@revoke.test',1,'user',0,100,100),
      ('other','Other','other@revoke.test',1,'user',0,100,100)`);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('revoke-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_create_public_links,created_at,updated_at)
      VALUES('revoke-org','owner','owner','active',1,1,100,100),('revoke-org','member','member','active',1,1,100,100),
      ('revoke-org','other','member','active',0,0,100,100)`);
    for (const userId of ['owner', 'member', 'other']) await admin.query(`INSERT INTO team_memberships
      (id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES($1,'revoke-org',$2,$3,$4,'active',100,100,100,100)`, [`seat-${userId}`, `${userId}@revoke.test`, userId, userId === 'owner' ? 'owner' : 'member']);
    await admin.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('revoke-org',100,100)");
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('revoke-space','revoke-org','organization',NULL,'Revoke','organizations/revoke-org/shared','active',100,100),
      ('foreign-space','revoke-org','personal','other','Other','users/other/workspace','active',100,100)`);
    const tokens: Record<string, string> = {};
    for (const userId of ['owner', 'member', 'other']) {
      const token = crypto.randomBytes(32).toString('hex'); tokens[userId] = token;
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,100,100)`, [`session-${userId}`, token, userId, Date.now() + 3600000]);
    }
    await admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES('public-agent','Public','special','restricted','organization','revoke-org','["public_share_file"]',100,100)`);
    await admin.query(`INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,created_at,updated_at)
      VALUES('public-grant','public-agent','revoke-org','workspace','revoke-space',1,100,100)`);
    await admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,
      workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES('public-pi','member','public-agent','fixture','fixture','revoke-org','revoke-space','organization','Revoke','organizations/revoke-org/shared',100,100)`);
    await admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,enabled_tools_json,created_at,updated_at)
      VALUES('bradley','Bradley','main','legacy','system','["__none__"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json='["__none__"]'`);
    await admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,
      workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES('public-main-pi','member','bradley','fixture','fixture','revoke-org','revoke-space','organization','Revoke','organizations/revoke-org/shared',100,100)`);
    const { auth } = await import('../app/lib/auth');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { withAgentToolInvocation, AgentToolInvocationError } = await import('../app/lib/pi/agent-tool-invocation');
    const { WorkspaceRequestPrincipalError } = await import('../app/lib/workspaces/request-principal');
    const { SeatLimitGuardError } = await import('../app/lib/license/seat-limit');
    const { AgentActorContextError } = await import('../app/lib/agents/actor-context');
    const { WorkspaceSideEffectWriterFenceError } = await import('../app/lib/files/workspace-side-effect-writer-fence');
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const writer = await import('../app/lib/public-sharing/writer');
    const { revokePublicShareForRequest, revokePublicShareForAgent } = writer;
    const { PublicShareToolPolicyError } = await import('../app/lib/public-sharing/tool-policy');
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { writePiRuntimeConfig } = await import('../app/lib/agents/storage');
    const configure = async (enabledTools: string[]) => writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG,
      activeProvider: 'openrouter', runtimeMigrations: { skillToolsDefaultEnabled: true },
      providers: { ...DEFAULT_PI_CONFIG.providers,
        openrouter: { ...DEFAULT_PI_CONFIG.providers.openrouter, enabledTools },
        anthropic: { ...DEFAULT_PI_CONFIG.providers.anthropic, enabledTools: ['__none__'] } },
    });
    await configure(['public_share_file']);
    const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { collaborationAdmissionActionDigest, collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const admission = createCollaborationAdmissionService({ openConnection: database.openDb });
    await admin.query('CREATE SEQUENCE fixture_public_write_attempts');
    await admin.query(`CREATE FUNCTION fixture_count_public_writes() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('fixture_public_write_attempts'); RETURN NULL; END $$`);
    await admin.query(`CREATE TRIGGER fixture_public_write_attempt BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON public_file_shares FOR EACH STATEMENT EXECUTE FUNCTION fixture_count_public_writes()`);
    const writeProof = async () => (await admin.query('SELECT last_value::text AS value,is_called FROM fixture_public_write_attempts')).rows[0];
    const request = async (userId = 'owner', cookie = false, shareId = 'fixture') => {
      const headers = new Headers({ 'x-canvas-workspace-id': 'revoke-space' });
      if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens[userId], process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization', `Bearer ${tokens[userId]}`);
      return new NextRequest(`http://localhost/api/security/public-shares/${shareId}`, { method: 'DELETE', headers });
    };
    for (const userId of ['owner', 'member', 'other']) assert.equal((await auth.api.getSession({ headers: (await request(userId)).headers }))?.session.id, `session-${userId}`);
    const workspace = await readPostgresWorkspaceForActor({ userId: 'member', role: 'member' }, 'revoke-space'); assert(workspace);
    const origin = (agentId = 'public-agent'): AgentExecutionContext => ({ userId: 'member', sessionId: agentId === 'bradley' ? 'public-main-pi' : 'public-pi', agentId,
      agentTurnId: 'public-revoke-turn', workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType,
      workspaceName: workspace.displayName ?? null, organizationId: workspace.organizationId ?? null,
      customerId: workspace.customerId ?? null, projectId: workspace.projectId ?? null, workspaceRoot: workspace.rootPath,
      workspaceRootRelativePath: workspace.rootRelativePath ?? null, legacy: false, canWrite: false, canDelete: false, canShare: false });
    const agent = <T>(operation: () => Promise<T>, signal?: AbortSignal, toolName = 'public_share_file', agentId = 'public-agent') => {
      const current = origin(agentId); return runWithAgentExecutionContext(current, () => withAgentToolInvocation(current,
        { toolName, toolCallId: `revoke-${crypto.randomUUID()}`, signal }, operation));
    };
    const row = async (id: string) => (await admin.query('SELECT to_jsonb(s) AS row FROM public_file_shares s WHERE id=$1', [id])).rows[0]?.row as Row;
    const seed = async (input: { status?: string; owner?: string; bound?: boolean; workspaceId?: string | null } = {}) => {
      const id = crypto.randomUUID(), filePath = `missing-${id}.md`, documentId = `native-${id}`, lineageId = `lineage-${id}`;
      await admin.query(`INSERT INTO public_file_shares(id,token,token_hash,token_preview,workspace_id,organization_id,workspace_type,workspace_root_relative_path,
        workspace_path,document_id,lineage_id,lifecycle_generation,file_name,file_identity,mime_type,size_bytes,status,created_by_user_id,
        source,reason,created_at,updated_at,access_count,last_accessed_at,password_enabled,password_hash)
        VALUES($1,$2,$3,'preview',$4,'revoke-org','organization','organizations/revoke-org/shared',$5,$6,$7,$8,$5,
          'historical-physical-identity','text/markdown',123,$9,$10,'ui','fixture reason',100,100,7,150,1,'fixture-password-hash')`,
      [id, crypto.randomBytes(32).toString('base64url'), crypto.randomBytes(32).toString('hex'),
        Object.hasOwn(input, 'workspaceId') ? input.workspaceId : 'revoke-space', filePath,
        input.bound ? documentId : null, input.bound ? lineageId : null, input.bound ? 5 : null, input.status ?? 'active', input.owner ?? 'member']);
      return { id, filePath, documentId, lineageId };
    };
    const web = async (id: string, userId = 'owner', cookie = false) => revokePublicShareForRequest(await request(userId, cookie, id), { id, workspaceId: 'revoke-space' });
    const via = (surface: 'web' | 'agent', id: string) => surface === 'web' ? web(id) : agent(() => revokePublicShareForAgent({ id, workspaceId: 'revoke-space' }));
    const domainFailure = (error: unknown) => {
      if (error instanceof WorkspaceRequestPrincipalError || error instanceof AgentToolInvocationError
        || error instanceof SeatLimitGuardError || error instanceof AgentActorContextError || error instanceof WorkspaceSideEffectWriterFenceError
        || error instanceof PublicShareToolPolicyError) return true;
      return error instanceof writer.PublicShareWriterError;
    };
    const preserves = (before: Row, after: Row) => {
      for (const key of Object.keys(before).filter(key => !['status', 'policy_revision', 'revoked_at', 'revoked_reason', 'updated_at'].includes(key))) {
        assert.deepEqual(after[key], before[key], `Revocation must preserve ${key}.`);
      }
    };
    const rejectedUnchanged = async (id: string, operation: () => Promise<unknown>, predicate = domainFailure) => {
      const before = await row(id), writes = await writeProof();
      await assert.rejects(operation(), predicate); assert.deepEqual(await row(id), before); assert.deepEqual(await writeProof(), writes);
    };
    for (const cookie of [false, true]) await check(`genuine Web ${cookie ? 'Cookie' : 'Bearer'} revokes missing physical origin`, async () => {
      const target = await seed(), before = await row(target.id);
      await assert.rejects(stat(path.join(workspace.rootPath, target.filePath)), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
      const result = await web(target.id, 'member', cookie); assert(result); assert.equal(result.row.id, target.id);
      assert.equal(result.workspace.workspaceId, 'revoke-space'); assert(result.row.revokedAt instanceof Date);
      const after = await row(target.id); assert.equal(after.status, 'revoked'); assert.equal(after.policy_revision, 2); assert.equal(after.revoked_reason, 'manual'); preserves(before, after);
    });
    await check('legacy dispatcher cannot revoke from untrusted userId and admin booleans without genuine request or invocation', async () => {
      const { revokePublicFileShare } = await import('../app/lib/public-sharing/public-file-shares');
      const target = await seed(), before = await row(target.id), writes = await writeProof();
      let resolved = false;
      try {
        await rejectedUnchanged(target.id, () => revokePublicFileShare({ id: target.id, userId: 'owner', isAdmin: true,
          workspace, workspaceId: 'revoke-space' }).then(value => { resolved = true; return value; }),
        error => error instanceof AgentToolInvocationError && error.code === 'AGENT_TOOL_INVOCATION_REQUIRED');
      } finally {
        const current = await row(target.id), attempted = await writeProof();
        console.log('Public dispatcher forgery actual SQL witness:', JSON.stringify({ resolved,
          rowChanged: !isDeepStrictEqual(before, current), attemptedWrite: attempted.value !== writes.value || attempted.is_called !== writes.is_called }));
      }
    });
    for (const surface of ['web', 'agent'] as const) for (const status of ['active', 'stale', 'missing', 'expired'] as const) {
      await check(`${surface} monotone revoke preserves all historical and native pins: ${status}`, async () => {
        const target = await seed({ bound: status !== 'active', status }), before = await row(target.id);
        const result = await via(surface, target.id); assert(result); assert.equal(result.row.status, 'revoked');
        const after = await row(target.id); assert.equal(after.policy_revision, 2); preserves(before, after);
        const writes = await writeProof();
        const again = await via(surface, target.id); assert(again); assert.equal(again.row.status, 'revoked'); assert.deepEqual(await row(target.id), after);
        assert.deepEqual(await writeProof(), writes, 'An idempotent revoke must not attempt another SQL mutation.');
      });
    }
    for (const surface of ['web', 'agent'] as const) await check(`${surface} missing foreign-workspace and unscoped shares return null without mutation`, async () => {
      assert.equal(await via(surface, crypto.randomUUID()), null);
      for (const workspaceId of ['foreign-space', null]) {
        const target = await seed({ workspaceId }), before = await row(target.id);
        assert.equal(await via(surface, target.id), null); assert.deepEqual(await row(target.id), before);
      }
    });
    await check('Web share owner retains monotone revoke after public-create permission removal', async () => {
      const target = await seed({ owner: 'other' });
      const result = await web(target.id, 'other'); assert(result); assert.equal(result.row.status, 'revoked');
    });
    await check('current Web workspace manager and actual instance admin can revoke another creator', async () => {
      const target = await seed({ owner: 'owner' });
      await admin.query("UPDATE organization_user_permissions SET role='admin' WHERE user_id='member'");
      try { assert((await web(target.id, 'member'))?.row.status === 'revoked'); }
      finally { await admin.query("UPDATE organization_user_permissions SET role='member' WHERE user_id='member'"); }
      const adminTarget = await seed(); assert((await web(adminTarget.id))?.row.status === 'revoked');
    });
    await check('caller booleans and a forged actor header cannot confer Web admin rights', async () => {
      const target = await seed({ owner: 'owner' });
      await rejectedUnchanged(target.id, async () => {
        const original = await request('other'); original.headers.set('x-canvas-user-role', 'admin');
        return revokePublicShareForRequest(original, { id: target.id, workspaceId: 'revoke-space', userId: 'owner', isAdmin: true } as Parameters<typeof revokePublicShareForRequest>[1]);
      });
      await rejectedUnchanged(target.id, () => revokePublicShareForRequest(new NextRequest('http://localhost/api/security/public-files/revoke',
        { headers: { 'x-canvas-workspace-id': 'revoke-space', 'x-canvas-user-id': 'owner', 'x-canvas-user-role': 'admin' } }), { id: target.id }));
      await rejectedUnchanged(target.id, async () => {
        const original = await request('other'); original.headers.set('x-canvas-user-role', 'admin');
        return revokePublicShareForRequest(original, { id: target.id, workspaceId: 'revoke-space' });
      }, error => error instanceof writer.PublicShareWriterError && error.code === 'PUBLIC_SHARE_WRITE_DENIED');
    });
    await check('ordinary Agent ALS and wrong actual tool name provide no public revoke authority', async () => {
      const target = await seed();
      await rejectedUnchanged(target.id, () => runWithAgentExecutionContext(origin(), () => revokePublicShareForAgent({ id: target.id })),
        error => error instanceof AgentToolInvocationError && error.code === 'AGENT_TOOL_INVOCATION_REQUIRED');
      await rejectedUnchanged(target.id, () => agent(() => revokePublicShareForAgent({ id: target.id }), undefined, 'read'));
    });
    for (const [name, change, restore] of [
      ['public ACL', "UPDATE organization_user_permissions SET can_create_public_links=0 WHERE user_id='member'", "UPDATE organization_user_permissions SET can_create_public_links=1 WHERE user_id='member'"],
      ['seat', "UPDATE team_memberships SET status='suspended' WHERE id='seat-member'", "UPDATE team_memberships SET status='active' WHERE id='seat-member'"],
      ['ban', "UPDATE \"user\" SET banned=1 WHERE id='member'", "UPDATE \"user\" SET banned=0 WHERE id='member'"],
      ['PI archive', "UPDATE pi_sessions SET archived_at=100 WHERE session_id='public-pi'", "UPDATE pi_sessions SET archived_at=NULL WHERE session_id='public-pi'"],
      ['disabled tool', "UPDATE agents SET enabled_tools_json='[\"__none__\"]' WHERE agent_id='public-agent'", "UPDATE agents SET enabled_tools_json='[\"public_share_file\"]' WHERE agent_id='public-agent'"],
      ['revoked grant', "UPDATE agent_grants SET can_use=0 WHERE id='public-grant'", "UPDATE agent_grants SET can_use=1 WHERE id='public-grant'"],
    ] as const) await check(`fresh Agent ${name} rejects without revoking`, async () => {
      const target = await seed(); await admin.query(change);
      try { await rejectedUnchanged(target.id, () => via('agent', target.id), name === 'revoked grant'
        ? error => error instanceof Error && error.constructor === Error
          && error.message === 'Agent access is no longer available in this workspace.' && !Object.hasOwn(error, 'code')
        : domainFailure); }
      finally { await admin.query(restore); }
    });
    for (const [name, change, restore] of [
      ['workspace membership', "UPDATE organization_user_permissions SET status='suspended' WHERE user_id='member'", "UPDATE organization_user_permissions SET status='active' WHERE user_id='member'"],
      ['ban', "UPDATE \"user\" SET banned=1 WHERE id='member'", "UPDATE \"user\" SET banned=0 WHERE id='member'"],
      ['seat', "UPDATE team_memberships SET status='suspended' WHERE id='seat-member'", "UPDATE team_memberships SET status='active' WHERE id='seat-member'"],
    ] as const) await check(`fresh Web ${name} rejects without revoking`, async () => {
      assert.equal((await auth.api.getSession({ headers: (await request('member')).headers }))?.session.id, 'session-member');
      const target = await seed(); await admin.query(change);
      try { await rejectedUnchanged(target.id, () => web(target.id, 'member')); }
      finally {
        const remainingSessions = (await admin.query("SELECT count(*)::integer AS count FROM session WHERE id='session-member'")).rows[0].count;
        await admin.query(restore);
        // The real Seat guard can revoke every session, even when this test
        // changes membership or ban state. Reauthenticate the next owned case.
        tokens.member = crypto.randomBytes(32).toString('hex');
        await admin.query(`INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at)
          VALUES('session-member',$1,'member',$2,100,100)
          ON CONFLICT(id) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at`, [tokens.member, Date.now() + 3600000]);
        const restored = await auth.api.getSession({ headers: (await request('member')).headers });
        console.log('Public Web negative credential isolation:', JSON.stringify({ name,
          credentialRevoked: remainingSessions === 0, freshSessionPresent: restored?.session.id === 'session-member' }));
        assert.equal(restored?.session.id, 'session-member');
      }
    });
    await check('fresh Web expired session rejects without revoking', async () => {
      const target = await seed(), expiredId = `expired-${crypto.randomUUID()}`, expiredToken = crypto.randomBytes(32).toString('hex');
      await admin.query(`INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,'member',100,100,100)`, [expiredId, expiredToken]);
      try {
        const original = await request('member', false, target.id);
        original.headers.set('authorization', `Bearer ${expiredToken}`);
        await rejectedUnchanged(target.id, () => revokePublicShareForRequest(original, { id: target.id, workspaceId: 'revoke-space' }));
        // Better Auth really consumes the expired credential. Later cases retain
        // their independent genuine session instead of reviving a deleted row.
        const expiredRows = (await admin.query('SELECT count(*)::integer AS count FROM session WHERE id=$1', [expiredId])).rows[0].count;
        const baselineSession = await auth.api.getSession({ headers: (await request('member')).headers });
        console.log('Public expired credential witness:', JSON.stringify({ expiredRows,
          baselineSessionPresent: baselineSession?.session.id === 'session-member' }));
        assert.equal(expiredRows, 0);
        assert.equal(baselineSession?.session.id, 'session-member');
      } finally { await admin.query('DELETE FROM session WHERE id=$1', [expiredId]); }
    });
    await check('Agent pre-abort cannot revoke or expose a success value', async () => {
      const target = await seed(), controller = new AbortController(); controller.abort();
      await rejectedUnchanged(target.id, () => agent(() => revokePublicShareForAgent({ id: target.id }), controller.signal),
        error => error instanceof AgentToolInvocationError && error.code === 'AGENT_TOOL_INVOCATION_ABORTED');
    });
    await check('actual Main runtime tools override its irrelevant stored enabled-tools column', async () => {
      const target = await seed();
      assert.equal((await agent(() => revokePublicShareForAgent({ id: target.id }), undefined, 'public_share_file', 'bradley'))?.row.status, 'revoked');
      assert.equal((await admin.query("SELECT enabled_tools_json FROM agents WHERE agent_id='bradley'")).rows[0].enabled_tools_json, '["__none__"]');
      const blocked = await seed(); await configure(['__none__']);
      try { await rejectedUnchanged(blocked.id, () => agent(() => revokePublicShareForAgent({ id: blocked.id }), undefined, 'public_share_file', 'bradley'),
        error => error instanceof PublicShareToolPolicyError && error.code === 'TOOL_POLICY_DENIED'); }
      finally { await configure(['public_share_file']); }
    });
    await check('Special NULL inherits actual Main disabled tools while an explicit override stays allowed', async () => {
      const blocked = await seed(); await configure(['__none__']); await admin.query("UPDATE agents SET enabled_tools_json=NULL WHERE agent_id='public-agent'");
      try {
        await rejectedUnchanged(blocked.id, () => via('agent', blocked.id), error => error instanceof PublicShareToolPolicyError && error.code === 'TOOL_POLICY_DENIED');
        await admin.query("UPDATE agents SET enabled_tools_json='[\"public_share_file\"]' WHERE agent_id='public-agent'");
        assert.equal((await via('agent', blocked.id))?.row.status, 'revoked');
      } finally { await configure(['public_share_file']); await admin.query("UPDATE agents SET enabled_tools_json='[\"public_share_file\"]' WHERE agent_id='public-agent'"); }
    });
    await check('Special whitespace-normalized disabled sentinel cannot grant public operations', async () => {
      const target = await seed(); await admin.query("UPDATE agents SET enabled_tools_json='[\" __none__ \"]' WHERE agent_id='public-agent'");
      try { await rejectedUnchanged(target.id, () => via('agent', target.id), error => error instanceof PublicShareToolPolicyError && error.code === 'TOOL_POLICY_DENIED'); }
      finally { await admin.query("UPDATE agents SET enabled_tools_json='[\"public_share_file\"]' WHERE agent_id='public-agent'"); }
    });
    await check('Special actual provider override inherits that provider tools instead of the active Main provider', async () => {
      const target = await seed();
      await admin.query("UPDATE agents SET enabled_tools_json=NULL,default_provider='anthropic',default_model='fixture-model' WHERE agent_id='public-agent'");
      try { await rejectedUnchanged(target.id, () => via('agent', target.id), error => error instanceof PublicShareToolPolicyError && error.code === 'TOOL_POLICY_DENIED'); }
      finally { await admin.query("UPDATE agents SET enabled_tools_json='[\"public_share_file\"]',default_provider=NULL,default_model=NULL WHERE agent_id='public-agent'"); }
    });
    await check('actual DELETE route preserves the original authenticated request and committed DTO policy', async () => {
      const { DELETE } = await import('../app/api/security/public-shares/[id]/route');
      for (const cookie of [false, true]) {
        const target = await seed(), response = await DELETE(await request('member', cookie, target.id), { params: Promise.resolve({ id: target.id }) });
        const body = await response.json();
        console.log('Public DELETE owned response witness:', JSON.stringify({ cookie, status: response.status,
          hasSetCookie: response.headers.has('set-cookie'), success: body.success, code: body.code,
          unauthorized: body.error === 'Unauthorized',
          shareStatus: body.share?.status, policyRevision: body.share?.policyRevision,
          storedPolicyRevision: (await row(target.id)).policy_revision }));
        assert.equal(response.status, 200); assert.equal(response.headers.has('set-cookie'), false);
        assert.equal(body.success, true); assert.equal(body.share.id, target.id);
        assert.equal(body.share.status, 'revoked'); assert.equal(body.share.policyRevision, 2); assert.equal((await row(target.id)).policy_revision, 2);
      }
    });
    await check('legacy dispatcher preserves genuine request and invocation positive paths', async () => {
      const { revokePublicFileShare } = await import('../app/lib/public-sharing/public-file-shares');
      const webTarget = await seed();
      assert.equal((await revokePublicFileShare({ id: webTarget.id, request: await request('member'), workspaceId: 'revoke-space' }))?.status, 'revoked');
      const agentTarget = await seed(); assert.equal((await agent(() => revokePublicFileShare({ id: agentTarget.id, workspaceId: 'revoke-space' })))?.status, 'revoked');
    });

    // Actual SQL instrumentation is restricted to the owned runtime checkout.
    // Every query delegates unchanged; faults occur after actual completion.
    const runtimeClient = (client: Client) => client !== admin && isOwnClient(client) && typeof Reflect.get(client, 'release') === 'function';
    const queryText = (args: unknown[]) => typeof args[0] === 'string' ? args[0].trim() : '';
    const queryValues = (args: unknown[]) => Array.isArray(args[1]) ? args[1] : [];
    const isShareUpdate = (sql: string) => /^UPDATE\s+"[^"\u0000]+"\."?public_file_shares"?\s/iu.test(sql);
    const isLockedShareRead = (sql: string) => /\bFROM\s+"[^"\u0000]+"\."?public_file_shares"?\s/iu.test(sql)
      && sql.endsWith(' FOR UPDATE NOWAIT');
    const reservation = (filePath: string, documents: Array<{ documentId: string; workspaceId: string; organizationId: string;
      path: string; representation: 'plain_text'; lifecycleGeneration: number; schemaVersion: number; status: 'active' }> = []) => {
      const actionPayloadText = JSON.stringify({ source: filePath, destination: `moved-${crypto.randomUUID()}.md` });
      return { requestId: crypto.randomUUID(), actorId: 'owner', action: 'move' as const, actionPayloadText,
        actionDigest: collaborationAdmissionActionDigest('move', actionPayloadText),
        scopes: [{ workspaceId: 'revoke-space', organizationId: 'revoke-org', path: filePath, kind: 'exact' as const }], expectedDocuments: documents };
    };
    const nativeSeed = async () => {
      const target = await seed({ bound: true }), doc = new Y.Doc();
      let update: Buffer, vector: Buffer;
      try { doc.getText('content').insert(0, 'Actual native public revocation fixture.');
        update = Buffer.from(Y.encodeStateAsUpdate(doc)); vector = Buffer.from(Y.encodeStateVector(doc)); }
      finally { doc.destroy(); }
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,'revoke-space','organization','revoke-org',$2,'active',100)`, [target.lineageId, target.filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,'revoke-space','organization','revoke-org',$3,'yjs',7,'initialized','active',100,100)`, [target.documentId, target.lineageId, target.filePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,'revoke-space','revoke-org',$2,'plain_text',5,1,$3,$4,7,100,7,100,'fixture','fixture','lf',0,0,'active')`,
      [target.documentId, target.filePath, update!, vector!]);
      return target;
    };
    const nativeScope = (target: Awaited<ReturnType<typeof nativeSeed>>, filePath = target.filePath) => ({
      documentId: target.documentId, workspaceId: 'revoke-space', organizationId: 'revoke-org', path: filePath,
      representation: 'plain_text' as const, lifecycleGeneration: 5, schemaVersion: 1,
    });
    const nativeProof = async (target: Awaited<ReturnType<typeof seed>>) => (await admin.query(`SELECT jsonb_build_object(
      'document',(SELECT to_jsonb(d) FROM collaboration_documents d WHERE d.id=$1),
      'lineage',(SELECT to_jsonb(l) FROM file_collaboration_lineages l WHERE l.id=$2),
      'state',(SELECT to_jsonb(s) FROM collaboration_yjs_states s WHERE s.document_id=$1)) AS snapshot`,
    [target.documentId, target.lineageId])).rows[0].snapshot as Row;
    for (const surface of ['web', 'agent'] as const) await check(`${surface} genuine path reservation blocks missing-target revoke without blocking unrelated links`, async () => {
      const target = await seed(), unrelated = await seed(), reserved = reservation(target.filePath);
      await admission.reserve(reserved);
      try {
        await rejectedUnchanged(target.id, () => via(surface, target.id), error => error instanceof writer.PublicShareWriterError && error.code === 'PUBLIC_SHARE_WRITE_BUSY');
        assert.equal((await via(surface, unrelated.id))?.row.status, 'revoked');
      } finally { await admission.cancel(reserved, 1); }
      assert.equal((await via(surface, target.id))?.row.status, 'revoked');
    });
    await check('native document reservation at a different current path blocks the pinned share', async () => {
      const target = await nativeSeed(), currentPath = `current-${crypto.randomUUID()}.md`;
      for (const relation of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages']) {
        await admin.query(`UPDATE ${relation} SET path=$1 WHERE ${relation === 'file_collaboration_lineages' ? 'id' : relation === 'collaboration_documents' ? 'id' : 'document_id'}=$2`,
          [currentPath, relation === 'file_collaboration_lineages' ? target.lineageId : target.documentId]);
      }
      const reserved = reservation(currentPath, [{ ...nativeScope(target, currentPath), status: 'active' }]);
      await admission.reserve(reserved);
      try {
        assert.equal(Number((await admin.query('SELECT count(*) AS n FROM collaboration_admission_scopes WHERE request_id=$1 AND path=$2', [reserved.requestId, target.filePath])).rows[0].n), 0);
        for (const surface of ['web', 'agent'] as const) await rejectedUnchanged(target.id, () => via(surface, target.id),
          error => error instanceof writer.PublicShareWriterError && error.code === 'PUBLIC_SHARE_WRITE_BUSY');
      } finally { await admission.cancel(reserved, 1); }
    });
    await check('genuine workspace exclusive admission prevents both revoke surfaces', async () => {
      const target = await seed(), blocker = await ownClient();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey('revoke-space')]);
        for (const surface of ['web', 'agent'] as const) await rejectedUnchanged(target.id, () => via(surface, target.id),
          error => error instanceof writer.PublicShareWriterError && error.code === 'PUBLIC_SHARE_WRITE_BUSY');
      } finally { await blocker.query('ROLLBACK'); await endClient(blocker); }
      assert.equal((await via('web', target.id))?.row.status, 'revoked');
    });
    for (const surface of ['web', 'agent'] as const) await check(`${surface} monotone revoke leaves genuine native room and binary state untouched`, async () => {
      const target = await nativeSeed(), client = await ownClient();
      let owner: Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>> | undefined;
      try {
        owner = await createCollaborationRoomOwnerSession(client); const held = await owner.acquire(nativeScope(target));
        const before = await nativeProof(target), result = await via(surface, target.id);
        assert.equal(result?.row.status, 'revoked'); owner.assertActive(held); assert.deepEqual(await nativeProof(target), before);
        await assert.rejects(stat(path.join(workspace.rootPath, target.filePath)), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
      } finally { if (owner) { await owner.close(); clients.delete(client); } else await endClient(client); }
    });
    for (const surface of ['web', 'agent'] as const) await check(`${surface} original peer row lock produces real 55P03 and no revoke attempt`, async () => {
      const target = await seed(), blocker = await ownClient(), originalQuery = Client.prototype.query;
      let rawBusy = false, writerPid = 0;
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT id FROM public_file_shares WHERE id=$1 FOR UPDATE', [target.id]);
        Client.prototype.query = function (this: Client, ...args: unknown[]) {
          const sql = queryText(args);
          if (runtimeClient(this) && isLockedShareRead(sql) && queryValues(args).includes(target.id)) {
            writerPid = Number(Reflect.get(this, 'processID'));
            return Promise.resolve(Reflect.apply(originalQuery, this, args)).catch(error => {
              rawBusy = !!error && typeof error === 'object' && Reflect.get(error, 'code') === '55P03'; throw error;
            });
          }
          return Reflect.apply(originalQuery, this, args);
        } as typeof Client.prototype.query;
        await rejectedUnchanged(target.id, () => via(surface, target.id), error => error instanceof WorkspaceRequestPrincipalError && error.code === 'PRINCIPAL_BUSY');
      } finally { Client.prototype.query = originalQuery; await blocker.query('ROLLBACK'); await endClient(blocker); }
      assert(rawBusy); assert(writerPid > 0); assert.equal((await via(surface, target.id))?.row.status, 'revoked');
    });
    for (const surface of ['web', 'agent'] as const) await check(`${surface} actual peer policy commit before row lock causes CHANGED with zero own DML`, async () => {
      const target = await seed(), before = await row(target.id), originalQuery = Client.prototype.query;
      let changed = false, ownDml = 0;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = queryText(args), selected = runtimeClient(this) && queryValues(args).includes(target.id);
        if (selected && isShareUpdate(sql)) ownDml++;
        if (selected && isLockedShareRead(sql) && !changed) {
          changed = true;
          return admin.query("UPDATE public_file_shares SET policy_revision=policy_revision+1,reason='external policy' WHERE id=$1", [target.id])
            .then(() => Reflect.apply(originalQuery, this, args));
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { await assert.rejects(via(surface, target.id), error => error instanceof writer.PublicShareWriterError && error.code === 'PUBLIC_SHARE_WRITE_CHANGED'); }
      finally { Client.prototype.query = originalQuery; }
      assert(changed); assert.equal(ownDml, 0);
      assert.deepEqual(await row(target.id), { ...before, policy_revision: 2, reason: 'external policy' });
    });
    await check('two actual Web and Agent revokes expose at most one policy increment and one SQL attempt', async () => {
      const target = await seed(), before = await row(target.id), writes = await writeProof();
      const results = await Promise.allSettled([via('web', target.id), via('agent', target.id)]);
      assert(results.some(result => result.status === 'fulfilled'));
      for (const result of results) {
        if (result.status === 'fulfilled') {
          assert(result.value); assert.equal(result.value.row.id, target.id); assert.equal(result.value.row.status, 'revoked'); assert.equal(result.value.row.policyRevision, 2);
        } else assert(result.reason instanceof writer.PublicShareWriterError && result.reason.code === 'PUBLIC_SHARE_WRITE_CHANGED'
          || result.reason instanceof WorkspaceRequestPrincipalError && result.reason.code === 'PRINCIPAL_BUSY');
      }
      const after = await row(target.id), attempted = await writeProof();
      assert.equal(after.status, 'revoked'); assert.equal(after.policy_revision, 2); preserves(before, after);
      assert.equal(BigInt(attempted.value), BigInt(writes.value) + BigInt(1)); assert.equal(attempted.is_called, true);
    });
    await check('actual post-capture Agent profile revision drift rejects before revocation', async () => {
      const target = await seed(), originalQuery = Client.prototype.query;
      let changed = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        if (runtimeClient(this) && queryText(args) === 'BEGIN' && !changed) {
          changed = true;
          return admin.query("UPDATE agents SET revision=revision+1 WHERE agent_id='public-agent'")
            .then(() => Reflect.apply(originalQuery, this, args));
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { await rejectedUnchanged(target.id, () => via('agent', target.id), error => error instanceof WorkspaceRequestPrincipalError && error.code === 'PRINCIPAL_SCOPE_CHANGED'); }
      finally { Client.prototype.query = originalQuery; }
      assert(changed);
    });
    await check('actual Agent invocation abort during the row-lock query prevents the narrow mutation', async () => {
      const target = await seed(), controller = new AbortController(), originalQuery = Client.prototype.query;
      let aborted = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        if (runtimeClient(this) && isLockedShareRead(queryText(args)) && queryValues(args).includes(target.id)) {
          aborted = true; controller.abort();
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { await rejectedUnchanged(target.id, () => agent(() => revokePublicShareForAgent({ id: target.id }), controller.signal),
        error => error instanceof AgentToolInvocationError && error.code === 'AGENT_TOOL_INVOCATION_ABORTED'); }
      finally { Client.prototype.query = originalQuery; }
      assert(aborted);
    });
    await check('actual held runtime config drift on B invalidates prepared Agent tool policy', async () => {
      const target = await seed(), before = await row(target.id), originalQuery = Client.prototype.query;
      let changed = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        if (runtimeClient(this) && isLockedShareRead(queryText(args)) && queryValues(args).includes(target.id) && !changed) {
          changed = true; return configure(['__none__']).then(() => Reflect.apply(originalQuery, this, args));
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { await assert.rejects(via('agent', target.id), error => error instanceof PublicShareToolPolicyError && error.code === 'TOOL_POLICY_CHANGED'); }
      finally { Client.prototype.query = originalQuery; await configure(['public_share_file']); }
      assert(changed); assert.deepEqual(await row(target.id), before);
    });
    for (const surface of ['web', 'agent'] as const) await check(`${surface} genuine TEMP public relation shadow is rejected and rolled back`, async () => {
      const target = await seed(), originalQuery = Client.prototype.query;
      let injected = false, rolledBack = false, absent = false;
      const writerClients = new WeakSet<Client>();
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = queryText(args);
        if (runtimeClient(this) && sql === 'BEGIN' && !injected) {
          injected = true; writerClients.add(this);
          return Promise.resolve(Reflect.apply(originalQuery, this, args)).then(async result => {
            await Reflect.apply(originalQuery, this, ['CREATE TEMP TABLE public_file_shares (fixture_shadow integer) ON COMMIT DROP']); return result;
          });
        }
        if (writerClients.has(this) && sql === 'ROLLBACK') return Promise.resolve(Reflect.apply(originalQuery, this, args)).then(async result => {
          rolledBack = true;
          const observed = await Reflect.apply(originalQuery, this, ["SELECT to_regclass('pg_temp.public_file_shares') IS NULL AS absent"]);
          absent = observed.rows[0].absent === true; return result;
        });
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { await rejectedUnchanged(target.id, () => via(surface, target.id), error => error instanceof writer.PublicShareWriterError && error.code === 'PUBLIC_SHARE_WRITE_CHANGED'); }
      finally { Client.prototype.query = originalQuery; }
      assert(injected); assert(rolledBack); assert(absent);
    });
    await check('held original public relation rejects real concurrent trigger DDL while revoke succeeds', async () => {
      const target = await seed(), peer = await ownClient(), originalQuery = Client.prototype.query;
      let attempted = false, ddlBusy = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        if (runtimeClient(this) && isShareUpdate(queryText(args)) && queryValues(args).includes(target.id) && !attempted) {
          attempted = true;
          return peer.query('ALTER TABLE public_file_shares DISABLE TRIGGER fixture_public_write_attempt').then(() => {
            assert.fail('The genuine held relation must block trigger DDL.');
          }, error => {
            assert(error && typeof error === 'object' && Reflect.get(error, 'code') === '55P03'); ddlBusy = true;
          }).then(() => Reflect.apply(originalQuery, this, args));
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { assert.equal((await via('web', target.id))?.row.status, 'revoked'); }
      finally { Client.prototype.query = originalQuery; await endClient(peer); }
      assert(attempted); assert(ddlBusy);
    });
    for (const surface of ['web', 'agent'] as const)
    for (const mode of ['lost-ack', 'lost-ack-discard-throws', 'confirmed-commit-release-throws'] as const)
    await check(`${surface} genuine COMMIT ${mode} never publishes success or replays revoke`, async () => {
      const target = await nativeSeed(), before = await row(target.id), nativeBefore = await nativeProof(target), originalQuery = Client.prototype.query;
      const releases = new Map<Client, (error?: Error) => void>();
      const lostAck = Object.assign(new Error('Owned fixture lost the ACK after the genuine public revoke COMMIT.'), { code: 'ECONNRESET' });
      const releaseError = new Error('Owned fixture lost only the genuine public revoke checkout disposal reply.');
      let writerPid = 0, dml = 0, commits = 0, rollbacks = 0, disposals = 0;
      let committed = false, disposed = false, discarded = false, disposalThrew = false, published = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = queryText(args);
        if (runtimeClient(this) && isShareUpdate(sql) && queryValues(args).includes(target.id)) {
          dml++; writerPid = Number(Reflect.get(this, 'processID'));
          if (!releases.has(this)) {
            const release = Reflect.get(this, 'release') as (error?: Error) => void; assert.equal(typeof release, 'function'); releases.set(this, release);
            Reflect.set(this, 'release', (error?: Error) => {
              disposals++; discarded = error instanceof Error;
              const result = Reflect.apply(release, this, [error]); disposed = true;
              if (mode !== 'lost-ack') { disposalThrew = true; throw releaseError; } return result;
            });
          }
        }
        if (releases.has(this)) {
          if (sql === 'ROLLBACK') rollbacks++;
          if (sql === 'COMMIT') {
            commits++;
            return Promise.resolve(Reflect.apply(originalQuery, this, args)).then(result => {
              committed = true; if (mode !== 'confirmed-commit-release-throws') throw lostAck; return result;
            });
          }
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try {
        await assert.rejects(via(surface, target.id).then(value => { published = true; return value; }), error => {
          assert(error instanceof writer.PublicShareWriterCommitError); assert.equal(error.code, 'PUBLIC_SHARE_WRITE_COMMIT_UNCONFIRMED'); assert.equal(error.status, 503);
          assert.deepEqual(writer.publicShareWriterFailure(error), { code: error.code, status: 503, message: error.message });
          assert(committed); assert(disposed); assert.equal(discarded, mode !== 'confirmed-commit-release-throws');
          assert.equal(disposalThrew, mode !== 'lost-ack'); return true;
        });
      } finally { Client.prototype.query = originalQuery; for (const [client, release] of releases) Reflect.set(client, 'release', release); }
      assert.equal(published, false); assert.equal(releases.size, 1); assert(writerPid > 0);
      assert.equal(dml, 1); assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(disposals, 1);
      if (discarded) {
        const deadline = Date.now() + 5000;
        while (!(await admin.query('SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent', [writerPid])).rows[0].absent) {
          assert(Date.now() < deadline, 'An actually discarded public revoke backend remained present.'); await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      const after = await row(target.id); assert.equal(after.status, 'revoked'); assert.equal(after.policy_revision, 2); preserves(before, after);
      assert.deepEqual(await nativeProof(target), nativeBefore);
      const writes = await writeProof(); assert.equal((await via(surface, target.id))?.row.status, 'revoked');
      assert.deepEqual(await row(target.id), after); assert.deepEqual(await writeProof(), writes, 'A fresh request must observe the committed revoke without issuing another mutation.');
    });
    assert.equal(passed, 57);

    assert.equal(fetches, 0); await own();
    console.log('Public share revoke SQL assertions complete:', JSON.stringify({ passed, fetches }));
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
      schemaRemoved = (await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed === true; assert(schemaRemoved);
    });
    await cleanup(() => control.end());
    await cleanup(async () => {
      const current = await stat(dataRoot);
      assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino); assert.equal(current.uid, rootIdentity.uid);
      await rm(dataRoot, { recursive: true }); await assert.rejects(stat(dataRoot), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT'); dataRemoved = true;
    });
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    console.log('Public share revoke owned cleanup:', JSON.stringify({ schemaRemoved, dataRemoved, openClients: clients.size, passed }));
    if (cleanupErrors.length) throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Owned public revoke fixture cleanup failed.');
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  assert(schemaRemoved); assert(dataRemoved); complete = true;
  console.log('Public share revoke PostgreSQL18 finished:', JSON.stringify({ passed, schemaRemoved, dataRemoved }));
}
main().catch(error => {
  console.error('Owned public revoke fixture failed:', { stage, passed, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null }); process.exitCode = 1;
});
