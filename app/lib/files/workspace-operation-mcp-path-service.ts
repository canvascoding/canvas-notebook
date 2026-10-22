import { decodeWorkspaceOperationPhysicalDeleteBatchPlanV5, type WorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import { readWorkspaceOperationPhysicalDeleteBatchStatusV5, type WorkspaceOperationPhysicalDeleteBatchStatusV5 } from './workspace-operation-physical-delete-status-v5';
import { workspaceOperationPhysicalDeleteExecutionResultV5, projectWorkspaceOperationPhysicalDeleteExecutionV5 } from './workspace-operation-physical-delete-execution-public-v5';
import { workspaceOperationMcpPhysicalHtmlDeletePreviewV3 } from './workspace-operation-physical-delete-public-v5';
import 'server-only';
import { decodeWorkspaceOperationCohortDeletePlan, type WorkspaceOperationCohortDeletePlan } from './workspace-operation-cohort-delete-plan';
import { readWorkspaceOperationCohortDeleteStatus, type WorkspaceOperationCohortDeleteStatus } from './workspace-operation-cohort-delete-status';
import { workspaceOperationCohortDeleteExecutionResult, projectWorkspaceOperationCohortDeleteExecution, workspaceOperationMcpCohortDeletePreview } from './workspace-operation-cohort-delete-public';

import { isDeepStrictEqual, types } from 'node:util';
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
  type DirectMcpWorkspacePathResultV1, type DirectMcpWorkspacePathImportPreviewV1, type DirectMcpWorkspacePathHtmlImportPreviewV4, type DirectMcpWorkspacePathHtmlPreviewV2, type DirectMcpWorkspacePathHtmlDeletePreviewV3,
  WORKSPACE_PATH_TOOL_RESULT_MAX_BYTES } from '../mcp/server/workspace-path-tool-contract';
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
import { decodeWorkspaceOperationNativeMoveBatchPlan, type WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
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
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';
import { readWorkspacePathImportOperationHistory } from './workspace-path-import-operation-history';
import { readWorkspacePathImportPreparationPlan } from './workspace-path-import-operation-preview';
import { prepareWorkspacePathImportOperation } from './workspace-path-import-operation';
import type { WorkspacePathHtmlImportPreparationPlanV4 } from './workspace-path-html-import-preparation';
import type { WorkspacePathImportPreparationPlanV1 } from './workspace-path-import-preparation-plan';
import { decodeWorkspacePathHtmlNoImportPreparationPlanV2 } from './workspace-path-html-no-import-preparation';
import { decodeWorkspacePathHtmlNativeDeletePreparationPlanV3 } from './workspace-path-html-native-delete-preparation';
import { decodeWorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-native-delete-plan';

type Request = DecodedDirectMcpWorkspaceMoveRequestV1 | DecodedDirectMcpWorkspaceDeleteRequestV1;
type NativePlan = WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationNativeDeleteBatchPlan | WorkspaceOperationPhysicalDeleteBatchPlanV5 | WorkspaceOperationCohortDeletePlan;
type SelectedRequest = Exclude<Request, { action: 'status' }>;
type Authority = Readonly<{ userId: string; clientId: string; sessionId: string;
  tool: 'move_knowledge_source' | 'delete_knowledge_source'; scope: WorkspaceOperationBatchScope }>;
type NativeStatus = Readonly<{ kind: 'move'; value: WorkspaceOperationNativeMoveBatchStatus }>
  | Readonly<{kind:'cohort-delete';value:WorkspaceOperationCohortDeleteStatus}>
  | Readonly<{ kind: 'delete'; value: WorkspaceOperationNativeDeleteBatchStatus | WorkspaceOperationPhysicalDeleteBatchStatusV5 }>;
type ImportHistory = NonNullable<Awaited<ReturnType<typeof readWorkspacePathImportOperationHistory>>>;

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
  if (plan.readiness !== 'ready' || (live.kind === 'move' ? plan.version !== 3 : plan.version !== 2 && plan.version !== 5 && plan.version !== 6)) {
    throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED', input.action === 'preview' ? undefined : input.operationId);
  }
  if(plan.version===6){const cohort=decodeWorkspaceOperationCohortDeletePlan(plan);if(!isDeepStrictEqual(cohort.sourceEvidence.workspaceScope,captureWorkspaceOperationJobScope(initial.scope.workspace)))throw new WorkspacePathToolError('PATH_SCOPE_CHANGED');return cohort;}
  if (plan.version === 5) {
    const physical = decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan);
    if (!physical.linkAssessment.complete || physical.linkAssessment.blockers.length || physical.issues.length
      || !isDeepStrictEqual(physical.sourceEvidence.workspaceScope, captureWorkspaceOperationJobScope(initial.scope.workspace))) {
      throw new WorkspacePathToolError('PATH_SCOPE_CHANGED', input.action === 'preview' ? undefined : input.operationId);
    }
    return physical;
  }
  const html = (plan.version === 2 || plan.version === 3) && plan.planIdentityVersion === 4 ? plan.version === 3 ? decodeWorkspaceOperationNativeMoveBatchPlan(plan)
    : plan.version === 2 ? decodeWorkspaceOperationNativeDeleteBatchPlan(plan) : null : null;
  if (html && (html.planIdentityVersion !== 4 || html.sourceEvidence.evidenceVersion !== 5 || !html.linkAssessment.complete
    || html.linkAssessment.blockers.length || html.issues.length || html.coverage.complete !== html.sourceEvidence.coverage.complete)) {
    throw new WorkspacePathToolError('PATH_SCOPE_CHANGED', input.action === 'preview' ? undefined : input.operationId);
  }
  if (plan.version === 1 || !plan.coverage.complete && !html
    || !isDeepStrictEqual(plan.sourceEvidence.workspaceScope, captureWorkspaceOperationJobScope(initial.scope.workspace))) {
    throw new WorkspacePathToolError('PATH_SCOPE_CHANGED', input.action === 'preview' ? undefined : input.operationId);
  }
  return html ?? plan;
}

