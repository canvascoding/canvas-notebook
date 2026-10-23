import assert from 'node:assert/strict';
import { deriveOriginalMoveSourceNamespaceFacts, assertOriginalMoveFinalSourceGraph, readOriginalMoveCollectorOverlay, readWorkspaceOperationOriginalMoveSourcesOnConnection } from '../app/lib/files/workspace-operation-original-move-sources';
import { assertWorkspaceOperationNativeMoveBatchPlanCurrent } from '../app/lib/files/workspace-operation-native-move-plan';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import type { NativeFileOperationReceipt } from '../app/lib/markdown/native-file-operation-handoff';
import type { PreparedWorkspacePathMoveReceipt } from '../app/lib/filesystem/prepared-workspace-path-move-contract';
import type { SqlConnection } from '../app/lib/db';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { captureNativeFileOperationBundle, type NativeFileOperationBundle } from '../app/lib/markdown/native-file-operation-handoff';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { prepareNativeLinkMutations } from '../app/lib/markdown/workspace-native-link-mutations';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { NativeNamespaceEntry } from '../app/lib/markdown/workspace-link-contract-v2';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { createWorkspaceOperationNativeMoveBatchPlan } from '../app/lib/files/workspace-operation-native-move-plan';
import * as codec from '../app/lib/files/workspace-operation-original-move';
import { preparedWorkspacePathMoveProof, type PreparedPathMoveIdentity, type PreparedWorkspacePathMoveOriginal } from '../app/lib/filesystem/prepared-workspace-path-move-contract';

// Actual Yjs inventories/planner/prepared link updates. Filesystem identities,
// journal rows and receipt digests are DECLARED pure fixtures, never PG/FS/ACL
// authority or an integrated Move-worker/runtime acceptance claim.
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const json=codec.serializeWorkspaceOperationOriginalMoveData;
const scope:WorkspaceOperationBatchScope={workspace:{workspaceId:'move-codec-workspace',workspaceType:'personal',organizationId:null,ownerUserId:'owner',
  rootPath:'/fixture/workspace',rootRelativePath:'users/owner/workspace',legacy:false,status:'active',
  permissions:{canRead:true,canWrite:true,canDelete:true,canRunAgent:true,canManageWorkspace:true,canCreatePublicLinks:false}},fileOptions:{}};
const identity=(kind:'file'|'directory',inode=kind==='file'?'2':'1',size='3'):PreparedPathMoveIdentity=>({device:'1',inode,
  mode:kind==='file'?0o100644:0o040755,uid:1000,gid:1000,linkCount:kind==='file'?'1':'2',size,birthtimeNs:'10',mtimeNs:'100000000',ctimeNs:'100000000'});
