import type { FileNode } from './types';
import { getFileTitle } from './metadata';

export type FileSortKey = 'name' | 'title' | 'type' | 'created' | 'modified' | 'size' | 'favorite' | 'pinned';
export type FileSortDirection = 'asc' | 'desc';

/** Shared filter contract for future Web and Mobile file-browser controls. */
export interface FileFilter {
  extensions?: string[];
  favorite?: boolean;
  pinned?: boolean;
  createdAfter?: number;
  createdBefore?: number;
  modifiedAfter?: number;
  modifiedBefore?: number;
  minSize?: number;
  maxSize?: number;
}

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

function numericSortValue(node: FileNode, sortKey: 'created' | 'modified' | 'size' | 'pinned'): number | undefined {
  const value = sortKey === 'pinned' ? node.pinnedAt : node[sortKey];
  return value ?? undefined;
}

export function sortFileNodes(
  nodes: FileNode[],
  sortKey: FileSortKey,
  direction: FileSortDirection,
): FileNode[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...nodes].sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;

    if (sortKey === 'title') {
      const titleOrder = fileNameCollator.compare(getFileTitle(left), getFileTitle(right));
      if (titleOrder !== 0) return titleOrder * multiplier;
    } else if (sortKey === 'created' || sortKey === 'modified' || sortKey === 'size' || sortKey === 'pinned') {
      const leftValue = numericSortValue(left, sortKey);
      const rightValue = numericSortValue(right, sortKey);
      const missingOrder = compareOptionalNumber(leftValue, rightValue);
      if (missingOrder !== null && missingOrder !== 0) return missingOrder;
      if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
        return (leftValue - rightValue) * multiplier;
      }
    } else if (sortKey === 'type') {
      const typeOrder = fileNameCollator.compare(fileType(left), fileType(right));
      if (typeOrder !== 0) return typeOrder * multiplier;
    } else if (sortKey === 'favorite') {
      const favoriteOrder = Number(Boolean(left.isFavorite)) - Number(Boolean(right.isFavorite));
      if (favoriteOrder !== 0) return favoriteOrder * multiplier;
    }

    return fileNameCollator.compare(left.name, right.name) * multiplier;
  });
}

export function filterFileNodes(nodes: FileNode[], filter: FileFilter = {}): FileNode[] {
  return nodes.filter((node) => {
    const extension = fileType(node);
    if (filter.extensions?.length && !filter.extensions.includes(extension)) return false;
    if (filter.favorite !== undefined && Boolean(node.isFavorite) !== filter.favorite) return false;
    if (filter.pinned !== undefined && Boolean(node.pinnedAt) !== filter.pinned) return false;
    if (filter.createdAfter !== undefined && (node.created === undefined || node.created < filter.createdAfter)) return false;
    if (filter.createdBefore !== undefined && (node.created === undefined || node.created > filter.createdBefore)) return false;
    if (filter.modifiedAfter !== undefined && (node.modified === undefined || node.modified < filter.modifiedAfter)) return false;
    if (filter.modifiedBefore !== undefined && (node.modified === undefined || node.modified > filter.modifiedBefore)) return false;
    if (filter.minSize !== undefined && (node.size === undefined || node.size < filter.minSize)) return false;
    if (filter.maxSize !== undefined && (node.size === undefined || node.size > filter.maxSize)) return false;
    return true;
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
