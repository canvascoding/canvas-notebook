import 'server-only';

import { isDeepStrictEqual as equal, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { createWorkspaceMixedHtmlFileOperationPlanV5 } from '../markdown/workspace-native-file-operation-planner';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import type { FilePlanV5 } from '../markdown/workspace-link-contract-v5';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationMixedSourceEvidenceV5, decodeWorkspaceOperationMixedSourceEvidenceV5,
  type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';

type Selection = Readonly<{ sourcePath: string; destinationPath: string }>;
type Request = Readonly<{ kind: 'move' | 'rename'; selections: readonly Selection[] }>;
type RawRequirement = Readonly<{ path: string; reasons: readonly ('selected' | 'link-change')[] }>;

/** Read-only early routing facts. This version never imports, installs a
 * preparation record or grants execution authority. Required raw imports stay
 * blocked until their own versioned import/rebinding path is available. */
export type WorkspacePathHtmlNoImportPreparationPlanV2 = Readonly<{
  version: 2; kind: 'native-path-import-preparation'; executionReady: false;
  readiness: 'native-ready' | 'blocked'; scope: WorkspaceOperationJobScope; request: Request;
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5; pathMappings: FilePlanV5['pathMappings'];
  issues: FilePlanV5['issues']; coverage: WorkspaceOperationMixedSourceEvidenceV5['coverage'];
  linkAssessment: FilePlanV5['htmlAssessment']; requiredRawImports: readonly RawRequirement[];
  planId: string; integrityProof: string;
}>;

export class WorkspacePathHtmlNoImportPreparationError extends Error {
  readonly status: 409 | 413;
  constructor(readonly code: 'PATH_HTML_PREPARATION_INVALID' | 'PATH_HTML_PREPARATION_TOO_LARGE') {
    super(code); this.name = 'WorkspacePathHtmlNoImportPreparationError';
    this.status = code === 'PATH_HTML_PREPARATION_TOO_LARGE' ? 413 : 409;
  }
}
function fail(reason: 'invalid' | 'too-large' = 'invalid'): never {
  throw new WorkspacePathHtmlNoImportPreparationError(reason === 'too-large'
    ? 'PATH_HTML_PREPARATION_TOO_LARGE' : 'PATH_HTML_PREPARATION_INVALID');
}
function capture<T>(value: unknown): T {
  return captureWorkspaceOperationNativePlanData(value, fail, 16 * 1024 * 1024) as T;
}
function own(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail(); result[key] = descriptor.value;
  }
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function request(input: unknown): Request {
  const value = own(capture(input), ['kind', 'selections']);
  if (value.kind !== 'move' && value.kind !== 'rename' || !Array.isArray(value.selections)
    || !value.selections.length || value.selections.length > 1000) return fail();
  const selections = value.selections.map(item => {
    const selection = own(item, ['sourcePath', 'destinationPath']);
    for (const file of Object.values(selection)) {
      if (typeof file !== 'string' || !isCanonicalAdmissionPath(file) || Buffer.byteLength(file) > 4096
        || file.split('/').length > 33 || Buffer.from(file).toString('utf8') !== file) return fail();
    }
    return selection as Selection;
  });
  return { kind: value.kind, selections };
}

/** A genuine capture and historical decoding share one deterministic graph
 * rehearsal. Decoding verifies facts only; Current/principal/FD guards remain
 * with the ordinary public plan and its actual execution owner. */
function build(scope: WorkspaceOperationJobScope, selected: Request,
  evidence: WorkspaceOperationMixedSourceEvidenceV5): WorkspacePathHtmlNoImportPreparationPlanV2 {
  if (!equal(scope, evidence.workspaceScope)) return fail();
  const plan = createWorkspaceMixedHtmlFileOperationPlanV5({ kind: selected.kind, sourceWorkspaceId: scope.workspaceId,
    destinationWorkspaceId: scope.workspaceId, selections: selected.selections.map(item => ({ ...item })), sourceEvidence: evidence });
  const requirements = new Map<string, Set<'selected' | 'link-change'>>();
  const add = (file: string, reason: 'selected' | 'link-change') => {
    const reasons = requirements.get(file) ?? new Set<'selected' | 'link-change'>(); reasons.add(reason); requirements.set(file, reasons);
  };
  // Selected Markdown needs a real native import even with zero ordinary
  // links. Do not infer its absence from recipe count or current HTML safety.
  for (const source of evidence.physicalSources4) {
    if (selected.selections.some(item => source.path === item.sourcePath || source.path.startsWith(`${item.sourcePath}/`))) {
      add(source.path, 'selected');
    }
  }
  for (const issue of plan.issues) {
    if (issue.code === 'physical-source-import-required' && evidence.physicalSources4.some(source => source.path === issue.path)) {
      add(issue.path, issue.linkId ? 'link-change' : 'selected');
    }
  }
  const requiredRawImports: RawRequirement[] = [...requirements].sort(([a], [b]) => a.localeCompare(b)).map(([file, reasons]) => ({
    path: file, reasons: (['selected', 'link-change'] as const).filter(reason => reasons.has(reason)),
  }));
  const body = { version: 2 as const, kind: 'native-path-import-preparation' as const, executionReady: false as const,
    readiness: plan.readiness === 'ready' && !plan.issues.length && plan.htmlAssessment.complete && !requiredRawImports.length
      ? 'native-ready' as const : 'blocked' as const,
    scope, request: selected, sourceEvidence: evidence, pathMappings: plan.pathMappings, issues: plan.issues,
    coverage: evidence.coverage, linkAssessment: plan.htmlAssessment, requiredRawImports };
  const bounded = capture<typeof body>(body);
  const planId = proof({ ...bounded, sourceEvidence: evidence.semanticProof });
  return freeze(capture({ ...bounded, planId, integrityProof: proof({ ...bounded, planId }) }));
}

/** Same actual collector3/native2 observation; parser4 and HTML facts are
 * derived by Evidence5. No second filesystem read or invented Evidence3. */
export function createWorkspacePathHtmlNoImportPreparationPlanV2(input: {
  scope: WorkspaceOperationJobScope; kind: 'move' | 'rename';
  selections: Array<{ sourcePath: string; destinationPath: string }>; observation: WorkspaceLinkSourceAuthorityObservation;
}): WorkspacePathHtmlNoImportPreparationPlanV2 {
  const value = own(input, ['scope', 'kind', 'selections', 'observation']);
  const scope = parseWorkspaceOperationJobScope(capture(value.scope));
  const selected = request({ kind: value.kind, selections: value.selections });
  const evidence = captureWorkspaceOperationMixedSourceEvidenceV5(scope, value.observation as WorkspaceLinkSourceAuthorityObservation);
  return build(scope, selected, evidence);
}

/** Bounded historical facts only. A forged readiness, issue list, raw-import
 * omission, coverage or HTML assessment cannot be saved by rehashing it. */
export function decodeWorkspacePathHtmlNoImportPreparationPlanV2(input: unknown): WorkspacePathHtmlNoImportPreparationPlanV2 {
  const value = own(capture(input), ['version', 'kind', 'executionReady', 'readiness', 'scope', 'request', 'sourceEvidence',
    'pathMappings', 'issues', 'coverage', 'linkAssessment', 'requiredRawImports', 'planId', 'integrityProof']);
  if (value.version !== 2 || value.kind !== 'native-path-import-preparation' || value.executionReady !== false) return fail();
  const scope = parseWorkspaceOperationJobScope(value.scope), selected = request(value.request);
  const evidence = decodeWorkspaceOperationMixedSourceEvidenceV5(value.sourceEvidence);
  const rebuilt = build(scope, selected, evidence);
  if (!equal(value, rebuilt)) return fail(); return rebuilt;
}
