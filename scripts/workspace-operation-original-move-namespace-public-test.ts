import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import type { NativeNamespaceEntry } from '../app/lib/markdown/workspace-link-contract-v2';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { createWorkspaceOperationNativeMoveBatchPlan } from '../app/lib/files/workspace-operation-native-move-plan';
import { serializeWorkspaceOperationOriginalMoveData, workspaceOperationOriginalMoveNamespaceEffects,
  type WorkspaceOperationOriginalMoveContext } from '../app/lib/files/workspace-operation-original-move';
import { decodeWorkspaceOperationOriginalMoveNamespaceStage, decodeWorkspaceOperationOriginalMoveNamespaceReceipt,
  type WorkspaceOperationOriginalMoveNamespaceStage } from '../app/lib/files/workspace-operation-original-move-namespace-effects';
import { projectWorkspaceOperationNativeMoveExecution, workspaceOperationNativeMoveExecutionResult,
  workspaceOperationNativeMoveEffects, workspaceOperationNativeMoveMutationEvidence } from '../app/lib/files/workspace-operation-native-move-execution-public';
import { workspacePathOperationPreview } from '../app/lib/files/workspace-path-operation-preview';

// Declared metadata/lock/receipt rows exercise pure codecs and presentation.
// The link plan/inventory uses actual Yjs. This suite creates no PG connection,
// filesystem capability, admission grant or integrated worker/runtime evidence.
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const json=serializeWorkspaceOperationOriginalMoveData;
const scope:WorkspaceOperationBatchScope={workspace:{workspaceId:'namespace-public-workspace',rootPath:'/declared/workspace',
  rootRelativePath:'users/owner/workspace',workspaceType:'personal',organizationId:null,ownerUserId:'owner',legacy:false,status:'active',
  permissions:{canRead:true,canWrite:true,canDelete:true,canRunAgent:true,canManageWorkspace:true,canCreatePublicLinks:false}},fileOptions:{}};
