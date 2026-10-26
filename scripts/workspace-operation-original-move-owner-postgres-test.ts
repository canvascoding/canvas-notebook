import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { types } from 'node:util';
import { parse } from 'dotenv';
import { Client, type Pool, type PoolClient } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { runPgliteFixture as runSqlFixture } from './helpers/pglite-pool-harness';
import { measureDocumentOperation, withDocumentOperationMetricObserver,
  type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';

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

// Diagnostics observe genuine Promise queries and return the exact original
// result. Callback/Query-object modes remain untouched and are counted as
// unobserved, rather than changing callback or EventEmitter error semantics.
function installOwnedMoveQueryProfile(pool:Pool) {
  type Metric={shape:string;operation:string;tables:string[];count:number;settled:number;unobserved:number;errors:number;sumMs:number;maxMs:number};
  type Span={startedAt:number;lastAt:number;count:number;settled:number;unobserved:number;errors:number;sumMs:number;maxMs:number;shapes:Map<string,Metric>};
  type Transaction=Span&{backendPid:number;ordinal:number;status:'open'|'committed'|'rolled_back'|'error';errorCode?:string};
  type Case=Span&{label:string;transactions:Transaction[];omittedTransactions:number};
  const observed=new Map<PoolClient,PropertyDescriptor|undefined>();
  const activeTransactions=new Map<PoolClient,Transaction>();
  const ordinals=new Map<PoolClient,number>();
  const shapeCache=new Map<string,{shape:string;operation:string;tables:string[]}>();
  const safeTables=new Set(['pg_locks','pg_stat_activity','pg_namespace','pg_roles','canvas_workspaces','canvas_organization_settings',
    'organization_user_permissions','team_memberships','team_membership_sync_state','agents','agent_members','agent_grants','pi_sessions',
    'collaboration_documents','collaboration_yjs_states','collaboration_file_projections','file_collaboration_lineages','file_revisions',
    'collaboration_admission_requests','collaboration_admission_targets','workspace_file_metadata','workspace_file_user_states',
    'workspace_file_operation_batches','workspace_file_operation_move_preparations','workspace_file_operation_move_intents',
    'workspace_file_operation_move_path_receipts','workspace_file_operation_move_receipts','workspace_file_operation_native_mutations']);
  const createSpan=():Span=>({startedAt:performance.now(),lastAt:performance.now(),count:0,settled:0,unobserved:0,errors:0,sumMs:0,maxMs:0,shapes:new Map()});
  let current:Case|undefined;
  const shapeFor=(args:unknown[])=>{
    const first=args[0];let sql:string|undefined;
    if(typeof first==='string')sql=first;
    else if(first&&typeof first==='object'&&!types.isProxy(first)){
      const descriptor=Object.getOwnPropertyDescriptor(first,'text');if(descriptor&&'value' in descriptor&&typeof descriptor.value==='string')sql=descriptor.value;
    }
    if(sql===undefined)return{shape:'unknown',operation:'OTHER',tables:[] as string[]};
    const cached=shapeCache.get(sql);if(cached)return cached;
    const canonical=sql.replace(/\/\*[\s\S]*?\*\//gu,' ').replace(/--[^\r\n]*/gu,' ')
      .replace(/'(?:''|[^'])*'/gu,'?').replace(/\b\d+\b/gu,'?').replace(/\s+/gu,' ').trim();
    const operation=/^(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SET|WITH|SAVEPOINT|RELEASE)\b/iu.exec(canonical)?.[1].toUpperCase()??'OTHER';
    const tables=[...new Set([...canonical.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+"?([a-z_][a-z0-9_]*)"?/giu)]
      .map(match=>match[1].toLowerCase()).filter(table=>safeTables.has(table)))].slice(0,8).sort();
    const shape={shape:sha(canonical).slice(0,16),operation,tables};if(shapeCache.size<256)shapeCache.set(sql,shape);return shape;
  };
  const metricFor=(span:Span,shape:ReturnType<typeof shapeFor>)=>{
    const key=span.shapes.has(shape.shape)||span.shapes.size<128?shape.shape:'overflow';let metric=span.shapes.get(key);
    if(!metric){metric={...(key==='overflow'?{shape:'overflow',operation:'OTHER',tables:[]}:shape),count:0,settled:0,unobserved:0,errors:0,sumMs:0,maxMs:0};span.shapes.set(key,metric);}
    return metric;
  };
  const onClient=(client:PoolClient)=>{
    if(observed.has(client))return;
    observed.set(client,Object.getOwnPropertyDescriptor(client,'query'));const original=client.query;
    Object.defineProperty(client,'query',{configurable:true,writable:true,value:(...args:unknown[])=>{
      const sample=current;if(!sample)return Reflect.apply(original,client,args);
      const shape=shapeFor(args),startedAt=performance.now();let transaction=activeTransactions.get(client);
      if(shape.operation==='BEGIN'){
        const ordinal=(ordinals.get(client)??0)+1;ordinals.set(client,ordinal);
        if(sample.transactions.length<64){
          transaction={...createSpan(),startedAt,lastAt:startedAt,backendPid:Number(Reflect.get(client,'processID')),ordinal,status:'open'};
          sample.transactions.push(transaction);activeTransactions.set(client,transaction);
        }else{sample.omittedTransactions++;transaction=undefined;activeTransactions.delete(client);}
      }
      const targets=[sample,...(transaction?[transaction]:[])].map(span=>({span,metric:metricFor(span,shape)}));
      for(const {span,metric} of targets){span.count++;metric.count++;}
      let recorded=false;
      const finish=(error?:unknown,unobserved=false)=>{
        if(recorded)return;recorded=true;const now=performance.now(),elapsed=now-startedAt;
        for(const {span,metric} of targets){span.lastAt=now;if(unobserved){span.unobserved++;metric.unobserved++;continue;}
          span.settled++;metric.settled++;span.sumMs+=elapsed;metric.sumMs+=elapsed;span.maxMs=Math.max(span.maxMs,elapsed);metric.maxMs=Math.max(metric.maxMs,elapsed);
          if(error!==undefined){span.errors++;metric.errors++;}}
        if(transaction&&error!==undefined){transaction.status='error';const failureCode=code(error);if(typeof failureCode==='string'&&/^[A-Za-z0-9_]{1,40}$/u.test(failureCode))transaction.errorCode=failureCode;}
        if(transaction&&['COMMIT','ROLLBACK'].includes(shape.operation)){
          if(error===undefined)transaction.status=shape.operation==='COMMIT'?'committed':'rolled_back';activeTransactions.delete(client);
        }
      };
      try{
        const result=Reflect.apply(original,client,args);
        if(result instanceof Promise){void result.then(()=>finish(),error=>finish(error));}else finish(undefined,true);
        return result;
      }catch(error){finish(error);throw error;}
    }});
  };
  const round=(value:number)=>Math.round(value*100)/100;
  const summarize=(span:Span)=>{
    const metrics=[...span.shapes.values()].map(metric=>({...metric,sumMs:round(metric.sumMs),maxMs:round(metric.maxMs)}));
    const wallMs=span.lastAt-span.startedAt;
    return{queries:span.count,settled:span.settled,unobserved:span.unobserved,errors:span.errors,wallMs:round(wallMs),queryMs:round(span.sumMs),
      nonQueryWallMs:round(Math.max(0,wallMs-span.sumMs)),maxQueryMs:round(span.maxMs),
      topCount:metrics.toSorted((a,b)=>b.count-a.count||b.sumMs-a.sumMs).slice(0,8),topTime:metrics.toSorted((a,b)=>b.sumMs-a.sumMs||b.count-a.count).slice(0,8)};
  };
  pool.on('connect',onClient);pool.on('acquire',onClient);
  return{
    beginCase(label:string){assert.equal(current,undefined);current={...createSpan(),label,transactions:[],omittedTransactions:0};},
    endCase(failed:boolean){
      const sample=current;if(!sample)return;sample.lastAt=performance.now();current=undefined;
      console.log('Original Move actual query profile:',JSON.stringify({label:sample.label,failed,...summarize(sample),
        transactionCount:sample.transactions.length,omittedTransactions:sample.omittedTransactions,
        transactions:sample.transactions.toSorted((a,b)=>(b.lastAt-b.startedAt)-(a.lastAt-a.startedAt)).slice(0,12).map(transaction=>({
          backendPid:transaction.backendPid,ordinal:transaction.ordinal,startedAfterMs:round(transaction.startedAt-sample.startedAt),
          status:transaction.status,...(transaction.errorCode?{errorCode:transaction.errorCode}:{}),...summarize(transaction)}))}));
      for(const [client,transaction] of activeTransactions)if(sample.transactions.includes(transaction))activeTransactions.delete(client);
    },
    close(){pool.off('connect',onClient);pool.off('acquire',onClient);
      for(const [client,descriptor] of observed){if(descriptor)Object.defineProperty(client,'query',descriptor);else Reflect.deleteProperty(client,'query');}
      observed.clear();activeTransactions.clear();ordinals.clear();shapeCache.clear();}
  };
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
  let queryProfile:ReturnType<typeof installOwnedMoveQueryProfile>|undefined;
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
    queryProfile=installOwnedMoveQueryProfile(runtime as unknown as Pool);
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
    const { createWorkspaceOperationNativeMoveBatchPlan, createWorkspaceOperationNativeMoveBatchPlanV4 } = await import('../app/lib/files/workspace-operation-native-move-plan');
    const { executeWorkspaceOperationOriginalMove: execute } = await import('../app/lib/files/workspace-operation-original-move-runner');
    const ownerApi = await import('../app/lib/files/workspace-operation-job-lifecycle-owner');
    const { waitForWorkspaceOperationNativePathAdmission } = await import('../app/lib/files/workspace-operation-native-path-admission');
    const { withWorkspaceOperationJobClaimScheduling } = await import('../app/lib/files/workspace-operation-job-phase-scheduling');
    const { WorkspaceRequestPrincipalError } = await import('../app/lib/workspaces/request-principal');
    const pins = ['app/lib/files/workspace-operation-job-lifecycle-owner.ts','app/lib/files/workspace-operation-original-move-storage.ts',
      'app/lib/files/workspace-operation-original-move-handoff-storage.ts','app/lib/files/workspace-operation-original-move-runner.ts',
      'app/lib/files/workspace-operation-original-move.ts','app/lib/files/workspace-operation-original-move-sources.ts',
      'app/lib/files/workspace-operation-original-move-namespace-effects.ts','app/lib/filesystem/prepared-workspace-path-move.ts',
      'app/lib/filesystem/prepared-workspace-path-move-contract.ts','scripts/workspace-operation-original-move-owner-postgres-test.ts',
      'app/lib/markdown/native-file-operation-handoff.ts','app/lib/markdown/native-file-operation-side-effects.ts',
      'app/lib/collaboration/room-admission-outcome.ts','app/lib/files/workspace-operation-original-move-admission.ts',
      'app/lib/files/workspace-operation-native-move-status.ts','app/lib/files/workspace-operation-native-read-context.ts',
      'app/lib/files/workspace-operation-batch-executor.ts','app/lib/files/workspace-operation-native-move-execution-public.ts',
      'app/lib/files/workspace-path-operation-response.ts',
      'app/lib/files/workspace-operation-native-move-plan.ts','app/lib/files/workspace-operation-mixed-source-evidence-v5.ts',
      'app/lib/files/workspace-operation-html-link-assessment.ts','app/lib/files/workspace-operation-path-source-parser.ts',
      'app/lib/markdown/workspace-native-file-operation-planner.ts','app/lib/markdown/workspace-native-mixed-batch-compiler.ts',
      'app/lib/markdown/workspace-native-link-graph.ts','app/lib/markdown/workspace-link-contract-v5.ts',
      'app/lib/markdown/workspace-native-link-mutations.ts','app/lib/markdown/native-link-mutation-persistence.ts',
      'app/api/files/upload/route.ts','app/lib/files/workspace-upload-flow.ts','app/lib/filesystem/workspace-files.ts',
      'app/lib/files/collaboration-policy.ts','app/lib/files/collaboration-repository/document-repository.ts',
      'app/lib/files/collaboration-repository/lineage-revision-repository.ts','app/lib/file-version-center/history-service.ts',
      'app/lib/collaboration/workspace-document-catalogue.ts','app/lib/collaboration/markdown-file-import-persistence.ts',
      'app/lib/files/workspace-operation-native-path-admission.ts','app/lib/files/workspace-operation-job-phase-scheduling.ts',
      'app/lib/workspaces/request-principal.ts'];
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
    // New cases explicitly choose collector3 + saved identity4/E5. Historical
    // factories and the thirteen original owner assertions retain their profile.
    const readHtmlPlanInput=async(selections:Array<{sourcePath:string;destinationPath:string}>)=>{
      const current=await currentWorkspace(),connection=await database.openDb();let observation;
      try{observation=await readWorkspaceLinkSourceAuthorityOnConnection(connection,current,{physicalParserVersion:3});}
      finally{await connection.close();}
      return {scope:{workspace:current,fileOptions:{workspace:current}},
        actions:[{reviewId:crypto.randomUUID(),kind:'move' as const,selections}],observation};
    };
    const freshHtmlJob=async(selections:Array<{sourcePath:string;destinationPath:string}>)=>{
      const input=await readHtmlPlanInput(selections),plan=createWorkspaceOperationNativeMoveBatchPlanV4(input);
      assert.equal(plan.version,3);assert.equal(plan.planIdentityVersion,4);assert.equal(plan.sourceEvidence.evidenceVersion,5);
      assert.equal(plan.nativePathPlan.contractVersion,5);assert.equal(plan.readiness,'ready');assert.equal(plan.executionReady,false);
      assert.equal(plan.nativePathPlan.htmlAssessment.complete,true);assert.equal(plan.sourceEvidence.coverage.complete,false);
      assert.deepEqual(plan.nativePathPlan.sourceCoverage[0].coverage.gaps.slice(0,plan.sourceEvidence.coverage.gaps.length),plan.sourceEvidence.coverage.gaps);
      const created=await store.createDirect({batchId:crypto.randomUUID(),plan,authorization:{mode:'direct',actorUserId:'member',actorId:'member',actorType:'user',
        actorDisplayName:'Actual HTML Move fixture actor',requestHash:sha(crypto.randomUUID()),jobScope:captureWorkspaceOperationJobScope(input.scope.workspace)}});
      const claimed=await store.claim(crypto.randomUUID());assert(claimed);assert.equal(claimed.batchId,created.batchId);
      return {claimed,plan,workspace:input.scope.workspace};
    };
    type Job=Awaited<ReturnType<typeof freshJob>>|Awaited<ReturnType<typeof freshHtmlJob>>;
    const invoke=async(job:Job,onPathCommitted?:(count:number)=>Promise<void>,afterCompleted?:(claim:Parameters<typeof execute>[0]['claim'],completion:Awaited<ReturnType<typeof execute>>)=>Promise<void>)=>store.withClaim(job.claimed,async claim=>{
      const result=await execute({claim,workspace:job.workspace,onPathCommitted});await afterCompleted?.(claim,result);
      assert(await store.finishClaim(job.claimed,{status:'applied',completedActions:job.claimed.totalActions,phase:'complete'}));return result;});
    const abort=async(job:Job)=>{assert(await store.finishClaim(job.claimed,{status:'failed',errorCode:'FIXTURE_EXPECTED_REJECTION',phase:'failed'}));};
    const resume=async(job:Job)=>{
      assert(await store.finishClaim(job.claimed,{status:'needs_recovery',errorCode:'FIXTURE_MOVE_INTERRUPTED',phase:'recovery'}));
      await store.enqueue({batchId:job.claimed.batchId,planId:job.claimed.planId,userId:'member',displayName:'Actual original actor',action:'resume'});
      const claimed=await store.claim(crypto.randomUUID());assert(claimed);assert.equal(claimed.batchId,job.claimed.batchId);return {...job,claimed};
    };
    const check=async(label:string,operation:()=>Promise<void>)=>{
      stage=label;queryProfile!.beginCase(label);let failed=true;
      const measurements:DocumentOperationMeasurement[]=[];
      try{
        await withDocumentOperationMetricObserver(value=>{measurements.push(value);},
          ()=>measureDocumentOperation('move','request',async()=>{await own();await operation();await own();}));
        assert.equal(measurements.length,1);const measurement=measurements[0];assert.equal(measurement.outcome,'succeeded');
        assert.equal(measurement.unsupportedQueryForms,0);assert.equal(measurement.openQueriesAtCompletion,0);
        assert.equal(measurement.openConnectionsAtCompletion,0);
        assert.equal(measurement.queryGroups.reduce((sum,group)=>sum+group.statements,0),measurement.statements);
        console.log('Original Move common operation measurement:',JSON.stringify({label,measurement}));
        passed++;failed=false;console.log('Original Move owner case passed:',label);
      }
      finally{queryProfile!.endCase(failed);}
    };
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
      const dataBefore=await originalDataFacts(),physicalBefore=await workspacePhysicalFacts();
      const foreignBefore=(await admin.query('SELECT to_jsonb(r)::text AS row FROM collaboration_admission_requests r WHERE request_id=$1',[requestId])).rows;
      // The existing P0 gate rejects a different live reservation before any
      // original Owner work. Preserve that precise Busy contract and prove it
      // neither adopts the foreign request nor mutates document/physical data.
      try {await assert.rejects(invoke(job),error=>code(error)==='COLLABORATION_FILE_LIFECYCLE_BUSY');
        assert.deepEqual(await originalDataFacts(),dataBefore);assert.deepEqual(await workspacePhysicalFacts(),physicalBefore);
        assert.deepEqual((await admin.query('SELECT to_jsonb(r)::text AS row FROM collaboration_admission_requests r WHERE request_id=$1',[requestId])).rows,foreignBefore);
        assert.equal(await readFile(path.join(workspace.rootPath,name),'utf8'),'foreign-guard');assert(await absent(path.join(workspace.rootPath,destination)));
        assert.equal((await admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_move_intents WHERE batch_id=$1',[job.claimed.batchId])).rows[0].n,0);
      }finally{await admin.query("UPDATE collaboration_admission_targets SET active=false,status='cancelled' WHERE request_id=$1",[requestId]);
        await admin.query("UPDATE collaboration_admission_requests SET status='cancelled' WHERE request_id=$1",[requestId]);}
      await abort(job);
    });
    await check('caught forged capability poisons the actual enclosing owner and closes B',async()=>{
      const name=`poison-${crypto.randomUUID()}.pdf`,destination=`poison-dest/${name}`;await writeFile(path.join(workspace.rootPath,name),'must-stay',{mode:0o600});
      const job=await freshJob([{sourcePath:name,destinationPath:destination}]);
      let reached=false;
      await assert.rejects(store.withClaim(job.claimed,async claim=>{
        await waitForWorkspaceOperationNativePathAdmission(claim);
        return ownerApi.withWorkspaceOperationNativeMoveJobOwner(claim,async owner=>{
        reached=true;
        await assert.rejects(ownerApi.readWorkspaceOperationOriginalMoveJobReceipts({} as typeof owner),error=>code(error)==='JOB_LIFECYCLE_REQUIRED');
        await ownerApi.readWorkspaceOperationOriginalMoveJobReceipts(owner);
      });}),error=>code(error)==='JOB_LIFECYCLE_REQUIRED');assert(reached,'The genuine reserved owner must reach the forged-capability probe');
      assert.equal(await readFile(path.join(workspace.rootPath,name),'utf8'),'must-stay');assert(await absent(path.join(workspace.rootPath,destination)));
      const recovered=await resume(job);await invoke(recovered);
      assert.equal(await readFile(path.join(workspace.rootPath,destination),'utf8'),'must-stay');
    });
    await check('detached fixed operation poisons, drains and closes the actual owner',async()=>{
      const name=`detached-${crypto.randomUUID()}.pdf`,destination=`detached-dest/${name}`;await writeFile(path.join(workspace.rootPath,name),'must-drain',{mode:0o600});
      const job=await freshJob([{sourcePath:name,destinationPath:destination}]);
      let reached=false;
      await assert.rejects(store.withClaim(job.claimed,async claim=>{
        await waitForWorkspaceOperationNativePathAdmission(claim);
        return ownerApi.withWorkspaceOperationNativeMoveJobOwner(claim,async owner=>{
        reached=true;
        void ownerApi.readWorkspaceOperationOriginalMoveJobReceipts(owner).catch(()=>undefined);
      });}),error=>code(error)==='JOB_LIFECYCLE_DETACHED');assert(reached,'The genuine reserved owner must reach the detached-operation probe');
      assert.equal(await readFile(path.join(workspace.rootPath,name),'utf8'),'must-drain');assert(await absent(path.join(workspace.rootPath,destination)));
      const recovered=await resume(job);await invoke(recovered);
      assert.equal(await readFile(path.join(workspace.rootPath,destination),'utf8'),'must-drain');
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
    // These are real FS and SQL observations under this fixture's owned schema,
    // not injected catalogue facts or substitutes for the production owner.
    const physicalFacts=async(filename:string)=>{
      const absolute=path.join(workspace.rootPath,filename),identity=await stat(absolute);
      assert(identity.isFile());
      return {device:String(identity.dev),inode:String(identity.ino),mode:identity.mode,size:identity.size,
        mtimeMs:identity.mtimeMs,ctimeMs:identity.ctimeMs,hash:sha(await readFile(absolute))};
    };
    async function workspacePhysicalFacts(){
      const rows:Array<{path:string;kind:'file'|'directory';device:string;inode:string;mode:number;size:number;mtimeMs:number;ctimeMs:number;hash?:string}>=[];
      const visit=async(relative:string):Promise<void>=>{
        const absolute=path.join(workspace.rootPath,relative),identity=await stat(absolute);
        assert(identity.isDirectory()||identity.isFile());assert(rows.length<10000);
        rows.push({path:relative,kind:identity.isDirectory()?'directory':'file',device:String(identity.dev),inode:String(identity.ino),
          mode:identity.mode,size:identity.size,mtimeMs:identity.mtimeMs,ctimeMs:identity.ctimeMs,
          ...(identity.isFile()?{hash:sha(await readFile(absolute))}:{})});
        if(identity.isDirectory())for(const entry of (await readdir(absolute)).sort())await visit(relative?`${relative}/${entry}`:entry);
      };
      await visit('');return rows;
    }
    async function originalDataFacts(){
      const tables=['collaboration_documents','file_collaboration_lineages','collaboration_yjs_states','collaboration_file_projections',
        'workspace_file_metadata','workspace_file_user_states','workspace_file_operation_move_intents','workspace_file_operation_move_parent_receipts',
        'workspace_file_operation_move_path_receipts','workspace_file_operation_move_receipts','collaboration_native_file_operation_intents',
        'collaboration_native_file_operation_receipts','collaboration_native_file_operation_side_effect_stages',
        'collaboration_native_file_operation_side_effect_receipts','collaboration_native_link_mutation_receipts'] as const;
      const rows:Record<string,string[]>={};
      for(const table of tables)rows[table]=(await admin.query(`SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows.map(row=>row.row);
      return rows;
    }
    // Arm the independent reader at the real session-EX query, after the
    // ordinary runner has completed P0/admission. Every SQL call below is
    // forwarded to the actual PoolClient; no result or owner is substituted.
    type AdmissionLockRow={pid:number;start:string;mode:string;granted:boolean;application_name:string;
      wait_event_type:string|null;blockers:number[];query_age_ms:string};
    const {collaborationAdmissionLockKey}=await import('../app/lib/collaboration/room-admission-contract');
    const admissionKey=collaborationAdmissionLockKey(workspaceId),unsignedKey=BigInt.asUintN(64,BigInt(admissionKey));
    const keyParts=[Number(unsignedKey>>BigInt(32)),Number(unsignedKey&BigInt('0xffffffff'))];
    const lockRows=async():Promise<AdmissionLockRow[]>=>{
      await admin.query('SELECT pg_stat_clear_snapshot()');
      return (await admin.query(`SELECT l.pid,extract(epoch FROM a.backend_start)::text AS start,l.mode,l.granted,
        a.application_name,a.wait_event_type,pg_blocking_pids(l.pid) AS blockers,
        (extract(epoch FROM (clock_timestamp()-a.query_start))*1000)::text AS query_age_ms
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=1 ORDER BY l.pid,l.mode`,keyParts)).rows;
    };
    const bounded=async<T>(promise:Promise<T>,milliseconds:number,label:string):Promise<T>=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error(`${label} exceeded its observation deadline.`)),milliseconds);
      })]);}finally{if(timer)clearTimeout(timer);}
    };
    for(const mode of ['short-shared-reader','bounded-shared-reader'] as const)await check(`original Move ${mode} uses one genuine keyed session acquisition`,async()=>{
      const name=`move-admission-${mode}-${crypto.randomUUID()}.pdf`,destination=`move-admission-${mode}/${name}`;
      const bytes=Buffer.from(`%PDF-1.7\n${mode} original bytes\n`);
      await writeFile(path.join(workspace.rootPath,name),bytes,{flag:'wx',mode:0o600});await seedMetadata(name);
      const peer=await seedNative(`move-admission-peer-${crypto.randomUUID()}.md`,`[PDF](${name})\n`),job=await freshJob([{sourcePath:name,destinationPath:destination}]);
      assert.equal(job.plan.planIdentityVersion,2);
      const actualPool=runtime as unknown as Pool,observed=new Map<PoolClient,PropertyDescriptor|undefined>();
      const holder=await ownClient();assert.notEqual(holder,admin);
      type Settled={value:Awaited<ReturnType<typeof execute>>}|{error:unknown};
      let pending:Promise<Settled>|undefined,settled:Settled|undefined,holderActive=false,holderPid=0,holderStart='';
      let ownerPid=0,ownerStart='',armCount=0,pathCallbacks=0,waitStartedAt=0;
      let sessionSqlOutcome:{status:'returned';locked:unknown}|{status:'rejected';code:unknown}|undefined;
      let beforeRows:Awaited<ReturnType<typeof originalDataFacts>>|undefined,beforeFs:Awaited<ReturnType<typeof workspacePhysicalFacts>>|undefined;
      let originalPreparation:Array<{preparation_digest:string;preparation_text:string}>|undefined;
      let signalArmed!:()=>void;const armed=new Promise<void>(resolve=>{signalArmed=resolve;});
      const release=async()=>{
        if(!holderActive)return;
        await holder.query('ROLLBACK');holderActive=false;
        assert.equal((await lockRows()).some(row=>row.pid===holderPid&&row.start===holderStart&&row.mode==='ShareLock'&&row.granted),false);
      };
      const arm=async(client:PoolClient)=>{
        assert.equal(armCount,0);armCount++;
        const actualPid=Reflect.get(client,'processID');assert(Number.isSafeInteger(actualPid)&&actualPid>0);
        const owner=(await admin.query(`SELECT pid,extract(epoch FROM backend_start)::text AS start,application_name
          FROM pg_stat_activity WHERE pid=$1`,[actualPid])).rows[0];
        assert(owner);assert.equal(owner.application_name,`owned-move-owner-${nonce}`);ownerPid=owner.pid;ownerStart=owner.start;
        await holder.query('BEGIN READ ONLY');holderActive=true;
        await holder.query('SELECT pg_advisory_xact_lock_shared($1::bigint)',[admissionKey]);
        const facts=(await holder.query(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
          current_setting('transaction_read_only') AS readonly,pg_current_xact_id_if_assigned()::text AS xid
          FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
        assert.equal(facts.readonly,'on');assert.equal(facts.xid,null);holderPid=facts.pid;holderStart=facts.start;assert.notEqual(holderPid,ownerPid);
        assert((await lockRows()).some(row=>row.pid===holderPid&&row.start===holderStart&&row.mode==='ShareLock'&&row.granted));
        originalPreparation=(await admin.query(`SELECT preparation_digest,preparation_text FROM workspace_file_operation_move_preparations
          WHERE batch_id=$1`,[job.claimed.batchId])).rows;assert.equal(originalPreparation.length,1);
        beforeRows=await originalDataFacts();beforeFs=await workspacePhysicalFacts();signalArmed();
      };
      const onClient=(client:PoolClient)=>{
        if(observed.has(client))return;
        observed.set(client,Object.getOwnPropertyDescriptor(client,'query'));const original=client.query;
        Object.defineProperty(client,'query',{configurable:true,writable:true,value:(...args:unknown[])=>{
          if(armCount||typeof args.at(-1)==='function')return Reflect.apply(original,client,args);
          let text:string,values:unknown[]|undefined;
          if(typeof args[0]==='string'){text=args[0];values=args[1] as unknown[]|undefined;}
          else{
            const config=args[0];
            if(args.length!==1||!config||typeof config!=='object'||types.isProxy(config)
              ||![Object.prototype,null].includes(Object.getPrototypeOf(config)))return Reflect.apply(original,client,args);
            const fields=Object.getOwnPropertyDescriptors(config),keys=Reflect.ownKeys(config);
            if(keys.length!==3||!keys.every(key=>typeof key==='string'&&['name','text','values'].includes(key))
              ||!Object.values(fields).every(field=>'value' in field)||typeof fields.name?.value!=='string'||typeof fields.text?.value!=='string'
              ||fields.values?.value!==undefined&&!Array.isArray(fields.values.value))return Reflect.apply(original,client,args);
            text=fields.text.value;values=fields.values.value;
          }
          if(!/^SELECT pg_(?:try_)?advisory_lock\(\$1::bigint\)(?: AS locked|, true AS locked)$/u.test(text.trim())
            ||values?.length!==1||String(values[0])!==String(admissionKey))return Reflect.apply(original,client,args);
          return (async()=>{
            await arm(client);
            try{
              const answer=await Reflect.apply(original,client,args) as {rows:Array<{locked?:unknown}>};
              sessionSqlOutcome={status:'returned',locked:answer.rows[0]?.locked};return answer;
            }catch(error){sessionSqlOutcome={status:'rejected',code:code(error)};throw error;}
          })();
        }});
      };
      let primary:unknown,failed=false;const closureFailures:unknown[]=[];
      actualPool.on('connect',onClient);actualPool.on('acquire',onClient);
      try{
        pending=invoke(job,async()=>{
          pathCallbacks++;const owners=(await lockRows()).filter(row=>row.mode==='ExclusiveLock'&&row.granted
            &&row.application_name===`owned-move-owner-${nonce}`);
          assert.equal(owners.length,1);assert.equal(owners[0].pid,ownerPid);assert.equal(owners[0].start,ownerStart);
        }).then(value=>({value}),error=>({error}));
        void pending.then(value=>{settled=value;});
        await bounded(Promise.race([armed,pending.then(()=>{throw new Error('Move settled before the genuine session-EX reader was armed.');})]),5000,'Move reader arm');
        let waiter:AdmissionLockRow|undefined;const waitDeadline=performance.now()+2000;
        do{
          waiter=(await lockRows()).find(row=>row.pid===ownerPid&&row.start===ownerStart&&row.mode==='ExclusiveLock'&&!row.granted
            &&row.application_name===`owned-move-owner-${nonce}`&&row.wait_event_type==='Lock'&&row.blockers.includes(holderPid));
          if(waiter){const age=Number(waiter.query_age_ms);assert(Number.isFinite(age)&&age>=0&&age<4000);waitStartedAt=performance.now()-age;break;}
          if(settled)break;
          await new Promise<void>(resolve=>setTimeout(resolve,20));
        }while(performance.now()<waitDeadline);
        if(!waiter)console.log('Original Move contention actual pre-fix result:',JSON.stringify({mode,armCount,sessionSqlOutcome,
          jobCode:settled&&'error' in settled?code(settled.error):null,
          sharedHolderStillGranted:(await lockRows()).some(row=>row.pid===holderPid&&row.start===holderStart&&row.mode==='ShareLock'&&row.granted)}));
        assert(waiter,'The genuine Move session-EX must wait for its independent keyed READ ONLY holder.');
        assert.equal(settled,undefined);assert.equal(armCount,1);assert.equal(pathCallbacks,0);
        assert.deepEqual(await originalDataFacts(),beforeRows);assert.deepEqual(await workspacePhysicalFacts(),beforeFs);
        if(mode==='short-shared-reader')await release();
        const outcome=await bounded(pending,mode==='short-shared-reader'?10000:Math.max(1,waitStartedAt+8000-performance.now()),'Contended original Move');
        // A missing key lock alone does not prove that the dedicated session
        // was discarded. Verify its exact backend identity before any recovery.
        const discardDeadline=performance.now()+1000;
        for(;;){
          const backend=(await admin.query(`SELECT pid FROM pg_stat_activity
            WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2`,[ownerPid,ownerStart])).rows;
          if(!backend.length)break;
          assert(performance.now()<discardDeadline,'The exact original Move backend must be discarded after its owner settles.');
          await new Promise<void>(resolve=>setTimeout(resolve,20));
        }
        if(mode==='short-shared-reader'){
          if('error' in outcome)throw outcome.error;
          assert.equal(pathCallbacks,1);assert.equal(outcome.value.pathReceipts.length,1);
        }else{
          assert('error' in outcome,'A persistent READ ONLY holder must end at the bounded acquisition.');
          assert.equal(code(outcome.error),'JOB_LIFECYCLE_CHANGED');assert.equal((outcome.error as {status?:unknown}).status,409);
          assert.equal(code((outcome.error as Error).cause),'55P03');
          const elapsed=performance.now()-waitStartedAt;assert(elapsed>=3500&&elapsed<8000,`Unexpected Move admission bound (${Math.round(elapsed)}ms).`);
          assert.equal(pathCallbacks,0);assert.equal(armCount,1);
          assert.deepEqual(await originalDataFacts(),beforeRows);assert.deepEqual(await workspacePhysicalFacts(),beforeFs);
          const rows=await lockRows();assert(rows.some(row=>row.pid===holderPid&&row.start===holderStart&&row.mode==='ShareLock'&&row.granted));
          assert.equal(rows.some(row=>row.pid===ownerPid&&row.start===ownerStart),false);
          await release();
          const resumed=await resume(job);assert.equal(resumed.claimed.batchId,job.claimed.batchId);assert.equal(resumed.claimed.planId,job.claimed.planId);
          await invoke(resumed);assert.deepEqual((await admin.query(`SELECT preparation_digest,preparation_text
            FROM workspace_file_operation_move_preparations WHERE batch_id=$1`,[job.claimed.batchId])).rows,originalPreparation);
        }
        assert.equal(armCount,1);assert(await absent(path.join(workspace.rootPath,name)));assert.deepEqual(await readFile(path.join(workspace.rootPath,destination)),bytes);
        assert.equal(await nativeContent(peer.documentId),`[PDF](${destination})\n`);assert.deepEqual(await metadata(name),[]);
        assert.deepEqual(await metadata(destination),[{path:destination,title:'Preserved title'}]);
        for(const table of ['workspace_file_operation_move_intents','workspace_file_operation_move_path_receipts','workspace_file_operation_move_receipts']){
          assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM "${table}" WHERE batch_id=$1`,[job.claimed.batchId])).rows[0].n,1);
        }
        console.log('Original Move contention actual completion:',JSON.stringify({mode,armCount,keyedWaitObserved:true,
          independentReadOnlyHolder:true,exactOwnerBackendRemoved:true,resumed:mode==='bounded-shared-reader'}));
      }catch(error){primary=error;failed=true;}
      finally{
        try{await release();}catch(error){closureFailures.push(error);}
        if(pending)try{await bounded(pending,10000,'Contended Move drain');}catch(error){closureFailures.push(error);}
        actualPool.off('connect',onClient);actualPool.off('acquire',onClient);
        for(const [client,descriptor] of observed){try{if(descriptor)Object.defineProperty(client,'query',descriptor);else Reflect.deleteProperty(client,'query');}catch(error){closureFailures.push(error);}}
        try{await endClient(holder);}catch(error){closureFailures.push(error);}
      }
      if(closureFailures.length)throw new AggregateError([...(failed?[primary]:[]),...closureFailures],'Contended Move fixture closure failed.');
      if(failed)throw primary;
    });
    const {POST:uploadPost}=await import('../app/api/files/upload/route');
    const {persistPristineOriginalWorkspaceFileForWrite}=await import('../app/lib/collaboration/markdown-file-import-persistence');
    const {readWorkspaceDocumentCatalogue}=await import('../app/lib/collaboration/workspace-document-catalogue');
    const uploadHeaders=async()=>new Headers({'x-canvas-workspace-id':workspaceId,
      cookie:(await serializeSignedCookie('better-auth.session_token',sessionToken,process.env.BETTER_AUTH_SECRET!)).split(';')[0]});
    const uploadTxt=async(filename:string,bytes:Buffer)=>{
      const form=new FormData();form.set('path',path.posix.dirname(filename));
      form.append('files',new File([Uint8Array.from(bytes)],path.posix.basename(filename),{type:'text/plain'}));
      const response=await uploadPost(new NextRequest('http://localhost/api/files/upload',{
        method:'POST',headers:await uploadHeaders(),body:form}));
      const result=await response.json();
      assert.equal(response.status,200,JSON.stringify({status:response.status,code:result.code}));assert.equal(result.success,true);assert.equal(result.count,1);
      assert.deepEqual(await readFile(path.join(workspace.rootPath,filename)),bytes);
      const rows=(await admin.query(`SELECT id,lineage_id,provider,status,state_version,yjs_state_lifecycle,path
        FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status='active'`,[workspaceId,filename])).rows;
      assert.equal(rows.length,1);const row=rows[0];assert.equal(row.provider,'yjs');assert.equal(row.status,'active');
      assert.equal(Number(row.state_version),0);assert.equal(row.yjs_state_lifecycle,'never_initialized');
      assert.equal(typeof row.id,'string');assert.equal(typeof row.lineage_id,'string');
      assert((await admin.query('SELECT count(*)::integer AS n FROM file_revisions WHERE workspace_id=$1 AND lineage_id=$2',[workspaceId,row.lineage_id])).rows[0].n>0);
      return {documentId:row.id as string,lineageId:row.lineage_id as string,filename,bytes};
    };
    const assertPristine=async(identity:Awaited<ReturnType<typeof uploadTxt>>,filename:string)=>{
      const rows=(await admin.query(`SELECT id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,status,state_version,yjs_state_lifecycle
        FROM collaboration_documents WHERE id=$1`,[identity.documentId])).rows;
      assert.equal(rows.length,1);const row=rows[0];assert.equal(row.id,identity.documentId);assert.equal(row.lineage_id,identity.lineageId);
      assert.equal(row.workspace_id,workspaceId);assert.equal(row.workspace_type,workspace.workspaceType);assert.equal(row.organization_id,organizationId);
      assert.equal(row.path,filename);assert.equal(row.provider,'yjs');assert.equal(row.status,'active');assert.equal(Number(row.state_version),0);
      assert.equal(row.yjs_state_lifecycle,'never_initialized');
      const lineages=(await admin.query('SELECT id,workspace_id,organization_id,path,status,archived_at,trash_entry_id FROM file_collaboration_lineages WHERE id=$1',[identity.lineageId])).rows;
      assert.deepEqual(lineages,[{id:identity.lineageId,workspace_id:workspaceId,organization_id:organizationId,path:filename,status:'active',archived_at:null,trash_entry_id:null}]);
      for(const table of ['collaboration_yjs_states','collaboration_yjs_state_backups','collaboration_agent_operations','collaboration_file_projections']){
        assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM "${table}" WHERE document_id=$1`,[identity.documentId])).rows[0].n,0);
      }
      const connection=await database.openDb();try{
        const catalogue=await readWorkspaceDocumentCatalogue(connection,await currentWorkspace(),{paths:[filename]});
        assert.equal(catalogue.length,1);assert.equal(catalogue[0].id,identity.documentId);assert.equal(catalogue[0].lineage_id,identity.lineageId);
        assert.equal(catalogue[0].authority,'pristine');assert.equal(catalogue[0].has_persisted_state,false);assert.equal(catalogue[0].has_state_history,false);
      }finally{await connection.close();}
      assert.deepEqual(await readFile(path.join(workspace.rootPath,filename)),identity.bytes);
    };
    const uploadDomainFacts=async()=>{
      const rows:Record<string,string[]>={};
      for(const table of ['file_revisions','file_revision_contents','file_version_blobs','collaboration_yjs_state_backups',
        'collaboration_agent_operations','collaboration_markdown_file_import_receipts']){
        rows[table]=(await admin.query(`SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows.map(row=>row.row);
      }
      return {original:await originalDataFacts(),upload:rows};
    };
    await check('genuine uploaded pristine TXT keeps its identity through folder Move recovery and later historical D2',async()=>{
      const folder=`uploaded-folder-${crypto.randomUUID()}`,destination=`uploaded-folder-dest-${crypto.randomUUID()}`;
      const txtPath=`${folder}/original.txt`,txtBytes=Buffer.from('\uFEFFOriginal uploaded TXT\r\nSecond line\r\n');
      const txt=await uploadTxt(txtPath,txtBytes);await assertPristine(txt,txtPath);
      const before=await physicalFacts(txtPath),inside=await seedNative(`${folder}/note.md`,'# Native inside uploaded folder\n');
      const peer=await seedNative(`uploaded-folder-peer-${crypto.randomUUID()}.md`,`[TXT](${txtPath})\n[Note](${inside.filename})\n`);
      await seedMetadata(txtPath);await seedMetadata(inside.filename);
      const revisions=(await admin.query('SELECT id FROM file_revisions WHERE lineage_id=$1 ORDER BY id',[txt.lineageId])).rows;
      const job=await freshJob([{sourcePath:folder,destinationPath:destination}]);let reached=false;
      await assert.rejects(invoke(job,async()=>{reached=true;throw Object.assign(new Error('Owned pristine folder after-FS interruption'),{code:'FIXTURE_PRISTINE_FOLDER_AFTER_PATH'});}),
        error=>{const actual=code(error);if(actual!=='FIXTURE_PRISTINE_FOLDER_AFTER_PATH')console.log('Pristine folder actual pre-fix failure:',JSON.stringify({code:actual,reached}));return actual==='FIXTURE_PRISTINE_FOLDER_AFTER_PATH';});
      assert(reached);assert(await absent(path.join(workspace.rootPath,folder)));assert.deepEqual(await readFile(path.join(workspace.rootPath,destination,'original.txt')),txtBytes);
      const intents=(await admin.query('SELECT intent_digest FROM workspace_file_operation_move_intents WHERE batch_id=$1',[job.claimed.batchId])).rows;
      assert.equal(intents.length,1);assert.equal((await admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_move_receipts WHERE batch_id=$1',[job.claimed.batchId])).rows[0].n,0);
      const resumed=await resume(job);assert.equal(resumed.claimed.batchId,job.claimed.batchId);assert.equal(resumed.claimed.planId,job.claimed.planId);
      let historyChecked=false;
      const completion=await invoke(resumed,undefined,async(claim,first)=>{
        await assertPristine(txt,`${destination}/original.txt`);
        assert.equal(await nativePath(inside.documentId),`${destination}/note.md`);assert.equal(await nativeContent(inside.documentId),inside.content);
        assert.equal(await nativeContent(peer.documentId),`[TXT](${destination}/original.txt)\n[Note](${destination}/note.md)\n`);
        const after=await physicalFacts(`${destination}/original.txt`);
        assert.equal(after.device,before.device);assert.equal(after.inode,before.inode);assert.equal(after.hash,before.hash);assert.equal(after.mode,before.mode);
        assert.deepEqual((await admin.query('SELECT id FROM file_revisions WHERE lineage_id=$1 ORDER BY id',[txt.lineageId])).rows,revisions);
        const selected=(await admin.query('SELECT id,lineage_id,path FROM collaboration_documents WHERE workspace_id=$1 AND path=ANY($2::text[]) AND status=\'active\' ORDER BY path',
          [workspaceId,[txtPath,`${destination}/original.txt`]])).rows;
        assert.deepEqual(selected,[{id:txt.documentId,lineage_id:txt.lineageId,path:`${destination}/original.txt`}]);
        const d2=await uploadTxt(txtPath,Buffer.from('Later independently uploaded D2\r\n'));assert.notEqual(d2.documentId,txt.documentId);assert.notEqual(d2.lineageId,txt.lineageId);
        await assertPristine(d2,txtPath);const originalRows=await uploadDomainFacts(),originalFs=await workspacePhysicalFacts();
        assert.deepEqual(await execute({claim,workspace:resumed.workspace}),first);
        const {readWorkspaceOperationNativeMoveBatchStatus}=await import('../app/lib/files/workspace-operation-native-move-status');
        const current=await currentWorkspace(),status=await readWorkspaceOperationNativeMoveBatchStatus({batchId:job.claimed.batchId,scope:{workspace:current,fileOptions:{workspace:current}}});
        assert(status);assert.equal(status.observation.apply,'complete');assert.deepEqual(status.observation.completion,first);
        assert.deepEqual(await uploadDomainFacts(),originalRows);assert.deepEqual(await workspacePhysicalFacts(),originalFs);historyChecked=true;
      });
      assert(historyChecked);assert(completion.native);assert.equal(completion.pathReceipts.length,1);
      assert.deepEqual((await admin.query('SELECT intent_digest FROM workspace_file_operation_move_intents WHERE batch_id=$1',[job.claimed.batchId])).rows,intents);
      for(const table of ['workspace_file_operation_move_intents','workspace_file_operation_move_path_receipts','workspace_file_operation_move_receipts']){
        assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM "${table}" WHERE batch_id=$1`,[job.claimed.batchId])).rows[0].n,1);
      }
    });
    await check('genuine pristine TXT initialization after planning conflicts before folder Move effects',async()=>{
      const folder=`pristine-race-${crypto.randomUUID()}`,destination=`pristine-race-dest-${crypto.randomUUID()}`,filename=`${folder}/race.txt`;
      const txt=await uploadTxt(filename,Buffer.from('Pristine TXT awaiting real initialization\r\n'));await assertPristine(txt,filename);
      const inside=await seedNative(`${folder}/note.md`,'# Independent native folder note\n');
      const peer=await seedNative(`pristine-race-peer-${crypto.randomUUID()}.md`,`[TXT](${filename})\n[Note](${inside.filename})\n`);
      const job=await freshJob([{sourcePath:folder,destinationPath:destination}]);
      const result=await persistPristineOriginalWorkspaceFileForWrite(new NextRequest('http://localhost/api/collaboration/session',{headers:await uploadHeaders()}),
        {workspaceId,path:filename,operationId:crypto.randomUUID(),requestId:crypto.randomUUID(),initialRepresentation:'plain_text',
          expectedTarget:{kind:'pristine',documentId:txt.documentId}});
      assert.equal(result.receipt.target.documentId,txt.documentId);assert.equal(result.receipt.target.lineageId,txt.lineageId);
      const initialized=(await admin.query('SELECT id,lineage_id,path,yjs_state_lifecycle FROM collaboration_documents WHERE id=$1',[txt.documentId])).rows;
      assert.deepEqual(initialized,[{id:txt.documentId,lineage_id:txt.lineageId,path:filename,yjs_state_lifecycle:'initialized'}]);
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_yjs_states WHERE document_id=$1',[txt.documentId])).rows[0].n,1);
      const beforeRows=await uploadDomainFacts(),beforeFs=await workspacePhysicalFacts();
      await assert.rejects(invoke(job),error=>code(error)==='NATIVE_MOVE_PLAN_CHANGED');
      assert.deepEqual(await uploadDomainFacts(),beforeRows);assert.deepEqual(await workspacePhysicalFacts(),beforeFs);
      assert.deepEqual(await readFile(path.join(workspace.rootPath,filename)),txt.bytes);assert(await absent(path.join(workspace.rootPath,destination)));
      assert.equal(await nativePath(inside.documentId),inside.filename);assert.equal(await nativeContent(peer.documentId),`[TXT](${filename})\n[Note](${inside.filename})\n`);
      for(const table of ['workspace_file_operation_move_intents','workspace_file_operation_move_path_receipts','workspace_file_operation_move_receipts']){
        assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM "${table}" WHERE batch_id=$1`,[job.claimed.batchId])).rows[0].n,0);
      }
      await abort(job);
    });
    const stableName=`html-stable-${crypto.randomUUID()}.bin`,stableBytes=Buffer.from('owned unrelated HTML target\n');
    await writeFile(path.join(workspace.rootPath,stableName),stableBytes,{flag:'wx',mode:0o600});
    await check('identity4 actual owner rewrites native backlinks while preserving native HTML and unrelated physical sources',async()=>{
      const name=`html-native-${crypto.randomUUID()}.md`,destination=`html-native-dest/${name}`;
      const target=await seedNative(name,'# Original native HTML target\n');
      const peerName=`html-native-peer-${crypto.randomUUID()}.md`,peerText=`[Target](${name})\n\n<img src="/${stableName}">\n`;
      const peer=await seedNative(peerName,peerText),htmlName=`unrelated-${crypto.randomUUID()}.html`,rawName=`unrelated-${crypto.randomUUID()}.md`;
      const htmlBytes=Buffer.from(`<p><a href="/${stableName}">Stable</a></p>\n`),rawBytes=Buffer.from(`# Raw read source\n\n[Stable](/${stableName})\n`);
      await writeFile(path.join(workspace.rootPath,htmlName),htmlBytes,{flag:'wx',mode:0o600});
      await writeFile(path.join(workspace.rootPath,rawName),rawBytes,{flag:'wx',mode:0o600});
      const before=await Promise.all([physicalFacts(htmlName),physicalFacts(rawName),physicalFacts(stableName)]);
      assert(await absent(path.join(workspace.rootPath,name)));assert(await absent(path.join(workspace.rootPath,peerName)));
      await seedMetadata(name);const job=await freshHtmlJob([{sourcePath:name,destinationPath:destination}]);
      assert(job.plan.nativePathPlan.htmlAssessment.warnings.some(row=>row.sourcePath===peerName));
      assert(job.plan.nativePathPlan.htmlAssessment.warnings.some(row=>row.sourcePath===htmlName));
      const receipt=await invoke(job);assert(receipt.native);assert.equal(receipt.native.receipts.length,2);
      assert.equal(await nativePath(target.documentId),destination);assert.equal(await nativeContent(target.documentId),target.content);
      assert.equal(await nativeContent(peer.documentId),`[Target](${destination})\n\n<img src="/${stableName}">\n`);
      assert.deepEqual(await readFile(path.join(workspace.rootPath,htmlName)),htmlBytes);assert.deepEqual(await readFile(path.join(workspace.rootPath,rawName)),rawBytes);
      assert.deepEqual(await Promise.all([physicalFacts(htmlName),physicalFacts(rawName),physicalFacts(stableName)]),before);
      assert(await absent(path.join(workspace.rootPath,name)));assert(await absent(path.join(workspace.rootPath,destination)));assert(await absent(path.join(workspace.rootPath,peerName)));
      assert.deepEqual(await metadata(name),[]);assert.deepEqual(await metadata(destination),[{path:destination,title:'Preserved title'}]);
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=ANY($2::text[])',[workspaceId,[rawName,htmlName]])).rows[0].n,0);
    });
    await check('identity4 moves original whole HTML bytes without manufacturing a notebook identity',async()=>{
      const name=`physical-html-${crypto.randomUUID()}.html`,destination=`html-files/${name}`;
      const bytes=Buffer.from('<!doctype html>\r\n<p>External <a href="https://example.test/">link</a></p>\r\n');
      await writeFile(path.join(workspace.rootPath,name),bytes,{flag:'wx',mode:0o600});
      const identity=await physicalFacts(name),peer=await seedNative(`whole-html-peer-${crypto.randomUUID()}.md`,`[Page](${name})\n`);
      await seedMetadata(name);const job=await freshHtmlJob([{sourcePath:name,destinationPath:destination}]),receipt=await invoke(job);
      assert.equal(receipt.pathReceipts.length,1);assert(await absent(path.join(workspace.rootPath,name)));
      assert.deepEqual(await readFile(path.join(workspace.rootPath,destination)),bytes);const after=await physicalFacts(destination);
      assert.equal(after.device,identity.device);assert.equal(after.inode,identity.inode);assert.equal(after.hash,identity.hash);assert.equal(after.mode,identity.mode);
      assert.equal(await nativeContent(peer.documentId),`[Page](${destination})\n`);
      assert.deepEqual(await metadata(name),[]);assert.equal((await metadata(destination)).length,1);
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=ANY($2::text[])',[workspaceId,[name,destination]])).rows[0].n,0);
    });
    await check('identity4 own after-FS recovery reuses its journal and historical completion ignores later D2',async()=>{
      const name=`html-resume-${crypto.randomUUID()}.pdf`,destination=`html-recovered/${name}`,bytes=Buffer.from('%PDF-1.7\nowned HTML profile recovery\n');
      await writeFile(path.join(workspace.rootPath,name),bytes,{flag:'wx',mode:0o600});
      const peer=await seedNative(`html-resume-peer-${crypto.randomUUID()}.md`,`[PDF](${name})\n`),job=await freshHtmlJob([{sourcePath:name,destinationPath:destination}]);
      let reached=false;
      await assert.rejects(invoke(job,async()=>{reached=true;throw Object.assign(new Error('Owned HTML Move interruption'),{code:'FIXTURE_HTML_MOVE_AFTER_PATH'});}),
        error=>code(error)==='FIXTURE_HTML_MOVE_AFTER_PATH');assert(reached);
      const intents=(await admin.query('SELECT intent_digest FROM workspace_file_operation_move_intents WHERE batch_id=$1',[job.claimed.batchId])).rows;assert.equal(intents.length,1);
      assert(await absent(path.join(workspace.rootPath,name)));assert.deepEqual(await readFile(path.join(workspace.rootPath,destination)),bytes);
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_move_receipts WHERE batch_id=$1',[job.claimed.batchId])).rows[0].n,0);
      const resumed=await resume(job);let historical=false;
      const completion=await invoke(resumed,undefined,async(claim,first)=>{
        await writeFile(path.join(workspace.rootPath,name),'Later independent D2\n',{flag:'wx',mode:0o600});
        const originalRows=await originalDataFacts(),originalFs=await workspacePhysicalFacts();
        assert.deepEqual(await execute({claim,workspace:resumed.workspace}),first);historical=true;
        assert.deepEqual(await originalDataFacts(),originalRows);assert.deepEqual(await workspacePhysicalFacts(),originalFs);
      });
      assert(historical);assert(completion.native);assert.equal(await nativeContent(peer.documentId),`[PDF](${destination})\n`);
      assert.deepEqual((await admin.query('SELECT intent_digest FROM workspace_file_operation_move_intents WHERE batch_id=$1',[job.claimed.batchId])).rows,intents);
      const {readWorkspaceOperationNativeMoveBatchStatus}=await import('../app/lib/files/workspace-operation-native-move-status');
      const status=await readWorkspaceOperationNativeMoveBatchStatus({batchId:job.claimed.batchId,scope:{workspace:await currentWorkspace(),fileOptions:{workspace:await currentWorkspace()}}});
      assert(status);assert.equal(status.plan.planIdentityVersion,4);assert.equal(status.observation.apply,'complete');assert.deepEqual(status.observation.completion,completion);
      assert.equal(await readFile(path.join(workspace.rootPath,name),'utf8'),'Later independent D2\n');assert.deepEqual(await readFile(path.join(workspace.rootPath,destination)),bytes);
    });
    await check('affected current HTML rejects fresh planning and the old claimed plan before original data effects',async()=>{
      const name=`affected-html-${crypto.randomUUID()}.pdf`,destination=`affected-html-dest/${name}`,bytes=Buffer.from('%PDF-1.7\nMust remain original\n');
      await writeFile(path.join(workspace.rootPath,name),bytes,{flag:'wx',mode:0o600});await seedMetadata(name);
      const peer=await seedNative(`affected-html-peer-${crypto.randomUUID()}.md`,`<img src="/${stableName}">\n`);
      const job=await freshHtmlJob([{sourcePath:name,destinationPath:destination}]);
      const {loadCollaborationState,persistCollaborationYDoc}=await import('../app/lib/collaboration/persistence');
      const state=await loadCollaborationState(peer.documentId);assert(state);const doc=new Y.Doc();
      try{Y.applyUpdate(doc,state.yjsState);const text=doc.getText('content');text.delete(0,text.length);text.insert(0,`<img src="/${name}">\n`);
        assert.equal((await persistCollaborationYDoc(peer.documentId,state.lifecycleGeneration,doc,{workspaceId,organizationId,path:peer.filename,representation:'plain_text',schemaVersion:1})).persistenceDisposition,'advanced');
      }finally{doc.destroy();}
      const before=await originalDataFacts(),physicalBefore=await workspacePhysicalFacts();
      const changed=await readHtmlPlanInput([{sourcePath:name,destinationPath:destination}]);
      assert.throws(()=>createWorkspaceOperationNativeMoveBatchPlanV4(changed),error=>code(error)==='NATIVE_MOVE_PLAN_UNSUPPORTED');
      assert.deepEqual(await originalDataFacts(),before);assert.deepEqual(await workspacePhysicalFacts(),physicalBefore);
      await assert.rejects(invoke(job),error=>code(error)==='NATIVE_MOVE_PLAN_CHANGED');
      // Coordination abort records may be written; original document data,
      // byte identities and every original/native mutation journal stay intact.
      assert.deepEqual(await originalDataFacts(),before);assert.deepEqual(await workspacePhysicalFacts(),physicalBefore);
      assert.equal(await nativeContent(peer.documentId),`<img src="/${name}">\n`);
      assert.deepEqual(await readFile(path.join(workspace.rootPath,name)),bytes);assert(await absent(path.join(workspace.rootPath,destination)));
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_move_intents WHERE batch_id=$1',[job.claimed.batchId])).rows[0].n,0);
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_move_path_receipts WHERE batch_id=$1',[job.claimed.batchId])).rows[0].n,0);
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_move_receipts WHERE batch_id=$1',[job.claimed.batchId])).rows[0].n,0);
      await abort(job);
    });
    await check('clean pre-owner Principal Busy settles before Scheduler resume and a fresh original attempt',async()=>{
      // A real independent row lock makes the genuine policy FOR SHARE NOWAIT
      // fail. No SQL result, Principal, Claim, owner or admission is substituted.
      for(const boundary of ['history','admission'] as const)for(const rejectResume of [false,true]){
        const name=`preowner-${boundary}-${crypto.randomUUID()}.pdf`,destination=`preowner-moved/${name}`;
        const bytes=Buffer.from('%PDF-1.7\npre-owner retry original bytes\n');
        await writeFile(path.join(workspace.rootPath,name),bytes,{flag:'wx',mode:0o600});
        const peer=await seedNative(`preowner-peer-${crypto.randomUUID()}.md`,`[PDF](${name})\n`);
        const job=await freshHtmlJob([{sourcePath:name,destinationPath:destination}]);
        const beforeRows=await originalDataFacts(),beforeFs=await workspacePhysicalFacts();
        const holder=await ownClient();let holderActive=false,revokedToken:string|undefined;
        const lease=(await admin.query('SELECT lease_token FROM workspace_file_operation_batches WHERE batch_id=$1',[job.claimed.batchId])).rows[0];
        assert.equal(typeof lease?.lease_token,'string');
        type Attempt={events:string[];closed:boolean;sqlBusy:number;closeError?:Error};
        const attempts:Attempt[]=[];let pauses=0,resumes=0,pathCallbacks=0;
        const resumeAbort=Object.assign(new Error('The owned Scheduler resume was deliberately aborted.'),{code:'FIXTURE_RESUME_ABORT'});
        const release=async()=>{if(holderActive){await holder.query('ROLLBACK');holderActive=false;}};
        const observedOpen=async():Promise<SqlConnection>=>{
          assert(attempts.every(attempt=>attempt.closed),'The preceding real B must close before a fresh checkout.');
          const actual=await database.openDb();checkouts.add(actual);
          const attempt:Attempt={events:[],closed:false,sqlBusy:0};attempts.push(attempt);
          const observe=async<T>(sql:string,operation:()=>T|Promise<T>):Promise<T>=>{
            try{const value=await operation();if(/^ROLLBACK\b/iu.test(sql))attempt.events.push('rollback');
              if(/^COMMIT\b/iu.test(sql))attempt.events.push('commit');return value;
            }catch(error){if(code(error)==='55P03'){attempt.sqlBusy++;attempt.events.push('sql55P03');}throw error;}
          };
          return {get:(sql,values)=>observe(sql,()=>actual.get(sql,values)),
            all:(sql,values)=>observe(sql,()=>actual.all(sql,values)),run:(sql,values)=>observe(sql,()=>actual.run(sql,values)),
            close:async error=>{attempt.closeError=error;await actual.close(error);checkouts.delete(actual);attempt.closed=true;attempt.events.push('closed');}};
        };
        try{
          await holder.query('BEGIN');holderActive=true;
          assert.equal((await holder.query(`SELECT id FROM "${schema}"."user" WHERE id='member' FOR UPDATE`)).rows[0]?.id,'member');
          const operation=()=>store.withClaim(job.claimed,async claim=>{
            const completion=await withWorkspaceOperationJobClaimScheduling(claim,{
              pauseAndDrain:async()=>{pauses++;assert(attempts.every(attempt=>attempt.closed));},
              resume:async()=>{
                resumes++;assert(attempts.every(attempt=>attempt.closed));
                if(resumes===1){
                  const first=attempts[0];assert(first);assert.equal(first.sqlBusy,1);
                  assert.deepEqual(first.events,['sql55P03','rollback','closed']);
                  if(boundary==='history'){
                    assert(first.closeError instanceof WorkspaceRequestPrincipalError);
                    assert.equal(first.closeError.code,'PRINCIPAL_BUSY');
                  }
                  assert.deepEqual(await originalDataFacts(),beforeRows);assert.deepEqual(await workspacePhysicalFacts(),beforeFs);
                  assert.equal(pathCallbacks,0);await release();
                  if(rejectResume){
                    if(boundary==='history')throw resumeAbort;
                    revokedToken=crypto.randomUUID();
                    assert.equal((await admin.query('UPDATE workspace_file_operation_batches SET lease_token=$2 WHERE batch_id=$1 RETURNING batch_id',
                      [job.claimed.batchId,revokedToken])).rows.length,1);
                  }
                }
                // This is the real A heartbeat, after B rollback/close. A stale
                // lease must abort here, before any fresh policy or owner phase.
                assert.equal(await store.heartbeatClaim(job.claimed),true);
              },
            },async()=>{
              const deadline=performance.now()+10_000;
              if(boundary==='history')assert.equal(await ownerApi.readWorkspaceOperationOriginalMoveJobHistory(claim,observedOpen,undefined,deadline),null);
              else await waitForWorkspaceOperationNativePathAdmission(claim,observedOpen,undefined,deadline);
              assert(attempts.length>=2,'The public entry must take a genuinely fresh phase after clean Busy.');
              assert.equal(attempts.reduce((sum,attempt)=>sum+attempt.sqlBusy,0),1);
              return execute({claim,workspace:job.workspace,onPathCommitted:async()=>{pathCallbacks++;}});
            });
            assert(await store.finishClaim(job.claimed,{status:'applied',completedActions:job.claimed.totalActions,phase:'complete'}));
            return completion;
          });
          if(rejectResume){
            await assert.rejects(operation(),error=>boundary==='history'?error===resumeAbort:code(error)==='BATCH_CLAIM_CHANGED');
            assert.equal(attempts.length,1);assert.equal(resumes,1);assert.equal(pauses,2);
            assert.equal(pathCallbacks,0);assert.deepEqual(await originalDataFacts(),beforeRows);assert.deepEqual(await workspacePhysicalFacts(),beforeFs);
            assert.equal(await nativeContent(peer.documentId),`[PDF](${name})\n`);
          }else{
            const completion=await operation();assert.equal(completion.pathReceipts.length,1);
            assert.equal(pathCallbacks,1);assert(resumes>=2);assert.equal(pauses,resumes+1);
            assert(await absent(path.join(workspace.rootPath,name)));assert.deepEqual(await readFile(path.join(workspace.rootPath,destination)),bytes);
            assert.equal(await nativeContent(peer.documentId),`[PDF](${destination})\n`);
          }
        }finally{
          await release();await endClient(holder);
          if(revokedToken){assert.equal((await admin.query('UPDATE workspace_file_operation_batches SET lease_token=$3 WHERE batch_id=$1 AND lease_token=$2 RETURNING batch_id',
            [job.claimed.batchId,revokedToken,lease.lease_token])).rows.length,1);}
        }
        if(rejectResume)await abort(job);
        assert(attempts.every(attempt=>attempt.closed));assert.equal(checkouts.size,0);
      }
    });
    assert.equal(passed,22);assert.equal(fetches,0);await own();assert.equal(await sourceHash(),pinned);
    for(const [filename,hash] of sourcePins)assert.equal(sha(await readFile(filename)),hash,`Source changed during original Move fixture: ${filename}`);
    console.log('Original Move genuine owner assertions finished:',JSON.stringify({passed,sourcePins,fetches}));
  } catch(error) {failures.push(error);}
  finally {
    const cleanup=async(operation:()=>Promise<unknown>)=>{try{await operation();}catch(error){failures.push(error);}};
    for(const connection of checkouts)await cleanup(async()=>{checkouts.delete(connection);await connection.close(new Error('Discarding original Move fixture checkout.'));});
    if(queryProfile)await cleanup(async()=>{queryProfile!.close();});
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