async function readPathStatus(live: WorkspaceOperationMcpJobPrincipal,
  batchId: string, scope: WorkspaceOperationBatchScope): Promise<NativeStatus | null> {
  if (live.kind === 'move') {
    const value = await readWorkspaceOperationNativeMoveBatchStatus({ batchId, scope, mcpPrincipal: live });
    return value ? Object.freeze({ kind: 'move', value }) : null;
  }
  const cohort=await readWorkspaceOperationCohortDeleteStatus({batchId,scope,mcpPrincipal:live});
  if(cohort)return Object.freeze({kind:'cohort-delete',value:cohort});
  const value = await readWorkspaceOperationNativeDeleteBatchStatus({ batchId, scope, mcpPrincipal: live });
  if (value) return Object.freeze({ kind: 'delete', value });
  const physical = await readWorkspaceOperationPhysicalDeleteBatchStatusV5({ batchId, scope, mcpPrincipal: live });
  return physical ? Object.freeze({ kind: 'delete', value: physical }) : null;
}

function assertPathRequest(status: NativeStatus, live: WorkspaceOperationMcpJobPrincipal,
  input: Exclude<Request, { action: 'preview' | 'status' }>, history: ImportHistory | null = null): void {
  const { batch, plan } = status.value;
  const originalId = history?.record.previewPlan.planId;
  if ((status.kind==='cohort-delete'?'delete':status.kind) !== live.kind || input.planId !== batch.planId && input.planId !== originalId
    || history && (batch.planId !== history.record.nativePlan.planId
      || !isDeepStrictEqual(history.record.previewPlan.request, { kind: live.kind, selections: selectedPaths(live.kind, input) }))
    || plan.actions.length !== 1 || plan.actions[0].kind !== live.kind
    || !isDeepStrictEqual(plan.actions[0].selections, selectedPaths(live.kind, input))) {
    throw new WorkspacePathToolError('PATH_PLAN_CHANGED', input.operationId);
  }
}

function pathExecution(status: NativeStatus): WorkspaceOperationBatchExecutionResult | null {
  if(status.kind==='cohort-delete')return workspaceOperationCohortDeleteExecutionResult(status.value.plan,status.value.observation);
  return status.kind === 'move'
    ? workspaceOperationNativeMoveExecutionResult(status.value.plan, status.value.observation)
    : status.value.plan.version === 5 ? workspaceOperationPhysicalDeleteExecutionResultV5(status.value.plan, status.value.observation)
      : workspaceOperationNativeDeleteExecutionResult(status.value.plan, status.value.observation);
}

