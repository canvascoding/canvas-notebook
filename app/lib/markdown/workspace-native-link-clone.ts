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
export function rebindNativeCloneLinks(input: {
  source: NativeDocumentLinkInventory;
  clone: NativeDocumentLinkInventory;
  receipt: NativeLinkCloneReceipt;
}): Map<string, NativeDocumentLink> {
  const { source, clone, receipt } = input;
  const matchesIdentity = (inventory: NativeDocumentLinkInventory, identity: NativeLinkCloneReceipt['source']) =>
    inventory.document.documentId === identity.documentId && inventory.document.lifecycleGeneration === identity.lifecycleGeneration
      && inventory.version.stateProof === identity.stateProof;
  if (receipt.version !== 1 || !matchesIdentity(source, receipt.source) || !matchesIdentity(clone, receipt.clone)
    || receipt.source.documentId === receipt.clone.documentId || !source.coverage.complete || !clone.coverage.complete
    || source.document.representation !== clone.document.representation || source.document.schemaVersion !== clone.document.schemaVersion
    || source.links.length !== clone.links.length) throw new Error('The native clone receipt does not certify these inventories.');
  const mapId = (id: string | null) => {
    if (id === null) return null;
    const property = Object.getOwnPropertyDescriptor(receipt.blockIdMapping, id);
    const mapped: unknown = property && Object.hasOwn(property, 'value') ? property.value : undefined;
    if (typeof mapped !== 'string' || !mapped || mapped === id) throw new Error('The native clone node mapping is incomplete.');
    return mapped;
  };
  // One complete indexed matching pass per document, including unchanged links.
  // Rebinding N recipes must not repeat an N-by-N inventory scan N times.
  const locatorKey = (link: NativeDocumentLink) => nativeLinkJsonProof({ kind: link.ref.kind, locator: link.cloneLocator });
  const byLocator = new Map<string, NativeDocumentLink>();
  const cloneIds = new Set<string>();
  for (const link of clone.links) {
    const key = locatorKey(link);
    if (byLocator.has(key) || cloneIds.has(link.id)) throw new Error('The native clone link mapping is ambiguous or changed.');
    byLocator.set(key, link); cloneIds.add(link.id);
  }
  const linked = new Map<string, NativeDocumentLink>();
  const used = new Set<string>();
  for (const original of source.links) {
    const locator = { ownerBlockId: mapId(original.cloneLocator.ownerBlockId), nodeId: mapId(original.cloneLocator.nodeId), ordinal: original.cloneLocator.ordinal };
    const candidate = byLocator.get(nativeLinkJsonProof({ kind: original.ref.kind, locator }));
    if (!candidate || linked.has(original.id) || used.has(candidate.id)
      || original.literal !== candidate.literal || original.targetPathText !== candidate.targetPathText
      || original.kind !== candidate.kind || original.syntax !== candidate.syntax
      || original.fragment !== candidate.fragment || original.alias !== candidate.alias
      || original.embed !== candidate.embed || original.classification !== candidate.classification
      || nativeLinkJsonProof(original.ref.expected) !== nativeLinkJsonProof(candidate.ref.expected)) {
      throw new Error('The native clone link mapping is ambiguous or changed.');
    }
    linked.set(original.id, candidate); used.add(candidate.id);
  }
  return linked;
}

/** Compatibility lookup for callers selecting one link from the full binding. */
export function rebindNativeCloneLink(input: {
  source: NativeDocumentLinkInventory;
  clone: NativeDocumentLinkInventory;
  sourceLinkId: string;
  receipt: NativeLinkCloneReceipt;
}): NativeDocumentLink {
  const matches = input.source.links.filter(link => link.id === input.sourceLinkId);
  if (matches.length !== 1) throw new Error('The source link is not uniquely identified.');
  return rebindNativeCloneLinks(input).get(input.sourceLinkId)!;
}
