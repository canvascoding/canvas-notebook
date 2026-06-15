import type { FileNode } from './types';

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

export function flattenTreePaths(nodes: FileNode[], result: string[] = []): string[] {
  for (const node of nodes) {
    result.push(node.path);
    if (node.children) {
      flattenTreePaths(node.children, result);
    }
  }
  return result;
}
