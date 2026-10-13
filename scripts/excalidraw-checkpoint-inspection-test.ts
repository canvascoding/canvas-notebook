import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';
import { closeDatabaseConnections, openDb } from '@/app/lib/db';
import { jsonDatabaseUnavailable } from '@/app/lib/api/route-helpers';
import { setFileCollaborationConnectionFactoryForTests } from '@/app/lib/files/collaboration-repository';
import { readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import * as mutationLock from '@/app/lib/files/workspace-mutation-lock';
import { fileVersionContentStore } from '@/app/lib/file-version-center/version-content-store';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
import { fileVersionRestoreService } from '@/app/lib/file-version-center/restore-service';
import { loadAuthoritativeFileVersionContent } from '@/app/lib/file-version-center/authoritative-content';
import * as apiContract from '@/app/lib/excalidraw-collaboration/api-contract';
import * as provider from '@/app/lib/excalidraw-collaboration/provider';
import * as sceneService from '@/app/lib/excalidraw-collaboration/scene-service';
import { getExcalidrawOperation, listExcalidrawOperations } from '@/app/lib/excalidraw-collaboration/operation-service';
import { materializeExcalidrawCheckpoint, serializePortableExcalidrawScene } from '@/app/lib/excalidraw-collaboration/checkpoint';
import { resolveExcalidrawCheckpointWorkspace } from '@/app/lib/excalidraw-collaboration/checkpoint-worker';
import { applyExcalidrawScenePatch, loadExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';
import { captureExcalidrawVersion } from '@/app/lib/excalidraw-collaboration/version-history';
import { EXCALIDRAW_PORTABLE_MAX_BYTES } from '@/app/lib/excalidraw-collaboration/limits';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { ExcalidrawElementRecord } from '@/app/lib/excalidraw-collaboration/protocol';

const runChild = promisify(execFile);
const requireDependency = createRequire(import.meta.url);
const suffix = randomUUID();
const userId = `inspection-user-${suffix}`;
const organizationId = `inspection-org-${suffix}`;
const actor = { userId, actorId: `inspection-agent-${suffix}`, actorType: 'agent' as const };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const element = (id: string): ExcalidrawElementRecord => ({ id, type: 'rectangle', version: 1, versionNonce: 100,
  isDeleted: false, x: 0, y: 0, width: 100, height: 80, angle: 0, opacity: 100, groupIds: [], boundElements: [] });

async function execute(sql: string, params: unknown[] = []) {
  const database = await openDb();
  try { await database.run(sql, params); } finally { await database.close(); }
}
async function query<Row>(sql: string, params: unknown[] = []): Promise<Row[]> {
  const database = await openDb();
  try { return await database.all(sql, params) as Row[]; } finally { await database.close(); }
}
function workspace(type: 'personal' | 'team'): WorkspaceContext {
  const rootRelativePath = `workspaces/excalidraw-inspection/${suffix}/${type}/files`;
  return { workspaceId: `inspection-${type}-${suffix}`, workspaceType: type, organizationId,
    ownerUserId: type === 'personal' ? userId : null, rootRelativePath, rootPath: workspaceAbsoluteRoot(rootRelativePath),
    displayName: `Inspection ${type}`, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: true, canRunAgent: true } };
}
function readOnly(current: WorkspaceContext): WorkspaceContext {
  return { ...current, permissions: { ...current.permissions, canWrite: false, canDelete: false, canRunAgent: false } };
}
async function seed(workspaces: WorkspaceContext[]) {
  const now = Date.now();
  await execute(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
    VALUES ($1,'Checkpoint inspection',$2,1,$3,$3)`, [userId,`${userId}@example.test`,now]);
  await execute(`INSERT INTO canvas_organization_settings
    (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
    VALUES ($1,$2,'team',1,$3,$3)`, [organizationId,userId,now]);
  await execute(`INSERT INTO organization_user_permissions
    (organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
    VALUES ($1,$2,'member','active',1,$3,$3)`, [organizationId,userId,now]);
  for (const current of workspaces) {
    await fs.mkdir(current.rootPath, { recursive: true });
    await execute(`INSERT INTO canvas_workspaces
      (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$7)`, [current.workspaceId,organizationId,current.workspaceType,
      current.ownerUserId ?? null,current.rootRelativePath,current.displayName,now]);
    if (current.workspaceType === 'team') await execute(`INSERT INTO canvas_workspace_members
      (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at)
      VALUES ($1,$2,$3,'member','active',1,1,1,$4,$4)`, [organizationId,current.workspaceId,userId,now]);
  }
}

/** Production REST handler/helper, substituting only authenticated identity and rate-limit IO. */
function restGet(current: WorkspaceContext) {
  function loadModule<T>(filename: string, dependencies: Record<string, unknown>): T {
    const absolute = path.resolve(filename);
    const javascript = ts.transpileModule(readFileSync(absolute, 'utf8'), { fileName: absolute,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const evaluatedModule = { exports: {} };
    new Function('require','module','exports',javascript)((name: string) => Object.hasOwn(dependencies,name)
      ? dependencies[name] : requireDependency(name),evaluatedModule,evaluatedModule.exports);
    return evaluatedModule.exports as T;
  }
  const helpers = { jsonDatabaseUnavailable, applyRateLimit: () => null };
  const http = loadModule<Record<string, unknown>>('app/lib/excalidraw-collaboration/http.ts', {
    'server-only': {}, 'next/server': { NextRequest, NextResponse },
    '@/app/lib/api/route-helpers': helpers, '@/app/lib/workspaces/constants': { WORKSPACE_ID_HEADER: 'x-canvas-workspace-id' },
    '@/app/lib/workspaces/request': { requireRequestWorkspace: async (_request: NextRequest, input: { permissions: string }) => {
      assert.equal(input.permissions,'canRead');
      return { response: null, workspace: readOnly(current), session: { user: { id: userId }, session: { id: 'inspection-session' } } };
    } }, './scene-service': sceneService, './api-contract': apiContract, './provider': provider,
  });
  const route = loadModule<{ GET(request: NextRequest, input: { params: Promise<{ documentId: string }> }): Promise<NextResponse> }>(
    'app/api/excalidraw/scenes/[documentId]/route.ts', { 'next/server': { NextRequest, NextResponse },
      '@/app/lib/api/route-helpers': helpers, '@/app/lib/excalidraw-collaboration/api-contract': apiContract,
      '@/app/lib/excalidraw-collaboration/http': http, '@/app/lib/excalidraw-collaboration/scene-service': sceneService,
      '@/app/lib/files/workspace-mutation-lock': mutationLock });
  return async (documentId: string) => {
    const response = await route.GET(new NextRequest(`http://localhost:4135/api/excalidraw/scenes/${documentId}`),
      { params: Promise.resolve({ documentId }) });
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    const result = await response.json();
    assert.equal(result.success,true);
    return result.document as sceneService.ExcalidrawDocumentSnapshot;
  };
}

async function historyRows(current: WorkspaceContext, filePath: string, contentHash?: string) {
  return query<{ id: string; lineage_id: string; history_only: boolean }>(`SELECT revision.id,revision.lineage_id,revision.history_only
    FROM file_revisions revision JOIN file_revision_contents content ON content.revision_id=revision.id
    WHERE revision.workspace_id=$1 AND revision.path=$2 AND content.source='external_import'
      AND ($3::text IS NULL OR revision.content_hash=$3)`, [current.workspaceId,filePath,contentHash ?? null]);
}
async function revisionCount(current: WorkspaceContext, filePath: string) {
  return (await query('SELECT id FROM file_revisions WHERE workspace_id=$1 AND path=$2',[current.workspaceId,filePath])).length;
}
async function foreignInspection(current: WorkspaceContext) {
  const created = await sceneService.createExcalidrawDocument({ workspace: current, actor, path: 'external.excalidraw', idempotencyKey: randomUUID() });
  const operation = await sceneService.applyExcalidrawChanges({ workspace: current, actor, documentId: created.documentId,
    lifecycleGeneration: created.lifecycleGeneration, observedSceneSequence: created.sceneSequence,
    actions: [{ type: 'create', element: element('persisted-rectangle') }], idempotencyKey: randomUUID() });
  assert.equal(operation.status,'applied');
  assert.equal(operation.checkpoint.status,'saved');
  const original = (await loadExcalidrawScene(created.documentId))!;
  const physical = path.join(current.rootPath,created.path);
  const originalBytes = await fs.readFile(physical);
  const originalStat = await fs.stat(physical,{bigint:true});
  const count = await revisionCount(current,created.path);
  const read = restGet(current);
  assert.equal((await read(created.documentId)).checkpoint.status,'saved');
  assert.equal((await sceneService.getExcalidrawDocument({ workspace: readOnly(current), documentId: created.documentId })).checkpoint.status,'saved');
  assert.equal(await revisionCount(current,created.path),count,'Repeated saved read-only reads cannot create revisions.');
  assert.deepEqual(await fs.readFile(physical),originalBytes);
  const afterRead = await fs.stat(physical,{bigint:true});
  assert.equal(afterRead.ino,originalStat.ino);assert.equal(afterRead.mtimeNs,originalStat.mtimeNs);

  // Arbitrary foreign bytes, including invalid UTF-8, must be retained exactly.
  const foreign = Buffer.from([0xff,0xfe,0x00,0x65,0x78,0x74,0x65,0x72,0x6e,0x61,0x6c]);
  await fs.writeFile(physical,foreign);
  const alteredStat = await fs.stat(physical,{bigint:true});
  const inspected = await read(created.documentId);
  assert.equal(inspected.checkpoint.status,'failed');assert.match(inspected.checkpoint.error!,/outside the scene service/u);
  assert.equal(inspected.canonicalHash,original.canonicalHash);assert.equal(inspected.sceneSequence,original.sceneSequence);
  assert.deepEqual(inspected.elements,original.elements);assert.equal(inspected.checkpoint.revisionId,original.checkpointRevisionId);
  const persisted = (await loadExcalidrawScene(created.documentId))!;
  assert(persisted.degradedReason,'Read inspection durably discloses the conflict.');
  assert.equal(persisted.canonicalHash,original.canonicalHash);assert.equal(persisted.lifecycleGeneration,original.lifecycleGeneration);
  await sceneService.getExcalidrawDocument({ workspace: readOnly(current), documentId: created.documentId });
  const operationRead = await getExcalidrawOperation({ workspace: readOnly(current), userId, operationId: operation.operationId });
  assert.equal(operationRead.status,'applied');assert.equal(operationRead.checkpoint.status,'failed');
  const listed = await listExcalidrawOperations({ workspace: readOnly(current), userId, documentId: created.documentId });
  assert.equal(listed.find(item => item.operationId === operation.operationId)?.checkpoint.status,'failed');
  const history = await historyRows(current,created.path,hash(foreign));
  assert.equal(history.length,1,'Repeated scene/REST/operation reads deduplicate the historical foreign bytes.');
  assert.equal(history[0].history_only,true);
  const retained = await fileVersionContentStore.readRevisionContent({ workspaceId: current.workspaceId,
    lineageId: history[0].lineage_id, revisionId: history[0].id });
  assert.deepEqual(retained?.content,foreign);
  assert.deepEqual(await fs.readFile(physical),foreign,'A read-only GET must not publish or overwrite checkpoint bytes.');
  const finalStat = await fs.stat(physical,{bigint:true});
  assert.equal(finalStat.ino,alteredStat.ino);assert.equal(finalStat.mtimeNs,alteredStat.mtimeNs);
  assert.equal((await readFileCollaborationState({ workspace: current,path:created.path })).latestRevision?.id,original.checkpointRevisionId);
}

async function pendingAndCrash(current: WorkspaceContext) {
  const created = await sceneService.createExcalidrawDocument({ workspace: current,actor,path:'crash.excalidraw',idempotencyKey:randomUUID() });
  const physical = path.join(current.rootPath,created.path);
  const originalBytes = await fs.readFile(physical);
  const originalStat = await fs.stat(physical,{bigint:true});
  const patch = await applyExcalidrawScenePatch({ documentId:created.documentId,lifecycleGeneration:created.lifecycleGeneration,
    baseSequence:created.sceneSequence,messageId:randomUUID(),actorId:actor.actorId,actorType:'agent',elements:[element('durable-crash')] });
  const count = await revisionCount(current,created.path);
  const oldValid = await sceneService.getExcalidrawDocument({ workspace:readOnly(current),documentId:created.documentId });
  assert.equal(oldValid.checkpoint.status,'pending');assert.equal(oldValid.checkpoint.error,null);
  assert.deepEqual(await fs.readFile(physical),originalBytes);assert.equal(await revisionCount(current,created.path),count);
  // Seed precisely the durable receipt state left by a creator crashing after scene initialization.
  await execute("UPDATE collaboration_excalidraw_creates SET status='preparing',updated_at=0 WHERE document_id=$1",[created.documentId]);
  await assert.rejects(runChild(process.execPath,['--import','tsx','--conditions','react-server',
    'scripts/excalidraw-checkpoint-inspection-test.ts','--crash-checkpoint',created.documentId,current.workspaceId],
  {env:process.env,timeout:20_000}),error => (error as {code?:number}).code===83);
  const portable = await serializePortableExcalidrawScene(patch.state);
  assert.equal(await fs.readFile(physical,'utf8'),portable);
  assert.notEqual((await fs.stat(physical,{bigint:true})).ino,originalStat.ino);
  const crashed = (await loadExcalidrawScene(created.documentId))!;
  assert(crashed.checkpointSequence<crashed.sceneSequence);assert.equal(crashed.checkpointContentHash,hash(originalBytes));
  const pending = await sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:created.documentId});
  assert.equal(pending.checkpoint.status,'pending');assert.equal(pending.checkpoint.error,null);
  assert.equal(pending.canonicalHash,patch.state.canonicalHash);assert.equal(await revisionCount(current,created.path),count);
  const [intent] = await query<{file_dev:string;file_ino:string}>('SELECT file_dev,file_ino FROM collaboration_excalidraw_checkpoint_intents WHERE document_id=$1',[created.documentId]);
  const actualStat = await fs.stat(physical,{bigint:true});
  assert.equal(intent.file_ino,String(actualStat.ino));assert.equal(intent.file_dev,String(actualStat.dev));
  const [beforeReceipt] = await query<{file_ino:string}>('SELECT file_ino FROM collaboration_excalidraw_creates WHERE document_id=$1',[created.documentId]);
  assert.equal(beforeReceipt.file_ino,String(originalStat.ino),'Read inspection cannot rotate receipt ownership.');
  assert.equal((await historyRows(current,created.path)).length,0,'Our staged publication cannot be mistaken for foreign content.');
  await materializeExcalidrawCheckpoint({workspace:current,state:crashed});
  assert.equal((await sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:created.documentId})).checkpoint.status,'saved');
  assert.equal((await query('SELECT * FROM collaboration_excalidraw_checkpoint_intents WHERE document_id=$1',[created.documentId])).length,0);
  const [rotated] = await query<{file_ino:string}>('SELECT file_ino FROM collaboration_excalidraw_creates WHERE document_id=$1',[created.documentId]);
  assert.equal(rotated.file_ino,String(actualStat.ino),'Successful materialization rotates a pending create proof before clearing its intent.');
  await execute('UPDATE collaboration_excalidraw_creates SET updated_at=-1 WHERE document_id=$1',[created.documentId]);
  await sceneService.recoverPendingExcalidrawCreates();
  const [completed] = await query<{status:string}>('SELECT status FROM collaboration_excalidraw_creates WHERE document_id=$1',[created.documentId]);
  assert.equal(completed.status,'completed');
}

