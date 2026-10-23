import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, type Pool } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { ExistingNativeSessionIdentity } from '../app/lib/collaboration/native-session-state-reader';
import type { DocumentReadPageV1 } from '../app/lib/documents/contracts';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';

// Actual public service and POST-route integration against one owned PG18
// schema. Request/PI authority is genuine. Query hooks preserve original SQL
// and actual results; they add only explicitly labelled mechanical faults.
// This is neither browser/TCP-server nor Direct-MCP transport acceptance.
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', passed = 0, complete = false;
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
  const suffix = crypto.randomUUID().replaceAll('-', ''), schema = `document_read_service_${suffix}`;
  const retiredSchema = `document_read_retired_${suffix}`;
  assert.match(schema, /^document_read_service_[a-f0-9]{32}$/u);
  const workspaceId = `document-service-${crypto.randomUUID()}`;
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-document-read-service-'));
  const applicationName = `document-read-service-${suffix}`;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c application_name=document-read-service-control' });
  const clients = new Set<Client>();
  let created = false, connected = false, pool: Pool | undefined, fetches = 0, primaryFailure: unknown;
  let initialSchemaOid: string | undefined, replacementSchemaOid: string | undefined;
  const rawQuery = Client.prototype.query;
  const runtimeLeases: Lease[] = [];
  const ownedDocuments = new Set<{ destroy: () => void }>();
  type Lease = {
    client: Client; pid: number; queries: number; begins: number; commits: number; rollbacks: number;
    released: number; transactions: Set<string>; steps: string[];
    originalRelease?: (error?: Error | boolean) => void;
    installedRelease?: (error?: Error | boolean) => void;
  };
  type Hook = {
    before?: (lease: Lease, sql: string) => Promise<void> | void;
    after?: (lease: Lease, sql: string) => Promise<void> | void;
    afterRelease?: (lease: Lease) => void;
  };
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=${applicationName}-admin` });
    client.on('error', () => undefined);
    clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const connection = (client: Client): SqlConnection => ({
    get: async (sql, values) => (await client.query(sql, values)).rows[0],
    all: async (sql, values) => (await client.query(sql, values)).rows,
    run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
    close: () => { throw new Error('Stored-context resolver does not own this fixture connection.'); },
  });
  const actualSql = (lease: Lease, sql: string, values?: unknown[]): Promise<unknown> =>
    Promise.resolve(Reflect.apply(rawQuery, lease.client, [sql, values]));
  const sqlText = (args: unknown[]): string => typeof args[0] === 'string' ? args[0].trim()
    : args[0] && typeof args[0] === 'object' && typeof Reflect.get(args[0], 'text') === 'string' ? Reflect.get(args[0], 'text').trim() : '';
  const audit = async <T>(operation: (leases: Lease[]) => Promise<T>, hook: Hook = {}): Promise<T> => {
    assert.equal(Client.prototype.query, rawQuery);
    const leases: Lease[] = [], active = new Map<Client, Lease>();
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      // Preserve Pool.query's callback overload and every nonservice checkout.
      if (args.some(argument => typeof argument === 'function') || clients.has(this) || this === control) {
        return Reflect.apply(rawQuery, this, args);
      }
      const sql = sqlText(args);
      if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') {
        const lease: Lease = { client: this, pid: Number(Reflect.get(this, 'processID')), queries: 0,
          begins: 0, commits: 0, rollbacks: 0, released: 0, transactions: new Set(), steps: [] };
        assert(Number.isSafeInteger(lease.pid) && lease.pid > 0);
        active.set(this, lease); leases.push(lease); runtimeLeases.push(lease);
      }
      const lease = active.get(this);
      if (!lease) return Reflect.apply(rawQuery, this, args);
      return (async () => {
        await hook.before?.(lease, sql);
        const result = await Reflect.apply(rawQuery, this, args);
        lease.queries++;
        if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') {
          lease.begins++; lease.steps.push('actual-BEGIN');
          const release = Reflect.get(this, 'release') as ((error?: Error | boolean) => void) | undefined;
          assert.equal(typeof release, 'function'); lease.originalRelease = release;
          const afterRelease = (error?: Error | boolean) => {
            Reflect.apply(release!, this, [error]);
            lease.released++; lease.steps.push('actual-release-completed'); active.delete(this);
            if (Reflect.get(this, 'release') === afterRelease) Reflect.set(this, 'release', release);
            hook.afterRelease?.(lease);
          };
          lease.installedRelease = afterRelease;
          assert.equal(Reflect.set(this, 'release', afterRelease), true);
          const realm = await Reflect.apply(rawQuery, this, ['SELECT current_schema() AS schema,pg_backend_pid() AS pid']);
          assert.equal(realm.rows[0].schema, schema); assert.equal(Number(realm.rows[0].pid), lease.pid);
        }
        if (sql === 'COMMIT') { lease.commits++; lease.steps.push('actual-COMMIT'); }
        if (sql === 'ROLLBACK') { lease.rollbacks++; lease.steps.push('actual-ROLLBACK'); }
        if (sql.includes('pg_backend_pid()') && Array.isArray(result.rows)) {
          for (const row of result.rows as Record<string, unknown>[]) {
            for (const key of ['backend', 'backend_pid']) if (row[key] !== undefined) assert.equal(Number(row[key]), lease.pid);
            const xid = row.transaction_id ?? row.transaction;
            if (typeof xid === 'string' && /^[1-9][0-9]*$/u.test(xid)) lease.transactions.add(xid);
          }
        }
        await hook.after?.(lease, sql);
        return result;
      })();
    } as typeof Client.prototype.query;
    try { return await operation(leases); }
    finally {
      Client.prototype.query = rawQuery;
      for (const lease of leases) if (lease.released && Reflect.get(lease.client, 'release') === lease.installedRelease) {
        Reflect.set(lease.client, 'release', lease.originalRelease);
      }
    }
  };
  const assertClosed = (leases: Lease[], disposition: 'commit' | 'rollback') => {
    assert.equal(leases.length, 1, 'One service invocation owns one actual transaction, without retries.');
    const lease = leases[0]; assert.equal(lease.begins, 1); assert.equal(lease.transactions.size, 1);
    assert.equal(lease.commits, disposition === 'commit' ? 1 : 0);
    assert.equal(lease.rollbacks, disposition === 'rollback' ? 1 : 0);
    assert.equal(lease.released, 1, 'Public completion follows the actual pool release.');
    assert(lease.steps.indexOf(`actual-${disposition === 'commit' ? 'COMMIT' : 'ROLLBACK'}`)
      < lease.steps.indexOf('actual-release-completed'));
  };
  const check = async (name: string, operation: () => Promise<void>) => {
    stage = name; await operation(); passed++; console.log('Document public read service case passed:', JSON.stringify({ passed, name }));
  };
  console.log('Document read service owned fixture:', JSON.stringify({ pid: process.pid, schema, dataRoot }));
  try {
    await control.connect(); connected = true;
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    initialSchemaOid = (await control.query('SELECT to_regnamespace($1)::oid::text AS oid', [schema])).rows[0].oid;
    assert.match(initialSchemaOid!, /^[1-9][0-9]*$/u);
    Object.assign(process.env, { DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=${applicationName}`,
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
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'principal-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('External network is forbidden in this owned fixture.'); };
    stage = 'actual full migrations';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const admin = await ownClient();
    const own = async () => {
      const row = (await admin.query("SELECT current_schema() AS schema,current_setting('search_path') AS path")).rows[0];
      assert.equal(row.schema, schema); assert.deepEqual(row.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']);
    };
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      await own(); const result = await admin.query(sql, values); await own(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
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
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES($1,'principal-org','organization','Organization','organizations/principal-org/shared','active',100,100)`, [workspaceId]);
    for (const userId of ['owner', 'member']) await admin.query(`INSERT INTO canvas_workspaces
      (id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
      VALUES($1,'principal-org','personal',$2,$2,$3,'active',100,100)`, [`personal-${userId}`, userId, `users/${userId}/workspace`]);
    const tokens: Record<string, string> = {};
    const seedSession = async (userId = 'owner') => {
      const token = crypto.randomBytes(32).toString('hex'); tokens[userId] = token;
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at`,
      [`session-${userId}`, token, userId, Date.now() + 3600000, now]);
    };
    await seedSession(); await seedSession('member');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as unknown as Pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!, process.env.CANVAS_INSTANCE_ID!)).ok, true);
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 2);
    const { readDocumentForRequest, readDocumentForAgentTool } = await import('../app/lib/documents/service');
    const { POST } = await import('../app/api/documents/read/route');
    const { DocumentReadError } = await import('../app/lib/documents/contracts');
    const { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const { getSchema } = await import('@tiptap/core');
    const { CollaborationBlockTree } = await import('../app/lib/collaboration/block-tree');
    const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
    await admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'System','main','legacy','organization','principal-org','["read"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [MAIN_AGENT_ID]);
    await admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,
      workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES('pi-read','owner',$1,'fixture','fixture','principal-org',$2,'organization','Organization','organizations/principal-org/shared',100,100)`,
    [MAIN_AGENT_ID, workspaceId]);
    await admin.query('CREATE TABLE fixture_writes(id text PRIMARY KEY,value text NOT NULL)');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const storedWorkspace = await readPostgresWorkspaceForActorOnConnection(connection(admin),
      resolveWorkspaceActor({ id: 'owner', email: 'owner@principal.test', role: 'admin' }), workspaceId);
    assert(storedWorkspace); assert.equal(storedWorkspace.legacy, false); assert.equal(storedWorkspace.permissions.canRunAgent, true);
    assert(storedWorkspace.rootPath.startsWith(dataRoot + path.sep));
    const context = (): AgentExecutionContext => ({ userId: 'owner', sessionId: 'pi-read', agentId: MAIN_AGENT_ID,
      agentTurnId: 'read-service-turn', workspaceId, workspaceType: storedWorkspace.workspaceType,
      workspaceName: storedWorkspace.displayName ?? null, organizationId: storedWorkspace.organizationId ?? null,
      customerId: storedWorkspace.customerId ?? null, projectId: storedWorkspace.projectId ?? null,
      workspaceRoot: storedWorkspace.rootPath, workspaceRootRelativePath: storedWorkspace.rootRelativePath ?? null,
      canWrite: false, canDelete: false, canShare: false, legacy: false });
    const invoke = <T>(operation: () => Promise<T>, signal?: AbortSignal) => {
      const source = context();
      return runWithAgentExecutionContext(source, () => withAgentToolInvocation(source,
        { toolName: 'read', toolCallId: `read-${crypto.randomUUID()}`, signal }, operation));
    };
    const seed = async (label: string, representation: ExistingNativeSessionIdentity['representation'] = 'plain_text',
      options: { text?: string; doc?: InstanceType<typeof Y.Doc>; filePath?: string } = {}) => {
      const doc = options.doc ?? (representation === 'plain_text' ? createPlainTextYDoc(options.text ?? 'Native text 🦊 with enough bytes for continuation')
        : createRichMarkdownYDoc(options.text ?? '# Native heading\n\nActual **rich** text.\n', representation));
      ownedDocuments.add(doc);
      const documentId = `doc-${crypto.randomUUID()}`, lineageId = `lineage-${crypto.randomUUID()}`;
      const filePath = options.filePath ?? `${label}-${crypto.randomUUID()}.md`;
      const update = Buffer.from(Y.encodeStateAsUpdate(doc)), vector = Buffer.from(Y.encodeStateVector(doc));
      const proof = collaborationStateProof(doc, Y); assert(proof);
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization','principal-org',$3,'active',100)`, [lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'organization','principal-org',$4,'yjs',7,'initialized','active',100,100)`, [documentId, lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,
        schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,
        serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,'principal-org',$3,$4,1,1,$5,$6,7,100,0,NULL,NULL,NULL,'lf',0,0,'active')`,
      [documentId, workspaceId, filePath, representation, update, vector]);
      return { identity: { documentId, lineageId, workspaceId, organizationId: 'principal-org', path: filePath,
        lifecycleGeneration: 1, representation, schemaVersion: 1 } as ExistingNativeSessionIdentity, doc, vector, proof };
    };
    type Target = Awaited<ReturnType<typeof seed>>;
    const selection = (target: Target, extra: Record<string, unknown> = {}) => ({ apiVersion: 1, workspaceId,
      documentId: target.identity.documentId, ...extra });
    const request = async (userId = 'owner', auth: 'bearer' | 'cookie' | 'none' = 'bearer', selectedWorkspace = workspaceId,
      json?: string) => {
      const headers = new Headers({ 'x-canvas-workspace-id': selectedWorkspace });
      if (auth === 'cookie') headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens[userId], process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      if (auth === 'bearer') headers.set('authorization', `Bearer ${tokens[userId]}`);
      if (json !== undefined) headers.set('content-type', 'application/json');
      return new NextRequest('http://localhost/api/documents/read', { method: 'POST', headers, ...(json === undefined ? {} : { body: json }) });
    };
    const read = async (target: Target, extra: Record<string, unknown> = {}, userId = 'owner', auth: 'bearer' | 'cookie' = 'bearer') =>
      readDocumentForRequest(await request(userId, auth), selection(target, extra));
    const expected = (wanted: ConstructorParameters<typeof DocumentReadError>[0]) => (error: unknown) => {
      assert(error instanceof DocumentReadError); assert.equal(error.code, wanted); return true;
    };
    const forbidden = (error: unknown) => {
      assert(error instanceof DocumentReadError); assert(['AUTHENTICATION_REQUIRED', 'ACCESS_DENIED'].includes(error.code));
      assert([401, 403].includes(error.status)); return true;
    };
    const nativeRows = async (target: Target) => ({
      registry: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_documents WHERE id=$1', [target.identity.documentId])).rows,
      lineage: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_collaboration_lineages WHERE id=$1', [target.identity.lineageId])).rows,
      state: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_yjs_states WHERE document_id=$1', [target.identity.documentId])).rows,
    });
    const projectionQuery = (sql: string) => sql.includes('AS finalized') && sql.includes('collaboration_file_projections');

    await check('genuine Bearer and signed Cookie finish one actual B COMMIT and release before returning content', async () => {
      const target = await seed('actual-web'); const before = await nativeRows(target);
      for (const auth of ['bearer', 'cookie'] as const) {
        await audit(async leases => {
          const page = await read(target, { format: 'text' }, 'owner', auth);
          assert.equal(page.fragment, 'Native text 🦊 with enough bytes for continuation'); assert.equal(page.complete, true);
          assert.equal(page.document.documentId, target.identity.documentId); assert.equal(page.document.lineageId, target.identity.lineageId);
          assert.equal(page.document.organizationId, 'principal-org');
          assert.equal(page.currency.observedDurable, true); assert.equal(page.projection.status, 'pending');
          assertClosed(leases, 'commit');
        });
        const headersSource = await request('owner', auth);
        const ordinary = new Request(headersSource.url, { method: headersSource.method, headers: new Headers(headersSource.headers) });
        assert(ordinary instanceof Request); assert.equal(ordinary instanceof NextRequest, false);
        await audit(async leases => {
          const page = await readDocumentForRequest(ordinary, selection(target, { format: 'text' }));
          assert.equal(page.fragment, 'Native text 🦊 with enough bytes for continuation'); assert.equal(page.complete, true);
          assert.equal(page.document.documentId, target.identity.documentId); assert.equal(page.document.organizationId, 'principal-org');
          assertClosed(leases, 'commit');
        });
      }
      assert.deepEqual(await nativeRows(target), before);
    });
    await check('projection status requires the exact finalized durable SQL receipt rather than equal zero sequences', async () => {
      // Mechanical SQL fixtures exercise the read-status contract only. No
      // checkpoint file, projector finalization or filesystem success is claimed.
      const target = await seed('projection-status');
      await admin.query('UPDATE collaboration_documents SET state_version=0 WHERE id=$1', [target.identity.documentId]);
      await admin.query('UPDATE collaboration_yjs_states SET document_sequence=0,checkpoint_sequence=0 WHERE document_id=$1', [target.identity.documentId]);
      const initial = await read(target, { format: 'text' });
      assert.equal(initial.currency.durableSequence, 0); assert.equal(initial.projection.checkpointSequence, 0);
      assert.equal(initial.projection.checkpointedAt, null); assert.equal(initial.projection.status, 'pending');
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_file_projections WHERE document_id=$1',
        [target.identity.documentId])).rows[0].count, 0);
      const text = target.doc.getText('content').toString();
      const canonicalHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
      const serializedHash = crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
      const differentHash = crypto.createHash('sha256').update('Different fixture checkpoint bytes', 'utf8').digest('hex');
      const revisionId = `revision-${crypto.randomUUID()}`;
      await admin.query(`INSERT INTO file_revisions(id,organization_id,workspace_id,workspace_type,path,content_hash,size_bytes,
        created_by_user_id,created_by_actor_type,lineage_id,revision_number,created_at)
        VALUES($1,'principal-org',$2,'organization',$3,$4,$5,'owner','user',$6,1,200)`,
      [revisionId, workspaceId, target.identity.path, serializedHash, Buffer.byteLength(text), target.identity.lineageId]);
      await admin.query('UPDATE collaboration_documents SET state_version=7,snapshot_revision_id=$2 WHERE id=$1', [target.identity.documentId, revisionId]);
      await admin.query(`UPDATE collaboration_yjs_states SET document_sequence=7,checkpoint_sequence=7,checkpointed_at=200,
        canonical_hash=$2,serialized_hash=$3 WHERE document_id=$1`, [target.identity.documentId, canonicalHash, serializedHash]);
      await admin.query(`INSERT INTO collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,revision_id,
        canonical_hash,serialized_hash,finalized,updated_at) VALUES($1,1,7,$2,$3,$4,1,200)`,
      [target.identity.documentId, revisionId, canonicalHash, serializedHash]);
      const resetReceipt = () => admin.query(`UPDATE collaboration_file_projections SET lifecycle_generation=1,projected_sequence=7,
        revision_id=$2,canonical_hash=$3,serialized_hash=$4,finalized=1,updated_at=200 WHERE document_id=$1`,
      [target.identity.documentId, revisionId, canonicalHash, serializedHash]);
      const before = await nativeRows(target);
      const current = await read(target, { format: 'text' });
      assert.equal(current.currency.durableSequence, 7); assert.equal(current.projection.checkpointSequence, 7);
      assert.equal(current.projection.checkpointedAt, 200); assert.equal(current.projection.status, 'current');
      for (const [name, assignment, value] of [
        ['not finalized', 'finalized=$2', 0],
        ['no confirmed revision', 'revision_id=$2', null],
        ['different generation', 'lifecycle_generation=$2', 2],
        ['different sequence', 'projected_sequence=$2', 6],
        ['different canonical hash', 'canonical_hash=$2', differentHash],
        ['different serialized hash', 'serialized_hash=$2', differentHash],
      ] as const) {
        await resetReceipt();
        await admin.query(`UPDATE collaboration_file_projections SET ${assignment} WHERE document_id=$1`, [target.identity.documentId, value]);
        const pending = await read(target, { format: 'text' });
        assert.equal(pending.projection.status, 'pending', name); assert.equal(pending.currency.observedDurable, true, name);
        assert.equal(pending.document.version, current.document.version, name);
      }
      await resetReceipt(); assert.equal((await read(target, { format: 'text' })).projection.status, 'current');
      assert.deepEqual(await nativeRows(target), before, 'Status reads do not alter native clocks, content or lifecycle.');
    });
    await check('actual POST route accepts read-only member Cookie and returns no-store complete native JSON', async () => {
      const target = await seed('route-member');
      await audit(async leases => {
        const response = await POST(await request('member', 'cookie', workspaceId, JSON.stringify(selection(target))));
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        const page = await response.json() as DocumentReadPageV1;
        assert.equal(page.apiVersion, 1); assert.equal(page.document.documentId, target.identity.documentId);
        assert.equal(JSON.parse(page.fragment).content.text, 'Native text 🦊 with enough bytes for continuation');
        assertClosed(leases, 'commit');
      });
    });
    await check('POST route invalid and unauthenticated requests expose only bounded named failures', async () => {
      const target = await seed('route-errors');
      for (const [json, auth, status, wanted] of [
        ['{broken', 'bearer', 400, 'INVALID_REQUEST'],
        [JSON.stringify({ ...selection(target), unknown: true }), 'bearer', 400, 'INVALID_REQUEST'],
        [JSON.stringify(selection(target)), 'none', 401, 'AUTHENTICATION_REQUIRED'],
      ] as const) {
        const response = await POST(await request('owner', auth, workspaceId, json));
        assert.equal(response.status, status); const wire = await response.json();
        assert.deepEqual(wire, { apiVersion: 1, success: false, code: wanted });
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
    });
    await check('Plain XML and Blocks native-only sources read without physical projections or filename dispatch', async () => {
      for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
        const target = await seed('native-only', representation, { filePath: `native-${crypto.randomUUID()}.bin` });
        const before = await nativeRows(target);
        await assert.rejects(stat(path.join(storedWorkspace.rootPath, target.identity.path)), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
        const page = await read(target);
        assert.equal(page.document.representation, representation); assert.equal(page.document.path, target.identity.path);
        assert.equal(JSON.parse(page.fragment).representation, representation);
        assert.deepEqual(await nativeRows(target), before);
      }
    });
    await check('nonexportable valid Rich remains public-native and semantic-text readable with explicit Markdown failure', async () => {
      const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| [Target](target.md) |', 'tiptap_blocks');
      const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
      for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
        (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
      }
      assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
      const target = await seed('unexportable', 'tiptap_blocks', { doc });
      assert.match((await read(target)).fragment, /"colwidth":\[120\]/u);
      assert.match((await read(target, { format: 'text' })).fragment, /Keep[\s\S]*Target/u);
      await assert.rejects(read(target, { format: 'markdown' }), expected('DOCUMENT_FORMAT_UNAVAILABLE'));
      const response = await POST(await request('owner', 'cookie', workspaceId, JSON.stringify(selection(target, { format: 'markdown' }))));
      assert.equal(response.status, 422); assert.deepEqual(await response.json(), { apiVersion: 1, success: false, code: 'DOCUMENT_FORMAT_UNAVAILABLE' });
    });
    await check('complete Unicode native text and Markdown pages keep the same ID version and exact byte offsets', async () => {
      const text = '\uFEFFÄ🦊日本語e\u0301\r\n'.repeat(5000), target = await seed('unicode', 'plain_text', { text });
      for (const format of ['native', 'text', 'markdown'] as const) {
        let cursor: string | null = null, version: string | undefined, metadataVersion: string | undefined, offset = 0, pages = 0;
        const fragments: string[] = [];
        do {
          const page = await read(target, { format, maxBytes: 65_537, ...(cursor ? { cursor } : {}) }, 'owner', pages % 2 ? 'cookie' : 'bearer');
          pages++; assert.equal(page.document.documentId, target.identity.documentId); assert.equal(page.byteOffset, offset);
          assert.equal(Buffer.byteLength(page.fragment), page.byteLength); assert(page.byteLength <= 65_537);
          version ??= page.document.version; metadataVersion ??= page.document.metadataVersion;
          assert.equal(page.document.version, version); assert.equal(page.document.metadataVersion, metadataVersion);
          offset += page.byteLength; fragments.push(page.fragment); cursor = page.nextCursor;
          assert.equal(page.complete, cursor === null); if (!cursor) assert.equal(offset, page.totalBytes);
        } while (cursor);
        assert(pages > 1); const full = fragments.join('');
        assert.equal(format === 'native' ? JSON.parse(full).content.text : full, text);
      }
    });
    await check('actual Yjs delete-only update invalidates expectedVersion and cursor despite identical state vector', async () => {
      const target = await seed('delete-only', 'plain_text', { text: 'ABCDEFGHIJK 🦊' });
      const before = await read(target, { format: 'text', maxBytes: 4 }); assert(before.nextCursor);
      target.doc.getText('content').delete(5, 1); assert.deepEqual(Buffer.from(Y.encodeStateVector(target.doc)), target.vector);
      await admin.query(`UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3,document_sequence=document_sequence+1,persisted_at=200
        WHERE document_id=$1`, [target.identity.documentId, Buffer.from(Y.encodeStateAsUpdate(target.doc)), Buffer.from(Y.encodeStateVector(target.doc))]);
      await admin.query('UPDATE collaboration_documents SET state_version=state_version+1 WHERE id=$1', [target.identity.documentId]);
      await assert.rejects(read(target, { format: 'text', expectedVersion: before.document.version }), expected('DOCUMENT_VERSION_CONFLICT'));
      await assert.rejects(read(target, { format: 'text', cursor: before.nextCursor }), expected('DOCUMENT_VERSION_CONFLICT'));
      const after = await read(target, { format: 'text' }); assert.notEqual(after.document.version, before.document.version);
      assert.equal(after.fragment, 'ABCDEGHIJK 🦊');
    });
    await check('shared metadata and coherent rename invalidate old cursors without changing content identity or adopting D2', async () => {
      const target = await seed('metadata'), before = await read(target, { format: 'text', maxBytes: 4 }); assert(before.nextCursor);
      await admin.query(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,'Shared title',100,200)`,
        [workspaceId, target.identity.path]);
      const titled = await read(target, { format: 'text', maxBytes: 4 }); assert(titled.nextCursor);
      assert.equal(titled.document.title, 'Shared title'); assert.equal(titled.document.version, before.document.version);
      assert.notEqual(titled.document.metadataVersion, before.document.metadataVersion);
      await assert.rejects(read(target, { format: 'text', cursor: before.nextCursor }), expected('DOCUMENT_VERSION_CONFLICT'));
      const oldPath = target.identity.path, renamed = `renamed-${crypto.randomUUID()}.bin`;
      await admin.query('UPDATE collaboration_documents SET path=$1 WHERE id=$2', [renamed, target.identity.documentId]);
      await admin.query('UPDATE file_collaboration_lineages SET path=$1 WHERE id=$2', [renamed, target.identity.lineageId]);
      await admin.query('UPDATE collaboration_yjs_states SET path=$1 WHERE document_id=$2', [renamed, target.identity.documentId]);
      await admin.query('UPDATE workspace_file_metadata SET path=$1 WHERE workspace_id=$2 AND path=$3', [renamed, workspaceId, oldPath]);
      const d2 = await seed('replacement', 'plain_text', { filePath: oldPath, text: 'D2 must not be selected' });
      const after = await read(target, { format: 'text' });
      assert.equal(after.document.path, renamed); assert.equal(after.document.documentId, target.identity.documentId);
      assert.equal(after.document.version, before.document.version); assert.notEqual(after.document.documentId, d2.identity.documentId);
      await assert.rejects(read(target, { format: 'text', cursor: titled.nextCursor }), expected('DOCUMENT_VERSION_CONFLICT'));
    });
    await check('wrong workspace and an archived original never rebind a selected document ID', async () => {
      const target = await seed('workspace-bound');
      await assert.rejects(readDocumentForRequest(await request('owner', 'bearer', 'personal-owner'),
        selection(target, { workspaceId: 'personal-owner' })), expected('DOCUMENT_NOT_FOUND'));
      await admin.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [target.identity.documentId]);
      await admin.query("UPDATE file_collaboration_lineages SET status='archived',archived_at=200 WHERE id=$1", [target.identity.lineageId]);
      await admin.query("UPDATE collaboration_yjs_states SET status='archived' WHERE document_id=$1", [target.identity.documentId]);
      const d2 = await seed('after-delete', 'plain_text', { filePath: target.identity.path });
      await assert.rejects(read(target), expected('DOCUMENT_NOT_FOUND'));
      assert.equal((await read(d2)).document.documentId, d2.identity.documentId);
    });
    await check('missing native state and quarantine do not fall back to existing stale Markdown bytes', async () => {
      for (const mode of ['missing', 'quarantined'] as const) {
        const target = await seed(mode); const file = path.join(storedWorkspace.rootPath, target.identity.path);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, 'Stale projection must never replace native state.', { mode: 0o600 });
        if (mode === 'missing') await admin.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [target.identity.documentId]);
        else await admin.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [target.identity.documentId]);
        await assert.rejects(read(target, { format: 'text' }), expected(mode === 'missing' ? 'DOCUMENT_STATE_MISSING' : 'DOCUMENT_QUARANTINED'));
        assert.equal(await readFile(file, 'utf8'), 'Stale projection must never replace native state.');
      }
    });
    await check('current missing authentication expired session and banned account deny document content', async () => {
      const target = await seed('auth-denials');
      await assert.rejects(readDocumentForRequest(await request('owner', 'none'), selection(target)), expected('AUTHENTICATION_REQUIRED'));
      try {
        await admin.query("UPDATE \"session\" SET expires_at=0 WHERE id='session-owner'"); await assert.rejects(read(target), forbidden);
      } finally { await seedSession(); }
      try {
        await admin.query("UPDATE \"user\" SET banned=1 WHERE id='owner'"); await assert.rejects(read(target), forbidden);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM "session" WHERE user_id=$1', ['owner'])).rows[0].count, 0,
          'The genuine seat/account guard revokes the banned account sessions.');
      } finally {
        await admin.query("UPDATE \"user\" SET banned=0 WHERE id='owner'");
        await seedSession();
      }
    });
    await check('fresh membership and seat revocation deny old cursor access and another reader cannot reuse its authority binding', async () => {
      const target = await seed('rights'), ownerPage = await read(target, { format: 'text', maxBytes: 4 }); assert(ownerPage.nextCursor);
      assert.equal((await read(target, { format: 'text' }, 'member', 'cookie')).document.documentId, target.identity.documentId);
      await assert.rejects(read(target, { format: 'text', cursor: ownerPage.nextCursor }, 'member', 'cookie'), expected('DOCUMENT_SCOPE_CHANGED'));
      const memberPage = await read(target, { format: 'text', maxBytes: 4 }, 'member', 'cookie'); assert(memberPage.nextCursor);
      try {
        await admin.query("UPDATE organization_user_permissions SET status='disabled' WHERE organization_id='principal-org' AND user_id='member'");
        await assert.rejects(read(target, { format: 'text', cursor: memberPage.nextCursor }, 'member', 'cookie'), forbidden);
      } finally {
        await admin.query("UPDATE organization_user_permissions SET status='active' WHERE organization_id='principal-org' AND user_id='member'");
        await seedSession('member');
      }
      assert.equal((await read(target, { format: 'text' }, 'member', 'cookie')).document.documentId, target.identity.documentId,
        'The seat counterfixture starts with an actually authorized current member session.');
      try {
        await admin.query("UPDATE team_memberships SET status='suspended' WHERE id='member-seat'");
        await assert.rejects(read(target, { format: 'text' }, 'member', 'cookie'), forbidden);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM "session" WHERE user_id=$1', ['member'])).rows[0].count, 0,
          'The genuine suspended-seat denial revokes the member sessions.');
      } finally {
        await admin.query("UPDATE team_memberships SET status='active' WHERE id='member-seat'");
        await seedSession('member');
      }
    });
    await check('genuine PI read invocation uses the public service and fresh invocations share only stable origin continuation', async () => {
      const target = await seed('pi-genuine');
      await audit(async leases => {
        const page = await invoke(() => readDocumentForAgentTool(selection(target, { format: 'text' })));
        assert.equal(page.document.documentId, target.identity.documentId); assertClosed(leases, 'commit');
      });
      const first = await invoke(() => readDocumentForAgentTool(selection(target, { format: 'text', maxBytes: 4 }))); assert(first.nextCursor);
      const next = await invoke(() => readDocumentForAgentTool(selection(target, { format: 'text', cursor: first.nextCursor, maxBytes: 4 })));
      assert.equal(next.byteOffset, first.byteLength); assert.equal(next.document.version, first.document.version);
    });
    await check('PI cannot substitute plain ALS for invocation or reuse an archived stored session', async () => {
      const target = await seed('pi-denied');
      await assert.rejects(readDocumentForAgentTool(selection(target)), expected('AUTHENTICATION_REQUIRED'));
      await assert.rejects(runWithAgentExecutionContext(context(), () => readDocumentForAgentTool(selection(target))), expected('AUTHENTICATION_REQUIRED'));
      try {
        await admin.query("UPDATE pi_sessions SET archived_at=200 WHERE session_id='pi-read'");
        await assert.rejects(invoke(() => readDocumentForAgentTool(selection(target))), expected('AUTHENTICATION_REQUIRED'));
      } finally { await admin.query("UPDATE pi_sessions SET archived_at=NULL WHERE session_id='pi-read'"); }
    });
    await check('actual late namespace generation and shared metadata drift roll back before public output', async () => {
      for (const mode of ['search-path', 'namespace-oid', 'generation', 'metadata'] as const) {
        const target = await seed('late-scope'); let injected = false;
        await audit(async leases => {
          await assert.rejects(read(target), expected('DOCUMENT_SCOPE_CHANGED'));
          assert.equal(injected, true); assertClosed(leases, 'rollback');
        }, { after: async (lease, sql) => {
          if (!injected && projectionQuery(sql)) {
            injected = true;
            if (mode === 'search-path') await actualSql(lease, `SET LOCAL search_path=${schema},pg_catalog,public`);
            if (mode === 'namespace-oid') {
              const absent = await actualSql(lease, 'SELECT to_regnamespace($1) IS NULL AS absent', [retiredSchema]) as { rows: Array<{ absent: boolean }> };
              assert.equal(absent.rows[0].absent, true);
              await actualSql(lease, `ALTER SCHEMA "${schema}" RENAME TO "${retiredSchema}"`);
              await actualSql(lease, `CREATE SCHEMA "${schema}"`);
              const replaced = await actualSql(lease, 'SELECT to_regnamespace($1)::oid::text AS oid', [schema]) as { rows: Array<{ oid: string }> };
              replacementSchemaOid = replaced.rows[0].oid; assert.match(replacementSchemaOid, /^[1-9][0-9]*$/u);
              assert.notEqual(replacementSchemaOid, initialSchemaOid);
            }
            if (mode === 'generation') await actualSql(lease, 'UPDATE collaboration_yjs_states SET lifecycle_generation=lifecycle_generation+1 WHERE document_id=$1', [target.identity.documentId]);
            if (mode === 'metadata') await actualSql(lease, `INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at)
              VALUES($1,$2,'Late title',100,200)`, [workspaceId, target.identity.path]);
          }
        } });
        assert.equal(Number((await admin.query('SELECT lifecycle_generation FROM collaboration_yjs_states WHERE document_id=$1', [target.identity.documentId])).rows[0].lifecycle_generation), 1);
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [workspaceId, target.identity.path])).rows[0].count, 0);
        const realm = (await control.query('SELECT to_regnamespace($1)::oid::text AS oid,to_regnamespace($2) IS NULL AS retired_absent', [schema, retiredSchema])).rows[0];
        assert.equal(realm.oid, initialSchemaOid); assert.equal(realm.retired_absent, true);
      }
    });
    await check('actual final account session and permission revocation cannot publish a precomputed page', async () => {
      for (const mode of ['ban', 'expiry', 'permission'] as const) {
        const target = await seed('late-auth'); let injected = false;
        const userId = mode === 'permission' ? 'member' : 'owner';
        await audit(async leases => {
          await assert.rejects(read(target, {}, userId), forbidden); assert.equal(injected, true); assertClosed(leases, 'rollback');
        }, { after: async (lease, sql) => {
          if (!injected && projectionQuery(sql)) {
            injected = true;
            if (mode === 'ban') await actualSql(lease, 'UPDATE "user" SET banned=1 WHERE id=$1', [userId]);
            if (mode === 'expiry') await actualSql(lease, 'UPDATE "session" SET expires_at=0 WHERE user_id=$1', [userId]);
            if (mode === 'permission') await actualSql(lease, "UPDATE organization_user_permissions SET status='disabled' WHERE organization_id='principal-org' AND user_id=$1", [userId]);
          }
        } });
        assert.equal(Number((await admin.query('SELECT banned FROM "user" WHERE id=$1', [userId])).rows[0].banned), 0);
        assert.equal((await admin.query('SELECT status FROM organization_user_permissions WHERE user_id=$1', [userId])).rows[0].status, 'active');
        assert(Number((await admin.query('SELECT expires_at FROM "session" WHERE user_id=$1', [userId])).rows[0].expires_at) > Date.now());
      }
    });
    await check('actual PI invocation abort during final service work rejects and rolls back', async () => {
      const target = await seed('pi-abort'), abort = new AbortController(); let aborted = false;
      await audit(async leases => {
        await assert.rejects(invoke(() => readDocumentForAgentTool(selection(target)), abort.signal), expected('DOCUMENT_SCOPE_CHANGED'));
        assert.equal(aborted, true); assertClosed(leases, 'rollback');
      }, { after: (_lease, sql) => { if (!aborted && projectionQuery(sql)) { aborted = true; abort.abort(); } } });
    });
    await check('lost actual COMMIT acknowledgement stays unconfirmed after the actual commit and never retries', async () => {
      const target = await seed('commit-ack'); let injected = false;
      await audit(async leases => {
        await assert.rejects(read(target), expected('READ_OUTCOME_UNCONFIRMED')); assert.equal(injected, true); assertClosed(leases, 'commit');
      }, { before: async (lease, sql) => {
        if (sql === 'COMMIT') await actualSql(lease, "INSERT INTO fixture_writes VALUES('read-commit-ack','actual B committed')");
      }, after: (_lease, sql) => { if (sql === 'COMMIT' && !injected) { injected = true; throw new Error('Owned actual COMMIT acknowledgement loss'); } } });
      assert.equal((await admin.query("SELECT value FROM fixture_writes WHERE id='read-commit-ack'")).rows[0].value, 'actual B committed');
    });
    await check('lost actual ROLLBACK acknowledgement remains unconfirmed and actual self-drift is rolled back', async () => {
      const target = await seed('rollback-ack'); let drifted = false, injected = false;
      await audit(async leases => {
        await assert.rejects(read(target), expected('READ_OUTCOME_UNCONFIRMED')); assert.equal(drifted, true); assert.equal(injected, true);
        assertClosed(leases, 'rollback');
      }, { after: async (lease, sql) => {
        if (!drifted && projectionQuery(sql)) {
          drifted = true; await actualSql(lease, 'UPDATE collaboration_yjs_states SET lifecycle_generation=lifecycle_generation+1 WHERE document_id=$1', [target.identity.documentId]);
        }
        if (sql === 'ROLLBACK' && !injected) { injected = true; throw new Error('Owned actual ROLLBACK acknowledgement loss'); }
      } });
      assert.equal(Number((await admin.query('SELECT lifecycle_generation FROM collaboration_yjs_states WHERE document_id=$1', [target.identity.documentId])).rows[0].lifecycle_generation), 1);
    });
    await check('failure after actual pool release never reports a successful page', async () => {
      const target = await seed('close-ack'); let injected = false;
      await audit(async leases => {
        await assert.rejects(read(target), expected('READ_OUTCOME_UNCONFIRMED')); assert.equal(injected, true); assertClosed(leases, 'commit');
      }, { afterRelease: () => { injected = true; throw new Error('Owned close acknowledgement failure after actual pool release'); } });
      assert.equal(pool!.idleCount, pool!.totalCount);
    });
    assert.equal(passed, 21); assert.equal(fetches, 0); await own();
    console.log('Document public read service SQL assertions complete:', JSON.stringify({ passed, fetches,
      observedLeases: runtimeLeases.length, allObservedLeasesReleased: runtimeLeases.every(lease => lease.released === 1) }));
  } catch (error) { primaryFailure = error; }
  finally {
    Client.prototype.query = rawQuery;
    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
    for (const document of ownedDocuments) await cleanup(async () => { document.destroy(); });
    for (const lease of runtimeLeases) if (!lease.released) {
      cleanupErrors.push(new Error('Public service left an observed owned lease undisposed.'));
      await cleanup(async () => {
        try { await Reflect.apply(rawQuery, lease.client, ['ROLLBACK']); }
        finally { if (lease.originalRelease) Reflect.apply(lease.originalRelease, lease.client, [new Error('Discarding leaked owned fixture lease.')]); }
      });
    }
    if (pool) await cleanup(() => pool!.end());
    for (const client of clients) await cleanup(() => endClient(client));
    if (created && clients.size === 0 && connected && cleanupErrors.length === 0) await cleanup(async () => {
      const remaining = await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 OR application_name=$2',
        [applicationName, applicationName + '-admin']);
      assert.equal(remaining.rows[0].count, 0);
      assert(initialSchemaOid);
      const owned = await control.query('SELECT nspname,oid::text AS oid FROM pg_namespace WHERE nspname=ANY($1::text[])', [[schema, retiredSchema]]);
      for (const row of owned.rows as Array<{ nspname: string; oid: string }>) {
        assert([schema, retiredSchema].includes(row.nspname));
        assert(row.oid === initialSchemaOid || row.oid === replacementSchemaOid);
        assert.equal((await control.query('SELECT to_regnamespace($1)::oid::text AS oid', [row.nspname])).rows[0].oid, row.oid);
        await control.query(`DROP SCHEMA "${row.nspname}" CASCADE`);
        assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [row.nspname])).rows[0].removed, true);
      }
      assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AND to_regnamespace($2) IS NULL AS removed', [schema, retiredSchema])).rows[0].removed, true);
    });
    await cleanup(() => control.end());
    await cleanup(async () => {
      await rm(dataRoot, { recursive: true, force: true });
      await assert.rejects(stat(dataRoot), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
    });
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    if (cleanupErrors.length) throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Owned document public service cleanup failed.');
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  complete = true;
  console.log('Document Read Public Service PostgreSQL18 finished:', JSON.stringify({ passed, cleanup: true }));
}

main().catch(error => {
  console.error('Owned document public service fixture failed:', { stage, passed, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null }); process.exitCode = 1;
});
