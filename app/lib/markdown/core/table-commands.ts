import type { CommandProps, RawCommands } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { findTable, isInTable, moveTableColumn, moveTableRow, selectedRect } from '@tiptap/pm/tables';

/** Only explicit table edits normalize the header; loading never changes a document. */
function retainMarkdownHeader(tr: Transaction) {
  const table = findTable(tr.selection.$from);
  if (!table) return;
  const alignments: (string | null)[] = [];
  table.node.forEach((row) => row.forEach((cell, _offset, column) => {
    alignments[column] ??= cell.attrs.align ?? null;
  }));
  table.node.forEach((row, rowOffset, rowIndex) => row.forEach((cell, cellOffset, column) => {
    const type = rowIndex === 0 ? tr.doc.type.schema.nodes.tableHeader : tr.doc.type.schema.nodes.tableCell;
    const align = alignments[column] ?? null;
    if (cell.type !== type || cell.attrs.align !== align) {
      tr.setNodeMarkup(table.start + rowOffset + 1 + cellOffset, type, { ...cell.attrs, align }, cell.marks);
    }
  }));
}

export function portableTableCommands(parent: Partial<RawCommands>): Partial<RawCommands> {
  const rowCommand = (name: 'addRowBefore' | 'addRowAfter' | 'deleteRow') => () => (props: CommandProps) => {
    const changed = parent[name]?.()(props) ?? false;
    if (changed && props.dispatch) retainMarkdownHeader(props.tr);
    return changed;
  };
  return {
    ...parent,
    insertTable: (options = {}) => (props) => parent.insertTable?.({ ...options, withHeaderRow: true })(props) ?? false,
    addRowBefore: rowCommand('addRowBefore'),
    addRowAfter: rowCommand('addRowAfter'),
    deleteRow: rowCommand('deleteRow'),
    // GFM has one header and no merged cells. These controls must not create
    // structures that the checkpoint serializer cannot retain.
    toggleHeaderRow: () => () => false,
    toggleHeaderColumn: () => () => false,
    toggleHeaderCell: () => () => false,
    mergeCells: () => () => false,
    setCellAttribute: (name, value) => (props) => {
      if (name !== 'align') return parent.setCellAttribute?.(name, value)(props) ?? false;
      if (!isInTable(props.state) || ![null, 'left', 'center', 'right'].includes(value)) return false;
      const rect = selectedRect(props.state);
      if (props.dispatch) {
        const visited = new Set<number>();
        for (let row = 0; row < rect.map.height; row++) {
          for (let column = rect.left; column < rect.right; column++) {
            const position = rect.tableStart + rect.map.map[row * rect.map.width + column];
            if (visited.has(position)) continue;
            visited.add(position);
            const cell = props.tr.doc.nodeAt(position);
            if (cell) props.tr.setNodeMarkup(position, undefined, { ...cell.attrs, align: value });
          }
        }
      }
      return true;
    },
  };
}

export function moveMarkdownTablePart(props: CommandProps, axis: 'row' | 'column', direction: -1 | 1): boolean {
  if (!isInTable(props.state)) return false;
  const rect = selectedRect(props.state);
  const from = axis === 'row' ? rect.top : rect.left;
  const to = from + direction;
  const limit = axis === 'row' ? rect.map.height : rect.map.width;
  // Keep the single header in place, and move one unmerged row/column at a time.
  if (to < (axis === 'row' ? 1 : 0) || from < (axis === 'row' ? 1 : 0) || to >= limit
    || (axis === 'row' ? rect.bottom - rect.top : rect.right - rect.left) !== 1) return false;
  return (axis === 'row' ? moveTableRow : moveTableColumn)({ from, to, select: true })(props.state, props.dispatch);
}
