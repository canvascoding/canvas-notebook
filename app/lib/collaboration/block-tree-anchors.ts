import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import type { CollaborationBlockTree } from './block-tree';

export type BlockTreeAnchor = {
  blockId: string;
  relative: Y.RelativePosition;
};

export type BlockTreeSelection =
  | { kind: 'text'; anchor: BlockTreeAnchor; head: BlockTreeAnchor }
  | { kind: 'node'; blockId: string };

function findNode(doc: ProseMirrorNode, id: string): { node: ProseMirrorNode; from: number } | null {
  let result: { node: ProseMirrorNode; from: number } | null = null;
  let count = 0;
  doc.descendants((node, from) => {
    if (node.attrs.id !== id) return;
    result = { node, from };
    count += 1;
  });
  return count === 1 ? result : null;
}

/** Only inline element sizes are needed by the relative-position conversion. */
function inlineMapping(fragment: Y.XmlFragment, node: ProseMirrorNode) {
  const mapping = new Map<Y.XmlElement | Y.XmlFragment, ProseMirrorNode>();
  const byId = new Map<string, ProseMirrorNode>();
  node.descendants((child) => {
    if (!child.isText && typeof child.attrs.id === 'string') byId.set(child.attrs.id, child);
  });
  const visit = (container: Y.XmlFragment) => {
    for (const child of container.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const current = byId.get(child.getAttribute('id') ?? '');
      if (!current) throw new Error('Inline anchor identity is missing.');
      mapping.set(child, current);
      visit(child);
    }
  };
  mapping.set(fragment, node);
  visit(fragment);
  return mapping;
}

function relativeAtOffset(
  container: Y.XmlFragment,
  offset: number,
  mapping: ReturnType<typeof inlineMapping>,
): Y.RelativePosition | null {
  if (offset === 0) return Y.createRelativePositionFromTypeIndex(container, 0, -1);
  const children = container.toArray();
  let position = 0;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child instanceof Y.XmlText) {
      if (offset <= position + child.length) return Y.createRelativePositionFromTypeIndex(child, offset - position);
      position += child.length;
    } else if (child instanceof Y.XmlElement) {
      const size = mapping.get(child)!.nodeSize;
      if (offset === position) return Y.createRelativePositionFromTypeIndex(container, index);
      if (offset < position + size) return relativeAtOffset(child, offset - position - 1, mapping);
      position += size;
    }
  }
  return offset === position ? Y.createRelativePositionFromTypeIndex(container, children.length, -1) : null;
}

function offsetOfRelative(
  container: Y.XmlFragment,
  absolute: Y.AbsolutePosition,
  mapping: ReturnType<typeof inlineMapping>,
): number | null {
  const children = container.toArray();
  let offset = 0;
  for (let index = 0; index < children.length; index += 1) {
    if (absolute.type === container && absolute.index === index) return offset;
    const child = children[index];
    if (child instanceof Y.XmlText) {
      if (absolute.type === child) return absolute.index <= child.length ? offset + absolute.index : null;
      offset += child.length;
    } else if (child instanceof Y.XmlElement) {
      const inner = offsetOfRelative(child, absolute, mapping);
      if (inner !== null) return offset + 1 + inner;
      offset += mapping.get(child)!.nodeSize;
    }
  }
  return absolute.type === container && absolute.index === children.length ? offset : null;
}

export function createBlockTreeAnchor(
  tree: CollaborationBlockTree,
  doc: ProseMirrorNode,
  position: number,
): BlockTreeAnchor | null {
  if (!Number.isInteger(position) || position < 0 || position > doc.content.size) return null;
  const $position = doc.resolve(position);
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const node = $position.node(depth);
    if (!node.inlineContent) continue;
    const blockId = node.attrs.id as string;
    if (!tree.records.has(blockId) || tree.project().deleted.has(blockId)) return null;
    try {
      const fragment = tree.content(blockId);
      const relative = relativeAtOffset(fragment, position - $position.start(depth), inlineMapping(fragment, node));
      return relative ? { blockId, relative } : null;
    } catch { return null; }
  }
  return null;
}

export function resolveBlockTreeAnchor(
  tree: CollaborationBlockTree,
  doc: ProseMirrorNode,
  anchor: BlockTreeAnchor,
): number | null {
  const current = findNode(doc, anchor.blockId);
  if (!current || !current.node.inlineContent || !tree.records.has(anchor.blockId)
    || tree.project().deleted.has(anchor.blockId)) return null;
  try {
    const fragment = tree.content(anchor.blockId);
    // Conversion checks that the underlying relative type is still a descendant
    // of this exact content fragment. An equal-looking replacement is no match.
    const absolute = Y.createAbsolutePositionFromRelativePosition(anchor.relative, tree.doc);
    const offset = absolute ? offsetOfRelative(fragment, absolute, inlineMapping(fragment, current.node)) : null;
    if (offset === null || offset < 0 || offset > current.node.content.size) return null;
    return current.from + 1 + offset;
  } catch { return null; }
}

export function captureBlockTreeSelection(
  tree: CollaborationBlockTree,
  doc: ProseMirrorNode,
  selection: Selection,
): BlockTreeSelection | null {
  if (selection instanceof NodeSelection && typeof selection.node.attrs.id === 'string') {
    return { kind: 'node', blockId: selection.node.attrs.id };
  }
  const anchor = createBlockTreeAnchor(tree, doc, selection.anchor);
  const head = createBlockTreeAnchor(tree, doc, selection.head);
  return anchor && head ? { kind: 'text', anchor, head } : null;
}

export function restoreBlockTreeSelection(
  tree: CollaborationBlockTree,
  doc: ProseMirrorNode,
  selection: BlockTreeSelection,
): Selection | null {
  if (selection.kind === 'node') {
    const current = findNode(doc, selection.blockId);
    return current && NodeSelection.isSelectable(current.node) ? NodeSelection.create(doc, current.from) : null;
  }
  const anchor = resolveBlockTreeAnchor(tree, doc, selection.anchor);
  const head = resolveBlockTreeAnchor(tree, doc, selection.head);
  return anchor === null || head === null ? null : TextSelection.between(doc.resolve(anchor), doc.resolve(head));
}
