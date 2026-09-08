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
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.path === targetPath) {
      const merged = mergeRootNodesPreservingChildren(children, node.children ?? []);
      if (merged === node.children) return node;
      changed = true;
      return { ...node, children: merged };
    }
    if (node.children && targetPath.startsWith(`${node.path}/`)) {
      const nextChildren = mergeSubtreeChildren(node.children, targetPath, children);
      if (nextChildren !== node.children) {
        changed = true;
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
  return changed ? nextNodes : nodes;
}

export function mergeRootNodesPreservingChildren(nextNodes: FileNode[], currentNodes: FileNode[]): FileNode[] {
  const currentNodesByPath = new Map<string, FileNode>();
  for (const node of currentNodes) {
    currentNodesByPath.set(node.path, node);
  }

  const merged = nextNodes.map((nextNode) => {
    const currentNode = currentNodesByPath.get(nextNode.path);
    const candidate = nextNode.type === 'directory' && currentNode?.type === 'directory' && currentNode.children
      ? { ...nextNode, children: currentNode.children } : nextNode;
    return currentNode && equalFileNode(candidate, currentNode) ? currentNode : candidate;
  });
  return merged.length === currentNodes.length && merged.every((node, index) => node === currentNodes[index]) ? currentNodes : merged;
}

function equalFileNode(left: FileNode, right: FileNode): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as Array<keyof FileNode>);
  for (const key of keys) {
    if (key === 'publicShare') {
      if (left.publicShare === right.publicShare) continue;
      if (!left.publicShare || !right.publicShare) return false;
      const fields = new Set([...Object.keys(left.publicShare), ...Object.keys(right.publicShare)] as Array<keyof NonNullable<FileNode['publicShare']>>);
      if ([...fields].some((field) => left.publicShare![field] !== right.publicShare![field])) return false;
    } else if (left[key] !== right[key]) return false;
  }
  return true;
}

/** Insert into loaded branches only; new closed parents remain lazy. */
export function mergeUploadedFileNodes(tree: FileNode[], uploads: FileNode[]): FileNode[] {
  const insert = (nodes: FileNode[], file: FileNode, segments: string[], depth: number): FileNode[] => {
    const path = segments.slice(0, depth + 1).join('/');
    const index = nodes.findIndex((node) => node.path === path);
    const existing = nodes[index];
    let next: FileNode;
    if (depth === segments.length - 1) {
      next = existing?.type === file.type ? { ...existing, ...file } : file;
      if (existing && equalFileNode(existing, next)) return nodes;
    } else if (!existing) next = { path, name: segments[depth], type: 'directory' };
    else {
      if (existing.type !== 'directory' || !existing.children) return nodes;
      const children = insert(existing.children, file, segments, depth + 1);
      if (children === existing.children) return nodes;
      next = { ...existing, children };
    }
    return index < 0 ? [...nodes, next] : nodes.map((node, cursor) => cursor === index ? next : node);
  };
  return uploads.reduce((nodes, upload) => insert(nodes, upload, upload.path.split('/'), 0), tree);
}

export function clearUnrefreshedDirectoryChildren(
  nodes: FileNode[],
  refreshedDirectories: Set<string>,
): FileNode[] {
  return nodes.map((node) => {
    if (node.type !== 'directory' || !node.children) return node;
    if (!refreshedDirectories.has(node.path)) {
      return { ...node, children: undefined };
    }
    return {
      ...node,
      children: clearUnrefreshedDirectoryChildren(node.children, refreshedDirectories),
    };
  });
}

export function clearDirectoryChildren(nodes: FileNode[], targetPath: string): FileNode[] {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.path === targetPath && node.type === 'directory') {
      if (!node.children) return node;
      changed = true;
      return { ...node, children: undefined };
    }
    if (node.children && targetPath.startsWith(`${node.path}/`)) {
      const nextChildren = clearDirectoryChildren(node.children, targetPath);
      if (nextChildren !== node.children) {
        changed = true;
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
  return changed ? nextNodes : nodes;
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

export function getSelectionRangePaths(paths: string[], startPath: string, endPath: string): string[] {
  const startIndex = paths.indexOf(startPath);
  const endIndex = paths.indexOf(endPath);

  if (startIndex === -1 || endIndex === -1) return [];

  const start = Math.min(startIndex, endIndex);
  const end = Math.max(startIndex, endIndex);
  return paths.slice(start, end + 1);
}

export function getTreeSelectionRangePaths(nodes: FileNode[], startPath: string, endPath: string): string[] {
  return getSelectionRangePaths(flattenTreePaths(nodes), startPath, endPath);
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
