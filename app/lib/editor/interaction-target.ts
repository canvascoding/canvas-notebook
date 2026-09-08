import type { Editor, Range } from '@tiptap/core';
import type { Slice } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { createBlockReference, resolveBlockReference, type BlockReference } from './block-reference';
import type { BlockTreeSelection } from '../collaboration/block-tree-anchors';
import { captureBlockTreeEditorSelection, isBlockTreeEditorReady, resolveBlockTreeEditorSelection } from '../collaboration/block-tree-editor';

type TargetLifetime = { editor: Editor; active: boolean };
type Edge = { block: BlockReference; offset: number };

export type EditorRangeTarget = TargetLifetime & {
  from: Edge;
  to: Edge;
  selection: BlockTreeSelection | null;
  original: Slice;
};

export type EditorNodeTarget = TargetLifetime & { block: BlockReference };

function writable(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return false;
  return !editor.extensionManager.extensions.some((extension) => extension.name === 'canvasBlockTreeCollaboration')
    || isBlockTreeEditorReady(editor);
}

function edgeAt(editor: Editor, position: number, association: -1 | 1): Edge | null {
  const $position = editor.state.doc.resolve(position);
  if ($position.parent.inlineContent) {
    return { block: createBlockReference(editor, $position.parent), offset: position - $position.before() };
  }
  const next = association === 1 ? $position.nodeAfter : $position.nodeBefore;
  if (next && !next.isText) return { block: createBlockReference(editor, next), offset: association === 1 ? 0 : next.nodeSize };
  const other = association === 1 ? $position.nodeBefore : $position.nodeAfter;
  return other && !other.isText
    ? { block: createBlockReference(editor, other), offset: association === 1 ? other.nodeSize : 0 } : null;
}

/** Capture at dialog/async-action opening, never at completion. */
export function createEditorRangeTarget(editor: Editor, range: Range = editor.state.selection): EditorRangeTarget | null {
  if (!writable(editor) || !Number.isInteger(range.from) || !Number.isInteger(range.to)
    || range.from < 0 || range.to < range.from || range.to > editor.state.doc.content.size) return null;
  const from = edgeAt(editor, range.from, 1);
  const to = edgeAt(editor, range.to, range.from === range.to ? 1 : -1);
  if (!from || !to) return null;
  const doc = editor.state.doc;
  const selection = doc.resolve(range.from).parent.inlineContent && doc.resolve(range.to).parent.inlineContent
    ? captureBlockTreeEditorSelection(editor, TextSelection.create(doc, range.from, range.to)) : null;
  return { editor, active: true, from, to, selection, original: doc.slice(range.from, range.to) };
}

function resolveEdge(editor: Editor, edge: Edge): number | null {
  const current = resolveBlockReference(editor.state.doc, editor, edge.block);
  // Without CRDT anchors, an edit inside this target needs review. A move of
  // the unchanged block remains valid; an old absolute position never is.
  return current && current.node.eq(edge.block.node) && edge.offset <= current.node.nodeSize
    ? current.from + edge.offset : null;
}

export function resolveEditorRangeTarget(editor: Editor, target: EditorRangeTarget | null | undefined): Range | null {
  if (!target?.active || target.editor !== editor || !writable(editor)) return null;
  const saved = target.selection ? resolveBlockTreeEditorSelection(editor, target.selection) : null;
  if (target.selection && !saved) return null;
  const from = saved?.from ?? resolveEdge(editor, target.from);
  const to = saved?.to ?? resolveEdge(editor, target.to);
  if (from === null || to === null || from > to || to > editor.state.doc.content.size) return null;
  // Replacing/linking a prepared range must not overwrite newly changed text.
  if (!target.original.eq(editor.state.doc.slice(from, to))) return null;
  return { from, to };
}

export function createEditorNodeTarget(editor: Editor, position: number): EditorNodeTarget | null {
  if (!writable(editor) || !Number.isInteger(position) || position < 0 || position >= editor.state.doc.content.size) return null;
  const node = editor.state.doc.nodeAt(position);
  return node && !node.isText ? { editor, active: true, block: createBlockReference(editor, node) } : null;
}

export function resolveEditorNodeTarget(editor: Editor, target: EditorNodeTarget | null | undefined): number | null {
  if (!target?.active || target.editor !== editor || !writable(editor)) return null;
  const current = resolveBlockReference(editor.state.doc, editor, target.block);
  // A full-node dialog is based on a snapshot. Retain its draft and report a
  // conflict if another writer changed that node while the dialog was open.
  return current?.node.eq(target.block.node) ? current.from : null;
}

export function invalidateEditorTarget(target: TargetLifetime | null | undefined): void {
  if (target) target.active = false;
}

export type EditorSelectionTarget =
  | { kind: 'text'; range: EditorRangeTarget; backward: boolean }
  | { kind: 'node'; node: EditorNodeTarget }
  | { kind: 'cells'; anchor: EditorNodeTarget; head: EditorNodeTarget; cells: EditorNodeTarget[] }
  | { kind: 'all'; range: EditorRangeTarget };

/** Toolbars preserve the selection kind as well as its stable target. */
export function createEditorSelectionTarget(editor: Editor): EditorSelectionTarget | null {
  if (!writable(editor)) return null;
  const selection = editor.state.selection;
  if (selection instanceof NodeSelection) {
    const node = createEditorNodeTarget(editor, selection.from);
    return node ? { kind: 'node', node } : null;
  }
  if (selection instanceof CellSelection) {
    const anchor = createEditorNodeTarget(editor, selection.$anchorCell.pos);
    const head = createEditorNodeTarget(editor, selection.$headCell.pos);
    const cells: Array<EditorNodeTarget | null> = [];
    selection.forEachCell((_cell, position) => cells.push(createEditorNodeTarget(editor, position)));
    return anchor && head && cells.every((cell): cell is EditorNodeTarget => cell !== null)
      ? { kind: 'cells', anchor, head, cells } : null;
  }
  const range = createEditorRangeTarget(editor, selection);
  if (!range) return null;
  if (selection instanceof AllSelection) return { kind: 'all', range };
  return selection instanceof TextSelection ? { kind: 'text', range, backward: selection.anchor > selection.head } : null;
}

export function resolveEditorSelectionTarget(editor: Editor, target: EditorSelectionTarget | null): Selection | null {
  if (!target) return null;
  const doc = editor.state.doc;
  if (target.kind === 'node') {
    const position = resolveEditorNodeTarget(editor, target.node);
    return position !== null && NodeSelection.isSelectable(doc.nodeAt(position)!) ? NodeSelection.create(doc, position) : null;
  }
  if (target.kind === 'cells') {
    const anchor = resolveEditorNodeTarget(editor, target.anchor);
    const head = resolveEditorNodeTarget(editor, target.head);
    const expected = target.cells.map((cell) => resolveEditorNodeTarget(editor, cell));
    if (anchor === null || head === null || expected.includes(null)) return null;
    try {
      const selection = CellSelection.create(doc, anchor, head);
      const actual: number[] = [];
      selection.forEachCell((_cell, position) => actual.push(position));
      return actual.length === expected.length && actual.every((position) => expected.includes(position)) ? selection : null;
    } catch { return null; }
  }
  const range = resolveEditorRangeTarget(editor, target.range);
  if (!range) return null;
  if (target.kind === 'all') return range.from === 0 && range.to === doc.content.size ? new AllSelection(doc) : null;
  return TextSelection.create(doc, target.backward ? range.to : range.from, target.backward ? range.from : range.to);
}