function originalPlan(destinations=['y.pdf','b.pdf'],withLinks=false,representation:PersistedCollaborationState['representation']='plain_text',
  content='[First](a.pdf) [Second](z.pdf)') {
  const values:PersistedCollaborationState[]=[];
  if(withLinks){const doc=representation==='plain_text'?createPlainTextYDoc(content):createRichMarkdownYDoc(content,representation);
    try{values.push({documentId:'private-document-id',workspaceId:scope.workspace.workspaceId,organizationId:null,path:'links.md',representation,
      lifecycleGeneration:1,schemaVersion:1,documentSequence:7,persistedAt:100,checkpointSequence:0,checkpointedAt:null,canonicalHash:null,serializedHash:null,
      newlineStyle:'lf',hasBom:false,degraded:false,status:'active',yjsState:Y.encodeStateAsUpdate(doc),stateVector:Y.encodeStateVector(doc)});}finally{doc.destroy();}}
  const inventories=values.map(value=>inspectPersistedNativeCollaborationSnapshot(value,inspectNativeDocumentLinks));
  const nativeBindings:WorkspaceNativeSourceBinding[]=values.map((value,index)=>({expected:{documentId:value.documentId,lineageId:'private-lineage-id',
    workspaceId:value.workspaceId,organizationId:null,path:value.path,representation:value.representation,schemaVersion:1,lifecycleGeneration:1,registryStateVersion:7,
    documentSequence:7,persistedAt:100,binaryHash:hash(value.yjsState),vectorHash:hash(value.stateVector),stateProof:inventories[index].version.stateProof},
    registry:{documentId:value.documentId,lineageId:'private-lineage-id',workspaceId:value.workspaceId,workspaceType:'personal',organizationId:null,customerId:null,projectId:null,
      path:value.path,provider:'yjs',stateLifecycle:'initialized',stateVersion:7,status:'active'},
    lineage:{lineageId:'private-lineage-id',workspaceId:value.workspaceId,workspaceType:'personal',organizationId:null,customerId:null,projectId:null,path:value.path,
      status:'active',archivedAt:null,trashEntryId:null},byteProfile:{newlineStyle:'lf',hasBom:false},inventoryProof:nativeLinkJsonProof(inventories[index])}));
  const namespace:NativeNamespaceEntry[]=['a.pdf','z.pdf'].map((filePath,index)=>({workspaceId:scope.workspace.workspaceId,path:filePath,kind:'file',
    identity:`1:${index+2}:3:100:100`,filesystemIdentity:`1:${index+2}:3:100:100`,documentId:null,lifecycleGeneration:null}));
  for(const value of values)namespace.push({workspaceId:value.workspaceId,path:value.path,kind:'file',identity:`registry:${value.documentId}:1`,
    filesystemIdentity:null,documentId:value.documentId,lifecycleGeneration:1});
  const body:Omit<WorkspaceSourceAuthorityStage,'stageProof'>={stageVersion:1,workspaceId:scope.workspace.workspaceId,organizationId:null,
    catalogueProof:nativeLinkJsonProof(nativeBindings.map(binding=>binding.registry)),namespace,sources:inventories.map(inventory=>({kind:'native',inventory})),
    scope:{kind:'visible-workspace',excludedPaths:[]},coverage:{complete:true,gaps:[]},readiness:'native-coordinator-required',executionReady:false};
  const observation:WorkspaceLinkSourceAuthorityObservation={stage:{...body,stageProof:workspaceSourceAuthorityStageProof(body)},nativeBindings,privateNativeStates:values};
  return createWorkspaceOperationNativeMoveBatchPlan({scope,actions:[{kind:'move',reviewId:'direct-move',selections:['a.pdf','z.pdf'].map((sourcePath,index)=>
    ({sourcePath,destinationPath:destinations[index]}))}],observation});
}
function namespaceFixture(destinations=['y.pdf','b.pdf']) {
  const plan=originalPlan(destinations),context:WorkspaceOperationOriginalMoveContext={batchId:'namespace-batch-0000001',requestHash:hash('request'),
    actor:{userId:'owner',actorId:'requesting-actor',actorType:'user',actorSessionId:'session'},plan};
  const stage:WorkspaceOperationOriginalMoveNamespaceStage={version:1,batchId:context.batchId,planId:plan.planId,workspaceId:plan.workspaceId,organizationId:null,
    requestHash:context.requestHash,actor:context.actor,schema:'declared_schema',effectsProof:nativeLinkJsonProof(workspaceOperationOriginalMoveNamespaceEffects(context)),
    beforeRows:{metadata:['a.pdf','z.pdf'].map(filePath=>({workspaceId:plan.workspaceId,path:filePath,title:filePath,createdAt:1,updatedAt:2})),
      userStates:['a.pdf','z.pdf'].map(filePath=>({workspaceId:plan.workspaceId,userId:'owner',path:filePath,isFavorite:true,pinnedAt:null,createdAt:1,updatedAt:2})),
      guests:[],publicShares:[],locks:[]},lineages:[]};
  return {context,stage};
}
const byteOrder=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
function expectedAfter(stage:WorkspaceOperationOriginalMoveNamespaceStage,context:WorkspaceOperationOriginalMoveContext,at=100) {
  const mapping=new Map(workspaceOperationOriginalMoveNamespaceEffects(context).map(effect=>[effect.sourcePath,effect.destinationPath]));
  const rows=structuredClone(stage.beforeRows);
  rows.metadata=rows.metadata.map(row=>({...row,path:mapping.get(String(row.path))!})).sort((a,b)=>byteOrder(String(a.path),String(b.path)));
  rows.userStates=rows.userStates.map<Record<string,unknown>>(row=>({...row,path:mapping.get(String(row.path))!})).sort((a,b)=>byteOrder(`${a.path}\u001f${a.userId}`,`${b.path}\u001f${b.userId}`));
  rows.publicShares=rows.publicShares.map(row=>({...row,status:'revoked',policyRevision:Number(row.policyRevision)+1,revokedAt:at,revokedReason:'target_moved',updatedAt:at}));
  rows.locks=rows.locks.map(row=>({...row,path:Number(row.expiresAt)>at?mapping.get(String(row.path))!:row.path,
    status:Number(row.expiresAt)>at?'active':'expired',updatedAt:at}));
  return {rows,lineages:stage.lineages.map(row=>({...row,path:mapping.get(String(row.path))!}))};
}
function namespaceReceipt(stage:WorkspaceOperationOriginalMoveNamespaceStage,context:WorkspaceOperationOriginalMoveContext,
  after=expectedAfter(stage,context),at=100) {
  const stageText=json(stage),state={stageText,stageDigest:hash(stageText)};
  const receiptText=json({version:1,batchId:context.batchId,planId:context.plan.planId,workspaceId:context.plan.workspaceId,effectsProof:stage.effectsProof,
    stageDigest:state.stageDigest,appliedAt:at,afterRowsProof:nativeLinkJsonProof(after),rowCounts:{metadata:stage.beforeRows.metadata.length,
      userStates:stage.beforeRows.userStates.length,guests:stage.beforeRows.guests.length,publicShares:stage.beforeRows.publicShares.length,
      locks:stage.beforeRows.locks.length,lineages:stage.lineages.length}});
  return {receiptText,state};
}
function lock(context:WorkspaceOperationOriginalMoveContext,patch:Record<string,unknown>={}) {
  return {id:'declared-lock',workspaceId:context.plan.workspaceId,organizationId:null,path:'a.pdf',lineageId:null,revisionId:null,
    lockedByUserId:context.actor.userId,lockedBySessionId:context.actor.actorSessionId,lockType:'edit',status:'active',expiresAt:200,
    createdAt:1,updatedAt:2,preservedRowProof:hash('private-preserved-lock'),...patch};
}

