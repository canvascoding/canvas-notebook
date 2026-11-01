import { decodeWorkspaceOperationPhysicalDeleteBatchPlanV5, type WorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import type { WorkspaceOperationPhysicalDeleteBatchStatusV5 } from './workspace-operation-physical-delete-status-v5';
import { workspaceOperationPhysicalDeleteExecutionResultV5, projectWorkspaceOperationPhysicalDeleteExecutionV5 } from './workspace-operation-physical-delete-execution-public-v5';
import { workspaceOperationMcpPhysicalHtmlDeletePreviewV3 } from './workspace-operation-physical-delete-public-v5';
import 'server-only';
import { decodeWorkspaceOperationCohortDeletePlan, type WorkspaceOperationCohortDeletePlan } from './workspace-operation-cohort-delete-plan';
import type { WorkspaceOperationCohortDeleteStatus } from './workspace-operation-cohort-delete-status';
import { workspaceOperationCohortDeleteExecutionResult, projectWorkspaceOperationCohortDeleteExecution, workspaceOperationMcpCohortDeletePreview } from './workspace-operation-cohort-delete-public';

import { isDeepStrictEqual, types } from 'node:util';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { openDb } from '../db';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import type { ApiKeyCredential } from '../api-keys/authentication';
import { withApiKeyWorkspacePathPrincipal, withApiKeyWorkspacePathPrincipalOnConnection,
  assertApiKeyWorkspacePathPrincipalCaptured, type ApiKeyWorkspacePathPrincipal, type ApiKeyWorkspacePathPurpose } from '../api-keys/document-read-principal';
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
import { captureWorkspaceOperationApiKeyJobPrincipal, captureWorkspaceOperationApiKeyJobReadPrincipal } from '../workspaces/workspace-operation-api-key-job-principal';
import { workspaceOperationProgrammaticJobOptions } from '../workspaces/workspace-operation-programmatic-job-principal';
import type { WorkspaceContext } from '../workspaces/types';
import { buildWorkspacePathOperationPlan } from './workspace-path-operation-service';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { workspaceOperationMcpBatchId } from './workspace-operation-mcp-authorization';
import { WorkspaceOperationBatchStore, type WorkspaceOperationBatchRecord,
  type WorkspaceOperationProgrammaticClaimResult } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope, WorkspaceOperationBatchExecutionResult,
  WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationNativeMoveBatchPlan, type WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import type { WorkspaceOperationNativeMoveBatchStatus } from './workspace-operation-native-move-status';
import type { WorkspaceOperationNativeDeleteBatchStatus } from './workspace-operation-native-delete-status';
import { readWorkspaceOperationNativePathStatus, lookupWorkspaceOperationNativePathStatus } from './workspace-operation-native-path-status';
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
type KeyPathInvocation=Readonly<{transport:'api-key';kind:'move'|'delete';purpose:ApiKeyWorkspacePathPurpose;principal:ApiKeyWorkspacePathPrincipal}>;
type PathInvocation=WorkspaceOperationMcpJobPrincipal|KeyPathInvocation;
type Authority = Readonly<{ userId: string; clientId: string; sessionId: string;
  tool: 'move_knowledge_source' | 'delete_knowledge_source'; scope: WorkspaceOperationBatchScope }>;
type NativeStatus = Readonly<{ kind: 'move'; value: WorkspaceOperationNativeMoveBatchStatus }>
  | Readonly<{kind:'cohort-delete';value:WorkspaceOperationCohortDeleteStatus}>
  | Readonly<{ kind: 'delete'; value: WorkspaceOperationNativeDeleteBatchStatus | WorkspaceOperationPhysicalDeleteBatchStatusV5 }>;
type ImportHistory = NonNullable<Awaited<ReturnType<typeof readWorkspacePathImportOperationHistory>>>;
type PathLookup=Readonly<{scope:WorkspaceOperationBatchScope;batchId:string;status:NativeStatus|null;history:ImportHistory|null}>;

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

/** Fixed current Key phase. The scope is factual data; the actual opaque
 * principal remains the only input to every later claim and native owner. */
async function captureKeyPathScope(live:KeyPathInvocation,workspaceId:string,operationId?:string,
  expected?:WorkspaceOperationBatchScope):Promise<WorkspaceOperationBatchScope>{
  assertApiKeyWorkspacePathPrincipalCaptured(live.principal,{workspaceId,purpose:live.purpose});
  return executeLifecycleTransaction({openConnection:openDb,execute:async database=>{
    await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
    return withApiKeyWorkspacePathPrincipalOnConnection(database,live.principal,live.purpose,async access=>{
      const workspace:WorkspaceContext=Object.freeze({...access.workspace,permissions:Object.freeze({...access.workspace.permissions}),
        ...(access.workspace.actor?{actor:Object.freeze({...access.workspace.actor})}:{})});
      if(expected&&!isDeepStrictEqual(captureWorkspaceOperationJobScope(workspace),captureWorkspaceOperationJobScope(expected.workspace)))
        throw new WorkspacePathToolError('PATH_SCOPE_CHANGED',operationId);
      await access.assertCurrent();
      return Object.freeze({workspace,fileOptions:Object.freeze({workspace})});
    });
  },recoverCommitted:async(_value,cause)=>{throw Object.assign(new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED',operationId),{cause});}});
}

/** Requests reuse the existing deterministic action identity and native
 * compiler. Neither unsupported legacy plans nor physical imports execute. */
async function buildPathPlan(live: PathInvocation, input: SelectedRequest,
  scope: WorkspaceOperationBatchScope, initial?: Authority): Promise<NativePlan> {
  const plan = await buildWorkspacePathOperationPlan({ scope, kind: live.kind,
    selections: selectedPaths(live.kind, input) });
  const operationId=input.action==='preview'?undefined:input.operationId;
  if('transport' in live)await captureKeyPathScope(live,input.workspaceId,operationId,scope);
  else{if(!initial)throw new WorkspacePathToolError('PATH_SCOPE_CHANGED',operationId);await capturePathAuthority(live,operationId,initial);}
  if (plan.readiness !== 'ready' || (live.kind === 'move' ? plan.version !== 3 : plan.version !== 2 && plan.version !== 5 && plan.version !== 6)) {
    throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED', input.action === 'preview' ? undefined : input.operationId);
  }
  if(plan.version===6){const cohort=decodeWorkspaceOperationCohortDeletePlan(plan);if(!isDeepStrictEqual(cohort.sourceEvidence.workspaceScope,captureWorkspaceOperationJobScope(scope.workspace)))throw new WorkspacePathToolError('PATH_SCOPE_CHANGED');return cohort;}
  if (plan.version === 5) {
    const physical = decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan);
    if (!physical.linkAssessment.complete || physical.linkAssessment.blockers.length || physical.issues.length
      || !isDeepStrictEqual(physical.sourceEvidence.workspaceScope, captureWorkspaceOperationJobScope(scope.workspace))) {
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
    || !isDeepStrictEqual(plan.sourceEvidence.workspaceScope, captureWorkspaceOperationJobScope(scope.workspace))) {
    throw new WorkspacePathToolError('PATH_SCOPE_CHANGED', input.action === 'preview' ? undefined : input.operationId);
  }
  return html ?? plan;
}

async function readPathStatus(live: WorkspaceOperationMcpJobPrincipal,
  batchId: string, scope: WorkspaceOperationBatchScope): Promise<NativeStatus | null> {
  const observation = await readWorkspaceOperationNativePathStatus({ batchId, scope, mcpPrincipal: live });
  return observation?.status ?? null;
}

function assertPathRequest(status: NativeStatus, live: Readonly<{kind:'move'|'delete'}>,
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
  live: PathInvocation, scope: WorkspaceOperationBatchScope, active:()=>void=()=>undefined): Promise<void> {
  const principal='transport' in live?captureWorkspaceOperationApiKeyJobPrincipal(live):live;
  return store.withClaim(batch, async jobClaim => {
    const original = batch.authorization;
    if (original.mode !== 'direct-mcp'&&original.mode!=='api-key'||('transport' in live)!==(original.mode==='api-key')) throw new WorkspacePathToolError('PATH_SCOPE_CHANGED');
    const renewals = createWorkspaceOperationClaimRenewals(store, batch);
    let finishAttempted = false;
    renewals.start();
    try {
      active();
      const result = await withWorkspaceOperationJobClaimScheduling(jobClaim, {
        pauseAndDrain: async () => {
          await renewals.pauseAndDrain();
          if (renewals.hasLeaseLost()) throw new Error('BATCH_LEASE_LOST');
        },
        resume: renewals.resume,
      }, () => executeWorkspaceOperationBatch({ batchId: batch.batchId, plan: batch.plan, scope,
        actorUserId: original.actorUserId, actorDisplayName: original.actorDisplayName,
        actorId: original.actorId, actorType: original.actorType,
        ...(original.mode==='api-key'?{}:{actorSessionId:original.actorSessionId}),
        jobClaim, ...workspaceOperationProgrammaticJobOptions(principal),
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
        failure = Object.assign(new AggregateError([error, views], 'Programmatic file action and view refresh failed.'),
          { code: workspaceOperationBatchErrorCode(error), status: 503 });
      }
      if (!finishAttempted && !renewals.hasLeaseLost()) {
        try {
          finishAttempted = true;
          if (!await store.finishClaim(batch, { status: 'needs_recovery', phase: 'recovery',
            errorCode: workspaceOperationBatchErrorCode(failure) })) throw new Error('BATCH_CLAIM_CHANGED');
        } catch (finalization) {
          throw Object.assign(new AggregateError([failure, finalization], 'Programmatic file action and journal finalization failed.'),
            { code: 'BATCH_CLAIM_COMMIT_UNCONFIRMED', status: 503 });
        }
      }
      throw failure;
    } finally { await renewals.pauseAndDrain(); }
  });
}

/** This shared entry receives only a frozen decoded request and one genuine
 * fixed action handle. It neither reconstructs AuthInfo nor invokes a worker. */
/** Capture one actual historical lookup. MCP import mapping remains its own
 * existing policy; Key operations use only their native operation namespace. */
async function lookupPathState(live:PathInvocation,input:Exclude<Request,{action:'preview'}>,
  initial?:Authority,knownHistory?:ImportHistory|null):Promise<PathLookup>{
  if('transport' in live){
    if(knownHistory)throw new WorkspacePathToolError('PATH_SCOPE_CHANGED',input.operationId);
    const lookup=await lookupWorkspaceOperationNativePathStatus({workspaceId:input.workspaceId,operationId:input.operationId,
      apiKeyPrincipal:captureWorkspaceOperationApiKeyJobReadPrincipal(live)});
    return Object.freeze({...lookup,history:null});
  }
  if(!initial)throw new WorkspacePathToolError('PATH_SCOPE_CHANGED',input.operationId);
  const batchId=workspaceOperationMcpBatchId({userId:initial.userId,clientId:initial.clientId,
    workspaceId:input.workspaceId,tool:initial.tool,operationId:input.operationId});
  const history=knownHistory===undefined?await readWorkspacePathImportOperationHistory({principal:live,operationId:input.operationId,
    ...(input.action==='status'?{}:{expected:{planId:input.planId,request:{kind:live.kind,selections:selectedPaths(live.kind,input)}}})}):knownHistory;
  const status=await readPathStatus(live,batchId,initial.scope);
  return Object.freeze({batchId,scope:initial.scope,status,history});
}

function assertPathStateHistory(status:NativeStatus,history:ImportHistory|null,live:PathInvocation,
  initial:Authority|undefined,operationId:string):void{
  if('transport' in live){if(history)throw new WorkspacePathToolError('PATH_SCOPE_CHANGED',operationId);return;}
  if(!initial)throw new WorkspacePathToolError('PATH_SCOPE_CHANGED',operationId);
  assertPathPreparationHistory(status,history,live,initial,operationId);
}

async function claimPathOperation(store:WorkspaceOperationBatchStore,live:PathInvocation,
  input:Exclude<Request,{action:'preview'|'status'}>,planId:string,plan?:NativePlan):Promise<WorkspaceOperationProgrammaticClaimResult>{
  const command={operationId:input.operationId,workspaceId:input.workspaceId,planId};
  if('transport' in live){
    const writer=captureWorkspaceOperationApiKeyJobPrincipal(live);
    if(!plan)return store.claimExistingApiKeyPath(writer.principal,writer.purpose,command);
    if(live.kind==='move'&&plan.version===3)return store.createApiKeyMoveAndClaim(writer.principal,{operationId:input.operationId,plan});
    if(live.kind==='delete'&&(plan.version===2||plan.version===5||plan.version===6))return store.createApiKeyDeleteAndClaim(writer.principal,{operationId:input.operationId,plan});
  }else{
    if(!plan)return live.kind==='move'?store.claimExistingMcpMove(live.principal,command):store.claimExistingMcpDelete(live.principal,command);
    if(live.kind==='move'&&plan.version===3)return store.createMcpMoveAndClaim(live.principal,{operationId:input.operationId,plan});
    if(live.kind==='delete'&&(plan.version===2||plan.version===5||plan.version===6))return store.createMcpDeleteAndClaim(live.principal,{operationId:input.operationId,plan});
  }
  throw new WorkspacePathToolError('PATH_SCOPE_CHANGED',input.operationId);
}

function assertPathSignal(input:Request,signal?:AbortSignal):void{
  if(signal?.aborted)throw new WorkspacePathToolError(input.action==='apply'||input.action==='recover'
    ?'PATH_OUTCOME_UNCONFIRMED':'PATH_UNAVAILABLE',input.action==='preview'?undefined:input.operationId);
}

/** Shared operational orchestration. Every transport keeps its actual opaque
 * handle; claims, native writers, scheduling and presentation are shared. */
async function runWorkspaceProgrammaticPathService(input:Request,live:PathInvocation,
  signal?:AbortSignal):Promise<DirectMcpWorkspacePathResultV1>{
  const operationId=input.action==='preview'?undefined:input.operationId,active=()=>assertPathSignal(input,signal);
  active();
  if(input.action!=='status'&&!authenticatedNativeTextSessionEnabled())throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED',operationId);
  const initial='transport' in live?undefined:await capturePathAuthority(live,operationId);
  if(input.action==='preview'){
    let scope:WorkspaceOperationBatchScope;
    if('transport' in live)scope=await captureKeyPathScope(live,input.workspaceId);
    else{
      if(!initial)throw new WorkspacePathToolError('PATH_SCOPE_CHANGED');
      scope=initial.scope;
      const preparation=await readWorkspacePathImportPreparationPlan({principal:live,kind:live.kind,selections:selectedPaths(live.kind,input)});
      await capturePathAuthority(live,undefined,initial);
      if(preparation.readiness!=='native-ready')return encodeDirectMcpWorkspacePathResultV1({apiVersion:1,action:'preview',
        preview:preparation.version===6?workspaceOperationMcpCohortDeletePreview(preparation):preparation.version===5?workspaceOperationMcpPhysicalHtmlDeletePreviewV3(preparation)
          :preparation.version===3?workspaceOperationMcpHtmlDeletePreviewV3(preparation):preparation.version===2?workspaceOperationMcpHtmlPreviewV2(preparation):pathImportPreparationPreview(preparation)});
    }
    const plan=await buildPathPlan(live,input,scope,initial);active();
    return encodeDirectMcpWorkspacePathResultV1({apiVersion:1,action:'preview',preview:pathPreview(plan)});
  }
  if(input.action==='status'){
    const state=await lookupPathState(live,input,initial);active();
    if(!state.status)throw new WorkspacePathToolError(state.history?'PATH_OUTCOME_UNCONFIRMED':'PATH_STATUS_NOT_FOUND',input.operationId);
    assertPathStateHistory(state.status,state.history,live,initial,input.operationId);
    return encodeDirectMcpWorkspacePathResultV1({apiVersion:1,action:'status',operation:pathOperation(state.status,input.operationId,state.history)},input.operationId);
  }
  const selection=await withWorkspaceMutationLock(input.workspaceId,async()=>{
    active();
    const state=await lookupPathState(live,input,initial),saved=state.status;
    let history=state.history;
    if(history&&!saved)throw new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED',input.operationId);
    if(saved){assertPathStateHistory(saved,history,live,initial,input.operationId);assertPathRequest(saved,live,input,history);}
    if(!saved&&input.action==='recover')throw new WorkspacePathToolError('PATH_OPERATION_NOT_FOUND',input.operationId);
    const store=new WorkspaceOperationBatchStore();
    let selected:WorkspaceOperationProgrammaticClaimResult;
    if(saved){active();selected=await claimPathOperation(store,live,input,saved.value.batch.planId);}
    else if(!('transport' in live)){
      if(!initial)throw new WorkspacePathToolError('PATH_SCOPE_CHANGED',input.operationId);
      const preparation=await readWorkspacePathImportPreparationPlan({principal:live,kind:live.kind,selections:selectedPaths(live.kind,input)});
      await capturePathAuthority(live,input.operationId,initial);
      if(preparation.readiness==='requires-import-rebinding'){
        if(preparation.planId!==input.planId)throw new WorkspacePathToolError('PATH_PLAN_CHANGED',input.operationId);
        encodeDirectMcpWorkspacePathResultV1({apiVersion:1,action:'preview',preview:pathImportPreparationPreview(preparation)});
        history=await prepareWorkspacePathImportOperation({principal:live,operationId:input.operationId,plan:preparation});
        const prepared=await readPathStatus(live,state.batchId,state.scope);
        if(!prepared)throw new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED',input.operationId);
        assertPathPreparationHistory(prepared,history,live,initial,input.operationId);assertPathRequest(prepared,live,input,history);
        selected=await claimPathOperation(store,live,input,history.record.nativePlan.planId);
      }else{
        if(preparation.readiness!=='native-ready')throw new WorkspacePathToolError('PATH_NATIVE_REQUIRED',input.operationId);
        const plan=await buildPathPlan(live,input,state.scope,initial);
        if(plan.planId!==input.planId)throw new WorkspacePathToolError('PATH_PLAN_CHANGED',input.operationId);
        encodeDirectMcpWorkspacePathResultV1({apiVersion:1,action:'preview',preview:pathPreview(plan)});active();
        selected=await claimPathOperation(store,live,input,plan.planId,plan);
      }
    }else{
      // Original-file import is an explicit, separately granted operation.
      // A Move/Delete key never enters MCP's implicit import preparation.
      const plan=await buildPathPlan(live,input,state.scope);
      if(plan.planId!==input.planId)throw new WorkspacePathToolError('PATH_PLAN_CHANGED',input.operationId);
      encodeDirectMcpWorkspacePathResultV1({apiVersion:1,action:'preview',preview:pathPreview(plan)});active();
      selected=await claimPathOperation(store,live,input,plan.planId,plan);
    }
    if(selected.kind==='absent')throw new WorkspacePathToolError('PATH_OPERATION_NOT_FOUND',input.operationId);
    if(selected.batch.batchId!==state.batchId)throw new WorkspacePathToolError('PATH_SCOPE_CHANGED',input.operationId);
    if(selected.kind==='historical-header'){
      const current=await lookupPathState(live,input,initial,history),confirmed=current.status;
      if(!confirmed||pathExecution(confirmed)?.status!=='applied'||confirmed.value.batch.status!=='applied')throw new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED',input.operationId);
      assertPathStateHistory(confirmed,history,live,initial,input.operationId);assertPathRequest(confirmed,live,input,history);
      invalidateWorkspaceFileViews({fileOptions:current.scope.fileOptions,fullTree:true,mutations:[]});
      return{kind:'historical' as const,result:encodeDirectMcpWorkspacePathResultV1({apiVersion:1,action:input.action,
        operation:pathOperation(confirmed,input.operationId,history),alreadyKnown:true},input.operationId)};
    }
    return{kind:'claimed' as const,store,batch:selected.batch,alreadyKnown:saved!==null,history,scope:state.scope};
  });
  if(selection.kind==='historical')return selection.result;
  // Admission and each native Owner run after the selection kernel closes.
  await executePathClaim(selection.store,selection.batch,live,selection.scope,active);
  const current=await lookupPathState(live,input,initial,selection.history);
  if(!current.status)throw new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED',input.operationId);
  assertPathStateHistory(current.status,selection.history,live,initial,input.operationId);assertPathRequest(current.status,live,input,selection.history);
  return encodeDirectMcpWorkspacePathResultV1({apiVersion:1,action:input.action,
    operation:pathOperation(current.status,input.operationId,selection.history),alreadyKnown:selection.alreadyKnown},input.operationId);
}

/** Retain the existing MCP entry and its actual capture contract. */
async function runDirectMcpWorkspacePathService(input:Request,live:WorkspaceOperationMcpJobPrincipal):Promise<DirectMcpWorkspacePathResultV1>{
  return runWorkspaceProgrammaticPathService(input,live);
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

async function runApiKeyWorkspacePathService(input:Request,credential:ApiKeyCredential,source:'request'|'mcp',
  kind:'move'|'delete',signal?:AbortSignal):Promise<DirectMcpWorkspacePathResultV1>{
  assertPathSignal(input,signal);
  const purpose:ApiKeyWorkspacePathPurpose=`${kind}_${input.action}`;
  return withApiKeyWorkspacePathPrincipal(credential,{workspaceId:input.workspaceId,purpose,source},principal=>
    runWorkspaceProgrammaticPathService(input,Object.freeze({transport:'api-key' as const,kind,purpose,principal}),signal));
}

/** Exclusive actual Key capture. Each public action retains its fixed purpose
 * across the shared planner, claim lifecycle and existing native writers. */
export function runApiKeyWorkspaceMoveService(input:DecodedDirectMcpWorkspaceMoveRequestV1,
  credential:ApiKeyCredential,source:'request'|'mcp',signal?:AbortSignal):Promise<DirectMcpWorkspacePathResultV1>{
  return runApiKeyWorkspacePathService(input,credential,source,'move',signal);
}
export function runApiKeyWorkspaceDeleteService(input:DecodedDirectMcpWorkspaceDeleteRequestV1,
  credential:ApiKeyCredential,source:'request'|'mcp',signal?:AbortSignal):Promise<DirectMcpWorkspacePathResultV1>{
  return runApiKeyWorkspacePathService(input,credential,source,'delete',signal);
}
