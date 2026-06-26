import type { Editor, Range } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';

export type BlockInsertPlacement = 'above' | 'below';

export type ReorderableBlockKind = 'topLevel' | 'listItem';

export type ReorderableBlockRange = {
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
  menuRange: Range;
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

function getListItemBlockRangeAt(
  editor: Editor,
  position: number,
  requiredParent?: Pick<ReorderableBlockRange, 'parentFrom' | 'parentTo'>,
): ReorderableBlockRange | null {
  const doc = editor.state.doc;
  const docEnd = doc.content.size;
  if (docEnd <= 0) return null;

  const safePosition = Math.max(0, Math.min(position, docEnd));
  const resolvePosition = Math.max(0, Math.min(safePosition, docEnd - 1));
  const $position = doc.resolve(resolvePosition);

  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const node = $position.node(depth);
    if (node.type.name !== 'listItem') continue;

    const parentDepth = depth - 1;
    const parentNode = $position.node(parentDepth);
    if (parentNode.type.name !== 'bulletList' && parentNode.type.name !== 'orderedList' && parentNode.type.name !== 'taskList') {
      continue;
    }

    const parentFrom = $position.start(parentDepth);
    const parentTo = $position.end(parentDepth);
    if (requiredParent && (parentFrom !== requiredParent.parentFrom || parentTo !== requiredParent.parentTo)) {
      continue;
    }

    return {
      depth,
      from: $position.before(depth),
      kind: 'listItem',
      node,
      parentFrom,
      parentTo,
      to: $position.after(depth),
    };
  }

  return null;
}

export function getReorderableBlockRangeAt(
  editor: Editor,
  position: number,
  source?: ReorderableBlockRange,
): ReorderableBlockRange | null {
  if (source?.kind === 'listItem') {
    return getListItemBlockRangeAt(editor, position, source);
  }

  if (source?.kind === 'topLevel') {
    return getTopLevelBlockRangeAt(editor, position);
  }

  return getListItemBlockRangeAt(editor, position) ?? getTopLevelBlockRangeAt(editor, position);
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
  if (!editor.isEditable || editor.isActive('codeBlock')) return null;

  if (blockRange) {
    const insertPosition = placement === 'above' ? blockRange.from : blockRange.to;
    const isListItem = blockRange.kind === 'listItem';
    const cursorPosition = insertPosition + (isListItem ? 2 : 1);
    const content = isListItem ? createEmptyListItemNode(editor, blockRange) : { type: 'paragraph' };

    editor.chain().focus().insertContentAt(insertPosition, content).setTextSelection(cursorPosition).run();

    return { from: cursorPosition, to: cursorPosition };
  }

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
  if (!editor.isEditable || editor.isActive('codeBlock')) return null;

  const { $from } = editor.state.selection;
  const textblockDepth = findActiveTextblockDepth(editor);
  if (!textblockDepth) return null;

  const blockRange = getReorderableBlockRangeAt(editor, editor.state.selection.from);
  if (!blockRange) return null;

  const blockDom = editor.view.nodeDOM(blockRange.from);
  const containerRect = container.getBoundingClientRect();
  const menuPosition = $from.start(textblockDepth);
  const menuRange = { from: menuPosition, to: menuPosition };

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
  event: DragEvent,
  source: ReorderableBlockRange,
): BlockDropTarget | null {
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
  const targetDom = editor.view.nodeDOM(dropTarget.target.from);
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
  const blockDom = editor.view.nodeDOM(blockRange.from);
  if (!(blockDom instanceof HTMLElement)) return null;

  const containerRect = container.getBoundingClientRect();
  const blockRect = blockDom.getBoundingClientRect();

  return {
    height: Math.max(20, blockRect.height),
    top: Math.max(4, blockRect.top - containerRect.top + container.scrollTop),
  };
}

export function moveReorderableBlock(editor: Editor, source: ReorderableBlockRange, insertPosition: number): boolean {
  const sourceSize = source.to - source.from;
  const adjustedInsertPosition = insertPosition > source.from ? insertPosition - sourceSize : insertPosition;

  if (adjustedInsertPosition === source.from) return false;

  try {
    const transaction = editor.state.tr
      .delete(source.from, source.to)
      .insert(adjustedInsertPosition, source.node)
      .scrollIntoView();
    const selectionPosition = Math.min(adjustedInsertPosition + 1, transaction.doc.content.size);

    if (selectionPosition >= 0) {
      transaction.setSelection(Selection.near(transaction.doc.resolve(selectionPosition), 1));
    }

    editor.view.dispatch(transaction);
  } catch {
    // Ignore invalid drops, for example when the browser reports coordinates
    // outside the reorderable parent list.
    return false;
  }

  try {
    editor.commands.focus();
  } catch {
    // Focusing can fail in non-browser test environments after a successful
    // transaction; the reorder itself is still complete.
  }

  return true;
}
