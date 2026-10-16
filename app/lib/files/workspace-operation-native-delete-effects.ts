import type { WorkspaceOperationBatchPlan, WorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-batch-contract';
import type { OriginalDeleteNativeLinkReceipt } from './workspace-operation-original-delete-links';

export type WorkspaceOperationNativeDeleteEffect = Readonly<{
  documentId: string; path: string; updatedLinks: number;
}>;
type ExpectedEffect = WorkspaceOperationNativeDeleteEffect & { linkIds: string[] };
type Completion = Readonly<{ version: 1 | 2; nativeLinks?: readonly OriginalDeleteNativeLinkReceipt[] }>;
const unavailable = (): never => { throw new Error('BATCH_JOURNAL_UNAVAILABLE'); };
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const canonicalPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && !value.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(value)
  && !value.split('/').some(segment => !segment || segment === '.' || segment === '..');

/** Presentation/counting facts from an already decoded plan, never authority. */
function expectedEffects(plan: WorkspaceOperationNativeDeleteBatchPlan): ExpectedEffect[] {
  const graph = plan.nativeGraphPlan;
  if (!graph || !Array.isArray(graph.steps) || graph.steps.length !== 1 || !Array.isArray(graph.steps[0].linkIntents)
    || !Array.isArray(graph.finalNamespace)) return unavailable();
  const effects = new Map<string, ExpectedEffect>(), paths = new Set<string>(), linkKeys = new Set<string>();
  for (const intent of graph.steps[0].linkIntents) {
    if (intent.action !== 'unlink' || intent.nextValue !== null || typeof intent.originEvidenceLinkId !== 'string'
      || !intent.originEvidenceLinkId || typeof intent.virtualLinkKey !== 'string' || !intent.virtualLinkKey
      || linkKeys.has(intent.virtualLinkKey)) return unavailable();
    linkKeys.add(intent.virtualLinkKey);
    const matches = graph.finalNamespace.filter(entry => entry.entityKey === intent.entityKey);
    if (matches.length !== 1) return unavailable();
    const entry = matches[0], binding = entry.binding;
    if (entry.workspaceId !== plan.workspaceId || entry.kind !== 'file' || !canonicalPath(entry.path)
      || binding.kind !== 'existing' || !binding.documentEvidenceKey
      || binding.namespaceEvidence.workspaceId !== plan.workspaceId || binding.namespaceEvidence.path !== entry.path
      || typeof binding.namespaceEvidence.documentId !== 'string' || !binding.namespaceEvidence.documentId
      || binding.namespaceEvidence.documentId === plan.nativeTarget.documentId || entry.path === plan.nativeTarget.path) return unavailable();
    const documentId = binding.namespaceEvidence.documentId, prior = effects.get(documentId);
    if (prior) {
      if (prior.path !== entry.path || prior.linkIds.includes(intent.originEvidenceLinkId)) return unavailable();
      prior.linkIds.push(intent.originEvidenceLinkId);
      effects.set(documentId, { ...prior, updatedLinks: prior.linkIds.length });
    } else {
      if (paths.has(entry.path)) return unavailable();
      paths.add(entry.path);
      effects.set(documentId, { documentId, path: entry.path, updatedLinks: 1, linkIds: [intent.originEvidenceLinkId] });
    }
  }
  return [...effects.values()].sort((left, right) => compare(left.path, right.path));
}

export function workspaceOperationNativeDeleteEffects(plan: WorkspaceOperationNativeDeleteBatchPlan): readonly WorkspaceOperationNativeDeleteEffect[] {
  return Object.freeze(expectedEffects(plan).map(({ documentId, path, updatedLinks }) => Object.freeze({ documentId, path, updatedLinks })));
}

/** V1 retains its original count; native source documents are real link steps. */
export function workspaceOperationBatchTotalActions(plan: WorkspaceOperationBatchPlan): number {
  if (plan.version === 2) return 1 + workspaceOperationNativeDeleteEffects(plan).length;
  if (plan.version === 3) return plan.pathSteps.length
    + new Set(plan.nativePathPlan.mutations.map(recipe => recipe.source.documentId)).size;
  return plan.pathSteps.length + plan.previewContents.length;
}

/** Checked SQL completion supplies applied rows. A graph intent alone cannot
 * acknowledge a write, and old no-link receipts never complete new link work. */
export function workspaceOperationNativeDeleteAppliedEffects(plan: WorkspaceOperationNativeDeleteBatchPlan,
  completion: Completion): readonly WorkspaceOperationNativeDeleteEffect[] {
  const expected = expectedEffects(plan);
  if (completion.version === 1) {
    if (expected.length || completion.nativeLinks !== undefined) return unavailable();
    return [];
  }
  if (completion.version !== 2 || !Array.isArray(completion.nativeLinks)
    || completion.nativeLinks.length !== expected.length) return unavailable();
  const receipts = new Map<string, OriginalDeleteNativeLinkReceipt>(), paths = new Set<string>(), operations = new Set<string>();
  for (const receipt of completion.nativeLinks) {
    if (!receipt || typeof receipt.operationId !== 'string' || !receipt.operationId || !receipt.source
      || receipt.source.workspaceId !== plan.workspaceId || receipts.has(receipt.source.documentId)
      || paths.has(receipt.source.path) || operations.has(receipt.operationId) || !Array.isArray(receipt.inverseRecipes)) return unavailable();
    receipts.set(receipt.source.documentId, receipt); paths.add(receipt.source.path); operations.add(receipt.operationId);
  }
  return Object.freeze(expected.map(effect => {
    const receipt = receipts.get(effect.documentId);
    if (!receipt || receipt.source.path !== effect.path || receipt.inverseRecipes.length !== effect.updatedLinks
      || receipt.inverseRecipes.some(inverse => !inverse || !inverse.source || inverse.source.documentId !== effect.documentId
        || inverse.source.path !== effect.path || inverse.source.workspaceId !== plan.workspaceId)
      || receipt.inverseRecipes.map(inverse => inverse.originalLinkId).sort(compare)
        .some((linkId, index) => linkId !== [...effect.linkIds].sort(compare)[index])) return unavailable();
    return Object.freeze({ documentId: effect.documentId, path: receipt.source.path, updatedLinks: receipt.inverseRecipes.length });
  }));
}
