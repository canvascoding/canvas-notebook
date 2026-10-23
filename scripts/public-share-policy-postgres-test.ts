import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import * as Y from 'yjs';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';

const sourcePath = path.resolve('scripts/public-share-policy-postgres-test.ts');
const sourceHash = async () => crypto.createHash('sha256').update(await readFile(sourcePath)).digest('hex');

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', passed = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const originalSourceHash = await sourceHash();
  console.log('Public policy source pin:', originalSourceHash);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `public_policy_${crypto.randomUUID().replaceAll('-', '')}`, nonce = crypto.randomUUID();
  assert.match(schema, /^public_policy_[a-f0-9]{32}$/u);
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-public-share-policy-'))), rootIdentity = await stat(dataRoot);
  assert.equal(rootIdentity.uid, process.getuid!()); assert.equal(rootIdentity.mode & 0o077, 0);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>();
  let created = false, schemaOid = 0, schemaRemoved = false, dataRemoved = false, fetches = 0;
  let pool: { end: () => Promise<void> } | undefined, primaryFailure: unknown;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=public-policy-fixture` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const check = async (name: string, operation: () => Promise<void>) => {
    stage = name; await operation(); passed++; console.log('Public policy case passed:', JSON.stringify({ passed, name }));
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
      CANVAS_ORGANIZATION_ID: 'policy-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'NEXT_PHASE', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'policy-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true,
      organizationId: 'policy-org', capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true }, seatLimit: 3, quotas: { users: 3 },
      entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('No network is permitted in the owned policy fixture.'); };
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
      ('owner','Owner','owner@policy.test',1,'admin',0,100,100),('member','Member','member@policy.test',1,'user',0,100,100),
      ('other','Other','other@policy.test',1,'user',0,100,100)`);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('policy-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_create_public_links,created_at,updated_at)
      VALUES('policy-org','owner','owner','active',1,1,100,100),('policy-org','member','member','active',1,1,100,100),
      ('policy-org','other','member','active',0,0,100,100)`);
    for (const userId of ['owner', 'member', 'other']) await admin.query(`INSERT INTO team_memberships
      (id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES($1,'policy-org',$2,$3,$4,'active',100,100,100,100)`, [`seat-${userId}`, `${userId}@policy.test`, userId, userId === 'owner' ? 'owner' : 'member']);
    await admin.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('policy-org',100,100)");
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('policy-space','policy-org','organization',NULL,'Policy','organizations/policy-org/shared','active',100,100),
      ('foreign-space','policy-org','personal','other','Other','users/other/workspace','active',100,100)`);
    await admin.query(`INSERT INTO canvas_customers(id,organization_id,name,slug,status,created_at,updated_at)
      VALUES('policy-customer','policy-org','Policy Customer','policy-customer','active',100,100)`);
    await admin.query(`INSERT INTO canvas_projects(id,organization_id,customer_id,name,slug,status,created_at,updated_at)
      VALUES('policy-project','policy-org','policy-customer','Policy Project','policy-project','active',100,100)`);
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,customer_id,project_id,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('project-space','policy-org','project','policy-customer','policy-project','Policy Project','organizations/policy-org/projects/policy-project','active',100,100)`);
    await admin.query(`INSERT INTO canvas_project_members(organization_id,project_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at)
      VALUES('policy-org','policy-project','member','member','active',1,0,1,100,100)`);
    const tokens: Record<string, string> = {};
    for (const userId of ['owner', 'member', 'other']) {
      const token = crypto.randomBytes(32).toString('hex'); tokens[userId] = token;
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,100,100)`, [`session-${userId}`, token, userId, Date.now() + 3600000]);
    }
    const { auth } = await import('../app/lib/auth');
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { WorkspaceRequestPrincipalError } = await import('../app/lib/workspaces/request-principal');
    const { SeatLimitGuardError } = await import('../app/lib/license/seat-limit');
    const { AgentActorContextError } = await import('../app/lib/agents/actor-context');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const writer = await import('../app/lib/public-sharing/writer');
    const { updatePublicSharePolicyForRequest } = writer;
    const sharing = await import('../app/lib/public-sharing/public-file-shares');
    const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { collaborationAdmissionActionDigest, collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const admission = createCollaborationAdmissionService({ openConnection: database.openDb });
    const workspace = await readPostgresWorkspaceForActor({ userId: 'member', role: 'member' }, 'policy-space'); assert(workspace);
    await mkdir(workspace.rootPath, { recursive: true });
    const project = await readPostgresWorkspaceForActor({ userId: 'member', role: 'member' }, 'project-space'); assert(project);
    assert.equal(project.projectId, 'policy-project'); assert.equal(project.customerId, 'policy-customer');
    assert.equal(project.permissions.canRead, true); assert.equal(project.permissions.canManageWorkspace, true); assert.equal(project.permissions.canCreatePublicLinks, true);
    await mkdir(project.rootPath, { recursive: true });
    await admin.query('CREATE SEQUENCE fixture_public_write_attempts');
    await admin.query(`CREATE FUNCTION fixture_count_public_writes() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('fixture_public_write_attempts'); RETURN NULL; END $$`);
    await admin.query(`CREATE TRIGGER fixture_public_write_attempt BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON public_file_shares FOR EACH STATEMENT EXECUTE FUNCTION fixture_count_public_writes()`);
    const writeProof = async () => (await admin.query('SELECT last_value::text AS value,is_called FROM fixture_public_write_attempts')).rows[0];
    const row = async (id: string) => (await admin.query('SELECT to_jsonb(s) AS row FROM public_file_shares s WHERE id=$1', [id])).rows[0]?.row as Row;
    type Policy = Parameters<typeof updatePublicSharePolicyForRequest>[1];
    const request = async (userId = 'member', cookie = false, id = 'fixture', body?: unknown, mobile = false) => {
      const headers = new Headers({ 'x-canvas-workspace-id': 'policy-space' });
      if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens[userId], process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization', `Bearer ${tokens[userId]}`);
      if (body !== undefined) headers.set('content-type', 'application/json');
      return new NextRequest(`http://localhost${mobile ? '/api/mobile/v1/files/shares/' : '/api/security/public-shares/'}${id}`,
        { method: 'PATCH', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    for (const userId of ['owner', 'member', 'other']) assert.equal((await auth.api.getSession({ headers: (await request(userId)).headers }))?.session.id, `session-${userId}`);
    const seed = async (input: { native?: boolean; status?: string; owner?: string; workspaceId?: string | null; extension?: string;
      expiresAt?: number | null; reason?: string | null; securityMode?: 'strict' | 'interactive' } = {}) => {
      const id = crypto.randomUUID(), filePath = `policy-${id}${input.extension ?? '.bin'}`, fullPath = path.join(workspace.rootPath, filePath);
      const documentId = `native-${id}`, lineageId = `lineage-${id}`;
      let identity = 'historical-unused-native-identity', size = 123;
      if (!input.native) {
        await writeFile(fullPath, input.extension === '.html' ? '<p>Owned physical policy fixture.</p>' : 'Owned physical policy fixture.');
        const observed = await stat(fullPath); identity = `${observed.dev}:${observed.ino}:${observed.birthtimeMs}`; size = observed.size;
      } else {
        const doc = new Y.Doc(); let update: Buffer, vector: Buffer;
        try { doc.getText('content').insert(0, 'Owned native policy fixture.'); update = Buffer.from(Y.encodeStateAsUpdate(doc)); vector = Buffer.from(Y.encodeStateVector(doc)); }
        finally { doc.destroy(); }
        await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
          VALUES($1,'policy-space','organization','policy-org',$2,'active',100)`, [lineageId, filePath]);
        await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
          state_version,yjs_state_lifecycle,status,created_at,updated_at)
          VALUES($1,$2,'policy-space','organization','policy-org',$3,'yjs',7,'initialized','active',100,100)`, [documentId, lineageId, filePath]);
        await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
          yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
          VALUES($1,'policy-space','policy-org',$2,'plain_text',5,1,$3,$4,7,100,7,100,'fixture','fixture','lf',0,0,'active')`,
        [documentId, filePath, update!, vector!]);
      }
      await admin.query(`INSERT INTO public_file_shares(id,token,token_hash,token_preview,workspace_id,organization_id,workspace_type,workspace_root_relative_path,
        workspace_path,document_id,lineage_id,lifecycle_generation,file_name,file_identity,mime_type,size_bytes,status,created_by_user_id,
        source,reason,security_mode,expires_at,created_at,updated_at,access_count,last_accessed_at,password_enabled,password_hash)
        VALUES($1,$2,$3,'preview',$4,'policy-org','organization','organizations/policy-org/shared',$5,$6,$7,$8,$5,$9,$10,$11,$12,$13,
          'ui',$14,$15,$16,100,100,7,150,1,'fixture-password-hash')`,
      [id, crypto.randomBytes(32).toString('base64url'), crypto.randomBytes(32).toString('hex'),
        Object.hasOwn(input, 'workspaceId') ? input.workspaceId : 'policy-space', filePath,
        input.native ? documentId : null, input.native ? lineageId : null, input.native ? 5 : null, identity,
        input.extension === '.html' || input.extension === '.htm' ? 'text/html' : input.native ? 'text/markdown' : 'application/octet-stream',
        size, input.status ?? 'active', input.owner ?? 'member', Object.hasOwn(input, 'reason') ? input.reason : 'fixture reason',
        input.securityMode ?? 'strict', input.expiresAt ?? null]);
      return { id, filePath, fullPath, documentId, lineageId };
    };
    const update = async (id: string, input: Partial<Policy> = {}, userId = 'member', cookie = false) =>
      updatePublicSharePolicyForRequest(await request(userId, cookie, id), { id, workspaceId: 'policy-space', expectedPolicyRevision: 1, ...input });
    const expected = (code: InstanceType<typeof writer.PublicShareWriterError>['code']) => (error: unknown) =>
      error instanceof writer.PublicShareWriterError && error.code === code;
    const authorityFailure = (error: unknown) => error instanceof WorkspaceRequestPrincipalError || error instanceof SeatLimitGuardError
      || error instanceof AgentActorContextError || expected('PUBLIC_SHARE_WRITE_DENIED')(error);
    const unchanged = async (id: string, operation: () => Promise<unknown>, predicate = expected('PUBLIC_SHARE_WRITE_CHANGED')) => {
      const before = await row(id), writes = await writeProof();
      await assert.rejects(operation(), predicate); assert.deepEqual(await row(id), before); assert.deepEqual(await writeProof(), writes);
    };
    const preserves = (before: Row, after: Row) => {
      for (const key of Object.keys(before).filter(key => !['expires_at', 'security_mode', 'reason', 'policy_revision', 'updated_at'].includes(key)))
        assert.deepEqual(after[key], before[key], `Policy changes must preserve ${key}.`);
    };
    const nativeProof = async (target: Awaited<ReturnType<typeof seed>>) => (await admin.query(`SELECT jsonb_build_object(
      'document',(SELECT to_jsonb(d) FROM collaboration_documents d WHERE d.id=$1),
      'lineage',(SELECT to_jsonb(l) FROM file_collaboration_lineages l WHERE l.id=$2),
      'state',(SELECT to_jsonb(s) FROM collaboration_yjs_states s WHERE s.document_id=$1)) AS snapshot`, [target.documentId, target.lineageId])).rows[0].snapshot as Row;
    const projectSeed = async () => {
      const target = await seed({ owner: 'owner' }); await rename(target.fullPath, path.join(project.rootPath, target.filePath));
      // Historical Create omitted both optional context columns. They are not
      // retroactively filled from the real project's current context.
      await admin.query(`UPDATE public_file_shares SET workspace_id='project-space',workspace_type='project',
        workspace_root_relative_path=$1 WHERE id=$2`, [project.rootRelativePath, target.id]);
      return { ...target, fullPath: path.join(project.rootPath, target.filePath) };
    };
    const updateProject = async (id: string, reason: string) => {
      const original = await request('member', false, id); original.headers.set('x-canvas-workspace-id', 'project-space');
      return updatePublicSharePolicyForRequest(original, { id, workspaceId: 'project-space', expectedPolicyRevision: 1, reason });
    };
    for (const cookie of [false, true]) await check(`genuine ${cookie ? 'Cookie' : 'Bearer'} policy update commits once and preserves historical NULL pins`, async () => {
      const target = await seed(), before = await row(target.id), writes = await writeProof();
      const result = await update(target.id, { reason: 'updated policy' }, 'member', cookie); assert(result);
      assert.equal(result.row.id, target.id); assert.equal(result.row.policyRevision, 2); assert.equal(result.row.reason, 'updated policy');
      const after = await row(target.id); assert.equal(after.policy_revision, 2); assert.equal(after.reason, 'updated policy'); preserves(before, after);
      assert.equal(BigInt((await writeProof()).value), BigInt(writes.value) + BigInt(1));
      for (const key of ['document_id', 'lineage_id', 'lifecycle_generation']) assert.equal(after[key], null);
    });
    await check('legacy policy dispatcher cannot accept a caller owner/workspace as authority without a request', async () => {
      const target = await seed(), before = await row(target.id), writes = await writeProof(); let resolved = false;
      try {
        await unchanged(target.id, () => sharing.updatePublicFileShare({ id: target.id, userId: 'member', workspace,
          expectedPolicyRevision: 1, reason: 'untrusted policy change' }).then(value => { resolved = true; return value; }), expected('PUBLIC_SHARE_WRITE_INVALID'));
      } finally {
        const attempted = await writeProof();
        console.log('Public policy dispatcher forgery actual SQL witness:', JSON.stringify({ resolved,
          rowChanged: !isDeepStrictEqual(before, await row(target.id)), attemptedWrite: attempted.value !== writes.value || attempted.is_called !== writes.is_called }));
      }
    });
    for (const native of [false, true]) await check(`${native ? 'native' : 'physical'} no-op preserves exact row and performs no SQL mutation`, async () => {
      const expiry = Date.now() + 3600000, target = await seed({ native, extension: native ? '.md' : '.bin', expiresAt: expiry, reason: 'same' });
      const before = await row(target.id), writes = await writeProof(), proof = await nativeProof(target);
      const sameSecond = new Date(Math.floor(expiry / 1000) * 1000 + ((expiry % 1000) + 1) % 1000);
      const result = await update(target.id, { expiresAt: sameSecond, securityMode: 'strict', reason: '  same  ' });
      assert(result); assert.equal(result.row.policyRevision, 1); assert.deepEqual(await row(target.id), before); assert.deepEqual(await writeProof(), writes);
      assert.deepEqual(await nativeProof(target), proof);
    });
    await check('omitted expiry stays fixed and explicit null removes it with one revision', async () => {
      const expiry = Date.now() + 3600000, target = await seed({ expiresAt: expiry });
      assert.equal((await update(target.id, { reason: 'changed only reason' }))?.row.expiresAt?.getTime(), expiry);
      const result = await update(target.id, { expectedPolicyRevision: 2, expiresAt: null }); assert(result); assert.equal(result.row.expiresAt, null);
      assert.equal(result.row.policyRevision, 3); assert.equal((await row(target.id)).expires_at, null);
    });
    await check('reason normalization trims truncates and maps empty text to null', async () => {
      const target = await seed(); assert.equal((await update(target.id, { reason: `  ${'x'.repeat(510)}  ` }))?.row.reason, 'x'.repeat(500));
      assert.equal((await update(target.id, { expectedPolicyRevision: 2, reason: '  ' }))?.row.reason, null);
    });
    for (const extension of ['.html', '.htm']) await check(`real ${extension} permits interactive mode and later omitted mode remains unchanged`, async () => {
      const target = await seed({ extension }); assert.equal((await update(target.id, { securityMode: 'interactive' }))?.row.securityMode, 'interactive');
      const before = await row(target.id), writes = await writeProof();
      assert.equal((await update(target.id, { expectedPolicyRevision: 2 }))?.row.securityMode, 'interactive');
      assert.deepEqual(await row(target.id), before); assert.deepEqual(await writeProof(), writes);
    });
    await check('interactive mode cannot be applied to a native Markdown or a physical binary target', async () => {
      for (const native of [false, true]) {
        const target = await seed({ native, extension: native ? '.md' : '.bin' });
        await unchanged(target.id, () => update(target.id, { securityMode: 'interactive' }), expected('PUBLIC_SHARE_WRITE_INVALID'));
      }
    });
    await check('HTML eligibility uses exact suffix and cannot trim a binary neighbor into HTML', async () => {
      const target = await seed({ extension: '.html ' });
      await unchanged(target.id, () => update(target.id, { securityMode: 'interactive' }), expected('PUBLIC_SHARE_WRITE_INVALID'));
    });
    await check('invalid revisions and direct policy values are rejected without attempting SQL', async () => {
      const target = await seed();
      for (const expectedPolicyRevision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        await unchanged(target.id, () => update(target.id, { expectedPolicyRevision }), expected('PUBLIC_SHARE_WRITE_INVALID'));
      for (const input of [{ expiresAt: new Date(NaN) }, { expiresAt: new Date(100) }, { expiresAt: 'tomorrow' },
        { securityMode: 'bogus' }, { reason: 17 }, { reason: {} }])
        await unchanged(target.id, () => update(target.id, input as Partial<Policy>), expected('PUBLIC_SHARE_WRITE_INVALID'));
    });
    await check('wrong revision is CHANGED even when the submitted policy is a no-op', async () => {
      const target = await seed(); await unchanged(target.id, () => update(target.id, { expectedPolicyRevision: 2 }));
    });
    for (const status of ['revoked', 'stale', 'missing', 'expired']) await check(`stored ${status} policy cannot be updated or revived`, async () => {
      const target = await seed({ status }); await unchanged(target.id, () => update(target.id, { reason: 'must not change' }));
      await unchanged(target.id, () => update(target.id, {}));
    });
    await check('a stored elapsed expiry cannot be extended even while status remains active', async () => {
      const target = await seed({ expiresAt: Date.now() - 1000 });
      await unchanged(target.id, () => update(target.id, { expiresAt: new Date(Date.now() + 3600000) }));
    });
    await check('missing foreign and unscoped row selectors stay isolated without mutation', async () => {
      assert.equal(await update(crypto.randomUUID(), {}), null);
      for (const workspaceId of ['foreign-space', null]) {
        const target = await seed({ workspaceId }), before = await row(target.id), writes = await writeProof();
        assert.equal(await update(target.id, { reason: 'must not cross workspace' }), null);
        assert.deepEqual(await row(target.id), before); assert.deepEqual(await writeProof(), writes);
      }
    });
    await check('genuine workspace share manager may change another creator but caller admin flags cannot grant rights', async () => {
      const target = await seed({ owner: 'owner' }); assert.equal((await update(target.id, { reason: 'manager update' }))?.row.policyRevision, 2);
      const denied = await seed({ owner: 'owner' });
      await unchanged(denied.id, async () => {
        const original = await request('other'); original.headers.set('x-canvas-user-role', 'admin');
        return updatePublicSharePolicyForRequest(original, { id: denied.id, workspaceId: 'policy-space', expectedPolicyRevision: 1, reason: 'denied' });
      }, authorityFailure);
    });
    await check('a share owner without current public-link permission cannot change even a no-op policy', async () => {
      const target = await seed({ owner: 'other' }); await unchanged(target.id, () => update(target.id, {}, 'other'), authorityFailure);
    });
    await check('ordinary Agent ALS supplies no authority to the request-only policy dispatcher', async () => {
      const target = await seed();
      const origin: AgentExecutionContext = { userId: 'member', sessionId: 'not-a-web-session', agentId: null, agentTurnId: 'policy-negative-turn',
        workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType, workspaceName: workspace.displayName ?? null,
        organizationId: workspace.organizationId ?? null, customerId: workspace.customerId ?? null, projectId: workspace.projectId ?? null,
        workspaceRoot: workspace.rootPath, workspaceRootRelativePath: workspace.rootRelativePath ?? null, legacy: false, canWrite: true, canDelete: true, canShare: true };
      await unchanged(target.id, () => runWithAgentExecutionContext(origin, () => sharing.updatePublicFileShare({ id: target.id,
        userId: 'member', workspace, expectedPolicyRevision: 1, reason: 'no request' })), expected('PUBLIC_SHARE_WRITE_INVALID'));
    });
    for (const [name, change, restore] of [
      ['public permission', "UPDATE organization_user_permissions SET can_create_public_links=0 WHERE user_id='member'", "UPDATE organization_user_permissions SET can_create_public_links=1 WHERE user_id='member'"],
      ['membership', "UPDATE organization_user_permissions SET status='suspended' WHERE user_id='member'", "UPDATE organization_user_permissions SET status='active' WHERE user_id='member'"],
      ['ban', "UPDATE \"user\" SET banned=1 WHERE id='member'", "UPDATE \"user\" SET banned=0 WHERE id='member'"],
      ['seat', "UPDATE team_memberships SET status='suspended' WHERE id='seat-member'", "UPDATE team_memberships SET status='active' WHERE id='seat-member'"],
    ] as const) await check(`fresh actual ${name} prevents policy mutation`, async () => {
      assert.equal((await auth.api.getSession({ headers: (await request('member')).headers }))?.session.id, 'session-member');
      const target = await seed(); await admin.query(change);
      try { await unchanged(target.id, () => update(target.id, { reason: 'denied' }), authorityFailure); }
      finally {
        const remainingSessions = (await admin.query("SELECT count(*)::integer AS count FROM session WHERE id='session-member'")).rows[0].count;
        await admin.query(restore);
        // Genuine offboarding/Seat checks can delete sessions during a ban or
        // membership negative. Each later case gets a fresh owned credential.
        tokens.member = crypto.randomBytes(32).toString('hex');
        await admin.query(`INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at)
          VALUES('session-member',$1,'member',$2,100,100)
          ON CONFLICT(id) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at`, [tokens.member, Date.now() + 3600000]);
        const restored = await auth.api.getSession({ headers: (await request('member')).headers });
        console.log('Public policy negative credential isolation:', JSON.stringify({ name,
          credentialRevoked: remainingSessions === 0, freshSessionPresent: restored?.session.id === 'session-member' }));
        assert.equal(restored?.session.id, 'session-member');
      }
    });
    await check('expired independent Web credential is consumed without deleting the base login', async () => {
      const target = await seed(), expiredId = `expired-${crypto.randomUUID()}`, expiredToken = crypto.randomBytes(32).toString('hex');
      await admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,'member',100,100,100)", [expiredId, expiredToken]);
      try {
        const original = await request(); original.headers.set('authorization', `Bearer ${expiredToken}`);
        await unchanged(target.id, () => updatePublicSharePolicyForRequest(original, { id: target.id, expectedPolicyRevision: 1, reason: 'denied' }),
          error => error instanceof WorkspaceRequestPrincipalError && error.code === 'PRINCIPAL_AUTH_REVOKED');
        assert.equal((await admin.query('SELECT count(*)::integer AS count FROM session WHERE id=$1', [expiredId])).rows[0].count, 0);
        assert.equal((await auth.api.getSession({ headers: (await request()).headers }))?.session.id, 'session-member');
      } finally { await admin.query('DELETE FROM session WHERE id=$1', [expiredId]); }
    });
    await check('actual Web and Mobile PATCH handlers return committed policy DTOs from the original requests', async () => {
      const { PATCH } = await import('../app/api/security/public-shares/[id]/route');
      const { PATCH: MOBILE_PATCH } = await import('../app/api/mobile/v1/files/shares/[id]/route'); assert.equal(MOBILE_PATCH, PATCH);
      for (const mobile of [false, true]) for (const cookie of [false, true]) {
        const target = await seed(), original = await request('member', cookie, target.id, { policyRevision: 1, reason: 'route update', expiresAt: null }, mobile);
        const response = await (mobile ? MOBILE_PATCH : PATCH)(original, { params: Promise.resolve({ id: target.id }) });
        assert.equal(response.status, 200); assert.equal(response.headers.has('set-cookie'), false);
        const body = await response.json(); assert.equal(body.success, true); assert.equal(body.share.id, target.id);
        assert.equal(body.share.reason, 'route update'); assert.equal(body.share.policyRevision, 2); assert.equal((await row(target.id)).policy_revision, 2);
      }
    });
    await check('actual PATCH rejects invalid wire policy fields and stale revisions without mutation', async () => {
      const { PATCH } = await import('../app/api/security/public-shares/[id]/route'); const target = await seed();
      for (const body of [null, [], { reason: 'missing revision' }, { policyRevision: 1.5 }, { policyRevision: 1, expiresAt: 'invalid' },
        { policyRevision: 1, expiresInDays: 366 }, { policyRevision: 1, expiresAt: null, expiresInDays: 0 },
        { policyRevision: 1, securityMode: 'bogus' }, { policyRevision: 1, reason: 3 }]) {
        const before = await row(target.id), writes = await writeProof();
        const response = await PATCH(await request('member', false, target.id, body), { params: Promise.resolve({ id: target.id }) });
        assert.equal(response.status, 400); assert.equal((await response.json()).success, false); assert.equal(response.headers.has('set-cookie'), false);
        assert.deepEqual(await row(target.id), before); assert.deepEqual(await writeProof(), writes);
      }
      const response = await PATCH(await request('member', false, target.id, { policyRevision: 2 }), { params: Promise.resolve({ id: target.id }) });
      assert.equal(response.status, 409); assert.equal((await response.json()).success, false);
    });
    await check('actual PATCH preserves relative expiry parsing and explicit never removal', async () => {
      const { PATCH } = await import('../app/api/security/public-shares/[id]/route'); const target = await seed(), before = Date.now();
      const response = await PATCH(await request('member', false, target.id, { policyRevision: 1, expiresInDays: 7 }), { params: Promise.resolve({ id: target.id }) });
      assert.equal(response.status, 200); const body = await response.json(), after = Date.now(), expires = new Date(body.share.expiresAt).getTime();
      assert(expires >= before + 7 * 86400000 && expires <= after + 7 * 86400000);
      const cleared = await PATCH(await request('member', false, target.id, { policyRevision: 2, expiresAt: 'never' }), { params: Promise.resolve({ id: target.id }) });
      assert.equal(cleared.status, 200); assert.equal((await cleared.json()).share.expiresAt, null); assert.equal((await row(target.id)).policy_revision, 3);
    });
    await check('genuine Project manager updates a historical share without backfilling optional customer/project pins', async () => {
      const target = await projectSeed(), before = await row(target.id); assert.equal(before.customer_id, null); assert.equal(before.project_id, null);
      const result = await updateProject(target.id, 'project policy'); assert(result); assert.equal(result.workspace.projectId, 'policy-project');
      assert.equal(result.row.policyRevision, 2); assert.equal(result.row.customerId, null); assert.equal(result.row.projectId, null);
      const after = await row(target.id); preserves(before, after); assert.equal(after.customer_id, null); assert.equal(after.project_id, null);
    });
    await admin.query('CREATE SEQUENCE fixture_capability_change_attempts');
    for (const capability of ['organization public links', 'Project manager'] as const)
    await check(`actual same-B trigger removal of ${capability} rolls back policy while canRead remains available`, async () => {
      const target = capability === 'Project manager' ? await projectSeed() : await seed(), before = await row(target.id), writes = await writeProof();
      const attempts = (await admin.query('SELECT last_value::text AS value,is_called FROM fixture_capability_change_attempts')).rows[0];
      const rights = capability === 'Project manager'
        ? "UPDATE canvas_project_members SET can_manage=0 WHERE project_id='policy-project' AND user_id='member' AND can_read=1 AND can_write=0 AND status='active'"
        : "UPDATE organization_user_permissions SET can_create_public_links=0 WHERE organization_id='policy-org' AND user_id='member' AND status='active' AND can_write_team_workspace=1";
      await admin.query(`CREATE FUNCTION fixture_change_public_capability() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id='${target.id}' THEN ${rights}; IF NOT FOUND THEN RAISE EXCEPTION 'Owned capability row was not changed'; END IF;
          PERFORM nextval('fixture_capability_change_attempts'); END IF; RETURN NEW; END $$`);
      await admin.query('CREATE TRIGGER fixture_change_public_capability AFTER UPDATE ON public_file_shares FOR EACH ROW EXECUTE FUNCTION fixture_change_public_capability()');
      try { await assert.rejects(capability === 'Project manager' ? updateProject(target.id, 'must roll back') : update(target.id, { reason: 'must roll back' }),
        expected('PUBLIC_SHARE_WRITE_DENIED')); }
      finally { await admin.query('DROP TRIGGER fixture_change_public_capability ON public_file_shares'); await admin.query('DROP FUNCTION fixture_change_public_capability()'); }
      const attempted = (await admin.query('SELECT last_value::text AS value,is_called FROM fixture_capability_change_attempts')).rows[0];
      assert.equal(BigInt(attempted.value), BigInt(attempts.value) + (attempts.is_called ? BigInt(1) : BigInt(0))); assert.equal(attempted.is_called, true);
      assert.deepEqual(await row(target.id), before); assert.equal(BigInt((await writeProof()).value), BigInt(writes.value) + BigInt(1));
      assert.equal((await admin.query("SELECT can_create_public_links FROM organization_user_permissions WHERE user_id='member'")).rows[0].can_create_public_links, 1);
      assert.equal((await admin.query("SELECT can_read=1 AND can_write=0 AND can_manage=1 AND status='active' AS original FROM canvas_project_members WHERE project_id='policy-project' AND user_id='member'")).rows[0].original, true);
    });
    await check('a full native binding is live without any physical projection and leaves native bytes unchanged', async () => {
      const target = await seed({ native: true, extension: '.md' }), before = await row(target.id), proof = await nativeProof(target);
      await assert.rejects(stat(target.fullPath), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
      const result = await update(target.id, { reason: 'native policy' }); assert.equal(result?.row.policyRevision, 2);
      const after = await row(target.id); preserves(before, after); assert.deepEqual(await nativeProof(target), proof);
      await assert.rejects(stat(target.fullPath), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
    });
    for (const drift of ['document', 'lineage', 'older generation', 'future generation', 'archived document', 'archived lineage', 'archived state'])
    await check(`native ${drift} cannot change policy or silently rebind the share`, async () => {
      const target = await seed({ native: true, extension: '.md' });
      if (drift === 'document') await admin.query('UPDATE public_file_shares SET document_id=$1 WHERE id=$2', [`missing-${crypto.randomUUID()}`, target.id]);
      if (drift === 'lineage') await admin.query('UPDATE public_file_shares SET lineage_id=$1 WHERE id=$2', [`different-${crypto.randomUUID()}`, target.id]);
      if (drift === 'older generation') await admin.query('UPDATE public_file_shares SET lifecycle_generation=4 WHERE id=$1', [target.id]);
      if (drift === 'future generation') await admin.query('UPDATE public_file_shares SET lifecycle_generation=6 WHERE id=$1', [target.id]);
      if (drift === 'archived document') await admin.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [target.documentId]);
      if (drift === 'archived lineage') await admin.query("UPDATE file_collaboration_lineages SET status='archived',archived_at=100 WHERE id=$1", [target.lineageId]);
      if (drift === 'archived state') await admin.query("UPDATE collaboration_yjs_states SET status='archived' WHERE document_id=$1", [target.documentId]);
      const proof = await nativeProof(target); await unchanged(target.id, () => update(target.id, { reason: 'must not rebind' }));
      assert.deepEqual(await nativeProof(target), proof);
    });
    await check('historical all-NULL share at a now-native path is rejected without backfilling pins', async () => {
      const target = await seed({ native: true, extension: '.md' }); await writeFile(target.fullPath, 'A physical projection cannot grant a native binding.');
      const observed = await stat(target.fullPath);
      await admin.query('UPDATE public_file_shares SET document_id=NULL,lineage_id=NULL,lifecycle_generation=NULL,file_identity=$1 WHERE id=$2',
        [`${observed.dev}:${observed.ino}:${observed.birthtimeMs}`, target.id]);
      const proof = await nativeProof(target); await unchanged(target.id, () => update(target.id, { reason: 'must not backfill' }));
      for (const key of ['document_id', 'lineage_id', 'lifecycle_generation']) assert.equal((await row(target.id))[key], null);
      assert.deepEqual(await nativeProof(target), proof);
    });
    for (const kind of ['missing', 'replacement inode', 'symbolic link']) await check(`physical ${kind} fails liveness even for a no-op`, async () => {
      const target = await seed();
      if (kind === 'missing') await unlink(target.fullPath);
      else {
        const held = `${target.fullPath}.held`; await rename(target.fullPath, held);
        if (kind === 'replacement inode') await writeFile(target.fullPath, 'Different original identity.');
        else await symlink(path.basename(held), target.fullPath);
      }
      await unchanged(target.id, () => update(target.id, {}));
    });
    const reservation = (target: Awaited<ReturnType<typeof seed>>, native = false) => {
      const actionPayloadText = JSON.stringify({ source: target.filePath, destination: `moved-${crypto.randomUUID()}.bin` });
      return { requestId: crypto.randomUUID(), actorId: 'owner', action: 'move' as const, actionPayloadText,
        actionDigest: collaborationAdmissionActionDigest('move', actionPayloadText),
        scopes: [{ workspaceId: 'policy-space', organizationId: 'policy-org', path: target.filePath, kind: 'exact' as const }],
        expectedDocuments: native ? [{ documentId: target.documentId, workspaceId: 'policy-space', organizationId: 'policy-org', path: target.filePath,
          representation: 'plain_text' as const, lifecycleGeneration: 5, schemaVersion: 1, status: 'active' as const }] : [] };
    };
    for (const native of [false, true]) await check(`actual ${native ? 'native document' : 'physical path'} reservation prevents policy and no-op changes`, async () => {
      const target = await seed({ native, extension: native ? '.md' : '.bin' }), other = await seed(), reserved = reservation(target, native);
      await admission.reserve(reserved);
      try {
        await unchanged(target.id, () => update(target.id, { reason: 'reserved' }), expected('PUBLIC_SHARE_WRITE_BUSY'));
        await unchanged(target.id, () => update(target.id, {}), expected('PUBLIC_SHARE_WRITE_BUSY'));
        assert.equal((await update(other.id, { reason: 'unrelated remains available' }))?.row.policyRevision, 2);
      } finally { await admission.cancel(reserved, 1); }
      assert.equal((await update(target.id, { reason: 'released' }))?.row.policyRevision, 2);
    });
    await check('actual exclusive workspace admission blocks policy before any DML', async () => {
      const target = await seed(), blocker = await ownClient();
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey('policy-space')]);
        await unchanged(target.id, () => update(target.id, { reason: 'blocked' }), expected('PUBLIC_SHARE_WRITE_BUSY'));
      } finally { await blocker.query('ROLLBACK'); await endClient(blocker); }
    });
    await check('native room ownership remains live and unchanged across a policy update', async () => {
      const target = await seed({ native: true, extension: '.md' }), client = await ownClient();
      let owner: Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>> | undefined;
      try {
        owner = await createCollaborationRoomOwnerSession(client);
        const held = await owner.acquire({ documentId: target.documentId, workspaceId: 'policy-space', organizationId: 'policy-org', path: target.filePath,
          representation: 'plain_text', lifecycleGeneration: 5, schemaVersion: 1 });
        const proof = await nativeProof(target); assert.equal((await update(target.id, { reason: 'room-safe policy' }))?.row.policyRevision, 2);
        owner.assertActive(held); assert.deepEqual(await nativeProof(target), proof);
      } finally { if (owner) { await owner.close(); clients.delete(client); } else await endClient(client); }
    });
    // Every observed/injected runtime query is the original statement against
    // this fixture's actual schema. No authority, SQL result or clock is mocked.
    const runtimeClient = (client: Client) => client !== admin && isOwnClient(client) && typeof Reflect.get(client, 'release') === 'function';
    const queryText = (args: unknown[]) => typeof args[0] === 'string' ? args[0].trim() : '';
    const queryValues = (args: unknown[]) => Array.isArray(args[1]) ? args[1] : [];
    const isShareUpdate = (sql: string) => /^UPDATE\s+"[^"\u0000]+"\."?public_file_shares"?\s/iu.test(sql);
    const isLockedShareRead = (sql: string) => /\bFROM\s+"[^"\u0000]+"\."?public_file_shares"?\s/iu.test(sql) && sql.endsWith(' FOR UPDATE NOWAIT');
    await check('original peer row lock yields real SQL55P03 and genuine PrincipalBusy without policy DML', async () => {
      const target = await seed(), blocker = await ownClient(), originalQuery = Client.prototype.query; let rawBusy = false;
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT id FROM public_file_shares WHERE id=$1 FOR UPDATE', [target.id]);
        Client.prototype.query = function (this: Client, ...args: unknown[]) {
          if (runtimeClient(this) && isLockedShareRead(queryText(args)) && queryValues(args).includes(target.id))
            return Promise.resolve(Reflect.apply(originalQuery, this, args)).catch(error => {
              rawBusy = !!error && typeof error === 'object' && Reflect.get(error, 'code') === '55P03'; throw error;
            });
          return Reflect.apply(originalQuery, this, args);
        } as typeof Client.prototype.query;
        await unchanged(target.id, () => update(target.id, { reason: 'blocked' }), error => error instanceof WorkspaceRequestPrincipalError && error.code === 'PRINCIPAL_BUSY');
      } finally { Client.prototype.query = originalQuery; await blocker.query('ROLLBACK'); await endClient(blocker); }
      assert(rawBusy); assert.equal((await update(target.id, { reason: 'released' }))?.row.policyRevision, 2);
    });
    await check('peer policy commit between original read and FOR UPDATE causes CHANGED before own DML', async () => {
      const target = await seed(), before = await row(target.id), originalQuery = Client.prototype.query; let changed = false, dml = 0;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = queryText(args), selected = runtimeClient(this) && queryValues(args).includes(target.id);
        if (selected && isShareUpdate(sql)) dml++;
        if (selected && isLockedShareRead(sql) && !changed) {
          changed = true;
          return admin.query("UPDATE public_file_shares SET policy_revision=policy_revision+1,reason='peer policy' WHERE id=$1", [target.id])
            .then(() => Reflect.apply(originalQuery, this, args));
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { await assert.rejects(update(target.id, { reason: 'stale desired value' }), expected('PUBLIC_SHARE_WRITE_CHANGED')); }
      finally { Client.prototype.query = originalQuery; }
      assert(changed); assert.equal(dml, 0); assert.deepEqual(await row(target.id), { ...before, policy_revision: 2, reason: 'peer policy' });
    });
    await check('two actual policy requests with one expected revision commit exactly one change', async () => {
      const target = await seed({ native: true, extension: '.md' }), before = await row(target.id), proof = await nativeProof(target), writes = await writeProof();
      const results = await Promise.allSettled([update(target.id, { reason: 'concurrent policy' }), update(target.id, { reason: 'concurrent policy' })]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      for (const result of results) {
        if (result.status === 'fulfilled') { assert(result.value); assert.equal(result.value.row.policyRevision, 2); }
        else assert(expected('PUBLIC_SHARE_WRITE_CHANGED')(result.reason)
          || result.reason instanceof WorkspaceRequestPrincipalError && result.reason.code === 'PRINCIPAL_BUSY');
      }
      const after = await row(target.id); assert.equal(after.policy_revision, 2); assert.equal(after.reason, 'concurrent policy'); preserves(before, after);
      assert.equal(BigInt((await writeProof()).value), BigInt(writes.value) + BigInt(1)); assert.deepEqual(await nativeProof(target), proof);
    });
    await check('physical path replacement after preparation is rejected by final held-FD liveness checks', async () => {
      const target = await seed(), originalQuery = Client.prototype.query; let replaced = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        if (runtimeClient(this) && isLockedShareRead(queryText(args)) && queryValues(args).includes(target.id) && !replaced) {
          replaced = true;
          return rename(target.fullPath, `${target.fullPath}.old`).then(() => writeFile(target.fullPath, 'A new identity after held FD capture.'))
            .then(() => Reflect.apply(originalQuery, this, args));
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { await unchanged(target.id, () => update(target.id, { reason: 'must not bind replacement' })); }
      finally { Client.prototype.query = originalQuery; }
      assert(replaced);
    });
    await check('caller mutation of its Date after capture cannot change the requested expiry', async () => {
      const target = await seed(), expiry = new Date(Date.now() + 3600000), captured = expiry.getTime(), originalQuery = Client.prototype.query; let changed = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        if (runtimeClient(this) && queryText(args) === 'BEGIN' && !changed) { changed = true; expiry.setTime(100); }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { assert.equal((await update(target.id, { expiresAt: expiry }))?.row.expiresAt?.getTime(), captured); }
      finally { Client.prototype.query = originalQuery; }
      assert(changed); assert.equal((await row(target.id)).expires_at, captured);
    });
    await check('a requested expiry that actually elapses inside B is rejected again before the narrow UPDATE', async () => {
      const target = await seed(), expiry = new Date(Date.now() + 2000), deadline = expiry.getTime(), originalQuery = Client.prototype.query;
      let entered = false, crossed = false, dml = 0;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = queryText(args), selected = runtimeClient(this) && queryValues(args).includes(target.id);
        if (selected && isShareUpdate(sql)) dml++;
        if (selected && isLockedShareRead(sql) && !entered) {
          entered = true; assert(Date.now() < deadline);
          return (async () => {
            while (Date.now() <= deadline) await new Promise(resolve => setTimeout(resolve, 1)); crossed = true;
            return Reflect.apply(originalQuery, this, args);
          })();
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { await unchanged(target.id, () => update(target.id, { expiresAt: expiry }), expected('PUBLIC_SHARE_WRITE_INVALID')); }
      finally { Client.prototype.query = originalQuery; }
      assert(entered); assert(crossed); assert.equal(dml, 0);
    });
    await check('actual constraint failure rolls the policy back and is never accepted as a domain denial', async () => {
      const target = await seed(), before = await row(target.id), writes = await writeProof();
      await admin.query("ALTER TABLE public_file_shares ADD CONSTRAINT fixture_policy_reject CHECK(reason IS DISTINCT FROM 'constraint rejection')");
      try { await assert.rejects(update(target.id, { reason: 'constraint rejection' }), error => !!error && typeof error === 'object'
        && Reflect.get(error, 'code') === '23514' && Reflect.get(error, 'constraint') === 'fixture_policy_reject'); }
      finally { await admin.query('ALTER TABLE public_file_shares DROP CONSTRAINT fixture_policy_reject'); }
      assert.deepEqual(await row(target.id), before); assert.equal(BigInt((await writeProof()).value), BigInt(writes.value) + BigInt(1));
    });
    for (const timing of ['BEFORE', 'AFTER']) await check(`actual ${timing} trigger mutation cannot bypass full result and reread validation`, async () => {
      const target = await seed(), before = await row(target.id), writes = await writeProof();
      await admin.query(`CREATE FUNCTION fixture_tamper_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.reason='requested value' THEN
          ${timing === 'BEFORE' ? "NEW.reason := 'trigger changed';" : "UPDATE public_file_shares SET reason='trigger changed' WHERE id=NEW.id;"}
        END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER fixture_tamper_policy ${timing} UPDATE ON public_file_shares FOR EACH ROW EXECUTE FUNCTION fixture_tamper_policy()`);
      try { await assert.rejects(update(target.id, { reason: 'requested value' }), expected('PUBLIC_SHARE_WRITE_CHANGED')); }
      finally { await admin.query('DROP TRIGGER fixture_tamper_policy ON public_file_shares'); await admin.query('DROP FUNCTION fixture_tamper_policy()'); }
      assert.deepEqual(await row(target.id), before);
      assert.equal(BigInt((await writeProof()).value), BigInt(writes.value) + (timing === 'BEFORE' ? BigInt(1) : BigInt(2)));
    });
    for (const phase of ['selection', 'final writer'] as const) await check(`genuine TEMP shadow in ${phase} is rejected with complete rollback cleanup`, async () => {
      const target = await seed(), originalQuery = Client.prototype.query;
      const held = new WeakSet<Client>();
      let begins = 0, injected = false, rolledBack = false, absent = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = queryText(args);
        if (runtimeClient(this) && sql === 'BEGIN') begins++;
        if (runtimeClient(this) && sql === 'BEGIN' && begins === (phase === 'selection' ? 1 : 2) && !injected) {
          injected = true; held.add(this);
          return Promise.resolve(Reflect.apply(originalQuery, this, args)).then(async result => {
            await Reflect.apply(originalQuery, this, ['CREATE TEMP TABLE public_file_shares (fixture_shadow integer) ON COMMIT DROP']); return result;
          });
        }
        if (held.has(this) && sql === 'ROLLBACK') return Promise.resolve(Reflect.apply(originalQuery, this, args)).then(async result => {
          rolledBack = true; const actual = await Reflect.apply(originalQuery, this, ["SELECT to_regclass('pg_temp.public_file_shares') IS NULL AS absent"]);
          absent = actual.rows[0].absent === true; return result;
        });
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { await unchanged(target.id, () => update(target.id, { reason: 'shadowed' })); }
      finally { Client.prototype.query = originalQuery; }
      assert(injected); assert(rolledBack); assert(absent);
    });
    await check('actual held public relation blocks concurrent trigger DDL while policy commits', async () => {
      const target = await seed(), peer = await ownClient(), originalQuery = Client.prototype.query; let attempted = false, ddlBusy = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        if (runtimeClient(this) && isShareUpdate(queryText(args)) && queryValues(args).includes(target.id) && !attempted) {
          attempted = true;
          return peer.query('ALTER TABLE public_file_shares DISABLE TRIGGER fixture_public_write_attempt').then(() => {
            assert.fail('The actual held relation must prevent trigger DDL.');
          }, error => { assert(error && typeof error === 'object' && Reflect.get(error, 'code') === '55P03'); ddlBusy = true; })
            .then(() => Reflect.apply(originalQuery, this, args));
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { assert.equal((await update(target.id, { reason: 'DDL-safe' }))?.row.policyRevision, 2); }
      finally { Client.prototype.query = originalQuery; await endClient(peer); }
      assert(attempted); assert(ddlBusy);
    });
    for (const mode of ['lost-ack', 'lost-ack-discard-throws', 'confirmed-commit-release-throws', 'route-lost-ack'] as const)
    await check(`actual policy COMMIT ${mode} never exposes success or blindly retries`, async () => {
      const target = await seed({ native: true, extension: '.md' }), before = await row(target.id), proof = await nativeProof(target), originalQuery = Client.prototype.query;
      const releases = new Map<Client, (error?: Error) => void>();
      const lostAck = Object.assign(new Error('Owned fixture lost only the reply of a successful actual policy COMMIT.'), { code: 'ECONNRESET' });
      const releaseError = new Error('Owned fixture lost only the actual policy checkout disposal reply.');
      let pid = 0, dml = 0, commits = 0, rollbacks = 0, disposals = 0, committed = false, disposed = false, discarded = false, published = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = queryText(args);
        if (runtimeClient(this) && isShareUpdate(sql) && queryValues(args).includes(target.id)) {
          dml++; pid = Number(Reflect.get(this, 'processID'));
          if (!releases.has(this)) {
            const release = Reflect.get(this, 'release') as (error?: Error) => void; releases.set(this, release);
            Reflect.set(this, 'release', (error?: Error) => {
              disposals++; discarded = error instanceof Error; const result = Reflect.apply(release, this, [error]); disposed = true;
              if (mode === 'lost-ack-discard-throws' || mode === 'confirmed-commit-release-throws') throw releaseError; return result;
            });
          }
        }
        if (releases.has(this)) {
          if (sql === 'ROLLBACK') rollbacks++;
          if (sql === 'COMMIT') { commits++; return Promise.resolve(Reflect.apply(originalQuery, this, args)).then(result => {
            committed = true; if (mode !== 'confirmed-commit-release-throws') throw lostAck; return result;
          }); }
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try {
        if (mode === 'route-lost-ack') {
          const { PATCH } = await import('../app/api/security/public-shares/[id]/route');
          const response = await PATCH(await request('member', false, target.id, { policyRevision: 1, reason: 'committed once' }), { params: Promise.resolve({ id: target.id }) });
          assert.equal(response.status, 503); assert.equal(response.headers.has('set-cookie'), false);
          const body = await response.json(); assert.equal(body.success, false); assert.equal(body.code, 'PUBLIC_SHARE_WRITE_COMMIT_UNCONFIRMED');
        } else await assert.rejects(update(target.id, { reason: 'committed once' }).then(value => { published = true; return value; }), error => {
          assert(error instanceof writer.PublicShareWriterCommitError); assert.equal(error.code, 'PUBLIC_SHARE_WRITE_COMMIT_UNCONFIRMED'); assert.equal(error.status, 503); return true;
        });
      } finally { Client.prototype.query = originalQuery; for (const [client, release] of releases) Reflect.set(client, 'release', release); }
      assert.equal(published, false); assert(committed); assert(disposed); assert.equal(discarded, mode !== 'confirmed-commit-release-throws');
      assert.equal(dml, 1); assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(disposals, 1); assert.equal(releases.size, 1); assert(pid > 0);
      if (discarded) {
        const deadline = Date.now() + 5000;
        while (!(await admin.query('SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent', [pid])).rows[0].absent) {
          assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      const after = await row(target.id); assert.equal(after.reason, 'committed once'); assert.equal(after.policy_revision, 2); preserves(before, after);
      assert.deepEqual(await nativeProof(target), proof);
      await unchanged(target.id, () => update(target.id, { reason: 'committed once' }));
      const writes = await writeProof(); assert.equal((await update(target.id, { expectedPolicyRevision: 2, reason: 'committed once' }))?.row.policyRevision, 2);
      assert.deepEqual(await row(target.id), after); assert.deepEqual(await writeProof(), writes);
    });
    assert.equal(passed, 65);
    assert.equal(fetches, 0); await own(); assert.equal(await sourceHash(), originalSourceHash);
    console.log('Public share policy SQL assertions complete:', JSON.stringify({ passed, fetches, sourceSha256: originalSourceHash }));
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
      const current = await stat(dataRoot); assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino); assert.equal(current.uid, rootIdentity.uid);
      await rm(dataRoot, { recursive: true }); await assert.rejects(stat(dataRoot), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT'); dataRemoved = true;
    });
    await cleanup(async () => { assert.equal(await sourceHash(), originalSourceHash); });
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    console.log('Public share policy owned cleanup:', JSON.stringify({ schemaRemoved, dataRemoved, openClients: clients.size, passed }));
    if (cleanupErrors.length) throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Owned public policy fixture cleanup failed.');
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  assert(schemaRemoved); assert(dataRemoved); complete = true;
  console.log('Public share policy PostgreSQL18 finished:', JSON.stringify({ passed, schemaRemoved, dataRemoved }));
}
main().catch(error => {
  const assertion = error instanceof assert.AssertionError ? error : null;
  const safeScalar = (value: unknown) => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const operators = ['strictEqual', 'deepStrictEqual', 'equal', 'notEqual', 'notStrictEqual', 'deepEqual', 'notDeepEqual', 'notDeepStrictEqual',
    'ok', '==', '===', '!=', '!==', 'rejects', 'throws', 'doesNotReject', 'doesNotThrow', 'match', 'doesNotMatch', 'fail'];
  const frame = error instanceof Error ? error.stack?.split('\n').find(line => /^\s+at\s/u.test(line) && line.includes(`${sourcePath}:`)) : undefined;
  const location = frame ? /:(\d+):(\d+)\)?$/u.exec(frame) : null;
  console.error('Owned public policy fixture failed:', { stage, passed, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null,
    ...(assertion ? { assertionOperator: operators.includes(assertion.operator) ? assertion.operator : 'other',
      actual: safeScalar(assertion.actual), expected: safeScalar(assertion.expected) } : {}),
    sourceFrame: location ? `${sourcePath}:${Number(location[1])}:${Number(location[2])}` : null }); process.exitCode = 1;
});
