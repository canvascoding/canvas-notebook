import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, type Pool } from 'pg';
import type { TextCollaborationRepresentation } from '../../app/lib/collaboration/types';

// Setup is adapted from the existing service21/MCP20 owned PG fixtures. The
// locally signed license and explicitly seeded seats are test data, not a
// claim of real Control Plane issuance or a completed browser OAuth flow.
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
const organizationId = 'tool-dispatch-org';
export type DispatchDocument = Readonly<{ documentId: string; lineageId: string; filePath: string;
  representation: TextCollaborationRepresentation; text: string }>;

export async function withDocumentReadToolDispatchFixture<T>(operation: (fixture: {
  admin: Client; workspaceId: string; clientId: string; agentId: string; piSessionId: string;
  workspaceRoot: string; dataRoot: string;
  issue: (overrides?: Record<string, unknown>) => Promise<string>;
  seed: (options?: { representation?: TextCollaborationRepresentation; text?: string; filePath?: string;
    nonexportable?: boolean }) => Promise<DispatchDocument>;
  snapshot: () => Promise<unknown>;
  restoreReaderSession: () => Promise<void>;
  setPiEnabledTools: (names: string[]) => Promise<void>;
}) => Promise<T>, options: Readonly<{ loopbackOrigin?: string }> = {}): Promise<T> {
  const fixtureOrigin = options.loopbackOrigin ?? 'http://localhost';
  if (options.loopbackOrigin !== undefined) {
    const selected = new URL(fixtureOrigin);
    assert.equal(selected.protocol, 'http:'); assert.equal(selected.hostname, '127.0.0.1');
    assert(Number(selected.port) >= 1 && Number(selected.port) <= 65535);
    assert.equal(selected.origin, fixtureOrigin); assert.equal(selected.pathname, '/');
    assert.equal(selected.username, ''); assert.equal(selected.password, '');
    assert.equal(selected.search, ''); assert.equal(selected.hash, '');
  }
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL;
  assert(connectionString);
  const databaseUrl = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
  assert(['localhost', '127.0.0.1'].includes(databaseUrl.hostname));
  assert.equal(databaseUrl.port, '55433'); assert.equal(databaseUrl.pathname, '/canvas_notebook');
  assert.equal(databaseUrl.search, '');
  const nonce = crypto.randomUUID().replaceAll('-', ''), schema = `document_tool_dispatch_${nonce}`;
  const applicationName = `document-tool-dispatch-${nonce}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-document-tool-dispatch-'));
  await chmod(dataRoot, 0o700);
  const dataIdentity = await lstat(dataRoot), canonicalDataRoot = await realpath(dataRoot);
  assert(dataIdentity.isDirectory() && !dataIdentity.isSymbolicLink());
  assert.equal(dataIdentity.uid, process.getuid?.());
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000,
    options: `-c statement_timeout=15000 -c application_name=${applicationName}-control` });
  control.on('error', () => undefined);
  let controlConnected = false, schemaOid: string | undefined, schemaCreated = false, pool: Pool | undefined;
  let primary: unknown, result: T | undefined, fetches = 0;
  const clients = new Set<Client>(), documents = new Set<{ destroy: () => void }>();
  const cleanupErrors: unknown[] = [];
  try {
    await control.connect(); controlConnected = true;
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    schemaOid = (await control.query('SELECT to_regnamespace($1)::oid::text AS oid', [schema])).rows[0].oid;
    assert.match(schemaOid!, /^[1-9][0-9]*$/u);
    await control.query(`COMMENT ON SCHEMA "${schema}" IS 'document-tool-dispatch:${nonce}'`);
    Object.assign(process.env, { DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=${applicationName}`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot,
      CANVAS_INSTANCE_ID: `fixture-${nonce}`, BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
      BETTER_AUTH_BASE_URL: fixtureOrigin, BASE_URL: fixtureOrigin, AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'read_knowledge_source,search_knowledge', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_ORGANIZATION_ID: organizationId, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'CANVAS_LICENSE_TEST_PUBLIC_KEY',
      'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS', 'NEXT_PHASE']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'dispatch-fixture-license',
      sub: process.env.CANVAS_INSTANCE_ID, instanceId: process.env.CANVAS_INSTANCE_ID,
      iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active', hostingMode: 'community',
      edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true, organizationId,
      capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true },
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('External network is forbidden in the dispatch fixture.'); };
    const admin = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=${applicationName}-admin` });
    admin.on('error', () => undefined); clients.add(admin); await admin.connect();
    const own = async () => {
      const row = (await admin.query("SELECT current_schema() AS schema,current_setting('search_path') AS search_path")).rows[0];
      assert.equal(row.schema, schema);
      assert.deepEqual(row.search_path.split(',').map((entry: string) => entry.trim()), [schema, 'pg_catalog']);
    };
    const { runPostgresMigrations } = await import('../../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      await own(); const actual = await admin.query(sql, values); await own(); return actual;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const workspaceId = `dispatch-${crypto.randomUUID()}`, clientId = `dispatch-client-${crypto.randomUUID()}`;
    const workspaceRelative = `organizations/${organizationId}/shared`, workspaceRoot = path.join(dataRoot, workspaceRelative);
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    const now = Date.now();
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@dispatch.test',1,'admin',0,$1,$1),('reader','Reader','reader@dispatch.test',1,'user',0,$1,$1)`, [now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES($1,'owner','team',1,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES($1,'owner','owner','active',1,100,100),($1,'reader','member','active',0,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat',$1,'owner@dispatch.test','owner','owner','active',100,100,100,100),
      ('reader-seat',$1,'reader@dispatch.test','reader','member','active',100,200,100,100)`, [organizationId]);
    await admin.query('INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES($1,100,100)', [organizationId]);
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES($1,$2,'organization','Dispatch workspace',$3,'active',100,100)`, [workspaceId, organizationId, workspaceRelative]);
    const restoreReaderSession = async () => {
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES('reader-session',$1,'reader',$2,$3,$3) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at`,
      [crypto.randomBytes(32).toString('hex'), Date.now() + 3600000, now]);
    };
    await restoreReaderSession();
    await admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES('dispatch-client',$1,'reader','Dispatch client',0,'[]',100,100)`, [clientId]);
    await admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES('dispatch-consent',$1,'reader',$2,$3,100,100)`,
    [clientId, JSON.stringify(['knowledge:read', 'knowledge:search']), JSON.stringify([`${fixtureOrigin}/mcp`])]);
    await admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
      VALUES($1,'owner',100,100)`, [workspaceId]);
    await admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
      VALUES($1,'reader',$2,100,100)`, [clientId, workspaceId]);
    const { getPostgresRuntimeQueryable } = await import('../../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as unknown as Pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../../app/lib/license');
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team');
    const { requireTeamRuntimeLicense } = await import('../../app/lib/license/entitlements');
    await requireTeamRuntimeLicense();
    // Run the genuine listing/bootstrap before read-only document snapshots.
    // Edition alone does not establish the Team runtime used by this path.
    const { loadDirectMcpWorkspaceListingForUser } = await import('../../app/lib/mcp/server/workspace-access-policy');
    const listing = await loadDirectMcpWorkspaceListingForUser('reader');
    const sharedWorkspace = listing.workspaces.find(entry => entry.workspaceId === workspaceId);
    assert(sharedWorkspace); assert.equal(sharedWorkspace.permissions.canRead, true);
    assert.equal(sharedWorkspace.permissions.canWrite, false);
    const { auth } = await import('../../app/lib/auth');
    const issue = async (overrides: Record<string, unknown> = {}) => {
      const issuedAt = Math.floor(Date.now() / 1000) - 1;
      const signed = await auth.api.signJWT({ body: { payload: { sub: 'reader', azp: clientId, sid: 'reader-session',
        iss: `${fixtureOrigin}/api/auth`, aud: `${fixtureOrigin}/mcp`, iat: issuedAt, exp: issuedAt + 600,
        scope: 'knowledge:read knowledge:search', ...overrides } } });
      assert(signed.token); return signed.token;
    };
    const { MAIN_AGENT_ID: agentId } = await import('../../app/lib/agents/main-agent');
    await admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'System','main','legacy','organization',$2,'["read_document"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [agentId, organizationId]);
    const piSessionId = 'dispatch-pi-session';
    const piSession = (await admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
      workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES($1,'reader',$2,'fixture','fixture',$3,$4,'organization','Dispatch workspace',$5,100,100) RETURNING id`,
    [piSessionId, agentId, organizationId, workspaceId, workspaceRelative])).rows[0];
    await admin.query(`INSERT INTO pi_messages(pi_session_db_id,role,content,timestamp,sequence) VALUES($1,'user',$2,100,1)`,
    [piSession.id, JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'Read the native fixture by stable ID.' }], timestamp: 100 })]);
    // Runtime settings are real private fixture data; the registry still reads
    // current agent settings/session/access and creates the actual invocation.
    const { DEFAULT_PI_CONFIG } = await import('../../app/lib/pi/config');
    const { writePiRuntimeConfig } = await import('../../app/lib/agents/storage');
    const setPiEnabledTools = async (names: string[]) => {
      await admin.query('UPDATE agents SET enabled_tools_json=$2 WHERE agent_id=$1', [agentId, JSON.stringify(names)]);
      await writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG, activeProvider: 'openrouter', providers: {
        ...DEFAULT_PI_CONFIG.providers, openrouter: { ...DEFAULT_PI_CONFIG.providers.openrouter,
          enabledTools: names } }, updatedBy: 'dispatch-fixture' });
    };
    await setPiEnabledTools(['read_document']);
    const { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } =
      await import('../../app/lib/collaboration/markdown-state');
    const { getSchema } = await import('@tiptap/core');
    const { Y } = await import('../../app/lib/collaboration/server-runtime');
    const { CollaborationBlockTree } = await import('../../app/lib/collaboration/block-tree');
    const seed = async (options: { representation?: TextCollaborationRepresentation; text?: string; filePath?: string;
      nonexportable?: boolean } = {}): Promise<DispatchDocument> => {
      const representation = options.representation ?? 'plain_text';
      const text = options.text ?? 'A😀B🧪C', filePath = options.filePath ?? `note-${crypto.randomUUID()}.bin`;
      const doc = representation === 'plain_text' ? createPlainTextYDoc(text)
        : createRichMarkdownYDoc(options.nonexportable ? '| Keep |\n| --- |\n| [Target](target.md) |' : text, representation);
      documents.add(doc);
      if (options.nonexportable) {
        assert.equal(representation, 'tiptap_blocks');
        const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
        for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
          (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
        }
        assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
      }
      const documentId = `doc-${crypto.randomUUID()}`, lineageId = `lineage-${crypto.randomUUID()}`;
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization',$3,$4,'active',100)`, [lineageId, workspaceId, organizationId, filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'organization',$4,$5,'yjs',7,'initialized','active',100,100)`,
      [documentId, lineageId, workspaceId, organizationId, filePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,
        schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,
        serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,$3,$4,$5,1,1,$6,$7,7,100,0,NULL,NULL,NULL,'lf',0,0,'active')`,
      [documentId, workspaceId, organizationId, filePath, representation, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
      await admin.query(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,'Shared fixture title',100,100)`,
      [workspaceId, filePath]);
      return Object.freeze({ documentId, lineageId, filePath, representation, text });
    };
    const snapshot = async () => ({
      documents: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_documents ORDER BY id')).rows,
      lineages: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_collaboration_lineages ORDER BY id')).rows,
      states: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_yjs_states ORDER BY document_id')).rows,
      metadata: (await admin.query('SELECT *,xmin::text AS original_xmin FROM workspace_file_metadata ORDER BY workspace_id,path')).rows,
      revisions: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_revisions ORDER BY id')).rows,
      projections: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_file_projections ORDER BY document_id')).rows,
    });
    console.log('Document tool dispatch owned fixture:', JSON.stringify({ schema, schemaOid, dataRoot, applicationName, pid: process.pid }));
    result = await operation({ admin, workspaceId, clientId, agentId, piSessionId, workspaceRoot, dataRoot,
      issue, seed, snapshot, restoreReaderSession, setPiEnabledTools });
    assert.equal(fetches, 0);
  } catch (error) { primary = error; }
  finally {
    for (const doc of documents) { try { doc.destroy(); } catch (error) { cleanupErrors.push(error); } }
    if (pool) { try { await pool.end(); } catch (error) { cleanupErrors.push(error); } }
    for (const client of clients) {
      try { await client.end(); clients.delete(client); } catch (error) { cleanupErrors.push(error); }
    }
    if (schemaCreated && controlConnected) {
      try {
        const row = (await control.query(`SELECT n.oid::text AS oid,obj_description(n.oid,'pg_namespace') AS marker,
          pg_get_userbyid(n.nspowner)=current_user AS owned FROM pg_namespace n WHERE n.nspname=$1`, [schema])).rows[0];
        assert(row); assert.equal(row.oid, schemaOid); assert.equal(row.marker, `document-tool-dispatch:${nonce}`); assert.equal(row.owned, true);
        assert.equal((await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name LIKE $1 AND pid<>pg_backend_pid()',
          [`${applicationName}%`])).rows[0].count, 0);
        await control.query(`DROP SCHEMA "${schema}" CASCADE`);
        assert.equal((await control.query('SELECT to_regnamespace($1) AS oid', [schema])).rows[0].oid, null);
      } catch (error) { cleanupErrors.push(error); }
    }
    try { await control.end(); } catch (error) { cleanupErrors.push(error); }
    try {
      const current = await lstat(dataRoot);
      assert(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.uid, dataIdentity.uid);
      assert.equal(current.dev, dataIdentity.dev); assert.equal(current.ino, dataIdentity.ino);
      assert.equal(await realpath(dataRoot), canonicalDataRoot);
      await rm(dataRoot, { recursive: true });
      await assert.rejects(lstat(dataRoot), { code: 'ENOENT' });
    } catch (error) { cleanupErrors.push(error); }
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
  }
  if (primary !== undefined && cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], 'Dispatch test failed and cleanup was not fully confirmed.');
  if (primary !== undefined) throw primary;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Dispatch fixture cleanup was not fully confirmed.');
  console.log(JSON.stringify({ fixture: 'document-read-tool-dispatch', schemaRemoved: true, clientsClosed: clients.size === 0,
    dataRemoved: true, fetches, tcpServersCreated: 0 }));
  return result as T;
}
