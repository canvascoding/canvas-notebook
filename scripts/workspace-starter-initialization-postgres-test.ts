import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { MarkdownFileImportReceipt } from '../app/lib/collaboration/markdown-file-import-persistence';

// This is a real PG/Auth/FS integration fixture, not a browser or producer test.
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
  const schema = `starter_initialization_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^starter_initialization_[a-f0-9]{32}$/u);
  const organizationId = `starter-org-${crypto.randomUUID()}`;
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const originalQuery = Client.prototype.query;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-starter-initialization-')));
  const applicationName = `starter-fixture-${crypto.randomUUID()}`;
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
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: `starter-license-${crypto.randomUUID()}`,
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
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { createPostgresWorkspaceForActor, upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { readWorkspaceStarterInitializationIntent } = await import('../app/lib/workspaces/starter-document-initialization-store');
    const { completeWorkspaceStarterDocumentInitialization: complete, observeWorkspaceStarterDocumentInitialization: observe } = await import('../app/lib/workspaces/starter-document-initialization');
    const { initializeCreatedWorkspaceStarter, workspaceStarterInitializationResponse } = await import('../app/lib/workspaces/starter-document-initialization-api');
    const { parseWorkspaceStarterInitializationResult } = await import('../app/lib/workspaces/starter-document-initialization-contract');
    const { persistPristineOriginalWorkspaceFileForWrite } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { loadCollaborationStateOnConnection, serializeCanonicalText } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
    const connection: SqlConnection = { get: async (sql, values) => (await admin.query(sql, values)).rows[0],
      all: async (sql, values) => (await admin.query(sql, values)).rows,
      run: async (sql, values) => ({ changes: (await admin.query(sql, values)).rowCount ?? 0 }),
      close: () => assert.fail('A borrowed inspection connection must remain owned.') };
    const request = async (workspaceId: string, user: keyof typeof tokens = 'owner', cookie = true) => {
      const headers = new Headers({ 'x-canvas-workspace-id': workspaceId });
      if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens[user], process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization', `Bearer ${tokens[user]}`);
      return new NextRequest(`http://localhost/api/workspaces/${encodeURIComponent(workspaceId)}/starter-document-initialization`, { method: 'POST', headers });
    };
    const session = await auth.api.getSession({ headers: (await request('unused')).headers }); assert(session); assert.equal(session.user.id, 'owner');
    const actor = resolveWorkspaceActor(session.user);
    const create = async (type: 'personal' | 'team', label: string) => {
      const workspace = await createPostgresWorkspaceForActor(actor, { type, name: `Starter ${label} ${crypto.randomUUID()}` });
      assert.equal(workspace.workspaceType, type); assert.equal(workspace.actor?.userId, 'owner');
      assert.equal(workspace.permissions.canRead, true); assert.equal(workspace.permissions.canWrite, true);
      const intent = await readWorkspaceStarterInitializationIntent(connection, workspace.workspaceId); assert(intent);
      const original = await readFile(path.join(workspace.rootPath, intent.path));
      assert.equal(intent.actorUserId, 'owner'); assert.equal(intent.workspaceType, type); assert.equal(intent.organizationId, organizationId);
      assert.equal(intent.rootRelativePath, workspace.rootRelativePath); assert.equal(intent.sourceSha256, digest(original)); assert.equal(intent.sourceBytes, original.length);
      assert.equal(intent.seedDisposition, 'created'); assert(Object.isFrozen(intent));
      return { workspace, intent, original };
    };
    type Starter = Awaited<ReturnType<typeof create>>;
    const countWorkspaces = async () => Number((await admin.query('SELECT count(*)::int AS count FROM canvas_workspaces')).rows[0].count);
    const noNative = async (starter: Starter) => {
      for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages', 'collaboration_markdown_file_import_receipts']) {
        assert.equal(Number((await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1`, [starter.workspace.workspaceId])).rows[0].count), 0, table);
      }
    };
    const durable = async (starter: Starter) => {
      const rows = (await admin.query(`SELECT operation_id,request_id,actor_user_id,actor_session_id,private_result,
        private_result::text AS exact_result,after_state_snapshot FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1`, [starter.workspace.workspaceId])).rows;
      assert.equal(rows.length, 1); const row = rows[0], receipt = row.private_result as MarkdownFileImportReceipt;
      assert.equal(row.operation_id, starter.intent.operationId); assert.equal(row.request_id, starter.intent.requestId);
      assert.equal(row.actor_user_id, 'owner'); assert.equal(row.actor_session_id, 'session-owner');
      assert.equal(receipt.sourceHash, starter.intent.sourceSha256); assert.equal(receipt.sourceBytes, starter.intent.sourceBytes);
      assert.equal(receipt.target.path, starter.intent.path); assert.equal(receipt.target.workspaceId, starter.workspace.workspaceId);
      assert.equal(receipt.target.organizationId, organizationId); assert.equal(receipt.target.lifecycleGeneration, 1); assert.equal(receipt.target.initialSequence, 0);
      assert.equal(receipt.target.initialStateProof, `yjs-snapshot-sha256-v1:${digest(row.after_state_snapshot)}`);
      const state = await loadCollaborationStateOnConnection(connection, receipt.target.documentId, true); assert(state);
      const registry = (await admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [state.documentId])).rows[0];
      assert.equal(registry.lineage_id, receipt.target.lineageId); assert.equal(state.lifecycleGeneration, 1); assert.equal(state.documentSequence, 0);
      const content = inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => snapshot.content.kind === 'plain_text' ? snapshot.content.text : richMarkdownFromYDoc(doc));
      assert(Buffer.from(serializeCanonicalText(content, state)).equals(starter.original));
      assert((await readFile(path.join(starter.workspace.rootPath, starter.intent.path))).equals(starter.original));
      return { receipt, exact: row.exact_result as string, snapshotHash: digest(row.after_state_snapshot), binaryHash: digest(state.yjsState) };
    };
    const safeResult = (value: unknown, starter: Starter, status: 'completed' | 'pending' | 'blocked') => {
      const parsed = parseWorkspaceStarterInitializationResult(value); assert(parsed); assert.equal(parsed.workspaceId, starter.workspace.workspaceId); assert.equal(parsed.status, status);
      if (parsed.operationId !== undefined) { assert.equal(parsed.operationId, starter.intent.operationId); assert.equal(parsed.requestId, starter.intent.requestId); }
      for (const secret of [tokens.owner, tokens.member, starter.workspace.rootPath, starter.intent.sourceSha256]) assert(!JSON.stringify(parsed).includes(secret));
      return parsed;
    };
    const check = async (name: string, operation: () => Promise<void>) => { stage = name; await operation(); cases++; console.log(`Starter initialization PG18 passed: ${name}`); };
    let personal!: Starter, team!: Starter;
    await check('actual Personal creation records immutable original intent; observe never imports', async () => {
      personal = await create('personal', 'Personal'); await noNative(personal); const count = await countWorkspaces();
      const pending = safeResult(await observe(await request(personal.workspace.workspaceId), personal.workspace.workspaceId, { requireIntent: true }), personal, 'pending');
      assert.equal(pending.code, 'WORKSPACE_STARTER_INITIALIZATION_PENDING'); await noNative(personal); assert.equal(await countWorkspaces(), count);
      await assert.rejects(admin.query('UPDATE canvas_workspace_starter_initializations SET source_bytes=source_bytes WHERE workspace_id=$1', [personal.workspace.workspaceId]),
        error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === '55000');
      assert.deepEqual(await readWorkspaceStarterInitializationIntent(connection, personal.workspace.workspaceId), personal.intent);
    });
    await check('creation API initializes Personal through genuine Cookie and original import receipt', async () => {
      const count = await countWorkspaces();
      safeResult(await initializeCreatedWorkspaceStarter(await request(personal.workspace.workspaceId), personal.workspace.workspaceId), personal, 'completed');
      await durable(personal); assert.equal(await countWorkspaces(), count);
    });
    await check('own Personal observe/retry uses identical receipt and never creates another Workspace', async () => {
      const before = await durable(personal), count = await countWorkspaces();
      safeResult(await observe(await request(personal.workspace.workspaceId, 'owner', false), personal.workspace.workspaceId, { requireIntent: true }), personal, 'completed');
      safeResult(await complete(await request(personal.workspace.workspaceId), personal.workspace.workspaceId, { requireIntent: true }), personal, 'completed');
      assert.deepEqual(await durable(personal), before); assert.equal(await countWorkspaces(), count);
    });
    await check('actual Team owner membership and Bearer initialize the saved Team attempt', async () => {
      team = await create('team', 'Team'); await noNative(team);
      const membership = (await admin.query('SELECT status,can_read,can_write,can_manage FROM canvas_workspace_members WHERE workspace_id=$1 AND user_id=$2', [team.workspace.workspaceId, 'owner'])).rows[0];
      assert(membership); assert.equal(membership.status, 'active'); assert.equal(Number(membership.can_write), 1);
      safeResult(await complete(await request(team.workspace.workspaceId, 'owner', false), team.workspace.workspaceId, { requireIntent: true }), team, 'completed'); await durable(team);
    });
    await check('status GET only observes and resume POST preserves the existing Team identity', async () => {
      const before = await durable(team), count = await countWorkspaces();
      const observed = await workspaceStarterInitializationResponse(await request(team.workspace.workspaceId), team.workspace.workspaceId, 'observe');
      assert.equal(observed.status, 200); assert.match(observed.headers.get('cache-control') ?? '', /no-store/u);
      const body = await observed.json(); assert.equal(body.success, true); safeResult(body.starterDocumentInitialization, team, 'completed');
      const completed = await workspaceStarterInitializationResponse(await request(team.workspace.workspaceId, 'owner', false), team.workspace.workspaceId, 'complete');
      assert.equal(completed.status, 200); safeResult((await completed.json()).starterDocumentInitialization, team, 'completed');
      assert.deepEqual(await durable(team), before); assert.equal(await countWorkspaces(), count);
    });
    await check('changed original source is blocked without native state or a completion receipt', async () => {
      const starter = await create('personal', 'Changed source'), count = await countWorkspaces();
      await writeFile(path.join(starter.workspace.rootPath, starter.intent.path), Buffer.concat([starter.original, Buffer.from('\nOwned source fault.\n')]));
      const blocked = safeResult(await complete(await request(starter.workspace.workspaceId), starter.workspace.workspaceId, { requireIntent: true }), starter, 'blocked');
      assert.equal(blocked.code, 'WORKSPACE_STARTER_SOURCE_CHANGED'); await noNative(starter); assert.equal(await countWorkspaces(), count);
    });
    await check('genuine foreign initialized winner is not adopted as this starter attempt', async () => {
      const starter = await create('personal', 'Foreign winner');
      const winner = await persistPristineOriginalWorkspaceFileForWrite(await request(starter.workspace.workspaceId), {
        workspaceId: starter.workspace.workspaceId, path: starter.intent.path, operationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
        expectedTarget: { kind: 'absent' }, expectedFileVersion: starter.intent.sourceFileVersion });
      const initialState = await loadCollaborationStateOnConnection(connection, winner.receipt.target.documentId, true); assert(initialState);
      const originalNative = { documentId: initialState.documentId, generation: initialState.lifecycleGeneration,
        binaryHash: digest(initialState.yjsState), vectorHash: digest(initialState.stateVector), sequence: initialState.documentSequence };
      const before = (await admin.query('SELECT private_result::text AS result,after_state_snapshot FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1', [starter.workspace.workspaceId])).rows;
      const blocked = safeResult(await complete(await request(starter.workspace.workspaceId), starter.workspace.workspaceId, { requireIntent: true }), starter, 'blocked');
      assert.equal(blocked.code, 'WORKSPACE_STARTER_TARGET_CHANGED');
      assert.deepEqual((await admin.query('SELECT private_result::text AS result,after_state_snapshot FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1', [starter.workspace.workspaceId])).rows, before);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1', [starter.intent.operationId])).rows[0].count, 0);
      const actual = await loadCollaborationStateOnConnection(connection, winner.receipt.target.documentId, true); assert(actual);
      assert.equal((await admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [actual.documentId])).rows[0].lineage_id, winner.receipt.target.lineageId);
      assert.deepEqual({ documentId: actual.documentId, generation: actual.lifecycleGeneration, binaryHash: digest(actual.yjsState),
        vectorHash: digest(actual.stateVector), sequence: actual.documentSequence }, originalNative);
    });
    await check('actual read-only Team member cannot initialize another creator attempt', async () => {
      const starter = await create('team', 'Read-only member');
      await upsertPostgresWorkspaceMemberForActor(actor, starter.workspace.workspaceId, { userId: 'member', role: 'member', canRead: true, canWrite: false, canManage: false });
      const blocked = safeResult(await complete(await request(starter.workspace.workspaceId, 'member'), starter.workspace.workspaceId, { requireIntent: true }), starter, 'blocked');
      assert.equal(blocked.code, 'WORKSPACE_STARTER_ACCESS_CHANGED'); await noNative(starter);
    });
    await check('actual expired creator session is denied without changing the workspace or native target', async () => {
      const starter = await create('personal', 'Expired session'), count = await countWorkspaces();
      const originalSession = (await admin.query('SELECT * FROM "session" WHERE id=$1', ['session-owner'])).rows[0] as Record<string, unknown>;
      assert(originalSession); assert.equal(originalSession.token, tokens.owner);
      await admin.query('UPDATE "session" SET expires_at=$1 WHERE id=$2', [Date.now() - 60000, 'session-owner']);
      try {
        const blocked = safeResult(await complete(await request(starter.workspace.workspaceId), starter.workspace.workspaceId, { requireIntent: true }), starter, 'blocked');
        assert.equal(blocked.code, 'WORKSPACE_STARTER_ACCESS_CHANGED'); await noNative(starter); assert.equal(await countWorkspaces(), count);
        // The genuine BetterAuth expiry path deletes the row. A later UPDATE
        // cannot restore authentication for the independently tested cases.
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM "session" WHERE id=$1', ['session-owner'])).rows[0].count, 0);
      } finally {
        const columns = Object.keys(originalSession); assert(columns.every(column => /^[a-z_]+$/u.test(column)));
        await admin.query(`INSERT INTO "session"(${columns.map(column => `"${column}"`).join(',')})
          VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')}) ON CONFLICT(id) DO UPDATE SET
          ${columns.filter(column => column !== 'id').map(column => `"${column}"=excluded."${column}"`).join(',')}`, Object.values(originalSession));
        assert.deepEqual((await admin.query('SELECT * FROM "session" WHERE id=$1', ['session-owner'])).rows[0], originalSession);
        const restored = await auth.api.getSession({ headers: (await request(starter.workspace.workspaceId)).headers });
        assert(restored); assert.equal(restored.user.id, 'owner'); assert.equal(restored.session.id, 'session-owner');
      }
    });
    await check('actual import COMMIT ACK loss recovers the same immutable intent and receipt', async () => {
      const starter = await create('team', 'Commit response'), count = await countWorkspaces();
      const currentSession = await auth.api.getSession({ headers: (await request(starter.workspace.workspaceId)).headers });
      assert(currentSession); assert.equal(currentSession.user.id, 'owner'); assert.equal(currentSession.session.id, 'session-owner');
      const armed = new WeakSet<Client>(); let insertions = 0, lostResponses = 0;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = (typeof args[0] === 'string' ? args[0] : '').trim();
        const values = Array.isArray(args[1]) ? args[1] : [];
        const receipt = /^INSERT INTO collaboration_markdown_file_import_receipts\b/u.test(sql)
          && values[0] === starter.workspace.workspaceId && values[1] === starter.intent.operationId;
        const loseAck = /^COMMIT$/iu.test(sql) && armed.has(this) && lostResponses === 0;
        const actual = Reflect.apply(originalQuery, this, args);
        if (!receipt && !loseAck) return actual;
        return Promise.resolve(actual).then(result => {
          if (receipt) { insertions++; armed.add(this); }
          if (loseAck) { lostResponses++; throw new Error('Owned starter import COMMIT response was lost.'); }
          return result;
        });
      } as typeof Client.prototype.query;
      try {
        const observed = await complete(await request(starter.workspace.workspaceId), starter.workspace.workspaceId, { requireIntent: true });
        console.log('ACK loss public result', parseWorkspaceStarterInitializationResult(observed));
        assert.equal(insertions, 1); assert.equal(lostResponses, 1);
        safeResult(observed, starter, 'completed');
      } finally { Client.prototype.query = originalQuery; }
      assert.equal(insertions, 1); assert.equal(lostResponses, 1); const before = await durable(starter);
      safeResult(await observe(await request(starter.workspace.workspaceId, 'owner', false), starter.workspace.workspaceId, { requireIntent: true }), starter, 'completed');
      safeResult(await complete(await request(starter.workspace.workspaceId), starter.workspace.workspaceId, { requireIntent: true }), starter, 'completed');
      assert.deepEqual(await durable(starter), before); assert.equal(await countWorkspaces(), count);
    });
    await check('gate-off creation is retained and missing required intent is pending, never a fabricated completion', async () => {
      process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '0';
      let workspace: WorkspaceContext;
      try {
        workspace = await createPostgresWorkspaceForActor(actor, { type: 'personal', name: `Legacy starter ${crypto.randomUUID()}` });
        assert.equal(await readWorkspaceStarterInitializationIntent(connection, workspace.workspaceId), null);
        assert.equal(await initializeCreatedWorkspaceStarter(await request(workspace.workspaceId), workspace.workspaceId), undefined);
        const optional = await observe(await request(workspace.workspaceId), workspace.workspaceId); assert.equal(optional.status, 'not_required');
        const required = await observe(await request(workspace.workspaceId), workspace.workspaceId, { requireIntent: true });
        assert.equal(required.status, 'pending'); assert.equal(required.code, 'WORKSPACE_STARTER_INITIALIZATION_UNCONFIRMED');
      } finally { process.env.CANVAS_TEST_NATIVE_TEXT_SESSION = '1'; }
      const count = await countWorkspaces(); const result = await complete(await request(workspace.workspaceId), workspace.workspaceId, { requireIntent: true });
      assert.equal(result.status, 'pending'); assert.equal(result.code, 'WORKSPACE_STARTER_INITIALIZATION_UNCONFIRMED');
      assert.equal(await countWorkspaces(), count); assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1', [workspace.workspaceId])).rows[0].count, 0);
    });
    assert.equal(fetches, 0);
    console.log(`Workspace Starter Initialization PG18: ${cases} real Personal/Team/Auth/FS/import families passed; no browser/room acceptance claimed.`);
  } finally {
    Client.prototype.query = originalQuery; globalThis.fetch = originalFetch;
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
    console.log('Workspace Starter Initialization cleanup: own schema removed, zero owned clients, DATA removed.');
  }
}
main().catch(error => {
  console.error('Owned Starter Initialization fixture failed:', { stage, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).filter(line => line.includes('/app/lib/') || line.includes('/scripts/')) : undefined });
  process.exitCode = 1;
});