/** Whitelist presentation only. Journal progress never acknowledges a domain
 * effect; both public execution and completion come from checked native rows. */
function pathOperation(status: NativeStatus, operationId: string, history: ImportHistory | null = null) {
  const { batch, plan } = status.value;
  const summary = { actionMode: 'apply' as const, status: batch.status,
    completedActions: batch.completedActions, phase: batch.phase };
  const execution = status.kind === 'cohort-delete' ? projectWorkspaceOperationCohortDeleteExecution({...summary,plan:status.value.plan},status.value.observation) : status.kind === 'move'
    ? projectWorkspaceOperationNativeMoveExecution({ ...summary, plan: status.value.plan }, status.value.observation)
    : status.value.plan.version === 5 ? projectWorkspaceOperationPhysicalDeleteExecutionV5({ ...summary, plan: status.value.plan }, status.value.observation)
      : projectWorkspaceOperationNativeDeleteExecution({ ...summary, plan: status.value.plan }, status.value.observation);
  // A lost completion acknowledgement can leave progress behind the proven
  // domain outcome. Preserve that honest journal separately from finality.
  const confirmed = execution.receiptStatus === 'available'
    && execution.finalization === 'complete' && pathExecution(status)?.status === 'applied';
  return { operationId, batchId: batch.batchId, planId: plan.planId, workspaceId: batch.workspaceId,
    ...(history ? { preparation: { version: 1 as const, previewPlanId: history.record.previewPlan.planId } } : {}),
    journal: { status: batch.status, phase: batch.phase, completedActions: batch.completedActions,
      totalActions: batch.totalActions, createdAt: batch.createdAt, updatedAt: batch.updatedAt, errorCode: batch.errorCode },
    execution: { receiptStatus: execution.receiptStatus, finalization: execution.finalization,
      steps: execution.steps.map(step => ({ key: step.key, phase: step.phase, kind: step.kind,
        path: step.path, ...(step.destinationPath === undefined ? {} : { destinationPath: step.destinationPath }),
        state: step.state, ...(step.openPath === undefined ? {} : { openPath: step.openPath }) })) },
    completion: confirmed ? { status: 'confirmed' as const, historical: true as const } : { status: 'not_confirmed' as const },
  };
}

/** The shared reader proves the immutable original mapping. Match its facts
 * to this separately checked domain status, never to a later path occupant. */
function assertPathPreparationHistory(status: NativeStatus, history: ImportHistory | null,
  live: WorkspaceOperationMcpJobPrincipal, authority: Authority, operationId: string): void {
  if (!history) return;
  const original = history.record, { batch, plan } = status.value;
  if (original.operationId !== operationId || original.batchId !== batch.batchId || history.batch.batchId !== batch.batchId
    || original.origin.kind !== 'direct-mcp' || original.origin.userId !== authority.userId || original.origin.clientId !== authority.clientId
    || original.origin.tool !== live.kind || original.previewPlan.request.kind !== live.kind || status.kind !== live.kind
    || !isDeepStrictEqual(original.origin.scope, captureWorkspaceOperationJobScope(authority.scope.workspace))
    || !isDeepStrictEqual(original.nativePlan, plan) || !isDeepStrictEqual(history.batch.plan, plan)
    || !isDeepStrictEqual(history.batch.authorization, batch.authorization)) {
    throw new WorkspacePathToolError('PATH_SCOPE_CHANGED', operationId);
  }
}

/** Bounded public facts only; no source evidence, FD, actor, native refs or
 * guessed rendered link edits. Preparation never claims execution readiness. */
