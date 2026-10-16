import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, type Pool, type PoolClient } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { runPgliteFixture as runSqlFixture } from './helpers/pglite-pool-harness';

// Real PG18, current signed Team license, actual actor policy and genuine Store
// claim. Every schema, connection and physical path belongs to this fixture.
const sourcePath = path.resolve('scripts/workspace-operation-original-move-owner-postgres-test.ts');
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const sourceHash = async () => sha(await readFile(sourcePath));
const code = (error:unknown) => error && typeof error==='object' ? Object.getOwnPropertyDescriptor(error,'code')?.value : undefined;
const absent = async (filename:string) => {try {await stat(filename);return false;} catch(error) {if(code(error)==='ENOENT')return true;throw error;}};
function describeFailure(error: unknown, depth=0):unknown {
  if (!(error instanceof Error) || depth>4) return {name:'unknown'};
  return {name:error.name,code:code(error),source:error.stack?.split('\n').flatMap(line=>{const match=/\/(app\/.*|scripts\/.*):(\d+):(\d+)\)?$/u.exec(line);return match?[`${match[1]}:${match[2]}:${match[3]}`]:[];}).slice(0,5),
    ...(error instanceof AggregateError?{errors:error.errors.slice(0,4).map(child=>describeFailure(child,depth+1))}:{}),
    ...(error.cause instanceof Error?{cause:describeFailure(error.cause,depth+1)}:{})};
}
async function main(): Promise<void> {
  const pinned = await sourceHash();
  console.log('Original Move owner fixture source:', pinned);
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
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=owned-move-owner-${nonce}`, CANVAS_DATABASE_PROVIDER: 'postgres',
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
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { createPlainTextYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { inspectPersistedNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
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
    const { readWorkspaceLinkSourceAuthorityOnConnection } = await import('../app/lib/markdown/workspace-source-authority-stage');
    const { createWorkspaceOperationNativeMoveBatchPlan } = await import('../app/lib/files/workspace-operation-native-move-plan');
    const { executeWorkspaceOperationOriginalMove: execute } = await import('../app/lib/files/workspace-operation-original-move-runner');
    const ownerApi = await import('../app/lib/files/workspace-operation-job-lifecycle-owner');
    const pins = ['app/lib/files/workspace-operation-job-lifecycle-owner.ts','app/lib/files/workspace-operation-original-move-storage.ts',
      'app/lib/files/workspace-operation-original-move-handoff-storage.ts','app/lib/files/workspace-operation-original-move-runner.ts',
      'app/lib/files/workspace-operation-original-move.ts','app/lib/files/workspace-operation-original-move-sources.ts',
      'app/lib/files/workspace-operation-original-move-namespace-effects.ts','app/lib/filesystem/prepared-workspace-path-move.ts',
      'app/lib/filesystem/prepared-workspace-path-move-contract.ts','scripts/workspace-operation-original-move-owner-postgres-test.ts',
      'app/lib/markdown/native-file-operation-handoff.ts','app/lib/markdown/native-file-operation-side-effects.ts',
      'app/lib/collaboration/room-admission-outcome.ts','app/lib/files/workspace-operation-original-move-admission.ts',
      'app/lib/files/workspace-operation-native-move-status.ts','app/lib/files/workspace-operation-native-read-context.ts',
      'app/lib/files/workspace-operation-batch-executor.ts','app/lib/files/workspace-operation-native-move-execution-public.ts',
      'app/lib/files/workspace-path-operation-response.ts'];
    const sourcePins = await Promise.all(pins.map(async filename => [filename,sha(await readFile(filename))] as const));
    console.log('Original Move pinned sources:',JSON.stringify(sourcePins));
    const seedNative = async (filename:string,content:string,physical=false) => {
      const documentId=`move-doc-${crypto.randomUUID()}`,lineageId=`move-lineage-${crypto.randomUUID()}`;
      const doc=createPlainTextYDoc(content);let state:PersistedCollaborationState;
      try {state={documentId,workspaceId,organizationId,path:filename,representation:'plain_text',lifecycleGeneration:1,schemaVersion:1,
        yjsState:Buffer.from(Y.encodeStateAsUpdate(doc)),stateVector:Buffer.from(Y.encodeStateVector(doc)),documentSequence:7,persistedAt:100,
        checkpointSequence:0,checkpointedAt:null,canonicalHash:null,serializedHash:null,newlineStyle:'lf',hasBom:false,degraded:false,status:'active'};
        inspectPersistedNativeCollaborationSnapshot(state,(_doc,native)=>native);
      } finally {doc.destroy();}
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization',$3,$4,'active',100)`,[lineageId,workspaceId,organizationId,filename]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'organization',$4,$5,'yjs',7,'initialized','active',100,100)`,[documentId,lineageId,workspaceId,organizationId,filename]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,$3,$4,'plain_text',1,1,$5,$6,7,100,0,NULL,NULL,NULL,'lf',0,0,'active')`,[documentId,workspaceId,organizationId,filename,state!.yjsState,state!.stateVector]);
      await admin.query(`INSERT INTO collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,finalized,updated_at) VALUES($1,1,0,0,100)`,[documentId]);
      if(physical) {await mkdir(path.dirname(path.join(workspace.rootPath,filename)),{recursive:true});await writeFile(path.join(workspace.rootPath,filename),content,{flag:'wx',mode:0o600});}
      return {documentId,lineageId,content,filename};
    };
    const seedMetadata=async(filename:string)=>{
      await admin.query('INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,\'Preserved title\',100,100)',[workspaceId,filename]);
      await admin.query(`INSERT INTO workspace_file_user_states(workspace_id,user_id,path,is_favorite,pinned_at,created_at,updated_at)
        VALUES($1,'member',$2,1,120,100,100)`,[workspaceId,filename]);
    };
    const metadata=async(filename:string)=>(await admin.query('SELECT path,title FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2',[workspaceId,filename])).rows;
    const nativePath=async(documentId:string)=>(await admin.query('SELECT path FROM collaboration_yjs_states WHERE document_id=$1',[documentId])).rows[0]?.path;
    const nativeContent=async(documentId:string)=>{
      const row=(await admin.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1',[documentId])).rows[0];assert(row);
      const doc=new Y.Doc();try{Y.applyUpdate(doc,row.yjs_state);return doc.getText('content').toString();}finally{doc.destroy();}
    };
    const freshJob=async(selections:Array<{sourcePath:string;destinationPath:string}>)=>{
      const current=await currentWorkspace(),connection=await database.openDb();let observation;
      try{observation=await readWorkspaceLinkSourceAuthorityOnConnection(connection,current);}finally{await connection.close();}
      const plan=createWorkspaceOperationNativeMoveBatchPlan({scope:{workspace:current,fileOptions:{workspace:current}},
        actions:[{reviewId:crypto.randomUUID(),kind:'move',selections}],observation});
      assert.equal(plan.version,3);assert.equal(plan.readiness,'ready');
      const created=await store.createDirect({batchId:crypto.randomUUID(),plan,authorization:{mode:'direct',actorUserId:'member',actorId:'member',actorType:'user',
        actorDisplayName:'Actual Move fixture actor',requestHash:sha(crypto.randomUUID()),jobScope:captureWorkspaceOperationJobScope(current)}});
      const claimed=await store.claim(crypto.randomUUID());assert(claimed);assert.equal(claimed.batchId,created.batchId);
      return {claimed,plan,workspace:current};
    };
    type Job=Awaited<ReturnType<typeof freshJob>>;
    const invoke=async(job:Job,onPathCommitted?:(count:number)=>Promise<void>,afterCompleted?:(claim:Parameters<typeof execute>[0]['claim'],completion:Awaited<ReturnType<typeof execute>>)=>Promise<void>)=>store.withClaim(job.claimed,async claim=>{
      const result=await execute({claim,workspace:job.workspace,onPathCommitted});await afterCompleted?.(claim,result);
      assert(await store.finishClaim(job.claimed,{status:'applied',completedActions:job.claimed.totalActions,phase:'complete'}));return result;});
    const abort=async(job:Job)=>{assert(await store.finishClaim(job.claimed,{status:'failed',errorCode:'FIXTURE_EXPECTED_REJECTION',phase:'failed'}));};
    const resume=async(job:Job)=>{
      assert(await store.finishClaim(job.claimed,{status:'needs_recovery',errorCode:'FIXTURE_MOVE_INTERRUPTED',phase:'recovery'}));
      await store.enqueue({batchId:job.claimed.batchId,planId:job.claimed.planId,userId:'member',displayName:'Actual original actor',action:'resume'});
      const claimed=await store.claim(crypto.randomUUID());assert(claimed);assert.equal(claimed.batchId,job.claimed.batchId);return {...job,claimed};
    };
    const check=async(label:string,operation:()=>Promise<void>)=>{stage=label;await own();await operation();await own();passed++;console.log('Original Move owner case passed:',label);};
    await check('native-only target, incoming native link and native metadata commit on real B',async()=>{
      const name=`native-${crypto.randomUUID()}.md`,destination=`virtual/${name}`;
      const target=await seedNative(name,'# Native original\n'),peer=await seedNative(`incoming-${crypto.randomUUID()}.md`,`[Original](${name})\n`);
      await seedMetadata(name);const job=await freshJob([{sourcePath:name,destinationPath:destination}]);
      const receipt=await invoke(job);assert(receipt.native);assert.equal(receipt.native.receipts.length,2);
      assert.equal(await nativePath(target.documentId),destination);assert((await nativeContent(peer.documentId)).includes(destination));
      assert.deepEqual(await metadata(name),[]);assert.deepEqual(await metadata(destination),[{path:destination,title:'Preserved title'}]);
      assert.equal(await absent(path.join(workspace.rootPath,name)),true);assert.equal(await absent(path.join(workspace.rootPath,destination)),true);
    });
    await check('PDF physical move, native link-only bundle and namespace metadata',async()=>{
      const name=`paper-${crypto.randomUUID()}.pdf`,destination=`papers/${name}`,bytes=Buffer.from('%PDF-1.7\nowned fixture bytes\n');
      await writeFile(path.join(workspace.rootPath,name),bytes,{flag:'wx',mode:0o600});
      const peer=await seedNative(`pdf-incoming-${crypto.randomUUID()}.md`,`[PDF](${name})\n`);await seedMetadata(name);
      const job=await freshJob([{sourcePath:name,destinationPath:destination}]),receipt=await invoke(job);
      assert(receipt.native);assert.equal(receipt.native.sideEffectReceiptDigest,null);assert(receipt.namespaceEffects);
      assert.deepEqual(await readFile(path.join(workspace.rootPath,destination)),bytes);assert.equal(await absent(path.join(workspace.rootPath,name)),true);
      assert((await nativeContent(peer.documentId)).includes(destination));assert.deepEqual(await metadata(name),[]);assert.equal((await metadata(destination)).length,1);
    });
    await check('filled folder preserves every owned file and updates native incoming links',async()=>{
      const name=`folder-${crypto.randomUUID()}`,destination=`moved/${name}`;
      await mkdir(path.join(workspace.rootPath,name));await writeFile(path.join(workspace.rootPath,name,'one.pdf'),'owned-one',{mode:0o600});
      await mkdir(path.join(workspace.rootPath,name,'child'));await writeFile(path.join(workspace.rootPath,name,'child','two.bin'),'owned-two',{mode:0o600});
      const peer=await seedNative(`folder-incoming-${crypto.randomUUID()}.md`,`[File](${name}/one.pdf)\n`);
      await seedMetadata(`${name}/one.pdf`);const job=await freshJob([{sourcePath:name,destinationPath:destination}]);await invoke(job);
      assert.equal(await readFile(path.join(workspace.rootPath,destination,'one.pdf'),'utf8'),'owned-one');
      assert.equal(await readFile(path.join(workspace.rootPath,destination,'child','two.bin'),'utf8'),'owned-two');
      assert((await nativeContent(peer.documentId)).includes(`${destination}/one.pdf`));assert.equal((await metadata(`${destination}/one.pdf`)).length,1);
    });
    await check('two physical roots share one durably acknowledged created parent',async()=>{
      const first=`one-${crypto.randomUUID()}.pdf`,second=`two-${crypto.randomUUID()}.pdf`,parent=`shared-${crypto.randomUUID()}`;
      await writeFile(path.join(workspace.rootPath,first),'one',{mode:0o600});await writeFile(path.join(workspace.rootPath,second),'two',{mode:0o600});
      const job=await freshJob([{sourcePath:first,destinationPath:`${parent}/${first}`},{sourcePath:second,destinationPath:`${parent}/${second}`}]);
      const receipt=await invoke(job);assert.equal(receipt.parentReceipts.length,1);assert.equal(receipt.pathReceipts.length,2);
      assert.equal(await readFile(path.join(workspace.rootPath,parent,first),'utf8'),'one');assert.equal(await readFile(path.join(workspace.rootPath,parent,second),'utf8'),'two');
    });
    await check('after-FS interruption retains own Admission and resumes same journal',async()=>{
      const name=`resume-${crypto.randomUUID()}.pdf`,destination=`resumed/${name}`;await writeFile(path.join(workspace.rootPath,name),'resumable',{mode:0o600});
      const job=await freshJob([{sourcePath:name,destinationPath:destination}]);let reached=false;
      await assert.rejects(invoke(job,async()=>{reached=true;throw Object.assign(new Error('Owned Move interruption'),{code:'FIXTURE_MOVE_AFTER_PATH'});}),error=>code(error)==='FIXTURE_MOVE_AFTER_PATH');assert(reached);
      const intents=(await admin.query('SELECT intent_digest FROM workspace_file_operation_move_intents WHERE batch_id=$1',[job.claimed.batchId])).rows;assert.equal(intents.length,1);
      assert.equal(await absent(path.join(workspace.rootPath,name)),true);assert.equal(await readFile(path.join(workspace.rootPath,destination),'utf8'),'resumable');
      const resumed=await resume(job);await invoke(resumed);assert.deepEqual((await admin.query('SELECT intent_digest FROM workspace_file_operation_move_intents WHERE batch_id=$1',[job.claimed.batchId])).rows,intents);
    });
    await check('historical completion authorizes but neither adopts nor moves a later D2',async()=>{
      const name=`history-${crypto.randomUUID()}.pdf`,destination=`history-dest/${name}`;await writeFile(path.join(workspace.rootPath,name),'first-original',{mode:0o600});
      const job=await freshJob([{sourcePath:name,destinationPath:destination}]);
      await invoke(job,undefined,async(claim,first)=>{await writeFile(path.join(workspace.rootPath,name),'later-D2',{flag:'wx',mode:0o600});
        const history=await execute({claim,workspace:job.workspace});assert.deepEqual(history,first);
        assert.equal(await readFile(path.join(workspace.rootPath,name),'utf8'),'later-D2');
        assert.equal(await readFile(path.join(workspace.rootPath,destination),'utf8'),'first-original');});
    });
    await check('forged owner and raw-B source getter cannot grant claimed work',async()=>{
      await assert.rejects(ownerApi.readWorkspaceOperationOriginalMoveJobReceipts({} as Parameters<typeof ownerApi.readWorkspaceOperationOriginalMoveJobReceipts>[0]),error=>code(error)==='JOB_LIFECYCLE_REQUIRED');
      const connection=await database.openDb();try{await assert.rejects(ownerApi.readWorkspaceOperationOriginalMoveSourcesContext(connection),error=>code(error)==='JOB_LIFECYCLE_REQUIRED');}finally{await connection.close();}
    });
    await check('revoked current actor permission rejects before any original intent or physical work',async()=>{
      const name=`revoked-${crypto.randomUUID()}.pdf`,destination=`revoked-dest/${name}`;await writeFile(path.join(workspace.rootPath,name),'current-actor',{mode:0o600});
      const job=await freshJob([{sourcePath:name,destinationPath:destination}]);
      await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE organization_id=$1 AND user_id='member'",[organizationId]);
      try {await assert.rejects(invoke(job));assert.equal(await readFile(path.join(workspace.rootPath,name),'utf8'),'current-actor');assert(await absent(path.join(workspace.rootPath,destination)));
        assert.equal((await admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_move_intents WHERE batch_id=$1',[job.claimed.batchId])).rows[0].n,0);
      }finally{await admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE organization_id=$1 AND user_id='member'",[organizationId]);}
      await abort(job);
    });
    await check('foreign durable Admission is never adopted as the original own reservation',async()=>{
      const name=`foreign-${crypto.randomUUID()}.pdf`,destination=`foreign-dest/${name}`;await writeFile(path.join(workspace.rootPath,name),'foreign-guard',{mode:0o600});
      const job=await freshJob([{sourcePath:name,destinationPath:destination}]);
      const {reserveCollaborationAdmissionOnConnection}=await import('../app/lib/collaboration/room-admission');
      const {collaborationAdmissionActionDigest}=await import('../app/lib/collaboration/room-admission-contract');
      const requestId=crypto.randomUUID(),payload=JSON.stringify({fixture:'foreign-original-request'}),connection=await database.openDb();
      try {await connection.run('BEGIN');await reserveCollaborationAdmissionOnConnection(connection,{requestId,actorId:'fixture-foreign',action:'move',actionPayloadText:payload,
        actionDigest:collaborationAdmissionActionDigest('move',payload),scopes:[{workspaceId,organizationId,path:'',kind:'subtree'}],
        expectedDocuments:job.plan.sourceEvidence.nativeBindings.map(binding=>({documentId:binding.expected.documentId,workspaceId,organizationId,path:binding.expected.path,
          representation:binding.expected.representation,lifecycleGeneration:binding.expected.lifecycleGeneration,schemaVersion:binding.expected.schemaVersion,status:'active'}))});await connection.run('COMMIT');}
      catch(error){await connection.run('ROLLBACK');throw error;}finally{await connection.close();}
      try {await assert.rejects(invoke(job),error=>code(error)==='JOB_LIFECYCLE_CHANGED');assert.equal(await readFile(path.join(workspace.rootPath,name),'utf8'),'foreign-guard');
        assert.equal((await admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_move_intents WHERE batch_id=$1',[job.claimed.batchId])).rows[0].n,0);
      }finally{await admin.query("UPDATE collaboration_admission_targets SET active=false,status='cancelled' WHERE request_id=$1",[requestId]);
        await admin.query("UPDATE collaboration_admission_requests SET status='cancelled' WHERE request_id=$1",[requestId]);}
      await abort(job);
    });
    await check('caught forged capability poisons the actual enclosing owner and closes B',async()=>{
      const name=`poison-${crypto.randomUUID()}.pdf`,destination=`poison-dest/${name}`;await writeFile(path.join(workspace.rootPath,name),'must-stay',{mode:0o600});
      const job=await freshJob([{sourcePath:name,destinationPath:destination}]);
      await assert.rejects(store.withClaim(job.claimed,claim=>ownerApi.withWorkspaceOperationNativeMoveJobOwner(claim,async owner=>{
        await assert.rejects(ownerApi.readWorkspaceOperationOriginalMoveJobReceipts({} as typeof owner),error=>code(error)==='JOB_LIFECYCLE_REQUIRED');
        await ownerApi.readWorkspaceOperationOriginalMoveJobReceipts(owner);
      })),error=>code(error)==='JOB_LIFECYCLE_REQUIRED');
      assert.equal(await readFile(path.join(workspace.rootPath,name),'utf8'),'must-stay');assert(await absent(path.join(workspace.rootPath,destination)));await abort(job);
    });
    await check('detached fixed operation poisons, drains and closes the actual owner',async()=>{
      const name=`detached-${crypto.randomUUID()}.pdf`,destination=`detached-dest/${name}`;await writeFile(path.join(workspace.rootPath,name),'must-drain',{mode:0o600});
      const job=await freshJob([{sourcePath:name,destinationPath:destination}]);
      await assert.rejects(store.withClaim(job.claimed,claim=>ownerApi.withWorkspaceOperationNativeMoveJobOwner(claim,async owner=>{
        void ownerApi.readWorkspaceOperationOriginalMoveJobReceipts(owner).catch(()=>undefined);
      })),error=>code(error)==='JOB_LIFECYCLE_DETACHED');
      assert.equal(await readFile(path.join(workspace.rootPath,name),'utf8'),'must-drain');assert(await absent(path.join(workspace.rootPath,destination)));await abort(job);
    });
    await check('lost actual owner backend after FS cannot commit B2 and genuine own recovery succeeds',async()=>{
      const name=`lost-b-${crypto.randomUUID()}.pdf`,destination=`lost-b-dest/${name}`;await writeFile(path.join(workspace.rootPath,name),'lost-real-B',{mode:0o600});
      const job=await freshJob([{sourcePath:name,destinationPath:destination}]);let terminated=false;
      const {collaborationAdmissionLockKey}=await import('../app/lib/collaboration/room-admission-contract');
      const key=BigInt.asUintN(64,BigInt(collaborationAdmissionLockKey(workspaceId)));
      await assert.rejects(invoke(job,async()=>{
        const rows=(await admin.query(`SELECT DISTINCT a.pid,a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock' AND l.objsubid=1
            AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.classid::bigint=$1 AND l.objid::bigint=$2`,
        [Number(key>>BigInt(32)),Number(key&BigInt('0xffffffff'))])).rows;
        assert.equal(rows.length,1);assert.equal(rows[0].application_name,`owned-move-owner-${nonce}`);
        terminated=(await admin.query('SELECT pg_terminate_backend($1) AS terminated',[rows[0].pid])).rows[0].terminated===true;assert(terminated);
      }));assert(terminated);
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_move_receipts WHERE batch_id=$1',[job.claimed.batchId])).rows[0].n,0);
      assert.equal(await readFile(path.join(workspace.rootPath,destination),'utf8'),'lost-real-B');const resumed=await resume(job);await invoke(resumed);
    });
    await check('regular Executor, immutable RR status and public response survive legitimate later native edits and D2/S2',async()=>{
      const name=`regular-${crypto.randomUUID()}.md`,destination=`regular-dest/${name}`;
      const target=await seedNative(name,'Original regular native\n'),peer=await seedNative(`regular-peer-${crypto.randomUUID()}.md`,`[Original](${name})\n`);
      await seedMetadata(name);const job=await freshJob([{sourcePath:name,destinationPath:destination}]);
      const {executeWorkspaceOperationBatch,getWorkspaceOperationBatchExecution,getWorkspaceOperationBatchExecutionPublic}=await import('../app/lib/files/workspace-operation-batch-executor');
      const {workspacePathOperationResponse}=await import('../app/lib/files/workspace-path-operation-response');
      const {readWorkspaceOperationNativeMoveBatchStatus}=await import('../app/lib/files/workspace-operation-native-move-status');
      const {loadCollaborationState,persistCollaborationYDoc}=await import('../app/lib/collaboration/persistence');
      let finished:NonNullable<Awaited<ReturnType<typeof store.finishClaim>>>|undefined;
      await store.withClaim(job.claimed,async claim=>{
        const scope={workspace:job.workspace,fileOptions:{workspace:job.workspace}},input={batchId:job.claimed.batchId,plan:job.plan,scope,
          actorUserId:'member',actorDisplayName:'Actual regular actor',jobClaim:claim};
        const first=await executeWorkspaceOperationBatch(input);assert.equal(first.status,'applied');assert.equal(first.completedActions,first.totalActions);
        const state=await loadCollaborationState(target.documentId);assert(state);const doc=new Y.Doc();
        try {Y.applyUpdate(doc,state.yjsState);doc.getText('content').insert(doc.getText('content').length,'Later legitimate text\n');
          const persisted=await persistCollaborationYDoc(target.documentId,state.lifecycleGeneration,doc,{workspaceId,organizationId,path:destination,representation:'plain_text',schemaVersion:1});
          assert.equal(persisted.persistenceDisposition,'advanced');
        }finally{doc.destroy();}
        await admin.query('UPDATE workspace_file_metadata SET title=$3,updated_at=updated_at+1 WHERE workspace_id=$1 AND path=$2',[workspaceId,destination,'Later metadata']);
        const replacement=await seedNative(name,'Later D2 stays here\n');await seedMetadata(name);
        const repeated=await executeWorkspaceOperationBatch(input);assert.deepEqual(repeated,first);
        assert.equal(await nativePath(replacement.documentId),name);assert.equal(await nativeContent(replacement.documentId),'Later D2 stays here\n');
        assert((await nativeContent(target.documentId)).includes('Later legitimate text'));assert.equal((await metadata(destination))[0].title,'Later metadata');
        finished=await store.finishClaim(job.claimed,{status:'applied',completedActions:first.completedActions,phase:'complete'})??undefined;assert(finished);
        assert((await nativeContent(peer.documentId)).includes(destination));
      });
      assert(finished);const current=await currentWorkspace(),scope={workspace:current,fileOptions:{workspace:current}};
      const status=await readWorkspaceOperationNativeMoveBatchStatus({batchId:job.claimed.batchId,scope});assert(status);assert.equal(status.observation.apply,'complete');
      const execution=await getWorkspaceOperationBatchExecution({batchId:job.claimed.batchId,scope});assert(execution);assert.equal(execution.status,'applied');
      assert.equal(execution.completedActions,execution.totalActions);
      const presentation=await getWorkspaceOperationBatchExecutionPublic({batchId:job.claimed.batchId,scope,plan:job.plan,actionMode:'apply',status:'applied',
        completedActions:finished.completedActions,phase:finished.phase});assert(presentation);assert.equal(presentation.receiptStatus,'available');assert.equal(presentation.finalization,'complete');
      const response=await workspacePathOperationResponse(finished,scope);assert.equal(response.operation.status,'applied');assert.equal(response.linkStatus,'complete');
      assert(response.linkUpdates?.updatedFiles.includes(peer.filename));assert.equal(response.mutation?.newPath,destination);
      const {createWorkspaceOperationOriginalMoveAdmissionRequest}=await import('../app/lib/files/workspace-operation-original-move-admission');
      const {readWorkspaceOperationOriginalMoveNativeBundle}=await import('../app/lib/files/workspace-operation-original-move');
      const {captureCollaborationAdmissionRequest}=await import('../app/lib/collaboration/room-admission-contract');
      const {readHistoricalCollaborationAdmissionOutcomeOnConnection}=await import('../app/lib/collaboration/room-admission-outcome');
      const {readHistoricalNativeFileOperationReceiptOnConnection}=await import('../app/lib/markdown/native-file-operation-handoff');
      const {readHistoricalNativeFileOperationSideEffectsOnConnection}=await import('../app/lib/markdown/native-file-operation-side-effects');
      const intent=status.observation.intent!;assert(job.claimed.authorization.mode==='direct');
      const context={batchId:job.claimed.batchId,requestHash:job.claimed.authorization.requestHash,actor:{userId:'member',actorId:'member',actorType:'user' as const,actorSessionId:null},plan:job.plan};
      const request=createWorkspaceOperationOriginalMoveAdmissionRequest(context,intent),bundle=readWorkspaceOperationOriginalMoveNativeBundle(intent);assert(bundle);
      const connection=await database.openDb(),queries:string[]=[];
      const traced:SqlConnection={get:(sql,values)=>{queries.push(sql);return connection.get(sql,values);},all:(sql,values)=>{queries.push(sql);return connection.all(sql,values);},run:()=>{throw new Error('Historical reader must not run mutation SQL.');},close:()=>{throw new Error('Historical reader must not close B.');}};
      try {await connection.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        assert.equal((await connection.get('SELECT pg_current_xact_id_if_assigned()::text AS xid') as {xid:null}).xid,null);
        assert(await readHistoricalCollaborationAdmissionOutcomeOnConnection(traced,captureCollaborationAdmissionRequest(request),{readOnly:true}));
        for(const mutation of bundle.mutations)assert(await readHistoricalNativeFileOperationReceiptOnConnection(traced,{request,operationId:bundle.operationId,mutationId:mutation.mutationId,readOnly:true}));
        assert(await readHistoricalNativeFileOperationSideEffectsOnConnection(traced,{request,operationId:bundle.operationId,actor:bundle.actor,readOnly:true}));
        assert.equal((await connection.get('SELECT pg_current_xact_id_if_assigned()::text AS xid') as {xid:null}).xid,null);
        assert(queries.every(sql=>!/(?:FOR\s+(?:SHARE|UPDATE)|pg_current_xact_id\s*\()/iu.test(sql)));
        assert(queries.every(sql=>!/(?:FROM|JOIN)\s+(?:"[^"]+"\.)?"?collaboration_yjs_states"?\b/iu.test(sql)));
        await connection.run('COMMIT');
      }catch(error){await connection.run('ROLLBACK');throw error;}finally{await connection.close();}
      const shadow=`owned_move_shadow_${crypto.randomUUID().replaceAll('-','')}`,shadowNonce=crypto.randomUUID();
      assert.match(shadow,/^owned_move_shadow_[a-f0-9]{32}$/u);let shadowOid=0,shadowCreated=false;
      const actualPool=runtime as unknown as Pool,priorConnect=Object.getOwnPropertyDescriptor(actualPool,'connect'),originalConnect=actualPool.connect.bind(actualPool);
      type ConnectCallback=(error:Error|undefined,client?:PoolClient,release?:(error?:Error)=>void)=>void;
      try {
        await admin.query(`CREATE SCHEMA "${shadow}"`);shadowCreated=true;await admin.query(`COMMENT ON SCHEMA "${shadow}" IS '${shadowNonce}'`);
        shadowOid=Number((await admin.query('SELECT oid FROM pg_namespace WHERE nspname=$1',[shadow])).rows[0].oid);
        for(const table of ['collaboration_admission_requests','collaboration_admission_scopes','collaboration_admission_targets',
          'collaboration_native_file_operation_intents','collaboration_native_file_operation_receipts','collaboration_native_file_operation_side_effect_stages','collaboration_native_file_operation_side_effect_receipts']) {
          await admin.query(`CREATE TABLE "${shadow}"."${table}" AS TABLE "${schema}"."${table}"`);
        }
        // Configure the actual backend returned by the actual runtime pool;
        // no SQL result, actor, claim, transaction or connection is mocked.
        const prepare=async(client:PoolClient)=>{await client.query(`SET search_path="${shadow}","${schema}",pg_catalog`);return client;};
        Object.defineProperty(actualPool,'connect',{configurable:true,writable:true,value:(callback?:ConnectCallback)=>{
          if(callback){originalConnect((error,client,release)=>{
            if(error||!client){callback(error??new Error('Actual fixture checkout missing.'));return;}
            void prepare(client).then(()=>callback(undefined,client,release),failure=>{release(failure as Error);callback(failure as Error);});
          });return;}
          return originalConnect().then(prepare);
        }});
        await assert.rejects(readWorkspaceOperationNativeMoveBatchStatus({batchId:job.claimed.batchId,scope}),error=>code(error)==='BATCH_SCOPE_CHANGED');
      }finally{
        if(priorConnect)Object.defineProperty(actualPool,'connect',priorConnect);else Reflect.deleteProperty(actualPool,'connect');
        if(shadowCreated){const row=(await admin.query(`SELECT oid,obj_description(oid,'pg_namespace') AS nonce,nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_namespace WHERE nspname=$1`,[shadow])).rows[0];
          assert(row);assert.equal(Number(row.oid),shadowOid);assert.equal(row.nonce,shadowNonce);assert.equal(row.owner,true);
          await admin.query(`DROP SCHEMA "${shadow}" CASCADE`);assert.equal((await admin.query('SELECT to_regnamespace($1) IS NULL AS absent',[shadow])).rows[0].absent,true);
        }
      }
    });
    assert.equal(passed,13);assert.equal(fetches,0);await own();assert.equal(await sourceHash(),pinned);
    for(const [filename,hash] of sourcePins)assert.equal(sha(await readFile(filename)),hash,`Source changed during original Move fixture: ${filename}`);
    console.log('Original Move genuine owner assertions finished:',JSON.stringify({passed,sourcePins,fetches}));
  } catch(error) {failures.push(error);}
  finally {
    const cleanup=async(operation:()=>Promise<unknown>)=>{try{await operation();}catch(error){failures.push(error);}};
    for(const connection of checkouts)await cleanup(async()=>{checkouts.delete(connection);await connection.close(new Error('Discarding original Move fixture checkout.'));});
    if(pool)await cleanup(()=>pool!.end());for(const client of clients)await cleanup(()=>endClient(client));
    if(connected)await cleanup(async()=>{const remaining=(await control.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[`owned-move-owner-${nonce}`])).rows;assert.deepEqual(remaining,[]);});
    if(created&&clients.size===0)await cleanup(async()=>{
      const row=(await control.query(`SELECT oid,obj_description(oid,'pg_namespace') AS nonce,nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_namespace WHERE nspname=$1`,[schema])).rows[0];
      assert(row);assert.equal(Number(row.oid),schemaOid);assert.equal(row.nonce,nonce);assert.equal(row.owner,true);
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);schemaRemoved=(await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed===true;assert(schemaRemoved);
    });
    if(connected)await cleanup(()=>control.end());
    await cleanup(async()=>{const now=await stat(dataRoot);assert.equal(now.dev,dataIdentity.dev);assert.equal(now.ino,dataIdentity.ino);assert.equal(now.uid,dataIdentity.uid);
      await rm(dataRoot,{recursive:true});assert(await absent(dataRoot));dataRemoved=true;});
    globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);
    await cleanup(async()=>{assert.equal(await sourceHash(),pinned);});
    console.log('Original Move fixture actual closure:',JSON.stringify({schema,schemaOid,schemaRemoved,dataRemoved,openClients:clients.size,openCheckouts:checkouts.size,passed}));
  }
  if(failures.length)throw new Error(`Original Move fixture failed: ${stage}; details=${JSON.stringify(failures.slice(0,4).map(error=>describeFailure(error)))}`);
  assert(schemaRemoved);assert(dataRemoved);
}
void runSqlFixture({label:'workspace-operation-original-move-owner-postgres-test',operation:main,
  successMessage:'Original Move genuine PG18 owner/runner evidence and owned resource closure passed; no UI or host-crash claim.'});
