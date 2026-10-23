import 'server-only';
import { randomUUID } from 'node:crypto';
import { openDb } from '../db';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import type { WorkspaceContext } from '../workspaces/types';
import { withPreparedWorkspacePathTrashes, withRecoveredWorkspacePathTrashes, readPreparedWorkspacePathTrashDisposition,
  readPreparedWorkspacePathTrashReceipt, trashPreparedWorkspacePath, assertPreparedWorkspacePathTrashCurrent } from '../filesystem/prepared-workspace-path-trash';
import type { WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import { readWorkspaceOperationBatchClaimBinding, type WorkspaceOperationBatchClaim } from './workspace-operation-batch-store';
import { withWorkspaceOperationJobLifecycleOwner, withWorkspaceOperationJobLifecycleTransaction,
  readWorkspaceOperationCohortDeleteJobHistory, completeWorkspaceOperationCohortDeleteJob,
  prepareWorkspaceOperationCohortDeleteJob, assertWorkspaceOperationCohortDeletePendingJob,
  readWorkspaceOperationCohortDeleteObservationJob } from './workspace-operation-job-lifecycle-owner';
import { waitForWorkspaceOperationNativePathAdmission } from './workspace-operation-native-path-admission';
import { decodeWorkspaceOperationCohortDeletePlan, captureWorkspaceOperationCohortDeleteCurrent, failCohortDelete } from './workspace-operation-cohort-delete-plan';
import type { CohortDeleteResult } from './workspace-operation-cohort-delete-evidence';
import type { CohortDeletePrepared, CohortDeletePhysical } from './workspace-operation-cohort-delete-domain';

/** One original cohort and one genuine Owner. No legacy FS fallback or child
 * Delete jobs; partial FS progress always retains this exact B1. */
export async function executeWorkspaceOperationCohortDelete(input:Readonly<{claim:WorkspaceOperationBatchClaim;workspace:WorkspaceContext;
  mcpPrincipal?:WorkspaceOperationMcpJobPrincipal}>):Promise<CohortDeleteResult>{
  const binding=readWorkspaceOperationBatchClaimBinding(input.claim);
  if(binding.plan.version!==6||binding.actionMode!=='apply')return failCohortDelete();
  const plan=decodeWorkspaceOperationCohortDeletePlan(binding.plan),dataRoot=resolveWorkspaceDataRoot();
  const history=await readWorkspaceOperationCohortDeleteJobHistory(input.claim,openDb,input.mcpPrincipal);
  if(history)return history;
  await waitForWorkspaceOperationNativePathAdmission(input.claim,openDb,input.mcpPrincipal);
  return withWorkspaceOperationJobLifecycleOwner(input.claim,async owner=>{
    const observed=await readWorkspaceOperationCohortDeleteObservationJob(owner);
    if(observed.result)return observed.result;
    const apply=async(prepared:readonly CohortDeletePrepared[]):Promise<CohortDeleteResult>=>{
      let intent=observed.intent,durable=observed.durable;
      if(!intent||!durable){const captured=await prepareWorkspaceOperationCohortDeleteJob(owner,{prepared});intent=captured.intent;durable=captured.durable;}
      const originalRow=durable,physical=new Map<string,CohortDeletePhysical>();
      // Read-only same-cap proofs of already-moved/absent originals. Recovery
      // does not attempt the rename again and does not adopt current D2 bytes.
      for(const item of prepared)if(readPreparedWorkspacePathTrashDisposition(item.cap)!=='pending'){
        const receipt=await readPreparedWorkspacePathTrashReceipt(item.cap);physical.set(item.stepKey,{...item,receipt});}
      const verify=()=>assertWorkspaceOperationCohortDeletePendingJob(owner,
        {expectedIntentDigest:originalRow.intentDigest,originalDurable:originalRow,prepared,physical:[...physical.values()]});
      // Original evidence and current rights are revalidated before EVERY
      // remaining physical effect, including a genuine SID_B recovery.
      for(const item of prepared){await verify();if(physical.has(item.stepKey))continue;
        await assertPreparedWorkspacePathTrashCurrent(item.cap);const receipt=await trashPreparedWorkspacePath(item.cap);physical.set(item.stepKey,{...item,receipt});}
      await verify();
      return completeWorkspaceOperationCohortDeleteJob(owner,{expectedIntentDigest:originalRow.intentDigest,prepared:prepared.map(item=>physical.get(item.stepKey)??failCohortDelete())});
    };
    if(observed.intent)return withRecoveredWorkspacePathTrashes({workspace:input.workspace,dataRoot,originals:observed.intent.roots.map(root=>({stepKey:root.stepKey,original:root.physical}))},apply);
    const current=await withWorkspaceOperationJobLifecycleTransaction(owner,async access=>captureWorkspaceOperationCohortDeleteCurrent(plan,await access.readOriginalNativeDeleteSources(),plan.sourceEvidence.workspaceScope));
    return withPreparedWorkspacePathTrashes({workspace:input.workspace,dataRoot,selections:plan.pathSteps.map((step,index)=>{
      const target=current.namespace.find(target=>target.path===step.sourcePath);if(!target)return failCohortDelete();
      return {stepKey:`path:${String(index).padStart(4,'0')}`,canonicalPath:step.sourcePath,trashEntryId:`trash-${randomUUID()}`,
        sourceKind:target.filesystemIdentity===null?'projection_absent' as const:target.kind==='directory'?'directory' as const:'regular_file' as const};})},apply);
  },openDb,input.mcpPrincipal);
}