test('original namespace stage rejects injected destination metadata after its JSON and digest are correctly rebuilt',()=>{
  const {context,stage}=namespaceFixture();
  for(const key of ['metadata','userStates'] as const){
    const poisoned=structuredClone(stage);poisoned.beforeRows[key][0].path='y.pdf';
    const {state}=namespaceReceipt(poisoned,context);
    assert.equal(state.stageDigest,hash(state.stageText));
    assert.throws(()=>decodeWorkspaceOperationOriginalMoveNamespaceStage(state.stageText,context),{code:'ORIGINAL_MOVE_NAMESPACE_INVALID'});
  }
  const poisoned=structuredClone(stage);poisoned.beforeRows.publicShares=[{id:'share',workspaceId:context.plan.workspaceId,organizationId:null,path:'y.pdf',
    status:'active',policyRevision:1,revokedAt:null,revokedReason:null,updatedAt:2,preservedRowProof:hash('private-share')}];
  assert.throws(()=>decodeWorkspaceOperationOriginalMoveNamespaceStage(json(poisoned),context),{code:'ORIGINAL_MOVE_NAMESPACE_INVALID'});
});

test('after-image order follows remapped paths and refuses an old-order proof despite matching values',()=>{
  const {context,stage}=namespaceFixture(),after=expectedAfter(stage,context),receipt=namespaceReceipt(stage,context,after);
  assert.deepEqual(after.rows.metadata.map(row=>row.path),['b.pdf','y.pdf']);
  decodeWorkspaceOperationOriginalMoveNamespaceReceipt(receipt.receiptText,context,receipt.state);
  const unsorted={...after,rows:{...after.rows,metadata:[...after.rows.metadata].reverse(),userStates:[...after.rows.userStates].reverse()}};
  const wrong=namespaceReceipt(stage,context,unsorted);
  assert.throws(()=>decodeWorkspaceOperationOriginalMoveNamespaceReceipt(wrong.receiptText,context,wrong.state),{code:'ORIGINAL_MOVE_NAMESPACE_INVALID'});
});

test('after-image UTF-8 C ordering differs from JS UTF-16 order and remains accepted for valid Unicode paths',()=>{
  const {context,stage}=namespaceFixture(['\u{10000}.pdf','\uE000.pdf']),after=expectedAfter(stage,context),receipt=namespaceReceipt(stage,context,after);
  assert.deepEqual(after.rows.metadata.map(row=>row.path),['\uE000.pdf','\u{10000}.pdf']);
  decodeWorkspaceOperationOriginalMoveNamespaceReceipt(receipt.receiptText,context,receipt.state);
  const utf16={...after,rows:{...after.rows,metadata:[...after.rows.metadata].sort((a,b)=>String(a.path)<String(b.path)?-1:1)}};
  const wrong=namespaceReceipt(stage,context,utf16);
  assert.throws(()=>decodeWorkspaceOperationOriginalMoveNamespaceReceipt(wrong.receiptText,context,wrong.state),{code:'ORIGINAL_MOVE_NAMESPACE_INVALID'});
});

test('a foreign unexpired lock cannot be approved by a correctly hashed historical namespace receipt',()=>{
  const {context,stage}=namespaceFixture();
  for(const patch of [{lockedByUserId:'another-user'},{lockedBySessionId:'another-session'},{path:'y.pdf'}]){
    const poisoned=structuredClone(stage);poisoned.beforeRows.locks=[lock(context,patch)];
    const receipt=namespaceReceipt(poisoned,context);
    assert.throws(()=>decodeWorkspaceOperationOriginalMoveNamespaceReceipt(receipt.receiptText,context,receipt.state),{code:'ORIGINAL_MOVE_NAMESPACE_BUSY'});
  }
});

