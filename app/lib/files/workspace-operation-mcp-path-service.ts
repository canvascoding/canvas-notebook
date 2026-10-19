import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { openDb } from '../db';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { invalidateWorkspaceFileViews } from '../api/route-helpers';
import { withDirectMcpWorkspaceMovePrincipal, withDirectMcpWorkspaceDeletePrincipal,
  withDirectMcpWorkspaceMovePrincipalOnConnection, withDirectMcpWorkspaceDeletePrincipalOnConnection,
  type DirectMcpWorkspaceMovePrincipalAccess, type DirectMcpWorkspaceDeletePrincipalAccess } from '../mcp/server/document-read-principal';
import { encodeDirectMcpWorkspacePathResultV1, WorkspacePathToolError,
  type DecodedDirectMcpWorkspaceMoveRequestV1, type DecodedDirectMcpWorkspaceDeleteRequestV1,
  type DirectMcpWorkspacePathResultV1 } from '../mcp/server/workspace-path-tool-contract';
import { captureWorkspaceOperationMcpJobPrincipal,
  type WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import type { WorkspaceContext } from '../workspaces/types';
import { buildWorkspacePathOperationPlan } from './workspace-path-operation-service';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { workspaceOperationMcpBatchId } from './workspace-operation-mcp-authorization';
import { WorkspaceOperationBatchStore, type WorkspaceOperationBatchRecord,
  type WorkspaceOperationMcpClaimResult } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope, WorkspaceOperationBatchExecutionResult,
  WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';
import type { WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import { readWorkspaceOperationNativeMoveBatchStatus,
  type WorkspaceOperationNativeMoveBatchStatus } from './workspace-operation-native-move-status';
import { readWorkspaceOperationNativeDeleteBatchStatus,
  type WorkspaceOperationNativeDeleteBatchStatus } from './workspace-operation-native-delete-status';
import { executeWorkspaceOperationBatch } from './workspace-operation-batch-executor';
import { projectWorkspaceOperationNativeMoveExecution, workspaceOperationNativeMoveExecutionResult,
  workspaceOperationNativeMoveEffects } from './workspace-operation-native-move-execution-public';
import { projectWorkspaceOperationNativeDeleteExecution,
  workspaceOperationNativeDeleteExecutionResult } from './workspace-operation-batch-execution-public';
import { workspaceOperationNativeDeleteEffects } from './workspace-operation-native-delete-effects';
import { projectWorkspaceOperationBatchFileViews } from './workspace-operation-batch-worker';
import { withWorkspaceOperationJobClaimScheduling } from './workspace-operation-job-phase-scheduling';
import { createWorkspaceOperationClaimRenewals } from './workspace-operation-claim-renewals';
import { workspaceOperationBatchErrorCode } from './workspace-operation-batch-failure';

type Request = DecodedDirectMcpWorkspaceMoveRequestV1 | DecodedDirectMcpWorkspaceDeleteRequestV1;
type NativePlan = WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationNativeDeleteBatchPlan;
type SelectedRequest = Exclude<Request, { action: 'status' }>;
type Authority = Readonly<{ userId: string; clientId: string; sessionId: string;
  tool: 'move_knowledge_source' | 'delete_knowledge_source'; scope: WorkspaceOperationBatchScope }>;
type NativeStatus = Readonly<{ kind: 'move'; value: WorkspaceOperationNativeMoveBatchStatus }>
  | Readonly<{ kind: 'delete'; value: WorkspaceOperationNativeDeleteBatchStatus }>;

/** Fixed current-principal phase only. No caller callback, arbitrary authority
 * DTO, journal claim, physical mutation or status read runs inside this B.
 * The Core pins the actual runtime/schema realm across every phase. */
async function capturePathAuthority(live: WorkspaceOperationMcpJobPrincipal,
  operationId?: string, initial?: Authority): Promise<Authority> {
  return executeLifecycleTransaction({ openConnection: openDb,
    execute: async database => {
      await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
      const inspect = async (access: DirectMcpWorkspaceMovePrincipalAccess | DirectMcpWorkspaceDeletePrincipalAccess): Promise<Authority> => {
        const workspace: WorkspaceContext = Object.freeze({ ...access.workspace,
          permissions: Object.freeze({ ...access.workspace.permissions }),
          ...(access.workspace.actor ? { actor: Object.freeze({ ...access.workspace.actor }) } : {}) });
        const value: Authority = Object.freeze({ userId: access.userId, clientId: access.clientId,
          sessionId: access.sessionId, tool: access.tool,
          scope: Object.freeze({ workspace, fileOptions: Object.freeze({ workspace }) }) });
        if (initial && (value.userId !== initial.userId || value.clientId !== initial.clientId
          || value.sessionId !== initial.sessionId || value.tool !== initial.tool
          || !isDeepStrictEqual(captureWorkspaceOperationJobScope(workspace),
            captureWorkspaceOperationJobScope(initial.scope.workspace)))) {
          throw new WorkspacePathToolError('PATH_SCOPE_CHANGED', operationId);
        }
        await access.assertCurrent();
        return value;
      };
      return live.kind === 'move'
        ? withDirectMcpWorkspaceMovePrincipalOnConnection(database, live.principal, inspect)
        : withDirectMcpWorkspaceDeletePrincipalOnConnection(database, live.principal, inspect);
    },
    recoverCommitted: async (_value, cause) => {
      throw Object.assign(new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED', operationId), { cause });
    },
  });
}

function selectedPaths(kind: WorkspaceOperationMcpJobPrincipal['kind'], input: SelectedRequest) {
  if (kind === 'move' && 'selections' in input) return input.selections.map(selection => ({ ...selection }));
  if (kind === 'delete' && 'path' in input) return [{ sourcePath: input.path }];
  throw new WorkspacePathToolError('INVALID_REQUEST', input.action === 'preview' ? undefined : input.operationId);
}

/** Requests reuse the existing deterministic action identity and native
 * compiler. Neither unsupported legacy plans nor physical imports execute. */
async function buildPathPlan(live: WorkspaceOperationMcpJobPrincipal, input: SelectedRequest,
  initial: Authority): Promise<NativePlan> {
  const plan = await buildWorkspacePathOperationPlan({ scope: initial.scope, kind: live.kind,
    selections: selectedPaths(live.kind, input) });
  await capturePathAuthority(live, input.action === 'preview' ? undefined : input.operationId, initial);
  if (plan.readiness !== 'ready' || (live.kind === 'move' ? plan.version !== 3 : plan.version !== 2)) {
    throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED', input.action === 'preview' ? undefined : input.operationId);
  }
  if (plan.version === 1 || !plan.coverage.complete
    || !isDeepStrictEqual(plan.sourceEvidence.workspaceScope, captureWorkspaceOperationJobScope(initial.scope.workspace))) {
    throw new WorkspacePathToolError('PATH_SCOPE_CHANGED', input.action === 'preview' ? undefined : input.operationId);
  }
  return plan;
}

async function readPathStatus(live: WorkspaceOperationMcpJobPrincipal,
  batchId: string, scope: WorkspaceOperationBatchScope): Promise<NativeStatus | null> {
  if (live.kind === 'move') {
    const value = await readWorkspaceOperationNativeMoveBatchStatus({ batchId, scope, mcpPrincipal: live });
    return value ? Object.freeze({ kind: 'move', value }) : null;
  }
  const value = await readWorkspaceOperationNativeDeleteBatchStatus({ batchId, scope, mcpPrincipal: live });
  return value ? Object.freeze({ kind: 'delete', value }) : null;
}

function assertPathRequest(status: NativeStatus, live: WorkspaceOperationMcpJobPrincipal,
  input: Exclude<Request, { action: 'preview' | 'status' }>): void {
  const { batch, plan } = status.value;
  if (status.kind !== live.kind || batch.planId !== input.planId
    || plan.actions.length !== 1 || plan.actions[0].kind !== live.kind
    || !isDeepStrictEqual(plan.actions[0].selections, selectedPaths(live.kind, input))) {
    throw new WorkspacePathToolError('PATH_PLAN_CHANGED', input.operationId);
  }
}

function pathExecution(status: NativeStatus): WorkspaceOperationBatchExecutionResult | null {
  return status.kind === 'move'
    ? workspaceOperationNativeMoveExecutionResult(status.value.plan, status.value.observation)
    : workspaceOperationNativeDeleteExecutionResult(status.value.plan, status.value.observation);
}

/** Whitelist presentation only. Journal progress never acknowledges a domain
 * effect; both public execution and completion come from checked native rows. */
function pathOperation(status: NativeStatus, operationId: string) {
  const { batch, plan } = status.value;
  const summary = { actionMode: 'apply' as const, status: batch.status,
    completedActions: batch.completedActions, phase: batch.phase };
  const execution = status.kind === 'move'
    ? projectWorkspaceOperationNativeMoveExecution({ ...summary, plan: status.value.plan }, status.value.observation)
    : projectWorkspaceOperationNativeDeleteExecution({ ...summary, plan: status.value.plan }, status.value.observation);
  // A lost completion acknowledgement can leave progress behind the proven
  // domain outcome. Preserve that honest journal separately from finality.
  const confirmed = execution.receiptStatus === 'available'
    && execution.finalization === 'complete' && pathExecution(status)?.status === 'applied';
  return { operationId, batchId: batch.batchId, planId: plan.planId, workspaceId: batch.workspaceId,
    journal: { status: batch.status, phase: batch.phase, completedActions: batch.completedActions,
      totalActions: batch.totalActions, createdAt: batch.createdAt, updatedAt: batch.updatedAt, errorCode: batch.errorCode },
    execution: { receiptStatus: execution.receiptStatus, finalization: execution.finalization,
      steps: execution.steps.map(step => ({ key: step.key, phase: step.phase, kind: step.kind,
        path: step.path, ...(step.destinationPath === undefined ? {} : { destinationPath: step.destinationPath }),
        state: step.state, ...(step.openPath === undefined ? {} : { openPath: step.openPath }) })) },
    completion: confirmed ? { status: 'confirmed' as const, historical: true as const } : { status: 'not_confirmed' as const },
  };
}

function pathPreview(plan: NativePlan) {
  const effects = plan.version === 3 ? workspaceOperationNativeMoveEffects(plan) : workspaceOperationNativeDeleteEffects(plan);
  const links = effects.reduce((count, effect) => count + effect.updatedLinks, 0);
  return { kind: plan.version === 3 ? 'move' as const : 'delete' as const,
    workspaceId: plan.workspaceId, planId: plan.planId, readiness: 'ready' as const,
    paths: plan.actions[0].selections.map(selection => ({ sourcePath: selection.sourcePath,
      ...(selection.destinationPath === undefined ? {} : { destinationPath: selection.destinationPath }) })),
    linkChanges: { rewrites: plan.version === 3 ? links : 0, unlinks: plan.version === 2 ? links : 0,
      affectedDocuments: effects.length }, coverage: { complete: true as const } };
}

/** Actual Store claims and existing native executor only. The shared renewal
 * controller is drained before each Owner B by the existing scheduler. */
async function executePathClaim(store: WorkspaceOperationBatchStore, batch: WorkspaceOperationBatchRecord,
  live: WorkspaceOperationMcpJobPrincipal, scope: WorkspaceOperationBatchScope): Promise<void> {
  return store.withClaim(batch, async jobClaim => {
    const original = batch.authorization;
    if (original.mode !== 'direct-mcp') throw new WorkspacePathToolError('PATH_SCOPE_CHANGED');
    const renewals = createWorkspaceOperationClaimRenewals(store, batch);
    let finishAttempted = false;
    renewals.start();
    try {
      const result = await withWorkspaceOperationJobClaimScheduling(jobClaim, {
        pauseAndDrain: async () => {
          await renewals.pauseAndDrain();
          if (renewals.hasLeaseLost()) throw new Error('BATCH_LEASE_LOST');
        },
        resume: renewals.resume,
      }, () => executeWorkspaceOperationBatch({ batchId: batch.batchId, plan: batch.plan, scope,
        actorUserId: original.actorUserId, actorDisplayName: original.actorDisplayName,
        actorId: original.actorId, actorType: original.actorType, actorSessionId: original.actorSessionId,
        jobClaim, mcpPrincipal: live,
        onProgress: async progress => {
          if (renewals.hasLeaseLost() || !await store.heartbeatClaim(batch, progress)) throw new Error('BATCH_LEASE_LOST');
        },
      }));
      await renewals.pauseAndDrain();
      if (renewals.hasLeaseLost()) throw new Error('BATCH_LEASE_LOST');
      projectWorkspaceOperationBatchFileViews({ scope, plan: batch.plan, result, undo: false });
      finishAttempted = true;
      if (!await store.finishClaim(batch, { status: result.status, completedActions: result.completedActions,
        trashEntryIds: result.trashEntryIds, errorCode: result.errorCode,
        phase: result.status === 'applied' ? 'complete' : 'recovery' })) throw new Error('BATCH_CLAIM_CHANGED');
    } catch (error) {
      await renewals.pauseAndDrain();
      let failure = error;
      // Refresh caches after an uncertain effect without announcing another
      // physical birth/deletion or claiming that an incomplete job succeeded.
      try { invalidateWorkspaceFileViews({ fileOptions: scope.fileOptions, fullTree: true, mutations: [] }); }
      catch (views) {
        failure = Object.assign(new AggregateError([error, views], 'MCP file action and view refresh failed.'),
          { code: workspaceOperationBatchErrorCode(error), status: 503 });
      }
      if (!finishAttempted && !renewals.hasLeaseLost()) {
        try {
          finishAttempted = true;
          if (!await store.finishClaim(batch, { status: 'needs_recovery', phase: 'recovery',
            errorCode: workspaceOperationBatchErrorCode(failure) })) throw new Error('BATCH_CLAIM_CHANGED');
        } catch (finalization) {
          throw Object.assign(new AggregateError([failure, finalization], 'MCP file action and journal finalization failed.'),
            { code: 'BATCH_CLAIM_COMMIT_UNCONFIRMED', status: 503 });
        }
      }
      throw failure;
    } finally { await renewals.pauseAndDrain(); }
  });
}

/** This shared entry receives only a frozen decoded request and one genuine
 * fixed action handle. It neither reconstructs AuthInfo nor invokes a worker. */
async function runDirectMcpWorkspacePathService(input: Request,
  live: WorkspaceOperationMcpJobPrincipal): Promise<DirectMcpWorkspacePathResultV1> {
  const operationId = input.action === 'preview' ? undefined : input.operationId;
  if (input.action !== 'status' && !authenticatedNativeTextSessionEnabled()) {
    throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED', operationId);
  }
  const initial = await capturePathAuthority(live, operationId);
  if (input.action === 'preview') {
    const plan = await buildPathPlan(live, input, initial);
    return encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: 'preview', preview: pathPreview(plan) });
  }
  const batchId = workspaceOperationMcpBatchId({ userId: initial.userId, clientId: initial.clientId,
    workspaceId: input.workspaceId, tool: initial.tool, operationId: input.operationId });
  if (input.action === 'status') {
    const status = await readPathStatus(live, batchId, initial.scope);
    if (!status) throw new WorkspacePathToolError('PATH_STATUS_NOT_FOUND', input.operationId);
    return encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: 'status',
      operation: pathOperation(status, input.operationId) }, input.operationId);
  }
  return withWorkspaceMutationLock(input.workspaceId, async () => {
    // Resolve original history before any planning. A moved/deleted source or
    // later replacement at its old path never becomes a new request on retry.
    const saved = await readPathStatus(live, batchId, initial.scope);
    if (saved) assertPathRequest(saved, live, input);
    if (!saved && input.action === 'recover') throw new WorkspacePathToolError('PATH_OPERATION_NOT_FOUND', input.operationId);
    const store = new WorkspaceOperationBatchStore();
    let selected: WorkspaceOperationMcpClaimResult;
    if (saved) {
      const command = { operationId: input.operationId, workspaceId: input.workspaceId, planId: input.planId };
      selected = live.kind === 'move' ? await store.claimExistingMcpMove(live.principal, command)
        : await store.claimExistingMcpDelete(live.principal, command);
    } else {
      const plan = await buildPathPlan(live, input, initial);
      if (plan.planId !== input.planId) throw new WorkspacePathToolError('PATH_PLAN_CHANGED', input.operationId);
      if (live.kind === 'move' && plan.version === 3) {
        selected = await store.createMcpMoveAndClaim(live.principal, { operationId: input.operationId, plan });
      } else if (live.kind === 'delete' && plan.version === 2) {
        selected = await store.createMcpDeleteAndClaim(live.principal, { operationId: input.operationId, plan });
      } else throw new WorkspacePathToolError('PATH_SCOPE_CHANGED', input.operationId);
    }
    if (selected.kind === 'absent') throw new WorkspacePathToolError('PATH_OPERATION_NOT_FOUND', input.operationId);
    if (selected.kind === 'historical-header') {
      const confirmed = await readPathStatus(live, batchId, initial.scope);
      if (!confirmed || pathExecution(confirmed)?.status !== 'applied' || confirmed.value.batch.status !== 'applied') {
        throw new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED', input.operationId);
      }
      assertPathRequest(confirmed, live, input);
      invalidateWorkspaceFileViews({ fileOptions: initial.scope.fileOptions, fullTree: true, mutations: [] });
      return encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: input.action,
        operation: pathOperation(confirmed, input.operationId), alreadyKnown: true }, input.operationId);
    }
    await executePathClaim(store, selected.batch, live, initial.scope);
    const current = await readPathStatus(live, batchId, initial.scope);
    if (!current) throw new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED', input.operationId);
    assertPathRequest(current, live, input);
    return encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: input.action,
      operation: pathOperation(current, input.operationId), alreadyKnown: saved !== null }, input.operationId);
  });
}

/** Start the genuine token capture synchronously before this entry's first
 * await. The fixed Core owns JWT/session/client/opt-in/ACL enforcement. */
export function runDirectMcpWorkspaceMoveService(input: DecodedDirectMcpWorkspaceMoveRequestV1,
  authInfo: AuthInfo): Promise<DirectMcpWorkspacePathResultV1> {
  return withDirectMcpWorkspaceMovePrincipal(authInfo, { workspaceId: input.workspaceId }, () => undefined, principal =>
    runDirectMcpWorkspacePathService(input, captureWorkspaceOperationMcpJobPrincipal({ kind: 'move', principal })));
}
export function runDirectMcpWorkspaceDeleteService(input: DecodedDirectMcpWorkspaceDeleteRequestV1,
  authInfo: AuthInfo): Promise<DirectMcpWorkspacePathResultV1> {
  return withDirectMcpWorkspaceDeletePrincipal(authInfo, { workspaceId: input.workspaceId }, () => undefined, principal =>
    runDirectMcpWorkspacePathService(input, captureWorkspaceOperationMcpJobPrincipal({ kind: 'delete', principal })));
}
