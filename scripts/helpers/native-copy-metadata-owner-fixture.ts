import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { types } from 'node:util';
import { parse } from 'dotenv';
import { Client, type Pool, type PoolClient, type QueryResult } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../../app/lib/db';
import type { WorkspaceContext } from '../../app/lib/workspaces/types';

export type MetadataSqlEvent = Readonly<{ text: string; values: unknown[]; queryForm: 'text' | 'native-adapter' | 'drizzle'; client: PoolClient; result: QueryResult;
  raw: (text: string, values?: unknown[]) => Promise<QueryResult> }>;
export type MetadataSqlProbe = (event: MetadataSqlEvent) => Promise<void>;
// This helper owns only private configuration/schema/data. Real request
// principals, source READ, destination WRITE, Stage/FD/SQL owners are unchanged.
export async function withNativeCopyMetadataOwnerFixture<T>(operation: (fixture: {
  schema: string; schemaOid: string; applicationName: string; dataRoot: string;
  admin: Client; connection: SqlConnection; source: WorkspaceContext; destination: WorkspaceContext;
  request: (workspace?: WorkspaceContext, userId?: 'owner' | 'member', cookie?: boolean, sessionToken?: string) => Promise<NextRequest>;
  upload: (filePath: string, content: Buffer) => Promise<{ documentId: string; lifecycleGeneration: number }>;
  metadata: (workspace: WorkspaceContext, filePath: string, values: { title?: string | null; isFavorite?: boolean; pinned?: boolean }, userId?: 'owner' | 'member', sessionToken?: string) => Promise<void>;
  withProbe: <R>(probe: MetadataSqlProbe, callback: () => Promise<R>) => Promise<R>;
}) => Promise<T>): Promise<T> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  const config = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
  assert.equal((await stat(config)).mode & 0o077, 0);
  const connectionString = parse(await readFile(config, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString); assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['localhost', '127.0.0.1'].includes(url.hostname)); assert.equal(url.port, '55433');
  assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const schema = `copy_metadata_${crypto.randomUUID().replaceAll('-', '')}`, applicationName = `copy-metadata-${crypto.randomUUID().replaceAll('-', '')}`;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-copy-metadata-'))), dataIdentity = await lstat(dataRoot);
  assert.equal(dataIdentity.uid, process.getuid!()); assert.equal(dataIdentity.mode & 0o077, 0);
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, application_name: `${applicationName}-admin`, connectionTimeoutMillis: 5000 });
  let admin: Client | undefined, pool: Pool | undefined, created = false, schemaOid = '', probe: MetadataSqlProbe | undefined;
  let fetches = 0, activeProbe = false, result!: T, failed = false, primary: unknown;
  const observed = new Map<PoolClient, PropertyDescriptor | undefined>(), restorers: Array<() => void> = [];
  try {
    await control.connect(); assert.equal(Math.floor(Number((await control.query("SHOW server_version_num")).rows[0].server_version_num) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${applicationName}'`);
    const identity = (await control.query('SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
    assert.equal(identity.owned, true); schemaOid = identity.oid;
    console.log(JSON.stringify({ fixture: 'native-copy-metadata-owner', schema, schemaOid, applicationName, dataRoot, pid: process.pid }));
    Object.assign(process.env, { DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`, PGAPPNAME: applicationName,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_TEST_NATIVE_TEXT_SESSION: '1', CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: 'principal-org',
      CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production',
      CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS', 'NEXT_PHASE']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000), claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'metadata-fixture-license',
      sub: process.env.CANVAS_INSTANCE_ID, instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('Network is forbidden in the private metadata fixture.'); };
    admin = new Client({ connectionString, application_name: `${applicationName}-fixture`, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000` });
    await admin.connect(); const fixtureAdmin = admin;
    const { runPostgresMigrations } = await import('../../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      const before = (await fixtureAdmin.query("SELECT current_schema() AS schema,current_setting('search_path') AS path")).rows[0];
      assert.equal(before.schema, schema); assert.deepEqual(before.path.split(',').map((part: string) => part.trim()), [schema, 'pg_catalog']);
      const answer = await fixtureAdmin.query(sql, values); assert.equal((await fixtureAdmin.query('SELECT current_schema() AS schema')).rows[0].schema, schema); return answer;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const { getPostgresRuntimeQueryable } = await import('../../app/lib/db');
    pool = getPostgresRuntimeQueryable() as Pool; assert(pool);
    assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { verifyLicenseJwtDetailed } = await import('../../app/lib/license/jwt');
    const { getLicenseStatus } = await import('../../app/lib/license');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!, process.env.CANVAS_INSTANCE_ID!)).ok, true);
    assert.equal((await getLicenseStatus()).licensed, true);
    const now = Date.now();
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@principal.test',1,'admin',0,$1,$1),('member','Member','member@principal.test',1,'user',0,$1,$1)`, [now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('principal-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES('principal-org','owner','owner','active',1,100,100),('principal-org','member','member','active',0,100,100)`);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','principal-org','owner@principal.test','owner','owner','active',100,100,100,100),
      ('member-seat','principal-org','member@principal.test','member','member','active',100,200,100,100)`);
    await admin.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('principal-org',100,100)");
    const tokens = new Map<string, string>();
    for (const userId of ['owner', 'member']) {
      const token = crypto.randomBytes(32).toString('hex'); tokens.set(userId, token);
      await admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
        [`session-${userId}`, token, userId, now + 3600000, now]);
    }
    const { resolveWorkspaceActor } = await import('../../app/lib/workspaces/context');
    const { createPostgresWorkspaceForActor, upsertPostgresWorkspaceMemberForActor, readPostgresWorkspaceForActorOnConnection } = await import('../../app/lib/workspaces/postgres-runtime');
    const actor = (id: string) => resolveWorkspaceActor({ id, role: id === 'owner' ? 'admin' : 'user', email: `${id}@principal.test` });
    const sourceOwner = await createPostgresWorkspaceForActor(actor('owner'), { type: 'team', name: 'Metadata source' });
    const destinationOwner = await createPostgresWorkspaceForActor(actor('owner'), { type: 'team', name: 'Metadata destination' });
    await upsertPostgresWorkspaceMemberForActor(actor('owner'), sourceOwner.workspaceId, { userId: 'member', canRead: true, canWrite: false, canManage: false });
    await upsertPostgresWorkspaceMemberForActor(actor('owner'), destinationOwner.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    const connection: SqlConnection = { get: async (sql, values) => (await fixtureAdmin.query(sql, values)).rows[0],
      all: async (sql, values) => (await fixtureAdmin.query(sql, values)).rows, run: async (sql, values) => ({ changes: (await fixtureAdmin.query(sql, values)).rowCount ?? 0 }),
      close: () => assert.fail('Private fixture reader does not own the admin connection.') };
    const source = await readPostgresWorkspaceForActorOnConnection(connection, actor('member'), sourceOwner.workspaceId);
    const destination = await readPostgresWorkspaceForActorOnConnection(connection, actor('member'), destinationOwner.workspaceId); assert(source && destination);
    assert(source.permissions.canRead && !source.permissions.canWrite); assert(destination.permissions.canWrite);
    const request = async (workspace = source, userId: 'owner' | 'member' = 'member', cookie = false, sessionToken?: string) => {
      // A rotated fixture session remains a real credential checked by auth.
      const token = sessionToken ?? tokens.get(userId); assert(token); const headers = new Headers({ 'x-canvas-workspace-id': workspace.workspaceId });
      if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', token, process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization', `Bearer ${token}`);
      return new NextRequest('http://localhost/api/files/copy', { method: 'POST', headers });
    };
    const { auth } = await import('../../app/lib/auth');
    assert.equal((await auth.api.getSession({ headers: (await request()).headers }))?.session.id, 'session-member');
    const { initializeCreatedWorkspaceStarter } = await import('../../app/lib/workspaces/starter-document-initialization-api');
    const { readWorkspaceStarterInitializationIntent } = await import('../../app/lib/workspaces/starter-document-initialization-store');
    const { WORKSPACE_STARTER_DOCUMENT_NAME } = await import('../../app/lib/workspaces/starter-document');
    for (const selected of [source, destination]) {
      const file = path.join(selected.rootPath, WORKSPACE_STARTER_DOCUMENT_NAME), before = await readFile(file);
      const intent = await readWorkspaceStarterInitializationIntent(connection, selected.workspaceId); assert(intent);
      const completion = await initializeCreatedWorkspaceStarter(await request(selected, 'owner'), selected.workspaceId); assert(completion);
      assert.equal(completion.status, 'completed'); assert.equal(completion.operationId, intent.operationId);
      const receipt: { private_result: { sourceHash: string } } | undefined = (await admin.query('SELECT private_result FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2', [selected.workspaceId, intent.operationId])).rows[0];
      assert(receipt); assert.equal(receipt.private_result.sourceHash, crypto.createHash('sha256').update(before).digest('hex'));
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2', [selected.workspaceId, WORKSPACE_STARTER_DOCUMENT_NAME])).rows[0].n, 1);
      assert.deepEqual(await readFile(file), before);
    }
    const upload = async (filePath: string, content: Buffer) => {
      const uploads = await import('../../app/lib/files/workspace-upload-service');
      const { persistAndProjectAuthenticatedMarkdownUploadFile } = await import('../../app/lib/collaboration/markdown-file-import-persistence');
      const original = await request(source, 'owner');
      const session = await uploads.createWorkspaceUploadSession({ userId: 'owner', workspace: sourceOwner, targetDir: '.',
        files: [{ path: filePath, size: content.length, mimeType: 'text/markdown' }] });
      await uploads.writeWorkspaceUploadChunk({ sessionId: session.id, userId: 'owner', workspace: sourceOwner, fileId: session.files[0].id,
        offset: 0, expectedBytes: content.length, body: new Blob([new Uint8Array(content)]).stream() });
      const applied = await persistAndProjectAuthenticatedMarkdownUploadFile(original, { uploadSessionId: session.id, fileId: session.files[0].id,
        workspaceId: source.workspaceId, targetPath: filePath, actorUserId: 'owner', actorSessionId: 'session-owner', requestId: crypto.randomUUID(), operationId: crypto.randomUUID() });
      assert.equal(applied.projection.status, 'projected'); assert.deepEqual(await readFile(path.join(source.rootPath, filePath)), content);
      return { documentId: applied.receipt.target.documentId, lifecycleGeneration: applied.receipt.target.lifecycleGeneration };
    };
    const metadata = async (workspace: WorkspaceContext, filePath: string, values: { title?: string | null; isFavorite?: boolean; pinned?: boolean }, userId: 'owner' | 'member' = 'owner', sessionToken?: string) => {
      const { updateWorkspaceFileMetadata } = await import('../../app/lib/files/workspace-file-metadata');
      const row = (await admin!.query('SELECT d.id,s.lifecycle_generation FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.workspace_id=$1 AND d.path=$2 AND d.status=$3', [workspace.workspaceId, filePath, 'active'])).rows[0]; assert(row);
      await updateWorkspaceFileMetadata(await request(workspace, userId, false, sessionToken), { path: filePath,
        expectedTarget: { version: 1, kind: 'native_file', workspaceId: workspace.workspaceId, path: filePath, documentId: row.id, lifecycleGeneration: Number(row.lifecycle_generation) }, ...values });
    };
    // SQL is always executed first. Hooks observe/fault actual acknowledgements;
    // they do not substitute rows, principals, checkouts or domain callbacks.
    const onConnect = (client: PoolClient) => {
      if (observed.has(client)) return; const descriptor = Object.getOwnPropertyDescriptor(client, 'query'); observed.set(client, descriptor);
      const original = client.query;
      const raw = original.bind(client) as (sql: string, values?: unknown[]) => Promise<QueryResult>;
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        // Preserve every original overload and argument. In addition to the
        // SQL adapter's inert config, observe Drizzle's actual config/params
        // form without reading or replacing its opaque type-parser object.
        // pg-pool forwards a Promise query to its client with this third
        // callback. Every other callback/stream overload stays untouched.
        const callback = args.length === 3 && typeof args[2] === 'function' && Array.isArray(args[1])
          && args[0] !== null && typeof args[0] === 'object' ? args[2] as (...values: unknown[]) => unknown : undefined;
        if (typeof args.at(-1) === 'function' && !callback) return Reflect.apply(original, client, args);
        let text: string, values: unknown[] | undefined, queryForm: MetadataSqlEvent['queryForm'] = 'text';
        if (typeof args[0] === 'string') {
          text = args[0]; values = args[1] as unknown[] | undefined;
        } else {
          const config = args[0];
          if (!config || typeof config !== 'object' || types.isProxy(config)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(config))) return Reflect.apply(original, client, args);
          const fields = Object.getOwnPropertyDescriptors(config), keys = Reflect.ownKeys(config);
          if (!Object.values(fields).every(field => 'value' in field)
            || typeof fields.text?.value !== 'string') return Reflect.apply(original, client, args);
          const adapter = args.length === 1 && keys.length === 3
            && keys.every(key => typeof key === 'string' && ['name', 'text', 'values'].includes(key))
            && typeof fields.name?.value === 'string'
            && (fields.values?.value === undefined || Array.isArray(fields.values.value));
          const drizzle = (args.length === 2 || callback !== undefined) && Array.isArray(args[1])
            && keys.length === (Object.hasOwn(fields, 'rowMode') ? 4 : 3)
            && keys.every(key => typeof key === 'string' && ['name', 'text', 'types', 'rowMode'].includes(key))
            && Object.hasOwn(fields, 'name') && Object.hasOwn(fields, 'types')
            && (fields.name.value === undefined || typeof fields.name.value === 'string')
            && (!Object.hasOwn(fields, 'rowMode') || fields.rowMode.value === 'array');
          if (!adapter && !drizzle) return Reflect.apply(original, client, args);
          queryForm = adapter ? 'native-adapter' : 'drizzle';
          text = fields.text.value; values = adapter ? fields.values.value : args[1] as unknown[];
        }
        const reportSqlFailure = (error: unknown) => {
          try {
            const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
            if (code !== '55P03' && code !== '25P04') return;
            const operation = /^\s*(SELECT|LOCK|INSERT|UPDATE|DELETE|WITH)\b/iu.exec(text)?.[1].toUpperCase() ?? 'OTHER';
            const relations = ['workspace_file_operation_batches', 'canvas_organization_settings', 'canvas_workspaces',
              'canvas_workspace_members', 'organization_user_permissions', 'team_memberships', 'session', 'user',
              'collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages',
              'collaboration_admission_requests', 'collaboration_admission_targets']
              .filter(name => new RegExp(`\\b${name}\\b`, 'u').test(text));
            console.error(JSON.stringify({ diagnostic: 'native-copy-metadata-owner-sql-failure', sqlstate: code, operation, relations }));
          } catch { /* Diagnostics retain the original SQL error and callback behavior. */ }
        };
        if (callback) {
          const forwarded = [...args];
          forwarded[2] = function (this: unknown, ...callbackArgs: unknown[]) {
            const currentProbe = probe;
            if (callbackArgs[0] != null) { reportSqlFailure(callbackArgs[0]); return Reflect.apply(callback, this, callbackArgs); }
            if (!currentProbe || activeProbe) return Reflect.apply(callback, this, callbackArgs);
            activeProbe = true;
            const deliver = (outcome: unknown[]) => {
              activeProbe = false;
              try { Reflect.apply(callback, this, outcome); }
              catch (error) { process.nextTick(() => { throw error; }); }
            };
            // Await only after native pg supplied the real successful result,
            // while its pool callback still retains this exact acquired client.
            // Both Promise branches terminate; callback throws follow pg's own
            // nextTick policy instead of becoming an unhandled rejection.
            void Promise.resolve().then(() => currentProbe({ text, values: values ?? [], queryForm, client,
              result: callbackArgs[1] as QueryResult, raw })).then(
              () => deliver(callbackArgs),
              error => deliver([error instanceof Error ? error : new Error('Metadata SQL probe failed.', { cause: error }),
                ...callbackArgs.slice(1)]),
            );
          };
          return Reflect.apply(original, client, forwarded);
        }
        return (async () => {
          let answer: QueryResult;
          try { answer = await Reflect.apply(original, client, args) as QueryResult; }
          catch (error) { reportSqlFailure(error); throw error; }
          if (probe && !activeProbe) { activeProbe = true;
            try { await probe({ text, values: values ?? [], queryForm, client, result: answer, raw }); } finally { activeProbe = false; } }
          return answer;
        })();
      } });
    };
    pool.on('connect', onConnect); pool.on('acquire', onConnect);
    restorers.push(() => { pool!.off('connect', onConnect); pool!.off('acquire', onConnect);
      for (const [client, descriptor] of observed) { if (descriptor) Object.defineProperty(client, 'query', descriptor); else Reflect.deleteProperty(client, 'query'); } });
    result = await operation({ schema, schemaOid, applicationName, dataRoot, admin, connection, source, destination, request, upload, metadata,
      withProbe: async (value, callback) => { assert.equal(probe, undefined); probe = value; try { return await callback(); } finally { probe = undefined; } } });
    assert.equal(fetches, 0);
  } catch (error) { failed = true; primary = error; }
  finally {
    const errors: unknown[] = []; for (const restore of restorers.reverse()) try { restore(); } catch (error) { errors.push(error); }
    globalThis.fetch = originalFetch;
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await admin?.end(); } catch (error) { errors.push(error); }
    try {
      if (created) {
        assert.equal((await control.query('SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name=ANY($1::text[])', [[applicationName, `${applicationName}-fixture`]])).rows[0].n, 0);
        const current = (await control.query("SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned,obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1", [schema])).rows[0];
        assert.equal(current?.oid, schemaOid); assert.equal(current?.owned, true); assert.equal(current?.marker, applicationName);
        await control.query(`DROP SCHEMA "${schema}" CASCADE`);
        assert.equal((await control.query('SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname=$1 OR oid::text=$2', [schema, schemaOid])).rows[0].n, 0);
      }
    } catch (error) { errors.push(error); }
    try { await control.end(); } catch (error) { errors.push(error); }
    try { const current = await lstat(dataRoot); assert.equal(current.dev, dataIdentity.dev); assert.equal(current.ino, dataIdentity.ino); assert.equal(current.uid, dataIdentity.uid);
      await rm(dataRoot, { recursive: true }); await assert.rejects(lstat(dataRoot), { code: 'ENOENT' }); } catch (error) { errors.push(error); }
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    if (errors.length) throw new AggregateError(failed ? [primary, ...errors] : errors, 'Private metadata fixture closure failed.');
    console.log(JSON.stringify({ closure: 'native-copy-metadata-owner', schema, schemaOid, applicationName, schemaRemoved: true, poolClosed: true, clientsClosed: true, dataRemoved: true, fetches }));
    if (failed) throw primary;
  }
  return result;
}
