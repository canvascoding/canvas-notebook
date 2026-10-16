import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import type { JSONContent } from '@tiptap/core';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { NativeCopyDocumentReceipt } from '../collaboration/native-copy-persistence';
import type { NativeRecoveryRecord } from '../collaboration/native-document-recovery';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { Y } from '../collaboration/server-runtime';
import type { WorkspaceOperationJobScope } from '../files/workspace-operation-batch-contract';
import type { NativeLinkMutationRecipe } from './workspace-link-contract-v2';
import { rebindNativeCloneLinks } from './workspace-native-link-clone';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from './workspace-native-link-inventory';
import { prepareNativeLinkMutations, type PreparedNativeLinkUpdate } from './workspace-native-link-mutations';

export class NativeCopyLinkBindingError extends Error {
  readonly status = 409;
  readonly code = 'NATIVE_COPY_LINK_BINDING_CONFLICT';
  constructor() { super('The original native copy receipt does not bind these documents and link recipes.'); }
}
function fail(): never { throw new NativeCopyLinkBindingError(); }

/** Pure preparation for a caller-held Copy transaction. A receipt is data, not
 * current authority: the owner must prove its original request, both current
 * workspaces, complete namespace and final graph before committing any delta.
 * Only the initial, freshly re-inventoried clone is accepted. Source Yjs
 * anchors are never submitted as clone anchors; the original receipt is kept. */
export function prepareNativeCopyLinkUpdates(input: {
  sourceScope: Pick<WorkspaceOperationJobScope, 'workspaceId' | 'organizationId'>;
  destinationScope: Pick<WorkspaceOperationJobScope, 'workspaceId' | 'organizationId'>;
  source: NativeRecoveryRecord;
  clone: NativeRecoveryRecord;
  receipt: NativeCopyDocumentReceipt;
  recipes: readonly NativeLinkMutationRecipe[];
  operationId: string;
}): {
  recipes: NativeLinkMutationRecipe[];
  linkBindings: Array<{ sourceLinkId: string; cloneLinkId: string }>;
  prepared: PreparedNativeLinkUpdate | null;
} {
  try {
    const { sourceScope, destinationScope, source, clone, receipt, recipes, operationId } = input;
    const before = authoritativeNativeCollaborationSnapshot(source.state);
    const copied = authoritativeNativeCollaborationSnapshot(clone.state);
    if (!operationId || before.workspaceId !== sourceScope.workspaceId || before.organizationId !== sourceScope.organizationId
      || copied.workspaceId !== destinationScope.workspaceId || copied.organizationId !== destinationScope.organizationId
      || receipt.version !== 1 || receipt.source.documentId !== before.documentId
      || receipt.source.lifecycleGeneration !== before.lifecycleGeneration || receipt.source.stateProof !== before.version.stateProof
      || receipt.source.documentSequence !== before.version.documentSequence
      || receipt.clone.documentId !== copied.documentId || receipt.clone.lineageId !== clone.lineageId
      || receipt.clone.path !== copied.path || receipt.clone.lifecycleGeneration !== 1 || copied.lifecycleGeneration !== 1
      || receipt.clone.initialSequence !== 0 || copied.version.documentSequence !== 0 || receipt.clone.stateProof !== copied.version.stateProof
      || before.documentId === copied.documentId || source.lineageId === clone.lineageId
      || before.representation !== copied.representation || before.schemaVersion !== copied.schemaVersion
      || source.state.newlineStyle !== clone.state.newlineStyle || source.state.hasBom !== clone.state.hasBom) fail();
    const sourceClients = Y.decodeStateVector(source.state.stateVector);
    if ([...Y.decodeStateVector(clone.state.stateVector).keys()].some(id => sourceClients.has(id))) fail();

    // Check the whole semantic clone, including unlinked blocks/frontmatter.
    // Original block IDs are opaque dictionary keys, including reserved names.
    const expected = structuredClone(before.content);
    const mapping = receipt.blockIdMapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(mapping))) fail();
    const originals = new Set<string>(); const replacements = new Set<string>();
    const remap = (node: JSONContent): void => {
      if (node.type !== 'doc' && node.type !== 'text') {
        const id = node.attrs?.id;
        if (typeof id !== 'string' || !id || originals.has(id)) fail();
        const property = Object.getOwnPropertyDescriptor(mapping, id);
        const next: unknown = property?.value;
        if (!property?.enumerable || !Object.hasOwn(property, 'value') || typeof next !== 'string'
          || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(next) || replacements.has(next)) fail();
        originals.add(id); replacements.add(next);
        node.attrs = { ...node.attrs, id: next };
      }
      for (const child of node.content ?? []) remap(child);
    };
    if (expected.kind === 'rich_text') remap(expected.document);
    if (Reflect.ownKeys(mapping).length !== originals.size || [...replacements].some(id => originals.has(id))
      || nativeLinkJsonProof(expected) !== nativeLinkJsonProof(copied.content)) fail();

    const sourceInventory = inspectPersistedDocumentLinks(source.state);
    const cloneInventory = inspectPersistedDocumentLinks(clone.state);
    if (!sourceInventory.coverage.complete || !cloneInventory.coverage.complete) fail();
    // Rebind every link, even when the path recipe only changes a subset. This
    // also certifies unchanged external/anchor links without reusing their refs.
    const links = rebindNativeCloneLinks({ source: sourceInventory, clone: cloneInventory, receipt });
    if (links.size !== sourceInventory.links.length) fail();
    const sourceLinks = new Map(sourceInventory.links.map(link => [link.id, link]));
    const selected = new Set<string>();
    const rebound = recipes.map(recipe => {
      const original = sourceLinks.get(recipe.linkId);
      const link = links.get(recipe.linkId);
      if (!original || !link || selected.has(recipe.linkId) || recipe.action !== 'rewrite' || typeof recipe.nextValue !== 'string'
        || !recipe.expectedTargetIdentity || !isDeepStrictEqual(recipe.source, sourceInventory.document)
        || !isDeepStrictEqual(recipe.sourceVersion, sourceInventory.version)
        || nativeLinkJsonProof(recipe.reference) !== nativeLinkJsonProof(original.ref)
        || recipe.destinationWorkspaceId !== copied.workspaceId || recipe.sourcePathAfter !== copied.path
        || typeof recipe.cloneSelection !== 'string' || !isCanonicalAdmissionPath(recipe.cloneSelection)
        || before.path !== recipe.cloneSelection && !before.path.startsWith(`${recipe.cloneSelection}/`)) fail();
      selected.add(recipe.linkId);
      return { ...structuredClone(recipe), linkId: link.id, source: structuredClone(cloneInventory.document),
        sourceVersion: structuredClone(cloneInventory.version), reference: structuredClone(link.ref), cloneSelection: null };
    }).filter(recipe => {
      // Cross-workspace path planning also emits equal-spelling rewrites. A
      // fresh clone already contains that value; keep its initial native clock
      // and proof, matching the compiler's actual mutation intents.
      const current = recipe.reference.kind === 'link-mark' ? recipe.reference.expected.href : recipe.reference.expected;
      return String(current) !== recipe.nextValue;
    });
    return { recipes: rebound, linkBindings: [...links].map(([sourceLinkId, link]) => ({ sourceLinkId, cloneLinkId: link.id })),
      prepared: rebound.length ? prepareNativeLinkMutations({ state: clone.state, recipes: rebound, operationId }) : null };
  } catch (error) {
    if (error instanceof NativeCopyLinkBindingError) throw error;
    return fail();
  }
}
