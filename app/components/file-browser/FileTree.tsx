'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertCircle, FolderOpen } from 'lucide-react';
import {
  SidebarMenu,
  SidebarGroup,
  SidebarGroupContent,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { useFileStore, FileNode as FileNodeType } from '@/app/store/file-store';
import { FileTreeNode } from './FileTreeNode';
import { BulkActionsToolbar } from './BulkActionsToolbar';
import { BulkMoveDialog } from './BulkMoveDialog';

export function FileTree() {
  const t = useTranslations('notebook');
  const {
    fileTree,
    isLoadingTree,
    treeError,
    loadFileTree,
    currentDirectory,
    selectAllInDirectory,
    clearMultiSelect,
  } = useFileStore();

  useEffect(() => {
    // Load file tree on mount
    loadFileTree();
  }, [loadFileTree]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
        event.preventDefault();
        selectAllInDirectory(currentDirectory);
      }
      if (event.key === 'Escape') {
        clearMultiSelect();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentDirectory, selectAllInDirectory, clearMultiSelect]);

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
          {t('tryAgain')}
        </Button>
      </div>
    );
  }

  if (fileTree.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <FolderOpen className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{t('noFilesFound')}</p>
        <p className="text-xs text-muted-foreground/60">{t('uploadFilesToGetStarted')}</p>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-y-auto py-2">
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
          <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
          <p className="text-xs text-muted-foreground/60">
            {t('noFilesMatch', { query: searchQuery })}
          </p>
        </div>
      )}

      <BulkActionsToolbar />
      <BulkMoveDialog />
    </div>
  );
}
