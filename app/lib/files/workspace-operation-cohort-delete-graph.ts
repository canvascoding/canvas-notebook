import 'server-only';
import { isDeepStrictEqual as equal } from 'node:util';
import { createHash } from 'node:crypto';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import type { WorkspaceDocumentCatalogueEntry } from '../collaboration/workspace-document-catalogue';
import type { NativeNamespaceEntry } from '../markdown/workspace-link-contract-v2';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { buildWorkspaceMixedHtmlLinkGraphV5, workspaceMixedHtmlBlockingCoverageV5 } from '../markdown/workspace-native-link-graph';
import { compileWorkspaceMixedHtmlBatchV5 } from '../markdown/workspace-native-mixed-batch-compiler';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationMixedSourceEvidenceV5, workspaceOperationMixedSourceSnapshotV5,
  captureWorkspaceOperationCohortDeleteAfterTrashObservation,
  type WorkspaceOperationCohortDeleteAfterTrashObservation, type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { decodeWorkspaceOperationNativeHtmlSourceEvidenceV4 } from './workspace-operation-native-source-evidence';
import type { PreparedWorkspacePathTrash, PreparedWorkspacePathTrashReceipt } from '../filesystem/prepared-workspace-path-trash';
import { decodeWorkspaceOperationCohortDeletePlan, cohortWithin, getWorkspaceOperationCohortDeleteRecipes,
  failCohortDelete, type WorkspaceOperationCohortDeletePlan } from './workspace-operation-cohort-delete-plan';
import type { CohortDeleteIntent, CohortDeleteResult } from './workspace-operation-cohort-delete-evidence';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const directoryIdentity=(entry:NativeNamespaceEntry)=>entry.filesystemIdentity===null?entry.identity:`directory:${entry.filesystemIdentity.split(':').slice(0,2).join(':')}`;
const normalizedNamespace=(entries:readonly NativeNamespaceEntry[])=>entries.map(entry=>entry.kind==='directory'
  ?{...entry,identity:directoryIdentity(entry),filesystemIdentity:null}:entry.documentId?{...entry,filesystemIdentity:null}:entry);
