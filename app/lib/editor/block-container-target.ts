import type { Editor } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createBlockReference, resolveBlockReference, type BlockReference } from './block-reference';
import type { ReorderableBlockRange } from './reorderable-blocks';

/** An explicit container choice belongs to this view, never a saved position. */
export type BlockContainerTarget = { kind: 'container'; scope: Editor; parent: BlockReference | null };
export type BlockContainerOption = { target: BlockContainerTarget; path: string; type: string; preview: string };

export function resolveBlockContainerMove(editor: Editor, source: ReorderableBlockRange, target: BlockContainerTarget) {
  if (target.scope !== editor || editor.isDestroyed || !editor.isEditable || editor.view.composing) return null;
  const doc = editor.state.doc;
  const located = target.parent ? resolveBlockReference(doc, editor, target.parent) : null;
  if (target.parent && (!located || located.node.type !== target.parent.node.type)) return null;
  const parent = located?.node ?? doc;
  const parentFrom = located ? located.from + 1 : 0;
  if (parentFrom === source.parentFrom || parent.inlineContent || parent.isLeaf || parent.type.spec.tableRole
    || (located && located.from >= source.from && located.to <= source.to)
    || !parent.canReplace(parent.childCount, parent.childCount, Fragment.from(source.node))) return null;
  const insertPosition = parentFrom + parent.content.size;
  const $source = doc.resolve(source.from);
  let removeFrom = source.from;
  let removeTo = source.to;
  // Prune only empty required wrappers (e.g. the last item leaves its list).
  // Optional bodies and titled containers remain. Insert first so an ancestor
  // destination can receive the child before its empty inner wrapper is removed.
  for (let depth = $source.depth; depth >= 0; depth--) {
    const oldParent = $source.node(depth);
    const index = $source.index(depth);
    if (oldParent === parent || oldParent.canReplace(index, index + 1)) break;
    if (depth === 0 || oldParent.childCount !== 1 || !oldParent.type.isInGroup('block')) return null;
    removeFrom = $source.before(depth);
    removeTo = $source.after(depth);
  }
  return { insertPosition, removeFrom, removeTo, parentId: located?.node.attrs.id ?? null };
}

/** List only destinations whose schema and ancestry accept the current block. */
export function getBlockContainerOptions(editor: Editor, source: ReorderableBlockRange): BlockContainerOption[] {
  if (editor.isDestroyed) return [];
  const options: BlockContainerOption[] = [];
  const add = (node: ProseMirrorNode, path: number[], previewNode = node) => {
    const target: BlockContainerTarget = { kind: 'container', scope: editor,
      parent: path.length ? createBlockReference(editor, node) : null };
    if (!resolveBlockContainerMove(editor, source, target)) return;
    options.push({ target, path: path.join('.'), type: node.type.name,
      preview: previewNode.textContent.replace(/\s+/gu, ' ').trim().slice(0, 100) });
  };
  add(editor.state.doc, []);
  const visit = (parent: ProseMirrorNode, from: number, path: number[]) => parent.forEach((node, offset, index) => {
    const position = from + offset;
    if (position >= source.from && position < source.to) return;
    if (node.isLeaf || node.inlineContent || node.type.spec.tableRole) return;
    const nextPath = [...path, index + 1];
    add(node, nextPath, node.type.name === 'canvasDetailsContent' ? parent : node);
    visit(node, position + 1, nextPath);
  });
  visit(editor.state.doc, 0, []);
  return options;
}