async function invalidOwnershipAndBounds(current: WorkspaceContext) {
  const created = await sceneService.createExcalidrawDocument({workspace:current,actor,path:'unproven.excalidraw',idempotencyKey:randomUUID()});
  const physical=path.join(current.rootPath,created.path);
  const foreign=Buffer.from('Matching hashes without inode proof are not owned checkpoint publications.');
  await fs.writeFile(physical,foreign);
  await execute(`INSERT INTO collaboration_excalidraw_checkpoint_intents
    (document_id,lifecycle_generation,scene_sequence,content_hash,file_dev,file_ino,created_at)
    VALUES ($1,$2,$3,$4,NULL,NULL,$5)`,[created.documentId,created.lifecycleGeneration,created.sceneSequence,hash(foreign),Date.now()]);
  assert.equal((await sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:created.documentId})).checkpoint.status,'failed');
  assert.equal((await historyRows(current,created.path,hash(foreign))).length,1);

  const oversized=await sceneService.createExcalidrawDocument({workspace:current,actor,path:'oversized.excalidraw',idempotencyKey:randomUUID()});
  const oversizedPath=path.join(current.rootPath,oversized.path);
  await fs.truncate(oversizedPath,EXCALIDRAW_PORTABLE_MAX_BYTES+1);
  const count=await revisionCount(current,oversized.path);
  const read=await sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:oversized.documentId});
  assert.equal(read.checkpoint.status,'failed');assert.match(read.checkpoint.error!,/50 MiB/u);
  assert.equal(await revisionCount(current,oversized.path),count);assert.equal((await fs.stat(oversizedPath)).size,EXCALIDRAW_PORTABLE_MAX_BYTES+1);
  const missing=await sceneService.createExcalidrawDocument({workspace:current,actor,path:'missing.excalidraw',idempotencyKey:randomUUID()});
  const missingPath=path.join(current.rootPath,missing.path);await fs.rm(missingPath);
  assert.equal((await sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:missing.documentId})).checkpoint.status,'failed');
  await assert.rejects(fs.stat(missingPath),error=>(error as NodeJS.ErrnoException).code==='ENOENT');

  const unverifiable=await sceneService.createExcalidrawDocument({workspace:current,actor,path:'unverifiable.excalidraw',idempotencyKey:randomUUID()});
  await execute('UPDATE collaboration_excalidraw_states SET checkpoint_content_hash=NULL,checkpoint_revision_id=NULL WHERE document_id=$1',[unverifiable.documentId]);
  await execute('UPDATE collaboration_documents SET snapshot_revision_id=NULL WHERE id=$1',[unverifiable.documentId]);
  const unverified=await sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:unverifiable.documentId});
  assert.equal(unverified.checkpoint.status,'failed');assert.match(unverified.checkpoint.error!,/no verifiable saved version/u);

  const fifo=await sceneService.createExcalidrawDocument({workspace:current,actor,path:'fifo.excalidraw',idempotencyKey:randomUUID()});
  const fifoPath=path.join(current.rootPath,fifo.path);await fs.rm(fifoPath);await runChild('mkfifo',[fifoPath]);
  const started=Date.now();
  const fifoRead=await sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:fifo.documentId});
  assert.equal(fifoRead.checkpoint.status,'failed');assert.match(fifoRead.checkpoint.error!,/not a regular file/u);
  assert(Date.now()-started<3_000,'O_NONBLOCK must reject a FIFO without waiting for a writer.');
}

