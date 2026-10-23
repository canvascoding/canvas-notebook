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
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { ExistingNativeSessionIdentity } from '../app/lib/collaboration/native-session-state-reader';

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
// Actual PG18 kernel probes plus genuine Web-principal positives. Direct SQL
// counterfixtures are not public mutation/authorization acceptance. No FS/Markdown fallback.
let stage = 'private configuration';
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost','127.0.0.1'].includes(url.hostname));
  assert.equal(url.port,'55433'); assert.equal(url.pathname,'/canvas_notebook'); assert.equal(url.search,'');
  const schema = `native_document_read_${crypto.randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^native_document_read_[a-f0-9]{32}$/u);
  const workspaceId = `native-auth-${crypto.randomUUID()}`;
  const dataRoot = await mkdtemp(path.join(tmpdir(),'canvas-native-document-read-'));
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options:'-c statement_timeout=15000', connectionTimeoutMillis:5000 });
  const clients = new Set<Client>(); let created = false; let pool: { end:()=>Promise<void> } | undefined;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis:5000,
      options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=native-document-read-fixture` });
    client.on('error',()=>undefined); // transaction_timeout may terminate this owned fixture client.
    clients.add(client); await client.connect(); return client;
  };
  const connection = (client: Client): SqlConnection => ({
    get: async (sql,values) => (await client.query(sql,values)).rows[0],
    all: async (sql,values) => (await client.query(sql,values)).rows,
    run: async (sql,values) => ({ changes:(await client.query(sql,values)).rowCount ?? 0 }),
    close: () => { throw new Error('Principal must never close caller-owned connection.'); },
  });
  const endClient = async (client:Client) => { await client.end(); clients.delete(client); };
  let cases = 0;
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version)/10000),18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    // Set node-postgres PGOPTIONS BEFORE importing any runtime DB/Auth module.
    // No public fallback, no public-qualified epoch conversion/extension path.
    Object.assign(process.env,{ DATABASE_URL:connectionString,PGOPTIONS:`-c search_path=${schema},pg_catalog -c statement_timeout=15000`,
      CANVAS_DATABASE_PROVIDER:'postgres',DATA:dataRoot,CANVAS_DATA_ROOT:dataRoot,CANVAS_INSTANCE_ID:`fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET:crypto.randomBytes(32).toString('hex'),BETTER_AUTH_BASE_URL:'http://localhost',AUTH_COOKIE_SECURE:'false',
      CANVAS_MCP_DIRECT_ENABLED:'false',CANVAS_ORGANIZATION_ID:'principal-org',CANVAS_DEPLOYMENT_MODE:'team',CANVAS_TEAM_FEATURES_ENABLED:'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT:'production',CANVAS_LICENSE_CONTROL_PLANE_URL:'https://control.example.test' });
    delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY;
    delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS; delete process.env.NEXT_PHASE;
    const keys = crypto.generateKeyPairSync('rsa',{ modulusLength:2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type:'spki',format:'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type:'spki',format:'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now()/1000);
    const claims = { protocolVersion:'canvas-team-seat-protocol-v1',licenseId:'principal-license',sub:process.env.CANVAS_INSTANCE_ID,
      instanceId:process.env.CANVAS_INSTANCE_ID,iss:'canvas-control-plane',aud:'canvas-notebook',plan:'community',status:'active',
      hostingMode:'community',edition:'team',licenseClass:'commercial',licenseEnvironment:'production',nonBillable:false,
      seatLimit:2,quotas:{ users:2 },entitlementsVersion:6,iat:seconds-60,exp:seconds+3600 };
    const header = Buffer.from(JSON.stringify({ alg:'RS256',typ:'JWT',kid:fingerprint.slice(0,16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256',Buffer.from(`${header}.${body}`),keys.privateKey).toString('base64url')}`;
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error('No network/issuer is permitted in this isolated fixture.'); };
    stage = 'actual owned-schema global DDL';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const admin = await ownClient();
    const own = async (client:Client) => {
      const row = (await client.query("SELECT current_schema() AS schema,current_setting('search_path') AS path")).rows[0];
      assert.equal(row.schema,schema); assert.deepEqual(row.path.split(',').map((s:string)=>s.trim()),[schema,'pg_catalog']);
    };
    await runPostgresMigrations({ query:async (sql:string,values?:unknown[]) => {
      await own(admin); const result = await admin.query(sql,values); await own(admin); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    stage = 'real users, memberships and auth sessions';
    const now = Date.now();
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@principal.test',1,'admin',0,$1,$1),
      ('member','Member','member@principal.test',1,'user',0,$1,$1),
      ('inactive','Inactive','inactive@principal.test',1,'user',0,$1,$1)`,[now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('principal-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES('principal-org','owner','owner','active',1,100,100),('principal-org','member','member','active',0,100,100),
      ('principal-org','inactive','member','disabled',0,100,100)`);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','principal-org','owner@principal.test','owner','owner','active',100,100,100,100),
      ('member-seat','principal-org','member@principal.test','member','member','active',100,200,100,100),
      ('inactive-seat','principal-org','inactive@principal.test','inactive','admin','suspended',100,50,100,100)`);
    await admin.query(`INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('principal-org',100,100)`);
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES($1,'principal-org','organization','Organization','organizations/principal-org/shared','active',100,100)`,[workspaceId]);
    for (const userId of ['owner','member','inactive']) {
      await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
        VALUES($1,'principal-org','personal',$2,$2,$3,'active',100,100)`,[`personal-${userId}`,userId,`users/${userId}/workspace`]);
    }
    const tokens:Record<string,string> = {};
    const seedSession = async (userId='owner') => {
      const token = crypto.randomBytes(32).toString('hex'); tokens[userId]=token;
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at`,
      [`session-${userId}`,token,userId,Date.now()+3600000,now]);
    };
    await seedSession(); await seedSession('member');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema,schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!,process.env.CANVAS_INSTANCE_ID!)).ok,true);
    const license = await getLicenseStatus(); assert.equal(license.licensed,true); assert.equal(license.edition,'team'); assert.equal(license.seatLimit,2);
    const { withWorkspaceRequestPrincipal: capture, withWorkspaceRequestPrincipalOnConnection: principalPhase } = await import('../app/lib/workspaces/request-principal');
    const { readNativeDocumentByIdOnConnection: readById } = await import('../app/lib/collaboration/native-document-read');
    const { DocumentReadError } = await import('../app/lib/documents/contracts');
    const { createPlainTextYDoc, createRichMarkdownYDoc, validateRichMarkdownYDoc, richMarkdownSchemaExtensions } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
    const { installCollaborationDocumentReader, isLiveCollaborationDocumentReaderAvailable } = await import('../app/lib/collaboration/document-access');
    const { getSchema } = await import('@tiptap/core');
    const { CollaborationBlockTree } = await import('../app/lib/collaboration/block-tree');
    const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { collaborationAdmissionActionDigest, collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const request = async (userId = 'owner', cookie = false) => {
      const headers = new Headers({ 'x-canvas-workspace-id': workspaceId });
      if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens[userId], process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization', `Bearer ${tokens[userId]}`);
      return new NextRequest('http://localhost/api/files/collaboration/session', { method: 'POST', headers });
    };
    const transaction = async <T>(operation: (db: SqlConnection, client: Client) => Promise<T>,
      begin = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE', assignXid = true): Promise<T> => {
      const client = await ownClient(); let began = false;
      try {
        await client.query(begin); began = true;
        if (assignXid) await client.query('SELECT pg_current_xact_id()');
        const value = await operation(connection(client), client);
        await client.query('COMMIT'); began = false; return value;
      } catch (primary) {
        if (began) try { await client.query('ROLLBACK'); }
        catch (rollback) { throw new AggregateError([primary, rollback], 'Owned native reader rollback unconfirmed.'); }
        throw primary;
      } finally { await endClient(client); }
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); cases++; console.log(`Native document by-ID reader passed: ${name}`);
    };
    const expected = (wanted: ConstructorParameters<typeof DocumentReadError>[0], status: number) => (error: unknown) => {
      assert(error instanceof DocumentReadError); assert.equal(error.code, wanted); assert.equal(error.status, status); return true;
    };
    const seed = async (label: string, representation: ExistingNativeSessionIdentity['representation'] = 'plain_text',
      options: { empty?: boolean; doc?: InstanceType<typeof Y.Doc>; filePath?: string } = {}) => {
      const documentId = `doc-${crypto.randomUUID()}`, lineageId = `lineage-${crypto.randomUUID()}`, filePath = options.filePath ?? `${label}-${crypto.randomUUID()}.md`;
      const doc = options.doc ?? (representation === 'plain_text' ? createPlainTextYDoc(options.empty ? '' : 'ABC')
        : createRichMarkdownYDoc(options.empty ? '' : '# Rich native\n', representation));
      const update = Buffer.from(Y.encodeStateAsUpdate(doc)), vector = Buffer.from(Y.encodeStateVector(doc)), proof = collaborationStateProof(doc, Y);
      if (!options.doc) doc.destroy();
      const sequence = options.empty ? 0 : 7;
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization','principal-org',$3,'active',100)`, [lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'organization','principal-org',$4,'yjs',$5,'initialized','active',100,100)`, [documentId, lineageId, workspaceId, filePath, sequence]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,'principal-org',$3,$4,1,1,$5,$6,$7,100,0,NULL,NULL,NULL,'crlf',1,0,'active')`,
      [documentId, workspaceId, filePath, representation, update, vector, sequence]);
      const identity: ExistingNativeSessionIdentity = { documentId, lineageId, workspaceId, organizationId: 'principal-org', path: filePath,
        lifecycleGeneration: 1, representation, schemaVersion: 1 };
      return { identity, update, vector, proof, sequence };
    };
    type Target = Awaited<ReturnType<typeof seed>>;
    const stored = async (target: Target) => ({
      document: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_documents WHERE id=$1', [target.identity.documentId])).rows,
      lineage: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_collaboration_lineages WHERE id=$1', [target.identity.lineageId])).rows,
      state: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_yjs_states WHERE document_id=$1', [target.identity.documentId])).rows,
      metadata: (await admin.query('SELECT *,xmin::text AS original_xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [workspaceId, target.identity.path])).rows,
    });
    // This frozen real workspace observation is only data for explicitly labelled
    // kernel counterfixtures. It is never presented as an active principal cap.
    const actualWorkspace = await capture(await request(), { permission: 'canRead', workspaceId }, principal =>
      transaction(db => principalPhase(db, principal, async access => access.workspace)));
    const kernelRead = (target: Target, workspace: WorkspaceContext = actualWorkspace) => transaction(db => readById(db, { workspace, documentId: target.identity.documentId }));
    const genuineRead = async (target: Target, userId = 'member', cookie = false) => capture(await request(userId, cookie),
      { permission: 'canRead', workspaceId }, principal => transaction(db => principalPhase(db, principal,
        access => readById(db, { workspace: access.workspace, documentId: target.identity.documentId }))));
    const noMutation = async (target: Target, operation: () => Promise<unknown>) => {
      const before = await stored(target); await operation(); assert.deepEqual(await stored(target), before);
    };
    const headerSql = (sql: string) => sql.includes('FULL JOIN') && sql.includes('collaboration_yjs_states');
    const payloadSql = (sql: string) => sql.includes('s.yjs_state,s.state_vector') && sql.includes('NULL::text AS canonical_hash');

    await check('genuine cookie and Bearer principal reads native-only Plain/XML/Blocks including empty documents', async () => {
      for (const cookie of [false, true]) for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) for (const empty of [false, true]) {
        const target = await seed(`${representation}-${empty}-${cookie}`, representation, { empty });
        await noMutation(target, async () => {
          const observed = await genuineRead(target, 'member', cookie);
          assert.deepEqual(observed.identity, target.identity); assert.equal(observed.native.source, 'persisted_yjs');
          assert.equal(observed.native.observed.stateProof, target.proof); assert.equal(observed.native.observed.stateVector, target.vector.toString('base64'));
          assert.equal(observed.native.observed.durable, true); assert.equal(observed.native.durable.documentSequence, target.sequence);
          assert.equal(observed.native.observed.content.kind, representation === 'plain_text' ? 'plain_text' : 'rich_text');
          assert.deepEqual(observed.metadata, { title: null, revision: null }); assert(Object.isFrozen(observed)); assert(Object.isFrozen(observed.native.observed));
        });
        assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_file_projections WHERE document_id=$1', [target.identity.documentId])).rows[0].count, 0);
        await assert.rejects(readFile(path.join(actualWorkspace.rootPath, target.identity.path)), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
      }
    });
    await check('shared metadata distinguishes missing row from present null and binds actual revision', async () => {
      const target = await seed('shared-title');
      for (const title of [null, 'Shared native title 😀'] as const) {
        await admin.query(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,$3,100,1400)
          ON CONFLICT(workspace_id,path) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at`, [workspaceId, target.identity.path, title]);
        await noMutation(target, async () => assert.deepEqual((await genuineRead(target)).metadata, { title, revision: 1400 }));
      }
    });
    await check('legal rich native content with unstable Markdown export is readable without serialization', async () => {
      const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| value |', 'tiptap_blocks');
      try {
        const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
        for (const row of tree.records.values()) if (['tableCell', 'tableHeader'].includes((row.get('shape') as { type: string }).type))
          (row.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]);
        assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
        const target = await seed('nonexportable', 'tiptap_blocks', { doc });
        await noMutation(target, async () => { const value = await genuineRead(target); assert.equal(value.native.observed.content.kind, 'rich_text'); assert.equal(value.native.observed.stateProof, target.proof); });
      } finally { doc.destroy(); }
    });
    await check('registry identity follows a coherent bin rename and never adopts D2 at its old path', async () => {
      const target = await seed('renamed'), originalPath = target.identity.path, newPath = `renamed-${crypto.randomUUID()}.bin`;
      await admin.query('UPDATE collaboration_documents SET path=$1 WHERE id=$2', [newPath, target.identity.documentId]);
      await admin.query('UPDATE file_collaboration_lineages SET path=$1 WHERE id=$2', [newPath, target.identity.lineageId]);
      await admin.query('UPDATE collaboration_yjs_states SET path=$1 WHERE document_id=$2', [newPath, target.identity.documentId]);
      const d2 = await seed('replacement', 'plain_text', { filePath: originalPath });
      const before = await stored(d2), value = await genuineRead(target);
      assert.equal(value.identity.documentId, target.identity.documentId); assert.equal(value.identity.path, newPath); assert.equal(value.native.observed.stateProof, target.proof);
      assert.notEqual(value.identity.documentId, d2.identity.documentId); assert.deepEqual(await stored(d2), before);
    });
    await check('archived original ID cannot resolve an active D2 at the reused path', async () => {
      const original = await seed('deleted'), oldPath = original.identity.path;
      await admin.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [original.identity.documentId]);
      await admin.query("UPDATE file_collaboration_lineages SET status='archived',archived_at=200 WHERE id=$1", [original.identity.lineageId]);
      await admin.query("UPDATE collaboration_yjs_states SET status='archived' WHERE document_id=$1", [original.identity.documentId]);
      const d2 = await seed('after-delete', 'plain_text', { filePath: oldPath });
      await noMutation(d2, () => assert.rejects(kernelRead(original), expected('DOCUMENT_NOT_FOUND', 404)));
      assert.equal((await genuineRead(d2)).identity.documentId, d2.identity.documentId);
    });
    await check('missing Registry, lost initialized state, orphan active state and nonnative provider remain distinct', async () => {
      await assert.rejects(transaction(db => readById(db, { workspace: actualWorkspace, documentId: `absent-${crypto.randomUUID()}` })), expected('DOCUMENT_NOT_FOUND', 404));
      for (const variant of ['lost', 'orphan', 'provider', 'archived-with-active-state'] as const) {
        const target = await seed(variant);
        if (variant === 'lost') await admin.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [target.identity.documentId]);
        if (variant === 'orphan') await admin.query('DELETE FROM collaboration_documents WHERE id=$1', [target.identity.documentId]);
        if (variant === 'provider') await admin.query("UPDATE collaboration_documents SET provider='excalidraw' WHERE id=$1", [target.identity.documentId]);
        if (variant === 'archived-with-active-state') await admin.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [target.identity.documentId]);
        const wanted = variant === 'lost' ? 'DOCUMENT_STATE_MISSING' : variant === 'provider' ? 'DOCUMENT_FORMAT_UNAVAILABLE' : 'DOCUMENT_STATE_INVALID';
        await noMutation(target, () => assert.rejects(kernelRead(target), expected(wanted, variant === 'provider' ? 422 : 409)));
      }
    });
    await check('mechanical D L S scope conflicts never become ID or path substitutions', async () => {
      const variants = [
        ['D.workspace', 'UPDATE collaboration_documents SET workspace_id=$2 WHERE id=$1', 'foreign-workspace'],
        ['D.type', 'UPDATE collaboration_documents SET workspace_type=$2 WHERE id=$1', 'personal'],
        ['D.org', 'UPDATE collaboration_documents SET organization_id=$2 WHERE id=$1', 'foreign-org'],
        ['D.customer', 'UPDATE collaboration_documents SET customer_id=$2 WHERE id=$1', 'foreign-customer'],
        ['D.project', 'UPDATE collaboration_documents SET project_id=$2 WHERE id=$1', 'foreign-project'],
        ['L.workspace', 'UPDATE file_collaboration_lineages SET workspace_id=$2 WHERE id=$1', 'foreign-workspace'],
        ['L.type', 'UPDATE file_collaboration_lineages SET workspace_type=$2 WHERE id=$1', 'personal'],
        ['L.org', 'UPDATE file_collaboration_lineages SET organization_id=$2 WHERE id=$1', 'foreign-org'],
        ['L.customer', 'UPDATE file_collaboration_lineages SET customer_id=$2 WHERE id=$1', 'foreign-customer'],
        ['L.project', 'UPDATE file_collaboration_lineages SET project_id=$2 WHERE id=$1', 'foreign-project'],
        ['L.path', 'UPDATE file_collaboration_lineages SET path=$2 WHERE id=$1', 'foreign.md'],
        ['S.workspace', 'UPDATE collaboration_yjs_states SET workspace_id=$2 WHERE document_id=$1', 'foreign-workspace'],
        ['S.org', 'UPDATE collaboration_yjs_states SET organization_id=$2 WHERE document_id=$1', 'foreign-org'],
        ['S.path', 'UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', 'foreign.md'],
      ] as const;
      for (const [name, sql, value] of variants) {
        const target = await seed(name), id = name.startsWith('L.') ? target.identity.lineageId : target.identity.documentId;
        await admin.query(sql, [id, value]); await noMutation(target, () => assert.rejects(kernelRead(target), expected('DOCUMENT_SCOPE_CHANGED', 409)));
      }
      const target = await seed('missing-lineage');
      await admin.query('UPDATE collaboration_documents SET lineage_id=NULL WHERE id=$1', [target.identity.documentId]);
      await noMutation(target, () => assert.rejects(kernelRead(target), expected('DOCUMENT_SCOPE_CHANGED', 409)));
    });
    await check('legacy nullable customer and project facts stay null while actual nonnull scope is checked', async () => {
      const target = await seed('legacy-null-scopes');
      await transaction(async (db, client) => {
        await client.query("INSERT INTO canvas_customers(id,organization_id,name,slug,status,created_at,updated_at) VALUES('native-read-customer','principal-org','Owned','native-read-customer','active',100,100)");
        await client.query("INSERT INTO canvas_projects(id,organization_id,customer_id,name,slug,status,created_at,updated_at) VALUES('native-read-project','principal-org','native-read-customer','Owned','native-read-project','active',100,100)");
        await client.query("UPDATE canvas_workspaces SET customer_id='native-read-customer',project_id='native-read-project' WHERE id=$1", [workspaceId]);
        const workspace = { ...actualWorkspace, customerId: 'native-read-customer', projectId: 'native-read-project' };
        const first = await readById(db, { workspace, documentId: target.identity.documentId }); assert.equal(first.identity.documentId, target.identity.documentId);
        assert.equal((await client.query('SELECT customer_id,project_id FROM collaboration_documents WHERE id=$1', [target.identity.documentId])).rows[0].customer_id, null);
        await client.query("UPDATE collaboration_documents SET customer_id='native-read-customer',project_id='native-read-project' WHERE id=$1", [target.identity.documentId]);
        await client.query("UPDATE file_collaboration_lineages SET customer_id='native-read-customer',project_id='native-read-project' WHERE id=$1", [target.identity.lineageId]);
        assert.equal((await readById(db, { workspace, documentId: target.identity.documentId })).identity.documentId, target.identity.documentId);
        // The counterfixture itself must not change the next case's workspace.
        await client.query('ROLLBACK; BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); await client.query('SELECT pg_current_xact_id()');
      });
      assert.deepEqual((await admin.query('SELECT customer_id,project_id FROM canvas_workspaces WHERE id=$1', [workspaceId])).rows[0], { customer_id: null, project_id: null });
    });
    await check('raw bigint flags and clocks are rejected before the state payload is fetched', async () => {
      for (const assignment of ['has_bom=2', 'degraded=2', 'projection_error_permanent=2', 'document_sequence=-1', 'checkpoint_sequence=8', 'persisted_at=-1', 'lifecycle_generation=0', 'schema_version=2']) {
        const target = await seed('raw-invalid'); await admin.query(`UPDATE collaboration_yjs_states SET ${assignment} WHERE document_id=$1`, [target.identity.documentId]);
        let payloadReads = 0;
        await noMutation(target, () => assert.rejects(transaction((db, client) => readById({ ...db, all: async (sql, values) => {
          if (payloadSql(sql)) payloadReads++;
          return (await client.query(sql, values)).rows;
        } }, { workspace: actualWorkspace, documentId: target.identity.documentId })), expected('DOCUMENT_STATE_INVALID', 409)));
        assert.equal(payloadReads, 0);
      }
    });
    await check('quarantine is distinct from transient persistence degradation', async () => {
      for (const permanent of [false, true]) {
        const target = await seed('quarantine');
        await admin.query(`UPDATE collaboration_yjs_states SET degraded=1,projection_error_code=$2,projection_error_sequence=7,
          projection_error_generation=1,projection_error_permanent=$3 WHERE document_id=$1`, [target.identity.documentId,
          permanent ? 'COLLABORATION_CHECKPOINT_SCHEMA_INVALID' : 'COLLABORATION_YJS_PERSISTENCE_FAILED', permanent ? 1 : 0]);
        await noMutation(target, async () => {
          if (permanent) await assert.rejects(kernelRead(target), expected('DOCUMENT_QUARANTINED', 409));
          else assert.equal((await kernelRead(target)).native.observed.stateProof, target.proof);
        });
      }
      const target = await seed('legacy-degraded'); await admin.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [target.identity.documentId]);
      await assert.rejects(kernelRead(target), expected('DOCUMENT_QUARANTINED', 409));
    });
    await check('malformed native binary trailing update vector and raw rich schema never fall back to Markdown', async () => {
      for (const variant of ['update', 'trailing', 'vector', 'xml-schema'] as const) {
        const doc = variant === 'xml-schema' ? createRichMarkdownYDoc('Raw native', 'tiptap_xml') : undefined;
        if (doc) (doc.getXmlFragment('body').toArray()[0] as InstanceType<typeof Y.XmlElement>).setAttribute('future-attr', 'untrusted');
        const target = await seed('malformed', doc ? 'tiptap_xml' : 'plain_text', { doc }); doc?.destroy();
        if (variant === 'update') await admin.query("UPDATE collaboration_yjs_states SET yjs_state=decode('ff','hex') WHERE document_id=$1", [target.identity.documentId]);
        if (variant === 'trailing') await admin.query("UPDATE collaboration_yjs_states SET yjs_state=yjs_state||decode('00','hex') WHERE document_id=$1", [target.identity.documentId]);
        if (variant === 'vector') await admin.query("UPDATE collaboration_yjs_states SET state_vector=decode('00','hex') WHERE document_id=$1", [target.identity.documentId]);
        await noMutation(target, () => assert.rejects(kernelRead(target), expected('DOCUMENT_STATE_INVALID', 409)));
      }
    });
    await check('actual oversized bytea is gated before output allocation', async () => {
      for (const [column, bytes] of [['yjs_state', 64 * 1024 * 1024 + 1], ['state_vector', 1024 * 1024 + 1]] as const) {
        const target = await seed('oversized'); await admin.query(`UPDATE collaboration_yjs_states SET ${column}=decode(repeat('00',$2),'hex') WHERE document_id=$1`, [target.identity.documentId, bytes]);
        let payloadReads = 0;
        await assert.rejects(transaction((db, client) => readById({ ...db, all: async (sql, values) => {
          if (payloadSql(sql)) payloadReads++;
          return (await client.query(sql, values)).rows;
        } }, { workspace: actualWorkspace, documentId: target.identity.documentId })), expected('DOCUMENT_TOO_LARGE', 413));
        assert.equal(payloadReads, 0);
      }
    });
    await check('large unused stored cause and checkpoint hashes are excluded from actual reader rows and output', async () => {
      const target = await seed('unused-text'), bytes = 1024 * 1024;
      await admin.query(`UPDATE collaboration_yjs_states SET projection_error_cause=repeat('C',$2),
        canonical_hash=repeat('H',$2),serialized_hash=repeat('S',$2) WHERE document_id=$1`, [target.identity.documentId, bytes]);
      const storedProof = async () => (await admin.query(`SELECT octet_length(projection_error_cause) AS cause_bytes,
        octet_length(canonical_hash) AS canonical_bytes,octet_length(serialized_hash) AS serialized_bytes,
        encode(sha256(convert_to(projection_error_cause,'UTF8')),'hex') AS cause_hash,
        encode(sha256(convert_to(canonical_hash,'UTF8')),'hex') AS canonical_hash,
        encode(sha256(convert_to(serialized_hash,'UTF8')),'hex') AS serialized_hash,xmin::text AS original_xmin
        FROM collaboration_yjs_states WHERE document_id=$1`, [target.identity.documentId])).rows[0];
      const before = await storedProof();
      assert.equal(before.cause_bytes, bytes); assert.equal(before.canonical_bytes, bytes); assert.equal(before.serialized_bytes, bytes);
      let actualPayloadRows = 0;
      const observed = await capture(await request('member', true), { permission: 'canRead', workspaceId }, principal => transaction((db, client) => principalPhase(db, principal,
        access => readById({ ...db, all: async (sql, values) => {
          const rows = (await client.query(sql, values)).rows;
          if (payloadSql(sql)) {
            actualPayloadRows++; assert.equal(rows.length, 1);
            assert.equal(Object.hasOwn(rows[0], 'projection_error_cause'), false);
            assert.equal(rows[0].canonical_hash, null); assert.equal(rows[0].serialized_hash, null);
            for (const value of Object.values(rows[0])) if (typeof value === 'string') assert(Buffer.byteLength(value) < bytes);
          }
          return rows;
        } }, { workspace: access.workspace, documentId: target.identity.documentId }))));
      assert.equal(actualPayloadRows, 1); assert.equal(observed.native.observed.stateProof, target.proof);
      const json = JSON.stringify(observed);
      assert.equal(/"(?:projection_error_cause|canonical_hash|serialized_hash|canonicalHash|serializedHash)"\s*:/u.test(json), false);
      for (const marker of ['C', 'H', 'S']) assert.equal(json.includes(marker.repeat(64)), false);
      assert.deepEqual(await storedProof(), before, 'Only the actual SELECT projection omits unused data; original SQL rows stay intact.');
    });
    await check('oversized required title and phase return only bounded header fields and fail before raw body', async () => {
      for (const variant of ['title', 'phase'] as const) {
        const target = await seed('required-text'), bytes = variant === 'title' ? 16385 : 1025;
        if (variant === 'title') await admin.query(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at)
          VALUES($1,$2,repeat('T',$3),100,200)`, [workspaceId, target.identity.path, bytes]);
        else await admin.query(`UPDATE collaboration_yjs_states SET projection_error_code='COLLABORATION_YJS_PERSISTENCE_FAILED',
          projection_error_sequence=7,projection_error_generation=1,projection_error_permanent=0,projection_error_phase=repeat('P',$2)
          WHERE document_id=$1`, [target.identity.documentId, bytes]);
        const storedProof = async () => (await admin.query(variant === 'title'
          ? `SELECT octet_length(title) AS bytes,encode(sha256(convert_to(title,'UTF8')),'hex') AS hash,xmin::text AS original_xmin
              FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2`
          : `SELECT octet_length(projection_error_phase) AS bytes,encode(sha256(convert_to(projection_error_phase,'UTF8')),'hex') AS hash,xmin::text AS original_xmin
              FROM collaboration_yjs_states WHERE document_id=$1`,
        variant === 'title' ? [workspaceId, target.identity.path] : [target.identity.documentId])).rows[0];
        const before = await storedProof(); assert.equal(before.bytes, bytes);
        let actualHeaders = 0, payloadReads = 0;
        await assert.rejects(capture(await request('member', true), { permission: 'canRead', workspaceId }, principal => transaction((db, client) => principalPhase(db, principal,
          access => readById({ ...db, all: async (sql, values) => {
            if (payloadSql(sql)) payloadReads++;
            const rows = (await client.query(sql, values)).rows;
            if (headerSql(sql)) {
              actualHeaders++; assert.equal(rows.length, 1); assert.equal(rows[0].oversized_text, true);
              assert.equal(rows[0][variant === 'title' ? 'metadata_title' : 'state_projection_error_phase'], null);
              for (const value of Object.values(rows[0])) if (typeof value === 'string') assert(Buffer.byteLength(value) < bytes);
            }
            return rows;
          } }, { workspace: access.workspace, documentId: target.identity.documentId })))), expected('DOCUMENT_TOO_LARGE', 413));
        assert.equal(actualHeaders, 1); assert.equal(payloadReads, 0); assert.deepEqual(await storedProof(), before);
      }
    });
    await check('ID read returns the coherent current lifecycle generation without an implicit old-generation pin', async () => {
      const target = await seed('current-generation');
      await admin.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [target.identity.documentId]);
      await noMutation(target, async () => {
        const observed = await genuineRead(target); assert.equal(observed.identity.lifecycleGeneration, 2);
        assert.equal(observed.native.lifecycleGeneration, 2); assert.equal(observed.native.observed.stateProof, target.proof);
      });
    });
    await check('fixed handoff combines actual same-B persisted state with current in-memory native content', async () => {
      const target = await seed('handoff-current'); assert.equal(isLiveCollaborationDocumentReaderAvailable(), false);
      const uninstall = installCollaborationDocumentReader(async (id, selectedWorkspace, read, load) => {
        assert.equal(id, target.identity.documentId); assert.equal(selectedWorkspace, workspaceId); assert(load);
        const state = await load(id); assert(state);
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, state.yjsState); doc.getText('content').insert(3, ' live'); return read(doc, state);
        } finally { doc.destroy(); }
      });
      try {
        await noMutation(target, async () => {
          const value = await genuineRead(target); assert.equal(value.native.source, 'live_yjs');
          assert.equal(value.native.observed.durable, false); assert.notEqual(value.native.observed.stateProof, target.proof);
          assert.equal(value.native.durable.stateProof, target.proof); assert.equal(value.native.durable.documentSequence, 7);
          assert.deepEqual(value.native.observed.content, { kind: 'plain_text', text: 'ABC live' });
        });
      } finally { uninstall(); }
      assert.equal(isLiveCollaborationDocumentReaderAvailable(), false);
    });
    await check('handoff cannot substitute state repeat a load or callback or replace the callback result', async () => {
      // Controlled room-IO counterfixtures exercise the kernel boundary. They
      // do not fabricate a principal or claim actual Hocuspocus room ownership.
      for (const variant of ['state-copy', 'duplicate-load', 'duplicate-callback', 'result-copy', 'missing-load'] as const) {
        const target = await seed('handoff-rejected'); assert.equal(isLiveCollaborationDocumentReaderAvailable(), false);
        const uninstall = installCollaborationDocumentReader(async (id, _selectedWorkspace, read, load) => {
          assert(load); const doc = new Y.Doc();
          try {
            if (variant === 'missing-load') { Y.applyUpdate(doc, target.update); return read(doc); }
            const state = await load(id); assert(state); Y.applyUpdate(doc, state.yjsState);
            if (variant === 'duplicate-load') await assert.rejects(load(id), expected('DOCUMENT_SCOPE_CHANGED', 409));
            if (variant === 'state-copy') return read(doc, { ...state });
            const value = read(doc, state);
            if (variant === 'duplicate-callback') assert.throws(() => read(doc, state), expected('DOCUMENT_SCOPE_CHANGED', 409));
            return variant === 'result-copy' ? structuredClone(value) : value;
          } finally { doc.destroy(); }
        });
        try { await noMutation(target, () => assert.rejects(kernelRead(target), expected('DOCUMENT_SCOPE_CHANGED', 409))); }
        finally { uninstall(); }
      }
    });
    await check('caught same-B reentry and escaped load during completion still poison the active read', async () => {
      for (const variant of ['reentry', 'late-load'] as const) {
        const target = await seed('lifetime'); let fired = false, headers = 0;
        let lateLoad: ((id: string) => Promise<unknown>) | undefined;
        assert.equal(isLiveCollaborationDocumentReaderAvailable(), false);
        const uninstall = installCollaborationDocumentReader(async (id, _workspaceId, read, load) => {
          assert(load); lateLoad = load; const state = await load(id); assert(state);
          const doc = new Y.Doc();
          try { Y.applyUpdate(doc, state.yjsState); return read(doc, state); }
          finally { doc.destroy(); }
        });
        try {
          await noMutation(target, () => assert.rejects(transaction((db, client) => {
            const wrapped: SqlConnection = { ...db, all: async (sql, values) => {
              const rows = (await client.query(sql, values)).rows;
              if (headerSql(sql)) {
                headers++;
                if (!fired && variant === 'reentry' && headers === 1) {
                  fired = true;
                  await assert.rejects(readById(wrapped, { workspace: actualWorkspace, documentId: target.identity.documentId }), expected('DOCUMENT_SCOPE_CHANGED', 409));
                }
                if (!fired && variant === 'late-load' && headers === 3) {
                  assert(lateLoad); fired = true;
                  await assert.rejects(lateLoad(target.identity.documentId), expected('DOCUMENT_SCOPE_CHANGED', 409));
                }
              }
              return rows;
            } };
            return readById(wrapped, { workspace: actualWorkspace, documentId: target.identity.documentId });
          }), expected('DOCUMENT_SCOPE_CHANGED', 409)));
          assert.equal(fired, true);
        } finally { uninstall(); }
      }
    });
    await check('input workspace and ID are captured before the first awaited query', async () => {
      const original = await seed('capture-original'), replacement = await seed('capture-replacement');
      await transaction(async db => {
        const mutable = { workspace: { ...actualWorkspace, permissions: { ...actualWorkspace.permissions } }, documentId: original.identity.documentId };
        const pending = readById(db, mutable); mutable.documentId = replacement.identity.documentId;
        mutable.workspace.workspaceId = 'foreign'; mutable.workspace.rootRelativePath = 'foreign'; mutable.workspace.permissions.canRead = false;
        const observed = await pending; assert.equal(observed.identity.documentId, original.identity.documentId);
      });
    });
    await check('outside transaction unassigned XID readonly and repeatable-read cannot borrow the kernel', async () => {
      const target = await seed('wrong-transaction');
      for (const begin of ['BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE'])
        await assert.rejects(transaction(db => readById(db, { workspace: actualWorkspace, documentId: target.identity.documentId }), begin, false), expected('DOCUMENT_SCOPE_CHANGED', 409));
      await assert.rejects(transaction(db => readById(db, { workspace: actualWorkspace, documentId: target.identity.documentId }), undefined, false), expected('DOCUMENT_SCOPE_CHANGED', 409));
      const client = await ownClient();
      try { await assert.rejects(readById(connection(client), { workspace: actualWorkspace, documentId: target.identity.documentId }), expected('DOCUMENT_SCOPE_CHANGED', 409)); }
      finally { await endClient(client); }
    });
    await check('source workspace and metadata changes after actual payload ACK cannot escape the final binding', async () => {
      for (const variant of ['generation', 'metadata', 'workspace-root', 'legacy-null'] as const) {
        const target = await seed('late-binding'); let fired = false, headerReads = 0;
        await assert.rejects(transaction((db, client) => readById({ ...db, all: async (sql, values) => {
          const rows = (await client.query(sql, values)).rows;
          if (headerSql(sql)) headerReads++;
          if (!fired && payloadSql(sql)) {
            assert.equal(headerReads, 2); fired = true;
            if (variant === 'generation') await client.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [target.identity.documentId]);
            if (variant === 'metadata') await client.query('INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,NULL,100,200)', [workspaceId, target.identity.path]);
            if (variant === 'workspace-root') await client.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/changed' WHERE id=$1", [workspaceId]);
            if (variant === 'legacy-null') await client.query("UPDATE file_collaboration_lineages SET customer_id='new-customer' WHERE id=$1", [target.identity.lineageId]);
          }
          return rows;
        } }, { workspace: actualWorkspace, documentId: target.identity.documentId })), expected('DOCUMENT_SCOPE_CHANGED', 409));
        assert.equal(fired, true);
        if (variant === 'generation' || variant === 'metadata') assert.equal(headerReads, 3);
        assert.equal((await kernelRead(target)).identity.documentId, target.identity.documentId);
      }
    });
    await check('same wrapper cannot hijack backend transaction schema name or schema OID after header ACK', async () => {
      for (const variant of ['backend', 'transaction', 'searchpath', 'schema-oid'] as const) {
        const target = await seed('realm-drift'); let fired = false;
        await assert.rejects(transaction(async (_db, client) => {
          const peer = await ownClient(); await peer.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); await peer.query('SELECT pg_current_xact_id()');
          let selected = client;
          const wrapped: SqlConnection = {
            get: async (sql, values) => (await selected.query(sql, values)).rows[0],
            all: async (sql, values) => {
              const rows = (await selected.query(sql, values)).rows;
              if (!fired && headerSql(sql)) {
                fired = true;
                if (variant === 'backend') selected = peer;
                if (variant === 'transaction') { await client.query('COMMIT; BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); await client.query('SELECT pg_current_xact_id()'); }
                if (variant === 'searchpath') await client.query('SET LOCAL search_path=pg_catalog');
                if (variant === 'schema-oid') {
                  const renamed = `native_read_old_${crypto.randomUUID().replaceAll('-', '')}`;
                  await client.query(`ALTER SCHEMA "${schema}" RENAME TO "${renamed}"`); await client.query(`CREATE SCHEMA "${schema}"`);
                }
              }
              return rows;
            },
            run: async (sql, values) => ({ changes: (await selected.query(sql, values)).rowCount ?? 0 }), close: () => assert.fail('Kernel may not close B.'),
          };
          try { await readById(wrapped, { workspace: actualWorkspace, documentId: target.identity.documentId }); }
          finally {
            await peer.query('ROLLBACK'); await endClient(peer);
            // Even a broken product guard must not commit this diagnostic DDL.
            if (variant === 'schema-oid' && fired) {
              await client.query('ROLLBACK; BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
              await client.query('SELECT pg_current_xact_id()');
            }
          }
        }), expected('DOCUMENT_SCOPE_CHANGED', 409));
        assert.equal(fired, true); assert.equal((await kernelRead(target)).identity.documentId, target.identity.documentId);
      }
    });
    await check('actual exclusive lifecycle fence denies and successful shared read holds through caller completion', async () => {
      const target = await seed('fenced'), peer = await ownClient(), key = collaborationAdmissionLockKey(workspaceId);
      try {
        assert.equal((await peer.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key])).rows[0].locked, true);
        await assert.rejects(kernelRead(target), expected('DOCUMENT_BUSY', 409));
        assert.equal((await peer.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [key])).rows[0].unlocked, true);
        await transaction(async db => {
          await readById(db, { workspace: actualWorkspace, documentId: target.identity.documentId });
          assert.equal((await peer.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key])).rows[0].locked, false);
        });
        assert.equal((await peer.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key])).rows[0].locked, true);
        assert.equal((await peer.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [key])).rows[0].unlocked, true);
        await assert.rejects(transaction(async db => { await db.run('SELECT pg_advisory_xact_lock($1::bigint)', [key]); return readById(db, { workspace: actualWorkspace, documentId: target.identity.documentId }); }), expected('DOCUMENT_SCOPE_CHANGED', 409));
      } finally { await endClient(peer); }
    });
    await check('actual pending admission remains a named Busy instead of native fallback', async () => {
      const target = await seed('pending-admission'), admission = createCollaborationAdmissionService({ openConnection: async () => {
        const client = await ownClient(); return { ...connection(client), close: () => endClient(client) };
      } });
      const { lineageId: _lineage, ...identity } = target.identity, payload = JSON.stringify({ targetPath: 'renamed.md' });
      await admission.reserve({ requestId: crypto.randomUUID(), actorId: 'owned-fixture', action: 'rename', actionPayloadText: payload,
        actionDigest: collaborationAdmissionActionDigest('rename', payload), scopes: [{ workspaceId, organizationId: 'principal-org', path: identity.path, kind: 'exact' }],
        expectedDocuments: [{ ...identity, status: 'active' }] });
      await noMutation(target, () => assert.rejects(kernelRead(target), expected('DOCUMENT_BUSY', 409)));
    });
    await check('reader uses actual same B and no hidden pool checkout within genuine principal phase', async () => {
      const target = await seed('one-B');
      await capture(await request('owner', true), { permission: 'canRead', workspaceId }, principal => transaction((db, client) => principalPhase(db, principal, async access => {
        const before = (await client.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
        const connect = Reflect.get(runtime, 'connect') as (...args: unknown[]) => unknown; let checkouts = 0;
        const counted = function (this: unknown, ...args: unknown[]) { checkouts++; return Reflect.apply(connect, this, args); };
        let value: Awaited<ReturnType<typeof readById>>;
        Reflect.set(runtime, 'connect', counted);
        try { value = await readById(db, { workspace: access.workspace, documentId: target.identity.documentId }); }
        finally { Reflect.set(runtime, 'connect', connect); }
        assert.equal(checkouts, 0); assert.equal(value.identity.documentId, target.identity.documentId);
        assert.deepEqual((await client.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0], before);
      })));
    });
    await check('genuine principal final rejects session expiry after reader return and outer rollback preserves session', async () => {
      const target = await seed('auth-final'); let readerReturned = false;
      await assert.rejects(capture(await request(), { permission: 'canRead', workspaceId }, principal => transaction((db, client) => principalPhase(db, principal, async access => {
        await readById(db, { workspace: access.workspace, documentId: target.identity.documentId }); readerReturned = true;
        await client.query("UPDATE session SET expires_at=1 WHERE id='session-owner'");
      }))), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'PRINCIPAL_AUTH_REVOKED');
      assert.equal(readerReturned, true); assert.equal((await genuineRead(target, 'owner')).identity.documentId, target.identity.documentId);
    });
    assert.equal(fetches, 0); assert.equal(cases, 26);
    console.log(`Native document by-ID reader: ${cases} actual PG18 kernel/genuine-principal families passed; no API/transport activation claim.`);
  } finally {
    globalThis.fetch = originalFetch;
    try { if (pool) await pool.end(); } finally {
      try { for (const client of clients) await client.end(); } finally {
        try { if (created) {
          await control.query(`DROP SCHEMA "${schema}" CASCADE`);
          assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true);
        } } finally {
          await control.end(); await rm(dataRoot, { recursive: true, force: true });
          for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
          Object.assign(process.env, environment);
        }
      }
    }
  }
}
main().catch(error => {
  console.error('Owned native by-ID reader fixture failed:', { stage, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null,
    constraint: error && typeof error === 'object' ? Reflect.get(error, 'constraint') ?? null : null });
  process.exitCode = 1;
});