const entityKey=(entry:NativeNamespaceEntry)=>proof({workspaceId:entry.workspaceId,identity:entry.identity});
function rawFacts(evidence:Pick<WorkspaceOperationMixedSourceEvidenceV5,'physicalSources4'|'physicalHtmlSources4'>){
  return [...evidence.physicalSources4,...evidence.physicalHtmlSources4].map(source=>{
    const {authority,...body}=source;const {catalogueProof:_catalogue,...binding}=authority;
    if('links'in body){const {physicalSourceProof:_proof,links,...rest}=body;return {...rest,authority:binding,links:links.map(({physicalLinkId:_id,...link})=>link)};}
    const {htmlSourceProof:_proof,...rest}=body;return {...rest,authority:binding};});
}
export async function assertCohortDeleteAfterTrash(plan:WorkspaceOperationCohortDeletePlan,intent:CohortDeleteIntent,
  observation:WorkspaceLinkSourceAuthorityObservation,
  prepared:readonly Readonly<{stepKey:string;cap:PreparedWorkspacePathTrash;receipt:PreparedWorkspacePathTrashReceipt}>[]
):Promise<WorkspaceOperationCohortDeleteAfterTrashObservation>{
  const decoded=decodeWorkspaceOperationCohortDeletePlan(plan),witness=intent.currentWitness;
  const actual=await captureWorkspaceOperationCohortDeleteAfterTrashObservation({scope:intent.jobScope,observation,originalSourceEvidence:witness,prepared});
  const evidence=actual.actualEvidence,selected=(file:string)=>prepared.some(item=>cohortWithin(file,item.receipt.original.canonicalPath));
  const actualNative=decodeWorkspaceOperationNativeHtmlSourceEvidenceV4(evidence.nativeComponent);
  if(!equal(evidence.scope,witness.scope)||!equal(actualNative.nativeBindings,witness.nativeComponent.nativeBindings)
    ||actualNative.semanticCatalogueProof!==witness.nativeComponent.semanticCatalogueProof
    ||!equal(evidence.nativeOrdinarySources4,witness.nativeOrdinarySources4)
    ||!equal(actualNative.htmlSources,witness.nativeComponent.htmlSources)||!equal(rawFacts(evidence),rawFacts(witness)))return failCohortDelete('COHORT_DELETE_CHANGED');
  const expectedNamespace=witness.namespace.filter(entry=>!selected(entry.path)||entry.documentId!==null||entry.kind==='directory'
    &&witness.namespace.some(child=>child.documentId!==null&&child.path.startsWith(entry.path+'/')));
  // Ancestor directories whose inode was physically moved may remain inferred
  // solely by active native registry children until the atomic archive B2.
  const normalized=(entries:readonly NativeNamespaceEntry[])=>normalizedNamespace(entries).map(entry=>entry.kind==='directory'&&selected(entry.path)
    ?{...entry,identity:`selected-directory:${entry.path}`}:entry).sort((a,b)=>a.path.localeCompare(b.path));
  if(!equal(normalized(evidence.namespace),normalized(expectedNamespace)))return failCohortDelete('COHORT_DELETE_CHANGED');
  const additions=witness.namespace.filter(entry=>selected(entry.path)&&entry.kind==='file'&&entry.documentId===null)
    .filter(entry=>intent.targets.find(target=>target.path===entry.path)?.physicalRegistry?.catalogue)
    .map(entry=>({code:'missing-physical-source',path:entry.path}));
  if(!equal([...evidence.coverage.gaps].map(proof).sort(),[...witness.coverage.gaps,...additions].map(proof).sort()))return failCohortDelete('COHORT_DELETE_CHANGED');
  const compiled=compileWorkspaceMixedHtmlBatchV5({sourceEvidence:decoded.sourceEvidence,states:structuredClone(observation.privateNativeStates),
    requests:[{kind:'delete',sourceWorkspaceId:plan.workspaceId,destinationWorkspaceId:plan.workspaceId,selections:plan.actions[0].selections}]});
  if(!equal(compiled,decoded.nativeGraphPlan))return failCohortDelete('COHORT_DELETE_CHANGED');
  return actual;
}
export function assertCohortDeleteFinalGraph(plan:WorkspaceOperationCohortDeletePlan,intent:CohortDeleteIntent,
  observation:WorkspaceLinkSourceAuthorityObservation,receipts:CohortDeleteResult['nativeLinks'],beforeCatalogue:readonly Readonly<WorkspaceDocumentCatalogueEntry>[]):void{
  const decoded=decodeWorkspaceOperationCohortDeletePlan(plan),witness=intent.currentWitness,
    actual=captureWorkspaceOperationMixedSourceEvidenceV5(intent.jobScope,observation),recipes=getWorkspaceOperationCohortDeleteRecipes(decoded);
  const reject=()=>failCohortDelete('COHORT_DELETE_POSTCONDITION');
  const before=captureWorkspaceOperationNativeCatalogueWitness(beforeCatalogue,intent.jobScope,proof(beforeCatalogue),witness.nativeComponent.nativeBindings,reject);
  const after=captureWorkspaceOperationNativeCatalogueWitness(observation.privateCatalogue,intent.jobScope,actual.nativeComponent.stage.catalogueProof!,actual.nativeComponent.nativeBindings,reject);
  if(before.semanticCatalogueProof!==witness.nativeComponent.semanticCatalogueProof)return reject();
  const deletedPaths=new Set(intent.targets.map(target=>target.path));
  const normalize=(rows:typeof before.entries)=>rows.map(row=>row.authority==='initialized'?{...row,state_version:0}:row);
  if(!equal(normalize(before.entries.filter(entry=>!deletedPaths.has(entry.path))),normalize(after.entries)))return reject();
  const targets=new Set(intent.targets.filter(target=>target.native!==null).map(target=>target.native!.documentId));
  const survivors=witness.nativeComponent.nativeBindings.filter(binding=>!targets.has(binding.expected.documentId));
  if(actual.nativeComponent.nativeBindings.length!==survivors.length||actual.namespace.some(entry=>intent.roots.some(root=>cohortWithin(entry.path,root.physical.canonicalPath)))
    ||!equal(rawFacts(actual),rawFacts(witness)))return failCohortDelete('COHORT_DELETE_POSTCONDITION');
  for(const before of survivors){const id=before.expected.documentId,after=actual.nativeComponent.nativeBindings.find(binding=>binding.expected.documentId===id),receipt=receipts.find(item=>item.source.documentId===id);
    if(!receipt){if(!equal(after,before))return failCohortDelete('COHORT_DELETE_POSTCONDITION');continue;}
    const inventory=actual.nativeOrdinarySources4.find(item=>item.documentId===id)?.inventory;
    if(!after||!inventory||receipt.resultEvidenceVersion!==4||receipt.parserVersion!==4||receipt.after.documentSequence!==before.expected.documentSequence+1
      ||receipt.afterVectorHash!==sha(Buffer.from(receipt.after.stateVector,'base64'))
      ||receipt.after.stateProof!==`yjs-snapshot-sha256-v1:${sha(Buffer.from(receipt.afterStateSnapshotBase64,'base64'))}`
      ||!equal(after,{...before,expected:{...before.expected,stateProof:receipt.after.stateProof,documentSequence:receipt.after.documentSequence,persistedAt:receipt.after.persistedAt,
        binaryHash:receipt.afterBinaryHash,vectorHash:receipt.afterVectorHash},inventoryProof:proof(actual.nativeComponent.stage.sources.find(source=>source.inventory.document.documentId===id)!.inventory)}))return failCohortDelete('COHORT_DELETE_POSTCONDITION');
  }
  const html=(e:WorkspaceOperationMixedSourceEvidenceV5)=>e.nativeComponent.htmlSources.filter(source=>!targets.has(source.documentId)).map(source=>({documentId:source.documentId,path:source.path,
    occurrences:source.inspection.occurrences.map(({raw,fullyInspected,explicitLocalTargets})=>({raw,fullyInspected,explicitLocalTargets}))}));
  if(!equal(html(actual),html(witness)))return failCohortDelete('COHORT_DELETE_POSTCONDITION');
  const snapshot=workspaceOperationMixedSourceSnapshotV5(actual),graph=buildWorkspaceMixedHtmlLinkGraphV5(snapshot),expected=decoded.nativeGraphPlan;
  if(workspaceMixedHtmlBlockingCoverageV5(snapshot).length||graph.edges.length!==expected.finalEdges.length)return failCohortDelete('COHORT_DELETE_POSTCONDITION');
  const expectedNamespace=expected.finalNamespace.filter(entity=>entity.kind!=='directory'||entity.binding.kind!=='existing'||entity.binding.namespaceEvidence.filesystemIdentity!==null
    ||expected.finalNamespace.some(child=>child.path.startsWith(entity.path+'/')&&(child.kind!=='directory'||child.binding.kind!=='existing'||child.binding.namespaceEvidence.filesystemIdentity!==null)));
  if(actual.namespace.length!==expectedNamespace.length)return failCohortDelete('COHORT_DELETE_POSTCONDITION');
  for(const entity of expectedNamespace){const entry=actual.namespace.find(entry=>entry.path===entity.path),binding=entity.binding;
    if(!entry||binding.kind!=='existing'||entry.kind!==entity.kind||entry.workspaceId!==entity.workspaceId||entity.entityKey!==entityKey(binding.namespaceEvidence)
      ||entry.kind==='directory'&&directoryIdentity(entry)!==directoryIdentity(binding.namespaceEvidence)
      ||entry.documentId&&entry.identity!==binding.namespaceEvidence.identity||!entry.documentId&&entry.kind==='file'&&!equal(entry,binding.namespaceEvidence))return failCohortDelete('COHORT_DELETE_POSTCONDITION');
    const inventory=snapshot.documents.find(item=>item.document.documentId===entry.documentId),state=observation.privateNativeStates.find(state=>state.documentId===entry.documentId);
    if(entry.documentId){if(!inventory||!state||proof(authoritativeNativeCollaborationSnapshot(state).content)!==entity.contentBasisProof||!equal(inventory.metadata,entity.metadata))return failCohortDelete('COHORT_DELETE_POSTCONDITION');
      const before=witness.nativeOrdinarySources4.find(source=>source.documentId===entry.documentId)!.inventory,
        removed=new Set(recipes.filter(recipe=>recipe.source.documentId===entry.documentId).map(recipe=>recipe.linkId)),retained=before.links.filter(link=>!removed.has(link.id)),edges=graph.edges.filter(edge=>edge.sourceKind==='native'&&edge.source.documentId===entry.documentId);
      if(edges.length!==retained.length)return failCohortDelete();
      for(const[index,link]of retained.entries()){const edge=edges[index],desired=expected.finalEdges.find(item=>item.sourceEntityKey===entity.entityKey&&item.originEvidenceLinkId===link.id);
        if(!desired||desired.literal!==edge.literal||desired.targetPathText!==edge.targetPathText||!equal(desired.resolution,{status:edge.resolution.status,
          targetEntityKey:edge.resolution.target?entityKey(edge.resolution.target):null,candidateEntityKeys:edge.resolution.candidates.map(entityKey).sort()}))return failCohortDelete('COHORT_DELETE_POSTCONDITION');}
    }else {
      if(inventory||state||entity.contentBasisProof!==null)return failCohortDelete('COHORT_DELETE_POSTCONDITION');
      const physical=witness.physicalSources4.find(source=>source.path===entry.path);
      if(!physical){if(entity.physicalReadSource!==undefined||entity.metadata!==null)return failCohortDelete('COHORT_DELETE_POSTCONDITION');continue;}
      if(!equal(entity.physicalReadSource,{physicalSourceProof:physical.physicalSourceProof})||!equal(entity.metadata,physical.metadata))return failCohortDelete('COHORT_DELETE_POSTCONDITION');
      const edges=graph.edges.filter(edge=>edge.sourceKind==='physical-read'&&edge.source.path===entry.path);
      if(edges.length!==physical.links.length)return failCohortDelete('COHORT_DELETE_POSTCONDITION');
      for(const[index,link]of physical.links.entries()){const edge=edges[index],desired=expected.finalEdges.find(item=>item.sourceEntityKey===entity.entityKey&&item.originEvidenceLinkId===link.physicalLinkId&&item.physicalReadSource===true);
        if(!desired||desired.literal!==edge.literal||desired.targetPathText!==edge.targetPathText||!equal(desired.resolution,{status:edge.resolution.status,targetEntityKey:edge.resolution.target?entityKey(edge.resolution.target):null,candidateEntityKeys:edge.resolution.candidates.map(entityKey).sort()}))return failCohortDelete('COHORT_DELETE_POSTCONDITION');}
    }
  }
}
