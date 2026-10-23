import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import * as Y from 'yjs';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';

const sourcePath = path.resolve('scripts/public-share-create-postgres-test.ts');
const sourceHash = async () => crypto.createHash('sha256').update(await readFile(sourcePath)).digest('hex');

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', passed = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const originalSourceHash = await sourceHash();
  console.log('Public create source pin:', originalSourceHash);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `public_create_${crypto.randomUUID().replaceAll('-', '')}`, nonce = crypto.randomUUID();
  assert.match(schema, /^public_create_[a-f0-9]{32}$/u);
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-public-share-create-'))), rootIdentity = await stat(dataRoot);
  assert.equal(rootIdentity.uid, process.getuid!()); assert.equal(rootIdentity.mode & 0o077, 0);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>();
  let created = false, schemaOid = 0, schemaRemoved = false, dataRemoved = false, fetches = 0;
  let pool: { end: () => Promise<void> } | undefined, primaryFailure: unknown;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=public-create-fixture` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const check = async (name: string, operation: () => Promise<void>) => {
    stage = name; await operation(); passed++; console.log('Public create case passed:', JSON.stringify({ passed, name }));
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
      CANVAS_ORGANIZATION_ID: 'create-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'NEXT_PHASE', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'create-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true,
      organizationId: 'create-org', capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true }, seatLimit: 3, quotas: { users: 3 },
      entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('No network is permitted in the owned create fixture.'); };
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
      ('owner','Owner','owner@create.test',1,'admin',0,100,100),('member','Member','member@create.test',1,'user',0,100,100),
      ('other','Other','other@create.test',1,'user',0,100,100)`);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('create-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_create_public_links,created_at,updated_at)
      VALUES('create-org','owner','owner','active',1,1,100,100),('create-org','member','member','active',1,1,100,100),
      ('create-org','other','member','active',0,0,100,100)`);
    for (const userId of ['owner', 'member', 'other']) await admin.query(`INSERT INTO team_memberships
      (id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES($1,'create-org',$2,$3,$4,'active',100,100,100,100)`, [`seat-${userId}`, `${userId}@create.test`, userId, userId === 'owner' ? 'owner' : 'member']);
    await admin.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('create-org',100,100)");
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('create-space','create-org','organization',NULL,'Create','organizations/create-org/shared','active',100,100),
      ('foreign-space','create-org','personal','other','Other','users/other/workspace','active',100,100)`);
    await admin.query(`INSERT INTO canvas_customers(id,organization_id,name,slug,status,created_at,updated_at)
      VALUES('create-customer','create-org','Create Customer','create-customer','active',100,100)`);
    await admin.query(`INSERT INTO canvas_projects(id,organization_id,customer_id,name,slug,status,created_at,updated_at)
      VALUES('create-project','create-org','create-customer','Create Project','create-project','active',100,100)`);
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,customer_id,project_id,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('project-space','create-org','project','create-customer','create-project','Create Project','organizations/create-org/projects/create-project','active',100,100)`);
    await admin.query(`INSERT INTO canvas_project_members(organization_id,project_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at)
      VALUES('create-org','create-project','member','member','active',1,0,1,100,100)`);
    const tokens: Record<string, string> = {};
    for (const userId of ['owner', 'member', 'other']) {
      const token = crypto.randomBytes(32).toString('hex'); tokens[userId] = token;
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,100,100)`, [`session-${userId}`, token, userId, Date.now() + 3600000]);
    }
    await admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES('public-agent','Public','special','restricted','organization','create-org','["public_share_file"]',100,100)`);
    await admin.query(`INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,created_at,updated_at)
      VALUES('public-grant','public-agent','create-org','workspace','create-space',1,100,100)`);
    await admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,
      workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES('public-pi','member','public-agent','fixture','fixture','create-org','create-space','organization','Create','organizations/create-org/shared',100,100)`);
    const { auth } = await import('../app/lib/auth');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { withAgentToolInvocation, AgentToolInvocationError } = await import('../app/lib/pi/agent-tool-invocation');
    const { WorkspaceRequestPrincipalError } = await import('../app/lib/workspaces/request-principal');
    const { SeatLimitGuardError } = await import('../app/lib/license/seat-limit');
    const { AgentActorContextError } = await import('../app/lib/agents/actor-context');
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const writer = await import('../app/lib/public-sharing/writer');
    const sharing = await import('../app/lib/public-sharing/public-file-shares');
    const { PublicShareToolPolicyError } = await import('../app/lib/public-sharing/tool-policy');
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { writePiRuntimeConfig } = await import('../app/lib/agents/storage');
    const configure = (enabledTools: string[]) => writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG,
      activeProvider: 'openrouter', runtimeMigrations: { skillToolsDefaultEnabled: true },
      providers: { ...DEFAULT_PI_CONFIG.providers,
        openrouter: { ...DEFAULT_PI_CONFIG.providers.openrouter, enabledTools },
        anthropic: { ...DEFAULT_PI_CONFIG.providers.anthropic, enabledTools: ['__none__'] } } });
    await configure(['public_share_file']);
    const workspace = await readPostgresWorkspaceForActor({ userId: 'member', role: 'member' }, 'create-space'); assert(workspace);
    const project = await readPostgresWorkspaceForActor({ userId: 'member', role: 'member' }, 'project-space'); assert(project);
    assert.equal(project.projectId, 'create-project'); assert.equal(project.permissions.canManageWorkspace, true);
    await mkdir(workspace.rootPath, { recursive: true }); await mkdir(project.rootPath, { recursive: true });
    const request = async (userId = 'member', cookie = false, body?: unknown, mobile = false, workspaceId = 'create-space') => {
      const headers = new Headers({ 'x-canvas-workspace-id': workspaceId });
      if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens[userId], process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization', `Bearer ${tokens[userId]}`);
      if (body !== undefined) headers.set('content-type', 'application/json');
      return new NextRequest(`http://localhost${mobile ? '/api/mobile/v1/files/shares' : '/api/security/public-shares'}`,
        { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    for (const userId of ['owner', 'member', 'other']) assert.equal((await auth.api.getSession({ headers: (await request(userId)).headers }))?.session.id, `session-${userId}`);
    const origin = (): AgentExecutionContext => ({ userId: 'member', sessionId: 'public-pi', agentId: 'public-agent',
      agentTurnId: 'public-create-turn', workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType,
      workspaceName: workspace.displayName ?? null, organizationId: workspace.organizationId ?? null,
      customerId: workspace.customerId ?? null, projectId: workspace.projectId ?? null, workspaceRoot: workspace.rootPath,
      workspaceRootRelativePath: workspace.rootRelativePath ?? null, legacy: false, canWrite: false, canDelete: false, canShare: false });
    const agent = <T>(operation: () => Promise<T>, toolName = 'public_share_file') => {
      const current = origin(); return runWithAgentExecutionContext(current, () => withAgentToolInvocation(current,
        { toolName, toolCallId: `create-${crypto.randomUUID()}` }, operation));
    };
    await admin.query('CREATE SEQUENCE fixture_public_write_attempts');
    await admin.query(`CREATE FUNCTION fixture_count_public_writes() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('fixture_public_write_attempts'); RETURN NULL; END $$`);
    await admin.query(`CREATE TRIGGER fixture_public_write_attempt BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON public_file_shares FOR EACH STATEMENT EXECUTE FUNCTION fixture_count_public_writes()`);
    const writeProof = async () => {
      const value = (await admin.query('SELECT last_value::text AS value,is_called FROM fixture_public_write_attempts')).rows[0];
      return value.is_called ? BigInt(value.value) : BigInt(0);
    };
    const row = async (id: string) => (await admin.query('SELECT to_jsonb(s) AS row FROM public_file_shares s WHERE id=$1', [id])).rows[0]?.row as Row | undefined;
    const allRows = async () => (await admin.query('SELECT to_jsonb(s) AS row FROM public_file_shares s ORDER BY id')).rows.map(value => value.row) as Row[];
    const pathRows = async (filePath: string) => (await admin.query('SELECT to_jsonb(s) AS row FROM public_file_shares s WHERE workspace_path=$1 ORDER BY created_at,id', [filePath])).rows.map(value => value.row) as Row[];
    type Create = Parameters<typeof sharing.createPublicFileShares>[0];
    const create = async (paths: string[], changes: Partial<Create> = {}, userId = 'member', cookie = false, workspaceId = 'create-space') =>
      sharing.createPublicFileShares({ paths, request: await request(userId, cookie, undefined, false, workspaceId), workspaceId,
        createdByUserId: userId, workspace: workspaceId === 'project-space' ? project : workspace, ...changes });
    const createAgent = (paths: string[], changes: Partial<Create> = {}) => agent(() => sharing.createPublicFileShares({ paths,
      source: 'agent', workspaceId: 'create-space', reason: 'Explicit owned publication', confirmPublicExposure: true, ...changes }));
    const one = (result: Awaited<ReturnType<typeof create>>) => {
      assert.equal(result.skipped.length, 0); assert.equal(result.shares.length, 1); return result.shares[0];
    };
    const physical = async (extension = '.bin', prefix = '', suffix = '', projectTarget = false) => {
      const filePath = `${prefix}create-${crypto.randomUUID()}${extension}${suffix}`;
      const fullPath = path.join(projectTarget ? project.rootPath : workspace.rootPath, filePath);
      await writeFile(fullPath, extension === '.html' ? '<p>Owned physical publication.</p>' : 'Owned physical publication.');
      return { filePath, fullPath };
    };
    type Native = { filePath: string; fullPath: string; documentId: string; lineageId: string; bytes: number;
      representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' };
    const nativeAt = async (filePath: string, representation: Native['representation'] = 'plain_text'): Promise<Native> => {
      const documentId = `native-${crypto.randomUUID()}`, lineageId = `lineage-${crypto.randomUUID()}`;
      const doc = representation === 'plain_text' ? new Y.Doc() : createRichMarkdownYDoc('# Owned native publication\n\nA real rich paragraph.\n', representation);
      let update: Buffer, vector: Buffer;
      try {
        if (representation === 'plain_text') doc.getText('content').insert(0, 'Owned native publication.');
        update = Buffer.from(Y.encodeStateAsUpdate(doc)); vector = Buffer.from(Y.encodeStateVector(doc));
      } finally { doc.destroy(); }
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,'create-space','organization','create-org',$2,'active',100)`, [lineageId, filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,'create-space','organization','create-org',$3,'yjs',7,'initialized','active',100,100)`, [documentId, lineageId, filePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,'create-space','create-org',$2,$3,5,1,$4,$5,7,100,7,100,'fixture','fixture','lf',0,0,'active')`,
      [documentId, filePath, representation, update!, vector!]);
      return { filePath, fullPath: path.join(workspace.rootPath, filePath), documentId, lineageId, bytes: update!.byteLength, representation };
    };
    const native = (representation: Native['representation'] = 'plain_text') => nativeAt(`create-${crypto.randomUUID()}.md`, representation);
    const nativeProof = async (target: Native) => (await admin.query(`SELECT jsonb_build_object(
      'document',(SELECT to_jsonb(d) FROM collaboration_documents d WHERE d.id=$1),
      'lineage',(SELECT to_jsonb(l) FROM file_collaboration_lineages l WHERE l.id=$2),
      'state',(SELECT to_jsonb(s) FROM collaboration_yjs_states s WHERE s.document_id=$1)) AS snapshot`, [target.documentId, target.lineageId])).rows[0].snapshot as Row;
    const noFile = async (fullPath: string) => assert.rejects(stat(fullPath), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
    const expected = (code: InstanceType<typeof writer.PublicShareWriterError>['code']) => (error: unknown) => error instanceof writer.PublicShareWriterError && error.code === code;
    const authorityFailure = (error: unknown) => error instanceof WorkspaceRequestPrincipalError || error instanceof SeatLimitGuardError
      || error instanceof AgentActorContextError || error instanceof AgentToolInvocationError || error instanceof PublicShareToolPolicyError
      || expected('PUBLIC_SHARE_WRITE_DENIED')(error);
    const rejectsWithoutWrites = async (operation: () => Promise<unknown>, predicate = authorityFailure) => {
      const before = await allRows(), writes = await writeProof(); await assert.rejects(operation(), predicate);
      assert.deepEqual(await allRows(), before); assert.equal(await writeProof(), writes);
    };
    const skippedWithoutWrites = async (filePath: string, operation = () => create([filePath])) => {
      const before = await allRows(), writes = await writeProof(), result = await operation();
      assert.equal(result.shares.length, 0); assert.equal(result.skipped.length, 1); assert.equal(result.skipped[0].path, filePath);
      assert.deepEqual(await allRows(), before); assert.equal(await writeProof(), writes);
    };
    // Real SQL calls are observed or faulted only on this fixture's actual
    // checked-out clients. No authority, native state, query result or clock is mocked.
    const runtimeClient = (client: Client) => client !== admin && isOwnClient(client) && typeof Reflect.get(client, 'release') === 'function';
    const queryText = (args: unknown[]) => typeof args[0] === 'string' ? args[0].trim() : '';
    const queryValues = (args: unknown[]) => Array.isArray(args[1]) ? args[1] : [];
    const isShareInsert = (sql: string) => /^INSERT INTO\s+"[^"\u0000]+"\."?public_file_shares"?\s/iu.test(sql);
    for (const cookie of [false, true]) await check(`genuine Web ${cookie ? 'Cookie' : 'Bearer'} writer creates one physical share`, async () => {
      const target = await physical(), before = await stat(target.fullPath), writes = await writeProof();
      const result = await writer.createPublicSharesForRequest(await request('member', cookie), { paths: [target.filePath], workspaceId: 'create-space' });
      assert.equal(result.skipped.length, 0); assert.equal(result.shares.length, 1);
      const published = result.shares[0], stored = await row(published.row.id); assert(stored);
      assert.equal(published.workspace.workspaceId, 'create-space'); assert.equal(stored.created_by_user_id, 'member'); assert.equal(stored.source, 'ui');
      assert.equal(stored.created_by_agent_id, null); assert.equal(stored.source_session_id, null); assert.equal(stored.policy_revision, 1);
      assert.equal(stored.file_identity, `${before.dev}:${before.ino}:${before.birthtimeMs}`); assert.equal(stored.size_bytes, before.size);
      for (const key of ['document_id', 'lineage_id', 'lifecycle_generation']) assert.equal(stored[key], null);
      assert.equal(await writeProof(), writes + BigInt(1)); assert.equal(published.row.securityMode, 'strict'); assert(published.row.shortCode);
    });
    await check('legacy actor/workspace claims cannot publish without a genuine request or invocation', async () => {
      const target = await physical(), before = await allRows(), writes = await writeProof(); let resolved = false;
      try { await rejectsWithoutWrites(() => sharing.createPublicFileShares({ paths: [target.filePath], createdByUserId: 'member', workspace,
        confirmPublicExposure: true }).then(value => { resolved = true; return value; }), expected('PUBLIC_SHARE_WRITE_INVALID')); }
      finally { console.log('Public create dispatcher forgery actual SQL witness:', JSON.stringify({ resolved,
        rowChanged: !isDeepStrictEqual(before, await allRows()), attemptedWrite: await writeProof() !== writes })); }
    });
    await check('actual request determines creator despite forged historical source claims', async () => {
      const target = await physical(), result = one(await create([target.filePath], { createdByUserId: 'owner', createdByAgentId: 'forged-agent', sourceSessionId: 'forged-pi' }));
      const stored = await row(result.id); assert(stored); assert.equal(stored.created_by_user_id, 'member');
      assert.equal(stored.source, 'ui'); assert.equal(stored.created_by_agent_id, null); assert.equal(stored.source_session_id, null);
    });
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) await check(`native ${representation} binds actual bytes without projection or native mutation`, async () => {
      const target = await native(representation), proof = await nativeProof(target); await noFile(target.fullPath);
      const result = one(await create([target.filePath])), stored = await row(result.id); assert(stored);
      assert.equal(stored.document_id, target.documentId); assert.equal(stored.lineage_id, target.lineageId); assert.equal(stored.lifecycle_generation, 5);
      assert.equal(stored.size_bytes, target.bytes); assert.equal(result.sizeBytes, target.bytes); assert.equal(Reflect.get(result, 'sizeKind'), 'native-state');
      assert.equal(stored.file_identity, `native:${crypto.createHash('sha256').update(JSON.stringify([target.documentId, target.lineageId, 5])).digest('hex')}`);
      assert.match(String(stored.last_known_revision), /^native:5:7:yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u);
      assert.deepEqual(await nativeProof(target), proof); await noFile(target.fullPath);
    });
    await check('renamed native docx remains a native target independent of suffix', async () => {
      const target = await native('tiptap_xml'), renamedPath = `${target.filePath}.docx`;
      await admin.query('UPDATE file_collaboration_lineages SET path=$1 WHERE id=$2', [renamedPath, target.lineageId]);
      await admin.query('UPDATE collaboration_documents SET path=$1 WHERE id=$2', [renamedPath, target.documentId]);
      await admin.query('UPDATE collaboration_yjs_states SET path=$1 WHERE document_id=$2', [renamedPath, target.documentId]);
      const proof = await nativeProof(target), result = one(await create([renamedPath])), stored = await row(result.id); assert(stored);
      assert.equal(stored.document_id, target.documentId); assert.equal(stored.workspace_path, renamedPath); assert.equal(stored.size_bytes, target.bytes);
      assert.equal(Reflect.get(result, 'sizeKind'), 'native-state'); assert.deepEqual(await nativeProof(target), proof);
      await noFile(path.join(workspace.rootPath, renamedPath));
    });
    await check('no-op reuse preserves token, original pins, source, access and password without DML', async () => {
      const target = await native(), first = one(await create([target.filePath], { expiresAt: new Date(Date.now() + 3600000) }));
      await admin.query("UPDATE public_file_shares SET access_count=7,last_accessed_at=150,password_enabled=1,password_hash='fixture-password',source='agent',created_by_agent_id='historical-agent',source_session_id='historical-pi' WHERE id=$1", [first.id]);
      const before = await row(first.id), proof = await nativeProof(target), writes = await writeProof();
      const again = one(await create([target.filePath], { defaultExpiresAt: new Date(Date.now() + 86400000) }));
      assert.equal(again.id, first.id); assert.equal(again.publicUrl, first.publicUrl); assert.equal(again.shortUrl, first.shortUrl);
      assert.deepEqual(await row(first.id), before); assert.equal(await writeProof(), writes); assert.deepEqual(await nativeProof(target), proof);
    });
    await check('explicit NULL removes expiry on reuse while a default applies only to a new row', async () => {
      const target = await physical(), future = new Date(Date.now() + 3600000), first = one(await create([target.filePath], { defaultExpiresAt: future }));
      assert.equal((await row(first.id))?.expires_at, future.getTime());
      const again = one(await create([target.filePath], { expiresAt: null, defaultExpiresAt: new Date(Date.now() + 86400000) }));
      assert.equal(again.id, first.id); assert.equal(again.publicUrl, first.publicUrl); assert.equal(again.policyRevision, 2);
      assert.equal((await row(first.id))?.expires_at, null); assert.equal((await row(first.id))?.access_count, 0);
    });
    await check('explicit reuse assigns a missing legacy short code without changing any other column', async () => {
      const target = await physical(), first = one(await create([target.filePath]));
      await admin.query('UPDATE public_file_shares SET short_code=NULL WHERE id=$1', [first.id]);
      const before = await row(first.id), writes = await writeProof(), again = one(await create([target.filePath])); assert(before);
      const after = await row(first.id); assert(after); assert.equal(again.id, first.id); assert.match(String(after.short_code), /^[A-Za-z0-9]+$/u);
      assert.deepEqual(after, { ...before, short_code: after.short_code }); assert.equal(await writeProof(), writes + BigInt(1));
    });
    for (const replacement of ['physical replacement', 'expired', 'all-NULL to native'] as const) await check(`republish ${replacement} revokes old token and inserts new token atomically`, async () => {
      const target = await physical('.md'), first = one(await create([target.filePath])); let nativeTarget: Native | undefined;
      if (replacement === 'physical replacement') { await rename(target.fullPath, `${target.fullPath}.old`); await writeFile(target.fullPath, 'New original physical identity.'); }
      if (replacement === 'expired') await admin.query('UPDATE public_file_shares SET expires_at=100 WHERE id=$1', [first.id]);
      if (replacement === 'all-NULL to native') nativeTarget = await nativeAt(target.filePath);
      const before = await row(first.id), writes = await writeProof(), second = one(await create([target.filePath])); assert(before);
      assert.notEqual(second.id, first.id); assert.notEqual(second.publicUrl, first.publicUrl); assert.notEqual(second.shortUrl, first.shortUrl);
      const after = await row(first.id); assert(after); assert.equal(after.status, 'revoked'); assert.equal(after.policy_revision, 2);
      assert.equal(after.revoked_reason, replacement === 'expired' ? 'republished_expired' : 'republished_stale');
      for (const key of Object.keys(before).filter(key => !['status', 'policy_revision', 'revoked_at', 'revoked_reason', 'updated_at'].includes(key))) assert.deepEqual(after[key], before[key]);
      assert.equal((await pathRows(target.filePath)).filter(value => value.status === 'active').length, 1);
      assert.equal(await writeProof(), writes + BigInt(2));
      if (nativeTarget) assert.equal((await row(second.id))?.document_id, nativeTarget.documentId);
    });
    await check('a failed replacement INSERT rolls back the preceding old-token revoke', async () => {
      const target = await physical(), first = one(await create([target.filePath])); await rename(target.fullPath, `${target.fullPath}.old`); await writeFile(target.fullPath, 'Replacement.');
      const before = await allRows(), writes = await writeProof();
      await admin.query("ALTER TABLE public_file_shares ADD CONSTRAINT fixture_create_reject CHECK(reason IS DISTINCT FROM 'constraint rejection')");
      try { await assert.rejects(create([target.filePath], { reason: 'constraint rejection' }), error => !!error && typeof error === 'object'
        && Reflect.get(error, 'code') === '23514' && Reflect.get(error, 'constraint') === 'fixture_create_reject'); }
      finally { await admin.query('ALTER TABLE public_file_shares DROP CONSTRAINT fixture_create_reject'); }
      assert.deepEqual(await allRows(), before); assert.equal((await row(first.id))?.status, 'active'); assert.equal(await writeProof(), writes + BigInt(2));
    });
    await check('strict management is required even for a compatible no-op in a project', async () => {
      const target = await physical('.bin', '', '', true), first = one(await create([target.filePath], {}, 'owner', false, 'project-space'));
      await admin.query("UPDATE canvas_project_members SET can_manage=0 WHERE project_id='create-project' AND user_id='member'");
      try { await rejectsWithoutWrites(() => create([target.filePath], {}, 'member', false, 'project-space'), expected('PUBLIC_SHARE_WRITE_DENIED')); }
      finally { await admin.query("UPDATE canvas_project_members SET can_manage=1 WHERE project_id='create-project' AND user_id='member'"); }
      assert.equal((await row(first.id))?.policy_revision, 1);
    });
    await check('genuine Agent invocation and stored tool grant determine provenance rather than caller flags', async () => {
      const target = await physical(), result = one(await createAgent([target.filePath], { createdByUserId: 'owner', createdByAgentId: 'forged-agent', sourceSessionId: 'forged-session' }));
      const stored = await row(result.id); assert(stored); assert.equal(stored.created_by_user_id, 'member'); assert.equal(stored.source, 'agent');
      assert.equal(stored.created_by_agent_id, 'public-agent'); assert.equal(stored.source_session_id, 'public-pi');
      assert.equal(stored.reason, 'Explicit owned publication');
    });
    await check('Agent native publication uses the current actual native binding with no projection', async () => {
      const target = await native('tiptap_blocks'), proof = await nativeProof(target), result = one(await createAgent([`/data/workspace/${target.filePath}`]));
      assert.equal((await row(result.id))?.document_id, target.documentId); assert.equal(result.sizeBytes, target.bytes);
      assert.deepEqual(await nativeProof(target), proof); await noFile(target.fullPath);
    });
    await check('ordinary Agent ALS or a different genuine tool cannot authorize publication', async () => {
      const target = await physical(), input: Create = { paths: [target.filePath], source: 'agent', workspaceId: 'create-space', reason: 'Explicit owned publication', confirmPublicExposure: true };
      await rejectsWithoutWrites(() => sharing.createPublicFileShares(input), error => error instanceof AgentToolInvocationError && error.code === 'AGENT_TOOL_INVOCATION_REQUIRED');
      await rejectsWithoutWrites(() => runWithAgentExecutionContext(origin(), () => sharing.createPublicFileShares(input)), error => error instanceof AgentToolInvocationError && error.code === 'AGENT_TOOL_INVOCATION_REQUIRED');
      await rejectsWithoutWrites(() => agent(() => sharing.createPublicFileShares(input), 'not_public_share_file'), expected('PUBLIC_SHARE_WRITE_DENIED'));
    });
    for (const missing of ['consent', 'reason', 'tool policy', 'stored tool', 'agent grant'] as const) await check(`Agent publication requires current ${missing}`, async () => {
      const target = await physical();
      if (missing === 'stored tool') await admin.query("UPDATE agents SET enabled_tools_json='[\"__none__\"]' WHERE agent_id='public-agent'");
      if (missing === 'agent grant') await admin.query("UPDATE agent_grants SET can_use=0 WHERE id='public-grant'");
      try {
        if (missing === 'tool policy') {
          await admin.query("UPDATE agents SET enabled_tools_json=NULL WHERE agent_id='public-agent'");
          await configure(['public_share_file']);
          const inherited = await physical(), positive = one(await createAgent([inherited.filePath]));
          assert.equal((await row(positive.id))?.created_by_agent_id, 'public-agent');
          await configure(['__none__']);
        }
        await rejectsWithoutWrites(() => createAgent([target.filePath], missing === 'consent' ? { confirmPublicExposure: false } : missing === 'reason' ? { reason: '   ' } : {}),
        error => authorityFailure(error) || missing === 'agent grant' && error instanceof Error
          && error.constructor === Error && error.message === 'Agent access is no longer available in this workspace.'); }
      finally {
        if (missing === 'tool policy') {
          await configure(['public_share_file']);
          await admin.query("UPDATE agents SET enabled_tools_json='[\"public_share_file\"]' WHERE agent_id='public-agent'");
        }
        if (missing === 'stored tool') await admin.query("UPDATE agents SET enabled_tools_json='[\"public_share_file\"]' WHERE agent_id='public-agent'");
        if (missing === 'agent grant') await admin.query("UPDATE agent_grants SET can_use=1 WHERE id='public-grant'");
      }
    });
    await check('current public-create permission is required for Web and Agent, including reuse', async () => {
      const target = await physical(), result = one(await create([target.filePath]));
      await admin.query("UPDATE organization_user_permissions SET can_create_public_links=0 WHERE user_id='member'");
      try { await rejectsWithoutWrites(() => create([target.filePath]), expected('PUBLIC_SHARE_WRITE_DENIED'));
        await rejectsWithoutWrites(() => createAgent([target.filePath]), expected('PUBLIC_SHARE_WRITE_DENIED')); }
      finally { await admin.query("UPDATE organization_user_permissions SET can_create_public_links=1 WHERE user_id='member'"); }
      assert.equal((await row(result.id))?.policy_revision, 1);
    });
    await check('Agent cannot create interactive exposure but can reuse existing physical interactive HTML unchanged', async () => {
      const target = await physical('.html');
      await rejectsWithoutWrites(() => createAgent([target.filePath], { securityMode: 'interactive' }), expected('PUBLIC_SHARE_WRITE_DENIED'));
      const first = one(await create([target.filePath], { securityMode: 'interactive', reason: 'Explicit owned publication' })), before = await row(first.id), writes = await writeProof();
      const again = one(await createAgent([target.filePath])); assert.equal(again.id, first.id); assert.equal(again.securityMode, 'interactive');
      assert.deepEqual(await row(first.id), before); assert.equal(await writeProof(), writes);
    });
    await check('a native HTML suffix cannot enable executable interactive sharing', async () => {
      const target = await nativeAt(`create-${crypto.randomUUID()}.html`), proof = await nativeProof(target);
      await skippedWithoutWrites(target.filePath, () => create([target.filePath], { securityMode: 'interactive' }));
      assert.deepEqual(await nativeProof(target), proof); await noFile(target.fullPath);
    });
    await check('leading and trailing filename spaces select the exact original physical file', async () => {
      const target = await physical('.bin', ' ', ' '), trimmed = target.filePath.trim(); await writeFile(path.join(workspace.rootPath, trimmed), 'A different neighboring exact name.');
      const observed = await stat(target.fullPath), result = one(await create([target.filePath])), stored = await row(result.id); assert(stored);
      assert.equal(stored.workspace_path, target.filePath); assert.equal(stored.file_name, target.filePath); assert.equal(stored.file_identity, `${observed.dev}:${observed.ino}:${observed.birthtimeMs}`);
      assert.equal((await pathRows(trimmed)).length, 0);
    });
    await check('sensitive, noncanonical and symlink targets are skipped without publication DML', async () => {
      const target = await physical(), symbolic = `symbolic-${crypto.randomUUID()}.bin`;
      await symlink(target.filePath, path.join(workspace.rootPath, symbolic)); await writeFile(path.join(workspace.rootPath, 'Canvas-Secrets.env'), 'OWNED_FIXTURE=value');
      for (const filePath of [symbolic, 'Canvas-Secrets.env', '../outside.bin', './noncanonical.bin', 'missing.bin']) await skippedWithoutWrites(filePath);
    });
    const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { collaborationAdmissionActionDigest, collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const admission = createCollaborationAdmissionService({ openConnection: database.openDb });
    for (const useNative of [false, true]) await check(`actual ${useNative ? 'native' : 'physical'} lifecycle reservation prevents publication`, async () => {
      const nativeTarget = useNative ? await native() : null;
      const target = nativeTarget ?? await physical(), other = await physical();
      const actionPayloadText = JSON.stringify({ source: target.filePath, destination: `moved-${crypto.randomUUID()}.bin` });
      const reserved = { requestId: crypto.randomUUID(), actorId: 'owner', action: 'move' as const, actionPayloadText,
        actionDigest: collaborationAdmissionActionDigest('move', actionPayloadText),
        scopes: [{ workspaceId: 'create-space', organizationId: 'create-org', path: target.filePath, kind: 'exact' as const }],
        expectedDocuments: nativeTarget ? [{ documentId: nativeTarget.documentId, workspaceId: 'create-space', organizationId: 'create-org', path: target.filePath,
          representation: 'plain_text' as const, lifecycleGeneration: 5, schemaVersion: 1, status: 'active' as const }] : [] };
      await admission.reserve(reserved);
      try { await skippedWithoutWrites(target.filePath); assert.equal(one(await create([other.filePath])).status, 'active'); }
      finally { await admission.cancel(reserved, 1); }
      assert.equal(one(await create([target.filePath])).status, 'active');
    });
    await check('actual exclusive workspace admission blocks physical publication without DML', async () => {
      const target = await physical(), blocker = await ownClient();
      try { await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey('create-space')]);
        await skippedWithoutWrites(target.filePath); }
      finally { await blocker.query('ROLLBACK'); await endClient(blocker); }
    });
    for (const phase of ['selection', 'final writer'] as const) await check(`real TEMP shadow in ${phase} is rejected with actual rollback cleanup`, async () => {
      const target = await physical(), originalQuery = Client.prototype.query, held = new WeakSet<Client>();
      let transactions = 0, injected = false, rolledBack = false, absent = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = queryText(args);
        if (runtimeClient(this) && sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE') transactions++;
        if (runtimeClient(this) && sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE' && transactions === (phase === 'selection' ? 1 : 2) && !injected) {
          injected = true; held.add(this);
          return Promise.resolve(Reflect.apply(originalQuery, this, args)).then(async result => {
            await Reflect.apply(originalQuery, this, ['CREATE TEMP TABLE public_file_shares (fixture_shadow integer) ON COMMIT DROP']); return result;
          });
        }
        if (held.has(this) && sql === 'ROLLBACK') return Promise.resolve(Reflect.apply(originalQuery, this, args)).then(async result => {
          rolledBack = true; absent = (await Reflect.apply(originalQuery, this, ["SELECT to_regclass('pg_temp.public_file_shares') IS NULL AS absent"])).rows[0].absent === true; return result;
        });
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try { await skippedWithoutWrites(target.filePath, async () => {
        const result = await create([target.filePath]);
        assert.equal(result.skipped[0]?.reason, new writer.PublicShareWriterError('PUBLIC_SHARE_WRITE_CHANGED').message);
        return result;
      }); }
      finally { Client.prototype.query = originalQuery; }
      assert(injected); assert(rolledBack); assert(absent);
    });
    for (const timing of ['BEFORE', 'AFTER']) await check(`actual ${timing} INSERT trigger mutation is detected and rolled back`, async () => {
      const target = await physical(), before = await allRows(), writes = await writeProof();
      await admin.query(`CREATE FUNCTION fixture_tamper_create() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.reason='requested value' THEN ${timing === 'BEFORE' ? "NEW.reason := 'trigger changed';" : "UPDATE public_file_shares SET reason='trigger changed' WHERE id=NEW.id;"}
        END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER fixture_tamper_create ${timing} INSERT ON public_file_shares FOR EACH ROW EXECUTE FUNCTION fixture_tamper_create()`);
      try {
        const result = await create([target.filePath], { reason: 'requested value' }); assert.equal(result.shares.length, 0); assert.equal(result.skipped.length, 1);
      } finally { await admin.query('DROP TRIGGER fixture_tamper_create ON public_file_shares'); await admin.query('DROP FUNCTION fixture_tamper_create()'); }
      assert.deepEqual(await allRows(), before); assert.equal(await writeProof(), writes + (timing === 'BEFORE' ? BigInt(1) : BigInt(2)));
    });
    await check('an actual short-code uniqueness collision allocates another candidate on the same transaction', async () => {
      const templateTarget = await physical(), template = one(await create([templateTarget.filePath])), target = await physical();
      const originalQuery = Client.prototype.query; let injected = false, inserts = 0, collidedCode: string | undefined;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const values = queryValues(args);
        if (runtimeClient(this) && isShareInsert(queryText(args)) && values.includes(target.filePath)) {
          inserts++;
          if (!injected) {
            injected = true; assert.equal(typeof values[4], 'string'); collidedCode = String(values[4]);
            const peerToken = crypto.randomBytes(32).toString('base64url');
            const overrides = { id: crypto.randomUUID(), token: peerToken, token_hash: crypto.createHash('sha256').update(peerToken).digest('hex'),
              token_preview: peerToken.slice(0, 8), short_code: collidedCode, workspace_path: `collision-peer-${crypto.randomUUID()}.bin` };
            return admin.query(`INSERT INTO public_file_shares SELECT (jsonb_populate_record(NULL::public_file_shares,to_jsonb(s)||$1::jsonb)).*
              FROM public_file_shares s WHERE id=$2`, [JSON.stringify(overrides), template.id]).then(() => Reflect.apply(originalQuery, this, args));
          }
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      let result: ReturnType<typeof one>;
      try { result = one(await create([target.filePath])); }
      finally { Client.prototype.query = originalQuery; }
      assert(injected); assert.equal(inserts, 2); assert.notEqual((await row(result!.id))?.short_code, collidedCode);
      assert.equal((await pathRows(target.filePath)).filter(value => value.status === 'active').length, 1);
    });
    for (const broken of ['archived lineage', 'missing state', 'invalid persisted bytes'] as const) await check(`native ${broken} cannot publish or alter stored state`, async () => {
      const target = await native();
      if (broken === 'archived lineage') await admin.query("UPDATE file_collaboration_lineages SET status='archived',archived_at=100 WHERE id=$1", [target.lineageId]);
      if (broken === 'missing state') await admin.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId]);
      if (broken === 'invalid persisted bytes') await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$1 WHERE document_id=$2', [Buffer.from([255, 255, 255]), target.documentId]);
      const proof = await nativeProof(target); await skippedWithoutWrites(target.filePath); assert.deepEqual(await nativeProof(target), proof); await noFile(target.fullPath);
    });
    for (const mobile of [false, true]) await check(`actual ${mobile ? 'Mobile' : 'Web'} POST creates and reuses with new-row-only default expiry`, async () => {
      const target = await physical('.html'), { POST } = mobile
        ? await import('../app/api/mobile/v1/files/shares/route') : await import('../app/api/security/public-shares/route');
      const started = Date.now(), response = await POST(await request('member', mobile, { paths: [target.filePath], reason: 'HTTP create' }, mobile));
      assert.equal(response.status, 200); assert.equal(response.headers.has('set-cookie'), false);
      const body = await response.json(); assert.equal(body.success, true); assert.equal(body.skipped.length, 0); assert.equal(body.shares.length, 1);
      const first = body.shares[0], before = await row(first.id); assert(before);
      assert.equal(before.created_by_user_id, 'member'); assert.equal(before.source, 'ui');
      assert(Number(before.expires_at) >= started + 30 * 86400000 && Number(before.expires_at) <= Date.now() + 30 * 86400000);
      const writes = await writeProof(), againResponse = await POST(await request('member', mobile, { path: target.filePath, reason: 'HTTP create' }, mobile));
      assert.equal(againResponse.status, 200); const again = await againResponse.json(); assert.equal(again.shares[0].id, first.id);
      assert.equal(again.shares[0].publicUrl, first.publicUrl); assert.deepEqual(await row(first.id), before); assert.equal(await writeProof(), writes);
    });
    for (const mode of ['lost-ack', 'lost-ack-discard-throws', 'confirmed-commit-release-throws', 'route-lost-ack'] as const)
    await check(`actual publication COMMIT ${mode} is fatal503 and never skipped or blindly retried`, async () => {
      const target = await native(), proof = await nativeProof(target), originalQuery = Client.prototype.query;
      const releases = new Map<Client, (error?: Error) => void>();
      const lostAck = Object.assign(new Error('Owned fixture lost only the reply of a successful actual publication COMMIT.'), { code: 'ECONNRESET' });
      const releaseError = new Error('Owned fixture lost only the actual publication checkout disposal reply.');
      let pid = 0, inserts = 0, commits = 0, rollbacks = 0, disposals = 0, committed = false, disposed = false, discarded = false, published = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = queryText(args);
        if (runtimeClient(this) && isShareInsert(sql) && queryValues(args).includes(target.filePath)) {
          inserts++; pid = Number(Reflect.get(this, 'processID'));
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
          const { POST } = await import('../app/api/security/public-shares/route');
          const response = await POST(await request('member', false, { paths: [target.filePath], reason: 'committed once' }));
          assert.equal(response.status, 503); assert.equal(response.headers.has('set-cookie'), false);
          const body = await response.json(); assert.equal(body.success, false); assert.equal(body.code, 'PUBLIC_SHARE_WRITE_COMMIT_UNCONFIRMED');
        } else await assert.rejects(create([target.filePath], { reason: 'committed once' }).then(value => { published = true; return value; }), error => {
          assert(error instanceof writer.PublicShareWriterCommitError); assert.equal(error.status, 503); assert.equal(error.code, 'PUBLIC_SHARE_WRITE_COMMIT_UNCONFIRMED'); return true;
        });
      } finally { Client.prototype.query = originalQuery; for (const [client, release] of releases) Reflect.set(client, 'release', release); }
      assert.equal(published, false); assert(committed); assert(disposed); assert.equal(discarded, mode !== 'confirmed-commit-release-throws');
      assert.equal(inserts, 1); assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(disposals, 1); assert.equal(releases.size, 1); assert(pid > 0);
      if (discarded) {
        const deadline = Date.now() + 5000;
        while (!(await admin.query('SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent', [pid])).rows[0].absent) {
          assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      const persisted = await pathRows(target.filePath); assert.equal(persisted.length, 1); assert.equal(persisted[0].status, 'active');
      assert.equal(persisted[0].reason, 'committed once'); assert.equal(persisted[0].policy_revision, 1); assert.deepEqual(await nativeProof(target), proof);
      const writes = await writeProof(), again = one(await create([target.filePath], { reason: 'committed once' }));
      assert.equal(again.id, persisted[0].id); assert.deepEqual(await pathRows(target.filePath), persisted); assert.equal(await writeProof(), writes); await noFile(target.fullPath);
    });
    assert.equal(passed, 46);
    assert.equal(fetches, 0); await own(); assert.equal(await sourceHash(), originalSourceHash);
    console.log('Public share create SQL assertions complete:', JSON.stringify({ passed, fetches, sourceSha256: originalSourceHash }));
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
    console.log('Public share create owned cleanup:', JSON.stringify({ schemaRemoved, dataRemoved, openClients: clients.size, passed }));
    if (cleanupErrors.length) throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Owned public create fixture cleanup failed.');
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  assert(schemaRemoved); assert(dataRemoved); complete = true;
  console.log('Public share create PostgreSQL18 finished:', JSON.stringify({ passed, schemaRemoved, dataRemoved }));
}
main().catch(error => {
  const assertion = error instanceof assert.AssertionError ? error : null;
  const safeScalar = (value: unknown) => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const operators = ['strictEqual', 'deepStrictEqual', 'equal', 'notEqual', 'notStrictEqual', 'deepEqual', 'notDeepEqual', 'notDeepStrictEqual',
    'ok', '==', '===', '!=', '!==', 'rejects', 'throws', 'doesNotReject', 'doesNotThrow', 'match', 'doesNotMatch', 'fail'];
  const frame = error instanceof Error ? error.stack?.split('\n').find(line => /^\s+at\s/u.test(line) && line.includes(`${sourcePath}:`)) : undefined;
  const location = frame ? /:(\d+):(\d+)\)?$/u.exec(frame) : null;
  console.error('Owned public create fixture failed:', { stage, passed, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null,
    ...(assertion ? { assertionOperator: operators.includes(assertion.operator) ? assertion.operator : 'other',
      actual: safeScalar(assertion.actual), expected: safeScalar(assertion.expected) } : {}),
    sourceFrame: location ? `${sourcePath}:${Number(location[1])}:${Number(location[2])}` : null }); process.exitCode = 1;
});
