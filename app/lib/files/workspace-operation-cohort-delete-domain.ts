import 'server-only';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import type { WorkspaceContext } from '../workspaces/types';
import type { SqlConnection } from '../db';
import { prepareNativeFileArchiveTransition } from '../collaboration/native-file-archive-transition';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import { readPreparedWorkspacePathTrash, assertPreparedWorkspacePathTrashCurrent, assertPreparedWorkspacePathTrashSourceVacant,
  type PreparedWorkspacePathTrash, type PreparedWorkspacePathTrashReceipt } from '../filesystem/prepared-workspace-path-trash';
import type { WorkspaceOperationJobLifecycleAccess } from './workspace-operation-job-lifecycle-owner';
import type { WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';
import { readWorkspaceOperationOriginalDeleteIntentOnConnection, readWorkspaceOperationOriginalDeleteReceiptOnConnection,
  readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection, insertWorkspaceOperationOriginalDeleteTrashReceiptOnConnection,
  insertWorkspaceOperationOriginalDeleteReceiptOnConnection, type WorkspaceOperationOriginalDeleteIntent } from './workspace-operation-original-delete-repository';
import { assertNoCompetingWriter } from './workspace-operation-original-delete-domain';
import { captureOriginalDeletePublicShareOnConnection, assertOriginalDeletePublicShareOnConnection, applyOriginalDeletePublicShareOnConnection } from './workspace-operation-original-delete-public';
import { readOriginalPhysicalDeleteRegistryOnConnectionV1, assertOriginalPhysicalDeleteRegistryCurrentOnConnectionV1,
  archiveOriginalPhysicalDeleteRegistryOnConnectionV1 } from './workspace-operation-original-physical-delete-registry-v5';
import { prepareOriginalDeleteNativeHtmlLinksV4, assertOriginalDeleteNativeHtmlLinkCompletionBudgetV4, assertOriginalDeleteNativeHtmlLinkReceiptsV4 } from './workspace-operation-original-delete-html-links';
import { captureWorkspaceOperationCohortDeleteCurrent, getWorkspaceOperationCohortDeleteRecipes, cohortWithin,
  freezeCohortDelete, failCohortDelete } from './workspace-operation-cohort-delete-plan';
import { cohortDeleteActor, cohortDeleteLinkContext, parseCohortDeleteIntent, assertCohortDeleteIntentPlan, completeCohortDeleteEvidence,
  type CohortDeleteIntent, type CohortDeleteRoot, type CohortDeleteTarget, type CohortDeleteCompletion, type CohortDeleteResult } from './workspace-operation-cohort-delete-evidence';
import { readCohortDeleteAdmissionOnConnection } from './workspace-operation-cohort-delete-admission';
import { assertCohortDeleteAfterTrash, assertCohortDeleteFinalGraph } from './workspace-operation-cohort-delete-graph';

export type CohortDeletePrepared=Readonly<{stepKey:string;cap:PreparedWorkspacePathTrash}>;
export type CohortDeletePhysical=Readonly<CohortDeletePrepared&{receipt:PreparedWorkspacePathTrashReceipt}>;
const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
export async function prepareCohortDeleteIntent(access:WorkspaceOperationJobLifecycleAccess,binding:WorkspaceOperationBatchClaimBinding,
  prepared:readonly CohortDeletePrepared[]):Promise<CohortDeleteIntent>{
  if(binding.plan.version!==6||binding.actionMode!=='apply'||binding.authorization.mode!=='direct'&&binding.authorization.mode!=='direct-mcp')return failCohortDelete();
  const plan=binding.plan,auth=binding.authorization,schema=binding.source.schemaName,prefix=quote(schema);
  await access.assertCurrent();
  const observation=await access.readOriginalNativeDeleteSources(),currentWitness=captureWorkspaceOperationCohortDeleteCurrent(plan,observation,auth.jobScope!);
  const roots:CohortDeleteRoot[]=prepared.map(item=>({stepKey:item.stepKey,physical:readPreparedWorkspacePathTrash(item.cap)}));
  const targets:CohortDeleteTarget[]=[],transitions:unknown[]=[];
  for(const target of plan.targets.filter(target=>target.kind==='file')){
    await access.assertCurrent();await assertNoCompetingWriter(access,prefix,target.path);
    const root=roots.find(root=>cohortWithin(target.path,root.physical.canonicalPath));if(!root)return failCohortDelete();
    const native=currentWitness.nativeComponent.nativeBindings.find(binding=>binding.expected.path===target.path)?.expected??null;
    const physicalRegistry=native?null:await readOriginalPhysicalDeleteRegistryOnConnectionV1(access.database,
      {schema,workspace:access.workspace,workspaceScope:auth.jobScope!,sourcePath:target.path,catalogue:observation.privateCatalogue});
    if(native){const state=observation.privateNativeStates.find(state=>state.documentId===native.documentId);if(!state)return failCohortDelete();
      transitions.push(prepareNativeFileArchiveTransition(state,native,{trashEntryId:root.physical.trashEntryId,archivedAt:root.physical.deletedAtMs}));}
    const publicShare=await captureOriginalDeletePublicShareOnConnection(access.database,{schema,workspace:access.workspace,path:target.path,...(native?{nativeExpected:native}:{})});
    targets.push({path:target.path,rootStep:root.stepKey,native,physicalRegistry,publicShare});
  }
  const nativeLinks=prepareOriginalDeleteNativeHtmlLinksV4(getWorkspaceOperationCohortDeleteRecipes(plan),observation,cohortDeleteLinkContext(binding));
  for(const link of nativeLinks)await assertNoCompetingWriter(access,prefix,link.prepared.source.path);
  const intent:CohortDeleteIntent={version:1,kind:'cohort-delete-original',batchId:binding.batchId,planId:binding.planId,requestHash:auth.requestHash,
    actor:cohortDeleteActor(binding),jobScope:auth.jobScope!,currentWitness,roots,targets,nativeLinks,admission:await access.readOriginalNativeDeleteAdmission()};
  assertCohortDeleteIntentPlan(intent,plan,resolveWorkspaceDataRoot());
  if(Buffer.byteLength(JSON.stringify(intent))>1048576)return failCohortDelete('COHORT_DELETE_TOO_LARGE');
  // Exact known archive transitions plus conservative bounds for immutable
  // physical/registry/share receipts. Every limit is checked before any rename.
  const envelope=Buffer.byteLength(JSON.stringify({version:1,kind:'cohort-delete-completion',batchId:binding.batchId,intentDigest:'0'.repeat(64),
    trashReceiptDigest:'0'.repeat(64),physical:roots,targets:transitions,nativeLinks:[]}))
    +2*Buffer.byteLength(JSON.stringify(roots))+roots.length*256
    +targets.reduce((bytes,target)=>bytes+32768+8192+(target.physicalRegistry?2*Buffer.byteLength(JSON.stringify(target.physicalRegistry))+4096:0),0);
  assertOriginalDeleteNativeHtmlLinkCompletionBudgetV4(nativeLinks,observation,envelope);
  await access.assertCurrent();return freezeCohortDelete(intent);
}
export async function readCohortDeleteObservationOnConnection(database:SqlConnection,input:Readonly<{schema:string;
  binding:import('./workspace-operation-cohort-delete-evidence').CohortDeleteEvidenceBinding;workspace:WorkspaceContext;dataRoot:string}>){
  const {schema,binding,workspace,dataRoot}=input,selected={schema,batchId:binding.batchId};
  const durable=await readWorkspaceOperationOriginalDeleteIntentOnConnection(database,selected),receipt=await readWorkspaceOperationOriginalDeleteReceiptOnConnection(database,selected),trash=await readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(database,selected);
  if(!durable){if(receipt||trash)return failCohortDelete('COHORT_DELETE_UNPROVEN');return freezeCohortDelete({apply:'absent' as const,durable:null,intent:null,result:null});}
  const intent=parseCohortDeleteIntent(durable,binding,workspace,dataRoot);
  if(!receipt){if(trash)return failCohortDelete('COHORT_DELETE_UNPROVEN');await readCohortDeleteAdmissionOnConnection(database,{schema,binding,intent});
    return freezeCohortDelete({apply:'started' as const,durable,intent,result:null});}
  const result=completeCohortDeleteEvidence(receipt,trash,durable,intent);
  await readCohortDeleteAdmissionOnConnection(database,{schema,binding,intent,result});
  return freezeCohortDelete({apply:'complete' as const,durable,intent,result});
}
export type CohortDeleteObservation=Awaited<ReturnType<typeof readCohortDeleteObservationOnConnection>>;
export async function assertCohortDeletePending(access:WorkspaceOperationJobLifecycleAccess,binding:WorkspaceOperationBatchClaimBinding,
  intent:CohortDeleteIntent,prepared:readonly CohortDeletePrepared[],physical?:readonly CohortDeletePhysical[]):Promise<void>{
  if(binding.plan.version!==6)return failCohortDelete();
  const prefix=quote(binding.source.schemaName);
  const observation=await access.readOriginalNativeDeleteSources();
  for(const target of intent.targets){await assertNoCompetingWriter(access,prefix,target.path);const root=intent.roots.find(root=>root.stepKey===target.rootStep)!;
    await assertOriginalDeletePublicShareOnConnection(access.database,{schema:binding.source.schemaName,workspace:access.workspace,original:target.publicShare,nowMs:root.physical.deletedAtMs});
    if(target.physicalRegistry)await assertOriginalPhysicalDeleteRegistryCurrentOnConnectionV1(access.database,{schema:binding.source.schemaName,workspace:access.workspace,
      workspaceScope:intent.jobScope,sourcePath:target.path,catalogue:observation.privateCatalogue},target.physicalRegistry);}
  if(physical?.length)await assertCohortDeleteAfterTrash(binding.plan,intent,observation,physical);
  else captureWorkspaceOperationCohortDeleteCurrent(binding.plan,observation,intent.jobScope);
  for(const item of prepared)await assertPreparedWorkspacePathTrashCurrent(item.cap);
  await access.assertCurrent();
}
function trashMetadata(intent:CohortDeleteIntent,root:CohortDeleteRoot,digest:string){return JSON.stringify({version:1,retentionDays:root.physical.retentionDays,
  workspaceType:intent.jobScope.workspaceType,requestedPath:root.physical.canonicalPath,originalDeleteIntent:digest,payloadKind:'cohort',cohortBatchId:intent.batchId,rootStep:root.stepKey});}
async function insertCohortTrash(access:WorkspaceOperationJobLifecycleAccess,binding:WorkspaceOperationBatchClaimBinding,intent:CohortDeleteIntent,digest:string){
  if(binding.plan.version!==6)return failCohortDelete();const prefix=quote(binding.source.schemaName),scope=intent.jobScope;
  for(const root of intent.roots){const physical=root.physical,entries=binding.plan.targets.filter(target=>cohortWithin(target.path,physical.canonicalPath));
    const itemType=entries.find(entry=>entry.path===physical.canonicalPath)!.kind,size=physical.source.kind==='regular_file'?Number(physical.source.identity.size)
      :physical.source.kind==='directory'?physical.source.entries.reduce((size,entry)=>size+(entry.kind==='regular_file'?Number(entry.identity.size):0),0):0;
    const files=entries.filter(entry=>entry.kind==='file').length,directories=entries.filter(entry=>entry.kind==='directory').length,metadata=trashMetadata(intent,root,digest);
    const values=[physical.trashEntryId,scope.organizationId,scope.customerId,scope.projectId,scope.workspaceId,scope.workspaceType,scope.ownerUserId,
      physical.canonicalPath,physical.trashRelativePath,path.posix.basename(physical.canonicalPath),itemType,size,files,directories,intent.actor.userId,physical.deletedAtMs,physical.expiresAtMs,metadata];
    const row=await access.database.get(`INSERT INTO ${prefix}.workspace_trash_entries
      (id,organization_id,customer_id,project_id,workspace_id,workspace_type,owner_user_id,original_path,trash_relative_path,entry_name,item_type,size_bytes,file_count,directory_count,status,deleted_by_user_id,deleted_at,expires_at,metadata_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'trashed',$15,$16,$17,$18) ON CONFLICT(id) DO NOTHING RETURNING *`,values) as Record<string,unknown>|undefined;
    if(!row||row.id!==physical.trashEntryId||row.organization_id!==scope.organizationId||row.customer_id!==scope.customerId
      ||row.project_id!==scope.projectId||row.workspace_id!==scope.workspaceId||row.workspace_type!==scope.workspaceType||row.owner_user_id!==scope.ownerUserId
      ||row.entry_name!==path.posix.basename(physical.canonicalPath)||row.restored_at!==null||row.restored_by_user_id!==null||row.purged_at!==null||row.purged_by_user_id!==null||row.original_path!==physical.canonicalPath||row.trash_relative_path!==physical.trashRelativePath
      ||row.item_type!==itemType||Number(row.size_bytes)!==size||Number(row.file_count)!==files||Number(row.directory_count)!==directories||row.status!=='trashed'
      ||row.metadata_json!==metadata||row.deleted_by_user_id!==intent.actor.userId||Number(row.deleted_at)!==physical.deletedAtMs||Number(row.expires_at)!==physical.expiresAtMs)return failCohortDelete('COHORT_DELETE_POSTCONDITION');}
}
export async function completeCohortDeleteDomain(access:WorkspaceOperationJobLifecycleAccess,input:Readonly<{binding:WorkspaceOperationBatchClaimBinding;
  durable:WorkspaceOperationOriginalDeleteIntent;intent:CohortDeleteIntent;prepared:readonly CohortDeletePhysical[]}>):Promise<CohortDeleteResult>{
  type CohortDeleteDomainTimingStage = 'enter' | 'before-durable' | 'durable-checked' | 'before-intent-parse' | 'intent-parsed' | 'before-pending' | 'pending-checked' | 'before-second-source-read' | 'second-source-read' | 'after-trash-checked' | 'before-links' | 'links-applied' | 'before-archive' | 'archive-returned' | 'before-target-loop' | 'targets-applied' | 'before-third-source-read' | 'third-source-read' | 'before-final-graph' | 'final-graph-checked' | 'writers-checked' | 'before-metadata' | 'metadata-removed' | 'pre-trash-caps-checked' | 'trash-inserted' | 'before-trash-receipt' | 'trash-receipt-written' | 'completion-prepared' | 'before-completion-receipt' | 'completion-receipt-written' | 'before-final-checks' | 'final-checks-done' | 'before-result-validation';
  let cohortDeleteDomainStartedAt = 0, cohortDeleteDomainLastStage: CohortDeleteDomainTimingStage = 'enter';
  const cohortDeleteDomainMilestones: { stage: CohortDeleteDomainTimingStage; elapsedMs: number }[] = [];
  const markCohortDeleteDomain = (stage: CohortDeleteDomainTimingStage) => {
    try {
      cohortDeleteDomainLastStage = stage;
      const now = performance.now();
      if (stage === 'enter') cohortDeleteDomainStartedAt = now;
      cohortDeleteDomainMilestones.push({ stage, elapsedMs: Math.round(now - cohortDeleteDomainStartedAt) });
    } catch { /* Timing diagnostics never replace the original operation result. */ }
  };
  try {
    markCohortDeleteDomain('enter');
    const {binding,durable,intent,prepared}=input;if(binding.plan.version!==6)return failCohortDelete();
    const schema=binding.source.schemaName,prefix=quote(schema),selected={schema,batchId:binding.batchId};
    markCohortDeleteDomain('before-durable');
    const current=await readWorkspaceOperationOriginalDeleteIntentOnConnection(access.database,{...selected,forShare:true});
    if(!current||!equal(current,durable)||await readWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database,{...selected,forShare:true}))return failCohortDelete('COHORT_DELETE_CHANGED');
    markCohortDeleteDomain('durable-checked');
    markCohortDeleteDomain('before-intent-parse');
    parseCohortDeleteIntent(current,binding,access.workspace,resolveWorkspaceDataRoot());
    markCohortDeleteDomain('intent-parsed');
    markCohortDeleteDomain('before-pending');
    await assertCohortDeletePending(access,binding,intent,prepared,prepared);
    markCohortDeleteDomain('pending-checked');
    markCohortDeleteDomain('before-second-source-read');
    const before=await access.readOriginalNativeDeleteSources();
    markCohortDeleteDomain('second-source-read');
    await assertCohortDeleteAfterTrash(binding.plan,intent,before,prepared);
    markCohortDeleteDomain('after-trash-checked');
    markCohortDeleteDomain('before-links');
    const nativeLinks=intent.nativeLinks.length?await access.applyOriginalNativeDeleteLinks(current.intentDigest):[];
    assertOriginalDeleteNativeHtmlLinkReceiptsV4(nativeLinks,intent.nativeLinks);
    markCohortDeleteDomain('links-applied');
    if(!access.archiveOriginalNativeCohortDeleteTargets)return failCohortDelete('COHORT_DELETE_UNPROVEN');
    markCohortDeleteDomain('before-archive');
    const native=await access.archiveOriginalNativeCohortDeleteTargets(current.intentDigest);
    markCohortDeleteDomain('archive-returned');
    const targets:CohortDeleteCompletion['targets'][number][]=[];
    markCohortDeleteDomain('before-target-loop');
    for(const target of intent.targets){await access.assertCurrent();const root=intent.roots.find(root=>root.stepKey===target.rootStep)!;
      const physicalRegistry=target.physicalRegistry?await archiveOriginalPhysicalDeleteRegistryOnConnectionV1(access.database,{schema,workspace:access.workspace,
        workspaceScope:intent.jobScope,sourcePath:target.path,catalogue:before.privateCatalogue,expected:target.physicalRegistry,trashEntryId:root.physical.trashEntryId,archivedAt:root.physical.deletedAtMs}):null;
      const publicShare=await applyOriginalDeletePublicShareOnConnection(access.database,{schema,workspace:access.workspace,original:target.publicShare,nowMs:root.physical.deletedAtMs});
      const archive=native.find(item=>item.path===target.path)?.transition??null;
      if(Boolean(archive)!==Boolean(target.native))return failCohortDelete('COHORT_DELETE_POSTCONDITION');targets.push({path:target.path,rootStep:target.rootStep,native:archive,physicalRegistry,publicShare});}
    markCohortDeleteDomain('targets-applied');
    markCohortDeleteDomain('before-third-source-read');
    const finalObservation=await access.readOriginalNativeDeleteSources();
    markCohortDeleteDomain('third-source-read');
    markCohortDeleteDomain('before-final-graph');
    assertCohortDeleteFinalGraph(binding.plan,intent,finalObservation,nativeLinks,before.privateCatalogue??[]);
    markCohortDeleteDomain('final-graph-checked');
    for(const target of binding.plan.targets)await assertNoCompetingWriter(access,prefix,target.path);
    markCohortDeleteDomain('writers-checked');
    markCohortDeleteDomain('before-metadata');
    const annotationPaths=binding.plan.targets.map(target=>target.path);
    await access.database.run(`DELETE FROM ${prefix}.workspace_file_metadata WHERE workspace_id=$1 AND path=ANY($2::text[])`,[binding.workspaceId,annotationPaths]);
    await access.database.run(`DELETE FROM ${prefix}.workspace_file_user_states WHERE workspace_id=$1 AND path=ANY($2::text[])`,[binding.workspaceId,annotationPaths]);
    markCohortDeleteDomain('metadata-removed');
    for(const item of prepared){await assertPreparedWorkspacePathTrashCurrent(item.cap);await assertPreparedWorkspacePathTrashSourceVacant(item.cap);}
    markCohortDeleteDomain('pre-trash-caps-checked');
    await insertCohortTrash(access,binding,intent,current.intentDigest);
    markCohortDeleteDomain('trash-inserted');
    const physical=prepared.map(({stepKey,receipt})=>({stepKey,receipt}));
    markCohortDeleteDomain('before-trash-receipt');
    const trash=await insertWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(access.database,{...selected,intentDigest:current.intentDigest,receiptText:JSON.stringify(physical)});
    if(trash.kind!=='created')return failCohortDelete('COHORT_DELETE_UNPROVEN');
    markCohortDeleteDomain('trash-receipt-written');
    const completion:CohortDeleteCompletion=freezeCohortDelete({version:1,kind:'cohort-delete-completion',batchId:binding.batchId,intentDigest:current.intentDigest,
      physical,targets,nativeLinks,trashReceiptDigest:trash.row.receiptDigest});
    markCohortDeleteDomain('completion-prepared');
    markCohortDeleteDomain('before-completion-receipt');
    const receipt=await insertWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database,{...selected,intentDigest:current.intentDigest,receiptText:JSON.stringify(completion)});
    if(receipt.kind!=='created')return failCohortDelete('COHORT_DELETE_UNPROVEN');
    markCohortDeleteDomain('completion-receipt-written');
    markCohortDeleteDomain('before-final-checks');
    for(const item of prepared){await assertPreparedWorkspacePathTrashCurrent(item.cap);await assertPreparedWorkspacePathTrashSourceVacant(item.cap);}
    await access.assertCurrent();
    markCohortDeleteDomain('final-checks-done');
    markCohortDeleteDomain('before-result-validation');
    return completeCohortDeleteEvidence(receipt.row,trash.row,current,intent);
  } finally {
    try { console.info('[File action owner] Cohort Delete B2 domain timings.', JSON.stringify({ version: 1,
      elapsedMs: Math.round(performance.now() - cohortDeleteDomainStartedAt), lastStage: cohortDeleteDomainLastStage,
      milestones: cohortDeleteDomainMilestones })); }
    catch { /* Timing diagnostics never replace the original operation result. */ }
  }
}
