import assert from 'node:assert/strict';
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
import type { PreparedPathMoveIdentity, PreparedWorkspacePathMoveOriginal } from '../app/lib/filesystem/prepared-workspace-path-move-contract';
import type { WorkspaceOperationOriginalMoveIntent, WorkspaceOperationOriginalMoveParentReceipt, WorkspaceOperationOriginalMovePathReceipt,
  WorkspaceOperationOriginalMoveReceipt } from '../app/lib/files/workspace-operation-original-move-repository';

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
function nativeOnly(representation:PersistedCollaborationState['representation']='plain_text') {
  return fixture(observation([state('a.md','Original',representation)]),[{sourcePath:'a.md',destinationPath:'b.md'}],[physical('a.md','b.md',{kind:'projection_absent'})]);
}
function parentRows(intent:codec.WorkspaceOperationOriginalMoveIntentData):WorkspaceOperationOriginalMoveParentReceipt[] {
  return intent.parents.map((parent,index)=>{
    const step=intent.steps.find(item=>item.stepKey===parent.producerStep)!;
    const value:codec.WorkspaceOperationOriginalMoveParentReceiptData={version:1,batchId:intent.batchId,intentDigest:hash(json(intent)),...parent,
      birth:{version:1,originalProof:step.originalProof,relativePath:parent.parentPath,identity:identity('directory',String(200+index))}};
    const receiptText=json(value),consumerBindingsText=json(parent.consumers);
    return {batchId:intent.batchId,intentDigest:value.intentDigest,parentPath:parent.parentPath,parentKey:hash(parent.parentPath),producerStep:parent.producerStep,
      consumerBindingsText,consumerBindingsDigest:hash(consumerBindingsText),receiptText,receiptDigest:hash(receiptText),createdAt:101};});
}
function pathRows(intent:codec.WorkspaceOperationOriginalMoveIntentData,parents=parentRows(intent)):WorkspaceOperationOriginalMovePathReceipt[] {
  return intent.steps.map(step=>{
    const source=structuredClone(step.physical.source),own=parents.filter(parent=>parent.producerStep===step.stepKey);
    const value:codec.WorkspaceOperationOriginalMovePathReceiptData={version:1,batchId:intent.batchId,intentDigest:hash(json(intent)),stepKey:step.stepKey,
      originalProof:step.originalProof,physical:{version:1,original:step.physical,createdParents:own.map(row=>JSON.parse(row.receiptText).birth),
        observation:source.kind==='projection_absent'?{kind:'projection_absent'}:{kind:'moved',method:'rename-no-replace',source}},
      parentReceipts:parents.filter(parent=>step.physical.source.kind!=='projection_absent'&&intent.parents.find(item=>item.parentPath===parent.parentPath)!.consumers.some(consumer=>consumer.stepKey===step.stepKey))
        .map(parent=>({parentPath:parent.parentPath,receiptDigest:parent.receiptDigest}))};
    const receiptText=json(value);return {batchId:intent.batchId,intentDigest:value.intentDigest,stepKey:step.stepKey,receiptText,receiptDigest:hash(receiptText),createdAt:102};});
}
function completion(intent:codec.WorkspaceOperationOriginalMoveIntentData,parents=parentRows(intent),paths=pathRows(intent,parents)):WorkspaceOperationOriginalMoveReceipt {
  const native=codec.readWorkspaceOperationOriginalMoveNativeBundle(intent);
  let namespaceEffects:codec.WorkspaceOperationOriginalMoveCompletionData['namespaceEffects']=null;
  if(intent.namespaceState){const stage=JSON.parse(intent.namespaceState.stageText),mapping=new Map(intent.namespaceEffects.map(effect=>[effect.sourcePath,effect.destinationPath]));
    const rows={...stage.beforeRows,metadata:stage.beforeRows.metadata.map((row:{path:string})=>({...row,path:mapping.get(row.path)}))};
    const receiptText=json({version:1,batchId:intent.batchId,planId:intent.planId,workspaceId:intent.jobScope.workspaceId,
      effectsProof:stage.effectsProof,stageDigest:intent.namespaceState.stageDigest,appliedAt:104,afterRowsProof:nativeLinkJsonProof({rows,lineages:[]}),
      rowCounts:{metadata:rows.metadata.length,userStates:0,guests:0,publicShares:0,locks:0,lineages:0}});
    namespaceEffects={effectsProof:stage.effectsProof,receiptDigest:hash(receiptText),receiptText};}
  const value:codec.WorkspaceOperationOriginalMoveCompletionData={version:1,batchId:intent.batchId,intentDigest:hash(json(intent)),planId:intent.planId,
    compilerPlanProof:intent.compilerPlanProof,finalGraphProof:intent.finalGraphProof,parentReceipts:parents.map(parent=>({parentPath:parent.parentPath,receiptDigest:parent.receiptDigest})),
    pathReceipts:paths.map(path=>({stepKey:path.stepKey,receiptDigest:path.receiptDigest})),native:native?{operationId:native.operationId,requestId:native.requestId,
      changesBundleProof:intent.nativeBundle!.changesBundleProof,receipts:native.mutations.map(mutation=>({mutationId:mutation.mutationId,receiptDigest:hash(mutation.mutationId)})),
      sideEffectReceiptDigest:native.mutations.some(mutation=>mutation.kind==='move')?hash('native-effects'):null}:null,
    namespaceEffects};
  const receiptText=json(value);return {batchId:intent.batchId,intentDigest:value.intentDigest,receiptText,receiptDigest:hash(receiptText),createdAt:103};
}
function intentRow(intent:codec.WorkspaceOperationOriginalMoveIntentData):WorkspaceOperationOriginalMoveIntent {
  const intentText=json(intent);return {batchId:intent.batchId,planId:intent.planId,workspaceId:intent.jobScope.workspaceId,requestHash:intent.requestHash,
    intentText,intentDigest:hash(intentText),createdAt:100};
}
function rewrite<T extends {receiptText:string;receiptDigest:string}>(row:T,mutate:(value:Record<string,unknown>)=>void):T {
  const value=JSON.parse(row.receiptText);mutate(value);const receiptText=json(value);return {...row,receiptText,receiptDigest:hash(receiptText)};
}
function shared() {
  const names=['a.md','b.md','c.md'],states=names.map(name=>state(name)),selections=names.map(name=>({sourcePath:name,destinationPath:'new/'+name}));
  return fixture(observation(states,[],{'a.md':'1:2:3:100:100','b.md':'1:3:3:100:100'}),selections,selections.map((item,index)=>physical(item.sourcePath,item.destinationPath,
    index===2?{kind:'projection_absent'}:{kind:'regular_file',identity:identity('file',String(2+index)),sha256:hash('abc')},0)));
}
for(const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const)test(`actual ${representation} native-only original and completion remain strictly bound`,()=>{
  const {intent,context}=nativeOnly(representation),row=intentRow(intent);
  assert.deepEqual(codec.parseWorkspaceOperationOriginalMoveIntent(row,context),intent);assert(Object.isFrozen(intent.steps[0].physical));
  const paths=pathRows(intent);assert.equal(codec.decodeWorkspaceOperationOriginalMovePathReceipt(paths[0],intent,[]).physical.observation.kind,'projection_absent');
  assert.equal(codec.decodeWorkspaceOperationOriginalMoveCompletion(completion(intent,[],paths),intent,[],paths).native?.receipts.length,1);
});
test('asset-only PDF move records namespace effects without inventing a native document',()=>{
  const observed=observation([],[{path:'a.pdf',kind:'file'}]);
  const {intent}=fixture(observed,[{sourcePath:'a.pdf',destinationPath:'b.pdf'}],[physical('a.pdf','b.pdf',{kind:'regular_file',identity:identity('file'),sha256:hash('pdf')})]);
  assert.equal(intent.nativeBundle,null);assert.deepEqual(intent.namespaceEffects.map(item=>item.sourcePath),['a.pdf']);
  const paths=pathRows(intent);assert(codec.decodeWorkspaceOperationOriginalMoveCompletion(completion(intent,[],paths),intent,[],paths).namespaceEffects);
});
for(const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const)test(`PDF with incoming ${representation} links retains real link-only bundle and separate metadata scope`,()=>{
  const value=state('links.md','[PDF](a.pdf)',representation),observed=observation([value],[{path:'a.pdf',kind:'file'}]);
  const {intent}=fixture(observed,[{sourcePath:'a.pdf',destinationPath:'b.pdf'}],[physical('a.pdf','b.pdf',{kind:'regular_file',identity:identity('file'),sha256:hash('pdf')})]);
  const bundle=codec.readWorkspaceOperationOriginalMoveNativeBundle(intent)!;assert.deepEqual(bundle.mutations.map(mutation=>mutation.kind),['link']);
  assert.equal(bundle.mutations[0].source.path,'links.md');assert.equal(intent.namespaceEffects[0].destinationPath,'b.pdf');
  const paths=pathRows(intent),result=codec.decodeWorkspaceOperationOriginalMoveCompletion(completion(intent,[],paths),intent,[],paths);
  assert.equal(result.native?.sideEffectReceiptDigest,null);assert(result.namespaceEffects);
});
test('shared parent has one genuine producer and explicit regular/native-absence consumers',()=>{
  const {intent}=shared();assert.equal(intent.parents.length,1);assert.equal(intent.parents[0].producerStep,'path:0000');
  assert.deepEqual(intent.parents[0].consumers.map(item=>item.sourceKind),['regular_file','regular_file','projection_absent']);
  const parents=parentRows(intent),paths=pathRows(intent,parents);
  assert.equal(codec.decodeWorkspaceOperationOriginalMovePathReceipt(paths[1],intent,parents).physical.createdParents.length,0);
  assert.equal(codec.decodeWorkspaceOperationOriginalMovePathReceipt(paths[2],intent,parents).physical.observation.kind,'projection_absent');
  codec.decodeWorkspaceOperationOriginalMoveCompletion(completion(intent,parents,paths),intent,parents,paths);
});
test('native absence alone plans no parent births even under missing target ancestors',()=>{
  const {intent}=fixture(observation([state('a.md')]),[{sourcePath:'a.md',destinationPath:'new/deep/a.md'}],[physical('a.md','new/deep/a.md',{kind:'projection_absent'},0)]);
  assert.deepEqual(intent.parents,[]);const paths=pathRows(intent);codec.decodeWorkspaceOperationOriginalMoveCompletion(completion(intent,[],paths),intent,[],paths);
});
test('a later producer can consume a shared parent and birth a deeper parent without rewriting either proof',()=>{
  const {intent}=fixture(observation([state('a.md'),state('b.md')],[],{'a.md':'1:2:3:100:100','b.md':'1:3:3:100:100'}),
    [{sourcePath:'a.md',destinationPath:'new/a.md'},{sourcePath:'b.md',destinationPath:'new/deeper/b.md'}],
    [physical('a.md','new/a.md',{kind:'regular_file',identity:identity('file'),sha256:hash('abc')},0),physical('b.md','new/deeper/b.md',{kind:'regular_file',identity:identity('file','3'),sha256:hash('abc')},0)]);
  const parents=parentRows(intent),paths=pathRows(intent,parents),decoded=codec.decodeWorkspaceOperationOriginalMovePathReceipt(paths[1],intent,parents);
  assert.deepEqual(decoded.physical.createdParents.map(item=>item.relativePath),['new/deeper']);assert.equal(decoded.parentReceipts.length,2);
});
test('strict own data rejects getters, prototypes, hidden keys, sparse arrays and invalid Unicode before copying',()=>{
  const {intent,context}=nativeOnly();let reads=0;
  const getter={...intent};Object.defineProperty(getter,'parents',{enumerable:true,get(){reads++;throw new Error('must not read');}});
  for(const value of [getter,{...intent,extra:true},Object.assign(Object.create({}),intent),{...intent,steps:new Array(1)},
    {...intent,actor:{...intent.actor,userId:'bad\ud800'}},{...intent,steps:[...intent.steps,undefined]}])assert.throws(()=>codec.captureWorkspaceOperationOriginalMoveIntent(value,context));
  assert.equal(reads,0);const hidden={...intent};Object.defineProperty(hidden,'hidden',{value:true});assert.throws(()=>codec.captureWorkspaceOperationOriginalMoveIntent(hidden,context));
});
test('original batch, actor, scope, request, plan and graph substitutions fail despite recomputed outer row digest',()=>{
  const {intent,context}=nativeOnly();
  for(const patch of [{batchId:'another-batch-0000001'},{requestHash:hash('different')},{actor:{...intent.actor,userId:'other'}},
    {jobScope:{...intent.jobScope,ownerUserId:'other'}},{planId:hash('different')},{compilerPlanProof:hash('different')},{finalGraphProof:hash('different')}]){
    const value={...intent,...patch};assert.throws(()=>codec.captureWorkspaceOperationOriginalMoveIntent(value,context));
    const literal=json(value);assert.throws(()=>codec.parseWorkspaceOperationOriginalMoveIntent({...intentRow(intent),intentText:literal,intentDigest:hash(literal)},context));
  }
});
test('physical selection, scope, proof, namespace metadata and shared consumers cannot be substituted',()=>{
  const {intent,context}=shared();
  const variants=[{...intent,steps:[...intent.steps].reverse()},{...intent,parents:[]},{...intent,parents:[{...intent.parents[0],producerStep:'path:0001'}]},
    {...intent,parents:[{...intent.parents[0],consumers:intent.parents[0].consumers.slice(0,2)}]},
    {...intent,namespaceEffects:[{sourcePath:'invented.pdf',destinationPath:'other.pdf',kind:'file',identity:'fake',filesystemIdentity:null}]}];
  for(const value of variants)assert.throws(()=>codec.captureWorkspaceOperationOriginalMoveIntent(value,context));
});
test('native bundle cannot swap mutations, lineage, before clock, actor or batch-bound IDs',()=>{
  const {intent,context}=nativeOnly();
  for(const mutate of [(bundle:Record<string,unknown>)=>{bundle.operationId='another';},(bundle:Record<string,unknown>)=>{bundle.actor={actorUserId:'other',actorId:'actor',actorType:'user',actorSessionId:null};},
    (bundle:Record<string,unknown>)=>{(bundle.mutations as Array<Record<string,unknown>>)[0].lineageId='wrong';},
    (bundle:Record<string,unknown>)=>{(bundle.mutations as Array<Record<string,unknown>>)[0].kind='link';},
    (bundle:Record<string,unknown>)=>{bundle.mutations=[];}]){
    const bundle=JSON.parse(intent.nativeBundle!.privateText);mutate(bundle);
    const value={...intent,nativeBundle:{...intent.nativeBundle!,privateText:JSON.stringify(bundle),changesBundleProof:hash(JSON.stringify(bundle))}};
    assert.throws(()=>codec.captureWorkspaceOperationOriginalMoveIntent(value,context));
  }
});
test('actual prepared rewrite membership, unknown fields, canonical Base64 and valid Yjs update structure are required',()=>{
  const observed=observation([state('links.md','[PDF](a.pdf)')],[{path:'a.pdf',kind:'file'}]);
  const {intent,context}=fixture(observed,[{sourcePath:'a.pdf',destinationPath:'b.pdf'}],[physical('a.pdf','b.pdf',{kind:'regular_file',identity:identity('file'),sha256:hash('pdf')})]);
  for(const mutate of [(prepared:Record<string,unknown>)=>{prepared.update='AA==';},(prepared:Record<string,unknown>)=>{prepared.update='%%%';},
    (prepared:Record<string,unknown>)=>{prepared.inverseRecipes=[];},(prepared:Record<string,unknown>)=>{prepared.unknown=true;},
    (prepared:Record<string,unknown>)=>{(prepared.inverseRecipes as Array<Record<string,unknown>>)[0].authorizedForwardRecipeProof=hash('forged');}]){
    const bundle=JSON.parse(intent.nativeBundle!.privateText);mutate(bundle.mutations[0].prepared);
    const privateText=JSON.stringify(bundle);assert.throws(()=>codec.captureWorkspaceOperationOriginalMoveIntent({...intent,nativeBundle:{...intent.nativeBundle!,privateText,changesBundleProof:hash(privateText)}},context));
  }
});
test('cumulative hash bytes refuse two individually permissible 3GiB roots before FS',()=>{
  const observed=observation([],[{path:'a.pdf',kind:'file',identity:`1:2:${3*1024**3}:100:100`},{path:'b.pdf',kind:'file',identity:`1:3:${3*1024**3}:100:100`}]);
  assert.throws(()=>fixture(observed,[{sourcePath:'a.pdf',destinationPath:'x.pdf'},{sourcePath:'b.pdf',destinationPath:'y.pdf'}],
    [physical('a.pdf','x.pdf',{kind:'regular_file',identity:identity('file','2',String(3*1024**3)),sha256:hash('a')}),
      physical('b.pdf','y.pdf',{kind:'regular_file',identity:identity('file','3',String(3*1024**3)),sha256:hash('b')})]),error=>error instanceof codec.WorkspaceOperationOriginalMoveCodecError&&error.code==='ORIGINAL_MOVE_TOO_LARGE');
});
test('exact cumulative 4GiB hash-byte boundary is permitted as declared mechanical evidence',()=>{
  const {intent}=fixture(observation([],[{path:'a.pdf',kind:'file',identity:`1:2:${4*1024**3}:100:100`}]),[{sourcePath:'a.pdf',destinationPath:'b.pdf'}],
    [physical('a.pdf','b.pdf',{kind:'regular_file',identity:identity('file','2',String(4*1024**3)),sha256:hash('declared-only')})]);
  codec.assertWorkspaceOperationOriginalMovePreflightBudget(intent);
});
test('cycles and dependencies fail before FS instead of adopting a staging or overwrite fallback',()=>{
  const observed=observation([state('a.md'),state('b.md')]);
  assert.throws(()=>fixture(observed,[{sourcePath:'a.md',destinationPath:'b.md'},{sourcePath:'b.md',destinationPath:'a.md'}],
    [physical('a.md','b.md',{kind:'projection_absent'}),physical('b.md','a.md',{kind:'projection_absent'})]));
});
test('receipt hashes and exact canonical text cannot be changed, including whitespace-only drift',()=>{
  const {intent,context}=nativeOnly(),original=intentRow(intent),paths=pathRows(intent),complete=completion(intent,[],paths);
  assert.throws(()=>codec.parseWorkspaceOperationOriginalMoveIntent({...original,intentText:original.intentText+' ',intentDigest:hash(original.intentText+' ')},context));
  assert.throws(()=>codec.decodeWorkspaceOperationOriginalMovePathReceipt({...paths[0],receiptDigest:hash('bad')},intent,[]));
  assert.throws(()=>codec.decodeWorkspaceOperationOriginalMoveCompletion({...complete,intentDigest:hash('wrong')},intent,[],paths));
});
test('parent path, producer, consumers, original proof, unsafe profile and digest drift are rejected',()=>{
  const {intent}=shared(),parents=parentRows(intent),original=parents[0];
  for(const row of [{...original,parentPath:'other'},{...original,producerStep:'path:0001'},
    {...original,consumerBindingsText:'[]',consumerBindingsDigest:hash('[]')},
    rewrite(original,value=>{(value.birth as Record<string,unknown>).originalProof=intent.steps[1].originalProof;}),
    rewrite(original,value=>{((value.birth as Record<string,unknown>).identity as Record<string,unknown>).mode=0o040777;})])
    assert.throws(()=>codec.decodeWorkspaceOperationOriginalMoveParentReceipt(row,intent));
});
test('only moved-root ctime may change, while nested bytes, inode and mtime remain exact',()=>{
  const {intent}=shared(),parents=parentRows(intent),row=pathRows(intent,parents)[0];
  const alter=(key:string,value:unknown)=>rewrite(row,data=>{const source=((data.physical as Record<string,unknown>).observation as Record<string,unknown>).source as Record<string,unknown>;
    (source.identity as Record<string,unknown>)[key]=value;});
  codec.decodeWorkspaceOperationOriginalMovePathReceipt(alter('ctimeNs','123456789'),intent,parents);
  for(const pair of [['inode','999'],['mtimeNs','123456789'],['linkCount','2']] as const)assert.throws(()=>codec.decodeWorkspaceOperationOriginalMovePathReceipt(alter(pair[0],pair[1]),intent,parents));
  assert.throws(()=>codec.decodeWorkspaceOperationOriginalMovePathReceipt(rewrite(row,data=>{((((data.physical as Record<string,unknown>).observation as Record<string,unknown>).source) as Record<string,unknown>).sha256=hash('wrong');}),intent,parents));
});
test('path receipts cannot omit/duplicate/substitute shared references or introduce unjournaled parents',()=>{
  const {intent}=shared(),parents=parentRows(intent),row=pathRows(intent,parents)[1];
  assert.throws(()=>codec.decodeWorkspaceOperationOriginalMovePathReceipt(row,intent,[]));
  for(const mutate of [(value:Record<string,unknown>)=>{value.parentReceipts=[];},(value:Record<string,unknown>)=>{value.originalProof=intent.steps[0].originalProof;},
    (value:Record<string,unknown>)=>{(value.physical as Record<string,unknown>).createdParents=[JSON.parse(parents[0].receiptText).birth];}])
    assert.throws(()=>codec.decodeWorkspaceOperationOriginalMovePathReceipt(rewrite(row,mutate),intent,parents));
});
test('completion requires all and only original steps, parent rows, native receipt IDs and graph proofs',()=>{
  const {intent}=shared(),parents=parentRows(intent),paths=pathRows(intent,parents),row=completion(intent,parents,paths);
  assert.throws(()=>codec.decodeWorkspaceOperationOriginalMoveCompletion(row,intent,parents,paths.slice(1)));
  assert.throws(()=>codec.decodeWorkspaceOperationOriginalMoveCompletion(row,intent,parents,[paths[0],paths[0],paths[2]]));
  for(const mutate of [(value:Record<string,unknown>)=>{value.finalGraphProof=hash('wrong');},(value:Record<string,unknown>)=>{value.parentReceipts=[];},
    (value:Record<string,unknown>)=>{(value.native as Record<string,unknown>).receipts=[];},(value:Record<string,unknown>)=>{value.namespaceEffects={effectsProof:hash('wrong'),receiptDigest:hash('made-up')};}])
    assert.throws(()=>codec.decodeWorkspaceOperationOriginalMoveCompletion(rewrite(row,mutate),intent,parents,paths));
});
test('JSON token budget includes escaping and rejects cycles without invoking toJSON',()=>{
  const cycle:Record<string,unknown>={};cycle.cycle=cycle;assert.throws(()=>json(cycle));
  let calls=0;assert.throws(()=>json({toJSON(){calls++;return {};}}));assert.equal(calls,0);
  assert.throws(()=>json({value:'\n'.repeat(33*1024**2)}),error=>error instanceof codec.WorkspaceOperationOriginalMoveCodecError&&error.code==='ORIGINAL_MOVE_TOO_LARGE');
});

