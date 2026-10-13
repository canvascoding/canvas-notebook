import { nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeDocumentLink, NativeDocumentLinkInventory } from './workspace-link-contract-v2';

export type NativeLinkCloneReceipt = {
  version: 1;
  source: { documentId: string; lifecycleGeneration: number; stateProof: string };
  clone: { documentId: string; lifecycleGeneration: number; stateProof: string };
  blockIdMapping: Record<string, string>;
};

/** Re-inventoried clone references belong to its fresh binary. Even a valid
 * source Y.RelativePosition must never be applied to that independent history. */
export function rebindNativeCloneLink(input: {
  source: NativeDocumentLinkInventory;
  clone: NativeDocumentLinkInventory;
  sourceLinkId: string;
  receipt: NativeLinkCloneReceipt;
}): NativeDocumentLink {
  const { source, clone, receipt } = input;
  const matchesIdentity = (inventory: NativeDocumentLinkInventory, identity: NativeLinkCloneReceipt['source']) =>
    inventory.document.documentId === identity.documentId && inventory.document.lifecycleGeneration === identity.lifecycleGeneration
      && inventory.version.stateProof === identity.stateProof;
  if (receipt.version !== 1 || !matchesIdentity(source, receipt.source) || !matchesIdentity(clone, receipt.clone)
    || receipt.source.documentId === receipt.clone.documentId || !source.coverage.complete || !clone.coverage.complete
    || source.document.representation !== clone.document.representation || source.document.schemaVersion !== clone.document.schemaVersion
    || source.links.length !== clone.links.length) throw new Error('The native clone receipt does not certify these inventories.');
  const selected = source.links.filter((link) => link.id === input.sourceLinkId);
  if (selected.length !== 1) throw new Error('The source link is not uniquely identified.');
  const mapId = (id: string | null) => {
    if (id === null) return null;
    const mapped = receipt.blockIdMapping[id];
    if (!mapped || mapped === id) throw new Error('The native clone node mapping is incomplete.');
    return mapped;
  };
  const linked = new Map<string, NativeDocumentLink>();
  for (const original of source.links) {
    const locator = { ownerBlockId: mapId(original.cloneLocator.ownerBlockId), nodeId: mapId(original.cloneLocator.nodeId), ordinal: original.cloneLocator.ordinal };
    const candidates = clone.links.filter((link) => link.ref.kind === original.ref.kind
      && nativeLinkJsonProof(link.cloneLocator) === nativeLinkJsonProof(locator));
    if (candidates.length !== 1 || linked.has(candidates[0].id)
      || original.literal !== candidates[0].literal || original.targetPathText !== candidates[0].targetPathText
      || original.kind !== candidates[0].kind || original.syntax !== candidates[0].syntax
      || original.fragment !== candidates[0].fragment || original.alias !== candidates[0].alias
      || original.embed !== candidates[0].embed || original.classification !== candidates[0].classification
      || nativeLinkJsonProof(original.ref.expected) !== nativeLinkJsonProof(candidates[0].ref.expected)) {
      throw new Error('The native clone link mapping is ambiguous or changed.');
    }
    linked.set(candidates[0].id, candidates[0]);
    if (original.id === input.sourceLinkId) linked.set('selected', candidates[0]);
  }
  return linked.get('selected')!;
}