function pathImportPreparationPreview(plan: WorkspacePathImportPreparationPlanV1 | WorkspacePathHtmlImportPreparationPlanV4): DirectMcpWorkspacePathImportPreviewV1 | DirectMcpWorkspacePathHtmlImportPreviewV4 {
  if (plan.request.kind !== 'move' && plan.request.kind !== 'delete'
    || plan.readiness !== 'blocked' && plan.readiness !== 'requires-import-rebinding') throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED');
  let bytes = 1024;
  const add = <T>(value: T): T => {
    bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > WORKSPACE_PATH_TOOL_RESULT_MAX_BYTES) throw new WorkspacePathToolError('PATH_OUTPUT_TOO_LARGE'); return value;
  };
  const safe = (value: string) => value.length <= 1024 && isCanonicalWorkspacePath(value) && value !== '.' && !/[\p{Cc}\p{Cf}]/u.test(value);
  const selected = (value: string): string => {
    if (!safe(value)) throw new WorkspacePathToolError(value.length > 1024 ? 'PATH_OUTPUT_TOO_LARGE' : 'PATH_UNAVAILABLE'); return value;
  };
  if (plan.request.selections.length > 1000 || plan.importRequirements.length > 10000 || plan.issues.length > 10000) {
    throw new WorkspacePathToolError('PATH_OUTPUT_TOO_LARGE');
  }
  const diagnostics = (items: WorkspacePathHtmlImportPreparationPlanV4['linkAssessment']['warnings']
    | WorkspacePathHtmlImportPreparationPlanV4['linkAssessment']['blockers']) => items.map(item => add({
      code: item.reason, path: selected(item.sourcePath), ...('line' in item && item.line !== undefined ? { line: item.line } : {}),
      targets: [...(item.htmlTargets ?? [])],
    }));
  const html = plan.version === 4 ? { version: 4 as const, linkAssessment: { complete: plan.linkAssessment.complete,
    warnings: diagnostics(plan.linkAssessment.warnings), blockers: diagnostics(plan.linkAssessment.blockers) } } : null;
  const common = { kind: 'native-path-import-preparation' as const, operationKind: plan.request.kind, workspaceId: plan.scope.workspaceId,
    planId: plan.planId, executionReady: false as const, readiness: plan.readiness,
    paths: plan.request.selections.map(item => add({ sourcePath: selected(item.sourcePath),
      ...(item.destinationPath === undefined ? {} : { destinationPath: selected(item.destinationPath) }) })),
    imports: plan.importRequirements.map(item => add({ path: selected(item.path), reasons: [...item.reasons] })),
    issues: [...new Map(plan.issues.map(item => {
      const issue = { code: /^[a-z][a-z0-9-]{0,99}$/u.test(item.code) ? item.code : 'unknown', path: safe(item.path) ? item.path : '' };
      return [JSON.stringify(issue), add(issue)] as const;
    })).values()] };
  return html ? { ...common, ...html, coverage: { complete: plan.coverage.complete } }
    : { ...common, version: 1, coverage: { complete: true } };
}

function pathPreview(plan: NativePlan) {
  if (plan.version === 6) return workspaceOperationMcpCohortDeletePreview(plan);
  if (plan.version === 5) return workspaceOperationMcpPhysicalHtmlDeletePreviewV3(plan);
  if (plan.version === 2 && plan.planIdentityVersion === 4) return workspaceOperationMcpHtmlDeletePreviewV3(plan);
  if (plan.version === 3 && plan.planIdentityVersion === 4) return workspaceOperationMcpHtmlPreviewV2(plan);
  const effects = plan.version === 3 ? workspaceOperationNativeMoveEffects(plan) : workspaceOperationNativeDeleteEffects(plan);
  const links = effects.reduce((count, effect) => count + effect.updatedLinks, 0);
  return { kind: plan.version === 3 ? 'move' as const : 'delete' as const,
    workspaceId: plan.workspaceId, planId: plan.planId, readiness: 'ready' as const,
    paths: plan.actions[0].selections.map(selection => ({ sourcePath: selection.sourcePath,
      ...(selection.destinationPath === undefined ? {} : { destinationPath: selection.destinationPath }) })),
    linkChanges: { rewrites: plan.version === 3 ? links : 0, unlinks: plan.version === 2 ? links : 0,
      affectedDocuments: effects.length }, coverage: { complete: true as const } };
}

/** Whitelisted display projection of strictly decoded new facts. No raw HTML,
 * native IDs/proofs, relative positions, binary payloads or actors escape.
 * A successful projection never grants authority to apply a request. */