async function authorityAfterRowLock(current: WorkspaceContext) {
  const created=await sceneService.createExcalidrawDocument({workspace:current,actor,path:'locked-acl.excalidraw',idempotencyKey:randomUUID()});
  const operation=await sceneService.applyExcalidrawChanges({workspace:current,actor,documentId:created.documentId,
    lifecycleGeneration:created.lifecycleGeneration,observedSceneSequence:created.sceneSequence,
    actions:[{type:'create',element:element('acl-persisted')}],idempotencyKey:randomUUID()});
  const physical=path.join(current.rootPath,created.path);const foreign=Buffer.from('Foreign bytes are not inspected after a blocked ACL is revoked.');
  await fs.writeFile(physical,foreign);
  const count=await revisionCount(current,created.path);
  for(const lockKind of ['scene','document','lineage'] as const) for(const kind of ['scene','operation','list'] as const) {
    const blocker=await openDb();let action:Promise<unknown>|undefined;let checks=0;let allowed=true;
    try {
      await blocker.run('BEGIN');
      const lockSql=lockKind==='scene'?'SELECT document_id FROM collaboration_excalidraw_states WHERE document_id=$1 FOR UPDATE'
        :lockKind==='document'?'SELECT id FROM collaboration_documents WHERE id=$1 FOR UPDATE'
          :`SELECT lineage.id FROM file_collaboration_lineages lineage JOIN collaboration_documents document
            ON document.lineage_id=lineage.id WHERE document.id=$1 FOR UPDATE OF lineage`;
      await blocker.get(lockSql,[created.documentId]);
      const [pid]=await blocker.all('SELECT pg_backend_pid() AS pid') as Array<{pid:number}>;
      const beforeRead=async()=>{checks+=1;return {...readOnly(current),permissions:{...readOnly(current).permissions,canRead:allowed}};};
      action=kind==='scene'?sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:created.documentId,beforeRead})
        :kind==='operation'?getExcalidrawOperation({workspace:readOnly(current),userId,operationId:operation.operationId,beforeRead})
          :listExcalidrawOperations({workspace:readOnly(current),userId,documentId:created.documentId,beforeRead});
      const denied=assert.rejects(action,error=>(error as {code?:string}).code==='EXCALIDRAW_PERMISSION_DENIED');
      const deadline=Date.now()+5_000;
      while(!(await query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid.pid])).length) {
        if(Date.now()>deadline)assert.fail(`${kind} Get must block on the actual ${lockKind} row lock.`);
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      const priorChecks=lockKind==='scene'?0:1;
      assert.equal(checks,priorChecks,'A final authority check must follow every identity row lock wait.');
      allowed=false;
      await blocker.run('COMMIT');await denied;
      assert.equal(checks,priorChecks+1);
    } finally {await blocker.run('ROLLBACK').catch(()=>undefined);await blocker.close();await action?.catch(()=>undefined);}
    assert.equal(await revisionCount(current,created.path),count,'Denied reads cannot capture foreign bytes.');
    assert.equal((await loadExcalidrawScene(created.documentId))?.degradedReason,null,'Denied reads cannot change checkpoint status.');
    assert.deepEqual(await fs.readFile(physical),foreign);
  }
}

