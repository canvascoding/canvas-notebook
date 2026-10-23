import 'server-only';
import { isDeepStrictEqual as equal } from 'node:util';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { decodeWorkspaceOperationPhysicalDeleteBatchPlanV5, getWorkspaceOperationPhysicalDeleteLinkRecipesV5,
  type WorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import type { OriginalDeleteNativeLinkIntentV4 } from './workspace-operation-original-delete-html-links';
function fail(): never { throw Object.assign(new Error('ORIGINAL_DELETE_UNPROVEN'), { code: 'ORIGINAL_DELETE_UNPROVEN', status: 409 }); }
/** Original recipe equality only. Actual private Yjs bytes, prepared profile4
 * decoding, current authority and SQL persistence stay mandatory elsewhere. */
export function assertOriginalPhysicalDeleteLinkPlanV5(plan: WorkspaceOperationPhysicalDeleteBatchPlanV5,
  intents: readonly OriginalDeleteNativeLinkIntentV4[]): void {
  const decoded = decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan), recipes = getWorkspaceOperationPhysicalDeleteLinkRecipesV5(decoded);
  if (!Array.isArray(intents) || intents.some(item => item.prepared.contractVersion !== 4 || item.prepared.parserVersion !== 4)) fail();
  const documents = [...new Set(recipes.map(recipe => recipe.source.documentId))].sort();
  if (!equal(documents, intents.map(item => item.prepared.source.documentId).sort())) fail();
  for (const item of intents) {
    const selected = recipes.filter(recipe => recipe.source.documentId === item.prepared.source.documentId);
    if (!selected.length || selected.some(recipe => !equal(recipe.source, item.prepared.source)
      || recipe.sourceVersion.stateProof !== item.prepared.before.stateProof
      || recipe.sourceVersion.stateVector !== item.prepared.before.stateVector
      || recipe.sourceVersion.documentSequence !== item.prepared.before.documentSequence)
      || !equal(selected.map(recipe => `${recipe.linkId}:${proof(recipe)}`).sort(),
        item.prepared.inverseRecipes.map((inverse: OriginalDeleteNativeLinkIntentV4['prepared']['inverseRecipes'][number]) => `${inverse.originalLinkId}:${inverse.authorizedForwardRecipeProof}`).sort())) fail();
  }
}
