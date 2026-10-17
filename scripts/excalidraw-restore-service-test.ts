import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { closeDatabaseConnections, openDb } from '@/app/lib/db';
import { setFileCollaborationConnectionFactoryForTests } from '@/app/lib/files/collaboration-repository';
import { archiveFileCollaborationPaths, moveFileCollaborationPath, restoreFileCollaborationPath } from '@/app/lib/files/collaboration-policy';
import { renameWorkspacePath } from '@/app/lib/files/rename-service';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
import { fileVersionRestoreService } from '@/app/lib/file-version-center/restore-service';
import { loadAuthoritativeFileVersionContent } from '@/app/lib/file-version-center/authoritative-content';
import { FILE_VERSION_CENTER_ERROR_CODES, type FileVersionRestoreRequestV1 } from '@/app/lib/file-version-center/contracts/v1';
import { createExcalidrawDocument, getExcalidrawDocument } from '@/app/lib/excalidraw-collaboration/scene-service';
import { createExcalidrawAgentOperation, getExcalidrawAgentOperation } from '@/app/lib/excalidraw-collaboration/agent-operations';
import { applyExcalidrawScenePatch, loadExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';
import { materializeExcalidrawCheckpoint } from '@/app/lib/excalidraw-collaboration/checkpoint';
import { flushPendingExcalidrawCheckpoints, resolveExcalidrawCheckpointWorkspace } from '@/app/lib/excalidraw-collaboration/checkpoint-worker';
import { loadExcalidrawAsset } from '@/app/lib/excalidraw-collaboration/assets';
import { captureExcalidrawVersion, createExcalidrawVersionContentStore } from '@/app/lib/excalidraw-collaboration/version-history';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const runChild = promisify(execFile);

async function execute(sql: string, params: unknown[] = []) {
  const db = await openDb();
  try { await db.run(sql, params); } finally { await db.close(); }
}
async function query<Row>(sql: string, params: unknown[] = []): Promise<Row[]> {
  const db = await openDb();
  try { return await db.all(sql, params) as Row[]; } finally { await db.close(); }
}
async function waitForBlockedConnection(blockerPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [blockerPid])).length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Restore must wait on the real PostgreSQL scene lock.');
}
async function childMode() {
  if (process.argv[2] !== '--crash-restore') return false;
  const state = await loadExcalidrawScene(process.argv[3]);
  const workspace = await resolveExcalidrawCheckpointWorkspace(process.argv[4]);
  assert(state && workspace);
  setFileCollaborationConnectionFactoryForTests(async () => {
    const db = await openDb();
    return { ...db, run: async (sql, params) => {
      if (/UPDATE collaboration_excalidraw_states\s+SET checkpoint_sequence/u.test(sql)) process.exit(73);
      return db.run(sql, params);
    } };
  });
  await materializeExcalidrawCheckpoint({ state, workspace });
  assert.fail('The restore crash point must run after physical publication.');
}

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/canvas_excalidraw_test_[a-f0-9]{16}$/u);
  if (await childMode()) return;
  // The root task has migrated the existing managed disposable database once.
  const suffix = randomUUID();
  const userId = `restore-user-${suffix}`;
  const organizationId = `restore-org-${suffix}`;
  const rootRelativePath = `workspaces/excalidraw-restore-test/${suffix}/files`;
  const workspace: WorkspaceContext = {
    workspaceId: `restore-team-${suffix}`,workspaceType:'team',organizationId,status:'active',legacy:false,
    rootPath:workspaceAbsoluteRoot(rootRelativePath),rootRelativePath,
    permissions:{canRead:true,canWrite:true,canDelete:true,canCreatePublicLinks:false,canManageWorkspace:true,canRunAgent:true},
  };
  const actor = { userId,actorId:`restore-agent-${suffix}`,actorType:'agent' as const };
  const access = {userId,authenticatedWorkspaceId:workspace.workspaceId,requestedWorkspaceId:workspace.workspaceId,
    membership:'active' as const,permissionsResolved:true,canRead:true,canWrite:true,canRunAgent:true,canManageWorkspace:true};
  const now = Date.now();
  await execute(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
    VALUES ($1,'Restore fixture',$2,1,$3,$3)`, [userId,`${userId}@example.test`,now]);
  await execute(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
    VALUES ($1,$2,'team',1,$3,$3)`, [organizationId,userId,now]);
  await execute(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
    VALUES ($1,$2,'team',$3,'Restore fixture','active',$4,$4)`, [workspace.workspaceId,organizationId,rootRelativePath,now]);
  await execute(`INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at)
    VALUES ($1,$2,$3,'member','active',1,1,1,$4,$4)`, [organizationId,workspace.workspaceId,userId,now]);
  await fs.mkdir(workspace.rootPath,{recursive:true});
  async function authority() {
    const [member] = await query<{can_write:boolean;status:string}>('SELECT can_write,status FROM canvas_workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspace.workspaceId,userId]);
    return {...workspace,actor:{userId,role:'member'},permissions:{...workspace.permissions,canWrite:member?.status==='active'&&Boolean(member.can_write)}};
  }
  try {
    const created = await createExcalidrawDocument({workspace,actor,path:'history.excalidraw',idempotencyKey:randomUUID()});
    const targetInput = {kind:'document' as const,workspaceId:workspace.workspaceId,documentId:created.documentId};
    async function target() { return fileVersionCenterQueryService.resolve({target:targetInput,access}); }
    async function request(revisionId: string): Promise<FileVersionRestoreRequestV1> {
      const resolved = await target();
      return {contractVersion:1,target:targetInput,revisionId,idempotencyKey:randomUUID(),
        expectedCurrent:(await loadAuthoritativeFileVersionContent(resolved,workspace)).fence};
    }
    const assetId = `historical-image-${suffix}`;
    // An incompressible binary asset gives genuine portable content above 10 MiB.
    const image = randomBytes(8*1024*1024);
    Buffer.from('89504e470d0a1a0a','hex').copy(image);
    const portable = `${JSON.stringify({type:'excalidraw',version:2,source:'historical-fixture',
      elements:[{id:'historical-image',type:'image',version:7,versionNonce:73,isDeleted:false,x:3,y:4,width:100,height:100,fileId:assetId}],
      appState:{viewBackgroundColor:'#ffeeee'},files:{[assetId]:{id:assetId,mimeType:'image/png',
        dataURL:`data:image/png;base64,${image.toString('base64')}`,created:123,version:3}}},null,2)}\n\n`;
    assert(Buffer.byteLength(portable)>10*1024*1024);
    const selected = await captureExcalidrawVersion({workspace,path:created.path,content:portable,source:'manual',historyOnly:true});
    const readLarge = await createExcalidrawVersionContentStore().readRevisionContent({revisionId:selected.revisionId,
      workspaceId:workspace.workspaceId,lineageId:selected.lineageId});
    assert.equal(readLarge?.content.toString(),portable,'Retained versions must decompress through the 50 MiB scene budget.');
    const physical = path.join(workspace.rootPath,created.path);
    await fs.writeFile(physical,'Externally changed portable bytes\n');
    const firstRequest = await request(selected.revisionId);
    const restored = await fileVersionRestoreService.restore({request:firstRequest,access,workspace,beforeApply:authority});
    assert.equal(restored.lifecycleGeneration,2);assert.equal(restored.sceneSequence,1);assert.equal(restored.checkpoint?.status,'saved');
    assert.equal(await fs.readFile(physical,'utf8'),portable,'Restore publishes the exact selected bytes, including formatting.');
    assert.equal(restored.current.sha256,digest(portable));
    const loadedAsset = await loadExcalidrawAsset({workspaceId:workspace.workspaceId,fileId:assetId});
    assert(loadedAsset);assert.deepEqual(loadedAsset.data,image);
    const scene = await getExcalidrawDocument({workspace,actor,documentId:created.documentId});
    assert.equal(scene.elements[0].id,'historical-image');assert.equal(scene.assets[0].contentHash,digest(image));
    const timeline = await fileVersionCenterQueryService.timeline({target:targetInput,access,workspace,limit:50});
    assert(timeline.capabilities.history&&timeline.capabilities.restore);assert.equal(timeline.capabilities.compare,false);
    assert(timeline.entries.some(entry=>entry.kind==='revision'&&entry.revisionId===restored.restoredRevisionId&&entry.source==='restore'&&entry.restorable));
    const state = (await loadExcalidrawScene(created.documentId))!;
    const pending = await createExcalidrawAgentOperation({workspace,documentId:state.documentId,lifecycleGeneration:state.lifecycleGeneration,
      observedSceneSequence:state.sceneSequence,initiatedByUserId:userId,actorId:actor.actorId,idempotencyKey:randomUUID(),
      actions:[{type:'update',elementId:'historical-image',expectedVersion:6,expectedVersionNonce:1,
        element:{...state.elements[0],version:8,versionNonce:99,x:99}}]});
    assert.equal(pending.status,'needs_review');
    const sameRequest = await request(selected.revisionId);
    const same = await fileVersionRestoreService.restore({request:sameRequest,access,workspace,beforeApply:authority});
    assert.equal(same.lifecycleGeneration,3);assert.equal(same.sceneSequence,2);
    assert.notEqual(same.restoredRevisionId,restored.restoredRevisionId,'Identical bytes still produce a new restore event.');
    assert.notEqual(same.current.stateVectorHash,restored.current.stateVectorHash);
    assert.equal((await getExcalidrawAgentOperation({workspace,userId,operationId:pending.operationId}))?.status,'cancelled');
    const repeat = await fileVersionRestoreService.restore({request:sameRequest,access,workspace,beforeApply:authority});
    assert.equal(repeat.outcome,'already_restored');assert.equal(repeat.lifecycleGeneration,3);assert.equal(repeat.restoredRevisionId,same.restoredRevisionId);
    await assert.rejects(fileVersionRestoreService.restore({request:{...sameRequest,revisionId:created.checkpoint.revisionId!},access,workspace}),code(FILE_VERSION_CENTER_ERROR_CODES.conflict));
    await assert.rejects(applyExcalidrawScenePatch({documentId:state.documentId,lifecycleGeneration:2,baseSequence:state.sceneSequence,
      messageId:randomUUID(),elements:[],actorId:userId,actorType:'user'}));

    // A missing portable file can only be recreated by the committed restore journal.
    await fs.rm(physical);
    const missing = await fileVersionRestoreService.restore({request:await request(selected.revisionId),access,workspace,beforeApply:authority});
    assert.equal(missing.checkpoint?.status,'saved');assert.equal(await fs.readFile(physical,'utf8'),portable);

    // Inject an unknown replacement after the scene+journal commit and before checkpoint publication.
    const foreign = Buffer.from('A different occupant arrived after restore commit.\n');
    let inject = true;
    setFileCollaborationConnectionFactoryForTests(async()=>{
      const db = await openDb();let restoring=false;
      return {...db,run:async(sql,params)=>{
        if (/INSERT INTO collaboration_excalidraw_restores/u.test(sql)) restoring=true;
        const result=await db.run(sql,params);
        if (restoring&&sql==='COMMIT'&&inject) {inject=false;await fs.rm(physical);await fs.writeFile(physical,foreign);}
        return result;
      }};
    });
    const raceRequest=await request(selected.revisionId);
    const raced=await fileVersionRestoreService.restore({request:raceRequest,access,workspace,beforeApply:authority});
    setFileCollaborationConnectionFactoryForTests(null);
    assert.equal(raced.outcome,'restored');assert.equal(raced.checkpoint?.status,'failed');
    assert.deepEqual(await fs.readFile(physical),foreign,'A committed scene restore cannot adopt an unknown filesystem replacement.');
    const externalRows=await query<{id:string}>(`SELECT revision.id FROM file_revisions revision JOIN file_revision_contents contents
      ON contents.revision_id=revision.id WHERE revision.lineage_id=$1 AND revision.content_hash=$2
        AND revision.history_only=true AND contents.source='external_import'`,[selected.lineageId,digest(foreign)]);
    assert(externalRows.length);
    const resumed=await fileVersionRestoreService.restore({request:raceRequest,access,workspace,beforeApply:authority});
    assert.equal(resumed.outcome,'already_restored');assert.equal(resumed.lifecycleGeneration,raced.lifecycleGeneration);
    assert.equal(resumed.checkpoint?.status,'failed');assert.deepEqual(await fs.readFile(physical),foreign);
    const recovered=await fileVersionRestoreService.restore({request:await request(selected.revisionId),access,workspace,beforeApply:authority});
    assert.equal(recovered.checkpoint?.status,'saved');assert.equal(await fs.readFile(physical,'utf8'),portable);

    // A real fsync→SQL process crash recovers only with the staged inode journal proof.
    // Different approved bytes force the child to publish before its SQL crash.
    await fs.writeFile(physical,'crash approved baseline');
    let afterCommit=false;
    setFileCollaborationConnectionFactoryForTests(async()=>{
      const db=await openDb();let restoring=false;
      return {...db,run:async(sql,params)=>{
        if (/INSERT INTO collaboration_excalidraw_restores/u.test(sql)) restoring=true;
        const result=await db.run(sql,params);
        if(restoring&&sql==='COMMIT'){afterCommit=true;}
        return result;
      }};
    });
    const crashPrepared=await fileVersionRestoreService.restore({request:await request(selected.revisionId),access,workspace,
      beforeApply:async()=>afterCommit?{...workspace,permissions:{...workspace.permissions,canWrite:false}}:authority()});
    setFileCollaborationConnectionFactoryForTests(null);
    assert.equal(crashPrepared.checkpoint?.status,'failed');
    await assert.rejects(runChild(process.execPath,[...process.execArgv,path.resolve('scripts/excalidraw-restore-service-test.ts'),
      '--crash-restore',created.documentId,workspace.workspaceId]),error=>(error as {code?:number}).code===73);
    assert.equal(await fs.readFile(physical,'utf8'),portable);
    const crashState=(await loadExcalidrawScene(created.documentId))!;
    // An identical hash cannot transfer a pending restore publication to a foreign inode.
    await fs.rename(physical,`${physical}.owned-staging-proof`);
    await fs.writeFile(physical,portable);
    await assert.rejects(materializeExcalidrawCheckpoint({state:crashState,workspace}),code('EXCALIDRAW_CHECKPOINT_CONFLICT'));
    assert.equal(await fs.readFile(physical,'utf8'),portable);
    assert((await loadExcalidrawScene(created.documentId))!.checkpointSequence<crashState.sceneSequence);
    await fs.rm(physical);
    await fs.rename(`${physical}.owned-staging-proof`,physical);
    await materializeExcalidrawCheckpoint({state:crashState,workspace});
    assert.equal((await loadExcalidrawScene(created.documentId))?.checkpointSequence,crashState.sceneSequence);
    assert.equal(await fs.readFile(physical,'utf8'),portable);

    // Revocation while waiting on the advisory lock must prevent the generation commit.
    const revokedRequest=await request(selected.revisionId);
    const blocker=await openDb();
    await blocker.run('BEGIN');await blocker.get('SELECT pg_advisory_xact_lock(hashtext($1))',[`excalidraw:${created.documentId}`]);
    const [pid]=await blocker.all('SELECT pg_backend_pid() AS pid') as Array<{pid:number}>;
    const waiting=fileVersionRestoreService.restore({request:revokedRequest,access,workspace,beforeApply:authority});
    const denied=assert.rejects(waiting,code(FILE_VERSION_CENTER_ERROR_CODES.accessDenied));
    await waitForBlockedConnection(pid.pid);
    await execute('UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id=$2',[workspace.workspaceId,userId]);
    await blocker.run('COMMIT');await blocker.close();await denied;
    assert.equal((await loadExcalidrawScene(created.documentId))?.lifecycleGeneration,crashState.lifecycleGeneration);
    await execute('UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id=$2',[workspace.workspaceId,userId]);

    const renameResult=await renameWorkspacePath({workspace,oldPath:created.path,newPath:'renamed.excalidraw',overwrite:false,fileOptions:{workspace}});
    assert(renameResult);
    const renamed=await getExcalidrawDocument({workspace,actor,documentId:created.documentId});
    assert.equal(renamed.documentId,created.documentId);assert.equal(renamed.path,'renamed.excalidraw');
    const renamedResolved=await target();assert.equal(renamedResolved.path,renamed.path);
    await assert.rejects(moveFileCollaborationPath({workspace,oldPath:renamed.path,newPath:'bypass.txt'}),code('EXCALIDRAW_EXTENSION_REQUIRED'));
    const trashEntryId=randomUUID();
    await archiveFileCollaborationPaths({workspace,paths:[{path:renamed.path,trashEntryId}]});
    const deleted=(await loadExcalidrawScene(created.documentId,true))!;assert.equal(deleted.status,'archived');
    assert(deleted.lifecycleGeneration>renamed.lifecycleGeneration);
    await restoreFileCollaborationPath({workspace,path:renamed.path,trashEntryId});
    const revived=(await loadExcalidrawScene(created.documentId))!;assert.equal(revived.status,'active');
    assert(revived.lifecycleGeneration>deleted.lifecycleGeneration);
    const flush=await flushPendingExcalidrawCheckpoints({workspaceId:workspace.workspaceId,paths:[renamed.path],forceValidation:true});
    assert.equal(flush.failedDocumentIds.length,0);
    console.log('Excalidraw >10MiB retained bytes/assets, exact restore/checkpoint, same-byte generation, lifecycle/rename, idempotence, unknown occupants, fsync crash recovery and real-lock permission revocation verified.');
  } finally {
    setFileCollaborationConnectionFactoryForTests(null);
    await execute("UPDATE canvas_workspaces SET status='archived' WHERE id=$1",[workspace.workspaceId]);
    await fs.rm(workspace.rootPath,{recursive:true,force:true});
  }
}
main().finally(()=>closeDatabaseConnections()).catch(error=>{console.error(error);process.exitCode=1;});