async function authorityAfterVersionStorageLock(current: WorkspaceContext) {
  const created=await sceneService.createExcalidrawDocument({workspace:current,actor,path:'version-storage-acl.excalidraw',idempotencyKey:randomUUID()});
  const physical=path.join(current.rootPath,created.path);
  const foreign=Buffer.from(`Foreign bytes awaiting the version-storage workspace lock: ${randomUUID()}`);
  await fs.writeFile(physical,foreign);
  const count=await revisionCount(current,created.path);const original=(await loadExcalidrawScene(created.documentId))!;
  const blocker=await openDb();let action:Promise<unknown>|undefined;let checks=0;let allowed=true;
  try {
    await blocker.run('BEGIN');
    const advisoryId=createHash('sha256').update(`workspace:${current.workspaceId}`).digest().readBigInt64BE().toString();
    await blocker.get('SELECT pg_advisory_xact_lock($1::bigint)',[advisoryId]);
    const [pid]=await blocker.all('SELECT pg_backend_pid() AS pid') as Array<{pid:number}>;
    action=sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:created.documentId,
      beforeRead:async()=>{checks+=1;return {...readOnly(current),permissions:{...readOnly(current).permissions,canRead:allowed}};}});
    const denied=assert.rejects(action,error=>(error as {code?:string}).code==='EXCALIDRAW_PERMISSION_DENIED');
    const deadline=Date.now()+5_000;
    while(!(await query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid.pid])).length) {
      if(Date.now()>deadline)assert.fail('Foreign history capture must wait on the actual version-content workspace advisory lock.');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(checks,2,'Initial and post-inspection checks passed before the storage-lock wait.');
    allowed=false;await blocker.run('COMMIT');await denied;
    assert.equal(checks,3,'Post-capture authority denial must escape the history savepoint catch.');
  } finally {await blocker.run('ROLLBACK').catch(()=>undefined);await blocker.close();await action?.catch(()=>undefined);}
  assert.equal(await revisionCount(current,created.path),count,'The outer transaction rolls back the captured historical revision.');
  assert.equal((await historyRows(current,created.path,hash(foreign))).length,0);
  const persisted=(await loadExcalidrawScene(created.documentId))!;
  assert.equal(persisted.degradedReason,null);assert.equal(persisted.canonicalHash,original.canonicalHash);
  assert.equal(persisted.sceneSequence,original.sceneSequence);assert.deepEqual(await fs.readFile(physical),foreign);
}