test('early NativeAbsence consumer needs no future parent birth but remains in its eventual producer binding',()=>{
  const {intent}=fixture(observation([state('a.md'),state('b.md')],[],{'b.md':'1:2:3:100:100'}),
    [{sourcePath:'a.md',destinationPath:'new/a.md'},{sourcePath:'b.md',destinationPath:'new/b.md'}],
    [physical('a.md','new/a.md',{kind:'projection_absent'},0),physical('b.md','new/b.md',{kind:'regular_file',identity:identity('file'),sha256:hash('abc')},0)]);
  assert.equal(intent.parents[0].producerStep,'path:0001');assert.equal(intent.parents[0].consumers[0].sourceKind,'projection_absent');
  const parents=parentRows(intent),paths=pathRows(intent,parents);
  assert.deepEqual(codec.decodeWorkspaceOperationOriginalMovePathReceipt(paths[0],intent,[]).parentReceipts,[]);
  codec.decodeWorkspaceOperationOriginalMoveCompletion(completion(intent,parents,paths),intent,parents,paths);
});

test('real native folder mapping includes assets and empty directories; descendant identities remain exact',()=>{
  const observed=observation([state('folder/note.md')],[{path:'folder',kind:'directory',identity:'1:10:3:100:100'},
    {path:'folder/a.pdf',kind:'file',identity:'1:11:3:100:100'},{path:'folder/empty',kind:'directory',identity:'1:12:3:100:100'}]);
  const original=physical('folder','moved',{kind:'directory',entries:[{relativePath:'',kind:'directory',identity:identity('directory','10')},
    {relativePath:'a.pdf',kind:'regular_file',identity:identity('file','11'),sha256:hash('pdf')},
    {relativePath:'empty',kind:'directory',identity:identity('directory','12')}]});
  const {intent}=fixture(observed,[{sourcePath:'folder',destinationPath:'moved'}],[original]);
  assert.deepEqual(intent.namespaceEffects.map(item=>item.sourcePath),['folder','folder/a.pdf','folder/empty']);
  const paths=pathRows(intent),row=paths[0];codec.decodeWorkspaceOperationOriginalMoveCompletion(completion(intent,[],paths),intent,[],paths);
  const altered=rewrite(row,value=>{const entries=(((value.physical as Record<string,unknown>).observation as Record<string,unknown>).source as Record<string,unknown>).entries as Array<Record<string,unknown>>;
    (entries[2].identity as Record<string,unknown>).ctimeNs='999';});
  assert.throws(()=>codec.decodeWorkspaceOperationOriginalMovePathReceipt(altered,intent,[]));
});