test('owned unexpired lock remaps while an expired foreign lock stays at its original path and expires',()=>{
  const {context,stage}=namespaceFixture();
  for(const patch of [{},{lockedByUserId:'another-user',lockedBySessionId:'another-session',expiresAt:50}]){
    const selected=structuredClone(stage);selected.beforeRows.locks=[lock(context,patch)];const after=expectedAfter(selected,context),receipt=namespaceReceipt(selected,context,after);
    decodeWorkspaceOperationOriginalMoveNamespaceReceipt(receipt.receiptText,context,receipt.state);
    assert.equal(after.rows.locks[0].path,'expiresAt'in patch?'a.pdf':'y.pdf');assert.equal(after.rows.locks[0].status,'expiresAt'in patch?'expired':'active');
  }
});

test('namespace before-image rejects duplicate rows, extra private fields and changed actor/request binding',()=>{
  const {context,stage}=namespaceFixture();
  for(const mutate of [(value:WorkspaceOperationOriginalMoveNamespaceStage)=>{value.beforeRows.metadata.push({...value.beforeRows.metadata[0]});},
    (value:WorkspaceOperationOriginalMoveNamespaceStage)=>{value.beforeRows.metadata[0].unknown='injected';}]){
    const poisoned=structuredClone(stage);mutate(poisoned);assert.throws(()=>decodeWorkspaceOperationOriginalMoveNamespaceStage(json(poisoned),context));
  }
  for(const patch of [{actor:{...stage.actor,userId:'other'}},{requestHash:hash('other')},{effectsProof:hash('other')}])
    assert.throws(()=>decodeWorkspaceOperationOriginalMoveNamespaceStage(json({...stage,...patch}),context));
});

type PublicInput=Parameters<typeof projectWorkspaceOperationNativeMoveExecution>[0];
type Observation=NonNullable<Parameters<typeof projectWorkspaceOperationNativeMoveExecution>[1]>;
function presentationFixture() {
  const plan=originalPlan(['y.pdf','b.pdf'],true);
  const input:PublicInput={plan,actionMode:'apply',status:'preview',completedActions:0,phase:'preparing'};
  const observation={apply:'complete',intent:{privateOnly:'private-intent-body'},completion:{planId:plan.planId,batchId:'batch',
    native:{operationId:'private-native-operation'},privateOnly:'private-receipt-body'},
    paths:plan.pathSteps.map((step,index)=>({stepKey:`path:${String(index).padStart(4,'0')}`,physical:{original:{sourcePath:step.sourcePath,
      destinationPath:step.destinationPath,privateOnly:'private-filesystem-identity'}}}))} as unknown as Observation;
  return {plan,input,observation};
}
function publicWhitelist(value:ReturnType<typeof projectWorkspaceOperationNativeMoveExecution>):void {
  assert.deepEqual(Object.keys(value).sort(),['finalization','mode','receiptStatus','steps']);
  const allowed=new Set(['key','phase','kind','path','destinationPath','reviewId','state','openPath']);
  for(const row of value.steps)for(const key of Object.keys(row))assert(allowed.has(key),key);
  const serialized=JSON.stringify(value);
  for(const privateField of ['sourceEvidence','nativePathPlan','nativeBundle','nativeBindings','compilerPlanProof','finalGraphProof','semanticProof','evidenceProof',
    'stateProof','stateVector','documentId','lineageId','inverseRecipes','originalProof','receiptDigest','mutationId','privateOnly'])assert(!serialized.includes(`"${privateField}"`),privateField);
  for(const token of ['private-document-id','private-lineage-id','private-intent-body','private-receipt-body','private-filesystem-identity','private-native-operation'])assert(!serialized.includes(token),token);
}

test('public native move presentation exposes only paths/counts/states while retaining two actual link rewrites',()=>{
  const {plan,input,observation}=presentationFixture(),effects=workspaceOperationNativeMoveEffects(plan);
  assert.equal(plan.nativePathPlan.mutations.length,2);assert.equal(effects.length,1);assert.equal(effects[0].updatedLinks,2);
  const output=projectWorkspaceOperationNativeMoveExecution(input,observation);publicWhitelist(output);
  assert.equal(output.finalization,'complete');assert.equal(output.receiptStatus,'available');assert.equal(output.steps.length,3);
  assert.equal(output.steps[2].openPath,'links.md');assert(output.steps.every(step=>step.state==='applied'));
  const internal=workspaceOperationNativeMoveExecutionResult(plan,observation)!;assert.equal(internal.totalActions,3);
  assert.equal(internal.stepResults?.find(step=>step.phase==='link')?.updatedLinks,2);
});