async function controlledRestore(current: WorkspaceContext) {
  const created=await sceneService.createExcalidrawDocument({workspace:current,actor,path:'restore.excalidraw',idempotencyKey:randomUUID()});
  const originalBytes=await fs.readFile(path.join(current.rootPath,created.path));
  const targetInput={kind:'document' as const,workspaceId:current.workspaceId,documentId:created.documentId};
  const access={userId,authenticatedWorkspaceId:current.workspaceId,requestedWorkspaceId:current.workspaceId,
    membership:'active' as const,permissionsResolved:true,canRead:true,canWrite:true,canRunAgent:true,canManageWorkspace:true};
  const selected=await captureExcalidrawVersion({workspace:current,path:created.path,source:'manual',historyOnly:true,
    content:JSON.stringify({type:'excalidraw',version:2,elements:[element('selected-restored')],appState:{},files:{}})});
  const target=await fileVersionCenterQueryService.resolve({target:targetInput,access});
  const request={contractVersion:1 as const,target:targetInput,revisionId:selected.revisionId,idempotencyKey:randomUUID(),
    expectedCurrent:(await loadAuthoritativeFileVersionContent(target,current)).fence};
  const physical=path.join(current.rootPath,created.path);const foreign=Buffer.from('Explicitly approved restore baseline.');
  await fs.writeFile(physical,foreign);
  let checks=0;
  const restored=await fileVersionRestoreService.restore({request,access,workspace:current,
    beforeApply:async()=>++checks===1?current:readOnly(current)});
  assert.equal(restored.outcome,'restored');assert.equal(restored.checkpoint?.status,'failed');
  const count=await revisionCount(current,created.path);
  const inspected=await sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:created.documentId});
  assert.equal(inspected.lifecycleGeneration,2);assert.equal(inspected.elements[0].id,'selected-restored');
  assert.equal(inspected.checkpoint.status,'failed');assert.doesNotMatch(inspected.checkpoint.error!,/outside the scene service/u);
  assert.equal(await revisionCount(current,created.path),count,'Already approved/preserved restore baseline cannot be reclassified on read.');
  assert.deepEqual(await fs.readFile(physical),foreign);
  await fs.writeFile(`${physical}.replacement`,originalBytes);await fs.rename(`${physical}.replacement`,physical);
  const replacement=await sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:created.documentId});
  assert.equal(replacement.checkpoint.status,'failed');assert.match(replacement.checkpoint.error!,/outside the scene service/u);
  assert.equal((await historyRows(current,created.path,hash(originalBytes))).length,1,
    'A pending restore requires its approved inode even if a replacement matches the previous checkpoint hash.');
  assert.deepEqual(await fs.readFile(physical),originalBytes);
  const retry={...request,idempotencyKey:randomUUID(),expectedCurrent:(await loadAuthoritativeFileVersionContent(target,current)).fence};
  const recovered=await fileVersionRestoreService.restore({request:retry,access,workspace:current,beforeApply:async()=>current});
  assert.equal(recovered.checkpoint?.status,'saved');
  assert.equal((await sceneService.getExcalidrawDocument({workspace:readOnly(current),documentId:created.documentId})).checkpoint.status,'saved');
}

