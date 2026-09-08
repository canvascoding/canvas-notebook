import type { FileNode } from './types';
import { getParentDirectory, isSameOrDescendantPath, remapDescendantPath } from './path-utils';
import { findNodeInTree } from './tree-utils';

export function remapPath(path: string, oldPath: string, newPath: string): string {
  return isSameOrDescendantPath(path, oldPath) ? remapDescendantPath(path, oldPath, newPath) : path;
}

export function remapNode(node: FileNode, oldPath: string, newPath: string): FileNode {
  const path = remapPath(node.path, oldPath, newPath);
  return { ...node, path, name: path.split('/').pop()!,
    ...(node.children ? { children: node.children.map((child) => remapNode(child, oldPath, newPath)) } : {}),
  };
}

export function removeTreePaths(tree: FileNode[], paths: string[]): FileNode[] {
  return tree.filter((node) => !paths.some((path) => isSameOrDescendantPath(node.path, path)))
    .map((node) => node.children ? { ...node, children: removeTreePaths(node.children, paths) } : node);
}

/** Preserve loaded descendants and update source/destination together. */
export function renameTreePath(tree: FileNode[], oldPath: string, newPath: string): FileNode[] {
  const source = findNodeInTree(oldPath, tree);
  if (!source) return tree;
  const renamed = remapNode(source, oldPath, newPath);
  const remaining = removeTreePaths(tree, [oldPath, newPath]);
  const parent = getParentDirectory(newPath);
  if (parent === '.') return [...remaining, renamed];
  const insert = (nodes: FileNode[]): FileNode[] => nodes.map((node) => {
    if (node.path === parent && node.children) return { ...node, children: [...node.children, renamed] };
    return node.children ? { ...node, children: insert(node.children) } : node;
  });
  return insert(remaining);
}