test('borrowed row arrays cannot invoke custom iterators, getters or silently ignore extra elements',()=>{
  const {intent}=shared(),parents=parentRows(intent),paths=pathRows(intent,parents),row=completion(intent,parents,paths);let reads=0;
  const supplied=[...parents];Object.defineProperty(supplied,Symbol.iterator,{value(){reads++;throw new Error('must not run');}});
  assert.throws(()=>codec.decodeWorkspaceOperationOriginalMovePathReceipt(paths[0],intent,supplied));assert.equal(reads,0);
  const sparse=new Array(paths.length) as typeof paths;assert.throws(()=>codec.decodeWorkspaceOperationOriginalMoveCompletion(row,intent,parents,sparse));
});

test('namespace stage is mandatory for actual asset effects and binds exact actor, request and before-image schema',()=>{
  const {intent,context}=fixture(observation([],[{path:'a.pdf',kind:'file'}]),[{sourcePath:'a.pdf',destinationPath:'b.pdf'}],
    [physical('a.pdf','b.pdf',{kind:'regular_file',identity:identity('file'),sha256:hash('pdf')})]);
  assert.throws(()=>codec.captureWorkspaceOperationOriginalMoveIntent({...intent,namespaceState:null},context));
  assert.throws(()=>codec.captureWorkspaceOperationOriginalMoveIntent({...intent,namespaceState:{...intent.namespaceState!,stageDigest:hash('wrong')}},context));
  for(const patch of [{requestHash:hash('different')},{actor:{...context.actor,userId:'wrong'}},{beforeRows:{metadata:[{unrecognized:true}],userStates:[],guests:[],publicShares:[],locks:[]}}]){
    const stageText=json({...JSON.parse(intent.namespaceState!.stageText),...patch});
    assert.throws(()=>codec.captureWorkspaceOperationOriginalMoveIntent({...intent,namespaceState:{stageText,stageDigest:hash(stageText)}},context));
  }
  const native=nativeOnly();assert.throws(()=>codec.captureWorkspaceOperationOriginalMoveIntent({...native.intent,namespaceState:intent.namespaceState},native.context));
});

