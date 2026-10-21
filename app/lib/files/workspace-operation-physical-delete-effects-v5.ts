import type { WorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import type { AnyOriginalDeleteNativeLinkReceipt } from './workspace-operation-original-delete-links';

export type WorkspaceOperationPhysicalDeleteEffectV5 = Readonly<{
  documentId: string; path: string; updatedLinks: number;
}>;
type ExpectedEffect = WorkspaceOperationPhysicalDeleteEffectV5 & { linkIds: string[] };
type Completion = Readonly<{ version: number; native?: unknown; nativeLinks?: readonly AnyOriginalDeleteNativeLinkReceipt[] }>;
const unavailable = (): never => { throw new Error('BATCH_JOURNAL_UNAVAILABLE'); };
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const canonicalPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && !value.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(value)
  && !value.split('/').some(segment => !segment || segment === '.' || segment === '..');

/** Presentation/counting facts from an already decoded plan, never authority. */
function expectedEffects(plan: WorkspaceOperationPhysicalDeleteBatchPlanV5): ExpectedEffect[] {
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
      || entry.path === plan.physicalTarget.path) return unavailable();
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

export function workspaceOperationPhysicalDeleteEffectsV5(plan: WorkspaceOperationPhysicalDeleteBatchPlanV5): readonly WorkspaceOperationPhysicalDeleteEffectV5[] {
  return Object.freeze(expectedEffects(plan).map(({ documentId, path, updatedLinks }) => Object.freeze({ documentId, path, updatedLinks })));
}

/** Checked SQL completion supplies applied rows. A graph intent alone cannot
 * acknowledge a write, and old no-link receipts never complete new link work. */
export function workspaceOperationPhysicalDeleteAppliedEffectsV5(plan: WorkspaceOperationPhysicalDeleteBatchPlanV5,
  completion: Completion): readonly WorkspaceOperationPhysicalDeleteEffectV5[] {
  const expected = expectedEffects(plan);
  if (completion.version !== 7 || completion.native !== null || !Array.isArray(completion.nativeLinks)
    || completion.nativeLinks.length !== expected.length) return unavailable();
  const receipts = new Map<string, AnyOriginalDeleteNativeLinkReceipt>(), paths = new Set<string>(), operations = new Set<string>();
  for (const receipt of completion.nativeLinks) {
    if (!receipt || typeof receipt.operationId !== 'string' || !receipt.operationId || !receipt.source
      || receipt.source.workspaceId !== plan.workspaceId || receipts.has(receipt.source.documentId)
      || paths.has(receipt.source.path) || operations.has(receipt.operationId) || !Array.isArray(receipt.inverseRecipes)) return unavailable();
    if (receipt.resultEvidenceVersion !== 4 || !('parserVersion' in receipt)
      || receipt.parserVersion !== 4 || !/^[a-f0-9]{64}$/u.test(receipt.htmlSourceProof)) return unavailable();
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