for(const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const)test(`V3 ${representation} dry-run exposes exact native target literals and counts without private evidence`,()=>{
  const plan=originalPlan(['y.pdf','b.pdf'],true,representation,'[[a.pdf|Original alias]] [Second](z.pdf)'),preview=workspacePathOperationPreview(plan);
  assert.ok('version' in preview);
  assert.equal(preview.version,3);assert.equal(preview.linkEdits.length,2);assert.equal(preview.linkEdits.length,plan.nativePathPlan.mutations.length);
  assert.deepEqual(Object.keys(preview).sort(),['version','kind','workspaceId','planId','readiness','pathMappings','linkEdits','coverage','linkAssessment','issues'].sort());
  for(const [index,recipe] of plan.nativePathPlan.mutations.entries()){
    const original=recipe.reference.kind==='link-mark'?recipe.reference.expected.href:recipe.reference.expected;
    assert.deepEqual(preview.linkEdits[index],{sourcePathBefore:recipe.source.path,sourcePathAfter:recipe.sourcePathAfter,
      previousTargetLiteral:original,nextTargetLiteral:recipe.nextValue});
  }
  for(const mapping of preview.pathMappings){
    assert(mapping.sourceIdentity.startsWith('native-preview:'));
    assert.deepEqual(Object.keys(mapping).sort(),['sourceWorkspaceId','sourcePath','destinationWorkspaceId','destinationPath','sourceIdentity','sourceKind'].sort());
  }
  const serialized=JSON.stringify(preview);
  for(const field of ['sourceEvidence','nativePathPlan','nativeBindings','privateNativeStates','stateProof','stateVector','binaryHash','vectorHash','filesystemIdentity',
    'documentId','lineageId','linkId','reference','startAnchor','endAnchor','membershipAnchor','targetRange','previewContents','inverseRecipes'])assert(!serialized.includes(`"${field}"`),field);
  for(const token of ['private-document-id','private-lineage-id',plan.sourceEvidence.evidenceProof,plan.sourceEvidence.semanticProof,
    ...plan.sourceEvidence.nativeBindings.flatMap(binding=>[binding.expected.binaryHash,binding.expected.vectorHash,binding.expected.stateProof])])assert(!serialized.includes(token),token);
});

test('partial, missing or inconsistent native evidence never becomes public completed work',()=>{
  const {input,observation}=presentationFixture();
  for(const selected of [null,{...observation,apply:'started'},{...observation,completion:null},
    {...observation,completion:{...observation.completion,planId:hash('other')}},{...observation,paths:observation.paths.slice(1)}] as Array<Observation|null>){
    const output=projectWorkspaceOperationNativeMoveExecution(input,selected);publicWhitelist(output);assert.equal(output.finalization,'pending');
    assert(output.steps.every(step=>step.state!=='applied'));assert(output.steps.every(step=>!step.openPath));
  }
  const stale=projectWorkspaceOperationNativeMoveExecution({...input,status:'applied',phase:'complete',completedActions:3},{...observation,apply:'absent'} as Observation);
  assert.equal(stale.receiptStatus,'unavailable');assert(stale.steps.every(step=>step.state==='needs_check'));
});

test('public projection keeps Undo unavailable and never manufactures restoration steps',()=>{
  const {plan,input,observation}=presentationFixture(),output=projectWorkspaceOperationNativeMoveExecution({...input,actionMode:'undo'},observation);
  publicWhitelist(output);assert.equal(output.receiptStatus,'unavailable');assert.equal(output.finalization,'pending');
  assert(output.steps.every(step=>step.kind!=='restore'&&step.state==='needs_check'));
  assert.throws(()=>workspaceOperationNativeMoveMutationEvidence(observation,true));
  assert.equal(workspaceOperationNativeMoveMutationEvidence(observation),'complete');
  const changed=structuredClone(plan);changed.nativePathPlan.mutations.push(changed.nativePathPlan.mutations[0]);
  assert.throws(()=>workspaceOperationNativeMoveEffects(changed));
});
