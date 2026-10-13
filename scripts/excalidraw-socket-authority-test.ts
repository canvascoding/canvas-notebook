import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { auth } from '@/app/lib/auth';
import { resolveUserProfile } from '@/app/lib/user-profile/service';
import { closeDatabaseConnections, openDb } from '@/app/lib/db';
import { issueCollaborationTicket } from '@/app/lib/collaboration/ticket';
import { createExcalidrawDocument, applyExcalidrawChanges } from '@/app/lib/excalidraw-collaboration/scene-service';
import { loadExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { resolveExistingPostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import { getConfiguredTrustedOrigins } from '@/app/lib/security/trusted-origins';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { renameWorkspacePath } from '@/app/lib/files/rename-service';
import { createExcalidrawCollaborationServer, flushExcalidrawCollaborationDocuments } from '@/server/excalidraw-collaboration/server';
import { applyExcalidrawSocketPatch, createExcalidrawAuthorizedDelivery, ExcalidrawSocketAuthorityError,
  type ExcalidrawSocketScope } from '@/server/excalidraw-collaboration/socket-authority';

async function query<Row>(sql: string, params: unknown[] = []): Promise<Row[]> {
  const db = await openDb();
  try { return await db.all(sql, params) as Row[]; } finally { await db.close(); }
}
async function execute(sql: string, params: unknown[] = []) { await query(sql, params); }
async function waitUntil(test: () => boolean | Promise<boolean>, reason: string) {
  const deadline = Date.now() + 7_000;
  while (!await test()) {
    if (Date.now() >= deadline) assert.fail(reason);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const authorityError = (error: unknown) => error instanceof ExcalidrawSocketAuthorityError;

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  assert.equal(process.env.NODE_ENV, 'development');
  const metadataPath = process.argv[2];
  assert(metadataPath && path.isAbsolute(metadataPath), 'The existing private managed QA metadata is required.');
  const metadata = JSON.parse(await fs.readFile(metadataPath,'utf8')) as {
    purpose:string;appRoot:string;dataRoot:string;databaseName:string;cloneOid:string;origin:string;source:string;
  };
  assert.equal(metadata.purpose,'isolated-local-Excalidraw-QA-fixture');
  assert.equal(metadata.source,'existing-managed-stack');
  assert.equal(await fs.realpath(metadata.appRoot),await fs.realpath(process.cwd()));
  assert.equal(await fs.realpath(metadata.dataRoot),await fs.realpath(process.env.DATA!));
  assert.equal(path.dirname(metadataPath),path.dirname(metadata.dataRoot));
  assert.equal((await fs.stat(path.dirname(metadataPath))).mode&0o777,0o700);
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  assert.equal(databaseUrl.hostname,'127.0.0.1');assert.equal(databaseUrl.port,'55433');
  assert.match(databaseUrl.pathname,/^\/canvas_excalidraw_e2e_[a-f0-9]{16}$/u);
  assert.equal(databaseUrl.pathname.slice(1),metadata.databaseName);
  const [databaseIdentity] = await query<{name:string;oid:string}>(`SELECT current_database() AS name,oid::text AS oid
    FROM pg_database WHERE datname=current_database()`);
  assert.equal(databaseIdentity.name,metadata.databaseName);assert.equal(databaseIdentity.oid,metadata.cloneOid);
  process.env.CANVAS_COLLABORATION_TICKET_SECRET ??= randomBytes(32).toString('hex');
  const suffix = randomUUID();
  type OwnedSession = {id:string;token:string;cookie:string;userId:string;user:{id:string;email:string;role:string}};
  const sessions = new Map<string,OwnedSession>();
  async function login(email: string|undefined,password: string|undefined):Promise<OwnedSession> {
    assert(email&&password,'Private managed QA login credentials must be present.');
    const response = await fetch(`${metadata.origin}/api/auth/sign-in/email`,{method:'POST',
      headers:{'content-type':'application/json',origin:metadata.origin},body:JSON.stringify({email,password})});
    assert.equal(response.status,200,'The dedicated QA HTTP login failed.');
    const body = await response.json() as {token?:string;user?:{id:string;email:string;role:string}};
    assert(body.token&&body.user?.id,'HTTP login must issue an owned real session.');
    const cookie=response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');
    const receipt=await fetch(`${metadata.origin}/api/auth/get-session`,{headers:{cookie,origin:metadata.origin}});
    assert.equal(receipt.status,200);
    const current=await receipt.json() as {session?:{id:string};user?:{id:string;email:string;role:string}};
    assert(current.session?.id&&current.user?.id===body.user.id,'HTTP get-session must prove the login identity.');
    const session={id:current.session.id,token:body.token,cookie,userId:body.user.id,user:current.user};
    sessions.set(session.userId,session);
    return session;
  }
  const ownerSession=await login(process.env.BOOTSTRAP_ADMIN_EMAIL,process.env.BOOTSTRAP_ADMIN_PASSWORD);
  const viewerSession=await login(process.env.TEST_SECONDARY_EMAIL,process.env.TEST_SECONDARY_PASSWORD);
  const ownerId=ownerSession.userId;const viewerId=viewerSession.userId;
  assert.notEqual(ownerId,viewerId);
  async function requestApi(relative:string,body:unknown) {
    const response=await fetch(`${metadata.origin}${relative}`,{method:'POST',
      headers:{'content-type':'application/json',cookie:ownerSession.cookie,origin:metadata.origin},body:JSON.stringify(body)});
    assert(response.ok,`The owned workspace API request failed (${response.status}).`);
    return response.json() as Promise<Record<string,unknown>>;
  }
  const createdWorkspace=await requestApi('/api/workspaces',{type:'team',name:`Socket authority QA ${suffix}`});
  const workspaceId=(createdWorkspace.workspace as {id:string}).id;assert(workspaceId);
  const workspace=await resolveExistingPostgresWorkspaceForActor(resolveWorkspaceActor(ownerSession.user),workspaceId);
  assert(workspace?.permissions.canWrite&&workspace.workspaceType==='team'&&workspace.rootRelativePath);
  assert.equal(workspace.rootPath,workspaceAbsoluteRoot(workspace.rootRelativePath));
  const organizationId=workspace.organizationId;
  async function member(canRead=true,canWrite=true) {
    await requestApi(`/api/workspaces/${workspaceId}/members`,{userId:viewerId,role:'member',canRead,canWrite,canManage:false});
  }
  await member();
  const actor = {userId:ownerId,actorId:`socket-agent-${suffix}`,actorType:'agent' as const};
  const created = await createExcalidrawDocument({workspace,actor,path:'live.excalidraw',idempotencyKey:randomUUID()});
  function scope(userId=viewerId,path=created.path):ExcalidrawSocketScope {
    const session = sessions.get(userId)!;
    return {workspace:workspace!,requestHeaders:new Headers({authorization:`Bearer ${session.token}`,cookie:session.cookie}),isOpen:()=>true,
      claims:issueCollaborationTicket({userId,sessionId:session.id,workspaceId:workspace.workspaceId,organizationId,
        documentId:created.documentId,path,provider:'excalidraw',representation:'excalidraw_scene',permission:'write',
        lifecycleGeneration:created.lifecycleGeneration}).claims};
  }
  const verifiedSession=await auth.api.getSession({headers:scope().requestHeaders});
  assert.equal(verifiedSession?.user.id,viewerId,'The actual Better Auth session must remain usable in the licensed fixture.');
  const http = createServer();
  let holdProfile=false;
  let enteredProfile:()=>void=()=>{};
  let releaseProfile:()=>void=()=>{};
  const wss = createExcalidrawCollaborationServer(http,{resolveProfile:async input=>{
    const profile=await resolveUserProfile(input);
    if(holdProfile&&input.userId===viewerId){
      enteredProfile();
      await new Promise<void>(resolve=>{releaseProfile=resolve;});
    }
    return profile;
  }});
  let awaitedMessageId: string | null = null;
  let messageReceived: (() => void) | null = null;
  wss.on('connection',peer=>peer.on('message',raw=>{
    const message=JSON.parse(raw.toString()) as {messageId?:string};
    if(message.messageId===awaitedMessageId)messageReceived?.();
  }));
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const address = http.address();assert(address&&typeof address==='object');
  const origin = getConfiguredTrustedOrigins().find(origin=>origin.startsWith('http'))!;
  const peers = new Set<WebSocket>();
  type Message = {type:string;replyTo?:string;sceneSequence?:number;snapshot?:{sceneSequence:number};[key:string]:unknown};
  async function connect(userId=viewerId,expectInit=true) {
    const authority = scope(userId);
    const ticket = issueCollaborationTicket({userId,sessionId:authority.claims.sessionId,workspaceId:workspace.workspaceId,
      organizationId,documentId:created.documentId,path:created.path,provider:'excalidraw',representation:'excalidraw_scene',
      permission:'write',lifecycleGeneration:created.lifecycleGeneration});
    const socket = new WebSocket(`ws://127.0.0.1:${address!.port}/ws/collaboration/excalidraw`,{
      headers:{authorization:authority.requestHeaders.get('authorization')!,cookie:authority.requestHeaders.get('cookie')!,origin},
    });
    peers.add(socket);
    const messages:Message[]=[];let closeCode:number|null=null;
    socket.on('message',raw=>messages.push(JSON.parse(raw.toString()) as Message));
    socket.on('close',code=>{closeCode=code;});
    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    socket.send(JSON.stringify({type:'authenticate',token:ticket.token}));
    await waitUntil(()=>messages.some(message=>message.type==='scene:init')||closeCode!==null,'The real WebSocket did not initialize.');
    if(expectInit){assert.equal(closeCode,null);assert(messages.some(message=>message.type==='scene:init'));}
    return {socket,messages,closed:()=>closeCode};
  }
  async function grant() {
    await member();
  }
  async function revokeRead() {
    await member(false,false);
  }
  const frame = (type:string,payload:unknown={},messageId=randomUUID()) => ({schemaVersion:1,type,messageId,
    lifecycleGeneration:created.lifecycleGeneration,baseSequence:0,payload});
  try {
    holdProfile=true;
    const profileEntered=new Promise<void>(resolve=>{enteredProfile=resolve;});
    const authenticating=connect(viewerId,false);
    await profileEntered;
    await revokeRead();
    holdProfile=false;releaseProfile();
    const initiallyRevoked=await authenticating;
    assert.equal(initiallyRevoked.closed(),4403);assert.deepEqual(initiallyRevoked.messages,[],
      'Revocation during the real profile await cannot leak the old initial scene.');
    await grant();
    const viewer = await connect();
    await revokeRead();
    const afterRevocation = viewer.messages.length;
    const state = (await loadExcalidrawScene(created.documentId))!;
    await applyExcalidrawChanges({workspace,actor,documentId:created.documentId,lifecycleGeneration:state.lifecycleGeneration,
      observedSceneSequence:state.sceneSequence,idempotencyKey:randomUUID(),
      actions:[{type:'create',element:{id:'new-secret-element',type:'rectangle',version:1,versionNonce:11,isDeleted:false,x:1,y:2,width:3,height:4}}]});
    await waitUntil(()=>viewer.closed()!==null,'A revoked reader remained open during a real broadcast.');
    assert.equal(viewer.closed(),4403);
    assert.equal(viewer.messages.length,afterRevocation,'No applied/status/presence data is delivered after read revocation.');
    for(const type of ['scene:resync_request','scene:ack']) {
      await grant();const peer=await connect();await revokeRead();const before=peer.messages.length;
      peer.socket.send(JSON.stringify(frame(type,{sceneSequence:0})));
      await waitUntil(()=>peer.closed()!==null,'A revoked resync/ack caller remained open.');
      assert.equal(peer.closed(),4403);assert.equal(peer.messages.length,before);
    }
    await grant();
    // A delivery already queued behind the real scene lock must check revocation after that wait.
    const blocker=await openDb();await blocker.run('BEGIN');
    await blocker.get('SELECT pg_advisory_xact_lock(hashtext($1))',[`excalidraw:${created.documentId}`]);
    const [pid]=await blocker.all('SELECT pg_backend_pid() AS pid') as Array<{pid:number}>;
    const seen:number[]=[];let rejected=0;
    const deliver=createExcalidrawAuthorizedDelivery(scope(),()=>{rejected+=1;});
    const queued=deliver(state=>seen.push(state.sceneSequence));
    await waitUntil(async()=>Boolean((await query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid.pid])).length),
      'The outgoing delivery must wait for the real scene lock.');
    await revokeRead();await blocker.run('COMMIT');await blocker.close();await queued;
    assert.equal(rejected,1);assert.deepEqual(seen,[]);
    await grant();
    const deliveryOrder:number[]=[];
    const ordered=createExcalidrawAuthorizedDelivery(scope(),error=>{throw error;});
    await Promise.all([ordered(()=>deliveryOrder.push(1)),ordered(()=>deliveryOrder.push(2)),ordered(()=>deliveryOrder.push(3))]);
    assert.deepEqual(deliveryOrder,[1,2,3]);
    // Session deletion is visible on the next delivery, independently of workspace ACLs.
    const sessionPeer=await connect();const beforeSessionRevocation=sessionPeer.messages.length;
    const owned=sessions.get(viewerId)!;
    await execute('DELETE FROM "session" WHERE id=$1 AND user_id=$2 AND token=$3',[owned.id,viewerId,owned.token]);
    sessionPeer.socket.send(JSON.stringify(frame('scene:resync_request')));
    await waitUntil(()=>sessionPeer.closed()!==null,'A deleted session remained usable.');
    assert.equal(sessionPeer.closed(),4403);assert.equal(sessionPeer.messages.length,beforeSessionRevocation);
    await login(process.env.TEST_SECONDARY_EMAIL,process.env.TEST_SECONDARY_PASSWORD);
    const staleSessionScope=scope();staleSessionScope.claims={...staleSessionScope.claims,sessionId:'different-session'};
    await assert.rejects(applyExcalidrawSocketPatch(staleSessionScope,{baseSequence:1,messageId:randomUUID(),elements:[]}),authorityError);
    const otherUserScope=scope();otherUserScope.claims={...otherUserScope.claims,userId:ownerId};
    await assert.rejects(applyExcalidrawSocketPatch(otherUserScope,{baseSequence:1,messageId:randomUUID(),elements:[]}),authorityError);
    // A write waiting on the scene lock sees current write permission after the lock is acquired.
    const writeBlocker=await openDb();await writeBlocker.run('BEGIN');
    await writeBlocker.get('SELECT pg_advisory_xact_lock(hashtext($1))',[`excalidraw:${created.documentId}`]);
    const [writePid]=await writeBlocker.all('SELECT pg_backend_pid() AS pid') as Array<{pid:number}>;
    const beforeWrite=(await loadExcalidrawScene(created.documentId))!;
    const write=applyExcalidrawSocketPatch(scope(),{baseSequence:beforeWrite.sceneSequence,messageId:randomUUID(),
      elements:[{id:'denied-write',type:'rectangle',version:1,versionNonce:12,isDeleted:false,x:1,y:1,width:1,height:1}]});
    const denied=assert.rejects(write,authorityError);
    await waitUntil(async()=>Boolean((await query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[writePid.pid])).length),
      'The write must wait for the real scene lock.');
    await member(true,false);
    await writeBlocker.run('COMMIT');await writeBlocker.close();await denied;
    assert.equal((await loadExcalidrawScene(created.documentId))!.sceneSequence,beforeWrite.sceneSequence);
    await grant();
    // The real shared rename runs first while an incoming socket write waits on the workspace lock.
    const renamePeer=await connect();
    const renameBefore=(await loadExcalidrawScene(created.documentId))!;
    awaitedMessageId=randomUUID();
    const received=new Promise<void>(resolve=>{messageReceived=resolve;});
    await withWorkspaceMutationLock(workspace.workspaceId,async()=>{
      renamePeer.socket.send(JSON.stringify(frame('scene:patch',{elements:[{id:'stale-path-write',type:'rectangle',version:1,
        versionNonce:13,isDeleted:false,x:1,y:1,width:1,height:1}]},awaitedMessageId!)));
      await received;
      await renameWorkspacePath({workspace,oldPath:created.path,newPath:'renamed.excalidraw',overwrite:false,fileOptions:{workspace}});
    });
    await waitUntil(()=>renamePeer.closed()!==null,'The old-path socket must close after rename.');
    assert.equal(renamePeer.closed(),4409);
    const renameAfter=(await loadExcalidrawScene(created.documentId))!;
    assert.equal(renameAfter.lifecycleGeneration,renameBefore.lifecycleGeneration);
    assert.equal(renameAfter.sceneSequence,renameBefore.sceneSequence,'A queued write cannot commit after same-generation rename.');
    assert(!renameAfter.elements.some(element=>element.id==='stale-path-write'));
    console.log('Excalidraw actual WebSocket broadcast/resync/ack revocation, real session deletion, serialized delivery, scene-lock write revocation and same-generation rename fencing verified.');
  } finally {
    for(const peer of peers)peer.terminate();
    await flushExcalidrawCollaborationDocuments();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await new Promise<void>(resolve=>http.close(()=>resolve()));
    await execute("UPDATE canvas_workspaces SET status='archived' WHERE id=$1",[workspace.workspaceId]);
    await fs.rm(workspace.rootPath,{recursive:true,force:true});
    for(const owned of sessions.values()) await execute('DELETE FROM "session" WHERE id=$1 AND user_id=$2 AND token=$3',
      [owned.id,owned.userId,owned.token]);
  }
}
main().finally(()=>closeDatabaseConnections()).catch(error=>{console.error(error);process.exitCode=1;});
