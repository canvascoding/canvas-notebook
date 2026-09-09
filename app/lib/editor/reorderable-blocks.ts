import type { Editor, Range } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { StepMap } from '@tiptap/pm/transform';
import { BLOCK_MOVE_TRANSACTION_META, createBlockReference, resolveBlockReference, type BlockReference } from './block-reference';

export type BlockInsertPlacement = 'above' | 'below';

export type ReorderableBlockKind = 'topLevel' | 'listItem' | 'nested';

export type ReorderableBlockRange = {
  reference: BlockReference;
  depth: number;
  from: number;
  kind: ReorderableBlockKind;
  node: ProseMirrorNode;
  parentFrom: number;
  parentTo: number;
  to: number;
};

export type BlockControlPosition = {
  blockRange: ReorderableBlockRange;
  menuRange: Range | null;
  top: number;
};

export type BlockDropPlacement = 'before' | 'after';

export type BlockDropTarget = {
  insertPosition: number;
  placement: BlockDropPlacement;
  target: ReorderableBlockRange;
};

export type BlockOverlayRect = {
  height: number;
  top: number;
};

export const CANVAS_BLOCK_DRAG_DATA_TYPE = 'application/x-canvas-editor-block';

export function setCanvasBlockDragData(dataTransfer: DataTransfer, gestureId = 'move'): void {
  dataTransfer.setData(CANVAS_BLOCK_DRAG_DATA_TYPE, gestureId);
}

export function hasCanvasBlockDragData(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes(CANVAS_BLOCK_DRAG_DATA_TYPE);
}

export function findActiveTextblockDepth(editor: Editor): number | null {
  const { $from } = editor.state.selection;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).isTextblock) return depth;
  }

  return null;
}

function getTopLevelBlockRangeAt(editor: Editor, position: number): ReorderableBlockRange | null {
  const docEnd = editor.state.doc.content.size;
  const safePosition = Math.max(0, Math.min(position, docEnd));
  let range: ReorderableBlockRange | null = null;

  editor.state.doc.forEach((node, offset) => {
    if (range) return;

    const from = offset;
    const to = offset + node.nodeSize;
    const isInsideNode = safePosition >= from && safePosition < to;
    const isAtDocumentEnd = safePosition === docEnd && safePosition === to;

    if (isInsideNode || isAtDocumentEnd) {
      range = {
        reference: createBlockReference(editor, node),
        depth: 1,
        from,
        kind: 'topLevel',
        node,
        parentFrom: 0,
        parentTo: docEnd,
        to,
      };
    }
  });

  return range;
}

/** Inline bodies and structural slots (cells, titles, list-item bodies) are not sibling blocks. */
function reorderableBlockKind(node: ProseMirrorNode, parent: ProseMirrorNode, depth: number): ReorderableBlockKind | null {
  if (depth === 1) return 'topLevel';
  if (['listItem', 'taskItem'].includes(node.type.name)
    && ['bulletList', 'orderedList', 'taskList'].includes(parent.type.name)) return 'listItem';
  if (parent.inlineContent || parent.type.spec.tableRole || ['listItem', 'taskItem'].includes(parent.type.name)) return null;
  return node.type.isInGroup('block') ? 'nested' : null;
}

function getContainedBlockRangeAt(
  editor: Editor,
  position: number,
  requiredParent?: Pick<ReorderableBlockRange, 'parentFrom' | 'parentTo'>,
): ReorderableBlockRange | null {
  const doc = editor.state.doc;
  const $position = doc.resolve(Math.max(0, Math.min(position, doc.content.size)));
  // Include nodeAfter at an exact block boundary (NodeSelection, atom or a
  // sibling destination). Walking only ancestors would select its container.
  for (let depth = $position.depth + 1; depth > 0; depth -= 1) {
    const atBoundary = depth > $position.depth;
    const node = atBoundary ? $position.nodeAfter : $position.node(depth);
    if (!node || node.isInline) continue;
    const parentDepth = depth - 1;
    const parentNode = $position.node(parentDepth);
    const kind = reorderableBlockKind(node, parentNode, depth);
    if (!kind) continue;
    const parentFrom = $position.start(parentDepth);
    const parentTo = $position.end(parentDepth);
    if (requiredParent && (parentFrom !== requiredParent.parentFrom || parentTo !== requiredParent.parentTo)) {
      continue;
    }

    return {
      reference: createBlockReference(editor, node),
      depth,
      from: atBoundary ? $position.pos : $position.before(depth),
      kind,
      node,
      parentFrom,
      parentTo,
      to: atBoundary ? $position.pos + node.nodeSize : $position.after(depth),
    };
  }

  return null;
}

