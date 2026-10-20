import 'server-only';

import { isDeepStrictEqual, types } from 'node:util';
import { openDb } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { captureWorkspaceOperationMcpJobPrincipal, type WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import { withPreparedWorkspacePathMove, withRecoveredWorkspacePathMoves, readPreparedWorkspacePathMove,
  movePreparedWorkspacePath, bindPreparedWorkspacePathMoveSharedParent } from '../filesystem/prepared-workspace-path-move';
import type { PreparedWorkspacePathMoveOriginal, PreparedWorkspacePathMoveReceipt } from '../filesystem/prepared-workspace-path-move-contract';
import { readWorkspaceOperationBatchClaimBinding, type WorkspaceOperationBatchClaim } from './workspace-operation-batch-store';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { workspaceOperationSourceNamespace } from './workspace-operation-mixed-source-evidence';
import { waitForWorkspaceOperationNativePathAdmission } from './workspace-operation-native-path-admission';
import { withWorkspaceOperationNativeMoveJobOwner, readWorkspaceOperationOriginalMoveJobHistory,
  readWorkspaceOperationOriginalMoveJobReceipts, readWorkspaceOperationOriginalMovePreparation, stageWorkspaceOperationOriginalMoveJob,
  recordWorkspaceOperationOriginalMoveJobParentReceipt, recordWorkspaceOperationOriginalMoveJobPathReceipt,
  completeWorkspaceOperationOriginalMoveJob } from './workspace-operation-job-lifecycle-owner';
import { decodeWorkspaceOperationOriginalMoveParentReceipt, decodeWorkspaceOperationOriginalMovePathReceipt,
  type WorkspaceOperationOriginalMoveCompletionData } from './workspace-operation-original-move';

/** The runner orchestrates fixed owner operations and actual descriptor scopes.
 * Neither a WorkspaceContext nor serialized plan/receipt data grant authority. */
export async function executeWorkspaceOperationOriginalMove(input: {
  claim: WorkspaceOperationBatchClaim; workspace: WorkspaceContext;
  onPathCommitted?: (completed: number) => Promise<void>;
  mcpPrincipal?: WorkspaceOperationMcpJobPrincipal;
}): Promise<WorkspaceOperationOriginalMoveCompletionData> {
  if (types.isProxy(input)) throw Object.assign(new Error('Original Move job scope changed.'), {code:'ORIGINAL_MOVE_SCOPE_CHANGED',status:409});
  const mcpField = Object.getOwnPropertyDescriptor(input, 'mcpPrincipal');
  if (mcpField && (!mcpField.enumerable || !Object.hasOwn(mcpField, 'value'))) {
    throw Object.assign(new Error('Original Move job scope changed.'), {code:'ORIGINAL_MOVE_SCOPE_CHANGED',status:409});
  }
  const mcpPrincipal = mcpField?.value === undefined ? undefined : captureWorkspaceOperationMcpJobPrincipal(mcpField.value);
  const claim = input.claim, workspace = input.workspace, onPathCommitted = input.onPathCommitted;
  const binding = readWorkspaceOperationBatchClaimBinding(claim), plan = binding.plan;
  if (plan.version !== 3 || binding.actionMode !== 'apply'
    || binding.authorization.mode !== 'direct' && binding.authorization.mode !== 'direct-mcp'
    || !isDeepStrictEqual(captureWorkspaceOperationJobScope(workspace), plan.sourceEvidence.workspaceScope)) {
    throw Object.assign(new Error('Original Move job scope changed.'), {code:'ORIGINAL_MOVE_SCOPE_CHANGED',status:409});
  }
  // A completed retry never requires a filesystem object to remain at the old
  // or new path. Current rights and exact historical SQL receipts are checked.
  const history = await readWorkspaceOperationOriginalMoveJobHistory(claim, openDb, mcpPrincipal);
  if (history?.completion) return history.completion;
  await waitForWorkspaceOperationNativePathAdmission(claim, openDb, mcpPrincipal);
  return withWorkspaceOperationNativeMoveJobOwner(claim, async owner => {
    let rows = await readWorkspaceOperationOriginalMoveJobReceipts(owner);
    if (rows.completion) return rows.completion;
    let originals: Array<{stepKey:string;original:PreparedWorkspacePathMoveOriginal}>;
    if (rows.intent) originals = rows.intent.steps.map(step=>({stepKey:step.stepKey,original:step.physical}));
    else {
      originals = [];
      const sourceEvidence = plan.planIdentityVersion === 2 || plan.planIdentityVersion === 3 || plan.planIdentityVersion === 4
        ? await readWorkspaceOperationOriginalMovePreparation(owner) : plan.sourceEvidence;
      for (const [index,selection] of plan.actions[0].selections.entries()) {
        const source = workspaceOperationSourceNamespace(sourceEvidence).find(entry=>entry.path===selection.sourcePath);
        if (!source || !selection.destinationPath) throw new Error('ORIGINAL_MOVE_SOURCE_CHANGED');
        await withPreparedWorkspacePathMove({workspace,sourcePath:selection.sourcePath,destinationPath:selection.destinationPath,
          sourceKind:source.filesystemIdentity===null ? 'projection_absent' : source.kind==='directory' ? 'directory':'regular_file'},async cap=>{
          originals.push({stepKey:`path:${String(index).padStart(4,'0')}`,original:readPreparedWorkspacePathMove(cap)});
        });
      }
    }
    const parents = rows.intent ? rows.parentRows.map(row=>{
      const parent=decodeWorkspaceOperationOriginalMoveParentReceipt(row,rows.intent!);
      return {producerStep:parent.producerStep,consumers:parent.consumers,receipt:parent.birth};
    }) : [];
    return withRecoveredWorkspacePathMoves({workspace,moves:originals,parents},async prepared=>{
      if (!rows.intent) rows = await stageWorkspaceOperationOriginalMoveJob(owner,{preparedSteps:prepared});
      const intent=rows.intent;
      if (!intent || !rows.intentRow) throw new Error('ORIGINAL_MOVE_INTENT_UNCONFIRMED');
      const receipts=new Map<string,PreparedWorkspacePathMoveReceipt>();
      // Physical producers run first, retaining the original selection/step IDs.
      // A native-only absence may depend on parent births from a later physical
      // selection. It creates nothing and is acknowledged after those producers.
      const order=[...prepared].sort((left,right)=>{
        const leftAbsent=intent.steps.find(step=>step.stepKey===left.stepKey)!.physical.source.kind==='projection_absent';
        const rightAbsent=intent.steps.find(step=>step.stepKey===right.stepKey)!.physical.source.kind==='projection_absent';
        return Number(leftAbsent)-Number(rightAbsent);
      });
      let completed=0;
      for (const step of order) {
        // A stored intent is no continuing permission for a physical effect.
        // Re-enter the fixed actual MCP owner phase immediately before each
        // move; revocation after that phase still follows original recovery.
        if (mcpPrincipal) await readWorkspaceOperationOriginalMoveJobReceipts(owner);
        const prior=rows.pathRows.find(row=>row.stepKey===step.stepKey);
        const births: Array<import('../filesystem/prepared-workspace-path-move-contract').PreparedWorkspacePathMoveParentReceipt> = [];
        const receipt=await movePreparedWorkspacePath(step.cap,async birth=>{
          await recordWorkspaceOperationOriginalMoveJobParentReceipt(owner,{stepKey:step.stepKey,cap:step.cap,birth});
          births.push(birth);
        });
        // The producer has now received its durable parent ACK and completed
        // its own move. Bind the very same birth, never a relabeled receipt.
        for (const birth of births) {
          const parent=intent.parents.find(parent=>parent.parentPath===birth.relativePath && parent.producerStep===step.stepKey);
          if(!parent)throw new Error('ORIGINAL_MOVE_PARENT_CHANGED');
          for(const consumer of parent.consumers)if(consumer.stepKey!==step.stepKey){
            const target=prepared.find(item=>item.stepKey===consumer.stepKey);if(!target)throw new Error('ORIGINAL_MOVE_PARENT_CHANGED');
            await bindPreparedWorkspacePathMoveSharedParent(target.cap,step.cap,birth);
          }
        }
        if(prior && !isDeepStrictEqual(decodeWorkspaceOperationOriginalMovePathReceipt(prior,intent,rows.parentRows).physical,receipt)) {
          throw new Error('ORIGINAL_MOVE_RECEIPT_CHANGED');
        }
        await recordWorkspaceOperationOriginalMoveJobPathReceipt(owner,{stepKey:step.stepKey,cap:step.cap,receipt});
        receipts.set(step.stepKey,receipt);completed++;
        await onPathCommitted?.(completed);
      }
      return completeWorkspaceOperationOriginalMoveJob(owner,{preparedSteps:prepared.map(step=>({stepKey:step.stepKey,cap:step.cap,receipt:receipts.get(step.stepKey)!}))});
    });
  }, undefined, mcpPrincipal);
}