export function workspaceOperationMcpHtmlPreviewV2(input: unknown): DirectMcpWorkspacePathHtmlPreviewV2 {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw new WorkspacePathToolError('PATH_UNAVAILABLE');
  const version = Object.getOwnPropertyDescriptor(input, 'version');
  if (!version?.enumerable || !Object.hasOwn(version, 'value')) throw new WorkspacePathToolError('PATH_UNAVAILABLE');
  const early = version.value === 2 ? decodeWorkspacePathHtmlNoImportPreparationPlanV2(input) : null;
  const decodedNative = early ? null : decodeWorkspaceOperationNativeMoveBatchPlan(input);
  const native = decodedNative?.planIdentityVersion === 4 ? decodedNative : null;
  if (early ? early.request.kind !== 'move' || early.readiness !== 'blocked'
    : !native || native.actions[0].kind !== 'move'
      || native.sourceEvidence.evidenceVersion !== 5 || !native.linkAssessment.complete || native.linkAssessment.blockers.length) {
    throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED');
  }
  const selections = early ? early.request.selections : native!.actions[0].selections;
  const assessment = early ? early.linkAssessment : native!.linkAssessment;
  const issues = early ? early.issues : native!.issues;
  const imports = early ? early.requiredRawImports : [];
  if (selections.length > 1000 || assessment.warnings.length > 10000 || assessment.blockers.length > 10000
    || issues.length > 10000 || imports.length > 10000) throw new WorkspacePathToolError('PATH_OUTPUT_TOO_LARGE');
  const diagnostics = (items: typeof assessment.warnings | typeof assessment.blockers) => items.map(item => ({
    code: item.reason, path: item.sourcePath, ...('line' in item && item.line !== undefined ? { line: item.line } : {}),
    targets: [...(item.htmlTargets ?? [])],
  }));
  const effects = native ? workspaceOperationNativeMoveEffects(native) : [];
  const projection = { version: 2 as const, kind: 'native-path-html-assessment' as const, operationKind: 'move' as const,
    executionReady: false as const, readiness: early ? 'blocked' as const : 'ready' as const,
    workspaceId: early ? early.scope.workspaceId : native!.workspaceId, planId: early ? early.planId : native!.planId,
    paths: selections.map(selection => {
      if (typeof selection.destinationPath !== 'string') throw new WorkspacePathToolError('PATH_UNAVAILABLE');
      return { sourcePath: selection.sourcePath, destinationPath: selection.destinationPath };
    }),
    linkChanges: { rewrites: effects.reduce((count, effect) => count + effect.updatedLinks, 0), unlinks: 0,
      affectedDocuments: effects.length }, coverage: { complete: early ? early.coverage.complete : native!.sourceEvidence.coverage.complete },
    linkAssessment: { complete: assessment.complete, warnings: diagnostics(assessment.warnings), blockers: diagnostics(assessment.blockers) },
    issues: [...new Map(issues.map(item => {
      const issue = { code: /^[a-z][a-z0-9-]{0,99}$/u.test(item.code) ? item.code : 'unknown', path: item.path };
      return [JSON.stringify(issue), issue] as const;
    })).values()], imports: imports.map(item => ({ path: item.path, reasons: [...item.reasons] })),
  };
  const encoded = encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: 'preview', preview: projection });
  if (encoded.action !== 'preview' || encoded.preview.kind !== 'native-path-html-assessment' || encoded.preview.version !== 2) throw new WorkspacePathToolError('PATH_UNAVAILABLE');
  return encoded.preview;
}

/** Actual Store claims and existing native executor only. The shared renewal
 * controller is drained before each Owner B by the existing scheduler. */