test('namespace completion retains the actual compact body and verifies its after-image proof rather than trusting a digest',()=>{
  const {intent}=fixture(observation([],[{path:'a.pdf',kind:'file'}]),[{sourcePath:'a.pdf',destinationPath:'b.pdf'}],
    [physical('a.pdf','b.pdf',{kind:'regular_file',identity:identity('file'),sha256:hash('pdf')})]);
  const paths=pathRows(intent),row=completion(intent,[],paths);
  for(const mutate of [(value:Record<string,unknown>)=>{(value.namespaceEffects as Record<string,unknown>).receiptDigest=hash('wrong');},
    (value:Record<string,unknown>)=>{const effect=value.namespaceEffects as Record<string,unknown>,body=JSON.parse(effect.receiptText as string);
      body.afterRowsProof=hash('forged');effect.receiptText=json(body);effect.receiptDigest=hash(effect.receiptText as string);},
    (value:Record<string,unknown>)=>{delete (value.namespaceEffects as Record<string,unknown>).receiptText;}])
    assert.throws(()=>codec.decodeWorkspaceOperationOriginalMoveCompletion(rewrite(row,mutate),intent,[],paths));
});

test('parent birth cannot reuse an existing directory identity, cross device or alias another birth',()=>{
  const {intent}=shared(),parents=parentRows(intent);
  for(const mutate of [(value:Record<string,unknown>)=>{((value.birth as Record<string,unknown>).identity as Record<string,unknown>).inode='1';},
    (value:Record<string,unknown>)=>{((value.birth as Record<string,unknown>).identity as Record<string,unknown>).device='999';}])
    assert.throws(()=>codec.decodeWorkspaceOperationOriginalMoveParentReceipt(rewrite(parents[0],mutate),intent));
});

test('logical native-only directory has an absent physical root and retains every native descendant mapping',()=>{
  const observed=observation([state('logical/note.md')],[{path:'logical',kind:'directory',identity:null}]);
  const {intent}=fixture(observed,[{sourcePath:'logical',destinationPath:'new/moved'}],
    [physical('logical','new/moved',{kind:'projection_absent'},0)]);
  assert.equal(intent.steps[0].physical.source.kind,'projection_absent');assert.deepEqual(intent.parents,[]);
  assert.deepEqual(intent.namespaceEffects.map(effect=>effect.sourcePath),['logical']);
  assert.equal(codec.readWorkspaceOperationOriginalMoveNativeBundle(intent)?.mutations[0].destinationPath,'new/moved/note.md');
  const paths=pathRows(intent);codec.decodeWorkspaceOperationOriginalMoveCompletion(completion(intent,[],paths),intent,[],paths);
});
