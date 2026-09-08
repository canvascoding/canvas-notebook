import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export const BLOCK_MOVE_TRANSACTION_META = 'canvas-block-move';

/** A target belongs to one binding/view lifetime, never just a file path. */
export type BlockReference = Readonly<{
  scope: object;
  id: string | null;
  node: ProseMirrorNode;
}>;

export type LocatedBlock = {
  node: ProseMirrorNode;
  from: number;
  to: number;
  depth: number;
  parent: ProseMirrorNode;
  parentFrom: number;
  parentTo: number;
};

type BlockIndex = {
  ids: Map<string, LocatedBlock | null>;
  nodes: Map<ProseMirrorNode, LocatedBlock | null>;
};

// ProseMirror documents are immutable: index once per transaction, not per
// pointer event. Null records ambiguity rather than choosing the first match.
const indexes = new WeakMap<ProseMirrorNode, BlockIndex>();

function getBlockIndex(doc: ProseMirrorNode): BlockIndex {
  const cached = indexes.get(doc);
  if (cached) return cached;
  const index: BlockIndex = { ids: new Map(), nodes: new Map() };
  const visit = (parent: ProseMirrorNode, parentFrom: number, depth: number) => {
    parent.forEach((node, offset) => {
      if (node.isText) return;
      const from = parentFrom + offset;
      const block: LocatedBlock = {
        node, from, to: from + node.nodeSize, depth, parent,
        parentFrom, parentTo: parentFrom + parent.content.size,
      };
      index.nodes.set(node, index.nodes.has(node) ? null : block);
      const id = node.attrs.id;
      if (typeof id === 'string' && id.length > 0) {
        index.ids.set(id, index.ids.has(id) ? null : block);
      }
      if (!node.isLeaf) visit(node, from + 1, depth + 1);
    });
  };
  visit(doc, 0, 1);
  indexes.set(doc, index);
  return index;
}

export function createBlockReference(scope: object, node: ProseMirrorNode): BlockReference {
  const id = node.attrs.id;
  return { scope, node, id: typeof id === 'string' && id.length > 0 ? id : null };
}

export function resolveBlockReference(
  doc: ProseMirrorNode,
  scope: object,
  reference: BlockReference,
): LocatedBlock | null {
  if (reference.scope !== scope) return null;
  const index = getBlockIndex(doc);
  // ID-less local editors can resolve an unchanged immutable node. Never fall
  // back to text equality or a saved position after that node was replaced.
  return (reference.id ? index.ids.get(reference.id) : index.nodes.get(reference.node)) ?? null;
}
