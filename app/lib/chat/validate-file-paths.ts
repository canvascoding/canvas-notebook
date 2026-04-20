import type { FileNode } from '@/app/store/file-store';

export async function validateFileExists(
  filePath: string,
  fileTree: FileNode[]
): Promise<boolean> {
  const normalizedPath = filePath.replace(/^\.\/|\/$/g, '');

  const nodeInTree = findNodeInTree(normalizedPath, fileTree);
  return nodeInTree !== null;
}

export function findNodeInTree(path: string, nodes: FileNode[]): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNodeInTree(path, node.children);
      if (found) return found;
    }
  }
  return null;
}