async function main() {
  assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.CANVAS_DATABASE_PROVIDER,'postgres');
  assert.match(new URL(process.env.DATABASE_URL!).pathname,/^\/canvas_excalidraw_test_[a-f0-9]{16}$/u);
  if(process.argv[2]==='--crash-checkpoint') {
    const state=await loadExcalidrawScene(process.argv[3]);const current=await resolveExcalidrawCheckpointWorkspace(process.argv[4]);
    assert(state&&current);
    setFileCollaborationConnectionFactoryForTests(async()=>{
      const connection=await openDb();return {...connection,run:async(sql,params)=>{
        if(/UPDATE collaboration_excalidraw_states\s+SET checkpoint_sequence/u.test(sql))process.exit(83);
        return connection.run(sql,params);
      }};
    });
    await materializeExcalidrawCheckpoint({workspace:current,state});assert.fail('The checkpoint process must crash after fsync publication.');
  }
  const workspaces=[workspace('personal'),workspace('team')];
  try {
    await seed(workspaces);
    for(const current of workspaces) {
      await foreignInspection(current);await pendingAndCrash(current);await invalidOwnershipAndBounds(current);
      await authorityAfterRowLock(current);
    }
    await authorityAfterVersionStorageLock(workspaces[0]);
    await controlledRestore(workspaces[1]);
    console.log(JSON.stringify({success:true,nativePostgres:true,realFilesystem:true,substitutedRestIdentityIO:true,
      workspaces:workspaces.map(current=>current.workspaceType),readonlySavedNoSideEffects:true,
      externalGetFailedWithExactHistory:true,operationGetAndListFailed:true,historyDeduplicated:true,
      pgScenePreserved:true,pendingOldCheckpointValid:true,realAfterFsyncProcessCrashRecoverable:true,
      pendingCreateOwnershipRotatedOnlyByMaterializer:true,unprovenIntentRejected:true,
      boundedAndMissingReads:true,nonblockingFifoRejected:true,unverifiableBaselineFailed:true,
      freshAuthorityAfterSceneDocumentAndLineageRowLocks:true,historyRollbackAfterVersionStorageLockRevocation:true,
      controlledRestoreBaselinePreserved:true,restoreForeignInodeSameHashRejected:true}));
  } finally {
    for(const current of workspaces) {
      await execute('DELETE FROM collaboration_excalidraw_creates WHERE workspace_id=$1',[current.workspaceId]).catch(()=>undefined);
      await execute("UPDATE canvas_workspaces SET status='archived' WHERE id=$1",[current.workspaceId]).catch(()=>undefined);
      await fs.rm(current.rootPath,{recursive:true,force:true});
    }
  }
}
void main().finally(closeDatabaseConnections);
