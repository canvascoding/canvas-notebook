import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import { WebSocket } from 'ws';
import { Hocuspocus, MessageType } from '@hocuspocus/server';
import { AuthMessageType } from '@hocuspocus/common';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type * as YTypes from 'yjs';
import type { DocumentVersionIdentityV1 } from '../app/lib/documents/read-version';
import type { NativeDocumentEditOperationOriginal } from '../app/lib/collaboration/agent-operations';
import type { AgentBlockEditRequest } from '../app/lib/collaboration/agent-block-edits';
import type { NativeDocumentEditTargetV1 } from '../app/lib/collaboration/native-document-edit-targets';
import type { NativeCollaborationContent } from '../app/lib/collaboration/document-snapshot';
import type { JSONContent } from '@tiptap/core';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Real private PG18/Cookie principals, accepted WebSocket peer writes, actual
// server room owners and the common native edit service. Hook/query observers
// retain real data. The single postwrite test injects an ACK loss AFTER an
// actual SQL result, never a grant, fabricated result or replacement writer.
let groups = 0, completed = false, stage = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const code = (error: unknown): unknown => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error,'code')?.value : undefined;
const errorCode = (expected: string) => (error: unknown): boolean => { assert.equal(code(error),expected); return true; };
async function bounded<T>(pending: Promise<T>, label: string, milliseconds = 12_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([pending,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(label)),milliseconds);})]); }
  finally { if (timer) clearTimeout(timer); }
}
async function until(test:()=>boolean|Promise<boolean>, label:string):Promise<void> {
  const end=Date.now()+10_000;
  while(Date.now()<end){if(await test())return;await new Promise(done=>setTimeout(done,20));}
  throw new Error(label);
}

