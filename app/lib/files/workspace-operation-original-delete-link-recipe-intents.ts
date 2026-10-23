import 'server-only';

import { isDeepStrictEqual as equal } from 'node:util';
import type { NativeLinkMutationRecipe } from '../markdown/workspace-link-contract-v2';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { AnyOriginalDeleteNativeLinkIntent } from './workspace-operation-original-delete-links';

function fail(): never { throw Object.assign(new Error('ORIGINAL_DELETE_UNPROVEN'), { code: 'ORIGINAL_DELETE_UNPROVEN', status: 409 }); }

/** Pure relation only: neither recipes nor a successful comparison grant any
 * authority. Callers must derive recipes from the strict original plan and
 * validate the intent's inspection profile separately. Current owner, scope,
 * SQL and durable mutation checks stay at their existing boundaries. */
export function assertOriginalDeleteNativeLinkRecipeIntents(recipes: readonly NativeLinkMutationRecipe[],
  intents: readonly AnyOriginalDeleteNativeLinkIntent[]): void {
  const documents = [...new Set(recipes.map(recipe => recipe.source.documentId))].sort();
  if (!equal(documents, intents.map(item => item.prepared.source.documentId).sort())) fail();
  for (const item of intents) {
    const selected = recipes.filter(recipe => recipe.source.documentId === item.prepared.source.documentId);
    if (!selected.length || selected.some(recipe => !equal(recipe.source, item.prepared.source)
      || recipe.sourceVersion.stateProof !== item.prepared.before.stateProof
      || recipe.sourceVersion.stateVector !== item.prepared.before.stateVector
      || recipe.sourceVersion.documentSequence !== item.prepared.before.documentSequence)
      || !equal(selected.map(recipe => `${recipe.linkId}:${nativeLinkJsonProof(recipe)}`).sort(),
        item.prepared.inverseRecipes.map(inverse => `${inverse.originalLinkId}:${inverse.authorizedForwardRecipeProof}`).sort())) fail();
  }
}
