import type { FileNode } from './types';

/** Keep a confirmed new folder visible while its parent snapshot catches up. */
export function insertConfirmedDirectory(nodes: FileNode[], directoryPath: string): FileNode[] {
  const segments = directoryPath.split('/').filter(Boolean);
  const insert = (entries: FileNode[], index: number): FileNode[] => {
    const currentPath = segments.slice(0, index + 1).join('/');
    const existing = entries.find((entry) => entry.path === currentPath);
    const directory: FileNode = existing?.type === 'directory' ? existing : {
      path: currentPath, name: segments[index], type: 'directory', children: [],
    };
    const next = index < segments.length - 1
      ? { ...directory, children: insert(directory.children ?? [], index + 1) }
      : directory;
    return existing
      ? entries.map((entry) => entry.path === currentPath ? next : entry)
      : [...entries, next];
  };
  return segments.length ? insert(nodes, 0) : nodes;
}

export function hasDirectoryInTree(nodes: FileNode[], directoryPath: string): boolean {
  return nodes.some((node) => node.type === 'directory' && (node.path === directoryPath
    || Boolean(node.children && hasDirectoryInTree(node.children, directoryPath))));
}