export async function nativeDocumentEditOwnerPostgresTest():Promise<void> {
  assert.equal(process.env.NODE_ENV,'test');
  await withNativeCopyMetadataOwnerFixture(async h=>{
    process.env.FILE_VERSION_CENTER_MODE='shadow'; // Actual binary history, Review UI remains OFF.
    const {readDocumentReviewAvailability}=await import('../app/lib/document-review-availability');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled,false);
    const {Y}=await import('../app/lib/collaboration/server-runtime');
    const {nativeTableWidthFixture}=await import('./helpers/rich-markdown-projection-fixtures');
    const {createPlainTextYDoc,validateRichMarkdownYDoc}=await import('../app/lib/collaboration/markdown-state');
    const {createCollaborationServer,flushCollaborationDocuments}=await import('../server/collaboration-server');
    const {createCollaborationRoomOwnerSession}=await import('../app/lib/collaboration/room-owner');
    const {issueCollaborationTicket}=await import('../app/lib/collaboration/ticket');
    const {withNativeDocumentEditRequestAuthority}=await import('../app/lib/documents/edit-principal');
    const {applyNativeDocumentEdit}=await import('../app/lib/documents/edit-service');
    const {prepareNativeDocumentEditSource}=await import('../app/lib/collaboration/native-document-edit-source');
    const {readDocumentForRequest}=await import('../app/lib/documents/service');
    const {inspectNativeDocument}=await import('../app/lib/collaboration/document-snapshot');
    const {documentVersionV1}=await import('../app/lib/documents/read-version');
    const {collaborationStateProof}=await import('../app/lib/collaboration/state-proof');
    const {captureNativeDocumentEditOriginal,captureNativeDocumentEditAfter}=await import('../app/lib/collaboration/native-document-edit-operation-contract');
    const {POST:editHttp}=await import('../app/api/documents/edit/route');
    const {POST:statusHttp}=await import('../app/api/documents/edit/status/route');
    const {POST:readHttp}=await import('../app/api/documents/read/route');
    const {encodeDocumentEditOperationResultV1}=await import('../app/lib/documents/edit-result-contract');
    type Seed={id:string;path:string;identity:DocumentVersionIdentityV1};
    const seed=async(file:string,representation:DocumentVersionIdentityV1['representation'],text:string):Promise<Seed>=>{
      const imported=await h.upload(file,Buffer.from('Original API Markdown seed.'));
      const doc=representation==='plain_text'?createPlainTextYDoc(text):nativeTableWidthFixture(representation,text);
      try{
        if(representation!=='plain_text')assert.equal(validateRichMarkdownYDoc(doc).valid,false,'Fixture is native-valid and not losslessly Markdown exportable.');
        await h.admin.query(`UPDATE collaboration_yjs_states SET representation=$2,yjs_state=$3,state_vector=$4,
          document_sequence=document_sequence+1,checkpoint_sequence=0,checkpointed_at=NULL,canonical_hash=NULL,serialized_hash=NULL
          WHERE document_id=$1 AND workspace_id=$5 AND status='active'`,
        [imported.documentId,representation,Buffer.from(Y.encodeStateAsUpdate(doc)),Buffer.from(Y.encodeStateVector(doc)),h.source.workspaceId]);
      }finally{doc.destroy();}
      const row=(await h.admin.query(`SELECT d.lineage_id,s.lifecycle_generation,s.schema_version FROM collaboration_documents d
        JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.id=$1 AND d.workspace_id=$2 AND d.status='active'`,[imported.documentId,h.source.workspaceId])).rows[0];assert(row?.lineage_id);
      const target=path.join(h.source.rootPath,file),relative=path.relative(h.dataRoot,target);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
      const fileIdentity=await fs.lstat(target);assert(fileIdentity.isFile()&&!fileIdentity.isSymbolicLink());
      await fs.unlink(target);await assert.rejects(fs.lstat(target),{code:'ENOENT'});
      return{id:imported.documentId,path:file,identity:{workspaceId:h.source.workspaceId,organizationId:h.source.organizationId??null,
        documentId:imported.documentId,lineageId:row.lineage_id,lifecycleGeneration:Number(row.lifecycle_generation),representation,schemaVersion:Number(row.schema_version)}};
    };
    // All initial API imports happen while genuine original member session A is current.
    const removeOwnProjection=async(selected:Seed)=>{
      const root=await fs.realpath(h.source.rootPath),target=path.join(root,selected.path),parent=path.dirname(target);
      assert.equal(await fs.realpath(parent),parent);assert(path.relative(root,target)&&!path.relative(root,target).startsWith('..'));
      let first;try{first=await fs.lstat(target);}catch(error){if(code(error)==='ENOENT')return;throw error;}
      assert(first.isFile()&&!first.isSymbolicLink());const bytes=await fs.readFile(target),again=await fs.lstat(target);
      assert.equal(again.dev,first.dev);assert.equal(again.ino,first.ino);assert.equal(again.size,bytes.length);
      await fs.unlink(target);await assert.rejects(fs.lstat(target),{code:'ENOENT'});
    };
    const plain=await seed('native-owner/plain.md','plain_text','Target plain and stable tail.'),
      race=await seed('native-owner/race.md','plain_text','Target race and stable tail.'),
      fault=await seed('native-owner/fault.md','plain_text','Target fault and stable tail.'),
      xml=await seed('native-owner/xml.md','tiptap_xml','Target XML'),blocks=await seed('native-owner/blocks.md','tiptap_blocks','Target Blocks');
    const ownClients=new Set<Client>(),ownerSessions=new Set<Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>>();
    const ownerBackends:Array<{pid:number;start:string}>=[],sockets=new Set<WebSocket>(),clientDocs=new Set<YTypes.Doc>();
    const documents=new Map<string,import('@hocuspocus/server').Document>();
    let runtime:Hocuspocus|undefined,wss:ReturnType<typeof createCollaborationServer>|undefined;
    const server=http.createServer((_request,response)=>{response.statusCode=404;response.end();});
    const originalHooks=Hocuspocus.prototype.hooks;
    let currentSession='session-owner',currentCookie=(await h.request(h.source,'owner',true)).headers.get('cookie');assert(currentCookie);
    const request=()=>new NextRequest('http://localhost/api/documents/edit',{method:'POST',headers:{cookie:currentCookie!, 'x-canvas-workspace-id':h.source.workspaceId}});
    const ownSession=async(onInvalidated:()=>void)=>{
      const client=new Client({connectionString:process.env.DATABASE_URL,application_name:h.applicationName,
        options:`-c search_path=${h.schema},pg_catalog -c statement_timeout=15000`,connectionTimeoutMillis:5000});
      ownClients.add(client);client.on('error',()=>undefined);await client.connect();
      const identity=(await client.query(`SELECT current_schema() AS schema,pg_backend_pid() AS pid,
        extract(epoch FROM backend_start)::text AS start FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
      assert.equal(identity.schema,h.schema);ownerBackends.push({pid:identity.pid,start:identity.start});
      const session=await createCollaborationRoomOwnerSession({query:client.query.bind(client),on:client.on.bind(client),
        end:async()=>{await client.end();ownClients.delete(client);}},onInvalidated);ownerSessions.add(session);return session;
    };
    const frame=(id:string,type:number,write:(encoder:ReturnType<typeof encoding.createEncoder>)=>void)=>{
      const encoder=encoding.createEncoder();encoding.writeVarString(encoder,id);encoding.writeVarUint(encoder,type);write(encoder);return encoding.toUint8Array(encoder);
    };
    const openPeer=async(selected:Seed,initial:string)=>{
      const address=server.address();assert(address&&typeof address==='object');
      const ticket=issueCollaborationTicket({userId:'owner',sessionId:currentSession,documentId:selected.id,workspaceId:h.source.workspaceId,
        organizationId:h.source.organizationId??null,path:selected.path,representation:selected.identity.representation,
        lifecycleGeneration:selected.identity.lifecycleGeneration,provider:'yjs',permission:'write'});
      const socket=new WebSocket(`ws://127.0.0.1:${address.port}/ws/collaboration`,{headers:{origin:'http://localhost',cookie:currentCookie!, 'x-canvas-workspace-id':h.source.workspaceId}});
      sockets.add(socket);const clientDoc=new Y.Doc();clientDocs.add(clientDoc);let authenticated=false,denied=false,startup=false,frameError:unknown;
      socket.on('error',error=>{frameError=error;});socket.on('message',data=>{
        try{const bytes=data instanceof ArrayBuffer?new Uint8Array(data):Array.isArray(data)?new Uint8Array(Buffer.concat(data)):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
          const decoder=decoding.createDecoder(bytes);assert.equal(decoding.readVarString(decoder),selected.id);const type=decoding.readVarUint(decoder);
          if(type===MessageType.Auth){const auth=decoding.readVarUint(decoder);authenticated ||= auth===AuthMessageType.Authenticated;denied ||= auth===AuthMessageType.PermissionDenied;}
          if(type===MessageType.Stateless)startup ||= JSON.parse(decoding.readVarString(decoder)).type==='durability_snapshot';
          if(type===MessageType.Sync){const subtype=decoding.readVarUint(decoder);if(subtype===1||subtype===2)Y.applyUpdate(clientDoc,decoding.readVarUint8Array(decoder));}
        }catch(error){frameError=error;}
      });
      await bounded(new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);}),'Actual peer socket did not open.');
      socket.send(frame(selected.id,MessageType.Auth,encoder=>{encoding.writeVarUint(encoder,AuthMessageType.Token);encoding.writeVarString(encoder,ticket.token);}));
      await until(()=>authenticated||denied||Boolean(frameError),'Actual peer authentication did not settle.');assert.equal(frameError,undefined);assert(authenticated&&!denied);
      await until(()=>startup&&documents.has(selected.id),'Actual peer room startup did not finish.');
      socket.send(frame(selected.id,MessageType.Sync,encoder=>{encoding.writeVarUint(encoder,0);encoding.writeVarUint8Array(encoder,Y.encodeStateVector(clientDoc));}));
      await until(()=>clientDoc.getText('content').toString()===initial,'Actual peer did not synchronize stored native text.');
      return{socket,doc:clientDoc,sendSuffix:async(suffix:string)=>{
        const before=Y.encodeStateVector(clientDoc);clientDoc.getText('content').insert(clientDoc.getText('content').length,suffix);
        socket.send(frame(selected.id,MessageType.Sync,encoder=>{encoding.writeVarUint(encoder,2);encoding.writeVarUint8Array(encoder,Y.encodeStateAsUpdate(clientDoc,before));}));
        await until(()=>documents.get(selected.id)?.getText('content').toString()===clientDoc.getText('content').toString(),'Actual accepted peer edit did not reach the room.');
      }};
    };
    const read=async(selected:Seed,format:'native'|'text'='text')=>readDocumentForRequest(request(),{apiVersion:1,workspaceId:h.source.workspaceId,documentId:selected.id,format,maxBytes:32768});
    const selection=(selected:Seed,version:string,key:string,oldText:string,newText:string)=>({apiVersion:1 as const,workspaceId:h.source.workspaceId,
      documentId:selected.id,expectedVersion:version,idempotencyKey:key,patch:{kind:'native_text_replace' as const,edits:[{oldText,newText}]}});
    const apply=async(value:ReturnType<typeof selection>)=>withNativeDocumentEditRequestAuthority(request(),{workspaceId:h.source.workspaceId},authority=>applyNativeDocumentEdit(authority,value));
    const rows=async(operationId:string)=>{
      const row=(await h.admin.query(`SELECT operation.*,xmin::text AS xmin FROM collaboration_agent_operations operation WHERE operation_id=$1`,[operationId])).rows[0];assert(row);
      const payload=(await h.admin.query(`SELECT *,xmin::text AS xmin FROM collaboration_agent_native_edit_payloads WHERE operation_id=$1`,[operationId])).rows;
      const history=row.version_revision_id?(await h.admin.query(`SELECT r.id,r.history_only,r.created_by_user_id,r.created_by_actor_type,r.source_session_id,
        c.content_format,c.source,c.state_vector_hash,b.content_sha256,b.raw_size_bytes,r.xmin::text AS revision_xmin,c.xmin::text AS content_xmin,b.xmin::text AS blob_xmin
        FROM file_revisions r JOIN file_revision_contents c ON c.revision_id=r.id JOIN file_version_blobs b ON b.blob_id=c.blob_id WHERE r.id=$1`,[row.version_revision_id])).rows:[];
      return{row,payload,history};
    };
    const assertActual=async(selected:Seed,result:NativeDocumentEditOperationOriginal)=>{
      assert(result.after);assert(['persisted_yjs','checkpointed_file'].includes(result.operation.operationStatus));assert.equal(result.operation.durability,result.operation.operationStatus);
      const actual=await rows(result.operation.operationId),original=captureNativeDocumentEditOriginal(actual.row.native_edit_original_json),after=captureNativeDocumentEditAfter(actual.row.native_edit_after_json,original);
      assert.deepEqual(result.original,original);assert.deepEqual(result.after,after);assert.equal(actual.row.actor_session_id,original.actor.sessionId);
      const state=(await h.admin.query('SELECT yjs_state,document_sequence,persisted_at FROM collaboration_yjs_states WHERE document_id=$1',[selected.id])).rows[0];assert(state);
      const doc=new Y.Doc({gc:false});try{Y.applyUpdate(doc,new Uint8Array(state.yjs_state));assert.equal(collaborationStateProof(doc,Y),after.stateProof);
        assert.equal(documentVersionV1(selected.identity,after.stateProof),after.afterVersion);assert.equal(inspectNativeDocument(doc,selected.identity.representation).version.stateProof,after.stateProof);
      }finally{doc.destroy();}
      assert.equal(actual.payload.length,after.history.status==='ready'?1:0);
      if(after.history.status==='ready'){
        const payload=actual.payload[0];assert.equal(payload.format,'native-yjs-update-v1');assert.equal(payload.original_proof,original.originalProof);assert.equal(payload.after_proof,after.afterProof);
        assert.equal(payload.sha256,after.history.sha256);assert.equal(Number(payload.size_bytes),after.history.sizeBytes);assert(after.history.sizeBytes<=1048576);
        assert.equal(crypto.createHash('sha256').update(payload.yjs_update).digest('hex'),after.history.sha256);
        assert.equal(actual.history.length,1);const history=actual.history[0];assert.equal(history.history_only,true);assert.equal(history.content_format,'binary');assert.equal(history.source,'manual');
        assert.equal(history.created_by_actor_type,'user');assert.equal(history.created_by_user_id,'owner');assert.equal(history.source_session_id,original.actor.sessionId);
        assert.equal(history.content_sha256,after.history.sha256);assert.equal(Number(history.raw_size_bytes),after.history.sizeBytes);
      }
      return actual;
    };
    try{
      Hocuspocus.prototype.hooks=(async function(this:Hocuspocus,name:string,payload:Record<string,unknown>,...args:unknown[]){
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        runtime=this;const result=await Reflect.apply(originalHooks,this,[name,payload,...args]);
        if(name==='onLoadDocument'&&typeof payload.documentName==='string'&&payload.document)documents.set(payload.documentName,payload.document as import('@hocuspocus/server').Document);
        if(name==='connected'&&typeof payload.documentName==='string'&&payload.connection)documents.set(payload.documentName,(payload.connection as import('@hocuspocus/server').Connection).document);return result;
      }) as typeof originalHooks;
      wss=createCollaborationServer(server,{roomOwner:{createSession:ownSession,heartbeatMs:1000}});
      await bounded(new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());}),'Actual owner HTTP server did not listen.');
      stage='native plain apply';
      const peer=await openPeer(plain,'Target plain and stable tail.');await flushCollaborationDocuments();
      // Startup may legitimately checkpoint an exportable document. Remove only
      // this fixture's own current projection AFTER that store, before the edit.
      await removeOwnProjection(plain);
      await assert.rejects(fs.lstat(path.join(h.source.rootPath,plain.path)),{code:'ENOENT'});
      const before=await read(plain),originalRequest=selection(plain,before.document.version,'native-owner-plain-1','Target','Changed');
      const preview=await withNativeDocumentEditRequestAuthority(request(),{workspaceId:h.source.workspaceId},authority=>prepareNativeDocumentEditSource(authority,originalRequest));
      const applied=await apply(originalRequest);assert(applied.after);assert.equal(applied.after.outcome,'applied');
      assert.notEqual(applied.after.afterVersion,preview.prepared.afterVersion,'Actual room writer allocates its own clocks; private preview is never the After receipt.');
      await until(()=>peer.doc.getText('content').toString()==='Changed plain and stable tail.','Actual peer did not observe the native operation.');
      const actual=await assertActual(plain,applied);assert.equal(actual.row.actor_session_id,'session-owner');assert.equal(applied.original.origin.transport,'request');
      assert.equal((await read(plain)).fragment,'Changed plain and stable tail.');
      console.log('PASS actual native-only Plain room apply, actual After differs from private preview, bounded binary history and real peer visibility');groups++;

      stage='original retry and renewed SID';
      const firstReceipt=await rows(applied.operation.operationId);const again=await apply(originalRequest);assert.deepEqual(again,applied);assert.deepEqual(await rows(applied.operation.operationId),firstReceipt);
      const tokenB=crypto.randomBytes(32).toString('hex'),now=Date.now();currentSession='session-owner-renewed';
      await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',[currentSession,tokenB,'owner',now+3600000,now]);
      currentCookie=(await serializeSignedCookie('better-auth.session_token',tokenB,process.env.BETTER_AUTH_SECRET!)).split(';')[0];
      await h.admin.query('UPDATE "session" SET expires_at=$2 WHERE id=$1',['session-owner',now-1000]);
      const renewed=await apply(originalRequest);assert.deepEqual(renewed,applied);assert.equal(renewed.original.actor.sessionId,'session-owner');assert.deepEqual(await rows(applied.operation.operationId),firstReceipt);
      await assert.rejects(apply({...originalRequest,patch:{kind:'native_text_replace',edits:[{oldText:'Target',newText:'Different'}]}}),errorCode('DOCUMENT_IDEMPOTENCY_CONFLICT'));
      await assert.rejects(apply({...originalRequest,idempotencyKey:'native-owner-stale-new-key'}),errorCode('DOCUMENT_VERSION_CONFLICT'));
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_agent_operations WHERE document_id=$1',[plain.id])).rows[0].n,1);
      console.log('PASS old search text gone retry, genuine renewed SID B with expired A preserves immutable Original/After/xmin, changed request and stale new key reject');groups++;

      stage='native no-op';
      const noOpSource=await read(plain),nativeBefore=(await h.admin.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1',[plain.id])).rows[0].yjs_state;
      const noOp=await apply(selection(plain,noOpSource.document.version,'native-owner-noop-1','Changed','Changed'));assert(noOp.after);assert.equal(noOp.after.outcome,'no_change');
      assert.equal(noOp.after.beforeVersion,noOp.after.afterVersion);assert.deepEqual(noOp.operation.appliedTargetIds,[]);assert.equal(noOp.original.actor.sessionId,currentSession);
      await assertActual(plain,noOp);assert.deepEqual((await h.admin.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1',[plain.id])).rows[0].yjs_state,nativeBefore);
      console.log('PASS no-op still gets an actual room CAS, independent immutable After and confirmed durability without a CRDT rewrite');groups++;

      stage='actual final full-version CAS';
      const racePeer=await openPeer(race,'Target race and stable tail.'),raceBefore=await read(race);let interleaved=false,admissionClient:unknown;
      const raceRequest=selection(race,raceBefore.document.version,'native-owner-race-1','Target','Forbidden');
      await h.withProbe(async event=>{
        if(!admissionClient&&event.text.startsWith('INSERT INTO collaboration_agent_operations')&&event.values[1]===race.id)admissionClient=event.client;
        // The actual successful COMMIT has released the workspace admission
        // guard. Waiting inside INSERT would block the peer's real admission.
        if(interleaved||event.client!==admissionClient||event.text.trim()!=='COMMIT')return;
        interleaved=true;await racePeer.sendSuffix(' peer accepted before final CAS');
      },async()=>{await assert.rejects(apply(raceRequest),errorCode('DOCUMENT_VERSION_CONFLICT'));});
      assert(interleaved);assert.equal(documents.get(race.id)?.getText('content').toString(),'Target race and stable tail. peer accepted before final CAS');await flushCollaborationDocuments();
      const raceRows=(await h.admin.query('SELECT status,native_edit_after_json FROM collaboration_agent_operations WHERE document_id=$1',[race.id])).rows;assert.equal(raceRows.length,1);assert.equal(raceRows[0].status,'failed');assert.equal(raceRows[0].native_edit_after_json,null);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_agent_native_edit_payloads p JOIN collaboration_agent_operations o ON o.operation_id=p.operation_id WHERE o.document_id=$1',[race.id])).rows[0].n,0);
      console.log('PASS real accepted Socket edit after operation admission invalidates full-version CAS; native operation never applies or records an After');groups++;

      stage='native-only unexportable XML and Blocks';
      for(const selected of [xml,blocks]){
        await assert.rejects(fs.lstat(path.join(h.source.rootPath,selected.path)),{code:'ENOENT'});const initial=await read(selected);
        const edited=await apply(selection(selected,initial.document.version,`native-owner-${selected.identity.representation}-1`,'Target','Edited'));assert(edited.after);assert.equal(edited.after.outcome,'applied');await assertActual(selected,edited);
        const native=await read(selected,'native');assert(native.complete&&native.fragment.includes('Edited'));
        const persisted=(await h.admin.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1',[selected.id])).rows[0];
        const doc=new Y.Doc({gc:false});try{Y.applyUpdate(doc,new Uint8Array(persisted.yjs_state));assert.equal(validateRichMarkdownYDoc(doc).valid,false,'Edit preserves native-only table width.');}finally{doc.destroy();}
      }
      console.log('PASS real native-only unexportable XML and Blocks edits persist and read by ID without Markdown history/export precondition');groups++;

      stage='postwrite SQL ACK loss';
      // No socket on this document: observe the direct edit authority's real
      // complete Member snapshot. Its session selector is parameter 3; the
      // former standalone session SELECT used parameter 1.
      const faultBefore=await read(fault),faultRequest=selection(fault,faultBefore.document.version,'native-owner-ack-loss-1','Target','Acknowledged');
      let injected=false,failedOperationId:string|undefined;
      await h.withProbe(async event=>{
        if(injected||!documents.get(fault.id)?.getText('content').toString().includes('Acknowledged')
          ||!event.text.includes('SELECT header.*,account.*,')
          ||!event.text.includes('SELECT s.user_id,s.expires_at,s.impersonated_by')
          ||event.values[0]!==h.source.workspaceId||event.values[2]!==currentSession)return;
        assert.equal(event.values[1],'owner');assert.equal(event.result.rows.length,1);
        assert.equal(event.result.rows[0].user_id,'owner');assert.equal(event.result.rows[0].id,'owner');
        injected=true;throw new Error('OWNED_POST_APPLY_SQL_ACK_LOSS');
      },async()=>{await assert.rejects(apply(faultRequest),error=>{
        assert.equal(code(error),'EDIT_OUTCOME_UNCONFIRMED');const id=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'operationId')?.value:undefined;
        assert(typeof id==='string');assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id));failedOperationId=id;return true;
      });});
      assert(injected&&failedOperationId);assert.equal(documents.get(fault.id)?.getText('content').toString(),'Acknowledged fault and stable tail.');await flushCollaborationDocuments();
      const acknowledged=await rows(failedOperationId);assert(acknowledged.row.native_edit_after_json,'Actual room After is ACKed even when current B final SQL acknowledgement fails.');
      const retried=await apply(faultRequest);assert.equal(retried.operation.operationId,failedOperationId);await assertActual(fault,retried);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_agent_operations WHERE document_id=$1',[fault.id])).rows[0].n,1);
      assert.equal((await read(fault)).fragment,'Acknowledged fault and stable tail.');
      assert.equal(readDocumentReviewAvailability().documentReviewEnabled,false);
      console.log('PASS controlled actual postwriter SQL ACK loss preserves operationId/After and fresh retry confirms durability without a second target application');groups++;

      stage='pure public historical status';
      const httpRequest=(endpoint:string,value:unknown,bearer?:string)=>new NextRequest(`http://localhost/api/documents/edit${endpoint}`,{
        method:'POST',headers:{'content-type':'application/json',
          ...(bearer?{authorization:`Bearer ${bearer}`}:{cookie:currentCookie!})},body:JSON.stringify(value)});
      const statusRequest={apiVersion:1,workspaceId:h.source.workspaceId,operationId:applied.operation.operationId};
      const immutable=await rows(statusRequest.operationId),statusStatements:string[]=[];
      const statusResponse=await h.withProbe(async event=>{statusStatements.push(event.text);},()=>statusHttp(httpRequest('/status',statusRequest)));
      assert.equal(statusResponse.status,200);assert.equal(statusResponse.headers.get('cache-control'),'no-store');
      assert.equal(statusResponse.headers.get('x-content-type-options'),'nosniff');
      const publicStatus=encodeDocumentEditOperationResultV1(await statusResponse.json());
      assert.equal(publicStatus.state,'confirmed');assert.equal(publicStatus.effect?.afterVersion,applied.after.afterVersion);
      assert.equal(publicStatus.history.status,'captured');assert.equal(publicStatus.document.documentId,plain.id);
      assert.deepEqual(await rows(statusRequest.operationId),immutable);
      assert.equal(statusStatements.filter(sql=>/\b(?:INSERT\s+INTO\b|UPDATE\s+["\w]|DELETE\s+FROM\b|MERGE\s+INTO\b|SAVEPOINT\b)/iu.test(sql)).length,0,
        'Public status must not reconcile, capture history or issue domain DML.');
      // Original peer A intentionally expired in the earlier renewal case.
      // A fresh genuine B peer supplies this later authorized change.
      const laterPeer=await openPeer(plain,(await read(plain)).fragment);
      await laterPeer.sendSuffix(' later peer content');await flushCollaborationDocuments();
      const later=await read(plain);assert.notEqual(later.document.version,publicStatus.effect?.afterVersion);
      const laterStatus=await statusHttp(httpRequest('/status',statusRequest));assert.equal(laterStatus.status,200);
      assert.deepEqual(encodeDocumentEditOperationResultV1(await laterStatus.json()),publicStatus);
      assert.deepEqual(await rows(statusRequest.operationId),immutable,'Later peers do not rewrite historical operation receipts.');
      console.log('PASS real Request status is SELECT-only with unchanged operation/payload/history rows and retains historical After after a genuine accepted peer edit');groups++;

      stage='public HTTP edit and session Bearer';
      const publicRequest=selection(plain,later.document.version,'native-owner-public-http-1','Changed','External');
      const editedResponse=await editHttp(httpRequest('',publicRequest,tokenB));assert.equal(editedResponse.status,200);
      const publicEdited=encodeDocumentEditOperationResultV1(await editedResponse.json());
      assert.equal(publicEdited.state,'confirmed');assert.equal(publicEdited.effect?.outcome,'applied');
      assert(publicEdited.effect);
      assert.equal(publicEdited.effect.beforeVersion,later.document.version);assert.equal(publicEdited.document.documentId,plain.id);
      assert.equal((await read(plain)).fragment,'External plain and stable tail. later peer content');
      const publicRows=await rows(publicEdited.operationId);assert.equal(publicRows.row.actor_session_id,currentSession);
      assert.equal(publicRows.row.native_edit_original_json.origin.transport,'request');
      const repeatedResponse=await editHttp(httpRequest('',publicRequest,tokenB));assert.equal(repeatedResponse.status,200);
      assert.deepEqual(encodeDocumentEditOperationResultV1(await repeatedResponse.json()),publicEdited);
      assert.deepEqual(await rows(publicEdited.operationId),publicRows);
      const staleResponse=await editHttp(httpRequest('',{...publicRequest,idempotencyKey:'native-owner-public-stale'},tokenB));
      assert.equal(staleResponse.status,409);assert.equal((await staleResponse.json()).code,'DOCUMENT_VERSION_CONFLICT');
      const malformedResponse=await editHttp(httpRequest('',{...publicRequest,apiVersion:2},tokenB));
      assert.equal(malformedResponse.status,400);assert.equal((await malformedResponse.json()).code,'INVALID_REQUEST');
      const oversizedResponse=await editHttp(httpRequest('',{...publicRequest,patch:{kind:'native_text_replace',edits:[{oldText:'External',newText:'x'.repeat(513*1024)}]}},tokenB));
      assert.equal(oversizedResponse.status,413);assert.equal((await oversizedResponse.json()).code,'DOCUMENT_TOO_LARGE');
      console.log('PASS public HTTP edit uses genuine session Bearer, same-key replay preserves rows and stale/invalid/oversized requests reject');groups++;

      stage='public native block guards and all six operations';
      const targetPage=async()=>{
        const response=await readHttp(new NextRequest('http://localhost/api/documents/read',{method:'POST',headers:{
          authorization:`Bearer ${tokenB}`,'content-type':'application/json'},body:JSON.stringify({apiVersion:1,
          workspaceId:h.source.workspaceId,documentId:blocks.id,format:'native',includeEditTargets:true,maxBytes:32768})}));
        assert.equal(response.status,200);const page=await response.json();assert.equal(page.complete,true);
        const body=JSON.parse(page.fragment) as {content:NativeCollaborationContent;editTargets:NativeDocumentEditTargetV1[]};
        assert(Array.isArray(body.editTargets));assert.equal(body.content.kind,'rich_text');
        for(const target of body.editTargets){assert.equal(Object.hasOwn(target,'text'),false);assert.equal(Object.hasOwn(target,'operations'),false);}
        return{page,body};
      };
      const targetFor=(body:Awaited<ReturnType<typeof targetPage>>['body'],label:string,type='paragraph')=>{
        assert(body.content.kind==='rich_text');const nodes:JSONContent[]=[];
        const visit=(node:JSONContent)=>{nodes.push(node);for(const child of node.content??[])visit(child);};visit(body.content.document);
        const node=nodes.find(node=>node.type===type&&(node.content??[]).map(child=>child.text??'').join('')===label);
        assert(node&&typeof node.attrs?.id==='string');const target=body.editTargets.find(target=>target.id===node.attrs!.id);assert(target);return target;
      };
      const applyBlock=async(operation:AgentBlockEditRequest,key:string)=>{
        const current=await targetPage();
        const value={apiVersion:1,workspaceId:h.source.workspaceId,documentId:blocks.id,expectedVersion:current.page.document.version,
          idempotencyKey:key,patch:{kind:'native_blocks',operations:[operation]}};
        const response=await editHttp(httpRequest('',value,tokenB));assert.equal(response.status,200);
        const result=encodeDocumentEditOperationResultV1(await response.json());assert.equal(result.state,'confirmed');
        assert.equal(result.effect?.outcome,'applied');const after=await targetPage();
        assert.equal(after.page.document.version,result.effect?.afterVersion);
        const immutable=await rows(result.operationId),retry=await editHttp(httpRequest('',value,tokenB));assert.equal(retry.status,200);
        assert.deepEqual(encodeDocumentEditOperationResultV1(await retry.json()),result);assert.deepEqual(await rows(result.operationId),immutable);
        return after;
      };
      let blockRead=await applyBlock({kind:'insert_blocks',parentId:null,beforeId:null,blocks:[
        {type:'heading',attrs:{level:1},content:[{type:'text',text:'API Heading'}]},
        ...['API Alpha','API Beta','API Remove'].map(text=>({type:'paragraph',content:[{type:'text',text}]})),
      ]},'native-public-block-insert');
      const heading=targetFor(blockRead.body,'API Heading','heading');
      blockRead=await applyBlock({kind:'format_block',blockId:heading.id,beforeAttrs:{level:1},afterAttrs:{level:2}},'native-public-block-format');
      assert.equal(targetFor(blockRead.body,'API Heading','heading').attrs.level,2);
      const alpha=targetFor(blockRead.body,'API Alpha');
      blockRead=await applyBlock({kind:'format_text',blockId:alpha.id,subtreeHash:alpha.subtreeHash,from:0,to:3,mark:'bold',enabled:true},'native-public-text-format');
      const beta=targetFor(blockRead.body,'API Beta');
      blockRead=await applyBlock({kind:'move_block',blockId:beta.id,placementHash:beta.placementHash,parentId:null,beforeId:alpha.id},'native-public-block-move');
      assert(blockRead.body.editTargets.findIndex(target=>target.id===beta.id)<blockRead.body.editTargets.findIndex(target=>target.id===alpha.id));
      const table=blockRead.body.editTargets.find(target=>target.type==='table'),cell=blockRead.body.editTargets.find(target=>target.type==='tableCell');
      assert(table&&cell?.tableOperationTarget);assert.equal(cell.tableOperationTarget.subtreeHash,table.subtreeHash);
      const rowCount=blockRead.body.editTargets.filter(target=>target.type==='tableRow').length;
      blockRead=await applyBlock({kind:'table_operation',...cell.tableOperationTarget,action:'addRowAfter'},'native-public-table-operation');
      assert.equal(blockRead.body.editTargets.filter(target=>target.type==='tableRow').length,rowCount+1);
      const removed=targetFor(blockRead.body,'API Remove');
      blockRead=await applyBlock({kind:'delete_block',blockId:removed.id,subtreeHash:removed.subtreeHash},'native-public-block-delete');
      assert.equal(blockRead.body.editTargets.some(target=>target.id===removed.id),false);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_agent_operations WHERE document_id=$1',[blocks.id])).rows[0].n,7);
      console.log('PASS genuine version-bound native HTTP target reads feed all six actual room block operations, table guards and same-key retries without raw Yjs, Markdown export or duplicated mutation');groups++;

      stage='public status after session revocation';
      // Revocation is terminal for this actual test login. No later positive
      // request attempts to restore or reuse the expired session.
      const beforeRevoke=await rows(publicEdited.operationId);
      await h.admin.query('UPDATE "session" SET expires_at=$2 WHERE id=$1',[currentSession,Date.now()-1000]);
      const revoked=await statusHttp(httpRequest('/status',{...statusRequest,operationId:publicEdited.operationId},tokenB));
      assert.equal(revoked.status,401);assert.equal((await revoked.json()).code,'AUTHENTICATION_REQUIRED');
      assert.deepEqual(await rows(publicEdited.operationId),beforeRevoke);
      console.log('PASS terminal real session expiry denies public status without modifying the stored operation, payload or history');groups++;
    }finally{
      const cleanup:unknown[]=[];for(const socket of sockets)socket.terminate();
      try{await until(()=>[...documents.values()].every(doc=>doc.getConnectionsCount()===0),'Owned peer sockets remain.');await flushCollaborationDocuments();}catch(error){cleanup.push(error);}
      if(runtime){for(const doc of [...runtime.documents.values()])try{await runtime.unloadDocument(doc);}catch(error){cleanup.push(error);}
        for(const pending of [...runtime.unloadingDocuments.values()])try{await bounded(pending,'Owned room unload did not settle.');}catch(error){cleanup.push(error);}}
      if(wss)try{await bounded(new Promise<void>((resolve,reject)=>wss!.close(error=>error?reject(error):resolve())),'Owned WSS close timed out.');}catch(error){cleanup.push(error);}
      try{await bounded(new Promise<void>((resolve,reject)=>server.close(error=>error&&(error as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve())),'Owned HTTP close timed out.');}catch(error){cleanup.push(error);}
      for(const session of ownerSessions)try{await session.close();}catch(error){cleanup.push(error);}
      for(const client of ownClients)try{await client.end();ownClients.delete(client);}catch(error){cleanup.push(error);}
      for(const doc of documents.values())doc.destroy();for(const doc of clientDocs)doc.destroy();Hocuspocus.prototype.hooks=originalHooks;
      for(const backend of ownerBackends)try{assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2',[backend.pid,backend.start])).rows[0].n,0);}catch(error){cleanup.push(error);}
      if(cleanup.length)throw new AggregateError(cleanup,'Actual native edit room resources did not close.');
      console.log(JSON.stringify({closure:'native-document-edit-owner',socketsClosed:true,serversClosed:true,dedicatedOwnerBackendsClosed:ownerBackends.length}));
    }
  });
  assert.equal(groups,10);completed=true;console.log(JSON.stringify({suite:'native-document-edit-owner',groups,evidence:'actual_request_principal_pg_owner_room_native_edit_service'}));
}
nativeDocumentEditOwnerPostgresTest().catch(error=>{console.error(JSON.stringify({suite:'native-document-edit-owner',stage,groups,
  name:error instanceof Error?error.name:'UnknownError',code:code(error)??null}));console.error(error);process.exitCode=1;});
