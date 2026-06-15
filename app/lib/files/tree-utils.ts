import type { FileNode } from './types';
import {
  getParentDirectories,
  getParentDirectory,
  isSameOrDescendantPath,
  remapDescendantPath,
} from './path-utils';

export function findNodeInTree(searchPath: string, nodes: FileNode[]): FileNode | null {
  for (const node of nodes) {
    if (node.path === searchPath) return node;
    if (node.children) {
      const found = findNodeInTree(searchPath, node.children);
      if (found) return found;
    }
  }
  return null;
}

export function findPathInTree(searchPath: string, tree: FileNode[]): boolean {
  if (searchPath === '.') return true;
  return findNodeInTree(searchPath, tree) !== null;
}

export function flattenDirectoryChildren(nodes: FileNode[], dirPath: string): FileNode[] | null {
  if (dirPath === '.') return nodes;
  for (const node of nodes) {
    if (node.path === dirPath) return node.children ?? null;
    if (node.children) {
      const found = flattenDirectoryChildren(node.children, dirPath);
      if (found !== null) return found;
    }
  }
  return null;
}

export function mergeSubtreeChildren(nodes: FileNode[], targetPath: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children };
    }
    if (node.children) {
      return { ...node, children: mergeSubtreeChildren(node.children, targetPath, children) };
    }
    return node;
  });
}

export function mergeRootNodesPreservingChildren(nextNodes: FileNode[], currentNodes: FileNode[]): FileNode[] {
  const currentNodesByPath = new Map<string, FileNode>();
  for (const node of currentNodes) {
    currentNodesByPath.set(node.path, node);
  }

  return nextNodes.map((nextNode) => {
    if (nextNode.type !== 'directory') return nextNode;
    const currentNode = currentNodesByPath.get(nextNode.path);
    return currentNode?.children ? { ...nextNode, children: currentNode.children } : nextNode;
  });
}

export function flattenTreePaths(nodes: FileNode[], result: string[] = []): string[] {
  for (const node of nodes) {
    result.push(node.path);
    if (node.children) {
      flattenTreePaths(node.children, result);
    }
  }
  return result;
}

export function getVisibleTreeRefreshDirectories(
  currentDirectory: string,
  expandedDirs: Set<string>,
  includeExpandedDirs: boolean
): string[] {
  const dirsToRefresh = new Set<string>();
  if (currentDirectory !== '.') {
    for (const dirPath of getParentDirectories(`${currentDirectory}/_`)) {
      dirsToRefresh.add(dirPath);
    }
    dirsToRefresh.add(currentDirectory);
  }

  if (includeExpandedDirs) {
    for (const dirPath of expandedDirs) {
      if (dirPath !== '.') dirsToRefresh.add(dirPath);
    }
  }

  return Array.from(dirsToRefresh).sort((a, b) => {
    const depthDiff = a.split('/').length - b.split('/').length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });
}

export function hasRefreshParentInTree(tree: FileNode[], dirPath: string): boolean {
  const parentDir = getParentDirectory(dirPath);
  return parentDir === '.'
    ? tree.some((node) => node.path === dirPath.split('/')[0] && node.type === 'directory')
    : findPathInTree(parentDir, tree);
}

export function getTreeSelectionRangePaths(nodes: FileNode[], startPath: string, endPath: string): string[] {
  const allPaths = flattenTreePaths(nodes);
  const startIndex = allPaths.indexOf(startPath);
  const endIndex = allPaths.indexOf(endPath);

  if (startIndex === -1 || endIndex === -1) return [];

  const start = Math.min(startIndex, endIndex);
  const end = Math.max(startIndex, endIndex);
  return allPaths.slice(start, end + 1);
}

export function getDirectoryDirectChildPaths(nodes: FileNode[], dirPath: string): string[] {
  const children = flattenDirectoryChildren(nodes, dirPath);
  return children?.map((child) => child.path) ?? [];
}

export function remapExpandedDirectories(expandedDirs: Set<string>, oldPath: string, newPath: string): Set<string> {
  const hasDescendants = expandedDirs.has(oldPath) || [...expandedDirs].some((dir) => isSameOrDescendantPath(dir, oldPath));
  if (!hasDescendants) return expandedDirs;

  const remapped = new Set<string>();
  for (const dir of expandedDirs) {
    remapped.add(isSameOrDescendantPath(dir, oldPath) ? remapDescendantPath(dir, oldPath, newPath) : dir);
  }
  return remapped;
}

export function getExpandedDescendantDirectories(expandedDirs: Set<string>, rootPath: string): string[] {
  return [...expandedDirs]
    .filter((dir) => isSameOrDescendantPath(dir, rootPath))
    .sort((a, b) => a.split('/').length - b.split('/').length);
}