function state(filePath:string,text='Original',representation:PersistedCollaborationState['representation']='plain_text'):PersistedCollaborationState {
  const doc=representation==='plain_text'?createPlainTextYDoc(text):createRichMarkdownYDoc(text,representation);
  try{return {documentId:`doc:${filePath}`,workspaceId:scope.workspace.workspaceId,organizationId:null,path:filePath,representation,lifecycleGeneration:1,
    schemaVersion:1,documentSequence:7,persistedAt:100,checkpointSequence:0,checkpointedAt:null,canonicalHash:null,serializedHash:null,newlineStyle:'lf',hasBom:false,
    degraded:false,status:'active',yjsState:Y.encodeStateAsUpdate(doc),stateVector:Y.encodeStateVector(doc)};}finally{doc.destroy();}
}
function observation(states:PersistedCollaborationState[],extras:Array<{path:string;kind:'file'|'directory';identity?:string|null}>=[],projections:Record<string,string|null>={}):WorkspaceLinkSourceAuthorityObservation {
  const inventories=states.map(value=>inspectPersistedNativeCollaborationSnapshot(value,inspectNativeDocumentLinks));
  const nativeBindings:WorkspaceNativeSourceBinding[]=states.map((value,index)=>({expected:{documentId:value.documentId,lineageId:`lineage:${value.path}`,
    workspaceId:value.workspaceId,organizationId:null,path:value.path,representation:value.representation,schemaVersion:1,lifecycleGeneration:1,registryStateVersion:7,
    documentSequence:7,persistedAt:100,binaryHash:hash(value.yjsState),vectorHash:hash(value.stateVector),stateProof:inventories[index].version.stateProof},
    registry:{documentId:value.documentId,lineageId:`lineage:${value.path}`,workspaceId:value.workspaceId,workspaceType:'personal',organizationId:null,customerId:null,projectId:null,
      path:value.path,provider:'yjs',stateLifecycle:'initialized',stateVersion:7,status:'active'},
    lineage:{lineageId:`lineage:${value.path}`,workspaceId:value.workspaceId,workspaceType:'personal',organizationId:null,customerId:null,projectId:null,path:value.path,
      status:'active',archivedAt:null,trashEntryId:null},byteProfile:{newlineStyle:'lf',hasBom:false},inventoryProof:nativeLinkJsonProof(inventories[index])}));
  const namespace:NativeNamespaceEntry[]=states.map(value=>({workspaceId:value.workspaceId,path:value.path,kind:'file',identity:`registry:${value.documentId}:1`,
    filesystemIdentity:projections[value.path]??null,documentId:value.documentId,lifecycleGeneration:1}));
  for(const item of extras){const physical=item.identity===undefined?'1:2:3:100:100':item.identity;
    namespace.push({workspaceId:scope.workspace.workspaceId,path:item.path,kind:item.kind,identity:physical??`registry-directory:${nativeLinkJsonProof({workspaceId:scope.workspace.workspaceId,path:item.path})}`,
      filesystemIdentity:physical,documentId:null,lifecycleGeneration:null});}
  const body:Omit<WorkspaceSourceAuthorityStage,'stageProof'>={stageVersion:1,workspaceId:scope.workspace.workspaceId,organizationId:null,
    catalogueProof:nativeLinkJsonProof(nativeBindings.map(binding=>binding.registry)),namespace,sources:inventories.map(inventory=>({kind:'native',inventory})),
    scope:{kind:'visible-workspace',excludedPaths:[]},coverage:{complete:true,gaps:[]},readiness:'native-coordinator-required',executionReady:false};
  return {stage:{...body,stageProof:workspaceSourceAuthorityStageProof(body)},nativeBindings,privateNativeStates:states};
}
function physical(sourcePath:string,destinationPath:string,source:PreparedWorkspacePathMoveOriginal['source'],missingAt:number|null=null):PreparedWorkspacePathMoveOriginal {
  const parents=(pathname:string,missing:number|null)=>{const parts=pathname.split('/').slice(0,-1),length=missing===null?parts.length:missing;
    return {directories:parts.slice(0,length).map((_,index)=>({relativePath:parts.slice(0,index+1).join('/'),identity:identity('directory',String(10+index))})),
      missingPrefix:length<parts.length?parts.slice(0,length+1).join('/'):null};};
  return {version:1,workspace:{workspaceId:scope.workspace.workspaceId,workspaceType:'personal',organizationId:null,rootPath:scope.workspace.rootPath},sourcePath,destinationPath,
    budget:{maxDepth:32,maxEntries:10_000,maxHashBytes:4*1024**3},caseOnlyAlias:false,filesystem:{root:{resolvedPath:scope.workspace.rootPath,identity:identity('directory')},
      sourceParents:parents(sourcePath,null),destinationParents:parents(destinationPath,missingAt)},source};
}
function fixture(observed:WorkspaceLinkSourceAuthorityObservation,selections:Array<{sourcePath:string;destinationPath:string}>,originals:PreparedWorkspacePathMoveOriginal[]) {
  const plan=createWorkspaceOperationNativeMoveBatchPlan({scope,actions:[{kind:'move',reviewId:'direct_move',selections}],observation:observed});
  const context:codec.WorkspaceOperationOriginalMoveContext={batchId:'move-codec-batch-000001',requestHash:hash('request'),
    actor:{userId:'owner',actorId:'actor',actorType:'user',actorSessionId:null},plan};
  const paths=plan.nativePathPlan.pathMappings.filter(mapping=>mapping.source.documentId!==null),recipes=plan.nativePathPlan.mutations;
  const ids=new Set([...paths.map(mapping=>mapping.source.documentId!),...recipes.map(recipe=>recipe.source.documentId)]);
  const native:NativeFileOperationBundle={version:1,...codec.getWorkspaceOperationOriginalMoveNativeIds(context),action:'move',reviewDigest:plan.planId,
    actor:{actorUserId:'owner',actorId:'actor',actorType:'user',actorSessionId:null},mutations:[...ids].map(documentId=>{
      const binding=observed.nativeBindings.find(value=>value.expected.documentId===documentId)!,value=observed.privateNativeStates.find(item=>item.documentId===documentId)!;
      const inventory=observed.stage.sources.find(source=>source.kind==='native'&&source.inventory.document.documentId===documentId)!;
      assert.equal(inventory.kind,'native');const source=inventory.inventory.document;
      const mapping=paths.find(item=>item.source.documentId===documentId),selected=recipes.filter(recipe=>recipe.source.documentId===documentId);
      const mutationId=codec.getWorkspaceOperationOriginalMoveNativeIds(context,documentId).mutationId!;
      return {mutationId,kind:mapping?'move':'link',source,lineageId:binding.expected.lineageId,registryStateVersion:binding.expected.registryStateVersion,
        before:{documentSequence:7,persistedAt:100,stateProof:binding.expected.stateProof,stateVector:Buffer.from(value.stateVector).toString('base64'),binaryHash:binding.expected.binaryHash},
        destinationPath:mapping?.destinationPath??null,trashEntryId:null,prepared:selected.length?prepareNativeLinkMutations({state:value,recipes:selected,operationId:mutationId}):null};})};
  const captured=ids.size?captureNativeFileOperationBundle(native):null;
  const nativeBundle=captured?{privateText:captured.privateText,changesBundleProof:captured.changesBundleProof,actionPayloadText:captured.actionPayloadText}:null;
  const effects=codec.workspaceOperationOriginalMoveNamespaceEffects(context),beforeRows={metadata:effects.map(effect=>({workspaceId:plan.workspaceId,
    path:effect.sourcePath,title:'Declared title',createdAt:1,updatedAt:2})),userStates:[],guests:[],publicShares:[],locks:[]};
  const stageText=json({version:1,batchId:context.batchId,planId:plan.planId,workspaceId:plan.workspaceId,organizationId:null,
    requestHash:context.requestHash,actor:context.actor,schema:'declared_fixture',effectsProof:nativeLinkJsonProof(effects),beforeRows,lineages:[]});
  const namespaceState=effects.length?{stageText,stageDigest:hash(stageText)}:null;
  const intent=codec.createWorkspaceOperationOriginalMoveIntent({physical:originals,nativeBundle,namespaceState},context);
  return {context,intent,nativeBundle};
}
// These comparisons use actual Yjs/compiler outputs with DECLARED native DAL
// receipts and FS identities. They test math/limits, not fixed-owner admission.
function completed(observed:WorkspaceLinkSourceAuthorityObservation, originals:PreparedWorkspacePathMoveOriginal[],
  selections:Array<{sourcePath:string;destinationPath:string}>, extras:Array<{path:string;kind:'file'|'directory';identity?:string|null}>=[]) {
  const value=fixture(observed,selections,originals),{context,intent}=value;
  const compiled=assertWorkspaceOperationNativeMoveBatchPlanCurrent(context.plan,observed,captureWorkspaceOperationJobScope(scope.workspace));
  const physicalReceipts:PreparedWorkspacePathMoveReceipt[]=originals.map(original=>({version:1,original,createdParents:[],
    observation:original.source.kind==='projection_absent'?{kind:'projection_absent'}:{kind:'moved',method:'rename-no-replace',source:original.source}}));
  const facts=deriveOriginalMoveSourceNamespaceFacts(context,originals,physicalReceipts,[]);
  const bundle=codec.readWorkspaceOperationOriginalMoveNativeBundle(intent);
  const receipts:NativeFileOperationReceipt[]=[];
  const states=observed.privateNativeStates.map(before=>{
    const mutation=bundle?.mutations.find(item=>item.source.documentId===before.documentId);if(!mutation)return structuredClone(before);
    const doc=new Y.Doc();let bytes:Uint8Array,vector:Uint8Array;
    try{Y.applyUpdate(doc,before.yjsState);if(mutation.prepared)Y.applyUpdate(doc,mutation.prepared.update);
      bytes=Y.encodeStateAsUpdate(doc);vector=Y.encodeStateVector(doc);}finally{doc.destroy();}
    const next={...before,path:mutation.destinationPath??before.path,yjsState:bytes!,stateVector:vector!,
      documentSequence:before.documentSequence+(mutation.prepared?1:0),persistedAt:before.persistedAt+(mutation.prepared?1:0)};
    const inventory=inspectPersistedNativeCollaborationSnapshot(next,inspectNativeDocumentLinks);
    const identity=inventory.document;
    receipts.push({version:1,operationId:bundle!.operationId,mutationId:mutation.mutationId,requestId:bundle!.requestId,
      requestDigest:hash('declared-request'),changesBundleProof:intent.nativeBundle!.changesBundleProof,actor:bundle!.actor,
      reviewDigest:bundle!.reviewDigest,action:bundle!.action,kind:mutation.kind,source:mutation.source,lineageId:mutation.lineageId,
      before:mutation.before,beforeRegistryStateVersion:mutation.registryStateVersion,
      after:{identity,status:'active',clock:{documentSequence:next.documentSequence,persistedAt:next.persistedAt,stateProof:inventory.version.stateProof,
        stateVector:Buffer.from(next.stateVector).toString('base64'),binaryHash:hash(next.yjsState)},registryStateVersion:mutation.kind==='link'?mutation.registryStateVersion:0},
      projection:{status:'pending',path:next.path,filesystemComplete:false},inverseRecipes:mutation.prepared?.inverseRecipes??[]});return next;
  });
  const final=observation(states,extras);
  for(const [index,binding] of final.nativeBindings.entries()) {
    const original=observed.nativeBindings.find(item=>item.expected.documentId===binding.expected.documentId)!;
    const receipt=receipts.find(item=>item.source.documentId===binding.expected.documentId),next=states[index];
    Object.assign(binding.expected,{lineageId:original.expected.lineageId,documentSequence:next.documentSequence,persistedAt:next.persistedAt,
      registryStateVersion:receipt?.after.registryStateVersion??original.expected.registryStateVersion});
    Object.assign(binding.registry,{lineageId:original.registry.lineageId,stateVersion:receipt?.after.registryStateVersion??original.registry.stateVersion});
    Object.assign(binding.lineage,{lineageId:original.lineage.lineageId});
  }
  // Fresh registry-only parents are computed from final paths, rather than
  // copied from original logical IDs; the comparison must handle both views.
  for(const entry of [...final.stage.namespace])if(entry.documentId){let parent=entry.path.includes('/')?entry.path.slice(0,entry.path.lastIndexOf('/')):'';
    while(parent){if(!final.stage.namespace.some(item=>item.path===parent))final.stage.namespace.push({workspaceId:scope.workspace.workspaceId,path:parent,kind:'directory',
      documentId:null,lifecycleGeneration:null,filesystemIdentity:null,identity:`registry-directory:${nativeLinkJsonProof({workspaceId:scope.workspace.workspaceId,path:parent})}`});
      parent=parent.includes('/')?parent.slice(0,parent.lastIndexOf('/')):'';}}
  const input={context,intent,compiled,facts,observation:final,nativeReceipts:receipts};
  return {input,physicalReceipts,check:()=>assertOriginalMoveFinalSourceGraph(input)};
}
for(const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const)test(`native-only ${representation} final graph uses original logical IDs and receipt clocks`,()=>{
  const observed=observation([state('a.md','[Self](a.md)',representation)]);
  const done=completed(observed,[physical('a.md','new/deep/b.md',{kind:'projection_absent'},0)], [{sourcePath:'a.md',destinationPath:'new/deep/b.md'}]);
  done.check();assert.equal(done.input.nativeReceipts[0].kind,'move');assert.equal(done.input.nativeReceipts[0].after.identity.path,'new/deep/b.md');
  assert.equal(done.input.observation.stage.namespace.find(item=>item.path==='new')?.filesystemIdentity,null);
});
for(const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const)test(`PDF incoming ${representation} link-only final graph preserves original asset entity ID`,()=>{
  const observed=observation([state('links.md','[PDF](a.pdf)',representation)],[{path:'a.pdf',kind:'file'}]);
  const done=completed(observed,[physical('a.pdf','b.pdf',{kind:'regular_file',identity:identity('file'),sha256:hash('pdf')})],
    [{sourcePath:'a.pdf',destinationPath:'b.pdf'}],[{path:'b.pdf',kind:'file'}]);
  done.check();assert.equal(done.input.nativeReceipts[0].kind,'link');
  assert.equal(done.input.compiled.finalEdges[0].resolution.targetEntityKey,done.input.compiled.finalNamespace.find(item=>item.path==='b.pdf')!.entityKey);
  const target=done.input.observation.stage.namespace.find(item=>item.path==='b.pdf')!;target.identity='1:2:3:100:101';target.filesystemIdentity=target.identity;
  assert.throws(done.check,{code:'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED'});
});
test('pure PDF move without any native source still verifies complete final namespace',()=>{
  const observed=observation([],[{path:'a.pdf',kind:'file'}]);
  const done=completed(observed,[physical('a.pdf','b.pdf',{kind:'regular_file',identity:identity('file'),sha256:hash('pdf')})],
    [{sourcePath:'a.pdf',destinationPath:'b.pdf'}],[{path:'b.pdf',kind:'file'}]);
  done.check();assert.equal(done.input.nativeReceipts.length,0);
});
test('exact owned physical membership never covers a foreign sibling or prefix lookalike',()=>{
  const observed=observation([],[{path:'a.pdf',kind:'file'}]);
  const done=completed(observed,[physical('a.pdf','new.pdf',{kind:'regular_file',identity:identity('file'),sha256:hash('pdf')})],
    [{sourcePath:'a.pdf',destinationPath:'new.pdf'}],[{path:'new.pdf',kind:'file'}]);done.check();
  assert.deepEqual(done.input.facts.moved.map(item=>[item.originalPath,item.currentPath]),[['a.pdf','new.pdf']]);
  for(const filePath of ['a.pdf','new.pdf.foreign','sibling.bin']) {
    const changed={...structuredClone(done.input),intent:done.input.intent};changed.observation.stage.namespace.push({workspaceId:scope.workspace.workspaceId,path:filePath,kind:'file',
      documentId:null,lifecycleGeneration:null,identity:'1:99:3:100:100',filesystemIdentity:'1:99:3:100:100'});
    assert.throws(()=>assertOriginalMoveFinalSourceGraph(changed),{code:'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED'});
  }
});
test('receipt binary, vector and native durable clock drift all reject despite matching semantic text',()=>{
  const done=completed(observation([state('a.md')]),[physical('a.md','b.md',{kind:'projection_absent'})],[{sourcePath:'a.md',destinationPath:'b.md'}]);done.check();
  for(const field of ['binaryHash','stateVector','documentSequence','persistedAt'] as const) {
    const changed={...structuredClone(done.input),intent:done.input.intent},clock=changed.nativeReceipts[0].after.clock;
    if(field==='binaryHash')clock[field]=hash('foreign');else if(field==='stateVector')clock[field]=Buffer.from('foreign').toString('base64');else clock[field]++;
    assert.throws(()=>assertOriginalMoveFinalSourceGraph(changed),{code:'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED'});
  }
});
test('ordinary collector has no overlay and caller DTO cannot enter the genuine owner read seam',async()=>{
  const connection={get:async()=>assert.fail('Unowned source seam must reject before SQL.'),all:async()=>assert.fail('No SQL.'),run:async()=>assert.fail('No SQL.'),close:async()=>assert.fail('No close.')} as SqlConnection;
  assert.equal(readOriginalMoveCollectorOverlay(connection,scope.workspace),undefined);
  await assert.rejects(readWorkspaceOperationOriginalMoveSourcesOnConnection(connection,scope.workspace,'original'),{code:'JOB_LIFECYCLE_REQUIRED'});
});
test('native-only logical folder derives new implicit IDs and drops abandoned old implicit views',()=>{
  const observed=observation([state('group/a.md','[Self](a.md)')],[{path:'group',kind:'directory',identity:null}]);
  const done=completed(observed,[physical('group','moved',{kind:'projection_absent'})],[{sourcePath:'group',destinationPath:'moved'}]);
  done.check();assert(done.input.compiled.finalNamespace.some(item=>item.path==='moved'&&item.kind==='directory'));
  assert.equal(done.input.observation.stage.namespace.some(item=>item.path==='group'),false);
});
test('physical folder inventory maps every asset and empty directory by exact member',()=>{
  const extras=[{path:'folder',kind:'directory' as const,identity:'1:10:3:100:100'},
    {path:'folder/a.pdf',kind:'file' as const,identity:'1:11:3:100:100'},
    {path:'folder/empty',kind:'directory' as const,identity:'1:12:3:100:100'}];
  const original=physical('folder','moved',{kind:'directory',entries:[{relativePath:'',kind:'directory',identity:identity('directory','10')},
    {relativePath:'a.pdf',kind:'regular_file',identity:identity('file','11'),sha256:hash('pdf')},
    {relativePath:'empty',kind:'directory',identity:identity('directory','12')}]});
  const done=completed(observation([],extras),[original],[{sourcePath:'folder',destinationPath:'moved'}],extras.map(item=>({...item,path:item.path.replace(/^folder/u,'moved')})));
  done.check();assert.deepEqual(done.input.facts.moved.map(item=>item.currentPath),['moved','moved/a.pdf','moved/empty']);
  const changed={...structuredClone(done.input),intent:done.input.intent};
  changed.observation.stage.namespace.find(item=>item.path==='moved/empty')!.filesystemIdentity='1:99:3:100:100';
  assert.throws(()=>assertOriginalMoveFinalSourceGraph(changed),{code:'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED'});
});
test('only an exact receipt-born physical parent is additional final namespace',()=>{
  const observed=observation([],[{path:'a.pdf',kind:'file'}]);
  const original=physical('a.pdf','new/b.pdf',{kind:'regular_file',identity:identity('file'),sha256:hash('pdf')},0);
  const done=completed(observed,[original],[{sourcePath:'a.pdf',destinationPath:'new/b.pdf'}],
    [{path:'new',kind:'directory',identity:'1:200:3:100:100'},{path:'new/b.pdf',kind:'file'}]);
  const born={version:1 as const,originalProof:preparedWorkspacePathMoveProof(original),relativePath:'new',identity:identity('directory','200')};
  done.input.facts=deriveOriginalMoveSourceNamespaceFacts(done.input.context,[original],done.physicalReceipts,[born]);done.check();
  const changed={...structuredClone(done.input),intent:done.input.intent};
  changed.observation.stage.namespace.find(item=>item.path==='new')!.filesystemIdentity='1:201:3:100:100';
  assert.throws(()=>assertOriginalMoveFinalSourceGraph(changed),{code:'ORIGINAL_MOVE_FINAL_GRAPH_CHANGED'});
});
test('actual DAL clears a historical active lineage trash reference without losing the original document identity',()=>{
  const observed=observation([state('a.md')]);
  Reflect.set(observed.nativeBindings[0].lineage,'trashEntryId','historical-restored-trash');
  const done=completed(observed,[physical('a.md','b.md',{kind:'projection_absent'})],[{sourcePath:'a.md',destinationPath:'b.md'}]);
  assert.equal(done.input.observation.nativeBindings[0].lineage.trashEntryId,null);done.check();
});
