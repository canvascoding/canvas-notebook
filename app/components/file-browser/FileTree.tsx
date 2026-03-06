'use client';

import { useEffect } from 'react';
import { Loader2, AlertCircle, FolderOpen } from 'lucide-react';
import {
  SidebarMenu,
  SidebarGroup,
  SidebarGroupContent,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { useFileStore, FileNode as FileNodeType } from '@/app/store/file-store';
import { FileTreeNode } from './FileTreeNode';

export function FileTree() {
  const {
    fileTree,
    isLoadingTree,
    treeError,
    loadFileTree,
  } = useFileStore();

  useEffect(() => {
    // Load file tree on mount
    loadFileTree();
  }, [loadFileTree]);

  // Filter tree based on search query
  const filterTree = (nodes: FileNodeType[], query: string): FileNodeType[] => {
    if (!query) return nodes;
    
    return nodes
      .map((node) => {
        if (node.type === 'directory' && node.children) {
          const filteredChildren = filterTree(node.children, query);
          if (filteredChildren.length > 0 || node.name.toLowerCase().includes(query.toLowerCase())) {
            return { ...node, children: filteredChildren };
          }
          return null;
        }
        if (node.name.toLowerCase().includes(query.toLowerCase())) {
          return node;
        }
        return null;
      })
      .filter((node): node is FileNodeType => node !== null);
  };

  const { searchQuery } = useFileStore();
  const filteredTree = searchQuery
    ? filterTree(fileTree, searchQuery.toLowerCase())
    : fileTree;

  if (isLoadingTree) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (treeError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">{treeError}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => loadFileTree()}
          className="mt-2"
        >
          Retry
        </Button>
      </div>
    );
  }

  if (fileTree.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <FolderOpen className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">No files found</p>
        <p className="text-xs text-muted-foreground/60">Upload files to get started</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto py-2">
      <SidebarGroup className="p-0">
        <SidebarGroupContent>
          <SidebarMenu className="space-y-0.5">
            {filteredTree.map((node) => (
              <FileTreeNode key={node.path} node={node} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      
      {filteredTree.length === 0 && searchQuery && (
        <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-sm text-muted-foreground">No results found</p>
          <p className="text-xs text-muted-foreground/60">
            No files match &quot;{searchQuery}&quot;
          </p>
        </div>
      )}
    </div>
  );
}
