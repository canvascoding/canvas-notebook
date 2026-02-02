'use client';

import { useEffect } from 'react';
import { useFileStore, FileNode as FileNodeType } from '@/app/store/file-store';
import { FileNode } from './FileNode';
import { Loader2, AlertCircle } from 'lucide-react';

export function FileTree() {
  const {
    fileTree,
    isLoadingTree,
    treeError,
    expandedDirs,
    selectedNode,
    searchQuery,
    autoRefresh,
    loadFileTree,
    toggleDirectory,
    loadFile,
    selectNode,
  } = useFileStore();

  useEffect(() => {
    // Load file tree on mount
    loadFileTree();
  }, [loadFileTree]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => {
      loadFileTree();
    }, 15000);

    return () => window.clearInterval(interval);
  }, [autoRefresh, loadFileTree]);

  const handleSelectNode = (node: FileNodeType) => {
    selectNode(node);
    if (node.type === 'file') {
      // Always force a refetch when a file is clicked to get the latest content
      loadFile(node.path, true);
    }
  };

  if (isLoadingTree) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (treeError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
        <AlertCircle className="w-8 h-8 text-red-400" />
        <p className="text-sm text-red-400">{treeError}</p>
        <button
          onClick={() => loadFileTree()}
          className="px-3 py-1 text-sm bg-slate-700 hover:bg-slate-600 rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (fileTree.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-slate-500">No files found</p>
      </div>
    );
  }

  const filteredTree = searchQuery
    ? filterTree(fileTree, searchQuery.toLowerCase())
    : fileTree;

  return (
    <div className="h-full overflow-y-auto">
      {filteredTree.map((node) => (
        <FileNode
          key={node.path}
          node={node}
          depth={0}
          expandedDirs={expandedDirs}
          selectedPath={selectedNode?.path ?? null}
          onToggle={toggleDirectory}
          onSelect={handleSelectNode}
        />
      ))}
    </div>
  );
}

function filterTree(nodes: FileNodeType[], query: string): FileNodeType[] {
  return nodes
    .map((node) => {
      if (node.type === 'directory' && node.children) {
        const filteredChildren = filterTree(node.children, query);
        if (filteredChildren.length > 0 || node.name.toLowerCase().includes(query)) {
          return { ...node, children: filteredChildren };
        }
        return null;
      }
      if (node.name.toLowerCase().includes(query)) {
        return node;
      }
      return null;
    })
    .filter((node): node is FileNodeType => node !== null);
}
