import type { OpenedDocumentAuthScope } from '../collaboration/opened-document-registry';
import type { WorkspacePathOperationPreviewPublic } from './workspace-path-operation-preview';

export type WorkspacePathOperationPreviewBinding = Readonly<{
  workspaceId: string; sourcePath: string; destinationPath: string; authScope: OpenedDocumentAuthScope;
}>;
type Coverage = WorkspacePathOperationPreviewPublic['coverage'];
type Assessment = NonNullable<WorkspacePathOperationPreviewPublic['linkAssessment']>;
type ImportPlan = Extract<WorkspacePathOperationPreviewPublic, { kind: 'native-path-import-preparation' }>;
type Diagnostics = { planId: string; readiness: 'blocked'; coverage: Coverage;
  issues: Array<{ code: string; path: string }> };

/** Display facts only: this is neither an executable plan nor a batch receipt. */
export type WorkspacePathOperationBlockedPreview = Readonly<{
  binding: WorkspacePathOperationPreviewBinding; dryRun: true; requiresRevalidation: true;
  plan: Diagnostics & ({ kind: 'rename'; linkAssessment?: Assessment }
    | { kind: 'native-path-import-preparation'; imports: ImportPlan['imports'];
      physicalLinkChanges: ImportPlan['physicalLinkChanges']; linkAssessment?: Assessment });
}>;

function previewRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid preview record');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length > 64) throw new Error('Preview record is too large');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    if (!descriptor || !('value' in descriptor)) throw new Error('Invalid preview property');
    result[key as string] = descriptor.value;
  }
  return result;
}

function previewList(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error('Invalid preview list');
  const descriptors = Object.getOwnPropertyDescriptors(value as object), length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 1000
    || Reflect.ownKeys(descriptors).length !== length + 1) throw new Error('Invalid preview list size');
  return Array.from({ length }, (_, index) => {
    const item = descriptors[String(index)];
    if (!item || !('value' in item)) throw new Error('Invalid preview list item');
    return item.value;
  });
}

function previewText(value: unknown, budget: { remaining: number }, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('Invalid preview text');
  encodeURIComponent(value); // Reject unpaired surrogates without changing text.
  budget.remaining -= value.length;
  if (budget.remaining < 0) throw new Error('Preview display budget exceeded');
  return value;
}

function previewPath(value: unknown, budget: { remaining: number }, allowEmpty = false): string {
  const text = previewText(value, budget);
  if (allowEmpty && (text === '' || text === '.')) return text;
  if (!text || text.startsWith('/') || text.includes('\\') || text.split('/').some(part => !part || part === '.' || part === '..')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(text)) throw new Error('Invalid preview path');
  return text;
}