export function getReorderableBlockRangeAt(
  editor: Editor,
  position: number,
  source?: ReorderableBlockRange,
): ReorderableBlockRange | null {
  if (editor.isDestroyed || !Number.isInteger(position)) return null;
  if (source) {
    const current = resolveReorderableBlockRange(editor, source);
    if (!current) return null;
    source = current;
  }
  if (source?.kind === 'topLevel') {
    return getTopLevelBlockRangeAt(editor, position);
  }
  if (source) return getContainedBlockRangeAt(editor, position, source);
  return getContainedBlockRangeAt(editor, position) ?? getTopLevelBlockRangeAt(editor, position);
}

export function resolveReorderableBlockRange(
  editor: Editor,
  range: ReorderableBlockRange,
): ReorderableBlockRange | null {
  if (editor.isDestroyed) return null;
  const current = resolveBlockReference(editor.state.doc, editor, range.reference);
  if (!current || current.node.type !== range.node.type) return null;
  if (range.kind !== reorderableBlockKind(current.node, current.parent, current.depth)) return null;
  return { ...range, ...current };
}

/** A selection must identify one whole movable unit, including selected atoms. */
export function getSelectedReorderableBlockRange(editor: Editor): ReorderableBlockRange | null {
  if (editor.isDestroyed) return null;
  const selection = editor.state.selection;
  const source = getReorderableBlockRangeAt(editor, selection.from);
  return source && selection.from >= source.from && selection.to <= source.to ? source : null;
}

function createEmptyListItemNode(editor: Editor, source: ReorderableBlockRange) {
  const paragraph = editor.schema.nodes.paragraph.create();
  return source.node.type.createAndFill(null, paragraph) ?? source.node.type.create(null, paragraph);
}

export function createInsertedBlockCommandTarget(
  editor: Editor,
  placement: BlockInsertPlacement,
  blockRange?: ReorderableBlockRange,
): Range | null {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return null;

  if (blockRange) {
    const current = resolveReorderableBlockRange(editor, blockRange);
    if (!current) return null;
    blockRange = current;
    const insertPosition = placement === 'above' ? blockRange.from : blockRange.to;
    const isListItem = blockRange.kind === 'listItem';
    const cursorPosition = insertPosition + (isListItem ? 2 : 1);
    const content = isListItem ? createEmptyListItemNode(editor, blockRange) : { type: 'paragraph' };

    const before = editor.state.doc;
    const applied = editor.chain().focus().insertContentAt(insertPosition, content).setTextSelection(cursorPosition).run();
    if (!applied || editor.state.doc === before) return null;

    return { from: cursorPosition, to: cursorPosition };
  }

  if (editor.isActive('codeBlock')) return null;
  const { $from } = editor.state.selection;
  const textblockDepth = findActiveTextblockDepth(editor);
  if (!textblockDepth) return null;

  const topLevelDepth = $from.depth >= 1 ? 1 : textblockDepth;
  const insertPosition = placement === 'above' ? $from.before(topLevelDepth) : $from.after(topLevelDepth);
  const cursorPosition = insertPosition + 1;
  editor
    .chain()
    .focus()
    .insertContentAt(insertPosition, { type: 'paragraph' })
    .setTextSelection(cursorPosition)
    .run();

  return { from: cursorPosition, to: cursorPosition };
}

export function createCurrentBlockCommandTarget(editor: Editor, menuRange?: Range): Range | null {
  if (!editor.isEditable || editor.isActive('codeBlock')) return null;

  if (menuRange) {
    editor.chain().focus().setTextSelection(menuRange.from).run();
    return menuRange;
  }

  const { $from } = editor.state.selection;
  const textblockDepth = findActiveTextblockDepth(editor);
  if (!textblockDepth) return null;

  const position = $from.start(textblockDepth);
  editor.chain().focus().setTextSelection(position).run();
  return { from: position, to: position };
}

