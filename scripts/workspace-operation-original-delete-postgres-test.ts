import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs, { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceOperationBatchPlan } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { runPgliteFixture as runSqlFixture } from './helpers/pglite-pool-harness';

// Actual PG18/Team license/Store claim/Owner, real filesystem and full DDL.
// Public rows are explicit fixtures, not a Public-create authorization claim.
// The pure planner consumes our exact selected-target snapshot; this does not
// prove general producer/backlink/Restore/UI or host-crash behavior.
const sourcePath = path.resolve('scripts/workspace-operation-original-delete-postgres-test.ts');
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
const sourceHash = async () => crypto.createHash('sha256').update(await readFile(sourcePath)).digest('hex');
type Row = Record<string, unknown>;
const rejected = (...codes: string[]) => (error: unknown): boolean => {
  if (!(error instanceof Error) || error instanceof assert.AssertionError) return false;
  return codes.includes(String(Reflect.get(error, 'code')));
};
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const absent = async (filePath: string) => {
  try { await stat(filePath); return false; }
  catch (error) { if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return true; throw error; }
};

async function main(): Promise<void> {
  const pinned = await sourceHash();
  console.log('Owned job fixture frozen source:', pinned);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const nonce = crypto.randomUUID(), schema = `owned_job_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^owned_job_[a-f0-9]{32}$/u);
  const organizationId = `job-org-${crypto.randomUUID()}`, workspaceId = `job-ws-${crypto.randomUUID()}`;
  const agentId = `job-agent-${crypto.randomUUID()}`, piSessionId = `job-pi-${crypto.randomUUID()}`;
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-owned-job-principal-'))), dataIdentity = await stat(dataRoot);
  assert.equal(dataIdentity.uid, process.getuid!()); assert.equal(dataIdentity.mode & 0o077, 0);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>();
  const checkouts = new Set<SqlConnection>();
  const failures: unknown[] = [];
  let connected = false, created = false, schemaOid = 0, schemaRemoved = false, dataRemoved = false;
  let pool: { end: () => Promise<void> } | undefined, fetches = 0, passed = 0, stage = 'prepare owned schema';
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=owned-job-principal-fixture` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  try {
    await control.connect(); connected = true;
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${nonce}'`);
    schemaOid = Number((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].oid);
    // These values are installed before dynamic DB/Auth imports, never applied to
    // an app process. The actual production verifier trusts our ephemeral key.
    Object.assign(process.env, { DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`, CANVAS_DATABASE_PROVIDER: 'postgres',
      DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost',
      BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
      CANVAS_ORGANIZATION_ID: organizationId, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'NEXT_PHASE', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'owned-job-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true, organizationId,
      capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true }, seatLimit: 2, quotas: { users: 2 },
      entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('Network is forbidden in this owned fixture.'); };
    const admin = await ownClient();
    const own = async () => {
      const row = (await admin.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path,
        n.oid,obj_description(n.oid,'pg_namespace') AS nonce,n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner
        FROM pg_namespace n WHERE n.nspname=$1`, [schema])).rows[0];
      assert(row); assert.equal(row.schema, schema); assert.equal(Number(row.oid), schemaOid); assert.equal(row.nonce, nonce); assert.equal(row.owner, true);
      assert.deepEqual(row.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']);
    };
    stage = 'original full global migrations';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      await own(); const result = await admin.query(sql, values); await own(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const database = await import('../app/lib/db');
    const runtime = database.getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!, process.env.CANVAS_INSTANCE_ID!)).ok, true);
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 2);
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at) VALUES
      ('owner','Owner','owner@owned-job.test',1,'admin',0,100,100),('member','Member','member@owned-job.test',1,'user',0,100,100),
      ('inactive','Inactive','inactive@owned-job.test',1,'user',0,100,100)`);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES($1,'owner','team',1,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_delete_team_files,can_create_public_links,created_at,updated_at)
      VALUES($1,'owner','owner','active',1,1,0,100,100),($1,'member','member','active',1,1,0,100,100),($1,'inactive','member','disabled',0,0,0,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at) VALUES
      ('owner-seat',$1,'owner@owned-job.test','owner','owner','active',100,100,100,100),
      ('member-seat',$1,'member@owned-job.test','member','member','active',100,200,100,100),
      ('inactive-seat',$1,'inactive@owned-job.test','inactive','member','suspended',100,50,100,100)`, [organizationId]);
    await admin.query('INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES($1,100,100)', [organizationId]);
    const rootRelativePath = `organizations/${organizationId}/shared`;
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES($1,$2,'organization','Owned job',$3,'active',100,100)`, [workspaceId, organizationId, rootRelativePath]);
    await admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'Stored job agent','special','restricted','organization',$2,'["write_text_file"]',100,100)`, [agentId, organizationId]);
    await admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
      VALUES($1,$2,'member','active',1,100,100)`, [agentId, organizationId]);
    await admin.query(`INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,created_at,updated_at)
      VALUES('job-grant',$1,$2,'workspace',$3,1,100,100)`, [agentId, organizationId, workspaceId]);
    const seedPi = () => admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
      workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES($1,'member',$2,'fixture','fixture',$3,$4,'organization','Owned job',$5,100,100)`, [piSessionId, agentId, organizationId, workspaceId, rootRelativePath]);
    await seedPi();
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,100,100)',
      ['fixture-browser-session', sessionToken, Date.now() + 3600000]);
    const { auth } = await import('../app/lib/auth');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { executeWorkspaceOperationOriginalDelete: execute } = await import('../app/lib/files/workspace-operation-original-delete');
    const { createWorkspaceOperationBatchPlan, computeWorkspaceOperationBatchPlanId } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions } = await import('../app/lib/collaboration/markdown-state');
    const { inspectPersistedNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { inspectArchivedNativeSnapshot } = await import('../app/lib/collaboration/archived-native-snapshot');
    const { authoritativeCollaborationSnapshot } = await import('../app/lib/collaboration/checkpoint');
    const { serializeCanonicalText } = await import('../app/lib/collaboration/persistence');
    const { CollaborationBlockTree } = await import('../app/lib/collaboration/block-tree');
    const { getSchema } = await import('@tiptap/core');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const store = new WorkspaceOperationBatchStore();
    const currentWorkspace = async (userId = 'member'): Promise<WorkspaceContext> => {
      const raw = (await admin.query('SELECT id,email,role FROM "user" WHERE id=$1', [userId])).rows[0]; assert(raw);
      const connection = await database.openDb();
      try {
        const current = await readPostgresWorkspaceForActorOnConnection(connection, resolveWorkspaceActor(raw), workspaceId);
        assert(current); return current;
      } finally { await connection.close(); }
    };
    const workspace = await currentWorkspace(); await mkdir(workspace.rootPath, { recursive: true });
    const row = async (table: string, key: string, value: string): Promise<Row | undefined> => {
      assert(['collaboration_documents', 'file_collaboration_lineages', 'collaboration_yjs_states', 'collaboration_file_projections',
        'public_file_shares', 'workspace_trash_entries', 'workspace_file_operation_delete_intents',
        'workspace_file_operation_delete_trash_receipts', 'workspace_file_operation_delete_receipts'].includes(table));
      assert(['id', 'document_id', 'batch_id'].includes(key));
      return (await admin.query(`SELECT to_jsonb(r) AS row FROM "${schema}".${table} r WHERE ${key}=$1`, [value])).rows[0]?.row as Row | undefined;
    };
    type Target = { filePath: string; fullPath: string; bytes: Buffer; documentId: string | null; lineageId: string | null;
      state: PersistedCollaborationState | null; proof: string | null; content: unknown; shareId: string };
    type Job = { claimed: NonNullable<Awaited<ReturnType<typeof store.claim>>>; target: Target; plan: WorkspaceOperationBatchPlan };
    const seedShare = async (target: Omit<Target, 'shareId'>, historicalNull = false) => {
      const shareId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
      // Complete rows under actual full migrations. No fake request/principal or
      // public-create success is inferred from this private fixture seeding.
      await admin.query(`INSERT INTO public_file_shares(id,token,token_hash,token_preview,short_code,organization_id,customer_id,project_id,
        workspace_id,workspace_type,workspace_root_relative_path,workspace_path,document_id,lineage_id,lifecycle_generation,
        file_name,file_identity,target_revision_policy,last_known_revision,mime_type,size_bytes,status,created_by_user_id,
        created_by_agent_id,source_session_id,source,security_mode,reason,created_at,updated_at,expires_at,revoked_at,revoked_reason,
        password_enabled,password_hash,last_accessed_at,access_count,policy_revision)
        VALUES($1,$2,$3,'fixture',NULL,$4,NULL,NULL,$5,'organization',$6,$7,$8,$9,$10,$7,$11,'latest',NULL,
          'text/markdown',$12,'active','member',NULL,NULL,'ui','strict','private fixture seed',100,100,NULL,NULL,NULL,1,
          'private-fixture-password-hash',150,7,3)`,
      [shareId, token, sha(token), organizationId, workspaceId, workspace.rootRelativePath, target.filePath,
        historicalNull ? null : target.documentId, historicalNull ? null : target.lineageId,
        !historicalNull && target.documentId ? 1 : null,
        await absent(target.fullPath) ? 'historical-projection-absent' : filesystemFileVersion(await stat(target.fullPath)), target.bytes.byteLength]);
      return shareId;
    };
    const seedTarget = async (options: { representation?: PersistedCollaborationState['representation']; physical?: boolean;
      historicalNull?: boolean; filePath?: string; nonexportable?: boolean; byteProfile?: boolean;
      keepPhysical?: boolean; reuseShareId?: string } = {}): Promise<Target> => {
      const filePath = options.filePath ?? ` original-${crypto.randomUUID()}.md`, fullPath = path.join(workspace.rootPath, filePath);
      const canonical = options.nonexportable ? '| A | B |\n| --- | --- |\n| one | two |\n' : '# Original target\n\nA genuine paragraph.\n';
      let state: PersistedCollaborationState | null = null, documentId: string | null = null, lineageId: string | null = null;
      let proof: string | null = null, content: unknown = null;
      let serialized = canonical;
      if (options.representation) {
        documentId = `collab-doc-${crypto.randomUUID()}`; lineageId = `lineage-${crypto.randomUUID()}`;
        const doc = options.representation === 'plain_text' ? createPlainTextYDoc(canonical) : createRichMarkdownYDoc(canonical, options.representation);
        try {
          if (options.nonexportable) {
            assert.equal(options.representation, 'tiptap_blocks');
            const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions())); let cells = 0;
            for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
              (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]); cells++;
            }
            assert(cells > 0);
          }
          state = { documentId, workspaceId, organizationId, path: filePath, representation: options.representation,
            lifecycleGeneration: 1, schemaVersion: 1, yjsState: Buffer.from(Y.encodeStateAsUpdate(doc)), stateVector: Buffer.from(Y.encodeStateVector(doc)),
            documentSequence: 7, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
            newlineStyle: options.byteProfile ? 'crlf' : 'lf', hasBom: !!options.byteProfile, degraded: false, status: 'active' };
          const snapshot = inspectPersistedNativeCollaborationSnapshot(state, (_doc, native) => native);
          proof = snapshot.version.stateProof; content = snapshot.content;
          if (!options.nonexportable) serialized = serializeCanonicalText(authoritativeCollaborationSnapshot(state).canonicalContent, state);
          else assert.throws(() => authoritativeCollaborationSnapshot(state!), rejected('COLLABORATION_ROUNDTRIP_UNSTABLE', 'COLLABORATION_SERIALIZATION_FAILED'));
        } finally { doc.destroy(); }
        await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
          VALUES($1,$2,'organization',$3,$4,'active',100)`, [lineageId, workspaceId, organizationId, filePath]);
        await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
          state_version,yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,$3,'organization',$4,$5,'yjs',7,'initialized','active',100,100)`,
        [documentId, lineageId, workspaceId, organizationId, filePath]);
        await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,
          schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,
          newline_style,has_bom,degraded,status) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,7,100,0,NULL,NULL,NULL,$8,$9,0,'active')`,
        [documentId, workspaceId, organizationId, filePath, state!.representation, Buffer.from(state!.yjsState), Buffer.from(state!.stateVector),
          state!.newlineStyle, state!.hasBom ? 1 : 0]);
        await admin.query(`INSERT INTO collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,finalized,updated_at)
          VALUES($1,1,0,0,100)`, [documentId]);
      }
      const bytes = Buffer.from(serialized);
      if (options.keepPhysical) assert.deepEqual(await readFile(fullPath), bytes);
      else if (options.physical !== false) await writeFile(fullPath, bytes, { flag: 'wx', mode: 0o600 });
      else assert.equal(await absent(fullPath), true);
      const target = { filePath, fullPath, bytes, documentId, lineageId, state, proof, content };
      return { ...target, shareId: options.reuseShareId ?? await seedShare(target, options.historicalNull) };
    };
    const freshJob = async (target: Target, actorType: 'user' | 'agent' = 'user'): Promise<Job> => {
      const current = await currentWorkspace();
      const identity = await absent(target.fullPath) ? `native:${target.proof}` : filesystemFileVersion(await stat(target.fullPath));
      // This is the actual pure planner, given a clearly fixture-owned exact
      // selected-target snapshot, including native-only virtual membership.
      const plan = createWorkspaceOperationBatchPlan({ snapshot: { workspaceId, entries: [{ path: target.filePath, kind: 'file', identity,
        markdownContent: target.bytes.toString('utf8') }] }, actions: [{ reviewId: crypto.randomUUID(), kind: 'delete', selections: [{ sourcePath: target.filePath }] }] });
      assert.equal(plan.readiness, 'ready'); assert.deepEqual(plan.issues, []); assert.equal(computeWorkspaceOperationBatchPlanId(plan), plan.planId);
      assert.equal(plan.pathSteps.length, 1); assert.equal(plan.linkEdits.length, 0); assert.equal(plan.originalDocuments.length, 0);
      const created = await store.createDirect({ batchId: crypto.randomUUID(), plan, authorization: { mode: 'direct', actorUserId: 'member',
        actorId: actorType === 'agent' ? agentId : 'member', actorType, actorDisplayName: 'Actual fixture job', requestHash: sha(crypto.randomUUID()),
        ...(actorType === 'agent' ? { actorSessionId: piSessionId } : {}), jobScope: captureWorkspaceOperationJobScope(current) } });
      const claimed = await store.claim(crypto.randomUUID()); assert(claimed); assert.equal(claimed.batchId, created.batchId);
      return { claimed, target, plan };
    };
    const ledger = (job: Job) => row('workspace_file_operation_delete_intents', 'batch_id', job.claimed.batchId);
    const completion = (job: Job) => row('workspace_file_operation_delete_receipts', 'batch_id', job.claimed.batchId);
    const physicalFacts = async (job: Job) => {
      const durable = await ledger(job); assert(durable); const intent = JSON.parse(String(durable.intent_text)) as { physical: {
        trashEntryId: string; trashRelativePath: string; source: { kind: string } } };
      assert.match(intent.physical.trashEntryId, /^trash-[a-f0-9-]{36}$/u);
      const full = path.resolve(dataRoot, intent.physical.trashRelativePath); assert(full.startsWith(`${dataRoot}${path.sep}`));
      return { durable, physical: intent.physical, full };
    };
    type Fault = 'none' | 'after_intent_commit' | 'after_fs' | 'after_native_before_public' | 'completion_ack_loss' | 'alter_trash_before_public';
    const tracked = (job: Job, fault: Fault = 'none') => {
      const observation = { opens: 0, closes: 0, commits: 0, pid: 0, injected: false, movedObserved: false, committedObserved: false, payloadAltered: false };
      const inject = (code: string): never => { observation.injected = true; throw Object.assign(new Error(code), { code }); };
      return { observation, open: async (): Promise<SqlConnection> => {
        observation.opens++; const raw = await database.openDb(); checkouts.add(raw);
        observation.pid = Number((await raw.get('SELECT pg_backend_pid() AS pid') as Row).pid);
        const before = async (sql: string) => {
          if (observation.injected) return;
          if (fault === 'after_fs' && /^BEGIN\b/iu.test(sql) && await absent(job.target.fullPath) && await ledger(job) && !await completion(job)) {
            const facts = await physicalFacts(job); assert.deepEqual(await readFile(facts.full), job.target.bytes);
            observation.movedObserved = true; inject('FIXTURE_ORIGINAL_DELETE_AFTER_FS');
          }
          if (fault === 'after_native_before_public' && /^UPDATE\s+"[^"\u0000]+"\."?public_file_shares"?\s/iu.test(sql)) {
            const native = await raw.get(`SELECT status FROM "${schema}".collaboration_yjs_states WHERE document_id=$1`, [job.target.documentId]) as Row;
            assert.equal(native.status, 'archived'); observation.movedObserved = true; inject('FIXTURE_ORIGINAL_DELETE_AFTER_NATIVE');
          }
          if (fault === 'alter_trash_before_public' && /^UPDATE\s+"[^"\u0000]+"\."?public_file_shares"?\s/iu.test(sql)) {
            const native = await raw.get(`SELECT status FROM "${schema}".collaboration_yjs_states WHERE document_id=$1`, [job.target.documentId]) as Row;
            assert.equal(native.status, 'archived'); const facts = await physicalFacts(job);
            assert.deepEqual(await readFile(facts.full), job.target.bytes);
            await writeFile(facts.full, 'Deliberately altered owned trash payload.\n');
            observation.movedObserved = true; observation.payloadAltered = true; observation.injected = true;
          }
        };
        return { get: async (sql, values) => { await before(sql); return raw.get(sql, values); },
          all: async (sql, values) => { await before(sql); return raw.all(sql, values); },
          run: async (sql, values) => {
            await before(sql); const value = await raw.run(sql, values);
            if (/^COMMIT\s*$/iu.test(sql)) {
              observation.commits++;
              if (!observation.injected && fault === 'after_intent_commit' && await ledger(job) && !await completion(job)) {
                assert.equal(await absent(job.target.fullPath), false); inject('FIXTURE_ORIGINAL_DELETE_AFTER_INTENT_COMMIT');
              }
              if (!observation.injected && fault === 'completion_ack_loss' && await completion(job)) {
                const facts = await physicalFacts(job); assert.deepEqual(await readFile(facts.full), job.target.bytes);
                observation.committedObserved = true; inject('FIXTURE_ORIGINAL_DELETE_ACK_LOST');
              }
            }
            return value;
          }, close: async error => { observation.closes++; assert.equal(observation.closes, 1); assert(error);
            checkouts.delete(raw); await raw.close(error); } };
      } };
    };
    const invoke = async (job: Job, adapter = tracked(job)) => {
      const result = await store.withClaim(job.claimed, async claim => {
        const value = await execute(claim, adapter.open);
        const finished = await store.finishClaim(job.claimed, { status: 'applied', trashEntryIds: [value.trashEntryId], completedActions: 1, phase: 'complete' });
        assert(finished); assert.equal(finished.status, 'applied'); return value;
      });
      assert.equal(adapter.observation.opens, 1); assert.equal(adapter.observation.closes, 1); return result;
    };
    const failJob = async (job: Job) => {
      const finished = await store.finishClaim(job.claimed, { status: 'needs_recovery', errorCode: 'FIXTURE_INJECTED_FAILURE', phase: 'recovery' });
      assert(finished); assert.equal(finished.status, 'needs_recovery');
    };
    const resume = async (job: Job): Promise<Job> => {
      await failJob(job);
      const queued = await store.enqueue({ batchId: job.claimed.batchId, planId: job.claimed.planId, userId: 'member', displayName: 'Original actor', action: 'resume' });
      assert.equal(queued.status, 'queued'); const claimed = await store.claim(crypto.randomUUID()); assert(claimed);
      assert.equal(claimed.batchId, job.claimed.batchId); assert.deepEqual(claimed.plan, job.claimed.plan); assert.deepEqual(claimed.authorization, job.claimed.authorization);
      return { ...job, claimed };
    };
    const stateRow = (target: Target) => target.documentId ? row('collaboration_yjs_states', 'document_id', target.documentId) : undefined;
    const proof = async (target: Target) => ({ registry: target.documentId ? await row('collaboration_documents', 'id', target.documentId) : null,
      lineage: target.lineageId ? await row('file_collaboration_lineages', 'id', target.lineageId) : null,
      state: await stateRow(target), share: await row('public_file_shares', 'id', target.shareId) });
    const assertNoCompletion = async (job: Job) => {
      assert.equal(await completion(job), undefined);
      assert.equal(await row('workspace_file_operation_delete_trash_receipts', 'batch_id', job.claimed.batchId), undefined);
      const facts = await ledger(job);
      if (facts) assert.equal(await row('workspace_trash_entries', 'id', (await physicalFacts(job)).physical.trashEntryId), undefined);
    };
    const assertApplied = async (job: Job, result: Awaited<ReturnType<typeof execute>>, before: Awaited<ReturnType<typeof proof>>) => {
      assert.equal(result.version, 1); assert.equal(result.batchId, job.claimed.batchId); assert.match(result.intentDigest, /^[a-f0-9]{64}$/u);
      assert.match(result.receiptDigest, /^[a-f0-9]{64}$/u); const facts = await physicalFacts(job);
      assert.equal(result.trashEntryId, facts.physical.trashEntryId); assert.equal(await absent(job.target.fullPath), true);
      const durable = await completion(job); assert(durable); assert.equal(durable.intent_digest, facts.durable.intent_digest);
      assert.equal(result.receiptDigest, durable.receipt_digest); assert.equal(sha(String(durable.receipt_text)), durable.receipt_digest);
      assert.equal(sha(String(facts.durable.intent_text)), facts.durable.intent_digest);
      const trashReceipt = await row('workspace_file_operation_delete_trash_receipts', 'batch_id', job.claimed.batchId); assert(trashReceipt);
      assert.equal(sha(String(trashReceipt.receipt_text)), trashReceipt.receipt_digest);
      const trash = await row('workspace_trash_entries', 'id', result.trashEntryId); assert(trash);
      assert.equal(trash.status, 'trashed'); assert.equal(trash.workspace_id, workspaceId); assert.equal(trash.organization_id, organizationId);
      assert.equal(trash.original_path, job.target.filePath); assert.equal(trash.deleted_by_user_id, 'member');
      assert.equal(trash.trash_relative_path, facts.physical.trashRelativePath);
      if (result.physical.observation.kind === 'moved') {
        assert.deepEqual(await readFile(facts.full), job.target.bytes); assert.equal(result.physical.observation.sha256, sha(job.target.bytes));
        assert.equal(result.physical.original.source.kind, 'regular_file');
        if (result.physical.original.source.kind === 'regular_file') {
          const actual = await stat(facts.full); assert.equal(actual.ino, result.physical.original.source.identity.inode);
          assert.equal(actual.dev, result.physical.original.source.identity.device);
        }
      } else {
        assert.equal(result.physical.observation.kind, 'projection_absent'); assert.equal(await absent(facts.full), true);
        assert.equal('sha256' in result.physical.observation, false); assert.equal('sha256' in result.physical.original.source, false);
        assert.equal(JSON.parse(String(trash.metadata_json)).payloadKind, 'native_archive');
      }
      const share = await row('public_file_shares', 'id', job.target.shareId); assert(share); assert(before.share);
      assert.equal(share.status, 'revoked'); assert.equal(Number(share.policy_revision), Number(before.share.policy_revision) + 1);
      for (const key of Object.keys(before.share).filter(key => !['status', 'policy_revision', 'revoked_at', 'revoked_reason', 'updated_at'].includes(key))) {
        assert.deepEqual(share[key], before.share[key], `Exact S1 preservation: ${key}`);
      }
      if (job.target.state) {
        assert(result.native); const target = job.target, raw = (await admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId])).rows[0];
        assert.equal(raw.status, 'archived'); assert.equal(Number(raw.lifecycle_generation), 2);
        assert.deepEqual(raw.yjs_state, Buffer.from(target.state!.yjsState)); assert.deepEqual(raw.state_vector, Buffer.from(target.state!.stateVector));
        assert.equal(Number(raw.document_sequence), 7); assert.equal(Number(raw.persisted_at), 100); assert.equal(Number(raw.checkpoint_sequence), 0);
        for (const key of ['checkpointed_at', 'canonical_hash', 'serialized_hash', 'projection_error_code', 'projection_error_generation',
          'projection_error_sequence', 'projection_error_phase', 'projection_error_cause']) assert.equal(raw[key], null);
        assert.equal(Number(raw.degraded), 0); assert.equal(Number(raw.projection_error_permanent), 0);
        const archived = inspectArchivedNativeSnapshot({ documentId: raw.document_id, workspaceId: raw.workspace_id, organizationId: raw.organization_id,
          path: raw.path, representation: raw.representation, status: raw.status, schemaVersion: Number(raw.schema_version),
          lifecycleGeneration: Number(raw.lifecycle_generation), yjsState: raw.yjs_state, stateVector: raw.state_vector,
          documentSequence: Number(raw.document_sequence), persistedAt: Number(raw.persisted_at), checkpointSequence: Number(raw.checkpoint_sequence),
          checkpointedAt: raw.checkpointed_at, canonicalHash: raw.canonical_hash, serializedHash: raw.serialized_hash,
          newlineStyle: raw.newline_style, hasBom: Number(raw.has_bom) === 1, degraded: Number(raw.degraded) === 1 });
        assert.deepEqual(archived.content, target.content); assert.equal(archived.version.stateProof, target.proof);
        assert.equal(result.native.before.identity.documentId, target.documentId); assert.equal(result.native.before.identity.lineageId, target.lineageId);
        assert.equal(result.native.before.clock.stateProof, target.proof); assert.equal(result.native.after.identity.lifecycleGeneration, 2);
        const registry = await row('collaboration_documents', 'id', target.documentId!); assert(registry);
        assert.equal(registry.status, 'archived'); assert.equal(Number(registry.state_version), 0); assert.equal(registry.lineage_id, target.lineageId);
        const lineage = await row('file_collaboration_lineages', 'id', target.lineageId!); assert(lineage);
        assert.equal(lineage.status, 'archived'); assert.equal(lineage.trash_entry_id, result.trashEntryId);
        const projection = await row('collaboration_file_projections', 'document_id', target.documentId!); assert(projection);
        assert.equal(Number(projection.lifecycle_generation), 2); assert.equal(Number(projection.projected_sequence), 7); assert.equal(Number(projection.finalized), 0);
        for (const key of ['revision_id', 'canonical_hash', 'serialized_hash']) assert.equal(projection[key], null);
      } else assert.equal(result.native, null);
      assert.equal(checkouts.size, 0);
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); passed++; assert.equal(checkouts.size, 0);
      console.log('Original Delete fixture group passed:', JSON.stringify({ passed, name }));
    };
    await check('actual license, Cookie/Bearer controls and canDelete without canCreatePublicLinks', async () => {
      assert.equal(workspace.permissions.canDelete, true); assert.equal(workspace.permissions.canWrite, true); assert.equal(workspace.permissions.canCreatePublicLinks, false);
      for (const cookie of [false, true]) {
        const headers = new Headers({ 'x-canvas-workspace-id': workspaceId });
        if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', sessionToken, process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
        else headers.set('authorization', `Bearer ${sessionToken}`);
        assert.equal((await auth.api.getSession({ headers: new NextRequest('http://localhost/api/files/delete', { headers }).headers }))?.session.id, 'fixture-browser-session');
      }
    });
    await check('physical original and all-null S1 pins use real trash with no invented native identity', async () => {
      const target = await seedTarget(), job = await freshJob(target), before = await proof(target);
      await assertApplied(job, await invoke(job), before);
    });
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) await check(`original ${representation} archives exact native binary, lineage, projection and S1`, async () => {
      const target = await seedTarget({ representation, byteProfile: representation === 'tiptap_blocks' }), job = await freshJob(target), before = await proof(target);
      await assertApplied(job, await invoke(job), before);
    });
    await check('valid native-only missing projection has no fabricated physical hash', async () => {
      const target = await seedTarget({ representation: 'tiptap_blocks', physical: false }), job = await freshJob(target), before = await proof(target);
      await assertApplied(job, await invoke(job), before);
    });
    await check('legal unexportable rich colwidth content archives without Markdown export or rebuild', async () => {
      const target = await seedTarget({ representation: 'tiptap_blocks', nonexportable: true }), job = await freshJob(target), before = await proof(target);
      await assertApplied(job, await invoke(job), before);
    });
    await check('historical all-null public pins remain null for native D1', async () => {
      const target = await seedTarget({ representation: 'tiptap_xml', historicalNull: true }), job = await freshJob(target), before = await proof(target);
      await assertApplied(job, await invoke(job), before);
      const after = await row('public_file_shares', 'id', target.shareId); assert(after);
      for (const key of ['document_id', 'lineage_id', 'lifecycle_generation']) assert.equal(after[key], null);
    });
    await check('genuine stored PI and current Agent ACL execute original Delete without a synthetic Tool invocation', async () => {
      const target = await seedTarget({ representation: 'plain_text' }), job = await freshJob(target, 'agent'), before = await proof(target);
      await assertApplied(job, await invoke(job), before);
      const durable = await ledger(job); assert(durable);
      const captured = JSON.parse(String(durable.intent_text)).actor;
      assert.deepEqual(captured, { userId: 'member', actorId: agentId, actorType: 'agent', actorSessionId: piSessionId });
    });
    await check('current delete-right revocation rejects before intent, filesystem or native/public mutation', async () => {
      const target = await seedTarget({ representation: 'tiptap_blocks' }), job = await freshJob(target), before = await proof(target), identity = await stat(target.fullPath);
      try {
        await admin.query('UPDATE organization_user_permissions SET can_delete_team_files=0 WHERE organization_id=$1 AND user_id=\'member\'', [organizationId]);
        await assert.rejects(invoke(job), rejected('PRINCIPAL_ACCESS_DENIED'));
      } finally { await admin.query('UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id=$1 AND user_id=\'member\'', [organizationId]); }
      assert.deepEqual(await proof(target), before); assert.equal(await ledger(job), undefined); await assertNoCompletion(job);
      assert.deepEqual(await readFile(target.fullPath), target.bytes); assert.equal((await stat(target.fullPath)).ino, identity.ino); await failJob(job);
    });
    for (const drift of ['generation', 'binary'] as const) await check(`persisted original intent refuses ${drift} drift before filesystem move`, async () => {
      const target = await seedTarget({ representation: 'tiptap_blocks' }), job = await freshJob(target), adapter = tracked(job, 'after_intent_commit');
      await assert.rejects(invoke(job, adapter), rejected('JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
      assert.equal(adapter.observation.injected, true); assert.equal(adapter.observation.closes, 1); assert.equal(await absent(target.fullPath), false);
      const original = await ledger(job); assert(original); const identity = await stat(target.fullPath);
      if (drift === 'generation') await admin.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [target.documentId]);
      else {
        const changed = createRichMarkdownYDoc('# Changed native\n\nDifferent content.\n', 'tiptap_blocks');
        try { await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3 WHERE document_id=$1',
          [target.documentId, Buffer.from(Y.encodeStateAsUpdate(changed)), Buffer.from(Y.encodeStateVector(changed))]); }
        finally { changed.destroy(); }
      }
      const changed = await proof(target), resumed = await resume(job);
      await assert.rejects(invoke(resumed), rejected('ORIGINAL_DELETE_CHANGED', 'ORIGINAL_NATIVE_DELETE_CHANGED', 'NATIVE_FILE_ARCHIVE_SOURCE_CHANGED'));
      assert.deepEqual(await proof(target), changed); assert.deepEqual(await ledger(job), original); await assertNoCompletion(job);
      assert.deepEqual(await readFile(target.fullPath), target.bytes); assert.equal((await stat(target.fullPath)).ino, identity.ino); await failJob(resumed);
    });
    await check('historical physical-only intent never adopts a later native D2 on the unchanged source inode', async () => {
      const target = await seedTarget(), job = await freshJob(target), adapter = tracked(job, 'after_intent_commit');
      await assert.rejects(invoke(job, adapter), rejected('JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
      assert.equal(adapter.observation.injected, true); const original = await ledger(job); assert(original);
      assert.equal(JSON.parse(String(original.intent_text)).native, null); const identity = await stat(target.fullPath);
      const replacement = await seedTarget({ representation: 'plain_text', filePath: target.filePath, keepPhysical: true, reuseShareId: target.shareId });
      const replacementBefore = await proof(replacement), resumed = await resume(job);
      await assert.rejects(invoke(resumed), rejected('ORIGINAL_DELETE_CHANGED', 'ORIGINAL_DELETE_UNPROVEN'));
      assert.deepEqual(await proof(replacement), replacementBefore); assert.deepEqual(await ledger(job), original); await assertNoCompletion(job);
      assert.deepEqual(await readFile(target.fullPath), target.bytes); const after = await stat(target.fullPath);
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(after[key], identity[key]);
      await failJob(resumed);
    });
    for (const fault of ['after_fs', 'after_native_before_public'] as const) await check(`${fault} preserves atomic SQL rollback and resumes the same original intent/trash`, async () => {
      const target = await seedTarget({ representation: 'tiptap_blocks' }), job = await freshJob(target), before = await proof(target), adapter = tracked(job, fault);
      await assert.rejects(invoke(job, adapter), rejected(fault === 'after_fs' ? 'FIXTURE_ORIGINAL_DELETE_AFTER_FS' : 'FIXTURE_ORIGINAL_DELETE_AFTER_NATIVE'));
      assert.equal(adapter.observation.injected, true); assert.equal(adapter.observation.movedObserved, true); assert.equal(adapter.observation.closes, 1);
      assert.equal(await absent(target.fullPath), true); assert.deepEqual(await proof(target), before); await assertNoCompletion(job);
      const original = await physicalFacts(job); assert.deepEqual(await readFile(original.full), target.bytes);
      const result = await invoke(await resume(job)); assert.equal(result.trashEntryId, original.physical.trashEntryId);
      assert.deepEqual(await ledger(job), original.durable); await assertApplied(job, result, before);
    });
    await check('actual completion COMMIT then ACK loss recovers history while fresh D2/S2 at the same path remain byte-exact', async () => {
      const target = await seedTarget({ representation: 'tiptap_blocks' }), job = await freshJob(target), before = await proof(target), adapter = tracked(job, 'completion_ack_loss');
      await assert.rejects(invoke(job, adapter), rejected('JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
      assert.equal(adapter.observation.injected, true); assert.equal(adapter.observation.committedObserved, true); assert.equal(adapter.observation.closes, 1);
      assert.equal((await control.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS alive', [adapter.observation.pid])).rows[0].alive, false);
      const original = await ledger(job), confirmed = await completion(job); assert(original); assert(confirmed);
      const stored = JSON.parse(String(confirmed.receipt_text));
      const recoveredBeforeD2 = { ...stored, receiptDigest: confirmed.receipt_digest } as Awaited<ReturnType<typeof execute>>;
      await assertApplied(job, recoveredBeforeD2, before);
      const replacement = await seedTarget({ representation: 'plain_text', filePath: target.filePath }), replacementBefore = await proof(replacement);
      const replacementBytes = await readFile(replacement.fullPath), replacementIdentity = await stat(replacement.fullPath);
      assert.notEqual(replacement.documentId, target.documentId); assert.notEqual(replacement.lineageId, target.lineageId); assert.notEqual(replacement.shareId, target.shareId);
      const recoveredAdapter = tracked(job), recovered = await invoke(await resume(job), recoveredAdapter);
      assert.notEqual(recoveredAdapter.observation.pid, adapter.observation.pid); assert.equal(recovered.intentDigest, original.intent_digest);
      assert.equal(recovered.receiptDigest, confirmed.receipt_digest); assert.equal(recovered.trashEntryId, stored.trashEntryId);
      assert.deepEqual(await ledger(job), original); assert.deepEqual(await completion(job), confirmed); assert.deepEqual(await proof(replacement), replacementBefore);
      assert.deepEqual(await readFile(replacement.fullPath), replacementBytes); const afterIdentity = await stat(replacement.fullPath);
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(afterIdentity[key], replacementIdentity[key]);
      assert.equal(recovered.native!.before.identity.documentId, target.documentId); assert.equal(recovered.native!.before.identity.lineageId, target.lineageId);
      assert.equal((await row('public_file_shares', 'id', replacement.shareId))!.status, 'active');
      const entries = await admin.query('SELECT id FROM workspace_trash_entries WHERE original_path=$1', [target.filePath]); assert.equal(entries.rows.length, 1);
      for (const table of ['workspace_file_operation_delete_intents', 'workspace_file_operation_delete_trash_receipts', 'workspace_file_operation_delete_receipts']) {
        const beforeImmutable = await row(table, 'batch_id', job.claimed.batchId); assert(beforeImmutable);
        await assert.rejects(admin.query(`UPDATE "${schema}".${table} SET created_at=created_at+1 WHERE batch_id=$1`, [job.claimed.batchId]), rejected('55000'));
        await assert.rejects(admin.query(`DELETE FROM "${schema}".${table} WHERE batch_id=$1`, [job.claimed.batchId]), rejected('55000'));
        assert.deepEqual(await row(table, 'batch_id', job.claimed.batchId), beforeImmutable);
      }
    });
    await check('actual FileHandle close ACK loss preserves the primary rolled-back SQL phase failure and disposal 503', async () => {
      const target = await seedTarget({ representation: 'tiptap_blocks' }), job = await freshJob(target), before = await proof(target);
      const adapter = tracked(job, 'after_native_before_public');
      const originalOpen = Object.getOwnPropertyDescriptor(fs, 'open'); assert(originalOpen); assert.equal(typeof originalOpen.value, 'function');
      const realOpen = fs.open.bind(fs), sourceHandles: FileHandle[] = [], closes = new Map<FileHandle, number>();
      const closeError = Object.assign(new Error('Owned source descriptor close acknowledgment lost.'), { code: 'FIXTURE_ORIGINAL_DELETE_FD_ACK_LOST' });
      const patchedOpen: typeof fs.open = async (...args) => {
        const handle = await realOpen(...args);
        if (args[0] === target.fullPath) {
          sourceHandles.push(handle); const realClose = handle.close.bind(handle);
          Object.defineProperty(handle, 'close', { configurable: true, writable: true, value: async () => {
            closes.set(handle, (closes.get(handle) ?? 0) + 1); await realClose(); throw closeError;
          } });
        }
        return handle;
      };
      try {
        Object.defineProperty(fs, 'open', { ...originalOpen, value: patchedOpen });
        await assert.rejects(invoke(job, adapter), error => {
          assert(error instanceof AggregateError); assert.equal(Reflect.get(error, 'code'), 'disposal-unconfirmed');
          assert.equal(Reflect.get(error, 'status'), 503);
          const observed = new Set<unknown>();
          const visit = (value: unknown): void => {
            if (!(value instanceof Error) || observed.has(value)) return; observed.add(value);
            if (value instanceof AggregateError) for (const child of value.errors) visit(child);
            visit(value.cause);
          };
          visit(error); assert(observed.has(closeError));
          assert([...observed].some(value => value instanceof Error && Reflect.get(value, 'code') === 'FIXTURE_ORIGINAL_DELETE_AFTER_NATIVE'));
          return true;
        });
      } finally { Object.defineProperty(fs, 'open', originalOpen); }
      assert.deepEqual(Object.getOwnPropertyDescriptor(fs, 'open'), originalOpen);
      assert.equal(sourceHandles.length, 1); assert.equal(sourceHandles[0].fd, -1); assert.equal(closes.get(sourceHandles[0]), 1);
      assert.equal(adapter.observation.injected, true); assert.equal(adapter.observation.movedObserved, true);
      assert.equal(adapter.observation.opens, 1); assert.equal(adapter.observation.closes, 1); assert.equal(checkouts.size, 0);
      assert.equal((await control.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS alive', [adapter.observation.pid])).rows[0].alive, false);
      assert.deepEqual(await proof(target), before); await assertNoCompletion(job); assert.equal(await absent(target.fullPath), true);
      const facts = await physicalFacts(job); assert.deepEqual(await readFile(facts.full), target.bytes); await failJob(job);
    });
    for (const drift of ['token', 'policy'] as const) await check(`original S1 ${drift} drift after durable intent rejects before filesystem move`, async () => {
      const target = await seedTarget({ representation: 'tiptap_blocks' }), job = await freshJob(target), adapter = tracked(job, 'after_intent_commit');
      await assert.rejects(invoke(job, adapter), rejected('JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
      assert.equal(adapter.observation.injected, true); const original = await ledger(job); assert(original); const identity = await stat(target.fullPath);
      if (drift === 'token') {
        const token = crypto.randomBytes(32).toString('base64url');
        await admin.query('UPDATE public_file_shares SET token=$2,token_hash=$3 WHERE id=$1', [target.shareId, token, sha(token)]);
      } else await admin.query("UPDATE public_file_shares SET policy_revision=policy_revision+1,reason='Changed owned fixture policy' WHERE id=$1", [target.shareId]);
      const changed = await proof(target), resumed = await resume(job);
      await assert.rejects(invoke(resumed), rejected('ORIGINAL_DELETE_PUBLIC_CHANGED'));
      assert.deepEqual(await proof(target), changed); assert.deepEqual(await ledger(job), original); await assertNoCompletion(job);
      assert.deepEqual(await readFile(target.fullPath), target.bytes); const after = await stat(target.fullPath);
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(after[key], identity[key]);
      await failJob(resumed);
    });
    await check('actual trash payload alteration during B2 rolls back native/public/trash/completion and remains needs_recovery', async () => {
      const target = await seedTarget({ representation: 'tiptap_blocks' }), job = await freshJob(target), before = await proof(target);
      const adapter = tracked(job, 'alter_trash_before_public');
      await assert.rejects(invoke(job, adapter), rejected('source-changed'));
      assert.equal(adapter.observation.payloadAltered, true); assert.equal(adapter.observation.movedObserved, true); assert.equal(adapter.observation.closes, 1);
      assert.deepEqual(await proof(target), before); await assertNoCompletion(job); assert.equal(await absent(target.fullPath), true);
      const facts = await physicalFacts(job); assert.equal(await readFile(facts.full, 'utf8'), 'Deliberately altered owned trash payload.\n');
      assert.notEqual(sha(await readFile(facts.full)), sha(target.bytes)); await failJob(job);
      const stored = await store.get(job.claimed.batchId); assert(stored); assert.equal(stored.status, 'needs_recovery');
      assert.equal(await completion(job), undefined); assert.equal(checkouts.size, 0);
    });
    assert.equal(passed, 20); assert.equal(fetches, 0); await own(); assert.equal(await sourceHash(), pinned);
    console.log('Original Delete SQL assertions finished:', JSON.stringify({ passed, fetches, sourceSha256: pinned }));
  } catch (error) { failures.push(error); }
  finally {
    const cleanup = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { failures.push(error); } };
    for (const connection of checkouts) await cleanup(async () => { checkouts.delete(connection); await connection.close(new Error('Discarding leaked original Delete fixture checkout.')); });
    if (pool) await cleanup(() => pool!.end());
    for (const client of clients) await cleanup(() => endClient(client));
    if (created && clients.size === 0) await cleanup(async () => {
      const row = (await control.query(`SELECT oid,obj_description(oid,'pg_namespace') AS nonce,
        nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
      assert(row); assert.equal(Number(row.oid), schemaOid); assert.equal(row.nonce, nonce); assert.equal(row.owner, true);
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      schemaRemoved = (await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed === true; assert(schemaRemoved);
    });
    if (connected) await cleanup(() => control.end());
    await cleanup(async () => { const current = await stat(dataRoot); assert.equal(current.dev, dataIdentity.dev); assert.equal(current.ino, dataIdentity.ino);
      assert.equal(current.uid, dataIdentity.uid); await rm(dataRoot, { recursive: true });
      await assert.rejects(stat(dataRoot), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT'); dataRemoved = true; });
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    await cleanup(async () => { assert.equal(await sourceHash(), pinned); });
    console.log('Original Delete fixture cleanup:', JSON.stringify({ schemaRemoved, dataRemoved, openClients: clients.size, openCheckouts: checkouts.size, passed }));
  }
  if (failures.length) {
    const error = failures[0], code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    const locations = error instanceof Error ? error.stack?.split('\n').flatMap(line => {
      const match = /\/(app\/.*|scripts\/.*):(\d+):(\d+)\)?$/u.exec(line);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 4) : undefined;
    throw new Error(`Original Delete fixture failed: ${stage}; name=${error instanceof Error ? error.name : 'unknown'}; code=${typeof code === 'string' && /^[A-Z0-9_]{1,128}$/u.test(code) ? code : 'unclassified'}; source=${locations?.join(',') || 'unavailable'}; failures=${failures.length}`);
  }
  assert(schemaRemoved); assert(dataRemoved);
}

void runSqlFixture({ label: 'workspace-operation-original-delete-postgres-test', operation: main,
  successMessage: 'Original Delete genuine PG18 integration assertions and owned resource cleanup passed; no UI/general-producer/Restore claim.' });