/** Project only bounded public display fields; unknown/private fields are not retained. */
export function readWorkspacePathOperationBlockedPreview(value: unknown,
  binding: WorkspacePathOperationPreviewBinding): WorkspacePathOperationBlockedPreview {
  try {
    const budget = { remaining: 1024 * 1024 };
    const scope = { workspaceId: previewText(binding.workspaceId, budget),
      sourcePath: previewPath(binding.sourcePath, budget), destinationPath: previewPath(binding.destinationPath, budget),
      authScope: binding.authScope };
    if (!scope.workspaceId.trim() || !scope.authScope) throw new Error('Missing preview scope');
    const response = previewRecord(value), plan = previewRecord(response.plan);
    if (response.dryRun !== true || response.requiresRevalidation !== true || plan.readiness !== 'blocked'
      || typeof plan.planId !== 'string' || !/^[a-f0-9]{64}$/u.test(plan.planId)) throw new Error('Invalid blocked preview');
    let workspaceBound = false;
    const workspace = (value: unknown) => {
      if (previewText(value, budget) !== scope.workspaceId) throw new Error('Foreign preview workspace');
      workspaceBound = true;
    };
    const resolveStatus = (value: unknown, resolved = false) => {
      if (typeof value !== 'string' || !['missing', 'ambiguous', 'outside-workspace', 'external', 'anchor-only',
        'not-evaluated', 'omitted', ...(resolved ? ['resolved'] : [])].includes(value)) throw new Error('Invalid link status');
      return value as Assessment['blockers'][number]['status'];
    };
    const sourceCoverage = previewRecord(plan.coverage);
    if (typeof sourceCoverage.complete !== 'boolean') throw new Error('Invalid preview coverage');
    const coverage: Coverage = { complete: sourceCoverage.complete,
      omittedSources: previewList(sourceCoverage.omittedSources).map(value => {
        const item = previewRecord(value), reason = item.reason;
        if (reason !== 'source-too-large' && reason !== 'source-unreadable' && reason !== 'target-unreadable'
          && reason !== 'permission-denied') throw new Error('Invalid omission reason');
        return { path: previewPath(item.path, budget), reason };
      }),
      unresolvedLinks: previewList(sourceCoverage.unresolvedLinks).map(value => {
        const item = previewRecord(value), status = resolveStatus(item.status);
        if (status === 'resolved') throw new Error('Invalid unresolved link');
        return { sourcePath: previewPath(item.sourcePath, budget), targetLiteral: previewText(item.targetLiteral, budget, 131104), status };
      }) };
    const issues = previewList(plan.issues).map(value => {
      const issue = previewRecord(value), code = previewText(issue.code, budget, 100);
      if (!/^[a-z][a-z0-9-]{0,99}$/u.test(code)) throw new Error('Invalid preview issue');
      if (issue.workspaceId !== undefined) workspace(issue.workspaceId);
      return { code, path: previewPath(issue.path, budget, true) };
    });
    const common: Diagnostics = { planId: plan.planId, readiness: 'blocked', coverage, issues };
    const readAssessment = (value: unknown): Assessment | undefined => {
      if (value === undefined) return undefined;
      const assessment = previewRecord(value);
      if (assessment.version !== 1 || typeof assessment.complete !== 'boolean') throw new Error('Invalid link assessment');
      const entry = (value: unknown) => {
        const item = previewRecord(value);
        if (item.workspaceId !== undefined) workspace(item.workspaceId);
        if (item.line !== undefined && (!Number.isSafeInteger(item.line) || Number(item.line) <= 0)) throw new Error('Invalid issue line');
        return { sourcePath: previewPath(item.sourcePath, budget), targetLiteral: previewText(item.targetLiteral, budget, 131104),
          ...(item.line === undefined ? {} : { line: Number(item.line) }) };
      };
      return { version: 1, complete: assessment.complete,
        blockers: previewList(assessment.blockers).map(value => {
          const item = previewRecord(value), reason = item.reason;
          if (reason !== 'affected-unresolved-link' && reason !== 'uninspected-source' && reason !== 'unevaluated-link'
            && reason !== 'affected-html-link' && reason !== 'resolution-changed') throw new Error('Invalid link blocker');
          return { ...entry(value), status: resolveStatus(item.status, true), reason };
        }),
        warnings: previewList(assessment.warnings).map(value => {
          const item = previewRecord(value), reason = item.reason, status = resolveStatus(item.status);
          if (reason !== 'unaffected-existing-link' && reason !== 'unaffected-explicit-html-link' || status === 'resolved') {
            throw new Error('Invalid link warning');
          }
          return { ...entry(value), status, reason };
        }) };
    };
    if (plan.kind === 'native-path-import-preparation') {
      if (plan.version !== 1 && plan.version !== 2 || plan.executionReady !== false || previewList(plan.linkEdits).length
        || (plan.version === 1 ? plan.linkAssessment !== undefined : plan.linkAssessment === undefined)) throw new Error('Invalid import preview');
      workspace(plan.workspaceId);
      for (const value of previewList(plan.pathMappings)) {
        const item = previewRecord(value), sourcePath = previewPath(item.sourcePath, budget);
        if (sourcePath !== scope.sourcePath && !sourcePath.startsWith(`${scope.sourcePath}/`)
          || previewPath(item.destinationPath, budget) !== `${scope.destinationPath}${sourcePath.slice(scope.sourcePath.length)}`) {
          throw new Error('Foreign preview selection');
        }
      }
      const imports = previewList(plan.imports).map(value => {
        const item = previewRecord(value);
        return { path: previewPath(item.path, budget), reasons: previewList(item.reasons).map(value => {
          if (value !== 'selected' && value !== 'link-change') throw new Error('Invalid import reason');
          return value;
        }) };
      });
      const physicalLinkChanges = previewList(plan.physicalLinkChanges).map((value): ImportPlan['physicalLinkChanges'][number] => {
        const item = previewRecord(value), action = item.action;
        if (action !== 'rewrite' && action !== 'unlink' || action === 'unlink' && item.targetPathAfter !== null
          || action === 'rewrite' && typeof item.targetPathAfter !== 'string') throw new Error('Invalid import link change');
        return { sourcePathBefore: previewPath(item.sourcePathBefore, budget), sourcePathAfter: previewPath(item.sourcePathAfter, budget),
          previousTargetLiteral: previewText(item.previousTargetLiteral, budget, 131104),
          targetPathAfter: item.targetPathAfter === null ? null : previewPath(item.targetPathAfter, budget), action };
      });
      if (plan.version === 2 && physicalLinkChanges.length) throw new Error('Invalid no-import preview');
      const linkAssessment = readAssessment(plan.linkAssessment);
      return { binding: scope, dryRun: true, requiresRevalidation: true,
        plan: { ...common, kind: 'native-path-import-preparation', imports, physicalLinkChanges,
          ...(linkAssessment ? { linkAssessment } : {}) } };
    }
    if (plan.contractVersion !== 1 || plan.kind !== 'rename' || plan.status !== 'planned') throw new Error('Invalid rename preview');
    for (const value of previewList(plan.pathMappings)) {
      const item = previewRecord(value); workspace(item.sourceWorkspaceId); workspace(item.destinationWorkspaceId);
      const sourcePath = previewPath(item.sourcePath, budget);
      if (sourcePath !== scope.sourcePath && !sourcePath.startsWith(`${scope.sourcePath}/`)
        || previewPath(item.destinationPath, budget) !== `${scope.destinationPath}${sourcePath.slice(scope.sourcePath.length)}`) {
        throw new Error('Foreign preview selection');
      }
    }
    const linkAssessment = readAssessment(plan.linkAssessment);
    if (!workspaceBound) throw new Error('Unbound preview workspace');
    return { binding: scope, dryRun: true, requiresRevalidation: true,
      plan: { ...common, kind: 'rename', ...(linkAssessment ? { linkAssessment } : {}) } };
  } catch { throw new Error('Invalid file action preview response'); }
}

export class WorkspacePathOperationPreviewError extends Error {
  readonly code = 'PREVIEW_BLOCKED';
  readonly preview: WorkspacePathOperationBlockedPreview;
  constructor(value: unknown, binding: WorkspacePathOperationPreviewBinding) {
    super('The file action is blocked. Inspect the listed paths and check again.');
    this.name = 'WorkspacePathOperationPreviewError';
    this.preview = readWorkspacePathOperationBlockedPreview(value, binding);
  }
}