export function getBlockInsertButtonPosition(editor: Editor, container: HTMLDivElement): BlockControlPosition | null {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return null;

  const { $from } = editor.state.selection;
  const textblockDepth = findActiveTextblockDepth(editor);
  const blockRange = getSelectedReorderableBlockRange(editor);
  if (!blockRange) return null;

  const blockDom = editor.view.nodeDOM(blockRange.from);
  const containerRect = container.getBoundingClientRect();
  const menuPosition = textblockDepth ? $from.start(textblockDepth)
    : blockRange.node.isTextblock ? blockRange.from + 1 : null;
  const menuRange = !editor.isActive('codeBlock') && blockRange.node.type.name !== 'codeBlock' && menuPosition !== null
    ? { from: menuPosition, to: menuPosition } : null;

  if (blockDom instanceof HTMLElement) {
    const blockRect = blockDom.getBoundingClientRect();
    return {
      blockRange,
      menuRange,
      top: Math.max(6, blockRect.top - containerRect.top + container.scrollTop + (blockRect.height / 2) - 12),
    };
  }

  const positionForCoords = Math.min(blockRange.from + 1, editor.state.doc.content.size);
  const coords = editor.view.coordsAtPos(positionForCoords);

  return {
    blockRange,
    menuRange,
    top: Math.max(6, coords.top - containerRect.top + container.scrollTop),
  };
}

export function getBlockDropInsertPosition(
  editor: Editor,
  event: DragEvent,
  source: ReorderableBlockRange,
): number | null {
  return getBlockDropTarget(editor, event, source)?.insertPosition ?? null;
}

export function getBlockDropTarget(
  editor: Editor,
  event: Pick<DragEvent, 'clientX' | 'clientY'>,
  source: ReorderableBlockRange,
): BlockDropTarget | null {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return null;
  const current = resolveReorderableBlockRange(editor, source);
  if (!current) return null;
  source = current;
  const positionAtCoords = editor.view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });

  if (!positionAtCoords) {
    if (source.kind !== 'topLevel') return null;

    const insertPosition = editor.state.doc.content.size;
    if (insertPosition >= source.from && insertPosition <= source.to) return null;

    const target = getTopLevelBlockRangeAt(editor, insertPosition);
    if (!target) return null;

    return {
      insertPosition,
      placement: 'after',
      target,
    };
  }

  const target = getReorderableBlockRangeAt(editor, positionAtCoords.pos, source);
  if (!target) {
    return null;
  }

  const targetDom = editor.view.nodeDOM(target.from);
  const targetRect = targetDom instanceof HTMLElement ? targetDom.getBoundingClientRect() : null;
  const placement: BlockDropPlacement = targetRect
    ? event.clientY < targetRect.top + targetRect.height / 2
      ? 'before'
      : 'after'
    : positionAtCoords.pos <= target.from
      ? 'before'
      : 'after';
  const insertPosition = placement === 'before' ? target.from : target.to;

  if (insertPosition >= source.from && insertPosition <= source.to) {
    return null;
  }

  return {
    insertPosition,
    placement,
    target,
  };
}

export function getBlockDropIndicatorTop(
  editor: Editor,
  container: HTMLDivElement,
  dropTarget: BlockDropTarget,
): number | null {
  const target = resolveReorderableBlockRange(editor, dropTarget.target);
  if (!target) return null;
  const targetDom = editor.view.nodeDOM(target.from);
  if (!(targetDom instanceof HTMLElement)) return null;

  const containerRect = container.getBoundingClientRect();
  const targetRect = targetDom.getBoundingClientRect();
  const targetEdge = dropTarget.placement === 'before' ? targetRect.top : targetRect.bottom;

  return Math.max(4, targetEdge - containerRect.top + container.scrollTop);
}

export function getBlockOverlayRect(
  editor: Editor,
  container: HTMLDivElement,
  blockRange: ReorderableBlockRange,
): BlockOverlayRect | null {
  const current = resolveReorderableBlockRange(editor, blockRange);
  if (!current) return null;
  const blockDom = editor.view.nodeDOM(current.from);
  if (!(blockDom instanceof HTMLElement)) return null;

  const containerRect = container.getBoundingClientRect();
  const blockRect = blockDom.getBoundingClientRect();

  return {
    height: Math.max(20, blockRect.height),
    top: Math.max(4, blockRect.top - containerRect.top + container.scrollTop),
  };
}

