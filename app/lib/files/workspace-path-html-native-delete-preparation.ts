import 'server-only';

import { isDeepStrictEqual as equal, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceMixedHtmlFileOperationPlanV5 } from '../markdown/workspace-native-file-operation-planner';
import type { FilePlanV5 } from '../markdown/workspace-link-contract-v5';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationMixedSourceEvidenceV5, decodeWorkspaceOperationMixedSourceEvidenceV5,
  type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';

type Request = Readonly<{ kind: 'delete'; selections: readonly Readonly<{ sourcePath: string }>[] }>;
/** New read-only routing profile. It never imports or installs durable state. */
export type WorkspacePathHtmlNativeDeletePreparationPlanV3 = Readonly<{
  version: 3; kind: 'native-path-import-preparation'; executionReady: false; readiness: 'native-ready' | 'blocked';
  scope: WorkspaceOperationJobScope; request: Request; sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5;
  pathMappings: FilePlanV5['pathMappings']; issues: FilePlanV5['issues']; coverage: WorkspaceOperationMixedSourceEvidenceV5['coverage'];
  linkAssessment: FilePlanV5['htmlAssessment'];
  requiredRawImports: readonly Readonly<{ path: string; reasons: readonly ('selected' | 'link-change')[] }>[];
  planId: string; integrityProof: string;
}>;
function fail(): never { throw Object.assign(new Error('PATH_HTML_PREPARATION_INVALID'), { code: 'PATH_HTML_PREPARATION_INVALID', status: 409 }); }
function capture(input: unknown): unknown { return captureWorkspaceOperationNativePlanData(input, fail, 16 * 1024 * 1024); }
function record(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== names.length) fail();
  const result: Record<string, unknown> = {};
  for (const key of names) { const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(); result[key] = descriptor.value; }
  return result;
}
function selected(input: unknown): Request {
  const value = record(capture(input), ['kind','selections']);
  if (value.kind !== 'delete' || !Array.isArray(value.selections) || value.selections.length !== 1) fail();
  const selection = record(value.selections[0], ['sourcePath']);
  if (typeof selection.sourcePath !== 'string' || !isCanonicalAdmissionPath(selection.sourcePath)
    || selection.sourcePath.length > 4096 || selection.sourcePath.split('/').length > 33) fail();
  return { kind: 'delete', selections: [{ sourcePath: selection.sourcePath }] };
}
function freeze<T>(input: T): T { if (input && typeof input === 'object') {
  for (const child of Object.values(input)) freeze(child); Object.freeze(input); } return input; }
function build(scope: WorkspaceOperationJobScope, request: Request, sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5
): WorkspacePathHtmlNativeDeletePreparationPlanV3 {
  if (!equal(scope, sourceEvidence.workspaceScope) || scope.legacy) fail();
  const plan = createWorkspaceMixedHtmlFileOperationPlanV5({ kind: 'delete', sourceWorkspaceId: scope.workspaceId,
    destinationWorkspaceId: scope.workspaceId, selections: request.selections.map(selection => ({ ...selection })), sourceEvidence });
  const sourcePath = request.selections[0].sourcePath, node = sourceEvidence.namespace.find(entry => entry.path === sourcePath);
  const target = sourceEvidence.nativeComponent.nativeBindings.find(item => item.expected.path === sourcePath);
  const issues = structuredClone(plan.issues);
  if (!node || node.kind !== 'file' || !target || node.documentId !== target.expected.documentId || !/\.(?:md|markdown)$/iu.test(sourcePath)) {
    issues.push({ code: 'unsupported-native-delete-selection', workspaceId: scope.workspaceId, path: sourcePath });
  }
  const requirements = new Map<string, Set<'selected' | 'link-change'>>();
  for (const source of sourceEvidence.physicalSources4) {
    if (source.path === sourcePath) requirements.set(source.path, new Set(['selected']));
    if (plan.issues.some(issue => issue.code === 'physical-source-import-required' && issue.path === source.path)) {
      const reasons = requirements.get(source.path) ?? new Set<'selected' | 'link-change'>();
      reasons.add(source.path === sourcePath ? 'selected' : 'link-change'); requirements.set(source.path, reasons);
    }
  }
  const requiredRawImports = [...requirements].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path,reasons]) => ({ path, reasons: (['selected','link-change'] as const).filter(reason => reasons.has(reason)) }));
  const body = { version: 3 as const, kind: 'native-path-import-preparation' as const, executionReady: false as const,
    readiness: plan.readiness === 'ready' && !issues.length && plan.htmlAssessment.complete && !requiredRawImports.length
      ? 'native-ready' as const : 'blocked' as const,
    scope, request, sourceEvidence, pathMappings: plan.pathMappings, issues, coverage: sourceEvidence.coverage,
    linkAssessment: plan.htmlAssessment, requiredRawImports };
  const planId = proof({ version: 3, scope, request, sourceSemanticProof: sourceEvidence.semanticProof,
    htmlAssessmentProof: plan.htmlAssessmentProof, readiness: body.readiness, issues, requiredRawImports });
  return freeze({ ...body, planId, integrityProof: proof({ integrityVersion: 3, ...body, planId }) });
}
export function createWorkspacePathHtmlNativeDeletePreparationPlanV3(input: {
  scope: WorkspaceOperationJobScope; kind: 'delete'; selections: readonly Readonly<{ sourcePath: string }>[];
  observation: WorkspaceLinkSourceAuthorityObservation;
}): WorkspacePathHtmlNativeDeletePreparationPlanV3 {
  const values = record(input, ['scope','kind','selections','observation']);
  const scope = parseWorkspaceOperationJobScope(values.scope), request = selected({ kind: values.kind, selections: values.selections });
  return build(scope, request, captureWorkspaceOperationMixedSourceEvidenceV5(scope, values.observation as WorkspaceLinkSourceAuthorityObservation));
}
export function decodeWorkspacePathHtmlNativeDeletePreparationPlanV3(input: unknown): WorkspacePathHtmlNativeDeletePreparationPlanV3 {
  const row = record(capture(input), ['version','kind','executionReady','readiness','scope','request','sourceEvidence','pathMappings',
    'issues','coverage','linkAssessment','requiredRawImports','planId','integrityProof']);
  if (row.version !== 3 || row.kind !== 'native-path-import-preparation' || row.executionReady !== false) fail();
  const rebuilt = build(parseWorkspaceOperationJobScope(row.scope), selected(row.request), decodeWorkspaceOperationMixedSourceEvidenceV5(row.sourceEvidence));
  if (!equal(rebuilt, row)) fail(); return rebuilt;
}