/** Explicit new Delete display shape. The historical Move2 projection stays unchanged. */
export function workspaceOperationMcpHtmlDeletePreviewV3(input: unknown): DirectMcpWorkspacePathHtmlDeletePreviewV3 {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw new WorkspacePathToolError('PATH_UNAVAILABLE');
  const version = Object.getOwnPropertyDescriptor(input, 'version');
  if (!version?.enumerable || !Object.hasOwn(version, 'value')) throw new WorkspacePathToolError('PATH_UNAVAILABLE');
  const early = version.value === 3 ? decodeWorkspacePathHtmlNativeDeletePreparationPlanV3(input) : null;
  const decoded = early ? null : decodeWorkspaceOperationNativeDeleteBatchPlan(input);
  const native = decoded?.planIdentityVersion === 4 ? decoded : null;
  if (early ? early.readiness !== 'blocked' : !native || !native.linkAssessment.complete
    || native.linkAssessment.blockers.length || native.issues.length) throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED');
  const assessment = early ? early.linkAssessment : native!.linkAssessment;
  const issues = early ? early.issues : native!.issues, imports = early ? early.requiredRawImports : [];
  const selections = early ? early.request.selections : native!.actions[0].selections;
  if (selections.length !== 1 || assessment.warnings.length > 10000 || assessment.blockers.length > 10000
    || issues.length > 10000 || imports.length > 10000) throw new WorkspacePathToolError('PATH_OUTPUT_TOO_LARGE');
  const diagnostics = (items: typeof assessment.warnings | typeof assessment.blockers) => items.map(item => ({
    code: item.reason, path: item.sourcePath, ...('line' in item && item.line !== undefined ? { line: item.line } : {}),
    targets: [...(item.htmlTargets ?? [])],
  }));
  const effects = native ? workspaceOperationNativeDeleteEffects(native) : [];
  const result = { version: 3 as const, kind: 'native-path-html-assessment' as const, operationKind: 'delete' as const,
    executionReady: false as const, readiness: early ? 'blocked' as const : 'ready' as const,
    workspaceId: early ? early.scope.workspaceId : native!.workspaceId, planId: early ? early.planId : native!.planId,
    paths: selections.map(selection => ({ sourcePath: selection.sourcePath })),
    linkChanges: { rewrites: 0, unlinks: effects.reduce((count,effect) => count + effect.updatedLinks, 0), affectedDocuments: effects.length },
    coverage: { complete: early ? early.coverage.complete : native!.sourceEvidence.coverage.complete },
    linkAssessment: { complete: assessment.complete, warnings: diagnostics(assessment.warnings), blockers: diagnostics(assessment.blockers) },
    issues: [...new Map(issues.map(item => { const issue = { code: /^[a-z][a-z0-9-]{0,99}$/u.test(item.code) ? item.code : 'unknown', path: item.path };
      return [JSON.stringify(issue),issue] as const; })).values()], imports: imports.map(item => ({ path: item.path,reasons:[...item.reasons] })),
  };
  const encoded = encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1,action: 'preview',preview: result });
  if (encoded.action !== 'preview' || encoded.preview.kind !== 'native-path-html-assessment' || encoded.preview.version !== 3) throw new WorkspacePathToolError('PATH_UNAVAILABLE');
  return encoded.preview;
}

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
    const preparation = await readWorkspacePathImportPreparationPlan({ principal: live, kind: live.kind, selections: selectedPaths(live.kind, input) });
    await capturePathAuthority(live, undefined, initial);
    if (preparation.readiness !== 'native-ready') return encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: 'preview',
      preview: preparation.version === 6 ? workspaceOperationMcpCohortDeletePreview(preparation) : preparation.version === 5 ? workspaceOperationMcpPhysicalHtmlDeletePreviewV3(preparation)
        : preparation.version === 3 ? workspaceOperationMcpHtmlDeletePreviewV3(preparation)
        : preparation.version === 2 ? workspaceOperationMcpHtmlPreviewV2(preparation) : pathImportPreparationPreview(preparation) });
    const plan = await buildPathPlan(live, input, initial);
    return encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: 'preview', preview: pathPreview(plan) });
  }
  const batchId = workspaceOperationMcpBatchId({ userId: initial.userId, clientId: initial.clientId,
    workspaceId: input.workspaceId, tool: initial.tool, operationId: input.operationId });
  if (input.action === 'status') {
    const history = await readWorkspacePathImportOperationHistory({ principal: live, operationId: input.operationId });
    const status = await readPathStatus(live, batchId, initial.scope);
    if (!status) throw new WorkspacePathToolError(history ? 'PATH_OUTCOME_UNCONFIRMED' : 'PATH_STATUS_NOT_FOUND', input.operationId);
    assertPathPreparationHistory(status, history, live, initial, input.operationId);
    return encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: 'status',
      operation: pathOperation(status, input.operationId, history) }, input.operationId);
  }
  const selection = await withWorkspaceMutationLock(input.workspaceId, async () => {
    // Resolve original history before any planning. A moved/deleted source or
    // later replacement at its old path never becomes a new request on retry.
    let history = await readWorkspacePathImportOperationHistory({ principal: live, operationId: input.operationId,
      expected: { planId: input.planId, request: { kind: live.kind, selections: selectedPaths(live.kind, input) } } });
    const saved = await readPathStatus(live, batchId, initial.scope);
    if (history && !saved) throw new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED', input.operationId);
    if (saved) { assertPathPreparationHistory(saved, history, live, initial, input.operationId); assertPathRequest(saved, live, input, history); }
    if (!saved && input.action === 'recover') throw new WorkspacePathToolError('PATH_OPERATION_NOT_FOUND', input.operationId);
    const store = new WorkspaceOperationBatchStore();
    let selected: WorkspaceOperationMcpClaimResult;
    if (saved) {
      const command = { operationId: input.operationId, workspaceId: input.workspaceId, planId: saved.value.batch.planId };
      selected = live.kind === 'move' ? await store.claimExistingMcpMove(live.principal, command)
        : await store.claimExistingMcpDelete(live.principal, command);
    } else {
      const preparation = await readWorkspacePathImportPreparationPlan({ principal: live, kind: live.kind, selections: selectedPaths(live.kind, input) });
      await capturePathAuthority(live, input.operationId, initial);
      if (preparation.readiness === 'requires-import-rebinding') {
        if (preparation.planId !== input.planId) throw new WorkspacePathToolError('PATH_PLAN_CHANGED', input.operationId);
        // Confirm bounded public representability before the first write. The
        // genuine Owner commits imports/header/P0/admission and releases its
        // exclusive guard before this ordinary claim can be acquired.
        encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: 'preview', preview: pathImportPreparationPreview(preparation) });
        history = await prepareWorkspacePathImportOperation({ principal: live, operationId: input.operationId, plan: preparation });
        const prepared = await readPathStatus(live, batchId, initial.scope);
        if (!prepared) throw new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED', input.operationId);
        assertPathPreparationHistory(prepared, history, live, initial, input.operationId); assertPathRequest(prepared, live, input, history);
        const command = { operationId: input.operationId, workspaceId: input.workspaceId, planId: history.record.nativePlan.planId };
        selected = live.kind === 'move' ? await store.claimExistingMcpMove(live.principal, command)
          : await store.claimExistingMcpDelete(live.principal, command);
      } else {
        if (preparation.readiness !== 'native-ready') throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED', input.operationId);
        const plan = await buildPathPlan(live, input, initial);
        if (plan.planId !== input.planId) throw new WorkspacePathToolError('PATH_PLAN_CHANGED', input.operationId);
        if (live.kind === 'move' && plan.version === 3) {
          selected = await store.createMcpMoveAndClaim(live.principal, { operationId: input.operationId, plan });
        } else if (live.kind === 'delete' && (plan.version === 2 || plan.version === 5 || plan.version === 6)) {
          selected = await store.createMcpDeleteAndClaim(live.principal, { operationId: input.operationId, plan });
        } else throw new WorkspacePathToolError('PATH_SCOPE_CHANGED', input.operationId);
      }
    }
    if (selected.kind === 'absent') throw new WorkspacePathToolError('PATH_OPERATION_NOT_FOUND', input.operationId);
    if (selected.kind === 'historical-header') {
      const confirmed = await readPathStatus(live, batchId, initial.scope);
      if (!confirmed || pathExecution(confirmed)?.status !== 'applied' || confirmed.value.batch.status !== 'applied') {
        throw new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED', input.operationId);
      }
      assertPathPreparationHistory(confirmed, history, live, initial, input.operationId); assertPathRequest(confirmed, live, input, history);
      invalidateWorkspaceFileViews({ fileOptions: initial.scope.fileOptions, fullTree: true, mutations: [] });
      return { kind: 'historical' as const,
        result: encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: input.action,
          operation: pathOperation(confirmed, input.operationId, history), alreadyKnown: true }, input.operationId) };
    }
    return { kind: 'claimed' as const, store, batch: selected.batch, alreadyKnown: saved !== null, history };
  });
  if (selection.kind === 'historical') return selection.result;
  // The native executor acquires its own fixed Owner kernels. Its admission
  // drain must run after this selection kernel has been released.
  await executePathClaim(selection.store, selection.batch, live, initial.scope);
  const current = await readPathStatus(live, batchId, initial.scope);
  if (!current) throw new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED', input.operationId);
  assertPathPreparationHistory(current, selection.history, live, initial, input.operationId); assertPathRequest(current, live, input, selection.history);
  return encodeDirectMcpWorkspacePathResultV1({ apiVersion: 1, action: input.action,
    operation: pathOperation(current, input.operationId, selection.history), alreadyKnown: selection.alreadyKnown }, input.operationId);
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