export type BlockMoveResult = { ok: true } | {
  ok: false;
  reason: 'read_only' | 'source_changed' | 'target_changed' | 'invalid_destination' | 'no_change';
};

/** Numeric destinations are for immediate commands only. Gestures carry a target reference. */
export function applyReorderableBlockMove(
  editor: Editor,
  capturedSource: ReorderableBlockRange,
  destination: BlockDropTarget | number,
  options: { preserveSelection?: boolean } = {},
): BlockMoveResult {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return { ok: false, reason: 'read_only' };
  const source = resolveReorderableBlockRange(editor, capturedSource);
  if (!source) return { ok: false, reason: 'source_changed' };
  let insertPosition: number;
  if (typeof destination === 'number') {
    insertPosition = destination;
  } else {
    const target = resolveReorderableBlockRange(editor, destination.target);
    if (!target) return { ok: false, reason: 'target_changed' };
    if (source.kind !== target.kind) return { ok: false, reason: 'invalid_destination' };
    insertPosition = destination.placement === 'before' ? target.from : target.to;
  }
  if (!Number.isInteger(insertPosition) || insertPosition < source.parentFrom || insertPosition > source.parentTo) {
    return { ok: false, reason: 'invalid_destination' };
  }
  const $insert = editor.state.doc.resolve(insertPosition);
  if ($insert.depth !== source.depth - 1 || $insert.start() !== source.parentFrom || $insert.textOffset !== 0) {
    return { ok: false, reason: 'invalid_destination' };
  }
  if (insertPosition >= source.from && insertPosition <= source.to) return { ok: false, reason: 'no_change' };

  try {
    const beforeDocument = editor.state.doc;
    const transaction = closeHistory(editor.state.tr).delete(source.from, source.to);
    // Reordering an existing block must not also create a trailing paragraph.
    transaction.setMeta('skipTrailingNode', true);
    const adjustedInsertPosition = transaction.mapping.map(insertPosition);
    transaction.insert(adjustedInsertPosition, source.node).scrollIntoView();
    transaction.doc.check();
    if (source.reference.id) {
      const parent = editor.state.doc.resolve(source.from).parent;
      const after = transaction.doc.nodeAt(adjustedInsertPosition + source.node.nodeSize);
      transaction.setMeta(BLOCK_MOVE_TRANSACTION_META, {
        blockId: source.reference.id,
        parentId: parent.type === editor.state.doc.type ? null : parent.attrs.id,
        beforeId: after?.attrs.id ?? null,
      });
    }
    const selectionPosition = Math.min(adjustedInsertPosition + 1, transaction.doc.content.size);

    if (options.preserveSelection) {
      // The move retains these positions even though its PM steps are a
      // delete/insert. Capture the final selection in this same history item.
      const mapResult = (position: number, association = 1) => {
        const moved = (position > source.from && position < source.to)
          || (position === source.from && association > 0)
          || (position === source.to && association < 0);
        return moved ? StepMap.empty.mapResult(adjustedInsertPosition + position - source.from, association)
          : transaction.mapping.mapResult(position, association);
      };
      transaction.setSelection(editor.state.selection.map(transaction.doc, {
        map: (position, association) => mapResult(position, association).pos, mapResult,
      }));
    } else if (selectionPosition >= 0) {
      transaction.setSelection(Selection.near(transaction.doc.resolve(selectionPosition), 1));
    }

    editor.view.dispatch(transaction);
    if (editor.state.doc === beforeDocument) return { ok: false, reason: 'invalid_destination' };
  } catch {
    return { ok: false, reason: 'invalid_destination' };
  }

  try {
    editor.commands.focus();
  } catch {
    // Focusing can fail in non-browser test environments after a successful
    // transaction; the reorder itself is still complete.
  }

  return { ok: true };
}

export function moveReorderableBlock(
  editor: Editor,
  source: ReorderableBlockRange,
  destination: BlockDropTarget | number,
): boolean {
  return applyReorderableBlockMove(editor, source, destination).ok;
}
