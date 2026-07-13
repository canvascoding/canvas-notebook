import type { FileNode } from './types';

export type FileSortKey = 'name' | 'type' | 'modified' | 'size';
export type FileSortDirection = 'asc' | 'desc';

const fileNameCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

function fileType(node: FileNode): string {
  if (node.type === 'directory') return '';
  const dotIndex = node.name.lastIndexOf('.');
  return dotIndex > 0 ? node.name.slice(dotIndex + 1).toLowerCase() : '';
}

function compareOptionalNumber(left?: number, right?: number): number | null {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return null;
}

export function sortFileNodes(
  nodes: FileNode[],
  sortKey: FileSortKey,
  direction: FileSortDirection,
): FileNode[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...nodes].sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;

    if (sortKey === 'modified' || sortKey === 'size') {
      const leftValue = left[sortKey];
      const rightValue = right[sortKey];
      const missingOrder = compareOptionalNumber(leftValue, rightValue);
      if (missingOrder !== null && missingOrder !== 0) return missingOrder;
      if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
        return (leftValue - rightValue) * multiplier;
      }
    } else if (sortKey === 'type') {
      const typeOrder = fileNameCollator.compare(fileType(left), fileType(right));
      if (typeOrder !== 0) return typeOrder * multiplier;
    }

    return fileNameCollator.compare(left.name, right.name) * multiplier;
  });
}

export function sortFileTree(
  nodes: FileNode[],
  sortKey: FileSortKey,
  direction: FileSortDirection,
): FileNode[] {
  return sortFileNodes(nodes, sortKey, direction).map((node) => (
    node.children
      ? { ...node, children: sortFileTree(node.children, sortKey, direction) }
      : node
  ));
}
