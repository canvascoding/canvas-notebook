import { nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeDocumentLink } from './workspace-link-contract-v2';
import type { NativeDocumentLinkInventoryV4 } from './workspace-native-link-inventory';

type NativeLinkCloneReceipt = {
  version: 1;
  source: { documentId: string; lifecycleGeneration: number; stateProof: string };
  clone: { documentId: string; lifecycleGeneration: number; stateProof: string };
  blockIdMapping: Record<string, string>;
};

function sameCoverage(source: NativeDocumentLinkInventoryV4, clone: NativeDocumentLinkInventoryV4): boolean {
  // Assessment is performed by the actual E5 owner. Clone preparation must
  // preserve every parser4 gap including its exact source-local HTML facts.
  // Path and fresh document ID differ; code/attribute facts may not.
  const normalized = (inventory: NativeDocumentLinkInventoryV4) => inventory.coverage.gaps.map(({ path: _path, ...gap }) => gap);
  return nativeLinkJsonProof(normalized(source)) === nativeLinkJsonProof(normalized(clone));
}

/** Re-inventoried clone references belong to its fresh binary. Even a valid
 * source Y.RelativePosition must never be applied to that independent history. */
export function rebindNativeCloneLinksV4(input: {
  source: NativeDocumentLinkInventoryV4;
  clone: NativeDocumentLinkInventoryV4;
  receipt: NativeLinkCloneReceipt;
}): Map<string, NativeDocumentLink> {
  const { source, clone, receipt } = input;
  const matchesIdentity = (inventory: NativeDocumentLinkInventoryV4, identity: NativeLinkCloneReceipt['source']) =>
    inventory.document.documentId === identity.documentId && inventory.document.lifecycleGeneration === identity.lifecycleGeneration
      && inventory.version.stateProof === identity.stateProof;
  if (receipt.version !== 1 || !matchesIdentity(source, receipt.source) || !matchesIdentity(clone, receipt.clone)
    || receipt.source.documentId === receipt.clone.documentId
    || source.parserVersion !== 4 || clone.parserVersion !== 4
    || !sameCoverage(source, clone)
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
